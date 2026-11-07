// ============================================================================
// SettingsHub - Paste Stack (v71): standalone floating clipboard panel
// ----------------------------------------------------------------------------
// v71 BUILD GUARD (must be the FIRST executable statement, before any work):
// the loader entry stamps globalThis.__SettingsHubBuild before importing the
// submodules; this module refuses to stay silent if it was loaded as part of
// a MIXED build. See settings_hub.js for the field history.
// ============================================================================
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["stack"] = true;
if (globalThis.__SettingsHubBuild !== "v73") {
    console.error("[SettingsHub] STALE BUILD: stack.js (v73) was loaded under entry build [" +
        (globalThis.__SettingsHubBuild ?? "unknown") +
        "] - the browser served cached modules. Hard-refresh the page (Ctrl+F5).");
}

// ============================================================================
// A floating clipboard-history panel that lives ALONGSIDE the hub (owner
// decision 2026-11-08: a SEPARATE panel, not a hub tab). Modeled on Nougan's
// Paste Stack (research: docs/plan-paste-stack.md) with the storage decision
// REVERSED:
//
//   * Server-side persistence (py/stack_store.py): entries live in
//     <ComfyUI>/user/settings_hub/stack/ (index.json + items/) so the stack
//     travels with the ComfyUI folder. The browser is a thin client; the
//     server index is the source of truth. When the routes are missing the
//     panel degrades to a session-only in-memory stack and says so.
//
//   * Capture paths (v71):
//       - click the paste area  -> navigator.clipboard.read (secure ctx only),
//         and when that yields NOTHING the OS-clipboard helper is asked
//         (POST /settings_hub/clipboard - py/clipboard_helper.py reads the
//         clipboard of the machine ComfyUI runs on; this is the ONLY path
//         that sees files copied in Explorer and works on LAN http);
//       - Ctrl+V while hovering the panel -> paste event (text + files);
//         when the browser event carries nothing (files copied in Explorer
//         fire an empty paste) the OS helper is asked as well;
//       - drag & drop files FROM THE OS onto the panel (v71: any kind -
//         video/audio/text/binary - not just images);
//     v70 accepted text + images; v71 adds file cards of every kind.
//
//   * Cards: image thumbnails, text excerpts, VIDEO/AUDIO players, generic
//     file cards. File-ish cards carry [→] "into the first matching hub
//     media row" (uploads through the row's own pipeline) and [⤓] download.
//
//   * Drag an image card ONTO THE CANVAS: a Load-Image-style node under the
//     cursor is highlighted (Esc cancels); on drop the blob is uploaded via
//     /upload/image and written into the node's `image` combo (Nougan
//     mechanics). Dropping on a hub MEDIA MIRROR routes into that row.
//
//   * Dedup: re-adding the same content MOVES the existing card to the top
//     (server hash check) instead of stacking a copy.
//
//   * Copy-back: click a text/image card -> the content returns to the
//     system clipboard (writeText / ClipboardItem), then Ctrl+V anywhere.
//
//   * Limits: the client-configured max (gear popup "Stack" section) evicts
//     the OLDEST entries after each add; server hard caps (500 / 200 MB)
//     guard the storage regardless.
//
//   * UI: drag the header, resize from the bottom-right grip, [–] minimizes
//     to a chip with a live count badge, [✕] hides the panel (gear popup
//     "Stack" section brings it back). Position/size state in localStorage.
// ============================================================================

import { app } from "../../scripts/app.js";
import { stackBridge } from "./sync.js";

// ---------------------------------------------------------------------------
// Constants + tiny utils
// ---------------------------------------------------------------------------

const LS_UI = "settingshub.stack.ui";      // {x,y,w,h,min,chipX,chipY}
const LS_ON = "settingshub.stack.on";      // "1"/"0" - panel enabled
const LS_MAX = "settingshub.stack.max";    // client eviction threshold

export const STACK_MAX_CHOICES = [25, 50, 100, 200, 500];
const STACK_MAX_DEFAULT = 100;
const MAX_TEXT_CHARS = 1_000_000;      // mirrors py/stack_store.py
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const TEXT_EXCERPT = 260;
const IMG_EXT_OK = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const VID_EXT_OK = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);
const AUD_EXT_OK = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"]);
const TEXT_EXT_OK = new Set(["txt", "md", "json", "csv", "log", "xml", "yml", "yaml", "ini", "tsv"]);
const Z_PANEL = "99900";               // under project popups (100000), over canvas
const DRAG_THRESHOLD = 6;              // px before a card mousedown becomes a drag

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function lsUi() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_UI) || "{}");
        return v && typeof v === "object" ? v : {};
    } catch (_) { return {}; }
}

function saveUi(patch) {
    try { localStorage.setItem(LS_UI, JSON.stringify({ ...lsUi(), ...patch })); } catch (_) {}
}

function loadFilter() {
    const ui = lsUi();
    viewFilter = {
        q: typeof ui.filterQ === "string" ? ui.filterQ : "",
        kind: ["all", "text", "image", "file"].includes(ui.filterKind) ? ui.filterKind : "all",
        tag: typeof ui.filterTag === "string" && ui.filterTag ? ui.filterTag : null,
    };
}

function saveFilter() {
    saveUi({ filterQ: viewFilter.q, filterKind: viewFilter.kind, filterTag: viewFilter.tag });
}

function localToast(msg, ms = 2600) {
    try {
        const t = document.createElement("div");
        t.textContent = msg;
        Object.assign(t.style, {
            position: "fixed", left: "14px", bottom: "52px", zIndex: "999990",
            maxWidth: "440px", padding: "8px 12px", borderRadius: "8px",
            background: "rgba(24,28,38,0.95)", color: "#dfe6f5",
            border: "1px solid #3d5a80", font: "12px/1.45 system-ui, sans-serif",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)", userSelect: "none",
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms);
    } catch (_) {}
}

function fmtTime(ts) {
    try {
        const d = new Date((ts || 0) * 1000);
        return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (_) { return ""; }
}

function fmtBytes(n) {
    const v = Number(n || 0);
    if (v >= 1024 * 1024) return (Math.round(v / (1024 * 1024) * 10) / 10) + " MB";
    if (v >= 1024) return Math.max(1, Math.round(v / 1024)) + " KB";
    return v + " B";
}

function fileUrl(name) {
    const p = "/settings_hub/stack/file/" + encodeURIComponent(name || "");
    try { return app.api?.apiURL ? app.api.apiURL(p) : p; } catch (_) { return p; }
}

function extOf(name) {
    return String(name || "").split(".").pop().toLowerCase().slice(0, 8);
}

function classifyBlob(blob, name) {
    const type = String(blob?.type || "");
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("text/")) return "text";
    const ext = extOf(name || (blob && blob.name));
    if (IMG_EXT_OK.has(ext)) return "image";
    if (VID_EXT_OK.has(ext)) return "video";
    if (AUD_EXT_OK.has(ext)) return "audio";
    if (TEXT_EXT_OK.has(ext) || type === "application/json") return "text";
    return "file";
}

/** Blob -> text without relying on blob.text() existing (jsdom-safe). */
function blobText(blob) {
    if (blob && typeof blob.text === "function") return blob.text().then((t) => String(t ?? ""));
    return new Promise((res) => {
        try {
            const r = new FileReader();
            r.onload = () => res(String(r.result || ""));
            r.onerror = () => res("");
            r.readAsText(blob);
        } catch (_) { res(""); }
    });
}

function b64ToBlob(b64, mime) {
    try {
        const bin = atob(String(b64 || ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || "application/octet-stream" });
    } catch (_) { return null; }
}

/** Fetch a blob through the SAME api channel the panel already uses
 *  (fetchApi honours ComfyUI sub-path installs; raw fetch does not). */
async function fetchBlob(url) {
    try {
        const r = apiReady()
            ? await app.api.fetchApi(url)
            : await fetch(url);
        if (r && r.ok && typeof r.blob === "function") return await r.blob();
    } catch (_) {}
    return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panel = null;        // .hub-stack-panel root
let headEl = null, listEl = null, pasteEl = null, noteEl = null;
let toolsEl = null;      // v72: search + kind filter row
let chip = null;         // minimized chip
let grip = null;         // resize handle

let stackItems = [];     // server index mirror, TOP-first
let serverOk = null;     // null=unknown, true, false
let mounted = false;
let pasteHover = false;  // cursor over the panel (paste-event gate)
let clearArmTs = 0;      // clear-button double-confirm window
let initSeq = 0;         // guards against stale async fetches across re-init
let localSeq = 0;        // ids for session-only entries when the server is down
let justDragged = false; // a card drag just ended - swallow the trailing click
const localBlobs = new Map(); // id -> Blob for session-only entries

// v72: snippet view state (persisted with the rest of the panel UI state)
let viewFilter = { q: "", kind: "all", tag: null }; // kind: all|text|image|file
let editId = null;       // id of the card currently in the inline editor

// ---------------------------------------------------------------------------
// Settings surface (gear popup "Stack" section, hub_ui_renderer.js)
// ---------------------------------------------------------------------------

export function isStackOn() {
    try { const v = localStorage.getItem(LS_ON); return v == null ? true : v === "1"; }
    catch (_) { return true; }
}

export function setStackOn(v) {
    try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (_) {}
    if (v && !mounted) initStack();
    else if (!v) teardown();
}

export function getStackMax() {
    try {
        const n = parseInt(localStorage.getItem(LS_MAX), 10);
        if (Number.isFinite(n) && n >= 1) return Math.min(500, n);
        return STACK_MAX_DEFAULT;
    } catch (_) { return STACK_MAX_DEFAULT; }
}

export function setStackMax(v) {
    // The gear SELECT offers STACK_MAX_CHOICES, but a manually stored value
    // (tests, future sliders) is honored too: any int 1..500 is valid.
    const n = Math.min(500, Math.max(1, parseInt(v, 10) || STACK_MAX_DEFAULT));
    try { localStorage.setItem(LS_MAX, String(n)); } catch (_) {}
    enforceMax();
    return n;
}

/** Clears the whole stack on the server and locally. Used by the gear popup. */
export async function stackClearAllFlow() {
    const ok = await apiClear();
    if (ok) { stackItems = []; renderAll(); localToast("Stack cleared"); }
    else localToast("Stack clear failed - server unreachable");
    return ok;
}

// ---------------------------------------------------------------------------
// Server access (thin client; server index is the source of truth)
// ---------------------------------------------------------------------------

function apiReady() {
    const a = app?.api;
    return !!(a && typeof a.fetchApi === "function");
}

async function apiGet() {
    if (!apiReady()) return null;
    try {
        const r = await app.api.fetchApi("/settings_hub/stack");
        if (!r || !r.ok) return null;
        const j = await r.json();
        return Array.isArray(j?.items) ? j.items.filter((x) => x && x.id) : [];
    } catch (_) { return null; }
}

async function apiAddText(text, name) {
    try {
        const body = { text };
        if (name) body.name = String(name);
        const r = await app.api.fetchApi("/settings_hub/stack/item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r || !r.ok) return { ok: false };
        return await r.json();
    } catch (_) { return { ok: false }; }
}

async function apiAddImage(blob, ext, name) {
    try {
        const q = new URLSearchParams({ ext });
        if (name) q.set("name", String(name));
        const r = await app.api.fetchApi("/settings_hub/stack/image?" + q.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: blob,
        });
        if (!r || !r.ok) return { ok: false };
        return await r.json();
    } catch (_) { return { ok: false }; }
}

async function apiAddFile(blob, ext, name) {
    try {
        const q = new URLSearchParams({ ext, name: name || "" });
        const r = await app.api.fetchApi("/settings_hub/stack/file?" + q.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: blob,
        });
        if (!r || !r.ok) return { ok: false };
        return await r.json();
    } catch (_) { return { ok: false }; }
}

async function apiDelete(id) {
    if (!apiReady()) return false;
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/item/" + encodeURIComponent(id), { method: "DELETE" });
        return !!(r && r.ok);
    } catch (_) { return false; }
}

async function apiClear() {
    if (!apiReady()) return false;
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/clear", { method: "POST" });
        return !!(r && r.ok);
    } catch (_) { return false; }
}

/** v72: metadata edit (rename/tags/pin/uses). Resolves with the updated
 *  item from the server (or null when the route/entry is unavailable). */
async function apiPatch(id, patch) {
    if (!apiReady()) return null;
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/patch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...patch }),
        });
        if (!r || !r.ok) return null;
        const j = await r.json();
        return j?.item || null;
    } catch (_) { return null; }
}

function applyPatched(item) {
    if (!item || !item.id) return;
    stackItems = stackItems.map((x) => (x.id === item.id ? { ...x, ...item } : x));
    renderAll();
}

/** v72: fire-and-forget usage counter for copy-back / insert actions. */
function bumpUses(item) {
    if (!item || item.local || !apiReady()) return;
    apiPatch(item.id, { bumpUses: true }).then((it) => { if (it) applyPatched(it); }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Mutations + client-side eviction
// ---------------------------------------------------------------------------

function applyServerAdd(res, localFallback) {
    if (res && res.ok && res.item) {
        serverOk = true;
        // A moved duplicate keeps its id - refresh its position locally.
        stackItems = stackItems.filter((x) => x.id !== res.item.id);
        stackItems.unshift(res.item);
        renderAll();
        enforceMax();
        return true;
    }
    // Server unreachable: session-only fallback so capture still works.
    serverOk = false;
    stackItems.unshift(localFallback);
    renderAll();
    enforceMax();
    return true;
}

function localTextItem(text, name) {
    const it = { id: "local-" + (++localSeq), type: "text", text, created: Math.floor(Date.now() / 1000), local: true };
    if (name) it.name = String(name);
    return it;
}

function localImageItem(url, ext, name) {
    const it = { id: "local-" + (++localSeq), type: "image", localUrl: url, file: null, ext, created: Math.floor(Date.now() / 1000), local: true };
    if (name) it.name = String(name);
    return it;
}

function localFileItem(url, kind, ext, name) {
    const it = { id: "local-" + (++localSeq), type: kind || "file", localUrl: url, file: null, ext, created: Math.floor(Date.now() / 1000), local: true };
    if (name) it.name = String(name);
    return it;
}

/** The client max evicts the OLDEST tail (server hard caps guard the rest).
 *  v71: calls are SERIALIZED through a promise chain - applyServerAdd fires
 *  this without awaiting, and two rapid adds used to run concurrent loops
 *  that double-popped one server delete (client list shorter than the server
 *  index until the next reload). */
let enforceChain = Promise.resolve();

function enforceMax() {
    const run = enforceChain.then(() => evictLoop());
    enforceChain = run.catch(() => {});
    return run;
}

async function evictLoop() {
    const max = getStackMax();
    while (stackItems.length > max) {
        // v72: PINNED entries survive eviction - the oldest UNPINNED one goes.
        let idx = -1;
        for (let i = stackItems.length - 1; i >= 0; i--) {
            if (!stackItems[i].pinned) { idx = i; break; }
        }
        if (idx < 0) break; // everything pinned - the server caps still guard
        const victim = stackItems[idx];
        const ok = await apiDelete(victim.id);
        if (!ok && !victim.local) break; // server decides eviction when unreachable
        // v72: remove BY IDENTITY, not by the pre-await index - the array may
        // have been replaced/shifted while apiDelete was in flight (a server
        // refresh merge, another capture), and a stale index used to delete
        // the WRONG entry client-side while the server kept the real victim.
        const i2 = stackItems.indexOf(victim);
        if (i2 >= 0) stackItems.splice(i2, 1);
        renderAll();
    }
}

// ---------------------------------------------------------------------------
// Capture paths
// ---------------------------------------------------------------------------

async function addText(text, name) {
    const t = String(text ?? "");
    if (!t.trim()) return false;
    if (t.length > MAX_TEXT_CHARS) { localToast("Text too large (1M char limit)"); return false; }
    applyServerAdd(await apiAddText(t, name), localTextItem(t, name));
    if (serverOk === false) localToast("Stack not persisted - restart ComfyUI to enable storage");
    return true;
}

async function addImageBlob(blob, name) {
    if (!blob || !blob.size) return false;
    if (blob.size > MAX_BLOB_BYTES) { localToast("Image too large (25 MB limit)"); return false; }
    let ext = extOf(name);
    if (!IMG_EXT_OK.has(ext)) ext = blob.type === "image/jpeg" ? "jpg" : "png";
    const url = URL.createObjectURL(blob);
    const fallback = localImageItem(url, ext, name);
    const res = await apiAddImage(blob, ext, name);
    applyServerAdd(res, fallback);
    if (!res || !res.ok) localBlobs.set(fallback.id, blob); // session mode keeps the payload
    if (serverOk === false) localToast("Stack not persisted - restart ComfyUI to enable storage");
    return true;
}

async function addFileBlob(blob, name, forcedKind) {
    if (!blob || !blob.size) return false;
    if (blob.size > MAX_BLOB_BYTES) { localToast("File too large (25 MB limit)"); return false; }
    const kind = forcedKind || classifyBlob(blob, name);
    let ext = extOf(name);
    if (!ext || ext.length > 8) {
        ext = String(blob.type || "").split("/")[1] || "bin";
    }
    const url = URL.createObjectURL(blob);
    const fallback = localFileItem(url, kind, ext, name);
    const res = await apiAddFile(blob, ext, name);
    applyServerAdd(res, fallback);
    if (!res || !res.ok) localBlobs.set(fallback.id, blob); // session mode keeps the payload
    if (serverOk === false) localToast("Stack not persisted - restart ComfyUI to enable storage");
    return true;
}

/**
 * Core capture used by every path (paste event, clipboard.read, drop,
 * OS helper, tests). data: {text?: string, files?: FileList|Array} - v71
 * accepts files of EVERY kind (video/audio/text/binary); text files are
 * read and stored as text cards carrying the source name.
 */
async function captureFromClipboardData(data) {
    if (!data) return false;
    let captured = false;
    if (typeof data.text === "string") {
        captured = (await addText(data.text)) || captured;
    }
    const files = data.files;
    if (files && typeof files.length === "number" && files.length) {
        captured = (await captureFiles(Array.from(files).map((f) => ({ blob: f, name: f?.name || "" })))) || captured;
    }
    return captured;
}

/** Route a list of {blob, name} entries by kind (v71: every kind lands). */
async function captureFiles(entries) {
    let any = false;
    for (const ent of entries || []) {
        const blob = ent?.blob ?? ent;
        const name = ent?.name || blob?.name || "";
        if (!blob || typeof blob.size !== "number" || !blob.size) continue;
        const kind = classifyBlob(blob, name);
        if (kind === "image") {
            any = (await addImageBlob(blob, name)) || any;
        } else if (kind === "text") {
            const t = await blobText(blob);
            any = (await addText(t, name)) || any;
        } else {
            any = (await addFileBlob(blob, name, kind)) || any;
        }
    }
    return any;
}

/** Click on the paste area: read the system clipboard directly; when the
 *  browser sees nothing (or the API is unavailable - LAN http), fall back
 *  to the OS-clipboard helper served by ComfyUI itself. */
async function captureFromRead() {
    let any = false;
    let apiBlocked = false;
    try {
        if (!navigator.clipboard || typeof navigator.clipboard.read !== "function" || !window.isSecureContext) {
            apiBlocked = true;
        } else {
            const clips = await navigator.clipboard.read();
            for (const item of clips || []) {
                const types = item?.types || [];
                if (types.includes("text/plain")) {
                    const txt = await item.getType("text/plain").then((b) => b.text?.() ?? "");
                    if (txt && txt.trim()) { await addText(txt); any = true; }
                }
                const imgType = types.find((t) => String(t).startsWith("image/"));
                if (imgType) {
                    const blob = await item.getType(imgType);
                    await addImageBlob(blob, "clip." + (imgType.split("/")[1] || "png"));
                    any = true;
                }
            }
        }
    } catch (err) {
        apiBlocked = true;
    }
    if (any) return;
    const viaHelper = await captureFromOsHelper();
    if (!viaHelper && apiBlocked) {
        localToast("Nothing to capture - copy something first (or drop a file here)");
    }
}

/**
 * v71: ask the ComfyUI process for the OS clipboard (files copied in
 * Explorer, screenshots, LAN-http contexts where the browser Clipboard API
 * is absent). py/clipboard_helper.py guards the route with a custom header
 * + loopback checks; pull-only, no polling anywhere.
 */
async function captureFromOsHelper() {
    if (!apiReady()) return false;
    try {
        const r = await app.api.fetchApi("/settings_hub/clipboard", {
            method: "POST",
            headers: { "X-SettingsHub-Clipboard": "1" },
        });
        if (!r || !r.ok) {
            localToast("OS-clipboard helper unavailable - restart ComfyUI after updating the extension");
            return false;
        }
        const j = await r.json();
        const files = (Array.isArray(j?.files) ? j.files : [])
            .map((f) => ({ blob: b64ToBlob(f?.data, f?.mime), name: String(f?.name || "") }))
            .filter((x) => x.blob && x.blob.size);
        if (!files.length) return false;
        await captureFiles(files);
        return true;
    } catch (_) {
        return false;
    }
}

/** window paste event: capture when the cursor hovers the panel (or the
 *  event originates inside it) and no text field OUTSIDE the panel owns the
 *  focus - the user's normal Ctrl+V into editors is never disturbed. When
 *  the browser event carries nothing usable (files copied in Explorer fire
 *  an empty paste) the OS helper is asked before giving up. */
function onPasteEvent(e) {
    if (!mounted || !isStackOn()) return;
    const inPanel = (() => { try { return panel?.contains(e.target); } catch (_) { return false; } })();
    if (!pasteHover && !inPanel) return;
    const ae = document.activeElement;
    const aeEditable = (() => {
        try {
            return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" ||
                ae.isContentEditable) && !panel.contains(ae);
        } catch (_) { return false; }
    })();
    if (aeEditable) return; // leave the focused editor alone
    const cd = e.clipboardData;
    const data = { text: typeof cd?.getData === "function" ? cd.getData("text/plain") : undefined, files: cd?.files };
    e.preventDefault();
    e.stopPropagation();
    captureFromClipboardData(data).then((ok) => {
        if (!ok) captureFromOsHelper();
    });
}

// ---------------------------------------------------------------------------
// Copy-back (card click)
// ---------------------------------------------------------------------------

async function copyBack(item) {
    try {
        if (item.type === "text") {
            const text = item.local || item.text != null
                ? item.text
                : await fetchTextFile(item.file);
            if (!navigator.clipboard?.writeText) { localToast("Clipboard write unavailable"); return; }
            await navigator.clipboard.writeText(text);
            localToast("Copied - Ctrl+V where you need it");
            return;
        }
        if (item.type === "image") {
            const src = item.localUrl || (item.file ? fileUrl(item.file) : null);
            if (!src || !navigator.clipboard?.write || !window.ClipboardItem || !window.isSecureContext) {
                localToast("Image copy unavailable - open the image URL instead");
                return;
            }
            const blob = await getBlob(item) || await (await fetch(src)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
            localToast("Image copied - Ctrl+V where you need it");
            return;
        }
        // video / audio / file: the browser cannot put files back into the
        // clipboard - the card's [⤓] and [→] actions are the way out.
        localToast("Files cannot return to the clipboard - use ⤓ (download) or → (media row)");
    } catch (_) {
        localToast("Copy failed");
    }
}

async function fetchTextFile(name) {
    try {
        const r = apiReady()
            ? await app.api.fetchApi("/settings_hub/stack/file/" + encodeURIComponent(name || ""))
            : await fetch(fileUrl(name));
        return r && r.ok ? await r.text() : "";
    } catch (_) { return ""; }
}

/** v71: payload of an entry as a Blob (session entries keep their blob in
 *  memory; server entries are fetched through the file route). */
async function getBlob(item) {
    try {
        if (item?.local && localBlobs.has(item.id)) return localBlobs.get(item.id);
        if (item?.localUrl) {
            const b = await (await fetch(item.localUrl)).blob();
            if (b && b.size) return b;
        }
        if (item?.file) {
            const b = await fetchBlob("/settings_hub/stack/file/" + encodeURIComponent(item.file));
            if (b && b.size) return b;
        }
    } catch (_) {}
    return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cardHtml(item) {
    const name = String(item.name || "");
    const nameHtml = name ? `<span class="hub-stack-name" title="${esc(name)}">${esc(name)}</span>` : "";
    const usesHtml = item.uses > 0 ? `<span class="hub-stack-uses" title="Used ${item.uses} time(s)">×${item.uses}</span>` : "";
    const tagsHtml = (Array.isArray(item.tags) && item.tags.length)
        ? `<span class="hub-stack-tags">${item.tags.map((t) =>
            `<span class="hub-stack-tag${viewFilter.tag && viewFilter.tag.toLowerCase() === String(t).toLowerCase() ? " hub-stack-tag-on" : ""}" data-tag="${esc(t)}" title="Filter by this tag">#${esc(t)}</span>`).join("")}</span>`
        : "";
    const pinCls = item.pinned ? " hub-stack-card-pin" : "";
    let preview = "";
    let meta = "";
    let acts = `<button type="button" class="hub-stack-act hub-stack-pin${item.pinned ? " hub-stack-pin-on" : ""}" data-act="pin" title="${item.pinned ? "Unpin (it will age out again)" : "Pin: survives max-eviction"}">📌</button>` +
        `<button type="button" class="hub-stack-act" data-act="edit" title="Rename / tags">✎</button>`;
    if (item.type === "image") {
        preview = `<img class="hub-stack-thumb" loading="lazy" alt="" src="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}">`;
        meta = `image${item.size ? " · " + fmtBytes(item.size) : ""}`;
    } else if (item.type === "video") {
        preview = `<video class="hub-stack-thumb hub-stack-media" src="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}" muted controls preload="metadata" playsinline></video>`;
        meta = `video${item.size ? " · " + fmtBytes(item.size) : ""}`;
        acts = `<button type="button" class="hub-stack-act" data-act="send" title="Send into the first matching hub media row">→</button>` +
            `<a class="hub-stack-act" data-act="dl" title="Download" download="${esc(name || item.file || "stack_file")}" href="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}">⤓</a>` + acts;
    } else if (item.type === "audio") {
        preview = `<div class="hub-stack-audio">🎵<audio class="hub-stack-audio-el" src="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}" controls preload="metadata"></audio></div>`;
        meta = `audio${item.size ? " · " + fmtBytes(item.size) : ""}`;
        acts = `<button type="button" class="hub-stack-act" data-act="send" title="Send into the first matching hub media row">→</button>` +
            `<a class="hub-stack-act" data-act="dl" title="Download" download="${esc(name || item.file || "stack_file")}" href="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}">⤓</a>` + acts;
    } else if (item.type === "file") {
        preview = `<div class="hub-stack-file"><span class="hub-stack-file-ico">📄</span>` +
            `<span class="hub-stack-file-name">${esc(name || item.file || "file")}</span></div>`;
        meta = `file${item.size ? " · " + fmtBytes(item.size) : ""}`;
        acts = `<button type="button" class="hub-stack-act" data-act="send" title="Send into the first matching hub media row">→</button>` +
            `<a class="hub-stack-act" data-act="dl" title="Download" download="${esc(name || item.file || "stack_file")}" href="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}">⤓</a>` + acts;
    } else if (item.id === editId) {
        // v72: inline snippet editor (rename + tags)
        return `<div class="hub-stack-card hub-stack-card-edit" data-id="${esc(item.id)}" data-type="${item.type}">` +
            `<div class="hub-stack-edit">` +
            `<input class="hub-stack-edit-name" data-hub-focus value="${esc(item.name || "")}" placeholder="Name (optional)">` +
            `<input class="hub-stack-edit-tags" data-hub-focus value="${esc((item.tags || []).join(", "))}" placeholder="tags, comma separated">` +
            `<div class="hub-stack-edit-btns">` +
            `<button type="button" class="hub-stack-act" data-act="edit-save" title="Save">✓</button>` +
            `<button type="button" class="hub-stack-act" data-act="edit-cancel" title="Cancel">✕</button>` +
            `</div></div></div>`;
    } else {
        preview = `<div class="hub-stack-text">${esc(excerptOf(item))}</div>`;
        meta = `${(item.text != null ? item.text.length : item.size || 0).toLocaleString()} chars`;
        acts = `<button type="button" class="hub-stack-act" data-act="ins" title="Insert into the last focused hub text field">→📝</button>` + acts;
    }
    const mainTitle = item.type === "text" || item.type === "image"
        ? "Click: copy back to clipboard"
        : (item.type === "video" ? "Video entry (player controls below)" : "File entry");
    return `<div class="hub-stack-card${pinCls}" data-id="${esc(item.id)}" data-type="${item.type}" title="${esc(mainTitle)}">` +
        `${item.pinned ? '<span class="hub-stack-pinflag" title="Pinned">📌</span>' : ""}` +
        `<div class="hub-stack-card-main">${preview}` +
        `<div class="hub-stack-meta">${nameHtml}<span class="hub-stack-tagslot">${tagsHtml}${usesHtml}</span><span>${esc(meta)}</span><span>${esc(fmtTime(item.created))}${item.local ? " · session" : ""}</span></div></div>` +
        `<div class="hub-stack-acts">${acts}<button type="button" class="hub-stack-del" title="Delete entry">✕</button></div>` +
        `</div>`;
}

function excerptOf(item) {
    let t = item.text;
    if (t == null && item.file) return "(large text file)";
    t = String(t ?? "");
    return t.length > TEXT_EXCERPT ? t.slice(0, TEXT_EXCERPT) + "…" : t;
}

/** v72: view filter (search + kind + tag) - purely visual, server truth is
 *  untouched. kind "file" covers video/audio/binary cards. */
function passesFilter(it) {
    if (viewFilter.kind !== "all") {
        const k = it.type === "image" ? "image" : (it.type === "text" ? "text" : "file");
        if (k !== viewFilter.kind) return false;
    }
    if (viewFilter.tag) {
        const tags = Array.isArray(it.tags) ? it.tags : [];
        if (!tags.some((t) => String(t).toLowerCase() === viewFilter.tag.toLowerCase())) return false;
    }
    if (viewFilter.q) {
        const hay = [it.name, it.text, it.file, ...(Array.isArray(it.tags) ? it.tags : [])]
            .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(viewFilter.q.toLowerCase())) return false;
    }
    return true;
}

function renderList() {
    if (!listEl) return;
    if (!stackItems.length) {
        listEl.innerHTML = `<div class="hub-stack-empty">Stack is empty - copy something,<br>then click the paste area (or Ctrl+V over the panel),<br>or drop a file here.</div>`;
        return;
    }
    const visible = stackItems.filter(passesFilter);
    if (!visible.length) {
        listEl.innerHTML = `<div class="hub-stack-empty">No entries match the filter.<br>Clear the search / tag / kind filter above.</div>`;
        return;
    }
    listEl.innerHTML = visible.map(cardHtml).join("");
    if (editId) {
        const nameInput = listEl.querySelector(".hub-stack-edit-name");
        if (nameInput) { try { nameInput.focus(); } catch (_) {} }
    }
}

function renderToolbar() {
    if (!toolsEl) return;
    const search = toolsEl.querySelector(".hub-stack-search");
    if (search && search.value !== viewFilter.q) search.value = viewFilter.q;
    for (const btn of toolsEl.querySelectorAll("[data-kind]")) {
        btn.classList.toggle("hub-stack-kind-on", btn.dataset.kind === viewFilter.kind);
    }
    const tagChip = toolsEl.querySelector(".hub-stack-tagnote");
    if (tagChip) {
        tagChip.style.display = viewFilter.tag ? "" : "none";
        tagChip.textContent = "#" + viewFilter.tag + " ✕";
    }
}

function renderBadge() {
    const n = String(stackItems.length);
    if (headEl) headEl.querySelector(".hub-stack-count").textContent = n;
    if (chip) chip.querySelector(".hub-stack-chip-count").textContent = n;
}

function renderNote() {
    if (!noteEl) return;
    if (serverOk === false) {
        noteEl.style.display = "";
        noteEl.textContent = "⚠ ComfyUI server storage unreachable - entries last this session only. Restart ComfyUI to enable persistence.";
    } else {
        noteEl.style.display = "none";
        noteEl.textContent = "";
    }
}

function renderAll() { renderList(); renderBadge(); renderNote(); renderToolbar(); }

// ---------------------------------------------------------------------------
// Drag / resize / minimize (mouse events - jsdom- and touchscreen-safe)
// ---------------------------------------------------------------------------

function clampPos(x, y, el) {
    const w = el?.offsetWidth || 260, h = el?.offsetHeight || 120;
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    return {
        x: Math.min(Math.max(x, -(w - 64)), vw - 64),
        y: Math.min(Math.max(y, 0), vh - 40),
    };
}

function makeDraggable(handle, target, getPos, setPos, isChip) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.("button")) return; // header buttons stay clickable
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const { x: ox, y: oy } = getPos();
        const move = (ev) => {
            const p = clampPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY), target);
            setPos(p.x, p.y, false);
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            const p = clampPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY), target);
            setPos(p.x, p.y, true); // persist on release
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function applyPos(x, y) {
    panel.style.left = x + "px";
    panel.style.top = y + "px";
}

function applyChipPos(x, y) {
    chip.style.left = x + "px";
    chip.style.top = y + "px";
}

function applySize(w, h) {
    const W = Math.min(Math.max(w, 200), 560);
    const H = Math.min(Math.max(h, 160), 900);
    panel.style.width = W + "px";
    panel.style.height = H + "px";
}

function setMinimized(min, persist = true) {
    if (!panel || !chip) return;
    panel.style.display = min ? "none" : "";
    chip.style.display = min ? "" : "none";
    if (min) {
        const ui = lsUi();
        applyChipPos(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16);
    }
    if (persist) saveUi({ min: !!min });
}

// ---------------------------------------------------------------------------
// v71: card drag -> Load-Image node / hub media mirror (Nougan mechanics)
// ---------------------------------------------------------------------------
// mousedown on an IMAGE card main + a 6px move arms a drag session: a ghost
// follows the pointer, the node under the cursor gets a highlight box (a
// node qualifies when it carries an `image` combo widget and is not
// collapsed), hub media mirrors highlight instead. Esc cancels; mouseup
// uploads via /upload/image and writes the combo (node) or routes the blob
// into the row's own upload pipeline (mirror).

let dragCtx = null;      // {item, card, sx, sy, started, ghost, target, blob}
let targetBox = null;    // canvas-node highlight overlay (reused)

function elemFromPoint(x, y) {
    try {
        return typeof document.elementFromPoint === "function"
            ? document.elementFromPoint(x, y) : null;
    } catch (_) { return null; }
}

function imageWidgetOf(node) {
    if (!node || node.flags?.collapsed) return null;
    try {
        return node.widgets?.find((w) => w && w.name === "image" &&
            (w.type === "combo" || w.options?.values)) || null;
    } catch (_) { return null; }
}

function nodeFromPoint(cx, cy) {
    try {
        const c = app.canvas;
        if (!c?.canvas) return null;
        if (elemFromPoint(cx, cy) !== c.canvas) return null;
        const rect = c.canvas.getBoundingClientRect();
        const ds = c.ds || { scale: 1, offset: [0, 0] };
        const gx = (cx - rect.left) / (ds.scale || 1) - (ds.offset?.[0] || 0);
        const gy = (cy - rect.top) / (ds.scale || 1) - (ds.offset?.[1] || 0);
        const graph = app.graph ?? c.graph;
        return graph?.getNodeOnPos?.(gx, gy, true) ?? null;
    } catch (_) { return null; }
}

function showTargetBox(node) {
    try {
        const c = app.canvas;
        if (!c?.canvas) return;
        if (!targetBox) {
            targetBox = document.createElement("div");
            targetBox.className = "hub-stack-targetbox";
            document.body.appendChild(targetBox);
        }
        const rect = c.canvas.getBoundingClientRect();
        const ds = c.ds || { scale: 1, offset: [0, 0] };
        const th = (window.LiteGraph?.NODE_TITLE_HEIGHT) ?? 30;
        targetBox.style.left = (rect.left + ((node.pos?.[0] || 0) + (ds.offset?.[0] || 0)) * (ds.scale || 1) - 3) + "px";
        targetBox.style.top = (rect.top + ((node.pos?.[1] || 0) - th + (ds.offset?.[1] || 0)) * (ds.scale || 1) - 3) + "px";
        targetBox.style.width = (((node.size?.[0]) || 100) * (ds.scale || 1) + 6) + "px";
        targetBox.style.height = (((node.size?.[1]) || 60) + th) * (ds.scale || 1) + 6 + "px";
        targetBox.style.display = "block";
    } catch (_) {}
}

function hideTargetBox() {
    if (targetBox) targetBox.style.display = "none";
}

function setDragTarget(target) {
    if (!dragCtx) return;
    const prev = dragCtx.target;
    if (prev?.kind === "mirror" && prev.el) {
        try { prev.el.classList.remove("hub-stack-drop-hot"); } catch (_) {}
    }
    if (prev?.kind === "text" && prev.el) {
        try { prev.el.classList.remove("hub-stack-drop-hot-text"); } catch (_) {}
    }
    dragCtx.target = target || null;
    if (target?.kind === "mirror" && target.el) {
        try { target.el.classList.add("hub-stack-drop-hot"); } catch (_) {}
        hideTargetBox();
    } else if (target?.kind === "text" && target.el) {
        try { target.el.classList.add("hub-stack-drop-hot-text"); } catch (_) {}
        hideTargetBox();
    } else if (target?.kind === "node") {
        showTargetBox(target.node);
    } else {
        hideTargetBox();
    }
}

function moveGhost(e) {
    if (!dragCtx?.ghost) return;
    dragCtx.ghost.style.left = (e.clientX + 12) + "px";
    dragCtx.ghost.style.top = (e.clientY + 10) + "px";
}

function endDragSession(keepClickBlock) {
    window.removeEventListener("mousemove", onCardDragMove, true);
    window.removeEventListener("mouseup", onCardDragUp, true);
    window.removeEventListener("keydown", onCardDragKey, true);
    const prev = dragCtx?.target;
    if (prev?.kind === "mirror" && prev.el) {
        try { prev.el.classList.remove("hub-stack-drop-hot"); } catch (_) {}
    }
    if (prev?.kind === "text" && prev.el) {
        try { prev.el.classList.remove("hub-stack-drop-hot-text"); } catch (_) {}
    }
    try { dragCtx?.ghost?.remove(); } catch (_) {}
    hideTargetBox();
    const wasStarted = !!dragCtx?.started;
    dragCtx = null;
    if (wasStarted || keepClickBlock) {
        justDragged = true; // the trailing click must not fire copy-back
        setTimeout(() => { justDragged = false; }, 80);
    }
}

function onCardDragKey(e) {
    if (e.key !== "Escape" || !dragCtx) return;
    e.preventDefault();
    e.stopPropagation();
    endDragSession(false); // Esc cancels the drop, nothing is uploaded
}

function onCardDragMove(e) {
    if (!dragCtx) return;
    if (!dragCtx.started) {
        const d = Math.hypot(e.clientX - dragCtx.sx, e.clientY - dragCtx.sy);
        if (d < DRAG_THRESHOLD) return;
        dragCtx.started = true;
        const ghost = document.createElement("div");
        ghost.className = "hub-stack-ghost";
        const src = dragCtx.item.localUrl ||
            (dragCtx.item.file ? fileUrl(dragCtx.item.file) : "");
        ghost.innerHTML = src && dragCtx.item.type === "image"
            ? `<img alt="" src="${esc(src)}">`
            : esc(String(dragCtx.item.name || excerptOf(dragCtx.item)).slice(0, 60));
        document.body.appendChild(ghost);
        dragCtx.ghost = ghost;
        if (dragCtx.item.type === "image") {
            getBlob(dragCtx.item).then((b) => { if (dragCtx) dragCtx.blob = b; });
        }
    }
    moveGhost(e);
    const el = elemFromPoint(e.clientX, e.clientY);
    let target = null;
    const mirror = el?.closest?.(".hub-mirror-media");
    if (mirror) {
        target = { kind: "mirror", el: mirror };
    } else {
        // v72: text cards land on text mirrors
        const textEl = el?.closest?.(".hub-text-input, .hub-text-area");
        if (textEl && dragCtx.item.type === "text") {
            target = { kind: "text", el: textEl };
        } else {
            const node = nodeFromPoint(e.clientX, e.clientY);
            if (node && imageWidgetOf(node)) target = { kind: "node", node };
        }
    }
    setDragTarget(target);
}

function onCardDragUp(e) {
    if (!dragCtx) { endDragSession(false); return; }
    const ctx = dragCtx;
    dragCtx = null;
    // Reproduce endDragSession's cleanup for THIS ctx (dragCtx nulled first
    // so the removal helpers cannot double-clean a fresh session).
    window.removeEventListener("mousemove", onCardDragMove, true);
    window.removeEventListener("mouseup", onCardDragUp, true);
    window.removeEventListener("keydown", onCardDragKey, true);
    if (ctx.target?.kind === "mirror" && ctx.target.el) {
        try { ctx.target.el.classList.remove("hub-stack-drop-hot"); } catch (_) {}
    }
    if (ctx.target?.kind === "text" && ctx.target.el) {
        try { ctx.target.el.classList.remove("hub-stack-drop-hot-text"); } catch (_) {}
    }
    try { ctx.ghost?.remove(); } catch (_) {}
    hideTargetBox();
    if (!ctx.started) { dragCtx = null; return; }
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 80);
    const t = ctx.target;
    if (t?.kind === "node") dropOnLoaderNode(ctx, t.node);
    else if (t?.kind === "mirror") dropOnMirror(ctx, t.el);
    else if (t?.kind === "text") dropOnTextMirror(ctx, t.el);
}

function onCardMouseDown(e) {
    if (!mounted || e.button !== 0) return;
    if (e.target?.closest?.("button, a, input, textarea, video, audio")) return;
    const card = e.target?.closest?.(".hub-stack-card");
    if (!card) return;
    // v71/v72: images drag onto loader nodes / media mirrors; TEXT cards drag
    // onto hub text mirrors ("→ в строку" by direct drop).
    if (card.dataset.type !== "image" && card.dataset.type !== "text") return;
    const item = stackItems.find((x) => x.id === card.dataset.id);
    if (!item) return;
    e.preventDefault();
    dragCtx = { item, card, sx: e.clientX, sy: e.clientY, started: false, ghost: null, target: null, blob: null };
    window.addEventListener("mousemove", onCardDragMove, true);
    window.addEventListener("mouseup", onCardDragUp, true);
    window.addEventListener("keydown", onCardDragKey, true);
}

function fileNameFor(item) {
    let n = String(item?.name || "").trim();
    if (!n) n = item?.file || "";
    if (!n) n = item?.type === "image" ? "stack_image.png" : "stack_file";
    n = n.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 120) || "stack_file";
    if (!/\.[A-Za-z0-9]{1,6}$/.test(n)) n += item?.type === "image" ? ".png" : ".bin";
    return n;
}

async function uploadToInput(blob, name) {
    const fd = new FormData();
    fd.append("image", new File([blob], name, { type: blob.type || "image/png" }));
    fd.append("type", "input");
    fd.append("overwrite", "false"); // identical files are reused, else renamed
    const r = await app.api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r || !r.ok) throw new Error("upload failed (" + (r?.status ?? "?") + ")");
    const j = await r.json();
    return j?.subfolder ? `${j.subfolder}/${j.name}` : String(j?.name || "");
}

async function dropOnLoaderNode(ctx, node) {
    const w = imageWidgetOf(node);
    if (!w) return;
    try {
        if (!ctx.blob) ctx.blob = await getBlob(ctx.item);
        if (!ctx.blob) { localToast("Entry payload unavailable"); return; }
        const uploaded = await uploadToInput(ctx.blob, fileNameFor(ctx.item));
        const old = w.value;
        if (Array.isArray(w.options?.values) && !w.options.values.includes(uploaded)) {
            w.options.values.push(uploaded);
        }
        w.value = uploaded;
        try { w.callback?.(uploaded, app.canvas, node); } catch (_) {} // preview refresh
        try { node.onWidgetChanged?.(w.name, uploaded, old, w); } catch (_) {}
        try { app.canvas.setDirty?.(true, true); } catch (_) {}
        localToast(`Loaded into ${node.title || node.type || "node"}`);
    } catch (err) {
        localToast("Upload failed - see F12 for details");
    }
}

async function dropOnMirror(ctx, el) {
    try {
        if (!ctx.blob) ctx.blob = await getBlob(ctx.item);
        if (!ctx.blob) { localToast("Entry payload unavailable"); return; }
        const br = stackBridge();
        const ok = typeof br?.sendBlobToMediaMirror === "function"
            ? !!br.sendBlobToMediaMirror(el, ctx.blob, fileNameFor(ctx.item))
            : false;
        localToast(ok ? "Sent to the media row" : "Media row refused the file");
    } catch (_) { localToast("Drop failed"); }
}

/** [→] on a file-ish card: first matching hub media row gets the blob. */
async function sendToMediaRow(item) {
    const kind = item.type === "file" ? "image" : item.type;
    const br = stackBridge();
    const mirror = typeof br?.findMediaMirror === "function" ? br.findMediaMirror(kind) : null;
    if (!mirror) {
        localToast(`No ${kind} media row in any hub - pin one first`);
        return;
    }
    const blob = await getBlob(item);
    if (!blob) { localToast("Entry payload unavailable"); return; }
    const ok = typeof br.sendBlobToMediaMirror === "function"
        ? !!br.sendBlobToMediaMirror(mirror, blob, fileNameFor(item))
        : false;
    localToast(ok ? "Sent to the media row" : "Media row refused the file");
    if (ok) bumpUses(item);
}

// ---------------------------------------------------------------------------
// v72: snippet engine - pins, rename/tags editor, "→ into the string"
// ---------------------------------------------------------------------------

async function togglePin(item) {
    const want = !item.pinned;
    if (item.local) { // session-only entries keep the flag locally only
        item.pinned = want;
        renderAll();
        return;
    }
    const it = await apiPatch(item.id, { pinned: want });
    if (it) { applyPatched(it); localToast(want ? "Pinned - it survives eviction" : "Unpinned"); }
    else localToast("Pin failed - server unreachable");
}

async function saveEdit(card, item) {
    const nameInput = card.querySelector(".hub-stack-edit-name");
    const tagsInput = card.querySelector(".hub-stack-edit-tags");
    const name = nameInput ? nameInput.value.trim() : "";
    const tags = tagsInput
        ? tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8)
        : [];
    editId = null;
    if (item.local) {
        item.name = name || undefined;
        item.tags = tags.length ? tags : undefined;
        renderAll();
        return;
    }
    const it = await apiPatch(item.id, { name, tags });
    if (it) applyPatched(it);
    else localToast("Save failed - server unreachable");
}

async function itemText(item) {
    if (item.text != null) return String(item.text);
    if (item.file) return await fetchTextFile(item.file);
    return "";
}

/** [→📝] on a TEXT card: write the snippet into the last focused hub text
 *  mirror (the field the user edited last). Falls back to a hint toast. */
async function insertIntoLastFocused(item) {
    const br = stackBridge();
    if (typeof br?.insertTextIntoLastFocused !== "function") {
        localToast("The hub rows are unavailable - click a hub text field first");
        return;
    }
    const text = await itemText(item);
    if (!text) { localToast("Entry has no text"); return; }
    const ok = !!br.insertTextIntoLastFocused(text);
    if (ok) {
        const info = typeof br.focusedTextInfo === "function" ? br.focusedTextInfo() : null;
        localToast(`Inserted into ${info?.label ? `"${info.label}"` : "the last focused field"}`);
        bumpUses(item);
    } else {
        localToast("No focused hub text field - click one first, then use →📝");
    }
}

/** v72: a TEXT card dropped straight onto a hub text mirror writes into
 *  THAT field (not the last-focused one). */
async function dropOnTextMirror(ctx, el) {
    try {
        const br = stackBridge();
        if (typeof br?.insertTextIntoEl !== "function") { localToast("Hub rows unavailable"); return; }
        const text = await itemText(ctx.item);
        if (!text) { localToast("Entry has no text"); return; }
        const ok = !!br.insertTextIntoEl(el, text);
        localToast(ok ? "Inserted into the field" : "The field refused the text");
        if (ok) bumpUses(ctx.item);
    } catch (_) { localToast("Drop failed"); }
}

// ---------------------------------------------------------------------------
// Mount / teardown
// ---------------------------------------------------------------------------

function teardown() {
    try { panel?.remove(); } catch (_) {}
    try { chip?.remove(); } catch (_) {}
    panel = chip = headEl = listEl = pasteEl = noteEl = grip = toolsEl = null;
    editId = null;
    mounted = false;
    try { window.removeEventListener("paste", onPasteEvent, true); } catch (_) {}
}

function buildDom() {
    panel = document.createElement("div");
    panel.className = "hub-stack-panel";
    panel.style.zIndex = Z_PANEL;
    panel.innerHTML =
        `<div class="hub-stack-head" title="Drag to move">` +
        `<span class="hub-stack-ico">📋</span><span class="hub-stack-title">Stack</span>` +
        `<span class="hub-stack-count">0</span>` +
        `<button type="button" class="hub-btn hub-stack-min" title="Minimize to chip">–</button>` +
        `<button type="button" class="hub-btn hub-stack-hide" title="Hide panel (⚙ Hub settings → Stack brings it back)">✕</button>` +
        `</div>` +
        `<div class="hub-stack-note" style="display:none"></div>` +
        `<div class="hub-stack-tools">` +
        `<input type="text" class="hub-stack-search" spellcheck="false" placeholder="🔍 search" title="Search name, content and tags">` +
        `<button type="button" class="hub-stack-kind" data-kind="all" title="Every kind">All</button>` +
        `<button type="button" class="hub-stack-kind" data-kind="text" title="Text cards">Txt</button>` +
        `<button type="button" class="hub-stack-kind" data-kind="image" title="Images">Img</button>` +
        `<button type="button" class="hub-stack-kind" data-kind="file" title="Video / audio / files">Files</button>` +
        `<button type="button" class="hub-stack-tagnote" style="display:none" title="Clear the tag filter"></button>` +
        `</div>` +
        `<div class="hub-stack-list"></div>` +
        `<div class="hub-stack-paste" tabindex="0" title="Click: read the clipboard. Or press Ctrl+V while hovering the panel.">＋ Click or Ctrl+V to add from clipboard</div>` +
        `<div class="hub-stack-grip" title="Drag to resize"></div>`;
    document.body.appendChild(panel);

    chip = document.createElement("div");
    chip.className = "hub-stack-chip";
    chip.style.zIndex = Z_PANEL;
    chip.innerHTML = `📋 <span class="hub-stack-chip-count">0</span>`;
    chip.title = "Paste Stack - click to open";
    chip.style.display = "none";
    document.body.appendChild(chip);

    headEl = panel.querySelector(".hub-stack-head");
    listEl = panel.querySelector(".hub-stack-list");
    noteEl = panel.querySelector(".hub-stack-note");
    pasteEl = panel.querySelector(".hub-stack-paste");
    grip = panel.querySelector(".hub-stack-grip");
    toolsEl = panel.querySelector(".hub-stack-tools");
    loadFilter();

    // saved geometry
    const ui = lsUi();
    applyPos(ui.x ?? Math.max(16, (window.innerWidth || 1600) - 320), ui.y ?? 120);
    applySize(ui.w ?? 280, ui.h ?? 380);
    setMinimized(!!ui.min, false);

    // wiring
    pasteEl.addEventListener("click", () => captureFromRead());
    panel.querySelector(".hub-stack-min").addEventListener("click", () => setMinimized(true));
    panel.querySelector(".hub-stack-hide").addEventListener("click", () => { saveUi({ min: false }); setStackOn(false); });
    chip.addEventListener("click", () => setMinimized(false));

    makeDraggable(headEl, panel,
        () => ({ x: parseFloat(panel.style.left) || 0, y: parseFloat(panel.style.top) || 0 }),
        (x, y, persist) => { applyPos(x, y); if (persist) saveUi({ x, y }); }, false);
    makeDraggable(chip, chip,
        () => ({ x: parseFloat(chip.style.left) || 0, y: parseFloat(chip.style.top) || 0 }),
        (x, y, persist) => { applyChipPos(x, y); if (persist) saveUi({ chipX: x, chipY: y }); }, true);

    // resize: grip at the bottom-right
    grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const w0 = panel.offsetWidth, h0 = panel.offsetHeight;
        const move = (ev) => applySize(w0 + (ev.clientX - startX), h0 + (ev.clientY - startY));
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            const w = Math.min(Math.max(w0 + (ev.clientX - startX), 200), 560);
            const h = Math.min(Math.max(h0 + (ev.clientY - startY), 160), 900);
            applySize(w, h);
            saveUi({ w, h });
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });

    // hover gate for the Ctrl+V capture
    panel.addEventListener("mouseenter", () => { pasteHover = true; });
    panel.addEventListener("mouseleave", () => { pasteHover = false; });

    // v71: OS file drop onto the panel (any kind, not just images)
    const fileDragOver = (e) => {
        const types = e.dataTransfer?.types;
        if (!types || !Array.from(types).includes("Files")) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
        panel.classList.add("hub-stack-drag");
    };
    panel.addEventListener("dragover", fileDragOver);
    panel.addEventListener("dragenter", fileDragOver);
    panel.addEventListener("dragleave", (e) => {
        const rt = e.relatedTarget;
        if (rt && panel.contains(rt)) return; // moving between children
        panel.classList.remove("hub-stack-drag");
    });
    panel.addEventListener("drop", (e) => {
        panel.classList.remove("hub-stack-drag");
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        captureFiles(files.map((f) => ({ blob: f, name: f.name || "" })));
    });

    // card interactions (event delegation)
    listEl.addEventListener("mousedown", onCardMouseDown);
    listEl.addEventListener("click", (e) => {
        const card = e.target.closest?.(".hub-stack-card");
        if (!card) return;
        const id = card.getAttribute("data-id");
        const item = stackItems.find((x) => x.id === id);
        if (!item) return;
        if (e.target.closest?.("input, textarea")) return; // the inline editor
        const tagChip = e.target.closest?.(".hub-stack-tag");
        if (tagChip) {
            // v72: a tag chip toggles the tag filter
            viewFilter.tag = viewFilter.tag &&
                viewFilter.tag.toLowerCase() === String(tagChip.dataset.tag).toLowerCase()
                ? null : String(tagChip.dataset.tag);
            saveFilter();
            renderAll();
            return;
        }
        if (e.target.closest?.(".hub-stack-del")) {
            deleteOne(item);
            return;
        }
        const act = e.target.closest?.("[data-act]");
        if (act) {
            const a = act.dataset.act;
            if (a === "send") sendToMediaRow(item);
            else if (a === "ins") insertIntoLastFocused(item);
            else if (a === "pin") togglePin(item);
            else if (a === "edit") { editId = item.id; renderAll(); }
            else if (a === "edit-cancel") { editId = null; renderAll(); }
            else if (a === "edit-save") saveEdit(card, item);
            // "dl" is a real <a download> - the browser handles it
            return;
        }
        if (e.target.closest?.("video, audio, a")) return; // native controls
        if (justDragged) return; // the click that trails a card drag
        copyBack(item);
    });

    // v72: toolbar wiring (search + kind filter + tag clear)
    const searchInput = toolsEl.querySelector(".hub-stack-search");
    searchInput.addEventListener("input", () => {
        viewFilter.q = searchInput.value;
        saveFilter();
        renderList();
    });
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            searchInput.value = "";
            viewFilter.q = "";
            saveFilter();
            renderList();
        }
    });
    for (const btn of toolsEl.querySelectorAll("[data-kind]")) {
        btn.addEventListener("click", () => {
            viewFilter.kind = btn.dataset.kind;
            saveFilter();
            renderAll();
        });
    }
    toolsEl.querySelector(".hub-stack-tagnote").addEventListener("click", () => {
        viewFilter.tag = null;
        saveFilter();
        renderAll();
    });

    window.addEventListener("paste", onPasteEvent, true);

    // re-sync when the tab regains focus (another tab/browser may have changed
    // the shared server stack); debounced + sequence-guarded.
    let focusTimer = 0;
    window.addEventListener("focus", () => {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => refreshFromServer(), 800);
    });
}

async function deleteOne(item) {
    stackItems = stackItems.filter((x) => x.id !== item.id);
    localBlobs.delete(item.id);
    renderAll();
    if (!item.local) {
        const ok = await apiDelete(item.id);
        if (!ok) localToast("Delete failed - will return on next reload");
    }
}

async function refreshFromServer(seq) {
    const remote = await apiGet();
    if (seq !== initSeq) return; // a newer init/refresh superseded this fetch
    if (remote === null) {
        if (serverOk !== false) { serverOk = false; renderNote(); }
        return;
    }
    serverOk = true;
    // Keep session-only entries (if any) on top of the server truth.
    const locals = stackItems.filter((x) => x.local);
    stackItems = [...locals, ...remote.filter((x) => !locals.some((l) => l.id === x.id))];
    renderAll();
}

// ---------------------------------------------------------------------------
// Public init (entry calls this from extension setup; idempotent)
// ---------------------------------------------------------------------------

export function initStack() {
    if (!isStackOn()) return;
    const seq = ++initSeq;
    teardown();
    buildDom();
    mounted = true;
    renderAll();
    refreshFromServer(seq);
}

// ---------------------------------------------------------------------------
// Test hooks (smoke_stack.mjs) - not used by the app
// ---------------------------------------------------------------------------

export function __stackTestHooks() {
    return {
        captureFromClipboardData,
        captureFiles,
        captureFromOsHelper,
        addText,
        addImageBlob,
        addFileBlob,
        classifyBlob,
        b64ToBlob,
        blobText,
        fileNameFor,
        getBlob,
        uploadToInput,
        dropOnLoaderNode,
        dropOnMirror,
        sendToMediaRow,
        nodeFromPoint,
        imageWidgetOf,
        elemFromPoint,
        items: () => stackItems.slice(),
        serverOk: () => serverOk,
        panelEl: () => panel,
        chipEl: () => chip,
        listEl: () => listEl,
        setPasteHover: (v) => { pasteHover = !!v; },
        viewFilter: () => ({ ...viewFilter }),
        dragState: () => (dragCtx ? { started: !!dragCtx.started, target: dragCtx.target } : null),
        isJustDragged: () => justDragged,
        refresh: () => refreshFromServer(initSeq),
        mount: initStack,
    };
}

