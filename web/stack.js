// ============================================================================
// SettingsHub - Paste Stack (v70): standalone floating clipboard panel
// ----------------------------------------------------------------------------
// v70 BUILD GUARD (must be the FIRST executable statement, before any work):
// the loader entry stamps globalThis.__SettingsHubBuild before importing the
// submodules; this module refuses to stay silent if it was loaded as part of
// a MIXED build. See settings_hub.js for the field history.
// ============================================================================
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["stack"] = true;
if (globalThis.__SettingsHubBuild !== "v70") {
    console.error("[SettingsHub] STALE BUILD: stack.js (v70) was loaded under entry build [" +
        (globalThis.__SettingsHubBuild ?? "unknown") +
        "] - the browser served cached modules. Hard-refresh the page (Ctrl+F5).");
}

// ============================================================================
// A floating clipboard-history panel that lives ALONGSIDE the hub (owner
// decision 2026-11-08: a SEPARATE panel, not a hub tab - the user works with
// the hub and the stack at the same time). Modeled on Nougan's Paste Stack
// (research: docs/plan-paste-stack.md) with the storage decision REVERSED:
//
//   * Server-side persistence (py/stack_store.py): entries live in
//     <ComfyUI>/user/settings_hub/stack/ (index.json + items/) so the stack
//     travels with the ComfyUI folder - portability - and is shared by every
//     origin/browser/profile. The browser is a thin client; the server index
//     is the source of truth. When the routes are missing (extension updated
//     without a ComfyUI restart) the panel degrades to a session-only
//     in-memory stack and says so.
//
//   * Capture: click the paste area (navigator.clipboard.read) or press
//     Ctrl+V while hovering the panel (window paste event; a focused text
//     field OUTSIDE the panel is never stolen). v70 accepts text + images;
//     files from Explorer need the v71 python helper.
//
//   * Dedup: re-adding the same content MOVES the existing card to the top
//     (server hash check) instead of stacking a copy.
//
//   * Copy-back: click a card -> the content returns to the system clipboard
//     (writeText / ClipboardItem), then Ctrl+V anywhere.
//
//   * Limits: the client-configured max (gear popup "Stack" section) evicts
//     the OLDEST entries after each add; server hard caps (500 / 200 MB)
//     guard the storage regardless.
//
//   * UI: drag the header, resize from the bottom-right grip, [–] minimizes
//     to a chip with a live count badge, [✕] hides the panel (gear popup
//     brings it back). Position/size/minimized state live in localStorage.
// ============================================================================

import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Constants + tiny utils
// ---------------------------------------------------------------------------

const LS_UI = "settingshub.stack.ui";      // {x,y,w,h,min,chipX,chipY}
const LS_ON = "settingshub.stack.on";      // "1"/"0" - panel enabled
const LS_MAX = "settingshub.stack.max";    // client eviction threshold

export const STACK_MAX_CHOICES = [25, 50, 100, 200, 500];
const STACK_MAX_DEFAULT = 100;
const MAX_TEXT_CHARS = 1_000_000;      // mirrors py/stack_store.py
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const TEXT_EXCERPT = 260;
const IMG_EXT_OK = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const Z_PANEL = "99900";               // under project popups (100000), over canvas

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

function fileUrl(name) {
    const p = "/settings_hub/stack/file/" + encodeURIComponent(name || "");
    try { return app.api?.apiURL ? app.api.apiURL(p) : p; } catch (_) { return p; }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panel = null;        // .hub-stack-panel root
let headEl = null, listEl = null, pasteEl = null, noteEl = null;
let chip = null;         // minimized chip
let grip = null;         // resize handle

let stackItems = [];     // server index mirror, TOP-first
let serverOk = null;     // null=unknown, true, false
let mounted = false;
let pasteHover = false;  // cursor over the panel (paste-event gate)
let clearArmTs = 0;      // clear-button double-confirm window
let initSeq = 0;         // guards against stale async fetches across re-init

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

async function apiAddText(text) {
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });
        if (!r || !r.ok) return { ok: false };
        return await r.json();
    } catch (_) { return { ok: false }; }
}

async function apiAddImage(blob, ext) {
    try {
        const r = await app.api.fetchApi("/settings_hub/stack/image?ext=" + encodeURIComponent(ext), {
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

// ---------------------------------------------------------------------------
// Mutations + client-side eviction
// ---------------------------------------------------------------------------

let localSeq = 0; // ids for session-only entries when the server is down

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

function localTextItem(text) {
    return { id: "local-" + (++localSeq), type: "text", text, created: Math.floor(Date.now() / 1000), local: true };
}

function localImageItem(url, ext) {
    return { id: "local-" + (++localSeq), type: "image", localUrl: url, file: null, ext, created: Math.floor(Date.now() / 1000), local: true };
}

/** The client max evicts the OLDEST tail (server hard caps guard the rest). */
async function enforceMax() {
    const max = getStackMax();
    while (stackItems.length > max) {
        const victim = stackItems[stackItems.length - 1];
        if (victim.pinned) break; // reserved for v72; guarded already
        const ok = await apiDelete(victim.id);
        if (!ok && !victim.local) break; // server decides eviction when unreachable
        stackItems.pop();
        renderAll();
    }
}

// ---------------------------------------------------------------------------
// Capture paths
// ---------------------------------------------------------------------------

async function addText(text) {
    const t = String(text ?? "");
    if (!t.trim()) return false;
    if (t.length > MAX_TEXT_CHARS) { localToast("Text too large (1M char limit)"); return false; }
    applyServerAdd(await apiAddText(t), localTextItem(t));
    if (serverOk === false) localToast("Stack not persisted - restart ComfyUI to enable storage");
    return true;
}

async function addImageBlob(blob, name) {
    if (!blob || !blob.size) return false;
    if (blob.size > MAX_IMAGE_BYTES) { localToast("Image too large (25 MB limit)"); return false; }
    let ext = (String(name || "").split(".").pop() || "").toLowerCase();
    if (!IMG_EXT_OK.has(ext)) ext = blob.type === "image/jpeg" ? "jpg" : "png";
    const url = URL.createObjectURL(blob);
    const res = await apiAddImage(blob, ext);
    applyServerAdd(res, localImageItem(url, ext));
    if (serverOk === false) localToast("Stack not persisted - restart ComfyUI to enable storage");
    return true;
}

/**
 * Core capture used by every path (paste event, clipboard.read, tests).
 * data: {text?: string, files?: FileList|Array} - files are filtered to
 * images in v70 (Explorer files arrive with the v71 helper).
 */
async function captureFromClipboardData(data) {
    if (!data) return false;
    let captured = false;
    if (typeof data.text === "string") {
        captured = (await addText(data.text)) || captured;
    }
    const files = data.files;
    if (files && typeof files.length === "number") {
        for (const f of Array.from(files)) {
            if (!f || !String(f.type || "").startsWith("image/")) continue; // v71: all files
            captured = (await addImageBlob(f, f.name)) || captured;
        }
    }
    return captured;
}

/** Click on the paste area: read the system clipboard directly. */
async function captureFromRead() {
    try {
        if (!navigator.clipboard || typeof navigator.clipboard.read !== "function" || !window.isSecureContext) {
            localToast("Clipboard API unavailable here - press Ctrl+V while hovering the panel");
            return;
        }
        const clips = await navigator.clipboard.read();
        let any = false;
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
        if (!any) localToast("Nothing to paste yet - copy something first");
    } catch (err) {
        localToast("Clipboard read blocked - press Ctrl+V while hovering the panel");
    }
}

/** window paste event: capture when the cursor hovers the panel (or the
 *  event originates inside it) and no text field OUTSIDE the panel owns the
 *  focus - the user's normal Ctrl+V into editors is never disturbed. */
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
    captureFromClipboardData(data);
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
        // image
        const src = item.localUrl || (item.file ? fileUrl(item.file) : null);
        if (!src || !navigator.clipboard?.write || !window.ClipboardItem || !window.isSecureContext) {
            localToast("Image copy unavailable - open the image URL instead");
            return;
        }
        const blob = await (await fetch(src)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
        localToast("Image copied - Ctrl+V where you need it");
    } catch (_) {
        localToast("Copy failed");
    }
}

async function fetchTextFile(name) {
    try {
        const r = await fetch(fileUrl(name));
        return r.ok ? await r.text() : "";
    } catch (_) { return ""; }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cardHtml(item) {
    const isImg = item.type === "image";
    const preview = isImg
        ? `<img class="hub-stack-thumb" loading="lazy" alt="" src="${esc(item.localUrl || (item.file ? fileUrl(item.file) : ""))}">`
        : `<div class="hub-stack-text">${esc(excerptOf(item))}</div>`;
    const meta = isImg
        ? `image${item.size ? " · " + Math.max(1, Math.round(item.size / 1024)) + " KB" : ""}`
        : `${(item.text != null ? item.text.length : item.size || 0).toLocaleString()} chars`;
    return `<div class="hub-stack-card" data-id="${esc(item.id)}" data-type="${item.type}" title="Click: copy back to clipboard">` +
        `<div class="hub-stack-card-main">${preview}` +
        `<div class="hub-stack-meta"><span>${esc(meta)}</span><span>${esc(fmtTime(item.created))}${item.local ? " · session" : ""}</span></div></div>` +
        `<button type="button" class="hub-stack-del" title="Delete entry">✕</button>` +
        `</div>`;
}

function excerptOf(item) {
    let t = item.text;
    if (t == null && item.file) return "(large text file)";
    t = String(t ?? "");
    return t.length > TEXT_EXCERPT ? t.slice(0, TEXT_EXCERPT) + "…" : t;
}

function renderList() {
    if (!listEl) return;
    if (!stackItems.length) {
        listEl.innerHTML = `<div class="hub-stack-empty">Stack is empty - copy something,<br>then click the paste area (or Ctrl+V over the panel).</div>`;
        return;
    }
    listEl.innerHTML = stackItems.map(cardHtml).join("");
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

function renderAll() { renderList(); renderBadge(); renderNote(); }

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
// Mount / teardown
// ---------------------------------------------------------------------------

function teardown() {
    try { panel?.remove(); } catch (_) {}
    try { chip?.remove(); } catch (_) {}
    panel = chip = headEl = listEl = pasteEl = noteEl = grip = null;
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

    // card interactions (event delegation)
    listEl.addEventListener("click", (e) => {
        const card = e.target.closest?.(".hub-stack-card");
        if (!card) return;
        const id = card.getAttribute("data-id");
        const item = stackItems.find((x) => x.id === id);
        if (!item) return;
        if (e.target.closest?.(".hub-stack-del")) {
            deleteOne(item);
            return;
        }
        copyBack(item);
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
        addText,
        addImageBlob,
        items: () => stackItems.slice(),
        serverOk: () => serverOk,
        panelEl: () => panel,
        chipEl: () => chip,
        listEl: () => listEl,
        setPasteHover: (v) => { pasteHover = !!v; },
        refresh: () => refreshFromServer(initSeq),
        mount: initStack,
    };
}
