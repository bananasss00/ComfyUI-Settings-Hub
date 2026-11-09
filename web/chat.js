// ============================================================================
// SettingsHub - LLM Chat (v86): floating panel with TABS, OpenAI-compatible
// upstream through the py proxy (py/chat_proxy.py)
// ----------------------------------------------------------------------------
// v86 (owner request 2026-11-09: "a simple LLM chat in the settings hub, just
//   for chatting, like the stacker in a separate window, with image and video
//   support, and some ComfyUI integration"): the CHAT panel:
//     * a floating panel EXACTLY like the Paste Stack one - drag the header,
//       resize by the grip, [–] minimize to a chip, geometry in localStorage
//       (settingshub.chat.ui), and the v85 refit contract from day one
//       (clampIntoView prefers the FULL panel inside the viewport, a window
//       resize re-fits instantly and persists the position debounced);
//     * TABS - several chats at once, every tab is its own dialog with its
//       own history (server-side sessions, see below); dblclick renames a
//       tab, ✕ closes it (the dialog stays in 🕘), [＋] starts a new one;
//     * MESSAGES - user/assistant bubbles, a collapsed 💭 thinking block for
//       reasoning models (reasoning_content), markdown-lite rendering (fenced
//       code blocks with a copy button, `inline`, **bold**, *italic*, links)
//       done by an escaping renderer - no external parser, no XSS surface;
//     * MESSAGE ACTIONS - 📋 copy, ↻ regenerate the last answer, ✎ edit your
//       own message and re-send (the tail after it is cut server-side);
//     * ATTACHMENTS - images (vision: the client downscales to the configured
//       max side and uploads a JPEG blob; the proxy sends it as an OpenAI
//       image_url data-URL part), video (the SERVER cuts frames with ffmpeg
//       and speaks the PolyStrata mtmd convention: [Video N] + <X.X seconds>
//       + one image_url part per frame) and text-like files (their content
//       enters the prompt inline, capped at 300 KB). 📎 button, Ctrl+V with
//       files, drag&drop onto the panel; chips above the input (🔍 viewer,
//       ✕ remove); sent messages keep clickable thumbnails;
//     * STREAMING - the reply renders as it arrives (SSE through the proxy);
//       ⏹ aborts; the server notices the vanished browser, cancels the
//       upstream request (PolyStrata frees the engine slot on "client went
//       away") and stores the partial answer marked "stopped";
//     * the browser NEVER talks to the LLM server directly - every request
//       goes through /settings_hub/chat/* (py/chat_proxy.py): no CORS setup
//       on the LLM server, the api key never enters the browser, aborts
//       propagate. Storage lives in user/settings_hub/chat/ (config.json +
//       sessions/<id>/) and travels with the ComfyUI folder; a custom
//       absolute folder is supported (the v84 stack-root mechanics).
//   The chat is NOT an agent (owner decision): no tools, no queue control,
//   no workflow access. ComfyUI integrations are parked for later.
// ============================================================================

// v86 self-report (single-source version, docs/plan-versions.md): the last
// FUNCTIONAL change of THIS file - no per-file build stamps anymore.
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["chat"] = "v86";

import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------

const LS_UI = "settingshub.chat.ui";   // {x,y,w,h,min,chipX,chipY,tabs:[id],active:id}
const LS_ON = "settingshub.chat.on";   // "1"/"0" - panel enabled
const Z_PANEL = "99901";               // next to the stack (99900), under popups
const DEF_W = 520, DEF_H = 640;
const MIN_W = 320, MIN_H = 280;

let panel = null, chip = null, mounted = false, initSeq = 0;
let headEl = null, tabEl = null, msgsEl = null, attachEl = null;
let inputEl = null, sendBtn = null, statusEl = null, noteEl = null;
let grip = null, modelSel = null, sessionsBtn = null;
let tabs = [];            // open tabs: {id, title, msgs, pending:[part]}
let activeId = null;      // active tab session id
let streaming = null;     // {ctrl, sid}
let serverState = null;   // /chat/health result
let cfg = null;           // cached (masked) config from the server
let degraded = null;      // {code, why} - red note state
let viewerEl = null;      // chat viewer overlay
let clearArm = null, clearArmTs = 0, sessArm = null, sessArmTs = 0;
const CLEAR_ARM_MS = 2600, SESS_ARM_MS = 2600;

// ---------------------------------------------------------------------------
// Small helpers (the stack.js patterns, chat flavor)
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function lsUi() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_UI) || "{}");
        return v && typeof v === "object" ? v : {};
    } catch (_) { return {}; }
}

function saveUi(patch) {
    try { localStorage.setItem(LS_UI, JSON.stringify({ ...lsUi(), ...patch })); } catch (_) {}
}

function localToast(msg, ms = 2600) {
    try {
        const t = document.createElement("div");
        t.textContent = msg;
        Object.assign(t.style, {
            position: "fixed", left: "14px", bottom: "86px", zIndex: "999990",
            maxWidth: "440px", padding: "8px 12px", borderRadius: "8px",
            background: "rgba(24,28,38,0.95)", color: "#dfe6f5",
            border: "1px solid #3d5a80", font: "12px/1.45 system-ui, sans-serif",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)", userSelect: "none",
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms);
    } catch (_) {}
}

function fmtBytes(n) {
    const v = Number(n || 0);
    if (v >= 1024 * 1024) return (Math.round(v / (1024 * 1024) * 10) / 10) + " MB";
    if (v >= 1024) return Math.max(1, Math.round(v / 1024)) + " KB";
    return v + " B";
}

function extOf(name) {
    return String(name || "").split(".").pop().toLowerCase().slice(0, 8);
}

const IMG_EXT_OK = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const VID_EXT_OK = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);
const TEXT_EXT_OK = new Set(["txt", "md", "json", "csv", "log", "py", "js",
    "css", "html", "xml", "yml", "yaml", "ini", "tsv"]);

function apiReady() {
    try { return !!(app && app.api && typeof app.api.fetchApi === "function"); }
    catch (_) { return false; }
}

function fileUrl(sid, name) {
    const p = "/settings_hub/chat/file/" + encodeURIComponent(sid || "") +
        "/" + encodeURIComponent(name || "");
    try { return app.api?.apiURL ? app.api.apiURL(p) : p; } catch (_) { return p; }
}

/** fetch + json in one call; NEVER throws - resolves {ok, status, json} */
async function jfetch(path, opts) {
    try {
        const r = await app.api.fetchApi(path, opts);
        if (!r) return { ok: false, status: 0, json: null };
        const j = await r.json().catch(() => null);
        return { ok: !!r.ok, status: r.status, json: j };
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        return { ok: false, status: 0, json: null, err: e };
    }
}

// ---------------------------------------------------------------------------
// Settings surface (⚙ Hub settings -> Chat, hub_ui_renderer.js)
// ---------------------------------------------------------------------------

export function isChatOn() {
    try { const v = localStorage.getItem(LS_ON); return v == null ? true : v === "1"; }
    catch (_) { return true; }
}

export function setChatOn(v) {
    try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (_) {}
    if (v && !mounted) initChat();
    else if (!v) teardown();
}

/** Masked config + diagnostics for the settings rows (never throws). */
export async function getChatUiState() {
    if (!apiReady()) return { cfg: null, has_ffmpeg: false, configured: false };
    const h = await jfetch("/settings_hub/chat/health");
    const c = await jfetch("/settings_hub/chat/config");
    return {
        cfg: c.json?.ok ? c.json.config : null,
        has_ffmpeg: !!h.json?.has_ffmpeg,
        configured: !!h.json?.configured,
        writable: h.json ? h.json.writable !== false : null,
        version: h.json?.version || null,
    };
}

/** Apply a partial config patch server-side. Resolves {ok, config?, error?}
 *  (never throws); stale=true means the py predates the chat routes. */
export async function applyChatSettings(patch) {
    const out = { ok: false };
    if (!apiReady()) { out.error = "server unreachable"; return out; }
    try {
        const r = await app.api.fetchApi("/settings_hub/chat/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch || {}),
        });
        const j = r ? await r.json().catch(() => null) : null;
        if (r && r.ok && j && j.ok) {
            out.ok = true;
            out.config = j.config;
            cfg = j.config;
            renderStatus();
        } else {
            out.error = (j && j.error) || ("HTTP " + (r ? r.status : "?"));
        }
    } catch (e) { out.error = String(e); }
    return out;
}

/** Probe the upstream LLM server through the proxy: /v1/models (+ /v1/status
 *  when it answers). Resolves {ok, models, current, status, error}. */
export async function testChatServer() {
    const res = await jfetch("/settings_hub/chat/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!res.json) return { ok: false, models: [], error: "server unreachable" };
    return res.json;
}

// v86: storage root - the v84 stack mechanics (chat flavor)
export async function getChatRootInfo() {
    if (!apiReady()) return null;
    const r = await jfetch("/settings_hub/chat/root");
    return r.json && r.json.ok ? r.json : null;
}

export async function setChatRootPath(raw) {
    const out = { ok: false, error: "server unreachable" };
    if (!apiReady()) return out;
    try {
        const r = await app.api.fetchApi("/settings_hub/chat/root", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: String(raw ?? "") }),
        });
        const j = r ? await r.json().catch(() => null) : null;
        if (r && r.ok && j && j.ok) return { ok: true, ...j };
        return {
            ok: false,
            stale: !!(r && r.status === 404),
            error: (j && j.error) || ("HTTP " + (r ? r.status : "?")),
        };
    } catch (e) { out.error = String(e); return out; }
}

// ---------------------------------------------------------------------------
// Geometry - the stack.js window contract incl. the v85 refit
// ---------------------------------------------------------------------------

function clampPos(x, y, el) {
    const w = el?.offsetWidth || 260, h = el?.offsetHeight || 120;
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    return {
        x: Math.min(Math.max(x, -w + 64), vw - 64),
        y: Math.min(Math.max(y, 0), vh - 64),
    };
}

function clampIntoView(x, y, el) {
    const p = clampPos(x, y, el);
    const w = el?.offsetWidth || 260, h = el?.offsetHeight || 120;
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    return {
        x: w + 16 <= vw ? Math.min(Math.max(p.x, 8), vw - w - 8) : p.x,
        y: h + 16 <= vh ? Math.min(Math.max(p.y, 8), vh - h - 8) : p.y,
    };
}

function applyPos(x, y) {
    if (!panel) return;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
}

function applyChipPos(x, y) {
    if (!chip) return;
    chip.style.left = x + "px";
    chip.style.top = y + "px";
}

function applySize(w, h) {
    if (!panel) return;
    const W = Math.min(Math.max(w, MIN_W), 900);
    const H = Math.min(Math.max(h, MIN_H), 1400);
    panel.style.width = W + "px";
    panel.style.height = H + "px";
}

function makeDraggable(handle, target, getPos, setPos) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.("button, select, input, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const { x: ox, y: oy } = getPos();
        const move = (ev) => {
            const p = clampPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY), target);
            setPos(p.x, p.y, false);
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            const p = clampPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY), target);
            setPos(p.x, p.y, true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function setMinimized(min, persist = true) {
    if (!panel || !chip) return;
    panel.style.display = min ? "none" : "";
    chip.style.display = min ? "" : "none";
    if (min) {
        const ui = lsUi();
        applyChipPos(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16);
    }
    if (persist) saveUi({ min: !!min });
}

function refitIntoView() {
    if (!panel || !chip) return;
    const ui = lsUi();
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    applySize(Math.min(ui.w ?? DEF_W, Math.max(MIN_W, vw - 24)),
        Math.min(ui.h ?? DEF_H, Math.max(MIN_H, vh - 24)));
    if (!ui.min) {
        const p = clampIntoView(ui.x ?? 16, ui.y ?? 90, panel);
        applyPos(p.x, p.y);
    } else {
        const c = clampIntoView(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16, chip);
        applyChipPos(c.x, c.y);
    }
}

let resizePersistT = null;
function onWinResize() {
    refitIntoView();
    clearTimeout(resizePersistT);
    resizePersistT = setTimeout(() => {
        if (!panel || !chip) return;
        const ui = lsUi();
        const p = clampIntoView(ui.x ?? 16, ui.y ?? 90, panel);
        const patch = { x: p.x, y: p.y };
        if (ui.min) {
            const c = clampIntoView(ui.chipX ?? p.x, ui.chipY ?? p.y, chip);
            patch.chipX = c.x; patch.chipY = c.y;
        }
        saveUi(patch);
    }, 150);
}

// ---------------------------------------------------------------------------
// Tabs (every tab = one server session)
// ---------------------------------------------------------------------------

function activeTab() {
    return tabs.find((t) => t.id === activeId) || null;
}

function saveOpenTabs() {
    saveUi({ tabs: tabs.map((t) => t.id), active: activeId });
}

function applySession(tab, sess) {
    if (!tab || !sess) return;
    tab.title = sess.title || "";
    tab.msgs = Array.isArray(sess.messages) ? sess.messages : [];
    if (tab.id === activeId) { renderTabs(); renderMsgs(); renderStatus(); }
}

async function createTab() {
    const res = await jfetch("/settings_hub/chat/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const sess = res.json?.session;
    if (!res.ok || !sess?.id) {
        // the probe note ("update the FULL pack and RESTART") is more
        // actionable than "could not create" - never overwrite it
        if (!degraded) noteDegraded({ code: "create", why: res.json?.error || ("HTTP " + res.status) });
        return null;
    }
    const tab = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], pending: [] };
    tabs.push(tab);
    activeId = tab.id;
    saveOpenTabs();
    renderTabs(); renderMsgs(); renderAttach(); renderStatus();
    try { inputEl?.focus(); } catch (_) {}
    return tab;
}

function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (activeId === id) activeId = tabs.length ? tabs[Math.max(0, i - 1)].id : null;
    if (!tabs.length) { void createTab(); }
    saveOpenTabs();
    renderTabs(); renderMsgs(); renderAttach(); renderStatus();
}

async function renameTab(id, title) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const res = await jfetch("/settings_hub/chat/session/" + id, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: String(title || "") }),
    });
    if (res.json?.ok) { tab.title = res.json.session.title || ""; renderTabs(); }
    else localToast("Rename failed: " + (res.json?.error || "HTTP " + res.status));
}

function setActive(id) {
    if (activeId === id) return;
    activeId = id;
    saveOpenTabs();
    renderTabs(); renderMsgs(); renderAttach(); renderStatus();
}

let tabEdit = null; // {mode:"create"|"rename", id?}
let tabArm = null, tabArmTs = 0;
const TAB_ARM_MS = 2600;

function renderTabs() {
    if (!tabEl) return;
    if (tabEdit) {
        tabEl.innerHTML = `<span class="hub-chat-tab hub-chat-tab-edit">` +
            `<input type="text" class="hub-chat-tab-input" spellcheck="false" ` +
            `placeholder="${tabEdit.mode === "rename" ? "new name" : "new chat"}" ` +
            `value="${tabEdit.mode === "rename" ? esc(tabEdit.value ?? "") : ""}">` +
            `</span>`;
        return;
    }
    const armId = tabArm;
    tabEl.innerHTML = tabs.map((t) =>
        `<span class="hub-chat-tab${t.id === activeId ? " hub-chat-tab-on" : ""}" ` +
        `data-tab="${t.id}" title="${esc(t.title || "New chat")} - double-click to rename">` +
        `<span class="hub-chat-tab-title">${esc(t.title || "New chat")}</span>` +
        `<button type="button" class="hub-chat-tab-x${armId === t.id ? " hub-chat-tab-x-armed" : ""}" ` +
        `title="Close the tab (the dialog stays in 🕘)">✕</button>` +
        `</span>`).join("") +
        `<button type="button" class="hub-chat-tab-add" title="New chat">＋</button>`;
}

// ---------------------------------------------------------------------------
// Header sessions popup (🕘): reopen / delete saved dialogs
// ---------------------------------------------------------------------------

let sessPop = null;

function closeSessPop() {
    try { sessPop?.remove(); } catch (_) {}
    sessPop = null;
    try { window.removeEventListener("mousedown", onSessPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onSessPopKey, true); } catch (_) {}
}

function onSessPopDown(e) {
    if (!sessPop || sessPop.contains(e.target) || e.target === sessionsBtn ||
        sessionsBtn?.contains?.(e.target)) return;
    closeSessPop();
}
function onSessPopKey(e) {
    if (e.key === "Escape" && sessPop) { e.preventDefault(); closeSessPop(); }
}

async function openSessPop() {
    if (sessPop) { closeSessPop(); return; }
    const res = await jfetch("/settings_hub/chat/sessions");
    if (!res.json?.ok) { localToast("Sessions unavailable: " + (res.json?.error || "HTTP " + res.status)); return; }
    const list = res.json.sessions || [];
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-chat-sessions";
    pop.innerHTML = `<div class="hub-menu-title">🕘 Saved chats</div>` +
        (list.length ? list.map((s) => {
            const open = tabs.some((t) => t.id === s.id);
            const armed = sessArm === s.id && Date.now() - sessArmTs <= SESS_ARM_MS;
            return `<div class="hub-chat-sess${s.id === activeId ? " hub-chat-sess-on" : ""}" data-sid="${s.id}">` +
                `<span class="hub-chat-sess-title">${esc(s.title || "(untitled)")}</span>` +
                `<span class="hub-chat-sess-n">${s.n} msg · ${new Date((s.updated || 0) * 1000)
                    .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` +
                (open ? `<span class="hub-chat-sess-open" title="This dialog is open in a tab">●</span>` : "") +
                `<button type="button" class="hub-chat-sess-del${armed ? " hub-chat-sess-del-armed" : ""}" ` +
                `title="${armed ? "Click again to DELETE the dialog with its files" : "Delete the dialog (asks twice)"}">🗑</button>` +
                `</div>`;
        }).join("") : `<div class="hub-chat-sess-empty">No saved chats yet</div>`);
    document.body.appendChild(pop);
    const r = sessionsBtn?.getBoundingClientRect?.();
    if (r) {
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        pop.style.left = Math.max(8, Math.min(r.left, vw - (pop.offsetWidth || 300) - 8)) + "px";
        pop.style.top = Math.min(r.bottom + 6, vh - (pop.offsetHeight || 200) - 8) + "px";
    }
    sessPop = pop;
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    pop.addEventListener("click", async (e) => {
        const del = e.target?.closest?.(".hub-chat-sess-del");
        const row = e.target?.closest?.(".hub-chat-sess");
        if (del && row) {
            const sid = row.dataset.sid;
            if (sessArm === sid && Date.now() - sessArmTs <= SESS_ARM_MS) {
                await jfetch("/settings_hub/chat/session/" + sid, { method: "DELETE" });
                if (tabs.some((t) => t.id === sid)) closeTab(sid);
                sessArm = null;
                closeSessPop();
                void openSessPop(); // refresh the list
                return;
            }
            sessArm = sid; sessArmTs = Date.now();
            closeSessPop();          // allow the re-render below to rebuild
            void openSessPop();     // re-render with the armed state
            localToast("Click 🗑 again to DELETE this dialog (files included)");
            return;
        }
        if (row) {
            const sid = row.dataset.sid;
            closeSessPop();
            const already = tabs.find((t) => t.id === sid);
            if (already) { setActive(sid); return; }
            const res2 = await jfetch("/settings_hub/chat/session/" + sid);
            const sess = res2.json?.session;
            if (!res2.ok || !sess) { localToast("Could not open: " + (res2.json?.error || "HTTP " + res2.status)); return; }
            const tab = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], pending: [] };
            tabs.push(tab);
            activeId = tab.id;
            saveOpenTabs();
            renderTabs(); renderMsgs(); renderAttach(); renderStatus();
        }
    });
    window.addEventListener("mousedown", onSessPopDown, true);
    window.addEventListener("keydown", onSessPopKey, true);
}

// ---------------------------------------------------------------------------
// Status line + degraded/config notes
// ---------------------------------------------------------------------------

function setStatusErr(msg) {
    if (!statusEl) return;
    statusEl.classList.add("hub-chat-status-err");
    statusEl.textContent = msg;
}

function renderStatus() {
    if (!statusEl) return;
    statusEl.classList.remove("hub-chat-status-err");
    const tab = activeTab();
    let last = "";
    if (tab && tab.msgs.length) {
        const a = [...tab.msgs].reverse().find((m) => m.role === "assistant");
        if (a) {
            const bits = [];
            if (a.usage?.completion_tokens) bits.push(a.usage.completion_tokens + " tok");
            if (a.ms) bits.push((a.ms / 1000).toFixed(1) + " s");
            if (a.stopped) bits.push("stopped");
            if (a.model) bits.push(a.model);
            last = bits.length ? " · last: " + bits.join(", ") : "";
        }
    }
    statusEl.textContent = (cfg?.url || "no LLM server") + " · " +
        (cfg?.model || "(no model)") + last;
}

function noteDegraded(d) {
    degraded = d;
    renderNote();
}

function renderNote() {
    if (!noteEl) return;
    if (degraded) {
        const why = {
            missing: "the chat py routes are missing - update the FULL pack and RESTART ComfyUI",
            http: "the chat backend answered with an error",
            nowrite: "the storage folder is NOT writable",
            create: "could not create a chat session",
        }[degraded.code] || "chat backend problem";
        noteEl.style.display = "";
        noteEl.className = "hub-chat-note";
        noteEl.innerHTML = `<div class="hub-chat-note-head">⚠ Chat storage problem</div>` +
            `<div class="hub-chat-note-why">${esc(why)}${degraded.why ? " - " + esc(degraded.why) : ""}</div>` +
            `<button type="button" class="hub-chat-note-retry" title="Probe the backend again">check again</button>`;
        return;
    }
    if (serverState && serverState.configured === false) {
        noteEl.style.display = "";
        noteEl.className = "hub-chat-note hub-chat-note-ok";
        noteEl.innerHTML = `<div class="hub-chat-note-head">No LLM server configured</div>` +
            `<div class="hub-chat-note-why">Open ⚙ Hub settings → Chat and set the server URL ` +
            `(e.g. http://127.0.0.1:8080/v1 for a local PolyStrata server), then press [Test].</div>`;
        return;
    }
    noteEl.style.display = "none";
    noteEl.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Markdown-lite rendering (escaping first - no raw HTML from the model)
// ---------------------------------------------------------------------------

function mdInline(t) {
    let s = esc(t);
    s = s.replace(/`([^`\n]+)`/g, (m, c) => `<code class="hub-chat-icode">${c}</code>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]\n]{1,80})\]\((https?:[^)\s]{1,300})\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s>])(https?:\/\/[^\s<]{4,200})/g,
        '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\n/g, "<br>");
    return s;
}

function mdLite(src) {
    const parts = String(src || "").split("```");
    let html = "";
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            const block = parts[i];
            const nl = block.indexOf("\n");
            const lang = nl >= 0 ? block.slice(0, nl).trim() : "";
            const code = (nl >= 0 ? block.slice(nl + 1) : block).replace(/\n$/, "");
            html += `<div class="hub-chat-code"><div class="hub-chat-code-head">` +
                `<span>${esc(lang || "code")}</span>` +
                `<button type="button" class="hub-chat-code-copy" data-code-copy="1" title="Copy the code">📋</button>` +
                `</div><pre><code>${esc(code)}</code></pre></div>`;
        } else {
            html += mdInline(parts[i]);
        }
    }
    return html;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function partsHtml(msg) {
    const parts = msg.parts || [];
    if (!parts.length) return "";
    return `<div class="hub-chat-msg-parts">` + parts.map((p, i) => {
        const orig = esc(p.orig || p.name || "file");
        if (p.kind === "image") {
            return `<span class="hub-chat-thumb" data-part="${i}" title="${orig} - click to view">` +
                `<img src="${esc(fileUrl(msg._sid || activeId, p.name))}" alt="${orig}" loading="lazy">` +
                `<button type="button" class="hub-chat-thumb-view" data-part="${i}" title="View large (🔍)">🔍</button></span>`;
        }
        const ico = p.kind === "video" ? "🎬" : p.kind === "audio" ? "🎵" : "📄";
        return `<span class="hub-chat-filechip" data-part="${i}" title="${orig} - click to view">` +
            `<span>${ico}</span><span class="hub-chat-filechip-name">${orig}</span>` +
            `<span class="hub-chat-filechip-size">${fmtBytes(p.size)}</span>` +
            `<button type="button" class="hub-chat-thumb-view" data-part="${i}" title="View (🔍)">🔍</button></span>`;
    }).join("") + `</div>`;
}

function bubbleHtml(msg, idx, sid) {
    const role = msg.role === "assistant" ? "Model" : "You";
    const m = { ...msg, _sid: sid };
    const meta = [];
    if (msg.usage?.completion_tokens) meta.push(msg.usage.completion_tokens + " tok");
    if (msg.ms) meta.push((msg.ms / 1000).toFixed(1) + " s");
    if (msg.stopped) meta.push("stopped");
    const acts = [];
    acts.push(`<button type="button" class="hub-chat-mact" data-act="copy" data-i="${idx}" title="Copy the text">📋</button>`);
    if (msg.role === "user") {
        acts.push(`<button type="button" class="hub-chat-mact" data-act="edit" data-i="${idx}" title="Edit and re-send (cuts everything after it)">✎</button>`);
    }
    const editing = editState && editState.idx === idx && msg.role === "user";
    const body = editing
        ? `<div class="hub-chat-edit">` +
          `<textarea class="hub-chat-edit-ta" rows="3">${esc(msg.text || "")}</textarea>` +
          `<span class="hub-chat-edit-acts">` +
          `<button type="button" class="hub-chat-edit-send" data-act="edit-send" data-i="${idx}" title="Re-send (the tail after this message is cut)">▶ re-send</button>` +
          `<button type="button" class="hub-chat-edit-cancel" data-act="edit-cancel" title="Cancel the edit">cancel</button>` +
          `</span></div>`
        : `<div class="hub-chat-msg-body">${mdLite(msg.text)}</div>`;
    return `<div class="hub-chat-msg hub-chat-msg-${msg.role === "assistant" ? "assistant" : "user"}" data-i="${idx}">` +
        `<div class="hub-chat-msg-head">` +
        `<span class="hub-chat-msg-role">${role}</span>` +
        (meta.length ? `<span class="hub-chat-msg-meta">${esc(meta.join(", "))}</span>` : "") +
        `<span class="hub-chat-msg-acts">${acts.join("")}</span>` +
        `</div>` +
        (msg.thoughts ? `<div class="hub-chat-think">` +
            `<button type="button" class="hub-chat-think-t" title="Show / hide the reasoning">💭 thinking ▸</button>` +
            `<div class="hub-chat-think-b" style="display:none">${mdLite(msg.thoughts)}</div></div>` : "") +
        body +
        partsHtml(m) +
        `</div>`;
}

function renderMsgs() {
    if (!msgsEl) return;
    const tab = activeTab();
    const sid = tab?.id || "";
    if (!tab) { msgsEl.innerHTML = ""; return; }
    msgsEl.innerHTML = tab.msgs.map((m, i) => bubbleHtml(m, i, sid)).join("") +
        (tab.msgs.length ? "" : `<div class="hub-chat-empty">Say something - the model answers here.<br>` +
            `📎 attaches an image (vision), 🎞 a video or a text file.</div>`);
    patchRegenButtons();
    msgsEl.scrollTop = msgsEl.scrollHeight;
}

// regenerate button only on the LAST assistant message - computed over the
// rendered list (bubbleHtml is per-message), patched here after the map.
function patchRegenButtons() {
    if (!msgsEl) return;
    const tab = activeTab();
    if (!tab) return;
    let lastA = -1;
    tab.msgs.forEach((m, i) => { if (m.role === "assistant") lastA = i; });
    msgsEl.querySelectorAll(".hub-chat-msg").forEach((el) => {
        const i = parseInt(el.dataset.i, 10);
        const msg = tab.msgs[i];
        if (!msg) return;
        if (msg.role === "assistant" && i === lastA && !streaming) {
            if (!el.querySelector('[data-act="regen"]')) {
                const span = el.querySelector(".hub-chat-msg-acts");
                if (span) span.insertAdjacentHTML("beforeend",
                    `<button type="button" class="hub-chat-mact" data-act="regen" data-i="${i}" title="Regenerate this answer">↻</button>`);
            }
        } else {
            el.querySelector('[data-act="regen"]')?.remove();
        }
    });
}

// ---------------------------------------------------------------------------
// Chat viewer (reuses the stack viewer classes for the identical look)
// ---------------------------------------------------------------------------

function onViewerKey(e) {
    if (e.key === "Escape" && viewerEl) {
        e.preventDefault();
        e.stopPropagation();
        closeViewer();
    }
}

function closeViewer() {
    try {
        viewerEl?.querySelectorAll("video, audio").forEach((v) => { try { v.pause(); } catch (_) {} });
        viewerEl?.remove();
    } catch (_) {}
    viewerEl = null;
    try { window.removeEventListener("keydown", onViewerKey, true); } catch (_) {}
}

async function openChatViewer(tab, part) {
    if (!part || !tab) return null;
    const seq = ++initSeq;
    closeViewer();
    const src = fileUrl(tab.id, part.name);
    const kind = part.kind || "file";
    const ico = kind === "image" ? "🖼" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "📄";
    const ext = extOf(part.orig || part.name);
    const isText = kind === "file" && TEXT_EXT_OK.has(ext);
    const v = document.createElement("div");
    v.className = "hub-stack-viewer hub-stack-viewer-media";
    v.innerHTML =
        `<div class="hub-stack-viewer-card hub-stack-viewer-card-media">` +
        `<div class="hub-stack-viewer-head">` +
        `<span class="hub-stack-viewer-ico">${ico}</span>` +
        `<span class="hub-stack-viewer-title" title="${esc(part.orig || "")}">${esc(part.orig || part.name || "Attachment")}</span>` +
        `<span class="hub-stack-viewer-n hub-stack-viewer-meta"></span>` +
        ((kind === "image" || isText)
            ? `<button type="button" class="hub-btn hub-stack-viewer-copy" title="${kind === "image" ? "Copy the image back to the clipboard" : "Copy the text content"}">📋 copy</button>`
            : "") +
        `<button type="button" class="hub-btn hub-stack-viewer-x" title="Close (Esc)">✕</button>` +
        `</div>` +
        `<div class="hub-stack-viewer-stage"></div>` +
        `</div>`;
    document.body.appendChild(v);
    viewerEl = v;
    const stage = v.querySelector(".hub-stack-viewer-stage");
    const metaEl = v.querySelector(".hub-stack-viewer-meta");
    if (kind === "image") {
        const img = document.createElement("img");
        img.src = src;
        img.alt = part.orig || "";
        img.className = "hub-chat-view-img";
        stage.appendChild(img);
        let zoom = 1;
        img.addEventListener("wheel", (e) => {
            e.preventDefault();
            zoom = Math.min(8, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            img.style.transform = "scale(" + zoom + ")";
        }, { passive: false });
        img.addEventListener("dblclick", () => { zoom = 1; img.style.transform = ""; });
        img.addEventListener("load", () => {
            metaEl.textContent = img.naturalWidth + "×" + img.naturalHeight + " · wheel zoom, dblclick resets";
        });
        v.querySelector(".hub-stack-viewer-copy")?.addEventListener("click", async () => {
            try {
                const blob = await (await fetch(src)).blob();
                await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
                localToast("Copied the image to the clipboard");
            } catch (_) { localToast("Copy failed"); }
        });
    } else if (kind === "video" || kind === "audio") {
        const el = document.createElement(kind === "video" ? "video" : "audio");
        el.src = src;
        el.controls = true;
        if (kind === "video") { el.autoplay = true; el.muted = true; el.className = "hub-chat-view-video"; }
        stage.appendChild(el);
    } else if (isText) {
        const pre = document.createElement("pre");
        pre.className = "hub-chat-view-text";
        stage.appendChild(pre);
        try {
            const r = await fetch(src);
            let t = await r.text();
            if (t.length > 300 * 1024) t = t.slice(0, 300 * 1024) + "\n… (preview truncated at 300 KB)";
            pre.textContent = t;
            metaEl.textContent = t.length.toLocaleString() + " chars";
            v.querySelector(".hub-stack-viewer-copy")?.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(pre.textContent);
                    localToast("Copied");
                } catch (_) { localToast("Copy failed"); }
            });
        } catch (_) { pre.textContent = "(preview failed)"; }
    } else {
        stage.innerHTML = `<div class="hub-chat-view-nobin">binary file - no inline preview.<br>` +
            `Download: <a href="${esc(src)}" download="${esc(part.orig || part.name)}">${esc(part.orig || part.name)}</a></div>`;
    }
    v.addEventListener("mousedown", (e) => { if (e.target === v) closeViewer(); });
    v.querySelector(".hub-stack-viewer-x")?.addEventListener("click", closeViewer);
    window.addEventListener("keydown", onViewerKey, true);
    return v;
}

// ---------------------------------------------------------------------------
// Attachments (pending chips above the input)
// ---------------------------------------------------------------------------

/** Returns { blob, resized } - resized=false means the ORIGINAL file comes
 *  back (decode failure/timeout) so the caller must NOT rename it to .jpg. */
async function shrinkImage(file, maxSide, quality) {
    try {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((res, rej) => {
                const i = new Image();
                // 700ms decode cap: a real browser decodes in well under that;
                // a stalled decode (old jsdom, exotic format) falls back to
                // uploading the ORIGINAL file - never a hang.
                const to = setTimeout(() => rej(new Error("image decode timeout")), 700);
                i.onload = () => { clearTimeout(to); res(i); };
                i.onerror = () => { clearTimeout(to); rej(new Error("decode failed")); };
                i.src = url;
            });
            const ow = img.naturalWidth || 1, oh = img.naturalHeight || 1;
            const scale = Math.min(1, (maxSide || 1024) / Math.max(ow, oh));
            const w = Math.max(1, Math.round(ow * scale)), h = Math.max(1, Math.round(oh * scale));
            const cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            cv.getContext("2d").drawImage(img, 0, 0, w, h);
            const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", quality || 0.9));
            if (blob) return { blob, resized: true };
        } finally {
            try { URL.revokeObjectURL(url); } catch (_) {}
        }
    } catch (_) {}
    return { blob: file, resized: false }; // jsdom / decode failure - upload as-is
}

async function uploadBlob(sid, blob, kind, origName) {
    try {
        const buf = await blob.arrayBuffer();
        const r = await app.api.fetchApi(
            "/settings_hub/chat/attach?session=" + encodeURIComponent(sid) +
            "&kind=" + encodeURIComponent(kind) +
            "&name=" + encodeURIComponent(origName || "file"),
            { method: "POST", body: buf });
        const j = r ? await r.json().catch(() => null) : null;
        if (!r || !r.ok || !j?.ok) {
            localToast("Attach failed: " + (j?.error || "HTTP " + (r ? r.status : "?")));
            return null;
        }
        return j;
    } catch (e) {
        localToast("Attach failed: " + e);
        return null;
    }
}

async function addFiles(fileList) {
    const tab = activeTab();
    if (!tab || !fileList) return;
    const files = Array.from(fileList).slice(0, 8);
    for (const f of files) {
        const ext = extOf(f.name);
        const isImg = IMG_EXT_OK.has(ext) || String(f.type || "").startsWith("image/");
        const isVid = !isImg && (VID_EXT_OK.has(ext) || String(f.type || "").startsWith("video/"));
        if (isImg) {
            const n = tab.pending.filter((p) => p.kind === "image").length;
            if (n >= (cfg?.img_max_count ?? 4)) {
                localToast("Too many images on one message (limit " + (cfg?.img_max_count ?? 4) + ")");
                continue;
            }
            const { blob, resized } = await shrinkImage(f, cfg?.img_max_side ?? 1024, 0.9);
            // only a REALLY re-encoded image may be renamed to .jpg - the
            // decode-fallback bytes are still whatever the owner dropped in
            const upName = resized ? f.name.replace(/\.[^.]+$/, "") + ".jpg" : f.name;
            const up = await uploadBlob(tab.id, blob, "image", upName);
            if (up) {
                tab.pending.push({ kind: "image", name: up.name, orig: up.orig, size: up.size, url: fileUrl(tab.id, up.name) });
            }
        } else if (isVid) {
            if (serverState && serverState.has_ffmpeg === false) {
                localToast("ffmpeg not found on the ComfyUI server - video is unavailable");
                continue;
            }
            const up = await uploadBlob(tab.id, f, "video", f.name);
            if (up) {
                tab.pending.push({ kind: "video", name: up.name, orig: up.orig, size: up.size });
            }
        } else {
            const up = await uploadBlob(tab.id, f, "file", f.name);
            if (up) {
                tab.pending.push({ kind: "file", name: up.name, orig: up.orig, size: up.size, text: TEXT_EXT_OK.has(ext) });
            }
        }
    }
    renderAttach();
}

function renderAttach() {
    if (!attachEl) return;
    const tab = activeTab();
    const list = tab?.pending || [];
    if (!list.length) { attachEl.style.display = "none"; attachEl.innerHTML = ""; return; }
    attachEl.style.display = "";
    attachEl.innerHTML = list.map((p, i) => {
        const inner = p.kind === "image"
            ? `<img src="${esc(p.url || "")}" alt="">`
            : `<span class="hub-chat-atch-ico">${p.kind === "video" ? "🎬" : "📄"}</span>`;
        return `<span class="hub-chat-atch" data-i="${i}" title="${esc(p.orig || "")}">` +
            inner +
            `<span class="hub-chat-atch-name">${esc(p.orig || "")}</span>` +
            (p.kind !== "image" ? `<span class="hub-chat-atch-size">${fmtBytes(p.size)}</span>` : "") +
            `<button type="button" class="hub-chat-atch-view" data-act="atch-view" data-i="${i}" title="View (🔍)">🔍</button>` +
            `<button type="button" class="hub-chat-atch-del" data-act="atch-del" data-i="${i}" title="Remove">✕</button>` +
            `</span>`;
    }).join("");
}

function clearPending() {
    const tab = activeTab();
    if (tab) tab.pending = [];
    renderAttach();
}

// ---------------------------------------------------------------------------
// Header model dropdown
// ---------------------------------------------------------------------------

let models = [];

async function fillModels(manual) {
    const res = await testChatServer();
    if (res.ok) {
        models = Array.isArray(res.models) ? res.models : [];
        if (res.current && !models.includes(res.current)) models.unshift(res.current);
        if (cfg?.model && !models.includes(cfg.model)) models.unshift(cfg.model);
        renderModelSel();
        renderNote();
        degraded = null; renderNote();
        if (manual) localToast("Models: " + (models.join(", ") || "(none)"));
    } else if (manual) {
        localToast("Model list failed: " + (res.error || "?"));
    }
    return res;
}

function renderModelSel() {
    if (!modelSel) return;
    const cur = cfg?.model || "";
    const opts = [];
    if (!models.length) {
        opts.push(`<option value="${esc(cur)}">${cur ? esc(cur) : "(no model - [Test] in ⚙ → Chat)"}</option>`);
    } else {
        if (cur && !models.includes(cur)) opts.push(`<option value="${esc(cur)}">${esc(cur)} (not in /models)</option>`);
        for (const m of models) {
            opts.push(`<option value="${esc(m)}"${m === cur ? " selected" : ""}>${esc(m)}</option>`);
        }
    }
    modelSel.innerHTML = opts.join("");
}

// ---------------------------------------------------------------------------
// Send / stream / stop
// ---------------------------------------------------------------------------

let editState = null; // {idx} - the user message being edited
let refreshT = null;

function refreshSessionSoon(sid, delay = 900) {
    clearTimeout(refreshT);
    refreshT = setTimeout(async () => {
        const tab = tabs.find((t) => t.id === sid);
        if (!tab) return;
        const res = await jfetch("/settings_hub/chat/session/" + sid);
        if (res.json?.ok) applySession(tab, res.json.session);
    }, delay);
}

async function readStream(r, onEvent) {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of raw.split("\n")) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const data = t.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                    const ev = JSON.parse(data);
                    onEvent?.(ev);
                } catch (_) {}
            }
        }
    }
}

function toggleThink(btn) {
    const box = btn?.closest?.(".hub-chat-think");
    if (!box) return;
    const body = box.querySelector(".hub-chat-think-b");
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "";
    btn.textContent = open ? "💭 thinking ▸" : "💭 thinking ▾";
}

function setBusy(b) {
    if (!sendBtn) return;
    sendBtn.textContent = b ? "⏹" : "▶";
    sendBtn.classList.toggle("hub-chat-send-stop", !!b);
    sendBtn.title = b ? "Stop the generation (the partial answer is kept)" : "Send (Enter)";
    patchRegenButtons();
}

function ensureStreamBubble() {
    let el = msgsEl.querySelector(".hub-chat-msg-streaming");
    if (!el) {
        msgsEl.insertAdjacentHTML("beforeend",
            `<div class="hub-chat-msg hub-chat-msg-assistant hub-chat-msg-streaming" data-i="live">` +
            `<div class="hub-chat-msg-head"><span class="hub-chat-msg-role">Model</span>` +
            `<span class="hub-chat-msg-meta">generating…</span></div>` +
            `<div class="hub-chat-think" style="display:none">` +
            `<button type="button" class="hub-chat-think-t">💭 thinking ▸</button>` +
            `<div class="hub-chat-think-b" style="display:none"></div></div>` +
            `<div class="hub-chat-msg-body"></div></div>`);
        el = msgsEl.querySelector(".hub-chat-msg-streaming");
        el.querySelector(".hub-chat-think-t")?.addEventListener("click", (e) => toggleThink(e.currentTarget));
    }
    return el;
}

function updateStreamBubble() {
    if (!msgsEl || !streaming) return;
    const el = ensureStreamBubble();
    el.querySelector(".hub-chat-msg-body").innerHTML =
        mdLite(streaming.text || (streaming.thoughts ? "" : "…"));
    if (streaming.thoughts) {
        const th = el.querySelector(".hub-chat-think");
        th.style.display = "";
        th.querySelector(".hub-chat-think-b").innerHTML = mdLite(streaming.thoughts);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function sendCurrent(opts = {}) {
    const tab = activeTab();
    if (!tab || !panel) return;
    if (streaming) { localToast("Already generating - press ⏹ to stop first"); return; }
    const text = (inputEl?.value || "").trim();
    const isEdit = opts.editIndex != null;
    const isRegen = !!opts.regenerate;
    if (!isEdit && !isRegen && !text && !tab.pending.length) return;
    if (!cfg?.url) {
        setStatusErr("No LLM server configured - ⚙ Hub settings → Chat");
        localToast("No LLM server configured - open ⚙ Hub settings → Chat");
        return;
    }
    const wantStream = !!(cfg?.stream ?? true);
    setBusy(true);
    if (isEdit) editState = null;
    try {
        const body = { session: tab.id, stream: wantStream };
        if (isEdit) {
            body.edit_index = opts.editIndex;
            body.text = opts.editText ?? text;
        } else if (isRegen) {
            body.regenerate = true;
        } else {
            body.text = text;
            body.attachments = tab.pending.map((p) => ({
                kind: p.kind, name: p.name, orig: p.orig, size: p.size,
            }));
        }
        const ctrl = new AbortController();
        streaming = { ctrl, sid: tab.id, text: "", thoughts: "" };
        const r = await app.api.fetchApi("/settings_hub/chat/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!r) throw new Error("no response from the chat backend");
        let ct = "";
        try { ct = r.headers?.get?.("content-type") || ""; } catch (_) {}
        if (wantStream && ct.includes("text/event-stream") && r.body && r.body.getReader) {
            renderMsgs(); // the history without the live bubble
            let fin = null;
            await readStream(r, (ev) => {
                if (ev.delta) { streaming.text += ev.delta; updateStreamBubble(); }
                else if (ev.thoughts) { streaming.thoughts += ev.thoughts; updateStreamBubble(); }
                else if (ev.error) setStatusErr(ev.error);
                else if (ev.done && ev.reply) fin = ev;
            });
            if (fin?.reply?.session) applySession(tab, fin.reply.session);
            else refreshSessionSoon(tab.id, 300);
        } else {
            const j = await r.json().catch(() => null);
            if (!r.ok || !j?.ok) throw new Error(j?.error || "HTTP " + (r.status || "?"));
            applySession(tab, j.session);
        }
        if (!isEdit && !isRegen) {
            if (inputEl) { inputEl.value = ""; autoGrow(); }
            clearPending();
        }
    } catch (e) {
        if (e?.name === "AbortError") {
            localToast("Stopped - the partial answer is kept");
        } else {
            setStatusErr(String(e?.message || e));
            localToast("Send failed: " + String(e?.message || e));
        }
        refreshSessionSoon(tab.id); // the server truth wins (it saved the user msg)
    } finally {
        streaming = null;
        setBusy(false);
        renderMsgs();
    }
}

function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}

// ---------------------------------------------------------------------------
// buildDom / initChat / teardown
// ---------------------------------------------------------------------------

async function probeServer(seq) {
    const res = await jfetch("/settings_hub/chat/health");
    if (seq !== initSeq) return;
    if (!res.json || !res.json.ok) {
        serverState = null;
        noteDegraded({
            code: res.status === 404 ? "missing" : "http",
            why: res.json?.error || ("HTTP " + res.status),
        });
        return;
    }
    serverState = res.json;
    degraded = null;
    renderNote();
}

async function ensureConfig() {
    const res = await jfetch("/settings_hub/chat/config");
    if (res.json?.ok) {
        cfg = res.json.config;
        renderModelSel();
        renderStatus();
    }
}

function buildDom() {
    panel = document.createElement("div");
    panel.className = "hub-chat-panel";
    panel.style.zIndex = Z_PANEL;
    panel.innerHTML =
        `<div class="hub-chat-head" title="Drag to move">` +
        `<span class="hub-chat-ico">💬</span><span class="hub-chat-title">Chat</span>` +
        `<select class="hub-chat-model" title="Model - the list comes from the LLM server ([Test] in ⚙ → Chat refreshes it)"></select>` +
        `<span class="hub-chat-hspace"></span>` +
        `<button type="button" class="hub-btn hub-chat-sessions" title="Saved chats - reopen or delete">🕘</button>` +
        `<button type="button" class="hub-btn hub-chat-clear" title="Clear THIS chat (click twice to confirm)">🗑</button>` +
        `<button type="button" class="hub-btn hub-chat-min" title="Minimize to chip">–</button>` +
        // v86: no [✕] close button - the panel is dismissed only via
        // ⚙ Hub settings → Chat (the v75 stack contract).
        `</div>` +
        `<div class="hub-chat-note" style="display:none"></div>` +
        `<div class="hub-chat-tabs"></div>` +
        `<div class="hub-chat-msgs"></div>` +
        `<div class="hub-chat-attach" style="display:none"></div>` +
        `<div class="hub-chat-inputrow">` +
        `<button type="button" class="hub-chat-attachbtn" title="Attach an image (vision), a video or a text file">📎</button>` +
        `<textarea class="hub-chat-input" rows="1" placeholder="Message… (Enter - send, Shift+Enter - new line)"></textarea>` +
        `<button type="button" class="hub-chat-send" title="Send (Enter)">▶</button>` +
        `</div>` +
        `<div class="hub-chat-status"></div>` +
        `<div class="hub-chat-grip" title="Drag to resize"></div>` +
        `<input type="file" class="hub-chat-file" multiple style="display:none">`;
    document.body.appendChild(panel);

    chip = document.createElement("div");
    chip.className = "hub-chat-chip";
    chip.style.zIndex = Z_PANEL;
    chip.innerHTML = `💬`;
    chip.title = "Chat - click to open";
    chip.style.display = "none";
    document.body.appendChild(chip);

    headEl = panel.querySelector(".hub-chat-head");
    tabEl = panel.querySelector(".hub-chat-tabs");
    msgsEl = panel.querySelector(".hub-chat-msgs");
    attachEl = panel.querySelector(".hub-chat-attach");
    inputEl = panel.querySelector(".hub-chat-input");
    sendBtn = panel.querySelector(".hub-chat-send");
    statusEl = panel.querySelector(".hub-chat-status");
    noteEl = panel.querySelector(".hub-chat-note");
    grip = panel.querySelector(".hub-chat-grip");
    modelSel = panel.querySelector(".hub-chat-model");
    sessionsBtn = panel.querySelector(".hub-chat-sessions");

    // geometry
    const ui = lsUi();
    applyPos(ui.x ?? Math.max(16, (window.innerWidth || 1600) - 560), ui.y ?? 90);
    applySize(ui.w ?? DEF_W, ui.h ?? DEF_H);
    setMinimized(!!ui.min, false);
    refitIntoView();
    window.addEventListener("resize", onWinResize);

    // header
    panel.querySelector(".hub-chat-min").addEventListener("click", () => setMinimized(true));
    chip.addEventListener("click", () => setMinimized(false));
    panel.querySelector(".hub-chat-clear").addEventListener("click", (e) => panelClearAll(e.currentTarget));
    sessionsBtn.addEventListener("click", () => void openSessPop());
    modelSel.addEventListener("change", () => {
        const v = modelSel.value;
        if (!v) return;
        void applyChatSettings({ model: v }).then((res) => {
            if (res.ok) { localToast("Model: " + v); }
            else localToast("Model not applied: " + (res.error || "?"));
        });
    });
    makeDraggable(headEl, panel,
        () => ({ x: parseFloat(panel.style.left) || 0, y: parseFloat(panel.style.top) || 0 }),
        (x, y, persist) => {
            applyPos(x, y);
            if (persist) saveUi({ x, y });
        });

    // resize grip
    grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX, sy = e.clientY;
        const sw = panel.offsetWidth, sh = panel.offsetHeight;
        const move = (ev) => applySize(sw + (ev.clientX - sx), sh + (ev.clientY - sy));
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            applySize(sw + (ev.clientX - sx), sh + (ev.clientY - sy));
            saveUi({ w: panel.offsetWidth, h: panel.offsetHeight });
            refitIntoView();
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });

    // tabs
    tabEl.addEventListener("click", (e) => {
        if (e.target?.closest?.(".hub-chat-tab-add")) {
            tabEdit = { mode: "create" };
            renderTabs();
            try { tabEl.querySelector(".hub-chat-tab-input")?.focus(); } catch (_) {}
            return;
        }
        const x = e.target?.closest?.(".hub-chat-tab-x");
        if (x) {
            const id = x.closest?.(".hub-chat-tab")?.dataset.tab;
            if (id) closeTab(id);
            return;
        }
        if (tabEdit) return;
        const chipEl = e.target?.closest?.(".hub-chat-tab[data-tab]");
        if (chipEl) setActive(chipEl.dataset.tab);
    });
    tabEl.addEventListener("dblclick", (e) => {
        const chipEl = e.target?.closest?.(".hub-chat-tab[data-tab]");
        if (!chipEl) return;
        const tab = tabs.find((t) => t.id === chipEl.dataset.tab);
        tabEdit = { mode: "rename", id: chipEl.dataset.tab, value: tab?.title || "" };
        renderTabs();
        try {
            const inp = tabEl.querySelector(".hub-chat-tab-input");
            if (inp) { inp.focus(); inp.select(); }
        } catch (_) {}
    });
    tabEl.addEventListener("keydown", (e) => {
        const inp = e.target.closest?.(".hub-chat-tab-input");
        if (!inp) return;
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const v = inp.value.trim();
            if (tabEdit?.mode === "rename") void renameTab(tabEdit.id, v);
            else void createTab();
            tabEdit = null;
            renderTabs();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            tabEdit = null;
            renderTabs();
        }
    });

    // messages
    msgsEl.addEventListener("click", (e) => {
        const codeCopy = e.target.closest("[data-code-copy]");
        if (codeCopy) {
            const code = codeCopy.closest(".hub-chat-code")?.querySelector("code");
            void (async () => {
                try {
                    await navigator.clipboard.writeText(code?.textContent || "");
                    localToast("Code copied");
                } catch (_) { localToast("Copy failed"); }
            })();
            return;
        }
        if (e.target.closest(".hub-chat-think-t")) { toggleThink(e.target.closest(".hub-chat-think-t")); return; }
        const act = e.target.closest("[data-act]");
        if (!act) {
            const th = e.target.closest(".hub-chat-thumb, .hub-chat-filechip");
            if (th) {
                const tab = activeTab();
                const msgEl = th.closest(".hub-chat-msg");
                const i = parseInt(msgEl?.dataset.i, 10);
                const p = tab?.msgs[i]?.parts?.[parseInt(th.dataset.part, 10)];
                if (tab && p) void openChatViewer(tab, p);
            }
            return;
        }
        const tab = activeTab();
        if (!tab) return;
        const a = act.dataset.act;
        const i = parseInt(act.dataset.i, 10);
        const msg = tab.msgs[i];
        if (a === "copy") {
            void (async () => {
                try {
                    await navigator.clipboard.writeText(msg?.text || "");
                    localToast("Copied");
                } catch (_) { localToast("Copy failed"); }
            })();
        } else if (a === "regen") {
            if (msg?.role === "assistant") void sendCurrent({ regenerate: true });
        } else if (a === "edit") {
            if (msg?.role === "user") {
                editState = { idx: i };
                renderMsgs();
                try { msgsEl.querySelector(".hub-chat-edit-ta")?.focus(); } catch (_) {}
            }
        } else if (a === "edit-cancel") {
            editState = null;
            renderMsgs();
        } else if (a === "edit-send") {
            const ta = msgsEl.querySelector('.hub-chat-msg[data-i="' + i + '"] .hub-chat-edit-ta');
            void sendCurrent({ editIndex: i, editText: ta ? ta.value : msg?.text });
        }
    });

    // attachments row
    attachEl.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]");
        if (!act) return;
        const tab = activeTab();
        if (!tab) return;
        const i = parseInt(act.dataset.i, 10);
        if (act.dataset.act === "atch-del") {
            tab.pending.splice(i, 1);
            renderAttach();
        } else if (act.dataset.act === "atch-view") {
            const p = tab.pending[i];
            if (p) void openChatViewer(tab, p);
        }
    });

    // input
    sendBtn.addEventListener("click", () => {
        if (streaming) { try { streaming.ctrl.abort(); } catch (_) {} return; }
        void sendCurrent();
    });
    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (streaming) { localToast("Already generating - ⏹ stops it"); return; }
            void sendCurrent();
        }
    });
    inputEl.addEventListener("input", autoGrow);
    panel.querySelector(".hub-chat-attachbtn").addEventListener("click", () => {
        panel.querySelector(".hub-chat-file").click();
    });
    panel.querySelector(".hub-chat-file").addEventListener("change", (e) => {
        const files = e.target?.files;
        if (files && files.length) void addFiles(files);
        try { e.target.value = ""; } catch (_) {}
    });
    panel.addEventListener("paste", (e) => {
        const files = e.clipboardData?.files;
        if (files && files.length) {
            e.preventDefault();
            void addFiles(files);
        }
    });
    panel.addEventListener("dragover", (e) => { e.preventDefault(); });
    panel.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (files && files.length) void addFiles(files);
    });

    // the note's retry button
    noteEl.addEventListener("click", (e) => {
        if (!e.target?.closest?.(".hub-chat-note-retry")) return;
        const seq = ++initSeq;
        void (async () => {
            await probeServer(seq);
            if (seq !== initSeq) return;
            await ensureConfig();
        })();
    });
}

async function panelClearAll(btn) {
    const tab = activeTab();
    if (!tab) return;
    const now = Date.now();
    if (clearArm === tab.id && now - clearArmTs <= CLEAR_ARM_MS) {
        clearArm = null;
        try { btn?.classList?.remove("hub-chat-clear-armed"); } catch (_) {}
        await jfetch("/settings_hub/chat/session/" + tab.id + "/clear", { method: "POST" });
        tab.msgs = [];
        renderMsgs();
        renderStatus();
        localToast("Chat cleared");
        return;
    }
    clearArm = tab.id;
    clearArmTs = now;
    try { btn?.classList?.add("hub-chat-clear-armed"); } catch (_) {}
    localToast("Click 🗑 again to clear this chat");
    setTimeout(() => {
        if (clearArm === tab.id) {
            clearArm = null;
            try { btn?.classList?.remove("hub-chat-clear-armed"); } catch (_) {}
        }
    }, CLEAR_ARM_MS);
}

export function initChat() {
    if (!isChatOn()) return;
    teardown();
    const seq = ++initSeq; // capture AFTER teardown - teardown() bumps initSeq
    buildDom();
    mounted = true;
    void (async () => {
        await probeServer(seq);
        if (seq !== initSeq) return;
        await ensureConfig();
        if (seq !== initSeq) return;
        // restore the previously open tabs (the sessions live server-side)
        const ui = lsUi();
        const ids = Array.isArray(ui.tabs) ? ui.tabs.slice(0, 12) : [];
        for (const id of ids) {
            if (!/^[a-f0-9]{8,32}$/.test(String(id))) continue;
            const res = await jfetch("/settings_hub/chat/session/" + id);
            const sess = res.json?.session;
            if (res.ok && sess?.id) {
                tabs.push({ id: sess.id, title: sess.title || "", msgs: sess.messages || [], pending: [] });
                if (!activeId) activeId = sess.id;
            }
        }
        if (!tabs.length) {
            await createTab();
            if (seq !== initSeq) return;
        }
        if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0]?.id || null;
        saveOpenTabs();
        renderTabs();
        renderMsgs();
        renderAttach();
        renderStatus();
        if (cfg?.url) void fillModels(false);
    })();
}

function teardown() {
    initSeq++;
    clearTimeout(resizePersistT);
    resizePersistT = null;
    clearTimeout(refreshT);
    refreshT = null;
    try { streaming?.ctrl?.abort(); } catch (_) {}
    streaming = null;
    closeViewer();
    closeSessPop();
    try { panel?.remove(); } catch (_) {}
    try { chip?.remove(); } catch (_) {}
    try { window.removeEventListener("resize", onWinResize); } catch (_) {}
    panel = chip = headEl = tabEl = msgsEl = attachEl = inputEl = sendBtn = null;
    statusEl = noteEl = grip = modelSel = sessionsBtn = null;
    tabs = [];
    activeId = null;
    serverState = null;
    degraded = null;
    editState = null;
    mounted = false;
}

// ---------------------------------------------------------------------------
// Test hooks (smoke_chat.mjs) - not used by the app
// ---------------------------------------------------------------------------

export function __chatTestHooks() {
    return {
        panelEl: () => panel,
        chipEl: () => chip,
        tabsEl: () => tabEl,
        msgsEl: () => msgsEl,
        attachEl: () => attachEl,
        inputEl: () => inputEl,
        sendBtnEl: () => sendBtn,
        statusEl: () => statusEl,
        noteEl: () => noteEl,
        modelSelEl: () => modelSel,
        tabs: () => tabs.map((t) => ({ id: t.id, title: t.title, n: t.msgs.length, pending: t.pending.length })),
        tabById: (id) => tabs.find((t) => t.id === id) || null,
        activeId: () => activeId,
        setActive,
        createTab,
        closeTab,
        renameTab,
        openSessPop,
        closeSessPop,
        sessPopEl: () => sessPop,
        addFiles,
        clearPending,
        send: sendCurrent,
        stopStream: () => { try { streaming?.ctrl?.abort(); } catch (_) {} },
        streaming: () => (streaming ? { sid: streaming.sid, text: streaming.text, thoughts: streaming.thoughts } : null),
        mdLite,
        openViewer: openChatViewer,
        closeViewer,
        viewerEl: () => viewerEl,
        cfg: () => (cfg ? { ...cfg } : null),
        models: () => models.slice(),
        fillModels,
        probe: probeServer,
        setCfg: (c) => { cfg = c; },
        setServerState: (s) => { serverState = s; },
        mount: initChat,
        fireResize: onWinResize,
    };
}



