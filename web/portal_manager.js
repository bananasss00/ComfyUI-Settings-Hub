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
import { getHubConfig } from "./core.js";

/** node -> Set<record>; records live between structural renders. */
const nodeRegistry = new WeakMap();

function findWidget(item) {
    const tn = app.graph?.getNodeById?.(item.targetNodeId);
    const tw = tn?.widgets?.find((w) => w.name === item.widgetToBind);
    return { tn, tw };
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

function mountCanvasPortal(node, item, tn, tw, host) {
    const srcHRaw = Number(item.options?.srcH);
    const srcH = Number.isFinite(srcHRaw) && srcHRaw > 0 ? Math.min(400, Math.max(36, srcHRaw)) : 60;

    const canvas = document.createElement("canvas");
    canvas.className = "hub-portal-canvas";
    canvas.title = "Live embed - click / right-click to use the source widget";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(
        160,
        host.clientWidth || (node.size?.[0] ?? 340) - 24,
    );
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(srcH * dpr);
    canvas.style.height = `${srcH}px`;
    host.textContent = "";
    host.appendChild(canvas);

    const rec = { kind: "canvas", item, tn, tw, canvas, host, timer: null, stale: 0, handlers: null };

    const drawOnce = () => {
        // Self-cleanup when the portal row was destroyed without a release
        // (node deleted while graph busy) - no orphaned intervals.
        if (!canvas.isConnected) {
            if (++rec.stale > 5) releaseRecord(rec);
            return;
        }
        rec.stale = 0;
        if (node.flags?.collapsed || document.hidden) return;
        try {
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.save();
            ctx.clearRect(0, 0, w, h);
            ctx.scale(dpr, dpr);
            // The widget paints itself exactly like on its source node.
            // y=0 keeps draw-space and mouse()-hitbox space aligned.
            rec.tw.draw?.(ctx, rec.tn, w, 0, h);
            ctx.restore();
        } catch (_) { /* custom draw code may expect graph-canvas globals */ }
    };

    // Forward pointer interactions (incl. RMB -> the widget's own menu).
    const forward = (e) => {
        try { rec.tw.mouse?.(e, localPos(canvas, e), rec.tn); } catch (_) {}
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

    drawOnce(); // immediate first paint
    rec.timer = setInterval(drawOnce, 80); // ~12fps: light but alive
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
        const { tn, tw } = findWidget(item);
        if (!tn || !tw) {
            host.textContent = "⚠️ target node / widget missing";
            host.classList.add("hub-portal-broken");
            continue;
        }
        host.classList.remove("hub-portal-broken");
        let rec = null;
        if ((item.options?.portalKind ?? "canvas") === "dom") {
            rec = mountDomPortal(item, tw, host);
        }
        if (!rec) rec = mountCanvasPortal(node, item, tn, tw, host);
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
