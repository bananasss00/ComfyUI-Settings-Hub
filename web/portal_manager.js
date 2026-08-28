// ============================================================================
// SettingsHub - universal custom-widget portals ("live embed")
// ----------------------------------------------------------------------------
// Some widgets are not primitive controls at all: rgthree's Power Lora Loader
// panel, image pickers, custom DOM panels... For those the hub creates a
// PORTAL binding (core.js classifies them universally: non-primitive value or
// unknown type -> portal). Two embed flavors, zero per-node code:
//
//   dom    - the widget owns a real element (element/inputEl/contentEl).
//            GHOST MIRROR (non-destructive): the hub shows a LIVE CLONE of
//            the panel; the ORIGINAL never leaves its node and stays fully
//            functional there. Interaction routing:
//              clone -> original  real DOM events on the clone are
//                                 re-dispatched on the matching original
//                                 element (index-path correspondence), with
//                                 value/checked copied BEFORE dispatch, so
//                                 the pack's own listeners drive the state;
//              original -> clone  a subtree MutationObserver debounces
//                                 structural/attr/text changes into a
//                                 full re-clone swap.
//            Feedback-safe by construction: we observe ONLY the original,
//            value copying uses properties (no attr writes, no echo).
//            Rebuilds defer while the user is mid-interaction (focus or
//            recent pointer/key inside the clone) - no lost keystrokes,
//            no closed popups.
//
//            Historical note: pins used to RELOCATE the element into the
//            hub ("live embed"). That stole the panel from its node and
//            fought ComfyUI's show/hide remounts (zoom cycles yanked it
//            back) - ghosts make both problem classes impossible.
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
import {
    getHubConfig, PORTAL_ROW_GAP, widgetNativeHeight, resolveBindingTarget,
    findWidgetOnNode,
} from "./core.js";
import { getVideoAudio, setVideoAudio, applyVideoAudio } from "./global_settings.js";
import { mountImageGallery, closeGalleryFullscreen, downloadMediaUrl } from "./viewer_gallery.js";

/** node -> Set<record>; records live between structural renders. */
const nodeRegistry = new WeakMap();

/** Cross-graph lookup: portal sources may live inside any subgraph. */
function findWidget(item) {
    const tn = resolveBindingTarget(item);
    const tw = findWidgetOnNode(tn, item.widgetToBind, item.widgetOrd);
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
        // v30: m.ord disambiguates same-name widget families (rgthree rows).
        const tw = findWidgetOnNode(tn, m.name, m.ord);
        if (tw) out.push({ widget: tw, srcH: Number(m.srcH) > 0 ? Number(m.srcH) : 30 });
    }
    return out;
}

// ---------------------------------------------------------------------------
// DOM ghost-mirror flavor (the original stays on its node)
// ---------------------------------------------------------------------------

const GHOST_CLASS = "hub-portal-ghost";
// v32: opt-in layout surrender for roots that POSITION THEMSELVES
// (computed absolute/fixed). Everything else keeps its own layout system -
// see mountDomPortal / styles.css for the full story.
const FLOAT_CLASS = "hub-portal-ghost-float";
const SYNC_DEBOUNCE = 180;   // batch bursts of original-side mutations
const RETRY_DELAY = 400;     // re-check the interaction lock later
const TOUCH_LOCK = 900;      // ms after clone interaction before rebuilds

/**
 * True for elements whose focus means "the user is mid-typing or a native
 * popup is open": swapping the ghost under them would eat keystrokes or
 * close the popup. Plain focusable elements (buttons, toggles, labels) do
 * NOT count - Chromium focuses a clicked <button> and that focus STAYS on
 * it until something else is clicked; treating it as "busy" held the
 * original->clone rebuild forever (the "hub updates only when I pan the
 * graph" class of bugs, reported on token toggles and other custom nodes).
 */
function isTextEntry(n) {
    try {
        const tag = n?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
        if (n?.isContentEditable) return true;
    } catch (_) {}
    return false;
}

/** Element-only child index path from `root` down to `node` (or null). */
function indexPath(root, node) {
    const path = [];
    let cur = node;
    while (cur && cur !== root) {
        const p = cur.parentElement;
        if (!p) return null;
        path.push(Array.from(p.children).indexOf(cur));
        cur = p;
    }
    return cur === root ? path.reverse() : null;
}

function mountDomPortal(item, tw, host, opts = {}) {
    const el = tw.element ?? tw.inputEl ?? tw.contentEl;
    if (!el || typeof el.appendChild !== "function") return null;
    // Constructor access via window: some extension realms lack bare globals.
    const win = globalThis.window;
    const MO = typeof MutationObserver !== "undefined"
        ? MutationObserver : win?.MutationObserver ?? null;
    if (!MO) return null;

    let clone;
    try { clone = el.cloneNode(true); } catch (_) { return null; }
    try {
        clone.classList.add(GHOST_CLASS);
        // v32: the hard display/position flattening used to break
        // self-laid-out panels - the KJNodes Model Preview Override mirror
        // lost its flex column, its absolute-fill preview image escaped the
        // image area (the hub host is position:relative) and the opaque
        // info panel painted over the picture. Only roots that position
        // THEMSELVES (the panels the hard rules were written for) get the
        // legacy detach treatment now.
        let cs = null;
        try { cs = win.getComputedStyle ? win.getComputedStyle(el) : null; } catch (_) {}
        const pos = String(cs?.position || "").toLowerCase();
        if (pos === "absolute" || pos === "fixed") {
            clone.classList.add(FLOAT_CLASS);
        }
    } catch (_) {}

    const rec = {
        kind: "dom",
        item,
        el,             // the ORIGINAL - never moved, only observed
        clone,
        host,
        releasing: false,
        dead: false,
        syncQueued: false,
        lastTouch: 0,
        observer: null,
        handlers: [],   // [type, fn] pairs bound on the current clone
        touchHandler: null,
        // v26.1 viewer mounts: media-aware ghost (aspect fixes + playhead
        // sync for <video> mirrors).
        viewer: !!opts.viewer,
        videoSync: [],  // [sourceVideo, timeupdateFn] pairs
        // v27.4: baseline of inline textarea heights taken right after each
        // (re)apply - lets us tell a real user resize apart from a plain
        // click on a textarea that merely carries the SOURCE widget height.
        ghostTszBase: null,
    };

    // --- clone -> original: re-dispatch real events on the counterpart ---
    const counterpart = (target) => {
        const path = indexPath(clone, target);
        if (!path) return null;
        let node = el;
        for (const idx of path) {
            node = node?.children?.[idx] ?? null;
            if (!node) return null;   // structure drifted - sync will catch up
        }
        return node;
    };
    const forward = (e) => {
        try {
            if (!clone.contains(e.target)) return;         // bubbling guests
            const origTarget = counterpart(e.target);
            if (!origTarget || e.hubForwarded) return;
            // Carry typed state over first - their handler reads .value/.checked.
            if ("value" in origTarget && "value" in e.target && origTarget.value !== e.target.value) {
                origTarget.value = e.target.value;
            }
            if ("checked" in origTarget && "checked" in e.target) {
                origTarget.checked = e.target.checked;
            }
            const Evt = win?.Event || Event;
            const ne = new Evt(e.type, { bubbles: true, cancelable: true });
            try {
                for (const k of ["clientX", "clientY", "button", "detail", "key", "code"] ) {
                    if (e[k] !== undefined) ne[k] = e[k];
                }
                for (const k of ["ctrlKey", "shiftKey", "altKey", "metaKey"]) ne[k] = !!e[k];
            } catch (_) {}
            try { Object.defineProperty(ne, "hubForwarded", { value: true }); } catch (_) {}
            origTarget.dispatchEvent(ne);
        } catch (_) { /* a half-detached tree must never break rendering */ }
    };
    const TYPES = ["click", "auxclick", "dblclick", "pointerdown", "pointerup",
        "pointermove", "mousedown", "mouseup", "mousemove", "keydown", "keyup",
        "input", "change"];
    const bindClone = (target) => {
        for (const t of TYPES) {
            const fn = forward;
            target.addEventListener(t, fn);
            rec.handlers.push([t, fn, target]);
        }
        // Capture-phase interaction tracker. Any touch arms TOUCH_LOCK so a
        // rebuild cannot land mid-gesture (a swapped clone would eat a
        // pending click: its target would belong to the detached subtree and
        // the router would drop it). A completed "click" RELEASES the lock
        // synchronously - click always fires after the gesture finished and
        // its forward+dispatch is one synchronous task, so the mutation it
        // causes may rebuild on the very next debounce tick (~180ms) instead
        // of idling out the full TOUCH_LOCK. Drag events keep the lock armed
        // (the browser fires them continuously and suppresses click).
        rec.touchHandler = (e) => {
            rec.lastTouch = e?.type === "click" ? 0 : Date.now();
        };
        // v32: pointermove/mousemove extend the lock too - a drag gesture
        // longer than TOUCH_LOCK (split grips, native sliders) used to lose
        // its protection and a rebuild could land mid-drag.
        for (const t of ["pointerdown", "pointermove", "mousemove", "wheel",
            "keydown", "input", "focusin",
            "dragstart", "drag", "dragend", "drop", "pointercancel", "click"]) {
            target.addEventListener(t, rec.touchHandler, { capture: true, passive: true });
        }
        // v27.4: end of a native textarea grip drag inside the ghost -
        // persist the new height(s). pointerup covers mouse/pen/touch,
        // mouseup is a belt-and-braces fallback; both are idempotent.
        target.addEventListener("pointerup", captureGhostTextHs);
        target.addEventListener("mouseup", captureGhostTextHs);
        rec.handlers.push(["pointerup", captureGhostTextHs, target]);
        rec.handlers.push(["mouseup", captureGhostTextHs, target]);
        // v32: local split-grip drag (see splitDrag above).
        target.addEventListener("mousedown", splitDrag);
        rec.handlers.push(["mousedown", splitDrag, target]);
    };
    // --- v32: local split-grip drag inside the ghost ----------------------
    // Panels like KJNodes' Model Preview Override put an ns-resize grip
    // between a flex-grow media area and a fixed-height info panel. The
    // pack's own grip handler resizes the ORIGINAL panel only, so the ghost
    // used to follow through delayed rebuilds (which could even land
    // mid-drag - pointermove did not extend the touch lock). A grip gesture
    // now ALSO drives a local drag on the clone: instant feedback with the
    // same clamp contract as the source (panel >= 60px, media keeps
    // >= 80px), while the forwarded events keep updating the original node
    // in sync - on release the rebuild lands with both sides equal.
    const splitDrag = (ev) => {
        try {
            if (ev.button !== 0) return;
            let grip = null;
            let t = ev.target;
            for (let i = 0; t && t !== clone && i < 6; i++) {
                let cur = "";
                try {
                    cur = String(win.getComputedStyle(t)?.cursor || "").toLowerCase();
                } catch (_) {}
                if (cur === "ns-resize" || cur === "row-resize") { grip = t; break; }
                t = t.parentElement;
            }
            if (!grip) return;
            const panel = grip.nextElementSibling;
            if (!panel) return;
            const startY = Number(ev.clientY) || 0;
            const startH = (panel.getBoundingClientRect?.().height
                || panel.offsetHeight
                || parseFloat(panel.style?.height) || 0);
            if (!(startH > 0)) return;
            // Live root height; falls back to the persisted mirror height
            // for layout-less environments (smoke harness).
            const rootH = (clone.getBoundingClientRect?.().height
                || Number(rec.item?.ghostSplitH) || 0);
            const maxH = rootH > 0
                ? Math.max(60, rootH - 80)
                : Math.max(60, startH + 200);
            const move = (e2) => {
                const y = Number(e2.clientY) || 0;
                const nh = Math.max(60, Math.min(maxH, startH + (startY - y)));
                try { panel.style.height = `${Math.round(nh)}px`; } catch (_) {}
            };
            const up = () => {
                try { win.removeEventListener("mousemove", move); } catch (_) {}
                try { win.removeEventListener("mouseup", up); } catch (_) {}
            };
            win.addEventListener("mousemove", move);
            win.addEventListener("mouseup", up);
        } catch (_) { /* interaction plumbing must never throw */ }
    };

    const unbindClone = (target) => {
        for (const [t, fn, elem] of rec.handlers.splice(0)) {
            try { elem.removeEventListener(t, fn); } catch (_) {}
        }
        for (const t of ["pointerdown", "pointermove", "mousemove", "wheel",
            "keydown", "input", "focusin",
            "dragstart", "drag", "dragend", "drop", "pointercancel", "click"]) {
            try { target?.removeEventListener(t, rec.touchHandler, { capture: true }); } catch (_) {}
        }
    };
    rec.unbind = () => unbindClone(rec.clone);

    // --- v27.4: user-resized ghost textareas ------------------------------
    // The native resize grip writes inline height while the user drags; we
    // persist those px per item (item.ghostTextHs, one entry per textarea in
    // querySelectorAll order - serialized with the graph) and re-apply after
    // the initial mount AND after every re-clone swap, which would otherwise
    // reset the mirror to the source widget's own height. The baseline
    // snapshot taken right after each apply keeps a plain click from saving
    // the source height (a fresh clone legally carries it).
    const ghostTextareas = (rootEl) => {
        try {
            if (!rootEl?.querySelectorAll) return [];
            // The ghost ROOT itself may be the editor (DOM widgets whose
            // element IS the textarea, not a wrapper around it).
            return rootEl.tagName === "TEXTAREA"
                ? [rootEl]
                : rootEl.querySelectorAll("textarea");
        } catch (_) { return []; }
    };
    const applyGhostTextHs = (rootEl) => {
        try {
            const hs = rec.item?.ghostTextHs;
            const tas = ghostTextareas(rootEl);
            const base = [];
            for (let i = 0; i < tas.length; i++) {
                const saved = Number(Array.isArray(hs) ? hs[i] : NaN);
                if (Number.isFinite(saved) && saved > 0) {
                    tas[i].style.height = `${saved}px`;
                    base.push(saved);
                } else {
                    const cur = parseFloat(tas[i]?.style?.height);
                    base.push(Number.isFinite(cur) && cur > 0 ? cur : 0);
                }
            }
            rec.ghostTszBase = base;
        } catch (_) { rec.ghostTszBase = null; }
    };
    const captureGhostTextHs = () => {
        try {
            const tas = ghostTextareas(rec.clone);
            if (!tas.length || !rec.item) return;
            const base = Array.isArray(rec.ghostTszBase) ? rec.ghostTszBase : [];
            const next = [];
            let changed = false;
            for (let i = 0; i < tas.length; i++) {
                const cur = parseFloat(tas[i]?.style?.height);
                const v = Number.isFinite(cur) && cur > 0 ? Math.round(cur) : 0;
                next.push(v);
                if (v > 0 && v !== (Number(base[i]) || 0)) changed = true;
            }
            rec.ghostTszBase = next;
            if (changed) rec.item.ghostTextHs = next;
        } catch (_) {}
    };

    // --- v32: mirror the source panel's own height ------------------------
    // A flex-column panel root (KJNodes Model Preview Override: flex:1
    // image area over a fixed-height info panel) lays out against its own
    // height. In the node that height comes from the widget box; in the hub
    // a content-sized clone collapses the image area to its min-height and
    // the grip drag has nothing to redistribute. Capture the source's
    // offsetHeight once (transform-independent, works for off-viewport
    // nodes), persist it per item and re-apply after every re-clone swap -
    // the hub mirror keeps the node's image/info split and the grip behaves
    // 1:1 with the node. Non-flex roots are untouched (legacy behavior).
    const applyGhostPanelSize = (rootEl) => {
        try {
            if (!rootEl?.style) return;
            const cs = win.getComputedStyle ? win.getComputedStyle(rootEl) : null;
            if (String(cs?.display || "").toLowerCase().indexOf("flex") < 0) return;
            if (String(cs?.flexDirection || "").toLowerCase() !== "column") return;
            const saved = Number(rec.item?.ghostSplitH);
            if (Number.isFinite(saved) && saved >= 60) {
                rootEl.style.height = `${Math.round(saved)}px`;
                return;
            }
            const oh = Math.round(el.offsetHeight || 0);
            if (oh >= 60) {
                rec.item.ghostSplitH = oh;
                rootEl.style.height = `${oh}px`;
            }
        } catch (_) { /* cosmetics must never break the mount */ }
    };

    // --- original -> clone: debounced full re-clone swap ----------------
    // Defer ONLY while the user is mid-typing / a native popup is open.
    // Button/toggle focus (which Chromium keeps on the clicked element until
    // something else is clicked) must never hold the mirror stale - see
    // isTextEntry(): that made click-driven source changes visible only
    // after the graph moved (panning blurs the button).
    const busyLocked = () => {
        try {
            const ae = document.activeElement;
            if (ae && rec.clone.contains(ae) && isTextEntry(ae)) return true;
        } catch (_) {}
        return Date.now() - rec.lastTouch < TOUCH_LOCK;         // drag/menu open
    };
    const rebuild = () => {
        if (rec.releasing || rec.dead || !el.isConnected) return;
        let fresh;
        try { fresh = el.cloneNode(true); } catch (_) { return; }
        try { fresh.classList.add(GHOST_CLASS); } catch (_) {}
        // Carry non-text focus across the swap (keyboard-operated toggles
        // keep working); text-entry focus is held by busyLocked() and can
        // never reach this point.
        let refocusPath = null;
        try {
            const ae = document.activeElement;
            if (ae && rec.clone.contains(ae)) refocusPath = indexPath(rec.clone, ae);
        } catch (_) {}
        unbindClone(rec.clone);
        rec.clone.remove();
        // Keep the closure's `clone` reference on the LIVE mirror - the
        // event router computes counterparts against this exact subtree.
        clone = fresh;
        bindClone(fresh);
        try { host.appendChild(fresh); } catch (_) { return; }
        rec.clone = fresh;
        if (refocusPath) {
            try {
                let n = fresh;
                for (const idx of refocusPath) {
                    n = n?.children?.[idx] ?? null;
                    if (!n) break;
                }
                if (n && typeof n.focus === "function") n.focus({ preventScroll: true });
            } catch (_) {}
        }
        normalizeGhostMedia(rec, fresh);
        applyGhostTextHs(fresh); // v27.4: restore user-resized textareas
        applyGhostPanelSize(fresh); // v32: keep the node's image/info split
        if (rec.viewer) syncViewerVideoTime(rec);
    };
    const scheduleSync = (delay = SYNC_DEBOUNCE) => {
        if (rec.syncQueued || rec.releasing || rec.dead) return;
        rec.syncQueued = true;
        setTimeout(() => {
            rec.syncQueued = false;
            if (rec.releasing || rec.dead) return;
            if (busyLocked()) { scheduleSync(RETRY_DELAY); return; } // deferred, not dropped
            rebuild();
        }, delay);
    };
    rec.observer = new MO(() => scheduleSync());
    try {
        rec.observer.observe(el, {
            childList: true, subtree: true,
            attributes: true, characterData: true,
        });
    } catch (_) {
        rec.observer.disconnect();
        rec.observer = null;
        return null;
    }

    try {
        keepPortalTag(host);
        host.appendChild(clone);
    } catch (err) {
        console.warn("[SettingsHub] dom ghost mount failed:", err);
        rec.observer.disconnect();
        rec.observer = null;
        return null;
    }
    bindClone(rec.clone);
    // v26.1: media inside the ghost must survive the hub row (viewer embeds
    // and video-preview panels used to come out cropped).
    normalizeGhostMedia(rec, rec.clone);
    applyGhostTextHs(rec.clone); // v27.4: restore user-resized textareas
    applyGhostPanelSize(rec.clone); // v32: keep the node's image/info split
    if (rec.viewer) syncViewerVideos(rec);
    return rec;
}

/**
 * Media inside a ghost keeps its node-baked inline geometry, which crops it
 * inside the (usually narrower) hub row. Aspect-correct the media and let
 * the row hug it. Canvas elements are normalized for VIEWER mounts only -
 * in interactive panels a canvas is usually functional UI, not media.
 */
function normalizeGhostMedia(rec, clone) {
    try {
        if (!clone?.querySelector) return false;
        const sel = rec.viewer ? "img,video,canvas" : "img,video";
        const media = clone.querySelectorAll(sel);
        if (!media?.length) return false;
        clone.classList.add("hub-portal-media");
        const freeBox = (el) => {
            if (!el?.style) return;
            el.style.height = "auto";
            el.style.maxHeight = "none";
        };
        freeBox(clone);
        for (const el of media) {
            if (!el.style) continue;
            el.style.width = "100%";
            el.style.maxWidth = "100%";
            el.style.height = "auto";
            el.style.display = "block";
            el.style.objectFit = "contain";
        }
        // Intermediate wrappers with node-baked pixel heights would still
        // crop the aspect-corrected media - release them too.
        for (const el of clone.querySelectorAll("*")) {
            const h = el?.style?.height;
            if (h && h !== "auto" && el.querySelector?.(sel)) freeBox(el);
        }
        return true;
    } catch (_) { return false; }
}

/** Point every mirrored <video> at the source's current playhead (a fresh
 *  clone would otherwise freeze on its first frame). */
function syncViewerVideoTime(rec) {
    try {
        const srcs = rec.el?.querySelectorAll?.("video") ?? [];
        const dsts = rec.clone?.querySelectorAll?.("video") ?? [];
        for (let i = 0; i < Math.min(srcs.length, dsts.length); i++) {
            const a = srcs[i].currentTime || 0;
            const b = dsts[i].currentTime || 0;
            if (Math.abs(a - b) > 0.3) dsts[i].currentTime = a;
        }
    } catch (_) {}
}

/** Track the source's video playback so the mirror stays roughly in sync
 *  (timeupdate fires a few times per second while playing - cheap). */
function syncViewerVideos(rec) {
    try {
        const srcs = rec.el?.querySelectorAll?.("video") ?? [];
        srcs.forEach((sv, i) => {
            const copy = () => {
                try {
                    const dv = rec.clone?.querySelectorAll("video")?.[i];
                    if (!dv) return;
                    if (Math.abs((dv.currentTime || 0) - (sv.currentTime || 0)) > 0.3) {
                        dv.currentTime = sv.currentTime || 0;
                    }
                } catch (_) {}
            };
            sv.addEventListener("timeupdate", copy);
            rec.videoSync.push([sv, copy]);
            copy();
        });
    } catch (_) {}
}

function unsyncViewerVideos(rec) {
    for (const [sv, fn] of rec.videoSync.splice(0)) {
        try { sv.removeEventListener("timeupdate", fn); } catch (_) {}
    }
}

function releaseDom(rec) {
    // Ghost semantics: the original was NEVER moved - there is nothing to
    // put back. Discard the mirror and stop every background activity.
    rec.releasing = true;
    try { rec.observer?.disconnect(); } catch (_) {}
    rec.observer = null;
    try { rec.unbind?.(); } catch (_) {}
    rec.unbind = null;
    try { unsyncViewerVideos(rec); } catch (_) {}
    try { rec.clone?.remove(); } catch (_) {}
    rec.clone = null;
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

/** The 🪟/🖼 live tag span (itemRowHtml) must SURVIVE mounting: it sits above
 *  the embed (flex column, see styles.css) and keeps telling panel and
 *  node-level embeds apart. The old blanket host.textContent = "" erased it
 *  the moment the portal mounted. */
function keepPortalTag(host) {
    const tag = host?.querySelector?.(".hub-portal-tag") ?? null;
    host.textContent = "";
    if (tag) {
        try { host.appendChild(tag); } catch (_) {}
    }
}

/** Subtle placeholder painted when neither widget nor node hooks render. */
function drawPortalHint(ctx, w, h, text) {
    try {
        ctx.fillStyle = "#3c3c54";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text || "⚠ live embed: source panel renders nothing", Math.max(60, w / 2), h / 2);
    } catch (_) {}
}

function mountCanvasPortal(node, item, tn, members, host) {
    const canvas = document.createElement("canvas");
    canvas.className = "hub-portal-canvas";
    canvas.title = "Live embed - click / right-click to use the source widget";
    keepPortalTag(host);
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
        // v26.1: fallback painters probed IN ORDER when the primary stack
        // paints nothing (viewer: draw node.imgs when the node has no
        // background-painter content). altWinner = the painter that produced
        // pixels; altIdx/altSig gate retries so late-arriving media (first
        // generation after the pin) still gets picked up.
        altPainters: null,
        altIdx: 0,
        altSig: "",
        altLastRetry: 0,
        altWinner: null,
        // Pixel-settle auto height: signed extra over the formula height.
        // autoH == null means "grace not started yet".
        hAdj: 0,
        autoH: null,
        // v26 viewer portals show a friendlier waiting hint before the
        // source paints its first preview.
        hintText: item?.options?.viewer
            ? "🖼 viewer: waiting for the source preview…" : null,
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
            paint(() => drawPortalHint(ctx, rec.W, rec.H, rec.hintText));
            return;
        }

        if (rec.mode === "alt") {
            // A fallback painter won the probe war - keep using it.
            paint(rec.altWinner);
            const scanA = scanCanvas(canvas);
            if (!scanA.blank) { settleAutoHeight(scanA, g); return; }
            // The fallback went dark too - restart the full probe cycle.
            rec.mode = undefined;
            rec.probes = 0;
            rec.autoH = null;
            rec.hAdj = 0;
            rec.altIdx = 0;
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
            // Keep the hint painted (each pass clears the surface) - but keep
            // retrying fallback painters when the media state changes, so a
            // preview that appears AFTER the pin still lands.
            if (Array.isArray(rec.altPainters)) {
                const sig = `${tn.imgs?.length ?? 0}/${tn.images?.length ?? 0}`;
                if (sig !== rec.altSig) {
                    rec.altSig = sig;
                    rec.altIdx = 0;
                }
                // v27: the sig only tracks array LENGTHS - it changes BEFORE
                // the first Image() finishes decoding, so one exhausted probe
                // war used to freeze the hint forever. Re-arm the probes
                // periodically (cheap: one paint + one scan per 3s) so late
                // decode still lands.
                if (rec.altIdx >= rec.altPainters.length
                    && Date.now() - (rec.altLastRetry || 0) > 3000) {
                    rec.altLastRetry = Date.now();
                    rec.altIdx = 0;
                }
                if (rec.altIdx < rec.altPainters.length) {
                    const fn = rec.altPainters[rec.altIdx++];
                    paint(fn);
                    const scanB = scanCanvas(canvas);
                    if (!scanB.blank) {
                        rec.mode = "alt";
                        rec.altWinner = fn;
                        rec.autoH = null;
                        rec.hAdj = 0;
                        settleAutoHeight(scanB, g);
                        return;
                    }
                }
            }
            paint(() => drawPortalHint(ctx, rec.W, rec.H, rec.hintText));
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
        // v26.1: fallback painters (viewer imgs) get their probe round after
        // the foreground hook declined.
        if (Array.isArray(rec.altPainters) && rec.altIdx < rec.altPainters.length) {
            const fn = rec.altPainters[rec.altIdx++];
            paint(fn);
            scan = scanCanvas(canvas);
            if (!scan.blank) {
                rec.mode = "alt";
                rec.altWinner = fn;
                rec.autoH = null;
                rec.hAdj = 0;
                settleAutoHeight(scan, g);
                return;
            }
        }
        rec.mode = "blank";
        paint(() => drawPortalHint(ctx, rec.W, rec.H, rec.hintText));
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
    else if (rec.kind === "viewer") {
        // v27: a gallery viewer owns the fullscreen overlay while open -
        // unpin/remount must never leave an orphaned overlay (its release
        // closes it too; this covers recs without release).
        try { closeGalleryFullscreen(); } catch (_) {}
        rec.release?.();
    }
    else releaseCanvas(rec);
    try { rec.set?.delete(rec); } catch (_) {}
}

// ---------------------------------------------------------------------------
// v26 viewer portal: bring the source node's PREVIEW into the hub.
//
// v26.2 - SELF-RENDERED media (field feedback): the hub builds and owns ITS
// OWN media element, fed from the source's live preview. The source widget
// is never cloned and never rebuilt - that mirror churn was visible in the
// field as per-frame flicker (re-cloned <video> + seek fighting) and rows
// that kept jitter-resizing.
//
//   video  -> our own native <video controls loop autoplay playsinline>: a
//             REAL player (seek/pause/volume) as the user asked. We copy the
//             src (blob: URLs stay valid in the same document) and re-point
//             it when the source swaps media (new generation).
//             v27: muted/volume start from the GLOBAL preference
//             (global_settings.getVideoAudio) and every volumechange made
//             through the native controls writes back - tune audio ONCE,
//             every future player follows (no per-clip re-muting).
//   img    -> our own <img> with the live src.
//   gallery-> v27: the node owns NO DOM media at all (new-frontend
//             PreviewImage/SaveImage render through the CANVAS-ONLY
//             "$$canvas-image-preview" widget - BaseWidget canvasOnly, no
//             element), but the frontend OUTPUT STORE has the full batch:
//             viewer_gallery.js feeds the hub's OWN gallery from
//             app.nodeOutputs / app.nodePreviewImages (+ legacy node
//             fields) - nav arrows, counter, thumbnails, fullscreen. The
//             route that finally kills the eternal "waiting for the
//             source preview".
//   canvas -> nodes that DO carry a real DOM <canvas> widget (custom
//             builds; the $$ canvas widget itself owns no element). We
//             blit it into our own canvas on a light interval: content
//             copies across, nothing rebuilds, no flicker.
//   none   -> classic painter portal (node.onDrawBackground) with the
//             node.imgs fallback painter from v26.1.
//
// A watcher (MutationObserver on the source container + 1s safety poll)
// re-resolves the CURRENT media element (Vue re-mounts it between runs) and
// re-points our element only when the src actually changed.
// ---------------------------------------------------------------------------

const viewerSpecsLoaded = new WeakSet();

/** Best-effort load of image specs ({filename,subfolder,type}) into node.imgs
 *  so they become drawable - mirrors what classic frontends do after exec. */
function loadViewerSpecs(tn) {
    if (viewerSpecsLoaded.has(tn)) return;
    viewerSpecsLoaded.add(tn);
    try {
        const Ctor = globalThis.Image ?? globalThis.window?.Image;
        if (typeof Ctor !== "function") return;
        const specs = Array.isArray(tn.images) ? tn.images : [];
        const imgs = specs.map((s) => {
            if (!s || typeof s !== "object" || !s.filename) return null;
            const q = new URLSearchParams();
            q.set("filename", String(s.filename));
            q.set("subfolder", String(s.subfolder ?? ""));
            q.set("type", String(s.type ?? "output"));
            const im = new Ctor();
            im.src = `/view?${q.toString()}`;
            return im;
        }).filter(Boolean);
        if (imgs.length) tn.imgs = [...(Array.isArray(tn.imgs) ? tn.imgs : []), ...imgs];
    } catch (_) { /* no Image realm - the painter path stays decorative */ }
}

/** Draw the node's latest loaded image fitted (letterboxed) into W x H. */
function drawViewerImgs(ctx, tn, W, H) {
    const imgs = Array.isArray(tn?.imgs) ? tn.imgs : [];
    for (let i = imgs.length - 1; i >= 0; i--) {
        const im = imgs[i];
        const iw = im?.naturalWidth || im?.width || 0;
        const ih = im?.naturalHeight || im?.height || 0;
        if (!im || !iw || !ih) continue;
        const ar = iw / ih;
        const dh = Math.min(H, W / ar);
        const dw = dh * ar;
        try {
            ctx.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
            return true;
        } catch (_) { /* not decodable yet - try the next one */ }
    }
    if (!imgs.length) loadViewerSpecs(tn);
    return false;
}

/** Live media behind a node: video beats img beats canvas (a canvas preview
 *  container may also wrap the video player of a Video Combine). Returns
 *  { widget, container, media, kind } or null. */
function findSourceMedia(tn) {
    for (const w of tn?.widgets ?? []) {
        const el = w?.element ?? w?.inputEl ?? w?.contentEl;
        if (!el || typeof el.querySelector !== "function") continue;
        try {
            const v = el.tagName === "VIDEO" ? el : el.querySelector("video");
            if (v) return { widget: w, container: el, media: v, kind: "video" };
            const i = el.tagName === "IMG" ? el : el.querySelector("img");
            if (i) return { widget: w, container: el, media: i, kind: "img" };
            const c = el.tagName === "CANVAS" ? el : el.querySelector("canvas");
            if (c && Number(c.width) >= 2 && Number(c.height) >= 2) {
                return { widget: w, container: el, media: c, kind: "canvas" };
            }
        } catch (_) { /* exotic element - keep scanning */ }
    }
    return null;
}

/** The src actually feeding a media element (attr, property or <source>). */
function liveMediaSrc(m) {
    try {
        return m?.currentSrc || m?.src || m?.getAttribute?.("src")
            || m?.querySelector?.("source")?.getAttribute?.("src") || "";
    } catch (_) { return ""; }
}

/**
 * SELF-RENDERED viewer: our own media element + a lightweight watcher.
 * Returns a viewer rec, or null when the source owns no DOM media (caller
 * falls back to the painter portal). The source is only READ - never
 * cloned, never rebuilt, never styled.
 */
function mountMediaViewer(node, item, tn, host) {
    keepPortalTag(host);
    const src = findSourceMedia(tn);
    if (!src) return null;

    if (src.kind === "video" || src.kind === "img") {
        const el = document.createElement(src.kind);
        el.className = "hub-viewer-media";
        el.dataset.role = "viewer-media";
        if (src.kind === "video") {
            // A REAL player: seek / pause / volume via native controls.
            // Audio starts from the GLOBAL preference, not a hardcoded
            // mute (v27): the user's mute/volume choice made on ANY hub
            // player persists (localStorage) and applies to every new
            // video - no more silencing each clip over and over.
            el.controls = true;
            el.loop = true;
            el.playsInline = true;
            el.preload = "auto";
            applyVideoAudio(el);
        }
        host.appendChild(el);

        // v27.3: download button over the self-rendered player / image.
        // The src swaps in place between generations - the handler
        // reads the CURRENT src at click time, never a captured one.
        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "hub-vid-dl";
        dlBtn.title = src.kind === "video" ? "Download video" : "Download image";
        dlBtn.textContent = "\u2b07";
        dlBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            try {
                const u = el.currentSrc || el.src || "";
                if (u) downloadMediaUrl(u, src.kind === "video" ? "settingshub_video" : "settingshub_image");
            } catch (_) {}
        });
        host.appendChild(dlBtn);

        const rec = {
            kind: "viewer", item, tn, host,
            media: el, srcKind: src.kind,
            dead: false, timer: null, observer: null, lastSrc: null,
            release: null, set: null,
        };
        // v27: persist audio changes made through the player's native
        // controls into the GLOBAL preference (fires for the mute toggle
        // and the volume slider alike). The same values we write via
        // applyVideoAudio also fire volumechange - writing them back is a
        // harmless same-value round-trip, no echo guard needed.
        const persistAudio = () => {
            try { setVideoAudio({ muted: !!el.muted, volume: Number(el.volume) }); } catch (_) {}
        };
        if (src.kind === "video") {
            try { el.addEventListener("volumechange", persistAudio); } catch (_) {}
        }
        const apply = () => {
            if (rec.dead) return;
            // Re-resolve the LIVE media element every pass: frontends
            // re-mount the preview element between runs.
            const live = findSourceMedia(tn);
            const s = live ? liveMediaSrc(live.media) : "";
            if (!s || s === rec.lastSrc) return;
            rec.lastSrc = s;
            try {
                el.src = s;
                if (rec.srcKind === "video") {
                    // New generation of the same node: re-apply the
                    // global audio preference (it may have changed since
                    // this element was mounted), then autoplay. If the
                    // browser denies unmuted autoplay the video simply
                    // waits for the user - its controls stay honest.
                    applyVideoAudio(el);
                    const p = el.play?.();
                    p?.catch?.(() => {}); // autoplay denial is fine
                }
            } catch (_) {}
        };
        apply();
        const MO = typeof MutationObserver !== "undefined"
            ? MutationObserver : globalThis.window?.MutationObserver ?? null;
        if (MO) {
            try {
                rec.observer = new MO(apply);
                rec.observer.observe(src.container, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ["src"],
                });
            } catch (_) { rec.observer = null; }
        }
        rec.timer = setInterval(apply, 1000); // mutation-silent swaps
        rec.release = () => {
            rec.dead = true;
            if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
            try { rec.observer?.disconnect(); } catch (_) {}
            rec.observer = null;
            if (src.kind === "video") {
                try { el.removeEventListener("volumechange", persistAudio); } catch (_) {}
            }
            try { el.pause?.(); } catch (_) {}
            try { dlBtn.remove(); } catch (_) {}
            try { el.remove(); } catch (_) {}
        };
        return rec;
    }

    // canvas: the frontend DRAWS the preview onto a canvas - cloneNode
    // copies the element but not its bitmap (pinned images came out blank).
    // Blit it into our own canvas on a light interval: nothing rebuilds.
    const el = document.createElement("canvas");
    el.className = "hub-viewer-media";
    el.dataset.role = "viewer-media";
    host.appendChild(el);
    const rec = {
        kind: "viewer", item, tn, host,
        media: el, srcKind: "canvas",
        dead: false, timer: null, observer: null,
        release: null, set: null,
    };
    const blit = () => {
        if (rec.dead) return;
        if (document.hidden) return;
        try {
            const live = findSourceMedia(tn);
            const c = live?.kind === "canvas" ? live.media : null;
            if (!c || !(c.width > 0) || !(c.height > 0)) return;
            if (el.width !== c.width) el.width = c.width;
            if (el.height !== c.height) el.height = c.height;
            const ctx = el.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, el.width, el.height);
            ctx.drawImage(c, 0, 0);
        } catch (_) { /* tainted source - retry next tick */ }
    };
    blit();
    rec.timer = setInterval(blit, 120);
    rec.release = () => {
        rec.dead = true;
        if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
        try { el.remove(); } catch (_) {}
    };
    return rec;
}

function mountViewerPortal(node, item, tn, host) {
    const persistedH = Number(item.options?.srcH);
    const srcH = Math.max(60, Number.isFinite(persistedH) && persistedH > 0
        ? persistedH
        : Math.round(Number(tn.size?.[1]) || 200));
    const painterWidget = {
        name: "__viewer__",
        label: item.customLabel || "viewer",
        // Draw contract of the canvas-portal stack: (ctx, node, W, top, h).
        // The viewer painter ignores top/h - it addresses node-local space,
        // which is exactly what our portal surface reproduces.
        draw: (ctx) => {
            try { tn.onDrawBackground?.call(tn, ctx, app.canvas ?? undefined, app.canvas ?? undefined); } catch (_) {}
        },
    };
    const rec = mountCanvasPortal(node, item, tn, [{ widget: painterWidget, srcH }], host);
    if (rec) {
        // Fallback when the painter produces nothing (no hook, or a hook
        // that only paints under the real graph canvas): show node.imgs.
        rec.altPainters = [(ctx) => drawViewerImgs(ctx, tn, rec.W, rec.H)];
    }
    return rec;
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

        // v26: node-level viewer embeds have no real widget behind them
        // (widgetToBind is the VIEWER_SENTINEL) - branch before member
        // resolution, which would otherwise report the row broken.
        if (item.options?.viewer) {
            if (!tn) {
                host.textContent = "⚠️ target node missing";
                host.classList.add("hub-portal-broken");
                continue;
            }
            host.classList.remove("hub-portal-broken");
            // v26.2/v27: the hub renders its OWN media element fed from the
            // live source - no ghost cloning (that churned, flickered and
            // lost canvas bits). Route order:
            //   1. DOM <video>/<img> widget -> real player / img mirror;
            //   2. NO DOM media (new frontend $$canvas-image-preview!) but
            //      output-store images -> OUR batch gallery + fullscreen;
            //   3. DOM <canvas> widget      -> blit;
            //   4. nothing                  -> painter portal (hint).
            let vrec = null;
            try { vrec = mountMediaViewer(node, item, tn, host); }
            catch (_) { vrec = null; }
            if (!vrec) {
                try { vrec = mountImageGallery(node, item, tn, host); }
                catch (err) {
                    console.warn("[SettingsHub] gallery mount failed:", err);
                    vrec = null;
                }
            }
            if (!vrec) vrec = mountViewerPortal(node, item, tn, host);
            if (vrec) { vrec.set = set; set.add(vrec); }
            continue;
        }

        const members = tn ? resolveMembers(item, tn) : [];
        if (!tn || !members.length) {
            host.textContent = "⚠️ target node / widget missing";
            host.classList.add("hub-portal-broken");
            continue;
        }
        host.classList.remove("hub-portal-broken");
        let rec = null;
        // Single DOM panels without members[] become GHOST MIRRORS; group
        // embeds render onto their shared canvas.
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
    // releaseRecord -> releaseDom flags `releasing` and drops the ghost
    // mirror BEFORE any DOM surgery - pending sync timers bail out safely.
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
