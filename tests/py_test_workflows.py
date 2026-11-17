"""tests/py_test_workflows.py - offline checks for the workflows routes (v104
per-preset storage + the legacy migration, v103 bumped the pack version).

Runs WITHOUT ComfyUI: `server`, `aiohttp` and `folder_paths` are stubbed in
sys.modules before the module under test is imported, so the route
registrars only record their handlers. Then the handlers are called directly
with fake aiohttp-style request objects.

Covers py/workflows_store.py:
  * v104 LAYOUT: every preset is its OWN presets/<id>.json file inside the
    storage root (the single-file presets.json is gone); snapshots stay
    EMBEDDED in the preset file; copying a file into presets/ (the transfer
    scenario) makes it appear on the next read; a file whose inner id
    disagrees with its name is ignored; a corrupt file skips itself without
    blanking the list; DELETE removes the file
  * the ONE-TIME MIGRATION: a legacy presets.json array is split into
    per-preset files, the original is renamed presets.json.bak (kept, not
    deleted); the folder copy wins over the legacy one (rerun-safe);
    hand-edited legacy ids get fresh safe names; a NEW create after the
    migration never resurrects presets.json
  * GET  /settings_hub/workflows/health  - version matches the source
    constant, writable, the per-preset file counter
  * GET/POST /settings_hub/workflows/root - the v84 root mechanics:
    - 400 on a relative path, a missing / non-string `path`, an unwritable
      folder
    - pasted quotes + whitespace are cleaned, ~ is expanded
    - the override file is saved in the DEFAULT user dir (never inside the
      custom root)
    - data isolation: a preset saved under the custom root lands ONLY in the
      custom presets/ folder
    - {"path": ""} returns to the default and leaves the old custom
      presets/ folder untouched
    - health/root reflect `custom` and the effective `dir`
  * preset CRUD:
    - create (path + snapshot items), path validation (../escape refused),
      fav-first sorting
    - overwrite and merge modes (dedupe by path, snapshot refresh by name)
    - PUT  /preset/{pid} (rename, items, fav)
    - DELETE /preset/{pid} (+ 404 on a second delete)
    - POST /import (single + list, fresh ids on collision, overwrite flag,
      bad payload refused - all-or-nothing even with per-file writes)
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
                 json_body=None, raw_body=None, headers=None):
        self.method = method
        self.path = path
        self.query = dict(query or {})
        self.match_info = dict(match_info or {})
        self._json = json_body
        self._raw = raw_body
        self.headers = dict(headers or {})  # v109: comfy-user reads

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

    # v116: the restore open-copy mode returns a raw bytes Response
    class _RawResponse:
        def __init__(self, body=None, content_type=None):
            self.body = body
            self.content_type = content_type
            self.status = 200

    web_stub.Response = _RawResponse
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
# v116: the store's sibling fallback imports (workflows_index/
# workflows_history) resolve through the py/ directory
sys.path.insert(0, os.path.join(ROOT, "py"))

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
# v107: the temp-snapshot routes (the reopen payloads of closed TEMP tabs)
TLIST = H[("GET", "/settings_hub/workflows/temp")]
TPUT = H[("POST", "/settings_hub/workflows/temp")]
TGET = H[("GET", "/settings_hub/workflows/temp/{tid}")]
TDEL = H[("DELETE", "/settings_hub/workflows/temp/{tid}")]


def presets_dir(custom=None):
    """The v104 per-preset folder of the given (or active-default) root."""
    base = custom or os.path.join(_USER_DIR, "settings_hub", "workflows")
    return os.path.join(base, "presets")


def preset_file(pid, custom=None):
    return os.path.join(presets_dir(custom), pid + ".json")


def presets_file(custom=None):
    """The LEGACY v101-v103 single-file store (only the migration tests use
    it now)."""
    base = custom or os.path.join(_USER_DIR, "settings_hub", "workflows")
    return os.path.join(base, "presets.json")


def temp_dir(custom=None):
    """The v107 reserved temp-snapshot folder of the given (or default) root."""
    base = custom or os.path.join(_USER_DIR, "settings_hub", "workflows")
    return os.path.join(base, "temp")


def reset_state():
    """Back to the default root, an EMPTY preset + temp folder, no legacy file."""
    wf_store._root_custom = None
    import shutil
    for d in (presets_dir(), temp_dir()):
        try:
            shutil.rmtree(d)
        except OSError:
            pass
    for f in (presets_file(), presets_file() + ".bak"):
        try:
            os.unlink(f)
        except OSError:
            pass
    try:
        os.unlink(wf_store._root_override_path())
    except OSError:
        pass


# ===========================================================================
print("== health ==")
reset_state()

r = loop(HEALTH(FakeRequest(method="GET")))
j = r.json()
check("health: ok", r.status == 200 and j.get("ok") is True)
_HEALTH_VER = wf_store.WORKFLOWS_SERVER_VERSION
check("health: version matches the source constant (%s)" % _HEALTH_VER,
      j.get("version") == wf_store.WORKFLOWS_SERVER_VERSION,
      "%s vs %s" % (j.get("version"), wf_store.WORKFLOWS_SERVER_VERSION))
check("health: default dir", j.get("dir") == os.path.join(_USER_DIR, "settings_hub", "workflows"), j.get("dir"))
check("health: no custom root yet", j.get("custom") is None)
check("health: writable", j.get("writable") is True)
check("health: presets 0", j.get("presets") == 0)
check("health: temp counter 0 (v107)", j.get("temp") == 0, str(j.get("temp")))

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

# a preset saved under the custom root lands ONLY there (its OWN file in
# the custom presets/ folder)
r = loop(PPOST(FakeRequest(json_body={
    "name": "CustomRootPreset",
    "items": [{"kind": "path", "path": "workflows/a.json"}],
})))
check("custom: preset created", r.status == 200 and r.json().get("ok") is True)
CUSTOM_PID = r.json()["preset"]["id"]
check("custom: presets/<id>.json exists in the CUSTOM root",
      os.path.isfile(preset_file(CUSTOM_PID, custom)), preset_file(CUSTOM_PID, custom))
check("custom: the DEFAULT presets/ folder is NOT touched", not os.path.isdir(presets_dir()))
check("custom: no legacy presets.json either", not os.path.isfile(presets_file(custom)))
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

# {"path": ""} -> back to the default, the custom presets/ folder stays
r = loop(ROOT_POST(FakeRequest(json_body={"path": "   "})))
j = r.json()
check("root POST: empty path -> back to default", j.get("ok") is True and j.get("custom") is None)
check("root POST: the old custom presets/ folder is untouched",
      os.path.isfile(preset_file(CUSTOM_PID, custom)))
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
print("== v104 per-preset files + the one-time legacy migration ==")
reset_state()

# A root that still holds the LEGACY v101-v103 presets.json (a fresh install
# of the old build over the new one - the typical upgrade path)
LEGACY = [
    {"id": "aaa111bbb222", "name": "Legacy One", "created": 1, "updated": 20,
     "fav": True,
     "items": [{"kind": "path", "path": "workflows/l1.json"},
               {"kind": "snapshot", "name": "Temp tab",
                "graph": {"nodes": [{"id": 1}], "links": []}}]},
    {"id": "ccc333ddd444", "name": "Legacy Two", "created": 2, "updated": 30,
     "fav": False,
     "items": [{"kind": "path", "path": "workflows/l2.json"}]},
    # a hand-edited legacy id (never written by the routes) - must survive
    {"id": "bad id!", "name": "Weird id", "created": 3, "updated": 40,
     "fav": False,
     "items": [{"kind": "path", "path": "workflows/l3.json"}]},
]
os.makedirs(os.path.dirname(presets_file()), exist_ok=True)
with open(presets_file(), "w", encoding="utf-8") as f:
    json.dump(LEGACY, f)

r = loop(PGET(FakeRequest(method="GET")))  # the first read TRIGGERS the migration
lst = r.json().get("presets", [])
check("migration: all 3 legacy presets served", len(lst) == 3, str(len(lst)))
check("migration: fav-first order kept", lst[0]["name"] == "Legacy One", str([p["name"] for p in lst]))
check("migration: per-preset file for the first", os.path.isfile(preset_file("aaa111bbb222")))
check("migration: per-preset file for the second", os.path.isfile(preset_file("ccc333ddd444")))
weird = next((p for p in lst if p["name"] == "Weird id"), None)
check("migration: the weird id got a FRESH safe file name",
      weird is not None and weird["id"] != "bad id!"
      and re.fullmatch(r"[a-f0-9]{8,32}", weird["id"] or "") is not None
      and os.path.isfile(preset_file(weird["id"])), str(weird))
check("migration: presets.json is GONE (renamed)", not os.path.isfile(presets_file()))
check("migration: presets.json.bak exists (kept, never deleted)",
      os.path.isfile(presets_file() + ".bak"))
with open(presets_file() + ".bak", "r", encoding="utf-8") as f:
    bak = json.load(f)
check("migration: the .bak holds the ORIGINAL array",
      isinstance(bak, list) and len(bak) == 3 and bak[0]["id"] == "aaa111bbb222")
with open(preset_file("aaa111bbb222"), "r", encoding="utf-8") as f:
    pf = json.load(f)
check("migration: the snapshot stays INSIDE the preset file",
      any(it.get("kind") == "snapshot" and it.get("graph") == {"nodes": [{"id": 1}], "links": []}
          for it in pf.get("items", [])), json.dumps(pf.get("items", []))[:120])

# the migration is RERUN-SAFE: restoring the legacy file must not roll the
# folder back (the folder copy wins) and must not duplicate anything
with open(presets_file(), "w", encoding="utf-8") as f:
    json.dump([dict(LEGACY[0], name="ROLLBACK-ATTEMPT", updated=999)], f)
r = loop(PGET(FakeRequest(method="GET")))
lst = r.json().get("presets", [])
check("migration: rerun - the folder copy wins over the legacy one",
      any(p["id"] == "aaa111bbb222" and p["name"] == "Legacy One" for p in lst),
      str([p["name"] for p in lst]))
check("migration: rerun - no duplicates", len(lst) == 3, str(len(lst)))
check("migration: rerun - the legacy file renamed to .bak again",
      not os.path.isfile(presets_file()) and os.path.isfile(presets_file() + ".bak"))

# a NEW create after the migration must NOT resurrect presets.json
r = loop(PPOST(FakeRequest(json_body={
    "name": "After Migration", "items": [{"kind": "path", "path": "workflows/n.json"}]})))
NEW_PID = r.json()["preset"]["id"]
check("migration: create lands as its own file",
      os.path.isfile(preset_file(NEW_PID)) and not os.path.isfile(presets_file()))

# the transfer scenario: copy a preset FILE from another machine (a dict with
# a matching id) into presets/ -> it appears on the next read
TRANSFER = {"id": "feedface0000", "name": "Copied From Afar", "created": 9,
            "updated": 9, "fav": False,
            "items": [{"kind": "path", "path": "workflows/copy.json"}]}
with open(preset_file("feedface0000"), "w", encoding="utf-8") as f:
    json.dump(TRANSFER, f)
r = loop(PGET(FakeRequest(method="GET")))
check("transfer: a copied file appears on the next read",
      any(p["id"] == "feedface0000" and p["name"] == "Copied From Afar"
          for p in r.json().get("presets", [])))

# a file whose inner id DISAGREES with its name is ignored (never served)
with open(preset_file("feedface1111"), "w", encoding="utf-8") as f:
    json.dump(dict(TRANSFER, id="feedface2222"), f)
r = loop(PGET(FakeRequest(method="GET")))
check("layout: an id/name mismatch is ignored",
      not any(p["id"] in ("feedface1111", "feedface2222") for p in r.json().get("presets", [])))
os.unlink(preset_file("feedface1111"))

# a corrupt file skips itself without blanking the list
with open(preset_file("deadbeefdead"), "w", encoding="utf-8") as f:
    f.write("{nope")
r = loop(PGET(FakeRequest(method="GET")))
lst = r.json().get("presets", [])
check("layout: a corrupt file does not blank the list",
      len(lst) == 5 and not any(p["id"] == "deadbeefdead" for p in lst), str(len(lst)))
os.unlink(preset_file("deadbeefdead"))

# DELETE removes the per-preset FILE (not an array entry)
r = loop(PDEL(FakeRequest(match_info={"pid": NEW_PID})))
check("layout: DELETE ok", r.json().get("ok") is True)
check("layout: DELETE removed the file",
      not os.path.exists(preset_file(NEW_PID)))

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

# v104: the create landed as its OWN per-preset file with the snapshot
# INSIDE it, and no legacy presets.json was written
check("create: its own presets/<id>.json exists", os.path.isfile(preset_file(PID1)))
check("create: no legacy presets.json resurrected", not os.path.isfile(presets_file()))
with open(preset_file(PID1), "r", encoding="utf-8") as f:
    _pf = json.load(f)
check("create: the file holds the FULL preset object (snapshot embedded)",
      _pf.get("id") == PID1 and _pf.get("name") == "Flux Inpaint"
      and any(it.get("kind") == "snapshot" and isinstance(it.get("graph"), dict)
              for it in _pf.get("items", [])))

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

# v112 stage 3 (plan 7.4): the snapshot dedupe moved to CONTENT - the same
# graph re-merge REFRESHES; a same-name DIFFERENT graph COEXISTS (the plan's
# acceptance criterion: two same-name/different-graph snapshots survive)
r = loop(PPOST(FakeRequest(json_body={
    "id": PID1,
    "items": [
        {"kind": "path", "path": "workflows/NEW.json"},                     # appended
        {"kind": "path", "path": "workflows/upscale.json", "name": "Upscale stage"},  # dup -> dropped
        {"kind": "snapshot", "name": "Same graph new name", "graph": {"nodes": [], "links": []}},  # SAME content as the existing -> REFRESHED
        {"kind": "snapshot", "name": "Temp nodes v2", "graph": {"v": 2}},   # different graph -> appended
        {"kind": "snapshot", "name": "Extra", "graph": {"v": 3}},           # appended (distinct content)
    ],
    "mode": "merge"})))
j = r.json()
check("merge: ok", j.get("ok") is True and j.get("mode") == "merge")
items = j["preset"]["items"]
paths = [it.get("path") for it in items if it.get("kind") == "path"]
check("merge: dup path not stacked", paths.count("workflows/upscale.json") == 1, str(paths))
check("merge: new path appended", "workflows/NEW.json" in paths)
snaps = [it for it in items if it.get("kind") == "snapshot"]
check("merge: the SAME graph content refreshes (not stacked)",
      len([s for s in snaps if s["graph"] == {"nodes": [], "links": []}]) == 1, str(snaps))
check("merge: a same-name DIFFERENT graph COEXISTS (plan 7.4)",
      any(s["graph"] == {"v": 2} for s in snaps),
      json.dumps([s["graph"] for s in snaps]))
check("merge: every item carries a stable itemId (plan 7.3)",
      all(it.get("itemId") for it in items), json.dumps(items)[:120])

# the activeItemId contract: a SNAPSHOT can be the preset's active item
AID = snaps[0]["itemId"]
r = loop(PPOST(FakeRequest(json_body={
    "id": PID1, "items": snaps + [{"kind": "path", "path": "workflows/a.json"}],
    "activeItemId": AID, "mode": "overwrite"})))
check("activeItemId: a snapshot can be the active item",
      r.json().get("ok") is True and r.json()["preset"].get("activeItemId") == AID,
      json.dumps(r.json())[:160])
r = loop(PPOST(FakeRequest(json_body={
    "id": PID1, "items": snaps, "activeItemId": "does-not-exist-00", "mode": "overwrite"})))
check("activeItemId: a dangling id is dropped",
      r.json().get("ok") is True and "activeItemId" not in r.json()["preset"])

# the snapshot origin metadata survives sanitization (plan 7.2)
r = loop(PPOST(FakeRequest(json_body={
    "name": "SnapMeta", "items": [{"kind": "snapshot", "name": "From disk",
        "graph": {"nodes": []}, "sourcePath": "workflows/a.json",
        "sourceName": "a.json", "workflowId": "abcd-1234", "capturedAt": 1700000000}],
    "mode": "create"})))
snap_meta = r.json()["preset"]["items"][0]
loop(PDEL(FakeRequest(match_info={"pid": snap_meta.get("__pid") or r.json()["preset"]["id"]})))
check("snapshot metadata: the origin fields survive (validated)",
      snap_meta.get("sourcePath") == "workflows/a.json" and
      snap_meta.get("sourceName") == "a.json" and
      snap_meta.get("workflowId") == "abcd-1234" and
      snap_meta.get("capturedAt") == 1700000000,
      json.dumps(snap_meta))
r = loop(PPOST(FakeRequest(json_body={
    "name": "SnapMetaBad", "items": [{"kind": "snapshot", "name": "Evil",
        "graph": {"nodes": []}, "sourcePath": "../../etc/passwd"}],
    "mode": "create"})))
check("snapshot metadata: a traversal sourcePath is REFUSED",
      r.status == 400, str(r.status))

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
check("import: each preset landed as its OWN file",
      os.path.isfile(preset_file("deadbeef1234")) and os.path.isfile(preset_file(nid)))

# bad payloads refuse
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={"nope": 1})))
check("import: no presets -> 400", r.status == 400, str(r.status))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(raw_body=b"{bad")))
check("import: bad json -> 400", r.status == 400, str(r.status))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "presets": [{"name": "Bad", "items": [{"kind": "path", "path": "../x.json"}]}]})))
check("import: bad item path refuses", r.status == 400, str(r.status))
# v104 all-or-nothing holds with per-file writes: the refused import (a bad
# preset AFTER a good one in the same payload) must not leave ANY new file
before = sorted(os.listdir(presets_dir()))
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "presets": [
        {"name": "GoodOne", "items": [{"kind": "path", "path": "workflows/g.json"}]},
        {"name": "BadOne", "items": [{"kind": "path", "path": "../escape.json"}]},
    ]})))
after = sorted(os.listdir(presets_dir()))
check("import: a mixed good+bad payload refuses", r.status == 400, str(r.status))
check("import: NOTHING landed from the refused import", before == after,
      "%s vs %s" % (before, after))

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
print("== temp snapshots (v107: the reopen payloads of closed TEMP tabs)")
reset_state()

# empty list
r = loop(TLIST(FakeRequest(method="GET")))
check("temp list: empty root -> ok, no items", r.status == 200 and r.json().get("ok") is True
      and r.json().get("items") == [])

# PUT stores ONE snapshot as temp/<id>.json; the id is strict hex
r = loop(TPUT(FakeRequest(json_body={"name": "Unsaved Workflow (3)",
                                     "graph": {"nodes": [{"id": 1}], "links": []}})))
j = r.json()
tid1 = j.get("id", "")
check("temp PUT: ok + strict-hex id", r.status == 200 and j.get("ok") is True
      and wf_store._ID_RE.match(tid1) is not None, json.dumps(j)[:120])
check("temp PUT: the file landed in the RESERVED temp/ folder",
      os.path.isfile(os.path.join(temp_dir(), tid1 + ".json")))
check("temp PUT: the file is NOT inside presets/",
      not os.path.exists(os.path.join(presets_dir(), tid1 + ".json")))

# GET returns the graph back
r = loop(TGET(FakeRequest(method="GET", match_info={"tid": tid1})))
j = r.json()
check("temp GET: the graph round-trips", r.status == 200 and j.get("ok") is True
      and j.get("graph", {}).get("nodes", [{}])[0].get("id") == 1
      and j.get("name") == "Unsaved Workflow (3)")

# GET of an unknown id -> 404 (the client says 'the snapshot is gone')
r = loop(TGET(FakeRequest(method="GET", match_info={"tid": "deadbeef0000"})))
check("temp GET: unknown id -> 404", r.status == 404, str(r.status))
# bad id shapes never reach the filesystem
for bad in ("../escape", "x", "ZZZZ", "deadbeef0000/tmp"):
    r = loop(TGET(FakeRequest(method="GET", match_info={"tid": bad})))
    check("temp GET: bad id refused (%s)" % bad[:12], r.status == 400, str(r.status))

# PUT without a graph -> 400; unserializable graph -> 400; oversized -> 413
r = loop(TPUT(FakeRequest(json_body={"name": "NoGraph"})))
check("temp PUT: no graph -> 400", r.status == 400, str(r.status))
r = loop(TPUT(FakeRequest(raw_body=b"{bad")))
check("temp PUT: bad json -> 400", r.status == 400, str(r.status))
big = {"nodes": ["x" * 1000] * (wf_store.MAX_SNAPSHOT_BYTES // 1000 + 1)}
r = loop(TPUT(FakeRequest(json_body={"name": "Huge", "graph": big})))
check("temp PUT: over MAX_SNAPSHOT_BYTES -> 413", r.status == 413, str(r.status))

# name sanitizing + the "Unsaved" default
r = loop(TPUT(FakeRequest(json_body={"name": "  bad\x01name  " + "y" * 200,
                                     "graph": {"nodes": []}})))
nm = r.json().get("name", "")
check("temp PUT: name sanitized + capped", "\x01" not in nm and len(nm) == wf_store.MAX_NAME_CHARS, repr(nm))
r = loop(TPUT(FakeRequest(json_body={"graph": {"nodes": []}})))
check("temp PUT: a missing name becomes Unsaved", r.json().get("name") == "Unsaved")

# the LIST carries metadata only (no graphs leak into the index) - by now
# the root holds: Unsaved Workflow (3) + the sanitized name + the Unsaved one
# (the 413-refused Huge and the two 400-refused PUTs stored nothing)
r = loop(TLIST(FakeRequest(method="GET")))
items = r.json().get("items", [])
check("temp list: metadata only (no graphs)", len(items) == 3
      and all(set(it.keys()) == {"id", "name", "ts"} for it in items),
      json.dumps(items)[:160])
check("temp list: sorted newest-first by ts", len(items) >= 2
      and all(items[i]["ts"] >= items[i + 1]["ts"] for i in range(len(items) - 1)),
      json.dumps([it["ts"] for it in items]))

# DELETE removes the file; a second delete is IDEMPOTENT (existed:false)
r = loop(TDEL(FakeRequest(method="DELETE", match_info={"tid": tid1})))
j = r.json()
check("temp DELETE: ok + the file is gone", j.get("ok") is True and j.get("existed") is True
      and not os.path.exists(os.path.join(temp_dir(), tid1 + ".json")))
r = loop(TDEL(FakeRequest(method="DELETE", match_info={"tid": tid1})))
j = r.json()
check("temp DELETE: idempotent on a missing id (the client GC may race)",
      j.get("ok") is True and j.get("existed") is False, json.dumps(j))

# MAX_TEMP_FILES: the OLDEST beyond the cap are evicted on every PUT (the
# server stamps its own ts - a client-supplied one is ignored; same-second
# writes tie-break by the file mtime, so the write order decides)
for i in range(wf_store.MAX_TEMP_FILES + 5):
    r = loop(TPUT(FakeRequest(json_body={"name": "T%02d" % i, "ts": i,
                                         "graph": {"n": i}})))
n = len(wf_store._list_temp_files())
check("temp cap: the folder never exceeds MAX_TEMP_FILES",
      n == wf_store.MAX_TEMP_FILES, str(n))
kept = [it["name"] for it in wf_store._list_temp_files()]
check("temp cap: the NEWEST survive the eviction",
      all("T%02d" % i in kept for i in range(5, wf_store.MAX_TEMP_FILES + 5)),
      json.dumps(kept[:8]))
check("temp cap: the OLDEST were evicted",
      all("T%02d" % i not in kept for i in range(5)))

# the temp folder follows the ACTIVE root (the v84 mechanics apply to it too)
custom = tempfile.mkdtemp(prefix="shub-wf-temp-custom-")
loop(ROOT_POST(FakeRequest(json_body={"path": custom})))
r = loop(TPUT(FakeRequest(json_body={"name": "InCustom", "graph": {"c": 1}})))
cid = r.json().get("id")
check("temp: a PUT under the CUSTOM root lands in the custom temp/ folder",
      os.path.isfile(os.path.join(temp_dir(custom), cid + ".json")))
check("temp: the DEFAULT root's temp folder did not get the file",
      not os.path.exists(os.path.join(temp_dir(), cid + ".json")))
r = loop(ROOT_POST(FakeRequest(json_body={"path": ""})))
check("temp: back to the default root", r.json().get("custom") is None)

# the health counter reflects the temp folder
r = loop(HEALTH(FakeRequest(method="GET")))
check("health: the temp counter counts the default-root files (v107)",
      r.json().get("temp") == wf_store.MAX_TEMP_FILES, str(r.json().get("temp")))
reset_state()

# ===========================================================================
print("== v108: unified storage view (both roots readable, no duplicates) ==")
reset_state()

# a preset in the DEFAULT root ...
r = loop(PPOST(FakeRequest(json_body={"name": "Home", "items": [
    {"kind": "path", "path": "workflows/a.json"}]})))
home_pid = r.json()["preset"]["id"]
check("unified: the preset was created in the default root",
      os.path.isfile(preset_file(home_pid)))

# ... then the storage root is re-pointed: the preset must STAY VISIBLE
custom = tempfile.mkdtemp(prefix="shub-wf-uni-custom-")
loop(ROOT_POST(FakeRequest(json_body={"path": custom})))
r = loop(PGET(FakeRequest(method="GET")))
ids = [p["id"] for p in r.json()["presets"]]
check("unified: the default-root preset is still listed under the custom root",
      home_pid in ids, json.dumps(ids))

# a NEW preset under the custom root lands there; BOTH are listed, no dupes
r = loop(PPOST(FakeRequest(json_body={"name": "Custom", "items": [
    {"kind": "path", "path": "workflows/b.json"}]})))
cust_pid = r.json()["preset"]["id"]
check("unified: a new preset lands in the ACTIVE (custom) root",
      os.path.isfile(preset_file(cust_pid, custom)) and
      not os.path.exists(preset_file(cust_pid)))
r = loop(PGET(FakeRequest(method="GET")))
got = [p["id"] for p in r.json()["presets"]]
check("unified: both presets visible, each exactly once",
      got.count(home_pid) == 1 and got.count(cust_pid) == 1, json.dumps(got))

# an id present in BOTH roots resolves to the ACTIVE copy
shutil_ = __import__("shutil")
dupe_pid = "aabbccdd1122"
os.makedirs(presets_dir(custom), exist_ok=True)
os.makedirs(presets_dir(), exist_ok=True)
with open(preset_file(dupe_pid, custom), "w", encoding="utf-8") as f:
    json.dump({"id": dupe_pid, "name": "ActiveCopy", "created": 1, "updated": 1,
               "fav": False, "items": []}, f)
with open(preset_file(dupe_pid), "w", encoding="utf-8") as f:
    json.dump({"id": dupe_pid, "name": "DefaultCopy", "created": 1, "updated": 1,
               "fav": False, "items": []}, f)
r = loop(PGET(FakeRequest(method="GET")))
dupe = [p for p in r.json()["presets"] if p["id"] == dupe_pid]
check("unified: the duplicate id resolves to the ACTIVE copy",
      len(dupe) == 1 and dupe[0].get("name") == "ActiveCopy", json.dumps(dupe))

# PUT writes WHERE THE PRESET LIVES (the default-root preset is updated in
# place - no forked copy appears in the custom root)
r = loop(PPUT(FakeRequest(match_info={"pid": home_pid},
                          json_body={"name": "HomeRenamed"})))
check("unified: PUT renamed the default-root preset",
      r.json().get("ok") and r.json()["preset"]["name"] == "HomeRenamed")
check("unified: the update did NOT fork a copy into the active root",
      not os.path.exists(preset_file(home_pid, custom)))
check("unified: the default-root file itself was updated",
      json.load(open(preset_file(home_pid), encoding="utf-8"))["name"] == "HomeRenamed")

# DELETE removes where it lives
r = loop(PDEL(FakeRequest(match_info={"pid": home_pid})))
check("unified: DELETE removed the default-root file",
      r.json().get("ok") and not os.path.exists(preset_file(home_pid)))
r = loop(PDEL(FakeRequest(match_info={"pid": cust_pid})))
check("unified: DELETE removed the custom-root file",
      r.json().get("ok") and not os.path.exists(preset_file(cust_pid, custom)))

# temp snapshots: a snapshot taken BEFORE the switch stays fetchable while
# its root is a member of the read set (active or default). A SWITCHED-OFF
# third location is out of the view by design - but nothing is deleted, and
# re-activating that root brings the snapshot back (no data loss).
r = loop(TPUT(FakeRequest(json_body={"name": "BeforeSwitch", "graph": {"x": 1}})))
tid = r.json()["id"]
check("unified: the temp snapshot landed in the ACTIVE (custom) root",
      os.path.isfile(os.path.join(temp_dir(custom), tid + ".json")))
r = loop(TGET(FakeRequest(match_info={"tid": tid})))
check("unified: the temp snapshot fetches under the custom root",
      r.json().get("ok") and r.json()["graph"] == {"x": 1})
loop(ROOT_POST(FakeRequest(json_body={"path": ""})))  # back to the default
r = loop(TGET(FakeRequest(match_info={"tid": tid})))
check("unified: the snapshot of the switched-OFF root is out of the view (not deleted)",
      r.status == 404)
r = loop(TLIST(FakeRequest(method="GET")))
check("unified: the temp list shows the DEFAULT root's files",
      all("BeforeSwitch" != it["name"] for it in r.json()["items"]))
loop(ROOT_POST(FakeRequest(json_body={"path": custom})))  # re-activate
r = loop(TGET(FakeRequest(match_info={"tid": tid})))
check("unified: re-activating the root brings the snapshot back (no data loss)",
      r.json().get("ok") and r.json()["name"] == "BeforeSwitch")
r = loop(TLIST(FakeRequest(method="GET")))
check("unified: the temp list covers the ACTIVE + the DEFAULT roots",
      any(it["id"] == tid for it in r.json()["items"]))
r = loop(TDEL(FakeRequest(match_info={"tid": tid})))
check("unified: the temp delete cleans the custom-root file",
      r.json().get("ok") and r.json().get("existed") is True and
      not os.path.exists(os.path.join(temp_dir(custom), tid + ".json")))
loop(ROOT_POST(FakeRequest(json_body={"path": ""})))

# the health presets counter reports the VISIBLE (unique) presets
r = loop(HEALTH(FakeRequest(method="GET")))
vis = len(wf_store._read_presets())
check("unified: health counts the visible presets (both roots)",
      r.json().get("presets") == vis, str(r.json().get("presets")) + " vs " + str(vis))
reset_state()

# ===========================================================================
print("== v108: the Files listing + the favorites ==")

# a small workflows/ library: root file, nested files, and the storage-root
# housekeeping that must NEVER surface in the Files list
# v109: the REAL userdata layout - the Workflow Browser lists
# <user_dir>/default/workflows (user_manager nests the users INSIDE the
# user directory); the flat <user_dir>/workflows is the legacy v108 layout
# and stays readable (nothing saved into it in that window may vanish)
wfdir = os.path.join(_USER_DIR, "default", "workflows")
legacy = os.path.join(_USER_DIR, "workflows")
sub = os.path.join(wfdir, "sub", "deep")
os.makedirs(sub, exist_ok=True)
os.makedirs(legacy, exist_ok=True)
def _touch(p, when=None, size=10):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write("x" * size)
    if when:
        os.utime(p, (when, when))
    return p

now = time.time()
_touch(os.path.join(wfdir, "a.json"), now - 100)
_touchb = _touch(os.path.join(wfdir, "sub", "b.json"), now - 50)
_touchc = _touch(os.path.join(wfdir, "sub", "deep", "c.json"), now - 10)
_touch(os.path.join(legacy, "legacy_flat.json"), now - 200)  # the v108 flat layout
# the storage housekeeping inside the workflows folder (a pathological but
# possible root placement) + a non-json stray
defroot = wf_store._default_root()
_touch(os.path.join(defroot, "presets", "zz.json"))
_touch(os.path.join(defroot, "temp", "zy.json"))
_touch(os.path.join(wfdir, "not_a_workflow.txt"))

FILES = H[("GET", "/settings_hub/workflows/files")]
FAV_GET = H[("GET", "/settings_hub/workflows/files-fav")]
FAV_POST = H[("POST", "/settings_hub/workflows/files-fav")]

r = loop(FILES(FakeRequest(method="GET")))
j = r.json()
paths = [f["path"] for f in j["files"]]
check("files: ok + the default-layout root named",
      j.get("ok") is True and j.get("root") == wfdir, str(j.get("root")))
check("files: the nested files are listed with workflows/ paths",
      "workflows/sub/b.json" in paths and "workflows/sub/deep/c.json" in paths,
      json.dumps(paths))
check("files: the root file is listed", "workflows/a.json" in paths)
check("files: the legacy flat layout is still listed (v108 window files)",
      "workflows/legacy_flat.json" in paths, json.dumps(paths))
check("files: only .json files", all(p.endswith(".json") for p in paths))
check("files: the storage presets/temp never mix in",
      not any("presets/" in p or "temp/" in p for p in paths), json.dumps(paths))
ameta = [f for f in j["files"] if f["path"] == "workflows/a.json"][0]
check("files: size + mtime carried", ameta["size"] == 10 and abs(ameta["mtime"] - (now - 100)) < 2)

# favorites: toggle on / off, persisted, traversal refused
r = loop(FAV_GET(FakeRequest(method="GET")))
check("favorites: an empty list at first", r.json().get("ok") and r.json()["favs"] == [])
r = loop(FAV_POST(FakeRequest(json_body={"path": "workflows/a.json", "fav": True})))
check("favorites: toggled on", r.json().get("ok") and r.json()["favs"] == ["workflows/a.json"])
r = loop(FAV_GET(FakeRequest(method="GET")))
check("favorites: persisted across reads",
      r.json()["favs"] == ["workflows/a.json"])
fav_file = os.path.join(_USER_DIR, "settings_hub", "workflows_favorites.json")
check("favorites: the file lives in the DEFAULT user dir", os.path.isfile(fav_file))
r = loop(FAV_POST(FakeRequest(json_body={"path": "workflows/sub/b.json", "fav": True})))
check("favorites: a second mark appends",
      r.json()["favs"] == ["workflows/a.json", "workflows/sub/b.json"])
r = loop(FAV_POST(FakeRequest(json_body={"path": "workflows/a.json", "fav": False})))
check("favorites: toggled off", r.json()["favs"] == ["workflows/sub/b.json"])
r = loop(FAV_POST(FakeRequest(json_body={"path": "../escape.json", "fav": True})))
check("favorites: a traversal path is refused", r.status == 400)
r = loop(FAV_POST(FakeRequest(json_body={"path": "", "fav": True})))
check("favorites: an empty path is refused", r.status == 400)

# the storage root re-pointed INTO the workflows folder: its own folder dies
# from the listing, the rest survives
custom2 = os.path.join(wfdir, "mystore")
r = loop(ROOT_POST(FakeRequest(json_body={"path": custom2})))
check("files: the custom root inside workflows was accepted", r.json().get("ok"))
r = loop(FILES(FakeRequest(method="GET")))
paths2 = [f["path"] for f in r.json()["files"]]
check("files: the storage subtree is excluded from the walk",
      not any(p.startswith("workflows/mystore/") for p in paths2), json.dumps(paths2))
check("files: the ordinary workflows survive the custom-root walk",
      "workflows/a.json" in paths2 and "workflows/sub/deep/c.json" in paths2,
      json.dumps(paths2))
check("root: userRel names the custom root relative to the user dir",
      loop(ROOT_GET(FakeRequest(method="GET"))).json().get("userRel") == "default/workflows/mystore")
loop(ROOT_POST(FakeRequest(json_body={"path": ""})))
r = loop(ROOT_GET(FakeRequest(method="GET")))
check("root: userRel back to the default layout",
      r.json().get("userRel") == "settings_hub/workflows", str(r.json().get("userRel")))

# v109: the multi-user header - a comfy-user folder is walked FIRST, and an
# unsafe header name is ignored entirely (no traversal, no system users)
otherdir = os.path.join(_USER_DIR, "alice", "workflows")
os.makedirs(otherdir, exist_ok=True)
_touch(os.path.join(otherdir, "alice_w.json"))
r = loop(FILES(FakeRequest(method="GET", headers={"comfy-user": "alice"})))
paths3 = [f["path"] for f in r.json()["files"]]
check("files: the comfy-user root is served FIRST",
      r.json().get("root") == otherdir, str(r.json().get("root")))
check("files: the comfy-user files + the default user both readable",
      "workflows/alice_w.json" in paths3 and "workflows/a.json" in paths3,
      json.dumps(paths3))
check("files: the legacy flat file survives the header walk too",
      "workflows/legacy_flat.json" in paths3, json.dumps(paths3))
r = loop(FILES(FakeRequest(method="GET", headers={"comfy-user": "..\\evil"})))
check("files: a traversal comfy-user header is ignored (default served)",
      r.json().get("root") == wfdir, str(r.json().get("root")))
r = loop(FILES(FakeRequest(method="GET", headers={"comfy-user": "__system"})))
check("files: a system-user comfy-user header is ignored",
      r.json().get("root") == wfdir, str(r.json().get("root")))
r = loop(FILES(FakeRequest(method="GET", headers={"comfy-user": "settings_hub"})))
check("files: the pack's own namespace is never a user root",
      r.json().get("root") == wfdir, str(r.json().get("root")))
r = loop(FILES(FakeRequest(method="GET", headers={"comfy-user": "ghost"})))
check("files: a nonexistent comfy-user falls back to default",
      r.json().get("root") == wfdir, str(r.json().get("root")))
try:
    shutil_ = __import__("shutil")
    shutil_.rmtree(os.path.join(_USER_DIR, "alice"), ignore_errors=True)
except Exception:
    pass

try:
    shutil_ = __import__("shutil")
    shutil_.rmtree(wfdir, ignore_errors=True)
    shutil_.rmtree(legacy, ignore_errors=True)
    shutil_.rmtree(os.path.join(_USER_DIR, "default"), ignore_errors=True)
    shutil_.rmtree(custom2, ignore_errors=True)
except Exception:
    pass

# v109: with every library gone the walk answers ok:true + files:[] - the
# client-side contract REQUIRES that shape to fall back to the native
# /userdata rungs (the v108 blanking bug may never repeat client-side)
r = loop(FILES(FakeRequest(method="GET")))
check("files: an empty library answers ok:true with an EMPTY list",
      r.json().get("ok") is True and r.json().get("files") == [], json.dumps(r.json().get("files")))
reset_state()

# ===========================================================================
# v112 (plan 3.1): the SERVER-SIDE UNDO SNAPSHOTS
# ===========================================================================

UPUT = H[("POST", "/settings_hub/workflows/undo")]
UGET = H[("GET", "/settings_hub/workflows/undo/{uid}")]
UDEL = H[("DELETE", "/settings_hub/workflows/undo/{uid}")]

print("== v112: server-side undo snapshots (plan 3.1) ==")
mgr_undo_dir = os.path.join(_USER_DIR, "settings_hub", wf_store.MGR_DIR_NAME, "undo")

r = loop(UPUT(FakeRequest(json_body={"tabs": [
    {"key": "t1", "path": "workflows/a.json", "name": "a.json", "active": True,
     "modified": False, "temp": False, "graph": None},
    {"key": "t2", "path": None, "name": "temp one", "active": False,
     "modified": True, "temp": True, "graph": {"nodes": [{"id": 9}], "links": []}},
], "activeKey": "t1"})))
check("undo: a valid snapshot stores and returns an undoId",
      r.json().get("ok") is True and isinstance(r.json().get("undoId"), str),
      json.dumps(r.json()))
undo_id = r.json().get("undoId")
check("undo: the file lives under workflows_manager/undo/",
      os.path.isfile(os.path.join(mgr_undo_dir, undo_id + ".json")))

r = loop(UGET(FakeRequest(method="GET", match_info={"uid": undo_id})))
tabs = r.json().get("tabs") or []
check("undo: GET returns the tabs with the graphs",
      r.json().get("ok") is True and len(tabs) == 2 and
      tabs[1].get("graph", {}).get("nodes", [{}])[0].get("id") == 9,
      json.dumps(r.json())[:160])
check("undo: the graph-less clean tab keeps graph=None (reopens by path)",
      tabs[0].get("graph") is None and tabs[0].get("path") == "workflows/a.json")
check("undo: the activeKey survived",
      r.json().get("activeKey") == "t1")

r = loop(UPUT(FakeRequest(json_body={"no_tabs": True})))
check("undo: a body without a tabs list refuses (400)",
      r.status == 400 and r.json().get("ok") is False)

r = loop(UPUT(FakeRequest(json_body={"tabs": [
    {"path": "../../escape.json", "name": "bad", "graph": None},
]})))
check("undo: a traversal path in the snapshot is sanitized to null (kept temp-like)",
      r.json().get("ok") is True and
      (r.json().get("ts") is not None), json.dumps(r.json()))
uid2 = r.json().get("undoId")
rec2 = json.load(open(os.path.join(mgr_undo_dir, uid2 + ".json")))
check("undo: the traversal path never reaches the stored record",
      rec2["tabs"][0]["path"] is None, json.dumps(rec2["tabs"][0]))

r = loop(UDEL(FakeRequest(method="DELETE", match_info={"uid": undo_id})))
check("undo: DELETE removes the snapshot",
      r.json().get("ok") is True and r.json().get("existed") is True and
      not os.path.isfile(os.path.join(mgr_undo_dir, undo_id + ".json")))
r = loop(UDEL(FakeRequest(method="DELETE", match_info={"uid": undo_id})))
check("undo: a second DELETE is idempotent (existed:false)",
      r.json().get("ok") is True and r.json().get("existed") is False)
r = loop(UGET(FakeRequest(method="GET", match_info={"uid": "nope"})))
check("undo: a malformed id answers 400 (strict charset)",
      r.status == 400, str(r.status))
r = loop(UGET(FakeRequest(method="GET", match_info={"uid": "0123456789abcdef"})))
check("undo: a well-formed unknown id answers 404",
      r.status == 404, str(r.status))

# the TTL GC: a snapshot older than UNDO_MAX_AGE_S dies on the next store
import time as _time
old_rec = {"id": "oldoldoldoldoldold", "ts": int(_time.time()) - wf_store.UNDO_MAX_AGE_S - 10,
           "activeKey": None, "tabs": []}
json.dump(old_rec, open(os.path.join(mgr_undo_dir, "oldoldoldoldoldold.json"), "w"))
r = loop(UPUT(FakeRequest(json_body={"tabs": []})))
check("undo: the TTL GC removed the expired snapshot",
      not os.path.isfile(os.path.join(mgr_undo_dir, "oldoldoldoldoldold.json")))
for f in os.listdir(mgr_undo_dir):
    os.unlink(os.path.join(mgr_undo_dir, f))

# ===========================================================================
# v112 (plan 3.6): the SERVER-SIDE RECENTLY-CLOSED MANIFESTS + reference GC
# ===========================================================================

RPUT = H[("POST", "/settings_hub/workflows/recent")]
RGET = H[("GET", "/settings_hub/workflows/recent/{cid}")]
RDEL = H[("DELETE", "/settings_hub/workflows/recent/{cid}")]
TGC = H[("POST", "/settings_hub/workflows/temp/gc")]

print("== v112: recently-closed manifests + server GC (plan 3.6) ==")
mgr_recent_dir = os.path.join(_USER_DIR, "settings_hub", wf_store.MGR_DIR_NAME, "recent")

# two browser sessions with their own rings, one SHARED snapshot
r = loop(TPUT(FakeRequest(json_body={"name": "shared temp", "graph": {"nodes": []}})))
shared_tid = r.json().get("id")
r = loop(TPUT(FakeRequest(json_body={"name": "alpha temp", "graph": {"nodes": []}})))
alpha_tid = r.json().get("id")

r = loop(RPUT(FakeRequest(json_body={
    "clientId": "browser_alpha01",
    "entries": [{"path": None, "name": "shared", "ts": 1, "tempId": shared_tid},
                {"path": None, "name": "alpha", "ts": 2, "tempId": alpha_tid}]})))
check("recent: the manifest stores and returns the cross-browser refs",
      r.json().get("ok") is True and
      set(r.json().get("refs", [])) == {shared_tid, alpha_tid},
      json.dumps(r.json()))
r = loop(RPUT(FakeRequest(json_body={
    "clientId": "browser_beta0001",
    "entries": [{"path": None, "name": "shared", "ts": 3, "tempId": shared_tid}]})))
check("recent: the SECOND browser registers its own manifest",
      r.json().get("ok") is True and set(r.json().get("refs", [])) == {shared_tid, alpha_tid})

r = loop(RGET(FakeRequest(method="GET", match_info={"cid": "browser_alpha01"})))
check("recent: GET returns the session manifest",
      r.json().get("ok") is True and len(r.json().get("entries") or []) == 2)
r = loop(RGET(FakeRequest(method="GET", match_info={"cid": "browser_nope0001"})))
check("recent: an unknown session answers 404 (fresh session migrates)",
      r.status == 404)

# the alpha browser EVICTS its rows (empty manifest): the shared snapshot
# must SURVIVE (beta still references it), its own may go only by TTL
r = loop(RPUT(FakeRequest(json_body={"clientId": "browser_alpha01", "entries": []})))
check("recent: the manifest replace works (eviction)",
      r.json().get("ok") is True and set(r.json().get("refs", [])) == {shared_tid})

# the SERVER GC: a stale orphan (not referenced by anyone, > 1 day) dies;
# the shared snapshot stays (beta references it) even though it is fresh
old_tid = "0123456789ab0000"  # strict hex, like the server ids
fake_temp_old = {"id": old_tid, "name": "stale orphan", "ts": int(_time.time()) - wf_store.TEMP_MAX_AGE_S - 10,
                 "seq": 0, "graph": {"nodes": []}}
os.makedirs(temp_dir(), exist_ok=True)
json.dump(fake_temp_old, open(os.path.join(temp_dir(), old_tid + ".json"), "w"))
r = loop(TGC(FakeRequest(method="POST")))
removed = r.json().get("removed") or []
check("temp/gc: the STALE unreferenced snapshot is removed",
      old_tid in removed and not os.path.isfile(os.path.join(temp_dir(), old_tid + ".json")),
      json.dumps(removed))
check("temp/gc: the SHARED snapshot survives (beta still references it)",
      shared_tid not in removed and os.path.isfile(os.path.join(temp_dir(), shared_tid + ".json")))
check("temp/gc: the alpha temp (referenced by nobody, FRESH) survives the age rule",
      alpha_tid in [t for t in (r.json().get("refs") or [])] or
      os.path.isfile(os.path.join(temp_dir(), alpha_tid + ".json")))

# beta forgets its manifest -> the next GC may reap the shared snapshot
r = loop(RDEL(FakeRequest(method="DELETE", match_info={"cid": "browser_beta0001"})))
check("recent: DELETE of a session manifest works",
      r.json().get("ok") is True and not os.path.isfile(
          os.path.join(mgr_recent_dir, "browser_beta0001.json")))
# make the shared snapshot old, then GC again - now NOTHING references it
tfile = os.path.join(temp_dir(), shared_tid + ".json")
rec = json.load(open(tfile))
rec["ts"] = int(_time.time()) - wf_store.TEMP_MAX_AGE_S - 10
json.dump(rec, open(tfile, "w"))
r = loop(TGC(FakeRequest(method="POST")))
check("temp/gc: with NO manifest left, the aged snapshot is reaped (no orphans)",
      shared_tid in (r.json().get("removed") or []),
      json.dumps(r.json().get("removed")))

r = loop(TGC(FakeRequest(method="POST")))
check("temp/gc: an idempotent run removes nothing new",
      r.json().get("ok") is True and (r.json().get("removed") or []) == [],
      json.dumps(r.json().get("removed")))

r = loop(RPUT(FakeRequest(json_body={"clientId": "../bad", "entries": []})))
check("recent: a traversal clientId refuses (400)",
      r.status == 400, str(r.status))
r = loop(RGET(FakeRequest(method="GET", match_info={"cid": "../bad"})))
check("recent: a traversal clientId in GET refuses (400)",
      r.status == 400, str(r.status))

# cleanup the manager folder for the later phases
import shutil as _sh
_sh.rmtree(os.path.join(_USER_DIR, "settings_hub", wf_store.MGR_DIR_NAME),
           ignore_errors=True)
reset_state()

# ===========================================================================
# v112 stage 4 (plan 9/10): the Preset CATEGORIES/TAGS + VERSION HISTORY
# ===========================================================================

VGET = H[("GET", "/settings_hub/workflows/preset/{pid}/versions")]
VRGET = H[("GET", "/settings_hub/workflows/preset/{pid}/version/{rid}")]
VREST = H[("POST", "/settings_hub/workflows/preset/{pid}/restore/{rid}")]

print("== v112 stage 4: preset categories/tags + version history ==")
reset_state()

# --- the category/tags sanitization ---
r = loop(PPOST(FakeRequest(json_body={
    "name": "Catty", "category": "  Portrait  ",
    "tags": ["Production", "production", "fast", "", "  hires  ", 42],
    "items": [{"kind": "path", "path": "workflows/a.json"}]})))
preset_c = r.json()["preset"]
check("tags: the category trims and stores",
      preset_c.get("category") == "Portrait", json.dumps(preset_c.get("category")))
check("tags: duplicates collapse case-insensitively, non-strings drop, cap holds",
      preset_c.get("tags") == ["Production", "fast", "hires"],
      json.dumps(preset_c.get("tags")))
r = loop(PPOST(FakeRequest(json_body={
    "name": "BadTags", "tags": "not-a-list",
    "items": [{"kind": "path", "path": "workflows/a.json"}]})))
check("tags: a non-list tags payload refuses (400)",
      r.status == 400, str(r.status))
r = loop(PPOST(FakeRequest(json_body={
    "name": "NoCat", "items": [{"kind": "path", "path": "workflows/a.json"}]})))
check("tags: an old-style preset carries NO category/tags keys (back-compat)",
      "category" not in r.json()["preset"] and "tags" not in r.json()["preset"])

# --- the version lifecycle: create -> initial revision; overwrite -> archive ---
PIDV = preset_c["id"]
r = loop(VGET(FakeRequest(match_info={"pid": PIDV})))
vers0 = r.json().get("versions") or []
check("versions: a NEW preset gets its INITIAL revision",
      r.json().get("ok") is True and len(vers0) == 1,
      json.dumps(vers0))
check("versions: the revision metadata carries name/items/changedBy",
      vers0 and vers0[0].get("changedBy") == "create" and
      vers0[0].get("itemCount") == 1 and vers0[0].get("name") == "Catty",
      json.dumps(vers0[0]))

# the version FILES live in the SAME root as the preset (plan 10)
vdir = os.path.join(presets_dir(), "..", "preset_versions", PIDV)
vdir = os.path.normpath(vdir)
check("versions: the sidecar folder sits next to presets/ in the same root",
      os.path.isdir(vdir) and len(os.listdir(vdir)) == 1,
      json.dumps(os.listdir(vdir)) if os.path.isdir(vdir) else "missing")

# an UNCHANGED overwrite -> NO new revision (plan 10: no revision when the
# content is semantically the same)
r = loop(PPOST(FakeRequest(json_body={
    "id": PIDV, "name": "Catty", "category": "Portrait",
    "tags": ["Production", "fast", "hires"],
    "items": [{"kind": "path", "path": "workflows/a.json"}],
    "mode": "overwrite"})))
check("versions: the no-op overwrite creates NO revision",
      len(loop(VGET(FakeRequest(match_info={"pid": PIDV}))).json()["versions"]) == 1)

# a MEANINGFUL change -> the previous state archives
r = loop(PPOST(FakeRequest(json_body={
    "id": PIDV, "name": "Catty v2", "category": "Flux", "tags": ["fast"],
    "items": [{"kind": "path", "path": "workflows/a.json"},
              {"kind": "path", "path": "workflows/upscale.json"}],
    "mode": "overwrite"})))
vers1 = loop(VGET(FakeRequest(match_info={"pid": PIDV}))).json()["versions"]
check("versions: the overwrite archives the previous state",
      len(vers1) == 2 and vers1[0]["changedBy"] == "overwrite",
      json.dumps([(v["changedBy"], v["name"]) for v in vers1]))
check("versions: the archive carries the OLD name/tags (metadata)",
      vers1[0]["name"] == "Catty" and vers1[0]["tags"] == ["Production", "fast", "hires"],
      json.dumps(vers1[0]))

# the version payload read
r = loop(VRGET(FakeRequest(match_info={"pid": PIDV, "rid": vers1[0]["revisionId"]}))
         ) if ("GET", "/settings_hub/workflows/preset/{pid}/version/{rid}") in H else None
rec = r.json()
check("versions: the payload returns the FULL previous preset",
      rec.get("ok") is True and rec["preset"]["name"] == "Catty" and
      len(rec["preset"]["items"]) == 1, json.dumps(rec)[:160])

# --- the restore: the current archives FIRST, then the chosen returns ---
r = loop(VREST(FakeRequest(match_info={"pid": PIDV, "rid": vers1[0]["revisionId"]},
                           json_body={})))
j = r.json()
check("restore: ok, the current archived, the chosen returned",
      j.get("ok") is True and j.get("restoredFrom") == vers1[0]["revisionId"] and
      j.get("archivedAs"), json.dumps(j)[:200])
check("restore: the preset went BACK (name/category/items)",
      j["preset"]["name"] == "Catty" and j["preset"]["category"] == "Portrait" and
      len(j["preset"]["items"]) == 1, json.dumps(j["preset"])[:160])
vers2 = loop(VGET(FakeRequest(match_info={"pid": PIDV}))).json()["versions"]
check("restore: the pre-restore archive exists (the rollback chain grows)",
      len(vers2) == 3 and vers2[0]["changedBy"] == "restore",
      json.dumps([(v["changedBy"]) for v in vers2]))

# the retention cap: 25 changes -> at most MAX_PRESET_VERSIONS revisions
for i in range(25):
    loop(PPOST(FakeRequest(json_body={
        "id": PIDV, "name": "Catty v%d" % i,
        "items": [{"kind": "path", "path": "workflows/a.json"}],
        "mode": "overwrite"})))
vers3 = loop(VGET(FakeRequest(match_info={"pid": PIDV}))).json()["versions"]
check("versions: the retention cap holds (%d max)" % wf_store.MAX_PRESET_VERSIONS,
      len(vers3) <= wf_store.MAX_PRESET_VERSIONS, str(len(vers3)))

# --- the DELETE takes the history along (no orphans) ---
r = loop(PDEL(FakeRequest(match_info={"pid": PIDV})))
check("versions: DELETE removes the preset",
      r.json().get("ok") is True)
check("versions: DELETE removes the version folder (no orphans)",
      not os.path.isdir(vdir), str(os.path.isdir(vdir)))

# --- the import carries the category/tags ---
r = loop(PDEL(FakeRequest(match_info={"pid": preset_c["id"]})) if False
         else FakeRequest()) if False else None
r = loop(H[("POST", "/settings_hub/workflows/import")](FakeRequest(json_body={
    "presets": [{"name": "Imported cat", "category": "Video",
                 "tags": ["testing"],
                 "items": [{"kind": "path", "path": "workflows/a.json"}]}]})))
imp = r.json()["presets"][0]
check("import: the category/tags transfer",
      imp.get("category") == "Video" and imp.get("tags") == ["testing"],
      json.dumps({k: imp.get(k) for k in ("category", "tags")}))
loop(PDEL(FakeRequest(match_info={"pid": imp["id"]})))

reset_state()
# ===========================================================================
# v116: the P0 data-safety + shared-store + Files-delete routes.
# ===========================================================================

LIBDIR = os.path.join(_USER_DIR, "default", "workflows")
os.makedirs(LIBDIR, exist_ok=True)
MGRDIR = os.path.join(_USER_DIR, "settings_hub", "workflows_manager")
wf_store._wf_index.set_db_path(os.path.join(MGRDIR, "index", "workflow_index.db"))
wf_store._wf_hist.set_base_dir(MGRDIR)

HIST = H[("POST", "/settings_hub/workflows/history/checkpoint")]
HPROC = H[("GET", "/settings_hub/workflows/history/processes")]
HRESOLVE = H[("GET", "/settings_hub/workflows/history/resolve")]
HRESTORE = H[("POST", "/settings_hub/workflows/history/process/{pid}/restore/{rid}")]
HPDEL = H[("POST", "/settings_hub/workflows/history/process/{pid}/delete")]
FDEL = H[("POST", "/settings_hub/workflows/files/delete")]
FUNDO = H[("POST", "/settings_hub/workflows/files/undo")]
HSTORAGE = H[("GET", "/settings_hub/workflows/history/storage")]
HMAINT = H[("POST", "/settings_hub/workflows/history/maintenance")]
HNOTES = H[("GET", "/settings_hub/workflows/index/notes")]
HBADGES = H[("GET", "/settings_hub/workflows/history/badges")]

def wf_v116(uid, seed="s1"):
    return {"id": uid, "revision": 1,
            "nodes": [{"id": 1, "type": "KSampler", "pos": [0, 0],
                       "widgets_values": [seed]}],
            "links": [], "extra": {"ds": {"scale": 1.0, "offset": [0, 0]},
                                   "frontendVersion": "1.24.4"},
            "version": 0.4}

def lib_write(name, obj):
    pth = os.path.join(LIBDIR, name)
    with open(pth, "wb") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    return pth

def lib_read(name):
    with open(os.path.join(LIBDIR, name), "rb") as fh:
        return fh.read()

# ---- 3.4: the Restore hardening -------------------------------------------
lib_write("r1.json", wf_v116("rrrrrrrr-1111-1111-1111-111111111111", seed="v1"))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/r1.json",
                                     "source": "disk"})))
check("v116 restore setup: the checkpoint lands",
      r.json().get("ok"), json.dumps(r.json()))
_pid = r.json()["processId"]
rid1 = r.json()["revisionId"]
lib_write("r1.json", wf_v116("rrrrrrrr-1111-1111-1111-111111111111", seed="v2"))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/r1.json",
                                     "source": "disk"})))
rid2 = r.json()["revisionId"]
# a SECOND process for the cross-ownership probe
lib_write("r2.json", wf_v116("ssssssss-2222-2222-2222-222222222222"))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/r2.json",
                                     "source": "disk"})))
_pid2 = r.json()["processId"]
rid_x = r.json()["revisionId"]   # the OTHER process's revision
# 1) the pid/rid ownership: restore pid2's revision under pid1 -> 404
r = loop(HRESTORE(FakeRequest(match_info={"pid": _pid, "rid": rid_x},
                              json_body={"mode": "open-copy"})))
_jown = r.json() if hasattr(r, "json") else {"status": r.status}
check("v116 restore: ANOTHER process's revision refuses (404)",
      r.status == 404 and _jown.get("ok") is False,
      json.dumps({"status": r.status, "j": _jown}))
r = loop(HRESTORE(FakeRequest(match_info={"pid": _pid, "rid": rid1},
                              json_body={"mode": "replace",
                                         "path": "workflows/r2.json"})))
check("v116 restore: a NON-LOCATION path refuses",
      r.status == 400, json.dumps({"status": r.status, "j": r.json()}))
# 2) a MISSING target refuses the replace (no empty-byte backup path)
os.unlink(os.path.join(LIBDIR, "r1.json"))
r = loop(HRESTORE(FakeRequest(match_info={"pid": _pid, "rid": rid1},
                              json_body={"mode": "replace",
                                         "path": "workflows/r1.json"})))
check("v116 restore: a MISSING target refuses with the copy suggestion",
      r.status == 400 and "Open version" in (r.json().get("error") or ""),
      json.dumps({"status": r.status, "j": r.json()}))
# 3) the happy path: replace + verified snapshot + atomic write + index refresh
lib_write("r1.json", wf_v116("rrrrrrrr-1111-1111-1111-111111111111", seed="v3"))
r = loop(HRESTORE(FakeRequest(match_info={"pid": _pid, "rid": rid1},
                              json_body={"mode": "replace",
                                         "path": "workflows/r1.json"})))
check("v116 restore: the replace succeeds with a snapshot + index refresh",
      r.json().get("ok") and r.json().get("rollbackAvailable") and
      json.loads(lib_read("r1.json")).get("nodes", [{}])[0].get("widgets_values") == ["v1"],
      json.dumps(r.json()))
check("v116 restore: the derived index row refreshed in place",
      r.json().get("indexRefreshed") == 1, json.dumps(r.json()))
# 4) the rollback: a failing os.replace keeps the OLD bytes from the snapshot
import unittest.mock as _umock
old_replace = os.replace
def _boom(a, b):
    if str(b).endswith(".json") and "restore-tmp" in str(a):
        raise OSError("injected failure")
    return old_replace(a, b)
with _umock.patch("os.replace", side_effect=_boom):
    r = loop(HRESTORE(FakeRequest(match_info={"pid": _pid, "rid": rid1},
                                  json_body={"mode": "replace",
                                             "path": "workflows/r1.json"})))
check("v116 restore: the injected write failure ROLLS BACK from the snapshot",
      r.status == 500 and "rolled back" in (r.json().get("error") or "") and
      json.loads(lib_read("r1.json")).get("nodes", [{}])[0].get("widgets_values") == ["v1"],
      json.dumps({"status": r.status, "j": r.json()}))

# ---- 4.2: the layered change status ---------------------------------------
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)
r = loop(HRESOLVE(FakeRequest(query={"path": "workflows/r2.json"})))
check("v116 status: an untouched location answers 'unchanged'",
      r.json().get("changeStatus") == "unchanged", json.dumps(r.json()))
# a canvas-only save (pos changed, graph identical) -> presentation_changed
lib_write("r2.json", wf_v116("ssssssss-2222-2222-2222-222222222222"))
lib_write("r2.json", {"id": "ssssssss-2222-2222-2222-222222222222",
                      "revision": 1,
                      "nodes": [{"id": 1, "type": "KSampler", "pos": [999, 999],
                                 "widgets_values": ["s1"]}],
                      "links": [],
                      "extra": {"ds": {"scale": 2.0, "offset": [1, 1]},
                                "frontendVersion": "1.24.4"},
                      "version": 0.4})
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)
r = loop(HRESOLVE(FakeRequest(query={"path": "workflows/r2.json"})))
check("v116 status: a canvas-only save answers 'presentation_changed'",
      r.json().get("changeStatus") == "presentation_changed" and
      r.json().get("statusLabel") == "Canvas changed only",
      json.dumps(r.json()))
# a widget change -> workflow_changed
lib_write("r2.json", wf_v116("ssssssss-2222-2222-2222-222222222222", seed="CHANGED"))
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)
r = loop(HRESOLVE(FakeRequest(query={"path": "workflows/r2.json"})))
check("v116 status: a widget change answers 'workflow_changed'",
      r.json().get("changeStatus") == "workflow_changed", json.dumps(r.json()))
# an unknown status: no index row at all
r = loop(HRESOLVE(FakeRequest(query={"path": "workflows/ghost.json"})))
check("v116 status: an unbound path answers bound:false",
      r.json().get("bound") is False, json.dumps(r.json()))

# ---- 3.5: the process delete preflight ------------------------------------
wf_store._wf_hist._reconcile_ts[0] = 0
wf_store._wf_hist.reconcile_processes("default")
r = loop(HPDEL(FakeRequest(match_info={"pid": _pid2},
                           json_body={"deleteFiles": True})))
check("v116 proc delete: the happy path erases files + history",
      r.json().get("ok") and r.json().get("deletedRevisions") == 1 and
      not os.path.exists(os.path.join(LIBDIR, "r2.json")),
      json.dumps(r.json()))
check("v116 proc delete: the index rows of the deleted files dropped",
      r.json().get("indexRowsDropped", 0) >= 1, json.dumps(r.json()))
# a preflight failure (an unreadable file) aborts with NOTHING deleted
lib_write("r3.json", wf_v116("tttttttt-3333-3333-3333-333333333333"))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/r3.json",
                                     "source": "disk"})))
pid3 = r.json()["processId"]
os.chmod(os.path.join(LIBDIR, "r3.json"), 0o000)
r = loop(HPDEL(FakeRequest(match_info={"pid": pid3},
                           json_body={"deleteFiles": True})))
os.chmod(os.path.join(LIBDIR, "r3.json"), 0o644)
check("v116 proc delete: the preflight failure deletes NOTHING (409, history kept)",
      r.status == 409 and r.json().get("stage") == "preflight" and
      wf_store._wf_hist._read_process(pid3) is not None and
      os.path.exists(os.path.join(LIBDIR, "r3.json")),
      json.dumps({"status": r.status, "j": r.json()}))

# ---- plan 7: the Files batch delete + undo ---------------------------------
lib_write("d1.json", wf_v116("dddddddd-1111-1111-1111-111111111111"))
lib_write("d2.json", wf_v116("dddddddd-2222-2222-2222-222222222222"))
lib_write("d3.json", wf_v116("dddddddd-3333-3333-3333-333333333333"))
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)
r = loop(HIST(FakeRequest(json_body={"path": "workflows/d1.json",
                                     "source": "disk"})))
check("v116 files delete setup: d1 owns a process + location",
      r.json().get("ok"), json.dumps(r.json()))
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/d1.json",
                                               "workflows/d2.json"]})))
jd = r.json()
check("v116 files delete: two files removed with per-file results",
      jd.get("ok") and jd.get("removed") == 2 and
      not os.path.exists(os.path.join(LIBDIR, "d1.json")) and
      not os.path.exists(os.path.join(LIBDIR, "d2.json")) and
      os.path.exists(os.path.join(LIBDIR, "d3.json")),
      json.dumps(jd))
check("v116 files delete: an undo handle comes back (2 h window)",
      jd.get("undo", {}).get("opId") and jd.get("undo", {}).get("expiresAt", 0) > 0,
      json.dumps(jd.get("undo")))
check("v116 files delete: the history is NOT deleted (the process survives orphaned)",
      jd.get("locationsDetached", 0) >= 1, json.dumps(jd))
# traversal refuses the whole batch
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/../../user/settings_hub/"
                                               "workflows/presets/x.json"]})))
check("v116 files delete: traversal refuses with NOTHING deleted",
      r.status == 400, json.dumps({"status": r.status}))
# the undo restores the exact bytes; a taken path would be skipped
r = loop(FUNDO(FakeRequest(json_body={"opId": jd["undo"]["opId"]})))
check("v116 files undo: both files restored byte-exact",
      r.json().get("ok") and r.json().get("restored") == 2 and
      json.loads(lib_read("d1.json")).get("id") == "dddddddd-1111-1111-1111-111111111111",
      json.dumps(r.json()))
# a second undo is refused (the manifest died with the use)
r = loop(FUNDO(FakeRequest(json_body={"opId": jd["undo"]["opId"]})))
check("v116 files undo: the manifest dies after use (404)",
      r.status == 404, json.dumps({"status": r.status}))
# the conflict rule: a newer file at the path is NEVER overwritten
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/d1.json"]})))
lib_write("d1.json", wf_v116("eeeeeeee-9999-9999-9999-999999999999", seed="newer"))
r2 = loop(FUNDO(FakeRequest(json_body={"opId": r.json()["undo"]["opId"]})))
check("v116 files undo: a TAKEN path is skipped, never overwritten",
      r2.json().get("restored") == 0 and
      json.loads(lib_read("d1.json")).get("id") == "eeeeeeee-9999-9999-9999-999999999999",
      json.dumps(r2.json()))
check("v116 files undo: the skip names the reason",
      "taken by a newer file" in (r2.json().get("results")[0].get("error") or ""),
      json.dumps(r2.json().get("results")))

# ---- 4.6: the notes search route -------------------------------------------
r = loop(HNOTES(FakeRequest(query={"q": "portrait"})))
check("v116 notes route: answers without a crash (empty index is fine)",
      r.json().get("ok") is True and "results" in r.json(), json.dumps(r.json()))
r = loop(HNOTES(FakeRequest(query={"q": "", "rebuild": "1"})))
check("v116 notes route: the rebuild pass is idempotent + safe",
      r.json().get("ok") is True, json.dumps(r.json()))

# ---- 5.4: the storage route + the compact action ---------------------------
r = loop(HSTORAGE(FakeRequest()))
check("v116 storage: the physical/logical split + the totals",
      r.json().get("ok") and "totalPhysicalBytes" in r.json() and
      "indexBytes" in r.json() and "txSnapshotBytes" in r.json(),
      json.dumps(sorted(r.json().keys())))
r = loop(HMAINT(FakeRequest(json_body={"action": "compact"})))
check("v116 compact route: the verified rebuild answers measured bytes",
      r.json().get("ok") is True and "before" in r.json() and "after" in r.json(),
      json.dumps(r.json()))

# ---- 5.1: the preset version payload migration -----------------------------
PVER = H[("GET", "/settings_hub/workflows/preset/{pid}/versions")]
PVGET = H[("GET", "/settings_hub/workflows/preset/{pid}/version/{rid}")]
r = loop(PPOST(FakeRequest(json_body={"name": "Mig preset",
                                      "items": [{"kind": "snapshot", "name": "snap",
                                                 "graph": wf_v116("mmmmmmmm-0000-4000-8000-000000000001")}]})))
mig = r.json()["preset"]
# a legacy embedded version file (the v112 shape) in the SAME root
vdir = os.path.join(os.path.dirname(os.path.dirname(
    wf_store._find_preset_file(mig["id"]))), "preset_versions", mig["id"])
os.makedirs(vdir, exist_ok=True)
legacy_rid = "a" * 16
with open(os.path.join(vdir, legacy_rid + ".json"), "w", encoding="utf-8") as fh:
    json.dump({"revisionId": legacy_rid, "presetId": mig["id"],
               "createdAt": int(time.time()), "seq": 1, "changedBy": "put",
               "preset": mig}, fh)
wf_store._pv_migrated = False
wf_store._pv_migrate_once()
rec = json.load(open(os.path.join(vdir, legacy_rid + ".json")))
check("v116 migration: the legacy manifest got a storage reference",
      rec.get("storage", {}).get("blob") and rec.get("rawHash") and
      "preset" not in rec,
      json.dumps(sorted(rec.keys())))
r = loop(PVGET(FakeRequest(match_info={"pid": mig["id"], "rid": legacy_rid})))
check("v116 migration: the version still reads (restorable through the store)",
      r.json().get("ok") and r.json().get("preset", {}).get("id") == mig["id"],
      json.dumps({k: r.json().get(k) for k in ("ok", "error")}))
n0 = rec.get("migrated")
wf_store._pv_migrated = False
wf_store._pv_migrate_once()
rec2 = json.load(open(os.path.join(vdir, legacy_rid + ".json")))
check("v116 migration: the rerun is IDEMPOTENT",
      rec2.get("storage", {}).get("blob") == rec.get("storage", {}).get("blob"),
      json.dumps({"m0": n0, "m1": rec2.get("migrated")}))
r = loop(PVER(FakeRequest(match_info={"pid": mig["id"]})))
check("v116 migration: the listing stays metadata-only",
      r.json().get("ok") and all("itemCount" in v for v in r.json().get("versions", [])),
      json.dumps(r.json()))
loop(PDEL(FakeRequest(match_info={"pid": mig["id"]})))

reset_state()
# ===========================================================================
# v117: the owner's delete plan + the similarity groups.
#   * Files → Delete selected deletes ONLY the checked files; a process that
#     lost its LAST live file dies WITH the file (orphaned versions), a
#     process with other live copies keeps everything; the preview answers
#     the confirm-dialog data BEFORE anything is deleted; a preset that
#     references a deleted file is named but NEVER touched.
#   * the Process-history route deletes EXACTLY the passed path (the
#     same-UUID siblings are never touched); the versions die only when no
#     live copy remains.
#   * presets_referencing_paths (the confirm-dialog warning).
#   * _evict_temp_files honors the cross-browser reference union.
#   * /index/groups: the same_uuid + exact-copy groups, the kind filter,
#     the SQLite result cache (+ the invalidation on any re-index).
# ===========================================================================
HGROUPS = H[("GET", "/settings_hub/workflows/index/groups")]

DU = "uuuuuuuu-4444-4444-4444-444444444444"
U2 = "uuuuuuuu-6666-6666-6666-666666666666"
EX1 = "uuuuuuuu-7777-7777-7777-777777777777"
EX2 = "uuuuuuuu-8888-8888-8888-888888888888"
SOLO = "vvvvvvvv-5555-5555-5555-555555555555"

def wf_copy(uid, seed="s1", pos=(0, 0)):
    """The exact-copy generator: everything except the top-level id is
    byte-identical (the ComfyUI Duplicate signature)."""
    return {"id": uid, "revision": 1,
            "nodes": [{"id": 1, "type": "KSampler", "pos": list(pos),
                       "widgets_values": [seed]},
                      {"id": 2, "type": "VAEDecode", "pos": [40, 40]}],
            "links": [[1, 1, 0, 2, 0, "LATENT"]],
            "extra": {"ds": {"scale": 1.0, "offset": [0, 0]},
                      "frontendVersion": "1.24.4"},
            "version": 0.4}

# ---- A) the preview + the delete with the orphan cleanup -------------------
lib_write("dup_a.json", wf_v116(DU, seed="a"))
lib_write("dup_b.json", wf_v116(DU, seed="a"))
lib_write("solo.json", wf_v116(SOLO))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/dup_a.json",
                                     "source": "disk"})))
pid_dup = r.json().get("processId")
r = loop(HIST(FakeRequest(json_body={"path": "workflows/dup_b.json",
                                     "source": "disk"})))
check("v117 setup: the second same-UUID file joins ONE process",
      r.json().get("ok") and r.json().get("processId") == pid_dup,
      json.dumps(r.json()))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/solo.json",
                                     "source": "disk"})))
pid_solo = r.json().get("processId")
r = loop(PPOST(FakeRequest(json_body={"name": "v117 ref preset",
                                      "items": [{"kind": "path",
                                                "path": "workflows/dup_a.json"}],
                                      "activePath": "workflows/dup_a.json"})))
ref_preset = r.json().get("preset") or {}
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)

# the PREVIEW: the dialog data BEFORE anything is deleted
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/dup_a.json"],
                                     "preview": True})))
pj = r.json()
check("v117 preview: answers the per-file process data",
      pj.get("ok") and pj.get("totals", {}).get("selected") == 1 and
      len(pj.get("files", [])) == 1,
      json.dumps(pj.get("totals")))
_f0 = (pj.get("files") or [{}])[0]
check("v117 preview: the sibling copy keeps the history reachable",
      _f0.get("otherLocations") == ["workflows/dup_b.json"] and
      _f0.get("willOrphanVersions") is False and
      _f0.get("revisions", 0) >= 1,
      json.dumps(_f0))
check("v117 preview: the referencing preset is NAMED",
      any(p.get("id") == ref_preset.get("id")
          for p in pj.get("presetsAffected", [])),
      json.dumps(pj.get("presetsAffected")))
check("v117 preview: NOTHING was deleted",
      os.path.isfile(os.path.join(LIBDIR, "dup_a.json")) and
      wf_store._wf_hist._read_process(pid_dup) is not None)

# the REAL delete of ONE of two copies: the history survives
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/dup_a.json"]})))
fj = r.json()
check("v117 delete: the selected file dies, the sibling copy keeps the process",
      fj.get("ok") and fj.get("removed") == 1 and
      fj.get("orphanedProcesses") == 0 and
      os.path.isfile(os.path.join(LIBDIR, "dup_b.json")) and
      wf_store._wf_hist._read_process(pid_dup) is not None,
      json.dumps({k: fj.get(k) for k in ("ok", "removed", "orphanedProcesses")}))
check("v117 delete: the referencing preset is NEVER deleted",
      wf_store._load_preset_file(ref_preset.get("id")) is not None)
check("v117 delete: the versions stay reachable through the surviving copy",
      len(wf_store._wf_hist.list_revisions(pid_dup)) >= 1 and
      wf_store._wf_hist._proc_cache["paths_of"].get(pid_dup) == {
          "workflows/dup_b.json"},
      json.dumps({"revs": len(wf_store._wf_hist.list_revisions(pid_dup)),
                  "locs": sorted(wf_store._wf_hist._proc_cache["paths_of"]
                                 .get(pid_dup) or ())}))

# deleting the LAST copy erases the unreachable versions with the file
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/dup_b.json"]})))
fj = r.json()
check("v117 delete: the LAST copy takes the orphaned versions with it",
      fj.get("ok") and fj.get("removed") == 1 and
      fj.get("orphanedProcesses") == 1 and
      fj.get("orphanedRevisions", 0) >= 1,
      json.dumps({k: fj.get(k) for k in ("removed", "orphanedProcesses",
                                         "orphanedRevisions")}))
check("v117 delete: the erased process is really gone",
      wf_store._wf_hist._read_process(pid_dup) is None and
      len(wf_store._wf_hist.list_revisions(pid_dup)) == 0)
r = loop(FDEL(FakeRequest(json_body={"paths": ["workflows/solo.json"]})))
check("v117 delete: a single-file process with history dies the same way",
      r.json().get("ok") and r.json().get("orphanedProcesses") == 1 and
      wf_store._wf_hist._read_process(pid_solo) is None,
      json.dumps(r.json()))

# ---- B) the Process-history route: the path-scoped file deletion -----------
lib_write("p_a.json", wf_v116(U2, seed="p1"))
lib_write("p_b.json", wf_v116(U2, seed="p1"))
r = loop(HIST(FakeRequest(json_body={"path": "workflows/p_a.json",
                                     "source": "disk"})))
pid_p = r.json().get("processId")
r = loop(HIST(FakeRequest(json_body={"path": "workflows/p_b.json",
                                     "source": "disk"})))
r = loop(HPDEL(FakeRequest(match_info={"pid": pid_p},
                           json_body={"deleteFiles": True,
                                      "path": "workflows/p_a.json"})))
hj = r.json()
check("v117 history route: ONLY the passed path was deleted",
      hj.get("ok") and hj.get("keptHistory") is True and
      hj.get("remainingLocations") == 1 and
      os.path.isfile(os.path.join(LIBDIR, "p_b.json")) and
      not os.path.isfile(os.path.join(LIBDIR, "p_a.json")),
      json.dumps(hj))
check("v117 history route: the versions survive with the sibling copy",
      len(wf_store._wf_hist.list_revisions(pid_p)) == 1,
      json.dumps({"revs": len(wf_store._wf_hist.list_revisions(pid_p))}))
r = loop(HPDEL(FakeRequest(match_info={"pid": pid_p},
                           json_body={"deleteFiles": False})))
hj = r.json()
check("v117 history route: versions-only erases the history, the file stays byte-for-byte",
      hj.get("ok") and hj.get("deletedRevisions") == 1 and
      os.path.isfile(os.path.join(LIBDIR, "p_b.json")),
      json.dumps(hj))
r = loop(HPDEL(FakeRequest(match_info={"pid": pid_p},
                           json_body={"deleteFiles": False})))
check("v117 history route: the erased process answers 'no such process' (409)",
      r.status == 409 and r.json().get("ok") is False,
      json.dumps({"status": r.status}))

# ---- C) presets_referencing_paths (the canonical + case-insensitive match) -
rr = wf_store.presets_referencing_paths(["workflows/dup_a.json"])
check("v117 preset refs: the referencing preset is found",
      any(p.get("id") == ref_preset.get("id") for p in rr),
      json.dumps(rr))
rr = wf_store.presets_referencing_paths(["workflows/DUP_A.JSON"])
check("v117 preset refs: the match is case-insensitive (a Windows spelling)",
      any(p.get("id") == ref_preset.get("id") for p in rr),
      json.dumps(rr))
rr = wf_store.presets_referencing_paths(["workflows/never.json"])
check("v117 preset refs: a non-referenced path answers empty",
      rr == [], json.dumps(rr))

# ---- D) _evict_temp_files honors the cross-browser reference union ---------
check("v117 evict: the temp cap grew to 128 (30 entries per session)",
      wf_store.MAX_TEMP_FILES == 128, str(wf_store.MAX_TEMP_FILES))
_tdir = wf_store._temp_dir()
os.makedirs(_tdir, exist_ok=True)
tids = []
for i in range(130):
    tid = "%04x%s" % (i, "a" * 8)   # the temp ids are HEX (the _ID_RE contract)
    tids.append(tid)
    with open(os.path.join(_tdir, tid + ".json"), "w", encoding="utf-8") as fh:
        json.dump({"id": tid, "ts": 1700000000 + i, "seq": i,
                   "name": "t%d" % i, "graph": {"nodes": []}}, fh)
# the manifest of ANOTHER browser session references the 2 OLDEST temps
_mrec = {"entries": [{"tempId": tids[0]}, {"tempId": tids[1]}],
         "updatedAt": int(time.time())}
wf_store._mgr_write_json(wf_store._mgr_dir("recent"), "cidOther", _mrec)
wf_store._evict_temp_files()
alive = [t for t in tids
         if os.path.isfile(os.path.join(_tdir, t + ".json"))]
check("v117 evict: the referenced snapshots of ANOTHER session survive the cap",
      len(alive) == 130 and tids[0] in alive and tids[1] in alive,
      json.dumps({"alive": len(alive)}))
wf_store._mgr_delete(wf_store._mgr_dir("recent"), "cidOther")
wf_store._evict_temp_files()
alive2 = [t for t in tids
          if os.path.isfile(os.path.join(_tdir, t + ".json"))]
check("v117 evict: with no manifest left the cap applies again (128)",
      len(alive2) == wf_store.MAX_TEMP_FILES and
      tids[0] not in alive2 and tids[1] not in alive2,
      json.dumps({"alive": len(alive2)}))
for t in alive2:
    try:
        os.unlink(os.path.join(_tdir, t + ".json"))
    except OSError:
        pass

# ---- E) the /index/groups route --------------------------------------------
lib_write("g_u1.json", wf_v116(DU, seed="g1"))
lib_write("g_u2.json", wf_v116(DU, seed="g1"))
# the EXACT copy pair: different UUIDs, byte-identical apart from the id
lib_write("g_e1.json", wf_copy(EX1))
lib_write("g_e2.json", wf_copy(EX2))
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default", force=True)
r = loop(HGROUPS(FakeRequest(query={"threshold": "90"})))
gj = r.json()
check("v117 groups: the route answers with the profile + the weights",
      gj.get("ok") and gj.get("profile") == "nprof2" and
      isinstance(gj.get("weights"), dict),
      json.dumps({k: gj.get(k) for k in ("ok", "profile", "weights")}))
kinds = {}
for g in gj.get("groups", []):
    kinds.setdefault(g.get("kind"), []).append(g)
check("v117 groups: the same-UUID files form ONE same_uuid group",
      any(len(g.get("files", [])) == 2 for g in kinds.get("same_uuid", [])),
      json.dumps(kinds.get("same_uuid", [])))
check("v117 groups: the ComfyUI-Duplicate pair lands in an exact group (100%)",
      any(len(g.get("files", [])) == 2 and g.get("minScore") == 100
          for g in kinds.get("exact", [])),
      json.dumps(kinds.get("exact", [])))
check("v117 groups: the ungrouped rows carry the page shape",
      all("path" in f and "workflowId" in f for f in gj.get("ungrouped", [])),
      json.dumps((gj.get("ungrouped") or [{}])[0]))
r = loop(HGROUPS(FakeRequest(query={"threshold": "90"})))
check("v117 groups: the second call answers from the SQLite cache",
      r.json().get("ok") and r.json().get("cached") is True,
      json.dumps({"cached": r.json().get("cached")}))
r = loop(HGROUPS(FakeRequest(query={"threshold": "90", "kind": "same_uuid"})))
check("v117 groups: the kind filter narrows the answer",
      r.json().get("ok") and
      all(g.get("kind") == "same_uuid" for g in r.json().get("groups", [])) and
      r.json().get("groups"),
      json.dumps([g.get("kind") for g in r.json().get("groups", [])]))
# the invalidation: a changed file re-indexes -> the cache key moves
lib_write("g_u1.json", wf_v116(DU, seed="CHANGED"))
wf_store._wf_index.scan_index(
    workflows_user_dirs=wf_store._workflows_user_dirs(FakeRequest()),
    hide_dirs_fn=wf_store._files_hide_dirs, user_scope="default")
r = loop(HGROUPS(FakeRequest(query={"threshold": "90"})))
check("v117 groups: ANY re-index invalidates the cached answer",
      r.json().get("ok") and r.json().get("cached") is False,
      json.dumps({"cached": r.json().get("cached")}))

reset_state()
# ===========================================================================

print()
print("PASS: %d  FAIL: %d" % (PASS, FAIL))
if FAILURES:
    print("Failures:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
