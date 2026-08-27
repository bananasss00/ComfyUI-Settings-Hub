// ============================================================================
// SettingsHub - DOM UI renderer
// ----------------------------------------------------------------------------
// The whole hub interface lives inside a single LiteGraph DOM widget
// (node.addDOMWidget), so the CSS in styles.css actually applies:
//
//   .hub-tab-bar    -> visual tabs: click switch / dblclick rename / [+]
//                      / hover [x] delete / drop-item-to-move-tab
//   .hub-queue-row  -> ▶ Queue + "run N times" count (ComfyUI queue)
//   .hub-container  -> one .hub-item-row per pinned widget:
//                      [handle] [label] [mirror] [locate] [remove]
//                      type:"button" pins render a RUN mirror instead
//   .hub-preset-row -> preset select + Save / New / Delete / Add Divider
//
// Mirror widgets are real <select>/<input type=...>/controls bound to the
// source widgets through SyncManager.writeTargetValue(), which holds the
// shared sync lock so no feedback loop can occur.
// ============================================================================

import { app } from "../../scripts/app.js";
import {
    getHubConfig, getActiveTabId, sortedTabs, itemsOfTab, genId,
    liveComboValues, coerceNumeric, removeItem, detectWidgetType,
    isMultilineWidget, portalKindOf, resolveBindingTarget, findHolderChainOf,
    synthSliderWindow, growSynthWindow, allHubs,
    effectiveSliderParams, getSliderOverride, hasSliderOverride,
    setSliderOverride, clearSliderOverride, applyOverrideToTargetWidgets,
    maybeReapplySliderOverride,
} from "./core.js";
import { presetSave, presetNew, presetDelete, presetApply } from "./preset_manager.js";
import { writeTargetValue, ensureHooksForItem, invokeTargetButton } from "./sync_manager.js";
import { beginEdit, endEdit, registerStructural, registerValues } from "./sync.js";
import { initDrag } from "./dnd_manager.js";
import * as Portals from "./portal_manager.js";
import { REFRESH_CHOICES, getRefreshMs, setRefreshMs, refreshLabel } from "./global_settings.js";

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
    // st.__widgetDetached: while the hub floats in a screen-pinned panel the
    // DOM widget is parked OUT of node.widgets (detachHubWidget) - that is a
    // healthy state, it must not trigger a duplicate rebuild here.
    if (st && st.widget && (st.__widgetDetached || node.widgets?.includes(st.widget))) return st;
    // v24.2: a FLOATING hub owns its DOM inside the panel - whatever happened
    // to the widget registry, never spawn a second wrap into the canvas slot
    // (field report: a zoom out+in cycle rebuilt the UI inside the node and
    // left the floating window stale). The render tail re-asserts
    // float + detach instead.
    {
        let pinnedNow = false;
        try { pinnedNow = !!getHubConfig(node).pinned; } catch (_) {}
        if (st && st.wrap && pinnedNow) return st;
    }

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
    // v25 right-side group: 🔍 compact filter, 👁 row-handles visibility,
    // 📌 screen pin, + new tab.
    return `<div class="hub-tab-bar">${btns}` +
        `<input type="text" class="hub-search" data-role="hub-search" spellcheck="false" ` +
        `placeholder="🔍" title="Filter widgets on this tab (substring, case-insensitive; Esc clears)">` +
        `<button type="button" class="hub-chrome-toggle${cfg.hideChrome ? " hub-chrome-off" : ""}" data-action="chrome-toggle" ` +
        `title="Show / hide row handles (drag ⠿ and remove ✕)" ` +
        `aria-pressed="${cfg.hideChrome ? "true" : "false"}">👁</button>` +
        `<button type="button" class="hub-pin-toggle${cfg.pinned ? " hub-pin-on" : ""}" data-action="pin-toggle" ` +
        `title="Keep this hub on screen - float above the canvas, survives panning/zoom" ` +
        `aria-pressed="${cfg.pinned ? "true" : "false"}">📌</button>` +
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
            // v24: the CLOSED trigger keeps its compact ellipsized look, but
            // the native tooltip now carries the FULL value (model paths are
            // routinely longer than the control) on top of the filter hint.
            const vals = liveComboValues(item, tw);
            const cur = String(tw?.value ?? "");
            const sig = vals.join("¦");
            return `<span class="hub-mirror hub-mirror-combo">` +
                `<button type="button" class="hub-combo" data-role="combo" data-hub-control data-sig="${esc(sig)}" ` +
                `title="${esc(cur)}${cur ? "\n" : ""}Searchable list - filter parts separated by space, all must match, case-insensitive">` +
                `<span class="hub-combo-label">${esc(cur)}</span><span class="hub-combo-caret">▾</span></button></span>`;
        }
        case "checkbox": {
            const checked = tw?.value === true || tw?.value === "true";
            return `<span class="hub-mirror"><input type="checkbox" class="hub-check" data-role="check" data-hub-control${checked ? " checked" : ""}></span>`;
        }
        case "int":
        case "slider": {
            // Effective view = source merge (incl. integral-step relaxation:
            // a float source declaring step=1 still gets a FINE drag grid) /
            // user override walls via the gear popup when present.
            const o = effectiveSliderParams(item, tw);
            const sStep = o.sliderStep > 0 ? o.sliderStep : o.step;
            const v = coerceNumeric(tw?.value, item, tw, Number.isFinite(o.min) ? o.min : undefined);
            const finMin = Number.isFinite(o.min);
            const finMax = Number.isFinite(o.max);
            // Faithful attributes on the TEXT editor: undeclared bounds stay
            // ABSENT (open-ended), never replaced by invented 0..1 walls.
            const numAttrs =
                (finMin ? ` min="${o.min}"` : "") +
                (finMax ? ` max="${o.max}"` : "") +
                ` step="${sStep}"`;
            // Slider box: declared bounds win; open sides get an ADAPTIVE
            // nudge window around the current value (data-synth-range).
            // Display-only helper for PrimitiveFloat-style widgets whose
            // bounds are effectively ±infinity: typed commits stay free,
            // coercion still clamps ONLY by declared bounds (+ overrides).
            let slider;
            if (finMin && finMax) {
                slider = `<input type="range" class="hub-range${o.overridden ? " hub-range-ovr" : ""}" data-role="range" data-hub-control ` +
                    `value="${esc(String(v))}" min="${o.min}" max="${o.max}" step="${sStep}">`;
            } else {
                const w = synthSliderWindow(v);
                slider = `<input type="range" class="hub-range hub-range-synth${o.overridden ? " hub-range-ovr" : ""}" data-role="range" data-hub-control ` +
                    `data-synth-range="1" value="${esc(String(v))}" min="${w.min}" max="${w.max}" step="${sStep}" ` +
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
        case "button": {
            // Pinned ACTION BUTTON (rgthree Seed etc.): no value state - the
            // mirror is just a runner that invokes the source callback on its
            // LIVE node. NOT marked data-hub-control on purpose: presets and
            // refreshValuesDom deal with VALUES only; a button has none.
            return `<span class="hub-mirror"><button type="button" class="hub-btn hub-btn-action" ` +
                `data-role="btn-run" title="Run this button on the source node">▶ run</button></span>`;
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
    // v26 viewer rows embed the whole NODE: no widget needs to resolve -
    // a missing widget would otherwise render the row as an orphan.
    const isViewer = item.type === "widget_portal" && !!item.options?.viewer;
    const ok = !!(tn && (tw || isViewer));
    const label = item.customLabel || tw?.label || tw?.name ||
        (isViewer ? "viewer" : item.widgetToBind) || "widget";

    const handle = `<span class="hub-drag-handle" draggable="true" title="Drag to reorder (drop on a tab to move)">⠿</span>`;
    const labelEl = ok
        ? `<span class="hub-item-label" data-action="rename-item" title="Dbl-click to rename">${esc(label)}</span>`
        : `<span class="hub-item-label hub-orphan" title="⚠️ Target node missing">⚠️ ${esc(label)}</span>`;
    const isNumericMirror = ok &&
        (item.widgetType === "int" || item.widgetType === "slider");
    const tools = [
        isNumericMirror
            ? `<button type="button" class="hub-btn hub-gear${hasSliderOverride(item) ? " hub-gear-on" : ""}" data-action="num-settings" title="Custom min / max / step for this slider (+ push to the real node)">⚙</button>`
            : "",
        `<button type="button" class="hub-btn hub-locate" data-action="locate" ${ok ? "" : "disabled"} title="Locate source node">🎯</button>`,
        `<button type="button" class="hub-btn hub-remove" data-action="unpin" title="Unpin from Hub">✕</button>`,
    ].join("");

    // Portal items embed the custom widget itself instead of a value mirror.
    // v26 viewer embeds pin the whole SOURCE NODE (its own background painter
    // IS the viewer) - mark the tag so users can tell the two embed kinds
    // apart at a glance.
    const body = item.type === "widget_portal"
        ? `<div class="hub-portal-host" data-role="portal-host" ` +
          `title="Live embed: interactions go to the source widget (its own menus work). ` +
          `Presets do not apply to portals."><span class="hub-portal-tag">${item.options?.viewer ? "🖼 live" : "🪟 live"}</span></div>`
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
        `<button type="button" class="hub-btn hub-settings" data-action="hub-settings" title="Hub settings (mirror update rate)">⚙</button>` +
        `</div>`;
}

// ---------------------------------------------------------------------------
// Queue controls: enqueue the CURRENT ComfyUI graph N times.
// Mirrors the vanilla Queue button: app.queuePrompt(undefined, N) queues the
// live graph exactly like clicking "Queue Prompt" N times - no number
// argument means plain append-at-back, server assigns execution numbers.
// ---------------------------------------------------------------------------

const MAX_QUEUE_BATCH = 1000;

function parseQueueCount(v) {
    const n = Math.floor(Number(String(v ?? "").trim().replace(",", ".")));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_QUEUE_BATCH);
}

function queueRowHtml(cfg) {
    const n = parseQueueCount(cfg.queueCount);
    // v25 layout: [▶ Queue] ×[N] [badge][🗑]. The badge mirrors ComfyUI's
    // queue_remaining; 🗑 is ALWAYS enabled and wipes the ENTIRE queue -
    // it interrupts the running job and removes every pending entry
    // (POST /queue {"clear":true}, the native Clear payload). It used to
    // be a state-dependent Cancel, which read as "a cross that never
    // activates" - the user asked for full-queue clearing instead.
    return `<div class="hub-queue-row">` +
        `<button type="button" class="hub-btn hub-queue-run" data-action="queue-run" title="Queue prompt (same as ComfyUI Queue button)">▶ Queue</button>` +
        `<span class="hub-queue-times">×</span>` +
        `<input type="text" inputmode="numeric" class="hub-queue-count" data-role="queue-count" ` +
        `value="${esc(String(n))}" title="Run the workflow this many times (1–${MAX_QUEUE_BATCH})">` +
        `<span class="hub-queue-badge" data-role="queue-badge" title="ComfyUI queue remaining"></span>` +
        `<button type="button" class="hub-btn hub-interrupt" data-action="queue-clear" ` +
        `title="Clear the whole queue: stop the current job + remove all pending">🗑</button>` +
        `</div>`;
}

async function runQueueFlow(node) {
    const st = stateMap.get(node);
    if (!st?.root) return;
    const cfg = getHubConfig(node);
    const input = st.root.querySelector('[data-role="queue-count"]');
    const n = parseQueueCount(input?.value);
    cfg.queueCount = n; // persist the user preference across reloads
    if (input && input.value !== String(n)) input.value = String(n);

    const btn = st.root.querySelector('[data-action="queue-run"]');
    try {
        if (typeof app.queuePrompt !== "function") {
            throw new Error("app.queuePrompt is not available in this frontend");
        }
        // Vanilla semantics: number omitted -> plain append, batchCount -> N copies.
        await app.queuePrompt(undefined, n);
        flashBtn(btn, "✓");
    } catch (err) {
        console.warn("[SettingsHub] queue failed:", err);
        flashBtn(btn, "⚠");
    }
}

// ---------------------------------------------------------------------------
// Live queue state (v24 field report: "кнопка почти сразу меняется на Queue,
// отменить задачу неактивна"). The frontend pushes everything we need as
// events on app.api - no polling: "status" carries queue_remaining,
// execution_start/executing turn the bar live, *_success/error/interrupted
// clear it. The Cancel button posts /interrupt exactly like the native UI.
// ---------------------------------------------------------------------------

const qStatus = { remaining: null, running: false }; // last seen server truth
let qApiWiredOnce = false;

/** Robust reader for queue_remaining: official payloads put it under
 *  detail.exec_info, some builds nest it deeper - search shallow-first. */
export function parseQueueRemaining(detail) {
    const found = { v: null };
    const walk = (obj, depth) => {
        if (found.v != null || !obj || typeof obj !== "object" || depth > 6) return;
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (k === "queue_remaining" && Number.isFinite(Number(v))) {
                found.v = Number(v);
                return;
            }
            walk(v, depth + 1);
            if (found.v != null) return;
        }
    };
    try { walk(detail, 0); } catch (_) {}
    return found.v;
}

function setQueueState(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
        if (qStatus[k] !== patch[k]) { qStatus[k] = patch[k]; changed = true; }
    }
    if (changed) paintAllQueues();
}

/**
 * Subscribe the shared queue-status engine to the ComfyUI api event source.
 * Idempotent; tolerates being called with nothing (called again from the
 * extension setup / afterConfigureGraph once the api object exists).
 */
export function initQueueStatus(api) {
    if (qApiWiredOnce || !api || typeof api.addEventListener !== "function") return false;
    qApiWiredOnce = true;
    const on = (ev, fn) => {
        try {
            api.addEventListener(ev, (e) => {
                try { fn(e?.detail); } catch (_) { /* listeners must never throw */ }
            });
        } catch (_) {}
    };
    on("status", (d) => {
        const r = parseQueueRemaining(d);
        if (r != null) setQueueState({ remaining: r });
    });
    on("execution_start", () => setQueueState({ running: true }));
    on("executing", (nid) => { if (nid != null) setQueueState({ running: true }); });
    on("execution_success", () => setQueueState({ running: false }));
    on("execution_error", () => setQueueState({ running: false }));
    on("execution_interrupted", () => setQueueState({ running: false }));
    return true;
}

/** Mirror qStatus into every rendered hub's queue bar WITHOUT a re-render
 *  (innerHTML swaps would kill open popups and inline editors). */
function paintQueueBarDom(root) {
    const btn = root.querySelector('[data-action="queue-run"]');
    const clearBtn = root.querySelector('[data-action="queue-clear"]');
    const badge = root.querySelector('[data-role="queue-badge"]');
    if (!btn && !clearBtn && !badge) return;
    const rem = Number(qStatus.remaining);
    const hasRem = Number.isFinite(rem) && rem > 0;
    if (badge) {
        const txt = hasRem ? String(rem) : "";
        if (badge.textContent !== txt) badge.textContent = txt;
        badge.classList.toggle("hub-queue-has", hasRem);
    }
    btn?.classList.toggle("hub-queue-live", qStatus.running === true);
    // The clear button is always clickable (v25); this class is now purely a
    // "there is something to wipe" visual hint.
    if (clearBtn) {
        clearBtn.classList.toggle("hub-interrupt-on", qStatus.running === true || hasRem);
    }
}

function paintAllQueues() {
    for (const hub of allHubs()) {
        const st = stateMap.get(hub);
        if (st?.root) paintQueueBarDom(st.root);
    }
}

/** v25: the 🗑 button wipes the ENTIRE queue - interrupts the running job
 *  AND removes every pending entry. Always enabled: clicking with an empty
 *  queue is a harmless no-op. api.clearQueue() is preferred where exposed;
 *  the fallback POSTs exactly what the native Clear button does
 *  (POST /queue {"clear":true}) plus POST /interrupt for the live job. */
async function clearQueueFlow(node) {
    const st = stateMap.get(node);
    const btn = st?.root?.querySelector('[data-action="queue-clear"]');
    const api = app.api;
    let stopped = false;
    let wiped = false;
    try {
        if (typeof api?.interrupt === "function") {
            await api.interrupt(); stopped = true;
        } else if (typeof api?.fetchApi === "function") {
            await api.fetchApi("/interrupt", { method: "POST" }); stopped = true;
        }
    } catch (_) { /* the wipe below still runs */ }
    try {
        if (typeof api?.clearQueue === "function") {
            await api.clearQueue(); wiped = true;
        } else if (typeof api?.fetchApi === "function") {
            await api.fetchApi("/queue", { method: "POST", body: JSON.stringify({ clear: true }) });
            wiped = true;
        }
    } catch (_) { /* reported below */ }
    if (stopped || wiped) {
        // Server truth re-syncs via status/execution_* events; flip locally
        // right away so the badge and the LIVE mark answer instantly.
        setQueueState({ running: false, remaining: 0 });
        flashBtn(btn, "✓");
    } else {
        console.warn("[SettingsHub] queue clear unavailable in this frontend");
        flashBtn(btn, "⚠");
    }
}

// ---------------------------------------------------------------------------
// Screen pinning (v24 feature request: "чтобы UI хаба оставался всегда на
// экране"). The whole hub DOM widget element (`wrap`) is MOVED out of the
// LiteGraph slot into a fixed-position panel on document.body. Moving (not
// cloning) preserves every listener; renderHub keeps rebuilding
// `st.root.innerHTML`, portals and observers are location-independent, so
// the floating window stays fully functional while the canvas node shrinks
// to a slim ghost. State persists in the hub config: pinned / pinPos /
// pinMin survive reloads (getHubConfig normalization in core.js).
//
// v24.1 zoom fix: the frontend's DOM-widget manager rewrites the element's
// visibility and geometry EVERY frame from the NODE's slot rect (hides at
// low zoom, culls offscreen, crushes to the slot height). While the element
// lives in the floating panel those writes are garbage - a zoom-out/zoom-in
// cycle left the window with a bare header. While floating, the widget is
// therefore parked OUT of node.widgets (detachHubWidget) so the manager
// cannot see the element at all; homeHub re-attaches it verbatim.
// ---------------------------------------------------------------------------

const pinPanels = new WeakMap(); // hub node -> { panel, head, body, btnMin, btnPin }
let pinCascade = 0;

function isWrapInPanel(st) {
    try { return !!(st?.wrap && st.panelBody && st.wrap.parentElement === st.panelBody); }
    catch (_) { return false; }
}

/** Park the DOM widget out of node.widgets while the wrap lives in the
 *  floating panel (rationale in the section comment above). The original
 *  slot index is remembered so homeHub can put it back 1:1. On frontends
 *  where node.widgets is not a plain array we skip the detach - the
 *  .hub-wrap-floating CSS shield below still neutralizes their writes. */
function detachHubWidget(node, st) {
    if (!st?.widget || st.__widgetDetached) return;
    const list = node.widgets;
    if (!Array.isArray(list)) return;
    st.__widgetIndex = list.indexOf(st.widget);
    if (st.__widgetIndex < 0) return;
    list.splice(st.__widgetIndex, 1);
    st.__widgetDetached = true;
}

function reattachHubWidget(node, st) {
    if (!st?.widget || !st.__widgetDetached) return;
    const list = node.widgets;
    if (Array.isArray(list) && !list.includes(st.widget)) {
        const at = Number.isInteger(st.__widgetIndex) && st.__widgetIndex >= 0
            ? Math.min(st.__widgetIndex, list.length)
            : list.length;
        list.splice(at, 0, st.widget);
    }
    st.__widgetDetached = false;
    st.__widgetIndex = -1;
}

/** Drop inline styles the frontend's DOM-widget manager may have parked on
 *  the element before the detach (display:none survives reparenting!) and
 *  restore the width contract that belongs to US, not to the slot. */
function resetWrapGeometry(wrap) {
    if (!wrap) return;
    const s = wrap.style;
    for (const k of ["position", "inset", "left", "top", "right", "bottom",
        "transform", "visibility", "zIndex", "margin", "display", "height"]) {
        s[k] = "";
    }
    s.width = "100%";
}

/** Live check: is THIS hub currently shown in a floating window? */
export function isHubFloating(node) {
    return isWrapInPanel(stateMap.get(node));
}

function clampPinPos(x, y) {
    const vw = Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1280;
    const vh = Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 800;
    return {
        x: Math.min(Math.max(8, Number(x) || 8), Math.max(8, vw - 200)),
        y: Math.min(Math.max(8, Number(y) || 8), Math.max(8, vh - 64)),
    };
}

function savePinPosFromRect(node, panel) {
    try {
        const x = parseFloat(panel.style.left || "0") || 0;
        const y = parseFloat(panel.style.top || "0") || 0;
        getHubConfig(node).pinPos = clampPinPos(x, y);
    } catch (_) {}
}

// --- v27.2: user-resizable floating window ---------------------------------
const PIN_MIN_W = 280;   // rows keep their chrome (handles/buttons) below this
const PIN_MIN_H = 120;   // header + a couple of rows

function clampPinSize(w, h) {
    const vw = Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1280;
    const vh = Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 800;
    const maxW = Math.max(PIN_MIN_W, vw - 16);
    const maxH = Math.max(PIN_MIN_H, vh - 40);
    return {
        w: Math.min(Math.max(PIN_MIN_W, Math.round(Number(w) || 0)), maxW),
        h: Math.min(Math.max(PIN_MIN_H, Math.round(Number(h) || 0)), maxH),
    };
}

/** Materialize cfg.pinSize on the panel (or reset to the auto/hug mode).
 *  Explicit height turns the panel into a real flex column: the body fills
 *  the remaining space and scrolls (.hub-pin-sized CSS); without pinSize the
 *  legacy CSS keeps hugging content up to max-height. */
function applyPinSize(node, panel) {
    let size = null;
    try {
        const raw = getHubConfig(node).pinSize;
        size = raw ? clampPinSize(raw.w, raw.h) : null;
    } catch (_) { size = null; }
    if (size) {
        try { getHubConfig(node).pinSize = size; } catch (_) {}
        panel.classList.add("hub-pin-sized");
        panel.style.width = `${size.w}px`;
        panel.style.height = `${size.h}px`;
    } else {
        panel.classList.remove("hub-pin-sized");
        panel.style.width = "";
        panel.style.height = "";
    }
}

/** Persist the on-screen size (called at the end of a resize gesture). */
function savePinSizeFromRect(node, panel) {
    try {
        const r = panel.getBoundingClientRect();
        const w = parseFloat(panel.style.width || "0") || r.width || 0;
        const h = parseFloat(panel.style.height || "0") || r.height || 0;
        getHubConfig(node).pinSize = clampPinSize(w, h);
    } catch (_) {}
}

/** While floating, the canvas node collapses to a title-bar ghost so no
 *  dead rectangle lingers under the cursor. The PRE-PIN envelope is saved
 *  and restored verbatim on unpin - a user-sized (FILL) hub must get back
 *  exactly the height it had, an auto hub re-hugs from there. Idempotent
 *  and RE-RUNNABLE: an external rebuild/re-inflation of the node while
 *  floating (frontend widget manager, graph configure) is re-slimmed on
 *  the next float pass; the pre-pin envelope is captured exactly once. */
function slimHubSlot(node, st) {
    if (!st.__prePinSize) st.__prePinSize = [node.size[0], node.size[1]];
    st.__slimApplied = true;
    const title = titleBarHeight();
    if (st.widget) st.widget.computeSize = () => [node.size[0], 4];
    node.__hubAutoSizing = true;
    try { node.setSize([node.size[0], title + 2]); }
    finally { node.__hubAutoSizing = false; }
    node.setDirtyCanvas?.(true, true);
}

function ensurePinPanel(node, st) {
    let p = pinPanels.get(node);
    if (p && p.isConnected !== false) return p;

    const panel = document.createElement("div");
    panel.className = "hub-pin-panel";
    panel.dataset.hubPin = "1";

    const head = document.createElement("div");
    head.className = "hub-pin-head";
    const grip = document.createElement("span");
    grip.className = "hub-pin-grip";
    grip.title = "Drag the window";
    grip.textContent = "⠿";
    const ttl = document.createElement("span");
    ttl.className = "hub-pin-title";
    ttl.textContent = node.title?.replace(/\s+/g, " ").trim() || "Settings Hub";
    const btnMin = document.createElement("button");
    btnMin.type = "button";
    btnMin.className = "hub-pin-btn hub-pin-min";
    btnMin.textContent = "–";
    btnMin.title = "Collapse / expand the pinned window";
    const btnBack = document.createElement("button");
    btnBack.type = "button";
    btnBack.className = "hub-pin-back hub-pin-btn";
    btnBack.textContent = "📌";
    btnBack.title = "Return the hub onto the canvas";
    head.appendChild(grip);
    head.appendChild(ttl);
    head.appendChild(btnMin);
    head.appendChild(btnBack);

    const body = document.createElement("div");
    body.className = "hub-pin-body";
    // v27.2: SE resize grip (size persists in cfg.pinSize, dblclick resets).
    const rsz = document.createElement("div");
    rsz.className = "hub-pin-resize";
    rsz.title = "Resize the window (double-click resets the size)";
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(rsz);
    document.body.appendChild(panel);

    // Dragging moves the WINDOW, never interferes with row-level dnd (the
    // handle lives here, rows' reorder handles stay inside the hub root).
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
        if (e.target.closest?.(".hub-pin-btn")) return;
        e.preventDefault();
        e.stopPropagation();
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { head.setPointerCapture?.(e.pointerId); } catch (_) {}
    });
    head.addEventListener("pointermove", (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = clampPinPos(e.clientX - drag.dx, e.clientY - drag.dy);
        panel.style.left = `${pos.x}px`;
        panel.style.top = `${pos.y}px`;
    });
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        savePinPosFromRect(node, panel);
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
    head.addEventListener("dblclick", (e) => e.stopPropagation());

    btnMin.addEventListener("click", (e) => {
        e.stopPropagation();
        const cfg = getHubConfig(node);
        cfg.pinMin = !cfg.pinMin;
        panel.classList.toggle("hub-pin-collapsed", cfg.pinMin);
        savePinPosFromRect(node, panel);
    });
    btnBack.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleHubPinned(node, false);
    });

    // --- v27.2: SE-corner resize (same pointer-capture pattern as the drag)
    let rszDrag = null;
    rsz.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (getHubConfig(node).pinMin) return;      // collapsed: nothing to size
        const r = panel.getBoundingClientRect();
        rszDrag = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
        panel.classList.add("hub-pin-resizing");
        try { rsz.setPointerCapture?.(e.pointerId); } catch (_) {}
    });
    rsz.addEventListener("pointermove", (e) => {
        if (!rszDrag) return;
        e.preventDefault();
        e.stopPropagation();
        const s = clampPinSize(
            rszDrag.w + (e.clientX - rszDrag.x),
            rszDrag.h + (e.clientY - rszDrag.y),
        );
        panel.classList.add("hub-pin-sized");
        panel.style.width = `${s.w}px`;
        panel.style.height = `${s.h}px`;
    });
    const endRsz = (e) => {
        if (!rszDrag) return;
        rszDrag = null;
        panel.classList.remove("hub-pin-resizing");
        try { rsz.releasePointerCapture?.(e?.pointerId); } catch (_) {}
        savePinSizeFromRect(node, panel);
    };
    rsz.addEventListener("pointerup", endRsz);
    rsz.addEventListener("pointercancel", endRsz);
    rsz.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        try { getHubConfig(node).pinSize = null; } catch (_) {}
        applyPinSize(node, panel);                  // back to hug-content mode
    });

    p = { panel, head, body, btnMin, btnBack, rsz };
    pinPanels.set(node, p);
    st.panelBody = body;
    return p;
}

let wrapHealCrumbShown = false;

/** v24.2 home-keeper: while the wrap lives in the floating panel, NOTHING
 *  else may move it (a frontend DOM-widget manager, a subgraph view
 *  rebuild, ...). If the element is yanked out, put it straight back.
 *  Event-driven (MutationObserver on the panel body) - zero polling. */
function armWrapHomeKeeper(node, st, body) {
    try { st.wrapObserver?.disconnect(); } catch (_) {}
    st.wrapObserver = null;
    if (typeof MutationObserver !== "function") return;
    st.wrapObserver = new MutationObserver(() => {
        try {
            if (!getHubConfig(node).pinned) return;
            if (!st.wrap || st.wrap.parentElement === body) return;
            if (!document.body.contains(body)) return;
            body.appendChild(st.wrap); // appendChild MOVES the element back
            if (!wrapHealCrumbShown) {
                wrapHealCrumbShown = true;
                console.info("[SettingsHub] floating hub content was pulled back to the canvas by the frontend - restored to the floating window automatically.");
            }
        } catch (_) {}
    });
    st.wrapObserver.observe(body, { childList: true });
}

function floatHub(node) {
    const st = stateMap.get(node);
    if (!st?.wrap) return false;
    const cfg = getHubConfig(node);
    const p = ensurePinPanel(node, st);
    if (!isWrapInPanel(st)) {
        // Leave the frontend's per-frame DOM-widget management FIRST (it may
        // have just parked display:none on the element during a zoom-out),
        // clean its stale inline writes, then move the element.
        detachHubWidget(node, st);
        st.__hubHomeParent = st.wrap.parentElement ?? null;
        st.__hubHomeNext = st.wrap.nextSibling;
        resetWrapGeometry(st.wrap);
        st.wrap.classList.add("hub-wrap-floating");
        p.body.appendChild(st.wrap);
    }
    armWrapHomeKeeper(node, st, p.body);
    p.panel.classList.toggle("hub-pin-collapsed", !!cfg.pinMin);
    let pos = (cfg.pinPos && Number.isFinite(Number(cfg.pinPos.x)))
        ? { x: cfg.pinPos.x, y: cfg.pinPos.y } : null;
    if (!pos) {
        pos = { x: 120 + (pinCascade % 7) * 26, y: 90 + (pinCascade % 7) * 26 };
        pinCascade++;
        cfg.pinPos = pos;
    }
    const c = clampPinPos(pos.x, pos.y);
    p.panel.style.left = `${c.x}px`;
    p.panel.style.top = `${c.y}px`;
    applyPinSize(node, p.panel);   // v27.2: restore the persisted window size
    slimHubSlot(node, st);
    // Reflect the state on the (already mounted) tab-bar marker instantly.
    const tgl = st.root.querySelector('[data-action="pin-toggle"]');
    if (tgl) {
        tgl.classList.add("hub-pin-on");
        tgl.setAttribute("aria-pressed", "true");
    }
    paintQueueBarDom(st.root);
    return true;
}

function homeHub(node) {
    const st = stateMap.get(node);
    // Disarm the home-keeper BEFORE touching the wrap: its pending mutation
    // records would otherwise pull the wrap straight back into the panel.
    try { st?.wrapObserver?.disconnect(); } catch (_) {}
    if (st) st.wrapObserver = null;
    if (st?.wrap) {
        // Hand the widget back to the frontend BEFORE the element moves home,
        // so a same-tick canvas draw can position it into the slot again.
        reattachHubWidget(node, st);
        st.wrap.classList.remove("hub-wrap-floating");
        resetWrapGeometry(st.wrap);
    }
    if (st?.wrap && st.__hubHomeParent) {
        try {
            st.__hubHomeParent.insertBefore(st.wrap, st.__hubHomeNext ?? null);
        } catch (_) {
            try { st.__hubHomeParent.appendChild(st.wrap); } catch (_) {}
        }
        st.__hubHomeParent = null;
        st.__hubHomeNext = null;
    }
    const p = pinPanels.get(node);
    try { p?.panel.remove(); } catch (_) {}
    if (p) pinPanels.delete(node);
    if (st) {
        // Give the node back its pre-pin envelope BEFORE the follow-up
        // render/layout pass - FILL hubs must not adopt the ghost height.
        if (st.__slimApplied && st.__prePinSize) {
            node.__hubAutoSizing = true;
            try { node.setSize([st.__prePinSize[0], st.__prePinSize[1]]); }
            finally { node.__hubAutoSizing = false; }
            st.__prePinSize = null;
        }
        st.panelBody = null;
        st.__slimApplied = false;
    }
    return true;
}

/**
 * Toggle (or force) the floating screen-pinned window for a hub.
 * Returns the resulting pinned state.
 */
export function toggleHubPinned(node, want) {
    if (!node || node.type !== "SettingsHub") return false;
    const cfg = getHubConfig(node);
    const target = typeof want === "boolean" ? want : !cfg.pinned;
    cfg.pinned = target;
    node.setDirtyCanvas?.(true, true);
    if (target) {
        floatHub(node);
    } else {
        homeHub(node);
        renderHub(node); // restores canvas slot sizing + normal layout
    }
    return target;
}

/** Full teardown (hub deleted from the graph): no orphan windows left. */
export function disposeHubVisuals(node) {
    const st = stateMap.get(node);
    try { st?.wrapObserver?.disconnect(); } catch (_) {}
    if (st) st.wrapObserver = null;
    const p = pinPanels.get(node);
    try { p?.panel.remove(); } catch (_) {}
    pinPanels.delete(node);
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
        // Adaptive slider window GROWS one-sidedly when the committed value
        // escapes it - NEVER re-centers, so the thumb stays meaningful
        // relative to a stable scale (field report v20: "всегда по центру").
        if (control.dataset.synthRange === "1") {
            const w = growSynthWindow(control.min, control.max, v);
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
 *  Adaptive (synth-range) sliders only GROW their window when the value
 *  escapes it (sticky scale - never re-centered: the thumb keeps meaning). */
function updateSiblingControl(control, value) {
    const mirror = control.closest(".hub-mirror-num");
    if (!mirror) return;
    for (const el of mirror.querySelectorAll("input[data-hub-control]")) {
        if (el === control) continue;
        if (el.dataset.synthRange === "1") {
            const w = growSynthWindow(el.min, el.max, value);
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

// ---------------------------------------------------------------------------
// v24 long-path readability. Model dropdown values are routinely full paths
// ("checkpoints/sdxl/jibMixReal_v60.safetensors"). The popup widens instead
// of clipping and very long entries render as TWO lines: highlighted file
// name over a dim monospace directory strip. Full text stays one hover away
// via native tooltips, so the compact look of the hub is never sacrificed.

/** Split a combo value into {base, dir} for the two-line display.
 *  base is the LAST path segment (file name); dir keeps its separator.
 *  Returns null when there is no meaningful split (no separator at all). */
export function splitComboPathText(text) {
    const s = String(text ?? "");
    const m = s.match(/^(.*[\/\\:])([^\/\\:]+)$/);
    if (!m || !m[1]) return null;
    return { dir: m[1], base: m[2] };
}

const COMBO_TWO_LINE_MIN_LEN = 34;

function comboOptionHtml(v, idx, isCur) {
    const split = splitComboPathText(v);
    // NOTE: no literal check-mark in the markup - the .hub-combo-cur tick
    // comes from CSS ::before, keeping textContent clean for a11y/tests.
    if (split && v.length >= COMBO_TWO_LINE_MIN_LEN) {
        return `<div class="hub-combo-opt hc-two${isCur ? " hub-combo-cur" : ""}" data-idx="${idx}" ` +
            `title="${esc(v)}">` +
            `<span class="hc-base">${esc(split.base)}</span>` +
            `<span class="hc-dir">${esc(split.dir)}</span></div>`;
    }
    return `<div class="hub-combo-opt${isCur ? " hub-combo-cur" : ""}" data-idx="${idx}" ` +
        `title="${esc(v)}">${esc(v)}</div>`;
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
        ? st.filtered.map((v, i) => comboOptionHtml(v, i, v === st.cur)).join("")
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
// Slider override gear popover (custom min / max / step per numeric row)
// ---------------------------------------------------------------------------
// Body-level fixed popup (same pattern as the combo list, immune to hub
// scroll clipping). Fields left EMPTY mean "no user wall on this side - use
// the source's semantics". Apply re-renders the row; Push writes the numbers
// onto the REAL node widget(s); auto-apply re-pushes after page reloads
// (ComfyUI rebuilds widgets from definitions on load).

let numPopState = null; // { node, item, trigger, pop }
let numPopGlobalWired = false;

function closeNumPopup() {
    if (!numPopState) return;
    try { numPopState.pop.remove(); } catch (_) {}
    numPopState = null;
}

/** One global closer pair for every gear popup ever opened (cheap no-op
 *  while closed - same pattern as ensureComboGlobalListeners). */
function ensureNumPopupGlobalListeners() {
    if (numPopGlobalWired) return;
    numPopGlobalWired = true;
    document.addEventListener("mousedown", (e) => {
        const st = numPopState;
        if (!st) return;
        try {
            if (st.pop.contains(e.target) || st.trigger.contains(e.target)) return;
        } catch (_) {}
        closeNumPopup();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (numPopState && e.key === "Escape") closeNumPopup();
    }, true);
}

function positionNumPopup(pop, trigger) {
    // Same clamp-into-viewport math as the combo popup.
    let left = 6, top = 6;
    try {
        const r = trigger.getBoundingClientRect();
        const vw = window.innerWidth || 1024;
        const vh = window.innerHeight || 768;
        const pw = pop.offsetWidth || 240;
        const ph = pop.offsetHeight || 220;
        left = Math.max(6, Math.min(r.left, vw - pw - 6));
        top = r.bottom + 4;
        if (top + ph > vh - 6) top = Math.max(6, r.top - ph - 4);
    } catch (_) { /* jsdom / detached node - defaults are fine */ }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

function parsePopField(el) {
    // Returns {clear:true} for empty input, {ok:true,v:Number} or {error}.
    const t = String(el.value ?? "").trim().replace(",", ".");
    if (t === "") return { clear: true };
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return { error: true };
    const n = Number(t);
    return Number.isFinite(n) ? { ok: true, v: n } : { error: true };
}

function flashBtn(btn, text) {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { try { btn.textContent = prev; } catch (_) {} }, 900);
}

function applyNumPopover(node, st) {
    const fields = {
        min: st.pop.querySelector('[data-pop-field="min"]'),
        max: st.pop.querySelector('[data-pop-field="max"]'),
        step: st.pop.querySelector('[data-pop-field="step"]'),
    };
    let bad = null;
    for (const k of Object.keys(fields)) {
        const res = parsePopField(fields[k]);
        const isBad = res.error || (k === "step" && !res.clear && !(res.v > 0));
        fields[k].classList.toggle("hub-pop-bad", !!isBad);
        if (isBad && !bad) bad = k;
    }
    if (bad) return false;

    const patch = {};
    for (const k of Object.keys(fields)) {
        const res = parsePopField(fields[k]);
        if (res.clear) patch[k] = null;             // explicit clear of a side
        else if (res.ok) patch[k] = res.v;
    }
    const autoApply = st.pop.querySelector('[data-pop-role="auto"]').checked;
    setSliderOverride(st.item, patch, { autoApply });
    node.setDirtyCanvas?.(true, true);
    closeNumPopup();
    renderHub(node); // fresh attrs on range/text pair + gear highlight state
    return true;
}

function openNumPopup(node, trigger) {
    const row = trigger.closest("[data-hub-item]");
    if (!row) return;
    const cfg = getHubConfig(node);
    const item = cfg.items.find((i) => i.id === row.dataset.hubItem);
    if (!item || item.type !== "widget_binding") return;
    if (!(item.widgetType === "int" || item.widgetType === "slider")) return;

    // Toggle behavior mirrors the combo trigger.
    if (numPopState?.trigger === trigger) { closeNumPopup(); return; }
    closeComboPopup();
    closeNumPopup();

    const ov = getSliderOverride(item);
    const eff = effectiveSliderParams(item, findTarget(item).tw);
    // Placeholder shows the NODE'S ORIGINAL value (captured before the first
    // push), not the currently-pushed numbers - field report v22: after a
    // push the custom values looked like node defaults in the empty-state
    // hints. Suffix "·node" is only truthful when a snapshot exists.
    const nat = (item.sliderOverride?.native && typeof item.sliderOverride.native === "object")
        ? item.sliderOverride.native : null;
    const phOf = (natV, effV) => {
        if (nat && Number.isFinite(Number(natV))) return `${String(natV)}·node`;
        const f = Number.isFinite(Number(effV)) ? String(Number(effV)) : "";
        return f ? `${f}·src` : "";
    };
    const autoChecked = item.sliderOverride?.applySliderOverride !== false;

    const pop = document.createElement("div");
    pop.className = "hub-menu hub-num-pop";
    pop.innerHTML =
        `<div class="hub-menu-title">⚙ ${esc(item.customLabel || item.widgetToBind || "slider")}</div>` +
        `<div class="hub-pop-grid">` +
        `<label>min</label><input data-pop-field="min" inputmode="decimal" spellcheck="false" placeholder="${esc(phOf(nat?.min, eff.min))}" value="${ov.min !== undefined ? esc(String(ov.min)) : ""}">` +
        `<label>max</label><input data-pop-field="max" inputmode="decimal" spellcheck="false" placeholder="${esc(phOf(nat?.max, eff.max))}" value="${ov.max !== undefined ? esc(String(ov.max)) : ""}">` +
        `<label>step</label><input data-pop-field="step" inputmode="decimal" spellcheck="false" placeholder="${esc(phOf(nat?.step, eff.sliderStep))}" value="${ov.step !== undefined ? esc(String(ov.step)) : ""}">` +
        `</div>` +
        `<label class="hub-pop-auto"><input type="checkbox" data-pop-role="auto"${autoChecked ? " checked" : ""}> auto-apply to real nodes (incl. reload)</label>` +
        `<div class="hub-pop-hint">empty field = keep source side · grey hint = node original · step &gt; 0</div>` +
        `<div class="hub-pop-btns">` +
        `<button type="button" data-pop-btn="apply" title="Save for this binding">✓</button>` +
        `<button type="button" data-pop-btn="push" title="Write min/max/step onto the REAL node widgets right now">⤴ push</button>` +
        `<button type="button" data-pop-btn="clear" title="Remove override completely">clear</button>` +
        `<button type="button" data-pop-btn="close" title="Close">✕</button>` +
        `</div>`;
    document.body.appendChild(pop);

    numPopState = { node, item, trigger, pop };
    ensureNumPopupGlobalListeners();

    pop.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-pop-btn]");
        if (!btn || !numPopState) return;
        e.stopPropagation();
        const act = btn.dataset.popBtn;
        if (act === "close") { closeNumPopup(); return; }
        if (act === "apply") { applyNumPopover(node, numPopState); return; }
        if (act === "clear") {
            // Restore the REAL widget's original min/max/step(/precision/round)
            // when they were captured at the first push, then drop the config.
            clearSliderOverride(numPopState.item);
            node.setDirtyCanvas?.(true, true);
            closeNumPopup();
            renderHub(node);
            return;
        }
        if (act === "push") {
            // Persist what the fields hold FIRST (empty=inputless sides stay),
            // then write onto live widgets without waiting for a reload.
            const okApply = applyNumPopover(node, numPopState);
            if (!okApply) return;
            const cnt = applyOverrideToTargetWidgets(
                getHubConfig(node).items.find((i) => i.id === item.id) ?? {});
            // The popup was closed and the hub re-rendered - flash the FRESH
            // gear button of this row (the old one died in the innerHTML swap).
            const freshGear = document.querySelector(
                `[data-hub-item="${item.id}"] .hub-gear`);
            if (freshGear) flashBtn(freshGear, cnt ? "✓" : "⚠");
            return;
        }
    });

    positionNumPopup(pop, trigger);
    try { pop.querySelector('[data-pop-field="min"]').focus(); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Global hub settings popup (⚙ in the preset row, v26)
// ---------------------------------------------------------------------------
// Same body-level fixed-popup pattern as the combo / gear popups (immune to
// hub scroll clipping, one global closer pair). The backing state lives in
// global_settings.js - GLOBAL across hubs, persisted in localStorage.

let setPopState = null; // { node, trigger, pop }
let setPopGlobalWired = false;

function closeSettingsPopup() {
    if (!setPopState) return;
    try { setPopState.pop.remove(); } catch (_) {}
    setPopState = null;
}

function ensureSettingsPopupGlobalListeners() {
    if (setPopGlobalWired) return;
    setPopGlobalWired = true;
    document.addEventListener("mousedown", (e) => {
        const st = setPopState;
        if (!st) return;
        try {
            if (st.pop.contains(e.target) || st.trigger.contains(e.target)) return;
        } catch (_) {}
        closeSettingsPopup();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (setPopState && e.key === "Escape") closeSettingsPopup();
    }, true);
}

function openSettingsPopup(node, trigger) {
    // Toggle behavior mirrors the combo / gear triggers.
    if (setPopState?.trigger === trigger) { closeSettingsPopup(); return; }
    closeComboPopup();
    closeNumPopup();
    closeSettingsPopup();

    const pop = document.createElement("div");
    pop.className = "hub-menu hub-set-pop";
    pop.innerHTML =
        `<div class="hub-menu-title">⚙ Hub settings</div>` +
        `<label class="hub-set-row"><span>Mirror update rate</span>` +
        `<select data-set-role="refresh">` +
        REFRESH_CHOICES.map((ms) =>
            `<option value="${ms}">${esc(refreshLabel(ms))}</option>`).join("") +
        `</select></label>` +
        `<div class="hub-pop-hint">How fast mirrors follow values that change WITHOUT events ` +
        `(node scripts, backend updates, onExecuted patches). "Events only" = zero background polling. ` +
        `Global for every hub.</div>`;
    document.body.appendChild(pop);

    setPopState = { node, trigger, pop };
    ensureSettingsPopupGlobalListeners();

    const sel = pop.querySelector('[data-set-role="refresh"]');
    sel.value = String(getRefreshMs());
    if (sel.value !== String(getRefreshMs())) sel.value = "0"; // stale persisted value
    sel.addEventListener("change", () => {
        const applied = setRefreshMs(sel.value);
        sel.value = String(applied);
        trigger.classList.toggle("hub-settings-on", getRefreshMs() > 0);
        flashBtn(trigger, "✓");
    });

    positionNumPopup(pop, trigger);
    try { sel.focus(); } catch (_) {}
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
        // v26: viewer portal rows have NO widget behind them (node-level
        // embed) - only the NODE must resolve, or the row would flash as
        // an orphan on every refresh.
        const isViewerItem = item.type === "widget_portal" && !!item.options?.viewer;
        const { tn, tw } = findTarget(item);

        // Orphan state may appear while values are unchanged.
        if (!tn || (!tw && !isViewerItem)) {
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
                    // v24: keep the full-value tooltip in lockstep as well.
                    const fresh = liveComboValues(item, tw).map(String);
                    control.dataset.sig = fresh.join("¦");
                    const cur = String(tw.value ?? "");
                    const lblEl = control.querySelector(".hub-combo-label");
                    if (lblEl && lblEl.textContent !== cur) lblEl.textContent = cur;
                    const fullTip = `${cur}${cur ? "\n" : ""}Searchable list - filter parts separated by space, all must match, case-insensitive`;
                    if (control.getAttribute("title") !== fullTip) control.setAttribute("title", fullTip);
                    control.classList.toggle("hub-combo-missing", !fresh.includes(cur));
                    break;
                }
                case "text":
                    if (control.value !== String(tw.value)) control.value = String(tw.value ?? "");
                    break;
                default: { // number / range
                    // While the user is editing this control (typing OR mid-
                    // drag), echoes from the target must NOT stomp it: values
                    // would jump AND synth windows would shift under the
                    // pointer. Resync happens right after commit/blur.
                    if (document.activeElement === control) break;
                    const v = coerceNumeric(tw.value, item, tw, tw.value);
                    if (control.dataset.synthRange === "1") {
                        const w = growSynthWindow(control.min, control.max, v);
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
// v25 widget filter (🔍): substring match on custom label / widget name /
// divider titles of the ACTIVE tab. Purely presentational: rows get a
// -hidden class (no innerHTML rebuild - typing keeps focus), the query
// itself lives in the session state (stateMap), NOT in the persisted config.
// While a query is active, drag handles hide too - reordering among
// filtered-out rows would corrupt the saved order.
// ---------------------------------------------------------------------------

function applySearchFilter(node, st) {
    if (!st?.root) return;
    const root = st.root;
    const raw = String(st.searchQuery ?? "");
    const q = raw.trim().toLowerCase();
    root.classList.toggle("hub-searching", !!q);
    const sInp = root.querySelector('[data-role="hub-search"]');
    if (sInp) sInp.classList.toggle("hub-search-active", !!q);
    if (!root.querySelector(".hub-container .hub-item-row")) return;

    const cfg = getHubConfig(node);
    const rows = root.querySelectorAll(".hub-container .hub-item-row");
    let visible = 0;
    for (const row of rows) {
        const item = cfg.items.find((i) => i.id === row.dataset.hubItem);
        const hay = item
            ? `${item.customLabel ?? ""} ${item.type === "divider" ? "" : item.widgetToBind ?? ""}`
            : (row.textContent ?? "");
        const hit = !q || String(hay).toLowerCase().includes(q);
        row.classList.toggle("hub-row-hidden", !hit);
        if (hit) visible++;
    }

    let note = root.querySelector(".hub-search-empty");
    if (q && rows.length && !visible) {
        if (!note) {
            note = document.createElement("div");
            note.className = "hub-search-empty";
            (root.querySelector(".hub-container-inner") ??
                root.querySelector(".hub-container"))?.appendChild(note);
        }
        note.textContent = `No widgets match "${raw.trim()}"`;
    } else {
        note?.remove();
    }
}

// ---------------------------------------------------------------------------
// Main structural render + events
// ---------------------------------------------------------------------------

function renderHub(node) {
    if (!node || node.type !== "SettingsHub") return;
    // DOM widget is hidden while the node is collapsed - EXCEPT when the hub
    // is pinned to the screen: the floating window lives on document.body,
    // independent of canvas visibility, exactly what users asked for.
    {
        let cfgC = null;
        try { cfgC = getHubConfig(node); } catch (_) { /* properties not ready */ }
        if (node.flags?.collapsed && !cfgC?.pinned) return;
    }

    const st = ensureHubDom(node);
    const cfg = getHubConfig(node);
    getActiveTabId(cfg);

    // Self-heal bindings: configs saved by older builds carry wrong values.
    // The live target widget is always authoritative.
    for (const item of cfg.items) {
        if (item.type !== "widget_binding" && item.type !== "widget_portal") continue;
        const { tw } = findTarget(item);
        if (!tw) continue;
        // Slider overrides requested to stick on real nodes: re-push them
        // once per session onto freshly rebuilt widgets (post-reload).
        if (item.type === "widget_binding") maybeReapplySliderOverride(item);
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
        queueRowHtml(cfg) +
        containerHtml(node, cfg) +
        presetRowHtml(cfg);

    // Attach reactive hooks for every rendered binding.
    for (const item of cfg.items) ensureHooksForItem(item);

    // Mount portal embeds (DOM relocation / canvas draw loops).
    Portals.mountPortals(node, st.root);

    // v24 queue bar: paint current server truth immediately after rebuild.
    try { paintQueueBarDom(st.root); } catch (_) {}

    // v25: restore the session search query on the fresh DOM (the innerHTML
    // swap rebuilt the input) and re-apply the row filter.
    try {
        const sInp = st.root.querySelector('[data-role="hub-search"]');
        if (sInp) sInp.value = String(st.searchQuery ?? "");
        applySearchFilter(node, st);
    } catch (_) {}

    // v25: row-chrome visibility (drag handles + remove buttons) via the 👁
    // toggle - a class on the root, CSS does the actual hiding.
    st.root.classList.toggle("hub-chrome-hidden", !!cfg.hideChrome);

    // v26: accent the ⚙ settings trigger while a non-default update rate is
    // active (the background catch-up poller is running).
    st.root.querySelector('[data-action="hub-settings"]')
        ?.classList.toggle("hub-settings-on", getRefreshMs() > 0);

    // v24 screen pinning: restore the floating window whenever the config
    // says pinned (including right after a page reload). If the wrap is
    // already floating but the widget reappeared in node.widgets (a graph
    // reconfigure rebuilt the array), park it out again - the floating
    // element must stay invisible to the DOM-widget manager.
    try {
        if (getHubConfig(node).pinned) {
            if (!isWrapInPanel(st)) floatHub(node);
            else detachHubWidget(node, st);
        }
    } catch (_) {}

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

    let measured = hOf(tabBar) + hOf(root.querySelector(".hub-queue-row")) + hOf(presetRow);

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
    if (!st) return;
    if (node.flags?.collapsed) return;
    // While the hub DOM lives in a floating panel the NODE's slot geometry
    // stays frozen (slim ghost) - layout passes must not fight it.
    if (st.panelBody && st.wrap?.parentElement === st.panelBody) return;
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
            case "queue-run": runQueueFlow(node); break;
            case "queue-clear": clearQueueFlow(node); break;
            case "chrome-toggle":
                cfg.hideChrome = !cfg.hideChrome;
                renderHub(node);
                break;
            case "pin-toggle": toggleHubPinned(node); break;
            case "locate": {
                const row = btn.closest("[data-hub-item]");
                const item = cfg.items.find((i) => i.id === row?.dataset.hubItem);
                if (item) locateItem(item);
                break;
            }
            case "num-settings": {
                openNumPopup(node, btn);
                break;
            }
            case "hub-settings": {
                openSettingsPopup(node, btn);
                break;
            }
            case "unpin": {
                // v25: NO confirmation - the action is one small ✕ click and
                // the parameter stays on its original node, so re-pinning
                // from the node menu trivially undoes it.
                const row = btn.closest("[data-hub-item]");
                const item = cfg.items.find((i) => i.id === row?.dataset.hubItem);
                if (item) {
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
        // Queue count normalizes itself: int, >=1, capped at MAX_QUEUE_BATCH.
        if (e.target.closest?.('[data-role="queue-count"]')) {
            const n = parseQueueCount(e.target.value);
            e.target.value = String(n);
            getHubConfig(node).queueCount = n; // persist immediately
            return;
        }
        const c = e.target.closest("[data-hub-control]");
        if (!c) return;
        if (c.dataset.role === "check") pushControlToTarget(node, c, c.checked);
        else if (c.dataset.role === "number") pushControlToTarget(node, c, c.value, true);
    });
    root.addEventListener("input", (e) => {
        // v25: the compact widget filter streams on every keystroke - it is
        // NOT a data-hub-control and never touches target values.
        if (e.target.closest?.('[data-role="hub-search"]')) {
            const st2 = stateMap.get(node);
            st2.searchQuery = e.target.value;
            applySearchFilter(node, st2);
            return;
        }
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

    // Pinned button rows RUN their source callback on the live node.
    root.addEventListener("click", async (e) => {
        const runBtn = e.target.closest('button[data-role="btn-run"]');
        if (!runBtn || runBtn.disabled) return;
        const row = runBtn.closest("[data-hub-item]");
        const item = getHubConfig(node).items.find(
            (i) => i.id === row?.dataset.hubItem);
        if (!item || item.type !== "widget_binding" || item.widgetType !== "button") return;
        const { tn, tw } = findTarget(item);
        if (!tn || !tw) return; // orphan row - nothing to run
        const res = invokeTargetButton(tn, tw);
        flashBtn(runBtn, res.ok ? "✓" : "⚠");
    });

    // Enter inside the queue count fires the queue right away.
    root.addEventListener("keydown", (e) => {
        // v25: Esc in the widget filter clears it instantly.
        if (e.target.closest?.('[data-role="hub-search"]') && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.target.value = "";
            const st2 = stateMap.get(node);
            st2.searchQuery = "";
            applySearchFilter(node, st2);
            e.target.blur();
            return;
        }
        if (e.key !== "Enter") return;
        if (!e.target.closest?.('[data-role="queue-count"]')) return;
        e.preventDefault();
        e.stopPropagation();
        runQueueFlow(node);
    });
}

// ============================================================================
// Public registration on the module bus
// ============================================================================

registerStructural(renderHub);

registerValues(refreshValuesDom);

// Queue-status engine binding point: by setup() time app.api exists in real
// frontends. Idempotent - safe to retry on every graph (re)configuration.
try {
    app.registerExtension({
        name: "Comfy.SettingsHub.queuestat",
        setup() { try { initQueueStatus(app.api); } catch (_) {} },
        afterConfigureGraph() { try { initQueueStatus(app.api); } catch (_) {} },
    });
} catch (_) { /* duplicate extension name on hot reloads is harmless */ }

export function syncHubNode(node) {
    renderHub(node);
}

/** Test hook: internal per-node renderer state (smoke phases ZF4+). */
export function __hubTestState(node) { return stateMap.get(node) ?? null; }

