"""tests/py_test_workflows_ext.py - offline checks for the v124 EXTERNAL
workflow folders (py/workflows_ext.py + the store/index wiring).

Runs WITHOUT ComfyUI: `server`, `aiohttp` and `folder_paths` are stubbed in
sys.modules before the modules under test are imported, so the route
registrars only record their handlers; the handlers are then called directly
with fake aiohttp-style request objects.

Covers:
  * the REGISTRY (workflow_dirs.json): an absolute existing folder registers,
    re-adding answers the SAME entry (idempotent), a relative / missing /
    non-folder path refuses, the settings_hub service namespace refuses,
    the display rename never touches the disk, DETACH removes only the
    registration (the files stay), the 24-folder cap answers 409
  * resolve_ext(): the virtual namespace (workflows/.settings_hub_ext/<id>/
    <rel>) resolves to the REAL file; traversal ('..'), non-.json targets,
    unregistered ids and symlink escapes are refused
  * the /userdata MIRRORS: store writes the REAL file (atomic, the native
    response contracts: full_info {path: VIRTUAL, size, modified, created},
    the rel-path string without full_info, 409 when overwrite=false and the
    file exists), read serves the bytes (404 missing), move renames the REAL
    file inside the registered folders (cross-folder shutil.move), a dest
    outside the virtual namespace is refused, delete removes the REAL file
  * the browse picker: empty path -> the ROOTS (drives / '/'), subdirs list,
    parent navigation
  * the LISTING MERGE: GET /settings_hub/workflows/files carries the ext
    rows under their virtual paths (the ordinary rows untouched)
  * the INDEX: scan_index(extra_roots=...) indexes the ext files under the
    virtual rel_path (the search + the groups see them), the folder column
    keeps the relative-to-workflows-root convention, refresh_paths(path_map)
    re-indexes one ext file after an edit
  * _resolve_library_file(): the virtual branch resolves (the delete+undo,
    the history and the inspector reach the real files), a broken ext path
    answers (None, None)
  * v130 the DST DIALECT: the full virtual ext dst ('workflows/.settings_hub_ext/
    ...') un-aliases, ext -> standard ROOT lands in the root (never in
    workflows/workflows/), standard -> ext takes the namespace as the first
    rel segment, the batch transfer crosses the storages both ways

Run: python3 tests/py_test_workflows_ext.py   (exit 0 = all good)
"""
import asyncio
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# Stub modules BEFORE importing the code under test
# ---------------------------------------------------------------------------

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        FAILURES.append(name + (": " + str(detail) if detail else ""))
        print("  FAIL " + name + ("  | " + str(detail) if detail else ""))


class FakeResponse:
    def __init__(self, data=None, status=200, headers=None):
        self._data = data if data is not None else {}
        self.status = status
        self.headers = dict(headers or {})
        self.text = ""

    @property
    def ok(self):
        return self.status < 400

    def json(self):
        return self._data

    async def read(self):
        return b""


class FakeRawResponse:
    """web.Response(status=..., text=..., reason=...) - the native error /
    204 shapes the ext mirrors keep."""

    def __init__(self, body=None, content_type=None, status=200, text=None,
                 reason=None, headers=None):
        self.body = body
        self.content_type = content_type
        self.status = status
        self.text = text or ""
        self.reason = reason
        self.headers = dict(headers or {})

    @property
    def ok(self):
        return self.status < 400


class FakeFileResponse:
    """web.FileResponse(path, headers=...) - the read mirror."""

    def __init__(self, path, headers=None):
        self.path = path
        self.headers = dict(headers or {})
        self.status = 200
        with open(path, "rb") as f:
            self.body = f.read()

    @property
    def ok(self):
        return self.status < 400


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
        self.headers = dict(headers or {})

    async def json(self):
        if self._raw is not None:
            return json.loads(self._raw.decode("utf-8"))
        if self._json is not None:
            return self._json
        raise ValueError("no body")

    async def read(self):
        return self._raw if self._raw is not None else b""


def make_web_stub():
    web_stub = types.SimpleNamespace()
    web_stub.json_response = staticmethod(
        lambda data, status=200, headers=None: FakeResponse(data, status, headers))
    web_stub.Response = FakeRawResponse
    web_stub.FileResponse = FakeFileResponse
    return web_stub


server_stub = types.ModuleType("server")
server_stub.PromptServer = FakePromptServer
sys.modules["server"] = server_stub

aiohttp_stub = types.ModuleType("aiohttp")
aiohttp_stub.web = make_web_stub()
sys.modules["aiohttp"] = aiohttp_stub

fp_stub = types.ModuleType("folder_paths")
_USER_DIR = tempfile.mkdtemp(prefix="shub-wfext-user-")
fp_stub.get_user_directory = lambda: _USER_DIR
sys.modules["folder_paths"] = fp_stub

sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "py"))

FakePromptServer.instance = FakePromptServer()

import importlib.util


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# workflows_ext FIRST under its fallback name - workflows_store._ext_module()
# then returns THIS instance (one registry cache, one handler table)
wfx = load("workflows_ext", "py/workflows_ext.py")
wf_store = load("shub_workflows_store", "py/workflows_store.py")
wf_index = load("shub_workflows_index", "py/workflows_index.py")
wf_store._wf_index = wf_index

# the handlers
H_DIRS_GET = wfx.ext_dirs_get
H_DIRS_ADD = wfx.ext_dirs_add
H_DIRS_RENAME = wfx.ext_dirs_rename
H_DIRS_REMOVE = wfx.ext_dirs_remove
H_BROWSE = wfx.ext_browse
H_LIST = wfx.ext_list
H_READ = wfx.ext_read
H_STORE = wfx.ext_store
H_MOVE = wfx.ext_move
H_DELETE = wfx.ext_delete
H_FILES = wf_store.workflows_files_list
H_DEL_FILES = wf_store.workflows_files_delete

MGRDIR = os.path.join(_USER_DIR, "settings_hub", "workflows_manager")
wf_index.set_db_path(os.path.join(MGRDIR, "index", "workflow_index.db"))

loop = asyncio.new_event_loop()
try:
    run = lambda coro: loop.run_until_complete(coro)

    # a tiny valid workflow json
    def wf_json(name):
        return json.dumps({
            "id": "00000000-0000-0000-0000-00000000000" + str(len(name) % 10),
            "revision": 9,
            "last_node_id": 1, "last_link_id": 0,
            "nodes": [{"id": 1, "type": "KSampler",
                       "inputs": [], "outputs": [],
                       "widgets_values": [name]}],
            "links": [], "groups": [], "config": {}, "extra": {},
            "version": 0.4,
        })

    LIB = tempfile.mkdtemp(prefix="shub-ext-lib-")
    SUB = os.path.join(LIB, "family")
    os.makedirs(SUB, exist_ok=True)
    with open(os.path.join(LIB, "alpha.json"), "w", encoding="utf-8") as f:
        f.write(wf_json("alpha"))
    with open(os.path.join(SUB, "beta.json"), "w", encoding="utf-8") as f:
        f.write(wf_json("beta"))
    with open(os.path.join(LIB, "notes.txt"), "w", encoding="utf-8") as f:
        f.write("not a workflow")

    print("== v124 ext: the REGISTRY ==")
    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": str(LIB)})))
    check("add: an absolute existing folder registers",
          r.json().get("ok") and r.json()["dir"]["path"] == os.path.normpath(LIB),
          json.dumps(r.json()))
    did = r.json()["dir"]["id"]
    check("add: the id carries the d+hex shape",
          did and did.startswith("d") and len(did) == 11, did)
    check("add: writable probe true on a tmp folder",
          r.json()["dir"]["writable"] is True)

    r2 = run(H_DIRS_ADD(FakeRequest(json_body={"path": str(LIB)})))
    check("add: re-adding answers the SAME entry (idempotent)",
          r2.json().get("ok") and r2.json().get("existing") is True and
          r2.json()["dir"]["id"] == did, json.dumps(r2.json()))

    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": "relative/path"})))
    check("add: a relative path refuses", not r.ok, str(r.json()))
    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": os.path.join(LIB, "nope")})))
    check("add: a missing folder refuses", not r.ok, str(r.json()))
    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": _USER_DIR})))
    check("add: the user dir itself refuses (service namespace)",
          not r.ok, str(r.json()))
    r = run(H_DIRS_ADD(FakeRequest(json_body={})))
    check("add: an empty body refuses", not r.ok, str(r.json()))

    r = run(H_DIRS_GET(FakeRequest(method="GET")))
    check("dirs GET: one entry, exists + writable flags",
          r.json().get("ok") and len(r.json()["dirs"]) == 1 and
          r.json()["dirs"][0]["exists"] is True, json.dumps(r.json()))

    r = run(H_DIRS_RENAME(FakeRequest(match_info={"dir_id": did},
                                      json_body={"name": "My Lib"})))
    check("rename: the display name updates",
          r.json().get("ok") and r.json()["dir"]["name"] == "My Lib",
          json.dumps(r.json()))
    check("rename: the real folder is untouched",
          os.path.isfile(os.path.join(LIB, "alpha.json")))

    r = run(H_DIRS_RENAME(FakeRequest(match_info={"dir_id": "ddeadbeef"},
                                      json_body={"name": "x"})))
    check("rename: an unknown id answers 404", r.status == 404, str(r.status))

    print("== v124 ext: resolve_ext security ==")
    virt = "workflows/.settings_hub_ext/%s/alpha.json" % did
    phys, d, rel = wfx.resolve_ext(virt)
    check("resolve: the virtual path -> the REAL file",
          phys == os.path.normpath(os.path.join(LIB, "alpha.json")) and
          d["id"] == did and rel == "alpha.json", str(phys))
    phys2, _d2, err2 = wfx.resolve_ext(
        "workflows/.settings_hub_ext/%s/../%s/alpha.json" % (did, did))
    check("resolve: a '..' traversal refuses",
          phys2 is None and "escape" in (err2 or "") or phys2 is None, str(err2))
    phys3, _d3, err3 = wfx.resolve_ext(
        "workflows/.settings_hub_ext/%s/notes.txt" % did)
    check("resolve: a non-.json target refuses", phys3 is None, str(err3))
    phys4, _d4, err4 = wfx.resolve_ext(
        "workflows/.settings_hub_ext/ddeadbeef99/x.json")
    check("resolve: an unregistered id refuses", phys4 is None, str(err4))
    phys5, _d5, err5 = wfx.resolve_ext("workflows/ordinary/folder.json")
    check("resolve: an ordinary path is not ext", phys5 is None, str(err5))

    if hasattr(os, "symlink"):
        link = os.path.join(LIB, "escape.json")
        outside = os.path.join(tempfile.mkdtemp(prefix="shub-ext-out-"), "x.json")
        with open(outside, "w", encoding="utf-8") as f:
            f.write("{}")
        try:
            os.symlink(outside, link)
            phys6, _d6, err6 = wfx.resolve_ext(
                "workflows/.settings_hub_ext/%s/escape.json" % did)
            check("resolve: a symlink escape refuses",
                  phys6 is None, str(err6))
        finally:
            os.unlink(link)

    print("== v124 ext: the /userdata MIRRORS ==")
    body = wf_json("beta-updated").encode("utf-8")
    r = run(H_STORE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/new.json" % did,
               "overwrite": "false", "full_info": "true"},
        raw_body=body)))
    check("store: creates the REAL file",
          r.ok and os.path.isfile(os.path.join(SUB, "new.json")),
          json.dumps(r.json()))
    fi = r.json()
    check("store: full_info keeps the VIRTUAL path + the ms stamps",
          fi.get("path") == "workflows/.settings_hub_ext/%s/family/new.json" % did and
          isinstance(fi.get("modified"), int) and fi["modified"] > 10**12,
          json.dumps(fi))
    r = run(H_STORE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/new.json" % did,
               "overwrite": "false", "full_info": "true"},
        raw_body=body)))
    check("store: overwrite=false on an existing file answers 409",
          r.status == 409, str(r.status))
    r = run(H_STORE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/new.json" % did,
               "overwrite": "true"},
        raw_body=body)))
    check("store: overwrite=true answers the rel-path string (native shape)",
          r.ok and r.json() == "workflows/.settings_hub_ext/%s/family/new.json" % did,
          json.dumps(r.json()))
    r = run(H_READ(FakeRequest(method="GET",
                               query={"path": "workflows/.settings_hub_ext/%s/family/new.json" % did})))
    check("read: the REAL bytes come back", r.ok and r.body == body, str(r.status))
    r = run(H_READ(FakeRequest(method="GET",
                               query={"path": "workflows/.settings_hub_ext/%s/missing.json" % did})))
    check("read: a missing file answers 404", r.status == 404, str(r.status))

    r = run(H_MOVE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/new.json" % did,
               "to": "workflows/.settings_hub_ext/%s/family/renamed.json" % did,
               "full_info": "true"})))
    check("move: the REAL file renames",
          r.ok and os.path.isfile(os.path.join(SUB, "renamed.json")) and
          not os.path.isfile(os.path.join(SUB, "new.json")), json.dumps(r.json()))
    check("move: the answer reports the VIRTUAL dest",
          r.json().get("path", "").endswith("renamed.json"), json.dumps(r.json()))
    r = run(H_MOVE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/renamed.json" % did,
               "to": "workflows/outside-dest.json"})))
    check("move: a dest OUTSIDE the virtual namespace refuses",
          not r.ok, str(r.json()))
    r = run(H_MOVE(FakeRequest(
        query={"path": "workflows/.settings_hub_ext/%s/family/ghost.json" % did,
               "to": "workflows/.settings_hub_ext/%s/family/x.json" % did})))
    check("move: a missing source answers 404", r.status == 404, str(r.status))

    r = run(H_DELETE(FakeRequest(method="DELETE",
                                 query={"path": "workflows/.settings_hub_ext/%s/family/renamed.json" % did})))
    check("delete: the REAL file is removed (204)",
          r.status == 204 and not os.path.isfile(os.path.join(SUB, "renamed.json")),
          str(r.status))
    r = run(H_DELETE(FakeRequest(method="DELETE",
                                 query={"path": "workflows/.settings_hub_ext/%s/family/renamed.json" % did})))
    check("delete: a second delete answers 404", r.status == 404, str(r.status))

    print("== v124 ext: the BROWSE picker ==")
    r = run(H_BROWSE(FakeRequest(method="GET", query={})))
    check("browse: the empty path answers the ROOTS",
          r.json().get("ok") and r.json().get("roots") is True and
          isinstance(r.json().get("roots_list"), list) and r.json()["roots_list"],
          json.dumps(r.json()))
    root0 = r.json()["roots_list"][0]
    r = run(H_BROWSE(FakeRequest(method="GET", query={"path": root0})))
    check("browse: a root lists its subdirs (bounded, dirs only)",
          r.json().get("ok") and r.json().get("roots") is False and
          isinstance(r.json().get("dirs"), list), json.dumps(r.json())[:200])
    # the parent navigation runs against the REGISTERED folder - a fully
    # controlled subtree (the filesystem root may hold unreadable dirs)
    r2 = run(H_BROWSE(FakeRequest(method="GET", query={"path": str(LIB)})))
    check("browse: a folder lists its subdirs",
          r2.json().get("ok") and "family" in r2.json().get("dirs", []),
          json.dumps(r2.json())[:200])
    r3 = run(H_BROWSE(FakeRequest(method="GET",
                                  query={"path": os.path.join(str(LIB), "family")})))
    check("browse: a child's parent navigates back",
          r3.json().get("ok") and
          os.path.normcase(r3.json().get("parent") or "") ==
          os.path.normcase(os.path.normpath(str(LIB))),
          json.dumps(r3.json())[:200])
    r = run(H_BROWSE(FakeRequest(method="GET", query={"path": "relative"})))
    check("browse: a relative path refuses", not r.ok, str(r.json()))

    print("== v124 ext: the FILES listing merge ==")
    r = run(H_FILES(FakeRequest(method="GET")))
    files = r.json().get("files") or []
    extpaths = [f["path"] for f in files if ".settings_hub_ext/" in f["path"]]
    check("files: the ext rows ride in the SAME answer under virtual paths",
          r.json().get("ok") and extpaths and
          all(p.startswith("workflows/.settings_hub_ext/") for p in extpaths),
          json.dumps(extpaths[:5]))
    check("files: only .json surfaces (the .txt is hidden)",
          all(p.lower().endswith(".json") for p in extpaths), json.dumps(extpaths))

    print("== v124 ext: the store wiring ==")
    phys7, root7 = wf_store._resolve_library_file(
        FakeRequest(method="POST"),
        "workflows/.settings_hub_ext/%s/alpha.json" % did)
    check("_resolve_library_file: the virtual branch reaches the REAL file",
          phys7 == os.path.normpath(os.path.join(LIB, "alpha.json")),
          str(phys7))
    check("_resolve_library_file: the root is the registered folder",
          root7 == os.path.normpath(LIB), str(root7))
    phys8, _root8 = wf_store._resolve_library_file(
        FakeRequest(method="POST"),
        "workflows/.settings_hub_ext/%s/../../etc.json" % did)
    check("_resolve_library_file: a traversal ext path refuses",
          phys8 is None, str(phys8))

    print("== v124 ext: the INDEX (extra roots + refresh map) ==")
    db = os.path.join(MGRDIR, "index", "workflow_index.db")
    extra = wfx.ext_scan_roots()
    check("scan roots: the registered folder carries the virtual prefix",
          len(extra) == 1 and extra[0][3] == "workflows/.settings_hub_ext/%s/" % did,
          json.dumps([list(e[:2]) + [e[3]] for e in extra]))
    st = wf_index.scan_index(db=db, workflows_user_dirs=[], hide_dirs_fn=lambda d: [],
                             user_scope="default", force=True, extra_roots=extra)
    check("scan: the ext files index (2 rows, no errors)",
          st.get("ok") and st.get("indexed") == 2 and st.get("errors") == 0,
          json.dumps({k: st.get(k) for k in ("indexed", "errors", "removed")}))
    res = wf_index.search_index(db=db, user_scope="default", q="alpha")
    row = (res.get("files") or [None])[0]
    check("search: the ext row answers under its VIRTUAL path",
          row and row["path"] == "workflows/.settings_hub_ext/%s/alpha.json" % did,
          json.dumps(res.get("files", []))[:200])
    res2 = wf_index.search_index(db=db, user_scope="default",
                                 folder=".settings_hub_ext/%s/family" % did)
    check("search: the folder filter reaches the ext subtree",
          any(f["name"] == "beta.json" for f in res2.get("files", [])),
          json.dumps(res2.get("files", []))[:200])

    # an edit + the point re-index through the path map
    with open(os.path.join(LIB, "alpha.json"), "w", encoding="utf-8") as f:
        f.write(wf_json("alpha-EDITED"))
    pmap = wfx.ext_refresh_map(
        ["workflows/.settings_hub_ext/%s/alpha.json" % did])
    check("refresh map: the virtual rel maps to the REAL file",
          pmap.get("workflows/.settings_hub_ext/%s/alpha.json" % did) ==
          os.path.normpath(os.path.join(LIB, "alpha.json")), json.dumps(pmap))
    fr = wf_index.refresh_paths(db=db, user_scope="default", root_dirs=[],
                                rel_paths=["workflows/.settings_hub_ext/%s/alpha.json" % did],
                                path_map=pmap)
    check("refresh_paths: the ext row updates through the map",
          fr.get("ok") and fr.get("updated") == 1, json.dumps(fr))
    res3 = wf_index.search_index(db=db, user_scope="default", q="EDITED")
    check("search: the re-indexed content is searchable",
          any(f.get("path", "").endswith("alpha.json")
              for f in res3.get("files", [])),
          json.dumps(res3.get("files", []))[:200])
    # a vanished ext file drops its row
    os.unlink(os.path.join(SUB, "beta.json"))
    fr2 = wf_index.refresh_paths(db=db, user_scope="default", root_dirs=[],
                                 rel_paths=["workflows/.settings_hub_ext/%s/family/beta.json" % did],
                                 path_map=wfx.ext_refresh_map(
                                     ["workflows/.settings_hub_ext/%s/family/beta.json" % did]))
    check("refresh_paths: a vanished ext file drops its row",
          fr2.get("ok") and fr2.get("removed") == 1, json.dumps(fr2))

    print("== v124 ext: DETACH (the files stay) ==")
    r = run(H_DIRS_REMOVE(FakeRequest(method="DELETE",
                                      match_info={"dir_id": did})))
    check("detach: the registration removes",
          r.json().get("ok") and r.json().get("removed") == did,
          json.dumps(r.json()))
    check("detach: the REAL files are NEVER touched",
          os.path.isfile(os.path.join(LIB, "alpha.json")))
    phys9, _r9, err9 = wfx.resolve_ext(
        "workflows/.settings_hub_ext/%s/alpha.json" % did)
    check("detach: the namespace stops resolving", phys9 is None, str(err9))
    r = run(H_FILES(FakeRequest(method="GET")))
    files2 = r.json().get("files") or []
    check("files: the detached rows leave the listing",
          not any(".settings_hub_ext/" in (f["path"] or "")
                  for f in files2), json.dumps(len(files2)))

    # ==================================================================
    print("== v129 ext: the SUBDIRS suggestions + the cross-storage rename ==")
    wfx._dirs_cache = []
    lib2 = tempfile.mkdtemp(prefix="shub-ext-sub-")
    os.makedirs(os.path.join(lib2, "a", "b"), exist_ok=True)
    os.makedirs(os.path.join(lib2, "empty"), exist_ok=True)
    with open(os.path.join(lib2, "a", "b", "deep.json"), "w", encoding="utf-8") as f:
        f.write(wf_json("deep"))
    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": lib2})))
    did2 = (r.json().get("dir") or {}).get("id")
    H_SUBS = wfx.ext_subdirs
    r = run(H_SUBS(FakeRequest(method="GET", query={"dir": did2})))
    j = r.json()
    check("v129 ext subdirs: ok", r.status == 200 and j.get("ok") is True, str(j))
    check("v129 ext subdirs: the EMPTY folder is listed (empty dirs included)",
          "empty" in (j.get("dirs") or []), str(j.get("dirs")))
    check("v129 ext subdirs: the nested chain is listed",
          "a" in (j.get("dirs") or []) and "a/b" in (j.get("dirs") or []),
          str(j.get("dirs")))
    check("v129 ext subdirs: sorted",
          (j.get("dirs") or []) == sorted(j.get("dirs") or []))
    r = run(H_SUBS(FakeRequest(method="GET", query={"dir": "nosuchid"})))
    check("v129 ext subdirs: an unknown id -> 404", r.status == 404, str(r.status))

    # the cross-storage rename: the ext virtual namespace -> the STANDARD
    # workflows folder - one server call, the REAL file moves across disks
    std_root = os.path.join(_USER_DIR, "default", "workflows")
    os.makedirs(std_root, exist_ok=True)
    H_REN = wf_store.workflows_files_rename
    r = run(H_REN(FakeRequest(json_body={
        "src": "workflows/.settings_hub_ext/%s/a/b/deep.json" % did2,
        "dst": "from-ext/deep.json"})))
    j = r.json()
    check("v129 ext rename: ext -> standard ok",
          r.status == 200 and j.get("ok") is True, str(j))
    check("v129 ext rename: the REAL file landed in the standard root",
          os.path.isfile(os.path.join(std_root, "from-ext", "deep.json")))
    check("v129 ext rename: the ext copy is gone",
          not os.path.isfile(os.path.join(lib2, "a", "b", "deep.json")))
    r = run(H_REN(FakeRequest(json_body={
        "src": "workflows/.settings_hub_ext/%s/a/b/deep.json" % did2,
        "dst": "nowhere.json"})))
    check("v129 ext rename: a missing ext src -> 400", r.status == 400,
          str(r.status))

    # == v130: the dst DIALECT fixes (the owner's bug report) ==============
    # 1) the FULL VIRTUAL ext dst ('workflows/.settings_hub_ext/<id>/...')
    #    un-aliases - the v129 frontend shipped exactly this shape
    with open(os.path.join(lib2, "a", "b", "dialect.json"), "w",
              encoding="utf-8") as f:
        f.write(wf_json("dialect"))
    r = run(H_REN(FakeRequest(json_body={
        "src": "workflows/.settings_hub_ext/%s/a/b/dialect.json" % did2,
        "dst": "workflows/.settings_hub_ext/%s/a/b/dialect-moved.json" % did2})))
    j = r.json()
    check("v130 rename: the full VIRTUAL ext dst un-aliases (ok)",
          r.status == 200 and j.get("ok") is True, str(j))
    check("v130 rename: the file moved INSIDE the ext folder",
          os.path.isfile(os.path.join(lib2, "a", "b", "dialect-moved.json")) and
          not os.path.isfile(os.path.join(lib2, "a", "b", "dialect.json")),
          str(j))
    check("v130 rename: the answer dst is the canonical virtual path",
          j.get("dst") == "workflows/.settings_hub_ext/%s/a/b/dialect-moved.json" % did2,
          str(j.get("dst")))

    # 2) ext -> STANDARD with a ROOT-level rel dst - the file lands in the
    #    STANDARD ROOT, never in workflows/workflows/ (the owner's bug)
    r = run(H_REN(FakeRequest(json_body={
        "src": "workflows/.settings_hub_ext/%s/a/b/dialect-moved.json" % did2,
        "dst": "dialect-root.json"})))
    j = r.json()
    check("v130 rename: ext -> standard ROOT ok",
          r.status == 200 and j.get("ok") is True, str(j))
    check("v130 rename: the file sits in the standard ROOT (no workflows/workflows/)",
          os.path.isfile(os.path.join(std_root, "dialect-root.json")) and
          not os.path.isfile(os.path.join(std_root, "workflows", "dialect-root.json")) and
          not os.path.isdir(os.path.join(std_root, "workflows")), str(j))
    check("v130 rename: the answer dst is the standard virtual path",
          j.get("dst") == "workflows/dialect-root.json", str(j.get("dst")))

    # 3) standard -> ext: the rel dst carries the namespace as the FIRST segment
    r = run(H_REN(FakeRequest(json_body={
        "src": "workflows/dialect-root.json",
        "dst": ".settings_hub_ext/%s/back.json" % did2})))
    j = r.json()
    check("v130 rename: standard -> ext (the rel namespace dst) ok",
          r.status == 200 and j.get("ok") is True, str(j))
    check("v130 rename: the REAL file is back in the ext folder",
          os.path.isfile(os.path.join(lib2, "back.json")), str(j))

    # 4) the batch transfer across the storages (the same rel dialect)
    H_TRF = wf_store.workflows_files_transfer
    with open(os.path.join(lib2, "batch-src.json"), "w", encoding="utf-8") as f:
        f.write(wf_json("batch"))
    r = run(H_TRF(FakeRequest(json_body={"op": "copy", "items": [
        {"src": "workflows/.settings_hub_ext/%s/batch-src.json" % did2,
         "dst": "batch-copy.json"}]})))
    j = r.json()
    check("v130 transfer: ext -> standard copy ok",
          r.status == 200 and j.get("copied") == 1, str(j))
    check("v130 transfer: the copy landed in the standard ROOT",
          os.path.isfile(os.path.join(std_root, "batch-copy.json")) and
          os.path.isfile(os.path.join(lib2, "batch-src.json")), str(j))
    r = run(H_TRF(FakeRequest(json_body={"op": "move", "items": [
        {"src": "workflows/batch-copy.json",
         "dst": ".settings_hub_ext/%s/batch-back.json" % did2}]})))
    j = r.json()
    check("v130 transfer: standard -> ext move ok",
          r.status == 200 and j.get("moved") == 1, str(j))
    check("v130 transfer: the REAL file crossed back to the ext disk",
          os.path.isfile(os.path.join(lib2, "batch-back.json")) and
          not os.path.isfile(os.path.join(std_root, "batch-copy.json")), str(j))

    # the cap check (a fresh registry, 24 + 1 entries would need 25 real
    # dirs - the cap answers before any 25th folder exists)
    wfx._dirs_cache = []
    for i in range(24):
        d = tempfile.mkdtemp(prefix="shub-ext-cap-")
        run(H_DIRS_ADD(FakeRequest(json_body={"path": d})))
    d25 = tempfile.mkdtemp(prefix="shub-ext-cap-")
    r = run(H_DIRS_ADD(FakeRequest(json_body={"path": d25})))
    check("add: the 24-folder cap answers 409", r.status == 409, str(r.status))

finally:
    loop.close()

print()
print("PASS: %d  FAIL: %d" % (PASS, FAIL))
if FAILURES:
    print("Failures:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
