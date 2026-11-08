// ============================================================================
// SettingsHub - entry registration smoke test (v67)
// ----------------------------------------------------------------------------
// Node ESM + jsdom. Loads the REAL entry (web/settings_hub.js) exactly like
// ComfyUI does - through the v35 loader block with the v64 build-guard flags
// and the v66 fail-open registration - and asserts the context menus survive
// every degradation class. Field motivation (v66): the v64 gate could refuse
// to register ANYTHING when the browser served one stale cached module, and
// the user's only symptom was "the Pin to Settings Hub items disappeared".
//
//   MA  clean build: every module self-reports -> the "Comfy.SettingsHub.
//       context" extension is registered, getNodeMenuItems offers the batch
//       picker and the widget pin for a regular node, [] for the hub node,
//       the sync hooks extension is registered, NO console.error, NO banner.
//   MB  stale cache: one module (sync.js) serves WITHOUT the self-report
//       line (a browser-served old file) -> the entry MUST still register
//       menus + hooks (fail-open), MUST name sync.js in console.error and
//       MUST show the visible degradation banner.
//   MC  broken module: nav_points.js throws at import (the cascade takes
//       hub_ui_renderer / sync_manager / hub_node with it) -> menus STILL
//       register and build items, sync hooks are loudly declared dead, the
//       banner names the failed file.
//
// Run from the extension root:  node tests/smoke_menu.mjs   (jsdom required)
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
    console.error("smoke_menu: jsdom is required (npm install jsdom)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");

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

// ---------------------------------------------------------------------------
// app stub (shared; per-phase state is reset between loads)
// ---------------------------------------------------------------------------

const appStub = {
    registerExtension(ext) { appStub.__extensions.push(ext); },
    __extensions: [],
    canvas: null,
    graph: null,
};
globalThis.__HUB_APP_STUB__ = appStub;

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

/** Copy the real web/ modules into a fresh sandbox (fresh URLs -> fresh
 *  module instances, exactly what a browser page-load produces). */
function makeSandbox(tag) {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), `hubmenu-${tag}-`));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(
        path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n",
    );
    return path.join(sb, "Hub", "web", "settings_hub.js");
}

/** Capture console.error/info around an async import (modules log at
 *  module-evaluation time, so the capture must span the import call). */
async function importCaptured(entryUrl) {
    const errors = [];
    const infos = [];
    const realErr = console.error, realInfo = console.info;
    console.error = (...a) => errors.push(a.map(String).join(" "));
    console.info = (...a) => infos.push(a.map(String).join(" "));
    try {
        const mod = await import(entryUrl);
        return { mod, errors, infos };
    } finally {
        console.error = realErr;
        console.info = realInfo;
    }
}

function resetPhaseState() {
    appStub.__extensions.length = 0;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
}

const extByName = (name) => appStub.__extensions.find((e) => e?.name === name) ?? null;

/** A regular canvas node the way litegraph presents it to menu hooks. */
function makeStubNode() {
    const comboW = { name: "ckpt_name", type: "COMBO", value: "a", options: { values: ["a", "b"] } };
    const numW = { name: "steps", type: "number", value: 20 };
    const btnW = { name: "apply", type: "button", value: null, callback: () => {} };
    const node = {
        type: "KSampler", title: "KSampler", mode: 0,
        widgets: [comboW, numW, btnW],
        getWidgetOnPos: () => comboW,
    };
    return node;
}

// ============================================================================
// MA — clean build: the entry must register menus + hooks, no errors
// ============================================================================

phase("MA clean build — entry registers menus, items are offered");
{
    resetPhaseState();
    const entry = makeSandbox("clean");
    const { errors } = await importCaptured(entry);

    check("MA: clean build logs no console.error", errors.length === 0,
        errors.join(" | "));

    const ctx = extByName("Comfy.SettingsHub.context");
    check("MA: Comfy.SettingsHub.context registered", !!ctx);
    check("MA: context extension exposes getNodeMenuItems",
        typeof ctx?.getNodeMenuItems === "function");

    const hooks = extByName("Comfy.SettingsHub.hooks");
    check("MA: Comfy.SettingsHub.hooks registered (reactive sync)", !!hooks);
    check("MA: hooks extension wires setup + afterConfigureGraph",
        typeof hooks?.setup === "function" && typeof hooks?.afterConfigureGraph === "function");

    const items = ctx?.getNodeMenuItems?.(makeStubNode()) ?? null;
    check("MA: menu hook returns an array for a regular node", Array.isArray(items));
    check("MA: batch picker entry is offered",
        items.some((i) => String(i?.content || "").includes("Add widgets to hub (batch)")));
    check("MA: widget pin entry is offered",
        items.some((i) => String(i?.content || "").includes("Pin to Settings Hub")));

    const hubItems = ctx?.getNodeMenuItems?.({ type: "SettingsHub", widgets: [] }) ?? null;
    check("MA: hub node gets an empty item list (no self-pinning)", Array.isArray(hubItems) && hubItems.length === 0);

    check("MA: no degradation banner on a clean build",
        !document.querySelector("div[style*='z-index: 999999']") &&
        ![...document.body.children].some((el) => String(el.textContent || "").includes("build degraded")));
}

// ============================================================================
// MB — stale cache: one module serves without the self-report line
// ============================================================================

phase("MB stale cache — fail-open registration + named files + visible banner");
{
    resetPhaseState();
    const entry = makeSandbox("stale");
    const sbRoot = path.dirname(entry);
    // Simulate a browser-served OLD sync.js: same code semantics, but no
    // self-report line (the file the detector is designed to catch). v82:
    // the self-report carries the last-functional-change version string.
    const syncPath = path.join(sbRoot, "sync.js");
    const syncSrc = fs.readFileSync(syncPath, "utf8");
    const stripped = syncSrc.replace(
        /^\s*globalThis\.__SettingsHubLoaded\["sync"\] = "v\d+";\s*$/m,
        "/* stale cached copy: no self-report */",
    );
    check("MB: fixture - self-report line found and removed in sync.js",
        stripped !== syncSrc);
    fs.writeFileSync(syncPath, stripped);

    const { errors } = await importCaptured(entry);

    check("MB: MIXED BUILD named in console.error",
        errors.some((e) => e.includes("MIXED BUILD") && e.includes("sync.js")));
    check("MB: error text demands a hard refresh",
        errors.some((e) => e.includes("HARD REFRESH") || e.includes("Ctrl+F5")));

    const ctx = extByName("Comfy.SettingsHub.context");
    check("MB: FAIL-OPEN - context extension still registered", !!ctx);
    const items = ctx?.getNodeMenuItems?.(makeStubNode()) ?? [];
    check("MB: pin menus still offered despite the stale file",
        Array.isArray(items) && items.some((i) => String(i?.content || "").includes("Add widgets to hub (batch)")));

    const hooks = extByName("Comfy.SettingsHub.hooks");
    check("MB: sync hooks still registered (fail-open)", !!hooks);

    const banner = [...document.body.children]
        .find((el) => String(el.textContent || "").includes("build degraded"));
    check("MB: visible degradation banner shown", !!banner);
    check("MB: banner names the stale file",
        !!banner && banner.textContent.includes("stale cached: sync.js") &&
        banner.textContent.includes("Ctrl+F5"));
}

// ============================================================================
// MC — broken module: nav_points.js throws (cascade kills hub_ui_renderer,
// sync_manager, hub_node) — menus must survive
// ============================================================================

phase("MC broken module — menus survive a cascading import failure");
{
    resetPhaseState();
    const entry = makeSandbox("broken");
    const sbRoot = path.dirname(entry);
    fs.writeFileSync(path.join(sbRoot, "nav_points.js"),
        'throw new Error("boom - simulated broken nav_points.js");\n');

    const { errors } = await importCaptured(entry);

    check("MC: FAILED-to-load named nav_points.js",
        errors.some((e) => e.includes("FAILED to load ./nav_points.js")));
    check("MC: sync hooks declared unavailable (not silently dropped)",
        errors.some((e) => e.includes("sync_manager.js unavailable") && e.includes("reactive sync")));

    const ctx = extByName("Comfy.SettingsHub.context");
    check("MC: FAIL-OPEN - context extension registered despite the cascade", !!ctx);
    const items = ctx?.getNodeMenuItems?.(makeStubNode()) ?? [];
    check("MC: pin menus still offered",
        Array.isArray(items) && items.some((i) => String(i?.content || "").includes("Add widgets to hub (batch)")));

    check("MC: hooks extension NOT registered when sync_manager is dead",
        !extByName("Comfy.SettingsHub.hooks"));

    const banner = [...document.body.children]
        .find((el) => String(el.textContent || "").includes("build degraded"));
    check("MC: banner names the failed file", !!banner &&
        banner.textContent.includes("failed to load: nav_points.js"));
}

// ---------------------------------------------------------------------------

console.log(`\nsmoke_menu: ${pass} passed, ${fail} failed`);
if (failures.length) {
    console.error("Failures:\n  " + failures.join("\n  "));
    process.exit(1);
}
process.exit(0);
