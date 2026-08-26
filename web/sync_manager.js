import { app } from "../../scripts/app.js";
import { getHubConfig } from "./core.js";
import { syncNode } from "./sync.js";

export const HUB_NODE_NAME = "SettingsHub";

export function isHubTarget(nodeId) {
    const graph = app.graph ?? app.canvas?.graph;
    for (const hubNode of graph?._nodes ?? []) {
        if (hubNode.type === HUB_NODE_NAME) {
            const cfg = getHubConfig(hubNode);
            for (const item of cfg.items) {
                if (item.targetNodeId === nodeId) return true;
            }
        }
    }
    return false;
}

export function syncAll() {
    const graph = app.graph ?? app.canvas?.graph;
    for (const node of graph?._nodes ?? []) {
        if (node.type === HUB_NODE_NAME) {
            syncNode(node);
        }
    }
}

function syncHubWidgetValues() {
    for (const hubNode of app.graph?._nodes ?? []) {
        if (hubNode.type !== HUB_NODE_NAME) continue;
        const cfg = getHubConfig(hubNode);
        for (const hubWidget of hubNode.widgets ?? []) {
            if (!hubWidget.name?.startsWith("__hub_item_")) continue;
            const itemId = hubWidget.name.replace("__hub_item_", "");
            const item = cfg.items.find((i) => i.id === itemId);
            if (!item || item.type !== "widget_binding") continue;
            const targetNode = app.graph.getNodeById(item.targetNodeId);
            const targetWidget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
            if (targetWidget && hubWidget.value !== targetWidget.value) {
                hubWidget.value = targetWidget.value;
                hubNode.setDirtyCanvas(true, true);
            }
        }
    }
}

function startSyncLoop() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
        syncHubWidgetValues();
    }, 300);
}

let syncTimer = null;
app.registerExtension({
    name: "Comfy.SettingsHub.sync",
    "setup"() {
        syncAll();
        startSyncLoop();
    },
    "afterConfigureGraph"() {
        syncAll();
    },
});
