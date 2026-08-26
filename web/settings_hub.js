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

app.registerExtension({
    name: "Comfy.SettingsHub.hooks",
    async "appReady"() {
        attachContextMenu();
        syncAll();
    },
});
