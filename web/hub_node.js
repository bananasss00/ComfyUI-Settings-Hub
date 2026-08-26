import { app } from "../../scripts/app.js";
import { getHubConfig } from "./core.js";
import { syncNode } from "./sync.js";

export const NODE_NAME = "SettingsHub";

class SettingsHubNode extends LGraphNode {
    constructor() {
        super();
        this.type = NODE_NAME;
        this.color = "#1a1a2e";
        this.title = "Settings Hub";
        this.size = [340, 200];
        this.resizable = true;
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
}

app.registerExtension({
    name: "Comfy.SettingsHub.node",
    "onNodeCreated"(node) {
        if (node.type === NODE_NAME) {
            getHubConfig(node);
            syncNode(node);
        }
    },
    "onNodeRemoved"(node) {
        if (node.type === NODE_NAME) {
            syncNode(node);
        }
    },
});

LiteGraph.registerNodeType(NODE_NAME, SettingsHubNode);
