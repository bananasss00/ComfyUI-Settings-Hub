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
    normalization_profile_version  the rules version ("nprof3") - a rule
                      change re-indexes, old hashes are never silently
                      reinterpreted

v117 SIMILARITY SIGNATURES (the owner's Files-grouping plan) - the scan
computes FOUR extra per-row features that make the grouping a pure SQLite
query (no file reads at group time):
    sig_graph_hash    the ID-INDEPENDENT graph fingerprint: the workflow
                      document minus the top-level id/revision and the
                      confirmed presentation fields. Two files that share it
                      are "Exact graph copy, different UUID" (100%) - the
                      ComfyUI Duplicate path regenerates ONLY state.id
                      (workflowService.ts duplicateWorkflow), so the saved
                      duplicate matches its original here.
    sig_types_hash    the hash of the node-type MULTISET (counts kept). The
                      cheap candidate bucket for the "Similar" score.
    sig_edges         the normalized link list as (source_type, origin_slot)
                      -> (target_type, target_slot) pairs - node ids and
                      link ids never enter the key.
    sig_widgets       the per-node widget values, volatile entries (seed /
                      control_after_generate) masked, so two runs of one
                      pipeline with different seeds stay similar.
The similarity SCORE itself is computed only for candidate pairs and the
result is cached in the similarity_cache table (invalidated by any re-index
or profile change) - the plan's performance contract for 2000+ libraries.

v119 FLEXIBLE CANDIDATES (nprof3) - the owner's report: at the 80%
threshold v117 found only ~10 groups, because the "Similar" stage bucketed
the candidates by the sig_types_hash - the hash of the FULL node-type
multiset, so a copy with ONE node added/removed changed the hash, landed
in a different bucket and was never scored. Three fixes (the score
formula, the weights and the anchor rule stay untouched):
    1. The candidate pool is now the UNION of three cheap sources: the
       exact multiset-hash bucket (the fast path), the UNIQUE-set bucket
       (the same classes with different counts) and the RARE-TYPE pairs
       (a node type seen in few files ties its carriers together - the
       generic types never explode the pool). A cheap MATH prefilter
       (the size band + the types floor derived from SIM_WEIGHTS) runs
       first; the full score runs for survivors only, against the ANCHOR
       (no chaining), bounded by a pair budget that is reported honestly.
    2. The wiring noise is INVISIBLE to the features: a Reroute chain is
       resolved THROUGH (A -> Reroute -> B contributes the direct edge
       A > B - a reroute inserted or deleted on the canvas never changes
       the edges), and Reroute/Note/MarkdownNote nodes leave the types
       multiset and the widget signature (the owner's 'the links
       switched' case scores by the semantic graph, not by the drawing).
    3. The widget alignment per type is a greedy BEST-PAIR matching
       instead of the sorted positional compare - one changed value can
       no longer reorder the whole type bucket and mismatch its peers.

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
NORMALIZATION_PROFILE_VERSION = "nprof3"   # v119: the flexible candidates
# (nprof2 = v117 introduced the sig_* features; nprof3 = v119 makes the
# Reroute/Note wiring noise INVISIBLE: the edges resolve through reroutes,
# the noise types leave the multiset and the widget signature - the rule
# change re-indexes every row once, honest per the profile contract)
SCHEMA_VERSION = "2"                       # v117: +4 sig columns + the cache

# The score/answer contract version in the CACHE KEY: a bump invalidates
# the cached similarity answers WITHOUT a full re-index (the extracted
# features are byte-identical, a profile bump would re-parse every file
# for nothing - the honest-cheap invalidation). s2 = the v120 jaccard+overlap
# blend; s3 = v121 - the FORMULA is untouched, the ANSWER construction
# changed: the similar stage now clusters by UNION-FIND over every scored
# candidate edge >= threshold (the strict anchor-star + the JOIN pass are
# retired) and the candidate pool gains the name-stem + model-set seeds.
SIM_SCORE_VERSION = "s3"

# v117 similarity-group bounds (the plan's performance contract: a 2000+
# library must answer from SQLite, the detailed score runs for CANDIDATES
# only; the cache table keeps repeat queries free)
SIM_MAX_BUCKET = 60        # a candidate bucket up to this emits ALL pairs
SIM_BIG_SUB = 200          # v120: an oversized-bucket model sub-bucket cap
SIM_STAR_K = 8             # v120: the giant-sub-bucket per-file star partners
SIM_STAR_MAX = 400         # v120: the star participants cap (deterministic,
                           # the star compare is O(star^2) cheap counters)
SIM_MAX_GROUPS = 200       # the groups answer cap
SIM_UNGROUPED_CAP = 300    # the ungrouped rows carried in one answer
SIM_CACHE_ROWS = 64        # the LRU cap of the similarity_cache table
# v119 flexible-candidate bounds: the rare-type posting lists cap (a type
# seen in MORE files than this is generic - KSampler/VAEDecode - and must
# never tie thousands of pairs), the full-score budget per answer (the math
# prefilter is free, the detailed score is the expensive step; the budget
# is reported honestly as skippedPairs).
# v121: the cap rises 60 -> 400 and rare_max itself now derives from the
# LARGEST ALREADY-VISIBLE family (the same-UUID/exact groups + the name-stem
# buckets), not from N//20 - on a small folder (N=113) the old formula
# collapsed to 8 while the family signature nodes sit at df 8-11, so they
# never posted and the candidate pool starved (the spec's P1 measurement:
# rare_max=60 restored 100% candidate coverage on the owner's folder).
SIM_RARE_DF_MAX_CAP = 400
SIM_RARE_SLACK = 4        # rare_max = largest_visible_family + this slack
SIM_PAIR_BUDGET = 24000
SIM_REROUTE_DEPTH = 32     # the reroute-chain walk cap (cycle defense)
SIM_CAND_PAIRS = 150000    # the candidate-pair emission cap (pathological
# libraries: the emission stops + candTruncated:true - honest, deterministic
# order: the buckets first, then the rare types by df ascending)
# the wiring/annotation noise: these node types NEVER enter the similarity
# features (the edges resolve THROUGH a reroute; a note text is free)
SIM_NOISE_TYPES = {"Reroute", "Note", "MarkdownNote"}
# the deterministic score weights (they sum to 1.0 and live in the answer so
# the UI can explain the estimate honestly)
SIM_WEIGHTS = {"types": 0.35, "edges": 0.40, "widgets": 0.15, "models": 0.10}
# volatile widget keys - their value NEVER lowers the similarity (two runs
# of one pipeline differ by the seed only)
SIM_VOLATILE_KEYS = {"seed", "noise_seed", "rand_seed", "random_seed",
                     "control_after_generate", "batch_seed"}
SIM_NUMERIC_PENALTY = 0.4  # a numeric (e.g. steps/cfg) mismatch is softened
# v116 (plan 3.1): the per-pass walk bound. The bound no longer lies: a
# truncated pass is reported (stats + meta) and the vanished-row prune is
# SKIPPED - unverified rows are never deleted. Tests shrink the bound
# through SHUB_WF_MAX_WALK instead of hardcoding a second limit.
MAX_WALK_FILES = 30000
# v116 (plan 3.2): a Refresh that lands while another scan runs JOINS it
# (waits up to this many seconds for the lock) instead of failing with
# "a scan is already running".
SCAN_JOIN_TIMEOUT_S = 120


def _walk_limit():
    """The effective per-pass walk bound (SHUB_WF_MAX_WALK overrides the
    default for tests; a broken value falls back to the default)."""
    raw = os.environ.get("SHUB_WF_MAX_WALK")
    if raw:
        try:
            v = int(raw)
            if v > 0:
                return v
        except (TypeError, ValueError):
            pass
    return MAX_WALK_FILES

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


def _is_sim_noise_type(t):
    """v119: the wiring/annotation noise test. A type is noise when its
    base name (the part before the '//frontend' suffix ComfyUI appends to
    some virtual nodes) is Reroute/Note/MarkdownNote or starts with
    'Reroute' (the rgthree/scene variants are reroutes too). The noise
    nodes never carry semantic state: a reroute only forwards its input,
    a note only holds free text."""
    if not isinstance(t, str):
        return False
    base = t.split("//", 1)[0].strip()
    # 'Reroute (rgthree)' is a reroute; 'RerouteOr...' is NOT (the prefix
    # must end at a word boundary)
    return (base in SIM_NOISE_TYPES or base == "Reroute"
            or base.startswith("Reroute ") or base.startswith("Reroute("))


# v121: the version-insensitive FILENAME STEM - the seed the spec's P1
# asked for. Versioned families literally share a name ('x-simp-batch-v3.1.1'
# and 'x-simp-batch-v3.1.2' carry the same stem); version tokens (v1.5.3.2 /
# 1.5.3 / v3 / v1_1), a trailing bare number (ref_image_01), the '(2)'
# duplicate suffix and a copy/backup word are stripped, every non-alphanumeric
# run collapses to one space, so 'x-simp-batch', 'x_simp_batch' and
# 'X Simp Batch' share the bucket too. Deterministic and O(1) per file; the
# candidate pairs it emits are still SCORE-GATED by the full similarity.
_SIM_STEM_VERSION_RE = re.compile(
    r"(?<![a-z0-9])v?\d+(?:[._]\d+)+(?![a-z0-9])")   # v1.5.3.2 / 1.5.3 / v1_1
_SIM_STEM_VNUM_RE = re.compile(r"(?<![a-z0-9])v\d+(?![a-z0-9])")  # bare v3
_SIM_STEM_TAILNUM_RE = re.compile(r"(?<![a-z0-9])\d+(?![a-z0-9])\s*$")  # _01
_SIM_STEM_DUP_RE = re.compile(r"\(\s*\d+\s*\)")                   # the (2) suffix
_SIM_STEM_COPY_RE = re.compile(
    r"[\s_-]*(?:copy|copies|копия|копии|duplicate|backup)\d*[\s_-]*$")
_SIM_STEM_NONWORD_RE = re.compile(r"[^a-z0-9]+")


def _name_stem(name):
    """The version-insensitive filename stem (v121): '' when nothing
    meaningful remains (a version-only name carries no family signal - the
    model-set/rare-type seeds cover those files instead)."""
    if not isinstance(name, str) or not name:
        return ""
    s = name.strip()
    if s.lower().endswith(".json"):
        s = s[:-5]
    s = s.lower()
    s = _SIM_STEM_DUP_RE.sub(" ", s)
    s = _SIM_STEM_VERSION_RE.sub(" ", s)
    s = _SIM_STEM_VNUM_RE.sub(" ", s)
    s = _SIM_STEM_COPY_RE.sub(" ", s)
    s = _SIM_STEM_TAILNUM_RE.sub(" ", s)
    return _SIM_STEM_NONWORD_RE.sub(" ", s).strip()


def _sig_graph_doc(wf):
    """The ID-INDEPENDENT graph document (v117): the presentation-stripped
copy WITHOUT the top-level id and revision. This is the fingerprint that
recognizes a ComfyUI Duplicate: duplicateWorkflow regenerates ONLY state.id,
so the saved copy is byte-identical apart from the id (and the file name).
The original document is NEVER modified."""
    g, _presentation = _strip_presentation(wf)
    g2 = dict(g)
    for k in ("id", "revision"):
        g2.pop(k, None)
    return g2


def _extract_edges(wf):
    """The normalized link keys (v117): ['srcType|slot>dstType|slot', ...]
    sorted + counted. Node ids and link ids NEVER enter the key - a graph that
    differs only by renumbering scores 100% on the edge feature. Handles both
    the v1 array links [id, origin_id, origin_slot, target_id, target_slot,
    type] and the newer object links. Bounded to 6000 keys.

    v119: a REROUTE CHAIN is resolved THROUGH - the link A -> Reroute ->
    B contributes the direct edge A|slot > B|slot, so inserting or deleting
    a reroute on the canvas never changes the edge features (the owner's
    'the links switched' case is scored by the semantic graph, not by the
    drawing). A chain that dead-ends keeps its reroute endpoint as-is."""
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    id2type = {}
    for n in nodes:
        if isinstance(n, dict) and isinstance(n.get("id"), (int, float)):
            id2type[n["id"]] = str(n.get("type") or "?")
    reroute_ids = {nid for nid, t in id2type.items()
                   if str(t).split("//", 1)[0].strip().startswith("Reroute")}
    links = wf.get("links") if isinstance(wf.get("links"), list) else []
    # the reroute wiring: rin[reroute_id] = its INPUT (origin_id, slot),
    # rout[reroute_id] = its OUTPUT (target_id, slot) - a reroute has one
    # input and one output slot, the maps are consulted only for reroutes
    rin, rout = {}, {}
    parsed = []
    for lk in links[:6000]:
        if isinstance(lk, dict):
            oid = lk.get("origin_id")
            oslot = lk.get("origin_slot")
            tid = lk.get("target_id")
            tslot = lk.get("target_slot")
        elif isinstance(lk, (list, tuple)) and len(lk) >= 5:
            oid, oslot, tid, tslot = lk[1], lk[2], lk[3], lk[4]
        else:
            continue
        parsed.append((oid, oslot, tid, tslot))
        if tid in reroute_ids:
            rin[tid] = (oid, oslot)
        if oid in reroute_ids:
            rout[oid] = (tid, tslot)

    def _walk(endpoint, nxt, slot):
        # follow the chain while the endpoint is a reroute (depth-capped:
        # a cyclic reroute wiring must never hang the scan)
        node_id, node_slot = endpoint, slot
        for _ in range(SIM_REROUTE_DEPTH):
            if node_id not in reroute_ids:
                break
            step = nxt.get(node_id)
            if step is None:
                break
            node_id, node_slot = step
        return node_id, node_slot

    out, resolved = [], set()
    for oid, oslot, tid, tslot in parsed:
        o2, s2 = _walk(oid, rin, oslot)
        t2, s3 = _walk(tid, rout, tslot)
        key = "%s|%s>%s|%s" % (id2type.get(o2, "?"), s2,
                               id2type.get(t2, "?"), s3)
        if oid in reroute_ids or tid in reroute_ids:
            # the whole chain A -> R... -> B collapses to ONE semantic edge:
            # every link of the chain resolves to the same pair, so the
            # reroute-touched links dedupe (a reroute fan-out must not
            # inflate the multiset); the untouched links keep their counts
            resolved.add(key)
        else:
            out.append(key)
    out.extend(sorted(resolved))
    out.sort()
    return out


def _norm_widget_value(v):
    """Scalar normalization for the widget signature: floats that are whole
compare equal to ints (0.9 vs 1 - ComfyUI round-trips), everything else
passes through; a value that is not JSON-serializable degrades to str."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        f = float(v)
        return int(f) if f.is_integer() else round(f, 6)
    if isinstance(v, str):
        return v
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return str(v)[:80]


def _extract_widgets(wf):
    """The per-node widget signature (v117): a sorted list of
    {"t": node_type, "w": [values...]} records. Volatile keys (seed /
    control_after_generate) are masked in the named-widget dict form; the
    positional list form keeps the raw scalars (the SCORE weakens numeric
    mismatches instead - a masked seed would also hide real config). Bounded
    to 400 nodes. v119: the wiring/annotation noise nodes (Reroute/Note)
    never contribute a record - a reroute carries no widgets, and a note's
    free text must not lower the similarity."""
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    out = []
    for n in nodes[:400]:
        if not isinstance(n, dict):
            continue
        t = str(n.get("type") or "?")
        if _is_sim_noise_type(t):
            continue
        wv = n.get("widgets_values")
        if isinstance(wv, dict):
            vals = [[str(k), "<v>" if str(k).lower() in SIM_VOLATILE_KEYS
                     else _norm_widget_value(v)]
                    for k, v in sorted(wv.items(), key=lambda kv: str(kv[0]))]
        elif isinstance(wv, (list, tuple)):
            vals = [_norm_widget_value(v) for v in wv[:60]]
        else:
            if wv is None:
                continue
            vals = [_norm_widget_value(wv)]
        out.append({"t": t, "w": vals})
    out.sort(key=lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False))
    return out


def _node_type_multiset(wf):
    """The node types WITH duplicates (the plan: a multiset, not a unique
    list) - sorted, capped. The sig_types_hash bucket key hashes this.
    v119: the wiring/annotation noise (Reroute/Note/MarkdownNote) is
    dropped - a reroute or a note added on the canvas never changes the
    bucket key."""
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    types = sorted(str(n.get("type") or "?") for n in nodes
                   if isinstance(n, dict)
                   and not _is_sim_noise_type(n.get("type")))
    return types[:4000]


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
        "sig_graph_hash": None,
        "sig_types_hash": None,
        "sig_edges": None,
        "sig_widgets": None,
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
    # v117: the similarity signatures (nprof2) - the ID-INDEPENDENT graph
    # hash, the node-type multiset bucket key and the bounded edge/widget
    # features the score reads straight from SQLite (never a file re-read)
    sigdoc = _sig_graph_doc(wf)
    sc = _canon_json(sigdoc)
    rec["sig_graph_hash"] = _sha256(sc.encode("utf-8")) if sc else None
    ms = _node_type_multiset(wf)
    mc = _canon_json(ms)
    rec["sig_types_hash"] = _sha256(mc.encode("utf-8")) if mc else None
    edges = _extract_edges(wf)
    rec["sig_edges"] = _canon_json(edges) if edges else None
    widgets = _extract_widgets(wf)
    rec["sig_widgets"] = _canon_json(widgets) if widgets else None
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


def _is_busy_error(e):
    """v118: 'database is locked' / 'database is busy' - a TRANSIENT
    contention state (a scan's open write txn, another process), NOT
    corruption. Treating it as corruption quarantined LIVE indexes (the
    v118 report: enabling Groups during a scan renamed the whole index db
    to .corrupt-* and answered 'database is locked')."""
    if isinstance(e, sqlite3.OperationalError):
        s = str(e).lower()
        return "locked" in s or "busy" in s
    return False


def init_db(db=None):
    """Create/migrate the schema. Returns (db_path, fts: bool). A corrupt
    DB is quarantined (renamed, never deleted - the owner inspects it) and
    a fresh one is built; the user's JSON files are untouched. A BUSY db
    (a concurrent writer, e.g. the scan's write txn) NEVER quarantines -
    the schema is presumed present (every writer init_db's before its
    txn); the caller's own statement answers the busy state through its
    own error path and the next call finishes the probe."""
    db = db or _db_path()
    with _db_lock:
        os.makedirs(os.path.dirname(db), exist_ok=True)
        conn = None
        try:
            conn = _connect(db)
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            _ensure_schema(conn)
            conn.commit()
            conn.close()
            _init_done.add(os.path.normpath(db))
            return db, _fts_flag(db)
        except sqlite3.DatabaseError as e:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.DatabaseError:
                    pass
            if _is_busy_error(e):
                return db, False   # transient - the data stays untouched
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
            _init_done.discard(os.path.normpath(db))
            conn = _connect(db)
            try:
                _ensure_schema(conn)
                conn.commit()
            except sqlite3.DatabaseError as e2:
                try:
                    conn.close()
                except sqlite3.DatabaseError:
                    pass
                if _is_busy_error(e2):
                    return db, False   # still contended - retry next call
                raise
            conn.close()
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
    # v116 (plan 4.6): the NOTES index - process + revision annotations live
    # in ONE small table mirrored into FTS when FTS5 exists. The search must
    # find a note WITHOUT reading any Git blob (plan 4.6); the rows are
    # maintained by the history module's mutation hooks and rebuildable from
    # the manifests alone (notes_rebuild).
    c.execute("CREATE TABLE IF NOT EXISTS history_notes ("
              "kind TEXT NOT NULL,"        # 'process' | 'revision'
              "pid TEXT NOT NULL,"
              "rid TEXT NOT NULL,"         # '' for a process note
              "title TEXT, note TEXT, updated_at INTEGER,"
              "PRIMARY KEY (kind, pid, rid))")
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
              "sig_graph_hash TEXT, sig_types_hash TEXT,"
              "sig_edges TEXT, sig_widgets TEXT,"
              "normalization_profile_version TEXT,"
              "extra_summary TEXT, node_count INTEGER,"
              "node_types TEXT, node_titles TEXT, model_refs TEXT,"
              "search_text TEXT,"
              "parse_status TEXT, parse_error TEXT,"
              "indexed_at INTEGER,"
              "PRIMARY KEY (user_scope, root_key, rel_path))")
    # v117: the nprof2 similarity signature columns - an OLD DB (schema 1)
    # gains them through the guarded ALTER TABLE pass below (CREATE with the
    # new columns covers only the fresh databases)
    have = {r[1] for r in conn.execute(
        "PRAGMA table_info(workflow_files)").fetchall()}
    for col in ("sig_graph_hash", "sig_types_hash", "sig_edges",
                "sig_widgets"):
        if col not in have:
            try:
                conn.execute("ALTER TABLE workflow_files ADD COLUMN %s TEXT"
                             % col)
            except sqlite3.DatabaseError:
                pass
    # v117: the similarity RESULT cache (the plan: cache the grouping in
    # SQLite, invalidate on ANY re-index or profile change). The key carries
    # (scope, threshold, profile, row_sig) where row_sig is the count +
    # max(indexed_at) of the scope - any scan pass that (re)writes a row
    # changes the signature and the stale entries simply stop being read.
    c.execute("CREATE TABLE IF NOT EXISTS similarity_cache ("
              "cache_key TEXT PRIMARY KEY, kind_filter TEXT,"
              "payload TEXT, created_at INTEGER)")
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

def _scan_roots(workflows_user_dirs, hide_dirs_fn, extra_roots=None):
    """[(root_key, dir, hide_set, rel_prefix)] - the walks the caller
    (workflows_store) already trusts. root_key distinguishes the per-user
    roots. v124: rel_prefix ('' for the ordinary roots) lets a root index
    its files under ANOTHER rel_path namespace - the EXTERNAL folders index
    under 'workflows/.settings_hub_ext/<id>/' so the whole manager speaks
    one path shape. extra_roots entries are 4-tuples already."""
    out = []
    for i, d in enumerate(workflows_user_dirs or []):
        out.append(("root%d" % i, d, set(hide_dirs_fn(d)), ""))
    for entry in (extra_roots or []):
        try:
            rk, dd, hides, prefix = entry
            out.append((rk, dd, set(hides or ()), prefix or ""))
        except Exception:
            continue  # a malformed root entry is skipped, never fatal
    return out


def scan_index(db=None, workflows_user_dirs=None, hide_dirs_fn=None,
               user_scope="default", force=False, progress=None,
               extra_roots=None):
    """ONE incremental pass over the library. Returns a stats dict.
    Runs in a WORKER THREAD (the caller wraps it in asyncio.to_thread) -
    the event loop never blocks (plan 4.4).

    v116 (plan 3.1): the pass is HONEST about its completeness. A walk that
    hit the file bound (truncated) or swallowed directory errors leaves the
    index INCOMPLETE: the vanished-row prune is skipped entirely (plan:
    'unverified rows are never deleted' - a truncated walk must not be able
    to erase the tail of a big library), the stats carry
    prune_skipped/walk_errors/complete and the meta table remembers
    last_scan_complete so index_status can answer 'is the index actually
    current?' without re-walking anything."""
    db = db or _db_path()
    # v116 (plan 3.2): JOIN semantics - a second scan request waits for the
    # running one (up to SCAN_JOIN_TIMEOUT_S) instead of answering
    # "a scan is already running"; the waiter then performs its own pass
    # (cheap: the fresh rows skip via the same mtime signature).
    if not _scan_lock.acquire(blocking=True, timeout=SCAN_JOIN_TIMEOUT_S):
        return {"ok": False, "error": "a scan is already running",
                "busy": True,
                "scanned": 0, "indexed": 0, "changed": 0, "errors": 0,
                "removed": 0, "skipped_same": 0, "too_large": 0,
                "non_json": 0}
    try:
        with _db_lock:
            init_db(db)
        stats = {"ok": True, "scanned": 0, "indexed": 0, "changed": 0,
                 "errors": 0, "removed": 0, "skipped_same": 0,
                 "too_large": 0, "truncated": False,
                 "prune_skipped": False, "walk_errors": 0,
                 "complete": True,
                 # v121: the non-.json files the walk SAW are counted (never
                 # indexed - the endswith(".json") filter is correct and
                 # stays). The count surfaces next to the indexed total so
                 # 'the walk saw them, the index skips them' is visible
                 # instead of the files silently disappearing into the
                 # surface (the owner's '.py in the listing' report).
                 "non_json": 0,
                 "db": db, "fts": _fts_enabled(db),
                 "profile": NORMALIZATION_PROFILE_VERSION}
        seen_keys = set()
        MAX_WALK = _walk_limit()

        def _walk_err(_err):
            # plan 3.1: a directory whose listing failed is NOT proof that
            # its files are gone - the pass may not claim completeness
            stats["walk_errors"] += 1

        conn = _connect(db)
        try:
            fts = _ensure_fts(conn)
            for root_key, root_dir, hides, rel_prefix in _scan_roots(
                    workflows_user_dirs, hide_dirs_fn, extra_roots):
                # v124: the external-folder roots carry a rel prefix - the
                # rows land under workflows/.settings_hub_ext/<id>/<rel>
                # (the folder_prefix strips the 'workflows/' part for the
                # `folder` column, the same relative-to-workflows-root
                # convention the ordinary roots keep)
                folder_prefix = rel_prefix[len("workflows/"):] \
                    if rel_prefix.startswith("workflows/") else rel_prefix
                for dirpath, dirnames, filenames in os.walk(root_dir,
                                                            onerror=_walk_err):
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
                            stats["non_json"] += 1
                            continue
                        full = os.path.join(dirpath, fn)
                        rel = os.path.relpath(full, root_dir).replace(os.sep, "/")
                        if rel_prefix:
                            # v124: the EXTERNAL namespace - the key and the
                            # folder column carry the virtual prefix
                            key = (user_scope, root_key,
                                   rel_prefix + rel)
                            folder_col = folder_prefix + rel.rsplit("/", 1)[0] \
                                if "/" in rel else folder_prefix.rstrip("/")
                        else:
                            key = (user_scope, root_key, "workflows/" + rel)
                            folder_col = rel.rsplit("/", 1)[0] if "/" in rel else ""
                        seen_keys.add(key)
                        stats["scanned"] += 1
                        if stats["scanned"] > MAX_WALK:
                            stats["truncated"] = True
                            stats["complete"] = False
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
                        # v124: the search text carries the VIRTUAL rel (the
                        # folder segments are searchable for the ext rows
                        # exactly like for the ordinary ones)
                        search_rel = key[2][len("workflows/"):] \
                            if key[2].startswith("workflows/") else key[2]
                        # v112: the FINAL search text is computed ONCE and used
                        # for BOTH the row and the FTS mirror - a divergence
                        # would leave the token index empty for the row
                        final_search = ((search_rel + " " + fn + " " + rec["search_text"])
                                        if rec["search_text"] else (search_rel + " " + fn))
                        with _db_lock:
                            conn.execute(
                                "INSERT OR REPLACE INTO workflow_files "
                                "(user_scope, root_key, rel_path, name, folder,"
                                " size_bytes, mtime_ns, inode, mtime_sec,"
                                " workflow_id, raw_hash, canonical_hash,"
                                " workflow_hash, presentation_hash,"
                                " extension_hash, structural_hash,"
                                " sig_graph_hash, sig_types_hash, sig_edges,"
                                " sig_widgets,"
                                " normalization_profile_version, extra_summary,"
                                " node_count, node_types, node_titles,"
                                " model_refs, search_text, parse_status,"
                                " parse_error, indexed_at)"
                                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (user_scope, root_key, key[2], fn,
                                 folder_col,
                                 sig[0], sig[1], sig[2], mtime_sec,
                                 rec["workflow_id"], rec["raw_hash"],
                                 rec["canonical_hash"], rec["workflow_hash"],
                                 rec["presentation_hash"], rec["extension_hash"],
                                 rec["structural_hash"],
                                 rec["sig_graph_hash"], rec["sig_types_hash"],
                                 rec["sig_edges"], rec["sig_widgets"],
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
                            # v118: commit PER FILE - the scan's write txn must
                            # never span the whole pass. A minutes-long open
                            # txn made every concurrent writer (the groups
                            # cache, the notes, the status) wait out
                            # busy_timeout and die 'database is locked'.
                            # WAL + synchronous=NORMAL keeps a per-file
                            # commit cheap (no fsync per commit).
                            conn.commit()
                        if progress and stats["scanned"] % 200 == 0:
                            progress(stats)
                    if stats["truncated"]:
                        break
            # v116 (plan 3.1): prune the rows whose files vanished ONLY when
            # the walk was complete AND error-free. A truncated pass (or one
            # with unreadable directories) has NOT verified the whole library
            # - deleting the unverified rows could erase the tail of a big
            # library or drop rows behind a transiently unreadable folder.
            if stats["walk_errors"]:
                stats["complete"] = False
            if stats["truncated"] or stats["walk_errors"]:
                stats["prune_skipped"] = True
            else:
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
            # v116: the completeness flag is durable - the next index_status
            # answers 'is the index actually current?' without a re-walk.
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    ("last_scan_complete", "1" if stats["complete"] else "0"))
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    ("last_scan_scope", user_scope))
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    ("last_scan_non_json", str(stats["non_json"])))
            except sqlite3.DatabaseError:
                pass
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


def refresh_paths(db=None, user_scope="default", root_dirs=None,
                   rel_paths=(), path_map=None):
    """v116 (plan 3.2): the POINT re-index of specific library paths - the
    route layer calls this after a Restore/Checkpoint touched one file, so
    the answer of the next query carries the fresh hashes without waiting
    for the next full scan. A path that no longer exists under ANY root has
    its row dropped (the same contract the scan prune follows). The
    root_key follows the first root that contains the file - the same
    first-root-wins precedence the walk and the Files listing use.

    v124: path_map ({rel_path: real_path}) resolves the virtual EXTERNAL
    namespace directly - the ordinary root join cannot reach outside the
    userdata tree. A mapped path whose real file is gone drops its row (the
    same removal contract)."""
    paths = [p for p in (rel_paths or ()) if isinstance(p, str) and p]
    if not paths:
        return {"ok": True, "updated": 0, "removed": 0}
    db = db or _db_path()
    pmap = path_map or {}
    if _scan_lock.acquire(blocking=True, timeout=10):
        try:
            with _db_lock:
                init_db(db)
            fts = _fts_enabled(db)
            updated = removed = 0
            with _db_lock:
                conn = _connect(db)
                try:
                    for rel in sorted(set(paths)):
                        rec = sig = mtime_sec = None
                        found = None
                        if rel in pmap:
                            full = pmap.get(rel)
                            if isinstance(full, str) and full and \
                                    os.path.isfile(full):
                                # v124: the EXTERNAL rows keep the ext_ root
                                # key family (the same convention the scan
                                # uses for the prefixed roots)
                                found = ("ext_mapped", full)
                        else:
                            for i, wroot in enumerate(root_dirs or []):
                                sub = rel[len("workflows/"):] \
                                    if rel.startswith("workflows/") else rel
                                cand = os.path.normpath(os.path.join(wroot, sub))
                                if not os.path.isfile(cand):
                                    continue
                                found = ("root%d" % i, cand)
                                break
                        if not found:
                            rows = conn.execute(
                                "SELECT rowid FROM workflow_files WHERE "
                                "user_scope=? AND rel_path=?",
                                (user_scope, rel)).fetchall()
                            for (rowid,) in rows:
                                conn.execute("DELETE FROM workflow_files "
                                             "WHERE rowid=?", (rowid,))
                                if fts:
                                    conn.execute("DELETE FROM workflow_fts "
                                                 "WHERE rowid=?", (rowid,))
                                removed += 1
                            continue
                        root_key, full = found
                        try:
                            st = os.stat(full)
                            with open(full, "rb") as fh:
                                raw = fh.read()
                        except OSError:
                            continue   # transient - not a confirmed removal
                        rec, _err = analyze_workflow_bytes(raw)
                        sig = (st.st_size, st.st_mtime_ns,
                               getattr(st, "st_ino", 0))
                        mtime_sec = int(st.st_mtime)
                        fn = rel.rsplit("/", 1)[-1]
                        rel_dir = rel[len("workflows/"):]
                        folder = (rel_dir.rsplit("/", 1)[0]
                                  if "/" in rel_dir else "")
                        final_search = ((rel + " " + fn + " " + rec["search_text"])
                                        if rec["search_text"] else (rel + " " + fn))
                        conn.execute(
                            "INSERT OR REPLACE INTO workflow_files "
                            "(user_scope, root_key, rel_path, name, folder,"
                            " size_bytes, mtime_ns, inode, mtime_sec,"
                            " workflow_id, raw_hash, canonical_hash,"
                            " workflow_hash, presentation_hash,"
                            " extension_hash, structural_hash,"
                            " sig_graph_hash, sig_types_hash, sig_edges,"
                            " sig_widgets,"
                            " normalization_profile_version, extra_summary,"
                            " node_count, node_types, node_titles,"
                            " model_refs, search_text, parse_status,"
                            " parse_error, indexed_at)"
                            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (user_scope, root_key, rel, fn, folder,
                             sig[0], sig[1], sig[2], mtime_sec,
                             rec["workflow_id"], rec["raw_hash"],
                             rec["canonical_hash"], rec["workflow_hash"],
                             rec["presentation_hash"], rec["extension_hash"],
                             rec["structural_hash"],
                             rec["sig_graph_hash"], rec["sig_types_hash"],
                             rec["sig_edges"], rec["sig_widgets"],
                             NORMALIZATION_PROFILE_VERSION,
                             json.dumps(rec["extra_summary"], ensure_ascii=False),
                             rec["node_count"],
                             json.dumps(rec["node_types"], ensure_ascii=False),
                             json.dumps(rec["node_titles"], ensure_ascii=False),
                             json.dumps(rec["model_refs"], ensure_ascii=False),
                             final_search, rec["parse_status"],
                             rec["parse_error"], int(time.time())))
                        if fts:
                            rowid = conn.execute(
                                "SELECT rowid FROM workflow_files WHERE "
                                "user_scope=? AND rel_path=?",
                                (user_scope, rel)).fetchone()
                            if rowid:
                                _fts_sync(conn, rowid[0], final_search)
                        updated += 1
                    conn.commit()
                finally:
                    conn.close()
            return {"ok": True, "updated": updated, "removed": removed}
        except sqlite3.DatabaseError as e:
            return {"ok": False, "error": str(e)[:MAX_ERROR_CHARS],
                    "updated": 0, "removed": 0}
        finally:
            _scan_lock.release()
    return {"ok": True, "updated": 0, "removed": 0, "busy": True}


# ---------------------------------------------------------------------------
# v116 (plan 4.6): the NOTES search index. Process notes, revision titles
# and revision notes live in ONE small SQLite table (history_notes) mirrored
# into FTS when FTS5 exists - the search NEVER reads a Git blob. The history
# module's mutation hooks keep it fresh; notes_rebuild restores it from the
# manifests alone (a dropped/corrupt table self-heals on the next search).
# ---------------------------------------------------------------------------

_NOTES_BUILT_KEY = "notes_built_v1"


def _notes_ensure_schema(conn):
    _ensure_schema(conn)
    row = conn.execute("SELECT count(*) FROM sqlite_master WHERE type='table' "
                       "AND name='history_notes'").fetchone()
    if not row or not row[0]:
        _ensure_schema(conn)
    if _fts_available(conn):
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS history_notes_fts "
                     "USING fts5(text, kind UNINDEXED, pid UNINDEXED, "
                     "rid UNINDEXED)")


def notes_upsert(kind, pid, rid, title=None, note=None, updated_at=None):
    """Index ONE note (kind 'process' with rid='' or 'revision'). Best
    effort: a broken index must never break a checkpoint (the notes search
    answers 'no results' until the next rebuild)."""
    if not isinstance(pid, str) or not pid:
        return False
    kind = "revision" if kind == "revision" else "process"
    rid = rid if isinstance(rid, str) else ""
    db = _db_path()
    if not os.path.isfile(db):
        return False
    try:
        with _db_lock:
            conn = _connect(db)
            try:
                _notes_ensure_schema(conn)
                conn.execute(
                    "INSERT OR REPLACE INTO history_notes "
                    "(kind, pid, rid, title, note, updated_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (kind, pid, rid,
                     (title or None) if isinstance(title, str) else None,
                     (note or None) if isinstance(note, str) else None,
                     int(updated_at or time.time())))
                if _fts_available(conn):
                    text = " ".join(x for x in (title, note) if x)
                    conn.execute("DELETE FROM history_notes_fts WHERE pid=? "
                                 "AND rid=? AND kind=?", (pid, rid, kind))
                    conn.execute("INSERT INTO history_notes_fts "
                                 "(text, kind, pid, rid) VALUES (?,?,?,?)",
                                 (text or "", kind, pid, rid))
                conn.commit()
            finally:
                conn.close()
        return True
    except sqlite3.DatabaseError:
        return False


def notes_drop(pid=None, kind=None, rid=None):
    """Drop note rows (all of a process, or one kind/rid)."""
    if pid is not None and not isinstance(pid, str):
        return False
    db = _db_path()
    if not os.path.isfile(db):
        return False
    try:
        with _db_lock:
            conn = _connect(db)
            try:
                _notes_ensure_schema(conn)
                where, args = ["1=1"], []
                if pid is not None:
                    where.append("pid=?")
                    args.append(pid)
                if kind:
                    where.append("kind=?")
                    args.append("revision" if kind == "revision" else "process")
                if rid is not None:
                    where.append("rid=?")
                    args.append(rid)
                conn.execute("DELETE FROM history_notes WHERE " +
                             " AND ".join(where), args)
                if _fts_available(conn):
                    fwhere, fargs = [], []
                    if pid is not None:
                        fwhere.append("pid=?")
                        fargs.append(pid)
                    if kind:
                        fwhere.append("kind=?")
                        fargs.append("revision" if kind == "revision"
                                     else "process")
                    if rid is not None:
                        fwhere.append("rid=?")
                        fargs.append(rid)
                    if fwhere:
                        conn.execute("DELETE FROM history_notes_fts WHERE " +
                                     " AND ".join(fwhere), fargs)
                conn.commit()
            finally:
                conn.close()
        return True
    except sqlite3.DatabaseError:
        return False


def notes_rebuild(processes, revisions):
    """Restore the notes index from the manifests ALONE (plan 4.6). The
    caller passes the manifest dicts it already read (the history module
    owns them) - one write per row, idempotent."""
    n = 0
    for p in (processes or []):
        if not isinstance(p, dict):
            continue
        pid = p.get("processId")
        if isinstance(pid, str) and (p.get("note") or p.get("displayName")):
            notes_upsert("process", pid, "", p.get("displayName"),
                         p.get("note"), p.get("updatedAt"))
            n += 1
    for r in (revisions or []):
        if not isinstance(r, dict):
            continue
        pid = r.get("processId")
        rid = r.get("revisionId")
        if isinstance(pid, str) and isinstance(rid, str) and \
                (r.get("note") or r.get("title")):
            notes_upsert("revision", pid, rid, r.get("title"), r.get("note"),
                         r.get("createdAt"))
            n += 1
    return n


def search_notes(db=None, q=None, limit=40):
    """The notes search (plan 4.6): process + revision annotations matching
    a free-text query. FTS when available, a tested LIKE fallback otherwise.
    Returns [{kind, processId, revisionId, title, note}]."""
    db = db or _db_path()
    out = {"ok": True, "results": [], "fts": False}
    q = str(q or "").strip()
    if not q:
        return out
    limit = max(1, min(int(limit or 40), 100))
    try:
        with _db_lock:
            init_db(db)
            conn = _connect(db)
            try:
                _notes_ensure_schema(conn)
                fts = _fts_available(conn)
                out["fts"] = fts
                if fts:
                    fts_q = " ".join('\"%s\"*' % t.replace('"', "")
                                     for t in q.split()[:8])
                    rows = conn.execute(
                        "SELECT kind, pid, rid FROM history_notes_fts "
                        "WHERE history_notes_fts MATCH ? LIMIT ?",
                        (fts_q, limit)).fetchall()
                    for kind, pid, rid in rows:
                        r2 = conn.execute(
                            "SELECT title, note FROM history_notes WHERE "
                            "kind=? AND pid=? AND rid=?",
                            (kind, pid, rid)).fetchone()
                        if r2:
                            out["results"].append({
                                "kind": kind, "processId": pid,
                                "revisionId": rid or None,
                                "title": r2[0], "note": r2[1]})
                else:
                    toks = [t.replace("%", "").replace("_", " ")
                            for t in q.split()[:8]]
                    where = ["(" + " AND ".join(
                        "(title LIKE ? OR note LIKE ?)" for _ in toks) + ")"]
                    args = []
                    for t in toks:
                        args.extend(["%" + t + "%", "%" + t + "%"])
                    rows = conn.execute(
                        "SELECT kind, pid, rid, title, note FROM "
                        "history_notes WHERE " + where[0] +
                        " LIMIT ?", args + [limit]).fetchall()
                    for kind, pid, rid, title, note in rows:
                        out["results"].append({
                            "kind": kind, "processId": pid,
                            "revisionId": rid or None,
                            "title": title, "note": note})
                conn.commit()
            finally:
                conn.close()
    except sqlite3.OperationalError as e:
        # v118: a locked db is TRANSIENT (a scan's write txn) - the answer
        # says busy so the client retries on a timer instead of a dead end
        if _is_busy_error(e):
            out["ok"] = False
            out["busy"] = True
            out["error"] = str(e)[:MAX_ERROR_CHARS]
            return out
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    except sqlite3.DatabaseError as e:
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    return out


def index_status(db=None, user_scope="default"):
    """The stats for the UI: how many files are indexed, the last scan, the
    profile, whether FTS is live. Cheap - never walks the filesystem.
    v116 (plan 3.1/4.7): the answer also says whether the LAST scan was
    COMPLETE (lastScanComplete / complete / truncated) - a truncated index
    must never pose as a full one (the UI shows 'incomplete - rebuild')."""
    db = db or _db_path()
    out = {"ok": True, "db_exists": os.path.isfile(db), "files": 0,
           "errors": 0, "too_large": 0, "last_scan": 0,
           "profile": NORMALIZATION_PROFILE_VERSION,
           "schema_version": SCHEMA_VERSION, "fts": False,
           "db_bytes": 0, "complete": True, "lastScanComplete": None,
           "truncated": False, "non_json": 0}
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
                mrow = conn.execute(
                    "SELECT key, value FROM meta WHERE key IN "
                    "('last_scan_complete', 'last_scan_scope', "
                    "'last_scan_non_json')").fetchall()
                md = {k: v for k, v in (mrow or [])}
                if "last_scan_complete" in md:
                    out["lastScanComplete"] = md["last_scan_complete"] == "1"
                    out["complete"] = out["lastScanComplete"]
                    out["truncated"] = not out["complete"]
                # v121: the walk's non-.json counter travels with the scan
                # scope - a counter from ANOTHER scope's walk means nothing
                # for this one (the same guard the completeness flag uses)
                if "last_scan_non_json" in md:
                    try:
                        out["non_json"] = int(md["last_scan_non_json"] or 0)
                    except (TypeError, ValueError):
                        out["non_json"] = 0
                if "last_scan_scope" in md and md["last_scan_scope"] != user_scope:
                    # the flag belongs to ANOTHER scope - this scope's rows
                    # may be older than the last complete pass
                    out["complete"] = False
                    # v121: the non-.json counter belongs to THAT walk too
                    out["non_json"] = 0
                conn.commit()
            finally:
                conn.close()
    except sqlite3.OperationalError as e:
        # v118: a locked db is TRANSIENT - answer busy:true, never a dead end
        if _is_busy_error(e):
            out["ok"] = False
            out["busy"] = True
            out["error"] = str(e)[:MAX_ERROR_CHARS]
            return out
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
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
    except sqlite3.OperationalError as e:
        # v118: a locked db is TRANSIENT - answer busy:true (the client
        # retries on a timer); the empty page shape stays intact
        if _is_busy_error(e):
            return {"files": [], "total": 0, "has_more": False,
                    "next_cursor": None, "busy": True,
                    "error": str(e)[:MAX_ERROR_CHARS]}
        return {"files": [], "total": 0, "has_more": False,
                "next_cursor": None, "error": str(e)[:MAX_ERROR_CHARS]}
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
                # v116 (plan 9.2): the STRUCTURAL candidates - the same node
                # class set, but everything else differs. Candidates ONLY:
                # the UI must never present them as duplicates and nothing
                # ever merges/links by similarity automatically.
                structural = groups("structural_hash")
                # structural candidates = structural groups whose members are
                # NOT all the same workflow (a real duplicate group would
                # make the candidate row noise); the plain list is enough -
                # the client labels them 'candidates only'
                real_structural = []
                for h in structural:
                    row = conn.execute(
                        "SELECT count(DISTINCT workflow_hash) FROM "
                        "workflow_files WHERE user_scope=? AND "
                        "structural_hash=?", (user_scope, h)).fetchone()
                    if row and row[0] > 1:
                        real_structural.append(h)
                out.update({
                    "exactCopies": exact,
                    "sameJsonContent": same_json,
                    "sameWorkflowDiffCanvas": same_wf_diff_canvas,
                    "sameUuidDiffContent": same_id_diff_content,
                    "structuralCandidates": real_structural,
                    "noUuidCount": int(no_uuid or 0),
                })
            finally:
                conn.close()
    except sqlite3.OperationalError as e:
        # v118: a locked db is TRANSIENT (a scan's write txn) - answer busy
        if _is_busy_error(e):
            out["ok"] = False
            out["busy"] = True
            out["error"] = str(e)[:MAX_ERROR_CHARS]
            return out
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    except sqlite3.DatabaseError as e:
        out["ok"] = False
        out["error"] = str(e)[:MAX_ERROR_CHARS]
    return out


# ---------------------------------------------------------------------------
# v117: SIMILARITY GROUPS (the owner's Files-grouping plan). A deterministic,
# versioned estimate - never an identity proof, never an automatic merge.
# The features come straight from the sig_* columns the scan maintains, the
# detailed score runs for CANDIDATE pairs only and the result is cached in
# similarity_cache (invalidated by any re-index or profile change).
# ---------------------------------------------------------------------------

def _multiset_jaccard(a, b):
    """Multiset Jaccard: sum(min) / sum(max) over counted keys (the plan:
    a node-type MULTISET, not a unique list). Two EMPTY multisets are
    neutral-identical (1.0) - the feature can only lower the score when it
    actually disagrees."""
    if not a and not b:
        return 1.0
    ca, cb = {}, {}
    for x in a:
        ca[x] = ca.get(x, 0) + 1
    for x in b:
        cb[x] = cb.get(x, 0) + 1
    inter = sum(min(n, cb.get(k, 0)) for k, n in ca.items())
    union = sum(max(ca.get(k, 0), cb.get(k, 0)) for k in set(ca) | set(cb))
    return inter / union if union else 1.0


def _counter_jaccard(ca, cb):
    """The prefilter form of _multiset_jaccard over PRECOMPUTED counters
    (v119: the candidate scan runs it thousands of times - it must never
    rebuild the counters). Same semantics: two EMPTY counters are
    neutral-identical (1.0)."""
    if not ca and not cb:
        return 1.0
    if len(cb) < len(ca):
        ca, cb = cb, ca
    inter = 0
    union = 0
    for k, n in ca.items():
        m = cb.get(k, 0)
        inter += n if n < m else m
        union += n if n > m else m
    for k, n in cb.items():
        if k not in ca:
            union += n
    return inter / union if union else 1.0


def _counter_pair_parts(ca, cb):
    """v120: (jaccard, overlap) over PRECOMPUTED counters in ONE pass.
    overlap = sum(min) / min(total_a, total_b) - the containment form that
    stays 1.0 when one graph is a strict SUPERSET of the other (the owner's
    'a node group added' case: a jaccard punishes the added nodes, the
    overlap does not). Both empty -> neutral (1.0, 1.0); exactly one empty
    -> (0.0, 0.0)."""
    if not ca and not cb:
        return 1.0, 1.0
    if len(cb) < len(ca):
        ca, cb = cb, ca
    inter = 0
    union = 0
    sa = 0
    for k, n in ca.items():
        m = cb.get(k, 0)
        inter += n if n < m else m
        union += n if n > m else m
        sa += n
    sb = 0
    for k, n in cb.items():
        if k not in ca:
            union += n
        sb += n
    return (inter / union if union else 1.0,
            inter / min(sa, sb) if min(sa, sb) else 0.0)


def _counter_pair_score(ca, cb):
    """v120: the blended types/edges sub-score over PRECOMPUTED counters:
    (jaccard + overlap) / 2. The blend keeps the jaccard's rewire-punishing
    (a switched link still costs) while the overlap half makes an ADDED or
    REMOVED node group nearly free (inter/min does not shrink when only one
    side grows). The zero-false-negative prefilter bound in
    similarity_groups uses exactly this number."""
    j, o = _counter_pair_parts(ca, cb)
    return (j + o) / 2.0


def _multiset_pair_score(a, b):
    """v120: the blended (jaccard + overlap) / 2 over raw feature lists -
    the score-form of _counter_pair_score (the counters are rebuilt here;
    the hot candidate scan uses the counter forms directly)."""
    if not a and not b:
        return 1.0
    ca, cb = {}, {}
    for x in a:
        ca[x] = ca.get(x, 0) + 1
    for x in b:
        cb[x] = cb.get(x, 0) + 1
    return _counter_pair_score(ca, cb)


def _widget_node_score(wa, wb):
    """One aligned node pair: the positional widget compare. Numeric
    mismatches are SOFTENED (SIM_NUMERIC_PENALTY) - two runs of one pipeline
    differ by seed/steps only; volatile keys were already masked at scan
    time in the named-dict form. A length difference dilutes the score."""
    if not wa and not wb:
        return 1.0
    n = min(len(wa), len(wb))
    eq = 0.0
    for i in range(n):
        va, vb = wa[i], wb[i]
        if va == vb:
            eq += 1.0
        elif (isinstance(va, (int, float)) and not isinstance(va, bool)
              and isinstance(vb, (int, float)) and not isinstance(vb, bool)):
            eq += SIM_NUMERIC_PENALTY
    return eq / max(len(wa), len(wb))


def _widgets_similarity(recs_a, recs_b):
    """Align the per-node widget records BY TYPE (never by node id). v119:
    the pairs within one type bucket match by a greedy BEST-PAIR search
    instead of the sorted positional compare - one changed value reordered
    the sorted bucket and mismatched ALL its peers; the greedy keeps every
    unchanged node matched with itself. A value mismatch is SOFTENED
    (numeric), volatile keys were masked at scan time, unmatched nodes
    cost fully. Both empty -> neutral 1.0. Deterministic: the records
    iterate in their stored (sorted) order, ties keep the earliest
    partner."""
    if not recs_a and not recs_b:
        return 1.0
    bya, byb = {}, {}
    for r in recs_a:
        bya.setdefault(r["t"], []).append(r["w"])
    for r in recs_b:
        byb.setdefault(r["t"], []).append(r["w"])
    total, score = 0, 0.0
    for t in set(bya) | set(byb):
        la, lb = bya.get(t, []), byb.get(t, [])
        if not la or not lb:
            total += max(len(la), len(lb))   # unmatched nodes cost fully
            continue
        if len(la) <= 8 and len(lb) <= 8:
            # the greedy best-pair matching (the buckets are small - a
            # type repeats a handful of times even in a big graph); an
            # unmatched record costs FULLY (score 0), never a negative
            used = [False] * len(lb)
            for wa in la:
                best_i, best_s = -1, 0.0
                for j, wb in enumerate(lb):
                    if used[j]:
                        continue
                    s = _widget_node_score(wa, wb)
                    if s > best_s:
                        best_s, best_i = s, j
                if best_i >= 0:
                    used[best_i] = True
                score += best_s
                total += 1
            total += max(0, len(lb) - len(la))   # the unused partners cost
        else:
            # a pathologically wide bucket keeps the cheap sorted compare
            la2 = sorted(la, key=lambda w: json.dumps(w, sort_keys=True,
                                                      ensure_ascii=False))
            lb2 = sorted(lb, key=lambda w: json.dumps(w, sort_keys=True,
                                                      ensure_ascii=False))
            m = min(len(la2), len(lb2))
            for i in range(m):
                score += _widget_node_score(la2[i], lb2[i])
                total += 1
            total += abs(len(la2) - len(lb2))
    return score / total if total else 1.0


def similarity_score(fa, fb):
    """The deterministic 0-100 similarity estimate (the plan: structure +
    content, presentation never counts). Weights live in SIM_WEIGHTS and are
    echoed in every answer so the UI can explain the number honestly.
    v119: the wiring/annotation noise (Reroute/Note/MarkdownNote) leaves
    the types and the widget features here too - the hand-built feature
    dicts (the tests) and the scan-extracted ones behave identically.
    v120: the types/edges/models sub-scores are the (jaccard + overlap) / 2
    BLEND - a modified copy that only ADDS or REMOVES a node group keeps a
    high score (the overlap half stays 1.0 on a strict subset/superset)
    while a switched link still costs through the jaccard half."""
    ta = [t for t in (fa.get("types") or [])
          if not _is_sim_noise_type(t)]
    tb = [t for t in (fb.get("types") or [])
          if not _is_sim_noise_type(t)]
    wa = [r for r in (fa.get("widgets") or [])
          if not _is_sim_noise_type(r.get("t"))]
    wb = [r for r in (fb.get("widgets") or [])
          if not _is_sim_noise_type(r.get("t"))]
    s = (SIM_WEIGHTS["types"] * _multiset_pair_score(ta, tb)
         + SIM_WEIGHTS["edges"] * _multiset_pair_score(fa["edges"], fb["edges"])
         + SIM_WEIGHTS["widgets"] * _widgets_similarity(wa, wb)
         + SIM_WEIGHTS["models"] * _multiset_pair_score(fa["models"],
                                                        fb["models"]))
    return int(round(100.0 * s))


_SIM_ROW_SQL = (
    "SELECT rel_path, name, folder, size_bytes, mtime_sec, workflow_id,"
    " raw_hash, canonical_hash, workflow_hash, presentation_hash,"
    " extension_hash, structural_hash, node_count, node_types, model_refs,"
    " sig_graph_hash, sig_types_hash, sig_edges, sig_widgets"
    " FROM workflow_files WHERE user_scope=? AND parse_status='ok'"
    " AND normalization_profile_version=? ORDER BY rel_path")


def _similarity_rows(conn, user_scope):
    """Every current-profile row as (features dict, page-shaped row dict).
    parse-broken/too-large files are skipped (they carry no graph); rows of
    an OLD profile are skipped too - a scan pass re-indexes them. v119: the
    feats carry the noise-filtered types + the per-file type counter for
    the cheap candidate prefilter (the display row keeps the RAW types)."""
    feats, rows = {}, []
    for (rel, name, folder, size_bytes, mtime_sec, wf_id, raw_hash,
         canon_hash, wf_hash, pres_hash, ext_hash, struct_hash, node_count,
         node_types, model_refs, sig_graph, sig_types, sig_edges,
         sig_widgets) in conn.execute(_SIM_ROW_SQL,
                                      (user_scope,
                                       NORMALIZATION_PROFILE_VERSION)).fetchall():
        try:
            edges = json.loads(sig_edges) if sig_edges else []
            widgets = json.loads(sig_widgets) if sig_widgets else []
            types = json.loads(node_types) if node_types else []
            models = json.loads(model_refs) if model_refs else []
        except ValueError:
            continue
        ftypes = [t for t in types if not _is_sim_noise_type(t)]
        tc = {}
        for t in ftypes:
            tc[t] = tc.get(t, 0) + 1
        feats[rel] = {
            "types": ftypes, "n": len(ftypes), "tc": tc,
            "edges": edges, "widgets": widgets,
            "models": models, "sig_graph": sig_graph, "sig_types": sig_types,
        }
        rows.append({
            "path": rel, "name": name, "folder": folder,
            "size": int(size_bytes or 0), "mtime": int(mtime_sec or 0),
            "workflowId": wf_id, "rawHash": raw_hash,
            "canonicalHash": canon_hash, "workflowHash": wf_hash,
            "presentationHash": pres_hash, "extensionHash": ext_hash,
            "structuralHash": struct_hash,
            "nodeCount": int(node_count or 0),
            "nodeTypes": types, "modelRefs": models,
            "parseStatus": "ok", "parseError": None,
        })
    return feats, rows


def _similarity_cache_key(conn, user_scope, threshold):
    """scope|scorever|profile|threshold|count|max(mtime_ns)|max(indexed_at) -
    ANY re-indexed row bumps max(indexed_at), any deletion bumps the count,
    any save bumps max(mtime_ns): the stale entries stop being read and the
    LRU trim reclaims the space. v120: the score-version part invalidates
    the cached answers when the FORMULA changes without touching the
    extracted features (no pointless re-index)."""
    row = conn.execute(
        "SELECT count(*), max(mtime_ns), max(indexed_at) FROM workflow_files"
        " WHERE user_scope=?", (user_scope,)).fetchone()
    return "%s|%d|%s|%s|%s|%s|%s" % (
        user_scope, threshold, SIM_SCORE_VERSION,
        NORMALIZATION_PROFILE_VERSION,
        row[0] or 0, row[1] or 0, row[2] or 0), int(row[0] or 0)


def _similarity_cache_get(conn, key):
    try:
        row = conn.execute(
            "SELECT payload FROM similarity_cache WHERE cache_key=?",
            (key,)).fetchone()
        if row:
            return json.loads(row[0])
    except (ValueError, sqlite3.DatabaseError):
        pass
    return None


def _similarity_cache_put(conn, key, payload):
    try:
        conn.execute("INSERT OR REPLACE INTO similarity_cache "
                     "(cache_key, kind_filter, payload, created_at) "
                     "VALUES (?,?,?,?)",
                     (key, "all",
                      json.dumps(payload, ensure_ascii=False), int(time.time())))
        conn.execute("DELETE FROM similarity_cache WHERE cache_key IN ("
                     "SELECT cache_key FROM similarity_cache "
                     "ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
                     (SIM_CACHE_ROWS,))
        # the answer connection closes WITHOUT a commit in the caller - the
        # cache write must persist on its own (best effort)
        conn.commit()
    except sqlite3.DatabaseError:
        pass   # the cache is best effort - the live computation already ran


def _similarity_filter(answer, kind):
    """The client-side kind filter ('same_uuid' / 'exact' / 'similar')
applied to a FULL cached answer - flipping the filter never recomputes.
v121: the 'similar' filter is SOFT - the same_uuid/exact groups stay in
the answer (the UI renders them after the Similar ones, badged 'shown for
context'): the version families share a workflow_id, so the hard filter
hid exactly the biggest groups (the spec's P0 - the owner's 'the Similar
view shows nothing'). 'same_uuid' / 'exact' stay precise stage views."""
    if kind == "similar":
        answer = dict(answer)
        answer["kind"] = kind
        return answer
    if kind not in ("same_uuid", "exact"):
        return answer
    answer = dict(answer)
    answer["groups"] = [g for g in answer.get("groups", [])
                        if g.get("kind") == kind]
    answer["kind"] = kind
    return answer


def similarity_groups(db=None, user_scope="default", threshold=60,
                      kind=None):
    """The Files-tab grouping (v117): groups over the WHOLE index, built
    server-side (the plan: the flat list is server-paginated, so grouping a
    single client page would lie). Priority: Same UUID > Exact graph copy >
    Similar; every file lands in AT MOST ONE group; the rest ships as
    `ungrouped`. The kind filter ('same_uuid' / 'exact' / 'similar') only
    shapes the ANSWER - the full computation is cached so flipping the
    filter is free (v121: 'similar' is a SOFT filter - the same_uuid/exact
    groups travel with the answer, badged, because the version families
    live in them).

    v120: the threshold accepts 50-100 (the owner asked for looser
    matching); the sub-scores are the (jaccard + overlap) blend; the
    oversized candidate buckets are no longer SKIPPED (sub-bucketed by the
    model set + a bounded star); the answer carries kindCounts so the UI
    can account for EVERY indexed file (the kind filter hides whole
    stages' members - the owner's 'many files unaccounted' report).

    v121 (the spec's P1+P2): the default threshold is 60 (90 only merged
    near-exact siblings - the owner's 'groups of 3' report); the candidate
    pool gains the FILENAME-STEM and MODEL-SET seeds (versioned families
    share a name stem and their models); rare_max derives from the largest
    already-visible family instead of collapsing to 8 on a small folder;
    the similar stage clusters by UNION-FIND over every scored candidate
    edge >= threshold (connected components) - the strict anchor-star with
    'no chaining' capped long version lines to the nearest few, the JOIN
    pass is retired (the chaining IS the clustering now)."""
    db = db or _db_path()
    try:
        threshold = int(threshold)
    except (TypeError, ValueError):
        threshold = 60
    threshold = max(50, min(100, threshold))
    out = {"ok": True, "profile": NORMALIZATION_PROFILE_VERSION,
           "threshold": threshold, "weights": SIM_WEIGHTS,
           "groups": [], "ungrouped": [], "ungroupedTotal": 0,
           "totalFiles": 0, "kindCounts": {}, "skippedBroad": 0,
           "candidatePairs": 0, "pairsScored": 0, "skippedPairs": 0,
           "cached": False}
    try:
        with _db_lock:
            init_db(db)
            conn = _connect(db)
            try:
                cache_key, total_files = _similarity_cache_key(
                    conn, user_scope, threshold)
                out["totalFiles"] = total_files
                cached = _similarity_cache_get(conn, cache_key)
                if isinstance(cached, dict) and cached.get("groups") is not None:
                    cached["cached"] = True
                    cached["threshold"] = threshold
                    return _similarity_filter(cached, kind)
                feats, rows = _similarity_rows(conn, user_scope)
                # v119 honesty: a profile bump (nprof2 -> nprof3) makes EVERY
                # row stale until the next scan pass re-indexes it - the
                # answer must say so instead of showing an empty grid
                if not rows:
                    stale = conn.execute(
                        "SELECT count(*) FROM workflow_files WHERE "
                        "user_scope=? AND parse_status='ok' AND "
                        "normalization_profile_version != ?",
                        (user_scope,
                         NORMALIZATION_PROFILE_VERSION)).fetchone()
                    if stale and stale[0]:
                        out["staleProfile"] = True
                        out["staleFiles"] = int(stale[0])
                rows_by_path = {r["path"]: r for r in rows}
                grouped = set()
                groups = []
                # 1) SAME UUID - every workflow_id shared by 2+ files
                by_id = {}
                for r in rows:
                    wid = r["workflowId"]
                    if wid:
                        by_id.setdefault(wid, []).append(r["path"])
                for wid, paths in sorted(by_id.items(),
                                         key=lambda kv: (-len(kv[1]), kv[0])):
                    if len(paths) < 2:
                        continue
                    members = sorted(paths)
                    grouped.update(members)
                    groups.append({
                        "kind": "same_uuid",
                        "key": "uuid:" + wid,
                        "label": "Same workflow ID",
                        "workflowId": wid,
                        "count": len(members),
                        "anchor": members[0],
                        "files": [rows_by_path[p] for p in members],
                    })
                    if len(groups) >= SIM_MAX_GROUPS:
                        break
                # 2) EXACT GRAPH COPY, DIFFERENT UUID - one sig_graph_hash:
                #    the id/revision-stripped document is byte-identical (the
                #    ComfyUI Duplicate signature). Files still sharing a UUID
                #    already live in a same_uuid group, so the remaining
                #    members really carry different ids.
                if len(groups) < SIM_MAX_GROUPS:
                    by_graph = {}
                    for rel, f in feats.items():
                        if rel in grouped or not f["sig_graph"]:
                            continue
                        by_graph.setdefault(f["sig_graph"], []).append(rel)
                    for gh, paths in sorted(by_graph.items(),
                                            key=lambda kv: (-len(kv[1]), kv[0])):
                        if len(paths) < 2:
                            continue
                        members = sorted(paths)
                        grouped.update(members)
                        groups.append({
                            "kind": "exact",
                            "key": "graph:" + gh,
                            "label": "Exact graph copy, different UUID",
                            "count": len(members),
                            "minScore": 100, "avgScore": 100,
                            "anchor": members[0],
                            "files": [rows_by_path[p] for p in members],
                        })
                        if len(groups) >= SIM_MAX_GROUPS:
                            break
                # 3) SIMILAR - v119 FLEXIBLE CANDIDATES + v120 LOOSE MATCH.
                #    The candidate pool is the UNION of the exact
                #    multiset-hash bucket (the fast path), the UNIQUE-set
                #    bucket (the same classes with different counts) and
                #    the RARE-TYPE pairs (a node type seen in few files
                #    ties its carriers). v120: an OVERSIZED bucket (a
                #    uniform library) is no longer skipped - it is
                #    sub-bucketed by the MODEL-SET key (a modified copy
                #    keeps its models) and the giant leftovers degrade to
                #    a bounded per-file top-K star by the cheap types
                #    blend (the old skip lost whole families silently).
                #    A cheap MATH prefilter runs first: the types blend
                #    floor (score <= w_types*T + (1-w_types), so a pair
                #    below the floor can never reach the threshold - zero
                #    false negatives). The full score runs for survivors
                #    against the ANCHOR (bounded by SIM_PAIR_BUDGET), then
                #    the v120 JOIN pass gives every still-ungrouped file a
                #    bounded second chance to join an EXISTING group
                #    through one of its members (the modified copy of a
                #    modified copy: similar to a member, not to the
                #    anchor). Everything is reported honestly.
                if len(groups) < SIM_MAX_GROUPS:
                    open_paths = [rel for rel in feats
                                  if rel not in grouped
                                  and feats[rel]["sig_types"]]
                    adj = {}
                    cand_left = SIM_CAND_PAIRS

                    def _emit(paths):
                        # all pairs inside one candidate family (bounded:
                        # the family itself is bounded, and the global cap
                        # guards a pathological library)
                        nonlocal cand_left
                        if cand_left <= 0:
                            return
                        for i in range(len(paths)):
                            a = paths[i]
                            for j in range(i + 1, len(paths)):
                                b = paths[j]
                                adj.setdefault(a, set()).add(b)
                                adj.setdefault(b, set()).add(a)
                                cand_left -= 1
                                if cand_left <= 0:
                                    return

                    def _emit_bucket(paths):
                        nonlocal cand_left
                        if len(paths) < 2:
                            return
                        if len(paths) <= SIM_MAX_BUCKET:
                            _emit(paths)
                            return
                        sub, star = {}, []
                        for rel in paths:
                            key = "\x00".join(
                                sorted(set(feats[rel]["models"])))
                            sub.setdefault(key, []).append(rel)
                        for sp in sorted(sub.values(),
                                         key=lambda ps: (-len(ps), ps[0])):
                            if len(sp) <= SIM_BIG_SUB:
                                _emit(sp)
                            else:
                                star.extend(sp)
                        if not star:
                            return
                        star = sorted(star, key=lambda p: (
                            -rows_by_path[p]["mtime"], p))[:SIM_STAR_MAX]
                        out["broadStarFiles"] = (out.get("broadStarFiles", 0)
                                                 + len(star))
                        for a in star:
                            if cand_left <= 0:
                                return
                            ta_ = feats[a]["tc"]
                            scored = [(-_counter_pair_score(ta_,
                                                            feats[b]["tc"]),
                                       b) for b in star if b != a]
                            scored.sort()
                            for _neg, b in scored[:SIM_STAR_K]:
                                adj.setdefault(a, set()).add(b)
                                adj.setdefault(b, set()).add(a)
                                cand_left -= 1
                                if cand_left <= 0:
                                    return

                    by_types, by_uset = {}, {}
                    for rel in open_paths:
                        f = feats[rel]
                        by_types.setdefault(f["sig_types"], []).append(rel)
                        by_uset.setdefault("\x00".join(sorted(set(f["types"]))),
                                           []).append(rel)
                    for buckets in (by_types, by_uset):
                        for paths in sorted(buckets.values(),
                                            key=lambda ps: (-len(ps), ps[0])):
                            if len(paths) >= 2:
                                _emit_bucket(paths)
                    # v121 the FAMILY SEEDS (the spec's P1): the exact
                    # type-set buckets miss a family the moment one node is
                    # added/removed, and the rare-type pass starved on a
                    # small folder - two O(n) seeds catch the versioned
                    # families directly: the FILENAME STEM ('x-simp-batch-
                    # v3.1.1' and 'x-simp-batch-v3.1.2' share one stem) and
                    # the MODEL SET (a modified copy keeps its models). A
                    # seed only PROPOSES candidates - the full score still
                    # gates every pair, an over-generated pair costs a
                    # prefilter check, never a false group.
                    by_stem, by_models = {}, {}
                    for rel in open_paths:
                        st = _name_stem(rows_by_path[rel]["name"])
                        if st:
                            by_stem.setdefault(st, []).append(rel)
                        ms = frozenset(feats[rel]["models"])
                        if ms:
                            by_models.setdefault("\x00".join(sorted(ms)),
                                                 []).append(rel)
                    for buckets in (by_stem, by_models):
                        for paths in sorted(buckets.values(),
                                            key=lambda ps: (-len(ps), ps[0])):
                            if len(paths) >= 2:
                                _emit_bucket(paths)
                    post = {}
                    for rel in open_paths:
                        for t in feats[rel]["tc"]:
                            post.setdefault(t, []).append(rel)
                    # v121 rare_max derives from the LARGEST ALREADY-VISIBLE
                    # family (the same_uuid/exact groups + the stem buckets
                    # capped at one bucket), not from N//20 alone - on a
                    # small folder the old formula collapsed to 8 while the
                    # family signature nodes sit at df 8-11, so they never
                    # posted and the candidates starved (the spec's P1:
                    # rare_max=60 restored 100% coverage on the owner's
                    # folder). A generic name ('untitled' x 500) cannot
                    # inflate it - its bucket stays over the cap and
                    # contributes nothing. A floor of min(N, 30) keeps even
                    # a fully-invisible family (unique names AND models)
                    # coverable on a small library; N//20 keeps the v119
                    # continuity on big uniform ones.
                    fam_size = 0
                    for g_ in groups:
                        if g_["kind"] in ("same_uuid", "exact"):
                            fam_size = max(fam_size, g_["count"])
                    for ps_ in by_stem.values():
                        if len(ps_) <= SIM_MAX_BUCKET:
                            fam_size = max(fam_size, len(ps_))
                    rare_max = max(8, min(SIM_RARE_DF_MAX_CAP,
                                          max(len(open_paths) // 20,
                                              min(len(open_paths), 30),
                                              fam_size + SIM_RARE_SLACK)))
                    for t in sorted(post, key=lambda k: (len(post[k]), k)):
                        members = post[t]
                        if not (2 <= len(members) <= rare_max) or cand_left <= 0:
                            continue
                        _emit(sorted(members))
                    out["candidatePairs"] = sum(len(v) for v in adj.values()) // 2
                    out["candTruncated"] = cand_left <= 0
                    # v121 the CLUSTERING: UNION-FIND (connected components)
                    # over every scored candidate edge >= threshold. The
                    # v117-v120 anchor rule ('members are compared ONLY
                    # against the anchor, no chaining') capped a long
                    # version line to the handful nearest the one anchor -
                    # the owner's 'groups of 3 while the family has 8-10'.
                    # Version-adjacent pairs score 55-70; only the members
                    # near the anchor cleared 90. The connected clustering
                    # lets EVERY qualifying edge tie its pair, so the line
                    # merges into one component. The cheap math prefilter
                    # (zero false negatives) and SIM_PAIR_BUDGET bound the
                    # cost; everything is reported honestly.
                    floor = max(0.0, (threshold / 100.0
                                      - (1.0 - SIM_WEIGHTS["types"]))
                                / SIM_WEIGHTS["types"])
                    anchors = sorted(open_paths,
                                     key=lambda p: (-rows_by_path[p]["mtime"],
                                                    p))
                    budget0 = SIM_PAIR_BUDGET
                    budget = budget0
                    scored_pairs = set()
                    edges = []
                    for anchor in anchors:
                        for p in sorted(
                                adj.get(anchor, ()),
                                key=lambda q: (-rows_by_path[q]["mtime"], q)):
                            key = (anchor, p) if anchor <= p else (p, anchor)
                            if key in scored_pairs:
                                continue
                            scored_pairs.add(key)
                            fa = feats[anchor]
                            fb = feats[p]
                            na, nb = fa["n"], fb["n"]
                            # the cheap math prefilter (zero false
                            # negatives): the types blend floor - a pair
                            # below it cannot reach the threshold even
                            # with the perfect other features. (The v119
                            # size band died with the blend: the overlap
                            # half stays 1.0 on a subset/superset pair,
                            # so a size ratio is NOT a valid bound.)
                            if na and nb:
                                if _counter_pair_score(fa["tc"],
                                                       fb["tc"]) < floor:
                                    continue
                            elif (na == 0) != (nb == 0):
                                continue
                            if budget <= 0:
                                out["skippedPairs"] += 1
                                continue
                            budget -= 1
                            sc = similarity_score(fa, fb)
                            if sc >= threshold:
                                edges.append((key[0], key[1], sc))
                    out["pairsScored"] = budget0 - max(budget, 0)
                    # union-find over the qualifying edges; the component's
                    # root (its deterministic representative) is the NEWEST
                    # member - the same anchor the v117-v120 groups carried
                    parent = {}

                    def _uf_find(x):
                        r = x
                        while parent[r] != r:
                            r = parent[r]
                        while parent[x] != r:
                            parent[x], x = r, parent[x]
                        return r

                    for a, b, _sc in edges:
                        parent.setdefault(a, a)
                        parent.setdefault(b, b)
                    for a, b, _sc in edges:
                        ra, rb = _uf_find(a), _uf_find(b)
                        if ra == rb:
                            continue
                        ka = (-rows_by_path[ra]["mtime"], ra)
                        kb = (-rows_by_path[rb]["mtime"], rb)
                        if ka <= kb:
                            parent[rb] = ra
                        else:
                            parent[ra] = rb
                    comps = {}
                    for a, b, sc in edges:
                        c = comps.setdefault(_uf_find(a),
                                             {"members": set(),
                                              "scores": []})
                        c["members"].add(a)
                        c["members"].add(b)
                        c["scores"].append(sc)
                    for r in sorted(comps,
                                    key=lambda k: (-rows_by_path[k]["mtime"],
                                                   k)):
                        if len(groups) >= SIM_MAX_GROUPS:
                            break
                        c = comps[r]
                        members = sorted(
                            c["members"],
                            key=lambda p: (-rows_by_path[p]["mtime"], p))
                        grouped.update(members)
                        groups.append({
                            "kind": "similar",
                            "key": "sim:" + r,
                            "label": "Similar workflows",
                            "count": len(members),
                            "minScore": min(c["scores"]),
                            "avgScore": int(round(sum(c["scores"])
                                                  / len(c["scores"]))),
                            "anchor": r,
                            "files": [rows_by_path[p] for p in members],
                        })
                ungrouped = [r for r in rows if r["path"] not in grouped]
                out["ungroupedTotal"] = len(ungrouped)
                out["ungrouped"] = ungrouped[:SIM_UNGROUPED_CAP]
                out["groups"] = groups[:SIM_MAX_GROUPS]
                out["totalFiles"] = len(rows)
                # v120 the accounting contract: EVERY indexed file is
                # either in a group (kindCounts names the kind) or in the
                # ungrouped tail - the UI can prove nothing is lost
                kind_counts = {}
                for g in out["groups"]:
                    kind_counts[g["kind"]] = (kind_counts.get(g["kind"], 0)
                                              + g["count"])
                out["kindCounts"] = kind_counts
                cacheable = dict(out)
                cacheable.pop("cached", None)
                cacheable.pop("kind", None)
                _similarity_cache_put(conn, cache_key, cacheable)
                return _similarity_filter(out, kind)
            finally:
                conn.close()
    except sqlite3.OperationalError as e:
        # v118: a locked db is TRANSIENT (a scan's write txn) - the answer
        # says busy:true and the Files UI retries automatically; the empty
        # shape stays intact so the render never breaks
        if _is_busy_error(e):
            return {"ok": False, "busy": True,
                    "error": str(e)[:MAX_ERROR_CHARS],
                    "profile": NORMALIZATION_PROFILE_VERSION,
                    "threshold": threshold, "weights": SIM_WEIGHTS,
                    "groups": [], "ungrouped": [], "ungroupedTotal": 0,
                    "totalFiles": 0, "skippedBroad": 0, "cached": False}
        return {"ok": False, "error": str(e)[:MAX_ERROR_CHARS],
                "profile": NORMALIZATION_PROFILE_VERSION,
                "threshold": threshold, "weights": SIM_WEIGHTS,
                "groups": [], "ungrouped": [], "ungroupedTotal": 0,
                "totalFiles": 0, "skippedBroad": 0, "cached": False}
    except sqlite3.DatabaseError as e:
        return {"ok": False, "error": str(e)[:MAX_ERROR_CHARS],
                "profile": NORMALIZATION_PROFILE_VERSION,
                "threshold": threshold, "weights": SIM_WEIGHTS,
                "groups": [], "ungrouped": [], "ungroupedTotal": 0,
                "totalFiles": 0, "skippedBroad": 0, "cached": False}
