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

Changing the root NEVER moves or copies presets (AGENTS.md 5.1 rules 7/12):
each location keeps its own presets/ folder, the new one starts empty. The
override file always stays in the DEFAULT user dir, so health/root answers
carry `custom` (the active custom root or null) and `dir` (the EFFECTIVE
root) next to `default`.

Safety: preset ids are strict hex (import may carry a wider legacy charset -
still path-safe, it IS the file name), item paths are relative-without-
traversal ONLY, names are control-stripped and capped, writes are size-
capped, every preset file is written atomically and every mutation takes an
asyncio.Lock (aiohttp handlers interleave on one event loop).
"""
import asyncio
import json
import os
import re
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

_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
# v101: import/legacy ids may be wider - still a strict path-safe charset.
_ID_LOOSE_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

_lock = asyncio.Lock()


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


def _legacy_presets_path():
    """The v101-v103 single-file store of the ACTIVE root - only ever read
    by the one-time migration; after it the name lives on as .bak."""
    return os.path.join(_workflows_root(), _LEGACY_NAME)


def _presets_dir():
    """The per-preset folder of the ACTIVE root (v104 layout)."""
    return os.path.join(_workflows_root(), _PRESETS_DIR_NAME)


def _preset_file(pid):
    """The per-preset file of the ACTIVE root. `pid` is ALWAYS matched
    against _ID_LOOSE_RE before this is used as a path (a strict path-safe
    charset: [A-Za-z0-9_-]{4,64}), so the file name cannot traverse."""
    return os.path.join(_presets_dir(), pid + ".json")


def _ensure_dirs():
    try:
        os.makedirs(_presets_dir(), exist_ok=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# v104 per-preset storage (ONE file per preset) + the one-time migration of
# the legacy presets.json array. Every write is atomic (tmp + os.replace);
# every mutation runs under the module asyncio.Lock.
# ---------------------------------------------------------------------------

def _migrate_legacy_file():
    """Split a legacy presets.json array into per-preset files (idempotent):
    a per-preset file that already exists WINS over the legacy copy, so a
    rerun after a partial migration never rolls the folder back. The original
    is renamed presets.json.bak (never deleted - the .bak is the owner's
    backup). Any failure leaves the legacy file in place and the next read
    retries - the routes never break on migration."""
    legacy = _legacy_presets_path()
    if not os.path.isfile(legacy):
        return
    try:
        with open(legacy, "r", encoding="utf-8") as f:
            data = json.load(f)
        legacy_list = data if isinstance(data, list) else []
    except Exception:
        legacy_list = []  # a corrupt legacy file has nothing to split
    _ensure_dirs()
    for p in legacy_list:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not isinstance(pid, str) or not _ID_LOOSE_RE.match(pid):
            # a hand-edited legacy id -> a fresh safe file name, data kept
            pid = uuid.uuid4().hex[:12]
            while os.path.exists(_preset_file(pid)):
                pid = uuid.uuid4().hex[:12]
            p["id"] = pid
        if os.path.exists(_preset_file(pid)):
            continue  # the folder copy wins
        try:
            _write_preset_file(p)
        except Exception:
            return
    try:
        os.replace(legacy, legacy + ".bak")
    except OSError:
        pass  # a locked file must not break the routes; the next read retries


def _read_presets():
    """All the presets of the ACTIVE root: scan presets/*.json, parse each,
    keep the well-formed ones (a dict whose inner id agrees with the file
    name - a disagreeing file is ignored, not served). A corrupt file skips
    itself; one bad file can never blank the whole list."""
    _migrate_legacy_file()
    out = []
    try:
        names = sorted(os.listdir(_presets_dir()))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(_presets_dir(), name), "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if (isinstance(data, dict) and isinstance(data.get("id"), str)
                and data["id"] == name[:-len(".json")]):
            out.append(data)
    return out


def _count_preset_files():
    """Cheap MAX_PRESETS guard: the number of per-preset files (no parsing)."""
    try:
        return len([n for n in os.listdir(_presets_dir()) if n.endswith(".json")])
    except OSError:
        return 0


def _load_preset_file(pid):
    """Parse ONE per-preset file (None when missing/corrupt/id-disagreeing).
    The id is re-validated here - every addressing path funnels through this
    check, so a pid from the wire can never reach the filesystem unchecked."""
    if not isinstance(pid, str) or not _ID_LOOSE_RE.match(pid):
        return None
    try:
        with open(_preset_file(pid), "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if isinstance(data, dict) and data.get("id") == pid:
        return data
    return None


def _write_preset_file(p):
    """Atomic write of ONE preset file (tmp + os.replace)."""
    _ensure_dirs()
    f = _preset_file(p["id"])
    tmp = f + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(p, fh, ensure_ascii=False)
    os.replace(tmp, f)


def _delete_preset_file(pid):
    try:
        os.unlink(_preset_file(pid))
        return True
    except OSError:
        return False


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
    """Merge/dedup identity of a preset item: path items by their path,
    snapshots by their display name (a re-saved temp tab REFRESHES its
    snapshot instead of stacking copies)."""
    if not isinstance(it, dict):
        return None
    if it.get("kind") == "path":
        return "path:" + str(it.get("path") or "")
    if it.get("kind") == "snapshot":
        return "snap:" + str(it.get("name") or "")
    return None


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
            it = {"kind": "snapshot", "name": nm, "graph": graph}
            key = _item_dedupe_key(it)
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
        else:
            continue
    if len(items) > MAX_ITEMS_PER_PRESET:
        return None, ("too many items: %d (max %d)"
                      % (len(items), MAX_ITEMS_PER_PRESET))
    return items, None


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
    if "fav" in body:
        fields["fav"] = bool(body.get("fav"))
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
    n = _count_preset_files()
    return web.json_response({
        "ok": True,
        "version": WORKFLOWS_SERVER_VERSION,
        "dir": _workflows_root(),
        "custom": _root_custom,
        "default": _default_root(),
        "writable": writable,
        "presets": n,
    })


# v101: server pack version - MUST bump together with the web build stamps
# (tools/version.py checks both against the entry stamp; the panel compares
# it against globalThis.__SettingsHubBuild). AGENTS.md release rule.
WORKFLOWS_SERVER_VERSION = "v105"


@PromptServer.instance.routes.get("/settings_hub/workflows/root")
async def workflows_root_get(request):
    return web.json_response({
        "ok": True,
        "root": _workflows_root(),
        "custom": _root_custom,
        "default": _default_root(),
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
                existing["items"] = items
                if fields.get("name"):
                    existing["name"] = fields["name"]
                if "activePath" in fields:
                    if fields["activePath"]:
                        existing["activePath"] = fields["activePath"]
                    else:
                        existing.pop("activePath", None)
                existing["updated"] = now
            else:  # merge
                merged = list(existing.get("items") or [])
                have = {_item_dedupe_key(it) for it in merged}
                for it in items:
                    k = _item_dedupe_key(it)
                    if k in have:
                        # refresh in place (a newer snapshot of the same tab)
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
                existing["items"] = merged
                if fields.get("name"):
                    existing["name"] = fields["name"]
                if "activePath" in fields and fields["activePath"]:
                    existing["activePath"] = fields["activePath"]
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
        _write_preset_file(preset)
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
        if "name" in fields:
            it["name"] = fields["name"] or it["name"]
        if "fav" in fields:
            it["fav"] = fields["fav"]
        if "items" in fields:
            it["items"] = fields["items"]
        if "activePath" in fields:
            if fields["activePath"]:
                it["activePath"] = fields["activePath"]
            else:
                it.pop("activePath", None)
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
                existing["items"] = fields["items"]
                if fields.get("name"):
                    existing["name"] = fields["name"]
                if "activePath" in fields:
                    if fields["activePath"]:
                        existing["activePath"] = fields["activePath"]
                    else:
                        existing.pop("activePath", None)
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
            _write_preset_file(preset)
            imported.append(preset)
    return web.json_response({"ok": True, "imported": len(imported),
                              "presets": imported})
