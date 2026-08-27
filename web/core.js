import { app } from "../../scripts/app.js";
import { syncNode } from "./sync.js";
import * as Pins from "./pins.js";

export const HUB_NODE_NAME = "SettingsHub";

let idCounter = 0;

export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Global hub registry (cross-graph discovery)
// ---------------------------------------------------------------------------
// ComfyUI subgraphs make `node.graph`/`app.graph` graph-local: a hub living
// on the ROOT canvas is invisible to menu code running while the user is
// INSIDE a subgraph ("only Create New is offered"). All hubs are created on
// the root graph anyway, so discovery must be GRAPH-INDEPENDENT. We keep our
// own registry - nodeCreated tracks, onRemoved forgets - and everything that
// enumerates hubs reads from it instead of scanning one graph's _nodes.

const hubRegistry = new Set();

/** Called from the extension's nodeCreated hook for EVERY hub instance. */
export function trackHubNode(node) {
    if (node?.type === HUB_NODE_NAME) hubRegistry.add(node);
}

/** Called from the hub class onRemoved hook. */
export function forgetHubNode(node) {
    if (node) hubRegistry.delete(node);
}

/** Live hubs across ALL graphs, in stable insertion order.
 *
 *  The registry is the primary source, but it can be COLD through no fault
 *  of the user: extension nodeCreated may have been missed entirely on exotic
 *  load paths (stale-cached chunks mixing versions, hot-swapped bundles,
 *  loader races during configureGraph). A hub sitting right there on the
 *  canvas MUST never vanish from pin menus just because our bookkeeping
 *  missed it - so when the registry comes up empty we fall back to a live
 *  scan over every graph we can reach. Cheap (only when empty) and always
 *  truthful. */
export function allHubs() {
    const found = [...hubRegistry].filter((n) => n?.type === HUB_NODE_NAME);
    if (found.length) return found;
    try {
        for (const g of allGraphs()) {
            for (const n of g?._nodes ?? []) {
                if (n?.type === HUB_NODE_NAME && !found.includes(n)) found.push(n);
            }
        }
    } catch (_) { /* enumeration must never kill a menu build */ }
    return found;
}

// ---------------------------------------------------------------------------
// Cross-graph traversal + node lookup
// ---------------------------------------------------------------------------
// Pinned targets may live INSIDE any subgraph while the hub sits on the root
// canvas (that is the whole point of the global registry above). app.graph
// lookups only see the ROOT graph, so every target resolution goes through
// the helpers below instead of raw getNodeById.

/**
 * Every LGraph-like object reachable right now: the root graph, whatever
 * graph the canvas is showing, plus any nested subgraph objects duck-typed
 * off the nodes. Defensive throughout - field names differ between frontend
 * generations, and an exotic node getter must never break enumeration.
 */
export function allGraphs(maxDepth = 6) {
    const seen = new Set();
    const out = [];
    const queue = [];

    const push = (g) => {
        if (g && typeof g === "object" && !seen.has(g)) {
            seen.add(g);
            out.push(g);
            queue.push(g);
        }
    };

    try { push(app.graph); } catch (_) {}
    try { push(app.canvas?.graph); } catch (_) {}
    try { push(window.comfyAPI?.app?.graph); } catch (_) {}

    for (let i = 0; i < queue.length && i < maxDepth * 64; i++) {
        const g = queue[i];
        for (const n of g?._nodes ?? []) {
            try { push(n.subgraph); } catch (_) {}      // SubgraphNode holder
            if (Array.isArray(n.subgraphs)) {
                for (const s of n.subgraphs) { try { push(s); } catch (_) {} }
            }
        }
        if (Array.isArray(g?._subgraphs)) {
            for (const s of g._subgraphs) { try { push(s); } catch (_) {} }
        }
        if (--maxDepth <= 0) break;
    }
    return out;
}

/** Node by numeric id across root graph AND every reachable subgraph. */
export function findNodeByIdEverywhere(id) {
    try {
        const local = app.graph?.getNodeById?.(id);
        if (local) return local;
    } catch (_) {}
    for (const g of allGraphs()) {
        const hit = (g?._nodes ?? []).find((n) => n.id === id);
        if (hit) return hit;
    }
    return null;
}

/**
 * Resolve the live target node behind a binding ITEM.
 * Pass 1: stored node id, searched everywhere (the common case).
 * Pass 2 (drift repair): if the id died (reloads renumber nodes under some
 * frontends) fall back to the persisted source TITLE + widget-name pair -
 * far better than orphaning a perfectly good pin. "targetTitle" is written
 * by createBinding/createPortalBinding; older configs simply skip this.
 */
export function resolveBindingTarget(item) {
    let tn = findNodeByIdEverywhere(item?.targetNodeId);
    if (tn) return tn;
    const wantTitle = item?.targetTitle != null ? String(item.targetTitle) : "";
    if (!wantTitle) return null;
    for (const g of allGraphs()) {
        const hit = (g?._nodes ?? []).find((n) =>
            String(n.title ?? "") === wantTitle &&
            (!item.widgetToBind ||
             n.widgets?.some((w) => w.name === item.widgetToBind)));
        if (hit) return hit;
    }
    return null;
}

/**
 * Chain of SubgraphNode holders leading from the root graph DOWN TO the graph
 * that directly contains `targetNode` (outermost holder FIRST, immediate
 * parent LAST). Empty array = node lives on a root canvas - nothing to enter.
 * null = owner graph unreachable through known holder fields.
 *
 * Locate navigation uses this to hop INTO nested subgraphs instead of just
 * panning the wrong canvas.
 */
export function findHolderChainOf(targetNode) {
    if (!targetNode || typeof targetNode !== "object") return null;
    const chains = new Map();   // graph -> holders[] to reach it
    const seen = new Set();
    const queue = [];

    const seed = (g) => {
        if (g && typeof g === "object" && !seen.has(g)) {
            seen.add(g);
            chains.set(g, []);
            queue.push(g);
        }
    };
    try { seed(app.graph); } catch (_) {}
    try { seed(app.canvas?.graph); } catch (_) {}
    try { seed(window.comfyAPI?.app?.graph); } catch (_) {}

    for (let qi = 0; qi < queue.length; qi++) {
        const g = queue[qi];
        const path = chains.get(g) ?? [];
        for (const n of g?._nodes ?? []) {
            if (n === targetNode) return [...path];
            try {
                if (n.subgraph && !seen.has(n.subgraph)) {
                    seen.add(n.subgraph);
                    chains.set(n.subgraph, [...path, n]);
                    queue.push(n.subgraph);
                }
            } catch (_) {}
            if (Array.isArray(n.subgraphs)) {
                for (const s of n.subgraphs) {
                    if (s && typeof s === "object" && !seen.has(s)) {
                        seen.add(s);
                        chains.set(s, [...path, n]);
                        queue.push(s);
                    }
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Config access / migration
// ---------------------------------------------------------------------------

export function getHubConfig(node) {
    if (!node.properties.hubConfig) {
        node.properties.hubConfig = {
            version: 1,
            activeTabId: "tab_default",
            tabs: [{ id: "tab_default", name: "General", order: 0 }],
            items: [],
            presets: {},
        };
    }
    const cfg = node.properties.hubConfig;
    if (!Array.isArray(cfg.tabs)) cfg.tabs = [];
    if (!Array.isArray(cfg.items)) cfg.items = [];
    if (!cfg.presets || typeof cfg.presets !== "object") cfg.presets = {};
    return cfg;
}

export function getActiveTabId(cfg) {
    if (cfg.activeTabId && cfg.tabs.find((t) => t.id === cfg.activeTabId)) {
        return cfg.activeTabId;
    }
    cfg.activeTabId = cfg.tabs?.[0]?.id ?? null;
    return cfg.activeTabId;
}

export function sortedTabs(cfg) {
    return [...cfg.tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function itemsOfTab(cfg, tabId) {
    return cfg.items
        .filter((i) => i.tabId === tabId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function nextOrder(cfg, tabId) {
    let order = 0;
    for (const item of cfg.items) {
        if (item.tabId === tabId) order = Math.max(order, (item.order ?? 0) + 1);
    }
    return order;
}

export function setOrders(items) {
    items.forEach((item, i) => { item.order = i; });
}

// ---------------------------------------------------------------------------
// Widget type detection (PROBLEM #1 FIX)
// ---------------------------------------------------------------------------
// LiteGraph / ComfyUI widget types come in every casing ("combo", "COMBO",
// "toggle", "customtext", ...) and some widget factories never fill `type`
// at all. Detection therefore relies on runtime facts first
// (options.values, typeof value) and only then on the lowercased type tag.

export function extractComboValues(widget) {
    const opts = widget?.options;
    if (!opts) return null;
    let values = opts.values;
    if (typeof values === "function") {
        try { values = values.call(widget); } catch { return null; }
    }
    if (!Array.isArray(values)) return null;
    // Stringify primitives so <option> comparisons stay consistent.
    return values.map((v) => (typeof v === "object" && v !== null ? v : String(v)));
}

const COMBO_TYPES = new Set(["combo", "combobox", "dropdown", "enum"]);
const BOOL_TYPES = new Set(["toggle", "boolean", "checkbox"]);
const TEXT_TYPES = new Set([
    "text", "string", "customtext", "textarea", "multiline",
]);

/**
 * True when the widget is a multiline text editor. ComfyUI expresses this in
 * two different ways depending on widget vintage:
 *   - options.multiline === true (canvas customtext widgets)
 *   - the widget itself carries a real <textarea> DOM element
 *     (DOM-based prompt widgets) - no flag at all.
 */
export function isMultilineWidget(widget) {
    if (!widget) return false;
    if (widget.options?.multiline === true) return true;
    const el = widget.element ?? widget.inputEl ?? widget.contentEl;
    return !!(el && el.tagName === "TEXTAREA");
}

export function detectWidgetType(widget) {
    const rawType = widget?.type;
    const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
    const opts = widget?.options || {};

    // 1) Combo wins first: anything carrying a values list IS a combo,
    //    regardless of its declared type. This is what used to fall through
    //    to the slider branch and produce NaN.
    const hasValues =
        Array.isArray(opts.values) ||
        typeof opts.values === "function";
    if (hasValues || COMBO_TYPES.has(type)) return "combo";

    // 2) Booleans / toggles.
    if (BOOL_TYPES.has(type) || typeof widget?.value === "boolean") return "checkbox";

    // 2.5) Real DOM panel containers (addDOMWidget-based custom UIs).
    //      Their serialized value is OPAQUE application state ("[]" stacks,
    //      objects...) - never mirror it into a primitive editor just
    //      because the value happens to be a string. The LTX / MiniMax H3
    //      "LoRA Loader Stack" lives entirely inside one such container and
    //      used to render as a bare text field bound to its JSON blob.
    //      Guards: a real <textarea> prompt stays a multiline mirror, and
    //      widgets that DECLARE a primitive shape (values list, min/max/
    //      step, numeric family types, plain text inputs) keep their old
    //      classifications even when they carry an element.
    const panelEl = widget?.element ?? widget?.contentEl ?? null;
    const declaresPrimitiveShape =
        opts.min != null ||
        opts.max != null ||
        opts.step != null ||
        type.includes("number") ||
        type.includes("slider") ||
        type.includes("int") ||
        type.includes("float");
    if (
        panelEl &&
        typeof panelEl.querySelector === "function" &&
        !isMultilineWidget(widget) &&
        !declaresPrimitiveShape &&
        !COMBO_TYPES.has(type) &&
        !BOOL_TYPES.has(type) &&
        !TEXT_TYPES.has(type)
    ) {
        return "portal";
    }

    // 3) Strings and prompt boxes.
    const declaresText =
        TEXT_TYPES.has(type) ||
        opts.multiline === true ||
        typeof opts.placeholder === "string";
    if (declaresText || typeof widget?.value === "string") return "text";

    // 4) Numeric family.
    const numericHints =
        type.includes("number") ||
        type.includes("slider") ||
        type.includes("float") ||
        type.includes("int") ||
        opts.min != null ||
        opts.max != null ||
        opts.step != null ||
        opts.precision != null ||
        opts.round != null ||
        typeof widget?.value === "number";
    if (!numericHints) return "portal"; // unknown/custom -> live portal embed

    const stepRaw = opts.step != null ? Number(opts.step) : NaN;
    const step = Number.isFinite(stepRaw) ? Math.abs(stepRaw) : NaN;

    // Modern frontends describe floats via options.precision (decimal digits)
    // or options.round instead of step; a missing step must NOT silently
    // degrade such widgets to ints.
    const precision = opts.precision != null ? Number(opts.precision) : NaN;
    const roundV = opts.round != null ? Number(opts.round) : NaN;
    const wholeStep = Number.isFinite(step) ? step >= 1 : null;

    const suggestsInt = type.includes("int") || wholeStep === true;
    const suggestsFloat =
        type.includes("float") ||
        type.includes("slider") ||
        precision > 0 ||
        (Number.isFinite(roundV) && roundV > 0 && roundV < 1);

    if (suggestsInt && !suggestsFloat) return "int";
    if (suggestsFloat) return "slider";

    // No declarations at all: fall back to how the CURRENT value looks.
    const v = Number(widget?.value);
    return Number.isFinite(v) ? (Number.isInteger(v) ? "int" : "slider") : "int";
}

// ---------------------------------------------------------------------------
// Live numeric options merge (target widget options win over snapshot)
// ---------------------------------------------------------------------------

function pickNum(...candidates) {
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
}

export function stepDecimals(step) {
    if (!(step > 0)) return 2;
    if (step >= 1) return 0;
    const s = String(step);
    const i = s.indexOf(".");
    return i < 0 ? 2 : Math.min(4, s.length - i - 1);
}

/**
 * Merge numeric options: prefer the live target widget's options, fall back
 * to the snapshot stored in the binding item, then to derived defaults.
 *
 * The mirror must be FAITHFUL: whatever step/min/max the source declares is
 * what the mirror uses - no invented walls (the old code clamped everything
 * into an implicit [0..1]), no ×10 mangled steps. A side with NO declared
 * bound stays open-ended: min/max come out as ±Infinity so the renderer can
 * omit the attribute and coercion skips that clamp.
 *
 * Step resolution order: declared step -> round -> precision-derived
 * (10^-digits) -> range-based fallback. The merged snapshot is also written
 * back into item.options (self-heal) so orphaned rows keep real geometry.
 */
export function numericMerge(item, targetWidget) {
    const live = targetWidget?.options || {};
    const snap = item?.options || {};

    let min = pickNum(live.min, snap.min, NaN);
    let max = pickNum(live.max, snap.max, NaN);
    if (Number.isFinite(min) && Number.isFinite(max) && !(max > min)) {
        max = min + Math.abs(min || 1); // degenerate equal bounds - keep them usable
    }

    const declaredStep = pickNum(live.step, snap.step, NaN);
    const rangeKnown = Number.isFinite(min) && Number.isFinite(max);
    const range = rangeKnown ? max - min : NaN;
    const fallbackStep = rangeKnown
        ? (range <= 1 ? 0.01 : Math.max(range / 200, 0.01))
        : 0.01;

    let step = declaredStep;
    if (!(step > 0) && optsHas(live, snap, "round")) step = pickNum(live.round, snap.round, NaN);
    if (!(step > 0) && optsHas(live, snap, "precision")) {
        const p = pickNum(live.precision, snap.precision, NaN);
        if (p >= 0) step = Math.pow(10, -Math.min(p, 6));
    }
    if (!(step > 0)) step = fallbackStep;
    // Never override a DECLARED step with range math; only the synthetic
    // fallback may adapt itself to a tiny range.
    if (!(declaredStep > 0) && rangeKnown && step > range) step = range / 100 || 0.01;

    // Self-heal the persisted snapshot so pins survive orphaning.
    try {
        if (item && typeof item === "object") {
            const so = (item.options && typeof item.options === "object")
                ? item.options : (item.options = {});
            if (so.min !== min && Number.isFinite(min)) so.min = min;
            if (so.max !== max && Number.isFinite(max)) so.max = max;
            if (so.step !== step && step > 0) so.step = step;
        }
    } catch (_) { /* frozen configs must not break rendering */ }

    return { min, max, step, decimals: stepDecimals(item?.widgetType === "int" ? 1 : step) };
}

function optsHas(a, b, key) {
    return a?.[key] != null || b?.[key] != null;
}

/**
 * Display window for the nudge-slider when the source widget declares NO
 * finite bounds (PrimitiveFloat et al: min/max are effectively ±infinity).
 * Mirrors never invent REAL walls - typed input stays unrestricted and
 * coercion ignores these numbers (only DECLARED bounds clamp). Initial
 * render centers the window on the current value; afterwards the window is
 * managed by growSynthWindow (sticky one-sided growth, no re-centering).
 */
export function synthSliderWindow(value) {
    const v = Number.isFinite(Number(value)) ? Number(value) : 0;
    const span = Math.max(Math.abs(v), 1);
    return { min: v - span, max: v + span };
}

/**
 * STICKY growth for an EXISTING adaptive window. v1.19 re-centered the
 * window on every commit, which kept snapping the thumb back to the visual
 * midpoint ("слайдер всегда по центру" field report) and shifted the scale
 * mid-gesture. New contract: initial render centers ONCE; afterwards the
 * window only EXPANDS on the side the value escapes to - the rest of the
 * scale (and the thumb's meaning) stays put, exactly like a declared
 * static slider behaves.
 */
export function growSynthWindow(min, max, value) {
    let lo = Number.isFinite(Number(min)) ? Number(min) : NaN;
    let hi = Number.isFinite(Number(max)) ? Number(max) : NaN;
    const n = Number(value);
    const v = Number.isFinite(n) ? n : null;

    // Degenerate seed -> synthesize a sane bracket around the value.
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) {
        const s = Math.max(Math.abs(v ?? 0), 1);
        return { min: (v ?? 0) - s, max: (v ?? 0) + s };
    }

    const eps = (hi - lo) * 0.02; // tiny inset so the thumb never hugs dead stop
    if (v !== null && v < lo) lo = v - eps;
    else if (v !== null && v > hi) hi = v + eps;
    return { min: lo, max: hi };
}

/**
 * Coerce any incoming value into a number against the REAL merged options.
 * quantize=false is used for MANUAL typed commits: values keep their exact
 * decimals (no step-grid snapping) and are only kept inside DECLARED bounds;
 * open-ended sides pass through untouched. Accepts comma decimals (ru).
 */
export function coerceNumeric(value, item, targetWidget, prevValue, opts = {}) {
    const o = numericMerge(item, targetWidget);
    const rawStr = typeof value === "string" && value.includes(",")
        ? value.replace(/\s/g, "").replace(",", ".")
        : value;
    let n = Number(typeof rawStr === "number" ? rawStr : parseFloat(String(rawStr)));
    if (!Number.isFinite(n)) n = Number(prevValue);
    if (!Number.isFinite(n)) n = Number.isFinite(o.min) ? o.min : 0;
    if (Number.isFinite(o.min)) n = Math.max(o.min, n);
    if (Number.isFinite(o.max)) n = Math.min(o.max, n);
    if (item?.widgetType === "int") n = Math.round(n);
    else if (opts.quantize !== false) n = Number(n.toFixed(o.decimals));
    else n = Number(n.toPrecision(10)); // strip float noise, keep user digits
    return n;
}

/** Fetch fresh combo values from the live widget, falling back to snapshot. */
export function liveComboValues(item, targetWidget) {
    const fresh = targetWidget ? extractComboValues(targetWidget) : null;
    if (fresh && fresh.length) return fresh;
    const snap = Array.isArray(item?.options?.values)
        ? item.options.values.map((v) => String(v))
        : [];
    return snap;
}

// ---------------------------------------------------------------------------
// Binding lifecycle
// ---------------------------------------------------------------------------

/**
 * True when the widget cannot be mirrored as a primitive control and must be
 * embedded as a live portal instead. Universal rule - no per-node code:
 * anything that is not combo/toggle/text/number and whose value is not a
 * primitive (rgthree Power Lora Loader lists, image pickers, custom panels)
 * qualifies.
 */
export function isPortalWidget(widget) {
    return detectWidgetType(widget) === "portal";
}

/** Portal embed flavor: real DOM element (relocate) vs canvas-drawn. */
export function portalKindOf(widget) {
    const el = widget?.element ?? widget?.inputEl ?? widget?.contentEl;
    return el && typeof el.appendChild === "function" ? "dom" : "canvas";
}

// ---------------------------------------------------------------------------
// Group portals ("whole panel" embeds)
// ---------------------------------------------------------------------------
// Custom panels are often drawn by SEVERAL sibling widgets on one node
// (rgthree Power Lora Loader: a header widget, one widget per lora row, a
// divider). Pinning them individually reproduces fragments only - users want
// THE PANEL. A group portal binds all portal-classified widgets of a node
// into ONE item whose members are stacked onto a shared canvas, mirroring
// how the node itself stacks them vertically. Still fully universal.

/** Vertical breathing room LiteGraph leaves between stacked widget rows. */
export const PORTAL_ROW_GAP = 4;

/** Best-effort current painted height of a widget row, in px. */
export function widgetNativeHeight(widget, fallback = 30) {
    let h = Number(widget?.height);
    if (!Number.isFinite(h) || h <= 0) {
        try { h = Number(widget?.computeSize?.()?.[1]); } catch (_) { h = NaN; }
    }
    if (!Number.isFinite(h) || h <= 0) h = Number(widget?.options?.height);
    if (!Number.isFinite(h) || h <= 0) h = Number(fallback);
    return Number.isFinite(h) && h > 0 ? h : 30;
}

/**
 * Bind SEVERAL portal widgets of one node as a single live embed.
 * members[] persists name+height so reloads survive; live geometry is still
 * re-read every frame by the portal renderer (rows grow/shrink dynamically).
 */
export function createPortalBinding(node, targetNode, widgets, tabId, label) {
    const cfg = getHubConfig(node);
    const list = (Array.isArray(widgets) ? widgets : [widgets]).filter(Boolean);
    if (!list.length) return null;

    const primary = list[0];
    const item = {
        id: genId("item"),
        type: "widget_portal",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: label || primary.label || primary.name || targetNode?.title || "panel",
        targetNodeId: targetNode.id,
        targetTitle: targetNode?.title ?? "",  // drift repair anchor (see resolveBindingTarget)
        widgetToBind: primary.name ?? "",
        widgetType: "portal",
        members: list.map((w) => ({
            name: w.name ?? "",
            srcH: Math.round(widgetNativeHeight(w)),
        })),
    };
    const totalH =
        item.members.reduce((acc, m) => acc + m.srcH, 0) +
        PORTAL_ROW_GAP * (item.members.length - 1);
    item.options = { portalKind: "canvas", srcH: totalH };
    if (list.length > 1) item.options.grouped = true;

    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

export function createBinding(node, targetNode, widget, tabId, type, extra) {
    const cfg = getHubConfig(node);
    const item = {
        id: genId("item"),
        type: type || "widget_binding",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: "",
    };
    if (type === "divider") {
        item.customLabel = extra?.label || "Section";
    } else if (isPortalWidget(widget)) {
        // Custom widget (custom panel, lora list, ...): live embed instead of
        // a value mirror. Presets deliberately do NOT cover portals - there
        // is no universal way to write complex widget states back.
        item.type = "widget_portal";
        item.targetNodeId = targetNode.id;
        item.widgetToBind = widget.name;
        item.widgetType = "portal";
        item.customLabel = extra?.label || widget.label || widget.name || "panel";
        let srcH = Number(widget.height ?? widget.options?.height);
        if (!Number.isFinite(srcH) || srcH <= 0) srcH = 60;
        item.options = { portalKind: portalKindOf(widget), srcH: Math.round(srcH) };
    } else {
        item.targetNodeId = targetNode.id;
        item.targetTitle = targetNode?.title ?? ""; // drift repair anchor
        item.widgetToBind = widget.name;
        item.widgetType = detectWidgetType(widget);           // fixed detection
        item.customLabel = extra?.label || widget.label || widget.name || "";
        const values = extractComboValues(widget);
        if (values) {
            item.options = { values };
        } else if (widget.options && (widget.options.min != null || widget.options.max != null)) {
            item.options = {
                min: widget.options.min,
                max: widget.options.max,
                step: widget.options.step,
            };
        } else {
            // Text-family binding: remember multiline so the hub renders a
            // growing <textarea> instead of a single-line input.
            item.options = isMultilineWidget(widget) ? { multiline: true } : {};
        }
    }
    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

/** Remove an item (binding or divider) from hub config with pin invalidation. */
export function removeItem(node, item) {
    const cfg = getHubConfig(node);
    const idx = cfg.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) cfg.items.splice(idx, 1);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
}

// ---------------------------------------------------------------------------
// Hub creation helper (context menu -> Create New Settings Hub)
// ---------------------------------------------------------------------------

function getRootGraph() {
    const candidates = [];
    try {
        if (app && app.graph && typeof app.graph.add === "function") candidates.push(app.graph);
        if (app && app.canvas && app.canvas.graph) candidates.push(app.canvas.graph);
    } catch (_) {}
    try {
        const store = window.comfyAPI && window.comfyAPI.app;
        if (store && store.graph) candidates.push(store.graph);
    } catch (_) {}
    for (const g of candidates) {
        if (g && (typeof g.add === "function" || typeof g.addNode === "function")) return g;
    }
    return null;
}

/**
 * Create a hub node on the ROOT graph - the CANONICAL way.
 *
 * History: we used to call graph.addNode({ type }) with a plain CONFIG
 * OBJECT. Legacy builds tolerated it; the modern ComfyUI frontend's
 * LGraph.add() dereferences real-node methods on the argument and dies with
 * "TypeError: e.snapToGrid is not a function", leaving NOTHING behind.
 * The only correct sequence is LiteGraph.createNode(type) -> graph.add(
 * INSTANCE): the instance is a true LGraphNode subclass, so every graph
 * bookkeeping path works exactly like a manual drag-in.
 */
export function createNewHub() {
    const graph = getRootGraph();
    if (!graph) {
        alert("Create New Settings Hub: no graph available");
        return null;
    }

    let node = null;
    try {
        const LG = window.LiteGraph;
        if (LG && typeof LG.createNode === "function") {
            node = LG.createNode(HUB_NODE_NAME);
        }
    } catch (_) { /* fall through to the ctor fallback */ }

    if (!node) {
        try {
            const Ctor = window.LiteGraph?.registered_node_types?.[HUB_NODE_NAME];
            if (Ctor) node = new Ctor();
        } catch (err) {
            console.warn("Create New Settings Hub failed:", err);
        }
    }

    if (!node) {
        console.warn("Create New Settings Hub: node type not registered yet");
        alert("Settings Hub node type is still loading - try again in a second.");
        return null;
    }

    try {
        graph.add(node);   // real instance - NEVER a bare {type} config object
    } catch (err) {
        console.warn("Create New Settings Hub failed:", err);
        alert("Could not add the Settings Hub node to the canvas:\n" + err?.message);
        return null;
    }
    node.title = "Settings Hub";
    try {
        const canvas = app.canvas;
        const pos = (canvas && canvas.graph_mouse) || (app.graph && app.graph.pos);
        if (pos && pos.length >= 2) {
            node.pos = [pos[0] + 40, pos[1] + 40];
        }
    } catch (_) {}
    getHubConfig(node);
    Pins.invalidatePins();
    syncNode(node);
    // Registry safety net: normally extension nodeCreated does this during
    // graph.add - but programmatic adds must never depend on that dispatch.
    try { trackHubNode(node); } catch (_) {}
    return node;
}
