import { app } from "../../scripts/app.js";
import { getHubConfig } from "./core.js";
import { syncNode } from "./sync.js";

export const NODE_NAME = "SettingsHub";

let registered = false;
let pollTimer = null;

function makeSettingsHubNodeClass(LGraphNode) {
    return class SettingsHubNode extends LGraphNode {
        constructor() {
            super();
            this.type = NODE_NAME;
            this.color = "#1a1a2e";
            this.title = "Settings Hub";
            this.size = [340, 200];
            this.resizable = true;
            this.widgets = [];
        }

        onSerialize() {
            return { properties: this.properties };
        }

        onConfigure(data) {
            if (data.properties?.hubConfig) {
                this.properties.hubConfig = data.properties.hubConfig;
            }
            syncNode(this);
            return true;
        }

        onDrawBackground(ctx) {
            ctx.fillStyle = "#1a1a2e";
            const w = this.size[0], h = this.size[1];
            ctx.fillRect(-5, -5, w + 10, h + 10);
        }

        onDrawForeground(ctx) {
            const cfg = getHubConfig(this);
            const count = cfg.items.filter((i) => i.type === "widget_binding").length;
            ctx.save();
            ctx.fillStyle = "#ff6b6b";
            ctx.font = "bold 12px sans-serif";
            ctx.fillText(`📌 ${count}`, 10, 20);
            ctx.restore();
        }
    };
}

export function registerHubNode() {
    if (registered) return true;
    const LiteGraph = window.LiteGraph;
    const LGraphNode = window.LGraphNode;
    if (!LiteGraph || !LGraphNode) return false;
    try {
        LiteGraph.registerNodeType(NODE_NAME, makeSettingsHubNodeClass(LGraphNode));
        registered = true;
        return true;
    } catch (e) {
        console.error("ComfyUI-Settings-Hub: registerNodeType failed:", e);
        return false;
    }
}

// The litegraph globals (window.LiteGraph / window.LGraphNode) are installed
// by the frontend during canvas initialization, which may happen after
// extension modules are imported. Try immediately and retry until they exist.
if (!registerHubNode()) {
    pollTimer = setInterval(() => {
        if (pollTimer && registerHubNode()) clearInterval(pollTimer);
    }, 100);
    setTimeout(() => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }, 60000);
}

app.registerExtension({
    name: "Comfy.SettingsHub.node",
    "nodeCreated"(node) {
        if (node.type === NODE_NAME) {
            getHubConfig(node);
            syncNode(node);
        }
    },
    "setup"() {
        registerHubNode();
    },
    "afterConfigureGraph"() {
        registerHubNode();
    },
});
