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


def _walk_one(d):
    """Walk a single directory and yield {path, kind, size} for each
    supported media file. Subdirectory paths are relative to d, using
    forward slashes."""
    if not isinstance(d, str) or not os.path.isdir(d):
        return
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
            try:
                size = os.path.getsize(full)
            except Exception:
                size = 0
            yield {"path": rel, "kind": kind, "size": size}


def _resolve_dirs(folder_type):
    """Collect every directory registered under `folder_type` from any
    of the folder_paths API shapes ComfyUI has used across builds:
      * folder_paths.get_<type>_directory() -> str      (modern, single)
      * folder_paths.get_directory_paths(type) -> list  (canonical)
      * folder_paths.folder_paths_and_paths[type] -> ([paths], [exts])
    Accepts both string entries and (path, [exts]) tuples. Returns a
    flat list of directory strings. Last-resort fallback: <cwd>/<type>.
    """
    if folder_paths is None:
        return []
    out = []
    # 1. get_<type>_directory() (modern ComfyUI: input/output/temp).
    fn = getattr(folder_paths, f"get_{folder_type}_directory", None)
    if callable(fn):
        try:
            d = fn()
            if isinstance(d, str) and d:
                out.append(d)
        except Exception:
            pass
    # 2. get_directory_paths(type) - may return list[str] OR list[tuple].
    try:
        dirs = folder_paths.get_directory_paths(folder_type)
        if dirs:
            for d in dirs:
                if isinstance(d, str):
                    out.append(d)
                elif isinstance(d, (list, tuple)):
                    for x in d:
                        if isinstance(x, str):
                            out.append(x)
    except Exception:
        pass
    # 3. Raw folder_paths_and_paths map: value is ([paths], [exts]).
    try:
        entry = folder_paths.folder_paths_and_paths.get(folder_type)
        if entry:
            paths_list = entry[0] if isinstance(entry, (list, tuple)) else None
            if isinstance(paths_list, list):
                for d in paths_list:
                    if isinstance(d, str):
                        out.append(d)
    except Exception:
        pass
    # 4. Last resort: <cwd>/<type> (covers non-standard installs).
    if not out:
        cwd_root = os.getcwd()
        # ComfyUI launches from its own root, so input/ lives here.
        for cand in (os.path.join(cwd_root, folder_type),
                     os.path.join(os.path.dirname(cwd_root), folder_type)):
            if os.path.isdir(cand):
                out.append(cand)
                break
    # Dedup while preserving order.
    seen = set()
    flat = []
    for d in out:
        if d and d not in seen:
            seen.add(d)
            flat.append(d)
    return flat


def _scan_folder(folder_type):
    """Walk every directory registered under `folder_type` and return
    [{path, kind, size}] for each supported media file. Subdirectory paths
    are relative to the folder root, using forward slashes. Resolves the
    folder via _resolve_dirs (handles every folder_paths API shape)."""
    dirs = _resolve_dirs(folder_type)
    if not dirs:
        return []
    seen = set()
    out = []
    for d in dirs:
        for entry in _walk_one(d):
            if entry["path"] in seen:
                continue
            seen.add(entry["path"])
            out.append(entry)
    out.sort(key=lambda x: x["path"].lower())
    return out


@PromptServer.instance.routes.get("/settings_hub/list_media")
async def list_media(request):
    folder = request.query.get("type", "input")
    verbose = request.query.get("verbose") in ("1", "true", "yes")
    files = _scan_folder(folder)
    resp = {"files": files, "type": folder}
    if verbose:
        resp["dirs"] = _resolve_dirs(folder)
    return web.json_response(resp)
