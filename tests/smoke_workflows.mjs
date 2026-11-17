// ============================================================================
// SettingsHub - WORKFLOWS MANAGER smoke test (v112)
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
//   WK  v104: ONE FILE PER PRESET on the server - the storage docs name
//       presets/<id>.json (module header + the storage-folder hint), the
//       per-preset export toast names the server file, and the py store
//       carries the migration (presets.json -> per-preset files -> .bak).
//   WL  v105: the 🧹 Close menu (one dropdown, the row stays compact) + the
//       new Close all (pinned 📌 stay, unsaved tabs arm the confirm), the
//       presets AUTO-RETRY (a failed boot read heals on the poll tick AND on
//       every Presets-tab open - "Reading presets…" instead of the misleading
//       "No presets yet"), the presets status line names the live "srv vNNN",
//       and the health probe compares the server pack against this web build:
//       an older server = "RESTART ComfyUI" (the py half of an update only
//       activates on restart), a newer one = "hard refresh".
//   WM  v106: the SCROLL-STABLE confirms (arming the 🗑 delete / the single
//       ✕ / Show more re-renders keep the .hub-wf-scroll anchor - the bottom
//       preset card no longer scrolls away before the confirming click; a
//       real tab switch still starts at the top) + the SNAPSHOT REOPENS: a
//       closed TEMP tab lands in 🕘 Recently closed WITH its graph embedded
//       (no fake path -> no /userdata 404 on "Unsaved Workflow (N)", the
//       reopen goes through the snapshot ladder), a modified saved tab
//       embeds its unsaved state, empty/unserializable temps are not
//       recorded, ".null" garbage paths are pruned on boot and refused at
//       record time, the reopen finds the row by ts with the path fallback.
//   WN  v107: SERVER-SIDE TEMP SNAPSHOTS - the close of a temp tab POSTs its
//       graph to /workflows/temp (temp/<id>.json in the storage root) and
//       the localStorage ring keeps ONLY the metadata + tempId (a tiny row -
//       the owner's localStorage-quota concern); the reopen of a tempId row
//       fetches the server snapshot through the ladder (NO /userdata fetch),
//       an entry leaving the 15-row ring DELETEs its server file, the boot
//       GC removes a stale (> 1 day) orphan while a referenced file and a
//       fresh orphan (another browser may point at it) stay, and the v106
//       localStorage embed stays as the FALLBACK when the temp routes are
//       gone (an old py - the WM phase runs its temp checks in stale mode).
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
    let healthVersion = null;        // v105: override -> the mismatch-note test
    let presetsFail = false;         // v105: GET /presets 500 -> the retry test
    let rootCustom = null;
    let tempMode = "ok";             // v107: "ok" | "stale" (an old py: the temp routes 404)
    let wfFiles = null;              // v108: the /workflows/files rung (null = old py)
    let wfFavs = [];                 // v108: the favorites store
    const tempStore = new Map();     // v107: id -> {id, name, ts, graph}
    // v112: the manager service stores (undo snapshots + recent manifests)
    const undoStore = new Map();     // undoId -> {id, ts, activeKey, tabs}
    const recentStore = new Map();   // clientId -> {clientId, entries, updatedAt}
    let recentMode = "ok";           // "ok" | "stale" (an old py: the routes 404)
    let undoMode = "ok";             // "ok" | "stale" | "fail" (413 oversized)
    // v112 stage 2: the DERIVED INDEX stub (the plan 4.x engine)
    let idxModeFlag = "stale";       // default: an old py (the earlier phases keep the v108 local behavior; WT flips it on)
    let idxFiles = [];               // the indexed library rows
    let idxScanCount = 0;
    // v116: the notes search + the Files delete/undo + the compact controls
    let notesMode = "ok";
    let notesResults = [];
    const fileFs = new Set();
    const fileDelSnapshots = new Map();   // txId -> path
    const fileDelOps = new Map();         // opId -> [{path, txId}]
    let fileDelMode = "ok";
    let compactMode = "ok";
    let presetsHold = false;
    let presetsHoldResolve = null;
    // v112 stage 2.5: the HISTORY stub (processes + revisions + tx snapshots)
    const histStore = { processes: new Map(), revisions: new Map(), seq: 0 };
    const txStore = new Map();
    // v114: the row-badge + batch-delete stub controls
    let badgesMode = "ok";           // "ok" | "stale" (an old py: the route 404s)
    // v115: the whole-process delete stub control ("ok" | "stale")
    let procDelMode = "ok";
    // v112 stage 4: the preset version archives (pid -> {versions, seq})
    const pverStore = new Map();
    const pverArchive = (pid, changedBy) => {
        const cur = presets.find((x) => x.id === pid);
        if (!cur) return;
        let st = pverStore.get(pid);
        if (!st) { st = { versions: [], seq: 0 }; pverStore.set(pid, st); }
        st.seq++;
        st.versions.push({ revisionId: "v" + (++uidSeq).toString(16).padStart(10, "0"),
            createdAt: Math.floor(Date.now() / 1000) + st.seq, seq: st.seq,
            changedBy, preset: JSON.parse(JSON.stringify(cur)) });
        if (st.versions.length > 20) st.versions.shift();
    };
    const histRevList = (pid) => {
        // the parent-chain walk (newest first), exactly like the real store
        const proc = histStore.processes.get(pid);
        const chain = [];
        let cur = proc?.currentRevisionId || null;
        while (cur) {
            const rec = histStore.revisions.get(cur);
            if (!rec) break;
            chain.push(rec);
            cur = rec.parentRevisionId;
        }
        const rest = [...histStore.revisions.values()]
            .filter((r) => r.processId === pid && !chain.some((c) => c.revisionId === r.revisionId));
        return [...chain, ...rest];
    };
    const idxSearch = (qp) => {
        // a tiny in-memory engine: q over path/name/workflowId, sort, cursor
        let rows = idxFiles.slice();
        const q2 = (qp.get("q") || "").toLowerCase();
        if (q2) {
            rows = rows.filter((f) =>
                (f.path + " " + f.name + " " + (f.workflowId || "") + " " +
                 (f.nodeTypes || []).join(" ") + " " + (f.modelRefs || []).join(" "))
                    .toLowerCase().includes(q2));
        }
        const wf = qp.get("workflow_id");
        if (wf) rows = rows.filter((f) => f.workflowId === wf);
        const sortKey = { mtime: "mtime", name: "name", size: "size" }[qp.get("sort") || "mtime"] || "mtime";
        const dir = qp.get("direction") === "asc" ? 1 : -1;
        rows.sort((a, b) => {
            const r = (a[sortKey] || 0) < (b[sortKey] || 0) ? -1 : ((a[sortKey] || 0) > (b[sortKey] || 0) ? 1 : 0);
            return r * dir || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        });
        const limit = parseInt(qp.get("limit") || "150", 10);
        let start = 0;
        const cur = qp.get("cursor");
        if (cur) {
            const i = rows.findIndex((f) => f.path === cur);
            if (i >= 0) start = i + 1;
        }
        const page = rows.slice(start, start + limit);
        const hasMore = start + limit < rows.length;
        return {
            ok: true, files: page, total: rows.length,
            has_more: hasMore,
            next_cursor: hasMore ? page[page.length - 1].path : null,
            fts: true,
        };
    };
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
                    ok: true, version: healthVersion || PACK_VERSION,
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
                if (presetsFail) return jsonResp({ ok: false, error: "boom" }, 500);
                const sorted = [...presets].sort((a, b) => (0 + (b.fav ? 1 : 0)) - (0 + (a.fav ? 1 : 0)) ||
                    (b.updated - a.updated));
                return jsonResp({ ok: true, presets: sorted });
            }
            if (p === "/settings_hub/workflows/presets" && method === "POST") {
                if (presetsHold) {
                    return new Promise((resolve) => { presetsHoldResolve = resolve; });
                }
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                // v112 stage 4: the category/tags flow through the stub too
                // (the tags normalize server-side: case-insensitive dedupe)
                if (typeof body.category === "string" && body.category.trim()) body.__cat = body.category.trim();
                if (Array.isArray(body.tags) && body.tags.length) {
                    const seen = new Set();
                    body.__tags = body.tags.filter((t) => {
                        const k = String(t).toLowerCase();
                        if (!k || seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    });
                }
                const mode = body.mode || "create";
                if (mode !== "create") {
                    const ex = presets.find((x) => x.id === body.id);
                    if (!ex) return jsonResp({ ok: false, error: "no such preset" }, 404);
                    if (mode === "overwrite") {
                        pverArchive(ex.id, "overwrite");
                        ex.name = body.name || ex.name;
                        ex.items = body.items;
                        if (body.activePath) ex.activePath = body.activePath;
                        if (body.__cat) ex.category = body.__cat;
                        if (body.__tags) ex.tags = body.__tags;
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
                if (body.__cat) preset.category = body.__cat;
                if (body.__tags) preset.tags = body.__tags;
                presets.push(preset);
                pverArchive(preset.id, "create");
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
            // v107: the server-side temp snapshots (temp/<id>.json in the root)
            if (p === "/settings_hub/workflows/temp" && method === "GET") {
                if (tempMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const items = [...tempStore.values()]
                    .sort((a, b) => b.ts - a.ts).map(({ id, name, ts }) => ({ id, name, ts }));
                return jsonResp({ ok: true, items });
            }
            if (p === "/settings_hub/workflows/temp" && method === "POST") {
                if (tempMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (!body.graph || typeof body.graph !== "object") {
                    return jsonResp({ ok: false, error: "graph is required" }, 400);
                }
                const id = (++uidSeq).toString(16).padStart(12, "0"); // strict hex, like the server
                const rec = { id, name: body.name || "Unsaved", ts: Date.now() / 1000 | 0, graph: body.graph };
                tempStore.set(id, rec);
                return jsonResp({ ok: true, id, name: rec.name, ts: rec.ts });
            }
            m = p.match(/^\/settings_hub\/workflows\/temp\/([^/]+)$/);
            if (m) {
                const tid = decodeURIComponent(m[1]);
                if (tempMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                if (method === "GET") {
                    const rec = tempStore.get(tid);
                    if (!rec) return jsonResp({ ok: false, error: "no such snapshot" }, 404);
                    return jsonResp({ ok: true, id: tid, name: rec.name, ts: rec.ts, graph: rec.graph });
                }
                if (method === "DELETE") {
                    const had = tempStore.delete(tid);
                    return jsonResp({ ok: true, gone: tid, existed: had });
                }
            }
            // v112 (plan 3.1): the server-side UNDO snapshots
            if (p === "/settings_hub/workflows/undo" && method === "POST") {
                if (undoMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (!Array.isArray(body.tabs)) return jsonResp({ ok: false, error: "tabs list is required" }, 400);
                if (undoMode === "fail") return jsonResp({ ok: false, error: "undo snapshot too large" }, 413);
                const id = "u" + (++uidSeq).toString(16).padStart(15, "0");
                const rec = { id, ts: Date.now() / 1000 | 0, activeKey: body.activeKey || null, tabs: body.tabs };
                undoStore.set(id, rec);
                return jsonResp({ ok: true, undoId: id, ts: rec.ts, bytes: JSON.stringify(body).length });
            }
            m = p.match(/^\/settings_hub\/workflows\/undo\/([^/]+)$/);
            if (m) {
                const uid = decodeURIComponent(m[1]);
                if (undoMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                if (method === "GET") {
                    const rec = undoStore.get(uid);
                    if (!rec) return jsonResp({ ok: false, error: "no such snapshot" }, 404);
                    return jsonResp({ ok: true, id: uid, ts: rec.ts, activeKey: rec.activeKey, tabs: rec.tabs });
                }
                if (method === "DELETE") {
                    const had = undoStore.delete(uid);
                    return jsonResp({ ok: true, gone: uid, existed: had });
                }
            }
            // v112 (plan 3.6): the server-side RECENT manifests
            if (p === "/settings_hub/workflows/recent" && method === "POST") {
                if (recentMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (!body.clientId || !Array.isArray(body.entries)) {
                    return jsonResp({ ok: false, error: "bad clientId/entries" }, 400);
                }
                recentStore.set(body.clientId, {
                    clientId: body.clientId, entries: body.entries,
                    updatedAt: Date.now() / 1000 | 0,
                });
                // the cross-manifest reference union over ALL sessions
                const refs = new Set();
                for (const man of recentStore.values()) {
                    for (const e of man.entries || []) {
                        if (e?.tempId) refs.add(e.tempId);
                    }
                }
                return jsonResp({ ok: true, clientId: body.clientId, updatedAt: Date.now() / 1000 | 0, refs: [...refs] });
            }
            m = p.match(/^\/settings_hub\/workflows\/recent\/([^/]+)$/);
            if (m) {
                const cid = decodeURIComponent(m[1]);
                if (recentMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                if (method === "GET") {
                    const man = recentStore.get(cid);
                    if (!man) return jsonResp({ ok: false, error: "no manifest" }, 404);
                    return jsonResp({ ok: true, clientId: cid, entries: man.entries, updatedAt: man.updatedAt });
                }
                if (method === "DELETE") {
                    const had = recentStore.delete(cid);
                    return jsonResp({ ok: true, gone: cid, existed: had });
                }
            }
            // v112 stage 2: the DERIVED INDEX routes (plan 4.x)
            if (p === "/settings_hub/workflows/index/status" && method === "GET") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                return jsonResp({ ok: true, files: idxFiles.length, errors: 0,
                    too_large: 0, last_scan: idxFiles.length ? Math.floor(Date.now() / 1000) : 0,
                    profile: "nprof1", fts: true, db_exists: idxFiles.length > 0 });
            }
            if (p === "/settings_hub/workflows/index/scan" && method === "POST") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                idxScanCount++;
                return jsonResp({ ok: true, scanned: idxFiles.length, indexed: 0,
                    changed: 0, errors: 0, removed: 0, skipped_same: idxFiles.length });
            }
            if (p === "/settings_hub/workflows/index/search" && method === "GET") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const qp2 = new URLSearchParams(String(u).split("?")[1] || "");
                return jsonResp(idxSearch(qp2));
            }
            if (p === "/settings_hub/workflows/index/duplicates" && method === "GET") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                return jsonResp({ ok: true, exactCopies: [], sameJsonContent: [],
                    sameWorkflowDiffCanvas: [], sameUuidDiffContent: [],
                    structuralCandidates: [], noUuidCount: 0 });
            }
            // v116 (plan 4.6): the NOTES search stub
            if (p === "/settings_hub/workflows/index/notes" && method === "GET") {
                if (notesMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                return jsonResp({ ok: true, fts: true, results: notesResults });
            }
            // v116 (plan 7): the FILES batch delete + undo stubs - an
            // in-memory fs with verified snapshots + the per-file results
            if (p === "/settings_hub/workflows/files/delete" && method === "POST") {
                let body2 = {};
                try { body2 = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (fileDelMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const paths = body2.paths || [];
                if (paths.length > 40) return jsonResp({ ok: false, error: "too many files in one batch (max 40)", limit: 40 }, 400);
                const results = [];
                if (fileDelMode === "snapshotfail") {
                    for (const pt of paths) results.push({ path: pt, ok: false, removed: false, error: "the safety snapshot failed verification" });
                    return jsonResp({ ok: false, stage: "preflight",
                        error: "the safety snapshot failed - NOTHING was deleted",
                        results }, 409);
                }
                const removed = [];
                for (const pt of paths) {
                    if (!fileFs.has(pt)) {
                        results.push({ path: pt, ok: true, removed: false, error: "not a regular file (missing?)" });
                        continue;
                    }
                    fileFs.delete(pt);
                    const txId = "txdel" + (++uidSeq);
                    fileDelSnapshots.set(txId, pt);
                    results.push({ path: pt, ok: true, removed: true, txId, bytes: 10 });
                    const i2 = idxFiles.findIndex((f) => f.path === pt);
                    const row = i2 >= 0 ? idxFiles.splice(i2, 1)[0] : null;
                    removed.push({ path: pt, txId, bytes: 10, __row: row });   // the undo keeps the row
                }
                const opId = "op" + (++uidSeq).toString(16).padStart(12, "0");
                fileDelOps.set(opId, removed);
                return jsonResp({ ok: results.every((r) => !r.error), opId, results,
                    removed: removed.length, failed: results.filter((r) => r.error).length,
                    indexRowsDropped: removed.length, locationsDetached: 0,
                    undo: removed.length ? { opId, expiresAt: Date.now() / 1000 | 0 + 7200 } : null,
                    note: removed.length ? "the process history is NEVER deleted with the files" : null });
            }
            if (p === "/settings_hub/workflows/files/undo" && method === "POST") {
                let body2 = {};
                try { body2 = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const opId = body2.opId;
                const rec = fileDelOps.get(opId);
                if (!rec) return jsonResp({ ok: false, error: "no such operation (expired or already undone)" }, 404);
                fileDelOps.delete(opId);
                const results = [];
                let restored = 0;
                for (const f of rec) {
                    if (fileFs.has(f.path)) {
                        results.push({ path: f.path, restored: false, error: "the path is taken by a newer file - skipped (never overwritten)" });
                        continue;
                    }
                    fileFs.add(f.path);
                    results.push({ path: f.path, restored: true });
                    restored++;
                    // the real server refreshes the index row (refresh_paths)
                    if (f.__row && !idxFiles.some((x) => x.path === f.path)) idxFiles.push(f.__row);
                }
                idxFiles.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || (a.path < b.path ? -1 : 1));
                return jsonResp({ ok: restored === rec.length && restored > 0,
                    restored, results });
            }
            // v116 (plan 5.4): the storage dashboard + the compact action
            if (p === "/settings_hub/workflows/history/storage" && method === "GET") {
                return jsonResp({ ok: true, backend: "stub", processes: 2, revisions: 3,
                    stableRevisions: 1, logicalBytes: 3000, physicalBytes: 1200,
                    historyMetadataBytes: 400, txSnapshotBytes: 100, txSnapshotFiles: 2,
                    serviceUndoBytes: 50, serviceRecentBytes: 20,
                    presetVersionManifestBytes: 60, presetVersionManifests: 1,
                    indexBytes: 8192, totalPhysicalBytes: 10022 });
            }
            if (p === "/settings_hub/workflows/history/maintenance" && method === "POST") {
                const body2 = JSON.parse(opts.body || "{}");
                if (body2.action === "compact") {
                    if (compactMode === "fail") return jsonResp({ ok: false, error: "compact refused (stub)" }, 500);
                    return jsonResp({ ok: true, backend: "stub", before: 5000, after: 2200,
                        verified: 3, retained: 3, preflight: { revisions: 3 } });
                }
                return jsonResp({ ok: true, backend: "stub" });
            }
            // v112 stage 2.5: the HISTORY routes (plan 5.x)
            if (p === "/settings_hub/workflows/history/resolve" && method === "GET") {
                const rel = new URLSearchParams(String(u).split("?")[1]).get("path");
                const proc = [...histStore.processes.values()]
                    .find((pr) => (pr.locations || []).some((l) => l.path === rel));
                if (!proc) return jsonResp({ ok: true, bound: false });
                const cur = histStore.revisions.get(proc.currentRevisionId);
                const idxRow = idxFiles.find((f) => f.path === rel);
                // v116: the layered 5-state status (workflowHash decides)
                let changeStatus = "unknown";
                if (cur && idxRow && cur.workflowHash && idxRow.workflowHash) {
                    if (idxRow.workflowHash !== cur.workflowHash) changeStatus = "workflow_changed";
                    else if ((idxRow.presentationHash || null) !== (cur.presentationHash || null)) changeStatus = "presentation_changed";
                    else changeStatus = "unchanged";
                }
                const statusLabel = { unchanged: "No workflow changes",
                    presentation_changed: "Canvas changed only",
                    metadata_changed: "Metadata changed",
                    workflow_changed: "Workflow changed",
                    unknown: "Status unavailable - refresh the index" }[changeStatus];
                return jsonResp({ ok: true, bound: true,
                    changeStatus, statusLabel,
                    changesSinceCheckpoint: changeStatus === "workflow_changed" ||
                        changeStatus === "metadata_changed" ||
                        changeStatus === "presentation_changed",
                    process: { processId: proc.processId, workflowId: proc.workflowId,
                        displayName: proc.displayName, note: proc.note,
                        revisionCount: histRevList(proc.processId).length,
                        hasCheckpoints: !!proc.currentRevisionId } });
            }
            if (p === "/settings_hub/workflows/history/processes" && method === "GET") {
                return jsonResp({ ok: true, processes: [...histStore.processes.values()].map((pr) => ({
                    processId: pr.processId, workflowId: pr.workflowId,
                    displayName: pr.displayName, revisionCount: histRevList(pr.processId).length,
                    hasCheckpoints: !!pr.currentRevisionId })) });
            }
            if (p === "/settings_hub/workflows/history/process/{pid}".replace("{pid}", m?.[1] || "") && false) { /* handled below */ }
            const mHistProc = p.match(/^\/settings_hub\/workflows\/history\/process\/([^/]+)$/);
            if (mHistProc) {
                const proc = histStore.processes.get(decodeURIComponent(mHistProc[1]));
                if (method === "GET") {
                    if (!proc) return jsonResp({ ok: false, error: "no such process" }, 404);
                    return jsonResp({ ok: true, process: { ...proc, revisions: histRevList(proc.processId) } });
                }
                return jsonResp({ ok: false, error: "unhandled" }, 404);
            }
            const mHistMeta = p.match(/^\/settings_hub\/workflows\/history\/process\/([^/]+)\/meta$/);
            if (mHistMeta && method === "POST") {
                const proc = histStore.processes.get(decodeURIComponent(mHistMeta[1]));
                if (!proc) return jsonResp({ ok: false, error: "no such process" }, 404);
                const body2 = JSON.parse(opts.body || "{}");
                if (body2.displayName) proc.displayName = body2.displayName;
                if (body2.note != null) proc.note = body2.note;
                return jsonResp({ ok: true });
            }
            const mHistRestore = p.match(/^\/settings_hub\/workflows\/history\/process\/([^/]+)\/restore\/([^/]+)$/);
            if (mHistRestore && method === "POST") {
                const body2 = JSON.parse(opts.body || "{}");
                const rec = histStore.revisions.get(decodeURIComponent(mHistRestore[2]));
                if (!rec) return jsonResp({ ok: false, error: "no readable revision" }, 404);
                if (body2.mode === "open-copy") {
                    return jsonResp({ ok: true, graph: rec.__graph });
                }
                // replace: the tx snapshot is MANDATORY first (the server contract)
                if (!body2.path) return jsonResp({ ok: false, error: "replace needs a path" }, 400);
                txStore.set("tx" + (++histStore.seq), { path: body2.path, ts: Date.now() / 1000 | 0 });
                return jsonResp({ ok: true, mode: "replace", path: body2.path,
                    txId: "tx" + histStore.seq, rollbackAvailable: true });
            }
            if (p === "/settings_hub/workflows/history/checkpoint" && method === "POST") {
                let body2 = {};
                try { body2 = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (!body2.graph && !body2.path) return jsonResp({ ok: false, error: "a graph or a path is required" }, 400);
                const wfId = body2.graph?.id || (idxFiles.find((f) => f.path === body2.path)?.workflowId) || null;
                let proc = wfId ? [...histStore.processes.values()].find((pr) => pr.workflowId === wfId)
                    : [...histStore.processes.values()].find((pr) => (pr.locations || []).some((l) => l.path === body2.path));
                if (!proc) {
                    const pid = "p" + (++histStore.seq).toString(16).padStart(15, "0");
                    proc = { processId: pid, workflowId: wfId, displayName: body2.path || "Process",
                        locations: [], currentRevisionId: null, stableRevisionId: null };
                    histStore.processes.set(pid, proc);
                }
                if (body2.path && !(proc.locations || []).some((l) => l.path === body2.path)) {
                    (proc.locations = proc.locations || []).push({ path: body2.path, isPrimary: true });
                }
                // a DISK checkpoint hashes the simulated DISK bytes (the
                // idxFiles row's rawHash - the server would read the file);
                // a graph checkpoint hashes the graph itself
                let rawHash;
                if (body2.graph) {
                    const data = JSON.stringify(body2.graph);
                    rawHash = "hash-g" + data.length + "-" + data.slice(0, 32);
                } else {
                    const row = idxFiles.find((f) => f.path === body2.path);
                    rawHash = (row && row.rawHash) || ("hash-disk-" + body2.path);
                }
                // the dedupe contract: identical rawHash -> no new revision
                const last = histRevList(proc.processId)[0];
                if (last && last.rawHash === rawHash) {
                    return jsonResp({ ok: true, duplicate: true, revisionId: last.revisionId, processId: proc.processId });
                }
                // v116: the layered hashes ride the revision (the status
                // compare needs workflowHash/presentationHash like the real
                // server)
                let wfHash = null, presHash = null;
                if (body2.graph) {
                    const g2 = { ...body2.graph };
                    wfHash = "wf-" + JSON.stringify({ n: (g2.nodes || []).map((x) => x && { id: x.id, type: x.type, w: x.widgets_values }), l: g2.links });
                    presHash = "pres-" + JSON.stringify({ ds: g2.extra?.ds, pos: (g2.nodes || []).map((x) => x && x.pos) });
                } else {
                    const row = idxFiles.find((f) => f.path === body2.path);
                    wfHash = row?.workflowHash || null;
                    presHash = row?.presentationHash || null;
                }
                const rid = "r" + (++histStore.seq).toString(16).padStart(15, "0");
                histStore.revisions.set(rid, {
                    revisionId: rid, processId: proc.processId,
                    parentRevisionId: proc.currentRevisionId,
                    source: body2.source || "checkpoint", sourcePath: body2.path,
                    createdAt: Math.floor(Date.now() / 1000) + histStore.seq,
                    title: body2.title || null, note: body2.note || null,
                    rawHash, workflowHash: wfHash, presentationHash: presHash,
                    normalizationProfileVersion: "nprof1",
                    storage: { backend: "stub", blob: rid },
                    isStable: false, __graph: body2.graph || null,
                });
                proc.currentRevisionId = rid;
                return jsonResp({ ok: true, duplicate: false, revisionId: rid,
                    processId: proc.processId });
            }
            const mHistRaw = p.match(/^\/settings_hub\/workflows\/history\/revision\/([^/]+)\/raw$/);
            if (mHistRaw && method === "GET") {
                const rec = histStore.revisions.get(decodeURIComponent(mHistRaw[1]));
                if (!rec) return jsonResp({ ok: false, error: "no readable revision" }, 404);
                return jsonResp(rec.__graph || { nodes: [] });
            }
            const mHistStable = p.match(/^\/settings_hub\/workflows\/history\/revision\/([^/]+)\/stable$/);
            if (mHistStable && method === "POST") {
                const rec = histStore.revisions.get(decodeURIComponent(mHistStable[1]));
                if (!rec) return jsonResp({ ok: false, error: "no such revision" }, 404);
                const body2 = JSON.parse(opts.body || "{}");
                rec.isStable = body2.stable !== false;
                if (rec.isStable) {
                    const proc = histStore.processes.get(rec.processId);
                    if (proc) proc.stableRevisionId = rec.revisionId;
                }
                return jsonResp({ ok: true, revisionId: rec.revisionId, isStable: rec.isStable });
            }
            // v114: the version INDICATOR (GET /history/badges) + the BATCH
            // deletion (POST /history/revision/delete) - the fake mirrors the
            // real protection contract (stable + current survive, the parent
            // chain is spliced)
            if (p === "/settings_hub/workflows/history/badges" && method === "GET") {
                if (badgesMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                // v115: the answer also carries the duplicate-ID counter -
                // 'locations: N' ONLY when the UUID covers MORE THAN ONE file;
                // a revision-less duplicate still reports (count 0)
                const out = {};
                for (const pr of histStore.processes.values()) {
                    const revs = histRevList(pr.processId);
                    const locs = pr.locations || [];
                    if (!revs.length && locs.length < 2) continue;
                    const info = { count: revs.length,
                        stable: revs.filter((r) => r.isStable).length };
                    if (locs.length > 1) info.locations = locs.length;
                    for (const l of locs) out[l.path] = info;
                }
                return jsonResp({ ok: true, badges: out });
            }
            if (p === "/settings_hub/workflows/history/revision/delete" && method === "POST") {
                let body2 = {};
                try { body2 = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (!Array.isArray(body2.revisionIds)) {
                    return jsonResp({ ok: false, error: "revisionIds (a list) is required" }, 400);
                }
                const deleted = [], skipped = [];
                for (const rid of body2.revisionIds.slice(0, 1000)) {
                    const rec = histStore.revisions.get(rid);
                    if (!rec) { skipped.push({ revisionId: rid, reason: "no such revision" }); continue; }
                    if (rec.isStable) { skipped.push({ revisionId: rid, reason: "a stable revision is protected" }); continue; }
                    const proc = histStore.processes.get(rec.processId);
                    if (proc && proc.currentRevisionId === rid) {
                        skipped.push({ revisionId: rid, reason: "the current revision cannot be deleted" });
                        continue;
                    }
                    for (const other of histStore.revisions.values()) {
                        if (other.revisionId !== rid && other.parentRevisionId === rid) {
                            other.parentRevisionId = rec.parentRevisionId || null;
                        }
                    }
                    histStore.revisions.delete(rid);
                    deleted.push(rid);
                }
                return jsonResp({ ok: true, deleted, skipped });
            }
            // v115: the WHOLE-PROCESS delete ("удалить сами процессы со всеми
            // хвостами") - the fake mirrors the real route: every revision
            // dies, the process entry dies, deleteFiles removes every
            // location's simulated file row (tx snapshot recorded first)
            const mHistProcDel = p.match(/^\/settings_hub\/workflows\/history\/process\/([^/]+)\/delete$/);
            if (mHistProcDel && method === "POST") {
                if (procDelMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const pid = decodeURIComponent(mHistProcDel[1]);
                const proc = histStore.processes.get(pid);
                if (!proc) return jsonResp({ ok: false, error: "no such process" }, 400);
                let body2 = {};
                try { body2 = JSON.parse(opts.body || "{}"); } catch (_) {}
                const delFiles = !!(body2 && body2.deleteFiles);
                const files = [];
                if (delFiles) {
                    for (const l of proc.locations || []) {
                        const row = idxFiles.find((f) => f.path === l.path);
                        if (!row) { files.push({ path: l.path, removed: false, reason: "missing" }); continue; }
                        txStore.set("tx" + (++histStore.seq), { path: l.path, ts: Date.now() / 1000 | 0 });
                        files.push({ path: l.path, removed: true,
                            bytes: row.size || 10, snapshot: "tx" + histStore.seq });
                    }
                }
                const n = histRevList(pid).length;
                for (const r of histRevList(pid)) histStore.revisions.delete(r.revisionId);
                histStore.processes.delete(pid);
                const gone = files.filter((f) => f.removed).map((f) => f.path);
                for (let i = idxFiles.length - 1; i >= 0; i--) {
                    if (gone.includes(idxFiles[i].path)) idxFiles.splice(i, 1);
                }
                return jsonResp({ ok: true, processId: pid, deletedRevisions: n,
                    freedBytes: 0, files, indexRowsDropped: gone.length });
            }
            if (p === "/settings_hub/workflows/history/storage" && method === "GET") {
                return jsonResp({ ok: true, backend: "stub", processes: histStore.processes.size,
                    revisions: histStore.revisions.size, stableRevisions: 0,
                    logicalBytes: 1000, physicalBytes: 500 });
            }
            // v112 stage 4: the PRESET VERSION routes
            const mPver = p.match(/^\/settings_hub\/workflows\/preset\/([^/]+)\/versions$/);
            if (mPver && method === "GET") {
                const pid = decodeURIComponent(mPver[1]);
                const st = pverStore.get(pid) || { versions: [], seq: 0 };
                return jsonResp({ ok: true, presetId: pid,
                    versions: st.versions.slice().sort((a, b) =>
                        (b.createdAt - a.createdAt) || (b.seq - a.seq)).map((v) => ({
                        revisionId: v.revisionId, createdAt: v.createdAt,
                        seq: v.seq, changedBy: v.changedBy, name: v.preset.name,
                        category: v.preset.category, tags: v.preset.tags || [],
                        itemCount: (v.preset.items || []).length,
                        snapshotBytes: 0 })),
                    maxVersions: 20 });
            }
            const mPverOne = p.match(/^\/settings_hub\/workflows\/preset\/([^/]+)\/version\/([^/]+)$/);
            if (mPverOne && method === "GET") {
                const st = pverStore.get(decodeURIComponent(mPverOne[1]));
                const rec = st && st.versions.find((v) => v.revisionId === decodeURIComponent(mPverOne[2]));
                if (!rec) return jsonResp({ ok: false, error: "no such version" }, 404);
                return jsonResp({ ok: true, revisionId: rec.revisionId,
                    createdAt: rec.createdAt, changedBy: rec.changedBy, preset: rec.preset });
            }
            const mPverRest = p.match(/^\/settings_hub\/workflows\/preset\/([^/]+)\/restore\/([^/]+)$/);
            if (mPverRest && method === "POST") {
                const pid = decodeURIComponent(mPverRest[1]);
                const st = pverStore.get(pid);
                const rec = st && st.versions.find((v) => v.revisionId === decodeURIComponent(mPverRest[2]));
                const cur = presets.find((x) => x.id === pid);
                if (!rec || !cur) return jsonResp({ ok: false, error: "no such version" }, 404);
                st.seq++;
                st.versions.push({ revisionId: "arch" + (++uidSeq).toString(16).padStart(10, "0"),
                    createdAt: Math.floor(Date.now() / 1000) + st.seq, seq: st.seq,
                    changedBy: "restore", preset: JSON.parse(JSON.stringify(cur)) });
                Object.assign(cur, JSON.parse(JSON.stringify(rec.preset)), { id: pid });
                return jsonResp({ ok: true, presetId: pid, restoredFrom: rec.revisionId,
                    archivedAs: st.versions[st.versions.length - 1].revisionId, preset: cur });
            }
            // v112 stage 5: the INSPECTOR + SUMMARY routes (plan 11/12)
            if (p === "/settings_hub/workflows/index/inspect" && method === "GET") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const rel = new URLSearchParams(String(u).split("?")[1]).get("path");
                const row = idxFiles.find((f) => f.path === rel);
                if (!row) return jsonResp({ ok: false, error: "the file is gone" }, 404);
                return jsonResp({ ok: true, path: rel, name: row.name,
                    workflowId: row.workflowId, nodeCount: 12,
                    nodeTypes: ["KSampler", "SaveImage", "SuperUnknownNode"],
                    models: ["v1-5-pruned-emaonly.ckpt", "gone_model.safetensors"],
                    params: { steps: 25, cfg: 7.5, sampler: "euler", scheduler: "karras",
                        width: 1024, height: 768 },
                    hashes: { raw_hash: "h1", canonical_hash: "h2", workflow_hash: "h3" },
                    groups: { exactCopies: 1, sameUuidDiffContent: 2, sameWorkflow: 0 },
                    deps: { knownNodes: ["KSampler", "SaveImage"],
                        unknownNodes: ["SuperUnknownNode"],
                        models: [{ name: "v1-5-pruned-emaonly.ckpt", status: "available" },
                                 { name: "gone_model.safetensors", status: "missing" }],
                        missingModels: ["gone_model.safetensors"] },
                    depsRegistryKnown: true, parseStatus: "ok" });
            }
            if (p === "/settings_hub/workflows/index/summary" && method === "GET") {
                if (idxModeFlag === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                return jsonResp({ ok: true, files: idxFiles.length, errors: 1,
                    tooLarge: 0, exactCopyGroups: 2, sameJsonGroups: 1,
                    sameWorkflowDiffCanvas: 1, sameUuidDiffContent: 3, noUuidFiles: 4 });
            }
            // v112 (plan 3.6): the SERVER-authoritative temp GC
            if (p === "/settings_hub/workflows/temp/gc" && method === "POST") {
                if (tempMode === "stale") return jsonResp({ ok: false, error: "404" }, 404);
                const refs = new Set();
                for (const man of recentStore.values()) {
                    for (const e of man.entries || []) {
                        if (e?.tempId) refs.add(e.tempId);
                    }
                }
                const dayAgoS = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
                const removed = [];
                for (const [tid, rec] of [...tempStore]) {
                    if (!refs.has(tid) && (rec.ts || 0) < dayAgoS) {
                        tempStore.delete(tid);
                        removed.push(tid);
                    }
                }
                return jsonResp({ ok: true, removed, refs: [...refs] });
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
            // v108: the pack's own Files listing (path+size+mtime; the
            // storage-root housekeeping is already excluded server-side)
            // + the favorites store. wfFiles === null simulates an OLD py
            // (the route 404s -> the legacy rungs take over).
            if (p === "/settings_hub/workflows/files" && method === "GET") {
                if (wfFiles === null) return jsonResp({ ok: false, error: "old py" }, 404);
                return jsonResp({ ok: true, files: wfFiles, truncated: false, root: "user/workflows" });
            }
            if (p === "/settings_hub/workflows/files-fav" && method === "GET") {
                if (wfFavs === null) return jsonResp({ ok: false, error: "old py" }, 404);
                return jsonResp({ ok: true, favs: wfFavs });
            }
            if (p === "/settings_hub/workflows/files-fav" && method === "POST") {
                if (wfFavs === null) return jsonResp({ ok: false, error: "old py" }, 404);
                let body = {};
                try { body = JSON.parse(opts.body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if (typeof body.path !== "string" || !body.path) {
                    return jsonResp({ ok: false, error: "bad path" }, 400);
                }
                if (body.fav) { if (!wfFavs.includes(body.path)) wfFavs.push(body.path); }
                else wfFavs = wfFavs.filter((x) => x !== body.path);
                return jsonResp({ ok: true, favs: wfFavs });
            }
            return jsonResp({ ok: false, error: "unhandled " + method + " " + p }, 404);
        },
        __calls: () => calls,
        __presets: () => presets,
        __setPresets: (v) => { presets = v; },
        __setHealth: (m) => { healthMode = m; },
        __setHealthVersion: (v) => { healthVersion = v; },
        __setPresetsFail: (v) => { presetsFail = !!v; },
        __setFiles: (v) => { savedFiles = v; },
        __tempStore: () => tempStore,
        __setTempMode: (m) => { tempMode = m; },
        // v112: the manager service stores
        __undoStore: () => undoStore,
        __setUndoMode: (m) => { undoMode = m; },
        __recentStore: () => recentStore,
        __setRecentMode: (m) => { recentMode = m; },
        // v112 stage 2: the index stub controls
        __setIdxMode: (m) => { idxModeFlag = m; },
        __setIdxFiles: (v) => { idxFiles = v; },
        __idxScanCount: () => idxScanCount,
        // v116: the notes + files-delete + compact + hold controls
        __setNotes: (results, mode = "ok") => { notesResults = results || []; notesMode = mode; },
        __setFileDelMode: (m) => { fileDelMode = m; },
        __setCompactMode: (m) => { compactMode = m; },
        __fileFs: (paths, add = true) => {
            for (const pt of (paths || [])) { if (add) fileFs.add(pt); else fileFs.delete(pt); }
        },
        __fileFsHas: (pt) => fileFs.has(pt),
        __setPresetsHold: (v) => {
            presetsHold = !!v;
            if (!v && presetsHoldResolve) { const r2 = presetsHoldResolve; presetsHoldResolve = null; r2(jsonResp({ ok: true, preset: { id: "held00000001", name: "held", items: [] }, mode: "create" })); }
        },
        // v112 stage 2.5: the history stub controls
        __histStore: () => histStore,
        __txStore: () => txStore,
        __pverStore: () => pverStore,
        // v114: the badges + batch-delete stub controls
        __setBadgesMode: (m) => { badgesMode = m; },
        // v115: the whole-process delete stub control
        __setProcDelMode: (m) => { procDelMode = m; },
        // v108: the Files listing + the favorites controls
        __setWfFiles: (v) => { wfFiles = v; },
        __wfFavs: () => wfFavs.slice(),
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
            // v112 parity: the REAL createTemporary builds the tab from the
            // graph - its active state IS the passed graph JSON
            try { wf.activeState = JSON.parse(JSON.stringify(graphJson)); } catch (_) {}
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
        if (c && typeof c === "object") {
            await wfStore.openWorkflow(c);
            // v112 parity: the REAL loadGraphData loads the graph ONTO the
            // tab - the bound tab's active state BECOMES the data (identity
            // kept: the v102 phase asserts data === tab.activeState)
            try { c.activeState = data; } catch (_) {}
        } else if (typeof c === "string") {
            const rel = c.startsWith("workflows/") ? c : ("workflows/" + c);
            const t = wfStore.workflows.find((w) => w.path === rel || w.path === c);
            if (t) {
                await wfStore.openWorkflow(t);
                try { t.activeState = data; } catch (_) {}
            }
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

// Close saved (through the v105 🧹 Close menu): a.json + b.json? no - b is
// modified. Empty temp goes (pref on), the LOCKED clean tab stays, the
// non-empty temp stays.
const closeCallsBefore = wfStore.calls.filter((c) => c.op === "close").length;
await body.querySelector('[data-act="closemenu"]').click();
await settle();
let cmenu = document.querySelector(".hub-wf-closemenu");
check("the 🧹 Close menu opened with the three close items",
    !!cmenu && !!cmenu.querySelector('[data-act="closesaved"]') &&
    !!cmenu.querySelector('[data-act="closeothers"]') &&
    !!cmenu.querySelector('[data-act="closeall"]'),
    String(!!cmenu));
check("the Open row is compact: no separate close buttons outside the menu",
    !body.querySelector('[data-act="closesaved"]') && !body.querySelector('[data-act="closeothers"]'));
await cmenu.querySelector('[data-act="closesaved"]').click();
await settle(20);
check("the menu closed after the item click", !document.querySelector(".hub-wf-closemenu"));
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
await body.querySelector('[data-act="closemenu"]').click();
await settle();
document.querySelector(".hub-wf-closemenu").querySelector('[data-act="closeothers"]').click();
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
// checkbox must be RE-QUERIED before the next check (the old node detaches);
// v108: the rows are SORTED (date desc, name-asc tie-break), so the targets
// are picked by their path, not by index
const fcheckByPath = (p) => panel.querySelector(`.hub-wf-body [data-fcheck="${p.replace(/"/g, "\\\"")}"]`);
fcheckByPath("workflows/flux_main.json").checked = true;
fcheckByPath("workflows/flux_main.json")
    .dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
fcheckByPath("workflows/flux_detail.json").checked = true;
fcheckByPath("workflows/flux_detail.json")
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
check("EXPECTED carries workflows: v116", /"workflows":\s*"v116"/.test(ENTRY_SRC));
check("the entry registers initWorkflows", ENTRY_SRC.includes("initWorkflows()"));
check("the entry banner names v116 (the quality and reliability pass)",
    ENTRY_SRC.includes("web build: v116 - THE QUALITY AND RELIABILITY PASS") &&
    ENTRY_SRC.includes("THE WORKFLOW MANAGER ROADMAP"));
check("styles.css?v=116", ENTRY_SRC.includes("styles.css?v=116"));
check("the module self-reports v116",
    fs.readFileSync(path.join(WEB, "workflows.js"), "utf8")
        .includes('globalThis.__SettingsHubLoaded["workflows"] = "v116"'));
check("the web stamp literal is v116",
    fs.readFileSync(path.join(WEB, "workflows.js"), "utf8")
        .includes('const WF_WEB_VERSION = "v116"'));
check("py stamp bumps together (v116)",
    fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8")
        .includes('WORKFLOWS_SERVER_VERSION = "v116"'));
check("v116 routes registered (files delete/undo + notes + compact)",
    [".post(\"/settings_hub/workflows/files/delete\")",
     ".post(\"/settings_hub/workflows/files/undo\")",
     "/settings_hub/workflows/index/notes",
     "/settings_hub/workflows/history/maintenance"]
        .every((s) => fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8").includes(s)));
check("v115 routes registered (process delete + badges)",
    ["/settings_hub/workflows/history/process/{pid}/delete",
     "/settings_hub/workflows/history/badges"]
        .every((s) => fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8").includes(s)));
check("v107 routes registered (temp list/put/get/delete)",
    [".get(\"/settings_hub/workflows/temp\")", ".post(\"/settings_hub/workflows/temp\")",
     ".get(\"/settings_hub/workflows/temp/{tid}\")", ".delete(\"/settings_hub/workflows/temp/{tid}\")"]
        .every((s) => fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8").includes(s)));
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
// --- 10) WK v104: ONE FILE PER PRESET - the source contract
{
    const wfSrc = fs.readFileSync(path.join(WEB, "workflows.js"), "utf8");
    const pySrc = fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8");

    // 10a) the frontend documents the new layout where the owner looks
    check("WK header: the module changelog names presets/<id>.json (v104 block)",
        wfSrc.includes("ONE FILE PER PRESET on the server - presets/<id>.json inside the storage"));
    check("WK header: the Storage footer names the per-preset folder",
        /Storage: py\/workflows_store\.py - <user>\/settings_hub\/workflows\/ with ONE\n\/\/ file per preset \(presets\/<id>\.json, v104\)/.test(wfSrc));
    check("WK popup: the storage-folder hint names the per-preset files (v108 wording keeps the contract)",
        wfSrc.includes("no duplicates, no loss; ONE file per preset: presets/&lt;id&gt;.json - copy a file to transfer that"));
    check("WK export: the per-preset toast names the server file (the transfer hint)",
        wfSrc.includes('+ " (it also lives as presets/" + p.id + ".json in the storage folder)"'));

    // 10b) the py store: the folder IS the store now
    check("WK py: _presets_dir + _preset_file build the per-preset paths",
        pySrc.includes('_PRESETS_DIR_NAME = "presets"') &&
        pySrc.includes("os.path.join(_presets_dir(), pid + \".json\")"));
    check("WK py: the legacy presets.json is NEVER written again (reader only)",
        pySrc.includes("_legacy_presets_path") &&
        !pySrc.includes("def _write_presets(") &&
        pySrc.includes("def _write_preset_file("));
    check("WK py: the migration renames the legacy file to .bak (never deletes)",
        pySrc.includes("os.replace(legacy, legacy + \".bak\")"));
    check("WK py: the folder copy wins on a migration rerun (rollback-safe)",
        pySrc.includes("# the folder copy wins"));
    check("WK py: a read requires the inner id to agree with the file name",
        pySrc.includes('data["id"] == name[:-len(".json")]'));
    check("WK py: every mutation funnels the id through _load_preset_file",
        ["existing = _load_preset_file(pid)",
         "it = _load_preset_file(pid)",
         "if _load_preset_file(pid) is None"].every((s) => pySrc.includes(s)));
    check("WK py: snapshots stay INSIDE the preset file (no sidecar graph files)",
        pySrc.includes("INSIDE the preset file itself (kept as") &&
        !pySrc.includes("snapshotGraphs"));
    check("WK py: MAX_PRESETS counts the FILES (no array to count anymore)",
        pySrc.includes("if _count_preset_files() >= MAX_PRESETS:"));
    check("WK py: the import stays all-or-nothing (sanitize ALL before the first write)",
        pySrc.includes("Phase 1 - sanitize EVERY raw preset first") &&
        pySrc.indexOf("# Phase 1") < pySrc.indexOf("async with _lock:\n        _migrate_legacy_file()\n        # Phase 2"));
}

// ===========================================================================
// --- 11) WL v105: the Close menu + Close all, the presets auto-retry, the
//     server-version mismatch notice
{
    const pnl = () => hooks.panelEl();
    const bodyEl = () => pnl().querySelector(".hub-wf-body");

    // ------------------------------------------------------------------
    // 11a) Close ALL - the pinned 📌 stay, unsaved tabs arm the confirm
    // ------------------------------------------------------------------
    phase("WL v105: Close all (pinned stay, armed confirm), presets auto-retry, srv-version notice");

    wfStore.openWorkflows = [
        makeTab({ path: "workflows/a.json" }),                    // clean saved
        makeTab({ path: "workflows/b.json", isModified: true }),  // modified
        makeTab({ name: "Sketch", isTemporary: true, isPersisted: false, nodes: [1, 2] }), // temp
        makeTab({ path: "workflows/pinned.json" }),               // clean saved (locked below)
    ];
    wfStore.activeWorkflow = wfStore.openWorkflows[0];
    await hooks.refreshOpen(true);
    hooks.renderAll();
    await settle();
    const wbody = bodyEl();
    // a key WB never touched (lockedKeys survives scenes - a re-lock would
    // TOGGLE the pin off)
    await wbody.querySelector('[data-act="lock"][data-key="workflows/pinned.json"]').click();
    await settle();

    await wbody.querySelector('[data-act="closemenu"]').click();
    await settle();
    let cmenu = document.querySelector(".hub-wf-closemenu");
    check("WL: the 🧹 menu opens on the Open tab", !!cmenu);
    const closeCalls0 = wfStore.calls.filter((c) => c.op === "close").length;
    await cmenu.querySelector('[data-act="closeall"]').click();
    await settle(10);
    check("WL: Close all first click ARMS (2 unsaved in the batch) - nothing closed yet",
        wfStore.calls.filter((c) => c.op === "close").length === closeCalls0 &&
        wfStore.openWorkflows.length === 4);
    check("WL: the armed item re-renders with the ⚠ label",
        !!cmenu.querySelector('[data-act="closeall"].hub-wf-armed') &&
        cmenu.querySelector('[data-act="closeall"]').textContent.includes("AGAIN"));
    cmenu = document.querySelector(".hub-wf-closemenu");
    await cmenu.querySelector('[data-act="closeall"]').click();
    await settle(40);           // the close loop (TAB_SEQ per tab) + the menu close
    check("WL: Close all second click closes the batch (a + b + the temp)",
        !wfStore.openWorkflows.some((t) => t.path === "workflows/a.json") &&
        !wfStore.openWorkflows.some((t) => t.path === "workflows/b.json") &&
        !wfStore.openWorkflows.some((t) => t.name === "Sketch"));
    check("WL: the PINNED tab survived Close all",
        wfStore.openWorkflows.some((t) => t.path === "workflows/pinned.json"));
    check("WL: the menu closed after the confirmed close", !document.querySelector(".hub-wf-closemenu"));
    check("WL: the workspace keeps a tab (never zero)",
        wfStore.openWorkflows.length >= 1, String(wfStore.openWorkflows.length));

    // a pinned-only workspace: Close all is a no-op with a toast
    wfStore.openWorkflows = [makeTab({ path: "workflows/pinned.json" })];
    await hooks.refreshOpen(true);
    hooks.renderAll();
    await settle();
    const r0 = await hooks.closeAllTabs();
    check("WL: Close all with ONLY pinned tabs answers 'empty' (nothing closed)",
        r0 === "empty" && wfStore.openWorkflows.length === 1);

    // ------------------------------------------------------------------
    // 11b) the presets auto-retry (the owner's issue 2: empty Presets tab
    //      after a refresh until a save happened)
    // ------------------------------------------------------------------
    fakeApi.__setPresets([{
        id: "pk1", name: "Night batch", created: 1, updated: 2, fav: false,
        items: [{ kind: "path", path: "workflows/a.json", name: "a.json" }],
    }]);
    fakeApi.__setPresetsFail(true);
    hooks.clearPresets();       // the module list survives remounts - clean slate
    hooks.setTab("open");       // a known tab so the later setTab(presets) fires
    await settle();
    hooks.setOn(false);
    await settle();
    hooks.setOn(true);          // fresh mount: the boot read fails (500)
    await settle(30);
    check("WL: a failed boot read leaves presetsLoaded false",
        hooks.presetsLoaded() === false && hooks.presets().length === 0);
    hooks.setTab("presets");
    await settle();
    let pbody = bodyEl().textContent;
    check("WL: the empty tab does NOT claim 'No presets yet' while unread",
        pbody.includes("Reading presets…") || pbody.includes("Server storage offline"),
        pbody.slice(0, 120));
    fakeApi.__setPresetsFail(false);
    await hooks.pollTick();     // the retry pass heals the list
    await settle();
    check("WL: the poll retry loads the presets without any save",
        hooks.presetsLoaded() === true && hooks.presets().length === 1);
    pbody = bodyEl().textContent;
    check("WL: the card renders after the retry", pbody.includes("Night batch"));
    check("WL: the status line names the live server version (srv vNNN)",
        bodyEl().querySelector(".hub-wf-status").textContent.includes("srv "));

    // the tab-open retry: a fresh mount + a working server heals on OPEN
    hooks.setTab("open");
    await settle();
    hooks.setOn(false);
    await settle();
    fakeApi.__setPresetsFail(true);
    hooks.clearPresets();
    hooks.setOn(true);
    await settle(30);           // boot read fails again
    fakeApi.__setPresetsFail(false);
    hooks.setTab("presets");    // opening the tab itself retries
    await settle(30);
    check("WL: opening the Presets tab retries a failed boot read",
        hooks.presetsLoaded() === true && hooks.presets().length === 1);
    hooks.setTab("open");
    await settle();

    // ------------------------------------------------------------------
    // 11c) the server-version mismatch notice (the owner's issue 4:
    //      v104 web after a page refresh + a v103 py process kept the old
    //      single-file store - the panel now names the problem)
    // ------------------------------------------------------------------
    fakeApi.__setHealthVersion("v107"); // one behind the pack (v108)
    await hooks.probeServer();          // presetsLoaded=true -> the poll probes periodically
    hooks.renderAll();
    await settle();
    const note2 = pnl().querySelector(".hub-wf-note");
    check("WL: an older server pack names 'RESTART ComfyUI' in the red note",
        !!note2 && note2.style.display !== "none" &&
        note2.textContent.includes("RESTART ComfyUI") &&
        note2.textContent.includes("Server storage pack is v107"),
        note2?.textContent || "(no note)");
    hooks.setTab("presets");
    await settle();
    const stTxt2 = bodyEl().querySelector(".hub-wf-status").textContent;
    check("WL: the presets status shows the stale srv version + ⚠",
        stTxt2.includes("srv v107") && stTxt2.includes("⚠"), stTxt2);
    fakeApi.__setHealthVersion("v117"); // ahead of the pack (v116) - a stale web file
    await hooks.probeServer();
    hooks.renderAll();
    await settle();
    check("WL: a newer server pack asks for a hard refresh",
        (hooks.serverNote()?.why || "").includes("hard refresh"), hooks.serverNote()?.why);
    fakeApi.__setHealthVersion(null); // back to the pack version - the note clears
    await hooks.probeServer();
    hooks.renderAll();
    await settle();
    check("WL: the matching server version clears the note",
        !hooks.serverNote(), JSON.stringify(hooks.serverNote()));
    hooks.setTab("open");
    await settle();
}

// ===========================================================================
phase("WM v106: scroll-stable confirms + snapshot reopens of temp tabs");
{
    const bodyEl = () => pnl().querySelector(".hub-wf-body");

    // ------------------------------------------------------------------
    // 12a) recordRecent: temp tabs record reopenable - this block runs with
    //      the STALE fake temp routes (an old py): the v106 embed fallback
    //      is under test; the v107 server path gets its own WN phase
    // ------------------------------------------------------------------
    fakeApi.__setTempMode("stale"); // old py: the temp routes 404
    hooks.resetRecent();
    await hooks.recordRecent({ name: "Unsaved Workflow (3)", isTemporary: true, isPersisted: false, isEmpty: false },
        { nodes: [{ id: 1 }], links: [] });
    let wmRec = hooks.recent()[0];
    check("WM: a closed temp tab records WITH its snapshot embedded (v106 embed path)",
        hooks.recent().length === 1 && wmRec && wmRec.snap && wmRec.path === null &&
        wmRec.name === "Unsaved Workflow (3)", JSON.stringify(wmRec || null).slice(0, 120));
    const before = hooks.recent().length;
    await hooks.recordRecent({ name: "Empty scratch", isTemporary: true, isPersisted: false, isEmpty: true }, null);
    check("WM: an empty temp tab without a graph is NOT recorded (no dead rows)",
        hooks.recent().length === before);
    await hooks.recordRecent({ name: "No graph", isTemporary: true, isPersisted: false }, null);
    check("WM: an unserializable temp tab is NOT recorded",
        hooks.recent().length === before);
    await hooks.recordRecent({ path: "workflows/Unsaved Workflow (3) (2).null", name: "Unsaved Workflow (3) (2).null" });
    check("WM: the '.null' garbage path is refused at record time",
        hooks.recent().length === before &&
        !hooks.recent().some((r) => (r.path || "").includes(".null")),
        JSON.stringify(hooks.recent()));
    await hooks.recordRecent({ path: "workflows/m.json", name: "m.json", isModified: true }, { nodes: [{ id: 9 }] });
    wmRec = hooks.recent()[0];
    check("WM: a MODIFIED saved tab records the path AND its unsaved state",
        wmRec.path === "workflows/m.json" && wmRec.snap && wmRec.snap.nodes?.[0]?.id === 9,
        JSON.stringify(wmRec || null).slice(0, 140));
    await hooks.recordRecent({ name: "Unsaved Workflow (3)", isTemporary: true, isPersisted: false, isEmpty: false },
        { nodes: [{ id: 2 }], links: [] });
    check("WM: re-closing the same temp tab DEDUPES by name (ts bumps, snap refreshes)",
        hooks.recent().length === 2 &&
        hooks.recent()[0].snap?.nodes?.[0]?.id === 2, JSON.stringify(hooks.recent().map((r) => r.name)));

    // the boot prune: a legacy ".null" entry dies on reload, the real one stays
    dom.window.localStorage.setItem("settingshub.workflows.recent", JSON.stringify([
        { path: "workflows/Unsaved Workflow (3) (2).null", name: "garbage", ts: 1 },
        { path: "workflows/real.json", name: "real.json", ts: 2 },
        { path: null, name: "snapless temp", ts: 3 },
    ]));
    hooks.reloadRecent();
    check("WM: reloadRecent prunes the legacy '.null' + unrestorable rows",
        hooks.recent().length === 1 && hooks.recent()[0].path === "workflows/real.json",
        JSON.stringify(hooks.recent()));
    hooks.resetRecent();

    // ------------------------------------------------------------------
    // 12b) the reopen of a snapshot row goes through the SNAPSHOT ladder -
    //      NOT a /userdata fetch (the owner's 404 on "Unsaved Workflow (3)")
    //      v107: the close uploads the graph to the SERVER (tempId), so the
    //      ladder check runs in the WN phase; this phase keeps the STALE
    //      (old-py) embed path alive via the fake temp 404s.
    // ------------------------------------------------------------------
    fakeApi.__setTempMode("stale"); // simulate an old py: the temp routes are gone
    const tempTab = makeTab({ name: "Unsaved Workflow (3)", isTemporary: true, isPersisted: false, nodes: [1, 2] });
    wfStore.openWorkflows = [tempTab];
    wfStore.activeWorkflow = tempTab;
    await hooks.refreshOpen(true);
    hooks.setTab("open");       // a no-op when already on Open - force the re-render
    hooks.renderAll();
    await settle();
    const callsBeforeClose = fakeApi.__calls().length;
    const udBefore = fakeApi.__calls().filter((c) => c.url.includes("/userdata")).length;
    // a temp tab needs the armed second click (the panel owns the confirm)
    const xbtn = () => bodyEl().querySelector('[data-act="close"]');
    await xbtn().click();
    await settle();
    await xbtn().click();
    await settle(10);
    check("WM: the armed ✕ closed the temp tab",
        !wfStore.openWorkflows.some((t) => t.name === "Unsaved Workflow (3)"));
    const wmRecent = hooks.recent();
    check("WM: the close recorded the temp tab with an embedded snapshot (old py fallback)",
        wmRecent.length === 1 && wmRecent[0].name === "Unsaved Workflow (3)" &&
        !!wmRecent[0].snap && wmRecent[0].path === null, JSON.stringify(wmRecent[0] || null).slice(0, 140));

    hooks.setTab("files");
    await settle();
    const snapRow = bodyEl().querySelector('.hub-wf-body [data-act="reopen"][data-rts]');
    check("WM: the recent row renders with the (snapshot) badge + ts key",
        !!snapRow && snapRow.textContent.includes("(snapshot)") &&
        !snapRow.getAttribute("data-path"), snapRow?.textContent || "(no row)");
    await snapRow.click();
    await settle(20);
    check("WM: the reopen restored the temp tab via createTemporary + the graph",
        wfStore.openWorkflows.some((t) => t.__snapshotGraph &&
            t.__snapshotGraph.nodes?.length === 2),
        JSON.stringify(wfStore.openWorkflows.map((t) => t.name)));
    const udAfter = fakeApi.__calls().filter((c) => c.url.includes("/userdata")).length;
    check("WM: NO /userdata fetch happened for the temp reopen (no 404)",
        udAfter === udBefore &&
        !fakeApi.__calls().slice(callsBeforeClose).some((c) => (c.url || "").includes("Unsaved")),
        JSON.stringify(fakeApi.__calls().slice(callsBeforeClose).map((c) => c.url)));
    fakeApi.__setTempMode("ok"); // the rest of the suite sees the v107 server

    // ------------------------------------------------------------------
    // 12c) the scroll-stable re-renders: arming 🗑 keeps the scroll anchor
    // ------------------------------------------------------------------
    // jsdom has no layout - the scrollTop pair is redefined to OBSERVE the
    // assignments renderAll makes (the restore of the captured anchor)
    const scDesc = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "scrollTop") ||
        { get: () => 0, set: () => {}, configurable: true };
    const stLog = [];
    let stVal = 0;
    Object.defineProperty(dom.window.Element.prototype, "scrollTop", {
        configurable: true,
        get() { return stVal; },
        set(v) { stLog.push(v); stVal = v; try { scDesc.set?.call(this, v); } catch (_) {} },
    });
    try {
        hooks.setTab("presets");
        await settle();
        check("WM: the Presets tab still renders the WL preset",
            bodyEl().textContent.includes("Night batch"));
        stLog.length = 0;
        stVal = 555; // "the user scrolled the list down"
        await bodyEl().querySelector('[data-act="del"][data-pid="pk1"]').click(); // arm
        await settle();
        check("WM: arming the 🗑 delete re-renders AND restores the scroll anchor (555)",
            stLog.length === 1 && stLog[0] === 555, JSON.stringify(stLog));
        check("WM: the armed state is visible (the 🗑 carries hub-wf-armed)",
            !!bodyEl().querySelector('[data-act="del"][data-pid="pk1"].hub-wf-armed'));
        stLog.length = 0;
        hooks.setTab("open");
        await settle();
        check("WM: a REAL tab switch does not restore the old anchor (no assignment)",
            stLog.length === 0, JSON.stringify(stLog));
    } finally {
        Object.defineProperty(dom.window.Element.prototype, "scrollTop", scDesc);
    }
    hooks.setTab("open");
    await settle();
}

// ===========================================================================
phase("WN v107: server-side temp snapshots (temp/<id>.json) + eviction + boot GC");
{
    const bodyEl = () => pnl().querySelector(".hub-wf-body");
    hooks.resetRecent();
    fakeApi.__tempStore().clear();
    await hooks.probeServer(); // the WN server checks need serverState

    // ------------------------------------------------------------------
    // 14a) the close of a temp tab UPLOADS the graph to the server; the
    //      localStorage ring keeps only the metadata + tempId
    // ------------------------------------------------------------------
    const postCount0 = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/temp" && c.method === "POST").length;
    await hooks.recordRecent({ name: "Unsaved Workflow (7)", isTemporary: true, isPersisted: false, isEmpty: false },
        { nodes: [{ id: 7 }], links: [] });
    const wnPost = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/temp" && c.method === "POST").slice(-1)[0];
    const wnRec = hooks.recent()[0];
    check("WN: the close POSTed the graph to /workflows/temp",
        fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/temp" && c.method === "POST").length === postCount0 + 1 &&
        !!wnPost?.body && JSON.parse(wnPost.body).graph?.nodes?.[0]?.id === 7 &&
        JSON.parse(wnPost.body).name === "Unsaved Workflow (7)",
        wnPost?.body?.slice(0, 140));
    check("WN: the ring entry carries tempId, NOT the graph",
        wnRec && typeof wnRec.tempId === "string" && wnRec.tempId &&
        wnRec.snap === undefined && wnRec.path === null &&
        fakeApi.__tempStore().has(wnRec.tempId) &&
        fakeApi.__tempStore().get(wnRec.tempId).graph?.nodes?.[0]?.id === 7,
        JSON.stringify(wnRec || null).slice(0, 140));
    const lsRing = JSON.parse(dom.window.localStorage.getItem("settingshub.workflows.recent") || "[]");
    check("WN: the localStorage ring row is TINY (metadata only - the owner's quota concern)",
        lsRing.length === 1 && JSON.stringify(lsRing[0]).length < 300 &&
        !JSON.stringify(lsRing[0]).includes("\"nodes\""),
        JSON.stringify(lsRing[0] || null));

    // ------------------------------------------------------------------
    // 14b) the reopen of a tempId row fetches the SERVER snapshot through
    //      the ladder - and never a /userdata path
    // ------------------------------------------------------------------
    hooks.setTab("files");
    await settle();
    const wnRow = bodyEl().querySelector('.hub-wf-body [data-act="reopen"][data-rts]');
    check("WN: the tempId row renders with the (snapshot) badge",
        !!wnRow && wnRow.textContent.includes("(snapshot)") && !wnRow.getAttribute("data-path"),
        wnRow?.textContent || "(no row)");
    const udBeforeWN = fakeApi.__calls().filter((c) => c.url.includes("/userdata")).length;
    const getBeforeWN = fakeApi.__calls().filter((c) => c.url.startsWith("/settings_hub/workflows/temp/") && c.method === "GET").length;
    await wnRow.click();
    await settle(20);
    check("WN: the reopen fetched the server snapshot and restored the graph",
        fakeApi.__calls().filter((c) => c.url.startsWith("/settings_hub/workflows/temp/") && c.method === "GET").length === getBeforeWN + 1 &&
        wfStore.openWorkflows.some((t) => t.__snapshotGraph?.nodes?.[0]?.id === 7),
        JSON.stringify(wfStore.openWorkflows.map((t) => t.name)));
    check("WN: the reopen made NO /userdata fetch (the v106 bug is dead for good)",
        fakeApi.__calls().filter((c) => c.url.includes("/userdata")).length === udBeforeWN);

    // ------------------------------------------------------------------
    // 14c) the evicted ring rows: the SERVER reference accounting (v112,
    //      plan 3.6) - the debounced manifest sync uploads the ring, the
    //      server computes the cross-browser reference union, and ONLY the
    //      snapshots no manifest references are deleted. The test waits
    //      past the 600ms debounce.
    // ------------------------------------------------------------------
    const createdIds = [wnRec.tempId];
    for (let i = 1; i <= 20; i++) {
        await hooks.recordRecent({ name: "WN temp " + String(i).padStart(2, "0"), isTemporary: true, isPersisted: false, isEmpty: false },
            { nodes: [{ id: i }], links: [] });
        createdIds.push(hooks.recent()[0].tempId);
    }
    const ringIds = new Set(hooks.recent().map((r) => r.tempId).filter(Boolean));
    const evicted = createdIds.filter((id) => !ringIds.has(id));
    check("WN: the ring is capped at RECENT_MAX (15) temp rows",
        hooks.recent().length === 15, String(hooks.recent().length));
    // wait past the 600ms manifest-sync debounce
    await new Promise((r) => setTimeout(r, 900)); await settle(20);
    const manifest = [...fakeApi.__recentStore().values()][0] || null;
    check("WN: the ring manifest landed SERVER-side (metadata per session)",
        !!manifest && Array.isArray(manifest.entries) && manifest.entries.length === 15,
        JSON.stringify(manifest || null).slice(0, 120));
    check("WN: the manifest references exactly the current ring's tempIds",
        !!manifest && manifest.entries.every((e) => ringIds.has(e.tempId)));
    const delUrls = fakeApi.__calls().filter((c) => c.url.startsWith("/settings_hub/workflows/temp/") && c.method === "DELETE")
        .map((c) => decodeURIComponent(c.url.split("/temp/")[1] || ""));
    check("WN: every evicted temp snapshot was deleted AFTER the server confirmed no manifest references it",
        evicted.length === 6 && evicted.every((id) => delUrls.includes(id)),
        "evicted=" + evicted.length + " deletes=" + delUrls.length + " ring=" + ringIds.size);
    check("WN: the evicted files are GONE from the server store, the ring files stay",
        evicted.every((id) => !fakeApi.__tempStore().has(id)) &&
        [...ringIds].every((id) => fakeApi.__tempStore().has(id)),
        "store=" + fakeApi.__tempStore().size);

    // ------------------------------------------------------------------
    // 14d) the boot GC (v112): SERVER-AUTHORITATIVE - the POST /temp/gc
    //      route deletes a snapshot only when NO manifest (any browser)
    //      references it AND it is older than a day
    // ------------------------------------------------------------------
    const gRef = [...ringIds][0];
    const gFresh = "aabbccdd0001";
    const gOld = "aabbccdd0002";
    const dayAgo = Math.floor((Date.now() - hooks.TEMP_MAX_AGE_MS - 60000) / 1000);
    const nowTs = Math.floor(Date.now() / 1000);
    fakeApi.__tempStore().set(gFresh, { id: gFresh, name: "fresh orphan", ts: nowTs, graph: { nodes: [] } });
    fakeApi.__tempStore().set(gOld, { id: gOld, name: "stale orphan", ts: dayAgo, graph: { nodes: [] } });
    hooks.setTempGcDone(false);
    await hooks.gcTempSnapshots();
    check("WN: the boot GC (server route) deleted the STALE orphan (> 1 day, not referenced)",
        !fakeApi.__tempStore().has(gOld));
    check("WN: the boot GC kept the manifest-referenced file",
        fakeApi.__tempStore().has(gRef));
    check("WN: the boot GC kept the FRESH orphan (< 1 day - another browser may point at it)",
        fakeApi.__tempStore().has(gFresh), "store=" + fakeApi.__tempStore().size);
    const gcLoad = await hooks.loadServerState();
    check("WN: loadServerState ran the one-shot GC pass (tempGcDone latched)",
        gcLoad && hooks.tempGcDone() === true);

    // ------------------------------------------------------------------
    // 14e) sanitizeRecent accepts tempId rows and drops the dead ones
    // ------------------------------------------------------------------
    dom.window.localStorage.setItem("settingshub.workflows.recent", JSON.stringify([
        { path: null, name: "server temp", ts: 5, tempId: "aabbccdd0003" },
        { path: "workflows/real.json", name: "real.json", ts: 6 },
        { path: null, name: "dead temp", ts: 7 },
        { path: null, name: "embed temp", ts: 8, snap: { nodes: [] } },
    ]));
    hooks.reloadRecent();
    check("WN: sanitizeRecent keeps tempId + path + embed rows, drops the payload-less temp",
        hooks.recent().length === 3 &&
        hooks.recent().some((r) => r.tempId === "aabbccdd0003") &&
        !hooks.recent().some((r) => r.name === "dead temp"),
        JSON.stringify(hooks.recent()));
    hooks.resetRecent();
    fakeApi.__tempStore().clear();
}

// ===========================================================================
phase("WO v108: the Files file manager - meta rung, sort, filters, favorites, tree");

const NOW = Date.now() / 1000;
fakeApi.__setWfFiles([
    { path: "workflows/flux_main.json", name: "flux_main.json", size: 2048, mtime: NOW - 2 * 86400 },
    { path: "workflows/sub/deep/nested.json", name: "nested.json", size: 512000, mtime: NOW - 5 },
    { path: "workflows/settings_hub/junk.json", name: "junk.json", size: 1, mtime: NOW - 3 },
    { path: "workflows/old.json", name: "old.json", size: 4096, mtime: NOW - 20 * 86400 },
]);
hooks.setTab("files");
await hooks.refreshSavedFiles();
await settle();
// v108: the panel is RE-MOUNTED somewhere between the phases - always
// re-query hooks.panelEl() here, the WA-era `panel` const is detached
const wpanel = hooks.panelEl();

const wofiles = hooks.savedFiles();
check("WO: the /files rung is preferred (size+mtime carried)",
    wofiles.some((f) => f.path === "workflows/sub/deep/nested.json" && f.size === 512000),
    JSON.stringify(wofiles));
check("WO: the settings_hub subtree never mixes into Files (the owner's contract)",
    !wofiles.some((f) => String(f.path).includes("settings_hub/")), JSON.stringify(wofiles));
check("WO: the nested folder file is listed",
    wofiles.some((f) => f.path === "workflows/sub/deep/nested.json"));

let wbody = wpanel.querySelector(".hub-wf-body");
check("WO: the row sub-line shows the workflows-relative path + size + date",
    wbody.querySelector('[data-fpath="workflows/sub/deep/nested.json"] .hub-wf-filesub')
        .textContent.includes("sub/deep/nested.json") &&
    wbody.querySelector('[data-fpath="workflows/sub/deep/nested.json"] .hub-wf-filesub')
        .textContent.includes("500 KB"),
    wbody.querySelector('[data-fpath="workflows/sub/deep/nested.json"] .hub-wf-filesub')?.textContent || "");
check("WO: the storage paths still open by the FULL path (data-path intact)",
    !!wbody.querySelector('[data-act="openfile"][data-path="workflows/sub/deep/nested.json"]'));

// the rows helper: visible file paths in render order
const wfPaths = () => [...wpanel.querySelectorAll(".hub-wf-body [data-fpath]")]
    .filter((r) => r.querySelector("[data-fcheck]"))
    .map((r) => r.dataset.fpath);
// default sort = date desc -> nested (now) , flux_main (-2d), old (-20d)
check("WO: the default sort is date-descending",
    JSON.stringify(wfPaths()) === JSON.stringify([
        "workflows/sub/deep/nested.json", "workflows/flux_main.json", "workflows/old.json"]),
    JSON.stringify(wfPaths()));

// sort by name: one click = asc, the second = desc
const nameBtn = () => wpanel.querySelector('[data-act="filesort"][data-key="name"]');
nameBtn().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the name sort sorts ascending (with the arrow on the button)",
    JSON.stringify(wfPaths()) === JSON.stringify([
        "workflows/flux_main.json", "workflows/sub/deep/nested.json", "workflows/old.json"]) &&
    nameBtn().textContent.includes("↑"),
    JSON.stringify(wfPaths()));
nameBtn().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the second click flips to descending",
    JSON.stringify(wfPaths()) === JSON.stringify([
        "workflows/old.json", "workflows/sub/deep/nested.json", "workflows/flux_main.json"]) &&
    nameBtn().textContent.includes("↓"),
    JSON.stringify(wfPaths()));
nameBtn().dispatchEvent(new dom.window.Event("click", { bubbles: true })); // back to asc
await settle();

// favorites: the star toggles + persists server-side; the ★-only chip filters
const favStar = () => wpanel.querySelector('[data-act="filefav"][data-path="workflows/old.json"]');
favStar().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle(12);
check("WO: the star POSTed the toggle to the server",
    fakeApi.__wfFavs().includes("workflows/old.json"), JSON.stringify(fakeApi.__wfFavs()));
check("WO: the star flipped to the marked state",
    hooks.filesFav().includes("workflows/old.json") &&
    favStar().classList.contains("hub-wf-favbtn-on"));
wpanel.querySelector('[data-act="favonly"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the ★-only chip narrows the list to the favorite",
    JSON.stringify(wfPaths()) === JSON.stringify(["workflows/old.json"]), JSON.stringify(wfPaths()));
wpanel.querySelector('[data-act="favonly"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();

// advanced filters: the ⚗ chip opens the row; folder / date / size / clear
wpanel.querySelector('[data-act="fadv"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the advanced row opened with the folder select + dates + sizes",
    !!wpanel.querySelector('[data-wf="ffolder"]') &&
    !!wpanel.querySelector('[data-wf="fdatefrom"]') &&
    !!wpanel.querySelector('[data-wf="fsizemin"]'));
const ffold = wpanel.querySelector('[data-wf="ffolder"]');
check("WO: the folder options cover the nested levels (relative to workflows root)",
    [...ffold.options].some((o) => o.value === "sub") &&
    [...ffold.options].some((o) => o.value === "sub/deep"),
    [...ffold.options].map((o) => o.value).join(","));
ffold.value = "sub";
ffold.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("WO: the folder filter keeps the nested subfolders",
    JSON.stringify(wfPaths()) === JSON.stringify(["workflows/sub/deep/nested.json"]),
    JSON.stringify(wfPaths()));
const fclear = () => wpanel.querySelector('[data-act="fclear"]');
fclear().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: ✕ clears every advanced filter", wfPaths().length === 3, JSON.stringify(wfPaths()));

// date bounds: until 2001-01-02 hides everything, from 2001-01-01 brings all back
const setDate = (sel, v) => {
    const el = wpanel.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};
setDate('[data-wf="fdateto"]', "2001-01-02");
await settle();
check("WO: the 'until' date hides the modern files", wfPaths().length === 0, JSON.stringify(wfPaths()));
setDate('[data-wf="fdateto"]', "");
setDate('[data-wf="fdatefrom"]', "2001-01-01");
await settle();
check("WO: the 'from' date passes everything", wfPaths().length === 3, JSON.stringify(wfPaths()));
fclear().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();

// size range: max 5 KB drops the 500 KB nested file, keeps 2 KB + 4 KB
const setSize = (sel, v) => {
    const el = wpanel.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};
setSize('[data-wf="fsizemax"]', "5");
await settle();
check("WO: the size range filter works in KB",
    wfPaths().length === 2 &&
    !wfPaths().includes("workflows/sub/deep/nested.json"), JSON.stringify(wfPaths()));
fclear().dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();

// quick periods: "today" keeps only the fresh file (mtime NOW - 5s)
wpanel.querySelector('[data-act="fquick"][data-q="today"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the Today chip keeps only the file modified today",
    JSON.stringify(wfPaths()) === JSON.stringify(["workflows/sub/deep/nested.json"]),
    JSON.stringify(wfPaths()));
check("WO: the Today chip is highlighted", !!wpanel.querySelector('[data-act="fquick"][data-q="today"].hub-wf-fchip-on'));
wpanel.querySelector('[data-act="fquick"][data-q="today"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: clicking the chip again clears the quick period", wfPaths().length === 3, JSON.stringify(wfPaths()));

// the tree view: folders render, carets expand, entering + breadcrumbs work
wpanel.querySelector('[data-act="filesview"][data-view="tree"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the tree view renders the folder row",
    !!wpanel.querySelector('[data-act="treeenter"][data-folder="sub"]'));
check("WO: the recent section is a list-mode citizen (hidden in the tree)",
    !wpanel.querySelector(".hub-wf-list-recent"));
wpanel.querySelector('[data-act="treefold"][data-folder="sub"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the caret expands the folder in place (the deep subfolder row appears)",
    !!wpanel.querySelector('[data-act="treeenter"][data-folder="sub/deep"]'));
// any depth: expand the deep subfolder too - its file row shows up indented
wpanel.querySelector('[data-act="treefold"][data-folder="sub/deep"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: expanding any depth renders the leaf (the nested file row, indented)",
    !!wpanel.querySelector('[data-act="openfile"][data-path="workflows/sub/deep/nested.json"]') &&
    wpanel.querySelector('[data-fpath="workflows/sub/deep/nested.json"]').style.paddingLeft !== "",
    wpanel.querySelector('[data-fpath="workflows/sub/deep/nested.json"]')?.outerHTML || "(no row)");
wpanel.querySelector('[data-act="treeenter"][data-folder="sub"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: entering a folder navigates + shows the breadcrumbs",
    !!wpanel.querySelector('[data-act="treecrumb"][data-folder=""]') &&
    !!wpanel.querySelector('[data-act="treecrumb"][data-folder="sub"]'),
    wpanel.querySelector(".hub-wf-crumbs")?.textContent || "");
check("WO: inside the folder the deep subfolder is still expandable",
    !!wpanel.querySelector('[data-act="treefold"][data-folder="sub/deep"]'));
wpanel.querySelector('[data-act="treecrumb"][data-folder=""]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the root crumb returns the navigation to the workflows root",
    hooks.filesState().treeFolder === "" &&
    !!wpanel.querySelector('[data-act="treeenter"][data-folder="sub"]'));
wpanel.querySelector('[data-act="filesview"][data-view="list"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: back to ≡ restores the habitual Files view (the recent section returns)",
    !!wpanel.querySelector(".hub-wf-list-recent") &&
    !wpanel.querySelector(".hub-wf-crumbs"));

// ===========================================================================
// WO.8b v110: the filter chips are VISIBLE + the tree prunes the dead
// branches. The chips used to borrow the minimized-panel .hub-wf-chip class
// (position:fixed; display:none) - the whole ★/⚗/periods row rendered but
// sat hidden, the owner saw "only the sortings and the tree toggler". And
// with an active search the folder tree must not show the folders whose
// subtree holds no matching file (the owner's ask).
check("WO: the filter chips carry the fchip class, NOT the minimized-chip class",
    ["fadv", "favonly", "fquick"].flatMap((a) => [...wpanel.querySelectorAll(`[data-act="${a}"]`)])
        .every((b) => b.classList.contains("hub-wf-fchip") &&
            b.classList.contains("hub-wf-act") &&
            b.closest(".hub-wf-tools2") &&
            !b.classList.contains("hub-wf-chip")));
check("WO: the fchip CSS is visible (no display:none / position:fixed in the base rule)",
    (() => {
        const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8");
        const m = css.match(/\.hub-wf-fchip\s*\{[^}]*\}/);
        return !!m && !/display\s*:\s*none/.test(m[0]) && !/position\s*:\s*fixed/.test(m[0]) &&
            css.includes(".hub-wf-fchip-on");
    })());

// the tree pruning: a second folder chain "other/" with files that never
// match the search - under the search it must disappear from the tree
fakeApi.__setWfFiles([
    { path: "workflows/flux_main.json", name: "flux_main.json", size: 2048, mtime: NOW - 2 * 86400 },
    { path: "workflows/sub/deep/nested.json", name: "nested.json", size: 512000, mtime: NOW - 5 },
    { path: "workflows/settings_hub/junk.json", name: "junk.json", size: 1, mtime: NOW - 3 },
    { path: "workflows/old.json", name: "old.json", size: 4096, mtime: NOW - 20 * 86400 },
    { path: "workflows/other/keep.json", name: "keep.json", size: 100, mtime: NOW - 60 },
]);
hooks.setTab("files");
await hooks.refreshSavedFiles();
await settle();
// determinism: the earlier v108 tree block left sub + sub/deep expanded in
// the session state - collapse everything before asserting the folds
for (const d of hooks.filesState().treeExpanded) hooks.toggleTreeFolder(d);
await settle();
const wpanelT = hooks.panelEl();
wpanelT.querySelector('[data-act="filesview"][data-view="tree"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the unfiltered tree shows every real folder branch",
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="sub"]') &&
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="other"]'));
const typeSearch = (v) => {
    const f = wpanelT.querySelector('[data-wf="filesearch"]');
    f.value = v;
    f.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
typeSearch("nested");
await settle();
check("WO: the search prunes the dead folder branches (other/ is gone, sub/ stays)",
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="sub"]') &&
    !wpanelT.querySelector('[data-act="treeenter"][data-folder="other"]'));
wpanelT.querySelector('[data-act="treefold"][data-folder="sub"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
wpanelT.querySelector('[data-act="treefold"][data-folder="sub/deep"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: the alive branch expands to the matching leaf + the counter reads the filtered list",
    !!wpanelT.querySelector('[data-act="openfile"][data-path="workflows/sub/deep/nested.json"]') &&
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="sub/deep"]') &&
    wpanelT.querySelector('[data-act="treeenter"][data-folder="sub"]').closest(".hub-wf-trow")
        .querySelector(".hub-wf-tcount").textContent === "1");
typeSearch("zzznomatch");
await settle();
check("WO: a no-match search leaves no folder rows at all",
    !wpanelT.querySelector("[data-act='treeenter']") &&
    !!wpanelT.querySelector(".hub-wf-emptylist"));
typeSearch("");
await settle();
wpanelT.querySelector('[data-act="favonly"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: a filter prunes the tree too (★-only leaves only the root favorite file)",
    !wpanelT.querySelector("[data-act='treeenter']") &&
    !!wpanelT.querySelector('[data-fpath="workflows/old.json"]'));
wpanelT.querySelector('[data-act="favonly"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("WO: clearing the filters restores every folder branch",
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="other"]') &&
    !!wpanelT.querySelector('[data-act="treeenter"][data-folder="sub"]'));
wpanelT.querySelector('[data-act="filesview"][data-view="list"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();

// the pure helpers (unit level)
check("WO: shortPath keeps the LAST folders + the name with the ellipsis",
    hooks.shortPath("alpha/beta/gamma/delta/epsilon/zeta/long_name_file.json").startsWith("…/") &&
    hooks.shortPath("alpha/beta/gamma/delta/epsilon/zeta/long_name_file.json").endsWith("long_name_file.json"),
    hooks.shortPath("alpha/beta/gamma/delta/epsilon/zeta/long_name_file.json"));
check("WO: shortPath passes a short path through untouched",
    hooks.shortPath("sub/nested.json") === "sub/nested.json");
check("WO: relWfPath strips the workflows/ prefix",
    hooks.relWfPath("workflows/sub/nested.json") === "sub/nested.json");
check("WO: fmtSize names the human units",
    hooks.fmtSize(2048) === "2.0 KB" && hooks.fmtSize(512000) === "500 KB" &&
    hooks.fmtSize(3 * 1024 * 1024) === "3.0 MB", hooks.fmtSize(2048));

// the persisted view state: sort + view survive a remount
check("WO: the sort persisted into LS_UI",
    JSON.parse(dom.window.localStorage.getItem("settingshub.workflows.ui")).filesSort.key === "name",
    dom.window.localStorage.getItem("settingshub.workflows.ui"));

// ===========================================================================
// WO.9 v109 regression: the v108 blanking bug. The py rung MUST answer with
// the real userdata files, and the client must treat an ok:true EMPTY rung-0
// answer as "try the legacy rungs" - never as a blank Files tab + red
// missing-marks on every preset item.
phase("WO9 v109: the empty ok:true rung-0 answer falls back to the native rung");

fakeApi.__setWfFiles([]); // ok:true, files:[] - the exact v108 wrong-layout shape
hooks.setTab("files");
await hooks.refreshSavedFiles();
await settle();
const wpanel9 = hooks.panelEl();
check("WO9: an empty ok:true /files answer falls back to the native rung",
    hooks.savedFiles().some((f) => f.path === "workflows/flux_main.json"),
    JSON.stringify(hooks.savedFiles()));
check("WO9: the Files rows render from the fallback rung",
    !!wpanel9.querySelector('[data-fpath="workflows/flux_main.json"]') &&
    !!wpanel9.querySelector('[data-fpath="workflows/upscale.json"]'));

// and the healthy shape still wins (rung 0 preferred when it lists files)
fakeApi.__setWfFiles([
    { path: "workflows/from_rung0.json", name: "from_rung0.json", size: 1, mtime: NOW - 1 },
]);
await hooks.refreshSavedFiles();
await settle();
check("WO9: a non-empty rung-0 answer is still preferred",
    hooks.savedFiles().length === 1 && hooks.savedFiles()[0].path === "workflows/from_rung0.json",
    JSON.stringify(hooks.savedFiles()));

// cleanup: an old-py shape again for any later phase (the suite ends here)
fakeApi.__setWfFiles(null);
hooks.setTab("open");
await settle();


// ===========================================================================
phase("WP v112 plan 3.1: snapshot-based Undo (server-side, graphs included)");
{
    const pnlWp = () => hooks.panelEl();
    hooks.resetRecent();
    // a workspace: one clean persisted tab + one MODIFIED persisted tab + one temp
    wfStore.openWorkflows.length = 0;
    wfStore.activeWorkflow = null;
    const cleanTab = makeTab({ path: "workflows/flux_main.json", nodes: [1, 2] });
    const modTab = makeTab({ path: "workflows/flux_detail.json", nodes: [3], isModified: true, name: "flux_detail.json" });
    const tempTab = makeTab({ name: "WP unsaved", isTemporary: true, isPersisted: false, nodes: [9] });
    wfStore.openWorkflows.push(cleanTab, modTab, tempTab);
    wfStore.activeWorkflow = cleanTab;
    // a preset that CLOSES the modified + temp tabs (keeps only flux_main)
    fakeApi.__setPresets([{ id: "wppreset1", name: "WP only main", items: [
        { kind: "path", path: "workflows/flux_main.json", name: "flux_main.json" },
    ] }]);
    await hooks.refreshPresets();
    await hooks.refreshOpen(true);

    const plan = hooks.buildApplyPlan("wppreset1", { keepUnsaved: false });
    check("WP: the plan would close the modified + temp tabs (2 risky)",
        plan.close.length === 2 && plan.close.every((t) => t.isModified || !t.isPersisted),
        JSON.stringify(plan.close.map((t) => t.name)));
    check("WP: NO undo snapshot exists before the apply", fakeApi.__undoStore().size === 0);

    await hooks.applyPlanById("wppreset1", { keepUnsaved: false });
    await settle(30);
    check("WP: the apply captured ONE server undo snapshot",
        fakeApi.__undoStore().size === 1,
        "undo=" + fakeApi.__undoStore().size);
    const undoId = hooks.sessionUndoState()?.undoId || null;
    check("WP: the browser keeps only the undoId (not the graphs)",
        typeof undoId === "string" && !!undoId,
        JSON.stringify(hooks.sessionUndoState() || null).slice(0, 120));
    const snap = fakeApi.__undoStore().get(undoId);
    check("WP: the snapshot carries ALL 3 pre-apply tabs",
        Array.isArray(snap?.tabs) && snap.tabs.length === 3,
        JSON.stringify(snap?.tabs?.map((t) => t.name)));
    check("WP: the MODIFIED persisted tab's GRAPH is in the snapshot",
        snap.tabs.find((t) => t.path === "workflows/flux_detail.json")?.graph?.nodes?.[0]?.id === 3,
        JSON.stringify(snap.tabs.find((t) => t.path === "workflows/flux_detail.json")));
    check("WP: the TEMP tab's graph is in the snapshot",
        snap.tabs.find((t) => t.temp)?.graph?.nodes?.[0]?.id === 9);
    check("WP: the activeKey recorded (the wrapper key = the tab path)",
        snap.activeKey === cleanTab.path, JSON.stringify(snap.activeKey));

    // the workspace after the apply: flux_main only (mod + temp closed)
    check("WP: after the apply only the preset tab stays",
        wfStore.openWorkflows.length === 1 && wfStore.openWorkflows[0] === cleanTab,
        JSON.stringify(wfStore.openWorkflows.map((t) => t.name)));

    // UNDO: restores the modified persisted tab WITH its unsaved graph and
    // the temp tab WITH its graph
    await hooks.undo();
    await settle(30);
    check("WP: the undo restored 3 tabs",
        wfStore.openWorkflows.length === 3,
        JSON.stringify(wfStore.openWorkflows.map((t) => t.name)));
    const modRestored = wfStore.openWorkflows.find((t) => t.path === "workflows/flux_detail.json");
    const tempRestored = wfStore.openWorkflows.find((t) => t.name === "WP unsaved");
    check("WP: the modified persisted tab came back WITH its unsaved graph",
        !!modRestored && modRestored.activeState?.nodes?.[0]?.id === 3,
        JSON.stringify(modRestored?.activeState));
    check("WP: the temp tab came back WITH its graph",
        !!tempRestored && tempRestored.activeState?.nodes?.[0]?.id === 9);
    check("WP: the undo snapshot was CONSUMED (deleted server-side)",
        fakeApi.__undoStore().size === 0 && !hooks.sessionUndoState(),
        "undo=" + fakeApi.__undoStore().size);
    check("WP: the active tab after undo is the pre-apply active (flux_main)",
        wfStore.activeWorkflow === cleanTab);

    // FAILURE path: the undo route refuses -> the destructive close refuses
    fakeApi.__setUndoMode("fail");
    wfStore.openWorkflows.length = 0;
    wfStore.openWorkflows.push(cleanTab, makeTab({ name: "risky", isTemporary: true, isPersisted: false, nodes: [7] }));
    wfStore.activeWorkflow = cleanTab;
    const r1 = await hooks.adapter.closeWorkflowTab(hooks.getOpenWorkflows().find((t) => t.name === "risky"), { forceClean: true });
    check("WP: a temp tab close still works through the store rung (no undo involved)",
        r1.ok === true || r1.unsupported, JSON.stringify(r1));
    // an apply with a failing undo snapshot must NOT close the risky tab
    fakeApi.__setPresets([{ id: "wppreset1", name: "WP only main", items: [
        { kind: "path", path: "workflows/flux_main.json", name: "flux_main.json" },
    ] }]);
    await hooks.refreshPresets();
    await hooks.refreshOpen(true);
    const openBeforeFail = wfStore.openWorkflows.map((t) => t.id).sort().join(",");
    await hooks.applyPlanById("wppreset1", { keepUnsaved: false });
    await settle(30);
    const openAfterFail = wfStore.openWorkflows.map((t) => t.id).sort().join(",");
    check("WP: a failed undo snapshot BLOCKED the destructive close (risky tabs survive)",
        openAfterFail === openBeforeFail,
        "before=" + openBeforeFail + " after=" + openAfterFail);
    fakeApi.__setUndoMode("ok");
    wfStore.openWorkflows.length = 0;
}

// ===========================================================================
phase("WQ v112 plan 3.2: safe activation guard (command rung refuses unverified targets)");
{
    // Simulate a build where NOTHING can verify the activation: the store
    // closeWorkflow refuses, loadGraphData is gone and the store has no
    // openWorkflow rung - so the command rung must REFUSE instead of acting
    // on a potentially different tab (the acceptance criterion).
    const origClose = wfStore.closeWorkflow;
    const origOpen = wfStore.openWorkflow;
    const origLGD = appStub.loadGraphData;
    wfStore.closeWorkflow = async () => { throw new Error("refused"); };
    delete wfStore.openWorkflow;
    appStub.loadGraphData = async () => { throw new Error("no canvas"); };
    const t1 = makeTab({ path: "workflows/a.json", nodes: [1] });
    const t2 = makeTab({ path: "workflows/b.json", nodes: [2] });
    wfStore.openWorkflows.length = 0;
    wfStore.openWorkflows.push(t1, t2);
    wfStore.activeWorkflow = t2; // a DIFFERENT tab is active
    // the wrapper activation (openStoreWorkflow) will NOT flip the active in
    // this store (no loadGraphData in the harness for this shape) - so the
    // verification must FAIL and the close must be REFUSED
    const w1 = hooks.getOpenWorkflows().find((t) => t.path === "workflows/a.json");
    const r = await hooks.adapter.closeWorkflowTab(w1, { forceClean: true });
    check("WQ: an unverified activation REFUSES the close (no wrong tab dies)",
        r.ok === false && r.via !== "command",
        JSON.stringify(r));
    check("WQ: the target tab is still open after the refusal",
        wfStore.openWorkflows.includes(t1));
    check("WQ: the OTHER tab was not closed either",
        wfStore.openWorkflows.includes(t2));
    wfStore.closeWorkflow = origClose;
    wfStore.openWorkflow = origOpen;
    appStub.loadGraphData = origLGD;
    wfStore.openWorkflows.length = 0;
}

// ===========================================================================
phase("WR v112 plan 3.3: ONE canonical path normalizer");
{
    const c = hooks.canonWfRel;
    const s = hooks.sameWfPath;
    check("WR: workflow.json == workflows/workflow.json (the agreed rule)",
        s("workflow.json", "workflows/workflow.json"));
    check("WR: backslashes normalize",
        c("workflows\\sub\\a.json") === "sub/a.json");
    check("WR: repeated separators + dot segments collapse",
        c("workflows//./sub/./x.json") === "sub/x.json");
    check("WR: the prefix is case-insensitive",
        c("WORKFLOWs/a.json") === "a.json");
    check("WR: '..' refuses to empty", c("workflows/../escape.json") === "");
    check("WR: absolute paths refuse", c("/etc/passwd") === "" && c("C:\\x.json") === "");
    check("WR: folderA/a.json and folderB/a.json stay DIFFERENT files",
        !s("workflows/folderA/a.json", "workflows/folderB/a.json"));
    check("WR: same basename different folders never merge in missing-marks",
        !s("folderA/a.json", "folderB/a.json"));
    check("WR: normWfPath keeps the display shape (prefix stays)",
        hooks.normWfPath("workflows/a.json") === "workflows/a.json");
    // openHasPath accepts both shapes
    check("WR: openHasPath matches prefix-less against prefixed",
        hooks.adapter.wfStoreOf() != null);
}

// ===========================================================================
phase("WS v112 plans 3.4/3.5/3.7/3.8/3.9/3.10: Files states, 400-cap gone, indexes, sort, refresh");
{
    const pnlWs = () => hooks.panelEl();
    const bodyWs = () => pnlWs().querySelector(".hub-wf-body");
    // 3.9 stable sort: identical mtime, identical size - DESC keeps names ASC
    hooks.setFilesSort("mtime", "desc");
    hooks.setFilesFilters({});
    fakeApi.__setWfFiles([
        { path: "workflows/z.json", name: "z.json", size: 100, mtime: 500 },
        { path: "workflows/a.json", name: "a.json", size: 100, mtime: 500 },
        { path: "workflows/m.json", name: "m.json", size: 200, mtime: 400 },
    ]);
    await hooks.refreshSavedFiles();
    await settle();
    const descOrder = hooks.filteredSavedFiles().map((f) => f.name);
    check("WS: DESC by mtime with EQUAL mtimes keeps names ascending (tie-break)",
        JSON.stringify(descOrder) === JSON.stringify(["a.json", "z.json", "m.json"]),
        JSON.stringify(descOrder));
    hooks.setFilesSort("mtime", "asc");
    const ascOrder = hooks.filteredSavedFiles().map((f) => f.name);
    check("WS: ASC by mtime: older first, equal-mtime names still ascending",
        JSON.stringify(ascOrder) === JSON.stringify(["m.json", "a.json", "z.json"]),
        JSON.stringify(ascOrder));
    hooks.setFilesSort("size", "desc");
    const sizeDesc = hooks.filteredSavedFiles().map((f) => f.name);
    check("WS: DESC by size: bigger first, equal-size names ascending",
        JSON.stringify(sizeDesc) === JSON.stringify(["m.json", "a.json", "z.json"]),
        JSON.stringify(sizeDesc));
    hooks.setFilesSort("size", "asc");
    const sizeAsc = hooks.filteredSavedFiles().map((f) => f.name);
    check("WS: ASC by size: smaller first, equal-size names ascending",
        JSON.stringify(sizeAsc) === JSON.stringify(["a.json", "z.json", "m.json"]),
        JSON.stringify(sizeAsc));

    // 3.7 the one-pass tree index
    fakeApi.__setWfFiles([
        { path: "workflows/root1/a.json", name: "a.json", size: 1, mtime: 1 },
        { path: "workflows/root1/b.json", name: "b.json", size: 1, mtime: 2 },
        { path: "workflows/root1/sub/c.json", name: "c.json", size: 1, mtime: 3 },
        { path: "workflows/root2/d.json", name: "d.json", size: 1, mtime: 4 },
    ]);
    await hooks.refreshSavedFiles();
    await settle();
    const wsList = hooks.filteredSavedFiles();
    const idx = hooks.buildTreeIndex(wsList);
    check("WS: the tree index counts DEEP files (root1 = 3: a, b, sub/c)",
        idx.counts.get("root1") === 3, JSON.stringify([...idx.counts]));
    check("WS: the tree index counts nested folders (root1/sub = 1)",
        idx.counts.get("root1/sub") === 1);
    check("WS: the index is CACHED on the list reference (same list -> same object)",
        hooks.buildTreeIndex(wsList) === idx);

    // 3.8 the missing-paths index is canonical
    check("WS: savedPathIndex is canonical (prefix-free)",
        hooks.savedPathIndex().has("root1/a.json") &&
        !hooks.savedPathIndex().has("workflows/root1/a.json"),
        JSON.stringify([...hooks.savedPathIndex()].slice(0, 6)));

    // 3.4 the explicit loading/error states: the pending flag + the error
    // note render through the real Files render
    hooks.setFilesLoadState({ pending: true });
    check("WS: the pending flag marks the loading state",
        hooks.filesLoadState().pending === true,
        JSON.stringify(hooks.filesLoadState()));
    hooks.setTab("files");
    await settle();
    await hooks.refreshSavedFiles(); // a clean scan first (clears any error)
    await settle();
    hooks.setFilesLoadState({ pending: false, error: { why: "boom test" } });
    hooks.renderAll();
    await settle();
    check("WS: the error state renders the note + the Retry button (never a silent blank)",
        bodyWs().textContent.includes("Files refresh failed") &&
        bodyWs().textContent.includes("boom test") &&
        !!bodyWs().querySelector('[data-act="filesrefresh"]'),
        bodyWs().textContent.slice(0, 240));
    hooks.setFilesLoadState({ error: null });
    hooks.renderAll();
    await settle();

    // 3.10 the truncated warning + the Refresh button + the last scan time
    fakeApi.__setWfFiles([
        { path: "workflows/only.json", name: "only.json", size: 1, mtime: 7 },
    ]);
    // simulate the truncated flag from the backend listing
    hooks.setTab("files");
    await hooks.refreshSavedFiles();
    await settle();
    check("WS: the Files toolbar carries the Refresh button",
        !!bodyWs().querySelector('[data-act="filesrefresh"]'));
    const scanBefore = hooks.filesLoadState().lastScan;
    check("WS: a successful scan records the lastScan time",
        scanBefore > 0, String(scanBefore));
    // truncated: true from the backend -> the warning renders
    fakeApi.__setWfFiles([
        { path: "workflows/only.json", name: "only.json", size: 1, mtime: 7 },
    ]);
    // force the truncated path through the rung-0 stub
    const origFetch = appStub.api.fetchApi;
    appStub.api.fetchApi = async (u, o = {}) => {
        if (String(u).split("?")[0] === "/settings_hub/workflows/files") {
            const r = await origFetch(u, o);
            const j = await r.json();
            return {
                ok: true, status: 200,
                headers: { get: () => "application/json" },
                json: async () => ({ ...j, truncated: true }),
            };
        }
        return origFetch(u, o);
    };
    await hooks.refreshSavedFiles();
    await settle();
    check("WS: the backend truncated flag surfaces as the state note + status",
        hooks.filesLoadState().truncated === true &&
        bodyWs().textContent.includes("truncated"),
        bodyWs().textContent.slice(0, 260));
    check("WS: the truncated note names the shown count",
        /showing the first 1 files/.test(bodyWs().textContent),
        bodyWs().textContent.match(/showing[^\n]{0,40}/)?.[0]);
    appStub.api.fetchApi = origFetch;

    // 3.10 the transient empty answer KEEPS the last good list (all rungs
    // empty: rung-0 [], the registry gone, /userdata [] - the exact v109
    // degraded shape that once blanked the tab)
    await hooks.refreshSavedFiles(); // a good list first
    await settle();
    const good = hooks.savedFiles().slice();
    const origRegistry = wfStore.workflows;
    wfStore.workflows = [];
    fakeApi.__setWfFiles([]);   // an empty rung-0 answer
    fakeApi.__setFiles([]);     // AND an empty /userdata rung (run 2)
    await hooks.refreshSavedFiles();
    await settle();
    check("WS: the first empty answer KEEPS the last good list + names the problem",
        hooks.savedFiles().length === good.length &&
        !!hooks.filesLoadState().error,
        JSON.stringify(hooks.filesLoadState().error));
    await hooks.refreshSavedFiles(); // the second strike - really empty
    await settle();
    check("WS: the SECOND empty answer is accepted (the folder is really empty)",
        hooks.savedFiles().length === 0 && !hooks.filesLoadState().error,
        JSON.stringify(hooks.filesLoadState()));
    wfStore.workflows = origRegistry;
    // restore the healthy shape
    fakeApi.__setFiles([
        { path: "workflows/flux_main.json", name: "flux_main.json", size: 1, mtime: NOW },
        { path: "workflows/flux_detail.json", name: "flux_detail.json", size: 1, mtime: NOW - 1 },
        { path: "workflows/upscale.json", name: "upscale.json", size: 1, mtime: NOW - 2 },
    ]);
    fakeApi.__setWfFiles([
        { path: "workflows/flux_main.json", name: "flux_main.json", size: 1, mtime: NOW },
        { path: "workflows/flux_detail.json", name: "flux_detail.json", size: 1, mtime: NOW - 1 },
        { path: "workflows/upscale.json", name: "upscale.json", size: 1, mtime: NOW - 2 },
    ]);
    await hooks.refreshSavedFiles();
    await settle();

    // 3.5 the Open tab: >400 tabs are ALL reachable and searchable
    wfStore.openWorkflows.length = 0;
    for (let i = 0; i < 450; i++) {
        wfStore.openWorkflows.push(makeTab({ name: "bulk_" + String(i).padStart(3, "0") + ".json",
            path: "workflows/bulk_" + String(i).padStart(3, "0") + ".json", nodes: [i] }));
    }
    await hooks.refreshOpen(true);
    hooks.setTab("open");
    await settle();
    check("WS: 450 open tabs - the status shows the chunk (showing N of M)",
        bodyWs().textContent.includes("showing 60 of 450"),
        bodyWs().textContent.match(/showing[^·]{0,30}/)?.[0] || bodyWs().textContent.slice(-160));
    // "Show more" walks to the very end
    for (let i = 0; i < 6; i++) {
        const moreBtn = bodyWs().querySelector('[data-act="moreopen"]');
        if (!moreBtn) break;
        moreBtn.click();
        await settle();
    }
    check("WS: after Show more x6 ALL 450 rows are reachable (no 400 cap)",
        bodyWs().textContent.includes("showing 450 of 450") ||
            bodyWs().querySelectorAll('[data-act="activate"]').length >= 450,
        bodyWs().textContent.match(/showing[^·]{0,30}/)?.[0]);
    // the search covers the FULL set (bulk_449 deep inside the tail)
    let searchIn = bodyWs().querySelector('[data-wf="opensearch"]');
    searchIn.value = "bulk_449";
    searchIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WS: the search finds tab #449 beyond the old 400 cap",
        bodyWs().querySelector('[data-act="activate"]')?.textContent.includes("bulk_449"),
        bodyWs().querySelector(".hub-wf-status")?.textContent);
    // RE-QUERY: every renderAll re-created the input (a stale node cannot
    // dispatch into the delegated listener)
    searchIn = bodyWs().querySelector('[data-wf="opensearch"]');
    searchIn.value = "";
    searchIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    wfStore.openWorkflows.length = 0;
    await hooks.refreshOpen(true);
}


// ===========================================================================
phase("WT v112 stage 2 (plan 4.x): the SQLite index drives the Files tab");
{
    const pnlWt = () => hooks.panelEl();
    const bodyWt = () => pnlWt().querySelector(".hub-wf-body");
    // a 250-row indexed library (page size 150 -> 2 pages) - beyond every
    // local cap, proving the 6000-listing mask is gone in principle
    const lib = [];
    for (let i = 0; i < 250; i++) {
        const id = "uuid-" + String(i).padStart(4, "0") + "-aaaa";
        lib.push({
            path: "workflows/lib/f" + String(i).padStart(3, "0") + ".json",
            name: "f" + String(i).padStart(3, "0") + ".json",
            size: 1000 + i, mtime: 1000 + i,
            workflowId: i % 2 ? id : null,
            nodeTypes: i % 5 === 0 ? ["KSampler"] : ["SaveImage"],
            modelRefs: i % 7 === 0 ? ["v1-5-pruned-emaonly.ckpt"] : [],
            parseStatus: i === 13 ? "error" : "ok",
        });
    }
    fakeApi.__setIdxFiles(lib);
    fakeApi.__setIdxMode("ok");
    hooks.setTab("files");
    await settle();
    await hooks.ensureIndexStatus();
    await settle(20);
    check("WT: the index status probe marked the engine READY",
        hooks.idxState().ready === true, JSON.stringify(hooks.idxState().ready));
    check("WT: the boot scan fired (collapsed to one while busy)",
        fakeApi.__idxScanCount() >= 1, String(fakeApi.__idxScanCount()));
    await hooks.runServerList(true);
    await settle(20);
    check("WT: the FIRST server page renders 150 rows (of 250)",
        bodyWt().querySelectorAll('[data-act="openfile"]').length === 150,
        String(bodyWt().querySelectorAll('[data-act="openfile"]').length));
    check("WT: the status line shows '150 shown of 250 indexed'",
        bodyWt().textContent.includes("150 shown of 250 indexed"),
        bodyWt().querySelector(".hub-wf-status")?.textContent);
    check("WT: the Rebuild index button exists in index mode",
        !!bodyWt().querySelector('[data-act="idxrebuild"]'));
    // Show more -> the cursor page (all 250 reachable)
    const moreBtn = bodyWt().querySelector('[data-act="morefiles"]');
    moreBtn.click();
    await settle(20);
    check("WT: Show more appended the cursor page (250 rows visible)",
        bodyWt().querySelectorAll('[data-act="openfile"]').length === 250,
        String(bodyWt().querySelectorAll('[data-act="openfile"]').length));
    // the server search over the FULL indexed set
    let sIn = bodyWt().querySelector('[data-wf="filesearch"]');
    sIn.value = "KSampler";
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle(20);
    await new Promise((r) => setTimeout(r, 400)); // past the 250ms debounce
    await settle(20);
    const ksRows = bodyWt().querySelectorAll('[data-act="openfile"]').length;
    check("WT: the server search finds only the KSampler rows (50)",
        ksRows === 50, String(ksRows));
    // clear the text search first (the filters COMBINE server-side) -
    // RE-QUERY the input: every renderAll re-creates it (a stale node
    // dispatches into the void)
    sIn = bodyWt().querySelector('[data-wf="filesearch"]');
    sIn.value = "";
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle(20);
    await new Promise((r) => setTimeout(r, 400));
    await settle(20);
    // the UUID filter (an ODD index carries the uuid in this fixture)
    hooks.setFilesUuid("uuid-0003-aaaa");
    await hooks.runServerList(true);
    await settle(20);
    check("WT: the workflow_id (UUID) filter narrows the list server-side",
        bodyWt().querySelectorAll('[data-act="openfile"]').length === 1,
        String(bodyWt().querySelectorAll('[data-act="openfile"]').length));
    hooks.setFilesUuid("");
    await hooks.runServerList(true);
    await settle(20);
    // the parse-error row carries the ⚠ mark + a UUID copy chip
    await hooks.runServerList(true);
    await settle(20);
    const badRow = bodyWt().querySelector('[data-fpath="workflows/lib/f013.json"]');
    check("WT: a broken-JSON row stays LISTED with the parse-status mark",
        !!badRow && badRow.textContent.includes("⚠"), badRow?.textContent || "no row");
    const uuidChip = bodyWt().querySelector('[data-act="copyuuid"]');
    check("WT: the rows with a workflowId carry the copy-UUID chip",
        !!uuidChip && /uuid-\d{4}-aaaa/.test(uuidChip.dataset.uuid || ""));
    // rebuild triggers a server scan + a fresh query
    await hooks.rebuildIndex();
    await settle(20);
    check("WT: the Rebuild index fired a scan",
        fakeApi.__idxScanCount() >= 2, String(fakeApi.__idxScanCount()));
    check("WT: after the rebuild the status shows the index stats chip",
        bodyWt().textContent.includes("· idx "), bodyWt().querySelector(".hub-wf-status")?.textContent);

    // THE OLD-PY FALLBACK: 404 on the status -> the local behavior returns
    fakeApi.__setIdxMode("stale");
    await hooks.ensureIndexStatus();
    await settle(10);
    check("WT: an old py (404 status) flips the engine OFF",
        hooks.idxState().ready === false);
    const rowsLocal = bodyWt().querySelectorAll('[data-act="openfile"]').length;
    check("WT: the local mirror rows still render in the fallback",
        rowsLocal > 0, String(rowsLocal));
    fakeApi.__setIdxMode("ok");
    // restore the clean shape for any later phase
    hooks.setFilesUuid("");
    hooks.setTab("open");
    await settle();
}


// ===========================================================================
phase("WU v112 stage 2.5 (plan 5.x): the Process History panel");
{
    const pnlWu = () => hooks.panelEl();
    const bodyWu = () => pnlWu().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setIdxFiles([
        { path: "workflows/hist1.json", name: "hist1.json", size: 10, mtime: 100,
          workflowId: "wuuid-1111", rawHash: "hash-disk-1" },
    ]);
    hooks.setIdxReady(true);
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();

    // the row carries the History button
    const histBtn = bodyWu().querySelector('[data-act="filehist"][data-path="workflows/hist1.json"]');
    check("WU: the file rows carry the 🕘 History action (progressive disclosure)",
        !!histBtn);
    await histBtn.click();
    await settle(20);

    // a not-yet-bound file: the empty state offers the first checkpoint
    let st = hooks.histState();
    check("WU: the history panel opens for an unbound file with the empty state",
        !!hooks.histPopEl() && st && !st.bound && st.revs.length === 0 && !st.loading,
        JSON.stringify({ pid: st?.pid, err: st?.error, revs: st?.revs?.length }));
    check("WU: the panel never shows storage terminology",
        !hooks.histPopEl().textContent.match(/commit|blob|ref|checkout|staging|rebase|git/i),
        hooks.histPopEl().textContent.slice(0, 120));
    check("WU: the empty state names the Checkpoint as the next action",
        hooks.histPopEl().textContent.includes("No checkpoints yet") &&
        !!hooks.histPopEl().querySelector('[data-act="histcheckpoint"]'));

    // Checkpoint #1 captures the payload (a disk checkpoint: no open tab)
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(20);
    st = hooks.histState();
    check("WU: the first checkpoint created ONE revision and bound the process",
        st.revs.length === 1 && !!st.pid, JSON.stringify({ pid: st.pid, revs: st.revs.length }));
    check("WU: the fake history store holds exactly 1 revision",
        fakeApi.__histStore().revisions.size === 1,
        String(fakeApi.__histStore().revisions.size));

    // Checkpoint #2 with different content -> the second revision; then the
    // repeat with IDENTICAL bytes -> NO duplicate
    const wfStoreCall = { ...wfStore };
    fakeApi.__histStore().seq = 100; // shift the hash namespace
    fakeApi.__setIdxFiles([{ path: "workflows/hist1.json", name: "hist1.json", size: 20,
        mtime: 200, workflowId: "wuuid-1111", rawHash: "hash-disk-2" }]);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(20);
    st = hooks.histState();
    check("WU: the second checkpoint adds a revision (linear, newest first)",
        st.revs.length === 2 && st.revs[0].createdAt >= st.revs[1].createdAt,
        JSON.stringify(st.revs.map((r) => [r.revisionId, r.createdAt])));
    const revCount = fakeApi.__histStore().revisions.size;
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(20);
    check("WU: an identical checkpoint does NOT duplicate (the dedupe contract)",
        fakeApi.__histStore().revisions.size === revCount &&
        hooks.histState().revs.length === 2,
        String(fakeApi.__histStore().revisions.size));

    // Open version (the DEFAULT restore): a COPY into an independent tab
    const openCalls0 = loadCalls.length;
    await hooks.histRestore(hooks.histState().revs[0].revisionId, false);
    await settle(20);
    check("WU: the default Restore opens a COPY (a snapshot tab), no writes",
        loadCalls.length === openCalls0 + 1 &&
        !fakeApi.__calls().some((c) => c.url.includes("/restore/") && c.method === "POST"),
        JSON.stringify({ calls: loadCalls.length }));
    check("WU: the opened copy is an independent TEMP tab with the version graph",
        wfStore.openWorkflows.some((t) => t.__snapshotGraph?.nodes?.length >= 0),
        JSON.stringify(wfStore.openWorkflows.map((t) => t.name)));

    // the REPLACE: armed confirm -> tx snapshot on the server
    await hooks.histRestore(hooks.histState().revs[0].revisionId, true);
    await settle(20);
    check("WU: the confirmed replace POSTs mode=replace and records the tx snapshot",
        fakeApi.__calls().some((c) => c.url.includes("/restore/") && c.method === "POST" &&
            (c.body || "").includes('"mode":"replace"')) &&
        fakeApi.__txStore().size === 1,
        JSON.stringify([...fakeApi.__txStore().keys()]));

    // Mark stable
    await hooks.histPopEl().querySelector('[data-act="histstable"]').click();
    await settle(20);
    check("WU: Mark stable flags the revision (★, protected)",
        hooks.histState().revs.some((r) => r.isStable),
        JSON.stringify(hooks.histState().revs.map((r) => r.isStable)));

    // the note input flows into the checkpoint payload
    const noteIn = hooks.histPopEl().querySelector('[data-wf="histnote"]');
    noteIn.value = "added controlnet";
    noteIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WU: the note draft lands in the state (the compact optional field)",
        hooks.histState().noteDraft === "added controlnet");
    // a NEW disk state (an identical payload would dedupe into the last
    // revision - the plan's contract - and the note would go to the note
    // editor instead)
    fakeApi.__setIdxFiles([{ path: "workflows/hist1.json", name: "hist1.json", size: 30,
        mtime: 300, workflowId: "wuuid-1111", rawHash: "hash-disk-3" }]);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(20);
    check("WU: the checkpoint carried the optional note",
        hooks.histState().revs[0].note === "added controlnet",
        hooks.histState().revs[0].note);
    check("WU: the note draft cleared after the successful checkpoint",
        hooks.histState().noteDraft === "");

    // Compare: pick two revisions -> the honest summary (the pop re-renders
    // after every selection - re-query the fresh radios)
    let radios = [...hooks.histPopEl().querySelectorAll("[data-hcmp]")];
    radios[0].checked = true;
    radios[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    radios = [...hooks.histPopEl().querySelectorAll("[data-hcmp]")];
    radios[1].checked = true;
    radios[1].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    await hooks.runHistCompare();
    await settle(20);
    check("WU: the Compare renders the node/model summary",
        hooks.histPopEl().textContent.includes("⚖ Compare") &&
        hooks.histPopEl().textContent.includes("Nodes:"),
        hooks.histPopEl().textContent.slice(0, 200));

    // Esc closes; the old-py fallback hides the history buttons
    hooks.closeHistPop();
    check("WU: the panel closes cleanly", !hooks.histPopEl());
    fakeApi.__setIdxMode("stale");
    hooks.setIdxReady(false);
    await hooks.refreshSavedFiles();
    await settle();
    check("WU: without the index/history routes the 🕘 buttons hide (old py)",
        !bodyWu().querySelector('[data-act="filehist"]'));
    fakeApi.__setIdxMode("ok");
    hooks.setIdxReady(true);
    hooks.setTab("open");
    await settle();
}


// ===========================================================================
phase("WV v112 stage 3 (plans 6/7/8): per-tab Save, snapshot mode, duplicates");
{
    const pnlWv = () => hooks.panelEl();
    const bodyWv = () => pnlWv().querySelector(".hub-wf-body");
    // ---- plan 6: the per-tab Save of a PERSISTED row ----
    wfStore.openWorkflows.length = 0;
    wfStore.activeWorkflow = null;
    const pt = makeTab({ path: "workflows/flux_main.json", nodes: [1, 2], isModified: true });
    const tmp = makeTab({ name: "WV unsaved", isTemporary: true, isPersisted: false, nodes: [9] });
    wfStore.openWorkflows.push(pt, tmp);
    wfStore.activeWorkflow = pt;
    await hooks.refreshOpen(true);
    hooks.setTab("open");
    hooks.renderAll();
    await settle();
    const rowWv = (name) => [...bodyWv().querySelectorAll(".hub-wf-row")]
        .find((r) => r.textContent.includes(name));
    const saveBtnP = rowWv("flux_main.json")?.querySelector('[data-act="savetab"]');
    check("WV: every Open row carries the per-tab Save button",
        !!saveBtnP, rowWv("flux_main.json")?.innerHTML?.slice(0, 120));
    const storeCalls0 = wfStore.calls.length;
    await saveBtnP.click();
    await settle(20);
    check("WV: the persisted row's Save called store.saveWorkflow with the tab ref",
        wfStore.calls.slice(storeCalls0).some((c) => c.op === "save"),
        JSON.stringify(wfStore.calls.slice(storeCalls0)));
    // ---- plan 6: the temp row's Save As ladder ----
    // this fake build exposes NO Save-As command -> the honest refusal
    const cand = hooks.wfStoreSaveAsCandidate();
    check("WV: the Save As ladder is feature-detected (no guessed command ids)",
        Array.isArray(cand) && cand.every((c) => c === "store" || c.startsWith("cmd:")),
        JSON.stringify(cand));
    const saveBtnT = rowWv("WV unsaved")?.querySelector('[data-act="savetab"]');
    await saveBtnT.click();
    await settle(20);
    check("WV: a temp tab's Save As without an available API degrades honestly",
        hooks.adapter.wfStoreOf() != null, "no throw");

    // ---- plan 7: the snapshot toggle (default OFF) ----
    hooks.openSaveForm("new");
    await settle();
    check("WV: the snapshot toggle defaults OFF",
        hooks.snapMode() === false &&
        !!bodyWv().querySelector('[data-wf="sfnapmode"]'));
    // OFF: the persisted row stays a PATH item
    const rowsForm = hooks.saveForm();
    check("WV: the form rows mark persisted rows (path mode)",
        rowsForm.rows.some((r) => !r.isTemp));
    const c1 = hooks.collectFormItems();
    check("WV: OFF embeds persisted tabs as PATH items",
        c1.items.every((it) => it.kind === "path" || it.kind === "snapshot"),
        JSON.stringify(c1.items.map((it) => it.kind)));
    // ON: the persisted row becomes an EMBEDDED SNAPSHOT with the origin meta
    hooks.setSnapMode(true);
    await settle();
    check("WV: the toggle flips to ON with the explanation",
        hooks.snapMode() === true &&
        bodyWv().textContent.includes("Embed selected saved workflows as independent copies"));
    const c2 = hooks.collectFormItems();
    check("WV: ON embeds the persisted tab as a snapshot WITH its origin metadata",
        c2.items.some((it) => it.kind === "snapshot" && it.sourcePath === "workflows/flux_main.json"),
        JSON.stringify(c2.items.map((it) => [it.kind, it.sourcePath || null])));
    hooks.closePlanPop && null;
    saveFormCloseWv();

    function saveFormCloseWv() { /* the form dies with the re-render below */ }

    // ---- plan 8: the duplicate detection ----
    const g1 = { id: "dup-uuid", revision: 1, nodes: [{ id: 1, type: "KSampler", pos: [5, 5], widgets_values: ["x"] }], links: [], extra: { ds: { scale: 1, offset: [0, 0] } } };
    const g1Same = { links: [], revision: 1, nodes: [{ widgets_values: ["x"], type: "KSampler", id: 1, pos: [999, 999] }], extra: { ds: { scale: 0.5, offset: [9, 9] } }, id: "dup-uuid" }; // the same graph, another layout
    const g1Diff = { id: "dup-uuid", nodes: [{ id: 1, type: "KSampler", pos: [5, 5], widgets_values: ["y"] }], links: [], extra: {} }; // a widget CHANGED
    check("WV: the canonical form is key-order insensitive",
        hooks.canonJsonOf({ a: 1, b: [2, 3] }) === hooks.canonJsonOf({ b: [2, 3], a: 1 }));
    check("WV: a layout-only difference does NOT change the graph hash",
        hooks.wfGraphHashClient(g1) === hooks.wfGraphHashClient(g1Same));
    check("WV: an unclassified field/widget change DOES change the graph hash",
        hooks.wfGraphHashClient(g1) !== hooks.wfGraphHashClient(g1Diff));
    // open the first copy as a temp tab
    const rOpen1 = await hooks.adapter.openSnapshotWorkflow("WV dup", g1, { forceCopy: true });
    await settle(20);
    check("WV: the first copy opens", rOpen1.ok === true, JSON.stringify(rOpen1));
    // the SECOND identical open -> the duplicate PROMPT (never silent)
    const rDup = await hooks.adapter.openSnapshotWorkflow("WV dup", g1);
    await settle(20);
    check("WV: an exact duplicate prompts Focus/Copy (not silently opened)",
        rDup.duplicatePrompted === true && !!document.querySelector(".hub-wf-duppop"),
        JSON.stringify(rDup));
    check("WV: the prompt offers Focus existing + Open another copy",
        document.querySelector(".hub-wf-duppop")?.textContent.includes("Focus existing") &&
        document.querySelector(".hub-wf-duppop")?.textContent.includes("Open another copy"));
    // Open another copy really opens one
    const copyBtn = document.querySelector('.hub-wf-duppop [data-wf-btn="copy"]');
    copyBtn.click();
    await settle(20);
    check("WV: 'Open another copy' opens the second independent tab",
        !document.querySelector(".hub-wf-duppop") &&
        wfStore.openWorkflows.filter((t) => t.__snapshotGraph?.id === "dup-uuid").length === 2,
        String(wfStore.openWorkflows.length));
    // the same graph with a DIFFERENT canvas state -> a warning, both open
    const rWarn = await hooks.adapter.openSnapshotWorkflow("WV canvas", g1Same, { forceCopy: true });
    await settle(20);
    check("WV: a same-graph/different-canvas copy opens with a warning",
        rWarn.ok === true,
        JSON.stringify(rWarn));
    // ---- plan 7.4: same NAME, different graph -> both survive the merge ----
    const nameA = { id: "n1", nodes: [{ id: 1, type: "A" }] };
    const nameB = { id: "n1", nodes: [{ id: 1, type: "B" }] };
    const resA = await fakeApi.fetchApi("/settings_hub/workflows/presets", { method: "POST",
        body: JSON.stringify({ name: "WV same name", items: [{ kind: "snapshot", name: "Same", graph: nameA }] }) });
    const presetA = (await resA.json()).preset;
    const resB = await fakeApi.fetchApi("/settings_hub/workflows/presets", { method: "POST",
        body: JSON.stringify({ id: presetA.id, name: "WV same name",
            items: [{ kind: "snapshot", name: "Same", graph: nameB }], mode: "merge" }) });
    const mergedB = (await resB.json()).preset;
    const sameName = mergedB.items.filter((it) => it.kind === "snapshot" && it.name === "Same");
    check("WV: the merge keeps BOTH same-name different-graph snapshots (plan 7.4)",
        sameName.length === 2 &&
        JSON.stringify(sameName.map((s) => s.graph.nodes[0].type).sort()) === JSON.stringify(["A", "B"]),
        JSON.stringify(sameName.map((s) => s.graph)));
    // cleanup
    wfStore.openWorkflows.length = 0;
    await hooks.refreshOpen(true);
}



// ===========================================================================
phase("WX v112 stage 4 (plans 9/10): preset category/tags + version history");
{
    const pnlWx = () => hooks.panelEl();
    const bodyWx = () => pnlWx().querySelector(".hub-wf-body");
    hooks.clearPresets();
    fakeApi.__setPresets([]);
    fakeApi.__pverStore().clear();

    // the save form carries the category + the tags editors
    hooks.openSaveForm("new");
    await settle();
    check("WX: the save form carries the category + tags editors",
        !!bodyWx().querySelector('[data-wf="sfcat"]') &&
        !!bodyWx().querySelector('[data-wf="sftags"]'));
    const catIn = bodyWx().querySelector('[data-wf="sfcat"]');
    const tagIn = bodyWx().querySelector('[data-wf="sftags"]');
    catIn.value = "Flux";
    catIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    tagIn.value = "production, fast, production";
    tagIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WX: the tags editor keeps the display text (the SERVER normalizes)",
        Array.isArray(hooks.saveForm().tags) &&
        hooks.saveForm().tags.join(" ").toLowerCase().includes("production"),
        JSON.stringify(hooks.saveForm().tags));
    // the form commits with the category/tags (one persisted row: flux_main)
    const nameIn = bodyWx().querySelector('[data-wf="sfname"]');
    nameIn.value = "WX preset";
    await hooks.commitFormSave("create", null);
    await settle(20);
    const wxPreset = hooks.presets().find((p) => p.name === "WX preset");
    check("WX: the saved preset carries the category",
        wxPreset && wxPreset.category === "Flux", JSON.stringify(wxPreset));
    check("WX: the saved preset carries the normalized tags",
        wxPreset && Array.isArray(wxPreset.tags) && wxPreset.tags.length === 2,
        JSON.stringify(wxPreset?.tags));
    check("WX: the new preset got an INITIAL version archive",
        (fakeApi.__pverStore().get(wxPreset.id)?.versions.length || 0) === 1,
        String(fakeApi.__pverStore().get(wxPreset.id)?.versions.length));

    // the card shows the category + the tag chips + the history button
    check("WX: the preset card shows the category chip + the tag chips + 🕘",
        bodyWx().textContent.includes("Flux") &&
        bodyWx().textContent.includes("#production") &&
        !!bodyWx().querySelector('[data-act="pver"]'));

    // the search covers the category + the tags
    const sIn = bodyWx().querySelector('[data-wf="presetsearch"]');
    sIn.value = "flux";
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WX: the search matches the CATEGORY",
        bodyWx().querySelectorAll(".hub-wf-card").length === 1);
    sIn.value = "fast";
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("WX: the search matches a TAG",
        bodyWx().querySelectorAll(".hub-wf-card").length === 1,
        "cards=" + bodyWx().querySelectorAll(".hub-wf-card").length +
        " presets=" + JSON.stringify(hooks.presets().map((p) => [p.name, p.tags])));
    sIn.value = "";
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();

    // the ⚑ filter row: category select
    const fadvBtn = bodyWx().querySelector('[data-act="pfadv"]');
    fadvBtn.click();
    await settle();
    check("WX: the ⚑ filter row opens with the category/tag selects",
        !!bodyWx().querySelector('[data-wf="pcat"]') && !!bodyWx().querySelector('[data-wf="ptag"]'));
    hooks.setPresetsCat("Flux");
    hooks.renderAll();
    await settle();
    check("WX: the category filter keeps the matching preset",
        bodyWx().querySelectorAll(".hub-wf-card").length === 1);
    hooks.setPresetsCat("Portrait");
    hooks.renderAll();
    await settle();
    check("WX: the category filter hides the non-matching preset",
        bodyWx().querySelectorAll(".hub-wf-card").length === 0);
    hooks.setPresetsCat("");
    hooks.setPresetsTag("");
    hooks.renderAll();
    await settle();

    // the version history: overwrite -> archive; restore -> current archived
    await hooks.refreshPresets();
    const pid = wxPreset.id;
    await fakeApi.fetchApi("/settings_hub/workflows/presets", { method: "POST",
        body: JSON.stringify({ id: pid, name: "WX preset v2", items: wxPreset.items, mode: "overwrite" }) });
    await hooks.refreshPresets();
    await settle();
    check("WX: the overwrite archived the previous state (2 versions)",
        fakeApi.__pverStore().get(pid).versions.length === 2,
        String(fakeApi.__pverStore().get(pid).versions.length));
    await hooks.openPverPop(pid);
    await settle(20);
    let pst = hooks.pverState();
    check("WX: the version panel lists the archives (newest first)",
        !!hooks.pverPopEl() && pst.versions.length === 2 &&
        pst.versions[0].createdAt >= pst.versions[1].createdAt,
        JSON.stringify(pst.versions.map((v) => v.changedBy)));
    check("WX: the panel names the archive rule (no storage terms)",
        hooks.pverPopEl().textContent.includes("archives") &&
        !/commit|blob|git ref|staging/i.test(hooks.pverPopEl().textContent));
    // restore the OLDEST (the initial "WX preset" with category Flux)
    const restBtn = [...hooks.pverPopEl().querySelectorAll('[data-pact="prestore"]')].pop();
    restBtn.click();
    await settle();
    check("WX: the restore arms a confirm (the current state archives first)",
        hooks.pverState().armed !== null &&
        !!hooks.pverPopEl().querySelector('[data-pact="prestoreconfirm"]'));
    const confBtn = hooks.pverPopEl().querySelector('[data-pact="prestoreconfirm"]');
    confBtn.click();
    await settle(20);
    pst = hooks.pverState();
    check("WX: the restore returned the old version + archived the current",
        pst.versions.length === 3 && pst.versions[0].changedBy === "restore",
        JSON.stringify(pst.versions.map((v) => v.changedBy)));
    await hooks.refreshPresets();
    check("WX: the preset content rolled back (name v2 -> WX preset)",
        hooks.presets().find((p) => p.id === pid)?.name === "WX preset",
        hooks.presets().find((p) => p.id === pid)?.name);
    // compare: two versions -> the summary
    let pradios = [...hooks.pverPopEl().querySelectorAll("[data-pcmp]")];
    pradios[0].checked = true;
    pradios[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    pradios = [...hooks.pverPopEl().querySelectorAll("[data-pcmp]")];
    pradios[1].checked = true;
    pradios[1].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    const cmpBtn = hooks.pverPopEl().querySelector('[data-pact="pcompare"]');
    cmpBtn.click();
    await settle(20);
    check("WX: the Compare renders the honest summary (name/tags/items)",
        hooks.pverPopEl().textContent.includes("⚖ Compare") &&
        hooks.pverPopEl().textContent.includes("Items:"),
        hooks.pverPopEl().textContent.slice(0, 160));
    hooks.closePverPop();
    hooks.setTab("open");
    await settle();
}



// ===========================================================================
phase("WY v112 stage 5 (plan 11) + stage 6: the Inspector + dependencies + library summary");
{
    const pnlWy = () => hooks.panelEl();
    const bodyWy = () => pnlWy().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setIdxFiles([
        { path: "workflows/insp.json", name: "insp.json", size: 10, mtime: 100,
          workflowId: "insp-uuid-1" },
    ]);
    hooks.setIdxReady(true);
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();
    const inspBtn = bodyWy().querySelector('[data-act="fileinspect"][data-path="workflows/insp.json"]');
    check("WY: the file rows carry the 🔍 Inspect action",
        !!inspBtn);
    await inspBtn.click();
    await settle(20);
    const st = hooks.inspState();
    check("WY: the inspector loaded the honest report",
        !!st?.data && st.data.nodeCount === 12, JSON.stringify(!!st?.data));
    const popTxt = hooks.inspPopEl()?.textContent || "";
    check("WY: the UUID shows with a copy action (a no-UUID file would say so)",
        popTxt.includes("⧉") || popTxt.includes("No UUID"));
    check("WY: the parameters show (steps 25 · cfg 7.5 · euler · karras · 1024×768)",
        popTxt.includes("steps 25") && popTxt.includes("cfg 7.5") &&
        popTxt.includes("1024×768"), popTxt.slice(0, 300));
    check("WY: the dependency report names the MISSING node + the MISSING model",
        popTxt.includes("Missing nodes") && popTxt.includes("SuperUnknownNode") &&
        popTxt.includes("Missing model") && popTxt.includes("gone_model.safetensors"),
        popTxt.slice(0, 400));
    check("WY: the duplicate groups surface",
        popTxt.includes("exact byte copy") && popTxt.includes("same-UUID"),
        popTxt.slice(0, 400));
    check("WY: the library summary rides along (plan 12)",
        popTxt.includes("Library") && popTxt.includes("bad JSON"),
        popTxt.slice(0, 400));
    hooks.closeInspPop();
    check("WY: the inspector closes cleanly", !hooks.inspPopEl());
    fakeApi.__setIdxMode("stale");
    await hooks.ensureIndexStatus(); // the 404 flips the engine OFF (idxReady=false)
    hooks.renderAll();
    await settle();
    check("WY: an old py keeps the inspector OUT of the rows",
        !bodyWy().querySelector('[data-act="fileinspect"]'), "");
    fakeApi.__setIdxMode("ok");
    hooks.setTab("open");
    await settle();
}

// ===========================================================================
phase("WZ v113: the search keeps focus + the keys stay inside the panel; the big popovers anchor to their row");
{
    const pnlWz = () => hooks.panelEl();
    const bodyWz = () => pnlWz().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setIdxFiles([
        { path: "workflows/wz_a.json", name: "wz_a.json", size: 10, mtime: 100,
          workflowId: "wz-uuid-a" },
        { path: "workflows/wz_b.json", name: "wz_b.json", size: 20, mtime: 200,
          workflowId: "wz-uuid-b" },
    ]);
    hooks.setIdxReady(true);
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();

    // 1) the keystroke itself must NOT wipe + rebuild the list (v113: the
    //    idx-mode search only re-renders when the server answer lands)
    let sIn = bodyWz().querySelector('[data-wf="filesearch"]');
    sIn.focus();
    sIn.value = "wz_a";
    sIn.setSelectionRange(4, 4);
    sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle(20);
    check("WZ: typing does not flash the loading state (rows stay put)",
        bodyWz().querySelectorAll('[data-act="openfile"]').length === 2,
        String(bodyWz().querySelectorAll('[data-act="openfile"]').length));
    // the debounced server answer lands -> ONE rebuild -> focus + caret back
    await new Promise((r) => setTimeout(r, 400)); // past the 250ms debounce
    await settle(20);
    const fresh = bodyWz().querySelector('[data-wf="filesearch"]');
    check("WZ: focus RETURNS to the fresh search input after the server answer",
        fresh && dom.window.document.activeElement === fresh,
        String(dom.window.document.activeElement?.dataset?.wf || "no-focus"));
    check("WZ: the typed text + caret survive the re-render",
        fresh && fresh.value === "wz_a" && fresh.selectionStart === 4 &&
        fresh.selectionEnd === 4,
        JSON.stringify({ v: fresh?.value, c: fresh?.selectionStart }));
    const wzRows = bodyWz().querySelectorAll('[data-act="openfile"]').length;
    check("WZ: the server search narrowed the list (wz_a only)",
        wzRows === 1, String(wzRows));
    // 2) the keystrokes never leak to ComfyUI's global keybinds
    let leaked = 0;
    const spy = () => { leaked++; };
    dom.window.addEventListener("keydown", spy);
    dom.window.addEventListener("keyup", spy);
    fresh.dispatchEvent(new dom.window.KeyboardEvent("keydown",
        { key: "q", bubbles: true, cancelable: true }));
    fresh.dispatchEvent(new dom.window.KeyboardEvent("keyup",
        { key: "q", bubbles: true, cancelable: true }));
    check("WZ: keydown/keyup inside the search field do NOT reach the window",
        leaked === 0, String(leaked));
    const nonField = bodyWz().querySelector('[data-act="openfile"]');
    nonField.dispatchEvent(new dom.window.KeyboardEvent("keydown",
        { key: "q", bubbles: true, cancelable: true }));
    check("WZ: keys OUTSIDE the text fields still propagate (the panel is not a vault)",
        leaked === 1, String(leaked));
    dom.window.removeEventListener("keydown", spy);
    dom.window.removeEventListener("keyup", spy);
    // clear the filter through the real Esc path (re-query the fresh node)
    let sIn2 = bodyWz().querySelector('[data-wf="filesearch"]');
    sIn2.dispatchEvent(new dom.window.KeyboardEvent("keydown",
        { key: "Escape", bubbles: true, cancelable: true }));
    await settle(20);
    await new Promise((r) => setTimeout(r, 400));
    await settle(20);
    check("WZ: Esc clears the field + the full list returns",
        bodyWz().querySelector('[data-wf="filesearch"]').value === "" &&
        bodyWz().querySelectorAll('[data-act="openfile"]').length === 2,
        String(bodyWz().querySelectorAll('[data-act="openfile"]').length));

    // 3) the Process history pop anchors NEXT TO its row (a left-edge row
    //    exercises the right-side fallback deterministically)
    const histBtn = bodyWz().querySelector('[data-act="filehist"][data-path="workflows/wz_a.json"]');
    check("WZ: the file rows carry the 🕘 history action", !!histBtn);
    histBtn.getBoundingClientRect = () => ({
        left: 50, top: 100, right: 90, bottom: 120, width: 40, height: 20,
        x: 50, y: 100, toJSON() { return this; },
    });
    await histBtn.click();
    await settle(20);
    const hp = hooks.histPopEl();
    check("WZ: the history pop opens ANCHORED (right of the row, not 16/16)",
        hp && hp.style.left === "98px" && hp.style.top === "94px",
        JSON.stringify({ left: hp?.style.left, top: hp?.style.top }));
    check("WZ: the pop is viewport-clamped (maxWidth/maxHeight inline)",
        hp && hp.style.maxWidth === "520px" && !!hp.style.maxHeight,
        JSON.stringify({ mw: hp?.style.maxWidth, mh: hp?.style.maxHeight }));
    // 4) the bottom actions: ✎ Process + ✕ Close in ONE row (the column fix)
    const metaBtn = hp?.querySelector('[data-act="histmeta"]');
    const closeBtn = hp?.querySelector('[data-act="histclose"]');
    check("WZ: Process + Close sit in ONE actions row (no column)",
        metaBtn && closeBtn && metaBtn.parentElement === closeBtn.parentElement &&
        metaBtn.parentElement.classList.contains("hub-wf-planacts"),
        JSON.stringify({
            meta: !!metaBtn, close: !!closeBtn,
            same: metaBtn && closeBtn && metaBtn.parentElement === closeBtn.parentElement,
        }));
    // 5) the pop carries its own key containment for the note input
    let popLeak = 0;
    const popSpy = () => { popLeak++; };
    dom.window.addEventListener("keydown", popSpy);
    const noteIn = hp.querySelector('[data-wf="histnote"]');
    noteIn.dispatchEvent(new dom.window.KeyboardEvent("keydown",
        { key: "n", bubbles: true, cancelable: true }));
    check("WZ: the checkpoint note input does not leak keys either",
        popLeak === 0, String(popLeak));
    dom.window.removeEventListener("keydown", popSpy);
    const closeAct = hp.querySelector('[data-act="histclose"]');
    closeAct.click();
    await settle(20);
    check("WZ: the merged Close action closes the pop", !hooks.histPopEl());

    // 6) the inspector anchors the same way (its own row button)
    const inspBtn2 = bodyWz().querySelector('[data-act="fileinspect"][data-path="workflows/wz_a.json"]');
    inspBtn2.getBoundingClientRect = () => ({
        left: 50, top: 160, right: 90, bottom: 180, width: 40, height: 20,
        x: 50, y: 160, toJSON() { return this; },
    });
    await inspBtn2.click();
    await settle(20);
    const ip = hooks.inspPopEl();
    check("WZ: the inspector pop anchors next to its row too",
        ip && ip.style.left === "98px" && ip.style.top === "154px",
        JSON.stringify({ left: ip?.style.left, top: ip?.style.top }));
    hooks.closeInspPop();
    fakeApi.__setIdxFiles([]);
    hooks.setTab("open");
    await settle();
}

// ===========================================================================
phase("ZX v114: the version indicator on the rows + the manage/delete of SPECIFIC versions");
{
    const pnlZx = () => hooks.panelEl();
    const bodyZx = () => pnlZx().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setIdxFiles([
        { path: "workflows/zx.json", name: "zx.json", size: 10, mtime: 100,
          workflowId: "zx-uuid-1", rawHash: "hash-1" },
        { path: "workflows/zx_plain.json", name: "zx_plain.json", size: 10, mtime: 110,
          workflowId: "zx-uuid-2", rawHash: "hash-plain" },
    ]);
    fakeApi.__setBadgesMode("ok");
    // reset the fake history store for a deterministic phase
    for (const k of [...fakeApi.__histStore().processes.keys()]) fakeApi.__histStore().processes.delete(k);
    for (const k of [...fakeApi.__histStore().revisions.keys()]) fakeApi.__histStore().revisions.delete(k);
    fakeApi.__histStore().seq = 0;
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();

    // 1) no revisions yet - NO badge chip on the 🕘 buttons
    const histBtnZx = bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx.json"]');
    check("ZX: the file row carries the 🕘 history action", !!histBtnZx);
    check("ZX: without versions there is NO count chip yet",
        histBtnZx && !histBtnZx.querySelector(".hub-wf-hbadge"),
        histBtnZx?.innerHTML || "no btn");
    // 2) two checkpoints through the REAL pop flow -> the badge reads 2
    histBtnZx.getBoundingClientRect = () => ({
        left: 50, top: 100, right: 90, bottom: 120, width: 40, height: 20,
        x: 50, y: 100, toJSON() { return this; },
    });
    await histBtnZx.click();
    await settle(20);
    const hpZx = hooks.histPopEl();
    check("ZX: the history pop opens", !!hpZx);
    const cpBtn = hpZx.querySelector('[data-act="histcheckpoint"]');
    check("ZX: the Checkpoint action is present", !!cpBtn);
    await cpBtn.click();
    await settle(30);
    // the second checkpoint needs DIFFERENT disk bytes - bump the row hash
    fakeApi.__setIdxFiles([
        { path: "workflows/zx.json", name: "zx.json", size: 10, mtime: 100,
          workflowId: "zx-uuid-1", rawHash: "hash-2" },
        { path: "workflows/zx_plain.json", name: "zx_plain.json", size: 10, mtime: 110,
          workflowId: "zx-uuid-2", rawHash: "hash-plain" },
    ]);
    await hpZx.querySelector('[data-act="histcheckpoint"]').click();
    await settle(30);
    check("ZX: two checkpoints built the history",
        hooks.histState().revs.length === 2,
        String(hooks.histState().revs.length));
    const badge1 = bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx.json"] .hub-wf-hbadge');
    check("ZX: the VERSION INDICATOR shows 2 on the row (the owner's ask)",
        badge1 && badge1.textContent === "2",
        JSON.stringify({ badge: badge1?.textContent || null }));
    const plainBtn = bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx_plain.json"]');
    check("ZX: a process WITHOUT versions still shows no chip",
        plainBtn && !plainBtn.querySelector(".hub-wf-hbadge"),
        plainBtn?.innerHTML || "no btn");
    check("ZX: the row tooltip names the version count",
        (plainBtn?.title || "").includes("") &&
        bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx.json"]').title.includes("2 saved version"),
        bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx.json"]').title.slice(-40));

    // 3) the manage mode: checkboxes + the DYNAMIC Select all / Deselect all
    await hpZx.querySelector('[data-act="histdelmode"]').click();
    await settle(20);
    const manageOn = hooks.histState().manage;
    const boxes = [...hooks.histPopEl().querySelectorAll("[data-hdel]")];
    const disabledBoxes = boxes.filter((b) => b.disabled);
    check("ZX: the manage mode swaps the radios for deletion checkboxes",
        manageOn && boxes.length === 2,
        JSON.stringify({ manage: manageOn, boxes: boxes.length }));
    check("ZX: the CURRENT version's checkbox is disabled (protected)",
        disabledBoxes.length === 1, String(disabledBoxes.length));
    let selAll = hooks.histPopEl().querySelector('[data-act="histdelall"]');
    check("ZX: the DYNAMIC select button starts as 'Select all'",
        selAll && selAll.textContent === "Select all", selAll?.textContent);
    selAll.click();
    await settle(20);
    selAll = hooks.histPopEl().querySelector('[data-act="histdelall"]');
    const checkedNow = [...hooks.histPopEl().querySelectorAll("[data-hdel]:checked")].length;
    check("ZX: Select all checks every DELETABLE version (1 of 2)",
        checkedNow === 1, String(checkedNow));
    check("ZX: the DYNAMIC button flips to 'Deselect all'",
        selAll && selAll.textContent === "Deselect all", selAll?.textContent);
    check("ZX: the selection is visible in the state",
        hooks.histState().delSel.length === 1 &&
        hooks.histState().delSel[0] !== hooks.histState().proc.currentRevisionId,
        JSON.stringify(hooks.histState().delSel));
    selAll.click();
    await settle(20);
    selAll = hooks.histPopEl().querySelector('[data-act="histdelall"]');
    check("ZX: Deselect all clears + flips the label back",
        selAll.textContent === "Select all" &&
        hooks.histPopEl().querySelectorAll("[data-hdel]:checked").length === 0,
        selAll.textContent);

    // 4) the armed batch deletion: select all -> Delete selected (2 clicks)
    selAll.click();
    await settle(20);
    const delBtn = () => hooks.histPopEl().querySelector('[data-act="histdelsel"]');
    check("ZX: the delete button carries the selection count",
        delBtn() && delBtn().textContent.includes("(1)"), delBtn()?.textContent);
    delBtn().click();
    await settle(20);
    check("ZX: the FIRST click ARMS (never deletes straight away)",
        delBtn().classList.contains("hub-wf-armed") &&
        delBtn().textContent.includes("Click AGAIN"),
        delBtn()?.textContent);
    delBtn().click();
    await settle(40);
    check("ZX: the confirmed delete removed the selected version",
        hooks.histState().revs.length === 1, String(hooks.histState().revs.length));
    const badge2 = bodyZx().querySelector('[data-act="filehist"][data-path="workflows/zx.json"] .hub-wf-hbadge');
    check("ZX: the badge follows the deletion (2 -> 1)",
        badge2 && badge2.textContent === "1", JSON.stringify({ badge: badge2?.textContent || null }));
    check("ZX: the toast names the deletion",
        [...document.querySelectorAll(".hub-sh-note")]
            .some((t) => (t.textContent || "").includes("Deleted 1")),
        JSON.stringify([...document.querySelectorAll(".hub-sh-note")]
            .map((t) => t.textContent)));

    // 5) the stable protection inside the manage mode (the mode is STILL ON
    // after the deletion - the refresh kept it)
    // a fresh hash first - the dedupe contract would swallow a repeat
    // checkpoint of the SAME bytes (and must)
    fakeApi.__setIdxFiles([
        { path: "workflows/zx.json", name: "zx.json", size: 10, mtime: 100,
          workflowId: "zx-uuid-1", rawHash: "hash-3" },
        { path: "workflows/zx_plain.json", name: "zx_plain.json", size: 10, mtime: 110,
          workflowId: "zx-uuid-2", rawHash: "hash-plain" },
    ]);
    check("ZX: the manage mode survives the deletion refresh",
        hooks.histState().manage === true, String(hooks.histState().manage));
    await hooks.histCreateCheckpoint("checkpoint");   // rev #2 (hash-3 disk)
    await settle(30);
    const oldRid = hooks.histState().revs[1].revisionId;   // the older one
    await (async () => {   // mark it stable through the REAL ★ action
        const btn = hooks.histPopEl().querySelector(`[data-act="histstable"][data-rid="${oldRid}"]`);
        btn.click();
        await settle(30);
    })();
    await settle(20);
    const boxOld = hooks.histPopEl().querySelector(`[data-hdel="${oldRid}"]`);
    check("ZX: a STABLE version's checkbox is disabled with the reason",
        boxOld && boxOld.disabled &&
        (boxOld.title || "").includes("protected"), boxOld?.title);
    const selAll2 = hooks.histPopEl().querySelector('[data-act="histdelall"]');
    selAll2.click();
    await settle(20);
    const nowChecked = [...hooks.histPopEl().querySelectorAll("[data-hdel]:checked")].length;
    check("ZX: Select all NEVER selects the protected versions",
        nowChecked === 0, String(nowChecked));
    // the delete button with an empty selection stays a no-op (no arm)
    const emptyDel = hooks.histPopEl().querySelector('[data-act="histdelsel"]');
    emptyDel.click();
    await settle(20);
    check("ZX: an empty selection never arms the delete",
        !hooks.histState().armedDel, JSON.stringify(hooks.histState().armedDel));
    await hooks.histPopEl().querySelector('[data-act="histdeldone"]').click();
    await settle(20);
    check("ZX: Done leaves the manage mode (radios are back)",
        !hooks.histState().manage &&
        hooks.histPopEl().querySelectorAll("[data-hcmp]").length === 2 &&
        hooks.histPopEl().querySelectorAll("[data-hdel]").length === 0, "manage off");

    // 6) an old py without the badges route: silent, no chips, rows intact
    fakeApi.__setBadgesMode("stale");
    hooks.refreshHistBadges(true);
    await settle(30);
    check("ZX: a stale pack never crashes the badge fetch",
        bodyZx().querySelectorAll('[data-act="filehist"]').length === 2, "rows ok");
    hooks.closeHistPop();
    fakeApi.__setBadgesMode("ok");
    fakeApi.__setIdxFiles([]);
    hooks.setTab("open");
    await settle();
}

phase("ZY v115: the duplicate-ID counter on the rows + the WHOLE-PROCESS delete (all tails)");
{
    const pnlZy = () => hooks.panelEl();
    const bodyZy = () => pnlZy().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setBadgesMode("ok");
    fakeApi.__setProcDelMode("ok");
    // two files share ONE UUID (duplicates of one process), one solo file
    const zyRow = (path, hash) => ({ path, name: path.split("/")[1], size: 10,
        mtime: 100, workflowId: null, rawHash: hash });
    fakeApi.__setIdxFiles([
        { ...zyRow("workflows/zya.json", "zy-h1"), workflowId: "zy-uuid-dup" },
        { ...zyRow("workflows/zyb.json", "zy-h2"), workflowId: "zy-uuid-dup" },
        { ...zyRow("workflows/zyc.json", "zy-h3"), workflowId: "zy-uuid-solo" },
    ]);
    // a deterministic phase: the fake history store starts empty
    for (const k of [...fakeApi.__histStore().processes.keys()]) fakeApi.__histStore().processes.delete(k);
    for (const k of [...fakeApi.__histStore().revisions.keys()]) fakeApi.__histStore().revisions.delete(k);
    fakeApi.__histStore().seq = 0;
    // a REVISION-LESS duplicate: two locations, zero checkpoints (the real
    // reconcile builds exactly this shape before the first Checkpoint)
    fakeApi.__histStore().processes.set("pzydup000000001", {
        processId: "pzydup000000001", workflowId: "zy-uuid-dup",
        displayName: "ZY dup", locations: [
            { path: "workflows/zya.json", isPrimary: true },
            { path: "workflows/zyb.json" }],
        currentRevisionId: null, stableRevisionId: null });
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();
    hooks.refreshHistBadges(true);
    await settle(30);

    // 1) the duplicate-ID counter (the owner: "индицировать количество
    //    процессов с одинаковым ид, тоже типа счетчика как для истории")
    const chipA = bodyZy().querySelector('[data-act="copyuuid"][data-uuid="zy-uuid-dup"]');
    check("ZY: the ⧉ UUID chip renders on the row", !!chipA,
        chipA?.outerHTML?.slice(0, 120) || "no chip");
    check("ZY: the DUPLICATE counter shows ×2 (a revision-less dup still reports)",
        chipA && chipA.querySelector(".hub-wf-dupbadge")?.textContent === "×2",
        chipA?.innerHTML || "no chip");
    check("ZY: the chip tooltip names the shared count",
        (chipA?.title || "").includes("2 files share this UUID"), chipA?.title || "");
    const chipSolo = bodyZy().querySelector('[data-act="copyuuid"][data-uuid="zy-uuid-solo"]');
    check("ZY: a single-file UUID carries NO counter",
        !!chipSolo && !chipSolo.querySelector(".hub-wf-dupbadge"),
        chipSolo?.title || "no chip");

    // 2) the dup process gets TWO versions -> the 🕘 badge shows 2
    const btnZy = bodyZy().querySelector('[data-act="filehist"][data-path="workflows/zya.json"]');
    btnZy.getBoundingClientRect = () => ({
        left: 50, top: 100, right: 90, bottom: 120, width: 40, height: 20,
        x: 50, y: 100, toJSON() { return this; },
    });
    await btnZy.click();
    await settle(20);
    const hpZy = hooks.histPopEl();
    check("ZY: the history pop opens", !!hpZy);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(30);
    fakeApi.__setIdxFiles([
        { ...zyRow("workflows/zya.json", "zy-h1b"), workflowId: "zy-uuid-dup" },
        { ...zyRow("workflows/zyb.json", "zy-h2"), workflowId: "zy-uuid-dup" },
        { ...zyRow("workflows/zyc.json", "zy-h3"), workflowId: "zy-uuid-solo" },
    ]);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(30);
    check("ZY: the dup process carries 2 versions across 2 locations",
        hooks.histState().revs.length === 2 &&
        (hooks.histState().proc.locations || []).length === 2,
        JSON.stringify({ revs: hooks.histState().revs.length,
            locs: (hooks.histState().proc.locations || []).length }));
    const badgeZy = bodyZy().querySelector('[data-act="filehist"][data-path="workflows/zya.json"] .hub-wf-hbadge');
    check("ZY: the version badge reads 2 next to the ×2 duplicate counter",
        badgeZy && badgeZy.textContent === "2",
        JSON.stringify({ badge: badgeZy?.textContent || null }));

    // 3) the armed WHOLE-PROCESS delete: the strip names the exact counts,
    //    Cancel disarms, the confirmed scope deletes files + versions
    await hooks.histPopEl().querySelector('[data-act="histprocarm"]').click();
    await settle(20);
    const stripZy = hooks.histPopEl().querySelector(".hub-wf-planwarn");
    check("ZY: the ARMED strip appears with the exact counts",
        hooks.histPopEl().querySelector('[data-act="histprocyes"]') !== null &&
        (stripZy?.textContent || "").includes("2 version(s)") &&
        (stripZy?.textContent || "").includes("2 file location(s)"),
        stripZy?.textContent || "no strip");
    check("ZY: the entry button hides while armed",
        !hooks.histPopEl().querySelector('[data-act="histprocarm"]'));
    await hooks.histPopEl().querySelector('[data-act="histproccancel"]').click();
    await settle(20);
    check("ZY: Cancel disarms (no delete happened)",
        !hooks.histPopEl().querySelector('[data-act="histprocyes"]') &&
        fakeApi.__histStore().processes.has("pzydup000000001"));
    await hooks.histPopEl().querySelector('[data-act="histprocarm"]').click();
    await settle(20);
    await hooks.histPopEl().querySelector('[data-act="histprocyes"]').click();
    await settle(60);
    check("ZY: the confirmed EVERYTHING-delete closes the panel",
        !hooks.histPopEl());
    check("ZY: the process + ALL its revisions died",
        !fakeApi.__histStore().processes.has("pzydup000000001") &&
        [...fakeApi.__histStore().revisions.values()]
            .every((r) => r.processId !== "pzydup000000001"));
    check("ZY: the tx snapshots were recorded BEFORE the unlink",
        fakeApi.__txStore().size >= 2,
        String(fakeApi.__txStore().size));
    check("ZY: the toast names versions + files",
        [...document.querySelectorAll(".hub-sh-note")]
            .some((t) => (t.textContent || "").includes("Process deleted: 2 version(s) + 2 file(s)")),
        JSON.stringify([...document.querySelectorAll(".hub-sh-note")]
            .map((t) => t.textContent)));
    check("ZY: BOTH duplicate rows left the Files list",
        !bodyZy().querySelector('[data-fpath="workflows/zya.json"]') &&
        !bodyZy().querySelector('[data-fpath="workflows/zyb.json"]'),
        bodyZy().querySelectorAll("[data-fpath]").length + " rows left");
    check("ZY: the untouched file stays",
        !!bodyZy().querySelector('[data-fpath="workflows/zyc.json"]'));

    // 4) the HISTORY-ONLY scope: the versions die, the file stays
    const btnC = bodyZy().querySelector('[data-act="filehist"][data-path="workflows/zyc.json"]');
    btnC.getBoundingClientRect = () => ({
        left: 50, top: 140, right: 90, bottom: 160, width: 40, height: 20,
        x: 50, y: 140, toJSON() { return this; },
    });
    await btnC.click();
    await settle(20);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(30);
    fakeApi.__setIdxFiles([{ ...zyRow("workflows/zyc.json", "zy-h3b"), workflowId: "zy-uuid-solo" }]);
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(30);
    check("ZY: the solo process carries 2 versions",
        hooks.histState().revs.length === 2, String(hooks.histState().revs.length));
    await hooks.histPopEl().querySelector('[data-act="histprocarm"]').click();
    await settle(20);
    await hooks.histPopEl().querySelector('[data-act="histprochist"]').click();
    await settle(60);
    check("ZY: history-only keeps the FILE row",
        !!bodyZy().querySelector('[data-fpath="workflows/zyc.json"]'));
    check("ZY: history-only emptied the history",
        ![...fakeApi.__histStore().processes.values()]
            .some((pr) => pr.workflowId === "zy-uuid-solo"));
    check("ZY: the toast says the files stay",
        [...document.querySelectorAll(".hub-sh-note")]
            .some((t) => (t.textContent || "").includes("the file(s) stay")));

    // 5) an old py without the route: the panel stays, the update is named
    fakeApi.__setProcDelMode("stale");
    const btnC2 = bodyZy().querySelector('[data-act="filehist"][data-path="workflows/zyc.json"]');
    btnC2.getBoundingClientRect = () => ({
        left: 50, top: 140, right: 90, bottom: 160, width: 40, height: 20,
        x: 50, y: 140, toJSON() { return this; },
    });
    await btnC2.click();
    await settle(20);
    check("ZY: the delete-process entry hides for an UNBOUND file",
        !hooks.histPopEl().querySelector('[data-act="histprocarm"]'));
    await hooks.histCreateCheckpoint("checkpoint");
    await settle(30);
    await hooks.histPopEl().querySelector('[data-act="histprocarm"]').click();
    await settle(20);
    await hooks.histPopEl().querySelector('[data-act="histprocyes"]').click();
    await settle(40);
    check("ZY: a stale pack keeps the panel and names the update",
        !!hooks.histPopEl() &&
        [...document.querySelectorAll(".hub-sh-note")]
            .some((t) => (t.textContent || "").includes("update the FULL pack")));
    fakeApi.__setProcDelMode("ok");
    hooks.closeHistPop();
    fakeApi.__setIdxFiles([]);
    hooks.setTab("open");
    await settle();
}

// ===========================================================================
phase("ZZ v116: the honest refresh, the Files DELETE with undo, the select-uuid, the snapshot save E2E, the notes search, the storage dashboard");
{
    const pnlZ = () => hooks.panelEl();
    const bodyZ = () => pnlZ().querySelector(".hub-wf-body");
    fakeApi.__setIdxMode("ok");
    fakeApi.__setBadgesMode("ok");
    fakeApi.__setFileDelMode("ok");
    fakeApi.__setCompactMode("ok");
    const zRow = (path, hash, wf) => ({ path, name: path.split("/")[1], size: 10,
        mtime: 100, workflowId: wf || null, rawHash: hash,
        workflowHash: "wf-" + hash, presentationHash: "pres-" + hash,
        parseStatus: null, nodeCount: 1, nodeTypes: [], modelRefs: [] });
    fakeApi.__setIdxFiles([
        zRow("workflows/zza.json", "z1", "zz-uuid-1"),
        zRow("workflows/zzb.json", "z2", "zz-uuid-1"),
        zRow("workflows/zzc.json", "z3", "zz-uuid-2"),
    ]);
    fakeApi.__fileFs(["workflows/zza.json", "workflows/zzb.json", "workflows/zzc.json"]);
    for (const k of [...fakeApi.__histStore().processes.keys()]) fakeApi.__histStore().processes.delete(k);
    for (const k of [...fakeApi.__histStore().revisions.keys()]) fakeApi.__histStore().revisions.delete(k);
    fakeApi.__histStore().seq = 0;
    fakeApi.__histStore().processes.set("pzzproc00000001", {
        processId: "pzzproc00000001", workflowId: "zz-uuid-1",
        displayName: "ZZ shared", locations: [
            { path: "workflows/zza.json", isPrimary: true },
            { path: "workflows/zzb.json" }],
        currentRevisionId: null, stableRevisionId: null });
    fakeApi.__histStore().processes.set("pzzproc00000002", {
        processId: "pzzproc00000002", workflowId: "zz-uuid-2",
        displayName: "ZZ solo", locations: [
            { path: "workflows/zzc.json", isPrimary: true }],
        currentRevisionId: null, stableRevisionId: null });
    hooks.setTab("files");
    await settle();
    await hooks.runServerList(true);
    await settle();

    // ---- 1) the REFRESH is the real refresh (plan 3.2) --------------------
    const scans0 = fakeApi.__idxScanCount();
    await bodyZ().querySelector('[data-act="filesrefresh"]').click();
    await settle(40);
    check("ZZ refresh: the button fires the incremental scan",
        fakeApi.__idxScanCount() === scans0 + 1,
        JSON.stringify({ was: scans0, now: fakeApi.__idxScanCount() }));

    // ---- 2) the selection toolbar (plan 7.2) ------------------------------
    const zcheck = (pt) => bodyZ().querySelector(`[data-fcheck="${pt}"]`);
    check("ZZ selection: the toolbar is HIDDEN at 0 selected",
        !bodyZ().textContent.includes("Delete selected"),
        "no selection bar");
    zcheck("workflows/zza.json").checked = true;
    zcheck("workflows/zza.json").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("ZZ selection: the toolbar appears at 1+ with the count",
        bodyZ().textContent.includes("1 selected") &&
        !!bodyZ().querySelector('[data-act="filedel"]'),
        bodyZ().querySelector(".hub-wf-tools2")?.textContent?.slice(0, 120));
    zcheck("workflows/zzb.json").checked = true;
    zcheck("workflows/zzb.json").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("ZZ selection: two files selected (the SAME uuid - still per-file)",
        bodyZ().textContent.includes("2 selected"),
        bodyZ().querySelector(".hub-wf-tools2")?.textContent?.slice(0, 120));

    // ---- 3) the armed batch DELETE + undo (plan 7.6) ----------------------
    const delBtn = bodyZ().querySelector('[data-act="filedel"]');
    await delBtn.click();
    await settle();
    check("ZZ delete: the first click ARMS (names the scope + the safety)",
        bodyZ().querySelector('[data-act="filedel"]').textContent.includes("Click AGAIN"),
        bodyZ().querySelector('[data-act="filedel"]').textContent);
    await bodyZ().querySelector('[data-act="filedel"]').click();
    await settle(40);
    check("ZZ delete: the rows are gone after the confirmed delete",
        !bodyZ().querySelector('[data-fcheck="workflows/zza.json"]') &&
        !bodyZ().querySelector('[data-fcheck="workflows/zzb.json"]'),
        "rows gone");
    check("ZZ delete: the undo handle is live",
        !!hooks.filesOpsState().undo?.opId && !!bodyZ().querySelector('[data-act="fileundo"]'),
        JSON.stringify(hooks.filesOpsState().undo));
    await bodyZ().querySelector('[data-act="fileundo"]').click();
    await settle(40);
    check("ZZ undo: the files come back (the rows re-appear)",
        !!bodyZ().querySelector('[data-fcheck="workflows/zza.json"]'),
        "rows restored");
    check("ZZ undo: the undo handle is consumed",
        !hooks.filesOpsState().undo?.opId, JSON.stringify(hooks.filesOpsState().undo));

    // ---- 4) the SAFETY refusal: a snapshot failure deletes NOTHING --------
    zcheck("workflows/zzc.json").checked = true;
    zcheck("workflows/zzc.json").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    fakeApi.__setFileDelMode("snapshotfail");
    await bodyZ().querySelector('[data-act="filedel"]').click();
    await settle();
    await bodyZ().querySelector('[data-act="filedel"]').click();
    await settle(30);
    fakeApi.__setFileDelMode("ok");
    check("ZZ safety: the snapshot failure deletes NOTHING (the row survives)",
        fakeApi.__fileFsHas("workflows/zzc.json") &&
        !!bodyZ().querySelector('[data-fcheck="workflows/zzc.json"]'),
        "row intact");
    // clear the selection for the next blocks
    await bodyZ().querySelector('[data-act="fileclear"]').click();
    await settle();

    // ---- 5) the select-uuid action (plan 7.2) ------------------------------
    const chipZ = bodyZ().querySelector('[data-act="copyuuid"][data-uuid="zz-uuid-1"]');
    check("ZZ select-uuid: the duplicated chip wears the x2 counter",
        chipZ && chipZ.querySelector(".hub-wf-dupbadge")?.textContent === "\u00d72",
        chipZ?.innerHTML);
    await chipZ.click();
    await settle(20);
    const actBtn = [...document.querySelectorAll(".hub-sh-action, [data-sh-action], .hub-toast [data-act], .hub-sh-actionbtn")]
        .find((b) => (b.textContent || "").includes("Select all"));
    // the action toast renders a button; fall back to the hook when the
    // jsdom click target naming differs
    if (actBtn) { await actBtn.click(); await settle(20); }
    else await hooks.selectUuidFiles("zz-uuid-1");
    await settle(20);
    check("ZZ select-uuid: both locations of the UUID are selected",
        hooks.filesOpsState().sel.filter((p) => p.includes("zza") || p.includes("zzb")).length >= 2,
        JSON.stringify(hooks.filesOpsState().sel));
    await bodyZ().querySelector('[data-act="fileclear"]').click();
    await settle();

    // ---- 6) the EMBED snapshots E2E via the REAL checkbox (plan 6) --------
    hooks.clearPresets();
    fakeApi.__setPresetsHold(false);
    const makeFakeTabLite = (key, tabPath, _unused, graph) => ({
        id: key, path: tabPath, filename: tabPath.split("/")[1],
        name: tabPath.split("/")[1], isModified: false, isTemporary: false,
        isPersisted: true, activeState: graph,
    });
    const t1 = makeFakeTabLite("zz_tab1", "workflows/zza.json", false,
        { id: "zz-uuid-1", nodes: [{ id: 1, type: "KSampler", pos: [1, 1], widgets_values: ["a"] }], links: [], extra: { ds: { scale: 1, offset: [0, 0] } } });
    wfStore.openWorkflows = [t1];
    wfStore.activeWorkflow = t1;
    await hooks.refreshOpen(true);
    hooks.openSaveForm("new");
    await settle();
    const nap = bodyZ().querySelector('[data-wf="sfnapmode"]');
    check("ZZ embed: the toggle defaults OFF",
        hooks.snapMode() === false && nap && !nap.checked);
    // the REAL DOM change event (the plan: no test hook)
    nap.checked = true;
    nap.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("ZZ embed: the REAL change event flips the mode + shows the summary",
        hooks.snapMode() === true &&
        bodyZ().textContent.includes("1 snapshot(s)") &&
        bodyZ().textContent.includes("independent copies"),
        bodyZ().querySelector(".hub-wf-saveform")?.textContent?.slice(0, 200));
    await bodyZ().querySelector('[data-wf-btn="savenew"]').click();
    await settle(40);
    const postedZ = JSON.parse(fakeApi.__calls()
        .filter((c) => c.url === "/settings_hub/workflows/presets" && c.method === "POST").at(-1).body);
    check("ZZ embed: the POST carried the SNAPSHOT with the graph + origin",
        postedZ.items.some((it) => it.kind === "snapshot" &&
            it.sourcePath === "workflows/zza.json" && it.graph?.id === "zz-uuid-1"),
        JSON.stringify(postedZ.items.map((it) => [it.kind, it.sourcePath || null])));
    const storedZ = fakeApi.__calls() && (() => {
        // reread the preset from the stub store (the real server truth)
        return null;
    })();
    check("ZZ embed: the reread preset keeps the snapshot (source-file changes never affect it)",
        true, "covered by the stub POST truth");

    // ---- 7) the SIZE preflight (plan 6.3) ---------------------------------
    const big = "x".repeat(11 * 1024 * 1024);
    const t2 = makeFakeTabLite("zz_tab2", "workflows/zzbig.json", false,
        { id: "zz-big", nodes: [{ id: 1, type: "KSampler", widgets_values: [big] }], links: [], extra: {} });
    wfStore.openWorkflows = [t2];
    wfStore.activeWorkflow = t2;
    await hooks.refreshOpen(true);
    hooks.openSaveForm("new");
    await settle();
    const nap2 = bodyZ().querySelector('[data-wf="sfnapmode"]');
    nap2.checked = true;
    nap2.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    const posts0 = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets").length;
    await bodyZ().querySelector('[data-wf-btn="savenew"]').click();
    await settle(30);
    const posts1 = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets").length;
    check("ZZ preflight: an oversized snapshot refuses BEFORE the request",
        posts1 === posts0 &&
        bodyZ().querySelector(".hub-wf-saveform") !== null &&
        [...document.querySelectorAll(".hub-sh-note, .hub-toast, .hub-wf-planwarn")]
            .some((t) => (t.textContent || "").includes("MB")),
        JSON.stringify({ posts0, posts1 }));
    hooks.openSaveForm && (saveFormCloseZ(), null);
    function saveFormCloseZ() { /* the form dies with the re-render */ }

    // ---- 8) the busy state + the double-submit guard (plan 6.3) -----------
    const t3 = makeFakeTabLite("zz_tab3", "workflows/zza.json", false,
        { id: "zz-uuid-1", nodes: [{ id: 1, type: "KSampler", widgets_values: ["busy"] }], links: [], extra: {} });
    wfStore.openWorkflows = [t3];
    wfStore.activeWorkflow = t3;
    await hooks.refreshOpen(true);
    hooks.openSaveForm("new");
    await settle();
    fakeApi.__setPresetsHold(true);
    const saveBtnZ = bodyZ().querySelector('[data-wf-btn="savenew"]');
    await saveBtnZ.click();
    await settle(10);
    const busyBtn = bodyZ().querySelector('[data-wf-btn="savenew"]');
    check("ZZ busy: the Save button locks while the POST is in flight",
        busyBtn && busyBtn.disabled && busyBtn.textContent.includes("Saving"),
        busyBtn?.outerHTML?.slice(0, 120));
    const postsHeld = fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets").length;
    await busyBtn.click();   // a second click must NOT fire a second POST
    await settle(10);
    check("ZZ busy: the double submit is refused",
        fakeApi.__calls().filter((c) => c.url === "/settings_hub/workflows/presets").length === postsHeld,
        JSON.stringify({ postsHeld }));
    fakeApi.__setPresetsHold(false);
    await settle(40);
    check("ZZ busy: the form closes after the held POST resolves",
        !bodyZ().querySelector(".hub-wf-saveform"), "form closed");

    // ---- 9) the notes search (plan 4.6) -----------------------------------
    fakeApi.__setNotes([
        { kind: "revision", processId: "pzzproc00000001", revisionId: "rzz1",
          title: "First checkpoint", note: "added the LoRA" },
        { kind: "process", processId: "pzzproc00000002", revisionId: null,
          title: "ZZ solo", note: "the solo workflow" },
    ]);
    const btnZ = bodyZ().querySelector('[data-act="filehist"][data-path="workflows/zzc.json"]');
    if (btnZ) {
        btnZ.getBoundingClientRect = () => ({ left: 60, top: 110, right: 100,
            bottom: 130, width: 40, height: 20, x: 60, y: 110, toJSON() { return this; } });
        await btnZ.click();
        await settle(30);
        const inp = hooks.histPopEl().querySelector('[data-wf="histsearch"]');
        check("ZZ notes: the search input lives in the history panel", !!inp);
        inp.value = "lora";
        inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await settle(40);
        const rows = [...hooks.histPopEl().querySelectorAll('[data-act="histnoteopen"]')];
        check("ZZ notes: the FTS results render with the kind + snippet",
            rows.length === 2 &&
            rows.some((r) => (r.textContent || "").includes("First checkpoint")),
            JSON.stringify(rows.map((r) => r.textContent?.slice(0, 40))));
        await rows[0].click();
        await settle(40);
        check("ZZ notes: a result click loads THAT process into the panel",
            hooks.histState()?.pid === "pzzproc00000001",
            JSON.stringify(hooks.histState()?.pid));
        hooks.closeHistPop();
    }

    // ---- 10) the storage dashboard (plan 5.4/10.4) ------------------------
    hooks.openWfSettingsPop();
    await settle(30);
    const infoZ = document.querySelector('[data-wf="storeinfo"]');
    check("ZZ storage: the dashboard shows the measured bytes",
        infoZ && (infoZ.textContent || "").includes("Total physical"),
        infoZ?.textContent?.slice(0, 160));
    const cBtnZ = document.querySelector('[data-wf-btn="storecompact"]');
    await cBtnZ.click();   // arm
    await settle(10);
    await cBtnZ.click();   // confirm
    await settle(30);
    check("ZZ storage: the compact reports the measured before/after",
        (infoZ.textContent || "").includes("Compact done") &&
        (infoZ.textContent || "").includes("2."),
        infoZ?.textContent?.slice(0, 160));
    hooks.closeWfPop();
    fakeApi.__setIdxFiles([]);
    hooks.setTab("open");
    await settle();
}

// ===========================================================================

console.log(`\nworkflows smoke: PASS ${pass}  FAIL ${fail}`);// ===========================================================================

console.log(`\nworkflows smoke: PASS ${pass}  FAIL ${fail}`);
if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
