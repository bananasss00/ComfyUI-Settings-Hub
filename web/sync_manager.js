import { app } from "../../scripts/app.js";
import { getHubConfig, HUB_NODE_NAME, allHubs, resolveBindingTarget } from "./core.js";
import { syncNode, queueHubRefresh, inEdit, beginEdit, endEdit } from "./sync.js";
import * as Pins from "./pins.js";

export const HUB_NODE_NAME_LOCAL = HUB_NODE_NAME;

const hookedWidgets = new WeakSet();

/**
 * Wrap a target widget's callback so manual edits on the source node are
 * pushed into every hub mirror within one animation frame (reactive,
 * polling-free). The original callback still runs first.
 */
function attachTargetHook(targetNode, targetWidget) {
    if (!targetWidget || hookedWidgets.has(targetWidget)) return;
    hookedWidgets.add(targetWidget);

    const original = typeof targetWidget.callback === "function"
        ? targetWidget.callback
        : null;

    targetWidget.callback = function (...args) {
        let result;
        if (original) {
            try { result = original.apply(this, args); }
            catch (err) { console.warn("[SettingsHub] target callback error:", err); }
        }
        // Only propagate user-driven changes; hub-initiated writes hold the
        // edit lock so the loop cannot recurse back onto itself. ALL hubs are
        // considered - including those on other graphs (target in a subgraph,
        // hub on the root canvas and vice versa).
        if (!inEdit()) {
            for (const hub of allHubs()) {
                if (hubBindsWidget(hub, targetNode.id, targetWidget.name)) {
                    queueHubRefresh(hub);
                }
            }
        }
        return result;
    };
}

export function ensureHooksForItem(item) {
    if (!item || item.type !== "widget_binding") return;
    // Cross-graph: the binding's source node may live inside any subgraph.
    const targetNode = resolveBindingTarget(item);
    const targetWidget = targetNode?.widgets?.find((w) => w.name === item.widgetToBind);
    attachTargetHook(targetNode, targetWidget);
}

/** Hub -> Target write with loop guard (the shared sync lock). */
export function writeTargetValue(targetNode, targetWidget, value) {
    beginEdit();
    try {
        targetWidget.value = value;
        // Invoke LiteGraph's own machinery (side effects like
        // control_after_generate), bypassing our wrapper is not required:
        // our wrapper checks the lock and will no-op propagation.
        if (typeof targetWidget.callback === "function") {
            try { targetWidget.callback(value); } catch (_) {}
        }
    } finally {
        endEdit();
    }
}

/**
 * Invoke a PINNED BUTTON's callback on its live target node.
 * Buttons carry no mirrored state, so unlike writeTargetValue this never
 * touches `.value` - it reproduces the litegraph click dispatch:
 * callback.call(widget, value ?? null, canvas, node). The shared edit lock
 * is held so the hook wrapper around the same callback stays silent (buttons
 * have no mirrors to refresh), and the invocation result/error report is
 * contained: a throwing handler must not break the hub UI.
 */
export function invokeTargetButton(targetNode, targetWidget) {
    if (!targetNode || !targetWidget) return { ok: false };
    if (typeof targetWidget.callback !== "function") return { ok: false };
    beginEdit();
    try {
        let ok = true;
        try {
            targetWidget.callback.call(
                targetWidget,
                targetWidget.value ?? null,
                app.canvas ?? undefined,
                targetNode,
            );
        } catch (err) {
            ok = false;
            console.warn("[SettingsHub] pinned button failed:", err);
        }
        return { ok };
    } finally {
        endEdit();
    }
}

// ---------------------------------------------------------------------------
// Global helpers
// ---------------------------------------------------------------------------

function hubBindsWidget(hubNode, targetNodeId, widgetName) {
    const cfg = getHubConfig(hubNode);
    for (const item of cfg.items) {
        if (
            item.type === "widget_binding" &&
            item.targetNodeId === targetNodeId &&
            item.widgetToBind === widgetName
        ) return true;
    }
    return false;
}

export function isHubTarget(nodeId) {
    for (const hub of allHubs()) {
        const cfg = getHubConfig(hub);
        for (const item of cfg.items) {
            if (item.type === "widget_binding" && item.targetNodeId === nodeId) return true;
        }
    }
    return false;
}

/** Full re-render of every hub on every graph + pin recount. */
export function syncAll() {
    Pins.invalidatePins();
    for (const hub of allHubs()) syncNode(hub);
    // Attach hooks to widgets that are already bound at load time.
    for (const hub of allHubs()) {
        const cfg = getHubConfig(hub);
        for (const item of cfg.items) ensureHooksForItem(item);
    }
}

app.registerExtension({
    name: "Comfy.SettingsHub.sync",
    setup() {
        syncAll();
    },
    afterConfigureGraph() {
        syncAll();
    },
});
