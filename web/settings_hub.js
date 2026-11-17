// ============================================================================
// SettingsHub - extension entry point (v35 loader)
// ----------------------------------------------------------------------------
// v35: this file is a LOADER, not a static importer. Field lesson from the
// v34 rollout: a stale cached module or a partially copied web/ folder kills
// the entire static import graph BEFORE the entry can log anything - the
// console stayed clean while the extension was completely dead. Now:
//   * the banner logs first, so entry freshness is always provable (F12);
//   * every submodule loads through its own try/catch - a failure names the
//     exact file and the error instead of dying silently;
//   * JS imports deliberately carry NO version query: submodules import
//     each other statically and a different specifier would create a SECOND
//     module instance (split state). styles.css has no such constraint.
// Loading this file via ComfyUI's WEB_DIRECTORY registers:
//   * the SettingsHub node type           (hub_node.js)
//   * the DOM UI renderer                 (hub_ui_renderer.js)
//   * the reactive two-way sync engine    (sync_manager.js + sync.js)
//   * the "📌 Pin to Settings Hub" menu   (context_menu.js)
//   * drag & drop reordering              (dnd_manager.js)
// ============================================================================

import { app } from "../../scripts/app.js";

// v30.3/v35: build banner - makes the running web build verifiable in F12
// (field debugging: "is the new file actually loaded?" stops being a guess;
// a stale cached module was a real suspect three times already).
console.info("[SettingsHub] web build: v115 - THE PROCESS CLEANUP + DUPLICATE COUNTER: the owner asked for two more things - (1) a button to delete the WHOLE processes with all their tails: the Process history panel got '🗑 Delete process' - the first click ARMS a confirm strip that names the exact scope (N version(s) + M file location(s)), the confirmed flow offers TWO scopes: '⚠ Delete EVERYTHING: versions + files' (every location's file is tx-safety-snapshotted server-side before the unlink, every per-file result is reported in the answer, and the derived-index rows of the deleted files are dropped too so the discovery reconcile cannot resurrect the erased process from a ghost row) or 'Versions only - keep the file(s)'; the WHOLE revision chain dies (stable/current included - the armed two-click confirm is the consent), the CAS blobs no other revision references are reclaimed for real bytes (the git backend keeps its immutable commit chain and reports zero freed bytes honestly), the panel closes and the rows/badges/lists refresh themselves; (2) a counter for the processes with the same ID: the ⧉ UUID chip on every Files row wears '×N' when several files share that ComfyUI UUID (they are locations of ONE process) - the SAME ONE /history/badges request feeds it (the answer carries 'locations: N' ONLY when N > 1 - a normal one-file process adds no bytes, while a revision-less duplicate still reports with count 0), the chips patch in place next to the version badges, the tooltip names 'N files share this UUID', and both chips vanish after the process deletion - v114: THE VERSION CLEANUP + INDICATOR: the owner asked for two things - (1) delete SPECIFIC process versions: the Process history panel got a manage mode (the 'Manage versions' button swaps the Compare radios for deletion checkboxes, the section header carries ONE DYNAMIC Select all / Deselect all button that flips its label, and 'Delete selected (N)' needs a second armed click), the stable + current versions are protected SERVER-side (the UI only grays them out with the reason on the tooltip, the server decides), a deleted revision is SPLICED out of the parent chain so the lineage stays linear, every skip is named in the answer, and the POST /history/revision/delete route does it all in one call; (2) an indication when a process has versions: the Files rows' 🕒 history button wears a small count chip (99+ capped) fed by ONE GET /history/badges request for the whole tab (processes without revisions contribute nothing - a small payload even with 2000+ processes), the already-rendered rows are patched in place, the tooltip names the count and the stable number, a 30s TTL keeps typing free of traffic, an old py without the route stays silent, and the chip updates itself after every checkpoint/delete - THE WORKFLOW MANAGER ROADMAP: the owner plan (Workflow_Manager_Agent_Plan.md) implemented end to end. P0: the preset switch now captures a FULL server-side undo snapshot (every temp + modified persisted tab graph included - the browser keeps only the undoId; a failed capture BLOCKS the destructive close with the exact reason), the command rungs VERIFY the active tab before a close/save (same-name tabs in different folders never die instead of the target), ONE canonical path normalizer rules every comparison (workflows/ prefix, slashes, dot segments; traversal refuses), the Files tab loads right at boot on the Files tab with explicit loading/empty/error/truncated states + a Refresh button + the last-scan time, the hard 400-row Open cap is GONE (chunks + Show more reach every tab, the search covers the full set), the recently-closed ring moved server-side (per-browser manifest records + a cross-browser reference union - one browser can never orphan another browser temp snapshot; the boot GC is a server route now), the folder tree and the preset missing-marks read one-pass cached indexes, the Files sort tie-break stays name-ascending in both directions. Stage 2: a DERIVED SQLITE INDEX of the library (workflows_manager/index/) - layered fingerprints (raw/canonical/workflow/presentation/extension/structural, a versioned normalization profile), FTS5 search over names/paths/UUIDs/node types/model refs/contents with a tested LIKE fallback, keyset-cursor pagination (the 6000-listing cap no longer masks the library), corrupt-DB quarantine + rebuild without touching a single workflow file, multi-user scoping. Stage 2.5: the PROCESS HISTORY - one shared Git bare repository (or a zlib-CAS fallback) per user scope with ONE history ref for ALL processes and preset histories, manual Checkpoints capturing the in-memory tab state, linear parent-linked revisions, Mark stable, Compare, Restore (a copy first; replacing a file takes a verified transaction safety snapshot + an atomic replace + rollback), duplicates dedupe by exact bytes, the ordinary ComfyUI Save creates NOTHING. Stage 3: a per-tab 💾 Save on every Open row (temp tabs run a feature-detected Save As ladder - a guessed command id is never executed), the 'Embed saved workflows as snapshots' toggle (default OFF) with origin metadata, the snapshot dedupe moved from the display name to the graph CONTENT (same-name different-graph coexists) + a stable itemId + activeItemId for snapshot items, the duplicate detection prompts Focus existing / Open another copy and warns on same-graph different-canvas. Stage 4: preset categories + tags (server-validated, searchable, ⚑-filterable) + a preset VERSION HISTORY (archive-before-change, restore archives the current first - always reversible, a 20-revision retention that never touches the current version). Stage 5: the workflow INSPECTOR (identity, nodes, models, parameters only when they extract unambiguously) + the DEPENDENCY CHECK (unknown nodes vs the installed registry, model files vs the models folders - diagnostics, never a blocker) + the library summary. v113: THE WORKFLOW MANAGER USABILITY FIXES: the owner hit three v112 defects - (1) the Files search lost focus after almost every keystroke and ComfyUI hotkeys fired while typing: renderAll now preserves the focused [data-wf] control with its EXACT caret across EVERY rebuild (the debounced server answer included - the v112 code restored focus only in the keystroke path), the index-mode search skips the per-keystroke full rebuild and the loading flash (ONE silent query, the answer re-renders once), every text field of the panel (searches, UUID filter, save form, date/size filters) and every popover input (the checkpoint 'What changed?' note, the name prompt, the import textarea, the storage folder) CONTAINS its keydown AND keyup - nothing leaks to ComfyUI's global keybinds anymore; Esc on the Files search re-queries the server too (the v112 Esc left the stale filtered rows visible). (2) the Process history / Workflow inspector / Preset history popovers opened HARDCODED at screen 16,16 - the far corner, often a monitor away from the panel - and had NO overflow rule: the inline max-height capped the box while the content kept painting past the window with no scrollbar; they now anchor NEXT TO the invoking row button (outside its left edge, the right edge as the fallback, viewport-clamped, centered without an anchor), re-place after every render, scroll INSIDE their box (a slim themed scrollbar, overscroll-behavior: contain, overflow-wrap for the long model paths) and the history panel's bottom actions merged into ONE row (the v112 ✎ Process + ✕ Close sat in two stacked strips and read as a column). (3) with a ~2000-process library the Process history took forever: the discovery reconcile was O(N²) file reads (_ensure_process scanned ALL process manifests once PER index row) and fsync-rewrote EVERY manifest on every pass, resolve_path_process re-read all manifests on every open and list_revisions re-read every revision manifest in the whole store - the catalog now lives in an in-memory cache (pid/uuid/path maps + a revision cache; lazily built in ONE pass, maintained by every mutation, listdir-signature guarded against external edits): a warm reconcile costs ZERO reads and ZERO writes per unchanged row, resolve is a dict lookup, get_process serves from the cache and never leaks its transient revisions list back into the stored manifest. v111: THE SMART QUEUE-START UNLOAD: the owner: 'выгружаются модели при каждом запуске очереди что не эффективно' when the chat is not used - the v92 hook fired a BLIND {action:'unload'} on EVERY execution_start (a 30 s cooldown was the only gate), so with the checkbox on an unused chat paid the full chain on every queue run (/v1/unload + the reserve release + the status refetch) and an off/unconfigured engine toasted a failure EVERY time; the hook now sends {action:'unload', auto:true} and the PROXY checks the engine status FIRST (GET /v1/status): no loaded model - or an unreachable/unconfigured engine, which cannot hold VRAM at all - answers {ok, skipped:true} and the WHOLE unload chain is skipped, the client stays SILENT (no toast noise per queue run); a loaded engine still unloads with its toast; the MANUAL ⚡ Unload model button keeps the force behavior; same principle as the v92 auto-free of ComfyUI models (unload only when something is actually loaded) - now on the LLM side of the same bargain. v110: THE INVISIBLE FILTER ROW + THE PRUNED SEARCH TREE: the owner reported 'где фильтры из плана? вижу только сортировки и туглер древовидной структуры' - the ★-only / ⚗ / Today-7d-30d chips had borrowed the .hub-wf-chip class, which in styles.css is the MINIMIZED-panel chip (position:fixed; display:none; z-index:99900), so the whole filter row rendered but sat hidden at the screen corner; the chips now wear their OWN .hub-wf-fchip class (a dashed border marks the filter buttons, the active one goes solid+bright) and ⚗ opens the advanced row exactly as the v108 plan promised (folder select over every nesting level, modified date from/until, size min-max in KB, ✕ clears everything). And 'когда включена древовидная структура в files надо чтобы не было пустых папок при поиске' - with an active search OR any filter (quick period, date range, size range, ★-only) the folder tree prunes every DEAD branch - a folder whose subtree holds no matching file disappears - and the per-folder counters read the FILTERED list (a count the visible rows cannot back up is impossible); without filters every real folder stays addressable. v109: REAL USERDATA ROOTS FOR THE FILES LIST: the owner hit a v108 regression ('менеджер процессов не видит процессов в пресетах и на вкладке files пусто') - ComfyUI nests the userdata users INSIDE the user directory (user_manager: 'default' unless multi-user, get_public_user_directory -> <user_dir>/<id>), so the real workflow library lives in <user_dir>/default/workflows, while the v108 py rung walked the flat <user_dir>/workflows and answered ok:true with an EMPTY list; as the client's rung 0 that empty 'success' masked the working legacy rungs - savedFiles went empty, the Files tab went blank and every preset path-item earned the red missing mark. BOTH sides fixed: the py /workflows/files walk now covers the REAL roots (the request's comfy-user folder for multi-user installs > 'default' > the legacy flat folder kept readable - anything saved into it in the v108 window must not vanish; the first root wins a relative-path clash, the storage-root presets/temp stay excluded) and the client only accepts a NON-EMPTY rung-0 answer - an empty ok:true falls through to the store/native rungs forever, so a wrong-layout listing can never blank the Files tab or the preset marks again. v108: FILES FILE MANAGER + UNIFIED STORAGE + CHAT MASS DELETE: the Workflows 'Files' tab became a file manager over the workflows/ folder - the new py /workflows/files route serves path+SIZE+MTIME (the storage-root presets/temp are excluded server-side - they never mix into the list), every row shows its relative path under the name (…-shortened, full path on hover) with the size and the last-modified date+time, the toolbar sorts by date/name/size with an asc/desc toggle, filters by folder (any nesting depth), by modified date (from/until) with the quick periods Today/7d/30d, by size range (KB) and by server-backed favorites (★ persists in workflows_favorites.json in the DEFAULT user dir - a root switch cannot hide it) with a ★-only chip; the ≡/🌲 view toggle switches the flat list to a folder tree with expand/collapse carets at any depth, click-to-enter navigation and breadcrumbs (back to ≡ restores the habitual view); a re-pointed storage root no longer HIDES anything - the presets/temp of the default location stay readable (the reads cover both roots, an id clash resolves to the active copy, writes go where the data already lives - no duplicates, no data loss). CHAT mass management: the 🕘 Saved-chats popup carries checkboxes, ONE dynamic Select all / Deselect all button (the save-form contract) and armed 🗑 Delete selected / 🗑 Delete all over the new POST /chat/sessions/delete ({ids} or {all:true} - one lock, blobs die with their session, open tabs close). v107: SERVER-SIDE TEMP SNAPSHOTS + STACK STORAGE TOGGLER: the reopen graphs of closed TEMP tabs moved OUT of localStorage (ComfyUI itself and the other extensions bloat the same origin quota - the owner asked 'надежно ли твое решение?') - the 🕘 ring keeps only the metadata, every closed temp tab uploads its graph to temp/<id>.json in a RESERVED subfolder of the workflows storage root (py v107 routes), the reopen fetches it back through the snapshot ladder (the v106 localStorage embed stays as the fallback for an old py), an entry leaving the ring deletes its file, a boot GC drops day-old orphans, the server keeps the 40 newest per root; the STACK header gained a 🌐/@wf STORAGE TOGGLER - the shared stack and the per-workflow store exist SIMULTANEOUSLY out of the box and the segments switch the active store with one click (the ⚙ 'Stack scope' select is GONE - the owner removed the setting). v106: SCROLL-STABLE CONFIRMS + SNAPSHOT REOPENS: the armed 🗑 delete (and every other same-tab re-render - the single ✕, Show more, search, Select/Deselect all) no longer jumps the list scroll to the top - renderAll keeps the .hub-wf-scroll anchor of the SAME tab; clicking a closed TEMP process in 🕘 Recently closed no longer 404s a /userdata fetch ('Unsaved Workflow (N).json' and the garbage '... (2).null' paths) - the close embeds a graph SNAPSHOT of the temp tab into its recent entry and the reopen restores it through the snapshot ladder (a modified saved tab embeds its unsaved state too); legacy '.null' garbage entries are pruned on boot. v105: CLOSE MENU + PRESETS AUTO-RETRY: the Open-tab mass close (Close saved / Close other saved / the new Close all with pinned 📌 staying) moved into ONE 🧹 Close ▾ dropdown - the row stays compact; a failed boot-time presets read now HEALS (retried on the poll tick + on every Presets-tab open, 'Reading presets…' instead of the misleading 'No presets yet' - presets appeared empty after a refresh until a save); the Presets status line names the live server pack ('srv vNNN') and the health probe compares it against this web build - an OLDER server = 'RESTART ComfyUI' (a page refresh only swaps the web half; the old py process kept saving the legacy presets.json), a NEWER one = 'hard refresh (Ctrl+F5)'. v104: WORKFLOWS STORAGE: ONE FILE PER PRESET - presets/<id>.json inside the storage root instead of the single presets.json array; copy one file to transfer that preset, temp snapshots stay INSIDE the preset file, the legacy presets.json is split by a one-time automatic migration (the original is kept as presets.json.bak). v103: the stack/chat resize grips wear the workflows marker; the Files 'Recently closed' group scrolls INSIDE its 30% cap; the save-form Select all / Deselect all toggle; the Open-tab multi-word filter. v102: the tab activation swaps the CANVAS via app.loadGraphData; snapshots of never-activated temp tabs save correctly; the ⚙ popup width cap; pinned status bar + Files search. v101: presets of open tabs (path items + snapshots of temp tabs), smart-diff ▶ Switch with a plan preview + ↩ Undo, ＋ Add, ↻ Update (overwrite/merge), protected bulk close with 📌 locks, 💾 Save all, 🕘 recent buffer, multi-word file search, export/import, the v84-mechanics storage folder. First run starts MINIMIZED into the taskbar. Stale-cache guard: EXPECTED manifest verifies every module.");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=115", import.meta.url).href;
    document.head.appendChild(link);
})();

// v82 SINGLE-SOURCE VERSION (docs/plan-versions.md): the stamp is set here,
// BEFORE any submodule import, and lives ONLY in this file (+ py + README
// badge). Submodules carry NO version literal - each self-reports the
// version of its LAST FUNCTIONAL CHANGE under globalThis.__SettingsHubLoaded
// and the EXPECTED manifest below verifies the table after the imports, so
// a half-updated module set (the browser serving a cached file next to fresh
// ones) still announces itself in F12 - with the stale files NAMED and both
// versions shown. Field lesson from the v63 rollout: "the fix did not work"
// was indistinguishable from "the fix never loaded" - the banner alone
// cannot prove the SUBMODULES are fresh.
// v66 FIELD LESSON (still in force): the v64 gate treated the mixed-build
// report as FATAL and skipped the registration entirely - after an update,
// ONE stale cached file silently removed every "Pin to Settings Hub" menu
// item and the sync hooks. The detector keeps its diagnostic value but is
// NO LONGER allowed to disable the pack.
globalThis.__SettingsHubBuild = "v115";
globalThis.__SettingsHubLoaded = {};

// Import order matters: core/sync first, then feature modules. A failure in
// one file is logged and does not prevent the rest from being attempted.
const FILES = [
    "./sync.js",            // internal bus (locks, rAF queue)
    "./core.js",            // v91 listed for the version manifest (same URL the
                            // feature modules import - one instance, verified)
    "./pins.js",            // badge counter cache
    "./nav_points.js",      // v61: nav points - resolver/jump/aim/markers/RMB
    "./hub_node.js",        // node registration + drawNode badge painter
    "./hub_ui_renderer.js", // DOM widget rendering
    "./sync_manager.js",    // target-widget callback hooks (reactive sync)
    "./launcher.js",        // v91: the MINI PANEL - chat/stack toggles + collapse target + ＋ hub
    "./stack.js",           // v70: Paste Stack - floating clipboard panel
    "./chat.js",            // v89: LLM Chat - named settings fields + ctx fill + chat search + own prompts path
    "./workflows.js",       // v107: Workflows Manager - server-side temp snapshots, storage toggler
    "./compare.js",         // v73: Image Compare - A/B wipe/fade/blink/diff panel
    "./context_menu.js",    // "📌 Pin to Settings Hub" menus + batch picker
];

// v35 CRITICAL: top-level await, NOT a fire-and-forget async IIFE. ComfyUI
// awaits `import(entry)` until the entry's EVALUATION completes; an IIFE
// would resolve that promise before any submodule registered itself and the
// whole pack would hook in after app.setup() - too late. TLA keeps the
// registration timing identical to the old static import graph.
{
    const mods = {};
    const failed = [];
    for (const f of FILES) {
        try {
            mods[f] = await import(f);
        } catch (err) {
            failed.push(f);
            console.error("[SettingsHub] FAILED to load " + f + " - the pack is PARTIAL; re-copy web/ and hard-refresh (Ctrl+F5). Error:", err);
        }
    }

    // v82 MIXED-BUILD CHECK (replaces the v67 missing-self-report scan): a
    // module that loaded but reports a DIFFERENT version than EXPECTED is a
    // browser-cached stale file; both sides are named. NON-FATAL (v67
    // fail-open): the pack registers whatever actually loaded.
    const EXPECTED = {
        "sync": "v71",            // internal bus
        "pins": "v70",            // badge counter cache
        "nav_points": "v69",      // nav points (zoom pinning)
        "hub_node": "v90",        // node registration + badge painter + phantom hiding (virtual hubs)
        "hub_ui_renderer": "v94", // DOM widget rendering (+ v94 rename commit refresh + popup grace)
        "sync_manager": "v70",    // reactive sync hooks
        "launcher": "v101",       // v101: the 4th taskbar item (workflows) + text+dot badges
        "stack": "v101",          // Paste Stack (+ v101: the header 🌐/@wf STORAGE TOGGLER - both stores exist at once, the ⚙ scope select is gone)
        "chat": "v111",           // LLM Chat (+ v111: the queue-start auto unload is SMART - the hook sends auto:true and the proxy checks the engine status first: no loaded model -> the whole /v1/unload + reserve-release chain is skipped and the client stays silent, an unused chat never touches the queue and a dead engine never toasts; the manual Unload button stays force)
        "workflows": "v115",     // Workflows Manager (+ v115: the process cleanup + duplicate counter - delete WHOLE processes with all tails (armed strip: EVERYTHING = versions + tx-snapshotted files + index-row drop, or versions only; CAS blob reclamation) and the ⧉-chip ×N counter for files sharing one UUID) (+ v114: the version-cleanup + indicator - delete SPECIFIC process versions (checkboxes + the dynamic Select all/Deselect all + the armed batch delete, stable+current protected server-side, the parent chain spliced) and the per-row version-count badge fed by ONE /history/badges request) (+ v113: usability fixes - focus-preserving search with contained keys, anchored scrolling popovers, the O(1) history catalog cache) (+ v112: the Workflow Manager roadmap - snapshot-based server Undo, ONE canonical path normalizer, cross-browser recently-closed ownership, the derived SQLite library index with layered fingerprints, the Process History in ONE shared Git/CAS store, per-tab Save, content-based snapshot dedupe + activeItemId, preset category/tags + version history, the workflow inspector + dependency checker)
        "compare": "v83",         // Image Compare A/B panel (v83 display fix)
        "context_menu": "v93",    // "Pin to Settings Hub" menus (+ v93 hub window RMB Rename/Materialize)
        "core": "v93",            // (+ v93 hub DOM resolver registry for the window menu)
    };
    const stale = [];
    for (const k of Object.keys(EXPECTED)) {
        if (!mods["./" + k + ".js"]) continue; // load failure - already reported above
        const got = globalThis.__SettingsHubLoaded?.[k];
        if (!got) stale.push(k + ".js (no self-report - pre-v67 stale cache)");
        else if (got !== EXPECTED[k]) stale.push(k + ".js (is " + got + ", pack expects " + EXPECTED[k] + ")");
    }
    if (stale.length) {
        console.error("[SettingsHub] MIXED BUILD detected: STALE CACHED module(s) " +
            stale.join(", ") +
            ". The pack still registers what loaded (fail-open), but a HARD REFRESH (Ctrl+F5) is required after updating the extension folder.");
    }

    // v66/v67 FAIL-OPEN registration, per module: menus first (the most visible
    // feature), then the reactive-sync hooks; each guarded independently so
    // one dead file cannot take the others down with it (v60 semantics plus
    // the v64 diagnostics).
    if (mods["./context_menu.js"]?.attachContextMenu) {
        try { mods["./context_menu.js"].attachContextMenu(); }
        catch (err) { console.error("[SettingsHub] attachContextMenu failed:", err); }
    } else {
        console.error("[SettingsHub] context_menu.js unavailable - 'Pin to Settings Hub' menus CANNOT register (see the failed list above if any).");
    }

    if (mods["./sync_manager.js"]?.syncAll) {
        app.registerExtension({
            name: "Comfy.SettingsHub.hooks",
            setup() {
                mods["./sync_manager.js"].syncAll();
            },
            afterConfigureGraph() {
                mods["./sync_manager.js"].syncAll();
            },
        });
    } else {
        console.error("[SettingsHub] sync_manager.js unavailable - reactive sync CANNOT register (see the failed list above if any).");
    }

    // v91: the MINI PANEL mounts in extension setup BEFORE the chat/stack
    // panels (they register their collapse hooks during their own init and
    // the launcher mirrors their state on its 800ms tick regardless of order).
    if (mods["./launcher.js"]?.initLauncher) {
        app.registerExtension({
            name: "Comfy.SettingsHub.launcher",
            setup() {
                try { mods["./launcher.js"].initLauncher(); }
                catch (err) { console.error("[SettingsHub] mini panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] launcher.js unavailable - the MINI PANEL CANNOT register (see the failed list above if any).");
    }

    // v70: the Paste Stack panel mounts in extension setup (AFTER the DOM is
    // ready, independent of any hub node). Fail-open like everything else: a
    // dead stack.js costs only the panel, never the menus or the sync.
    if (mods["./stack.js"]?.initStack) {
        app.registerExtension({
            name: "Comfy.SettingsHub.stack",
            setup() {
                try { mods["./stack.js"].initStack(); }
                catch (err) { console.error("[SettingsHub] stack panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] stack.js unavailable - the Paste Stack panel CANNOT register (see the failed list above if any).");
    }

    // v86: the LLM Chat panel mounts in extension setup like the stack - a
    // standalone floating window, independent of any hub node. Fail-open: a
    // dead chat.js costs only the chat panel.
    if (mods["./chat.js"]?.initChat) {
        app.registerExtension({
            name: "Comfy.SettingsHub.chat",
            setup() {
                try { mods["./chat.js"].initChat(); }
                catch (err) { console.error("[SettingsHub] chat panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] chat.js unavailable - the LLM Chat panel CANNOT register (see the failed list above if any).");
    }

    // v101: the WORKFLOWS MANAGER mounts in extension setup like the stack /
    // the chat - a standalone floating panel over the open workflow tabs.
    // Fail-open: a dead workflows.js costs only the new panel.
    if (mods["./workflows.js"]?.initWorkflows) {
        app.registerExtension({
            name: "Comfy.SettingsHub.workflows",
            setup() {
                try { mods["./workflows.js"].initWorkflows(); }
                catch (err) { console.error("[SettingsHub] workflows panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] workflows.js unavailable - the Workflows Manager CANNOT register (see the failed list above if any).");
    }

    // v73: Image Compare installs its context-menu + executed listeners in
    // extension setup; the panel itself is built lazily on the first
    // "Add to Compare". Fail-open like the stack.
    if (mods["./compare.js"]?.initCompare) {
        app.registerExtension({
            name: "Comfy.SettingsHub.compare",
            setup() {
                try { mods["./compare.js"].initCompare(); }
                catch (err) { console.error("[SettingsHub] compare init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] compare.js unavailable - Image Compare CANNOT register (see the failed list above if any).");
    }

    // v66: the degradation is made VISIBLE - the field report proved an
    // F12-only error never gets seen ("the menus just disappeared"). Inline
    // styles only: styles.css itself may be the stale file here.
    if (failed.length || stale.length) {
        try {
            const parts = [];
            if (failed.length) {
                parts.push("failed to load: " + failed.map((f) => f.replace(/^\.\//, "")).join(", "));
            }
            if (stale.length) {
                parts.push("stale cached: " + stale.join(", "));
            }
            const el = document.createElement("div");
            el.textContent = "⚠ SettingsHub build degraded - " + parts.join(" · ") +
                " - HARD-REFRESH the page (Ctrl+F5); until then some menus may be missing. Click to dismiss.";
            el.title = "Click to dismiss";
            Object.assign(el.style, {
                position: "fixed", left: "12px", bottom: "12px", zIndex: "999999",
                maxWidth: "560px", padding: "10px 14px", borderRadius: "8px",
                background: "#4a1f1f", color: "#ffd9d9", border: "1px solid #a5533f",
                font: "12px/1.45 system-ui, sans-serif", cursor: "pointer",
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)", userSelect: "none",
            });
            el.addEventListener("click", () => el.remove());
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 25000);
        } catch (_) { /* the banner is best-effort; registration is done */ }
    }
}

// ---------------------------------------------------------------------------
// v90 MODAL GUARD (owner: "when I open some ComfyUI windows, like the Comfy
// settings, my stacker, hub and chat are ON TOP of those windows, do not
// react to clicks and get in the way of interacting with the settings window
// or other ComfyUI windows").
//
// Our floating layers (hub pin panels, the stack, the chat, the compare
// panel, menus, popups, viewers, toasts) carry z-index 99900..2147483000 so
// they always win over the canvas - and that also made them win over
// ComfyUI's own modal dialogs (.comfy-modal z-index ~10000), visually
// covering them and catching the clicks meant for the dialog.
//
// The guard watches for a VISIBLE modal (a .comfy-modal with display other
// than none, or a native <dialog open>) and toggles body.sh-modal-open; the
// v90 block in styles.css makes every SettingsHub floating layer
// visibility:hidden + pointer-events:none while the class is set. visibility
// (not display) keeps the layout boxes intact, so the geometry/clamp code
// never reads zero rects, and everything returns the moment the dialog
// closes. Event-driven through a MutationObserver on <html> (modal dialogs
// show/hide via class/style attribute changes or body childList) plus a
// 400 ms interval fallback for frontends that toggle modals in ways no
// mutation catches. Our own popups are NOT .comfy-modal elements, so they
// never trigger the guard against themselves.
// ---------------------------------------------------------------------------
function installModalGuard() {
    let open = false;
    const visibleIn = (list) => {
        for (const el of list) {
            try {
                const cs = getComputedStyle(el);
                if (cs.display !== "none" && cs.visibility !== "hidden") return true;
            } catch (_) { /* a broken element must not kill the scan */ }
        }
        return false;
    };
    const scan = () => {
        let any = false;
        try {
            if (document.querySelector) {
                any = visibleIn(document.querySelectorAll(".comfy-modal")) ||
                    visibleIn(document.querySelectorAll("dialog[open]"));
            }
        } catch (_) {}
        if (any === open) return;
        open = any;
        try { document.body.classList.toggle("sh-modal-open", open); } catch (_) {}
    };
    try {
        if (typeof MutationObserver === "function") {
            const mo = new MutationObserver(scan);
            const arm = () => {
                try {
                    mo.observe(document.documentElement, {
                        attributes: true, childList: true, subtree: true,
                    });
                } catch (_) {}
            };
            if (document.documentElement) arm();
            else document.addEventListener("DOMContentLoaded", arm, { once: true });
        }
    } catch (_) {}
    setInterval(scan, 400);   // belt-and-braces fallback (cheap query)
    scan();
}
try { installModalGuard(); } catch (err) {
    console.warn("[SettingsHub] modal guard unavailable:", err);
}
