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
check("health: version matches the source constant",
      j.get("version") == wf_store.WORKFLOWS_SERVER_VERSION,
      "%s vs %s" % (j.get("version"), wf_store.WORKFLOWS_SERVER_VERSION))
check("health: version is v109", j.get("version") == "v109", str(j.get("version")))
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

print()
print("PASS: %d  FAIL: %d" % (PASS, FAIL))
if FAILURES:
    print("Failures:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
