import { app } from "../../scripts/app.js";
import {
    getHubConfig, getActiveTabId, createBinding, createPortalBinding,
    createNewHub, HUB_NODE_NAME, detectWidgetType, portalKindOf, allHubs,
    isViewerNode, createViewerBinding, isInternalWidget,
    mediaLoaderInfo, createMediaBinding,
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
    attachPanelSurfacePinMenu();

    app.registerExtension({
        name: "Comfy.SettingsHub.context",
        "getNodeMenuItems"(node) {
            if (!node || node.type === HUB_NODE_NAME) return [];

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
            if (widget && node.widgets?.length && !isHelperWidget(widget)
                && !isInternalWidget(widget)) {
                items.push({
                    content: "📌 Pin to Settings Hub",
                    has_submenu: true,
                    submenu: {
                        options: buildPinSubmenu(node, widget),
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
                        options: buildPanelSubmenu(node, panels),
                    },
                });
            }

            // v30: media-source loaders - ONE row with the input-file
            // preview, the searchable file combo and upload (native picker
            // via the node's own upload button, drag&drop routed through
            // the node's onDrop pipeline, /upload/image fallback). v30.1:
            // offered BEFORE the viewer entry (on Load Image the viewer
            // submenu hid the media action at the bottom).
            try {
                const mi = mediaLoaderInfo(node);
                if (mi) {
                    items.push({
                        content: "🎬 Pin media source (preview + upload)",
                        has_submenu: true,
                        submenu: {
                            options: buildMediaSubmenu(node, mi),
                        },
                    });
                }
            } catch (_) { /* detection must never kill the menu */ }
            // v26: viewers that paint straight in onDrawBackground (classic
            // PreviewImage / LoadImage / SaveImage builds, video combiners,
            // custom gallery nodes) own NO widget to pin - offer the whole
            // NODE as one live canvas embed instead.
            if (isViewerNode(node)) {
                items.push({
                    content: "🖼 Pin viewer (live embed)",
                    has_submenu: true,
                    submenu: {
                        options: buildViewerSubmenu(node),
                    },
                });
            }
            return items;
        },
    });
}

/** Helper widgets = buttons WITHOUT any handler (spacers / dead labels).
 *  They carry no state to mirror, no callback worth invoking and no panel
 *  worth embedding - historically the source of mis-pins like "empty space".
 *  Buttons WITH a callable handler are first-class pins since v23 (rgthree
 *  Seed "Randomize Each Time" etc.). */
function isHelperWidget(w) {
    const t = (typeof w?.type === "string" ? w.type : "").trim().toLowerCase();
    if (t !== "button") return false;
    return typeof w?.callback !== "function";
}

/** v26 viewer entries: hub x tab flat list + Create New / New Tab.
 *  Mirrors the panel submenu shape (the Vue menu converter supports ONE
 *  submenu level, so cross products stay flat). */
function buildViewerSubmenu(node) {
    const hubs = allHubs();
    const title = String(node?.title || "").trim().slice(0, 26) || "node";
    const what = `🖼 viewer «${title}»`;
    const bind = (hub, tabId) => createViewerBinding(hub, node, tabId);

    if (!hubs.length) {
        return [{
            content: `${what} → Create New Settings Hub`,
            callback: () => {
                const newHub = createNewHub();
                if (!newHub) return;
                bind(newHub, getActiveTabId(getHubConfig(newHub)));
            },
        }];
    }

    const entries = [];
    for (const hub of hubs) {
        const cfg = getHubConfig(hub);
        const prefix = hubs.length > 1 ? `${hub.title || "Settings Hub"}: ` : "";
        for (const tab of cfg.tabs) {
            entries.push({
                content: `${what} → ${prefix}${tab.name}`,
                callback: () => bind(hub, tab.id),
            });
        }
        entries.push({
            content: `➕ ${what} → ${prefix}New Tab`,
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    bind(hub, tabId);
                }
            },
        });
    }
    return entries;
}

/** v30 media-source entries: hub x tab flat list + Create New / New Tab.
 *  Same shape as the viewer submenu (ONE submenu level in the Vue menu). */
function buildMediaSubmenu(node, mi) {
    const hubs = allHubs();
    const title = String(node?.title || "").trim().slice(0, 26) || "node";
    const what = `🎬 media source «${title}»`;
    const bind = (hub, tabId) => createMediaBinding(hub, node, mi, tabId);

    if (!hubs.length) {
        return [{
            content: `${what} → Create New Settings Hub`,
            callback: () => {
                const newHub = createNewHub();
                if (!newHub) return;
                bind(newHub, getActiveTabId(getHubConfig(newHub)));
            },
        }];
    }

    const entries = [];
    for (const hub of hubs) {
        const cfg = getHubConfig(hub);
        const prefix = hubs.length > 1 ? `${hub.title || "Settings Hub"}: ` : "";
        for (const tab of cfg.tabs) {
            entries.push({
                content: `${what} → ${prefix}${tab.name}`,
                callback: () => bind(hub, tab.id),
            });
        }
        entries.push({
            content: `➕ ${what} → ${prefix}New Tab`,
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    bind(hub, tabId);
                }
            },
        });
    }
    return entries;
}

/** All widgets of the node classified as portals (custom panels).
 *  Universal detection - zero per-custom-node hardcode. */
function listPanelWidgets(node) {
    const out = [];
    for (const w of node.widgets ?? []) {
        try {
            if (isHelperWidget(w) || isInternalWidget(w)) continue;
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
 *  reproduces only pieces, so the preferred action pins them together.
 *
 *  A panel that lives ENTIRELY inside ONE addDOMWidget container (LTX /
 *  MiniMax H3 "LoRA Loader Stack": per-lora rows AND the add-button are all
 *  children of a single element) gets the same friendly whole-panel wording.
 *  Those single-container panels deliberately DO NOT build members[] groups:
 *  mountPortals RELOCATES live DOM containers (all listeners stay native), a
 *  canvas group would only paint nothing. */
function buildWholeBlockEntries(node, panels, hubs) {
    if (!panels || !panels.length) return [];
    const multi = panels.length > 1;
    const loneDomPanel =
        !multi && portalKindOf(panels[0]) === "dom" ? panels[0] : null;
    if (!multi && !loneDomPanel) return [];

    const title = String(node?.title || "").trim().slice(0, 26);
    const what = multi
        ? `whole panel «${title || panelLabel(panels[0])}» (${panels.length} parts)`
        : `whole panel «${title || panelLabel(loneDomPanel)}»`;
    const bindSingle = (hub, tabId) =>
        createBinding(hub, node, loneDomPanel, tabId, undefined,
            { label: node?.title || undefined });
    const bindGroup = (hub, tabId) => createPortalBinding(hub, node, panels, tabId);
    const entries = [];

    if (hubs.length === 0) {
        entries.push({
            content: `🪟 ${what} → Create New Settings Hub`,
            callback: () => {
                const newHub = createNewHub();
                if (!newHub) return; // creation failed - error already surfaced
                const tid = getActiveTabId(getHubConfig(newHub));
                if (loneDomPanel) bindSingle(newHub, tid); else bindGroup(newHub, tid);
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
                callback: () => (loneDomPanel ? bindSingle(hub, tab.id) : bindGroup(hub, tab.id)),
            });
        }
        entries.push({
            content: `➕ ${what} → ${prefix}New Tab`,
            callback: () => {
                const name = prompt("New tab name:", "New Tab");
                if (name !== null) {
                    const tabId = `tab_${Date.now().toString(36)}`;
                    cfg.tabs.push({ id: tabId, name, order: cfg.tabs.length });
                    if (loneDomPanel) bindSingle(hub, tabId); else bindGroup(hub, tabId);
                }
            },
        });
    }
    return entries;
}

/** Flat "candidate -> hub -> tab" entries (the Vue menu converter only
 *  supports ONE submenu level, so cross products stay flat).
 *  Hubs come from the GLOBAL registry, not graph._nodes: from inside a
 *  subgraph the root-canvas hubs must still be offered (they always live
 *  on the root anyway - see createNewHub). */
function buildPanelSubmenu(node, panels) {
    const hubs = allHubs();
    const entries = [];

    // PREFERRED first: the whole custom block as ONE live embed.
    entries.push(...buildWholeBlockEntries(node, panels, hubs));

    if (!hubs.length) {
        for (const w of panels) {
            entries.push({
                content: `🪟 Create New Settings Hub (${panelLabel(w)})`,
                callback: () => {
                    const newHub = createNewHub();
                    if (!newHub) return;
                    createBinding(newHub, node, w, getActiveTabId(getHubConfig(newHub)));
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

function buildPinSubmenu(node, widget) {
    // Global registry again: works identically on the root canvas and inside
    // any subgraph.
    const hubs = allHubs();
    // Custom widgets (non-primitive values / unknown types) become live
    // portals - mark those entries so users know what to expect. Plain
    // action buttons get their own mark: the hub row will RUN them.
    const kind = detectWidgetType(widget);
    const portal = kind === "portal";
    const mark = portal ? "🪟 " : (kind === "button" ? "🔘 " : "📌 ");
    const btnNote = kind === "button" ? " · button" : "";

    if (hubs.length === 0) {
        return [
            {
                content: `${mark}Create New Settings Hub${
                    portal ? " (live embed)" : btnNote}`,
                callback: () => {
                    const newHub = createNewHub();
                    if (!newHub) return; // never leave a bare empty hub behind
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
                    : `${mark}${tab.name}${portal ? " · live" : ""}${btnNote}`,
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

/**
 * Menu entries for a right-click whose owner widget is frontend-INTERNAL
 * ("$$canvas-image-preview" - the hidden DOM container that SHOWS a
 * PreviewImage/SaveImage/VideoCombine preview). Binding it is meaningless
 * (opaque value -> useless text mirror), but the SURFACE under the cursor is
 * exactly the media the user wants in the hub - offer the viewer pin.
 */
function entriesForInternalOwner(node) {
    return isViewerNode(node) ? buildViewerSubmenu(node) : [];
}

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
            // space pointer against the ACTIVE canvas graph (root or sub).
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

        // Internal media containers ($$...) offer the viewer pin only.
        const entries = isInternalWidget(owner.widget)
            ? entriesForInternalOwner(owner.node)
            : [
                // Offer the WHOLE-PANEL group embed first (the widget under the
                // cursor is usually just one row of a multi-widget custom panel),
                // then node-level viewer embeds, then the under-cursor widget pin.
                ...buildWholeBlockEntries(owner.node, listPanelWidgets(owner.node), allHubs()),
                ...(isViewerNode(owner.node) ? buildViewerSubmenu(owner.node) : []),
                ...buildPinSubmenu(owner.node, owner.widget),
            ];
        if (!entries.length) return;

        e.preventDefault();
        e.stopPropagation();
        showHubMenu(e.clientX, e.clientY, entries);
    }, true);
}

// ============================================================================
// 4) Plain RMB over rendered DOM-panel surfaces (LTX LoRA Stack etc.)
// ============================================================================
// Panels drawn ENTIRELY inside an addDOMWidget container have NO canvas
// surface: their elements sit in ComfyUI's DOM overlay, so the LiteGraph
// node menu never fires there and the raw BROWSER menu used to open instead.
// Such surfaces have no native context menu worth preserving -> plain RMB
// offers the standard pin menu. Shift+RMB stays the native escape hatch,
// Ctrl/Cmd belongs to the override listener; text fields and canvas-drawn
// panels keep their dedicated paths above.
function attachPanelSurfacePinMenu() {
    document.addEventListener("contextmenu", (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
        const t = e.target;
        if (!t || typeof t.closest !== "function") return;
        // Never intercept our own UI or panels already relocated into the hub.
        if (t.closest(".hub-menu, .settings-hub-wrap, .hub-portal-host")) return;

        const owner = findDomWidgetOwner(t);
        if (!owner || owner.node.type === HUB_NODE_NAME) return;
        if (isInternalWidget(owner.widget)) {
            // Hidden preview container: viewer pin or nothing.
            const entries = entriesForInternalOwner(owner.node);
            if (!entries.length) return;
            e.preventDefault();
            e.stopPropagation();
            showHubMenu(e.clientX, e.clientY, entries);
            return;
        }
        // Panel-classified widgets only - everything else has its own handler.
        if (detectWidgetType(owner.widget) !== "portal") return;

        const entries = [
            ...buildWholeBlockEntries(owner.node, listPanelWidgets(owner.node), allHubs()),
            ...(isViewerNode(owner.node) ? buildViewerSubmenu(owner.node) : []),
            ...buildPinSubmenu(owner.node, owner.widget),
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
        // Text fields living under our portal rows belong to that mirror:
        // their own menus must stay native, re-pinning them is meaningless.
        if (e.target.closest?.(".hub-portal-host")) return;

        const owner = findDomWidgetOwner(e.target);
        if (!owner || owner.node.type === HUB_NODE_NAME) return;
        if (isInternalWidget(owner.widget)) {
            const entries = entriesForInternalOwner(owner.node);
            if (!entries.length) return;
            e.preventDefault();
            e.stopPropagation();
            showHubMenu(e.clientX, e.clientY, entries);
            return;
        }

        const entries = buildPinSubmenu(owner.node, owner.widget);
        if (!entries.length) return;

        e.preventDefault();
        e.stopPropagation();
        showHubMenu(e.clientX, e.clientY, entries);
    }, true);
}
