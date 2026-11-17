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
MAX_REVISIONS_PER_PROCESS = 500         # a hard bound; retention trims first
MAX_PROCESS_NAME_CHARS = 120
MAX_NOTE_CHARS = 2000
TX_SNAPSHOT_TTL_S = 6 * 60 * 60         # transaction safety snapshots TTL
TX_MAX_FILES = 40
GIT_REF = "refs/heads/history"          # the ONE shared ref (plan 5.6.2)
_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")

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
    identical UX when the git binary is missing."""
    with _lock:
        if _backend_cache["resolved"]:
            return _backend_cache["kind"]
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
_proc_cache = {"loaded": False, "by_pid": {}, "by_uuid": {}, "by_path": {},
               "paths_of": {}, "sig": None}


def _proc_sig():
    try:
        return sorted(os.listdir(_hist_dir("catalog", "processes")))
    except OSError:
        return []


def _cache_load_locked(force=False):
    """ONE pass over the process manifests -> pid/uuid/path maps. Sorted
    order keeps the binding pick deterministic (v112 iterated listdir
    order, which is arbitrary)."""
    sig = _proc_sig()
    if _proc_cache["loaded"] and not force and sig == _proc_cache["sig"]:
        return
    by_pid, by_uuid, by_path, paths_of = {}, {}, {}, {}
    for pid in sorted(_list_ids(_hist_dir("catalog", "processes"))):
        p = _read_json(_process_file(pid))
        if not p or p.get("processId") != pid:
            continue
        by_pid[pid] = p
        wid = p.get("workflowId")
        if isinstance(wid, str) and wid and wid not in by_uuid:
            by_uuid[wid] = pid
        pths = set()
        for loc in p.get("locations") or []:
            lp = loc.get("path")
            if isinstance(lp, str) and lp and lp not in by_path:
                by_path[lp] = pid
                pths.add(lp)
        paths_of[pid] = pths
    _proc_cache["by_pid"] = by_pid
    _proc_cache["by_uuid"] = by_uuid
    _proc_cache["by_path"] = by_path
    _proc_cache["paths_of"] = paths_of
    _proc_cache["sig"] = sig
    _proc_cache["loaded"] = True


def _cache_put_locked(p):
    """Keep the maps in sync after THIS module writes a process manifest."""
    pid = p.get("processId")
    if not isinstance(pid, str):
        return
    _proc_cache["loaded"] = True
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
            if _proc_cache["by_path"].get(lp) == pid:
                _proc_cache["by_path"].pop(lp, None)
    by_uuid = _proc_cache["by_uuid"]
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
    pths = set()
    for loc in p.get("locations") or []:
        lp = loc.get("path")
        if isinstance(lp, str) and lp:
            pths.add(lp)
            if _proc_cache["by_path"].get(lp) in (None, pid):
                _proc_cache["by_path"][lp] = pid
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


def list_processes():
    """All process manifests, newest-activity first. Reconciles the file
    bindings from the derived index first (the processes are DISCOVERED
    from the ComfyUI UUIDs the index extracted - plan 5.1). v113: served
    from the in-memory catalog cache (one disk pass per session instead of
    a full re-read per call - the route stays instant with 2000+ processes)."""
    with _lock:
        _resolve_backend()
        reconcile_processes()
        _cache_load_locked()
        out = [p for p in _proc_cache["by_pid"].values()
               if p and p.get("processId")]
        out.sort(key=lambda p: -(p.get("updatedAt") or 0))
        return out


def get_process(pid):
    with _lock:
        _resolve_backend()
        reconcile_processes()
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
        return {"ok": True, "duplicate": False, "revisionId": rid, "revision": rec}


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
    live in the same store)."""
    with _lock:
        rec = _read_revision(rid)
        if not rec:
            return {"ok": False, "error": "no such revision"}
        rec["note"] = _sanitize_name(note, MAX_NOTE_CHARS)
        rec["noteEditedAt"] = _now()
        _atomic_write_json(_revision_file(rid), rec)
        _rev_cache_put_locked(rec)
        return {"ok": True, "revisionId": rid}


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
    say exactly why a version survived."""
    if not isinstance(rids, list):
        return {"ok": False, "error": "revisionIds must be a list"}
    clean = []
    for x in rids[:1000]:
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


def revision_badges():
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
    shows up - duplicates matter even before the first Checkpoint."""
    with _lock:
        reconcile_processes()   # throttled (10s); keeps the bindings fresh
        _cache_load_locked()
        _rev_cache_load_locked()
        out = {}
        for pid, revs in _rev_cache["of_pid"].items():
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
            if pid in _rev_cache["of_pid"]:
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


def delete_process(pid, delete_files=False, file_remover=None):
    """v115 (owner request): "кнопка удалять сами процессы со всеми
    хвостами" - erase ONE process AND everything attached to it: every
    revision manifest, the stored blobs no other revision references (the
    CAS backend reclaims the real bytes; the git backend keeps its
    immutable commit chain - the manifests still die so the process
    disappears), every location binding and the process manifest itself.
    The version-level protections (stable/current) live at the REVISION
    level - an explicit process erasure removes the whole object, the
    armed two-click confirm in the UI is the consent.

    delete_files: ALSO remove the physical workflow files of every
    location. The remover callable is injected by the route layer (it owns
    the library roots + the tx safety snapshots); every file result is
    reported back verbatim so the UI can name exactly what happened.

    The catalog writes stay atomic; the caches are dropped in one pass so
    a subsequent reconcile sees a clean world (and with the files gone the
    index rows are removed by the route too - a ghost row would resurrect
    the process)."""
    if not isinstance(pid, str) or not _ID_RE.match(pid):
        return {"ok": False, "error": "bad processId"}
    if file_remover is not None and not callable(file_remover):
        return {"ok": False, "error": "file_remover must be callable"}
    with _lock:
        proc = _read_process(pid)
        if not proc:
            return {"ok": False, "error": "no such process"}
        _rev_cache_load_locked()
        _cache_load_locked()
        revs = list(_rev_cache["of_pid"].get(pid) or [])
        # 1) the physical files first (the remover owns roots + snapshots)
        files = []
        if delete_files and file_remover is not None:
            for lp in sorted(_proc_cache["paths_of"].get(pid) or ()):
                try:
                    files.append(file_remover(lp) or {"path": lp})
                except Exception as e:   # a hostile remover must not wed the store
                    files.append({"path": lp, "removed": False,
                                  "error": str(e)[:160]})
        # 2) the CAS blobs this process uniquely owns (content dedupe means
        #    a blob may be shared with ANOTHER process's revisions)
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
        # 3) the revision manifests (no splice needed - the whole chain dies)
        for r in revs:
            rid = r.get("revisionId")
            if isinstance(rid, str):
                try:
                    os.unlink(_revision_file(rid))
                except OSError:
                    pass
                _rev_cache_drop_locked(rid)
        # 4) the process manifest + the caches
        try:
            os.unlink(_process_file(pid))
        except OSError:
            pass
        _proc_cache["by_pid"].pop(pid, None)
        wid = proc.get("workflowId")
        if wid and _proc_cache["by_uuid"].get(wid) == pid:
            _proc_cache["by_uuid"].pop(wid, None)
        for lp in (_proc_cache["paths_of"].pop(pid, None) or ()):
            if _proc_cache["by_path"].get(lp) == pid:
                _proc_cache["by_path"].pop(lp, None)
        # the file-set signature changes (a manifest vanished) - the next
        # reconcile pass must not serve a stale cache
        sig = _proc_cache["sig"]
        if isinstance(sig, list):
            _proc_cache["sig"] = [n for n in sig if n != pid + ".json"]
        else:
            _proc_cache["sig"] = None
        _reconcile_ts[0] = 0   # the discovery must re-run immediately
        return {"ok": True, "processId": pid,
                "deletedRevisions": len(revs),
                "freedBytes": freed,
                "files": files,
                "backend": _resolve_backend()}


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

def _ensure_process(workflow_id, display_name=None, note=None):
    """Find the process bound to a ComfyUI workflow UUID, or create it
    (plan 2.1 rule 2: one valid UUID -> ONE processId). v113: the lookup
    is the in-memory uuid map (the v112 code re-read EVERY manifest per
    call - O(N) per row made reconcile O(N^2) file reads with a large
    library)."""
    with _lock:
        if workflow_id:
            _cache_load_locked()
            hit = _proc_cache["by_uuid"].get(workflow_id)
            if hit:
                p = _proc_cache["by_pid"].get(hit)
                if p:
                    return p, False
        pid = _new_id()
        now = _now()
        proc = {
            "processId": pid,
            "workflowId": workflow_id if isinstance(workflow_id, str) else None,
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
        return {"ok": True, "process": proc}


_reconcile_ts = [0, 0]  # [last_run, count] - a small TTL guard


def reconcile_processes():
    """DISCOVERY (plan 5.1 + stage-2 item 6): group the indexed files by
    ComfyUI UUID - every valid workflow_id becomes/updates ONE process with
    the file paths as locations. Files WITHOUT an id are never bound (rule
    8: no basename/similarity auto-merge). Cheap: a GROUP BY over the index;
    throttled to once per 10s (every process listing re-checks). v113: a
    row whose binding is already current (same process, same path, same
    hash + mtime) costs ZERO reads and ZERO writes - the warm pass over a
    2000-process library is one SELECT plus dict lookups."""
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
        rows = conn.execute(
            "SELECT workflow_id, rel_path, raw_hash, mtime_ns, name FROM "
            "workflow_files WHERE workflow_id IS NOT NULL AND parse_status='ok' "
            "ORDER BY mtime_ns DESC").fetchall()
        conn.close()
    except Exception:
        return 0
    n = 0
    with _lock:
        _cache_load_locked()
        for workflow_id, rel_path, raw_hash, mtime_ns, name in rows[:5000]:
            pid = _proc_cache["by_path"].get(rel_path)
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
                    continue  # the binding is already current - touch nothing
            proc, _created = _ensure_process(workflow_id, display_name=name)
            attach_location(proc["processId"], rel_path,
                            last_seen_hash=raw_hash, mtime_ns=mtime_ns)
            n += 1
    _reconcile_ts[0] = time.time()
    _reconcile_ts[1] = n
    return n


def resolve_path_process(rel_path):
    """The binding of ONE file path (the UI asks: which process does this
    file belong to, and does it differ from the last checkpoint?). v113:
    the O(1) path map instead of a full manifest re-read (the v112 code
    scanned EVERY process manifest on EVERY open of the history panel)."""
    with _lock:
        reconcile_processes()
        _cache_load_locked()
        pid = _proc_cache["by_path"].get(rel_path)
        if pid:
            return _proc_cache["by_pid"].get(pid)
        return None


def record_checkpoint_for_path(rel_path, data, note=None, source="checkpoint",
                               title=None):
    """The Checkpoint entry point used by the routes: find/create the
    process for the file's workflow UUID (extracted from the payload
    itself), attach the location, create the revision."""
    analysis = None
    if _wf_index is not None:
        analysis, _err = _wf_index.analyze_workflow_bytes(data)
    workflow_id = analysis.get("workflow_id") if analysis else None
    if not workflow_id:
        # rule 8: a file without a valid UUID still gets a process, bound to
        # the file path (never merged by name/similarity)
        proc = resolve_path_process(rel_path) if rel_path else None
        if not proc:
            proc, _c = _ensure_process(None, display_name=title)
            if rel_path:
                attach_location(proc["processId"], rel_path)
        pid = proc["processId"]
    else:
        proc, _c = _ensure_process(workflow_id,
                                   display_name=title or (rel_path or "").split("/")[-1])
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
    for txid, ts in items:
        if now - ts > TX_SNAPSHOT_TTL_S:
            drop_tx_snapshot(txid)
    for txid, _ts in items[:TX_MAX_FILES]:
        pass
    for txid, _ts in items[TX_MAX_FILES:]:
        drop_tx_snapshot(txid)


# ---------------------------------------------------------------------------
# Stats + maintenance
# ---------------------------------------------------------------------------

def storage_stats():
    with _lock:
        kind = _resolve_backend()
        procs = _list_ids(_hist_dir("catalog", "processes"))
        revs = _list_ids(_hist_dir("catalog", "revisions"))
        stable = 0
        total_bytes = 0
        for rid in revs:
            r = _read_json(_revision_file(rid))
            if not r:
                continue
            if r.get("isStable"):
                stable += 1
            total_bytes += int(r.get("size") or 0)
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
            "gitAvailable": _git_available(),
        }


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
