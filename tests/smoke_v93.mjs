// ============================================================================
// tests/smoke_v93.mjs - v93 regression suite
// ----------------------------------------------------------------------------
// Covers the owner requests that shipped in v93 (1 feature + 4 fixes):
//   PA  build/manifest: the entry reports v93 and the EXPECTED manifest
//       matches the submodules' self-reports;
//   PB  ONE-SHOT mode (owner: "инференс одним сообщением"): the 💬/⚡ switch,
//       the runs view replaces the chat view (tabs hidden, 📎 hidden, the
//       placeholder changes), the server runs log loads into cards, a run
//       streams through the SAME SSE protocol into the runs list, ⏹ keeps a
//       stopped partial, ⧉ copy, the armed 🗑 clear, the scoped 📜 prompt;
//   PC  the launcher taskbar is draggable from ANYWHERE (a 5px threshold
//       separates a drag from a button click - owner #1);
//   PD  fix source markers: the VRAM checkboxes in the ⚡ GPU popup (owner
//       #2), the hub rename double-tap + the window RMB menu + the core DOM
//       resolver (owner #3), the stack DOM-widget drop target + textarea
//       highlight (owner #4);
//   PE  py chat_proxy: the oneshot_* config keys, _resolve_oneshot_prompt,
//       the /oneshot routes and the payload system_prompt override.
// Run: NODE_PATH=<node_modules with jsdom> node tests/smoke_v93.mjs
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
    console.error("smoke_v93: jsdom is required (NODE_PATH=<node_modules with jsdom>)");
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
// Fake app + an in-memory chat backend with SSE + the one-shot routes
// ---------------------------------------------------------------------------

function makeFakeApi() {
    const calls = [];
    const sessions = new Map();
    const runsLog = [];
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
    // a controllable SSE response: frames are pushed by the test; an abort
    // (the client's ⏹) rejects the pending reads with an AbortError, like a
    // real fetch body reader does
    const sse = {
        controller: null,
        response(signal) {
            const enc = new TextEncoder();
            const self = this;
            return {
                ok: true, status: 200,
                headers: { get: () => "text/event-stream" },
                body: {
                    getReader() {
                        let buf = [];
                        let done = false;
                        let dead = false;
                        let waiter = null;
                        self.controller = {
                            push(frame) { buf.push(enc.encode(frame)); waiter?.(); waiter = null; },
                            end() { done = true; waiter?.(); waiter = null; },
                            kill() {
                                dead = true; waiter?.(); waiter = null;
                                try { signal?.removeEventListener?.("abort", onAbort); } catch (_) {}
                            },
                        };
                        const onAbort = () => self.controller?.kill?.();
                        try { signal?.addEventListener?.("abort", onAbort); } catch (_) {}
                        return {
                            read: () => new Promise((res, rej) => {
                                if (dead) {
                                    const e = new Error("The user aborted a request.");
                                    e.name = "AbortError";
                                    return rej(e);
                                }
                                if (buf.length) return res({ done: false, value: buf.shift() });
                                if (done) return res({ done: true, value: undefined });
                                waiter = () => {
                                    if (dead) {
                                        const e = new Error("The user aborted a request.");
                                        e.name = "AbortError";
                                        return rej(e);
                                    }
                                    res(buf.length ? { done: false, value: buf.shift() } : { done: true, value: undefined });
                                };
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
        __runs: runsLog,
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
                return jres({ ok: true, has_ffmpeg: true, configured: true, writable: true, version: "v94" });
            }
            if (p === "/settings_hub/chat/config") {
                if (method === "POST") return jres({ ok: true, config: body || {} });
                return jres({ ok: true, config: {
                    url: "http://127.0.0.1:8080/v1", model: "m", stream: true,
                    prompt_preset: "", system_prompt: "",
                    oneshot_preset: "", oneshot_system: "", oneshot_keep: 30,
                } });
            }
            if (p === "/settings_hub/chat/models") return jres({ ok: true, models: [{ id: "m", status: "loaded" }], source: "openai" });
            if (p === "/settings_hub/chat/prompts") return jres({ ok: true, files: [], dir: "/x/prompts" });
            if (p === "/settings_hub/chat/gpu") return jres({ ok: true, action: body?.action || "?" });
            // v93 one-shot routes
            if (p === "/settings_hub/chat/oneshot/runs") {
                return jres({ ok: true, runs: runsLog.slice() });
            }
            if (p === "/settings_hub/chat/oneshot/clear") {
                runsLog.length = 0;
                return jres({ ok: true });
            }
            if (p === "/settings_hub/chat/oneshot" && method === "POST") {
                if (!body?.text) return jres({ ok: false, error: "empty message" }, 400);
                if (body.stream) {
                    sse.__sendBody = body;
                    return sse.response(opts.signal);
                }
                const rec = { id: "os" + (++seq), ts: Math.floor(Date.now() / 1000),
                    model: "m", prompt: "preset: a.txt", text: "one-shot answer",
                    ms: 12, usage: { completion_tokens: 3 } };
                runsLog.unshift(rec);
                return jres({ ok: true, reply: { ...rec, ctx: { used: 10, total: 0, est: true } } });
            }
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
                return jres({ ok: true, session: getSession(body.session), reply: { text: "x" } });
            }
            return jres({ ok: false, error: "unmocked " + p }, 404);
        },
        apiURL: (p) => p,
    };
    return api;
}

function makeSandbox() {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubv93-"));
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
globalThis.__SettingsHubBuild = "v95";

const sb = makeSandbox();
const core = await import(sb.core);
const launcher = await import(sb.launcher);
const chat = await import(sb.chat);
const hooks = chat.__chatTestHooks();

// ---------------------------------------------------------------------------
phase("PA build v95 + version manifest");
{
    // v95: this round touched ONLY styles.css - the other modules keep
    // their self-reports (the manifest follows the truth)
    check("PA the entry reports v95", globalThis.__SettingsHubBuild === "v95");
    check("PA chat self-reports v98 (the v98 chat tab-strip wheel round)", globalThis.__SettingsHubLoaded?.chat === "v98");
    check("PA launcher self-reports v93 (unchanged)", globalThis.__SettingsHubLoaded?.launcher === "v93");
    check("PA core self-reports v93 (unchanged)", globalThis.__SettingsHubLoaded?.core === "v93");
    // the modules the boot does not import are checked in their sources
    // (the same approach smoke_v92 takes)
    const s93src = fs.readFileSync(sb.stack, "utf8");
    const m93src = fs.readFileSync(sb.menu, "utf8");
    const r93src = fs.readFileSync(sb.renderer, "utf8");
    check("PA stack self-reports v100 (the v100 connections-fix round changed it)", s93src.includes('__SettingsHubLoaded["stack"] = "v100"'));
    check("PA context_menu self-reports v93 (unchanged)", m93src.includes('__SettingsHubLoaded["context_menu"] = "v93"'));
    check("PA hub_ui_renderer self-reports v94", r93src.includes('__SettingsHubLoaded["hub_ui_renderer"] = "v94"'));
}

// ---------------------------------------------------------------------------
phase("PB one-shot mode (owner: инференс одним сообщением)");
{
    chat.initChat();
    await settle();
    hooks.setCfg({
        url: "http://127.0.0.1:8080/v1", model: "m", stream: true,
        oneshot_preset: "prompts/a.txt", oneshot_system: "",
    });
    hooks.setServerState({ configured: true });
    await settle(4);

    const tabsRow = document.querySelector(".hub-chat-tabs");
    check("PB the 💬/⚡ mode switch exists on the tabs row",
        !!tabsRow?.querySelector(".hub-chat-mode[data-mode='chat']") &&
        !!tabsRow?.querySelector(".hub-chat-mode[data-mode='oneshot']"));
    check("PB the chat mode is ON by default",
        tabsRow?.querySelector(".hub-chat-mode[data-mode='chat']")?.classList.contains("hub-chat-mode-on") === true);
    check("PB the runs view is hidden in chat mode",
        hooks.runsEl()?.style.display === "none" && hooks.msgsEl()?.style.display !== "none");

    hooks.setMode("oneshot");
    await settle(8);   // the runs fetch is async
    check("PB setMode('oneshot') sticks", hooks.mode() === "oneshot");
    check("PB the ⚡ segment is highlighted",
        tabsRow?.querySelector(".hub-chat-mode[data-mode='oneshot']")?.classList.contains("hub-chat-mode-on") === true);
    check("PB the runs view is visible, the chat list is hidden",
        hooks.runsEl()?.style.display !== "none" && hooks.msgsEl()?.style.display === "none");
    check("PB the runs bar is visible with the armed clear button",
        hooks.runsBarEl()?.style.display !== "none" &&
        !!hooks.runsBarEl()?.querySelector(".hub-chat-runs-clear"));
    check("PB no tab chips in one-shot mode",
        tabsRow?.querySelectorAll(".hub-chat-tab").length === 0 &&
        !tabsRow?.querySelector(".hub-chat-tab-add"));
    const input = hooks.inputEl();
    check("PB the placeholder became a prompt", /Prompt…/.test(input?.placeholder || ""));
    check("PB the 📎 attach button is hidden in one-shot",
        document.querySelector(".hub-chat-attachbtn")?.style.display === "none");
    check("PB the runs log was fetched",
        appStub.api.__calls().some((c) => c.url === "/settings_hub/chat/oneshot/runs"));

    // a seed run (in the SERVER log) renders as a card with ⧉ copy
    appStub.api.__runs.unshift({
        id: "seed1", ts: Math.floor(Date.now() / 1000), model: "m",
        prompt: "preset: a.txt", text: "the seed answer", ms: 20, usage: {},
    });
    await hooks.loadRuns();
    await settle(2);
    const card = hooks.runsEl()?.querySelector(".hub-chat-run[data-run='seed1']");
    check("PB a run renders as a card with the id hook", !!card);
    check("PB the card carries ⧉ copy",
        !!card?.querySelector(".hub-chat-run-copy"));
    check("PB the card body renders the answer",
        card?.querySelector(".hub-chat-run-body")?.textContent.includes("the seed answer") === true);

    // the status line names the one-shot prompt (the ⚡ scoped 📜 segment)
    hooks.renderStatus();
    const st = hooks.statusEl()?.textContent || "";
    check("PB the status 📜⚡ segment names the one-shot preset",
        st.includes("a.txt"), st);

    // a streaming RUN: the live bubble paints into the runs list
    input.value = "make it so";
    const runP = hooks.sendRun();
    await settle(4);
    const sse = appStub.api.__sse;
    check("PB the run POSTed to /chat/oneshot",
        appStub.api.__calls().some((c) => c.url === "/settings_hub/chat/oneshot" && c.body?.text === "make it so"));
    check("PB the run opened a stream", !!sse.controller);
    sse.controller.push('data: {"note": "auto-free: nothing to free"}\n\n');
    sse.controller.push('data: {"delta": "Answer "}\n\n');
    sse.controller.push('data: {"delta": "part one.\\n\\npart two"}\n\n');
    await sleep(140);
    const live = hooks.runsEl()?.querySelector(".hub-chat-msg-streaming");
    check("PB the live bubble lives in the RUNS list", !!live);
    check("PB the live bubble is incremental (stable + tail)",
        !!live?.querySelector(":scope > .hub-chat-msg-body > .hub-chat-stable") &&
        !!live?.querySelector(":scope > .hub-chat-msg-body > .hub-chat-tail"));
    check("PB the SSE note surfaced on the live meta",
        live?.querySelector(".hub-chat-msg-meta")?.textContent.includes("nothing to free") === true);
    sse.controller.push('data: {"done": true, "reply": {"id": "os1", "text": "Answer part one.\\n\\npart two", "model": "m", "ms": 42, "usage": {"completion_tokens": 5}}}\n\n');
    sse.controller.end();
    await runP;
    await settle(6);
    check("PB the stream is over", hooks.streaming() === null);
    const doneCard = hooks.runsEl()?.querySelector(".hub-chat-run[data-run='os1']");
    check("PB the finished run became a card", !!doneCard);
    check("PB the input was cleared", input.value === "");

    // ⏹ keeps a stopped partial
    input.value = "long run";
    const runP2 = hooks.sendRun();
    await settle(4);
    appStub.api.__sse.controller.push('data: {"delta": "partial answ"}\n\n');
    await sleep(140);
    hooks.stopStream();
    try { await runP2; } catch (_) {}
    await settle(6);
    const stoppedCard = [...(hooks.runsEl()?.querySelectorAll(".hub-chat-run") || [])]
        .find((c) => c.querySelector(".hub-chat-run-meta")?.textContent.includes("stopped"));
    check("PB the stopped run keeps the partial as a stopped card",
        !!stoppedCard && stoppedCard.querySelector(".hub-chat-run-body")?.textContent.includes("partial answ"),
        stoppedCard?.querySelector(".hub-chat-run-body")?.textContent);

    // the armed 🗑 clears the log
    const clr = hooks.runsBarEl()?.querySelector(".hub-chat-runs-clear");
    clr.click();
    await tick();
    check("PB the first 🗑 click only ARMS", hooks.runsList().length > 0 &&
        clr.textContent === "❗", clr.textContent);
    clr.click();
    await settle(4);
    check("PB the second 🗑 click clears the log",
        appStub.api.__calls().some((c) => c.url === "/settings_hub/chat/oneshot/clear") &&
        hooks.runsList().length === 0 && !!hooks.runsEl()?.querySelector(".hub-chat-runs-empty"));

    // back to chat mode: the views swap back
    hooks.setMode("chat");
    await settle(4);
    check("PB back to chat: the chat list is visible, runs hidden",
        hooks.mode() === "chat" && hooks.msgsEl()?.style.display !== "none" &&
        hooks.runsEl()?.style.display === "none");
    // the mode persisted to localStorage
    check("PB the mode persisted",
        (globalThis.localStorage.getItem("settingshub.chat.ui") || "").includes("oneshot") === false ||
        JSON.parse(globalThis.localStorage.getItem("settingshub.chat.ui") || "{}").mode === "chat");
}

// ---------------------------------------------------------------------------
phase("PC launcher drag from anywhere (owner #1)");
{
    launcher.initLauncher();
    await settle();
    const bar = document.querySelector(".hub-lnch");
    check("PC the bar exists", !!bar);
    bar.style.left = "100px"; bar.style.top = "100px";
    const btn = bar.querySelector('[data-lnch="hub"]');
    let hubClicks = 0;
    // the hub button's own click handler would create a node - count instead
    btn.replaceWith(btn.cloneNode(true));
    const btn2 = bar.querySelector('[data-lnch="hub"]');
    btn2.addEventListener("click", () => { hubClicks++; });

    const fire = (type, x, y, target) => {
        const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperty(ev, "target", { value: target });
        (target || bar).dispatchEvent(ev);
    };
    // a DRAG from the button surface: mousedown + 30px move + mouseup
    fire("mousedown", 100, 100, btn2);
    window.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 130, clientY: 115 }));
    window.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, clientX: 130, clientY: 115 }));
    await tick();
    check("PC a drag moved the bar",
        bar.style.left !== "100px" || bar.style.top !== "100px",
        bar.style.left + " / " + bar.style.top);
    check("PC a dragged release is NOT a click (the button did not fire)", hubClicks === 0);

    // a plain CLICK (mousedown + mouseup within 5px) still clicks the button
    const lx = parseFloat(bar.style.left), ly = parseFloat(bar.style.top);
    fire("mousedown", lx + 10, ly + 10, btn2);
    fire("mouseup", lx + 11, ly + 11, btn2);
    btn2.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
    check("PC a non-drag release still clicks the button", hubClicks === 1);

    // the position persisted
    const ui = JSON.parse(globalThis.localStorage.getItem("settingshub.launcher.ui") || "{}");
    check("PC the drag position persisted", typeof ui.x === "number", JSON.stringify(ui));
}

// ---------------------------------------------------------------------------
phase("PD fix source markers (owner #2, #3, #4)");
{
    const csrc = fs.readFileSync(sb.chat, "utf8");
    const ssrc = fs.readFileSync(sb.stack, "utf8");
    const rsrc = fs.readFileSync(sb.renderer, "utf8");
    const msrc = fs.readFileSync(sb.menu, "utf8");
    const co = fs.readFileSync(sb.core, "utf8");
    const lsrc = fs.readFileSync(sb.launcher, "utf8");

    // #2: the VRAM checkboxes MOVED to the GPU popup
    check("PD the ⚙ popup carries NO VRAM checkboxes anymore",
        !csrc.includes('data-cs="freec"') && !csrc.includes('data-cs="unq"'));
    check("PD the ⚡ GPU popup carries both VRAM checkboxes",
        csrc.includes('data-gpu="freec"') && csrc.includes('data-gpu="unq"'));
    check("PD the GPU popup patches auto_free_comfy + auto_unload_llm_on_queue",
        csrc.includes("{ auto_free_comfy: vFreeChk.checked }") &&
        csrc.includes("{ auto_unload_llm_on_queue: vUnqChk.checked }"));

    // #3: the hub rename + the window RMB menu
    check("PD the floating title rename is a manual double-tap (the drag pointerdown kills dblclick)",
        rsrc.includes("pointerdown") && rsrc.includes("(now - lastTap) < 450"));
    check("PD the double-tap opens the shared hubRenameFlow",
        /isDouble[\s\S]{0,700}hubRenameFlow\(node\)/.test(rsrc));
    check("PD the floating window has its own contextmenu (no browser menu)",
        msrc.includes("function attachHubWindowMenu") &&
        msrc.includes('.hub-pin-panel') && msrc.includes("resolveHubNodeFromDom(t)"));
    check("PD the window menu carries Rename + Materialize/Dematerialize",
        msrc.includes("Materialize - back to a canvas node") &&
        msrc.includes("Dematerialize - turn into a floating window"));
    check("PD core.js has the DOM resolver registry",
        co.includes("registerHubDomResolver") && co.includes("resolveHubNodeFromDom"));
    check("PD the renderer registers the resolver + the materialize action",
        rsrc.includes('registerHubAction("materialize"') &&
        rsrc.includes("registerHubDomResolver"));

    // #4: the DOM-widget drop target under the cursor
    check("PD the stack resolves a DOM widget input under the cursor",
        ssrc.includes("function domWidgetOwnerAt") &&
        ssrc.includes("domWidgetOwnerAt(el)"));
    check("PD the resolved textarea target highlights the field itself",
        ssrc.includes('wkind: "text", el: own.el') &&
        ssrc.includes('target.el.classList.add("hub-stack-drop-hot-text")'));
    check("PD the cleanup drops the textarea highlight (3 places)",
        (ssrc.match(/hub-stack-drop-hot-text"\)/g) || []).length >= 5);
    check("PD textWidgetAt gained the widget-DOM-rect layer",
        ssrc.includes("the widget's own DOM element rect under the cursor"));
    // the chat checkboxes marker of v92 is now the GPU popup's
    check("PD the ⚡ checkbox wiring stays through applyChatSettings",
        csrc.includes("applyChatSettings({ auto_free_comfy"));

    // #1: the launcher drag threshold
    check("PD the launcher drag uses a 5px threshold + click suppression",
        lsrc.includes("moved = true") && lsrc.includes("suppressClick"));
}

// ---------------------------------------------------------------------------
phase("PE py chat_proxy: the one-shot backend");
{
    const psrc = fs.readFileSync(path.join(ROOT, "py", "chat_proxy.py"), "utf8");
    check("PE the oneshot_* keys exist in DEFAULT_CONFIG",
        psrc.includes('"oneshot_preset"') && psrc.includes('"oneshot_system"') &&
        psrc.includes('"oneshot_keep": 30'));
    check("PE /chat/config accepts the oneshot keys",
        psrc.includes('cfg["oneshot_preset"]') && psrc.includes('cfg["oneshot_system"]'));
    check("PE _resolve_oneshot_prompt mirrors the PolyStrata semantics",
        psrc.includes("def _resolve_oneshot_prompt") &&
        /def _resolve_oneshot_prompt[\s\S]{0,700}oneshot_preset[\s\S]{0,400}oneshot_system/.test(psrc));
    check("PE the routes exist: /oneshot + /runs + /clear",
        psrc.includes('"/settings_hub/chat/oneshot"') &&
        psrc.includes('"/settings_hub/chat/oneshot/runs"') &&
        psrc.includes('"/settings_hub/chat/oneshot/clear"'));
    check("PE the payload override: build_upstream_payload(system_prompt=...)",
        psrc.includes("def build_upstream_payload(session_msgs, cfg, sid, stream=False, model=\"\",\n                           system_prompt=None)") &&
        psrc.includes("model=model, system_prompt=sp)"));
    check("PE the runs log is flat + capped (oneshot_runs.json)",
        psrc.includes("oneshot_runs.json") && psrc.includes("_record_oneshot_run") &&
        psrc.includes("oneshot_keep"));
    check("PE the one-shot send runs the same VRAM prep (_pre_send_prep)",
        /async def chat_oneshot[\s\S]{0,4000}_pre_send_prep\(cfg, model\)/.test(psrc));
    check("PE the chat stamp is v93", psrc.includes('CHAT_SERVER_VERSION = "v93"'));
}

// ---------------------------------------------------------------------------
console.log(`\nsmoke_v93: ${PASS} passed, ${FAIL} failed`);
if (FAIL) {
    for (const f of FAILURES) console.log("  FAIL: " + f);
    process.exit(1);
}
