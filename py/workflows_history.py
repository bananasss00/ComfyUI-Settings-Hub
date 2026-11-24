"""v112 stage 2.5: the WORKFLOW HISTORY STORE (plan 5.x) - linear
Process -> Revision histories with manual Checkpoints, backed by ONE shared
repository per user scope.

THE CONTRACT (plan 5.6.2, hard requirements):
  * exactly ONE shared store per user scope - NO per-process repositories,
    branches, refs or worktrees; processes and Preset histories share the
    same object database;
  * the user NEVER sees Git terminology - the UI words are Process,
    History, Checkpoint, Restore (this module's identifiers stay internal);
  * an ordinary ComfyUI Save creates NOTHING here - only the explicit
    Checkpoint / Import / manager-controlled restore points do;
  * revisions store the EXACT original bytes (raw), never a normalized form;
  * a failed/degraded store must surface an error, never fake success.

BACKENDS (the Stage-0 benchmark decision - Git preferred, CAS fallback,
identical UX):
  git  - one BARE repository <user>/settings_hub/workflows_manager/history.git,
         ONE history ref (refs/heads/history); every Checkpoint writes
         blob(processes/<pid>/current.json) + catalog/revision/<rid>.json
         into a tree and moves the shared ref forward (a parent-linked
         linear chain); content-addressed blobs dedupe identical content
         across ALL processes automatically;
  cas  - zlib-compressed blobs under history/cas/<sha256>.z (raw bytes),
         revision manifests under catalog/revisions/<rid>.json with
         parent links - the same logical model when the git binary is
         unavailable.

LAYOUT (per user scope, inside workflows_manager/ - outside every workflow
root and the re-pointable presets root):
  history.git/            (git backend) OR history/cas/<sha>.z (cas backend)
  history/catalog/processes/<pid>.json    - durable process manifests
  history/catalog/revisions/<rid>.json    - durable revision manifests
  history/temp/tx/                        - transaction safety snapshots (TTL)
  history/index.json                      - a tiny root manifest {backend}

Crash safety: writes are tmp + fsync + os.replace; the git ref update is
the LAST step of a checkpoint (an interrupted run leaves orphan objects
that git gc prunes later - the catalog manifest is only written after the
object storage confirmed the write).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import zlib

try:
    from . import workflows_index as _wf_index  # the package import
except Exception:  # pragma: no cover
    try:
        import workflows_index as _wf_index
    except Exception:
        _wf_index = None

# ---------------------------------------------------------------------------
# Limits / constants
# ---------------------------------------------------------------------------

HIST_DIR_NAME = "history"
MAX_REVISION_BYTES = 24 * 1024 * 1024   # a checkpoint payload budget
# v116 (plan 5.3/11.1): this is a SOFT advisory bound, NOT a hard limit and
# NOT an auto-pruning rule - user checkpoints are NEVER deleted behind the
# user's back. create_revision answers a `warning` field when a process
# crosses the bound (the UI shows it once); the actual retention stays
# entirely the user's decision (Manage versions / Delete process).
MAX_REVISIONS_PER_PROCESS = 500
MAX_REVISIONS_WARN_AFTER = 500
MAX_PROCESS_NAME_CHARS = 120
MAX_NOTE_CHARS = 2000
TX_SNAPSHOT_TTL_S = 6 * 60 * 60         # transaction safety snapshots TTL
TX_MAX_FILES = 40
GIT_REF = "refs/heads/history"          # the ONE shared ref (plan 5.6.2)
# v116 (plan 3.6): the explicit batch cap of the revision-delete endpoint -
# a larger payload is REFUSED (400), never silently truncated.
DELETE_REVISIONS_MAX = 1000
_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")
# v116 (plan 3.3): the reconcile batch size - the index rows are processed
# in chunks so one pass over a huge library never holds the store lock for
# a single unbounded stretch.
RECONCILE_BATCH = 1000

_lock = threading.RLock()               # ALL store mutations serialize


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _now():
    return int(time.time())


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_base_override = [None]


def set_base_dir(path):
    """Inject the base dir (the routes call this at import; tests inject a
    temp dir). <base>/history.git, <base>/history/catalog/... live under it."""
    _base_override[0] = os.path.abspath(path)


def _base():
    if _base_override[0]:
        return _base_override[0]
    if os.environ.get("SHUB_WF_USER_DIR_OVERRIDE"):
        return os.path.join(os.environ["SHUB_WF_USER_DIR_OVERRIDE"],
                            "settings_hub", "workflows_manager")
    return os.path.join(os.getcwd(), "user", "settings_hub",
                        "workflows_manager")


def _hist_dir(*parts):
    return os.path.join(_base(), HIST_DIR_NAME, *parts)


def _git_dir():
    return os.path.join(_base(), "history.git")


def _process_file(pid):
    return _hist_dir("catalog", "processes", pid + ".json")


def _revision_file(rid):
    return _hist_dir("catalog", "revisions", rid + ".json")


def _tx_dir():
    return _hist_dir("temp", "tx")


def _atomic_write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Backend selection + initialization
# ---------------------------------------------------------------------------

_backend_cache = {"resolved": None, "kind": None}


def _git_available():
    try:
        r = subprocess.run(["git", "--version"], capture_output=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def _resolve_backend():
    """Git preferred (the Stage-0 benchmark: size parity + delta on
    incremental edits + crash-safe ref updates); the CAS fallback keeps the
    identical UX when the git binary is missing.
    v116: the resolution SELF-HEALS - a store folder deleted behind the
    running process (the test phases clean between sections; an owner may
    too) re-initializes on the next touch instead of failing every write
    with 'the history store refused the write'."""
    with _lock:
        if _backend_cache["resolved"]:
            kind = _backend_cache["kind"]
            if kind == "git" and not os.path.isdir(_git_dir()):
                _backend_cache["resolved"] = False   # re-init below
            else:
                os.makedirs(_hist_dir("catalog", "processes"), exist_ok=True)
                os.makedirs(_hist_dir("catalog", "revisions"), exist_ok=True)
                os.makedirs(_tx_dir(), exist_ok=True)
                return kind
        root_manifest = _read_json(_hist_dir("index.json"))
        if root_manifest and root_manifest.get("backend") in ("git", "cas"):
            kind = root_manifest["backend"]
        else:
            kind = "git" if _git_available() else "cas"
            _atomic_write_json(_hist_dir("index.json"),
                               {"backend": kind, "created": _now()})
        if kind == "git":
            if not os.path.isdir(_git_dir()):
                env = dict(os.environ, GIT_AUTHOR_NAME="settings-hub",
                           GIT_AUTHOR_EMAIL="settings-hub@local",
                           GIT_COMMITTER_NAME="settings-hub",
                           GIT_COMMITTER_EMAIL="settings-hub@local")
                try:
                    subprocess.run(["git", "init", "--bare", "-q", _git_dir()],
                                   check=True, capture_output=True, env=env)
                    subprocess.run(["git", "--git-dir", _git_dir(), "config",
                                    "core.compression", "9"],
                                   check=True, capture_output=True, env=env)
                except Exception:
                    kind = "cas"
                    _atomic_write_json(_hist_dir("index.json"),
                                       {"backend": kind, "created": _now()})
        os.makedirs(_hist_dir("catalog", "processes"), exist_ok=True)
        os.makedirs(_hist_dir("catalog", "revisions"), exist_ok=True)
        os.makedirs(_tx_dir(), exist_ok=True)
        _backend_cache["resolved"] = True
        _backend_cache["kind"] = kind
        return kind


def backend_kind():
    return _resolve_backend()


# ---------------------------------------------------------------------------
# Git plumbing (fast, no worktree - plan 5.6.2)
# ---------------------------------------------------------------------------

def _git_env():
    return dict(os.environ, GIT_AUTHOR_NAME="settings-hub",
                GIT_AUTHOR_EMAIL="settings-hub@local",
                GIT_COMMITTER_NAME="settings-hub",
                GIT_COMMITTER_EMAIL="settings-hub@local")


def _git(*args, inp=None):
    return subprocess.run(["git", "--git-dir", _git_dir()] + list(args),
                          capture_output=True, env=_git_env(),
                          input=inp, timeout=60)


def _git_write_blob(data):
    """Write a blob; returns the OID or None."""
    r = _git("hash-object", "-w", "--stdin", inp=data)
    if r.returncode != 0:
        return None
    return r.stdout.decode().strip()


def _git_write_tree(entries):
    """entries: [(mode, oid, name)] -> tree OID. The mktree input format is
    `<mode> SP <type> SP <sha1> TAB <name>` - the type field is REQUIRED."""
    lines = "".join("%s blob %s\t%s\n" % (mode, oid, name) for mode, oid, name in entries)
    r = _git("mktree", inp=lines.encode())
    if r.returncode != 0:
        return None
    return r.stdout.decode().strip()


def _git_commit_tree(tree_oid, parent, message):
    args = ["commit-tree", tree_oid, "-m", message]
    if parent:
        args += ["-p", parent]
    r = _git(*args)
    if r.returncode != 0:
        return None
    return r.stdout.decode().strip()


def _git_update_ref(commit_oid):
    r = _git("update-ref", GIT_REF, commit_oid)
    return r.returncode == 0


def _git_head():
    r = _git("rev-parse", "--verify", GIT_REF)
    if r.returncode != 0:
        return None
    return r.stdout.decode().strip()


def _git_read_blob(oid):
    r = _git("cat-file", "blob", oid)
    if r.returncode != 0:
        return None
    return r.stdout


def _git_dir_size():
    total = 0
    for dp, _dn, fns in os.walk(_git_dir()):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


# ---------------------------------------------------------------------------
# CAS plumbing
# ---------------------------------------------------------------------------

def _cas_write(data):
    oid = _sha256(data)
    path = _hist_dir("cas", oid[:2], oid + ".z")
    if os.path.isfile(path):
        return oid  # content-addressed dedupe
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(zlib.compress(data, 9))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return oid


def _cas_read(oid):
    if not isinstance(oid, str) or not _ID_RE.match(oid):
        return None
    path = _hist_dir("cas", oid[:2], oid + ".z")
    try:
        with open(path, "rb") as f:
            return zlib.decompress(f.read())
    except Exception:
        return None


def _cas_size():
    total = 0
    cas = _hist_dir("cas")
    for dp, _dn, fns in os.walk(cas):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


# ---------------------------------------------------------------------------
# Catalog primitives
# ---------------------------------------------------------------------------

def _sanitize_name(raw, cap=MAX_PROCESS_NAME_CHARS):
    if not isinstance(raw, str):
        return None
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", raw).strip()
    return cleaned[:cap] or None


def _new_id():
    return uuid.uuid4().hex[:16]


# v113: in-memory catalog cache. The v112 flows re-read every process
# manifest per lookup (O(N^2) inside reconcile: _ensure_process scanned ALL
# manifests once PER index row) and re-wrote every manifest on each pass
# (fsync per row) - with a 2000-process library that turned ONE open of the
# history panel into thousands of file reads + thousands of atomic writes.
# The cache is built lazily in ONE pass and is maintained by every mutation
# in THIS module (the only writer of the catalog); an external file-set
# change (a manifest added/removed by hand) is picked up through the
# listdir-signature check on the reconcile TTL tick.
# v116 (plan 3.3/4.5): the uuid/path maps are keyed by USER SCOPE - two
# ComfyUI users' same-named files (and same-UUID files!) must never bind to
# each other's process. The manifests carry a `scope` field (older files
# without one read as 'default' - the single-user install keeps every
# existing binding). The process file NAME space stays flat (globally
# unique hex ids) - no data migration is needed.
_proc_cache = {"loaded": False, "by_pid": {}, "by_uuid": {}, "by_path": {},
               "paths_of": {}, "sig": None}


def _proc_sig():
    try:
        return sorted(os.listdir(_hist_dir("catalog", "processes")))
    except OSError:
        return []


def _manifest_scope(p):
    """The user scope of a process manifest (plan 4.5). Older manifests
    carry no scope field - they belong to the 'default' scope, which is the
    only scope a single-user ComfyUI ever produces."""
    s = (p or {}).get("scope")
    return s if isinstance(s, str) and s else "default"


def _cache_load_locked(force=False):
    """ONE pass over the process manifests -> pid/uuid/path maps. Sorted
    order keeps the binding pick deterministic (v112 iterated listdir
    order, which is arbitrary). v116: the uuid + path maps are
    scope-partitioned {scope: {key: pid}}."""
    sig = _proc_sig()
    if _proc_cache["loaded"] and not force and sig == _proc_cache["sig"]:
        return
    by_pid, by_uuid, by_path, paths_of = {}, {}, {}, {}
    for pid in sorted(_list_ids(_hist_dir("catalog", "processes"))):
        p = _read_json(_process_file(pid))
        if not p or p.get("processId") != pid:
            continue
        by_pid[pid] = p
        scope = _manifest_scope(p)
        wid = p.get("workflowId")
        if isinstance(wid, str) and wid:
            by_uuid.setdefault(scope, {})
            if wid not in by_uuid[scope]:
                by_uuid[scope][wid] = pid
        pths = set()
        for loc in p.get("locations") or []:
            lp = loc.get("path")
            if isinstance(lp, str) and lp:
                by_path.setdefault(scope, {})
                if lp not in by_path[scope]:
                    by_path[scope][lp] = pid
                pths.add(lp)
        paths_of[pid] = pths
    _proc_cache["by_pid"] = by_pid
    _proc_cache["by_uuid"] = by_uuid
    _proc_cache["by_path"] = by_path
    _proc_cache["paths_of"] = paths_of
    _proc_cache["sig"] = sig
    _proc_cache["loaded"] = True


def _cache_put_locked(p):
    """Keep the maps in sync after THIS module writes a process manifest.
    v116 (plan 3.3): the NEW location list is AUTHORITATIVE - the path map
    claims every listed path unconditionally (overwriting a stale binding
    another process still holds), and the process's OLD paths that fell out
    of the list are released. A UUID change therefore can never leave the
    same path bound to two processes."""
    pid = p.get("processId")
    if not isinstance(pid, str):
        return
    _proc_cache["loaded"] = True
    scope = _manifest_scope(p)
    # keep the file-set signature incremental (a NEW process must not force
    # a full cache rebuild on the next reconcile tick)
    fname = pid + ".json"
    sig = _proc_cache["sig"]
    if not isinstance(sig, list):
        sig = []
    if fname not in sig:
        sig = sorted(sig + [fname])
    _proc_cache["sig"] = sig
    old = _proc_cache["by_pid"].get(pid)
    if old is not None and old is not p:
        for lp in (_proc_cache["paths_of"].get(pid) or set()):
            if _proc_cache["by_path"].get(scope, {}).get(lp) == pid:
                _proc_cache["by_path"][scope].pop(lp, None)
    by_uuid = _proc_cache["by_uuid"].setdefault(scope, {})
    wid = p.get("workflowId")
    if isinstance(wid, str) and wid:
        cur = by_uuid.get(wid)
        if cur is None or cur == pid or _proc_cache["by_pid"].get(cur) is None:
            by_uuid[wid] = pid
    elif old is not None and old.get("workflowId"):
        # the workflowId was cleared - drop the binding
        if by_uuid.get(old["workflowId"]) == pid:
            by_uuid.pop(old["workflowId"], None)
    _proc_cache["by_pid"][pid] = p
    by_path = _proc_cache["by_path"].setdefault(scope, {})
    pths = set()
    for loc in p.get("locations") or []:
        lp = loc.get("path")
        if isinstance(lp, str) and lp:
            pths.add(lp)
            by_path[lp] = pid   # authoritative - overwrite any stale claim
    _proc_cache["paths_of"][pid] = pths


# v113: the same idea for revision manifests - list_revisions() walked the
# parent chain (fine) but then scanned + re-read EVERY revision manifest in
# the store to catch crash-orphaned branches; with thousands of revisions
# that is a per-open file storm. One lazy pass + the same signature guard.
_rev_cache = {"loaded": False, "by_rid": {}, "of_pid": {}, "sig": None}


def _rev_sig():
    try:
        return sorted(os.listdir(_hist_dir("catalog", "revisions")))
    except OSError:
        return []


def _rev_cache_load_locked(force=False):
    sig = _rev_sig()
    if _rev_cache["loaded"] and not force and sig == _rev_cache["sig"]:
        return
    by_rid, of_pid = {}, {}
    for rid in sorted(_list_ids(_hist_dir("catalog", "revisions"))):
        r = _read_json(_revision_file(rid))
        if not r or r.get("revisionId") != rid:
            continue
        by_rid[rid] = r
        pid = r.get("processId")
        if isinstance(pid, str):
            of_pid.setdefault(pid, []).append(r)
    _rev_cache["by_rid"] = by_rid
    _rev_cache["of_pid"] = of_pid
    _rev_cache["sig"] = sig
    _rev_cache["loaded"] = True


def _rev_cache_put_locked(rec):
    rid = rec.get("revisionId")
    if not isinstance(rid, str):
        return
    _rev_cache["loaded"] = True
    fname = rid + ".json"
    sig = _rev_cache["sig"]
    if not isinstance(sig, list):
        sig = []
    if fname not in sig:
        sig = sorted(sig + [fname])
    _rev_cache["sig"] = sig
    pid = rec.get("processId")
    _rev_cache["by_rid"][rid] = rec
    if isinstance(pid, str):
        lst = _rev_cache["of_pid"].setdefault(pid, [])
        for i, r in enumerate(lst):
            if r.get("revisionId") == rid:
                lst[i] = rec
                break
        else:
            lst.append(rec)


def _rev_cache_drop_locked(rid):
    _rev_cache["by_rid"].pop(rid, None)
    for pid, lst in list(_rev_cache["of_pid"].items()):
        lst2 = [r for r in lst if r.get("revisionId") != rid]
        if lst2:
            _rev_cache["of_pid"][pid] = lst2
        else:
            # v115: the LAST revision of a process must not leave an empty
            # shell under of_pid - the badges walk and delete_process treat
            # "key present" as "process has revisions"
            _rev_cache["of_pid"].pop(pid, None)
    sig = _rev_cache["sig"]
    if isinstance(sig, list):
        _rev_cache["sig"] = [n for n in sig if n != rid + ".json"]
    else:
        _rev_cache["sig"] = None  # the file set changed - reload on next use


def _read_process(pid):
    if not isinstance(pid, str) or not _ID_RE.match(pid):
        return None
    with _lock:
        _cache_load_locked()
        p = _proc_cache["by_pid"].get(pid)
        if p is not None:
            return p
    return _read_json(_process_file(pid))  # not cached yet - the direct read


def _read_revision(rid):
    if not isinstance(rid, str) or not _ID_RE.match(rid):
        return None
    with _lock:
        _rev_cache_load_locked()
        r = _rev_cache["by_rid"].get(rid)
        if r is not None:
            return r
    return _read_json(_revision_file(rid))


def _list_ids(folder):
    try:
        return [n[:-len(".json")] for n in os.listdir(folder)
                if n.endswith(".json")]
    except OSError:
        return []


def list_processes(scope="default"):
    """All process manifests, newest-activity first. Reconciles the file
    bindings from the derived index first (the processes are DISCOVERED
    from the ComfyUI UUIDs the index extracted - plan 5.1). v113: served
    from the in-memory catalog cache (one disk pass per session instead of
    a full re-read per call - the route stays instant with 2000+ processes).
    v116 (plan 4.5): the list is SCOPE-filtered - one shared storage root
    must never mix different users' processes."""
    with _lock:
        _resolve_backend()
        reconcile_processes(scope)
        _cache_load_locked()
        out = [p for p in _proc_cache["by_pid"].values()
               if p and p.get("processId") and _manifest_scope(p) == scope]
        out.sort(key=lambda p: -(p.get("updatedAt") or 0))
        return out


def get_process(pid):
    with _lock:
        _resolve_backend()
        reconcile_processes(_manifest_scope(_read_process(pid))
                            if _read_process(pid) else "default")
        p = _read_process(pid)
        if not p:
            return None
        # v113: COPY - the cached manifest must never gain the transient
        # "revisions" key (the cache is written back to disk on mutations)
        out = dict(p)
        out["revisions"] = list_revisions(pid)
        return out


def _store_bytes(data):
    """Store exact raw bytes in the shared object database (one store for
    every process + Presets). Returns (backend, oid) or (None, None)."""
    kind = _resolve_backend()
    if kind == "git":
        oid = _git_write_blob(data)
        if oid:
            return "git", oid
        return None, None
    return "cas", _cas_write(data)


def _read_stored(backend, oid):
    if backend == "git":
        return _git_read_blob(oid)
    return _cas_read(oid)


# ---------------------------------------------------------------------------
# v116 (plan 5.1): the SHARED OBJECT STORE for the Preset version payloads.
# The preset history used to keep one FULL JSON file per revision
# (preset_versions/<pid>/<rid>.json with the whole preset embedded) - large
# embedded snapshot graphs were duplicated on every Preset update. Now the
# PAYLOAD lives in the same object store as the process revisions (one
# shared Git repository / one CAS namespace), and the small manifest JSON
# only references it: {storage: {backend, blob[, commit]}, rawHash, size}.
# Content-addressed storage dedupes identical payloads across ALL presets
# and processes automatically.
# ---------------------------------------------------------------------------

def store_preset_payload(pid, rid, data):
    """Store ONE preset revision payload in the shared object store.
    Returns {ok, backend, blob, commit?, rawHash, size} or
    {ok: False, error}. Under the git backend the payload blob becomes part
    of the shared commit chain (parent-linked to the current head) - an
    unreferenced loose blob would be pruned by the next repack, so the
    preset payloads are REACHABLE exactly like the process revisions."""
    if not isinstance(data, (bytes, bytearray)):
        return {"ok": False, "error": "payload must be bytes"}
    data = bytes(data)
    if len(data) > MAX_REVISION_BYTES:
        return {"ok": False, "error": "payload too large (%d bytes)" % len(data)}
    with _lock:
        _resolve_backend()
        kind = _resolve_backend()
        raw_hash = _sha256(data)
        if kind == "git":
            oid = _git_write_blob(data)
            if not oid:
                return {"ok": False, "error": "the history store refused the write"}
            parent = _git_head()
            tree = _git_write_tree([("100644", oid,
                                     "preset-%s-%s.json" % (pid, rid))])
            if not tree:
                return {"ok": False, "error": "git tree write failed"}
            commit = _git_commit_tree(tree, parent,
                                      "preset version %s (%s)" % (rid, (pid or "")[:6]))
            if not commit:
                return {"ok": False, "error": "git commit failed"}
            if not _git_update_ref(commit):
                return {"ok": False, "error": "git ref update failed"}
            return {"ok": True, "backend": "git", "blob": oid,
                    "commit": commit, "rawHash": raw_hash, "size": len(data)}
        oid = _cas_write(data)
        return {"ok": True, "backend": "cas", "blob": oid,
                "rawHash": raw_hash, "size": len(data)}


def read_preset_payload(storage):
    """The EXACT payload bytes of a preset revision manifest (rawHash
    verified - a broken blob answers None instead of serving lies)."""
    if not isinstance(storage, dict):
        return None
    data = _read_stored(storage.get("backend"), storage.get("blob"))
    if data is None:
        return None
    if storage.get("rawHash") and _sha256(data) != storage.get("rawHash"):
        return None
    return data


def reclaim_preset_blobs(storages):
    """Delete the CAS blobs a preset's revisions uniquely own (plan 7.8/5.1:
    the preset deletion takes its history with it). Cross-referencing
    protects blobs shared with OTHER preset versions or process revisions
    (content dedupe). Git blobs stay reachable in the commit chain - the
    freed bytes report 0 honestly. Returns (freed_bytes, reclaimed_count)."""
    freed = 0
    reclaimed = 0
    with _lock:
        _rev_cache_load_locked()
        referenced = set()
        for r in _rev_cache["by_rid"].values():
            st = r.get("storage") or {}
            if st.get("backend") == "cas" and isinstance(st.get("blob"), str):
                referenced.add(st["blob"])
        gone = set()
        for st in (storages or []):
            if isinstance(st, dict) and st.get("backend") == "cas" \
                    and isinstance(st.get("blob"), str):
                gone.add(st["blob"])
        gone -= referenced
        for oid in gone:
            bp = _cas_blob_path(oid)
            try:
                freed += os.path.getsize(bp)
            except OSError:
                freed += 0
            try:
                os.unlink(bp)
                reclaimed += 1
            except OSError:
                pass
    return freed, reclaimed


# ---------------------------------------------------------------------------
# Revisions
# ---------------------------------------------------------------------------

def create_revision(pid, data, meta):
    """ONE Checkpoint = exactly ONE revision/commit (plan tests). Dedupe: if
    the raw bytes match the LAST revision of the process, no new revision is
    created (returns {ok, duplicate, revisionId}). The commit happens in the
    shared store BEFORE the catalog manifest is written (crash order)."""
    if not isinstance(data, (bytes, bytearray)):
        return {"ok": False, "error": "payload must be bytes"}
    data = bytes(data)
    if len(data) > MAX_REVISION_BYTES:
        return {"ok": False, "error": "payload too large (%d bytes)" % len(data)}
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        raw_hash = _sha256(data)
        revisions = list_revisions(pid)
        if revisions:
            last = revisions[0]
            if last.get("rawHash") == raw_hash:
                return {"ok": True, "duplicate": True,
                        "revisionId": last["revisionId"]}
        rid = _new_id()
        source = _sanitize_name(meta.get("source"), 24) or "checkpoint"
        note = _sanitize_name(meta.get("note"), MAX_NOTE_CHARS)
        title = _sanitize_name(meta.get("title"), MAX_PROCESS_NAME_CHARS)
        rec = {
            "revisionId": rid,
            "processId": pid,
            "parentRevisionId": revisions[0]["revisionId"] if revisions else None,
            "source": source,
            "sourcePath": meta.get("sourcePath") or None,
            "createdAt": _now(),
            "title": title,
            "note": note,
            "rawHash": raw_hash,
            "canonicalHash": meta.get("canonicalHash"),
            "workflowHash": meta.get("workflowHash"),
            "presentationHash": meta.get("presentationHash"),
            "extensionHash": meta.get("extensionHash"),
            "normalizationProfileVersion": meta.get("normalizationProfileVersion")
                or (_wf_index.NORMALIZATION_PROFILE_VERSION if _wf_index else "nprof1"),
            "workflowId": proc.get("workflowId"),
            "size": len(data),
        }
        # 1) the object storage first (crash order: an orphan blob is
        #    collectable garbage; a manifest without bytes would be a lie)
        backend, oid = _store_bytes(data)
        if not backend:
            return {"ok": False, "error": "the history store refused the write"}
        rec["storage"] = {"backend": backend, "blob": oid}
        if backend == "git":
            parent = _git_head()
            # mktree takes FLAT names only - the commit tree mirrors the
            # catalog layout with two levels of sub-trees (the durability
            # contract: the revision bytes + the manifest in one commit)
            rev_blob = _git_write_blob(json.dumps(rec, ensure_ascii=False).encode("utf-8"))
            tree = _git_write_tree([
                ("100644", oid, "current-%s.json" % pid),
                ("100644", rev_blob, "revision-%s.json" % rid),
            ])
            if not tree:
                return {"ok": False, "error": "git tree write failed"}
            commit = _git_commit_tree(tree, parent,
                                      "checkpoint %s (%s)" % (rid, pid[:6]))
            if not commit:
                return {"ok": False, "error": "git commit failed"}
            if not _git_update_ref(commit):
                return {"ok": False, "error": "git ref update failed"}
            rec["storage"]["commit"] = commit
        # 2) the durable manifest
        _atomic_write_json(_revision_file(rid), rec)
        _rev_cache_put_locked(rec)
        proc["currentRevisionId"] = rid
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        # v116 (plan 4.6): the revision title/note join the searchable notes
        # index (best effort - a broken notes table never breaks a checkpoint)
        if _wf_index is not None and (note or title):
            try:
                _wf_index.notes_upsert("revision", pid, rid, title, note,
                                       rec.get("createdAt"))
            except Exception:
                pass
        out = {"ok": True, "duplicate": False, "revisionId": rid,
               "revision": rec}
        # v116 (plan 5.3/11.1): the SOFT retention advisory - the count is
        # reported, NOTHING is deleted automatically
        if len(revisions) + 1 >= MAX_REVISIONS_WARN_AFTER:
            out["warning"] = ("the process history holds %d versions "
                               "(advisory limit %d) - nothing is deleted "
                               "automatically; use Manage versions to clean up"
                               % (len(revisions) + 1, MAX_REVISIONS_PER_PROCESS))
            out["revisionCount"] = len(revisions) + 1
        return out


def list_revisions(pid):
    """The LINEAR revision list of ONE process, newest first. The order is
    the true parent chain (walked backwards from the process's current
    revision) - a createdAt tie inside one second cannot reorder the
    history. Revisions outside the chain (an abandoned branch of a crashed
    run) append after, newest first. v113: served from the in-memory
    revision cache (one disk pass per session; the per-open full re-read
    of EVERY revision manifest is gone)."""
    proc = _read_process(pid)
    chain = []
    seen = set()
    cur = proc.get("currentRevisionId") if proc else None
    while isinstance(cur, str) and _ID_RE.match(cur) and cur not in seen:
        rec = _read_revision(cur)
        if not rec or rec.get("processId") != pid:
            break
        chain.append(rec)
        seen.add(cur)
        cur = rec.get("parentRevisionId")
    rest = []
    with _lock:
        _rev_cache_load_locked()
        for r in _rev_cache["of_pid"].get(pid) or []:
            if r.get("revisionId") in seen:
                continue
            rest.append(r)
    rest.sort(key=lambda r: -(r.get("createdAt") or 0))
    return chain + rest


def read_revision_bytes(rid):
    """The EXACT original bytes of a revision (plan: raw hash verified)."""
    with _lock:
        rec = _read_revision(rid)
        if not rec:
            return None
        st = rec.get("storage") or {}
        data = _read_stored(st.get("backend"), st.get("blob"))
        if data is None:
            return None
        if _sha256(data) != rec.get("rawHash"):
            return None  # integrity failed - refuse, never serve broken bytes
        return data


def mark_stable(rid, stable=True):
    with _lock:
        rec = _read_revision(rid)
        if not rec:
            return {"ok": False, "error": "no such revision"}
        rec["isStable"] = bool(stable)
        rec["stableAt"] = _now() if stable else None
        _atomic_write_json(_revision_file(rid), rec)
        _rev_cache_put_locked(rec)
        pid = rec.get("processId")
        proc = _read_process(pid)
        if proc:
            if stable:
                proc["stableRevisionId"] = rid
            elif proc.get("stableRevisionId") == rid:
                proc.pop("stableRevisionId", None)
            _atomic_write_json(_process_file(pid), proc)
            _cache_put_locked(proc)
        return {"ok": True, "revisionId": rid, "isStable": bool(stable)}


def set_revision_note(rid, note):
    """A durable annotation on an existing revision (plan 5.8: annotations
    live in the same store). v116: the note joins the searchable notes
    index (plan 4.6)."""
    with _lock:
        rec = _read_revision(rid)
        if not rec:
            return {"ok": False, "error": "no such revision"}
        rec["note"] = _sanitize_name(note, MAX_NOTE_CHARS)
        rec["noteEditedAt"] = _now()
        _atomic_write_json(_revision_file(rid), rec)
        _rev_cache_put_locked(rec)
        if _wf_index is not None:
            try:
                _wf_index.notes_upsert("revision", rec.get("processId"), rid,
                                       rec.get("title"), rec.get("note"),
                                       rec.get("noteEditedAt"))
            except Exception:
                pass
        return {"ok": True, "revisionId": rid}


def overwrite_revision(rid, data, note=None, title=None):
    """v122 (owner request): OVERWRITE one existing checkpoint's content
    with the CURRENT workflow state, optionally renaming it. The revision
    keeps its identity - revisionId, processId, the place in the parent
    chain, createdAt and the stable flag all survive; only the stored
    bytes, the derived hashes and (optionally) the title/note change.

    `note`/`title` semantics: None = keep the current value untouched,
    a string (even an empty one) = set it. A rename with UNCHANGED bytes
    is a legitimate call - it updates the manifest + the notes index and
    reports {ok, renamed: True}; identical bytes AND identical names
    report {ok, duplicate: True} (nothing was written).

    Crash order mirrors create_revision: the object storage first, then
    the shared git commit (when the bytes changed - a rename-only call
    follows the set_revision_note precedent and does NOT commit), then
    the durable catalog manifest."""
    if not isinstance(data, (bytes, bytearray)):
        return {"ok": False, "error": "payload must be bytes"}
    data = bytes(data)
    if len(data) > MAX_REVISION_BYTES:
        return {"ok": False, "error": "payload too large (%d bytes)" % len(data)}
    with _lock:
        rec = _read_revision(rid)
        if not rec:
            return {"ok": False, "error": "no such revision"}
        pid = rec.get("processId")
        proc = _read_process(pid) if pid else None
        if not proc:
            return {"ok": False, "error": "the revision's process is gone"}
        raw_hash = _sha256(data)
        analysis = None
        if _wf_index is not None:
            analysis, _err = _wf_index.analyze_workflow_bytes(data)
        new_title = _sanitize_name(title, MAX_PROCESS_NAME_CHARS) \
            if isinstance(title, str) else None
        new_note = _sanitize_name(note, MAX_NOTE_CHARS) \
            if isinstance(note, str) else None
        renamed = ((new_title is not None and new_title != rec.get("title")) or
                   (new_note is not None and new_note != rec.get("note")))
        bytes_changed = raw_hash != rec.get("rawHash")
        if not bytes_changed and not renamed:
            return {"ok": True, "duplicate": True, "revisionId": rid}
        if bytes_changed:
            backend, oid = _store_bytes(data)
            if not backend:
                return {"ok": False, "error": "the history store refused the write"}
            rec["rawHash"] = raw_hash
            rec["canonicalHash"] = analysis.get("canonical_hash") if analysis else None
            rec["workflowHash"] = analysis.get("workflow_hash") if analysis else None
            rec["presentationHash"] = analysis.get("presentation_hash") if analysis else None
            rec["extensionHash"] = analysis.get("extension_hash") if analysis else None
            rec["normalizationProfileVersion"] = (
                analysis.get("normalization_profile_version") if analysis else None
            ) or (_wf_index.NORMALIZATION_PROFILE_VERSION if _wf_index else "nprof1")
            rec["size"] = len(data)
            rec["storage"] = {"backend": backend, "blob": oid}
            if backend == "git":
                parent = _git_head()
                entries = [("100644", oid, "revision-%s.json" % rid)]
                cur = proc.get("currentRevisionId")
                if cur == rid:
                    entries.append(("100644", oid, "current-%s.json" % pid))
                else:
                    cur_rec = _read_revision(cur) if isinstance(cur, str) else None
                    cur_blob = ((cur_rec.get("storage") or {}).get("blob")
                                if cur_rec else None)
                    if isinstance(cur_blob, str) and cur_blob:
                        entries.append(("100644", cur_blob,
                                        "current-%s.json" % pid))
                tree = _git_write_tree(entries)
                if not tree:
                    return {"ok": False, "error": "git tree write failed"}
                commit = _git_commit_tree(
                    tree, parent, "overwrite %s (%s)" % (rid, (pid or "")[:6]))
                if not commit:
                    return {"ok": False, "error": "git commit failed"}
                if not _git_update_ref(commit):
                    return {"ok": False, "error": "git ref update failed"}
                rec["storage"]["commit"] = commit
        # the rename - even without new bytes - is recorded durably
        if new_title is not None:
            rec["title"] = new_title
        if new_note is not None:
            rec["note"] = new_note
        rec["overwrittenAt"] = _now()
        _atomic_write_json(_revision_file(rid), rec)
        _rev_cache_put_locked(rec)
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        # v122: the renamed/new notes stay searchable (same best-effort
        # contract as create_revision/set_revision_note)
        if _wf_index is not None and (rec.get("note") or rec.get("title")):
            try:
                _wf_index.notes_upsert("revision", pid, rid, rec.get("title"),
                                       rec.get("note"), rec.get("overwrittenAt"))
            except Exception:
                pass
        out = {"ok": True, "duplicate": False, "renamed": renamed,
               "revisionId": rid, "revision": rec}
        return out


def _delete_revision_locked(rid):
    """The shared deletion core of delete_revision/delete_revisions (the
    caller HOLDS _lock). One protection contract for every entry point:
    a STABLE revision and the CURRENT revision of the process are never
    deleted; a deleted revision is SPLICED out of the parent chain (its
    children re-link to its parent) so the linear lineage survives a
    middle-of-chain delete - the descendants must never become an
    invisible branch. Returns None when the rid is protected/unknown,
    or a {"reason": ...} string for the skip report."""
    rec = _read_revision(rid)
    if not rec:
        return "no such revision"
    if rec.get("isStable"):
        return "a stable revision is protected"
    pid = rec.get("processId")
    proc = _read_process(pid) if pid else None
    if proc and proc.get("currentRevisionId") == rid:
        return "the current revision cannot be deleted"
    parent = rec.get("parentRevisionId")
    if pid:
        _rev_cache_load_locked()
        for other in (_rev_cache["of_pid"].get(pid) or []):
            oid = other.get("revisionId")
            if oid == rid or other.get("parentRevisionId") != rid:
                continue
            other["parentRevisionId"] = parent
            _atomic_write_json(_revision_file(oid), other)
            _rev_cache_put_locked(other)
    if proc and proc.get("stableRevisionId") == rid:
        # belt+braces: a stable rid cannot reach this line, but a stale
        # pointer must not survive the deletion either
        proc.pop("stableRevisionId", None)
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
    try:
        os.unlink(_revision_file(rid))
    except OSError:
        pass
    _rev_cache_drop_locked(rid)
    # v116 (plan 4.6): the deleted revision's note leaves the notes index
    if _wf_index is not None:
        try:
            _wf_index.notes_drop(pid, "revision", rid)
        except Exception:
            pass
    return None


def delete_revision(rid):
    """An EXPLICIT cleanup only - manual/stable revisions are protected
    (the plan: never silently prune)."""
    with _lock:
        reason = _delete_revision_locked(rid)
        if reason:
            return {"ok": False, "error": reason}
        return {"ok": True, "gone": rid}


def delete_revisions(rids):
    """v114 (owner request): the BATCH deletion of SPECIFIC versions - the
    Process-history panel got a manage mode (checkboxes + a dynamic
    Select all / Deselect all + an armed Delete selected). One lock, one
    pass; every rid passes the SAME protection contract as the single
    delete (stable + current are protected server-side - the UI only
    grays them out, the server decides); each deleted revision is spliced
    out of the parent chain. The answer names every skip so the UI can
    say exactly why a version survived.
    v116 (plan 3.6): the batch cap is EXPLICIT - a payload beyond
    DELETE_REVISIONS_MAX is refused with 400, never silently truncated
    (the owner would never learn that the tail was not deleted)."""
    if not isinstance(rids, list):
        return {"ok": False, "error": "revisionIds must be a list"}
    if len(rids) > DELETE_REVISIONS_MAX:
        return {"ok": False,
                "error": "too many revisions in one batch (max %d)"
                         % DELETE_REVISIONS_MAX,
                "limit": DELETE_REVISIONS_MAX}
    clean = []
    for x in rids[:DELETE_REVISIONS_MAX]:
        if isinstance(x, str) and _ID_RE.match(x):
            clean.append(x)
    deleted, skipped = [], []
    with _lock:
        for rid in clean:
            reason = _delete_revision_locked(rid)
            if reason:
                skipped.append({"revisionId": rid, "reason": reason})
            else:
                deleted.append(rid)
    return {"ok": True, "deleted": deleted, "skipped": skipped}


def revision_badges(scope="default"):
    """v114 (owner request): the per-FILE version indicator data - the Files
    rows must SHOW when a process has versions. One call feeds the whole
    tab: {rel_path: {count, stable}} for every process that HAS revisions;
    a process without revisions (the bulk of a big library) contributes
    NOTHING - the payload stays small even with 2000+ processes. The keys
    are the same 'workflows/<rel>' paths the Files listing serves.

    v115 (owner request): the same answer also carries the DUPLICATE-ID
    counter - "индицировать количество процессов с одинаковым ид": several
    FILES sharing one ComfyUI UUID are locations of ONE process, and the
    user must SEE how many rows that ID covers. A process reports
    'locations: N' ONLY when N > 1 (a normal one-file process adds no
    bytes), and a process with zero revisions but several locations still
    shows up - duplicates matter even before the first Checkpoint.
    v116: scope-filtered like every other list."""
    with _lock:
        reconcile_processes(scope)   # throttled (10s); keeps the bindings fresh
        _cache_load_locked()
        _rev_cache_load_locked()
        out = {}
        for pid, revs in _rev_cache["of_pid"].items():
            p = _proc_cache["by_pid"].get(pid)
            if p and _manifest_scope(p) != scope:
                continue
            n = len(revs)
            locs = _proc_cache["paths_of"].get(pid) or ()
            if n == 0 and len(locs) < 2:
                continue   # the bulk of a big library - zero bytes
            info = {"count": n,
                    "stable": sum(1 for r in revs if r.get("isStable"))}
            if len(locs) > 1:
                info["locations"] = len(locs)
            for lp in locs:
                out[lp] = info
        # v115: a process with NO revisions never entered the loop above
        # (of_pid holds only processes that own a revision manifest) - walk
        # the process cache for the revision-less duplicates
        for pid, p in _proc_cache["by_pid"].items():
            if pid in _rev_cache["of_pid"] or _manifest_scope(p) != scope:
                continue
            locs = _proc_cache["paths_of"].get(pid) or ()
            if len(locs) < 2:
                continue
            info = {"count": 0, "stable": 0, "locations": len(locs)}
            for lp in locs:
                out.setdefault(lp, info)
        return out


def _cas_blob_path(oid):
    return _hist_dir("cas", oid[:2], oid + ".z")


def delete_process(pid, delete_files=False, only_paths=None,
                   file_remover=None, file_preflight=None):
    """v115 (owner request): "кнопка удалять сами процессы со всеми
    хвостами" - erase ONE process AND everything attached to it: every
    revision manifest, the stored blobs no other revision references (the
    CAS backend reclaims the real bytes; the git backend keeps its
    immutable commit chain - the manifests still die so the process
    disappears), every location binding and the process manifest itself.
    The version-level protections (stable/current) live at the REVISION
    level - an explicit process erasure removes the whole object, the
    armed two-click confirm in the UI is the consent.

    v116 (plan 3.5): the file deletion became a TWO-PHASE, all-or-nothing
    operation - the v115 loop deleted files one by one and STILL erased the
    history when a removal failed mid-way (physical files without metadata).
    The contract now:
      PHASE 0 preflight  - file_preflight(location) runs for EVERY location
        FIRST (the route snapshots + verifies the bytes). ANY failure aborts
        the whole operation: {ok: False, stage: "preflight", files: [...]} -
        nothing on disk, in the catalog or in the store has been touched.
      PHASE 1 file removal - only after EVERY preflight passed; the remover
        unlinks. A failure here is reported per file AND the process + ALL
        revisions are KEPT ({ok: False, stage: "files", partial: True, ...})
        - the metadata can never outlive its files on a partial failure.
      PHASE 2 history erasure - only when every requested file is gone
        (or delete_files=False: the explicit "versions only" choice): the
        revision manifests, the uniquely-owned CAS blobs and the process
        manifest die; the answer reports the reclaimed bytes honestly (the
        git backend keeps its reachable commit chain and reports 0).

    v117 (the owner's delete plan): the DANGEROUS UUID-wide deletion is
    GONE. only_paths scopes the file deletion to the EXACT files the user
    chose (the Process-history panel passes the panel's CURRENT file): the
    other files of the same UUID on disk are NEVER touched. After the
    removal the scoped paths are DETACHED from the process; the history is
    erased ONLY when no live location remains - otherwise the answer says
    {keptHistory: true, remainingLocations: N} and the versions stay
    reachable through the surviving copies."""
    if not isinstance(pid, str) or not _ID_RE.match(pid):
        return {"ok": False, "error": "bad processId"}
    if file_remover is not None and not callable(file_remover):
        return {"ok": False, "error": "file_remover must be callable"}
    if file_preflight is not None and not callable(file_preflight):
        return {"ok": False, "error": "file_preflight must be callable"}
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        _rev_cache_load_locked()
        _cache_load_locked()
        revs = list(_rev_cache["of_pid"].get(pid) or [])
        locations = sorted(_proc_cache["paths_of"].get(pid) or ())
        # v117: scope the file deletion to the EXACT paths the user chose
        # (unknown paths are ignored - never a silent wider deletion)
        scoped = None
        if delete_files and only_paths is not None:
            if not isinstance(only_paths, (list, tuple, set)):
                return {"ok": False, "error": "only_paths must be a list"}
            scoped = sorted(set(str(p) for p in only_paths
                                if isinstance(p, str) and p) & set(locations))
        targets = scoped if scoped is not None else locations
        files = []
        if delete_files:
            # PHASE 0 - the FULL preflight before anything is touched
            if file_preflight is not None:
                for lp in targets:
                    try:
                        res = file_preflight(lp) or {"path": lp}
                    except Exception as e:   # a hostile checker must not wed the store
                        res = {"path": lp, "ok": False,
                               "error": str(e)[:160]}
                    res.setdefault("path", lp)
                    files.append(res)
                if any(not f.get("ok", False) for f in files):
                    return {"ok": False, "stage": "preflight",
                            "error": "the safety preflight failed - NOTHING "
                                     "was deleted (the file copies and the "
                                     "history are intact)",
                            "files": files}
            # PHASE 1 - the physical removal (every file checked above)
            if file_remover is not None:
                files = []
                for lp in targets:
                    try:
                        files.append(file_remover(lp) or {"path": lp})
                    except Exception as e:
                        files.append({"path": lp, "removed": False,
                                      "error": str(e)[:160]})
                failed = [f for f in files if f.get("error")
                          and not f.get("removed")]
                if failed:
                    # plan 3.5: a partial file failure keeps the process AND
                    # the whole history - retryable, nothing is lost
                    return {"ok": False, "stage": "files", "partial": True,
                            "error": ("%d of %d file(s) could not be deleted "
                                      "- the process history is KEPT"
                                      % (len(failed), len(files))),
                            "files": files,
                            "deletedRevisions": 0}
        # v117: the scoped deletion detaches the removed paths FIRST - the
        # history dies only when the process lost its LAST live location
        kept_history = False
        remaining = 0
        if scoped is not None:
            for lp in scoped:
                try:
                    detach_location(pid, lp)
                except Exception:
                    pass
            _cache_load_locked()
            remaining = len(_proc_cache["paths_of"].get(pid) or ())
            if remaining > 0:
                kept_history = True
        # PHASE 2 - the history erasure (the requested files are all gone
        # and no location survives, or delete_files=False: the explicit
        # versions-only choice)
        if kept_history:
            _reconcile_ts[0] = 0   # the discovery must re-run immediately
            return {"ok": True, "processId": pid,
                    "deletedRevisions": 0,
                    "freedBytes": 0,
                    "files": files,
                    "keptHistory": True,
                    "remainingLocations": remaining,
                    "backend": _resolve_backend()}
        freed = 0
        gone_oids = set()
        for r in revs:
            st = r.get("storage") or {}
            if st.get("backend") == "cas" and isinstance(st.get("blob"), str):
                gone_oids.add(st["blob"])
        if gone_oids:
            for other in _rev_cache["by_rid"].values():
                if other.get("processId") == pid:
                    continue
                st = other.get("storage") or {}
                if st.get("backend") == "cas":
                    gone_oids.discard(st.get("blob"))
            for oid in gone_oids:
                bp = _cas_blob_path(oid)
                try:
                    freed += os.path.getsize(bp)
                except OSError:
                    freed += 0
                try:
                    os.unlink(bp)
                except OSError:
                    pass
        # the revision manifests (no splice needed - the whole chain dies)
        for r in revs:
            rid = r.get("revisionId")
            if isinstance(rid, str):
                try:
                    os.unlink(_revision_file(rid))
                except OSError:
                    pass
                _rev_cache_drop_locked(rid)
        # the process manifest + the caches
        try:
            os.unlink(_process_file(pid))
        except OSError:
            pass
        scope = _manifest_scope(proc)
        _proc_cache["by_pid"].pop(pid, None)
        wid = proc.get("workflowId")
        if wid and (_proc_cache["by_uuid"].get(scope) or {}).get(wid) == pid:
            _proc_cache["by_uuid"][scope].pop(wid, None)
        for lp in (_proc_cache["paths_of"].pop(pid, None) or ()):
            if (_proc_cache["by_path"].get(scope) or {}).get(lp) == pid:
                _proc_cache["by_path"][scope].pop(lp, None)
        # the file-set signature changes (a manifest vanished) - the next
        # reconcile pass must not serve a stale cache
        sig = _proc_cache["sig"]
        if isinstance(sig, list):
            _proc_cache["sig"] = [n for n in sig if n != pid + ".json"]
        else:
            _proc_cache["sig"] = None
        _reconcile_ts[0] = 0   # the discovery must re-run immediately
        # v116 (plan 4.6): the notes of the erased history leave the index
        if _wf_index is not None:
            try:
                _wf_index.notes_drop(pid)
            except Exception:
                pass
        return {"ok": True, "processId": pid,
                "deletedRevisions": len(revs),
                "freedBytes": freed,
                "files": files,
                "backend": _resolve_backend()}


def detach_locations(rel_paths):
    """v116 (plan 7.8): the Files-delete route unbinds EVERY deleted path
    from its process - the history STAYS (an orphaned process keeps its
    revisions and can be re-linked when a file with the same UUID appears).
    Returns {ok, detached: [{path, processId, removed, remaining}]}.
    v117: every entry also carries the process's REMAINING location count
    AFTER the detach (the Files-delete route uses it to erase the versions
    that lost their last live file - the owner's "orphaned versions" rule)."""
    out = []
    if not isinstance(rel_paths, (list, tuple, set)):
        return {"ok": False, "error": "paths must be a list"}
    with _lock:
        reconcile_processes()
        _cache_load_locked()
        for rp in set(rel_paths):
            if not isinstance(rp, str) or not rp:
                continue
            pid = (_proc_cache["by_path"].get("default") or {}).get(rp)
            if not pid:
                out.append({"path": rp, "processId": None, "removed": False,
                            "remaining": None})
                continue
            r = detach_location(pid, rp)
            _cache_load_locked()
            remaining = len(_proc_cache["paths_of"].get(pid) or ())
            out.append({"path": rp, "processId": pid,
                        "removed": bool(r.get("ok")) and not r.get("unchanged"),
                        "remaining": remaining})
        return {"ok": True, "detached": out}


def paths_preview(rel_paths, user_scope="default"):
    """v117 (the owner's delete plan): the DATA for the Files-delete confirm
    dialog - computed BEFORE anything is deleted, never a guess. For every
    selected path: the owning process, its total locations, the OTHER
    (unselected) live files that keep the same history, the version count
    that would become unreachable (and deleted with the file) when no live
    copy survives, and the preset references pointing at the path (the
    presets themselves are NEVER touched - the warning is informational).
    Returns {ok, files: [{path, processId, processName, revisions,
    locations, otherLocations, willOrphanVersions}], presetsAffected,
    totals}."""
    sel = [p for p in (rel_paths or []) if isinstance(p, str) and p]
    sel_set = set(sel)
    files = []
    presets_affected = []
    with _lock:
        reconcile_processes()
        _cache_load_locked()
        seen_pids = set()
        for rp in sel:
            pid = (_proc_cache["by_path"].get("default") or {}).get(rp)
            info = {"path": rp, "processId": pid, "processName": None,
                    "revisions": 0, "locations": 0, "otherLocations": [],
                    "willOrphanVersions": False}
            if pid:
                proc = _proc_cache["by_pid"].get(pid) or {}
                info["processName"] = proc.get("displayName") or None
                locs = sorted(_proc_cache["paths_of"].get(pid) or ())
                info["locations"] = len(locs)
                info["otherLocations"] = [p for p in locs if p not in sel_set]
                _rev_cache_load_locked()
                info["revisions"] = len(_rev_cache["of_pid"].get(pid) or ())
                info["willOrphanVersions"] = (
                    bool(info["revisions"]) and not info["otherLocations"])
                if pid not in seen_pids:
                    seen_pids.add(pid)
            files.append(info)
    # the PRESET references (best effort - the presets live in the store
    # module; a read failure must never kill the preview)
    try:
        from . import workflows_store as _store
    except Exception:
        try:
            import workflows_store as _store
        except Exception:
            _store = None
    if _store is not None and hasattr(_store, "presets_referencing_paths"):
        try:
            presets_affected = _store.presets_referencing_paths(sel)
        except Exception:
            presets_affected = []
    orphan_pids = {f["processId"] for f in files
                   if f["willOrphanVersions"] and f["processId"]}
    return {"ok": True, "files": files,
            "presetsAffected": presets_affected,
            "totals": {
                "selected": len(sel),
                "orphanProcesses": len(orphan_pids),
                "orphanVersions": sum(f["revisions"] for f in files
                                      if f["willOrphanVersions"]),
                "presetsAffected": len(presets_affected),
            }}


def expire_reconcile_cache():
    """v116 (plan 7.8): force the NEXT reconcile to re-run immediately (the
    Files-delete undo restored physical files - the discovery must re-bind
    them without waiting out the 10s throttle)."""
    _reconcile_ts[0] = 0


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

def _ensure_process(workflow_id, display_name=None, note=None,
                    scope="default"):
    """Find the process bound to a ComfyUI workflow UUID, or create it
    (plan 2.1 rule 2: one valid UUID -> ONE processId). v113: the lookup
    is the in-memory uuid map (the v112 code re-read EVERY manifest per
    call - O(N) per row made reconcile O(N^2) file reads with a large
    library). v116 (plan 4.5): the lookup + the new manifest are SCOPE
    scoped - two users' same-UUID files never merge into one process."""
    with _lock:
        if workflow_id:
            _cache_load_locked()
            hit = (_proc_cache["by_uuid"].get(scope) or {}).get(workflow_id)
            if hit:
                p = _proc_cache["by_pid"].get(hit)
                if p:
                    return p, False
        pid = _new_id()
        now = _now()
        proc = {
            "processId": pid,
            "workflowId": workflow_id if isinstance(workflow_id, str) else None,
            "scope": scope if isinstance(scope, str) and scope else "default",
            "displayName": _sanitize_name(display_name) or ("Process " + pid[:6]),
            "note": _sanitize_name(note, MAX_NOTE_CHARS),
            "locations": [],
            "currentRevisionId": None,
            "stableRevisionId": None,
            "archived": False,
            "createdAt": now,
            "updatedAt": now,
        }
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        return proc, True


def detach_location(pid, rel_path):
    """v116 (plan 3.3): UNBIND ONE physical path from the process - the
    path moved to another UUID (rebind), the file vanished (orphaned
    history keeps its revisions), or the user deleted the file (the Files
    delete route). The process + its history STAY (the plan: 'the old
    process keeps its history even when it has no files on disk'). A
    no-op answer {unchanged} when the path is not bound here."""
    if not isinstance(rel_path, str) or not rel_path:
        return {"ok": False, "error": "bad path"}
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        locs = proc.get("locations") or []
        hit = next((l for l in locs if l.get("path") == rel_path), None)
        if hit is None:
            return {"ok": True, "processId": pid, "unchanged": True}
        was_primary = bool(hit.get("isPrimary"))
        proc["locations"] = [l for l in locs if l.get("path") != rel_path]
        if was_primary and proc["locations"]:
            # the primary flag must not die with the detached location
            proc["locations"][0]["isPrimary"] = True
            for l in proc["locations"][1:]:
                l["isPrimary"] = False
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        return {"ok": True, "processId": pid, "locations": len(proc["locations"])}


def attach_location(pid, rel_path, last_seen_hash=None, mtime_ns=None,
                    primary=False):
    """Bind ONE physical file location to the process (plan 5.2: Save As
    with the same UUID adds a location, never a revision). v113: a
    no-change binding (the typical reconcile row on a warm store) does NOT
    rewrite the manifest - the v112 code fsync-wrote EVERY process manifest
    on EVERY reconcile pass."""
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        locs = proc.setdefault("locations", [])
        hit = None
        for loc in locs:
            if loc.get("path") == rel_path:
                hit = loc
                break
        if hit is not None:
            hash_same = (last_seen_hash is None or
                         hit.get("lastSeenHash") == last_seen_hash)
            mtime_same = (mtime_ns is None or
                          hit.get("mtimeNs") == mtime_ns)
            primary_ok = (not primary and
                          any(l.get("isPrimary") for l in locs))
            if hash_same and mtime_same and primary_ok:
                return {"ok": True, "processId": pid, "locations": len(locs),
                        "unchanged": True}
        if hit is None:
            hit = {"path": rel_path, "boundAt": _now()}
            locs.append(hit)
        if last_seen_hash is not None:
            hit["lastSeenHash"] = last_seen_hash
        if mtime_ns is not None:
            hit["mtimeNs"] = mtime_ns
        if primary or not any(l.get("isPrimary") for l in locs):
            for l in locs:
                l["isPrimary"] = False
            hit["isPrimary"] = True
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        return {"ok": True, "processId": pid, "locations": len(locs)}


def set_process_meta(pid, display_name=None, note=None, archived=None):
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        if display_name is not None:
            nm = _sanitize_name(display_name)
            if nm:
                proc["displayName"] = nm
        if note is not None:
            proc["note"] = _sanitize_name(note, MAX_NOTE_CHARS)
        if archived is not None:
            proc["archived"] = bool(archived)
        proc["updatedAt"] = _now()
        _atomic_write_json(_process_file(pid), proc)
        _cache_put_locked(proc)
        # v116 (plan 4.6): the process note + name are searchable - the
        # notes index follows every manifest change (best effort)
        if _wf_index is not None:
            try:
                _wf_index.notes_upsert("process", pid, "",
                                       proc.get("displayName"), proc.get("note"),
                                       proc.get("updatedAt"))
            except Exception:
                pass
        return {"ok": True, "process": proc}


_reconcile_ts = [0, 0]  # [last_run, count] - a small TTL guard


def reconcile_processes(scope="default"):
    """DISCOVERY (plan 5.1 + stage-2 item 6): group the indexed files by
    ComfyUI UUID - every valid workflow_id becomes/updates ONE process with
    the file paths as locations. Files WITHOUT an id are never bound (rule
    8: no basename/similarity auto-merge). Cheap: a GROUP BY over the index;
    throttled to once per 10s (every process listing re-checks). v113: a
    row whose binding is already current (same process, same path, same
    hash + mtime) costs ZERO reads and ZERO writes - the warm pass over a
    2000-process library is one SELECT plus dict lookups.

    v116 (plan 3.3 + 11.2): the pass is COMPLETE and REBINDS correctly -
    the v115 code stopped at rows[:5000] (a silent partial sync) and
    ATTACHED a new UUID to a path without releasing the old process's
    binding (both manifests kept the same path forever after a UUID A -> B
    file replacement). The v116 contract per row:
      * the path's current binding is looked up FIRST (scope-aware map);
      * a row bound elsewhere with a DIFFERENT UUID detaches the old
        binding (atomically, manifest rewrite) before the new attach - a
        path can only ever live in ONE process of its scope;
      * a row whose UUID vanished (the file content lost its id) detaches
        the path from a UUID-bound process (orphaned history stays); a
        path-bound process (created by a no-UUID checkpoint) keeps the
        binding and just refreshes hash/mtime;
      * paths that no longer exist in the index detach from every process
        of the scope (the file was deleted outside the manager);
      * the whole index is processed in RECONCILE_BATCH chunks - no silent
        truncation, no single unbounded lock hold.
    The root_key tie-break follows the scan order (root0 first) - the same
    first-root-wins precedence the Files listing applies to identical
    relative paths in different roots."""
    if _wf_index is None:
        return 0
    if time.time() - _reconcile_ts[0] < 10:
        return _reconcile_ts[1]
    db = _wf_index._db_path()
    if not os.path.isfile(db):
        return 0
    try:
        import sqlite3
        conn = sqlite3.connect(db, timeout=10)
        # scope-filtered; root_key orders the same-rel-path collision exactly
        # like the Files listing walk does (first root wins). Every row marks
        # its path as SEEN (a broken-JSON file still exists on disk - its
        # binding must never be swept as vanished); only ok rows BIND.
        rows = conn.execute(
            "SELECT workflow_id, rel_path, raw_hash, mtime_ns, name, root_key "
            "FROM workflow_files WHERE user_scope=? "
            "ORDER BY root_key ASC, rel_path ASC",
            (scope,)).fetchall()
        conn.close()
    except Exception:
        return 0
    n = 0
    all_seen = set()   # every index path of the scope across ALL chunks

    def _detach_if_stale(pid, rel_path):
        """Release the path binding of ONE process (manifest + maps).
        Returns True when the binding actually existed."""
        p = _proc_cache["by_pid"].get(pid)
        if not p:
            return False
        if rel_path not in (_proc_cache["paths_of"].get(pid) or ()):
            return False
        detach_location(pid, rel_path)
        return True

    for start in range(0, len(rows), RECONCILE_BATCH):
        chunk = rows[start:start + RECONCILE_BATCH]
        with _lock:
            _cache_load_locked()
            by_path = _proc_cache["by_path"].get(scope) or {}
            # v116: the FIRST row per rel_path (root_key order = the same
            # first-root-wins precedence the Files listing applies) OWNS
            # the path for this pass - a second root's row for the same
            # rel path is a duplicate listing entry, never a rebinding.
            seen_paths = {}
            for workflow_id, rel_path, raw_hash, mtime_ns, name, _rk in chunk:
                if rel_path in seen_paths:
                    continue
                seen_paths[rel_path] = (workflow_id, rel_path, raw_hash,
                                        mtime_ns, name)
                all_seen.add(rel_path)
                pid = by_path.get(rel_path)
                if pid:
                    p = _proc_cache["by_pid"].get(pid)
                    loc = None
                    for l in (p or {}).get("locations") or []:
                        if l.get("path") == rel_path:
                            loc = l
                            break
                    if (p and p.get("workflowId") == workflow_id and loc and
                            loc.get("lastSeenHash") == raw_hash and
                            loc.get("mtimeNs") == mtime_ns):
                        continue   # the binding is already current
                    if p and p.get("workflowId") != workflow_id:
                        # plan 3.3: the file under this path now carries a
                        # DIFFERENT (or no) UUID - the old binding dies
                        # FIRST, atomically; the old process + its history
                        # stay (orphaned history is legal and restorable)
                        _detach_if_stale(pid, rel_path)
            # second micro-pass per chunk: (re)attach the CURRENT owner row
            # per path (detached ones re-bind to the NEW uuid process;
            # unchanged ones cost nothing through the warm path)
            for rel_path, (workflow_id, _rp, raw_hash, mtime_ns, name) \
                    in seen_paths.items():
                if not workflow_id:
                    continue   # rule 8: no UUID - never bind, never merge
                cur = (_proc_cache["by_path"].get(scope) or {}).get(rel_path)
                p = _proc_cache["by_pid"].get(cur) if cur else None
                if p and p.get("workflowId") == workflow_id:
                    loc = next((l for l in p.get("locations") or []
                                if l.get("path") == rel_path), None)
                    if (loc and loc.get("lastSeenHash") == raw_hash and
                            loc.get("mtimeNs") == mtime_ns):
                        continue
                attach_location(_ensure_process(workflow_id,
                                                display_name=name,
                                                scope=scope)[0]["processId"],
                                rel_path, last_seen_hash=raw_hash,
                                mtime_ns=mtime_ns)
                n += 1
    # the vanished-path sweep (AFTER the last chunk): every scope process
    # holding a path that NO chunk saw among the index rows loses that
    # binding (the file was deleted/renamed outside the manager) - the
    # process itself and its revisions stay. v116 freshness guard: a
    # location bound AFTER the index's last scan is not "vanished" - the
    # index simply has not seen the file yet (a brand-new checkpoint must
    # not lose its location to a stale index). The explicit detach paths
    # (the Files-delete route) never rely on this sweep.
    try:
        _ls_row = _wf_index._db_path() if _wf_index else None
        if _ls_row and os.path.isfile(_ls_row):
            import sqlite3 as _sq3b
            _c2 = _sq3b.connect(_ls_row, timeout=5)
            _r2 = _c2.execute(
                "SELECT max(indexed_at) FROM workflow_files "
                "WHERE user_scope=?", (scope,)).fetchone()
            _c2.close()
            last_scan_ts = int((_r2 or [0])[0] or 0)
        else:
            last_scan_ts = 0
    except Exception:
        last_scan_ts = 0
    with _lock:
        _cache_load_locked()
        for p2 in list(_proc_cache["by_pid"].values()):
            if _manifest_scope(p2) != scope:
                continue
            for loc2 in list(p2.get("locations") or []):
                lp = loc2.get("path")
                if not isinstance(lp, str) or lp in all_seen:
                    continue
                if int(loc2.get("boundAt") or 0) > last_scan_ts and last_scan_ts:
                    # bound after the last scan - the index has not seen
                    # this file yet; NOT a vanished file
                    continue
                if last_scan_ts == 0:
                    continue   # an empty/stale index proves nothing
                _detach_if_stale(p2["processId"], lp)
                n += 1
    _reconcile_ts[0] = time.time()
    _reconcile_ts[1] = n
    return n


def resolve_path_process(rel_path, scope="default"):
    """The binding of ONE file path (the UI asks: which process does this
    file belong to, and does it differ from the last checkpoint?). v113:
    the O(1) path map instead of a full manifest re-read (the v112 code
    scanned EVERY process manifest on EVERY open of the history panel).
    v116: the map is scope-partitioned."""
    with _lock:
        reconcile_processes(scope)
        _cache_load_locked()
        pid = (_proc_cache["by_path"].get(scope) or {}).get(rel_path)
        if pid:
            return _proc_cache["by_pid"].get(pid)
        return None


def find_process_by_uuid(workflow_id, scope="default"):
    """v122: the process bound to ONE ComfyUI workflow UUID (the Open-tab
    history entry asks: a TEMPORARY tab has no file path yet, but its
    serialized graph carries the top-level "id" - the same UUID the
    processes are discovered by). O(1) over the same scope-partitioned
    uuid map the checkpoints bind with; a no-UUID query answers None."""
    if not isinstance(workflow_id, str) or not workflow_id.strip():
        return None
    with _lock:
        _cache_load_locked()
        pid = (_proc_cache["by_uuid"].get(scope) or {}).get(workflow_id.strip())
        if pid:
            return _proc_cache["by_pid"].get(pid)
        return None


def record_checkpoint_for_path(rel_path, data, note=None, source="checkpoint",
                               title=None, scope="default"):
    """The Checkpoint entry point used by the routes: find/create the
    process for the file's workflow UUID (extracted from the payload
    itself), attach the location, create the revision. v116: scope-aware
    bindings; a checkpoint that flips a path's UUID detaches the old
    process's binding first (the same contract reconcile enforces)."""
    analysis = None
    if _wf_index is not None:
        analysis, _err = _wf_index.analyze_workflow_bytes(data)
    workflow_id = analysis.get("workflow_id") if analysis else None
    if rel_path:
        with _lock:
            reconcile_processes(scope)
            _cache_load_locked()
            cur_pid = (_proc_cache["by_path"].get(scope) or {}).get(rel_path)
            if cur_pid:
                cur = _proc_cache["by_pid"].get(cur_pid)
                if cur and cur.get("workflowId") != workflow_id:
                    # the payload's UUID differs from the path's bound one -
                    # release the stale binding before attaching (plan 3.3)
                    detach_location(cur_pid, rel_path)
    if not workflow_id:
        # rule 8: a file without a valid UUID still gets a process, bound to
        # the file path (never merged by name/similarity)
        proc = resolve_path_process(rel_path, scope) if rel_path else None
        if not proc:
            proc, _c = _ensure_process(None, display_name=title, scope=scope)
            if rel_path:
                attach_location(proc["processId"], rel_path)
        pid = proc["processId"]
    else:
        proc, _c = _ensure_process(workflow_id,
                                   display_name=title or (rel_path or "").split("/")[-1],
                                   scope=scope)
        if rel_path:
            attach_location(proc["processId"], rel_path,
                            last_seen_hash=analysis.get("raw_hash"))
        pid = proc["processId"]
    meta = {
        "source": source,
        "sourcePath": rel_path,
        "note": note,
        "title": title,
        "canonicalHash": analysis.get("canonical_hash") if analysis else None,
        "workflowHash": analysis.get("workflow_hash") if analysis else None,
        "presentationHash": analysis.get("presentation_hash") if analysis else None,
        "extensionHash": analysis.get("extension_hash") if analysis else None,
        "normalizationProfileVersion": (_wf_index.NORMALIZATION_PROFILE_VERSION
                                        if _wf_index else "nprof1"),
    }
    r = create_revision(pid, data, meta)
    r["processId"] = pid
    return r


def import_revision_for_process(pid, data, note=None, title=None,
                                source_path=None, scope="default"):
    """v126 (owner request): attach ANY workflow's bytes as ONE MORE version
    of an EXISTING process - the Process-history panel's Import (a foreign
    file picked in the browser, or the currently open tab's in-memory graph
    dropped into this process's history).

    The contract differs from record_checkpoint_for_path ON PURPOSE: the
    revision lands on the GIVEN processId and NOTHING ELSE moves - the
    location bindings, the uuid map and the process's own workflowId are
    never touched. Importing a foreign-UUID workflow must NOT re-bind the
    process to that foreign UUID (the checkpoint ladder's detach/attach
    logic does exactly that and is deliberately NOT reused here). The
    imported content's own workflow UUID (when the bytes carry one) is kept
    in the revision manifest as `importedWorkflowId` for provenance only.

    Dedupe follows create_revision (identical raw bytes to the LAST revision
    -> no new revision)."""
    if not isinstance(data, (bytes, bytearray)):
        return {"ok": False, "error": "payload must be bytes"}
    with _lock:
        reconcile_processes(scope if isinstance(scope, str) and scope else "default")
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        if _manifest_scope(proc) != (scope if isinstance(scope, str) and scope else "default"):
            return {"ok": False, "error": "the process belongs to another user scope"}
    analysis = None
    if _wf_index is not None:
        analysis, _err = _wf_index.analyze_workflow_bytes(data)
    meta = {
        "source": "import",
        "sourcePath": source_path if isinstance(source_path, str) and source_path else None,
        "note": note,
        "title": title,
        "canonicalHash": analysis.get("canonical_hash") if analysis else None,
        "workflowHash": analysis.get("workflow_hash") if analysis else None,
        "presentationHash": analysis.get("presentation_hash") if analysis else None,
        "extensionHash": analysis.get("extension_hash") if analysis else None,
        "normalizationProfileVersion": (_wf_index.NORMALIZATION_PROFILE_VERSION
                                        if _wf_index else "nprof1"),
    }
    r = create_revision(pid, bytes(data), meta)
    if r.get("ok") and not r.get("duplicate") and analysis:
        # provenance only - the process binding is NEVER re-pointed
        r["importedWorkflowId"] = analysis.get("workflow_id") or None
    r["processId"] = pid
    return r


# ---------------------------------------------------------------------------
# Transaction safety snapshots (plan 5.7: before EVERY destructive action)
# ---------------------------------------------------------------------------

def make_tx_snapshot(rel_path, data):
    """A checked-in copy of the data a destructive action is about to touch.
    Returns {ok, txId, hash} - the action may proceed only on ok."""
    if not isinstance(data, (bytes, bytearray)):
        return {"ok": False, "error": "payload must be bytes"}
    data = bytes(data)
    with _lock:
        _resolve_backend()
        txid = _new_id()
        rec = {
            "txId": txid,
            "path": rel_path,
            "hash": _sha256(data),
            "size": len(data),
            "ts": _now(),
        }
        try:
            _atomic_write_json(os.path.join(_tx_dir(), txid + ".json"), rec)
            with open(os.path.join(_tx_dir(), txid + ".blob"), "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}
        _tx_gc_locked()
        return {"ok": True, "txId": txid, "hash": rec["hash"]}


def read_tx_snapshot(txid):
    if not isinstance(txid, str) or not _ID_RE.match(txid):
        return None
    try:
        with open(os.path.join(_tx_dir(), txid + ".blob"), "rb") as f:
            return f.read()
    except Exception:
        return None


def drop_tx_snapshot(txid):
    for suffix in (".json", ".blob"):
        try:
            os.unlink(os.path.join(_tx_dir(), txid + suffix))
        except OSError:
            pass
    return True


def _tx_gc_locked():
    now = _now()
    items = []
    for txid in _list_ids(_tx_dir()):
        rec = _read_json(os.path.join(_tx_dir(), txid + ".json"))
        items.append((txid, int((rec or {}).get("ts", 0) or 0)))
    items.sort(key=lambda x: -x[1])
    # v116 (plan 7.6): the tx snapshots an UNDO MANIFEST still references
    # (the Files batch-delete keeps one manifest with the per-file tx ids
    # for UNDO_MAX_AGE_S) are protected from the count-based GC - the undo
    # button must be able to restore what it promised. The TTL still wins:
    # expired snapshots die regardless of the protection.
    protected = set()
    try:
        if callable(TX_PROTECT_HOOK):
            protected = {x for x in (TX_PROTECT_HOOK() or ())
                         if isinstance(x, str)}
    except Exception:
        protected = set()
    for txid, ts in items:
        if now - ts > TX_SNAPSHOT_TTL_S:
            drop_tx_snapshot(txid)
    keep = [x for x in items if now - x[1] <= TX_SNAPSHOT_TTL_S]
    kept = 0
    for txid, _ts in keep:
        kept += 1
        if kept > TX_MAX_FILES and txid not in protected:
            drop_tx_snapshot(txid)


# v116: set by the route layer to a callable returning the tx ids the
# Files-delete undo manifests still reference (see _tx_gc_locked).
TX_PROTECT_HOOK = None


# ---------------------------------------------------------------------------
# Stats + maintenance
# ---------------------------------------------------------------------------

def storage_stats():
    """v116 (plan 5.4): the transparent storage stats - LOGICAL bytes (the
    uncompressed payload sum, deduplicated payloads counted per reference)
    are kept strictly apart from PHYSICAL bytes (what the filesystem
    actually holds); the metadata (catalog manifests) and the transaction
    snapshot folder report their own physical sizes. No `freedBytes`
    promises: every number here is a measurement."""
    with _lock:
        kind = _resolve_backend()
        procs = _list_ids(_hist_dir("catalog", "processes"))
        revs = _list_ids(_hist_dir("catalog", "revisions"))
        stable = 0
        total_bytes = 0
        meta_bytes = 0
        for pid in procs:
            try:
                meta_bytes += os.path.getsize(_process_file(pid))
            except OSError:
                pass
        for rid in revs:
            rf = _revision_file(rid)
            try:
                meta_bytes += os.path.getsize(rf)
            except OSError:
                pass
            r = _read_json(rf)
            if not r:
                continue
            if r.get("isStable"):
                stable += 1
            total_bytes += int(r.get("size") or 0)
        # the transaction-snapshot folder (physical)
        tx_bytes = 0
        tx_count = 0
        for dp, _dn, fns in os.walk(_tx_dir()):
            for fn in fns:
                try:
                    tx_bytes += os.path.getsize(os.path.join(dp, fn))
                    tx_count += 1
                except OSError:
                    pass
        if kind == "git":
            physical = _git_dir_size()
        else:
            physical = _cas_size()
        return {
            "ok": True,
            "backend": kind,          # internal - the UI never shows it
            "processes": len(procs),
            "revisions": len(revs),
            "stableRevisions": stable,
            "logicalBytes": total_bytes,   # uncompressed payload sizes
            "physicalBytes": physical,     # the packed/compressed store
            "historyMetadataBytes": meta_bytes,   # the catalog manifests
            "txSnapshotBytes": tx_bytes,
            "txSnapshotFiles": tx_count,
            "gitAvailable": _git_available(),
        }


# ---------------------------------------------------------------------------
# v116 (plan 5.3): COMPACT HISTORY. Ordinary deletions do NOT free Git pack
# bytes (the deleted revisions stay reachable from the shared ref until the
# store is rebuilt), and the CAS fallback accumulates blobs of erased
# revisions. Compact rebuilds the object store from the RETAINED payloads
# only: a preflight report (counts + sizes + free disk space), a NEW store
# built in a neighboring temp directory, every retained blob read back and
# SHA-256 verified, fsck on the git backend, THEN the atomic directory
# switch with the old store kept as rollback until the post-check passes.
# Nothing here runs automatically - the storage dashboard button is the
# only entry point, and stable/current/manual revisions are never dropped.
# ---------------------------------------------------------------------------

def compact_history():
    """Rebuild the shared object store from the retained revisions. Returns
    a report: {ok, preflight: {...}, before, after, verified, ...}."""
    report = {"ok": False, "backend": None, "verified": 0}
    with _lock:
        kind = _resolve_backend()
        report["backend"] = kind
        _rev_cache_load_locked(force=True)
        _cache_load_locked(force=True)
        retained = []
        for r in _rev_cache["by_rid"].values():
            st = r.get("storage") or {}
            if isinstance(st.get("blob"), str) and st.get("blob"):
                retained.append(r)
        total_logical = sum(int(r.get("size") or 0) for r in retained)
        before = _git_dir_size() if kind == "git" else _cas_size()
        free = 0
        try:
            free = shutil.disk_usage(_base()).free
        except Exception:
            pass
        report["preflight"] = {
            "revisions": len(retained),
            "logicalBytes": total_logical,
            "currentStoreBytes": before,
            "freeBytes": free,
        }
        if not retained:
            report["ok"] = True
            report["before"] = before
            report["after"] = before
            report["note"] = "nothing to compact"
            return report
        # every retained payload, read and verified BEFORE building anything
        payloads = []
        broken = 0
        for r in retained:
            st = r.get("storage") or {}
            data = _read_stored(st.get("backend"), st.get("blob"))
            if data is None or (r.get("rawHash")
                                and _sha256(data) != r.get("rawHash")):
                broken += 1
                continue   # a broken revision cannot be retained honestly
            payloads.append((r, data))
        report["preflight"]["broken"] = broken
        if broken:
            # plan: never quietly drop revisions - a broken store refuses
            report["error"] = ("%d retained revision(s) failed the "
                               "integrity check - compact refused" % broken)
            return report
        if free and free < max(total_logical, 1) * 2:
            report["error"] = "not enough free disk space for the rebuild"
            return report
        stamp = _now()
        if kind == "git":
            new_dir = _git_dir() + ".compact-%d" % stamp
            old_dir = _git_dir()
            env = _git_env()
            try:
                subprocess.run(["git", "init", "--bare", "-q", new_dir],
                               check=True, capture_output=True, env=env)
                subprocess.run(["git", "--git-dir", new_dir, "config",
                                "core.compression", "9"],
                               check=True, capture_output=True, env=env)
            except Exception as e:
                report["error"] = "the new store init failed: " + str(e)[:120]
                shutil.rmtree(new_dir, ignore_errors=True)
                return report

            def ngit(*args, inp=None):
                return subprocess.run(["git", "--git-dir", new_dir] + list(args),
                                      capture_output=True, env=env, input=inp,
                                      timeout=120)
            entries = []
            new_blobs = {}
            for r, data in payloads:
                rid = r.get("revisionId")
                proc = r.get("processId")
                res = ngit("hash-object", "-w", "--stdin", inp=data)
                if res.returncode != 0:
                    report["error"] = "blob write failed in the new store"
                    shutil.rmtree(new_dir, ignore_errors=True)
                    return report
                oid = res.stdout.decode().strip()
                new_blobs[rid] = oid
                entries.append(("100644", oid, "rev-%s.json" % rid))
                if proc:
                    entries.append(("100644", oid,
                                    "current-%s.json" % proc))
            # dedupe the tree entries by name (current-<pid> keeps the LAST
            # write = the process's current revision)
            entries = list({name: (m, o, name) for m, o, name in entries}.values())
            lines = "".join("%s blob %s\t%s\n" % e for e in entries)
            res = ngit("mktree", inp=lines.encode())
            if res.returncode != 0:
                report["error"] = "tree write failed in the new store"
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            tree = res.stdout.decode().strip()
            res = ngit("commit-tree", tree, "-m", "compact %d" % stamp)
            if res.returncode != 0:
                report["error"] = "commit failed in the new store"
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            commit = res.stdout.decode().strip()
            if ngit("update-ref", GIT_REF, commit).returncode != 0:
                report["error"] = "ref update failed in the new store"
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            if ngit("repack", "-adf", "--depth=50", "--window=100",
                    "-q").returncode != 0:
                report["error"] = "repack failed in the new store"
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            fsck = ngit("fsck", "--no-dangling")
            if fsck.returncode != 0:
                report["error"] = "fsck failed in the new store: " + \
                    fsck.stderr.decode(errors="replace")[:200]
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            # read back EVERY retained blob and verify the hash
            verified = 0
            for r, _data in payloads:
                rid = r.get("revisionId")
                res = ngit("cat-file", "blob", new_blobs[rid])
                if res.returncode != 0:
                    report["error"] = "a retained blob is not readable in the new store"
                    shutil.rmtree(new_dir, ignore_errors=True)
                    return report
                if r.get("rawHash") and \
                        _sha256(res.stdout) != r.get("rawHash"):
                    report["error"] = "a retained blob failed the hash check"
                    shutil.rmtree(new_dir, ignore_errors=True)
                    return report
                verified += 1
            # the atomic switch (the old store stays as rollback until the
            # post-check below)
            prev_dir = old_dir + ".prev-%d" % stamp
            try:
                os.rename(old_dir, prev_dir)
                os.rename(new_dir, old_dir)
            except OSError as e:
                report["error"] = "the store switch failed: " + str(e)[:120]
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            # post-check: the ref resolves through the NEW store
            head = _git_head()
            if not head:
                # rollback
                try:
                    os.rename(old_dir, new_dir)
                    os.rename(prev_dir, old_dir)
                except OSError:
                    pass
                report["error"] = "the post-check failed - rolled back"
                shutil.rmtree(new_dir, ignore_errors=True)
                return report
            after = _git_dir_size()
            try:
                shutil.rmtree(prev_dir, ignore_errors=True)
            except Exception:
                pass
            report.update({"ok": True, "before": before, "after": after,
                           "verified": verified,
                           "retained": len(payloads)})
            return report
        # CAS backend: reclaim the blobs no retained revision references
        live = set(r["storage"]["blob"] for r in retained
                   if isinstance((r.get("storage") or {}).get("blob"), str))
        cas_root = _hist_dir("cas")
        freed = 0
        reclaimed = 0
        for dp, _dn, fns in os.walk(cas_root):
            for fn in fns:
                if not fn.endswith(".z"):
                    continue
                oid = fn[:-2]
                if oid not in live:
                    p = os.path.join(dp, fn)
                    try:
                        freed += os.path.getsize(p)
                    except OSError:
                        freed += 0
                    try:
                        os.unlink(p)
                        reclaimed += 1
                    except OSError:
                        pass
        after = _cas_size()
        report.update({"ok": True, "before": before, "after": after,
                       "verified": len(payloads), "retained": len(payloads),
                       "reclaimedBlobs": reclaimed, "freedBytes": freed})
        return report


def run_maintenance():
    """Housekeeping OUTSIDE the checkpoint critical section (plan 5.6.3):
    the git backend repacks; the CAS backend has nothing to do. Stable and
    manual revisions are NEVER touched - this only compacts the object db."""
    with _lock:
        kind = _resolve_backend()
        if kind == "git":
            r = _git("repack", "-adf", "--depth=50", "--window=100", "-q")
            return {"ok": r.returncode == 0, "backend": kind}
        return {"ok": True, "backend": kind, "note": "nothing to compact"}


def verify_store():
    """Crash recovery helper: an fsck-style integrity probe. Orphan objects
    are legal (an interrupted checkpoint); a broken ref chain is reported."""
    kind = _resolve_backend()
    if kind == "git":
        r = _git("fsck", "--no-dangling")
        return {"ok": r.returncode == 0, "backend": kind,
                "detail": r.stderr.decode(errors="replace")[:400]}
    return {"ok": True, "backend": kind}
