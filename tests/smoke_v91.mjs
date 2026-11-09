// ============================================================================
// tests/smoke_v91.mjs - v91 regression suite
// ----------------------------------------------------------------------------
// Covers the owner requests that shipped in v91:
//   PA  hub registry self-healing (D2 + D3): a live scan ADDS a fresh hub,
//       positive removal evidence (node.graph === null / the own graph no
//       longer lists the node) DROPS a deleted one, undefined back-refs stay
//       (fail-open, the smoke_nav fixture contract);
//   PB  the launcher module: the only ComfyUI settings rows, the item
//       toggles, the collapse-hosting API;
//   PC  chat branches UI: variant arrows render from the session tree and
//       POST /chat/branch; the armed delete POSTs msg_delete; the fork POSTs
//       /chat/import with the prefix + copy_blobs_from; in-place assistant
//       edit PUTs /session/{sid}/msg; the active-prompt labels.
// Run: NODE_PATH=<jsdom> node tests/smoke_v91.mjs
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
    console.error("smoke_v91: jsdom is required (NODE_PATH=<node_modules with jsdom>)");
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

// ---------------------------------------------------------------------------
// Fake app + a minimal in-memory chat backend (v91 routes)
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
        // linearize the active path (the same contract the py implements)
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
    const api = {
        __calls: () => calls.slice(),
        __sessions: sessions,   // the PC phase syncs the client fixture into the server tree
        fetchApi: async (p, opts = {}) => {
            const method = (opts.method || "GET").toUpperCase();
            const body = opts.body ? JSON.parse(opts.body) : null;
            calls.push({ method, url: p, body });
            let m;
            if (p === "/settings_hub/chat/health") {
                return jres({ ok: true, has_ffmpeg: true, configured: true, writable: true, version: "v91" });
            }
            if (p === "/settings_hub/chat/config") {
                if (method === "POST") return jres({ ok: true, config: body || {} });
                return jres({ ok: true, config: { url: "http://127.0.0.1:8080/v1", model: "m", prompt_preset: "", system_prompt: "" } });
            }
            if (p === "/settings_hub/chat/models") return jres({ ok: true, models: [{ id: "m", status: "loaded" }], source: "openai" });
            if (p === "/settings_hub/chat/prompts") return jres({ ok: true, files: [], dir: "/x" });
            if (p === "/settings_hub/chat/sessions" && method === "POST") {
                const sid = newSid();
                const s = { id: sid, title: body?.title || "", created: 1, updated: 1, messages: [],
                    tree: { nodes: { __root__: { id: "__root__", parent: null, children: [], activeChild: null } }, activeLeaf: null } };
                sessions.set(sid, s);
                return jres({ ok: true, session: getSession(sid) });
            }
            if ((m = p.match(/^\/settings_hub\/chat\/session\/(\w+)\/msg_delete$/)) && method === "POST") {
                const s = sessions.get(m[1]);
                if (!s || !body?.nid || !s.tree.nodes[body.nid]) return jres({ ok: false, error: "no such message" }, 400);
                const doomed = new Set([body.nid]);
                for (const d of doomed) for (const c of (s.tree.nodes[d]?.children || [])) doomed.add(c);
                const pid = s.tree.nodes[body.nid]?.parent;
                for (const d of doomed) delete s.tree.nodes[d];
                if (pid && s.tree.nodes[pid]) {
                    const p2 = s.tree.nodes[pid];
                    p2.children = (p2.children || []).filter((c) => !doomed.has(c));
                    if (!p2.children.includes(p2.activeChild)) p2.activeChild = p2.children[p2.children.length - 1] || null;
                }
                return jres({ ok: true, session: getSession(m[1]) });
            }
            if ((m = p.match(/^\/settings_hub\/chat\/session\/(\w+)\/msg$/)) && method === "PUT") {
                const s = sessions.get(m[1]);
                const n = s?.tree.nodes[body?.nid];
                if (!n) return jres({ ok: false, error: "no such message" }, 400);
                n.text = body.text || "";
                return jres({ ok: true, session: getSession(m[1]) });
            }
            if ((m = p.match(/^\/settings_hub\/chat\/session\/(\w+)$/)) && method === "GET") {
                const s = sessions.get(m[1]);
                return s ? jres({ ok: true, session: getSession(m[1]) }) : jres({ ok: false }, 404);
            }
            if (p === "/settings_hub/chat/branch" && method === "POST") {
                const s = sessions.get(body?.sid);
                const n = s?.tree.nodes[body?.nid];
                if (!n) return jres({ ok: false, error: "no variant" }, 400);
                const kids = s.tree.nodes[n.parent].children;
                const i = kids.indexOf(body.nid);
                const j = body.dir > 0 ? i + 1 : i - 1;
                if (j < 0 || j >= kids.length) return jres({ ok: false, error: "no variant" }, 400);
                s.tree.nodes[n.parent].activeChild = kids[j];
                return jres({ ok: true, session: getSession(body.sid) });
            }
            if (p === "/settings_hub/chat/import" && method === "POST") {
                const sid = newSid();
                const s = { id: sid, title: body?.title || "", created: 1, updated: 1,
                    tree: { nodes: { __root__: { id: "__root__", parent: null, children: [], activeChild: null } }, activeLeaf: null },
                    messages: [] };
                sessions.set(sid, s);
                let prev = "__root__";
                for (const mm of (body?.messages || [])) {
                    const nid = "n" + Math.random().toString(16).slice(2, 8);
                    s.tree.nodes[nid] = { id: nid, parent: prev, children: [], activeChild: null, role: mm.role, text: mm.text };
                    s.tree.nodes[prev].children.push(nid);
                    s.tree.nodes[prev].activeChild = nid;
                    prev = nid;
                }
                s.tree.activeLeaf = prev;
                s.importedBlobsFrom = body?.copy_blobs_from || "";
                return jres({ ok: true, session: getSession(sid) });
            }
            if (p === "/settings_hub/chat/send" && method === "POST") {
                const s = sessions.get(body?.session);
                if (!s) return jres({ ok: false, error: "no such session" }, 404);
                const nodes = s.tree.nodes;
                const nid = "n" + Math.random().toString(16).slice(2, 8);
                if (body.edit_nid != null) {
                    const src = nodes[body.edit_nid];
                    const nnid = "n" + Math.random().toString(16).slice(2, 8);
                    nodes[nnid] = { id: nnid, parent: src.parent, children: [], activeChild: null, role: "user", text: body.text };
                    nodes[src.parent].children.push(nnid);
                    nodes[src.parent].activeChild = nnid;
                    const an = "n" + Math.random().toString(16).slice(2, 8);
                    nodes[an] = { id: an, parent: nnid, children: [], activeChild: null, role: "assistant", text: "branch answer" };
                    nodes[nnid].children.push(an);
                    nodes[nnid].activeChild = an;
                } else {
                    const leaf = s.tree.activeLeaf || "__root__";
                    nodes[nid] = { id: nid, parent: leaf, children: [], activeChild: null, role: "user", text: body.text || "" };
                    nodes[leaf].children.push(nid);
                    nodes[leaf].activeChild = nid;
                    const an = "n" + Math.random().toString(16).slice(2, 8);
                    nodes[an] = { id: an, parent: nid, children: [], activeChild: null, role: "assistant", text: "the answer" };
                    nodes[nid].children.push(an);
                    nodes[nid].activeChild = an;
                }
                return jres({ ok: true, session: getSession(body.session), reply: { text: "x", ctx: { used: 1, total: 0, est: true } } });
            }
            return jres({ ok: false, error: "unmocked " + p }, 404);
        },
        apiURL: (p) => p,
    };
    return api;
}

function makeSandbox() {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubv91-"));
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
globalThis.__SettingsHubBuild = "v91";

const sb = makeSandbox();
const core = await import(sb.core);
const launcher = await import(sb.launcher);
const chat = await import(sb.chat);
const hooks = chat.__chatTestHooks();

// ---------------------------------------------------------------------------
phase("PA hub registry self-healing (D2 dead hub, D3 fresh hub)");
{
    // D3: a hub tracked only by the bookkeeping (no graph back-ref) SURVIVES
    const ghost = { type: "SettingsHub", title: "tracked-only", properties: {} };
    core.trackHubNode(ghost);
    check("PA tracked-only hub listed", core.allHubs().includes(ghost));
    // D3: a hub that exists ONLY inside a live graph is discovered
    const fresh = { type: "SettingsHub", title: "fresh", properties: {}, graph: { _nodes: [] } };
    const g = { _nodes: [fresh] };
    fresh.graph._nodes = g._nodes;
    appStub.graph = g;
    check("PA fresh hub discovered by the scan", core.allHubs().includes(fresh));
    // D2 belt 1: node.graph === null -> removed on the very next call
    const dead = { type: "SettingsHub", title: "dead", properties: {}, graph: null };
    core.trackHubNode(dead);
    check("PA belt-1 dropped a graph=null hub immediately", !core.allHubs().includes(dead));
    // D2 belt 2: the own graph no longer lists the node
    const g2 = { _nodes: [{ type: "K", title: "other" }] };
    const stale = { type: "SettingsHub", title: "stale", properties: {}, graph: g2 };
    core.trackHubNode(stale);
    check("PA belt-2 removed a stale member", !core.allHubs().includes(stale));
    // fail-open: undefined back-ref stays (the smoke_nav fixture contract)
    check("PA undefined back-ref survives", core.allHubs().includes(ghost));
    appStub.graph = null;
}

// ---------------------------------------------------------------------------
phase("PB launcher module: settings rows + item toggles + hosting API");
{
    check("PB launcher self-reports v92 (the v92 taskbar rework)", globalThis.__SettingsHubLoaded?.launcher === "v92");
    check("PB on by default", launcher.isLauncherOn() === true);
    check("PB items default on",
        launcher.isLauncherItemOn("chat") && launcher.isLauncherItemOn("stack") && launcher.isLauncherItemOn("hub"));
    launcher.setLauncherItemOn("hub", false);
    check("PB item toggle persisted", launcher.isLauncherItemOn("hub") === false &&
        localStorage.getItem("settingshub.launcher.item.hub") === "0");
    launcher.setLauncherItemOn("hub", true);
    check("PB hosting API answers false without the bar",
        launcher.launcherHostsMinimized("chat") === false);
    // the ONLY SettingsHub rows in ComfyUI settings are the launcher ones
    const lsrc = fs.readFileSync(sb.launcher, "utf8");
    check("PB registers the 4 launcher rows",
        lsrc.includes("SettingsHub.Launcher.enabled") && lsrc.includes("SettingsHub.Launcher.itemChat") &&
        lsrc.includes("SettingsHub.Launcher.itemStack") && lsrc.includes("SettingsHub.Launcher.itemHub"));
    const csrc = fs.readFileSync(sb.chat, "utf8");
    const ssrc = fs.readFileSync(sb.base + "/stack.js", "utf8");
    check("PB chat/stack no longer register per-panel rows",
        !csrc.includes("SettingsHub.Chat.enabled") && !ssrc.includes("SettingsHub.PasteStack.enabled"));
}

// ---------------------------------------------------------------------------
phase("PC chat branches UI: arrows, delete, fork, edit-in-place");
{
    chat.initChat();
    await settle();
    const tab = hooks.activeId() ? hooks.tabById(hooks.activeId()) : null;
    check("PC a tab exists", !!tab);

    // a fixture tree: root has TWO user variants (u1 -> a1, u2 -> a2);
    // the active path is variant 1
    const T = (id, parent, role, text) => ({ id, parent, children: [], activeChild: null, role, text, ts: 1 });
    const tree = {
        nodes: {
            __root__: { id: "__root__", parent: null, children: ["u1", "u2"], activeChild: "u1" },
            u1: T("u1", "__root__", "user", "q one"),
            a1: T("a1", "u1", "assistant", "answer one"),
            u2: T("u2", "__root__", "user", "q two"),
            a2: T("a2", "u2", "assistant", "answer two"),
        },
        activeLeaf: "a1",
    };
    tree.nodes.u1.children = ["a1"]; tree.nodes.u1.activeChild = "a1";
    tree.nodes.u2.children = ["a2"]; tree.nodes.u2.activeChild = "a2";
    hooks.applySession(tab, {
        title: tab.title,
        messages: [
            { role: "user", text: "q one", ts: 1, nid: "u1" },
            { role: "assistant", text: "answer one", ts: 2, nid: "a1" },
        ],
        tree,
    });
    // the CLIENT fixture and the FAKE SERVER must see the same tree - the
    // /branch route operates on the server copy
    const srv = appStub.api.__sessions.get(tab.id);
    srv.tree = JSON.parse(JSON.stringify(tree));
    srv.messages = [{ role: "user", text: "q one", ts: 1, nid: "u1" }, { role: "assistant", text: "answer one", ts: 2, nid: "a1" }];
    await settle();
    const v = hooks.variantInfo(tab, "u1");
    check("PC variantInfo sees 2 root variants", v && v.count === 2 && v.index === 0, JSON.stringify(v));
    const varsHtml = hooks.msgsEl().querySelectorAll(".hub-chat-var");
    check("PC the arrows render on the branching message only", varsHtml.length === 2, String(varsHtml.length));
    check("PC the counter shows 1/2",
        hooks.msgsEl().textContent.includes("1/2"));
    // switch to variant 2 through the arrow -> POST /branch + re-render
    hooks.msgsEl().querySelector('[data-act="var-next"][data-nid="u1"]').click();
    await settle();
    const br = appStub.api.__calls().filter((c) => c.url === "/settings_hub/chat/branch");
    check("PC the arrow POSTed /branch", br.length === 1 && br[0].body.nid === "u1" && br[0].body.dir === 1, JSON.stringify(br[0]?.body));
    check("PC the path switched to variant 2",
        hooks.msgsEl().textContent.includes("q two") && hooks.msgsEl().textContent.includes("answer two"));
    check("PC the counter shows 2/2", hooks.msgsEl().textContent.includes("2/2"));

    // fork: ⑂ on the SECOND message copies the prefix (2 messages)
    hooks.msgsEl().querySelector('[data-act="fork"][data-i="1"]').click();
    await settle();
    const imp = appStub.api.__calls().filter((c) => c.url === "/settings_hub/chat/import");
    check("PC the fork POSTed /import", imp.length >= 1, JSON.stringify(imp.length));
    const lastImp = imp[imp.length - 1];
    check("PC the fork copies the prefix + the source sid",
        lastImp.body.copy_blobs_from === tab.id && lastImp.body.messages.length === 2,
        JSON.stringify({ from: lastImp.body?.copy_blobs_from, n: lastImp.body?.messages?.length }));
    check("PC the fork opened a new tab", hooks.tabs().length === 2, JSON.stringify(hooks.tabs().length));

    // armed delete: two clicks -> POST msg_delete (back on the source tab)
    hooks.setActive(tab.id);
    await settle();
    hooks.msgsEl().querySelector('[data-act="del"][data-nid="a2"]').click();
    await tick();
    hooks.msgsEl().querySelector('[data-act="del"][data-nid="a2"]').click();
    await settle();
    const del = appStub.api.__calls().filter((c) => c.url.endsWith("/msg_delete"));
    check("PC the delete is armed + POSTed once", del.length === 1 && del[0].body.nid === "a2", JSON.stringify(del));

    // in-place assistant edit: back to variant 1, ✎ -> ✔ save -> PUT /msg
    await hooks.switchVariant(tab, "u2", -1);
    await settle();
    hooks.msgsEl().querySelector('[data-act="edit"][data-i="1"]').click();
    await settle();
    const ta = hooks.msgsEl().querySelector(".hub-chat-edit-ta");
    check("PC the assistant edit textarea opens", !!ta);
    if (ta) {
        ta.value = "corrected";
        hooks.msgsEl().querySelector('[data-act="edit-save"]').click();
        await settle();
        const ed = appStub.api.__calls().filter((c) => c.url.endsWith("/msg"));
        check("PC the edit PUT /msg with the nid",
            ed.length === 1 && ed[0].body.nid === "a1" && ed[0].body.text === "corrected", JSON.stringify(ed[0]?.body));
    }

    // the active-prompt labels
    hooks.setCfg({ prompt_preset: "sub/name.txt", system_prompt: "" });
    check("PC the active prompt label names the file",
        hooks.activePromptLabel().text === "Active: sub/name.txt", hooks.activePromptLabel().text);
    hooks.setCfg({ prompt_preset: "", system_prompt: "be brief" });
    check("PC the custom text label",
        hooks.activePromptLabel().text === "Active: custom text (no file selected)");
    hooks.setCfg({ prompt_preset: "", system_prompt: "" });
    check("PC the none label", hooks.activePromptLabel().text.startsWith("Active: none"));

    // retry affordance: a trailing user request carries ↻ (patchRegenButtons)
    hooks.applySession(tab, {
        title: tab.title,
        messages: [{ role: "user", text: "unanswered", ts: 1, nid: "u9" }],
        tree: { nodes: { __root__: { id: "__root__", parent: null, children: ["u9"], activeChild: "u9" },
            u9: T("u9", "__root__", "user", "unanswered") }, activeLeaf: "u9" },
    });
    await settle();
    check("PC a trailing user request gets a retry button",
        !!hooks.msgsEl().querySelector('[data-act="regen"]'));
}

// ---------------------------------------------------------------------------
console.log(`\nsmoke_v91: ${PASS} passed, ${FAIL} failed`);
if (FAILURES.length) {
    console.log("Failures:");
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
}
