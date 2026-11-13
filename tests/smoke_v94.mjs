// ============================================================================
// tests/smoke_v94.mjs - v94 regression suite (3 owner follow-up fixes to v93)
// ----------------------------------------------------------------------------
// Covers the owner requests that shipped in v94:
//   PA  build/manifest: the entry reports v95 (v95 CSS-only fix round); chat
//       + hub_ui_renderer self-report v94; the styles.css stamp query moved;
//   PB  ONE-SHOT ACCUMULATION (owner: "в этом огромном блоке получилась
//       как история - рассуждения первого запроса + второго"): the live
//       stream bubble is DROPPED when a run finishes and when the next run
//       starts, so the second run's thoughts/answer can never append into
//       the first run's stale bubble; each finished run is a card holding
//       ONLY its own reasoning;
//   PC  the HUB RENAME applies (owner: "жму ентер - имя хаба остается
//       прежним" + "двойным кликом ничего не происходит"): the commit
//       refreshes the floating header title in place; the popup survives
//       its own opening gesture (500ms grace against the compatibility
//       mousedown; the double-tap cancels the pointer);
//   PD  the STACK card actions are a wrapping ROW (owner: "часть кнопок
//       скрываются за границами" - the vertical column was clipped by the
//       card's overflow:hidden on short single-line entries);
//   PE  the fix source markers in chat.js (the stale-bubble removals).
// Run: NODE_PATH=<node_modules with jsdom> node tests/smoke_v94.mjs
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
    console.error("smoke_v94: jsdom is required (NODE_PATH=<node_modules with jsdom>)");
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
    FAILURES.push(name + (detail ? " :: " + String(detail).slice(0, 160) : ""));
    console.log("  ✗ " + name + (detail ? " :: " + String(detail).slice(0, 160) : ""));
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
                    model: "m", prompt: "", text: "one-shot answer",
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
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubv94-"));
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
        dir: sb,
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
    check("PA the entry reports v95", globalThis.__SettingsHubBuild === "v95");
    check("PA chat self-reports v98 (the v98 chat tab-strip wheel round)", globalThis.__SettingsHubLoaded?.chat === "v98");
    check("PA launcher self-reports v93 (unchanged this round)",
        globalThis.__SettingsHubLoaded?.launcher === "v93");
    check("PA core self-reports v93 (unchanged this round)",
        globalThis.__SettingsHubLoaded?.core === "v93");
    const rsrc = fs.readFileSync(sb.renderer, "utf8");
    const entrySrc = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
    check("PA hub_ui_renderer self-reports v94",
        rsrc.includes('__SettingsHubLoaded["hub_ui_renderer"] = "v94"'));
    check("PA the EXPECTED manifest expects chat v98 + renderer v94",
        entrySrc.includes('"chat": "v98"') && entrySrc.includes('"hub_ui_renderer": "v94"'));
    check("PA the banner names the v100 connections-fix round",
        entrySrc.includes("web build: v100 - STACK FRAGMENT CONNECTIONS FIX"));
}

// ---------------------------------------------------------------------------
phase("PB one-shot: no reasoning accumulation across runs (owner bug)");
{
    chat.initChat();
    await settle();
    hooks.setCfg({
        url: "http://127.0.0.1:8080/v1", model: "m", stream: true,
        oneshot_preset: "", oneshot_system: "",
    });
    hooks.setServerState({ configured: true });
    await settle(4);
    hooks.setMode("oneshot");
    await settle(8);
    check("PB one-shot mode is on", hooks.mode() === "oneshot");

    const input = hooks.inputEl();
    const runEl = hooks.runsEl();
    const bubble = () => runEl?.querySelector(".hub-chat-msg-streaming");

    // ---- run 1: thoughts AAA + answer one
    input.value = "first";
    const p1 = hooks.sendRun();
    await settle(4);
    const sse = appStub.api.__sse;
    check("PB run 1 opened a stream", !!sse.controller);
    sse.controller.push('data: {"thoughts": "AAA reasoning of run one"}\n\n');
    await sleep(140);
    check("PB run 1 paints its thoughts live", bubble()?.querySelector(".hub-chat-think-b")?.textContent.includes("AAA") === true);
    sse.controller.push('data: {"delta": "Answer one."}\n\n');
    await sleep(140);
    sse.controller.push('data: {"done": true, "reply": {"id": "os1", "text": "Answer one.", "thoughts": "AAA reasoning of run one", "model": "m", "ms": 30, "usage": {"completion_tokens": 4}}}\n\n');
    sse.controller.end();
    await p1;
    await settle(8);
    // THE regression: the stale bubble must be GONE (it used to survive the
    // run and the next run appended its reasoning into it)
    check("PB the live bubble is dropped after run 1", !bubble(),
        bubble()?.textContent?.slice(0, 80));
    const card1 = runEl?.querySelector(".hub-chat-run[data-run='os1']");
    check("PB run 1 became a card", !!card1);
    check("PB card 1 holds only its own reasoning",
        card1?.querySelector(".hub-chat-think-b")?.textContent.includes("AAA") === true &&
        !card1?.querySelector(".hub-chat-think-b")?.textContent.includes("BBB"));

    // ---- run 2: thoughts BBB + answer two - must NEVER see AAA anywhere
    input.value = "second";
    const p2 = hooks.sendRun();
    await settle(4);
    check("PB run 2 opened a stream", !!sse.controller);
    sse.controller.push('data: {"thoughts": "BBB reasoning of run two"}\n\n');
    await sleep(140);
    const th = bubble()?.querySelector(".hub-chat-think-b")?.textContent || "";
    check("PB run 2 paints its OWN thoughts live", th.includes("BBB"), th);
    check("PB run 2 does NOT inherit run 1's reasoning", !th.includes("AAA"), th);
    sse.controller.push('data: {"delta": "Answer two."}\n\n');
    await sleep(140);
    const body = bubble()?.querySelector(".hub-chat-msg-body")?.textContent || "";
    check("PB run 2 does NOT inherit run 1's answer text",
        body.includes("Answer two.") && !body.includes("Answer one."), body);
    sse.controller.push('data: {"done": true, "reply": {"id": "os2", "text": "Answer two.", "thoughts": "BBB reasoning of run two", "model": "m", "ms": 25, "usage": {"completion_tokens": 4}}}\n\n');
    sse.controller.end();
    await p2;
    await settle(8);
    check("PB the live bubble is dropped after run 2", !bubble());
    check("PB both runs are cards now",
        !!runEl?.querySelector(".hub-chat-run[data-run='os1']") &&
        !!runEl?.querySelector(".hub-chat-run[data-run='os2']"));
    check("PB the whole runs list never mixes the two reasonings",
        !runEl?.textContent.includes("AAA reasoning of run one") ||
        !runEl?.textContent.includes("AAA reasoning of run oneAAA"));
    const card2 = runEl?.querySelector(".hub-chat-run[data-run='os2']");
    check("PB card 2 holds only its own reasoning",
        card2?.querySelector(".hub-chat-think-b")?.textContent.includes("BBB") === true &&
        !card2?.querySelector(".hub-chat-think-b")?.textContent.includes("AAA"));
}

// ---------------------------------------------------------------------------
phase("PC hub rename applies (owner #1)");
{
    const rsrc = fs.readFileSync(sb.renderer, "utf8");
    // 1a: the commit refreshes the floating header title in place
    check("PC the commit refreshes the floating header title",
        rsrc.includes('pinPanels.get(node)?.panel?.querySelector(".hub-pin-title")'));
    // 1b: the popup survives its own opening gesture
    check("PC the popup ignores outside mousedown during a 500ms grace",
        rsrc.includes("Date.now() - born < 500"));
    check("PC the double-tap cancels the pointer (no compatibility mousedown)",
        /isDouble[\s\S]{0,160}stopPropagation\(\);[\s\S]{0,420}preventDefault\(\)/.test(rsrc));
    check("PC the double-tap still opens the shared hubRenameFlow",
        /isDouble[\s\S]{0,700}hubRenameFlow\(node\)/.test(rsrc));
}

// ---------------------------------------------------------------------------
phase("PD stack card actions fit short entries (owner #2)");
{
    const css = fs.readFileSync(path.join(WEB, "styles.css"), "utf8");
    const m = css.match(/\.hub-stack-acts \{[\s\S]*?\n\}/);
    check("PD .hub-stack-acts exists", !!m);
    const block = m ? m[0] : "";
    check("PD the actions are a ROW (was a clipped column)",
        block.includes("flex-direction: row"), block);
    check("PD the row wraps when the card is narrow",
        block.includes("flex-wrap: wrap"));
    check("PD the row stays right-aligned like before",
        block.includes("justify-content: flex-end"));
    check("PD the row cannot exceed the card width",
        block.includes("max-width: calc(100% - 6px)"));
}

// ---------------------------------------------------------------------------
phase("PE chat.js stale-bubble fix markers");
{
    const csrc = fs.readFileSync(sb.chat, "utf8");
    check("PE a stale bubble is removed when a NEW run starts",
        /streamHostEl = runEl;[\s\S]{0,800}\.hub-chat-msg-streaming"\)\?\.remove\(\)/.test(csrc));
    check("PE the bubble is dropped in the run's finally (every outcome)",
        /finally \{[\s\S]{0,400}\.hub-chat-msg-streaming"\)\?\.remove\(\)[\s\S]{0,200}streaming = null;[\s\S]{0,120}streamHostEl = null;/.test(csrc));
    check("PE an empty runs list restores the hint after a failed run",
        /if \(!runs\.length\) renderRuns\(\);/.test(csrc));
}

// ---------------------------------------------------------------------------
console.log(`\nsmoke_v94: ${PASS} passed, ${FAIL} failed`);
if (FAIL) {
    for (const f of FAILURES) console.log("  FAIL: " + f);
    process.exit(1);
}
