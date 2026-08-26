import { app } from "../../scripts/app.js";
import { attachContextMenu } from "./context_menu.js";
import { syncAll } from "./sync_manager.js";
import "./hub_node.js";
import "./hub_ui_renderer.js";

// Load CSS via link tag to avoid module MIME type errors
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/extensions/ComfyUI-Settings-Hub/styles.css";
    document.head.appendChild(link);
})();

// Register the context-menu extension immediately. Extension registration is
// safe at module scope: the frontend stores it and invokes the hooks when the
// menu is built. (The "appReady" hook does not exist in current frontends.)
attachContextMenu();

app.registerExtension({
    name: "Comfy.SettingsHub.hooks",
    "setup"() {
        syncAll();
    },
    "afterConfigureGraph"() {
        syncAll();
    },
});
