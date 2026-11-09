// ============================================================================
// SettingsHub - MINI PANEL / LAUNCHER (v91)
// ----------------------------------------------------------------------------
// Owner request v91 #1: "a mini panel where toggles switch the chat and the
// stack on/off, or create a new virtual hub. Collapsing now goes INTO this
// (movable) panel - the chat and the stack collapse into it. And the ComfyUI
// settings only show the panel itself and which elements appear on it."
//
// So the launcher is:
//   * a small always-there floating BAR (drag by its handle, geometry in
//     localStorage settingshub.launcher.ui) with:
//       [chat button + on/off toggle] [stack button + on/off toggle]
//       [+ hub] [⚙];
//   * the collapse TARGET of both utility panels: [–] on the chat / stack
//     no longer leaves a free chip floating around - when the launcher is on
//     and the panel's item is visible, the panel collapses INTO the launcher
//     (its button gets the amber "collapsed" state; a click restores it).
//     A hidden launcher or a hidden item falls back to the old own-chip
//     behavior, so nothing can ever become unreachable;
//   * the ONLY SettingsHub rows in ComfyUI's own Settings dialog (the
//     SettingsHub group): "Mini panel (SettingsHub)" + the three item
//     switches (Chat / Stack / New-hub). The v88 per-panel rows
//     (SettingsHub.Chat.enabled / SettingsHub.PasteStack.enabled) are GONE -
//     the way back to a hidden chat/stack is the launcher itself, and the
//     way back to a hidden launcher is the ComfyUI setting above.
//
// The state mirrors run off a cheap 800ms re-render + immediate refreshes on
// every local action; the on/off toggles stay the SAME truth the panels use
// (settingshub.chat.on / settingshub.stack.on), so the launcher, the panel
// ⚙ popups and the collapsed states can never disagree for long.
// ============================================================================

import { app } from "../../scripts/app.js";
import { createVirtualHub } from "./core.js";
// v91 DELIBERATE: no static imports from chat.js / stack.js here. The panels
// REGISTER their state hooks below (registerLauncherPanel), so the launcher
// stays a leaf module - a broken chat.js can never take the stack (or this
// bar) down with it, and the import graph stays cycle-free.

// v91 self-report (single-source version, docs/plan-versions.md)
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["launcher"] = "v91";

const LS_ON = "settingshub.launcher.on";        // "1"/"0" - panel shown
const LS_ITEM = "settingshub.launcher.item.";   // + kind -> "1"/"0"
const LS_UI = "settingshub.launcher.ui";        // {x,y}
const Z_PANEL = "99902";                        // above chat (99901) / stack (99900)
const ITEM_KINDS = ["chat", "stack", "hub"];
const ITEM_LABEL = { chat: "💬 Chat", stack: "📋 Stack", hub: "＋ Hub" };
const ITEM_TITLE = {
    chat: "Chat - click: minimize into this panel / restore; the checkbox switches it on/off",
    stack: "Paste Stack - click: minimize into this panel / restore; the checkbox switches it on/off",
    hub: "Create a new VIRTUAL hub (a floating control window without a canvas node)",
};

let panelEl = null;
let mounted = false;
let initSeq = 0;
let collapsed = { chat: false, stack: false };   // the panels collapsed INTO this bar
const panelHooks = {};                           // kind -> {isOn,isMin,minimize,restore,showChip}
let popEl = null;                                // the ⚙ popup
let renderT = null;
let nativeRegistered = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function localToast(msg, ms = 3200) {
    try {
        const t = document.createElement("div");
        t.textContent = msg;
        t.className = "hub-sh-note";
        Object.assign(t.style, {
            position: "fixed", left: "14px", bottom: "86px", zIndex: "999990",
            maxWidth: "460px", padding: "8px 12px", borderRadius: "8px",
            background: "rgba(24,28,38,0.95)", color: "#dfe6f5",
            border: "1px solid #3d5a80", font: "12px/1.45 system-ui, sans-serif",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)", userSelect: "none",
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms);
    } catch (_) {}
}

function lsFlag(key, def) {
    try {
        const v = localStorage.getItem(key);
        if (v == null || v === "") return def;
        return v === "1";
    } catch (_) { return def; }
}

function writeFlag(key, v) {
    try { localStorage.setItem(key, v ? "1" : "0"); } catch (_) {}
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

// ---------------------------------------------------------------------------
// State API (chat.js / stack.js / the ComfyUI settings consume these)
// ---------------------------------------------------------------------------

export function isLauncherOn() {
    return lsFlag(LS_ON, true);
}

export function setLauncherOn(v, src) {
    const was = isLauncherOn();
    writeFlag(LS_ON, !!v);
    if (was && !v) {
        // a collapsed panel must not become unreachable: fall back to the
        // panels' own chips before the bar goes away
        unhostAll("The mini panel is hidden");
    }
    if (v) initLauncher();
    else teardown();
    if (src !== "native") syncNative();
}

export function isLauncherItemOn(kind) {
    return lsFlag(LS_ITEM + kind, true);
}

export function setLauncherItemOn(kind, v) {
    if (!ITEM_KINDS.includes(kind)) return;
    writeFlag(LS_ITEM + kind, !!v);
    if (!v && collapsed[kind]) {
        // the item disappears while its panel is collapsed into us - hand
        // the panel back its own chip
        try { panelHooks[kind]?.showChip?.(); } catch (_) {}
        collapsed[kind] = false;
    }
    renderItems();
    syncNative();
}

/** True when the launcher should HOST the panel's minimized state ([–] on
 *  the chat/stack collapses INTO this bar instead of a free chip). */
export function launcherHostsMinimized(kind) {
    return !!(mounted && panelEl && isLauncherOn() &&
        isLauncherItemOn(kind) && panelHooks[kind]);
}

/** chat.js / stack.js report their collapse state through here. */
export function launcherSetCollapsed(kind, on) {
    if (!(kind in collapsed)) return;
    collapsed[kind] = !!on;
    renderItems();
}

/** chat.js / stack.js register their state + restore/minimize/chip actions.
 *  hooks: {isOn, setOn, isMin, minimize, restore, showChip}. */
export function registerLauncherPanel(kind, hooks) {
    if (!ITEM_KINDS.includes(kind) || !hooks) return;
    panelHooks[kind] = hooks;
    renderItems();
}

function unhostAll(why) {
    for (const kind of ["chat", "stack"]) {
        if (collapsed[kind]) {
            try { panelHooks[kind]?.showChip?.(); } catch (_) {}
            collapsed[kind] = false;
        }
    }
    if (why) localToast(why + " - minimized panels are back to their own chips.");
}

// ---------------------------------------------------------------------------
// ComfyUI Settings - THE SettingsHub rows (the launcher replaces the old
// per-panel Chat/Stack switches)
// ---------------------------------------------------------------------------

function syncNative() {
    // converge ComfyUI's stored values with OUR truth (cheap no-op when the
    // dialog is closed; the onChange guards make a round-trip a no-op)
    if (!nativeRegistered) return;
    try { __launcherNative?.enabled?.set?.(isLauncherOn()); } catch (_) {}
    try { __launcherNative?.chat?.set?.(isLauncherItemOn("chat")); } catch (_) {}
    try { __launcherNative?.stack?.set?.(isLauncherItemOn("stack")); } catch (_) {}
    try { __launcherNative?.hub?.set?.(isLauncherItemOn("hub")); } catch (_) {}
}

let __launcherNative = null;

function registerLauncherSettings() {
    if (nativeRegistered) return;
    try {
        const s = app?.ui?.settings;
        if (!s || typeof s.addSetting !== "function") return;
        nativeRegistered = true;
        const mk = (id, name, get, set) => s.addSetting({
            id, name, type: "boolean", defaultValue: get(),
            onChange: (value) => { if (!!value !== get()) set(!!value, "native"); },
        });
        __launcherNative = {
            enabled: mk("SettingsHub.Launcher.enabled",
                "Mini panel (SettingsHub) - show it",
                isLauncherOn, setLauncherOn),
            chat: mk("SettingsHub.Launcher.itemChat",
                "Mini panel: Chat item",
                () => isLauncherItemOn("chat"), setLauncherItemOn),
            stack: mk("SettingsHub.Launcher.itemStack",
                "Mini panel: Stack item",
                () => isLauncherItemOn("stack"), setLauncherItemOn),
            hub: mk("SettingsHub.Launcher.itemHub",
                "Mini panel: New-hub button",
                () => isLauncherItemOn("hub"), setLauncherItemOn),
        };
    } catch (e) {
        console.warn("[SettingsHub] launcher settings unavailable:", e);
    }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function makeDraggable(handle) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !panelEl) return;
        if (e.target?.closest?.("button, input, select, label")) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const ox = parseFloat(panelEl.style.left) || 0;
        const oy = parseFloat(panelEl.style.top) || 0;
        const clamp = (x, y) => {
            const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
            const w = panelEl.offsetWidth || 120, h = panelEl.offsetHeight || 40;
            return {
                x: Math.min(Math.max(x, -w + 48), vw - 48),
                y: Math.min(Math.max(y, 0), vh - 48),
            };
        };
        const move = (ev) => {
            const p = clamp(ox + (ev.clientX - startX), oy + (ev.clientY - startY));
            panelEl.style.left = p.x + "px";
            panelEl.style.top = p.y + "px";
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            const p = clamp(ox + (ev.clientX - startX), oy + (ev.clientY - startY));
            panelEl.style.left = p.x + "px";
            panelEl.style.top = p.y + "px";
            saveUi({ x: p.x, y: p.y });
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function itemState(kind) {
    // the panel hooks carry the live state (registered by chat.js/stack.js);
    // an unregistered panel counts as off-ish - its toggle simply has noone
    // to command yet
    const h = panelHooks[kind];
    if (kind === "hub") return "on";
    if (!h || !h.isOn()) return "off";
    return collapsed[kind] ? "min" : "on";
}

function renderItems() {
    if (!panelEl) return;
    for (const kind of ["chat", "stack"]) {
        const btn = panelEl.querySelector(`[data-lnch="${kind}"]`);
        const cb = panelEl.querySelector(`[data-lnch-cb="${kind}"]`);
        if (!btn || !cb) continue;
        const st = itemState(kind);
        const on = isLauncherItemOn(kind);
        btn.classList.toggle("hub-lnch-on", st === "on" && on);
        btn.classList.toggle("hub-lnch-min", st === "min" && on);
        btn.classList.toggle("hub-lnch-off", st === "off" || !on);
        btn.disabled = !on;
        cb.checked = st !== "off" && on;
        cb.disabled = !on;
        const bit = st === "min" ? " ▪" : "";
        btn.title = ITEM_TITLE[kind] + (st === "min" ? " (collapsed HERE - click to restore)" : "");
        const lbl = btn.querySelector(".hub-lnch-lbl");
        if (lbl) lbl.textContent = ITEM_LABEL[kind] + bit;
    }
    const hubBtn = panelEl.querySelector('[data-lnch="hub"]');
    if (hubBtn) hubBtn.classList.toggle("hub-lnch-on", isLauncherItemOn("hub"));
}

function onItemBtn(kind) {
    if (!isLauncherItemOn(kind)) return;
    if (kind === "hub") {
        try {
            const node = createVirtualHub();
            if (node) localToast("👻 Virtual hub created - the floating window opens when its UI mounts.");
        } catch (e) {
            console.warn("[SettingsHub] launcher hub creation failed:", e);
            localToast("Could not create the virtual hub - see F12");
        }
        return;
    }
    const h = panelHooks[kind];
    if (!h) { localToast("The " + (kind === "chat" ? "chat" : "stack") + " module is not loaded yet"); return; }
    if (itemState(kind) === "off") {
        h.setOn(true);   // off -> turn the panel on (the checkbox mirrors it)
        renderItems();
        return;
    }
    if (collapsed[kind]) h.restore?.();
    else h.minimize?.();
    renderItems();
}

function onItemToggle(kind, v) {
    if (!isLauncherItemOn(kind)) return;
    panelHooks[kind]?.setOn?.(!!v);
    renderItems();
}

// --- the ⚙ popup (the same rows the ComfyUI settings carry) ----------------

function closePop() {
    try { popEl?.remove(); } catch (_) {}
    popEl = null;
    try { window.removeEventListener("mousedown", onPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onPopKey, true); } catch (_) {}
}
function onPopDown(e) {
    if (!popEl || popEl.contains(e.target)) return;
    closePop();
}
function onPopKey(e) {
    if (e.key === "Escape" && popEl) { e.preventDefault(); closePop(); }
}

function openPop() {
    if (popEl) { closePop(); return; }
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-lnch-pop";
    const row = (kind, label, title) =>
        `<label class="hub-cs-row" title="${title}"><span>${label}</span>` +
        `<select class="hub-cs-sel" data-lnch-set="${kind}">` +
        `<option value="1">On</option><option value="0">Off</option>` +
        `</select></label>`;
    pop.innerHTML =
        `<div class="hub-menu-title">⚙ Mini panel</div>` +
        row("__on", "Panel shown", "The mini panel itself. Off falls minimized chat/stack back to their own chips.") +
        row("chat", "Chat item", "The chat button + toggle on the mini panel.") +
        row("stack", "Stack item", "The stack button + toggle on the mini panel.") +
        row("hub", "New-hub button", "The ＋ Hub button on the mini panel (creates a virtual hub).") +
        `<div class="hub-cs-info">[–] on the chat / the stack collapses them INTO this panel ` +
        `(an amber ▪ marks it); a click restores. This panel is also configured in ` +
        `ComfyUI Settings → SettingsHub → "Mini panel (SettingsHub)" - reachable in every workflow.</div>`;
    document.body.appendChild(pop);
    const r = panelEl?.getBoundingClientRect?.();
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    let x = 12, y = 12;
    if (r) {
        x = Math.max(8, Math.min(r.left, vw - (pop.offsetWidth || 260) - 8));
        y = r.bottom + 6;
        if (y + (pop.offsetHeight || 220) > vh - 8) y = Math.max(8, r.top - (pop.offsetHeight || 220) - 6);
    }
    pop.style.left = x + "px";
    pop.style.top = y + "px";
    popEl = pop;
    const vals = { __on: isLauncherOn(), chat: isLauncherItemOn("chat"), stack: isLauncherItemOn("stack"), hub: isLauncherItemOn("hub") };
    for (const sel of pop.querySelectorAll("[data-lnch-set]")) {
        sel.value = vals[sel.dataset.lnchSet] ? "1" : "0";
        sel.addEventListener("change", () => {
            const v = sel.value === "1";
            const k = sel.dataset.lnchSet;
            if (k === "__on") setLauncherOn(v);
            else setLauncherItemOn(k, v);
            if (popEl) sel.value = (k === "__on" ? isLauncherOn() : isLauncherItemOn(k)) ? "1" : "0";
        });
    }
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    window.addEventListener("mousedown", onPopDown, true);
    window.addEventListener("keydown", onPopKey, true);
}

// ---------------------------------------------------------------------------
// init / teardown
// ---------------------------------------------------------------------------

export function initLauncher() {
    if (!isLauncherOn()) return;
    registerLauncherSettings();
    teardown();
    const seq = ++initSeq;
    panelEl = document.createElement("div");
    panelEl.className = "hub-lnch";
    panelEl.style.zIndex = Z_PANEL;
    panelEl.innerHTML =
        `<span class="hub-lnch-drag" title="Drag to move">⣿</span>` +
        `<button type="button" class="hub-lnch-btn" data-lnch="chat">` +
        `<span class="hub-lnch-lbl">💬 Chat</span></button>` +
        `<label class="hub-lnch-tg" title="Chat panel on/off"><input type="checkbox" data-lnch-cb="chat"></label>` +
        `<button type="button" class="hub-lnch-btn" data-lnch="stack">` +
        `<span class="hub-lnch-lbl">📋 Stack</span></button>` +
        `<label class="hub-lnch-tg" title="Stack panel on/off"><input type="checkbox" data-lnch-cb="stack"></label>` +
        `<button type="button" class="hub-lnch-btn hub-lnch-hub" data-lnch="hub">` +
        `<span class="hub-lnch-lbl">＋ Hub</span></button>` +
        `<button type="button" class="hub-lnch-gear" title="Mini panel settings (also in ComfyUI Settings → SettingsHub)">⚙</button>`;
    document.body.appendChild(panelEl);
    const ui = lsUi();
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    const x = Math.min(Math.max(typeof ui.x === "number" ? ui.x : 12, -200), Math.max(8, vw - 80));
    const y = Math.min(Math.max(typeof ui.y === "number" ? ui.y : 8, 0), Math.max(8, vh - 60));
    panelEl.style.left = x + "px";
    panelEl.style.top = y + "px";
    makeDraggable(panelEl.querySelector(".hub-lnch-drag"));
    for (const kind of ["chat", "stack", "hub"]) {
        panelEl.querySelector(`[data-lnch="${kind}"]`)?.addEventListener("click", () => onItemBtn(kind));
        panelEl.querySelector(`[data-lnch-cb="${kind}"]`)?.addEventListener("change", (e) => onItemToggle(kind, e.target?.checked));
    }
    panelEl.querySelector(".hub-lnch-gear").addEventListener("click", openPop);
    mounted = true;
    renderItems();
    // a cheap mirror: the panels can change state from their own popups
    clearTimeout(renderT);
    renderT = setInterval(() => { if (initSeq === seq) renderItems(); }, 800);
    // v91: a shrinking window must never park the bar outside the viewport
    window.addEventListener("resize", onWinResize);
}

function onWinResize() {
    if (!panelEl) return;
    try {
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        const w = panelEl.offsetWidth || 120, h = panelEl.offsetHeight || 40;
        let x = parseFloat(panelEl.style.left) || 0;
        let y = parseFloat(panelEl.style.top) || 0;
        const nx = Math.min(Math.max(x, -w + 48), Math.max(8, vw - 48));
        const ny = Math.min(Math.max(y, 0), Math.max(8, vh - 48));
        if (nx !== x || ny !== y) {
            panelEl.style.left = nx + "px";
            panelEl.style.top = ny + "px";
            saveUi({ x: nx, y: ny });
        }
    } catch (_) {}
}

function teardown() {
    initSeq++;
    clearInterval(renderT);
    renderT = null;
    closePop();
    try { window.removeEventListener("resize", onWinResize); } catch (_) {}
    try { panelEl?.remove(); } catch (_) {}
    panelEl = null;
    mounted = false;
}
