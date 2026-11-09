// ============================================================================
// SettingsHub - MINI PANEL / LAUNCHER (v92)
// ----------------------------------------------------------------------------
// v92 (owner: "ты сделал странную панельку не так как я хотел ... панель типа
// панели задач в windows все!"): the launcher is a TASKBAR now - a thin
// movable strip of ICON buttons [💬][📋][＋], nothing else:
//   * the confusing per-item CHECKBOXES are gone (they only ever disabled the
//     button next to them - the owner called it nonsense). An item switch
//     lives ONLY in ComfyUI Settings → SettingsHub → "Mini panel" rows;
//   * no ⚙ gear on the bar either - the bar configures nothing about itself;
//   * the STATES speak through the button look: bright = the panel is on
//     screen, AMBER = the panel is collapsed INTO the bar (click restores),
//     dimmed = the panel is off (click turns it on) - the exact Windows
//     taskbar metaphor;
//   * BADGES carry the extra info the owner asked for ("минипанель пусть
//     отображает доп инфу"): the stack button shows the ENTRY COUNT, the
//     chat button pulses a dot while a generation is running. Panels report
//     through the registerLauncherPanel hook's new badge() field;
//   * the collapse-hosting contract of v91 is untouched: [–] on the chat /
//     the stack collapses them INTO this bar (the amber state), a hidden
//     launcher or a hidden item falls back to the panels' own chips.
//
// v91 history: "a mini panel where toggles switch the chat and the stack
// on/off, or create a new virtual hub. Collapsing now goes INTO this
// (movable) panel - the chat and the stack collapse into it." The ONLY
// SettingsHub rows in ComfyUI's own Settings dialog stay the four launcher
// ones (the bar + Chat / Stack / New-hub items).
// ============================================================================

import { app } from "../../scripts/app.js";
import { createVirtualHub } from "./core.js";
// v91 DELIBERATE: no static imports from chat.js / stack.js here. The panels
// REGISTER their state hooks below (registerLauncherPanel), so the launcher
// stays a leaf module - a broken chat.js can never take the stack (or this
// bar) down with it, and the import graph stays cycle-free.

// v92 self-report (single-source version, docs/plan-versions.md)
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["launcher"] = "v92";

const LS_ON = "settingshub.launcher.on";        // "1"/"0" - panel shown
const LS_ITEM = "settingshub.launcher.item.";   // + kind -> "1"/"0"
const LS_UI = "settingshub.launcher.ui";        // {x,y}
const Z_PANEL = "99902";                        // above chat (99901) / stack (99900)
const ITEM_KINDS = ["chat", "stack", "hub"];
// v92: the taskbar is ICON-ONLY (the owner's Windows-taskbar request) - the
// labels live in the tooltips now.
const ITEM_ICON = { chat: "💬", stack: "📋", hub: "＋" };
const ITEM_TITLE = {
    chat: "Chat - click: minimize into this bar / restore; dimmed = the chat panel is off (click turns it on)",
    stack: "Paste Stack - click: minimize into this bar / restore; dimmed = the stack panel is off (click turns it on)",
    hub: "Create a new VIRTUAL hub (a floating control window without a canvas node)",
};

let panelEl = null;
let mounted = false;
let initSeq = 0;
let collapsed = { chat: false, stack: false };   // the panels collapsed INTO this bar
const panelHooks = {};                           // kind -> {isOn,isMin,minimize,restore,showChip,badge}
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
 *  hooks: {isOn, setOn, isMin, minimize, restore, showChip, badge} - badge()
 *  (v92) is optional and returns null or {text} / {dot:true} for the corner
 *  badge of the taskbar button. */
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
// ComfyUI Settings - THE SettingsHub rows (the taskbar itself carries no
// configuration since v92 - the item switches live here)
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
// DOM - the v92 taskbar
// ---------------------------------------------------------------------------

function makeDraggable() {
    // the whole bar is the drag handle; the buttons stay clickable
    panelEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !panelEl) return;
        if (e.target?.closest?.("button")) return;
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
    // an unregistered panel counts as off-ish - its button simply has noone
    // to command yet
    const h = panelHooks[kind];
    if (kind === "hub") return "on";
    if (!h || !h.isOn()) return "off";
    return collapsed[kind] ? "min" : "on";
}

/** v92: the corner badge of a taskbar button - {text} or {dot:true} or null.
 *  A hidden item never shows a badge; a huge count caps at "99+". */
function badgeOf(kind) {
    if (!isLauncherItemOn(kind)) return null;
    let b = null;
    try { b = panelHooks[kind]?.badge?.() || null; } catch (_) { b = null; }
    if (!b) return null;
    if (b.dot) return { dot: true };
    const n = parseInt(b.text, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { text: n > 99 ? "99+" : String(n) };
}

function renderItems() {
    if (!panelEl) return;
    for (const kind of ["chat", "stack", "hub"]) {
        const btn = panelEl.querySelector(`[data-lnch="${kind}"]`);
        if (!btn) continue;
        const on = isLauncherItemOn(kind);
        // a hidden item is GONE from the bar (a taskbar shows what exists)
        btn.style.display = on ? "" : "none";
        const st = itemState(kind);
        btn.classList.toggle("hub-lnch-on", on && st === "on");
        btn.classList.toggle("hub-lnch-min", on && st === "min");
        btn.classList.toggle("hub-lnch-off", on && st === "off");
        if (kind !== "hub") {
            btn.title = ITEM_TITLE[kind] +
                (st === "min" ? " (collapsed HERE - click to restore)" : "");
        }
        // v92: the corner badge (stack = the entry count, chat = a live dot)
        const bEl = btn.querySelector(".hub-lnch-badge");
        if (bEl) {
            const b = badgeOf(kind);
            bEl.textContent = b?.text || "";
            bEl.classList.toggle("hub-lnch-dot", !!b?.dot);
            bEl.style.display = b ? "" : "none";
        }
    }
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
        h.setOn(true);   // dimmed button -> turn the panel on (one click, no checkbox)
        renderItems();
        return;
    }
    if (collapsed[kind]) h.restore?.();
    else h.minimize?.();
    renderItems();
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
    // v92: the Windows-taskbar strip - three icon buttons, nothing else
    panelEl.innerHTML =
        ITEM_KINDS.map((kind) =>
            `<button type="button" class="hub-lnch-btn${kind === "hub" ? " hub-lnch-hub" : ""}" data-lnch="${kind}" ` +
            `title="${ITEM_TITLE[kind]}">` +
            `<span class="hub-lnch-ico">${ITEM_ICON[kind]}</span>` +
            (kind === "hub" ? "" : `<span class="hub-lnch-badge" style="display:none"></span>`) +
            `</button>`).join("");
    document.body.appendChild(panelEl);
    const ui = lsUi();
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    const x = Math.min(Math.max(typeof ui.x === "number" ? ui.x : 12, -200), Math.max(8, vw - 80));
    const y = Math.min(Math.max(typeof ui.y === "number" ? ui.y : 8, 0), Math.max(8, vh - 60));
    panelEl.style.left = x + "px";
    panelEl.style.top = y + "px";
    makeDraggable();
    for (const kind of ITEM_KINDS) {
        panelEl.querySelector(`[data-lnch="${kind}"]`)?.addEventListener("click", () => onItemBtn(kind));
    }
    mounted = true;
    renderItems();
    // a cheap mirror: the panels can change state from their own popups, and
    // the badges (stream dot, entry count) follow without any event wiring
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
    try { window.removeEventListener("resize", onWinResize); } catch (_) {}
    try { panelEl?.remove(); } catch (_) {}
    panelEl = null;
    mounted = false;
}

// ---------------------------------------------------------------------------
// v92 test hooks (the smoke suite drives the taskbar contract through these)
// ---------------------------------------------------------------------------

export function __launcherTestHooks() {
    return {
        el: () => panelEl,
        mounted: () => mounted,
        itemState,
        badgeOf,
        renderItems: () => renderItems(),
        click: (kind) => onItemBtn(kind),
        hooks: () => panelHooks,
    };
}
