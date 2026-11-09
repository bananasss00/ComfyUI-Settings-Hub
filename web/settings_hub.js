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
console.info("[SettingsHub] web build: v95 - HUB RENAME POPUP ABOVE THE HUB WINDOW (owner follow-up 2026-11-10, 1 fix to v94): the rename popup (opened by the double-click on the window title OR the window's right-click Rename action) stacked BELOW the floating hub window itself - z-index 99920 vs the panel's 99990 - and it is anchored to the window's top-left corner, so whenever the two overlapped the window covered the input and the owner had to drag the hub aside to reach it; the popup now stacks at 100002 - above the hub window, the compare menu and every other hub floating layer (the v90 modal guard still hides it while a ComfyUI modal is open). v94 rides along: FIX 1 - the virtual hub RENAME now visibly APPLIES: Enter saved node.title all along, but the floating header painted its text only once at panel creation (renderHub rebuilds the hub root, never the pin panel) - the header refreshes in place on commit now; AND the double-tap rename really opens: the opener's stopPropagation kept the header drag handler from preventDefault()-ing the pointer, the browser fired the COMPATIBILITY mousedown for the same tap, and the popup's own outside-closed committed + closed it within one frame ('nothing happens') - the second tap now cancels the pointer AND the popup ignores its opening gesture for 500ms (a real outside click still commits); FIX 2 - the stack card action buttons (🔍 📌 ✎ ✕) were a VERTICAL column clipped by the card's overflow:hidden whenever the entry was short (a single-line text card is ~39px, the column ~73px) - the actions are a wrapping ROW now (grow sideways first, wrap downwards), right-aligned like before; FIX 3 - the one-shot runs list no longer accumulates the reasoning of SEVERAL runs into one giant 'history' block: renderRuns() preserves the live stream bubble while a run is up, but nobody removed it afterwards, so the NEXT run reset the paint state and APPENDED its thoughts/answer into the stale bubble (chat mode never saw this - its renderMsgs() wipes the list) - the bubble is dropped when a run starts and in the finally of every run; v93 (one-shot inference mode, taskbar drag, GPU-popup VRAM checkboxes, hub rename/RMB menu, DOM-widget drop target) rides along unchanged. Stale-cache guard: EXPECTED manifest verifies every module.");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=95", import.meta.url).href;
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
globalThis.__SettingsHubBuild = "v95";
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
        "launcher": "v93",        // v93 TASKBAR (drag from anywhere with a 5px click threshold)
        "stack": "v93",           // Paste Stack (+ v93 DOM-widget drop target + textarea highlight)
        "chat": "v94",            // LLM Chat (+ v94 one-shot stale stream-bubble fix)
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
