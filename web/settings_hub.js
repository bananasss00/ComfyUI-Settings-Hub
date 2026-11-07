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
console.info("[SettingsHub] web build: v75 - Paste Stack header cleanup (owner request): the [✕] close button is REMOVED from the panel header - only [–] (minimize to chip) and 🗑 (clear) remain; the panel is an always-there tool and is disabled ONLY via ⚙ Hub settings → Stack → Off (the pre-existing stackon switch, whose hint now explains this). Includes v74 (Paste Stack QA round: the list SCROLLS for real (min-height:0 + a styled always-visible scrollbar), a 🗑 CLEAR button lives in the panel header (double-click confirm; removed from the settings popup), stack cards drag onto REAL nodes for every kind (image -> LoadImage, video -> VHS/native LoadVideo via options.video_upload, audio -> LoadAudio via options.audio_upload, all uploaded through /upload/image - ComfyUI has no /upload/audio), TEXT cards drop onto prompt nodes and write the string widget under the cursor, the inline rename/tags editor commits on Enter (Esc cancels), and a focused input (even inside the panel) wins Ctrl+V over capture; the eye toggle now also hides the nav authoring buttons (AGENTS.md 5.1)). Includes v73 (IMAGE COMPARE: right-click a media row/gallery thumbnail/stack image card -> Add to Compare, a floating A/B panel with WIPE/FADE/BLINK/DIFF modes + gain, A/B swap, auto-refresh on executed), v72 (Paste Stack snippets: pins/rename/tags/search/kind filters/usage counter/into-the-string insert), v71 (files & drag + OS-clipboard helper + drag-to-Load-Image), v70 (Paste Stack standalone floating panel with server-side storage), v69 (nav points pin the CURRENT canvas zoom on create), v68 (hotkey capture fix), v67 (per-point hotkeys), v66 (fail-open registration), v65 (top-left jump anchor), v64 (fresh-add mount invariant)");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=75", import.meta.url).href;
    document.head.appendChild(link);
})();

// v67 BUILD GUARD: stamped BEFORE any submodule import. Every submodule
// self-reports under globalThis.__SettingsHubLoaded[module] and verifies this
// stamp at load time, so a half-updated module set (the browser serving a
// cached v62/v63 file next to fresh ones) announces itself in F12 - with the
// stale files NAMED - instead of silently reproducing bugs that no longer
// exist in the source tree. Field lesson from the v63 rollout: "the fix did
// not work" was indistinguishable from "the fix never loaded" - the banner
// alone cannot prove the SUBMODULES are fresh.
// v66 FIELD LESSON: the v64 gate treated the mixed-build report as FATAL and
// skipped the registration entirely - after an update, ONE stale cached file
// silently removed every "Pin to Settings Hub" menu item and the sync hooks
// (the user saw the menus vanish and had no idea why). The detector keeps its
// diagnostic value but is NO LONGER allowed to disable the pack.
globalThis.__SettingsHubBuild = "v75";
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
    "./stack.js",           // v70: Paste Stack - floating clipboard panel
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

    // v64 diagnostic, v66 NON-FATAL: a LOADED module that did not self-report
    // is a stale cached file (its old code has no flag line). We still name
    // the files, but the pack registers whatever actually loaded - a cache
    // detector must not take working menus hostage.
    const keyOf = (f) => f.replace(/^\.\//, "").replace(/\.js$/, "");
    const missing = FILES
        .filter((f) => mods[f])
        .map(keyOf)
        .filter((k) => !globalThis.__SettingsHubLoaded?.[k]);
    if (missing.length) {
        console.error("[SettingsHub] MIXED BUILD detected: STALE CACHED module(s) " +
            missing.map((k) => k + ".js").join(", ") +
            " did not self-report as v74. The pack still registers what loaded (v67 fail-open), but a HARD REFRESH (Ctrl+F5) is required after updating the extension folder.");
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
    if (failed.length || missing.length) {
        try {
            const parts = [];
            if (failed.length) {
                parts.push("failed to load: " + failed.map((f) => f.replace(/^\.\//, "")).join(", "));
            }
            if (missing.length) {
                parts.push("stale cached: " + missing.map((k) => k + ".js").join(", "));
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
