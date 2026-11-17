"""tests/py_test_workflows_index.py - v112 stage 2 (plan 4.x): the derived
SQLite index of the workflow library.

Runs WITHOUT ComfyUI: py/workflows_index.py is imported by file path and the
DB path is injected into a temp dir. Covers the plan's mandatory scenarios:

  * DB init + schema version; FTS5 availability + the LIKE fallback
  * incremental scan: a second scan is a NO-OP (stat signature skip)
  * changed file re-index (mtime_ns changes -> the hashes refresh)
  * deleted file pruning; new file insert
  * corrupt JSON -> parse_status=error, the file stays listable
  * oversized JSON -> too_large_to_index, still listable
  * DB corruption -> quarantine + rebuild, no workflow file touched
  * multi-user isolation (user_scope rows never mix)
  * storage internals (settings_hub namespace) excluded from the scan
  * UUID extraction / missing / invalid
  * rawHash/canonicalHash stability; canonical ignores formatting only
  * workflowHash ignores ONLY the confirmed viewport/environment fields
    (extra.ds.scale/offset, extra.frontendVersion); changing an unclassified
    VHS_* field CHANGES workflowHash and extensionHash (never stripped)
  * node layout-only changes (pos/size) leave workflowHash untouched and
    move presentationHash
  * the normalization profile version is recorded per row
  * keyset cursor pagination: stable, no dup/missing rows across pages
  * duplicate groups (exact copies / same JSON / same workflow different
    canvas / same UUID different content / no-UUID count)

Run: python3 tests/py_test_workflows_index.py   (exit 0 = all good)
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import importlib.util

spec = importlib.util.spec_from_file_location(
    "shub_workflows_index", os.path.join(ROOT, "py", "workflows_index.py"))
widx = importlib.util.module_from_spec(spec)
sys.modules["shub_workflows_index"] = widx
spec.loader.exec_module(widx)

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append("%s :: %s" % (name, detail))
        print("  x %s :: %s" % (name, detail))


TMP = tempfile.mkdtemp(prefix="shub-wf-idx-")
DB = os.path.join(TMP, "settings_hub", "workflows_manager", "index",
                  "workflow_index.db")
widx.set_db_path(DB)
LIB = os.path.join(TMP, "userlib", "workflows")  # a fake workflows/ root
os.makedirs(LIB, exist_ok=True)


def wf_json(uid="11111111-2222-3333-4444-555555555555", nodes=None, extra=None,
            version=0.4):
    return {
        "id": uid,
        "revision": 1,
        "nodes": nodes if nodes is not None else [
            {"id": 1, "type": "KSampler", "pos": [10, 20], "size": [100, 60],
             "title": "Sampler", "widgets_values": ["seed"]},
            {"id": 2, "type": "CheckpointLoaderSimple", "pos": [50, 60],
             "size": [100, 60], "widgets_values": ["v1-5-pruned-emaonly.ckpt"]},
            {"id": 3, "type": "SaveImage", "pos": [90, 90]},
        ],
        "links": [],
        "extra": extra if extra is not None else {
            "ds": {"scale": 1.0, "offset": [0, 0]},
            "frontendVersion": "1.24.4",
            "VHS_MetadataImage": True,
        },
        "version": version,
    }


def write_lib(rel, obj_or_bytes):
    p = os.path.join(LIB, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        if isinstance(obj_or_bytes, bytes):
            f.write(obj_or_bytes)
        else:
            f.write(json.dumps(obj_or_bytes, ensure_ascii=False).encode("utf-8"))
    return p


def scan(scope="default", force=False):
    return widx.scan_index(
        workflows_user_dirs=[LIB], hide_dirs_fn=lambda d: [],
        user_scope=scope, force=force)


def q(**kw):
    return widx.search_index(user_scope=kw.pop("scope", "default"), **kw)


def row_of(rel, scope="default"):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute(
            "SELECT workflow_id, raw_hash, canonical_hash, workflow_hash,"
            " presentation_hash, extension_hash, structural_hash,"
            " parse_status, normalization_profile_version, node_count,"
            " node_types FROM workflow_files WHERE user_scope=? AND rel_path=?",
            (scope, rel)).fetchone()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
print("== v112 stage 2: the derived SQLite index ==")

# 1) init + FTS probe
db_path, fts = widx.init_db(DB)
check("init: the DB file is created at the injected path", os.path.isfile(DB))
check("init: FTS5 availability detected (CPython builds ship it)",
      isinstance(fts, bool), str(fts))
conn = sqlite3.connect(DB)
sv = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
prof = conn.execute("SELECT value FROM meta WHERE key='normalization_profile_version'").fetchone()
conn.close()
check("init: the schema + profile versions are recorded",
      sv and sv[0] == widx.SCHEMA_VERSION and prof and
      prof[0] == widx.NORMALIZATION_PROFILE_VERSION)

# 2) the first scan indexes everything
write_lib("a.json", wf_json())
write_lib("sub/b.json", wf_json(uid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
st = scan()
check("scan: two files indexed, none removed",
      st["indexed"] == 2 and st["removed"] == 0 and st["errors"] == 0,
      json.dumps(st))
check("scan: the profile rides along",
      st["profile"] == widx.NORMALIZATION_PROFILE_VERSION)

row_a = row_of("workflows/a.json")
check("scan: the top-level id lands as workflow_id",
      row_a[0] == "11111111-2222-3333-4444-555555555555")
check("scan: raw + canonical + workflow hashes exist",
      all(row_a[1:6]), json.dumps(row_a[:6]))
check("scan: node count + types extracted",
      row_a[9] == 3 and "KSampler" in row_a[10], json.dumps(row_a[9:11]))
check("scan: the profile version is per-row",
      row_a[8] == widx.NORMALIZATION_PROFILE_VERSION)

# 3) the second scan is a NO-OP (the stat signature skip - plan 4.4 #1)
st2 = scan()
check("scan: the second pass SKIPS unchanged files (no re-parse)",
      st2["skipped_same"] == 2 and st2["indexed"] == 0 and st2["changed"] == 0,
      json.dumps(st2))

# 4) a changed file re-indexes
time.sleep(0.02)
write_lib("a.json", wf_json(nodes=[
    {"id": 1, "type": "KSampler", "pos": [10, 20], "size": [100, 60],
     "title": "Sampler", "widgets_values": ["seed2", "changed"]},
    {"id": 2, "type": "CheckpointLoaderSimple", "pos": [50, 60]},
    {"id": 3, "type": "SaveImage", "pos": [90, 90]},
]))
st3 = scan()
check("scan: a changed file re-indexes (others skip)",
      st3["indexed"] == 1 and st3["skipped_same"] == 1 and st3["changed"] == 1,
      json.dumps(st3))
row_a2 = row_of("workflows/a.json")
check("scan: the workflow hash CHANGED after a widget edit",
      row_a2[3] != row_a[3])
check("scan: raw hash changed too", row_a2[1] != row_a[1])

# 5) presentation-only changes (pos/size) do NOT move workflow_hash (plan 2.2)
time.sleep(0.02)
write_lib("a.json", wf_json(nodes=[
    {"id": 1, "type": "KSampler", "pos": [777, 555], "size": [300, 200],
     "title": "Sampler", "widgets_values": ["seed"]},
    {"id": 2, "type": "CheckpointLoaderSimple", "pos": [50, 60],
     "widgets_values": ["v1-5-pruned-emaonly.ckpt"]},
    {"id": 3, "type": "SaveImage", "pos": [90, 90]},
]))
scan()
row_a3 = row_of("workflows/a.json")
check("hash: a LAYOUT-ONLY change keeps workflow_hash identical",
      row_a3[3] == row_a[3],
      "old=%s new=%s" % (row_a[3], row_a3[3]))
check("hash: the presentation hash moved instead",
      row_a3[4] != row_a[4])

# 6) viewport/env-only changes: ds.scale/offset + frontendVersion (plan 2.2)
time.sleep(0.02)
write_lib("a.json", wf_json(extra={
    "ds": {"scale": 0.5, "offset": [120, -30]},
    "frontendVersion": "1.30.0",
    "VHS_MetadataImage": True,
}))
scan()
row_a4 = row_of("workflows/a.json")
check("hash: ds.scale/offset + frontendVersion alone do NOT move workflow_hash",
      row_a4[3] == row_a[3], "wf old=%s new=%s" % (row_a[3], row_a4[3]))
check("hash: the presentation hash moved (ds is presentation)",
      row_a4[4] != row_a[4])
check("hash: the canonical hash moved (canonical keeps EVERYTHING)",
      row_a4[2] != row_a[2])

# 7) an UNCLASSIFIED extension field moving = a real graph difference
time.sleep(0.02)
write_lib("a.json", wf_json(extra={
    "ds": {"scale": 1.0, "offset": [0, 0]},
    "frontendVersion": "1.24.4",
    "VHS_MetadataImage": False,
}))
scan()
row_a5 = row_of("workflows/a.json")
check("hash: an unclassified extra field change MOVES workflow_hash",
      row_a5[3] != row_a[3])
check("hash: the extension hash moved too (never silently stripped)",
      row_a5[5] != row_a[5])

# 8) uuid-less / invalid formats
write_lib("noid.json", {"nodes": [], "extra": {}})
write_lib("badid.json", {"id": 12345, "nodes": []})
scan()
row_noid = row_of("workflows/noid.json")
row_badid = row_of("workflows/badid.json")
check("uuid: a missing id -> workflow_id NULL (never auto-bound)",
      row_noid[0] is None)
check("uuid: a non-string id -> workflow_id NULL",
      row_badid[0] is None)

# 9) corrupt JSON stays listable with parse_status=error
write_lib("broken.json", b"{ this is not json ,,")
st4 = scan()
check("corrupt: the scan does not die (1 error, the rest skipped)",
      st4["errors"] == 1 and st4["skipped_same"] == 4 and st4["indexed"] == 0,
      json.dumps(st4))
r = q(q="broken")
check("corrupt: the broken file is SEARCHABLE (parseStatus=error)",
      any(f["path"] == "workflows/broken.json" for f in r["files"]) and
      any(f["parseStatus"] == "error" for f in r["files"]),
      json.dumps(r["files"])[:200])
# fix it back
write_lib("broken.json", wf_json(uid="99999999-8888-7777-6666-555555555555"))
scan()
row_fixed = row_of("workflows/broken.json")
check("corrupt: a repaired file re-indexes to parse_status=ok",
      row_fixed[7] == "ok", row_fixed[7])

# 10) oversized JSON -> too_large_to_index (still listable)
big = {"id": "abababab-abab-abab-abab-abababababab",
       "nodes": [], "pad": ["x" * 10000] * 1200}  # ~12MB raw
write_lib("huge.json", json.dumps(big).encode())
st5 = scan()
row_huge = row_of("workflows/huge.json")
check("oversize: too_large_to_index and still listed",
      row_huge[7] == "too_large_to_index", row_huge[7])
r = q(q="huge")
check("oversize: the too-large file still shows in search",
      any(f["path"] == "workflows/huge.json" for f in r["files"]))
os.unlink(os.path.join(LIB, "huge.json"))

# 11) deleted file pruning
os.unlink(os.path.join(LIB, "noid.json"))
st6 = scan()
check("prune: deleted files leave the index (noid + the removed huge)",
      st6["removed"] == 2, json.dumps(st6))
check("prune: the row is gone", row_of("workflows/noid.json") is None)

# 12) search: name, path, UUID, node type, model ref, content
r = q(q="flux")  # no match
check("search: no match -> empty but ok", r["ok"] if "ok" in r else True and r["files"] == [])
r = q(q="KSampler")
check("search: a NODE TYPE matches",
      any(f["path"] == "workflows/a.json" for f in r["files"]),
      json.dumps(r["files"])[:160])
r = q(q="11111111")
check("search: a UUID prefix matches",
      any(f["path"] == "workflows/a.json" for f in r["files"]))
r = q(q="v1-5-pruned")
check("search: a MODEL REF matches",
      any(f["path"] == "workflows/a.json" for f in r["files"]))
r = q(q="sub")
check("search: a PATH segment matches",
      any(f["path"] == "workflows/sub/b.json" for f in r["files"]))
r = q(workflow_id="11111111-2222-3333-4444-555555555555")
check("search: the workflow_id filter is exact",
      len(r["files"]) == 1 and r["files"][0]["path"] == "workflows/a.json",
      json.dumps(r["files"])[:160])

# 13) the LIKE fallback works when FTS is unavailable (plan 4.3)
try:
    conn = sqlite3.connect(DB)
    conn.execute("DROP TABLE workflow_fts")
    conn.commit()
    conn.close()
    fts_gone = True
except sqlite3.DatabaseError:
    fts_gone = False
check("fallback: the FTS mirror dropped", fts_gone)
r = q(q="KSampler")
check("fallback: the LIKE path answers the same query",
      any(f["path"] == "workflows/a.json" for f in r["files"]),
      json.dumps(r["files"])[:160])

# 14) keyset cursor pagination: stable, no dup/missing (plan 4.6 #7)
for i in range(25):
    write_lib("page/p%02d.json" % i, wf_json(uid="%032d" % i))
scan()
all_paths = []
cur = None
pages = 0
while True:
    r = q(sort="path", direction="asc", limit=5, cursor=cur)
    pages += 1
    all_paths.extend(f["path"] for f in r["files"])
    if not r["has_more"]:
        break
    cur = r["next_cursor"]
    if pages > 40:
        break
check("pagination: every row reached exactly once (no dup/missing)",
      len(all_paths) == len(set(all_paths)) and len(all_paths) >= 28,
      "rows=%d uniq=%d pages=%d" % (len(all_paths), len(set(all_paths)), pages))
check("pagination: the paths arrive sorted",
      all_paths == sorted(all_paths))
r1 = q(sort="mtime", direction="desc", limit=3)
check("pagination: mtime cursor pages forward without repeats",
      r1["has_more"] and r1["next_cursor"],
      json.dumps({"nc": r1["next_cursor"], "hm": r1["has_more"]}))

# 15) duplicate groups (plan 5.3 views)
with open(os.path.join(LIB, "a.json"), "rb") as _f:
    _a_bytes = _f.read()
write_lib("copy_of_a.json", _a_bytes)  # byte-identical to the CURRENT a.json
scan()
d = widx.duplicate_groups()
check("dup: the byte-identical copy is an EXACT COPY group",
      len(d["exactCopies"]) >= 1, json.dumps(d)[:200])
d = widx.duplicate_groups()
time.sleep(0.02)
write_lib("samejson.json",
          json.dumps(wf_json(), indent=2, sort_keys=True).encode())  # same content, new formatting
scan()
d = widx.duplicate_groups()
check("dup: re-formatted JSON lands in the same-JSON-content group",
      len(d["sameJsonContent"]) >= 1, json.dumps(d)[:240])
check("dup: same UUID + different content counted",
      len(d["sameUuidDiffContent"]) >= 1, json.dumps(d)[:240])
check("dup: the no-UUID counter is exact (badid.json only)",
      d["noUuidCount"] == 1, str(d["noUuidCount"]))

# 16) multi-user isolation (plan 4.2)
scan(scope="alice")
conn = sqlite3.connect(DB)
alice_rows = conn.execute(
    "SELECT count(*) FROM workflow_files WHERE user_scope='alice'").fetchone()[0]
default_rows = conn.execute(
    "SELECT count(*) FROM workflow_files WHERE user_scope='default'").fetchone()[0]
conn.close()
check("isolation: alice's scan indexes under her scope",
      alice_rows == default_rows and alice_rows > 0,
      "alice=%d default=%d" % (alice_rows, default_rows))
r = q(scope="alice", q="KSampler")
check("isolation: alice's search sees her rows", len(r["files"]) > 0)

# 17) DB corruption recovery (plan 4.4 #6): the workflow files untouched
before = {}
for rel in ("a.json", "sub/b.json"):
    p = os.path.join(LIB, rel)
    with open(p, "rb") as f:
        before[rel] = f.read()
# corrupt the DB file
conn = sqlite3.connect(DB)
conn.close()
with open(DB, "r+b") as f:
    f.seek(100)
    f.write(b"\xde\xad\xbe\xef" * 64)
db_path2, fts2 = widx.init_db(DB)
check("recovery: the corrupt DB was quarantined (a .corrupt- file exists)",
      any(n.startswith("workflow_index.db.corrupt-")
          for n in os.listdir(os.path.dirname(DB))),
      json.dumps(os.listdir(os.path.dirname(DB))))
st7 = scan(force=True)
check("recovery: the index rebuilt from the filesystem",
      st7["indexed"] >= 28, json.dumps(st7))
after = {}
for rel in ("a.json", "sub/b.json"):
    p = os.path.join(LIB, rel)
    with open(p, "rb") as f:
        after[rel] = f.read()
check("recovery: the WORKFLOW FILES are byte-identical (untouched)",
      before == after)

# 18) the storage internals never enter the scan (plan 4.2/plan rule)
storage_root = os.path.join(LIB, "settings_hub", "workflows")
os.makedirs(os.path.join(storage_root, "presets"), exist_ok=True)
os.makedirs(os.path.join(storage_root, "temp"), exist_ok=True)
write_lib("settings_hub/workflows/presets/xx.json", {"id": "xx"})
write_lib("settings_hub/workflows/temp/yy.json", {"id": "yy"})
st8 = scan(force=True)
check("exclusions: presets/temp housekeeping never indexed",
      row_of("workflows/settings_hub/workflows/presets/xx.json") is None and
      row_of("workflows/settings_hub/workflows/temp/yy.json") is None,
      json.dumps(st8))

# ---------------------------------------------------------------------------
# v112 stage 5 (plan 11): the INSPECTOR extraction + the DEPENDENCY report
# ---------------------------------------------------------------------------
print("== v112 stage 5: inspector extraction + dependency report ==")

wf_ins = {
    "id": "cccccccc-1111-2222-3333-444444444444",
    "nodes": [
        {"id": 1, "type": "KSampler", "pos": [1, 1],
         "widgets_values": [123, "fixed", 25, 7.5, "euler", "karras", 1.0]},
        {"id": 2, "type": "CheckpointLoaderSimple", "pos": [2, 2],
         "widgets_values": ["v1-5-pruned-emaonly.ckpt"]},
        {"id": 3, "type": "EmptyLatentImage", "pos": [3, 3],
         "widgets_values": [1024, 768, 1]},
        {"id": 4, "type": "LoraLoader", "pos": [4, 4],
         "widgets_values": ["my_lora.safetensors", 1.0, 1.0]},
        {"id": 5, "type": "SaveImage", "pos": [5, 5]},
    ],
    "extra": {},
}
payload = widx.inspect_payload(json.dumps(wf_ins, ensure_ascii=False).encode("utf-8"))
check("inspect: the workflow id extracts",
      payload["workflowId"] == "cccccccc-1111-2222-3333-444444444444")
check("inspect: the node count/types extract",
      payload["nodeCount"] == 5 and "KSampler" in payload["nodeTypes"])
check("inspect: the models extract from the confirmed keys",
      "v1-5-pruned-emaonly.ckpt" in payload["models"] and
      "my_lora.safetensors" in payload["models"],
      json.dumps(payload["models"]))
check("inspect: the KSampler parameters extract (steps/cfg/sampler/scheduler)",
      payload["params"]["steps"] == 25 and payload["params"]["cfg"] == 7.5 and
      payload["params"]["sampler"] == "euler" and payload["params"]["scheduler"] == "karras",
      json.dumps(payload["params"]))
check("inspect: the resolution extracts from EmptyLatentImage",
      payload["params"]["width"] == 1024 and payload["params"]["height"] == 768)
check("inspect: the hashes block carries the layered fingerprints",
      all(payload["hashes"][k] for k in ("raw_hash", "canonical_hash", "workflow_hash")),
      json.dumps(payload["hashes"])[:120])

# an exotic sampler value stays NOT detected (no guessing - plan 11)
wf_exotic = {"id": "dd", "nodes": [
    {"id": 1, "type": "WeirdSamplerNode", "pos": [1, 1],
     "widgets_values": ["mystery_sampler"]}]}
p2 = widx.inspect_payload(json.dumps(wf_exotic).encode())
check("inspect: an unknown sampler shape stays Not detected",
      p2["params"]["sampler"] is None and p2["params"]["steps"] is None,
      json.dumps(p2["params"]))

# the dependency report: unknown nodes + missing models (a fake registry)
dep = widx.dependency_report(
    ["KSampler", "SaveImage", "SuperUnknownNode"],
    ["v1-5-pruned-emaonly.ckpt", "gone_model.safetensors", "mystery.bin"],
    registry={"KSampler", "SaveImage", "CheckpointLoaderSimple", "LoraLoader"},
    model_lookup={"v1-5-pruned-emaonly.ckpt": True,
                  "gone_model.safetensors": False})
check("deps: the unknown node class is reported (not guessed)",
      dep["unknownNodes"] == ["SuperUnknownNode"], json.dumps(dep["unknownNodes"]))
check("deps: the known node classes list",
      set(dep["knownNodes"]) == {"KSampler", "SaveImage"},
      json.dumps(dep["knownNodes"]))
check("deps: the model statuses available/missing/unknown",
      [m["status"] for m in dep["models"]] == ["available", "missing", "unknown"],
      json.dumps(dep["models"]))
check("deps: the missing models list",
      dep["missingModels"] == ["gone_model.safetensors"])
# a missing registry -> every node stays unknown (never a false 'missing')
dep2 = widx.dependency_report(["KSampler"], [], registry=None, model_lookup={})
check("deps: an absent registry keeps the nodes unknown (no false alarms)",
      dep2["unknownNodes"] == ["KSampler"] and dep2["knownNodes"] == [])
# ---------------------------------------------------------------------------
# v116 (plan 3.1): the TRUNCATED scan never prunes - a walk that hit the
# bound cannot delete the rows it did not verify.
import sqlite3 as _sq3

_big = os.path.join(TMP, "biglib", "workflows")
os.makedirs(_big, exist_ok=True)
for i in range(40):
    with open(os.path.join(_big, "f%02d.json" % i), "wb") as _f:
        _f.write(json.dumps(wf_json(uid="%08x-0000-4000-8000-%012x" % (i, i)))
                 .encode("utf-8"))
_dbp_big = os.path.join(TMP, "bigidx", "workflow_index.db")
widx.set_db_path(_dbp_big)
# the FIRST scan is complete (no bound): all 40 rows land in the index
st0 = widx.scan_index(workflows_user_dirs=[_big], hide_dirs_fn=lambda d: [],
                      user_scope="default", force=True)
check("trunc: the unbounded first pass is complete with 40 rows",
      st0.get("complete") is True and
      widx.index_status(user_scope="default").get("files") == 40,
      json.dumps({"complete": st0.get("complete"),
                  "files": widx.index_status(user_scope="default").get("files")}))
# NOW the walk bound kicks in; files 30-39 vanish from disk right before
os.environ["SHUB_WF_MAX_WALK"] = "10"
for i in range(30, 40):
    os.unlink(os.path.join(_big, "f%02d.json" % i))
st1 = widx.scan_index(workflows_user_dirs=[_big], hide_dirs_fn=lambda d: [],
                      user_scope="default", force=True)
check("trunc: the walk bound marks the pass truncated",
      st1.get("truncated") is True and st1.get("complete") is False and
      st1.get("prune_skipped") is True,
      json.dumps({k: st1.get(k) for k in ("truncated", "complete",
                                          "prune_skipped", "scanned")}))
_n_after = widx.index_status(user_scope="default")
check("trunc: the unverified rows SURVIVE a truncated re-scan",
      _n_after.get("files") == 40,
      json.dumps({"files": _n_after.get("files")}))
check("trunc: the status reports the incomplete index honestly",
      _n_after.get("complete") is False and _n_after.get("truncated") is True and
      _n_after.get("lastScanComplete") is False,
      json.dumps({k: _n_after.get(k) for k in ("complete", "truncated",
                                               "lastScanComplete")}))
os.environ.pop("SHUB_WF_MAX_WALK")
st3 = widx.scan_index(workflows_user_dirs=[_big], hide_dirs_fn=lambda d: [],
                      user_scope="default", force=True)
_n_full = widx.index_status(user_scope="default")
check("trunc: a COMPLETE scan prunes exactly the vanished files",
      st3.get("complete") is True and _n_full.get("files") == 30,
      json.dumps({"complete": st3.get("complete"),
                  "files": _n_full.get("files"),
                  "removed": st3.get("removed")}))
check("trunc: FTS stays in sync with the rows after the prune",
      widx.search_index(user_scope="default",
                        q="f39")["total"] == 0 and
      widx.search_index(user_scope="default",
                        q="f29")["total"] == 1,
      json.dumps({"gone": widx.search_index(user_scope="default", q="f39")["total"],
                  "kept": widx.search_index(user_scope="default", q="f29")["total"]}))
# v116: an unreadable DIRECTORY also blocks the prune (os.walk onerror)
_missing_root = os.path.join(TMP, "does-not-exist")
st4 = widx.scan_index(workflows_user_dirs=[_missing_root],
                      hide_dirs_fn=lambda d: [], user_scope="default",
                      force=True)
check("trunc: a walk error (unreadable/missing root) skips the prune too",
      st4.get("walk_errors", 0) >= 1 and st4.get("prune_skipped") is True and
      st4.get("complete") is False,
      json.dumps({k: st4.get(k) for k in ("walk_errors", "prune_skipped",
                                          "complete")}))
# ---------------------------------------------------------------------------
# v116 (plan 4.6): the NOTES index - upsert / search / drop / rebuild.
widx.notes_upsert("process", "procnotes1", "", "Portrait master",
                  "the main portrait workflow")
widx.notes_upsert("revision", "procnotes1", "revnotes1", "First checkpoint",
                  "added the LoRA and bumped steps")
_r = widx.search_notes(q="portrait")
check("notes: a process note is found by FTS",
      _r.get("ok") and any(x["processId"] == "procnotes1" and
                           x["kind"] == "process" for x in _r["results"]),
      json.dumps(_r))
_r2 = widx.search_notes(q="lora")
check("notes: a revision note is found too",
      any(x["revisionId"] == "revnotes1" for x in _r2.get("results", [])),
      json.dumps(_r2))
widx.notes_drop("procnotes1")
_r3 = widx.search_notes(q="portrait")
check("notes: the drop removes both rows",
      not any(x["processId"] == "procnotes1" for x in _r3.get("results", [])),
      json.dumps(_r3))
_n = widx.notes_rebuild(
    [{"processId": "procnotes2", "displayName": "Upscale chain",
      "note": "4x upscale + face restore", "updatedAt": 5}],
    [{"revisionId": "revnotes2", "processId": "procnotes2",
      "title": "Second", "note": "changed the denoise", "createdAt": 6}])
_r4 = widx.search_notes(q="upscale")
_r5 = widx.search_notes(q="denoise")
check("notes: the rebuild restores the notes from the manifests",
      _n >= 1 and any(x["processId"] == "procnotes2" for x in _r4.get("results", []))
      and any(x["revisionId"] == "revnotes2" for x in _r5.get("results", [])),
      json.dumps({"rebuilt": _n, "proc": _r4, "rev": _r5}))

# ---------------------------------------------------------------------------
# v116 (plan 3.2): refresh_paths - the POINT re-index after a Restore.
_one = os.path.join(_big, "f00.json")
with open(_one, "wb") as _f:
    _f.write(json.dumps(wf_json(uid="11111111-0000-4000-8000-00000000000f",
                                extra={"ds": {"scale": 2.0, "offset": [5, 5]},
                                       "frontendVersion": "1.24.4"}))
             .encode("utf-8"))
_rp = widx.refresh_paths(user_scope="default", root_dirs=[_big],
                         rel_paths=["workflows/f00.json"])
_row = _sq3.connect(_dbp_big).execute(
    "SELECT workflow_id, raw_hash FROM workflow_files WHERE "
    "user_scope='default' AND rel_path='workflows/f00.json'").fetchone()
check("refresh_paths: the touched file re-analyzed in place",
      _rp.get("ok") and _rp.get("updated") == 1 and
      _row is not None and
      _row[0] == "11111111-0000-4000-8000-00000000000f",
      json.dumps({"res": _rp, "row": _row}))
os.unlink(_one)
_rp2 = widx.refresh_paths(user_scope="default", root_dirs=[_big],
                          rel_paths=["workflows/f00.json"])
_row2 = _sq3.connect(_dbp_big).execute(
    "SELECT count(*) FROM workflow_files WHERE "
    "user_scope='default' AND rel_path='workflows/f00.json'").fetchone()
check("refresh_paths: a vanished file drops its row",
      _rp2.get("ok") and _rp2.get("removed") == 1 and _row2[0] == 0,
      json.dumps({"res": _rp2, "rows": _row2[0]}))
# back to the harness DB (after the refresh_paths block - it uses _db_path)
widx.set_db_path(DB)

# ---------------------------------------------------------------------------
# v116 (plan 9.2): the duplicate groups answer carries the STRUCTURAL
# candidates (same node classes, different workflows - candidates ONLY).
_dg = widx.duplicate_groups(user_scope="default")
check("duplicates: structuralCandidates is part of the answer",
      "structuralCandidates" in _dg and isinstance(_dg.get("structuralCandidates"), list),
      json.dumps(sorted(_dg.keys())))
# ---------------------------------------------------------------------------
# v117 (nprof2): the SIMILARITY SIGNATURES + the groups. The owner's plan:
# presentation never lowers the score, the ComfyUI Duplicate (a new state.id,
# byte-identical everything else) is an exact copy, the volatile widgets
# (seed / control_after_generate) never count, the score is deterministic.
# ---------------------------------------------------------------------------
check("v119: the profile is nprof3 and the schema stays 2",
      widx.NORMALIZATION_PROFILE_VERSION == "nprof3" and
      widx.SCHEMA_VERSION == "2",
      widx.NORMALIZATION_PROFILE_VERSION + "/" + widx.SCHEMA_VERSION)

def wf_v117(uid, seed=1, pos=(0, 0), extra_link=None):
    return {"id": uid, "revision": 7,
            "nodes": [
                {"id": 10, "type": "KSampler", "pos": list(pos),
                 "size": [300, 100], "collapsed": True,
                 "widgets_values": {"seed": 12345, "steps": 20 + seed,
                                    "cfg": 8.0}},
                {"id": 20, "type": "VAEDecode", "pos": [500, 300]},
            ],
            "links": ([[1, 10, 0, 20, 0, "LATENT"]] +
                      ([[2, 20, 0, 99, 0, "IMAGE"]] if extra_link else [])),
            "extra": {"ds": {"scale": 1.0 + seed / 10, "offset": [7, 9]},
                      "frontendVersion": "1.24.4"},
            "version": 0.4}

_r1, _ = widx.analyze_workflow_bytes(json.dumps(wf_v117("id-a")).encode())
# the ComfyUI Duplicate: ONLY the id changes (+ any presentation noise)
_r2, _ = widx.analyze_workflow_bytes(json.dumps(
    wf_v117("id-b", seed=1, pos=(999, 888))).encode())
check("v117 sig: the Duplicate (new id, moved canvas) keeps the SAME graph hash",
      _r2["sig_graph_hash"] == _r1["sig_graph_hash"],
      json.dumps({"a": _r1["sig_graph_hash"], "b": _r2["sig_graph_hash"]}))
check("v117 sig: a different id still changes the OLD workflow_hash",
      _r2["workflow_hash"] != _r1["workflow_hash"])
# a REAL graph change (an extra link) must change the signature
_r3, _ = widx.analyze_workflow_bytes(json.dumps(
    wf_v117("id-c", extra_link=True)).encode())
check("v117 sig: a different LINK SET changes the graph hash",
      _r3["sig_graph_hash"] != _r1["sig_graph_hash"],
      json.dumps({"a": _r1["sig_graph_hash"][:10],
                  "c": _r3["sig_graph_hash"][:10]}))
# the node renumbering (ids 10/20 -> 100/200, the same edges) never matters
_wfrenum = wf_v117("id-d")
_wfrenum["nodes"][0]["id"] = 100
_wfrenum["nodes"][1]["id"] = 200
_wfrenum["links"] = [[1, 100, 0, 200, 0, "LATENT"]]
_r4, _ = widx.analyze_workflow_bytes(json.dumps(_wfrenum).encode())
check("v117 sig: the renumbered nodes keep the SAME normalized edge keys",
      _r4["sig_edges"] == _r1["sig_edges"],
      json.dumps({"edges": _r4["sig_edges"]}))
check("v117 sig: the seed is masked in the named-widget form",
      json.dumps(_r1["sig_widgets"]).count("<v>") >= 1,
      _r1["sig_widgets"])
check("v117 sig: the multiset hash counts DUPLICATE node types",
      widx._node_type_multiset({"nodes": [
          {"type": "A"}, {"type": "A"}, {"type": "B"}]}) == ["A", "A", "B"])

# the deterministic score: presentation differences are invisible; the
# structure dominates; the same node types with DIFFERENT links never earn a
# falsely high score
_fa = {"types": ["KSampler", "VAEDecode"],
       "edges": ["KSampler|0>VAEDecode|0"],
       "widgets": [{"t": "KSampler",
                    "w": [["seed", "<v>"], ["steps", 20], ["cfg", 8.0]]},
                   {"t": "VAEDecode", "w": []}],
       "models": []}
check("v117 score: identical features = 100",
      widx.similarity_score(_fa, json.loads(json.dumps(_fa))) == 100)
_fb = json.loads(json.dumps(_fa))
_fb["widgets"][0]["w"][1][1] = 35   # a numeric-only config difference
_fb["widgets"][0]["w"][2][1] = 12.5
_sc_num = widx.similarity_score(_fa, _fb)
check("v117 score: a numeric widget mismatch is SOFTENED, not fatal",
      90 <= _sc_num < 100, str(_sc_num))
_fc = json.loads(json.dumps(_fa))
_fc["edges"] = ["VAEDecode|0>KSampler|0"]   # rewired
_sc_edge = widx.similarity_score(_fa, _fc)
check("v117 score: rewired links drop the score far below the threshold",
      _sc_edge < 80, str(_sc_edge))
_fd = json.loads(json.dumps(_fa))
_fd["edges"] = []
_fd["widgets"] = []
_sc_empty = widx.similarity_score(_fa, _fd)
check("v117 score: the same types with NO links/widgets never score high",
      _sc_empty < 80, str(_sc_empty))

# the GROUPS over a scanned library: same_uuid, exact copies, similar with
# the threshold + the anchor (no chaining), the kind filter, the cache
write_lib("v117_u1.json", wf_v117("v117-same-uuid"))
write_lib("v117_u2.json", wf_v117("v117-same-uuid"))
write_lib("v117_e1.json", wf_v117("v117-exact-a"))
write_lib("v117_e2.json", wf_v117("v117-exact-b"))   # the Duplicate twin
write_lib("v117_d1.json", wf_v117("v117-diff", extra_link=True))
scan(force=True)
_g = widx.similarity_groups(user_scope="default", threshold=90)
check("v117 groups: the answer is ok + nprof3 + the threshold echo",
      _g.get("ok") and _g.get("profile") == "nprof3" and
      _g.get("threshold") == 90,
      json.dumps({k: _g.get(k) for k in ("ok", "profile", "threshold")}))
_kinds = {}
for g in _g.get("groups", []):
    _kinds.setdefault(g["kind"], []).append(g)
check("v117 groups: the same-UUID pair is ONE same_uuid group",
      len([g for g in _kinds.get("same_uuid", [])
           if g.get("workflowId") == "v117-same-uuid"]) == 1,
      json.dumps([g.get("key") for g in _kinds.get("same_uuid", [])]))
check("v117 groups: the Duplicate twin is an exact group with 100%",
      any(g.get("count") == 2 and g.get("minScore") == 100 and
          {f["path"] for f in g.get("files", [])} ==
          {"workflows/v117_e1.json", "workflows/v117_e2.json"}
          for g in _kinds.get("exact", [])),
      json.dumps([g.get("key") for g in _kinds.get("exact", [])]))
check("v117 groups: the DIFFERENT graph with the same node types is NOT grouped",
      all(not [f for f in g.get("files", [])
               if f["path"].endswith("v117_d1.json")]
          for g in _g.get("groups", [])),
      json.dumps([g.get("key") for g in _g.get("groups", [])]))
check("v117 groups: every file sits in AT MOST ONE group",
      sum(g["count"] for g in _g.get("groups", [])) +
      _g.get("ungroupedTotal", 0) == _g.get("totalFiles", -1),
      json.dumps({"groups": sum(g["count"] for g in _g.get("groups", [])),
                  "ungrouped": _g.get("ungroupedTotal"),
                  "total": _g.get("totalFiles")}))
_g2 = widx.similarity_groups(user_scope="default", threshold=90)
check("v117 groups: the second call is served from the SQLite cache",
      _g2.get("cached") is True and
      len(_g2.get("groups", [])) == len(_g.get("groups", [])),
      json.dumps({"cached": _g2.get("cached")}))
_g3 = widx.similarity_groups(user_scope="default", threshold=90,
                             kind="exact")
check("v117 groups: the kind filter narrows WITHOUT recomputing",
      _g3.get("cached") is True and
      all(g["kind"] == "exact" for g in _g3.get("groups", [])) and
      any({f["path"] for f in g.get("files", [])} ==
          {"workflows/v117_e1.json", "workflows/v117_e2.json"}
          for g in _g3.get("groups", [])),
      json.dumps([g.get("key") for g in _g3.get("groups", [])]))
# the cache invalidation: a changed file re-indexes and the answer recomputes
write_lib("v117_u1.json", wf_v117("v117-same-uuid", seed=5))
scan(force=False)
_g4 = widx.similarity_groups(user_scope="default", threshold=90)
check("v117 groups: a re-index invalidates the cached answer",
      _g4.get("cached") is False,
      json.dumps({"cached": _g4.get("cached")}))
# the anchor rule: the group members are compared ONLY against the anchor -
# a low-similarity tail member never chains a third file into the group
_g5 = widx.similarity_groups(user_scope="default", threshold=95)
check("v117 groups: the strict threshold keeps the groups tight",
      all(g["kind"] != "similar" for g in _g5.get("groups", [])) or
      all(g["count"] <= 3 for g in _g5.get("groups", [])
          if g["kind"] == "similar"),
      json.dumps([g.get("count") for g in _g5.get("groups", [])]))
# the broad-bucket guard: a bucket bigger than SIM_MAX_BUCKET is skipped.
# The probe files carry NO uuid (never grouped by id) and pairwise-DIFFERENT
# edge sets (never an exact group) - their ONLY common feature is the node
# type multiset, so they land in ONE types bucket together with d1.
_old_bucket = widx.SIM_MAX_BUCKET
widx.SIM_MAX_BUCKET = 2
try:
    for i in range(4):
        _wf = wf_v117("v117-wide-%d" % i, seed=i)
        # a per-file edge set (never two files share the exact graph)
        _wf["links"] = [[1, 10, 0, 20, i % 2, "LATENT"]]
        write_lib("v117_w%d.json" % i, _wf)
    scan(force=True)
    _gb = widx.similarity_groups(user_scope="default", threshold=80)
    check("v117 groups: a bucket over the cap is SKIPPED (reported honestly)",
          _gb.get("skippedBroad", 0) >= 1,
          json.dumps({"skipped": _gb.get("skippedBroad"),
                      "ok": _gb.get("ok"), "error": _gb.get("error"),
                      "groups": [(g.get("kind"), g.get("count"))
                                 for g in _gb.get("groups", [])],
                      "ungrouped": _gb.get("ungroupedTotal"),
                      "total": _gb.get("totalFiles")}))
finally:
    widx.SIM_MAX_BUCKET = _old_bucket

# ---------------------------------------------------------------------------
# v118: the BUSY db contract - a locked db is TRANSIENT, never corruption.
# The v117 bug: init_db's probe DDL waited out busy_timeout against the
# scan's open write txn, the OperationalError fell into the corrupt-db
# quarantine branch and RENAMED THE LIVE INDEX to .corrupt-* (the groups
# request wiped the index and answered 'database is locked').
# ---------------------------------------------------------------------------
_lib2 = os.path.join(TMP, "userlib2", "workflows")
os.makedirs(_lib2, exist_ok=True)


def _wf118(wid, seed=0):
    return {"id": wid, "revision": 1,
            "nodes": [{"id": 1, "type": "KSampler", "pos": [seed, 0],
                       "widgets_values": ["s%d" % seed]},
                      {"id": 2, "type": "SaveImage", "pos": [9, 9]}],
            "links": [], "extra": {}, "version": 0.4}


for _i in range(6):
    _p = os.path.join(_lib2, "f%d.json" % _i)
    with open(_p, "w") as _fh:
        json.dump(_wf118("uuid-%d" % (_i % 3), seed=_i), _fh)

_stats118 = widx.scan_index(workflows_user_dirs=[_lib2],
                            hide_dirs_fn=lambda d: [], force=True)
check("v118 busy: the scan over the fresh root is complete",
      _stats118.get("ok") and _stats118.get("complete") and
      _stats118.get("indexed") == 6,
      json.dumps({k: _stats118.get(k)
                  for k in ("ok", "complete", "indexed", "errors")}))

# the dir may already carry a LEGITIMATE .corrupt-* left by the earlier
# corruption-rebuild test - the busy contract asserts NO NEW one appears
# (the -wal/-shm sidecars come and go with the connections - only the
# .corrupt-* names are compared)
_corrupt_before_busy = {n for n in os.listdir(os.path.dirname(DB))
                        if ".corrupt-" in n}

_fast_orig_connect = widx._connect


def _fast_connect118(db):
    _c = _fast_orig_connect(db)
    _c.execute("PRAGMA busy_timeout=200")
    return _c


class _BusyConn:
    """A connection whose every statement answers 'database is locked'."""
    def __init__(self, real):
        self._real = real

    def execute(self, *a, **k):
        raise sqlite3.OperationalError("database is locked")

    def commit(self):
        pass

    def close(self):
        try:
            self._real.close()
        except sqlite3.DatabaseError:
            pass


def _dir_entries118():
    return sorted(os.listdir(os.path.dirname(DB)))


_connA = sqlite3.connect(DB, timeout=10)
_connA.execute("PRAGMA busy_timeout=8000")
_connA.execute("BEGIN IMMEDIATE")
_connA.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('p118','1')")
try:
    widx._connect = _fast_connect118
    try:
        _res_init = widx.init_db(DB)
        check("v118 busy: init_db answers (db, fts) WITHOUT quarantining",
              isinstance(_res_init, tuple) and _res_init[0] == DB,
              json.dumps(str(_res_init)))
        _corrupt_now = {n for n in os.listdir(os.path.dirname(DB))
                        if ".corrupt-" in n}
        check("v118 busy: NO NEW .corrupt-* file appeared (the index survived)",
              _corrupt_now == _corrupt_before_busy,
              json.dumps(sorted(_corrupt_now)))
        _connB = sqlite3.connect(DB, timeout=10)
        _n = _connB.execute("SELECT count(*) FROM workflow_files").fetchone()[0]
        _connB.close()
        check("v118 busy: the indexed rows are intact during a foreign txn",
              _n == 6, str(_n))
        _g118 = widx.similarity_groups(user_scope="default", threshold=90)
        check("v118 busy: the groups request SUCCEEDS during a foreign write txn (WAL)",
              _g118.get("ok") is True and _g118.get("totalFiles") == 6 and
              not _g118.get("busy"),
              json.dumps({k: _g118.get(k)
                          for k in ("ok", "busy", "error", "totalFiles")}))
        check("v118 busy: the same-UUID groups still build during the txn",
              any(g.get("kind") == "same_uuid" and g.get("count") == 2
                  for g in _g118.get("groups", [])),
              json.dumps([(g.get("kind"), g.get("count"))
                          for g in _g118.get("groups", [])]))
    finally:
        widx._connect = _fast_orig_connect

    # the CLASSIFICATION: a locked statement answers {ok:false, busy:true}
    widx._connect = (lambda db: _BusyConn(sqlite3.connect(db)))
    try:
        _dup = widx.duplicate_groups(user_scope="default")
        check("v118 busy: duplicate_groups classifies locked as busy:true",
              _dup.get("ok") is False and _dup.get("busy") is True and
              "locked" in str(_dup.get("error")),
              json.dumps({k: _dup.get(k) for k in ("ok", "busy", "error")}))
        _sr = widx.search_index(user_scope="default", q="")
        check("v118 busy: search_index classifies locked as busy:true (the page shape intact)",
              _sr.get("busy") is True and _sr.get("files") == [] and
              "has_more" in _sr,
              json.dumps({k: _sr.get(k) for k in ("busy", "error", "total")}))
        _sn = widx.search_notes(q="x")
        check("v118 busy: search_notes classifies locked as busy:true",
              _sn.get("ok") is False and _sn.get("busy") is True,
              json.dumps({k: _sn.get(k) for k in ("ok", "busy", "error")}))
        _st = widx.index_status(user_scope="default")
        check("v118 busy: index_status classifies locked as busy:true",
              _st.get("ok") is False and _st.get("busy") is True,
              json.dumps({k: _st.get(k) for k in ("ok", "busy", "error")}))
    finally:
        widx._connect = _fast_orig_connect

    # a REAL OperationalError raised past the reads (simulating a write
    # contention inside the answer build) keeps the busy contract
    _orig_rows = widx._similarity_rows

    def _busy_rows(conn, scope):
        raise sqlite3.OperationalError("database is locked")

    widx._similarity_rows = _busy_rows
    try:
        _gb = widx.similarity_groups(user_scope="default", threshold=90)
        check("v118 busy: similarity_groups answers busy:true on a locked statement",
              _gb.get("ok") is False and _gb.get("busy") is True and
              "locked" in str(_gb.get("error")) and
              _gb.get("groups") == [] and "threshold" in _gb,
              json.dumps({k: _gb.get(k)
                          for k in ("ok", "busy", "error", "threshold")}))
    finally:
        widx._similarity_rows = _orig_rows
finally:
    _connA.rollback()
    _connA.close()

# the quarantine still fires for REAL corruption (the contract unchanged)
_connC = sqlite3.connect(DB, timeout=10)
_connC.execute("PRAGMA busy_timeout=8000")
_connC.execute("BEGIN IMMEDIATE")
_connC.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('p118b','1')")
try:
    widx._connect = _fast_connect118
    try:
        _res_init2 = widx.init_db(DB)
        _corrupt_now2 = {n for n in os.listdir(os.path.dirname(DB))
                         if ".corrupt-" in n}
        check("v118 busy: the second contended init also stays clean",
              isinstance(_res_init2, tuple) and
              _corrupt_now2 == _corrupt_before_busy,
              json.dumps(sorted(_corrupt_now2)))
    finally:
        widx._connect = _fast_orig_connect
finally:
    _connC.rollback()
    _connC.close()

_corrupt_tmp = os.path.join(TMP, "corrupt118")
os.makedirs(_corrupt_tmp, exist_ok=True)
_corrupt_db = os.path.join(_corrupt_tmp, "c.db")
with open(_corrupt_db, "wb") as _fh:
    _fh.write(b"this is not a sqlite database at all" * 40)
widx.set_db_path(_corrupt_db)
try:
    _rc = widx.init_db(_corrupt_db)
    check("v118 busy: REAL corruption still quarantines + rebuilds",
          isinstance(_rc, tuple) and
          any(".corrupt-" in n for n in sorted(os.listdir(_corrupt_tmp))),
          json.dumps(sorted(os.listdir(_corrupt_tmp))))
finally:
    widx.set_db_path(DB)

# the PER-FILE COMMIT: the scan's write txn never spans the whole pass -
# rows written so far are VISIBLE to a concurrent reader mid-scan
_lib3 = os.path.join(TMP, "userlib3", "workflows")
os.makedirs(_lib3, exist_ok=True)
for _i in range(210):
    _p = os.path.join(_lib3, "w%03d.json" % _i)
    with open(_p, "w") as _fh:
        json.dump(_wf118("uuid3-%d" % (_i % 7), seed=_i), _fh)
_seen_progress = {"n": 0}


def _progress118(_stats):
    _seen_progress["n"] += 1
    if _seen_progress.get("rows_at_first") is None:
        _c = sqlite3.connect(DB, timeout=10)
        try:
            _seen_progress["rows_at_first"] = _c.execute(
                "SELECT count(*) FROM workflow_files WHERE rel_path LIKE "
                "'workflows/w%'").fetchone()[0]
        finally:
            _c.close()


_stats3 = widx.scan_index(workflows_user_dirs=[_lib3],
                          hide_dirs_fn=lambda d: [], force=True,
                          progress=_progress118)
check("v118 per-file commit: the progress callback fired mid-scan",
      _seen_progress["n"] >= 1, str(_seen_progress["n"]))
check("v118 per-file commit: rows are COMMITTED while the scan still runs (no whole-pass txn)",
      (_seen_progress.get("rows_at_first") or 0) >= 100,
      json.dumps(_seen_progress))
check("v118 per-file commit: the pass itself still completes + indexes everything",
      _stats3.get("complete") and _stats3.get("indexed") == 210,
      json.dumps({k: _stats3.get(k)
                  for k in ("ok", "complete", "indexed", "errors")}))

# ---------------------------------------------------------------------------
# v119: the FLEXIBLE similarity candidates (nprof3). The owner's report:
# v117 bucketed the "Similar" stage by the FULL node-type multiset hash -
# a copy with ONE node added/removed changed the hash and was never scored
# (only ~10 groups at the 80% threshold on a heavily-modified library).
# nprof3: the candidates are the union of the multiset bucket + the
# unique-set bucket + the rare-type pairs, the wiring noise (Reroute/Note)
# is invisible to the features, the widget alignment is a greedy best-pair.
# ---------------------------------------------------------------------------
check("v119 noise: _is_sim_noise_type covers the reroute variants + notes",
      widx._is_sim_noise_type("Reroute") and
      widx._is_sim_noise_type("Reroute (rgthree)") and
      widx._is_sim_noise_type("Reroute//something") and
      widx._is_sim_noise_type("Note") and
      widx._is_sim_noise_type("MarkdownNote") and
      not widx._is_sim_noise_type("KSampler") and
      not widx._is_sim_noise_type("RerouteOr Something") and
      not widx._is_sim_noise_type(None),
      "noise test")


def wf_v119_base(wid, seed=0):
    # a 12-node pipeline: 10 UNIQUE node types, two DISTINCTIVE LS* classes
    # (the rare-type candidate signal) + the generic ones
    return {"id": wid, "revision": 1,
            "nodes": [
                {"id": 1, "type": "CheckpointLoaderSimple",
                 "widgets_values": ["m.safetensors"]},
                {"id": 2, "type": "CLIPTextEncode",
                 "widgets_values": ["prompt %d" % seed]},
                {"id": 3, "type": "CLIPTextEncode",
                 "widgets_values": ["neg %d" % seed]},
                {"id": 4, "type": "LSEncoder", "widgets_values": {"frames": 24}},
                {"id": 5, "type": "LSWav2Vec", "widgets_values": {"chunk": 2}},
                {"id": 6, "type": "LSDenoiser", "widgets_values": {"strength": 0.6}},
                {"id": 7, "type": "KSampler",
                 "widgets_values": {"seed": 5, "steps": 20}},
                {"id": 8, "type": "KSampler",
                 "widgets_values": {"seed": 6, "steps": 18}},
                {"id": 9, "type": "VAEDecode"},
                {"id": 10, "type": "SaveImage"},
                {"id": 11, "type": "PreviewImage"},
                {"id": 12, "type": "LSUpscale", "widgets_values": ["2x"]},
            ],
            "links": [
                [1, 1, 0, 7, 0, "MODEL"], [2, 1, 0, 8, 0, "MODEL"],
                [3, 2, 0, 7, 1, "CONDITIONING"], [4, 3, 0, 8, 1, "CONDITIONING"],
                [5, 4, 0, 7, 2, "LATENT"], [6, 4, 0, 8, 2, "LATENT"],
                [7, 5, 0, 6, 0, "AUDIO"],
                [8, 7, 0, 9, 0, "LATENT"], [9, 8, 0, 12, 0, "LATENT"],
                [10, 9, 0, 10, 0, "IMAGE"], [11, 9, 0, 11, 0, "IMAGE"],
                [12, 12, 0, 8, 3, "LATENT"],
            ],
            "extra": {}, "version": 0.4}


_lib4 = os.path.join(TMP, "userlib4", "workflows")
os.makedirs(_lib4, exist_ok=True)
# THE OWNER'S CASE: a copy with a TWO-NODE GROUP added (a small upscale
# tail). v117: the multiset hash changed -> the pair was never scored.
# v119: the rare LS* types tie the pair, the math prefilter passes, the
# score 86 clears the 80% threshold.
_a119 = wf_v119_base("v119-a")
_b119 = wf_v119_base("v119-b")
_b119["nodes"].extend([
    {"id": 13, "type": "UpscalerX", "widgets_values": ["2x-model"]},
    {"id": 14, "type": "ImageScaleBy", "widgets_values": {"scale": 1.5}},
])
_b119["links"].extend([[13, 9, 0, 13, 0, "IMAGE"],
                       [14, 13, 0, 14, 0, "IMAGE"]])
with open(os.path.join(_lib4, "v119_a.json"), "w") as _fh:
    json.dump(_a119, _fh)
with open(os.path.join(_lib4, "v119_b.json"), "w") as _fh:
    json.dump(_b119, _fh)
_stats119 = widx.scan_index(workflows_user_dirs=[_lib4],
                            hide_dirs_fn=lambda d: [], force=True)
check("v119 scan: the two modified-copy files index cleanly",
      _stats119.get("ok") and _stats119.get("indexed") == 2,
      json.dumps({k: _stats119.get(k) for k in ("ok", "indexed", "errors")}))
_ga = widx.similarity_groups(user_scope="default", threshold=80)
check("v119 similar: a copy with a node GROUP added is GROUPED at 80 (the owner's case, v117 refused)",
      any(g.get("kind") == "similar" and
          {f["path"] for f in g.get("files", [])} ==
          {"workflows/v119_a.json", "workflows/v119_b.json"}
          for g in _ga.get("groups", [])),
      json.dumps([(g.get("kind"), g.get("count"), g.get("minScore"))
                  for g in _ga.get("groups", [])]))
_ga90 = widx.similarity_groups(user_scope="default", threshold=90)
check("v119 similar: the SAME pair stays UNGROUPED at 90 (the score decides, not the prefilter)",
      all(g.get("kind") != "similar" for g in _ga90.get("groups", [])),
      json.dumps([(g.get("kind"), g.get("count"))
                  for g in _ga90.get("groups", [])]))
check("v119 similar: the honest counters are in the answer",
      _ga.get("candidatePairs", 0) >= 1 and _ga.get("pairsScored", 0) >= 1
      and "skippedPairs" in _ga,
      json.dumps({k: _ga.get(k) for k in ("candidatePairs", "pairsScored",
                                          "skippedPairs")}))

# the REROUTE/NOTE invisibility: a reroute chain on one link + a note node
# change NOTHING in the features - the pair scores 100 inside a similar
# group (never an exact group: the graph document still differs)
_lib5 = os.path.join(TMP, "userlib5", "workflows")
os.makedirs(_lib5, exist_ok=True)
_d1 = wf_v119_base("v119-d1")
_d2 = wf_v119_base("v119-d2")
_d2["nodes"].append({"id": 15, "type": "Reroute"})
_d2["nodes"].append({"id": 16, "type": "Note",
                     "widgets_values": ["the free text must not count"]})
_d2["links"] = [lk for lk in wf_v119_base("v119-d2")["links"]
                if not (lk[1] == 9 and lk[3] == 10)]
_d2["links"].extend([[15, 9, 0, 15, 0, "IMAGE"],
                     [16, 15, 0, 10, 0, "IMAGE"]])
with open(os.path.join(_lib5, "v119_d1.json"), "w") as _fh:
    json.dump(_d1, _fh)
with open(os.path.join(_lib5, "v119_d2.json"), "w") as _fh:
    json.dump(_d2, _fh)
widx.scan_index(workflows_user_dirs=[_lib5], hide_dirs_fn=lambda d: [],
                force=True)
_gd = widx.similarity_groups(user_scope="default", threshold=95)
check("v119 reroute: reroute chain + note node stay INVISIBLE - the pair groups at 95 with score 100",
      any(g.get("kind") == "similar" and g.get("minScore") == 100 and
          {f["path"] for f in g.get("files", [])} ==
          {"workflows/v119_d1.json", "workflows/v119_d2.json"}
          for g in _gd.get("groups", [])),
      json.dumps([(g.get("kind"), g.get("count"), g.get("minScore"))
                  for g in _gd.get("groups", [])]))
check("v119 reroute: the pair is NOT an exact group (the graph doc still differs)",
      all(not ({f["path"] for f in g.get("files", [])} ==
               {"workflows/v119_d1.json", "workflows/v119_d2.json"})
          for g in _gd.get("groups", []) if g.get("kind") == "exact"),
      json.dumps([g.get("kind") for g in _gd.get("groups", [])]))

# the _extract_edges reroute resolution: unit assertions
_e_direct = widx._extract_edges({
    "nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B"}],
    "links": [[1, 1, 0, 2, 0, "X"]]})
_e_reroute = widx._extract_edges({
    "nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B"},
               {"id": 3, "type": "Reroute"}],
    "links": [[1, 1, 0, 3, 0, "X"], [2, 3, 0, 2, 0, "X"]]})
_e_fanout = widx._extract_edges({
    "nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B"},
               {"id": 4, "type": "B"}, {"id": 3, "type": "Reroute"}],
    "links": [[1, 1, 0, 3, 0, "X"], [2, 3, 0, 2, 0, "X"],
              [3, 3, 0, 4, 0, "X"]]})
_e_cycle = widx._extract_edges({
    "nodes": [{"id": 4, "type": "Reroute"}, {"id": 5, "type": "Reroute"}],
    "links": [[1, 4, 0, 5, 0, "X"], [2, 5, 0, 4, 0, "X"]]})
check("v119 edges: the direct link keeps its key",
      _e_direct == ["A|0>B|0"], json.dumps(_e_direct))
check("v119 edges: A>Reroute>B resolves to the SAME key as the direct link",
      _e_reroute == _e_direct, json.dumps(_e_reroute))
check("v119 edges: a reroute FAN-OUT dedupes to one semantic edge (no multiset inflation)",
      _e_fanout == ["A|0>B|0"], json.dumps(_e_fanout))
check("v119 edges: a cyclic reroute wiring terminates + dedupes to ONE edge",
      _e_cycle == ["Reroute|0>Reroute|0"],
      json.dumps(_e_cycle))

# the widget greedy alignment: the swapped bucket order the positional
# compare mismatched (both pairs scored 0) now aligns to 1.0
_wa = [{"t": "KSampler", "w": [["seed", "<v>"], ["steps", 20]]},
       {"t": "KSampler", "w": [["steps", 30]]}]
_wb = [{"t": "KSampler", "w": [["steps", 30]]},
       {"t": "KSampler", "w": [["seed", "<v>"], ["steps", 20]]}]
check("v119 widgets: the greedy best-pair aligns a reordered bucket to 1.0",
      widx._widgets_similarity(_wa, _wb) == 1.0,
      str(widx._widgets_similarity(_wa, _wb)))
_wc = [{"t": "KSampler", "w": [["seed", "<v>"], ["steps", 20]]},
       {"t": "KSampler", "w": [["steps", 30]]}]
_wd = [{"t": "KSampler", "w": [["seed", "<v>"], ["steps", 20]]}]
check("v119 widgets: an unmatched extra node still costs fully",
      abs(widx._widgets_similarity(_wc, _wd) - 0.5) < 1e-9,
      str(widx._widgets_similarity(_wc, _wd)))
check("v119 score: the noise types in a hand-built feature dict change NOTHING",
      widx.similarity_score(
          {"types": ["KSampler", "Reroute", "Note"], "edges": [],
           "widgets": [], "models": []},
          {"types": ["KSampler"], "edges": [], "widgets": [],
           "models": []}) == 100,
      str(widx.similarity_score(
          {"types": ["KSampler", "Reroute", "Note"], "edges": [],
           "widgets": [], "models": []},
          {"types": ["KSampler"], "edges": [], "widgets": [],
           "models": []})))

# the pair budget: the full scores stay bounded + the skip is honest
_lib6 = os.path.join(TMP, "userlib6", "workflows")
os.makedirs(_lib6, exist_ok=True)
for _i, _wid in enumerate(("v119-c1", "v119-c2", "v119-c3")):
    with open(os.path.join(_lib6, "v119_c%d.json" % _i), "w") as _fh:
        json.dump(wf_v119_base(_wid, seed=_i), _fh)
widx.scan_index(workflows_user_dirs=[_lib6], hide_dirs_fn=lambda d: [],
                force=True)
_old_budget = widx.SIM_PAIR_BUDGET
widx.SIM_PAIR_BUDGET = 1
try:
    _gb = widx.similarity_groups(user_scope="default", threshold=80)
    check("v119 budget: the full scores stay inside the budget + the skips are counted",
          _gb.get("ok") and _gb.get("pairsScored") <= 1 and
          _gb.get("skippedPairs") >= 1,
          json.dumps({k: _gb.get(k) for k in ("ok", "pairsScored",
                                              "skippedPairs")}))
    check("v119 budget: a group still builds from the scored pair",
          any(g.get("kind") == "similar" for g in _gb.get("groups", [])),
          json.dumps([(g.get("kind"),) for g in _gb.get("groups", [])]))
finally:
    widx.SIM_PAIR_BUDGET = _old_budget

# the STALE-PROFILE honesty: after a profile bump every row is old-profile
# until the next scan - the answer says so instead of an empty grid
_stale_db = os.path.join(TMP, "staleprof", "settings_hub", "workflows_manager",
                         "index", "workflow_index.db")
os.makedirs(os.path.dirname(_stale_db), exist_ok=True)
_stale_lib = os.path.join(TMP, "stalelib", "workflows")
os.makedirs(_stale_lib, exist_ok=True)
with open(os.path.join(_stale_lib, "s1.json"), "w") as _fh:
    json.dump(wf_v119_base("v119-stale"), _fh)
widx.set_db_path(_stale_db)
try:
    widx.scan_index(workflows_user_dirs=[_stale_lib],
                    hide_dirs_fn=lambda d: [], force=True)
    _sc = sqlite3.connect(_stale_db, timeout=10)
    try:
        _sc.execute("UPDATE workflow_files SET "
                    "normalization_profile_version='nprof0'")
        _sc.commit()
    finally:
        _sc.close()
    _gs = widx.similarity_groups(user_scope="default", threshold=80)
    check("v119 stale: the answer stays ok + names the stale profile",
          _gs.get("ok") is True and _gs.get("staleProfile") is True and
          _gs.get("staleFiles", 0) == 1 and _gs.get("totalFiles") == 0,
          json.dumps({k: _gs.get(k) for k in ("ok", "staleProfile",
                                              "staleFiles", "totalFiles")}))
finally:
    widx.set_db_path(DB)

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# cleanup
shutil.rmtree(TMP, ignore_errors=True)

print()
print("PASS: %d  FAIL: %d" % (PASS, FAIL))
if FAILURES:
    print("Failures:")
    for f in FAILURES:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
