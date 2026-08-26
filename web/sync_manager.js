import { app } from "../../scripts/app.js";
import { getHubConfig } from "./core.js";
import { syncNode } from "./sync.js";

export const HUB_NODE_NAME = "SettingsHub";

export function isHubTarget(nodeId) {
    for (const hubNode of app.graph._nodes ?? []) {
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
    for (const node of app.graph._nodes ?? []) {
        if (node.type === HUB_NODE_NAME) {
            syncNode(node);
        }
    }
}

app.registerExtension({
    name: "Comfy.SettingsHub.sync",
    "graphToCanvas.post"(graph) {
        for (const node of graph._nodes ?? []) {
            if (node.type === HUB_NODE_NAME) {
                syncNode(node);
            }
        }
    },
});
