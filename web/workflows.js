// ============================================================================
// SettingsHub - WORKFLOWS MANAGER (v110)
// ----------------------------------------------------------------------------
// v110 (owner bug report: "где фильтры из плана? вижу только сортировки и
// туглер для переключения древовидной структуры папок" + "когда включена
// древовидная структура в files надо чтобы не было пустых папок при поиске"):
//   1. THE FILTER CHIPS BECAME VISIBLE: the ★-only / ⚗ / Today-7d-30d buttons
//      borrowed the .hub-wf-chip class, which in styles.css belongs to the
//      MINIMIZED-panel chip (position:fixed; left:16px; top:16px;
//      display:none; z-index:99900) - the whole filter row rendered but sat
//      hidden at the screen corner, so the owner saw "only the sortings and
//      the tree toggler". The chips now wear their OWN .hub-wf-fchip class
//      (dashed border marks "filter" buttons) - ⚗ opens the advanced row
//      (folder select, date from/until, size min-max KB, ✕ clear), ★-only
//      narrows to the favorites, the quick periods click on/off;
//   2. THE TREE PRUNES THE DEAD BRANCHES: with an active search OR any
//      filter (quick period, date range, size range, ★-only) a folder whose
//      subtree holds NO matching file disappears from the folder tree - no
//      empty skeleton folders during the search - and the per-folder
//      counters read the FILTERED list (a count the rows cannot back up is
//      impossible); without filters the tree shows every real folder.
// v109 (owner bug report: "менеджер процессов не видит процессов в пресетах
// (красный восклицательный знак значок) и на вкладке files пусто"):
//   REGRESSION ROOT CAUSE: ComfyUI nests userdata users INSIDE the user
//   directory (user_manager: 'default' unless multi-user,
//   get_public_user_directory -> <user_dir>/<id>), so the REAL workflow
//   library lives in <user_dir>/default/workflows. The v108 py rung walked
//   the flat <user_dir>/workflows, got nothing and answered ok:true with an
//   EMPTY list - and as the client's rung 0 that empty "success" masked the
//   working legacy rungs: savedFiles went empty, the Files tab went blank
//   and every preset path-item earned the red missing mark. Fixed BOTH
//   sides: the py rung now walks the real per-user roots (the request's
//   comfy-user folder > 'default' > the legacy flat folder, deduped) and
//   the client only accepts a NON-EMPTY rung-0 answer (an empty ok:true
//   falls through to the store/native rungs forever).
// v108 (owner plan, 4 items):
//   1. FILES TAB = A REAL FILE MANAGER: the listing moved to the new
//      GET /settings_hub/workflows/files route (path + SIZE + MTIME per
//      workflow file, the storage-root housekeeping excluded server-side) and
//      the tab gained: sorting by date/name/size with an asc/desc toggle,
//      the last-modified date+time + the size on every row, DATE filters
//      (from/until) with the quick periods Today / 7d / 30d, a FOLDER filter
//      (a select over every nesting level, subfolders included), a file-SIZE
//      range filter (KB), and per-file FAVORITES (★ server-side,
//      <user>/settings_hub/workflows_favorites.json - root-switch-proof)
//      with a ★-only filter chip;
//   2. PATH DISPLAY + FOLDER NAVIGATION: every file row shows its path
//      relative to the workflows root under the name (long paths ellipsized
//      through "…" keeping the LAST folders + the file name, the full path on
//      hover), the search matches the nested folder names too, and a ≡/🌲
//      view toggle switches the flat list (default) to a FOLDER TREE with
//      expand/collapse carets at any depth, click-to-enter navigation and
//      breadcrumbs; returning to ≡ restores the habitual Files view;
//   3. UNIFIED STORAGE VIEW (py v108): while a custom storage root is
//      active, the presets/temp of the DEFAULT location stay readable - the
//      reads cover both roots (an id clash resolves to the active copy, so
//      no duplicates), the writes go where the data already lives, nothing
//      is moved or lost on a root switch;
//   4. PRESETS NEVER MIX INTO FILES: the new /files listing (and the
//      native /userdata fallback) keep the storage-root presets/temp out of
//      the ordinary workflow list even when the root is re-pointed INSIDE
//      the workflows folder.
//
// v107 (owner request 2026-11-15: "ты пишешь 'есть бюджет localStorage', но
//   сам комфи и другие кастом екстеншены тоже сильно раздувают буфер, надежно
//   ли твое решение? мб лучше хранить temp процессы в зарезервированной папке
//   для settings_hub\workflows пока они фигурируют в recently closed?"):
//   TEMP SNAPSHOTS MOVED SERVER-SIDE:
//   * the reopen graphs of closed TEMP tabs no longer live in localStorage -
//     ComfyUI itself and the other custom extensions bloat the SAME origin
//     quota, so the v106 embedded snapshot could silently vanish exactly
//     when it was needed. The 🕘 ring keeps only the METADATA (name, ts,
//     path?, tempId?) - a closed temp tab uploads its graph to the SERVER:
//     temp/<id>.json in a RESERVED subfolder of the workflows storage root
//     (next to presets/, the same re-pointable root, py v107 routes);
//   * the 🕘 reopen fetches temp/<id> through the snapshot ladder - a
//     missing file (or an old py without the routes) degrades to the v106
//     localStorage embed when one exists, then to the path reopen. The
//     RECENT_SNAP_CAP / RECENT_BUDGET ladders below still guard that
//     fallback, but they no longer limit a server-backed snapshot (the
//     server cap is MAX_SNAPSHOT_BYTES = 10 MB, one file per tab);
//   * lifecycle: the entry leaving the ring (the 15-row cap, the same-name
//     dedupe) deletes ITS file; the boot GC removes orphans NOT referenced
//     by this browser's ring AND older than a day (conservative - a
//     snapshot another browser still points at is never touched);
//   * the server keeps MAX_TEMP_FILES = 40 newest snapshots per root, so
//     the folder stays bounded even when a client never cleans up.
//
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
const WF_WEB_VERSION = "v120";
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["workflows"] = "v120";

// ---------------------------------------------------------------------------
// Constants + tiny utils
// ---------------------------------------------------------------------------

const LS_ON = "settingshub.workflows.on";      // "1"/"0" - panel enabled
const LS_UI = "settingshub.workflows.ui";      // {x,y,w,h,min,chipX,chipY,tab}
const LS_PREF = "settingshub.workflows.pref";  // {keepUnsaved,closeEmptyTemp,warnOnQueue}
const LS_RECENT = "settingshub.workflows.recent"; // ring buffer of closed tabs
const LS_CLIENT = "settingshub.workflows.client"; // v112: the browser-session id (server recent manifests)
// v117: the owner's 'Recently closed items' setting (5/10/15/20/30, default
// 15) - ONE active limit feeds the ring, the render, the server manifest
// upload AND the Clear button; shrinking TRIMS the ring immediately and the
// evicted tempIds free their snapshots through the manifest sync (the
// cross-browser refs are honored server-side)
const LS_RECENT_LIMIT = "settingshub.workflows.recentLimit";
const RECENT_CHOICES = [5, 10, 15, 20, 30];
// v117: the Files similarity grouping (the owner's plan section 4)
const LS_GROUPS = "settingshub.workflows.groups"; // {on,threshold,kind}
// v120: the threshold goes DOWN to 50 (the owner's request: the heavily
// modified copies only group at a loose estimate; the score formula got
// the jaccard+overlap blend so additions cost far less than before)
const GROUP_THRESHOLD_CHOICES = [50, 60, 70, 80, 85, 90, 95, 100];
const Z_PANEL = "99900";               // same layer as the stack / chat panels
const RECENT_MAX = 15;                 // the DEFAULT limit (the setting wins)
// v108: the Files-tab quick-period bounds ("today" / "7d" / "30d" chips -
// a lower mtime bound only, so a skewed clock can never hide a fresh file)
const DAY_MS = 24 * 60 * 60 * 1000;
// v107: the reopen snapshots of closed TEMP tabs live SERVER-side as
// temp/<id>.json inside the storage root (see the v107 header note) - the
// localStorage ring carries only the metadata + the temp id. The caps below
// now bound the FALLBACK embed only (an old py without the temp routes or a
// failed upload): one huge graph must not crowd the other entries out;
// over-budget entries degrade to name-only from the OLDEST side
// (persistRecent)
const RECENT_SNAP_CAP = 400000;          // chars of JSON per single entry
const RECENT_BUDGET = 2500000;           // total chars of JSON across the ring
// v107: the boot GC deletes a server temp snapshot that NO ring entry
// references AND that is older than this - anything younger may still be
// pointed at by another browser's ring, a day-old orphan is a leftover
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ARM_MS = 2500;                   // double-click confirm window (✕ / 🗑)
const TAB_SEQ = 30;                    // ms between tab operations (ChangeTracker settle)
const ITEM_LIST_CAP = 12;              // preset card: items shown before "+N more"
const ROW_LIST_CAP = 60;               // open/files lists: rows per render chunk
const SHOW_MORE_STEP = 150;
// v112 (plan 3.5): the hard 400-row cap is GONE - it permanently hid open
// tabs beyond 400. The list renders in chunks (ROW_LIST_CAP + "Show more")
// and the search always runs over the FULL open set.
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

/** v117: the ACTIVE Recently-closed limit (the owner's plan section 3).
 *  A broken/stale localStorage value falls back to the default 15. NOTE:
 *  lsJson() only returns OBJECTS - a bare number would fall back to the
 *  default, so the raw value is parsed here. */
function recentLimit() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_RECENT_LIMIT) || "null");
        return RECENT_CHOICES.includes(v) ? v : RECENT_MAX;
    } catch (_) { return RECENT_MAX; }
}

/** v117: apply a new limit IMMEDIATELY (no reload): the ring is trimmed,
 *  the evicted tempIds go through the manifest sync (the server frees the
 *  snapshots no OTHER browser session references) and the tab re-renders. */
function setRecentLimit(n) {
    const v = RECENT_CHOICES.includes(n) ? n : RECENT_MAX;
    saveJson(LS_RECENT_LIMIT, v);
    const lim = recentLimit();
    if (Array.isArray(recent) && recent.length > lim) {
        for (const r of recent.slice(lim)) {
            if (r && typeof r.tempId === "string" && r.tempId)
                _pendingEvicted.push(r.tempId);
        }
        recent = recent.slice(0, lim);
        persistRecent();
        syncRecentManifest();
    }
    if (uiTab === "files") renderAll();
    return v;
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

/** v112 (plan 3.3): THE ONE canonical workflow-path normalizer - every
 *  path-based comparison in the panel goes through THIS function (the
 *  plan: "создать одну каноническую функцию нормализации относительных
 *  workflow path"). Rules:
 *    - backslashes -> slashes, surrounding whitespace trimmed;
 *    - the "workflows/" userdata prefix is stripped ("workflow.json" and
 *      "workflows/workflow.json" compare EQUAL - the agreed rule);
 *    - "." and empty segments collapse, repeated separators collapse;
 *    - "..", absolute paths (leading "/", drive letters) REFUSE to "" -
 *      a path that escapes the userdata root never matches anything.
 *  The server-side validation is separate (py _clean_item_path) - this
 *  function is a comparison helper, not a security boundary.
 *  normWfPath stays as the RAW normalized form (prefix kept) for the
 *  favorites set + display paths. */
function canonWfRel(p) {
    if (typeof p !== "string") return "";
    let s = p.replace(/\\/g, "/").trim();
    if (/^[A-Za-z]:/.test(s) || s.startsWith("/")) return ""; // absolute -> refuse
    s = s.replace(/^(?:\.\/)+/, "");
    s = s.replace(/^workflows\//i, "");
    const parts = s.split("/").filter((seg) => seg && seg !== ".");
    if (parts.some((seg) => seg === "..")) return "";
    return parts.join("/");
}

/** Normalize a workflow file path for display/storage (POSIX, no leading
 *  ./ or /; the workflows/ prefix is KEPT - the listing shape). */
function normWfPath(p) {
    if (typeof p !== "string") return "";
    let s = p.replace(/\\/g, "/").trim();
    while (s.startsWith("./")) s = s.slice(2);
    while (s.startsWith("/")) s = s.slice(1);
    return s;
}

/** Canonical compare: TRUE when both paths point at the SAME workflow file
 *  under the agreed rule (prefix-insensitive, never basename-only). */
function sameWfPath(a, b) {
    const ca = canonWfRel(a), cb = canonWfRel(b);
    return !!ca && !!cb && ca === cb;
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
 *  Rung 0 (v108): the pack's own /workflows/files route - path + SIZE +
 *  MTIME in one shot, and the storage-root housekeeping (presets/, temp/)
 *  is already excluded server-side, so presets never mix into the list.
 *  Rung 1: the frontend store registry (no meta - the filters degrade).
 *  Rung 2: the NATIVE /userdata endpoint (multi-user aware - reading the
 *  server folder directly is not); meta is parsed when the build carries
 *  it. Every rung filters out the "settings_hub/" segments from the paths -
 *  a legacy listing cannot be trusted to have excluded the default storage
 *  folder (it lives OUTSIDE workflows/, but a hand-copied presets/ folder
 *  inside it must not surface either). */
async function getSavedWorkflows() {
    // v108 rung 0: the pack's own listing (size + mtime in one shot).
    // v109: only a NON-EMPTY answer wins - an ok:true files:[] reply
    // (a py that misses the real userdata layout, or a transiently
    // unreadable folder) must fall through to the legacy rungs and can
    // never blank the Files tab + the preset missing-marks again.
    try {
        const res = await jfetch("/settings_hub/workflows/files");
        if (res.json?.ok && Array.isArray(res.json.files) && res.json.files.length) {
            // v112 (plan 3.10): the backend cap surfaces as a truncation note
            lastFilesTruncated = !!res.json.truncated;
            return res.json.files.map((f) => ({
                path: normWfPath(f.path),
                name: f.name || baseName(f.path),
                size: Number(f.size) || 0,
                mtime: Number(f.mtime) || 0,
            })).filter((f) => f.path && !f.path.toLowerCase().includes("settings_hub/"));
        }
    } catch (_) { /* old py - the legacy rungs take over */ }
    lastFilesTruncated = false;
    const store = wfStoreOf();
    let list = null;
    try { list = store?.workflows ?? store?.persistedWorkflows ?? null; } catch (_) { list = null; }
    if (Array.isArray(list) && list.length) {
        const out = [];
        for (const w of list) {
            const p = w?.path || w?.fullPath || null;
            if (typeof p === "string" && p) {
                out.push({ path: p, name: baseName(p), size: 0, mtime: 0 });
            }
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
                let p = null;
                if (typeof it === "string") {
                    p = it.startsWith("workflows/") ? it : ("workflows/" + it);
                } else if (it && typeof it === "object") {
                    p = it.path || (it.name ? (it.name.startsWith("workflows/") ? it.name : "workflows/" + it.name) : null);
                }
                if (!p) continue;
                // meta: field names differ between builds - accept the
                // number epoch ("mtime"/"modified") and an ISO date string
                let size = 0, mtime = 0;
                if (it && typeof it === "object") {
                    size = Number(it.size) || 0;
                    mtime = Number(it.mtime) || Number(it.modified) || 0;
                    if (!mtime && typeof it.modified === "string" && it.modified) {
                        const t = Date.parse(it.modified);
                        if (Number.isFinite(t)) mtime = Math.floor(t / 1000);
                    }
                }
                p = normWfPath(p);
                if (p.toLowerCase().includes("settings_hub/")) continue; // v108: never mix
                out.push({ path: p, name: baseName(p), size, mtime });
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
    // v112 (plan 3.3): the canonical comparison - prefix/slash/dot-shape
    // differences must never fork the already-open check
    const already = getOpenWorkflows().find((t) => t.path && sameWfPath(t.path, path));
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

/** Open a SNAPSHOT (an embedded graph JSON of a temporary tab).
 *  v112 stage 3 (plan 8): an exact duplicate of an open temp tab prompts
 *  Focus existing / Open another copy (opts.forceCopy skips the prompt);
 *  the same working graph with a different canvas state only WARNS. */
async function openSnapshotWorkflow(name, graphJson, opts = {}) {
    if (!graphJson || typeof graphJson !== "object") return { ok: false, error: "no graph" };
    if (!opts.forceCopy) {
        const dup = findSnapshotDuplicates(graphJson);
        if (dup.exact) {
            askSnapshotDuplicate(dup.exact, name, graphJson,
                () => void openSnapshotWorkflow(name, graphJson, { forceCopy: true }));
            return { ok: false, duplicatePrompted: true };
        }
        if (dup.sameGraph) {
            localToast("Same workflow; the canvas state differs - both tabs stay open", 3600);
        }
    }
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

/** v112 (plan 3.2): after a fallback activation, VERIFY that the target tab
 *  is really the active one before a targeted/destructive command (Close/
 *  Save run over "the ACTIVE tab" in some ComfyUI builds). Verification
 *  ladder: the store's isActive(ref) -> the re-queried wrapper list's
 *  isActive flag -> a canonical-PATH match (NEVER a name-only check: equal
 *  basenames in different folders are different files, the plan's own
 *  acceptance criterion). A tab that cannot be verified is refused - an
 *  operation on a POTENTIALLY DIFFERENT tab is never attempted. */
async function verifyActiveTab(w) {
    const store = wfStoreOf();
    try {
        if (w?.ref && typeof store?.isActive === "function") {
            if (store.isActive(w.ref)) return true;
        }
    } catch (_) {}
    await sleep(TAB_SEQ);
    await nextFrame();
    const live = getOpenWorkflows();
    const cur = live.find((t) => t.key === w.key) || null;
    if (cur) return !!cur.isActive;
    if (w?.path) {
        const byPath = live.find((t) => t.path && sameWfPath(t.path, w.path));
        return !!(byPath && byPath.isActive);
    }
    return false; // a temp tab without a verifiable identity -> refuse
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
            await recordRecent(w, snap); // v107: awaited - the temp upload is part of the close
            await ensureSomeTab();
            return { ok: true, via: "store" };
        } catch (_) {}
    }
    // rung 2: the command API (some builds expose close as a command).
    // v112 (plan 3.2): the command targets the ACTIVE tab - the activation
    // must be VERIFIED first, otherwise the close is refused (a same-name
    // tab in a different folder must never die instead of the target).
    try {
        const cmd = app.extensionManager?.command;
        if (cmd && typeof cmd.execute === "function") {
            await activateWorkflow(w);
            if (!(await verifyActiveTab(w))) {
                return { ok: false, unsupported: true,
                    error: "the target tab could not be verified as active - close refused" };
            }
            await cmd.execute("Workspace.CloseWorkflow");
            await recordRecent(w, snap); // v107: awaited (see above)
            return { ok: true, via: "command" };
        }
    } catch (_) {}
    return { ok: false, unsupported: true };
}

/** Save ONE modified persisted tab ("Save all modified").
 *  v112 (plan 3.2): the command fallback VERIFIES the activation first -
 *  Comfy.SaveWorkflow acts on the ACTIVE tab, so an unverified activation
 *  refuses instead of writing a potentially DIFFERENT file. */
async function saveWorkflowTab(w) {
    if (!w) return { ok: false, error: "no tab" };
    if (!w.isPersisted || !w.isModified) return { ok: false, skipped: true };
    const store = wfStoreOf();
    if (store && typeof store.saveWorkflow === "function" && w.ref) {
        try { await store.saveWorkflow(w.ref); return { ok: true, via: "store" }; } catch (_) {}
    }
    try {
        await activateWorkflow(w);
        if (!(await verifyActiveTab(w))) {
            return { ok: false,
                error: "the target tab could not be verified as active - save refused" };
        }
        await app.extensionManager?.command?.execute?.("Comfy.SaveWorkflow");
        return { ok: true, via: "command" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// v112 stage 3 (plan 6): the PER-TAB save of the Open tab.
const saveState = new Map(); // key -> "saving" | "saved" (a transient marker)

/** The Save As candidate ladder for TEMP tabs (plan 6: feature detection
 *  ONLY - a guessed command id is never executed). The store's own
 *  saveWorkflow(ref, {saveAs})-style API first, then a command whose id the
 *  installed build actually exposes, then an honest refusal (the native
 *  ComfyUI UI stays the way back). */
function wfStoreSaveAsCandidate() {
    const store = wfStoreOf();
    const cands = [];
    if (store && typeof store.saveWorkflow === "function") cands.push("store");
    try {
        const cmd = app?.extensionManager?.command;
        const ids = new Set();
        try {
            const list = typeof cmd?.getCommands === "function" ? cmd.getCommands() : null;
            if (Array.isArray(list)) for (const c of list) ids.add(String(c?.id || c));
        } catch (_) {}
        try {
            const reg = cmd?.registry || cmd?.commands;
            if (reg instanceof Map) for (const k of reg.keys()) ids.add(String(k));
            else if (reg && typeof reg === "object") for (const k of Object.keys(reg)) ids.add(String(k));
        } catch (_) {}
        for (const want of ["Comfy.SaveWorkflowAs", "Workflow.SaveAs",
            "Comfy.SaveAsWorkflow", "Workspace.SaveWorkflowAs"]) {
            if (ids.has(want)) cands.push("cmd:" + want);
        }
    } catch (_) {}
    return cands;
}

async function saveWorkflowTabAs(w) {
    if (!w) return { ok: false, error: "no tab" };
    const store = wfStoreOf();
    // rung 1: the store's own save-with-name API (feature-detected shapes)
    if (store && typeof store.saveWorkflow === "function" && w.ref) {
        for (const shape of [{ saveAs: true }, { as: true }, { saveAsName: true }]) {
            try {
                const r = await store.saveWorkflow(w.ref, shape);
                if (r !== false) return { ok: true, via: "store", shape };
            } catch (_) { /* the next shape */ }
        }
    }
    // rung 2: a command the installed build ACTUALLY exposes
    try {
        await activateWorkflow(w);
        if (!(await verifyActiveTab(w))) {
            return { ok: false, error: "the target tab could not be verified as active - Save As refused" };
        }
        const cands = wfStoreSaveAsCandidate();
        const cmdId = cands.find((c) => c.startsWith("cmd:"));
        if (cmdId) {
            await app.extensionManager.command.execute(cmdId.slice(4));
            return { ok: true, via: "command" };
        }
        return { ok: false, unsupported: true,
            error: "this ComfyUI build exposes no Save-As API to extensions - use the native ComfyUI UI (File > Save As)" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** The per-row 💾 action (plan 6): a persisted tab saves IN PLACE; a temp
 *  tab runs the Save As ladder; a clean persisted tab still saves explicitly
 *  (the unified UX: always enabled). The row shows saving/saved/error. */
async function saveTabRow(t) {
    if (!t || saveState.get(t.key) === "saving") return;
    saveState.set(t.key, "saving");
    renderAll();
    let r;
    if (t.isPersisted) {
        r = await saveWorkflowTab(t);
    } else {
        r = await saveWorkflowTabAs(t);
    }
    if (r?.ok) {
        saveState.set(t.key, "saved");
        if (t.isPersisted && t.ref) { try { t.ref.isModified = false; } catch (_) {} }
        await refreshOpen(true);
        await refreshSavedFiles();
        if (idxMode()) await runServerList(true);
    } else {
        saveState.delete(t.key);
    }
    renderAll();
    if (r?.ok) {
        localToast(t.isPersisted ? "Saved \"" + (t.name || "") + "\"" : "Save As handed to ComfyUI");
    } else if (r?.skipped) {
        localToast("No changes to save");
    } else if (r?.unsupported) {
        localToast(r.error || "Save As is not available in this build", 4200);
    } else {
        localToast("Save failed: " + ((r && r.error) || "?"), 4200);
    }
    setTimeout(() => { if (saveState.get(t.key) === "saved") { saveState.delete(t.key); renderAll(); } }, 2000);
}

// ---------------------------------------------------------------------------
// v112 stage 3 (plan 8): the DUPLICATE DETECTION of temporary tabs and
// snapshot opens. The client mirrors the layered-hash IDEA with a light
// canonical form: byte-exact = raw string equality; same JSON content =
// canonical (sorted keys) equality; the same working graph with a different
// canvas state = a WARNING, never a silent merge (plan 2.2: unknown fields
// stay in the graph hash, only the confirmed presentation fields strip out).
// ---------------------------------------------------------------------------

function canonJsonOf(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonJsonOf).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonJsonOf(v[k])).join(",") + "}";
}

/** The graph WITHOUT the confirmed presentation/environment fields - the
 *  client-side mirror of the server's workflowHash normalization (plan 2.2:
 *  extra.ds.scale/offset + frontendVersion + nodes[].pos/size + visual
 *  node fields; EVERY unknown field stays). */
function stripPresentationOf(wf) {
    if (!wf || typeof wf !== "object") return wf;
    const PRESENT_NODE = new Set(["pos", "size", "bgcolor", "color", "collapsed", "shape", "loc"]);
    const g = { ...wf };
    if (g.extra && typeof g.extra === "object") {
        const e = { ...g.extra };
        delete e.ds;
        delete e.frontendVersion;
        g.extra = e;
    }
    if (Array.isArray(g.nodes)) {
        g.nodes = g.nodes.map((n) => {
            if (!n || typeof n !== "object") return n;
            const n2 = { ...n };
            for (const k of PRESENT_NODE) delete n2[k];
            return n2;
        });
    }
    return g;
}

function wfGraphHashClient(graph) {
    try {
        return canonJsonOf(stripPresentationOf(graph));
    } catch (_) { return null; }
}

/** The duplicate scan of ONE snapshot graph against the OPEN TEMP tabs.
 *  Returns {exact: tab|null, sameGraph: tab|null} - exact = the same JSON
 *  content; sameGraph = the same working graph, a different canvas state. */
function findSnapshotDuplicates(graphJson) {
    const out = { exact: null, sameGraph: null };
    if (!graphJson || typeof graphJson !== "object") return out;
    let canon = null, ghash = null;
    try { canon = canonJsonOf(graphJson); } catch (_) { return out; }
    ghash = wfGraphHashClient(graphJson);
    const temps = getOpenWorkflows().filter((t) => !t.path || t.isTemporary);
    for (const t of temps) {
        const g = graphJsonOfOpenTab(t);
        if (!g) continue;
        if (!out.exact) {
            try {
                if (canonJsonOf(g) === canon) { out.exact = t; continue; }
            } catch (_) {}
        }
        if (!out.sameGraph && ghash) {
            const gh2 = wfGraphHashClient(g);
            if (gh2 && gh2 === ghash) out.sameGraph = t;
        }
    }
    return out;
}

/** The snapshot-open duplicate prompt (plan 8): Focus existing / Open
 *  another copy - a duplicate is NEVER created silently. */
function askSnapshotDuplicate(hit, name, graphJson, onOpenCopy) {
    closeDupPop();
    const pop = document.createElement("div");
    pop.className = "hub-menu hub-wf-duppop";
    pop.innerHTML =
        `<div class="hub-menu-title">Duplicate workflow</div>` +
        `<div class="hub-wf-planhint">The same workflow content is already open as '${esc(hit.name || "a temp tab")}'.</div>` +
        `<div class="hub-wf-planacts">` +
        `<button type="button" class="hub-wf-act" data-wf-btn="focus">🎯 Focus existing</button>` +
        `<button type="button" class="hub-wf-act" data-wf-btn="copy">＋ Open another copy</button>` +
        `</div>`;
    document.body.appendChild(pop);
    dupPop = pop;
    try {
        const vw = window.innerWidth || 1600;
        pop.style.left = Math.max(8, (vw - (pop.offsetWidth || 300)) / 2) + "px";
        pop.style.top = "80px";
    } catch (_) {}
    pop.addEventListener("click", async (e) => {
        const b = e.target?.closest?.("[data-wf-btn]");
        if (!b) return;
        closeDupPop();
        if (b.dataset.wfBtn === "focus") {
            const r = await activateWorkflow(hit);
            if (!r.ok) localToast("Could not focus the existing tab - see F12", 3600);
            return;
        }
        void onOpenCopy();
    });
}

let dupPop = null;
function closeDupPop() {
    try { dupPop?.remove(); } catch (_) {}
    dupPop = null;
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
    if (serverState) {
        await refreshPresets();
        // v107: after the first healthy probe - one silent GC pass over the
        // temp folder (stale orphans not referenced by the ring, > 1 day)
        if (!tempGcDone && presetsLoaded) {
            tempGcDone = true;
            void gcTempSnapshots();
        }
    }
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
// v107: server-side temp snapshots - temp/<id>.json in the storage root.
// The recently-closed ring keeps only the metadata; the reopen graphs live
// here while the tabs figure in 🕘 Recently closed (the owner's contract).
// An old py without the routes answers 404 - every helper degrades and the
// v106 localStorage embed takes over.
// ---------------------------------------------------------------------------

/** Store ONE reopen snapshot: POST /workflows/temp {name, graph} ->
 *  {ok, id}. Never throws - {ok:false} makes recordRecent fall back to the
 *  v106 localStorage embed. */
async function saveTempSnapshot(name, graph) {
    try {
        const res = await jfetch("/settings_hub/workflows/temp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name || "Unsaved", graph }),
        });
        if (res.json?.ok && typeof res.json.id === "string" && res.json.id) {
            return { ok: true, id: res.json.id };
        }
        return { ok: false, error: (res.json && res.json.error) || ("HTTP " + (res.status || "?")) };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** Fetch ONE reopen snapshot: GET /workflows/temp/{id} -> the graph object
 *  or null (gone / corrupt / old py). */
async function fetchTempSnapshot(id) {
    if (!id) return null;
    try {
        const res = await jfetch("/settings_hub/workflows/temp/" + encodeURIComponent(id));
        if (res.json?.ok && res.json.graph && typeof res.json.graph === "object") {
            return res.json.graph;
        }
    } catch (_) {}
    return null;
}

/** Delete ONE temp snapshot (entry eviction / boot GC). Fire-and-forget
 *  safe: an already-missing file answers ok:true existed:false. */
async function deleteTempSnapshot(id) {
    if (!id) return;
    try {
        await jfetch("/settings_hub/workflows/temp/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (_) {}
}

let tempGcDone = false; // one silent boot GC pass per page load

/** v112 boot GC (plan 3.6): SERVER-AUTHORITATIVE - POST /workflows/temp/gc
 *  deletes a snapshot only when NO manifest (any browser) references it AND
 *  it is older than a day. The v107 client-side per-id deletion could orphan
 *  another browser's reopen - the server computes the reference union now.
 *  An old py (no gc route) answers 404: the boot GC silently skips (the
 *  folder still bounds itself via MAX_TEMP_FILES eviction). */
async function gcTempSnapshots() {
    if (!serverState) return;
    try {
        await jfetch("/settings_hub/workflows/temp/gc", { method: "POST" });
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// v108 FILES TAB - sort / filters / favorites / tree. The listing data comes
// from getSavedWorkflows() (the /workflows/files rung carries size + mtime);
// everything below shapes it for display. The view state the user expects to
// STAY (sort, view mode) persists in LS_UI; the session filters (dates,
// sizes, folder, ★-only) reset with the page like any search box.
// ---------------------------------------------------------------------------

let filesSort = { key: "mtime", dir: "desc" };  // "mtime" | "name" | "size"
let filesView = "list";         // "list" (flat, the habitual view) | "tree"
let filesFav = new Set();       // favorite paths (normalized) - server-backed
let filesFavsLoaded = false;    // the favorites list has been fetched once
let filesFavOnly = false;       // the ★-only filter chip
let filesFolder = "";           // the folder filter (list mode), "" = all
let filesQuick = "";            // "today" | "7d" | "30d" | ""
let filesDateFrom = "";         // "YYYY-MM-DD" (inclusive lower mtime bound)
let filesDateTo = "";           // "YYYY-MM-DD" (inclusive upper mtime bound)
let fileSizeMin = "";           // KB (string until parsed - an empty box is unbounded)
let fileSizeMax = "";
let filesAdvOpen = false;       // the ⚗ advanced-filters row visibility
let filesTreeFolder = "";       // tree-mode navigation ("" = the root)
let treeExpanded = new Set();   // the expanded folder paths in tree mode
// v112 (plan 3.4/3.10): the EXPLICIT Files-list states + the request guard.
// filesLoadSeq kills stale responses; filesLoadError keeps the last good
// list visible; filesTruncated mirrors the backend listing cap; filesLast-
// Scan feeds the Refresh tooltip + the status line.
let filesLoadSeq = 0;
let filesLoadPending = false;
let filesLoadError = null;      // {why} | null
let filesTruncated = false;
let filesLastScan = 0;          // ms epoch of the last SUCCESSFUL scan
let filesEmptyStrikes = 0;      // two consecutive empty answers = really empty
let lastFilesTruncated = false; // the truncated flag of the last listing fetch

// ---------------------------------------------------------------------------
// v112 stage 2 (plan 4.x): the DERIVED SQLITE INDEX as the Files-tab engine.
// When the index routes answer (a v112 py), the LIST mode is SERVER-PAGINATED
// (keyset cursor - no 6000 cap masks the library) and the search runs on the
// SERVER over names/paths/UUIDs/node types/model refs/contents. The tree
// view and the preset missing-marks keep the local mirror listing. The index
// is a derived cache - an old py (404 status) degrades to the v108 local
// behavior with zero UI contract change.
// ---------------------------------------------------------------------------
let idxReady = null;            // null unknown / true / false (index routes alive)
let idxStats = null;            // the /index/status answer
let idxSeq = 0;                 // the stale-response guard of the queries
let idxQueryT = null;           // the search debounce (~250ms)
let idxScanBusy = false;        // one scan trigger per session (client-side)
let serverList = { files: [], total: 0, hasMore: false, nextCursor: null,
    loading: false, error: null };
let filesUuid = "";             // the advanced filter: exact/partial ComfyUI UUID

// v117 (the owner's plan section 4): the FILES SIMILARITY GROUPING state.
// on/threshold/kind persist in localStorage; the ANSWER (groups + rows) is
// a fetch cache with a short TTL - the server computes it over the WHOLE
// index and caches it in SQLite, so the client never recomputes anything.
let groupsState = { on: false, threshold: 90, kind: "all",
    data: null, loading: false, error: null, busy: false, collapsed: {} };
// v118: a BUSY index (a scan holds the SQLite db) is a SOFT state - the
// answer retries on a timer until the scan finishes; the v117 dead
// 'The groups are unavailable: database is locked' note is retired.
let groupsRetryT = null;
let groupsRetryMs = 3000;

function loadGroupsPrefs() {
    try {
        const v = lsJson(LS_GROUPS, null);
        if (v && typeof v === "object") {
            groupsState.on = !!v.on;
            const th = parseInt(v.threshold, 10);
            if (GROUP_THRESHOLD_CHOICES.includes(th)) groupsState.threshold = th;
            if (v.kind === "same_uuid" || v.kind === "exact" || v.kind === "similar")
                groupsState.kind = v.kind;
        }
    } catch (_) {}
}

function saveGroupsPrefs() {
    saveJson(LS_GROUPS, { on: groupsState.on, threshold: groupsState.threshold,
        kind: groupsState.kind });
}

function scheduleGroupsRetry() {
    clearTimeout(groupsRetryT);
    groupsRetryT = setTimeout(() => {
        groupsRetryT = null;
        if (groupsState.on && idxMode() && filesView === "list" && uiTab === "files")
            void runGroups(true);
    }, groupsRetryMs);
}

/** v117: fetch the server-built groups (threshold + kind are server params;
 *  the server caches the full computation in SQLite, the kind filter is
 *  applied there). force=true drops the cache (Refresh / after a delete). */
async function runGroups(force = false) {
    if (!idxMode() || !groupsState.on || filesView !== "list") return;
    if (groupsState.loading) return;
    if (groupsState.data && !force &&
        Date.now() - (groupsState.data.ts || 0) < 15000) return;
    groupsState.loading = true;
    if (force) groupsState.data = null;
    groupsState.error = null;
    renderAll();
    try {
        const res = await jfetch("/settings_hub/workflows/index/groups?threshold=" +
            encodeURIComponent(groupsState.threshold) + "&kind=" +
            encodeURIComponent(groupsState.kind));
        if (res.json?.ok) {
            groupsState.data = { ...res.json, ts: Date.now() };
            groupsState.busy = false;
            clearTimeout(groupsRetryT);
            groupsRetryT = null;
        } else if (res.json && res.json.busy) {
            // v118: the index is busy (a scan holds the db) - a SOFT state:
            // 'Indexing in progress' + an automatic retry until the scan
            // finishes. Never a dead 'unavailable' note again.
            groupsState.busy = true;
            groupsState.error = null;
            scheduleGroupsRetry();
        } else {
            groupsState.busy = false;
            clearTimeout(groupsRetryT);
            groupsRetryT = null;
            groupsState.error = (res.json && res.json.error) ||
                (res.status === 404 ? "the groups route is missing (an old py) - update the FULL pack"
                    : "HTTP " + res.status);
        }
    } catch (e) {
        groupsState.busy = false;
        groupsState.error = String((e && e.message) || e);
    }
    groupsState.loading = false;
    if (uiTab === "files") renderAll();
}

// v117: the persisted grouping prefs (on/threshold/kind) load ONCE at boot
loadGroupsPrefs();

function idxMode() { return idxReady === true; }

/** The Files-tab list query the server answers: search + filters + sort +
 *  pagination in ONE request. Debounced for typing, immediate for the
 *  sort/filter clicks (the callers pass delay). */
function scheduleServerList(delay = 250) {
    if (!idxMode() || filesView !== "list") return;
    clearTimeout(idxQueryT);
    // v113: silent=true - typing must not flash the "Reading…" state and
    // wipe the visible rows on every debounced keystroke; the answer
    // replaces the list in one step
    idxQueryT = setTimeout(() => void runServerList(true, true), delay);
}

async function runServerList(reset = true, silent = false) {
    if (!idxMode()) return;
    const seq = ++idxSeq;
    if (reset) {
        serverList = { files: [], total: serverList.total, hasMore: false,
            nextCursor: null, loading: true, error: null };
        if (!silent && uiTab === "files") renderAll(); // the loading state renders once
    }
    const params = new URLSearchParams();
    if (filesSearch) params.set("q", filesSearch);
    if (filesUuid) params.set("workflow_id", filesUuid.trim());
    if (filesFolder && filesView === "list") params.set("folder", filesFolder);
    if (filesFavOnly) params.set("fav", "1");
    params.set("sort", filesSort.key === "mtime" ? "mtime" : filesSort.key);
    params.set("direction", filesSort.dir);
    params.set("limit", String(SHOW_MORE_STEP));
    if (!reset && serverList.nextCursor) params.set("cursor", serverList.nextCursor);
    if (filesDateFrom) {
        const t = Date.parse(filesDateFrom + "T00:00:00");
        if (Number.isFinite(t)) params.set("mtime_from", String(Math.floor(t / 1000)));
    }
    if (filesDateTo) {
        const t = Date.parse(filesDateTo + "T23:59:59");
        if (Number.isFinite(t)) params.set("mtime_to", String(Math.floor(t / 1000)));
    }
    if (fileSizeMin !== "" && Number.isFinite(parseFloat(fileSizeMin))) {
        params.set("size_min", String(Math.round(parseFloat(fileSizeMin) * 1024)));
    }
    if (fileSizeMax !== "" && Number.isFinite(parseFloat(fileSizeMax))) {
        params.set("size_max", String(Math.round(parseFloat(fileSizeMax) * 1024)));
    }
    const res = await jfetch("/settings_hub/workflows/index/search?" + params.toString());
    if (seq !== idxSeq) return; // a newer query superseded this one
    if (res.json?.ok && Array.isArray(res.json.files)) {
        const rows = res.json.files.map((f) => ({
            path: f.path, name: f.name || baseName(f.path),
            size: Number(f.size) || 0, mtime: Number(f.mtime) || 0,
            workflowId: f.workflowId || null,
            parseStatus: f.parseStatus || null,
            nodeCount: Number(f.nodeCount) || 0,
        }));
        serverList = {
            files: reset ? rows : serverList.files.concat(rows),
            total: Number(res.json.total) || rows.length,
            hasMore: !!res.json.has_more,
            nextCursor: res.json.next_cursor || null,
            loading: false, error: null,
        };
        idxReady = true;
    } else if (res.status === 404) {
        idxReady = false; // an old py - the local rung takes over for good
        serverList.loading = false;
    } else {
        serverList.loading = false;
        serverList.error = (res.json && res.json.error) || ("HTTP " + (res.status || "?"));
    }
    if (uiTab === "files") renderAll();
}

/** The index status probe + the boot scan trigger (once per session). The
 *  scan walks the library in a SERVER worker thread - the panel only shows
 *  the Indexing state and re-queries when it lands. */
async function ensureIndexStatus() {
    if (!serverState) return;
    try {
        const res = await jfetch("/settings_hub/workflows/index/status");
        if (res.json?.ok) {
            idxStats = res.json;
            idxReady = true;
            if (!idxScanBusy) {
                idxScanBusy = true;
                void (async () => {
                    try {
                        await jfetch("/settings_hub/workflows/index/scan", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ force: false }),
                        });
                    } catch (_) {}
                    const st2 = await jfetch("/settings_hub/workflows/index/status");
                    if (st2.json?.ok) idxStats = st2.json;
                    idxScanBusy = false;
                    if (uiTab === "files") {
                        await runServerList(true);
                        renderAll();
                    }
                })();
            }
        } else if (res.status === 404) {
            idxReady = false;
        }
    } catch (_) { /* an old py - local mode stays */ }
}

/** v112 stage 2 (plan 4.4): the manual Rebuild index - a FULL rescan
 *  (force:true re-analyzes every file), then the status + the list refresh. */
async function rebuildIndex() {
    if (!idxMode()) { localToast("The index routes are not available (an old py)"); return; }
    idxScanBusy = true;
    renderAll();
    try {
        await jfetch("/settings_hub/workflows/index/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true }),
        });
    } catch (_) {}
    const st = await jfetch("/settings_hub/workflows/index/status");
    if (st.json?.ok) idxStats = st.json;
    idxScanBusy = false;
    await runServerList(true);
    if (uiTab === "files") renderAll();
    localToast("Index rebuilt: " + (idxStats?.files || 0) + " file(s)"
        + (idxStats?.errors ? " · " + idxStats.errors + " bad json" : ""));
}

function filesListRows() {
    // the rows the LIST mode displays: the server page when the index is
    // live, the local mirror otherwise (the old v108 behavior)
    if (idxMode()) return serverList.files;
    return filteredSavedFiles().slice(0, fileRowsShown);
}

function loadFilesViewState() {
    // the persisted bits of LS_UI (sort + view mode) - read once at mount
    const ui = lsUi();
    if (ui.filesSort && ["mtime", "name", "size"].includes(ui.filesSort.key)) {
        filesSort = { key: ui.filesSort.key, dir: ui.filesSort.dir === "asc" ? "asc" : "desc" };
    }
    if (ui.filesView === "tree") filesView = "tree";
}

/** v108: the path RELATIVE to the workflows root - the Files tab displays
 *  and filters by THIS shape (the storage paths carry the "workflows/"
 *  prefix; the owner asked for the path under the name relative to the
 *  workflows folder). */
function relWfPath(p) {
    return normWfPath(p).replace(/^workflows\//, "");
}

function fileFolderOf(p) {
    const s = relWfPath(p);
    const i = s.lastIndexOf("/");
    return i < 0 ? "" : s.slice(0, i);
}

/** The date filter bounds in ms. Quick periods give a LOWER bound only (a
 *  skewed clock must not hide a fresh file); the explicit from/until dates
 *  are inclusive. A date input change clears the quick chip and back. */
function filesDateBoundFrom() {
    if (filesQuick === "today") {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }
    if (filesQuick === "7d") return Date.now() - 7 * DAY_MS;
    if (filesQuick === "30d") return Date.now() - 30 * DAY_MS;
    if (filesDateFrom) {
        const t = Date.parse(filesDateFrom + "T00:00:00");
        if (Number.isFinite(t)) return t;
    }
    return null;
}

function filesDateBoundTo() {
    if (filesDateTo) {
        const t = Date.parse(filesDateTo + "T23:59:59.999");
        if (Number.isFinite(t)) return t;
    }
    return null;
}

function filesActiveFilterCount() {
    let n = 0;
    if (filesFolder) n++;
    if (filesQuick || filesDateFrom || filesDateTo) n++;
    if (fileSizeMin !== "" || fileSizeMax !== "") n++;
    if (filesUuid) n++; // v112 stage 2: the UUID filter
    return n;
}

/** Every folder that holds (or leads to) a workflow file - the folder filter
 *  select and the tree both build from this. Ancestors of file folders are
 *  included so any nesting level is reachable. */
function filesFolderList() {
    const dirs = new Set();
    for (const f of savedFiles) {
        const parts = fileFolderOf(f.path).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return [...dirs].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The filter pipeline (search tokens over name + nested folders, folder,
 *  date range, size range, ★-only) + the sort. One function - the list mode,
 *  the tree leaves and the status counts all read the same answer. */
function filteredSavedFiles() {
    const toks = filesSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const fromMs = filesDateBoundFrom();
    const toMs = filesDateBoundTo();
    const minB = fileSizeMin !== "" && Number.isFinite(parseFloat(fileSizeMin))
        ? parseFloat(fileSizeMin) * 1024 : null;
    const maxB = fileSizeMax !== "" && Number.isFinite(parseFloat(fileSizeMax))
        ? parseFloat(fileSizeMax) * 1024 : null;
    const folder = filesView === "tree" ? "" : filesFolder;
    let list = savedFiles.filter((f) => {
        const rel = relWfPath(f.path);
        if (filesFavOnly && !filesFav.has(normWfPath(f.path))) return false;
        if (folder && !(rel === folder || rel.startsWith(folder + "/"))) return false;
        if (toks.length) {
            // the search covers the name AND every nested folder segment
            if (!toks.every((t) => rel.toLowerCase().includes(t))) return false;
        }
        const mt = (f.mtime || 0) * 1000;
        if (fromMs != null && (!mt || mt < fromMs)) return false;
        if (toMs != null && (!mt || mt > toMs)) return false;
        if (minB != null && (f.size || 0) < minB) return false;
        if (maxB != null && (f.size || 0) > maxB) return false;
        return true;
    });
    const mul = filesSort.dir === "asc" ? 1 : -1;
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    const byNamePathAsc = (a, b) => byName(a, b) ||
        String(relWfPath(a.path)).localeCompare(String(relWfPath(b.path)), undefined, { sensitivity: "base" });
    list.sort((a, b) => {
        let r;
        if (filesSort.key === "name") r = byName(a, b) * mul;
        else if (filesSort.key === "size") r = ((a.size || 0) - (b.size || 0)) * mul;
        else r = ((a.mtime || 0) - (b.mtime || 0)) * mul;
        // v112 (plan 3.9): the tie-break is ALWAYS name-ascending (path as
        // the second tie) - a DESC pass must not reverse the alphabet inside
        // one mtime/size group (the old `r * mul` multiplied the tie-break
        // by the direction too)
        if (!r) r = byNamePathAsc(a, b);
        return r;
    });
    return list;
}

/** The relative path shortened through "…" keeping the LAST folders + the
 *  file name (the owner's spec); the full path stays on hover (title). */
function shortPath(p, maxLen = 34) {
    const s = normWfPath(p);
    if (s.length <= maxLen) return s;
    const parts = s.split("/");
    const name = parts.pop() || "";
    const keep = [];
    let used = name.length + 2;
    for (let i = parts.length - 1; i >= 0; i--) {
        const seg = parts[i];
        if (used + seg.length + 1 > maxLen) break;
        keep.unshift(seg);
        used += seg.length + 1;
    }
    return "…/" + (keep.length ? keep.join("/") + "/" : "") + name;
}

function fmtSize(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "";
    if (v < 1024) return v + " B";
    const kb = v / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + " KB";
    return (kb / 1024).toFixed(1) + " MB";
}

function fmtDateTime(ts) {
    if (!ts) return "";
    try {
        const d = new Date(ts * 1000);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
            " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (_) { return ""; }
}

// --- v108: the server-backed favorites -------------------------------------

async function fetchFileFavs() {
    try {
        const res = await jfetch("/settings_hub/workflows/files-fav");
        if (res.json?.ok && Array.isArray(res.json.favs)) {
            filesFav = new Set(res.json.favs.map(normWfPath));
        }
    } catch (_) { /* old py - the star toggles degrade to a toast */ }
    filesFavsLoaded = true;
    return true;
}

/** Toggle ONE favorite. Optimistic: the star flips right away (a re-render
 *  must not wait on the network), the server answer settles the truth, a
 *  failure reverts the flip and names the problem. */
async function toggleFileFav(path) {
    const norm = normWfPath(path);
    if (!norm) return false;
    const next = !filesFav.has(norm);
    if (next) filesFav.add(norm); else filesFav.delete(norm);
    renderAll();
    const res = await jfetch("/settings_hub/workflows/files-fav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: norm, fav: next }),
    });
    if (res.json?.ok && Array.isArray(res.json.favs)) {
        filesFav = new Set(res.json.favs.map(normWfPath));
        renderAll();
        return true;
    }
    if (next) filesFav.delete(norm); else filesFav.add(norm); // revert
    renderAll();
    localToast(res.status === 404
        ? "Could not save the favorite - the server has no files-fav route (old py): update the FULL pack."
        : "Could not save the favorite - see F12", 3600);
    return false;
}

// --- v108: the folder tree (tree view mode) --------------------------------

/** parentDir -> Set(subDirName) over every saved file path. Leaf folders
 *  (files only, no subfolder) get an empty set so they stay addressable.
 *  v112: prefer buildTreeIndex() for rendering - THIS helper stays for the
 *  tests/back-compat. */
function buildFolderMap() {
    const map = new Map();
    for (const f of savedFiles) {
        const segs = fileFolderOf(f.path).split("/").filter(Boolean);
        let acc = "";
        for (const s of segs) {
            if (!map.has(acc)) map.set(acc, new Set());
            map.get(acc).add(s);
            acc = acc ? acc + "/" + s : s;
        }
        if (!map.has(acc)) map.set(acc, new Set());
    }
    return map;
}

/** v112 (plan 3.7): the folder tree index in ONE pass over the list - the
 *  folder map AND the deep file count of every folder in one walk (the old
 *  code ran a full filter() over the whole list PER FOLDER ROW). Cached on
 *  the list reference: a new filtered array rebuilds it, a re-render of
 *  the same list reuses it. */
let _treeIdx = null;
let _treeIdxList = null;
function buildTreeIndex(list) {
    if (_treeIdx && _treeIdxList === list) return _treeIdx;
    const map = new Map();
    const counts = new Map();
    for (const f of list) {
        const segs = fileFolderOf(f.path).split("/").filter(Boolean);
        let acc = "";
        for (const s of segs) {
            if (!map.has(acc)) map.set(acc, new Set());
            map.get(acc).add(s);
            acc = acc ? acc + "/" + s : s;
            counts.set(acc, (counts.get(acc) || 0) + 1); // the deep count
        }
        if (!map.has(acc)) map.set(acc, new Set());
    }
    _treeIdx = { map, counts };
    _treeIdxList = list;
    return _treeIdx;
}

/** How many files a folder holds at ANY depth (the folder row's counter).
 *  v112: reads the one-pass index (O(files) total, not O(files) per row).
 *  Kept for the tests/back-compat. */
function deepCountIn(dir) {
    if (!dir) return savedFiles.length;
    const pre = dir + "/";
    return savedFiles.filter((f) => relWfPath(f.path).startsWith(pre)).length;
}

function folderRowHtml(full, label, depth, open, count) {
    return `<div class="hub-wf-row hub-wf-trow">` +
        `<button type="button" class="hub-wf-caret" data-act="treefold" data-folder="${esc(full)}" ` +
        `title="${open ? "Collapse" : "Expand"} this folder (any depth)">${open ? "▾" : "▸"}</button>` +
        `<button type="button" class="hub-wf-tname" data-act="treeenter" data-folder="${esc(full)}" ` +
        `title="Enter ${esc(full)}" style="padding-left:${depth * 10}px">${esc(label)}/</button>` +
        `<span class="hub-wf-tcount">${count}</span>` +
        `</div>`;
}

// ---------------------------------------------------------------------------
// Recently-closed ring buffer (🕘 Files & Recent)
// v112 (plan 3.6): the SERVER is the source of truth for the ring METADATA.
// Each browser session owns a manifest record (workflows_manager/recent/<cid>
// .json server-side) and every temp snapshot is referenced by the UNION of
// the manifests - one browser can never delete a snapshot another browser
// still points at. The localStorage ring stays as the offline mirror + the
// degraded fallback (an old py without the recent routes = v107 behavior,
// surfaced in the UI as "recent available only locally"). The temp payload
// files themselves live server-side as temp/<id>.json exactly as in v107.
// ---------------------------------------------------------------------------

let recent = lsJson(LS_RECENT, []);
if (!Array.isArray(recent)) recent = [];
sanitizeRecent(); // v106: drop the legacy ".null" garbage + unrestorable rows

/** v112: the stable browser-session id (one manifest record per session).
 *  Generated once, kept in localStorage; a cleared localStorage simply
 *  re-registers as a new session (its old manifest expires by TTL). */
function clientSessionId() {
    try {
        let cid = localStorage.getItem(LS_CLIENT);
        if (typeof cid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(cid)) return cid;
        cid = "c" + (crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 24)
            : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
        localStorage.setItem(LS_CLIENT, cid);
        return cid;
    } catch (_) { return "c" + Date.now().toString(36); }
}

let recentServer = null;   // true = the server manifests are live (v112)
let recentSyncT = null;    // the debounce of the manifest sync
// v112: the tempIds this browser EVICTED from its ring since the last
// successful sync (the debounce collapses bursts of closes, so the eviction
// candidates accumulate here - the plan's reference accounting needs them
// to survive the whole burst)
let _pendingEvicted = [];
// v117: the armed Clear of the Recently closed list (a two-click confirm -
// the plan's 'Clear Recently closed' button next to the group header)
let recentClearArmed = null;   // a timeout id - the 2.5s disarm window

function sanitizeRecent() {
    const ok = (r) => r && typeof r === "object" &&
        (typeof r.tempId === "string" && r.tempId ||
            r.snap !== null && typeof r.snap === "object" ||
            (typeof r.path === "string" && r.path &&
                !r.path.toLowerCase().endsWith(".null")));
    recent = recent.filter(ok).slice(0, recentLimit());
}

function reloadRecent() {
    const v = lsJson(LS_RECENT, []);
    recent = Array.isArray(v) ? v : [];
    sanitizeRecent();
    persistRecent();
}

function persistRecent() {
    // the v106 degrade ladder guards the FALLBACK embeds only now - an
    // entry carrying a server tempId has no snap and is a few dozen chars
    let used = 0;
    const list = recent.slice(0, recentLimit()).map((r) => {
        if (!r || !r.snap) return r;
        used += JSON.stringify(r.snap).length;
        return used > RECENT_BUDGET ? { path: r.path, name: r.name, ts: r.ts } : r;
    });
    saveJson(LS_RECENT, list);
}

/** v112: upload the ring manifest to the server (debounced ~600ms - bursts
 *  of closes must not stampede the POST route). On success the server-side
 *  reference union comes back; the evicted temps of THIS ring are deleted
 *  ONLY when NO manifest references them anymore (cross-browser safe).
 *  Never throws; a failure just leaves the v107 semantics for this close. */
function syncRecentManifest(immediate = false) {
    if (!serverState) return;
    clearTimeout(recentSyncT);
    const send = async () => {
        const evicted = _pendingEvicted;
        _pendingEvicted = [];
        try {
            const res = await jfetch("/settings_hub/workflows/recent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    clientId: clientSessionId(),
                    entries: recent.slice(0, recentLimit()).map((r) => ({
                        path: r.path || null, name: r.name || "Unsaved",
                        ts: r.ts || 0, tempId: r.tempId || null, snap: null,
                    })),
                }),
            });
            if (res.json?.ok) {
                recentServer = true;
                // cross-browser reference accounting: delete an evicted
                // snapshot only when NO manifest references it anymore (the
                // server computed the union over every browser session)
                const refs = new Set(res.json.refs || []);
                const keep = new Set(recent.map((r) => r.tempId).filter(Boolean));
                for (const tid of evicted) {
                    if (tid && !keep.has(tid) && !refs.has(tid)) {
                        void deleteTempSnapshot(tid);
                    }
                }
            } else {
                // the sync failed - the candidates stay pending for the retry
                _pendingEvicted.push(...evicted);
            }
        } catch (_) {
            _pendingEvicted.push(...evicted); // the local ring stays the fallback
        }
    };
    // v117: the Clear button flushes IMMEDIATELY (the plan: 'немедленно
    // отправлять пустой entries: []') - every other path keeps the ~600ms
    // debounce that collapses bursts of closes
    if (immediate) void send();
    else recentSyncT = setTimeout(send, 600);
}

/** v117 (the owner's plan section 3): clear the Recently closed list of
 *  THIS browser session only. The workflow files, Presets, Favorites and
 *  the Process history are NEVER touched. The empty manifest goes to the
 *  server immediately ({entries: []} for this clientId - the other
 *  browsers' manifests stay), and this session's evicted snapshots are
 *  freed ONLY when no other session's manifest still references them (the
 *  server's refs union answers that). The tab shows 'Nothing closed yet'
 *  right away. */
function recentClearAll() {
    recentClearArmed = null;
    const evicted = (Array.isArray(recent) ? recent : [])
        .map((r) => (r && typeof r.tempId === "string" && r.tempId) || null)
        .filter(Boolean);
    _pendingEvicted.push(...evicted);
    recent = [];
    persistRecent();
    syncRecentManifest(true);   // the plan: the empty manifest goes NOW
    renderAll();
}

/** v112 boot: adopt the SERVER manifest for this session (the plan: the
 *  localStorage ring must not be the only source). A 404 (fresh session)
 *  MIGRATES the existing localStorage ring up without losing references;
 *  a 404 on the POST too (an old py) keeps the v107 local-only behavior. */
async function loadRecentFromServer() {
    if (!serverState) return false;
    const cid = clientSessionId();
    try {
        const res = await jfetch("/settings_hub/workflows/recent/" + encodeURIComponent(cid));
        if (res.json?.ok && Array.isArray(res.json.entries)) {
            recent = res.json.entries.filter((r) => r && typeof r === "object")
                .slice(0, recentLimit());
            sanitizeRecent();
            persistRecent();
            recentServer = true;
            return true;
        }
        // no manifest yet (fresh session / cleared storage): upload the
        // migrated localStorage ring - the entries keep their tempIds, so
        // the referenced snapshots stay alive
        if (res.status === 404) {
            syncRecentManifest();
            return true;
        }
    } catch (_) {}
    return false;
}

/** The recently-closed ring. v107: a TEMP tab (no real file behind it - the
 *  autosave-ish "Unsaved Workflow (N).json" names never materialize in
 *  userdata, and the duplicate suffix builds "... (2).null") is recorded
 *  WITH its graph - but the graph payload is uploaded to the SERVER
 *  (temp/<id>.json, a reserved subfolder of the workflows storage root) and
 *  the ring entry keeps only {name, ts, tempId}. localStorage cannot be the
 *  guarantee anymore: ComfyUI and the other custom extensions share the
 *  same origin quota. The v106 embed stays as the fallback when the server
 *  has no temp routes (an old py) or the upload fails - RECENT_SNAP_CAP
 *  bounds THAT fallback. A modified PERSISTED tab keeps its unsaved state
 *  the same way (server first, embed fallback) - the reopen shows what was
 *  on screen, not the stale disk copy. Empty temps and snapshots that are
 *  BOTH too large for the server AND the fallback cap are not recorded (a
 *  recent row must always open). snap is captured by closeWorkflowTab
 *  BEFORE the store drops the ref. Resolves {ok, tempId?} for the tests. */
function recordRecent(w, snap = null) {
    if (!w) return Promise.resolve({ ok: false });
    const temp = !!w.isTemporary || !w.path;
    // a ".null" path is never a real file - treat the tab as temp-like
    const garbagePath = !!w.path && normWfPath(w.path).toLowerCase().endsWith(".null");
    const path = (!temp && !garbagePath) ? normWfPath(w.path) : null;
    const name = w.name || (path ? baseName(path) : "Unsaved");
    if (!path && (!snap || w.isEmpty)) return Promise.resolve({ ok: false }); // nothing reopenable - skip
    const prev = recent;
    const same = (r) => path ? sameWfPath(r.path, path) : (!r.path && r.name === name);
    return (async () => {
        let tempId = null, embed = null;
        if (snap) {
            const saved = await saveTempSnapshot(name, snap);
            if (saved.ok) {
                tempId = saved.id; // the payload lives server-side now
            } else {
                // fallback: the v106 localStorage embed (small graphs only)
                try { if (JSON.stringify(snap).length <= RECENT_SNAP_CAP) embed = snap; } catch (_) {}
                if (!embed && !path) return { ok: false, tooLarge: true };
            }
        }
        recent = [{ path, name, ts: Date.now(),
                ...(tempId ? { tempId } : {}), ...(embed ? { snap: embed } : {}) },
            ...prev.filter((r) => !same(r))].slice(0, recentLimit());
        // v112: collect the tempIds that just LEFT the ring - the debounced
        // manifest sync owns their deletion (server reference union first;
        // the old direct dropEvictedTemps could orphan ANOTHER browser's
        // snapshot - plan 3.6)
        const keepIds = new Set(recent.map((r) => r.tempId).filter(Boolean));
        for (const r of prev) {
            if (r && typeof r.tempId === "string" && r.tempId && !keepIds.has(r.tempId)) {
                _pendingEvicted.push(r.tempId);
            }
        }
        persistRecent();
        syncRecentManifest();
        return { ok: true, tempId };
    })();
}

/** v112: kept for the tests/diagnostics - the DELETION decision moved into
 *  syncRecentManifest (server reference union). Deleting a temp snapshot
 *  directly here would break the plan 3.6 ownership contract. */
function dropEvictedTemps(prev) {
    const keep = new Set(recent.map((r) => r.tempId).filter(Boolean));
    const seen = new Set();
    for (const r of prev) {
        if (!r || typeof r.tempId !== "string" || !r.tempId) continue;
        if (seen.has(r.tempId) || keep.has(r.tempId)) continue;
        seen.add(r.tempId);
        void deleteTempSnapshot(r.tempId);
    }
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
// v116 (plan 7.6): the Files batch DELETE state - the armed confirm + the
// last operation's undo handle (the server keeps the verified safety
// snapshots for 2 h; the button lives in the selection toolbar)
let fileOpsArmed = false;
let fileOpsUndo = null;             // {opId, expiresAt} of the last batch
let fileOpsBusy = false;
// v117 (the owner's plan section 2): the PREVIEW-driven confirm state - the
// first click fetches the server's preview (which versions become
// unreachable, which copies stay, which presets point at the files) and the
// strip renders it; the second click performs the deletion.
let fileOpsConfirm = null;          // {data, paths} of the current preview
let chipMoved = false;              // the chip drag-vs-click discriminator
let presetsSearch = "";
// v112 stage 4 (plan 9): the category/tag filter state (compact - hidden
// behind the ⚑ chip per the progressive-disclosure contract)
let presetsFadvOpen = false;
let presetsCat = "";   // "" = all
let presetsTag = "";   // "" = all
let filesSearch = "";
let openSearch = "";       // v103: the multi-word filter of the Open tab
let pollT = null;
let pollSeq = 0;
let pollN = 0;
let lastOpenSig = "";
let lastLoadSig = "";      // v105: the retry render guard's last seen value
let renderedTab = null;    // v106: the scroll-keep guard's last rendered tab

function openHasPath(p) {
    // v112 (plan 3.3): ONE canonical comparison for every open-tab check
    return openTabs.some((t) => t.path && sameWfPath(t.path, p));
}

/** v112 (plan 3.8): the saved-file path index - ONE canonical Set built per
 *  refresh/render pass (the old missingPathsOf rebuilt Sets per preset-card
 *  ROW, O(presets x items x files) in the template). Invalidated on every
 *  refreshSavedFiles() (the only writer of savedFiles). */
let _savedPathIdx = null;
function savedPathIndex() {
    if (!_savedPathIdx) {
        const s = new Set();
        for (const f of savedFiles) {
            const c = canonWfRel(f.path);
            if (c) s.add(c);
        }
        _savedPathIdx = s;
    }
    return _savedPathIdx;
}

function missingPathsOf(preset) {
    if (!savedFilesLoaded) return [];
    const known = savedPathIndex();
    return (preset.items || [])
        .filter((it) => it.kind === "path")
        .filter((it) => {
            const c = canonWfRel(it.path);
            return !c || !known.has(c); // unknown/unsafe path = missing
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
    // v112 (plan 3.3): ALL path set-membership goes through canonWfRel
    const itemPaths = new Set((preset.items || [])
        .filter((it) => it.kind === "path")
        .map((it) => canonWfRel(it.path))
        .filter(Boolean));
    const open = getOpenWorkflows();
    const keep = [], close = [];
    for (const t of open) {
        const inPreset = !!(t.path && itemPaths.has(canonWfRel(t.path)));
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
    const keptPaths = new Set(keep.filter((t) => t.path).map((t) => canonWfRel(t.path)));
    const openPaths = new Set(open.filter((t) => t.path).map((t) => canonWfRel(t.path)));
    const toOpenPaths = (preset.items || [])
        .filter((it) => it.kind === "path" && !keptPaths.has(canonWfRel(it.path)));
    let toOpenSnaps = (preset.items || []).filter((it) => it.kind === "snapshot");
    // v112 stage 3 (plan 8): the batch duplicate accounting - the exact
    // copies of ALREADY-OPEN temp tabs are counted and can be SKIPPED by an
    // explicit user choice (the default opens all copies - nothing is
    // dropped silently)
    const dupCount = (opts.skipDupSnaps ? toOpenSnaps : []).filter((it) => {
        const dup = findSnapshotDuplicates(it.graph);
        return !!dup.exact;
    }).length;
    if (opts.skipDupSnaps) {
        toOpenSnaps = toOpenSnaps.filter((it) => !findSnapshotDuplicates(it.graph).exact);
    }
    return {
        preset, keep, close, toOpenPaths, toOpenSnaps,
        reopenClosed: toOpenPaths.filter((it) => openPaths.has(canonWfRel(it.path))),
        missing: missingPathsOf(preset),
        keepUnsaved,
        dupCount,
    };
}

/** v112 (plan 3.1): SNAPSHOT-BASED UNDO. Before a destructive apply the
 *  FULL workspace state is captured SERVER-side (POST /workflows/undo):
 *  every open tab's path/flags AND the actual graph JSON of any tab that
 *  may be closed/overwritten (temp tabs, modified persisted tabs - the
 *  plan: "включая temp и modified persisted tabs"). The browser keeps only
 *  the undoId. A failed/oversized capture resolves {ok:false, reason} and
 *  the apply plan then REFUSES the destructive close for the unsnapshotable
 *  tabs (never silently drops unsaved work). The old paths-only
 *  sessionUndo is gone: undo restores the actual graphs, not just paths. */
async function captureUndo() {
    const open = getOpenWorkflows();
    const act = open.find((t) => t.isActive) || null;
    const plan = {
        paths: open.filter((t) => t.path).map((t) => t.path),
        activePath: act?.path || null,
        openedKeys: [],
        undoId: null,
        ts: Date.now(),
    };
    const tabs = [];
    let failed = [];
    for (const t of open) {
        let graph = null;
        // capture the JSON of every tab whose content may be lost: temp tabs
        // and modified persisted tabs (clean persisted tabs reopen by path)
        if (t.isTemporary || t.isModified || !t.isPersisted) {
            graph = graphJsonOfOpenTab(t);
            if (!graph) {
                failed.push(t.name || t.path || "tab");
                graph = null;
            }
        }
        tabs.push({
            key: t.key, path: t.path || null, name: t.name || null,
            active: !!t.isActive, modified: !!t.isModified,
            temp: !!t.isTemporary || !t.isPersisted, graph,
        });
    }
    if (failed.length) {
        // plan 3.1: "При неудачном snapshot не выполнять destructive close
        // соответствующей вкладки. Показать точную причину."
        return { ...plan, ok: false,
            reason: "could not serialize " + failed.join(", ") };
    }
    if (!serverState) {
        return { ...plan, ok: false,
            reason: "the server is offline - the undo snapshot cannot be stored" };
    }
    try {
        const res = await jfetch("/settings_hub/workflows/undo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabs, activeKey: act?.key || null }),
        });
        if (res.json?.ok && typeof res.json.undoId === "string") {
            return { ...plan, ok: true, undoId: res.json.undoId };
        }
        return { ...plan, ok: false,
            reason: (res.json && res.json.error) || ("HTTP " + (res.status || "?")) };
    } catch (e) {
        return { ...plan, ok: false, reason: String((e && e.message) || e) };
    }
}

/** v112: restore ONE pre-apply tab from the server undo snapshot. A tab
 *  with a captured graph gets its content back (a modified persisted tab
 *  is reopened by path FIRST so the file binding survives, then the
 *  in-memory graph is swapped onto the canvas; a temp tab reopens as a
 *  snapshot). A graph-less tab reopens by path. */
async function restoreUndoTab(tab) {
    if (!tab || typeof tab !== "object") return false;
    const path = tab.path ? normWfPath(tab.path) : null;
    if (tab.graph && typeof tab.graph === "object") {
        if (path && !tab.temp) {
            // modified persisted tab: bind the file first, then swap the
            // graph (loadGraphData carries the path -> the SAME tab is
            // reopened with its unsaved state)
            const opened = await openWorkflowByPath(path);
            if (opened.ok) {
                try {
                    const bindName = path.replace(/^workflows\//, "");
                    await app.loadGraphData(tab.graph, true, true, bindName, {
                        showMissingModelsDialog: false,
                        showMissingNodesDialog: false,
                        checkForRerouteMigration: false,
                    });
                    return true;
                } catch (_) { /* the saved-file version stays - not a silent loss:
                               the snapshot graph is below */ }
            }
        }
        const r = await openSnapshotWorkflow(tab.name || (path ? baseName(path) : "Unsaved"), tab.graph);
        return !!r.ok;
    }
    if (path) {
        const r = await openWorkflowByPath(path);
        return !!r.ok;
    }
    return false;
}

async function applyPlan(plan) {
    const p = plan.preset;
    const preKeys = getOpenWorkflows().map((t) => t.key);
    // v112 (plan 3.1): the snapshot is REQUIRED before any destructive close.
    // A failed capture blocks the close of the tabs it could not protect -
    // the plan degrades to "open-only" with the exact reason, never to a
    // silent loss.
    const undoCap = await captureUndo();
    if (!undoCap.ok && plan.close.length) {
        const risky = plan.close.filter((t) => t.isModified || !t.isPersisted);
        if (risky.length) {
            await refreshOpen(true);
            renderAll();
            actionToast("Switch blocked: the undo snapshot failed (" +
                (undoCap.reason || "?") + ") - " + risky.length +
                " unsaved tab(s) would be lost. Opened what was safe.",
                "↩ Retry", () => { void (async () => {
                    const cap2 = await captureUndo();
                    if (cap2.ok) await applyPlan(plan);
                    else localToast("Undo snapshot still failing: " + cap2.reason, 4200);
                })(); }, 7000);
            return;
        }
    }
    // v112: sessionUndo ALWAYS exists after a successful capture (undoId +
    // server snapshot); a failed capture still allows a paths-only undo
    // (only safe when no risky tabs were closed - checked above)
    sessionUndo = undoCap;
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
    // 3) activate the preset's active tab - v112 stage 3 (plan 7.3): the
    // active item may be a SNAPSHOT (activeItemId); the snapshot's temp tab
    // opened above is the LAST matching snapshot - activate by name
    if (p.activePath) {
        const t = getOpenWorkflows().find((x) => x.path && sameWfPath(x.path, p.activePath));
        if (t) await activateWorkflow(t);
    } else if (p.activeItemId) {
        const it = (p.items || []).find((x) => x.itemId === p.activeItemId);
        if (it?.kind === "snapshot") {
            const t = [...getOpenWorkflows()].reverse()
                .find((x) => !x.path && x.name === (it.name || it.sourceName));
            if (t) await activateWorkflow(t);
        }
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
    // v112 (plan 3.1): fetch the SERVER snapshot - the actual pre-apply
    // graphs, including temp tabs and the unsaved states of persisted tabs.
    let snapTabs = null, snapActiveKey = null;
    if (u.undoId) {
        try {
            const res = await jfetch("/settings_hub/workflows/undo/" + encodeURIComponent(u.undoId));
            if (res.json?.ok && Array.isArray(res.json.tabs)) {
                snapTabs = res.json.tabs;
                snapActiveKey = res.json.activeKey || null;
            }
        } catch (_) {}
        // consumed: the snapshot is one-shot (bounded server storage)
        void jfetch("/settings_hub/workflows/undo/" + encodeURIComponent(u.undoId), { method: "DELETE" });
    }
    const keep = new Set((u.paths || []).map(canonWfRel));
    const openedByApply = new Set(u.openedKeys || []);
    // retire what the apply brought in (still untouched) - the tabs the user
    // had BEFORE the apply survive unless they were retired by it
    for (const t of getOpenWorkflows()) {
        if (lockedKeys.has(t.key)) continue;
        if (t.isModified) continue;   // never close touched work on undo
        if (t.path && keep.has(canonWfRel(t.path))) continue;
        if (!openedByApply.has(t.key) && (t.isModified || (!t.isPersisted && !t.isEmpty))) {
            // a PRE-EXISTING unsaved/temp tab the plan kept - hands off
            continue;
        }
        await closeWorkflowTab(t, { forceClean: true });
        await sleep(TAB_SEQ);
        await nextFrame();
    }
    // bring the pre-apply set back - WITH the captured graphs when the
    // snapshot is available (temp tabs + modified persisted tabs restore
    // their actual content, not just the file paths)
    if (snapTabs) {
        const knownKeys = new Set(snapTabs.map((t) => t.key || ""));
        for (const tab of snapTabs) {
            const path = tab.path ? normWfPath(tab.path) : null;
            if (path && openHasPath(path)) {
                // already open: restore the pre-apply MODIFIED content only
                // when the current copy is clean (post-apply work survives)
                const cur = getOpenWorkflows().find((t) => t.path && sameWfPath(t.path, path));
                if (cur && (cur.isModified || (tab.graph && tab.modified))) {
                    if (!cur.isModified && tab.graph && tab.modified) {
                        await restoreUndoTab(tab);
                        await sleep(TAB_SEQ);
                        await nextFrame();
                    }
                }
                continue;
            }
            if (!path && tab.key && openTabs.some((t) => t.key === tab.key)) {
                continue; // that temp tab is still open - nothing to restore
            }
            const ok = await restoreUndoTab(tab);
            if (!ok && path) {
                await openWorkflowByPath(path); // the file at least
            }
            await sleep(TAB_SEQ);
            await nextFrame();
        }
        // a paths-only safety net: every pre-apply PATH must be open again
        for (const path of (u.paths || [])) {
            if (!openHasPath(path)) {
                await openWorkflowByPath(path);
                await sleep(TAB_SEQ);
                await nextFrame();
            }
        }
        // activate what was active pre-apply (by the snapshot key, then path)
        let act = snapActiveKey ? getOpenWorkflows().find((t) => knownKeys.has(t.key) && t.key === snapActiveKey) : null;
        if (!act && u.activePath) {
            act = getOpenWorkflows().find((x) => x.path && sameWfPath(x.path, u.activePath)) || null;
        }
        if (act) await activateWorkflow(act);
    } else {
        // degraded (no snapshot): paths-only restore - reached only when no
        // risky tab was closed (the apply refuses destructive closes then)
        for (const path of (u.paths || [])) {
            if (!openHasPath(path)) {
                await openWorkflowByPath(path);
                await sleep(TAB_SEQ);
                await nextFrame();
            }
        }
        if (u.activePath) {
            const t = getOpenWorkflows().find((x) => x.path && sameWfPath(x.path, u.activePath));
            if (t) await activateWorkflow(t);
        }
    }
    await refreshOpen(true);
    renderAll();
    localToast(snapTabs
        ? "Restored the previous workspace (including unsaved states)"
        : "Restored the previous set of open workflows");
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
    loadFilesViewState(); // v108: the persisted Files sort + view mode
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
    // v113: ComfyUI binds keyup too (releasing a combo fires actions) - the
    // text fields must contain BOTH halves of the keystroke
    panel.querySelector(".hub-wf-body").addEventListener("keyup", (e) => {
        if (isWfTextField(e.target)) e.stopPropagation();
    });

    // v112 (plan 3.4): mount ON the Files tab starts the listing fetch
    // immediately - no detour through another tab is required anymore
    if (uiTab === "files") void refreshSavedFiles();
}

function setUiTab(tab) {
    if (!["open", "presets", "files"].includes(tab)) return;
    if (uiTab === tab) return;
    uiTab = tab;
    saveUi({ tab });
    if (tab === "files" || tab === "presets") void refreshSavedFiles();
    // v112 stage 2: the Files tab drives the index engine
    if (tab === "files") {
        void ensureIndexStatus();
        if (idxReady === true) void runServerList(true);
        else if (idxReady === null) {
            void (async () => {
                await ensureIndexStatus();
                if (idxReady === true) void runServerList(true);
            })();
        }
    }
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
    // v113: a re-render must not drop the text cursor. Every filter/search
    // box (and every other [data-wf] control) keeps focus + exact caret
    // position across the rebuild - the v112 code restored focus only in
    // the keystroke path, so the DEBOUNCED server answer (and every other
    // async renderAll) silently moved focus away from the search box and
    // the next keystrokes hit ComfyUI's hotkeys instead of the field.
    const ae = document.activeElement;
    let focusWf = null, selA = -1, selB = -1;
    if (ae && panel.contains(ae) && ae.matches?.("[data-wf]")) {
        focusWf = ae.dataset.wf || null;
        try { selA = ae.selectionStart; selB = ae.selectionEnd; } catch (_) {}
    }
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
    if (focusWf) {
        const el = body.querySelector('[data-wf="' + focusWf + '"]') ||
            panel.querySelector('[data-wf="' + focusWf + '"]');
        if (el) {
            try { el.focus(); } catch (_) {}
            if (selA >= 0 && typeof el.setSelectionRange === "function") {
                try { el.setSelectionRange(selA, selB); } catch (_) {}
            }
        }
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
    const rows = list.slice(0, openRowsShown).map((t, i) => {
        if (i >= openRowsShown) return "";
        const locked = lockedKeys.has(t.key);
        const marks = [
            t.isActive ? `<span class="hub-wf-dot" title="Active">●</span>` : "",
            t.isModified ? `<span class="hub-wf-mod" title="Unsaved changes">*</span>` : "",
            t.isTemporary ? `<span class="hub-wf-temp" title="Not saved to disk yet">temp</span>` : "",
            t.isEmpty ? `<span class="hub-wf-empty" title="0 nodes">(empty)</span>` : "",
        ].join("");
        // v112 stage 3 (plan 6): the PER-TAB save - persisted = save in
        // place, temp = Save As ladder, clean = an explicit save (unified UX)
        const saveMark = saveState.get(t.key);
        const saveBtn = `<button type="button" class="hub-wf-lockbtn${saveMark === "saved" ? " hub-wf-locked" : ""}" data-act="savetab" data-key="${esc(t.key)}" ` +
            `title="${t.isPersisted ? (t.isModified ? "Save this tab to its file" : "Save this tab (no changes yet)") : "Save As... (hands the tab to ComfyUI's own Save-As flow)"}">${saveMark === "saving" ? "…" : (saveMark === "saved" ? "✓" : "💾")}</button>`;
        return `<div class="hub-wf-row${t.isActive ? " hub-wf-row-active" : ""}${locked ? " hub-wf-row-locked" : ""}" data-key="${esc(t.key)}">` +
            `<button type="button" class="hub-wf-name" data-act="activate" data-key="${esc(t.key)}" title="${esc(t.path || "temporary tab")}">${esc(t.name)}${t.isModified ? " *" : ""}</button>` +
            `<span class="hub-wf-marks">${marks}</span>` +
            saveBtn +
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
        // v112 (plan 3.5): the status shows the chunk position when the list
        // is longer than the rendered chunk ("showing N of M"), the search
        // still covers the FULL open set
        `<div class="hub-wf-status">${toks.length ? list.length + " of " : ""}${openTabs.length} open${openTabs.length > openRowsShown ? " · showing " + Math.min(openRowsShown, list.length) + " of " + list.length : ""}${unsaved ? " · unsaved work present" : ""}${queueRunning ? " · ⚠ generation running" : ""}</div>`;
}

function presetCardHtml(p) {
    const items = p.items || [];
    // v112 stage 4 (plan 9): the category + the tag chips (a long list
    // collapses; the full set stays on hover)
    const cat = p.category || "Uncategorized";
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const shownTags = tags.slice(0, 4);
    const tagChips = shownTags.map((t) =>
        `<span class="hub-wf-snap" title="Tag: ${esc(t)}">#${esc(t)}</span>`).join("") +
        (tags.length > shownTags.length ? `<span class="hub-wf-snap" title="${esc(tags.slice(4).join(", "))}">+${tags.length - 4}</span>` : "");
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
        `<span class="hub-wf-snap" title="Category: ${esc(cat)}" data-cat="${esc(cat)}">${esc(cat)}</span>` +
        tagChips +
        `<span class="hub-wf-card-badge">${items.length} wf</span>` +
        `<button type="button" class="hub-wf-cbtn" data-act="pver" data-pid="${esc(p.id)}" title="Version history: the automatic archives before every change (restore any point)">🕘</button>` +
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
            : (f.snapMode
                ? `<span class="hub-wf-sf-snap">→ embedded snapshot</span>`
                : (r.isModified ? `<span class="hub-wf-sf-mod" title="The tab has unsaved changes">* (references disk file)</span>` : ""));
        return `<label class="hub-wf-sf-row">` +
            `<input type="checkbox" data-wf-check="${i}"${r.checked ? " checked" : ""}>` +
            `<input type="radio" name="hub-wf-activeradio" data-wf-radio="${i}"${(f.activeKey === r.key || (f.snapMode && f.activeKey === r.key)) ? " checked" : ""} title="Which item counts as the preset's active tab">` +
            `<span class="hub-wf-sf-name" title="${esc(r.path || "temporary tab")}">${esc(r.name)}${r.isModified && !r.isTemp ? " *" : ""}</span>${mark}` +
            `</label>`;
    }).join("");
    const target = f.mode === "update" ? (presets.find((p) => p.id === f.targetPid)?.name || "preset") : null;
    // v103: ONE dynamic toggle - any unchecked row => "Select all", otherwise
    // "Deselect all" (the owner asked for a single two-state button)
    const allChecked = f.rows.length > 0 && f.rows.every((r) => r.checked);
    // v116 (plan 6.4): the EMBED summary next to the toggle - how many tabs
    // will become independent copies. The exact bytes preflight runs at
    // commit time (the graphs serialize once, no render-time churn).
    const nSnap = f.rows.filter((r) => r.checked && (r.isTemp || f.snapMode)).length;
    const nPath = f.rows.filter((r) => r.checked && !(r.isTemp || f.snapMode)).length;
    const snapSummary = (f.snapMode || nSnap)
        ? `<span class="hub-wf-snap" title="${f.snapMode ? "The checked saved tabs are embedded as independent copies - the later file changes/deletion never affect the preset" : "Temp tabs are always embedded as independent copies"}">${nSnap} snapshot(s)` +
          (nPath ? " · " + nPath + " path reference(s)" : "") + `</span>`
        : "";
    return `<div class="hub-wf-saveform">` +
        `<div class="hub-wf-sf-title">${f.mode === "update" ? "Update '" + esc(target) + "'" : "Save current tabs as a preset"}</div>` +
        `<input type="text" class="hub-wf-sf-namein" data-wf="sfname" placeholder="Workspace ${presets.length + 1}" value="${esc(f.name || "")}" spellcheck="false">` +
        // v112 stage 4 (plan 9): the category + the tag editor (comma-separated)
        `<div class="hub-wf-sf-tools">` +
        `<input type="text" class="hub-cs-in" data-wf="sfcat" placeholder="Category (e.g. Portrait, Flux, Upscale)" value="${esc(f.category || "")}" spellcheck="false" style="flex:1 1 auto">` +
        `<input type="text" class="hub-cs-in" data-wf="sftags" placeholder="Tags, comma-separated (production, fast…)" value="${esc((f.tags || []).join(", "))}" spellcheck="false" style="flex:1 1 auto">` +
        `</div>` +
        // v112 stage 3 (plan 7.1) + v116 (plan 6.4): the SNAPSHOT toggle -
        // default OFF, the wording names the EFFECT on the preset
        `<label class="hub-wf-plankeep" title="OFF: the checked saved tabs are referenced by their file path (the preset follows the file). ON: the preset keeps its own copy - later changes or deletion of the original file won't affect it.">` +
        `<input type="checkbox" data-wf="sfnapmode"${f.snapMode ? " checked" : ""}> Embed selected saved workflows as independent copies</label>` +
        (snapSummary ? `<div class="hub-wf-sf-hint">${snapSummary}</div>` : "") +
        (f.rows.length
            ? `<div class="hub-wf-sf-tools"><button type="button" class="hub-wf-act" data-wf-btn="sftoggle" title="${allChecked ? "Uncheck every tab" : "Check every tab (temp tabs become snapshots)"}">${allChecked ? "Deselect all" : "Select all"}</button></div>`
            : "") +
        `<div class="hub-wf-sf-rows">${rows || `<div class="hub-wf-emptylist">Nothing is open</div>`}</div>` +
        `<div class="hub-wf-sf-acts">` +
        (f.hasModified ? `<button type="button" class="hub-wf-act" data-wf-btn="savemods" title="Save the modified tabs to their files first">💾 Save modified first</button>` : "") +
        (f.mode === "update"
            ? `<button type="button" class="hub-wf-act" data-wf-btn="overwrite"${f.busy ? " disabled" : ""}>${f.busy ? "Saving…" : "Overwrite"}</button>` +
              `<button type="button" class="hub-wf-act" data-wf-btn="merge" title="Merge: existing entries stay, new ones are appended (dedupe by path)"${f.busy ? " disabled" : ""}>Merge into</button>`
            : `<button type="button" class="hub-wf-act" data-wf-btn="savenew"${f.busy ? " disabled" : ""}>${f.busy ? "Saving…" : "💾 Save new"}</button>`) +
        `<button type="button" class="hub-wf-act" data-wf-btn="cancelsave"${f.busy ? " disabled" : ""}>✕ Cancel</button>` +
        `</div>` +
        `<div class="hub-wf-sf-hint">Checked rows go into the preset; temp tabs are embedded as SNAPSHOTS (unchecked by default). The radio picks the activePath.</div>` +
        `</div>`;
}

function presetsTabHtml() {
    // v112 stage 4 (plan 9): the search covers name + items + CATEGORY + TAGS;
    // the compact ⚑ filter row (category + tag selects) opens on demand
    const toks = presetsSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const list = presets.filter((p) => {
        const hay = [p.name || "", p.category || "", ...(p.tags || []),
            ...(p.items || []).map((it) => it.path || it.name || "")]
            .join(" ").toLowerCase();
        if (toks.length && !toks.every((t) => hay.includes(t))) return false;
        if (presetsCat && (p.category || "Uncategorized") !== presetsCat) return false;
        if (presetsTag && !(p.tags || []).some((t) =>
            String(t).toLowerCase() === presetsTag.toLowerCase())) return false;
        return true;
    });
    const cats = [...new Set(presets.map((p) => p.category || "Uncategorized"))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const tagSet = new Map();
    for (const p of presets) {
        for (const t of (p.tags || [])) {
            const k = String(t).toLowerCase();
            if (!tagSet.has(k)) tagSet.set(k, t);
        }
    }
    const fRow = !presetsFadvOpen ? "" :
        `<div class="hub-wf-fadv">` +
        `<select class="hub-wf-fsel" data-wf="pcat" title="Category filter">` +
        `<option value=""${!presetsCat ? " selected" : ""}>category: all</option>` +
        cats.map((c) => `<option value="${esc(c)}"${presetsCat === c ? " selected" : ""}>${esc(c)}</option>`).join("") +
        `</select>` +
        `<select class="hub-wf-fsel" data-wf="ptag" title="Tag filter">` +
        `<option value=""${!presetsTag ? " selected" : ""}>tag: all</option>` +
        [...tagSet.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, t]) =>
            `<option value="${esc(k)}"${presetsTag === k ? " selected" : ""}>#${esc(t)}</option>`).join("") +
        `</select>` +
        `<button type="button" class="hub-wf-act" data-act="pfclear" title="Clear the category/tag filters">✕</button>` +
        `</div>`;
    const fCount = (presetsCat ? 1 : 0) + (presetsTag ? 1 : 0);
    return `<div class="hub-wf-toolbar">` +
        `<input type="text" class="hub-wf-search" data-wf="presetsearch" placeholder="filter: name, category, tag…" value="${esc(presetsSearch)}" spellcheck="false">` +
        `<button type="button" class="hub-wf-act hub-wf-fchip${presetsFadvOpen ? " hub-wf-advbtn-on" : ""}" data-act="pfadv" title="Category/tag filters">⚑${fCount ? " " + fCount : ""}</button>` +
        `<button type="button" class="hub-wf-act" data-act="savepreset" title="Save the current open tabs as a new preset">＋ Save current</button>` +
        `<button type="button" class="hub-wf-act" data-act="import" title="Import presets from JSON (paste)">⤒ Import</button>` +
        `<button type="button" class="hub-wf-act" data-act="exportall" title="Export ALL presets as JSON (to the clipboard)">⤓ Export all</button>` +
        `</div>` + fRow +
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
    // v114: the version indicator needs the badge cache - ONE TTL-guarded
    // request per 30s max; the answer patches the already-rendered rows in
    // place, later re-renders read the cache directly.
    refreshHistBadges();
    // v117: the similarity groups fetch (server-side over the WHOLE index;
    // a TTL cache so re-renders never stampede). The request fires ONLY on
    // a data miss - the render loop stays single-shot.
    if (groupsState.on && idxMode() && filesView === "list" &&
        !groupsState.data && !groupsState.loading && !groupsState.error &&
        !groupsState.busy) {
        void runGroups(true);
    }
    // v107: temp tabs reopen from their SERVER snapshot (tempId ->
    // temp/<id>.json; the v106 embed is the fallback) - no file path, the
    // row is found by ts, carries a (snapshot) badge and its own tooltip.
    // v108: the 🕘 section is a list-mode citizen - the tree view is a pure
    // file browser and restores the habitual Files view when switched back.
    const rec = filesView === "list" ? recent.slice(0, recentLimit()).map((r) =>
        `<div class="hub-wf-row hub-wf-row-recent" data-path="${esc(r.path || "")}" data-rts="${esc(String(r.ts || 0))}">` +
        `<button type="button" class="hub-wf-name" data-act="reopen" data-path="${esc(r.path || "")}" data-rts="${esc(String(r.ts || 0))}" ` +
        `title="${(r.tempId || r.snap) ? "Snapshot - restores the tab as it was when closed" : esc(r.path || "")}">🕘 ${esc(r.name)}${(r.tempId || r.snap) && !r.path ? " <span class=\"hub-wf-snap\">(snapshot)</span>" : ""}</button>` +
        `<span class="hub-wf-marks"><span class="hub-wf-snap">${esc(fmtDate(Math.floor((r.ts || 0) / 1000)))}</span></span>` +
        `</div>`).join("") : "";
    // v112 stage 2: in index mode the LIST branch renders the SERVER page
    // (search + filters + sort + pagination on the backend, keyset cursor -
    // the 6000-listing cap no longer masks the library); the tree branch and
    // the counts stay on the local mirror (full paths needed).
    const list = filteredSavedFiles();
    const idxList = idxMode() && filesView === "list" ? serverList.files : null;
    const viewBtn = (v, label, title) =>
        `<button type="button" class="hub-wf-act hub-wf-viewbtn${filesView === v ? " hub-wf-viewbtn-on" : ""}" data-act="filesview" data-view="${v}" title="${title}">${label}</button>`;
    const sortBtn = (k, label, title) => {
        const on = filesSort.key === k;
        const arrow = on ? (filesSort.dir === "asc" ? " ↑" : " ↓") : "";
        return `<button type="button" class="hub-wf-act hub-wf-sortbtn${on ? " hub-wf-sortbtn-on" : ""}" data-act="filesort" data-key="${k}" ` +
            `title="${title}${on ? " - click to flip ascending/descending" : ""}">${label}${arrow}</button>`;
    };
    // v110: the filter chips wear their OWN hub-wf-fchip class - they used to
    // borrow hub-wf-chip, which in CSS is the MINIMIZED-panel chip
    // (position:fixed; display:none), so the whole ★/⚗/periods row rendered
    // invisible and the owner saw "only the sortings and the tree toggler"
    const quickChip = (q, label) =>
        `<button type="button" class="hub-wf-act hub-wf-fchip${filesQuick === q ? " hub-wf-fchip-on" : ""}" data-act="fquick" data-q="${q}" ` +
        `title="Show only the files modified ${label.toLowerCase()} (click again to clear)">${label}</button>`;
    // v108: the advanced filter row (folder / dates / size range) - collapsed
    // by default, the ⚗ chip counts the ACTIVE filters
    const adv = !filesAdvOpen ? "" :
        `<div class="hub-wf-fadv">` +
        (filesView === "list"
            ? `<select class="hub-wf-fsel" data-wf="ffolder" title="Folder filter - the nested subfolders are included">` +
              `<option value=""${!filesFolder ? " selected" : ""}>folder: all</option>` +
              filesFolderList().map((d) => {
                  const depth = d.split("/").length - 1;
                  const label = "\u00a0".repeat(depth * 2) + d.split("/").pop();
                  return `<option value="${esc(d)}"${filesFolder === d ? " selected" : ""}>${esc(label)}</option>`;
              }).join("") + `</select>`
            : `<span class="hub-wf-flabel" title="In tree mode the navigation below filters the folders">folder: tree nav</span>`) +
        `<input type="text" class="hub-wf-fdate" data-wf="fuuid" placeholder="UUID" value="${esc(filesUuid)}" title="ComfyUI workflow UUID filter (exact or prefix) - the index groups files by this id" spellcheck="false">` +
        `<input type="date" class="hub-wf-fdate" data-wf="fdatefrom" value="${esc(filesDateFrom)}" title="Modified from (inclusive)" aria-label="Modified from">` +
        `<input type="date" class="hub-wf-fdate" data-wf="fdateto" value="${esc(filesDateTo)}" title="Modified until (inclusive)" aria-label="Modified until">` +
        `<span class="hub-wf-fnum-wrap"><input type="number" class="hub-wf-fnum" data-wf="fsizemin" min="0" step="any" placeholder="min" value="${esc(fileSizeMin)}" title="Size min, KB">` +
        `<span class="hub-wf-flabel">–</span>` +
        `<input type="number" class="hub-wf-fnum" data-wf="fsizemax" min="0" step="any" placeholder="max" value="${esc(fileSizeMax)}" title="Size max, KB">` +
        `<span class="hub-wf-flabel">KB</span></span>` +
        `<button type="button" class="hub-wf-act" data-act="fclear" title="Clear every advanced filter (folder, dates, size)">✕</button>` +
        `</div>`;
    // v117: the similarity-kind filter chips (the group controls row)
    const groupKindChip = (kind, label) =>
        `<button type="button" class="hub-wf-act hub-wf-fchip${groupsState.kind === kind ? " hub-wf-fchip-on" : ""}" data-act="groupkind" data-kind="${kind}" ` +
        `title="Show ${label.toLowerCase()} only (the groups are computed once on the server - flipping the filter is free)">${label}</button>`;
    // v117 (the owner's plan section 2): the DELETE CONFIRM strip - the
    // preview data lands here BEFORE anything is deleted: what dies, which
    // versions become unreachable WITH the files (Undo restores the .json
    // file(s) only), which same-UUID copies stay untouched, which presets
    // point at the deleted files (the presets are never deleted).
    const delConfirm = (fileOpsArmed && fileOpsConfirm)
        ? filesDeleteConfirmHtml(fileOpsConfirm.data) : "";
    // v108: the rows - the flat list or the folder tree. Both share the
    // savedFileRowHtml rows (checkbox, name, path sub-line, ★) and the
    // fileRowsShown cap.
    let rows, more = "";
    if (filesView === "tree") {
        // v112 (plan 3.7): the one-pass tree index over the FILTERED list -
        // the map AND the deep counts in one walk (the per-folder-row
        // filter() is gone). The map now comes from the filtered list, so a
        // dead branch (no matching files under the active filters) is simply
        // absent from the map - the v110 pruning contract holds, without the
        // extra aliveDirs walk.
        const idx = buildTreeIndex(list);
        const map = idx.map;
        const deepCount = (dir) => dir ? (idx.counts.get(dir) || 0) : list.length;
        const out = [];
        let shown = 0, capHit = false;
        const renderDir = (dir, depth) => {
            if (capHit) return;
            const kids = [...(map.get(dir) || [])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
            for (const k of kids) {
                const full = dir ? dir + "/" + k : k;
                const open = treeExpanded.has(full);
                out.push(folderRowHtml(full, k, depth, open, deepCount(full)));
                if (open) renderDir(full, depth + 1);
            }
            for (const f of list.filter((x) => fileFolderOf(x.path) === dir)) {
                if (shown >= fileRowsShown) { capHit = true; break; }
                shown++;
                out.push(savedFileRowHtml(f, depth));
            }
        };
        renderDir(filesTreeFolder, 0);
        rows = out.join("");
        if (capHit) more = `<button type="button" class="hub-wf-more" data-act="morefiles">Show more</button>`;
    } else {
        if (idxList && groupsState.on) {
            // v117: the GROUPED view (the owner's plan section 4) - the
            // groups are built SERVER-side over the whole index; the rows
            // are the ordinary Files rows with every action they carry in
            // the flat list. Collapsible headers name the kind, the file
            // count and (for Similar) the min/avg score.
            const gd = groupsState.data;
            if (groupsState.loading && !gd) {
                rows = `<div class="hub-wf-emptylist">Building the groups over the indexed library…</div>`;
            } else if (groupsState.busy && !gd) {
                // v118: the scan holds the SQLite db - a SOFT state with an
                // automatic retry; never the dead 'unavailable' note
                rows = `<div class="hub-wf-emptylist">⏳ Indexing in progress - the groups will appear as soon as the scan finishes</div>`;
            } else if (groupsState.error && !gd) {
                rows = `<div class="hub-wf-planwarn">⚠ The groups are unavailable: ${esc(groupsState.error)}</div>`;
            } else if (gd) {
                // v119: after a similarity-profile bump (nprof2 -> nprof3)
                // every index row is old-profile until the next scan
                // re-indexes it - a calm note instead of an empty grid
                // (the boot scan runs automatically, the note self-heals)
                if (gd.staleProfile && !(gd.groups || []).length &&
                    !(gd.ungroupedTotal || 0)) {
                    rows = `<div class="hub-wf-emptylist">⏳ The similarity profile was updated (v119 searches modified copies too) - the groups appear as soon as the index scan re-indexes the library (it runs automatically on the panel open, or press Refresh)</div>`;
                } else {
                    const out = [];
                    const kindIcon = { same_uuid: "⧉", exact: "⧉", similar: "≈" };
                    // v120 the ACCOUNTING: the kind filter hides the other
                    // stages' groups while their members still leave the
                    // ungrouped tail - without this note the owner's sums
                    // "did not add up" (844 files in hidden Same-UUID/
                    // Exact groups looked lost). kindCounts comes from the
                    // server answer and covers every indexed file.
                    const kindCounts = gd.kindCounts || {};
                    const kindLabel = { same_uuid: "Same workflow ID",
                                        exact: "Exact copies",
                                        similar: "Similar" };
                    let hiddenCount = 0;
                    const hiddenLabels = [];
                    for (const k of Object.keys(kindCounts)) {
                        if (groupsState.kind !== "all" &&
                            k !== groupsState.kind && kindCounts[k] > 0) {
                            hiddenCount += kindCounts[k];
                            hiddenLabels.push(kindLabel[k] || k);
                        }
                    }
                    if (hiddenCount > 0)
                        out.push(`<div class="hub-wf-emptylist">ℹ ${hiddenCount} file(s) live in ${esc(hiddenLabels.join(" / "))} groups - hidden by this filter (All groups shows them)</div>`);
                    for (const g of (gd.groups || [])) {
                        const collapsed = !!groupsState.collapsed[g.key];
                        const scoreTxt = g.kind === "similar" &&
                            Number.isFinite(g.minScore)
                            ? ` · ${g.minScore}%${Number.isFinite(g.avgScore) ? "–" + g.avgScore + "%" : ""}` : "";
                        out.push(`<div class="hub-wf-sect hub-wf-sect-row">` +
                            `<button type="button" class="hub-wf-act" data-act="groupfold" data-key="${esc(g.key)}" ` +
                            `title="${collapsed ? "Expand the group" : "Collapse the group"}">${collapsed ? "▸" : "▾"} ${kindIcon[g.kind] || ""} ${esc(g.label)} · ${g.count} file(s)${scoreTxt}</button>` +
                            `<span class="hub-wf-snap" title="A visual grouping only - nothing is merged, moved or deleted automatically">${g.kind === "same_uuid" ? "one workflow id" : g.kind === "exact" ? "100%" : "estimate ≥ " + groupsState.threshold + "%"}</span></div>`);
                        if (!collapsed) {
                            for (const f of (g.files || []))
                                out.push(savedFileRowHtml(f, 1));
                        }
                    }
                    out.push(`<div class="hub-wf-sect">Outside the groups (${gd.ungroupedTotal || 0}${(gd.totalFiles || 0) > (gd.ungroupedTotal || 0) ? " of " + gd.totalFiles + " indexed" : ""})</div>`);
                    for (const f of (gd.ungrouped || []))
                        out.push(savedFileRowHtml(f, 0));
                    if ((gd.ungroupedTotal || 0) > (gd.ungrouped || []).length)
                        out.push(`<div class="hub-wf-emptylist">… and ${gd.ungroupedTotal - (gd.ungrouped || []).length} more ungrouped files (the grouped view caps its answer - use the flat list to page through everything)</div>`);
                    rows = out.join("");
                    more = groupsState.loading
                        ? `<div class="hub-wf-emptylist">Recomputing…</div>` : "";
                }
            }
        } else if (idxList) {
            // the SERVER page (index mode): the rows are already filtered/
            // sorted/paginated backend-side - render as-is
            rows = idxList.map((f) => savedFileRowHtml(f, 0)).join("");
            more = serverList.hasMore
                ? `<button type="button" class="hub-wf-more" data-act="morefiles">Show more (${serverList.total - idxList.length} hidden of ${serverList.total})</button>`
                : (serverList.loading ? `<div class="hub-wf-emptylist">Loading the library…</div>` : "");
            if (!rows && serverList.loading) {
                rows = "";
                more = `<div class="hub-wf-emptylist">Reading the indexed library…</div>`;
            }
        } else {
            rows = list.slice(0, fileRowsShown).map((f) => savedFileRowHtml(f, 0)).join("");
            more = list.length > fileRowsShown
                ? `<button type="button" class="hub-wf-more" data-act="morefiles">Show more (${list.length - fileRowsShown} hidden)</button>` : "";
        }
    }
    const crumbs = filesView === "tree" ? crumbsHtml() : "";
    // v116 (plan 3.2): the Refresh button names what it does in index mode
    const refreshBtn = `<button type="button" class="hub-wf-act" data-act="filesrefresh" ` +
        `title="${idxMode() && filesView === "list" ? "Rescan the library (incremental) + reload the query" : "Re-read the workflow files from the server"}${filesLastScan ? " (last scan " + esc(fmtDateTime(Math.floor(filesLastScan / 1000))) + ")" : ""}">⟳ Refresh</button>`;
    // v112 (plan 3.4): EXPLICIT list states - loading / loaded empty / error /
    // partial (truncated). An error NEVER blanks the last good list and the
    // "Reading…" placeholder cannot outlive a failed request (the note names
    // the problem and offers the next action - Refresh).
    let stateNote = "";
    if (idxMode() && filesView === "list" && serverList.error) {
        stateNote = `<div class="hub-wf-planwarn" title="${esc(serverList.error)}">⚠ The index query failed: ${esc(serverList.error)} - the local mirror still works.</div>`;
    } else if (idxMode() && filesView === "list" && idxScanBusy) {
        stateNote = `<div class="hub-wf-planwarn" title="The server walks the library in a background thread">⏳ Indexing the library… the search results refresh when it lands.</div>`;
    } else if (idxMode() && filesView === "list" && idxStats && idxStats.truncated) {
        // v116 (plan 4.7): a truncated/incomplete index never poses as full
        stateNote = `<div class="hub-wf-planwarn" title="The last scan hit the walk bound - unverified rows were NOT pruned; rebuild to make the index complete">⚠ The index is incomplete (the last scan hit the walk bound) - <button type="button" class="hub-wf-act" data-act="idxrebuild">⟲ Rebuild</button></div>`;
    } else if (filesLoadError) {
        stateNote = `<div class="hub-wf-planwarn" title="${esc(filesLoadError.why)}">⚠ Files refresh failed: ${esc(filesLoadError.why)} - the last list is kept. ${""}` +
            `<button type="button" class="hub-wf-act" data-act="filesrefresh">⟳ Retry</button></div>`;
    } else if (filesTruncated && savedFilesLoaded) {
        stateNote = `<div class="hub-wf-planwarn" title="The backend caps one listing - the SQLite index stage removes the cap">⚠ The library is larger than one listing - showing the first ${savedFiles.length} files (truncated).</div>`;
    }
    // v116 (plan 7.6): the Undo lives OUTSIDE the selection toolbar - right
    // after a delete the selection is empty, and the undo must still be one
    // click away for its whole 2 h window
    if (fileOpsUndo?.opId) {
        stateNote += `<div class="hub-wf-planwarn">↩ The last delete can be undone (2 h) ` +
            `<button type="button" class="hub-wf-act" data-act="fileundo" title="Restore the deleted files from their verified safety copies">↩ Undo delete</button></div>`;
    }
    const emptyMsg = !savedFilesLoaded
        ? (filesLoadPending ? "Reading the workflow files…" : "No saved workflow files found")
        : (filesView === "tree" && filesTreeFolder
            ? "This folder is empty (or the filters hide everything)"
            : (idxMode() && filesView === "list"
                ? (serverList.error ? "The index query failed: " + serverList.error
                    : (savedFiles.length || serverList.total ? "Nothing matches the filters" : "No saved workflow files found"))
                : (savedFiles.length ? "Nothing matches the filters" : "No saved workflow files found")));
    return `<div class="hub-wf-toolbar">` +
        // v102: the search + actions are PINNED above the scroll container -
        // the field stays visible while the file list scrolls
        `<input type="text" class="hub-wf-search" data-wf="filesearch" placeholder="${idxMode() && filesView === "list" ? "search: name, path, UUID, node, model, content…" : "filter: name or nested folder…"}" value="${esc(filesSearch)}" spellcheck="false">` +
        `<button type="button" class="hub-wf-act" data-act="openselected" title="Open every checked file">▶ Open selected</button>` +
        `<button type="button" class="hub-wf-act" data-act="saveselection" title="Save the checked files as a preset WITHOUT opening them">💾 Save selected as preset</button>` +
        refreshBtn +
        (idxMode() ? `<button type="button" class="hub-wf-act" data-act="idxrebuild" title="Rebuild the SQLite library index from scratch (a background server scan)">⟲ ${idxScanBusy ? "Indexing…" : "Rebuild index"}</button>` : "") +
        `</div>` +
        // v116 (plan 7.2): the compact SELECTION toolbar - hidden at 0
        // selected, appears at 1+. The owner's cut: DELETE only (no move/
        // copy). The operations apply to the selected FILES, never
        // automatically to every file of the same UUID.
        (fileSel.size
            ? `<div class="hub-wf-tools2">` +
              `<span class="hub-wf-flabel" title="The operations apply to the selected FILES">${fileSel.size} selected${filesSelOutsideCount() ? " (" + filesSelOutsideCount() + " outside the visible rows)" : ""}</span>` +
              `<button type="button" class="hub-wf-act${fileOpsArmed ? " hub-wf-armed" : ""}" data-act="filedel" ` +
              `title="${fileOpsArmed ? "Click AGAIN to delete the selected files (a verified safety copy of each is kept for 2 h - Undo stays available)" : "Delete the selected files (the process history is NEVER deleted; a verified safety copy of each file is taken first)"}">` +
              `${fileOpsArmed ? "⚠ Click AGAIN to delete " + fileSel.size : "🗑 Delete selected"}</button>` +
              (fileOpsUndo ? `<button type="button" class="hub-wf-act" data-act="fileundo" title="Restore the last deleted batch from its verified safety copies (2 h window)">↩ Undo delete</button>` : "") +
              `<button type="button" class="hub-wf-act" data-act="fileclear" title="Clear the selection">✕ Clear</button>` +
              `</div>`
            : "") +
        // v108: the file-manager row - sort (date/name/size, asc/desc on the
        // active one), the list/tree view toggle, the ★-only chip, the ⚗
        // advanced filters and the quick periods
        `<div class="hub-wf-tools2">` +
        sortBtn("mtime", "date", "Sort by last modified") +
        sortBtn("name", "name", "Sort by file name") +
        sortBtn("size", "size", "Sort by file size") +
        viewBtn("list", "≡", "Flat list (the default Files view)") +
        viewBtn("tree", "🌲", "Folder tree - expand/collapse any depth, enter folders, breadcrumbs") +
        `<button type="button" class="hub-wf-act hub-wf-fchip${filesFavOnly ? " hub-wf-fchip-on" : ""}" data-act="favonly" title="Show only the favorites (★)">★${filesFav.size ? " " + filesFav.size : ""}</button>` +
        `<button type="button" class="hub-wf-act hub-wf-fchip${filesAdvOpen ? " hub-wf-advbtn-on" : ""}" data-act="fadv" title="Advanced filters: folder, modified date range, file size range">⚗${filesActiveFilterCount() ? " " + filesActiveFilterCount() : ""}</button>` +
        // v117 (the owner's plan section 4): the similarity grouping toggle -
        // default OFF, the flat list stays exactly as it is today
        `<button type="button" class="hub-wf-act hub-wf-fchip${groupsState.on ? " hub-wf-fchip-on" : ""}" data-act="grouptoggle" ` +
        `title="Group similar workflows: files with the same UUID, exact graph copies and structurally similar workflows render as collapsible groups (built SERVER-side over the whole index - nothing is merged, moved or deleted)">◫ Group</button>` +
        quickChip("today", "Today") +
        quickChip("7d", "7d") +
        quickChip("30d", "30d") +
        `</div>` +
        // v117: the group controls row (threshold + the kind filter) - only
        // while the grouping is on; the estimate disclaimer lives on the
        // chips' tooltips, the percentage is an estimate, never a proof
        (groupsState.on && idxMode()
            ? `<div class="hub-wf-fadv">` +
              `<select class="hub-wf-fsel" data-wf="groupthresh" title="The similarity threshold: 50-100%. 95-100% = very similar, 80-94% = similar, 50-79% = loose (a heavily modified copy joins when it still resembles the group). v119 searches the MODIFIED copies too (a node group added/removed, reroutes, another seed - all still group); v120 scores additions/removals softer and joins copies of copies through a group member. The % is a structural/content ESTIMATE, not an identity guarantee">` +
              GROUP_THRESHOLD_CHOICES.map((t) =>
                  `<option value="${t}"${groupsState.threshold === t ? " selected" : ""}>≥ ${t}%</option>`).join("") +
              `</select>` +
              groupKindChip("all", "All groups") +
              groupKindChip("same_uuid", "Same UUID") +
              groupKindChip("exact", "Exact copies") +
              groupKindChip("similar", "Similar") +
              `<button type="button" class="hub-wf-act" data-act="grouprefetch" title="Recompute the groups from the current index">⟳</button>` +
              `</div>`
            : "") +
        adv + stateNote + delConfirm +
        `<div class="hub-wf-scroll">` +
        (filesView === "list"
            ? `<div class="hub-wf-sect hub-wf-sect-row">🕘 Recently closed${recentServer === false ? " <span class=\"hub-wf-snap\" title=\"An old py without the recent routes - the ring lives in this browser only\">(local only)</span>" : ""}` +
              `<button type="button" class="hub-wf-act hub-wf-fchip${recentClearArmed ? " hub-wf-armed" : ""}" data-act="recentclear" ` +
              `title="${recentClearArmed ? "Click AGAIN to clear THIS browser's Recently closed list (the workflow files, Presets, Favorites and Process history stay untouched)" : "Clear this browser's Recently closed list - other browser sessions keep their own lists; the workflow files, Presets, Favorites and Process history are never touched"}">${recentClearArmed ? "⚠ Click AGAIN to clear" : "✕ Clear"}</button></div>` +
              `<div class="hub-wf-list hub-wf-list-recent">${rec || `<div class="hub-wf-emptylist">Nothing closed yet</div>`}</div>` +
              `<div class="hub-wf-sect">All saved workflows</div>`
            : `<div class="hub-wf-sect">${filesTreeFolder ? "📁 " + esc(filesTreeFolder) : "📁 Folder tree"}</div>` + crumbs) +
        `<div class="hub-wf-list">${rows || `<div class="hub-wf-emptylist">${emptyMsg}</div>`}${more}</div>` +
        `</div>` +
        `<div class="hub-wf-status">${idxMode() && filesView === "list"
            ? (serverList.loading && !serverList.files.length ? "reading the index…"
                : serverList.files.length + " shown of " + serverList.total + " indexed")
            : (savedFilesLoaded ? (filesView === "tree"
                ? list.length + " match(es)"
                : list.length + " of " + savedFiles.length + " file(s)") : (filesLoadPending ? "reading…" : "no files loaded"))}` +
        `${idxMode() && idxStats ? " · idx " + (idxStats.files || 0) + (idxStats.errors ? " (" + idxStats.errors + " bad json)" : "") : ""}` +
        `${filesTruncated ? " · ⚠ truncated" : ""}` +
        ` · ★ ${filesFav.size} · ${fileSel.size} selected` +
        `${filesLastScan ? " · scanned " + esc(fmtDateTime(Math.floor(filesLastScan / 1000))) : ""}` +
        `${filesView === "tree" && filesTreeFolder ? " · in " + esc(filesTreeFolder) : ""}</div>`;
}

/** v108: the tree-mode breadcrumbs (workflows › sub › …) - every crumb is a
 *  jump back up; the root crumb leaves the navigation. */
function crumbsHtml() {
    const parts = filesTreeFolder ? filesTreeFolder.split("/") : [];
    const crumbs = [`<button type="button" class="hub-wf-crumb" data-act="treecrumb" data-folder="" title="Back to the workflows root">🗂 workflows</button>`];
    let acc = "";
    for (const p of parts) {
        acc = acc ? acc + "/" + p : p;
        crumbs.push(`<span class="hub-wf-crumbs-sep">›</span>` +
            `<button type="button" class="hub-wf-crumb${acc === filesTreeFolder ? " hub-wf-crumb-on" : ""}" data-act="treecrumb" data-folder="${esc(acc)}" title="Back to ${esc(acc)}">${esc(p)}</button>`);
    }
    return `<div class="hub-wf-crumbs">${crumbs.join("")}</div>`;
}

/** v116 (plan 7.2): how many selected paths are OUTSIDE the currently
 *  visible rows (the selection survives pagination + filters; hiding that
 *  fact would make a mass delete lie about its scope). */
function filesSelOutsideCount() {
    const visible = new Set(filesListRows().map((f) => normWfPath(f.path)));
    let n = 0;
    for (const p of fileSel) if (!visible.has(p)) n++;
    return n;
}

/** v117 (the owner's plan section 2): the confirm-strip HTML built from the
 *  server preview - every number comes from the server data, never a guess.
 *  The strip says: what is deleted, whose versions become unreachable (and
 *  die WITH the files - the Undo restores the .json file(s) ONLY), which
 *  same-UUID copies stay untouched (their history remains reachable through
 *  them) and which presets reference the files (the presets are NEVER
 *  deleted with them). */
function filesDeleteConfirmHtml(pv) {
    if (!pv || typeof pv !== "object") return "";
    const t = pv.totals || {};
    const files = pv.files || [];
    const orphanFiles = files.filter((f) => f.willOrphanVersions);
    const sharedFiles = files.filter((f) => (f.otherLocations || []).length > 0);
    const presets = pv.presetsAffected || [];
    const lines = [];
    lines.push(`⚠ Delete <b>${Number(t.selected) || fileSel.size} selected file(s)</b> from the disk.`);
    if (orphanFiles.length) {
        const names = orphanFiles.slice(0, 3)
            .map((f) => esc(baseName(f.path))).join(", ");
        lines.push(`<span class="hub-wf-missing">◷</span> For <b>${orphanFiles.length}</b> file(s) ` +
            `(<b>${Number(t.orphanVersions) || 0}</b> saved version(s)) no live copy stays on disk - ` +
            `the versions become unreachable and are deleted <b>with the files</b>. ` +
            `↩ Undo restores the <b>.json file(s) only - never the deleted versions</b>.` +
            (orphanFiles.length > 3 ? ` (${names}, …)` : ` (${names})`));
    }
    if (sharedFiles.length) {
        lines.push(`⧉ <b>${sharedFiles.length}</b> file(s) share their workflow UUID with other files ` +
            `that are <b>NOT selected</b> - those copies stay byte-for-byte on disk ` +
            `and the shared history remains reachable through them.`);
    }
    if (presets.length) {
        const names = presets.slice(0, 4).map((p) => esc(p.name || p.id)).join(", ");
        lines.push(`<span class="hub-wf-snap">💾</span> Preset(s) reference the deleted files: <b>${names}</b>` +
            (presets.length > 4 ? ` +${presets.length - 4} more` : "") +
            `. The presets themselves are <b>NOT deleted</b> (they keep the item; it will show the missing mark).`);
    }
    if (!orphanFiles.length && !sharedFiles.length && !presets.length) {
        lines.push(`No saved versions and no preset references are affected.`);
    }
    return `<div class="hub-wf-planwarn">${lines.join("<br>")}` +
        `<div class="hub-wf-planacts hub-wf-planacts-end" style="margin-top:4px">` +
        `<button type="button" class="hub-wf-act hub-wf-armed" data-act="filedel" ` +
        `title="Click AGAIN to delete the selected files (a verified safety copy of each is kept for 2 h; the unreachable versions described above are erased for good)">` +
        `${fileOpsBusy ? "…" : "⚠ Click AGAIN to delete " + fileSel.size}</button>` +
        `<button type="button" class="hub-wf-act" data-act="filedelcancel" title="Do not delete anything">✕ Cancel</button>` +
        `</div></div>`;
}

/** v116 (plan 7.6): the FILES batch delete - the owner's cut (delete only,
 *  no move/copy). v117 (the owner's plan section 2): the first click runs
 *  the SERVER preview (which versions become unreachable and die with the
 *  files, which same-UUID copies stay, which presets reference the paths)
 *  and renders the confirm strip; the armed second click performs the
 *  deletion. Only the SELECTED files are ever touched on disk; a process
 *  that lost its last live file has its unreachable versions erased by the
 *  server (the strip said so); the History stays reachable through every
 *  surviving copy. The selection/list/index/favorites refresh after. */
async function filesDeleteSelected() {
    if (fileOpsBusy) return;
    const paths = [...fileSel];
    if (!paths.length) { localToast("Nothing selected"); return; }
    const pathKey = paths.join("|");
    // STEP 1 - the preview confirm (the plan: the dialog BEFORE deletion)
    if (!fileOpsArmed || !fileOpsConfirm || fileOpsConfirm.paths !== pathKey) {
        fileOpsBusy = true;
        renderAll();
        try {
            const res = await jfetch("/settings_hub/workflows/files/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths, preview: true }),
            });
            if (res.json?.ok) {
                fileOpsConfirm = { data: res.json, paths: pathKey };
                fileOpsArmed = true;
            } else {
                fileOpsArmed = false;
                fileOpsConfirm = null;
                localToast("The delete preview failed: " +
                    ((res.json && res.json.error) || "HTTP " + res.status), 5000);
            }
        } catch (e) {
            fileOpsArmed = false;
            fileOpsConfirm = null;
            localToast("The delete preview failed: " +
                String((e && e.message) || e), 4200);
        }
        fileOpsBusy = false;
        renderAll();
        return;
    }
    // STEP 2 - confirmed: the real deletion (only the checked files)
    fileOpsBusy = true;
    fileOpsArmed = false;
    fileOpsConfirm = null;
    renderAll();
    let res = null;
    try {
        res = await jfetch("/settings_hub/workflows/files/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths }),
        });
    } catch (e) {
        fileOpsBusy = false;
        fileOpsArmed = false;
        renderAll();
        localToast("Delete failed: " + String((e && e.message) || e), 4200);
        return;
    }
    fileOpsBusy = false;
    const j = res.json || {};
    if (res.status === 409 || res.status === 400) {
        // the preflight/validate refusal - NOTHING was deleted
        const bad = (j.results || []).filter((r) => r.error)
            .map((r) => r.path + ": " + r.error).slice(0, 3).join(" · ");
        localToast("Deleted nothing (safety): " + (j.error || "") +
            (bad ? " · " + bad : ""), 6000);
        renderAll();
        return;
    }
    const removed = Number(j.removed) || 0;
    const failed = Number(j.failed) || 0;
    const orphanP = Number(j.orphanedProcesses) || 0;
    const orphanR = Number(j.orphanedRevisions) || 0;
    if (removed) {
        fileSel = new Set([...fileSel].filter((p) =>
            !(j.results || []).some((r) => r.removed && sameWfPath(r.path, p))));
        if (j.undo && j.undo.opId) fileOpsUndo = j.undo;
        else fileOpsUndo = null;
    }
    renderAll();
    localToast("Deleted " + removed + " file(s)" +
        (failed ? " · " + failed + " FAILED" : "") +
        (orphanP ? " · " + orphanP + " unreachable version set(s) (" + orphanR +
            " version(s)) deleted with them" : "") +
        (removed && j.undo ? " · ↩ Undo restores the file(s) (2 h)" : ""), 6000);
    await refreshSavedFiles();
    if (idxMode()) {
        await runServerList(true, true);
        void runGroups(true);   // the groups must reflect the deletion
    }
    refreshHistBadges(true);
    if (uiTab === "files") renderAll();
}

/** v116 (plan 7.6): the Undo of the LAST Files delete - the exact bytes
 *  come back from the verified snapshots (free paths only; a path taken
 *  by a newer file is skipped, never overwritten). */
async function filesUndoDelete() {
    if (!fileOpsUndo?.opId || fileOpsBusy) return;
    fileOpsBusy = true;
    renderAll();
    let res = null;
    try {
        res = await jfetch("/settings_hub/workflows/files/undo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opId: fileOpsUndo.opId }),
        });
    } catch (e) {
        fileOpsBusy = false;
        renderAll();
        localToast("Undo failed: " + String((e && e.message) || e), 4200);
        return;
    }
    fileOpsBusy = false;
    const j = res.json || {};
    fileOpsUndo = null;   // the manifest dies after use (either way)
    renderAll();
    if (j.ok || Number(j.restored) > 0) {
        localToast("Restored " + (Number(j.restored) || 0) + " file(s)" +
            ((j.results || []).some((r) => r.error) ? " · some paths were skipped (taken by newer files)" : ""),
            5000);
        await refreshSavedFiles();
        if (idxMode()) await runServerList(true, true);
        refreshHistBadges(true);
    } else {
        localToast("Undo failed: " + (j.error || ("HTTP " + (res.status || "?"))), 4200);
    }
    if (uiTab === "files") renderAll();
}

/** v116 (plan 7.2): 'Select all files with this UUID' - the ⧉ chip action
 *  (the copy toast offers it). Selects every file LOCATION of the process
 *  across pages: a server query by workflow_id in index mode, the local
 *  mirror filter otherwise. The user is shown the count and warned that
 *  the operations act on files, not on the whole process automatically. */
async function selectUuidFiles(uuid) {
    if (!uuid) return;
    let paths = [];
    if (idxMode()) {
        try {
            const res = await jfetch("/settings_hub/workflows/index/search?workflow_id=" +
                encodeURIComponent(uuid) + "&limit=1000&sort=mtime&direction=desc");
            if (res.json?.ok && Array.isArray(res.json.files)) {
                paths = res.json.files.map((f) => normWfPath(f.path));
            }
        } catch (_) {}
    }
    if (!paths.length) {
        paths = savedFiles.filter((f) => f.workflowId === uuid)
            .map((f) => normWfPath(f.path));
    }
    if (!paths.length) {
        localToast("No indexed files carry this UUID");
        return;
    }
    for (const p of paths) fileSel.add(p);
    renderAll();
    localToast("Selected " + paths.length + " file(s) with UUID " + uuid +
        " (they share ONE process history - the file operations still act per file)", 5000);
}

function savedFileRowHtml(f, depth = 0) {
    const norm = normWfPath(f.path);
    const rel = relWfPath(norm);
    const openNow = openHasPath(f.path);
    const fav = filesFav.has(norm);
    const ind = depth ? ` style="padding-left:${depth * 10 + 5}px"` : "";
    // v112 stage 2: the UUID chip (copy on click) + the parse-status mark -
    // a broken JSON stays LISTABLE with a ⚠ and a readable tooltip (plan 4.4)
    const uuid = f.workflowId ? String(f.workflowId) : null;
    const shortUuid = uuid ? (uuid.length > 8 ? uuid.slice(0, 8) + "…" : uuid) : null;
    // v115: the duplicate-ID counter - several files sharing one UUID are
    // locations of ONE process, the chip shows HOW MANY rows that ID covers
    const dups = histBadgeDups(f.path);
    const uuidChip = shortUuid
        ? `<button type="button" class="hub-wf-act hub-wf-fchip" data-act="copyuuid" data-uuid="${esc(uuid)}" ` +
          `title="ComfyUI workflow UUID: ${esc(uuid)} - click to copy; the files with the same UUID form ONE process${dups > 1 ? " · " + dups + " files share this UUID" : ""}">⧉ ${esc(shortUuid)}${dups > 1 ? `<span class="hub-wf-dupbadge">×${dups}</span>` : ""}</button>`
        : "";
    const badMark = f.parseStatus === "error"
        ? `<span class="hub-wf-missing" title="This JSON failed to parse: ${esc(f.parseError || "")}">⚠</span>`
        : (f.parseStatus === "too_large_to_index"
            ? `<span class="hub-wf-snap" title="The file is too large for the index analysis - it still opens normally">…MB</span>` : "");
    const meta = [f.mtime ? fmtDateTime(f.mtime) : "", fmtSize(f.size)].filter(Boolean).join(" · ");
    // v114: the version indicator - the 🕘 button wears a small count chip
    // when the file's process has saved versions (the badge cache is fed by
    // ONE /history/badges request for the whole tab)
    const hrev = histBadgeCount(f.path);
    const hrevChip = hrev > 0
        ? `<span class="hub-wf-hbadge">${hrev > 99 ? "99+" : String(hrev)}</span>` : "";
    const hrevTitle = histBadgeTitle(f.path);
    return `<div class="hub-wf-row${openNow ? " hub-wf-row-active" : ""}" data-fpath="${esc(f.path)}"${ind}>` +
        `<input type="checkbox" class="hub-wf-fcheck" data-fcheck="${esc(f.path)}"${fileSel.has(norm) ? " checked" : ""} title="Select for Open selected / Save selected as preset">` +
        `<span class="hub-wf-filecol">` +
        `<button type="button" class="hub-wf-name" data-act="openfile" data-path="${esc(f.path)}" title="${esc(rel)}${uuid ? " · UUID " + uuid : ""}">${esc(f.name)}${openNow ? " ●" : ""}${badMark}</button>` +
        `<span class="hub-wf-filesub" title="${esc(rel)}">${esc(shortPath(rel))}${meta ? " · " + esc(meta) : ""}</span>` +
        `</span>` +
        uuidChip +
        (idxReady === false ? "" : `<button type="button" class="hub-wf-cbtn" data-act="fileinspect" data-path="${esc(f.path)}" ` +
        `title="Inspect: the identity, the nodes, the models, the parameters, the dependencies of this workflow">🔍</button>`) +
        (idxReady === false ? "" : `<button type="button" class="hub-wf-cbtn" data-act="filehist" data-path="${esc(f.path)}" ` +
        `title="Process history: the Checkpoints, Compare, Restore of this workflow${uuid ? " (UUID " + uuid + ")" : ""}${hrevTitle}">${hrevChip}🕘</button>`) +
        `<button type="button" class="hub-wf-favbtn${fav ? " hub-wf-favbtn-on" : ""}" data-act="filefav" data-path="${esc(f.path)}" ` +
        `title="${fav ? "Remove from favorites" : "Add to favorites (★)"}">${fav ? "★" : "☆"}</button>` +
        `</div>`;
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
        // v112 stage 2: in index mode the Show more fetches the NEXT server
        // page (keyset cursor); the local chunk cap stays for the tree + the
        // old-py fallback
        case "morefiles":
            if (idxMode() && filesView === "list") { void runServerList(false); }
            else { fileRowsShown += SHOW_MORE_STEP; renderAll(); }
            return;
        // v116 (plan 3.2): Refresh = incremental scan + status + query +
        // local mirror (the v112 button skipped the SQLite index entirely)
        case "filesrefresh": void refreshFilesFull(); return;
        // v112 stage 2 (plan 4.4): the manual full re-index
        case "idxrebuild": void rebuildIndex(); return;
        // ---- v108 Files tab: the file-manager controls --------------------
        case "filesort": {
            const k = btn.dataset.key;
            if (filesSort.key === k) filesSort.dir = filesSort.dir === "asc" ? "desc" : "asc";
            else filesSort = { key: k, dir: k === "name" ? "asc" : "desc" };
            saveUi({ filesSort });
            if (idxMode() && filesView === "list") scheduleServerList(0);
            renderAll();
            return;
        }
        case "filesview": {
            const v = btn.dataset.view === "tree" ? "tree" : "list";
            if (filesView !== v) {
                filesView = v;
                saveUi({ filesView });
                fileRowsShown = ROW_LIST_CAP;
                renderAll(); // v108: back to ≡ restores the habitual Files view
            }
            return;
        }
        case "favonly": {
            filesFavOnly = !filesFavOnly;
            fileRowsShown = ROW_LIST_CAP;
            if (idxMode() && filesView === "list") scheduleServerList(0);
            renderAll();
            return;
        }
        case "fadv": { filesAdvOpen = !filesAdvOpen; renderAll(); return; }
        case "fclear": {
            filesFolder = "";
            filesDateFrom = "";
            filesDateTo = "";
            fileSizeMin = "";
            fileSizeMax = "";
            filesUuid = "";
            fileRowsShown = ROW_LIST_CAP;
            if (idxMode() && filesView === "list") scheduleServerList(0);
            renderAll();
            return;
        }
        case "fquick": {
            const q = btn.dataset.q || "";
            filesQuick = filesQuick === q ? "" : q; // click again clears
            filesDateFrom = "";
            filesDateTo = "";
            fileRowsShown = ROW_LIST_CAP;
            if (idxMode() && filesView === "list") scheduleServerList(0);
            renderAll();
            return;
        }
        case "filefav": {
            if (btn.dataset.path) void toggleFileFav(btn.dataset.path);
            return;
        }
        // v112 stage 5 (plan 11): the workflow inspector
        case "fileinspect": {
            if (btn.dataset.path) void openInspPop(btn.dataset.path, btn);
            return;
        }
        // v112 stage 3 (plan 6): the per-tab Save / Save As
        case "savetab": {
            const t = byKey(btn.dataset.key);
            if (t) void saveTabRow(t);
            return;
        }
        // v112 stage 2.5: the process-history panel of one file
        case "filehist": {
            if (btn.dataset.path) void openHistPop(btn.dataset.path, btn);
            return;
        }
        // v112 stage 2 (plan 4.7): copy the ComfyUI UUID of a workflow file
        case "copyuuid": {
            if (btn.dataset.uuid) {
                const ok = await copyText(String(btn.dataset.uuid));
                const n = histBadgeDups(btn.dataset.path ||
                    btn.closest("[data-fpath]")?.dataset.fpath || "");
                if (ok && n > 1) {
                    // v116 (plan 7.2): the UUID context action - the toast
                    // offers 'Select all files with this UUID'
                    actionToast("UUID copied - " + n + " files share it",
                        "Select all " + n,
                        () => void selectUuidFiles(String(btn.dataset.uuid)));
                } else {
                    localToast(ok ? "UUID copied: " + btn.dataset.uuid
                        : "Could not copy - see F12");
                }
            }
            return;
        }
        // v116 (plan 7.6): the Files batch delete + undo + clear selection.
        // v117: the arming lives INSIDE filesDeleteSelected - the first click
        // fetches the preview and renders the confirm strip, the second
        // click (armed) deletes.
        case "filedel": {
            if (!fileSel.size) return;
            void filesDeleteSelected();
            return;
        }
        case "filedelcancel": {
            fileOpsArmed = false;
            fileOpsConfirm = null;
            renderAll();
            return;
        }
        case "fileundo": void filesUndoDelete(); return;
        case "fileclear": {
            fileSel.clear();
            fileOpsArmed = false;
            fileOpsConfirm = null;
            renderAll();
            return;
        }
        // v117 (the owner's plan section 3): the armed Clear of the
        // Recently closed list (this browser session only)
        case "recentclear": {
            if (recentClearArmed) {
                clearTimeout(recentClearArmed);
                recentClearArmed = null;
                recentClearAll();
                return;
            }
            recentClearArmed = setTimeout(() => {
                recentClearArmed = null;
                if (uiTab === "files") renderAll();
            }, ARM_MS);
            renderAll();
            return;
        }
        // v117 (the owner's plan section 4): the similarity groups controls
        case "grouptoggle": {
            groupsState.on = !groupsState.on;
            saveGroupsPrefs();
            groupsState.data = null;
            groupsState.error = null;
            groupsState.busy = false;          // v118: a fresh state per toggle
            clearTimeout(groupsRetryT);
            groupsRetryT = null;
            // the plan: with the grouping on the FILES tab leaves the tree
            // for the grouped list
            if (groupsState.on && filesView === "tree") filesView = "list";
            if (groupsState.on) void runGroups(true);
            renderAll();
            return;
        }
        case "groupkind": {
            const k = btn.dataset.kind || "all";
            groupsState.kind = (k === "same_uuid" || k === "exact" ||
                k === "similar") ? k : "all";
            saveGroupsPrefs();
            // the kind filter is a server param - refetch (the SQLite cache
            // makes it free)
            void runGroups(true);
            return;
        }
        case "groupfold": {
            const key = btn.dataset.key || "";
            if (groupsState.collapsed[key]) delete groupsState.collapsed[key];
            else groupsState.collapsed[key] = true;
            renderAll();
            return;
        }
        case "grouprefetch": {
            void runGroups(true);
            return;
        }
        case "treefold": {
            const d = btn.dataset.folder || "";
            if (treeExpanded.has(d)) treeExpanded.delete(d);
            else treeExpanded.add(d);
            renderAll();
            return;
        }
        case "treeenter":
        case "treecrumb": {
            filesTreeFolder = btn.dataset.folder || "";
            fileRowsShown = ROW_LIST_CAP;
            renderAll();
            return;
        }
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
        // v112 stage 4: the preset category/tag filter row
        case "pfadv": { presetsFadvOpen = !presetsFadvOpen; renderAll(); return; }
        case "pfclear": { presetsCat = ""; presetsTag = ""; renderAll(); return; }
        // v112 stage 4 (plan 10): the preset version history
        case "pver": {
            const p = presets.find((x) => x.id === btn.dataset.pid);
            if (p) void openPverPop(p.id, btn);
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
            // v107: a temp entry reopens from its SERVER snapshot
            // (temp/<id>.json in the storage root) - never a /userdata fetch
            // (that was the 404 on "Unsaved Workflow (N)"). The v106
            // localStorage embed is the fallback (an old py / a lost file),
            // then a real path entry keeps the by-path reopen.
            const entry = recent.find((r) => String(r.ts || 0) === btn.dataset.rts)
                || recent.find((r) => r.path && r.path === btn.dataset.path);
            let graph = entry?.tempId ? await fetchTempSnapshot(entry.tempId) : null;
            if (!graph && entry?.snap) graph = entry.snap; // v106 fallback
            if (graph) {
                const r = await openSnapshotWorkflow(entry.name, graph);
                if (!r.ok) localToast("Could not restore the snapshot - see F12");
            } else if (btn.dataset.path) {
                const r = await openWorkflowByPath(btn.dataset.path);
                if (!r.ok) localToast(r.missing ? "The file no longer exists" : "Could not open - see F12");
            } else if (entry?.tempId) {
                localToast("The temp snapshot is gone from the server storage");
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
    if (el.matches('[data-wf="sfnapmode"]')) {
        // v112 stage 3 (plan 7.1): flip the whole form's embedding mode
        if (saveForm) saveForm.snapMode = !!el.checked;
        renderAll();
        return;
    }
    if (el.matches("[data-wf-radio]")) {
        const i = parseInt(el.dataset.wfRadio, 10);
        if (saveForm && saveForm.rows[i]) saveForm.activeKey = saveForm.rows[i].key;
        return;
    }
    if (el.matches("[data-hcmp]")) {
        // the Compare selection: two radios (A then B)
        if (histState) {
            if (!histState.cmpA || histState.cmpA === el.dataset.hcmp) {
                histState.cmpA = el.dataset.hcmp;
                histState.cmpB = null;
            } else if (!histState.cmpB) {
                histState.cmpB = el.dataset.hcmp;
            } else {
                histState.cmpA = histState.cmpB;
                histState.cmpB = el.dataset.hcmp;
            }
            renderHistPop();
        }
        return;
    }
    if (el.matches("[data-fcheck]")) {
        const norm = normWfPath(el.dataset.fcheck);
        if (el.checked) fileSel.add(norm);
        else fileSel.delete(norm);
        renderAll(); // refresh the "N selected" status line
        return;
    }
    // ---- v108 Files tab: the advanced filter inputs ------------------------
    if (el.matches('[data-wf="groupthresh"]')) {
        // v120: the similarity threshold (50-100) - a server param,
        // the answer refetches immediately (the SQLite cache keeps it cheap)
        const t = parseInt(el.value, 10);
        if (GROUP_THRESHOLD_CHOICES.includes(t)) {
            groupsState.threshold = t;
            saveGroupsPrefs();
            void runGroups(true);
        }
        return;
    }
    if (el.matches('[data-wf="ffolder"]')) {
        filesFolder = el.value || "";
        fileRowsShown = ROW_LIST_CAP;
        renderAll();
        return;
    }
    if (el.matches('[data-wf="fdatefrom"]')) {
        filesDateFrom = el.value || "";
        filesQuick = ""; // the explicit date wins over the quick chip
        fileRowsShown = ROW_LIST_CAP;
        if (idxMode() && filesView === "list") scheduleServerList(0);
        renderAll();
        return;
    }
    if (el.matches('[data-wf="fdateto"]')) {
        filesDateTo = el.value || "";
        fileRowsShown = ROW_LIST_CAP;
        if (idxMode() && filesView === "list") scheduleServerList(0);
        renderAll();
        return;
    }
    if (el.matches('[data-wf="fsizemin"]')) {
        fileSizeMin = el.value === "" ? "" : el.value;
        fileRowsShown = ROW_LIST_CAP;
        if (idxMode() && filesView === "list") scheduleServerList(0);
        renderAll();
        return;
    }
    if (el.matches('[data-wf="fsizemax"]')) {
        fileSizeMax = el.value === "" ? "" : el.value;
        fileRowsShown = ROW_LIST_CAP;
        if (idxMode() && filesView === "list") scheduleServerList(0);
        renderAll();
        return;
    }
}

function onBodyInput(e) {
    const el = e.target;
    if (!el) return;
    if (el.matches('[data-wf="presetsearch"]')) {
        presetsSearch = el.value || "";
        // live filter without rebuilding the input itself (keeps the caret);
        // v112 stage 4: the SAME extended hay as presetsTabHtml (category +
        // tags) - the two code paths must never diverge
        const list = panel?.querySelector(".hub-wf-list");
        if (list) {
            const toks = presetsSearch.toLowerCase().split(/\s+/).filter(Boolean);
            const filtered = presets.filter((p) => {
                const hay = [p.name || "", p.category || "", ...(p.tags || []),
                    ...(p.items || []).map((it) => it.path || it.name || "")]
                    .join(" ").toLowerCase();
                if (toks.length && !toks.every((t) => hay.includes(t))) return false;
                if (presetsCat && (p.category || "Uncategorized") !== presetsCat) return false;
                if (presetsTag && !(p.tags || []).some((t) =>
                    String(t).toLowerCase() === presetsTag.toLowerCase())) return false;
                return true;
            });
            list.innerHTML = filtered.map(presetCardHtml).join("") ||
                `<div class="hub-wf-emptylist">${presets.length ? "Nothing matches the filter" : "No presets yet"}</div>`;
        }
        return;
    }
    if (el.matches('[data-wf="filesearch"]')) {
        filesSearch = el.value || "";
        fileRowsShown = ROW_LIST_CAP;
        if (idxMode() && filesView === "list") {
            // v112 stage 2: the SERVER search (debounced ~250ms per plan 4.7).
            // v113: NO renderAll() per keystroke here - the focus/caret are
            // preserved by renderAll itself now, but the v112 double rebuild
            // (keystroke + the loading state + the answer) made typing in a
            // 2000-file library feel like fighting the panel. The list
            // region re-renders when the server answer lands.
            scheduleServerList(250);
            return;
        }
        renderAll();
        return;
    }
    if (el.matches('[data-wf="histnote"]')) {
        if (histState) histState.noteDraft = el.value || "";
        return;
    }
    if (el.matches('[data-wf="fuuid"]')) {
        // v112 stage 2 (plan 4.7): the UUID filter (exact/partial)
        filesUuid = el.value || "";
        if (idxMode() && filesView === "list") {
            scheduleServerList(250);   // v113: no per-keystroke rebuild (see above)
            return;
        }
        renderAll();
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
    // v112 stage 4 (plan 9): the category/tags editors
    if (el.matches('[data-wf="sfcat"]')) {
        if (saveForm) saveForm.category = el.value || "";
        return;
    }
    if (el.matches('[data-wf="sftags"]')) {
        if (saveForm) saveForm.tags = (el.value || "").split(",").map((s) => s.trim()).filter(Boolean);
        return;
    }
    // v112 stage 4: the preset category/tag filters
    if (el.matches('[data-wf="pcat"]')) {
        presetsCat = el.value || "";
        renderAll();
        return;
    }
    if (el.matches('[data-wf="ptag"]')) {
        presetsTag = el.value || "";
        renderAll();
        return;
    }
}

// v113: the text controls the panel owns. Keys typed into them must never
// reach ComfyUI's global keybinds (a bare letter / Ctrl-combo in a search
// box queued generations and triggered shortcuts - the search was unusable).
const WF_TEXT_FIELDS = [
    '[data-wf="presetsearch"]', '[data-wf="filesearch"]', '[data-wf="opensearch"]',
    '[data-wf="fuuid"]', '[data-wf="sfname"]', '[data-wf="sfcat"]', '[data-wf="sftags"]',
    '[data-wf="histnote"]', '[data-wf="root"]', '[data-wf="fdatefrom"]',
    '[data-wf="fdateto"]', '[data-wf="fsizemin"]', '[data-wf="fsizemax"]',
].join(", ");
function isWfTextField(el) {
    return !!(el && el.matches?.(WF_TEXT_FIELDS));
}

function onBodyKeydown(e) {
    const el = e.target;
    if (!el) return;
    if (el.matches('[data-wf="presetsearch"], [data-wf="filesearch"], [data-wf="opensearch"], [data-wf="fuuid"]') && e.key === "Escape") {
        // (the category/tags filter clears via the ✕ chip, Esc keeps the text)
        e.preventDefault();
        e.stopPropagation();
        el.value = "";
        if (el.matches('[data-wf="presetsearch"]')) presetsSearch = "";
        else if (el.matches('[data-wf="opensearch"]')) openSearch = "";
        else if (el.matches('[data-wf="fuuid"]')) { filesUuid = ""; if (idxMode() && filesView === "list") scheduleServerList(0); }
        else {
            // v113: clearing the Files search ALSO re-queries the server -
            // the v112 Esc left the stale filtered rows visible
            filesSearch = "";
            if (idxMode() && filesView === "list") scheduleServerList(0);
        }
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
    // v113: the containment itself - every other key stays inside the panel
    // (Escape/Enter handled above are stopped too; this catches the rest)
    if (isWfTextField(el)) e.stopPropagation();
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
    const target = mode === "update" ? presets.find((p) => p.id === targetPid) : null;
    saveForm = {
        mode,
        targetPid,
        // v112 stage 4 (plan 9): the category/tags flow with the form
        category: target?.category || "",
        tags: Array.isArray(target?.tags) ? target.tags.slice() : [],
        snapMode: false,   // v112 stage 3 (plan 7.1): default OFF - persisted
                           // tabs stay path items unless the toggle flips
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

/** v118: the DISK-truth rung of the embed save. A saved tab whose graph was
 *  never LOADED into the frontend store (a background tab at boot: no
 *  activeState, no content, no ref.graph) serializes from its own FILE -
 *  for an unmodified tab the disk copy IS the tab's content, byte for byte
 *  the correct independent snapshot. */
async function fetchDiskWorkflowJson(path) {
    const n = normWfPath(path);
    if (!n) return null;
    const withPrefix = n.startsWith("workflows/") ? n : ("workflows/" + n);
    try {
        const res = await jfetch("/userdata/" + encodeURIComponent(withPrefix));
        const j = res.json;
        if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch (_) {}
    return null;
}

async function collectFormItems() {
    if (!saveForm) return { error: "no form" };
    const items = [];
    let activePath = null;
    let activeItem = null;   // v116 (plan 6.3): matched by CONTENT after save
    let snapBytes = 0;       // v116 (plan 6.3): the preflight size budget
    const snapSizes = [];    // {name, bytes} for the too-large error
    for (const r of saveForm.rows) {
        if (!r.checked) continue;
        const snap = r.isTemp || saveForm.snapMode;
        if (snap) {
            // v118: a saved tab the store never LOADED (a background tab at
            // boot) has no serializable graph - the old code refused the
            // WHOLE save here ('Could not serialize ...'), and with the
            // toast CSS missing the owner saw NOTHING happen. Healing
            // ladder, cheapest first: the store's own loader (mirrors
            // openStoreWorkflow's precondition) -> the disk file. A
            // MODIFIED tab skips both - disk content would silently lose
            // the edits, so it keeps the honest named error.
            let g = graphJsonOfOpenTab(r.tab);
            if (!g && r.path && !r.isModified) {
                const wf = r.tab && r.tab.ref;
                if (wf && !wf.isLoaded && !storeWorkflowHasContent(wf) &&
                    typeof wf.load === "function") {
                    try { await wf.load(); } catch (_) {}
                    g = graphJsonOfOpenTab(r.tab);
                }
                if (!g) g = await fetchDiskWorkflowJson(r.path);
            }
            if (!g) {
                // plan 6.3: an unserializable tab keeps the form open and
                // NAMES the tab - never a silent fallback to a stale copy
                return { error: "Could not serialize the tab '" + r.name +
                    (r.isModified
                        ? "' (unsaved changes and no loaded state) - activate it, save it, then retry"
                        : "' - save it manually first, then retry") };
            }
            // v112 stage 3 (plan 7.2): the snapshot ORIGIN metadata - the
            // snapshot stays an independent copy, the metadata only explains
            // where it came from
            const it = { kind: "snapshot", name: r.name, graph: g };
            if (r.path) {
                it.sourcePath = r.path;
                it.sourceName = r.name;
            }
            if (g && typeof g.id === "string" && g.id) it.workflowId = g.id;
            it.capturedAt = Math.floor(Date.now() / 1000);
            it.snapHash = _graph_canon_hash_local(g);
            let bytes = 0;
            try { bytes = JSON.stringify(g).length; } catch (_) { bytes = 0; }
            snapBytes += bytes;
            snapSizes.push({ name: r.name, bytes });
            const idx = items.push(it) - 1;
            if (saveForm.activeKey === r.key) activeItem = it;
        } else {
            items.push({ kind: "path", path: r.path });
            if (saveForm.activeKey === r.key && !activePath) activePath = r.path;
        }
    }
    return { items, activePath,
        activeItemName: activeItem ? activeItem.name : null,
        activeSnapHash: activeItem ? activeItem.snapHash : null,
        snapBytes, snapSizes };
}

/** v116 (plan 6.3): the client-side canonical content hash of a snapshot
 *  graph - the SAME rule as the server's snapHash (sorted keys, compact).
 *  The active item binds by (snapHash + name) after the save instead of by
 *  the display name alone - two same-named snapshots can never collide. */
function _graph_canon_hash_local(graph) {
    try {
        const s = JSON.stringify(graph, Object.keys(graph).sort());
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return "h" + (h >>> 0).toString(16);
    } catch (_) { return null; }
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
    if (saveForm.busy) return;   // v116 (plan 6.3): no double submit
    // v118: read the typed name BEFORE any re-render - the busy render
    // rebuilds the input from saveForm.name and would silently LOSE the
    // name the owner typed (the WX smoke caught it)
    const nameIn = panel?.querySelector('[data-wf="sfname"]');
    const name = ((nameIn?.value ?? saveForm.name) || "").trim() || nextWorkspaceName();
    // v118: busy BEFORE the collect - collectFormItems now awaits the
    // healing rungs (ref.load / the disk fetch); a second click during
    // those awaits must never double-submit
    saveForm.busy = true;
    renderAll();   // the Save button goes '…' + disabled
    try {
        const c = await collectFormItems();
        if (c.error) { localToast(c.error, 4200); return; }   // the form stays open
        if (!c.items || !c.items.length) { localToast("Nothing checked - check at least one tab"); return; }
        // v116 (plan 6.3): the SIZE preflight BEFORE the request - the
        // exact serialized bytes of every snapshot item vs the server cap;
        // the error names the heaviest tabs so the user can uncheck them
        const SRV_MAX = 10 * 1024 * 1024;
        if (c.snapBytes > SRV_MAX) {
            const top = [...(c.snapSizes || [])].sort((a, b) => b.bytes - a.bytes)
                .slice(0, 3)
                .map((s) => s.name + " (" + (s.bytes / 1048576).toFixed(1) + " MB)")
                .join(", ");
            localToast("Too large to save: " + (c.snapBytes / 1048576).toFixed(1) +
                " MB of snapshots (the server takes 10 MB). The heaviest: " + top +
                ". Uncheck or save them separately.", 8000);
            return;
        }
        const res = await savePreset({
            id: targetPid || undefined,
            name, items: c.items,
            activePath: c.activePath || undefined,
            category: saveForm.category || undefined,
            tags: saveForm.tags?.length ? saveForm.tags : undefined,
            mode: mode || "create",
        });
        if (res.ok) {
            // v116 (plan 6.3): the ACTIVE snapshot binds by its CONTENT hash
            // (+ name) against the SAVED items - two same-named snapshots
            // can never steal the activeItemId from each other
            const saved = res.preset;
            if (c.activeSnapHash && Array.isArray(saved?.items)) {
                const hit = saved.items.find((it) => it.kind === "snapshot" &&
                    (it.name === c.activeItemName) &&
                    (it.snapHash === c.activeSnapHash || !c.activeSnapHash)) ||
                    saved.items.find((it) => it.kind === "snapshot" &&
                        it.name === c.activeItemName);
                if (hit?.itemId) {
                    await patchPreset(saved.id, { activeItemId: hit.itemId });
                }
            }
            saveForm = null;
            await refreshPresets();
            renderAll();
            const nSnaps = c.items.filter((it) => it.kind === "snapshot").length;
            localToast((mode === "merge" ? "Merged into '" : (mode === "overwrite" ? "Overwrote '" : "Saved preset '")) +
                name + "' (" + c.items.length + " item(s)" +
                (nSnaps ? ", " + nSnaps + " snapshot(s)" : "") + ")");
        } else {
            // plan 6.3 + v118: 400/413/500 are NAMED, the form stays open,
            // the buttons unlock (no silent 'nothing happened'). A transport
            // 413 (a body cap BELOW the pack's own 10 MB budget) names itself
            // instead of a bare 'HTTP 413'.
            localToast((res.stale
                ? "The server has no workflows routes (old py) - update the FULL pack and RESTART ComfyUI."
                : res.status === 413
                    ? "Too large for the server (413) - uncheck the heaviest tabs, or update the FULL pack and RESTART ComfyUI (v118 raises the transport cap)."
                    : "Could not save the preset: " + (res.error || ("HTTP " + (res.status || "?")))), 5200);
        }
    } catch (e) {
        // a throw here used to vanish as an unhandled rejection - the owner
        // saw "nothing happens". Name the problem instead.
        localToast("Could not save the preset: " + String((e && e.message) || e), 4200);
    } finally {
        // v118: the unlock lives in finally - EVERY path (an early error
        // return, a server refusal, a throw) re-enables the buttons
        if (saveForm) saveForm.busy = false;
        renderAll();
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
        (plan.toOpenSnaps.length ? `<label class="hub-wf-plankeep"><input type="checkbox" data-wf="planskipsnaps"> Skip exact copies of already-open tabs${plan.dupCount ? " (" + plan.dupCount + " exact copy)" : ""}</label>` : "") +
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
            const skipSnaps = !!pop.querySelector('[data-wf="planskipsnaps"]')?.checked;
            setPref({ keepUnsaved: keep });
            const fresh = buildApplyPlan(preset, { keepUnsaved: keep, skipDupSnaps: skipSnaps });
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
    containPopTextKeys(pop);   // v113: the prompt field keeps its keys
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
    containPopTextKeys(pop);   // v113: the pasted-JSON textarea keeps its keys
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
        // v117 (the owner's plan section 3): the Recently-closed limit -
        // applied IMMEDIATELY (the ring trims, the evicted snapshots free
        // through the manifest sync honoring other browsers' refs)
        `<label class="hub-cs-row"><span>Recently closed items</span>` +
        `<select class="hub-cs-sel" data-wf="recentlimit" title="How many entries the Files tab keeps in the Recently closed list (this browser session). Shrinking trims the list at once; the freed reopen snapshots are deleted only when no other browser session still points at them">` +
        RECENT_CHOICES.map((n) => `<option value="${n}"${recentLimit() === n ? " selected" : ""}>${n}</option>`).join("") +
        `</select></label>` +
        `<div class="hub-cs-sect">Storage folder</div>` +
        `<div class="hub-cs-row"><span class="hub-cs-box">` +
        `<input type="text" class="hub-cs-in hub-cs-path" data-wf="root" ` +
        `placeholder="default: user/settings_hub/workflows" spellcheck="false" autocomplete="off">` +
        `<button type="button" class="hub-cs-chip" data-wf-btn="rootdef">default</button></span></div>` +
        `<div class="hub-cs-info" data-wf="rootinfo"></div>` +
        // v117 (the owner's plan section 1): ONE short sentence instead of
        // the wall of text - it must fit the small popup without pushing the
        // controls out of view; the technical details moved into a CLOSED by
        // default <details> block
        `<div class="hub-cs-hint">Choose where Workflow Manager stores presets and temporary reopen snapshots. ` +
        `Changing this folder does not move or delete existing data.</div>` +
        `<details class="hub-wf-advdetails" data-wf="rootadv">` +
        `<summary class="hub-wf-sect" style="cursor:pointer" title="The technical details of the storage mechanics">Advanced details</summary>` +
        `<div class="hub-cs-hint">` +
        `Roots: the DEFAULT root is user/settings_hub/workflows; a CUSTOM root replaces it as the ACTIVE one. ` +
        `While a custom root is active the default one stays READABLE (an id present in both roots resolves to the ACTIVE copy; writes go where the data already lives) - ` +
        `no duplicates, no loss, and switching NEVER moves or deletes anything.<br>` +
        `Layout: one file per preset - presets/&lt;id&gt;.json; the reopen snapshots of closed temp tabs live in temp/&lt;id&gt;.json of the SAME root.<br>` +
        `Service files: the root choice itself (workflows_root.json) and the Files-tab favorites (workflows_favorites.json) live in the DEFAULT user dir - a root switch cannot hide them.<br>` +
        `The presets/ and temp/ housekeeping NEVER mixes into the Files list.<br>` +
        `🗑 on a preset card deletes it (click twice). Hidden panel: the mini panel (🗂) or ComfyUI Settings → SettingsHub → 'Mini panel'.` +
        `</div></details>` +
        // v116 (plan 5.4/10.4): the STORAGE DASHBOARD - the measured physical
        // bytes of every manager component next to the logical payload sum;
        // Analyze refreshes, Compact runs the verified history rebuild (an
        // explicit, never automatic action)
        `<div class="hub-cs-sect">Storage</div>` +
        `<div class="hub-cs-info" data-wf="storeinfo">Reading the storage stats…</div>` +
        `<div class="hub-cs-row" style="gap:6px">` +
        `<button type="button" class="hub-cs-chip" data-wf-btn="storeanalyze">Analyze</button>` +
        `<button type="button" class="hub-cs-chip" data-wf-btn="storecompact" title="Rebuild the version store from the retained versions only (a verified preflight + an atomic switch; never automatic)">🧹 Compact history</button></div>`;
    document.body.appendChild(pop);
    wfPop = pop;
    containPopTextKeys(pop);   // v113: the storage-folder input keeps its keys

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
    // v117: the Recently-closed limit - applied IMMEDIATELY (the ring trims,
    // the evicted tempIds free through the manifest sync)
    const rcSel = pop.querySelector('[data-wf="recentlimit"]');
    rcSel.value = String(recentLimit());
    rcSel.addEventListener("change", () => {
        rcSel.value = String(setRecentLimit(parseInt(rcSel.value, 10)));
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

    // v116 (plan 5.4/10.4): the storage dashboard - the real measured bytes
    const storeInfo = pop.querySelector('[data-wf="storeinfo"]');
    const fmtMb = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB"
        : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B";
    const storeAnalyze = async () => {
        if (!storeInfo.isConnected) return;
        storeInfo.textContent = "Reading the storage stats…";
        try {
            const res = await jfetch("/settings_hub/workflows/history/storage");
            if (!res.json?.ok || !storeInfo.isConnected) return;
            const s = res.json;
            storeInfo.innerHTML =
                `Versions store: <b>${fmtMb(Number(s.physicalBytes) || 0)}</b> physical` +
                ` · ${fmtMb(Number(s.logicalBytes) || 0)} logical (${s.revisions || 0} version(s), ${s.processes || 0} process(es))<br>` +
                `Metadata: ${fmtMb(Number(s.historyMetadataBytes) || 0)} · Preset archives: ${s.presetVersionManifests || 0} (${fmtMb(Number(s.presetVersionManifestBytes) || 0)})<br>` +
                `Safety snapshots: ${s.txSnapshotFiles || 0} (${fmtMb(Number(s.txSnapshotBytes) || 0)}) · Index: ${fmtMb(Number(s.indexBytes) || 0)} · Service: ${fmtMb(Number(s.serviceUndoBytes || 0) + Number(s.serviceRecentBytes || 0))}<br>` +
                `<b>Total physical: ${fmtMb(Number(s.totalPhysicalBytes) || 0)}</b>`;
        } catch (_) {
            storeInfo.textContent = "The storage stats are unavailable (an old py).";
        }
    };
    pop.querySelector('[data-wf-btn="storeanalyze"]').addEventListener("click", () => void storeAnalyze());
    pop.querySelector('[data-wf-btn="storecompact"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.textContent = "🧹 Compacting…";
            btn.disabled = true;
            try {
                const res = await jfetch("/settings_hub/workflows/history/maintenance", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "compact" }),
                });
                const s = res.json || {};
                if (s.ok) {
                    storeInfo.innerHTML = `Compact done: ${fmtMb(Number(s.before) || 0)} → <b>${fmtMb(Number(s.after) || 0)}</b>` +
                        ` (${s.verified || 0} version(s) verified byte-by-byte)`;
                } else {
                    storeInfo.textContent = "Compact refused: " + (s.error || "error") +
                        (s.preflight ? " · " + s.preflight.revisions + " version(s), " + fmtMb(Number(s.preflight.currentStoreBytes) || 0) : "");
                }
            } catch (_) {
                storeInfo.textContent = "Compact failed - see F12.";
            }
            btn.textContent = "🧹 Compact history";
            btn.disabled = false;
        } else {
            btn.dataset.armed = "1";
            btn.textContent = "⚠ Click AGAIN to rebuild the store";
            setTimeout(() => {
                if (btn.dataset.armed) {
                    delete btn.dataset.armed;
                    btn.textContent = "🧹 Compact history";
                }
            }, 4000);
        }
    });
    void storeAnalyze();
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

/** v116 (plan 3.2): the Files REFRESH is the REAL refresh in index mode:
 *  ONE incremental scan (force:false) -> the fresh index status -> the
 *  current server query -> the local mirror. The v112 button only re-read
 *  the legacy local listing while the panel displayed the SQLite rows, so
 *  fresh files/changes never appeared without a full Rebuild. A scan that
 *  is already running is JOINED (the server serializes; the client does
 *  not fire a competing trigger). Errors keep the last good list (the
 *  state note + Retry carry the reason). */
async function refreshFilesFull() {
    if (idxMode() && filesView === "list") {
        if (!idxScanBusy) {
            idxScanBusy = true;
            renderAll();   // the calm 'Indexing…' note - the rows stay
            try {
                await jfetch("/settings_hub/workflows/index/scan", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ force: false }),
                });
            } catch (_) { /* the status probe below still refreshes */ }
            const st = await jfetch("/settings_hub/workflows/index/status");
            if (st.json?.ok) idxStats = st.json;
            idxScanBusy = false;
        }
        await runServerList(true, true);   // silent - the rows never flash
    }
    await refreshSavedFiles();             // the local mirror + the tree view
    if (uiTab === "files") renderAll();
}

async function refreshSavedFiles() {
    // v112 (plan 3.4): ONE request sequence - a newer refresh invalidates an
    // older in-flight one; the completed answer lands in the DOM only when
    // it is still the newest and the tab is one of the data tabs.
    const seq = ++filesLoadSeq;
    if (!savedFilesLoaded) {
        filesLoadPending = true;
        renderAll(); // show the explicit "Reading…" state once
    }
    let list = [];
    let ok = false;
    try {
        list = await getSavedWorkflows();
        ok = true;
    } catch (e) {
        list = null;
    }
    if (seq !== filesLoadSeq) return; // superseded
    filesLoadPending = false;
    if (!ok || list === null) {
        filesLoadError = { why: "the request failed - see F12" };
    } else if (!list.length && savedFiles.length && savedFilesLoaded) {
        // v112 (plan 3.10): a TRANSIENT empty answer must not blank the last
        // good list. TWO consecutive empty answers are accepted as real (the
        // user may genuinely have emptied the folder).
        filesEmptyStrikes++;
        if (filesEmptyStrikes < 2) {
            filesLoadError = { why: "the refresh returned no files - the previous list is kept (transient server hiccup)" };
        } else {
            savedFiles = list;
            savedFilesLoaded = true;
            _savedPathIdx = null;
            filesLoadError = null;
            filesLastScan = Date.now();
        }
    } else {
        filesEmptyStrikes = 0;
        savedFiles = list;
        savedFilesLoaded = true;
        _savedPathIdx = null; // plan 3.8: the missing-paths index invalidates
        filesLoadError = null;
        filesTruncated = !!lastFilesTruncated;
        filesLastScan = Date.now();
    }
    if (!filesFavsLoaded) {
        // v108: the ★ marks load once per session; a stale answer must not
        // sit in the DOM when the Files tab is the visible one
        await fetchFileFavs();
        if (seq !== filesLoadSeq) return;
    }
    fileSel = new Set([...fileSel].filter((p) => savedFiles.some((f) => sameWfPath(f.path, p))));
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
        // v112 (plan 3.6): adopt the server-side recent manifest (or migrate
        // the localStorage ring up) right after the first healthy probe
        await loadRecentFromServer();
        // v112 stage 2: the library index probe + the boot scan (server-side
        // worker thread; the panel stays responsive either way)
        void ensureIndexStatus();
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
    clearTimeout(groupsRetryT);   // v118: the groups busy-retry timer dies with the panel
    groupsRetryT = null;
    closeDupPop();
    closeHistPop();
    closePverPop();
    closeInspPop();
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
// v112 stage 2.5 (plan 5.x): the PROCESS HISTORY panel - a linear list of
// Checkpoints with Compare / Restore / Mark stable. The user sees Process,
// History, Checkpoint, Restore - NEVER storage terminology. It opens from a
// file row (🕘) and stays OUT of the main screen (progressive disclosure).
// ---------------------------------------------------------------------------

let histPop = null;
let histState = null;      // {path, pid, proc, revs, loading, error, sel, cpBusy, armedRestore, compare}

function closeHistPop() {
    try { histPop?.remove(); } catch (_) {}
    histPop = null;
    histState = null;
    try { window.removeEventListener("mousedown", onHistDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onHistKey, true); } catch (_) {}
}
function onHistDown(e) {
    if (!histPop || histPop.contains(e.target)) return;
    closeHistPop();
}
function onHistKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeHistPop(); }
}

function histRevLabel(r) {
    const d = r.createdAt ? fmtDateTime(r.createdAt) : "";
    const src = r.source === "disk" ? "Disk file" : (r.source || "Checkpoint");
    const title = r.title || r.note || "";
    return { d, src, title };
}

// v113: shared placement for the big popovers (Process history, Workflow
// inspector, Preset history). The v112 code hardcoded left/top = 16px - the
// pop appeared in the far corner of the SCREEN, potentially on the other
// side of the monitor from the Workflows panel. The pop now opens NEXT TO
// the invoking row button (outside its left edge, right edge as the
// fallback, viewport-clamped; a centered fallback when no anchor exists -
// the jsdom tests drive the openers directly).
function popAnchorRect(btn) {
    try {
        const r = btn?.getBoundingClientRect?.();
        if (r && (r.width || r.height)) {
            return { left: r.left, top: r.top, right: r.right,
                bottom: r.bottom, width: r.width, height: r.height };
        }
    } catch (_) {}
    return null;
}

function placeHubPop(pop, anchor, opts = {}) {
    const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
    const maxW = Math.max(240, Math.min(opts.maxW || 520, vw - 20));
    const maxH = Math.max(240, Math.min(opts.maxH || (vh - 24), vh - 20));
    try {
        pop.style.maxWidth = maxW + "px";
        pop.style.maxHeight = maxH + "px";
    } catch (_) {}
    const pw = pop.offsetWidth || Math.min(maxW, 420);
    const ph = pop.offsetHeight || 320;
    const pad = 10;
    let x = null, y = null;
    if (anchor && (anchor.width || anchor.height)) {
        x = anchor.left - pw - 8;               // outside the row's LEFT edge
        if (x < pad) x = anchor.right + 8;      // no room - the right edge
        y = anchor.top - 6;
    }
    if (x === null || !Number.isFinite(x)) x = (vw - pw) / 2;
    if (y === null || !Number.isFinite(y)) y = (vh - ph) / 2;
    x = Math.round(Math.min(Math.max(pad, x), Math.max(pad, vw - pw - pad)));
    y = Math.round(Math.min(Math.max(pad, y), Math.max(pad, vh - ph - pad)));
    try { pop.style.left = x + "px"; pop.style.top = y + "px"; } catch (_) {}
}

// v113: the popovers live on document.body (outside the panel's delegated
// listeners) - any text input inside them needs its OWN key containment,
// or ComfyUI's global keybinds fire while the user types the checkpoint
// note ("What changed?").
function isTextEntryEl(el) {
    const t = el?.tagName;
    if (t === "TEXTAREA") return true;
    if (t === "INPUT") {
        const NON_TEXT = new Set(["checkbox", "radio", "button", "submit",
            "range", "file", "color", "image", "reset"]);
        return !NON_TEXT.has((el.type || "text").toLowerCase());
    }
    return false;
}
function containPopTextKeys(pop) {
    pop.addEventListener("keydown", (e) => {
        if (isTextEntryEl(e.target)) e.stopPropagation();
    });
    pop.addEventListener("keyup", (e) => {
        if (isTextEntryEl(e.target)) e.stopPropagation();
    });
}

// ---------------------------------------------------------------------------
// v114 (owner request): the VERSION INDICATOR on the Files rows - "когда у
// процесса есть версии должно быть видно". One small request feeds the WHOLE
// tab (GET /history/badges -> {rel_path: {count, stable}}; processes without
// revisions contribute nothing), the answer lands in a module cache and the
// already-rendered rows are patched IN PLACE (no re-render churn). Rows
// rendered later read the same cache at render time. The 30s TTL keeps
// typing/filtering free of extra traffic; an old py without the route is
// silent (the rows stay unbadged, nothing else breaks).
// ---------------------------------------------------------------------------

let histBadges = { map: null, ts: 0, inflight: null };
const HIST_BADGE_TTL_MS = 30000;

function histBadgeCount(path) {
    const m = histBadges.map;
    if (!m) return 0;
    const b = m[normWfPath(path)];
    return b && b.count > 0 ? b.count : 0;
}

function histBadgeTitle(path) {
    const m = histBadges.map;
    const b = m ? m[normWfPath(path)] : null;
    if (!b || !(b.count > 0)) return "";
    return " · " + b.count + " saved version(s)" +
        (b.stable > 0 ? " (" + b.stable + " stable)" : "");
}

/** v115: the duplicate-ID counter - the badges answer carries 'locations'
 *  ONLY for processes whose UUID covers MORE THAN ONE file (a normal
 *  one-file process adds nothing); the chip renders when the count > 1. */
function histBadgeDups(path) {
    const m = histBadges.map;
    if (!m) return 0;
    const b = m[normWfPath(path)];
    return b && b.locations > 1 ? b.locations : 0;
}

function applyHistBadges() {
    try {
        document.querySelectorAll('[data-act="filehist"][data-path]').forEach((btn) => {
            const n = histBadgeCount(btn.dataset.path);
            const ex = btn.querySelector(".hub-wf-hbadge");
            if (n > 0) {
                if (ex) ex.textContent = String(n);
                else {
                    const s = document.createElement("span");
                    s.className = "hub-wf-hbadge";
                    s.textContent = String(n);
                    btn.appendChild(s);
                }
            } else if (ex) ex.remove();
            // the tooltip carries the count too (stripped first - a re-render
            // already baked the current suffix in)
            const base = (btn.title || "").replace(/ · \d+ saved version.*$/, "");
            btn.title = base + histBadgeTitle(btn.dataset.path);
        });
        // v115: the duplicate-ID counter rides the SAME in-place patch pass -
        // the ⧉ UUID chip wears "×N" when several files share that UUID
        document.querySelectorAll('[data-act="copyuuid"][data-uuid]').forEach((chip) => {
            const row = chip.closest("[data-fpath]");
            const n = row ? histBadgeDups(row.dataset.fpath) : 0;
            const ex = chip.querySelector(".hub-wf-dupbadge");
            if (n > 1) {
                if (ex) ex.textContent = "×" + n;
                else {
                    const s = document.createElement("span");
                    s.className = "hub-wf-dupbadge";
                    s.textContent = "×" + n;
                    chip.appendChild(s);
                }
            } else if (ex) ex.remove();
            const cbase = (chip.title || "")
                .replace(/ · \d+ files? share this UUID$/, "");
            chip.title = cbase + (n > 1 ? " · " + n + " files share this UUID" : "");
        });
    } catch (_) {}
}

function refreshHistBadges(force) {
    const fresh = histBadges.map !== null && Date.now() - histBadges.ts < HIST_BADGE_TTL_MS;
    if (!force && fresh) return;
    if (histBadges.inflight) return;
    histBadges.inflight = (async () => {
        try {
            const res = await jfetch("/settings_hub/workflows/history/badges");
            if (res.json?.ok && res.json.badges && typeof res.json.badges === "object") {
                histBadges.map = res.json.badges;
                applyHistBadges();
            }
        } catch (_) { /* an old py without the route - the rows stay unbadged */ }
        // the timestamp ticks on EVERY completed attempt (even a 404) - a
        // stale pack must not turn every re-render into a request storm
        histBadges.ts = Date.now();
        histBadges.inflight = null;
    })();
}

async function openHistPop(path, anchorBtn) {
    if (histPop) { closeHistPop(); return; }
    // v114: manage - the version-cleanup mode (checkboxes + Select all /
    // Deselect all + an armed Delete selected); delSel holds the chosen
    // revisionIds; armedDel is the second-click confirm state.
    // v115: armedProc - the WHOLE-PROCESS delete confirm (the owner's "кнопка
    // удалять сами процессы со всеми хвостами"); procDelBusy locks the strip
    // while the POST is in flight.
    histState = { path, pid: null, proc: null, revs: [], loading: true,
        error: null, cpBusy: false, armedRestore: null, compare: null,
        manage: false, delSel: new Set(), armedDel: false,
        armedProc: false, procDelBusy: false,
        // v116 (plan 4.6): the notes search inside the history panel - the
        // process notes + revision titles/notes from the SQLite index
        notesQ: "", notes: null, notesBusy: false,
        anchor: popAnchorRect(anchorBtn) };
    histPop = document.createElement("div");
    histPop.className = "hub-menu hub-wf-histpop";
    histPop.innerHTML = `<div class="hub-menu-title">🕘 Process history</div>` +
        `<div class="hub-wf-emptylist">Reading the history…</div>`;
    document.body.appendChild(histPop);
    placeHubPop(histPop, histState.anchor, { maxW: 520 });
    histPop.addEventListener("click", (e) => {
        const btn = e.target?.closest?.("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act && act.startsWith("hist")) { e.preventDefault(); e.stopPropagation(); histPopClick(act, btn); }
    });
    // the pop lives on document.body - OUTSIDE the panel's delegated
    // listeners, so it carries its OWN input/change wiring
    histPop.addEventListener("input", (e) => {
        const el = e.target;
        if (!el) return;
        if (el.matches('[data-wf="histnote"]') && histState) {
            histState.noteDraft = el.value || "";
        }
        // v116 (plan 4.6): the debounced notes search (FTS server-side)
        if (el.matches('[data-wf="histsearch"]') && histState) {
            histState.notesQ = el.value || "";
            clearTimeout(histState.notesT);
            histState.notesT = setTimeout(() => void histSearchNotes(), 250);
        }
    });
    histPop.addEventListener("change", (e) => {
        const el = e.target;
        if (!el) return;
        if (el.matches("[data-hcmp]") && histState) {
            if (!histState.cmpA || histState.cmpA === el.dataset.hcmp) {
                histState.cmpA = el.dataset.hcmp;
                histState.cmpB = null;
            } else if (!histState.cmpB) {
                histState.cmpB = el.dataset.hcmp;
            } else {
                histState.cmpA = histState.cmpB;
                histState.cmpB = el.dataset.hcmp;
            }
            renderHistPop();
        }
        // v114: the manage-mode deletion checkboxes (the radio above is the
        // Compare pair; the two never show at once)
        if (el.matches("[data-hdel]") && histState) {
            const rid = el.dataset.hdel;
            if (el.checked) histState.delSel.add(rid);
            else histState.delSel.delete(rid);
            histState.armedDel = false;   // a changed selection disarms
            renderHistPop();
        }
    });
    window.addEventListener("mousedown", onHistDown, true);
    window.addEventListener("keydown", onHistKey, true);
    containPopTextKeys(histPop);   // v113: the note input never leaks keys
    await refreshHistState();
}

/** v116 (plan 4.6): the NOTES search over the SQLite notes index - the
 *  process notes + the revision titles/notes, never a Git blob read. A
 *  result row switches the panel to that process (Open). */
async function histSearchNotes() {
    const st = histState;
    if (!st) return;
    const q = (st.notesQ || "").trim();
    if (!q) { st.notes = null; renderHistPop(); return; }
    st.notesBusy = true;
    renderHistPop();
    try {
        const res = await jfetch("/settings_hub/workflows/index/notes?q=" +
            encodeURIComponent(q) + "&limit=30");
        st.notes = res.json?.ok ? (res.json.results || []) : null;
        if (!res.json?.ok && res.json?.error) st.notesError = res.json.error;
        else st.notesError = null;
    } catch (_) {
        st.notes = null;
        st.notesError = "the notes search is unavailable (an old py)";
    }
    st.notesBusy = false;
    renderHistPop();
}

/** v116: a notes-result click loads THAT process into the panel (the
 *  primary location becomes the reference path; every action - Checkpoint,
 *  Restore, Manage versions - keeps working on it). */
async function histOpenProcess(pid) {
    const st = histState;
    if (!st || !pid) return;
    st.loading = true;
    st.error = null;
    st.notes = null;
    st.notesQ = "";
    renderHistPop();
    const pr = await jfetch("/settings_hub/workflows/history/process/" + encodeURIComponent(pid));
    if (pr.json?.ok && pr.json.process) {
        st.pid = pid;
        st.proc = pr.json.process;
        st.revs = Array.isArray(pr.json.process.revisions) ? pr.json.process.revisions : [];
        const prim = (pr.json.process.locations || []).find((l) => l.isPrimary) ||
            (pr.json.process.locations || [])[0] || null;
        st.path = prim?.path || (st.proc.workflowId ? st.proc.displayName : st.path);
        st.changeStatus = null;
        st.changesSince = false;
    } else {
        st.error = (pr.json && pr.json.error) || ("HTTP " + pr.status);
    }
    st.loading = false;
    renderHistPop();
}

async function refreshHistState() {
    if (!histState) return;
    histState.loading = true;
    histState.error = null;
    renderHistPop();
    const res = await jfetch("/settings_hub/workflows/history/resolve?path=" +
        encodeURIComponent(histState.path));
    if (res.json?.ok && res.json.bound && res.json.process) {
        histState.pid = res.json.process.processId;
        const pr = await jfetch("/settings_hub/workflows/history/process/" +
            encodeURIComponent(res.json.process.processId));
        if (pr.json?.ok && pr.json.process) {
            histState.proc = pr.json.process;
            histState.revs = Array.isArray(pr.json.process.revisions)
                ? pr.json.process.revisions : [];
        } else {
            histState.error = (pr.json && pr.json.error) || ("HTTP " + pr.status);
        }
        // v116 (plan 4.2): the layered 5-state status (the v112 rawHash
        // compare showed a workflow change for a canvas move)
        histState.changeStatus = res.json.changeStatus || null;
        histState.statusLabel = res.json.statusLabel || null;
        histState.changesSince = !!res.json.changesSinceCheckpoint;
    } else if (res.status === 404) {
        histState.error = "The history routes are missing (an old py) - update the FULL pack.";
    } else if (res.json?.ok && !res.json.bound) {
        histState.pid = null;
        histState.proc = null;
        histState.revs = [];
    } else {
        histState.error = (res.json && res.json.error) || ("HTTP " + res.status);
    }
    histState.loading = false;
    renderHistPop();
}

/** v114: the server's protection contract mirrored for the UI - stable and
 *  current revisions get a DISABLED checkbox (the server decides anyway). */
function histRevProtectReason(r) {
    if (r.isStable) return "Marked stable - protected from deletion";
    if (histState?.proc?.currentRevisionId === r.revisionId)
        return "The current version - restore another one first";
    return "";
}

function histRevRowHtml(r, i) {
    const lbl = histRevLabel(r);
    const stable = !!r.isStable;
    const sel = histState.sel === r.revisionId;
    // v114: in manage mode the Compare radio gives way to the deletion
    // checkbox; protected rows are disabled with the reason on the tooltip
    const lead = histState.manage
        ? (() => {
            const prot = histRevProtectReason(r);
            return `<input type="checkbox" data-hdel="${esc(r.revisionId)}"${histState.delSel.has(r.revisionId) ? " checked" : ""}${prot ? " disabled" : ""} ` +
                `title="${prot ? "Cannot delete: " + esc(prot) : "Select for deletion"}">`;
        })()
        : `<input type="radio" name="hub-wf-histcmp" data-hcmp="${esc(r.revisionId)}"${histState.cmpA === r.revisionId ? " checked" : ""} ` +
        `title="Select two versions for Compare">`;
    return `<div class="hub-wf-item${sel ? " hub-wf-item-open" : ""}" data-hrev="${esc(r.revisionId)}">` +
        lead +
        `<button type="button" class="hub-wf-name" data-act="histopen" data-rid="${esc(r.revisionId)}" ` +
        `title="Open this version as an independent COPY (the source file is never touched)">` +
        `${esc(lbl.title || ("Checkpoint " + (histState.revs.length - i)))}</button>` +
        `${stable ? `<span class="hub-wf-dot" title="Marked stable - never cleaned up">★</span>` : ""}` +
        `<span class="hub-wf-filesub">${esc(lbl.d)} · ${esc(lbl.src)}${r.note && r.title ? " · " + esc(r.note) : ""}</span>` +
        `<button type="button" class="hub-wf-cbtn" data-act="histstable" data-rid="${esc(r.revisionId)}" ` +
        `title="${stable ? "Unmark stable" : "Mark stable - protects this version from cleanup"}">★</button>` +
        `<button type="button" class="hub-wf-cbtn" data-act="histrestore" data-rid="${esc(r.revisionId)}" ` +
        `title="Restore: opens a COPY first; overwriting the file needs a second confirm">↺</button>` +
        `</div>`;
}

function renderHistPop() {
    if (!histPop || !histState) return;
    const st = histState;
    let body = "";
    if (st.loading) {
        body = `<div class="hub-wf-emptylist">Reading the history…</div>`;
    } else if (st.error) {
        body = `<div class="hub-wf-planwarn">⚠ ${esc(st.error)}</div>`;
    } else {
        const procName = st.proc?.displayName || baseName(st.path);
        const uuid = st.proc?.workflowId ? ` · <span class="hub-wf-snap" title="${esc(st.proc.workflowId)}">⧉ ${esc(String(st.proc.workflowId).slice(0, 8))}…</span>` : "";
        const head = `<div class="hub-wf-planrow"><span class="hub-wf-plan-cap">Process</span>` +
            `<span class="hub-wf-plan-names">${esc(procName)}${uuid}</span></div>` +
            // v116 (plan 4.2): the status speaks in the plan's five labels -
            // a canvas-only change no longer claims a workflow change
            (st.changeStatus === "presentation_changed"
                ? `<div class="hub-wf-planhint" title="The working graph is identical; only the canvas/layout metadata moved">⇅ ${esc(st.statusLabel || "Canvas changed only")} - a Checkpoint still saves the exact current state.</div>`
                : st.changeStatus === "metadata_changed"
                    ? `<div class="hub-wf-planhint" title="The graph is the same; unclassified extension metadata moved">⇅ ${esc(st.statusLabel || "Metadata changed")} - a Checkpoint still saves the exact current state.</div>`
                    : st.changesSince
                        ? `<div class="hub-wf-planwarn" title="The current disk file (or the open tab) differs from the last Checkpoint">⇅ ${esc(st.statusLabel || "Changes since the last checkpoint")} - a Checkpoint saves the current state.</div>`
                        : "");
        const cp = `<div class="hub-wf-planacts">` +
            `<input type="text" class="hub-cs-in" data-wf="histnote" placeholder="What changed? (optional)" value="${esc(st.noteDraft || "")}" spellcheck="false">` +
            `<button type="button" class="hub-wf-act" data-act="histcheckpoint" title="Capture the CURRENT state into the history${st.openTab ? " (the in-memory tab incl. unsaved edits)" : " (the disk file)"}">📌 Checkpoint</button>` +
            `<button type="button" class="hub-wf-act" data-act="histimport" title="Add the CURRENT DISK file into the history as an imported version">⤓ Import disk file</button>` +
            `</div>` +
            (st.openTab ? `<div class="hub-wf-planhint">The tab is open - the Checkpoint captures the in-memory graph, including unsaved edits.</div>` : "");
        const revs = st.revs.length
            ? st.revs.map(histRevRowHtml).join("")
            : `<div class="hub-wf-emptylist">No checkpoints yet - the ordinary ComfyUI Save does not create history; press 📌 Checkpoint to fix the current state.</div>`;
        // v114: in manage mode the section header carries the DYNAMIC
        // Select all / Deselect all button (the owner's wording: "выделить
        // все/снять все - динамическая кнопка"): it selects every
        // DELETABLE version, the label flips when all of them are chosen
        const delIds = st.revs.filter((r) => !histRevProtectReason(r))
            .map((r) => r.revisionId);
        const allSel = delIds.length > 0 &&
            delIds.every((rid) => st.delSel.has(rid));
        const sectHead = st.manage
            ? `<div class="hub-wf-sect hub-wf-sect-row">Checkpoints (newest first)` +
              `<button type="button" class="hub-wf-act hub-wf-fchip" data-act="histdelall" ` +
              `title="${allSel ? "Clear the selection" : "Select every deletable version (stable + current stay protected)"}">${allSel ? "Deselect all" : "Select all"}</button></div>`
            : `<div class="hub-wf-sect">Checkpoints (newest first)</div>`;
        const cmpBtn = st.cmpA && st.cmpB
            ? `<button type="button" class="hub-wf-act" data-act="histcompare">⚖ Compare the selected versions</button>` : "";
        // v114: the manage-mode actions - the armed Delete selected + Done;
        // the plain mode carries ONE 🗑 Manage versions entry button
        const nSel = st.delSel.size;
        const manageBtns = st.manage
            ? `<button type="button" class="hub-wf-act${st.armedDel ? " hub-wf-armed" : ""}" data-act="histdelsel" ` +
              `title="${st.armedDel ? "Click AGAIN to delete the selected versions" : "Delete the selected versions (stable + current are protected)"}">` +
              `${st.armedDel ? "⚠ Click AGAIN to delete " + nSel : "🗑 Delete selected" + (nSel ? " (" + nSel + ")" : "")}</button>` +
              `<button type="button" class="hub-wf-act" data-act="histdeldone" title="Leave the manage mode">✓ Done</button>`
            : `<button type="button" class="hub-wf-act" data-act="histdelmode" title="Manage the versions: select and delete the checkpoints you do not need">🗑 Manage versions</button>`;
        // v115 (owner request): the process deletion - an armed confirm strip.
        // v117 (the owner's delete plan): PLAIN LANGUAGE, no jargon, and the
        // dangerous UUID-wide file deletion is GONE - the file scope is the
        // panel's CURRENT file only; the copies with the same UUID on disk
        // are never touched, and the versions die only when no copy survives.
        const locs = Array.isArray(st.proc?.locations) ? st.proc.locations : [];
        const nLocs = locs.length;
        const nOthers = locs.filter((l) =>
            normWfPath(String(l?.path || "")) !== normWfPath(st.path)).length;
        const procDelUi = st.armedProc && st.pid
            ? `<div class="hub-wf-planwarn">⚠ Delete <b>${esc(procName)}</b>` +
              `<div class="hub-wf-filesub" style="margin:3px 0">Current file: ${esc(baseName(st.path))}` +
              ` · ${st.revs.length} saved version(s)` +
              (nOthers ? ` · ${nOthers} other file(s) with the same UUID stay on disk` : ` · no other copies on disk`) +
              `</div>` +
              `<div class="hub-wf-planacts hub-wf-planacts-end" style="margin-top:4px">` +
              `<button type="button" class="hub-wf-act hub-wf-armed" data-act="histprocyes" ` +
              `title="Delete the CURRENT file only (${nOthers ? "the other " + nOthers + " file(s) with the same UUID are NOT touched - the versions stay reachable through them" : "no other copies exist - the saved versions are deleted with the file"})">${st.procDelBusy ? "…" : "Delete current file (and versions if no copies left)"}</button>` +
              `<button type="button" class="hub-wf-act" data-act="histprochist" ` +
              `title="Erase all ${st.revs.length} saved version(s); the workflow file(s) stay byte-for-byte">${st.procDelBusy ? "…" : "Delete stored versions only - keep files"}</button>` +
              `<button type="button" class="hub-wf-act" data-act="histproccancel" title="Do not delete anything">✕ Cancel</button>` +
              `</div></div>`
            : "";
        const compareBox = st.compare ? st.compare : "";
        // v116 (plan 4.6): the NOTES search - the results land right above
        // the checkpoints (a click loads that process into the panel)
        const notesUi = `<div class="hub-wf-planacts">` +
            `<input type="text" class="hub-cs-in" data-wf="histsearch" placeholder="🔍 Search notes: process names, version notes…" value="${esc(st.notesQ || "")}" spellcheck="false">` +
            `</div>` +
            (st.notesBusy ? `<div class="hub-wf-emptylist">Searching the notes…</div>` : "") +
            (st.notesError ? `<div class="hub-wf-planwarn">⚠ ${esc(st.notesError)}</div>` : "") +
            (st.notes && !st.notes.length && (st.notesQ || "").trim()
                ? `<div class="hub-wf-emptylist">No notes match '${esc(st.notesQ)}'</div>` : "") +
            (st.notes && st.notes.length
                ? `<div class="hub-wf-list">` + st.notes.slice(0, 12).map((n) =>
                    `<div class="hub-wf-item" data-hnote="${esc(n.processId || "")}">` +
                    `<button type="button" class="hub-wf-name" data-act="histnoteopen" data-pid="${esc(n.processId || "")}" ` +
                    `title="Open this process in the panel">${n.kind === "revision" ? "🕘" : "📄"} ${esc(n.title || n.note || "(no title)")}</button>` +
                    `<span class="hub-wf-filesub">${n.kind === "revision" ? "version" : "process"}${n.note && n.title ? " · " + esc(n.note.slice(0, 60)) : ""}</span>` +
                    `</div>`).join("") + `</div>` : "");
        body = head + cp + notesUi + sectHead +
            `<div class="hub-wf-list">${revs}</div>` +
            compareBox +
            procDelUi +
            // v113: ONE bottom actions row - ✎ Process and ✕ Close used to
            // sit in two stacked planacts strips and read as a column
            `<div class="hub-wf-planacts hub-wf-planacts-end">${cmpBtn}${manageBtns}` +
            (st.pid && !st.armedProc ? `<button type="button" class="hub-wf-act" data-act="histprocarm" title="Delete this file and its versions - files with the same UUID that you did NOT select are never touched (a confirmed two-step action)">🗑 Delete process</button>` : "") +
            `<button type="button" class="hub-wf-act" data-act="histmeta" title="Rename the process / edit the shared note">✎ Process</button>` +
            `<button type="button" class="hub-wf-act" data-act="histclose" title="Close the history panel">✕ Close</button></div>`;
        // the restore confirm strip
        if (st.pendingRestore) {
            body += `<div class="hub-wf-planwarn">⚠ Overwrite <b>${esc(baseName(st.path))}</b> with the selected version? ` +
                `<button type="button" class="hub-wf-act hub-wf-armed" data-act="histrestoreconfirm">Click AGAIN to replace the file</button> ` +
                `<span class="hub-wf-snap">(a safety snapshot is taken first; undoable)</span></div>`;
        }
    }
    histPop.innerHTML = `<div class="hub-menu-title">🕘 Process history</div>` +
        `<div class="hub-wf-planhint">${esc(histState.path || "")}</div>` + body;
    // v113: the content size changed (loading -> data) - re-clamp + re-place
    placeHubPop(histPop, histState.anchor, { maxW: 520 });
}

/** The COMPARE of two revisions (plan 9.1): a human-readable STRUCTURAL
 *  diff - not only counts. Nodes added/removed/class-changed, widget value
 *  changes (old -> new previews for the unrecognized shapes), the model
 *  references, the confirmed sampler/resolution params, the prompt/text
 *  changes, the presentation-only group and the unknown-extension group.
 *  No invented semantics for custom node widgets: only node type + field
 *  + old/new JSON preview. */
async function runHistCompare() {
    const st = histState;
    if (!st?.cmpA || !st.cmpB) return;
    const [ra, rb] = [st.revs.find((r) => r.revisionId === st.cmpA),
        st.revs.find((r) => r.revisionId === st.cmpB)];
    if (!ra || !rb) return;
    const load = async (rid) => {
        const res = await jfetch("/settings_hub/workflows/history/revision/" +
            encodeURIComponent(rid) + "/raw");
        if (res.json && typeof res.json === "object") return res.json;
        try { return JSON.parse(await res.text()); } catch (_) { return null; }
    };
    const ga = await load(ra.revisionId);
    const gb = await load(rb.revisionId);
    if (!ga || !gb) {
        st.compare = `<div class="hub-wf-planwarn">⚠ Could not read the versions for compare.</div>`;
        renderHistPop();
        return;
    }
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const prev = (v) => esc(JSON.stringify(v).slice(0, 80));
    const nodesA = Array.isArray(ga.nodes) ? ga.nodes : [];
    const nodesB = Array.isArray(gb.nodes) ? gb.nodes : [];
    const mapA = new Map(nodesA.filter((n) => n && typeof n === "object").map((n) => [n.id, n]));
    const mapB = new Map(nodesB.filter((n) => n && typeof n === "object").map((n) => [n.id, n]));
    const added = [...mapB.keys()].filter((id) => !mapA.has(id));
    const removed = [...mapA.keys()].filter((id) => !mapB.has(id));
    const classChanged = [...mapB.keys()].filter((id) =>
        mapA.has(id) && mapA.get(id).type !== mapB.get(id).type);
    const valChanged = [];
    const presChanged = [];
    for (const id of mapB.keys()) {
        if (!mapA.has(id)) continue;
        const a = mapA.get(id), b = mapB.get(id);
        const wa = Array.isArray(a.widgets_values) ? a.widgets_values : null;
        const wb = Array.isArray(b.widgets_values) ? b.widgets_values : null;
        if (wa && wb && JSON.stringify(wa) !== JSON.stringify(wb)) {
            const n2 = Math.max(wa.length, wb.length);
            for (let i = 0; i < n2; i++) {
                if (JSON.stringify(wa[i]) !== JSON.stringify(wb[i])) {
                    valChanged.push(`#${id} (${esc(String(b.type || "?"))}) widgets[${i}]: ${prev(wa[i])} → ${prev(wb[i])}`);
                }
            }
        }
        const pa = JSON.stringify([a.pos, a.size, a.collapsed, a.bgcolor]);
        const pb = JSON.stringify([b.pos, b.size, b.collapsed, b.bgcolor]);
        if (pa !== pb) presChanged.push(`#${id}`);
    }
    const linksA = JSON.stringify(ga.links || []);
    const linksB = JSON.stringify(gb.links || []);
    const linksChanged = linksA !== linksB;
    // the confirmed parameter shapes (KSampler / EmptyLatentImage) only
    const params = (g) => {
        const out = {};
        for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
            if (!n || typeof n !== "object") continue;
            const t = String(n.type || "");
            const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
            const nums = wv.filter((v) => typeof v === "number");
            const strs = wv.filter((v) => typeof v === "string");
            if (t.startsWith("KSampler") && nums.length >= 3) {
                out.steps = out.steps ?? nums[1];
                out.cfg = out.cfg ?? nums[2];
                for (const v of strs) {
                    if (/^(euler|heun|lms|ddim|ddpm|uni_pc|dpm)/.test(v) && !out.sampler) out.sampler = v;
                }
            }
            if ((t === "EmptyLatentImage" || t === "EmptySD3LatentImage") && nums.length >= 2) {
                out.size = out.size ?? (nums[0] + "×" + nums[1]);
            }
        }
        return out;
    };
    const PA = params(ga), PB = params(gb);
    const paramRows = [...new Set([...Object.keys(PA), ...Object.keys(PB)])]
        .filter((k) => JSON.stringify(PA[k]) !== JSON.stringify(PB[k]))
        .map((k) => `${k}: ${prev(PA[k])} → ${prev(PB[k])}`);
    const modelsOf = (g) => {
        const out = [];
        for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
            const wv = n && Array.isArray(n.widgets_values) ? n.widgets_values : [];
            for (const v of wv) {
                if (typeof v === "string" && /\.(safetensors|ckpt|pt|pth|sft)$/i.test(v) &&
                    !out.includes(v)) out.push(v);
            }
        }
        return out;
    };
    const MA = modelsOf(ga), MB = modelsOf(gb);
    const modelDiff = [...new Set([...MA, ...MB])]
        .filter((m) => (MA.includes(m) ? 1 : 0) !== (MB.includes(m) ? 1 : 0));
    // the unknown/extension metadata group (extra keys minus the confirmed
    // ds/frontendVersion)
    const exKeys = (g) => {
        const e = (g && typeof g.extra === "object" && g.extra) || {};
        return JSON.stringify(Object.fromEntries(
            Object.entries(e).filter(([k]) => k !== "ds" && k !== "frontendVersion")));
    };
    const extChanged = exKeys(ga) !== exKeys(gb);
    const summary = [`Nodes: ${nodesA.length} → ${nodesB.length}`];
    if (!added.length && !removed.length && !classChanged.length &&
        !valChanged.length && !linksChanged && !modelDiff.length &&
        !paramRows.length && !extChanged && !presChanged.length) {
        summary.push("The workflows are identical in content");
    }
    const group = (title, items, open) => !items.length ? "" :
        `<details${open ? " open" : ""}><summary class="hub-wf-sect" style="cursor:pointer">${title} (${items.length})</summary>` +
        `<div class="hub-wf-planhint">${items.slice(0, 40).map((r) => "· " + r).join("<br>")}${items.length > 40 ? "<br>… " + (items.length - 40) + " more" : ""}</div></details>`;
    st.compare = `<div class="hub-wf-sect">⚖ Compare</div>` +
        `<div class="hub-wf-planhint">${summary.map((r) => "· " + esc(r)).join("<br>")}</div>` +
        group("Nodes added", added.map((id) => `#${id} (${esc(String((mapB.get(id) || {}).type || "?"))})`), true) +
        group("Nodes removed", removed.map((id) => `#${id} (${esc(String((mapA.get(id) || {}).type || "?"))})`), true) +
        group("Node class changed", classChanged.map((id) =>
            `#${id}: ${esc(String(mapA.get(id).type))} → ${esc(String(mapB.get(id).type))}`), false) +
        group("Values changed", valChanged, true) +
        (linksChanged ? `<div class="hub-wf-planwarn">· Links changed (added/removed/rewired)</div>` : "") +
        group("Model references", modelDiff.map((m) =>
            `${esc(m)}: ${MA.includes(m) ? "present" : "absent"} → ${MB.includes(m) ? "present" : "absent"}`), false) +
        group("Generation parameters", paramRows, false) +
        (extChanged ? `<div class="hub-wf-planwarn">· Extension/metadata changed (unclassified extra fields)</div>` : "") +
        group("Canvas/layout only", presChanged.map((id) => `#${id}`), false);
    renderHistPop();
}

/** The Checkpoint action: the OPEN tab's in-memory graph wins over the disk
 * (plan 5.7.2) - a disk checkpoint only when the workflow is not open. */
async function histCreateCheckpoint(source) {
    const st = histState;
    if (!st || st.cpBusy) return;
    st.cpBusy = true;
    renderHistPop();
    try {
        const payload = { path: st.path, source: source || "checkpoint",
            note: st.noteDraft || undefined, title: undefined };
        if (!source || source === "checkpoint") {
            const tab = getOpenWorkflows().find((t) => t.path && sameWfPath(t.path, st.path));
            const graph = tab ? graphJsonOfOpenTab(tab) : null;
            if (graph) payload.graph = graph;
            else payload.source = "disk";
        }
        const res = await jfetch("/settings_hub/workflows/history/checkpoint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (res.json?.ok) {
            st.noteDraft = "";
            await refreshHistState();
            refreshHistBadges(true);   // v114: the row count chip changes
            if (res.json.duplicate) {
                localToast("No new checkpoint - content is identical");
            } else {
                // v116 (plan 10.3): the workflowHash comparison names a
                // canvas-only checkpoint honestly (nothing is blocked -
                // the exact revision still saves)
                const prev = st.revs && st.revs[1];
                const cur = res.json.revision || {};
                const canvasOnly = prev && cur.workflowHash && prev.workflowHash &&
                    cur.workflowHash === prev.workflowHash &&
                    cur.presentationHash !== prev.presentationHash;
                localToast(canvasOnly
                    ? "Checkpoint saved - only canvas/presentation changed"
                    : "Checkpoint saved" + (payload.graph ? " (the in-memory state)" : " (the disk file)"));
            }
            if (res.json.warning) localToast(res.json.warning, 6000);   // v116: the soft retention advisory
        } else {
            localToast("Checkpoint failed: " + ((res.json && res.json.error) || ("HTTP " + res.status)), 4200);
            st.cpBusy = false;
            renderHistPop();
            return;
        }
    } catch (e) {
        localToast("Checkpoint failed: " + String((e && e.message) || e), 4200);
    }
    st.cpBusy = false;
}

async function histRestore(rid, confirmReplace) {
    const st = histState;
    if (!st) return;
    if (!confirmReplace) {
        // the DEFAULT restore: open as an independent COPY (no writes)
        const res = await jfetch("/settings_hub/workflows/history/revision/" +
            encodeURIComponent(rid) + "/raw");
        let graph = null;
        if (res.json && typeof res.json === "object") graph = res.json;
        else { try { graph = JSON.parse(await res.text()); } catch (_) {} }
        if (!graph) { localToast("Could not read the version - see F12", 3600); return; }
        const r = await openSnapshotWorkflow(baseName(st.path), graph);
        if (r.ok) localToast("Opened the version as a copy (the file is untouched)");
        else localToast("Could not open the version - see F12", 3600);
        return;
    }
    // the CONFIRMED replace: the server snapshots + atomically overwrites
    const res = await jfetch("/settings_hub/workflows/history/process/" +
        encodeURIComponent(st.pid) + "/restore/" + encodeURIComponent(rid), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "replace", path: st.path }),
    });
    if (res.json?.ok) {
        st.pendingRestore = null;
        st.armedRestore = null;
        localToast("The file was replaced (a safety snapshot is kept)");
        await refreshSavedFiles();
        if (idxMode()) await runServerList(true);
        await refreshHistState();
    } else {
        localToast("Replace failed: " + ((res.json && res.json.error) || "?"), 5000);
    }
}

/** v114 (owner request): the batch deletion of the SELECTED versions - the
 *  server protects stable + current and splices the parent chain; the UI
 *  refreshes the list AND the row badges afterwards. */
async function histDeleteSelected() {
    const st = histState;
    if (!st?.pid || !st.delSel?.size) return;
    const rids = [...st.delSel];
    const res = await jfetch("/settings_hub/workflows/history/revision/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revisionIds: rids }),
    });
    st.armedDel = false;
    if (res.json?.ok) {
        const n = (res.json.deleted || []).length;
        const sk = (res.json.skipped || []).length;
        st.delSel.clear();
        localToast("Deleted " + n + " version(s)" +
            (sk ? " · " + sk + " protected/missing skipped" : ""));
        await refreshHistState();
        refreshHistBadges(true);   // the count chips on the Files rows
    } else {
        const why = (res.json && res.json.error) || ("HTTP " + res.status);
        localToast((res.status === 404
            ? "The delete route is missing (an old py) - update the FULL pack."
            : "Delete failed: " + why), 4200);
    }
}

/** v115 (owner request): the process deletion. v117 (the owner's delete
 *  plan): deleteFiles=true deletes ONLY the panel's CURRENT file (the exact
 *  path goes to the server) - the other files with the same UUID on disk
 *  are NEVER touched. The server erases the stored versions only when no
 *  live copy remains (keptHistory=false); otherwise the answer says
 *  keptHistory and the versions stay reachable through the surviving
 *  copies. deleteFiles=false is the explicit versions-only erasure - the
 *  files stay byte-for-byte. The panel closes, the badges/lists refresh. */
async function histDeleteProcess(deleteFiles) {
    const st = histState;
    if (!st?.pid || st.procDelBusy) return;
    st.procDelBusy = true;
    renderHistPop();
    const res = await jfetch("/settings_hub/workflows/history/process/" +
        encodeURIComponent(st.pid) + "/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // v117: the file scope is the CURRENT file only - never the whole
        // UUID (the plan's main principle)
        body: JSON.stringify(deleteFiles
            ? { deleteFiles: true, path: st.path }
            : { deleteFiles: false }),
    });
    st.procDelBusy = false;
    // v116 (plan 3.5): the preflight/partial refusal - the process and its
    // history are KEPT; the per-file reasons are named
    if (res.status === 409) {
        st.armedProc = false;
        const bad = ((res.json || {}).files || []).filter((f) => f.error)
            .map((f) => (f.path || "") + ": " + (f.error || "")).slice(0, 3).join(" · ");
        renderHistPop();
        localToast("Deleted nothing - " + ((res.json || {}).error || "the safety preflight failed") +
            (bad ? " · " + bad : ""), 7000);
        return;
    }
    if (res.json?.ok) {
        const n = res.json.deletedRevisions || 0;
        const files = Array.isArray(res.json.files) ? res.json.files : [];
        const removed = files.filter((f) => f.removed).length;
        const failed = files.filter((f) => f.error).length;
        const kept = !!res.json.keptHistory;
        const remaining = Number(res.json.remainingLocations) || 0;
        closeHistPop();
        refreshHistBadges(true);   // the count + duplicate chips on the rows
        await refreshSavedFiles();
        if (idxMode()) {
            await runServerList(true, true);
            void runGroups(true);   // the file set changed
        }
        localToast(kept
            // the file died, the versions live on through the other copies
            ? "Deleted the current file" +
              (failed ? " · " + failed + " file(s) FAILED" : "") +
              " · the " + n + " saved version(s) stay reachable through " +
              remaining + " other file(s) with the same UUID"
            : "Process deleted: " + n + " version(s)" +
              (deleteFiles ? " + " + removed + " file(s)" : " · the file(s) stay") +
              (failed ? " · " + failed + " file(s) FAILED" : ""), 6000);
    } else {
        const why = (res.json && res.json.error) || ("HTTP " + res.status);
        st.armedProc = false;
        renderHistPop();
        localToast((res.status === 404
            ? "The delete route is missing (an old py) - update the FULL pack."
            : "Delete failed: " + why), 4200);
    }
}

function histPopClick(act, btn) {
    const st = histState;
    if (!st) return;
    const rid = btn.dataset.rid || null;
    switch (act) {
        case "histclose": closeHistPop(); return;
        // v116 (plan 4.6): a notes-result click opens that process
        case "histnoteopen": {
            if (btn.dataset.pid) void histOpenProcess(btn.dataset.pid);
            return;
        }
        case "histcheckpoint": void histCreateCheckpoint("checkpoint"); return;
        case "histimport": void histCreateCheckpoint("import"); return;
        case "histopen": void histRestore(rid, false); return;
        case "histstable": {
            const rev = st.revs.find((r) => r.revisionId === rid);
            void (async () => {
                const res = await jfetch("/settings_hub/workflows/history/revision/" +
                    encodeURIComponent(rid) + "/stable", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ stable: !(rev && rev.isStable) }),
                });
                if (res.json?.ok) await refreshHistState();
                else localToast("Could not update: " + ((res.json && res.json.error) || "?"), 3600);
            })();
            return;
        }
        case "histrestore": {
            // the plan contract: Restore DEFAULTS to opening a COPY; the
            // file-replace is a SEPARATE confirmed action (the second click)
            if (st.armedRestore === rid) {
                st.pendingRestore = rid;
                renderHistPop();
                void histRestore(rid, true);
            } else {
                st.armedRestore = rid;
                void histRestore(rid, false); // the non-destructive copy open
                localToast("Opened as a copy. Click ↺ AGAIN to overwrite the file (confirmed + safety snapshot).", 5000);
            }
            return;
        }
        case "histrestoreconfirm": {
            if (st.armedRestore) void histRestore(st.armedRestore, true);
            return;
        }
        case "histcompare": void runHistCompare(); return;
        // v114: the version-cleanup actions
        case "histdelmode": {
            st.manage = !st.manage;
            st.armedDel = false;
            st.delSel.clear();
            renderHistPop();
            return;
        }
        case "histdelall": {
            // the DYNAMIC Select all / Deselect all - the label reflects the
            // state; selecting covers only the DELETABLE versions
            const ids = st.revs.filter((r) => !histRevProtectReason(r))
                .map((r) => r.revisionId);
            const allSel = ids.length > 0 && ids.every((rid) => st.delSel.has(rid));
            if (allSel) st.delSel.clear();
            else ids.forEach((rid) => st.delSel.add(rid));
            st.armedDel = false;
            renderHistPop();
            return;
        }
        case "histdelsel": {
            if (!st.delSel.size) return;
            if (!st.armedDel) { st.armedDel = true; renderHistPop(); return; }
            void histDeleteSelected();
            return;
        }
        case "histdeldone": {
            st.manage = false;
            st.armedDel = false;
            st.delSel.clear();
            renderHistPop();
            return;
        }
        // v115: the WHOLE-PROCESS delete (armed strip: two scopes + cancel)
        case "histprocarm": {
            st.armedProc = true;
            st.armedDel = false;
            st.delSel.clear();
            renderHistPop();
            return;
        }
        case "histprocyes": {
            if (!st.procDelBusy) void histDeleteProcess(true);
            return;
        }
        case "histprochist": {
            if (!st.procDelBusy) void histDeleteProcess(false);
            return;
        }
        case "histproccancel": {
            st.armedProc = false;
            renderHistPop();
            return;
        }
        case "histmeta": {
            const nm = prompt("Process name:", st.proc?.displayName || "");
            if (nm === null) return;
            const note = prompt("Process note (what is this workflow for?):", st.proc?.note || "");
            if (note === null) return;
            void (async () => {
                const res = await jfetch("/settings_hub/workflows/history/process/" +
                    encodeURIComponent(st.pid) + "/meta", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ displayName: nm, note }),
                });
                if (res.json?.ok) { await refreshHistState(); }
                else localToast("Could not update: " + ((res.json && res.json.error) || "?"), 3600);
            })();
            return;
        }
        default: return;
    }
}



// ---------------------------------------------------------------------------
// v112 stage 4 (plan 10): the PRESET VERSION HISTORY panel - the automatic
// archives of every meaningful change; Restore with a confirm preview; the
// Compare of two versions (name/tags/items summary). The payloads load for
// restore/compare only - the list carries metadata.
// ---------------------------------------------------------------------------

let pverPop = null;
let pverState = null;   // {pid, versions, loading, error, armed, cmpA, cmpB, compare}

function closePverPop() {
    try { pverPop?.remove(); } catch (_) {}
    pverPop = null;
    pverState = null;
    try { window.removeEventListener("mousedown", onPverDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onPverKey, true); } catch (_) {}
}
function onPverDown(e) {
    if (!pverPop || pverPop.contains(e.target)) return;
    closePverPop();
}
function onPverKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePverPop(); }
}

async function openPverPop(pid, anchorBtn) {
    if (pverPop) { closePverPop(); return; }
    pverState = { pid, versions: [], loading: true, error: null, armed: null,
        cmpA: null, cmpB: null, compare: null, anchor: popAnchorRect(anchorBtn) };
    pverPop = document.createElement("div");
    pverPop.className = "hub-menu hub-wf-histpop";
    pverPop.innerHTML = `<div class="hub-menu-title">🕘 Preset history</div>` +
        `<div class="hub-wf-emptylist">Reading the versions…</div>`;
    document.body.appendChild(pverPop);
    placeHubPop(pverPop, pverState.anchor, { maxW: 520 });
    pverPop.addEventListener("click", (e) => {
        const btn = e.target?.closest?.("[data-pact]");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        pverClick(btn.dataset.pact, btn);
    });
    pverPop.addEventListener("change", (e) => {
        const el = e.target;
        if (!el?.matches("[data-pcmp]") || !pverState) return;
        if (!pverState.cmpA || pverState.cmpA === el.dataset.pcmp) {
            pverState.cmpA = el.dataset.pcmp;
            pverState.cmpB = null;
        } else if (!pverState.cmpB) {
            pverState.cmpB = el.dataset.pcmp;
        } else {
            pverState.cmpA = pverState.cmpB;
            pverState.cmpB = el.dataset.pcmp;
        }
        renderPverPop();
    });
    window.addEventListener("mousedown", onPverDown, true);
    window.addEventListener("keydown", onPverKey, true);
    await refreshPverState();
}

async function refreshPverState() {
    if (!pverState) return;
    pverState.loading = true;
    pverState.error = null;
    renderPverPop();
    const res = await jfetch("/settings_hub/workflows/preset/" +
        encodeURIComponent(pverState.pid) + "/versions");
    if (res.json?.ok) {
        pverState.versions = Array.isArray(res.json.versions) ? res.json.versions : [];
        pverState.maxVersions = res.json.maxVersions || 20;
    } else if (res.status === 404) {
        pverState.error = "The version routes are missing (an old py) - update the FULL pack.";
    } else {
        pverState.error = (res.json && res.json.error) || ("HTTP " + res.status);
    }
    pverState.loading = false;
    renderPverPop();
}

function pverRowHtml(v, i) {
    const armed = pverState.armed === v.revisionId;
    return `<div class="hub-wf-item" data-prev="${esc(v.revisionId)}">` +
        `<input type="radio" name="hub-wf-pvercmp" data-pcmp="${esc(v.revisionId)}" title="Select two versions for Compare">` +
        `<span class="hub-wf-name" title="${esc(v.name || "")}">#${pverState.versions.length - i} · ${esc(v.name || "preset")}` +
        `${v.changedBy ? ` <span class="hub-wf-snap">${esc(v.changedBy)}</span>` : ""}</span>` +
        `<span class="hub-wf-filesub">${esc(fmtDateTime(v.createdAt))} · ${v.itemCount} item(s)` +
        `${v.snapshotBytes > 0 ? " · " + fmtSize(v.snapshotBytes) : ""}` +
        `${v.category ? " · " + esc(v.category) : ""}${(v.tags || []).length ? " · " + esc(v.tags.join(", ")) : ""}</span>` +
        `<button type="button" class="hub-wf-cbtn${armed ? " hub-wf-armed" : ""}" data-pact="prestore" data-rid="${esc(v.revisionId)}" ` +
        `title="${armed ? "Click AGAIN: the CURRENT state is archived first, then this version returns" : "Restore this version (the current state archives first - always reversible)"}">↺</button>` +
        `</div>`;
}

function renderPverPop() {
    if (!pverPop || !pverState) return;
    const st = pverState;
    let body = "";
    if (st.loading) body = `<div class="hub-wf-emptylist">Reading the versions…</div>`;
    else if (st.error) body = `<div class="hub-wf-planwarn">⚠ ${esc(st.error)}</div>`;
    else {
        body = st.versions.length
            ? `<div class="hub-wf-list">${st.versions.map(pverRowHtml).join("")}</div>`
            : `<div class="hub-wf-emptylist">No archived versions yet - every meaningful change archives the previous state automatically.</div>`;
        if (st.cmpA && st.cmpB) {
            body += `<button type="button" class="hub-wf-act" data-pact="pcompare">⚖ Compare the selected versions</button>`;
        }
        if (st.compare) body += st.compare;
        if (st.pendingRestore) {
            body += `<div class="hub-wf-planwarn">⚠ Restore version #${st.pendingRestore.n}? The current state archives FIRST (nothing is lost). ` +
                `<button type="button" class="hub-wf-act hub-wf-armed" data-pact="prestoreconfirm">Click AGAIN to restore</button></div>`;
        }
    }
    pverPop.innerHTML = `<div class="hub-menu-title">🕘 Preset history</div>` +
        `<div class="hub-wf-planhint">Every overwrite / merge / import archives the previous state automatically (up to ${st.maxVersions || 20}).</div>` +
        body +
        `<div class="hub-wf-planacts hub-wf-planacts-end"><button type="button" class="hub-wf-act" data-pact="pclose">✕ Close</button></div>`;
    // v113: re-clamp + re-place (the content size changed)
    placeHubPop(pverPop, pverState.anchor, { maxW: 520 });
}

async function pverClick(act, btn) {
    const st = pverState;
    if (!st) return;
    const rid = btn.dataset.rid || null;
    switch (act) {
        case "pclose": closePverPop(); return;
        case "prestore": {
            if (st.armed === rid) {
                await pverRestore(rid);
            } else {
                st.armed = rid;
                const idx = st.versions.findIndex((v) => v.revisionId === rid);
                st.pendingRestore = { rid, n: st.versions.length - idx };
                renderPverPop();
            }
            return;
        }
        case "prestoreconfirm": {
            if (st.armed) await pverRestore(st.armed);
            return;
        }
        case "pcompare": await pverCompare(); return;
        default: return;
    }
}

async function pverRestore(rid) {
    const st = pverState;
    const res = await jfetch("/settings_hub/workflows/preset/" +
        encodeURIComponent(st.pid) + "/restore/" + encodeURIComponent(rid), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    if (res.json?.ok) {
        st.armed = null;
        st.pendingRestore = null;
        await refreshPresets();
        renderAll();
        localToast("Restored version (the previous state was archived - reversible)");
        await refreshPverState();
    } else {
        localToast("Restore failed: " + ((res.json && res.json.error) || "?"), 4200);
    }
}

async function pverCompare() {
    const st = pverState;
    const ra = st.versions.find((v) => v.revisionId === st.cmpA);
    const rb = st.versions.find((v) => v.revisionId === st.cmpB);
    if (!ra || !rb) return;
    const load = async (rid) => {
        const res = await jfetch("/settings_hub/workflows/preset/" +
            encodeURIComponent(st.pid) + "/version/" + encodeURIComponent(rid));
        return res.json?.ok ? res.json.preset : null;
    };
    const [pa, pb] = [await load(ra.revisionId), await load(rb.revisionId)];
    if (!pa || !pb) {
        st.compare = `<div class="hub-wf-planwarn">⚠ Could not read the versions.</div>`;
        renderPverPop();
        return;
    }
    const itemsSig = (p) => (p.items || []).map((it) =>
        it.kind === "path" ? ("path:" + (it.path || "")) : ("snap:" + (it.snapHash || it.name || "")));
    const sa = new Set(itemsSig(pa)), sb = new Set(itemsSig(pb));
    const added = itemsSig(pb).filter((s) => !sa.has(s));
    const removed = itemsSig(pa).filter((s) => !sb.has(s));
    const rows = [
        `Name: ${pa.name || "?"} → ${pb.name || "?"}`,
        `Category: ${pa.category || "Uncategorized"} → ${pb.category || "Uncategorized"}`,
        `Tags: ${(pa.tags || []).join(", ") || "—"} → ${(pb.tags || []).join(", ") || "—"}`,
        `Items: ${(pa.items || []).length} → ${(pb.items || []).length}`,
        ...(added.length ? ["Added: " + added.length + " item(s)"] : []),
        ...(removed.length ? ["Removed: " + removed.length + " item(s)"] : []),
    ];
    st.compare = `<div class="hub-wf-sect">⚖ Compare</div>` +
        `<div class="hub-wf-planhint">${rows.map((r) => "· " + esc(r)).join("<br>")}</div>`;
    renderPverPop();
}



// ---------------------------------------------------------------------------
// v112 stage 5 (plan 11) + stage 6 (plan 12): the WORKFLOW INSPECTOR + the
// DEPENDENCY CHECK + the library summary. Honest diagnostics only - every
// non-extractable value shows "Not detected"; the report never blocks an
// open.
// ---------------------------------------------------------------------------

let inspPop = null;
let inspState = null;   // {path, loading, error, data}

function closeInspPop() {
    try { inspPop?.remove(); } catch (_) {}
    inspPop = null;
    inspState = null;
    try { window.removeEventListener("mousedown", onInspDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", onInspKey, true); } catch (_) {}
}
function onInspDown(e) {
    if (!inspPop || inspPop.contains(e.target)) return;
    closeInspPop();
}
function onInspKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeInspPop(); }
}

async function openInspPop(path, anchorBtn) {
    if (inspPop) { closeInspPop(); return; }
    inspState = { path, loading: true, error: null, data: null,
        anchor: popAnchorRect(anchorBtn) };
    inspPop = document.createElement("div");
    inspPop.className = "hub-menu hub-wf-histpop";
    inspPop.innerHTML = `<div class="hub-menu-title">🔍 Workflow inspector</div>` +
        `<div class="hub-wf-emptylist">Inspecting…</div>`;
    document.body.appendChild(inspPop);
    placeHubPop(inspPop, inspState.anchor, { maxW: 520 });
    inspPop.addEventListener("click", (e) => {
        const btn = e.target?.closest?.("[data-iact]");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (btn.dataset.iact === "iclose") closeInspPop();
        if (btn.dataset.iact === "icopyuuid" && btn.dataset.uuid) {
            void copyText(btn.dataset.uuid).then((ok) =>
                localToast(ok ? "UUID copied" : "Could not copy - see F12"));
        }
    });
    window.addEventListener("mousedown", onInspDown, true);
    window.addEventListener("keydown", onInspKey, true);
    // v113: the summary and the inspection run in PARALLEL (the v112
    // sequential chain doubled the wait on every open)
    const [sumRes, res] = await Promise.all([
        jfetch("/settings_hub/workflows/index/summary"),
        jfetch("/settings_hub/workflows/index/inspect?path=" +
            encodeURIComponent(path)),
    ]);
    inspState.summary = sumRes.json?.ok ? sumRes.json : null;
    if (res.json?.ok) {
        inspState.data = res.json;
    } else if (res.status === 404) {
        inspState.error = "The inspector routes are missing (an old py) - update the FULL pack.";
    } else {
        inspState.error = (res.json && res.json.error) || ("HTTP " + res.status);
    }
    inspState.loading = false;
    renderInspPop();
}

function inspRow(cap, val, title) {
    return `<div class="hub-wf-planrow"><span class="hub-wf-plan-cap" title="${esc(title || cap)}">${esc(cap)}</span>` +
        `<span class="hub-wf-plan-names">${val}</span></div>`;
}

function renderInspPop() {
    if (!inspPop || !inspState) return;
    const st = inspState;
    let body = "";
    if (st.loading) {
        body = `<div class="hub-wf-emptylist">Inspecting…</div>`;
    } else if (st.error) {
        body = `<div class="hub-wf-planwarn">⚠ ${esc(st.error)}</div>`;
    } else {
        const d = st.data;
        const uuid = d.workflowId
            ? `<button type="button" class="hub-wf-act" data-iact="icopyuuid" data-uuid="${esc(d.workflowId)}" title="Copy the ComfyUI workflow UUID">⧉ ${esc(String(d.workflowId).slice(0, 10))}…</button>`
            : `<span class="hub-wf-snap" title="No valid ComfyUI UUID in this JSON">No UUID</span>`;
        const params = d.params || {};
        const paramStr = [
            params.steps != null ? "steps " + params.steps : null,
            params.cfg != null ? "cfg " + params.cfg : null,
            params.sampler || null,
            params.scheduler || null,
            (params.width != null && params.height != null) ? params.width + "×" + params.height : null,
        ].filter(Boolean).join(" · ") || `<span class="hub-wf-snap">Not detected</span>`;
        const types = (d.nodeTypes || []).slice(0, 40).map((t) => esc(t)).join(", ") +
            ((d.nodeTypes || []).length > 40 ? " …+" + (d.nodeTypes.length - 40) : "");
        const models = (d.models || []).length
            ? (d.models || []).slice(0, 10).map((m) => esc(m)).join("<br>") +
              ((d.models || []).length > 10 ? "<br>…+" + (d.models.length - 10) : "")
            : `<span class="hub-wf-snap">Not detected</span>`;
        const deps = d.deps || {};
        const depRows = [];
        if (deps.unknownNodes?.length) {
            depRows.push(`<div class="hub-wf-planwarn" title="These node classes are not in the installed registry">⚠ Missing nodes: ${deps.unknownNodes.map(esc).join(", ")}</div>`);
        }
        for (const m of (deps.models || [])) {
            if (m.status === "missing") {
                depRows.push(`<div class="hub-wf-planwarn">⚠ Missing model: ${esc(m.name)}</div>`);
            }
        }
        if (!deps.unknownNodes?.length && !(deps.models || []).some((m) => m.status === "missing")) {
            depRows.push(`<div class="hub-wf-planhint" title="Every node class and every model file this workflow references checks out">✓ No missing dependencies detected${d.depsRegistryKnown ? "" : " (the node registry is not exposed by this runtime - the check is partial)"}</div>`);
        }
        const groups = d.groups || {};
        const grpStr = [];
        if (groups.exactCopies) grpStr.push(groups.exactCopies + " exact byte copy(ies)");
        if (groups.sameJson) grpStr.push(groups.sameJson + " same-JSON copy(ies)");
        if (groups.sameUuidDiffContent) grpStr.push(groups.sameUuidDiffContent + " same-UUID different-content");
        if (groups.sameWorkflow) grpStr.push(groups.sameWorkflow + " same-workflow file(s)");
        const summary = st.summary;
        const sumStr = summary
            ? inspRow("Library", `${summary.files} file(s) · ${summary.errors} bad JSON · ${summary.exactCopyGroups} exact-copy group(s) · ${summary.sameUuidDiffContent} same-UUID/diff group(s) · ${summary.noUuidFiles} without UUID`,
                "The library summary (plan 12)")
            : "";
        body = inspRow("UUID", uuid, "The ComfyUI workflow UUID - files sharing it form ONE process") +
            inspRow("Path", esc(d.name || "") + ` <span class="hub-wf-snap">${esc(d.path || "")}</span>`) +
            inspRow("Nodes", String(d.nodeCount ?? "?")) +
            inspRow("Params", paramStr, "Sampler/CFG/steps/resolution - only when they extract unambiguously") +
            inspRow("Node classes", types || `<span class="hub-wf-snap">Not detected</span>`) +
            inspRow("Models", models) +
            (grpStr.length ? inspRow("Duplicates", grpStr.join(" · ") || "none", "The duplicate/similarity groups this file belongs to") : "") +
            sumStr +
            `<div class="hub-wf-sect">Dependencies</div>` + depRows.join("") +
            (d.parseStatus && d.parseStatus !== "ok"
                ? `<div class="hub-wf-planwarn">⚠ This JSON ${d.parseStatus === "error" ? "failed to parse: " + esc(d.parseError || "") : "is too large for the analysis"}</div>` : "");
    }
    inspPop.innerHTML = `<div class="hub-menu-title">🔍 Workflow inspector</div>` +
        body +
        `<div class="hub-wf-planacts hub-wf-planacts-end"><button type="button" class="hub-wf-act" data-iact="iclose">✕ Close</button></div>`;
    // v113: the content size changed (loading -> the full report) -
    // re-clamp + re-place; the pop scrolls INSIDE its box (styles.css)
    placeHubPop(inspPop, inspState.anchor, { maxW: 520 });
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
        // v108 Files-tab file manager: state + the pure helpers for the tests
        filesState: () => ({
            sort: { ...filesSort }, view: filesView,
            favOnly: filesFavOnly, folder: filesFolder,
            quick: filesQuick, dateFrom: filesDateFrom, dateTo: filesDateTo,
            sizeMin: fileSizeMin, sizeMax: fileSizeMax,
            advOpen: filesAdvOpen, treeFolder: filesTreeFolder,
            treeExpanded: [...treeExpanded],
        }),
        filesFav: () => [...filesFav],
        filesFavsLoaded: () => filesFavsLoaded,
        fetchFileFavs,
        toggleFileFav,
        filteredSavedFiles,
        filesFolderList,
        buildFolderMap,
        shortPath,
        relWfPath,
        fmtSize,
        fmtDateTime,
        setFilesView: (v) => { filesView = v === "tree" ? "tree" : "list"; },
        setFilesSort: (k, d) => { filesSort = { key: k, dir: d === "asc" ? "asc" : "desc" }; },
        setFilesFilters: (patch = {}) => {
            if ("folder" in patch) filesFolder = patch.folder || "";
            if ("quick" in patch) filesQuick = patch.quick || "";
            if ("dateFrom" in patch) filesDateFrom = patch.dateFrom || "";
            if ("dateTo" in patch) filesDateTo = patch.dateTo || "";
            if ("sizeMin" in patch) fileSizeMin = patch.sizeMin ?? "";
            if ("sizeMax" in patch) fileSizeMax = patch.sizeMax ?? "";
            if ("favOnly" in patch) filesFavOnly = !!patch.favOnly;
            if ("treeFolder" in patch) filesTreeFolder = patch.treeFolder || "";
            if ("advOpen" in patch) filesAdvOpen = !!patch.advOpen;
        },
        toggleTreeFolder: (d) => { if (treeExpanded.has(d)) treeExpanded.delete(d); else treeExpanded.add(d); renderAll(); },
        enterTreeFolder: (d) => { filesTreeFolder = d || ""; renderAll(); },
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
        // v107: the server-side temp snapshot store (temp/<id>.json)
        saveTempSnapshot,
        fetchTempSnapshot,
        deleteTempSnapshot,
        gcTempSnapshots,
        setTempGcDone: (v) => { tempGcDone = !!v; },
        tempGcDone: () => tempGcDone,
        TEMP_MAX_AGE_MS,
        openPlanPop: (pid, anchor) => {
            const p = presets.find((x) => x.id === pid);
            if (p) openPlanPop(p, anchor || null);
        },
        planPop: () => planPop,
        closePlanPop,
        openWfSettingsPop: () => openWfSettingsPop(),
        wfPop: () => wfPop,
        closeWfPop,
        // v117: the owner's plan features (the groups, the Recently-closed
        // limit + Clear; the filesOpsState hook below carries the preview)
        groupsState: () => ({ ...groupsState,
            data: groupsState.data ? { ...groupsState.data } : null }),
        setGroupsState: (patch = {}) => {
            if ("on" in patch) groupsState.on = !!patch.on;
            if ("threshold" in patch) groupsState.threshold = patch.threshold;
            if ("kind" in patch) groupsState.kind = patch.kind;
            saveGroupsPrefs();
        },
        // v118: the tests drive the retry cadence (the production default
        // stays 3000ms)
        setGroupsRetryMs: (ms) => {
            const n = parseInt(ms, 10);
            if (n >= 10) groupsRetryMs = n;
        },
        groupsBusy: () => !!groupsState.busy,
        runGroups,
        setRecentLimit: (n) => setRecentLimit(n),
        recentLimit: () => recentLimit(),
        recentClearAll: () => recentClearAll(),
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
        // v112 (plan 3.x): the P0 helpers the new phases drive directly
        canonWfRel,
        sameWfPath,
        normWfPath,
        captureUndo,
        verifyActiveTab,
        sessionUndoState: () => sessionUndo,
        setSessionUndo: (v) => { sessionUndo = v; },
        filesLoadState: () => ({ seq: filesLoadSeq, pending: filesLoadPending,
            error: filesLoadError, truncated: filesTruncated,
            lastScan: filesLastScan, emptyStrikes: filesEmptyStrikes }),
        setFilesLoadState: (patch = {}) => {
            if ("pending" in patch) filesLoadPending = !!patch.pending;
            if ("error" in patch) filesLoadError = patch.error;
            if ("truncated" in patch) filesTruncated = !!patch.truncated;
            if ("lastScan" in patch) filesLastScan = patch.lastScan || 0;
        },
        buildTreeIndex,
        savedPathIndex,
        // v112 stage 2: the index engine hooks
        idxState: () => ({ ready: idxReady, stats: idxStats,
            scanBusy: idxScanBusy, serverList: JSON.parse(JSON.stringify(serverList)),
            uuid: filesUuid }),
        // v112 stage 5: the inspector hooks
        openInspPop: (p) => openInspPop(p),
        closeInspPop,
        inspState: () => inspState ? JSON.parse(JSON.stringify(inspState)) : null,
        inspPopEl: () => inspPop,
        // v112 stage 4: the preset versions panel hooks
        openPverPop: (pid) => openPverPop(pid),
        closePverPop,
        pverState: () => pverState ? JSON.parse(JSON.stringify(pverState)) : null,
        pverPopEl: () => pverPop,
        setPresetsCat: (v) => { presetsCat = v || ""; },
        setPresetsTag: (v) => { presetsTag = v || ""; },
        presetsFilters: () => ({ cat: presetsCat, tag: presetsTag, open: presetsFadvOpen }),
        // v112 stage 3: the duplicate detection + the snapshot toggle hooks
        canonJsonOf,
        stripPresentationOf,
        wfGraphHashClient,
        findSnapshotDuplicates,
        setSnapMode: (v) => { if (saveForm) saveForm.snapMode = !!v; },
        snapMode: () => !!saveForm?.snapMode,
        saveTabRow: (t) => saveTabRow(t),
        saveWorkflowTabAs: (t) => saveWorkflowTabAs(t),
        wfStoreSaveAsCandidate,
        setSaveFormRows: (rows) => { if (saveForm) saveForm.rows = rows; },
        // v112 stage 2.5: the history panel hooks
        openHistPop: (p) => openHistPop(p),
        closeHistPop,
        histState: () => histState
            ? JSON.parse(JSON.stringify({ ...histState, delSel: [...(histState.delSel || [])] }))
            : null,
        histPopEl: () => histPop,
        histCreateCheckpoint: (src) => histCreateCheckpoint(src),
        histRestore: (rid, confirmReplace) => histRestore(rid, confirmReplace),
        runHistCompare: () => runHistCompare(),
        refreshHistState: () => refreshHistState(),
        // v114: the version-cleanup + the row badge indicator hooks
        histDeleteSelected: () => histDeleteSelected(),
        histRevProtectReason: (r) => histRevProtectReason(r),
        histBadgeCount: (p) => histBadgeCount(p),
        histBadgesState: () => ({ map: histBadges.map ? { ...histBadges.map } : null, ts: histBadges.ts }),
        refreshHistBadges: (force) => refreshHistBadges(force),
        applyHistBadges: () => applyHistBadges(),
        setIdxReady: (v) => { idxReady = v; },
        runServerList: (reset) => runServerList(reset),
        ensureIndexStatus: () => ensureIndexStatus(),
        rebuildIndex: () => rebuildIndex(),
        // v116: the Refresh action + the Files batch delete/undo/select hooks
        refreshFilesFull: () => refreshFilesFull(),
        filesDeleteSelected: () => filesDeleteSelected(),
        filesUndoDelete: () => filesUndoDelete(),
        selectUuidFiles: (u) => selectUuidFiles(u),
        filesOpsState: () => ({ armed: fileOpsArmed, undo: fileOpsUndo,
            busy: fileOpsBusy, sel: [...fileSel],
            selOutside: filesSelOutsideCount(),
            confirm: fileOpsConfirm ? { paths: fileOpsConfirm.paths,
                totals: fileOpsConfirm.data?.totals,
                presets: fileOpsConfirm.data?.presetsAffected } : null }),
        setFileOpsUndo: (v) => { fileOpsUndo = v; },
        addFileSel: (paths) => { for (const p of (paths || [])) fileSel.add(normWfPath(p)); },
        histSearchNotes: () => histSearchNotes(),
        histOpenProcess: (pid) => histOpenProcess(pid),
        setFilesUuid: (v) => { filesUuid = v || ""; },
        recentServer: () => recentServer,
        loadRecentFromServer: () => loadRecentFromServer(),
        clientSessionId,
        serverState: () => serverState,
        undoRoute: "/settings_hub/workflows/undo",
        isOn: isWfOn,
        setOn: setWorkflowsOn,
        mount: initWorkflows,
        unmount: () => teardown(),
        // test determinism: freeze the 900ms poll so jsdom phases do not race
        stopPoll: () => { clearTimeout(pollT); clearInterval(pollT); pollT = null; },
        badgeState,
    };
}
