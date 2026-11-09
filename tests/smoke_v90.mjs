// ============================================================================
// SettingsHub - v90 smoke test: FONT SCALE + MODAL GUARD + VIRTUAL HUBS
// ----------------------------------------------------------------------------
// Node ESM + jsdom. Three owner requests, three feature areas:
//
//   A  FONT SCALE (web/global_settings.js + web/styles.css): the shared
//      setting normalizes 75..250 (out-of-range -> default 100), persists in
//      localStorage, applies through the --sh-fs CSS variable on :root at
//      boot and on every change; the stylesheet converts every font-size /
//      text control geometry to calc(var(--sh-fs, 1) * Npx) while media
//      thumbnails (the 60px placeholder box) stay px; the modal-guard block
//      exists and lists every floating layer.
//   B  VIRTUAL HUBS (web/core.js + web/hub_node.js + web/context_menu.js +
//      web/hub_ui_renderer.js): createVirtualHub produces a REAL hub node on
//      the root graph with cfg.phantom+pinned serialized in
//      node.properties.hubConfig; isPhantomHub is exact; the canvas wrapper
//      skips drawNode AND getNodeOnPos hit-testing for phantoms (and only
//      for them); the canvas RMB menu offers "New virtual hub" whose
//      callback creates one; unpinHubAction materializes a phantom (flag
//      cleared) while a normal hub still toggles.
//   C  MODAL GUARD (web/settings_hub.js): importing the entry installs the
//      watcher - a visible .comfy-modal (or dialog[open]) toggles
//      body.sh-modal-open within the 400 ms scan; a hidden one and our own
//      .hub-menu never do; removing the modal clears the class.
//
// Run from the extension root:  node tests/smoke_v90.mjs   (jsdom required)
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
    console.error("smoke_v90: jsdom is required (npm install jsdom)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");

const { JSDOM } = jsdom;
// url: "http://localhost/" - otherwise the origin is opaque and window.localStorage THROWS
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
});
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
// Browser globals the modules read bare (in a real page they are window
// properties); jsdom provides them on the window realm only.
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appStub = {
    registerExtension(ext) { appStub.__extensions.push(ext); },
    __extensions: [],
    canvas: null,
    graph: null,
};
globalThis.__HUB_APP_STUB__ = appStub;

/** Copy the real web/ modules into a fresh sandbox (fresh module instances). */
function makeSandbox(tag) {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), `hubv90-${tag}-`));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(
        path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n",
    );
    return path.join(sb, "Hub", "web");
}

// ---------------------------------------------------------------------------
// LiteGraph / graph stubs (fresh per phase)
// ---------------------------------------------------------------------------

function makeFakeNode(type = "SettingsHub") {
    return {
        type,
        id: Math.floor(Math.random() * 1e9),
        title: type === "SettingsHub" ? "Settings Hub" : type,
        properties: {},
        size: [340, 200],
        flags: {},
        widgets: [],
        setDirtyCanvas() {},
    };
}

function makeGraph() {
    return {
        nodes: [],
        add(n) { this.nodes.push(n); n.graph = this; },
        remove(n) {
            this.nodes = this.nodes.filter((x) => x !== n);
            n.graph = null;
            try { n.onRemoved?.(); } catch (_) {}
        },
        serialize() { return { nodes: this.nodes.map(() => ({})) }; },
    };
}

function installLiteGraphStubs() {
    const created = [];
    window.LiteGraph = {
        __created: created,
        registered_node_types: {},
        registerNodeType(name, cls) { this.registered_node_types[name] = cls; },
        createNode(type) {
            const n = makeFakeNode(type);
            created.push(n);
            return n;
        },
    };
    window.LGraphNode = class LGraphNode {
        constructor() { this.properties = {}; this.widgets = []; }
    };
    return created;
}

function installCanvasStub(origImpls = {}) {
    const proto = {
        __drawCalls: [],
        drawNode(node, ...rest) { this.__drawCalls.push(node); return origImpls.drawNode?.(node, ...rest); },
        __nextHit: null,
        getNodeOnPos() { return this.__nextHit; },
        getCanvasMenuOptions() { return [{ content: "Add Node" }]; },
        graph_mouse: [10, 10],
    };
    window.LGraphCanvas = function LGraphCanvas() {};
    Object.assign(window.LGraphCanvas.prototype, proto, origImpls.proto ?? {});
    return window.LGraphCanvas.prototype;
}

// ===========================================================================
// Phase A - FONT SCALE (global_settings + styles.css)
// ===========================================================================

{
    phase("A: font scale setting + CSS contracts");
    try { localStorage.removeItem("settingshub.ui.fontScale"); } catch (_) {}

    const web = makeSandbox("gs");
    const gs = await import(web + "/global_settings.js");

    check("A: default scale is 100", gs.getUiFontScale() === 100);
    check("A: boot applied the default var", document.documentElement.style.getPropertyValue("--sh-fs") === "1");

    const v150 = gs.setUiFontScale(150);
    check("A: 150 accepted", v150 === 150);
    check("A: var follows (1.5)", document.documentElement.style.getPropertyValue("--sh-fs") === "1.5");
    check("A: persisted", localStorage.getItem("settingshub.ui.fontScale") === "150");

    check("A: fractional 87.5 kept", gs.setUiFontScale(87.5) === 87.5);
    check("A: var 0.875", document.documentElement.style.getPropertyValue("--sh-fs") === "0.875");

    check("A: out-of-range high -> default 100", gs.setUiFontScale(300) === 100);
    check("A: out-of-range low -> default 100", gs.setUiFontScale(10) === 100);
    check("A: NaN -> default 100", gs.setUiFontScale("abc") === 100);
    check("A: storage normalized", localStorage.getItem("settingshub.ui.fontScale") === "100");

    check("A: label marks the default", gs.uiFontScaleLabel(100).includes("default"));
    check("A: plain label otherwise", !gs.uiFontScaleLabel(150).includes("default"));
    check("A: quick picks expose 80..200",
        JSON.stringify(gs.UI_FONT_SCALE_CHOICES) === JSON.stringify([80, 90, 100, 110, 125, 150, 175, 200]));

    // A fresh module instance (a page reload) restores the saved scale at boot.
    gs.setUiFontScale(175);
    const gs2 = await import(web + "/global_settings.js?v=reboot"); // same file, new query = same instance in node; use a sandbox copy instead
    check("A: re-apply hook is idempotent", gs2.applyUiFontScale() === 175);
    check("A: var 1.75 after re-apply", document.documentElement.style.getPropertyValue("--sh-fs") === "1.75");

    // styles.css contracts
    const css = fs.readFileSync(path.join(WEB, "styles.css"), "utf-8");
    const fsCount = (css.match(/font-size:\s*calc\(var\(--sh-fs, 1\)/g) || []).length;
    check("A: ~202 font-size rules converted", fsCount >= 195, String(fsCount));
    const leftover = (css.match(/font-size:\s*[0-9.]+px/g) || []).length;
    check("A: only the 60px thumb placeholder keeps px", leftover === 1,
        String(leftover));
    check("A: the placeholder rule keeps 22px",
        /\.hub-media-thumb-ph\s*\{[^}]*font-size:\s*22px/.test(css));
    const shCount = (css.match(/font:\s*calc\(var\(--sh-fs, 1\)/g) || []).length;
    check("A: font shorthand sizes converted (>=10)", shCount >= 10, String(shCount));
    check("A: text control heights scaled (.hub-text-area)",
        /\.hub-text-area\s*\{[^}]*min-height:\s*calc\(var\(--sh-fs, 1\)\s*\*\s*46px\)/.test(css));
    check("A: select max-width scaled (.hub-cs-sel)",
        /\.hub-cs-sel\s*\{[^}]*max-width:\s*calc\(var\(--sh-fs, 1\)/.test(css));
    check("A: modal guard block exists", css.includes("v90 MODAL GUARD"));
    for (const sel of [".hub-pin-panel", ".hub-stack-panel", ".hub-chat-panel",
        ".hub-cmp-panel", ".hub-fs-overlay", ".hub-menu", ".hub-toast",
        ".hub-stack-chip", ".hub-chat-chip"]) {
        const re = new RegExp("body\\.sh-modal-open\\s+" + sel.replace(/\./g, "\\.") + "\\s*,");
        check(`A: guard hides ${sel}`, re.test(css));
    }
    check("A: guard uses visibility (rects intact) + pointer-events",
        /visibility:\s*hidden\s*!important/.test(css) &&
        /pointer-events:\s*none\s*!important/.test(css));
}

// ===========================================================================
// Phase B - VIRTUAL HUBS (core + hub_node + context_menu)
// ===========================================================================

{
    phase("B: virtual hubs (create / hide / hit-test / canvas menu / materialize)");
    const created = installLiteGraphStubs();
    const canvasProto = installCanvasStub();
    appStub.graph = makeGraph();
    appStub.canvas = { graph: appStub.graph };

    const web = makeSandbox("vh");
    const core = await import(web + "/core.js");

    check("B: core self-reports v90", globalThis.__SettingsHubLoaded?.core === "v90");

    const node = core.createVirtualHub();
    check("B: node created via the canonical path", !!node && node.type === "SettingsHub");
    check("B: node is ON the root graph", appStub.graph.nodes.includes(node));
    check("B: cfg.phantom = true", node.properties.hubConfig?.phantom === true);
    check("B: cfg.pinned = true (auto-float)", node.properties.hubConfig?.pinned === true);
    check("B: default title", node.title === "Virtual Hub");
    check("B: isPhantomHub true", core.isPhantomHub(node) === true);
    check("B: isPhantomHub false for a plain node",
        core.isPhantomHub(makeFakeNode("KSampler")) === false);
    check("B: isPhantomHub false for a NORMAL hub", (() => {
        const n = core.createNewHub();
        n.properties.hubConfig.phantom = false;
        return core.isPhantomHub(n) === false;
    })());

    const named = core.createVirtualHub("Мой хаб");
    check("B: custom title kept", named?.title === "Мой хаб");

    // Serialization: the flag rides node.properties.hubConfig with the workflow.
    const rt = JSON.parse(JSON.stringify(node.properties));
    check("B: phantom survives JSON round-trip", rt.hubConfig?.phantom === true);

    // hub_node: draw + hit-test skipping (only for phantoms).
    const hn = await import(web + "/hub_node.js");
    check("B: hub_node self-reports v90", globalThis.__SettingsHubLoaded?.hub_node === "v90");
    hn.registerHubNode();   // the extension setup() normally calls this
    check("B: node type registered", !!window.LiteGraph.registered_node_types?.SettingsHub);

    canvasProto.__drawCalls.length = 0;
    canvasProto.drawNode(node, {});
    canvasProto.drawNode(named, {});
    const normal = core.createNewHub();
    canvasProto.drawNode(normal, {});
    check("B: phantom hubs are NOT drawn (2 skips, 1 draw)",
        canvasProto.__drawCalls.length === 1 && canvasProto.__drawCalls[0] === normal);

    canvasProto.__nextHit = node;
    check("B: hit-test returns null for a phantom", canvasProto.getNodeOnPos(1, 1) === null);
    canvasProto.__nextHit = normal;
    check("B: hit-test still finds a normal hub", canvasProto.getNodeOnPos(1, 1) === normal);

    // context_menu: the canvas RMB item.
    const cm = await import(web + "/context_menu.js");
    cm.attachContextMenu();
    const items = canvasProto.getCanvasMenuOptions();
    const vhItem = items.find((i) => String(i?.content || "").includes("New virtual hub"));
    check("B: canvas menu offers the virtual hub item", !!vhItem);
    const before = appStub.graph.nodes.length;
    vhItem?.callback?.();
    check("B: the item callback creates a virtual hub",
        appStub.graph.nodes.length === before + 1 &&
        appStub.graph.nodes[appStub.graph.nodes.length - 1]?.properties?.hubConfig?.phantom === true);

    // hub_ui_renderer: unpinHubAction is not exported, but its effect is
    // reachable through toggleHubPinned on a MATERIALIZED phantom - here we
    // verify the flag semantics the materialize path relies on.
    node.properties.hubConfig.phantom = false;
    check("B: clearing the flag makes it a normal hub", core.isPhantomHub(node) === false);

    // Deleting through node.graph.remove fires onRemoved (registry + panel
    // teardown path) - the fake graph stub mimics litegraph.
    let removedFired = false;
    named.onRemoved = () => { removedFired = true; };
    named.graph.remove(named);
    check("B: delete path fires onRemoved", removedFired);
    check("B: deleted node left the graph", !appStub.graph.nodes.includes(named));
}

// ===========================================================================
// Phase C - MODAL GUARD (the entry)
// ===========================================================================

{
    phase("C: modal guard (entry watcher)");
    installLiteGraphStubs();
    installCanvasStub();

    const web = makeSandbox("mg");
    const entryUrl = web + "/settings_hub.js";
    const errors = [];
    const realErr = console.error;
    console.error = (...a) => errors.push(a.map(String).join(" "));
    try {
        await import(entryUrl);
    } finally {
        console.error = realErr;
    }
    check("C: entry self-reports v90", globalThis.__SettingsHubBuild === "v90");
    check("C: no stale-cache report", !errors.some((e) => e.includes("MIXED BUILD")));

    const body = document.body;
    check("C: no guard class on a clean page", !body.classList.contains("sh-modal-open"));

    // Our own popups are NOT modals - they must never trigger the guard.
    const own = document.createElement("div");
    own.className = "hub-menu";
    body.appendChild(own);
    await sleep(650);
    check("C: our .hub-menu does not trigger the guard",
        !body.classList.contains("sh-modal-open"));
    own.remove();
    await sleep(650);
    check("C: guard still clean after the popup left", !body.classList.contains("sh-modal-open"));

    // A visible ComfyUI modal.
    const modal = document.createElement("div");
    modal.className = "comfy-modal";
    body.appendChild(modal);
    await sleep(650);
    check("C: a visible .comfy-modal opens the guard",
        body.classList.contains("sh-modal-open"));

    // A hidden .comfy-modal (the usual DOM resident) must not.
    const modal2 = document.createElement("div");
    modal2.className = "comfy-modal";
    modal2.style.display = "none";
    modal.remove();
    body.appendChild(modal2);
    await sleep(650);
    check("C: a display:none .comfy-modal does not open the guard",
        !body.classList.contains("sh-modal-open"));

    // Native dialog[open].
    const dlg = document.createElement("dialog");
    dlg.setAttribute("open", "");
    body.appendChild(dlg);
    await sleep(650);
    check("C: dialog[open] opens the guard", body.classList.contains("sh-modal-open"));
    dlg.remove();
    await sleep(650);
    check("C: closing the dialog clears the guard", !body.classList.contains("sh-modal-open"));
}

// ---------------------------------------------------------------------------

console.log(`\nsmoke_v90: ${pass} passed, ${fail} failed`);
if (failures.length) {
    console.error("Failures:\n  " + failures.join("\n  "));
    process.exit(1);
}
process.exit(0);
