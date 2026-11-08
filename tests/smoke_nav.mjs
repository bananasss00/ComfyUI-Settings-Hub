// ============================================================================
// SettingsHub - nav points smoke test (v67)
// ----------------------------------------------------------------------------
// Node ESM + jsdom, mirrors the smoke_hub.mjs philosophy: the REAL web/*.js
// files are copied into a sandbox with a stubbed scripts/app.js, imported
// and asserted. Covers the nav-point ENGINE (renderer DOM phases stay in the
// external harness):
//
//   NA  config: normalize + JSON round-trip + label defaults
//   NB  resolver: nested subgraphs by uuid (holders chains, Map / object
//       registries, orphan, root), activeGraphContext
//   NC  camera: absolute anchor placement (v65: TOP-LEFT, 80px margin) under
//       BOTH offset conventions, zoom null / number / clamp, converter-less
//       fallback formula, screenToWorld
//   NCE anti-drift (v62): idempotent re-anchoring, "lying" converters with
//       response slopes 2 / -1, getter-setter (frozen) offset arrays,
//       repeated full-path jumps land identically, settle guard recovers a
//       view-restore drag
//   ND  jump: enter + center, zoom semantics, orphan degradation, race guard
//   NE  entry ladder: direct setter / gesture replay / full degradation
//       (the old copy died here on a ReferenceError - regression guard)
//   NF  aim mode: canvas pick, outside/Esc/RMB cancel, world coords
//   NG  canvas hooks: painter + RMB menu wrapper + point creation via menu
//   NH  marker drag: pointer interception moves item.nav.pos
//   NI  presets: nav items never enter preset captures
//   NJ  v64 fresh-add lifecycle: nodeCreated defers the UI build (frontend
//       mounts DOM widgets only for in-graph nodes), onAdded builds it,
//       the fallback ladder repairs a dropped element and ignores
//       collapsed / foreign-view / graph-less hubs
//   NJ8 v64 sweep repair: the 1200ms DOM-truth sweep rebuilds a visible hub
//       whose element never mounted (pathological frontend), the grace
//       window prevents churn, healthy hubs are untouched
//   NJ9 v64 final escalation: one-time workflow reconfigure for a hub whose
//       UI still is not mounted (the user's own manual workaround),
//       once-per-node, never for healthy hubs
//   NJ10 v64 build self-report: every FILES-module flags itself under
//       __SettingsHubLoaded so the entry can name stale cached files
//   NK  v67 point hotkeys: canonical combo form (physical-key based),
//       assignment + duplicate refusal with the owner named, normalizeNav
//       heal + JSON round-trip, the document-capture keydown engine (jump,
//       preventDefault, unmatched keys untouched, typing-target guard,
//       repeat guard, aim-mode priority, global toggle)
//
// Run from the extension root:  node tests/smoke_nav.mjs   (jsdom required)
// ============================================================================

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";

const require = createRequire(import.meta.url);
let jsdom = null;
try { jsdom = require("jsdom"); } catch (_) {}
if (!jsdom) {
    console.error("smoke_nav: jsdom is required (npm install jsdom)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
// v82: the pack version is READ from the entry source - the suite never
// carries a release-version literal again (single-source version rule,
// docs/plan-versions.md).
const ENTRY_SRC = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
const PACK_VERSION = (ENTRY_SRC.match(/__SettingsHubBuild\s*=\s*"(v\d+)"/) || [])[1] || "v0";

// ---------------------------------------------------------------------------
// Sandbox: copy real web modules + stub app.js
// ---------------------------------------------------------------------------

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "hubnav-"));
fs.mkdirSync(path.join(SANDBOX, "scripts"), { recursive: true });
// web modules live one level deeper (Hub/web) so that "../../scripts/app.js"
// resolves to SANDBOX/scripts/app.js exactly like in ComfyUI's layout.
fs.mkdirSync(path.join(SANDBOX, "Hub", "web"), { recursive: true });
for (const f of fs.readdirSync(WEB)) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(SANDBOX, "Hub", "web", f));
}
fs.writeFileSync(
    path.join(SANDBOX, "scripts", "app.js"),
    "export const app = globalThis.__HUB_APP_STUB__;\n",
);

// ---------------------------------------------------------------------------
// DOM globals BEFORE any web module evaluates
// ---------------------------------------------------------------------------

const { JSDOM } = jsdom;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.localStorage = dom.window.localStorage; } catch (_) {}
try { globalThis.navigator = dom.window.navigator; } catch (_) {}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame
    ? dom.window.cancelAnimationFrame.bind(dom.window)
    : clearTimeout;
if (dom.window.DOMMatrix) globalThis.DOMMatrix = dom.window.DOMMatrix;

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// app + canvas stubs
// ---------------------------------------------------------------------------

const appStub = {
    registerExtension(ext) { appStub.__extensions.push(ext); },
    __extensions: [],
    canvas: null,
    graph: null,
};
globalThis.__HUB_APP_STUB__ = appStub;
// The production entry stamps this BEFORE importing submodules; the sandbox
// loads the pack without the entry, so it stamps the same value READ FROM
// THE ENTRY SOURCE (v82 single-source rule - no per-suite version literal).
globalThis.__SettingsHubBuild = PACK_VERSION;

function makeCanvasStub({ W = 800, H = 600, convention = "A" } = {}) {
    const el = document.createElement("canvas");
    // MUST be attached: document-capture listeners only fire for events
    // dispatched inside the document tree (unattached elements have no
    // propagation path ancestors).
    document.body.appendChild(el);
    el.getBoundingClientRect = () => ({
        left: 0, top: 0, right: W, bottom: H, width: W, height: H,
    });
    const ds = {
        scale: 1,
        offset: [0, 0],
        min_scale: 0.1,
        max_scale: 2,
    };
    if (convention === "A") {
        // Project contract: screen = (world - offset) * scale
        ds.convertOffsetToCanvas = (p) => [(p[0] - ds.offset[0]) * ds.scale, (p[1] - ds.offset[1]) * ds.scale];
        ds.convertCanvasToOffset = (p) => [p[0] / ds.scale + ds.offset[0], p[1] / ds.scale + ds.offset[1]];
    } else {
        // Opposite-sign convention (world = offset - screen/scale) - the
        // delta-centering must be correct under BOTH.
        ds.convertOffsetToCanvas = (p) => [(ds.offset[0] - p[0]) * ds.scale, (ds.offset[1] - p[1]) * ds.scale];
        ds.convertCanvasToOffset = (p) => [ds.offset[0] - p[0] / ds.scale, ds.offset[1] - p[1] / ds.scale];
    }
    const c = {
        canvas: el,
        ds,
        graph: null,
        graph_mouse: [0, 0],
        ctx: null,
        dirtyCalls: 0,
        setDirtyCanvas() { c.dirtyCalls++; },
        setGraph(g) { c.graph = g; },   // direct setter of the entry ladder
    };
    return c;
}

function makeGraph(id, nodes = [], registry = null) {
    const g = { id, _nodes: nodes };
    if (registry) g._subgraphs = registry;
    return g;
}

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const approx2 = (p, q, eps = 1e-6) => approx(p[0], q[0], eps) && approx(p[1], q[1], eps);

// v65 anchor: the stub view is 800x600 CSS px, so viewAnchorPx() pins the
// full NAV_ANCHOR_MARGIN (80 < 25% of either side). Every camera expectation
// below asserts the point lands HERE - at the top-left anchor, not at the
// old screen center [400, 300].
const ANCHOR = [80, 80];

// ---------------------------------------------------------------------------
// Module imports (sandboxed copies)
// ---------------------------------------------------------------------------

const { getHubConfig, getActiveTabId, trackHubNode, forgetHubNode } = await import(path.join(SANDBOX, "Hub", "web", "core.js"));
const {
    NAV_TYPE, isNavItem, normalizeNav, createNavItem, getNavItems,
    resolveNavTarget, activeGraphContext, screenToWorld, setActiveViewAnchor,
    enterOwnerGraph, navJump, armAim, cancelAim, isAiming, markersVersionBump,
    installNavCanvasHooks, setNavUiHooks, currentCanvasZoom,
    hotkeyFromEvent, canonicalHotkey, findNavHotkeyOwner, assignNavHotkey,
} = await import(path.join(SANDBOX, "Hub", "web", "nav_points.js"));
const { captureActiveTab } = await import(path.join(SANDBOX, "Hub", "web", "preset_manager.js"));

// The renderer gets pulled in transitively (preset chain) and wires its
// renderHub through setNavUiHooks - a bare stub hub would make it log
// errors on every nav CRUD. Engine tests do not need the DOM UI: override
// the bridge with silent no-ops.
setNavUiHooks({ rerender: () => {}, toast: () => {} });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
    if (cond) { pass++; }
    else {
        fail++;
        failures.push(`${name}${detail ? " :: " + detail : ""}`);
        console.error(`  ✗ ${name}${detail ? " :: " + detail : ""}`);
    }
}
function phase(title) { console.log(`— ${title}`); }

// ---------------------------------------------------------------------------
// Shared fixture: root → subA (uuid-A) → subB (uuid-B)
// ---------------------------------------------------------------------------

function buildTree(registryKind = "array") {
    const subB = makeGraph("uuid-B", []);
    const holderB = { subgraph: subB, title: "Sub B" };
    const subA = makeGraph("uuid-A", [holderB]);
    const holderA = { subgraph: subA, title: "Sub A" };
    const root = makeGraph("root-graph", [holderA]);
    if (registryKind === "map") root._subgraphs = new Map([["uuid-A", subA], ["uuid-B", subB]]);
    else if (registryKind === "object") root._subgraphs = { "uuid-A": subA, "uuid-B": subB };
    else root._subgraphs = [subA, subB];
    return { root, subA, subB, holderA, holderB };
}

function freshHub(label = "Settings Hub") {
    const hub = { type: "SettingsHub", title: label, properties: {} };
    getHubConfig(hub);
    trackHubNode(hub);
    ALL_HUBS.push(hub);
    return hub;
}

const ALL_HUBS = [];
/** Forget every previously tracked hub - phases that rely on "single hub"
 *  behavior (RMB menu direct placement) must not see earlier fixtures. */
function resetHubs() {
    for (const h of ALL_HUBS) forgetHubNode(h);
    ALL_HUBS.length = 0;
}

// ============================================================================
// NA — config / normalize / round-trip
// ============================================================================

phase("NA config + normalize + JSON round-trip");
{
    const hub = freshHub();
    const cfg = getHubConfig(hub);
    const item = createNavItem(hub, cfg.activeTabId, {
        graphUuid: "uuid-A", graphName: "Main ▸ Sub A", pos: [10.5, -3.25],
    });
    check("NA type", item.type === NAV_TYPE && isNavItem(item));
    check("NA default label", item.customLabel === "Point 1", item.customLabel);
    check("NA order", item.order === 0);
    check("NA zoom default null", item.nav.zoom === null);
    check("NA pos stored", approx2(item.nav.pos, [10.5, -3.25]));

    const second = createNavItem(hub, cfg.activeTabId, {});
    check("NA second label", second.customLabel === "Point 2", second.customLabel);
    check("NA root uuid null", second.nav.graphUuid === null);

    // normalize heals garbage
    item.nav.zoom = "0.75";                       // string number
    item.nav.pos = ["x", 2];                      // NaN side
    let nav = normalizeNav(item);
    check("NA zoom string healed", nav.zoom === 0.75);
    check("NA pos NaN -> 0", nav.pos[0] === 0 && nav.pos[1] === 2);
    item.nav.zoom = -2; nav = normalizeNav(item);
    check("NA negative zoom -> null", nav.zoom === null);
    item.nav.zoom = 0; nav = normalizeNav(item);
    check("NA zero zoom -> null", nav.zoom === null);
    item.nav.zoom = "abc"; nav = normalizeNav(item);
    check("NA garbage zoom -> null", nav.zoom === null);
    item.nav.zoom = "0.75"; nav = normalizeNav(item);
    check("NA zoom restored for round-trip", nav.zoom === 0.75);
    item.nav.graphUuid = 12345; nav = normalizeNav(item);
    check("NA uuid stringified", nav.graphUuid === "12345");
    item.nav.graphUuid = null; nav = normalizeNav(item);
    check("NA null uuid stays", nav.graphUuid === null);

    // JSON round-trip (workflow save / load)
    const restored = JSON.parse(JSON.stringify(hub.properties));
    const hub2 = { type: "SettingsHub", properties: restored };
    const cfg2 = getHubConfig(hub2);
    const navItems = cfg2.items.filter(isNavItem);
    check("NA round-trip count", navItems.length === 2);
    check("NA round-trip zoom", normalizeNav(navItems[0]).zoom === 0.75);
    check("NA round-trip label", navItems[0].customLabel === "Point 1");
}

// ============================================================================
// NB — resolver
// ============================================================================

phase("NB resolver (uuid BFS, registries, orphans)");
for (const kind of ["array", "map", "object"]) {
    const { root, subA, subB, holderA, holderB } = buildTree(kind);
    appStub.graph = root;
    appStub.canvas = makeCanvasStub();
    appStub.canvas.graph = root;
    markersVersionBump();

    const t0 = resolveNavTarget({ graphUuid: null });
    check(`NB[${kind}] root`, t0.ok && t0.graph === root);
    const t1 = resolveNavTarget({ graphUuid: "uuid-A" });
    check(`NB[${kind}] subA`, t1.ok && t1.graph === subA);
    check(`NB[${kind}] subA holders`, t1.holders.length === 1 && t1.holders[0] === holderA);
    const t2 = resolveNavTarget({ graphUuid: "uuid-B" });
    check(`NB[${kind}] nested subB`, t2.ok && t2.graph === subB);
    check(`NB[${kind}] nested holders`, t2.holders.length === 2 &&
        t2.holders[0] === holderA && t2.holders[1] === holderB);
    const t3 = resolveNavTarget({ graphUuid: "dead-uuid" });
    check(`NB[${kind}] orphan`, !t3.ok && t3.reason === "orphan");

    const ctx = activeGraphContext();
    check(`NB[${kind}] ctx root`, ctx.uuid === null && ctx.path === "Main");
    appStub.canvas.graph = subB;
    markersVersionBump();
    const ctx2 = activeGraphContext();
    check(`NB[${kind}] ctx nested`, ctx2.uuid === "uuid-B", JSON.stringify(ctx2));
    check(`NB[${kind}] ctx path`, String(ctx2.path).startsWith("Main ▸"), ctx2.path);
}
{
    // Stale canvas graph (a subgraph of ANOTHER workflow) is unreachable
    const { root } = buildTree();
    appStub.graph = root;
    const stale = makeGraph("uuid-stale", []);
    appStub.canvas = makeCanvasStub();
    appStub.canvas.graph = stale;
    markersVersionBump();
    const t = resolveNavTarget({ graphUuid: "uuid-stale" });
    check("NB stale graph is orphan", !t.ok);
}

// ============================================================================
// NC — camera math
// ============================================================================

phase("NC camera (absolute anchor, zoom semantics, fallback)");
for (const convention of ["A", "B"]) {
    const c = makeCanvasStub({ convention });
    appStub.canvas = c;

    // zoom null -> ds.scale untouched, point pinned at the anchor
    c.ds.scale = 1.3;
    setActiveViewAnchor([100, -50], null);
    check(`NC[${convention}] null zoom keeps scale`, c.ds.scale === 1.3);
    check(`NC[${convention}] anchored`,
        approx2(c.ds.convertCanvasToOffset(ANCHOR), [100, -50]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));

    // numeric zoom applied BEFORE anchoring
    setActiveViewAnchor([40, 60], 0.5);
    check(`NC[${convention}] zoom applied`, c.ds.scale === 0.5);
    check(`NC[${convention}] anchored after zoom`,
        approx2(c.ds.convertCanvasToOffset(ANCHOR), [40, 60]));

    // clamp to ds limits
    setActiveViewAnchor([0, 0], 5);
    check(`NC[${convention}] clamp max`, c.ds.scale === 2);
    setActiveViewAnchor([0, 0], 0.001);
    check(`NC[${convention}] clamp min`, c.ds.scale === 0.1);
}
{
    // Converter-less fallback: project formula offset = p - ANCHOR/scale
    const c = makeCanvasStub();
    delete c.ds.convertCanvasToOffset;
    delete c.ds.convertOffsetToCanvas;
    appStub.canvas = c;
    c.ds.scale = 2;
    setActiveViewAnchor([10, 20], null);
    const ax = ANCHOR[0], ay = ANCHOR[1];   // v65 top-left anchor (80, 80)
    check("NC fallback offset", approx2(c.ds.offset, [10 - ax / 2, 20 - ay / 2]),
        JSON.stringify(c.ds.offset));
    // round trip through the fallback relation: world = screen/s + offset
    check("NC fallback anchor", approx2([ax / 2 + c.ds.offset[0], ay / 2 + c.ds.offset[1]], [10, 20]));
}
{
    // screenToWorld via converters + fallback
    const c = makeCanvasStub();
    appStub.canvas = c;
    setActiveViewAnchor([100, -50], null);
    check("NC screenToWorld anchor", approx2(screenToWorld(ANCHOR[0], ANCHOR[1]), [100, -50]));
    check("NC screenToWorld corner", approx2(screenToWorld(0, 0), [100 - ANCHOR[0], -50 - ANCHOR[1]]));
    delete c.ds.convertCanvasToOffset;
    c.ds.offset = [7, 8]; c.ds.scale = 2;
    check("NC screenToWorld fallback", approx2(screenToWorld(10, 10), [10 / 2 + 7, 10 / 2 + 8]));
}

// ============================================================================
// NCE — anti-drift camera (v62): the v61 delta method turned RELATIVE on
// real frontends whose view layer answered the offset write with a slope
// other than +1, so every click landed further away from the point.
// ============================================================================

phase("NCE anti-drift (idempotence, lying converters, frozen offset)");
{
    // Idempotence: anchoring from wildly different starting views must land
    // on the SAME offset every time (regression for the reported drift).
    const c = makeCanvasStub({ convention: "A" });
    appStub.canvas = c;
    const seen = [];
    for (const start of [[5000, -3000], [-9999, 9999], [42, -42]]) {
        c.ds.offset = [...start];
        setActiveViewAnchor([37, -81], null);
        seen.push([...c.ds.offset]);
    }
    check("NCE idempotent anchoring", approx2(seen[0], seen[1]) && approx2(seen[0], seen[2]),
        JSON.stringify(seen));
    check("NCE idempotent value", approx2(c.ds.convertCanvasToOffset(ANCHOR), [37, -81]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));
}
for (const slope of [2, -1]) {
    // "Lying" converter: the view layer answers an offset write of d with a
    // world-under-anchor change of slope*d. The v61 delta shift drifted
    // here; the v62 probe must measure the slope and Newton-step exactly -
    // now for the v65 top-left anchor as well.
    const c = makeCanvasStub({ convention: "A" });
    appStub.canvas = c;
    c.ds.convertCanvasToOffset = (p) => [
        slope * c.ds.offset[0] + p[0] / c.ds.scale,
        slope * c.ds.offset[1] + p[1] / c.ds.scale,
    ];
    // start far away: any residual read-modify-write dependence shows up
    c.ds.offset = [-4200, 3300];
    setActiveViewAnchor([30, -40], null);
    let got = c.ds.convertCanvasToOffset(ANCHOR);
    check(`NCE slope-${slope} anchored`, approx2(got, [30, -40], 1e-4), JSON.stringify(got));
    // ...and a second click from ANOTHER far view must land identically
    c.ds.offset = [9900, -9900];
    setActiveViewAnchor([30, -40], null);
    got = c.ds.convertCanvasToOffset(ANCHOR);
    check(`NCE slope-${slope} idempotent`, approx2(got, [30, -40], 1e-4), JSON.stringify(got));
}
{
    // Getter/setter-backed offset ("frozen" array): element writes are
    // silently LOST - only whole-array assignment reaches the view.
    const c = makeCanvasStub({ convention: "A" });
    appStub.canvas = c;
    const hidden = [0, 0];
    delete c.ds.offset;
    Object.defineProperty(c.ds, "offset", {
        configurable: true,
        get: () => [hidden[0], hidden[1]],
        set: (v) => { hidden[0] = Number(v?.[0]) || 0; hidden[1] = Number(v?.[1]) || 0; },
    });
    setActiveViewAnchor([11, 22], null);
    check("NCE frozen-offset anchored", approx2(c.ds.convertCanvasToOffset(ANCHOR), [11, 22]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));
    c.ds.offset = [7000, -7000];
    setActiveViewAnchor([11, 22], null);
    check("NCE frozen-offset idempotent", approx2(c.ds.convertCanvasToOffset(ANCHOR), [11, 22]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));
}

// ============================================================================
// ND — jump engine
// ============================================================================

phase("ND jump (enter + center, zoom, orphan, race)");
{
    const { root, subA, subB } = buildTree();
    const hub = freshHub();
    appStub.graph = root;
    const c = makeCanvasStub();
    c.graph = root;
    appStub.canvas = c;
    markersVersionBump();

    const cfg = getHubConfig(hub);
    const pB = createNavItem(hub, getActiveTabId(cfg), {
        graphUuid: "uuid-B", graphName: "Main ▸ Sub A ▸ Sub B", pos: [5, 7],
    });

    c.ds.scale = 0.7;
    await navJump(pB);
    check("ND entered nested", c.graph === subB);
    check("ND anchored", approx2(c.ds.convertCanvasToOffset(ANCHOR), [5, 7]));
    check("ND null zoom keeps scale", c.ds.scale === 0.7);

    // numeric zoom
    pB.nav.zoom = 0.5;
    await navJump(pB);
    check("ND zoom applied", c.ds.scale === 0.5);
    check("ND anchored after zoom", approx2(c.ds.convertCanvasToOffset(ANCHOR), [5, 7]));

    // jump to root exits the subgraph
    const pRoot = createNavItem(hub, getActiveTabId(cfg), { graphUuid: null, pos: [-9, 3] });
    await navJump(pRoot);
    check("ND exit to root", c.graph === root);
    check("ND root anchored", approx2(c.ds.convertCanvasToOffset(ANCHOR), [-9, 3]));

    // jump to subA from subB-like state
    c.graph = subB;
    const pA = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-A", pos: [1, 2] });
    await navJump(pA);
    check("ND cross jump to subA", c.graph === subA);

    // orphan: clean degradation, no throw, no graph switch
    c.graph = root;
    const pDead = createNavItem(hub, getActiveTabId(cfg), {
        graphUuid: "dead-uuid", graphName: "Gone", pos: [0, 0],
    });
    let threw = false;
    try { await navJump(pDead); } catch (e) { threw = true; }
    check("ND orphan no throw", !threw);
    check("ND orphan no switch", c.graph === root);

    // race: two concurrent jumps - the fresher one wins the camera
    c.graph = root;
    const pa = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-A", pos: [11, 0] });
    const pb = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-B", pos: [22, 0] });
    const j1 = navJump(pa);
    const j2 = navJump(pb);
    await Promise.all([j1, j2]);
    check("ND race winner is fresher", approx2(c.ds.convertCanvasToOffset(ANCHOR), [22, 0]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));

    // v62 drift regression: jump to the SAME point repeatedly, from wildly
    // different starting views, forcing the full entry ladder every time -
    // every landing must be exact AND identical (v61 accumulated a growing
    // offset on real frontends: "relative jump, further away every click").
    const pB2 = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-B", pos: [5, 7] });
    const landings = [];
    for (const start of [[1234, -567], [-9000, 8000], [64, 64]]) {
        c.ds.offset = [...start];
        c.graph = root;
        await navJump(pB2);
        const got = c.ds.convertCanvasToOffset(ANCHOR);
        landings.push(got);
        check("ND repeat jump anchored", approx2(got, [5, 7]), JSON.stringify(got));
    }
    check("ND repeat jump idempotent", approx2(landings[0], landings[2], 1e-6),
        JSON.stringify(landings));

    // v62 settle guard: a frontend that drags the view away right AFTER the
    // jump (subgraph-open animation / view restore) must not eat the anchor.
    {
        c.graph = root;
        c.ds.offset = [500, -500];
        const expected = [5 - ANCHOR[0] / c.ds.scale, 7 - ANCHOR[1] / c.ds.scale];
        let phase = 0, guard = 0;
        const step = () => {
            if (guard++ > 400) return;                    // failsafe, self-removes
            if (phase === 0) {
                if (approx2(c.ds.offset, expected, 1e-6)) phase = 1;   // jump anchored
            } else if (phase === 1) {
                c.ds.offset[0] -= 600;                    // one-shot "view restore" drag
                c.ds.offset[1] += 450;
                phase = 2;
                return;                                   // chain stops here
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        await navJump(pB2);
        const got = c.ds.convertCanvasToOffset(ANCHOR);
        check("ND settle recovers view restore", approx2(got, [5, 7]), JSON.stringify(got));
    }
}

// ============================================================================
// NE — entry ladder
// ============================================================================

phase("NE entry ladder (setters / gesture / degradation)");
{
    const { root, subA, holderA } = buildTree();
    appStub.graph = root;

    // 1) direct setter works
    const c1 = makeCanvasStub();
    c1.graph = root;
    appStub.canvas = c1;
    check("NE setter ok", await enterOwnerGraph(subA, [holderA]) === true && c1.graph === subA);

    // 2) setters broken -> gesture replay via processNodeDoubleClicked
    const c2 = makeCanvasStub();
    c2.graph = root;
    c2.setGraph = () => { throw new Error("nope"); };
    c2.processNodeDoubleClicked = (n) => { c2.graph = n.subgraph; };
    appStub.canvas = c2;
    check("NE gesture ok", await enterOwnerGraph(subA, [holderA]) === true && c2.graph === subA);

    // 3) everything broken -> clean false (NO ReferenceError - the moved
    //    ladder fixed the latent `sleep is not defined` crash)
    const c3 = makeCanvasStub();
    c3.graph = root;
    c3.setGraph = () => { throw new Error("nope"); };
    appStub.canvas = c3;
    let err = null;
    let ok3 = false;
    try { ok3 = await enterOwnerGraph(subA, [holderA]); } catch (e) { err = e; }
    check("NE full degradation false", ok3 === false && err === null, String(err));
    check("NE no graph switch", c3.graph === root);

    // 4) no canvas at all
    appStub.canvas = null;
    check("NE no canvas", await enterOwnerGraph(subA, [holderA]) === false);
}

// ============================================================================
// NF — aim mode
// ============================================================================

phase("NF aim mode (pick / cancels / world coords)");
{
    const { root, subA } = buildTree();
    appStub.graph = root;
    const c = makeCanvasStub();
    c.graph = subA;
    appStub.canvas = c;
    markersVersionBump();
    const el = c.canvas;

    let picked = null, cancelled = 0;
    check("NF arm", armAim({ onPick: (ctx, pos) => { picked = { ctx, pos }; }, onCancel: () => { cancelled++; } }) === true);
    check("NF isAiming", isAiming() === true);

    // click OUTSIDE the canvas (hub DOM) cancels and does not pick
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
    await tick();
    check("NF outside cancels", cancelled === 1 && !isAiming());
    check("NF outside does not pick", picked === null);
    div.remove();

    // LMB on canvas picks with world coords from the ACTIVE graph
    picked = null;
    armAim({
        onPick: (ctx, pos) => { picked = { ctx, pos }; },
        onCancel: () => { cancelled++; },
    });
    el.dispatchEvent(new dom.window.MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 200, clientY: 120,
    }));
    await tick();
    check("NF picked", !!picked);
    check("NF world coords", picked && approx2(picked.pos, [200, 120]),
        picked && JSON.stringify(picked.pos));
    check("NF ctx graph", picked && picked.ctx.uuid === "uuid-A", picked && picked.ctx.uuid);
    check("NF aim disarmed after pick", !isAiming());

    // Esc cancels
    cancelled = 0; picked = null;
    armAim({ onPick: (ctx, pos) => { picked = { ctx, pos }; }, onCancel: () => { cancelled++; } });
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    check("NF Esc cancels", cancelled === 1 && !isAiming());

    // RMB cancels (no menu, no pick)
    armAim({ onPick: (ctx, pos) => { picked = { ctx, pos }; }, onCancel: () => { cancelled++; } });
    el.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 2, clientX: 10, clientY: 10 }));
    await tick();
    check("NF RMB cancels", cancelled === 2 && picked === null && !isAiming());

    // single-flight: a fresh aim replaces a pending one without a stray cancel
    cancelled = 0;
    armAim({ onPick: () => {}, onCancel: () => { cancelled++; } });
    armAim({ onPick: () => {}, onCancel: () => { cancelled++; } });
    check("NF single-flight", cancelled === 0 && isAiming());
    cancelAim();
    check("NF cancelAim", cancelled === 1 && !isAiming());
}

// ============================================================================
// NG — canvas hooks: painter wrap + RMB menu + point creation
// ============================================================================

phase("NG canvas hooks (painter wrap, RMB menu, creation)");
{
    resetHubs();
    const { root, subA } = buildTree();
    appStub.graph = root;
    const c = makeCanvasStub();
    c.graph = subA;
    c.graph_mouse = [33, 44];
    appStub.canvas = c;
    markersVersionBump();

    const hub = freshHub();
    let drawCalls = 0;
    window.LGraphCanvas = function () {};
    window.LGraphCanvas.prototype.draw = function () { drawCalls++; };
    window.LGraphCanvas.prototype.getCanvasMenuOptions = function () {
        return [{ content: "native-item", callback: () => {} }];
    };

    check("NG hooks install", installNavCanvasHooks() === true);
    check("NG hooks idempotent", installNavCanvasHooks() === true);

    // painter: original draw still runs, wrapper does not throw without ctx
    const inst = new window.LGraphCanvas();
    inst.graph_mouse = [33, 44];   // the real canvas maintains this - stub it
    inst.draw();
    check("NG original draw ran", drawCalls === 1);

    // RMB menu: our item is prepended, native item preserved
    const items = inst.getCanvasMenuOptions();
    check("NG menu prepend", items.length === 2 &&
        String(items[0].content).includes("Add navigation point"), JSON.stringify(items.map((i) => i.content)));
    check("NG native kept", items[1].content === "native-item");

    // menu callback creates the point in the hub (single hub -> direct place)
    // v69: the CURRENT canvas zoom is pinned into the fresh point
    c.ds.scale = 0.5;
    check("NG currentCanvasZoom reads scale", currentCanvasZoom() === 0.5, String(currentCanvasZoom()));
    items[0].callback();
    const cfg = getHubConfig(hub);
    const navs = cfg.items.filter(isNavItem);
    check("NG point created", navs.length === 1, String(navs.length));
    check("NG point pos from graph_mouse", navs.length === 1 && approx2(navs[0].nav.pos, [33, 44]));
    check("NG point graph from active canvas", navs.length === 1 && navs[0].nav.graphUuid === "uuid-A");
    check("NG point graphName path", navs.length === 1 && String(navs[0].nav.graphName).includes("Sub A"));
    check("NG v69 zoom captured on creation", navs.length === 1 && navs[0].nav.zoom === 0.5,
        JSON.stringify(navs[0]?.nav?.zoom));

    // toggle off -> menu item disappears
    const gs = await import(path.join(SANDBOX, "Hub", "web", "global_settings.js"));
    gs.setNavMenuOn(false);
    const items2 = inst.getCanvasMenuOptions();
    check("NG menu toggle off", items2.length === 1 && items2[0].content === "native-item");
    gs.setNavMenuOn(true);
}

// ============================================================================
// NH — marker drag
// ============================================================================

phase("NH marker drag (pointer interception)");
{
    resetHubs();
    const { root, subA } = buildTree();
    appStub.graph = root;
    const c = makeCanvasStub();
    c.graph = subA;
    appStub.canvas = c;
    markersVersionBump();

    const hub = freshHub();
    const cfg = getHubConfig(hub);
    const item = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-A", pos: [100, 100] });
    markersVersionBump();
    await tick(5); // let the marker cache TTL settle

    const el = c.canvas;
    // down near the marker (11px world radius at scale 1)
    el.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 104, clientY: 102 }));
    await tick(5);
    // move: rAF-coalesced - wait between moves so every sample lands
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 150, clientY: 120 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160, clientY: 130 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 160, clientY: 130 }));
    await tick(10);
    check("NH drag moved point", approx2(item.nav.pos, [160, 130]), JSON.stringify(item.nav.pos));

    // down on a NODE (not the marker) must NOT start a marker drag
    subA._nodes.push({ pos: [500, 500], size: [200, 80], title: "N" });
    markersVersionBump();
    await tick(5);
    el.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 520, clientY: 510 }));
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 300 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 305, clientY: 305 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 305, clientY: 305 }));
    await tick(10);
    check("NH node wins over marker", approx2(item.nav.pos, [160, 130]), JSON.stringify(item.nav.pos));

    // markers toggle off -> no drag
    const gs = await import(path.join(SANDBOX, "Hub", "web", "global_settings.js"));
    gs.setNavMarkersOn(false);
    el.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 162, clientY: 132 }));
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 400, clientY: 400 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 405, clientY: 405 }));
    await tick(40);
    el.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 405, clientY: 405 }));
    await tick(10);
    check("NH toggle off blocks drag", approx2(item.nav.pos, [160, 130]));
    gs.setNavMarkersOn(true);
}

// ============================================================================
// NI — presets never capture nav rows
// ============================================================================

phase("NI presets exclusion");
{
    const hub = freshHub();
    const cfg = getHubConfig(hub);
    createNavItem(hub, cfg.activeTabId, { graphUuid: null, pos: [1, 2] });
    const snap = captureActiveTab(hub);
    const entries = snap?.entries ?? snap?.snapshot?.entries ?? [];
    check("NI no nav entries", entries.length === 0, JSON.stringify(entries).slice(0, 120));
}

// ============================================================================
// NJ - v63 fresh-add lifecycle (nodeCreated defers; onAdded builds; ladder)
// ============================================================================

phase("NJ fresh-add lifecycle (v63/v64)");
{
    resetHubs();
    // The REAL hub_node.js: registers "Comfy.SettingsHub.node" on appStub and
    // shares the REAL renderer (already in the module registry via the preset
    // chain), whose renderHub performs the actual DOM-widget build.
    await import(path.join(SANDBOX, "Hub", "web", "hub_node.js"));
    const ext = appStub.__extensions.find((e) => e.name === "Comfy.SettingsHub.node");
    check("NJ extension captured", !!ext);
    const { isHubUiMounted, forceHubRebuild } = await import(path.join(SANDBOX, "Hub", "web", "hub_ui_renderer.js"));

    // Faithful mock of the modern frontend's DOM-widget contract: the element
    // is mounted ONLY for nodes that are IN the graph (domWidget.ts:
    // `if (node.graph) registerWidget(widget)`). Graph-less widgets stay
    // unmounted forever in the buggy builds - the exact field report v63.
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    const mountedCount = () => layer.childElementCount;

    class FakeGraphNode {
        constructor() {
            this.type = "SettingsHub";
            this.title = "Settings Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph) layer.appendChild(element); // in-graph -> mounts
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }

    const graph = makeGraph("nj-root", []);
    appStub.graph = graph;
    appStub.canvas = { graph, setDirtyCanvas() {} };

    // 1) constructor end (nodeCreated): NOTHING may be built graph-less.
    const node = new FakeGraphNode();
    ext.nodeCreated(node);
    check("NJ nodeCreated defers build", node.widgets.length === 0, String(node.widgets.length));
    check("NJ onAdded chained", typeof node.onAdded === "function");

    // 2) graph.add() fires onAdded AFTER node.graph/node.id - UI builds there.
    graph._nodes.push(node);
    node.graph = graph;
    node.onAdded?.(graph);
    check("NJ onAdded builds widget", node.widgets.length === 1, String(node.widgets.length));
    check("NJ widget named __hub_ui", node.widgets[0]?.name === "__hub_ui");
    check("NJ element mounted in-graph", node.widgets[0]?.element?.isConnected === true);

    // 3) healthy hub: the ladder must NOT churn (two ticks pass untouched).
    const mountedBefore = mountedCount();
    await tick(700);
    check("NJ ladder no-op when healthy", node.widgets.length === 1 && mountedCount() === mountedBefore,
        `widgets=${node.widgets.length} mounted=${mountedCount()}/${mountedBefore}`);

    // 4) poisoned mount (frontend dropped the element - the reported state):
    //    isHubUiMounted answers NO and forceHubRebuild rebuilds in-graph.
    const w1 = node.widgets[0];
    w1.element.remove();
    check("NJ unmounted detected", isHubUiMounted(node) === false);
    const removed = [];
    w1.onRemove = () => removed.push(w1);
    forceHubRebuild(node);
    check("NJ rebuild spliced old widget", !node.widgets.includes(w1) && node.widgets.length === 1, String(node.widgets.length));
    check("NJ old widget unregistered", removed.length === 1);
    check("NJ new element mounted", node.widgets[0]?.element?.isConnected === true && node.widgets[0] !== w1);

    // 5) ladder self-repair: an element dropped right after the add is
    //    rebuilt automatically by the first ladder tick (150ms).
    const node2 = new FakeGraphNode();
    ext.nodeCreated(node2);
    graph._nodes.push(node2);
    node2.graph = graph;
    node2.onAdded?.(graph);
    node2.widgets[0]?.element.remove();
    await tick(450);
    check("NJ ladder self-repair", node2.widgets.length === 1 && node2.widgets[0]?.element?.isConnected === true,
        `widgets=${node2.widgets.length}`);

    // 6) collapsed hubs are left alone (mount unverifiable while collapsed).
    const node3 = new FakeGraphNode();
    ext.nodeCreated(node3);
    node3.flags.collapsed = true;
    graph._nodes.push(node3);
    node3.graph = graph;
    node3.onAdded?.(graph);
    const w3 = node3.widgets[0];
    const count3 = node3.widgets.length;
    await tick(700);
    check("NJ collapsed not rebuilt", node3.widgets.length === count3 && node3.widgets[0] === w3);

    // 7) graph-less nodes (created, never added / already removed) untouched.
    const node4 = new FakeGraphNode();
    ext.nodeCreated(node4);
    await tick(1700);
    check("NJ graph-less untouched", node4.widgets.length === 0, String(node4.widgets.length));

    appStub.canvas = null;
    appStub.graph = null;
}

// ============================================================================
// NJ8 - v64 persistent DOM-truth repair in the tab-watch sweep
// ============================================================================

phase("NJ8 sweep mount-repair (v64)");
{
    resetHubs();
    const { hubTabSweepTick } = await import(path.join(SANDBOX, "Hub", "web", "hub_ui_renderer.js"));
    const ext = appStub.__extensions.find((e) => e.name === "Comfy.SettingsHub.node");

    // Pathological frontend: widgets of freshly added nodes NEVER mount
    // (the exact field state from the v63 round-2 report - the element is
    // registered in-graph but the reactive layer never connects it).
    const layer8 = document.createElement("div");
    document.body.appendChild(layer8);
    class Node8 {
        constructor(mount) {
            this.type = "SettingsHub";
            this.title = "Settings Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
            this.__mount = mount;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph && this.__mount) layer8.appendChild(element);
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }

    const graph8 = makeGraph("nj8-root", []);
    appStub.graph = graph8;
    appStub.canvas = { graph: graph8, setDirtyCanvas() {} };

    const p1 = new Node8(false);
    ext.nodeCreated(p1);
    graph8._nodes.push(p1);
    p1.graph = graph8;
    p1.onAdded?.(graph8);
    check("NJ8 pathological hub unmounted", p1.widgets.length === 1 && p1.widgets[0].element.isConnected === false);

    const wBefore = p1.widgets[0];
    hubTabSweepTick();
    check("NJ8 sweep rebuilds unmounted hub", p1.widgets.length === 1 && p1.widgets[0] !== wBefore,
        `widgets=${p1.widgets.length}`);
    check("NJ8 repair counter + grace recorded", p1.__hubMountRepairs === 1 && (p1.__hubMountGraceUntil ?? 0) > 0);

    const wAfterFirst = p1.widgets[0];
    hubTabSweepTick(); // grace window is active - no churn
    check("NJ8 grace prevents churn", p1.widgets[0] === wAfterFirst);

    const h1 = new Node8(true);
    ext.nodeCreated(h1);
    graph8._nodes.push(h1);
    h1.graph = graph8;
    h1.onAdded?.(graph8);
    const hw = h1.widgets[0];
    hubTabSweepTick();
    check("NJ8 healthy hub untouched by sweep", h1.widgets[0] === hw && hw.element.isConnected === true);

    appStub.canvas = null;
    appStub.graph = null;
}

// ============================================================================
// NJ9 - v64 final escalation: one-time workflow reconfigure
// ============================================================================

phase("NJ9 final reconfigure repair (v64)");
{
    resetHubs();
    const { freshAddFinalRepair } = await import(path.join(SANDBOX, "Hub", "web", "hub_node.js"));
    const ext = appStub.__extensions.find((e) => e.name === "Comfy.SettingsHub.node");

    const layer9 = document.createElement("div");
    document.body.appendChild(layer9);
    class Node9 {
        constructor(mount) {
            this.type = "SettingsHub";
            this.title = "Settings Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
            this.__mount = mount;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph && this.__mount) layer9.appendChild(element);
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }

    const graph9 = makeGraph("nj9-root", []);
    graph9.serialize = () => ({ nodes: [], links: [] });
    appStub.graph = graph9;
    appStub.canvas = { graph: graph9, setDirtyCanvas() {} };
    const loads = [];
    appStub.loadGraphData = (data) => { loads.push(data); return Promise.resolve(); };

    const p2 = new Node9(false);
    ext.nodeCreated(p2);
    graph9._nodes.push(p2);
    p2.graph = graph9;
    p2.onAdded?.(graph9);
    freshAddFinalRepair(p2);
    check("NJ9 reconfigure fired once", loads.length === 1 && p2.__hubReconfiguredForMount === true,
        `loads=${loads.length}`);
    freshAddFinalRepair(p2);
    check("NJ9 reconfigure is once-per-node", loads.length === 1);

    const h2 = new Node9(true);
    ext.nodeCreated(h2);
    graph9._nodes.push(h2);
    h2.graph = graph9;
    h2.onAdded?.(graph9);
    freshAddFinalRepair(h2);
    check("NJ9 healthy hub not reconfigured", loads.length === 1 && !h2.__hubReconfiguredForMount);

    delete appStub.loadGraphData;
    appStub.canvas = null;
    appStub.graph = null;
}

// ============================================================================
// NJ10 - v82 build self-report manifest (stale-cache detector)
// ============================================================================

phase("NJ10 v82 build self-report (EXPECTED manifest)");
{
    // The sandbox harness stamps __SettingsHubBuild itself (the entry does it
    // in production). Every imported FILES-module must have self-reported AND
    // its value must equal the entry's EXPECTED manifest entry - a mismatch
    // is exactly what the entry reports as MIXED BUILD in the browser.
    // context_menu.js is not imported by this suite - excluded here.
    const flags = globalThis.__SettingsHubLoaded ?? {};
    const need = ["sync", "pins", "nav_points", "hub_node", "hub_ui_renderer", "sync_manager"];
    const expected = Object.fromEntries(
        [...ENTRY_SRC.matchAll(/"(\w+)":\s*"(v\d+)"/g)].map((m) => [m[1], m[2]]));
    const missing = need.filter((k) => !flags[k]);
    check("NJ10 all loaded modules self-reported", missing.length === 0, missing.join(","));
    const drifted = need.filter((k) => expected[k] && flags[k] !== expected[k]);
    check("NJ10 self-reports match the EXPECTED manifest", drifted.length === 0,
        drifted.map((k) => k + ":" + flags[k] + "!=" + expected[k]).join(","));
    check("NJ10 build stamp matches the entry source", globalThis.__SettingsHubBuild === PACK_VERSION);
}

// ============================================================================
// NK - v67 point hotkeys: canonical form, assignment, keydown engine
// ============================================================================

phase("NK v67 hotkeys (canonical combos, assign/dup, engine jump)");
{
    resetHubs();
    const { root, subA } = buildTree();
    appStub.graph = root;
    const c = makeCanvasStub();
    c.graph = root;
    appStub.canvas = c;
    markersVersionBump();

    const kdown = (init) => new dom.window.KeyboardEvent("keydown", init);

    // --- event -> canonical combo -------------------------------------------
    check("NK F3", hotkeyFromEvent(kdown({ key: "F3", code: "F3" })) === "F3");
    check("NK ctrl+shift+1", hotkeyFromEvent(kdown({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })) === "Ctrl+Shift+1");
    check("NK alt+letter", hotkeyFromEvent(kdown({ key: "g", code: "KeyG", altKey: true })) === "Alt+G");
    check("NK modifier order",
        hotkeyFromEvent(kdown({ key: "X", code: "KeyX", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })) === "Ctrl+Alt+Shift+Meta+X");
    check("NK escape rejected", hotkeyFromEvent(kdown({ key: "Escape", code: "Escape" })) === null);
    check("NK modifier-only rejected", hotkeyFromEvent(kdown({ key: "Shift", code: "ShiftLeft" })) === null);
    check("NK numpad digit", hotkeyFromEvent(kdown({ key: "3", code: "Numpad3" })) === "Num3");
    check("NK space", hotkeyFromEvent(kdown({ key: " ", code: "Space" })) === "Space");
    check("NK punctuation", hotkeyFromEvent(kdown({ key: ",", code: "Comma" })) === ",");
    check("NK numpad plus", hotkeyFromEvent(kdown({ key: "+", code: "NumpadAdd" })) === "NumPlus");

    // --- stored string -> canonical combo -----------------------------------
    check("NK canon lowercase", canonicalHotkey("ctrl+g") === "Ctrl+G");
    check("NK canon reorders mods", canonicalHotkey("shift+ctrl+1") === "Ctrl+Shift+1");
    check("NK canon aliases", canonicalHotkey("cmd+space") === "Meta+Space");
    check("NK canon control", canonicalHotkey("control+q") === "Ctrl+Q");
    check("NK canon numpad word", canonicalHotkey("NumPlus") === "NumPlus");
    check("NK canon modifier-only", canonicalHotkey("ctrl+shift") === null);
    check("NK canon two keys", canonicalHotkey("ctrl+a+b") === null);
    check("NK canon garbage", canonicalHotkey("not a hotkey") === null);
    check("NK canon empty", canonicalHotkey("") === null && canonicalHotkey(null) === null);

    // --- normalizeNav heal + JSON round-trip --------------------------------
    const hub = freshHub();
    const cfg = getHubConfig(hub);
    const item = createNavItem(hub, getActiveTabId(cfg), { graphUuid: "uuid-A", pos: [10, 20] });
    item.nav.hotkey = "shift+f2";
    let n = normalizeNav(item);
    check("NK heal canonicalizes", n.hotkey === "Shift+F2", n.hotkey);
    item.nav.hotkey = "bogus!!";
    n = normalizeNav(item);
    check("NK heal garbage -> null", n.hotkey === null, n.hotkey);
    item.nav.hotkey = "F2";
    const rt = JSON.parse(JSON.stringify(hub.properties));
    const it2 = getHubConfig({ type: "SettingsHub", properties: rt }).items.filter(isNavItem)[0];
    check("NK round-trip", normalizeNav(it2).hotkey === "F2", it2.nav?.hotkey);

    // --- assignment: duplicates refused, owner named ------------------------
    const item2 = createNavItem(hub, getActiveTabId(cfg), { graphUuid: null, pos: [0, 0] });
    check("NK assign ok", assignNavHotkey(item, "Ctrl+7").ok && item.nav.hotkey === "Ctrl+7");
    const dup = assignNavHotkey(item2, "ctrl+7");
    check("NK duplicate refused", !dup.ok && dup.reason === "duplicate", JSON.stringify(dup));
    check("NK duplicate names owner", dup.owner?.item === item);
    check("NK duplicate left victim untouched", item2.nav.hotkey === null);
    check("NK owner found", findNavHotkeyOwner("ctrl+7")?.item === item);
    check("NK owner none for free combo", findNavHotkeyOwner("F9") === null);
    check("NK assign invalid refused", assignNavHotkey(item2, "not a combo").ok === false);
    check("NK re-assign on same item ok", assignNavHotkey(item, "Ctrl+8").ok && item.nav.hotkey === "Ctrl+8");
    check("NK clear", assignNavHotkey(item, null).ok && item.nav.hotkey === null);
    check("NK re-assign F3 for engine", assignNavHotkey(item, "F3").ok);

    // --- ENGINE: keydown jumps the point, preventDefaulted ------------------
    c.ds.scale = 1;
    c.ds.offset = [0, 0];
    const e1 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e1);
    await tick(160);
    check("NK engine jumped", approx2(c.ds.convertCanvasToOffset(ANCHOR), [10, 20]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));
    check("NK engine entered point graph", c.graph === subA);
    check("NK engine prevented default", e1.defaultPrevented === true);

    // unmatched combo: completely native (no preventDefault, no movement)
    c.ds.offset = [500, 500];
    const e2 = kdown({ key: "F9", code: "F9", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e2);
    await tick(60);
    check("NK unmatched untouched", !e2.defaultPrevented && approx2(c.ds.offset, [500, 500]));

    // typing-target guard: the same combo inside an <input> does nothing
    const inp = document.createElement("input");
    document.body.appendChild(inp);
    c.ds.offset = [777, 777];
    const e3 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true });
    inp.dispatchEvent(e3);
    await tick(60);
    check("NK typing guard", !e3.defaultPrevented && approx2(c.ds.offset, [777, 777]));
    inp.remove();

    // auto-repeat guard
    c.ds.offset = [888, 888];
    const e4 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true, repeat: true });
    document.body.dispatchEvent(e4);
    await tick(60);
    check("NK repeat guard", !e4.defaultPrevented && approx2(c.ds.offset, [888, 888]));

    // aim mode is modal: no jump while the crosshair is armed
    c.ds.offset = [999, 999];
    let aimPicked = false;
    armAim({ onPick: () => { aimPicked = true; }, onCancel: () => {} });
    const e5 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e5);
    await tick(60);
    check("NK aim wins over engine", !aimPicked && approx2(c.ds.offset, [999, 999]) && isAiming());
    cancelAim();

    // global toggle off: engine dormant, key stays native
    const gs = await import(path.join(SANDBOX, "Hub", "web", "global_settings.js"));
    gs.setNavHotkeysOn(false);
    c.ds.offset = [1111, 1111];
    const e6 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e6);
    await tick(60);
    check("NK toggle off blocks engine", !e6.defaultPrevented && approx2(c.ds.offset, [1111, 1111]));
    gs.setNavHotkeysOn(true);
    check("NK toggle round-trip", gs.getNavHotkeysOn() === true);

    // multi-hub: an item in ANOTHER hub jumps too (the engine scans all
    // hubs, not just the first - and jump does not need the row's tab open)
    resetHubs();
    const hubB = freshHub("Hub B");
    const cfgB = getHubConfig(hubB);
    const itemB = createNavItem(hubB, getActiveTabId(cfgB), { graphUuid: null, pos: [70, 80] });
    check("NK second hub assign", assignNavHotkey(itemB, "F3").ok);
    c.graph = root;
    markersVersionBump();
    c.ds.offset = [0, 0];
    const e7 = kdown({ key: "F3", code: "F3", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e7);
    await tick(160);
    check("NK second hub engine jump", approx2(c.ds.convertCanvasToOffset(ANCHOR), [70, 80]),
        JSON.stringify(c.ds.convertCanvasToOffset(ANCHOR)));
    check("NK second hub prevented", e7.defaultPrevented === true);

    // stale-hub hygiene: once the hub is forgotten, the combo is free again
    resetHubs();
    check("NK no stale match after resetHubs", !findNavHotkeyOwner("F3"));
}

// ============================================================================
// NK2 - v68 REGRESSION: the popover key-cap CAPTURE flow (the v67 field bug
// was invisible to the engine tests above: hub_ui_renderer.js used
// hotkeyFromEvent without importing it, so the first captured keydown threw
// a silent ReferenceError AFTER preventDefault and the session wedged in
// "press keys..." forever). This phase drives the REAL UI: render -> open
// popover -> click the cap -> press keys on it -> apply -> assignment.
// ============================================================================

phase("NK2 v68 popover capture flow (UI regression)");
{
    const { syncHubNode } = await import(path.join(SANDBOX, "Hub", "web", "hub_ui_renderer.js"));

    class UiHubNode {
        constructor() {
            this.type = "SettingsHub";
            this.title = "Capture Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph) layer2.appendChild(element);
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }
    const layer2 = document.createElement("div");
    document.body.appendChild(layer2);
    const graph2 = makeGraph("nk2-root", []);
    appStub.graph = graph2;
    appStub.canvas = makeCanvasStub();
    appStub.canvas.graph = graph2;

    const hub = new UiHubNode();
    graph2._nodes.push(hub);
    hub.graph = graph2;
    getHubConfig(hub);
    trackHubNode(hub);
    const cfgN = getHubConfig(hub);
    const itemA = createNavItem(hub, getActiveTabId(cfgN), { graphUuid: null, pos: [5, 6] });
    const itemB = createNavItem(hub, getActiveTabId(cfgN), { graphUuid: null, pos: [7, 8] });
    syncHubNode(hub);
    await tick(40);

    const kdown2 = (init) => new dom.window.KeyboardEvent("keydown", init);
    const clickOn = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const openPop = (it) => {
        const row = layer2.querySelector(`[data-hub-item="${it.id}"]`);
        check("NK2 row rendered for " + it.id, !!row);
        clickOn(row.querySelector('[data-action="nav-zoom"]'));
        return document.querySelector(".hub-nav-pop");
    };
    const capOf = (pop) => pop.querySelector('[data-nav-btn="keycap"]');

    // 1) capture "2" on point A and APPLY it
    let pop = openPop(itemA);
    check("NK2 popover opened", !!pop);
    const capA = capOf(pop);
    check("NK2 cap shows not set", capA.textContent === "not set", capA.textContent);
    clickOn(capA);
    check("NK2 cap arms capture", capA.textContent === "press keys…", capA.textContent);
    // the keydown fires on the FOCUSED cap button and bubbles through window
    capA.dispatchEvent(kdown2({ key: "2", code: "Digit2", bubbles: true, cancelable: true }));
    check("NK2 cap painted the combo", capA.textContent === "2", capA.textContent);
    clickOn(pop.querySelector('[data-nav-btn="apply"]'));
    check("NK2 assignment committed", itemA.nav?.hotkey === "2", JSON.stringify(itemA.nav?.hotkey));
    check("NK2 popup closed on apply", !document.querySelector(".hub-nav-pop"));
    const chip = layer2.querySelector(`[data-hub-item="${itemA.id}"] .hub-nav-key`);
    check("NK2 row chip appeared", !!chip && chip.textContent.includes("2"), chip?.textContent ?? "none");

    // 2) duplicate refusal: capturing the SAME combo for point B keeps B null
    pop = openPop(itemB);
    const capB = capOf(pop);
    clickOn(capB);
    capB.dispatchEvent(kdown2({ key: "2", code: "Digit2", bubbles: true, cancelable: true }));
    check("NK2 duplicate capture painted", capB.textContent === "2", capB.textContent);
    clickOn(pop.querySelector('[data-nav-btn="apply"]'));
    check("NK2 duplicate refused", itemB.nav?.hotkey == null, JSON.stringify(itemB.nav?.hotkey));
    check("NK2 popup STAYS open on refusal", !!document.querySelector(".hub-nav-pop"));
    check("NK2 cap flagged bad", capB.classList.contains("hub-pop-bad"));
    clickOn(pop.querySelector('[data-nav-btn="close"]'));

    // 3) Esc cancels the CAPTURE, not the popup; popup Esc still closes
    pop = openPop(itemB);
    const capB2 = capOf(pop);
    clickOn(capB2);
    check("NK2 recapture armed", capB2.textContent === "press keys…", capB2.textContent);
    capB2.dispatchEvent(kdown2({ key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    check("NK2 Esc ended capture session", capB2.textContent !== "press keys…", capB2.textContent);
    check("NK2 popup survived capture-Esc", !!document.querySelector(".hub-nav-pop"));
    clickOn(pop.querySelector('[data-nav-btn="close"]'));

    // 4) modifier-only press keeps waiting (session must stay armed, cap still waiting)
    pop = openPop(itemB);
    const capB3 = capOf(pop);
    clickOn(capB3);
    capB3.dispatchEvent(kdown2({ key: "Shift", code: "ShiftLeft", bubbles: true, cancelable: true }));
    check("NK2 modifier-only keeps waiting", capB3.textContent === "press keys…", capB3.textContent);
    // then the real key lands
    capB3.dispatchEvent(kdown2({ key: "g", code: "KeyG", ctrlKey: true, bubbles: true, cancelable: true }));
    check("NK2 combo after modifier", capB3.textContent === "Ctrl+G", capB3.textContent);
    clickOn(pop.querySelector('[data-nav-btn="apply"]'));
    check("NK2 Ctrl+G committed", itemB.nav?.hotkey === "Ctrl+G", JSON.stringify(itemB.nav?.hotkey));

    // 5) the committed combo actually JUMPS (engine + UI integration)
    appStub.canvas.ds.offset = [100, 100];
    const evJump = kdown2({ key: "2", code: "Digit2", bubbles: true, cancelable: true });
    document.body.dispatchEvent(evJump);
    await tick(120);
    check("NK2 engine jumped via captured combo",
        approx2(appStub.canvas.ds.convertCanvasToOffset(ANCHOR), [5, 6]),
        JSON.stringify(appStub.canvas.ds.convertCanvasToOffset(ANCHOR)));

    // 6) v69: a fresh point added via the REAL ＋🧭 aim flow captures the
    //    current canvas zoom, and the popover lands with "custom zoom" ON
    appStub.canvas.ds.scale = 0.5;
    const addBtn = layer2.querySelector('[data-action="add-navpoint"]');
    check("NK2 add button present", !!addBtn);
    clickOn(addBtn);                       // arms the aim mode
    check("NK2 aim armed by add button", isAiming());
    appStub.canvas.canvas.dispatchEvent(new dom.window.MouseEvent("pointerdown",
        { bubbles: true, button: 0, clientX: 200, clientY: 120 }));
    await tick(60);
    const cfgItems = getHubConfig(hub).items.filter(isNavItem);
    const itemC = cfgItems[cfgItems.length - 1];
    check("NK2 aim point created", isNavItem(itemC));
    check("NK2 v69 zoom captured on aim add", itemC.nav.zoom === 0.5,
        JSON.stringify(itemC.nav?.zoom));
    const popC = openPop(itemC);
    check("NK2 popover for new point", !!popC);
    const cbC = popC.querySelector('[data-nav-role="usezoom"]');
    const ziC = popC.querySelector('[data-nav-field="zoom"]');
    check("NK2 v69 custom zoom ON by default", !!cbC && cbC.checked === true);
    check("NK2 v69 zoom field prefilled", !!ziC && ziC.value === "0.5", ziC?.value);
    clickOn(popC.querySelector('[data-nav-btn="close"]'));

    // 7) createNavItem WITHOUT patch.zoom stays zoom-null (deterministic;
    //    programs / tests that do not want a zoom keep the old behavior)
    const itemD = createNavItem(hub, getActiveTabId(cfgN), { graphUuid: null, pos: [1, 1] });
    check("NK2 no-patch create stays zoom-null", itemD.nav.zoom === null, JSON.stringify(itemD.nav.zoom));

    resetHubs();
    layer2.remove();
}

// ============================================================================
// NM - v74: the eye (hideChrome) hides the NAV AUTHORING buttons too.
// Owner report 2026-11-08 (AGENTS.md 5.1): "заменить точку навигацию" (📍,
// .hub-nav-move) and "добавить новую" (＋🧭, .hub-add-nav) stayed visible
// after hiding the chrome. The v74 fix adds both selectors to the
// .settings-hub.hub-chrome-hidden block in styles.css. jsdom cannot compute
// the cascade, but it CAN match selectors - so this phase proves the REAL
// contract: after clicking the eye, both buttons live INSIDE the
// .settings-hub.hub-chrome-hidden subtree, which is exactly what the real
// browser's descendant selector requires to display:none them.
// ============================================================================

phase("NM v74 eye — chrome-hidden covers .hub-add-nav / .hub-nav-move");
{
    const { syncHubNode } = await import(path.join(SANDBOX, "Hub", "web", "hub_ui_renderer.js"));

    class EyeHubNode {
        constructor() {
            this.type = "SettingsHub";
            this.title = "Eye Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph) layerEye.appendChild(element);
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }
    const layerEye = document.createElement("div");
    document.body.appendChild(layerEye);
    const graphEye = makeGraph("nm-root", []);
    appStub.graph = graphEye;
    appStub.canvas = makeCanvasStub();
    appStub.canvas.graph = graphEye;

    const hub = new EyeHubNode();
    graphEye._nodes.push(hub);
    hub.graph = graphEye;
    const cfgE = getHubConfig(hub);
    trackHubNode(hub);
    createNavItem(hub, getActiveTabId(cfgE), { graphUuid: null, pos: [5, 6] });
    syncHubNode(hub);
    await tick(40);

    const root = layerEye.querySelector(".settings-hub");
    const clickOn = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    check("NM: hub UI built with a nav row and the toolbar",
        !!root && !!root.querySelector(".hub-nav-row") && !!root.querySelector(".hub-add-nav"));
    check("NM: chrome visible by default (no hub-chrome-hidden)",
        !root.classList.contains("hub-chrome-hidden"));

    // click the eye -> cfg.hideChrome flips and the render re-applies the class
    clickOn(root.querySelector('[data-action="chrome-toggle"]'));
    await tick(40);
    const root2 = layerEye.querySelector(".settings-hub");
    check("NM: the eye toggled hub-chrome-hidden on the hub root",
        root2.classList.contains("hub-chrome-hidden"));
    check("NM: the config keeps the state", getHubConfig(hub).hideChrome === true);

    // THE FIX PROOF: both buttons sit inside the classed root -> the real
    // stylesheet rule (display:none !important) matches them in the browser.
    const addNav = root2.querySelector(".hub-add-nav");
    const navMove = root2.querySelector(".hub-nav-move");
    check("NM: ➕🧭 (add nav point) is inside the hidden chrome -> it hides",
        !!addNav && addNav.closest(".settings-hub.hub-chrome-hidden") === root2);
    check("NM: 📍 (re-place point) is inside the hidden chrome -> it hides",
        !!navMove && navMove.closest(".settings-hub.hub-chrome-hidden") === root2);
    check("NM: nav rows (jump chips) stay - they are VALUE, not chrome",
        !!root2.querySelector(".hub-nav-jump") &&
        root2.querySelector(".hub-nav-jump").closest(".settings-hub.hub-chrome-hidden") === root2);

    // the eye itself must never join the hide list - it is the way back
    const cssSrc = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8");
    const blockStart = cssSrc.indexOf("hub-chrome-hidden .hub-drag-handle");
    const blockEnd = cssSrc.indexOf(".hub-searching .hub-drag-handle");
    const chromeBlock = cssSrc.slice(blockStart, blockEnd);
    check("NM: the hide list covers both nav authoring buttons",
        chromeBlock.includes(".hub-add-nav") && chromeBlock.includes(".hub-nav-move"));
    check("NM: the eye itself is NOT in the hide list (the way back)",
        !chromeBlock.includes("hub-chrome-toggle"));

    // second click restores the editing chrome
    clickOn(root2.querySelector('[data-action="chrome-toggle"]'));
    await tick(40);
    check("NM: the second click restores the chrome",
        !layerEye.querySelector(".settings-hub").classList.contains("hub-chrome-hidden") &&
        getHubConfig(hub).hideChrome === false);

    resetHubs();
    layerEye.remove();
    appStub.canvas = null;
    appStub.graph = null;
}

// ============================================================================
// NL - v72: the Paste Stack bridge writes into a REAL hub text mirror
// (the renderer's insertTextIntoLastFocused is the "→ в строку" path of the
// clipboard stack: last focused .hub-text-input/.hub-text-area -> target
// widget through pushControlToTarget, the SAME MirrorSync route as typing).
// ============================================================================

phase("NL v72 stack bridge inserts into the last focused text mirror");
{
    const { syncHubNode } = await import(path.join(SANDBOX, "Hub", "web", "hub_ui_renderer.js"));
    const { stackBridge } = await import(path.join(SANDBOX, "Hub", "web", "sync.js"));

    class BridgeHubNode {
        constructor() {
            this.type = "SettingsHub";
            this.title = "Bridge Hub";
            this.properties = {};
            this.widgets = [];
            this.size = [340, 200];
            this.flags = {};
            this.graph = null;
        }
        addDOMWidget(name, type, element, options) {
            const widget = { name, type, element, options: options ?? {}, y: 0,
                serialize: false, onRemove: null, releaseRegisteredState: null };
            this.widgets.push(widget);
            if (this.graph) layer3.appendChild(element);
            return widget;
        }
        setSize(s) { this.size = [s[0], s[1]]; }
        setDirtyCanvas() {}
    }
    const layer3 = document.createElement("div");
    document.body.appendChild(layer3);
    const graph3 = makeGraph("nl-root", []);
    appStub.graph = graph3;
    appStub.canvas = makeCanvasStub();
    appStub.canvas.graph = graph3;

    // the target widget lives on its own node (a customtext prompt mirror)
    const target = {
        id: "nl-target-1",
        title: "Prompt Node",
        widgets: [{ name: "prompt", type: "customtext", value: "old value" }],
    };
    graph3._nodes.push(target);

    const hubB = new BridgeHubNode();
    graph3._nodes.push(hubB);
    hubB.graph = graph3;
    const cfgB = getHubConfig(hubB);
    trackHubNode(hubB);
    cfgB.items.push({
        id: "nl-item-1",
        type: "widget_binding",
        widgetType: "text",
        widgetToBind: "prompt",
        widgetOrd: 0,
        targetNodeId: "nl-target-1",
        tabId: getActiveTabId(cfgB),
    });
    syncHubNode(hubB);
    await tick(40);

    const control = layer3.querySelector('[data-hub-item="nl-item-1"] .hub-text-input, ' +
        '[data-hub-item="nl-item-1"] .hub-text-area');
    check("NL: the text mirror rendered", !!control, String(!!control));

    // 1) nothing focused yet -> the insert refuses
    check("NL: no focus -> insert returns false", stackBridge().insertTextIntoLastFocused("x") === false);

    // 2) the user focuses the mirror (focusin) -> the bridge tracks it
    control.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    const info = stackBridge().focusedTextInfo();
    check("NL: focusedTextInfo names the row", !!info, JSON.stringify(info));

    // 3) the stack writes the snippet -> target widget + DOM update
    const okIns = stackBridge().insertTextIntoLastFocused("from the paste stack");
    check("NL: insert accepted", okIns === true);
    check("NL: the TARGET widget value changed (MirrorSync path)",
        target.widgets[0].value === "from the paste stack", JSON.stringify(target.widgets[0].value));
    check("NL: the control shows the new value", control.value === "from the paste stack", control.value);

    // 4) insertTextIntoEl writes into a SPECIFIC mirror
    const okEl = stackBridge().insertTextIntoEl(control, "dropped straight on");
    check("NL: insertTextIntoEl accepted", okEl === true);
    check("NL: the specific mirror got the text", target.widgets[0].value === "dropped straight on");

    // 5) a non-mirror element is refused
    check("NL: foreign element refused", stackBridge().insertTextIntoEl(layer3, "x") === false);

    resetHubs();
    layer3.remove();
}

// ============================================================================

console.log(`\nsmoke_nav: ${pass} passed, ${fail} failed`);
if (fail) {
    console.error("FAILED phases:\n  " + failures.join("\n  "));
    process.exitCode = 1;
}
// The nav_points retry poll keeps the event loop alive up to 60s - exit hard.
process.exit(process.exitCode ?? 0);
