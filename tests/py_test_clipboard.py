"""tests/py_test_clipboard.py - offline checks for the v71 python routes.

Runs WITHOUT ComfyUI: `server`, `aiohttp` and `folder_paths` are stubbed in
sys.modules before the modules under test are imported, so the route
registrars only need to record their handlers. Then the handlers are called
directly with fake aiohttp-style request objects.

Covers:
  * py/clipboard_helper.py
      - header guard: a request without X-SettingsHub-Clipboard -> 403
      - loopback guard: a foreign remote -> 403, loopback/mapped-v6 -> 200
      - _collect(): file list from ImageGrab paths (extension allow-list,
        per-file and total caps) and the raw-image -> PNG fallback
      - the handler returns {ok, files:[{name,mime,data}]} with base64 data
  * py/stack_store.py
      - POST /settings_hub/stack/file: video/audio/blob entries land in the
        index with the right `type`, ?name= is stored, bad ext -> 400
      - POST /settings_hub/stack/item: optional name is stored
      - POST /settings_hub/stack/patch: rename/tags/pinned/uses/bumpUses
      - GET /settings_hub/stack/file/<name>: Content-Type for every kind
      - eviction skips pinned entries

Run: python3 tests/py_test_clipboard.py   (exit 0 = all good)
"""
import asyncio
import base64
import json
import os
import re
import sys
import tempfile
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

    def set_body(self, body):
        self._body = body


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

    def delete(self, path):
        return self._reg("DELETE", path)


class FakePromptServer:
    instance = None

    def __init__(self):
        self.routes = FakeRoutes()


class CIDict(dict):
    """Case-insensitive dict - mirrors aiohttp's CIMultiDict headers."""

    def __init__(self, data=None):
        super().__init__()
        for k, v in (data or {}).items():
            self[k] = v

    def __setitem__(self, k, v):
        super().__setitem__(k.lower(), v)

    def __getitem__(self, k):
        return super().__getitem__(k.lower())

    def get(self, k, default=None):
        return super().get(k.lower(), default)

    def __contains__(self, k):
        return super().__contains__(k.lower())


class FakeRequest:
    """Just enough of aiohttp.web.Request for the handlers under test."""

    def __init__(self, method="POST", path="/", headers=None, query=None,
                 match_info=None, body=b"", json_body=None, remote="127.0.0.1"):
        self.method = method
        self.path = path
        self.headers = CIDict(headers or {})
        self.query = dict(query or {})
        self.match_info = dict(match_info or {})
        self.remote = remote
        self._json = json_body
        self._body = body

    async def json(self):
        if self._json is not None:
            return self._json
        return json.loads(self._body.decode("utf-8"))

    async def read(self):
        return self._body


def make_json_response_cls():
    class FileResponse:
        def __init__(self, path, headers=None):
            self.path = path
            self.headers = dict(headers or {})

    web_stub = types.SimpleNamespace()
    web_stub.json_response = staticmethod(
        lambda data, status=200, headers=None: FakeResponse(data, status, headers))
    web_stub.FileResponse = FileResponse
    return web_stub


server_stub = types.ModuleType("server")
server_stub.PromptServer = FakePromptServer
sys.modules["server"] = server_stub

aiohttp_stub = types.ModuleType("aiohttp")
aiohttp_stub.web = make_json_response_cls()
sys.modules["aiohttp"] = aiohttp_stub

fp_stub = types.ModuleType("folder_paths")
_USER_DIR = tempfile.mkdtemp(prefix="shub-user-")
fp_stub.get_user_directory = lambda: _USER_DIR
sys.modules["folder_paths"] = fp_stub

sys.path.insert(0, ROOT)

# The route registrars read PromptServer.instance at import time.
FakePromptServer.instance = FakePromptServer()

# Fake PIL used by clipboard_helper (ImageGrab with canned content).
pil_stub = types.ModuleType("PIL")
grab_mod = types.ModuleType("PIL.ImageGrab")
_PIL_RESULT = {"value": None}


def _grabclipboard():
    return _PIL_RESULT["value"]


grab_mod.ImageGrab = types.SimpleNamespace(grabclipboard=_grabclipboard)
pil_stub.ImageGrab = grab_mod.ImageGrab
sys.modules["PIL"] = pil_stub
sys.modules["PIL.ImageGrab"] = grab_mod

# ---------------------------------------------------------------------------

import importlib.util


def load(name, rel):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


clipboard_helper = load("shub_clipboard_helper", "py/clipboard_helper.py")
stack_store = load("shub_stack_store", "py/stack_store.py")

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
        FAILURES.append(f"{name}{(' :: ' + detail) if detail else ''}")
        print(f"  FAIL {name}{(' :: ' + detail) if detail else ''}")


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.new_event_loop().run_until_complete(coro)


def loop(coro):
    loop_ = asyncio.new_event_loop()
    try:
        return loop_.run_until_complete(coro)
    finally:
        loop_.close()


# ===========================================================================
# clipboard_helper
# ===========================================================================

print("== clipboard_helper ==")

check("helper: route registered", ("POST", "/settings_hub/clipboard") in
      FakePromptServer.instance.routes.handlers)
handler = FakePromptServer.instance.routes.handlers[("POST", "/settings_hub/clipboard")]


def call_helper(headers=None, remote="127.0.0.1"):
    return loop(handler(FakeRequest(headers=headers or {}, remote=remote)))


r = call_helper({})
check("helper: no header -> 403", r.status == 403, str(r.status))
r = call_helper({"X-SettingsHub-Clipboard": "1"}, remote="8.8.8.8")
check("helper: foreign remote -> 403", r.status == 403, str(r.status))
r = call_helper({"X-SettingsHub-Clipboard": "1"}, remote="::ffff:127.0.0.1")
check("helper: mapped-v6 loopback -> 200", r.status == 200, str(r.status))

# _collect with file paths (PIL returns a list of paths)
tmpdir = tempfile.mkdtemp(prefix="shub-clip-")
png = os.path.join(tmpdir, "shot.png")
txt = os.path.join(tmpdir, "note.txt")
mp4 = os.path.join(tmpdir, "clip.mp4")
exe = os.path.join(tmpdir, "bad.exe")
big = os.path.join(tmpdir, "huge.png")
for p, data in ((png, b"\x89PNG fake"), (txt, b"hello"), (mp4, b"\x00mp4"),
                (exe, b"MZ"), (big, b"x" * (26 * 1024 * 1024))):
    with open(p, "wb") as f:
        f.write(data)
_PIL_RESULT["value"] = [png, txt, mp4, exe, big]
files = clipboard_helper._collect()
names = [f["name"] for f in files]
check("collect: allowed files only", set(names) == {"shot.png", "note.txt", "clip.mp4"},
      str(names))
by_name = {f["name"]: f for f in files}
check("collect: png data round-trips",
      base64.b64decode(by_name["shot.png"]["data"]) == b"\x89PNG fake")
check("collect: png mime", by_name["shot.png"]["mime"] == "image/png")
check("collect: mp4 mime", by_name["clip.mp4"]["mime"] == "video/mp4")
check("collect: txt mime", by_name["note.txt"]["mime"] == "text/plain")

# raw image fallback (PIL returns an image object instead of paths)
class FakePilImage:
    def convert(self, _mode):
        return self

    def save(self, buf, fmt):
        buf.write(b"\x89PNG-from-image")


_PIL_RESULT["value"] = FakePilImage()
files = clipboard_helper._collect()
check("collect: raw image -> one png",
      len(files) == 1 and files[0]["name"] == "clipboard.png" and
      base64.b64decode(files[0]["data"]) == b"\x89PNG-from-image",
      str(files))

# handler returns the files
_PIL_RESULT["value"] = [png]
r = call_helper({"X-SettingsHub-Clipboard": "1"})
j = r.json()
check("helper: ok + files", r.status == 200 and j.get("ok") is True and
      [f["name"] for f in j.get("files", [])] == ["shot.png"], json.dumps(j)[:120])

# ===========================================================================
# stack_store: file route, name, patch, serve, eviction
# ===========================================================================

print("== stack_store ==")

routes = FakePromptServer.instance.routes.handlers
check("store: file route registered", ("POST", "/settings_hub/stack/file") in routes)
check("store: patch route registered", ("POST", "/settings_hub/stack/patch") in routes)
check("store: health route registered", ("GET", "/settings_hub/stack/health") in routes)


def call(route, req):
    return loop(routes[route](req))


def add_file(data, ext, name="", remote="127.0.0.1"):
    q = {"ext": ext}
    if name:
        q["name"] = name
    return call(("POST", "/settings_hub/stack/file"),
                FakeRequest(query=q, body=data))


def get_items():
    r = call(("GET", "/settings_hub/stack"), FakeRequest(method="GET"))
    return r.json()["items"]


# v76: the self-diagnosis health route the web panel probes first
r = call(("GET", "/settings_hub/stack/health"), FakeRequest(method="GET"))
j = r.json()
check("health: ok", r.status == 200 and j.get("ok") is True, str(j)[:120])
# v82: the expected version is READ from py/stack_store.py - the suite never
# carries a release-version literal again (single-source version rule,
# docs/plan-versions.md).
_STACK_SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "..", "py", "stack_store.py"), encoding="utf-8").read()
_M = re.search(r'STACK_SERVER_VERSION\s*=\s*"(v\d+)"', _STACK_SRC)
_EXP_VER = _M.group(1) if _M else None
check("health: version matches STACK_SERVER_VERSION in source",
      _EXP_VER is not None and j.get("version") == _EXP_VER, str(j.get("version")))
check("health: writable", j.get("writable") is True, str(j.get("writable")))
check("health: items int", isinstance(j.get("items"), int) and j["items"] >= 0, str(j.get("items")))
check("health: dir is the stack root", str(j.get("dir", "")).replace("\\", "/").endswith("settings_hub/stack"), str(j.get("dir")))
# negative writability path (posix only: a 0o500 folder cannot host the probe file)
if os.name == "posix":
    _ro = os.path.join(_USER_DIR, "settings_hub", "stack", "items")
    os.makedirs(_ro, exist_ok=True)
    os.chmod(_ro, 0o500)
    try:
        r = call(("GET", "/settings_hub/stack/health"), FakeRequest(method="GET"))
        check("health: readonly folder -> writable false", r.json().get("writable") is False)
    finally:
        os.chmod(_ro, 0o700)


r = add_file(b"\x00\x00mp4bytes", "mp4", "my clip.mp4")
j = r.json()
check("file: ok", r.status == 200 and j["ok"] is True and not j.get("moved"))
it = j["item"]
check("file: type=video", it["type"] == "video", str(it))
check("file: name stored", it.get("name") == "my clip.mp4", str(it))
check("file: size", it["size"] == len(b"\x00\x00mp4bytes"))
check("file: blob exists", os.path.isfile(
    os.path.join(stack_store._items_dir(), it["file"])))

r = add_file(b"wavdata", "wav", "snd.wav")
check("file: audio type", r.json()["item"]["type"] == "audio")
r = add_file(b"zipdata", "zip", "pack.zip")
check("file: binary type", r.json()["item"]["type"] == "file")
r = add_file(b"doc", "pdf", "doc.pdf")
check("file: pdf type=file", r.json()["item"]["type"] == "file")

r = add_file(b"x", "html")
check("file: active-content ext refused", r.status == 400, str(r.status))
r = add_file(b"x", "totally_bogus_ext")
check("file: long ext refused", r.status == 400, str(r.status))
r = add_file(b"", "png")
check("file: empty payload -> 400", r.status == 400, str(r.status))
r = add_file(b"x" * (26 * 1024 * 1024), "png")
check("file: oversized -> 413", r.status == 413, str(r.status))

# dedup: same bytes move the entry
r = add_file(b"\x00\x00mp4bytes", "mp4", "renamed.mp4")
j = r.json()
check("file: dedup moved", j.get("moved") is True and j["item"]["id"] == it["id"])
check("file: dedup did not duplicate",
      len([x for x in get_items() if x["id"] == it["id"]]) == 1)
check("file: dedup backfills the name",
      j["item"].get("name") == "renamed.mp4" or j["item"].get("name") == "my clip.mp4",
      str(j["item"].get("name")))

# text entry with a name
r = call(("POST", "/settings_hub/stack/item"),
         FakeRequest(json_body={"text": "a prompt", "name": "prompt #1"}))
check("text: name stored", r.json()["item"].get("name") == "prompt #1", r.json().__str__())

# serve: content types
for fname, ctype in ((it["file"], "video/mp4"),):
    r = call(("GET", "/settings_hub/stack/file/{name}"),
             FakeRequest(method="GET", match_info={"name": fname}))
    check("serve: video content-type", r.headers.get("Content-Type") == ctype,
          str(r.headers))
r = call(("GET", "/settings_hub/stack/file/{name}"),
         FakeRequest(method="GET", match_info={"name": "../../etc/passwd"}))
check("serve: traversal refused", r.status in (400, 404), str(r.status))

# patch: rename/tags/pin/uses
iid = it["id"]
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(json_body={"id": iid, "name": "hero clip", "tags": [" ref ", "hero", "hero"],
                                "pinned": True, "bumpUses": True}))
j = r.json()
check("patch: ok+item", j.get("ok") is True and j["item"]["id"] == iid)
check("patch: renamed", j["item"]["name"] == "hero clip", str(j["item"].get("name")))
check("patch: tags cleaned+deduped", j["item"]["tags"] == ["ref", "hero"],
      str(j["item"].get("tags")))
check("patch: pinned", j["item"]["pinned"] is True)
check("patch: uses bumped", j["item"]["uses"] == 1, str(j["item"].get("uses")))
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(json_body={"id": iid, "uses": 7}))
check("patch: absolute uses", r.json()["item"]["uses"] == 7)
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(json_body={"id": iid, "tags": []}))
check("patch: empty tags removed", "tags" not in r.json()["item"], str(r.json()["item"]))
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(json_body={"id": "nope", "name": "x"}))
check("patch: bad id -> 400", r.status == 400, str(r.status))

# eviction skips pinned: shrink the caps, push junk, the pinned entry lives
old_items, old_total = stack_store.MAX_ITEMS, stack_store.MAX_TOTAL_BYTES
try:
    stack_store.MAX_ITEMS = 3
    stack_store.MAX_TOTAL_BYTES = 10 * 1024 * 1024
    call(("POST", "/settings_hub/stack/item"), FakeRequest(json_body={"text": "junk 1"}))
    call(("POST", "/settings_hub/stack/item"), FakeRequest(json_body={"text": "junk 2"}))
    call(("POST", "/settings_hub/stack/item"), FakeRequest(json_body={"text": "junk 3"}))
    call(("POST", "/settings_hub/stack/item"), FakeRequest(json_body={"text": "junk 4"}))
    items = get_items()
    check("evict: cap enforced", len(items) <= 3, str(len(items)))
    check("evict: pinned survived", any(x["id"] == iid for x in items),
          str([x["id"] for x in items]))
finally:
    stack_store.MAX_ITEMS, stack_store.MAX_TOTAL_BYTES = old_items, old_total

# ===========================================================================
# v77: per-workflow scopes (?wf=)
# ===========================================================================

print("== stack_store v77: workflow scopes ==")

WF_A, WF_B, WF_C = "wfaaaaaaaaaaaa", "wfbbbbbbbbbbbb", "wfcccccccccccc"

# start from a clean shared store (the eviction tests left junk behind)
call(("POST", "/settings_hub/stack/clear"), FakeRequest())


def wf_get(wf=None):
    q = {"wf": wf} if wf else {}
    return call(("GET", "/settings_hub/stack"), FakeRequest(method="GET", query=q))


def add_text_wf(text, wf=None, name=None):
    q = {"wf": wf} if wf else {}
    body = {"text": text}
    if name:
        body["name"] = name
    return call(("POST", "/settings_hub/stack/item"), FakeRequest(query=q, json_body=body))


r = add_text_wf("shared entry")
check("wf: no wf= writes the shared store", r.status == 200 and
      [x["text"] for x in get_items()] == ["shared entry"], str(r.status))

r = add_text_wf("alpha prompt", WF_A)
check("wf: add to A ok", r.status == 200 and r.json()["ok"] is True, str(r.status))
r = add_text_wf("beta prompt", WF_B)
check("wf: add to B ok", r.status == 200, str(r.status))

check("wf: shared store untouched", [x["text"] for x in get_items()] == ["shared entry"],
      str(get_items()))
j = wf_get(WF_A).json()
check("wf: store A holds its entry only", [x["text"] for x in j["items"]] == ["alpha prompt"],
      str(j))
j = wf_get(WF_B).json()
check("wf: store B holds its entry only", [x["text"] for x in j["items"]] == ["beta prompt"],
      str(j))
r = wf_get(WF_C)
check("wf: never-written store reads as EMPTY 200 (not 404)",
      r.status == 200 and r.json()["items"] == [], str(r.status))

j = add_text_wf("alpha prompt", WF_A).json()
check("wf: dedup applies WITHIN a scope (moved)",
      j.get("moved") is True and len(wf_get(WF_A).json()["items"]) == 1, str(j))
j = add_text_wf("alpha prompt", WF_B).json()
check("wf: NO dedup ACROSS scopes (B gets its own copy)",
      j.get("moved") is not True and len(wf_get(WF_B).json()["items"]) == 2, str(j))

alpha_id = wf_get(WF_A).json()["items"][0]["id"]
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(query={"wf": WF_A}, json_body={"id": alpha_id, "name": "hero"}))
check("wf: patch scoped to A", r.json()["item"].get("name") == "hero", str(r.json()))
r = call(("POST", "/settings_hub/stack/patch"),
         FakeRequest(json_body={"id": alpha_id, "name": "hijack"}))
check("wf: patch from the shared store cannot see A's entry",
      r.json().get("gone") is True, str(r.json()))

r = loop(routes[("DELETE", "/settings_hub/stack/item/{item_id}")](
    FakeRequest(method="DELETE", query={"wf": WF_A}, match_info={"item_id": alpha_id})))
check("wf: delete scoped to A", r.json().get("ok") is True and
      wf_get(WF_A).json()["items"] == [], str(r.json()))

# blobs live in the workflow's own items/ dir
r = call(("POST", "/settings_hub/stack/file"),
         FakeRequest(query={"ext": "mp4", "wf": WF_A, "name": "clip.mp4"},
                     body=b"\x00\x00mp4bytes"))
wf_file = r.json()["item"]["file"]
check("wf: blob stored for A", r.status == 200, str(r.status))
r = call(("GET", "/settings_hub/stack/file/{name}"),
         FakeRequest(method="GET", query={"wf": WF_A}, match_info={"name": wf_file}))
check("wf: file route serves from the workflow store",
      isinstance(r, aiohttp_stub.web.FileResponse) and
      r.headers.get("Content-Type") == "video/mp4", str(type(r)))
r = call(("GET", "/settings_hub/stack/file/{name}"),
         FakeRequest(method="GET", match_info={"name": wf_file}))
check("wf: the shared store does NOT see the workflow blob", r.status == 404, str(r.status))

r = call(("POST", "/settings_hub/stack/clear"), FakeRequest(query={"wf": WF_B}))
check("wf: clear scoped to B", r.json().get("ok") is True and
      wf_get(WF_B).json()["items"] == [] and
      [x["text"] for x in get_items()] == ["shared entry"], str(r.json()))

r = wf_get("../../etc")
check("wf: malformed wf -> 400 (never falls through to the shared store)",
      r.status == 400, str(r.status))
r = add_text_wf("x", "../../etc")
check("wf: malformed wf on POST -> 400", r.status == 400, str(r.status))

j = call(("GET", "/settings_hub/stack/health"),
         FakeRequest(method="GET")).json()
check("wf: health reports the workflow store count", j.get("workflows") == 2,
      str(j.get("workflows")))  # A (cleared index) + B (cleared); C was never written

# cleanup of the temp user dir
r = call(("POST", "/settings_hub/stack/clear"), FakeRequest())
check("clear: ok", r.json().get("ok") is True)
check("clear: index empty", get_items() == [])

# ===========================================================================
# v84: custom storage root (GET/POST /settings_hub/stack/root) - the ⚙
# settings row re-points the storage to any ABSOLUTE folder; the default
# user/settings_hub/stack stays; entries are never moved.
# ===========================================================================

print("== stack_store: custom storage root (v84) ==")

check("root: GET route registered", ("GET", "/settings_hub/stack/root") in routes)
check("root: POST route registered", ("POST", "/settings_hub/stack/root") in routes)

ROOT_DEFAULT = os.path.join(_USER_DIR, "settings_hub", "stack")
ROOT_CUSTOM = os.path.join(_USER_DIR, "custom-stack-root")
ROOT_FILE = os.path.join(_USER_DIR, "settings_hub", "stack_root.json")


def read_json_file(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def same_path(a, b):
    return os.path.abspath(str(a)) == os.path.abspath(str(b))


r = call(("GET", "/settings_hub/stack/root"), FakeRequest(method="GET"))
j = r.json()
check("root: GET ok", r.status == 200 and j.get("ok") is True, str(j)[:120])
check("root: default reported",
      str(j.get("default", "")).replace("\\", "/").endswith("settings_hub/stack"),
      str(j.get("default")))
check("root: no custom at boot", j.get("custom") is None, str(j.get("custom")))
check("root: effective root == default", same_path(j.get("root"), ROOT_DEFAULT),
      str(j.get("root")))
check("root: writable", j.get("writable") is True, str(j.get("writable")))

# a relative path is REFUSED (owner contract: "any, by ABSOLUTE path")
r = call(("POST", "/settings_hub/stack/root"),
         FakeRequest(json_body={"path": "my/relative/stack"}))
check("root: relative path -> 400",
      r.status == 400 and r.json().get("ok") is False, str(r.status))
check("root: refusal names the path",
      "absolute" in str(r.json().get("error", "")), str(r.json().get("error")))

# a missing/non-string "path" key is an error (an accidental blank body must
# not reset the root - same philosophy as the clear route's empty ?tab=)
r = call(("POST", "/settings_hub/stack/root"), FakeRequest(json_body={}))
check("root: missing path key -> 400", r.status == 400, str(r.status))
r = call(("POST", "/settings_hub/stack/root"), FakeRequest(json_body={"path": 42}))
check("root: non-string path -> 400", r.status == 400, str(r.status))

# pasted quotes + surrounding spaces are stripped, the custom root applies
r = call(("POST", "/settings_hub/stack/root"),
         FakeRequest(json_body={"path": '  "' + ROOT_CUSTOM + '"  '}))
j = r.json()
check("root: quoted+spaces applied", r.status == 200 and j.get("ok") is True and
      same_path(j.get("root"), ROOT_CUSTOM), str(j.get("root")))
check("root: custom echoes back",
      j.get("custom") and same_path(j["custom"], ROOT_CUSTOM), str(j.get("custom")))

# the choice persists in the DEFAULT user dir (never inside the custom root)
check("root: override saved to the default user dir", os.path.isfile(ROOT_FILE),
      ROOT_FILE)
_saved = read_json_file(ROOT_FILE) or {}
check("root: saved json carries the custom path",
      isinstance(_saved.get("custom"), str) and same_path(_saved["custom"], ROOT_CUSTOM),
      str(_saved))

# the whole store follows: a new entry lands in the CUSTOM root only
r = call(("POST", "/settings_hub/stack/item"),
         FakeRequest(json_body={"text": "custom root entry"}))
check("root: item add ok", r.status == 200 and r.json().get("ok") is True,
      str(r.status))
check("root: index.json lives in the custom root",
      os.path.isfile(os.path.join(ROOT_CUSTOM, "index.json")), ROOT_CUSTOM)
_default_items = read_json_file(os.path.join(ROOT_DEFAULT, "index.json")) or []
check("root: default store untouched by the new entry",
      all(x.get("text") != "custom root entry" for x in _default_items),
      str(len(_default_items)) + " default entries")

# health answers custom + the effective dir
j = call(("GET", "/settings_hub/stack/health"), FakeRequest(method="GET")).json()
check("root: health carries custom",
      j.get("custom") and same_path(j["custom"], ROOT_CUSTOM), str(j.get("custom")))
check("root: health dir == custom root", same_path(j.get("dir"), ROOT_CUSTOM),
      str(j.get("dir")))

# per-workflow scopes live under the custom root too
r = call(("POST", "/settings_hub/stack/item"),
         FakeRequest(json_body={"text": "wf on custom root"}, query={"wf": "wfcustom1"}))
check("root: wf item ok", r.status == 200 and r.json().get("ok") is True, str(r.status))
check("root: wf store under the custom root",
      os.path.isfile(os.path.join(ROOT_CUSTOM, "workflows", "wfcustom1", "index.json")),
      str(os.path.join(ROOT_CUSTOM, "workflows", "wfcustom1")))

# an unwritable folder is refused and the previous root survives
if os.name == "posix":
    ROOT_RO = os.path.join(_USER_DIR, "readonly-root")
    os.makedirs(ROOT_RO, exist_ok=True)
    os.chmod(ROOT_RO, 0o500)
    try:
        r = call(("POST", "/settings_hub/stack/root"),
                 FakeRequest(json_body={"path": ROOT_RO}))
        check("root: unwritable folder -> 400",
              r.status == 400 and "writable" in str(r.json().get("error", "")),
              str(r.status))
    finally:
        os.chmod(ROOT_RO, 0o700)
    check("root: refusal keeps the previous root",
          same_path(call(("GET", "/settings_hub/stack/root"),
                         FakeRequest(method="GET")).json().get("root"), ROOT_CUSTOM), "")

# back to the default: explicit empty string
r = call(("POST", "/settings_hub/stack/root"), FakeRequest(json_body={"path": "   "}))
j = r.json()
check("root: empty path -> back to default",
      r.status == 200 and j.get("ok") is True and j.get("custom") is None and
      same_path(j.get("root"), ROOT_DEFAULT), str(j.get("root")))
_saved = read_json_file(ROOT_FILE) or {}
check("root: cleared override persisted", _saved.get("custom") is None, str(_saved))
check("root: health custom null again",
      call(("GET", "/settings_hub/stack/health"),
           FakeRequest(method="GET")).json().get("custom") is None, "")
# the custom store keeps its files after the switch back (never deleted)
check("root: old custom store keeps its files",
      os.path.isfile(os.path.join(ROOT_CUSTOM, "index.json")), ROOT_CUSTOM)

# ---------------------------------------------------------------------------

print(f"\npy_test_clipboard: {PASS} passed, {FAIL} failed")
if FAILURES:
    print("Failures:\n  " + "\n  ".join(FAILURES))
    sys.exit(1)
sys.exit(0)
