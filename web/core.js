import { app } from "../../scripts/app.js";
import { syncNode } from "./sync.js";
import * as Pins from "./pins.js";

export const HUB_NODE_NAME = "SettingsHub";

let idCounter = 0;

export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
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
        typeof widget?.value === "number";
    if (!numericHints) return "portal"; // unknown/custom -> live portal embed

    const stepRaw = opts.step != null ? Number(opts.step) : NaN;
    const step = Number.isFinite(stepRaw) ? Math.abs(stepRaw) : NaN;

    let intLike = type.includes("int");
    if (!Number.isFinite(step) || step >= 1) {
        // Integer unless something explicitly says "float"/"slider".
        intLike = !type.includes("float") && !type.includes("slider");
    }
    return intLike ? "int" : "slider";
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
 * to the snapshot stored in the binding item, then to sane derived defaults.
 */
export function numericMerge(item, targetWidget) {
    const live = targetWidget?.options || {};
    const snap = item?.options || {};
    let min = pickNum(live.min, snap.min, 0);
    let max = pickNum(live.max, snap.max, 1);
    if (!(max > min)) { max = min + 1; }

    const range = max - min;
    const fallbackStep = range <= 1 ? 0.01 : Math.max(range / 200, 0.01);
    let step = pickNum(live.step, snap.step, fallbackStep);
    if (!(step > 0)) step = fallbackStep;
    if (step > range) step = range / 100 || 0.01;

    return { min, max, step, decimals: stepDecimals(item?.widgetType === "int" ? 1 : step) };
}

/** Coerce any incoming value into a valid number clamped to merged options. */
export function coerceNumeric(value, item, targetWidget, prevValue) {
    const o = numericMerge(item, targetWidget);
    let n = Number(typeof value === "number" ? value : parseFloat(String(value)));
    if (!Number.isFinite(n)) n = Number(prevValue);
    if (!Number.isFinite(n)) n = o.min;
    n = Math.min(o.max, Math.max(o.min, n));
    if (item?.widgetType === "int") n = Math.round(n);
    else n = Number(n.toFixed(o.decimals));
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

export function createNewHub() {
    const graph = getRootGraph();
    if (!graph) {
        alert("Create New Settings Hub: no graph available");
        return null;
    }
    let node = null;
    try {
        if (typeof graph.addNode === "function") node = graph.addNode({ type: HUB_NODE_NAME });
        else node = graph.add({ type: HUB_NODE_NAME });
    } catch (err) {
        console.warn("Create New Settings Hub failed:", err);
    }
    if (!node) return null;
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
    return node;
}
