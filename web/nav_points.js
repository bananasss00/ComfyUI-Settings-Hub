// ============================================================================
// SettingsHub - Navigation points ("nav" items, 🧭) - v67
// ----------------------------------------------------------------------------
// A nav item is a hub row that JUMPS the camera to a saved place of the
// workflow: the root canvas, a subgraph, or a subgraph nested inside another
// subgraph. The stored item shape:
//
//   {
//     id: genId("item"), type: "nav", tabId, order,
//     customLabel: "Point 1",
//     nav: {
//       graphUuid: null | "<subgraph uuid>",   // null = ROOT canvas
//       graphName: "Main ▸ Sub A ▸ Sub B",     // capture-time path (diagnostics)
//       pos: [x, y],                           // WORLD coordinates pinned at
//                                              // the view's TOP-LEFT anchor (v65)
//       zoom: null | number,                   // null = DON'T touch zoom (default)
//       hotkey: null | "Ctrl+Shift+1",         // v67 keyboard shortcut (null =
//     },                                      //   no hotkey) - canonical form:
//   }                                         //   Ctrl/Alt/Shift/Meta prefixes in
//                                             //   THIS order, then the physical key
//
// v67 HOTKEYS: every point may carry a keyboard shortcut - a single key or a
// modifier combination. Canonical storage is PHYSICAL-KEY based (e.code):
// "Ctrl+Shift+Digit1" is stored as "Ctrl+Shift+1", so an assigned combo works
// across keyboard layouts (a RU-layout user who assigned Ctrl+G presses the
// same physical key with "п" printed on it and the point still jumps). The
// engine is ONE document-CAPTURE keydown listener installed at module load:
//   * guard chain: global toggle (⚙ -> Navigation) -> aim/marker-drag modal
//     states -> typing targets (INPUT/TEXTAREA/SELECT/contentEditable) ->
//     e.repeat -> modifier-only presses;
//   * a matched combo is preventDefault+stopPropagation'ed (it wins over
//     ComfyUI's own shortcuts by design) and jumps via the SAME navJump
//     ladder - any tab, any hub, the row does not have to be visible;
//   * an unmatched key is left COMPLETELY untouched (no default prevented).
// Assignment goes through assignNavHotkey(): duplicates are REFUSED with the
// owning point named (first match wins would make the second silent-dead),
// and the canonical form is recomputed on every heal so old/garbage values
// degrade to null instead of crashing the matcher.
//
// CONTRACTS (see AGENTS.md, v61 + invariant 15):
//   * Graph addressing is UUID-based and resolved at JUMP time by BFS from
//     the root graphs - never cached across workflows, never by node ids.
//     A dead uuid degrades to an ⚠ orphan row, never a crash (ZB4 spirit).
//   * zoom === null means ds.scale is NEVER touched - only panning.
//     A numeric zoom is clamped to ds.min_scale/ds.max_scale when exposed.
//   * All world<->screen math goes through the canvas' OWN converters
//     (convertCanvasToOffset / ds.convertOffsetToCanvas). The only fallback
//     is the project relation screen = (world - offset) * scale (the same
//     one emulateDblClickAt was field-verified against). Placement (v62) is
//     ABSOLUTE-first: write offset = point - anchor/scale directly, then
//     VERIFY through the canvas' own converter; an empirical probe (measured
//     d(world)/d(offset) response) covers frontends whose view layer answers
//     the offset write with any other slope, and a post-jump settle loop
//     re-asserts the anchor if a view restore/open animation drags it away.
//     (v61's read-modify-write delta method turned RELATIVE on such
//     frontends: every click landed a bit further from the point.)
//     v65: the anchor is the TOP-LEFT corner of the view (80px margin) -
//     the user's reference-corner preference - not the screen center; the
//     whole anti-drift machinery is unchanged, only S changed.
//   * Aim mode and marker dragging intercept the canvas via DOCUMENT-level
//     capture listeners (registered before the canvas sees the event) and
//     ALWAYS uninstall them; no polling is introduced anywhere.
//   * Markers are pure paint + cfg mutation - no graph nodes are created,
//     nothing is written into the workflow except the hub's own config.
//
// Dependencies stay one-way: core.js -> global_settings.js -> nav_points.js
// -> hub_ui_renderer.js (no cycles; the renderer forwards rerender/toast
// through setNavUiHooks).
// ============================================================================

import { app } from "../../scripts/app.js";
import {
    genId, allHubs, getHubConfig, getActiveTabId, nextOrder,
    nodeListOf, childGraphsOfNode,
} from "./core.js";
import { getNavMarkersOn, getNavMenuOn, getNavHotkeysOn } from "./global_settings.js";

// v67 BUILD GUARD (see settings_hub.js): every submodule self-reports
// under __SettingsHubLoaded so the entry can NAME stale cached files.
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["nav_points"] = true;
if (globalThis.__SettingsHubBuild !== "v73") {
    console.error("[SettingsHub] STALE BUILD: nav_points.js (v70) was loaded under entry build [" +
        (globalThis.__SettingsHubBuild ?? "unknown") + "] - hard-refresh the page (Ctrl+F5).");
}

export const NAV_TYPE = "nav";

// ---------------------------------------------------------------------------
// Small shared helpers (module-local on purpose)
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const nextFrame = () => new Promise((r) => {
    try { requestAnimationFrame(() => r()); }
    catch (_) { setTimeout(r, 16); }
});
const napFrames = async (n) => { for (let i = 0; i < n; i++) await nextFrame(); };

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nowMs() {
    try { return performance.now(); } catch (_) { return Date.now(); }
}

function canvasElement(c) {
    return c?.canvas ?? c?.canvas_element ??
        (typeof document !== "undefined" ? document.querySelector("canvas") : null) ?? null;
}

function numStr(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    return String(Math.round(n * 100) / 100);
}

// ---------------------------------------------------------------------------
// Config-side helpers: normalize / create / enumerate
// ---------------------------------------------------------------------------

export function isNavItem(item) {
    return !!item && typeof item === "object" && item.type === NAV_TYPE;
}

function normalizePos(p) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
}

/** Self-heal a nav item in place; returns the healed nav object (or null). */
export function normalizeNav(item) {
    if (!isNavItem(item)) return null;
    const raw = item.nav && typeof item.nav === "object" ? item.nav : {};
    // Per-side healing: a partially corrupted pair keeps its good half.
    const x = Number(raw.pos?.[0]);
    const y = Number(raw.pos?.[1]);
    const pos = [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
    const z = Number(raw.zoom);
    const uuid = raw.graphUuid == null ? null : String(raw.graphUuid);
    // v67 hotkey heal: garbage/deprecated spellings re-canonicalize; an
    // unparseable value degrades to null (never crashes the matcher).
    const hk = canonicalHotkey(raw.hotkey);
    item.nav = {
        graphUuid: uuid,
        graphName: typeof raw.graphName === "string" ? raw.graphName : "",
        pos,
        zoom: Number.isFinite(z) && z > 0 ? z : null,   // null = keep current zoom
        hotkey: hk,                                     // null = no hotkey
    };
    return item.nav;
}

function defaultNavLabel(cfg) {
    let n = 0;
    for (const it of cfg.items || []) { if (isNavItem(it)) n++; }
    return `Point ${n + 1}`;
}

/** Current canvas zoom (finite, > 0) or null - the single read-point for
 *  "what zoom is the canvas at RIGHT NOW": the v69 point-creation capture
 *  (addPointViaMenu / add-navpoint pass it into createNavItem) and the
 *  popover's "= now" button. Never throws; a dead canvas yields null. */
export function currentCanvasZoom() {
    try {
        const z = Number(app.canvas?.ds?.scale);
        return Number.isFinite(z) && z > 0 ? z : null;
    } catch (_) { return null; }
}

/** Create a nav item in cfg (push + order). Does NOT re-render - callers do.
 *  v69: patch.zoom (finite > 0) becomes the point's INITIAL zoom - the UI
 *  creation paths pass currentCanvasZoom() so a freshly added point pins the
 *  zoom the user was looking at ("custom zoom" lands ON). Without patch.zoom
 *  the point stays zoom-null (keep current zoom on jump) - deterministic for
 *  tests and programmatic creation. */
export function createNavItem(node, tabId, patch = {}) {
    const cfg = getHubConfig(node);
    const z = Number(patch.zoom);
    const item = {
        id: genId("item"),
        type: NAV_TYPE,
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: typeof patch.label === "string" && patch.label.trim()
            ? patch.label.trim() : defaultNavLabel(cfg),
        nav: {
            graphUuid: patch.graphUuid == null ? null : String(patch.graphUuid),
            graphName: typeof patch.graphName === "string" ? patch.graphName : "",
            pos: normalizePos(patch.pos) ?? [0, 0],
            zoom: Number.isFinite(z) && z > 0 ? z : null, // v69: capture on create
            hotkey: null, // v67: assigned ONLY via assignNavHotkey (dup-check)
        },
    };
    cfg.items.push(item);
    markersVersionBump();
    return item;
}

/** All nav items across every live hub: [{ item, hub }] (diagnostics/tests). */
export function getNavItems() {
    const out = [];
    for (const hub of allHubs()) {
        let cfg = null;
        try { cfg = getHubConfig(hub); } catch (_) { continue; }
        for (const item of cfg?.items || []) {
            if (isNavItem(item)) out.push({ item, hub });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Graph index: BFS from the root graphs, uuid -> { graph, holders }
// ---------------------------------------------------------------------------
// Reuses the SAME shape space as core.js walkers (union node lists via
// nodeListOf, duck-typed holder refs via childGraphsOfNode, Array/Map/object
// definition registries). Kept local because the index must ALSO record the
// holder chain per graph - the allGraphs() flat walker loses that.

function looksLikeGraphLite(g) {
    if (!g || typeof g !== "object") return false;
    try {
        return Array.isArray(g._nodes) || Array.isArray(g.nodes);
    } catch (_) { return false; }
}

function registryEntriesLite(g) {
    const out = [];
    for (const key of ["_subgraphs", "subgraphs", "subgraphsById"]) {
        let reg;
        try { reg = g?.[key]; } catch (_) { continue; }
        try {
            if (!reg) continue;
            if (Array.isArray(reg)) { out.push(...reg); continue; }
            if (typeof reg.forEach === "function") {          // Map / Set
                reg.forEach((v) => { if (v && typeof v === "object") out.push(v); });
                continue;
            }
            if (typeof reg === "object") {
                for (const k of Object.keys(reg)) {           // {uuid: Subgraph}
                    const v = reg[k];
                    if (v && typeof v === "object") out.push(v);
                }
            }
        } catch (_) {}
    }
    return out;
}

function rootGraphs() {
    const out = [];
    const push = (g) => { if (looksLikeGraphLite(g) && !out.includes(g)) out.push(g); };
    try { push(app.graph); } catch (_) {}
    try { push(app.canvas?.graph); } catch (_) {}
    try { push(window.comfyAPI?.app?.graph); } catch (_) {}
    return out;
}

function safeId(g) {
    try { const v = g?.id; return v == null ? null : String(v); } catch (_) { return null; }
}

let graphIndexCache = null;   // { root, t, byUuid: Map, byObj: Map }
const INDEX_TTL_MS = 1500;    // covers mid-session subgraph edits cheaply

function buildGraphIndex() {
    const root = rootGraphs()[0] ?? null;
    if (graphIndexCache && graphIndexCache.root === root &&
        nowMs() - graphIndexCache.t < INDEX_TTL_MS) {
        return graphIndexCache;
    }
    const byUuid = new Map();   // uuid -> { graph, holders }
    const byObj = new Map();    // graph -> { holders }
    const seen = new Set();
    const seeded = new Set();   // canvas/root seeds - may get a chain upgrade
    let frontier = [];

    const seed = (g) => {
        if (looksLikeGraphLite(g) && !seen.has(g)) {
            seen.add(g);
            seeded.add(g);
            byObj.set(g, { holders: [] });
            // NO uuid registration here yet: a canvas seed may be a STALE
            // graph of ANOTHER workflow (tab switch) - registering it blindly
            // would make dead targets resolvable. If the seed is really part
            // of THIS workflow, pass 1 reaches it through its holder chain
            // and upgrades the entry (uuid + chain) there.
            frontier.push(g);
        }
    };
    for (const g of rootGraphs()) seed(g);

    // PASS 1 - HOLDER CHAINS ONLY. Holder-node children are explored to
    // completion FIRST: a subgraph reachable through holder nodes gets the
    // FULL chain (SubgraphNode per level) - the gesture-replay ladder needs
    // every step. (A single-pass BFS that reads definition registries at the
    // same level would register a deep subgraph from its root registry with
    // an EMPTY chain before the holder path was ever considered.)
    for (let depth = 0; depth < 16 && frontier.length; depth++) {
        const next = [];
        for (const g of frontier) {
            const holders = byObj.get(g)?.holders ?? [];
            for (const n of nodeListOf(g)) {
                for (const child of childGraphsOfNode(n)) {
                    const chain = [...holders, n];
                    if (!seen.has(child)) {
                        seen.add(child);
                        byObj.set(child, { holders: chain });
                        const id = safeId(child);
                        if (id != null && !byUuid.has(id)) byUuid.set(id, { graph: child, holders: chain });
                        next.push(child);
                    } else if (seeded.has(child) && chain.length &&
                               !(byObj.get(child)?.holders ?? []).length) {
                        // Chain upgrade for a pre-seeded (browsed) graph: the
                        // holder path is the honest one - it powers the
                        // gesture-replay ladder and the breadcrumb labels.
                        byObj.set(child, { holders: chain });
                        const id = safeId(child);
                        if (id != null && !byUuid.has(id)) byUuid.set(id, { graph: child, holders: chain });
                        // no re-push: seeded graphs were explored from level 0
                    }
                }
            }
        }
        frontier = next;
    }

    // PASS 2 - DEFINITION REGISTRIES for everything pass 1 missed (holder-
    // less frontends): the entry inherits the OWNING graph's chain - same
    // policy as findHolderChainOf (locate only needs A valid ladder), and
    // registries of registry-found graphs are scanned too.
    let regFrontier = [...byObj.keys()];
    for (let depth = 0; depth < 16 && regFrontier.length; depth++) {
        const next = [];
        for (const g of regFrontier) {
            const holders = byObj.get(g)?.holders ?? [];
            for (const def of registryEntriesLite(g)) {
                if (seen.has(def)) continue;
                seen.add(def);
                byObj.set(def, { holders: [...holders] });
                const id = safeId(def);
                if (id != null && !byUuid.has(id)) byUuid.set(id, { graph: def, holders: [...holders] });
                next.push(def);
            }
        }
        regFrontier = next;
    }
    graphIndexCache = { root, t: nowMs(), byUuid, byObj };
    return graphIndexCache;
}

/** Drop every cached marker/index structure (nav CRUD, graph configure). */
export function markersVersionBump() {
    graphIndexCache = null;
}

function holdersPathNames(holders) {
    return (holders ?? []).map((n) => {
        try { return String(n.title ?? n.name ?? "?"); } catch (_) { return "?"; }
    });
}

/**
 * Resolve a nav object to a live graph. Never throws; an unknown uuid is a
 * clean { ok:false, reason:"orphan" } (the row shows ⚠, jump shows a toast).
 */
export function resolveNavTarget(nav) {
    const raw = nav && typeof nav === "object" ? nav : {};
    const uuid = raw.graphUuid == null ? null : String(raw.graphUuid);
    if (!uuid) {
        const root = rootGraphs()[0] ?? null;
        return root
            ? { ok: true, graph: root, holders: [], path: [] }
            : { ok: false, reason: "no-root" };
    }
    let hit = null;
    try { hit = buildGraphIndex().byUuid.get(uuid) ?? null; } catch (_) { hit = null; }
    if (!hit) return { ok: false, reason: "orphan", uuid };
    return {
        ok: true,
        graph: hit.graph,
        holders: hit.holders,
        path: holdersPathNames(hit.holders),
    };
}

/** Which graph is the canvas showing right now (capture context). */
export function activeGraphContext() {
    const c = app.canvas;
    const g = c?.graph ?? app.graph ?? null;
    const root = rootGraphs()[0] ?? null;
    if (!g) return { graph: null, uuid: null, name: "", path: "Main" };
    if (!root || g === root) return { graph: g, uuid: null, name: "Main", path: "Main" };
    let holders = [];
    try { holders = buildGraphIndex().byObj.get(g)?.holders ?? []; } catch (_) {}
    const names = holdersPathNames(holders);
    try { names.push(String(g.name ?? g.title ?? "Subgraph")); } catch (_) { names.push("Subgraph"); }
    return {
        graph: g,
        uuid: safeId(g),
        name: names[names.length - 1] ?? "",
        path: ["Main", ...names].join(" ▸ "),
    };
}

// ---------------------------------------------------------------------------
// Camera: screen<->world + centering with optional per-point zoom
// ---------------------------------------------------------------------------

function clampZoom(z) {
    const v = Number(z);
    if (!Number.isFinite(v) || v <= 0) return null;
    let ds = null;
    try { ds = app.canvas?.ds ?? null; } catch (_) {}
    const min = ds && Number.isFinite(Number(ds.min_scale)) ? Number(ds.min_scale) : null;
    const max = ds && Number.isFinite(Number(ds.max_scale)) ? Number(ds.max_scale) : null;
    let out = v;
    if (min != null && min > 0) out = Math.max(min, out);
    if (max != null && max > 0) out = Math.min(max, out);
    return out;
}

/** Preferred world<->screen converter: the canvas-level proxy when the
 *  frontend exposes one, else the DragAndScale instance itself. */
function canvasToOffsetFn(c) {
    if (typeof c?.convertCanvasToOffset === "function") return (p) => c.convertCanvasToOffset(p);
    if (typeof c?.ds?.convertCanvasToOffset === "function") return (p) => c.ds.convertCanvasToOffset(p);
    return null;
}

/** clientX/clientY -> world coords (litegraph converters, project fallback). */
export function screenToWorld(clientX, clientY) {
    const c = app.canvas;
    const el = canvasElement(c);
    if (!c || !el?.getBoundingClientRect) return null;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (_) { return null; }
    const lx = Number(clientX) - rect.left;
    const ly = Number(clientY) - rect.top;
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return null;
    const toWorld = canvasToOffsetFn(c);
    if (toWorld) {
        try {
            const w = toWorld([lx, ly]);
            if (Array.isArray(w) && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1]))) {
                return [Number(w[0]), Number(w[1])];
            }
        } catch (_) { /* fall through to the project formula */ }
    }
    const ds = c.ds ?? {};
    const s = Number(ds.scale) > 0 ? Number(ds.scale) : 1;
    const ox = Array.isArray(ds.offset) ? Number(ds.offset[0]) || 0 : 0;
    const oy = Array.isArray(ds.offset) ? Number(ds.offset[1]) || 0 : 0;
    return [lx / s + ox, ly / s + oy];
}

// v65 ANCHOR: a jumped point is pinned at the TOP-LEFT of the visible view
// (the user's reference-corner preference) instead of the screen center.
// The margin keeps the marker clear of the canvas edge and of the overlays
// hugging the corner (sidebars / toolbars); on tiny windows the margin
// shrinks so the anchor can never leave the view (min 24px, max 25% side).
const NAV_ANCHOR_MARGIN = 80;

/** Visible view size in canvas-local px (CSS space - the same space
 *  litegraph's converters expect mouse positions in). */
function viewDimsPx(c) {
    const el = canvasElement(c);
    let rect = null;
    try { rect = el?.getBoundingClientRect?.() ?? null; } catch (_) {}
    const W = rect && rect.width > 0 ? rect.width
        : (Number(c.canvas?.width) > 0 ? Number(c.canvas.width) : 800);
    const H = rect && rect.height > 0 ? rect.height
        : (Number(c.canvas?.height) > 0 ? Number(c.canvas.height) : 600);
    return [W, H];
}

/** Screen anchor (canvas-local px): the screen position a nav point lands
 *  on when the camera jumps. v65: top-left + NAV_ANCHOR_MARGIN. */
function viewAnchorPx(c) {
    const [W, H] = viewDimsPx(c);
    const mx = Math.max(24, Math.min(NAV_ANCHOR_MARGIN, W * 0.25));
    const my = Math.max(24, Math.min(NAV_ANCHOR_MARGIN, H * 0.25));
    return [mx, my];
}

/** World point under a screen position, through the canvas' OWN converter. */
function readWorldUnderScreen(c, toWorld, Sx, Sy) {
    if (typeof toWorld !== "function") return null;
    try {
        const w = toWorld([Sx, Sy]);
        if (Array.isArray(w) && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1]))) {
            return [Number(w[0]), Number(w[1])];
        }
    } catch (_) { /* converter disagreement -> caller treats as unverifiable */ }
    return null;
}

/** Verification tolerance: Float32 conversions inside litegraph lose
 *  precision on huge world coords, so scale the epsilon with |p|. */
function anchorTol(p) {
    return 0.05 + 1e-6 * Math.max(Math.abs(p[0]), Math.abs(p[1]), 1);
}

/**
 * Write a world->view offset. mode "elements" mutates the array in place
 * (plain litegraph arrays); mode "assign" REPLACES the array (offsets backed
 * by a getter/setter lose element writes entirely - v62's frozen-array case).
 */
function writeOffset(c, arr, mode) {
    try {
        if (mode === "assign") { c.ds.offset = [arr[0], arr[1]]; return true; }
        c.ds.offset[0] = arr[0];
        c.ds.offset[1] = arr[1];
        return true;
    } catch (_) { return false; }
}

/** Absolute one-shot write under the documented project contract
 *  screen = (world - offset) * scale  =>  offset = world - anchor/scale.
 *  No read-modify-write: repeated calls are IDEMPOTENT by construction. */
function applyAbsoluteAnchor(c, Sx, Sy, p, mode) {
    const s = Number(c.ds.scale) > 0 ? Number(c.ds.scale) : 1;
    return writeOffset(c, [p[0] - Sx / s, p[1] - Sy / s], mode);
}

/**
 * Empirical-probe anchoring (v62): measure the REAL d(world-under-anchor)/
 * d(offset) response of the running frontend by nudging the offset a little
 * and re-reading the converter, then Newton-step to the target. Exact for
 * ANY affine response (slope +1, -1, 2, 0.5...), which is what killed the
 * v61 drift: that code ASSUMED slope +1 and turned relative otherwise.
 * All writes/reads happen inside one synchronous block - nothing paints the
 * intermediate states.
 */
function applyProbeAnchor(c, toWorld, Sx, Sy, p, mode) {
    const PROBE = 128;   // offset units; response slope is scale-independent
    const o0 = [Number(c.ds.offset?.[0]) || 0, Number(c.ds.offset?.[1]) || 0];
    const cur0 = readWorldUnderScreen(c, toWorld, Sx, Sy);
    if (!cur0) return false;

    const slope = [0, 0];
    for (const axis of [0, 1]) {
        const o1 = [o0[0], o0[1]];
        o1[axis] += PROBE;
        if (!writeOffset(c, o1, mode)) continue;
        const cur1 = readWorldUnderScreen(c, toWorld, Sx, Sy);
        writeOffset(c, o0, mode);   // restore before judging
        if (!cur1) continue;
        const k = (cur1[axis] - cur0[axis]) / PROBE;
        if (Number.isFinite(k) && Math.abs(k) > 1e-6) slope[axis] = k;
    }
    if (!slope[0] && !slope[1]) return false;   // writes never reach the view

    let o = [o0[0], o0[1]];
    for (let iter = 0; iter < 2; iter++) {      // affine -> 1 step is exact
        const cur = readWorldUnderScreen(c, toWorld, Sx, Sy);
        if (!cur) break;
        const next = [o[0], o[1]];
        let moved = false;
        for (const axis of [0, 1]) {
            if (!slope[axis]) continue;
            const t = next[axis] + (p[axis] - cur[axis]) / slope[axis];
            if (Number.isFinite(t)) { next[axis] = t; moved = true; }
        }
        if (!moved) break;
        o = next;
        writeOffset(c, o, mode);
    }
    const tol = anchorTol(p);
    const fin = readWorldUnderScreen(c, toWorld, Sx, Sy);
    return !!fin && Math.abs(fin[0] - p[0]) <= tol && Math.abs(fin[1] - p[1]) <= tol;
}

/**
 * Pin the ACTIVE view so a world point lands on the view's ANCHOR
 * (v65: top-left + margin - the reference-corner preference); apply zoom
 * first when numeric. v62 strategy ladder - every step is ABSOLUTE (the old
 * delta method could drift further away on every click when the frontend's
 * view layer answered the offset write with a slope other than +1) and every
 * step with a working converter is VERIFIED through that same converter
 * before we accept it:
 *   1. absolute write, in-place (standard litegraph - the 99.9% path);
 *   2. empirical probe, in-place (any affine response slope);
 *   3. absolute write via array replacement (getter/setter-backed offset);
 *   4. empirical probe via array replacement;
 *   5. unverifiable (no converter): best-effort absolute write under the
 *      documented project contract.
 */
export function setActiveViewAnchor(pos, zoom = null) {
    const c = app.canvas;
    if (!c || !c.ds) return false;
    const p = normalizePos(pos);
    if (!p) return false;
    const z = clampZoom(zoom);
    if (z != null) c.ds.scale = z;

    const [Sx, Sy] = viewAnchorPx(c);
    const toWorld = canvasToOffsetFn(c);
    const tol = anchorTol(p);
    const anchored = () => {
        const cur = readWorldUnderScreen(c, toWorld, Sx, Sy);
        return !!cur && Math.abs(cur[0] - p[0]) <= tol && Math.abs(cur[1] - p[1]) <= tol;
    };

    let applied = false;
    if (toWorld) {
        if (applyAbsoluteAnchor(c, Sx, Sy, p, "elements") && anchored()) applied = true;
        if (!applied) applied = applyProbeAnchor(c, toWorld, Sx, Sy, p, "elements");
        if (!applied && applyAbsoluteAnchor(c, Sx, Sy, p, "assign") && anchored()) applied = true;
        if (!applied) applied = applyProbeAnchor(c, toWorld, Sx, Sy, p, "assign");
    }
    if (!applied) {
        // Converter-less / unverifiable frontend: keep the documented-contract
        // absolute write (same value strategy 1 wrote) as the best effort.
        applyAbsoluteAnchor(c, Sx, Sy, p, "elements");
    }
    try { c.setDirtyCanvas?.(true, true); } catch (_) {}
    return true;
}

// ---------------------------------------------------------------------------
// Entry ladder (moved here from hub_ui_renderer so locate and nav share ONE
// implementation; also fixes the latent `sleep is not defined` ReferenceError
// in the synthetic-dblclick wait loop).
// ---------------------------------------------------------------------------

/** Last-resort opener for frontends exposing no programmatic navigation:
 *  synthesize the SAME gesture the user would make - a double click on the
 *  holder node, mapped world->screen through the canvas transform. */
function emulateDblClickAt(holder) {
    const c = app.canvas ?? {};
    const el = canvasElement(c);
    if (!el || typeof el.dispatchEvent !== "function" ||
        !Array.isArray(holder?.pos)) return false;
    let rect = { left: 0, top: 0 };
    try { rect = el.getBoundingClientRect?.() ?? rect; } catch (_) {}
    const ds = c.ds ?? {};
    const scale = Number(ds.scale) > 0 ? Number(ds.scale) : 1;
    const ox = Array.isArray(ds.offset) ? Number(ds.offset[0]) || 0 : 0;
    const oy = Array.isArray(ds.offset) ? Number(ds.offset[1]) || 0 : 0;
    const wx = holder.pos[0] + (holder.size?.[0] ?? 140) / 2;
    const wy = holder.pos[1] + (holder.size?.[1] ?? 60) / 2;
    const base = {
        clientX: rect.left + (wx - ox) * scale,
        clientY: rect.top + (wy - oy) * scale,
        bubbles: true, cancelable: true, view: window,
    };
    const fire = (Ctor, type) => {
        if (typeof Ctor !== "function") return;
        try { el.dispatchEvent(new Ctor(type, base)); } catch (_) {}
    };
    const tap = () => {
        fire(window.PointerEvent, "pointerdown");
        fire(window.MouseEvent, "mousedown");
        fire(window.PointerEvent, "pointerup");
        fire(window.MouseEvent, "mouseup");
        fire(window.MouseEvent, "click");
    };
    tap();
    setTimeout(tap, 110);
    setTimeout(() => fire(window.MouseEvent, "dblclick"), 160);
    return true;
}

/**
 * Make the ACTIVE canvas graph become `ownerGraph`.
 * Strategy ladder (availability differs between litegraph generations):
 *   1. direct setters: setGraph / openGraph / openSubgraph / showSubgraph;
 *   2. replaying the canonical gesture along the holder chain -
 *      processNodeDoubleClicked when exposed, synthetic dblclick otherwise.
 * Every strategy verifies the switch by the canvas.graph identity.
 */
export async function enterOwnerGraph(ownerGraph, holders) {
    const c = app.canvas;
    if (!c || !ownerGraph) return false;

    for (const name of ["setGraph", "openGraph", "openSubgraph", "showSubgraph"]) {
        try {
            if (typeof c[name] !== "function") continue;
            c[name].call(c, ownerGraph);
            await napFrames(2);
            if ((c.graph ?? null) === ownerGraph) return true;
        } catch (_) { /* fall through to the next strategy */ }
    }

    for (const holder of holders ?? []) {
        if (!holder || typeof holder !== "object") continue;
        try {
            if (typeof c.processNodeDoubleClicked === "function") {
                c.processNodeDoubleClicked.call(c, holder);
                for (let i = 0; i < 4; i++) {
                    await napFrames(1);
                    if ((c.graph ?? null) === ownerGraph) return true;
                }
            }
        } catch (_) { /* ignore broken overrides, keep trying */ }
        try {
            if (emulateDblClickAt(holder)) {
                for (let i = 0; i < 8; i++) {
                    await sleep(40);
                    if ((c.graph ?? null) === ownerGraph) return true;
                }
            }
        } catch (_) {}
    }
    return (c.graph ?? null) === ownerGraph;
}

// ---------------------------------------------------------------------------
// Jump engine + landing flash
// ---------------------------------------------------------------------------

let navSeq = 0;          // race guard: a fresher jump supersedes an older one
let flashState = null;   // { pos, t0 }

function startFlash(pos) {
    const p = normalizePos(pos);
    if (!p) return;
    flashState = { pos: p, t0: nowMs() };
    const tick = () => {
        if (!flashState) return;
        try { app.canvas?.setDirtyCanvas?.(true, true); } catch (_) {}
        if (nowMs() - flashState.t0 < 900) requestAnimationFrame(tick);
        else flashState = null;
    };
    try { requestAnimationFrame(tick); } catch (_) { flashState = null; }
}

/**
 * Generous post-jump check: is the point still visually AT the anchor?
 * Tolerance is a fraction of the FULL view diagonal (world units at the
 * current scale) - big enough to never fight a user's own pan, small enough
 * to catch a view-restore animation that dragged the camera away. It is
 * deliberately NOT tied to the anchor position: the v65 top-left anchor
 * must not make this guard stricter than the v62 center one
 * (0.12 * 2 * hypot(W/2, H/2) === 0.12 * hypot(W, H)).
 */
function viewAtAnchor(c, toWorld, pos) {
    const [Sx, Sy] = viewAnchorPx(c);
    const [W, H] = viewDimsPx(c);
    const cur = readWorldUnderScreen(c, toWorld, Sx, Sy);
    if (!cur) return true;   // unverifiable -> never fight the view
    const s = Number(c.ds?.scale) > 0 ? Number(c.ds.scale) : 1;
    const tol = (0.12 * Math.hypot(W, H)) / s;
    return Math.abs(cur[0] - pos[0]) <= tol && Math.abs(cur[1] - pos[1]) <= tol;
}

/**
 * Jump the camera to a nav item's point: enter the owner graph first (root,
 * subgraph, nested subgraph - whichever the uuid resolves to), THEN set the
 * camera. zoom===null keeps the current zoom - only panning happens.
 *
 * v62: after the jump, a short SETTLE guard re-asserts the anchor while the
 * frontend's own view restore / subgraph-open animation keeps dragging the
 * camera away. Every re-assert goes through setActiveViewAnchor, which is
 * ABSOLUTE - so neither the animation nor repeated clicks can accumulate a
 * drifting offset (the v61 "jump lands further away every click" bug).
 * v65: the anchor is the TOP-LEFT of the view (80px margin), not the center.
 */
export async function navJump(item) {
    const nav = normalizeNav(item);
    if (!nav || !app.canvas) return;
    const c = app.canvas;
    const seq = ++navSeq;

    const target = resolveNavTarget(nav);
    if (!target.ok || !target.graph) {
        toastUi(nav.graphUuid
            ? `⚠ Subgraph not found (${nav.graphName || nav.graphUuid}) - re-place this point`
            : "⚠ No root graph available");
        return;
    }

    if ((c.graph ?? null) !== target.graph) {
        try { await enterOwnerGraph(target.graph, target.holders ?? []); } catch (_) {}
        if (seq !== navSeq) return; // a fresher jump took over
        if ((c.graph ?? null) !== target.graph) {
            toastUi("⚠ Could not enter the target subgraph");
            return;
        }
    }

    // Let the frontend settle its own view restore after the graph switch,
    // then apply OUR camera (zoom first, then the anchor).
    await napFrames(2);
    if (seq !== navSeq) return;
    setActiveViewAnchor(nav.pos, nav.zoom);
    startFlash(nav.pos);

    // Settle guard: verify through the canvas' own converter that the point
    // really IS at the anchor once the frontend stops animating; re-assert
    // (absolutely) while it is not. Superseded by any fresher jump.
    const toWorld = canvasToOffsetFn(c);
    if (!toWorld) return;
    for (let pass = 0; pass < 4; pass++) {
        await napFrames(4);
        if (seq !== navSeq) return;
        if (viewAtAnchor(c, toWorld, nav.pos)) return;
        setActiveViewAnchor(nav.pos, null);   // zoom already applied above
    }
}

// ---------------------------------------------------------------------------
// Aim mode ("прицел"): arm once, the next canvas click captures a point
// ---------------------------------------------------------------------------

let aimState = null;   // { el, prevCursor, onPick, onCancel, chip }

export function isAiming() { return !!aimState; }

function aimCleanup() {
    const st = aimState;
    if (!st) return;
    aimState = null;
    document.removeEventListener("pointerdown", aimPointerDown, true);
    document.removeEventListener("contextmenu", aimContextMenu, true);
    document.removeEventListener("keydown", aimKeyDown, true);
    try { if (st.el) st.el.style.cursor = st.prevCursor ?? ""; } catch (_) {}
    try { st.chip?.remove(); } catch (_) {}
}

function aimPointerDown(e) {
    if (!aimState) return;
    const st = aimState;
    if (e.target !== st.el) {
        // Click outside the canvas (hub DOM, popups) cancels the aim and lets
        // the normal UI work.
        aimCleanup();
        try { st.onCancel?.(); } catch (_) {}
        return;
    }
    // Any canvas button picks: LMB places the point, RMB/MIDDLE cancel
    // (their default action is suppressed so no menu / pan starts).
    e.preventDefault();
    e.stopPropagation();
    const w = e.button === 0 ? screenToWorld(e.clientX, e.clientY) : null;
    const ctx = activeGraphContext();
    const onPick = st.onPick, onCancel = st.onCancel;
    aimCleanup();
    if (e.button !== 0 || !w) { try { onCancel?.(); } catch (_) {} return; }
    try { onPick(ctx, w); } catch (err) { console.warn("[SettingsHub] nav pick failed:", err); }
}

function aimContextMenu(e) {
    if (!aimState) return;
    e.preventDefault();
    e.stopPropagation();
    const st = aimState;
    aimCleanup();
    try { st.onCancel?.(); } catch (_) {}
}

function aimKeyDown(e) {
    if (!aimState) return;
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const st = aimState;
        aimCleanup();
        try { st.onCancel?.(); } catch (_) {}
    }
}

/**
 * Arm the aim mode. The next LMB click ON THE CANVAS fires onPick
 * ({ graph, uuid, name, path }, [wx, wy]); Esc / RMB / clicking any hub DOM
 * cancels via onCancel. Returns false when no canvas is available.
 */
export function armAim({ onPick, onCancel, hint } = {}) {
    if (typeof onPick !== "function") return false;
    const c = app.canvas;
    const el = canvasElement(c);
    if (!c || !el) return false;
    aimCleanup(); // single-flight: a fresh aim replaces a pending one
    const prevCursor = (() => { try { return el.style.cursor ?? ""; } catch (_) { return ""; } })();
    aimState = { el, prevCursor, onPick, onCancel, chip: null };
    try { el.style.cursor = "crosshair"; } catch (_) {}
    try {
        const chip = document.createElement("div");
        chip.className = "hub-nav-aim-hint";
        chip.textContent = hint || "🧭 Click the canvas to place the point · Esc / right-click - cancel";
        document.body.appendChild(chip);
        aimState.chip = chip;
    } catch (_) {}
    document.addEventListener("pointerdown", aimPointerDown, true);
    document.addEventListener("contextmenu", aimContextMenu, true);
    document.addEventListener("keydown", aimKeyDown, true);
    return true;
}

export function cancelAim() {
    const st = aimState;
    if (!st) return;
    aimCleanup();
    try { st.onCancel?.(); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Canvas markers: paint + drag (pure paint, cfg mutation only)
// ---------------------------------------------------------------------------

let markerVersion = 0;
const markerCache = new WeakMap();   // graph -> { v, t, list }

function getMarkersForGraph(g) {
    const c = markerCache.get(g);
    if (c && c.v === markerVersion && nowMs() - c.t < INDEX_TTL_MS) return c.list;
    const list = [];
    for (const { item, hub } of getNavItems()) {
        const nav = normalizeNav(item);
        if (!nav) continue;
        const t = resolveNavTarget(nav);
        if (t.ok && t.graph === g) list.push({ item, hub, nav });
    }
    markerCache.set(g, { v: markerVersion, t: nowMs(), list });
    return list;
}

function markerScreenPos(c, p) {
    const ds = c.ds ?? {};
    try {
        if (typeof ds.convertOffsetToCanvas === "function") {
            const s = ds.convertOffsetToCanvas(p);
            if (Array.isArray(s) && Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1]))) {
                return [Number(s[0]), Number(s[1])];
            }
        }
    } catch (_) { /* fall through to the project formula */ }
    const s = Number(ds.scale) > 0 ? Number(ds.scale) : 1;
    const ox = Array.isArray(ds.offset) ? Number(ds.offset[0]) || 0 : 0;
    const oy = Array.isArray(ds.offset) ? Number(ds.offset[1]) || 0 : 0;
    return [(p[0] - ox) * s, (p[1] - oy) * s];
}

function paintNavMarkers(canvasObj) {
    const c = app.canvas;
    if (!c || canvasObj && canvasObj !== c) return;
    const g = c.graph;
    if (!g) return;
    const ctx = c.ctx ?? c.canvas?.getContext?.("2d") ?? null;
    if (!ctx) return;
    const markers = getNavMarkersOn() ? getMarkersForGraph(g) : [];
    const flash = flashState;
    if (!markers.length && !flash) return;

    // After litegraph's own draw the ctx is back at its FRAME BASE transform
    // (identity, or the DPR scale on HiDPI frontends). convertOffsetToCanvas
    // speaks CSS-px canvas coords - drawing with the base transform restored
    // maps them onto the buffer exactly like litegraph's own mouse math does.
    let base = null;
    try { base = ctx.getTransform?.() ?? null; } catch (_) {}
    ctx.save();
    try {
        if (base && typeof DOMMatrix !== "undefined" && base instanceof DOMMatrix) {
            ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
        }
        if (markers.length) {
            const dragPos = markerDrag?.item?.nav?.pos ?? null;
            for (const m of markers) {
                const p = normalizePos(m.nav?.pos);
                if (!p) continue;
                const [sx, sy] = markerScreenPos(c, p);
                const active = dragPos === m.nav?.pos;
                ctx.beginPath();
                ctx.arc(sx, sy, 7, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(22,22,42,0.78)";
                ctx.fill();
                ctx.lineWidth = active ? 3 : 2;
                ctx.strokeStyle = active ? "#ffd66e" : "#d9a441";
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
                ctx.fillStyle = "#ffd66e";
                ctx.fill();
                if (active && m.item?.customLabel) {
                    ctx.font = "11px sans-serif";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "middle";
                    ctx.fillStyle = "rgba(22,22,42,0.85)";
                    const label = String(m.item.customLabel);
                    const w = ctx.measureText(label).width;
                    ctx.fillRect(sx + 10, sy - 8, w + 10, 16);
                    ctx.fillStyle = "#ffd66e";
                    ctx.fillText(label, sx + 15, sy);
                }
            }
        }
        if (flash) {
            const dt = nowMs() - flash.t0;
            const k = Math.max(0, Math.min(1, dt / 900));
            const [sx, sy] = markerScreenPos(c, flash.pos);
            ctx.beginPath();
            ctx.arc(sx, sy, 6 + 34 * k, 0, Math.PI * 2);
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = `rgba(255,214,110,${(1 - k) * 0.9})`;
            ctx.stroke();
        }
    } finally {
        try { ctx.restore(); } catch (_) {}
    }
}

// --- Marker dragging: document-capture interception (litegraph never sees
// the pointerdown, so it cannot start a pan / node drag underneath).

let markerDrag = null;   // { item, hub, raf }

function nodeUnderWorld(c, w) {
    const nodes = nodeListOf(c.graph);
    if (!nodes?.length) return false;
    let th = 20;
    try {
        const lt = window.LiteGraph?.NODE_TITLE_HEIGHT;
        if (Number(lt) > 0) th = Number(lt);
    } catch (_) {}
    for (const n of nodes) {
        try {
            const x0 = Number(n.pos?.[0]), y0 = Number(n.pos?.[1]);
            const w0 = Number(n.size?.[0]), h0 = Number(n.size?.[1]);
            if (![x0, y0, w0, h0].every(Number.isFinite)) continue;
            const t = Number.isFinite(Number(n.title_height)) && Number(n.title_height) > 0
                ? Number(n.title_height) : th;
            // Union bounding (title above the body OR included in pos - both
            // frontend generations are covered by the wider rect).
            if (w[0] >= x0 && w[0] <= x0 + w0 && w[1] >= y0 - t && w[1] <= y0 + h0) return true;
        } catch (_) {}
    }
    return false;
}

function hitMarker(c, w) {
    const g = c.graph;
    if (!g) return null;
    const scale = Number(c.ds?.scale) > 0 ? Number(c.ds.scale) : 1;
    const rWorld = 11 / scale;
    let best = null, bestD = Infinity;
    for (const m of getMarkersForGraph(g)) {
        const p = normalizePos(m.nav?.pos);
        if (!p) continue;
        const dx = w[0] - p[0], dy = w[1] - p[1];
        const d = Math.hypot(dx, dy);
        if (d <= rWorld && d < bestD) { best = m; bestD = d; }
    }
    return best;
}

function navPointerDown(e) {
    try {
        if (aimState || markerDrag) return;
        if (!getNavMarkersOn() || e.button !== 0) return;
        const c = app.canvas;
        const el = canvasElement(c);
        if (!el || e.target !== el) return;
        const w = screenToWorld(e.clientX, e.clientY);
        if (!w) return;
        if (nodeUnderWorld(c, w)) return;   // nodes always win their own drags
        const hit = hitMarker(c, w);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        markerDrag = { ...hit, raf: 0 };
        document.addEventListener("pointermove", navPointerMove, true);
        document.addEventListener("pointerup", navPointerUp, true);
        try { c.setDirtyCanvas?.(true, true); } catch (_) {}
    } catch (_) {}
}

function navPointerMove(e) {
    if (!markerDrag) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (!w) return;
    if (markerDrag.raf) return;   // rAF-coalesced
    markerDrag.raf = requestAnimationFrame(() => {
        if (!markerDrag) return;
        markerDrag.raf = 0;
        try {
            markerDrag.item.nav.pos = w;
            app.canvas?.setDirtyCanvas?.(true, true);
        } catch (_) {}
    });
    e.preventDefault();
}

function navPointerUp() {
    if (!markerDrag) return;
    const wasDrag = markerDrag;
    markerDrag = null;
    document.removeEventListener("pointermove", navPointerMove, true);
    document.removeEventListener("pointerup", navPointerUp, true);
    try { if (wasDrag.raf) cancelAnimationFrame(wasDrag.raf); } catch (_) {}
    try { app.canvas?.setDirtyCanvas?.(true, true); } catch (_) {}
}

// ---------------------------------------------------------------------------
// v67: POINT HOTKEYS - canonical combos + assignment + the keydown engine
// ---------------------------------------------------------------------------
// Canonical form (the ONLY thing stored / compared):
//     [Ctrl+][Alt+][Shift+][Meta+]<KEY>   e.g. "F3", "Ctrl+Shift+1", "Alt+G"
// KEY is derived from the PHYSICAL key (e.code), so an assignment survives
// keyboard-layout switches (RU/EN): the same keycap always matches. Numpad
// keys become word tokens (Num1, NumPlus...) so the "+"-split can never
// mis-parse a stored combo.

const HOTKEY_CODE_KEY_MAP = {
    Space: "Space", Enter: "Enter", NumpadEnter: "NumEnter", Tab: "Tab",
    Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Comma: ",", Period: ".", Slash: "/", Backquote: "`",
    BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
    Backslash: "\\", Minus: "-", Equal: "=",
    NumpadAdd: "NumPlus", NumpadSubtract: "NumMinus", NumpadMultiply: "NumMul",
    NumpadDivide: "NumDiv", NumpadDecimal: "NumDot", ContextMenu: "Menu",
};

const HOTKEY_WORD_KEYS = {
    space: "Space", enter: "Enter", numpadenter: "NumEnter", tab: "Tab",
    backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
    up: "Up", arrowup: "Up", down: "Down", arrowdown: "Down",
    left: "Left", arrowleft: "Left", right: "Right", arrowright: "Right",
    menu: "Menu", numpadplus: "NumPlus", numpadminus: "NumMinus",
    numpadmul: "NumMul", numpaddivide: "NumDiv", numpaddot: "NumDot",
};

function canonKeyFromCode(code) {
    if (!code) return null;
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return "Num" + m[1];
    m = /^F(\d{1,2})$/.exec(code);
    if (m) return code;                                    // F1..F24 as-is
    return HOTKEY_CODE_KEY_MAP[code] ?? null;
}

/** Canonicalize ONE stored key token; null = invalid (rejects the combo). */
function canonKeyToken(tok) {
    const t = String(tok ?? "").trim();
    if (!t) return null;
    if (/^F\d{1,2}$/i.test(t)) return t.toUpperCase();
    if (/^[a-z]$/i.test(t)) return t.toUpperCase();
    if (/^[0-9]$/.test(t)) return t;
    if (/^Num(?:[0-9]|Enter|Plus|Minus|Mul|Div|Dot)$/i.test(t)) {
        const body = t.slice(3);
        return "Num" + (/^[0-9]$/.test(body) ? body : body.charAt(0).toUpperCase() + body.slice(1).toLowerCase());
    }
    const w = HOTKEY_WORD_KEYS[t.toLowerCase()];
    if (w) return w;
    if (/^[,.\[\];'`\\\/\-=]$/.test(t)) return t;
    return null;
}

/**
 * Live KeyboardEvent -> canonical combo string, or null when the event must
 * NOT become a hotkey: Escape is reserved (aim/popup cancellation), modifier
 * presses alone are not combos, unknown/exotic codes are rejected rather
 * than guessed.
 */
export function hotkeyFromEvent(e) {
    try {
        if (!e || typeof e !== "object") return null;
        if (e.key === "Escape" || e.key === "Dead") return null;
        if (/^(Shift|Control|Alt|Meta)$/.test(String(e.key ?? ""))) return null;
        if (/^(Shift|Control|Alt|Meta|OS|Fn|CapsLock|Hyper|Super|Code\d*)\w*$/.test(String(e.code ?? ""))) {
            return null;                                   // bare modifier press
        }
        let key = canonKeyFromCode(e.code);
        if (!key) {
            // No usable e.code (synthetic events / exotic keyboards): accept a
            // plain single-character or F-key from e.key, reject the rest.
            const k = String(e.key ?? "");
            if (k.length === 1) key = /[a-z]/i.test(k) ? k.toUpperCase() : k;
            else if (/^F\d{1,2}$/.test(k)) key = k;
            else return null;
        }
        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Meta");
        parts.push(key);
        return parts.join("+");
    } catch (_) { return null; }
}

/** Stored (possibly old / hand-edited) string -> canonical combo or null. */
export function canonicalHotkey(str) {
    if (typeof str !== "string") return null;
    const s = str.trim();
    if (!s) return null;
    const mods = { Ctrl: false, Alt: false, Shift: false, Meta: false };
    let keyToken = null;
    for (const rawPart of s.split("+")) {
        const p = rawPart.trim().toLowerCase();
        if (!p) return null;                               // "Ctrl++" and friends
        if (p === "ctrl" || p === "control") { mods.Ctrl = true; continue; }
        if (p === "alt" || p === "option") { mods.Alt = true; continue; }
        if (p === "shift") { mods.Shift = true; continue; }
        if (p === "meta" || p === "cmd" || p === "command" ||
            p === "win" || p === "super") { mods.Meta = true; continue; }
        if (keyToken !== null) return null;                // two key tokens
        keyToken = rawPart;
    }
    if (!keyToken) return null;                            // modifiers only
    const key = canonKeyToken(keyToken);
    if (!key) return null;
    const parts = [];
    if (mods.Ctrl) parts.push("Ctrl");
    if (mods.Alt) parts.push("Alt");
    if (mods.Shift) parts.push("Shift");
    if (mods.Meta) parts.push("Meta");
    parts.push(key);
    return parts.join("+");
}

/** First nav item (all hubs, any tab) owning this combo, or null. */
export function findNavHotkeyOwner(combo, exceptItem = null) {
    const c = canonicalHotkey(combo);
    if (!c) return null;
    for (const { item, hub } of getNavItems()) {
        if (exceptItem && item === exceptItem) continue;
        const nav = normalizeNav(item);
        if (nav && nav.hotkey === c) return { item, hub, combo: c };
    }
    return null;
}

/**
 * Assign (or clear) a point's hotkey. Duplicates are REFUSED - two points on
 * one combo would make the second silently dead (first match wins). Returns
 * { ok:true, combo } | { ok:false, reason, combo?, owner? }.
 */
export function assignNavHotkey(item, combo) {
    const nav = normalizeNav(item);
    if (!nav) return { ok: false, reason: "not-nav" };
    if (combo == null || combo === "") {                   // explicit clear
        nav.hotkey = null;
        return { ok: true, combo: null };
    }
    const c = canonicalHotkey(combo);
    if (!c) return { ok: false, reason: "invalid", combo: null };
    const owner = findNavHotkeyOwner(c, item);
    if (owner) return { ok: false, reason: "duplicate", combo: c, owner };
    nav.hotkey = c;
    return { ok: true, combo: c };
}

// The engine: ONE permanent document-CAPTURE keydown listener (same
// interception discipline as the aim/marker listeners - it sees every key
// before the canvas and ComfyUI's own shortcut handlers do).
function navHotkeyKeyDown(e) {
    try {
        if (!getNavHotkeysOn()) return;
        if (aimState || markerDrag) return;                // modal modes win
        if (e.repeat) return;
        const t = e.target ?? null;
        if (t) {
            const tag = String(t.tagName ?? "").toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            if (t.isContentEditable === true) return;
        }
        const combo = hotkeyFromEvent(e);
        if (!combo) return;
        const owner = findNavHotkeyOwner(combo);
        if (!owner) return;          // unmatched keys stay COMPLETELY native
        e.preventDefault();
        e.stopPropagation();
        toastUi(`⌨ ${owner.item.customLabel ?? "Point"}`);
        navJump(owner.item);
    } catch (_) { /* a hotkey failure must never break the page's keyboard */ }
}

// Registered at module load: the engine needs no canvas init, and a keydown
// before ComfyUI finishes booting simply finds no match (no-op).
try { document.addEventListener("keydown", navHotkeyKeyDown, true); } catch (_) {}

// ---------------------------------------------------------------------------
// Canvas right-click menu: "Add navigation point here"
// ---------------------------------------------------------------------------

function addPointViaMenu(worldPos) {
    const hubs = allHubs();
    if (!hubs.length) {
        toastUi("⚠ No Settings Hub on this workflow - add one first (double-click canvas → search \"SettingsHub\")");
        return;
    }
    const ctx = activeGraphContext();
    if (!ctx.graph) { toastUi("⚠ No active graph"); return; }
    const place = (hub) => {
        let cfg = null;
        try { cfg = getHubConfig(hub); } catch (_) {}
        const tabId = getActiveTabId(cfg ?? {}) ?? "tab_default";
        const item = createNavItem(hub, tabId, {
            graphUuid: ctx.uuid, graphName: ctx.path, pos: worldPos,
            zoom: currentCanvasZoom(),   // v69: pin the zoom the user sees
        });
        rerenderUi(hub);
        toastUi(`🧭 "${item.customLabel}" → ${hub.title ?? "Settings Hub"} (${ctx.path})`);
    };
    if (hubs.length === 1) { place(hubs[0]); return; }
    openHubPickMenu(hubs, (hub) => place(hub));
}

function openHubPickMenu(hubs, onPick) {
    closeHubPickMenu();
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-nav-hubpick";
    pop.innerHTML =
        `<div class="hub-menu-title">🧭 Add point to hub…</div>` +
        hubs.map((h, i) => {
            let tabName = "?";
            try {
                const cfg = getHubConfig(h);
                tabName = cfg?.tabs?.find((t) => t.id === getActiveTabId(cfg))?.name ?? "?";
            } catch (_) {}
            return `<div class="hub-menu-item" data-nav-hub="${i}">${esc(h.title ?? "Settings Hub")} · tab: ${esc(tabName)}</div>`;
        }).join("") +
        `<div class="hub-menu-cancel" data-nav-hub="cancel">Cancel</div>`;
    document.body.appendChild(pop);

    // Outside-click closer (document capture, removed with the popup) - the
    // menu lives on body, so it needs its own dismissal, like every other
    // body-level popup in the pack.
    const outside = (e) => {
        if (pop.contains(e.target)) return;
        closeHubPickMenu();
    };
    document.addEventListener("pointerdown", outside, true);
    const close = () => {
        document.removeEventListener("pointerdown", outside, true);
        pop.remove();
        hubPickPop = null;
    };
    hubPickPop = { pop, close };

    let left = 6, top = 6;
    try {
        const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
        const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 160;
        left = Math.max(6, Math.min(vw - pw - 6, (vw - pw) / 2));
        top = Math.max(6, Math.min(vh - ph - 6, (vh - ph) / 2));
    } catch (_) {}
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.addEventListener("click", (e) => {
        const it = e.target.closest("[data-nav-hub]");
        if (!it) return;
        e.stopPropagation();
        const v = it.dataset.navHub;
        close();
        if (v === "cancel") return;
        const hub = hubs[Number(v)];
        if (hub) { try { onPick(hub); } catch (err) { console.warn("[SettingsHub] nav hub pick failed:", err); } }
    });
}

let hubPickPop = null;   // { pop, close }

function closeHubPickMenu() {
    try { hubPickPop?.close(); } catch (_) {}
    hubPickPop = null;
    try { document.querySelector(".hub-nav-hubpick")?.remove(); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Canvas hook installation (markers painter + RMB menu) - idempotent
// ---------------------------------------------------------------------------

let canvasHooksInstalled = false;

function protoOfCanvas() {
    try {
        return window.LGraphCanvas?.prototype ?? app.canvas?.constructor?.prototype ?? null;
    } catch (_) { return null; }
}

function installMarkerPainter(proto) {
    if (!proto || proto.__hubNavMarkers) return true;
    const pick = typeof proto.draw === "function" ? "draw"
        : (typeof proto.drawGraph === "function" ? "drawGraph" : null);
    if (!pick) return false;
    proto.__hubNavMarkers = true;
    const orig = proto[pick];
    proto[pick] = function (...args) {
        const r = orig.apply(this, args);
        try { paintNavMarkers(this); } catch (_) {}
        return r;
    };
    return true;
}

function installCanvasMenu(proto) {
    if (!proto || proto.__hubNavMenu) return true;
    if (typeof proto.getCanvasMenuOptions !== "function") return false;
    proto.__hubNavMenu = true;
    const orig = proto.getCanvasMenuOptions;
    proto.getCanvasMenuOptions = function (...args) {
        const items = orig.apply(this, args);
        try {
            if (getNavMenuOn() && Array.isArray(items)) {
                // graph_mouse is maintained on the canvas instance that opens
                // the menu; a foreign `this` falls back to the main canvas.
                const gm = Array.isArray(this.graph_mouse) ? this.graph_mouse
                    : (Array.isArray(app.canvas?.graph_mouse) ? app.canvas.graph_mouse : null);
                const pos = gm ? [Number(gm[0]) || 0, Number(gm[1]) || 0] : null;
                items.unshift({
                    content: "🧭 Add navigation point here",
                    callback: () => { if (pos) addPointViaMenu(pos); },
                });
            }
        } catch (_) {}
        return items;
    };
    return true;
}

export function installNavCanvasHooks() {
    if (canvasHooksInstalled) return true;
    const proto = protoOfCanvas();
    if (!proto) return false;
    const okPaint = installMarkerPainter(proto);
    const okMenu = installCanvasMenu(proto);
    if (!okPaint || !okMenu) return false;
    canvasHooksInstalled = true;
    try { document.addEventListener("pointerdown", navPointerDown, true); } catch (_) {}
    return true;
}

// Retry poll: globals appear only after canvas init (same pattern as the
// badge painter in hub_node.js); the extension setup() below tries first.
{
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (installNavCanvasHooks() || tries > 600) clearInterval(timer);
    }, 100);
}

app.registerExtension({
    name: "Comfy.SettingsHub.nav",
    setup() {
        try { installNavCanvasHooks(); } catch (_) {}
    },
    afterConfigureGraph() {
        // A workflow switch rebuilds every subgraph object - the uuid index
        // and the per-graph marker lists must not survive it.
        markersVersionBump();
    },
});

// ---------------------------------------------------------------------------
// UI bridge (the renderer forwards rerender/toast - no import cycle)
// ---------------------------------------------------------------------------

const ui = { rerender: null, toast: null };

export function setNavUiHooks(hooks) {
    if (hooks && typeof hooks === "object") Object.assign(ui, hooks);
}

function rerenderUi(node) {
    try { ui.rerender?.(node); } catch (_) {}
}

function toastUi(msg) {
    try {
        if (typeof ui.toast === "function") ui.toast(msg);
        else console.info("[SettingsHub] " + msg);
    } catch (_) { console.info("[SettingsHub] " + msg); }
}
