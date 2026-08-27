// ============================================================================
// SettingsHub - DOM UI renderer
// ----------------------------------------------------------------------------
// The whole hub interface lives inside a single LiteGraph DOM widget
// (node.addDOMWidget), so the CSS in styles.css actually applies:
//
//   .hub-tab-bar    -> visual tabs: click switch / dblclick rename / [+]
//                      / hover [x] delete / drop-item-to-move-tab
//   .hub-container  -> one .hub-item-row per pinned widget:
//                      [handle] [label] [mirror] [locate] [remove]
//   .hub-preset-row -> preset select + Save / New / Delete / Add Divider
//
// Mirror widgets are real <select>/<input type=...>/controls bound to the
// source widgets through SyncManager.writeTargetValue(), which holds the
// shared sync lock so no feedback loop can occur.
// ============================================================================

import { app } from "../../scripts/app.js";
import {
    getHubConfig, getActiveTabId, sortedTabs, itemsOfTab, genId,
    liveComboValues, numericMerge, coerceNumeric, removeItem, detectWidgetType,
    isMultilineWidget, portalKindOf, resolveBindingTarget, findHolderChainOf,
    synthSliderWindow,
} from "./core.js";
import { presetSave, presetNew, presetDelete, presetApply } from "./preset_manager.js";
import { writeTargetValue, ensureHooksForItem } from "./sync_manager.js";
import { beginEdit, endEdit, registerStructural, registerValues } from "./sync.js";
import { initDrag } from "./dnd_manager.js";
import * as Portals from "./portal_manager.js";

// Layout allowances. The title bar height is taken from LiteGraph when
// available (themes vary); SLOT_TOP_GAP is the canvas-side offset above the
// first widget slot. Both plus CHROME_H are deliberately generous: a few
// spare pixels at the bottom are invisible, while a couple of missing ones
// clip the preset row (reported bug).
function titleBarHeight() {
    const h = window.LiteGraph?.NODE_TITLE_HEIGHT;
    return typeof h === "number" && h > 0 ? h : 30;
}
const SLOT_TOP_GAP = 8;
const CHROME_H = 12;
// ComfyUI's DOM-widget draw insets the element by ~10px on top and bottom
// inside the widget slot; element height ends up slotHeight - 20.
const DOM_SLOT_MARGIN = 20;

const stateMap = new WeakMap();

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Target lookup is CROSS-GRAPH: pinned widgets may live inside any subgraph
 *  while the hub sits on the root canvas (see core.resolveBindingTarget). */
function findTarget(item) {
    const tn = resolveBindingTarget(item);
    const tw = tn?.widgets?.find((w) => w.name === item.widgetToBind);
    return { tn, tw };
}

// ---------------------------------------------------------------------------
// Per-node DOM construction (created once)
// ---------------------------------------------------------------------------

function ensureHubDom(node) {
    let st = stateMap.get(node);
    if (st && st.widget && node.widgets?.includes(st.widget)) return st;

    const root = document.createElement("div");
    root.className = "settings-hub";
    const wrap = document.createElement("div");
    wrap.className = "settings-hub-wrap";
    wrap.style.width = "100%";
    wrap.appendChild(root);

    let widget = null;
    try {
        widget = node.addDOMWidget("__hub_ui", "custom", wrap, {});
        if (widget) {
            widget.serializable = false;
            if (widget.options) widget.options.serialize = false;
            // Slot height is driven by measured content (auto mode) or by the
            // user-sized node (fill mode); applyHubLayout swaps this closure.
            widget.computeSize = () => [node.size[0], (wrap._hubH ?? 60) + SLOT_TOP_GAP + CHROME_H];
        }
    } catch (err) {
        console.warn("[SettingsHub] addDOMWidget unavailable:", err);
    }

    st = { root, wrap, widget };
    stateMap.set(node, st);

    // Content-follow: ResizeObserver on the inner content wrapper catches
    // in-hub textarea resizes (resize: vertical), tab-bar wraps, font loads.
    // The wrapper's height is pure content height - the observer never fires
    // because WE resized the node, so there is no feedback loop.
    if (typeof ResizeObserver !== "undefined") {
        try {
            st.contentRO = new ResizeObserver(() => {
                if (node.flags?.collapsed) return;
                scheduleLayout(node, st);
            });
        } catch (_) { st.contentRO = null; }
    }

    initDrag(root, {
        getCfg: () => getHubConfig(node),
        getNode: () => node,
        commitItems: () => {
            node.setDirtyCanvas(true, true);
            renderHub(node); // full re-render keeps DOM consistent
        },
    });

    wireEvents(node, st);
    return st;
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

function tabBtnHtml(tab, active, count) {
    const del = active
        ? `<span class="hub-tab-del" data-action="del-tab" title="Delete tab">✕</span>`
        : "";
    // NOTE: the button itself carries data-action="switch-tab" so the delegated
    // click handler resolves it via closest("[data-action]"). The [x] span
    // shadows it because closest() stops at the nearest match.
    return `<button type="button" draggable="true" class="hub-tab-btn${active ? " hub-tab-active" : ""}" ` +
        `data-action="switch-tab" data-tab="${esc(tab.id)}" title="Click - switch · Dbl-click - rename · Drop item here - move">${esc(tab.name)}${count ? ` <span class="hub-tab-count">${count}</span>` : ""}${del}</button>`;
}

function buildTabBarHtml(cfg) {
    const tabs = sortedTabs(cfg);
    const btns = tabs.map((t) =>
        tabBtnHtml(t, t.id === getActiveTabId(cfg),
            cfg.items.filter((i) => i.tabId === t.id).length)).join("");
    return `<div class="hub-tab-bar">${btns}` +
        `<button type="button" class="hub-add-tab" data-action="add-tab" title="Add tab">+</button>` +
        `</div>`;
}

function mirrorHtml(item, tw) {
    switch (item.widgetType) {
        case "combo": {
            // Searchable combo (like the ComfyUI frontend one): a compact
            // trigger showing the current value; clicking it opens a live-
            // filtered popup (see openComboPopup below). data-sig keeps the
            // values-signature so refreshValuesDom can detect list changes.
            const vals = liveComboValues(item, tw);
            const cur = String(tw?.value ?? "");
            const sig = vals.join("¦");
            return `<span class="hub-mirror hub-mirror-combo">` +
                `<button type="button" class="hub-combo" data-role="combo" data-hub-control data-sig="${esc(sig)}" ` +
                `title="Searchable list - filter parts separated by space, all must match, case-insensitive">` +
                `<span class="hub-combo-label">${esc(cur)}</span><span class="hub-combo-caret">▾</span></button></span>`;
        }
        case "checkbox": {
            const checked = tw?.value === true || tw?.value === "true";
            return `<span class="hub-mirror"><input type="checkbox" class="hub-check" data-role="check" data-hub-control${checked ? " checked" : ""}></span>`;
        }
        case "int":
        case "slider": {
            const o = numericMerge(item, tw);
            const v = coerceNumeric(tw?.value, item, tw, o.min);
            const finMin = Number.isFinite(o.min);
            const finMax = Number.isFinite(o.max);
            // Faithful attributes on the TEXT editor: undeclared bounds stay
            // ABSENT (open-ended), never replaced by invented 0..1 walls.
            const numAttrs =
                (finMin ? ` min="${o.min}"` : "") +
                (finMax ? ` max="${o.max}"` : "") +
                ` step="${o.step}"`;
            // Slider box: declared bounds win; open sides get an ADAPTIVE
            // nudge window around the current value (data-synth-range).
            // Display-only helper for PrimitiveFloat-style widgets whose
            // bounds are effectively ±infinity: typed commits stay free,
            // coercion still clamps ONLY by declared bounds.
            let slider;
            if (finMin && finMax) {
                slider = `<input type="range" class="hub-range" data-role="range" data-hub-control ` +
                    `value="${esc(String(v))}" min="${o.min}" max="${o.max}" step="${o.step}">`;
            } else {
                const w = synthSliderWindow(v);
                slider = `<input type="range" class="hub-range hub-range-synth" data-role="range" data-hub-control ` +
                    `data-synth-range="1" value="${esc(String(v))}" min="${w.min}" max="${w.max}" step="${o.step}" ` +
                    `title="No declared source bounds - adaptive nudge around the current value; exact values via the text field">`;
            }
            // The editor is a TEXT input with inputmode=decimal, NOT
            // type=number: native number fields SANITIZE the value ("0,9"
            // becomes "", comma locales and exotic decimals die before our
            // validation ever sees them). We own clamping/quantization in
            // coerceNumeric, so the raw user text always reaches it intact.
            return `<span class="hub-mirror hub-mirror-num">` +
                `<input type="text" inputmode="decimal" class="hub-num-input" data-role="number" data-hub-control ` +
                `value="${esc(String(v))}"${numAttrs}>` + slider + `</span>`;
        }
        default: {
            const val = tw?.value ?? "";
            // Multiline mirrors: persisted flag OR live widget carrying a
            // real <textarea> element (DOM prompt widgets have no flag).
            if (item.options?.multiline || isMultilineWidget(tw)) {
                // hub-mirror-text: the textarea takes the remaining row width
                // (see styles.css); vertical resize is followed by the
                // content observer so the node re-fits.
                return `<span class="hub-mirror hub-mirror-text"><textarea class="hub-text-area" rows="3" spellcheck="false" data-role="text" data-hub-control>${esc(val)}</textarea></span>`;
            }
            return `<span class="hub-mirror"><input type="text" class="hub-text-input" data-role="text" data-hub-control value="${esc(val)}"></span>`;
        }
    }
}

function itemRowHtml(item) {
    const { tn, tw } = findTarget(item);
    const ok = !!(tn && tw);
    const label = item.customLabel || tw?.label || tw?.name || item.widgetToBind || "widget";

    const handle = `<span class="hub-drag-handle" draggable="true" title="Drag to reorder (drop on a tab to move)">⠿</span>`;
    const labelEl = ok
        ? `<span class="hub-item-label" data-action="rename-item" title="Dbl-click to rename">${esc(label)}</span>`
        : `<span class="hub-item-label hub-orphan" title="⚠️ Target node missing">⚠️ ${esc(label)}</span>`;
    const tools = [
        `<button type="button" class="hub-btn hub-locate" data-action="locate" ${ok ? "" : "disabled"} title="Locate source node">🎯</button>`,
        `<button type="button" class="hub-btn hub-remove" data-action="unpin" title="Unpin from Hub">✕</button>`,
    ].join("");

    // Portal items embed the custom widget itself instead of a value mirror.
    const body = item.type === "widget_portal"
        ? `<div class="hub-portal-host" data-role="portal-host" ` +
          `title="Live embed: interactions go to the source widget (its own menus work). ` +
          `Presets do not apply to portals."><span class="hub-portal-tag">🪟 live</span></div>`
        : (ok ? mirrorHtml(item, tw) : "");

    return `<div class="hub-item-row${ok ? "" : " hub-orphan-row"}" data-hub-item="${esc(item.id)}" data-tab-id="${esc(item.tabId)}">` +
        handle + labelEl + body + tools + `</div>`;
}

function dividerRowHtml(item) {
    return `<div class="hub-divider-row hub-item-row" data-hub-item="${esc(item.id)}" data-tab-id="${esc(item.tabId)}">` +
        `<span class="hub-drag-handle" draggable="true" title="Drag to reorder">⠿</span>` +
        `<span class="hub-divider-label" data-action="rename-divider" title="Dbl-click to rename">— ${esc(item.customLabel || "Section")} —</span>` +
        `<button type="button" class="hub-btn hub-remove" data-action="unpin" title="Remove divider">✕</button>` +
        `</div>`;
}

function containerHtml(node, cfg) {
    const activeTabId = getActiveTabId(cfg);
    const items = itemsOfTab(cfg, activeTabId);
    // .hub-container is the scroll viewport (flex:1 of the node body);
    // .hub-container-inner is the measured content wrapper inside it - its
    // height stays independent of the viewport being stretched or scrolled.
    if (!items.length) {
        return `<div class="hub-container"><div class="hub-container-inner">` +
            `<div class="hub-empty">Right-click any node → 📌 Pin to Settings Hub</div>` +
            `</div></div>`;
    }
    const rows = items.map((it) =>
        it.type === "divider" ? dividerRowHtml(it) : itemRowHtml(it)).join("");
    return `<div class="hub-container"><div class="hub-container-inner">${rows}</div></div>`;
}

function presetRowHtml(cfg) {
    const names = Object.keys(cfg.presets || {});
    const opts = [`<option value="" disabled selected>Preset…</option>`]
        .concat(names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)).join("");
    return `<div class="hub-preset-row">` +
        `<select class="hub-preset-select" data-role="preset-select">${opts}</select>` +
        `<button type="button" class="hub-btn" data-action="preset-save" title="Save current values into selected preset">💾</button>` +
        `<button type="button" class="hub-btn" data-action="preset-new" title="New preset">➕</button>` +
        `<button type="button" class="hub-btn" data-action="preset-del" title="Delete selected preset">🗑️</button>` +
        `<button type="button" class="hub-btn" data-action="add-divider" title="Add section divider">＋Div</button>` +
        `</div>`;
}

// ---------------------------------------------------------------------------
// Value plumbing: control -> target node (with shared lock)
// ---------------------------------------------------------------------------

function pushControlToTarget(node, control, rawValue, manualText = false) {
    const row = control.closest("[data-hub-item]");
    if (!row) return;
    const cfg = getHubConfig(node);
    const item = cfg.items.find((i) => i.id === row.dataset.hubItem);
    if (!item || item.type !== "widget_binding") return;

    const { tn, tw } = findTarget(item);
    if (!tn || !tw) return;

    beginEdit();
    try {
        let v = rawValue;
        switch (control.dataset.role) {
            case "check": v = !!rawValue; break;
            case "combo": v = String(rawValue); break;
            case "text": v = String(rawValue); break;
            case "number":
                // Typed commits keep exact decimals: no step-grid snapping,
                // only real declared bounds apply. manualText=true comes from
                // the change event (user typed); arrows/programmatic stay quantized.
                v = coerceNumeric(rawValue, item, tw, tw.value, { quantize: !manualText });
                break;
            case "range": v = coerceNumeric(rawValue, item, tw, tw.value); break;
        }
        writeTargetValue(tn, tw, v); // already wrapped in the sync lock
        // Normalize BOTH the touched control (e.g. clamped number input)
        // and its sibling so the DOM never shows out-of-range junk.
        if (String(control.value) !== String(v)) control.value = String(v);
        updateSiblingControl(control, v);
        // Adaptive slider re-centers itself on its OWN commit too - otherwise
        // releasing the thumb exactly on a window edge leaves zero headroom.
        if (control.dataset.synthRange === "1") {
            const w = synthSliderWindow(v);
            control.setAttribute("min", String(w.min));
            control.setAttribute("max", String(w.max));
        }
    } finally {
        // writeTargetValue manages its own nesting; this outer pair keeps
        // any callback-triggered rAF refresh suppressed until fully done.
        endEdit();
    }
}

/** Keep range <-> number pair consistent without re-entering target writes.
 *  Adaptive (synth-range) sliders get their display window refreshed around
 *  the committed value so the NEXT drag has headroom both ways. */
function updateSiblingControl(control, value) {
    const mirror = control.closest(".hub-mirror-num");
    if (!mirror) return;
    for (const el of mirror.querySelectorAll("input[data-hub-control]")) {
        if (el === control) continue;
        if (el.dataset.synthRange === "1") {
            const w = synthSliderWindow(value);
            el.setAttribute("min", String(w.min));
            el.setAttribute("max", String(w.max));
        }
        if (el.value !== String(value)) el.value = String(value);
    }
}

// ---------------------------------------------------------------------------
// Searchable combo popup
// ---------------------------------------------------------------------------
// Mirrors the ComfyUI frontend combobox: a live-filtered list that opens near
// the trigger. Filter grammar: space-separated parts, ALL of them must occur
// in the option name (case-insensitive substrings) - "lor 1.2" finds
// "myLora_v1.2". Popup lives on document.body (position:fixed) so the hub's
// scroll viewport can never clip it; same pattern as .hub-menu.

let comboPopState = null; // { node, trigger, cur, active, pop, search, list, filtered }
let comboGlobalWired = false;

/** Multi-token live filter - the user-facing contract of this feature. */
export function comboTokensMatch(text, query) {
    const hay = String(text).toLowerCase();
    const toks = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return true; // empty / whitespace query -> everything matches
    return toks.every((t) => hay.includes(t));
}

export function closeComboPopup() {
    if (!comboPopState) return;
    try { comboPopState.pop.remove(); } catch (_) {}
    comboPopState = null;
}

function markComboActive() {
    const st = comboPopState;
    if (!st) return;
    for (const el of st.list.querySelectorAll(".hub-combo-opt")) {
        el.classList.toggle("hub-combo-active", Number(el.dataset.idx) === st.active);
    }
    try { st.list.querySelector(".hub-combo-active")?.scrollIntoView?.({ block: "nearest" }); } catch (_) {}
}

function paintComboList() {
    const st = comboPopState;
    if (!st) return;
    st.filtered = st.vals.filter((v) => comboTokensMatch(v, st.search.value));
    st.list.innerHTML = st.filtered.length
        ? st.filtered.map((v, i) =>
            `<div class="hub-combo-opt${v === st.cur ? " hub-combo-cur" : ""}" data-idx="${i}">${esc(v)}</div>`).join("")
        : `<div class="hub-combo-none">no matches</div>`;
    // Keep the keyboard cursor inside the filtered set (default: first hit).
    st.active = st.filtered.length ? Math.max(0, Math.min(st.active || 0, st.filtered.length - 1)) : 0;
    markComboActive();
}

function positionComboPopup(pop, trigger) {
    let left = 6, top = 6;
    try {
        const r = trigger.getBoundingClientRect();
        const vw = window.innerWidth || 1024;
        const vh = window.innerHeight || 768;
        const pw = pop.offsetWidth || 220;
        const ph = pop.offsetHeight || 200;
        left = Math.max(6, Math.min(r.left, vw - pw - 6));
        top = r.bottom + 4;
        if (top + ph > vh - 6) top = Math.max(6, r.top - ph - 4); // flip above
    } catch (_) { /* jsdom / detached node - defaults are fine */ }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

/** One global closer pair for every combo popup ever opened. */
function ensureComboGlobalListeners() {
    if (comboGlobalWired) return;
    comboGlobalWired = true;
    document.addEventListener("mousedown", (e) => {
        const st = comboPopState;
        if (!st) return;
        try {
            if (st.pop.contains(e.target) || st.trigger.contains(e.target)) return;
        } catch (_) {}
        closeComboPopup();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (comboPopState && e.key === "Escape") closeComboPopup();
    }, true);
}

function chooseComboValue(node, trigger, value) {
    pushControlToTarget(node, trigger, value); // write-through under sync lock
    const lbl = trigger.querySelector(".hub-combo-label");
    if (lbl) lbl.textContent = String(value);  // reflect instantly (no re-render)
    closeComboPopup();
}

function openComboPopup(node, trigger) {
    // Clicking the same trigger again toggles the popup closed.
    if (comboPopState?.trigger === trigger) { closeComboPopup(); return; }

    const row = trigger.closest("[data-hub-item]");
    if (!row) return;
    const cfg = getHubConfig(node);
    const item = cfg.items.find((i) => i.id === row.dataset.hubItem);
    if (!item || item.type !== "widget_binding") return;
    const { tn, tw } = findTarget(item);
    if (!tn || !tw) return; // orphan rows have nothing to offer
    closeComboPopup();

    const vals = liveComboValues(item, tw).map(String); // always read LIVE options
    if (!vals.length) return;
    const cur = String(tw.value ?? "");

    ensureComboGlobalListeners();

    const pop = document.createElement("div");
    pop.className = "hub-menu hub-combo-pop";
    pop.innerHTML =
        `<input type="text" class="hub-combo-search" spellcheck="false" ` +
        `placeholder="filter… parts separated by space">` +
        `<div class="hub-combo-list"></div>` +
        `<div class="hub-combo-hint">all parts must match · Enter apply · Esc close</div>`;
    document.body.appendChild(pop);

    comboPopState = {
        node, trigger, cur,
        active: Math.max(0, vals.indexOf(cur)), // start on the current value
        pop,
        search: pop.querySelector(".hub-combo-search"),
        list: pop.querySelector(".hub-combo-list"),
        vals, filtered: vals,
    };

    paintComboList();
    positionComboPopup(pop, trigger);
    try { comboPopState.search.focus(); } catch (_) {}

    comboPopState.search.addEventListener("input", () => {
        if (!comboPopState) return;
        comboPopState.active = 0;
        paintComboList();
    });
    comboPopState.search.addEventListener("keydown", (e) => {
        e.stopPropagation();
        const st = comboPopState;
        if (!st) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = st.filtered.length;
            if (!n) return;
            st.active = e.key === "ArrowDown" ? (st.active + 1) % n : (st.active - 1 + n) % n;
            markComboActive();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const v = st.filtered[st.active];
            if (v !== undefined) chooseComboValue(node, trigger, v);
            else closeComboPopup();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeComboPopup();
        }
    });
    comboPopState.list.addEventListener("click", (e) => {
        const opt = e.target.closest(".hub-combo-opt");
        if (!opt || !comboPopState) return;
        const v = comboPopState.filtered[Number(opt.dataset.idx)];
        if (v !== undefined) chooseComboValue(node, trigger, v);
    });
    comboPopState.list.addEventListener("mousemove", (e) => {
        const opt = e.target.closest(".hub-combo-opt");
        const st = comboPopState;
        if (!opt || !st) return;
        const idx = Number(opt.dataset.idx);
        if (st.active !== idx) { st.active = idx; markComboActive(); }
    });
}

// ---------------------------------------------------------------------------
// Value plumbing: target node -> controls  (registered as the values bus fn)
// ---------------------------------------------------------------------------

function refreshValuesDom(node) {
    const st = stateMap.get(node);
    if (!st || !st.root) return;
    const cfg = getHubConfig(node);

    for (const row of st.root.querySelectorAll("[data-hub-item].hub-item-row")) {
        const item = cfg.items.find((i) => i.id === row.dataset.hubItem);
        if (!item || (item.type !== "widget_binding" && item.type !== "widget_portal")) continue;
        const { tn, tw } = findTarget(item);

        // Orphan state may appear while values are unchanged.
        if (!tn || !tw) {
            if (!row.classList.contains("hub-orphan-row")) {
                row.classList.add("hub-orphan-row");
                const lbl = row.querySelector(".hub-item-label");
                if (lbl) { lbl.classList.add("hub-orphan"); lbl.textContent = `⚠️ ${lbl.textContent}`; }
            }
            continue;
        }

        for (const control of row.querySelectorAll("[data-hub-control]")) {
            switch (control.dataset.role) {
                case "check":
                    if (control.checked !== !!tw.value) control.checked = !!tw.value;
                    break;
                case "combo": {
                    // Trigger button: keep the displayed value in lockstep with
                    // the source widget and flag values missing from the live
                    // list (dynamic combos can legally hold stale values).
                    const fresh = liveComboValues(item, tw).map(String);
                    control.dataset.sig = fresh.join("¦");
                    const cur = String(tw.value ?? "");
                    const lblEl = control.querySelector(".hub-combo-label");
                    if (lblEl && lblEl.textContent !== cur) lblEl.textContent = cur;
                    control.classList.toggle("hub-combo-missing", !fresh.includes(cur));
                    break;
                }
                case "text":
                    if (control.value !== String(tw.value)) control.value = String(tw.value ?? "");
                    break;
                default: { // number / range
                    // While the user is editing this control, echoes from the
                    // target must NOT stomp the value mid-typing (caret jumps,
                    // partial strings like "0." overwritten). It resyncs right
                    // after commit/blur via the normal flow.
                    if (document.activeElement === control && control.dataset.role === "number") break;
                    const v = coerceNumeric(tw.value, item, tw, tw.value);
                    if (control.dataset.synthRange === "1") {
                        const w = synthSliderWindow(Number.isFinite(v) ? v : Number(control.value));
                        control.setAttribute("min", String(w.min));
                        control.setAttribute("max", String(w.max));
                    }
                    if (Number(control.value) !== v) control.value = String(v);
                    break;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Locate (🎯): ENTER the owner graph (subgraph!), center camera, highlight
// ---------------------------------------------------------------------------

const nextFrame = () => new Promise((r) => {
    try { requestAnimationFrame(() => r()); }
    catch (_) { setTimeout(r, 16); }
});
const napFrames = async (n) => { for (let i = 0; i < n; i++) await nextFrame(); };

/** Last-resort opener for frontends exposing no programmatic navigation:
 *  synthesize the SAME gesture the user would make - a double click on the
 *  holder node, mapped world->screen through the canvas transform. */
function emulateDblClickAt(holder) {
    const c = app.canvas ?? {};
    const el = c.canvas ?? c.canvas_element ??
        (typeof document !== "undefined" ? document.querySelector("canvas") : null);
    if (!el || typeof el.dispatchEvent !== "function" ||
        !Array.isArray(holder?.pos)) return false;
    const rect = el.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const ds = c.ds ?? {};
    const scale = Number(ds.scale) > 0 ? Number(ds.scale) : 1;
    const ox = Array.isArray(ds.offset) ? Number(ds.offset[0]) || 0 : 0;
    const oy = Array.isArray(ds.offset) ? Number(ds.offset[1]) || 0 : 0;
    const wx = holder.pos[0] + (holder.size?.[0] ?? 140) / 2;
    const wy = holder.pos[1] + (holder.size?.[1] ?? 60) / 2;
    const base = {
        clientX: rect.left + (wx - ox) * scale,
        clientY: rect.top + (wy - oy) * scale,
        bubbles: true, cancelable: true, view: window,
    };
    const fire = (Ctor, type) => {
        if (typeof Ctor !== "function") return;
        try { el.dispatchEvent(new Ctor(type, base)); } catch (_) {}
    };
    const tap = () => {
        fire(window.PointerEvent, "pointerdown");
        fire(window.MouseEvent, "mousedown");
        fire(window.PointerEvent, "pointerup");
        fire(window.MouseEvent, "mouseup");
        fire(window.MouseEvent, "click");
    };
    tap();
    setTimeout(tap, 110);
    setTimeout(() => fire(window.MouseEvent, "dblclick"), 160);
    return true;
}

/**
 * Make the ACTIVE canvas graph become `ownerGraph`.
 * Strategy ladder (availability differs between litegraph generations):
 *   1. direct setters: setGraph / openGraph / openSubgraph / showSubgraph;
 *   2. replaying the canonical gesture along the holder chain -
 *      processNodeDoubleClicked when exposed, synthetic dblclick otherwise.
 */
async function enterOwnerGraph(ownerGraph, holders) {
    const c = app.canvas;
    if (!c || !ownerGraph) return false;

    for (const name of ["setGraph", "openGraph", "openSubgraph", "showSubgraph"]) {
        try {
            if (typeof c[name] !== "function") continue;
            c[name].call(c, ownerGraph);
            await napFrames(2);
            if ((c.graph ?? null) === ownerGraph) return true;
        } catch (_) { /* fall through to the next strategy */ }
    }

    for (const holder of holders ?? []) {
        if (!holder || typeof holder !== "object") continue;
        try {
            if (typeof c.processNodeDoubleClicked === "function") {
                c.processNodeDoubleClicked.call(c, holder);
                for (let i = 0; i < 4; i++) {
                    await napFrames(1);
                    if ((c.graph ?? null) === ownerGraph) return true;
                }
            }
        } catch (_) { /* ignore broken overrides, keep trying */ }
        try {
            if (emulateDblClickAt(holder)) {
                for (let i = 0; i < 8; i++) {
                    await sleep(40);
                    if ((c.graph ?? null) === ownerGraph) return true;
                }
            }
        } catch (_) {}
    }
    return (c.graph ?? null) === ownerGraph;
}

let locateSeq = 0;

async function locateItem(item) {
    const tn = resolveBindingTarget(item);
    if (!tn || !app.canvas?.centerOnNode) return;
    const seq = ++locateSeq;

    // The target usually lives on ANOTHER graph than the visible canvas.
    // Jump INTO its owner graph first - otherwise centering pans the wrong
    // canvas and the user sees nothing move where it matters (field report:
    // pin from inside a subgraph always panned the root view).
    const holders = findHolderChainOf(tn); // [] on root, null when unreachable
    let ownerGraph = tn.graph ?? null;
    if (!ownerGraph || typeof ownerGraph !== "object") {
        // node.graph is NOT guaranteed by every frontend generation - derive
        // the owner from the freshly computed holder chain instead.
        if (holders == null) ownerGraph = null;
        else if (holders.length === 0) ownerGraph = app.graph;
        else ownerGraph = holders[holders.length - 1]?.subgraph ?? null;
    }
    if (ownerGraph && (app.canvas.graph ?? null) !== ownerGraph) {
        try {
            await enterOwnerGraph(ownerGraph, holders ?? []);
        } catch (_) { /* highlight below is still worth showing */ }
    }
    if (seq !== locateSeq) return; // a fresher locate click took over

    app.canvas.centerOnNode(tn);
    // The target may belong to a DIFFERENT graph than the active one - dirty
    // its OWNER so the highlight repaints even when reached cross-graph.
    try { (tn.graph ?? app.graph)?.setDirtyCanvas?.(true, true); } catch (_) {}
    const origColor = tn._origColorHub ?? tn.color ?? "#333333";
    tn._origColorHub = origColor;
    tn.color = "#4a4a2e";
    clearTimeout(locateItem._t);
    locateItem._t = setTimeout(() => {
        tn.color = tn._origColorHub ?? origColor;
        delete tn._origColorHub;
        try { (tn.graph ?? app.graph)?.setDirtyCanvas?.(true, true); } catch (_) {}
    }, 1200);
}

// ---------------------------------------------------------------------------
// Inline rename (tabs / labels / dividers) - single small input swap
// ---------------------------------------------------------------------------

function startInlineEdit(el, initial, onCommit, extraClass = "") {
    if (el.querySelector("input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = `hub-inline-input ${extraClass}`;
    input.value = initial;
    const prevText = el.textContent;
    el.textContent = "";
    el.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        el.textContent = commit && val ? "" : prevText; // onCommit re-renders anyway
        if (commit && val) onCommit(val);
        else el.textContent = prevText;
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// Tab operations
// ---------------------------------------------------------------------------

function addTabFlow(node, cfg) {
    const name = prompt("New tab name:", `Tab ${cfg.tabs.length + 1}`);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    cfg.tabs.push({ id: genId("tab"), name: trimmed, order: cfg.tabs.length });
    node.setDirtyCanvas(true, true);
    renderHub(node);
}

function deleteTabFlow(node, cfg, tabId) {
    if (cfg.tabs.length <= 1) {
        alert("A hub needs at least one tab.");
        return;
    }
    const items = itemsOfTab(cfg, tabId);
    let action = "keep-first"; // default when no items
    if (items.length) {
        action = confirm(
            `"${cfg.tabs.find((t) => t.id === tabId)?.name}" contains ${items.length} pinned item(s).\n\n` +
            `OK = move them to another tab, Cancel = DELETE them from the hub.`,
        ) ? "move" : "delete-items";
    }
    cfg.items = cfg.items.filter(
        (i) => !(i.tabId === tabId) || (action === "move" && i.tabId === tabId),
    );
    if (action === "move") {
        const fallback = sortedTabs(cfg).find((t) => t.id !== tabId)?.id;
        for (const i of cfg.items) if (i.tabId === tabId && fallback) i.tabId = fallback;
    }
    cfg.items = cfg.items.filter((i) => i.tabId !== tabId);
    cfg.tabs = cfg.tabs.filter((t) => t.id !== tabId);
    sortedTabs(cfg).forEach((t, idx) => { t.order = idx; });
    getActiveTabId(cfg);
    renderHub(node);
}

// ---------------------------------------------------------------------------
// Main structural render + events
// ---------------------------------------------------------------------------

function renderHub(node) {
    if (!node || node.type !== "SettingsHub") return;
    if (node.flags?.collapsed) return; // DOM widget hidden while collapsed

    const st = ensureHubDom(node);
    const cfg = getHubConfig(node);
    getActiveTabId(cfg);

    // Self-heal bindings: configs saved by older builds carry wrong values.
    // The live target widget is always authoritative.
    for (const item of cfg.items) {
        if (item.type !== "widget_binding" && item.type !== "widget_portal") continue;
        const { tw } = findTarget(item);
        if (!tw) continue;
        const live = detectWidgetType(tw);
        const liveIsPortal = live === "portal";
        const itemIsPortal = item.type === "widget_portal";

        // Whole-panel GROUP embeds: as long as the primary widget is still a
        // panel there is nothing to heal - and the members[] list + grouped
        // flag must survive (a single-widget migration would destroy them).
        if (itemIsPortal && liveIsPortal && item.options?.grouped) continue;

        if (liveIsPortal !== itemIsPortal) {
            // The widget's character changed (custom widget swapped in/out).
            // Migrate the binding kind so the row stays meaningful.
            item.type = liveIsPortal ? "widget_portal" : "widget_binding";
            item.widgetType = liveIsPortal ? "portal" : live;
            if (liveIsPortal) {
                let srcH = Number(tw.height ?? tw.options?.height);
                if (!Number.isFinite(srcH) || srcH <= 0) srcH = 60;
                const opts = { portalKind: portalKindOf(tw), srcH: Math.round(srcH) };
                if (item.options?.grouped) opts.grouped = true; // keep whole-panel embeds
                item.options = opts;
            } else {
                item.options = isMultilineWidget(tw) ? { multiline: true } : {};
            }
            continue;
        }
        if (itemIsPortal) continue; // portals carry no primitive values

        if (live !== item.widgetType) item.widgetType = live;
        if (live === "text") {
            const ml = isMultilineWidget(tw);
            if (ml !== !!item.options?.multiline) {
                item.options = { ...(item.options || {}), multiline: ml };
            }
        }
    }

    // Held DOM elements would be destroyed by the innerHTML swap below -
    // return them home FIRST, then rebuild, then re-mount portals.
    Portals.releaseAll(node);

    st.root.innerHTML =
        buildTabBarHtml(cfg) +
        containerHtml(node, cfg) +
        presetRowHtml(cfg);

    // Attach reactive hooks for every rendered binding.
    for (const item of cfg.items) ensureHooksForItem(item);

    // Mount portal embeds (DOM relocation / canvas draw loops).
    Portals.mountPortals(node, st.root);

    // The innerHTML swap rebuilt .hub-container-inner - re-attach the
    // content observer to the fresh element.
    if (st.contentRO) {
        try {
            st.contentRO.disconnect();
            const inner = st.root.querySelector(".hub-container-inner");
            if (inner) st.contentRO.observe(inner);
        } catch (_) {}
    }

    layoutNode(node);
}

// ---------------------------------------------------------------------------
// Layout engine
// ---------------------------------------------------------------------------
// Two sizing modes, switched by node.__hubUserH (set in hub_node.onResize
// when the USER drags the node, never when we set the size ourselves):
//
//   AUTO (default)  - node height hugs the content (dev_plan "auto height").
//   FILL (userH)    - the user's height wins; the DOM fills the node exactly
//                     (preset row pinned to the bottom, .hub-container
//                     stretches / scrolls). Content growth taller than the
//                     node lifts the envelope instead of clipping.
//
// Measurement is BY PARTS (tab bar + inner content + preset row), taken from
// .hub-container-inner - immune to the viewport being stretched or scrolled,
// unlike the old max(scrollHeight, rect) read of the whole root which went
// stale (reported: dead space under the preset row).

function measureContent(node, st) {
    const hOf = (el) => {
        if (!el) return 0;
        const rect = el.getBoundingClientRect?.().height || 0;
        return Math.max(el.scrollHeight || 0, el.offsetHeight || 0, rect);
    };
    const root = st.root;
    const tabBar = root.querySelector(".hub-tab-bar");
    const inner = root.querySelector(".hub-container-inner");
    const presetRow = root.querySelector(".hub-preset-row");

    let measured = hOf(tabBar) + hOf(presetRow);

    if (inner) {
        // Count the scroll viewport's own padding/border around the content.
        let pad = 0;
        const container = inner.parentElement;
        if (container && typeof getComputedStyle === "function") {
            try {
                const cs = getComputedStyle(container);
                pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) +
                    (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
            } catch (_) { pad = 0; }
        }
        measured += pad + hOf(inner);
    } else {
        measured += hOf(root.querySelector(".hub-container"));
    }

    // Bottom margin of the preset row is part of the visual content.
    if (presetRow && typeof getComputedStyle === "function") {
        try { measured += parseFloat(getComputedStyle(presetRow).marginBottom) || 0; } catch (_) {}
    }
    return Math.ceil(Math.max(measured, 24));
}

function setNodeHeight(node, h) {
    // Flag around our own setSize so onResize can tell user drags from
    // automatic fits (hub_node.onResize consults this).
    node.__hubAutoSizing = true;
    try { node.setSize([node.size[0], h]); }
    finally { node.__hubAutoSizing = false; }
    node.setDirtyCanvas?.(true, true);
}

function applyHubLayout(node, st) {
    if (node.flags?.collapsed) return;
    const title = titleBarHeight();
    const measured = measureContent(node, st);
    const prevMeasured = st._prevMeasured ?? 0;
    st._prevMeasured = measured;
    st.wrap._hubH = measured; // legacy handle consumed by the auto computeSize

    const userH = !!node.__hubUserH;
    if (st.widget) {
        st.widget.computeSize = userH
            ? () => [node.size[0], Math.max(60, node.size[1] - title - SLOT_TOP_GAP)]
            : () => [node.size[0], measured + SLOT_TOP_GAP + CHROME_H];
    }

    if (userH) {
        // FILL mode. The content grew taller than the user's envelope
        // (textarea stretched, row pinned, ...): lift the envelope instead
        // of clipping. Shrinking content keeps the user's size - the
        // stretchy container absorbs the difference, no dead space.
        const needed = title + SLOT_TOP_GAP + measured + CHROME_H;
        if (measured > prevMeasured && needed > node.size[1] + 0.5) {
            setNodeHeight(node, needed);
        }
        const elH = Math.max(60, node.size[1] - title - SLOT_TOP_GAP - DOM_SLOT_MARGIN);
        if (st.wrap.style.height !== `${elH}px`) st.wrap.style.height = `${elH}px`;
        return;
    }

    // AUTO mode: natural element height + hug the node in both directions,
    // so stale larger sizes can never linger as dead canvas space.
    if (st.wrap.style.height) st.wrap.style.height = "";
    const total = title + SLOT_TOP_GAP + measured + CHROME_H;
    if (Math.abs(node.size[1] - total) > 0.5) setNodeHeight(node, total);
}

/** rAF-coalesced layout pass (safe to call at event frequency). */
function scheduleLayout(node, st) {
    if (!node || node.type !== "SettingsHub" || !st) return;
    if (relayoutScheduled.has(node)) return;
    relayoutScheduled.add(node);
    requestAnimationFrame(() => {
        relayoutScheduled.delete(node);
        applyHubLayout(node, st);
    });
}

/** Full re-render layout: immediate pass + several settling passes. */
function layoutNode(node) {
    const st = stateMap.get(node);
    if (!st) return;
    applyHubLayout(node, st);          // first paint is already correct
    scheduleLayout(node, st);          // after paint (fonts/images settle)
    setTimeout(() => scheduleLayout(node, st), 60);
    setTimeout(() => scheduleLayout(node, st), 250);
}

const relayoutScheduled = new WeakSet();

/**
 * Lightweight relayout for node resizes: NO innerHTML rebuild, one rAF-
 * coalesced measure pass. Cheap enough to run during the whole drag.
 */
export function relayoutHub(node) {
    if (!node || node.type !== "SettingsHub") return;
    scheduleLayout(node, stateMap.get(node));
}

/**
 * Test/RO hook: the hub CONTENT changed size outside a structural render
 * (e.g. the user stretched a mirror textarea). Runs a normal layout pass;
 * growth is detected via the measured diff inside applyHubLayout.
 */
export function notifyHubContentChanged(node) {
    if (!node || node.type !== "SettingsHub") return;
    scheduleLayout(node, stateMap.get(node));
}

// Delegated event wiring — bound ONCE per hub DOM.
function wireEvents(node, st) {
    const root = st.root;

    // Tab switching is ALSO the only place a rename can be started: the
    // browser's native dblclick can never fire on a tab button, because the
    // FIRST click re-renders the whole bar (innerHTML swap) and the second
    // physical click lands on a REPLACEMENT element - the dblclick chain is
    // broken by design of our own render. So we detect the double click at
    // the CLICK level: two clicks on the same tab within the window start
    // the inline edit instead of re-switching.
    const TAB_RENAME_WINDOW_MS = 400;
    let lastTabClick = { id: null, ts: 0 };

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn || btn.disabled) return;
        const cfg = getHubConfig(node);
        const action = btn.dataset.action;

        if (action === "switch-tab") {
            const tabId = btn.dataset.tab;
            const now = Date.now();
            if (lastTabClick.id === tabId && now - lastTabClick.ts < TAB_RENAME_WINDOW_MS) {
                lastTabClick = { id: null, ts: 0 };
                const tabBtn = btn.closest(".hub-tab-btn");
                const tab = cfg.tabs.find((t) => t.id === tabId);
                if (tab && tabBtn && !tabBtn.querySelector("input")) {
                    startInlineEdit(tabBtn, tab.name, (val) => {
                        tab.name = val;
                        node.setDirtyCanvas(true, true);
                        renderHub(node);
                    });
                }
                return; // already active from the first click - no re-render,
                //         otherwise the swap would kill the inline input
            }
            lastTabClick = { id: tabId, ts: now };
            cfg.activeTabId = tabId;
            renderHub(node);
            return;
        }

        switch (action) {
            case "add-tab": addTabFlow(node, cfg); break;
            case "del-tab": deleteTabFlow(node, cfg, btn.closest(".hub-tab-btn")?.dataset.tab); break;
            case "locate": {
                const row = btn.closest("[data-hub-item]");
                const item = cfg.items.find((i) => i.id === row?.dataset.hubItem);
                if (item) locateItem(item);
                break;
            }
            case "unpin": {
                const row = btn.closest("[data-hub-item]");
                const item = cfg.items.find((i) => i.id === row?.dataset.hubItem);
                if (item && confirm(`Unpin "${item.customLabel || item.widgetToBind}"?\n(The parameter stays on its original node.)`)) {
                    if (item.type === "widget_portal") Portals.releaseItem(node, item);
                    removeItem(node, item);
                }
                break;
            }
            case "add-divider": {
                const label = prompt("Divider label:", "");
                if (label === null) return;
                const tabId = getActiveTabId(cfg);
                cfg.items.push({
                    id: genId("item"), type: "divider", tabId,
                    order: Math.max(...cfg.items.filter((i) => i.tabId === tabId).map((i) => (i.order ?? 0)), -1) + 1,
                    customLabel: label.trim() || "Section",
                });
                renderHub(node);
                break;
            }
            case "preset-save": {
                const sel = root.querySelector('[data-role="preset-select"]');
                const chosen = sel?.value || null;
                presetSave(node, chosen); // no selection => single prompt for a name
                break;
            }
            case "preset-new": presetNew(node); break;
            case "preset-del": {
                const sel = root.querySelector('[data-role="preset-select"]');
                if (sel?.value && confirm(`Delete preset "${sel.value}"?`)) {
                    presetDelete(node, sel.value);
                }
                break;
            }
        }
    });

    // Tab rename via double click.
    root.addEventListener("dblclick", (e) => {
        const tabBtn = e.target.closest(".hub-tab-btn[data-tab]");
        if (tabBtn) {
            e.stopPropagation();
            const cfg = getHubConfig(node);
            const tab = cfg.tabs.find((t) => t.id === tabBtn.dataset.tab);
            if (tab) startInlineEdit(tabBtn, tab.name, (val) => {
                tab.name = val;
                node.setDirtyCanvas(true, true);
                renderHub(node);
            });
            return;
        }
        const labelEl = e.target.closest('.hub-item-label[data-action="rename-item"], .hub-divider-label');
        if (labelEl) {
            e.stopPropagation();
            const row = labelEl.closest("[data-hub-item]");
            const cfg2 = getHubConfig(node);
            const item = cfg2.items.find((i) => i.id === row?.dataset.hubItem);
            if (item) {
                const isDivider = item.type === "divider";
                startInlineEdit(labelEl, item.customLabel ||
                    findTarget(item).tw?.name || "", (val) => {
                    item.customLabel = val;
                    node.setDirtyCanvas(true, true);
                    renderHub(node);
                }, isDivider ? "hub-inline-divider" : "");
            }
        }
    });

    // Mirror widget edits -> target nodes.
    root.addEventListener("change", (e) => {
        const c = e.target.closest("[data-hub-control]");
        if (!c) return;
        if (c.dataset.role === "check") pushControlToTarget(node, c, c.checked);
        else if (c.dataset.role === "number") pushControlToTarget(node, c, c.value, true);
    });
    root.addEventListener("input", (e) => {
        const c = e.target.closest("[data-hub-control]");
        if (!c) return;
        if (c.dataset.role === "range") pushControlToTarget(node, c, c.value);
        else if (c.dataset.role === "text") {
            pushControlToTarget(node, c, c.value); // plain inputs + textareas stream
        }
        // number deliberately NOT here: typing "0." / "1e" must not punch
        // garbage through to the target on every keystroke - number inputs
        // commit on the change event above.
    });

    // Preset select applies instantly.
    root.addEventListener("change", (e) => {
        const sel = e.target.closest('[data-role="preset-select"]');
        if (sel && sel.value) presetApply(node, sel.value);
    });

    // Combo triggers open the searchable list (toggle on repeat click).
    root.addEventListener("click", (e) => {
        const btn = e.target.closest('button[data-role="combo"]');
        if (btn && !btn.disabled) openComboPopup(node, btn);
    });
}

// ============================================================================
// Public registration on the module bus
// ============================================================================

registerStructural(renderHub);

registerValues(refreshValuesDom);

export function syncHubNode(node) {
    renderHub(node);
}

