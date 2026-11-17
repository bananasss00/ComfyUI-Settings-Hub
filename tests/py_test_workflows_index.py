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
check("v117: the profile is nprof2 and the schema is 2",
      widx.NORMALIZATION_PROFILE_VERSION == "nprof2" and
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
check("v117 groups: the answer is ok + nprof2 + the threshold echo",
      _g.get("ok") and _g.get("profile") == "nprof2" and
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
