// ============================================================================
// SettingsHub - nav points smoke test (v61)
// ----------------------------------------------------------------------------
// Node ESM + jsdom, mirrors the smoke_hub.mjs philosophy: the REAL web/*.js
// files are copied into a sandbox with a stubbed scripts/app.js, imported
// and asserted. Covers the nav-point ENGINE (renderer DOM phases stay in the
// external harness):
//
//   NA  config: normalize + JSON round-trip + label defaults
//   NB  resolver: nested subgraphs by uuid (holders chains, Map / object
//       registries, orphan, root), activeGraphContext
//   NC  camera: delta-centering under BOTH offset conventions, zoom null /
//       number / clamp, converter-less fallback formula, screenToWorld
//   ND  jump: enter + center, zoom semantics, orphan degradation, race guard
//   NE  entry ladder: direct setter / gesture replay / full degradation
//       (the old copy died here on a ReferenceError - regression guard)
//   NF  aim mode: canvas pick, outside/Esc/RMB cancel, world coords
//   NG  canvas hooks: painter + RMB menu wrapper + point creation via menu
//   NH  marker drag: pointer interception moves item.nav.pos
//   NI  presets: nav items never enter preset captures
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

// ---------------------------------------------------------------------------
// Module imports (sandboxed copies)
// ---------------------------------------------------------------------------

const { getHubConfig, getActiveTabId, trackHubNode, forgetHubNode } = await import(path.join(SANDBOX, "Hub", "web", "core.js"));
const {
    NAV_TYPE, isNavItem, normalizeNav, createNavItem, getNavItems,
    resolveNavTarget, activeGraphContext, screenToWorld, setActiveViewCenter,
    enterOwnerGraph, navJump, armAim, cancelAim, isAiming, markersVersionBump,
    installNavCanvasHooks, setNavUiHooks,
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

phase("NC camera (delta centering, zoom semantics, fallback)");
for (const convention of ["A", "B"]) {
    const c = makeCanvasStub({ convention });
    appStub.canvas = c;

    // zoom null -> ds.scale untouched, point centered
    c.ds.scale = 1.3;
    setActiveViewCenter([100, -50], null);
    check(`NC[${convention}] null zoom keeps scale`, c.ds.scale === 1.3);
    check(`NC[${convention}] centered`,
        approx2(c.ds.convertCanvasToOffset([400, 300]), [100, -50]),
        JSON.stringify(c.ds.convertCanvasToOffset([400, 300])));

    // numeric zoom applied BEFORE centering
    setActiveViewCenter([40, 60], 0.5);
    check(`NC[${convention}] zoom applied`, c.ds.scale === 0.5);
    check(`NC[${convention}] centered after zoom`,
        approx2(c.ds.convertCanvasToOffset([400, 300]), [40, 60]));

    // clamp to ds limits
    setActiveViewCenter([0, 0], 5);
    check(`NC[${convention}] clamp max`, c.ds.scale === 2);
    setActiveViewCenter([0, 0], 0.001);
    check(`NC[${convention}] clamp min`, c.ds.scale === 0.1);
}
{
    // Converter-less fallback: project formula offset = p - S/scale
    const c = makeCanvasStub();
    delete c.ds.convertCanvasToOffset;
    delete c.ds.convertOffsetToCanvas;
    appStub.canvas = c;
    c.ds.scale = 2;
    setActiveViewCenter([10, 20], null);
    const cx = 400, cy = 300;   // screen center in CSS px (rect 800x600)
    check("NC fallback offset", approx2(c.ds.offset, [10 - cx / 2, 20 - cy / 2]),
        JSON.stringify(c.ds.offset));
    // round trip through the fallback relation: world = screen/s + offset
    check("NC fallback center", approx2([cx / 2 + c.ds.offset[0], cy / 2 + c.ds.offset[1]], [10, 20]));
}
{
    // screenToWorld via converters + fallback
    const c = makeCanvasStub();
    appStub.canvas = c;
    setActiveViewCenter([100, -50], null);
    check("NC screenToWorld center", approx2(screenToWorld(400, 300), [100, -50]));
    check("NC screenToWorld corner", approx2(screenToWorld(0, 0), [100 - 400, -50 - 300]));
    delete c.ds.convertCanvasToOffset;
    c.ds.offset = [7, 8]; c.ds.scale = 2;
    check("NC screenToWorld fallback", approx2(screenToWorld(10, 10), [10 / 2 + 7, 10 / 2 + 8]));
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
    check("ND centered", approx2(c.ds.convertCanvasToOffset([400, 300]), [5, 7]));
    check("ND null zoom keeps scale", c.ds.scale === 0.7);

    // numeric zoom
    pB.nav.zoom = 0.5;
    await navJump(pB);
    check("ND zoom applied", c.ds.scale === 0.5);
    check("ND centered after zoom", approx2(c.ds.convertCanvasToOffset([400, 300]), [5, 7]));

    // jump to root exits the subgraph
    const pRoot = createNavItem(hub, getActiveTabId(cfg), { graphUuid: null, pos: [-9, 3] });
    await navJump(pRoot);
    check("ND exit to root", c.graph === root);
    check("ND root centered", approx2(c.ds.convertCanvasToOffset([400, 300]), [-9, 3]));

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
    check("ND race winner is fresher", approx2(c.ds.convertCanvasToOffset([400, 300]), [22, 0]),
        JSON.stringify(c.ds.convertCanvasToOffset([400, 300])));
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
    items[0].callback();
    const cfg = getHubConfig(hub);
    const navs = cfg.items.filter(isNavItem);
    check("NG point created", navs.length === 1, String(navs.length));
    check("NG point pos from graph_mouse", navs.length === 1 && approx2(navs[0].nav.pos, [33, 44]));
    check("NG point graph from active canvas", navs.length === 1 && navs[0].nav.graphUuid === "uuid-A");
    check("NG point graphName path", navs.length === 1 && String(navs[0].nav.graphName).includes("Sub A"));

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

console.log(`\nsmoke_nav: ${pass} passed, ${fail} failed`);
if (fail) {
    console.error("FAILED phases:\n  " + failures.join("\n  "));
    process.exitCode = 1;
}
// The nav_points retry poll keeps the event loop alive up to 60s - exit hard.
process.exit(process.exitCode ?? 0);
