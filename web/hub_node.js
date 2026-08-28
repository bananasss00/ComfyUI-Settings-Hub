import { app } from "../../scripts/app.js";
import { getHubConfig, trackHubNode, forgetHubNode } from "./core.js";
import { syncNode } from "./sync.js";
import { relayoutHub, disposeHubVisuals, pruneForeignHubs } from "./hub_ui_renderer.js";
import * as Pins from "./pins.js";

export const NODE_NAME = "SettingsHub";

let registered = false;
let pollTimer = null;
let badgeInstalled = false;

// ---------------------------------------------------------------------------
// Node class
// ---------------------------------------------------------------------------

function makeSettingsHubNodeClass(LGraphNode) {
    return class SettingsHub extends LGraphNode {
        constructor() {
            super();
            this.type = NODE_NAME;
            this.title = "Settings Hub";
            this.color = "#2a2a3e";
            this.bgcolor = "#16162a";
            this.size = [340, 200];
            this.resizable = true;
            this.widgets = [];
        }

        onSerialize() {
            // Only properties.hubConfig matters; LiteGraph serializes the rest.
        }

        onConfigure(data) {
            if (data.properties?.hubConfig) {
                this.properties.hubConfig = data.properties.hubConfig;
            }
            syncNode(this); // rebuilds DOM widget from loaded config
        }

        onResize(size) {
            // Distinguish USER drags from our own automatic fits: automatic
            // ones run with __hubAutoSizing raised (see setNodeHeight in
            // hub_ui_renderer). A manual drag switches the hub into FILL
            // mode - the user's height wins and the DOM adapts to it.
            if (!this.__hubAutoSizing) this.__hubUserH = true;
            // rAF-coalesced layout, no innerHTML rebuild - safe mid-drag.
            try { relayoutHub(this); } catch (_) {}
        }

        onRemoved() {
            // Keep the global registry truthful: removed hubs must stop
            // appearing in pin menus and sync loops.
            forgetHubNode(this);
            // v24: a screen-pinned hub must not leave a ghost floating window.
            try { disposeHubVisuals(this); } catch (_) {}
        }
    };
}

// ---------------------------------------------------------------------------
// Registration (globals appear only after canvas init -> retry loop)
// ---------------------------------------------------------------------------

export function registerHubNode() {
    if (registered) return true;
    const LiteGraph = window.LiteGraph;
    const LGraphNode = window.LGraphNode;
    if (!LiteGraph || !LGraphNode) return false;
    try {
        LiteGraph.registerNodeType(NODE_NAME, makeSettingsHubNodeClass(LGraphNode));
        registered = true;
        installBadgePainter();
        return true;
    } catch (e) {
        console.error("ComfyUI-Settings-Hub: registerNodeType failed:", e);
        return false;
    }
}

// ---------------------------------------------------------------------------
// "📌 n" badge on pinned target nodes (dev_plan phase 4)
// ---------------------------------------------------------------------------
// Wraps LGraphCanvas.prototype.drawNode once; after the node is drawn the
// badge is painted on top - equivalent to an onDrawForeground hook without
// touching every registered node class.

function installBadgePainter() {
    if (badgeInstalled) return;
    const LGraphCanvasProto =
        window.LGraphCanvas?.prototype ?? app.canvas?.constructor?.prototype;
    if (!LGraphCanvasProto || !LGraphCanvasProto.drawNode) return;

    if (LGraphCanvasProto.__hubBadgeInstalled) { badgeInstalled = true; return; }
    LGraphCanvasProto.__hubBadgeInstalled = true;

    const origDrawNode = LGraphCanvasProto.drawNode;
    LGraphCanvasProto.drawNode = function (...args) {
        const result = origDrawNode.apply(this, args);
        try {
            const [node, ctx] = args;
            const count = Pins.getPinCount(node?.id);
            if (count > 0 && !node.flags?.collapsed && ctx) {
                ctx.save();
                ctx.font = "10px sans-serif";
                ctx.textAlign = "left";
                ctx.textBaseline = "top";
                const label = `📌${count}`;
                const w = ctx.measureText(label).width + 6;
                const x = (node.size?.[0] ?? 0) - w - 2;
                const y = 2;
                ctx.fillStyle = "rgba(30,30,52,0.85)";
                ctx.strokeStyle = "#6b6b8e";
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(x, y, w, 14, 3) : ctx.rect(x, y, w, 14);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = "#e0e0e0";
                ctx.fillText(label, x + 3, y + 2.5);
                ctx.restore();
            }
        } catch (_) {}
        return result;
    };
    badgeInstalled = true;
}

function tryInstallBadgeSoon() {
    if (badgeInstalled || installBadgePainter()) return;
    pollTimer = pollTimer || setInterval(() => {
        if ((registerHubNode() || installBadgePainter()) && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }, 100);
    setTimeout(() => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }, 60000);
}
tryInstallBadgeSoon();

app.registerExtension({
    name: "Comfy.SettingsHub.node",
    nodeCreated(node) {
        if (node.type === NODE_NAME) {
            getHubConfig(node);
            syncNode(node);
            trackHubNode(node); // cross-graph discovery (subgraph-safe menus)
        }
    },
    setup() {
        registerHubNode();
        installBadgePainter();
    },
    afterConfigureGraph() {
        // v31: BEFORE the survivors re-render - a graph configure (workflow
        // switch) rebuilds node instances without firing onRemoved; sweep
        // dead hubs so their pinned windows do not outlive the workflow.
        try { pruneForeignHubs(); } catch (_) {}
        registerHubNode();
        installBadgePainter();
        Pins.repaint(app); // badges for freshly loaded graph
    },
});
