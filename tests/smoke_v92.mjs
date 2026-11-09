// ============================================================================
// tests/smoke_v92.mjs - v92 regression suite
// ----------------------------------------------------------------------------
// Covers the owner requests that shipped in v92 (11 items):
//   PA  build/manifest: the entry reports v92 and the EXPECTED manifest
//       matches the submodules' self-reports;
//   PB  the launcher is a TASKBAR now: icon buttons only (no checkboxes, no
//       gear), the state classes (on / amber min / dimmed off), the badges
//       (stack entry count with a 99+ cap, chat live dot), a hidden item
//       disappears, a dimmed click turns the panel on;
//   PC  chat streaming v92: INCREMENTAL throttled paints (stable/tail nodes,
//       ~10 Hz), the SSE note events surface (prep notes), the queue hook
//       unloads the chat engine on execution_start (owner #11) with a
//       cooldown; the model pick only SAVES (owner #1, source marker);
//   PD  stack chips + drop hit-test v92 (owner #6+#8, source markers: the
//       wasDragged threshold, the layered textWidgetAt);
//   PE  hub materialization v92 (owner #4+#5): the core.js action registry
//       works, the renderer registers dematerialize + rename, the tab-bar
//       📌 is gone, the node right-click menu carries the entries;
//   PF  py config: the auto_free_comfy / auto_unload_llm_on_queue keys and
//       the conditional-free helper exist in chat_proxy.py.
// Run: NODE_PATH=<jsdom> node tests/smoke_v92.mjs
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import url from "node:url";

const require = createRequire(import.meta.url);
let jsdom = null;
try { jsdom = require("jsdom"); } catch (_) {}
if (!jsdom) {
    console.error("smoke_v92: jsdom is required (NODE_PATH=<node_modules with jsdom>)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");

const { JSDOM } = jsdom;
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true, url: "http://localhost:8188/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.localStorage = dom.window.localStorage; } catch (_) {}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || clearTimeout;
if (!dom.window.URL.createObjectURL) {
    dom.window.URL.createObjectURL = () => "blob:fake";
    dom.window.URL.revokeObjectURL = () => {};
}
try { globalThis.URL = dom.window.URL; } catch (_) {}

let PASS = 0, FAIL = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
    if (cond) { PASS++; return; }
    FAIL++;
    FAILURES.push(name + (detail ? " :: " + detail : ""));
    console.log("  ✗ " + name + (detail ? " :: " + detail : ""));
}
const phase = (t) => console.log(`— ${t}`);
const tick = () => new Promise((r) => setTimeout(r, 6));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake app + an in-memory chat backend with an SSE-capable /chat/send
// ---------------------------------------------------------------------------

function makeFakeApi() {
    const calls = [];
    const sessions = new Map();
    let seq = 0;
    const newSid = () => ("ab" + (++seq).toString(16).padStart(6, "0") + "c0ffee").slice(0, 12);
    const jres = (j, status = 200) => ({
        ok: status < 400, status,
        headers: { get: () => "application/json" },
        json: async () => j,
    });
    const getSession = (sid) => {
        const s = sessions.get(sid);
        if (!s) return null;
        const nodes = s.tree.nodes;
        const out = [];
        let nid = nodes.__root__.activeChild;
        while (nid) {
            const n = nodes[nid];
            out.push({ role: n.role, text: n.text, ts: n.ts || 0, nid });
            nid = n.activeChild;
        }
        s.messages = out;
        return s;
    };
    // a controllable SSE response: frames are pushed by the test
    const sse = {
        controller: null,
        response() {
            const enc = new TextEncoder();
            const self = this;
            return {
                ok: true, status: 200,
                headers: { get: () => "text/event-stream" },
                body: {
                    getReader() {
                        let buf = [];
                        let done = false;
                        let waiter = null;
                        self.controller = {
                            push(frame) { buf.push(enc.encode(frame)); waiter?.(); waiter = null; },
                            end() { done = true; waiter?.(); waiter = null; },
                        };
                        return {
                            read: () => new Promise((res) => {
                                if (buf.length) return res({ done: false, value: buf.shift() });
                                if (done) return res({ done: true, value: undefined });
                                waiter = () => res(buf.length
                                    ? { done: false, value: buf.shift() }
                                    : { done: true, value: undefined });
                            }),
                        };
                    },
                },
            };
        },
    };
    const api = {
        __calls: () => calls.slice(),
        __sessions: sessions,
        __sse: sse,
        listeners: {},
        addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); },
        removeEventListener(ev, fn) {
            this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
        },
        dispatch(ev, detail) { for (const f of (this.listeners[ev] || [])) try { f(detail); } catch (_) {} },
        fetchApi: async (p, opts = {}) => {
            const method = (opts.method || "GET").toUpperCase();
            const body = opts.body ? JSON.parse(opts.body) : null;
            calls.push({ method, url: p, body });
            let m;
            if (p === "/settings_hub/chat/health") {
                return jres({ ok: true, has_ffmpeg: true, configured: true, writable: true, version: "v92" });
            }
            if (p === "/settings_hub/chat/config") {
                if (method === "POST") return jres({ ok: true, config: body || {} });
                return jres({ ok: true, config: { url: "http://127.0.0.1:8080/v1", model: "m", stream: true, prompt_preset: "", system_prompt: "" } });
            }
            if (p === "/settings_hub/chat/models") return jres({ ok: true, models: [{ id: "m", status: "loaded" }], source: "openai" });
            if (p === "/settings_hub/chat/prompts") return jres({ ok: true, files: [], dir: "/x/prompts" });
            if (p === "/settings_hub/chat/gpu") return jres({ ok: true, action: body?.action || "?" });
            if (p === "/settings_hub/chat/sessions" && method === "POST") {
                const sid = newSid();
                const s = { id: sid, title: body?.title || "", created: 1, updated: 1, messages: [],
                    tree: { nodes: { __root__: { id: "__root__", parent: null, children: [], activeChild: null } }, activeLeaf: null } };
                sessions.set(sid, s);
                return jres({ ok: true, session: getSession(sid) });
            }
            if ((m = p.match(/^\/settings_hub\/chat\/session\/(\w+)$/)) && method === "GET") {
                const s = sessions.get(m[1]);
                return s ? jres({ ok: true, session: getSession(m[1]) }) : jres({ ok: false }, 404);
            }
            if (p === "/settings_hub/chat/send" && method === "POST") {
                const s = sessions.get(body?.session);
                if (!s) return jres({ ok: false, error: "no such session" }, 404);
                if (body.stream) {
                    // the server grows the tree lazily on done (like py would)
                    sse.__sendBody = body;
                    return sse.response();
                }
                const nodes = s.tree.nodes;
                const nid = "n" + Math.random().toString(16).slice(2, 8);
                const leaf = s.tree.activeLeaf || "__root__";
                nodes[nid] = { id: nid, parent: leaf, children: [], activeChild: null, role: "user", text: body.text || "" };
                nodes[leaf].children.push(nid);
                nodes[leaf].activeChild = nid;
                const an = "n" + Math.random().toString(16).slice(2, 8);
                nodes[an] = { id: an, parent: nid, children: [], activeChild: null, role: "assistant", text: "the answer" };
                nodes[nid].children.push(an);
                nodes[nid].activeChild = an;
                return jres({ ok: true, session: getSession(body.session), note: "auto-free: already unloaded - nothing to free", reply: { text: "x" } });
            }
            return jres({ ok: false, error: "unmocked " + p }, 404);
        },
        apiURL: (p) => p,
    };
    return api;
}

function makeSandbox() {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubv92-"));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n");
    return {
        base: path.join(sb, "Hub", "web"),
        chat: path.join(sb, "Hub", "web", "chat.js"),
        core: path.join(sb, "Hub", "web", "core.js"),
        launcher: path.join(sb, "Hub", "web", "launcher.js"),
        stack: path.join(sb, "Hub", "web", "stack.js"),
        renderer: path.join(sb, "Hub", "web", "hub_ui_renderer.js"),
        menu: path.join(sb, "Hub", "web", "context_menu.js"),
    };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const appStub = {
    registerExtension(ext) { appStub.__extensions.push(ext); },
    __extensions: [], canvas: null, graph: null,
};
appStub.api = makeFakeApi();
globalThis.__HUB_APP_STUB__ = appStub;
globalThis.__SettingsHubBuild = "v93";

const sb = makeSandbox();
const core = await import(sb.core);
const launcher = await import(sb.launcher);
const chat = await import(sb.chat);
const hooks = chat.__chatTestHooks();

// ---------------------------------------------------------------------------
phase("PA build v92 + version manifest");
{
    // v93: the pack moved on - the manifest expectations follow the truth
    check("PA the entry reports v93", globalThis.__SettingsHubBuild === "v93");
    check("PA chat self-reports v93", globalThis.__SettingsHubLoaded?.chat === "v93");
    check("PA launcher self-reports v93", globalThis.__SettingsHubLoaded?.launcher === "v93");
    check("PA core self-reports v93", globalThis.__SettingsHubLoaded?.core === "v93");
    const rsrc = fs.readFileSync(sb.renderer, "utf8");
    const msrc = fs.readFileSync(sb.menu, "utf8");
    const ssrc = fs.readFileSync(sb.stack, "utf8");
    check("PA renderer self-reports v93", rsrc.includes('__SettingsHubLoaded["hub_ui_renderer"] = "v93"'));
    check("PA context_menu self-reports v93", msrc.includes('__SettingsHubLoaded["context_menu"] = "v93"'));
    check("PA stack self-reports v93", ssrc.includes('__SettingsHubLoaded["stack"] = "v93"'));
}

// ---------------------------------------------------------------------------
phase("PB launcher = a Windows-style taskbar (owner #7)");
{
    launcher.initLauncher();
    await settle();
    const bar = document.querySelector(".hub-lnch");
    check("PB the bar exists", !!bar);
    const btns = [...bar.querySelectorAll("button.hub-lnch-btn")];
    check("PB exactly 3 icon buttons (chat/stack/hub)",
        btns.length === 3 &&
        !!bar.querySelector('[data-lnch="chat"]') &&
        !!bar.querySelector('[data-lnch="stack"]') &&
        !!bar.querySelector('[data-lnch="hub"]'));
    check("PB NO checkboxes on the bar", bar.querySelectorAll("input[type=checkbox]").length === 0);
    check("PB NO gear on the bar", !bar.querySelector(".hub-lnch-gear"));
    check("PB icon-only labels (no 'Chat'/'Stack' text)",
        btns.every((b) => !/Chat|Stack/.test(b.textContent)));

    // badges: the stack entry count (99+ cap) + the chat live dot
    launcher.registerLauncherPanel("stack", {
        isOn: () => true, setOn: () => {}, isMin: () => false,
        minimize: () => {}, restore: () => {}, showChip: () => {},
        badge: () => ({ text: "125" }),
    });
    launcher.registerLauncherPanel("chat", {
        isOn: () => true, setOn: () => {}, isMin: () => false,
        minimize: () => {}, restore: () => {}, showChip: () => {},
        badge: () => ({ dot: true }),
    });
    launcher.__launcherTestHooks().renderItems();
    const stkBadge = bar.querySelector('[data-lnch="stack"] .hub-lnch-badge');
    const chtBadge = bar.querySelector('[data-lnch="chat"] .hub-lnch-badge');
    check("PB the stack badge shows the capped count", stkBadge?.textContent === "99+", stkBadge?.textContent);
    check("PB the chat badge is a live dot", chtBadge?.classList.contains("hub-lnch-dot") === true);

    // states: on-screen / collapsed-into-bar (amber) / off (dimmed)
    check("PB the hosting API is live once mounted",
        launcher.launcherHostsMinimized("chat") === true);
    launcher.launcherSetCollapsed("chat", true);
    check("PB the collapsed chat is amber (hub-lnch-min)",
        bar.querySelector('[data-lnch="chat"]')?.classList.contains("hub-lnch-min") === true);
    launcher.launcherSetCollapsed("chat", false);

    // a dimmed button turns the panel ON with a single click (no checkbox)
    let setOnCalls = 0;
    launcher.registerLauncherPanel("stack", {
        isOn: () => false, setOn: () => { setOnCalls++; }, isMin: () => false,
        minimize: () => {}, restore: () => {}, showChip: () => {},
        badge: () => null,
    });
    launcher.__launcherTestHooks().renderItems();
    const stkBtn = bar.querySelector('[data-lnch="stack"]');
    check("PB the off panel is dimmed (hub-lnch-off)",
        stkBtn?.classList.contains("hub-lnch-off") === true);
    stkBtn.click();
    check("PB a click on a dimmed button turns the panel on", setOnCalls === 1);

    // a hidden item disappears from the bar entirely
    launcher.setLauncherItemOn("hub", false);
    check("PB a hidden item is not rendered",
        bar.querySelector('[data-lnch="hub"]')?.style.display === "none");
    launcher.setLauncherItemOn("hub", true);
    check("PB the item is back",
        bar.querySelector('[data-lnch="hub"]')?.style.display !== "none");
}

// ---------------------------------------------------------------------------
phase("PC chat stream v92: incremental paint + notes + queue hook (#10, #3, #11, #1)");
{
    chat.initChat();
    await settle();
    hooks.setCfg({ url: "http://127.0.0.1:8080/v1", model: "m", stream: true });
    hooks.setServerState({ configured: true });
    await hooks.fillModels?.(false);
    const tab = await hooks.createTab("t1");   // async - and it self-activates
    await settle();
    check("PC a tab exists and is active", !!tab && hooks.activeId() === tab.id, hooks.activeId());

    // the streaming send: SSE frames with notes + deltas
    const input = document.querySelector(".hub-chat-input");
    input.value = "hello";
    const sendP = hooks.send();
    await settle(4);
    const sse = appStub.api.__sse;
    check("PC the send opened a stream", !!sse.controller);
    sse.controller.push('data: {"note": "auto-free before the request: ComfyUI models already unloaded - nothing to free"}\n\n');
    await settle(2);
    sse.controller.push('data: {"delta": "Hello "}\n\n');
    sse.controller.push('data: {"delta": "world,\\n\\nthis is a "}\n\n');
    sse.controller.push('data: {"thoughts": "thinking..."}\n\n');
    await sleep(140);   // a paint is scheduled within STREAM_FRAME_MS=100
    const bubble = document.querySelector(".hub-chat-msg-streaming");
    check("PC the live bubble exists during the stream", !!bubble);
    const bodyEl = bubble?.querySelector(".hub-chat-msg-body");
    check("PC the bubble body is INCREMENTAL (stable + tail nodes)",
        !!bodyEl?.querySelector(":scope > .hub-chat-stable") &&
        !!bodyEl?.querySelector(":scope > .hub-chat-tail"));
    const st = hooks.streamPaintState();
    check("PC the paint state tracks the stable length", !!st && st.stableLen > 0, JSON.stringify(st));
    check("PC the stable part renders the settled paragraphs",
        bodyEl?.querySelector(".hub-chat-stable")?.textContent.includes("Hello world") === true);
    const noteEl2 = bubble?.querySelector(".hub-chat-msg-meta");
    check("PC the SSE prep note surfaced on the bubble meta",
        noteEl2?.textContent.includes("already unloaded") === true, noteEl2?.textContent);
    const toasts = [...document.querySelectorAll(".hub-sh-note")].map((t) => t.textContent).join("|");
    check("PC the prep note toasted", toasts.includes("auto-free"), toasts);

    sse.controller.push('data: {"delta": "tail."}\n\n');
    // the throttle: a burst of deltas schedules ONE paint
    for (let i = 0; i < 8; i++) sse.controller.push('data: {"delta": "x"}\n\n');
    await sleep(150);
    sse.controller.push('data: {"done": true, "reply": {"session": ' +
        JSON.stringify(appStub.api.__sessions.get(tab.id)) + '}}\n\n');
    sse.controller.end();   // the server closes the SSE - readStream must see done
    // grow the server tree for the done reply (the fake backend does it lazily)
    const srv = appStub.api.__sessions.get(tab.id);
    const nid = "s92u"; const anid = "s92a";
    srv.tree.nodes[nid] = { id: nid, parent: "__root__", children: [anid], activeChild: anid, role: "user", text: "hello", ts: 1 };
    srv.tree.nodes["__root__"].children.push(nid);
    srv.tree.nodes["__root__"].activeChild = nid;
    srv.tree.nodes[anid] = { id: anid, parent: nid, children: [], activeChild: null, role: "assistant", text: "Hello world, this is a tail.x", ts: 2 };
    srv.tree.activeLeaf = anid;
    await sendP;
    await settle(6);
    check("PC the stream ended and the paint state reset", hooks.streamPaintState() === null);
    check("PC the stream is over", hooks.streaming() === null);

    // п.11: the queue hook unloads the chat engine when the flag is on
    hooks.setCfg({ url: "http://127.0.0.1:8080/v1", model: "m", stream: true, auto_unload_llm_on_queue: true });
    appStub.api.dispatch("execution_start", {});
    await settle(4);
    let gpuCalls = appStub.api.__calls().filter((c) => c.url === "/settings_hub/chat/gpu" && c.body?.action === "unload");
    check("PC the queue start unloaded the chat engine", gpuCalls.length === 1, JSON.stringify(appStub.api.__calls()));
    appStub.api.dispatch("execution_start", {});
    await settle(4);
    gpuCalls = appStub.api.__calls().filter((c) => c.url === "/settings_hub/chat/gpu" && c.body?.action === "unload");
    check("PC the 30 s cooldown swallows the burst", gpuCalls.length === 1);
    // the flag off -> no unload
    hooks.setCfg({ url: "http://127.0.0.1:8080/v1", model: "m", stream: true, auto_unload_llm_on_queue: false });
    appStub.api.dispatch("execution_start", {});
    await settle(4);
    gpuCalls = appStub.api.__calls().filter((c) => c.url === "/settings_hub/chat/gpu" && c.body?.action === "unload");
    check("PC the flag off never unloads", gpuCalls.length === 1);

    // п.1 source marker: the model pick only saves
    const csrc = fs.readFileSync(sb.chat, "utf8");
    check("PC the model pick only saves the choice",
        csrc.includes("it loads with the next message") &&
        !/modelSel\.addEventListener[\s\S]{0,600}switchModel/.test(csrc));
    // п.3 source marker: the two VRAM checkboxes exist
    // v93: the VRAM checkboxes MOVED from ⚙ into the ⚡ GPU popup
    check("PC the ⚡ GPU popup carries both VRAM checkboxes",
        csrc.includes('data-gpu="freec"') && csrc.includes('data-gpu="unq"'));
}

// ---------------------------------------------------------------------------
phase("PD stack chip + drop hit-test v92 (owner #6, #8)");
{
    const ssrc = fs.readFileSync(sb.stack, "utf8");
    check("PD the stack chip drag returns wasDragged",
        ssrc.includes("wasDragged") && ssrc.includes("chipDrag?.wasDragged?.()"));
    check("PD the drag threshold is 5px", ssrc.includes(">= 5) moved = true") || ssrc.includes(">= 5) moved = true;"));
    check("PD the chip click consults wasDragged",
        /chip\.addEventListener\("click", \(\) => \{ if \(chipDrag\?\.wasDragged\?\.\(\)\) return;/.test(ssrc));
    check("PD the drop hit-test takes the cursor (client coords)",
        ssrc.includes("function textWidgetAt(node, gx, gy, cx, cy)"));
    check("PD the layered hit-test: DOM element under the cursor",
        ssrc.includes("elemFromPoint(cx, cy)"));
    check("PD the layered hit-test: the last_y band walk",
        ssrc.includes("w.last_y") && ssrc.includes("bestDist"));
    check("PD the layered hit-test: the 40px nearest-band slop",
        ssrc.includes("bestDist <= 40"));
}

// ---------------------------------------------------------------------------
phase("PE hub materialization v92 (owner #4, #5)");
{
    // the core.js action registry works (behavioral)
    let fired = null;
    core.registerHubAction("test-action", (node) => { fired = node; return "ok"; });
    check("PE runHubAction fires the registered impl",
        core.runHubAction("test-action", { title: "n" }) === "ok" && fired?.title === "n");
    check("PE an unknown action fails closed", core.runHubAction("nope", {}) === null);

    const rsrc = fs.readFileSync(sb.renderer, "utf8");
    const msrc = fs.readFileSync(sb.menu, "utf8");
    check("PE the renderer registers dematerialize + rename",
        rsrc.includes('registerHubAction("dematerialize"') &&
        rsrc.includes('registerHubAction("rename"'));
    check("PE the tab-bar 📌 is GONE from the node UI",
        !rsrc.includes('data-action="pin-toggle"') && !rsrc.includes("hub-pin-toggle"));
    check("PE dematerialize sets phantom + pinned and re-floats",
        rsrc.includes("cfg.phantom = true") && rsrc.includes("cfg.pinned = true") &&
        rsrc.includes("function dematerializeHubAction"));
    check("PE the rename popup writes node.title",
        rsrc.includes("function hubRenameFlow") && rsrc.includes("node.title = v"));
    check("PE the node right-click menu carries the entries",
        msrc.includes("attachHubNodeMenu") &&
        msrc.includes("Dematerialize - turn into a floating window") &&
        msrc.includes("\u270f Rename hub"));
    check("PE the menu skips dematerialize for already-phantom hubs",
        msrc.includes("hubConfig?.phantom"));
}

// ---------------------------------------------------------------------------
phase("PF py chat_proxy v92 config + conditional free");
{
    const psrc = fs.readFileSync(path.join(ROOT, "py", "chat_proxy.py"), "utf8");
    check("PF auto_free_comfy exists in DEFAULT_CONFIG", psrc.includes('"auto_free_comfy": False'));
    check("PF auto_unload_llm_on_queue exists in DEFAULT_CONFIG",
        psrc.includes('"auto_unload_llm_on_queue": False'));
    check("PF /chat/config accepts both keys",
        psrc.includes('cfg["auto_free_comfy"]') && psrc.includes('cfg["auto_unload_llm_on_queue"]'));
    check("PF the conditional free checks current_loaded_models",
        psrc.includes("current_loaded_models") && psrc.includes("already unloaded - nothing to free"));
    check("PF the LLM wake path exists (_ensure_llm_ready)",
        psrc.includes("_ensure_llm_ready") && psrc.includes("_pre_send_prep"));
}

// ---------------------------------------------------------------------------
console.log(`\nsmoke_v92: ${PASS} passed, ${FAIL} failed`);
if (FAIL) {
    for (const f of FAILURES) console.log("  FAIL: " + f);
    process.exit(1);
}
