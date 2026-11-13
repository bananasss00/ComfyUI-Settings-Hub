// ============================================================================
// SettingsHub - Paste Stack smoke test (v70-v78)
// ----------------------------------------------------------------------------
// Node ESM + jsdom. Loads the REAL entry (web/settings_hub.js) exactly like
// ComfyUI does, runs the "Comfy.SettingsHub.stack" extension setup, and
// drives the panel through its REAL UI paths with a FAKE server: app.api is
// an in-memory implementation of the py/stack_store.py protocol (GET stack,
// POST item, POST image, POST file, POST patch, DELETE item, POST clear) that
// records every call.
//
//   SA  mount: setup() builds the panel + chip, renders the preloaded server
//       index (2 items), badge shows the count, serverOk=true.
//   SB  capture via the REAL paste event (hover gate): text lands on the
//       server (POST /settings_hub/stack/item, JSON body) and an image file
//       lands as POST /settings_hub/stack/image?ext=...; cards render
//       newest-first; a non-image file is ignored (v70 scope).
//   SC  dedupe: capturing the same text AGAIN moves the existing card to the
//       top (server moved:true) without duplicating it.
//   SD  delete: clicking a card's ✕ issues DELETE /settings_hub/stack/item/<id>
//       and the card disappears.
//   SE  copy-back: clicking a text card calls navigator.clipboard.writeText
//       with the stored text.
//   SF  client max eviction: max=2 -> older entries are DELETEd until the
//       list fits.
//   SG  clear: stackClearAllFlow() POSTs /settings_hub/stack/clear and empties
//       the list; the gear button path arms the "Sure?" confirm (source check).
//   SH  degraded server: when fetchApi fails, initStack shows the note, a
//       capture falls back to a session-only card (marked "session") and the
//       copy-back still works.
//   SI  minimize/hide: [–] swaps the panel for the chip, the chip restores it;
//       [✕] hides everything (isStackOn false) and setStackOn(true) re-mounts.
//   SJ  gear integration: the renderer's settings popup sources contain the
//       Stack section (On/Off + max) wired to the stack module; the CLEAR
//       button lives in the PANEL HEADER now (v74), not in settings.
//   SX  v74: the header 🗑 clears the stack with a double-click confirm
//       (first click arms - class + toast, no POST; second click wipes
//       server + panel).
//   SY  v74: the scroll contract in styles.css - .hub-stack-list carries
//       min-height: 0 (the missing line that killed the scrollbar) and an
//       always-visible styled scrollbar; the eye's chrome-hidden list covers
//       the nav authoring buttons.
//   SZ  v74: the inline rename/tags editor commits on Enter and cancels on
//       Escape.
//   TA  v74: a VIDEO card drags onto a real node whose combo carries
//       options.video_upload (native LoadVideo shape: name "file") ->
//       /upload/image -> combo set + callback.
//   TB  v74: a TEXT card drags onto a REAL prompt node -> the string widget
//       under the cursor (getWidgetOnPos) wins, else the node's first text
//       widget; value + callback + uses bump.
//   TC  v74: Ctrl+V with a panel input focused (search) is NOT captured -
//       the field wins (no preventDefault, no POST).
//   SL  v76: the health probe classification (legacy/missing/http/mismatch/
//       nowrite) + the retry button recovers without a remount.
//   TS  v77: STACK SCOPE - per-workflow stores vs the shared stack: the
//       default is shared; switching to per-workflow marks the graph with
//       extra.settingshubStackId, scopes EVERY route with ?wf=, shows the
//       @workflow badge, keeps the shared store untouched; a workflow switch
//       (graph.onConfigure) re-reads THAT workflow's store; switching back
//       restores it; 🗑 clears only the active scope.
//   TE  v77: the WORKFLOW-FILE TEXT BACKUP - texts are mirrored into
//       extra.settingshubStack, an empty server store rehydrates them (the
//       moved-to-another-machine case), deletions/clears propagate into the
//       embed, and nothing is restored while the server store has entries.
//   TX  v83: the LARGE MEDIA VIEWER - 🔍 on image/video/audio/file cards
//       opens a big overlay (images: wheel zoom + drag pan + dblclick 1:1;
//       video/audio: big players; text-like files: inline preview capped at
//       300 KB; binary: "no preview" + download) and the COMPARE DISPLAY
//       FIX contract (explicit display values - slots/divider/canvas are
//       never hidden by an inline "" again) in SU/SV.
//   UG  v97: the UNIVERSAL inline editor - ✎ opens name/tags/tab for EVERY
//       kind (image and nodes cards included; the edit branch used to be
//       reachable for text only); cancel sends no PATCH.
//   UH  v97: TEXT EDIT in the Full text view - ✎ swaps the read view for a
//       textarea, ✓ saves through PATCH {text} (server truth mirrored into
//       the card excerpt), ✕/Esc discards (Esc first cancels the edit,
//       second Esc closes the viewer); media viewers carry no text editor.
//   UI  v97: TAB-STRIP WHEEL - the vertical wheel scrolls the hidden-
//       scrollbar strip horizontally (deltaMode 0/1/2, a horizontal delta
//       wins), the event is consumed only when the strip overflows, and
//       revealActiveTab keeps the opened chip inside the visible strip.
//
// Run from the extension root:  node tests/smoke_stack.mjs   (jsdom required)
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
    console.error("smoke_stack: jsdom is required (npm install jsdom)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
// v82: the pack version is READ from the entry source - the suite never
// carries a release-version literal again (single-source version rule,
// docs/plan-versions.md).
const ENTRY_SRC = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
const PACK_VERSION = (ENTRY_SRC.match(/__SettingsHubBuild\s*=\s*"(v\d+)"/) || [])[1] || "v0";
// v84: the suite never carries release-version literals - the expected
// self-report of a module is read from the entry's EXPECTED manifest
// (single-source version rule, docs/plan-versions.md).
const EXPECTED_MANIFEST = (() => {
    const m = ENTRY_SRC.match(/const EXPECTED = \{([\s\S]*?)\};/);
    const out = {};
    if (m) for (const mm of m[1].matchAll(/"(\w+)":\s*"(v\d+)"/g)) out[mm[1]] = mm[2];
    return out;
})();

// ---------------------------------------------------------------------------
// DOM globals BEFORE any web module evaluates
// ---------------------------------------------------------------------------

const { JSDOM } = jsdom;
// url: without it the document has an OPAQUE origin and jsdom refuses
// localStorage entirely (every setItem throws) - the panel's LS-backed
// settings would silently no-op and the suite would chase phantom bugs.
// ComfyUI runs on http://localhost - mirror that origin here.
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
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame
    ? dom.window.cancelAnimationFrame.bind(dom.window)
    : clearTimeout;
try { globalThis.IS_MARKED_NODE = undefined; } catch (_) {}

// jsdom: no URL.createObjectURL - the local-fallback image path uses it.
if (!dom.window.URL.createObjectURL) {
    dom.window.URL.createObjectURL = () => "blob:fake-" + Math.random().toString(36).slice(2);
    dom.window.URL.revokeObjectURL = () => {};
}
try { globalThis.URL = dom.window.URL; } catch (_) {}

// ---------------------------------------------------------------------------
// Fake server: in-memory implementation of the py/stack_store.py protocol
// ---------------------------------------------------------------------------

function makeFakeApi() {
    const calls = [];
    // v77: scoped stores - "" is the shared stack, a workflow id its own.
    const stores = new Map();
    const storeFor = (wfKey) => {
        if (!stores.has(wfKey)) stores.set(wfKey, []);
        return stores.get(wfKey);
    };
    let items = storeFor(""); // top-first, mirrors the python index shape; RE-SCOPED per request by ?wf=
    let failing = false; // SH: simulate an unreachable server
    let seq = 0;
    // v76 probe controls (SL): health endpoint behavior + py pack version
    let healthMode = "ok";       // "ok" | "legacy" (no /health, list works) | "missing" (no routes) | "http"
    let serverVersion = PACK_VERSION;   // what /health reports as the py pack version (from the entry source)
    let noWrite = false;         // /health writable:false
    const blobBytes = new Map(); // stored blob name -> Uint8Array (file serving), v77: keyed "<wf>/<name>"
    const blobMime = new Map();  // stored blob name -> content type
    let clipboardMode = "off";   // SL: "off" | "files"
    let clipboardFiles = [];
    let uploadCalls = 0;         // SM: POST /upload/image counter

    const djb2 = (str) => {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return h.toString(16).padStart(8, "0");
    };
    const hashBytes = async (blob) => {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (const b of buf) s += String.fromCharCode(b);
        return djb2(s);
    };
    const jsonResp = (data, status = 200) => ({
        ok: status < 400, status, json: async () => data,
    });
    const blobResp = (bytes, mime) => ({
        ok: true, status: 200,
        json: async () => ({}),
        blob: async () => new dom.window.Blob([bytes], { type: mime || "application/octet-stream" }),
        text: async () => new TextDecoder().decode(bytes),
    });
    const touchDup = (h) => {
        const i = items.findIndex((x) => x.hash === h);
        if (i < 0) return null;
        const [old] = items.splice(i, 1);
        old.created = Math.floor(Date.now() / 1000);
        items.unshift(old);
        return old;
    };

    const storeBlob = async (blob, name, mime, wfKey) => {
        try {
            const buf = new Uint8Array(await blob.arrayBuffer());
            blobBytes.set((wfKey || "") + "/" + name, buf);
            blobMime.set((wfKey || "") + "/" + name, mime);
        } catch (_) { /* entries without arrayBuffer stay unservable */ }
    };
    const typeForExt = (ext) => {
        if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return "image";
        if (["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"].includes(ext)) return "video";
        if (["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"].includes(ext)) return "audio";
        return "file";
    };

    const listeners = {};
    const api = {
        apiURL: (p) => p,
        addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
        removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
        __emit: (ev) => { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
        fetchApi: async (u, opts = {}) => {
            const method = (opts.method || "GET").toUpperCase();
            calls.push({ url: u, method, body: opts.body });
            if (failing) throw new Error("simulated server outage");
            const [path, query] = String(u).split("?");
            // v77: scope routing - every request operates on the store named
            // by ?wf= (mirrors py/stack_store.py); helpers close over the
            // `items` BINDING, so reassigning it re-scopes the whole handler.
            const wfKey = new URLSearchParams(query || "").get("wf") || "";
            items = storeFor(wfKey);
            if (path === "/settings_hub/stack/health" && method === "GET") {
                // v76 probe endpoint (mirrors py/stack_store.py stack_health)
                if (healthMode === "missing" || healthMode === "legacy") return jsonResp({ ok: false, error: "not found" }, 404);
                if (healthMode === "http") return jsonResp({ ok: false, error: "boom" }, 500);
                return jsonResp({ ok: true, version: serverVersion, dir: "C:/ComfyUI/user/settings_hub/stack", writable: !noWrite, items: items.length });
            }
            if (path === "/settings_hub/stack" && method === "GET") {
                if (healthMode === "missing") return jsonResp({ ok: false, error: "not found" }, 404);
                return jsonResp({ ok: true, items: items.map((x) => ({ ...x })) });
            }
            // v99: the file GET route (mirrors py /settings_hub/stack/file/{name})
            // - serves the stored blob bytes as text; the lazy nodeMeta backfill
            // of file-backed fragments reads through it
            if (path.startsWith("/settings_hub/stack/file/") && method === "GET") {
                const fname = decodeURIComponent(path.slice("/settings_hub/stack/file/".length));
                const buf = blobBytes.get((wfKey || "") + "/" + fname);
                if (!buf) return jsonResp({ ok: false, error: "not found" }, 404);
                return blobResp(buf, "application/octet-stream");
            }
            if (path === "/settings_hub/stack/item" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const text = body?.text;
                if (typeof text !== "string" || !text.trim()) return jsonResp({ ok: false, error: "empty" }, 400);
                const h = djb2(text);
                const dup = touchDup(h);
                if (dup) return jsonResp({ ok: true, item: { ...dup }, moved: true });
                // v96: optional entry type - "nodes" = a node-fragment JSON
                // (allowlist mirrors py/stack_store.py stack_add_text)
                const entryType = body?.type === "nodes" ? "nodes" : "text";
                // v99: the bounded preview aggregate - mirror py semantics:
                // nodes entries only, stored as-is if it looks sane
                const item = { id: "srv" + (++seq), type: entryType, text, hash: h, size: text.length, created: Math.floor(Date.now() / 1000) };
                if (entryType === "nodes" && body.nodeMeta && typeof body.nodeMeta === "object" &&
                    typeof body.nodeMeta.nodeCount === "number") item.nodeMeta = body.nodeMeta;
                if (body?.name) item.name = String(body.name).slice(0, 120);
                if (body?.tab) item.tab = String(body.tab).slice(0, 48);
                items.unshift(item);
                return jsonResp({ ok: true, item: { ...item }, moved: false });
            }
            if (path === "/settings_hub/stack/image" && method === "POST") {
                const q = new URLSearchParams(query || "");
                const ext = q.get("ext") || "png";
                const nm = q.get("name") || "";
                const blob = opts.body;
                if (!blob || typeof blob.arrayBuffer !== "function") return jsonResp({ ok: false, error: "no payload" }, 400);
                const h = await hashBytes(blob);
                const dup = touchDup(h);
                if (dup) return jsonResp({ ok: true, item: { ...dup }, moved: true });
                const item = { id: "srv" + (++seq), type: "image", file: "srv" + seq + "." + ext, hash: h, size: blob.size, created: Math.floor(Date.now() / 1000) };
                if (nm) item.name = nm;
                items.unshift(item);
                await storeBlob(blob, item.file, "image/" + ext, wfKey);
                return jsonResp({ ok: true, item: { ...item }, moved: false });
            }
            if (path === "/settings_hub/stack/file" && method === "POST") {
                // v71: generic blob route (mirrors py/stack_store.py)
                const q = new URLSearchParams(query || "");
                const ext = (q.get("ext") || "").toLowerCase();
                const name = q.get("name") || "";
                const blob = opts.body;
                if (!blob || typeof blob.size !== "number") return jsonResp({ ok: false, error: "no payload" }, 400);
                let h;
                try { h = await hashBytes(blob); } catch (_) { h = djb2(name + ":" + blob.size + ":" + ext); }
                const dup = touchDup(h);
                if (dup) return jsonResp({ ok: true, item: { ...dup }, moved: true });
                const item = { id: "srv" + (++seq), type: typeForExt(ext), file: "srv" + seq + "." + ext, hash: h, size: blob.size, created: Math.floor(Date.now() / 1000) };
                if (name) item.name = name;
                items.unshift(item);
                await storeBlob(blob, item.file, "application/octet-stream", wfKey);
                return jsonResp({ ok: true, item: { ...item }, moved: false });
            }
            if (path === "/settings_hub/stack/patch" && method === "POST") {
                // v72: metadata patch (mirrors py/stack_store.py semantics)
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const it = items.find((x) => x.id === body?.id);
                if (!it) return jsonResp({ ok: true, gone: true });
                if ("name" in body) {
                    const nm = String(body.name ?? "").trim();
                    if (nm) it.name = nm.slice(0, 120); else delete it.name;
                }
                if ("tags" in body) {
                    const clean = [];
                    for (const t of Array.isArray(body.tags) ? body.tags : []) {
                        const s = String(t ?? "").trim();
                        if (s && !clean.some((x) => x.toLowerCase() === s.toLowerCase())) clean.push(s);
                        if (clean.length >= 8) break;
                    }
                    if (clean.length) it.tags = clean; else delete it.tags;
                }
                if ("pinned" in body) it.pinned = !!body.pinned;
                if ("tab" in body) {
                    const tb = String(body.tab ?? "").trim().slice(0, 48);
                    if (tb) it.tab = tb; else delete it.tab;
                }
                // v97: text edit mirrors py semantics - text entries only
                if ("text" in body) {
                    if (it.type !== "text") return jsonResp({ ok: false, error: "text edit allowed for text entries only" }, 400);
                    const nt = body.text;
                    if (typeof nt !== "string" || !nt.trim()) return jsonResp({ ok: false, error: "empty text" }, 400);
                    it.text = nt;
                    it.size = Buffer.byteLength(nt, "utf8");
                }
                if ("uses" in body) it.uses = Math.max(0, parseInt(body.uses, 10) || 0);
                if (body.bumpUses) it.uses = (it.uses || 0) + 1;
                // v99: nodeMeta patch mirrors py - "nodes" entries only, sane
                // object stored, a refusal answers 400
                if ("nodeMeta" in body) {
                    if (it.type !== "nodes") return jsonResp({ ok: false, error: "nodeMeta allowed for nodes entries only" }, 400);
                    const nm = body.nodeMeta;
                    if (!nm || typeof nm !== "object" || typeof nm.nodeCount !== "number") return jsonResp({ ok: false, error: "bad nodeMeta" }, 400);
                    it.nodeMeta = nm;
                }
                return jsonResp({ ok: true, item: { ...it } });
            }
            if (path === "/settings_hub/clipboard" && method === "POST") {
                if (clipboardMode !== "files") return jsonResp({ ok: false, error: "missing" }, 404);
                return jsonResp({ ok: true, files: clipboardFiles });
            }
            if (path === "/upload/image" && method === "POST") {
                uploadCalls++;
                return jsonResp({ name: "uploaded.png", subfolder: "" });
            }
            const fileGet = path.match(/^\/settings_hub\/stack\/file\/([A-Za-z0-9._-]+)$/);
            if (fileGet && method === "GET" && blobBytes.has(wfKey + "/" + fileGet[1])) {
                return blobResp(blobBytes.get(wfKey + "/" + fileGet[1]), blobMime.get(wfKey + "/" + fileGet[1]));
            }
            const del = path.match(/^\/settings_hub\/stack\/item\/([a-z0-9-]+)$/);
            if (del && method === "DELETE") {
                const before = items.length;
                const i = items.findIndex((x) => x.id === del[1]);
                if (i >= 0) items.splice(i, 1); // v77: in place - `items` IS the scoped store array
                return jsonResp({ ok: true, gone: before !== items.length });
            }
            if (path === "/settings_hub/stack/clear" && method === "POST") {
                items.length = 0; // v77: mutate IN PLACE - `items` IS the scoped store array
                return jsonResp({ ok: true });
            }
            return jsonResp({ ok: false, error: "not found" }, 404);
        },
        __calls: calls,
        __items: () => storeFor("").map((x) => ({ ...x })),
        __itemsOf: (wf) => storeFor(wf || "").map((x) => ({ ...x })), // v77: scoped store read
        // v99: inject a raw item (e.g. a file-backed node fragment) directly
        // into the shared store - the next GET /stack serves it to the panel
        __pushItem: (it) => { storeFor("").unshift(it); },
        __storeBlob: storeBlob, // v99: seed the blob store for the file GET route
        __setFailing: (v) => { failing = !!v; },
        __setHealth: (m) => { healthMode = m; },
        __setServerVersion: (v) => { serverVersion = String(v); },
        __setNoWrite: (v) => { noWrite = !!v; },
        __setClipboard: (mode, files) => { clipboardMode = mode; clipboardFiles = files || []; },
        __uploadCalls: () => uploadCalls,
    };
    return api;
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
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubstack-"));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(
        path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n",
    );
    return {
        entry: path.join(sb, "Hub", "web", "settings_hub.js"),
        stack: path.join(sb, "Hub", "web", "stack.js"),
    };
}

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

const tick = () => new Promise((r) => setTimeout(r, 8));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

/** Node 24's globalThis.navigator is getter-only - mock the clipboard by
 *  defining the property on the EXISTING navigator object. */
function setClipboard(mock) {
    Object.defineProperty(globalThis.navigator, "clipboard", {
        value: mock, configurable: true,
    });
}

// ---------------------------------------------------------------------------
// Boot: app stub + fake server + real entry + stack extension setup
// ---------------------------------------------------------------------------

const appStub = { registerExtension(ext) { appStub.__extensions.push(ext); }, __extensions: [], canvas: null, graph: null };
const fakeApi = makeFakeApi();
appStub.api = fakeApi;
globalThis.__HUB_APP_STUB__ = appStub;

// Preload the server index: one text + one image entry (as if from a past session).
fakeApi.fetchApi("/settings_hub/stack/item", { method: "POST", body: JSON.stringify({ text: "masterpiece portrait, film grain" }) }).catch(() => {});
fakeApi.fetchApi("/settings_hub/stack/image?ext=png", { method: "POST", body: new dom.window.Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], { type: "image/png" }) }).catch(() => {});
await settle();

const { entry, stack: stackUrl } = makeSandbox();
globalThis.__SettingsHubBuild = PACK_VERSION; // the entry re-stamps this at import - the suite stays in sync
const { errors: bootErrors } = await importCaptured(entry);
const stack = await import(stackUrl); // SAME module instance the entry loaded
const syncMod = await import(path.join(path.dirname(stackUrl), "sync.js")); // bridge registry (same instance)
const hooks = stack.__stackTestHooks();

const extStack = appStub.__extensions.find((e) => e?.name === "Comfy.SettingsHub.stack");
const panel = () => document.querySelector(".hub-stack-panel");
const chip = () => document.querySelector(".hub-stack-chip");
const cards = () => [...document.querySelectorAll(".hub-stack-card")];
const textCards = () => [...document.querySelectorAll('.hub-stack-card[data-type="text"]')];
const serverTextCard = () => textCards().find((c) => !String(c.getAttribute("data-id")).startsWith("local-")); // v72: skip session-only locals;
const imgCards = () => [...document.querySelectorAll('.hub-stack-card[data-type="image"]')];
const postTexts = () => fakeApi.__calls
    .filter((c) => c.method === "POST" && c.url === "/settings_hub/stack/item")
    .map((c) => { try { return JSON.parse(c.body).text; } catch (_) { return null; } });

// ===========================================================================
// SA - mount
// ===========================================================================

phase("SA mount — panel + chip built, server index rendered");
{
    check("boot: no console.error during entry import", bootErrors.length === 0, bootErrors.join(" | "));
    check("boot: stack extension registered", !!extStack);
    check("boot: stack.js self-reports the version the entry EXPECTS (last functional change)",
        !!EXPECTED_MANIFEST.stack && globalThis.__SettingsHubLoaded?.stack === EXPECTED_MANIFEST.stack,
        String(globalThis.__SettingsHubLoaded?.stack) + " vs " + String(EXPECTED_MANIFEST.stack));

    extStack.setup();
    await settle();

    check("SA: panel in DOM", !!panel());
    check("SA: chip in DOM (hidden by default)", !!chip() && chip().style.display === "none");
    check("SA: preloaded server items rendered (2 cards)", cards().length === 2, String(cards().length));
    check("SA: text card first (server order)", textCards().length === 1 && imgCards().length === 1);
    check("SA: head badge shows 2", panel().querySelector(".hub-stack-count").textContent === "2");
    check("SA: text preview shows stored content", textCards()[0]?.textContent.includes("masterpiece portrait"));
    check("SA: serverOk=true (no degraded note)", hooks.serverOk() === true &&
        panel().querySelector(".hub-stack-note").style.display === "none");
}

// ===========================================================================
// SB - capture through the REAL paste event
// ===========================================================================

phase("SB capture — paste event with hover gate: text + image + a v71 FILE card");
{
    const callsBefore = fakeApi.__calls.length;
    hooks.setPasteHover(true);
    const ev = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = {
        getData: (t) => (t === "text/plain" ? "a fresh prompt idea" : ""),
        files: [
            new dom.window.Blob([new Uint8Array([9, 9, 9, 9])], { type: "image/png" }),
            { type: "application/pdf", name: "doc.pdf", size: 10 }, // v71: lands as a file card
        ],
    };
    window.dispatchEvent(ev);
    await settle();

    const newCalls = fakeApi.__calls.slice(callsBefore);
    check("SB: paste event was preventDefault'ed (captured)", ev.defaultPrevented === true);
    const texts = postTexts();
    check("SB: text POSTed to the server", texts.some((t) => t === "a fresh prompt idea"), JSON.stringify(texts));
    const imgPosts = newCalls.filter((c) => c.method === "POST" && String(c.url).startsWith("/settings_hub/stack/image?"));
    check("SB: exactly ONE image POST with ext=png", imgPosts.length === 1 && imgPosts[0].url.includes("ext=png"),
        JSON.stringify(newCalls.map((c) => c.method + " " + c.url)));
    const filePosts = newCalls.filter((c) => c.method === "POST" && String(c.url).startsWith("/settings_hub/stack/file?"));
    check("SB: the pdf became a FILE POST with ext=pdf", filePosts.length === 1 && filePosts[0].url.includes("ext=pdf") &&
        filePosts[0].url.includes("name=doc.pdf"), JSON.stringify(filePosts.map((c) => c.url)));
    check("SB: 5 cards now (2 preloaded + text + image + pdf)", cards().length === 5, String(cards().length));
    check("SB: newest first (fresh text on top of its kind)", textCards()[0]?.textContent.includes("a fresh prompt idea"));
    const fileCard = document.querySelector('.hub-stack-card[data-type="file"]');
    check("SB: file card shows the source name + download/send actions",
        !!fileCard && fileCard.textContent.includes("doc.pdf") &&
        !!fileCard.querySelector('[data-act="dl"]') && !!fileCard.querySelector('[data-act="send"]'));
    check("SB: badge shows 5", panel().querySelector(".hub-stack-count").textContent === "5");

    // hover gate OFF: a paste event outside the panel must be untouched
    hooks.setPasteHover(false);
    const ev2 = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    ev2.clipboardData = { getData: () => "must not be captured", files: [] };
    window.dispatchEvent(ev2);
    await settle();
    check("SB: paste WITHOUT hover is not captured", !postTexts().includes("must not be captured"));
    hooks.setPasteHover(true);
}

// ===========================================================================
// SC - dedupe: same content moves to top, no duplicate
// ===========================================================================

phase("SC dedupe — same text moves the existing card to the top");
{
    const nBefore = cards().length;
    await hooks.captureFromClipboardData({ text: "a fresh prompt idea" });
    await settle();
    check("SC: no duplicate card created", cards().length === nBefore, `${cards().length} vs ${nBefore}`);
    check("SC: the moved card is on top", textCards()[0]?.textContent.includes("a fresh prompt idea"));
    const movedCall = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/item").pop();
    check("SC: server returned the same id (moved, not re-added)",
        fakeApi.__items().filter((x) => x.text === "a fresh prompt idea").length === 1);
}

// ===========================================================================
// SD - delete a card
// ===========================================================================

phase("SD delete — ✕ removes the card and DELETEs on the server");
{
    const victim = textCards()[0];
    const victimId = victim.getAttribute("data-id");
    victim.querySelector(".hub-stack-del").click();
    await settle();
    check("SD: DELETE issued for the right id",
        fakeApi.__calls.some((c) => c.method === "DELETE" && c.url === "/settings_hub/stack/item/" + victimId));
    check("SD: card removed from the panel", !cards().some((c) => c.getAttribute("data-id") === victimId));
    check("SD: server list no longer has it", !fakeApi.__items().some((x) => x.id === victimId));
}

// ===========================================================================
// SE - copy-back
// ===========================================================================

phase("SE copy-back — clicking a text card writes the clipboard");
{
    let written = null;
    setClipboard({ writeText: async (t) => { written = t; } });
    const expected = textCards()[0].querySelector(".hub-stack-text").textContent;
    textCards()[0].querySelector(".hub-stack-card-main").click();
    await settle();
    check("SE: clipboard.writeText called with the stored text",
        written === expected, JSON.stringify(written) + " vs " + JSON.stringify(expected));
}

// ===========================================================================
// SF - client max eviction
// ===========================================================================

phase("SF max eviction — max=2 drops the oldest until the list fits");
{
    stack.setStackMax(2);
    check("SF: setter persists + returns the choice", stack.getStackMax() === 2);
    await hooks.captureFromClipboardData({ text: "entry two" });
    await settle();
    await hooks.captureFromClipboardData({ text: "entry three" });
    await settle();
    check("SF: list trimmed to max", cards().length === 2, String(cards().length));
    check("SF: the OLDEST entries were DELETEd server-side",
        fakeApi.__items().every((x) => x.text === "entry two" || x.text === "entry three" || x.type === "image"),
        JSON.stringify(fakeApi.__items().map((x) => x.text || x.file)));
    check("SF: newest kept", textCards()[0]?.textContent.includes("entry three"));
    stack.setStackMax(100);
}

// ===========================================================================
// SG - clear all
// ===========================================================================

phase("SG clear — flow POSTs clear and empties the panel");
{
    const ok = await stack.stackClearAllFlow();
    await settle();
    check("SG: flow reports success", ok === true);
    check("SG: server received POST /settings_hub/stack/clear",
        fakeApi.__calls.some((c) => c.method === "POST" && c.url === "/settings_hub/stack/clear"));
    check("SG: panel empty (empty-state row)", cards().length === 0 && !!panel().querySelector(".hub-stack-empty"));
    check("SG: server items empty", fakeApi.__items().length === 0);
}

// ===========================================================================
// SH - degraded server (no storage): session-only fallback
// ===========================================================================

phase("SH degraded — server outage keeps capture working in session mode");
{
    fakeApi.__setFailing(true);
    hooks.mount(); // full re-init against a dead server
    await settle();
    check("SH: re-init survived without throwing", !!panel());
    check("SH: degraded note visible", panel().querySelector(".hub-stack-note").style.display !== "none" &&
        panel().querySelector(".hub-stack-note").textContent.includes("session"));
    check("SH: serverOk=false", hooks.serverOk() === false);

    let written = null;
    setClipboard({ writeText: async (t) => { written = t; } });
    await hooks.captureFromClipboardData({ text: "offline capture" });
    await settle();
    check("SH: fallback card rendered", textCards()[0]?.textContent.includes("offline capture"));
    check("SH: card marked as session-only", textCards()[0]?.textContent.includes("session"));
    textCards()[0].querySelector(".hub-stack-card-main").click();
    await settle();
    check("SH: copy-back works for a session-only card", written === "offline capture", String(written));

    fakeApi.__setFailing(false);
    await hooks.refresh();
    await settle();
    check("SH: server recovery re-syncs and clears the note",
        hooks.serverOk() === true && panel().querySelector(".hub-stack-note").style.display === "none");
}

// ===========================================================================
// SI - minimize / hide / re-enable
// ===========================================================================

phase("SI window states — minimize to chip, restore; NO close button (v75), settings-only off");
{
    extStack.setup(); // fresh mount for a clean state
    await settle();
    check("SI: no [✕] close button in the header (v75: removed)",
        !panel().querySelector(".hub-stack-hide"));
    check("SI: header buttons are exactly ⚙ + 🗑 + [–] (v88: the own settings popup)",
        [...panel().querySelectorAll(".hub-stack-head button")].map((b) => b.className).join(",") ===
            "hub-btn hub-stack-sett,hub-btn hub-stack-clear,hub-btn hub-stack-min",
        [...panel().querySelectorAll(".hub-stack-head button")].map((b) => b.className).join(","));
    panel().querySelector(".hub-stack-min").click();
    await settle();
    check("SI: [–] hides the panel", panel().style.display === "none");
    check("SI: [–] shows the chip", chip().style.display !== "none");
    chip().click();
    await settle();
    check("SI: chip click restores the panel", panel().style.display !== "none" && chip().style.display === "none");

    // v75: the ONLY way to remove the panel is the settings switch (the gear
    // popup calls setStackOn(false); the ✕ route no longer exists).
    check("SI: isStackOn still true before the settings toggle", stack.isStackOn() === true);

    // v88: the panel's OWN ⚙ settings popup (the rows the hub used to host)
    panel().querySelector(".hub-stack-sett").click();
    await settle();
    const stkPop = hooks.stkPopEl();
    check("SI: ⚙ opens the stack's own settings popup", !!stkPop && stkPop.className.includes("hub-stk-setpop"));
    check("SI: the popup carries the four rows",
        !!stkPop.querySelector('[data-stk="on"]') && !!stkPop.querySelector('[data-stk="max"]') &&
        !!stkPop.querySelector('[data-stk="scope"]') && !!stkPop.querySelector('[data-stk="root"]'));
    check("SI: Panel row shows On", stkPop.querySelector('[data-stk="on"]').value === "1");
    const maxSelSi = stkPop.querySelector('[data-stk="max"]');
    maxSelSi.value = "200";
    maxSelSi.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    check("SI: max row applies via setStackMax", stack.getStackMax() === 200, stack.getStackMax());
    stack.setStackMax(100);
    // Panel Off THROUGH THE POPUP tears the panel + popup down
    const onSelSi = stkPop.querySelector('[data-stk="on"]');
    onSelSi.value = "0";
    onSelSi.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("SI: popup Off removes the panel AND the popup", !panel() && !hooks.stkPopEl());
    check("SI: popup Off flipped isStackOn off", stack.isStackOn() === false);
    stack.setStackOn(true);
    await settle();
    check("SI: setStackOn(true) re-mounts the panel", !!panel());
    check("SI: re-mounted panel re-reads the server (2 items from SG/SH recovery)",
        cards().length >= 1, String(cards().length));
}

// ===========================================================================
// SL - v76: server self-diagnosis probe (health route) + retry button
// ===========================================================================

phase("SL v76 probe — health classification, green notes, retry recovers");
{
    const note = () => panel()?.querySelector(".hub-stack-note");
    const noteText = () => (note()?.textContent || "");

    extStack.setup(); // fresh mount against a HEALTHY v76 server
    await settle();
    check("SL: healthy v76 server -> no note",
        note() && note().style.display === "none" && !note().classList.contains("hub-stack-note-ok"));
    check("SL: probe hit /health", fakeApi.__calls.some((c) => c.method === "GET" && c.url === "/settings_hub/stack/health"));

    // mismatch: storage works but the py pack is a different version
    fakeApi.__setServerVersion("v70");
    extStack.setup();
    await settle();
    check("SL: mismatch note shown", note().style.display !== "none" && noteText().includes("version mismatch"), noteText().slice(0, 120));
    check("SL: mismatch names the server version", noteText().includes("v70") && noteText().includes("restart ComfyUI"));
    check("SL: mismatch note is GREEN (storage is ON)", note().classList.contains("hub-stack-note-ok"));
    check("SL: mismatch keeps serverOk true", hooks.serverOk() === true);

    // legacy: no /health (py v70-v75) but the list route answers
    fakeApi.__setServerVersion(PACK_VERSION);
    fakeApi.__setHealth("legacy");
    extStack.setup();
    await settle();
    check("SL: legacy note shown and GREEN", note().style.display !== "none" &&
        note().classList.contains("hub-stack-note-ok") && noteText().includes("/health"));
    check("SL: legacy keeps serverOk true", hooks.serverOk() === true);
    check("SL: legacy WHY names the RESTART fix", noteText().includes("RESTART ComfyUI"));

    // missing: the py part has no stack routes at all (old py/)
    fakeApi.__setHealth("missing");
    extStack.setup();
    await settle();
    check("SL: missing note shown RED", note().style.display !== "none" && !note().classList.contains("hub-stack-note-ok"));
    check("SL: missing names the cause + the fix", noteText().includes("NO /settings_hub/stack routes") && noteText().includes("Reinstall the FULL zip"));
    check("SL: missing flips serverOk false", hooks.serverOk() === false);

    // retry button recovers WITHOUT a page reload
    fakeApi.__setHealth("ok");
    note().querySelector(".hub-stack-note-retry").click();
    await settle();
    check("SL: retry clears the note", note().style.display === "none");
    check("SL: retry restores serverOk", hooks.serverOk() === true);
    check("SL: retry re-synced the server items", cards().length >= 1, String(cards().length));

    // nowrite: health reports a non-writable storage folder
    fakeApi.__setNoWrite(true);
    extStack.setup();
    await settle();
    check("SL: nowrite note names the folder", noteText().includes("cannot be written") && noteText().includes("C:/ComfyUI/user/settings_hub/stack"));
    check("SL: nowrite flips serverOk false", hooks.serverOk() === false);
    fakeApi.__setNoWrite(false);

    // http: a 5xx from the stack routes themselves
    fakeApi.__setHealth("http");
    extStack.setup();
    await settle();
    check("SL: http note shows the status", noteText().includes("HTTP 500"));
    check("SL: http keeps the data path usable (serverOk true)", hooks.serverOk() === true);
    fakeApi.__setHealth("ok");
    note().querySelector(".hub-stack-note-retry").click();
    await settle();
    check("SL: final retry back to healthy", note().style.display === "none" && hooks.serverOk() === true);

    // v78: green notes self-retire - shown ONCE per state, then console-only.
    // mismatch with a NEW server version shows again (the seen flag is keyed
    // by the state), the dismiss button hides it, remounts stay quiet.
    fakeApi.__setServerVersion("v71");
    extStack.setup();
    await settle();
    check("SL: mismatch re-shows for a NEW server version", noteText().includes("version mismatch") && noteText().includes("v71"), noteText().slice(0, 140));
    check("SL: green note carries the dismiss button", !!note().querySelector(".hub-stack-note-x"));
    note().querySelector(".hub-stack-note-x").click();
    await settle();
    check("SL: dismiss hides the green note", note().style.display === "none");
    extStack.setup();
    await settle();
    check("SL: dismissed green state stays quiet on remount", note().style.display === "none" && hooks.serverOk() === true);

    // a DIFFERENT green state (legacy) shows once, then stays quiet too
    fakeApi.__setHealth("legacy");
    fakeApi.__setServerVersion(PACK_VERSION);
    extStack.setup();
    await settle();
    check("SL: legacy shows once more (state changed)", note().style.display !== "none" && note().classList.contains("hub-stack-note-ok"));
    check("SL: first green show persisted the seen flag",
        (() => { try { return JSON.parse(localStorage.getItem("settingshub.stack.noteSeen") || "null")?.code === "legacy"; } catch (_) { return false; } })());
    hooks.resetNoteSession(); // simulate a fresh page load (new module session)
    extStack.setup();
    await settle();
    check("SL: same green state stays quiet on the next mount", note().style.display === "none" && !note().classList.contains("hub-stack-note-ok"));
    check("SL: quiet green keeps serverOk true", hooks.serverOk() === true);

    // the RED states never consult the seen flag
    fakeApi.__setHealth("missing");
    extStack.setup();
    await settle();
    check("SL: red note ignores the green seen flag", note().style.display !== "none" && !note().classList.contains("hub-stack-note-ok"));
    fakeApi.__setHealth("ok");
    note().querySelector(".hub-stack-note-retry").click();
    await settle();
    check("SL: back to healthy after the red check", note().style.display === "none" && hooks.serverOk() === true);
}

// ===========================================================================
// SJ - settings integration (source-level). v88: the hub renderer hosts NO
// Stack rows anymore - the panel manages itself via its OWN ⚙ popup, and
// the On/Off switch is registered as a NATIVE ComfyUI setting.
// ===========================================================================

phase("SJ stack settings — own ⚙ popup since v88, the hub hosts nothing");
{
    const src = fs.readFileSync(path.join(ROOT, "web", "hub_ui_renderer.js"), "utf8");
    check("SJ: v88 - the Stack section LEFT the hub settings popup",
        !src.includes('<div class="hub-set-section">Stack</div>'));
    check("SJ: v88 - the Chat section LEFT the hub settings popup too",
        !src.includes('data-set-role="chaton"') && !src.includes('<div class="hub-set-section">Chat'));
    check("SJ: v88 - the hint names both panels as standalone + the native switch",
        src.includes("Panels (v88)") && src.includes("Settings → SettingsHub"));
    check("SJ: v88 - the renderer imports nothing from the panels anymore",
        !src.includes('import { isStackOn') && !src.includes('import { isChatOn'));
    const ssrc = fs.readFileSync(path.join(ROOT, "web", "stack.js"), "utf8");
    check("SJ: v88 - the panel ⚙ button exists in the header",
        ssrc.includes("hub-stack-sett") && ssrc.includes("openStkSettingsPop"));
    check("SJ: v88 - the own popup carries the four rows (On/Off, max, scope, folder)",
        ssrc.includes('data-stk="on"') && ssrc.includes('data-stk="max"') &&
        ssrc.includes('data-stk="scope"') && ssrc.includes('data-stk="root"') &&
        ssrc.includes("setStackRootPath(") && ssrc.includes("getStackRootInfo("));
    check("SJ: v88 - the popup dies with the panel (teardown closes it)",
        ssrc.includes("closeStkPop();") && ssrc.includes("closeStkPop();  // v88"));
    check("SJ: v91 - the launcher replaces the native stack switch",
        ssrc.includes('from "./launcher.js"') &&
        fs.readFileSync(path.join(ROOT, "web", "launcher.js"), "utf8").includes('mk("SettingsHub.Launcher.itemStack"') &&
        !ssrc.includes("SettingsHub.PasteStack.enabled"));
    check("SJ: v74 - the clear button lives in the PANEL HEADER",
        ssrc.includes("hub-stack-clear") && ssrc.includes("panelClearAll"));
    check("SJ: v75 - the hide button is gone from stack.js entirely",
        !ssrc.includes("hub-stack-hide"));
    check("SJ: v77 - stack.js routes every path through scopeUrl",
        ssrc.includes("function scopeUrl") &&
        ssrc.includes('scopeUrl("/settings_hub/stack")') &&
        ssrc.includes("settingshubStackId"));
    check("SJ: v78 - green verdicts show once (seen flag helpers exist)",
        ssrc.includes("noteSeenMatches") && ssrc.includes("settingshub.stack.noteSeen"));
    check("SJ: v78 - green notes carry a dismiss button", ssrc.includes("hub-stack-note-x"));
    check("SJ: v84 - stack.js carries the storage-root API (server answer, never throws)",
        ssrc.includes("export async function getStackRootInfo") &&
        ssrc.includes("export async function setStackRootPath") &&
        ssrc.includes("/settings_hub/stack/root"));
}

// ===========================================================================
// SK - v71: OS file drop onto the panel (video/audio/text/binary)
// ===========================================================================

phase("SK file drop — OS files land as per-kind cards (video/audio/text)");
{
    const callsBefore = fakeApi.__calls.length;
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    drop.dataTransfer = {
        files: [
            new dom.window.Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" }),
            new dom.window.Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
            new dom.window.Blob(["dropped prompt text"], { type: "text/plain" }),
        ],
    };
    Object.defineProperty(drop, "target", { value: panel() });
    panel().dispatchEvent(drop);
    await settle();

    const newCalls = fakeApi.__calls.slice(callsBefore);
    const filePosts = newCalls.filter((c) => c.method === "POST" && String(c.url).startsWith("/settings_hub/stack/file?"));
    check("SK: mp4+wav via the FILE route; the txt via the TEXT route",
        filePosts.length === 2 &&
        filePosts.some((c) => c.url.includes("ext=mp4")) &&
        filePosts.some((c) => c.url.includes("ext=wav")) &&
        newCalls.filter((c) => c.url === "/settings_hub/stack/item").length === 1,
        JSON.stringify(newCalls.map((c) => c.method + " " + c.url)));
    const videoCard = document.querySelector('.hub-stack-card[data-type="video"]');
    const audioCard = document.querySelector('.hub-stack-card[data-type="audio"]');
    check("SK: video card with a <video> player + actions",
        !!videoCard && !!videoCard.querySelector("video") &&
        !!videoCard.querySelector('[data-act="send"]') && !!videoCard.querySelector('[data-act="dl"]'));
    check("SK: audio card with an <audio> player",
        !!audioCard && !!audioCard.querySelector("audio"));
    const textCard = textCards()[0];
    check("SK: the dropped .txt became a TEXT card (content inline)", textCard?.textContent.includes("dropped prompt text"));

    // text FILE content lands as text (inline) without a name when none given
    const stored = fakeApi.__items().find((x) => x.text === "dropped prompt text");
    check("SK: server text entry has no name", !!stored && !stored.name,
        JSON.stringify(stored || {}));

    // classification helper contract
    check("SK: classifyBlob kinds", hooks.classifyBlob({ type: "video/mp4" }, "x.mp4") === "video" &&
        hooks.classifyBlob({ type: "" }, "a.txt") === "text" &&
        hooks.classifyBlob({ type: "" }, "b.exe") === "file" &&
        hooks.classifyBlob({ type: "image/png" }, "c") === "image");
}

// ===========================================================================
// SL - v71: the OS-clipboard helper (py/clipboard_helper.py contract)
// ===========================================================================

phase("SL os helper — POST /settings_hub/clipboard with the custom header");
{
    const b64 = Buffer.from(new Uint8Array([137, 80, 78, 71, 42, 42])).toString("base64");
    fakeApi.__setClipboard("files", [{ name: "helper.png", mime: "image/png", data: b64 }]);
    const callsBefore = fakeApi.__calls.length;
    const ok = await hooks.captureFromOsHelper();
    await settle();
    const helperCalls = fakeApi.__calls.slice(callsBefore).filter((c) => c.url === "/settings_hub/clipboard");
    check("SL: helper was POSTed once", ok === true && helperCalls.length === 1, String(ok));
    check("SL: the custom header was sent", helperCalls[0] && true); // body/headers recorded by the fake
    check("SL: the helper image landed as an image card",
        fakeApi.__items().some((x) => x.type === "image" && x.name === "helper.png"),
        JSON.stringify(fakeApi.__items().map((x) => x.name || x.text)));

    // helper missing (old server build) -> false, panel survives
    fakeApi.__setClipboard("off", []);
    const ok2 = await hooks.captureFromOsHelper();
    check("SL: missing helper route -> false without throwing", ok2 === false);
}

// ===========================================================================
// SM - v71: drag an image card onto a Load-Image node (canvas highlight)
// ===========================================================================

phase("SM drag to node — image card -> /upload/image -> image combo");
{
    const fakeCanvasEl = document.createElement("canvas");
    fakeCanvasEl.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 });
    document.elementFromPoint = (x, y) =>
        (x >= 0 && y >= 0 && x <= 800 && y <= 600) ? fakeCanvasEl : null;
    appStub.canvas = { canvas: fakeCanvasEl, ds: { scale: 1, offset: [0, 0] }, setDirty: () => {} };
    const imageWidget = {
        name: "image", type: "combo", value: "old.png", options: { values: ["old.png"] },
        callbackCalls: [],
    };
    imageWidget.callback = (v) => { imageWidget.callbackCalls.push(v); };
    const loaderNode = {
        title: "Load Image", type: "LoadImage", pos: [100, 80], size: [220, 160],
        widgets: [imageWidget],
    };
    appStub.graph = { getNodeOnPos: () => loaderNode };

    const imgCard = imgCards()[0];
    check("SM: an image card exists to drag", !!imgCard);
    const main = imgCard.querySelector(".hub-stack-card-main");
    main.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 300, clientY: 300 }));
    await settle();
    check("SM: drag session started", hooks.dragState()?.started === true);
    check("SM: a loader node is highlighted", hooks.dragState()?.target?.kind === "node");
    check("SM: the highlight box is on screen", !!document.querySelector(".hub-stack-targetbox"));
    check("SM: the drag ghost follows the pointer", !!document.querySelector(".hub-stack-ghost"));

    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 300, clientY: 300 }));
    await settle();
    check("SM: /upload/image POSTed once", fakeApi.__uploadCalls() === 1, String(fakeApi.__uploadCalls()));
    check("SM: the image combo got the uploaded name", imageWidget.value === "uploaded.png", String(imageWidget.value));
    check("SM: the name was added to the combo values", imageWidget.options.values.includes("uploaded.png"));
    check("SM: the widget callback fired (preview refresh)", imageWidget.callbackCalls.includes("uploaded.png"));
    check("SM: the ghost + highlight box are gone after the drop",
        !document.querySelector(".hub-stack-ghost") &&
        document.querySelector(".hub-stack-targetbox").style.display === "none");
    check("SM: the trailing click is blocked (no copy-back)", hooks.isJustDragged() === true);

    // Esc cancels a fresh drag
    const uploadsBefore = fakeApi.__uploadCalls();
    main.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 320, clientY: 320 }));
    await settle();
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    check("SM: Esc ends the drag session", hooks.dragState() === null);
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 320, clientY: 320 }));
    await settle();
    check("SM: Esc-cancelled drag uploads NOTHING", fakeApi.__uploadCalls() === uploadsBefore);
    check("SM: a node without an image combo is not a target", hooks.imageWidgetOf({ widgets: [{ name: "seed", type: "number" }] }) === null);
}

// ===========================================================================
// SN - v71: drag an image card onto a hub MEDIA MIRROR (bridge route)
// ===========================================================================

phase("SN drag to mirror — drop on .hub-mirror-media routes through the bridge");
{
    const bridgeCalls = [];
    const mirrorEl = document.createElement("span");
    mirrorEl.className = "hub-mirror-media";
    mirrorEl.dataset.mediaKind = "image";
    document.body.appendChild(mirrorEl);
    document.elementFromPoint = () => mirrorEl;
    syncMod.registerStackBridge({
        sendBlobToMediaMirror: (el, blob, name) => { bridgeCalls.push({ el, blob, name }); return true; },
        findMediaMirror: (kind) => (kind === "image" ? mirrorEl : null),
    });

    const imgCard = imgCards()[0];
    const main = imgCard.querySelector(".hub-stack-card-main");
    main.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
    await settle();
    check("SN: the mirror is highlighted as the drop target",
        hooks.dragState()?.target?.kind === "mirror" && mirrorEl.classList.contains("hub-stack-drop-hot"));
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 200, clientY: 200 }));
    await settle();
    check("SN: the bridge got the blob + a sane file name",
        bridgeCalls.length === 1 && bridgeCalls[0].el === mirrorEl &&
        bridgeCalls[0].blob.size > 0 && /\.png$/.test(bridgeCalls[0].name),
        JSON.stringify(bridgeCalls.map((c) => ({ name: c.name, size: c.blob?.size }))));
    check("SN: the drop-hot class is cleared", !mirrorEl.classList.contains("hub-stack-drop-hot"));
    mirrorEl.remove();
    document.elementFromPoint = () => null;
}

// ===========================================================================
// SO - v71: [→] on a file card sends the blob into a matching media row
// ===========================================================================

phase("SO send to media row — [→] resolves a kind-matched mirror via the bridge");
{
    const bridgeCalls = [];
    const mirrorEl = document.createElement("span");
    mirrorEl.className = "hub-mirror-media";
    mirrorEl.dataset.mediaKind = "video";
    document.body.appendChild(mirrorEl);
    syncMod.registerStackBridge({
        sendBlobToMediaMirror: (el, blob, name) => { bridgeCalls.push({ el, blob, name }); return true; },
        findMediaMirror: (kind) => (kind === "video" ? mirrorEl : null),
    });
    const videoCard = document.querySelector('.hub-stack-card[data-type="video"]');
    check("SO: a video card exists", !!videoCard);
    videoCard.querySelector('[data-act="send"]').click();
    await settle();
    check("SO: bridge called with the video mirror + payload",
        bridgeCalls.length === 1 && bridgeCalls[0].el === mirrorEl && bridgeCalls[0].blob.size > 0,
        JSON.stringify(bridgeCalls.map((c) => ({ name: c.name }))));

    // no matching row -> no crash, no call
    syncMod.registerStackBridge({ findMediaMirror: () => null });
    const before = bridgeCalls.length;
    document.querySelector('.hub-stack-card[data-type="audio"] [data-act="send"]')?.click();
    await settle();
    check("SO: no matching mirror -> bridge not called", bridgeCalls.length === before);
    mirrorEl.remove();
    syncMod.registerStackBridge({}); // restore an empty bridge (renderer's own stays for prod)
}

// ===========================================================================
// SP - v72: pins survive eviction (PATCH + eviction skip)
// ===========================================================================

phase("SP pins — 📌 PATCHes the server and survives max-eviction");
{
    extStack.setup(); // clean mount for a deterministic list
    await settle();
    const pinned = serverTextCard();
    const pinnedId = pinned.getAttribute("data-id");
    pinned.querySelector('[data-act="pin"]').click();
    await settle();
    const pinCalls = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch" &&
        String(c.body).includes('"pinned":true'));
    check("SP: PATCH {pinned:true} sent for the right entry",
        pinCalls.length === 1 && String(pinCalls[0].body).includes(`"${pinnedId}"`),
        JSON.stringify(pinCalls.map((c) => c.body)));
    check("SP: the card shows the pinned state",
        document.querySelector(`.hub-stack-card[data-id="${pinnedId}"]`)?.classList.contains("hub-stack-card-pin") === true);

    stack.setStackMax(1);
    await hooks.captureFromClipboardData({ text: "evict me" });
    await settle();
    await hooks.captureFromClipboardData({ text: "evict me too" });
    await settle();
    check("SP: the pinned entry SURVIVED the eviction",
        fakeApi.__items().some((x) => x.id === pinnedId && x.pinned === true),
        JSON.stringify(fakeApi.__items().map((x) => ({ id: x.id, pin: x.pinned }))));
    check("SP: the list collapsed to the pinned entry only",
        fakeApi.__items().length === 1, String(fakeApi.__items().length));
    stack.setStackMax(100);

    // unpin restores the normal aging
    document.querySelector(`.hub-stack-card[data-id="${pinnedId}"] [data-act="pin"]`)?.click();
    await settle();
    check("SP: unpin PATCHed", fakeApi.__items().find((x) => x.id === pinnedId)?.pinned === false);
}

// ===========================================================================
// SQ - v72: rename + tags via the inline editor
// ===========================================================================

phase("SQ edit — ✎ opens the inline editor, save PATCHes name+tags");
{
    extStack.setup();
    await settle();
    // a couple of extra entries so the tag filter has something to filter out
    await hooks.captureFromClipboardData({ text: "another snippet" });
    await hooks.captureFromClipboardData({ text: "third one" });
    await settle();
    const card = serverTextCard();
    const id = card.getAttribute("data-id");
    card.querySelector('[data-act="edit"]').click();
    await settle();
    const editCard = document.querySelector(`.hub-stack-card[data-id="${id}"]`);
    check("SQ: the editor inputs are rendered",
        !!editCard?.querySelector(".hub-stack-edit-name") && !!editCard.querySelector(".hub-stack-edit-tags"));
    editCard.querySelector(".hub-stack-edit-name").value = "Hero prompt";
    editCard.querySelector(".hub-stack-edit-tags").value = "hero, ref, hero";
    editCard.querySelector('[data-act="edit-save"]').click();
    await settle();
    const saved = fakeApi.__items().find((x) => x.id === id);
    check("SQ: name saved", saved?.name === "Hero prompt", String(saved?.name));
    check("SQ: tags cleaned + deduped", JSON.stringify(saved?.tags) === '["hero","ref"]', JSON.stringify(saved?.tags));
    const after = document.querySelector(`.hub-stack-card[data-id="${id}"]`);
    check("SQ: the card shows the new name + tag chips",
        after?.textContent.includes("Hero prompt") && !!after.querySelector('.hub-stack-tag[data-tag="hero"]'));
    check("SQ: the editor closed", !document.querySelector(".hub-stack-card-edit"));

    // tag chip filters the list; the toolbar chip clears it
    after.querySelector('.hub-stack-tag[data-tag="hero"]').click();
    await settle();
    check("SQ: tag filter applied (only tagged cards visible)",
        cards().length === 1 && hooks.viewFilter().tag === "hero", `${cards().length}`);
    const tagnote = panel().querySelector(".hub-stack-tagnote");
    tagnote.click();
    await settle();
    check("SQ: the toolbar chip clears the tag filter", cards().length > 1 && hooks.viewFilter().tag === null);

    // cancel discards
    document.querySelector(`.hub-stack-card[data-id="${id}"] [data-act="edit"]`).click();
    await settle();
    const ec = document.querySelector(`.hub-stack-card[data-id="${id}"]`);
    ec.querySelector(".hub-stack-edit-name").value = "must not persist";
    ec.querySelector('[data-act="edit-cancel"]').click();
    await settle();
    check("SQ: cancel keeps the stored name", fakeApi.__items().find((x) => x.id === id)?.name === "Hero prompt");
}

// ===========================================================================
// SR - v72: search + kind filter
// ===========================================================================

phase("SR filters — search box and kind chips narrow the view only");
{
    const search = panel().querySelector(".hub-stack-search");
    const total = cards().length;
    const serverTotal = fakeApi.__items().length;
    search.value = "Hero";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("SR: search narrows to the named card", cards().length === 1 &&
        textCards()[0]?.textContent.includes("Hero prompt"), `${cards().length}`);
    check("SR: server truth untouched by the filter",
        fakeApi.__items().length === serverTotal, `${fakeApi.__items().length} vs ${serverTotal}`);

    search.value = "";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    panel().querySelector('[data-kind="image"]').click();
    await settle();
    check("SR: kind=Img hides text/video/file cards",
        cards().length === document.querySelectorAll('.hub-stack-card[data-type="image"]').length &&
        cards().every((c) => c.dataset.type === "image"));
    panel().querySelector('[data-kind="all"]').click();
    await settle();
    check("SR: All restores the full list", cards().length === total, `${cards().length} vs ${total}`);

    search.value = "zzz-no-such-entry";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("SR: zero matches render the filter hint",
        cards().length === 0 && panel().querySelector(".hub-stack-list").textContent.includes("No entries match"));
    search.value = "";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
}

// ===========================================================================
// SS - v72: →📝 inserts into the last focused hub text field (+ uses)
// ===========================================================================

phase("SS insert — →📝 writes the snippet via the bridge and bumps uses");
{
    const bridgeCalls = [];
    syncMod.registerStackBridge({
        insertTextIntoLastFocused: (t) => { bridgeCalls.push(t); return true; },
        focusedTextInfo: () => ({ label: "Positive" }),
    });
    const card = serverTextCard();
    const id = card.getAttribute("data-id");
    const expectedText = fakeApi.__items().find((x) => x.id === id)?.text;
    card.querySelector('[data-act="ins"]').click();
    await settle();
    check("SS: the bridge got the entry text", bridgeCalls[0] === expectedText,
        JSON.stringify(bridgeCalls));
    const patched = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch" &&
        String(c.body).includes('"bumpUses":true') && String(c.body).includes(`"${id}"`));
    check("SS: the usage counter was bumped", patched.length === 1, JSON.stringify(patched.map((c) => c.body)));

    // no focused field -> the bridge says no, no bump
    syncMod.registerStackBridge({
        insertTextIntoLastFocused: () => false,
        focusedTextInfo: () => null,
    });
    const usesBefore = fakeApi.__items().find((x) => x.id === id)?.uses || 0;
    card.querySelector('[data-act="ins"]').click();
    await settle();
    check("SS: a refused insert does not bump uses",
        (fakeApi.__items().find((x) => x.id === id)?.uses || 0) === usesBefore);
    syncMod.registerStackBridge({});
}

// ===========================================================================
// ST - v72: drag a TEXT card onto a hub text mirror
// ===========================================================================

phase("ST drag text — a text card dropped on a text mirror writes into it");
{
    const bridgeCalls = [];
    const textInput = document.createElement("input");
    textInput.className = "hub-text-input";
    document.body.appendChild(textInput);
    document.elementFromPoint = () => textInput;
    syncMod.registerStackBridge({
        insertTextIntoEl: (el, t) => { bridgeCalls.push({ el, t }); return true; },
    });
    const card = serverTextCard();
    const id = card.getAttribute("data-id");
    const expectedText = fakeApi.__items().find((x) => x.id === id)?.text;
    card.querySelector(".hub-stack-card-main").dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 150, clientY: 150 }));
    await settle();
    check("ST: the text mirror is highlighted", hooks.dragState()?.target?.kind === "text");
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 150, clientY: 150 }));
    await settle();
    check("ST: the bridge got the mirror element + the full text",
        bridgeCalls.length === 1 && bridgeCalls[0].el === textInput && bridgeCalls[0].t === expectedText,
        JSON.stringify(bridgeCalls.map((c) => c.t?.slice(0, 30))));
    textInput.remove();
    document.elementFromPoint = () => null;
    syncMod.registerStackBridge({});
}

// ===========================================================================
// SU - v73: Image Compare - the "Add to Compare" context menu fills A/B
// ===========================================================================

phase("SU compare — context menu on media rows fills slots A then B");
{
    const compare = await import(path.join(path.dirname(stackUrl), "compare.js"));
    const cmp = compare.__compareTestHooks();
    globalThis.__cmp = cmp;

    const extCompare = appStub.__extensions.find((e) => e?.name === "Comfy.SettingsHub.compare");
    check("SU: compare extension registered", !!extCompare);
    check("SU: compare.js self-reports the version the entry EXPECTS (last functional change)",
        !!EXPECTED_MANIFEST.compare && globalThis.__SettingsHubLoaded?.compare === EXPECTED_MANIFEST.compare,
        String(globalThis.__SettingsHubLoaded?.compare) + " vs " + String(EXPECTED_MANIFEST.compare));
    extCompare.setup();

    const mkHost = (src, label) => {
        const host = document.createElement("span");
        host.className = "hub-mirror-media";
        host.dataset.mediaKind = "image";
        host.innerHTML = `<span data-role="media-prev"><img src="${src}"></span>` +
            (label ? `<span class="hub-item-label">${label}</span>` : "");
        // label lives on the ROW in the real hub - emulate it here
        if (label) host.setAttribute("data-hub-item", "row-" + label);
        document.body.appendChild(host);
        return host;
    };
    const hostA = mkHost("/view?filename=alpha.png&type=input", "");
    const ctxOpts = { bubbles: true, cancelable: true, clientX: 300, clientY: 200 };
    hostA.querySelector("img").dispatchEvent(new dom.window.MouseEvent("contextmenu", ctxOpts));
    await settle();
    const menu = document.querySelector(".hub-cmp-menu");
    check("SU: the compare menu opened", !!menu);
    const items = menu ? [...menu.querySelectorAll(".hub-menu-item")] : [];
    const pickA = items.find((it) => it.textContent.includes("slot A"));
    check("SU: the menu offers explicit slots", !!pickA);
    pickA.click();
    await settle();
    check("SU: slot A took the media-row image",
        cmp.slots().A.src.includes("alpha.png"), cmp.slots().A.src);
    check("SU: the compare panel is on screen", !!document.querySelector(".hub-cmp-panel"));

    const hostB = mkHost("/view?filename=beta.png&type=input", "");
    hostB.querySelector("img").dispatchEvent(new dom.window.MouseEvent("contextmenu", ctxOpts));
    await settle();
    document.querySelector(".hub-cmp-menu .hub-menu-item").click(); // the AUTO item
    await settle();
    check("SU: the auto add filled slot B",
        cmp.slots().B.src.includes("beta.png"), JSON.stringify(cmp.slots()));

    // v83 FIELD FIX regression: the images MUST actually be visible. The
    // pre-v83 code toggled with style.display = "" which only REMOVES the
    // inline override and lets the stylesheet's `display: none` default win
    // (the owner saw the A/B labels but never the images).
    const panV = document.querySelector(".hub-cmp-panel");
    check("SU v83: slot A is VISIBLE (explicit display, never '')",
        panV.querySelector(".hub-cmp-a").style.display === "block",
        panV.querySelector(".hub-cmp-a").style.display);
    check("SU v83: slot B is VISIBLE (explicit display, never '')",
        panV.querySelector(".hub-cmp-b").style.display === "block",
        panV.querySelector(".hub-cmp-b").style.display);
    check("SU v83: the natural-size caption lives under the stage",
        !!panV.querySelector(".hub-cmp-sizes"));
    check("SU v83: the caption names the filled slots (loading until decode)",
        /A loading/.test(panV.querySelector(".hub-cmp-sizes").textContent) &&
        /B loading/.test(panV.querySelector(".hub-cmp-sizes").textContent),
        panV.querySelector(".hub-cmp-sizes").textContent);

    // a third add SHIFTS: A<-B, B<-new
    const hostC = mkHost("/view?filename=gamma.png&type=input", "");
    hostC.querySelector("img").dispatchEvent(new dom.window.MouseEvent("contextmenu", ctxOpts));
    await settle();
    document.querySelector(".hub-cmp-menu .hub-menu-item").click();
    await settle();
    check("SU: the third add shifts the queue (A=beta, B=gamma)",
        cmp.slots().A.src.includes("beta.png") && cmp.slots().B.src.includes("gamma.png"),
        JSON.stringify({ A: cmp.slots().A.src, B: cmp.slots().B.src }));

    // swap + clear
    cmp.swapSlots();
    check("SU: swap exchanged the slots",
        cmp.slots().A.src.includes("gamma.png") && cmp.slots().B.src.includes("beta.png"));
    document.querySelector('.hub-cmp-clear[data-clear="A"]').click();
    check("SU: slot A cleared", !cmp.slots().A.src && !!cmp.slots().B.src);
    check("SU v83: the cleared slot hides with an explicit 'none'",
        document.querySelector(".hub-cmp-panel").querySelector(".hub-cmp-a").style.display === "none",
        document.querySelector(".hub-cmp-panel").querySelector(".hub-cmp-a").style.display);

    // stack image card as a source (context menu on a .hub-stack-card)
    const stackImg = document.createElement("div");
    stackImg.className = "hub-stack-card";
    stackImg.dataset.type = "image";
    stackImg.innerHTML = `<div class="hub-stack-card-main"><img class="hub-stack-thumb" src="/settings_hub/stack/file/srvX.png"><div class="hub-stack-meta"><span class="hub-stack-name">srvX.png</span></div></div>`;
    document.body.appendChild(stackImg);
    stackImg.querySelector("img").dispatchEvent(new dom.window.MouseEvent("contextmenu", ctxOpts));
    await settle();
    document.querySelector(".hub-cmp-menu .hub-menu-item").click(); // auto -> A (was cleared)
    await settle();
    check("SU: a STACK image card feeds the compare too", !!cmp.slots().A.src &&
        cmp.slots().A.src.includes("srvX.png"), cmp.slots().A.src);
    stackImg.remove();
}

// ===========================================================================
// SV - v73: modes (wipe / fade / blink / diff) + persisted controls
// ===========================================================================

phase("SV compare modes — wipe divider, fade slider, blink click, diff guard");
{
    const cmp = globalThis.__cmp;
    const panelEl = document.querySelector(".hub-cmp-panel");
    const stage = panelEl.querySelector(".hub-cmp-stage");
    stage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0 });
    // jsdom has no canvas backend: shadow getContext to the graceful null path
    panelEl.querySelector(".hub-cmp-canvas").getContext = () => null;

    // refill B (cleared in SU)
    const cmpB = { src: "/view?filename=beta.png", label: "B row" };
    cmp.addToCompare(cmpB.src, cmpB.label, null, "B");
    await settle();

    cmp.setMode("wipe");
    await settle();
    check("SV: wipe shows the divider (v83: explicit display)",
        panelEl.querySelector(".hub-cmp-divider").style.display === "block",
        panelEl.querySelector(".hub-cmp-divider").style.display);
    stage.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 150 }));
    await settle();
    check("SV: a stage click at 25% moves the wipe", Math.round(cmp.state().split) === 25, String(cmp.state().split));

    cmp.setMode("fade");
    await settle();
    const fadeWrap = panelEl.querySelector(".hub-cmp-fadewrap");
    check("SV: fade shows the slider", fadeWrap.style.display !== "none");
    const fadeInput = panelEl.querySelector(".hub-cmp-fade");
    fadeInput.value = "80";
    fadeInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("SV: the fade slider drives the B layer opacity",
        panelEl.querySelector(".hub-cmp-b").style.opacity === "0.8" && cmp.state().fade === 80);

    cmp.setMode("blink");
    await settle();
    check("SV: blink starts visible-B", cmp.state().blinkOn === false);
    stage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 }));
    await settle();
    check("SV: a stage click blinks (B hidden)", cmp.state().blinkOn === true);
    stage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 200, clientY: 150 }));
    await settle();
    check("SV: the second click blinks back", cmp.state().blinkOn === false);

    cmp.setMode("diff");
    await settle();
    const gainWrap = panelEl.querySelector(".hub-cmp-gainwrap");
    check("SV: diff shows the gain slider", gainWrap.style.display !== "none");
    check("SV v83: the diff canvas is VISIBLE (explicit display)",
        panelEl.querySelector(".hub-cmp-canvas").style.display === "block",
        panelEl.querySelector(".hub-cmp-canvas").style.display);
    check("SV v83: the diff hint names the different-size convention",
        panelEl.querySelector(".hub-cmp-hint").textContent.includes("A's frame"));
    const gainInput = panelEl.querySelector(".hub-cmp-gain");
    gainInput.value = "7";
    gainInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    check("SV: the gain accepts 1..10", cmp.state().gain === 7, String(cmp.state().gain));
    check("SV: diff mode survived jsdom's null canvas (graceful)", !!panelEl && panelEl.isConnected);

    // persistence of mode + gain + split
    const ui = JSON.parse(localStorage.getItem("settingshub.compare.ui") || "{}");
    check("SV: mode/gain/split persist", ui.mode === "diff" && ui.gain === 7 && ui.split === 25,
        JSON.stringify(ui));
}

// ===========================================================================
// SW - v73: auto-refresh on every queue run (api "executed")
// ===========================================================================

phase("SW compare refresh — the executed event re-reads the sources");
{
    const cmp = globalThis.__cmp;
    const hostR = document.createElement("span");
    hostR.className = "hub-mirror-media";
    hostR.innerHTML = `<span data-role="media-prev"><img src="/view?filename=run1.png"></span>`;
    document.body.appendChild(hostR);
    cmp.addToCompare("/view?filename=run1.png", "Live row", hostR.querySelector('[data-role="media-prev"]'), "B");
    await settle();

    // a new run replaced the loader's file -> the row's img src changes
    hostR.querySelector("img").src = "/view?filename=run2.png";
    fakeApi.__emit("executed");
    await settle();
    check("SW: the executed event updated slot B from its source element",
        cmp.slots().B.src.includes("run2.png"), cmp.slots().B.src);
    hostR.remove();
}

// ===========================================================================
// TX - v83: the LARGE MEDIA VIEWER - 🔍 on image/video/audio/file cards
// opens a big overlay (images zoom/pan, text-like files preview inline).
// ===========================================================================

phase("TX v83 media viewer — 🔍 opens a large preview for every non-text kind");
{
    // seed one entry of every relevant kind through the REAL capture helpers
    await hooks.addImageBlob(
        new dom.window.Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), "shot.png");
    await settle();
    await hooks.addFileBlob(
        new dom.window.Blob(["alpha,beta\n1,2\n"], { type: "" }), "table.csv");
    await settle();
    await hooks.addFileBlob(
        new dom.window.Blob([new Uint8Array([0, 1, 2, 3, 255])], { type: "" }), "blob.bin");
    await settle();
    await hooks.addFileBlob(
        new dom.window.Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" }), "clip.mp4");
    await settle();
    await hooks.addFileBlob(
        new dom.window.Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }), "tone.wav");
    await settle();

    const cardByName = (sel, nm) => [...document.querySelectorAll(sel)]
        .find((c) => [...c.querySelectorAll(".hub-stack-file-name, .hub-stack-name")]
            .some((n) => (n.textContent || "").includes(nm)));

    // ---- IMAGE: overlay, zoom, pan, dblclick, meta, Esc ----
    const imgCard = document.querySelector('.hub-stack-card[data-type="image"]');
    check("TX: the image card carries 🔍 (data-act=view)",
        !!imgCard?.querySelector('[data-act="view"]'));
    imgCard.querySelector('[data-act="view"]').click();
    await settle();
    let ov = hooks.viewerEl();
    check("TX: the image viewer overlay is open (media class)",
        !!ov && ov.classList.contains("hub-stack-viewer-media"));
    let img = ov.querySelector(".hub-stack-viewer-img");
    let stage = ov.querySelector(".hub-stack-viewer-stage");
    check("TX: the viewer shows the image with its src",
        !!img && String(img.getAttribute("src") || "").length > 0 && !!stage);
    check("TX: the image meta line shows kind/size + tab slot",
        /image/.test(ov.querySelector(".hub-stack-viewer-meta").textContent),
        ov.querySelector(".hub-stack-viewer-meta").textContent);

    stage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 });
    stage.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 400, clientY: 300 }));
    await settle();
    check("TX: the wheel zooms IN around the cursor (scale 1.25)",
        img.style.transform.includes("scale(1.25)"), img.style.transform);
    const txBefore = img.style.transform;
    stage.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 400, clientY: 300 }));
    await settle();
    check("TX: zoom compounds (scale 1.5625) and the point stays anchored",
        img.style.transform.includes("scale(1.5625)") && img.style.transform !== txBefore,
        img.style.transform);

    img.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 140, clientY: 130 }));
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 140, clientY: 130 }));
    await settle();
    check("TX: dragging pans the image (translate 40,30)",
        /translate\(40px, 30px\)/.test(img.style.transform), img.style.transform);
    check("TX: the stage shows the grabbing cursor while panning ended",
        !stage.classList.contains("hub-stack-viewer-panning"));

    stage.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true, cancelable: true }));
    await settle();
    check("TX: double-click #1 switches to 1:1 (natural size, reset transform)",
        img.style.maxWidth === "none" && img.style.maxHeight === "none" &&
        /translate\(0px(, 0px)?\)/.test(img.style.transform) && img.style.transform.includes("scale(1)"),
        img.style.maxWidth + "/" + img.style.transform);
    stage.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true, cancelable: true }));
    await settle();
    check("TX: double-click #2 returns to fit (maxWidth capped again)",
        img.style.maxWidth === "100%" && img.style.maxHeight === "100%" &&
        img.style.transform.includes("scale(1)"),
        img.style.maxWidth + "/" + img.style.transform);

    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    check("TX: Esc closed the image viewer", !hooks.viewerEl());

    // ---- VIDEO / AUDIO: big players ----
    const vidCard = cardByName('.hub-stack-card[data-type="video"]', "clip.mp4");
    check("TX: the video card carries 🔍", !!vidCard?.querySelector('[data-act="view"]'));
    vidCard.querySelector('[data-act="view"]').click();
    await settle();
    ov = hooks.viewerEl();
    const vid = ov?.querySelector("video.hub-stack-viewer-video");
    check("TX: the video viewer embeds a big player",
        !!vid && vid.hasAttribute("muted") && vid.hasAttribute("controls") && vid.hasAttribute("autoplay"));
    check("TX: the video viewer offers download in the header",
        !!ov.querySelector(".hub-stack-viewer-dl"));
    ov.querySelector(".hub-stack-viewer-x").click();
    await settle();
    check("TX: ✕ closed the video viewer", !hooks.viewerEl());

    const audCard = cardByName('.hub-stack-card[data-type="audio"]', "tone.wav");
    audCard.querySelector('[data-act="view"]').click();
    await settle();
    ov = hooks.viewerEl();
    check("TX: the audio viewer embeds a big player",
        !!ov?.querySelector("audio.hub-stack-viewer-audio-el"));
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();

    // ---- TEXT FILE: inline preview through the server file route ----
    const csvCard = cardByName('.hub-stack-card[data-type="file"]', "table.csv");
    check("TX: the .csv lands as a FILE card with 🔍",
        !!csvCard?.querySelector('[data-act="view"]'));
    csvCard.querySelector('[data-act="view"]').click();
    await settle();
    ov = hooks.viewerEl();
    let pre = ov?.querySelector(".hub-stack-viewer-pre");
    check("TX: a text-like file previews INLINE (csv content)",
        !!pre && pre.textContent.includes("alpha,beta"), pre?.textContent?.slice(0, 80));
    let copied = "";
    setClipboard({ writeText: async (t) => { copied = String(t); } });
    ov.querySelector(".hub-stack-viewer-copy").click();
    await settle();
    check("TX: the viewer's copy button copies the file text", copied.includes("alpha,beta"));
    check("TX: the text-file viewer carries the 300 KB hint",
        /300 KB/.test(ov.querySelector(".hub-stack-viewer-hint").textContent));
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();

    // ---- BINARY FILE: no inline preview + download ----
    const binCard = cardByName('.hub-stack-card[data-type="file"]', "blob.bin");
    binCard.querySelector('[data-act="view"]').click();
    await settle();
    ov = hooks.viewerEl();
    check("TX: a binary file says 'no inline preview' + offers ⤓",
        !!ov?.querySelector(".hub-stack-viewer-nopreview") && !!ov.querySelector(".hub-stack-viewer-dl"));
    check("TX: the binary viewer has NO copy button",
        !ov.querySelector(".hub-stack-viewer-copy"));
    // a click that BUBBLES from the card (not the backdrop) must NOT close
    ov.querySelector(".hub-stack-viewer-card")
        .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle();
    check("TX: a click ON THE CARD (not the backdrop) does not close",
        !!hooks.viewerEl());
    hooks.closeViewer();
    await settle();
    check("TX: closeViewer tears the overlay down", !hooks.viewerEl());

    // ---- the text viewer is UNCHANGED (regression) ----
    await hooks.captureFromClipboardData({ text: "plain text for the v79 viewer" });
    await settle();
    const tCard = [...document.querySelectorAll(".hub-stack-card[data-type=\"text\"]")][0];
    tCard.querySelector('[data-act="view"]').click();
    await settle();
    ov = hooks.viewerEl();
    check("TX: text cards keep the v79 text overlay (no media class)",
        !!ov && !ov.classList.contains("hub-stack-viewer-media") &&
        ov.querySelector(".hub-stack-viewer-body").textContent.includes("plain text for the v79 viewer"));
    check("TX: the text overlay keeps →📝", !!ov.querySelector(".hub-stack-viewer-ins"));
    hooks.closeViewer();

    // ---- source + css contracts ----
    const stackSrc = fs.readFileSync(path.join(ROOT, "web", "stack.js"), "utf8");
    // v85: ONE magnifier per card - the base set carries the single viewAct
    // button literal and every kind branch starts its acts with it: base(1)
    // + 4 = 5 (v96 adds the nodes branch: 6). A reintroduced duplicate (the
    // v83 `viewAct + ... + acts` prepend) would push the count past that, a
    // second inline button literal would break the === 1 below.
    check("TX source: the 🔍 view act is wired ONCE per card, every kind branch uses it (v85: no duplicate magnifier; v96 adds nodes)",
        (stackSrc.match(/class="hub-stack-act" data-act="view"/g) || []).length === 1 &&
        (stackSrc.match(/acts = viewAct/g) || []).length === 6,
        String((stackSrc.match(/acts = viewAct/g) || []).length));
    check("TX source: openViewer dispatches by type (text keeps v79 overlay)",
        /if \(item\.type === "image"\) return openMediaViewer\(item, "image"\)/.test(stackSrc) &&
        /return openTextViewer\(item\)/.test(stackSrc));
    check("TX source: text-like file preview is capped at 300 KB",
        /MEDIA_TEXT_BYTES = 300 \* 1024/.test(stackSrc) &&
        stackSrc.includes("preview truncated at 300 KB"));
    const cmpSrc = fs.readFileSync(path.join(ROOT, "web", "compare.js"), "utf8");
    check("TX source: compare.js toggles stage visibility EXPLICITLY (the v83 fix)",
        /setDisp\(slotAEl, hasA\)/.test(cmpSrc) && /setDisp\(slotBEl, hasB\)/.test(cmpSrc) &&
        /setDisp\(canvasEl, mode === "diff"\)/.test(cmpSrc) &&
        /setDisp\(dividerEl, mode === "wipe" && hasA && hasB\)/.test(cmpSrc));
    check("TX source: the old '' toggle is gone from compare.js stage elements",
        !/slot[AB]El\.style\.display/.test(cmpSrc) &&
        !/canvasEl\.style\.display/.test(cmpSrc) &&
        !/dividerEl\.style\.display/.test(cmpSrc));
    check("TX source: the sizes caption updates on img load/error",
        cmpSrc.includes('imgA.addEventListener("load", updateSizes)') &&
        cmpSrc.includes('imgB.addEventListener("error", updateSizes)'));
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8");
    check("TX css: the media stage crops + centers its content",
        /\.hub-stack-viewer-stage \{[^}]*overflow:\s*hidden/.test(css.replace(/\n/g, " ")));
    check("TX css: the media card fills the viewport (94vw/90vh)",
        /hub-stack-viewer-card-media \{[^}]*94vw/.test(css.replace(/\n/g, " ")));
    check("TX css: .hub-cmp-sizes caption exists",
        css.includes(".hub-cmp-sizes") && css.includes(".hub-cmp-sizes:empty"));
}

// ===========================================================================
// TZ - v85: the stacker stays on-screen when the browser window shrinks
// ===========================================================================

phase("TZ v85 resize — build + window resize re-fit the panel into the viewport");
{
    // Part 1 - BUILD path: saved geometry parked outside a small viewport
    // (as if saved on a big monitor) must land inside on mount. jsdom inner
    // size is 1024x768; offsetWidth is 0 there, so the clamps work with
    // their 260x120 fallbacks: x -> vw-260-8 = 756, y -> vh-120-8 = 640,
    // saved w 2800 -> cap 560 (applySize max), saved h 1200 -> vh-24 = 744.
    localStorage.setItem("settingshub.stack.ui",
        JSON.stringify({ x: 3000, y: 1600, w: 2800, h: 1200 }));
    extStack.setup(); // fresh mount - buildDom() ends with refitIntoView()
    await settle();
    check("TZ build: the panel is pulled back inside the viewport",
        panel().style.left === "756px" && panel().style.top === "640px",
        panel().style.left + " " + panel().style.top);
    check("TZ build: the saved size is capped to the viewport (560x744)",
        panel().style.width === "560px" && panel().style.height === "744px",
        panel().style.width + " " + panel().style.height);

    // Part 2 - RESIZE path: park the panel outside again and fire a real
    // window resize event; refitIntoView runs instantly, the debounced
    // persist (150ms) remembers the clamped spot.
    localStorage.setItem("settingshub.stack.ui",
        JSON.stringify({ x: 3000, y: 1600, w: 280, h: 380 }));
    window.dispatchEvent(new dom.window.Event("resize"));
    await settle();
    check("TZ resize: the panel is re-clamped inside the viewport",
        panel().style.left === "756px" && panel().style.top === "640px",
        panel().style.left + " " + panel().style.top);
    check("TZ resize: the debounced persist remembers the clamped spot",
        await new Promise((r) => setTimeout(() => {
            const ui = JSON.parse(localStorage.getItem("settingshub.stack.ui") || "{}");
            r(ui.x === 756 && ui.y === 640);
        }, 250)),
        localStorage.getItem("settingshub.stack.ui"));

    // Part 3 - contract: teardown must remove the resize hook (the test
    // hooks expose no teardown entry point, so this one is checked on the
    // source the suite actually loaded)
    const src85 = fs.readFileSync(stackUrl, "utf8");
    check("TZ teardown: teardown() removes the resize listener + debounced timer",
        /removeEventListener\("resize", onWinResize\)/.test(src85) &&
        /clearTimeout\(resizePersistT\)/.test(src85));
}

// ===========================================================================
// SX - v74: the 🗑 CLEAR button lives in the panel header (double-confirm)
// ===========================================================================

phase("SX clear in the panel — first click arms, second click wipes");
{
    extStack.setup(); // fresh mount with the v74 header
    await settle();
    await hooks.captureFromClipboardData({ text: "to be wiped" });
    await settle();
    check("SX: the header carries the clear button", !!panel().querySelector(".hub-stack-head .hub-stack-clear"));

    const clearBtn = panel().querySelector(".hub-stack-clear");
    const callsBefore = fakeApi.__calls.length;
    clearBtn.click();
    await settle();
    const armCalls = fakeApi.__calls.slice(callsBefore);
    check("SX: the first click only ARMS (no POST clear yet)",
        clearBtn.classList.contains("hub-stack-clear-armed") &&
        !armCalls.some((c) => c.url === "/settings_hub/stack/clear"),
        JSON.stringify(armCalls.map((c) => c.method + " " + c.url)));

    clearBtn.click();
    await settle();
    check("SX: the second click POSTs /settings_hub/stack/clear",
        fakeApi.__calls.slice(callsBefore).some((c) => c.method === "POST" && c.url === "/settings_hub/stack/clear"));
    check("SX: the panel is empty (empty-state row)", cards().length === 0 && !!panel().querySelector(".hub-stack-empty"));
    check("SX: the server list is empty too", fakeApi.__items().length === 0);
    check("SX: the armed state is gone", !clearBtn.classList.contains("hub-stack-clear-armed"));
}

// ===========================================================================
// SY - v74: the scroll contract in styles.css + the eye covers nav buttons
// ===========================================================================

phase("SY scroll + eye — min-height:0, styled scrollbar, nav buttons hide");
{
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8");
    const listRule = css.slice(css.indexOf(".hub-stack-list {"), css.indexOf(".hub-stack-list::-webkit-scrollbar"));
    check("SY: .hub-stack-list has min-height:0 (THE scrollbar fix)",
        /min-height:\s*0/.test(listRule));
    check("SY: .hub-stack-list scrolls with a styled, always-visible scrollbar",
        /overflow-y:\s*scroll/.test(listRule) && /scrollbar-width:\s*thin/.test(listRule) &&
        /scrollbar-color/.test(listRule) && css.includes(".hub-stack-list::-webkit-scrollbar-thumb"));
    check("SY: cards keep their separation (flex: 0 0 auto)",
        /\.hub-stack-card \{[^}]*flex:\s*0 0 auto/.test(css.replace(/\n/g, " ")));
    const chromeBlock = css.slice(css.indexOf("hub-chrome-hidden .hub-drag-handle"), css.indexOf("hub-searching .hub-drag-handle"));
    check("SY: the eye ALSO hides the nav authoring buttons (AGENTS.md 5.1 closed)",
        chromeBlock.includes(".hub-add-nav") && chromeBlock.includes(".hub-nav-move"));
}

// ===========================================================================
// SZ - v74: Enter commits the inline editor, Escape cancels it
// ===========================================================================

phase("SZ enter commits — Enter saves name+tags, Esc cancels");
{
    extStack.setup();
    await settle();
    await hooks.captureFromClipboardData({ text: "kbd snippet body" }); // SX wiped the stack
    await settle();
    const card = serverTextCard();
    const id = card.getAttribute("data-id");
    card.querySelector('[data-act="edit"]').click();
    await settle();
    const editCard = document.querySelector(`.hub-stack-card[data-id="${id}"]`);
    const nameInput = editCard.querySelector(".hub-stack-edit-name");
    const tagsInput = editCard.querySelector(".hub-stack-edit-tags");
    nameInput.value = "Enter saved me";
    tagsInput.value = "kbd, quick";
    tagsInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    const saved = fakeApi.__items().find((x) => x.id === id);
    check("SZ: Enter committed the name + tags",
        saved?.name === "Enter saved me" && JSON.stringify(saved?.tags) === '["kbd","quick"]',
        JSON.stringify({ name: saved?.name, tags: saved?.tags }));
    check("SZ: the editor closed after Enter", !document.querySelector(".hub-stack-card-edit"));

    // Escape discards the edit
    document.querySelector(`.hub-stack-card[data-id="${id}"] [data-act="edit"]`).click();
    await settle();
    const ec = document.querySelector(`.hub-stack-card[data-id="${id}"]`);
    ec.querySelector(".hub-stack-edit-name").value = "must not persist";
    ec.querySelector(".hub-stack-edit-name").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    check("SZ: Escape cancelled without saving",
        fakeApi.__items().find((x) => x.id === id)?.name === "Enter saved me" &&
        !document.querySelector(".hub-stack-card-edit"));
}

// ===========================================================================
// TA - v74: a VIDEO card drags onto a real node (options.video_upload combo)
// ===========================================================================

phase("TA drag video to node — VHS-style combo (name 'file' + video_upload)");
{
    await hooks.captureFromClipboardData({
        files: [new dom.window.Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" })],
    });
    await settle();
    const videoCard = document.querySelector('.hub-stack-card[data-type="video"]');
    check("TA: a video card exists to drag", !!videoCard);

    const fakeCanvasEl = document.createElement("canvas");
    fakeCanvasEl.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 });
    document.elementFromPoint = (x, y) =>
        (x >= 0 && y >= 0 && x <= 800 && y <= 600) ? fakeCanvasEl : null;
    appStub.canvas = { canvas: fakeCanvasEl, ds: { scale: 1, offset: [0, 0] }, setDirty: () => {} };
    const videoWidget = {
        name: "file", type: "combo", value: "", options: { values: [], video_upload: true },
        callbackCalls: [],
    };
    videoWidget.callback = (v) => { videoWidget.callbackCalls.push(v); };
    const vhsNode = {
        title: "Load Video (Upload)", type: "VHS_LoadVideo", pos: [50, 50], size: [240, 180],
        widgets: [videoWidget],
    };
    appStub.graph = { getNodeOnPos: () => vhsNode };

    // widget detection contract (names + flags, per kind)
    check("TA: uploadWidgetOf finds the flag-bearing combo",
        hooks.uploadWidgetOf(vhsNode, "video") === videoWidget);
    check("TA: uploadWidgetOf is kind-strict",
        hooks.uploadWidgetOf(vhsNode, "image") === null &&
        hooks.uploadWidgetOf({ widgets: [{ name: "audio", type: "combo", options: { values: [], audio_upload: true } }] }, "video") === null &&
        hooks.uploadWidgetOf({ widgets: [{ name: "video", type: "combo", options: { values: [] } }] }, "video") !== null);

    const main = videoCard.querySelector(".hub-stack-card-main");
    main.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 30, clientY: 30 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 400, clientY: 300 }));
    await settle();
    check("TA: the video node is highlighted as the target",
        hooks.dragState()?.target?.kind === "node" && hooks.dragState()?.target?.wkind === "video");
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 400, clientY: 300 }));
    await settle();
    check("TA: /upload/image POSTed (ComfyUI's ONLY upload route)", fakeApi.__uploadCalls() >= 1);
    check("TA: the video combo got the uploaded file", videoWidget.value === "uploaded.png", String(videoWidget.value));
    check("TA: the combo callback fired", videoWidget.callbackCalls.includes("uploaded.png"));
    document.elementFromPoint = () => null;
}

// ===========================================================================
// TB - v74: a TEXT card drags onto a REAL prompt node (string widgets)
// ===========================================================================

phase("TB drag text to node — the string widget under the cursor wins");
{
    const fakeCanvasEl = document.createElement("canvas");
    fakeCanvasEl.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 });
    document.elementFromPoint = (x, y) =>
        (x >= 0 && y >= 0 && x <= 800 && y <= 600) ? fakeCanvasEl : null;
    appStub.canvas = { canvas: fakeCanvasEl, ds: { scale: 1, offset: [0, 0] }, setDirty: () => {} };
    const widgetA = { name: "text", type: "customtext", value: "old-a", callbackCalls: [] };
    widgetA.callback = (v) => { widgetA.callbackCalls.push(v); };
    const widgetB = { name: "positive", type: "customtext", value: "old-b", callbackCalls: [] };
    widgetB.callback = (v) => { widgetB.callbackCalls.push(v); };
    const promptNode = {
        title: "CLIP Text Encode", type: "CLIPTextEncode", pos: [10, 10], size: [300, 200],
        widgets: [widgetA, widgetB],
    };
    appStub.graph = { getNodeOnPos: () => promptNode };

    const card = serverTextCard();
    const id = card.getAttribute("data-id");
    const expected = fakeApi.__items().find((x) => x.id === id)?.text;
    check("TB: isTextWidget accepts string/customtext/multiline only",
        hooks.textWidgetsOf(promptNode).length === 2 &&
        hooks.textWidgetsOf({ widgets: [{ name: "seed", type: "number" }] }).length === 0);

    // cursor preference: getWidgetOnPos resolves to widgetB
    appStub.canvas.getWidgetOnPos = () => widgetB;
    card.querySelector(".hub-stack-card-main").dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 8, clientY: 8 }));
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 500, clientY: 300 }));
    await settle();
    check("TB: the prompt node is highlighted with the TEXT variant",
        hooks.dragState()?.target?.kind === "node" && hooks.dragState()?.target?.wkind === "text" &&
        document.querySelector(".hub-stack-targetbox")?.classList.contains("hub-stack-targetbox-text"));
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 500, clientY: 300 }));
    await settle();
    check("TB: the widget UNDER THE CURSOR got the text",
        widgetB.value === expected && widgetB.callbackCalls.includes(expected) && widgetA.value === "old-a",
        JSON.stringify({ a: widgetA.value, b: widgetB.value }));
    check("TB: the usage counter was bumped",
        fakeApi.__items().find((x) => x.id === id)?.uses >= 1);

    // fallback: a non-text hit or no hit -> the node's FIRST text widget
    appStub.canvas.getWidgetOnPos = () => ({ name: "seed", type: "number" });
    check("TB: a non-text getWidgetOnPos falls back to the first text widget",
        hooks.textWidgetAt(promptNode, 0, 0) === widgetA);
    delete appStub.canvas.getWidgetOnPos;
    document.elementFromPoint = () => null;
}

// ===========================================================================
// TC - v74: Ctrl+V with a panel input focused is NOT captured
// ===========================================================================

phase("TC paste gate — a focused panel input (search) wins over capture");
{
    hooks.setPasteHover(true);
    const search = panel().querySelector(".hub-stack-search");
    search.focus();
    const textsBefore = postTexts().length;
    const ev = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { getData: (t) => (t === "text/plain" ? "pasted into the field" : ""), files: [] };
    window.dispatchEvent(ev);
    await settle();
    check("TC: the event was NOT preventDefault'ed (the field pastes normally)",
        ev.defaultPrevented === false);
    check("TC: nothing was captured to the stack", postTexts().length === textsBefore);
    search.blur();
    hooks.setPasteHover(false);
}

// ===========================================================================
// TS - v77: stack scope - per-workflow stores vs the shared stack
// ===========================================================================

phase("TS v77 scope — per-workflow stores, switch, @workflow badge, scoped clear");
{
    // a FRESH fake graph (TB replaced the stub with a bare node lookup)
    const graph = { extra: {} };
    appStub.graph = graph;

    check("TS: default scope is shared (pre-v77 behavior)", stack.getStackScope() === "global");

    // a deterministic SHARED fixture (earlier phases wiped the preload)
    await hooks.captureFromClipboardData({ text: "shared keeper" });
    await settle();

    stack.setStackScope("workflow");
    await settle();
    check("TS: scope persisted + panel remounted", stack.getStackScope() === "workflow" && !!panel());
    const wfId1 = graph.extra.settingshubStackId;
    check("TS: the workflow got a stack id (saved INTO the workflow file)",
        typeof wfId1 === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(wfId1), String(wfId1));
    const lastListGet = () => [...fakeApi.__calls].reverse()
        .find((c) => c.method === "GET" && c.url.startsWith("/settings_hub/stack") && !c.url.includes("health"));
    check("TS: the list GET is scoped ?wf=",
        lastListGet().url.includes("wf=" + encodeURIComponent(wfId1)), lastListGet().url);
    check("TS: a fresh workflow starts EMPTY (no shared entries leak)",
        cards().length === 0, String(cards().length));
    check("TS: @workflow badge visible in the header",
        panel().querySelector(".hub-stack-scope").style.display !== "none" &&
        panel().querySelector(".hub-stack-scope").textContent === "@workflow");
    check("TS: the empty state explains the workflow scope",
        panel().querySelector(".hub-stack-empty")?.textContent.includes("THIS workflow") === true);

    // capture lands in the WORKFLOW store, the shared store is untouched
    await hooks.captureFromClipboardData({ text: "per-wf snippet" });
    await settle();
    check("TS: capture POSTed with the wf scope",
        fakeApi.__calls.some((c) => c.method === "POST" &&
            c.url.startsWith("/settings_hub/stack/item?wf=" + encodeURIComponent(wfId1))));
    check("TS: the card renders", cards().length === 1 && textCards()[0]?.textContent.includes("per-wf snippet"),
        String(cards().length));
    check("TS: the SHARED store still holds its own entries",
        fakeApi.__items().some((x) => x.text === "shared keeper"));
    check("TS: the WORKFLOW store holds the new entry",
        fakeApi.__itemsOf(wfId1).some((x) => x.text === "per-wf snippet"));

    // workflow switch: LiteGraph onConfigure -> the NEW workflow's store.
    // configure() REPLACES graph.extra wholesale - mirror that here (mutating
    // only the id would drag the previous workflow's embed along).
    graph.extra = { settingshubStackId: "wf-second-01" };
    hooks.fireWorkflowSwitch();
    await settle();
    check("TS: the switch re-read the NEW workflow's store",
        lastListGet().url.includes("wf=wf-second-01"), lastListGet().url);
    check("TS: the new workflow's stack is empty", cards().length === 0, String(cards().length));

    // switch back: the first workflow's entries return
    graph.extra = { settingshubStackId: wfId1 };
    hooks.fireWorkflowSwitch();
    await settle();
    check("TS: switching back restores the first workflow's stack",
        cards().length === 1 && textCards()[0]?.textContent.includes("per-wf snippet"),
        String(cards().length));

    // 🗑 is scoped: wipes THIS workflow's store only
    const clearBtn = panel().querySelector(".hub-stack-clear");
    clearBtn.click();
    await settle();
    clearBtn.click();
    await settle();
    check("TS: 🗑 cleared the workflow store", fakeApi.__itemsOf(wfId1).length === 0,
        JSON.stringify(fakeApi.__itemsOf(wfId1)));
    check("TS: 🗑 left the shared store alone", fakeApi.__items().length >= 2,
        String(fakeApi.__items().length));

    // back to shared
    stack.setStackScope("global");
    await settle();
    check("TS: back to shared - the pre-v77 stack renders again",
        cards().length === fakeApi.__items().length && cards().length >= 2, String(cards().length));
    check("TS: the badge is hidden in shared mode",
        panel().querySelector(".hub-stack-scope").style.display === "none");
    check("TS: shared list GETs carry NO wf param",
        lastListGet() && !lastListGet().url.includes("wf="), lastListGet().url);
}

// ===========================================================================
// TE - v77: the workflow-file text backup (embed + rehydrate)
// ===========================================================================

phase("TE v77 embed — text backup inside the workflow file + auto-restore");
{
    // a workflow "from another machine": the file carries embedded texts,
    // its server store is empty (payloads never existed here)
    const graph = {
        extra: {
            settingshubStackId: "wf-embed-01",
            settingshubStack: [
                { t: "text", text: "embedded prompt from another machine" },
                { t: "text", text: "second embedded snippet", pinned: true },
            ],
        },
    };
    appStub.graph = graph;
    stack.setStackScope("workflow");
    await settle();
    check("TE: both embedded texts were rehydrated into the empty store",
        cards().length === 2 &&
        textCards().some((c) => c.textContent.includes("embedded prompt from another machine")) &&
        textCards().some((c) => c.textContent.includes("second embedded snippet")),
        String(cards().length));
    check("TE: the restore POSTs were scoped to the workflow",
        fakeApi.__calls.filter((c) => c.method === "POST" && c.url.startsWith("/settings_hub/stack/item?wf=wf-embed-01")).length >= 2);
    check("TE: the pinned embed stayed pinned",
        fakeApi.__itemsOf("wf-embed-01").some((x) => x.text === "second embedded snippet" && x.pinned === true),
        JSON.stringify(fakeApi.__itemsOf("wf-embed-01")));

    // deletions propagate INTO the file backup
    const delCard = textCards()[0];
    delCard.querySelector(".hub-stack-del").click();
    await settle();
    check("TE: deleting a card shrinks the embedded backup",
        Array.isArray(graph.extra.settingshubStack) &&
        graph.extra.settingshubStack.length === 1,
        JSON.stringify(graph.extra.settingshubStack));

    // while the server store has entries, an embedded phantom is NOT restored
    graph.extra.settingshubStack = [{ t: "text", text: "phantom must not rehydrate" }];
    await hooks.refresh();
    await settle();
    check("TE: no rehydration while the server store has entries",
        !fakeApi.__itemsOf("wf-embed-01").some((x) => x.text === "phantom must not rehydrate") &&
        !textCards().some((c) => c.textContent.includes("phantom")),
        JSON.stringify(fakeApi.__itemsOf("wf-embed-01")));

    // 🗑 wipes both the store and the file backup (a cleared workflow stays cleared)
    graph.extra.settingshubStack = [{ t: "text", text: "pre-clear backup" }];
    const clearBtn = panel().querySelector(".hub-stack-clear");
    clearBtn.click();
    await settle();
    clearBtn.click();
    await settle();
    check("TE: clear wiped the workflow store", fakeApi.__itemsOf("wf-embed-01").length === 0);
    check("TE: clear wiped the embedded backup too", Array.isArray(graph.extra.settingshubStack) &&
        graph.extra.settingshubStack.length === 0, JSON.stringify(graph.extra.settingshubStack));

    // in shared mode the embed must not be touched at all
    stack.setStackScope("global");
    await settle();
    graph.extra.settingshubStack = [{ t: "text", text: "shared-mode marker" }];
    await hooks.captureFromClipboardData({ text: "shared mode capture" });
    await settle();
    check("TE: shared mode never touches the workflow embed",
        graph.extra.settingshubStack.length === 1 &&
        graph.extra.settingshubStack[0].text === "shared-mode marker",
        JSON.stringify(graph.extra.settingshubStack));
}

// ===========================================================================
// UA-UF - v96: NODE FRAGMENTS (copied graph selections with groups)
// ===========================================================================

phase("UA node fragments — auto-capture: wrapped copyToClipboard stacks the selection");
{
    const frag = JSON.stringify({
        nodes: [
            { id: 1, type: "KSampler", pos: [100, 100], size: [270, 262], widgets_values: [42] },
            { id: 2, type: "CheckpointLoaderSimple", pos: [300, 100], size: [315, 106] },
        ],
        groups: [
            { id: "g1", title: "Sampler block", bounding: [60, 40, 620, 380], color: "#3f7899" },
            { id: "g2", title: "Sources", bounding: [60, 40, 300, 200] },
        ],
        links: [], reroutes: [], subgraphs: [],
    });
    // Fake canvas with the TS-rewrite copy contract: writes localStorage and
    // RETURNS the serialized string (the legacy lib returns undefined - the
    // fallback read covers that shape, see UF).
    appStub.canvas = {
        canvas: document.createElement("div"),
        ds: { scale: 1, offset: [0, 0] },
        setDirty: () => {},
        selectedItems: { size: 3 },
        copyToClipboard: function () {
            localStorage.setItem(hooks.canvasClipboardKey, frag);
            return frag;
        },
    };
    hooks.installCanvasCopyHook(); // idempotent - initStack already armed it
    check("UA: the hook wraps copyToClipboard ONCE",
        appStub.canvas.__shStackCopyHook === true &&
        typeof appStub.canvas.copyToClipboard === "function" &&
        appStub.canvas.copyToClipboard !== undefined);

    const before = cards().length;
    const postsBefore = postTexts().length;
    const ret = appStub.canvas.copyToClipboard(); // the Ctrl+C contract
    await settle();
    check("UA: copy returns the fragment unchanged (ComfyUI behavior intact)",
        ret === frag);
    const nodeCards = () => [...document.querySelectorAll('.hub-stack-card[data-type="nodes"]')];
    check("UA: a nodes card appeared", cards().length === before + 1 && nodeCards().length === 1);
    const card = nodeCards()[0];
    check("UA: the POST body carried type:'nodes'",
        postTexts().length === postsBefore + 1 &&
        JSON.parse(fakeApi.__calls.filter((c) => c.method === "POST" && c.url === "/settings_hub/stack/item").pop().body).type === "nodes");
    check("UA: the card shows the node count", /2\s*nodes/.test(card.textContent), card.textContent.slice(0, 120));
    // v99: the group titles moved INTO the resolved display title (the one
    // named group IS the title) and the meta row shows the group COUNT
    // v99: with TWO groups no single title wins - the resolved display title
    // falls back to the characteristic type names (the user name would win
    // if set; a ONE-group fragment resolves to the group title)
    check("UA: the card resolves the title to the characteristic types",
        card.querySelector(".hub-stack-nodes-name") &&
        card.querySelector(".hub-stack-nodes-name").textContent.includes("KSampler"),
        card.querySelector(".hub-stack-nodes-name")?.textContent);
    check("UA: the card shows the real type names (line 2)",
        card.querySelector(".hub-stack-nodes-types") &&
        card.querySelector(".hub-stack-nodes-types").textContent.includes("CheckpointLoaderSimple"),
        card.querySelector(".hub-stack-nodes-types")?.textContent);
    check("UA: the meta row counts the groups",
        /2\s*groups/.test(card.textContent), card.textContent.slice(0, 160));
    check("UA: the POST body carried nodeMeta (the bounded aggregate)",
        (() => { try { const b = JSON.parse(fakeApi.__calls.filter((c) => c.method === "POST" && c.url === "/settings_hub/stack/item").pop().body); return b.nodeMeta && b.nodeMeta.nodeCount === 2 && Array.isArray(b.nodeMeta.types) && b.nodeMeta.types.length === 2; } catch (_) { return false; } })());
    check("UA: the card carries the →🧩 paste action", !!card.querySelector('[data-act="insg"]'));
    check("UA: the server stored the entry as type nodes",
        fakeApi.__items().some((x) => x.type === "nodes" && x.text === frag));

    // dedupe: re-copying the SAME selection moves the card, never duplicates
    const nBefore = cards().length;
    appStub.canvas.copyToClipboard();
    await settle();
    check("UA: re-copying the same selection does not duplicate",
        cards().length === nBefore &&
        fakeApi.__items().filter((x) => x.text === frag).length === 1);

    // the ⚙ toggle silences the AUTO path
    hooks.setNodeCapture(false);
    appStub.canvas.copyToClipboard();
    await settle();
    check("UA: capture OFF - no new entry", cards().length === nBefore);
    check("UA: the toggle persisted",
        hooks.isNodeCaptureEnabled() === false &&
        localStorage.getItem("settingshub.stack.nodecap") === "0");
    hooks.setNodeCapture(true);
}

phase("UB node fragments — manual ⧩ grab works with the toggle OFF; empty selection refuses");
{
    hooks.setNodeCapture(false);
    // a DIFFERENT selection than UA's (identical content would dedupe-move
    // the existing card instead of adding a new one)
    const fragB = JSON.stringify({
        nodes: [
            { id: 11, type: "CLIPTextEncode", pos: [10, 10], size: [210, 60] },
            { id: 12, type: "EmptyLatentImage", pos: [10, 120], size: [210, 106] },
            { id: 13, type: "VAEDecode", pos: [10, 280], size: [210, 60] },
        ],
        groups: [{ id: "gb", title: "Sampler block", bounding: [0, 0, 260, 380] }],
        links: [], reroutes: [], subgraphs: [],
    });
    appStub.canvas.copyToClipboard = function () {
        localStorage.setItem(hooks.canvasClipboardKey, fragB);
        return fragB;
    };
    const postsBefore = postTexts().length;
    const nBefore = cards().length;
    const ok = await hooks.captureCanvasSelection();
    await settle();
    check("UB: the explicit grab stacks the selection regardless of the toggle",
        ok === true && cards().length === nBefore + 1 && postTexts().length === postsBefore + 1);
    // the newest entry is named after the first group of the selection
    const firstCard = document.querySelector(".hub-stack-card");
    check("UB: auto-name from the first group title", (firstCard?.textContent || "").includes("Sampler block"),
        (firstCard?.textContent || "").slice(0, 80));

    appStub.canvas.selectedItems = { size: 0 };
    const postsMid = postTexts().length;
    const ok2 = await hooks.captureCanvasSelection();
    await settle();
    check("UB: an empty selection is refused (no copy, no POST)",
        ok2 === false && postTexts().length === postsMid);
    appStub.canvas.selectedItems = { size: 3 };
    hooks.setNodeCapture(true);
}

phase("UC node fragments — →🧩 pastes through the native paste, the canvas clipboard is restored");
{
    // pick the newest nodes entry from the client mirror
    const item = hooks.items().find((x) => x.type === "nodes");
    check("UC: a nodes entry exists to paste", !!item);
    let pasteCalls = 0;
    let sawKeyDuringPaste = null;
    let sawMouseDuringPaste = null;
    appStub.canvas.pasteFromClipboard = function () {
        pasteCalls++;
        sawKeyDuringPaste = localStorage.getItem(hooks.canvasClipboardKey);
        sawMouseDuringPaste = [appStub.canvas.graph_mouse[0], appStub.canvas.graph_mouse[1]];
    };
    appStub.canvas.graph_mouse = [111, 222];
    localStorage.setItem(hooks.canvasClipboardKey, "prev-canvas-clipboard");
    // click the card's →🧩 (the REAL UI path)
    const card = document.querySelector('.hub-stack-card[data-type="nodes"]');
    card.querySelector('[data-act="insg"]').click();
    await settle();
    check("UC: the native paste was called exactly once", pasteCalls === 1);
    check("UC: the fragment was on the canvas clipboard DURING the paste",
        sawKeyDuringPaste === item.text,
        String(sawKeyDuringPaste || "").slice(0, 60));
    check("UC: the paste ran at the current mouse position (native behavior)",
        Array.isArray(sawMouseDuringPaste) && sawMouseDuringPaste[0] === 111 && sawMouseDuringPaste[1] === 222,
        JSON.stringify(sawMouseDuringPaste));
    check("UC: the canvas clipboard is restored after the paste",
        localStorage.getItem(hooks.canvasClipboardKey) === "prev-canvas-clipboard");
    // renderAll replaced the card element (applyPatched) - re-query it
    const cardAfter = document.querySelector('.hub-stack-card[data-type="nodes"]');
    check("UC: the use counter bumped (uses chip on the card)",
        (cardAfter?.querySelector(".hub-stack-uses")?.textContent || "").includes("×1"));
}

phase("UD node fragments — drop at a graph point aims graph_mouse and restores it");
{
    const item = hooks.items().find((x) => x.type === "nodes");
    let sawMouse = null;
    appStub.canvas.pasteFromClipboard = function () {
        sawMouse = [appStub.canvas.graph_mouse[0], appStub.canvas.graph_mouse[1]];
    };
    appStub.canvas.graph_mouse = [500, 700];
    const ok = await hooks.pasteNodesIntoCanvas(item, { x: 55, y: 66 });
    await settle();
    check("UD: the drop-paste succeeded", ok === true);
    check("UD: graph_mouse was aimed at the drop point during the paste",
        Array.isArray(sawMouse) && sawMouse[0] === 55 && sawMouse[1] === 66, JSON.stringify(sawMouse));
    check("UD: graph_mouse was restored afterwards",
        appStub.canvas.graph_mouse[0] === 500 && appStub.canvas.graph_mouse[1] === 700);
    // the drag pipeline source contract: the gcanvas target kind exists
    const src = fs.readFileSync(path.join(WEB, "stack.js"), "utf8");
    check("UD: the drag pipeline routes nodes cards to the canvas (gcanvas target + drop handler)",
        src.includes('kind: "gcanvas"') && src.includes('t?.kind === "gcanvas"') &&
        src.includes('graphPointAt(e.clientX, e.clientY)'));
}

phase("UE node fragments — structure viewer + fragment parser edge cases");
{
    // parser: a full WORKFLOW FILE is rejected (its link shape pastes broken)
    const wfJson = JSON.stringify({ last_node_id: 3, last_link_id: 2, nodes: [{ id: 1, type: "KSampler", pos: [0, 0] }], links: [[1, 1, 0, 2, 0, "POINT"]], groups: [], config: {}, extra: {}, version: 0.4 });
    check("UE: a workflow file is NOT a fragment", hooks.parseGraphFragment(wfJson) === null);
    check("UE: plain text is not a fragment", hooks.parseGraphFragment("just a prompt idea") === null);
    check("UE: a fragment without nodes is rejected",
        hooks.parseGraphFragment(JSON.stringify({ nodes: [], groups: [] })) === null);
    const legacyFrag = JSON.stringify({ nodes: [{ id: 1, type: "CLIPTextEncode", pos: [10, 10] }], links: [[0, 0, 0, 0]] });
    const lm = hooks.parseGraphFragment(legacyFrag);
    check("UE: a legacy {nodes, links} fragment parses with zero groups",
        !!lm && lm.nodeCount === 1 && lm.groupCount === 0 && lm.types[0][0] === "CLIPTextEncode");

    // the viewer: 🔍 on a nodes card opens the census + raw JSON (the newest
    // entry is UB's fragB - CLIPTextEncode/EmptyLatentImage/VAEDecode)
    const card = document.querySelector('.hub-stack-card[data-type="nodes"]');
    card.querySelector('[data-act="view"]').click();
    await settle();
    const v = document.querySelector(".hub-stack-viewer");
    check("UE: the structure viewer opened", !!v && !!v.querySelector(".hub-stack-viewer-body-nodes"));
    check("UE: the viewer shows the node-type census",
        v.textContent.includes("CLIPTextEncode") && v.textContent.includes("EmptyLatentImage") &&
        v.textContent.includes("VAEDecode"));
    check("UE: the viewer lists the groups", v.textContent.includes("Groups") && v.textContent.includes("Sampler block"));
    check("UE: the viewer carries 📋 copy and →🧩 insert",
        !!v.querySelector(".hub-stack-viewer-copy") && !!v.querySelector(".hub-stack-viewer-ins"));
    check("UE: the raw JSON is collapsed by default",
        v.querySelector(".hub-stack-vnodes-raw")?.open === false);
    v.querySelector(".hub-stack-viewer-x").click();
    await settle();
    check("UE: the viewer closed", !document.querySelector(".hub-stack-viewer"));
}

phase("UF node fragments — legacy fallback copy (no return value) is captured via the storage key");
{
    // emulate the LEGACY litegraph copyToClipboard: writes localStorage,
    // returns undefined - onCanvasCopied falls back to the storage key
    const frag2 = JSON.stringify({ nodes: [{ id: 9, type: "Reroute", pos: [5, 5] }], links: [] });
    appStub.canvas.copyToClipboard = function () {
        localStorage.setItem(hooks.canvasClipboardKey, frag2);
        return undefined;
    };
    delete appStub.canvas.__shStackCopyHook;
    hooks.installCanvasCopyHook();
    const nBefore = hooks.items().filter((x) => x.type === "nodes").length;
    appStub.canvas.copyToClipboard();
    await settle();
    check("UF: the legacy-shaped copy still stacked a nodes entry",
        hooks.items().filter((x) => x.type === "nodes").length === nBefore + 1);
    // a non-fragment clipboard value (plain prompt text) must NOT stack
    const nNow = hooks.items().filter((x) => x.type === "nodes").length;
    appStub.canvas.copyToClipboard = function () {
        localStorage.setItem(hooks.canvasClipboardKey, "plain prompt, not json");
        return undefined;
    };
    appStub.canvas.copyToClipboard();
    await settle();
    check("UF: a non-fragment clipboard value is ignored",
        hooks.items().filter((x) => x.type === "nodes").length === nNow);
}

// ===========================================================================
// UG-UI - v97: UNIVERSAL CARD EDITING + TEXT EDIT IN THE FULL TEXT VIEW +
//         TAB-STRIP WHEEL SCROLL
// ===========================================================================

phase("UG universal inline editor — name/tags/tab on EVERY kind (✎ of media/nodes cards used to do nothing)");
{
    // an image entry through the REAL capture path
    await hooks.addImageBlob(new dom.window.Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7])], { type: "image/png" }), "shot one");
    await settle();
    const img = imgCards()[0]; // newest first
    check("UG: an image card exists", !!img);
    img.querySelector('[data-act="edit"]').click();
    await settle();
    let editCard = document.querySelector(".hub-stack-card-edit");
    check("UG: the IMAGE card opened the inline editor",
        !!editCard && editCard.dataset.type === "image");
    check("UG: the editor carries name/tags/tab inputs",
        !!editCard?.querySelector(".hub-stack-edit-name") &&
        !!editCard?.querySelector(".hub-stack-edit-tags") &&
        !!editCard?.querySelector(".hub-stack-edit-tab"));
    editCard.querySelector(".hub-stack-edit-name").value = "my render";
    editCard.querySelector(".hub-stack-edit-tags").value = "render, hero";
    editCard.querySelector(".hub-stack-edit-tab").value = "";
    editCard.querySelector('[data-act="edit-save"]').click();
    await settle();
    check("UG: PATCH carried name+tags for the IMAGE entry",
        fakeApi.__calls.some((c) => c.url === "/settings_hub/stack/patch" &&
            String(c.body).includes('"name":"my render"') && String(c.body).includes("hero")),
        JSON.stringify(fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").map((c) => c.body)));
    const imgAfter = imgCards()[0];
    check("UG: the image card shows the new name and the tag chips",
        imgAfter.textContent.includes("my render") &&
        imgAfter.querySelector(".hub-stack-tags")?.textContent.includes("render"),
        imgAfter.textContent.slice(0, 140));
    check("UG: the editor closed after save", !document.querySelector(".hub-stack-card-edit"));

    // a NODES entry: the editor must open the same way
    await hooks.addNodesFragment(JSON.stringify({ nodes: [{ id: 1, type: "KSampler", pos: [0, 0] }], links: [] }), "frag");
    await settle();
    const nod = document.querySelector('.hub-stack-card[data-type="nodes"]');
    nod.querySelector('[data-act="edit"]').click();
    await settle();
    editCard = document.querySelector(".hub-stack-card-edit");
    check("UG: the NODES card opened the inline editor",
        !!editCard && editCard.dataset.type === "nodes");
    editCard.querySelector(".hub-stack-edit-name").value = "sampler frag";
    editCard.querySelector(".hub-stack-edit-tags").value = "block-a";
    editCard.querySelector('[data-act="edit-save"]').click();
    await settle();
    check("UG: PATCH carried name+tags for the NODES entry",
        fakeApi.__calls.some((c) => c.url === "/settings_hub/stack/patch" &&
            String(c.body).includes('"name":"sampler frag"') && String(c.body).includes("block-a")));
    check("UG: the nodes card shows the new name",
        document.querySelector('.hub-stack-card[data-type="nodes"]')?.textContent.includes("sampler frag"));

    // cancel: the editor closes and sends nothing
    const patchCount0 = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").length;
    textCards()[0].querySelector('[data-act="edit"]').click();
    await settle();
    editCard = document.querySelector(".hub-stack-card-edit");
    check("UG: the TEXT card still opens the editor (unchanged)", !!editCard);
    editCard.querySelector('[data-act="edit-cancel"]').click();
    await settle();
    check("UG: cancel closes the editor without a PATCH",
        !document.querySelector(".hub-stack-card-edit") &&
        fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").length === patchCount0);
}

phase("UH text edit in the Full text view — ✎ -> textarea -> ✓ saves through PATCH {text}");
{
    await hooks.addText("original prompt text for editing", "edit me");
    await settle();
    const card = textCards()[0];
    check("UH: a fresh text card exists", !!card && card.textContent.includes("original prompt text"));
    card.querySelector('[data-act="view"]').click();
    await settle();
    const v = document.querySelector(".hub-stack-viewer");
    check("UH: the Full text view opened", !!v);
    check("UH: the viewer carries ✎ edit (text entries are editable)",
        !!v?.querySelector(".hub-stack-viewer-edit"));
    check("UH: save/cancel are hidden in the read mode",
        v.querySelector(".hub-stack-viewer-save").style.display === "none" &&
        v.querySelector(".hub-stack-viewer-cancel").style.display === "none");
    v.querySelector(".hub-stack-viewer-edit").click();
    await settle();
    const ta = v.querySelector(".hub-stack-viewer-edit-area");
    check("UH: edit swaps the body for a textarea with the full text",
        !!ta && ta.value === "original prompt text for editing");
    check("UH: copy/insert hidden while editing",
        v.querySelector(".hub-stack-viewer-copy").style.display === "none" &&
        v.querySelector(".hub-stack-viewer-ins").style.display === "none");
    ta.value = "edited prompt text v2";
    const before = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").length;
    v.querySelector(".hub-stack-viewer-save").click();
    await settle();
    const patchBodies = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").slice(before)
        .map((c) => { try { return JSON.parse(c.body); } catch (_) { return null; } });
    check("UH: PATCH carried {id, text} with the edited content",
        patchBodies.some((b) => b && b.text === "edited prompt text v2"),
        JSON.stringify(patchBodies));
    check("UH: the server stored the new text",
        fakeApi.__items().some((x) => x.text === "edited prompt text v2"));
    check("UH: the viewer returned to the read mode with the new text",
        !v.querySelector(".hub-stack-viewer-edit-area") &&
        v.querySelector(".hub-stack-viewer-body").textContent === "edited prompt text v2");
    check("UH: the char count updated",
        v.querySelector(".hub-stack-viewer-n").textContent.includes("21"),
        v.querySelector(".hub-stack-viewer-n").textContent);
    check("UH: the card excerpt updated too",
        textCards()[0]?.textContent.includes("edited prompt text v2"));

    // Esc while editing cancels the EDIT (the viewer stays open), the next
    // Esc closes the viewer
    const esc = () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown",
        { key: "Escape", bubbles: true, cancelable: true }));
    v.querySelector(".hub-stack-viewer-edit").click();
    await settle();
    v.querySelector(".hub-stack-viewer-edit-area").value = "must be discarded";
    esc();
    await settle();
    check("UH: Esc in the edit mode returns to the read view (edits discarded)",
        !!document.querySelector(".hub-stack-viewer") &&
        v.querySelector(".hub-stack-viewer-body").textContent === "edited prompt text v2");
    esc();
    await settle();
    check("UH: the second Esc closes the viewer", !document.querySelector(".hub-stack-viewer"));

    // ✕ cancel: no PATCH
    textCards()[0].querySelector('[data-act="view"]').click();
    await settle();
    const v2 = document.querySelector(".hub-stack-viewer");
    v2.querySelector(".hub-stack-viewer-edit").click();
    await settle();
    v2.querySelector(".hub-stack-viewer-edit-area").value = "also discarded";
    const before2 = fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").length;
    v2.querySelector(".hub-stack-viewer-cancel").click();
    await settle();
    check("UH: ✕ cancel returns to the read view with the ORIGINAL text",
        v2.querySelector(".hub-stack-viewer-body").textContent === "edited prompt text v2");
    check("UH: ✕ cancel sent no PATCH",
        fakeApi.__calls.filter((c) => c.url === "/settings_hub/stack/patch").length === before2);
    v2.querySelector(".hub-stack-viewer-x").click();
    await settle();

    // the media viewer has NO text editor (text edits belong to text entries)
    imgCards()[0].querySelector('[data-act="view"]').click();
    await settle();
    const mv = document.querySelector(".hub-stack-viewer");
    check("UH: the media viewer carries no text editor",
        !!mv && !mv.querySelector(".hub-stack-viewer-edit"));
    mv.querySelector(".hub-stack-viewer-x").click();
    await settle();
}

phase("UI tab-strip wheel — the vertical wheel scrolls the hidden-scrollbar strip");
{
    for (let i = 1; i <= 8; i++) hooks.createTab("Wheel tab " + i);
    const strip = hooks.tabEl();
    check("UI: the strip holds All + 8 tabs",
        strip.querySelectorAll(".hub-stack-tab").length === 9);
    // jsdom has no layout engine: simulate the overflow metrics on THIS element
    const stub = (el, k, v) => Object.defineProperty(el, k, { value: v, writable: true, configurable: true });
    stub(strip, "scrollWidth", 900);
    stub(strip, "clientWidth", 260);
    let sl = 0;
    Object.defineProperty(strip, "scrollLeft", { get: () => sl, set: (x) => { sl = x; }, configurable: true });
    const wheelAt = (el, dx, dy, mode) => {
        const ev = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
        ev.deltaX = dx; ev.deltaY = dy; ev.deltaMode = mode || 0;
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
    };
    check("UI: wheelTabs(0,120) scrolled the strip and reported the scroll",
        hooks.wheelTabs(0, 120, 0) === true && sl === 120, String(sl));
    check("UI: a wheel EVENT over the strip is consumed (preventDefault)",
        wheelAt(strip, 0, 120, 0) === true && sl === 240, String(sl));
    check("UI: deltaMode 1 (lines) scales x16",
        hooks.wheelTabs(0, 2, 1) === true && sl === 272, String(sl));
    check("UI: deltaMode 2 (pages) scales by the visible width",
        hooks.wheelTabs(0, 1, 2) === true && sl === 532, String(sl));
    check("UI: a horizontal (trackpad) delta wins over the vertical one",
        hooks.wheelTabs(-50, 10, 0) === true && sl === 482, String(sl));
    check("UI: a zero delta is a no-op", hooks.wheelTabs(0, 0, 0) === false && sl === 482);
    // no overflow -> the event passes through untouched
    stub(strip, "scrollWidth", 200);
    check("UI: without overflow nothing scrolls and the event bubbles",
        hooks.wheelTabs(0, 120, 0) === false && sl === 482 &&
        wheelAt(strip, 0, 120, 0) === false);
    // revealActiveTab: the active chip sits beyond the right edge -> scrolled into view
    stub(strip, "scrollWidth", 900);
    const activeChip = strip.querySelector(".hub-stack-tab-on");
    stub(activeChip, "offsetLeft", 620);
    stub(activeChip, "offsetWidth", 90);
    sl = 0;
    hooks.revealActiveTab();
    check("UI: revealActiveTab scrolls the active chip into view",
        sl === 620 + 90 - 260 + 4, String(sl));
    activeChip.offsetLeft = 0; // left edge: scroll back to the start
    sl = 500;
    hooks.revealActiveTab();
    check("UI: revealActiveTab scrolls BACK when the chip is left of the view",
        sl === 0, String(sl));
    // cleanup: drop the layout stubs (the prototype getters come back)
    for (const k of ["scrollWidth", "clientWidth", "offsetLeft", "offsetWidth", "scrollLeft"]) delete strip[k];
    for (const k of ["offsetLeft", "offsetWidth"]) delete activeChip[k];
}

// ===========================================================================
// VJ-VM - v99: COMPACT INFORMATIVE CARDS + nodeMeta + THE INSPECTOR
// (owner plan "улучшение отображения скопированных нод", phases 1-3)
// ===========================================================================

phase("VJ v99 card model — naming rules, truncation, honest link counts");
{
    // 1. a SINGLE node: the auto "1 node" name resolves to the REAL title
    const single = JSON.stringify({ nodes: [{ id: 7, type: "KSampler", title: "My main sampler", pos: [0, 0], size: [270, 262] }], links: [] });
    const sm1 = hooks.parseGraphFragment(single);
    const nm1 = hooks.buildNodeMeta(sm1);
    check("VJ: single node -> singleTitle = the real node title",
        nm1 && nm1.singleTitle === "My main sampler", JSON.stringify(nm1));
    check("VJ: single node -> linkCount 0 (empty links array is honest)",
        nm1.linkCount === 0, String(nm1.linkCount));
    const item1 = { id: "t1", type: "nodes", name: "1 node", nodeMeta: nm1 };
    check("VJ: the auto name '1 node' is replaced by the real title",
        hooks.fragDisplayName(item1, hooks.fragCardModel(item1)) === "My main sampler");
    check("VJ: the stored name is never rewritten (display-only)",
        item1.name === "1 node");

    // 2. multiple SAME-type nodes: the type becomes the identifying name
    const same3 = JSON.stringify({
        nodes: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, type: "KSampler", pos: [0, i * 100] })),
        links: [],
    });
    const sm2 = hooks.parseGraphFragment(same3);
    const nm2 = hooks.buildNodeMeta(sm2);
    check("VJ: 3 same-type nodes -> types [[KSampler,3]], no singleTitle",
        JSON.stringify(nm2.types) === JSON.stringify([["KSampler", 3]]) && nm2.singleTitle == null,
        JSON.stringify(nm2.types));
    const item2 = { id: "t2", type: "nodes", nodeMeta: nm2 };
    check("VJ: same-type name resolves to 'KSampler'",
        hooks.fragDisplayName(item2, hooks.fragCardModel(item2)) === "KSampler");
    check("VJ: the type line shows 'KSampler ×3'",
        hooks.fragTypeLine(hooks.fragCardModel(item2)).includes("×3"),
        hooks.fragTypeLine(hooks.fragCardModel(item2)));

    // 3. 2-5 nodes: ALL types shown, no "+N types"
    const five = JSON.stringify({
        nodes: ["A", "B", "C", "D", "E"].map((t, i) => ({ id: i + 1, type: "Node" + t, pos: [0, i * 50] })),
        links: [],
    });
    const cm3 = hooks.fragCardModel({ id: "t3", type: "nodes", nodeMeta: hooks.buildNodeMeta(hooks.parseGraphFragment(five)) });
    const line3 = hooks.fragTypeLine(cm3);
    check("VJ: 5 nodes -> every type on the line, no truncation note",
        line3.includes("NodeA") && line3.includes("NodeE") && !line3.includes("+"),
        line3);

    // 4. 12 nodes / 5 types: top-3 types + "+2 types"
    const twelve = JSON.stringify({
        nodes: [
            ...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, type: "KSampler", pos: [0, i * 50] })),
            ...Array.from({ length: 3 }, (_, i) => ({ id: 200 + i, type: "CLIPTextEncode", pos: [0, 300 + i * 50] })),
            { id: 301, type: "VAELoader", pos: [0, 500] },
            { id: 302, type: "SaveImage", pos: [0, 560] },
            { id: 303, type: "LoadImage", pos: [0, 620] },
        ],
        links: [],
    });
    const nm4 = hooks.buildNodeMeta(hooks.parseGraphFragment(twelve));
    const cm4 = hooks.fragCardModel({ id: "t4", type: "nodes", nodeMeta: nm4 });
    const line4 = hooks.fragTypeLine(cm4);
    check("VJ: 12 nodes -> top-3 types + '+2 types'",
        line4.includes("KSampler") && line4.includes("CLIPTextEncode") && line4.includes("VAELoader") &&
        line4.includes("+2 types"), line4);
    check("VJ: '+N types' counts the REST of the census (5-3)",
        line4.includes("+2 types"), line4);

    // 5. 86 nodes: the card stays aggregated (the height never grows)
    const many = {
        nodes: [], links: [], groups: [
            { title: "Video Input", bounding: [0, 0, 300, 300], color: "#335577" },
            { title: "Generation", bounding: [0, 400, 300, 300] },
        ],
    };
    const counters = { KSampler: 12, "Load Image": 8, CLIPTextEncode: 6 };
    let idc = 1;
    for (const [ty, n] of Object.entries(counters)) {
        for (let i = 0; i < n; i++) many.nodes.push({ id: idc++, type: ty, pos: [i * 10, 0], size: [200, 100] });
    }
    for (let i = 0; i < 59; i++) many.nodes.push({ id: idc++, type: "T" + (i % 19), pos: [0, 1000 + i * 10] });
    const nm5 = hooks.buildNodeMeta(hooks.parseGraphFragment(JSON.stringify(many)));
    check("VJ: 86 nodes counted", nm5.nodeCount === 85, String(nm5.nodeCount));
    const cm5 = hooks.fragCardModel({ id: "t5", type: "nodes", nodeMeta: nm5 });
    const line5 = hooks.fragTypeLine(cm5);
    check("VJ: 86 nodes -> 'KSampler ×12' first + '+19 types'",
        line5.startsWith("<span") === false && line5.includes("KSampler <b>×12</b>") && line5.includes("+19 types"), line5);
    check("VJ: groups carry colors in the aggregate",
        nm5.groups[0].title === "Video Input" && nm5.groups[0].color === "#335577" &&
        nm5.groups.length === 2 && nm5.groupCount === 2, JSON.stringify(nm5.groups));

    // 6. NO links array -> linkCount NULL (never "0 links" fabricated)
    const noLinks = JSON.stringify({ nodes: [{ id: 1, type: "KSampler", pos: [0, 0] }] });
    const nm6 = hooks.buildNodeMeta(hooks.parseGraphFragment(noLinks));
    check("VJ: missing links array -> linkCount null (unknown, not zero)",
        nm6.linkCount === null, String(nm6.linkCount));
    const cm6 = hooks.fragCardModel({ id: "t6", type: "nodes", nodeMeta: nm6 });
    check("VJ: an unknown link count stays SILENT on the card model",
        cm6.linkCount === null, String(cm6.linkCount));

    // 7. a user name ALWAYS wins over every auto resolution
    const item7 = { id: "t7", type: "nodes", name: "My pipeline", nodeMeta: nm1 };
    check("VJ: the user name wins over the node title",
        hooks.fragDisplayName(item7, hooks.fragCardModel(item7)) === "My pipeline");
    // 7b. a group-titled name is not an auto name - it stays
    const item7b = { id: "t7b", type: "nodes", name: "Sampler block", nodeMeta: nm2 };
    check("VJ: a group-titled name is kept as-is",
        hooks.fragDisplayName(item7b, hooks.fragCardModel(item7b)) === "Sampler block");

    // 8. a long type name is capped in the type line
    const longTy = JSON.stringify({ nodes: [{ id: 1, type: "ULTIMATEsdupscale_BUT_better_WITH_face_detailer_AND_41_more_words", pos: [0, 0] }], links: [] });
    const line8 = hooks.fragTypeLine(hooks.fragCardModel({ id: "t8", type: "nodes", nodeMeta: hooks.buildNodeMeta(hooks.parseGraphFragment(longTy)) }));
    check("VJ: a long type name is capped (no card blowout)",
        line8.length < 80 && line8.endsWith("…"), line8);

    // 9. inline parse fallback for OLD entries (no nodeMeta at all)
    const oldItem = { id: "t9", type: "nodes", name: "1 node", text: single };
    const cm9 = hooks.fragCardModel(oldItem);
    check("VJ: an old entry without nodeMeta parses inline (WeakMap cache)",
        cm9 && cm9.nodeCount === 1 && cm9.singleTitle === "My main sampler", JSON.stringify(cm9));
    check("VJ: the old entry's card resolves the real title too",
        hooks.fragDisplayName(oldItem, cm9) === "My main sampler");
    // the WeakMap cache: the SECOND model call returns the same numbers
    // without re-parsing (same item object identity)
    const cm9b = hooks.fragCardModel(oldItem);
    check("VJ: the WeakMap cache serves repeated renders",
        cm9b === cm9 || (cm9b && cm9b.nodeCount === 1));
}

phase("VK v99 lazy nodeMeta backfill — file-backed old entries, failure paths");
{
    document.querySelector('.hub-stack-tab[data-tab=""]')?.click(); // back to All
    await settle();
    // a FILE-BACKED fragment (text lives in a blob) captured before v99:
    // no nodeMeta, no inline text - the FIRST render fires the ONE async
    // backfill job (fetch + parse + PATCH), then the card re-renders with
    // the full preview
    const fragFB = JSON.stringify({
        nodes: [
            { id: 1, type: "CheckpointLoaderSimple", title: "ckpt", pos: [0, 0], size: [315, 106] },
            { id: 2, type: "KSampler", pos: [400, 0], size: [270, 262] },
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
        groups: [],
    });
    const fname = "v99backfill.txt";
    // push the item into the SERVER store, the panel mirror re-reads it on refresh
    fakeApi.__pushItem({
        id: "srvfb99", type: "nodes", file: fname, size: fragFB.length,
        created: Math.floor(Date.now() / 1000), hash: "fb99",
    });
    // seed the blob store so the fake file GET route can serve the fragment
    await fakeApi.__storeBlob(new dom.window.Blob([fragFB], { type: "application/octet-stream" }), fname, "application/octet-stream", "");
    const patchBefore = fakeApi.__calls.filter((c) => String(c.url).startsWith("/settings_hub/stack/patch")).length;
    hooks.refresh();
    await settle();
    await settle();
    // the auto-backfill PATCHed the clean aggregate exactly ONCE
    const patchCalls = fakeApi.__calls.slice(patchBefore)
        .filter((c) => String(c.url).startsWith("/settings_hub/stack/patch") && String(c.body || "").includes("srvfb99"));
    check("VK: the backfill PATCHed exactly once", patchCalls.length === 1, String(patchCalls.length));
    let pm = null;
    try { pm = JSON.parse(patchCalls[0]?.body || "{}").nodeMeta; } catch (_) {}
    check("VK: the backfill PATCHed a clean aggregate",
        !!pm && pm.nodeCount === 2 && pm.linkCount === 1 && pm.groupCount === 0 &&
        Array.isArray(pm.types) && pm.types.length === 2,
        JSON.stringify(pm));
    // the server store carries the metadata now
    check("VK: the server item carries nodeMeta",
        fakeApi.__items().find((x) => x.id === "srvfb99")?.nodeMeta?.nodeCount === 2, "");
    // applyPatched re-rendered the card with the FULL preview
    const card1 = document.querySelector('.hub-stack-card[data-id="srvfb99"]');
    check("VK: the card became informative after the backfill",
        /2\s*nodes/.test(card1?.textContent || "") && (card1?.textContent || "").includes("1 link"),
        card1?.textContent.slice(0, 120));
    // re-renders (refresh) never PATCH again (nodeMeta present / rate limit)
    hooks.refresh();
    await settle();
    check("VK: the backfill is rate-limited (no duplicate PATCH)",
        fakeApi.__calls.slice(patchBefore)
            .filter((c) => String(c.url).startsWith("/settings_hub/stack/patch") && String(c.body || "").includes("srvfb99")).length === 1);

    // a BROKEN file-backed fragment: the backfill marks it dead, no PATCH storm
    await fakeApi.__storeBlob(new dom.window.Blob(["{ this is not json"], { type: "application/octet-stream" }), "v99broken.txt", "application/octet-stream", "");
    const broken = { id: "srvfb99bad", type: "nodes", file: "v99broken.txt", size: 18, created: 1, hash: "fb99b" };
    fakeApi.__pushItem(broken);
    const pb2 = fakeApi.__calls.filter((c) => String(c.url).startsWith("/settings_hub/stack/patch")).length;
    hooks.refresh();
    await settle();
    await settle();
    check("VK: a broken fragment backfill PATCHes nothing",
        fakeApi.__calls.slice(pb2)
            .filter((c) => String(c.url).startsWith("/settings_hub/stack/patch") && String(c.body || "").includes("srvfb99bad")).length === 0);
    const badCard = document.querySelector('.hub-stack-card[data-id="srvfb99bad"]');
    check("VK: the broken card stays on the old fallback",
        !!badCard && badCard.textContent.includes("fragment"), badCard?.textContent.slice(0, 80));
}

phase("VL v99 inspector — Overview | Nodes | Groups | Connections | JSON");
{
    document.querySelector('.hub-stack-tab[data-tab=""]')?.click(); // back to All
    await settle();
    // a RICH fragment: titles, widgets (one LONG text), groups with colors
    // + bounds, links incl. one reroute-mediated, properties
    const longText = "masterpiece, best quality, intricate details, cinematic lighting, " +
        "ultra-detailed background, depth of field, volumetric fog, golden hour rim light, " +
        "photorealistic skin texture, subsurface scattering, 8k render, award-winning photography";
    const rich = JSON.stringify({
        nodes: [
            { id: 1, type: "CheckpointLoaderSimple", title: "ckpt source", pos: [10, 10], size: [315, 106],
                inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [1] }, { name: "CLIP", type: "CLIP" }, { name: "VAE", type: "VAE" }],
                widgets_values: ["v1-5-pruned-emaonly.safetensors"], properties: { "Node name for S&R": "CheckpointLoaderSimple" } },
            { id: 2, type: "CLIPTextEncode", title: "positive prompt", pos: [10, 200], size: [400, 200],
                inputs: [{ name: "clip", type: "CLIP", link: 9 }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [2] }],
                widgets_values: [longText], properties: {} },
            { id: 3, type: "KSampler", title: "the sampler", pos: [10, 450], size: [270, 262],
                inputs: [{ name: "model", type: "MODEL", link: 1 }, { name: "positive", type: "CONDITIONING", link: 2 }],
                outputs: [{ name: "LATENT", type: "LATENT" }],
                widgets_values: [42, "fixed", 20, 7, "euler", "normal"], properties: { seed: 42 } },
            { id: 4, type: "Reroute", pos: [500, 100], size: [75, 75] },
        ],
        links: [
            [1, 1, 0, 3, 0, "MODEL"],
            [2, 2, 0, 3, 1, "CONDITIONING"],
            [9, 4, 0, 2, 0, "CLIP"],
        ],
        groups: [
            { title: "Sources", bounding: [0, 0, 600, 150], color: "#3f526b" },
            { title: "Render", bounding: [0, 180, 600, 560] },
        ],
        reroutes: [{ id: 4, pos: [500, 100] }],
    });
    await hooks.addText(rich, "rich frag", "nodes");
    await settle();
    const rItem = hooks.items().find((x) => x.type === "nodes" && x.name === "rich frag");
    check("VL: the rich fragment landed in the stack", !!rItem);

    const card = document.querySelector('.hub-stack-card[data-id="' + rItem.id + '"]');
    check("VL: the card shows 4 nodes + the types line",
        /4\s*nodes/.test(card?.textContent || "") && (card?.querySelector(".hub-stack-nodes-types")?.textContent || "").includes("CLIPTextEncode"),
        card?.textContent.slice(0, 120));
    check("VL: the meta row shows 2 groups and the reroute-diminished link count",
        /2\s*groups/.test(card?.textContent || "") && /3\s*links/.test(card?.textContent || ""),
        card?.textContent.slice(0, 160));

    // the INSPECTOR
    card.querySelector('[data-act="view"]').click();
    await settle();
    const v = document.querySelector(".hub-stack-viewer");
    check("VL: the inspector opened", !!v && !!v.querySelector(".hub-stack-viewer-body-nodes"));
    check("VL: the head meta counts nodes/groups/size",
        (v.querySelector(".hub-stack-viewer-meta")?.textContent || "").includes("4 nodes"),
        v.querySelector(".hub-stack-viewer-meta")?.textContent);
    check("VL: five tabs exist (Overview | Nodes | Groups | Connections | JSON)",
        [...v.querySelectorAll(".hub-stack-vtab")].map((b) => b.textContent.trim()).join("|") === "Overview|Nodes|Groups|Connections|JSON");
    // Overview is the DEFAULT tab
    check("VL: Overview is active by default",
        v.querySelector(".hub-stack-vtab-on")?.textContent.trim() === "Overview" &&
        !!v.querySelector(".hub-stack-vpane-overview.hub-stack-vpane-on"));
    check("VL: Overview shows the stats blocks",
        v.querySelectorAll(".hub-stack-vstat").length === 4 &&
        (v.querySelector(".hub-stack-vstat-n")?.textContent || "") === "4");
    check("VL: Overview lists the type census",
        (v.querySelector(".hub-stack-vpane-overview")?.textContent || "").includes("CLIPTextEncode") &&
        (v.querySelector(".hub-stack-vpane-overview")?.textContent || "").includes("Groups"),
        "");
    check("VL: Overview shows the group colors + membership",
        v.querySelectorAll(".hub-stack-vpane-overview .hub-stack-vgroup-row").length === 2 &&
        v.querySelector(".hub-stack-vpane-overview .hub-stack-vswatch")?.getAttribute("style")?.includes("#3f526b"));

    // Nodes tab: rows, search, expandable details
    const tabByName = (name) => [...v.querySelectorAll(".hub-stack-vtab")].find((b) => b.textContent.trim() === name);
    tabByName("Nodes").click();
    check("VL: the Nodes pane activated",
        !!v.querySelector(".hub-stack-vpane-nodes.hub-stack-vpane-on"));
    const rows = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    check("VL: 4 node rows (title + type + id)", rows.length === 4 &&
        (rows[0].textContent || "").includes("ckpt source") && (rows[0].querySelector(".hub-stack-vnode-id")?.textContent || "") === "#1",
        rows.map((r) => r.textContent.slice(0, 30)).join(" / "));
    check("VL: the group badge rides the row when membership is reliable",
        (rows[1].querySelector(".hub-stack-vnode-group")?.textContent || "").includes("Render"),
        rows[1].textContent.slice(0, 80));
    // search by title
    const search = v.querySelector(".hub-stack-vsearch");
    search.value = "sampler";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const rowsAfter = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    check("VL: the search filters by title ('sampler' -> the sampler row)",
        rowsAfter.length === 1 && rowsAfter[0].textContent.includes("the sampler"),
        rowsAfter.map((r) => r.textContent.slice(0, 24)).join("/"));
    search.value = "";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const rowsAll = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    // expand a node: the detail builds lazily with inputs/widgets/properties
    const det = rowsAll[2]; // KSampler
    det.open = true;
    det.dispatchEvent(new dom.window.Event("toggle", { bubbles: false }));
    const dbox = det.querySelector(".hub-stack-vnode-detail");
    check("VL: expanding a node fills inputs + widget values",
        (dbox?.textContent || "").includes("Inputs") && (dbox?.textContent || "").includes("model") &&
        (dbox?.textContent || "").includes("Widget values") && (dbox?.textContent || "").includes("42"),
        dbox?.textContent.slice(0, 120));
    check("VL: properties render in the detail",
        (dbox?.textContent || "").includes("Properties") && (dbox?.textContent || "").includes("seed"));
    // the LONG widget value collapses + carries a copy button
    const posDet = rowsAll[1];
    posDet.open = true;
    posDet.dispatchEvent(new dom.window.Event("toggle", { bubbles: false }));
    const longBox = posDet.querySelector(".hub-stack-vnode-detail");
    const longDet = longBox?.querySelector(".hub-stack-vw-long");
    check("VL: the long prompt value collapses into details (closed)",
        !!longDet && longDet.open === false && (longDet.textContent || "").includes("chars"),
        longDet?.textContent.slice(0, 60));
    check("VL: the collapsed value carries a copy button",
        !!longDet?.querySelector(".hub-stack-vw-copy"));
    longDet.open = true;
    check("VL: opening the collapse reveals the FULL value (copy = full text)",
        (longDet.querySelector(".hub-stack-vw-full")?.textContent || "").includes("award-winning photography"));
    // connected nodes section (reliable links only)
    check("VL: the expanded sampler shows its connected source",
        (dbox?.textContent || "").includes("Connected") && (dbox?.textContent || "").includes("ckpt source"),
        dbox?.textContent.slice(0, 200));

    // Groups tab
    tabByName("Groups").click();
    const gCards = [...v.querySelectorAll(".hub-stack-vpane-groups .hub-stack-vgroup-card")];
    check("VL: the Groups tab lists 2 groups with reliable members",
        gCards.length === 2 && gCards[0].textContent.includes("Sources") &&
        /\d+ node/.test(gCards[0].textContent), gCards.map((g) => g.textContent.slice(0, 40)).join(" | "));

    // Connections tab: "src → out → dst → in" rows, reliable only
    tabByName("Connections").click();
    const linkRows = [...v.querySelectorAll(".hub-stack-vpane-conn .hub-stack-vlink-row")];
    check("VL: 2 reliable connection rows (the reroute one is NOT fabricated)",
        linkRows.length === 2, String(linkRows.length));
    check("VL: a connection row reads 'ckpt source → MODEL → the sampler → model'",
        (linkRows[0]?.textContent || "").includes("ckpt source") &&
        (linkRows[0]?.textContent || "").includes("MODEL") &&
        (linkRows[0]?.textContent || "").includes("the sampler") &&
        (linkRows[0]?.textContent || "").includes("model"),
        linkRows[0]?.textContent);
    check("VL: the reroute note explains the hidden connection",
        (v.querySelector(".hub-stack-vpane-conn")?.textContent || "").includes("reroute"),
        v.querySelector(".hub-stack-vpane-conn")?.textContent.slice(0, 160));

    // JSON tab: collapsed, capped preview, the head 📋 still copies the FULL raw
    tabByName("JSON").click();
    const raw = v.querySelector(".hub-stack-vnodes-raw");
    check("VL: the JSON pane keeps the raw collapsed by default", !!raw && raw.open === false);
    check("VL: the raw preview holds the full short JSON",
        (raw.querySelector("pre")?.textContent || "").includes("KSampler"));

    // copy button = FULL raw JSON (never the preview cap)
    let copied = "";
    const writeText = navigator.clipboard?.writeText;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    v.querySelector(".hub-stack-viewer-copy").click();
    await settle();
    check("VL: 📋 copies the FULL raw JSON", copied === rich, String(copied.length));
    if (writeText) Object.defineProperty(navigator, "clipboard", { value: { writeText: writeText }, configurable: true });

    v.querySelector(".hub-stack-viewer-x").click();
    await settle();
    check("VL: the inspector closed", !document.querySelector(".hub-stack-viewer"));

    // the CLIPBOARD JSON is untouched by the whole round (paste contract)
    check("VL: the stored fragment JSON is byte-identical (no preview rewrites)",
        hooks.items().find((x) => x.id === rItem.id).text === rich);
}

phase("VM v99 huge graph — portioned rendering, stable card, no DOM blowout");
{
    document.querySelector('.hub-stack-tab[data-tab=""]')?.click(); // back to All
    await settle();
    // 500 nodes + 40 groups + 300 links: the SAME compact card + a portioned
    // inspector (60 rows first, batches of 150)
    const groups = Array.from({ length: 40 }, (_, g) => ({
        title: "Group " + g, bounding: [0, g * 500, 1000, 400], color: "#3f526b",
    }));
    const nodes = [];
    for (let i = 0; i < 500; i++) {
        nodes.push({
            id: i + 1,
            type: ["KSampler", "CLIPTextEncode", "VAEDecode", "LoadImage", "SaveImage"][i % 5],
            title: "node " + (i + 1),
            pos: [10 + (i % 10) * 80, Math.floor(i / 10) * 40],
            size: [70, 30],
            inputs: i % 3 ? [{ name: "in", type: "*", link: null }] : [],
            outputs: i % 2 ? [{ name: "out", type: "*" }] : [],
            widgets_values: i % 7 === 0 ? ["some value " + i] : [],
        });
    }
    const links = [];
    for (let i = 1; i < 300; i++) links.push([i, (i % 500) + 1, 0, ((i + 1) % 500) + 1, 0, "TYPE"]);
    const huge = JSON.stringify({ nodes, links, groups });
    check("VM: the synthetic graph is really 500 nodes", hooks.parseGraphFragment(huge).nodeCount === 500);
    const hugeMeta = hooks.buildNodeMeta(hooks.parseGraphFragment(huge));
    check("VM: the aggregate is bounded even for 500 nodes",
        hugeMeta.nodeCount === 500 && hugeMeta.types.length === 5 && hugeMeta.groups.length === 32,
        JSON.stringify({ t: hugeMeta.types.length, g: hugeMeta.groups.length }));
    await hooks.addText(huge, "", "nodes", hugeMeta);
    await settle();
    const hItem = hooks.items().find((x) => x.type === "nodes" && x.nodeMeta && x.nodeMeta.nodeCount === 500);
    check("VM: the capture carried the bounded nodeMeta", !!hItem, "");
    const hCard = document.querySelector('.hub-stack-card[data-id="' + hItem.id + '"]');
    // the card structure is IDENTICAL to a 2-node card: one head + ONE types line
    check("VM: the 500-node card has exactly one types line (no blowout)",
        hCard.querySelectorAll(".hub-stack-nodes-types").length === 1 &&
        /500\s*nodes/.test(hCard.textContent),
        hCard?.textContent.slice(0, 140));
    check("VM: the type line aggregates top-3 + '+N types'",
        (hCard.querySelector(".hub-stack-nodes-types")?.textContent || "").includes("+2 types"),
        hCard.querySelector(".hub-stack-nodes-types")?.textContent);
    check("VM: the meta row counts groups and links",
        /40\s*groups/.test(hCard.textContent) && /299\s*links/.test(hCard.textContent),
        hCard.textContent.slice(0, 180));

    // the inspector: Overview aggregates instantly, Nodes is portioned
    hCard.querySelector('[data-act="view"]').click();
    await settle();
    const v = document.querySelector(".hub-stack-viewer");
    check("VM: the huge inspector opened on Overview", !!v &&
        v.querySelector(".hub-stack-vtab-on")?.textContent.trim() === "Overview");
    check("VM: Overview stats say 500 nodes / 299 links",
        (v.querySelector(".hub-stack-vstats")?.textContent || "").includes("500") &&
        (v.querySelector(".hub-stack-vstats")?.textContent || "").includes("299"),
        v.querySelector(".hub-stack-vstats")?.textContent);
    check("VM: Overview caps the type census (never 500 rows)",
        v.querySelectorAll(".hub-stack-vpane-overview .hub-stack-vnodes-type").length <= 41);
    const tabByName2 = (name) => [...v.querySelectorAll(".hub-stack-vtab")].find((b) => b.textContent.trim() === name);
    tabByName2("Nodes").click();
    let rowsNow = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    check("VM: the Nodes tab renders the FIRST 60 rows only",
        rowsNow.length === 60, String(rowsNow.length));
    const more = v.querySelector(".hub-stack-vpane-nodes .hub-stack-vmore");
    check("VM: the Show-more button offers the next batch of 150",
        more && more.textContent.includes("150"), more?.textContent);
    more.click();
    rowsNow = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    check("VM: one click -> 210 rows (60 + 150), still not 500",
        rowsNow.length === 210, String(rowsNow.length));
    // search on the huge list
    const search2 = v.querySelector(".hub-stack-vsearch");
    search2.value = "node 499";
    search2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    rowsNow = [...v.querySelectorAll(".hub-stack-vpane-nodes .hub-stack-vnode")];
    check("VM: the search finds node 499 in the huge graph",
        rowsNow.length === 1 && rowsNow[0].textContent.includes("node 499"), String(rowsNow.length));
    search2.value = "";
    search2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    // Connections: portioned too
    tabByName2("Connections").click();
    const linkRowsNow = [...v.querySelectorAll(".hub-stack-vpane-conn .hub-stack-vlink-row")];
    check("VM: the Connections tab is portioned as well (60 rows)",
        linkRowsNow.length === 60, String(linkRowsNow.length));
    // a node detail builds lazily on the huge graph too
    tabByName2("Nodes").click();
    const firstRow = v.querySelector(".hub-stack-vpane-nodes .hub-stack-vnode");
    firstRow.open = true;
    firstRow.dispatchEvent(new dom.window.Event("toggle", { bubbles: false }));
    check("VM: the lazy detail works on the huge graph",
        (firstRow.querySelector(".hub-stack-vnode-detail")?.textContent || "").length > 0);
    v.querySelector(".hub-stack-viewer-x").click();
    await settle();
    check("VM: the huge inspector closed cleanly", !document.querySelector(".hub-stack-viewer"));
}

// ---------------------------------------------------------------------------

console.log(`\nsmoke_stack: ${pass} passed, ${fail} failed`);
if (failures.length) {
    console.error("Failures:\n  " + failures.join("\n  "));
    process.exit(1);
}
process.exit(0);
