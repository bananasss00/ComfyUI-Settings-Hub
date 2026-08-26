import { app } from "../../scripts/app.js";
import {
    getHubConfig, createBinding, createNewHub, HUB_NODE_NAME, detectWidgetType,
} from "./core.js";

// ============================================================================
// 1) Standard node menu hook (canvas widgets)
// ============================================================================
// ComfyUI builds the right-click node menu through "getNodeMenuItems"; we
// append our "Pin to Settings Hub" entry there when the pointer is over a
// canvas-rendered widget.

export function attachContextMenu() {
    attachDomWidgetPinMenu();

    app.registerExtension({
        name: "Comfy.SettingsHub.context",
        "getNodeMenuItems"(node) {
            if (!node || node.type === HUB_NODE_NAME) return [];
            if (!node.widgets?.length) return [];

            // Widget strictly under the cursor. No body-click fallback:
            // pinning the wrong widget silently was one of the sources of
            // "wrong mirror type" reports.
            const canvas = app.canvas;
            let widget = null;
            try {
                widget = node.getWidgetOnPos?.(
                    canvas?.graph_mouse?.[0],
                    canvas?.graph_mouse?.[1],
                    true,
                );
            } catch {
                widget = null;
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
    // Custom widgets (non-primitive values / unknown types) become live
    // portals - mark those entries so users know what to expect.
    const portal = detectWidgetType(widget) === "portal";
    const mark = portal ? "🪟 " : "📌 ";

    if (hubs.length === 0) {
        return [
            {
                content: `${mark}Create New Settings Hub${portal ? " (live embed)" : ""}`,
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
                content: prefix
                    ? `${mark}${prefix}: ${tab.name}${portal ? " · live" : ""}`
                    : `${mark}${tab.name}${portal ? " · live" : ""}`,
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

// ============================================================================
// 2) Custom menu for DOM-widget text fields (multiline prompts etc.)
// ============================================================================
// Multiline / customtext widgets are real <textarea> DOM elements layered
// above the canvas, so a right-click opens the BROWSER menu and ComfyUI's
// node menu (and our getNodeMenuItems hook) never fires. We intercept
// contextmenu on such fields, resolve the owning (node, widget) pair and
// show our own pin menu. Shift+RMB still opens the native browser menu
// (copy/paste escape hatch).

let openMenuEl = null;
let dismissHandlers = null;

function closeHubMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
    if (dismissHandlers) {
        document.removeEventListener("pointerdown", dismissHandlers.pointer, true);
        document.removeEventListener("keydown", dismissHandlers.key, true);
        window.removeEventListener("blur", dismissHandlers.blur);
        dismissHandlers = null;
    }
}

function showHubMenu(x, y, entries) {
    closeHubMenu();

    const menu = document.createElement("div");
    menu.className = "hub-menu";

    const title = document.createElement("div");
    title.className = "hub-menu-title";
    title.textContent = "📌 Pin to Settings Hub";
    menu.appendChild(title);

    for (const ent of entries) {
        const item = document.createElement("div");
        item.className = "hub-menu-item";
        item.textContent = ent.content;
        item.addEventListener("click", () => {
            closeHubMenu();
            try { ent.callback?.(); }
            catch (err) { console.warn("[SettingsHub] menu action failed:", err); }
        });
        menu.appendChild(item);
    }

    const cancel = document.createElement("div");
    cancel.className = "hub-menu-item hub-menu-cancel";
    cancel.textContent = "✖ Cancel  (Shift+RMB = browser menu)";
    cancel.addEventListener("click", closeHubMenu);
    menu.appendChild(cancel);

    document.body.appendChild(menu);

    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;

    openMenuEl = menu;
    dismissHandlers = {
        pointer: (e) => { if (!menu.contains(e.target)) closeHubMenu(); },
        key: (e) => { if (e.key === "Escape") closeHubMenu(); },
        blur: () => closeHubMenu(),
    };
    document.addEventListener("pointerdown", dismissHandlers.pointer, true);
    document.addEventListener("keydown", dismissHandlers.key, true);
    window.addEventListener("blur", dismissHandlers.blur);
}

/** Find which node widget owns the given DOM element (textarea/input). */
function findDomWidgetOwner(target) {
    const graph = app.graph ?? app.canvas?.graph;
    for (const node of graph?._nodes ?? []) {
        for (const w of node.widgets ?? []) {
            const el = w.element ?? w.inputEl ?? w.contentEl ?? null;
            if (el && (el === target ||
                (typeof el.contains === "function" && el.contains(target)))) {
                return { node, widget: w };
            }
        }
    }
    return null;
}

function isTextField(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
    if (el.tagName === "INPUT") {
        const t = String(el.type ?? "text").toLowerCase();
        return !["checkbox", "range", "button", "submit", "color", "file", "radio"].includes(t);
    }
    return false;
}

function attachDomWidgetPinMenu() {
    document.addEventListener("contextmenu", (e) => {
        // Shift+RMB -> let the browser menu through (copy/paste etc.).
        if (e.shiftKey || e.defaultPrevented) return;
        if (!isTextField(e.target)) return;
        // Text fields already relocated into a portal belong to that portal:
        // their own menus must stay native, re-pinning them is meaningless.
        if (e.target.closest?.(".hub-portal-host")) return;

        const owner = findDomWidgetOwner(e.target);
        if (!owner || owner.node.type === HUB_NODE_NAME) return;

        const graph = owner.node.graph || app.graph;
        const entries = buildPinSubmenu(owner.node, owner.widget, graph);
        if (!entries.length) return;

        e.preventDefault();
        e.stopPropagation();
        showHubMenu(e.clientX, e.clientY, entries);
    }, true);
}
