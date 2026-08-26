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
    isMultilineWidget,
} from "./core.js";
import { presetSave, presetNew, presetDelete, presetApply } from "./preset_manager.js";
import { writeTargetValue, ensureHooksForItem } from "./sync_manager.js";
import { beginEdit, endEdit, registerStructural, registerValues } from "./sync.js";
import { initDrag } from "./dnd_manager.js";

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

const stateMap = new WeakMap();

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function findTarget(item) {
    const tn = app.graph?.getNodeById?.(item.targetNodeId);
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
            // Slot height is driven by measured content; ComfyUI sizes the
            // element itself per frame, so we never pin explicit pixel widths.
            widget.computeSize = () => [node.size[0], (wrap._hubH ?? 60) + SLOT_TOP_GAP + CHROME_H];
        }
    } catch (err) {
        console.warn("[SettingsHub] addDOMWidget unavailable:", err);
    }

    st = { root, wrap, widget };
    stateMap.set(node, st);

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
            const vals = liveComboValues(item, tw);
            const cur = String(tw?.value ?? "");
            const sig = vals.join("¦");
            const opts = vals.map((v) =>
                `<option value="${esc(v)}"${String(v) === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
            return `<span class="hub-mirror"><select class="hub-combo" data-role="combo" data-hub-control data-sig="${esc(sig)}">${opts}</select></span>`;
        }
        case "checkbox": {
            const checked = tw?.value === true || tw?.value === "true";
            return `<span class="hub-mirror"><input type="checkbox" class="hub-check" data-role="check" data-hub-control${checked ? " checked" : ""}></span>`;
        }
        case "int":
        case "slider": {
            const o = numericMerge(item, tw);
            const v = coerceNumeric(tw?.value, item, tw, o.min);
            return `<span class="hub-mirror hub-mirror-num">` +
                `<input type="number" class="hub-num-input" data-role="number" data-hub-control ` +
                `value="${esc(String(v))}" min="${o.min}" max="${o.max}" step="${o.step}">` +
                `<input type="range" class="hub-range" data-role="range" data-hub-control ` +
                `value="${esc(String(v))}" min="${o.min}" max="${o.max}" step="${o.step}">` +
                `</span>`;
        }
        default: {
            const val = tw?.value ?? "";
            // Multiline mirrors: persisted flag OR live widget carrying a
            // real <textarea> element (DOM prompt widgets have no flag).
            if (item.options?.multiline || isMultilineWidget(tw)) {
                return `<span class="hub-mirror"><textarea class="hub-text-area" rows="3" spellcheck="false" data-role="text" data-hub-control>${esc(val)}</textarea></span>`;
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

    return `<div class="hub-item-row${ok ? "" : " hub-orphan-row"}" data-hub-item="${esc(item.id)}" data-tab-id="${esc(item.tabId)}">` +
        handle + labelEl +
        (ok ? mirrorHtml(item, tw) : "") +
        tools + `</div>`;
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
    if (!items.length) {
        return `<div class="hub-container"><div class="hub-empty">Right-click any node → 📌 Pin to Settings Hub</div></div>`;
    }
    const rows = items.map((it) =>
        it.type === "divider" ? dividerRowHtml(it) : itemRowHtml(it)).join("");
    return `<div class="hub-container">${rows}</div>`;
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

function pushControlToTarget(node, control, rawValue) {
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
            case "range": v = coerceNumeric(rawValue, item, tw, tw.value); break;
        }
        writeTargetValue(tn, tw, v); // already wrapped in the sync lock
        // Normalize BOTH the touched control (e.g. clamped number input)
        // and its sibling so the DOM never shows out-of-range junk.
        if (String(control.value) !== String(v)) control.value = String(v);
        updateSiblingControl(control, v);
    } finally {
        // writeTargetValue manages its own nesting; this outer pair keeps
        // any callback-triggered rAF refresh suppressed until fully done.
        endEdit();
    }
}

/** Keep range <-> number pair consistent without re-entering target writes. */
function updateSiblingControl(control, value) {
    const mirror = control.closest(".hub-mirror-num");
    if (!mirror) return;
    for (const el of mirror.querySelectorAll("input[data-hub-control]")) {
        if (el !== control && el.value !== String(value)) el.value = String(value);
    }
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
        if (!item || item.type !== "widget_binding") continue;
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
                    const fresh = liveComboValues(item, tw);
                    const sig = fresh.join("¦");
                    if (sig !== control.dataset.sig) {
                        control.innerHTML = fresh.map((v) =>
                            `<option value="${esc(v)}">${esc(v)}</option>`).join("");
                        control.dataset.sig = sig;
                    }
                    const cur = String(tw.value ?? "");
                    if (String(control.value) !== cur && fresh.includes(cur)) control.value = cur;
                    break;
                }
                case "text":
                    if (control.value !== String(tw.value)) control.value = String(tw.value ?? "");
                    break;
                default: { // number / range
                    const v = coerceNumeric(tw.value, item, tw, tw.value);
                    if (Number(control.value) !== v) control.value = String(v);
                    break;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Locate (🎯): center camera on source node + temporary highlight
// ---------------------------------------------------------------------------

function locateItem(item) {
    const tn = app.graph?.getNodeById?.(item.targetNodeId);
    if (!tn || !app.canvas?.centerOnNode) return;
    app.canvas.centerOnNode(tn);
    const origColor = tn._origColorHub ?? tn.color ?? "#333333";
    tn._origColorHub = origColor;
    tn.color = "#4a4a2e";
    clearTimeout(locateItem._t);
    locateItem._t = setTimeout(() => {
        tn.color = tn._origColorHub ?? origColor;
        delete tn._origColorHub;
        app.graph.setDirtyCanvas(true, true);
    }, 1200);
    app.graph.setDirtyCanvas(true, true);
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
        if (item.type !== "widget_binding") continue;
        const { tw } = findTarget(item);
        if (!tw) continue;
        const live = detectWidgetType(tw);
        if (live !== item.widgetType) item.widgetType = live;
        if (live === "text") {
            const ml = isMultilineWidget(tw);
            if (ml !== !!item.options?.multiline) {
                item.options = { ...(item.options || {}), multiline: ml };
            }
        }
    }

    st.root.innerHTML =
        buildTabBarHtml(cfg) +
        containerHtml(node, cfg) +
        presetRowHtml(cfg);

    // Attach reactive hooks for every rendered binding.
    for (const item of cfg.items) ensureHooksForItem(item);

    layoutNode(node);
}

function measurer(node, st) {
    return () => {
        if (node.flags?.collapsed) return;
        // max(scrollHeight, rect) covers both content growth and cases where
        // the element already has an explicitly sized wrapper.
        const rectH = st.root.getBoundingClientRect?.().height || 0;
        const measured = Math.ceil(Math.max(st.root.scrollHeight, rectH, 24));
        st.wrap._hubH = measured;
        if (st.widget) {
            st.widget.computeSize = () => [node.size[0], measured + SLOT_TOP_GAP + CHROME_H];
        }
        // AUTO-HEIGHT (dev_plan: "configurable width, auto height"): the node
        // hugs its content in BOTH directions. User resizes adjust the width
        // freely; manual height changes snap back - shrinking can no longer
        // clip content, growing can no longer leave dead canvas space.
        const total = titleBarHeight() + SLOT_TOP_GAP + measured + CHROME_H;
        if (Math.abs(node.size[1] - total) > 0.5) {
            node.setSize([node.size[0], total]);
            node.setDirtyCanvas(true, true);
        }
    };
}

/** Full re-render layout: several settling passes after content changed. */
function layoutNode(node) {
    const st = stateMap.get(node);
    if (!st) return;
    const m = measurer(node, st);
    requestAnimationFrame(m);          // after paint (attached DOM)
    setTimeout(m, 60);                 // settle pass for fonts/images
    setTimeout(m, 250);                // final pass for async layout shifts
}

const relayoutScheduled = new WeakSet();

/**
 * Lightweight relayout for node resizes: NO innerHTML rebuild, one rAF-
 * coalesced measure pass. Cheap enough to run during the whole drag.
 */
export function relayoutHub(node) {
    if (!node || node.type !== "SettingsHub") return;
    const st = stateMap.get(node);
    if (!st || relayoutScheduled.has(node)) return;
    relayoutScheduled.add(node);
    requestAnimationFrame(() => {
        relayoutScheduled.delete(node);
        if (node.flags?.collapsed) return;
        measurer(node, st)();
    });
}

// Delegated event wiring — bound ONCE per hub DOM.
function wireEvents(node, st) {
    const root = st.root;

    root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn || btn.disabled) return;
        const cfg = getHubConfig(node);
        const action = btn.dataset.action;

        if (action === "switch-tab") {
            cfg.activeTabId = btn.dataset.tab;
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
        if (c.dataset.role === "combo") pushControlToTarget(node, c, c.value);
        else if (c.dataset.role === "check") pushControlToTarget(node, c, c.checked);
        else if (c.dataset.role === "number") pushControlToTarget(node, c, c.value);
    });
    root.addEventListener("input", (e) => {
        const c = e.target.closest("[data-hub-control]");
        if (!c) return;
        if (c.dataset.role === "range") pushControlToTarget(node, c, c.value);
        else if (c.dataset.role === "text" || c.dataset.role === "number") {
            if (c.tagName === "TEXTAREA" || c.dataset.role === "number") {
                pushControlToTarget(node, c, c.value);
            } else {
                pushControlToTarget(node, c, c.value); // text inputs stream too
            }
        }
    });

    // Preset select applies instantly.
    root.addEventListener("change", (e) => {
        const sel = e.target.closest('[data-role="preset-select"]');
        if (sel && sel.value) presetApply(node, sel.value);
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

