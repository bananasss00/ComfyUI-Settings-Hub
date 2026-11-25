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
console.info("[SettingsHub] web build: v130 - SAVE/RENAME/TRANSFER POPUP FIXES (the owner's five bug reports): (1) the dst DIALECT - the client speaks the REL path ('sub/name.json' under the standard root, '.settings_hub_ext/<id>/...' for the ext) so a move NEVER lands in workflows/workflows/ and the ext namespace stays the FIRST rel segment (the py also un-aliases a full virtual ext dst); (2) the popover checkboxes TOGGLE on click (the blanket click preventDefault froze them all); (3) the temp memory rename flips the STORE RECORD's both name fields (filename+name) and the adoption guards ride BOTH keys; (4) the moved tabs rebind IN PLACE (ref.path + the names mutate on the store record - no loadGraphData/close dance, a tab NEVER closes, the picker shows the real storage); (5) the MULTI-WORD folder search over the subfolder chips (every word must hit, from 9+ chips) + the v129 SAVE AS / RENAME / TRANSFER ACROSS STORAGES (the owner's plan, \u00a71-\u00a76): the Workflows Manager gets ITS OWN save/rename layer over every storage - the manager popover opens ALWAYS (never an automatic bypass into Comfy.SaveWorkflowAs; the native dialog stays a secondary link inside the popover). \u2956 SAVE/SAVE-AS: the \ud83d\udcbe+ button (\u2937 on a temp) opens \"Save workflow to...\" with the STORAGE PICKER (Standard workflows/ + every \u2b21 registered external folder, missing \u26a0 / read-only \ud83d\udd12 marked and refused), the relative path WITH subfolder structure (folder/sub/name, .json auto-appended), the SUBFOLDER CHIPS (the existing folders of the picked storage via the new GET /files/subdirs + /ext/subdirs routes, EMPTY folders included, + the recent targets in localStorage), the Save-As options (Switch this tab to the new file - default ON; New workflow ID (independent history) - default OFF; a temp tab ALWAYS keeps its graph.id so the v122 pre-save checkpoints rebind to the created file), and the honest 409 CONFLICT block (an existence probe BEFORE the write + Overwrite / Save as name (2).json; inside the ext namespace the v125 hook force-flips overwrite=false so the probe is the only conflict window there). \u2956 RENAME/MOVE (\u270e): persisted tabs + Files rows go through ONE server call (POST /settings_hub/workflows/files/rename - name + subfolders + storage in one step, 409 on a conflict), the open tabs rebind client-side (the unsaved edits survive - loadGraphData with the tab's own in-memory graph, the old ref closes WITHOUT the Recently-closed record); the \u2605 favorites, the SQLite index (forget+point-refresh), the process-history locations (detach + reconcile-cache reset) follow the file SERVER-side; a TEMP tab works in TWO modes - a name-only rename stays IN MEMORY (ref.path flips, the tab stays temp, renamedTempKeys+adoptChecked guard it from the adoption rungs) while a path with folders or a picked storage becomes \"Save & Rename\" (the file is written, the tab turns persisted). \u2956 BATCH TRANSFER: the Files selection toolbar gains \ud83d\udce5 Copy to... / \ud83d\udce6 Move to... (POST /files/transfer, onConflict skip/overwrite/auto, Keep subfolder structure, per-item results in the popover); \u2956 a fresh NATIVE save becomes searchable immediately (POST /index/refresh; the ext writes re-index themselves inside ext_store). py v129 = the four new routes + the favorites/index/history/tx side-effects; the v124-v128 feature set rides unchanged - worklog v129 has the full contract - COMMIT MESSAGE RULE AND THE WORKLOG RULE APPLY");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=130", import.meta.url).href;
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
globalThis.__SettingsHubBuild = "v130";
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
        "workflows": "v130",     // Workflows Manager (+ v130: THE DST DIALECT + THE POPUP FIXES - the client speaks the REL dst ('sub/name.json' standard, '.settings_hub_ext/<id>/...' ext; no more workflows/workflows/, no more 'addressable only as the first segment'), the popover checkboxes toggle (the blanket preventDefault froze them), the temp memory rename flips the store record's BOTH name fields + the adoption guards ride both keys, the moved tabs rebind IN PLACE (a tab never closes, the picker derives the real storage), the multi-word folder search over the subfolder chips (from 9+ chips, Enter accepts the first match) (+ v129: SAVE AS / RENAME / TRANSFER ACROSS STORAGES - the manager save/save-as popover (the storage picker Standard + every ext folder, the relative path with the subfolder structure, the subfolder chips incl. empty dirs + the recent targets, the options Switch-tab / New-ID, the honest 409 conflict block Overwrite / name (2).json); the ✎ rename/move for persisted tabs + Files rows + the TWO-MODE temp rename (in-memory vs Save & Rename with the kept graph.id); the batch 📥 Copy to… / 📦 Move to… (keep-structure + onConflict skip/overwrite/auto + per-item results); the py routes /files/rename, /files/transfer, /files/subdirs, /ext/subdirs, /index/refresh with the favorites/index/history/tx side-effects (+ v128: THE RESTORE SEMANTICS - the Process-history ↺ Restore restores the ACTIVE state of the process: the first click only ARMS (a confirm strip names the target version + warns about unsaved changes; Cancel disarms; NOTHING opens, NOTHING is written), the second click writes the version's bytes back to the real file (the hardened server replace) AND swaps the open tab's canvas IN PLACE (loadGraphData with the tab's OWN store ref - the same tab, never a temp fork; the live getOpenWorkflows lookup); the history stays EXACTLY as is (no revision created/deleted, the current pointer never moves - py-tested), opening a COPY remains the commit-name click (histopen) (+ v123: OPEN ONLY THE SELECTED TABS OF A PRESET - the ▶ Switch plan popover and the ＋ Add button carry a TAB CHECKLIST (uncheck = not opened; an unchecked item's open tab retires, 📌/Keep-unsaved still protect; the active-tab focus skips when the active item is unchecked; buildApplyPlan onlyIdx is the shared engine) (+ v121: THE CONNECTED SIMILARITY CLUSTERS + the honest non-.json accounting - the Files listings carry ONLY .json (the same rule the index applies; the native /userdata rung used to surface .py/.bak), the walk counts what it saw and skips (non_json in the scan stats + /index/status + the status bars), a DB SELECT proves zero non-.json rows; the Similar kind filter is SOFT (the Same-UUID/Exact groups travel in the answer, badged shown-for-context - the version families share a workflow_id and the hard filter hid exactly the biggest groups); the candidates gain the FILENAME-STEM seed (version tokens/the (2) suffix/copy words/trailing numbers strip, separators collapse) + the MODEL-SET seed, rare_max derives from the LARGEST ALREADY-VISIBLE family with a min(N,30) floor and the cap 60->400 (the v119 formula collapsed to 8 on a small folder while the signature nodes sat at df 8-11); the DEFAULT THRESHOLD is 60 (was 90; the persisted legacy default migrates once) and the clustering is UNION-FIND over every scored candidate edge >= threshold (connected components - the anchor-star no-chaining capped a long version line to groups of 3, the JOIN pass is retired, the formula/weights untouched, SIM_SCORE_VERSION s2->s3 invalidates the cached answers WITHOUT a re-index, the profile stays nprof3); acceptance on an owner-shaped library: 6 named version families -> ONE group per family at 60, true singletons ungrouped, nothing glues (+ v120: the LOOSE similarity match - the owner's report: at the minimal threshold only ~24 small groups + one 30-file group and ~845 files 'unaccounted'; (1) the score formula is now the (jaccard + overlap) BLEND for types/edges/models - an ADDED or REMOVED node group costs far less (the overlap half stays 1.0 on a subset/superset pair) while a switched link still costs through the jaccard half; (2) the JOIN pass: a modified copy of a modified copy joins an EXISTING group through one of its MEMBERS (the anchor-only rule left such chains ungrouped) - bounded by its own budget + member cap, reported honestly (joinScored/joinSkipped); (3) the OVERSIZED candidate buckets are no longer skipped silently - sub-bucketed by the MODEL SET + a bounded per-file top-K star (broadStarFiles); (4) the threshold accepts 50-100 (50/60/70 added); (5) the ACCOUNTING: the answer carries kindCounts, the Files view names the files hidden by the kind filter (844 files sat in Same-UUID/Exact groups - the 'Similar' filter hid them and the sums did not add up) and Outside-the-groups reads 'N of M indexed'; the cached answers invalidate through the new SIM_SCORE_VERSION cache-key part - the extracted features did not change, no re-index needed (+ v119: the FLEXIBLE similarity groups (nprof3) - the owner's report: at the 80% threshold v117 found only ~10 groups because the candidates bucketed by the FULL node-type multiset hash (one added/removed node = a different hash = never scored); now the candidates are the UNION of the multiset bucket + the unique-set bucket + the rare-type pairs with a zero-false-negative math prefilter (size band + types floor), the Reroute/Note wiring noise is INVISIBLE (the edges resolve THROUGH a reroute chain, notes leave the features), the per-type widget alignment is a greedy best-pair, the full-score runs stay inside an honest pair budget (pairsScored/skippedPairs), and after the profile bump the groups answer names the stale index (staleProfile) instead of an empty grid (+ v118: THE VISIBLE TOASTS + the embed save healing + the groups busy retry: (1) the Storage folder setting speaks ONE short sentence and hides the technical details in a CLOSED 'Advanced details' block (the roots, the presets/<id>.json + temp/<id>.json layout, the service files, the Files exclusion - the mechanics unchanged); (2) the DELETE plan: Files → Delete selected runs a SERVER PREVIEW first and the confirm strip names everything BEFORE the click - what dies, whose saved versions become unreachable and are deleted WITH the files (the Undo restores the .json files only, never the versions), which same-UUID copies stay byte-for-byte with their reachable history, and which presets point at the files (a preset is NEVER deleted with a file); a process that lost its LAST live file dies with it (no invisible unreachable versions in the store), the derived index rows + badges + lists refresh without a reload; the Process-history panel now deletes ONLY the panel's current file ('Delete current file (and versions if no copies left)') - the dangerous UUID-wide deletion is retired - or erases the stored versions only ('Delete stored versions only - keep files'), plain language, no jargon; (3) the Recently-closed setting: 5/10/15/20/30 items per browser session applied IMMEDIATELY (the ring trims and the evicted snapshots free through the cross-browser reference union), the server temp eviction NEVER deletes a snapshot another session still references, and the ✕ Clear button wipes THIS session's list with an armed confirm + an immediate empty manifest POST (files/presets/favorites/history untouched); (4) the SIMILARITY GROUPS in Files (nprof2): a ◫ Group toggle (default off), the threshold 80-100% step 5, the All/Same UUID/Exact copies/Similar filter - built SERVER-side over the WHOLE index (new GET /index/groups) from new SQLite signature columns (the id/revision-stripped graph hash recognizes the ComfyUI Duplicate as a 100% exact copy, the node-type MULTISET hash is the cheap candidate bucket, the normalized edges never carry node/link ids, the volatile widgets are masked), the deterministic weighted score (types 0.35 / edges 0.40 / widgets 0.15 / models 0.10) runs for CANDIDATES only against an ANCHOR (no chaining), the answer is cached in SQLite and invalidated by any re-index or profile change, groups are collapsible with min/avg score, every row keeps every action, and NOTHING is ever merged, moved or deleted automatically) (+ v116: the quality/reliability pass - the honest index scan, the real Files Refresh, the layered change status, the UUID rebind, the Restore hardening, the process-delete preflight, the shared object store for preset versions, Compact History, the storage dashboard, the notes search, the structural Compare, the dependency missing/unknown split, the Files batch DELETE + 2 h Undo (the owner cut: no move/copy), the corrected Git benchmark) (+ v115: the process cleanup + duplicate counter) (+ v114: the version cleanup + indicator) (+ v113: usability fixes) (+ v112: the Workflow Manager roadmap)
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
