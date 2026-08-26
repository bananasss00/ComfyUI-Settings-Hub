// ============================================================================
// SettingsHub - pinned-node counter cache
// ----------------------------------------------------------------------------
// Tracks how many hub bindings reference each target node so the canvas can
// draw the little "📌 n" badge on target nodes without re-scanning configs
// on every frame. The cache is invalidated whenever bindings change.
// ============================================================================

const counts = new Map(); // targetNodeId -> binding count
const canvases = new Set(); // nodes seen during last recount (for cleanup)

export function invalidatePins() {
    counts.clear();
}

export function getPinCount(targetNodeId) {
    return counts.get(targetNodeId) || 0;
}

export function hasPin(targetNodeId) {
    return counts.has(targetNodeId);
}

/** Recount all bindings from all hubs currently on the graph. */
export function recountPins(graph, HUB_NODE_NAME, cfgGetter) {
    counts.clear();
    canvases.clear();
    for (const node of graph?._nodes ?? []) {
        if (node.type !== HUB_NODE_NAME) continue;
        const cfg = cfgGetter(node);
        for (const item of cfg?.items ?? []) {
            if (item.type !== "widget_binding") continue;
            const id = item.targetNodeId;
            counts.set(id, (counts.get(id) || 0) + 1);
            canvases.add(id);
        }
    }
}

/** Repaint foreground layers so badge changes show up immediately. */
export function repaint(app) {
    try { app?.graph?.setDirtyCanvas(false, true); } catch (_) {}
}
