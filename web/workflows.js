// ============================================================================
// SettingsHub - WORKFLOWS MANAGER (v106)
// ----------------------------------------------------------------------------
// v106 (owner feedback round 4):
//   1. the armed 🗑 delete on the BOTTOM preset card jumped the list scroll
//      to the very top (every arm/confirm re-rendered .hub-wf-body via
//      innerHTML - the fresh .hub-wf-scroll started at scrollTop 0), so the
//      second confirming click needed a scroll hunt back down. renderAll now
//      KEEPS the scroll anchor of the same tab (and ONLY the same tab - real
//      tab switches still start at the top). The same class of jumps died at
//      the other armed confirms (single ✕, Show more, ⚙ search-as-you-type
//      re-renders, the save-form Select/Deselect all);
//   2. clicking a closed TEMP process in 🕘 Recently closed fired
//      GET /userdata/workflows/Unsaved Workflow (3).json -> 404 (and even a
//      garbage "... (2).null" path - ComfyUI builds unsaved-tab paths with a
//      null extension): a temp tab has NO real file behind it, reopening by
//      path can never work. The close now EMBEDS a graph snapshot of the temp
//      tab into its recent entry (the same payload the presets use), the
//      reopen restores it via the snapshot ladder instead of a userdata
//      fetch; a temp tab whose graph cannot be serialized (or that is empty /
//      over the size cap) is not recorded at all - a recent row always
//      reopens SOMETHING. The persisted tabs keep the path reopen; a modified
//      saved tab also embeds its unsaved state, so the reopen shows what the
//      user actually saw, not the stale disk file. Legacy localStorage
//      entries with the ".null" garbage paths are pruned on boot;
//
// v105 (owner feedback round 3):
//   1. "Close all" - the 🧹 Close menu (the Open tab) closes EVERY open tab
//      while the pinned 📌 stay; unsaved tabs inside the batch need the armed
//      second click (the panel owns the confirm UX, never a silent loss);
//   2. presets were EMPTY on a fresh page load / a new browser tab until a
//      new preset was saved: the boot-time presets fetch is one-shot - a
//      transient failure (the server still busy serving the page) was never
//      retried and nothing re-rendered. The list now has presetsLoaded + an
//      auto-retry (poll tick + every Presets-tab open), the tab shows
//      "Reading presets…" instead of the misleading "No presets yet";
//   3. the Open-tab button row grew a 5th button - Close saved, Close other
//      saved and the new Close all moved into ONE 🧹 Close ▾ dropdown (the
//      row stays [Close ▾] [Save all] [+ Save preset]); the items keep the
//      full-word labels + tooltips, so nothing got less discoverable;
//   4. "saved a preset and still only presets.json" = the PY half of the
//      pack only activates on a ComfyUI RESTART - a page refresh updates the
//      web half (v104 in the banner) while the server keeps the old
//      single-file store. The health probe now compares the server version
//      against this web build and the panel shows a red note naming the
//      exact problem ("RESTART ComfyUI ..." / "hard refresh ..."), plus the
//      presets status line shows the live "srv vNNN" so the restart is
//      verifiable at a glance.
//
// v104 (owner decision on the storage layout):
//   ONE FILE PER PRESET on the server - presets/<id>.json inside the storage
//   root instead of the single presets.json array (tabs are many, temp
//   snapshots are large, and a single file made every transfer
//   all-or-nothing). Copying one presets/<id>.json into another machine's
//   presets/ folder transfers exactly that preset - the file is picked up on
//   the next read, no export/import round-trip. The temp-snapshot graphs
//   STAY EMBEDDED INSIDE the preset file (as they were); the legacy
//   v101-v103 presets.json is split into per-preset files by a one-time
//   automatic migration that renames the original to presets.json.bak
//   (never deleted). The routes and payloads are UNCHANGED - only the
//   server-side layout moved, so the panel code needed no logic fixes.
//
// v103 (owner feedback round 2):
//   1. the resize GRIP of the stack/chat panels now wears the workflows
//      marker (the border corner + hover highlight) - styles.css;
//   2. (answer) presets + embedded temp snapshots live in ONE server file -
//      <user>/settings_hub/workflows/presets.json; the 🕘 recently-closed
//      ring buffer is browser localStorage, not the server;
//   3. the Files "🕘 Recently closed" group was capped at 30% WITHOUT
//      overflow - 15 rows painted straight over "All saved workflows". The
//      group now scrolls INSIDE its cap;
//   4. (answer) the radio in the save form picks the preset's activePath -
//      the tab that ▶ Switch focuses on the canvas after the apply; temp
//      rows are disabled there (a snapshot has no file path);
//   5. the save form got the Select all / Deselect all toggle (one dynamic
//      button - unchecked rows exist => "Select all", else "Deselect all");
//   6. the Open tab got the same multi-word filter as Presets/Files (name +
//      path, pinned above the list, Esc clears).
//
// v102 (owner feedback on v101 - six fixes):
//   1. the ⚙ settings popup no longer stretches across the whole screen (the
//      width cap of the stack/chat settings pops);
//   2. the status bar is PINNED at the bottom - the lists scroll in their own
//      .hub-wf-scroll container instead of dragging the status under them;
//   3.+5. THE BIG ONE: activating a workflow now swaps the CANVAS. The
//      frontend's own tab click is workflowService.openWorkflow ->
//      app.loadGraphData(..., workflow) -> afterLoadNewGraph ->
//      store.openWorkflow; calling the store's openWorkflow DIRECTLY (v101
//      rung 1) only flipped the tab-strip state - the canvas kept the old
//      graph. Every activation / open-by-path / snapshot-open now goes
//      through app.loadGraphData with the workflow object (or the bind path);
//   4. "Save new" with temp tabs checked works: a temp tab that was never
//      activated has no changeTracker/activeState - its graph is read from
//      the store's in-memory content/originalContent strings;
//   6. the Files-tab search toolbar is pinned above the scroll container and
//      stays visible while the file list scrolls;
//   + parity fixes: closing the ACTIVE tab focuses a neighbor first and an
//   empty workspace re-opens a blank tab (the frontend service semantics),
//   and /userdata opens bind to the saved file instead of forking an orphan
//   unsaved copy.
//
// v101 (owner plan: "Workflows / Workspace Manager"): a standalone utility
// over ALL the open ComfyUI workflows - NOT bound to a SettingsHub node on
// the canvas. The floating panel:
//   * saves the set of open workflow tabs as a PRESET (named, favoritable,
//     path items + optional SNAPSHOT items for temporary/unsaved tabs);
//   * applies a preset with a smart diff (Replace with an apply-plan preview
//     + 1-level Undo, or Append = open the missing tabs only) - tabs whose
//     file is already open are NEVER closed or reloaded;
//   * closes workflows in bulk (Close saved / Close other saved) while
//     PROTECTING unsaved tabs, locked (📌) tabs and empty-temp handling;
//   * a 🕘 recent-closed ring buffer, a flat multi-word search over all the
//     saved workflow files, "Save all modified", JSON export/import;
//   * warns before mass operations while the ComfyUI queue is running;
//   * a ⚙ popup with the v84-mechanics STORAGE FOLDER switch (the exact
//     contract of the stack storage root: absolute paths only, probed
//     writable BEFORE the switch, the override file lives in the DEFAULT
//     user dir, changing the root NEVER moves presets).
//
// The access to ComfyUI's tabs is encapsulated in an ADAPTER LADDER (the
// nav_points.js enterOwnerGraph precedent): the frontend workflow store API
// changed between builds (Pinia `app.extensionManager.workflow` vs commands),
// so every operation tries the modern store first and falls back through
// commands / the native /userdata endpoint. A missing rung answers
// {ok:false, ...} with a readable toast - the panel degrades, ComfyUI never
// breaks.
//
// Storage: py/workflows_store.py - <user>/settings_hub/workflows/ with ONE
// file per preset (presets/<id>.json, v104) by default, the root is
// re-pointable. The panel probes /settings_hub/workflows/health first and
// names the exact problem when the routes are missing (an old py/ = update
// the FULL pack).
// ============================================================================

import { app } from "../../scripts/app.js";
import { launcherHostsMinimized, launcherSetCollapsed, registerLauncherPanel } from "./launcher.js";
import { getUiFontScale, setUiFontScale, UI_FONT_SCALE_CHOICES, uiFontScaleLabel } from "./global_settings.js";

// self-report (single-source version, docs/plan-versions.md): the stamp
// of the LAST functional change of this file - the entry's EXPECTED manifest
// verifies it.
// v105: this build's OWN stamp (the mismatch check against /health). The
// release rule keeps WORKFLOWS_SERVER_VERSION and __SettingsHubBuild equal,
// so "server older than this build" == "the py half is stale = restart".
const WF_WEB_VERSION = "v106";
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["workflows"] = "v106";

// ---------------------------------------------------------------------------
// Constants + tiny utils
// ---------------------------------------------------------------------------

const LS_ON = "settingshub.workflows.on";      // "1"/"0" - panel enabled
const LS_UI = "settingshub.workflows.ui";      // {x,y,w,h,min,chipX,chipY,tab}
const LS_PREF = "settingshub.workflows.pref";  // {keepUnsaved,closeEmptyTemp,warnOnQueue}
const LS_RECENT = "settingshub.workflows.recent"; // ring buffer of closed tabs
const Z_PANEL = "99900";               // same layer as the stack / chat panels
const RECENT_MAX = 15;
// v106: the reopen snapshots of temp tabs live in localStorage (~5MB per
// origin) - one huge graph must not crowd the other entries out; over-budget
// entries degrade to name-only from the OLDEST side (persistRecent)
const RECENT_SNAP_CAP = 400000;          // chars of JSON per single entry
const RECENT_BUDGET = 2500000;           // total chars of JSON across the ring
const ARM_MS = 2500;                   // double-click confirm window (✕ / 🗑)
const TAB_SEQ = 30;                    // ms between tab operations (ChangeTracker settle)
const ITEM_LIST_CAP = 12;              // preset card: items shown before "+N more"
const ROW_LIST_CAP = 60;               // open/files lists: rows per render chunk
const SHOW_MORE_STEP = 150;
const MAX_OPEN_ROWS = 400;             // hard cap of rendered rows (huge sessions)
const DEF_W = 320;
const DEF_H = 430;

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function verNum(s) {
    return parseInt(String(s || "").replace(/\D+/g, ""), 10) || 0;
}

function localToast(msg, ms = 2600) {
    try {
        const t = document.createElement("div");
        t.textContent = msg;
        t.className = "hub-sh-note";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms);
    } catch (_) {}
}

/** A toast with one action button (the "Switched · Undo" pattern). */
function actionToast(msg, actionLabel, onAction, ms = 6000) {
    try {
        const t = document.createElement("div");
        t.className = "hub-sh-note hub-wf-toast";
        const span = document.createElement("span");
        span.textContent = msg;
        t.appendChild(span);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "hub-wf-toast-act";
        b.textContent = actionLabel;
        b.addEventListener("click", () => {
            try { onAction?.(); } catch (e) { console.warn("[SettingsHub] workflows toast action:", e); }
            t.remove();
        });
        t.appendChild(b);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms);
    } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nextFrame() {
    return new Promise((r) => {
        try { requestAnimationFrame(() => r()); }
        catch (_) { setTimeout(r, 16); }
    });
}

function lsJson(key, def) {
    try {
        const v = JSON.parse(localStorage.getItem(key) || "null");
        return (v && typeof v === "object") ? v : def;
    } catch (_) { return def; }
}
function saveJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {}
}

function lsUi() { return lsJson(LS_UI, {}); }
function saveUi(patch) { saveJson(LS_UI, { ...lsUi(), ...patch }); }

function lsFlag(key, def) {
    try {
        const v = localStorage.getItem(key);
        return v == null || v === "" ? def : v === "1";
    } catch (_) { return def; }
}

// v101 preferences (the ⚙ Behavior rows)
const PREF_DEFAULT = { keepUnsaved: true, closeEmptyTemp: true, warnOnQueue: true };
function getPref() {
    const p = lsJson(LS_PREF, PREF_DEFAULT);
    return {
        keepUnsaved: p.keepUnsaved !== false,
        closeEmptyTemp: p.closeEmptyTemp !== false,
        warnOnQueue: p.warnOnQueue !== false,
    };
}
function setPref(patch) { saveJson(LS_PREF, { ...getPref(), ...patch }); }

function isWfOn() { return lsFlag(LS_ON, true); }
function setWorkflowsOn(v) {
    const was = isWfOn();
    try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (_) {}
    if (was && !v) {
        // a panel collapsed INTO the launcher must not become unreachable
        try { launcherSetCollapsed("workflows", false); } catch (_) {}
        teardown();
        localToast("Workflows panel hidden - bring it back: ComfyUI Settings → SettingsHub → 'Mini panel'.", 4200);
    } else if (!was && v) {
        initWorkflows();
    }
}

/** Normalize a workflow file path for comparisons (POSIX, no leading ./ or /). */
function normWfPath(p) {
    if (typeof p !== "string") return "";
    let s = p.replace(/\\/g, "/").trim();
    while (s.startsWith("./")) s = s.slice(2);
    while (s.startsWith("/")) s = s.slice(1);
    return s;
}

function baseName(p) {
    const s = normWfPath(p);
    return s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : (s || "Unsaved");
}

async function copyText(t) {
    try {
        await navigator.clipboard.writeText(t);
        return true;
    } catch (_) {
        try {
            const ta = document.createElement("textarea");
            ta.value = t;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) { return false; }
    }
}

// ---------------------------------------------------------------------------
// ComfyUI queue context - a generation running guards the mass operations
// ---------------------------------------------------------------------------

let queueRunning = false;
let queueHooked = false;
function watchQueue() {
    if (queueHooked) return;
    const api = app?.api;
    if (!api || typeof api.addEventListener !== "function") return;
    queueHooked = true;
    const on = (ev, fn) => {
        try { api.addEventListener(ev, fn); } catch (_) {}
    };
    on("execution_start", () => { queueRunning = true; });
    on("execution_success", () => { queueRunning = false; });
    on("execution_error", () => { queueRunning = false; });
    on("execution_interrupted", () => { queueRunning = false; });
    on("status", (e) => {
        try {
            const d = e?.detail;
            if (!d || typeof d !== "object") return;
            if (d.exec && typeof d.exec.running === "boolean") {
                queueRunning = !!d.exec.running;
            } else if (Array.isArray(d?.queue_remaining) && d.queue_remaining[1] > 0) {
                queueRunning = true;
            }
        } catch (_) {}
    });
}

// ---------------------------------------------------------------------------
// THE ADAPTER LADDER - every access to ComfyUI's workflow tabs goes through
// here. Rungs: the modern extensionManager.workflow store -> commands -> the
// native /userdata endpoint -> app.loadGraphData. Missing rungs answer
// {ok:false} - the panel degrades with a readable toast, ComfyUI never breaks.
// ---------------------------------------------------------------------------

function wfStoreOf() {
    try { return app?.extensionManager?.workflow || null; } catch (_) { return null; }
}

function nodeCountOf(wf) {
    try {
        const st = wf?.activeState;
        if (st && typeof st === "object") {
            if (Array.isArray(st.nodes)) return st.nodes.length;
            if (st.nodes instanceof Map) return st.nodes.size;
            if (st.nodes && typeof st.nodes === "object" && typeof st.nodes.size === "number") return st.nodes.size;
        }
        const g = wf?.graph ?? wf?.activeGraph;
        if (g) {
            if (Array.isArray(g._nodes)) return g._nodes.length;
            if (Array.isArray(g.nodes)) return g.nodes.length;
        }
    } catch (_) {}
    return null;
}

/** The graph JSON a store workflow object carries. The truth ladder:
 *  changeTracker.activeState (a LOADED tab keeps its state after the focus
 *  moved away - workflowService.beforeLoadNewGraph stores it) -> the store's
 *  in-memory content strings (a temp / never-activated tab has no tracker,
 *  v102: this is what makes snapshots of untouched temp tabs work). */
function storeWorkflowStateOf(wf) {
    try {
        const st = wf?.activeState;
        if (st && typeof st === "object") return st;
    } catch (_) {}
    for (const k of ["content", "originalContent"]) {
        try {
            const s = wf?.[k];
            if (typeof s === "string" && s) {
                const j = JSON.parse(s);
                if (j && typeof j === "object") return j;
            }
        } catch (_) {}
    }
    return null;
}

function storeWorkflowHasContent(wf) {
    for (const k of ["content", "originalContent"]) {
        try {
            const s = wf?.[k];
            if (typeof s === "string" && s) return true;
        } catch (_) {}
    }
    return false;
}

function storeWorkflowIsActive(wf) {
    const store = wfStoreOf();
    try { if (typeof store?.isActive === "function") return !!store.isActive(wf); } catch (_) {}
    try { return !!store && store.activeWorkflow === wf; } catch (_) {}
    return false;
}

/** THE ACTIVATION RUNG (v102). The frontend's own tab click is
 *  workflowService.openWorkflow -> app.loadGraphData(activeState, true, true,
 *  workflow) -> afterLoadNewGraph -> store.openWorkflow - the CANVAS swap is
 *  the loadGraphData call. Calling the store's openWorkflow DIRECTLY (the
 *  v101 activate rung) only flips the tab-strip state, so the manager showed
 *  the tab switched while the graph stayed the previous one. */
async function openStoreWorkflow(target) {
    if (!target) return { ok: false, error: "no tab" };
    if (storeWorkflowIsActive(target)) return { ok: true, via: "store", alreadyActive: true };
    // mirror workflowService.openWorkflow: load only a tab without in-memory
    // content (a persisted file opened in the background); the dialog flags
    // follow the service exactly
    const loadFromRemote = !target.isLoaded && !storeWorkflowHasContent(target);
    if (loadFromRemote && typeof target.load === "function") {
        try { await target.load(); } catch (_) { /* the state rungs may still hold the graph */ }
    }
    const state = storeWorkflowStateOf(target);
    if (state && typeof app?.loadGraphData === "function") {
        try {
            await app.loadGraphData(state, true, true, target, {
                showMissingModelsDialog: loadFromRemote,
                showMissingNodesDialog: loadFromRemote,
                checkForRerouteMigration: false,
            });
            return { ok: true, via: "loadGraphData" };
        } catch (_) { /* fall through to the state-only rung */ }
    }
    // very old / unusual builds without a callable loadGraphData - the
    // state-only open at least keeps the tab strip consistent
    const store = wfStoreOf();
    if (store && typeof store.openWorkflow === "function") {
        try { await store.openWorkflow(target); return { ok: true, via: "store" }; } catch (_) {}
    }
    return { ok: false, unsupported: true };
}

/** The normalized open-tab wrappers (ref, key, path, flags) - the panel NEVER
 *  touches the raw store objects outside this adapter. */
function getOpenWorkflows() {
    const store = wfStoreOf();
    let list = null;
    try { list = store?.openWorkflows ?? null; } catch (_) { list = null; }
    const arr = Array.isArray(list) ? list : [];
    const act = store?.activeWorkflow ?? null;
    const out = [];
    for (let idx = 0; idx < arr.length; idx++) {
        const wf = arr[idx];
        if (!wf) continue;
        let path = null;
        try { path = (typeof wf.path === "string" && wf.path) ? wf.path : null; } catch (_) { path = null; }
        let name = null;
        try { name = wf.filename || wf.name || null; } catch (_) { name = null; }
        if (!name && path) name = baseName(path);
        if (!name) name = "Unsaved";
        let isPersisted;
        if (typeof wf.isPersisted === "boolean") isPersisted = wf.isPersisted;
        else isPersisted = !!path && !wf.isTemporary;
        const isModified = !!wf.isModified;
        const isTemporary = !!wf.isTemporary || !isPersisted;
        const isActive = !!(wf === act || (path && act && act.path === path));
        const nodeCount = nodeCountOf(wf);
        const isEmpty = nodeCount === 0;
        let key = path || null;
        if (!key) {
            try { key = wf.key || wf.id || wf.filename || null; } catch (_) { key = null; }
        }
        if (!key) key = "#temp-" + idx;
        out.push({
            ref: wf, key: String(key), idx, path, name,
            isPersisted, isModified, isTemporary, isActive,
            nodeCount, isEmpty,
        });
    }
    return out;
}

/** All the saved workflow FILES (for the Files tab + the ⚠ missing marks).
 *  Rung 1: the frontend store registry; rung 2: the NATIVE /userdata endpoint
 *  (multi-user aware - reading the server folder directly is not). */
async function getSavedWorkflows() {
    const store = wfStoreOf();
    let list = null;
    try { list = store?.workflows ?? store?.persistedWorkflows ?? null; } catch (_) { list = null; }
    if (Array.isArray(list) && list.length) {
        const out = [];
        for (const w of list) {
            const p = w?.path || w?.fullPath || null;
            if (typeof p === "string" && p) out.push({ path: p, name: baseName(p) });
        }
        if (out.length) return out;
    }
    try {
        const r = await app.api.fetchApi("/userdata?dir=workflows&recurse=true&full_info=true");
        if (r && r.ok) {
            const j = await r.json();
            const items = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
            const out = [];
            for (const it of items) {
                if (typeof it === "string") {
                    const p = it.startsWith("workflows/") ? it : ("workflows/" + it);
                    out.push({ path: p, name: baseName(p) });
                } else if (it && typeof it === "object") {
                    const p = it.path || (it.name ? (it.name.startsWith("workflows/") ? it.name : "workflows/" + it.name) : null);
                    if (p) out.push({ path: p, name: baseName(p) });
                }
            }
            return out;
        }
    } catch (_) {}
    return [];
}

async function activateWorkflow(w) {
    if (!w) return { ok: false, error: "no tab" };
    // rung 1: the CANVAS-swap activation (the native tab-click path, v102)
    if (w.ref) {
        const r = await openStoreWorkflow(w.ref);
        if (r.ok) return r;
    }
    // rung 2: the frontend tab strip - click the tab with this name
    try {
        const cands = [...document.querySelectorAll(".comfy-workflow-tab, [class*='workflow'][class*='tab']")];
        const hit = cands.find((el) => (el.textContent || "").trim().startsWith(w.name));
        if (hit) { hit.click?.(); return { ok: true, via: "dom" }; }
    } catch (_) {}
    return { ok: false, unsupported: true };
}

/** Open a workflow FILE by its relative path (already-open tabs activate
 *  instead - a re-open must never reload a live tab). */
async function openWorkflowByPath(path) {
    const n2 = normWfPath(path);
    if (!n2) return { ok: false, error: "empty path" };
    // the store keys carry the workflows/ prefix, the presets may keep either
    // shape - compare against both
    const withPrefix = n2.startsWith("workflows/") ? n2 : ("workflows/" + n2);
    const already = getOpenWorkflows().find((t) => t.path &&
        (normWfPath(t.path) === n2 || normWfPath(t.path) === withPrefix));
    if (already) {
        const r = await activateWorkflow(already);
        return { ...r, alreadyOpen: true };
    }
    const store = wfStoreOf();
    let target = null;
    if (store && typeof store.getWorkflowByPath === "function") {
        for (const p of [n2, withPrefix]) {
            try {
                // some builds expose getWorkflowByPath as async - a bare call
                // would assign a PROMISE (truthy!) and poison the rung
                const t = store.getWorkflowByPath(p);
                target = (t && typeof t.then === "function") ? await t : t;
            } catch (_) { target = null; }
            if (target) break;
        }
    }
    if (!target) {
        try {
            const list = Array.isArray(store?.workflows) ? store.workflows : [];
            target = list.find((w) => w?.path && (normWfPath(w.path) === n2 || normWfPath(w.path) === withPrefix)) || null;
        } catch (_) {}
    }
    if (target) {
        const r = await openStoreWorkflow(target);
        if (r.ok) return r;
    }
    // rung 3: the native endpoint -> loadGraphData. The 4th arg BINDS the
    // loaded graph to the saved file (afterLoadNewGraph opens that tab) -
    // v102: without it the open forked an orphan UNSAVED copy of the file.
    try {
        const r = await app.api.fetchApi("/userdata/" + encodeURIComponent(withPrefix));
        if (!r || !r.ok) return { ok: false, missing: !!(r && r.status === 404) };
        const data = await r.json();
        await app.loadGraphData(data, true, true, n2.replace(/^workflows\//, ""));
        return { ok: true, via: "loadGraphData" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** Open a SNAPSHOT (an embedded graph JSON of a temporary tab). */
async function openSnapshotWorkflow(name, graphJson) {
    if (!graphJson || typeof graphJson !== "object") return { ok: false, error: "no graph" };
    const store = wfStoreOf();
    // rung 1: the store's own temporary-tab factory + the CANVAS-swap open
    // (v102: the bare store.openWorkflow left the new tab with the previous
    // graph on the canvas - "Add opened empty tabs")
    if (store && typeof store.createTemporary === "function") {
        try {
            const wf = await store.createTemporary(name || "Snapshot", graphJson);
            if (wf) {
                const r = await openStoreWorkflow(wf);
                if (r.ok) return r;
                return r; // the temp tab exists; a canvas swap was refused
            }
        } catch (_) {}
    }
    // rung 2: a new blank tab + loadGraphData
    try {
        try { await app.extensionManager?.command?.execute?.("Comfy.NewBlankWorkflow"); } catch (_) {}
        await sleep(TAB_SEQ);
        await nextFrame();
        await app.loadGraphData(graphJson, true, true);
        return { ok: true, via: "loadGraphData" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** The workflowService parity for closes: when the ACTIVE tab is being
 *  closed, the frontend loads a NEIGHBOR tab first (closeWorkflow ->
 *  loadNextOpenedWorkflow). Without it the tab strip loses its active entry
 *  and the canvas goes stale behind the panel's back. */
async function activateNeighborBeforeClose(w, store) {
    try {
        let active = false;
        try {
            active = typeof store.isActive === "function"
                ? !!store.isActive(w.ref)
                : (store.activeWorkflow === w.ref);
        } catch (_) {}
        if (!active) return;
        const others = getOpenWorkflows().filter((t) => t.key !== w.key);
        if (!others.length) return;
        // the tab that shifts into the closed slot = the native "next"
        const next = others[Math.min(w.idx ?? 0, others.length - 1)];
        await activateWorkflow(next);
    } catch (_) {}
}

/** The workspace must never end with zero tabs (the native service loads a
 *  blank/default workflow when the last one closes). */
async function ensureSomeTab() {
    try {
        if (getOpenWorkflows().length) return;
        await app.extensionManager?.command?.execute?.("Comfy.NewBlankWorkflow");
    } catch (_) {}
}

/** Close ONE tab. forceClean (default) skips the frontend's own unsaved
 *  warning - the PANEL owns the confirmation UX (armed ✕ / the apply plan). */
async function closeWorkflowTab(w, opts = {}) {
    if (!w) return { ok: false, error: "no tab" };
    const forceClean = opts.forceClean !== false;
    // v106: the reopen snapshot must be captured BEFORE the close - the store
    // may drop the content together with the ref
    const snap = (w.isTemporary || w.isModified) ? graphJsonOfOpenTab(w) : null;
    const store = wfStoreOf();
    if (store && typeof store.closeWorkflow === "function" && w.ref) {
        try {
            await activateNeighborBeforeClose(w, store);
            await store.closeWorkflow(w.ref, { warnIfUnsaved: !forceClean });
            recordRecent(w, snap);
            await ensureSomeTab();
            return { ok: true, via: "store" };
        } catch (_) {}
    }
    // rung 2: the command API (some builds expose close as a command)
    try {
        const cmd = app.extensionManager?.command;
        if (cmd && typeof cmd.execute === "function") {
            await activateWorkflow(w);
            await cmd.execute("Workspace.CloseWorkflow");
            recordRecent(w, snap);
            return { ok: true, via: "command" };
        }
    } catch (_) {}
    return { ok: false, unsupported: true };
}

/** Save ONE modified persisted tab ("Save all modified"). */
async function saveWorkflowTab(w) {
    if (!w) return { ok: false, error: "no tab" };
    if (!w.isPersisted || !w.isModified) return { ok: false, skipped: true };
    const store = wfStoreOf();
    if (store && typeof store.saveWorkflow === "function" && w.ref) {
        try { await store.saveWorkflow(w.ref); return { ok: true, via: "store" }; } catch (_) {}
    }
    try {
        await activateWorkflow(w);
        await app.extensionManager?.command?.execute?.("Comfy.SaveWorkflow");
        return { ok: true, via: "command" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** The serialized graph JSON of an open tab (the SNAPSHOT payload). */
function graphJsonOfOpenTab(t) {
    const wf = t?.ref;
    // v102 ladder: changeTracker.activeState (a LOADED tab - also the
    // non-active ones keep their stored state) -> the store's in-memory
    // content strings (a temp tab that was never activated has NO tracker -
    // this rung is what makes "check a temp row -> Save new" work) ->
    // graph.serialize -> app.graph (the ACTIVE tab only).
    const st = storeWorkflowStateOf(wf);
    if (st) {
        try { return JSON.parse(JSON.stringify(st)); } catch (_) {}
    }
    try {
        const g = wf?.graph;
        if (g && typeof g.serialize === "function") return JSON.parse(JSON.stringify(g.serialize()));
    } catch (_) {}
    // only the ACTIVE tab may fall back to app.graph
    try {
        if (t?.isActive && app?.graph && typeof app.graph.serialize === "function") {
            return JSON.parse(JSON.stringify(app.graph.serialize()));
        }
    } catch (_) {}
    return null;
}

// ---------------------------------------------------------------------------
// Server API (py/workflows_store.py v101)
// ---------------------------------------------------------------------------

let serverState = null;   // the /health answer (null = not probed yet)
let serverNote = null;    // {why} - a red note line under the tabs
let presetsLoaded = false; // v105: the presets GET has succeeded at least once
let probeSeq = 0;
let loadSig = "";         // v105: the retry render guard (no re-render churn)

function calcLoadSig() {
    return JSON.stringify([!!serverState, serverState?.version || "",
        serverNote?.why || "", presets.length, presetsLoaded]);
}

async function jfetch(url, opts = {}) {
    try {
        const r = await app.api.fetchApi(url, opts);
        const j = r ? await r.json().catch(() => null) : null;
        return { ok: !!(r && r.ok), status: r ? r.status : 0, json: j };
    } catch (e) {
        return { ok: false, status: 0, json: null, error: String((e && e.message) || e) };
    }
}

async function probeServer() {
    const seq = ++probeSeq;
    const res = await jfetch("/settings_hub/workflows/health");
    if (seq !== probeSeq) return;
    if (!res.json || !res.json.ok) {
        serverState = null;
        serverNote = {
            why: res.status === 404
                ? "The server has no /settings_hub/workflows routes (old py/) - update the FULL pack and RESTART ComfyUI."
                : ("Server unreachable (HTTP " + res.status + ") - presets need the server storage."),
        };
    } else {
        serverState = res.json;
        serverNote = null;
        // v105: the pack releases py + web together, so a server version
        // OLDER than this web build means the py half is still the previous
        // process (a page refresh only swaps the web half). Name the exact
        // problem instead of the mysterious "presets.json did not split":
        // the owner's v105 report - v104 web + v103 py kept saving the
        // legacy single-file store.
        const srv = String(serverState.version || "");
        if (srv && verNum(srv) !== verNum(WF_WEB_VERSION)) {
            serverNote = {
                why: verNum(srv) < verNum(WF_WEB_VERSION)
                    ? ("Server storage pack is " + srv + ", this web build is " + WF_WEB_VERSION +
                       " - RESTART ComfyUI to finish the update (the old server keeps the previous storage layout).")
                    : ("This web build (" + WF_WEB_VERSION + ") is older than the server pack (" + srv +
                       ") - the browser cached a stale file, hard refresh (Ctrl+F5)."),
            };
        }
    }
    loadSig = calcLoadSig();
    // v105: no renderAll here - the callers decide (the poll retry only
    // re-renders when the signature actually changed, so a red offline note
    // cannot steal the focus from a search input every 900 ms)
}

async function refreshPresets() {
    const res = await jfetch("/settings_hub/workflows/presets");
    if (res.json?.ok) {
        presets = Array.isArray(res.json.presets) ? res.json.presets : [];
        presetsLoaded = true;
        loadSig = calcLoadSig();
        return true;
    }
    if (res.status === 404) serverNote = { why: "The server has no /settings_hub/workflows routes (old py/) - update the FULL pack and RESTART ComfyUI." };
    loadSig = calcLoadSig();
    return false;
}

/** v105: one boot/retry pass - probe + presets read. The poll tick and the
 *  Presets-tab open call this while `!serverState || !presetsLoaded`, so a
 *  transient boot failure (the server busy serving the page, a hidden tab
 *  that mounted late) heals itself and the cards appear WITHOUT a save. */
async function loadServerState() {
    await probeServer();
    // a version-mismatch note does NOT block the read: an older-but-alive
    // server still serves its preset list (the note just says "restart")
    if (serverState) await refreshPresets();
    return !!(serverState && presetsLoaded);
}

async function savePreset(payload) {
    const res = await jfetch("/settings_hub/workflows/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (res.json?.ok) return { ok: true, preset: res.json.preset, mode: res.json.mode };
    return {
        ok: false,
        stale: res.status === 404,
        error: (res.json && res.json.error) || ("HTTP " + res.status),
        status: res.status,
    };
}

async function patchPreset(pid, fields) {
    const res = await jfetch("/settings_hub/workflows/preset/" + encodeURIComponent(pid), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
    if (res.json?.ok) return { ok: true, preset: res.json.preset };
    return { ok: false, stale: res.status === 404, error: (res.json && res.json.error) || ("HTTP " + res.status) };
}

async function deletePreset(pid) {
    const res = await jfetch("/settings_hub/workflows/preset/" + encodeURIComponent(pid), { method: "DELETE" });
    if (res.json?.ok) return { ok: true };
    return { ok: false, stale: res.status === 404, error: (res.json && res.json.error) || ("HTTP " + res.status) };
}

async function importPresets(payload) {
    const res = await jfetch("/settings_hub/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (res.json?.ok) return { ok: true, imported: res.json.imported, presets: res.json.presets };
    return { ok: false, stale: res.status === 404, error: (res.json && res.json.error) || ("HTTP " + res.status) };
}

async function getRootInfo() {
    const res = await jfetch("/settings_hub/workflows/root");
    return res.json && res.json.ok ? res.json : null;
}

/** Set the storage root ("" = back to the default). On success the preset
 *  list is re-read from the NEW root - files are NEVER moved (the v84
 *  contract). */
async function setRootPath(raw) {
    const res = await jfetch("/settings_hub/workflows/root", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: String(raw ?? "") }),
    });
    const j = res.json;
    if (res.ok && j && j.ok) {
        await refreshPresets();
        renderAll();
        localToast(j.custom
            ? "Workflow presets storage moved to: " + j.custom
            : "Workflow presets storage back to the default (user/settings_hub/workflows)");
        return { ok: true, ...j };
    }
    return {
        ok: false,
        stale: res.status === 404,
        error: (j && j.error) || ("HTTP " + (res.status || "?")),
    };
}

// ---------------------------------------------------------------------------
// Recently-closed ring buffer (🕘 Files & Recent)
// ---------------------------------------------------------------------------

let recent = lsJson(LS_RECENT, []);
if (!Array.isArray(recent)) recent = [];
sanitizeRecent(); // v106: drop the legacy ".null" garbage + unrestorable rows
/** v106: prune the reopen buffer to what can actually be reopened - a path
 *  entry needs a real file path (the ".null" suffix is the garbage ComfyUI
 *  builds for unsaved tabs, it can never exist in userdata), a temp entry
 *  needs its embedded snapshot. Runs on boot over the loaded localStorage
 *  and is exported for the tests. */
function sanitizeRecent() {
    const ok = (r) => r && typeof r === "object" &&
        (r.snap !== null && typeof r.snap === "object" ||
            (typeof r.path === "string" && r.path &&
                !r.path.toLowerCase().endsWith(".null")));
    recent = recent.filter(ok).slice(0, RECENT_MAX);
}

function reloadRecent() {
    const v = lsJson(LS_RECENT, []);
    recent = Array.isArray(v) ? v : [];
    sanitizeRecent();
    persistRecent();
}

function persistRecent() {
    // v106: the newest entries keep their snapshots, the older ones degrade
    // to path/name-only once the total JSON crosses RECENT_BUDGET (a hard
    // quota error would silently drop the WHOLE buffer - saveJson swallows)
    let used = 0;
    const list = recent.slice(0, RECENT_MAX).map((r) => {
        if (!r || !r.snap) return r;
        used += JSON.stringify(r.snap).length;
        return used > RECENT_BUDGET ? { path: r.path, name: r.name, ts: r.ts } : r;
    });
    saveJson(LS_RECENT, list);
}

/** The recently-closed ring. v106: a TEMP tab (no real file behind it - the
 *  autosave-ish "Unsaved Workflow (N).json" names never materialize in
 *  userdata, and the duplicate suffix builds "... (2).null") is recorded
 *  WITH the graph snapshot taken at close time and WITHOUT the fake path, so
 *  the 🕘 reopen restores the graph instead of 404-ing a userdata fetch. A
 *  modified PERSISTED tab embeds its unsaved state too - the reopen shows
 *  what was on screen, not the stale disk copy. Empty temps and snapshots
 *  over RECENT_SNAP_CAP are not recorded (a recent row must always open).
 *  snap is captured by closeWorkflowTab BEFORE the store drops the ref. */
function recordRecent(w, snap = null) {
    if (!w) return;
    const temp = !!w.isTemporary || !w.path;
    // a ".null" path is never a real file - treat the tab as temp-like
    const garbagePath = !!w.path && normWfPath(w.path).toLowerCase().endsWith(".null");
    const path = (!temp && !garbagePath) ? normWfPath(w.path) : null;
    const name = w.name || (path ? baseName(path) : "Unsaved");
    if (!path && (!snap || w.isEmpty)) return; // nothing reopenable - skip
    if (snap) {
        try { if (JSON.stringify(snap).length > RECENT_SNAP_CAP) snap = null; } catch (_) { snap = null; }
        if (!snap && !path) return;
    }
    const same = (r) => path ? r.path === path : (!r.path && r.name === name);
    recent = [{ path, name, ts: Date.now(), ...(snap ? { snap } : {}) },
        ...recent.filter((r) => !same(r))].slice(0, RECENT_MAX);
    persistRecent();
}

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

let panel = null;
let chip = null;
let mounted = false;
let initSeq = 0;
let presets = [];
let openTabs = [];
let savedFiles = [];       // lazily loaded (the Files tab + ⚠ missing marks)
let savedFilesLoaded = false;
let uiTab = "open";        // "open" | "presets" | "files"
let lockedKeys = new Set(); // 📌 session locks (in-memory only)
let sessionUndo = null;    // 1-level {paths, activePath}
let saveForm = null;       // the in-panel save dialog state
let armedClose = null;     // {key, t} - the armed single-✕ confirm
let armedDelete = null;    // {pid, t} - the armed preset 🗑 confirm
let armedCloseAll = null;  // v105: {t} - the armed Close-all confirm (unsaved in the batch)
let openRowsShown = ROW_LIST_CAP;
let fileRowsShown = ROW_LIST_CAP;
let fileSel = new Set();            // the Files-tab selection (normalized paths)
let chipMoved = false;              // the chip drag-vs-click discriminator
let presetsSearch = "";
let filesSearch = "";
let openSearch = "";       // v103: the multi-word filter of the Open tab
let pollT = null;
let pollSeq = 0;
let pollN = 0;
let lastOpenSig = "";
let lastLoadSig = "";      // v105: the retry render guard's last seen value
let renderedTab = null;    // v106: the scroll-keep guard's last rendered tab

function openHasPath(p) {
    const norm = normWfPath(p);
    return openTabs.some((t) => t.path && normWfPath(t.path) === norm);
}

function missingPathsOf(preset) {
    if (!savedFilesLoaded) return [];
    const known = new Set(savedFiles.map((f) => normWfPath(f.path)));
    // some builds keep the workflows/ prefix in one list but not the other
    const alt = new Set(savedFiles.map((f) => normWfPath(f.path).replace(/^workflows\//, "")));
    return (preset.items || [])
        .filter((it) => it.kind === "path")
        .filter((it) => {
            const n = normWfPath(it.path);
            return !known.has(n) && !alt.has(n.replace(/^workflows\//, ""));
        })
        .map((it) => it.path);
}

// ---------------------------------------------------------------------------
// THE APPLY PLAN - the smart diff of a preset switch (AGENTS.md: never close
// what is already a target tab, never lose unsaved work without consent)
// ---------------------------------------------------------------------------

function buildApplyPlan(preset, opts = {}) {
    const pref = getPref();
    const keepUnsaved = opts.keepUnsaved != null ? !!opts.keepUnsaved : pref.keepUnsaved;
    const itemPaths = (preset.items || [])
        .filter((it) => it.kind === "path")
        .map((it) => normWfPath(it.path));
    const open = getOpenWorkflows();
    const keep = [], close = [];
    for (const t of open) {
        const inPreset = !!(t.path && itemPaths.includes(normWfPath(t.path)));
        const locked = lockedKeys.has(t.key);
        const unsaved = t.isModified || !t.isPersisted;
        const emptyTemp = t.isEmpty && t.isTemporary && !t.isModified;
        let keepIt = inPreset || locked;
        if (!keepIt && unsaved) {
            // keepUnsaved protects modified/unsaved tabs; closeEmptyTemp (the
            // ⚙ preference) lets the empty 0-node untitled tabs go
            keepIt = keepUnsaved && !(pref.closeEmptyTemp && emptyTemp);
        }
        (keepIt ? keep : close).push(t);
    }
    const keptPaths = new Set(keep.filter((t) => t.path).map((t) => normWfPath(t.path)));
    const openPaths = new Set(open.filter((t) => t.path).map((t) => normWfPath(t.path)));
    const toOpenPaths = (preset.items || [])
        .filter((it) => it.kind === "path" && !keptPaths.has(normWfPath(it.path)));
    const toOpenSnaps = (preset.items || []).filter((it) => it.kind === "snapshot");
    return {
        preset, keep, close, toOpenPaths, toOpenSnaps,
        reopenClosed: toOpenPaths.filter((it) => openPaths.has(normWfPath(it.path))),
        missing: missingPathsOf(preset),
        keepUnsaved,
    };
}

function captureUndo() {
    const open = getOpenWorkflows();
    const act = open.find((t) => t.isActive) || null;
    sessionUndo = {
        paths: open.filter((t) => t.path).map((t) => t.path),
        activePath: act?.path || null,
        openedKeys: [],   // filled by applyPlan after the opens complete
        ts: Date.now(),
    };
}

async function applyPlan(plan) {
    const p = plan.preset;
    const preKeys = getOpenWorkflows().map((t) => t.key);
    captureUndo();
    let opened = 0, closed = 0, failed = [];
    // 1) open the missing targets FIRST (ComfyUI always keeps one live tab -
    //    opening before closing never leaves the workspace empty)
    for (const it of plan.toOpenPaths) {
        const r = await openWorkflowByPath(it.path);
        if (r.ok && !r.alreadyOpen) opened++;
        if (!r.ok) failed.push(it.path + (r.missing ? " (missing)" : ""));
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    for (const it of plan.toOpenSnaps) {
        const r = await openSnapshotWorkflow(it.name, it.graph);
        if (r.ok) opened++;
        if (!r.ok) failed.push((it.name || "snapshot") + " (snapshot)");
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    // 2) close what the plan retires
    for (const t of plan.close) {
        const r = await closeWorkflowTab(t, { forceClean: true });
        if (r.ok) closed++;
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    // 3) activate the preset's active tab
    if (p.activePath) {
        const norm = normWfPath(p.activePath);
        const t = getOpenWorkflows().find((x) => x.path && normWfPath(x.path) === norm);
        if (t) await activateWorkflow(t);
    }
    // remember which keys the apply ADDED - the undo retires exactly these
    // (still untouched) and brings the pre-apply set back
    if (sessionUndo) {
        sessionUndo.openedKeys = getOpenWorkflows()
            .filter((t) => !preKeys.includes(t.key)).map((t) => t.key);
    }
    await refreshOpen(true);
    renderAll();
    const miss = plan.missing.length ? " · ⚠ " + plan.missing.length + " missing" : "";
    const fail = failed.length ? " · " + failed.length + " failed (see F12)" : "";
    if (failed.length) console.warn("[SettingsHub] workflows apply failures:", failed);
    actionToast("Switched to '" + (p.name || "preset") + "' · opened " + opened +
        ", closed " + closed + miss + fail, "↩ Undo", () => void undoApply());
}

async function undoApply() {
    const u = sessionUndo;
    if (!u) { localToast("Nothing to undo"); return; }
    sessionUndo = null;
    const keep = new Set(u.paths.map(normWfPath));
    const openedByApply = new Set(u.openedKeys || []);
    // retire what the apply brought in (still untouched) - the tabs the user
    // had BEFORE the apply survive unless they were retired by it
    for (const t of getOpenWorkflows()) {
        if (lockedKeys.has(t.key)) continue;
        if (t.isModified) continue;   // never close touched work on undo
        if (t.path && keep.has(normWfPath(t.path))) continue;
        if (!openedByApply.has(t.key) && (t.isModified || (!t.isPersisted && !t.isEmpty))) {
            // a PRE-EXISTING unsaved/temp tab the plan kept - hands off
            continue;
        }
        await closeWorkflowTab(t, { forceClean: true });
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    // bring back the pre-apply set
    for (const path of u.paths) {
        if (!openHasPath(path)) {
            await openWorkflowByPath(path);
            await sleep(TAB_SEQ);
            await nextFrame();
        }
    }
    if (u.activePath) {
        const norm = normWfPath(u.activePath);
        const t = getOpenWorkflows().find((x) => x.path && normWfPath(x.path) === norm);
        if (t) await activateWorkflow(t);
    }
    await refreshOpen(true);
    renderAll();
    localToast("Restored the previous set of open workflows");
}

// ---------------------------------------------------------------------------
// Bulk operations (the Open tab)
// ---------------------------------------------------------------------------

async function closeSavedTabs(keepActive = false) {
    const act = getOpenWorkflows().find((t) => t.isActive);
    const victims = openTabs.filter((t) =>
        t.isPersisted && !t.isModified && !lockedKeys.has(t.key) &&
        // keepActive keeps the ACTIVE tab even when it is clean; a plain
        // Close saved does not spare it (it is just another clean saved tab)
        !(keepActive && (t.isActive || (act && t.key === act.key))));
    if (!victims.length) { localToast("No clean saved tabs to close"); return; }
    if (queueRunning && getPref().warnOnQueue) {
        localToast("⚠ A generation is running - the tabs still closed cleanly (saved + unmodified only).");
    }
    let closed = 0;
    for (const t of victims) {
        const r = await closeWorkflowTab(t, { forceClean: true });
        if (r.ok) closed++;
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    // the plan: Close saved ALSO retires the EMPTY untitled temp tabs when
    // the ⚙ preference allows it
    if (getPref().closeEmptyTemp) closed += await closeEmptyTempTabs();
    await refreshOpen(true);
    renderAll();
    localToast("Closed " + closed + " tab(s)" + (keepActive ? " (the active one stays)" : ""));
}

async function closeEmptyTempTabs() {
    const victims = openTabs.filter((t) =>
        t.isEmpty && t.isTemporary && !t.isModified && !lockedKeys.has(t.key));
    let closed = 0;
    for (const t of victims) {
        const r = await closeWorkflowTab(t, { forceClean: true });
        if (r.ok) closed++;
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    if (closed) { await refreshOpen(true); renderAll(); }
    return closed;
}

// v105: Close ALL open tabs - the pinned 📌 stay. Unsaved work inside the
// batch (modified saved tabs, non-empty temp tabs, and empty temps when the
// ⚙ preference keeps them) needs the armed second click - the same panel-
// owns-the-confirm contract as the single ✕ and the preset 🗑. Returns
// "closed" | "armed" | "empty" so the 🧹 menu keeps itself open while armed.
async function closeAllTabs() {
    const victims = openTabs.filter((t) => !lockedKeys.has(t.key));
    if (!victims.length) {
        localToast("Only pinned (📌) tabs are open - nothing to close");
        return "empty";
    }
    const risky = victims.filter((t) => t.isModified || (t.isTemporary && !t.isEmpty) ||
        (t.isTemporary && t.isEmpty && !getPref().closeEmptyTemp));
    if (risky.length && !armedCloseAll) {
        clearTimeout(armedCloseAll?.t);
        armedCloseAll = { t: setTimeout(() => { armedCloseAll = null; renderCloseMenu(); }, ARM_MS) };
        renderCloseMenu();
        localToast("⚠ " + risky.length + " unsaved tab(s) in the batch - click Close all AGAIN to confirm", 3600);
        return "armed";
    }
    clearTimeout(armedCloseAll?.t);
    armedCloseAll = null;
    if (queueRunning && getPref().warnOnQueue) {
        localToast("⚠ A generation is running - the tabs still closed (the pinned 📌 stayed).");
    }
    let closed = 0;
    for (const t of victims) {
        const r = await closeWorkflowTab(t, { forceClean: true });
        if (r.ok) closed++;
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    await refreshOpen(true);
    renderAll();
    localToast("Closed " + closed + " tab(s)" + (lockedKeys.size ? " (the pinned 📌 stayed)" : ""));
    return "closed";
}

async function closeOneTab(t) {
    const r = await closeWorkflowTab(t, { forceClean: true });
    if (!r.ok) {
        localToast(r.unsupported
            ? "This ComfyUI build does not expose a tab-close API - close the tab manually."
            : "Could not close the tab - see F12", 3600);
        return;
    }
    await refreshOpen(true);
    renderAll();
}

async function saveAllModified() {
    const victims = openTabs.filter((t) => t.isPersisted && t.isModified && !lockedKeys.has(t.key));
    if (!victims.length) { localToast("No modified saved tabs"); return; }
    let saved = 0, failed = 0;
    for (const t of victims) {
        const r = await saveWorkflowTab(t);
        if (r.ok) saved++; else failed++;
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    await refreshOpen(true);
    renderAll();
    localToast("Saved " + saved + " modified tab(s)" + (failed ? " · " + failed + " failed" : ""));
}

// ---------------------------------------------------------------------------
// Geometry (the stack.js / chat.js contract: saved x/y/w/h, clamped into the
// viewport on mount and on every resize, DPR-aware zoom rescaling)
// ---------------------------------------------------------------------------

function clampPos(x, y, el) {
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    const w = el?.offsetWidth || DEF_W, h = el?.offsetHeight || DEF_H;
    return {
        x: Math.min(Math.max(x, -w + 64), Math.max(8, vw - 64)),
        y: Math.min(Math.max(y, 0), Math.max(8, vh - 64)),
    };
}

function applyPos(x, y) {
    if (!panel) return;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
}

function applySize(w, h) {
    if (!panel) return;
    panel.style.width = Math.min(Math.max(w, 240), 620) + "px";
    panel.style.height = Math.min(Math.max(h, 200), 900) + "px";
}

function clampIntoView(x, y, el) {
    const p = clampPos(x, y, el);
    const w = el?.offsetWidth || DEF_W, h = el?.offsetHeight || DEF_H;
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    return {
        x: w + 16 <= vw ? Math.min(Math.max(p.x, 8), vw - w - 8) : p.x,
        y: h + 16 <= vh ? Math.min(Math.max(p.y, 8), vh - h - 8) : p.y,
    };
}

function applyChipPos(x, y) {
    if (!chip) return;
    chip.style.left = x + "px";
    chip.style.top = y + "px";
}

function setMinimized(min, persist = true) {
    if (!panel || !chip) return;
    const host = min && launcherHostsMinimized("workflows");
    panel.style.display = min ? "none" : "";
    chip.style.display = (min && host) ? "none" : (min ? "" : "none");
    if (min) {
        if (host) {
            try { launcherSetCollapsed("workflows", true); } catch (_) {}
        } else {
            const ui = lsUi();
            const c = clampIntoView(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16, chip);
            applyChipPos(c.x, c.y);
        }
    } else {
        try { launcherSetCollapsed("workflows", false); } catch (_) {}
    }
    if (persist) saveUi({ min: !!min });
}

function refitIntoView() {
    if (!panel || !chip) return;
    const ui = lsUi();
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    applySize(Math.min(ui.w ?? DEF_W, Math.max(240, vw - 24)),
        Math.min(ui.h ?? DEF_H, Math.max(200, vh - 24)));
    if (!ui.min) {
        const p = clampIntoView(ui.x ?? 16, ui.y ?? 90, panel);
        applyPos(p.x, p.y);
    } else {
        const c = clampIntoView(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16, chip);
        applyChipPos(c.x, c.y);
    }
}

let lastDpr = 0;
function curDpr() {
    try {
        const v = Number(window.devicePixelRatio);
        return Number.isFinite(v) && v > 0 ? v : 1;
    } catch (_) { return 1; }
}
let resizePersistT = null;
function onWinResize() {
    if (!panel || !chip) return;
    const ui = lsUi();
    const dpr = curDpr();
    const f = lastDpr ? dpr / lastDpr : 1;
    lastDpr = dpr;
    if (f && Math.abs(f - 1) >= 0.01) {
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
        if (u2.min) {
            const c = clampIntoView(u2.chipX ?? u2.x ?? 16, u2.chipY ?? u2.y ?? 16, chip);
            saveUi({ chipX: c.x, chipY: c.y });
        } else {
            const p = clampIntoView(u2.x ?? 16, u2.y ?? 90, panel);
            saveUi({ x: p.x, y: p.y });
        }
    }, 150);
}

function makeHeadDraggable() {
    const head = panel?.querySelector(".hub-wf-head");
    if (!head) return;
    let suppressClick = false;
    head.addEventListener("click", (e) => {
        if (!suppressClick) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    head.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.("button")) return; // the buttons stay clickable
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const ox = parseFloat(panel.style.left) || 0;
        const oy = parseFloat(panel.style.top) || 0;
        let moved = false;
        const move = (ev) => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
            moved = true;
            const p = clampPos(ox + dx, oy + dy, panel);
            applyPos(p.x, p.y);
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!moved) return;
            const p = clampPos(ox + (ev.clientX - startX), oy + (ev.clientY - startY), panel);
            applyPos(p.x, p.y);
            saveUi({ x: p.x, y: p.y });
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function makeGripResizable() {
    const grip = panel?.querySelector(".hub-wf-grip");
    if (!grip) return;
    grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const w0 = panel.offsetWidth, h0 = panel.offsetHeight;
        const move = (ev) => {
            const w = Math.min(Math.max(w0 + (ev.clientX - startX), 240), 620);
            const h = Math.min(Math.max(h0 + (ev.clientY - startY), 200), 900);
            applySize(w, h);
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            saveUi({ w: panel.offsetWidth, h: panel.offsetHeight });
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

function makeChipDraggable() {
    if (!chip) return;
    chipMoved = false;
    chip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const startX = e.clientX, startY = e.clientY;
        const ox = parseFloat(chip.style.left) || 0;
        const oy = parseFloat(chip.style.top) || 0;
        chipMoved = false;
        const move = (ev) => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!chipMoved && Math.abs(dx) + Math.abs(dy) < 5) return;
            chipMoved = true;
            applyChipPos(ox + dx, oy + dy);
        };
        const up = (ev) => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!chipMoved) return;
            const c = clampIntoView(ox + (ev.clientX - startX), oy + (ev.clientY - startY), chip);
            applyChipPos(c.x, c.y);
            saveUi({ chipX: c.x, chipY: c.y });
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    });
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const TAB_LABELS = [
    ["open", "Open", "The currently open workflow tabs"],
    ["presets", "Presets", "Saved workspace presets - switch / append / update"],
    ["files", "Files", "All saved workflow files + the recently closed buffer"],
];

function buildDom() {
    panel = document.createElement("div");
    panel.className = "hub-wf-panel";
    panel.style.zIndex = Z_PANEL;
    panel.innerHTML =
        `<div class="hub-wf-head" title="Drag to move">` +
        `<span class="hub-wf-ico">🗂</span><span class="hub-wf-title">Workflows</span>` +
        `<span class="hub-wf-count"></span>` +
        `<span class="hub-wf-hspace"></span>` +
        `<button type="button" class="hub-btn hub-wf-sett" title="Workflows panel settings (on/off, behavior, storage folder)">⚙</button>` +
        `<button type="button" class="hub-btn hub-wf-min" title="Minimize into the mini panel">–</button>` +
        // v75 contract: no [✕] close button - the panel is dismissed only via ⚙ → Off
        `</div>` +
        `<div class="hub-wf-note" style="display:none"></div>` +
        `<div class="hub-wf-tabs">` +
        TAB_LABELS.map(([id, label, tip]) =>
            `<button type="button" class="hub-wf-tab" data-wftab="${id}" title="${esc(tip)}">${label}</button>`).join("") +
        `</div>` +
        `<div class="hub-wf-body"></div>` +
        `<div class="hub-wf-grip" title="Drag to resize"></div>`;
    document.body.appendChild(panel);

    chip = document.createElement("div");
    chip.className = "hub-wf-chip";
    chip.style.zIndex = Z_PANEL;
    chip.innerHTML = `🗂`;
    chip.title = "Workflows - click to open, drag to move";
    chip.style.display = "none";
    document.body.appendChild(chip);

    // first-run: start minimized so an update never covers the screen - the
    // panel waits in the taskbar until the first click (the owner's plan)
    let firstRun = false;
    try { firstRun = localStorage.getItem(LS_UI) == null; } catch (_) {}
    if (firstRun) saveUi({ min: true });

    const ui = lsUi();
    uiTab = ["open", "presets", "files"].includes(ui.tab) ? ui.tab : "open";
    lastDpr = curDpr();
    applyPos(ui.x ?? Math.max(16, (window.innerWidth || 1600) - 380), ui.y ?? 90);
    applySize(ui.w ?? DEF_W, ui.h ?? DEF_H);
    setMinimized(!!ui.min, false);
    refitIntoView();

    makeHeadDraggable();
    makeGripResizable();
    makeChipDraggable();
    window.addEventListener("resize", onWinResize);

    panel.querySelector(".hub-wf-min").addEventListener("click", () => setMinimized(true));
    panel.querySelector(".hub-wf-sett").addEventListener("click", () => openWfSettingsPop());
    chip.addEventListener("click", () => {
        if (chipMoved) return; // a drag release is not a click
        chipMoved = false;
        setMinimized(false);
    });
    panel.querySelector(".hub-wf-tabs").addEventListener("click", (e) => {
        const b = e.target?.closest?.("[data-wftab]");
        if (b) setUiTab(b.dataset.wftab);
    });
    panel.querySelector(".hub-wf-body").addEventListener("click", (e) => void onBodyClick(e));
    panel.querySelector(".hub-wf-body").addEventListener("change", (e) => void onBodyChange(e));
    panel.querySelector(".hub-wf-body").addEventListener("input", (e) => void onBodyInput(e));
    panel.querySelector(".hub-wf-body").addEventListener("keydown", (e) => void onBodyKeydown(e));
}

function setUiTab(tab) {
    if (!["open", "presets", "files"].includes(tab)) return;
    if (uiTab === tab) return;
    uiTab = tab;
    saveUi({ tab });
    if (tab === "files" || tab === "presets") void refreshSavedFiles();
    renderAll();
    // v105: the presets list is loaded ONCE per session - a transient boot
    // failure used to leave the tab empty until a save happened. Opening the
    // Presets tab retries the read while it has never succeeded.
    if (tab === "presets" && !presetsLoaded) {
        void (async () => {
            await loadServerState();
            if (presetsLoaded) renderAll();
        })();
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtDate(ts) {
    try {
        const d = new Date((ts || 0) * 1000);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (_) { return ""; }
}

function openCountBadge() {
    const n = openTabs.length;
    const unsaved = openTabs.some((t) => t.isModified || !t.isPersisted);
    return n ? (n + (unsaved ? "*" : "")) : "";
}

function renderHead() {
    if (!panel) return;
    const c = panel.querySelector(".hub-wf-count");
    if (c) c.textContent = openCountBadge();
}

function renderTabs() {
    if (!panel) return;
    for (const b of panel.querySelectorAll(".hub-wf-tab")) {
        b.classList.toggle("hub-wf-tab-on", b.dataset.wftab === uiTab);
    }
}

function renderNote() {
    const el = panel?.querySelector(".hub-wf-note");
    if (!el) return;
    if (serverNote) {
        el.style.display = "";
        el.textContent = serverNote.why;
    } else {
        el.style.display = "none";
        el.textContent = "";
    }
}

function renderAll() {
    if (!panel) return;
    renderHead();
    renderTabs();
    renderNote();
    const body = panel.querySelector(".hub-wf-body");
    if (!body) return;
    // v106: a re-render of the SAME tab must not scroll-jump - the armed 🗑
    // on the bottom preset card (and the single ✕, Show more, the search
    // re-renders) used to reset .hub-wf-scroll to the top. A real tab switch
    // (renderedTab differs) still starts at the top.
    const keep = renderedTab === uiTab ? body.querySelector(".hub-wf-scroll")?.scrollTop || 0 : 0;
    if (uiTab === "open") body.innerHTML = openTabHtml();
    else if (uiTab === "presets") body.innerHTML = presetsTabHtml();
    else body.innerHTML = filesTabHtml();
    renderedTab = uiTab;
    if (keep) {
        const sc = body.querySelector(".hub-wf-scroll");
        if (sc) sc.scrollTop = keep;
    }
}

function openTabHtml() {
    const unsaved = openTabs.some((t) => t.isModified && t.isPersisted);
    // v103: the same multi-word filter the Presets/Files tabs have (tokens
    // over the name + the path; a token matches when the haystack contains it)
    const toks = openSearch.toLowerCase().split(/\s+/).filter(Boolean);
    // the haystack mirrors what the row SHOWS: the name, the file path and
    // the visible "temp" badge (typing temp finds the temporary tabs)
    const list = !toks.length ? openTabs : openTabs.filter((t) => {
        const hay = [t.name || "", t.path || "", t.isTemporary ? "temp" : ""].join(" ").toLowerCase();
        return toks.every((tok) => hay.includes(tok));
    });
    const rows = list.slice(0, MAX_OPEN_ROWS).map((t, i) => {
        if (i >= openRowsShown) return "";
        const locked = lockedKeys.has(t.key);
        const marks = [
            t.isActive ? `<span class="hub-wf-dot" title="Active">●</span>` : "",
            t.isModified ? `<span class="hub-wf-mod" title="Unsaved changes">*</span>` : "",
            t.isTemporary ? `<span class="hub-wf-temp" title="Not saved to disk yet">temp</span>` : "",
            t.isEmpty ? `<span class="hub-wf-empty" title="0 nodes">(empty)</span>` : "",
        ].join("");
        return `<div class="hub-wf-row${t.isActive ? " hub-wf-row-active" : ""}${locked ? " hub-wf-row-locked" : ""}" data-key="${esc(t.key)}">` +
            `<button type="button" class="hub-wf-name" data-act="activate" data-key="${esc(t.key)}" title="${esc(t.path || "temporary tab")}">${esc(t.name)}${t.isModified ? " *" : ""}</button>` +
            `<span class="hub-wf-marks">${marks}</span>` +
            `<button type="button" class="hub-wf-lockbtn${locked ? " hub-wf-locked" : ""}" data-act="lock" data-key="${esc(t.key)}" title="${locked ? "Unlock - allow mass close" : "Lock - protect from mass close (📌)"}">📌</button>` +
            `<button type="button" class="hub-wf-closebtn${armedClose?.key === t.key ? " hub-wf-armed" : ""}" data-act="close" data-key="${esc(t.key)}" title="${(t.isModified || t.isTemporary) ? (armedClose?.key === t.key ? "Click AGAIN to confirm closing the UNSAVED tab" : "Close (unsaved - click twice)") : "Close this tab"}">✕</button>` +
            `</div>`;
    }).join("");
    const more = list.length > openRowsShown
        ? `<button type="button" class="hub-wf-more" data-act="moreopen">Show more (${list.length - openRowsShown} hidden)</button>`
        : "";
    return `<div class="hub-wf-toolbar">` +
        // v103: the Open-tab search - pinned above the scroll like the Files
        // search; Esc clears (tokens match the tab name and its file path)
        `<input type="text" class="hub-wf-search" data-wf="opensearch" placeholder="filter: flux inpaint…" value="${esc(openSearch)}" spellcheck="false">` +
        `</div>` +
        // v105: ONE 🧹 Close dropdown instead of two fat buttons + the new
        // Close all - the row stays compact (Close ▾ / Save all / Save preset)
        // while the menu items keep the full-word labels + tooltips
        `<div class="hub-wf-acts">` +
        `<button type="button" class="hub-wf-act" data-act="closemenu" title="Mass close - pick what stays: saved clean tabs (📌 stay), other saved (the active stays too), or EVERYTHING except 📌">🧹 Close ▾</button>` +
        `<button type="button" class="hub-wf-act${unsaved ? "" : " hub-wf-dim"}" data-act="saveall" title="Save every modified tab that has a disk file">💾 Save all${unsaved ? " *" : ""}</button>` +
        `<button type="button" class="hub-wf-act" data-act="savepreset" title="Save the open tabs as a preset">＋ Save preset</button>` +
        `</div>` +
        // v102: the rows scroll INSIDE .hub-wf-scroll - the actions stay
        // pinned on top and the status bar stays pinned at the bottom (v101
        // scrolled the whole body, so the status slid under the list)
        `<div class="hub-wf-scroll">${rows || `<div class="hub-wf-emptylist">${toks.length ? "Nothing matches the filter" : "Nothing is open (or this ComfyUI build does not expose its tab list to extensions)"}</div>`}${more}</div>` +
        `<div class="hub-wf-status">${toks.length ? list.length + " of " : ""}${openTabs.length} open${unsaved ? " · unsaved work present" : ""}${queueRunning ? " · ⚠ generation running" : ""}</div>`;
}

function presetCardHtml(p) {
    const items = p.items || [];
    const shown = items.slice(0, ITEM_LIST_CAP);
    const rows = shown.map((it) => {
        if (it.kind === "snapshot") {
            return `<div class="hub-wf-item" title="Embedded snapshot of a temporary tab"><span class="hub-wf-item-ico">📄</span>${esc(it.name || "snapshot")} <span class="hub-wf-snap">(snapshot)</span></div>`;
        }
        const openNow = openHasPath(it.path);
        const missing = missingPathsOf(p).some((mp) => normWfPath(mp) === normWfPath(it.path));
        const marks = openNow ? `<span class="hub-wf-dot" title="Open now">●</span>` : (missing ? `<span class="hub-wf-missing" title="The file was not found among the saved workflows">⚠</span>` : "");
        return `<div class="hub-wf-item${openNow ? " hub-wf-item-open" : ""}" title="${esc(it.path)}"><span class="hub-wf-item-ico">🗃</span>${esc(it.name || baseName(it.path))}${marks}</div>`;
    }).join("");
    const more = items.length > ITEM_LIST_CAP
        ? `<div class="hub-wf-item hub-wf-item-more">+${items.length - ITEM_LIST_CAP} more…</div>` : "";
    const armed = armedDelete?.pid === p.id;
    return `<div class="hub-wf-card" data-pid="${esc(p.id)}">` +
        `<div class="hub-wf-card-head">` +
        `<button type="button" class="hub-wf-fav${p.fav ? " hub-wf-fav-on" : ""}" data-act="fav" data-pid="${esc(p.id)}" title="${p.fav ? "Unfavorite" : "Favorite - stays on top"}">${p.fav ? "★" : "☆"}</button>` +
        `<span class="hub-wf-card-name" title="${esc(p.name)}">${esc(p.name)}</span>` +
        `<span class="hub-wf-card-badge">${items.length} wf</span>` +
        `<span class="hub-wf-card-date">${esc(fmtDate(p.updated))}</span>` +
        `<span class="hub-wf-hspace"></span>` +
        `<button type="button" class="hub-wf-cbtn" data-act="rename" data-pid="${esc(p.id)}" title="Rename (Enter applies, Esc cancels)">✎</button>` +
        `<button type="button" class="hub-wf-cbtn" data-act="export1" data-pid="${esc(p.id)}" title="Export this preset as JSON (to the clipboard)">⤓</button>` +
        `<button type="button" class="hub-wf-cbtn${armed ? " hub-wf-armed" : ""}" data-act="del" data-pid="${esc(p.id)}" title="${armed ? "Click AGAIN to delete" : "Delete (click twice)"}">🗑</button>` +
        `</div>` +
        `<div class="hub-wf-card-items">${rows}${more}</div>` +
        `<div class="hub-wf-card-actions">` +
        `<button type="button" class="hub-wf-act" data-act="switch" data-pid="${esc(p.id)}" title="Close the other tabs and open exactly this preset (a plan preview first)">▶ Switch</button>` +
        `<button type="button" class="hub-wf-act" data-act="add" data-pid="${esc(p.id)}" title="Open the missing tabs of this preset, keep everything else">＋ Add</button>` +
        `<button type="button" class="hub-wf-act" data-act="update" data-pid="${esc(p.id)}" title="Update the preset from the currently open tabs (overwrite / merge)">↻ Update</button>` +
        `</div></div>`;
}

function saveFormHtml() {
    const f = saveForm;
    if (!f) return "";
    const rows = f.rows.map((r, i) => {
        const mark = r.isTemp
            ? `<span class="hub-wf-sf-snap">temp → snapshot</span>`
            : (r.isModified ? `<span class="hub-wf-sf-mod" title="The tab has unsaved changes">* (references disk file)</span>` : "");
        return `<label class="hub-wf-sf-row">` +
            `<input type="checkbox" data-wf-check="${i}"${r.checked ? " checked" : ""}>` +
            `<input type="radio" name="hub-wf-activeradio" data-wf-radio="${i}"${f.activeKey === r.key ? " checked" : ""}${r.isTemp ? " disabled title=\"A snapshot has no file path\"" : ""} title="Which file counts as the preset's active tab">` +
            `<span class="hub-wf-sf-name" title="${esc(r.path || "temporary tab")}">${esc(r.name)}${r.isModified && !r.isTemp ? " *" : ""}</span>${mark}` +
            `</label>`;
    }).join("");
    const target = f.mode === "update" ? (presets.find((p) => p.id === f.targetPid)?.name || "preset") : null;
    // v103: ONE dynamic toggle - any unchecked row => "Select all", otherwise
    // "Deselect all" (the owner asked for a single two-state button)
    const allChecked = f.rows.length > 0 && f.rows.every((r) => r.checked);
    return `<div class="hub-wf-saveform">` +
        `<div class="hub-wf-sf-title">${f.mode === "update" ? "Update '" + esc(target) + "'" : "Save current tabs as a preset"}</div>` +
        `<input type="text" class="hub-wf-sf-namein" data-wf="sfname" placeholder="Workspace ${presets.length + 1}" value="${esc(f.name || "")}" spellcheck="false">` +
        (f.rows.length
            ? `<div class="hub-wf-sf-tools"><button type="button" class="hub-wf-act" data-wf-btn="sftoggle" title="${allChecked ? "Uncheck every tab" : "Check every tab (temp tabs become snapshots)"}">${allChecked ? "Deselect all" : "Select all"}</button></div>`
            : "") +
        `<div class="hub-wf-sf-rows">${rows || `<div class="hub-wf-emptylist">Nothing is open</div>`}</div>` +
        `<div class="hub-wf-sf-acts">` +
        (f.hasModified ? `<button type="button" class="hub-wf-act" data-wf-btn="savemods" title="Save the modified tabs to their files first">💾 Save modified first</button>` : "") +
        (f.mode === "update"
            ? `<button type="button" class="hub-wf-act" data-wf-btn="overwrite">Overwrite</button>` +
              `<button type="button" class="hub-wf-act" data-wf-btn="merge" title="Merge: existing entries stay, new ones are appended (dedupe by path)">Merge into</button>`
            : `<button type="button" class="hub-wf-act" data-wf-btn="savenew">💾 Save new</button>`) +
        `<button type="button" class="hub-wf-act" data-wf-btn="cancelsave">✕ Cancel</button>` +
        `</div>` +
        `<div class="hub-wf-sf-hint">Checked rows go into the preset; temp tabs are embedded as SNAPSHOTS (unchecked by default). The radio picks the activePath.</div>` +
        `</div>`;
}

function presetsTabHtml() {
    const toks = presetsSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const list = !toks.length ? presets : presets.filter((p) => {
        const hay = [p.name || "", ...(p.items || []).map((it) => it.path || it.name || "")]
            .join(" ").toLowerCase();
        return toks.every((t) => hay.includes(t));
    });
    return `<div class="hub-wf-toolbar">` +
        `<input type="text" class="hub-wf-search" data-wf="presetsearch" placeholder="filter: multi-word…" value="${esc(presetsSearch)}" spellcheck="false">` +
        `<button type="button" class="hub-wf-act" data-act="savepreset" title="Save the current open tabs as a new preset">＋ Save current</button>` +
        `<button type="button" class="hub-wf-act" data-act="import" title="Import presets from JSON (paste)">⤒ Import</button>` +
        `<button type="button" class="hub-wf-act" data-act="exportall" title="Export ALL presets as JSON (to the clipboard)">⤓ Export all</button>` +
        `</div>` +
        (saveForm ? saveFormHtml() : "") +
        // v102: the cards scroll INSIDE .hub-wf-scroll - the search toolbar
        // and the save form stay pinned on top, the status bar at the bottom
        `<div class="hub-wf-scroll"><div class="hub-wf-list">${list.map(presetCardHtml).join("") ||
            `<div class="hub-wf-emptylist">${presets.length ? "Nothing matches the filter"
                // v105: never claim "No presets yet" while the list simply has
                // not been read (the boot fetch is retried every tick)
                : !presetsLoaded ? (serverState ? "Reading presets…" : "Server storage offline - presets cannot be read")
                : "No presets yet - arrange the open tabs and press ＋ Save current"}</div>`}</div></div>` +
        // v105: the status names the LIVE server pack version - the "I refreshed
        // the page and got v104 web but the py half is still the old process"
        // case becomes visible at a glance (srv v103 vs the banner v104)
        `<div class="hub-wf-status">${presets.length} preset(s)${!presetsLoaded && serverState ? " · reading…" : ""}` +
        `${serverState ? " · srv " + esc(serverState.version || "?") + (serverNote ? " ⚠" : "") : " · server storage offline"}</div>`;
}

function filesTabHtml() {
    // v106: temp tabs reopen from their embedded snapshot (no file path) -
    // the row is found by ts, carries a (snapshot) badge and its own tooltip
    const rec = recent.slice(0, RECENT_MAX).map((r) =>
        `<div class="hub-wf-row hub-wf-row-recent" data-path="${esc(r.path || "")}" data-rts="${esc(String(r.ts || 0))}">` +
        `<button type="button" class="hub-wf-name" data-act="reopen" data-path="${esc(r.path || "")}" data-rts="${esc(String(r.ts || 0))}" ` +
        `title="${r.snap ? "Snapshot - restores the tab as it was when closed" : esc(r.path || "")}">🕘 ${esc(r.name)}${r.snap && !r.path ? " <span class=\"hub-wf-snap\">(snapshot)</span>" : ""}</button>` +
        `<span class="hub-wf-marks"><span class="hub-wf-snap">${esc(fmtDate(Math.floor((r.ts || 0) / 1000)))}</span></span>` +
        `</div>`).join("");
    const toks = filesSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const list = !toks.length ? savedFiles : savedFiles.filter((f) => {
        const hay = normWfPath(f.path).toLowerCase();
        return toks.every((t) => hay.includes(t));
    });
    const rows = list.slice(0, fileRowsShown).map((f, i) => {
        const norm = normWfPath(f.path);
        const openNow = openHasPath(f.path);
        return `<div class="hub-wf-row${openNow ? " hub-wf-row-active" : ""}" data-fpath="${esc(f.path)}">` +
            `<input type="checkbox" class="hub-wf-fcheck" data-fcheck="${esc(f.path)}"${fileSel.has(norm) ? " checked" : ""} title="Select for Open selected / Save selected as preset">` +
            `<button type="button" class="hub-wf-name" data-act="openfile" data-path="${esc(f.path)}" title="${esc(f.path)}">${esc(f.name)}${openNow ? " ●" : ""}</button>` +
            `</div>`;
    }).join("");
    const more = list.length > fileRowsShown
        ? `<button type="button" class="hub-wf-more" data-act="morefiles">Show more (${list.length - fileRowsShown} hidden)</button>` : "";
    return `<div class="hub-wf-toolbar">` +
        // v102: the search + actions are PINNED above the scroll container -
        // the field stays visible while the file list scrolls (v101 put it
        // between the sections and it scrolled away with the body)
        `<input type="text" class="hub-wf-search" data-wf="filesearch" placeholder="filter: flux detail…" value="${esc(filesSearch)}" spellcheck="false">` +
        `<button type="button" class="hub-wf-act" data-act="openselected" title="Open every checked file">▶ Open selected</button>` +
        `<button type="button" class="hub-wf-act" data-act="saveselection" title="Save the checked files as a preset WITHOUT opening them">💾 Save selected as preset</button>` +
        `</div>` +
        `<div class="hub-wf-scroll">` +
        `<div class="hub-wf-sect">🕘 Recently closed</div>` +
        `<div class="hub-wf-list hub-wf-list-recent">${rec || `<div class="hub-wf-emptylist">Nothing closed yet</div>`}</div>` +
        `<div class="hub-wf-sect">All saved workflows</div>` +
        `<div class="hub-wf-list">${rows || `<div class="hub-wf-emptylist">${savedFilesLoaded ? "No saved workflow files found" : "Reading the workflow files…"}</div>`}${more}</div>` +
        `</div>` +
        `<div class="hub-wf-status">${savedFilesLoaded ? savedFiles.length + " file(s)" : "reading…"} · ${fileSel.size} selected</div>`;
}

// ---------------------------------------------------------------------------
// Body events (delegated; every action reads its target from data-*)
// ---------------------------------------------------------------------------

async function onBodyClick(e) {
    const btn = e.target?.closest?.("[data-act],[data-wf-btn]");
    if (!btn) return;
    const act = btn.dataset.act || btn.dataset.wfBtn;
    if (!act) return;
    const byKey = (k) => openTabs.find((t) => t.key === k);
    switch (act) {
        case "activate": {
            const t = byKey(btn.dataset.key);
            if (t) await activateWorkflow(t);
            await refreshOpen(true);
            renderAll();
            return;
        }
        case "lock": {
            const k = btn.dataset.key;
            if (lockedKeys.has(k)) lockedKeys.delete(k);
            else lockedKeys.add(k);
            renderAll();
            return;
        }
        case "close": {
            const t = byKey(btn.dataset.key);
            if (!t) return;
            // unsaved tabs need the 2500ms armed confirm - the panel owns the UX
            if (t.isModified || t.isTemporary) {
                if (!armedClose || armedClose.key !== t.key) {
                    clearTimeout(armedClose?.t);
                    armedClose = { key: t.key, t: setTimeout(() => { armedClose = null; renderAll(); }, ARM_MS) };
                    renderAll();
                    return;
                }
                clearTimeout(armedClose.t);
                armedClose = null;
            }
            await closeOneTab(t);
            return;
        }
        case "closesaved": return void closeSavedTabs(false);
        case "closeothers": return void closeSavedTabs(true);
        case "closeall": return void closeAllTabs();
        // v105: the 🧹 Close dropdown (Close saved / Close other saved /
        // Close all) - one anchored menu instead of a 5-button row
        case "closemenu": openCloseMenuPop(btn); return;
        case "saveall": return void saveAllModified();
        case "savepreset": openSaveForm("new"); return;
        // the in-panel save form buttons
        case "savenew": return void commitFormSave("create", null);
        case "overwrite": return void commitFormSave("overwrite", saveForm?.targetPid || null);
        case "merge": return void commitFormSave("merge", saveForm?.targetPid || null);
        case "cancelsave": { saveForm = null; renderAll(); return; }
        case "savemods": return void saveModifiedFromForm();
        // v103: the Select all / Deselect all toggle of the save form
        case "sftoggle": {
            if (!saveForm || !saveForm.rows.length) return;
            const allChecked = saveForm.rows.every((r) => r.checked);
            for (const r of saveForm.rows) r.checked = !allChecked;
            renderAll();
            return;
        }
        case "moreopen": openRowsShown += SHOW_MORE_STEP; renderAll(); return;
        case "morefiles": fileRowsShown += SHOW_MORE_STEP; renderAll(); return;
        case "switch": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) openPlanPop(p, btn);
            return;
        }
        case "add": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) void addPresetItems(p);
            return;
        }
        case "update": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) openSaveForm("update", p.id);
            return;
        }
        case "fav": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) {
                const r = await patchPreset(p.id, { fav: !p.fav });
                if (r.ok) { p.fav = !p.fav; await refreshPresets(); }
                else localToast("Could not update the favorite: " + (r.error || "?"));
                renderAll();
            }
            return;
        }
        case "rename": {
            const card = btn.closest(".hub-wf-card");
            if (card) startInlineRename(card, btn.dataset.pid);
            return;
        }
        case "export1": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) {
                const ok = await copyText(JSON.stringify(p, null, 2));
                localToast(ok ? "Preset '" + (p.name || "") + "' exported - JSON is in the clipboard"
                    + " (it also lives as presets/" + p.id + ".json in the storage folder)"
                    : "Could not copy - see F12");
            }
            return;
        }
        case "del": {
            const pid = btn.dataset.pid;
            if (!armedDelete || armedDelete.pid !== pid) {
                clearTimeout(armedDelete?.t);
                armedDelete = { pid, t: setTimeout(() => { armedDelete = null; renderAll(); }, ARM_MS) };
                renderAll();
                return;
            }
            clearTimeout(armedDelete.t);
            armedDelete = null;
            const r = await deletePreset(pid);
            if (r.ok) { await refreshPresets(); localToast("Preset deleted"); }
            else localToast("Could not delete: " + (r.error || "?"));
            renderAll();
            return;
        }
        case "import": openImportPop(); return;
        case "exportall": {
            const ok = await copyText(JSON.stringify({ settingsHubWorkflows: 1, presets }, null, 2));
            localToast(ok ? "Exported " + presets.length + " preset(s) - JSON is in the clipboard"
                : "Could not copy - see F12");
            return;
        }
        case "reopen": {
            // v106: a temp entry reopens from its EMBEDDED SNAPSHOT - never a
            // /userdata fetch (that was the 404 on "Unsaved Workflow (N)")
            const entry = recent.find((r) => String(r.ts || 0) === btn.dataset.rts)
                || recent.find((r) => r.path && r.path === btn.dataset.path);
            if (entry?.snap) {
                const r = await openSnapshotWorkflow(entry.name, entry.snap);
                if (!r.ok) localToast("Could not restore the snapshot - see F12");
            } else if (btn.dataset.path) {
                const r = await openWorkflowByPath(btn.dataset.path);
                if (!r.ok) localToast(r.missing ? "The file no longer exists" : "Could not open - see F12");
            } else {
                localToast("This temp tab was too large to keep a snapshot - it cannot be reopened");
            }
            await refreshOpen(true);
            renderAll();
            return;
        }
        case "openfile": {
            const r = await openWorkflowByPath(btn.dataset.path);
            if (!r.ok) localToast(r.missing ? "The file no longer exists" : "Could not open - see F12");
            await refreshOpen(true);
            renderAll();
            return;
        }
        case "openselected": {
            const paths = [...fileSel];
            if (!paths.length) { localToast("Nothing selected"); return; }
            let n = 0, miss = 0;
            for (const p of paths) {
                if (openHasPath(p)) continue;
                const r = await openWorkflowByPath(p);
                if (r.ok) n++; else if (r.missing) miss++;
                await sleep(TAB_SEQ);
                await nextFrame();
            }
            await refreshOpen(true);
            renderAll();
            localToast("Opened " + n + " workflow(s)" + (miss ? " · ⚠ " + miss + " missing" : ""));
            return;
        }
        case "saveselection": {
            const paths = [...fileSel];
            if (!paths.length) { localToast("Nothing selected"); return; }
            openNamePrompt("Save " + paths.length + " file(s) as a preset", "Selection " + (presets.length + 1),
                async (name) => {
                    const res = await savePreset({
                        name,
                        items: paths.map((p) => ({ kind: "path", path: p })),
                    });
                    if (res.ok) { await refreshPresets(); renderAll(); localToast("Preset '" + name + "' saved (" + paths.length + " files)"); }
                    else localToast("Could not save: " + (res.error || "?"), 3600);
                });
            return;
        }
        default: return;
    }
}

function onBodyChange(e) {
    const el = e.target;
    if (!el) return;
    if (el.matches("[data-wf-check]")) {
        const i = parseInt(el.dataset.wfCheck, 10);
        if (saveForm && saveForm.rows[i]) saveForm.rows[i].checked = el.checked;
        return;
    }
    if (el.matches("[data-wf-radio]")) {
        const i = parseInt(el.dataset.wfRadio, 10);
        if (saveForm && saveForm.rows[i]) saveForm.activeKey = saveForm.rows[i].key;
        return;
    }
    if (el.matches("[data-fcheck]")) {
        const norm = normWfPath(el.dataset.fcheck);
        if (el.checked) fileSel.add(norm);
        else fileSel.delete(norm);
        renderAll(); // refresh the "N selected" status line
        return;
    }
}

function onBodyInput(e) {
    const el = e.target;
    if (!el) return;
    if (el.matches('[data-wf="presetsearch"]')) {
        presetsSearch = el.value || "";
        // live filter without rebuilding the input itself (keeps the caret)
        const list = panel?.querySelector(".hub-wf-list");
        if (list) {
            const toks = presetsSearch.toLowerCase().split(/\s+/).filter(Boolean);
            const filtered = !toks.length ? presets : presets.filter((p) => {
                const hay = [p.name || "", ...(p.items || []).map((it) => it.path || it.name || "")]
                    .join(" ").toLowerCase();
                return toks.every((t) => hay.includes(t));
            });
            list.innerHTML = filtered.map(presetCardHtml).join("") ||
                `<div class="hub-wf-emptylist">${presets.length ? "Nothing matches the filter" : "No presets yet"}</div>`;
        }
        return;
    }
    if (el.matches('[data-wf="filesearch"]')) {
        filesSearch = el.value || "";
        fileRowsShown = ROW_LIST_CAP;
        renderAll();
        // restore the caret into the fresh input
        const inp = panel?.querySelector('[data-wf="filesearch"]');
        if (inp && inp !== document.activeElement) {
            try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
        }
        return;
    }
    if (el.matches('[data-wf="opensearch"]')) {
        // v103: the Open-tab filter - same live-refilter + caret restore
        // pattern as the Files search
        openSearch = el.value || "";
        openRowsShown = ROW_LIST_CAP;
        renderAll();
        const inp = panel?.querySelector('[data-wf="opensearch"]');
        if (inp && inp !== document.activeElement) {
            try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
        }
        return;
    }
    if (el.matches('[data-wf="sfname"]')) {
        if (saveForm) saveForm.name = el.value || "";
        return;
    }
}

function onBodyKeydown(e) {
    const el = e.target;
    if (!el) return;
    if (el.matches('[data-wf="presetsearch"], [data-wf="filesearch"], [data-wf="opensearch"]') && e.key === "Escape") {
        el.value = "";
        if (el.matches('[data-wf="presetsearch"]')) presetsSearch = "";
        else if (el.matches('[data-wf="opensearch"]')) openSearch = "";
        else filesSearch = "";
        renderAll();
        return;
    }
    if (el.matches('[data-wf="sfname"]')) {
        if (e.key === "Enter") {
            e.preventDefault();
            void commitFormSave(saveForm?.mode === "update" ? "overwrite" : "create", saveForm?.targetPid || null);
        } else if (e.key === "Escape") {
            e.preventDefault();
            saveForm = null;
            renderAll();
        }
    }
}

// ---------------------------------------------------------------------------
// The save form (in the Presets tab)
// ---------------------------------------------------------------------------

function nextWorkspaceName() {
    const taken = new Set(presets.map((p) => (p.name || "").toLowerCase()));
    let n = presets.length + 1;
    while (taken.has(("workspace " + n).toLowerCase())) n++;
    return "Workspace " + n;
}

function openSaveForm(mode = "new", targetPid = null) {
    const open = getOpenWorkflows();
    if (mode === "new" && !open.length) {
        localToast("No open tabs to save - open some workflows first");
        return;
    }
    const act = open.find((t) => t.isActive);
    saveForm = {
        mode,
        targetPid,
        name: mode === "update" ? (presets.find((p) => p.id === targetPid)?.name || "") : nextWorkspaceName(),
        rows: open.map((t) => ({
            key: t.key, name: t.name, path: t.path, tab: t,
            isTemp: !t.isPersisted,
            isModified: t.isModified,
            checked: !!t.isPersisted,   // temp rows opt IN (a snapshot decision)
        })),
        activeKey: (act?.isPersisted ? act.key : (open.find((t) => t.isPersisted)?.key || null)),
        hasModified: open.some((t) => t.isModified && t.isPersisted),
    };
    setUiTab("presets");
    if (uiTab !== "presets") { uiTab = "presets"; saveUi({ tab: "presets" }); } // setUiTab may no-op when equal
    openRowsShown = ROW_LIST_CAP;
    renderAll();
}

function collectFormItems() {
    if (!saveForm) return { error: "no form" };
    const items = [];
    let activePath = null;
    for (const r of saveForm.rows) {
        if (!r.checked) continue;
        if (r.isTemp) {
            const g = graphJsonOfOpenTab(r.tab);
            if (!g) return { error: "Could not serialize the temp tab '" + r.name + "'" };
            items.push({ kind: "snapshot", name: r.name, graph: g });
        } else {
            items.push({ kind: "path", path: r.path });
            if (saveForm.activeKey === r.key && !activePath) activePath = r.path;
        }
    }
    return { items, activePath };
}

/** "💾 Save modified first" inside the save form: saves every CHECKED
 *  modified persisted tab to its file, then refreshes the rows' * marks. */
async function saveModifiedFromForm() {
    if (!saveForm) return;
    let saved = 0;
    for (const r of saveForm.rows) {
        if (r.checked && !r.isTemp && r.isModified && r.tab) {
            const res = await saveWorkflowTab(r.tab);
            if (res.ok) saved++;
            await sleep(TAB_SEQ);
            await nextFrame();
        }
    }
    await refreshOpen(true);
    // refresh the rows' isModified from the live tabs (by key) - the form
    // stays open with the fresh marks
    const nowOpen = new Map(getOpenWorkflows().map((t) => [t.key, t]));
    for (const r of saveForm.rows) {
        const t = nowOpen.get(r.key);
        r.isModified = t ? t.isModified : r.isModified;
    }
    saveForm.hasModified = saveForm.rows.some((r) => r.isModified && !r.isTemp);
    renderAll();
    localToast("Saved " + saved + " modified tab(s)");
}

async function commitFormSave(mode, targetPid) {
    if (!saveForm) return;
    try {
        const nameIn = panel?.querySelector('[data-wf="sfname"]');
        const name = ((nameIn?.value ?? saveForm.name) || "").trim() || nextWorkspaceName();
        const c = collectFormItems();
        if (c.error) { localToast(c.error, 3600); return; }
        if (!c.items || !c.items.length) { localToast("Nothing checked - check at least one tab"); return; }
        const res = await savePreset({
            id: targetPid || undefined,
            name, items: c.items,
            activePath: c.activePath || undefined,
            mode: mode || "create",
        });
        if (res.ok) {
            saveForm = null;
            await refreshPresets();
            renderAll();
            localToast((mode === "merge" ? "Merged into '" : (mode === "overwrite" ? "Overwrote '" : "Saved preset '")) +
                name + "' (" + c.items.length + " item(s))");
        } else {
            localToast((res.stale
                ? "The server has no workflows routes (old py) - update the FULL pack and RESTART ComfyUI."
                : "Could not save the preset: " + (res.error || "?")), 4200);
        }
    } catch (e) {
        // a throw here used to vanish as an unhandled rejection - the owner
        // saw "nothing happens". Name the problem instead.
        localToast("Could not save the preset: " + String((e && e.message) || e), 4200);
    }
}

async function addPresetItems(p) {
    if (!p) return;
    let opened = 0, failed = 0, missing = 0;
    for (const it of (p.items || [])) {
        if (it.kind === "path") {
            if (openHasPath(it.path)) continue; // already there - never reload
            const r = await openWorkflowByPath(it.path);
            if (r.ok) opened++;
            else if (r.missing) missing++;
            else failed++;
        } else if (it.kind === "snapshot") {
            const r = await openSnapshotWorkflow(it.name, it.graph);
            if (r.ok) opened++; else failed++;
        }
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    await refreshOpen(true);
    renderAll();
    localToast("Added " + opened + " tab(s) from '" + (p.name || "preset") + "'" +
        (missing ? " · ⚠ " + missing + " missing" : "") + (failed ? " · " + failed + " failed" : ""));
}

function startInlineRename(card, pid) {
    const p = presets.find((x) => x.id === pid);
    const nameEl = card?.querySelector(".hub-wf-card-name");
    if (!p || !nameEl || nameEl.querySelector("input")) return;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = p.name || "";
    inp.className = "hub-wf-rename-in";
    inp.spellcheck = false;
    nameEl.textContent = "";
    nameEl.appendChild(inp);
    try { inp.focus(); inp.select(); } catch (_) {}
    let done = false;
    const commit = async () => {
        if (done) return;
        done = true;
        const nm = (inp.value || "").trim();
        if (nm && nm !== p.name) {
            const r = await patchPreset(p.id, { name: nm });
            if (r.ok) { p.name = nm; await refreshPresets(); }
            else localToast("Rename failed: " + (r.error || "?"));
        }
        renderAll();
    };
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done = true; renderAll(); }
        e.stopPropagation();
    });
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("blur", () => void commit());
}

// ---------------------------------------------------------------------------
// The apply-plan popover (▶ Switch) - the smart diff, visible BEFORE it runs
// ---------------------------------------------------------------------------

let planPop = null;

function closePlanPop() {
    try { planPop?.remove(); } catch (_) {}
    planPop = null;
    try { window.removeEventListener("mousedown", onPlanPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onPlanPopKey, true); } catch (_) {}
}
function onPlanPopDown(e) {
    if (!planPop || planPop.contains(e.target)) return;
    closePlanPop();
}
function onPlanPopKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePlanPop(); }
}

function openPlanPop(preset, anchorEl) {
    if (planPop) { closePlanPop(); return; }
    const plan = buildApplyPlan(preset);
    const names = (arr, cap = 8) => arr.slice(0, cap).map((x) => esc(x.name || x.path || "?")).join(", ") +
        (arr.length > cap ? " …+" + (arr.length - cap) : "");
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-planpop";
    pop.innerHTML =
        `<div class="hub-menu-title">Apply '${esc(preset.name || "preset")}'</div>` +
        (queueRunning && getPref().warnOnQueue
            ? `<div class="hub-wf-planwarn" title="Closing tabs while ComfyUI renders can interrupt the workflow UI state">⚠ A generation is running - applying a preset will switch tabs under it.</div>` : "") +
        `<div class="hub-wf-planrow"><span class="hub-wf-plan-cap hub-wf-plan-close">Will close: ${plan.close.length}</span>` +
        `<span class="hub-wf-plan-names">${plan.close.length ? names(plan.close) : "—"}</span></div>` +
        `<div class="hub-wf-planrow"><span class="hub-wf-plan-cap hub-wf-plan-keep">Stays: ${plan.keep.length}</span>` +
        `<span class="hub-wf-plan-names">${plan.keep.length ? names(plan.keep) + " (already open / unsaved / 📌)" : "—"}</span></div>` +
        `<div class="hub-wf-planrow"><span class="hub-wf-plan-cap hub-wf-plan-open">Will open: ${plan.toOpenPaths.length + plan.toOpenSnaps.length}</span>` +
        `<span class="hub-wf-plan-names">${names([...plan.toOpenPaths, ...plan.toOpenSnaps]) || "—"}` +
        (plan.missing.length ? ` <span class="hub-wf-missing">⚠ ${plan.missing.length} missing</span>` : "") +
        `</span></div>` +
        `<label class="hub-wf-plankeep"><input type="checkbox" data-wf="plankeep"${plan.keepUnsaved ? " checked" : ""}> Keep unsaved open</label>` +
        `<div class="hub-wf-planacts">` +
        `<button type="button" class="hub-wf-act hub-wf-plan-apply" data-wf-btn="planapply">Apply</button>` +
        `<button type="button" class="hub-wf-act" data-wf-btn="plancancel">Cancel</button>` +
        `</div>` +
        (plan.reopenClosed.length ? `<div class="hub-wf-planhint">${plan.reopenClosed.length} tab(s) are open but dirty and will be re-opened fresh from their files.</div>` : "") +
        `<div class="hub-wf-planhint">↩ Undo restores the previous set (one level).</div>`;
    document.body.appendChild(pop);
    planPop = pop;
    // anchor near the button, viewport-clamped
    try {
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        pop.style.maxHeight = Math.max(200, vh - 16) + "px";
        const r = anchorEl?.getBoundingClientRect?.();
        if (r && (r.width || r.height)) {
            const x = Math.min(Math.max(8, r.left), Math.max(8, vw - (pop.offsetWidth || 320) - 8));
            const y = Math.min(Math.max(8, r.bottom + 6), Math.max(8, vh - (pop.offsetHeight || 220) - 8));
            pop.style.left = x + "px";
            pop.style.top = y + "px";
        } else {
            pop.style.left = "16px";
            pop.style.top = "16px";
        }
    } catch (_) {}
    window.addEventListener("mousedown", onPlanPopDown, true);
    window.addEventListener("keydown", onPlanPopKey, true);
    pop.addEventListener("click", async (e) => {
        const b = e.target?.closest?.("[data-wf-btn]");
        if (!b) return;
        if (b.dataset.wfBtn === "plancancel") { closePlanPop(); return; }
        if (b.dataset.wfBtn === "planapply") {
            const keep = !!pop.querySelector('[data-wf="plankeep"]')?.checked;
            setPref({ keepUnsaved: keep });
            const fresh = buildApplyPlan(preset, { keepUnsaved: keep });
            closePlanPop();
            await applyPlan(fresh);
        }
    });
}


// ---------------------------------------------------------------------------
// The name prompt (Save selected as preset) - a tiny .hub-menu with a field
// ---------------------------------------------------------------------------

let namePop = null;

function closeNamePop() {
    try { namePop?.remove(); } catch (_) {}
    namePop = null;
    try { window.removeEventListener("keydown", onNamePopKey, true); } catch (_) {}
}
function onNamePopKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeNamePop(); }
}

function openNamePrompt(title, defName, onSubmit) {
    if (namePop) { closeNamePop(); return; }
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-namepop";
    pop.innerHTML =
        `<div class="hub-menu-title">${esc(title)}</div>` +
        `<input type="text" class="hub-wf-rename-in hub-wf-namepop-in" value="${esc(defName || "")}" spellcheck="false">` +
        `<div class="hub-wf-planacts">` +
        `<button type="button" class="hub-wf-act" data-wf-btn="ok">Save</button>` +
        `<button type="button" class="hub-wf-act" data-wf-btn="no">Cancel</button>` +
        `</div>`;
    document.body.appendChild(pop);
    namePop = pop;
    const inp = pop.querySelector("input");
    try { inp.focus(); inp.select(); } catch (_) {}
    window.addEventListener("keydown", onNamePopKey, true);
    const commit = async () => {
        const nm = (inp.value || "").trim();
        if (!nm) { inp.focus(); return; }
        closeNamePop();
        try { await onSubmit(nm); } catch (e) { console.warn("[SettingsHub] workflows name prompt:", e); }
    };
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
        e.stopPropagation();
    });
    pop.addEventListener("click", (e) => {
        const b = e.target?.closest?.("[data-wf-btn]");
        if (!b) return;
        if (b.dataset.wfBtn === "ok") void commit();
        else closeNamePop();
    });
}

// ---------------------------------------------------------------------------
// The import popup (⤒ Import) - paste the exported JSON
// ---------------------------------------------------------------------------

let importPop = null;

function closeImportPop() {
    try { importPop?.remove(); } catch (_) {}
    importPop = null;
    try { window.removeEventListener("keydown", onImportPopKey, true); } catch (_) {}
}
function onImportPopKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeImportPop(); }
}

function openImportPop() {
    if (importPop) { closeImportPop(); return; }
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-importpop";
    pop.innerHTML =
        `<div class="hub-menu-title">⤒ Import presets</div>` +
        `<div class="hub-wf-planhint">Paste the JSON of an ⤓ export (one preset or {presets: [...]}) - colliding ids become fresh ones.</div>` +
        `<textarea class="hub-wf-import-ta" rows="6" spellcheck="false" placeholder='{"presets": [...]}'></textarea>` +
        `<div class="hub-wf-planacts">` +
        `<button type="button" class="hub-wf-act" data-wf-btn="doimport">Import</button>` +
        `<button type="button" class="hub-wf-act" data-wf-btn="noimport">Cancel</button>` +
        `</div>`;
    document.body.appendChild(pop);
    importPop = pop;
    const ta = pop.querySelector("textarea");
    try { ta.focus(); } catch (_) {}
    window.addEventListener("keydown", onImportPopKey, true);
    pop.addEventListener("click", async (e) => {
        const b = e.target?.closest?.("[data-wf-btn]");
        if (!b) return;
        if (b.dataset.wfBtn === "noimport") { closeImportPop(); return; }
        if (b.dataset.wfBtn === "doimport") {
            let payload = null;
            try { payload = JSON.parse(ta.value || ""); } catch (_) { payload = null; }
            if (!payload || typeof payload !== "object") {
                localToast("Not valid JSON - nothing imported");
                return;
            }
            const r = await importPresets(payload);
            if (r.ok) {
                closeImportPop();
                await refreshPresets();
                renderAll();
                localToast("Imported " + r.imported + " preset(s)");
            } else {
                localToast("Import failed: " + (r.error || "?") +
                    (r.stale ? " - the server has no workflows routes (old py): update the FULL pack." : ""), 4200);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// v105: the 🧹 CLOSE MENU - one anchored dropdown on the Open tab instead of
// a 5-button row. Close saved / Close other saved keep their exact v101
// semantics; Close all closes everything except the pinned 📌 (the armed
// second click when unsaved tabs are in the batch). Outside-mousedown + Esc
// close, clamped into the viewport - the wfPop pattern.
// ---------------------------------------------------------------------------

let wfCloseMenu = null;

function closeWfCloseMenu() {
    clearTimeout(armedCloseAll?.t);
    armedCloseAll = null;
    try { wfCloseMenu?.remove(); } catch (_) {}
    wfCloseMenu = null;
    try { window.removeEventListener("mousedown", onCloseMenuDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onCloseMenuKey, true); } catch (_) {}
}
function onCloseMenuDown(e) {
    if (!wfCloseMenu || wfCloseMenu.contains(e.target)
        || panel?.querySelector('[data-act="closemenu"]')?.contains?.(e.target)) return;
    closeWfCloseMenu();
}
function onCloseMenuKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWfCloseMenu(); }
}

function closeMenuItemsHtml() {
    const victims = openTabs.filter((t) => !lockedKeys.has(t.key));
    const risky = victims.filter((t) => t.isModified || (t.isTemporary && !t.isEmpty) ||
        (t.isTemporary && t.isEmpty && !getPref().closeEmptyTemp));
    const armed = !!armedCloseAll && risky.length > 0;
    return `<div class="hub-menu-title">🧹 Mass close</div>` +
        `<button type="button" class="hub-wf-cmi" data-act="closesaved" ` +
        `title="Close every saved + unmodified tab (locks 📌 and the active tab stay)">🧹 Close saved<span class="hub-wf-cmi-sub">clean saved tabs · 📌 + active stay</span></button>` +
        `<button type="button" class="hub-wf-cmi" data-act="closeothers" ` +
        `title="Same, but the active tab stays even when it is clean">🧹 Close other saved<span class="hub-wf-cmi-sub">the active tab stays too</span></button>` +
        `<button type="button" class="hub-wf-cmi${armed ? " hub-wf-armed" : ""}" data-act="closeall" ` +
        `title="${armed ? "Click AGAIN to confirm - " + risky.length + " unsaved tab(s) will be closed" : "Close EVERY open tab; only the pinned 📌 stay" + (risky.length ? " (" + risky.length + " unsaved - confirms on the second click)" : "")}">` +
        (armed ? "⚠ Close all - click AGAIN" : "✕ Close all (📌 stay)") +
        `<span class="hub-wf-cmi-sub">${armed ? risky.length + " unsaved tab(s) in the batch" : "everything except the pinned"}</span></button>`;
}
function renderCloseMenu() {
    if (!wfCloseMenu) return;
    wfCloseMenu.innerHTML = closeMenuItemsHtml();
}
function openCloseMenuPop(anchorBtn) {
    if (wfCloseMenu) { closeWfCloseMenu(); return; }
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-closemenu";
    pop.innerHTML = closeMenuItemsHtml();
    document.body.appendChild(pop);
    wfCloseMenu = pop;
    // under the anchor button, clamped into the viewport (flip above when tight)
    try {
        const r = anchorBtn.getBoundingClientRect();
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        const w = pop.offsetWidth || 240, h = pop.offsetHeight || 130;
        const x = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
        let y = r.bottom + 6;
        if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);
        pop.style.left = x + "px";
        pop.style.top = y + "px";
    } catch (_) {}
    window.addEventListener("mousedown", onCloseMenuDown, true);
    window.addEventListener("keydown", onCloseMenuKey, true);
    pop.addEventListener("click", async (e) => {
        const b = e.target?.closest?.("[data-act]");
        if (!b) return;
        const act = b.dataset.act;
        if (act === "closeall") {
            // armed confirm lives INSIDE closeAllTabs - the menu stays open
            // while armed (its item re-renders with the ⚠ label)
            const r = await closeAllTabs();
            if (r !== "armed") closeWfCloseMenu();
            return;
        }
        closeWfCloseMenu();
        if (act === "closesaved") return void closeSavedTabs(false);
        if (act === "closeothers") return void closeSavedTabs(true);
    });
}

// ---------------------------------------------------------------------------
// ⚙ WORKFLOWS SETTINGS POPUP - the panel manages itself (the stack.js
// openStkSettingsPop pattern): ONE body-level .hub-menu, outside-mousedown +
// Esc close, clamped into the viewport. Includes the v84-mechanics STORAGE
// FOLDER switch (Enter applies, Esc reverts - the rule-4 contract).
// ---------------------------------------------------------------------------

let wfPop = null;

function closeWfPop() {
    try { wfPop?.remove(); } catch (_) {}
    wfPop = null;
    try { window.removeEventListener("mousedown", onWfPopDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onWfPopKey, true); } catch (_) {}
}
function onWfPopDown(e) {
    if (!wfPop || wfPop.contains(e.target)
        || panel?.querySelector(".hub-wf-sett")?.contains?.(e.target)) return;
    closeWfPop();
}
function onWfPopKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWfPop(); }
}

function openWfSettingsPop() {
    if (wfPop) { closeWfPop(); return; }
    const pref = getPref();
    // v90: font-scale options = quick picks ∪ current (a custom value keeps
    // its slot - the same contract as the hub / stack / chat ⚙ rows)
    const curFs = getUiFontScale();
    const fsChoices = [...new Set([...UI_FONT_SCALE_CHOICES, curFs])].sort((a, b) => a - b);
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-setpop";
    pop.innerHTML =
        `<div class="hub-menu-title">⚙ Workflows settings</div>` +
        `<label class="hub-cs-row"><span>Workflows panel</span>` +
        `<select class="hub-cs-sel" data-wf="on">` +
        `<option value="1">On (default)</option>` +
        `<option value="0">Off - hide the panel + chip</option>` +
        `</select></label>` +
        `<div class="hub-cs-info">Off hides the panel AND its chip. Bring it back: ` +
        `the mini panel (🗂 toggle) or ComfyUI Settings → SettingsHub → 'Mini panel'.</div>` +
        `<div class="hub-cs-sect">Behavior</div>` +
        `<label class="hub-cs-row hub-cs-check"><input type="checkbox" data-wf="keepunsaved">` +
        `<span>Keep unsaved open on preset switch (recommended)</span></label>` +
        `<label class="hub-cs-row hub-cs-check"><input type="checkbox" data-wf="closeemptytemp">` +
        `<span>Close empty untitled tabs (0 nodes, unmodified)</span></label>` +
        `<label class="hub-cs-row hub-cs-check"><input type="checkbox" data-wf="warnqueue">` +
        `<span>Warn when the ComfyUI queue is running</span></label>` +
        `<div class="hub-cs-sect">Interface</div>` +
        `<label class="hub-cs-row"><span>Font size (hub · stack · chat · workflows)</span>` +
        `<select class="hub-cs-sel" data-wf="font">` +
        fsChoices.map((p) => `<option value="${p}">${esc(uiFontScaleLabel(p))}</option>`).join("") +
        `</select></label>` +
        `<div class="hub-cs-sect">Storage folder (v84 mechanics)</div>` +
        `<div class="hub-cs-row"><span class="hub-cs-box">` +
        `<input type="text" class="hub-cs-in hub-cs-path" data-wf="root" ` +
        `placeholder="default: user/settings_hub/workflows" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="hub-cs-chip" data-wf-btn="rootdef">default</button></span></div>` +
        `<div class="hub-cs-info" data-wf="rootinfo"></div>` +
        `<div class="hub-cs-hint">Enter applies the folder, Esc reverts it. Switching the folder NEVER moves ` +
        `presets - each location keeps its own presets/ folder (ONE file per preset: ` +
        `presets/&lt;id&gt;.json - copy a file to transfer that preset); the root choice itself lives in the DEFAULT ` +
        `user folder (workflows_root.json). 🗑 on a preset card deletes it (click twice). Hidden panel: ` +
        `the mini panel (🗂) or ComfyUI Settings → SettingsHub → 'Mini panel'.</div>`;
    document.body.appendChild(pop);
    wfPop = pop;

    const onSel = pop.querySelector('[data-wf="on"]');
    onSel.value = isWfOn() ? "1" : "0";
    onSel.addEventListener("change", () => {
        const on = onSel.value === "1";
        setWorkflowsOn(on);   // Off tears the panel down; this popup dies with it
        if (on && wfPop) onSel.value = isWfOn() ? "1" : "0";
    });
    const ku = pop.querySelector('[data-wf="keepunsaved"]');
    const ce = pop.querySelector('[data-wf="closeemptytemp"]');
    const wq = pop.querySelector('[data-wf="warnqueue"]');
    ku.checked = pref.keepUnsaved;
    ce.checked = pref.closeEmptyTemp;
    wq.checked = pref.warnOnQueue;
    ku.addEventListener("change", () => setPref({ keepUnsaved: ku.checked }));
    ce.addEventListener("change", () => setPref({ closeEmptyTemp: ce.checked }));
    wq.addEventListener("change", () => setPref({ warnOnQueue: wq.checked }));
    const fsSel = pop.querySelector('[data-wf="font"]');
    fsSel.value = String(getUiFontScale());
    fsSel.addEventListener("change", () => {
        fsSel.value = String(setUiFontScale(fsSel.value));
    });

    const rootIn = pop.querySelector('[data-wf="root"]');
    const rootInfo = pop.querySelector('[data-wf="rootinfo"]');
    const rootApply = async () => {
        const res = await setRootPath(rootIn.value);
        if (res.ok) {
            rootIn.value = res.custom || "";
            rootIn.dataset.cur = rootIn.value;
            rootInfo.classList.remove("hub-cs-err");
            rootInfo.textContent = "Now: " + (res.root || "") +
                (res.custom ? " (custom)" : " (default)") +
                (res.saved === false ? " - could not save workflows_root.json (folder works for this session only)" : "");
        } else {
            rootInfo.classList.add("hub-cs-err");
            rootInfo.textContent = "Not applied: " + (res.error || "error") +
                (res.stale ? " - the server has no /workflows/root route (old py): update the FULL pack and RESTART ComfyUI." : "");
        }
    };
    rootIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void rootApply(); }
        else if (e.key === "Escape") {
            e.stopPropagation();
            rootIn.value = rootIn.dataset.cur || "";
            rootIn.blur();
        }
    });
    pop.querySelector('[data-wf-btn="rootdef"]').addEventListener("click", () => {
        rootIn.value = "";
        void rootApply();
    });
    void (async () => {
        const info = await getRootInfo();
        if (!info || !rootInfo.isConnected) return; // popup closed / old py
        rootIn.dataset.cur = info.custom || "";
        if (!rootIn.value) rootIn.value = info.custom || "";
        rootInfo.classList.remove("hub-cs-err");
        rootInfo.textContent = "Now: " + (info.root || "") +
            (info.custom ? " (custom)" : " (default)") +
            (info.writable === false ? " - NOT writable" : "");
    })();

    // place near the panel's ⚙ (viewport-clamped like the chat popups)
    try {
        const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
        pop.style.maxHeight = Math.max(200, vh - 16) + "px";
        const btn = panel?.querySelector(".hub-wf-sett");
        const r = btn?.getBoundingClientRect?.();
        if (r && (r.width || r.height)) {
            const x = Math.min(Math.max(8, r.left - 40), Math.max(8, vw - (pop.offsetWidth || 340) - 8));
            const y = Math.min(Math.max(8, r.bottom + 6), Math.max(8, vh - (pop.offsetHeight || 300) - 8));
            pop.style.left = x + "px";
            pop.style.top = y + "px";
        } else {
            pop.style.left = "16px";
            pop.style.top = "16px";
        }
    } catch (_) {}
    window.addEventListener("mousedown", onWfPopDown, true);
    window.addEventListener("keydown", onWfPopKey, true);
}

// ---------------------------------------------------------------------------
// Data refresh + the light poll (the tab list and the badges stay fresh)
// ---------------------------------------------------------------------------

function openSignature() {
    return openTabs.map((t) => [t.key, t.isActive ? 1 : 0, t.isModified ? 1 : 0,
        t.isPersisted ? 1 : 0, t.nodeCount].join("|")).join(";");
}

async function refreshOpen(force = false) {
    openTabs = getOpenWorkflows();
    if (force) lastOpenSig = openSignature();
}

async function refreshSavedFiles() {
    savedFiles = await getSavedWorkflows();
    savedFilesLoaded = true;
    fileSel = new Set([...fileSel].filter((p) => savedFiles.some((f) => normWfPath(f.path) === p)));
    // the tab may have rendered its "Reading the workflow files…" placeholder
    // while this was in flight - the completed list must land in the DOM
    if (uiTab === "files" || uiTab === "presets") renderAll();
}

async function pollTick() {
    if (!mounted || !panel || (typeof document !== "undefined" && document.hidden)) return;
    // v105: the server state + the preset list self-heal. The boot-time read
    // is one-shot - a transient failure (the server busy serving the page,
    // a hidden tab that mounted late) used to leave the Presets tab empty
    // until a save happened. Retry while the first successful read has not
    // landed; re-render ONLY when something actually changed (the red note
    // must not steal the focus from a search input every 900 ms).
    pollN++;
    if (!serverState || !presetsLoaded) {
        await loadServerState();
        if (loadSig !== lastLoadSig) {
            lastLoadSig = loadSig;
            renderAll();
        }
    } else if (pollN % 10 === 0) {
        // every ~9s: keep the srv version + the mismatch note live - the
        // owner restarts ComfyUI, and the note must clear WITHOUT a remount
        await probeServer();
        if (loadSig !== lastLoadSig) {
            lastLoadSig = loadSig;
            renderAll();
        }
    }
    await refreshOpen(false);
    const sig = openSignature();
    if (sig !== lastOpenSig) {
        lastOpenSig = sig;
        renderAll();
    } else {
        renderHead(); // the count badge + unsaved dot stay live
    }
}

// ---------------------------------------------------------------------------
// init / teardown + the launcher registration (the 4th taskbar item)
// ---------------------------------------------------------------------------

function badgeState() {
    const n = openTabs.length;
    const unsaved = openTabs.some((t) => t.isModified || !t.isPersisted);
    if (!n) return null;
    return { text: String(n), dot: unsaved };
}

export function initWorkflows() {
    if (!isWfOn()) return;
    // the launcher hooks register FIRST (the bar may already be mounted and
    // its 800ms tick reads them regardless of the panel's own state)
    registerLauncherPanel("workflows", {
        isOn: () => isWfOn(),
        setOn: (v) => setWorkflowsOn(v),
        isMin: () => !!(panel && panel.style.display === "none"),
        minimize: () => setMinimized(true),
        restore: () => setMinimized(false),
        badge: () => badgeState(),
        showChip: () => {
            if (!panel || !chip || !isWfOn()) return;
            const ui = lsUi();
            const c = clampIntoView(ui.chipX ?? ui.x ?? 16, ui.chipY ?? ui.y ?? 16, chip);
            applyChipPos(c.x, c.y);
            chip.style.display = "";
        },
    });
    teardown();
    const seq = ++initSeq;
    buildDom();
    mounted = true;
    watchQueue();
    void (async () => {
        await loadServerState();
        if (seq !== initSeq) return;
        // v105: a refreshOpen throw must not skip the one render that shows
        // the freshly-read presets (a stale body used to outlive the read)
        try { await refreshOpen(true); } catch (_) {}
        if (seq !== initSeq) return;
        renderAll();
    })();
    clearTimeout(pollT);
    pollT = setInterval(() => {
        if (initSeq !== seq) return;
        void pollTick();
    }, 900);
}

function teardown() {
    initSeq++;
    clearTimeout(pollT);
    clearInterval(pollT);
    pollT = null;
    closeWfPop();
    closePlanPop();
    closeImportPop();
    closeNamePop();
    closeWfCloseMenu(); // v105: the 🧹 dropdown + its armed timer
    try { window.removeEventListener("resize", onWinResize); } catch (_) {}
    try { panel?.remove(); } catch (_) {}
    try { chip?.remove(); } catch (_) {}
    panel = null;
    chip = null;
    mounted = false;
    saveForm = null;
    armedClose = null;
    armedDelete = null;
    sessionUndo = null;
    presetsLoaded = false; // v105: the next mount re-reads from scratch
}

// ---------------------------------------------------------------------------
// v101 test hooks (the smoke suite drives the panel through its real UI)
// ---------------------------------------------------------------------------

export function __workflowsTestHooks() {
    return {
        panelEl: () => panel,
        chipEl: () => chip,
        mounted: () => mounted,
        uiTab: () => uiTab,
        setTab: (t) => setUiTab(t),
        openTabs: () => openTabs.slice(),
        getOpenWorkflows,
        presets: () => presets.slice(),
        lockedKeys: () => new Set(lockedKeys),
        savedFiles: () => savedFiles.slice(),
        savedFilesLoaded: () => savedFilesLoaded,
        refreshSavedFiles: () => refreshSavedFiles(),
        refreshPresets: () => refreshPresets(),
        refreshOpen: (f) => refreshOpen(f),
        renderAll: () => renderAll(),
        serverState: () => serverState,
        serverNote: () => serverNote,
        presetsLoaded: () => presetsLoaded,
        loadServerState: () => loadServerState(),
        // v105 test determinism: the module preset list survives remounts by
        // design (the last known state) - the retry tests need a clean slate
        clearPresets: () => { presets = []; presetsLoaded = false; loadSig = calcLoadSig(); },
        pollTick: () => pollTick(),
        probeServer: () => probeServer(),
        closeAllTabs: () => closeAllTabs(),
        closeMenuItemsHtml,
        openCloseMenuPop: (btn) => openCloseMenuPop(btn),
        closeWfCloseMenu,
        saveForm: () => saveForm ? { ...saveForm, rows: saveForm.rows.map((r) => ({ ...r, tab: undefined })) } : null,
        openSaveForm,
        commitFormSave,
        collectFormItems,
        buildApplyPlan: (pid, opts) => {
            const p = presets.find((x) => x.id === pid);
            return p ? buildApplyPlan(p, opts) : null;
        },
        applyPlanById: (pid, opts) => {
            const p = presets.find((x) => x.id === pid);
            return p ? applyPlan(buildApplyPlan(p, opts)) : Promise.resolve();
        },
        runApplyPlan: (plan) => applyPlan(plan),
        undo: () => undoApply(),
        sessionUndo: () => sessionUndo,
        closeSavedTabs: (keep) => closeSavedTabs(keep),
        closeEmptyTempTabs: () => closeEmptyTempTabs(),
        saveAllModified: () => saveAllModified(),
        addPresetItems: (pid) => addPresetItems(presets.find((x) => x.id === pid)),
        pref: getPref,
        setPref,
        recent: () => recent.slice(),
        resetRecent: () => { recent = []; persistRecent(); },
        recordRecent,
        reloadRecent,      // v106: the boot read + the ".null" garbage prune
        sanitizeRecent,
        openPlanPop: (pid, anchor) => {
            const p = presets.find((x) => x.id === pid);
            if (p) openPlanPop(p, anchor || null);
        },
        planPop: () => planPop,
        closePlanPop,
        openWfSettingsPop: () => openWfSettingsPop(),
        wfPop: () => wfPop,
        closeWfPop,
        openImportPop: () => openImportPop(),
        importPop: () => importPop,
        closeImportPop,
        openNamePrompt,
        namePop: () => namePop,
        closeNamePop,
        setQueueRunning: (v) => { queueRunning = !!v; },
        queueRunning: () => queueRunning,
        adapter: {
            wfStoreOf,
            activateWorkflow,
            openWorkflowByPath,
            openSnapshotWorkflow,
            closeWorkflowTab,
            saveWorkflowTab,
            graphJsonOfOpenTab,
            getSavedWorkflows,
        },
        isOn: isWfOn,
        setOn: setWorkflowsOn,
        mount: initWorkflows,
        unmount: () => teardown(),
        // test determinism: freeze the 900ms poll so jsdom phases do not race
        stopPoll: () => { clearTimeout(pollT); clearInterval(pollT); pollT = null; },
        badgeState,
    };
}
