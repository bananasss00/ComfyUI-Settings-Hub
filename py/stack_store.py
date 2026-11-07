"""v70: server-side storage for the Settings Hub Paste Stack.

The stack is a floating clipboard-history panel (web/stack.js). Its entries
live IN THE COMFYUI PROCESS FILESYSTEM - not in the browser - so the stack
travels with the ComfyUI folder (portability, owner decision 2026-11-08):
it is shared by every origin (localhost / 127.0.0.1 / LAN), browser and
profile, and survives site-data wipes.

Layout under the user directory:

    <user>/settings_hub/stack/index.json   - metadata, top-first order:
        [{id, type, created, hash, size, text?, file?, pinned?}]
    <user>/settings_hub/stack/items/<id>.<ext> - blobs (images)

Routes (registered at import, PromptServer aiohttp, same style as
media_list.py; the SettingsHub node class itself stays a stub and these
routes never run during a queue):

    GET    /settings_hub/stack             -> {ok, items}
    POST   /settings_hub/stack/item        -> JSON {type:"text", text}     add text
    POST   /settings_hub/stack/image       -> raw bytes, ?ext=png|jpg|...  add image
    DELETE /settings_hub/stack/item/{id}   -> remove one entry (+ blob)
    POST   /settings_hub/stack/clear       -> wipe entries + blobs
    GET    /settings_hub/stack/file/{name} -> serve a stored blob

Safety: names are validated against ^[A-Za-z0-9._-]{1,120}$ and resolved
INSIDE the items directory (no traversal); writes are size-capped; the
index is written atomically (tmp + os.replace); every mutation takes an
asyncio.Lock (aiohttp handlers interleave on one event loop).

Dedup: each entry carries a sha1-based hash of its content. Re-adding the
same content MOVES the existing entry to the top (fresh `created`) instead
of stacking a copy - exactly the Nougan semantics.

Eviction: hard caps of MAX_ITEMS entries / MAX_TOTAL_BYTES (configurable
client max applies BEFORE these server-side guards; the client deletes its
oldest first). The server drops the OLDEST tail entries (pinned excluded,
pinned arrives in v72) and unlinks their blobs.
"""
import asyncio
import hashlib
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

MAX_ITEMS = 500
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_TEXT_CHARS = 1_000_000
MAX_IMAGE_BYTES = 25 * 1024 * 1024
TEXT_INLINE_LIMIT = 100 * 1024  # larger texts become files too

_IMG_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "bmp": "image/bmp",
}
_TEXT_EXT = {"txt", "md", "json", "csv", "log", "py", "js", "css", "html", "xml", "yml", "yaml"}
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")

_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _stack_root():
    """<user-dir>/settings_hub/stack. folder_paths.get_user_directory() is the
    canonical user dir (default <ComfyUI>/user); never hardcode a path."""
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
    return os.path.join(base, "settings_hub", "stack")


def _items_dir():
    return os.path.join(_stack_root(), "items")


def _index_path():
    return os.path.join(_stack_root(), "index.json")


def _ensure_dirs():
    try:
        os.makedirs(_items_dir(), exist_ok=True)
    except Exception:
        pass


def _unlink_blob(name):
    if not isinstance(name, str) or not _NAME_RE.match(name):
        return
    try:
        p = os.path.join(_items_dir(), name)
        if os.path.abspath(p).startswith(os.path.abspath(_items_dir()) + os.sep):
            os.unlink(p)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Index read/write (atomic)
# ---------------------------------------------------------------------------

def _read_index():
    try:
        with open(_index_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [it for it in data if isinstance(it, dict) and isinstance(it.get("id"), str)]
    except Exception:
        pass
    return []


def _write_index(items):
    _ensure_dirs()
    tmp = _index_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, _index_path())


# ---------------------------------------------------------------------------
# Mutations (call under _lock)
# ---------------------------------------------------------------------------

def _hash_bytes(b):
    return hashlib.sha1(b).hexdigest()[:16]


def _entry_size(it):
    if it.get("type") == "text":
        return len(it.get("text", "").encode("utf-8", "ignore"))
    return int(it.get("size", 0) or 0)


def _evict(items):
    """Drop the oldest tail until count/size caps hold; pinned entries are
    reserved (the field arrives in v72, guarded here already)."""
    def droppable():
        alive = [it for it in items if not it.get("pinned")]
        return alive[-1] if alive else None

    while len(items) > MAX_ITEMS:
        victim = droppable()
        if victim is None:
            break
        items.remove(victim)
        _unlink_blob(victim.get("file"))
    total = sum(_entry_size(it) for it in items)
    while total > MAX_TOTAL_BYTES:
        victim = droppable()
        if victim is None:
            break
        items.remove(victim)
        _unlink_blob(victim.get("file"))
        total -= _entry_size(victim)


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def _touch_dup(items, content_hash):
    """If an entry with this hash exists, move it to the top (fresh created)
    and return (entry, True). Returns None when there is no duplicate."""
    idx = next((i for i, x in enumerate(items) if x.get("hash") == content_hash), None)
    if idx is None:
        return None
    old = items.pop(idx)
    old["created"] = int(time.time())
    items.insert(0, old)
    _write_index(items)
    return old, True


@PromptServer.instance.routes.get("/settings_hub/stack")
async def stack_get(request):
    return web.json_response({"ok": True, "items": _read_index()})


@PromptServer.instance.routes.post("/settings_hub/stack/item")
async def stack_add_text(request):
    """Add a TEXT entry. Body: JSON {text}. Text lives inline in the index
    unless it exceeds TEXT_INLINE_LIMIT - then it is stored as a .txt blob."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or not text.strip():
        return web.json_response({"ok": False, "error": "empty text"}, status=400)
    if len(text) > MAX_TEXT_CHARS:
        return web.json_response({"ok": False, "error": "text too large"}, status=413)
    size = len(text.encode("utf-8", "ignore"))
    async with _lock:
        items = _read_index()
        h = _hash_bytes(text.encode("utf-8"))
        dup = _touch_dup(items, h)
        if dup is not None:
            return web.json_response({"ok": True, "item": dup[0], "moved": True})
        item = {"id": uuid.uuid4().hex[:12], "type": "text", "hash": h,
                "text": text, "size": size}
        if size > TEXT_INLINE_LIMIT:
            _ensure_dirs()
            name = item["id"] + ".txt"
            with open(os.path.join(_items_dir(), name), "wb") as f:
                f.write(text.encode("utf-8"))
            item["file"] = name
            del item["text"]
        item["created"] = int(time.time())
        items.insert(0, item)
        _evict(items)
        _write_index(items)
    return web.json_response({"ok": True, "item": item, "moved": False})


@PromptServer.instance.routes.post("/settings_hub/stack/image")
async def stack_add_image(request):
    """Add an IMAGE entry. Body: raw bytes, ?ext=png|jpg|jpeg|webp|gif|bmp.
    A duplicate (same bytes hash) moves the existing entry to the top and
    the new payload is discarded without touching the stored blob."""
    ext = (request.query.get("ext") or "png").lower().lstrip(".")
    if ext not in _IMG_EXT:
        return web.json_response({"ok": False, "error": "bad ext"}, status=400)
    payload = await request.read()
    if not payload:
        return web.json_response({"ok": False, "error": "empty payload"}, status=400)
    if len(payload) > MAX_IMAGE_BYTES:
        return web.json_response({"ok": False, "error": "image too large"}, status=413)
    async with _lock:
        items = _read_index()
        h = _hash_bytes(payload)
        dup = _touch_dup(items, h)
        if dup is not None:
            return web.json_response({"ok": True, "item": dup[0], "moved": True})
        item_id = uuid.uuid4().hex[:12]
        name = item_id + "." + ext
        _ensure_dirs()
        with open(os.path.join(_items_dir(), name), "wb") as f:
            f.write(payload)
        item = {"id": item_id, "type": "image", "hash": h,
                "file": name, "size": len(payload), "created": int(time.time())}
        items.insert(0, item)
        _evict(items)
        _write_index(items)
    return web.json_response({"ok": True, "item": item, "moved": False})


@PromptServer.instance.routes.delete("/settings_hub/stack/item/{item_id}")
async def stack_delete(request):
    item_id = request.match_info.get("item_id", "")
    if not _ID_RE.match(item_id):
        return web.json_response({"ok": False, "error": "bad id"}, status=400)
    async with _lock:
        items = _read_index()
        found = next((it for it in items if it.get("id") == item_id), None)
        if found is None:
            return web.json_response({"ok": True, "gone": True})
        items.remove(found)
        _unlink_blob(found.get("file"))
        _write_index(items)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/settings_hub/stack/clear")
async def stack_clear(request):
    async with _lock:
        items = _read_index()
        for it in items:
            _unlink_blob(it.get("file"))
        _write_index([])
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/settings_hub/stack/file/{name}")
async def stack_file(request):
    name = request.match_info.get("name", "")
    if not _NAME_RE.match(name):
        return web.json_response({"ok": False, "error": "bad name"}, status=400)
    root = os.path.abspath(_items_dir())
    path = os.path.abspath(os.path.join(root, name))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "not found"}, status=404)
    ext = os.path.splitext(name)[1].lower().lstrip(".")
    return web.FileResponse(path, headers={
        "Content-Type": _IMG_EXT.get(ext, "application/octet-stream"),
        "Cache-Control": "no-store",
    })
