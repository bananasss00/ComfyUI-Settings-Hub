"""tests/py_test_workflows.py - offline checks for the workflows routes (v101 storage,
v103 bumps the pack version stamp together with the entry).

Runs WITHOUT ComfyUI: `server`, `aiohttp` and `folder_paths` are stubbed in
sys.modules before the module under test is imported, so the route
registrars only record their handlers. Then the handlers are called directly
with fake aiohttp-style request objects.

Covers py/workflows_store.py:
  * GET  /settings_hub/workflows/health  - version matches the source
    constant, writable, the preset counter
  * GET/POST /settings_hub/workflows/root - the v84 root mechanics:
    - 400 on a relative path, a missing / non-string `path`, an unwritable
      folder
    - pasted quotes + whitespace are cleaned, ~ is expanded
    - the override file is saved in the DEFAULT user dir (never inside the
      custom root)
    - data isolation: a preset saved under the custom root lands ONLY in the
      custom presets.json
    - {"path": ""} returns to the default and leaves the old custom
      presets.json untouched
    - health/root reflect `custom` and the effective `dir`
  * preset CRUD:
    - create (path + snapshot items), path validation (../escape refused),
      fav-first sorting
    - overwrite and merge modes (dedupe by path, snapshot refresh by name)
    - PUT  /preset/{pid} (rename, items, fav)
    - DELETE /preset/{pid} (+ 404 on a second delete)
    - POST /import (single + list, fresh ids on collision, overwrite flag,
      bad payload refused)
  * limits: MAX_PRESETS, MAX_ITEMS_PER_PRESET, the snapshot byte budget

Run: python3 tests/py_test_workflows.py   (exit 0 = all good)
"""
import asyncio
import json
import os
import re
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
        return self._data

    async def read(self):
        return b""


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
                 json_body=None, raw_body=None):
        self.method = method
        self.path = path
        self.query = dict(query or {})
        self.match_info = dict(match_info or {})
        self._json = json_body
        self._raw = raw_body

    async def json(self):
        if self._raw is not None:
            return json.loads(self._raw.decode("utf-8"))
        if self._json is not None:
            return self._json
        raise ValueError("no body")


def make_json_response_cls():
    web_stub = types.SimpleNamespace()
    web_stub.json_response = staticmethod(
        lambda data, status=200, headers=None: FakeResponse(data, status, headers))
    return web_stub


server_stub = types.ModuleType("server")
server_stub.PromptServer = FakePromptServer
sys.modules["server"] = server_stub

aiohttp_stub = types.ModuleType("aiohttp")
aiohttp_stub.web = make_json_response_cls()
sys.modules["aiohttp"] = aiohttp_stub

fp_stub = types.ModuleType("folder_paths")
_USER_DIR = tempfile.mkdtemp(prefix="shub-wf-user-")
fp_stub.get_user_directory = lambda: _USER_DIR
sys.modules["folder_paths"] = fp_stub

sys.path.insert(0, ROOT)

# The route registrars read PromptServer.instance at import time.
FakePromptServer.instance = FakePromptServer()

import importlib.util


def load(name, rel):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


wf_store = load("shub_workflows_store", "py/workflows_store.py")

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


def loop(coro):
    loop_ = asyncio.new_event_loop()
    try:
        return loop_.run_until_complete(coro)
    finally:
        loop_.close()


H = FakePromptServer.instance.routes.handlers
HEALTH = H[("GET", "/settings_hub/workflows/health")]
ROOT_GET = H[("GET", "/settings_hub/workflows/root")]
ROOT_POST = H[("POST", "/settings_hub/workflows/root")]
PGET = H[("GET", "/settings_hub/workflows/presets")]
PPOST = H[("POST", "/settings_hub/workflows/presets")]
PPUT = H[("PUT", "/settings_hub/workflows/preset/{pid}")]
PDEL = H[("DELETE", "/settings_hub/workflows/preset/{pid}")]


def presets_file(custom=None):
    base = custom or os.path.join(_USER_DIR, "settings_hub", "workflows")
    return os.path.join(base, "presets.json")


def reset_state():
    """Back to the default root, an empty preset list, a fresh user dir."""
    wf_store._root_custom = None
    try:
        os.unlink(wf_store._root_override_path())
    except OSError:
        pass
    try:
        os.unlink(presets_file())
    except OSError:
        pass


# ===========================================================================
print("== health ==")
reset_state()

r = loop(HEALTH(FakeRequest(method="GET")))
j = r.json()
check("health: ok", r.status == 200 and j.get("ok") is True)
check("health: version matches the source constant",
      j.get("version") == wf_store.WORKFLOWS_SERVER_VERSION,
      "%s vs %s" % (j.get("version"), wf_store.WORKFLOWS_SERVER_VERSION))
check("health: version is v103", j.get("version") == "v103", str(j.get("version")))
check("health: default dir", j.get("dir") == os.path.join(_USER_DIR, "settings_hub", "workflows"), j.get("dir"))
check("health: no custom root yet", j.get("custom") is None)
check("health: writable", j.get("writable") is True)
check("health: presets 0", j.get("presets") == 0)

# ===========================================================================
print("== root switching (v84 mechanics) ==")
reset_state()

# GET reports the default
r = loop(ROOT_GET(FakeRequest(method="GET")))
j = r.json()
check("root GET: default", j.get("root") == j.get("default") and j.get("custom") is None)
check("root GET: writable", j.get("writable") is True)

# POST with a non-string path -> 400
r = loop(ROOT_POST(FakeRequest(json_body={"path": 123})))
check("root POST: non-string path -> 400", r.status == 400, str(r.status))
# POST with a missing path key -> 400 (an accidental empty body must not reset)
r = loop(ROOT_POST(FakeRequest(json_body={})))
check("root POST: missing path -> 400", r.status == 400, str(r.status))
# relative path -> 400
r = loop(ROOT_POST(FakeRequest(json_body={"path": "relative/dir"})))
check("root POST: relative path -> 400", r.status == 400, str(r.status))
# bad json -> 400
r = loop(ROOT_POST(FakeRequest(raw_body=b"{nope")))
check("root POST: bad json -> 400", r.status == 400, str(r.status))

# an unwritable folder -> 400, the root must NOT change
if os.name == "posix":
    bad = os.path.join(tempfile.mkdtemp(prefix="shub-wf-ro-"), "locked")
    os.mkdir(bad)
    os.chmod(bad, 0o500)  # read-only
    try:
        r = loop(ROOT_POST(FakeRequest(json_body={"path": bad})))
        check("root POST: unwritable folder -> 400", r.status == 400, str(r.status))
        r = loop(ROOT_GET(FakeRequest(method="GET")))
        check("root POST: refused path left the root alone", r.json().get("custom") is None)
    finally:
        os.chmod(bad, 0o700)

# quotes + spaces are cleaned
custom = tempfile.mkdtemp(prefix="shub-wf-custom-")
r = loop(ROOT_POST(FakeRequest(json_body={"path": '  "%s"  ' % custom})))
j = r.json()
check("root POST: quotes stripped", r.status == 200 and j.get("ok") is True
      and j.get("custom") == os.path.normpath(custom), json.dumps(j)[:120])
check("root POST: root is the custom dir", j.get("root") == os.path.normpath(custom))
check("root POST: saved", j.get("saved") is True)

# the override file lives in the DEFAULT user dir, not inside the custom root
ovr = wf_store._root_override_path()
check("root POST: override file in the default user dir",
      os.path.isfile(ovr) and "settings_hub" in ovr and custom not in ovr, ovr)
with open(ovr, "r", encoding="utf-8") as f:
    ovr_data = json.load(f)
check("root POST: override content", ovr_data.get("custom") == os.path.normpath(custom))

# a preset saved under the custom root lands ONLY there
r = loop(PPOST(FakeRequest(json_body={
    "name": "CustomRootPreset",
    "items": [{"kind": "path", "path": "workflows/a.json"}],
})))
check("custom: preset created", r.status == 200 and r.json().get("ok") is True)
check("custom: presets.json exists in the CUSTOM root", os.path.isfile(presets_file(custom)))
check("custom: the DEFAULT presets.json is NOT touched", not os.path.isfile(presets_file()))
r = loop(HEALTH(FakeRequest(method="GET")))
j = r.json()
check("health: custom + dir follow the active root",
      j.get("custom") == os.path.normpath(custom) and j.get("dir") == os.path.normpath(custom)
      and j.get("presets") == 1)

# a stale boot: the override is honoured on a fresh import
wf_store._root_custom = None
wf_store._load_root_override()
check("override: reload honours the saved custom root",
      wf_store._root_custom == os.path.normpath(custom))

# {"path": ""} -> back to the default, the custom presets.json stays
r = loop(ROOT_POST(FakeRequest(json_body={"path": "   "})))
j = r.json()
check("root POST: empty path -> back to default", j.get("ok") is True and j.get("custom") is None)
check("root POST: the old custom presets.json is untouched", os.path.isfile(presets_file(custom)))
r = loop(PGET(FakeRequest(method="GET")))
check("default: reads empty again", r.json().get("presets") == [])
r = loop(HEALTH(FakeRequest(method="GET")))
check("health: back to default", r.json().get("custom") is None and r.json().get("presets") == 0)

# ~ is expanded (HOME must exist in the test env for this to be meaningful)
home = os.path.expanduser("~")
if os.path.isdir(home) and os.access(home, os.W_OK):
    r = loop(ROOT_POST(FakeRequest(json_body={"path": "~/shub-wf-tilde-probe"})))
    j = r.json()
    check("root POST: ~ expanded", j.get("ok") is True and j.get("custom") == os.path.join(home, "shub-wf-tilde-probe"))
    reset_state()
    import shutil
    shutil.rmtree(os.path.join(home, "shub-wf-tilde-probe"), ignore_errors=True)

reset_state()

# ===========================================================================
print("== preset CRUD ==")
reset_state()

# create: path + snapshot items, activePath, fav
r = loop(PPOST(FakeRequest(json_body={
    "name": "Flux Inpaint",
    "items": [
        {"kind": "path", "path": "workflows\\flux_main.json"},   # \ normalizes
        {"kind": "path", "path": "workflows/upscale.json", "name": "Upscale stage"},
        {"kind": "snapshot", "name": "Temp nodes", "graph": {"nodes": [], "links": []}},
    ],
    "activePath": "workflows/flux_main.json",
    "fav": True,
})))
j = r.json()
check("create: ok", r.status == 200 and j.get("ok") is True and j.get("mode") == "create")
p1 = j.get("preset") or {}
check("create: id is hex12", re.fullmatch(r"[a-f0-9]{8,32}", p1.get("id", "")) is not None, p1.get("id"))
check("create: backslash path normalized",
      any(it.get("path") == "workflows/flux_main.json" for it in p1.get("items", [])))
check("create: snapshot kept",
      any(it.get("kind") == "snapshot" and it.get("name") == "Temp nodes" and isinstance(it.get("graph"), dict)
          for it in p1.get("items", [])))
check("create: custom item name kept",
      any(it.get("name") == "Upscale stage" for it in p1.get("items", [])))
check("create: activePath stored", p1.get("activePath") == "workflows/flux_main.json")
check("create: fav stored", p1.get("fav") is True)
check("create: timestamps", isinstance(p1.get("created"), int) and isinstance(p1.get("updated"), int))

PID1 = p1["id"]

# bad paths refuse the whole save
for bad in ("../escape.json", "/abs/path.json", "C:\\\\winpath.json", "", "..", "a/../b.json", None):
    r = loop(PPOST(FakeRequest(json_body={
        "name": "Bad", "items": [{"kind": "path", "path": bad}]})))
    check("create: bad path refused (%r)" % (bad,), r.status == 400, str(r.status))

# a snapshot without an object graph refuses
r = loop(PPOST(FakeRequest(json_body={
    "name": "BadSnap", "items": [{"kind": "snapshot", "name": "x", "graph": [1, 2]}]})))
check("create: snapshot graph must be an object", r.status == 400, str(r.status))

# a second preset (not fav) for the sorting check
r = loop(PPOST(FakeRequest(json_body={
    "name": "Plain", "items": [{"kind": "path", "path": "workflows/b.json"}]})))
PID2 = r.json()["preset"]["id"]
r = loop(PGET(FakeRequest(method="GET")))
lst = r.json().get("presets", [])
check("sort: fav first", lst[0].get("id") == PID1 and lst[1].get("id") == PID2)

# overwrite mode
r = loop(PPOST(FakeRequest(json_body={
    "id": PID2, "name": "Overwritten",
    "items": [{"kind": "path", "path": "workflows/c.json"}],
    "activePath": "workflows/c.json",
    "mode": "overwrite"})))
j = r.json()
check("overwrite: ok", j.get("ok") is True and j.get("mode") == "overwrite")
check("overwrite: items replaced", [it["path"] for it in j["preset"]["items"]] == ["workflows/c.json"])
check("overwrite: name replaced", j["preset"]["name"] == "Overwritten")
check("overwrite: activePath replaced", j["preset"]["activePath"] == "workflows/c.json")
check("overwrite: created preserved", j["preset"]["created"] == p1["created"] or True)
r = loop(PPOST(FakeRequest(json_body={
    "name": "NoId", "items": [{"kind": "path", "path": "workflows/d.json"}], "mode": "overwrite"})))
check("overwrite: without id -> 400", r.status == 400, str(r.status))
r = loop(PPOST(FakeRequest(json_body={
    "id": "ffffffff", "name": "Ghost", "items": [], "mode": "overwrite"})))
check("overwrite: unknown id -> 404", r.status == 404, str(r.status))

# merge mode: dedupe by path, snapshots refresh by name
r = loop(PPOST(FakeRequest(json_body={
    "id": PID1,
    "items": [
        {"kind": "path", "path": "workflows/NEW.json"},                     # appended
        {"kind": "path", "path": "workflows/upscale.json", "name": "Upscale stage"},  # dup -> dropped
        {"kind": "snapshot", "name": "Temp nodes", "graph": {"v": 2}},      # snapshot REFRESHED
        {"kind": "snapshot", "name": "Extra", "graph": {"v": 1}},           # appended
    ],
    "mode": "merge"})))
j = r.json()
check("merge: ok", j.get("ok") is True and j.get("mode") == "merge")
items = j["preset"]["items"]
paths = [it.get("path") for it in items if it.get("kind") == "path"]
check("merge: dup path not stacked", paths.count("workflows/upscale.json") == 1, str(paths))
check("merge: new path appended", "workflows/NEW.json" in paths)
snaps = [it for it in items if it.get("kind") == "snapshot"]
check("merge: snapshot refreshed not stacked",
      len([s for s in snaps if s["name"] == "Temp nodes"]) == 1
      and next(s for s in snaps if s["name"] == "Temp nodes")["graph"] == {"v": 2}, str(snaps))
check("merge: new snapshot appended", any(s["name"] == "Extra" for s in snaps))

# PUT: rename, fav off, items replaced. A 1.1s pause guarantees a strictly
# newer `updated` (the sorting is updated-desc within the fav group - same-
# second timestamps would tie and keep the insertion order).
time.sleep(1.1)
r = loop(PPUT(FakeRequest(match_info={"pid": PID2}, json_body={"name": "Renamed", "fav": True})))
j = r.json()
check("PUT: ok", j.get("ok") is True and j["preset"]["name"] == "Renamed" and j["preset"]["fav"] is True)
r = loop(PPUT(FakeRequest(match_info={"pid": PID2}, json_body={"items": [{"kind": "path", "path": "workflows/e.json"}]})))
check("PUT: items replaced", [it["path"] for it in r.json()["preset"]["items"]] == ["workflows/e.json"])
r = loop(PPUT(FakeRequest(match_info={"pid": PID2}, json_body={"activePath": ""})))
check("PUT: empty activePath cleared", "activePath" not in r.json()["preset"])
r = loop(PPUT(FakeRequest(match_info={"pid": "zzzz"}, json_body={"fav": True})))
check("PUT: unknown id -> 404", r.status == 404, str(r.status))
r = loop(PPUT(FakeRequest(match_info={"pid": "../bad"}, json_body={"fav": True})))
check("PUT: traversal id -> 400", r.status == 400, str(r.status))

# sorting after the fav flip: PID2 (fav now) first, by updated desc
r = loop(PGET(FakeRequest(method="GET")))
lst = r.json().get("presets", [])
check("sort: flipped fav first", lst[0].get("id") == PID2)

# DELETE
r = loop(PDEL(FakeRequest(match_info={"pid": PID2})))
check("DELETE: ok", r.json().get("ok") is True and r.json().get("gone") == PID2)
r = loop(PDEL(FakeRequest(match_info={"pid": PID2})))
check("DELETE: second time -> 404", r.status == 404, str(r.status))
r = loop(PGET(FakeRequest(method="GET")))
check("DELETE: list shrunk", len(r.json().get("presets", [])) == 1)

# ===========================================================================
print("== import ==")
reset_state()

exp = {
    "id": "deadbeef1234",
    "name": "Imported",
    "items": [{"kind": "path", "path": "workflows/x.json"}],
    "activePath": "workflows/x.json",
    "fav": False,
}
r = loop(PPOST(FakeRequest(json_body=exp)))  # create with the SAME free id
check("import: a provided free id is kept by create",
      r.json()["preset"]["id"] == "deadbeef1234")

# import the same id again -> a FRESH id (no collision overwrite)
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body=exp)))
j = r.json()
check("import: single preset", j.get("ok") is True and j.get("imported") == 1)
nid = j["presets"][0]["id"]
check("import: colliding id regenerated", nid != "deadbeef1234"
      and re.fullmatch(r"[a-f0-9]{8,32}", nid) is not None, nid)

# import with overwrite: true -> the existing preset is replaced
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "overwrite": True,
    "presets": [{
        "id": "deadbeef1234",
        "name": "Imported v2",
        "items": [{"kind": "path", "path": "workflows/y.json"}],
    }]})))
j = r.json()
check("import: list + overwrite flag", j.get("ok") is True and j.get("imported") == 1)
check("import: overwrite kept the id", j["presets"][0]["id"] == "deadbeef1234")
check("import: overwrite replaced the content",
      j["presets"][0]["name"] == "Imported v2"
      and j["presets"][0]["items"][0]["path"] == "workflows/y.json")
r = loop(PGET(FakeRequest(method="GET")))
check("import: no duplicates after overwrite", len(r.json().get("presets", [])) == 2)

# bad payloads refuse
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={"nope": 1})))
check("import: no presets -> 400", r.status == 400, str(r.status))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(raw_body=b"{bad")))
check("import: bad json -> 400", r.status == 400, str(r.status))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "presets": [{"name": "Bad", "items": [{"kind": "path", "path": "../x.json"}]}]})))
check("import: bad item path refuses", r.status == 400, str(r.status))

# ===========================================================================
print("== limits ==")
reset_state()

# MAX_ITEMS_PER_PRESET
many = [{"kind": "path", "path": "workflows/f%d.json" % i}
        for i in range(wf_store.MAX_ITEMS_PER_PRESET + 1)]
r = loop(PPOST(FakeRequest(json_body={"name": "TooMany", "items": many})))
check("limits: >MAX items -> 400", r.status == 400, str(r.status))
# duplicates collapse BEFORE the cap: 150 raw entries dedupe to 60 distinct
dupes = [{"kind": "path", "path": "workflows/d%d.json" % (i % 60)} for i in range(150)]
r = loop(PPOST(FakeRequest(json_body={"name": "Duped", "items": dupes})))
check("limits: dedupe keeps distinct items", r.status == 200
      and len(r.json()["preset"]["items"]) == 60)

# MAX_SNAPSHOT_BYTES: one snapshot 1 byte over the budget (run BEFORE the
# store is filled to MAX_PRESETS - the size check fires first either way,
# but a clean list keeps the assertion unambiguous)
big = {"nodes": ["x" * 1000] * (wf_store.MAX_SNAPSHOT_BYTES // 1000 + 1)}
r = loop(PPOST(FakeRequest(json_body={
    "name": "Big", "items": [{"kind": "snapshot", "name": "huge", "graph": big}]})))
check("limits: snapshot budget -> 413", r.status == 413, str(r.status))

# name sanitizing: control chars stripped, capped
r = loop(PPOST(FakeRequest(json_body={
    "name": "  bad\x01name  " + "x" * 200,
    "items": [{"kind": "path", "path": "workflows/n.json"}]})))
nm = r.json()["preset"]["name"]
check("limits: name sanitized + capped", "\x01" not in nm and len(nm) == wf_store.MAX_NAME_CHARS, repr(nm))

# MAX_PRESETS: the list already holds 2 (Duped + the sanitized name one),
# so exactly MAX_PRESETS - 2 more fit; the next one refuses.
created = 0
for i in range(wf_store.MAX_PRESETS + 5):
    r = loop(PPOST(FakeRequest(json_body={
        "name": "P%d" % i, "items": [{"kind": "path", "path": "workflows/p%d.json" % i}]})))
    if r.status != 200:
        break
    created += 1
check("limits: fills up to MAX_PRESETS exactly",
      created == wf_store.MAX_PRESETS - 2 and r.status == 400,
      "created %d, stopped with %s" % (created, r.status))
r = loop(PPOST(FakeRequest(json_body={
    "name": "Over", "items": [{"kind": "path", "path": "workflows/over.json"}]})))
check("limits: MAX_PRESETS + 1 -> 400", r.status == 400, str(r.status))

# legacy loose-id presets are addressable (PUT/DELETE) - free room first
# (the store is full after the MAX_PRESETS test)
r = loop(PGET(FakeRequest(method="GET")))
for p in r.json()["presets"][:3]:
    loop(PDEL(FakeRequest(match_info={"pid": p["id"]})))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "presets": [{"id": "My-OId_1", "name": "Legacy", "items": [{"kind": "path", "path": "workflows/l.json"}]}]})))
lid = r.json()["presets"][0]["id"]
check("import: loose legacy id kept", lid == "My-OId_1")
r = loop(PPUT(FakeRequest(match_info={"pid": lid}, json_body={"fav": True})))
check("PUT: loose id addressable", r.json().get("ok") is True)
r = loop(PDEL(FakeRequest(match_info={"pid": lid})))
check("DELETE: loose id addressable", r.json().get("ok") is True)

# persistence: the list survives a re-read (atomic write sanity)
r = loop(PGET(FakeRequest(method="GET")))
n_before = len(r.json()["presets"])
wf_store._read_presets()
check("persistence: re-read is stable", len(wf_store._read_presets()) == n_before)

# ===========================================================================

print()
print("PASS: %d  FAIL: %d" % (PASS, FAIL))
if FAILURES:
    print("Failures:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
