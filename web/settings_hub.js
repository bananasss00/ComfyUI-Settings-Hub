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
console.info("[SettingsHub] web build: v49 - z-index fix: the thumbnail picker and the hover preview popup were at z-index 10001 (below the pinned hub panel at 99990) so the panel covered them when the hub was pinned; bumped both to 100000 to match the rest of the project popups (.hub-menu / .hub-batch / .hub-toast). Plus: each picker cell now shows image/video resolution + megapixels (e.g. 1920x1080 · 2.07mpx) in a monospace dim line under the basename; detection is client-side (img.naturalWidth/Height after load, video.videoWidth/Height after loadedmetadata), no server-side probe dependency. Previous: v48 - media picker toolbar: Type segmented control (Auto / Image / Video / Audio / All, default Auto = the loader's expected kind) and Sort segmented control (Modified / Created / Name, default Modified newest-first); mediaFileList(item, tw, {kindFilter, sortMode}) filters and sorts unified (live combo ∪ recursive subdirs); per-cell kind detection so the 'All' view renders each cell with the right element; cycle arrows and the refreshValuesDom async recheck stay on Auto + Modified so they remain predictable; server adds mtime/ctime to every list_media entry. Previous: v47.1 - bugfix: media_list endpoint resolves the input folder through every folder_paths API shape (string and tuple entries, get_<type>_directory, raw folder_paths_and_paths map, <cwd>/type fallback) so /settings_hub/list_media returns the recursive file list instead of []; thumbnail picker grid pins row height via grid-auto-rows 110px + flex 0 0 60px on the img-box so lazy <img> decoding no longer collapses cells into horizontal lines; add ?verbose=1 to the endpoint to see the resolved dirs for diagnostics. Previous: v47 - media browser for source rows: (1) subdirectory visibility via /settings_hub/list_media (recursive os.walk of the input folder, 60s cache, union with the live combo); cycle arrows and the picker reach subdir files the flat combo doesn't surface; (2) hover the 40x30 thumb -> enlarged preview popup (img / video controls / audio + filename, body-level fixed, closes on mouseleave/scroll/Esc); (3) thumbnail picker replaces the text combo list for media rows - grid of lazy-loaded previews + basename + dimmed dirname, multi-token text search, click selects under the sync lock; subdir values no longer flagged missing");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=49", import.meta.url).href;
    document.head.appendChild(link);
})();

// Import order matters: core/sync first, then feature modules. A failure in
// one file is logged and does not prevent the rest from being attempted.
const FILES = [
    "./sync.js",            // internal bus (locks, rAF queue)
    "./pins.js",            // badge counter cache
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
