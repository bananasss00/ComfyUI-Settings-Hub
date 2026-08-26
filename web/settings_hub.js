import { attachContextMenu } from "./context_menu.js";
import { syncAll } from "./sync_manager.js";
import "./hub_node.js";
import "./hub_ui_renderer.js";
import "./styles.css";

app.registerExtension({
    name: "Comfy.SettingsHub.hooks",
    async "appReady"() {
        attachContextMenu();
        syncAll();
    },
});
