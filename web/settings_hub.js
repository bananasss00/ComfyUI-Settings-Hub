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
console.info("[SettingsHub] web build: v119 - THE FLEXIBLE SIMILARITY GROUPS (nprof3): the owner's report - at the 80% threshold v117 found only ~10 groups, because the 'Similar' stage bucketed the candidates by the FULL node-type multiset hash (one added/removed node = a different hash = the pair was never scored); now the candidate pool is the UNION of the exact multiset bucket + the UNIQUE-set bucket + the RARE-TYPE pairs (a node type seen in few files ties its carriers; generic types never explode the pool), guarded by a zero-false-negative math prefilter (the size band + the types floor derived from the score weights) and an honest full-score pair budget (candidatePairs / pairsScored / skippedPairs in the answer); the wiring noise is INVISIBLE: a Reroute chain resolves THROUGH (A > Reroute > B contributes the direct edge A > B - inserting or deleting a reroute never changes the features) and Reroute/Note/MarkdownNote leave the types multiset and the widget signature; the per-type widget alignment is a greedy BEST-PAIR matching (one changed value can no longer reorder the sorted bucket and mismatch its peers); after the profile bump (nprof2 -> nprof3) the groups answer names the stale index (staleProfile + staleFiles) and the Files view shows a calm note instead of an empty grid - the boot scan re-indexes everything automatically; the modified copies now GROUP at the same threshold where v117 saw nothing. + v118 - THE VISIBLE ERRORS + THE HEALING EMBED SAVE + THE GROUPS BUSY RETRY: the owner hit three walls - (1) SAVE WITH THE EMBED TOGGLE DID NOTHING: the failure was REAL (a saved tab the frontend store never loaded - a background tab at boot has no activeState/content/graph - refused the whole save with a 'Could not serialize' error) but the toast NEVER SHOWED: the .hub-sh-note toast class had NO base CSS rule in styles.css at all (only the modal-guard override), so every named error rendered as an unstyled div at the end of <body> - below the fold, behind the ComfyUI canvas - and looked like 'nothing happens'; the base style now exists once for every module (chat/stack/launcher/compare/workflows), so EVERY error names itself; the save itself now HEALS: collectFormItems is async and for an unserializable UNMODIFIED saved tab tries the store's own loader (ref.load, the openStoreWorkflow precondition) and then the DISK TRUTH (GET /userdata/<path> - for an unmodified tab the file IS the content), only a genuinely unserializable tab still refuses and now the refusal is VISIBLE and names the tab; the busy unlock moved into finally (every path re-enables the buttons), the size preflight stays, and a transport 413 names itself ('Too large for the server (413)...') instead of a bare HTTP code; the py side raises the aiohttp transport body cap to 16 MB (many ComfyUI builds ship the default 1 MB client_max_size - a multi-workflow embed POST died at the transport layer BEFORE the route with a bare 413 HTML); (2) THE GROUPS 'DATABASE IS LOCKED': the REAL root was the index scan holding ONE write transaction for the whole pass (a single commit at the end) - the groups request's init_db DDL waited out busy_timeout (8 s), the error fell into the CORRUPT-DB QUARANTINE branch and RENAMED THE LIVE INDEX to .corrupt-* (the index was wiped until the next scan) - quarantine now fires only on real corruption (a locked/busy db never quarantines), the scan commits PER FILE (WAL + synchronous=NORMAL keeps it cheap) so the write txn never spans the pass, every read path (groups/duplicates/search/notes/status) answers {ok:false, busy:true} on a locked db, and the Files UI shows a calm 'Indexing in progress - the groups will appear as soon as the scan finishes' with an AUTOMATIC 3 s retry instead of the dead 'unavailable' note; (3) the toast CSS fix makes the whole pack's errors visible at once. + THE DELETE PLAN + GROUPS (the owner's four-part plan): (1) the Storage folder setting now speaks ONE short sentence and the technical details moved into a CLOSED 'Advanced details' block (the default/custom roots, the presets/<id>.json + temp/<id>.json layout, the service files in the default user dir, the Files exclusion - the mechanics unchanged); (2) THE DELETE PLAN: Files → Delete selected runs a SERVER PREVIEW first and the confirm strip names everything BEFORE the click - what dies, whose saved versions become unreachable and are deleted WITH the files (the Undo restores the .json files only, never the versions), which same-UUID copies stay byte-for-byte with their reachable history, and which presets point at the files (a preset is NEVER deleted with a file); a process that lost its LAST live file dies with it so the store keeps no invisible unreachable versions; the Process-history panel deletes ONLY the panel's current file ('Delete current file (and versions if no copies left)') - the dangerous UUID-wide deletion is retired - or erases the stored versions only ('Delete stored versions only - keep files'), plain language, no jargon; (3) the Recently-closed setting 5/10/15/20/30 per browser session applied IMMEDIATELY (the ring trims, the evicted snapshots free through the cross-browser reference union), the server temp eviction NEVER deletes a snapshot another session still references (MAX_TEMP_FILES 128), and the ✕ Clear button wipes THIS session's list with an armed confirm + an immediate empty manifest POST (workflow files, Presets, Favorites and the Process history are never touched); (4) the SIMILARITY GROUPS in Files (nprof2): a ◫ Group toggle (default off), the threshold 80-100% step 5 and the All / Same UUID / Exact copies / Similar filter - built SERVER-side over the WHOLE index (new GET /index/groups) from NEW SQLite signature columns (the id/revision-stripped graph hash recognizes the ComfyUI Duplicate as a 100% exact copy, the node-type MULTISET hash is the cheap candidate bucket, the normalized edges never carry node/link ids, the volatile widgets are masked), the deterministic weighted score (types 0.35 / edges 0.40 / widgets 0.15 / models 0.10) runs for CANDIDATES only against an ANCHOR (no chaining), the answer is cached in SQLite and invalidated by any re-index or profile change, the groups are collapsible with min/avg score, every row keeps every action, and NOTHING is ever merged, moved or deleted automatically. + THE QUALITY AND RELIABILITY PASS (the owner plan Workflow_Manager_Agent_Task.md, stages 0-6): (1) the SQLite scan is HONEST - a truncated walk (the 30k bound) or a walk with unreadable directories SKIPS the vanished-row prune entirely (unverified rows are never deleted - the v115 code could erase the tail of a big library), the pass reports prune_skipped/walk_errors/complete and the durable last_scan_complete flag makes index_status answer \u2018is the index actually current?\u2019 (the Files tab shows an \u2018index incomplete - rebuild\u2019 note instead of posing); (2) the Files REFRESH now does the real thing in index mode: ONE incremental scan (concurrent scans JOIN instead of failing) + the fresh status + the current query + the local mirror - the v112 button only re-read the legacy listing while the panel showed SQLite rows, so fresh files never appeared without a full Rebuild; (3) the CHANGES SINCE CHECKPOINT status is layered now - unchanged / Canvas changed only / Metadata changed / Workflow changed / Status unavailable (the v112 rawHash compare claimed a workflow change for a canvas move or a formatting-only save); (4) the UUID REBIND: a file whose content now carries another UUID leaves the old process (its history stays - orphaned but restorable) and joins the new one, ONE path binds to exactly ONE process per scope, the reconciliation covers the WHOLE index in batches (the v115 [:5000] cut is gone) with the first-root-wins rule for identical relative paths in different roots and a freshness guard so a brand-new checkpoint never loses its location to a stale index; (5) the RESTORE hardening: the revision must BELONG to the pid, the target must be a CURRENT location of the process, a missing/unreadable target refuses the replace (no empty-byte backups ever), the safety snapshot is VERIFIED (read-back SHA-256) before any write, the write is tmp+fsync+atomic os.replace with a rollback from the verified snapshot, and the derived index row refreshes in place; (6) the process DELETE preflight: EVERY location is snapshot-verified BEFORE the first unlink (a failure deletes NOTHING), a partial file failure KEEPS the process and its whole history, and the erasure runs only after the files are confirmed gone; (7) the Preset version payloads moved into the SHARED object store - one Git repository / CAS namespace for processes AND presets with content dedupe, the small manifests only reference the blob, the legacy embedded payloads migrate idempotently (byte length + SHA-256 verified before the manifest rewrite, a failure leaves the file untouched and retries); (8) COMPACT HISTORY: the preflight report (counts + sizes + free space), the new store built in a neighboring directory, EVERY retained blob read back and verified, fsck, then the atomic switch - never automatic, the ⚙ Storage dashboard button is the only entry; (9) the STORAGE DASHBOARD in the ⚙ popup: the measured physical bytes of the store/metadata/snapshots/index/service next to the logical payload sum, Analyze + Compact; (10) the NOTES SEARCH: process notes + version titles/notes live in a SQLite FTS table maintained by every mutation and rebuildable from the manifests - the search NEVER reads a Git blob (the history panel carries the search box, a result click loads that process); (11) the STRUCTURAL COMPARE: nodes added/removed/class-changed, per-widget old\u2192new previews, links, model references, the confirmed sampler/resolution params, a separate canvas-only group and an extension-metadata group; (12) the DEPENDENCY CHECKER now says \u2018missing\u2019 when the folder_paths API is alive and the model folders were really probed - \u2018unknown\u2019 only when the check is impossible; (13) the FILES batch DELETE (the owner cut: move/copy are NOT wanted) with verified per-file safety snapshots, per-file results, the process history NEVER deleted, a 2 h Undo that restores exact bytes into free paths only, and the \u29c9 UUID chip action Select all files with this UUID; (14) the benchmark defect is fixed - ONE global parent chain, fsck + reachability of EVERY revision before and after the repack, realistic anonymized JSON with the plan\u2019s scenarios - GIT PREFERRED confirmed on the corrected measurement. + v115: THE PROCESS CLEANUP + DUPLICATE COUNTER: the owner asked for two more things - (1) a button to delete the WHOLE processes with all their tails: the Process history panel got '🗑 Delete process' - the first click ARMS a confirm strip that names the exact scope (N version(s) + M file location(s)), the confirmed flow offers TWO scopes: '⚠ Delete EVERYTHING: versions + files' (every location's file is tx-safety-snapshotted server-side before the unlink, every per-file result is reported in the answer, and the derived-index rows of the deleted files are dropped too so the discovery reconcile cannot resurrect the erased process from a ghost row) or 'Versions only - keep the file(s)'; the WHOLE revision chain dies (stable/current included - the armed two-click confirm is the consent), the CAS blobs no other revision references are reclaimed for real bytes (the git backend keeps its immutable commit chain and reports zero freed bytes honestly), the panel closes and the rows/badges/lists refresh themselves; (2) a counter for the processes with the same ID: the ⧉ UUID chip on every Files row wears '×N' when several files share that ComfyUI UUID (they are locations of ONE process) - the SAME ONE /history/badges request feeds it (the answer carries 'locations: N' ONLY when N > 1 - a normal one-file process adds no bytes, while a revision-less duplicate still reports with count 0), the chips patch in place next to the version badges, the tooltip names 'N files share this UUID', and both chips vanish after the process deletion - v114: THE VERSION CLEANUP + INDICATOR: the owner asked for two things - (1) delete SPECIFIC process versions: the Process history panel got a manage mode (the 'Manage versions' button swaps the Compare radios for deletion checkboxes, the section header carries ONE DYNAMIC Select all / Deselect all button that flips its label, and 'Delete selected (N)' needs a second armed click), the stable + current versions are protected SERVER-side (the UI only grays them out with the reason on the tooltip, the server decides), a deleted revision is SPLICED out of the parent chain so the lineage stays linear, every skip is named in the answer, and the POST /history/revision/delete route does it all in one call; (2) an indication when a process has versions: the Files rows' 🕒 history button wears a small count chip (99+ capped) fed by ONE GET /history/badges request for the whole tab (processes without revisions contribute nothing - a small payload even with 2000+ processes), the already-rendered rows are patched in place, the tooltip names the count and the stable number, a 30s TTL keeps typing free of traffic, an old py without the route stays silent, and the chip updates itself after every checkpoint/delete - THE WORKFLOW MANAGER ROADMAP: the owner plan (Workflow_Manager_Agent_Plan.md) implemented end to end. P0: the preset switch now captures a FULL server-side undo snapshot (every temp + modified persisted tab graph included - the browser keeps only the undoId; a failed capture BLOCKS the destructive close with the exact reason), the command rungs VERIFY the active tab before a close/save (same-name tabs in different folders never die instead of the target), ONE canonical path normalizer rules every comparison (workflows/ prefix, slashes, dot segments; traversal refuses), the Files tab loads right at boot on the Files tab with explicit loading/empty/error/truncated states + a Refresh button + the last-scan time, the hard 400-row Open cap is GONE (chunks + Show more reach every tab, the search covers the full set), the recently-closed ring moved server-side (per-browser manifest records + a cross-browser reference union - one browser can never orphan another browser temp snapshot; the boot GC is a server route now), the folder tree and the preset missing-marks read one-pass cached indexes, the Files sort tie-break stays name-ascending in both directions. Stage 2: a DERIVED SQLITE INDEX of the library (workflows_manager/index/) - layered fingerprints (raw/canonical/workflow/presentation/extension/structural, a versioned normalization profile), FTS5 search over names/paths/UUIDs/node types/model refs/contents with a tested LIKE fallback, keyset-cursor pagination (the 6000-listing cap no longer masks the library), corrupt-DB quarantine + rebuild without touching a single workflow file, multi-user scoping. Stage 2.5: the PROCESS HISTORY - one shared Git bare repository (or a zlib-CAS fallback) per user scope with ONE history ref for ALL processes and preset histories, manual Checkpoints capturing the in-memory tab state, linear parent-linked revisions, Mark stable, Compare, Restore (a copy first; replacing a file takes a verified transaction safety snapshot + an atomic replace + rollback), duplicates dedupe by exact bytes, the ordinary ComfyUI Save creates NOTHING. Stage 3: a per-tab 💾 Save on every Open row (temp tabs run a feature-detected Save As ladder - a guessed command id is never executed), the 'Embed saved workflows as snapshots' toggle (default OFF) with origin metadata, the snapshot dedupe moved from the display name to the graph CONTENT (same-name different-graph coexists) + a stable itemId + activeItemId for snapshot items, the duplicate detection prompts Focus existing / Open another copy and warns on same-graph different-canvas. Stage 4: preset categories + tags (server-validated, searchable, ⚑-filterable) + a preset VERSION HISTORY (archive-before-change, restore archives the current first - always reversible, a 20-revision retention that never touches the current version). Stage 5: the workflow INSPECTOR (identity, nodes, models, parameters only when they extract unambiguously) + the DEPENDENCY CHECK (unknown nodes vs the installed registry, model files vs the models folders - diagnostics, never a blocker) + the library summary. v113: THE WORKFLOW MANAGER USABILITY FIXES: the owner hit three v112 defects - (1) the Files search lost focus after almost every keystroke and ComfyUI hotkeys fired while typing: renderAll now preserves the focused [data-wf] control with its EXACT caret across EVERY rebuild (the debounced server answer included - the v112 code restored focus only in the keystroke path), the index-mode search skips the per-keystroke full rebuild and the loading flash (ONE silent query, the answer re-renders once), every text field of the panel (searches, UUID filter, save form, date/size filters) and every popover input (the checkpoint 'What changed?' note, the name prompt, the import textarea, the storage folder) CONTAINS its keydown AND keyup - nothing leaks to ComfyUI's global keybinds anymore; Esc on the Files search re-queries the server too (the v112 Esc left the stale filtered rows visible). (2) the Process history / Workflow inspector / Preset history popovers opened HARDCODED at screen 16,16 - the far corner, often a monitor away from the panel - and had NO overflow rule: the inline max-height capped the box while the content kept painting past the window with no scrollbar; they now anchor NEXT TO the invoking row button (outside its left edge, the right edge as the fallback, viewport-clamped, centered without an anchor), re-place after every render, scroll INSIDE their box (a slim themed scrollbar, overscroll-behavior: contain, overflow-wrap for the long model paths) and the history panel's bottom actions merged into ONE row (the v112 ✎ Process + ✕ Close sat in two stacked strips and read as a column). (3) with a ~2000-process library the Process history took forever: the discovery reconcile was O(N²) file reads (_ensure_process scanned ALL process manifests once PER index row) and fsync-rewrote EVERY manifest on every pass, resolve_path_process re-read all manifests on every open and list_revisions re-read every revision manifest in the whole store - the catalog now lives in an in-memory cache (pid/uuid/path maps + a revision cache; lazily built in ONE pass, maintained by every mutation, listdir-signature guarded against external edits): a warm reconcile costs ZERO reads and ZERO writes per unchanged row, resolve is a dict lookup, get_process serves from the cache and never leaks its transient revisions list back into the stored manifest. v111: THE SMART QUEUE-START UNLOAD: the owner: 'выгружаются модели при каждом запуске очереди что не эффективно' when the chat is not used - the v92 hook fired a BLIND {action:'unload'} on EVERY execution_start (a 30 s cooldown was the only gate), so with the checkbox on an unused chat paid the full chain on every queue run (/v1/unload + the reserve release + the status refetch) and an off/unconfigured engine toasted a failure EVERY time; the hook now sends {action:'unload', auto:true} and the PROXY checks the engine status FIRST (GET /v1/status): no loaded model - or an unreachable/unconfigured engine, which cannot hold VRAM at all - answers {ok, skipped:true} and the WHOLE unload chain is skipped, the client stays SILENT (no toast noise per queue run); a loaded engine still unloads with its toast; the MANUAL ⚡ Unload model button keeps the force behavior; same principle as the v92 auto-free of ComfyUI models (unload only when something is actually loaded) - now on the LLM side of the same bargain. v110: THE INVISIBLE FILTER ROW + THE PRUNED SEARCH TREE: the owner reported 'где фильтры из плана? вижу только сортировки и туглер древовидной структуры' - the ★-only / ⚗ / Today-7d-30d chips had borrowed the .hub-wf-chip class, which in styles.css is the MINIMIZED-panel chip (position:fixed; display:none; z-index:99900), so the whole filter row rendered but sat hidden at the screen corner; the chips now wear their OWN .hub-wf-fchip class (a dashed border marks the filter buttons, the active one goes solid+bright) and ⚗ opens the advanced row exactly as the v108 plan promised (folder select over every nesting level, modified date from/until, size min-max in KB, ✕ clears everything). And 'когда включена древовидная структура в files надо чтобы не было пустых папок при поиске' - with an active search OR any filter (quick period, date range, size range, ★-only) the folder tree prunes every DEAD branch - a folder whose subtree holds no matching file disappears - and the per-folder counters read the FILTERED list (a count the visible rows cannot back up is impossible); without filters every real folder stays addressable. v109: REAL USERDATA ROOTS FOR THE FILES LIST: the owner hit a v108 regression ('менеджер процессов не видит процессов в пресетах и на вкладке files пусто') - ComfyUI nests the userdata users INSIDE the user directory (user_manager: 'default' unless multi-user, get_public_user_directory -> <user_dir>/<id>), so the real workflow library lives in <user_dir>/default/workflows, while the v108 py rung walked the flat <user_dir>/workflows and answered ok:true with an EMPTY list; as the client's rung 0 that empty 'success' masked the working legacy rungs - savedFiles went empty, the Files tab went blank and every preset path-item earned the red missing mark. BOTH sides fixed: the py /workflows/files walk now covers the REAL roots (the request's comfy-user folder for multi-user installs > 'default' > the legacy flat folder kept readable - anything saved into it in the v108 window must not vanish; the first root wins a relative-path clash, the storage-root presets/temp stay excluded) and the client only accepts a NON-EMPTY rung-0 answer - an empty ok:true falls through to the store/native rungs forever, so a wrong-layout listing can never blank the Files tab or the preset marks again. v108: FILES FILE MANAGER + UNIFIED STORAGE + CHAT MASS DELETE: the Workflows 'Files' tab became a file manager over the workflows/ folder - the new py /workflows/files route serves path+SIZE+MTIME (the storage-root presets/temp are excluded server-side - they never mix into the list), every row shows its relative path under the name (…-shortened, full path on hover) with the size and the last-modified date+time, the toolbar sorts by date/name/size with an asc/desc toggle, filters by folder (any nesting depth), by modified date (from/until) with the quick periods Today/7d/30d, by size range (KB) and by server-backed favorites (★ persists in workflows_favorites.json in the DEFAULT user dir - a root switch cannot hide it) with a ★-only chip; the ≡/🌲 view toggle switches the flat list to a folder tree with expand/collapse carets at any depth, click-to-enter navigation and breadcrumbs (back to ≡ restores the habitual view); a re-pointed storage root no longer HIDES anything - the presets/temp of the default location stay readable (the reads cover both roots, an id clash resolves to the active copy, writes go where the data already lives - no duplicates, no data loss). CHAT mass management: the 🕘 Saved-chats popup carries checkboxes, ONE dynamic Select all / Deselect all button (the save-form contract) and armed 🗑 Delete selected / 🗑 Delete all over the new POST /chat/sessions/delete ({ids} or {all:true} - one lock, blobs die with their session, open tabs close). v107: SERVER-SIDE TEMP SNAPSHOTS + STACK STORAGE TOGGLER: the reopen graphs of closed TEMP tabs moved OUT of localStorage (ComfyUI itself and the other extensions bloat the same origin quota - the owner asked 'надежно ли твое решение?') - the 🕘 ring keeps only the metadata, every closed temp tab uploads its graph to temp/<id>.json in a RESERVED subfolder of the workflows storage root (py v107 routes), the reopen fetches it back through the snapshot ladder (the v106 localStorage embed stays as the fallback for an old py), an entry leaving the ring deletes its file, a boot GC drops day-old orphans, the server keeps the 40 newest per root; the STACK header gained a 🌐/@wf STORAGE TOGGLER - the shared stack and the per-workflow store exist SIMULTANEOUSLY out of the box and the segments switch the active store with one click (the ⚙ 'Stack scope' select is GONE - the owner removed the setting). v106: SCROLL-STABLE CONFIRMS + SNAPSHOT REOPENS: the armed 🗑 delete (and every other same-tab re-render - the single ✕, Show more, search, Select/Deselect all) no longer jumps the list scroll to the top - renderAll keeps the .hub-wf-scroll anchor of the SAME tab; clicking a closed TEMP process in 🕘 Recently closed no longer 404s a /userdata fetch ('Unsaved Workflow (N).json' and the garbage '... (2).null' paths) - the close embeds a graph SNAPSHOT of the temp tab into its recent entry and the reopen restores it through the snapshot ladder (a modified saved tab embeds its unsaved state too); legacy '.null' garbage entries are pruned on boot. v105: CLOSE MENU + PRESETS AUTO-RETRY: the Open-tab mass close (Close saved / Close other saved / the new Close all with pinned 📌 staying) moved into ONE 🧹 Close ▾ dropdown - the row stays compact; a failed boot-time presets read now HEALS (retried on the poll tick + on every Presets-tab open, 'Reading presets…' instead of the misleading 'No presets yet' - presets appeared empty after a refresh until a save); the Presets status line names the live server pack ('srv vNNN') and the health probe compares it against this web build - an OLDER server = 'RESTART ComfyUI' (a page refresh only swaps the web half; the old py process kept saving the legacy presets.json), a NEWER one = 'hard refresh (Ctrl+F5)'. v104: WORKFLOWS STORAGE: ONE FILE PER PRESET - presets/<id>.json inside the storage root instead of the single presets.json array; copy one file to transfer that preset, temp snapshots stay INSIDE the preset file, the legacy presets.json is split by a one-time automatic migration (the original is kept as presets.json.bak). v103: the stack/chat resize grips wear the workflows marker; the Files 'Recently closed' group scrolls INSIDE its 30% cap; the save-form Select all / Deselect all toggle; the Open-tab multi-word filter. v102: the tab activation swaps the CANVAS via app.loadGraphData; snapshots of never-activated temp tabs save correctly; the ⚙ popup width cap; pinned status bar + Files search. v101: presets of open tabs (path items + snapshots of temp tabs), smart-diff ▶ Switch with a plan preview + ↩ Undo, ＋ Add, ↻ Update (overwrite/merge), protected bulk close with 📌 locks, 💾 Save all, 🕘 recent buffer, multi-word file search, export/import, the v84-mechanics storage folder. First run starts MINIMIZED into the taskbar. Stale-cache guard: EXPECTED manifest verifies every module.");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=119", import.meta.url).href;
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
globalThis.__SettingsHubBuild = "v119";
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
        "workflows": "v119",     // Workflows Manager (+ v119: the FLEXIBLE similarity groups (nprof3) - the owner's report: at the 80% threshold v117 found only ~10 groups because the candidates bucketed by the FULL node-type multiset hash (one added/removed node = a different hash = never scored); now the candidates are the UNION of the multiset bucket + the unique-set bucket + the rare-type pairs with a zero-false-negative math prefilter (size band + types floor), the Reroute/Note wiring noise is INVISIBLE (the edges resolve THROUGH a reroute chain, notes leave the features), the per-type widget alignment is a greedy best-pair, the full-score runs stay inside an honest pair budget (pairsScored/skippedPairs), and after the profile bump the groups answer names the stale index (staleProfile) instead of an empty grid (+ v118: THE VISIBLE TOASTS + the embed save healing + the groups busy retry: (1) the Storage folder setting speaks ONE short sentence and hides the technical details in a CLOSED 'Advanced details' block (the roots, the presets/<id>.json + temp/<id>.json layout, the service files, the Files exclusion - the mechanics unchanged); (2) the DELETE plan: Files → Delete selected runs a SERVER PREVIEW first and the confirm strip names everything BEFORE the click - what dies, whose saved versions become unreachable and are deleted WITH the files (the Undo restores the .json files only, never the versions), which same-UUID copies stay byte-for-byte with their reachable history, and which presets point at the files (a preset is NEVER deleted with a file); a process that lost its LAST live file dies with it (no invisible unreachable versions in the store), the derived index rows + badges + lists refresh without a reload; the Process-history panel now deletes ONLY the panel's current file ('Delete current file (and versions if no copies left)') - the dangerous UUID-wide deletion is retired - or erases the stored versions only ('Delete stored versions only - keep files'), plain language, no jargon; (3) the Recently-closed setting: 5/10/15/20/30 items per browser session applied IMMEDIATELY (the ring trims and the evicted snapshots free through the cross-browser reference union), the server temp eviction NEVER deletes a snapshot another session still references, and the ✕ Clear button wipes THIS session's list with an armed confirm + an immediate empty manifest POST (files/presets/favorites/history untouched); (4) the SIMILARITY GROUPS in Files (nprof2): a ◫ Group toggle (default off), the threshold 80-100% step 5, the All/Same UUID/Exact copies/Similar filter - built SERVER-side over the WHOLE index (new GET /index/groups) from new SQLite signature columns (the id/revision-stripped graph hash recognizes the ComfyUI Duplicate as a 100% exact copy, the node-type MULTISET hash is the cheap candidate bucket, the normalized edges never carry node/link ids, the volatile widgets are masked), the deterministic weighted score (types 0.35 / edges 0.40 / widgets 0.15 / models 0.10) runs for CANDIDATES only against an ANCHOR (no chaining), the answer is cached in SQLite and invalidated by any re-index or profile change, groups are collapsible with min/avg score, every row keeps every action, and NOTHING is ever merged, moved or deleted automatically) (+ v116: the quality/reliability pass - the honest index scan, the real Files Refresh, the layered change status, the UUID rebind, the Restore hardening, the process-delete preflight, the shared object store for preset versions, Compact History, the storage dashboard, the notes search, the structural Compare, the dependency missing/unknown split, the Files batch DELETE + 2 h Undo (the owner cut: no move/copy), the corrected Git benchmark) (+ v115: the process cleanup + duplicate counter) (+ v114: the version cleanup + indicator) (+ v113: usability fixes) (+ v112: the Workflow Manager roadmap)
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
