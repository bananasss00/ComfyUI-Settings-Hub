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
console.info("[SettingsHub] web build: v64 - FIX (round 2): a hub added from the Add-Node menu could still appear WITHOUT its UI on some frontends: the v63 one-shot repair ladder gave up before the frontend's reactive DOM-widget layer ever mounted the late-registered element. v64 enforces the INVARIANT instead of one timing: a visible, non-collapsed, non-pinned hub always ends up with its element connected - a longer repair ladder (250/700/1600/3000ms) plus a persistent DOM-truth repair in the 1200ms tab-watch sweep, plus a one-time workflow reconfigure (the same thing switching workflows away and back does) as the last resort ~6s after the add. v64 also stamps __SettingsHubBuild and requires a self-report flag from every module, so a browser that serves STALE cached modules now names them in F12 instead of reproducing fixed bugs");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=64", import.meta.url).href;
    document.head.appendChild(link);
})();

// v64 BUILD GUARD: stamped BEFORE any submodule import. Every submodule
// self-reports under globalThis.__SettingsHubLoaded[module] and verifies this
// stamp at load time, so a half-updated module set (the browser serving a
// cached v62/v63 file next to fresh ones) announces itself in F12 - with the
// stale files NAMED - instead of silently reproducing bugs that no longer
// exist in the source tree. Field lesson from the v63 rollout: "the fix did
// not work" was indistinguishable from "the fix never loaded" - the banner
// alone cannot prove the SUBMODULES are fresh.
globalThis.__SettingsHubBuild = "v64";
globalThis.__SettingsHubLoaded = {};

// Import order matters: core/sync first, then feature modules. A failure in
// one file is logged and does not prevent the rest from being attempted.
const FILES = [
    "./sync.js",            // internal bus (locks, rAF queue)
    "./pins.js",            // badge counter cache
    "./nav_points.js",      // v61: nav points - resolver/jump/aim/markers/RMB
    "./hub_node.js",        // node registration + drawNode badge painter
    "./hub_ui_renderer.js", // DOM widget rendering
    "./sync_manager.js",    // target-widget callback hooks (reactive sync)
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
    if (failed.length) {
        console.error("[SettingsHub] partial load:", FILES.length - failed.length, "of", FILES.length, "modules; not registering the sync hooks. Failed:", failed.join(", "));
    } else {
        // v64: name stale cached modules precisely - a fresh module sets its
        // flag; a stale cached file has no v64 code to run and stays silent.
        const missing = FILES
            .map((f) => f.replace(/^\.\//, "").replace(/\.js$/, ""))
            .filter((k) => !globalThis.__SettingsHubLoaded?.[k]);
        if (missing.length) {
            console.error("[SettingsHub] MIXED BUILD detected: STALE CACHED module(s) " +
                missing.map((k) => k + ".js").join(", ") +
                " did not self-report as v64. Hard-refresh the page (Ctrl+F5) after updating the extension folder.");
        } else {
            mods["./context_menu.js"].attachContextMenu();

            app.registerExtension({
                name: "Comfy.SettingsHub.hooks",
                setup() {
                    mods["./sync_manager.js"].syncAll();
                },
                afterConfigureGraph() {
                    mods["./sync_manager.js"].syncAll();
                },
            });
        }
    }
}
