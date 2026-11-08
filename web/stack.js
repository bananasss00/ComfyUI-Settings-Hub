// ============================================================================
// SettingsHub - Paste Stack (v77): standalone floating clipboard panel
// ----------------------------------------------------------------------------
// v71-v77 BUILD GUARD (must be the FIRST executable statement, before any work):
// the loader entry stamps globalThis.__SettingsHubBuild before importing the
// submodules; this module refuses to stay silent if it was loaded as part of
// a MIXED build. See settings_hub.js for the field history.
// ============================================================================
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["stack"] = true;
if (globalThis.__SettingsHubBuild !== "v77") {
    console.error("[SettingsHub] STALE BUILD: stack.js (v77) was loaded under entry build [" +
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
//     to a chip with a live count badge. There is NO close button (v75 owner
//     request): the only way to remove the panel is the gear popup "Stack"
//     section -> Off. Position/size state in localStorage.
//
// v77 (owner request 2026-11-08: the stack followed him across workflows -
//   "initially I planned the stack to be workflow-dependent, but a shared
//   stack is not quite it either - make a switchable option and reconcile it
//   with the earlier 'save the stack into the workflow' requirement"):
//   * SCOPE MODES. ⚙ Hub settings -> Stack -> "Stack scope":
//       - Shared (default): one stack for every workflow - the pre-v77
//         behavior, stored in user/settings_hub/stack/.
//       - Per-workflow: EVERY workflow keeps its own stack, stored server-side
//         in user/settings_hub/stack/workflows/<id>/ (new ?wf= parameter on
//         every stack route - py/stack_store.py v77).
//   * The per-workflow IDENTITY lives in the workflow file:
//     app.graph.extra.settingshubStackId (LiteGraph serializes graph.extra
//     into extra_data) - the stack is literally "saved into the workflow":
//     the binding travels with the file, the payloads stay server-side. The
//     id is generated on first use and survives save/load; a workflow moved
//     to another machine still points at ITS OWN store id (empty until the
//     payloads exist there - see the text backup below).
//   * TEXT BACKUP inside the workflow file: every mutation mirrors the
//     current TEXT entries (inline texts only, 200KB budget, newest-first)
//     into app.graph.extra.settingshubStack. When a per-workflow server store
//     comes up EMPTY and the workflow carries embedded texts, they are
//     re-added automatically (rehydration) - prompts survive moving the
//     workflow to another machine or wiping the user folder. Blob entries
//     (images/video/audio) are NOT embedded (a workflow file must not carry
//     megabytes of base64); they live only in the server store.
//   * Workflow SWITCH detection: app.graph.onConfigure / onClear are wrapped
//     (LiteGraph fires both when a workflow loads / the canvas clears). In
//     per-workflow mode a switch re-reads THAT workflow's store; session-only
//     entries of the previous workflow are dropped (they belong to it, not to
//     the new one). All API urls resolve the scope id FRESH at call time, so
//     even an undetected switch cannot cross-contaminate stores.
//   * Switching the scope NEVER copies or moves entries (AGENTS.md 5.1 rule
//     7): the shared stack keeps the shared entries, each workflow keeps its
//     own. The header shows an "@workflow" badge while the per-workflow scope
//     is active, and 🗑 clears only the ACTIVE scope's store.
//
// v76 (owner report 2026-11-08: "every page reload shows 'server storage
//   unreachable' even after many restarts"):
//   * the note is no longer a one-liner guess - a PROBE classifies the
//     failure: GET /settings_hub/stack/health (new v76 py route answering
//     {ok, version, dir, writable, items}) -> 404-on-both = py part missing
//     (old py/, typically only web/ was replaced) / fetch throw = network /
//     other status = HTTP error / writable=false = folder not writable /
//     health 404 + list 200 = legacy server (storage WORKS, py < v76) /
//     version != web build = half-updated install (mismatch).
//   * the note names the cause and the fix, turns GREEN for
//     legacy/mismatch (storage is ON - never look broken while working),
//     and carries a [↻ check again] button that re-probes + re-syncs
//     WITHOUT a page reload.
//
// v75 (owner request 2026-11-08):
//   * the header [✕] hide button is GONE - only [–] (minimize to chip) and
//     🗑 (clear) remain in the header. The panel is intentionally an
//     always-there tool; hiding/disabling happens ONLY through the settings
//     (⚙ Hub settings -> Stack -> Off, the pre-existing stackon switch),
//     which stays the single source of truth for the panel's existence.
//
// v74 (owner QA round 2026-11-08):
//   * 🗑 CLEAR moved INTO the panel header (the settings popup no longer
//     carries it - destructive controls belong to the thing they destroy);
//     double-click confirm (2.5s window), wipes server + session entries.
//   * the list SCROLLS for real: .hub-stack-list gets min-height:0 (a flex
//     item could not shrink below its content, so the panel clipped the tail
//     with no scrollbar) + an always-visible styled scrollbar + clearer
//     card separation.
//   * card DRAG lands on REAL GRAPH NODES for every media kind: image ->
//     combos named "image" / options.image_upload (LoadImage, masks...),
//     video -> "video" / options.video_upload (native LoadVideo, VHS),
//     audio -> "audio" / options.audio_upload (LoadAudio); upload always
//     goes through /upload/image - ComfyUI has NO /upload/audio or
//     /upload/video, LoadVideo/LoadAudio feed the same input dir. TEXT
//     cards dropped on a node write the STRING/customtext widget under the
//     cursor (fallback: the node's first text widget) - prompts included.
//   * Enter commits the inline rename/tags editor (Esc cancels) and Ctrl+V
//     with a panel input focused pastes INTO that input instead of being
//     captured as a new entry.
// ============================================================================

import { app } from "../../scripts/app.js";
import { stackBridge } from "./sync.js";

// ---------------------------------------------------------------------------
// Constants + tiny utils
// ---------------------------------------------------------------------------

const LS_UI = "settingshub.stack.ui";      // {x,y,w,h,min,chipX,chipY}
const LS_ON = "settingshub.stack.on";      // "1"/"0" - panel enabled
const LS_MAX = "settingshub.stack.max";    // client eviction threshold
const LS_SCOPE = "settingshub.stack.scope"; // v77: "global" | "workflow"

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
    const p = scopeUrl("/settings_hub/stack/file/" + encodeURIComponent(name || ""));
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
let degraded = null;     // v76: null | {code, detail?} - probeServer() verdict
let mounted = false;
let pasteHover = false;  // cursor over the panel (paste-event gate)
let clearArmTs = 0;      // clear-button double-confirm window
let initSeq = 0;         // guards against stale async fetches across re-init
let localSeq = 0;        // ids for session-only entries when the server is down
let lastMountScope = null; // v77: the scope of the previous mount (reset the list only on a scope change)
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

// ---------------------------------------------------------------------------
// v77: stack scope - shared (one stack for every workflow, the pre-v77
// behavior and the default) vs per-workflow (every workflow keeps its own
// entries). The mode is a client setting; switching it NEVER migrates data
// (AGENTS.md 5.1 rule 7) - each scope keeps its own store.
// ---------------------------------------------------------------------------

const WF_ID_KEY = "settingshubStackId";   // in app.graph.extra (workflow file)
const WF_EMBED_KEY = "settingshubStack";  // in app.graph.extra (text backup)
const WF_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const WF_EMBED_BUDGET = 200_000;          // max embedded text chars per file
const WF_EMBED_MAX = 50;                  // max embedded text entries

export function getStackScope() {
    try { return localStorage.getItem(LS_SCOPE) === "workflow" ? "workflow" : "global"; }
    catch (_) { return "global"; }
}

export function setStackScope(v) {
    const mode = v === "workflow" ? "workflow" : "global";
    const prev = getStackScope();
    try { localStorage.setItem(LS_SCOPE, mode); } catch (_) {}
    if (mode !== prev) {
        if (mounted) initStack(); // full re-mount: right store, badge, empty state
        localToast(mode === "workflow"
            ? "Stack scope: PER-WORKFLOW. This workflow now keeps its own entries; the shared stack keeps the shared ones."
            : "Stack scope: SHARED. Every workflow sees the shared stack; per-workflow entries stay in their workflows.");
    }
    return mode;
}

/** The current workflow's stack id - resolved FRESH at every call so a
 *  switch can never be missed by the data path: the id lives in
 *  app.graph.extra (LiteGraph serializes it into extra_data, i.e. INTO the
 *  workflow file - the owner's "save the stack into the workflow" contract).
 *  A missing/invalid id is generated once and written back into the graph. */
function workflowStackId() {
    try {
        const g = app?.graph;
        if (!g) return "wf-default";
        const extra = g.extra || (g.extra = {});
        let id = extra[WF_ID_KEY];
        if (typeof id !== "string" || !WF_ID_RE.test(id)) {
            id = "wf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
            extra[WF_ID_KEY] = id;
        }
        return id;
    } catch (_) { return "wf-default"; }
}

/** Route a stack path through the ACTIVE scope: untouched in shared mode,
 *  ?wf=<id> in per-workflow mode (py/stack_store.py v77 routes by it). */
function scopeUrl(path) {
    if (getStackScope() !== "workflow") return path;
    return path + (path.includes("?") ? "&" : "?") + "wf=" + encodeURIComponent(workflowStackId());
}

/** Clears the whole stack on the server and locally. v74: called from the
 *  panel's own 🗑 header button (the gear popup no longer carries it). */
export async function stackClearAllFlow() {
    const ok = await apiClear();
    if (ok) { stackItems = []; localBlobs.clear(); renderAll(); localToast("Stack cleared"); }
    else localToast("Stack clear failed - server unreachable");
    return ok;
}

// v74: the header 🗑 arms on the first click and wipes on a second click
// within the window (same double-confirm contract the gear button had).
const CLEAR_ARM_MS = 2500;

function panelClearAll(btn) {
    const now = Date.now();
    if (now - clearArmTs > CLEAR_ARM_MS) {
        clearArmTs = now;
        try { btn.classList.add("hub-stack-clear-armed"); } catch (_) {}
        localToast("Click 🗑 again to clear the WHOLE stack");
        setTimeout(() => {
            try { btn.classList.remove("hub-stack-clear-armed"); } catch (_) {}
        }, CLEAR_ARM_MS);
        return;
    }
    clearArmTs = 0;
    try { btn.classList.remove("hub-stack-clear-armed"); } catch (_) {}
    void stackClearAllFlow();
}

// ---------------------------------------------------------------------------
// Server access (thin client; server index is the source of truth)
// ---------------------------------------------------------------------------

function apiReady() {
    const a = app?.api;
    return !!(a && typeof a.fetchApi === "function");
}

// ---------------------------------------------------------------------------
// v76: server self-diagnosis probe. The old note ("storage unreachable -
// restart ComfyUI") fired for EVERY failure mode and the owner hit a
// persistent one across restarts. Now the panel probes /settings_hub/stack/
// health FIRST (v76+ py answers with the pack version + storage state) and
// classifies the failure so the note says exactly WHAT is wrong and what to
// do; a retry button re-runs the probe without a page reload.
//
//   degraded = null                          healthy
//            = { code: "missing" }           404 on health AND list: the py
//                                            part has no stack routes (old
//                                            py/ - typically only web/ was
//                                            replaced during an update)
//            = { code: "network" }           fetch threw (server down, page
//                                            not served by ComfyUI)
//            = { code: "http", detail: "500" }  any other non-OK status
//            = { code: "nowrite", detail: dir }  health says the storage
//                                            folder is not writable
//            = { code: "legacy" }            health 404 but the v70 list route
//                                            answers: storage WORKS, py is
//                                            just older than v76
//            = { code: "mismatch", detail: "vNN" }  storage works but the py
//                                            pack version differs from the
//                                            web build - half-updated install
// ---------------------------------------------------------------------------

const BUILD = globalThis.__SettingsHubBuild || "v77";

function setDegraded(seq, d) {
    if (seq !== initSeq) return;
    degraded = d;
    serverOk = d ? (d.code === "legacy" || d.code === "mismatch") : true;
    renderNote();
}

async function probeServer(seq) {
    if (!apiReady()) { setDegraded(seq, { code: "network" }); return; }
    // v76+ servers answer /health with {ok, version, dir, writable, items}.
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/health");
        if (r && r.ok) {
            const j = await r.json().catch(() => null);
            if (seq !== initSeq) return;
            if (j && j.ok) {
                if (j.writable === false) {
                    setDegraded(seq, { code: "nowrite", detail: String(j.dir || "") });
                } else {
                    const v = typeof j.version === "string" ? j.version : "";
                    if (v && v !== BUILD) setDegraded(seq, { code: "mismatch", detail: v });
                    else setDegraded(seq, null);
                }
                return;
            }
            // ok:false - weird server; fall through to the list probe.
        } else if (seq === initSeq && r && r.status !== 404) {
            // A non-404 error on health means the routes ARE there but the
            // handler failed - report the status instead of falling through.
            setDegraded(seq, { code: "http", detail: String(r.status) });
            return;
        }
    } catch (_) { /* fall through to the list probe */ }
    // Legacy (v70-v75) or broken server: classify via the list route.
    try {
        const r = await app.api.fetchApi("/settings_hub/stack");
        if (seq !== initSeq) return;
        if (r && r.ok) { setDegraded(seq, { code: "legacy" }); return; }
        const st = r ? r.status : 0;
        if (st === 404) setDegraded(seq, { code: "missing" });
        else setDegraded(seq, { code: "http", detail: String(st) });
    } catch (_) {
        if (seq !== initSeq) return;
        setDegraded(seq, { code: "network" });
    }
}

async function apiGet() {
    if (!apiReady()) return null;
    try {
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack"));
        if (!r || !r.ok) return null;
        const j = await r.json();
        return Array.isArray(j?.items) ? j.items.filter((x) => x && x.id) : [];
    } catch (_) { return null; }
}

async function apiAddText(text, name) {
    try {
        const body = { text };
        if (name) body.name = String(name);
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/item"), {
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
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/image?" + q.toString()), {
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
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/file?" + q.toString()), {
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
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/item/" + encodeURIComponent(id)), { method: "DELETE" });
        return !!(r && r.ok);
    } catch (_) { return false; }
}

async function apiClear() {
    if (!apiReady()) return false;
    try {
        // v77: in per-workflow mode this clears ONLY the active workflow's
        // store (?wf= is appended by scopeUrl) - the shared stack and the
        // other workflows keep their entries.
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/clear"), { method: "POST" });
        return !!(r && r.ok);
    } catch (_) { return false; }
}

/** v72: metadata edit (rename/tags/pin/uses). Resolves with the updated
 *  item from the server (or null when the route/entry is unavailable). */
async function apiPatch(id, patch) {
    if (!apiReady()) return null;
    try {
        const r = await app.api.fetchApi(scopeUrl("/settings_hub/stack/patch"), {
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
    // v76: surface the failure in the note too (the probe verdict may not
    // exist yet when the very first add fails).
    if (!degraded || degraded.code === "legacy" || degraded.code === "mismatch") {
        degraded = { code: "network" };
    }
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
 *  event originates inside it) and no text field owns the focus - INCLUDING
 *  the panel's own search/editor inputs (v74): a Ctrl+V aimed at them pastes
 *  INTO them instead of becoming a new entry. The user's normal Ctrl+V into
 *  editors is never disturbed. When the browser event carries nothing usable
 *  (files copied in Explorer fire an empty paste) the OS helper is asked
 *  before giving up. */
function onPasteEvent(e) {
    if (!mounted || !isStackOn()) return;
    const inPanel = (() => { try { return panel?.contains(e.target); } catch (_) { return false; } })();
    if (!pasteHover && !inPanel) return;
    const ae = document.activeElement;
    const aeEditable = (() => {
        try {
            return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" ||
                ae.isContentEditable);
        } catch (_) { return false; }
    })();
    if (aeEditable) return; // the focused editor (hub OR panel) wins
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
            ? await app.api.fetchApi(scopeUrl("/settings_hub/stack/file/" + encodeURIComponent(name || "")))
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
            const b = await fetchBlob(scopeUrl("/settings_hub/stack/file/" + encodeURIComponent(item.file)));
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
        listEl.innerHTML = getStackScope() === "workflow"
            ? `<div class="hub-stack-empty">Stack is empty for THIS workflow - copy something,<br>then click the paste area (or Ctrl+V over the panel).<br>Per-workflow entries are saved with the workflow.</div>`
            : `<div class="hub-stack-empty">Stack is empty - copy something,<br>then click the paste area (or Ctrl+V over the panel),<br>or drop a file here.</div>`;
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

/** v77: the header scope badge - visible only in per-workflow mode, so the
 *  active scope is never a hidden dimension. */
function renderScope() {
    const el = headEl?.querySelector(".hub-stack-scope");
    if (!el) return;
    if (getStackScope() === "workflow") {
        el.style.display = "";
        el.textContent = "@workflow";
        el.title = "Per-workflow stack: THIS workflow keeps its own entries (the binding id is saved inside the workflow file)";
    } else {
        el.style.display = "none";
        el.textContent = "";
    }
}

function renderNote() {
    if (!noteEl) return;
    const d = degraded;
    if (!d) {
        noteEl.style.display = "none";
        noteEl.classList.remove("hub-stack-note-ok");
        noteEl.textContent = "";
        noteEl.innerHTML = "";
        return;
    }
    const TITLES = {
        missing: "server storage unreachable - entries last this session only",
        network: "server storage unreachable - entries last this session only",
        http: "storage check failed (HTTP " + (d.detail || "?") + ")",
        nowrite: "storage folder is not writable - entries last this session only",
        legacy: "storage works (server py is v70-v75, no /health yet)",
        mismatch: "version mismatch (storage is ON)",
    };
    const WHY = {
        missing: "The ComfyUI server has NO /settings_hub/stack routes: the Python part of the pack is missing or older than v70 - typically only web/ was replaced during an update. Reinstall the FULL zip (all folders) and RESTART ComfyUI.",
        network: "The request to the ComfyUI server failed. Check that ComfyUI is running and this page is served by it (same address/port).",
        http: "The ComfyUI server answered HTTP " + (d.detail || "?") + " for the stack storage. Check the ComfyUI console for the Python error.",
        nowrite: "The stack storage folder cannot be written: " + (d.detail || "?") + ". Fix the folder permissions, then press \u21bb.",
        legacy: "Everything works. The Python part just predates v76 self-diagnostics - updating the full pack is recommended.",
        mismatch: "Server py/ = " + (d.detail || "?") + " while web = " + BUILD + ". If you just updated - restart ComfyUI (py/ loads once at startup); otherwise reinstall the FULL zip (all folders).",
    };
    noteEl.style.display = "";
    noteEl.classList.toggle("hub-stack-note-ok", d.code === "legacy" || d.code === "mismatch");
    noteEl.textContent = "";
    const head = document.createElement("div");
    head.className = "hub-stack-note-head";
    head.textContent = (d.code === "legacy" ? "\u2713" : "\u26a0") + " Paste Stack " + (TITLES[d.code] || TITLES.network);
    const why = document.createElement("div");
    why.className = "hub-stack-note-why";
    why.textContent = WHY[d.code] || WHY.network;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "hub-stack-note-retry";
    retry.textContent = "\u21bb check again";
    noteEl.append(head, why, retry);
}

function renderAll() {
    renderList();
    renderBadge();
    renderNote();
    renderToolbar();
    renderScope();
    syncWorkflowEmbed();
}

// ---------------------------------------------------------------------------
// v77: workflow file backup (per-workflow scope)
// ---------------------------------------------------------------------------
// Every render mirrors the current TEXT entries into
// app.graph.extra.settingshubStack (inline texts only - blobs would bloat the
// workflow file with base64). When that workflow's SERVER store is empty
// while the embedded copy exists (workflow moved to another machine, user
// folder wiped, ComfyUI reinstalled), refreshFromServer re-adds the embedded
// texts automatically. Deletions/clears propagate the same way: the embed is
// rewritten from the live list, so a cleared workflow stays cleared.

function syncWorkflowEmbed() {
    try {
        if (getStackScope() !== "workflow") return;
        const g = app?.graph;
        if (!g) return;
        // Sync only when the list is a KNOWN truth: a working server (the
        // list may legitimately be empty - the user cleared it) or any local
        // content. An unknown/dead server with an empty list must not wipe
        // the file's backup before the first refresh answers.
        if (!stackItems.length && serverOk !== true) return;
        const extra = g.extra || (g.extra = {});
        const out = [];
        let budget = WF_EMBED_BUDGET;
        for (const it of stackItems) {
            if (out.length >= WF_EMBED_MAX || budget <= 0) break;
            if (it.type !== "text" || typeof it.text !== "string" || !it.text.trim()) continue;
            const e = { t: "text", text: it.text };
            if (it.name) e.name = String(it.name).slice(0, 120);
            if (Array.isArray(it.tags) && it.tags.length) e.tags = it.tags.slice(0, 8);
            if (it.pinned) e.pinned = true;
            out.push(e);
            budget -= it.text.length;
        }
        extra[WF_EMBED_KEY] = out;
    } catch (_) {}
}

/** Re-add the workflow-file text backup when the server store is empty.
 *  Returns the number of restored entries (0 = nothing to do). The server
 *  dedups by content, so a restore can never duplicate surviving entries. */
async function rehydrateWorkflowTexts() {
    try {
        if (getStackScope() !== "workflow") return 0;
        const arr = app?.graph?.extra?.[WF_EMBED_KEY];
        if (!Array.isArray(arr) || !arr.length) return 0;
        let n = 0;
        for (const e of arr.slice(0, WF_EMBED_MAX)) {
            if (!e || e.t !== "text" || typeof e.text !== "string" || !e.text.trim()) continue;
            const res = await apiAddText(e.text, e.name);
            if (res?.ok) {
                n++;
                if (Array.isArray(e.tags) && e.tags.length) {
                    await apiPatch(res.item?.id, { tags: e.tags.slice(0, 8) }).catch(() => {});
                }
                if (e.pinned && res.item?.id) {
                    await apiPatch(res.item.id, { pinned: true }).catch(() => {});
                }
            }
        }
        if (n) localToast("Restored " + n + " text snippet(s) saved in this workflow");
        return n;
    } catch (_) { return 0; }
}

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

// v74: kind-aware combo detection. Name matches cover the classic loaders
// (LoadImage "image", VHS Load Video "video", LoadAudio "audio"); the
// options flags cover the native LoadVideo, whose combo is just named
// "file" but carries options.video_upload (same for audio_upload).
function uploadWidgetOf(node, kind) {
    if (!node || node.flags?.collapsed) return null;
    try {
        const ws = Array.isArray(node.widgets) ? node.widgets : [];
        for (const w of ws) {
            if (!w) continue;
            if (!(w.type === "combo" || w.options?.values || w.options?.upload)) continue;
            const o = w.options || {};
            if (kind === "image" && (o.image_upload || w.name === "image")) return w;
            if (kind === "video" && (o.video_upload || w.name === "video" || w.name === "video_file")) return w;
            if (kind === "audio" && (o.audio_upload || w.name === "audio")) return w;
        }
        return null;
    } catch (_) { return null; }
}

function imageWidgetOf(node) { return uploadWidgetOf(node, "image"); }

// v74: TEXT cards dropped on a real node write a string widget.
function isTextWidget(w) {
    if (!w || w.disabled) return false;
    return w.type === "string" || w.type === "customtext" || w.type === "text" ||
        !!(w.options && w.options.multiline);
}

function textWidgetsOf(node) {
    if (!node || node.flags?.collapsed) return [];
    try {
        const ws = Array.isArray(node.widgets) ? node.widgets : [];
        return ws.filter(isTextWidget);
    } catch (_) { return []; }
}

/** The text widget under the cursor (LiteGraph hit-test), else the node's
 *  first text widget (prompt nodes usually carry exactly one). */
function textWidgetAt(node, gx, gy) {
    try {
        const w = app.canvas?.getWidgetOnPos?.(gx, gy);
        if (w && isTextWidget(w)) return w;
    } catch (_) {}
    return textWidgetsOf(node)[0] || null;
}

function pointToGraph(cx, cy) {
    try {
        const c = app.canvas;
        if (!c?.canvas) return null;
        if (elemFromPoint(cx, cy) !== c.canvas) return null;
        const rect = c.canvas.getBoundingClientRect();
        const ds = c.ds || { scale: 1, offset: [0, 0] };
        const gx = (cx - rect.left) / (ds.scale || 1) - (ds.offset?.[0] || 0);
        const gy = (cy - rect.top) / (ds.scale || 1) - (ds.offset?.[1] || 0);
        const graph = app.graph ?? c.graph;
        const node = graph?.getNodeOnPos?.(gx, gy, true) ?? null;
        return node ? { node, gx, gy } : null;
    } catch (_) { return null; }
}

function nodeFromPoint(cx, cy) { return pointToGraph(cx, cy)?.node ?? null; }

function showTargetBox(node, wkind) {
    try {
        const c = app.canvas;
        if (!c?.canvas) return;
        if (!targetBox) {
            targetBox = document.createElement("div");
            targetBox.className = "hub-stack-targetbox";
            document.body.appendChild(targetBox);
        }
        // v74: a TEXT drop target gets its own (blue) highlight variant
        targetBox.classList.toggle("hub-stack-targetbox-text", wkind === "text");
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
        showTargetBox(target.node, target.wkind);
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
    const t = dragCtx.item.type;
    let target = null;
    if (t === "text") {
        // v72: text cards land on hub text mirrors ...
        const textEl = el?.closest?.(".hub-text-input, .hub-text-area");
        if (textEl) target = { kind: "text", el: textEl };
    } else {
        // ... media cards land on hub media mirrors
        const mirror = el?.closest?.(".hub-mirror-media");
        if (mirror) target = { kind: "mirror", el: mirror };
    }
    if (!target) {
        // v74: REAL GRAPH NODES as targets - image/video/audio cards need a
        // kind-matched upload combo, text cards a string widget.
        const g = pointToGraph(e.clientX, e.clientY);
        if (g) {
            if (t === "text") {
                const w = textWidgetAt(g.node, g.gx, g.gy);
                if (w) target = { kind: "node", node: g.node, widget: w, wkind: "text" };
            } else if (t === "image" || t === "video" || t === "audio") {
                const w = uploadWidgetOf(g.node, t);
                if (w) target = { kind: "node", node: g.node, widget: w, wkind: t };
            }
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
    if (t?.kind === "node") {
        // v74: the target carries the widget picked during the drag
        if (t.wkind === "text") dropOnTextNode(ctx, t.node, t.widget);
        else dropOnLoaderNode(ctx, t.node, t.widget);
    }
    else if (t?.kind === "mirror") dropOnMirror(ctx, t.el);
    else if (t?.kind === "text") dropOnTextMirror(ctx, t.el);
}

function onCardMouseDown(e) {
    if (!mounted || e.button !== 0) return;
    if (e.target?.closest?.("button, a, input, textarea, video, audio")) return;
    const card = e.target?.closest?.(".hub-stack-card");
    if (!card) return;
    // v71/v74: images drag onto loader nodes / media mirrors; TEXT cards drag
    // onto hub text mirrors or REAL prompt nodes; video/audio onto matching
    // loaders (VHS Load Video, LoadAudio) or media mirrors.
    const kind = card.dataset.type;
    if (kind !== "image" && kind !== "text" && kind !== "video" && kind !== "audio") return;
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

async function dropOnLoaderNode(ctx, node, widget) {
    // v74: the widget resolved during the drag; re-resolve as a fallback
    const w = widget || uploadWidgetOf(node, ctx.item.type === "file" ? "image" : ctx.item.type);
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

/** v74: a TEXT card dropped on a REAL node writes its text into a string
 *  widget (the row under the cursor, else the node's first text widget) -
 *  the same route a manual edit takes, so preview refresh hooks fire. */
async function dropOnTextNode(ctx, node, widget) {
    const w = widget || textWidgetsOf(node)[0];
    if (!w) { localToast("No text field on this node"); return; }
    try {
        const text = await itemText(ctx.item);
        if (!text) { localToast("Entry has no text"); return; }
        const old = w.value;
        w.value = text;
        try { w.callback?.(text, app.canvas, node); } catch (_) {}
        try { node.onWidgetChanged?.(w.name, text, old, w); } catch (_) {}
        try { app.canvas.setDirty?.(true, true); } catch (_) {}
        localToast(`Text into ${node.title || node.type || "node"}`);
        bumpUses(ctx.item);
    } catch (_) { localToast("Drop failed"); }
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
        `<span class="hub-stack-scope" style="display:none"></span>` +
        `<span class="hub-stack-count">0</span>` +
        `<button type="button" class="hub-btn hub-stack-clear" title="Clear ALL entries (click twice to confirm)">🗑</button>` +
        `<button type="button" class="hub-btn hub-stack-min" title="Minimize to chip">–</button>` +
        // v75: no [✕] close button - the panel is dismissed only via
        // ⚙ Hub settings → Stack → Off (setStackOn(false) from the renderer).
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
    panel.querySelector(".hub-stack-clear").addEventListener("click", (e) => panelClearAll(e.currentTarget));
    panel.querySelector(".hub-stack-min").addEventListener("click", () => setMinimized(true));
    // v75: the hide/close wiring is intentionally absent - see buildDom().
    chip.addEventListener("click", () => setMinimized(false));

    // v76: retry button inside the degraded note - re-probe + re-sync without
    // a page reload (fixing the server side, e.g. reinstalling the pack, takes
    // effect immediately).
    noteEl.addEventListener("click", (e) => {
        if (!e.target?.closest?.(".hub-stack-note-retry")) return;
        const seq = initSeq;
        void (async () => {
            await probeServer(seq);
            if (seq !== initSeq) return;
            await refreshFromServer(seq);
        })();
    });

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
    // v74: the inline editor commits on Enter and cancels on Escape
    listEl.addEventListener("keydown", (e) => {
        const inEditor = e.target?.closest?.(".hub-stack-edit-name, .hub-stack-edit-tags");
        if (!inEditor) return;
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const card = inEditor.closest(".hub-stack-card");
            const item = stackItems.find((x) => x.id === card?.getAttribute("data-id"));
            if (item) saveEdit(card, item);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            editId = null;
            renderAll();
        }
    });
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
    // the shared server stack); debounced + sequence-guarded. v77 fix: the
    // refresh MUST carry the current sequence - a bare refreshFromServer()
    // failed the seq guard and has been a silent no-op since v70.
    let focusTimer = 0;
    window.addEventListener("focus", () => {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => refreshFromServer(initSeq), 800);
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
    let remote = await apiGet();
    if (seq !== initSeq) return; // a newer init/refresh superseded this fetch
    if (remote === null) {
        if (serverOk !== false) { serverOk = false; }
        // v76: keep a MORE PRECISE probe verdict (missing/http/nowrite);
        // only fill in the generic network verdict when we know nothing.
        if (!degraded || degraded.code === "mismatch" || degraded.code === "legacy") {
            degraded = { code: "network" };
        }
        renderNote();
        return;
    }
    serverOk = !(degraded && degraded.code === "nowrite"); // reads may work while writes are broken
    // v76: a successful list GET proves the data path - it contradicts only a
    // "missing" (list 404) or "network" (fetch threw) verdict. http/nowrite/
    // legacy/mismatch describe OTHER layers (health handler, folder rights,
    // versions) that a working list route does NOT refute.
    if (degraded && (degraded.code === "network" || degraded.code === "missing")) {
        degraded = null;
    }
    // v77: per-workflow scope - an EMPTY workflow store while the workflow
    // FILE carries a text backup means the payloads are gone server-side
    // (workflow moved to another machine, user folder wiped): re-add the
    // embedded texts once, then re-read the store.
    if (getStackScope() === "workflow" && remote.length === 0) {
        const restored = await rehydrateWorkflowTexts();
        if (seq !== initSeq) return;
        if (restored > 0) {
            remote = await apiGet();
            if (seq !== initSeq) return;
            if (remote === null) remote = [];
        }
    }
    // Keep session-only entries (if any) on top of the server truth.
    const locals = stackItems.filter((x) => x.local);
    stackItems = [...locals, ...remote.filter((x) => !locals.some((l) => l.id === x.id))];
    renderAll();
}

// ---------------------------------------------------------------------------
// Public init (entry calls this from extension setup; idempotent)
// ---------------------------------------------------------------------------

/** v77: LiteGraph fires onConfigure when a workflow finished loading (its
 *  extra - with the stack id and the text backup - is already in place) and
 *  onClear when the canvas is wiped ("New"). Both mean: the workflow
 *  changed. In per-workflow mode the panel re-reads THAT workflow's store;
 *  in shared mode nothing changes (one stack for all). The wrapper is
 *  installed once per graph instance and always calls the original hook. */
function hookWorkflowSwitch() {
    try {
        const g = app?.graph;
        if (!g || g.__shStackWfHook) return;
        g.__shStackWfHook = true;
        const fire = () => {
            try {
                if (!mounted) return;
                if (getStackScope() !== "workflow") return;
                const seq = ++initSeq;
                stackItems = [];        // session-only entries belong to the PREVIOUS workflow
                localBlobs.clear();
                editId = null;
                // renderList/badge ONLY - renderAll would syncWorkflowEmbed()
                // the still-empty list into the NEW workflow's extra and wipe
                // its text backup before refreshFromServer can rehydrate it.
                renderList();
                renderBadge();
                void refreshFromServer(seq);
            } catch (_) {}
        };
        const oc = g.onConfigure;
        g.onConfigure = function () {
            try { if (typeof oc === "function") oc.apply(this, arguments); } finally { fire(); }
        };
        const ocl = g.onClear;
        g.onClear = function () {
            try { if (typeof ocl === "function") ocl.apply(this, arguments); } finally { fire(); }
        };
    } catch (_) {}
}

export function initStack() {
    if (!isStackOn()) return;
    const seq = ++initSeq;
    teardown();
    // v77: a fresh context - the list must never leak ACROSS scopes. In
    // per-workflow mode a stale list (e.g. the shared store's entries right
    // after a scope switch) would be embedded into the WRONG workflow file
    // by the first renderAll, and the server would then "restore" it into
    // the new store - a silent migration, exactly what rule 7 forbids.
    // Within ONE scope a remount keeps the list: session-only entries must
    // survive a settings Off/On toggle (the SH recovery contract).
    const scopeNow = getStackScope();
    if (scopeNow !== lastMountScope) {
        stackItems = [];
        localBlobs.clear();
    }
    lastMountScope = scopeNow;
    degraded = null;
    serverOk = null; // v77: unknown until the probe answers - the embed guard needs this
    buildDom();
    mounted = true;
    renderAll();
    hookWorkflowSwitch();
    // v77: in per-workflow mode mark the workflow with its stack id right
    // away (idempotent) so the binding is in the file even before the first
    // capture.
    if (getStackScope() === "workflow") workflowStackId();
    // v76: probe FIRST (classifies the server), then sync the data.
    void (async () => {
        await probeServer(seq);
        if (seq !== initSeq) return;
        await refreshFromServer(seq);
    })();
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
        pointToGraph,
        imageWidgetOf,
        uploadWidgetOf,
        textWidgetsOf,
        textWidgetAt,
        dropOnTextNode,
        panelClearAll,
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
        // v77: scope introspection for the smoke tests
        scope: () => getStackScope(),
        workflowId: () => workflowStackId(),
        fireWorkflowSwitch: () => {
            try { app?.graph?.onConfigure?.(); } catch (_) {}
        },
    };
}

