// ============================================================================
// SettingsHub - LLM Chat smoke test (v89)
// ----------------------------------------------------------------------------
// Node ESM + jsdom. Loads the REAL web/chat.js module exactly like the entry
// does (a sandbox copies web/ and stubs ../../scripts/app.js with an in-memory
// implementation of the py/chat_proxy.py protocol that records every call),
// then drives the panel through its REAL UI paths.
//
//   SA  mount: the panel + chip appear, a first tab is created automatically,
//       the status line shows the server url, the toolbar hosts the model
//       dropdown + refresh + thinking + prompt + GPU buttons.
//   SB  settings surface: getChatUiState echoes the (masked) config,
//       applyChatSettings POSTs a patch (url validated, numbers clamped).
//   SC  tabs: [＋] creates a second dialog, switching renders that dialog's
//       messages, ✕ closes a tab, dblclick-rename PUTs a new title.
//   SC2 (v87) a TYPED NAME + Enter in the [＋] field creates the tab under
//       that name (POST /sessions {title}).
//   SD  send (non-stream): the input text goes to POST /send, the session in
//       the reply replaces the tab messages (user + assistant bubbles),
//       the input is cleared.
//   SE  send (stream): SSE deltas update a live bubble, the done event's
//       session is applied, the input is cleared, pending attachments gone.
//   SF  stop: ⏹ aborts a hanging generation, the send button returns to ▶,
//       the client re-fetches the session (the server truth wins).
//   SG  attachments: a .txt file and a .png (jsdom cannot decode - the
//       fallback uploads the original) land on POST /attach and render as
//       chips; atch-del removes a chip; the image limit is enforced.
//   SH  viewer: 🔍 on a message thumbnail opens the large overlay, Esc/✕
//       close it.
//   SI  markdown-lite: <script> is escaped, **bold** / `code` / fenced blocks
//       (with a copy button) / links render; [t](javascript:...) does not.
//   SJ  geometry: a saved off-screen position is re-clamped on mount and on a
//       window resize (the v85 refit contract), the position persists
//       debounced; (v87) a devicePixelRatio change RESCALES the saved
//       geometry by the zoom factor before the refit.
//   SK  clear: 🗑 asks twice; the second click POSTs the clear and empties.
//   SL  sessions popup: 🕘 lists saved dialogs, a click reopens one in a tab,
//       🗑 deletes (armed, second click).
//   SM  degraded + Off/On: a missing py shows the red note; setChatOn(false)
//       tears the panel down, true re-mounts it.
//   SN  entry integration: the entry FILES list + EXPECTED manifest carry
//       chat.js, and the mount block calls initChat (source contract).
//   SO  (v87) ⚙ in the chat header opens the CHAT SETTINGS popup: the URL
//       row arrives from GET /config, Enter applies it via POST /config.
//   SP  (v88) 📜 opens the PROMPT popup = the user's CATALOG: the .txt files
//       of models/LLM/prompts (the PolyStrata path), a live MULTI-WORD
//       search, [↻] re-scan, a click stores cfg.prompt_preset, Save switches
//       to the custom text (and deselects the file), Clear = none.
//   SP2 (v88) [model ▾] reads GET /chat/models: the FULL registry list with
//       statuses (unavailable hidden), ● / ◐ / ○ marks; selecting a
//       not-loaded registry model fires POST /chat/load; an openai-source
//       list does not.
//   SP3 (v88) the panel manages itself: the ⚙ popup carries the Panel
//       On/Off row (Off tears the panel + popup down, On re-mounts) and the
//       native ComfyUI setting (SettingsHub.Chat.enabled) is registered.
//   SQ  (v87) ⚡ opens the GPU popup: the state line renders from
//       GET /chat/gpu, the buttons POST the actions (reserve/unload/load/
//       free_comfy/release) and the notes render.
//   SV  (v89) ⚙ NAMED FIELDS: every number sits in a .hub-cs-cell with a
//       visible non-empty .hub-cs-lab label (11 cells incl. context size
//       and timeout); the labels carry the field names.
//   SW  (v89) CONTEXT FILL: an assistant message carrying ctx {used,total,
//       est} renders "ctx 1.2k/32k" (≈ when estimated, ⚠ past 90%, exact
//       without ≈ when the server reported usage).
//   SX  (v89) 🕘 SEARCH: a live multi-word query filters the saved chats by
//       the title OR the content, hits show a content snippet, a no-match
//       query shows "nothing matches".
//   SY  (v89) 📜 PROMPTS FOLDER: the ⚙ 'Prompts folder' row applies a custom
//       catalog path via POST /config {prompts_dir} and [default] resets.
//   SZ  (v89) THE WAY BACK: hiding the chat toasts "ComfyUI Settings →
//       SettingsHub → 'LLM Chat panel'".
//
// Run from the extension root:  node tests/smoke_chat.mjs   (jsdom required)
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
    console.error("smoke_chat: jsdom is required (npm install -g jsdom + NODE_PATH)");
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const ENTRY_SRC = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
const PACK_VERSION = (ENTRY_SRC.match(/__SettingsHubBuild\s*=\s*"(v\d+)"/) || [])[1] || "v0";
// v96: the EXPECTED manifest of the entry (single-source version rule,
// docs/plan-versions.md) - module self-reports are checked against IT.
const EXPECTED_MANIFEST = (() => {
    const m = ENTRY_SRC.match(/const EXPECTED = \{([\s\S]*?)\};/);
    const out = {};
    if (m) for (const mm of m[1].matchAll(/"(\w+)":\s*"(v\d+)"/g)) out[mm[1]] = mm[2];
    return out;
})();

// ---------------------------------------------------------------------------
// DOM globals BEFORE chat.js evaluates
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
if (!dom.window.URL.createObjectURL) {
    dom.window.URL.createObjectURL = () => "blob:fake-" + Math.random().toString(36).slice(2);
    dom.window.URL.revokeObjectURL = () => {};
}
try { globalThis.URL = dom.window.URL; } catch (_) {}
// chat.js uses Image/canvas with a decode timeout - jsdom never decodes, the
// timeout path uploads the ORIGINAL file (which is exactly the fallback).
globalThis.Image = dom.window.Image;
globalThis.TextDecoder = globalThis.TextDecoder || util_TextDecoder();

function util_TextDecoder() {
    // Node has TextDecoder globally since 11 - this branch never fires.
    const { TextDecoder: TD } = require("node:util");
    return TD;
}

// ---------------------------------------------------------------------------
// Fake server: in-memory py/chat_proxy.py protocol
// ---------------------------------------------------------------------------

function makeFakeApi() {
    const calls = [];
    const sessions = new Map();   // id -> {id,title,created,updated,messages}
    const blobs = new Map();      // "<sid>/<name>" -> {bytes, mime, kind, orig}
    let config = {
        url: "http://127.0.0.1:8080/v1", key: "", model: "qwen-vl",
        system_prompt: "", prompt_preset: "", prompts_dir: "", ctx_size: 0,
        temperature: 0.8, top_p: 0.95,
        max_tokens: 1024, reasoning: "default", ctx_depth: 12, media_depth: 1,
        img_max_side: 1024, img_max_count: 4, video_frames: 16,
        video_max_side: 768, stream: true, keep_sessions: 20,
        timeout_s: 600, max_file_mb: 20, vram_reserve_mib: 0,
    };
    let healthMode = "ok";        // "ok" | "missing" | "http"
    let sseMode = true;           // /send answers SSE (true) or JSON (false)
    let hangSend = false;         // SF: the send request hangs until aborted
    // v88: the model registry (the PolyStrata /api/models shape) + the prompt
    // catalog (the models/LLM/prompts scan) - scriptable per phase
    let modelItems = [
        { id: "qwen-vl", status: "loaded" },
        { id: "glm-4b-air", status: "available" },
        { id: "qwen3-8b", status: "unavailable" },   // must be HIDDEN (the nodes hide it too)
    ];
    let modelSource = "registry";
    let promptFiles = ["analysis/detailed.txt", "cinematic.txt", "short_story.txt", "notes.md"];
    let promptDir = "/comfy/models/LLM/prompts";
    // v89: scriptable ctx fill for the /send answers
    let fakeCtx = { used: 1234, est: true, images: 0 };
    const uuid = () => Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, "0");

    const jsonResp = (data, status = 200) => ({
        ok: status < 400, status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => data,
    });

    const sessBrief = (s) => ({ id: s.id, title: s.title, created: s.created, updated: s.updated, n: s.messages.length });

    const api = {
        apiURL: (p) => p,
        fetchApi: async (u, opts = {}) => {
            const method = (opts.method || "GET").toUpperCase();
            calls.push({ url: u, method, body: opts.body });
            if (healthMode === "missing" && !String(u).startsWith("/settings_hub/chat/config")) {
                if (String(u).startsWith("/settings_hub/chat/")) return jsonResp({ ok: false, error: "not found" }, 404);
            }
            const [p, q] = String(u).split("?");
            const query = new URLSearchParams(q || "");

            if (p === "/settings_hub/chat/health" && method === "GET") {
                if (healthMode === "missing") return jsonResp({ ok: false, error: "404" }, 404);
                if (healthMode === "http") return jsonResp({ ok: false, error: "boom" }, 500);
                return jsonResp({ ok: true, version: PACK_VERSION, dir: "user/settings_hub/chat",
                    custom: false, default: "user/settings_hub/chat", writable: true,
                    sessions: sessions.size, configured: !!config.url, has_ffmpeg: true,
                    model: config.model, url: config.url });
            }
            if (p === "/settings_hub/chat/config" && method === "GET") {
                const masked = { ...config, key: config.key ? config.key.slice(0, 2) + "****" + config.key.slice(-4) : "" };
                return jsonResp({ ok: true, config: masked });
            }
            if (p === "/settings_hub/chat/config" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                if ("url" in body) {
                    const u2 = String(body.url || "").replace(/\/+$/, "");
                    if (u2 && !/^https?:\/\//.test(u2)) return jsonResp({ ok: false, error: "URL must start with http:// or https://" }, 400);
                    config.url = u2;
                }
                if ("key" in body) config.key = String(body.key || "");
                if ("reasoning" in body) config.reasoning = String(body.reasoning);
                if ("stream" in body) config.stream = !!body.stream;
                for (const k of ["temperature", "top_p", "max_tokens", "ctx_depth", "media_depth",
                    "img_max_side", "img_max_count", "video_frames", "video_max_side",
                    "keep_sessions", "timeout_s", "max_file_mb", "vram_reserve_mib"]) {
                    if (k in body && Number.isFinite(parseFloat(body[k]))) config[k] = parseFloat(body[k]);
                }
                for (const k of ["model", "system_prompt"])
                    if (k in body) config[k] = String(body[k] || "");
                if ("prompt_preset" in body) config.prompt_preset = String(body.prompt_preset || "");
                if ("prompts_dir" in body) config.prompts_dir = String(body.prompts_dir || "");
                const masked = { ...config, key: config.key ? config.key.slice(0, 2) + "****" + config.key.slice(-4) : "" };
                return jsonResp({ ok: true, config: masked });
            }
            if (p === "/settings_hub/chat/test" && method === "POST") {
                return jsonResp({ ok: true, source: modelSource,
                    models: modelItems.filter((m) => m.status !== "unavailable").map((m) => m.id),
                    current: config.model || "qwen-vl", status: null });
            }
            if (p === "/settings_hub/chat/models" && method === "GET") {
                return jsonResp({ ok: true, source: modelSource,
                    models: modelItems.filter((m) => m.status !== "unavailable"),
                    current: config.model || "qwen-vl", model: config.model || "" });
            }
            if (p === "/settings_hub/chat/load" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const m = String(body?.model || "");
                config.model = m;
                modelItems = modelItems.map((x) => x.id === m ? { ...x, status: "loaded" } : { ...x, status: x.status === "loaded" ? "unloaded" : x.status });
                return jsonResp({ ok: true, status: 200, answer: "{\"status\":\"loaded\"}", via: "registry" });
            }
            if (p === "/settings_hub/chat/prompts" && method === "GET") {
                return jsonResp({ ok: true, dir: promptDir, exists: true, files: promptFiles, error: null });
            }
            if (p === "/settings_hub/chat/prompt" && method === "GET") {
                const name = query.get("name") || "";
                if (!name.toLowerCase().endsWith(".txt")) return jsonResp({ ok: false, error: "bad prompt name" }, 400);
                return jsonResp({ ok: true, name, text: "PROMPT-TEXT(" + name + ")" });
            }
            if (p === "/settings_hub/chat/root" && method === "GET") {
                return jsonResp({ ok: true, root: "user/settings_hub/chat", custom: "", writable: true });
            }
            if (p === "/settings_hub/chat/root" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const pp = String(body.path || "").trim();
                if (pp && !pp.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(pp)) return jsonResp({ ok: false, error: "not an absolute path: " + pp });
                return jsonResp({ ok: true, root: pp || "user/settings_hub/chat", custom: pp, writable: true, saved: true });
            }
            if (p === "/settings_hub/chat/sessions" && method === "GET") {
                // v89: ?q= = the flexible search - every word must hit the
                // title OR any message text; hits carry a content snippet.
                const q = String(query.get("q") || "").trim().toLowerCase();
                let list = [...sessions.values()];
                if (q) {
                    const toks = q.split(/\s+/).filter(Boolean);
                    list = list.map((s) => {
                        const lt = String(s.title || "").toLowerCase();
                        const texts = s.messages.map((mm) => String(mm.text || ""));
                        const hitLine = texts.flatMap((t) => String(t).split("\n"))
                            .find((line) => line && toks.some((tk) => line.toLowerCase().includes(tk)));
                        const okAll = toks.every((tk) =>
                            lt.includes(tk) || texts.some((t) => t.toLowerCase().includes(tk)));
                        if (!okAll) return null;
                        const brief = sessBrief(s);
                        if (hitLine) brief.hit = hitLine.trim().slice(0, 120);
                        return brief;
                    }).filter(Boolean);
                } else {
                    list = list.map(sessBrief);
                }
                return jsonResp({ ok: true, sessions: list.sort((a, b) => b.updated - a.updated), q });
            }
            if (p === "/settings_hub/chat/sessions" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { body = {}; }
                const s = { id: uuid(), title: String(body?.title || ""), created: 1, updated: 1, messages: [] };
                sessions.set(s.id, s);
                return jsonResp({ ok: true, session: s });
            }
            // v108: the mass delete of the 🕘 popup ({ids} or {all:true})
            if (p === "/settings_hub/chat/sessions/delete" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                let ids = [];
                if (body.all === true) ids = [...sessions.keys()];
                else if (Array.isArray(body.ids)) {
                    if (body.ids.some((x) => !/^[a-f0-9]{8,32}$/.test(x))) {
                        return jsonResp({ ok: false, error: "bad session id" }, 400);
                    }
                    ids = body.ids;
                } else return jsonResp({ ok: false, error: "ids must be a list" }, 400);
                let deleted = 0;
                for (const sid of ids) if (sessions.delete(sid)) deleted++;
                return jsonResp({ ok: true, deleted, requested: ids.length });
            }
            if (p === "/settings_hub/chat/gpu" && method === "GET") {
                return jsonResp({
                    ok: true, configured: !!config.url,
                    upstream: { model: "qwen-vl", loaded: true, free_mib: 5120, total_mib: 24576, elastic: false },
                    reserve_mib: config.vram_reserve_mib || 0,
                    comfy_reserved: (config.vram_reserve_mib || 0) > 0,
                });
            }
            if (p === "/settings_hub/chat/gpu" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const act = String(body?.action || "");
                if (act === "reserve") {
                    config.vram_reserve_mib = Math.max(0, parseInt(body.mib, 10) || 0);
                    return jsonResp({ ok: true, action: act, notes: ["target " + config.vram_reserve_mib + " MiB, free 5120 MiB - OK"],
                        upstream: { model: "qwen-vl", loaded: true, free_mib: 5120, total_mib: 24576, elastic: false },
                        reserve_mib: config.vram_reserve_mib });
                }
                if (act === "release") {
                    config.vram_reserve_mib = 0;
                    return jsonResp({ ok: true, action: act, notes: ["server reserve released", "ComfyUI reservation: nothing to release"],
                        upstream: { model: "qwen-vl", loaded: true, free_mib: 5120, total_mib: 24576, elastic: false },
                        reserve_mib: 0 });
                }
                if (act === "unload") {
                    config.vram_reserve_mib = 0;
                    return jsonResp({ ok: true, action: act, notes: ["model unloaded - all of its VRAM is back", "server reserve released"],
                        upstream: { model: "qwen-vl", loaded: false, free_mib: 23000, total_mib: 24576, elastic: false },
                        reserve_mib: 0 });
                }
                if (act === "load") {
                    return jsonResp({ ok: true, action: act,
                        notes: ["load " + (body.model || "?") + ": " + JSON.stringify({ status: "loaded" })] });
                }
                if (act === "free_comfy") {
                    return jsonResp({ ok: true, action: act, notes: ["ComfyUI models unloaded; torch cache cleared"] });
                }
                if (act === "status") {
                    return jsonResp({ ok: true, action: act, notes: [],
                        upstream: { model: "qwen-vl", loaded: true, free_mib: 5120, total_mib: 24576, elastic: false },
                        reserve_mib: config.vram_reserve_mib || 0 });
                }
                return jsonResp({ ok: false, error: "unknown action: " + act }, 400);
            }
            let m = p.match(/^\/settings_hub\/chat\/session\/([a-f0-9]+)\/clear$/);
            if (m && method === "POST") {
                const s = sessions.get(m[1]);
                if (!s) return jsonResp({ ok: false, error: "no such session" }, 404);
                s.messages = [];
                return jsonResp({ ok: true, session: s });
            }
            m = p.match(/^\/settings_hub\/chat\/session\/([a-f0-9]+)$/);
            if (m) {
                const s = sessions.get(m[1]);
                if (method === "GET") {
                    if (!s) return jsonResp({ ok: false, error: "no such session" }, 404);
                    return jsonResp({ ok: true, session: s });
                }
                if (method === "PUT") {
                    const body = JSON.parse(String(opts.body));
                    s.title = String(body.title || "");
                    return jsonResp({ ok: true, session: s });
                }
                if (method === "DELETE") {
                    sessions.delete(m[1]);
                    return jsonResp({ ok: true, gone: m[1] });
                }
            }
            if (p === "/settings_hub/chat/attach" && method === "POST") {
                const sid = query.get("session") || "";
                const kind = query.get("kind") || "";
                const orig = query.get("name") || "file";
                if (!sessions.has(sid)) return jsonResp({ ok: false, error: "no such session" }, 404);
                const ext = (orig.split(".").pop() || "").toLowerCase();
                const OKD = {
                    image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                    video: ["mp4", "webm", "mov", "mkv", "avi"],
                    file: ["png", "jpg", "txt", "md", "json", "csv", "mp4", "pdf", "bin"],
                }[kind] || [];
                if (!OKD.includes(ext)) return jsonResp({ ok: false, error: "bad ext '" + ext + "' for kind " + kind }, 400);
                let bytes;
                try { bytes = new Uint8Array(await new dom.window.Blob([opts.body]).arrayBuffer()); }
                catch (_) { bytes = new Uint8Array(opts.body instanceof ArrayBuffer ? opts.body : []); }
                if (!bytes.length) return jsonResp({ ok: false, error: "empty payload" }, 400);
                const name = uuid() + "." + ext;
                blobs.set(sid + "/" + name, { bytes, kind, orig });
                return jsonResp({ ok: true, name, orig, size: bytes.length, kind,
                    mime: ext === "png" ? "image/png" : "application/octet-stream" });
            }
            if (p === "/settings_hub/chat/send" && method === "POST") {
                let body = opts.body;
                try { body = JSON.parse(body); } catch (_) { return jsonResp({ ok: false, error: "bad json" }, 400); }
                const s = sessions.get(body.session);
                if (!s) return jsonResp({ ok: false, error: "no such session" }, 404);
                if (hangSend) {
                    // SF: hang until the client aborts
                    await new Promise((res, rej) => {
                        const t = setTimeout(() => { res(); }, 8000);
                        try {
                            opts.signal.addEventListener("abort", () => {
                                clearTimeout(t);
                                const e = new Error("aborted");
                                e.name = "AbortError";
                                rej(e);
                            });
                        } catch (_) { clearTimeout(t); res(); }
                    });
                }
                if (body.edit_index != null) {
                    const i = body.edit_index;
                    s.messages[i].text = String(body.text ?? s.messages[i].text);
                    s.messages.length = i + 1;
                } else if (body.regenerate) {
                    if (s.messages.length && s.messages[s.messages.length - 1].role === "assistant") s.messages.pop();
                } else {
                    s.messages.push({ role: "user", text: String(body.text || ""), parts: body.attachments || [] });
                    if (!s.title && String(body.text || "").trim()) s.title = String(body.text).trim().slice(0, 60);
                }
                const replyText = "Echo: " + (body.edit_index != null ? s.messages[body.edit_index].text : s.messages[s.messages.length - 1].text);
                s.updated = Date.now();
                // v89: the context fill - the fake server attaches ctx to the
                // assistant message and the reply (total = ctx_size or 32000).
                const ctxTotal = parseInt(config.ctx_size, 10) > 0 ? parseInt(config.ctx_size, 10) : 32000;
                const ctx = { used: fakeCtx.used, total: ctxTotal,
                    est: fakeCtx.est !== false, images: fakeCtx.images || 0 };
                if (body.stream && sseMode && !hangSend) {
                    const evs = [];
                    for (const piece of ["Hel", "lo ", "world"]) {
                        evs.push(`data: ${JSON.stringify({ delta: piece })}\n\n`);
                    }
                    s.messages.push({ role: "assistant", text: replyText, parts: [], ctx });
                    // the REAL proxy puts the session INSIDE reply (chat_proxy.py:
                    // reply["session"] = sess) - match it exactly
                    evs.push(`data: ${JSON.stringify({ done: true, reply: { text: replyText, usage: {}, ctx, session: s } })}\n\n`);
                    const enc = new TextEncoder();
                    const chunks = evs.map((e) => enc.encode(e));
                    let ci = 0;
                    return {
                        ok: true, status: 200,
                        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
                        json: async () => { throw new Error("sse has no json"); },
                        body: {
                            // pace the stream: a pause before every chunk after
                            // the first, so the test can SEE the live bubble
                            getReader: () => ({
                                read: async () => {
                                    if (ci > 0 && ci < chunks.length) await new Promise((r) => setTimeout(r, 90));
                                    return ci < chunks.length
                                        ? { done: false, value: chunks[ci++] }
                                        : { done: true, value: undefined };
                                },
                            }),
                        },
                    };
                }
                s.messages.push({ role: "assistant", text: replyText, parts: [], ctx });
                return jsonResp({ ok: true, session: s, reply: { text: replyText, usage: { completion_tokens: 5 }, ctx } });
            }
            return jsonResp({ ok: false, error: "unhandled " + method + " " + p }, 404);
        },
        __calls: () => calls,
        __sessions: () => sessions,
        __blobs: () => blobs,
        __setHealth: (m) => { healthMode = m; },
        __setModels: (items, source) => { modelItems = items; modelSource = source || "registry"; },
        __setPrompts: (files, dir) => { promptFiles = files; if (dir) promptDir = dir; },
        __setCtx: (c) => { fakeCtx = { ...fakeCtx, ...c }; },
        __setSse: (v) => { sseMode = !!v; },
        __setHang: (v) => { hangSend = !!v; },
        __config: () => config,
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
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "hubchat-"));
    fs.mkdirSync(path.join(sb, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sb, "Hub", "web"), { recursive: true });
    for (const f of fs.readdirSync(WEB)) {
        if (f.endsWith(".js")) fs.copyFileSync(path.join(WEB, f), path.join(sb, "Hub", "web", f));
    }
    fs.writeFileSync(
        path.join(sb, "scripts", "app.js"),
        "export const app = globalThis.__HUB_APP_STUB__;\n",
    );
    return { chat: path.join(sb, "Hub", "web", "chat.js") };
}

const tick = () => new Promise((r) => setTimeout(r, 6));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

function fakeFile(name, type, bytes) {
    return {
        name, type,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const appStub = { registerExtension(ext) { appStub.__extensions.push(ext); }, __extensions: [], canvas: null, graph: null };
const fakeApi = makeFakeApi();
appStub.api = fakeApi;
globalThis.__HUB_APP_STUB__ = appStub;

// a pre-existing saved session (the 🕘 reopen path)
fakeApi.fetchApi("/settings_hub/chat/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
}).then(async (r) => {
    const j = await r.json();
    j.session.title = "Старый чат";
    j.session.messages = [{ role: "user", text: "previous" }, { role: "assistant", text: "earlier answer" }];
}).catch(() => {});
await settle();

const { chat: chatUrl } = makeSandbox();
globalThis.__SettingsHubBuild = PACK_VERSION;
const chat = await import(chatUrl);
const hooks = chat.__chatTestHooks();

// setChatOn(true) is the default; mount like the entry's extension setup does
chat.initChat();
await settle();

// ---------------------------------------------------------------------------
phase("SA mount: panel + chip + an auto-created first tab + status line");

const panel = hooks.panelEl();
check("panel exists", !!panel && panel.className === "hub-chat-panel");
check("chip exists (hidden)", !!hooks.chipEl() && hooks.chipEl().style.display === "none");
check("no ✕ close button (the v75 contract)", !panel.querySelector(".hub-chat-close"));
await settle();
check("one tab auto-created", hooks.tabs().length === 1, JSON.stringify(hooks.tabs()));
check("tab is active", hooks.activeId() === hooks.tabs()[0].id);
check("status line shows the server url",
    hooks.statusEl().textContent.includes("http://127.0.0.1:8080/v1"), hooks.statusEl().textContent);
check("toolbar model dropdown populated", hooks.modelSelEl().innerHTML.includes("qwen-vl"), hooks.modelSelEl().innerHTML);
check("toolbar carries refresh + thinking + prompt + gpu",
    !!hooks.modelsBtnEl() && !!hooks.thinkSelEl() && !!hooks.promptBtnEl() && !!hooks.gpuBtnEl());
check("header carries the settings gear + no model select in the header",
    !!hooks.settingsBtnEl() && !panel.querySelector(".hub-chat-head .hub-chat-model"));
check("tabs markup rendered", hooks.tabsEl().querySelectorAll(".hub-chat-tab").length === 1);
check("input + send + attach present",
    !!hooks.inputEl() && !!hooks.sendBtnEl() && !!panel.querySelector(".hub-chat-attachbtn"));

// ---------------------------------------------------------------------------
phase("SB settings surface: config echo + apply");

const st = await chat.getChatUiState();
check("ui state echoes the config", st.cfg && st.cfg.url === "http://127.0.0.1:8080/v1" && st.cfg.model === "qwen-vl");
check("ui state reports ffmpeg", st.has_ffmpeg === true);
const ap = await chat.applyChatSettings({ temperature: 1.25 });
check("applyChatSettings applies", ap.ok && ap.config.temperature === 1.25, ap);
const ap2 = await chat.applyChatSettings({ url: "not-a-url" });
check("bad url refused", !ap2.ok && /http/.test(ap2.error), ap2);
const tr = await chat.testChatServer();
check("testChatServer returns models", tr.ok && tr.models.includes("qwen-vl"), tr);

// ---------------------------------------------------------------------------
phase("SC tabs: create / switch / rename / close");

const firstId = hooks.activeId();
const t2 = await hooks.createTab();
await settle();
check("second tab created + active", hooks.tabs().length === 2 && hooks.activeId() === t2.id, JSON.stringify(hooks.tabs()));
hooks.inputEl().value = "tab2 message";
await hooks.send();
await settle();
check("message landed in tab2", hooks.tabById(t2.id).msgs.length === 2, hooks.tabById(t2.id).msgs.length);
hooks.setActive(firstId);
await settle();
check("switching back shows tab1 (empty)", hooks.tabById(firstId).msgs.length === 0);
check("the rendered list belongs to tab1", hooks.msgsEl().querySelectorAll(".hub-chat-msg").length === 0);
check("tab chips rendered", hooks.tabsEl().querySelectorAll(".hub-chat-tab").length === 2);
await hooks.renameTab(t2.id, "Второй диалог");
await settle();
check("rename PUT applied", hooks.tabById(t2.id).title === "Второй диалог", hooks.tabById(t2.id).title);
hooks.closeTab(t2.id);
await settle();
check("close removes the tab and re-activates tab1", hooks.tabs().length === 1 && hooks.activeId() === firstId);

// ---------------------------------------------------------------------------
phase("SC2 (v87) a typed tab name IS used");

// drive the REAL UI path: [＋] -> type -> Enter (the v86 bug: the typed
// name was dropped and the tab fell back to the auto-title)
const addBtn = hooks.tabsEl().querySelector(".hub-chat-tab-add");
addBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await tick();
const tabInp = hooks.tabsEl().querySelector(".hub-chat-tab-input");
check("the [＋] field opened", !!tabInp);
tabInp.value = "Мой новый чат";
tabInp.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await settle();
const named = hooks.tabs().find((t) => t.title === "Мой новый чат");
check("the tab carries the typed name", !!named, JSON.stringify(hooks.tabs()));
check("POST /sessions carried the title",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/sessions" && c.method === "POST" &&
        String(c.body).includes("Мой новый чат")));
hooks.closeTab(named.id);
await settle();
check("close removes the tab and re-activates tab1", hooks.tabs().length === 1 && hooks.activeId() === firstId);

// ---------------------------------------------------------------------------
phase("SD send (non-stream): server session replaces the tab");

fakeApi.__setSse(false);
hooks.setCfg({ ...hooks.cfg(), stream: false });
hooks.inputEl().value = "Привет, модель";
await hooks.send();
await settle();
const tab1 = hooks.tabById(firstId);
check("two bubbles rendered", hooks.msgsEl().querySelectorAll(".hub-chat-msg").length === 2);
check("user + assistant in the tab", tab1.msgs.length === 2 && tab1.msgs[0].role === "user");
check("reply text", tab1.msgs[1].text === "Echo: Привет, модель", tab1.msgs[1].text);
check("input cleared", hooks.inputEl().value === "");
check("send recorded with the session id",
    fakeApi.__calls().some((c) => c.url.startsWith("/settings_hub/chat/send") && String(c.body).includes('"session":"' + firstId + '"')));
check("assistant bubble carries a regen button",
    !!hooks.msgsEl().querySelector('[data-act="regen"]'));
check("user bubble carries an edit button",
    !!hooks.msgsEl().querySelector('.hub-chat-msg-user [data-act="edit"]'));

// ---------------------------------------------------------------------------
phase("SE send (stream): live deltas then the done session");

fakeApi.__setSse(true);
hooks.setCfg({ ...hooks.cfg(), stream: true });
hooks.inputEl().value = "streamed question";
const sendP = hooks.send();
await new Promise((r) => setTimeout(r, 40));
check("live streaming bubble appears", !!hooks.msgsEl().querySelector(".hub-chat-msg-streaming"));
check("send button shows stop", hooks.sendBtnEl().textContent === "⏹", hooks.sendBtnEl().textContent);
await sendP;
await settle();
check("streamed answer applied (2+2 msgs)", tab1.msgs.length === 4, tab1.msgs.length);
check("streamed text assembled", tab1.msgs[3].text === "Echo: streamed question", tab1.msgs[3].text);
check("input cleared after stream", hooks.inputEl().value === "");
check("send button back to send", hooks.sendBtnEl().textContent === "▶");
check("no streaming bubble left", !hooks.msgsEl().querySelector(".hub-chat-msg-streaming"));

// ---------------------------------------------------------------------------
phase("SF stop: abort a hanging generation");

fakeApi.__setHang(true);
hooks.inputEl().value = "will be aborted";
const hangP = hooks.send();
await settle();
check("busy during the hang", hooks.sendBtnEl().textContent === "⏹");
hooks.stopStream();
await hangP;
await settle();
check("busy cleared after abort", hooks.sendBtnEl().textContent === "▶");
check("input NOT cleared on abort (owner keeps the text)", hooks.inputEl().value === "will be aborted",
    hooks.inputEl().value);
fakeApi.__setHang(false);
await new Promise((r) => setTimeout(r, 1100)); // refreshSessionSoon's 900ms debounce
check("a session refresh GET followed the abort",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/session/" + firstId && c.method === "GET" &&
        fakeApi.__calls().indexOf(c) > fakeApi.__calls().findIndex((c2) => c2.url.startsWith("/settings_hub/chat/send"))));

// ---------------------------------------------------------------------------
phase("SG attachments: chips, upload, limits");

const sid = hooks.activeId();
await hooks.addFiles([fakeFile("notes.txt", "text/plain", [104, 105])]);
await settle();
check("txt chip rendered", hooks.attachEl().querySelectorAll(".hub-chat-atch").length === 1);
check("attach POST recorded", fakeApi.__calls().some((c) => c.url.includes("/settings_hub/chat/attach") && c.url.includes("kind=file")));
const pend = hooks.tabById(sid).pending;
check("pending references the blob", pend.length === 1 && /^[a-f0-9]+\.txt$/.test(pend[0].name), JSON.stringify(pend));
// a video without real bytes still attaches (has_ffmpeg=true in the fake)
await hooks.addFiles([fakeFile("clip.mp4", "video/mp4", [1, 2, 3, 4])]);
await settle();
check("video chip added", hooks.tabById(sid).pending.filter((p) => p.kind === "video").length === 1);
// png: jsdom cannot decode -> the timeout fallback uploads the ORIGINAL file
const t0 = Date.now();
await hooks.addFiles([fakeFile("shot.png", "image/png", [137, 80, 78, 71])]);
check("image attach finished via the decode fallback", Date.now() - t0 < 4000);
await settle();
const imgs = hooks.tabById(sid).pending.filter((p) => p.kind === "image");
check("image chip added", imgs.length === 1, JSON.stringify(hooks.tabById(sid).pending));
check("image blob name kept the extension", /\.png$/.test(imgs[0]?.name || ""), imgs[0]?.name);
// the per-message image limit
for (let i = 0; i < 5; i++) {
    await hooks.addFiles([fakeFile("more.png", "image/png", [1])]);
}
check("img_max_count=4 enforced", hooks.tabById(sid).pending.filter((p) => p.kind === "image").length === 4,
    hooks.tabById(sid).pending.length);
// remove a chip via its ✕
const del = hooks.attachEl().querySelector('[data-act="atch-del"]');
const before = hooks.tabById(sid).pending.length;
del.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("atch-del removed a chip", hooks.tabById(sid).pending.length === before - 1);
hooks.clearPending();
check("clearPending empties the row", hooks.attachEl().style.display === "none");

// ---------------------------------------------------------------------------
phase("SH viewer: 🔍 opens the overlay, Esc closes");

const part = { kind: "file", name: "x.txt", orig: "x.txt" };
hooks.tabById(hooks.activeId()).msgs.push({ role: "user", text: "with a file", parts: [part] });
await settle();
await hooks.openViewer(hooks.tabById(hooks.activeId()), part);
check("viewer overlay open", !!hooks.viewerEl() && hooks.viewerEl().className.includes("hub-stack-viewer"));
check("text preview staged", !!hooks.viewerEl().querySelector(".hub-chat-view-text"));
hooks.closeViewer();
check("viewer closed", !hooks.viewerEl());

// ---------------------------------------------------------------------------
phase("SI markdown-lite: escaping + fences + links");

const html = hooks.mdLite("Hi **bold** `code` <script>alert(1)</script>\n```py\nx<1\n```\n[site](https://x.y) [bad](javascript:alert(1))");
check("script tag escaped", !html.includes("<script>"), html);
check("bold rendered", html.includes("<b>bold</b>"));
check("inline code rendered", html.includes('class="hub-chat-icode"'));
check("fenced block + copy button", html.includes("hub-chat-code") && html.includes("data-code-copy"));
check("fence content escaped", html.includes("x&lt;1"));
check("http link kept", html.includes('href="https://x.y"'));
check("javascript: link neutralized", !html.includes('href="javascript:'), html);

// ---------------------------------------------------------------------------
phase("SJ geometry: refit on mount and on resize (the v85 contract) + the v87 page zoom");

try { localStorage.setItem("settingshub.chat.ui", JSON.stringify({ x: 3000, y: 1600, w: 2800, h: 1200 })); } catch (_) {}
chat.setChatOn(false);
await settle();
chat.setChatOn(true);
await settle();
const p2 = hooks.panelEl();
const left = parseFloat(p2.style.left), top = parseFloat(p2.style.top);
const w = parseFloat(p2.style.width), h = parseFloat(p2.style.height);
check("size capped to the 1024x768 viewport", w <= 1000 && h <= 744, `${w}x${h}`);
// jsdom has NO layout: offsetWidth/offsetHeight are 0, so clampIntoView
// measures the 260x120 FALLBACK box (the same observable contract the stack
// suite TX pins: a 1024x768 viewport clamps x to vw-260-8 and y to vh-120-8;
// a real browser measures the real box and clamps the full panel in).
check("position clamped inside", left >= 8 && top >= 8 && left <= 1024 - 260 - 8 && top <= 768 - 120 - 8,
    `${left},${top}`);
// a resize event re-fits
p2.style.left = "1000px";
hooks.fireResize();
await tick();
check("resize re-clamps instantly", parseFloat(hooks.panelEl().style.left) <= 1024 - 260 - 8 + 4,
    hooks.panelEl().style.left);
await new Promise((r) => setTimeout(r, 250)); // the debounced persist
const uiSaved = JSON.parse(localStorage.getItem("settingshub.chat.ui") || "{}");
check("position persisted debounced", typeof uiSaved.x === "number" && uiSaved.x <= 1024 - 260 - 8 + 4, JSON.stringify(uiSaved));

// v87 page zoom: a devicePixelRatio change rescales the SAVED geometry by
// the zoom factor (before the refit clamps it) - 2x zoom doubles x/y/w/h.
try { localStorage.setItem("settingshub.chat.ui", JSON.stringify({ x: 100, y: 80, w: 400, h: 300 })); } catch (_) {}
hooks.setDpr(1);
Object.defineProperty(dom.window, "devicePixelRatio", { value: 2, configurable: true });
hooks.fireResize();
await new Promise((r) => setTimeout(r, 250));
const uiZoomed = JSON.parse(localStorage.getItem("settingshub.chat.ui") || "{}");
check("page zoom rescales the saved geometry",
    Math.abs(uiZoomed.w - 800) <= 1 && Math.abs(uiZoomed.h - 600) <= 1 && Math.abs(uiZoomed.x - 200) <= 1,
    JSON.stringify(uiZoomed));
Object.defineProperty(dom.window, "devicePixelRatio", { value: 1, configurable: true });
hooks.setDpr(1);
hooks.fireResize();
await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------------------
phase("SK clear: 🗑 asks twice");

const clearBtn = p2.querySelector(".hub-chat-clear");
clearBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("first click only arms", tab1.msgs.length > 0);
clearBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("second click cleared the tab", hooks.tabById(hooks.activeId()).msgs.length === 0);
check("clear POST recorded",
    fakeApi.__calls().some((c) => c.url.endsWith("/clear") && c.method === "POST"));

// ---------------------------------------------------------------------------
phase("SL sessions popup: reopen + armed delete");

await hooks.openSessPop();
await settle();
const pop = hooks.sessPopEl();
check("popup rendered", !!pop && pop.className.includes("hub-chat-sessions"));
check("saved chat listed", pop.textContent.includes("Старый чат"));
const nTabs = hooks.tabs().length;
const oldRow = [...pop.querySelectorAll(".hub-chat-sess")].find((r) => r.textContent.includes("Старый чат"));
check("the saved row is addressable", !!oldRow);
oldRow.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("click reopened the dialog in a new tab", hooks.tabs().length === nTabs + 1, hooks.tabs().length);
const reopened = hooks.tabById(hooks.activeId());
check("reopened tab carries its messages", reopened.msgs.length === 2, reopened.msgs.length);
check("reopened tab title", reopened.title === "Старый чат", reopened.title);
hooks.closeSessPop();
await hooks.openSessPop();
await settle();
const oldRow2 = [...hooks.sessPopEl().querySelectorAll(".hub-chat-sess")].find((r) => r.textContent.includes("Старый чат"));
const delBtn = oldRow2.querySelector(".hub-chat-sess-del");
delBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("first 🗑 re-arms the same row", !!hooks.sessPopEl() &&
    !!hooks.sessPopEl().querySelector(".hub-chat-sess-del-armed"), !!hooks.sessPopEl());
const delBtn2 = hooks.sessPopEl().querySelector(".hub-chat-sess-del-armed") ||
    hooks.sessPopEl().querySelector(".hub-chat-sess-del");
delBtn2.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("second 🗑 DELETEd the session",
    fakeApi.__calls().some((c) => c.method === "DELETE" && c.url.startsWith("/settings_hub/chat/session/")));
hooks.closeSessPop();

// ---------------------------------------------------------------------------
phase("SS (v108) saved-chats MASS management: checkboxes, dynamic select-all, armed deletes");

// seed three saved chats for the bulk playground
const seedSess = (id, title) =>
    fakeApi.__sessions().set(id, { id, title, created: 1, updated: 1, messages: [] });
seedSess("aa11bb22cc33", "Bulk alpha");
seedSess("bb22cc33dd44", "Bulk beta");
seedSess("cc33dd44ee55", "Bulk gamma");

await hooks.openSessPop();
await settle();
let spop = hooks.sessPopEl();
check("SS: the mass tools row exists (selall / delself / delall)",
    !!spop.querySelector('[data-ss="selall"]') &&
    !!spop.querySelector('[data-ss="delself"]') &&
    !!spop.querySelector('[data-ss="delall"]'));
check("SS: every row carries a checkbox",
    spop.querySelectorAll(".hub-chat-sess-check").length >= 3,
    String(spop.querySelectorAll(".hub-chat-sess-check").length));
const selAllBtn = spop.querySelector('[data-ss="selall"]');
check("SS: the select-all starts as 'Select all'", selAllBtn.textContent.includes("Select all"), selAllBtn.textContent);

// one checkbox change joins the selection; the click itself never opens the chat
const tabsBeforeCb = hooks.tabs().length;
const cbA = [...spop.querySelectorAll(".hub-chat-sess-check")].find((c) => c.dataset.sscheck === "aa11bb22cc33");
cbA.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("SS: a checkbox click does NOT open the chat", hooks.tabs().length === tabsBeforeCb, hooks.tabs().length);
cbA.checked = true;
cbA.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("SS: the change event joined the selection", hooks.sessSel().includes("aa11bb22cc33"), JSON.stringify(hooks.sessSel()));
check("SS: the row wears the selected highlight",
    !!hooks.sessPopEl().querySelector('.hub-chat-sess[data-sid="aa11bb22cc33"].hub-chat-sess-sel'));
check("SS: the select-all label is still 'Select all' (some unchecked)",
    hooks.sessPopEl().querySelector('[data-ss="selall"]').textContent.includes("Select all"));

// dynamic select-all: one click checks EVERY visible row -> 'Deselect all'
hooks.sessPopEl().querySelector('[data-ss="selall"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("SS: select-all checked the whole visible list",
    hooks.sessSel().includes("aa11bb22cc33") && hooks.sessSel().includes("bb22cc33dd44") && hooks.sessSel().includes("cc33dd44ee55"),
    JSON.stringify(hooks.sessSel()));
const selLabel = hooks.sessPopEl().querySelector('[data-ss="selall"]').textContent;
check("SS: the label flipped to 'Deselect all'", selLabel.includes("Deselect all"), selLabel);
hooks.sessPopEl().querySelector('[data-ss="selall"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("SS: deselect-all cleared the visible list", hooks.sessSel().length === 0, JSON.stringify(hooks.sessSel()));

// Delete selected: arm -> confirm -> one POST /sessions/delete {ids}; an open
// tab of a deleted chat closes too
const openTab = await hooks.createTab("Bulk victim");
hooks.sessSelSet(["aa11bb22cc33", "bb22cc33dd44", openTab.id]);
hooks.renderSessTools();
const delSelBtn = hooks.sessPopEl().querySelector('[data-ss="delself"]');
delSelBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("SS: delete-selected armed (the pulsing confirm)", hooks.sessBulk()?.mode === "sel", String(hooks.sessBulk()?.mode));
check("SS: the armed button names the confirm",
    hooks.sessPopEl().querySelector('[data-ss="delself"]').textContent.includes("Confirm"));
hooks.sessPopEl().querySelector('[data-ss="delself"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle(12);
const bulkCall = fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/sessions/delete").at(-1);
check("SS: the confirm POSTed one bulk delete",
    !!bulkCall && bulkCall.method === "POST", JSON.stringify(bulkCall || {}));
const bulkBody = bulkCall ? JSON.parse(bulkCall.body) : {};
check("SS: the payload carried exactly the checked ids",
    Array.isArray(bulkBody.ids) && bulkBody.ids.includes("aa11bb22cc33") &&
    bulkBody.ids.includes("bb22cc33dd44") && bulkBody.ids.includes(openTab.id) &&
    !bulkBody.ids.includes("cc33dd44ee55"), JSON.stringify(bulkBody));
check("SS: the deleted sessions left the server store",
    !fakeApi.__sessions().has("aa11bb22cc33") && !fakeApi.__sessions().has("bb22cc33dd44"));
check("SS: the open tab of a deleted chat was closed",
    !hooks.tabs().some((t) => t.id === openTab.id), JSON.stringify(hooks.tabs()));
check("SS: the untouched chat survived",
    fakeApi.__sessions().has("cc33dd44ee55"));
check("SS: the selection was consumed by the delete", hooks.sessSel().length === 0, JSON.stringify(hooks.sessSel()));

// Delete all: arm -> confirm -> {all:true}; every session dies, an emptied
// workspace auto-creates a fresh tab (the panel never ends with zero tabs)
hooks.sessPopEl().querySelector('[data-ss="delall"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("SS: delete-all armed", hooks.sessBulk()?.mode === "all", String(hooks.sessBulk()?.mode));
hooks.sessPopEl().querySelector('[data-ss="delall"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle(12);
const allCall = fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/sessions/delete").at(-1);
check("SS: the confirm POSTed {all:true}", !!allCall && JSON.parse(allCall.body).all === true, JSON.stringify(allCall || {}));
check("SS: every SEEDED session is gone",
    !fakeApi.__sessions().has("cc33dd44ee55") && !fakeApi.__sessions().has("aa11bb22cc33"));
await settle();
check("SS: an emptied workspace auto-created one fresh tab",
    hooks.tabs().length === 1, JSON.stringify(hooks.tabs()));
hooks.closeSessPop();
check("SS: closing the popup resets the selection", hooks.sessSel().length === 0);

// ---------------------------------------------------------------------------
phase("SM degraded py + Off/On");

fakeApi.__setHealth("missing");
chat.setChatOn(false);
await settle();
chat.setChatOn(true);
await settle();
check("red note names the fix", hooks.noteEl().textContent.includes("RESTART ComfyUI"),
    hooks.noteEl().textContent);
check("panel still mounted despite the degraded py", !!hooks.panelEl());
fakeApi.__setHealth("ok");
chat.setChatOn(false);
await settle();
check("Off removes the panel", !hooks.panelEl() && !hooks.chipEl());
check("Off is the localStorage switch", localStorage.getItem("settingshub.chat.on") === "0");
check("Off tells WHERE the way back is (v91: the mini panel)",
    document.body.textContent.includes("the mini panel (💬 toggle) or ComfyUI Settings → SettingsHub → 'Mini panel'"));
chat.setChatOn(true);
await settle();
check("On re-mounts", !!hooks.panelEl());

// ---------------------------------------------------------------------------
phase("SN entry integration (source contract)");

check("entry FILES carries ./chat.js", /"\.\/chat\.js",\s*\/\/ v\d+/.test(ENTRY_SRC));
check("entry EXPECTED carries chat", /"chat":\s*"v\d+"/.test(ENTRY_SRC));
check("entry mounts the chat extension", /initChat\(\)/.test(ENTRY_SRC) && /Comfy\.SettingsHub\.chat/.test(ENTRY_SRC));
// v96: aligned with the v82 single-source version convention (the README
// carried this check as known-stale since v95): a module self-reports the
// version of its LAST FUNCTIONAL CHANGE, and the entry manifest must name
// exactly that value - not the pack version.
check("chat self-reports the version the entry EXPECTS (v82 convention)",
    globalThis.__SettingsHubLoaded?.chat === EXPECTED_MANIFEST.chat,
    String(globalThis.__SettingsHubLoaded?.chat) + " vs " + String(EXPECTED_MANIFEST.chat));
check("the py module is wired in __init__.py",
    fs.readFileSync(path.join(ROOT, "__init__.py"), "utf8").includes("chat_proxy"));

// ---------------------------------------------------------------------------
phase("SO (v87) ⚙ opens the chat settings popup (URL applies)");

hooks.openSetPop();
await settle();
const setPop = hooks.setPopEl();
check("settings popup open", !!setPop && setPop.className.includes("hub-chat-setpop"));
const urlIn2 = setPop.querySelector('[data-cs="url"]');
check("URL row arrived from GET /config", urlIn2.value === "http://127.0.0.1:8080/v1", urlIn2.value);
const nums2 = setPop.querySelectorAll("[data-cs-num]");
check("sampling rows arrived (11 = 9 + ctx_size + timeout)", nums2.length === 11, nums2.length);
check("every number sits under a visible label",
    [...setPop.querySelectorAll(".hub-cs-cell")].every((c) =>
        c.querySelector(".hub-cs-lab")?.textContent?.trim().length > 0 && c.querySelector("[data-cs-num]")),
    [...setPop.querySelectorAll(".hub-cs-cell")].map((c) => c.querySelector(".hub-cs-lab")?.textContent));
check("label names are readable (temperature, history depth, context size)",
    setPop.textContent.includes("temperature") && setPop.textContent.includes("history depth") &&
    setPop.textContent.includes("context size (0 = auto)"));
check("the Off row spells the way back (v91: the mini panel)",
    setPop.textContent.includes("the mini panel (💬 toggle) or ComfyUI Settings → SettingsHub → 'Mini panel'"));
urlIn2.value = "http://127.0.0.1:9999/v1";
urlIn2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await settle();
check("URL Enter applied via POST /config",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/config" && c.method === "POST" &&
        String(c.body).includes("9999")));
check("config in memory followed", hooks.cfg().url === "http://127.0.0.1:9999/v1", hooks.cfg().url);
hooks.closeSetPop();
check("settings popup closed", !hooks.setPopEl());
// restore the url for the later phases
await chat.applyChatSettings({ url: "http://127.0.0.1:8080/v1" });
await settle();

// ---------------------------------------------------------------------------
phase("SP (v88) 📜 prompt popup: the user's CATALOG - list, live multi-word search, refresh, select");

fakeApi.__setPrompts(["analysis/detailed.txt", "cinematic.txt", "short_story.txt", "notes.md"]);
hooks.openPromptPop();
await settle();
const prPop = hooks.promptPopEl();
check("prompt popup open", !!prPop && prPop.className.includes("hub-chat-promptpop"));
check("GET /chat/prompts fetched the catalog",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/prompts" && c.method === "GET"));
check("no invented presets left", !prPop.querySelector('[data-cp="concise"]') && !prPop.innerHTML.includes("Concise assistant"));
const listEl = prPop.querySelector('[data-cp="list"]');
check("catalog listed (txt only, relative paths)", listEl.innerHTML.includes("cinematic.txt") &&
    listEl.innerHTML.includes("analysis/detailed.txt") && !listEl.innerHTML.includes("notes.md"), listEl.innerHTML);
check("none (custom text) is listed first", listEl.querySelector('[data-cp-name=""]') != null);

// live multi-word search: EVERY word must match the relative path
const searchIn = prPop.querySelector('[data-cp="search"]');
searchIn.value = "detailed txt";
searchIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
check("multi-word search narrows the list",
    listEl.querySelectorAll("[data-cp-name]").length === 2, listEl.innerHTML); // none + the one match
searchIn.value = "zzz-nothing";
searchIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
check("empty result shows the search note", listEl.innerHTML.includes("nothing matches"));
searchIn.value = "";
searchIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

// select a catalog file -> cfg.prompt_preset
const fileBtn = listEl.querySelector('[data-cp-name="cinematic.txt"]');
fileBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("selecting a file stores cfg.prompt_preset", hooks.cfg().prompt_preset === "cinematic.txt",
    hooks.cfg().prompt_preset);
check("the file is highlighted in the list",
    listEl.querySelector('[data-cp-name="cinematic.txt"]').classList.contains("hub-cp-item-on"));
check("prompt button lit", hooks.promptBtnEl().classList.contains("hub-chat-tb-on"));
check("button title names the file", hooks.promptBtnEl().title.includes("cinematic.txt"), hooks.promptBtnEl().title);

// [↻] refresh re-fetches the catalog (fresh scan)
fakeApi.__setPrompts(["only_one.txt"]);
prPop.querySelector('[data-cp="refresh"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("refresh re-scanned the catalog", listEl.innerHTML.includes("only_one.txt"), listEl.innerHTML);

// Save switches to the custom text (and deselects the preset)
const ta2 = prPop.querySelector(".hub-cp-ta");
ta2.value = "Custom owner prompt";
prPop.querySelector(".hub-cp-save").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("Save stored the custom text", hooks.cfg().system_prompt === "Custom owner prompt", hooks.cfg().system_prompt);
check("Save DESELECTED the preset", hooks.cfg().prompt_preset === "", hooks.cfg().prompt_preset);
check("none is highlighted again", listEl.querySelector('[data-cp-name=""]').classList.contains("hub-cp-item-on"));
prPop.querySelector(".hub-cp-clear").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("Clear emptied the prompt", hooks.cfg().system_prompt === "", JSON.stringify(hooks.cfg().system_prompt));
check("prompt button unlit", !hooks.promptBtnEl().classList.contains("hub-chat-tb-on"));
hooks.closePromptPop();
check("prompt popup closed", !hooks.promptPopEl());

// ---------------------------------------------------------------------------
phase("SP2 (v88→v92) model dropdown: the FULL registry list, status marks; select = SAVE ONLY");

check("fillModels used GET /chat/models",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/models" && c.method === "GET"));
check("models carry statuses (the registry shape)",
    JSON.stringify(hooks.models()) === JSON.stringify([
        { id: "qwen-vl", status: "loaded" }, { id: "glm-4b-air", status: "available" }]),
    JSON.stringify(hooks.models()));
check("unavailable registry entries are HIDDEN", !hooks.models().some((m) => m.id === "qwen3-8b"));
check("dropdown shows the loaded mark for the current model",
    hooks.modelSelEl().innerHTML.includes("● qwen-vl"), hooks.modelSelEl().innerHTML);
check("dropdown shows the available mark for the other model",
    hooks.modelSelEl().innerHTML.includes("○ glm-4b-air"), hooks.modelSelEl().innerHTML);

// selecting a model ONLY SAVES the choice (v92 owner #1: nothing loads or
// switches here - the wake happens with the FIRST message through the py
// _ensure_llm_ready path; ⚡ can still load on demand)
const loadCallsBeforeSel = fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/load").length;
hooks.modelSelEl().value = "glm-4b-air";
hooks.modelSelEl().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("selection saved cfg.model", hooks.cfg().model === "glm-4b-air", hooks.cfg().model);
check("v92: the pick fires NO switch (it only saves)",
    fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/load").length === loadCallsBeforeSel);
check("v92: the picked model keeps its registry status (nothing loaded)",
    hooks.models().find((m) => m.id === "glm-4b-air").status === "available",
    JSON.stringify(hooks.models()));

// an openai-style server (no registry) just takes the name - no switch call
const loadCallsBefore = fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/load").length;
fakeApi.__setModels([{ id: "llama-3", status: "" }], "openai");
await hooks.fillModels(false);
await settle();
check("openai fallback list rendered with the plain mark",
    hooks.modelSelEl().innerHTML.includes("○ llama-3"), hooks.modelSelEl().innerHTML);
hooks.modelSelEl().value = "llama-3";
hooks.modelSelEl().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("openai source does NOT fire the switch",
    fakeApi.__calls().filter((c) => c.url === "/settings_hub/chat/load").length === loadCallsBefore);
fakeApi.__setModels([
    { id: "qwen-vl", status: "loaded" }, { id: "glm-4b-air", status: "available" }], "registry");

// ---------------------------------------------------------------------------
phase("SP3 (v88) the chat panel manages itself: Panel On/Off in ⚙ + the native setting");

hooks.openSetPop();
await settle();
const setPop3 = hooks.setPopEl();
const panelSel3 = setPop3.querySelector('[data-cs="panel"]');
check("⚙ popup carries the Panel row", !!panelSel3, setPop3.innerHTML.slice(0, 400));
check("Panel row shows On", panelSel3.value === "1");
panelSel3.value = "0";
panelSel3.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await settle();
check("Panel Off tore the panel down (incl. the popup)", !hooks.panelEl() && !hooks.setPopEl());
chat.setChatOn(true);
await settle();
check("Panel On re-mounted the chat", !!hooks.panelEl());
check("source-level: the v91 launcher replaces the native chat switch",
    fs.readFileSync(path.join(ROOT, "web", "chat.js"), "utf8").includes('from "./launcher.js"') &&
    fs.readFileSync(path.join(ROOT, "web", "launcher.js"), "utf8").includes('mk("SettingsHub.Launcher.enabled"') &&
    !fs.readFileSync(path.join(ROOT, "web", "chat.js"), "utf8").includes('SettingsHub.Chat.enabled'));
await settle();

// ---------------------------------------------------------------------------
phase("SQ (v87) ⚡ GPU popup: state + actions");

hooks.openGpuPop();
await settle();
const gPop = hooks.gpuPopEl();
check("gpu popup open", !!gPop && gPop.className.includes("hub-chat-gpupop"));
await settle(); // refreshGpuPop
check("state line rendered", gPop.querySelector('[data-gpu="state"]').textContent.includes("LOADED"),
    gPop.querySelector('[data-gpu="state"]').textContent);
gPop.querySelector('[data-gpu="mib"]').value = "4096";
gPop.querySelector('[data-gpu-btn="reserve"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("reserve action POSTed",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/gpu" && c.method === "POST" &&
        String(c.body).includes('"action":"reserve"')));
check("notes rendered", gPop.querySelector('[data-gpu="notes"]').textContent.includes("target 4096"),
    gPop.querySelector('[data-gpu="notes"]').textContent);
check("gpu button lit (reserve ON)", hooks.gpuBtnEl().classList.contains("hub-chat-tb-on"));
gPop.querySelector('[data-gpu-btn="unload"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("unload action POSTed",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/gpu" && c.method === "POST" &&
        String(c.body).includes('"action":"unload"')));
check("unload note rendered", gPop.querySelector('[data-gpu="notes"]').textContent.includes("unloaded"),
    gPop.querySelector('[data-gpu="notes"]').textContent);
check("reserve dropped after unload", hooks.cfg().vram_reserve_mib === 0, hooks.cfg().vram_reserve_mib);
gPop.querySelector('[data-gpu-btn="free"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("free_comfy action POSTed",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/gpu" && c.method === "POST" &&
        String(c.body).includes('"action":"free_comfy"')));
hooks.closeGpuPop();
check("gpu popup closed", !hooks.gpuPopEl());

// ---------------------------------------------------------------------------
phase("SW (v89) context fill: the status line shows used/available");

// a fresh send leaves an assistant ctx {used:1234, total:32000, est} on the tab
const tabC = hooks.tabById(hooks.activeId());
tabC.msgs = [...tabC.msgs,
    { role: "user", text: "ctx question", parts: [] },
    { role: "assistant", text: "ctx answer", parts: [], ctx: { used: 1234, total: 32000, est: true, images: 0 } }];
hooks.renderStatus();
check("status line shows ctx used/total",
    /ctx ≈1\.2k\s*\/\s*32k/.test(hooks.statusEl().textContent), hooks.statusEl().textContent);
// exact usage (the server reported prompt_tokens) loses the ≈
tabC.msgs[tabC.msgs.length - 1].ctx = { used: 1234, total: 32000, est: false, images: 0 };
hooks.renderStatus();
check("exact usage drops the ≈",
    /ctx 1\.2k\s*\/\s*32k/.test(hooks.statusEl().textContent) && !hooks.statusEl().textContent.includes("≈"),
    hooks.statusEl().textContent);
// past 90% of the context - the warning mark
tabC.msgs[tabC.msgs.length - 1].ctx = { used: 31000, total: 32000, est: true, images: 2 };
hooks.renderStatus();
check("past 90% shows ⚠ + the image count",
    hooks.statusEl().textContent.includes("31k / 32k ⚠") && hooks.statusEl().textContent.includes("2 img"),
    hooks.statusEl().textContent);
// no total reported -> only the used part
tabC.msgs[tabC.msgs.length - 1].ctx = { used: 900, total: 0, est: true, images: 0 };
hooks.renderStatus();
check("unknown total shows only the used",
    /ctx ≈900(\s|$)/.test(hooks.statusEl().textContent) && !hooks.statusEl().textContent.includes(" / "),
    hooks.statusEl().textContent);
// the real send path stores ctx from the reply (fake server attaches it)
hooks.inputEl().value = "hello ctx";
await hooks.send();
await settle();
const sentTab = hooks.tabById(hooks.activeId());
check("a real send stores ctx on the assistant message",
    !!sentTab.msgs[sentTab.msgs.length - 1].ctx && sentTab.msgs[sentTab.msgs.length - 1].ctx.used === 1234,
    JSON.stringify(sentTab.msgs[sentTab.msgs.length - 1].ctx));
check("the sent ctx renders in the status line",
    hooks.statusEl().textContent.includes("ctx"), hooks.statusEl().textContent);

// ---------------------------------------------------------------------------
phase("SX (v89) 🕘 search: multi-word over title + content, snippets");

// two fresh saved chats with distinct titles/content
const rA = await fakeApi.fetchApi("/settings_hub/chat/sessions",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const sA = (await rA.json()).session;
sA.title = "Cat breeds";
sA.messages = [{ role: "user", text: "About Maine Coon cats" }, { role: "assistant", text: "They are large" }];
const rB = await fakeApi.fetchApi("/settings_hub/chat/sessions",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const sB = (await rB.json()).session;
sB.title = "Trip plan";
sB.messages = [{ role: "user", text: "Visit Rome and Naples" }];

await hooks.openSessPop();
await settle();
const sPop2 = hooks.sessPopEl();
check("the search row is there", !!sPop2.querySelector('[data-ss="q"]'));
const sIn = sPop2.querySelector('[data-ss="q"]');
sIn.value = "cats";
sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 350));   // the debounce + fetch
await settle();
check("content word filters to its chat",
    sPop2.textContent.includes("Cat breeds") && !sPop2.textContent.includes("Trip plan"),
    sPop2.textContent.slice(0, 200));
sIn.value = "trip rome";
sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 350));
await settle();
check("multi-word title+content combined",
    sPop2.textContent.includes("Trip plan") && !sPop2.textContent.includes("Cat breeds"),
    sPop2.textContent.slice(0, 200));
check("hit snippet shows the matched line", sPop2.textContent.includes("Visit Rome and Naples"),
    sPop2.textContent.slice(0, 300));
sIn.value = "zzz-nowhere";
sIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 350));
await settle();
check("no match -> nothing matches the search", sPop2.textContent.includes("nothing matches"),
    sPop2.textContent.slice(0, 200));
hooks.closeSessPop();

// ---------------------------------------------------------------------------
phase("SY (v89) prompts folder: a custom catalog path in ⚙");

hooks.openSetPop();
await settle();
const setPop4 = hooks.setPopEl();
const pdirIn = setPop4.querySelector('[data-cs="pdir"]');
check("Prompts folder row exists", !!pdirIn);
pdirIn.value = "/my/own/prompts";
pdirIn.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await settle();
check("Enter applied prompts_dir via POST /config",
    fakeApi.__calls().some((c) => c.url === "/settings_hub/chat/config" && c.method === "POST" &&
        String(c.body).includes("/my/own/prompts")), JSON.stringify(hooks.cfg().prompts_dir));
check("config followed", hooks.cfg().prompts_dir === "/my/own/prompts", hooks.cfg().prompts_dir);
check("info line confirms", setPop4.querySelector('[data-cs="pdirinfo"]').textContent.includes("/my/own/prompts"),
    setPop4.querySelector('[data-cs="pdirinfo"]').textContent);
setPop4.querySelector('[data-cs-btn="pdirdef"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
await settle();
check("[default] resets to the PolyStrata path", hooks.cfg().prompts_dir === "", hooks.cfg().prompts_dir);
hooks.closeSetPop();

// ---------------------------------------------------------------------------

// SZ (v98) tab-strip wheel — the same defect the Paste Stack had before v97:
// the strip is overflow-x:auto with a HIDDEN scrollbar, so the mouse wheel
// is the only scroller. Mirrors the stack's UI phase.
phase("SZ (v98) tab-strip wheel — the vertical wheel scrolls the hidden-scrollbar strip");
{
    for (let i = 1; i <= 8; i++) await hooks.createTab("Wheel chat " + i);
    const strip = hooks.tabsEl();
    check("SZ: the strip holds the modes switch + 9 tab chips",
        strip.querySelectorAll(".hub-chat-tab:not(.hub-chat-tab-edit)").length === 9 &&
        !!strip.querySelector(".hub-chat-modes"));
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
    check("SZ: wheelTabs(0,120) scrolled the strip and reported the scroll",
        hooks.wheelTabs(0, 120, 0) === true && sl === 120, String(sl));
    check("SZ: a wheel EVENT over the strip is consumed (preventDefault)",
        wheelAt(strip, 0, 120, 0) === true && sl === 240, String(sl));
    check("SZ: deltaMode 1 (lines) scales x16",
        hooks.wheelTabs(0, 2, 1) === true && sl === 272, String(sl));
    check("SZ: deltaMode 2 (pages) scales by the visible width",
        hooks.wheelTabs(0, 1, 2) === true && sl === 532, String(sl));
    check("SZ: a horizontal (trackpad) delta wins over the vertical one",
        hooks.wheelTabs(-50, 10, 0) === true && sl === 482, String(sl));
    check("SZ: a zero delta is a no-op", hooks.wheelTabs(0, 0, 0) === false && sl === 482);
    // no overflow -> the event passes through untouched
    stub(strip, "scrollWidth", 200);
    check("SZ: without overflow nothing scrolls and the event bubbles",
        hooks.wheelTabs(0, 120, 0) === false && sl === 482 &&
        wheelAt(strip, 0, 120, 0) === false);
    // revealActiveTab: the active chip sits beyond the right edge -> scrolled into view
    stub(strip, "scrollWidth", 900);
    const activeChip = strip.querySelector(".hub-chat-tab-on");
    check("SZ: exactly one active chip after the renders", !!activeChip);
    stub(activeChip, "offsetLeft", 620);
    stub(activeChip, "offsetWidth", 90);
    sl = 0;
    hooks.revealActiveTab();
    check("SZ: revealActiveTab scrolls the active chip into view",
        sl === 620 + 90 - 260 + 4, String(sl));
    activeChip.offsetLeft = 0; // left edge: scroll back to the start
    sl = 500;
    hooks.revealActiveTab();
    check("SZ: revealActiveTab scrolls BACK when the chip is left of the view",
        sl === 0, String(sl));
    // a re-render (switch the active tab) also reveals the new active chip.
    // The freshly rendered chip element cannot carry per-element stubs (the
    // innerHTML rebuild recreates it) - stub the geometry on the prototype
    // for the duration of the switch instead. createTab ACTIVATES the new
    // tab, so a non-active one (the first) is the honest switch target.
    const firstId = hooks.tabs()[0].id;
    stub(strip, "scrollWidth", 900);
    sl = 0;
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetLeft", { value: 700, configurable: true });
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { value: 90, configurable: true });
    hooks.setActive(firstId);
    // renderTabs already ran inside setActive: scrollLeft moved to the new chip
    check("SZ: setActive re-render reveals the newly opened chip",
        sl === 700 + 90 - 260 + 4, String(sl));
    delete dom.window.HTMLElement.prototype.offsetLeft;
    delete dom.window.HTMLElement.prototype.offsetWidth;
    // cleanup: drop the layout stubs (the prototype getters come back)
    for (const k of ["scrollWidth", "clientWidth", "offsetLeft", "offsetWidth", "scrollLeft"]) delete strip[k];
    for (const k of ["offsetLeft", "offsetWidth"]) delete activeChip[k];
}

// ---------------------------------------------------------------------------

console.log();
console.log("smoke_chat: %d passed, %d failed", pass, fail);
if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
