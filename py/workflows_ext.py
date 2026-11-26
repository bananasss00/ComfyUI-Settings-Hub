"""
SettingsHub - Workflows Manager: EXTERNAL workflow folders (v124).

The owner's ask (v124):
  1. the Workflows Manager must list workflows from ARBITRARY folders -
     outside the ComfyUI environment, including other disks (Windows D:\\,
     network mounts, ...);
  2. saving a workflow through ComfyUI itself (Ctrl+S / Workflow > Save) or
     through the manager must write THE SAME file it was opened from - never
     spawn a fresh copy inside the official userdata workflows/ folder.

HOW IT WORKS
------------
Every registered folder gets a STABLE VIRTUAL path namespace inside the
userdata tree:

    workflows/.settings_hub_ext/<dirId>/<rel>.json

* `<dirId>` is a short stable id ("d" + 10 hex chars of the sha1 of the
  registered absolute path) - it survives restarts and re-registrations.
* The frontend lists these virtual paths TOGETHER with the ordinary ones
  (the listing merge happens in web/workflows.js), so the ComfyUI workflow
  store treats them as first-class persisted files. Opening, tab binding,
  drafts, Save, the Save As dialog, rename, delete - all keep working
  through the frontend's own UserFile I/O.
* The frontend installs ONE small fetchApi hook (web/workflows.js): requests
  that target the virtual namespace are re-pointed to THIS module's routes,
  which read/write the REAL file on the real disk. Responses mimic the
  native /userdata contracts (the get_file_info shape, 409/404 statuses),
  so the frontend code paths stay untouched.
* The manager's own machinery (the files listing, the SQLite index, the
  similarity groups, the history, the inspector, the delete + undo)
  resolves the virtual prefix through resolve_ext() - one resolver, every
  route stays uniform.

SECURITY
--------
* Only REGISTERED absolute directories are reachable; the id alone is not
  enough - it must map to a currently-registered path.
* The relative part is sanitized (no "..", no backslashes, no absolute
  forms) and the REALPATH of the joined path must stay inside the REALPATH
  of the registered dir - symlink escapes are refused.
* File operations accept .json only (workflows are .json; the folder picker
  is the only window into directory listings, and it lists DIRECTORIES
  only, no file content ever leaves the server).
* Everything is bounded (MAX_* constants) - a huge external tree cannot
  stall the server.
"""

import hashlib
import json
import os
import re
import shutil
import string
import tempfile
import time

from server import PromptServer
from aiohttp import web

try:
    import folder_paths
except Exception:  # pragma: no cover - folder_paths always exists in ComfyUI
    folder_paths = None

# ---------------------------------------------------------------------------
# Limits (server-side absolute guards)
# ---------------------------------------------------------------------------

MAX_EXT_DIRS = 24                 # registered folders per install
MAX_EXT_PATH_CHARS = 400          # the registered absolute path
MAX_EXT_NAME_CHARS = 80           # the display name
MAX_EXT_FILES_LISTED = 6000       # one ext listing walk (the store's bound)
MAX_EXT_WRITE_BYTES = 64 * 1024 * 1024   # one workflow json is far smaller
MAX_EXT_BROWSE_ENTRIES = 500      # subdirs shown by the folder picker
MAX_EXT_REL_CHARS = 300           # one virtual relative path
MAX_EXT_SUBDIRS = 2000            # v129: the subdir suggestions of one folder
# v131: these files NEVER make a folder "occupied" (mirrors the store side)
_SUBDIR_JUNK_FILES = {".ds_store", "thumbs.db", "desktop.ini"}

# the virtual namespace inside the userdata workflows tree
VIRT_DIR_NAME = ".settings_hub_ext"
VIRT_PREFIX = "workflows/" + VIRT_DIR_NAME + "/"   # "workflows/.settings_hub_ext/"
_DIR_ID_RE = re.compile(r"^d[0-9a-f]{6,16}$")

_DIR_PROBE_NAME = ".sh_ext_probe"  # the writability probe file name


def _user_dir():
    base = None
    if folder_paths is not None:
        fn = getattr(folder_paths, "get_user_directory", None)
        if callable(fn):
            try:
                base = fn()
            except Exception:
                base = None
    if not isinstance(base, str) or not base:
        base = os.path.join(os.getcwd(), "user")
    return base


def _registry_path():
    return os.path.join(_user_dir(), "settings_hub", "workflow_dirs.json")


# ---------------------------------------------------------------------------
# The registry - a small JSON file next to workflows_root.json / the
# favorites. The registered folders are GLOBAL for the server (the storage
# root override is global too) and are NEVER moved or deleted by a removal:
# removing a registration only detaches the folder from the manager.
# ---------------------------------------------------------------------------

_dirs_cache = None


def _dir_id_for(abs_path):
    """STABLE per-path id - the same folder always maps to the same virtual
    namespace (restarts and re-adds never orphan the index rows)."""
    h = hashlib.sha1(os.path.normcase(os.path.abspath(abs_path))
                     .encode("utf-8", "replace")).hexdigest()[:10]
    return "d" + h


def _load_dirs():
    """The registered folders. A corrupt file reads as empty (the registry
    self-heals on the next save); entries keep only the confirmed fields."""
    global _dirs_cache
    if _dirs_cache is not None:
        return _dirs_cache
    out = []
    try:
        with open(_registry_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("dirs") if isinstance(data, dict) else None
        if isinstance(items, list):
            for it in items:
                if not isinstance(it, dict):
                    continue
                p = it.get("path")
                if not isinstance(p, str) or not p or not os.path.isabs(p):
                    continue
                out.append({
                    "id": str(it.get("id") or _dir_id_for(p)),
                    "name": str(it.get("name") or "")[:MAX_EXT_NAME_CHARS],
                    "path": os.path.normpath(p),
                    "added": int(it.get("added") or 0),
                })
    except Exception:
        out = []
    # de-dupe by normalized path (a hand-edited file must not stack entries)
    seen = set()
    uniq = []
    for d in out:
        key = os.path.normcase(os.path.abspath(d["path"]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(d)
    _dirs_cache = uniq
    return _dirs_cache


def _save_dirs(dirs):
    """Atomic registry write (tmp + os.replace). Best-effort: False on a
    failure (the answer names it; the folder still works for the session)."""
    global _dirs_cache
    try:
        os.makedirs(os.path.dirname(_registry_path()), exist_ok=True)
        tmp = _registry_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"dirs": dirs, "saved": int(time.time())}, f,
                      ensure_ascii=False, indent=1)
        os.replace(tmp, _registry_path())
        _dirs_cache = list(dirs)
        return True
    except Exception:
        return False


def _find_dir_by_path(abs_path):
    key = os.path.normcase(os.path.abspath(abs_path))
    for d in _load_dirs():
        if os.path.normcase(os.path.abspath(d["path"])) == key:
            return d
    return None


def _find_dir_by_id(dir_id):
    if not isinstance(dir_id, str) or not _DIR_ID_RE.match(dir_id):
        return None
    for d in _load_dirs():
        if d["id"] == dir_id:
            return d
    return None


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------

def _clean_rel(raw):
    """The relative part of a virtual path - POSIX, no traversal, .json only.
    Returns the cleaned rel or None. The length cap mirrors the store's
    MAX_PATH_CHARS budget."""
    if not isinstance(raw, str):
        return None
    p = raw.strip().replace("\\", "/")
    if not p or len(p) > MAX_EXT_REL_CHARS:
        return None
    if p.startswith("/") or re.match(r"^[A-Za-z]:", p):
        return None
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if not parts or any(seg == ".." for seg in parts):
        return None
    rel = "/".join(parts)
    if not rel.lower().endswith(".json"):
        return None
    return rel


def _parse_virtual(path_str):
    """'workflows/.settings_hub_ext/<id>/<rel>' (the leading 'workflows/' is
    optional) -> ((dir_rec, rel), None) or (None, error). The id must map to
    a CURRENTLY REGISTERED dir - a guessed id reaches nothing."""
    if not isinstance(path_str, str) or not path_str:
        return None, "path is required"
    s = path_str.strip().replace("\\", "/")
    s = s[len("workflows/"):] if s.lower().startswith("workflows/") else s
    if not s.startswith(VIRT_DIR_NAME + "/"):
        return None, "not an external-folder path"
    rest = s[len(VIRT_DIR_NAME) + 1:]
    parts = rest.split("/", 1)
    if len(parts) != 2 or not parts[1]:
        return None, "the virtual path has no file part"
    dir_id, raw_rel = parts[0], parts[1]
    d = _find_dir_by_id(dir_id)
    if not d:
        return None, "the folder is not registered (removed?)"
    rel = _clean_rel(raw_rel)
    if not rel:
        return None, "bad file path (only relative .json paths are allowed)"
    return (d, rel), None


def _is_inside(path, folder):
    try:
        rel = os.path.relpath(path, folder)
    except Exception:
        return False
    return not rel.startswith("..") and not os.path.isabs(rel) and rel != "."


def resolve_ext(path_str, check_exists=False):
    """The ONE hardened locator of an external workflow file. Returns
    (real_path, dir_rec, rel) on success or (None, None, error) on a refusal.
    The joined path is symlink-checked: its realpath must stay inside the
    registered dir's realpath - a link pointing outside the registered
    folder can never be read, written, moved or deleted."""
    pair, err = _parse_virtual(path_str)
    if err:
        return None, None, err
    d, rel = pair
    root = d["path"]
    cand = os.path.normpath(os.path.join(root, rel))
    if not _is_inside(cand, root):
        return None, None, "the path escapes the registered folder"
    try:
        real_cand = os.path.realpath(cand)
        real_root = os.path.realpath(root)
    except Exception:
        return None, None, "the path cannot be resolved"
    if not _is_inside(real_cand, real_root):
        return None, None, "a symlink escape is not allowed"
    if check_exists and not os.path.isfile(real_cand):
        return None, None, "no such file"
    return real_cand, d, rel


def virtual_path(dir_rec, rel):
    """The full virtual path of a file: workflows/.settings_hub_ext/<id>/<rel>."""
    return VIRT_PREFIX + dir_rec["id"] + "/" + rel


# ---------------------------------------------------------------------------
# Listing - the bounded walk the Files tab + the index scan share
# ---------------------------------------------------------------------------

def _walk_ext_files(root, rel_prefix, limit):
    """[(virtual_rel_under_workflows, full_path, size, mtime)] - .json only,
    bounded. virtual_rel does NOT carry the 'workflows/' prefix (the callers
    add it)."""
    out = []
    truncated = False
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            filenames.sort()
            for fn in sorted(filenames):
                if not fn.lower().endswith(".json"):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                try:
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                except Exception:
                    continue
                out.append((rel_prefix + rel, full, int(st.st_size),
                            int(st.st_mtime)))
                if len(out) >= limit:
                    truncated = True
                    break
            if truncated:
                break
    except Exception:
        pass
    return out, truncated


def list_dir_files(dir_rec, limit=MAX_EXT_FILES_LISTED):
    """One folder's .json files as the Files-tab rows (virtual paths)."""
    prefix = VIRT_DIR_NAME + "/" + dir_rec["id"] + "/"
    rows, truncated = _walk_ext_files(dir_rec["path"], prefix, max(1, limit))
    files = []
    for vrel, _full, size, mtime in rows:
        files.append({"path": "workflows/" + vrel,
                      "name": vrel.rsplit("/", 1)[-1],
                      "size": size, "mtime": mtime})
    return files, truncated


def list_all_ext_files(limit=MAX_EXT_FILES_LISTED):
    """Every registered folder's files in ONE list (the /workflows/files
    route merges it after the userdata roots walk). Bounded by the same
    total budget."""
    out = []
    truncated = False
    budget = max(1, limit)
    for d in _load_dirs():
        if not os.path.isdir(d["path"]):
            continue
        if len(out) >= budget:
            truncated = True
            break
        files, tr = list_dir_files(d, budget - len(out))
        out.extend(files)
        truncated = truncated or tr
    return out, truncated


def ext_scan_roots():
    """The index-scan roots for the registered folders:
    [(root_key, dir, hides, rel_prefix)] - rel_prefix puts the rows under
    the virtual namespace ('workflows/.settings_hub_ext/<id>/'), so the
    index, the groups, the search and the open/save machinery all speak ONE
    path shape. A folder that vanished from disk simply walks empty."""
    out = []
    for d in _load_dirs():
        if not os.path.isdir(d["path"]):
            continue
        out.append(("ext_" + d["id"], d["path"], set(),
                    VIRT_PREFIX + d["id"] + "/"))
    return out


def ext_refresh_map(paths):
    """{virtual_rel: real_path} for the point re-index (refresh_paths) -
    virtual paths cannot be re-resolved by the ordinary root join."""
    want = {p for p in (paths or []) if isinstance(p, str) and p}
    if not want:
        return {}
    out = {}
    for d in _load_dirs():
        if not os.path.isdir(d["path"]):
            continue
        prefix = VIRT_DIR_NAME + "/" + d["id"] + "/"
        rows, _tr = _walk_ext_files(d["path"], prefix, MAX_EXT_FILES_LISTED)
        for vrel, full, _sz, _mt in rows:
            key = "workflows/" + vrel
            if key in want:
                out[key] = full
    return out


def _probe_writable(root):
    try:
        os.makedirs(root, exist_ok=True)
        probe = os.path.join(root, _DIR_PROBE_NAME)
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.unlink(probe)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _bad(error, status=400):
    return web.json_response({"ok": False, "error": error}, status=status)


def _dir_row(d):
    exists = os.path.isdir(d["path"])
    return {"id": d["id"],
            "name": d["name"] or os.path.basename(d["path"]) or d["path"],
            "path": d["path"], "exists": exists,
            "writable": bool(exists and _probe_writable(d["path"]))}


@PromptServer.instance.routes.get("/settings_hub/workflows/ext/dirs")
async def ext_dirs_get(request):
    """The registered folders (+ live exists/writable probes). An old py
    without this route answers 404 - the client degrades to the native
    behavior (the same contract the other manager routes keep)."""
    return web.json_response({"ok": True,
                              "dirs": [_dir_row(d) for d in _load_dirs()]})


@PromptServer.instance.routes.post("/settings_hub/workflows/ext/dirs")
async def ext_dirs_add(request):
    """Register a folder. Body {path, name?}. The path MUST be absolute and
    an existing directory (other disks are fine - that is the point).
    Re-adding a known path answers the SAME entry (idempotent)."""
    try:
        body = await request.json()
    except Exception:
        return _bad("bad json")
    if not isinstance(body, dict):
        return _bad("bad json")
    raw = body.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return _bad("path is required")
    p = raw.strip()
    while p[:1] in ('"', "'") and p.endswith(p[0]):
        p = p[1:-1].strip()
    try:
        p = os.path.expanduser(p)
    except Exception:
        pass
    if not p or len(p) > MAX_EXT_PATH_CHARS:
        return _bad("path is empty or too long")
    if not os.path.isabs(p):
        return _bad("not an absolute path: " + p[:120])
    p = os.path.normpath(p)
    if not os.path.isdir(p):
        return _bad("the folder does not exist: " + p[:200])
    # never register anything inside the ComfyUI user dir's settings_hub
    # namespace (the manager's own housekeeping must not become a library)
    ud = os.path.normcase(os.path.abspath(_user_dir()))
    pn = os.path.normcase(os.path.abspath(p))
    if pn == ud or _is_inside(pn, os.path.join(ud, "settings_hub")):
        return _bad("the settings_hub service namespace cannot be a library folder")
    existing = _find_dir_by_path(p)
    if existing:
        # idempotent: refresh the display name when one was supplied
        name = body.get("name")
        if isinstance(name, str) and name.strip() and \
                name.strip() != (existing["name"] or ""):
            existing["name"] = name.strip()[:MAX_EXT_NAME_CHARS]
            if not _save_dirs(_load_dirs()):
                return _bad("the folder is registered, but the registry file "
                            "could not be written", 500)
        return web.json_response({"ok": True, "dir": _dir_row(existing),
                                  "existing": True})
    dirs = _load_dirs()
    if len(dirs) >= MAX_EXT_DIRS:
        return _bad("too many folders registered (max %d)" % MAX_EXT_DIRS, 409)
    entry = {"id": _dir_id_for(p),
             "name": (body.get("name") or os.path.basename(p) or p)[:MAX_EXT_NAME_CHARS],
             "path": p, "added": int(time.time())}
    dirs.append(entry)
    if not _save_dirs(dirs):
        return _bad("the registry file could not be written (permissions?)", 500)
    return web.json_response({"ok": True, "dir": _dir_row(entry)})


@PromptServer.instance.routes.post("/settings_hub/workflows/ext/dirs/{dir_id}")
async def ext_dirs_rename(request):
    """Rename the DISPLAY name of a registered folder (the real folder and
    its files are never touched)."""
    d = _find_dir_by_id(request.match_info.get("dir_id"))
    if not d:
        return _bad("no such folder", 404)
    try:
        body = await request.json()
    except Exception:
        return _bad("bad json")
    name = body.get("name") if isinstance(body, dict) else None
    if not isinstance(name, str) or not name.strip():
        return _bad("name is required")
    d["name"] = name.strip()[:MAX_EXT_NAME_CHARS]
    if not _save_dirs(_load_dirs()):
        return _bad("the registry file could not be written", 500)
    return web.json_response({"ok": True, "dir": _dir_row(d)})


@PromptServer.instance.routes.delete("/settings_hub/workflows/ext/dirs/{dir_id}")
async def ext_dirs_remove(request):
    """Detach a folder. The files on disk are NEVER touched (the answer says
    so explicitly). The detached namespace's index rows are pruned by the
    next scan."""
    d = _find_dir_by_id(request.match_info.get("dir_id"))
    if not d:
        return _bad("no such folder", 404)
    dirs = [x for x in _load_dirs() if x["id"] != d["id"]]
    if not _save_dirs(dirs):
        return _bad("the registry file could not be written", 500)
    return web.json_response({"ok": True, "removed": d["id"],
                              "note": "the files on the disk stay untouched"})


@PromptServer.instance.routes.get("/settings_hub/workflows/ext/browse")
async def ext_browse(request):
    """The folder picker's backend: list the immediate SUBDIRECTORIES of an
    absolute path. `path` empty/absent answers the ROOTS (the Windows drives
    that exist / '/' on POSIX) - 'other disks' are reachable in two clicks.
    Bounded, directories only."""
    p = request.query.get("path", "").strip()
    try:
        if not p:
            roots = []
            if os.name == "nt":
                for ch in string.ascii_uppercase:
                    drv = ch + ":\\"
                    if os.path.exists(drv):
                        roots.append(drv)
                if not roots:
                    roots = ["C:\\"]
            else:
                roots = [os.sep]
            return web.json_response({"ok": True, "roots": True,
                                      "current": "", "parent": None,
                                      "dirs": [], "roots_list": roots})
        if len(p) > MAX_EXT_PATH_CHARS:
            return _bad("path is too long")
        if not os.path.isabs(p):
            return _bad("not an absolute path")
        p = os.path.normpath(p)
        if not os.path.isdir(p):
            return _bad("the folder does not exist")
        dirs = []
        try:
            with os.scandir(p) as it:
                for e in it:
                    if e.is_dir():
                        dirs.append(e.name)
                        if len(dirs) >= MAX_EXT_BROWSE_ENTRIES:
                            break
        except OSError as e:
            return _bad("the folder cannot be read: " + str(e)[:120])
        dirs.sort(key=str.lower)
        parent = os.path.dirname(p) or None
        if parent and os.path.normcase(parent) == os.path.normcase(p):
            parent = None   # a drive root's dirname is itself - stop there
        return web.json_response({"ok": True, "roots": False,
                                  "current": p, "parent": parent,
                                  "dirs": dirs[:MAX_EXT_BROWSE_ENTRIES]})
    except Exception as e:
        return _bad(str(e)[:200], 500)


@PromptServer.instance.routes.get("/settings_hub/workflows/ext/list")
async def ext_list(request):
    """One folder's .json files as virtual-path rows (`dir=<id>`), or EVERY
    registered folder in ONE answer (`all=1` - the frontend store-sync
    listing merge reads this; the items carry the full virtual paths)."""
    if request.query.get("all") == "1":
        files, truncated = list_all_ext_files()
        return web.json_response({"ok": True, "files": files,
                                  "truncated": truncated})
    d = _find_dir_by_id(request.query.get("dir", ""))
    if not d:
        return _bad("no such folder", 404)
    files, truncated = list_dir_files(d)
    return web.json_response({"ok": True, "dir": _dir_row(d),
                              "files": files, "truncated": truncated})


# ---------------------------------------------------------------------------
# The /userdata-mirror routes - the frontend fetchApi hook re-points the
# virtual-namespace requests HERE. The response contracts match the native
# ones (post_userdata / getuserdata / move_userdata / delete_userdata), so
# the frontend UserFile/ComfyWorkflow code paths run unmodified and the tab
# state stays consistent (the paths it knows are virtual; the bytes live at
# the real location).
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/settings_hub/workflows/ext/read")
async def ext_read(request):
    """GET /userdata/<virtual> equivalent: the REAL file's bytes. 404 keeps
    the native meaning ('the file is gone' - the frontend handles it)."""
    phys, _d, err = resolve_ext(request.query.get("path", ""))
    if not phys:
        return _bad(err, 404 if "not registered" in str(err) else 400)
    if not os.path.isfile(phys):
        return web.json_response({"ok": False, "error": "no such file"},
                                 status=404)
    return web.FileResponse(phys, headers={
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
    })


@PromptServer.instance.routes.post("/settings_hub/workflows/ext/store")
async def ext_store(request):
    """POST /userdata/<virtual>?overwrite=&full_info= equivalent: write the
    REAL file (atomic tmp + os.replace - the native write pattern). The
    response mirrors post_userdata exactly:
      409 when overwrite=false and the file exists;
      400 on an OSError (the native 'invalid filename' shape);
      200 -> full_info ? {path, size, modified, created} : the rel path.
    The reported `path` stays VIRTUAL (the frontend state keeps pointing at
    the virtual namespace)."""
    phys, d, rel = resolve_ext(request.query.get("path", ""))
    if not phys:
        return _bad(str(rel))
    overwrite = request.query.get("overwrite", "true") != "false"
    full_info = request.query.get("full_info", "false").lower() == "true"
    if not overwrite and os.path.exists(phys):
        return web.Response(status=409, text="File already exists")
    body = await request.read()
    if len(body) > MAX_EXT_WRITE_BYTES:
        return web.Response(status=400, text="the workflow file is too large")
    try:
        os.makedirs(os.path.dirname(phys), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(phys))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, phys)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        return web.Response(status=400, reason="Invalid filename. Please avoid "
                            "special characters like :\\/*?\"<>|",
                            text=str(e)[:200])
    vpath = virtual_path(d, rel)
    _index_refresh_quiet([vpath])
    if full_info:
        return web.json_response(_full_info_for(phys, d, rel))
    return web.json_response(vpath)


def _full_info_for(phys, d, rel):
    """The native get_file_info shape with the VIRTUAL path reported."""
    st = os.stat(phys)
    return {
        "path": virtual_path(d, rel),
        "size": int(st.st_size),
        "modified": int(st.st_mtime * 1000),
        "created": int(getattr(st, "st_ctime", st.st_mtime) * 1000),
    }


@PromptServer.instance.routes.post("/settings_hub/workflows/ext/move")
async def ext_move(request):
    """POST /userdata/<src>/move/<dest> equivalent: rename/move the REAL
    file. The destination must stay in the virtual namespace - a rename in
    the ComfyUI UI moves the real file inside the registered folders (across
    folders/disks shutil.move copies then deletes). A destination outside
    the virtual namespace is refused: the native rename dialog must never
    silently export a file into the userdata tree."""
    src = request.query.get("path", "")
    dst = request.query.get("to", "")
    overwrite = request.query.get("overwrite", "true") != "false"
    full_info = request.query.get("full_info", "false").lower() == "true"
    phys, _d, err = resolve_ext(src, check_exists=True)
    if not phys:
        return web.Response(status=404, text=str(err)[:200])
    dphys, dd, drel = resolve_ext(dst)
    if not dphys:
        return _bad(str(drel))
    if os.path.normcase(os.path.abspath(dphys)) == os.path.normcase(
            os.path.abspath(phys)):
        return web.json_response(virtual_path(dd, drel))
    if not overwrite and os.path.exists(dphys):
        return web.Response(status=409, text="File already exists")
    try:
        os.makedirs(os.path.dirname(dphys), exist_ok=True)
        shutil.move(phys, dphys)
    except (OSError, shutil.Error) as e:
        return web.Response(status=400, text=str(e)[:200])
    if full_info:
        return web.json_response(_full_info_for(dphys, dd, drel))
    return web.json_response(virtual_path(dd, drel))


@PromptServer.instance.routes.delete("/settings_hub/workflows/ext/delete")
async def ext_delete(request):
    """DELETE /userdata/<virtual> equivalent: delete the REAL file. 204/404
    keep the native meaning."""
    phys, _d, err = resolve_ext(request.query.get("path", ""),
                                check_exists=True)
    if not phys:
        return web.Response(status=404, text=str(err)[:200])
    try:
        os.remove(phys)
    except OSError as e:
        return web.Response(status=400, text=str(e)[:200])
    return web.Response(status=204)


def _index_refresh_quiet(paths):
    """v129: the point re-index of the freshly written files - the Files
    search/groups see the new save without waiting for a full scan.
    Best-effort: the index is a sibling module of the same pack; an old or
    partial install (and a busy/locked DB) silently degrade to the next
    full Refresh - the write route itself never fails because of it."""
    try:
        try:
            from . import workflows_index as _wi
        except Exception:
            import workflows_index as _wi  # type: ignore
        if not hasattr(_wi, "refresh_paths"):
            return
        _wi.refresh_paths(rel_paths=list(paths),
                          path_map=ext_refresh_map(list(paths)))
    except Exception:
        pass


@PromptServer.instance.routes.get("/settings_hub/workflows/ext/subdirs")
async def ext_subdirs(request):
    """v129: EVERY relative subfolder of one registered folder for the
    save/rename pickers. v131 (the owner's ask - the empty folders are
    noise): a folder shows only when its SUBTREE holds at least one usable
    file (OS junk like .DS_Store does not count) - a truly empty branch and
    its dead intermediate dirs never reach the chips or the search. The
    same bounded-walk style as the folder picker: a huge external tree
    cannot stall the server, the answer caps at MAX_EXT_SUBDIRS with an
    honest `truncated` flag."""
    d = _find_dir_by_id(request.query.get("dir", ""))
    if d is None:
        return _bad("no such registered folder", 404)
    root = d["path"]
    out = []
    if os.path.isdir(root):
        try:
            file_dirs, all_dirs = set(), []
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                if any(f.lower() not in _SUBDIR_JUNK_FILES for f in filenames):
                    try:
                        file_dirs.add(os.path.relpath(
                            dirpath, root).replace(os.sep, "/"))
                    except Exception:
                        pass
                for dn in dirnames:
                    try:
                        all_dirs.append(os.path.relpath(
                            os.path.join(dirpath, dn),
                            root).replace(os.sep, "/"))
                    except Exception:
                        continue
                if len(all_dirs) >= MAX_EXT_SUBDIRS:
                    break
            occupied = set(file_dirs)
            for rel in file_dirs:
                parts = rel.split("/")
                for i in range(1, len(parts) + 1):
                    occupied.add("/".join(parts[:i]))
            out = [rel for rel in all_dirs if rel in occupied]
        except OSError:
            pass
    out.sort()
    return web.json_response({"ok": True, "dir": _dir_row(d),
                              "dirs": out[:MAX_EXT_SUBDIRS],
                              "truncated": len(out) > MAX_EXT_SUBDIRS})
