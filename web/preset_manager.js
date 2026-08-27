import { app } from "../../scripts/app.js";
import { getHubConfig, resolveBindingTarget } from "./core.js";
import { writeTargetValue } from "./sync_manager.js";
import * as Pins from "./pins.js";
import { syncNode, refreshNodeValues } from "./sync.js";

/**
 * Snapshot the CURRENT values of every widget binding of this hub
 * (all tabs - per spec section "Presets": "reads current values of all hub bindings").
 */
function snapshotAll(node) {
    const cfg = getHubConfig(node);
    const snap = {};
    for (const item of cfg.items) {
        // widget_portal items are deliberately NOT preset-able: there is no
        // universal way to serialize/restore complex custom-widget states
        // (lora lists, panels) across custom nodes.
        if (item.type !== "widget_binding") continue;
        // Prefer live value mirrored on the target node; fall back to DOM mirror.
        const targetNode = resolveBindingTarget(item);
        const widget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
        if (widget && widget.value !== undefined) {
            snap[item.id] = widget.value;
            continue;
        }
        const input = document.querySelector(
            `[data-hub-item="${item.id}"] [data-hub-control]`,
        );
        if (input) {
            snap[item.id] = input.type === "checkbox" ? input.checked : input.value;
        }
    }
    return snap;
}

/** Save into an existing preset name (overwrite) or prompt for a new one. */
export function presetSave(node, existingName) {
    const cfg = getHubConfig(node);
    let name = existingName;

    if (!name || cfg.presets[name] === undefined) {
        name = prompt("Preset name:", name || `Preset ${Object.keys(cfg.presets).length + 1}`);
        if (name === null) return null;
        name = String(name).trim();
        if (!name) return null;
    }

    cfg.presets[name] = snapshotAll(node);
    Pins.repaint(app);
    syncNode(node);
    node.setDirtyCanvas(true, true);
    return name;
}

export function presetNew(node) {
    return presetSave(node, null);
}

export function presetDelete(node, name) {
    const cfg = getHubConfig(node);
    if (!name || cfg.presets[name] === undefined) return false;
    delete cfg.presets[name];
    syncNode(node);
    node.setDirtyCanvas(true, true);
    return true;
}

export function presetApply(node, presetName) {
    if (!presetName) return false;
    const cfg = getHubConfig(node);
    const preset = cfg.presets?.[presetName];
    if (!preset) return false;

    for (const [itemId, value] of Object.entries(preset)) {
        const item = cfg.items.find((i) => i.id === itemId);
        if (!item || item.type !== "widget_binding") continue;
        const targetNode = resolveBindingTarget(item);
        const widget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
        if (!widget) continue;

        let v = value;
        if (item.widgetType === "slider" || item.widgetType === "int") {
            const n = Number(value);
            v = Number.isFinite(n) ? n : widget.value;
        } else if (item.widgetType === "checkbox") {
            v = !!value;
        } else {
            v = String(value);
        }
        writeTargetValue(targetNode, widget, v);
    }
    // The wrapped target callbacks stay silent while the edit lock is held,
    // so the hub mirrors must be refreshed explicitly once ALL writes are
    // done (previously the DOM kept stale values after preset switching).
    refreshNodeValues(node);
    (node.graph ?? app.graph)?.setDirtyCanvas?.(true, true);
    return true;
}
