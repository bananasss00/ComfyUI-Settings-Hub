// ============================================================================
// SettingsHub - Image Compare (v73): A/B comparison of workflow images
// ----------------------------------------------------------------------------
// v73 BUILD GUARD (must be the FIRST executable statement, before any work):
// the loader entry stamps globalThis.__SettingsHubBuild before importing the
// submodules; this module refuses to stay silent if it was loaded as part of
// a MIXED build. See settings_hub.js for the field history.
// ============================================================================

// ============================================================================
// The single feature taken from Nougan_Nodes (owner decision 2026-11-08,
// docs/plan-paste-stack.md §3.1): A/B-compare two images of the workflow in
// a floating panel.
//
//   * Sources: a hub MEDIA ROW preview, a gallery thumbnail or a Paste Stack
//     image card - right-click one and pick "Add to Compare". The first add
//     fills slot A, the second slot B, further adds SHIFT (A<-B, B<-new).
//   * Modes: WIPE (draggable divider), FADE (crossfade slider), BLINK
//     (click the stage = A<->B flash), DIFF (pixel |A-B| x gain 1..10).
//   * A/B swap; labels follow the source rows; slot clear buttons.
//   * AUTO-REFRESH: the panel re-reads the SOURCE elements on every
//     api "executed" event - a new queue run that replaced a loader's file
//     updates the comparison without touching the panel.
//   * Persisted: position/size/mode/gain/wipe/fade in localStorage
//     (settingshub.compare.ui). The panel is built lazily on the first add.
// ============================================================================

// v73 BUILD GUARD (see settings_hub.js): every submodule self-reports under
// __SettingsHubLoaded so the entry can NAME stale cached files.
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["compare"] = true;
if (globalThis.__SettingsHubBuild !== "v80") {
    console.error("[SettingsHub] STALE BUILD: compare.js (v77) was loaded under entry build [" +
        (globalThis.__SettingsHubBuild ?? "unknown") +
        "] - the browser served cached modules. Hard-refresh the page (Ctrl+F5).");
}

const LS_UI = "settingshub.compare.ui";
const Z_PANEL = "99900";

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panel = null, stageEl = null, slotAEl = null, slotBEl = null;
let imgA = null, imgB = null, canvasEl = null, dividerEl = null;
let modeSel = null, gainWrap = null, gainInput = null, fadeWrap = null, fadeInput = null;
let labelA = null, labelB = null;
let headEl = null, grip = null, toolsHint = null;

const slots = {
    A: { src: "", label: "", srcEl: null },
    B: { src: "", label: "", srcEl: null },
};
let mode = "wipe";
let gain = 3;      // diff gain 1..10
let fade = 50;     // fade percent 0..100
let split = 50;    // wipe percent 0..100
let blinkOn = false;
let wired = false; // contextmenu + executed listeners installed
let apiHook = null; // the "executed" listener (kept for teardown)

const MODES = [
    ["wipe", "Wipe"],
    ["fade", "Fade"],
    ["blink", "Blink"],
    ["diff", "Diff"],
];

// ---------------------------------------------------------------------------
// Source extraction (media rows / gallery thumbs / stack cards)
// ---------------------------------------------------------------------------

function mediaSrcFromHost(host) {
    try {
        const el = host.querySelector("img, video") || host;
        const src = el.src || el.currentSrc || "";
        return src ? String(src) : "";
    } catch (_) { return ""; }
}

function labelFromHost(host) {
    try {
        const row = host.closest?.("[data-hub-item]");
        const lbl = row?.querySelector(".hub-item-label")?.textContent?.trim();
        if (lbl) return lbl;
        const card = host.closest?.(".hub-stack-card");
        if (card) {
            const nm = card.querySelector(".hub-stack-name, .hub-stack-file-name")?.textContent?.trim();
            if (nm) return nm;
        }
        return "";
    } catch (_) { return ""; }
}

/**
 * Assign a source to a slot. First add -> A, second -> B, later adds SHIFT
 * the queue (A<-B, B<-new) so "right-click, right-click, right-click" walks
 * through pairs naturally. The SOURCE ELEMENT is remembered for the
 * auto-refresh (executed) reader.
 */
function addToCompare(src, label, srcEl, slot) {
    if (!src) { localToast("Nothing to compare - the source has no image"); return; }
    ensurePanel();
    const put = (k) => {
        slots[k] = { src: String(src), label: String(label || ""), srcEl: srcEl || null };
        localToast(`Compare ${k}: ${label || "image"}`);
    };
    if (slot === "A" || slot === "B") {
        put(slot);
    } else if (!slots.A.src) {
        put("A");
    } else if (!slots.B.src) {
        put("B");
    } else {
        slots.A = { ...slots.B };
        put("B");
    }
    renderSlots();
    if (mode === "diff") computeDiff();
}

function clearSlot(k) {
    slots[k] = { src: "", label: "", srcEl: null };
    renderSlots();
}

function swapSlots() {
    const t = { ...slots.A };
    slots.A = { ...slots.B };
    slots.B = t;
    renderSlots();
    if (mode === "diff") computeDiff();
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function ensurePanel() {
    if (panel && panel.isConnected) return;
    const ui = lsUi();
    mode = MODES.some((m) => m[0] === ui.mode) ? ui.mode : "wipe";
    gain = Math.min(10, Math.max(1, parseInt(ui.gain, 10) || 3));
    fade = Math.min(100, Math.max(0, parseInt(ui.fade, 10) ?? 50));
    split = Math.min(100, Math.max(0, parseInt(ui.split, 10) ?? 50));

    panel = document.createElement("div");
    panel.className = "hub-cmp-panel";
    panel.style.zIndex = Z_PANEL;
    panel.innerHTML =
        `<div class="hub-cmp-head" title="Drag to move">` +
        `<span class="hub-cmp-ico">⇆</span><span class="hub-cmp-title">Compare</span>` +
        `<button type="button" class="hub-btn hub-cmp-swap" title="Swap A and B">⇄</button>` +
        `<button type="button" class="hub-btn hub-cmp-close" title="Close (keeps the slots - reopen via Add to Compare)">✕</button>` +
        `</div>` +
        `<div class="hub-cmp-stage" title="Click: blink A↔B (blink mode)">` +
        `<div class="hub-cmp-slot hub-cmp-a"><img alt="" draggable="false"></div>` +
        `<div class="hub-cmp-slot hub-cmp-b"><img alt="" draggable="false"></div>` +
        `<canvas class="hub-cmp-canvas"></canvas>` +
        `<div class="hub-cmp-divider" title="Drag to move the wipe divider"></div>` +
        `<div class="hub-cmp-empty">Right-click a media row, gallery thumb or a Stack image card<br>→ "Add to Compare" (first add → A, second → B)</div>` +
        `</div>` +
        `<div class="hub-cmp-slots">` +
        `<span class="hub-cmp-slotlabel" data-slot="A"><b>A</b> <span class="hub-cmp-lbltext">-</span>` +
        `<button type="button" class="hub-btn hub-cmp-clear" data-clear="A" title="Clear slot A">✕</button></span>` +
        `<span class="hub-cmp-slotlabel" data-slot="B"><b>B</b> <span class="hub-cmp-lbltext">-</span>` +
        `<button type="button" class="hub-btn hub-cmp-clear" data-clear="B" title="Clear slot B">✕</button></span>` +
        `</div>` +
        `<div class="hub-cmp-tools">` +
        `<select class="hub-cmp-mode" title="Comparison mode">` +
        MODES.map((m) => `<option value="${m[0]}">${m[1]}</option>`).join("") +
        `</select>` +
        `<span class="hub-cmp-gainwrap" style="display:none">gain ` +
        `<input type="range" class="hub-cmp-gain" min="1" max="10" step="1"> <span class="hub-cmp-gainval"></span></span>` +
        `<span class="hub-cmp-fadewrap" style="display:none">fade ` +
        `<input type="range" class="hub-cmp-fade" min="0" max="100" step="1"> <span class="hub-cmp-fadeval"></span>%</span>` +
        `<span class="hub-cmp-hint"></span>` +
        `</div>` +
        `<div class="hub-cmp-grip" title="Drag to resize"></div>`;
    document.body.appendChild(panel);

    headEl = panel.querySelector(".hub-cmp-head");
    stageEl = panel.querySelector(".hub-cmp-stage");
    slotAEl = panel.querySelector(".hub-cmp-a");
    slotBEl = panel.querySelector(".hub-cmp-b");
    imgA = slotAEl.querySelector("img");
    imgB = slotBEl.querySelector("img");
    canvasEl = panel.querySelector(".hub-cmp-canvas");
    dividerEl = panel.querySelector(".hub-cmp-divider");
    modeSel = panel.querySelector(".hub-cmp-mode");
    gainWrap = panel.querySelector(".hub-cmp-gainwrap");
    gainInput = panel.querySelector(".hub-cmp-gain");
    fadeWrap = panel.querySelector(".hub-cmp-fadewrap");
    fadeInput = panel.querySelector(".hub-cmp-fade");
    labelA = panel.querySelector('[data-slot="A"] .hub-cmp-lbltext');
    labelB = panel.querySelector('[data-slot="B"] .hub-cmp-lbltext');
    toolsHint = panel.querySelector(".hub-cmp-hint");
    grip = panel.querySelector(".hub-cmp-grip");

    applyPos(ui.x ?? Math.max(16, (window.innerWidth || 1600) - 560), ui.y ?? 80);
    applySize(ui.w ?? 520, ui.h ?? 420);

    makeDraggable(headEl);
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
            const w = Math.min(Math.max(w0 + (ev.clientX - startX), 260), 1200);
            const h = Math.min(Math.max(h0 + (ev.clientY - startY), 220), 1000);
            applySize(w, h);
            saveUi({ w, h });
            if (mode === "diff") computeDiff();
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });

    panel.querySelector(".hub-cmp-swap").addEventListener("click", () => swapSlots());
    panel.querySelector(".hub-cmp-close").addEventListener("click", () => {
        panel.remove();
        panel = null;
    });
    for (const btn of panel.querySelectorAll(".hub-cmp-clear")) {
        btn.addEventListener("click", () => clearSlot(btn.dataset.clear));
    }

    modeSel.value = mode;
    modeSel.addEventListener("change", () => setMode(modeSel.value));
    gainInput.value = String(gain);
    gainInput.addEventListener("input", () => {
        gain = Math.min(10, Math.max(1, parseInt(gainInput.value, 10) || 3));
        panel.querySelector(".hub-cmp-gainval").textContent = String(gain) + "×";
        saveUi({ gain });
        if (mode === "diff") computeDiff();
    });
    fadeInput.value = String(fade);
    fadeInput.addEventListener("input", () => {
        fade = Math.min(100, Math.max(0, parseInt(fadeInput.value, 10) || 0));
        panel.querySelector(".hub-cmp-fadeval").textContent = String(fade);
        saveUi({ fade });
        applyModeStyles();
    });

    stageEl.addEventListener("click", (e) => {
        if (e.target.closest(".hub-cmp-divider")) return;
        if (mode !== "blink") return;
        blinkOn = !blinkOn;
        applyModeStyles();
    });

    // wipe divider drag
    dividerEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const move = (ev) => {
            const r = stageEl.getBoundingClientRect();
            const pct = Math.min(100, Math.max(0, ((ev.clientX - r.left) / (r.width || 1)) * 100));
            split = pct;
            saveUi({ split: Math.round(pct) });
            applyModeStyles();
        };
        const up = () => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
    stageEl.addEventListener("mousedown", (e) => {
        // click anywhere in wipe mode also moves the divider (Nougan-style)
        if (mode !== "wipe" || e.button !== 0) return;
        if (e.target.closest(".hub-cmp-divider")) return;
        const r = stageEl.getBoundingClientRect();
        const pct = Math.min(100, Math.max(0, ((e.clientX - r.left) / (r.width || 1)) * 100));
        split = pct;
        saveUi({ split: Math.round(pct) });
        applyModeStyles();
    });

    renderSlots();
    setMode(mode);
}

function makeDraggable(handle) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.("button, select, input")) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const ox = parseFloat(panel.style.left) || 0;
        const oy = parseFloat(panel.style.top) || 0;
        const move = (ev) => {
            applyPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY));
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
            const x = Math.min(Math.max(ox + (ev.clientX - startX), -(panel.offsetWidth - 60)), vw - 60);
            const y = Math.min(Math.max(oy + (ev.clientY - startY), 0), vh - 36);
            applyPos(x, y);
            saveUi({ x, y });
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function applyPos(x, y) {
    panel.style.left = x + "px";
    panel.style.top = y + "px";
}

function applySize(w, h) {
    panel.style.width = w + "px";
    panel.style.height = h + "px";
}

function setMode(m) {
    if (!MODES.some((x) => x[0] === m)) m = "wipe";
    mode = m;
    if (modeSel) modeSel.value = m;
    saveUi({ mode: m });
    applyModeStyles();
    if (m === "diff") computeDiff();
}

function applyModeStyles() {
    if (!panel) return;
    panel.dataset.mode = mode;
    const hasB = !!slots.B.src;
    const hasA = !!slots.A.src;
    // layering
    imgA.src = slots.A.src || "";
    imgB.src = hasB ? slots.B.src : "";
    slotAEl.style.display = hasA ? "" : "none";
    slotBEl.style.display = hasB ? "" : "none";
    canvasEl.style.display = mode === "diff" ? "" : "none";
    dividerEl.style.display = (mode === "wipe" && hasA && hasB) ? "" : "none";
    gainWrap.style.display = mode === "diff" ? "" : "none";
    fadeWrap.style.display = mode === "fade" ? "" : "none";
    stageEl.classList.toggle("hub-cmp-blinkable", mode === "blink" && hasA && hasB);
    // per-mode layer styles
    if (mode === "wipe") {
        slotBEl.style.clipPath = `inset(0 0 0 ${split}%)`;
        slotBEl.style.opacity = "1";
        dividerEl.style.left = split + "%";
        toolsHint.textContent = "Drag the divider (or click the stage) to move the wipe";
    } else {
        slotBEl.style.clipPath = "";
    }
    if (mode === "fade") {
        slotBEl.style.opacity = String(fade / 100);
        toolsHint.textContent = "Fade slider blends B over A";
    } else if (mode !== "diff") {
        slotBEl.style.opacity = "";
    }
    if (mode === "blink") {
        slotBEl.style.opacity = blinkOn ? "0" : "1";
        toolsHint.textContent = "Click the stage to blink A↔B";
    }
    if (mode === "diff") {
        toolsHint.textContent = "Pixel difference × gain";
    }
}

function renderSlots() {
    if (!panel) return;
    labelA.textContent = slots.A.label || (slots.A.src ? "(image)" : "-");
    labelB.textContent = slots.B.label || (slots.B.src ? "(image)" : "-");
    panel.querySelector('[data-slot="A"]').classList.toggle("hub-cmp-slot-on", !!slots.A.src);
    panel.querySelector('[data-slot="B"]').classList.toggle("hub-cmp-slot-on", !!slots.B.src);
    panel.classList.toggle("hub-cmp-ready", !!(slots.A.src && slots.B.src));
    panel.querySelector(".hub-cmp-empty").style.display =
        (slots.A.src || slots.B.src) ? "none" : "";
    applyModeStyles();
}

// ---------------------------------------------------------------------------
// Diff mode
// ---------------------------------------------------------------------------

function computeDiff() {
    try {
        if (!canvasEl || !slots.A.src || !slots.B.src) return;
        const ctx = canvasEl.getContext?.("2d");
        if (!ctx) { toolsHint.textContent = "Canvas unavailable in this browser - diff is disabled"; return; }
        const load = (src) => new Promise((res) => {
            const im = new Image();
            im.onload = () => res(im);
            im.onerror = () => res(null);
            im.src = src;
        });
        Promise.all([load(slots.A.src), load(slots.B.src)]).then(([ia, ib]) => {
            if (!ia || !ib || !panel) return;
            const w = Math.max(1, Math.min(ia.naturalWidth || ia.width || 1, 1024));
            const h = Math.max(1, Math.round(w * ((ia.naturalHeight || ia.height || 1) / (ia.naturalWidth || ia.width || 1))));
            canvasEl.width = w;
            canvasEl.height = h;
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(ia, 0, 0, w, h);
            const dA = ctx.getImageData(0, 0, w, h);
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(ib, 0, 0, w, h);
            const dB = ctx.getImageData(0, 0, w, h);
            const out = ctx.createImageData(w, h);
            const a = dA.data, b = dB.data, o = out.data;
            for (let i = 0; i < a.length; i += 4) {
                o[i] = Math.min(255, Math.abs(a[i] - b[i]) * gain);
                o[i + 1] = Math.min(255, Math.abs(a[i + 1] - b[i + 1]) * gain);
                o[i + 2] = Math.min(255, Math.abs(a[i + 2] - b[i + 2]) * gain);
                o[i + 3] = 255;
            }
            ctx.putImageData(out, 0, 0);
        }).catch(() => {});
    } catch (_) {
        try { toolsHint.textContent = "Diff unavailable (canvas error)"; } catch (_) {}
    }
}

// ---------------------------------------------------------------------------
// Auto-refresh on every queue run
// ---------------------------------------------------------------------------

function refreshSlotsFromSources() {
    let changed = false;
    for (const k of ["A", "B"]) {
        const s = slots[k];
        if (!s.srcEl) continue;
        try {
            if (!s.srcEl.isConnected) continue;
            const now = mediaSrcFromHost(s.srcEl);
            if (now && now !== s.src) {
                s.src = now;
                changed = true;
            }
        } catch (_) {}
    }
    if (changed) {
        renderSlots();
        if (mode === "diff") computeDiff();
    }
}

function installApiHook() {
    try {
        const api = globalThis.__HUB_APP_STUB__?.api || window.app?.api;
        if (!api || typeof api.addEventListener !== "function" || apiHook) return;
        apiHook = () => refreshSlotsFromSources();
        api.addEventListener("executed", apiHook);
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Context menu ("Add to Compare")
// ---------------------------------------------------------------------------

let cmpMenuEl = null;
let cmpMenuDismiss = null;

function closeCmpMenu() {
    cmpMenuEl?.remove();
    cmpMenuEl = null;
    if (cmpMenuDismiss) {
        document.removeEventListener("pointerdown", cmpMenuDismiss.pointer, true);
        document.removeEventListener("keydown", cmpMenuDismiss.key, true);
        window.removeEventListener("blur", cmpMenuDismiss.blur);
        cmpMenuDismiss = null;
    }
}

function openCmpMenu(x, y, src, label, srcEl) {
    closeCmpMenu();
    const menu = document.createElement("div");
    menu.className = "hub-menu hub-cmp-menu";
    const title = document.createElement("div");
    title.className = "hub-menu-title";
    title.textContent = "⇆ Add to Compare";
    menu.appendChild(title);
    const mk = (text, slot) => {
        const item = document.createElement("div");
        item.className = "hub-menu-item";
        item.textContent = text;
        item.addEventListener("click", () => {
            closeCmpMenu();
            addToCompare(src, label, srcEl, slot);
        });
        return item;
    };
    menu.appendChild(mk("Add to Compare (auto: A, then B)", null));
    menu.appendChild(mk("→ slot A", "A"));
    menu.appendChild(mk("→ slot B", "B"));
    const cancel = document.createElement("div");
    cancel.className = "hub-menu-item hub-menu-cancel";
    cancel.textContent = "✖ Cancel";
    cancel.addEventListener("click", closeCmpMenu);
    menu.appendChild(cancel);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    cmpMenuEl = menu;
    cmpMenuDismiss = {
        pointer: (e) => { if (!menu.contains(e.target)) closeCmpMenu(); },
        key: (e) => { if (e.key === "Escape") closeCmpMenu(); },
        blur: () => closeCmpMenu(),
    };
    document.addEventListener("pointerdown", cmpMenuDismiss.pointer, true);
    document.addEventListener("keydown", cmpMenuDismiss.key, true);
    window.addEventListener("blur", cmpMenuDismiss.blur);
}

function onContext(e) {
    // Shift+RMB stays the native-menu escape hatch (project convention).
    if (e.shiftKey || e.defaultPrevented) return;
    const t = e.target;
    if (!t || typeof t.closest !== "function") return;
    if (t.closest(".hub-cmp-panel, .hub-menu")) return;
    const host = t.closest('[data-role="media-prev"], .hub-gal-thumb, .hub-stack-card[data-type="image"]');
    if (!host) return;
    const src = mediaSrcFromHost(host);
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    openCmpMenu(e.clientX, e.clientY, src, labelFromHost(host), host);
}

// ---------------------------------------------------------------------------
// Public init + test hooks
// ---------------------------------------------------------------------------

export function initCompare() {
    if (wired) return;
    wired = true;
    document.addEventListener("contextmenu", onContext, true);
    installApiHook();
}

export function __compareTestHooks() {
    return {
        addToCompare,
        clearSlot,
        swapSlots,
        setMode,
        refreshSlotsFromSources,
        computeDiff,
        onContext,
        panelEl: () => panel,
        slots: () => ({ A: { ...slots.A, srcEl: !!slots.A.srcEl }, B: { ...slots.B, srcEl: !!slots.B.srcEl } }),
        state: () => ({ mode, gain, fade, split, blinkOn }),
    };
}
