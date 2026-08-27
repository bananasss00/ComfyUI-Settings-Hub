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

function localPos(canvas, e, dpr) {
    try {
        const r = canvas.getBoundingClientRect();
        // CSS may scale the canvas down to fit a narrow hub row
        // (max-width:100% + height:auto). Compensate so the forwarded
        // position is ALWAYS in logical draw coordinates - clicks stay
        // pixel-true at any display scale (and any hub width).
        let sx = 1, sy = 1;
        const lw = canvas.width / (dpr || 1);
        const lh = canvas.height / (dpr || 1);
        if (r.width > 0 && lw > 0) sx = lw / r.width;
        if (r.height > 0 && lh > 0) sy = lh / r.height;
        return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
    } catch (_) {
        return [e.clientX || 0, e.clientY || 0];
    }
}

/**
 * Single-pass bitmap scan used by the tick's blank-probe AND the auto-height
 * settle loop. blank -> mode-gated widgets whose draw() is a no-op outside
 * the Vue frontend (TrixNodes: "if (!isVueMode) return;") paint through
 * NODE-level hooks instead (see the foreground fallback). pb -> the LAST
 * painted row, the only measurable truth about "how tall the panel really
 * is" - panels routinely draw far beyond their declared widget slot.
 */
function scanCanvas(canvas) {
    const res = { blank: true, bottom: false, pb: -1 };
    try {
        const ctx = canvas.getContext("2d");
        const w = canvas.width || 1;
        const h = canvas.height || 1;
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y++) {
            const row = y * w * 4;
            for (let x = row + 3; x < row + w * 4; x += 4) {
                if (data[x] !== 0) { res.blank = false; res.pb = y; break; }
            }
        }
        res.bottom = res.pb === h - 1;
        return res;
    } catch (_) {
        // tainted canvas etc. - assume it painted something, never grow
        return { blank: false, bottom: false, pb: -1 };
    }
}

/** Subtle placeholder painted when neither widget nor node hooks render. */
function drawPortalHint(ctx, w, h) {
    try {
        ctx.fillStyle = "#3c3c54";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("⚠ live embed: source panel renders nothing", Math.max(60, w / 2), h / 2);
    } catch (_) {}
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
        // Render routing: undefined = per-widget draw (classic portal),
        // "foreground" = node.onDrawFallback engaged, "blank" = nothing
        // drawable (hint shown). See tick().
        mode: undefined,
        probes: 0,
        // Pixel-settle auto height: signed extra over the formula height.
        // autoH == null means "grace not started yet".
        hAdj: 0,
        autoH: null,
    };

    // --- geometry model ----------------------------------------------------
    // The portal reproduces the SOURCE node's own widget area so that the
    // panel's internal hit-testing (which custom panels derive from the node
    // width / their real row offsets) matches what the user sees:
    //
    //   width  = the source node's widget width. NEVER squeezed into the
    //            hub row - squeezing shifted right-anchored controls
    //            (rgthree arrows, trix toggles) and made clicks activate
    //            the WRONG element, depending on the hub's width. A narrow
    //            row scales the canvas down via CSS (max-width:100% +
    //            height:auto) and localPos() compensates pointer
    //            coordinates back into logical space.
    //   rows   = the source's own widget offsets (widget.last_y) whenever
    //            they are SANE (strictly growing, each step at least the
    //            row's own native height - rows cannot overlap on the real
    //            node), so stacked rows sit EXACTLY where they sit on the
    //            node. Some frontends leave stale/zeroed last_y on custom
    //            widgets - stacking by those collapsed the embed to a
    //            single row (rgthree report), so they are guarded and the
    //            layout falls back to declared native heights + row gap.
    //   height = the row stack as the FLOOR, then a pixel settle loop hugs
    //            the embed to its real content: content touching the last
    //            bitmap row -> grow (+30, capped); clear bottom -> trim to
    //            the painted bottom (+2px). This is what fixes panels that
    //            paint the whole node body from one slot AND nodes that size
    //            themselves WITHOUT the title allowance (TrixNodes sets
    //            size[1] == panel height, so subtracting NODE_TITLE_HEIGHT
    //            - the old bodyH() - cut exactly one row per embed; the
    //            "last target never fits" report). The foreground baseline
    //            is therefore the FULL size[1]; any overshoot is trimmed
    //            back by the same pixel loop within a few ticks.
    const titleTop = () => {
        const th = Number(globalThis.window?.LiteGraph?.NODE_TITLE_HEIGHT);
        return Number.isFinite(th) && th >= 0 ? th : 30;
    };
    const sizeH = () => Math.round(Number(tn.size?.[1]) || 0);
    const nativeHeights = () =>
        members.map((m) => Math.min(widgetNativeHeight(m.widget, m.srcH), 400));
    const cumulativeTops = (hs) => {
        const t = [];
        let y = 0;
        for (const h of hs) { t.push(y); y += h + PORTAL_ROW_GAP; }
        return t;
    };
    // Row tops relative to the FIRST member (title-height agnostic).
    // Sanity-guarded: widgets cannot overlap on the real node, so every step
    // must be >= the row's own native height (small tolerance). Stale or
    // zeroed offsets (all equal - seen on rgthree panels in some frontends)
    // return null -> the safe cumulative fallback is used instead.
    const sourceTops = () => {
        if (!members.length) return null;
        const ly = members.map((m) => Number(m.widget?.last_y));
        if (ly.some((v) => !Number.isFinite(v))) return null;
        const nat = nativeHeights();
        for (let i = 0; i < ly.length - 1; i++) {
            if (ly[i + 1] - ly[i] < nat[i] * 0.9 - 0.5) return null;
        }
        return ly.map((v) => Math.max(0, v - ly[0]));
    };

    const computeLayout = () => {
        let avail = Math.round(host.clientWidth || 0);
        if (!(avail > 0)) avail = Math.max(160, (tn.size?.[0] ?? 340) - 24);
        let W = Math.round(Number(tn.size?.[0]) || 0) - 4;
        if (!(W > 80)) W = Math.max(160, avail);
        W = Math.max(80, Math.min(1600, W));

        const tops = sourceTops();
        const nat = nativeHeights();
        // Draw rows with their NATIVE heights at the source's own offsets -
        // exactly what the node itself does (draw receives widget.height).
        // The simple stack sum is a hard floor for the total height: the
        // embed must never end up shorter than the panel it reproduces.
        const topsArr = tops ?? cumulativeTops(nat);
        const stackH = nat.reduce((a, b) => a + b, 0)
            + PORTAL_ROW_GAP * Math.max(0, nat.length - 1);
        let H0 = topsArr[members.length - 1] + nat[nat.length - 1];
        H0 = Math.max(H0, stackH);
        // Foreground panels ARE the node body; some nodes size themselves
        // to the panel only (size[1] == panel height, no title allowance -
        // TrixNodes). The FULL size[1] is the honest baseline; overshoot
        // (title-sized nodes) is trimmed by the pixel settle loop.
        if (rec.mode === "foreground") H0 = Math.max(H0, sizeH());
        H0 = Math.max(30, Math.min(1600, Math.round(H0)));
        const H = Math.max(30, Math.min(1600, H0 + (rec.hAdj | 0)));
        return { W, H, H0, hs: nat, tops: topsArr };
    };

    const applyGeometry = (g) => {
        if (g.W === rec.W && g.H === rec.H) return;
        rec.W = g.W;
        rec.H = g.H;
        canvas.width = Math.max(1, Math.round(g.W * dpr));
        canvas.height = Math.max(1, Math.round(g.H * dpr));
        // style.width pins the intrinsic logical size; the stylesheet may
        // scale it down (max-width:100%). style.height is NEVER pinned -
        // the aspect ratio must follow the rendered width or clicks drift.
        canvas.style.width = `${g.W}px`;
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

        const g = computeLayout();
        applyGeometry(g); // buffer resize clears the surface automatically

        // Persist live row heights so saved configs restart accurately.
        let dirty = false;
        let total = 0;
        for (let i = 0; i < members.length; i++) {
            const h = Math.round(g.hs[i]);
            total += h + (i < members.length - 1 ? PORTAL_ROW_GAP : 0);
            if (Array.isArray(item.members) && members[i].srcH !== h) {
                members[i].srcH = h;
                if (item.members[i]) item.members[i].srcH = h;
                dirty = true;
            }
        }
        if (dirty) item.options.srcH = Math.round(total);

        // All drawing happens through this wrapper: scaled to CSS pixels,
        // fully cleared every pass (scale FIRST so the clear covers the
        // whole backing buffer at any DPR).
        const paint = (fn) => {
            ctx.save();
            try {
                ctx.scale(dpr, dpr);
                ctx.clearRect(0, 0, rec.W, rec.H);
                fn();
            } catch (_) { /* custom draw code may expect graph-canvas globals */ }
            ctx.restore();
        };

        // Every member paints itself exactly like on its source node,
        // stacked vertically - the same order/layout LiteGraph uses.
        const paintWidgetStack = () => {
            const tops = g.tops ?? cumulativeTops(g.hs);
            for (let i = 0; i < members.length; i++) {
                members[i].widget.draw?.(ctx, tn, rec.W, tops[i], g.hs[i]);
            }
        };

        // Pixel settle loop: the embed must HUG its content. Content
        // touching the last bitmap row -> clipped -> grow (+30, capped);
        // clear bottom -> trim to the painted bottom (+2px). Idempotent at
        // content+2, so it never oscillates; the cap guards against runaway
        // full-body painters.
        const settleAutoHeight = (scan, g) => {
            if (rec.mode === "blank") return;
            if (!rec.autoH) rec.autoH = { grace: 3 };
            const st = rec.autoH;
            if (st.grace > 0) { st.grace--; return; } // let mode probes settle
            if (scan.bottom) {
                const cap = Math.max(g.H0, sizeH()) + titleTop() + 8;
                if (rec.H < cap) rec.hAdj = (rec.hAdj | 0) + 30;
                return;
            }
            if (!(scan.pb >= 0)) return; // tainted canvas - leave as is
            const target = Math.min(1600, Math.ceil(scan.pb / rec.dpr) + 2);
            const adj = Math.max(30 - g.H0, Math.min(1600 - g.H0, target - g.H0));
            if (adj !== (rec.hAdj | 0)) rec.hAdj = adj; // applies next tick
        };

        if (rec.mode === "foreground") {
            // NODE-level render (TrixNodes-style panels). Their hook is in
            // node-local coordinates with the body origin at (0,0) - which
            // is exactly what our portal surface represents.
            paint(() => { tn.onDrawForeground?.call(tn, ctx); });
            const scan = scanCanvas(canvas);
            if (!scan.blank) { settleAutoHeight(scan, g); return; }
            // The hook went dark (frontend mode flipped / node teardown).
            // Re-probe the widget stack instead of leaving a void.
            rec.mode = undefined;
            rec.probes = 0;
            rec.autoH = null;
            rec.hAdj = 0;
            paint(paintWidgetStack);
            const scan2 = scanCanvas(canvas);
            if (!scan2.blank) { settleAutoHeight(scan2, g); return; }
            rec.mode = "blank";
            paint(() => drawPortalHint(ctx, rec.W, rec.H));
            return;
        }

        paint(paintWidgetStack);

        // Probe whether the widget actually painted. The first ticks decide
        // the routing; settled portals run the auto-height loop instead.
        let scan = scanCanvas(canvas);
        if (!scan.blank) {
            if (rec.mode === "blank") { // panel came alive
                rec.mode = undefined;
                rec.probes = 0;
                rec.autoH = null;
                rec.hAdj = 0;
            }
            settleAutoHeight(scan, g);
            return;
        }
        if (rec.mode === "blank") {
            // Keep the hint painted (each pass clears the surface).
            paint(() => drawPortalHint(ctx, rec.W, rec.H));
            return;
        }
        rec.probes++;
        if (rec.probes <= 3 && typeof tn.onDrawForeground === "function") {
            // Mode-gated widget.draw (classic-LiteGraph-only panel):
            // retry through the node's own foreground hook.
            paint(() => { tn.onDrawForeground.call(tn, ctx); });
            scan = scanCanvas(canvas);
            if (!scan.blank) {
                rec.mode = "foreground";
                rec.autoH = null;
                rec.hAdj = 0;
                settleAutoHeight(scan, g);
                return;
            }
        }
        rec.mode = "blank";
        paint(() => drawPortalHint(ctx, rec.W, rec.H));
    };
    rec.tick = tick;

    // Forward pointer interactions. Widget-level mouse() runs FIRST (Vue-
    // frontend panels, rgthree rows). When it does not claim the event
    // (mode-gated widgets return false outside Vue mode), the NODE-level
    // handlers get it with node-local coordinates - our portal surface
    // maps 1:1 onto the node body origin (same contract as onDrawForeground).
    // Row routing uses the SAME layout math as the painter (source last_y
    // offsets when available), and localPos() compensates any CSS scaling -
    // so the row you click is always the row that receives the event.
    const forward = (e) => {
        try {
            const [px, py] = localPos(canvas, e, rec.dpr);
            const g = computeLayout();
            const tops = g.tops;
            let top = tops[0] ?? 0;
            let hit = -1;
            for (let i = 0; i < members.length; i++) {
                top = tops[i];
                // A row owns everything up to the NEXT row's top - source
                // gaps between rows route to the row above, no dead zones.
                const nextTop = i < members.length - 1
                    ? Math.max(tops[i + 1], top + g.hs[i])
                    : top + g.hs[i];
                if (py >= top && py < nextTop) { hit = i; break; }
            }
            if (hit < 0) {
                hit = members.length - 1;                 // past the last row
                top = tops[hit] ?? 0;
            }
            const pos = [px, py - top];
            let handled = false;
            try { handled = !!members[hit].widget.mouse?.(e, pos, tn); } catch (_) { handled = true; }
            if (handled) return;
            const fn = e.type === "pointerdown" ? tn.onMouseDown
                : e.type === "pointerup" ? tn.onMouseUp
                : e.type === "pointermove" ? tn.onMouseMove
                : null;
            if (typeof fn === "function") {
                fn.call(tn, e, pos, app.canvas);
            }
        } catch (_) {}
    };
    rec.handlers = {
        pointerdown: (e) => { forward(e); },
        pointerup: (e) => { forward(e); },
        pointermove: (e) => { forward(e); },
        pointerleave: (e) => {
            // Legacy drag cancellation lives on the node (widget level has
            // no leave concept) - best effort, never swallows anything.
            try {
                const [px, py] = localPos(canvas, e, rec.dpr);
                tn.onMouseLeave?.call(tn, e, [px, py], app.canvas);
            } catch (_) {}
        },
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
