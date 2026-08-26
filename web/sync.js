// ============================================================================
// SettingsHub - internal message bus
// ----------------------------------------------------------------------------
// A tiny registry shared by all hub modules to avoid circular imports.
// It also provides the "sync lock" used to break Hub <-> Target feedback
// loops, and a requestAnimationFrame-coalesced queue for reactive value
// refreshes coming from hooked target widgets (no polling).
// ============================================================================

let structuralSync = null;   // full re-render of one hub node
let valueRefresh = null;     // value-only refresh of one hub node's DOM

let editDepth = 0;           // >0 while a hub-initiated write is in flight

const pendingHubs = new Set();
let pendingRaf = 0;

export function beginEdit() { editDepth++; }
export function endEdit() { editDepth = Math.max(0, editDepth - 1); }
export function inEdit() { return editDepth > 0; }

export function registerStructural(fn) { structuralSync = fn; }
export function registerValues(fn) { valueRefresh = fn; }

/** Full re-render (structure + values) of a single hub node. */
export function syncNode(node) {
    if (!node) return;
    try { structuralSync && structuralSync(node); }
    catch (err) { console.warn("[SettingsHub] syncNode failed:", err); }
}

/** Value-only refresh: pushes target widget values into existing DOM controls. */
export function refreshNodeValues(node) {
    if (!node) return;
    try { valueRefresh && valueRefresh(node); }
    catch (err) { console.warn("[SettingsHub] refreshNodeValues failed:", err); }
}

/**
 * Schedule a lightweight value refresh for a hub node. Multiple calls within
 * the same frame are coalesced into one rAF flush. Refresh is skipped if we
 * are inside a hub-initiated write (the local control already holds truth).
 */
export function queueHubRefresh(node) {
    if (!node || inEdit()) return;
    pendingHubs.add(node);
    if (!pendingRaf) {
        pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0;
            const list = [...pendingHubs];
            pendingHubs.clear();
            for (const hub of list) refreshNodeValues(hub);
        });
    }
}
