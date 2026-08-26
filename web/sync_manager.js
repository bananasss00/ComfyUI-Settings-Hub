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

app.registerExtension({
    name: "Comfy.SettingsHub.sync",
    "setup"() {
        syncAll();
    },
    "afterConfigureGraph"() {
        syncAll();
    },
});
