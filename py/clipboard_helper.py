"""v71: OS-clipboard helper for the Settings Hub Paste Stack.

Why this exists: a web page can never read FILES copied in Explorer/Finder
(browser security rule) and the Clipboard API itself requires a secure
context - on a LAN http:// address `navigator.clipboard.read` is simply
absent. The ComfyUI server process runs on the user's own machine, so it
can look at the OS clipboard on behalf of the panel: web/stack.js calls
this route automatically when the paste-area click yields nothing through
the browser Clipboard API (or when a Ctrl+V over the panel carried no data
the browser could see).

Safety contract (mirrors the Nougan helper the feature was modeled on):

  * the request MUST carry the custom header `X-SettingsHub-Clipboard: 1`
    - a random web page cannot trigger clipboard reads cross-origin;
  * the request MUST come from THIS machine (loopback / any local address
    of the host) - the helper reads the server machine's clipboard, so a
    browser on another box gets an honest "not-local" refusal;
  * hard caps: <=10 files, <=25 MB per file, <=60 MB total, extension
    allow-list (images / video / audio / plain-text formats);
  * it is pull-only: NO background polling, the page asks once per click.
  * the read runs in an executor thread - a wedged PowerShell probe or a
    slow PIL grab can never block the ComfyUI event loop.

Windows fallback: `Get-Clipboard -Format FileDropList` via PowerShell when
Pillow is absent or returned nothing (CREATE_NO_WINDOW, 6s timeout).
Raw image data on the clipboard (screenshots) is re-encoded to PNG.
"""
import asyncio
import base64
import io
import mimetypes
import os
import socket
import subprocess
import sys

from server import PromptServer
from aiohttp import web

try:
    import folder_paths  # noqa: F401  (import parity with the sibling routes)
except Exception:  # pragma: no cover
    folder_paths = None

HEADER = "X-SettingsHub-Clipboard"
HEADER_VALUE = "1"

MAX_FILES = 10
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 60 * 1024 * 1024

ALLOWED_EXT = {
    # images
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff",
    # plain text / structured text
    ".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml", ".log",
    ".ini", ".toml", ".xml",
    # video (file cards, v71)
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv",
    # audio
    ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".opus",
}
_MIME_FIX = {
    ".webp": "image/webp", ".avif": "image/avif", ".md": "text/markdown",
    ".json": "application/json", ".yml": "text/yaml", ".yaml": "text/yaml",
    ".log": "text/plain", ".tsv": "text/tab-separated-values",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".m4v": "video/x-m4v", ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4",
    ".opus": "audio/opus",
}

_POWERSHELL_CREATE_NO_WINDOW = 0x08000000


def _local_addrs():
    """Every address that counts as 'this machine': loopback plus whatever
    the hostname resolves to (covers ::1, 127.x and LAN IPs of the host)."""
    addrs = {"127.0.0.1", "::1", "localhost"}
    try:
        addrs.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    return addrs


def _is_local(remote):
    if not remote:
        return False
    remote = str(remote)
    if remote.startswith("::ffff:"):  # IPv4-mapped IPv6 (aiohttp on dual stack)
        remote = remote[7:]
    return remote in _local_addrs()


def _clipboard_content():
    """Return (paths, image). `paths` = files copied in a file manager;
    `image` = a PIL image when the clipboard holds raw picture data."""
    try:
        from PIL import ImageGrab

        data = ImageGrab.grabclipboard()
        if isinstance(data, (list, tuple)):
            return [str(p) for p in data], None
        if data is not None:
            return [], data
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
                  "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }")
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
                capture_output=True, timeout=6,
                creationflags=_POWERSHELL_CREATE_NO_WINDOW,
            )
            lines = out.stdout.decode("utf-8", errors="replace").splitlines()
            return [ln.strip() for ln in lines if ln.strip()], None
        except Exception:
            pass
    return [], None


def _collect():
    """Read the OS clipboard and return [{name, mime, data(b64)}]. Runs in an
    executor thread - never on the event loop."""
    paths, image = _clipboard_content()
    files, total = [], 0
    for p in paths:
        if len(files) >= MAX_FILES:
            break
        try:
            ext = os.path.splitext(p)[1].lower()
            if ext not in ALLOWED_EXT or not os.path.isfile(p):
                continue
            size = os.path.getsize(p)
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
                continue
            with open(p, "rb") as fh:
                raw = fh.read()
            total += size
            mime = _MIME_FIX.get(ext) or mimetypes.guess_type(p)[0] or "application/octet-stream"
            files.append({
                "name": os.path.basename(p),
                "mime": mime,
                "data": base64.b64encode(raw).decode("ascii"),
            })
        except Exception:
            continue
    if not files and image is not None:
        # Raw picture data (screenshot) rather than file references.
        try:
            buf = io.BytesIO()
            image.convert("RGBA").save(buf, "PNG")
            files.append({
                "name": "clipboard.png",
                "mime": "image/png",
                "data": base64.b64encode(buf.getvalue()).decode("ascii"),
            })
        except Exception:
            pass
    return files


def _register():
    routes = PromptServer.instance.routes

    @routes.post("/settings_hub/clipboard")
    async def settings_hub_clipboard(request):
        # Custom header first: a stray cross-origin form POST cannot forge
        # it without a CORS preflight this server never grants.
        if request.headers.get(HEADER) != HEADER_VALUE:
            return web.json_response(
                {"ok": False, "error": "forbidden", "files": []}, status=403)
        if not _is_local(request.remote):
            return web.json_response(
                {"ok": False, "error": "not-local", "files": []}, status=403)
        try:
            files = await asyncio.get_running_loop().run_in_executor(None, _collect)
        except Exception:
            files = []
        return web.json_response({"ok": True, "files": files})


_register()
