"""tests/py_test_chat.py - offline checks for the v86 chat routes.

Runs WITHOUT ComfyUI: `server`, `aiohttp` and `folder_paths` are stubbed in
sys.modules before py/chat_proxy.py is imported (same harness as
py_test_clipboard.py). The fake aiohttp ClientSession SCRIPTS the upstream
LLM answers, so the /send proxy core is exercised end-to-end - including the
SSE branch - without any network.

Covers:
  * config: defaults, key masking (the browser never sees the key), numeric
    clamping, url validation, the special "key: ''" clearing
  * storage root: an absolute custom path is probed before switching, a
    relative one is refused, "" returns to the default (v84 mechanics)
  * sessions: create / get / rename / clear / delete via the REAL handlers
  * attach: per-kind extension whitelist, size cap, blob stored in
    sessions/<sid>/blobs/, serving via /file/<sid>/<name>
  * payload building: ctx_depth cut, media_depth window (older images
    degrade to text notes), image -> base64 image_url data-URL part,
    text file -> inline content capped at 300 KB, missing blob -> note,
    system prompt, max_tokens 0 omitted, reasoning none/low mapping
  * /send non-stream: user message appended + auto-title, upstream payload
    shape, assistant reply stored with usage, regenerate drops the last
    answer, edit_index rewrites the text and cuts the tail, an upstream
    error KEEPS the user message
  * /send stream (SSE): delta events forwarded, the assistant message saved,
    a truncated stream still stores the partial
  * video: without ffmpeg _video_frames reports a human reason instead of
    raising; eviction prunes the oldest sessions beyond keep_sessions

Run: python3 tests/py_test_chat.py   (exit 0 = all good)
"""
import asyncio
import base64
import json
import os
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# Stub modules BEFORE importing the code under test
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, data=None, status=200, headers=None):
        self._data = data if data is not None else {}
        self.status = status
        self.headers = dict(headers or {})

    @property
    def ok(self):
        return self.status < 400

    def json(self):
        if isinstance(self._data, bytes):
            return json.loads(self._data.decode("utf-8"))
        return self._data

    async def read(self):
        return self._body if hasattr(self, "_body") else b""

    async def text(self):
        b = self._body if hasattr(self, "_body") else b""
        return b.decode("utf-8", "replace")


class FakeRoutes:
    def __init__(self):
        self.handlers = {}

    def _reg(self, method, path):
        def deco(fn):
            self.handlers[(method, path)] = fn
            return fn
        return deco

    def get(self, path):
        return self._reg("GET", path)

    def post(self, path):
        return self._reg("POST", path)

    def put(self, path):
        return self._reg("PUT", path)

    def delete(self, path):
        return self._reg("DELETE", path)


class FakePromptServer:
    instance = None

    def __init__(self):
        self.routes = FakeRoutes()


class FakeRequest:
    """Just enough of aiohttp.web.Request for the handlers under test."""

    def __init__(self, method="POST", path="/", query=None, match_info=None,
                 body=b"", json_body=None, transport=None):
        self.method = method
        self.path = path
        self.query = dict(query or {})
        self.match_info = dict(match_info or {})
        self._json = json_body
        self._body = body
        self.transport = transport

    async def json(self):
        if self._json is not None:
            return self._json
        return json.loads(self._body.decode("utf-8"))

    async def read(self):
        return self._body


class FakeFileResponse:
    def __init__(self, path, headers=None):
        self.path = path
        self.headers = dict(headers or {})


def make_web_stub():
    web_stub = types.SimpleNamespace()
    web_stub.json_response = staticmethod(
        lambda data, status=200, headers=None: FakeResponse(data, status, headers))
    web_stub.FileResponse = FakeFileResponse

    class StreamResponse:
        """Records SSE writes instead of touching a socket."""
        instances = []

        def __init__(self, headers=None):
            self.headers = dict(headers or {})
            self.written = []
            self.prepared = False
            self.eof = False
            StreamResponse.instances.append(self)

        async def prepare(self, request):
            self.prepared = True
            return self

        async def write(self, data):
            self.written.append(bytes(data))

        async def write_eof(self):
            self.eof = True

    web_stub.StreamResponse = StreamResponse
    return web_stub


# --- fake aiohttp client: the SCRIPTED upstream LLM server ------------------

class FakeClientTimeout:
    def __init__(self, total=None, sock_connect=None):
        self.total = total
        self.sock_connect = sock_connect


class FakeContent:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def iter_any(self):
        for c in self._chunks:
            yield c


class FakeUpstream:
    def __init__(self, status=200, text="", chunks=None):
        self.status = status
        self._text = text
        self.content = FakeContent(chunks or [])
        self.released = False

    async def text(self):
        return self._text

    def release(self):
        self.released = True


class FakePostCtx:
    """aiohttp's session.post() is BOTH awaitable and an async context
    manager - the proxy uses `await http.post(...)` in the stream branch and
    `async with http.post(...)` in the plain one. Mimic both."""

    def __init__(self, url, payload, headers):
        self._url = url
        self._payload = payload
        self._headers = headers

    def _resolve(self):
        FakeClientSession.requests.append(("POST", self._url, self._payload, self._headers))
        item = (FakeClientSession.script.pop(0)
                if FakeClientSession.script else FakeUpstream(500, "script exhausted"))
        if isinstance(item, Exception):
            raise item
        return item

    def __await__(self):
        async def _do():
            return self._resolve()
        return _do().__await__()

    async def __aenter__(self):
        return self._resolve()

    async def __aexit__(self, *a):
        return False


class FakeGetCtx:
    def __init__(self, url, headers):
        self._url = url
        self._headers = headers

    async def __aenter__(self):
        FakeClientSession.requests.append(("GET", self._url, None, self._headers))
        item = (FakeClientSession.script.pop(0)
                if FakeClientSession.script else FakeUpstream(500, "script exhausted"))
        if isinstance(item, Exception):
            raise item
        return item

    async def __aexit__(self, *a):
        return False


class FakeClientSession:
    """Scripts consecutive upstream answers; records every request."""
    script = []          # list of FakeUpstream / Exception
    requests = []        # [(method, url, payload, headers)]

    def __init__(self, timeout=None):
        self.timeout = timeout
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        self.closed = True
        return False

    async def close(self):
        self.closed = True

    def post(self, url, json=None, headers=None):
        return FakePostCtx(url, json, headers)

    def get(self, url, headers=None):
        return FakeGetCtx(url, headers)


server_stub = types.ModuleType("server")
server_stub.PromptServer = FakePromptServer
sys.modules["server"] = server_stub

aiohttp_stub = types.ModuleType("aiohttp")
aiohttp_stub.web = make_web_stub()
aiohttp_stub.ClientTimeout = FakeClientTimeout
aiohttp_stub.ClientSession = FakeClientSession
sys.modules["aiohttp"] = aiohttp_stub

fp_stub = types.ModuleType("folder_paths")
_USER_DIR = tempfile.mkdtemp(prefix="shub-chat-user-")
fp_stub.get_user_directory = lambda: _USER_DIR
sys.modules["folder_paths"] = fp_stub

sys.path.insert(0, ROOT)

FakePromptServer.instance = FakePromptServer()

import importlib.util


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


chat = load("shub_chat_proxy", "py/chat_proxy.py")

# ---------------------------------------------------------------------------

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append("%s%s" % (name, (" :: " + str(detail)) if detail else ""))
        print("  FAIL %s%s" % (name, (" :: " + str(detail)) if detail else ""))


def phase(title):
    print("- %s" % title)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def resp_json(r):
    return r.json()


UPSTREAM = "http://127.0.0.1:8080/v1"


def seed_config(**over):
    cfg = dict(chat._load_config())
    cfg["url"] = UPSTREAM
    cfg["model"] = "test-model"
    cfg["stream"] = False
    cfg.update(over)
    chat._save_config(cfg)
    return cfg


def make_session(title=""):
    r = run(chat.chat_sessions_create(FakeRequest(json_body={"title": title})))
    return resp_json(r)["session"]


def add_blob(sid, name, data):
    d = chat._blobs_dir(sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "wb") as f:
        f.write(data)


PNG = bytes([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])


# ---------------------------------------------------------------------------
phase("config: defaults, masking, clamps, url validation")

cfg = chat._load_config()
check("default url points at the polystrata port", cfg["url"] == "http://127.0.0.1:8080/v1", cfg["url"])
check("key empty by default", cfg["key"] == "")

seed_config(key="sk-secret-1234567890")
masked = chat._masked_config(chat._load_config())
check("key is masked in GET", masked["key"] == "sk****7890", masked["key"])
check("raw key stays on the server", chat._load_config()["key"] == "sk-secret-1234567890")

r = run(chat.chat_config_set(FakeRequest(json_body={"temperature": 99, "url": "ftp://bad", "reasoning": "nope"})))
j = resp_json(r)
check("bad url refused", not j["ok"] and "http" in j["error"], j)
r = run(chat.chat_config_set(FakeRequest(json_body={"temperature": 99, "reasoning": "nope"})))
j = resp_json(r)
check("reasoning whitelist enforced", not j["ok"], j)
r = run(chat.chat_config_set(FakeRequest(json_body={"temperature": 99})))
j = resp_json(r)
check("temperature clamped to 2.0", j["ok"] and j["config"]["temperature"] == 2.0, j.get("config"))
check("masked key present in the answer", j["config"]["key"] == "sk****7890", j["config"]["key"])
r = run(chat.chat_config_set(FakeRequest(json_body={"key": ""})))
check("empty key clears", resp_json(r)["config"]["key"] == "")
r = run(chat.chat_config_set(FakeRequest(json_body={"max_tokens": 0})))
check("max_tokens 0 accepted (no limit)", resp_json(r)["config"]["max_tokens"] == 0)

# ---------------------------------------------------------------------------
phase("storage root: v84 mechanics")

r = run(chat.chat_root_set(FakeRequest(json_body={"path": "relative/path"})))
check("relative path refused", not resp_json(r)["ok"], resp_json(r))
custom = tempfile.mkdtemp(prefix="shub-chat-custom-")
r = run(chat.chat_root_set(FakeRequest(json_body={"path": "'" + custom + "'"})))
j = resp_json(r)
check("quoted absolute path applied", j["ok"] and j["custom"] == os.path.normpath(custom), j)
check("override persisted in the DEFAULT user dir",
      os.path.isfile(os.path.join(_USER_DIR, "settings_hub", "chat_root.json")))
r = run(chat.chat_root_set(FakeRequest(json_body={"path": ""})))
check("empty path returns to the default", resp_json(r)["ok"] and "custom" not in str(resp_json(r)["custom"]))
check("custom root reset", chat._root_custom is None)

# ---------------------------------------------------------------------------
phase("sessions: create / rename / clear / delete")

sess = make_session()
check("session id shape", chat._SID_RE.match(sess["id"]), sess)
r = run(chat.chat_session_rename(FakeRequest(match_info={"sid": sess["id"]}, json_body={"title": "Дизайн-бриф"})))
check("rename stored", resp_json(r)["session"]["title"] == "Дизайн-бриф")
r = run(chat.chat_sessions_list(FakeRequest()))
lst = resp_json(r)["sessions"]
check("session listed with n=0", any(s["id"] == sess["id"] and s["n"] == 0 for s in lst), lst)
r = run(chat.chat_session_clear(FakeRequest(match_info={"sid": sess["id"]})))
check("clear ok", resp_json(r)["ok"])
r = run(chat.chat_session_delete(FakeRequest(match_info={"sid": sess["id"]})))
check("delete ok", resp_json(r)["ok"])
check("session dir gone", not os.path.isdir(chat._session_dir(sess["id"])))
r = run(chat.chat_session_get(FakeRequest(match_info={"sid": sess["id"]})))
check("get deleted session -> 404", r.status == 404)

# ---------------------------------------------------------------------------
phase("attach: kinds, size cap, serving")

sess = make_session()
r = run(chat.chat_attach(FakeRequest(
    query={"session": sess["id"], "kind": "image", "name": "photo.PNG"}, body=PNG)))
j = resp_json(r)
check("image attached", j["ok"] and j["name"].endswith(".png") and j["mime"] == "image/png", j)
blob_name = j["name"]
check("blob exists", os.path.isfile(os.path.join(chat._blobs_dir(sess["id"]), blob_name)))
r = run(chat.chat_attach(FakeRequest(
    query={"session": sess["id"], "kind": "video", "name": "clip.txt"}, body=b"x")))
check("video kind refuses a .txt", r.status == 400)
r = run(chat.chat_attach(FakeRequest(
    query={"session": sess["id"], "kind": "file", "name": "notes.md"},
    body="# heading\nbody text".encode())))
check("text file attached as file kind", resp_json(r)["ok"])
r = run(chat.chat_attach(FakeRequest(
    query={"session": sess["id"], "kind": "image", "name": "big.png"},
    body=b"x" * (21 * 1024 * 1024))))
check("over-cap blob refused (20 MB default)", r.status == 413)
r = run(chat.chat_file(FakeRequest(match_info={"sid": sess["id"], "name": blob_name})))
check("file route serves the blob", isinstance(r, FakeFileResponse) and r.path.endswith(blob_name), r)
check("file route sets the mime", r.headers.get("Content-Type") == "image/png", r.headers)
r = run(chat.chat_file(FakeRequest(match_info={"sid": sess["id"], "name": ".."})))
check("traversal refused", r.status == 400)

# ---------------------------------------------------------------------------
phase("payload building: depth, media window, files")


def msg(role, text, parts=None):
    return {"role": role, "text": text, "parts": parts or [], "ts": 0}


cfgv = seed_config(ctx_depth=3, media_depth=1, system_prompt="be brief",
                   temperature=0.8, top_p=0.95, max_tokens=1024)
sess2 = make_session()
add_blob(sess2["id"], "aabbcc.png", PNG)
add_blob(sess2["id"], "ccddee.txt", "file-content".encode())

msgs = [
    msg("user", "old1", [{"kind": "image", "name": "missing.png", "orig": "old.png"}]),
    msg("assistant", "old2"),
    msg("user", "old3"),
    msg("assistant", "old4"),
    msg("user", "now", [
        {"kind": "image", "name": "aabbcc.png", "orig": "photo.png"},
        {"kind": "file", "name": "ccddee.txt", "orig": "notes.md"},
    ]),
]
up = chat.build_upstream_messages(msgs, cfgv, sess2["id"])
check("ctx_depth=3 keeps the last 3", len(up) == 3, len(up))
check("no system msg in the raw history", all(m["role"] != "system" for m in up))
tail = up[-1]["content"]
kinds = [c["type"] for c in tail]
check("image part present in the media window", "image_url" in kinds, kinds)
img_part = next(c for c in tail if c["type"] == "image_url")
check("image is a base64 data-url", img_part["image_url"]["url"].startswith("data:image/png;base64,"))
file_text = next(c["text"] for c in tail if c["type"] == "text" and "[File:" in c["text"])
check("text file content inline", "file-content" in file_text and "[File: notes.md]" in file_text, file_text[:80])
check("[Image 1] marker precedes the part",
      any(c["type"] == "text" and c["text"].startswith("[Image 1]") for c in tail), kinds)

# an image OUTSIDE the media window degrades to a text note
msgs2 = [
    msg("user", "older", [{"kind": "image", "name": "aabbcc.png", "orig": "photo2.png"}]),
    msg("assistant", "a"),
    msg("user", "last"),
]
up2 = chat.build_upstream_messages(msgs2, cfgv, sess2["id"])
first = up2[0]["content"]
check("old image degraded to a text note",
      len(first) == 1 and "photo2.png" in first[0]["text"] and "older than the media window" in first[0]["text"],
      first)
check("no image_url outside the window", all(c["type"] != "image_url" for c in first))

# a missing blob inside the window -> an explicit note, never a crash
msgs3 = [msg("user", "q", [{"kind": "image", "name": "nofile.png", "orig": "gone.png"}])]
up3 = chat.build_upstream_messages(msgs3, cfgv, sess2["id"])
check("missing blob noted", "(missing)" in up3[0]["content"][0]["text"], up3[0]["content"])

p = chat.build_upstream_payload(msgs, cfgv, sess2["id"])
check("system prompt inserted", p["messages"][0]["role"] == "system" and p["messages"][0]["content"] == "be brief")
check("model passed", p["model"] == "test-model")
check("sampling passed", p["temperature"] == 0.8 and p["top_p"] == 0.95)
check("max_tokens present", p.get("max_tokens") == 1024)
check("stream flag", p["stream"] is False)

cfgv2 = seed_config(max_tokens=0, reasoning="none")
p2 = chat.build_upstream_payload(msgs, cfgv2, sess2["id"])
check("max_tokens 0 omitted", "max_tokens" not in p2, p2.get("max_tokens"))
check("reasoning none -> enable_thinking false",
      p2.get("chat_template_kwargs", {}).get("enable_thinking") is False)
cfgv3 = seed_config(reasoning="high")
p3 = chat.build_upstream_payload(msgs, cfgv3, sess2["id"])
check("reasoning high -> reasoning_effort", p3.get("reasoning_effort") == "high")
check("no reasoning key for default", "reasoning_effort" not in p and "chat_template_kwargs" not in p)

rep = chat.parse_upstream_response({
    "model": "m1", "choices": [{"message": {"content": "hello", "reasoning_content": "think"},
                                "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}})
check("reply parsed", rep["text"] == "hello" and rep["thoughts"] == "think")
check("usage parsed", rep["usage"]["completion_tokens"] == 7)

# ---------------------------------------------------------------------------
phase("/send non-stream: the full proxy roundtrip")

cfgv = seed_config(stream=False)
sess3 = make_session()
sid3 = sess3["id"]
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "model": "test-model",
    "choices": [{"message": {"content": "The answer", "reasoning_content": ""},
                 "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 3, "completion_tokens": 9},
}))]
req = FakeRequest(json_body={"session": sid3, "text": "Привет, модель", "stream": False})
r = run(chat.chat_send(req))
j = resp_json(r)
check("send ok", j["ok"], j)
ms = j["session"]["messages"]
check("user + assistant stored", len(ms) == 2 and ms[0]["role"] == "user" and ms[1]["role"] == "assistant", ms)
check("assistant text", ms[1]["text"] == "The answer")
check("usage stored", ms[1]["usage"]["completion_tokens"] == 9)
check("auto title from the first message", j["session"]["title"] == "Привет, модель", j["session"]["title"])
sent = FakeClientSession.requests[-1]
check("upstream URL is <url>/chat/completions", sent[1] == UPSTREAM + "/chat/completions", sent[1])
check("upstream model in payload", sent[2]["model"] == "test-model")
check("history went upstream",
      sent[2]["messages"][-1]["content"][0]["text"] == "Привет, модель", sent[2]["messages"][-1])
check("session persisted on disk", os.path.isfile(os.path.join(chat._session_dir(sid3), "session.json")))

# regenerate drops the last assistant answer and re-asks
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "Better answer"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid3, "regenerate": True, "stream": False})))
j = resp_json(r)
ms = j["session"]["messages"]
check("regenerate replaced the answer", ms[-1]["text"] == "Better answer" and len(ms) == 2, [m["text"] for m in ms])

# edit_index rewrites a user message and cuts the tail
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "Answer v2"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sid3, "edit_index": 0, "text": "Переписанный вопрос", "stream": False})))
j = resp_json(r)
ms = j["session"]["messages"]
check("edit rewrote the first user msg", ms[0]["text"] == "Переписанный вопрос")
check("edit cut the tail", len(ms) == 2, len(ms))

# upstream error: the user message SURVIVES
FakeClientSession.script = [FakeUpstream(status=500, text=json.dumps(
    {"error": {"message": "model exploded"}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid3, "text": "second", "stream": False})))
j = resp_json(r)
check("upstream error surfaced", not j["ok"] and "model exploded" in j["error"], j)
saved = chat._read_session(sid3)
check("user message kept after the error", saved["messages"][-1]["text"] == "second")
check("no half assistant message", saved["messages"][-1]["role"] == "user")

# no model -> explicit error
seed_config(model="")
r = run(chat.chat_send(FakeRequest(json_body={"session": sid3, "text": "x", "stream": False})))
check("no model refused", not resp_json(r)["ok"] and "model" in resp_json(r)["error"])

# ---------------------------------------------------------------------------
phase("/send stream: SSE events + partial storage")

cfgv = seed_config(stream=True)
sess4 = make_session()
sid4 = sess4["id"]
sse = (b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
       b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
       b"data: [DONE]\n\n")
FakeClientSession.script = [FakeUpstream(status=200, text="", chunks=[sse])]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid4, "text": "stream please", "stream": True})))
check("stream returns a StreamResponse", isinstance(r, aiohttp_stub.web.StreamResponse), type(r))
body = b"".join(r.written).decode("utf-8")
check("delta events forwarded", '"delta": "Hel"' in body.replace(" ", "") or '"delta":"Hel"' in body.replace(" ", ""), body[:200])
check("done event carries the session", '"done": true' in body.replace(" ", "") or '"done":true' in body.replace(" ", ""))
saved = chat._read_session(sid4)
check("stream reply stored", saved["messages"][-1]["text"] == "Hello", saved["messages"][-1])

# a truncated stream (no [DONE]) still stores the partial
sess5 = make_session()
partial = b'data: {"choices":[{"delta":{"content":"par"}}]}\n\n'
FakeClientSession.script = [FakeUpstream(status=200, text="", chunks=[partial])]
r = run(chat.chat_send(FakeRequest(json_body={"session": sess5["id"], "text": "q", "stream": True})))
body = b"".join(r.written).decode("utf-8")
saved = chat._read_session(sess5["id"])
check("partial stored with stopped flag",
      saved["messages"][-1]["text"] == "par" and saved["messages"][-1].get("stopped") is True, saved["messages"][-1])

# an upstream HTTP error mid-setup is surfaced as an SSE error event
sess6 = make_session()
FakeClientSession.script = [FakeUpstream(status=503, text="loading")]
r = run(chat.chat_send(FakeRequest(json_body={"session": sess6["id"], "text": "q", "stream": True})))
body = b"".join(r.written).decode("utf-8")
check("upstream error becomes an SSE event", "503" in body, body[:200])

# ---------------------------------------------------------------------------
phase("video: no ffmpeg -> a human reason, never a raise")

real_which = chat.shutil.which
try:
    chat.shutil.which = lambda name: None
    sess7 = make_session()
    add_blob(sess7["id"], "v1.mp4", b"not really a video")
    frames, err = chat._video_frames(os.path.join(chat._blobs_dir(sess7["id"]), "v1.mp4"),
                                     {"video_frames": 16, "video_max_side": 768})
    check("no ffmpeg -> empty frames + reason", frames == [] and "ffmpeg" in (err or ""), err)
finally:
    chat.shutil.which = real_which

# ---------------------------------------------------------------------------
phase("eviction: keep_sessions prunes the oldest")

seed_config(keep_sessions=3)
made = [make_session() for _ in range(5)]
now = int(time.time())
for i, s in enumerate(made):  # strictly decreasing updated -> a stable oldest
    s["updated"] = now - (len(made) - i)
    chat._write_session(s)
chat._evict_sessions(3)
left = chat._list_sessions()
check("eviction keeps 3 newest", len(left) == 3, len(left))
check("the oldest are gone", all(s["id"] not in [m["id"] for m in made[:2]] for s in left))

# ---------------------------------------------------------------------------
phase("health + config GET")

r = run(chat.chat_health(FakeRequest()))
j = resp_json(r)
check("health ok + version", j["ok"] and j["version"] == chat.CHAT_SERVER_VERSION, j.get("version"))
check("health reports configured + sessions", j["configured"] is True and isinstance(j["sessions"], int))
check("has_ffmpeg is a bool", isinstance(j["has_ffmpeg"], bool))
r = run(chat.chat_config_get(FakeRequest()))
check("config GET returns a masked key", "key" in resp_json(r)["config"])

# ---------------------------------------------------------------------------
# v87: GPU & memory - /chat/gpu routes + the send-time reserve
# ---------------------------------------------------------------------------

# the scripted upstream needs an ASYNC json() (the /status probe awaits it)
async def _fake_upstream_json(self, content_type=None):
    return json.loads(self._text)

FakeUpstream.json = _fake_upstream_json

# _upstream_unload passes params= to session.post - accept and record it
_orig_fake_post = FakeClientSession.post

def _fake_post_with_params(self, url, json=None, headers=None, params=None):
    if params:
        FakeClientSession.requests.append(("POST-PARAMS", url, params, headers))
    return _orig_fake_post(self, url, json=json, headers=headers)

FakeClientSession.post = _fake_post_with_params

STATUS_JSON = json.dumps({
    "model": "test-model", "loaded": True, "elastic": False,
    "machine": {"gpu": {"total_mib": 24576, "free_mib": 1234}},
    "vram": {"vram_free_mib": 20000},
})

phase("v87 config: vram_reserve_mib clamped + persisted")

seed_config()
r = run(chat.chat_config_set(FakeRequest(json_body={"vram_reserve_mib": 4096})))
check("reserve 4096 accepted", resp_json(r)["config"]["vram_reserve_mib"] == 4096, resp_json(r)["config"])
check("reserve persisted", chat._load_config()["vram_reserve_mib"] == 4096)
r = run(chat.chat_config_set(FakeRequest(json_body={"vram_reserve_mib": -5})))
check("negative reserve clamps to 0", resp_json(r)["config"]["vram_reserve_mib"] == 0)
r = run(chat.chat_config_set(FakeRequest(json_body={"vram_reserve_mib": 99999999})))
check("huge reserve clamps to 131072", resp_json(r)["config"]["vram_reserve_mib"] == 131072)

phase("v87 gpu GET: the upstream status picture")

seed_config(vram_reserve_mib=4096)
FakeClientSession.script = [FakeUpstream(200, STATUS_JSON)]
FakeClientSession.requests = []
r = run(chat.chat_gpu_get(FakeRequest()))
j = resp_json(r)
check("gpu GET ok", j["ok"] is True, j)
check("gpu GET carries the snapshot",
      j["upstream"] and j["upstream"]["loaded"] is True and j["upstream"]["total_mib"] == 24576, j["upstream"])
check("gpu GET reports the configured reserve", j["reserve_mib"] == 4096, j)
check("gpu GET recorded the upstream /status probe",
      any(q[0] == "GET" and q[1] == UPSTREAM + "/status" for q in FakeClientSession.requests))

r = run(chat.chat_gpu_get(FakeRequest()))  # script exhausted -> upstream None
check("gpu GET survives a dead upstream", resp_json(r)["ok"] is True and resp_json(r)["upstream"] is None)

phase("v87 gpu POST reserve: /v1/vram + cfg + notes")

seed_config(vram_reserve_mib=0)
chat._COMFY_EXTRA_ORIG["bytes"] = None
FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"reserve_mib": 4096, "vram_free_mib": 20000})),
    FakeUpstream(200, STATUS_JSON),
]
FakeClientSession.requests = []
r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "reserve", "mib": 4096})))
j = resp_json(r)
check("reserve ok", j["ok"] is True, j)
check("reserve POSTed /v1/vram with the payload",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/vram" and q[2] == {"reserve_mib": 4096}
          for q in FakeClientSession.requests), FakeClientSession.requests[:3])
check("reserve note names target vs free",
      any("4096" in n and "20000" in n for n in j["notes"]), j["notes"])
check("reserve cfg persisted", chat._load_config()["vram_reserve_mib"] == 4096)
check("comfy note honest without comfy",
      any("comfy.model_management unavailable" in n for n in j["notes"]), j["notes"])
check("reserve answer carries the snapshot", j["upstream"]["free_mib"] == 20000, j["upstream"])

phase("v87 gpu POST release: /v1/vram null + cfg 0")

FakeClientSession.script = [
    FakeUpstream(200, "{}"),
    FakeUpstream(200, STATUS_JSON),
]
r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "release"})))
j = resp_json(r)
check("release ok", j["ok"] is True, j)
check("release POSTed /v1/vram with null",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/vram" and q[2] == {"reserve_mib": None}
          for q in FakeClientSession.requests), FakeClientSession.requests[:3])
check("release reset the cfg", chat._load_config()["vram_reserve_mib"] == 0)
check("release note says so", any("released" in n for n in j["notes"]), j["notes"])

phase("v87 gpu POST unload: /v1/unload + a full release")

FakeClientSession.script = [
    FakeUpstream(200, "{}"),          # POST /unload
    FakeUpstream(200, "{}"),          # POST /vram null (the release)
    FakeUpstream(200, STATUS_JSON),   # GET /status
]
FakeClientSession.requests = []
r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "unload", "wait": 0})))
j = resp_json(r)
check("unload ok", j["ok"] is True, j)
check("unload POSTed /v1/unload",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/unload" for q in FakeClientSession.requests),
      FakeClientSession.requests[:3])
check("unload note says the VRAM is back",
      any("unloaded" in n for n in j["notes"]), j["notes"])
check("unload released the reservation too",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/vram" and q[2] == {"reserve_mib": None}
          for q in FakeClientSession.requests), FakeClientSession.requests[:4])
check("unload reset the cfg", chat._load_config()["vram_reserve_mib"] == 0)

phase("v87 gpu POST free_comfy / load / unknown")

r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "free_comfy"})))
j = resp_json(r)
check("free_comfy ok without comfy", j["ok"] is True and "comfy.model_management unavailable" in j["notes"][0], j)

FakeClientSession.script = [FakeUpstream(200, json.dumps({"status": "loaded"}))]
r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "load", "model": "test-model"})))
j = resp_json(r)
check("load ok", j["ok"] is True, j)
check("load POSTed /v1/load",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/load" and q[2] == {"model": "test-model"}
          for q in FakeClientSession.requests), FakeClientSession.requests[:3])

r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "explode"})))
check("unknown action refused", r.status == 400, r.status)

phase("v87 send: the reserve is applied BEFORE the upstream call")

seed_config(vram_reserve_mib=4096, stream=False)
sess8 = make_session()
REPLY = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                    "model": "test-model",
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})
FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"reserve_mib": 4096})),  # POST /vram (auto reserve)
    FakeUpstream(200, STATUS_JSON),                        # GET /status (consumption)
    FakeUpstream(200, REPLY),                              # POST /chat/completions
]
FakeClientSession.requests = []
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sess8["id"], "text": "hello reserve", "stream": False})))
j = resp_json(r)
check("send ok with the reserve on", j["ok"] is True, j if j.get("ok") else j.get("error"))
urls = [(q[0], q[1]) for q in FakeClientSession.requests]
ivram = next((i for i, (m_, u_) in enumerate(urls) if u_ == UPSTREAM + "/vram"), -1)
icomp = next((i for i, (m_, u_) in enumerate(urls) if u_ == UPSTREAM + "/chat/completions"), -1)
check("the reserve preceded the generation", 0 <= ivram < icomp, urls)
check("the reserve payload carried the configured MiB",
      any(q[0] == "POST" and q[1] == UPSTREAM + "/vram" and q[2] == {"reserve_mib": 4096}
          for q in FakeClientSession.requests), urls)
# reset for the remaining runs
run(chat.chat_config_set(FakeRequest(json_body={"vram_reserve_mib": 0})))
check("reserve reset after the send test", chat._load_config()["vram_reserve_mib"] == 0)

# ---------------------------------------------------------------------------

print()
print("py_test_chat: %d passed, %d failed" % (PASS, FAIL))
if FAILURES:
    print("FAILURES:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
