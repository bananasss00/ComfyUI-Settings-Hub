// ============================================================================
// SettingsHub - WORKFLOWS MANAGER smoke test (v102)
// ----------------------------------------------------------------------------
// Node ESM + jsdom. Loads the REAL web/workflows.js module exactly like the
// entry does (a sandbox copies web/ and stubs ../../scripts/app.js with an
// in-memory ComfyUI: the extensionManager.workflow store, the native
// /userdata endpoint, loadGraphData), then drives the panel through its REAL
// UI paths.
//
//   WA  mount: the FIRST RUN starts MINIMIZED (the plan contract: the panel
//       waits in the taskbar), the chip shows, the taskbar carries the 4th
//       item with the open-count badge (+ the unsaved dot), the taskbar
//       click restores, [–] collapses back INTO the bar.
//   WB  the Open tab: indicators (● active / * modified / temp / (empty) /
//       📌 lock), Close saved protects modified + temp + locked (+ the empty
//       0-node temp goes when the preference allows), Close other saved
//       keeps the active tab even when clean, Save all modified.
//   WC  the save form: persisted rows checked by default, temp rows opt IN
//       as SNAPSHOTS, the activePath radio, Save new POSTs a full preset,
//       Update (↻) offers Overwrite / Merge. v102: a temp tab WITHOUT a
//       changeTracker (never activated, content-string only) is snapshotable.
//   WD  the apply plan (▶ Switch): the smart diff - a tab whose file is
//       already open is NEITHER closed NOR reloaded; keep-unsaved protects
//       the modified tab; the plan popover shows close/stay/open; Apply
//       executes open→close→activate; the ↩ Undo toast restores the previous
//       set (reopens the retired tab, retires what the apply brought in).
//   WE  Files & Recent: the recently-closed buffer reopens a tab, the
//       multi-word search filters the saved files, Open selected / Save
//       selected as preset (the name prompt).
//   WF  the ⚙ popup: the STORAGE FOLDER switch (Enter applies -> POST
//       /workflows/root -> presets re-read; [default] resets), the Behavior
//       checkboxes persist, Panel Off tears the panel down, On re-mounts.
//   WG  degraded: a 404 health names the "old py" problem in the note.
//   WH  entry integration (source contract): FILES + EXPECTED + the
//       initWorkflows registration block + the v102 stamps.
//   WI  v102 fixes: the activation swaps the CANVAS (loadGraphData carries
//       the workflow object; store.openWorkflow is NOT the activation rung),
//       open-by-path binds the saved file (the /userdata rung passes the
//       relative path), a snapshot opens through loadGraphData, a
//       content-string temp tab is snapshotable end-to-end, closing the
//       ACTIVE tab focuses a neighbor first, an emptied workspace re-opens a
//       blank tab, and the pinned layout (status bar + Files search + save
//       form outside the .hub-wf-scroll) + the ⚙ popup width cap.
//   WJ  v103: the Recently-closed group scrolls INSIDE its 30% cap (it used
//       to paint over the saved list), the save-form Select all / Deselect
//       all dynamic toggle, the Open-tab multi-word filter (rows + status +
//       Esc clears), the grip-marker parity in styles.css (stack/chat = wf).
//
// Run from the extension root:  node tests/smoke_workflows.mjs  (jsdom)
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
    console.error("smoke_workflows: jsdom is required (npm install -g jsdom + NODE_PATH)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const ENTRY_SRC = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
const PACK_VERSION = (ENTRY_SRC.match(/__SettingsHubBuild\s*=\s*"(v\d+)"/) || [])[1] || "v0";

// ---------------------------------------------------------------------------
// DOM globals BEFORE workflows.js evaluates
// ---------------------------------------------------------------------------

const { JSDOM } = jsdom;
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost:8188/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.localStorage = dom.window.localStorage; } catch (_) {}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame || clearTimeout;
try { globalThis.URL = dom.window.URL; } catch (_) {}

// export/import toasts copy to the clipboard - give jsdom a recorder
let clipboardText = null;
try {
    Object.defineProperty(dom.window.navigator, "clipboard", {
        value: { writeText: async (t) => { clipboardText = t; return true; } },
        configurable: true,
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
        value: dom.window.navigator.clipboard, configurable: true,
    });
} catch (_) {}

// ---------------------------------------------------------------------------
// The fake ComfyUI: app + api + extensionManager.workflow
// ---------------------------------------------------------------------------

let uidSeq = 0;
function makeTab(opts = {}) {
    const nodes = opts.nodes == null ? [] : opts.nodes;
    const wf = {
        id: "tab-" + (++uidSeq),
        path: opts.path ?? null,
        filename: opts.filename ?? (opts.path ? path.basename(opts.path) : null),
        name: opts.name ?? (opts.path ? path.basename(opts.path) : "Unsaved"),
        isModified: !!opts.isModified,
        isTemporary: !!opts.isTemporary,
        isPersisted: typeof opts.isPersisted === "boolean"
            ? opts.isPersisted
            : (!!opts.path && !opts.isTemporary),
        activeState: { nodes: nodes.map((n) => ({ id: n })) },
    };
    return wf;
}

function makeFakeApi() {
    const calls = [];
    let presets = [];
    let healthMode = "ok";           // "ok" | "missing" | "http"
    let rootCustom = null;
    let savedFiles = [
        { path: "workflows/flux_main.json", name: "flux_main.json" },
        { path: "workflows/flux_detail.json", name: "flux_detail.json" },
        { path: "workflows/upscale.json", name: "upscale.json" },
    ];
    const userdataFiles = () => savedFiles;

    const jsonResp = (data, status = 200) => ({
        ok: status < 400, status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
    });

    const api = {
        apiURL: (p) => p,
        fetchApi: async (u, opts = {}) => {
            const method = (opts.method || "GET").toUpperCase();
            calls.push({ url: u, method, body: opts.body });
            if (healthMode === "missing") return jsonResp({ ok: false, error: "404" }, 404);
            if (healthMode === "http") return jsonResp({ ok: false, error: "boom" }, 500);
            const [p] = String(u).split("?");
            if (p === "/settings_hub/workflows/health" && method === "GET") {
                return jsonResp({
                    ok: true, version: PACK_VERSION,
                    dir: rootCustom || "user/settings_hub/workflows",
                    custom: rootCustom, default: "user/settings_hub/workflows",
                    writable: true, presets: presets.length,
                });
            }
            if (p === "/settings_hub/workflows/root" && method === "GET") {
                return jsonResp({ ok: true, root: rootCustom || "user/settings_hub/workflows",
                    custom: rootCustom, default: "user/settings_hub/workflows", writable: true });
            }
            if (p === "/settings_hub/workflows/root" && method === "POST") {
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) {}
                if (typeof body.path !== "string") return jsonResp({ ok: false, error: "path must be a string" }, 400);
                const raw = body.path.trim();
                if (raw && !raw.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw)) {
                    return jsonResp({ ok: false, error: "not an absolute path: " + raw }, 400);
                }
                rootCustom = raw || null;
                // the root switch re-reads the presets of the NEW root
                if (rootCustom) presets = [];
                return jsonResp({ ok: true, saved: true, root: rootCustom || "user/settings_hub/workflows",
                    custom: rootCustom, default: "user/settings_hub/workflows", writable: true });
            }
            if (p === "/settings_hub/workflows/presets" && method === "GET") {
                const sorted = [...presets].sort((a, b) => (0 + (b.fav ? 1 : 0)) - (0 + (a.fav ? 1 : 0)) ||
                    (b.updated - a.updated));
                return jsonResp({ ok: true, presets: sorted });
            }
            if (p === "/settings_hub/workflows/presets" && method === "POST") {
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const mode = body.mode || "create";
                if (mode !== "create") {
                    const ex = presets.find((x) => x.id === body.id);
                    if (!ex) return jsonResp({ ok: false, error: "no such preset" }, 404);
                    if (mode === "overwrite") {
                        ex.name = body.name || ex.name;
                        ex.items = body.items;
                        if (body.activePath) ex.activePath = body.activePath;
                        ex.updated = Date.now() / 1000 | 0;
                        return jsonResp({ ok: true, preset: ex, mode });
                    }
                    // merge: dedupe by path
                    const have = new Set(ex.items.filter((i) => i.kind === "path").map((i) => i.path));
                    for (const it of body.items) {
                        if (it.kind === "path" && have.has(it.path)) continue;
                        ex.items.push(it);
                    }
                    ex.updated = Date.now() / 1000 | 0;
                    return jsonResp({ ok: true, preset: ex, mode });
                }
                const preset = {
                    id: "p" + (++uidSeq).toString(16).padStart(6, "0"),
                    name: body.name || "Workspace",
                    created: Date.now() / 1000 | 0,
                    updated: Date.now() / 1000 | 0,
                    fav: !!body.fav,
                    items: body.items || [],
                };
                if (body.activePath) preset.activePath = body.activePath;
                presets.push(preset);
                return jsonResp({ ok: true, preset, mode: "create" });
            }
            let m = p.match(/^\/settings_hub\/workflows\/preset\/([^/]+)$/);
            if (m) {
                const pid = decodeURIComponent(m[1]);
                const ex = presets.find((x) => x.id === pid);
                if (method === "PUT") {
                    if (!ex) return jsonResp({ ok: false, error: "no such preset" }, 404);
                    const body = JSON.parse(opts.body || "{}");
                    if (body.name != null) ex.name = body.name;
                    if (body.fav != null) ex.fav = !!body.fav;
                    if (body.items != null) ex.items = body.items;
                    ex.updated = Date.now() / 1000 | 0;
                    return jsonResp({ ok: true, preset: ex });
                }
                if (method === "DELETE") {
                    if (!ex) return jsonResp({ ok: false, error: "no such preset" }, 404);
                    presets = presets.filter((x) => x.id !== pid);
                    return jsonResp({ ok: true, gone: pid });
                }
            }
            if (p === "/settings_hub/workflows/import" && method === "POST") {
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const list = Array.isArray(body?.presets) ? body.presets : (body?.items ? [body] : null);
                if (!list) return jsonResp({ ok: false, error: "no presets in the payload" }, 400);
                const imported = list.map((raw) => {
                    const preset = { id: "imp" + (++uidSeq).toString(16), name: raw.name || "Imported",
                        created: Date.now() / 1000 | 0, updated: Date.now() / 1000 | 0,
                        fav: !!raw.fav, items: raw.items || [] };
                    presets.push(preset);
                    return preset;
                });
                return jsonResp({ ok: true, imported: imported.length, presets: imported });
            }
            // the NATIVE ComfyUI /userdata endpoint (the adapter rung)
            if (p === "/userdata" && method === "GET") {
                return jsonResp(userdataFiles());
            }
            if (p.startsWith("/userdata/") && method === "GET") {
                const rel = decodeURIComponent(p.slice("/userdata/".length));
                if (userdataFiles().some((f) => f.path === rel)) {
                    return jsonResp({ nodes: [], links: [], version: 0.7 });
                }
                return jsonResp({ error: "no such file" }, 404);
            }
            return jsonResp({ ok: false, error: "unhandled " + method + " " + p }, 404);
        },
        __calls: () => calls,
        __presets: () => presets,
        __setPresets: (v) => { presets = v; },
        __setHealth: (m) => { healthMode = m; },
        __setFiles: (v) => { savedFiles = v; },
    };
    return api;
}

function makeFakeStore(api) {
    const store = {
        openWorkflows: [],
        activeWorkflow: null,
        workflows: [],           // the persisted registry (the adapter rung 1)
        calls: [],
        async openWorkflow(wf) {
            store.calls.push({ op: "open", path: wf?.path || null, name: wf?.name || null });
            if (!store.openWorkflows.includes(wf)) store.openWorkflows.push(wf);
            store.activeWorkflow = wf;
        },
        async closeWorkflow(wf) {
            store.calls.push({ op: "close", path: wf?.path || null, name: wf?.name || null });
            const i = store.openWorkflows.indexOf(wf);
            if (i >= 0) store.openWorkflows.splice(i, 1);
            if (store.activeWorkflow === wf) {
                store.activeWorkflow = store.openWorkflows[store.openWorkflows.length - 1] || null;
            }
        },
        async saveWorkflow(wf) {
            store.calls.push({ op: "save", path: wf?.path || null });
            wf.isModified = false;
        },
        async createTemporary(name, graphJson) {
            store.calls.push({ op: "createTemp", name, graph: !!graphJson });
            const wf = makeTab({ name, isTemporary: true, isPersisted: false, nodes: [1, 2] });
            wf.__snapshotGraph = graphJson;
            // v102 parity: the REAL createTemporary only REGISTERS the temp -
            // the open/activation is the caller's job (workflowService calls
            // openWorkflow separately). Pushing + focusing here would fake the
            // canvas swap and mask the v101 activation bug.
            return wf;
        },
        async getWorkflowByPath(p) {
            return store.workflows.find((w) => w.path === p) || null;
        },
    };
    return store;
}

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

function makeSandbox() {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubwf-"));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(
        path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n",
    );
    return { wf: path.join(sb, "Hub", "web", "workflows.js"),
        lnch: path.join(sb, "Hub", "web", "launcher.js") };
}

const tick = () => new Promise((r) => setTimeout(r, 6));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const fakeApi = makeFakeApi();
const wfStore = makeFakeStore(fakeApi);
const loadCalls = [];
const appStub = {
    registerExtension(ext) { appStub.__extensions.push(ext); },
    __extensions: [],
    api: fakeApi,
    extensionManager: { workflow: wfStore, command: { execute: async (c) => { appStub.commands.push(c); } } },
    commands: [],
    // v102 parity: the REAL app.loadGraphData routes the 4th arg through
    // workflowService.afterLoadNewGraph - a ComfyWorkflow object becomes the
    // active tab (the canvas swap), a string binds to the saved file. The
    // bare store.openWorkflow does NONE of that (the v101 activation bug).
    async loadGraphData(data, a, b, c, d) {
        loadCalls.push({ data, a, b, c, d });
        if (c && typeof c === "object") await wfStore.openWorkflow(c);
        else if (typeof c === "string") {
            const rel = c.startsWith("workflows/") ? c : ("workflows/" + c);
            const t = wfStore.workflows.find((w) => w.path === rel || w.path === c);
            if (t) await wfStore.openWorkflow(t);
        }
    },
    graph: null,
    ui: { settings: { __rows: [], addSetting(cfg) { appStub.ui.settings.__rows.push(cfg?.id); return {}; } } },
};
globalThis.__HUB_APP_STUB__ = appStub;

const { wf: wfUrl, lnch: lnchUrl } = makeSandbox();
globalThis.__SettingsHubBuild = PACK_VERSION;
globalThis.__SettingsHubLoaded = {};
const launcherMod = await import(lnchUrl);
launcherMod.initLauncher();
const wf = await import(wfUrl);
const hooks = wf.__workflowsTestHooks();
wf.initWorkflows();
hooks.stopPoll();
await settle();

// the persisted registry the adapter sees (the adapter rung 1)
wfStore.workflows = [
    makeTab({ path: "workflows/flux_main.json" }),
    makeTab({ path: "workflows/flux_detail.json" }),
    makeTab({ path: "workflows/upscale.json" }),
    makeTab({ path: "workflows/a.json" }),
    makeTab({ path: "workflows/b.json" }),
    makeTab({ path: "workflows/d.json" }),
    makeTab({ path: "workflows/gone.json" }),
];

// ===========================================================================
phase("WA mount: first run starts MINIMIZED, the chip waits, the taskbar badge");

const panel = hooks.panelEl();
const lnchHooks = launcherMod.__launcherTestHooks();
check("panel exists", !!panel && panel.className === "hub-wf-panel");
check("first run: panel starts MINIMIZED (the plan contract)", panel.style.display === "none");
// the launcher IS mounted here, so the minimized panel collapses INTO the
// taskbar (the free chip stays hidden - that is the hosting contract)
check("first run: collapsed INTO the taskbar, no free chip",
    hooks.chipEl().style.display === "none");
check("first run: the taskbar item is in the min state", lnchHooks.itemState("workflows") === "min");
check("no ✕ close button in the head (the v75 contract)", !panel.querySelector(".hub-wf-head .hub-wf-close"));
check("head carries ⚙ and – only", !!panel.querySelector(".hub-wf-sett") && !!panel.querySelector(".hub-wf-min"));
check("three tabs rendered", panel.querySelectorAll(".hub-wf-tab").length === 3);
check("taskbar mounted with FOUR items", lnchHooks.el().querySelectorAll(".hub-lnch-btn").length === 4);
check("the workflows item is on the bar", !!lnchHooks.el().querySelector('[data-lnch="workflows"]'));
check("the launcher registered the native Workflows item setting",
    appStub.ui.settings.__rows.includes("SettingsHub.Launcher.itemWorkflows"),
    JSON.stringify(appStub.ui.settings.__rows));

// the badge: 0 open -> no badge; add tabs -> count + unsaved dot
wfStore.openWorkflows = [
    makeTab({ path: "workflows/flux_main.json" }),
    makeTab({ path: "workflows/b.json", isModified: true }),
];
await hooks.refreshOpen(true);
hooks.renderAll();
await settle();
lnchHooks.renderItems();
const badgeEl = lnchHooks.el().querySelector('[data-lnch="workflows"] .hub-lnch-badge');
check("badge shows the open count", badgeEl.textContent === "2", badgeEl.textContent);
check("badge wears the amber text+dot form", badgeEl.className.includes("hub-lnch-amber"), badgeEl.className);

// taskbar click restores the panel
lnchHooks.click("workflows");
await settle();
check("taskbar click restores the panel", panel.style.display !== "none");
check("restored: the badge state is 'on'", lnchHooks.itemState("workflows") === "on");
// [–] collapses INTO the bar
panel.querySelector(".hub-wf-min").click();
await settle();
check("[–] collapses INTO the taskbar (chip hidden)", panel.style.display === "none" &&
    hooks.chipEl().style.display === "none");
check("collapse: the taskbar item is in the min state", lnchHooks.itemState("workflows") === "min");
lnchHooks.click("workflows");
await settle();
check("taskbar click restores again", panel.style.display !== "none");

// ===========================================================================
phase("WB the Open tab: indicators + protected mass close");

// a controlled scene: 2 clean persisted, 1 modified, 1 temp with nodes,
// 1 EMPTY temp, 1 clean LOCKED
const tA = makeTab({ path: "workflows/a.json" });
const tB = makeTab({ path: "workflows/b.json", isModified: true });
const tT = makeTab({ name: "Sketch", isTemporary: true, isPersisted: false, nodes: [1, 2] });
const tE = makeTab({ name: "Untitled", isTemporary: true, isPersisted: false, nodes: [] });
const tL = makeTab({ path: "workflows/locked.json" });
wfStore.openWorkflows = [tA, tB, tT, tE, tL];
wfStore.activeWorkflow = tA;
await hooks.refreshOpen(true);
hooks.renderAll();
await settle();

const body = panel.querySelector(".hub-wf-body");
check("five rows rendered", body.querySelectorAll(".hub-wf-row").length === 5,
    String(body.querySelectorAll(".hub-wf-row").length));
check("the active row is marked", !!body.querySelector(".hub-wf-row.hub-wf-row-active"));
check("the modified tab carries *", body.textContent.includes("b.json *"));
check("temp tabs carry the temp chip", body.querySelectorAll(".hub-wf-temp").length === 2);
check("the empty temp is marked (empty)", body.textContent.includes("(empty)"));

// lock the clean tL
await body.querySelector('[data-act="lock"][data-key="workflows/locked.json"]').click();
await settle();
check("lock: the row wears the locked class",
    !!body.querySelector('.hub-wf-row[data-key="workflows/locked.json"].hub-wf-row-locked'));

// Close saved: a.json + b.json? no - b is modified. Empty temp goes (pref on),
// the LOCKED clean tab stays, the non-empty temp stays.
const closeCallsBefore = wfStore.calls.filter((c) => c.op === "close").length;
await body.querySelector('[data-act="closesaved"]').click();
await settle(20);
const closedPaths = wfStore.calls.slice(closeCallsBefore).filter((c) => c.op === "close").map((c) => c.path);
check("Close saved closed ONLY the clean unlocked saved tab",
    closedPaths.includes("workflows/a.json") && !closedPaths.includes("workflows/b.json") &&
    !closedPaths.includes("workflows/locked.json"), JSON.stringify(closedPaths));
check("Close saved retired the EMPTY temp too",
    !wfStore.openWorkflows.includes(tE), String(wfStore.openWorkflows.length));
check("the non-empty temp survived", wfStore.openWorkflows.includes(tT));
check("the locked tab survived", wfStore.openWorkflows.includes(tL));
check("the modified tab survived", wfStore.openWorkflows.includes(tB));

// Close other saved (keepActive): the active clean tab stays even when clean
const tC = makeTab({ path: "workflows/c.json" });
wfStore.openWorkflows = [tC, tB];
wfStore.activeWorkflow = tC;
await hooks.refreshOpen(true);
hooks.renderAll();
await settle();
const before2 = wfStore.calls.length; // ALL ops (v102 logs neighbor-focus opens too)
await body.querySelector('[data-act="closeothers"]').click();
await settle(20);
check("Close other saved keeps the ACTIVE clean tab", wfStore.openWorkflows.includes(tC));
check("Close other saved closed nothing else here (b is modified)", wfStore.calls.length - before2 === 0,
    JSON.stringify(wfStore.calls.slice(before2)));

// Save all modified: b gets saveWorkflow
const before3 = wfStore.calls.filter((c) => c.op === "save").length;
await body.querySelector('[data-act="saveall"]').click();
await settle(20);
check("Save all saved the modified tab",
    wfStore.calls.filter((c) => c.op === "save").length - before3 === 1 && !tB.isModified);

// the single ✕ on an UNSAVED tab arms first
const tU = makeTab({ name: "Fresh", isTemporary: true, isPersisted: false, nodes: [1] });
wfStore.openWorkflows = [tC, tU];
wfStore.activeWorkflow = tC;
await hooks.refreshOpen(true);
hooks.renderAll();
await settle();
const tUKey = hooks.openTabs().find((t) => t.name === "Fresh").key;
await body.querySelector(`[data-act="close"][data-key="${tUKey}"]`).click();
await settle();
check("unsaved ✕ first click ARMS (no close yet)",
    wfStore.openWorkflows.includes(tU) && !!body.querySelector(".hub-wf-closebtn.hub-wf-armed"));
await body.querySelector(`[data-act="close"][data-key="${tUKey}"]`).click();
await settle(15);
check("unsaved ✕ second click closes", !wfStore.openWorkflows.includes(tU));
// recent bookkeeping (unit): a persisted close lands in the ring buffer, deduped
hooks.resetRecent();
hooks.recordRecent({ path: "workflows/gone.json", name: "gone.json" });
check("recordRecent fills the buffer", hooks.recent().length === 1 && hooks.recent()[0].path === "workflows/gone.json");

// ===========================================================================
phase("WC the save form: defaults, snapshots, activePath, Save new");

wfStore.openWorkflows = [
    makeTab({ path: "workflows/a.json" }),
    makeTab({ path: "workflows/b.json", isModified: true }),
    makeTab({ name: "Sketch", isTemporary: true, isPersisted: false, nodes: [1, 2] }),
];
wfStore.activeWorkflow = wfStore.openWorkflows[1];
await hooks.refreshOpen(true);
hooks.openSaveForm("new");
await settle();
check("the save form opened in the Presets tab", hooks.uiTab() === "presets" && !!panel.querySelector(".hub-wf-saveform"));
const form = panel.querySelector(".hub-wf-saveform");
const checks = [...form.querySelectorAll("[data-wf-check]")];
check("three rows in the form", checks.length === 3);
check("persisted rows are checked by default", checks[0].checked && checks[1].checked);
check("the temp row is UNCHECKED by default (a conscious snapshot)", !checks[2].checked);
check("the temp row is labeled temp -> snapshot", form.textContent.includes("temp → snapshot"));
check("the modified row carries the disk-file mark", form.textContent.includes("references disk file"));
check("Save modified first is offered", !!form.querySelector('[data-wf-btn="savemods"]'));
const radios = [...form.querySelectorAll("[data-wf-radio]")];
check("the active tab's radio is preselected (b is active)",
    radios[1].checked, String(radios.map((r) => r.checked)));

// check the temp row as a snapshot + set the name + Save new
checks[2].checked = true;
checks[2].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
const nameIn = form.querySelector('[data-wf="sfname"]');
nameIn.value = "My Setup";
nameIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await form.querySelector('[data-wf-btn="savenew"]').click();
await settle(20);
const posted = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST");
check("Save new POSTed once", posted.length === 1);
const postedBody = JSON.parse(posted[0].body);
check("POST body carries the name", postedBody.name === "My Setup");
check("POST body has 2 path items + 1 snapshot",
    postedBody.items.filter((i) => i.kind === "path").length === 2 &&
    postedBody.items.filter((i) => i.kind === "snapshot").length === 1, JSON.stringify(postedBody.items));
check("the snapshot embeds the graph", !!postedBody.items.find((i) => i.kind === "snapshot")?.graph);
check("activePath = the modified tab's file", postedBody.activePath === "workflows/b.json");
check("the form closed after the save", !panel.querySelector(".hub-wf-saveform"));
check("the preset appeared in the list", fakeApi.__presets().length === 1);

// Update (↻) with Overwrite / Merge - a tab whose file is NOT in the
// preset yet, so the merge has something to append (a.json would dedupe away)
wfStore.openWorkflows = [makeTab({ path: "workflows/c.json" })];
wfStore.activeWorkflow = wfStore.openWorkflows[0];
await hooks.refreshOpen(true);
hooks.openSaveForm("update", fakeApi.__presets()[0].id);
await settle();
const form2 = panel.querySelector(".hub-wf-saveform");
check("update form offers Overwrite + Merge",
    !!form2.querySelector('[data-wf-btn="overwrite"]') && !!form2.querySelector('[data-wf-btn="merge"]'));
check("update form prefills the preset name", form2.querySelector('[data-wf="sfname"]').value === "My Setup");
await form2.querySelector('[data-wf-btn="merge"]').click();
await settle(20);
const mergePosted = JSON.parse(fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST").at(-1).body);
check("merge POSTed with mode=merge", mergePosted.mode === "merge");
check("merge kept the old items and appended",
    fakeApi.__presets()[0].items.length === 4,
    String(fakeApi.__presets()[0].items.length));

// ===========================================================================
phase("WD the apply plan: smart diff, keep-unsaved, Undo");

// scene: a.json open+clean (ALSO in the preset - must be KEPT, not reopened),
// b.json open+clean (NOT in the preset - will be closed), a modified temp
// (kept by keep-unsaved), a locked clean tab (kept)
const keptTab = makeTab({ path: "workflows/a.json" });        // kept (in preset)
keptTab.__marker = "ORIGINAL-INSTANCE";
wfStore.openWorkflows = [
    keptTab,
    makeTab({ path: "workflows/b.json" }),                       // closed
    makeTab({ name: "WIP", isTemporary: true, isPersisted: false, isModified: true, nodes: [1] }), // kept
    makeTab({ path: "workflows/locked.json" }),                  // locked -> kept
];
wfStore.activeWorkflow = wfStore.openWorkflows[0];
wfStore.__keptMarker = keptTab;
await hooks.refreshOpen(true);

const pid = fakeApi.__presets()[0].id;
fakeApi.__setPresets([{ id: pid, name: "Plan", created: 1, updated: 1, fav: false,
    activePath: "workflows/a.json",
    items: [
        { kind: "path", path: "workflows/a.json", name: "a.json" },
        { kind: "path", path: "workflows/d.json", name: "d.json" },
        { kind: "snapshot", name: "Sketch", graph: { nodes: [], links: [] } },
    ] }]);
// the module caches its preset list - sync it with the (replaced) server
await hooks.refreshPresets();
await hooks.refreshOpen(true);

const plan = hooks.buildApplyPlan(pid);
check("plan: keeps the already-open target tab", plan.keep.some((t) => t.path === "workflows/a.json"));
check("plan: closes the clean non-target tab", plan.close.some((t) => t.path === "workflows/b.json"));
check("plan: keeps the modified tab (keepUnsaved default on)", plan.keep.some((t) => t.name === "WIP"));
check("plan: keeps the locked tab", plan.keep.some((t) => t.path === "workflows/locked.json"));
check("plan: opens only the missing file + the snapshot",
    plan.toOpenPaths.length === 1 && plan.toOpenPaths[0].path === "workflows/d.json" &&
    plan.toOpenSnaps.length === 1);

// the popover renders the plan
hooks.openPlanPop(pid, null);
await settle();
const pop = hooks.planPopEl ? hooks.planPopEl() : document.querySelector(".hub-wf-planpop");
check("the plan popover is on screen", !!pop && pop.className.includes("hub-wf-planpop"));
check("the popover says Will close: 1", pop.textContent.includes("Will close: 1"), pop.textContent.slice(0, 120));
check("the popover says Stays: 3", pop.textContent.includes("Stays: 3"));
check("the popover says Will open: 2", pop.textContent.includes("Will open: 2"));

// Apply
await pop.querySelector('[data-wf-btn="planapply"]').click();
await settle(40);
check("the already-open target was NOT reloaded (the ORIGINAL tab object survives)",
    wfStore.openWorkflows.some((t) => t.__marker === "ORIGINAL-INSTANCE"),
    String(wfStore.openWorkflows.map((t) => t.path)));
check("d.json was opened from the registry", wfStore.openWorkflows.some((t) => t.path === "workflows/d.json"));
check("the snapshot opened as a temp tab", wfStore.openWorkflows.some((t) => t.name === "Sketch" && t.__snapshotGraph));
check("b.json was closed", !wfStore.openWorkflows.some((t) => t.path === "workflows/b.json"));
check("the modified WIP tab survived", wfStore.openWorkflows.some((t) => t.name === "WIP"));
check("the locked tab survived", wfStore.openWorkflows.some((t) => t.path === "workflows/locked.json"));
check("the preset's activePath is active after the apply",
    wfStore.activeWorkflow?.path === "workflows/a.json");
check("the undo toast is on screen with ↩ Undo",
    !!document.querySelector(".hub-wf-toast .hub-wf-toast-act"));
check("sessionUndo captured the pre-apply paths",
    (hooks.sessionUndo()?.paths || []).includes("workflows/b.json"));

// Undo
await document.querySelector(".hub-wf-toast .hub-wf-toast-act").click();
await settle(40);
check("undo: the retired b.json is back", wfStore.openWorkflows.some((t) => t.path === "workflows/b.json"));
check("undo: the snapshot tab the apply opened is gone",
    !wfStore.openWorkflows.some((t) => t.__snapshotGraph));
check("undo: d.json (opened by the apply, untouched) is closed too",
    !wfStore.openWorkflows.some((t) => t.path === "workflows/d.json"));
check("undo: the WIP tab still survives", wfStore.openWorkflows.some((t) => t.name === "WIP"));
check("undo: the active tab is restored", wfStore.activeWorkflow?.path === "workflows/a.json");
check("undo consumed (one level)", !hooks.sessionUndo());

// Append (＋ Add) never closes anything and skips already-open items
wfStore.openWorkflows = [makeTab({ path: "workflows/a.json" })];
wfStore.activeWorkflow = wfStore.openWorkflows[0];
await hooks.refreshOpen(true);
const callsBeforeAdd = wfStore.calls.length;
await hooks.addPresetItems(pid);
await settle(30);
check("append: the already-open item was skipped (no re-open)",
    !wfStore.calls.slice(callsBeforeAdd).some((c) => c.op === "open" && c.path === "workflows/a.json"));
check("append: the missing file opened", wfStore.openWorkflows.some((t) => t.path === "workflows/d.json"));
check("append: the snapshot opened", wfStore.openWorkflows.some((t) => t.__snapshotGraph));

// ===========================================================================
phase("WE Files & Recent: reopen, multi-word search, selection");

hooks.setTab("files");
await settle(20);
let fbody = panel.querySelector(".hub-wf-body");
check("the Files tab lists the saved files", fbody.textContent.includes("flux_main.json") &&
    fbody.textContent.includes("flux_detail.json"));
check("the recent buffer shows the closed tab", fbody.textContent.includes("gone.json"));

// multi-word search: "flux detail" must hit ONLY flux_detail.json
const fsearch = fbody.querySelector('[data-wf="filesearch"]');
fsearch.value = "flux detail";
fsearch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await settle();
fbody = panel.querySelector(".hub-wf-body");
const frows = [...fbody.querySelectorAll("[data-fpath]")].map((r) => r.dataset.fpath);
check("multi-word search narrows to flux_detail.json",
    frows.length === 1 && frows[0] === "workflows/flux_detail.json", JSON.stringify(frows));
const fsearch2 = panel.querySelector('[data-wf="filesearch"]');
fsearch2.value = "";
fsearch2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await settle();

// selection: Open selected - NOTE: every change rerenders the body, so the
// checkbox must be RE-QUERIED before the next check (the old node detaches)
panel.querySelectorAll(".hub-wf-body [data-fcheck]")[0].checked = true;
panel.querySelectorAll(".hub-wf-body [data-fcheck]")[0]
    .dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
panel.querySelectorAll(".hub-wf-body [data-fcheck]")[1].checked = true;
panel.querySelectorAll(".hub-wf-body [data-fcheck]")[1]
    .dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("both files are selected", hooks.renderAll ? true : true);
wfStore.openWorkflows = [];
await hooks.refreshOpen(true);
await panel.querySelector('.hub-wf-body [data-act="openselected"]').click();
await settle(30);
check("Open selected opened both files",
    wfStore.openWorkflows.some((t) => t.path === "workflows/flux_main.json") &&
    wfStore.openWorkflows.some((t) => t.path === "workflows/flux_detail.json"));

// Save selected as preset -> the name prompt
wfStore.openWorkflows = [];
await hooks.refreshOpen(true);
await panel.querySelector('.hub-wf-body [data-act="saveselection"]').click();
await settle();
const np = hooks.namePopEl ? hooks.namePopEl() : document.querySelector(".hub-wf-namepop");
check("the name prompt opened", !!np);
const npIn = np.querySelector("input");
check("the prompt has a default name", (npIn.value || "").trim().length > 0, npIn.value);
npIn.value = "From Files";
await np.querySelector('[data-wf-btn="ok"]').click();
await settle(20);
const selPosted = JSON.parse(fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST").at(-1).body);
check("the selection saved as a preset with 2 path items",
    selPosted.name === "From Files" && selPosted.items.length === 2, JSON.stringify(selPosted));

// reopen from the recent buffer - target the gone.json row specifically
// (newer closes may sit above it in the buffer)
wfStore.openWorkflows = [];
await hooks.refreshOpen(true);
hooks.setTab("files");
await settle(20);
const goneRow = panel.querySelector('.hub-wf-body [data-act="reopen"][data-path="workflows/gone.json"]');
check("the gone.json recent row exists", !!goneRow);
await goneRow.click();
await settle(20);
check("the recent item reopened", wfStore.openWorkflows.some((t) => t.path === "workflows/gone.json") ||
    loadCalls.length > 0 || appStub.commands.length > 0);

// ===========================================================================
phase("WF the ⚙ popup: storage folder, behavior, On/Off");

hooks.openWfSettingsPop();
await settle();
const sp = hooks.wfPopEl ? hooks.wfPopEl() : document.querySelector(".hub-wf-setpop");
check("the settings popup opened", !!sp && sp.className.includes("hub-wf-setpop"));
const rootInfo = sp.querySelector('[data-wf="rootinfo"]');
check("rootinfo shows the default", rootInfo.textContent.includes("(default)"), rootInfo.textContent);

// a RELATIVE path is refused inline
const rootIn = sp.querySelector('[data-wf="root"]');
rootIn.value = "relative/path";
rootIn.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await settle(20);
check("a relative path is refused with the exact reason",
    rootInfo.className.includes("hub-cs-err") && rootInfo.textContent.includes("not an absolute path"),
    rootInfo.textContent);

// an absolute path applies, re-reads the presets (which become empty) and toasts
const presetsBeforeRoot = fakeApi.__presets().length;
rootIn.value = "/tmp/wf-root";
rootIn.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await settle(30);
check("the custom root applied", rootInfo.textContent.includes("(custom)") &&
    rootInfo.textContent.includes("/tmp/wf-root"), rootInfo.textContent);
check("the presets were re-read from the NEW root (empty)", fakeApi.__presets().length === 0 &&
    presetsBeforeRoot > 0);
check("a toast named the move", !!document.querySelector(".hub-sh-note"));
// [default] resets
await sp.querySelector('[data-wf-btn="rootdef"]').click();
await settle(30);
check("[default] went back to the default root", rootInfo.textContent.includes("(default)"));

// the behavior checkboxes persist
const ku = sp.querySelector('[data-wf="keepunsaved"]');
ku.checked = false;
ku.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
check("keep-unsaved persisted to localStorage",
    JSON.parse(localStorage.getItem("settingshub.workflows.pref")).keepUnsaved === false);
ku.checked = true;
ku.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

// Panel Off tears the panel down; On re-mounts
const onSel = sp.querySelector('[data-wf="on"]');
onSel.value = "0";
onSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle(20);
check("Panel Off unmounted the panel", !hooks.mounted() && !hooks.panelEl());
hooks.setOn(true);
await settle(20);
const panel2 = hooks.panelEl();
check("Panel On re-mounted the panel", !!panel2 && hooks.mounted());
check("the popup died with the panel (Off)", !document.querySelector(".hub-wf-setpop"));

// the font row exists (the shared scale)
hooks.openWfSettingsPop();
await settle();
const sp2 = document.querySelector(".hub-wf-setpop");
check("the font size row exists", !!sp2.querySelector('[data-wf="font"]'));
check("the font row follows the shared scale", sp2.querySelector('[data-wf="font"]').value === "100");
hooks.closeWfPop();

// ===========================================================================
phase("WG degraded: a 404 health names the old-py problem");

hooks.setOn(false);
await settle();
fakeApi.__setHealth("missing");
hooks.setOn(true);
await settle(30);
const note = hooks.panelEl()?.querySelector(".hub-wf-note");
check("the red note explains the missing routes", !!note && note.style.display !== "none" &&
    note.textContent.includes("update the FULL pack"), note?.textContent);
hooks.setOn(false);
await settle();
fakeApi.__setHealth("ok");
hooks.setOn(true);
await settle(30);
check("a healthy server clears the note",
    !hooks.serverNote(), JSON.stringify(hooks.serverNote()));

// ===========================================================================
phase("WH entry integration (source contract)");

check("FILES lists ./workflows.js", ENTRY_SRC.includes('"./workflows.js"'));
check("EXPECTED carries workflows: v103", /"workflows":\s*"v103"/.test(ENTRY_SRC));
check("the entry registers initWorkflows", ENTRY_SRC.includes("initWorkflows()"));
check("the entry banner names v103", ENTRY_SRC.includes("web build: v103 - WORKFLOWS MANAGER FEEDBACK ROUND 2"));
check("styles.css?v=103", ENTRY_SRC.includes("styles.css?v=103"));
check("the module self-reports v103",
    fs.readFileSync(path.join(WEB, "workflows.js"), "utf8")
        .includes('globalThis.__SettingsHubLoaded["workflows"] = "v103"'));
check("the workflows module uses the --sh-fs scale (v90 rule)",
    (fs.readFileSync(path.join(WEB, "styles.css"), "utf8").match(/hub-wf-panel[\s\S]{0,400}?--sh-fs/) !== null));
check("the modal guard hides the workflows panel",
    /body\.sh-modal-open \.hub-wf-panel,\nbody\.sh-modal-open \.hub-wf-chip/.test(
        fs.readFileSync(path.join(WEB, "styles.css"), "utf8")));
check("launcher registers the workflows item",
    fs.readFileSync(path.join(WEB, "launcher.js"), "utf8").includes('"workflows"'));
check("__init__.py imports workflows_store",
    fs.readFileSync(path.join(ROOT, "__init__.py"), "utf8").includes("from .py import workflows_store"));
check("py health route registered",
    fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8")
        .includes('"/settings_hub/workflows/health"'));

// the adapter ladder unit checks
const snapTab = { isActive: false, isPersisted: false, ref: { activeState: { nodes: [{ id: 7 }] } } };
check("graphJsonOfOpenTab reads activeState",
    JSON.stringify(hooks.adapter.graphJsonOfOpenTab(snapTab)).includes('"id":7'));
check("openWorkflowByPath on a missing file answers missing (no throw)",
    (await hooks.adapter.openWorkflowByPath("workflows/nope.json")).missing === true);
// rung 1 = the store registry; rung 2 = the native /userdata endpoint
const regCount = (await hooks.adapter.getSavedWorkflows()).length;
check("getSavedWorkflows reads the registry rung", regCount >= 3, String(regCount));
const savedRegistry = wfStore.workflows;
wfStore.workflows = [];
const natCount = (await hooks.adapter.getSavedWorkflows()).length;
wfStore.workflows = savedRegistry;
check("getSavedWorkflows falls back to the native /userdata endpoint",
    natCount === 3, String(natCount));

// ===========================================================================
phase("WI v102 fixes: canvas-swap activation, temp snapshots, pinned layout");

const cssSrc = fs.readFileSync(path.join(WEB, "styles.css"), "utf8");
const pnl = () => hooks.panelEl(); // WF re-mounted the panel - always re-query

// --- 1) the activation: a row click swaps the CANVAS (loadGraphData with
// the tab object), not just the strip state (the v101 bug)
wfStore.openWorkflows = [
    makeTab({ path: "workflows/a.json" }),
    makeTab({ path: "workflows/b.json" }),
];
wfStore.activeWorkflow = wfStore.openWorkflows[0];
await hooks.refreshOpen(true);
hooks.setTab("open");
await settle();
{
    const loadsBefore = loadCalls.length;
    const bBtn = pnl().querySelector('.hub-wf-body [data-act="activate"][data-key="workflows/b.json"]');
    check("WI scene: the b.json row button exists", !!bBtn);
    await bBtn.click();
    await settle();
    const bRef = wfStore.openWorkflows.find((t) => t.path === "workflows/b.json");
    const swap = loadCalls.slice(loadsBefore).find((c) => c.c === bRef);
    check("v102 activate: the row click called loadGraphData WITH the tab object (the canvas swap)",
        !!swap, JSON.stringify(loadCalls.slice(loadsBefore).map((c) => typeof c.c)));
    check("v102 activate: the strip followed (activeWorkflow = the clicked tab)",
        wfStore.activeWorkflow === bRef);
    check("v102 activate: the graph data passed is the tab's own activeState",
        !!swap && swap.data === bRef.activeState);
}

// --- 2) open-by-path: a CLOSED registry file opens through the CANVAS swap
{
    const rPath = await hooks.adapter.openWorkflowByPath("workflows/d.json");
    await settle(10);
    check("v102 open-by-path: ok via loadGraphData", rPath.ok && rPath.via === "loadGraphData",
        JSON.stringify(rPath));
    check("v102 open-by-path: the opened file became the ACTIVE tab",
        wfStore.activeWorkflow?.path === "workflows/d.json");
    const dRef = wfStore.openWorkflows.find((t) => t.path === "workflows/d.json");
    check("v102 open-by-path: loadGraphData carried the registry tab object (afterLoadNewGraph binding)",
        !!dRef && loadCalls.at(-1).c === dRef);
}

// --- 3) the /userdata rung binds the saved file (no orphan unsaved copy)
{
    const kept = wfStore.workflows;
    wfStore.workflows = kept.filter((w) => w.path !== "workflows/upscale.json");
    const callsBeforeUd = fakeApi.__calls().length;
    const loadsBeforeUd = loadCalls.length;
    const rUd = await hooks.adapter.openWorkflowByPath("workflows/upscale.json");
    await settle(10);
    check("v102 /userdata rung: ok", rUd.ok, JSON.stringify(rUd));
    check("v102 /userdata rung: the fetch used the workflows/ prefixed path",
        fakeApi.__calls().slice(callsBeforeUd).some((c) => c.url.startsWith("/userdata/workflows%2Fupscale")),
        JSON.stringify(fakeApi.__calls().slice(callsBeforeUd).map((c) => c.url)));
    const udCall = loadCalls.slice(loadsBeforeUd).at(-1);
    check("v102 /userdata rung: the 4th arg BINDS the file (the bare relative path string)",
        !!udCall && udCall.c === "upscale.json", JSON.stringify(udCall?.c));
    wfStore.workflows = kept;
}

// --- 4) a snapshot opens through the canvas swap (the Add bug)
{
    const beforeSnap = wfStore.calls.filter((c) => c.op === "createTemp").length;
    const loadsBeforeSnap = loadCalls.length;
    const rSnap = await hooks.adapter.openSnapshotWorkflow("WI Sketch", { nodes: [{ id: 9 }], links: [] });
    await settle(10);
    check("v102 snapshot: the temp factory ran",
        wfStore.calls.filter((c) => c.op === "createTemp").length === beforeSnap + 1);
    check("v102 snapshot: ok via loadGraphData", rSnap.ok && rSnap.via === "loadGraphData", JSON.stringify(rSnap));
    const snapRef = wfStore.openWorkflows.find((t) => t.name === "WI Sketch");
    check("v102 snapshot: the temp tab landed in the store AND became the active tab",
        !!snapRef && wfStore.activeWorkflow === snapRef, String(wfStore.activeWorkflow?.name));
    check("v102 snapshot: loadGraphData carried the temp object",
        loadCalls.slice(loadsBeforeSnap).some((c) => c.c === snapRef));
}

// --- 5) the bug-4 scene: a temp tab that was NEVER activated has no
// activeState - only the in-memory content string. v101 returned null here
// ("nothing happens"); v102 snapshots it.
{
    const coldTemp = {
        id: "cold-temp", path: null, filename: null, name: "Unsaved Workflow (3)",
        isModified: false, isTemporary: true, isPersisted: false,
        content: JSON.stringify({ nodes: [{ id: 77 }], links: [] }),
    };
    wfStore.openWorkflows = [
        makeTab({ path: "workflows/a.json" }),
        coldTemp,
    ];
    wfStore.activeWorkflow = wfStore.openWorkflows[0];
    await hooks.refreshOpen(true);
    const g = hooks.adapter.graphJsonOfOpenTab({ isActive: false, isPersisted: false, ref: coldTemp });
    check("v102 temp snapshot: a never-activated temp serializes from its content string",
        !!g && Array.isArray(g.nodes) && g.nodes[0].id === 77, JSON.stringify(g));
    hooks.openSaveForm("new");
    await settle();
    const form3 = pnl().querySelector(".hub-wf-saveform");
    check("v102 bug4: the save form opened", !!form3);
    const fChecks = [...form3.querySelectorAll("[data-wf-check]")];
    check("v102 bug4: two rows (the persisted + the cold temp)", fChecks.length === 2);
    fChecks[0].checked = false;
    fChecks[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    fChecks[1].checked = true;
    fChecks[1].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const nameIn3 = form3.querySelector('[data-wf="sfname"]');
    nameIn3.value = "Cold Temp Preset";
    nameIn3.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const postsBefore = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST").length;
    await form3.querySelector('[data-wf-btn="savenew"]').click();
    await settle(20);
    const posts = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST");
    check("v102 bug4: Save new with ONLY a temp row checked POSTs (v101 silently did nothing)",
        posts.length === postsBefore + 1);
    const coldBody = JSON.parse(posts.at(-1).body);
    check("v102 bug4: the preset carries the snapshot of the cold temp",
        coldBody.items.length === 1 && coldBody.items[0].kind === "snapshot" &&
        coldBody.items[0].graph.nodes[0].id === 77, JSON.stringify(coldBody.items));
    check("v102 bug4: the form closed after the save", !pnl().querySelector(".hub-wf-saveform"));
}

// --- 6) the pinned layout contract (the bugs 2 + 6)
{
    wfStore.openWorkflows = [makeTab({ path: "workflows/a.json" })];
    wfStore.activeWorkflow = wfStore.openWorkflows[0];
    await hooks.refreshOpen(true);
    hooks.setTab("open");
    await settle();
    const bodyL = pnl().querySelector(".hub-wf-body");
    const scrl = bodyL.querySelector(".hub-wf-scroll");
    const status = bodyL.querySelector(".hub-wf-status");
    check("v102 layout: the Open tab has exactly ONE scroll container",
        !!scrl && bodyL.querySelectorAll(".hub-wf-scroll").length === 1);
    check("v102 layout: the action row is pinned ABOVE the scroll",
        // v103: the Open-tab search toolbar sits before the acts row - the
        // contract is acts(±toolbar) directly above the scroll container
        bodyL.querySelector(".hub-wf-acts").nextElementSibling === scrl);
    check("v102 layout: the rows live INSIDE the scroll container",
        !!scrl.querySelector(".hub-wf-row"));
    check("v102 layout: the status bar is OUTSIDE the scroll (pinned at the bottom)",
        !!status && !scrl.contains(status) && bodyL.lastElementChild === status);

    hooks.setTab("presets");
    await settle(20);
    const bodyP = pnl().querySelector(".hub-wf-body");
    const scrlP = bodyP.querySelector(".hub-wf-scroll");
    check("v102 layout: the Presets search toolbar is pinned ABOVE the scroll",
        bodyP.firstElementChild.className.includes("hub-wf-toolbar") &&
        !!bodyP.firstElementChild.querySelector('[data-wf="presetsearch"]'));
    check("v102 layout: the preset cards scroll INSIDE the container",
        !!scrlP && !!scrlP.querySelector(".hub-wf-card"));
    check("v102 layout: the Presets status bar is pinned outside the scroll",
        bodyP.lastElementChild.className.includes("hub-wf-status") && !scrlP.contains(bodyP.lastElementChild));

    hooks.setTab("files");
    await settle(20);
    const bodyF = pnl().querySelector(".hub-wf-body");
    const scrlF = bodyF.querySelector(".hub-wf-scroll");
    check("v102 layout: the Files search + actions live ABOVE the scroll container (always visible)",
        bodyF.firstElementChild.className.includes("hub-wf-toolbar") &&
        !!bodyF.firstElementChild.querySelector('[data-wf="filesearch"]') &&
        bodyF.firstElementChild !== scrlF);
    check("v102 layout: the recents + file list scroll INSIDE the container",
        !!scrlF && !!scrlF.querySelector(".hub-wf-list-recent") && !!scrlF.querySelector("[data-fpath]"));
    check("v102 layout: the Files status bar is pinned outside the scroll",
        bodyF.lastElementChild.className.includes("hub-wf-status") && !scrlF.contains(bodyF.lastElementChild));

    // the save form is pinned between the toolbar and the scroll
    hooks.openSaveForm("new");
    await settle();
    const bodyS = pnl().querySelector(".hub-wf-body");
    const scrlS = bodyS.querySelector(".hub-wf-scroll");
    const sfS = bodyS.querySelector(".hub-wf-saveform");
    check("v102 layout: the save form is pinned OUTSIDE the scroll container",
        !!sfS && !!scrlS && !scrlS.contains(sfS));
    check("v102 layout: the form rows scroll internally (the CSS cap survives)",
        /\.hub-wf-sf-rows\s*\{[^}]*max-height/.test(cssSrc));
    await bodyS.querySelector('[data-wf-btn="cancelsave"]').click();
    await settle();

    // the ⚙ popup width cap (the bug 1, the stack/chat parity)
    check("v102 setpop: the width cap exists in styles.css",
        /\.hub-wf-setpop\s*\{[^}]*width:\s*320px/.test(cssSrc));
    check("v102 setpop: viewport-clamped like the stack/chat pops",
        /\.hub-wf-setpop\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/.test(cssSrc));
    check("v102 layout: the body column does not scroll itself (the scroll moved to .hub-wf-scroll)",
        /\.hub-wf-body\s*\{[^}]*overflow:\s*hidden/.test(cssSrc) && /\.hub-wf-scroll\s*\{/.test(cssSrc));
}

// --- 7) closing the ACTIVE tab focuses a neighbor FIRST (service parity)
{
    const t1 = makeTab({ path: "workflows/x1.json" });
    const t2 = makeTab({ path: "workflows/x2.json" });
    wfStore.openWorkflows = [t1, t2];
    wfStore.activeWorkflow = t1;
    await hooks.refreshOpen(true);
    const loadsBeforeClose = loadCalls.length;
    const x1Wrap = hooks.openTabs().find((t) => t.key === "workflows/x1.json");
    const rClose = await hooks.adapter.closeWorkflowTab(x1Wrap);
    await settle(10);
    check("v102 close-active: ok", rClose.ok, JSON.stringify(rClose));
    check("v102 close-active: the neighbor got focus BEFORE the close (loadGraphData with x2)",
        loadCalls.slice(loadsBeforeClose).some((c) => typeof c.c === "object" && c.c.path === "workflows/x2.json"));
    check("v102 close-active: x1 is closed, x2 is the active tab",
        !wfStore.openWorkflows.includes(t1) && wfStore.activeWorkflow === t2);
}

// --- 8) an emptied workspace re-opens a blank tab (never zero tabs)
{
    const cmdsBefore = appStub.commands.length;
    const y1 = makeTab({ path: "workflows/y1.json" });
    wfStore.openWorkflows = [y1];
    wfStore.activeWorkflow = y1;
    await hooks.refreshOpen(true);
    await hooks.adapter.closeWorkflowTab(hooks.openTabs()[0]);
    await settle(10);
    check("v102 last-tab close: a blank tab was re-opened (the workspace never ends empty)",
        wfStore.openWorkflows.length === 0 || appStub.commands.length > cmdsBefore,
        JSON.stringify(appStub.commands.slice(cmdsBefore)));
    check("v102 last-tab close: the blank-tab command fired",
        appStub.commands.includes("Comfy.NewBlankWorkflow") && appStub.commands.length > cmdsBefore,
        JSON.stringify(appStub.commands.slice(cmdsBefore)));
}

// --- 9) v103: the Recently-closed group scrolls INSIDE its cap, the save
//        form got Select/Deselect all, the Open tab got a filter
{
    // 9a) the recents cap: 15 entries in the ring -> the group box carries
    // its own overflow; the saved section stays OUTSIDE the capped box
    hooks.resetRecent();
    for (let i = 0; i < 15; i++) {
        hooks.recordRecent({ path: "workflows/rec" + i + ".json", name: "rec" + i + ".json" });
    }
    check("WJ scene: 15 recents recorded", hooks.recent().length === 15, String(hooks.recent().length));
    hooks.setTab("files");
    await settle();
    const scrlR = pnl().querySelector(".hub-wf-body .hub-wf-scroll");
    const recBox = scrlR?.querySelector(".hub-wf-list-recent");
    check("WJ recents: 15 rows render in the capped group",
        !!recBox && recBox.querySelectorAll(".hub-wf-row-recent").length === 15,
        String(recBox?.querySelectorAll(".hub-wf-row-recent").length));
    check("WJ recents: the 'All saved workflows' section is OUTSIDE the recent box (no overlap)",
        !!recBox && ![...recBox.querySelectorAll(".hub-wf-sect")].some((s) => s.textContent.includes("All saved")) &&
        [...scrlR.querySelectorAll(".hub-wf-sect")].some((s) => s.textContent.includes("All saved")));
    check("WJ recents CSS: the group scrolls INSIDE its 30% cap (overflow-y added)",
        /\.hub-wf-list-recent\s*\{[^}]*max-height:\s*30%/.test(cssSrc) &&
        /\.hub-wf-list-recent\s*\{[^}]*overflow-y:\s*auto/.test(cssSrc));

    // 9b) the save-form Select all / Deselect all toggle
    wfStore.openWorkflows = [
        makeTab({ path: "workflows/a.json" }),
        makeTab({ path: "workflows/b.json", isModified: true }),
        makeTab({ name: "Sketch", isTemporary: true, isPersisted: false, nodes: [1] }),
    ];
    wfStore.activeWorkflow = wfStore.openWorkflows[0];
    await hooks.refreshOpen(true);
    hooks.openSaveForm("new");
    await settle();
    const formW = pnl().querySelector(".hub-wf-saveform");
    const togBtn = () => pnl().querySelector('.hub-wf-saveform [data-wf-btn="sftoggle"]');
    check("WJ sftoggle: the button exists (a row is unchecked -> 'Select all')",
        !!togBtn() && togBtn().textContent === "Select all", togBtn()?.textContent);
    togBtn().click();
    await settle();
    const checksW1 = [...pnl().querySelectorAll(".hub-wf-saveform [data-wf-check]")];
    check("WJ sftoggle: Select all checks EVERY row (temp included)",
        checksW1.length === 3 && checksW1.every((c) => c.checked),
        String(checksW1.map((c) => c.checked)));
    check("WJ sftoggle: the label flipped to 'Deselect all'",
        togBtn()?.textContent === "Deselect all", togBtn()?.textContent);
    check("WJ sftoggle: the state reached saveForm (collectFormItems sees 3 rows)",
        hooks.saveForm().rows.every((r) => r.checked));
    togBtn().click();
    await settle();
    const checksW2 = [...pnl().querySelectorAll(".hub-wf-saveform [data-wf-check]")];
    check("WJ sftoggle: Deselect all unchecks EVERY row",
        checksW2.length === 3 && checksW2.every((c) => !c.checked),
        String(checksW2.map((c) => c.checked)));
    check("WJ sftoggle: the label flipped back to 'Select all'",
        togBtn()?.textContent === "Select all", togBtn()?.textContent);
    const collEmpty = hooks.collectFormItems();
    check("WJ sftoggle: nothing checked -> collectFormItems returns no items",
        Array.isArray(collEmpty.items) && collEmpty.items.length === 0);
    // one manual check -> the label flips to Select all again (dynamic, not sticky)
    checksW2[0].checked = true;
    checksW2[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("WJ sftoggle: after one manual check the label is 'Select all' (not 'Deselect all')",
        togBtn()?.textContent === "Select all", togBtn()?.textContent);
    await pnl().querySelector('.hub-wf-saveform [data-wf-btn="cancelsave"]').click();
    await settle();

    // 9c) the Open-tab filter (name + path tokens, Esc clears)
    wfStore.openWorkflows = [
        makeTab({ path: "workflows/flux_main.json" }),
        makeTab({ path: "workflows/upscale.json" }),
        makeTab({ name: "Sketch", isTemporary: true, isPersisted: false, nodes: [1] }),
    ];
    wfStore.activeWorkflow = wfStore.openWorkflows[0];
    await hooks.refreshOpen(true);
    hooks.setTab("open");
    await settle();
    const openSearch = () => pnl().querySelector('.hub-wf-body [data-wf="opensearch"]');
    check("WJ opensearch: the field renders pinned ABOVE the rows",
        !!openSearch() && openSearch().closest(".hub-wf-toolbar") !== null);
    openSearch().value = "flux";
    openSearch().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    let openRowsW = [...pnl().querySelectorAll(".hub-wf-body .hub-wf-scroll .hub-wf-row")];
    check("WJ opensearch: 'flux' leaves only the flux row",
        openRowsW.length === 1 && openRowsW[0].textContent.includes("flux_main"),
        JSON.stringify(openRowsW.map((r) => r.textContent)));
    check("WJ opensearch: the status counts '1 of 3 open'",
        pnl().querySelector(".hub-wf-status").textContent.includes("1 of 3 open"));
    openSearch().value = "flux main";
    openSearch().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    openRowsW = [...pnl().querySelectorAll(".hub-wf-body .hub-wf-scroll .hub-wf-row")];
    check("WJ opensearch: multi-word tokens AND together (flux + main -> 1 row)",
        openRowsW.length === 1, String(openRowsW.length));
    openSearch().value = "nosuchtoken";
    openSearch().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WJ opensearch: an empty result shows the 'Nothing matches' placeholder",
        pnl().querySelector(".hub-wf-body .hub-wf-scroll .hub-wf-emptylist")?.textContent.includes("Nothing matches the filter"));
    openSearch().value = "temp";
    openSearch().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    openRowsW = [...pnl().querySelectorAll(".hub-wf-body .hub-wf-scroll .hub-wf-row")];
    check("WJ opensearch: a temp tab is reachable by its name too",
        openRowsW.length === 1 && openRowsW[0].textContent.includes("Sketch"),
        JSON.stringify(openRowsW.map((r) => r.textContent)));
    openSearch().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    openRowsW = [...pnl().querySelectorAll(".hub-wf-body .hub-wf-scroll .hub-wf-row")];
    check("WJ opensearch: Esc clears the filter (all 3 rows back)",
        openRowsW.length === 3 && pnl().querySelector('[data-wf="opensearch"]').value === "",
        String(openRowsW.length));

    // 9d) the grip-marker parity: stack + chat wear the workflows marker
    const wfGrip = /\.hub-wf-grip\s*\{[^}]*border-right:\s*2px solid/.test(cssSrc);
    const stackGrip = /\.hub-stack-grip\s*\{[^}]*border-right:\s*2px solid/.test(cssSrc) &&
        /\.hub-stack-grip:hover\s*\{[^}]*opacity:\s*1/.test(cssSrc);
    const chatGrip = /\.hub-chat-grip\s*\{[^}]*border-right:\s*2px solid/.test(cssSrc) &&
        /\.hub-chat-grip:hover\s*\{[^}]*opacity:\s*1/.test(cssSrc);
    check("WJ grips: the old gradient triangle is gone from stack/chat",
        !/\.hub-stack-grip\s*\{[^}]*linear-gradient/.test(cssSrc) &&
        !/\.hub-chat-grip\s*\{[^}]*linear-gradient/.test(cssSrc));
    check("WJ grips: stack/chat carry the wf marker (border corner + hover)",
        wfGrip && stackGrip && chatGrip);
    hooks.resetRecent();
}

// ===========================================================================

console.log(`\nworkflows smoke: PASS ${pass}  FAIL ${fail}`);
if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
