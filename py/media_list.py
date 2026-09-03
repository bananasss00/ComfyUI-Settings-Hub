"""v47: recursive input-folder listing for the SettingsHub media browser.

Vanilla ComfyUI's `folder_paths.get_filename_list("input")` is FLAT - it
does not see files inside subdirectories. The hub's media-source row needs
the full recursive list (the loaders themselves ACCEPT relative paths like
"subdir/file.png" via tw.value; the combo just doesn't surface them). This
endpoint walks every directory registered under the requested folder type
and returns the relative paths with a kind hint.

Registered as a PromptServer route; the SettingsHub node class itself stays
a stub (no OUTPUT_NODE, noop returns ()). The route is independent of node
execution - it never runs during a queue.
"""
import os
from server import PromptServer
from aiohttp import web

try:
    import folder_paths
except Exception:
    folder_paths = None

_IMG_EXT = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tif", "tiff", "svg"}
_VID_EXT = {"mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"}
_AUD_EXT = {"mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"}


def _kind_for(ext):
    if ext in _IMG_EXT:
        return "image"
    if ext in _VID_EXT:
        return "video"
    if ext in _AUD_EXT:
        return "audio"
    return None


def _scan_folder(folder_type):
    """Walk every directory registered under `folder_type` and return
    [{path, kind, size}] for each supported media file. Subdirectory paths
    are relative to the folder root, using forward slashes."""
    if folder_paths is None:
        return []
    try:
        dirs = folder_paths.get_directory_paths(folder_type)
    except Exception:
        return []
    if not dirs:
        return []
    seen = set()
    out = []
    for d in dirs:
        if not isinstance(d, str) or not os.path.isdir(d):
            continue
        for root, _dirs, fnames in os.walk(d):
            for fn in fnames:
                if fn.startswith("."):
                    continue
                ext = os.path.splitext(fn)[1].lower().lstrip(".")
                kind = _kind_for(ext)
                if not kind:
                    continue
                full = os.path.join(root, fn)
                try:
                    rel = os.path.relpath(full, d).replace(os.sep, "/")
                except Exception:
                    continue
                if rel in seen:
                    continue
                seen.add(rel)
                try:
                    size = os.path.getsize(full)
                except Exception:
                    size = 0
                out.append({"path": rel, "kind": kind, "size": size})
    out.sort(key=lambda x: x["path"].lower())
    return out


@PromptServer.instance.routes.get("/settings_hub/list_media")
async def list_media(request):
    folder = request.query.get("type", "input")
    files = _scan_folder(folder)
    return web.json_response({"files": files, "type": folder})
