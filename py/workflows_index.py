"""v112 stage 2: the DERIVED SQLite index of the workflow library
(plan 4.x of Workflow_Manager_Agent_Plan.md).

WHAT THIS IS
------------
A rebuildable CACHE over the user's workflow JSON files - never the source
of truth. The library lives in the ComfyUI userdata folders; if this DB is
deleted or corrupted it is re-scanned from the filesystem WITHOUT touching
a single workflow file (the plan's acceptance criterion #6).

    <user>/settings_hub/workflows_manager/index/workflow_index.db

The DB sits in the DEFAULT user dir (outside the re-pointable presets
storage root, outside every workflows/ walk root, never inside the JSON
library itself). Multi-user isolation follows the same _workflows_user_dirs
logic as the Files listing: the row key is (user_scope, root_key, rel_path)
and a request's comfy-user header scopes every query.

LAYERED FINGERPRINTS (plan 2.2) - one hash per question:
    raw_hash          SHA-256 of the exact file bytes
    canonical_hash    SHA-256 of the canonical JSON dump (sorted keys,
                      compact separators) - formatting/order insensitive
    workflow_hash     the WORKING GRAPH: everything except the confirmed
                      presentation/environment fields (extra.ds.scale,
                      extra.ds.offset, extra.frontendVersion). Unclassified
                      extension fields STAY IN - the plan forbids dropping
                      them silently.
    presentation_hash the confirmed canvas/layout metadata (extra.ds,
                      nodes[].pos/size and the visual-only node fields)
    extension_hash    the unclassified/behavior-relevant extra metadata
    structural_hash   optional topology fingerprint (sorted node types) -
                      similarity HINT only, never an identity proof
    normalization_profile_version  the rules version ("nprof1") - a rule
                      change re-indexes, old hashes are never silently
                      reinterpreted

EXTRACTION (plan 4.5) - only what the schema actually carries:
    workflow_id (top-level "id"), node count, node classes, node titles,
    model-looking strings ONLY from confirmed keys (ckpt_name, lora_name,
    vae_name, unet_name, control_net_name, model_name...), the
    extra_summary (known metadata keys), parse status/error.
Nothing is written back to the JSON files.

SEARCH (plan 4.6): FTS5 when the build ships it (verified at runtime),
a tested LIKE fallback otherwise. The endpoint answers paginated queries
with a stable keyset cursor (canonical path tie-break).
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_ANALYZE_BYTES = 8 * 1024 * 1024      # plan 4.4: no unbounded reads
MAX_SEARCH_TEXT_CHARS = 20000           # the FTS payload budget per file
MAX_ERROR_CHARS = 200
NORMALIZATION_PROFILE_VERSION = "nprof1"
SCHEMA_VERSION = "1"

_DB_DIRNAME = "index"
_DB_NAME = "workflow_index.db"
_db_lock = threading.RLock()             # SQLite writes serialize per process
_scan_lock = threading.Lock()            # one scan at a time
_init_done = set()                       # initialized DB paths

# The model-bearing widget keys (plan 4.5: confirmed keys only - a random
# string is NOT guessed to be a model name)
_MODEL_KEYS = {
    "ckpt_name", "lora_name", "vae_name", "unet_name", "control_net_name",
    "model_name", "clip_name", "style_model_name", "hypernetwork",
    "gligen", "upscale_model", "ipadapter_file", "instantid_file",
}
_MODEL_RE = re.compile(
    r"\.(safetensors|ckpt|pt|pth|sft|bin|onnx)$", re.IGNORECASE)

# Node fields that are PRESENTATION-only (plan 2.2: schema-verified list).
# Anything not in this set stays inside workflow_hash.
_PRESENTATION_NODE_KEYS = {"pos", "size", "bgcolor", "color", "collapsed",
                          "shape", "loc"}

# extra keys classified as ENVIRONMENT/viewport (excluded from
# workflow_hash, kept inside canonical_hash AND presentation_hash)
_EXTRA_ENV_KEYS = {"ds", "frontendVersion"}
# extra keys classified as PRESENTATION metadata when their value is a
# plain scalar/position (the versioned adapter registry grows ONLY after
# a verified check of the owning extension's code - plan 2.2)
_EXTRA_PRESENTATION_KEYS = set()


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _canon_json(obj):
    """The canonical serialization: sorted keys, compact separators. Arrays
    keep their order (the plan: ordering-insensitive ONLY for object keys)."""
    try:
        return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def _strip_presentation(wf):
    """A COPY of the workflow without the confirmed presentation/environment
    fields (extra.ds.*, extra.frontendVersion, nodes[].pos/size/...). The
    original document is NEVER modified."""
    if not isinstance(wf, dict):
        return wf, {}
    presentation = {}
    extra = wf.get("extra")
    if isinstance(extra, dict):
        pres_extra = {}
        for k, v in extra.items():
            if k in _EXTRA_ENV_KEYS or k in _EXTRA_PRESENTATION_KEYS:
                pres_extra[k] = v
        if pres_extra:
            presentation["extra"] = pres_extra
    nodes = wf.get("nodes")
    if isinstance(nodes, list):
        pres_nodes = []
        for n in nodes:
            if not isinstance(n, dict):
                continue
            pn = {k: n[k] for k in _PRESENTATION_NODE_KEYS if k in n}
            if pn:
                pres_nodes.append(pn)
        if pres_nodes:
            presentation["nodes_pres"] = pres_nodes
    # rebuild the graph document without the presentation fields
    g = dict(wf)
    new_extra = {k: v for k, v in (extra or {}).items()
                 if isinstance(extra, dict) and k not in _EXTRA_ENV_KEYS
                 and k not in _EXTRA_PRESENTATION_KEYS}
    g["extra"] = new_extra
    if "nodes" in g and isinstance(g.get("nodes"), list):
        clean_nodes = []
        for n in g["nodes"]:
            if isinstance(n, dict):
                n2 = {k: v for k, v in n.items()
                      if k not in _PRESENTATION_NODE_KEYS}
                clean_nodes.append(n2)
            else:
                clean_nodes.append(n)
        g["nodes"] = clean_nodes
    return g, presentation


def _extension_summary(wf):
    """The extension-owned extra fields - unclassified ones land here (the
    behavior-relevant unknowns). extra.ds / frontendVersion are classified
    and therefore NOT part of this hash."""
    extra = wf.get("extra") if isinstance(wf, dict) else None
    if not isinstance(extra, dict):
        return {}
    return {k: v for k, v in extra.items()
            if k not in _EXTRA_ENV_KEYS and k not in _EXTRA_PRESENTATION_KEYS}


def _extract_models(obj, out, depth=0):
    """A depth-bounded recursive collect of model-looking values - but ONLY
    under confirmed keys or values ending with a model extension."""
    if depth > 8 or out.get("_stop"):
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if isinstance(v, str):
                if kl in _MODEL_KEYS or _MODEL_RE.search(v):
                    out.setdefault("models", [])
                    if v not in out["models"] and len(out["models"]) < 60:
                        out["models"].append(v)
            else:
                _extract_models(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:200]:
            if isinstance(v, str):
                if _MODEL_RE.search(v):
                    out.setdefault("models", [])
                    if v not in out["models"] and len(out["models"]) < 60:
                        out["models"].append(v)
            else:
                _extract_models(v, out, depth + 1)


def _collect_text_values(obj, out, depth=0):
    """The search-text harvest: strings from widget/input-like keys, node
    titles and types. Depth- and size-bounded."""
    if depth > 8 or len(out) > MAX_SEARCH_TEXT_CHARS:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if isinstance(v, str) and (kl in ("title", "type", "name")
                    or "widget" in kl or kl in ("text", "prompt", "value")):
                if len(v) < 400 and v not in out:
                    out.append(v)
            else:
                _collect_text_values(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:200]:
            if isinstance(v, str):
                if len(v) < 400 and v not in out:
                    out.append(v)
            else:
                _collect_text_values(v, out, depth + 1)


def analyze_workflow_bytes(raw):
    """The FULL per-file analysis: (record, error). Never raises - a corrupt
    JSON answers parse_status=error and keeps the file listable (plan 4.4:
    'a damaged JSON never breaks the whole query')."""
    size = len(raw)
    rec = {
        "raw_hash": _sha256(raw),
        "canonical_hash": None,
        "workflow_hash": None,
        "presentation_hash": None,
        "extension_hash": None,
        "structural_hash": None,
        "workflow_id": None,
        "node_count": None,
        "node_types": None,
        "node_titles": None,
        "model_refs": None,
        "extra_summary": None,
        "search_text": None,
        "parse_status": "ok",
        "parse_error": None,
        "normalized": False,
    }
    if size > MAX_ANALYZE_BYTES:
        rec["parse_status"] = "too_large_to_index"
        rec["parse_error"] = "file exceeds %d bytes" % MAX_ANALYZE_BYTES
        return rec, None
    try:
        wf = json.loads(raw.decode("utf-8"))
    except Exception as e:
        rec["parse_status"] = "error"
        rec["parse_error"] = str(e)[:MAX_ERROR_CHARS]
        return rec, None
    if not isinstance(wf, dict):
        rec["parse_status"] = "error"
        rec["parse_error"] = "top-level JSON is not an object"
        return rec, None
    canon = _canon_json(wf)
    rec["canonical_hash"] = _sha256(canon.encode("utf-8")) if canon else None
    rec["workflow_id"] = wf.get("id") if isinstance(wf.get("id"), str) else None
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    rec["node_count"] = len(nodes)
    types, titles = [], []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if isinstance(t, str) and t not in types:
            types.append(t)
        tt = n.get("title")
        if isinstance(tt, str) and tt and tt not in titles:
            titles.append(tt)
    rec["node_types"] = types[:400]
    rec["node_titles"] = titles[:200]
    # the layered hashes
    graph, presentation = _strip_presentation(wf)
    gcanon = _canon_json(graph)
    rec["workflow_hash"] = _sha256(gcanon.encode("utf-8")) if gcanon else None
    pcanon = _canon_json(presentation)
    rec["presentation_hash"] = _sha256(pcanon.encode("utf-8")) if pcanon else None
    ext = _extension_summary(wf)
    ecanon = _canon_json(ext)
    rec["extension_hash"] = _sha256(ecanon.encode("utf-8")) if ecanon else None
    rec["structural_hash"] = _sha256(
        _canon_json(sorted(t for t in types if t)).encode("utf-8")) if types else None
    rec["normalized"] = True
    # the summaries
    known_extra = {}
    extra = wf.get("extra")
    if isinstance(extra, dict):
        for k in ("ds", "frontendVersion"):
            if k in extra:
                known_extra[k] = extra[k]
    rec["extra_summary"] = known_extra
    models = {}
    _extract_models(wf, models)
    rec["model_refs"] = models.get("models") or []
    text_parts = []
    if rec["workflow_id"]:
        text_parts.append(rec["workflow_id"])
    text_parts.extend(types)
    text_parts.extend(titles)
    text_parts.extend(rec["model_refs"])
    _collect_text_values(wf.get("nodes") if isinstance(wf.get("nodes"), list) else [],
                         text_parts)
    # dedupe, keep bounded
    seen = set()
    search = []
    for s in text_parts:
        if isinstance(s, str) and s and s not in seen:
            seen.add(s)
            search.append(s)
            if sum(len(x) for x in search) > MAX_SEARCH_TEXT_CHARS:
                break
    rec["search_text"] = " ".join(search)[:MAX_SEARCH_TEXT_CHARS]
    return rec, None


# ---------------------------------------------------------------------------
# DB management
# ---------------------------------------------------------------------------

def _db_path():
    """The derived index DB of the DEFAULT user dir (plan 4.2: a stable
    service folder, never inside the mutable storage roots). The pack's
    routes inject the exact path at import time (set_db_path) - the module
    itself stays import-standalone (tests load it by file path)."""
    base = os.environ.get("SHUB_WF_USER_DIR_OVERRIDE")  # tests only
    if base:
        return os.path.join(base, "settings_hub", "workflows_manager",
                            _DB_DIRNAME, _DB_NAME)
    if _db_path_override:
        return _db_path_override
    # best-effort standalone default: the CWD user dir (the real pack always
    # injects the proper path - this fallback never runs in ComfyUI)
    return os.path.join(os.getcwd(), "user", "settings_hub",
                        "workflows_manager", _DB_DIRNAME, _DB_NAME)


_db_path_override = None


def set_db_path(p):
    """Inject the exact DB location (the pack's routes call this once at
    import). The path lives in the DEFAULT user dir and never follows a
    client-supplied value."""
    global _db_path_override
    _db_path_override = os.path.abspath(p)


def _connect(db):
    conn = sqlite3.connect(db, timeout=10)
    conn.execute("PRAGMA busy_timeout=8000")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _fts_available(conn):
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe "
                     "USING fts5(x)")
        conn.execute("DROP TABLE IF EXISTS _fts_probe")
        return True
    except sqlite3.DatabaseError:
        return False


def init_db(db=None):
    """Create/migrate the schema. Returns (db_path, fts: bool). A corrupt
    DB is quarantined (renamed, never deleted - the owner inspects it) and
    a fresh one is built; the user's JSON files are untouched."""
    db = db or _db_path()
    with _db_lock:
        os.makedirs(os.path.dirname(db), exist_ok=True)
        try:
            conn = _connect(db)
            ok = True
        except sqlite3.DatabaseError:
            ok = False
        if ok:
            try:
                conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            except sqlite3.DatabaseError:
                ok = False
            if ok:
                try:
                    _ensure_schema(conn)
                    conn.commit()
                    conn.close()
                    _init_done.add(os.path.normpath(db))
                    return db, _fts_flag(db)
                except sqlite3.DatabaseError:
                    ok = False
            conn.close()
        # corrupt -> quarantine + rebuild
        stamp = int(time.time())
        try:
            os.replace(db, db + ".corrupt-%d" % stamp)
        except OSError:
            try:
                os.unlink(db)
            except OSError:
                pass
        for suf in ("-wal", "-shm"):
            try:
                os.unlink(db + suf)
            except OSError:
                pass
        conn = _connect(db)
        _ensure_schema(conn)
        conn.commit()
        conn.close()
        _init_done.discard(os.path.normpath(db))
        return db, _fts_flag(db)


def _fts_flag(db):
    conn = _connect(db)
    try:
        return _fts_available(conn)
    finally:
        conn.close()


def _ensure_schema(conn):
    c = conn
    c.execute("CREATE TABLE IF NOT EXISTS meta ("
              "key TEXT PRIMARY KEY, value TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS workflow_files ("
              "user_scope TEXT NOT NULL,"
              "root_key TEXT NOT NULL,"
              "rel_path TEXT NOT NULL,"
              "name TEXT, folder TEXT,"
              "size_bytes INTEGER, mtime_ns INTEGER, inode INTEGER,"
              "mtime_sec INTEGER,"
              "workflow_id TEXT,"
              "raw_hash TEXT, canonical_hash TEXT, workflow_hash TEXT,"
              "presentation_hash TEXT, extension_hash TEXT,"
              "structural_hash TEXT,"
              "normalization_profile_version TEXT,"
              "extra_summary TEXT, node_count INTEGER,"
              "node_types TEXT, node_titles TEXT, model_refs TEXT,"
              "search_text TEXT,"
              "parse_status TEXT, parse_error TEXT,"
              "indexed_at INTEGER,"
              "PRIMARY KEY (user_scope, root_key, rel_path))")
    c.execute("CREATE INDEX IF NOT EXISTS idx_wf_id "
              "ON workflow_files (user_scope, workflow_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_wf_mtime "
              "ON workflow_files (user_scope, mtime_ns)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_wf_size "
              "ON workflow_files (user_scope, size_bytes)")
    # the FTS mirror is (re)built by the caller when FTS is available
    c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
              ("schema_version", SCHEMA_VERSION))
    c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
              ("normalization_profile_version", NORMALIZATION_PROFILE_VERSION))


def _ensure_fts(conn):
    """Create the FTS mirror if FTS5 exists; report availability. A freshly
    created mirror is REBUILT from workflow_files right away - a dropped
    table (or a recovered DB) self-heals on the next query/scan instead of
    answering empty results."""
    if not _fts_available(conn):
        return False
    row = conn.execute("SELECT count(*) FROM sqlite_master WHERE type='table' "
                       "AND name='workflow_fts'").fetchone()
    existed = bool(row and row[0])
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS workflow_fts USING fts5("
                 "search_text, content='workflow_files', content_rowid='rowid')")
    if not existed:
        conn.execute("INSERT INTO workflow_fts (rowid, search_text) "
                     "SELECT rowid, search_text FROM workflow_files")
    return True


def _fts_enabled(db):
    conn = _connect(db)
    try:
        row = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' "
            "AND name='workflow_fts'").fetchone()
        return bool(row and row[0])
    except sqlite3.DatabaseError:
        return False
    finally:
        conn.close()


def _fts_sync(conn, rowid, search_text):
    conn.execute("INSERT OR REPLACE INTO workflow_fts (rowid, search_text) "
                 "VALUES (?, ?)", (rowid, search_text or ""))


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

def _scan_roots(workflows_user_dirs, hide_dirs_fn):
    """[(root_key, dir, hide_set)] - the walks the caller (workflows_store)
    already trusts. root_key distinguishes the per-user roots."""
    out = []
    for i, d in enumerate(workflows_user_dirs):
        out.append(("root%d" % i, d, set(hide_dirs_fn(d))))
    return out


def scan_index(db=None, workflows_user_dirs=None, hide_dirs_fn=None,
               user_scope="default", force=False, progress=None):
    """ONE incremental pass over the library. Returns a stats dict.
    Runs in a WORKER THREAD (the caller wraps it in asyncio.to_thread) -
    the event loop never blocks (plan 4.4)."""
    db = db or _db_path()
    if not _scan_lock.acquire(blocking=False):
        return {"ok": False, "error": "a scan is already running",
                "scanned": 0, "indexed": 0, "changed": 0, "errors": 0,
                "removed": 0, "skipped_same": 0, "too_large": 0}
    try:
        with _db_lock:
            init_db(db)
        stats = {"ok": True, "scanned": 0, "indexed": 0, "changed": 0,
                 "errors": 0, "removed": 0, "skipped_same": 0,
                 "too_large": 0, "truncated": False,
                 "db": db, "fts": _fts_enabled(db),
                 "profile": NORMALIZATION_PROFILE_VERSION}
        seen_keys = set()
        MAX_WALK = 30000
        conn = _connect(db)
        try:
            fts = _ensure_fts(conn)
            for root_key, root_dir, hides in _scan_roots(
                    workflows_user_dirs or [], hide_dirs_fn or (lambda d: [])):
                for dirpath, dirnames, filenames in os.walk(root_dir):
                    # built-in defense: the storage internals (the settings_hub
                    # namespace: presets/temp/manager housekeeping) are NEVER
                    # indexed, even when the caller forgets its hide list
                    rel_dir = os.path.relpath(dirpath, root_dir).replace(os.sep, "/")
                    if rel_dir == "." :
                        rel_dir = ""
                    if any(seg == "settings_hub" for seg in rel_dir.split("/")):
                        dirnames[:] = []
                        continue
                    dirnames[:] = sorted(
                        d for d in dirnames
                        if os.path.normcase(os.path.abspath(
                            os.path.join(dirpath, d))) not in hides)
                    for fn in sorted(filenames):
                        if not fn.lower().endswith(".json"):
                            continue
                        full = os.path.join(dirpath, fn)
                        rel = os.path.relpath(full, root_dir).replace(os.sep, "/")
                        key = (user_scope, root_key, "workflows/" + rel)
                        seen_keys.add(key)
                        stats["scanned"] += 1
                        if stats["scanned"] > MAX_WALK:
                            stats["truncated"] = True
                            break
                        try:
                            st = os.stat(full)
                        except OSError:
                            continue
                        sig = (st.st_size, st.st_mtime_ns,
                               getattr(st, "st_ino", 0))
                        row = conn.execute(
                            "SELECT size_bytes, mtime_ns, inode, raw_hash, "
                            "parse_status, normalization_profile_version "
                            "FROM workflow_files WHERE user_scope=? AND "
                            "root_key=? AND rel_path=?",
                            (user_scope, root_key, key[2])).fetchone()
                        if (not force and row and
                                row[0] == sig[0] and row[1] == sig[1] and
                                (row[2] or 0) == (sig[2] or 0) and
                                row[5] == NORMALIZATION_PROFILE_VERSION):
                            stats["skipped_same"] += 1
                            continue
                        # (re)analyze this file
                        try:
                            with open(full, "rb") as fh:
                                raw = fh.read()
                        except OSError:
                            continue
                        rec, _err = analyze_workflow_bytes(raw)
                        mtime_sec = int(st.st_mtime)
                        # v112: the FINAL search text is computed ONCE and used
                        # for BOTH the row and the FTS mirror - a divergence
                        # would leave the token index empty for the row
                        final_search = ((rel + " " + fn + " " + rec["search_text"])
                                        if rec["search_text"] else (rel + " " + fn))
                        with _db_lock:
                            conn.execute(
                                "INSERT OR REPLACE INTO workflow_files "
                                "(user_scope, root_key, rel_path, name, folder,"
                                " size_bytes, mtime_ns, inode, mtime_sec,"
                                " workflow_id, raw_hash, canonical_hash,"
                                " workflow_hash, presentation_hash,"
                                " extension_hash, structural_hash,"
                                " normalization_profile_version, extra_summary,"
                                " node_count, node_types, node_titles,"
                                " model_refs, search_text, parse_status,"
                                " parse_error, indexed_at)"
                                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (user_scope, root_key, key[2], fn,
                                 rel.rsplit("/", 1)[0] if "/" in rel else "",
                                 sig[0], sig[1], sig[2], mtime_sec,
                                 rec["workflow_id"], rec["raw_hash"],
                                 rec["canonical_hash"], rec["workflow_hash"],
                                 rec["presentation_hash"], rec["extension_hash"],
                                 rec["structural_hash"],
                                 NORMALIZATION_PROFILE_VERSION,
                                 json.dumps(rec["extra_summary"], ensure_ascii=False),
                                 rec["node_count"],
                                 json.dumps(rec["node_types"], ensure_ascii=False),
                                 json.dumps(rec["node_titles"], ensure_ascii=False),
                                 json.dumps(rec["model_refs"], ensure_ascii=False),
                                 final_search,
                                 rec["parse_status"],
                                 rec["parse_error"], int(time.time())))
                            if rec["parse_status"] == "error":
                                stats["errors"] += 1
                            elif rec["parse_status"] == "too_large_to_index":
                                stats["too_large"] += 1
                            else:
                                stats["indexed"] += 1
                            stats["changed"] += 1
                            if fts:
                                rowid = conn.execute(
                                    "SELECT rowid FROM workflow_files WHERE "
                                    "user_scope=? AND root_key=? AND rel_path=?",
                                    (user_scope, root_key, key[2])).fetchone()
                                if rowid:
                                    _fts_sync(conn, rowid[0], final_search)
                        if progress and stats["scanned"] % 200 == 0:
                            progress(stats)
                    if stats["truncated"]:
                        break
            # prune the rows whose files vanished (plan 4.4 reconciliation)
            with _db_lock:
                rows = conn.execute(
                    "SELECT rowid, user_scope, root_key, rel_path "
                    "FROM workflow_files WHERE user_scope=?",
                    (user_scope,)).fetchall()
                for rowid, us, rk, rp in rows:
                    if (us, rk, rp) not in seen_keys:
                        conn.execute("DELETE FROM workflow_files WHERE rowid=?",
                                     (rowid,))
                        if fts:
                            conn.execute("DELETE FROM workflow_fts WHERE rowid=?",
                                         (rowid,))
                        stats["removed"] += 1
            conn.commit()
        finally:
            conn.close()
        return stats
    finally:
        _scan_lock.release()


def forget_paths(db=None, user_scope="default", rel_paths=()):
    """v115: drop the index rows of files the Process-delete route removed
    from disk. The reconcile discovery groups the INDEX rows by UUID - a
    stale row of a deleted file would resurrect the erased process with a
    ghost location on the next throttled pass. The next full scan prunes
    vanished rows anyway (reconciliation); this only closes the window
    between the delete and that scan. The FTS mirror rows die with their
    rows (the same contract the scan's prune branch follows). Returns
    {ok, removed} - a busy scan just skips (the safety net above holds)."""
    paths = {p for p in (rel_paths or ()) if isinstance(p, str) and p}
    if not paths:
        return {"ok": True, "removed": 0, "busy": False}
    db = db or _db_path()
    if not os.path.isfile(db):
        return {"ok": True, "removed": 0, "busy": False}
    if not _scan_lock.acquire(blocking=True, timeout=5):
        return {"ok": True, "removed": 0, "busy": True}
    removed = 0
    try:
        with _db_lock:
            conn = _connect(db)
            try:
                fts = _fts_enabled(db)
                for rp in sorted(paths):
                    rows = conn.execute(
                        "SELECT rowid FROM workflow_files "
                        "WHERE user_scope=? AND rel_path=?",
                        (user_scope, rp)).fetchall()
                    for (rowid,) in rows:
                        conn.execute("DELETE FROM workflow_files WHERE rowid=?",
                                     (rowid,))
                        if fts:
                            conn.execute("DELETE FROM workflow_fts WHERE rowid=?",
                                         (rowid,))
                        removed += 1
                conn.commit()
            finally:
                conn.close()
    except sqlite3.DatabaseError:
        return {"ok": False, "removed": 0, "busy": False,
                "error": "index update failed"}
    finally:
        _scan_lock.release()
    return {"ok": True, "removed": removed, "busy": False}


def index_status(db=None, user_scope="default"):
    """The stats for the UI: how many files are indexed, the last scan, the
    profile, whether FTS is live. Cheap - never walks the filesystem."""
    db = db or _db_path()
    out = {"ok": True, "db_exists": os.path.isfile(db), "files": 0,
           "errors": 0, "too_large": 0, "last_scan": 0,
           "profile": NORMALIZATION_PROFILE_VERSION,
           "schema_version": SCHEMA_VERSION, "fts": False,
           "db_bytes": 0}
    if not out["db_exists"]:
        return out
    out["db_bytes"] = os.path.getsize(db)
    try:
        with _db_lock:
            conn = _connect(db)
            try:
                _ensure_schema(conn)
                out["fts"] = _ensure_fts(conn)
                row = conn.execute(
                    "SELECT count(*), sum(parse_status='error'), "
                    "sum(parse_status='too_large_to_index'), "
                    "max(indexed_at) FROM workflow_files "
                    "WHERE user_scope=?", (user_scope,)).fetchone()
                out["files"] = int(row[0] or 0)
                out["errors"] = int(row[1] or 0)
                out["too_large"] = int(row[2] or 0)
                out["last_scan"] = int(row[3] or 0)
                conn.commit()
            finally:
                conn.close()
    except sqlite3.DatabaseError as e:
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    return out


# ---------------------------------------------------------------------------
# Search / listing (plan 4.6: pagination + filters, stable keyset cursor)
# ---------------------------------------------------------------------------

_SORTS = {
    "path": "rel_path",
    "mtime": "mtime_ns",
    "size": "size_bytes",
    "name": "name",
    "node_count": "node_count",
}


def search_index(db=None, user_scope="default", q=None, workflow_id=None,
                 folder=None, sort="mtime", direction="desc", limit=200,
                 cursor=None, favorites=None, size_min=None, size_max=None,
                 mtime_from=None, mtime_to=None):
    """Paginated query over the index. The cursor is the last row's sort key
    + rel_path (keyset pagination - stable, no OFFSET drift). Returns a dict
    ready for the route layer. favorites: an optional iterable of canonical
    rel paths (the star filter applies against the index rows)."""
    db = db or _db_path()
    limit = max(1, min(int(limit or 200), 1000))
    sort_col = _SORTS.get(sort, "mtime_ns")
    if direction not in ("asc", "desc"):
        direction = "desc"
    cmp_op = ">" if direction == "asc" else "<"

    # base filters (shared by the rows query AND the total count)
    base_where = ["user_scope = ?"]
    base_args = [user_scope]
    if workflow_id:
        base_where.append("workflow_id = ?")
        base_args.append(workflow_id)
    if folder:
        base_where.append("(folder = ? OR rel_path LIKE ?)")
        base_args.extend([folder, folder + "/%"])
    if favorites is not None:
        favs = list(favorites)
        if not favs:
            return {"files": [], "total": 0, "has_more": False,
                    "next_cursor": None, "fts": _fts_flag(db)}
        marks = ",".join("?" for _ in favs[:1000])
        base_where.append("rel_path IN (%s)" % marks)
        base_args.extend(favs[:1000])
    # the numeric range filters (the Files tab advanced row) - server-side,
    # so a filter can never apply to just the first fetched page (plan 4.6)
    if size_min is not None:
        try:
            base_where.append("size_bytes >= ?")
            base_args.append(int(size_min))
        except (TypeError, ValueError):
            pass
    if size_max is not None:
        try:
            base_where.append("size_bytes <= ?")
            base_args.append(int(size_max))
        except (TypeError, ValueError):
            pass
    if mtime_from is not None:
        try:
            base_where.append("mtime_sec >= ?")
            base_args.append(int(mtime_from))
        except (TypeError, ValueError):
            pass
    if mtime_to is not None:
        try:
            base_where.append("mtime_sec <= ?")
            base_args.append(int(mtime_to))
        except (TypeError, ValueError):
            pass
    q = str(q).strip() if q else ""
    fts_flag = False
    if q:
        with _db_lock:
            init_db(db)
            conn = _connect(db)
            try:
                # the probe may CREATE + REBUILD the FTS mirror - persist it,
                # otherwise the close rolls the rebuild back and every query
                # answers "no such table" forever (the fallback self-heal)
                fts_flag = _ensure_fts(conn)
                conn.commit()
            except sqlite3.DatabaseError:
                fts_flag = False
            finally:
                conn.close()
        if fts_flag:
            fts_q = " ".join('\"%s\"*' % t.replace('"', "") for t in q.split()[:8])
            base_where.append("rowid IN (SELECT rowid FROM workflow_fts "
                              "WHERE workflow_fts MATCH ?)")
            base_args.append(fts_q)
        else:
            conds = []
            for tok in q.split()[:8]:
                tok_like = "%" + tok.replace("%", "").replace("_", " ") + "%"
                conds.append("(search_text LIKE ? OR rel_path LIKE ? "
                             "OR workflow_id LIKE ?)")
                base_args.extend([tok_like, tok_like, tok_like])
            base_where.append("(" + " AND ".join(conds) + ")")

    # the keyset cursor clause (rows only, never the total count)
    cursor_where = ""
    cursor_args = []
    if cursor:
        cur_parts = str(cursor).split("|", 1)
        if len(cur_parts) == 2:
            if sort_col == "rel_path":
                cursor_where = "(rel_path %s ?)" % cmp_op
                cursor_args.append(cur_parts[1])
            elif sort_col in ("mtime_ns", "size_bytes", "node_count"):
                try:
                    val = int(cur_parts[0])
                except ValueError:
                    val = 0
                cursor_where = "(%s %s ? OR (%s = ? AND rel_path %s ?))" % (
                    sort_col, cmp_op, sort_col, cmp_op)
                cursor_args.extend([val, val, cur_parts[1]])
            else:  # name
                cursor_where = "(name %s ? OR (name = ? AND rel_path %s ?))" % (
                    cmp_op, cmp_op)
                cursor_args.extend([cur_parts[0], cur_parts[0], cur_parts[1]])
    where_sql = " AND ".join(base_where + ([cursor_where] if cursor_where else []))
    order = "%s %s, rel_path %s" % (sort_col, direction.upper(), direction.upper())
    sql = ("SELECT rel_path, name, folder, size_bytes, mtime_sec, mtime_ns,"
           " workflow_id, raw_hash, canonical_hash, workflow_hash,"
           " presentation_hash, extension_hash, structural_hash,"
           " node_count, node_types, model_refs, parse_status, parse_error,"
           " indexed_at FROM workflow_files WHERE " + where_sql +
           " ORDER BY " + order + " LIMIT ?")
    count_sql = ("SELECT count(*) FROM workflow_files WHERE " +
                 " AND ".join(base_where))
    try:
        with _db_lock:
            init_db(db)
            conn = _connect(db)
            try:
                rows = conn.execute(sql, base_args + cursor_args + [limit + 1]).fetchall()
                trow = conn.execute(count_sql, base_args).fetchone()
            finally:
                conn.close()
    except sqlite3.DatabaseError as e:
        return {"files": [], "total": 0, "has_more": False,
                "next_cursor": None, "error": str(e)[:MAX_ERROR_CHARS]}
    has_more = len(rows) > limit
    rows = rows[:limit]
    files = []
    for (rel_path, name, folder_, size_bytes, mtime_sec, mtime_ns,
         workflow_id_, raw_hash, canonical_hash, workflow_hash,
         presentation_hash, extension_hash, structural_hash, node_count,
         node_types, model_refs, parse_status, parse_error, indexed_at) in rows:
        files.append({
            "path": rel_path, "name": name, "folder": folder_,
            "size": int(size_bytes or 0), "mtime": int(mtime_sec or 0),
            "workflowId": workflow_id_, "rawHash": raw_hash,
            "canonicalHash": canonical_hash, "workflowHash": workflow_hash,
            "presentationHash": presentation_hash,
            "extensionHash": extension_hash,
            "structuralHash": structural_hash,
            "nodeCount": int(node_count or 0),
            "nodeTypes": json.loads(node_types) if node_types else [],
            "modelRefs": json.loads(model_refs) if model_refs else [],
            "parseStatus": parse_status,
            "parseError": parse_error,
        })
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        col_idx = {"rel_path": 0, "name": 1, "size_bytes": 3, "mtime_ns": 5,
                   "node_count": 13}[sort_col]
        keyval = last[col_idx]
        if sort_col == "mtime_ns":
            keyval = int(keyval or 0)
        next_cursor = "%s|%s" % (keyval, last[0])
    return {"files": files, "total": int(trow[0] or 0),
            "has_more": has_more, "next_cursor": next_cursor,
            "fts": fts_flag or _fts_flag(db)}


# ---------------------------------------------------------------------------
# v112 stage 5 (plan 11): the WORKFLOW INSPECTOR extraction - ONLY what the
# schema carries, never a guess. The sampler/resolution params extract from
# the CONFIRMED node shapes (KSampler-family / EmptyLatentImage widget
# layouts); anything else reports Unknown / Not detected.
# ---------------------------------------------------------------------------

_KSAMPLER_WIDGETS = ["seed", "control", "steps", "cfg", "sampler", "scheduler", "denoise"]


def extract_params(nodes):
    """The generation parameters when they extract UNAMBIGUOUSLY from the
    known node shapes: steps/cfg/sampler/scheduler from KSampler*, the
    resolution from EmptyLatentImage/EmptySD3LatentImage. Every unknown
    stays 'None' (the UI shows 'Not detected' - plan 11)."""
    out = {"steps": None, "cfg": None, "sampler": None, "scheduler": None,
           "denoise": None, "width": None, "height": None}
    if not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict):
            continue
        t = str(n.get("type") or "")
        wv = n.get("widgets_values")
        if not isinstance(wv, list):
            continue
        nums = [v for v in wv if isinstance(v, (int, float))]
        strs = [v for v in wv if isinstance(v, str)]
        if t.startswith("KSampler") or t in ("SamplerCustom", "SamplerCustomAdvanced"):
            # KSampler: [seed, control_after_generate, steps, cfg, sampler,
            # scheduler, denoise] - the numeric pairs carry steps/cfg/denoise
            if t.startswith("KSampler") and len(nums) >= 3:
                if out["steps"] is None and isinstance(nums[1], (int, float)):
                    out["steps"] = nums[1]
                if out["cfg"] is None and isinstance(nums[2], (int, float)):
                    out["cfg"] = nums[2]
            for v in strs:
                if out["sampler"] is None and v in (
                        "euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral",
                        "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral",
                        "dpmpp_sde", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde",
                        "ddim", "uni_pc", "uni_pc_bh2", "lcm", "ddpm", "deis",
                        "res_multistep", "gradient_estimation", "er_sde", "seeds_2",
                        "seeds_3"):
                    out["sampler"] = v
                elif out["scheduler"] is None and v in (
                        "normal", "karras", "exponential", "sgm_uniform", "simple",
                        "ddim_uniform", "beta", "linear_quadratic", "kl_optimal"):
                    out["scheduler"] = v
        if t in ("EmptyLatentImage", "EmptySD3LatentImage") and len(nums) >= 2:
            if out["width"] is None:
                out["width"] = nums[0]
                out["height"] = nums[1]
    return out


def inspect_payload(raw):
    """The FULL inspector record for ONE workflow (bytes -> the honest
    report): the identity, the structure, the models, the parameters when
    extractable, and the duplicate/similarity counts. No guessing."""
    rec, _err = analyze_workflow_bytes(raw)
    payload = {
        "workflowId": rec["workflow_id"],
        "nodeCount": rec["node_count"],
        "nodeTypes": rec["node_types"] or [],
        "models": rec["model_refs"] or [],
        "parseStatus": rec["parse_status"],
        "parseError": rec["parse_error"],
        "hashes": {k: rec[k] for k in ("raw_hash", "canonical_hash",
                                       "workflow_hash", "presentation_hash",
                                       "extension_hash", "structural_hash")},
        "params": extract_params(
            json.loads(raw.decode("utf-8")).get("nodes")
            if rec["parse_status"] == "ok" and isinstance(
                _safe_json(raw), dict) else None),
    }
    return payload


def _safe_json(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def dependency_report(node_types, models, registry=None, model_lookup=None):
    """The DEPENDENCY CHECK (plan 11): unknown node classes vs the installed
    registry (feature-detected - the caller passes what exists), the model
    files vs the models folders. Statuses: missing/available/unknown. NEVER
    blocks an open - diagnostics only."""
    known = set(registry or {})
    unknown = [t for t in (node_types or []) if t not in known]
    missing_models, checked = [], []
    for m in (models or []):
        if model_lookup and m in model_lookup:
            checked.append({"name": m, "status": "available"
                            if model_lookup[m] else "missing"})
            if not model_lookup[m]:
                missing_models.append(m)
        else:
            checked.append({"name": m, "status": "unknown"})
    return {
        "knownNodes": sorted(t for t in (node_types or []) if t in known),
        "unknownNodes": sorted(set(unknown)),
        "models": checked,
        "missingModels": missing_models,
    }


def duplicate_groups(db=None, user_scope="default"):
    """The plan 5.3 duplicate/similarity views: exact copies (rawHash), same
    JSON content (canonicalHash), same workflow/different canvas (workflowHash
    + extensionHash, presentationHash differs), same UUID/different content,
    no-UUID files. Cheap GROUP BYs - the scan does the heavy lifting."""
    db = db or _db_path()
    out = {"ok": True}
    try:
        with _db_lock:
            init_db(db)
            conn = _connect(db)
            try:
                def groups(col, having="count(*) > 1"):
                    return [r[0] for r in conn.execute(
                        "SELECT %s FROM workflow_files WHERE user_scope=? AND "
                        "%s IS NOT NULL GROUP BY %s HAVING %s LIMIT 200"
                        % (col, col, col, having), (user_scope,)).fetchall()]
                exact = groups("raw_hash")
                same_json = [h for h in groups("canonical_hash") if h not in exact]
                wf_groups = groups("workflow_hash")
                same_wf_diff_canvas = []
                for h in wf_groups:
                    rows = conn.execute(
                        "SELECT count(DISTINCT presentation_hash) FROM "
                        "workflow_files WHERE user_scope=? AND workflow_hash=?",
                        (user_scope, h)).fetchone()
                    if rows and rows[0] > 1:
                        same_wf_diff_canvas.append(h)
                same_id_diff_content = [r[0] for r in conn.execute(
                    "SELECT workflow_id FROM workflow_files WHERE user_scope=? "
                    "AND workflow_id IS NOT NULL GROUP BY workflow_id "
                    "HAVING count(DISTINCT workflow_hash) > 1 LIMIT 200",
                    (user_scope,)).fetchall()]
                no_uuid = conn.execute(
                    "SELECT count(*) FROM workflow_files WHERE user_scope=? "
                    "AND workflow_id IS NULL", (user_scope,)).fetchone()[0]
                out.update({
                    "exactCopies": exact,
                    "sameJsonContent": same_json,
                    "sameWorkflowDiffCanvas": same_wf_diff_canvas,
                    "sameUuidDiffContent": same_id_diff_content,
                    "noUuidCount": int(no_uuid or 0),
                })
            finally:
                conn.close()
    except sqlite3.DatabaseError as e:
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    return out
