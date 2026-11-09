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
  * v89: reply ctx {used,total,est} (exact usage.prompt_tokens vs estimate;
    ctx_size override + the auto /v1/status context.native probe), the
    saved-chat search ?q= (multi-word over title + content, hit snippets)
    and the owner's own prompts_dir catalog folder

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

# v92: the LLM WAKE path (_pre_send_prep -> _ensure_llm_ready) probes the
# PolyStrata registry (GET /api/models) BEFORE every send - the scripted
# FakeClientSession below only carries /chat/completions answers, so the
# legacy phases stub the registry probe out (fail-open: no registry -> no
# wake). The REAL wake/free mechanics get their own scripted phase at the
# bottom (v92: conditional free + wake + prep notes).
_orig_upstream_models_full = chat._upstream_models_full


async def _no_registry_stub(cfg):
    return {"ok": False, "source": "", "models": []}


chat._upstream_models_full = _no_registry_stub

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
    # v89: a non-zero ctx_size keeps _ctx_total() from probing the scripted
    # upstream (the probe would consume a scripted /chat/completions answer);
    # the auto-probe path gets its OWN phase with a scripted /status answer.
    cfg["ctx_size"] = 8192
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
check("reply ctx: exact from usage + seeded total",
      j["reply"]["ctx"]["used"] == 3 and j["reply"]["ctx"]["est"] is False
      and j["reply"]["ctx"]["total"] == 8192, j.get("reply", {}).get("ctx"))
check("assistant message stores ctx", ms[1]["ctx"]["used"] == 3, ms[1].get("ctx"))
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
# restore the default for the REST of the run - a leaked keep=3 makes every
# later make_session() an eviction hazard (same-second updated ties are
# resolved by the arbitrary os.listdir order -> random "no such session")
seed_config(keep_sessions=20)
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

FakeClientSession.script = [
    FakeUpstream(404, "no registry"),                      # POST /api/models/load (v88: tried first)
    FakeUpstream(200, json.dumps({"status": "loaded"})),   # POST /v1/load fallback
]
r = run(chat.chat_gpu_post(FakeRequest(json_body={"action": "load", "model": "test-model"})))
j = resp_json(r)
check("load ok", j["ok"] is True, j)
check("load falls back to /v1/load when the registry is absent",
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
phase("v88 prompt catalog: list, read, jail, the preset wins in the payload")

# point the catalog at a fake models dir (the PolyStrata prompt_root path)
CAT = tempfile.mkdtemp(prefix="shub-models-")
fp_stub.models_dir = CAT
PROMPTS_DIR = os.path.join(CAT, "LLM", "prompts")
os.makedirs(os.path.join(PROMPTS_DIR, "sub"), exist_ok=True)


def _wp(rel, text):
    p = os.path.join(PROMPTS_DIR, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


_wp("cinematic.txt", "  Cinematic one-paragraph prompt.  ")
_wp("sub/deep.txt", "Deep prompt")
_wp("notes.md", "not a preset")

r = run(chat.chat_prompts_list(FakeRequest(method="GET", path="/settings_hub/chat/prompts")))
j = resp_json(r)
check("catalog lists ONLY .txt recursively with / separators",
      j["ok"] and j["files"] == ["cinematic.txt", "sub/deep.txt"], j)
check("catalog reports the models/LLM/prompts dir",
      j["dir"].endswith(os.path.join("LLM", "prompts")), j["dir"])

r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/settings_hub/chat/prompt", query={"name": "cinematic.txt"})))
j = resp_json(r)
check("prompt read returns the stripped text",
      j["ok"] and j["text"] == "Cinematic one-paragraph prompt.", j)

r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/x", query={"name": "../../secret.txt"})))
check("path traversal refused", r.status == 400, r.status)
r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/x", query={"name": "sub/../../../etc/passwd.txt"})))
check("nested traversal refused too", r.status == 400, r.status)
r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/x", query={"name": "notes.md"})))
check("non-txt refused", r.status == 400, r.status)
r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/x", query={"name": "missing.txt"})))
check("missing file refused", r.status == 400, r.status)

# the preset WINS over the custom text and is read FRESH per payload
seed_config(prompt_preset="sub/deep.txt", system_prompt="custom-wins-when-no-preset")
sess = make_session("cat")
_msgs = [{"role": "user", "text": "hi", "ts": 1, "parts": []}]
body = chat.build_upstream_payload(_msgs, chat._load_config(), sess["id"])
check("preset wins: the FILE text is the system message",
      body["messages"][0] == {"role": "system", "content": "Deep prompt"},
      body["messages"][0])
os.remove(os.path.join(PROMPTS_DIR, "sub", "deep.txt"))
body = chat.build_upstream_payload(_msgs, chat._load_config(), sess["id"])
check("unreadable preset -> EMPTY prompt, the custom text does NOT sneak in",
      not any(m.get("role") == "system" for m in body["messages"]), body["messages"][:2])
seed_config(prompt_preset="")
body = chat.build_upstream_payload(_msgs, chat._load_config(), sess["id"])
check("no preset -> the custom text is used",
      body["messages"][0] == {"role": "system", "content": "custom-wins-when-no-preset"},
      body["messages"][0])

r = run(chat.chat_config_set(FakeRequest(json_body={"prompt_preset": "cinematic.txt"})))
j = resp_json(r)
check("config POST stores prompt_preset",
      j["ok"] and j["config"]["prompt_preset"] == "cinematic.txt", j.get("config"))
seed_config(prompt_preset="")

# ---------------------------------------------------------------------------
phase("v88 model list: /api/models registry first, /v1/models fallback, switch route")

# v92: the REAL registry probe back for these phases (the wake stub above
# would hollow them out); the /send phases further down re-stub it.
chat._upstream_models_full = _orig_upstream_models_full

FakeClientSession.requests.clear()
FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"models": [
        {"id": "m-loaded", "status": "loaded"},
        {"id": "m-avail", "status": "available"},
        {"id": "m-broken", "status": "unavailable"},
        {"id": "m-loading", "status": "loading"},
    ], "current": "m-loaded"})),
]
r = run(chat.chat_models_list(FakeRequest(method="GET", path="/settings_hub/chat/models")))
j = resp_json(r)
check("registry list: unavailable hidden, statuses kept",
      j["ok"] and j["source"] == "registry" and
      [(m["id"], m["status"]) for m in j["models"]] ==
      [("m-loaded", "loaded"), ("m-avail", "available"), ("m-loading", "loading")], j)
check("registry is read at the SERVER ROOT (not /v1)",
      FakeClientSession.requests and
      FakeClientSession.requests[-1][1] == "http://127.0.0.1:8080/api/models",
      FakeClientSession.requests[-1][1] if FakeClientSession.requests else None)

FakeClientSession.script = [
    FakeUpstream(404, "no registry here"),                      # GET /api/models
    FakeUpstream(200, json.dumps({"data": [{"id": "openai-m"}]})),  # GET /v1/models
]
r = run(chat.chat_models_list(FakeRequest(method="GET", path="/settings_hub/chat/models")))
j = resp_json(r)
check("registry 404 -> /v1/models fallback answers",
      j["ok"] and j["source"] == "openai" and
      j["models"] == [{"id": "openai-m", "status": ""}], j)

FakeClientSession.script = [
    FakeUpstream(500, "boom"),       # GET /api/models
    FakeUpstream(500, "boom"),       # GET /v1/models
    FakeUpstream(200, STATUS_JSON),  # GET /v1/status
]
r = run(chat.chat_models_list(FakeRequest(method="GET", path="/settings_hub/chat/models")))
j = resp_json(r)
check("no registry + no /v1/models -> the current model from /v1/status",
      j["ok"] and j["source"] == "status" and
      j["models"] == [{"id": "test-model", "status": "loaded"}], j)

FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"status": "loaded", "model": {"id": "m-avail"}})),
]
r = run(chat.chat_load(FakeRequest(json_body={"model": "m-avail"})))
j = resp_json(r)
check("switch goes through POST /api/models/load (the node way)",
      j["ok"] and j["via"] == "registry", j)
check("switch hit the server root",
      FakeClientSession.requests[-1] == ("POST", "http://127.0.0.1:8080/api/models/load",
                                         {"model": "m-avail"}, FakeClientSession.requests[-1][3]),
      FakeClientSession.requests[-1][:3])

FakeClientSession.script = [
    FakeUpstream(404, "no registry"),                      # /api/models/load
    FakeUpstream(200, json.dumps({"status": "loaded"})),   # /v1/load fallback
]
r = run(chat.chat_load(FakeRequest(json_body={"model": "m-avail"})))
j = resp_json(r)
check("registry 404 -> /v1/load fallback", j["ok"] and j["via"] == "openai", j)

FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"models": [
        {"id": "m-loaded", "status": "loaded"},
        {"id": "m-avail", "status": "available"},
    ], "current": "m-loaded"})),
]
r = run(chat.chat_test(FakeRequest(method="POST", path="/settings_hub/chat/test",
                                    json_body={})))
j = resp_json(r)
check("test probe now reports the registry source + ids",
      j["ok"] and j["source"] == "registry" and j["models"] == ["m-loaded", "m-avail"], j)

# v92: the /send phases below run the wake probe on every send - stub the
# registry probe out again (no network in the scripted phases).
chat._upstream_models_full = _no_registry_stub

# ---------------------------------------------------------------------------
phase("v89 ctx fill: estimate, auto probe, ctx_size, exact usage")

est = chat.estimate_ctx_tokens({"messages": [
    {"role": "user", "content": "abcdefg" * 4},          # 28 chars
    {"role": "assistant", "content": [
        {"type": "text", "text": "abcdefgh"},            # 8 chars
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,x"}},
    ]},
]})
# chars 28+8=36 -> 9; 2 msgs -> 16; 1 image -> 750
check("estimate math (chars/4 + 8/msg + 750/img)",
      est["used"] == 9 + 16 + 750 and est["images"] == 1 and est["est"] is True, est)

check("_status_ctx_total: polystrata context.native",
      chat._status_ctx_total({"context": {"native": 8192}}) == 8192)
check("_status_ctx_total: bare dict -> 0", chat._status_ctx_total({"loaded": True}) == 0)
check("_status_ctx_total: alternative n_ctx", chat._status_ctx_total({"n_ctx": 4096}) == 4096)

seed_config(ctx_size=0, stream=False)
chat._CTX_TOTAL_CACHE.update({"total": 0, "ts": 0.0})
sC = make_session()
REPLY_NO_USAGE = json.dumps({"choices": [{"message": {"content": "auto"}}]})
FakeClientSession.script = [
    FakeUpstream(200, json.dumps({"model": "test-model", "context": {"native": 32768}})),  # GET /status
    FakeUpstream(200, REPLY_NO_USAGE),   # POST /chat/completions (no usage)
]
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sC["id"], "text": "ctx auto", "stream": False})))
j = resp_json(r)
cx = j.get("reply", {}).get("ctx", {})
check("auto: total from /v1/status context.native", cx.get("total") == 32768, cx)
check("auto: the estimate is marked", cx.get("est") is True and cx.get("used", 0) > 0, cx)
check("auto: assistant stores ctx",
      j["session"]["messages"][-1]["ctx"].get("total") == 32768,
      j["session"]["messages"][-1].get("ctx"))

# the probe result is cached (TTL) - a second send must NOT re-probe
FakeClientSession.script = [FakeUpstream(200, REPLY_NO_USAGE)]
FakeClientSession.requests = []
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sC["id"], "text": "ctx cached", "stream": False})))
check("ctx total cached (no re-probe within the TTL)",
      not any(q[1] == UPSTREAM + "/status" for q in FakeClientSession.requests),
      [(q[0], q[1]) for q in FakeClientSession.requests])

seed_config(ctx_size=4096, stream=False)
FakeClientSession.script = [FakeUpstream(200, REPLY_NO_USAGE)]
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sC["id"], "text": "ctx cfg", "stream": False})))
cx = resp_json(r).get("reply", {}).get("ctx", {})
check("cfg ctx_size wins over the probe", cx.get("total") == 4096, cx)

REPLY_USAGE = json.dumps({"choices": [{"message": {"content": "exact"}}],
                          "usage": {"prompt_tokens": 111}})
FakeClientSession.script = [FakeUpstream(200, REPLY_USAGE)]
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sC["id"], "text": "ctx exact", "stream": False})))
cx = resp_json(r).get("reply", {}).get("ctx", {})
check("usage.prompt_tokens replaces the estimate",
      cx.get("used") == 111 and cx.get("est") is False and cx.get("total") == 4096, cx)
chat._CTX_TOTAL_CACHE.update({"total": 0, "ts": 0.0})

# ---------------------------------------------------------------------------
phase("v89 sessions search: multi-word, title, content, hit snippets")

s1 = chat._new_session("Cat breeds")
s1["messages"] = [{"role": "user", "text": "Tell me about Maine Coon cats", "ts": 1},
                  {"role": "assistant", "text": "Maine Coons are large and friendly", "ts": 2}]
chat._write_session(s1)
s2 = chat._new_session("Trip plan")
s2["messages"] = [{"role": "user", "text": "Visit Rome and Naples this spring", "ts": 1}]
chat._write_session(s2)
s3 = chat._new_session("scratch")
s3["messages"] = []
chat._write_session(s3)


def _search(q):
    r_ = run(chat.chat_sessions_list(FakeRequest(method="GET", path="/x", query={"q": q})))
    j_ = resp_json(r_)
    return j_


j = _search("")
check("no q -> the plain list", j["ok"] and any(s["id"] == s1["id"] for s in j["sessions"]))
j = _search("cats")
ids = [s["id"] for s in j["sessions"]]
check("single word hits title AND content", s1["id"] in ids and s2["id"] not in ids, ids)
j = _search("rome")
ids = [s["id"] for s in j["sessions"]]
hit = next((s.get("hit") for s in j["sessions"] if s["id"] == s2["id"]), None)
check("content word hits its chat", s2["id"] in ids and s1["id"] not in ids, ids)
check("hit snippet quotes the matched line", hit and "Rome" in hit, hit)
j = _search("trip rome")
ids = [s["id"] for s in j["sessions"]]
check("multi-word combined over title + content",
      s2["id"] in ids and s1["id"] not in ids, ids)
j = _search("maine plan")
check("each word must hit the SAME chat", not j["sessions"], j["sessions"])
j = _search("breed")
hit = next((s.get("hit") for s in j["sessions"] if s["id"] == s1["id"]), None)
check("title-only match carries no snippet",
      any(s["id"] == s1["id"] for s in j["sessions"]) and not hit, j["sessions"])
j = _search("zzz-nowhere")
check("no match -> empty list", j["ok"] and j["sessions"] == [])
for s in (s1, s2, s3):
    chat.shutil.rmtree(chat._session_dir(s["id"]), ignore_errors=True)

# ---------------------------------------------------------------------------
phase("v89 prompts_dir: the owner's own catalog folder")

PDIR = tempfile.mkdtemp(prefix="shub-prompts-")
os.makedirs(os.path.join(PDIR, "nested"), exist_ok=True)
with open(os.path.join(PDIR, "my_prompt.txt"), "w", encoding="utf-8") as f:
    f.write("My own prompt")
with open(os.path.join(PDIR, "nested", "deep2.txt"), "w", encoding="utf-8") as f:
    f.write("Deep two")

r = run(chat.chat_config_set(FakeRequest(json_body={"prompts_dir": PDIR})))
j = resp_json(r)
check("config POST stores prompts_dir", j["ok"] and j["config"]["prompts_dir"] == PDIR, j.get("config"))
check("prompts_dir persisted", chat._load_config()["prompts_dir"] == PDIR)
r = run(chat.chat_prompts_list(FakeRequest(method="GET", path="/settings_hub/chat/prompts")))
j = resp_json(r)
check("custom dir listed recursively", j["ok"] and j["files"] == ["my_prompt.txt", "nested/deep2.txt"], j)
check("custom dir echoed", os.path.normpath(j["dir"]) == os.path.normpath(PDIR), j["dir"])
r = run(chat.chat_prompt_read(FakeRequest(
    method="GET", path="/x", query={"name": "nested/deep2.txt"})))
check("custom dir read works", resp_json(r)["text"] == "Deep two", resp_json(r))

seed_config(prompt_preset="my_prompt.txt")
body = chat.build_upstream_payload([{"role": "user", "text": "hi", "ts": 1, "parts": []}],
                                   chat._load_config(), s3["id"])
check("the preset resolves inside the custom dir",
      body["messages"][0] == {"role": "system", "content": "My own prompt"}, body["messages"][0])
seed_config(prompt_preset="")

r = run(chat.chat_config_set(FakeRequest(json_body={"prompts_dir": ""})))
check("empty prompts_dir returns to the default", resp_json(r)["config"]["prompts_dir"] == "")
r = run(chat.chat_prompts_list(FakeRequest(method="GET", path="/settings_hub/chat/prompts")))
j = resp_json(r)
check("default catalog is back (the v88 models dir)",
      j["ok"] and j["files"] == ["cinematic.txt"], j)

# ---------------------------------------------------------------------------
phase("v91 tree: migration, branches, variants, edit/delete, import")

seed_config(stream=False)

# a fresh chat: q1 -> a1
sess = make_session("v91 tree")
sid = sess["id"]
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "a1"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid, "text": "q1", "stream": False})))
j = resp_json(r)
ms = j["session"]["messages"]
check("v91 send keeps the linear shape", [m["text"] for m in ms] == ["q1", "a1"], ms)
check("v91 linear messages carry nids", all(m.get("nid") for m in ms), ms)
check("v91 session carries the tree", isinstance(j["session"].get("tree"), dict))
tree = j["session"]["tree"]
check("v91 tree has the virtual root", "__root__" in tree["nodes"])
check("v91 activeLeaf is the answer", tree["activeLeaf"] == ms[1]["nid"], tree)
q1, a1 = ms[0]["nid"], ms[1]["nid"]

# session GET migrates + hands out the tree
r = run(chat.chat_session_get(FakeRequest(match_info={"sid": sid})))
j = resp_json(r)["session"]
check("v91 GET returns the tree + nids", j["tree"]["nodes"][j["messages"][0]["nid"]]["text"] == "q1")

# an OLD session (linear only) migrates lazily and keeps the messages
old = make_session("old chat")
with open(os.path.join(chat._session_dir(old["id"]), "session.json"), "w", encoding="utf-8") as f:
    json.dump({"id": old["id"], "title": "old chat", "created": 1, "updated": 1,
               "messages": [{"role": "user", "text": "u1", "ts": 1},
                            {"role": "assistant", "text": "x1", "ts": 2}]}, f)
r = run(chat.chat_session_get(FakeRequest(match_info={"sid": old["id"]})))
j = resp_json(r)["session"]
check("v91 old session migrated", "tree" in j and len(j["messages"]) == 2, j.get("tree"))
check("v91 migration preserves the texts",
      [m["text"] for m in j["messages"]] == ["u1", "x1"], j["messages"])

# EDIT = a NEW BRANCH: the old wording + its answer stay in the tree
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "a2"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={
    "session": sid, "edit_nid": q1, "text": "q1-edited", "stream": False})))
j = resp_json(r)
ms = j["session"]["messages"]
q2, a2 = ms[0]["nid"], ms[1]["nid"]
check("v91 edit: the active path shows the new branch",
      [m["text"] for m in ms] == ["q1-edited", "a2"], ms)
tree = j["session"]["tree"]
check("v91 edit: the old branch survives in the tree",
      tree["nodes"][q1]["text"] == "q1" and tree["nodes"][a1]["text"] == "a1", tree["nodes"].get(q1))
check("v91 edit: root has TWO variants", len(tree["nodes"]["__root__"]["children"]) == 2,
      tree["nodes"]["__root__"]["children"])
check("v91 edit: the old answer subtree survives",
      tree["nodes"][q1]["children"] == [a1], tree["nodes"][q1])

# the arrows walk the variants - back to the original branch
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": q2, "dir": -1})))
j = resp_json(r)
ms = j["session"]["messages"]
check("v91 branch switch: the WHOLE path follows the request",
      [m["text"] for m in ms] == ["q1", "a1"], ms)
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": q1, "set": 0})))
check("v91 branch set-index works",
      [m["text"] for m in resp_json(r)["session"]["messages"]] == ["q1", "a1"])
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": q1, "dir": -1})))
check("v91 branch switch past the start refused", r.status == 400, r.status)
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": q1, "set": 1})))
check("v91 branch set-index forward",
      [m["text"] for m in resp_json(r)["session"]["messages"]] == ["q1-edited", "a2"])
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": q2, "dir": -1})))
check("v91 branch back to the original",
      [m["text"] for m in resp_json(r)["session"]["messages"]] == ["q1", "a1"])

# REGENERATE = a NEW SIBLING answer (the old one stays a variant)
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "a3"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid, "regenerate": True, "stream": False})))
j = resp_json(r)
ms = j["session"]["messages"]
a3 = ms[1]["nid"]
check("v91 regenerate: the new answer is active", [m["text"] for m in ms] == ["q1", "a3"], ms)
tree = j["session"]["tree"]
check("v91 regenerate: the old answer stays a sibling",
      tree["nodes"][q1]["children"] == [a1, a3] and tree["nodes"][q1]["activeChild"] == a3,
      tree["nodes"][q1])
r = run(chat.chat_branch(FakeRequest(json_body={"session": sid, "nid": a3, "dir": -1})))
check("v91 answer variants walk back",
      [m["text"] for m in resp_json(r)["session"]["messages"]] == ["q1", "a1"])

# a failed send leaves a trailing user request; regenerate retries it
FakeClientSession.script = [FakeUpstream(status=500, text=json.dumps(
    {"error": {"message": "boom"}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid, "text": "retry-me", "stream": False})))
check("v91 failed send returns an error", r.status == 502, r.status)
j = resp_json(run(chat.chat_session_get(FakeRequest(match_info={"sid": sid}))))["session"]
ms = j["messages"]
check("v91 failed send: the request stays active",
      ms[-1]["role"] == "user" and ms[-1]["text"] == "retry-me", ms)
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "retried"}}], "usage": {}}))]
r = run(chat.chat_send(FakeRequest(json_body={"session": sid, "regenerate": True, "stream": False})))
j = resp_json(r)
check("v91 retry hangs the answer under the same request",
      [m["text"] for m in j["session"]["messages"]][-2:] == ["retry-me", "retried"],
      j["session"]["messages"])

# in-place edit (the model's replies too)
r = run(chat.chat_msg_edit(FakeRequest(
    match_info={"sid": sid},
    json_body={"nid": j["session"]["messages"][-1]["nid"], "text": "retried+corrected"})))
j = resp_json(r)
check("v91 in-place edit applied", j["session"]["messages"][-1]["text"] == "retried+corrected", j)
r = run(chat.chat_msg_edit(FakeRequest(match_info={"sid": sid}, json_body={"nid": "__root__", "text": "x"})))
check("v91 in-place edit refuses the root", r.status == 400)

# delete a message WITH its subtree
r = run(chat.chat_msg_delete(FakeRequest(
    match_info={"sid": sid},
    json_body={"nid": [m for m in j["session"]["messages"] if m["role"] == "user"][-1]["nid"]})))
j = resp_json(r)
check("v91 delete removes the node + its answer",
      "retry-me" not in [m["text"] for m in j["session"]["messages"]], j["session"]["messages"])
r = run(chat.chat_msg_delete(FakeRequest(match_info={"sid": sid}, json_body={"nid": "nope"})))
check("v91 delete unknown nid refused", r.status == 400)

# fork / import: blobs are copied from the source session
src = make_session("fork me")
add_blob(src["id"], "forkimg.png", PNG)
body = {"session": src["id"], "text": "look", "stream": False,
        "attachments": [{"kind": "image", "name": "forkimg.png", "orig": "fork.png", "size": len(PNG)}]}
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({
    "choices": [{"message": {"content": "nice"}}], "usage": {}}))]
run(chat.chat_send(FakeRequest(json_body=body)))
sess_src = resp_json(run(chat.chat_session_get(FakeRequest(match_info={"sid": src["id"]}))))["session"]
r = run(chat.chat_import(FakeRequest(json_body={
    "title": "Fork: fork me",
    "messages": [dict(m, nid=None) for m in sess_src["messages"]],
    "copy_blobs_from": src["id"]})))
j = resp_json(r)
check("v91 import creates a session", j["ok"] and j["session"]["id"] != src["id"], j)
check("v91 import carries the messages",
      [m["text"] for m in j["session"]["messages"]] == ["look", "nice"], j["session"]["messages"])
check("v91 import keeps the attachment part",
      j["session"]["messages"][0]["parts"][0]["name"] == "forkimg.png", j["session"]["messages"][0])
check("v91 import copies the blob file",
      os.path.isfile(os.path.join(chat._blobs_dir(j["session"]["id"]), "forkimg.png")))
check("v91 import builds a tree", "tree" in j["session"])
r = run(chat.chat_import(FakeRequest(json_body={"messages": "nope"})))
check("v91 import refuses a bad body", r.status == 400)

# clear resets the tree too
r = run(chat.chat_session_clear(FakeRequest(match_info={"sid": sid})))
j = resp_json(r)["session"]
check("v91 clear empties the path", j["messages"] == [], j["messages"])
check("v91 clear drops the tree", "tree" not in j, j.get("tree"))

# a linear payload never leaks nid into the upstream request
body = chat.build_upstream_payload(
    [{"role": "user", "text": "plain", "nid": "deadbeef", "ts": 1, "parts": []}],
    chat._load_config(), sid)
um = [m for m in body["messages"] if m["role"] == "user"][-1]
check("v91 nid never goes upstream",
      um == {"role": "user", "content": [{"type": "text", "text": "plain"}]}, um)

# ---------------------------------------------------------------------------
phase("v92: conditional free + LLM wake + prep notes + queue flag")

# the registry probe comes back for the REAL mechanics
chat._upstream_models_full = _orig_upstream_models_full

# _comfy_loaded_count mirrors comfy.model_management.current_loaded_models
saved_mm = getattr(chat, "_comfy_mm", None)


class _FakeMM:
    def __init__(self, lst):
        self.current_loaded_models = lst


def _with_mm(lst, fn):
    chat._comfy_mm = lambda: _FakeMM(lst)
    try:
        return fn()
    finally:
        if saved_mm is not None:
            chat._comfy_mm = saved_mm


with0 = _with_mm([], lambda: chat._comfy_loaded_count())
check("v92 loaded count = 0 for an empty list", with0 == 0, with0)
none_mm = _with_mm(None, lambda: chat._comfy_loaded_count())
check("v92 loaded count = None when comfy hides the list", none_mm is None, none_mm)

# the conditional free: 0 loaded -> the nothing-to-free note, no real free
freed = {"n": 0}
chat._comfy_free_memory = lambda: (freed.__setitem__("n", freed["n"] + 1) or "freed!")
note = _with_mm([], lambda: chat._comfy_free_if_loaded())
check("v92 zero loaded -> already-unloaded note", "already unloaded" in note, note)
check("v92 zero loaded -> the real free did NOT run", freed["n"] == 0)
note = _with_mm([object(), object()], lambda: chat._comfy_free_if_loaded())
check("v92 two loaded -> the free ran with its note",
      freed["n"] == 1 and note.startswith("auto-free before the request: freed!"), note)

# _ensure_llm_ready: loaded -> skip; available -> switch + note; no registry -> no-op
async def _mm(models):
    return {"ok": True, "source": "registry", "models": models, "current": ""}


async def _loaded_registry(cfg):
    return await _mm([{"id": "test-model", "status": "loaded"}])


async def _available_registry(cfg):
    return await _mm([{"id": "test-model", "status": "available"}])


cfgw = seed_config(stream=False)
chat._upstream_models_full = _loaded_registry
ok, note = run(chat._ensure_llm_ready(cfgw, "test-model"))
check("v92 a loaded registry model wakes instantly", ok and note is None, (ok, note))
check("v92 a loaded model fires NO switch POST",
      not any(c[1].endswith("/api/models/load") for c in FakeClientSession.requests[-1:]))

chat._upstream_models_full = _available_registry
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({"ok": True}))]
ok, note = run(chat._ensure_llm_ready(cfgw, "test-model"))
check("v92 an available model is switched on the upstream", ok and note and "loaded (on request)" in note, (ok, note))
sw = [c for c in FakeClientSession.requests if c[1].endswith("/api/models/load")]
check("v92 the switch POST hit /api/models/load", len(sw) == 1, [c[1] for c in FakeClientSession.requests[-2:]])

chat._upstream_models_full = _no_registry_stub
ok, note = run(chat._ensure_llm_ready(cfgw, "test-model"))
check("v92 no registry -> the wake is a silent no-op", ok and note is None, (ok, note))

# _pre_send_prep: the notes come back as a list and NEVER raise
chat._upstream_models_full = _available_registry
FakeClientSession.script = [FakeUpstream(status=200, text=json.dumps({"ok": True}))]
cfgf = seed_config(stream=False, auto_free_comfy=True)
notes = run(chat._pre_send_prep(cfgf, "test-model"))
check("v92 prep notes carry the free + wake lines",
      isinstance(notes, list) and len(notes) == 2 and "auto-free" in notes[0] and "loaded (on request)" in notes[1],
      notes)
async def _probe_boom(cfg):
    raise RuntimeError("probe boom")


chat._upstream_models_full = _probe_boom
notes = run(chat._pre_send_prep(cfgf, "test-model"))
check("v92 a broken probe never fails the prep (error becomes a note)",
      isinstance(notes, list) and any("model wake failed" in n for n in notes), notes)

# the config roundtrip accepts the v92 queue flag
chat._upstream_models_full = _orig_upstream_models_full
r = run(chat.chat_config_set(FakeRequest(json_body={"auto_unload_llm_on_queue": True,
                                                    "auto_free_comfy": True})))
j = resp_json(r)
check("v92 config accepts auto_unload_llm_on_queue",
      j["ok"] and j["config"]["auto_unload_llm_on_queue"] is True, j.get("config"))
check("v92 config accepts auto_free_comfy",
      j["config"]["auto_free_comfy"] is True, j.get("config"))
r = run(chat.chat_config_set(FakeRequest(json_body={"auto_unload_llm_on_queue": False})))
check("v92 the queue flag flips back off",
      resp_json(r)["config"]["auto_unload_llm_on_queue"] is False)

# ---------------------------------------------------------------------------

print()
print("py_test_chat: %d passed, %d failed" % (PASS, FAIL))
if FAILURES:
    print("FAILURES:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
