import { app } from "../../scripts/app.js";
import {
    getHubConfig, createBinding, createPortalBinding, createNewHub, HUB_NODE_NAME, detectWidgetType,
} from "./core.js";

// ============================================================================
// 1) Standard node menu hook (canvas widgets)
// ============================================================================
// ComfyUI builds the right-click node menu through "getNodeMenuItems"; we
// append our "Pin to Settings Hub" entry there when the pointer is over a
// canvas-rendered widget.

export function attachContextMenu() {
    attachDomWidgetPinMenu();
    attachCtrlRmbOverride();

    app.registerExtension({
        name: "Comfy.SettingsHub.context",
        "getNodeMenuItems"(node) {
            if (!node || node.type === HUB_NODE_NAME) return [];

            const graph = node.graph || app.graph;

            // Path 1 (unchanged): the widget strictly under the cursor.
            // Precise, but useless for rgthree-style panels whose surface
            // is fully covered by their own handlers/menus - on the loras
            // list their own menu wins and ours never fires.
            let widget = null;
            try {
                widget = node.getWidgetOnPos?.(
                    app.canvas?.graph_mouse?.[0],
                    app.canvas?.graph_mouse?.[1],
                    true,
                );
            } catch {
                widget = null;
            }

            const items = [];
            if (widget && node.widgets?.length && !isHelperWidget(widget)) {
                items.push({
                    content: "📌 Pin to Settings Hub",
                    has_submenu: true,
                    submenu: {
                        options: buildPinSubmenu(node, widget, graph),
                    },
                });
            }

            // Path 2 (NEW): deterministically list EVERY panel-classified
            // widget of this node. Works even when the right-click lands on
            // the safe node title bar (no widget handler underneath) and it
            // removes the guesswork that previously mis-pinned "spacer"
            // widgets ("empty space", "toggle all", ...).
            const panels = listPanelWidgets(node);
            if (panels.length) {
                items.push({
                    content: "🪟 Pin custom panel (live embed)",
                    has_submenu: true,
                    submenu: {
                        options: buildPanelSubmenu(node, panels, graph),
                    },
                });
            }
            return items;
        },
    });
}

/** Declared helper widgets (bare buttons etc.) carry no state worth mirroring
 *  and no panel worth embedding - they were the source of mis-pins like
 *  "empty space" / stray toggles. */
function isHelperWidget(w) {
    const t = (typeof w?.type === "string" ? w.type : "").trim().toLowerCase();
    return t === "button";
}

/** All widgets of the node classified as portals (custom panels).
 *  Universal detection - zero per-custom-node hardcode. */
function listPanelWidgets(node) {
    const out = [];
    for (const w of node.widgets ?? []) {
        try {
            if (isHelperWidget(w)) continue;
            if (detectWidgetType(w) === "portal") out.push(w);
        } catch (_) { /* defensive: exotic getters must not kill the menu */ }
    }
    return out;
}

/** Human-readable, truncated widget label for menu entries. */
function panelLabel(w) {
    const raw =
        w?.label ||
        w?.name ||
        (typeof w?.type === "string" && w.type ? w.type : "");
    const s = String(raw).replace(/\s+/g, " ").trim() || "panel";
    return s.length > 26 ? `${s.slice(0, 25)}…` : s;
}

/** Whole-panel entries: bind ALL portal-classified widgets of the node as ONE
 *  group embed. rgthree's Power Lora Loader draws its header, every per-lora
 *  row and the divider as SEPARATE sibling widgets - pinning fragments
 *  reproduces only pieces, so the preferred action pins them together. */
function buildWholeBlockEntries(node, panels, hubs) {
    if (!panels || panels.length < 2) return [];
    const what =
        `whole panel «${String(node?.title || panelLabel(panels[0])).slice(0, 26)}» ` +
        `(${panels.length} parts)`;
    const entries = [];

    if (hubs.length === 0) {
        entries.push({
            content: `🪟 ${what} → Create New Settings Hub`,
            callback: () => {
                const newHub = createNewHub();
                if (newHub) {
                    createPortalBinding(
                        newHub, node, panels, getActiveTabId(getHubConfig(newHub)));
                }
            },
        });
        return entries;
    }

    for (const hub of hubs) {
        const cfg = getHubConfig(hub);
        const prefix = hubs.length > 1 ? `${hub.title || "Settings Hub"}: ` : "";
        for (const tab of cfg.tabs) {
            entries.push({
                content: `🪟 ${what} → ${prefix}${tab.name}`,
                callback: () => createPortalBinding(hub, node, panels, tab.id),
            });
        }
        entries.push({
            content: `➕ ${what} → ${prefix}New Tab`,
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    createPortalBinding(hub, node, panels, tabId);
                }
            },
        });
    }
    return entries;
}

/** Flat "candidate -> hub -> tab" entries (the Vue menu converter only
 *  supports ONE submenu level, so cross products stay flat). */
function buildPanelSubmenu(node, panels, graph) {
    const hubs = (graph._nodes ?? []).filter((n) => n.type === HUB_NODE_NAME);
    const entries = [];

    // PREFERRED first: the whole custom block as ONE live embed.
    entries.push(...buildWholeBlockEntries(node, panels, hubs));

    if (!hubs.length) {
        for (const w of panels) {
            entries.push({
                content: `🪟 Create New Settings Hub (${panelLabel(w)})`,
                callback: () => {
                    const newHub = createNewHub();
                    if (newHub) {
                        createBinding(newHub, node, w, getActiveTabId(getHubConfig(newHub)));
                    }
                },
            });
        }
        return entries;
    }

    for (const w of panels) {
        for (const hub of hubs) {
            const cfg = getHubConfig(hub);
            const prefix = hubs.length > 1 ? `${hub.title || "Settings Hub"}: ` : "";
            for (const tab of cfg.tabs) {
                entries.push({
                    content: `🪟 «${panelLabel(w)}» → ${prefix}${tab.name}`,
                    callback: () => createBinding(hub, node, w, tab.id),
                });
            }
            entries.push({
                content: `➕ «${panelLabel(w)}» → ${prefix}New Tab`,
                callback: () => {
                    const name = prompt("New tab name:", "New Tab");
                    if (name !== null) {
                        const tabId = `tab_${Date.now().toString(36)}`;
                        cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                        createBinding(hub, node, w, tabId);
                    }
                },
            });
        }
    }
    return entries;
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
    cancel.textContent = "✖ Cancel · Shift+RMB = native menu";
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

// ============================================================================
// 3) Ctrl/Cmd+RMB override - pin menu from INSIDE foreign panels
// ============================================================================
// Custom panels (rgthree Power Lora Loader etc.) consume right-clicks over
// practically their whole surface for their own per-row menus, leaving no
// reachable pixel to request a pin. Holding Ctrl/Cmd flips the priority:
// our capture-phase handler answers BEFORE the panel's own contextmenu
// logic and offers the standard pin menu instead.

function attachCtrlRmbOverride() {
    document.addEventListener("contextmenu", (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.defaultPrevented) return;
        const t = e.target;
        if (!t || typeof t.closest !== "function") return;
        // Never intercept our own UI or panels already relocated into the hub.
        if (t.closest(".hub-menu, .settings-hub-wrap, .hub-portal-host")) return;

        let owner = null;
        if (t.tagName === "CANVAS") {
            // Canvas surface: resolve node+widget under the tracked graph-
            // space pointer, exactly like ComfyUI's own menu does.
            const mx = app.canvas?.graph_mouse?.[0];
            const my = app.canvas?.graph_mouse?.[1];
            if (typeof mx === "number" && typeof my === "number") {
                let hit = null;
                try {
                    hit = (app.graph ?? app.canvas?.graph)?.getNodeOnPos?.(mx, my, true);
                } catch (_) {
                    hit = null;
                }
                if (hit && hit.type !== HUB_NODE_NAME) {
                    try {
                        const w = hit.getWidgetOnPos?.(mx, my, true);
                        if (w) owner = { node: hit, widget: w };
                    } catch (_) {
                        owner = null;
                    }
                }
            }
        } else {
            owner = findDomWidgetOwner(t);
        }

        if (!owner || owner.node.type === HUB_NODE_NAME) return;

        const graph = owner.node.graph || app.graph;
        // Offer the WHOLE-PANEL group embed first (the widget under the
        // cursor is usually just one row of a multi-widget custom panel).
        const entries = [
            ...buildWholeBlockEntries(owner.node, listPanelWidgets(owner.node),
                (graph._nodes ?? []).filter((n) => n.type === HUB_NODE_NAME)),
            ...buildPinSubmenu(owner.node, owner.widget, graph),
        ];
        if (!entries.length) return;

        e.preventDefault();
        e.stopPropagation();
        showHubMenu(e.clientX, e.clientY, entries);
    }, true);
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
        // Plain RMB only. Shift stays the native-menu escape hatch;
        // Ctrl/Cmd belongs to the override listener (section 3).
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
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
