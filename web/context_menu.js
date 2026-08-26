import { app } from "../../scripts/app.js";
import { getHubConfig, getActiveTabId, createBinding, createNewHub, HUB_NODE_NAME } from "./core.js";

export function attachContextMenu() {
    app.registerExtension({
        name: "Comfy.SettingsHub.context",
        "getNodeMenuItems"(node) {
            if (!node || node.type === HUB_NODE_NAME) return [];
            if (!node.widgets?.length) return [];

            // Widget under the cursor, or the last widget when right-clicking
            // the node body.
            const canvas = app.canvas;
            let widget = null;
            try {
                widget = node.getWidgetOnPos?.(canvas?.graph_mouse?.[0], canvas?.graph_mouse?.[1], true) ||
                    node.widgets[node.widgets.length - 1];
            } catch {
                widget = node.widgets[node.widgets.length - 1];
            }
            if (!widget) return [];

            const graph = node.graph || app.graph;
            return [
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
    const hubs = (graph._nodes ?? []).filter((n) => n.type === HUB_NODE_NAME);

    if (hubs.length === 0) {
        return [
            {
                content: "➕ Create New Settings Hub",
                callback: () => {
                    const newHub = createNewHub();
                    createBinding(newHub, node, widget, getActiveTabId(getHubConfig(newHub)));
                },
            },
        ];
    }

    // The Vue menu converter only supports one submenu level, so keep the
    // list flat.
    const entries = [];
    for (const hub of hubs) {
        const cfg = getHubConfig(hub);
        const prefix = hubs.length > 1 ? hub.title || "Settings Hub" : null;
        for (const tab of cfg.tabs) {
            entries.push({
                content: prefix ? `${prefix}: ${tab.name}` : tab.name,
                callback: () => {
                    createBinding(hub, node, widget, tab.id);
                },
            });
        }
        entries.push({
            content: prefix ? `➕ ${prefix}: New Tab` : "➕ Add to New Tab",
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    createBinding(hub, node, widget, tabId);
                }
            },
        });
    }
    return entries;
}
