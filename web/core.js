import { app } from "../../scripts/app.js";
import { syncNode } from "./sync.js";

export const HUB_NODE_NAME = "SettingsHub";

let idCounter = 0;

export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

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
    return node.properties.hubConfig;
}

export function getActiveTabId(cfg) {
    if (cfg.activeTabId && cfg.tabs.find((t) => t.id === cfg.activeTabId)) {
        return cfg.activeTabId;
    }
    cfg.activeTabId = cfg.tabs?.[0]?.id ?? null;
    return cfg.activeTabId;
}

export function nextOrder(cfg, tabId) {
    let order = 0;
    for (const item of cfg.items) {
        if (item.tabId === tabId) order = Math.max(order, (item.order ?? 0) + 1);
    }
    return order;
}

export function extractComboValues(widget) {
    const opts = widget.options;
    if (!opts) return null;
    let values = opts.values;
    if (typeof values === "function") {
        try { values = values.call(widget); } catch { return null; }
    }
    return Array.isArray(values) ? values.slice() : null;
}

export function detectWidgetType(widget) {
    if (widget.type === "BOOLEAN") return "checkbox";
    if (widget.type === "COMBO") return "combo";
    if (widget.type === "STRING") return "text";
    const opts = widget.options;
    if (opts && (opts.min != null || opts.max != null || opts.step != null)) {
        const step = opts.step ?? 1;
        return step === 1 ? "int" : "slider";
    }
    return "slider";
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
    } else {
        item.targetNodeId = targetNode.id;
        item.widgetToBind = widget.name;
        item.widgetType = detectWidgetType(widget);
        const values = extractComboValues(widget);
        if (values) {
            item.options = { values };
        } else if (widget.options) {
            item.options = {
                min: widget.options.min ?? 0,
                max: widget.options.max ?? 1,
                step: widget.options.step ?? 1,
            };
        } else {
            item.options = {};
        }
    }
    cfg.items.push(item);
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

export function createNewHub() {
    const node = app.graph.addNode({ type: HUB_NODE_NAME });
    getHubConfig(node);
    syncNode(node);
    return node;
}
