// ============================================================================
// SettingsHub - Drag & Drop manager (HTML5 DnD inside the hub DOM widget)
// ----------------------------------------------------------------------------
// * Row reorder within the active tab   -> drag by the [handle] handle
// * Move an item to another tab         -> drop the row onto a tab button
// * Reorder tabs themselves             -> drag tab buttons horizontally
//
// Everything is expressed as plain array reordering; `order` fields are then
// rebased to 0..n-1 and a full structural re-render is triggered through the
// provided callbacks.
// ============================================================================

const DND_MIME = "application/x-settings-hub-item";
const DND_TAB_MIME = "application/x-settings-hub-tab";

let dragState = null; // { kind: "item"|"tab", id, fromTabId }

/**
 * @param {HTMLElement} root     the .settings-hub container
 * @param {Object} handlers
 *   getCfg()               -> current hubConfig
 *   getNode()              -> hub LGraphNode
 *   commitItems(payload)   -> called after any structural change (triggers re-render)
 */
export function initDrag(root, handlers) {
    // ------------------------------------------------------------------
    // Sources: item handles AND tab buttons (tab reorder)
    // ------------------------------------------------------------------
    root.addEventListener("dragstart", (e) => {
        const tabBtn = e.target.closest?.(".hub-tab-btn[data-tab]");
        if (!tabBtn && e.target.closest?.(".hub-add-tab")) return; // not draggable

        if (tabBtn) {
            dragState = { kind: "tab", id: tabBtn.dataset.tab };
            e.dataTransfer.effectAllowed = "move";
            try {
                e.dataTransfer.setData("text/plain", `tab:${dragState.id}`);
            } catch (_) {}
            requestAnimationFrame(() => tabBtn.classList.add("hub-dragging"));
            return;
        }

        const handle = e.target.closest?.(".hub-drag-handle");
        if (!handle) return;
        const row = handle.closest("[data-hub-item]");
        if (!row) return;
        const isDivider = row.classList.contains("hub-divider-row");
        dragState = {
            kind: "item",
            id: row.dataset.hubItem,
            fromTabId: row.dataset.tabId || null,
        };
        e.dataTransfer.effectAllowed = "move";
        try {
            e.dataTransfer.setData(DND_MIME, dragState.id);
            e.dataTransfer.setData("text/plain", dragState.id);
        } catch (_) {}
        if (!isDivider) e.dataTransfer.setDragImage?.(row, 10, 10);
        requestAnimationFrame(() => row.classList.add("hub-dragging"));
    });

    root.addEventListener("dragend", () => {
        root.querySelectorAll(".hub-dragging").forEach((el) => el.classList.remove("hub-dragging"));
        clearDropMarks(root);
        dragState = null;
    });

    root.addEventListener("dragover", (e) => {
        if (!dragState) return;
        const overTab = e.target.closest?.(".hub-tab-btn[data-tab]");

        if (overTab) {
            // Items -> move to that tab; tabs themselves -> reorder.
            const selfDrag = dragState.kind === "tab" && overTab.dataset.tab === dragState.id;
            if (!selfDrag) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                markDrop(root, overTab, "hub-tab-drop-target");
                return;
            }
        }

        if (dragState.kind === "item") {
            const row = e.target.closest?.(".hub-item-row, .hub-divider-row");
            if (row && !row.classList.contains("hub-dragging")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = row.getBoundingClientRect();
                const above = e.clientY < rect.top + rect.height / 2;
                markDrop(root, row, above ? "hub-drop-before" : "hub-drop-after");
            }
        }
    });

    root.addEventListener("drop", (e) => {
        const tabBtn = e.target.closest?.(".hub-tab-btn[data-tab]");
        if (!dragState) return;

        if (tabBtn && tabBtn.dataset.tab !== dragState.id) {
            e.preventDefault();
            if (dragState.kind === "item") {
                moveItemToTabById(handlers, dragState.id, tabBtn.dataset.tab);
            } else {
                reorderTabs(handlers, dragState.id, tabBtn.dataset.tab);
            }
        } else if (dragState.kind === "item") {
            const row = e.target.closest?.(".hub-item-row, .hub-divider-row");
            if (row && !row.classList.contains("hub-dragging")) {
                e.preventDefault();
                reorderItem(handlers, root, row, e);
            }
        }
        clearDropMarks(root);
        dragState = null;
    });
}

function markDrop(root, el, cls) {
    const prev = root.querySelector(
        ".hub-drop-before, .hub-drop-after, .hub-tab-drop-target",
    );
    if (prev === el && prev.classList.contains(cls)) return;
    clearDropMarks(root);
    el.classList.add(cls);
}

function clearDropMarks(root) {
    root.querySelectorAll(".hub-drop-before, .hub-drop-after, .hub-tab-drop-target")
        .forEach((el) => el.classList.remove("hub-drop-before", "hub-drop-after", "hub-tab-drop-target"));
}

// ---------------------------------------------------------------------------
// Order math
// ---------------------------------------------------------------------------

function collectVisible(handlers) {
    const cfg = handlers.getCfg();
    const active = cfg.activeTabId;
    return cfg.items
        .filter((i) => i.tabId === active)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function reorderItem(handlers, root, targetRow, e) {
    const cfg = handlers.getCfg();
    const list = collectVisible(handlers);
    const srcIdx = list.findIndex((i) => i.id === dragState.id);
    if (srcIdx < 0) return;

    let dstIdx = [...root.querySelectorAll(".hub-item-row, .hub-divider-row")]
        .filter((r) => !r.classList.contains("hub-dragging"))
        .indexOf(targetRow);
    if (dstIdx < 0) dstIdx = list.length - 1;

    // Adjust for "drop after" side.
    const rect = targetRow.getBoundingClientRect();
    const insertAfter = e.clientY >= rect.top + rect.height / 2;
    const [moved] = list.splice(srcIdx, 1);
    if (srcIdx < dstIdx) dstIdx -= 1;   // removing earlier element shifts left
    list.splice(insertAfter ? dstIdx + 1 : dstIdx, 0, moved);

    // Write back new per-tab order into cfg.items.
    for (const item of list) item.order = list.indexOf(item);
    // Keep other tabs' relative order untouched (their orders are per-tab).
    handlers.commitItems(cfg.items);
}

/** Move dragged tab before/after the drop-target tab based on pointer x. */
function reorderTabs(handlers, srcTabId, dstTabId) {
    const cfg = handlers.getCfg();
    if (srcTabId === dstTabId) return;
    const sorted = [...cfg.tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const fromIdx = sorted.findIndex((t) => t.id === srcTabId);
    let toIdx = sorted.findIndex((t) => t.id === dstTabId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = sorted.splice(fromIdx, 1);
    toIdx = sorted.findIndex((t) => t.id === dstTabId); // recompute after removal
    sorted.splice(toIdx + 1, 0, moved);
    sorted.forEach((t, i) => { t.order = i; });
    cfg.tabs = sorted;
    handlers.commitItems(cfg.tabs); // triggers full re-render
}

export function moveItemToTabById(handlers, itemId, tabId) {
    const cfg = handlers.getCfg();
    const item = cfg.items.find((i) => i.id === itemId);
    if (!item || item.tabId === tabId) return false;
    item.tabId = tabId;
    item.order = cfg.items
        .filter((i) => i.tabId === tabId)
        .reduce((m, i) => Math.max(m, (i.order ?? 0) + 1), 0);
    handlers.commitItems(cfg.items);
    return true;
}

