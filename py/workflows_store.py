"""v101: server-side storage for the SettingsHub Workflows Manager.

The Workflows Manager (web/workflows.js) is a standalone utility over ALL the
open ComfyUI workflows (not bound to a SettingsHub node on the canvas). It
saves the set of open workflow tabs as a PRESET and re-applies a preset later
(Replace / Append) - the panel works entirely through the frontend
`app.extensionManager.workflow` adapter; the server only stores the presets.

Layout under the user directory (v104: ONE FILE PER PRESET - the owner's
call: tabs are many and temp snapshots are large, and a single file made
every transfer all-or-nothing):

    <user>/settings_hub/workflows/         - the storage root (re-pointable
        presets/<preset-id>.json            through the settings popup)
                                           - ONE file per preset: the FULL
        preset object below. Copying one presets/<id>.json into another
        machine's presets/ folder transfers exactly that preset (no
        export/import round-trip); the file is picked up on the next read.
        favorite-first / updated-desc ordering is applied on read; writes
        are atomic (tmp + os.replace) under an asyncio.Lock.

    {
      "id": "<uuid_hex_12>",
      "name": "Flux Inpaint",
      "created": 1763100000,
      "updated": 1763100000,
      "fav": false,
      "activePath": "workflows/flux_main.json",
      "items": [
        { "kind": "path",     "path": "workflows/flux_main.json",
          "name": "flux_main.json" },
        { "kind": "snapshot", "name": "Temp nodes", "graph": { ... } }
      ]
    }

A "path" item references a workflow FILE relative to the ComfyUI workflows/
user folder (multi-user safe: the frontend resolves it through the frontend
store or the native /userdata endpoint). A "snapshot" item embeds the graph
JSON of a TEMPORARY (unsaved) tab INSIDE the preset file itself (kept as
is, v104) - the snapshot travels with the preset it belongs to.

v107: the REOPEN snapshots of closed TEMP tabs (the 🕘 Recently-closed ring)
moved OUT of browser localStorage - the owner: "сам комфи и другие кастом
extensions тоже сильно раздувают буфер" (ComfyUI itself and the other
custom extensions bloat the same origin quota, so an embedded snapshot
could silently vanish). The ring keeps only the METADATA; every graph
payload lives server-side as temp/<id>.json in a RESERVED subfolder of the
active storage root (next to presets/, the same re-pointable root):

    temp/<temp-id>.json
    {
      "id": "<uuid_hex_12>",
      "name": "Unsaved Workflow (3)",
      "ts": 1763200000,
      "graph": { ... the workflow JSON as closed ... }
    }

The client uploads at close time, fetches on the 🕘 reopen and deletes when
the entry leaves the ring; a boot GC removes stale orphans (older than a
day, not referenced by this browser's ring - a conservative rule that
never touches a snapshot another browser may still point at). MAX_TEMP_FILES
keeps a root bounded even when a client never cleans up. An old py (no
temp routes) degrades the panel back to the v106 embedded-snapshot
behavior - the localStorage fallback stays wired.

Migration (one-time, automatic, on the first storage touch of a root): a
root that still holds the legacy v101-v103 single-file store gets its
presets.json array split into presets/<id>.json files, and the original is
renamed presets.json.bak (never deleted - the .bak is the owner's backup).
A per-preset file that already exists WINS over the legacy copy, so a rerun
after a partial migration never rolls the folder back. A file whose inner
"id" disagrees with its <name>.json is ignored on read (not served), and a
corrupt file skips itself instead of blanking the whole list.

v101 also ports the v84 CUSTOM STORAGE ROOT mechanics from py/stack_store.py
(the owner contract, AGENTS.md 5.1 rule 12): the root defaults to
<user>/settings_hub/workflows and the panel's own ⚙ popup ("Storage folder")
can re-point EVERY workflows route to any ABSOLUTE folder. The choice is
verified (the folder is created and probed writable BEFORE the switch) and
persisted SERVER-side in <user>/settings_hub/workflows_root.json - always in
the DEFAULT user dir, never inside the custom root, so a broken custom path
can never hide the way back. Routes:

    GET  /settings_hub/workflows/health -> {ok, version, dir, custom, default,
                                            writable, presets}
    GET  /settings_hub/workflows/root   -> {ok, root, custom, default,
                                            writable}
    POST /settings_hub/workflows/root   -> JSON {path: "D:\\gen\\wf" | ""}
                                           ("" / whitespace = back to the
                                           default; ~ is expanded, pasted
                                           quotes are stripped, RELATIVE
                                           paths are REFUSED)
    GET    /settings_hub/workflows/presets      -> {ok, presets: [...]}
    POST   /settings_hub/workflows/presets      -> {id?, name, items,
                                            activePath?, fav?,
                                            mode?: "create"|"overwrite"|
                                                   "merge"}
    PUT    /settings_hub/workflows/preset/{pid} -> {name?, fav?, items?,
                                            activePath?}
    DELETE /settings_hub/workflows/preset/{pid}
    POST   /settings_hub/workflows/import       -> one preset object OR
                                            {presets: [...], overwrite?}
    GET    /settings_hub/workflows/temp         -> {ok, items: [{id, name,
                                            ts}]} (v107, no graphs)
    POST   /settings_hub/workflows/temp         -> {name?, graph} - store one
                                            reopen snapshot (v107)
    GET    /settings_hub/workflows/temp/{tid}   -> {ok, id, name, ts, graph}
                                            (v107)
    DELETE /settings_hub/workflows/temp/{tid}   -> {ok, gone, existed}
                                            (v107)

v108 (the owner re-worked the root contract: "при переназначении пути
хранения обеспечить доступ к данным как из пользовательского, так и из
стандартного хранилища. Исключить дубликаты и не терять существующие данные.
Не смешивать пресеты с обычными workflow-файлами в Files") - UNIFIED
STORAGE VIEW: while a custom root is active, the READS cover BOTH roots
(the ACTIVE one first, then the DEFAULT one), so the presets/temp of the
default location stay reachable and nothing is ever lost on a switch;
an id present in BOTH roots resolves to the ACTIVE copy (duplicates are
excluded, not stacked). The WRITES go where the data already lives
(overwrite/merge/PUT/DELETE act on the copy the read served), only NEW
presets/temps land in the ACTIVE root - an update can never fork a second
copy into the other root. Nothing is moved, copied or deleted on the root
switch itself. The Files tab keeps its own housekeeping out of sight: the
new GET /settings_hub/workflows/files listing skips the storage-root
subtree (presets/, temp/) even when the root is re-pointed INSIDE the
workflows/ userdata folder - presets must never mix into the ordinary
workflow list. The File favorites live in the DEFAULT user dir (next to
workflows_root.json) - they tag the workflow FILES, not the storage
content, so a root switch cannot hide them. The override file always
stays in the DEFAULT user dir, so health/root answers carry `custom`
(the active custom root or null), `dir` (the EFFECTIVE root) and `userRel`
(the active root relative to the user dir, or null) next to `default`.

Safety: preset ids are strict hex (import may carry a wider legacy charset -
still path-safe, it IS the file name), item paths are relative-without-
traversal ONLY, names are control-stripped and capped, writes are size-
capped, every preset file is written atomically and every mutation takes an
asyncio.Lock (aiohttp handlers interleave on one event loop).
"""
import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import uuid

from server import PromptServer
from aiohttp import web

try:
    import folder_paths
except Exception:  # pragma: no cover - folder_paths always exists in ComfyUI
    folder_paths = None

# ---------------------------------------------------------------------------
# Limits (server-side absolute guards; the frontend may enforce smaller ones)
# ---------------------------------------------------------------------------

MAX_PRESETS = 200
MAX_ITEMS_PER_PRESET = 100
MAX_NAME_CHARS = 80
# The total serialized size of the snapshot GRAPHS inside one save body.
MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
MAX_PATH_CHARS = 300
MAX_ACTIVE_PATH_CHARS = MAX_PATH_CHARS
# v107: the temp-snapshot folder cap (a root must stay bounded even when a
# client never cleans its recently-closed evictions up - multi-browser).
MAX_TEMP_FILES = 40
# v112 (plan 3.1/3.6): the reserved WORKFLOWS-MANAGER service folder of the
# DEFAULT user dir - outside every workflows/ walk root and outside the
# re-pointable storage root: undo snapshots, recently-closed manifests and
# (from the later stages) the derived index + the shared history store live
# here. Nothing in this folder is ever user data - it is all rebuildable.
MGR_DIR_NAME = "workflows_manager"
# v112: undo snapshots TTL (the plan: "TTL и очистка Undo snapshots")
UNDO_MAX_AGE_S = 2 * 60 * 60          # 2 hours
UNDO_MAX_FILES = 60
# v112: recently-closed manifests are the SERVER-side ring metadata
# (plan 3.6): one manifest per browser session (client id), each entry
# references the temp/<id>.json snapshot files. A temp snapshot is
# deletable only when NO manifest references it and it is older than
# TEMP_MAX_AGE_S - one browser can never orphan another browser's reopen.
RECENT_MAX_CLIENTS = 50
RECENT_MAX_ENTRIES = 30
RECENT_MAX_AGE_S = 7 * 24 * 60 * 60   # stale client manifests GC after a week
TEMP_MAX_AGE_S = 24 * 60 * 60

_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
# v101: import/legacy ids may be wider - still a strict path-safe charset.
_ID_LOOSE_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

_lock = asyncio.Lock()
# v107: a monotonic write counter for the temp snapshots - the mtime
# tie-break is NOT reliable on every filesystem (overlayfs quantizes it),
# so same-second writes order by THIS counter instead (the MAX_TEMP_FILES
# eviction really drops the OLDEST writes, not the lucky-name ones)
_temp_seq = 0


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _user_dir():
    """The canonical ComfyUI user directory (default <ComfyUI>/user) via
    folder_paths.get_user_directory(); never hardcode a path."""
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


def _default_root():
    return os.path.join(_user_dir(), "settings_hub", "workflows")


# ---------------------------------------------------------------------------
# v101: custom storage root (the v84 mechanics of py/stack_store.py). The
# override lives in a small JSON file in the DEFAULT user dir (NOT inside the
# custom root - a broken custom path must never hide the way back) and is
# loaded once at import; every _workflows_root() call below honours it, so
# ALL routes switch together. Changing the root never moves presets - each
# location keeps its own presets/ folder (AGENTS.md 5.1 rule 12).
# ---------------------------------------------------------------------------

_ROOT_OVERRIDE_NAME = "workflows_root.json"
_root_custom = None  # str | None - normalized absolute custom root


def _root_override_path():
    return os.path.join(_user_dir(), "settings_hub", _ROOT_OVERRIDE_NAME)


def _load_root_override():
    """Boot-time read of the persisted override. A missing/corrupt file or a
    non-absolute value reads as "no override" - the default root stands and
    the routes never block on it."""
    global _root_custom
    try:
        with open(_root_override_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        p = data.get("custom") if isinstance(data, dict) else None
        if isinstance(p, str) and p and os.path.isabs(p):
            _root_custom = os.path.normpath(p)
            return _root_custom
    except Exception:
        pass
    _root_custom = None
    return None


def _save_root_override():
    """Persist (or clear) the override atomically. Best-effort: the caller
    reports `saved: false` when the file could not be written."""
    try:
        os.makedirs(os.path.dirname(_root_override_path()), exist_ok=True)
        tmp = _root_override_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"custom": _root_custom, "saved": int(time.time())}, f)
        os.replace(tmp, _root_override_path())
        return True
    except Exception:
        return False


def _clean_root_candidate(raw):
    """Validate a candidate root from the settings UI. Whitespace and pasted
    surrounding quotes are stripped, ~ is expanded, the result MUST be an
    ABSOLUTE path (a relative path would silently depend on the server's
    cwd). Returns (path, None) with path == "" meaning "back to the default",
    or (None, error)."""
    if raw is None:
        return "", None
    if not isinstance(raw, str):
        return None, "path must be a string"
    p = raw.strip()
    while p[:1] in ('"', "'") and p.endswith(p[0]):
        p = p[1:-1].strip()
    if not p:
        return "", None
    try:
        p = os.path.expanduser(p)
    except Exception:
        pass
    if not os.path.isabs(p):
        return None, "not an absolute path: " + p
    return os.path.normpath(p), None


def _probe_writable(root):
    """True when <root> can be created and a probe file written+deleted there
    (the same check health performs on the effective root)."""
    try:
        os.makedirs(root, exist_ok=True)
        probe = os.path.join(root, ".root_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.unlink(probe)
        return True
    except Exception:
        return False


def _workflows_root():
    """v101: the ACTIVE storage root - <user-dir>/settings_hub/workflows by
    default or the custom absolute root from the settings UI."""
    return _root_custom or _default_root()


_load_root_override()


_LEGACY_NAME = "presets.json"
_PRESETS_DIR_NAME = "presets"
_TEMP_DIR_NAME = "temp"  # v107: the reopen snapshots of TEMP tabs


def _legacy_presets_path(root=None):
    """The v101-v103 single-file store of a root (the ACTIVE one by
    default) - only ever read by the one-time migration; after it the name
    lives on as .bak."""
    return os.path.join(root or _workflows_root(), _LEGACY_NAME)


def _presets_dir():
    """The per-preset folder of the ACTIVE root (v104 layout)."""
    return os.path.join(_workflows_root(), _PRESETS_DIR_NAME)


def _preset_file(pid):
    """The per-preset file of the ACTIVE root. `pid` is ALWAYS matched
    against _ID_LOOSE_RE before this is used as a path (a strict path-safe
    charset: [A-Za-z0-9_-]{4,64}), so the file name cannot traverse."""
    return os.path.join(_presets_dir(), pid + ".json")


def _preset_file_in(root, pid):
    """The per-preset file inside an EXPLICIT root (the unified view)."""
    return os.path.join(root, _PRESETS_DIR_NAME, pid + ".json")


def _find_preset_file(pid):
    """The preset file of the root that OWNS the pid: the ACTIVE root first,
    then the DEFAULT root when a custom one is active (v108 unified view).
    Writes reuse this location so an update never forks a second copy into
    the other root ('исключить дубликаты'). None when the pid lives nowhere."""
    if not isinstance(pid, str) or not _ID_LOOSE_RE.match(pid):
        return None
    for root in _roots_all():
        f = _preset_file_in(root, pid)
        if os.path.isfile(f):
            return f
    return None


def _temp_dir():
    """v107: the RESERVED temp-snapshot folder of the ACTIVE root - sits
    next to presets/ and follows the same re-pointable storage root."""
    return os.path.join(_workflows_root(), _TEMP_DIR_NAME)


def _temp_file(tid):
    """temp/<id>.json - `tid` is ALWAYS matched against _ID_RE (strict hex,
    server-generated) before this is used as a path, so the file name cannot
    traverse."""
    return os.path.join(_temp_dir(), tid + ".json")


def _temp_file_in(root, tid):
    """temp/<id>.json inside an EXPLICIT root (v108 unified view)."""
    return os.path.join(root, _TEMP_DIR_NAME, tid + ".json")


def _find_temp_file(tid):
    """The temp snapshot file of the root that OWNS the tid (active first,
    then the default root while a custom one is active) - a snapshot taken
    BEFORE a root switch stays reopenable after it (no data loss)."""
    if not isinstance(tid, str) or not _ID_RE.match(tid):
        return None
    for root in _roots_all():
        f = _temp_file_in(root, tid)
        if os.path.isfile(f):
            return f
    return None


def _ensure_dir(path):
    """Create ONE directory (best-effort)."""
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass


def _ensure_dirs():
    _ensure_dir(_presets_dir())
    _ensure_dir(_temp_dir())  # v107: the temp snapshots


# ---------------------------------------------------------------------------
# v112: the WORKFLOWS-MANAGER service folder of the DEFAULT user dir -
# <user>/settings_hub/workflows_manager/. NEVER inside the re-pointable
# storage root and NEVER under a workflows/ walk root (the Files listing
# cannot see it), so a broken custom root or a huge library never touches
# the manager's own bookkeeping. Subfolders:
#   undo/<id>.json     - plan 3.1: full pre-apply workspace snapshots (TTL)
#   recent/<cid>.json  - plan 3.6: server-side recently-closed ring metadata
#                        per browser session; temp snapshots keep REFERENCES
#                        here, so one browser can never orphan another's
#                        reopen payload
#   temp/              - (later stages) transaction safety snapshots
#   catalog/, index/   - (later stages) durable manifests + SQLite index
# Everything here is DERIVED/service data: deleting the folder must never
# lose a workflow JSON or a preset.
# ---------------------------------------------------------------------------

def _mgr_dir(*parts):
    return os.path.join(_user_dir(), "settings_hub", MGR_DIR_NAME, *parts)


def _ensure_mgr_dirs():
    _ensure_dir(_mgr_dir("undo"))
    _ensure_dir(_mgr_dir("recent"))


def _mgr_write_json(folder, fid, obj):
    """Atomic write of ONE service JSON file (tmp + fsync + os.replace)."""
    _ensure_dir(folder)
    f = os.path.join(folder, fid + ".json")
    tmp = f + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, f)
        return True
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def _mgr_read_json(folder, fid):
    f = os.path.join(folder, fid + ".json")
    try:
        with open(f, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _mgr_delete(folder, fid):
    try:
        os.unlink(os.path.join(folder, fid + ".json"))
        return True
    except OSError:
        return False


def _mgr_list(folder):
    """Sorted *.json ids of ONE manager service folder (no parsing)."""
    try:
        return [n[:-len(".json")] for n in sorted(os.listdir(folder))
                if n.endswith(".json")]
    except OSError:
        return []


def _undo_gc_locked():
    """TTL + count GC over the undo snapshots (plan 3.1). Runs under the
    module lock; every record older than UNDO_MAX_AGE_S dies, then the
    newest beyond UNDO_MAX_FILES are dropped. The ids the CLIENT still
    holds are irrelevant here - a client whose undoId was GC'd just gets
    'Nothing to undo' (the snapshot is a bounded best-effort service)."""
    now = int(time.time())
    items = []
    for fid in _mgr_list(_mgr_dir("undo")):
        rec = _mgr_read_json(_mgr_dir("undo"), fid)
        if rec is None:
            _mgr_delete(_mgr_dir("undo"), fid)  # corrupt = dead weight
            continue
        items.append({"id": fid, "ts": int(rec.get("ts", 0) or 0)})
    items.sort(key=lambda it: -it["ts"])
    for it in items:
        if now - it["ts"] > UNDO_MAX_AGE_S:
            _mgr_delete(_mgr_dir("undo"), it["id"])
    for it in [x for x in items if now - x["ts"] <= UNDO_MAX_AGE_S][UNDO_MAX_FILES:]:
        _mgr_delete(_mgr_dir("undo"), it["id"])


def _recent_refs():
    """Every tempId currently referenced by ANY browser manifest (plan 3.6
    reference accounting: the deletion of a temp snapshot is decided by the
    UNION of the manifests, never by one browser's ring)."""
    refs = set()
    for cid in _mgr_list(_mgr_dir("recent")):
        rec = _mgr_read_json(_mgr_dir("recent"), cid)
        if not isinstance(rec, dict):
            continue
        for ent in rec.get("entries") or []:
            tid = ent.get("tempId") if isinstance(ent, dict) else None
            if isinstance(tid, str) and tid:
                refs.add(tid)
    return refs


def _recent_gc_locked():
    """GC of stale browser manifests (a client that never came back)."""
    now = int(time.time())
    for cid in _mgr_list(_mgr_dir("recent")):
        rec = _mgr_read_json(_mgr_dir("recent"), cid)
        if rec is None:
            _mgr_delete(_mgr_dir("recent"), cid)
            continue
        if now - int(rec.get("updatedAt", 0) or 0) > RECENT_MAX_AGE_S:
            _mgr_delete(_mgr_dir("recent"), cid)


# ---------------------------------------------------------------------------
# v108 UNIFIED STORAGE VIEW - the roots a read covers. While a custom root
# is active, the DEFAULT root stays a readable member (the owner: access to
# the data from BOTH the user and the standard storage, no duplicates, no
# data loss). The ACTIVE root always comes FIRST - it wins every id clash
# and it is where new files are created.
# ---------------------------------------------------------------------------

def _roots_all():
    """The read set of storage roots: [active] + [default] when a custom
    root is active (deduped - the default is skipped when it IS active)."""
    roots = [_workflows_root()]
    d = _default_root()
    if _root_custom and d != _workflows_root():
        roots.append(d)
    return roots


def _root_rel_to_user():
    """The ACTIVE storage root relative to the ComfyUI user dir (None when
    it lies outside) - the client keeps this subtree out of the userdata
    file listings, so the presets/temp housekeeping can never mix into the
    Files tab even when the root is re-pointed inside the workflows folder."""
    try:
        rel = os.path.relpath(_workflows_root(), _user_dir())
    except Exception:
        return None
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    return rel.replace(os.sep, "/")


# ---------------------------------------------------------------------------
# v104 per-preset storage (ONE file per preset) + the one-time migration of
# the legacy presets.json array. Every write is atomic (tmp + os.replace);
# every mutation runs under the module asyncio.Lock.
# ---------------------------------------------------------------------------

def _migrate_legacy_file(root=None):
    """Split a legacy presets.json array into per-preset files (idempotent):
    a per-preset file that already exists WINS over the legacy copy, so a
    rerun after a partial migration never rolls the folder back. The original
    is renamed presets.json.bak (never deleted - the .bak is the owner's
    backup). Any failure leaves the legacy file in place and the next read
    retries - the routes never break on migration. v108: runs for EVERY
    readable root (the active one and, while a custom root is switched on,
    the default one too - the old location must stay alive and readable)."""
    root = root or _workflows_root()
    legacy = _legacy_presets_path(root)
    if not os.path.isfile(legacy):
        return
    try:
        with open(legacy, "r", encoding="utf-8") as f:
            data = json.load(f)
        legacy_list = data if isinstance(data, list) else []
    except Exception:
        legacy_list = []  # a corrupt legacy file has nothing to split
    _ensure_dir(os.path.join(root, _PRESETS_DIR_NAME))
    for p in legacy_list:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not isinstance(pid, str) or not _ID_LOOSE_RE.match(pid):
            # a hand-edited legacy id -> a fresh safe file name, data kept
            pid = uuid.uuid4().hex[:12]
            while os.path.exists(_preset_file_in(root, pid)):
                pid = uuid.uuid4().hex[:12]
            p["id"] = pid
        if os.path.exists(_preset_file_in(root, pid)):
            continue  # the folder copy wins
        try:
            _write_preset_file_in(root, p)  # stay in THIS root, never fork
        except Exception:
            return
    try:
        os.replace(legacy, legacy + ".bak")
    except OSError:
        pass  # a locked file must not break the routes; the next read retries


def _read_presets():
    """All the presets VISIBLE to the panel (v108 unified storage view): the
    ACTIVE root first, then the DEFAULT root while a custom one is active -
    the old location stays readable after a root switch, no data is ever
    hidden by the re-point. An id present in BOTH roots resolves to the
    ACTIVE copy (duplicates are excluded, not stacked). Well-formed files
    only: a dict whose inner id agrees with the file name - a disagreeing
    file is ignored, not served; a corrupt file skips itself and can never
    blank the whole list."""
    for root in _roots_all():
        _migrate_legacy_file(root)
    out = {}
    for root in _roots_all():
        pdir = os.path.join(root, _PRESETS_DIR_NAME)
        try:
            names = sorted(os.listdir(pdir))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(pdir, name), "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            if (isinstance(data, dict) and isinstance(data.get("id"), str)
                    and data["id"] == name[:-len(".json")]):
                out.setdefault(data["id"], data)  # the FIRST root wins (active)
    return list(out.values())


def _count_preset_files():
    """Cheap MAX_PRESETS guard: the per-preset files of the ACTIVE root (no
    parsing) - new presets are created here, so THIS folder is the one the
    cap bounds."""
    try:
        return len([n for n in os.listdir(_presets_dir()) if n.endswith(".json")])
    except OSError:
        return 0


def _count_visible_presets():
    """v108: the number of DISTINCT preset ids across every readable root
    (the health probe reports what the panel can actually see, not just the
    write-target folder)."""
    seen = set()
    for root in _roots_all():
        try:
            names = os.listdir(os.path.join(root, _PRESETS_DIR_NAME))
        except OSError:
            continue
        for n in names:
            if n.endswith(".json"):
                seen.add(n[:-len(".json")])
    return len(seen)


def _load_preset_file(pid):
    """Parse ONE per-preset file (None when missing/corrupt/id-disagreeing).
    v108: the lookup covers every readable root (active first). The id is
    re-validated here - every addressing path funnels through this check,
    so a pid from the wire can never reach the filesystem unchecked."""
    if not isinstance(pid, str) or not _ID_LOOSE_RE.match(pid):
        return None
    f = _find_preset_file(pid)
    if not f:
        return None
    try:
        with open(f, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    if isinstance(data, dict) and data.get("id") == pid:
        return data
    return None


def _write_preset_file_in(root, p):
    """Atomic write of ONE preset file into an EXPLICIT root (tmp +
    os.replace) - the migration and the root-aware write path."""
    _ensure_dir(os.path.join(root, _PRESETS_DIR_NAME))
    f = _preset_file_in(root, p["id"])
    tmp = f + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(p, fh, ensure_ascii=False)
    os.replace(tmp, f)


def _write_preset_file(p):
    """Atomic write of ONE preset file (tmp + os.replace). v108: the file
    lands WHERE THE PID ALREADY LIVES (active root first, default fallback)
    so an overwrite/merge/PUT never forks a duplicate into the other root;
    a NEW id is written into the ACTIVE root."""
    home = _find_preset_file(p["id"])
    if home:
        _ensure_dir(os.path.dirname(home))
        f = home
    else:
        _ensure_dirs()
        f = _preset_file(p["id"])
    tmp = f + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(p, fh, ensure_ascii=False)
    os.replace(tmp, f)


def _delete_preset_file(pid):
    """Delete the preset WHERE IT LIVES (active root first, then the default
    root - the unified view)."""
    f = _find_preset_file(pid)
    if not f:
        return False
    try:
        os.unlink(f)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# v107: temp-snapshot files - the reopen payloads of closed TEMP tabs.
# The recently-closed ring in the browser keeps only the metadata; every
# graph lives here as temp/<id>.json (uploaded at close, fetched on the
# 🕘 reopen, deleted when the entry leaves the ring / the boot GC drops a
# stale orphan). Writes are atomic like the preset files.
# ---------------------------------------------------------------------------

def _write_temp_file(obj):
    """Atomic write of ONE temp snapshot file (tmp + os.replace)."""
    try:
        os.makedirs(_temp_dir(), exist_ok=True)
    except Exception:
        return False
    f = _temp_file(obj["id"])
    tmp = f + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
        os.replace(tmp, f)
        return True
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def _read_temp_file(tid):
    """Parse ONE temp snapshot (None when missing/corrupt/id-disagreeing).
    v108: the lookup covers every readable root (active first). The id is
    re-validated here - a wire value can never reach the filesystem
    unchecked."""
    f = _find_temp_file(tid)
    if not f:
        return None
    try:
        with open(f, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    if isinstance(data, dict) and data.get("id") == tid:
        return data
    return None


def _delete_temp_file(tid):
    """Delete the snapshot from EVERY root that holds it (an id cannot
    legitimately exist twice, but a root switch must never leave a stale
    copy behind - 'не терять существующие данные' cuts both ways)."""
    existed = False
    if not isinstance(tid, str) or not _ID_RE.match(tid):
        return False
    for root in _roots_all():
        try:
            os.unlink(_temp_file_in(root, tid))
            existed = True
        except OSError:
            pass
    return existed


def _list_temp_files():
    """[{id, name, ts}] of every temp snapshot VISIBLE to the panel (v108:
    the ACTIVE root first, then the default one while a custom root is
    active; an id in both roots resolves to the active copy) - newest first,
    NO graphs (the list feeds the client boot GC and diagnostics; the
    payloads are fetched one-by-one). Ties on ts (a burst of closes inside
    one second) break by the monotonic write counter (seq) - the filesystem
    mtime proved non-monotonic under overlayfs."""
    out = {}
    for root in _roots_all():
        tdir = os.path.join(root, _TEMP_DIR_NAME)
        try:
            names = sorted(os.listdir(tdir))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".json"):
                continue
            tid = name[:-len(".json")]
            if not _ID_RE.match(tid):
                continue
            if tid in out:
                continue  # the ACTIVE root's copy already won
            it = _read_temp_file(tid)
            if it is None:
                continue
            out[tid] = {"id": tid, "name": it.get("name") or "",
                        "ts": int(it.get("ts", 0) or 0),
                        "_s": int(it.get("seq", 0) or 0)}
    items = sorted(out.values(), key=lambda it: (-it["ts"], -it["_s"]))
    for it in items:
        it.pop("_s", None)
    return items


def _count_temp_files():
    """Cheap temp counter for /health (no parsing, every readable root)."""
    n = 0
    for root in _roots_all():
        try:
            n += len([x for x in os.listdir(os.path.join(root, _TEMP_DIR_NAME))
                      if x.endswith(".json")])
        except OSError:
            pass
    return n


def _evict_temp_files():
    """Keep every folder bounded: the OLDEST temp snapshots beyond
    MAX_TEMP_FILES are deleted PER ROOT (newest-by-ts win; the default root
    is evicted in its own right so a switch cannot let it grow forever).
    Best effort - a locked file skips itself. Runs after every PUT."""
    for root in _roots_all():
        tdir = os.path.join(root, _TEMP_DIR_NAME)
        try:
            names = sorted(os.listdir(tdir))
        except OSError:
            continue
        items = []
        for name in names:
            if not name.endswith(".json"):
                continue
            tid = name[:-len(".json")]
            it = _read_temp_file(tid)
            if it is not None:
                items.append({"id": tid,
                              "ts": int(it.get("ts", 0) or 0),
                              "seq": int(it.get("seq", 0) or 0)})
        items.sort(key=lambda it: (-it["ts"], -it["seq"]))
        for it in items[MAX_TEMP_FILES:]:
            try:
                os.unlink(_temp_file_in(root, it["id"]))
            except OSError:
                pass


# ---------------------------------------------------------------------------
# v112 stage 4 (plan 10): the PRESET VERSION HISTORY - immutable sidecar
# revisions in <the preset's own root>/preset_versions/<pid>/<rid>.json.
# Before every meaningful change (overwrite/merge/PUT/import-overwrite) the
# CURRENT preset archives itself; a restore archives the current first
# (the rollback is always possible). No revision when nothing changed.
# Limits: MAX_PRESET_VERSIONS per preset, the oldest trimmed - the CURRENT
# version is never touched by the trim.
# ---------------------------------------------------------------------------

_PRESET_VERSIONS_DIR = "preset_versions"
MAX_PRESET_VERSIONS = 20
_version_seq = 0    # the monotonic write counter - the same-second tie-break

_PRESET_SIGNIFICANT_FIELDS = ("name", "items", "activePath", "activeItemId",
                              "category", "tags", "fav")


def _versions_dir_for(pid, home=None):
    """The versions folder in the SAME root the preset lives in (the plan:
    the history follows the preset's root; the unified view reads both)."""
    f = home or _find_preset_file(pid)
    if not f:
        return None
    root = os.path.dirname(os.path.dirname(os.path.abspath(f)))
    return os.path.join(root, _PRESET_VERSIONS_DIR, pid)


def _preset_significant_copy(p):
    """The fields whose change creates a revision. The itemId stamps are
    NOT semantic (every sanitize assigns fresh ids to wire items) - they
    are stripped before the comparison, the CONTENT decides."""
    out = {}
    for k in _PRESET_SIGNIFICANT_FIELDS:
        if k in p:
            v = p[k]
            if k == "items" and isinstance(v, list):
                v = [{key: it[key] for key in it if key != "itemId"}
                     if isinstance(it, dict) else it for it in v]
            out[k] = v
    return out


def preset_versions_changed(old, new):
    """True when a MEANINGFUL field differs (plan 10: no revision when the
    content is semantically the same). The items comparison uses the
    canonical JSON - the key order of the wire payload must not create
    phantom revisions."""
    a, b = _preset_significant_copy(old or {}), _preset_significant_copy(new or {})
    if set(a.keys()) != set(b.keys()):
        return True
    for k in a:
        if k == "items":
            try:
                if json.dumps(a[k], sort_keys=True, ensure_ascii=False) != \
                        json.dumps(b[k], sort_keys=True, ensure_ascii=False):
                    return True
            except (TypeError, ValueError):
                return True
        else:
            if a[k] != b[k]:
                return True
    return False


def _archive_preset_version(pid, changed_by):
    """Snapshot the CURRENT preset into preset_versions/<pid>/<rid>.json.
    Returns (rid, None) or (None, error). Never touches the current file."""
    cur = _load_preset_file(pid)
    if cur is None:
        return None, "no such preset"
    vdir = _versions_dir_for(pid)
    if not vdir:
        return None, "no versions dir"
    global _version_seq
    _version_seq += 1
    rid = uuid.uuid4().hex[:16]
    rec = {
        "revisionId": rid,
        "presetId": pid,
        "createdAt": int(time.time()),
        "seq": _version_seq,         # the monotonic tie-break (same-second)
        "changedBy": changed_by,     # overwrite | merge | put | import | restore
        "preset": cur,               # the FULL previous preset object
    }
    try:
        _ensure_dir(vdir)
        f = os.path.join(vdir, rid + ".json")
        tmp = f + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, f)
    except Exception as e:
        return None, str(e)[:200]
    _prune_preset_versions(pid)
    return rid, None


def _prune_preset_versions(pid):
    """The retention cap: the OLDEST revisions beyond MAX_PRESET_VERSIONS
    die; the current version is NOT a revision file and is never touched."""
    vdir = _versions_dir_for(pid)
    if not vdir:
        return
    try:
        ids = sorted(n[:-len(".json")] for n in os.listdir(vdir)
                     if n.endswith(".json"))
    except OSError:
        return
    recs = []
    for rid in ids:
        rec = _mgr_read_json(vdir, rid)
        if rec:
            recs.append((rid, int(rec.get("createdAt", 0) or 0), rec.get("revisionId") == rid))
    recs.sort(key=lambda x: -x[1])
    for rid, _ts, _ok in recs[MAX_PRESET_VERSIONS:]:
        try:
            os.unlink(os.path.join(vdir, rid + ".json"))
        except OSError:
            pass


def _list_preset_versions(pid):
    """The revision METADATA list (newest first) - NO graph payloads (the
    plan: the list answers metadata; the payload loads for restore/compare
    only)."""
    vdir = _versions_dir_for(pid)
    out = []
    if not vdir:
        return out
    try:
        ids = sorted(n[:-len(".json")] for n in os.listdir(vdir)
                     if n.endswith(".json"))
    except OSError:
        return out
    for rid in ids:
        rec = _mgr_read_json(vdir, rid)
        if not rec or rec.get("presetId") != pid:
            continue
        prev = rec.get("preset") or {}
        snap_bytes = 0
        try:
            for it in prev.get("items") or []:
                if isinstance(it, dict) and it.get("kind") == "snapshot":
                    snap_bytes += len(json.dumps(it.get("graph"), ensure_ascii=False))
        except (TypeError, ValueError):
            snap_bytes = -1
        out.append({
            "revisionId": rid,
            "createdAt": rec.get("createdAt"),
            "seq": int(rec.get("seq", 0) or 0),
            "changedBy": rec.get("changedBy"),
            "name": prev.get("name"),
            "category": prev.get("category"),
            "tags": prev.get("tags") or [],
            "itemCount": len(prev.get("items") or []),
            "fav": bool(prev.get("fav")),
            "snapshotBytes": snap_bytes,
        })
    out.sort(key=lambda v: (-(v.get("createdAt") or 0), -v.get("seq", 0)))
    return out


def _read_preset_version(pid, rid):
    vdir = _versions_dir_for(pid)
    if not vdir or not isinstance(rid, str) or not _ID_RE.match(rid):
        return None
    rec = _mgr_read_json(vdir, rid)
    if rec and rec.get("presetId") == pid:
        return rec
    return None


def _delete_preset_versions(pid):
    """The preset deletion takes its history with it (an explicit armed
    confirm already guarded the UI) - no orphans without a UI."""
    vdir = _versions_dir_for(pid)
    if not vdir:
        return
    shutil.rmtree(vdir, ignore_errors=True)


def _sorted_presets(presets):
    """GET order: favorites first, then the most recently updated."""
    return sorted(presets, key=lambda p: (0 if p.get("fav") else 1,
                                          -int(p.get("updated", 0) or 0)))


# ---------------------------------------------------------------------------
# Sanitizers
# ---------------------------------------------------------------------------

def _sanitize_name(raw):
    """A display name for a preset / a snapshot item (never a path): control
    characters stripped, trimmed, capped. Empty input -> None."""
    if not isinstance(raw, str):
        return None
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", raw).strip()
    if not cleaned:
        return None
    return cleaned[:MAX_NAME_CHARS]


def _clean_item_path(raw):
    """A workflow FILE path inside a preset item - ALWAYS relative, POSIX
    separators, no traversal. Backslashes are normalized to slashes; a
    leading slash, a drive letter or a '..' segment refuses the item (the
    preset stores references into the user's workflows/ folder, never
    arbitrary filesystem locations). Returns the cleaned path or None."""
    if not isinstance(raw, str):
        return None
    p = raw.strip().replace("\\", "/")
    if not p or len(p) > MAX_PATH_CHARS:
        return None
    if p.startswith("/") or re.match(r"^[A-Za-z]:", p):
        return None
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if not parts or any(seg == ".." for seg in parts):
        return None
    return "/".join(parts)


def _item_dedupe_key(it):
    """Merge/dedup identity of a preset item. v112 stage 3 (plan 7.4): the
    snapshot identity moved from the display NAME to the graph CONTENT -
    two different graphs with the same name are NOT duplicates and must
    coexist; the same graph re-saved under another name still refreshes.
    Path items keep the path identity."""
    if not isinstance(it, dict):
        return None
    if it.get("kind") == "path":
        return "path:" + str(it.get("path") or "")
    if it.get("kind") == "snapshot":
        h = it.get("snapHash")
        if h:
            return "snap:" + str(h)
        # the legacy shape: fall back to the name (never merge two unknown
        # graphs silently)
        return "snapname:" + str(it.get("name") or "")
    return None


def _graph_canon_hash(graph):
    """A stable content hash of a snapshot graph (canonical JSON). The same
    helper rule as the index canonical hash - sorted keys, compact."""
    try:
        return hashlib.sha256(json.dumps(
            graph, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False).encode("utf-8")).hexdigest()
    except (TypeError, ValueError):
        return None


# v112 stage 4 (plan 9): the Preset CATEGORIES + TAGS. One category per
# preset; several tags; whitespace/case are normalized for the COMPARISON
# while the display form is preserved. Server-side validation - the UI is
# not the security boundary.
MAX_CATEGORY_CHARS = 40
MAX_TAGS = 12
MAX_TAG_CHARS = 32


def _sanitize_category(raw):
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", raw).strip()
    return cleaned[:MAX_CATEGORY_CHARS] or None


def _sanitize_tags(raw):
    """A bounded tag list; every tag control-stripped + capped; duplicates
    collapse by a case/space-normalized key; the FIRST spelling wins."""
    if raw is None:
        return None
    if not isinstance(raw, list):
        return None
    out, seen = [], set()
    for t in raw:
        if not isinstance(t, str):
            continue
        cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", t).strip()
        if not cleaned:
            continue
        cleaned = cleaned[:MAX_TAG_CHARS]
        key = re.sub(r"\s+", " ", cleaned).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= MAX_TAGS:
            break
    return out


def _snapshot_bytes(items):
    """Total serialized size of the snapshot graphs (the save-body budget)."""
    total = 0
    for it in items:
        if isinstance(it, dict) and it.get("kind") == "snapshot":
            try:
                total += len(json.dumps(it.get("graph"), ensure_ascii=False))
            except (TypeError, ValueError):
                return -1  # unserializable graph -> refuse the whole save
    return total


def _sanitize_items(raw):
    """Whitelist rebuild of a preset's items: only the known keys survive,
    path items are traversal-checked, snapshot graphs must be JSON objects.
    Returns (items, error) - error is None on success. The count is capped at
    MAX_ITEMS_PER_PRESET (a refusal, not a silent truncation - a silently
    dropped tab would look like a lost workflow)."""
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, "items must be a list"
    items, seen = [], set()
    for raw_it in raw:
        if not isinstance(raw_it, dict):
            continue
        kind = raw_it.get("kind")
        if kind == "path":
            path = _clean_item_path(raw_it.get("path"))
            if not path:
                return None, "bad item path: " + json.dumps(raw_it.get("path"))[:80]
            it = {"kind": "path", "path": path,
                  "name": path.split("/")[-1]}
            nm = _sanitize_name(raw_it.get("name"))
            if nm:
                it["name"] = nm
            key = _item_dedupe_key(it)
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
        elif kind == "snapshot":
            nm = _sanitize_name(raw_it.get("name"))
            graph = raw_it.get("graph")
            if not isinstance(graph, dict):
                return None, "snapshot graph must be an object"
            if not nm:
                nm = "Snapshot"
            # v112 stage 3 (plan 7.2): the snapshot ORIGIN metadata - kept
            # separately from the graph, the snapshot stays an INDEPENDENT
            # copy (a source file change never re-reads into it)
            it = {"kind": "snapshot", "name": nm, "graph": graph,
                  "snapHash": _graph_canon_hash(graph)}
            iid = raw_it.get("itemId")
            if isinstance(iid, str) and _ID_LOOSE_RE.match(iid):
                it["itemId"] = iid
            if raw_it.get("sourcePath") is not None:
                sp = _clean_item_path(raw_it.get("sourcePath"))
                if not sp:
                    return None, "bad snapshot sourcePath: " + \
                        json.dumps(raw_it.get("sourcePath"))[:80]
                it["sourcePath"] = sp  # a validated LIBRARY path only
            sn = _sanitize_name(raw_it.get("sourceName"))
            if sn:
                it["sourceName"] = sn
            wid = raw_it.get("workflowId")
            if isinstance(wid, str) and wid and len(wid) <= 64:
                it["workflowId"] = wid  # the ComfyUI UUID, display-only here
            ca = raw_it.get("capturedAt")
            if isinstance(ca, int) and ca > 0:
                it["capturedAt"] = ca
            key = _item_dedupe_key(it)
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
        else:
            continue
    # v112 stage 3 (plan 7.3): every item carries a stable itemId so the
    # ACTIVE item can be addressed regardless of its kind (a snapshot has
    # no path for the legacy activePath). Legacy presets get ids on their
    # next write - old JSON keeps reading without any migration.
    for i, it in enumerate(items):
        if not it.get("itemId"):
            it["itemId"] = uuid.uuid4().hex[:12] + ("%02d" % i)
    if len(items) > MAX_ITEMS_PER_PRESET:
        return None, ("too many items: %d (max %d)"
                      % (len(items), MAX_ITEMS_PER_PRESET))
    return items, None


def _apply_fields_to_preset(p, fields):
    """Apply the sanitized wire fields to a preset dict IN PLACE (the ONE
    shared mutation of overwrite/merge/PUT - and the would-be comparison
    before the version archive). Keys NOT present in `fields` never touch
    the preset - a would-be copy can therefore never introduce phantom
    None-keyed fields (the v112 phantom-revision bug)."""
    if "items" in fields:
        p["items"] = fields["items"]
    if fields.get("name"):
        p["name"] = fields["name"]
    if "activePath" in fields:
        if fields["activePath"]:
            p["activePath"] = fields["activePath"]
        else:
            p.pop("activePath", None)
    if "activeItemId" in fields:
        if fields["activeItemId"] and any(
                it.get("itemId") == fields["activeItemId"]
                for it in (p.get("items") or [])):
            p["activeItemId"] = fields["activeItemId"]
        else:
            p.pop("activeItemId", None)
    if "category" in fields:
        if fields["category"]:
            p["category"] = fields["category"]
        else:
            p.pop("category", None)
    if "tags" in fields:
        p["tags"] = fields["tags"]
    if "fav" in fields:
        p["fav"] = fields["fav"]
    return p


def _sanitize_preset_body(body):
    """Validate/sanitize a create/update payload. Returns (fields, error):
    fields = {name, items, activePath, fav} with only the PROVIDED keys set
    (a partial update leaves the rest untouched)."""
    if not isinstance(body, dict):
        return None, "bad body"
    fields = {}
    if "name" in body:
        nm = _sanitize_name(body.get("name"))
        if nm:
            fields["name"] = nm
    if "items" in body:
        items, err = _sanitize_items(body.get("items"))
        if err:
            return None, err
        fields["items"] = items
    if "activePath" in body:
        ap = _clean_item_path(body.get("activePath"))
        fields["activePath"] = ap  # None clears it (a snapshot-only preset)
    if "activeItemId" in body:
        # v112 stage 3 (plan 7.3): the active item may be a SNAPSHOT - the
        # id must reference one of the preset's items (validated on write)
        aid = body.get("activeItemId")
        fields["activeItemId"] = (aid if isinstance(aid, str)
                                  and _ID_LOOSE_RE.match(aid) else None)
    if "fav" in body:
        fields["fav"] = bool(body.get("fav"))
    # v112 stage 4 (plan 9): the category + the tags - backwards compatible
    # (an absent field never touches the stored value)
    if "category" in body:
        fields["category"] = _sanitize_category(body.get("category"))
    if "tags" in body:
        tags = _sanitize_tags(body.get("tags"))
        if tags is None:
            return None, "tags must be a list of strings"
        fields["tags"] = tags
    return fields, None


def _new_preset(pid, name, items, active_path, fav, now):
    p = {
        "id": pid,
        "name": name or ("Workspace %s" % pid[:4]),
        "created": now,
        "updated": now,
        "fav": bool(fav),
        "items": items,
    }
    if active_path:
        p["activePath"] = active_path
    return p


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/settings_hub/workflows/health")
async def workflows_health(request):
    """Self-diagnosis for the Workflows panel (and humans): proves the
    Python routes are alive, reports where the storage lives, whether it is
    WRITABLE (a probe file is written+deleted in the root) and how many
    per-preset files the active root holds (v104: the file count - parsing
    every snapshot graph just to count would be wasteful on a probe). Never
    throws: every check degrades to a false/empty field."""
    _ensure_dirs()
    writable = _probe_writable(_workflows_root())
    n = _count_visible_presets()
    return web.json_response({
        "ok": True,
        "version": WORKFLOWS_SERVER_VERSION,
        "dir": _workflows_root(),
        "custom": _root_custom,
        "default": _default_root(),
        "userRel": _root_rel_to_user(),  # v108: the root relative to the user dir
        "writable": writable,
        "presets": n,
        "temp": _count_temp_files(),  # v107: the temp-snapshot counter
    })


# v101: server pack version - MUST bump together with the web build stamps
# (tools/version.py checks both against the entry stamp; the panel compares
# it against globalThis.__SettingsHubBuild). AGENTS.md release rule.
WORKFLOWS_SERVER_VERSION = "v115"


@PromptServer.instance.routes.get("/settings_hub/workflows/root")
async def workflows_root_get(request):
    return web.json_response({
        "ok": True,
        "root": _workflows_root(),
        "custom": _root_custom,
        "default": _default_root(),
        "userRel": _root_rel_to_user(),  # v108
        "writable": _probe_writable(_workflows_root()),
    })


@PromptServer.instance.routes.post("/settings_hub/workflows/root")
async def workflows_root_set(request):
    """Re-point the storage root. Body JSON {path}: an empty string or
    whitespace = back to the default; otherwise an ABSOLUTE folder path
    (~ expanded, pasted quotes stripped). The folder is created and probed
    writable BEFORE the switch. Presets are NEVER moved: the new root starts
    empty, the old one keeps its presets/ folder (AGENTS.md 5.1 rule 12)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    # The "path" key must be EXPLICIT (the same philosophy as the stack root
    # route): an accidental/blank body must not reset the root by hiding
    # behind a missing value.
    raw = body.get("path") if isinstance(body, dict) else None
    if not isinstance(raw, str):
        return web.json_response(
            {"ok": False, "error": "path must be a string"}, status=400)
    path, err = _clean_root_candidate(raw)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    global _root_custom
    async with _lock:
        if path:
            if not _probe_writable(path):
                return web.json_response(
                    {"ok": False, "error": "folder is not writable: " + path},
                    status=400)
            _root_custom = path
        else:
            _root_custom = None
        saved = _save_root_override()
    root = _workflows_root()
    return web.json_response({
        "ok": True,
        "saved": saved,
        "root": root,
        "custom": _root_custom,
        "default": _default_root(),
        "userRel": _root_rel_to_user(),  # v108
        "writable": _probe_writable(root),
    })


@PromptServer.instance.routes.get("/settings_hub/workflows/presets")
async def workflows_presets_get(request):
    """The full preset list of the active root - favorites first, then by
    `updated` descending."""
    return web.json_response({"ok": True, "presets": _sorted_presets(_read_presets())})


@PromptServer.instance.routes.post("/settings_hub/workflows/presets")
async def workflows_presets_post(request):
    """Create / overwrite / merge a preset. Body JSON:
      {id?, name, items, activePath?, fav?, mode?}
      mode "create" (default) - a NEW preset (a provided unused id is kept,
                                a colliding one is regenerated);
      mode "overwrite"        - id REQUIRED: replace name/items/activePath;
      mode "merge"            - id REQUIRED: merge items into the preset
                                (dedupe: path items by path, snapshots by
                                name - a re-saved temp tab refreshes its
                                snapshot instead of stacking a copy)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    fields, err = _sanitize_preset_body(body)
    if err:
        # an item-shape error is a plain refusal (400); oversized snapshot
        # graphs answer 413 (content too large) - the client keeps the form
        # open either way and shows the exact reason
        big = "too large" in err or "bytes" in err
        return web.json_response({"ok": False, "error": err},
                                 status=413 if big else 400)
    if "items" not in fields:
        return web.json_response(
            {"ok": False, "error": "items are required"}, status=400)
    items = fields["items"]
    total = _snapshot_bytes(items)
    if total < 0:
        return web.json_response(
            {"ok": False, "error": "snapshot graph is not serializable"}, status=400)
    if total > MAX_SNAPSHOT_BYTES:
        return web.json_response(
            {"ok": False, "error": "snapshots too large: %d bytes (max %d)"
             % (total, MAX_SNAPSHOT_BYTES)}, status=413)
    mode = body.get("mode") if isinstance(body, dict) else None
    if mode not in ("create", "overwrite", "merge"):
        mode = "create"
    pid = body.get("id") if isinstance(body.get("id"), str) else ""
    now = int(time.time())
    async with _lock:
        _migrate_legacy_file()
        if mode in ("overwrite", "merge"):
            if not pid or not _ID_LOOSE_RE.match(pid):
                return web.json_response(
                    {"ok": False, "error": "a valid id is required for %s" % mode},
                    status=400)
            existing = _load_preset_file(pid)
            if existing is None:
                return web.json_response(
                    {"ok": False, "error": "no such preset: " + pid}, status=404)
            if mode == "overwrite":
                # v112 stage 4 (plan 10): archive BEFORE the change - only
                # when a meaningful field actually differs (the would-be copy
                # goes through the SAME mutation helper - no phantom keys)
                would = _apply_fields_to_preset(dict(existing), fields)
                if preset_versions_changed(existing, would):
                    _archive_preset_version(pid, "overwrite")
                _apply_fields_to_preset(existing, fields)
                existing["updated"] = now
            else:  # merge
                # v112 stage 4 (plan 10): the archive fires only when the
                # would-be merge result really differs from the current
                before = dict(existing)
                merged = list(existing.get("items") or [])
                have = {_item_dedupe_key(it) for it in merged}
                for it in items:
                    k = _item_dedupe_key(it)
                    if k in have:
                        # refresh in place (a newer snapshot of the SAME
                        # graph content; same-name-different-graph coexists)
                        merged = [it if _item_dedupe_key(x) == k else x
                                  for x in merged]
                    else:
                        merged.append(it)
                        have.add(k)
                if len(merged) > MAX_ITEMS_PER_PRESET:
                    return web.json_response(
                        {"ok": False,
                         "error": "merge exceeds %d items (would be %d)"
                                  % (MAX_ITEMS_PER_PRESET, len(merged))},
                        status=400)
                would = _apply_fields_to_preset(dict(existing),
                                                {k: v for k, v in fields.items()
                                                 if k != "items"})
                would["items"] = merged
                if preset_versions_changed(before, would):
                    _archive_preset_version(pid, "merge")
                _apply_fields_to_preset(existing, fields)
                existing["items"] = merged
                existing["updated"] = now
            _write_preset_file(existing)
            return web.json_response({"ok": True, "preset": existing,
                                      "mode": mode})
        # create: the folder is the store - MAX_PRESETS counts the files and
        # a colliding id is an existing FILE, not an array entry
        if _count_preset_files() >= MAX_PRESETS:
            return web.json_response(
                {"ok": False, "error": "too many presets (max %d)" % MAX_PRESETS},
                status=400)
        if pid and _ID_RE.match(pid) and _load_preset_file(pid) is None:
            new_id = pid          # import keeps a provided FREE id
        else:
            new_id = uuid.uuid4().hex[:12]  # a collision regenerates
            while _load_preset_file(new_id) is not None:
                new_id = uuid.uuid4().hex[:12]
        preset = _new_preset(new_id, fields.get("name"), items,
                             fields.get("activePath"), fields.get("fav"), now)
        if fields.get("activeItemId") and any(
                it.get("itemId") == fields["activeItemId"] for it in items):
            preset["activeItemId"] = fields["activeItemId"]
        if fields.get("category"):
            preset["category"] = fields["category"]
        if fields.get("tags"):
            preset["tags"] = fields["tags"]
        _write_preset_file(preset)
        # v112 stage 4 (plan 10): the INITIAL revision of a new preset
        _archive_preset_version(preset["id"], "create")
    return web.json_response({"ok": True, "preset": preset, "mode": "create"})


@PromptServer.instance.routes.put("/settings_hub/workflows/preset/{pid}")
async def workflows_preset_put(request):
    """Partial update of ONE preset: {name?, fav?, items?, activePath?}.
    Missing keys leave the fields untouched. The response carries the updated
    preset so the client mirrors the server truth."""
    pid = request.match_info.get("pid", "")
    if not _ID_LOOSE_RE.match(pid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    fields, err = _sanitize_preset_body(body)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    if "items" in fields:
        total = _snapshot_bytes(fields["items"])
        if total < 0:
            return web.json_response(
                {"ok": False, "error": "snapshot graph is not serializable"},
                status=400)
        if total > MAX_SNAPSHOT_BYTES:
            return web.json_response(
                {"ok": False, "error": "snapshots too large"}, status=413)
    async with _lock:
        _migrate_legacy_file()
        it = _load_preset_file(pid)
        if it is None:
            return web.json_response({"ok": False, "error": "no such preset"},
                                     status=404)
        # v112 stage 4 (plan 10): compute the would-be result FIRST (the ONE
        # shared mutation helper) - the archive fires only when a meaningful
        # field actually differs
        would = _apply_fields_to_preset(dict(it), fields)
        if preset_versions_changed(it, would):
            _archive_preset_version(pid, "put")
        _apply_fields_to_preset(it, fields)
        it["updated"] = int(time.time())
        _write_preset_file(it)
    return web.json_response({"ok": True, "preset": it})


@PromptServer.instance.routes.delete("/settings_hub/workflows/preset/{pid}")
async def workflows_preset_delete(request):
    pid = request.match_info.get("pid", "")
    if not _ID_LOOSE_RE.match(pid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        _migrate_legacy_file()
        if _load_preset_file(pid) is None:
            return web.json_response({"ok": False, "error": "no such preset"},
                                     status=404)
        _delete_preset_versions(pid)  # the history dies WITH the preset
        _delete_preset_file(pid)
    return web.json_response({"ok": True, "gone": pid})


@PromptServer.instance.routes.post("/settings_hub/workflows/import")
async def workflows_import(request):
    """Import presets exported by the export button (one preset object or
    {presets: [...]}). Ids are regenerated on collision; body
    {overwrite: true} replaces an existing preset with the same id instead.
    v104 storage: every preset lands as its OWN presets/<id>.json file, so a
    single-preset payload transfers exactly one preset (the same transfer is
    possible without this route at all - copy the file). Import stays
    all-or-nothing: EVERY preset is sanitized and the room is checked BEFORE
    the first file is written - a bad item anywhere refuses the whole import
    (a half-imported list would hide which parts failed)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if isinstance(body, dict) and isinstance(body.get("presets"), list):
        raw_list = body["presets"]
        overwrite = bool(body.get("overwrite"))
    elif isinstance(body, dict) and ("items" in body):
        raw_list = [body]
        overwrite = bool(body.get("overwrite"))
    else:
        return web.json_response(
            {"ok": False, "error": "no presets in the payload"}, status=400)
    # Phase 1 - sanitize EVERY raw preset first (no storage touched yet).
    plan = []
    for raw in raw_list:
        fields, err = _sanitize_preset_body(raw)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        if "items" not in fields:
            return web.json_response(
                {"ok": False, "error": "items are required"}, status=400)
        total = _snapshot_bytes(fields["items"])
        if total < 0 or total > MAX_SNAPSHOT_BYTES:
            return web.json_response(
                {"ok": False, "error": "snapshot size"}, status=413)
        raw_id = raw.get("id") if isinstance(raw, dict) else None
        raw_id = raw_id if isinstance(raw_id, str) else ""
        plan.append((raw_id, fields))
    now = int(time.time())
    async with _lock:
        _migrate_legacy_file()
        # Phase 2 - the room check counts every NEW file the import would
        # add (overwrite-in-place adds none) BEFORE the first write.
        fresh = 0
        for raw_id, _fields in plan:
            exists = bool(raw_id) and _load_preset_file(raw_id) is not None
            if not (exists and overwrite):
                fresh += 1
        if _count_preset_files() + fresh > MAX_PRESETS:
            return web.json_response(
                {"ok": False, "error": "too many presets (max %d)"
                 % MAX_PRESETS}, status=400)
        # Phase 3 - apply, one file per preset.
        imported = []
        for raw_id, fields in plan:
            existing = _load_preset_file(raw_id) if raw_id else None
            if existing is not None and overwrite:
                _archive_preset_version(existing["id"], "import")
                existing["items"] = fields["items"]
                if fields.get("name"):
                    existing["name"] = fields["name"]
                if "activePath" in fields:
                    if fields["activePath"]:
                        existing["activePath"] = fields["activePath"]
                    else:
                        existing.pop("activePath", None)
                if "activeItemId" in fields and fields["activeItemId"] and any(
                        x.get("itemId") == fields["activeItemId"]
                        for x in (fields["items"] or [])):
                    existing["activeItemId"] = fields["activeItemId"]
                if "category" in fields:
                    if fields["category"]:
                        existing["category"] = fields["category"]
                    else:
                        existing.pop("category", None)
                if "tags" in fields:
                    existing["tags"] = fields["tags"]
                if "fav" in fields:
                    existing["fav"] = fields["fav"]
                existing["updated"] = now
                _write_preset_file(existing)
                imported.append(existing)
                continue
            if raw_id and _ID_LOOSE_RE.match(raw_id) \
                    and _load_preset_file(raw_id) is None:
                new_id = raw_id  # a legacy/loose id is kept when it is FREE
            else:
                new_id = uuid.uuid4().hex[:12]
                while _load_preset_file(new_id) is not None:
                    new_id = uuid.uuid4().hex[:12]
            preset = _new_preset(new_id, fields.get("name"), fields["items"],
                                 fields.get("activePath"), fields.get("fav"),
                                 now)
            if fields.get("category"):
                preset["category"] = fields["category"]
            if fields.get("tags"):
                preset["tags"] = fields["tags"]
            _write_preset_file(preset)
            _archive_preset_version(preset["id"], "create")
            imported.append(preset)
    return web.json_response({"ok": True, "imported": len(imported),
                              "presets": imported})


# ---------------------------------------------------------------------------
# v107: temp-snapshot routes - the reopen payloads of closed TEMP tabs.
# The browser recently-closed ring stores ONLY the metadata; these routes
# carry the graphs. All mutations run under the module lock; every answer is
# a JSON object with ok:true|false (never a bare error page).
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/settings_hub/workflows/temp")
async def workflows_temp_list(request):
    """The temp-snapshot index of the ACTIVE root: {ok, items: [{id, name,
    ts}]} - NO graphs (the payloads are fetched one-by-one on a reopen).
    Feeds the client boot GC (it deletes the stale orphans no recently-
    closed entry references) and the owner's folder hygiene."""
    return web.json_response({"ok": True, "items": _list_temp_files()})


@PromptServer.instance.routes.post("/settings_hub/workflows/temp")
async def workflows_temp_put(request):
    """Store ONE reopen snapshot of a closed TEMP tab. Body JSON
    {name?, graph}: the graph must be JSON-serializable and within
    MAX_SNAPSHOT_BYTES (the same budget the preset snapshots use). The id is
    server-generated strict hex; the oldest files beyond MAX_TEMP_FILES are
    evicted after the write. The client deletes the file when the
    recently-closed entry leaves the ring."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    graph = body.get("graph") if isinstance(body, dict) else None
    if graph is None:
        return web.json_response(
            {"ok": False, "error": "graph is required"}, status=400)
    try:
        blob = json.dumps(graph, ensure_ascii=False)
    except Exception:
        return web.json_response(
            {"ok": False, "error": "snapshot graph is not serializable"},
            status=400)
    size = len(blob.encode("utf-8"))
    if size > MAX_SNAPSHOT_BYTES:
        return web.json_response(
            {"ok": False, "error": "snapshot too large: %d bytes (max %d)"
             % (size, MAX_SNAPSHOT_BYTES)}, status=413)
    name = _sanitize_name(body.get("name") if isinstance(body, dict) else None) \
        or "Unsaved"
    now = int(time.time())
    global _temp_seq
    _temp_seq += 1
    async with _lock:
        tid = uuid.uuid4().hex[:12]
        while os.path.exists(_temp_file(tid)):
            tid = uuid.uuid4().hex[:12]
        if not _write_temp_file({"id": tid, "name": name, "ts": now,
                                 "seq": _temp_seq, "graph": graph}):
            return web.json_response(
                {"ok": False, "error": "could not write the temp snapshot"},
                status=500)
        _evict_temp_files()
    return web.json_response({"ok": True, "id": tid, "name": name, "ts": now})


@PromptServer.instance.routes.get("/settings_hub/workflows/temp/{tid}")
async def workflows_temp_get(request):
    """ONE temp snapshot: {ok, id, name, ts, graph}. 404 on an unknown id -
    the client answers "the snapshot is gone" and falls back (a saved-file
    reopen by path when the entry carries one)."""
    tid = request.match_info.get("tid", "")
    if not _ID_RE.match(tid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    it = _read_temp_file(tid)
    if it is None:
        return web.json_response(
            {"ok": False, "error": "no such snapshot"}, status=404)
    return web.json_response({
        "ok": True,
        "id": tid,
        "name": it.get("name") or "",
        "ts": int(it.get("ts", 0) or 0),
        "graph": it.get("graph"),
    })


@PromptServer.instance.routes.delete("/settings_hub/workflows/temp/{tid}")
async def workflows_temp_delete(request):
    """Delete ONE temp snapshot (the entry left the recently-closed ring, or
    the boot GC dropped a stale orphan). Idempotent: an already-missing id
    answers ok:true with existed:false (a client cleanup may race the server
    MAX_TEMP_FILES eviction)."""
    tid = request.match_info.get("tid", "")
    if not _ID_RE.match(tid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        existed = _delete_temp_file(tid)
    return web.json_response({"ok": True, "gone": tid, "existed": existed})


# ---------------------------------------------------------------------------
# v108: the FILES listing for the Workflows panel's Files tab - the ComfyUI
# workflows/ USER folder (the userdata "workflows" directory) with the size
# and the last-modified time of every workflow file, so the tab can sort by
# date/size and filter by them. The STORAGE ROOT is excluded from the walk:
# the owner's contract - presets must never mix into the ordinary workflow
# list ("не смешивать пресеты с обычными workflow-файлами в Files"), even
# when the root is re-pointed INSIDE the workflows folder. The listing is a
# plain directory walk over the DEFAULT user dir (single-user installs - the
# panel's audience; the native multi-user /userdata endpoint stays wired in
# the client as the fallback rung when this route is missing).
# ---------------------------------------------------------------------------

MAX_FILES_LISTED = 6000  # a walk must stay bounded on a huge library


def _workflows_user_dirs(request=None):
    """v109: the REAL 'workflows' folders the native /userdata endpoints
    serve. The ComfyUI user directory is NOT the userdata root itself -
    the server nests every user inside it (user_manager.get_request_user_id:
    'default' unless multi-user; get_public_user_directory: <user_dir>/<id>),
    so the Workflow Browser lists <user_dir>/default/workflows. v108 walked
    the flat <user_dir>/workflows instead, which answered an EMPTY ok:true
    on real installs and - as the client's rung 0 - blanked the Files tab
    and marked every preset item missing. Returns the EXISTING roots, best
    first: the request's comfy-user folder (multi-user installs) > the
    'default' user > the legacy flat folder (still readable - anything
    saved into it in the v108 window must not vanish). System users
    ('__'-prefixed) and the pack's own 'settings_hub' namespace are never
    candidates."""
    base = _user_dir()
    out = []
    seen = set()

    def add(d):
        d = os.path.abspath(d)
        if d in seen or not os.path.isdir(d):
            return
        seen.add(d)
        out.append(d)

    hdr = None
    try:
        hdr = request.headers.get("comfy-user") if request is not None else None
    except Exception:
        hdr = None
    if (isinstance(hdr, str) and hdr and not hdr.startswith(".")
            and not hdr.startswith("__") and "/" not in hdr and "\\" not in hdr
            and ".." not in hdr and hdr != "settings_hub"):
        add(os.path.join(base, hdr, "workflows"))
    add(os.path.join(base, "default", "workflows"))
    add(os.path.join(base, "workflows"))  # the v108 flat layout, kept readable
    return out


def _is_inside(path, folder):
    """True when `path` lies INSIDE `folder` (or equals it)."""
    try:
        rel = os.path.relpath(path, folder)
    except Exception:
        return False
    return not rel.startswith("..") and not os.path.isabs(rel) and rel != "."


def _files_hide_dirs(wroot):
    """The directories ONE walk root must skip - the storage root's own
    housekeeping when it lives under (or around) that walk root."""
    hides = []
    sroot = _workflows_root()
    if _is_inside(sroot, wroot):
        # the storage root sits under this workflows/ root - hide the whole
        # subtree (its presets/ + temp/ die with it)
        hides.append(sroot)
    else:
        # the storage root CONTAINS the walk root (or equals it): at least
        # keep its presets/ + temp/ housekeeping out of the list
        for name in (_PRESETS_DIR_NAME, _TEMP_DIR_NAME):
            p = os.path.join(sroot, name)
            if _is_inside(p, wroot):
                hides.append(p)
    return [os.path.normcase(os.path.abspath(h)) for h in hides]


@PromptServer.instance.routes.get("/settings_hub/workflows/files")
async def workflows_files_list(request):
    """Every workflow file under the REAL userdata workflows folders
    (recursive, .json only): [{path: "workflows/<rel>", name, size, mtime}].
    `mtime` is the unix mtime (seconds) and `size` the byte size - the Files
    tab sorts/filters by them. v109: the walk covers the per-user roots
    (the request's comfy-user folder > 'default') + the legacy flat folder;
    the FIRST root wins on a relative-path clash (deduped, no stacked
    duplicates). The storage-root housekeeping (presets/, temp/) never
    appears here. Bounded by MAX_FILES_LISTED (truncated: true on a hit) -
    a huge library cannot stall the panel."""
    roots = _workflows_user_dirs(request)
    out = []
    seen_rel = set()
    truncated = False
    for root in roots:
        if truncated:
            break
        hides = _files_hide_dirs(root)
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                dirnames[:] = [d for d in dirnames
                               if os.path.normcase(os.path.abspath(os.path.join(dirpath, d))) not in hides]
                filenames.sort()
                for fn in filenames:
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
                    key = "workflows/" + rel
                    if key in seen_rel:
                        continue  # the first root wins - no stacked duplicates
                    seen_rel.add(key)
                    out.append({"path": key, "name": fn,
                                "size": int(st.st_size), "mtime": int(st.st_mtime)})
                    if len(out) >= MAX_FILES_LISTED:
                        truncated = True
                        break
                if truncated:
                    break
        except Exception:
            pass  # a missing/unreadable workflows folder answers an empty list
    return web.json_response({
        "ok": True,
        "files": out,
        "truncated": truncated,
        "root": roots[0] if roots else os.path.join(_user_dir(), "default", "workflows"),
    })


# ---------------------------------------------------------------------------
# v108: the File favorites - the ★ marks of the Files tab. They live in the
# DEFAULT user dir (next to workflows_root.json): a favorite tags a workflow
# FILE of the ComfyUI workflows/ folder, not the storage content, so a root
# switch must never hide or lose them (the same "the way back lives in the
# default dir" philosophy as the root override file).
# ---------------------------------------------------------------------------

_FAV_NAME = "workflows_favorites.json"
MAX_FAVS = 2000


def _fav_path():
    return os.path.join(_user_dir(), "settings_hub", _FAV_NAME)


def _read_file_favs():
    """The favorite paths (["workflows/<rel>", ...], normalized POSIX). A
    corrupt file reads as empty - the marks re-appear on the next toggle."""
    try:
        with open(_fav_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        favs = data.get("favs") if isinstance(data, dict) else None
        if isinstance(favs, list):
            seen = set()
            out = []
            for x in favs:
                if isinstance(x, str) and x and x not in seen:
                    seen.add(x)
                    out.append(x)
            return out
    except Exception:
        pass
    return []


def _write_file_favs(favs):
    """Atomic write of the favorites list (tmp + os.replace)."""
    _ensure_dir(os.path.dirname(_fav_path()))
    tmp = _fav_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"favs": favs, "saved": int(time.time())}, f, ensure_ascii=False)
    os.replace(tmp, _fav_path())


@PromptServer.instance.routes.get("/settings_hub/workflows/files-fav")
async def workflows_files_fav_get(request):
    return web.json_response({"ok": True, "favs": _read_file_favs()})


@PromptServer.instance.routes.post("/settings_hub/workflows/files-fav")
async def workflows_files_fav_post(request):
    """Toggle ONE favorite: body {path, fav}. The path is the same relative
    "workflows/<rel>" shape the Files listing serves (traversal-checked by
    the item-path sanitizer). The full list comes back so the client mirrors
    the server truth (multi-window safe)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    path = _clean_item_path(body.get("path") if isinstance(body, dict) else None)
    if not path:
        return web.json_response({"ok": False, "error": "bad path"}, status=400)
    fav = bool(body.get("fav")) if isinstance(body, dict) else False
    async with _lock:
        favs = _read_file_favs()
        if fav and path not in favs:
            favs.append(path)
        elif not fav and path in favs:
            favs = [x for x in favs if x != path]
        if len(favs) > MAX_FAVS:
            return web.json_response(
                {"ok": False, "error": "too many favorites (max %d)" % MAX_FAVS},
                status=400)
        try:
            _write_file_favs(favs)
        except Exception:
            return web.json_response(
                {"ok": False, "error": "could not write the favorites file"},
                status=500)
    return web.json_response({"ok": True, "favs": favs})


# ---------------------------------------------------------------------------
# v112 (plan 3.1): SERVER-SIDE UNDO SNAPSHOTS. Before the Workflow Manager
# runs a destructive apply plan it captures the FULL workspace state - every
# open tab's path/key/modified/temp flags AND the actual graph JSON of the
# tabs that may be closed - and stores it here. The browser keeps only the
# undoId; the payload is bounded (UNDO_MAX_FILES + TTL GC) and never
# blocks the apply. A failed upload => the plan REFUSES the destructive
# close for the tabs it could not snapshot (the client contract).
# ---------------------------------------------------------------------------

MAX_UNDO_SNAPSHOT_BYTES = 24 * 1024 * 1024  # the plan: server-side, not localStorage


def _sanitize_undo_tab(raw):
    """Whitelist ONE undo tab record: the identity + the flags + the graph.
    The graph MUST be a JSON object (a tab without a graph is recorded with
    graph: null and is reopened by path on undo, not restored from bytes)."""
    if not isinstance(raw, dict):
        return None
    tab = {}
    key = raw.get("key")
    tab["key"] = key if isinstance(key, str) and key else None
    path = _clean_item_path(raw.get("path"))
    tab["path"] = path  # None for temp tabs (legal)
    name = _sanitize_name(raw.get("name"))
    tab["name"] = name or (path.split("/")[-1] if path else "Unsaved")
    tab["active"] = bool(raw.get("active"))
    tab["modified"] = bool(raw.get("modified"))
    tab["temp"] = bool(raw.get("temp"))
    g = raw.get("graph")
    tab["graph"] = g if isinstance(g, dict) else None
    return tab


@PromptServer.instance.routes.post("/settings_hub/workflows/undo")
async def workflows_undo_put(request):
    """Store ONE pre-apply workspace snapshot. Body:
    {tabs: [{key?, path?, name, active, modified, temp, graph?}],
     activeKey?}. Returns {ok, undoId, bytes}. The whole body is bounded by
    MAX_UNDO_SNAPSHOT_BYTES - a workspace with huge unsaved graphs still
    fits (24 MB >> the 10 MB preset budget), anything larger refuses the
    SNAPSHOT (the client must then refuse the destructive close, never
    half-carry it out)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if not isinstance(body, dict) or not isinstance(body.get("tabs"), list):
        return web.json_response(
            {"ok": False, "error": "tabs list is required"}, status=400)
    raw_tabs = body["tabs"]
    if len(raw_tabs) > MAX_ITEMS_PER_PRESET * 3:
        return web.json_response(
            {"ok": False, "error": "too many tabs in the snapshot"}, status=400)
    tabs = []
    for raw in raw_tabs:
        tab = _sanitize_undo_tab(raw)
        if tab is not None:
            tabs.append(tab)
    try:
        blob = json.dumps({"tabs": tabs}, ensure_ascii=False)
    except (TypeError, ValueError):
        return web.json_response(
            {"ok": False, "error": "snapshot graph is not serializable"}, status=400)
    size = len(blob.encode("utf-8"))
    if size > MAX_UNDO_SNAPSHOT_BYTES:
        return web.json_response(
            {"ok": False, "error": "undo snapshot too large: %d bytes (max %d)"
             % (size, MAX_UNDO_SNAPSHOT_BYTES)}, status=413)
    now = int(time.time())
    async with _lock:
        _ensure_mgr_dirs()
        uid = uuid.uuid4().hex[:16]
        rec = {
            "id": uid,
            "ts": now,
            "activeKey": body.get("activeKey") if isinstance(body.get("activeKey"), str) else None,
            "tabs": tabs,
        }
        if not _mgr_write_json(_mgr_dir("undo"), uid, rec):
            return web.json_response(
                {"ok": False, "error": "could not write the undo snapshot"}, status=500)
        _undo_gc_locked()
    return web.json_response({"ok": True, "undoId": uid, "ts": now, "bytes": size})


@PromptServer.instance.routes.get("/settings_hub/workflows/undo/{uid}")
async def workflows_undo_get(request):
    uid = request.match_info.get("uid", "")
    if not _ID_RE.match(uid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    rec = _mgr_read_json(_mgr_dir("undo"), uid)
    if not isinstance(rec, dict) or rec.get("id") != uid:
        return web.json_response({"ok": False, "error": "no such snapshot"}, status=404)
    return web.json_response({
        "ok": True, "id": uid, "ts": int(rec.get("ts", 0) or 0),
        "activeKey": rec.get("activeKey"), "tabs": rec.get("tabs") or [],
    })


@PromptServer.instance.routes.delete("/settings_hub/workflows/undo/{uid}")
async def workflows_undo_delete(request):
    """Delete ONE undo snapshot (consumed by undo, or replaced by a newer
    capture). Idempotent like the temp delete."""
    uid = request.match_info.get("uid", "")
    if not _ID_RE.match(uid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        existed = _mgr_delete(_mgr_dir("undo"), uid)
    return web.json_response({"ok": True, "gone": uid, "existed": existed})


# ---------------------------------------------------------------------------
# v112 (plan 3.6): SERVER-SIDE RECENTLY-CLOSED MANIFESTS. The localStorage
# ring stops being the source of truth: each browser session keeps its ring
# as a manifest record under workflows_manager/recent/<clientId>.json and
# the temp snapshots get CROSS-BROWSER reference accounting. A snapshot is
# deletable only when NO manifest references it AND it is older than
# TEMP_MAX_AGE_S - one browser can never orphan another browser's reopen.
# The localStorage ring stays as the offline/degraded mirror (an old py
# without these routes keeps the v107 behavior).
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/settings_hub/workflows/recent/{cid}")
async def workflows_recent_get(request):
    """The manifest of ONE browser session. 404 = no manifest yet (a fresh
    session - the client may then UPLOAD its migrated localStorage ring)."""
    cid = request.match_info.get("cid", "")
    if not _ID_LOOSE_RE.match(cid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    rec = _mgr_read_json(_mgr_dir("recent"), cid)
    if not isinstance(rec, dict) or rec.get("clientId") != cid:
        return web.json_response({"ok": False, "error": "no manifest"}, status=404)
    return web.json_response({
        "ok": True,
        "clientId": cid,
        "entries": rec.get("entries") or [],
        "updatedAt": int(rec.get("updatedAt", 0) or 0),
    })


@PromptServer.instance.routes.post("/settings_hub/workflows/recent")
async def workflows_recent_put(request):
    """Upsert the ring manifest of ONE browser session. Body:
    {clientId, entries: [{path?, name, ts, tempId?, snap?}]}.
    The manifest REPLACES the stored one (the client owns its ring content);
    entries are sanitized/capped. Returns {ok, refs} - the temp ids still
    referenced by ALL manifests, so the client can drop only truly orphaned
    snapshots. Stale manifests (older than RECENT_MAX_AGE_S) are GC'd."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "bad body"}, status=400)
    cid = body.get("clientId")
    if not isinstance(cid, str) or not _ID_LOOSE_RE.match(cid):
        return web.json_response({"ok": False, "error": "bad clientId"}, status=400)
    raw_entries = body.get("entries")
    if not isinstance(raw_entries, list):
        return web.json_response({"ok": False, "error": "entries must be a list"}, status=400)
    entries = []
    for raw in raw_entries[:RECENT_MAX_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        ent = {}
        path = _clean_item_path(raw.get("path"))
        ent["path"] = path
        ent["name"] = _sanitize_name(raw.get("name")) or "Unsaved"
        try:
            ent["ts"] = int(raw.get("ts", 0) or 0)
        except (TypeError, ValueError):
            ent["ts"] = 0
        tid = raw.get("tempId")
        ent["tempId"] = tid if isinstance(tid, str) and _ID_RE.match(tid) else None
        snap = raw.get("snap")
        ent["snap"] = snap if isinstance(snap, dict) else None
        if ent["path"] or ent["tempId"] or ent["snap"]:
            entries.append(ent)
    now = int(time.time())
    async with _lock:
        _ensure_mgr_dirs()
        # the capacity guard counts the manifests AFTER the stale-GC
        _recent_gc_locked()
        rec = {"clientId": cid, "entries": entries, "updatedAt": now}
        if not _mgr_write_json(_mgr_dir("recent"), cid, rec):
            return web.json_response(
                {"ok": False, "error": "could not write the manifest"}, status=500)
        extra = [c for c in _mgr_list(_mgr_dir("recent")) if c != cid]
        if len(extra) >= RECENT_MAX_CLIENTS:
            # too many stale sessions: drop the OLDEST beyond the cap
            aged = []
            for c2 in extra:
                r2 = _mgr_read_json(_mgr_dir("recent"), c2)
                if r2 is None:
                    aged.append((c2, 0))
                else:
                    aged.append((c2, int(r2.get("updatedAt", 0) or 0)))
            aged.sort(key=lambda x: x[1])
            for c2, _ts in aged[:max(0, len(aged) - RECENT_MAX_CLIENTS + 1)]:
                _mgr_delete(_mgr_dir("recent"), c2)
        refs = sorted(_recent_refs())
    return web.json_response({"ok": True, "clientId": cid, "updatedAt": now,
                              "refs": refs})


@PromptServer.instance.routes.delete("/settings_hub/workflows/recent/{cid}")
async def workflows_recent_delete(request):
    """Delete ONE session manifest (a browser explicitly forgets its ring).
    The temp snapshots it referenced are NOT deleted here - the next server
    GC (POST /workflows/temp/gc) reaps them after the TTL only."""
    cid = request.match_info.get("cid", "")
    if not _ID_LOOSE_RE.match(cid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        existed = _mgr_delete(_mgr_dir("recent"), cid)
    return web.json_response({"ok": True, "gone": cid, "existed": existed})


@PromptServer.instance.routes.post("/settings_hub/workflows/temp/gc")
async def workflows_temp_gc(request):
    """SERVER-AUTHORITATIVE GC of the temp snapshots (plan 3.6): a snapshot
    dies only when (a) NO recently-closed manifest references it and (b) it
    is older than TEMP_MAX_AGE_S. One browser's boot GC can therefore never
    delete a file another browser still points at. Returns the ids that
    were removed (for diagnostics/tests)."""
    now = int(time.time())
    removed = []
    async with _lock:
        _ensure_mgr_dirs()
        _recent_gc_locked()
        refs = _recent_refs()
        for root in _roots_all():
            for tid in _mgr_list(os.path.join(root, _TEMP_DIR_NAME)):
                if tid in refs:
                    continue
                it = _read_temp_file(tid)
                if it is None:
                    continue
                if now - int(it.get("ts", 0) or 0) <= TEMP_MAX_AGE_S:
                    continue
                if _delete_temp_file(tid):
                    removed.append(tid)
        # reference accounting: also apply the per-root MAX_TEMP_FILES cap
        _evict_temp_files()
    return web.json_response({"ok": True, "removed": removed,
                              "refs": sorted(_recent_refs())})


# ---------------------------------------------------------------------------
# v112 stage 2 (plan 4.x): the DERIVED SQLITE INDEX of the workflow library -
# search over names/paths/UUIDs/node types/model refs/contents, layered
# fingerprints, keyset pagination. py/workflows_index.py owns the logic;
# the routes below are the thin aiohttp shell. The index is rebuildable:
# the JSON files stay the source of truth.
# ---------------------------------------------------------------------------

try:
    from . import workflows_index as _wf_index  # the package import
except Exception:  # pragma: no cover - direct/test imports
    try:
        import workflows_index as _wf_index
    except Exception:
        _wf_index = None

if _wf_index is not None:
    _wf_index.set_db_path(os.path.join(_user_dir(), "settings_hub",
                                       MGR_DIR_NAME, "index",
                                       "workflow_index.db"))


def _request_user_scope(request):
    """The multi-user scope of a request (plan 4.2): the comfy-user header
    when it is a sane single segment - otherwise 'default'. Never a
    client-controlled filesystem path: it only scopes DB rows."""
    hdr = None
    try:
        hdr = request.headers.get("comfy-user") if request is not None else None
    except Exception:
        hdr = None
    if (isinstance(hdr, str) and hdr and not hdr.startswith(".")
            and not hdr.startswith("__") and "/" not in hdr and "\\" not in hdr
            and ".." not in hdr and hdr != "settings_hub"):
        return hdr
    return "default"


@PromptServer.instance.routes.get("/settings_hub/workflows/index/status")
async def workflows_index_status(request):
    """The index stats for the UI: files/errors/too-large counters, the last
    scan time, FTS availability, the normalization profile. Cheap - never
    walks the library."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    st = _wf_index.index_status(user_scope=scope)
    st["scope"] = scope
    return web.json_response(st)


@PromptServer.instance.routes.post("/settings_hub/workflows/index/scan")
async def workflows_index_scan(request):
    """ONE incremental scan pass (or a full rebuild with force:true). The
    walk runs in a WORKER THREAD (asyncio.to_thread) - the event loop stays
    responsive; concurrent scans collapse into the running one. Never
    touches the workflow JSON files."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    force = False
    try:
        body = await request.json()
        if isinstance(body, dict):
            force = bool(body.get("force"))
    except Exception:
        force = False
    roots = _workflows_user_dirs(request)
    hide_fn = _files_hide_dirs
    loop_ = asyncio.get_event_loop()
    try:
        stats = await loop_.run_in_executor(
            None, lambda: _wf_index.scan_index(
                workflows_user_dirs=roots, hide_dirs_fn=hide_fn,
                user_scope=scope, force=force))
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)
    return web.json_response(stats)


@PromptServer.instance.routes.get("/settings_hub/workflows/index/search")
async def workflows_index_search(request):
    """The paginated library query: q (FTS/LIKE), workflow_id, folder, sort
    + direction, size/date ranges, the favorites filter, a keyset cursor.
    The legacy /files route stays untouched - the old panels keep working."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    qp = request.query
    fav_only = qp.get("fav") in ("1", "true")
    favorites = _read_file_favs() if fav_only else None
    res = _wf_index.search_index(
        user_scope=scope,
        q=qp.get("q") or None,
        workflow_id=qp.get("workflow_id") or None,
        folder=qp.get("folder") or None,
        sort=qp.get("sort") or "mtime",
        direction=qp.get("direction") or "desc",
        limit=int(qp.get("limit") or 200),
        cursor=qp.get("cursor") or None,
        favorites=favorites,
        size_min=qp.get("size_min") if qp.get("size_min") else None,
        size_max=qp.get("size_max") if qp.get("size_max") else None,
        mtime_from=qp.get("mtime_from") if qp.get("mtime_from") else None,
        mtime_to=qp.get("mtime_to") if qp.get("mtime_to") else None,
    )
    res["ok"] = "error" not in res
    return web.json_response(res)


@PromptServer.instance.routes.get("/settings_hub/workflows/index/duplicates")
async def workflows_index_duplicates(request):
    """The plan 5.3 duplicate/similarity groups over the indexed library."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    res = _wf_index.duplicate_groups(user_scope=scope)
    res["ok"] = "error" not in res
    return web.json_response(res)


# ---------------------------------------------------------------------------
# v112 stage 2.5 (plan 5.x): the PROCESS HISTORY routes - linear
# Checkpoint/Restore histories in ONE shared store per user scope
# (py/workflows_history.py). The UI words are Process/History/Checkpoint/
# Restore - no storage terminology ever reaches the user.
# ---------------------------------------------------------------------------

try:
    from . import workflows_history as _wf_hist  # the package import
except Exception:  # pragma: no cover - direct/test imports
    try:
        import workflows_history as _wf_hist
    except Exception:
        _wf_hist = None

if _wf_hist is not None:
    _wf_hist.set_base_dir(os.path.join(_user_dir(), "settings_hub",
                                       MGR_DIR_NAME))


def _resolve_rel_path_from_request(raw):
    """The client may only reference a workflow by its LIBRARY-relative path
    ('workflows/<rel>' - the same shape the listings serve). Never an
    arbitrary filesystem path."""
    p = _clean_item_path(raw)
    return p


@PromptServer.instance.routes.get("/settings_hub/workflows/history/processes")
async def workflows_history_processes(request):
    """The process list (discovered from the indexed ComfyUI UUIDs) with the
    compact fields the row UI needs: names, revision counts, stable flags,
    per-location 'changes since checkpoint' statuses."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    procs = _wf_hist.list_processes()
    # the per-location 'changes since checkpoint' status: the index row hash
    # vs the process's current revision rawHash (plan 5.7.3)
    changed = {}
    if _wf_index is not None:
        try:
            import sqlite3
            conn = sqlite3.connect(_wf_index._db_path(), timeout=10)
            for row in conn.execute(
                    "SELECT rel_path, raw_hash FROM workflow_files "
                    "WHERE user_scope=?", (scope,)).fetchall():
                changed[row[0]] = row[1]
            conn.close()
        except Exception:
            changed = {}
    out = []
    for p in procs:
        cur = None
        if p.get("currentRevisionId"):
            cur = _wf_hist._read_revision(p["currentRevisionId"])
        locs = []
        for loc in p.get("locations") or []:
            cur_hash = changed.get(loc.get("path") or "")
            locs.append({
                "path": loc.get("path"),
                "isPrimary": bool(loc.get("isPrimary")),
                "mtimeNs": loc.get("mtimeNs"),
                "changesSinceCheckpoint": bool(cur and cur_hash and
                                               cur_hash != cur.get("rawHash")),
            })
        out.append({
            "processId": p["processId"],
            "workflowId": p.get("workflowId"),
            "displayName": p.get("displayName"),
            "note": p.get("note"),
            "archived": bool(p.get("archived")),
            "revisionCount": len(_wf_hist.list_revisions(p["processId"])),
            "hasCheckpoints": bool(p.get("currentRevisionId")),
            "stableRevisionId": p.get("stableRevisionId"),
            "updatedAt": p.get("updatedAt"),
            "locations": locs,
        })
    return web.json_response({"ok": True, "processes": out})


@PromptServer.instance.routes.get("/settings_hub/workflows/history/process/{pid}")
async def workflows_history_process_get(request):
    pid = request.match_info.get("pid", "")
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    p = _wf_hist.get_process(pid)
    if not p:
        return web.json_response({"ok": False, "error": "no such process"}, status=404)
    return web.json_response({"ok": True, "process": p})


@PromptServer.instance.routes.post("/settings_hub/workflows/history/process/{pid}/meta")
async def workflows_history_process_meta(request):
    """Set the display name / the shared note / the archived flag."""
    pid = request.match_info.get("pid", "")
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    r = _wf_hist.set_process_meta(
        pid,
        display_name=body.get("displayName") if isinstance(body, dict) else None,
        note=body.get("note") if isinstance(body, dict) else None,
        archived=body.get("archived") if isinstance(body, dict) else None)
    return web.json_response(r, status=200 if r.get("ok") else 404)


@PromptServer.instance.routes.post("/settings_hub/workflows/history/checkpoint")
async def workflows_history_checkpoint(request):
    """ONE manual Checkpoint. Body: {path?, graph?, note?, title?, source?}:
    - `graph` (the serialized OPEN TAB - the in-memory state incl. unsaved
      edits) takes priority (plan 5.7.2: never re-read the disk when the
      tab is modified);
    - without a graph, `path` checkpoints the DISK FILE (source 'disk').
    The workflow UUID is extracted from the payload itself - the process
    binding follows the plan 2.1 rules."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "bad body"}, status=400)
    rel_path = _resolve_rel_path_from_request(body.get("path"))
    note = body.get("note") if isinstance(body.get("note"), str) else None
    title = body.get("title") if isinstance(body.get("title"), str) else None
    source = "checkpoint"
    if body.get("source") in ("disk", "import", "restore"):
        source = body["source"]
    if isinstance(body.get("graph"), dict):
        try:
            data = json.dumps(body["graph"], ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            return web.json_response({"ok": False,
                                      "error": "the tab graph is not serializable"}, status=400)
    elif rel_path:
        # a DISK checkpoint: read the exact bytes of the library file
        data = None
        for wroot in _workflows_user_dirs(request):
            cand = os.path.join(wroot, rel_path[len("workflows/"):]
                                if rel_path.startswith("workflows/") else rel_path)
            cand = os.path.normpath(cand)
            if _is_inside(cand, wroot) and os.path.isfile(cand):
                try:
                    with open(cand, "rb") as fh:
                        data = fh.read()
                except OSError:
                    data = None
                break
        if data is None:
            return web.json_response({"ok": False, "error": "the file is gone"},
                                     status=404)
    else:
        return web.json_response(
            {"ok": False, "error": "a graph or a path is required"}, status=400)
    r = _wf_hist.record_checkpoint_for_path(rel_path, data, note=note,
                                            source=source, title=title)
    if not r.get("ok"):
        return web.json_response(r, status=500)
    # the Files index stays in sync after a history mutation
    return web.json_response(r)


@PromptServer.instance.routes.get("/settings_hub/workflows/history/resolve")
async def workflows_history_resolve(request):
    """The binding of ONE library path: the process + the statuses the row
    UI shows ('Checkpoint available' / 'Changes since checkpoint')."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    rel = _resolve_rel_path_from_request(request.query.get("path"))
    if not rel:
        return web.json_response({"ok": False, "error": "bad path"}, status=400)
    p = _wf_hist.resolve_path_process(rel)
    if not p:
        return web.json_response({"ok": True, "bound": False})
    cur = _wf_hist._read_revision(p.get("currentRevisionId")) \
        if p.get("currentRevisionId") else None
    # the disk hash from the index (fresh scan needed for accuracy)
    disk_hash = None
    if _wf_index is not None:
        try:
            import sqlite3
            scope = _request_user_scope(request)
            conn = sqlite3.connect(_wf_index._db_path(), timeout=10)
            row = conn.execute(
                "SELECT raw_hash FROM workflow_files WHERE user_scope=? AND "
                "rel_path=?", (scope, rel)).fetchone()
            conn.close()
            if row:
                disk_hash = row[0]
        except Exception:
            disk_hash = None
    return web.json_response({
        "ok": True,
        "bound": True,
        "process": {
            "processId": p["processId"],
            "workflowId": p.get("workflowId"),
            "displayName": p.get("displayName"),
            "note": p.get("note"),
            "revisionCount": len(_wf_hist.list_revisions(p["processId"])),
            "hasCheckpoints": bool(p.get("currentRevisionId")),
        },
        "changesSinceCheckpoint": bool(cur and disk_hash and
                                       disk_hash != cur.get("rawHash")),
    })


@PromptServer.instance.routes.get("/settings_hub/workflows/history/revision/{rid}/raw")
async def workflows_history_revision_raw(request):
    """The EXACT original bytes of one revision (integrity-checked)."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    rid = request.match_info.get("rid", "")
    data = _wf_hist.read_revision_bytes(rid)
    if data is None:
        return web.json_response({"ok": False, "error": "no readable revision"},
                                 status=404)
    return web.Response(body=data, content_type="application/json")


@PromptServer.instance.routes.post("/settings_hub/workflows/history/revision/{rid}/stable")
async def workflows_history_revision_stable(request):
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    rid = request.match_info.get("rid", "")
    stable = True
    try:
        body = await request.json()
        if isinstance(body, dict):
            stable = bool(body.get("stable", True))
    except Exception:
        pass
    return web.json_response(_wf_hist.mark_stable(rid, stable),
                             status=200 if True else 500)


@PromptServer.instance.routes.post("/settings_hub/workflows/history/revision/{rid}/note")
async def workflows_history_revision_note(request):
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    rid = request.match_info.get("rid", "")
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    note = body.get("note") if isinstance(body, dict) else None
    return web.json_response(_wf_hist.set_revision_note(rid, note))


@PromptServer.instance.routes.post("/settings_hub/workflows/history/revision/delete")
async def workflows_history_revision_delete(request):
    """v114 (owner request): the version-cleanup flow - delete SPECIFIC
    revisions of ONE or MORE processes in one call (the Process-history
    panel selects them with checkboxes + a dynamic Select all / Deselect
    all). The protection contract lives SERVER-side (the UI only grays the
    protected rows out): stable revisions and the CURRENT revision of a
    process are never deleted; a deleted revision is spliced out of the
    parent chain so the lineage stays linear."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    rids = body.get("revisionIds") if isinstance(body, dict) else None
    if not isinstance(rids, list):
        return web.json_response({"ok": False, "error": "revisionIds (a list) is required"},
                                 status=400)
    r = _wf_hist.delete_revisions(rids)
    return web.json_response(r, status=200 if r.get("ok") else 400)


@PromptServer.instance.routes.post("/settings_hub/workflows/history/process/{pid}/delete")
async def workflows_history_process_delete(request):
    """v115 (owner request): "кнопка удалять сами процессы со всеми
    хвостами" - erase the WHOLE process: every revision, the process
    manifest, every location binding and the CAS blobs no other revision
    references. Body {deleteFiles: true} ALSO removes the physical workflow
    files of every location - each file is safety-snapshotted (a tx copy
    with the 6h TTL) BEFORE the unlink and every per-file result is
    reported back so the UI can name exactly what happened. When the files
    are gone their derived-index rows are dropped too - a stale row would
    let the discovery reconcile resurrect the erased process from a ghost
    location on the next throttled pass."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    pid = request.match_info.get("pid", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    delete_files = bool(body.get("deleteFiles")) if isinstance(body, dict) else False

    def _remove_file(rel):
        """The remover the store calls for every location: validate the
        library-relative path against the REAL roots (never an arbitrary
        filesystem path), snapshot the bytes, then unlink. A missing file
        is a fine outcome (already gone); a failure is reported, never
        raised - the process erasure itself must not wedge."""
        res = {"path": rel, "removed": False, "snapshot": None}
        if not isinstance(rel, str) or not rel.startswith("workflows/"):
            res["error"] = "outside the workflows library"
            return res
        target = None
        for wroot in _workflows_user_dirs(request):
            cand = os.path.normpath(os.path.join(
                wroot, rel[len("workflows/"):]))
            if _is_inside(cand, wroot):
                target = cand
                break
        if not target:
            res["error"] = "the path escapes the library"
            return res
        if not os.path.isfile(target):
            res["reason"] = "missing"   # already gone - not an error
            return res
        try:
            with open(target, "rb") as fh:
                old = fh.read()
        except OSError as e:
            res["error"] = "read failed: " + str(e)[:100]
            return res
        tx = _wf_hist.make_tx_snapshot(rel, old)
        if not tx.get("ok"):
            res["error"] = ("the safety snapshot failed: "
                            + str(tx.get("error", "?"))[:100])
            return res
        res["snapshot"] = tx.get("txId")
        try:
            os.remove(target)
            res["removed"] = True
            res["bytes"] = len(old)
        except OSError as e:
            res["error"] = "remove failed: " + str(e)[:100]
        return res

    r = _wf_hist.delete_process(pid, delete_files=delete_files,
                                file_remover=_remove_file if delete_files else None)
    if not r.get("ok"):
        return web.json_response(r, status=400)
    dropped = 0
    if delete_files and _wf_index is not None:
        try:
            gone = [f.get("path") for f in r.get("files") or [] if f.get("removed")]
            if gone:
                fr = _wf_index.forget_paths(
                    user_scope=_request_user_scope(request), rel_paths=gone)
                dropped = int(fr.get("removed") or 0)
        except Exception:
            dropped = 0   # the scan's own prune pass is the safety net
    r["indexRowsDropped"] = dropped
    return web.json_response(r, status=200)


@PromptServer.instance.routes.get("/settings_hub/workflows/history/badges")
async def workflows_history_badges(request):
    """v114 (owner request): the version INDICATOR for the Files rows - the
    user must see at a glance which workflows carry saved versions. One
    small answer for the whole tab: {rel_path: {count, stable}} for the
    processes that HAVE revisions (the rest costs nothing). An old pack
    without this route simply shows no badges."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    try:
        badges = _wf_hist.revision_badges()
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)
    return web.json_response({"ok": True, "badges": badges})


@PromptServer.instance.routes.post("/settings_hub/workflows/history/process/{pid}/restore/{rid}")
async def workflows_history_restore(request):
    """Restore a revision. mode 'open-copy' (DEFAULT - never writes) returns
    the exact bytes for the client to open as an independent tab. mode
    'replace' + path OVERWRITES the file: the transaction safety snapshot is
    MANDATORY first (a preflight failure refuses the replace), then an
    atomic tmp+fsync+replace write, rollback from the snapshot on failure."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    pid = request.match_info.get("pid", "")
    rid = request.match_info.get("rid", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    mode = (body.get("mode") if isinstance(body, dict) else None) or "open-copy"
    data = _wf_hist.read_revision_bytes(rid)
    if data is None:
        return web.json_response({"ok": False, "error": "no readable revision"},
                                 status=404)
    if mode == "open-copy":
        return web.Response(body=data, content_type="application/json")
    rel = _resolve_rel_path_from_request(body.get("path") if isinstance(body, dict) else None)
    if not rel:
        return web.json_response({"ok": False, "error": "replace needs a path"}, status=400)
    # 1) the transaction safety snapshot BEFORE any destructive step
    old = None
    for wroot in _workflows_user_dirs(request):
        cand = os.path.join(wroot, rel[len("workflows/"):]
                            if rel.startswith("workflows/") else rel)
        cand = os.path.normpath(cand)
        if _is_inside(cand, wroot) and os.path.isfile(cand):
            try:
                with open(cand, "rb") as fh:
                    old = fh.read()
            except OSError:
                old = None
            break
    tx = _wf_hist.make_tx_snapshot(rel, old if old is not None else b"")
    if not tx.get("ok"):
        return web.json_response(
            {"ok": False, "error": "the safety snapshot failed: " + tx.get("error", "?")},
            status=500)
    # 2) the atomic replace (tmp + fsync + os.replace)
    target = None
    for wroot in _workflows_user_dirs(request):
        cand = os.path.join(wroot, rel[len("workflows/"):]
                            if rel.startswith("workflows/") else rel)
        cand = os.path.normpath(cand)
        if _is_inside(cand, wroot):
            target = cand
            break
    if not target:
        return web.json_response({"ok": False, "error": "the path escapes the library"},
                                 status=400)
    tmp = target + ".restore-tmp"
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)
    except Exception as e:
        # 3) the rollback from the verified snapshot
        rolled = False
        snap = _wf_hist.read_tx_snapshot(tx.get("txId"))
        if snap is not None and os.path.isfile(target):
            try:
                with open(target, "wb") as fh:
                    fh.write(snap)
                    fh.flush()
                    os.fsync(fh.fileno())
                rolled = True
            except OSError:
                rolled = False
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return web.json_response({
            "ok": False,
            "error": "the replace failed (" + str(e)[:120] + ")"
                     + (" - rolled back from the safety snapshot" if rolled else
                        " - the safety snapshot " + str(tx.get("txId")) + " is kept"),
            "txId": tx.get("txId"),
        }, status=500)
    return web.json_response({"ok": True, "mode": "replace", "path": rel,
                              "txId": tx.get("txId"),
                              "rollbackAvailable": True})


@PromptServer.instance.routes.post("/settings_hub/workflows/history/process/{pid}/import")
async def workflows_history_import_disk(request):
    """'Import as checkpoint' (plan 5.2): add the CURRENT disk bytes of a
    location into the process history - an explicit user action only."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    pid = request.match_info.get("pid", "")
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    rel = _resolve_rel_path_from_request(body.get("path") if isinstance(body, dict) else None)
    if not rel:
        return web.json_response({"ok": False, "error": "a library path is required"},
                                 status=400)
    data = None
    for wroot in _workflows_user_dirs(request):
        cand = os.path.join(wroot, rel[len("workflows/"):]
                            if rel.startswith("workflows/") else rel)
        cand = os.path.normpath(cand)
        if _is_inside(cand, wroot) and os.path.isfile(cand):
            try:
                with open(cand, "rb") as fh:
                    data = fh.read()
            except OSError:
                data = None
            break
    if data is None:
        return web.json_response({"ok": False, "error": "the file is gone"}, status=404)
    note = body.get("note") if isinstance(body, dict) else None
    r = _wf_hist.record_checkpoint_for_path(rel, data, note=note,
                                            source="import",
                                            title=(body.get("title") if isinstance(body, dict) else None))
    return web.json_response(r, status=200 if r.get("ok") else 500)


@PromptServer.instance.routes.get("/settings_hub/workflows/history/storage")
async def workflows_history_storage(request):
    """The transparent storage stats (plan: the size shows the COMPRESSED
    physical bytes, never the uncompressed sum)."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    return web.json_response(_wf_hist.storage_stats())


@PromptServer.instance.routes.post("/settings_hub/workflows/history/maintenance")
async def workflows_history_maintenance(request):
    """Housekeeping outside the checkpoint critical section."""
    if _wf_hist is None:
        return web.json_response({"ok": False, "error": "history module unavailable"},
                                 status=404)
    return web.json_response(_wf_hist.run_maintenance())


# ---------------------------------------------------------------------------
# v112 stage 4 (plan 10): the PRESET VERSION routes - the metadata list, the
# payload read, the restore. The restore ARCHIVES the current first (the
# rollback stays possible) and never trims the current version.
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/settings_hub/workflows/preset/{pid}/versions")
async def workflows_preset_versions(request):
    """The revision METADATA list of ONE preset (newest first) - no graph
    payloads; the payload loads for a restore/compare only."""
    pid = request.match_info.get("pid", "")
    if not _ID_LOOSE_RE.match(pid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    if _load_preset_file(pid) is None:
        return web.json_response({"ok": False, "error": "no such preset"}, status=404)
    return web.json_response({"ok": True, "presetId": pid,
                              "versions": _list_preset_versions(pid),
                              "maxVersions": MAX_PRESET_VERSIONS})


@PromptServer.instance.routes.get("/settings_hub/workflows/preset/{pid}/version/{rid}")
async def workflows_preset_version_get(request):
    """ONE archived revision: the FULL previous preset object (the client
    compares/restores from it)."""
    pid = request.match_info.get("pid", "")
    rid = request.match_info.get("rid", "")
    if not _ID_LOOSE_RE.match(pid) or not _ID_RE.match(rid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    rec = _read_preset_version(pid, rid)
    if not rec:
        return web.json_response({"ok": False, "error": "no such version"}, status=404)
    return web.json_response({"ok": True, "revisionId": rid,
                              "createdAt": rec.get("createdAt"),
                              "changedBy": rec.get("changedBy"),
                              "preset": rec.get("preset")})


@PromptServer.instance.routes.post("/settings_hub/workflows/preset/{pid}/restore/{rid}")
async def workflows_preset_version_restore(request):
    """Restore ONE revision: the CURRENT preset archives itself FIRST (the
    rollback is guaranteed), then the chosen revision becomes the current.
    The version files are immutable - a restore never edits them."""
    pid = request.match_info.get("pid", "")
    rid = request.match_info.get("rid", "")
    if not _ID_LOOSE_RE.match(pid) or not _ID_RE.match(rid):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        _migrate_legacy_file()
        cur = _load_preset_file(pid)
        if cur is None:
            return web.json_response({"ok": False, "error": "no such preset"}, status=404)
        rec = _read_preset_version(pid, rid)
        if not rec:
            return web.json_response({"ok": False, "error": "no such version"}, status=404)
        prev = rec.get("preset")
        if not isinstance(prev, dict) or not isinstance(prev.get("items"), list):
            return web.json_response({"ok": False, "error": "the version payload is damaged"},
                                     status=500)
        # 1) the current state archives FIRST (the plan: rollback-safe)
        archive_rid, err = _archive_preset_version(pid, "restore")
        if err:
            return web.json_response({"ok": False, "error": "the pre-restore archive failed: " + err},
                                     status=500)
        # 2) the chosen revision becomes the current (the ids/updated stay)
        restored = dict(prev)
        restored["id"] = pid
        restored["updated"] = int(time.time())
        _write_preset_file(restored)
        _prune_preset_versions(pid)
    return web.json_response({"ok": True, "presetId": pid,
                              "restoredFrom": rid, "archivedAs": archive_rid,
                              "preset": restored})


# ---------------------------------------------------------------------------
# v112 stage 5 (plan 11): the WORKFLOW INSPECTOR + DEPENDENCY CHECK routes -
# honest diagnostics for one file: identity, structure, models, parameters
# (only when they extract unambiguously), duplicate groups, missing nodes /
# models. Diagnostics only - never blocks an open.
# ---------------------------------------------------------------------------

def _node_registry():
    """The installed node classes (feature-detected; an absent registry
    means the dependency check reports unknown/unknown instead of guessing)."""
    try:
        from nodes import NODE_CLASS_MAPPINGS  # the ComfyUI runtime
        return set(str(k) for k in (NODE_CLASS_MAPPINGS or {}).keys())
    except Exception:
        return None


def _model_lookup(names):
    """The model-file existence check via folder_paths (feature-detected).
    Returns {name: bool} for the names whose folder we could actually
    probe; unknown names stay unchecked (status 'unknown')."""
    out = {}
    if not names:
        return out
    try:
        import folder_paths
        get_full = getattr(folder_paths, "get_full_path", None)
        if not callable(get_full):
            return out
        for name in names:
            found = None
            for folder in ("checkpoints", "loras", "vae", "controlnet",
                           "upscale_models", "unet", "clip", "style_models",
                           "hypernetworks", "gligen", "ipadapter", "instantid"):
                try:
                    p = get_full(folder, name)
                except Exception:
                    p = None
                if p and os.path.isfile(p):
                    found = folder
                    break
            if found is not None:
                out[name] = True
            # an unprobed name stays absent from the map (status 'unknown')
    except Exception:
        pass
    return out


@PromptServer.instance.routes.get("/settings_hub/workflows/index/inspect")
async def workflows_index_inspect(request):
    """Inspect ONE library file: identity + structure + models + parameters
    + duplicate groups + the dependency report."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    rel = _resolve_rel_path_from_request(request.query.get("path"))
    if not rel:
        return web.json_response({"ok": False, "error": "bad path"}, status=400)
    scope = _request_user_scope(request)
    # read the EXACT file bytes from the library
    data = None
    for wroot in _workflows_user_dirs(request):
        cand = os.path.join(wroot, rel[len("workflows/"):]
                            if rel.startswith("workflows/") else rel)
        cand = os.path.normpath(cand)
        if _is_inside(cand, wroot) and os.path.isfile(cand):
            try:
                with open(cand, "rb") as fh:
                    data = fh.read()
            except OSError:
                data = None
            break
    if data is None:
        return web.json_response({"ok": False, "error": "the file is gone"}, status=404)
    payload = _wf_index.inspect_payload(data)
    payload["path"] = rel
    payload["name"] = rel.rsplit("/", 1)[-1]
    # the duplicate/similarity groups this file belongs to (from the index)
    if data is not None and payload["hashes"].get("raw_hash"):
        groups = _wf_index.duplicate_groups(user_scope=scope)
        h = payload["hashes"]
        dupes = {}
        try:
            import sqlite3
            conn = sqlite3.connect(_wf_index._db_path(), timeout=10)
            for label, col, val in (
                    ("exactCopies", "raw_hash", h.get("raw_hash")),
                    ("sameJson", "canonical_hash", h.get("canonical_hash")),
                    ("sameWorkflow", "workflow_hash", h.get("workflow_hash"))):
                if val:
                    row = conn.execute(
                        "SELECT count(*) FROM workflow_files WHERE user_scope=? "
                        "AND %s=?" % col, (scope, val)).fetchone()
                    dupes[label] = max(0, int(row[0] or 0) - 1)
            # same UUID, different content
            if payload.get("workflowId"):
                row = conn.execute(
                    "SELECT count(DISTINCT workflow_hash) FROM workflow_files "
                    "WHERE user_scope=? AND workflow_id=?",
                    (scope, payload["workflowId"])).fetchone()
                dupes["sameUuidDiffContent"] = max(0, int(row[0] or 0) - 1)
            conn.close()
        except Exception:
            dupes = {}
        payload["groups"] = dupes
    # the dependency check (feature-detected registry + models folders)
    registry = _node_registry()
    mlookup = _model_lookup(payload.get("models") or [])
    payload["deps"] = _wf_index.dependency_report(
        payload.get("nodeTypes") or [], payload.get("models") or [],
        registry=registry, model_lookup=mlookup)
    payload["depsRegistryKnown"] = registry is not None
    payload["ok"] = True
    return web.json_response(payload)


@PromptServer.instance.routes.get("/settings_hub/workflows/index/summary")
async def workflows_index_summary(request):
    """The LIBRARY SUMMARY (plan 12 P3): the counts of the duplicate/
    similarity groups, the no-UUID files, the broken JSONs."""
    if _wf_index is None:
        return web.json_response({"ok": False, "error": "index module unavailable"},
                                 status=404)
    scope = _request_user_scope(request)
    d = _wf_index.duplicate_groups(user_scope=scope)
    st = _wf_index.index_status(user_scope=scope)
    return web.json_response({
        "ok": True,
        "files": st.get("files", 0),
        "errors": st.get("errors", 0),
        "tooLarge": st.get("too_large", 0),
        "exactCopyGroups": len(d.get("exactCopies") or []),
        "sameJsonGroups": len(d.get("sameJsonContent") or []),
        "sameWorkflowDiffCanvas": len(d.get("sameWorkflowDiffCanvas") or []),
        "sameUuidDiffContent": len(d.get("sameUuidDiffContent") or []),
        "noUuidFiles": d.get("noUuidCount", 0),
        "lastScan": st.get("last_scan", 0),
    })
