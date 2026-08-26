import { app } from "../../scripts/app.js";
import { getHubConfig, getActiveTabId, nextOrder, genId, extractComboValues } from "./core.js";
import { presetSave, presetNew, presetApply } from "./preset_manager.js";
import { registerSync } from "./sync.js";

let syncLock = false;

function mapItemWidgetType(itemType) {
    switch (itemType) {
        case "combo": return "combo";
        case "checkbox": return "checkbox";
        case "slider":
        case "int": return "slider";
        default: return "text";
    }
}

function widgetFor(node, name, type, defaultValue, callback) {
    const w = {
        name,
        type,
        label: name,
        defaultValue,
        value: defaultValue,
        serializable: false,
        options: {},
    };
    if (callback) w.callback = callback;
    node.widgets.push(w);
    return w;
}

function doSetValue(targetWidget, val) {
    if (syncLock) return;
    syncLock = true;
    try {
        targetWidget.value = val;
        if (targetWidget.callback) {
            try { targetWidget.callback(val); } catch {}
        }
    } finally {
        syncLock = false;
    }
}

function locateNode(hubNode, item) {
    const targetNode = app.graph.getNodeById(item.targetNodeId);
    if (targetNode) {
        app.canvas.centerOnNode(targetNode);
        const origColor = targetNode.color || "#1a1a2e";
        targetNode._origColor = origColor;
        targetNode.color = "#4a4a2e";
        setTimeout(() => {
            targetNode.color = targetNode._origColor || origColor;
            app.graph.setDirtyCanvas(true, true);
        }, 1500);
    }
}

function renderPresetSection(node, cfg) {
    const presetNames = Object.keys(cfg.presets || {});
    const presetValues = presetNames.length ? presetNames : ["— Default —"];
    const presetDefault = presetNames.length ? presetNames[0] : "— Default —";
    const presetWidget = widgetFor(
        node, "__hub_presets", "combo", presetDefault,
        (val) => { if (val !== presetDefault) presetApply(node, val); },
    );
    presetWidget.options = { values: presetValues };
    presetWidget.value = presetDefault;
    presetWidget.defaultValue = presetDefault;
    widgetFor(node, "__hub_save_btn", "text", "💾 Save Preset", () => presetSave(node));
    widgetFor(node, "__hub_new_btn", "text", "➕ New Preset", () => presetNew(node));
    widgetFor(node, "__hub_divider_btn", "text", "+ Add Divider", () => {
        const label = prompt("Divider label:", "");
        if (label === null) return;
        cfg.items.push({
            id: genId("item"),
            type: "divider",
            tabId: getActiveTabId(cfg),
            order: nextOrder(cfg, getActiveTabId(cfg)),
            customLabel: label || "Section",
        });
        syncHubNode(node);
    });
}

function renderItemWidget(node, cfg, item, index, previousItemValues) {
    const targetNode = app.graph.getNodeById(item.targetNodeId);
    const targetWidget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);

    if (item.type === "divider") {
        widgetFor(node, `__hub_div_${item.id}`, "label",
            `--- ${item.customLabel || "Section"} ---`);
    } else if (targetNode && targetWidget) {
        const name = `__hub_item_${item.id}`;
        const label = item.customLabel || targetWidget.name;
        const hubWidgetType = mapItemWidgetType(item.widgetType);
        const initialValue = previousItemValues.get(item.id) ?? targetWidget.value;
        const w = widgetFor(node, name, hubWidgetType, initialValue,
            (val) => doSetValue(targetWidget, val));
        w.label = label;
        // Preserve combo values / slider range.
        if (item.widgetType === "combo") {
            w.options.values = extractComboValues(targetWidget) || item.options?.values || [];
        } else if (hubWidgetType === "slider") {
            w.options = {
                min: item.options?.min ?? 0,
                max: item.options?.max ?? 1,
                step: item.options?.step ?? 1,
            };
        }
    } else {
        widgetFor(node, `__hub_item_${item.id}`, "label",
            `⚠️ ${(item.customLabel || item.widgetToBind)} - target missing`);
    }
}

function renderTabSection(node, cfg) {
    const tabs = [...cfg.tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const tabWidget = widgetFor(node, "__hub_tab", "combo", cfg.activeTabId,
        (val) => {
            const tab = tabs.find((t) => t.name === val);
            if (tab) {
                cfg.activeTabId = tab.id;
                syncHubNode(node);
            }
        });
    tabWidget.options = { values: tabs.map((t) => t.name) };
}

export function syncHubNode(node) {
    if (!node || node.type !== "SettingsHub") return;
    const cfg = getHubConfig(node);
    const isFullSync = !node.widgets?.length;
    const previousItemValues = new Map();
    if (!isFullSync) {
        for (const hubWidget of node.widgets) {
            if (hubWidget.name?.startsWith("__hub_item_")) {
                const itemId = hubWidget.name.replace("__hub_item_", "");
                const item = cfg.items.find((i) => i.id === itemId);
                if (item && item.type === "widget_binding") {
                    previousItemValues.set(item.id, hubWidget.value);
                }
            }
        }
    }

    // Clear old widgets
    node.widgets = (node.widgets || []).filter((w) => !w.name?.startsWith("__hub_"));

    // Add tab selector first
    renderTabSection(node, cfg);

    // Add preset section
    renderPresetSection(node, cfg);

    // Add items
    const activeTabId = getActiveTabId(cfg);
    const tabItems = cfg.items
        .filter((i) => i.tabId === activeTabId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const item of tabItems) {
        renderItemWidget(node, cfg, item, 0, previousItemValues);
    }

    // Auto-resize
    const widgetHeight = node.widgets.length * 22 + 30;
    node.setSize([340, Math.max(150, widgetHeight)]);
    node.setDirtyCanvas(true, true);
}

registerSync(syncHubNode);
