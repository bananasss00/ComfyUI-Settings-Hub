import { app } from "../../scripts/app.js";
import { getHubConfig, getActiveTabId } from "./core.js";
import { syncNode } from "./sync.js";

export function presetSave(node) {
    const cfg = getHubConfig(node);
    const name = prompt("Preset name:");
    if (name === null) return;
    cfg.presets = cfg.presets || {};
    cfg.presets[name] = {};
    const activeTabId = getActiveTabId(cfg);
    for (const item of cfg.items) {
        if (item.tabId !== activeTabId || item.type !== "widget_binding") continue;
        const targetNode = app.graph.getNodeById(item.targetNodeId);
        const widget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
        if (widget) {
            cfg.presets[name][item.id] = widget.value;
        }
    }
    syncNode(node);
    node.setDirtyCanvas(true, true);
}

export function presetNew(node) {
    presetSave(node);
}

export function presetDelete(node) {
    const cfg = getHubConfig(node);
    const names = Object.keys(cfg.presets || {});
    if (!names.length) return;
    const name = prompt("Delete preset name:");
    if (name !== null && cfg.presets[name] !== undefined) {
        delete cfg.presets[name];
        syncNode(node);
        node.setDirtyCanvas(true, true);
    }
}

export function presetApply(node, presetName) {
    if (!presetName) return;
    const cfg = getHubConfig(node);
    const preset = cfg.presets?.[presetName];
    if (!preset) return;
    for (const [itemId, value] of Object.entries(preset)) {
        const item = cfg.items.find((i) => i.id === itemId);
        if (!item || item.type !== "widget_binding") continue;
        const targetNode = app.graph.getNodeById(item.targetNodeId);
        const widget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
        if (widget) {
            widget.value = value;
            if (widget.callback) {
                try { widget.callback(value); } catch {}
            }
        }
    }
    node.graph.setDirtyCanvas(true, true);
    syncNode(node);
}
