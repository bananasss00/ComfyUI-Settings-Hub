// ============================================================================
// SettingsHub - universal custom-widget portals ("live embed")
// ----------------------------------------------------------------------------
// Some widgets are not primitive controls at all: rgthree's Power Lora Loader
// panel, image pickers, custom DOM panels... For those the hub creates a
// PORTAL binding (core.js classifies them universally: non-primitive value or
// unknown type -> portal). Two embed flavors, zero per-node code:
//
//   dom    - the widget owns a real element (element/inputEl/contentEl).
//            The element is physically RELOCATED into the hub with all its
//            listeners, so its own buttons AND its own custom context menu
//            keep working natively. On release it returns to its original
//            place. A `.hub-portal-held` style clamp defeats ComfyUI's
//            per-frame inline positioning (position/top/left...).
//
//   canvas - the widget paints itself (draw()). The portal hosts a <canvas>
//            that continuously re-renders via the widget's own draw(), and
//            forwards pointer events (incl. right-click) to the widget's
//            mouse() - so the widget's OWN context menu opens right there,
//            exactly as it does on the source node.
//
// Portals are deliberately EXCLUDED from presets: there is no universal way
// to serialize/restore complex widget states across custom nodes.
// ============================================================================

import { app } from "../../scripts/app.js";
import { getHubConfig, PORTAL_ROW_GAP, widgetNativeHeight } from "./core.js";

/** node -> Set<record>; records live between structural renders. */
const nodeRegistry = new WeakMap();

function findWidget(item) {
    const tn = app.graph?.getNodeById?.(item.targetNodeId);
    const tw = tn?.widgets?.find((w) => w.name === item.widgetToBind);
    return { tn, tw };
}

/**
 * Resolve the live widget objects behind a portal item. Group items
 * ("whole panel") carry item.members[]; legacy single portals fall back to
 * widgetToBind. Members that disappeared are skipped (partial survives).
 */
function resolveMembers(item, tn) {
    const list = Array.isArray(item.members) && item.members.length
        ? item.members
        : [{ name: item.widgetToBind, srcH: Number(item.options?.srcH) || 30 }];
    const out = [];
    for (const m of list) {
        const tw = tn.widgets?.find((w) => w.name === m.name);
        if (tw) out.push({ widget: tw, srcH: Number(m.srcH) > 0 ? Number(m.srcH) : 30 });
    }
    return out;
}

// ---------------------------------------------------------------------------
// DOM relocation flavor
// ---------------------------------------------------------------------------

function mountDomPortal(item, tw, host) {
    const el = tw.element ?? tw.inputEl ?? tw.contentEl;
    if (!el || typeof el.appendChild !== "function") return null;

    const rec = {
        kind: "dom",
        item,
        el,
        host,
        // Where to put the element back + its own inline styles (ComfyUI
        // rewrites top/left/width/height every frame; we snapshot once and
        // restore verbatim on release).
        saved: {
            parent: el.parentNode,
            next: el.nextSibling,
            css: el.getAttribute("style"),
        },
    };
    try {
        el.classList.add("hub-portal-held");
        host.textContent = "";
        host.appendChild(el); // appendChild MOVES the node (listeners kept)
        return rec;
    } catch (err) {
        console.warn("[SettingsHub] dom portal mount failed:", err);
        el.classList.remove("hub-portal-held");
        return null;
    }
}

function releaseDom(rec) {
    const { el, saved } = rec;
    try { el.classList.remove("hub-portal-held"); } catch (_) {}
    try {
        if (saved.parent) {
            if (saved.next && saved.next.parentNode === saved.parent) {
                saved.parent.insertBefore(el, saved.next);
            } else {
                saved.parent.appendChild(el);
            }
        }
    } catch (_) {}
    try {
        if (saved.css === null) el.removeAttribute("style");
        else el.setAttribute("style", saved.css);
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Canvas re-render flavor
// ---------------------------------------------------------------------------

function localPos(canvas, e) {
    try {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    } catch (_) {
        return [e.clientX || 0, e.clientY || 0];
    }
}

function mountCanvasPortal(node, item, tn, members, host) {
    const canvas = document.createElement("canvas");
    canvas.className = "hub-portal-canvas";
    canvas.title = "Live embed - click / right-click to use the source widget";
    host.textContent = "";
    host.appendChild(canvas);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rec = {
        kind: "canvas", item, tn, members, canvas, host, dpr,
        W: 0, H: 0, timer: null, stale: 0, handlers: null,
    };

    // Live row tracking: native growth (a lora added on the source node),
    // hub resizing or viewport changes are all picked up WITHIN ONE TICK -
    // no tab switch / page reload needed anymore.
    const rowHeights = () =>
        members.map((m) => Math.min(widgetNativeHeight(m.widget, m.srcH), 400));

    // Authentic-size geometry: the draw width mirrors the SOURCE node's
    // widget area (capped by what the hub row offers), and the CSS display
    // size stays 1:1 with the backing buffer - so the embed reproduces the
    // original styling/sizes instead of being stretched into the row.
    const desired = () => {
        let avail = Math.round(host.clientWidth || 0);
        if (!(avail > 0)) avail = Math.max(160, (node.size?.[0] ?? 340) - 24);
        let cap = Math.round(Number(tn.size?.[0]) || 340) - 14;
        if (!(cap > 80)) cap = avail;
        const hs = rowHeights();
        const H = Math.min(
            1600,
            hs.reduce((a, b) => a + b, 0)
                + PORTAL_ROW_GAP * Math.max(0, hs.length - 1),
        );
        return { W: Math.max(80, Math.min(avail, cap)), H, hs };
    };

    const applyGeometry = (g) => {
        if (g.W === rec.W && g.H === rec.H) return;
        rec.W = g.W;
        rec.H = g.H;
        canvas.width = Math.max(1, Math.round(g.W * dpr));
        canvas.height = Math.max(1, Math.round(g.H * dpr));
        canvas.style.width = `${g.W}px`;
        canvas.style.height = `${g.H}px`;
    };

    const tick = () => {
        // Self-cleanup when the portal row was destroyed without a release
        // (node deleted while graph busy) - no orphaned intervals.
        if (!canvas.isConnected) {
            if (++rec.stale > 5) releaseRecord(rec);
            return;
        }
        rec.stale = 0;
        if (node.flags?.collapsed || document.hidden) return;
        let ctx = null;
        try { ctx = canvas.getContext("2d"); } catch (_) { ctx = null; }
        if (!ctx) return;

        const g = desired();
        applyGeometry(g); // buffer resize clears the surface automatically

        // Persist live row heights so saved configs restart accurately.
        let dirty = false;
        let total = 0;
        for (let i = 0; i < members.length; i++) {
            const h = Math.round(Math.min(widgetNativeHeight(members[i].widget, members[i].srcH), 400));
            total += h + (i < members.length - 1 ? PORTAL_ROW_GAP : 0);
            if (Array.isArray(item.members) && members[i].srcH !== h) {
                members[i].srcH = h;
                if (item.members[i]) item.members[i].srcH = h;
                dirty = true;
            }
        }
        if (dirty) item.options.srcH = Math.round(total);

        try {
            ctx.save();
            ctx.clearRect(0, 0, rec.W, rec.H);
            ctx.scale(dpr, dpr);
            // Every member paints itself exactly like on its source node,
            // stacked vertically - the same order/layout LiteGraph uses.
            let y = 0;
            for (let i = 0; i < members.length; i++) {
                const h = g.hs[i];
                members[i].widget.draw?.(ctx, tn, rec.W, y, h);
                y += h + PORTAL_ROW_GAP;
            }
            ctx.restore();
        } catch (_) { /* custom draw code may expect graph-canvas globals */ }
    };
    rec.tick = tick;

    // Forward pointer interactions (incl. RMB -> each widget's own menu).
    const forward = (e) => {
        try {
            const [px, py] = localPos(canvas, e);
            const hs = rowHeights();
            let top = 0;
            let hit = -1;
            for (let i = 0; i < members.length; i++) {
                if (py >= top && py < top + hs[i]) { hit = i; break; }
                top += hs[i] + PORTAL_ROW_GAP;
            }
            if (hit < 0) {
                hit = members.length - 1;                 // past the last row
                top = Math.max(0, top - PORTAL_ROW_GAP - hs[hit]);
            }
            members[hit].widget.mouse?.(e, [px, py - top], tn);
        } catch (_) {}
    };
    rec.handlers = {
        pointerdown: (e) => { forward(e); },
        pointerup: (e) => { forward(e); },
        wheel: (e) => { e.preventDefault(); forward(e); },
        contextmenu: (e) => {
            // The source widget's custom menu handles this (rgthree etc.).
            e.preventDefault();
            e.stopPropagation();
            forward(e);
        },
    };
    for (const [type, fn] of Object.entries(rec.handlers)) {
        canvas.addEventListener(type, fn, { passive: false });
    }

    tick(); // immediate first paint at the already-final geometry
    rec.timer = setInterval(tick, 80); // ~12fps: light but alive
    return rec;
}

function releaseCanvas(rec) {
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    if (rec.handlers) {
        for (const [type, fn] of Object.entries(rec.handlers)) {
            try { rec.canvas.removeEventListener(type, fn); } catch (_) {}
        }
        rec.handlers = null;
    }
    try { rec.canvas.remove(); } catch (_) {}
}

function releaseRecord(rec) {
    if (rec.kind === "dom") releaseDom(rec);
    else releaseCanvas(rec);
    try { rec.set?.delete(rec); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Mount / release API (called by hub_ui_renderer around structural renders)
// ---------------------------------------------------------------------------

/**
 * Attach every portal item of the hub that has a rendered
 * `[data-role="portal-host"]` row. Called AFTER each structural render.
 */
export function mountPortals(node, root) {
    if (!node || node.type !== "SettingsHub" || !root) return;
    const cfg = getHubConfig(node);

    let set = nodeRegistry.get(node);
    if (!set) { set = new Set(); nodeRegistry.set(node, set); }
    for (const rec of [...set]) releaseRecord(rec);
    set.clear();

    for (const item of cfg.items) {
        if (item.type !== "widget_portal") continue;
        const host = root.querySelector(
            `[data-hub-item="${item.id}"] [data-role="portal-host"]`,
        );
        if (!host) continue;
        const { tn } = findWidget(item);
        const members = tn ? resolveMembers(item, tn) : [];
        if (!tn || !members.length) {
            host.textContent = "⚠️ target node / widget missing";
            host.classList.add("hub-portal-broken");
            continue;
        }
        host.classList.remove("hub-portal-broken");
        let rec = null;
        // Only LEGACY single portals without members[] may relocate a DOM
        // element; group embeds render onto their shared canvas.
        if ((item.options?.portalKind ?? "canvas") === "dom"
            && !Array.isArray(item.members)) {
            rec = mountDomPortal(item, members[0].widget, host);
        }
        if (!rec) rec = mountCanvasPortal(node, item, tn, members, host);
        if (rec) { rec.set = set; set.add(rec); }
    }
}

/** Release everything this hub currently holds (before innerHTML swap!). */
export function releaseAll(node) {
    const set = node && nodeRegistry.get(node);
    if (!set) return;
    for (const rec of [...set]) releaseRecord(rec);
    set.clear();
}

/** Immediate draw+geometry pass over a hub's mounted canvas portals
 *  (used by the smoke harness; harmless no-op for DOM portals). */
export function runPortalTicks(node) {
    const set = node && nodeRegistry.get(node);
    if (!set) return;
    for (const rec of [...set]) {
        if (rec.kind === "canvas" && typeof rec.tick === "function") {
            try { rec.tick(); } catch (_) {}
        }
    }
}

/** Release a single portal (unpin / item removal). */
export function releaseItem(node, item) {
    const set = node && nodeRegistry.get(node);
    if (!set) return;
    for (const rec of [...set]) {
        if (rec.item?.id === item?.id) {
            releaseRecord(rec);
            set.delete(rec);
        }
    }
}
