import { app } from "../../scripts/app.js";
import { getHubConfig, getActiveTabId, nextOrder, genId, extractComboValues } from "./core.js";
import { presetSave, presetNew, presetApply } from "./preset_manager.js";
import { registerSync } from "./sync.js";

let syncLock = false;

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
    // Add preset combo
    const presetNames = Object.keys(cfg.presets || {});
    const presetWidget = {
        name: "__hub_presets",
        type: "COMBO",
        options: { values: presetNames.length ? presetNames : ["— Default —"] },
        default_value: presetNames.length ? presetNames[0] : "— Default —",
    };
    presetWidget.callback = function (val) {
        if (val === "— Default —") return;
        presetApply(node, val);
    };
    node.widgets.push(presetWidget);

    // Add action buttons
    const saveBtn = {
        name: "__hub_save_btn",
        type: "STRING",
        default_value: "💾 Save Preset",
    };
    saveBtn.callback = function () { presetSave(node); };
    node.widgets.push(saveBtn);

    const newBtn = {
        name: "__hub_new_btn",
        type: "STRING",
        default_value: "➕ New Preset",
    };
    newBtn.callback = function () { presetNew(node); };
    node.widgets.push(newBtn);

    const divBtn = {
        name: "__hub_divider_btn",
        type: "STRING",
        default_value: "+ Add Divider",
    };
    divBtn.callback = function () {
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
    };
    node.widgets.push(divBtn);
}

function renderItemWidget(node, cfg, item, index) {
    const targetNode = app.graph.getNodeById(item.targetNodeId);
    const widget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);

    if (item.type === "divider") {
        const w = {
            name: `__hub_div_${item.id}`,
            type: "STRING",
            default_value: `--- ${item.customLabel || "Section"} ---`,
        };
        node.widgets.push(w);
    } else if (targetNode && widget) {
        const name = `__hub_item_${item.id}`;
        const label = item.customLabel || widget.name;

        if (item.widgetType === "combo") {
            const values = extractComboValues(widget) || item.options?.values || [];
            const w = {
                name,
                type: "COMBO",
                options: { values },
                default_value: widget.value,
            };
            w.callback = (val) => doSetValue(widget, val);
            node.widgets.push(w);
        } else if (item.widgetType === "checkbox") {
            const w = {
                name,
                type: "BOOLEAN",
                default_value: !!widget.value,
            };
            w.callback = (val) => doSetValue(widget, val);
            node.widgets.push(w);
        } else if (item.widgetType === "slider" || item.widgetType === "int") {
            const w = {
                name,
                type: "NUMBER",
                options: item.options || {},
                default_value: widget.value,
            };
            w.callback = (val) => doSetValue(widget, val);
            node.widgets.push(w);
        } else {
            const w = {
                name,
                type: "STRING",
                default_value: widget.value,
            };
            w.callback = (val) => doSetValue(widget, val);
            node.widgets.push(w);
        }
    } else {
        const w = {
            name: `__hub_item_${item.id}`,
            type: "STRING",
            default_value: `⚠️ ${(item.customLabel || item.widgetToBind)} - target missing`,
        };
        node.widgets.push(w);
    }
}

function renderTabSection(node, cfg) {
    // Remove existing tab widget
    const existingTab = node.widgets.find((w) => w.name === "__hub_tab");
    const tabIdx = node.widgets.indexOf(existingTab);
    if (tabIdx !== -1) node.widgets.splice(tabIdx, 1);

    const tabs = [...cfg.tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const tabWidget = {
        name: "__hub_tab",
        type: "COMBO",
        options: { values: tabs.map((t) => t.name) },
        default_value: cfg.activeTabId,
    };
    tabWidget.callback = function (val) {
        const tab = tabs.find((t) => t.name === val);
        if (tab) {
            cfg.activeTabId = tab.id;
            syncHubNode(node);
        }
    };
    node.widgets.push(tabWidget);
}

export function syncHubNode(node) {
    if (!node || node.type !== "SettingsHub") return;
    const cfg = getHubConfig(node);

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
        renderItemWidget(node, cfg, item, 0);
    }

    // Auto-resize
    const widgetHeight = node.widgets.length * 22 + 30;
    node.setSize([340, Math.max(150, widgetHeight)]);
    node.setDirtyCanvas(true, true);
}

registerSync(syncHubNode);
