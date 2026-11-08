import { app } from "../../scripts/app.js";
import { getHubConfig, trackHubNode, forgetHubNode, isNodeInViewTree } from "./core.js";
import { syncNode } from "./sync.js";
import { relayoutHub, disposeHubVisuals, pruneForeignHubs, installHubTabWatch, isHubUiMounted, forceHubRebuild, showHubToast } from "./hub_ui_renderer.js";
import * as Pins from "./pins.js";

// v67 BUILD GUARD (see settings_hub.js): every submodule self-reports
// under __SettingsHubLoaded so the entry can NAME stale cached files.
globalThis.__SettingsHubLoaded = globalThis.__SettingsHubLoaded ?? {};
globalThis.__SettingsHubLoaded["hub_node"] = true;
if (globalThis.__SettingsHubBuild !== "v79") {
    console.error("[SettingsHub] STALE BUILD: hub_node.js (v77) was loaded under entry build [" +
        (globalThis.__SettingsHubBuild ?? "unknown") +
        "] - the browser served cached modules. Hard-refresh the page (Ctrl+F5).");
}

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

// ---------------------------------------------------------------------------
// v64 fresh-add lifecycle: build the UI only while the node is IN the graph
// ---------------------------------------------------------------------------
// `nodeCreated` fires at the END of the node constructor (docs: "right at
// the end of the ComfyNode() function"), i.e. BEFORE graph.add() - the node
// has no graph and no real id yet. The frontend's DOM-widget layer only
// mounts elements for widgets whose node is in the graph
// (domWidget.ts: `if (node.graph) registerWidget(widget)`, the rest is
// deferred onto node.onAdded). A UI built here used to produce a DOM widget
// that never mounted: the node stayed EMPTY until the workflow was reloaded
// or re-configured (field report v63; page reload / workflow switch were
// the only workarounds).
//
// v63 field round 2: building from onAdded alone was NOT enough - the hub
// still landed empty on the user's frontend (the element mount happens in
// the frontend's reactive layer some time AFTER registration, and exotic
// builds can drop it entirely). v64 therefore enforces the INVARIANT, not
// one timing: a visible, non-collapsed, non-pinned hub always ends up with
// its element connected - through a longer repair ladder here and a
// persistent DOM-truth repair in the 1200ms tab-watch sweep
// (hub_ui_renderer.hubTabSweepTick), with a one-time workflow reconfigure
// (the user's own manual workaround) as the final escalation.

function syncIfInGraph(node) {
    if (!node || node.type !== NODE_NAME || !node.graph) return false;
    syncNode(node);
    return true;
}

function deferHubUiBuild(node) {
    // Primary: chain onAdded (prev first - foreign chains keep working).
    const prev = node.onAdded;
    node.onAdded = function (graph) {
        try { prev?.call(this, graph); } catch (_) {}
        try { syncIfInGraph(node); } catch (_) {}
    };
    // v64 post-add canonical sync: every add flow calls graph.add()
    // synchronously right after the constructor, so a macrotask armed in
    // nodeCreated runs AFTER graph.add() has fully returned - the exact
    // timing of the proven context-menu creation path (core.createNewHub:
    // add() THEN syncNode()). Gentle on purpose: it only re-renders content
    // into an already-mounted widget; the ladder owns the hard repairs.
    for (const ms of [0, 60]) {
        setTimeout(() => {
            try {
                if (!node.graph || node.type !== NODE_NAME) return;
                if (node.flags?.collapsed) return;
                if (!isHubUiMounted(node)) return;
                syncNode(node);
            } catch (_) {}
        }, ms);
    }
    // Fallback ladder for exotic frontends (an extension or build that
    // clobbers node.onAdded after us, add flows without it, or a mount that
    // lands later than the reactive flush). Each tick is a no-op when the
    // UI is healthy; the repair runs only while the node is in the graph,
    // so a fresh widget always lands on the registration path every
    // frontend handles correctly. Ticks grant a shared grace window so the
    // sweep (hubTabSweepTick) does not churn the same node mid-repair.
    for (const ms of [250, 700, 1600, 3000]) {
        setTimeout(() => {
            try {
                if (!node.graph || node.type !== NODE_NAME) return;
                if (node.flags?.collapsed) return; // mount unverifiable
                if (isHubUiMounted(node)) return;
                // A hub whose view tree is not open (closed subgraph) has a
                // legitimately unmounted element - not a poisoned widget.
                if (!isNodeInViewTree(node)) return;
                node.__hubMountGraceUntil = Date.now() + 2500;
                node.__hubMountRepairs = (node.__hubMountRepairs ?? 0) + 1;
                forceHubRebuild(node);
            } catch (_) {}
        }, ms);
    }
    // v64 FINAL escalation (~6s after the add): the user's own proven
    // workaround, automated - reconfigure the workflow. Fires only when
    // every repair failed, at most once per node, never while healthy.
    setTimeout(() => {
        try { freshAddFinalRepair(node); } catch (_) {}
    }, 6000);
}

// v64: one-time final repair - reconfigure the current workflow from its own
// serialization. This is EXACTLY what the user does by hand ("switch to
// another workflow and back") and it is the one path their frontend
// demonstrably mounts correctly: nodes are rebuilt graph-less and their Vue
// components mount only after every widget already exists. Exported for the
// smoke suite. Guarded: in-graph, in view, not collapsed, still unmounted,
// once per node, once globally at a time.
let freshAddReconfiguring = false;
export function freshAddFinalRepair(node) {
    if (!node || node.type !== NODE_NAME) return;
    if (node.__hubReconfiguredForMount) return;
    if (!node.graph) return;
    if (node.flags?.collapsed) return;
    if (isHubUiMounted(node)) return;
    if (!isNodeInViewTree(node)) return;
    node.__hubReconfiguredForMount = true;
    if (freshAddReconfiguring) return;
    const data = node.graph.serialize?.();
    if (!data || typeof app?.loadGraphData !== "function") {
        console.warn("[SettingsHub] a fresh hub's UI did not mount and the workflow reconfigure is unavailable (build " +
            (globalThis.__SettingsHubBuild ?? "?") + ") - switch workflows away and back once to mount it.");
        return;
    }
    freshAddReconfiguring = true;
    console.info("[SettingsHub] a fresh hub's UI did not mount ~6s after the add - reconfiguring the workflow (the same thing switching workflows away and back does). One-time repair for this node.");
    try { showHubToast("SettingsHub: remounting the hub UI - reloading the workflow once…"); } catch (_) {}
    try {
        const p = app.loadGraphData(data);
        Promise.resolve(p).catch((err) => {
            console.warn("[SettingsHub] fresh-add reconfigure failed:", err);
        }).finally(() => { freshAddReconfiguring = false; });
    } catch (err) {
        freshAddReconfiguring = false;
        console.warn("[SettingsHub] fresh-add reconfigure failed:", err);
    }
}

app.registerExtension({
    name: "Comfy.SettingsHub.node",
    nodeCreated(node) {
        if (node.type !== NODE_NAME) return;
        getHubConfig(node);
        trackHubNode(node); // cross-graph discovery (subgraph-safe menus)
        // v64: UI build is deferred until the node is in the graph - see
        // "v64 fresh-add lifecycle" above.
        if (!syncIfInGraph(node)) deferHubUiBuild(node);
    },
    setup() {
        registerHubNode();
        installBadgePainter();
        // v35/v36/v42: workflow TAB switches do not necessarily configure
        // the graph (frontends swap app.canvas.graph, or re-deserialize
        // INTO the same LGraph object) - the watcher sweeps EVERY tick
        // against a node-identity active set (no signature gate), so a
        // pinned window never floats over a foreign workflow - same-id
        // switches included.
        // Self-disarming: a pathological frontend degrades to v33 behavior.
        try { installHubTabWatch(); } catch (_) {}
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
