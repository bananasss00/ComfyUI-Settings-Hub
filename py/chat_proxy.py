"""v86: server-side storage + upstream proxy for the Settings Hub LLM Chat.

The chat is a floating panel with TABS (web/chat.js, modeled on the Paste
Stack panel). Owner decisions (2026-11-09):
  * ONE connector type: an OpenAI-compatible base URL + optional api key.
    The primary target is the owner's local PolyStrata server
    (http://<ip>:<port>/v1 - the server natively speaks /v1/chat/completions,
    /v1/models, /v1/load), the same format covers llama.cpp / LM Studio /
    Ollama (/v1) / vLLM / OpenRouter.
  * The chat is NOT an agent: it never touches the ComfyUI queue, workflow
    or nodes. There are no tools, no auto-loops.
  * Several chats at once as TABS in the panel; every tab is its own dialog
    with its own history.
  * Images attach to a message (vision) in v86; video (server-side frame
    extraction, the PolyStrata/mtmd convention) ships in the same release;
    text files go into the request inline.
  * The browser NEVER talks to the LLM server directly: this module is the
    single proxy (/settings_hub/chat/*). Reasons: no CORS setup on the LLM
    server, the api key never enters the browser (F12 / disk), client
    disconnects cancel the upstream request (PolyStrata treats a closed
    socket as "client went away" and frees the slot), one contract.

Storage layout under the ACTIVE root (default <user>/settings_hub/chat,
custom absolute path via chat_root.json - the v84 stack_root mechanics,
loaded at import, probed before switching, NEVER moved):

    <root>/config.json                      persisted settings (incl. key)
    <root>/sessions/<sid>/session.json      {id,title,created,updated,messages}
    <root>/sessions/<sid>/blobs/<name>      attachment blobs

A message looks like:
    {"role": "user"|"assistant", "text": str, "ts": int,
     "parts": [{"kind": "image"|"video"|"file", "name": <blob>,
                "orig": <display name>, "size": int}],
     "usage": {...}?, "model"?: str, "ms"?: int, "stopped"?: bool}

Routes (registered at import, PromptServer aiohttp, same style as
py/stack_store.py):
    GET    /settings_hub/chat/health            storage + config diagnostics
    GET    /settings_hub/chat/config            config with a MASKED key
    POST   /settings_hub/chat/config            partial update (key: absent
                                                = keep, "" = clear, else set)
    POST   /settings_hub/chat/test              probe the upstream: /v1/models
                                                (+ /v1/status when present)
    GET    /settings_hub/chat/sessions          session list (id,title,dates,n)
    POST   /settings_hub/chat/sessions          create {title?}
    GET    /settings_hub/chat/session/{sid}     full session
    PUT    /settings_hub/chat/session/{sid}     rename {title}
    DELETE /settings_hub/chat/session/{sid}     delete (dir + blobs)
    POST   /settings_hub/chat/session/{sid}/clear  messages = []
    POST   /settings_hub/chat/attach            blob upload (?session&kind&name)
    GET    /settings_hub/chat/file/{sid}/{name} serve a blob (typed)
    POST   /settings_hub/chat/send              THE proxy: append/patch the user
                                                message, build the upstream
                                                payload, call the LLM, store the
                                                reply; JSON or SSE (stream)
    POST   /settings_hub/chat/load              upstream /v1/load {model}
    GET    /settings_hub/chat/gpu               upstream /v1/status + the reserve
                                                state (v87 memory menu)
    POST   /settings_hub/chat/gpu               actions (v87): reserve {mib} /
                                                release / unload {wait?} /
                                                load {model?} / free_comfy /
                                                status - the PolyStrata VRAM
                                                mechanics (/v1/vram, /v1/unload)
                                                + ComfyUI-side cleanup

v87 memory mechanics (the PolyStrata node logic, ported):
  * POST /v1/vram {"reserve_mib": N} - the LLM server keeps N MiB of VRAM
    FREE on the GPU (it re-applies the reserve itself after engine
    restarts); {"reserve_mib": null} returns to the startup state.
  * comfy.model_management.EXTRA_RESERVED_VRAM - ComfyUI plans its own
    model loads around this many bytes (the llama.cpp-node method): when
    the reserve is applied we measure the LLM's ACTUAL consumption
    (gpu total - now free) and write it there, so ComfyUI never plans a
    load into the LLM's memory; releasing restores the original value.
  * cfg "vram_reserve_mib" > 0 makes EVERY /send re-apply the reserve
    before the upstream call (best-effort, errors never fail the chat) -
    that is the "reserve when a model loads in PolyStrata" guarantee.
  * free_comfy = mm.unload_all_models() + soft_empty_cache() + gc -
    ComfyUI's own "Free model and node cache" button; the LLM server is
    NOT touched.
"""

import asyncio
import base64
import json
import os
import re
import shutil
import time
import uuid

from aiohttp import web

try:
    import aiohttp
except Exception:  # pragma: no cover - aiohttp always exists in ComfyUI
    aiohttp = None

try:
    import folder_paths
except Exception:  # pragma: no cover - folder_paths always exists in ComfyUI
    folder_paths = None

CHAT_SERVER_VERSION = "v87"

# ---------------------------------------------------------------------------
# Limits (server-side absolute guards; the frontend may enforce smaller ones)
# ---------------------------------------------------------------------------

MAX_MESSAGE_CHARS = 100_000
MAX_TITLE_CHARS = 80
MAX_BLOB_BYTES_HARD = 100 * 1024 * 1024   # absolute cap regardless of config
DEFAULT_MAX_FILE_MB = 20
TEXT_INLINE_LIMIT = 300 * 1024            # text files enter the prompt capped
DEFAULT_TIMEOUT_S = 600
PROBE_TIMEOUT_S = 20

_IMG_EXT = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
}
_VID_EXT = {
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "mkv": "video/x-matroska", "avi": "video/x-msvideo",
    "m4v": "video/x-m4v", "ogv": "video/ogg",
}
_AUD_EXT = {
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "flac": "audio/flac", "aac": "audio/aac", "m4a": "audio/mp4",
    "opus": "audio/opus",
}
_DOC_MIME = {
    "txt": "text/plain", "md": "text/markdown", "json": "application/json",
    "csv": "text/csv", "log": "text/plain", "pdf": "application/pdf",
    "xml": "application/xml", "yml": "text/plain", "yaml": "text/plain",
    "py": "text/plain", "js": "text/plain", "html": "text/html",
    "ini": "text/plain", "tsv": "text/tab-separated-values",
}
_FILE_MIME = {**_IMG_EXT, **_VID_EXT, **_AUD_EXT, **_DOC_MIME}
_ALL_BLOB_EXT = set(_FILE_MIME) | {"zip", "safetensors"}
# kinds -> allowed extensions for /attach
_KIND_EXT = {
    "image": set(_IMG_EXT),
    "video": set(_VID_EXT),
    "file": _ALL_BLOB_EXT,
}
# text-like files may carry their CONTENT into the prompt (the v83 viewer list)
_TEXT_LIKE = {"txt", "md", "json", "csv", "log", "py", "js", "css", "html",
              "xml", "yml", "yaml", "ini", "tsv"}

_SID_RE = re.compile(r"^[a-f0-9]{8,32}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "url": "",                 # OpenAI-compatible base, e.g. http://127.0.0.1:8080/v1
    "key": "",                 # api key (Bearer); optional
    "model": "",
    "system_prompt": "",
    "temperature": 0.8,
    "top_p": 0.95,
    "max_tokens": 1024,        # 0 = no limit (send nothing)
    "reasoning": "default",    # default | none | low | medium | high
    "ctx_depth": 12,           # how many last messages go into the request
    "media_depth": 1,          # how many of those may carry real media parts
    "img_max_side": 1024,      # the client downscales to this before upload
    "img_max_count": 4,        # images per one message
    "video_frames": 16,        # frames per video (server-side ffmpeg cut)
    "video_max_side": 768,
    "stream": True,            # SSE streaming replies
    "keep_sessions": 20,       # eviction for old sessions
    "timeout_s": DEFAULT_TIMEOUT_S,
    "max_file_mb": DEFAULT_MAX_FILE_MB,
    "vram_reserve_mib": 0,     # v87: keep this much VRAM free for ComfyUI
                               # (POST /v1/vram; 0 = touch nothing). Re-applied
                               # before every send while > 0 (the "reserve when
                               # a model loads in PolyStrata" guarantee).
}

_CONFIG_NUM_RANGES = {
    "temperature": (0.0, 2.0), "top_p": (0.0, 1.0),
    "max_tokens": (0, 131072), "ctx_depth": (1, 200), "media_depth": (0, 50),
    "img_max_side": (256, 4096), "img_max_count": (1, 16),
    "video_frames": (2, 64), "video_max_side": (256, 4096),
    "keep_sessions": (1, 500), "timeout_s": (30, 86400),
    "max_file_mb": (1, 100), "vram_reserve_mib": (0, 131072),
}
_REASONS = {"default", "none", "low", "medium", "high"}


# ---------------------------------------------------------------------------
# Paths - the v84 stack-root mechanics (chat flavor)
# ---------------------------------------------------------------------------

def _user_dir():
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


_ROOT_OVERRIDE_NAME = "chat_root.json"
_root_custom = None  # str | None


def _root_override_path():
    return os.path.join(_user_dir(), "settings_hub", _ROOT_OVERRIDE_NAME)


def _load_root_override():
    """Boot-time read of the persisted override (v84 stack mechanics)."""
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
    """(path, None) with path == "" meaning back-to-default, or (None, err)."""
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
    try:
        os.makedirs(os.path.join(root, "sessions"), exist_ok=True)
        probe = os.path.join(root, "sessions", ".root_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.unlink(probe)
        return True
    except Exception:
        return False


def _chat_root():
    return _root_custom or os.path.join(_user_dir(), "settings_hub", "chat")


def _sessions_dir():
    return os.path.join(_chat_root(), "sessions")


def _session_dir(sid):
    return os.path.join(_sessions_dir(), sid)


def _blobs_dir(sid):
    return os.path.join(_session_dir(sid), "blobs")


def _config_path():
    return os.path.join(_chat_root(), "config.json")


def _ensure_dirs(sid=None):
    os.makedirs(_sessions_dir(), exist_ok=True)
    if sid:
        os.makedirs(_blobs_dir(sid), exist_ok=True)


def _has_ffmpeg():
    return bool(shutil.which("ffmpeg"))


# ---------------------------------------------------------------------------
# Config load / save / mask
# ---------------------------------------------------------------------------

def _default_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg["url"] = "http://127.0.0.1:8080/v1"
    return cfg


def _load_config():
    cfg = _default_config()
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in DEFAULT_CONFIG:
                if k in data:
                    cfg[k] = data[k]
    except Exception:
        pass
    # sanitize numerics
    for k, (lo, hi) in _CONFIG_NUM_RANGES.items():
        try:
            v = float(cfg.get(k))
        except Exception:
            v = DEFAULT_CONFIG[k]
        if isinstance(DEFAULT_CONFIG[k], int) and float(v).is_integer():
            v = int(v)
        cfg[k] = min(hi, max(lo, v))
    if cfg.get("reasoning") not in _REASONS:
        cfg["reasoning"] = "default"
    cfg["stream"] = bool(cfg.get("stream"))
    cfg["url"] = _clean_url(cfg.get("url") or "")
    cfg["key"] = str(cfg.get("key") or "")
    cfg["model"] = str(cfg.get("model") or "")[:200]
    cfg["system_prompt"] = str(cfg.get("system_prompt") or "")[:8000]
    return cfg


def _clean_url(u):
    u = str(u or "").strip()
    while u.endswith("/"):
        u = u[:-1]
    return u


def _save_config(cfg):
    _ensure_dirs()
    tmp = _config_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _config_path())


def _mask_key(key):
    if not key:
        return ""
    if len(key) <= 6:
        return "*" * len(key)
    return key[:2] + "****" + key[-4:]


def _masked_config(cfg):
    out = dict(cfg)
    out["key"] = _mask_key(cfg.get("key") or "")
    return out


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def _read_session(sid):
    path = os.path.join(_session_dir(sid), "session.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("id") == sid:
            return data
    except Exception:
        pass
    return None


def _write_session(sess):
    os.makedirs(_session_dir(sess["id"]), exist_ok=True)
    path = os.path.join(_session_dir(sess["id"]), "session.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sess, f, ensure_ascii=False)
    os.replace(tmp, path)


def _session_brief(sess):
    return {
        "id": sess["id"], "title": sess.get("title") or "",
        "created": sess.get("created", 0), "updated": sess.get("updated", 0),
        "n": len(sess.get("messages") or []),
    }


def _list_sessions():
    out = []
    try:
        names = os.listdir(_sessions_dir())
    except Exception:
        names = []
    for n in names:
        if _SID_RE.match(n):
            s = _read_session(n)
            if s:
                out.append(_session_brief(s))
    out.sort(key=lambda x: x.get("updated", 0), reverse=True)
    return out


def _new_session(title=""):
    sid = uuid.uuid4().hex[:12]
    now = int(time.time())
    return {"id": sid, "title": str(title or "")[:MAX_TITLE_CHARS],
            "created": now, "updated": now, "messages": []}


def _evict_sessions(keep):
    """Drop the OLDEST sessions beyond keep (by updated). Active sessions get
    touched on every send, so an open chat is never the eviction victim."""
    try:
        keep = int(keep)
    except Exception:
        keep = DEFAULT_CONFIG["keep_sessions"]
    lst = _list_sessions()
    if len(lst) <= keep:
        return
    for brief in lst[keep:]:
        try:
            shutil.rmtree(_session_dir(brief["id"]), ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Blobs
# ---------------------------------------------------------------------------

def _ext_of(name):
    n = str(name or "").lower()
    i = n.rfind(".")
    return n[i + 1:] if i >= 0 else ""


def _sanitize_orig(name):
    n = re.sub(r"[^A-Za-z0-9._ -]+", "_", str(name or "file"))[:80]
    return n or "file"


def _data_url(path, mime):
    with open(path, "rb") as f:
        b = f.read()
    return "data:" + mime + ";base64," + base64.b64encode(b).decode("ascii")


def _text_of_blob(path, orig):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            t = f.read(TEXT_INLINE_LIMIT + 1)
    except Exception:
        return "[File: %s - unreadable]" % orig
    if len(t) > TEXT_INLINE_LIMIT:
        t = t[:TEXT_INLINE_LIMIT] + "\n… (truncated at 300 KB)"
    return t


# ---------------------------------------------------------------------------
# Video -> frames (the PolyStrata/mtmd convention: [Video N] + <X.X seconds>
# + one image_url part per frame, so the model sees a SEQUENCE)
# ---------------------------------------------------------------------------

def _video_frames(path, cfg):
    """Returns (frames, None) with frames = [(seconds, jpeg_path)] or
    ([], reason) when ffmpeg is unavailable / failed. Requires ffmpeg
    (ffprobe optional - the duration falls back to a 1 fps scan)."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return [], "ffmpeg not found on the ComfyUI server - video is unavailable"
    out_dir = os.path.join(os.path.dirname(path), "_vid_" + os.path.basename(path).replace(".", "_"))
    try:
        shutil.rmtree(out_dir, ignore_errors=True)
        os.makedirs(out_dir, exist_ok=True)
        want = max(2, int(cfg.get("video_frames") or 16))
        max_side = int(cfg.get("video_max_side") or 768)
        dur = None
        fp = shutil.which("ffprobe")
        if fp:
            try:
                import subprocess
                cp = subprocess.run(
                    [fp, "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=nw=1:nk=1", path],
                    capture_output=True, text=True, timeout=30)
                dur = float(cp.stdout.strip())
            except Exception:
                dur = None
        if not dur or dur <= 0:
            fps = 1.0  # unknown duration - one frame per second, capped
        else:
            fps = min(want / max(dur, 0.1), 4.0)
        vf = "fps=%s,scale='min(%d,iw)':-2" % (("%.3f" % fps), max_side)
        import subprocess
        cp = subprocess.run(
            [ff, "-v", "error", "-i", path, "-vf", vf, "-frames:v", str(want),
             "-q:v", "7", os.path.join(out_dir, "f_%04d.jpg")],
            capture_output=True, text=True, timeout=120)
        names = sorted(os.listdir(out_dir)) if os.path.isdir(out_dir) else []
        frames = []
        for i, n in enumerate(names):
            if not n.endswith(".jpg"):
                continue
            t = (i + 0.5) / fps if fps > 0 else float(i)
            frames.append((round(t, 1), os.path.join(out_dir, n)))
        if not frames:
            return [], "ffmpeg produced no frames for this video"
        return frames, None
    except Exception as e:
        shutil.rmtree(out_dir, ignore_errors=True)
        return [], "video frame extraction failed: %s" % e
    finally:
        pass


# ---------------------------------------------------------------------------
# Upstream payload building (pure, unit-tested)
# ---------------------------------------------------------------------------

def _media_window(session_msgs, cfg):
    """The number of TRAILING messages allowed to carry real media parts
    (media_depth); older ones degrade to a text note (frames are expensive)."""
    return max(0, int(cfg.get("media_depth") or 0))


def build_upstream_messages(session_msgs, cfg, sid):
    """history -> OpenAI chat messages. The last ctx_depth messages go in;
    within the trailing media window image/video parts become real
    content parts (image_url with base64 data-URLs), older ones become a
    '[image: name]' note appended to the text. Text-like FILE parts always
    go in inline (capped) - they are cheap compared to frames."""
    depth = max(1, int(cfg.get("ctx_depth") or 12))
    window = _media_window(session_msgs, cfg)
    n = len(session_msgs)
    out = []
    for i, msg in enumerate(session_msgs[-depth:]):
        pos = n - len(session_msgs[-depth:]) + i  # absolute index
        in_window = pos >= n - window
        text = str(msg.get("text") or "")
        parts = msg.get("parts") or []
        media_parts = [p for p in parts if p.get("kind") in ("image", "video")]
        file_parts = [p for p in parts if p.get("kind") == "file"]
        for fp in file_parts:
            path = os.path.join(_blobs_dir(sid), fp.get("name") or "")
            orig = _sanitize_orig(fp.get("orig") or fp.get("name") or "file")
            if os.path.isfile(path) and _ext_of(fp.get("name")) in _TEXT_LIKE:
                text += ("\n\n" if text else "") + "[File: %s]\n%s" % (orig, _text_of_blob(path, orig))
            else:
                text += ("\n\n" if text else "") + "[File: %s (binary, not shown)]" % orig
        stripped = []
        content = []
        if text:
            content.append({"type": "text", "text": text})
        if media_parts and in_window:
            for vi, p in enumerate(media_parts):
                path = os.path.join(_blobs_dir(sid), p.get("name") or "")
                orig = _sanitize_orig(p.get("orig") or p.get("name") or "media")
                ext = _ext_of(p.get("name"))
                if not os.path.isfile(path):
                    stripped.append("[%s: %s (missing)]" % (p.get("kind"), orig))
                    continue
                if p.get("kind") == "image" and ext in _IMG_EXT:
                    content.append({"type": "text", "text": "[Image %d]" % (vi + 1)})
                    content.append({"type": "image_url", "image_url": {
                        "url": _data_url(path, _IMG_EXT[ext])}})
                elif p.get("kind") == "video" and ext in _VID_EXT:
                    frames, err = _video_frames(path, cfg)
                    if err:
                        stripped.append("[video: %s (%s)]" % (orig, err))
                        continue
                    content.append({"type": "text", "text": "[Video %d]" % (vi + 1)})
                    for secs, fpath in frames:
                        content.append({"type": "text", "text": "<%.1f seconds>" % secs})
                        content.append({"type": "image_url", "image_url": {
                            "url": _data_url(fpath, "image/jpeg")}})
                else:
                    stripped.append("[%s: %s]" % (p.get("kind"), orig))
        elif media_parts:
            for p in media_parts:
                stripped.append("[%s: %s (older than the media window)]"
                                % (p.get("kind"), _sanitize_orig(p.get("orig") or "media")))
        if stripped:
            note = (" " if text else "") + " ".join(stripped)
            if content and content[0].get("type") == "text":
                content[0]["text"] += note
            else:
                content.insert(0, {"type": "text", "text": note.strip()})
        if not content:
            content = [{"type": "text", "text": "(empty)"}]
        out.append({"role": msg.get("role") or "user", "content": content})
    return out


def build_upstream_payload(session_msgs, cfg, sid, stream=False, model=""):
    """The full /chat/completions body: history + sampling + reasoning knobs.
    reasoning 'none' maps to chat_template_kwargs.enable_thinking=false (the
    llama.cpp / vLLM convention PolyStrata speaks); low/medium/high map to
    the OpenAI-style reasoning_effort field."""
    msgs = build_upstream_messages(session_msgs, cfg, sid)
    sp = str(cfg.get("system_prompt") or "").strip()
    if sp:
        msgs.insert(0, {"role": "system", "content": sp})
    body = {
        "model": str(model or cfg.get("model") or ""),
        "messages": msgs,
        "temperature": float(cfg.get("temperature")),
        "top_p": float(cfg.get("top_p")),
        "stream": bool(stream),
    }
    mt = int(cfg.get("max_tokens") or 0)
    if mt > 0:
        body["max_tokens"] = mt
    r = cfg.get("reasoning")
    if r == "none":
        body["chat_template_kwargs"] = {"enable_thinking": False}
    elif r in ("low", "medium", "high"):
        body["reasoning_effort"] = r
    return body


def parse_upstream_response(j):
    """OpenAI non-stream response -> normalized reply dict."""
    ch = (j.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    usage = j.get("usage") or {}
    return {
        "text": str(msg.get("content") or ""),
        "thoughts": str(msg.get("reasoning_content") or ""),
        "model": str(j.get("model") or ""),
        "finish": str(ch.get("finish_reason") or ""),
        "usage": {k: usage.get(k) for k in
                  ("prompt_tokens", "completion_tokens", "total_tokens")
                  if usage.get(k) is not None},
    }


# ---------------------------------------------------------------------------
# v87 VRAM management - the PolyStrata node mechanics, ported to the proxy.
# Two coordinated knobs:
#   1) the LLM SERVER keeps `reserve_mib` MiB of VRAM free (POST /v1/vram;
#      it remembers the value and re-applies it after engine restarts);
#   2) ComfyUI plans its own loads around the LLM's ACTUAL consumption
#      (comfy.model_management.EXTRA_RESERVED_VRAM - the llama.cpp-node
#      method update_global_vram_reservation); releasing restores the
#      original value. Both are best-effort: any failure degrades to a
#      note, never to a broken chat/generation.
# ---------------------------------------------------------------------------

_COMFY_EXTRA_ORIG = {"bytes": None}   # EXTRA_RESERVED_VRAM before our booking


def _comfy_mm():
    """comfy.model_management or None (tests / odd installs)."""
    try:
        import comfy.model_management as mm
        return mm
    except Exception:
        return None


def _comfy_reserve_from_bytes(used_bytes):
    """Tell ComfyUI's model planner about the LLM's consumption (bytes).
    Returns a human note; never raises."""
    try:
        used = int(used_bytes or 0)
    except Exception:
        used = 0
    if used <= 0:
        return "LLM consumption unknown - ComfyUI reservation not set"
    mm = _comfy_mm()
    if mm is None:
        return "comfy.model_management unavailable - reservation not set"
    try:
        if _COMFY_EXTRA_ORIG["bytes"] is None:
            _COMFY_EXTRA_ORIG["bytes"] = int(getattr(mm, "EXTRA_RESERVED_VRAM", 0) or 0)
        mm.EXTRA_RESERVED_VRAM = used
        # DynamicVRAM (comfy-aimdo) headroom, best-effort like PolyStrata does
        aimdo_note = ""
        try:
            enabled = False
            for mod in ("comfy.memory_management", "comfy.model_management"):
                try:
                    m = __import__(mod, fromlist=["aimdo_enabled"])
                    if getattr(m, "aimdo_enabled", False):
                        enabled = True
                        break
                except Exception:
                    pass
            if enabled:
                import comfy_aimdo.control as aimdo
                if getattr(aimdo, "lib", None) is not None:
                    aimdo.set_simple_vram_headroom(used)
                    aimdo_note = " + DynamicVRAM headroom"
        except Exception:
            pass
        return "ComfyUI plans around %d MiB (EXTRA_RESERVED_VRAM%s)" % (
            used >> 20, aimdo_note)
    except Exception as e:
        return "ComfyUI reservation failed (%s)" % e


def _comfy_reserve_release():
    """Restore the ORIGINAL EXTRA_RESERVED_VRAM (after unload/release)."""
    mm = _comfy_mm()
    if mm is None or _COMFY_EXTRA_ORIG["bytes"] is None:
        return "ComfyUI reservation: nothing to release"
    try:
        orig = _COMFY_EXTRA_ORIG["bytes"]
        cur = int(getattr(mm, "EXTRA_RESERVED_VRAM", 0) or 0)
        if cur != orig:
            mm.EXTRA_RESERVED_VRAM = orig
            note = "ComfyUI reservation restored (%d -> %d MiB)" % (cur >> 20, orig >> 20)
        else:
            note = "ComfyUI reservation already original"
        _COMFY_EXTRA_ORIG["bytes"] = None
        return note
    except Exception as e:
        return "ComfyUI reservation release failed (%s)" % e


def _comfy_free_memory():
    """ComfyUI's own 'Free model and node cache' button: unload its models,
    empty the torch cache, gc. The LLM server is NOT touched. Returns a
    human note; never raises."""
    mm = _comfy_mm()
    if mm is None:
        return "comfy.model_management unavailable (not running inside ComfyUI?)"
    notes = []
    unload = getattr(mm, "unload_all_models", None)
    if callable(unload):
        try:
            unload()
            notes.append("ComfyUI models unloaded")
        except Exception as e:
            notes.append("unload failed: %s" % e)
    else:
        notes.append("unload_all_models missing in this ComfyUI")
    cache_fn = getattr(mm, "soft_empty_cache", None) or getattr(mm, "empty_cache", None)
    if callable(cache_fn):
        try:
            cache_fn()
            notes.append("torch cache cleared")
        except Exception as e:
            notes.append("cache clear failed: %s" % e)
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    return "; ".join(notes) or "nothing done"


def _vram_status_snapshot(st):
    """Extract a compact GPU picture from an upstream /v1/status dict."""
    if not isinstance(st, dict):
        return None
    gpu = (st.get("machine") or {}).get("gpu") or {}
    vram = st.get("vram") or {}
    return {
        "model": st.get("model") or "",
        "loaded": bool(st.get("loaded")),
        "free_mib": vram.get("vram_free_mib") if vram.get("vram_free_mib") is not None
                    else gpu.get("free_mib"),
        "total_mib": gpu.get("total_mib"),
        "elastic": bool(vram.get("elastic")),
    }


async def _upstream_status(cfg, http=None):
    """GET {base}/v1/status -> dict | None. When `http` (a ClientSession) is
    given it is USED, not closed - the caller owns its lifetime."""
    if aiohttp is None or not cfg.get("url"):
        return None
    try:
        timeout = aiohttp.ClientTimeout(total=PROBE_TIMEOUT_S, sock_connect=10)
        if http is not None:
            async with http.get(cfg["url"] + "/status", headers=_upstream_headers(cfg)) as r:
                return await r.json(content_type=None) if r.status == 200 else None
        async with aiohttp.ClientSession(timeout=timeout) as http2:
            async with http2.get(cfg["url"] + "/status", headers=_upstream_headers(cfg)) as r:
                return await r.json(content_type=None) if r.status == 200 else None
    except Exception:
        return None


async def _upstream_vram(cfg, mib_or_none, timeout_s=120):
    """POST {base}/v1/vram {"reserve_mib": mib_or_none}. Returns
    (ok, data|None, error|None)."""
    if aiohttp is None or not cfg.get("url"):
        return False, None, "no LLM server configured"
    try:
        timeout = aiohttp.ClientTimeout(total=timeout_s, sock_connect=15)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(cfg["url"] + "/vram",
                                 json={"reserve_mib": mib_or_none},
                                 headers=_upstream_headers(cfg)) as r:
                txt = await r.text()
                if r.status != 200:
                    return False, None, "HTTP %s - %s" % (r.status, txt[:200])
                try:
                    return True, json.loads(txt), None
                except Exception:
                    return True, None, None
    except Exception as e:
        return False, None, str(e)


async def _upstream_unload(cfg, wait_s=0.0, timeout_s=300):
    """POST {base}/v1/unload[?wait=N] - the engine stops, ALL of its VRAM is
    freed, the server stays alive. Returns (ok, error|None)."""
    if aiohttp is None or not cfg.get("url"):
        return False, "no LLM server configured"
    try:
        params = {"wait": wait_s} if wait_s and float(wait_s) > 0 else None
        timeout = aiohttp.ClientTimeout(total=timeout_s, sock_connect=15)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(cfg["url"] + "/unload", params=params,
                                 headers=_upstream_headers(cfg)) as r:
                if r.status == 200:
                    return True, None
                return False, "HTTP %s - %s" % (r.status, (await r.text())[:200])
    except Exception as e:
        return False, str(e)


def _apply_reserve_note(vram_ok, vram_data, vram_err, st):
    """Human-readable result line for the GPU menu (the PolyStrata node
    wording): the target vs the ACTUALLY free VRAM, partial eviction named."""
    if not vram_ok:
        return "RESERVE NOT APPLIED: %s" % (vram_err or "upstream error")
    target = None
    snap = _vram_status_snapshot(st) if st else None
    free = snap.get("free_mib") if snap else None
    try:
        if isinstance(vram_data, dict):
            target = vram_data.get("reserve_mib", vram_data.get("target_mib"))
            free = vram_data.get("vram_free_mib", free)
    except Exception:
        pass
    if isinstance(vram_data, dict) and vram_data.get("status") == "not loaded":
        return "model asleep - %s MiB recorded, applies on the next load" % (target if target is not None else "?")
    if free is not None and target is not None:
        try:
            if float(free) + 0.5 < float(target):
                return "target %s MiB, free %s MiB - PARTIAL (expert cache exhausted; Unload gives it all back)" % (target, free)
            return "target %s MiB, free %s MiB - OK" % (target, free)
        except Exception:
            pass
    return "reserve applied"


async def _auto_reserve_for_send(cfg):
    """cfg.vram_reserve_mib > 0: re-apply the reserve before a generation and
    sync ComfyUI's planner with the LLM's ACTUAL consumption. Best-effort:
    every failure is swallowed (a reserve is a wish, never a condition)."""
    mib = int(cfg.get("vram_reserve_mib") or 0)
    if mib <= 0:
        return
    try:
        ok, _data, _err = await _upstream_vram(cfg, mib, timeout_s=60)
        if not ok:
            return
        st = await _upstream_status(cfg)
        snap = _vram_status_snapshot(st)
        total, free = (snap or {}).get("total_mib"), (snap or {}).get("free_mib")
        if total and free is not None and not (snap or {}).get("loaded"):
            return  # asleep - nothing on GPU to plan around
        if total and free is not None:
            used = max(0, (int(total) - int(free)) << 20)
            if used > 0:
                _comfy_reserve_from_bytes(used)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Upstream HTTP
# ---------------------------------------------------------------------------

def _upstream_headers(cfg):
    h = {"Content-Type": "application/json"}
    if cfg.get("key"):
        h["Authorization"] = "Bearer " + cfg["key"]
    return h


def _upstream_unconfigured():
    return web.json_response(
        {"ok": False, "error": "no LLM server configured - set the URL in "
                               "⚙ Hub settings → Chat", "code": "noconfig"},
        status=400)


class _ClientGone(Exception):
    pass


async def _await_upstream(request, coro):
    """Await an upstream task but cancel it as soon as the BROWSER side goes
    away (PolyStrata treats a closed socket as 'client went away' and frees
    the engine slot). Polls every 0.5 s."""
    task = asyncio.ensure_future(coro)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if done:
                return task.result()
            tr = getattr(request, "transport", None)
            if tr is not None and tr.is_closing():
                raise _ClientGone()
    except _ClientGone:
        task.cancel()
        try:
            await task
        except Exception:
            pass
        raise
    except Exception:
        task.cancel()
        try:
            await task
        except Exception:
            pass
        raise


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _jerr(msg, status=400, **extra):
    return web.json_response(dict({"ok": False, "error": msg}, **extra), status=status)


def _sid_from(request, body=None):
    sid = ""
    if body and isinstance(body, dict):
        sid = str(body.get("session") or "")
    if not sid:
        sid = request.query.get("session") or ""
    if not _SID_RE.match(sid):
        return None
    return sid


# ---------------------------------------------------------------------------
# Route registration - the py_test stubs `server` in sys.modules BEFORE this
# module is imported, so the registrar only records handlers there.
# ---------------------------------------------------------------------------

from server import PromptServer  # noqa: E402


@PromptServer.instance.routes.get("/settings_hub/chat/root")
async def chat_root_get(request):
    return web.json_response({
        "ok": True, "root": _chat_root(), "custom": _root_custom or "",
        "default": os.path.join(_user_dir(), "settings_hub", "chat"),
        "writable": _probe_writable(_chat_root()),
    })


@PromptServer.instance.routes.post("/settings_hub/chat/root")
async def chat_root_set(request):
    """v84 stack-root mechanics: an ABSOLUTE path re-points the store (probe
    before switch), "" returns to the default, entries are NEVER moved."""
    global _root_custom
    try:
        body = await request.json()
    except Exception:
        return _jerr("bad json")
    path, err = _clean_root_candidate((body or {}).get("path"))
    if err:
        return _jerr(err)
    if not path:
        _root_custom = None
        saved = _save_root_override()
        return web.json_response({"ok": True, "root": _chat_root(), "custom": "",
                                  "default": os.path.join(_user_dir(), "settings_hub", "chat"),
                                  "writable": _probe_writable(_chat_root()), "saved": saved})
    _root_custom = path
    if not _probe_writable(path):
        _root_custom = None
        return _jerr("folder is not writable: " + path)
    saved = _save_root_override()
    return web.json_response({"ok": True, "root": _chat_root(), "custom": path,
                              "default": os.path.join(_user_dir(), "settings_hub", "chat"),
                              "writable": True, "saved": saved})


@PromptServer.instance.routes.get("/settings_hub/chat/health")
async def chat_health(request):
    root = _chat_root()
    cfg = _load_config()
    return web.json_response({
        "ok": True, "version": CHAT_SERVER_VERSION,
        "dir": root, "custom": bool(_root_custom),
        "default": os.path.join(_user_dir(), "settings_hub", "chat"),
        "writable": _probe_writable(root),
        "sessions": len(_list_sessions()),
        "configured": bool(cfg.get("url")),
        "has_ffmpeg": _has_ffmpeg(),
        "model": cfg.get("model") or "",
        "url": cfg.get("url") or "",
    })


@PromptServer.instance.routes.get("/settings_hub/chat/config")
async def chat_config_get(request):
    return web.json_response({"ok": True, "config": _masked_config(_load_config())})


@PromptServer.instance.routes.post("/settings_hub/chat/config")
async def chat_config_set(request):
    try:
        body = await request.json()
    except Exception:
        return _jerr("bad json")
    if not isinstance(body, dict):
        return _jerr("bad body")
    cfg = _load_config()
    if "key" in body:
        k = body.get("key")
        cfg["key"] = str(k or "").strip()  # "" clears
    if "url" in body:
        u = _clean_url(body.get("url"))
        if u and not _URL_RE.match(u):
            return _jerr("URL must start with http:// or https://")
        cfg["url"] = u
    if "reasoning" in body:
        r = str(body.get("reasoning") or "default")
        if r not in _REASONS:
            return _jerr("bad reasoning value")
        cfg["reasoning"] = r
    if "stream" in body:
        cfg["stream"] = bool(body.get("stream"))
    for k in ("model", "system_prompt"):
        if k in body:
            cfg[k] = str(body.get(k) or "")[:8000]
    for k, (lo, hi) in _CONFIG_NUM_RANGES.items():
        if k in body:
            try:
                v = float(body.get(k))
            except Exception:
                return _jerr("bad number for " + k)
            if isinstance(DEFAULT_CONFIG[k], int) and float(v).is_integer():
                v = int(v)
            cfg[k] = min(hi, max(lo, v))
    try:
        _save_config(cfg)
    except Exception as e:
        return _jerr("could not save config: %s" % e, 500)
    return web.json_response({"ok": True, "config": _masked_config(cfg)})


@PromptServer.instance.routes.post("/settings_hub/chat/test")
async def chat_test(request):
    cfg = _load_config()
    base = cfg.get("url") or ""
    if not base:
        return _jerr("no LLM server configured - set the URL first")
    if aiohttp is None:
        return _jerr("aiohttp missing", 500)
    out = {"ok": False, "models": [], "current": "", "status": None}
    try:
        timeout = aiohttp.ClientTimeout(total=PROBE_TIMEOUT_S, sock_connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.get(base + "/models", headers=_upstream_headers(cfg)) as r:
                txt = await r.text()
                if r.status != 200:
                    return web.json_response(dict(out, ok=False, error=(
                        "HTTP %s from %s/models - %s" % (r.status, base, txt[:200]))))
                try:
                    j = json.loads(txt)
                except Exception:
                    return web.json_response(dict(out, ok=False, error="not JSON from /models"))
                data = j.get("data") if isinstance(j, dict) else None
                for m in (data or []):
                    if isinstance(m, dict) and m.get("id"):
                        out["models"].append(str(m["id"]))
                    elif isinstance(m, str):
                        out["models"].append(m)
            try:
                async with http.get(base + "/status", headers=_upstream_headers(cfg)) as r:
                    if r.status == 200:
                        out["status"] = await r.json(content_type=None)
                        st = out["status"]
                        if isinstance(st, dict) and st.get("model"):
                            out["current"] = str(st.get("model"))
            except Exception:
                pass
    except asyncio.TimeoutError:
        return web.json_response(dict(out, ok=False, error="timeout reaching " + base))
    except Exception as e:
        return web.json_response(dict(out, ok=False, error="connect failed: %s" % e))
    out["ok"] = True
    return web.json_response(out)


@PromptServer.instance.routes.post("/settings_hub/chat/load")
async def chat_load(request):
    """Switch the upstream model (PolyStrata: POST /v1/load - may take MINUTES
    with a big model; the client shows its own progress and keeps the typed
    text)."""
    cfg = _load_config()
    if not cfg.get("url"):
        return _upstream_unconfigured()
    try:
        body = await request.json()
    except Exception:
        body = {}
    model = str((body or {}).get("model") or cfg.get("model") or "")
    if not model:
        return _jerr("no model given")
    if aiohttp is None:
        return _jerr("aiohttp missing", 500)
    timeout = aiohttp.ClientTimeout(total=PROBE_TIMEOUT_S, sock_connect=10)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(cfg["url"] + "/load", json={"model": model},
                                 headers=_upstream_headers(cfg)) as r:
                txt = (await r.text())[:300]
                return web.json_response({"ok": r.status == 200,
                                          "status": r.status, "answer": txt})
    except Exception as e:
        return _jerr("load failed: %s" % e, 502)


@PromptServer.instance.routes.get("/settings_hub/chat/gpu")
async def chat_gpu_get(request):
    """v87 GPU menu state: the upstream /v1/status picture + the configured
    reserve. Works even when the upstream is unreachable (upstream: null)."""
    cfg = _load_config()
    st = await _upstream_status(cfg)
    return web.json_response({
        "ok": True,
        "configured": bool(cfg.get("url")),
        "upstream": _vram_status_snapshot(st),
        "reserve_mib": int(cfg.get("vram_reserve_mib") or 0),
        "comfy_reserved": bool(_COMFY_EXTRA_ORIG["bytes"] is not None),
    })


@PromptServer.instance.routes.post("/settings_hub/chat/gpu")
async def chat_gpu_post(request):
    """v87 memory actions (the PolyStrata mechanics, no extra nodes needed):
        reserve {mib}   - POST /v1/vram {reserve_mib} + persist cfg +
                          ComfyUI EXTRA_RESERVED sync (actual consumption)
        release         - POST /v1/vram {reserve_mib: null} + restore
                          ComfyUI's original EXTRA_RESERVED + cfg = 0
        unload {wait?}  - POST /v1/unload, then a full release (the model
                          AND the reservation return their memory)
        load {model?}   - POST /v1/load {model} (PolyStrata wakes/switches;
                          may take minutes on a big model)
        free_comfy      - ComfyUI's own 'Free model and node cache' (its
                          models + torch cache + gc); the LLM is untouched
        status          - refresh (same as GET)
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    body = body if isinstance(body, dict) else {}
    action = str(body.get("action") or "")
    cfg = _load_config()
    notes = []

    if action == "free_comfy":
        notes.append(_comfy_free_memory())
        return web.json_response({"ok": True, "action": action, "notes": notes})

    if action == "status":
        st = await _upstream_status(cfg)
        return web.json_response({
            "ok": True, "action": action, "notes": notes,
            "upstream": _vram_status_snapshot(st),
            "reserve_mib": int(cfg.get("vram_reserve_mib") or 0),
        })

    if not cfg.get("url"):
        return _jerr("no LLM server configured - set the URL in the chat settings first")

    if action == "load":
        model = str(body.get("model") or cfg.get("model") or "")
        if not model:
            return _jerr("no model given")
        if aiohttp is None:
            return _jerr("aiohttp missing", 500)
        timeout = aiohttp.ClientTimeout(total=PROBE_TIMEOUT_S, sock_connect=10)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with http.post(cfg["url"] + "/load", json={"model": model},
                                     headers=_upstream_headers(cfg)) as r:
                    txt = (await r.text())[:300]
                    ok = r.status == 200
                    notes.append("load %s: %s" % (model, txt or ("HTTP %s" % r.status)))
                    return web.json_response({"ok": ok, "action": action, "notes": notes})
        except Exception as e:
            return _jerr("load failed: %s" % e, 502)

    if action == "reserve":
        try:
            mib = int(float(body.get("mib")))
        except Exception:
            return _jerr("bad mib")
        mib = max(0, min(mib, 131072))
        if mib <= 0:
            return await _gpu_release(cfg, notes)
        ok, data, err = await _upstream_vram(cfg, mib)
        st = await _upstream_status(cfg)
        notes.append(_apply_reserve_note(ok, data, err, st))
        if ok:
            cfg["vram_reserve_mib"] = mib
            try:
                _save_config(cfg)
            except Exception:
                notes.append("reserve remembered for this session only (config not saved)")
            snap = _vram_status_snapshot(st)
            total, free = (snap or {}).get("total_mib"), (snap or {}).get("free_mib")
            if total and free is not None:
                used = max(0, (int(total) - int(free)) << 20)
                if used > 0:
                    notes.append(_comfy_reserve_from_bytes(used))
        return web.json_response({
            "ok": ok, "action": action, "notes": notes,
            "upstream": _vram_status_snapshot(st),
            "reserve_mib": int(_load_config().get("vram_reserve_mib") or 0),
        })

    if action == "release":
        return await _gpu_release(cfg, notes)

    if action == "unload":
        try:
            wait_s = float(body.get("wait") or 0)
        except Exception:
            wait_s = 0.0
        ok, err = await _upstream_unload(cfg, wait_s)
        notes.append("model unloaded - all of its VRAM is back"
                     if ok else "UNLOAD FAILED: %s" % (err or "?"))
        if ok:
            await _gpu_release(cfg, notes)  # the reservation returns too
        st = await _upstream_status(cfg)
        return web.json_response({
            "ok": ok, "action": action, "notes": notes,
            "upstream": _vram_status_snapshot(st),
            "reserve_mib": int(_load_config().get("vram_reserve_mib") or 0),
        })

    return _jerr("unknown action: %s" % (action or "(none)"))


async def _gpu_release(cfg, notes):
    """Shared release path: /v1/vram null (the server reserve returns to the
    startup state) + ComfyUI's EXTRA_RESERVED restored + cfg reset to 0."""
    ok, _data, err = await _upstream_vram(cfg, None)
    notes.append("server reserve released"
                 if ok else "reserve release failed: %s" % (err or "?"))
    notes.append(_comfy_reserve_release())
    if cfg.get("vram_reserve_mib"):
        cfg["vram_reserve_mib"] = 0
        try:
            _save_config(cfg)
        except Exception:
            pass
    st = await _upstream_status(cfg)
    return web.json_response({
        "ok": ok, "action": "release", "notes": notes,
        "upstream": _vram_status_snapshot(st),
        "reserve_mib": int(_load_config().get("vram_reserve_mib") or 0),
    })


@PromptServer.instance.routes.get("/settings_hub/chat/sessions")
async def chat_sessions_list(request):
    return web.json_response({"ok": True, "sessions": _list_sessions()})


@PromptServer.instance.routes.post("/settings_hub/chat/sessions")
async def chat_sessions_create(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    title = ""
    if isinstance(body, dict):
        title = str(body.get("title") or "")[:MAX_TITLE_CHARS]
    async with _lock:
        sess = _new_session(title)
        _ensure_dirs(sess["id"])
        _write_session(sess)
        _evict_sessions(_load_config().get("keep_sessions"))
    return web.json_response({"ok": True, "session": sess})


@PromptServer.instance.routes.get("/settings_hub/chat/session/{sid}")
async def chat_session_get(request):
    sid = request.match_info.get("sid") or ""
    if not _SID_RE.match(sid):
        return _jerr("bad session id")
    sess = _read_session(sid)
    if not sess:
        return _jerr("no such session", 404)
    return web.json_response({"ok": True, "session": sess})


@PromptServer.instance.routes.put("/settings_hub/chat/session/{sid}")
async def chat_session_rename(request):
    sid = request.match_info.get("sid") or ""
    if not _SID_RE.match(sid):
        return _jerr("bad session id")
    try:
        body = await request.json()
    except Exception:
        return _jerr("bad json")
    async with _lock:
        sess = _read_session(sid)
        if not sess:
            return _jerr("no such session", 404)
        sess["title"] = str(body.get("title") or "")[:MAX_TITLE_CHARS]
        sess["updated"] = int(time.time())
        _write_session(sess)
    return web.json_response({"ok": True, "session": sess})


@PromptServer.instance.routes.delete("/settings_hub/chat/session/{sid}")
async def chat_session_delete(request):
    sid = request.match_info.get("sid") or ""
    if not _SID_RE.match(sid):
        return _jerr("bad session id")
    async with _lock:
        shutil.rmtree(_session_dir(sid), ignore_errors=True)
    return web.json_response({"ok": True, "gone": sid})


@PromptServer.instance.routes.post("/settings_hub/chat/session/{sid}/clear")
async def chat_session_clear(request):
    sid = request.match_info.get("sid") or ""
    if not _SID_RE.match(sid):
        return _jerr("bad session id")
    async with _lock:
        sess = _read_session(sid)
        if not sess:
            return _jerr("no such session", 404)
        sess["messages"] = []
        sess["updated"] = int(time.time())
        _write_session(sess)
    return web.json_response({"ok": True, "session": sess})


@PromptServer.instance.routes.post("/settings_hub/chat/attach")
async def chat_attach(request):
    """Blob upload: raw bytes body, ?session=<sid>&kind=image|video|file&name=<orig>.
    The blob lands in sessions/<sid>/blobs/<hex>.<ext>; the message part that
    references it is stored by /send."""
    sid = _sid_from(request)
    if not sid:
        return _jerr("bad session id")
    kind = (request.query.get("kind") or "").lower()
    if kind not in _KIND_EXT:
        return _jerr("bad kind")
    orig = _sanitize_orig(request.query.get("name"))
    ext = _ext_of(orig)
    if ext not in _KIND_EXT[kind]:
        return _jerr("bad ext '%s' for kind %s" % (ext or "?", kind))
    cfg = _load_config()
    limit = min(int(cfg.get("max_file_mb") or DEFAULT_MAX_FILE_MB) * 1024 * 1024,
                MAX_BLOB_BYTES_HARD)
    payload = await request.read()
    if not payload:
        return _jerr("empty payload")
    if len(payload) > limit:
        return _jerr("file too large (limit %d MB)" % (limit // (1024 * 1024)), 413)
    async with _lock:
        sess = _read_session(sid)
        if not sess:
            return _jerr("no such session", 404)
        _ensure_dirs(sid)
        blob = uuid.uuid4().hex[:12] + "." + (ext or "bin")
        with open(os.path.join(_blobs_dir(sid), blob), "wb") as f:
            f.write(payload)
    return web.json_response({"ok": True, "name": blob, "orig": orig,
                              "size": len(payload), "kind": kind,
                              "mime": _FILE_MIME.get(ext, "application/octet-stream")})


@PromptServer.instance.routes.get("/settings_hub/chat/file/{sid}/{name}")
async def chat_file(request):
    sid = request.match_info.get("sid") or ""
    name = request.match_info.get("name") or ""
    if not _SID_RE.match(sid) or not _NAME_RE.match(name) or name in (".", ".."):
        return _jerr("bad path")
    path = os.path.join(_blobs_dir(sid), name)
    if not os.path.isfile(path):
        return _jerr("no such file", 404)
    mime = _FILE_MIME.get(_ext_of(name), "application/octet-stream")
    return web.FileResponse(path, headers={"Content-Type": mime})


# ---------------------------------------------------------------------------
# POST /send - the proxy core
# ---------------------------------------------------------------------------

async def _emit_sse(resp, ev):
    """Write one SSE event; False = the browser side is gone."""
    try:
        await resp.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode("utf-8"))
        return True
    except Exception:
        return False


@PromptServer.instance.routes.post("/settings_hub/chat/send")
async def chat_send(request):
    try:
        body = await request.json()
    except Exception:
        return _jerr("bad json")
    if not isinstance(body, dict):
        return _jerr("bad body")
    cfg = _load_config()
    if not cfg.get("url"):
        return _upstream_unconfigured()
    if aiohttp is None:
        return _jerr("aiohttp missing", 500)
    sid = _sid_from(request, body)
    if not sid:
        return _jerr("bad session id")
    model = str(body.get("model") or cfg.get("model") or "")
    if not model:
        return _jerr("no model selected - pick one in ⚙ Hub settings → Chat")
    stream = bool(body.get("stream", cfg.get("stream", True)))

    async with _lock:
        sess = _read_session(sid)
        if not sess:
            return _jerr("no such session", 404)
        now = int(time.time())
        msgs = sess["messages"]

        # --- mutate the history per the request kind ------------------------
        if body.get("edit_index") is not None:
            try:
                idx = int(body.get("edit_index"))
            except Exception:
                return _jerr("bad edit_index")
            if idx < 0 or idx >= len(msgs) or msgs[idx].get("role") != "user":
                return _jerr("edit_index does not point at a user message")
            new_text = str(body.get("text") if body.get("text") is not None
                           else msgs[idx].get("text") or "")
            if len(new_text) > MAX_MESSAGE_CHARS:
                return _jerr("text too large", 413)
            msgs[idx]["text"] = new_text
            del msgs[idx + 1:]
            for m in msgs:
                m.pop("stopped", None)
        elif body.get("regenerate"):
            if msgs and msgs[-1].get("role") == "assistant":
                msgs.pop()
        else:
            text = str(body.get("text") or "").strip()
            atts = body.get("attachments") or []
            if not isinstance(atts, list):
                return _jerr("bad attachments")
            parts = []
            for a in atts[:8]:
                if not isinstance(a, dict):
                    continue
                kind = str(a.get("kind") or "")
                name = str(a.get("name") or "")
                if kind not in _KIND_EXT or not _NAME_RE.match(name):
                    continue
                if not os.path.isfile(os.path.join(_blobs_dir(sid), name)):
                    continue
                parts.append({"kind": kind, "name": name,
                              "orig": _sanitize_orig(a.get("orig") or name),
                              "size": int(a.get("size") or 0)})
            if not text and not parts:
                return _jerr("empty message")
            if len(text) > MAX_MESSAGE_CHARS:
                return _jerr("text too large", 413)
            msgs.append({"role": "user", "text": text, "parts": parts, "ts": now})

        # auto title from the first user text
        if not sess.get("title"):
            for m in msgs:
                if m.get("role") == "user" and (m.get("text") or "").strip():
                    sess["title"] = m["text"].strip()[:MAX_TITLE_CHARS]
                    break
        sess["updated"] = now
        _write_session(sess)  # the user message survives an upstream error

        payload = build_upstream_payload(sess["messages"], cfg, sid,
                                         stream=stream, model=model)
        url = cfg["url"] + "/chat/completions"
        headers = _upstream_headers(cfg)
        timeout = aiohttp.ClientTimeout(total=int(cfg.get("timeout_s") or DEFAULT_TIMEOUT_S),
                                        sock_connect=30)

    # --- upstream call (OUTSIDE the storage lock - generation is slow) -----
    # v87: when a reserve is configured, re-apply it BEFORE waking the model
    # (the "reserve when a model loads in PolyStrata" guarantee; best-effort).
    try:
        await _auto_reserve_for_send(cfg)
    except Exception:
        pass
    if not stream:
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async def call():
                async with http.post(url, json=payload, headers=headers) as r:
                    return r.status, await r.text()
            try:
                status, txt = await _await_upstream(request, call())
            except _ClientGone:
                return web.Response(status=499, text="client gone")
            except asyncio.TimeoutError:
                return _jerr("upstream timeout after %d s" % int(cfg.get("timeout_s")),
                             504, code="timeout")
            except Exception as e:
                return _jerr("connect failed: %s" % e, 502, code="connect")
        if status != 200:
            try:
                jerr = json.loads(txt).get("error", {})
                msg = jerr.get("message") if isinstance(jerr, dict) else str(jerr)
            except Exception:
                msg = txt[:300]
            return _jerr("HTTP %s from the LLM server: %s" % (status, msg or "?"),
                         502, code="upstream")
        try:
            reply = parse_upstream_response(json.loads(txt))
        except Exception:
            return _jerr("unparsable answer from the LLM server", 502, code="parse")
        async with _lock:
            sess = _read_session(sid) or sess
            reply["ms"] = int((time.time() - now) * 1000)
            assistant = {"role": "assistant", "text": reply["text"], "ts": int(time.time())}
            if reply.get("thoughts"):
                assistant["thoughts"] = reply["thoughts"]
            for k in ("usage", "model", "ms", "finish"):
                if reply.get(k):
                    assistant[k] = reply[k]
            sess["messages"].append(assistant)
            sess["updated"] = int(time.time())
            _write_session(sess)
            _evict_sessions(cfg.get("keep_sessions"))
        return web.json_response({"ok": True, "session": sess, "reply": reply})

    # --- SSE streaming ------------------------------------------------------
    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(request)
    acc, th_acc, stopped, err = "", "", False, None
    t0 = time.time()
    try:
        http = aiohttp.ClientSession(timeout=timeout)
        try:
            upstream = await http.post(url, json=payload, headers=headers)
        except Exception as e:
            await http.close()
            err = "connect failed: %s" % e
            await _emit_sse(resp, {"error": err})
            await resp.write_eof()
            return resp
        if upstream.status != 200:
            txt = await upstream.text()
            try:
                jerr = json.loads(txt).get("error", {})
                msg = jerr.get("message") if isinstance(jerr, dict) else str(jerr)
            except Exception:
                msg = txt[:300]
            await http.close()
            await _emit_sse(resp, {"error": "HTTP %s: %s" % (upstream.status, msg or "?")})
            await resp.write_eof()
            return resp
        buf = ""
        saw_done = False
        try:
            async for chunk in upstream.content.iter_any():
                buf += chunk.decode("utf-8", "replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        saw_done = True
                        buf = ""
                        break
                    try:
                        j = json.loads(data)
                    except Exception:
                        continue
                    delta = ((j.get("choices") or [{}])[0].get("delta") or {})
                    if delta.get("content"):
                        acc += delta["content"]
                        if not await _emit_sse(resp, {"delta": delta["content"]}):
                            stopped = True
                            break
                    if delta.get("reasoning_content"):
                        th_acc += delta["reasoning_content"]
                        if not await _emit_sse(resp, {"thoughts": delta["reasoning_content"]}):
                            stopped = True
                            break
                tr = getattr(request, "transport", None)
                if stopped or (tr is not None and tr.is_closing()):
                    stopped = True
                    break
        except asyncio.TimeoutError:
            err = "upstream timeout after %d s" % int(cfg.get("timeout_s"))
            await _emit_sse(resp, {"error": err})
        except Exception:
            stopped = True  # network hiccup / client vanished mid-stream
        finally:
            try:
                upstream.release()
            except Exception:
                pass
            try:
                await http.close()  # closes the socket -> upstream cancels
            except Exception:
                pass
        reply = {"text": acc, "thoughts": th_acc, "model": model,
                 "usage": {}, "ms": int((time.time() - t0) * 1000),
                 "stopped": bool(stopped or not saw_done)}
        async with _lock:
            sess = _read_session(sid) or sess
            assistant = {"role": "assistant", "text": acc, "ts": int(time.time())}
            if th_acc:
                assistant["thoughts"] = th_acc
            assistant["model"] = model
            assistant["ms"] = reply["ms"]
            if reply["stopped"]:
                assistant["stopped"] = True
            sess["messages"].append(assistant)
            sess["updated"] = int(time.time())
            _write_session(sess)
            _evict_sessions(cfg.get("keep_sessions"))
            reply["session"] = sess
        await _emit_sse(resp, {"done": True, "reply": reply})
        await resp.write_eof()
    except Exception:
        try:
            await resp.write_eof()
        except Exception:
            pass
    return resp


