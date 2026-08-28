// ============================================================================
// SettingsHub - extension entry point
// ----------------------------------------------------------------------------
// Import order matters: core/sync first, then feature modules.
// Loading this file via ComfyUI's WEB_DIRECTORY registers:
//   * the SettingsHub node type           (hub_node.js)
//   * the DOM UI renderer                 (hub_ui_renderer.js)
//   * the reactive two-way sync engine    (sync_manager.js + sync.js)
//   * the "📌 Pin to Settings Hub" menu   (context_menu.js)
//   * drag & drop reordering              (dnd_manager.js)
// ============================================================================

import { app } from "../../scripts/app.js";

import "./sync.js";            // internal bus (locks, rAF queue)
import "./pins.js";            // badge counter cache
import "./hub_node.js";        // node registration + drawNode badge painter
import "./hub_ui_renderer.js"; // DOM widget rendering
import "./sync_manager.js";    // target-widget callback hooks (reactive sync)

import { attachContextMenu } from "./context_menu.js";
import { syncAll } from "./sync_manager.js";

// v30.3: build banner - makes the running web build verifiable in F12
// (field debugging: "is the new file actually loaded?" stops being a guess;
// a stale cached module was a real suspect twice already).
console.info("[SettingsHub] web build: v32 - self-laid-out ghost mirrors: KJNodes Model Preview Override image/info split, live local grip drag in the hub");

// Load CSS via link tag to avoid module MIME type errors.
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css", import.meta.url).href;
    document.head.appendChild(link);
})();

attachContextMenu();

app.registerExtension({
    name: "Comfy.SettingsHub.hooks",
    setup() {
        syncAll();
    },
    afterConfigureGraph() {
        syncAll();
    },
});
