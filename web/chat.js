// ============================================================================
// SettingsHub - LLM Chat (v89): floating panel with TABS, OpenAI-compatible
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
// ----------------------------------------------------------------------------
// v89 (owner corrections 2026-11-09: "the chat settings are just fields
//   without names - you only learn what a value is from the tooltip - the
//   fields must have NAMES" + "display the used and the available context in
//   the chat" + "the saved-chat search must be flexible: multi-words, by the
//   chat title, the content or all together" + "the user must be able to set
//   his own system-prompts path" + "the system prompts list is unreadable -
//   many files all squished together" + "when the chat or the stack is hidden
//   the user may not know where to bring it back - the info that it is in the
//   ComfyUI settings must be there"):
//     * ⚙ CHAT SETTINGS: every number now sits under its own visible MINI
//       LABEL (a 2-column grid - temperature / top_p / max tokens / history
//       depth / media depth / image max side / images per msg / video frames
//       / video max side); the full explanation stays in the tooltip.
//     * CONTEXT FILL: every answer stores reply ctx {used, total, est} -
//       used = the upstream usage.prompt_tokens when reported (exact),
//       otherwise an estimate (chars/4 + 8/msg + 750/image, shown as "≈");
//       total = cfg "ctx_size" (a NEW ⚙ row, 0 = auto) or the PolyStrata
//       /v1/status context.native (probed + cached server-side). The status
//       line shows "ctx 3.2k/32k" (≈ when estimated, ⚠ past 90%); it
//       survives reloads because the assistant message carries it.
//     * 🕘 SEARCH: a live search row - multi-word (every word must hit),
//       matching the chat TITLE, the message CONTENT or both together;
//       each hit shows a snippet of the matching content line; the server
//       does the scan (GET /chat/sessions?q=).
//     * 📜 PROMPTS PATH: ⚙ gains a "System prompt catalog" section with a
//       "Prompts folder" row (Enter applies, [default] resets) - the owner's
//       own folder (absolute or ComfyUI-relative) replaces the PolyStrata
//       models/LLM/prompts for BOTH the listing and the per-send read.
//     * 📜 LIST FIX: .hub-cp-list is a flex COLUMN with max-height and the
//       items kept the default flex-shrink:1 - with more files than fit
//       EVERY item collapsed to a few px (the "squished" screenshot);
//       flex: 0 0 auto pins them and the list scrolls instead.
//     * THE WAY BACK: hiding the chat (⚙ → Off or the ComfyUI setting)
//       toasts "ComfyUI Settings → SettingsHub → 'LLM Chat panel'" - the
//       stack does the same; the ⚙ Off option names it too.
// ----------------------------------------------------------------------------
// v88 (owner corrections 2026-11-09: "the settingshub is not present in every
//   workflow and managing the stacker and chat from it is inconvenient - they
//   are SEPARATE useful utilities; how is it done right in ComfyUI?" + "I did
//   not ask you to invent prompt presets - the PolyStrata nodes have a
//   catalog of MY OWN prompts, the txt path is the same as the nodes', with a
//   refresh button and a live multi-word search" + "the model list shows only
//   ONE active model - look how the PolyStrata nodes get the models"):
//     * SELF-MANAGED PANEL: the hub no longer hosts the Chat On/Off - the
//       chat ⚙ popup gains a Panel On/Off row. v91: the ComfyUI-settings
//       switch moved into the MINI PANEL (web/launcher.js - "Mini panel
//       (SettingsHub)" + the item rows); the per-panel row is gone. That
//       dialog is reachable in EVERY workflow,
//       with or without a hub node - so a hidden panel can always be brought
//       back (the hub window used to be the only way back).
//     * 📜 SYSTEM PROMPT = THE USER'S CATALOG: no invented presets. The popup
//       lists the .txt files of ComfyUI/models/LLM/prompts (prompt_root() of
//       the PolyStrata nodes - the exact same folder, subdirs included), a
//       [↻] refresh re-scans it, a LIVE SEARCH filters it (multi-word: every
//       word must match the relative path), a click selects the file (stored
//       as cfg.prompt_preset - the server reads the file FRESH on every send
//       and the preset WINS over the custom text, exactly like the nodes'),
//       "none (custom text)" + the textarea + Save/Clear stay for a custom
//       prompt.
//     * MODEL DROPDOWN = THE FULL LIST: [model ▾] + [↻] now read the new
//       GET /chat/models, which tries /api/models FIRST - the PolyStrata
//       registry of ALL installed models with their statuses (the nodes'
//       way), then /v1/models, then /v1/status. Options show a status mark
//       (● loaded/current, ◐ loading, ○ available); selecting a not-loaded
//       registry model ALSO switches the server (POST /chat/load ->
//       /api/models/load - may take minutes, the chat keeps working).
// ----------------------------------------------------------------------------
// v87 (owner reports 2026-11-09: "all chat settings must live IN the chat,
//   the hub keeps only the show/hide switch" + "the model picker belongs
//   under the input as a dropdown with a refresh button - not a typed text
//   field! - and the thinking mode + system prompt must be at hand" + "the
//   system prompt opens in a small popup: presets or my own text" + "the
//   PolyStrata memory features: unload buttons for ComfyUI models + a VRAM
//   reservation for ComfyUI when a model loads in PolyStrata + a PolyStrata
//   unload button that returns the memory" + "the tab name I type must be
//   used" + "follow the browser page zoom"): ALL of it, in one pass:
//     * the TOOLBAR under the input: [model ▾] fed by /v1/models with a [↻]
//       refresh, [thinking ▾] (default/none/low/medium/high), [📜] system
//       prompt, [⚡] GPU & memory - the header keeps 🕘 🗑 ⚙ – only;
//     * [📜] opens the PROMPT popup: preset chips (concise, detailed,
//       programmer, translator, SD-prompt engineer) + a custom textarea -
//       a chip applies instantly, [Save] stores the custom text, [Clear]
//       wipes it ("empty = none");
//     * [⚡] opens the GPU popup (the v87 py /chat/gpu routes): live
//       loaded/free-VRAM picture, the VRAM RESERVE for ComfyUI (MiB input,
//       Apply / Release - the PolyStrata /v1/vram mechanics + the
//       ComfyUI EXTRA_RESERVED sync, and cfg.vram_reserve_mib > 0 is
//       re-applied by the SERVER before every send), [Unload model] (the
//       engine stops, ALL of its VRAM + the reservation come back),
//       [Load now] (/v1/load), [Free ComfyUI memory] (unload_all_models +
//       soft_empty_cache + gc - ComfyUI's own button); every action
//       prints its human note in the popup;
//     * [⚙] in the HEADER opens the CHAT SETTINGS popup (moved out of the
//       hub window): URL + key + [Test], sampling, depths, image/video
//       limits, stream, keep-chats, timeout, storage folder - the Enter
//       applies / Esc reverts contract, the same rows the hub used to
//       host. The hub ⚙ keeps ONLY the Chat On/Off switch;
//     * [＋] + a typed name + Enter creates the tab UNDER THAT NAME (the
//       title used to be dropped and fell back to the auto-title);
//     * PAGE ZOOM: a devicePixelRatio change (Ctrl +/-, ctrl-pinch) scales
//       the saved geometry (x/y/w/h/chip) by the zoom factor before the
//       usual refit, so the panel keeps its physical size and never drifts
//       off-screen (the stack does the same); the v87 settings popups are
//       viewport-clamped like the hub one.
// ============================================================================

// v87 self-report (single-source version, docs/plan-versions.md): the last
// FUNCTIONAL change of THIS file - no per-file build stamps anymore.
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["chat"] = "v91";

import { app } from "../../scripts/app.js";
// v90: the shared UI font scale - the chat ⚙ hosts the same row as the hub
// ⚙ and the stack ⚙ (one localStorage value, one CSS variable --sh-fs).
import { UI_FONT_SCALE_CHOICES, getUiFontScale, setUiFontScale, uiFontScaleLabel } from "./global_settings.js";
// v91: the MINI PANEL (launcher) - the collapse target of this panel and the
// home of the only SettingsHub rows in ComfyUI's Settings dialog.
import { launcherHostsMinimized, launcherSetCollapsed, registerLauncherPanel } from "./launcher.js";

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
let grip = null, modelSel = null, sessionsBtn = null, settingsBtn = null;
let thinkSel = null, promptBtn = null, gpuBtn = null, modelsBtn = null;
let tabs = [];            // open tabs: {id, title, msgs, pending:[part]}
let activeId = null;      // active tab session id
let streaming = null;     // {ctrl, sid}
let serverState = null;   // /chat/health result
let cfg = null;           // cached (masked) config from the server
let degraded = null;      // {code, why} - red note state
let viewerEl = null;      // chat viewer overlay
let clearArm = null, clearArmTs = 0, sessArm = null, sessArmTs = 0;
const CLEAR_ARM_MS = 2600, SESS_ARM_MS = 2600;
// v87 popups (single instance each, body-level fixed): settings ⚙, prompt 📜, GPU ⚡
let setPop = null, promptPop = null, gpuPop = null;
// v87 page-zoom tracking (devicePixelRatio changes with Ctrl +/- / ctrl-pinch)
let lastDpr = 0;
// v91: the native ComfyUI "LLM Chat panel" switch was REMOVED - the MINI
// PANEL (web/launcher.js) carries the only SettingsHub rows now.
// v88: the model list comes from GET /chat/models as {id, status} items
// (source registry = the PolyStrata /api/models registry)
let models = [];          // [{id, status}]
let modelsSource = "";    // registry | openai | status

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
        t.className = "hub-sh-note";   // v90: the modal guard hides it too
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
// Settings surface (⚙ in the chat header since v87; the hub hosts nothing)
// ---------------------------------------------------------------------------

export function isChatOn() {
    try { const v = localStorage.getItem(LS_ON); return v == null ? true : v === "1"; }
    catch (_) { return true; }
}

export function setChatOn(v, src) {
    const was = isChatOn();
    try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (_) {}
    // v91: the way back is the MINI PANEL (the launcher) - the old native
    // ComfyUI "LLM Chat panel" switch is GONE (the launcher rows replaced
    // the per-panel ones).
    // v89 contract kept: a hidden panel has NO ui of its own - always say
    // WHERE the way back is, whatever flipped it.
    if (was && !v) {
        localToast("Chat hidden - bring it back: the mini panel (💬 toggle) or ComfyUI Settings → SettingsHub → 'Mini panel'", 5200);
    }
    if (v && !mounted) initChat();
    else if (!v) teardown();
}

// v91: the native "LLM Chat panel" ComfyUI setting was REMOVED - the MINI
// PANEL (web/launcher.js) carries the only SettingsHub rows now: "Mini panel
// (SettingsHub)" + the item switches. The way back to a hidden chat is the
// launcher's 💬 toggle; the way back to a hidden launcher is the ComfyUI
// setting above. The old registerNativeChatSwitch is gone on purpose.

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

/** Probe the upstream LLM server through the proxy: the FULL model list
 *  (v88: /api/models registry first) + /v1/status when it answers.
 *  Resolves {ok, models, current, status, source, error}. */
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
    // v91 (owner #1): [–] collapses the chat INTO the mini panel when it is
    // shown and its chat item is visible; otherwise the historical own chip.
    const host = min && launcherHostsMinimized("chat");
    panel.style.display = min ? "none" : "";
    chip.style.display = (min && host) ? "none" : (min ? "" : "none");
    if (min) {
        closeAllChatPops();   // a popup must not outlive the window
        if (host) {
            launcherSetCollapsed("chat", true);
        } else {
            const ui = lsUi();
            applyChipPos(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16);
        }
    } else {
        launcherSetCollapsed("chat", false);
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
// v87: onWinResize (with the page-zoom geometry rescale) lives in the v87
// section below - it uses lastDpr + refitIntoView defined here.

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
    // v91: the branch tree travels with the session - the variant arrows
    // (‹ i/n ›) read it at render time.
    tab.tree = (sess.tree && typeof sess.tree === "object") ? sess.tree : null;
    if (tab.id === activeId) { renderTabs(); renderMsgs(); renderStatus(); }
}

/** v91 (owner 8a): sibling info of a message node - which variant is active
 *  and how many exist. The arrows switch the WHOLE visible path under the
 *  node (the answer branch follows its request). */
function variantInfo(tab, nid) {
    if (!tab || !nid || !tab.tree?.nodes) return null;
    const n = tab.tree.nodes[nid];
    if (!n || n.id === "__root__") return null;
    const p = n.parent ? tab.tree.nodes[n.parent] : null;
    if (!p) return null;
    const kids = p.children || [];
    if (kids.length < 2) return null;
    const i = kids.indexOf(nid);
    if (i < 0) return null;
    return { index: i, count: kids.length };
}

/** v91: switch to the prev/next variant of a message (POST /chat/branch). */
async function switchVariant(tab, nid, dir) {
    if (!tab || !nid) return;
    const res = await jfetch("/settings_hub/chat/branch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: tab.id, nid, dir }),
    });
    if (res.json?.ok) applySession(tab, res.json.session);
    else localToast("No variant in that direction");
}

/** v91 (owner 8b): delete a message WITH its subtree (armed two-click). */
const DEL_ARM_MS = 2600;
let delArm = null;   // {sid, nid, ts}

async function deleteMsg(tab, nid) {
    const res = await jfetch("/settings_hub/chat/session/" + tab.id + "/msg_delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nid }),
    });
    if (res.json?.ok) applySession(tab, res.json.session);
    else localToast("Delete failed: " + (res.json?.error || "HTTP " + res.status));
}

/** v91 (owner 8b): save an edited message text in place (the model's replies
 *  too; user edits that BRANCH go through /send edit_nid). */
async function saveMsgText(tab, nid, text) {
    const res = await jfetch("/settings_hub/chat/session/" + tab.id + "/msg", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nid, text }),
    });
    if (res.json?.ok) applySession(tab, res.json.session);
    else localToast("Save failed: " + (res.json?.error || "HTTP " + res.status));
}

/** v91 (owner 8c): a NEW chat from a selected message - the message and
 *  everything ABOVE it is copied into a fresh session (attachment blobs are
 *  copied server-side while the source chat exists). */
async function forkFromMessage(tab, idx) {
    if (!tab) return;
    const prefix = (tab.msgs || []).slice(0, idx + 1).map((m) => {
        const { nid, ...rest } = m;
        return rest;
    });
    if (!prefix.length) return;
    const res = await jfetch("/settings_hub/chat/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: ("Fork: " + (tab.title || "chat")).slice(0, 80),
            messages: prefix,
            copy_blobs_from: tab.id,
        }),
    });
    const sess = res.json?.session;
    if (res.json?.ok && sess?.id) {
        const nt = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], tree: sess.tree || null, pending: [] };
        tabs.push(nt);
        activeId = nt.id;
        saveOpenTabs();
        renderTabs(); renderMsgs(); renderAttach(); renderStatus();
        localToast("New chat created from this message");
    } else {
        localToast("Fork failed: " + (res.json?.error || "HTTP " + res.status));
    }
}

/** v91 (owner 8d): download the ACTIVE chat as JSON (messages + the branch
 *  tree). The browser builds the file - the proxy stays storage-only. */
function exportSession(tab) {
    if (!tab) { localToast("Open a chat first"); return; }
    try {
        const data = {
            app: "ComfyUI-Settings-Hub chat export",
            version: 1,
            exported: new Date().toISOString(),
            sid: tab.id,
            title: tab.title || "",
            messages: tab.msgs || [],
            tree: tab.tree || null,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "chat-" + String(tab.title || tab.id || "chat")
            .replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 4000);
        localToast("Chat exported (attachments live on the server - import them on the same install)");
    } catch (e) { localToast("Export failed: " + e); }
}

/** v91 (owner 8d): create a new chat from an exported JSON file. */
async function importSessionFile(file) {
    if (!file) return;
    let data = null;
    try { data = JSON.parse(await file.text()); } catch (_) { localToast("Not a valid chat export (JSON parse failed)"); return; }
    if (!data || !Array.isArray(data.messages)) { localToast("Not a chat export (no messages)"); return; }
    const res = await jfetch("/settings_hub/chat/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: String(data.title || "Imported chat").slice(0, 80),
            messages: data.messages,
            copy_blobs_from: String(data.sid || ""),
        }),
    });
    const sess = res.json?.session;
    if (res.json?.ok && sess?.id) {
        const nt = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], tree: sess.tree || null, pending: [] };
        tabs.push(nt);
        activeId = nt.id;
        saveOpenTabs();
        renderTabs(); renderMsgs(); renderAttach(); renderStatus();
        localToast("Chat imported" + (data.sid ? " - attachments restored when the source chat still exists" : ""));
    } else {
        localToast("Import failed: " + (res.json?.error || "HTTP " + res.status));
    }
}

async function createTab(title) {
    const res = await jfetch("/settings_hub/chat/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // v87: a typed name travels with the create - the owner names the
        // tab in the [＋] field and Enter must USE it (it used to fall
        // back to the auto-title from the first message).
        body: JSON.stringify({ title: String(title || "").slice(0, 80) }),
    });
    const sess = res.json?.session;
    if (!res.ok || !sess?.id) {
        // the probe note ("update the FULL pack and RESTART") is more
        // actionable than "could not create" - never overwrite it
        if (!degraded) noteDegraded({ code: "create", why: res.json?.error || ("HTTP " + res.status) });
        return null;
    }
    const tab = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], tree: sess.tree || null, pending: [] };
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
// v89: the saved-chats search - multi-word, by the title, the content or
// both together (the server scans, GET /chat/sessions?q=); kept while the
// popup re-renders.
let sessQuery = "";
let sessFetchSeq = 0;

function closeSessPop() {
    sessFetchSeq++;   // an in-flight render must not fill a closed popup
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

function sessRowHtml(s) {
    const open = tabs.some((t) => t.id === s.id);
    const armed = sessArm === s.id && Date.now() - sessArmTs <= SESS_ARM_MS;
    return `<div class="hub-chat-sess${s.id === activeId ? " hub-chat-sess-on" : ""}" data-sid="${s.id}">` +
        `<span class="hub-chat-sess-main">` +
        `<span class="hub-chat-sess-title">${esc(s.title || "(untitled)")}</span>` +
        (s.hit ? `<span class="hub-chat-sess-hit" title="${esc(s.hit)}">${esc(s.hit)}</span>` : "") +
        `</span>` +
        `<span class="hub-chat-sess-n">${s.n} msg · ${new Date((s.updated || 0) * 1000)
            .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` +
        (open ? `<span class="hub-chat-sess-open" title="This dialog is open in a tab">●</span>` : "") +
        `<button type="button" class="hub-chat-sess-del${armed ? " hub-chat-sess-del-armed" : ""}" ` +
        `title="${armed ? "Click again to DELETE the dialog with its files" : "Delete the dialog (asks twice)"}">🗑</button>` +
        `</div>`;
}

async function renderSessList() {
    if (!sessPop) return;
    const seq = ++sessFetchSeq;
    const listEl = sessPop.querySelector('[data-ss="list"]');
    const q = sessQuery.trim();
    const res = await jfetch("/settings_hub/chat/sessions" +
        (q ? "?q=" + encodeURIComponent(q) : ""));
    if (!sessPop || seq !== sessFetchSeq || !listEl) return;   // closed / stale
    if (!res.json?.ok) {
        listEl.innerHTML = `<div class="hub-chat-sess-empty">unavailable: ` +
            `${esc(res.json?.error || "HTTP " + res.status)}</div>`;
        return;
    }
    const list = res.json.sessions || [];
    listEl.innerHTML = list.length ? list.map(sessRowHtml).join("")
        : (q ? `<div class="hub-chat-sess-empty">nothing matches the search</div>`
             : `<div class="hub-chat-sess-empty">No saved chats yet</div>`);
}

function openSessPop() {
    if (sessPop) { closeSessPop(); return; }
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-chat-sessions";
    pop.innerHTML = `<div class="hub-menu-title">🕘 Saved chats</div>` +
        // v89: the flexible search - every word must hit the title or the
        // content (together); hits show a content snippet.
        `<div class="hub-chat-sessq">` +
        `<input type="text" class="hub-cp-in hub-cp-search" data-ss="q" spellcheck="false" autocomplete="off" ` +
        `placeholder="search… (title, text or both)" ` +
        `title="Live multi-word search: every word must match the chat title OR its message text - together they cover both. A matched content line is shown under the title.">` +
        `<button type="button" class="hub-cs-chip" data-ss="refresh" title="Re-run the search">↻</button>` +
        `</div>` +
        // v91 (owner 8d): export / import the ACTIVE chat as a JSON file.
        `<div class="hub-cp-btns">` +
        `<button type="button" class="hub-cs-chip" data-ss="export" title="Download the ACTIVE chat as a JSON file (the active path + the branch tree)">⤓ export chat</button>` +
        `<button type="button" class="hub-cs-chip" data-ss="import" title="Create a NEW chat from an exported JSON file">⤒ import chat</button>` +
        `<input type="file" data-ss="file" accept=".json,application/json" style="display:none">` +
        `</div>` +
        `<div data-ss="list"><div class="hub-chat-sess-empty">loading…</div></div>`;
    document.body.appendChild(pop);
    const r = sessionsBtn?.getBoundingClientRect?.();
    if (r) {
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        pop.style.left = Math.max(8, Math.min(r.left, vw - (pop.offsetWidth || 300) - 8)) + "px";
        pop.style.top = Math.min(r.bottom + 6, vh - (pop.offsetHeight || 200) - 8) + "px";
    }
    sessPop = pop;
    const qIn = pop.querySelector('[data-ss="q"]');
    qIn.value = sessQuery;
    let deb = null;
    qIn.addEventListener("input", () => {
        sessQuery = qIn.value;
        clearTimeout(deb);
        deb = setTimeout(() => void renderSessList(), 250);
    });
    qIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            clearTimeout(deb);
            sessQuery = qIn.value;
            void renderSessList();
        } else if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation(); closeSessPop();
        }
    });
    pop.querySelector('[data-ss="refresh"]').addEventListener("click", () => void renderSessList());
    // v91 (owner 8d): export = download the ACTIVE chat; import = file picker
    // -> POST /chat/import -> a new tab opens.
    pop.querySelector('[data-ss="export"]').addEventListener("click", () => exportSession(activeTab()));
    const fileIn = pop.querySelector('[data-ss="file"]');
    pop.querySelector('[data-ss="import"]').addEventListener("click", () => { try { fileIn.click(); } catch (_) {} });
    fileIn.addEventListener("change", () => {
        const f = fileIn.files && fileIn.files[0];
        if (f) void importSessionFile(f);
        try { fileIn.value = ""; } catch (_) {}
    });
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
                void renderSessList(); // refresh the list, the popup stays
                return;
            }
            sessArm = sid; sessArmTs = Date.now();
            void renderSessList();   // re-render with the armed state
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
            const tab = { id: sess.id, title: sess.title || "", msgs: sess.messages || [], tree: sess.tree || null, pending: [] };
            tabs.push(tab);
            activeId = tab.id;
            saveOpenTabs();
            renderTabs(); renderMsgs(); renderAttach(); renderStatus();
        }
    });
    void renderSessList();
    try { qIn.focus(); } catch (_) {}
    window.addEventListener("mousedown", onSessPopDown, true);
    window.addEventListener("keydown", onSessPopKey, true);
}

// ---------------------------------------------------------------------------
// v87 page zoom (devicePixelRatio): keep the panel's PHYSICAL size across
// Ctrl +/- / ctrl-pinch. The saved geometry is CSS px; a zoom change rescales
// it by the zoom factor BEFORE the normal refit clamps it into the viewport.
// ---------------------------------------------------------------------------

function curDpr() {
    try {
        const v = Number(window.devicePixelRatio);
        return Number.isFinite(v) && v > 0 ? v : 1;
    } catch (_) { return 1; }
}

function onWinResize() {
    const ui = lsUi();
    const dpr = curDpr();
    const f = lastDpr ? dpr / lastDpr : 1;
    lastDpr = dpr;
    if (f && Math.abs(f - 1) >= 0.01) {
        // page zoom changed - rescale the SAVED geometry and persist it (a
        // zoom change is a persistent user action, like a drag)
        const sc = {};
        for (const k of ["x", "y", "w", "h", "chipX", "chipY"]) {
            if (typeof ui[k] === "number" && Number.isFinite(ui[k])) sc[k] = ui[k] * f;
        }
        saveUi(sc);
    }
    refitIntoView();
    clearTimeout(resizePersistT);
    resizePersistT = setTimeout(() => {
        if (!panel || !chip) return;
        const u2 = lsUi();
        const p = clampIntoView(u2.x ?? 16, u2.y ?? 90, panel);
        const patch = { x: p.x, y: p.y };
        if (u2.min) {
            const c = clampIntoView(u2.chipX ?? p.x, u2.chipY ?? p.y, chip);
            patch.chipX = c.x; patch.chipY = c.y;
        }
        saveUi(patch);
    }, 150);
}

// ---------------------------------------------------------------------------
// v87 popups (⚙ settings / 📜 prompt / ⚡ GPU) - body-level fixed, ONE
// instance each, outside-mousedown + Esc close, clamped into the viewport.
// ---------------------------------------------------------------------------

function popupKeyCloser(closer) {
    return (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closer(); }
    };
}

function placePopup(pop, trigger) {
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    pop.style.maxHeight = Math.max(200, vh - 16) + "px";
    let x = 12, y = 12;
    try {
        const r = trigger.getBoundingClientRect();
        x = Math.max(8, Math.min(r.left, vw - (pop.offsetWidth || 300) - 8));
        y = r.bottom + 6;
        if (y + (pop.offsetHeight || 300) > vh - 8) {
            y = Math.max(8, r.top - (pop.offsetHeight || 300) - 6);
        }
    } catch (_) {}
    pop.style.left = x + "px";
    pop.style.top = y + "px";
}

function closeSetPop() {
    try { setPop?.remove(); } catch (_) {}
    setPop = null;
    try { window.removeEventListener("mousedown", onSetPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", setPopKey, true); } catch (_) {}
}
function onSetPopDown(e) {
    if (!setPop || setPop.contains(e.target) || settingsBtn?.contains?.(e.target)) return;
    closeSetPop();
}
const setPopKey = popupKeyCloser(closeSetPop);

function closePromptPop() {
    try { promptPop?.remove(); } catch (_) {}
    promptPop = null;
    try { window.removeEventListener("mousedown", onPromptPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", promptPopKey, true); } catch (_) {}
}
function onPromptPopDown(e) {
    if (!promptPop || promptPop.contains(e.target) || promptBtn?.contains?.(e.target)) return;
    closePromptPop();
}
const promptPopKey = popupKeyCloser(closePromptPop);

function closeGpuPop() {
    try { gpuPop?.remove(); } catch (_) {}
    gpuPop = null;
    try { window.removeEventListener("mousedown", onGpuPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", gpuPopKey, true); } catch (_) {}
}
function onGpuPopDown(e) {
    if (!gpuPop || gpuPop.contains(e.target) || gpuBtn?.contains?.(e.target)) return;
    closeGpuPop();
}
const gpuPopKey = popupKeyCloser(closeGpuPop);

function closeAllChatPops() { closeSetPop(); closePromptPop(); closeGpuPop(); }

// --- ⚙ Chat settings (moved out of the hub window in v87) -------------------

// v89: [key, tooltip, step, min, max, VISIBLE LABEL] - the owner: "the fields
// must have names, not just tooltips". The label is short; the tooltip keeps
// the full explanation.
const SET_NUM_KEYS = [
    ["temperature", "temperature (0-2)", "0.05", "0", "2", "temperature"],
    ["top_p", "top_p (0-1)", "0.01", "0", "1", "top_p"],
    ["max_tokens", "max_tokens (0 = no limit)", "64", "0", "131072", "max tokens"],
    ["ctx_depth", "how many last messages go into every request", "1", "1", "200", "history depth"],
    ["media_depth", "how many of them may carry real image/video parts", "1", "0", "50", "media depth"],
    ["img_max_side", "the client downscales a pasted image to this side (px)", "64", "256", "4096", "image max side"],
    ["img_max_count", "images per one message", "1", "1", "16", "images / msg"],
    ["video_frames", "frames cut from one video (needs ffmpeg on the server)", "1", "2", "64", "video frames"],
    ["video_max_side", "long side of a video frame (px)", "64", "256", "4096", "video max side"],
];
const CTX_TOOLTIP = "model context in tokens for the ctx display. 0 = auto: " +
    "the LLM server reports it (PolyStrata /v1/status context.native); when " +
    "nothing reports it the status line shows only the used part";
const TIMEOUT_TOOLTIP = "generation timeout, seconds - a local model may think for minutes";

// v89: one labeled cell per number - <label> wraps the mini label + the
// input, so a click on the label focuses the field too.
const setNumCell = ([k, t, step, min, max, lab]) =>
    `<label class="hub-cs-cell" title="${t}">` +
    `<span class="hub-cs-lab">${lab}</span>` +
    `<input type="number" step="${step}" min="${min}" max="${max}" data-cs-num="${k}" class="hub-cs-in">` +
    `</label>`;
const setNumGrid = (keys) =>
    `<div class="hub-cs-grid">` + keys.map(setNumCell).join("") + `</div>`;

function openSetPop() {
    if (setPop) { closeSetPop(); return; }
    closePromptPop(); closeGpuPop();
    // v90: font-scale options = quick picks ∪ current (a custom 75..250
    // value keeps its slot - same contract as the hub ⚙ row).
    const curFs = getUiFontScale();
    const fsChoices = [...new Set([...UI_FONT_SCALE_CHOICES, curFs])].sort((a, b) => a - b);
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-chat-setpop";
    pop.innerHTML =
        `<div class="hub-menu-title">⚙ Chat settings</div>` +
        // v88: the panel On/Off moved here from the hub - the chat is a
        // self-managed utility. v91: the way back is the MINI PANEL; the
        // per-panel ComfyUI settings row is gone (the launcher rows only).
        `<label class="hub-cs-row"><span>Chat panel</span>` +
        `<select class="hub-cs-sel" data-cs="panel">` +
        `<option value="1">On (default)</option>` +
        `<option value="0">Off - hide the panel</option>` +
        `</select></label>` +
        // v91: a hidden panel has NO ui of its own - spell the way back out.
        `<div class="hub-cs-info">Off hides the panel. Bring it back: the ` +
        `mini panel (💬 toggle) or ComfyUI Settings → SettingsHub → 'Mini ` +
        `panel' (reachable in every workflow).</div>` +
        `<label class="hub-cs-row"><span>LLM server URL</span>` +
        `<input type="text" class="hub-cs-in" data-cs="url" placeholder="http://127.0.0.1:8080/v1" spellcheck="false" autocomplete="off"></label>` +
        `<label class="hub-cs-row"><span>API key (optional)</span>` +
        `<input type="password" class="hub-cs-in" data-cs="key" placeholder="type + Enter to set, empty + Enter clears" spellcheck="false" autocomplete="off"></label>` +
        `<div class="hub-cs-row"><span>Connection</span>` +
        `<span class="hub-cs-box"><button type="button" class="hub-cs-chip" data-cs-btn="test">Test</button></span></div>` +
        `<div class="hub-cs-info" data-cs="testinfo"></div>` +
        `<div class="hub-cs-sect">Sampling</div>` +
        setNumGrid(SET_NUM_KEYS.slice(0, 3)) +
        // v89: the available-context override (0 = auto-detect server-side).
        `<label class="hub-cs-cell hub-cs-cell-wide" title="${CTX_TOOLTIP}">` +
        `<span class="hub-cs-lab">context size (0 = auto)</span>` +
        `<input type="number" step="512" min="0" max="2000000" data-cs-num="ctx_size" class="hub-cs-in"></label>` +
        `<div class="hub-cs-sect">History &amp; media</div>` +
        setNumGrid(SET_NUM_KEYS.slice(3, 9)) +
        `<label class="hub-cs-row"><span>Streaming replies</span>` +
        `<select class="hub-cs-sel" data-cs="stream">` +
        `<option value="1">On (default)</option><option value="0">Off</option>` +
        `</select></label>` +
        `<label class="hub-cs-row"><span>Keep last chats</span>` +
        `<select class="hub-cs-sel" data-cs="keep">` +
        `<option value="10">10</option><option value="20">20 · default</option>` +
        `<option value="50">50</option><option value="100">100</option>` +
        `</select></label>` +
        // v89: the timeout number keeps a NAMED row (label + input).
        `<label class="hub-cs-cell hub-cs-cell-wide" title="${TIMEOUT_TOOLTIP}">` +
        `<span class="hub-cs-lab">timeout, s</span>` +
        `<input type="number" step="30" min="30" max="86400" data-cs-num="timeout_s" class="hub-cs-in"></label>` +
        // v90: the shared interface font scale (the same value the hub ⚙ and
        // the stack ⚙ edit; applies instantly through the --sh-fs CSS var).
        `<div class="hub-cs-sect">Interface (v90)</div>` +
        `<label class="hub-cs-row"><span>Font size (hub · stack · chat)</span>` +
        `<select class="hub-cs-sel" data-cs="font">` +
        fsChoices.map((p) => `<option value="${p}">${esc(uiFontScaleLabel(p))}</option>`).join("") +
        `</select></label>` +
        // v89: the owner's own prompt-catalog folder (empty = the PolyStrata path).
        `<div class="hub-cs-sect">System prompt catalog</div>` +
        `<div class="hub-cs-row"><span>Prompts folder</span><span class="hub-cs-box">` +
        `<input type="text" class="hub-cs-in hub-cs-path" data-cs="pdir" placeholder="default: models/LLM/prompts" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="hub-cs-chip" data-cs-btn="pdirdef">default</button></span></div>` +
        `<div class="hub-cs-info" data-cs="pdirinfo"></div>` +
        `<div class="hub-cs-sect">Storage folder</div>` +
        `<div class="hub-cs-row"><span class="hub-cs-box">` +
        `<input type="text" class="hub-cs-in hub-cs-path" data-cs="root" placeholder="default: user/settings_hub/chat" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="hub-cs-chip" data-cs-btn="rootdef">default</button></span></div>` +
        `<div class="hub-cs-info" data-cs="rootinfo"></div>` +
        `<div class="hub-cs-hint">Enter applies a row, Esc reverts it. The key lives in ` +
        `config.json on the SERVER - the browser only ever sees a mask. The URL must ` +
        `include /v1 (PolyStrata: http://127.0.0.1:8080/v1). Model, thinking and the ` +
        `system prompt sit under the input. The panel switch above is also in ` +
        `ComfyUI Settings → SettingsHub - reachable in every workflow.</div>`;
    document.body.appendChild(pop);
    setPop = pop;

    const urlIn = pop.querySelector('[data-cs="url"]');
    const keyIn = pop.querySelector('[data-cs="key"]');
    const info = pop.querySelector('[data-cs="testinfo"]');
    const keepSel = pop.querySelector('[data-cs="keep"]');
    const streamSel = pop.querySelector('[data-cs="stream"]');
    const rootIn = pop.querySelector('[data-cs="root"]');
    const rootInfo = pop.querySelector('[data-cs="rootinfo"]');
    const panelSel = pop.querySelector('[data-cs="panel"]');
    panelSel.value = isChatOn() ? "1" : "0";
    panelSel.addEventListener("change", () => {
        const on = panelSel.value === "1";
        setChatOn(on);   // Off tears the panel down - this popup dies with it
        if (on && setPop) panelSel.value = isChatOn() ? "1" : "0";
    });
    // v90: the shared font scale (applies instantly via the --sh-fs var -
    // the open popup reflows with the rest of the UI).
    const fsSel = pop.querySelector('[data-cs="font"]');
    fsSel.value = String(getUiFontScale());
    fsSel.addEventListener("change", () => {
        fsSel.value = String(setUiFontScale(fsSel.value));
    });
    const nums = Array.from(pop.querySelectorAll("[data-cs-num]"));
    const syncNums = (c) => {
        for (const inp of nums) {
            inp.value = String(c?.[inp.dataset.csNum] ?? "");
            inp.dataset.cur = inp.value;
        }
    };

    const applyPatch = async (patch, onOk) => {
        const res = await applyChatSettings(patch);
        if (res.ok) { if (onOk) onOk(res.config); else syncNums(cfg); }
        else localToast("Not applied: " + (res.error || "?"));
        return res;
    };

    for (const inp of nums) {
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault(); e.stopPropagation();
                const k = inp.dataset.csNum;
                const raw = inp.value.trim();
                void applyPatch({ [k]: raw === "" ? undefined : parseFloat(raw) });
            } else if (e.key === "Escape") {
                e.stopPropagation();
                inp.value = inp.dataset.cur ?? "";
                inp.blur();
            }
        });
    }
    urlIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            void applyPatch({ url: urlIn.value }, (c) => { urlIn.value = c?.url || ""; urlIn.dataset.cur = urlIn.value; });
        } else if (e.key === "Escape") {
            e.stopPropagation(); urlIn.value = urlIn.dataset.cur ?? ""; urlIn.blur();
        }
    });
    keyIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            void applyPatch({ key: keyIn.value }, (c) => {
                keyIn.value = "";
                keyIn.placeholder = c?.key
                    ? ("saved: " + c.key + " - type + Enter to replace, empty + Enter clears")
                    : "(no key) - type + Enter to set";
            });
        } else if (e.key === "Escape") {
            e.stopPropagation(); keyIn.value = ""; keyIn.blur();
        }
    });
    streamSel.addEventListener("change", () => {
        void applyPatch({ stream: streamSel.value === "1" });
    });
    keepSel.addEventListener("change", () => {
        void applyPatch({ keep_sessions: parseInt(keepSel.value, 10) || 20 });
    });
    pop.querySelector('[data-cs-btn="test"]').addEventListener("click", async () => {
        info.classList.remove("hub-cs-err");
        info.textContent = "Testing the LLM server…";
        const res = await testChatServer();
        if (res.ok) {
            const bits = ["OK - " + (res.current || res.models?.[0] || "no model reported")];
            if (res.models?.length) bits.push("models: " + res.models.slice(0, 6).join(", "));
            if (res.status?.context?.native) bits.push("ctx " + res.status.context.native);
            info.textContent = bits.join(" · ");
            void fillModels(false);
        } else {
            info.classList.add("hub-cs-err");
            info.textContent = "FAIL: " + (res.error || "?");
        }
    });
    const rootApply = async () => {
        const res = await setChatRootPath(rootIn.value);
        if (res.ok) {
            rootIn.value = res.custom || "";
            rootIn.dataset.cur = rootIn.value;
            rootInfo.classList.remove("hub-cs-err");
            rootInfo.textContent = "Now: " + (res.root || "") + (res.custom ? " (custom)" : " (default)") +
                (res.saved === false ? " - could not save chat_root.json (this session only)" : "");
        } else {
            rootInfo.classList.add("hub-cs-err");
            rootInfo.textContent = "Not applied: " + (res.error || "error") +
                (res.stale ? " - old py: update the FULL pack and RESTART ComfyUI." : "");
        }
    };
    rootIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void rootApply(); }
        else if (e.key === "Escape") { e.stopPropagation(); rootIn.value = rootIn.dataset.cur || ""; rootIn.blur(); }
    });
    pop.querySelector('[data-cs-btn="rootdef"]').addEventListener("click", () => {
        rootIn.value = "";
        void rootApply();
    });

    // v89: the owner's own prompt-catalog folder (empty = the PolyStrata path).
    const pdirIn = pop.querySelector('[data-cs="pdir"]');
    const pdirInfo = pop.querySelector('[data-cs="pdirinfo"]');
    const pdirApply = async () => {
        const res = await applyChatSettings({ prompts_dir: pdirIn.value });
        if (res.ok) {
            pdirIn.value = res.config?.prompts_dir || "";
            pdirIn.dataset.cur = pdirIn.value;
            pdirInfo.classList.remove("hub-cs-err");
            pdirInfo.textContent = "Now: " + (pdirIn.value || "models/LLM/prompts (default)") +
                " - the 📜 list re-scans it on open";
            if (promptPop) void refreshPromptList(false);   // a live refresh
        } else {
            pdirInfo.classList.add("hub-cs-err");
            pdirInfo.textContent = "Not applied: " + (res.error || "error");
        }
    };
    pdirIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void pdirApply(); }
        else if (e.key === "Escape") { e.stopPropagation(); pdirIn.value = pdirIn.dataset.cur || ""; pdirIn.blur(); }
    });
    pop.querySelector('[data-cs-btn="pdirdef"]').addEventListener("click", () => {
        pdirIn.value = "";
        void pdirApply();
    });

    // async initial values (the popup is already open)
    void (async () => {
        const st = await getChatUiState();
        if (!st.cfg || !setPop || !urlIn.isConnected) return;
        urlIn.value = st.cfg.url || "";
        urlIn.dataset.cur = urlIn.value;
        keyIn.placeholder = st.cfg.key
            ? ("saved: " + st.cfg.key + " - type + Enter to replace, empty + Enter clears")
            : "(no key) - type + Enter to set";
        syncNums(st.cfg);
        if (pdirIn.isConnected && !pdirIn.value) {
            pdirIn.value = st.cfg.prompts_dir || "";
            pdirIn.dataset.cur = pdirIn.value;
            if (pdirInfo.isConnected && !pdirInfo.textContent) {
                pdirInfo.textContent = pdirIn.value
                    ? "Custom folder - the 📜 list scans it"
                    : "";
            }
        }
        streamSel.value = st.cfg.stream === false ? "0" : "1";
        keepSel.value = String(st.cfg.keep_sessions || 20);
        if (!info.textContent) {
            info.textContent = st.configured
                ? (st.has_ffmpeg ? "" : "ffmpeg NOT found - video attachments are unavailable")
                : "no LLM server configured yet";
            if (!st.configured) info.classList.add("hub-cs-err");
        }
        const ri = await getChatRootInfo();
        if (ri && rootIn.isConnected) {
            rootInfo.textContent = "Now: " + (ri.root || "") + (ri.custom ? " (custom)" : " (default)") +
                (ri.writable === false ? " - NOT writable" : "");
            if (!rootIn.value) rootIn.value = ri.custom || "";
            rootIn.dataset.cur = rootIn.value;
        }
    })();

    placePopup(pop, settingsBtn);
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    try { urlIn.focus(); } catch (_) {}
    window.addEventListener("mousedown", onSetPopDown, true);
    window.addEventListener("keydown", setPopKey, true);
}

// --- 📜 System prompt (v88: the user's OWN catalog - the PolyStrata path) ----

// The catalog lives in ComfyUI/models/LLM/prompts (prompt_root() of the
// PolyStrata nodes - the same folder the llama.cpp pack uses). The list IS
// the user's files: NOTHING is invented here. The selection is stored as
// cfg.prompt_preset; the SERVER reads the file fresh on every send and the
// preset wins over the custom text (the nodes' resolve_system_prompt).
let promptFiles = [];      // relative paths "sub/name.txt"
let promptDir = "";        // the catalog folder, for the hint line
let promptListError = "";  // "catalog folder does not exist yet" etc.
let promptQuery = "";

function promptFilter(files, q) {
    // the catalog is *.txt server-side; the client re-filters too (defense in
    // depth) and then applies the live multi-word search: EVERY
    // whitespace-separated word must appear in the relative path
    const toks = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    return (files || []).filter((f) => {
        const lf = String(f).toLowerCase();
        if (!lf.endsWith(".txt")) return false;
        return toks.every((t) => lf.includes(t));
    });
}

function renderPromptBtnState() {
    if (!promptBtn) return;
    const preset = (cfg?.prompt_preset || "").trim();
    const custom = (cfg?.system_prompt || "").trim();
    promptBtn.classList.toggle("hub-chat-tb-on", !!(preset || custom));
    promptBtn.title = preset
        ? "System prompt: file " + preset + " - click to change"
        : (custom ? "System prompt: custom text - click to change"
                  : "System prompt: none - click to set");
}

// v91 (owner: "when there are many files and a custom one from the middle is
// selected, it is not obvious WHICH prompt is in use - write somewhere which
// system prompt is active"): the active prompt is (a) always visible as a 📜
// segment in the status line (renderStatus), (b) spelled out in an ACTIVE
// banner on top of the prompt popup, and (c) the popup scrolls the selected
// file into view on open (renderPromptList).
function activePromptLabel() {
    const preset = (cfg?.prompt_preset || "").trim();
    if (preset) return { text: "Active: " + preset, on: true };
    if ((cfg?.system_prompt || "").trim()) return { text: "Active: custom text (no file selected)", on: true };
    return { text: "Active: none - no system prompt is sent", on: false };
}

function renderActivePrompt() {
    if (!promptPop) return;
    const el = promptPop.querySelector('[data-cp="active"]');
    if (!el) return;
    const p = activePromptLabel();
    el.textContent = p.text;
    el.classList.toggle("hub-cp-active-on", p.on);
}

async function refreshPromptList(manual) {
    const res = await jfetch("/settings_hub/chat/prompts");
    if (res.json?.ok) {
        promptFiles = Array.isArray(res.json.files) ? res.json.files : [];
        promptDir = res.json.dir || "";
        promptListError = res.json.error || "";
        if (manual) {
            localToast("Prompt catalog: " + promptFiles.length + " file(s)" +
                (promptDir ? " - " + promptDir : ""));
        }
    } else if (manual) {
        localToast("Prompt catalog failed: " + (res.json?.error || "HTTP " + res.status));
    }
    renderPromptList();
}

function renderPromptList() {
    if (!promptPop) return;
    const listEl = promptPop.querySelector('[data-cp="list"]');
    if (!listEl) return;
    const sel = (cfg?.prompt_preset || "").trim();
    const files = promptFilter(promptFiles, promptQuery);
    let html =
        `<button type="button" class="hub-cp-item${!sel ? " hub-cp-item-on" : ""}" ` +
        `data-cp-name="" title="No catalog file - the custom text below is used">none (custom text)</button>`;
    if (!promptFiles.length) {
        html += `<div class="hub-cp-empty">${esc(promptListError || "no .txt files in the catalog yet")}` +
            `${promptDir ? ": " + esc(promptDir) : ""}</div>`;
    } else if (!files.length) {
        html += `<div class="hub-cp-empty">nothing matches the search</div>`;
    }
    html += files.map((f) =>
        `<button type="button" class="hub-cp-item${f === sel ? " hub-cp-item-on" : ""}" ` +
        `data-cp-name="${esc(f)}" title="${esc(f)}">${esc(f)}</button>`).join("");
    listEl.innerHTML = html;
    renderActivePrompt();
    // v91: with a long catalog the selected file must be VISIBLE when the
    // popup opens - scroll it into view (skipped while the user is typing a
    // search filter, so the list never yanks mid-typing).
    if (!promptQuery) {
        try { listEl.querySelector(".hub-cp-item-on")?.scrollIntoView?.({ block: "center" }); } catch (_) {}
    }
}

function openPromptPop() {
    if (promptPop) { closePromptPop(); return; }
    closeSetPop(); closeGpuPop();
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-chat-promptpop";
    pop.innerHTML =
        `<div class="hub-menu-title">📜 System prompt</div>` +
        // v91: the ACTIVE prompt is spelled out on top of the popup - no
        // guessing which file (or the custom text) is actually in use.
        `<div class="hub-cp-active" data-cp="active"></div>` +
        `<div class="hub-cp-searchrow">` +
        `<input type="text" class="hub-cp-in hub-cp-search" data-cp="search" spellcheck="false" autocomplete="off" ` +
        `placeholder="search… (several words)" title="Live search: every word must match the file path">` +
        `<button type="button" class="hub-cs-chip" data-cp="refresh" title="Re-scan the catalog folder">↻</button>` +
        `</div>` +
        `<div class="hub-cp-list" data-cp="list"></div>` +
        `<textarea class="hub-cp-ta" rows="6" spellcheck="false" ` +
        `placeholder="Custom prompt (used while no file is selected)…"></textarea>` +
        `<div class="hub-cp-btns">` +
        `<button type="button" class="hub-cs-chip hub-cp-save" title="Use THIS custom text (a selected file is deselected)">Save</button>` +
        `<button type="button" class="hub-cs-chip hub-cp-clear" title="No system prompt at all">Clear</button>` +
        `</div>` +
        `<div class="hub-cs-hint">Your OWN .txt prompts from ` +
        `<span class="hub-cp-mono" data-cp="dir">…</span> - the same folder the ` +
        `PolyStrata / llama.cpp nodes use. A selected file is read fresh on EVERY ` +
        `message and WINS over the custom text; "Save" switches to the custom text; ` +
        `"Clear" sends none. Applies to every chat.</div>`;
    document.body.appendChild(pop);
    promptPop = pop;
    const ta = pop.querySelector(".hub-cp-ta");
    ta.value = cfg?.system_prompt || "";
    const dirEl = pop.querySelector('[data-cp="dir"]');
    if (dirEl) dirEl.textContent = promptDir || "ComfyUI/models/LLM/prompts";
    const searchIn = pop.querySelector('[data-cp="search"]');
    searchIn.value = promptQuery;
    searchIn.addEventListener("input", () => {
        promptQuery = searchIn.value;
        renderPromptList();
    });
    pop.querySelector('[data-cp="refresh"]').addEventListener("click", () => void refreshPromptList(true));
    pop.querySelector('[data-cp="list"]').addEventListener("click", async (e) => {
        const item = e.target?.closest?.("[data-cp-name]");
        if (!item) return;
        const name = item.dataset.cpName || "";
        const res = await applyChatSettings({ prompt_preset: name });
        if (res.ok) {
            renderPromptList();
            renderPromptBtnState();
            localToast(name ? "System prompt: " + name : "System prompt: none (custom text)");
        } else {
            localToast("Not applied: " + (res.error || "?"));
        }
    });
    const commit = async (text) => {
        const res = await applyChatSettings({ system_prompt: text, prompt_preset: "" });
        if (res.ok) {
            ta.value = res.config?.system_prompt ?? text;
            renderPromptList();
            renderPromptBtnState();
            localToast(text.trim() ? "System prompt: custom text saved" : "System prompt cleared");
        } else {
            localToast("Not applied: " + (res.error || "?"));
        }
    };
    pop.querySelector(".hub-cp-save").addEventListener("click", () => void commit(ta.value));
    pop.querySelector(".hub-cp-clear").addEventListener("click", () => void commit(""));
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); e.stopPropagation();
            void commit(ta.value);
        } else if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation(); closePromptPop();
        }
    });
    renderPromptList();
    void refreshPromptList(false);   // fresh scan on every open
    placePopup(pop, promptBtn);
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    try { searchIn.focus(); } catch (_) {}
    window.addEventListener("mousedown", onPromptPopDown, true);
    window.addEventListener("keydown", promptPopKey, true);
}

// --- ⚡ GPU & memory (the v87 /chat/gpu routes) -------------------------------

function renderGpuBtnState() {
    if (!gpuBtn) return;
    const on = Number(cfg?.vram_reserve_mib || 0) > 0;
    gpuBtn.classList.toggle("hub-chat-tb-on", on);
    gpuBtn.title = on
        ? "GPU & memory - VRAM reserve for ComfyUI: " + cfg.vram_reserve_mib + " MiB ON"
        : "GPU & memory - model load/unload, VRAM reserve, ComfyUI cleanup";
}

async function gpuAction(body) {
    const res = await jfetch("/settings_hub/chat/gpu", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    return res.json || { ok: false, error: res.json?.error || "HTTP " + res.status };
}

function gpuStateLine(up) {
    if (!up) return "no LLM server / status unavailable";
    const bits = [];
    bits.push(up.loaded ? "model LOADED" : "model not loaded");
    if (up.model) bits.push(up.model);
    if (up.free_mib != null && up.total_mib != null) {
        bits.push("VRAM free " + up.free_mib + " / " + up.total_mib + " MiB");
    } else if (up.free_mib != null) {
        bits.push("VRAM free " + up.free_mib + " MiB");
    }
    return bits.join(" · ");
}

async function refreshGpuPop() {
    if (!gpuPop) return;
    const stateEl = gpuPop.querySelector('[data-gpu="state"]');
    const planEl = gpuPop.querySelector('[data-gpu="plan"]');
    const mibIn = gpuPop.querySelector('[data-gpu="mib"]');
    const r = await jfetch("/settings_hub/chat/gpu");
    if (!r.json?.ok) {
        stateEl.textContent = "GPU status failed: " + (r.json?.error || "HTTP " + r.status);
        return;
    }
    stateEl.textContent = gpuStateLine(r.json.upstream);
    stateEl.classList.toggle("hub-cs-err", !r.json.upstream);
    const reserve = Number(r.json.reserve_mib || 0);
    if (cfg && cfg.vram_reserve_mib !== reserve) {
        cfg.vram_reserve_mib = reserve;
        renderGpuBtnState();
    }
    if (mibIn && document.activeElement !== mibIn) mibIn.value = reserve ? String(reserve) : "";
    // the PERSISTENT planner state lives on its own line - the action notes
    // element is never clobbered by a refresh
    planEl.textContent = reserve
        ? (r.json.comfy_reserved
            ? "Reserve ON: " + reserve + " MiB - ComfyUI plans around the LLM (EXTRA_RESERVED_VRAM)"
            : "Reserve ON: " + reserve + " MiB - re-applied before every chat message")
        : "";
}

function openGpuPop() {
    if (gpuPop) { closeGpuPop(); return; }
    closeSetPop(); closePromptPop();
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-chat-gpupop";
    pop.innerHTML =
        `<div class="hub-menu-title">⚡ GPU & memory</div>` +
        `<div class="hub-gp-state" data-gpu="state">reading…</div>` +
        `<div class="hub-cs-info" data-gpu="plan"></div>` +
        `<div class="hub-cs-info" data-gpu="notes"></div>` +
        `<div class="hub-cp-btns">` +
        `<button type="button" class="hub-cs-chip" data-gpu-btn="refresh" title="Re-read the upstream /v1/status">↻ status</button>` +
        `<button type="button" class="hub-cs-chip" data-gpu-btn="load" title="Wake / switch the model now (POST /v1/load)">Load now</button>` +
        `<button type="button" class="hub-cs-chip hub-gp-unload" data-gpu-btn="unload" title="Unload the LLM model - ALL of its VRAM + the reservation come back">Unload model</button>` +
        `<button type="button" class="hub-cs-chip hub-gp-unload" data-gpu-btn="free" title="ComfyUI's own 'Free model and node cache': unload ITS models + torch cache + gc (the LLM is untouched)">Free ComfyUI memory</button>` +
        `</div>` +
        `<div class="hub-cs-sect">VRAM reserve for ComfyUI</div>` +
        `<div class="hub-cp-btns">` +
        `<input type="number" class="hub-cs-in hub-gp-mib" data-gpu="mib" min="0" step="256" placeholder="MiB, e.g. 4096" title="Keep this much VRAM free for ComfyUI (the PolyStrata /v1/vram mechanics; re-applied before every chat message while > 0)">` +
        `<button type="button" class="hub-cs-chip" data-gpu-btn="reserve" title="Apply now and remember (ComfyUI plans its loads around the LLM)">Apply</button>` +
        `<button type="button" class="hub-cs-chip" data-gpu-btn="release" title="Return the reserve to the startup state (both sides)">Release</button>` +
        `</div>` +
        `<div class="hub-cs-hint">While a reserve is set, EVERY chat message re-applies it before ` +
        `the model wakes - ComfyUI keeps its VRAM and stops catching OOM. "Unload model" stops ` +
        `the engine and returns ALL of its memory + the reservation. "Free ComfyUI memory" is ` +
        `ComfyUI's own cache cleanup.</div>`;
    document.body.appendChild(pop);
    gpuPop = pop;
    const notesEl = pop.querySelector('[data-gpu="notes"]');
    const showNotes = (j) => {
        notesEl.classList.remove("hub-cs-err");
        notesEl.textContent = (j?.notes || []).join(" · ") || (j?.error ? "FAILED: " + j.error : "");
        if (j?.error) notesEl.classList.add("hub-cs-err");
        void refreshGpuPop();
    };
    const busy = async (fn) => {
        notesEl.classList.remove("hub-cs-err");
        notesEl.textContent = "…";
        try { showNotes(await gpuAction(await fn())); }
        catch (e) { notesEl.classList.add("hub-cs-err"); notesEl.textContent = String(e); }
    };
    pop.addEventListener("click", (e) => {
        const b = e.target?.closest?.("[data-gpu-btn]");
        if (!b) return;
        const k = b.dataset.gpuBtn;
        if (k === "refresh") { void refreshGpuPop().then(() => { if (gpuPop) notesEl.textContent = ""; }); }
        else if (k === "load") void busy(async () => ({ action: "load", model: cfg?.model || "" }));
        else if (k === "unload") void busy(async () => ({ action: "unload" }));
        else if (k === "free") void busy(async () => ({ action: "free_comfy" }));
        else if (k === "reserve") {
            const mib = parseInt(pop.querySelector('[data-gpu="mib"]').value, 10);
            if (!Number.isFinite(mib) || mib < 0) { localToast("Type the reserve in MiB (e.g. 4096)"); return; }
            void busy(async () => ({ action: "reserve", mib }));
        }
        else if (k === "release") void busy(async () => ({ action: "release" }));
    });
    placePopup(pop, gpuBtn);
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    void refreshGpuPop();
    window.addEventListener("mousedown", onGpuPopDown, true);
    window.addEventListener("keydown", gpuPopKey, true);
}

// ---------------------------------------------------------------------------
// Status line + degraded/config notes
// ---------------------------------------------------------------------------

function setStatusErr(msg) {
    if (!statusEl) return;
    statusEl.classList.add("hub-chat-status-err");
    statusEl.textContent = msg;
}

function fmtTok(n) {
    const v = Number(n || 0);
    if (v >= 10000) return Math.round(v / 1000) + "k";
    if (v >= 1000) return (Math.round(v / 100) / 10) + "k";
    return String(v);
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
            last = bits.length ? "last: " + bits.join(", ") : "";
        }
    }
    // v89: the context fill - the last answer carries ctx {used, total, est}.
    // "ctx 3.2k/32k", "≈" when estimated (no usage.prompt_tokens), ⚠ past 90%.
    let ctxSeg = "";
    let ctxTitle = "";
    if (tab && tab.msgs.length) {
        const a = [...tab.msgs].reverse().find((m) => m.role === "assistant" && m.ctx?.used);
        if (a) {
            const c = a.ctx;
            const used = Number(c.used || 0);
            const total = Number(c.total || 0);
            let seg = (c.est ? "ctx ≈" : "ctx ") + fmtTok(used);
            if (total > 0) {
                seg += " / " + fmtTok(total);
                if (used > total * 0.9) seg += " ⚠";
            }
            const tail = [];
            if (c.images) tail.push(c.images + " img");
            if (tail.length) seg += " (" + tail.join(", ") + ")";
            ctxSeg = seg;
            ctxTitle = ctxSeg
                ? "Context: the request size after the last answer" +
                  (total > 0 ? " of the model context" : " (the model context is unknown - set it in ⚙ 'context size')") +
                  ". ≈ = the proxy's estimate (the exact prompt_tokens arrives when the server reports usage); ⚠ = past 90% - the model starts forgetting the oldest messages (trim the history or raise 'history depth' limits)."
                : "";
        }
    }
    // v87: the model moved into the toolbar dropdown - the status line keeps
    // the server url + the last-answer stats (degraded errors override it).
    // v91: + a permanent 📜 segment naming the ACTIVE system prompt.
    let prSeg = "";
    const prPreset = (cfg?.prompt_preset || "").trim();
    const prCustom = (cfg?.system_prompt || "").trim();
    if (prPreset) {
        const base = String(prPreset).split("/").pop() || prPreset;
        prSeg = "📜 " + base;
    } else if (prCustom) {
        prSeg = "📜 custom";
    }
    statusEl.textContent = (cfg?.url || "no LLM server") +
        (last ? " · " + last : "") +
        (ctxSeg ? " · " + ctxSeg : "") +
        (prSeg ? " · " + prSeg : "");
    // the title is rebuilt FRESH on every render - it must never grow
    statusEl.title = (ctxTitle ? ctxTitle + "\n" : "") +
        (prSeg ? "System prompt in use: " + (prPreset || "custom text (no file)") : "");
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
            `<div class="hub-chat-note-why">Press ⚙ in the chat header and set the server URL ` +
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

function bubbleHtml(tab, msg, idx) {
    const role = msg.role === "assistant" ? "Model" : "You";
    const sid = tab?.id || activeId || "";
    const m = { ...msg, _sid: sid };
    const meta = [];
    if (msg.usage?.completion_tokens) meta.push(msg.usage.completion_tokens + " tok");
    if (msg.ms) meta.push((msg.ms / 1000).toFixed(1) + " s");
    if (msg.stopped) meta.push("stopped");
    // v91 (owner 8a): the variant arrows - ‹ i/n › when this message has
    // sibling variants (edited wordings / regenerated answers). Switching
    // the variant rebuilds the WHOLE path below it.
    const v = variantInfo(tab, msg.nid);
    const vars = (v && v.count > 1)
        ? `<span class="hub-chat-vars">` +
          `<button type="button" class="hub-chat-var" data-act="var-prev" data-nid="${esc(msg.nid)}" title="Previous variant of ${role === "You" ? "your request" : "this answer"}"${v.index <= 0 ? " disabled" : ""}>‹</button>` +
          `<span class="hub-chat-var-n" title="Variant ${v.index + 1} of ${v.count}">${v.index + 1}/${v.count}</span>` +
          `<button type="button" class="hub-chat-var" data-act="var-next" data-nid="${esc(msg.nid)}" title="Next variant of ${role === "You" ? "your request" : "this answer"}"${v.index >= v.count - 1 ? " disabled" : ""}>›</button>` +
          `</span>`
        : "";
    const acts = [];
    acts.push(`<button type="button" class="hub-chat-mact" data-act="copy" data-i="${idx}" title="Copy the text">📋</button>`);
    if (msg.role === "user") {
        acts.push(`<button type="button" class="hub-chat-mact" data-act="edit" data-i="${idx}" title="Edit as a NEW branch - the old wording and its answers stay (walk them with ‹ ›)">✎</button>`);
    } else {
        acts.push(`<button type="button" class="hub-chat-mact" data-act="edit" data-i="${idx}" title="Edit this reply in place">✎</button>`);
    }
    // v91 (owner 8b): every message is deletable (with its subtree, armed);
    // (owner 8c): every message can start a new chat from here.
    acts.push(`<button type="button" class="hub-chat-mact" data-act="fork" data-i="${idx}" title="New chat from here (copies this message and everything above)">⑂</button>`);
    acts.push(`<button type="button" class="hub-chat-mact" data-act="del" data-nid="${esc(msg.nid || "")}" title="Delete this message and everything under it - click twice">🗑</button>`);
    const editing = editState && editState.idx === idx;
    const body = editing
        ? `<div class="hub-chat-edit">` +
          `<textarea class="hub-chat-edit-ta" rows="3">${esc(msg.text || "")}</textarea>` +
          `<span class="hub-chat-edit-acts">` +
          (msg.role === "user"
            ? `<button type="button" class="hub-chat-edit-send" data-act="edit-send" data-i="${idx}" title="Send as a NEW branch (the old wording + its answers stay)">▶ send</button>`
            : `<button type="button" class="hub-chat-edit-send" data-act="edit-save" data-i="${idx}" title="Save the edited reply in place">✔ save</button>`) +
          `<button type="button" class="hub-chat-edit-cancel" data-act="edit-cancel" title="Cancel the edit">cancel</button>` +
          `</span></div>`
        : `<div class="hub-chat-msg-body">${mdLite(msg.text)}</div>`;
    return `<div class="hub-chat-msg hub-chat-msg-${msg.role === "assistant" ? "assistant" : "user"}" data-i="${idx}">` +
        `<div class="hub-chat-msg-head">` +
        `<span class="hub-chat-msg-role">${role}</span>` +
        vars +
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
    if (!tab) { msgsEl.innerHTML = ""; return; }
    const sid = tab.id || "";
    msgsEl.innerHTML = tab.msgs.map((m, i) => bubbleHtml(tab, m, i)).join("") +
        (tab.msgs.length ? "" : `<div class="hub-chat-empty">Say something - the model answers here.<br>` +
            `📎 attaches an image (vision), 🎞 a video or a text file.</div>`);
    patchRegenButtons();
    msgsEl.scrollTop = msgsEl.scrollHeight;
}

// regenerate button on the LAST assistant message - and (v91) on a trailing
// USER message whose answer never arrived (a failed/stopped send gets a
// one-click retry hanging the answer under that same request).
function patchRegenButtons() {
    if (!msgsEl) return;
    const tab = activeTab();
    if (!tab) return;
    let lastA = -1;
    tab.msgs.forEach((m, i) => { if (m.role === "assistant") lastA = i; });
    const lastIdx = tab.msgs.length - 1;
    const retryUser = lastIdx >= 0 && tab.msgs[lastIdx].role === "user";
    msgsEl.querySelectorAll(".hub-chat-msg").forEach((el) => {
        const i = parseInt(el.dataset.i, 10);
        const msg = tab.msgs[i];
        if (!msg) return;
        const wantRegen = !streaming && (
            (msg.role === "assistant" && i === lastA) ||
            (msg.role === "user" && i === lastIdx && retryUser));
        if (wantRegen) {
            if (!el.querySelector('[data-act="regen"]')) {
                const span = el.querySelector(".hub-chat-msg-acts");
                if (span) span.insertAdjacentHTML("beforeend",
                    `<button type="button" class="hub-chat-mact" data-act="regen" data-i="${i}" title="${msg.role === "user" ? "Generate the answer for this request" : "Regenerate this answer (the old one stays as a variant)"}">↻</button>`);
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
        img.draggable = false;
        stage.appendChild(img);
        // v91 (owner: "a picture opened from the chat does not MOVE with the
        // mouse - only the wheel zooms it; in the stack moving works in the
        // same mode"): the viewer now carries the EXACT stack-viewer
        // mechanics - wheel zoom keeps the point under the cursor stationary,
        // left-button drag PANS, double-click toggles fit <-> 1:1.
        let zoom = 1, tx = 0, ty = 0, oneToOne = false, dimsShown = false;
        const applyT = () => {
            img.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + zoom + ")";
        };
        const resetView = (native) => {
            zoom = 1; tx = 0; ty = 0; oneToOne = !!native;
            img.style.maxWidth = native ? "none" : "";
            img.style.maxHeight = native ? "none" : "";
            applyT();
        };
        stage.addEventListener("wheel", (e) => {
            e.preventDefault();
            const r = stage.getBoundingClientRect();
            const cx = e.clientX - r.left - r.width / 2;
            const cy = e.clientY - r.top - r.height / 2;
            const old = zoom;
            const nz = Math.min(8, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
            if (nz === old) return;
            tx = cx - (cx - tx) * (nz / old);
            ty = cy - (cy - ty) * (nz / old);
            zoom = nz;
            applyT();
        }, { passive: false });
        img.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const sx = e.clientX, sy = e.clientY, ox = tx, oy = ty;
            stage.classList.add("hub-stack-viewer-panning");
            const move = (ev) => {
                tx = ox + (ev.clientX - sx);
                ty = oy + (ev.clientY - sy);
                applyT();
            };
            const up = () => {
                window.removeEventListener("mousemove", move, true);
                window.removeEventListener("mouseup", up, true);
                stage.classList.remove("hub-stack-viewer-panning");
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, true);
        });
        stage.addEventListener("dblclick", () => resetView(!oneToOne));
        img.addEventListener("load", () => {
            if (dimsShown || !img.naturalWidth) return;
            dimsShown = true;
            metaEl.textContent = img.naturalWidth + "×" + img.naturalHeight +
                " · wheel: zoom · drag: pan · double-click: 1:1 ↔ fit";
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
// Header model dropdown (v88: the FULL list - the PolyStrata /api/models
// registry first, per-model status marks, a select SWITCHES the server)
// ---------------------------------------------------------------------------

function modelMark(status, id) {
    if (id && id === (cfg?.model || "")) return "● ";
    if (status === "loaded") return "● ";
    if (status === "loading") return "◐ ";
    return "○ ";
}

async function fillModels(manual) {
    // v88: GET /chat/models tries the PolyStrata /api/models registry FIRST
    // (ALL installed models + statuses - the way the NODES fill their
    // dropdowns), then /v1/models, then at least the current model.
    const res = await jfetch("/settings_hub/chat/models");
    if (res.json?.ok) {
        models = Array.isArray(res.json.models) ? res.json.models : [];
        modelsSource = res.json.source || "";
        const cur = cfg?.model || "";
        if (cur && !models.some((m) => m.id === cur)) {
            models.unshift({ id: cur, status: "" });
        }
        renderModelSel();
        degraded = null; renderNote();
        if (manual) localToast("Models: " + (models.map((m) => m.id).join(", ") || "(none)"));
    } else if (manual) {
        localToast("Model list failed: " + (res.json?.error || "HTTP " + res.status));
    }
    return res.json || { ok: false, error: "HTTP " + res.status };
}

function renderModelSel() {
    if (!modelSel) return;
    const cur = cfg?.model || "";
    const opts = [];
    if (!models.length) {
        opts.push(`<option value="${esc(cur)}">${cur ? esc(cur) : "(no model - ↻ refreshes the list)"}</option>`);
    } else {
        if (cur && !models.some((m) => m.id === cur)) {
            opts.push(`<option value="${esc(cur)}">${esc(cur)} (not in the list)</option>`);
        }
        for (const m of models) {
            const tail = m.id === cur ? " · selected"
                : (m.status === "loaded" ? " · loaded" : "");
            opts.push(`<option value="${esc(m.id)}"${m.id === cur ? " selected" : ""}>${modelMark(m.status, m.id)}${esc(m.id)}${tail}</option>`);
        }
    }
    modelSel.innerHTML = opts.join("");
}

/** v88: switch the upstream to an installed (not loaded) registry model -
 *  the /chat/load route speaks /api/models/load first (the node way; may
 *  take MINUTES on a big model), /v1/load on plain llama.cpp servers. */
async function switchModel(id) {
    const res = await jfetch("/settings_hub/chat/load", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
    });
    if (res.json?.ok) {
        localToast("Model switched: " + id);
        void fillModels(false);
    } else {
        localToast("Switch failed: " + (res.json?.error || "HTTP " + res.status));
    }
    return res.json;
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
    // v91: a MANUAL toggle is respected while the stream runs - the
    // auto-expand below never fights the user's own click.
    box.dataset.thinkUser = "1";
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
        const body = th.querySelector(".hub-chat-think-b");
        body.innerHTML = mdLite(streaming.thoughts);
        // v91 (owner: "the thinking block does not expand during generation"):
        // it AUTO-OPENS as soon as reasoning tokens arrive and keeps following
        // the text while the model thinks; after the answer lands the normal
        // re-render collapses it again (the historical look), and a manual
        // toggle during the stream always wins (toggleThink sets thinkUser).
        if (el.dataset.thinkUser !== "1") {
            body.style.display = "";
            const btn = th.querySelector(".hub-chat-think-t");
            if (btn) btn.textContent = "💭 thinking ▾";
        }
        try { body.scrollTop = body.scrollHeight; } catch (_) {}
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
        setStatusErr("No LLM server configured - ⚙ in the chat header");
        localToast("No LLM server configured - press ⚙ in the chat header");
        return;
    }
    const wantStream = !!(cfg?.stream ?? true);
    setBusy(true);
    if (isEdit) editState = null;
    try {
        const body = { session: tab.id, stream: wantStream };
        if (isEdit) {
            // v91: the edit lands as a NEW BRANCH (the old wording + answers
            // stay) - edit_nid names the request; edit_index stays as the
            // legacy fallback for an old py.
            const nid = opts.editNid || (opts.editIndex != null ? tab.msgs[opts.editIndex]?.nid : null);
            if (nid) body.edit_nid = nid;
            else if (opts.editIndex != null) body.edit_index = opts.editIndex;
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
        renderPromptBtnState();
        renderGpuBtnState();
        const r = cfg?.reasoning || "default";
        if (thinkSel) thinkSel.value = r;
    }
}

function buildDom() {
    panel = document.createElement("div");
    panel.className = "hub-chat-panel";
    panel.style.zIndex = Z_PANEL;
    panel.innerHTML =
        `<div class="hub-chat-head" title="Drag to move">` +
        `<span class="hub-chat-ico">💬</span><span class="hub-chat-title">Chat</span>` +
        `<span class="hub-chat-hspace"></span>` +
        `<button type="button" class="hub-btn hub-chat-settings" title="Chat settings (URL, key, sampling, limits, storage)">⚙</button>` +
        `<button type="button" class="hub-btn hub-chat-sessions" title="Saved chats - reopen or delete">🕘</button>` +
        `<button type="button" class="hub-btn hub-chat-clear" title="Clear THIS chat (click twice to confirm)">🗑</button>` +
        `<button type="button" class="hub-btn hub-chat-min" title="Minimize to chip">–</button>` +
        // v86: no [✕] close button - the panel is dismissed only via
        // ⚙ Hub settings → Chat → Off (the v75 stack contract).
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
        // v87: the toolbar UNDER the input - model (dropdown + refresh),
        // thinking mode, system prompt, GPU & memory - all "at hand".
        `<div class="hub-chat-toolbar">` +
        `<select class="hub-chat-model" title="Model - the full list comes from the LLM server (PolyStrata: ALL installed models)"></select>` +
        `<button type="button" class="hub-chat-tbbtn hub-chat-models" title="Refresh the model list (/api/models registry on a PolyStrata server, /v1/models otherwise)">↻</button>` +
        `<select class="hub-chat-think hub-chat-tbbtn" title="Thinking mode - none sends enable_thinking=false, low/medium/high send reasoning_effort">` +
        `<option value="default" title="The model's own default">think: default</option>` +
        `<option value="none" title="enable_thinking = false">think: off</option>` +
        `<option value="low">think: low</option>` +
        `<option value="medium">think: medium</option>` +
        `<option value="high">think: high</option>` +
        `</select>` +
        `<span class="hub-chat-tspace"></span>` +
        `<button type="button" class="hub-chat-tbbtn hub-chat-prompt" title="System prompt: none - click to set">📜</button>` +
        `<button type="button" class="hub-chat-tbbtn hub-chat-gpu" title="GPU & memory - model load/unload, VRAM reserve, ComfyUI cleanup">⚡</button>` +
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
    settingsBtn = panel.querySelector(".hub-chat-settings");
    thinkSel = panel.querySelector(".hub-chat-think");
    promptBtn = panel.querySelector(".hub-chat-prompt");
    gpuBtn = panel.querySelector(".hub-chat-gpu");
    modelsBtn = panel.querySelector(".hub-chat-models");

    // geometry
    lastDpr = curDpr();   // v87: zoom tracking starts from the CURRENT dpr
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
    settingsBtn.addEventListener("click", () => openSetPop());
    modelSel.addEventListener("change", () => {
        const v = modelSel.value;
        if (!v) return;
        const item = models.find((m) => m.id === v);
        void applyChatSettings({ model: v }).then((res) => {
            if (!res.ok) { localToast("Model not applied: " + (res.error || "?")); return; }
            renderStatus(); renderModelSel();
            // v88: a PolyStrata registry model that is NOT loaded must be
            // SWITCHED (the nodes' POST /api/models/load) - the chat stays
            // usable meanwhile; plain /v1/models servers just take the name.
            if (modelsSource === "registry" && item && item.status
                && item.status !== "loaded" && item.status !== "loading") {
                localToast("Switching to " + v + " - may take minutes…");
                void switchModel(v);
            } else {
                localToast("Model: " + v + " - it loads with the next message (⚡ can load it now)");
            }
        });
    });
    modelsBtn.addEventListener("click", () => void fillModels(true));
    thinkSel.addEventListener("change", () => {
        void applyChatSettings({ reasoning: thinkSel.value }).then((res) => {
            if (res.ok) localToast("Thinking: " + thinkSel.value);
            else localToast("Not applied: " + (res.error || "?"));
        });
    });
    promptBtn.addEventListener("click", () => openPromptPop());
    gpuBtn.addEventListener("click", () => openGpuPop());
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
            else void createTab(v);   // v87: the typed name IS the title
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
            // v91: the model's answer (a NEW sibling - the old one stays as a
            // variant) or a retry for a trailing user request.
            if (msg && (msg.role === "assistant" || msg.role === "user")) {
                void sendCurrent({ regenerate: true });
            }
        } else if (a === "edit") {
            // v91 (owner 8b): user messages edit into a NEW branch; the
            // model's replies edit IN PLACE.
            if (msg && (msg.role === "user" || msg.role === "assistant")) {
                editState = { idx: i };
                renderMsgs();
                try { msgsEl.querySelector(".hub-chat-edit-ta")?.focus(); } catch (_) {}
            }
        } else if (a === "edit-cancel") {
            editState = null;
            renderMsgs();
        } else if (a === "edit-send") {
            const ta = msgsEl.querySelector('.hub-chat-msg[data-i="' + i + '"] .hub-chat-edit-ta');
            void sendCurrent({ editIndex: i, editNid: msg?.nid, editText: ta ? ta.value : msg?.text });
        } else if (a === "edit-save") {
            // v91: the model's reply edited in place.
            const ta = msgsEl.querySelector('.hub-chat-msg[data-i="' + i + '"] .hub-chat-edit-ta');
            editState = null;
            void saveMsgText(tab, msg?.nid, ta ? ta.value : msg?.text);
        } else if (a === "var-prev" || a === "var-next") {
            // v91 (owner 8a): walk the variants; the branch switches WITH the
            // request. Locked while a generation is running.
            if (streaming) { localToast("Already generating - press ⏹ to stop first"); return; }
            void switchVariant(tab, act.dataset.nid, a === "var-next" ? 1 : -1);
        } else if (a === "fork") {
            // v91 (owner 8c): a new chat from this message (+ everything above).
            void forkFromMessage(tab, i);
        } else if (a === "del") {
            // v91 (owner 8b): armed two-click delete (message + subtree).
            const nid = act.dataset.nid || msg?.nid;
            if (!nid) { localToast("This message is too old to delete - reload the chat once"); return; }
            const now = Date.now();
            if (delArm && delArm.sid === tab.id && delArm.nid === nid && now - delArm.ts <= DEL_ARM_MS) {
                delArm = null;
                void deleteMsg(tab, nid);
                return;
            }
            delArm = { sid: tab.id, nid, ts: now };
            try { act.classList.add("hub-chat-mact-armed"); } catch (_) {}
            localToast("Click 🗑 again to DELETE this message and everything under it");
            setTimeout(() => { if (delArm?.nid === nid) delArm = null; }, DEL_ARM_MS);
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
    // v91: the native "LLM Chat panel" ComfyUI switch is gone - the MINI
    // PANEL (launcher) carries the SettingsHub rows now; register the panel
    // with it so [–] can collapse the chat INTO the bar.
    registerLauncherPanel("chat", {
        isOn: () => isChatOn(),
        setOn: (v) => setChatOn(v),
        isMin: () => !!(panel && panel.style.display === "none"),
        minimize: () => setMinimized(true),
        restore: () => setMinimized(false),
        showChip: () => {
            if (!panel || !chip || !isChatOn()) return;
            const ui = lsUi();
            applyChipPos(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16);
            chip.style.display = "";
        },
    });
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
                tabs.push({ id: sess.id, title: sess.title || "", msgs: sess.messages || [], tree: sess.tree || null, pending: [] });
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
    closeAllChatPops();   // v87: ⚙ / 📜 / ⚡ popups die with the panel
    try { panel?.remove(); } catch (_) {}
    try { chip?.remove(); } catch (_) {}
    try { window.removeEventListener("resize", onWinResize); } catch (_) {}
    panel = chip = headEl = tabEl = msgsEl = attachEl = inputEl = sendBtn = null;
    statusEl = noteEl = grip = modelSel = sessionsBtn = null;
    settingsBtn = thinkSel = promptBtn = gpuBtn = modelsBtn = null;
    tabs = [];
    activeId = null;
    serverState = null;
    degraded = null;
    editState = null;
    delArm = null;
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
        renderStatus,
        noteEl: () => noteEl,
        modelSelEl: () => modelSel,
        settingsBtnEl: () => settingsBtn,
        thinkSelEl: () => thinkSel,
        promptBtnEl: () => promptBtn,
        gpuBtnEl: () => gpuBtn,
        modelsBtnEl: () => modelsBtn,
        setPopEl: () => setPop,
        promptPopEl: () => promptPop,
        gpuPopEl: () => gpuPop,
        openSetPop, closeSetPop, openPromptPop, closePromptPop,
        openGpuPop, closeGpuPop, refreshGpuPop, gpuAction,
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
        sessQuery: () => sessQuery,
        setSessQuery: (q) => { sessQuery = q; },
        renderSessList,
        fmtTok,
        addFiles,
        clearPending,
        send: sendCurrent,
        stopStream: () => { try { streaming?.ctrl?.abort(); } catch (_) {} },
        streaming: () => (streaming ? { sid: streaming.sid, text: streaming.text, thoughts: streaming.thoughts } : null),
        // v91: branch/edit/delete/fork/export introspection for the smoke tests
        variantInfo,
        switchVariant,
        deleteMsg,
        saveMsgText,
        forkFromMessage,
        exportSession,
        importSessionFile,
        applySession,
        bubbleHtml,
        activePromptLabel,
        mdLite,
        openViewer: openChatViewer,
        closeViewer,
        viewerEl: () => viewerEl,
        cfg: () => (cfg ? { ...cfg } : null),
        models: () => models.map((m) => ({ ...m })),
        modelsSource: () => modelsSource,
        fillModels,
        switchModel,
        promptFiles: () => promptFiles.slice(),
        promptDir: () => promptDir,
        refreshPromptList,
        setPromptQuery: (q) => { promptQuery = q; renderPromptList(); },
        renderPromptList,
        probe: probeServer,
        setCfg: (c) => { cfg = c; },
        setServerState: (s) => { serverState = s; },
        mount: initChat,
        fireResize: onWinResize,
        setDpr: (v) => { lastDpr = v; },
    };
}



