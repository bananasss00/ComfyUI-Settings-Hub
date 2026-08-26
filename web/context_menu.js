import { app } from "../../scripts/app.js";
import { getHubConfig, getActiveTabId, createBinding, createNewHub, HUB_NODE_NAME } from "./core.js";

export function attachContextMenu() {
    app.registerExtension({
        name: "Comfy.SettingsHub.context",
        "getNodeMenuItems"(node) {
            // Resolve the widget under the cursor for pinning.
            const canvas = app.canvas;
            const widget = node.getWidgetOnPos?.(canvas.graph_mouse[0], canvas.graph_mouse[1], true);
            if (!widget) return [];

            const graph = node.graph || app.graph;
            const hubCount = graph._nodes?.filter((n) => n.type === HUB_NODE_NAME).length ?? 0;
            if (!hubCount) return [];

            return [
                null,
                {
                    content: "📌 Pin to Settings Hub",
                    has_submenu: true,
                    submenu: {
                        options: buildPinSubmenu(node, widget, graph),
                    },
                },
            ];
        },
    });
}

function buildPinSubmenu(node, widget, graph) {
    const entries = [];

    for (const hubNode of graph._nodes ?? []) {
        if (hubNode.type !== HUB_NODE_NAME) continue;
        const cfg = getHubConfig(hubNode);
        const tabSub = [];
        for (const tab of cfg.tabs) {
            tabSub.push({
                content: tab.name,
                callback: () => {
                    createBinding(hubNode, node, widget, tab.id);
                },
            });
        }
        tabSub.push(null);
        tabSub.push({
            content: "➕ Add to New Tab",
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    createBinding(hubNode, node, widget, tabId);
                }
            },
        });
        entries.push({
            content: hubNode.title || "Settings Hub",
            has_submenu: true,
            submenu: { options: tabSub },
        });
    }

    if (entries.length === 0) {
        entries.push({
            content: "➕ Create New Settings Hub",
            callback: () => {
                const newHub = createNewHub();
                createBinding(newHub, node, widget, getActiveTabId(getHubConfig(newHub)));
            },
        });
    }

    return entries;
}
