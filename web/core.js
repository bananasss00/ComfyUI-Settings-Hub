import { app } from "../../scripts/app.js";
import { syncNode } from "./sync.js";
import * as Pins from "./pins.js";

export const HUB_NODE_NAME = "SettingsHub";

let idCounter = 0;

export function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Global hub registry (cross-graph discovery)
// ---------------------------------------------------------------------------
// ComfyUI subgraphs make `node.graph`/`app.graph` graph-local: a hub living
// on the ROOT canvas is invisible to menu code running while the user is
// INSIDE a subgraph ("only Create New is offered"). All hubs are created on
// the root graph anyway, so discovery must be GRAPH-INDEPENDENT. We keep our
// own registry - nodeCreated tracks, onRemoved forgets - and everything that
// enumerates hubs reads from it instead of scanning one graph's _nodes.

const hubRegistry = new Set();

/** Called from the extension's nodeCreated hook for EVERY hub instance. */
export function trackHubNode(node) {
    if (node?.type === HUB_NODE_NAME) hubRegistry.add(node);
}

/** Called from the hub class onRemoved hook. */
export function forgetHubNode(node) {
    if (node) hubRegistry.delete(node);
}

/** Live hubs across ALL graphs, in stable insertion order.
 *
 *  The registry is the primary source, but it can be COLD through no fault
 *  of the user: extension nodeCreated may have been missed entirely on exotic
 *  load paths (stale-cached chunks mixing versions, hot-swapped bundles,
 *  loader races during configureGraph). A hub sitting right there on the
 *  canvas MUST never vanish from pin menus just because our bookkeeping
 *  missed it - so when the registry comes up empty we fall back to a live
 *  scan over every graph we can reach. Cheap (only when empty) and always
 *  truthful. */
export function allHubs() {
    const found = [...hubRegistry].filter((n) => n?.type === HUB_NODE_NAME);
    if (found.length) return found;
    try {
        for (const g of allGraphs()) {
            for (const n of g?._nodes ?? []) {
                if (n?.type === HUB_NODE_NAME && !found.includes(n)) found.push(n);
            }
        }
    } catch (_) { /* enumeration must never kill a menu build */ }
    return found;
}

// ---------------------------------------------------------------------------
// Cross-graph traversal + node lookup
// ---------------------------------------------------------------------------
// Pinned targets may live INSIDE any subgraph while the hub sits on the root
// canvas (that is the whole point of the global registry above). app.graph
// lookups only see the ROOT graph, so every target resolution goes through
// the helpers below instead of raw getNodeById.

/**
 * Every LGraph-like object reachable right now: the root graph, whatever
 * graph the canvas is showing, plus any nested subgraph objects.
 *
 * v24 - FIELD-HARDENED (report: hub on root, pin inside subgraph1->subgraph2
 * showed "!"). The old walker only understood `_nodes` arrays plus a short
 * hand-list of holder fields (`n.subgraph`, `n.subgraphs`) and read
 * `g._subgraphs` ONLY when it was an Array. Real frontends break every one
 * of those assumptions somewhere: newer builds keep subgraph registries in
 * a Map (or expose nested definitions only through less obvious refs), id
 * types drift between number and string after re-mapping, and deep nesting
 * adds levels the old per-item depth budget could cut off. The walker now:
 *   1. walks LEVELS, not queue items (maxDepth counts hierarchy depth);
 *   2. scans BOTH `_nodes` and public `nodes` node lists;
 *   3. accepts Array / Map / plain-object registries (`_subgraphs`,
 *      `subgraphs`, `subgraphsById`);
 *   4. DUCK-TYPE HARVESTS candidate graphs from EVERY own enumerable node
 *      property that looks like an LGraph (owns `_nodes`/`nodes` array) -
 *      naming conventions stop mattering; cycles are deduped by identity.
 */
function looksLikeGraph(obj) {
    return !!(obj && typeof obj === "object" &&
        (Array.isArray(obj._nodes) || Array.isArray(obj.nodes)));
}

export function nodeListOf(g) {
    // Union of the raw + public lists; nodes may legally appear in both,
    // callers tolerate duplicates cheaply (Map/Set by reference).
    const out = [];
    if (Array.isArray(g?._nodes)) out.push(...g._nodes);
    if (Array.isArray(g?.nodes) && g.nodes !== g._nodes) {
        for (const n of g.nodes) if (!out.includes(n)) out.push(n);
    }
    return out;
}

/** Registries of subgraph DEFINITIONS held on a graph itself. */
function registryEntriesOf(g) {
    const out = [];
    for (const key of ["_subgraphs", "subgraphs", "subgraphsById"]) {
        let reg;
        try { reg = g?.[key]; } catch (_) { continue; }
        try {
            if (!reg) continue;
            if (Array.isArray(reg)) { out.push(...reg); continue; }
            if (typeof reg.forEach === "function") {          // Map / Set
                reg.forEach((v) => { if (v && typeof v === "object") out.push(v); });
                continue;
            }
            if (typeof reg === "object") {
                for (const k of Object.keys(reg)) {           // {uuid: Subgraph}
                    const v = reg[k];
                    if (v && typeof v === "object") out.push(v);
                }
            }
        } catch (_) {}
    }
    return out;
}

function seedRootGraphs(push) {
    try { push(app.graph); } catch (_) {}
    try { push(app.canvas?.graph); } catch (_) {}
    try { push(window.comfyAPI?.app?.graph); } catch (_) {}
}

/** Child graphs directly reachable off one node's own properties. */
export function childGraphsOfNode(n) {
    const found = [];
    const consider = (v) => { if (looksLikeGraph(v)) found.push(v); };
    try { consider(n.subgraph); } catch (_) {}
    try {
        if (Array.isArray(n.subgraphs)) {
            for (const s of n.subgraphs) consider(s);
        }
    } catch (_) {}
    // Duck-type harvest over remaining OWN keys - future-proof against
    // renamed holder fields without touching widget values or callbacks.
    try {
        for (const k of Object.getOwnPropertyNames(n ?? {})) {
            if (k === "subgraph" || k === "subgraphs") continue;
            let v;
            try { v = n[k]; } catch (_) { continue; }
            if (v && typeof v === "object") consider(v);
        }
    } catch (_) {}
    return found;
}

export function allGraphs(maxDepth = 12) {
    const seen = new Set();
    const out = [];
    const push = (g) => {
        if (looksLikeGraph(g) && !seen.has(g)) {
            seen.add(g);
            out.push(g);
            return true;
        }
        return false;
    };

    seedRootGraphs(push);
    // Root-seeded graphs first, then level-by-level expansion.
    let frontier = [...out];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
        const next = [];
        for (const g of frontier) {
            for (const n of nodeListOf(g)) {
                for (const child of childGraphsOfNode(n)) {
                    if (push(child)) next.push(child);
                }
            }
            for (const def of registryEntriesOf(g)) {
                if (push(def)) next.push(def);
            }
        }
        frontier = next;
    }
    return out;
}

// ---------------------------------------------------------------------------
// v37: LIVE-TREE walker - liveness decisions must not consult subgraph
// DEFINITION registries. allGraphs() also walks g._subgraphs (needed for
// cross-subgraph pin RESOLUTION), but frontend 1.51.9 tab switches run
// loadGraphData -> clean() -> configure() and clean() SKIPS rootGraph.clear()
// whenever canvas.subgraph is set; configure() then replaces _nodes without
// any removal lifecycle and MERGES the incoming subgraph definitions into
// the registry - the PREVIOUS workflow's subgraph objects stay reachable
// through it. Liveness driven by that walker kept dead hubs "alive":
// prune skipped them and their pinned windows survived tab switches
// (field report: 1.51.9, frontend package 1.51.9). liveGraphs() walks ONLY
// the roots plus graphs directly referenced by live nodes' own properties.
export function liveGraphs(maxDepth = 12) {
    const seen = new Set();
    const out = [];
    const push = (g) => {
        if (looksLikeGraph(g) && !seen.has(g)) {
            seen.add(g);
            out.push(g);
            return true;
        }
        return false;
    };

    seedRootGraphs(push);
    let frontier = [...out];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
        const next = [];
        for (const g of frontier) {
            for (const n of nodeListOf(g)) {
                for (const child of childGraphsOfNode(n)) {
                    if (push(child)) next.push(child);
                }
            }
            // NOTE: no registryEntriesOf() here - that is the point.
        }
        frontier = next;
    }
    return out;
}

/** True when the node object is a member of the CURRENT workflow tree
 *  (liveGraphs). A walker hiccup answers YES - live state is never
 *  destroyed on a tooling failure. */
export function isNodeInLiveTree(node) {
    try {
        for (const g of liveGraphs()) {
            for (const n of nodeListOf(g)) {
                if (n === node) return true;
            }
        }
    } catch (_) {
        return true;
    }
    return false;
}

/** Node by numeric OR stringified id across root graph AND every reachable
 *  subgraph. The loose second pass absorbs frontend generations that re-map
 *  inner ids to strings (a stored numeric pin id still matches). Exact id
 *  equality ALWAYS wins everywhere before any type-loose comparison runs -
 *  reused/garbage-collected legacy ids must never shadow real ones. */
export function findNodeByIdEverywhere(id) {
    try {
        const local = app.graph?.getNodeById?.(id);
        if (local != null) return local;
    } catch (_) {}
    const key = String(id);
    let looseHit = null;
    for (const g of allGraphs()) {
        for (const n of nodeListOf(g)) {
            if (n.id === id) return n;              // authoritative exact hit
            if (looseHit == null && String(n.id) === key) looseHit = n;
        }
    }
    return looseHit;
}

const diagReported = new Set();
const diagPending = new WeakSet();
const diagAttempts = new WeakMap();

/** One-line console breadcrumb when a pin stays unresolved - turns future
 *  field reports into actionable data (how many graphs/nodes were scanned).
 *  Fired once per target identity, never spams.
 *
 *  v36: the report is DEFERRED (~2.5s) and re-checked first. The hub renders
 *  DURING graph.configure (onConfigure -> syncNode) while the workflow is
 *  still being populated, so targets routinely do not exist yet; every
 *  immediate report fired in that window was a false alarm healed
 *  milliseconds later by afterConfigureGraph -> syncAll (one field log
 *  showed ~35 such lines per page load). Only pins that STILL fail against
 *  the settled graph produce the breadcrumb, with truthful scan stats. */
function reportUnresolved(item) {
    try {
        if (!item || diagPending.has(item)) return;
        diagPending.add(item);
        const tries = diagAttempts.get(item) ?? 0;
        setTimeout(() => {
            try {
                // Re-entry from resolveBindingTarget -> reportUnresolved is
                // a no-op while the item is pending (diagPending guard).
                if (resolveBindingTarget(item)) {
                    diagAttempts.delete(item); // healed after load
                    return;
                }
                diagPending.delete(item);
                // Fresh truthful stats - a nodeId-only pin never populates
                // lastResolverStats on its own (no title -> no scan ran).
                scanAllNodesFor(() => false);
                const st = lastResolverStats();
                // v37: a scan visiting ZERO nodes means the workflow has
                // not been populated yet (heavy environments boot slower
                // than the 2.5s window - one field log showed five pins
                // reported against an empty graph, all healed later).
                // Re-arm instead of reporting; only a POPULATED graph that
                // still cannot serve the pin earns the breadcrumb.
                if (st.nodes === 0 && tries < 2) {
                    diagAttempts.set(item, tries + 1);
                    reportUnresolved(item);
                    return;
                }
                diagAttempts.delete(item);
                const key = `${item?.targetNodeId}|${item?.targetTitle}|${item?.widgetToBind}`;
                if (diagReported.has(key)) return;
                diagReported.add(key);
                // Viewer embeds bind the whole NODE (no real widget name) -
                // showing the internal sentinel would just confuse reports.
                const widgetLabel = item?.options?.viewer
                    ? "(whole node embed)" : item?.widgetToBind;
                console.info(
                    "[SettingsHub] pin unresolved:", JSON.stringify({
                        title: item?.targetTitle, widget: widgetLabel,
                        nodeId: item?.targetNodeId,
                    }),
                    `- scanned ${st.graphs} graph(s), ${st.nodes} node(s).` +
                    "\nIf this persists please report it with your ComfyUI frontend version.");
            } catch (_) {
                try { diagPending.delete(item); } catch (_) {}
            }
        }, 2500);
    } catch (_) {}
}

let lastScanStats = { graphs: 0, nodes: 0 };

/** Diagnostic snapshot of the most recent cross-graph scan (tests/support). */
export function lastResolverStats() { return { ...lastScanStats }; }

function scanAllNodesFor(pred) {
    const graphs = allGraphs();
    let visited = 0;
    for (const g of graphs) {
        for (const n of nodeListOf(g)) {
            visited++;
            if (pred(n)) {
                lastScanStats = { graphs: graphs.length, nodes: visited };
                return n;
            }
        }
    }
    lastScanStats = { graphs: graphs.length, nodes: visited };
    return null;
}

/**
 * Resolve the live target node behind a binding ITEM.
 * Pass 1: stored node id (exact or stringified), searched everywhere.
 * Pass 2 (drift repair): if the id died (reloads renumber nodes under some
 * frontends) fall back to the persisted source TITLE + widget-name pair -
 * far better than orphaning a perfectly good pin. "targetTitle" is written
 * by createBinding/createPortalBinding; older configs simply skip this.
 */
/**
 * v30: widget lookup by name with a same-name ORDINAL disambiguator.
 * Custom packs register SEVERAL widgets under ONE name (rgthree Fast
 * Groups Muter/Bypasser rows are all "RGTHREE_TOGGLE_AND_NAV") - a plain
 * find-by-name always returned the FIRST row, so pinning such a node
 * duplicated its first toggle N times (every member resolved to the same
 * widget). Pin time stores an ordinal (index among the same-name widgets);
 * out-of-range ordinals (row removed / re-sorted) degrade to the first hit.
 */
export function findWidgetOnNode(tn, name, ord) {
    // v34: hostile name getters on a SIBLING widget must not kill the
    // lookup (one exotic custom widget used to take down the whole hub
    // render - every mirror of that node resolves through here).
    const list = [];
    for (const w of tn?.widgets || []) {
        try { if (w && w.name === name) list.push(w); } catch (_) {}
    }
    if (!list.length) return null;
    const i = Number.isInteger(ord) && ord >= 0 && ord < list.length ? ord : 0;
    return list[i] ?? list[0];
}

export function resolveBindingTarget(item) {
    const tn = findNodeByIdEverywhere(item?.targetNodeId);
    if (tn != null) return tn;
    const wantTitle = item?.targetTitle != null ? String(item.targetTitle) : "";
    if (!wantTitle) {
        reportUnresolved(item, lastResolverStats().graphs, lastResolverStats().nodes);
        return null;
    }
    const hit = scanAllNodesFor((n) =>
        String(n.title ?? "") === wantTitle &&
        (!item.widgetToBind ||
         n.widgets?.some((w) => w.name === item.widgetToBind)));
    if (hit) return hit;
    reportUnresolved(item, lastResolverStats().graphs, lastResolverStats().nodes);
    return null;
}

/**
 * Chain of SubgraphNode holders leading from the root graph DOWN TO the graph
 * that directly contains `targetNode` (outermost holder FIRST, immediate
 * parent LAST). Empty array = node lives on a root canvas - nothing to enter.
 * null = owner graph unreachable through known holder fields.
 *
 * Locate navigation uses this to hop INTO nested subgraphs instead of just
 * panning the wrong canvas.
 *
 * v24: walks the SAME hardened shape space as allGraphs() - union node
 * lists, Array/Map/object subgraph registries and duck-typed holder refs -
 * so a target discovered by the resolver is ALWAYS navigable by locate.
 */
export function findHolderChainOf(targetNode) {
    if (!targetNode || typeof targetNode !== "object") return null;
    const chains = new Map();   // graph -> holders[] to reach it
    const seen = new Set();
    let frontier = [];

    const seed = (g) => {
        if (looksLikeGraph(g) && !seen.has(g)) {
            seen.add(g);
            chains.set(g, []);
            frontier.push(g);
        }
    };
    seedRootGraphs(seed);

    for (let depth = 0; depth < 16 && frontier.length; depth++) {
        const next = [];
        for (const g of frontier) {
            const path = chains.get(g) ?? [];
            for (const n of nodeListOf(g)) {
                if (n === targetNode) return [...path];
                for (const child of childGraphsOfNode(n)) {
                    if (!seen.has(child)) {
                        seen.add(child);
                        chains.set(child, [...path, n]);
                        next.push(child);
                    }
                }
            }
            for (const def of registryEntriesOf(g)) {
                // Definition registries lack a specific holder node; the
                // outermost entry carries the graph itself (holders chain
                // stays as-is - locate only needs A valid entry ladder).
                if (!seen.has(def)) {
                    seen.add(def);
                    chains.set(def, [...path]);
                    next.push(def);
                }
            }
        }
        frontier = next;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Config access / migration
// ---------------------------------------------------------------------------

export function getHubConfig(node) {
    if (!node.properties.hubConfig) {
        node.properties.hubConfig = {
            version: 1,
            activeTabId: "tab_default",
            tabs: [{ id: "tab_default", name: "General", order: 0 }],
            items: [],
            presets: {},
        };
    }
    const cfg = node.properties.hubConfig;
    if (!Array.isArray(cfg.tabs)) cfg.tabs = [];
    if (!Array.isArray(cfg.items)) cfg.items = [];
    if (!cfg.presets || typeof cfg.presets !== "object") cfg.presets = {};
    // v24 screen-pin state (boolean, viewport position, collapsed panel).
    if (cfg.pinned !== true) cfg.pinned = false;
    if (cfg.pinPos && typeof cfg.pinPos === "object" &&
        Number.isFinite(Number(cfg.pinPos.x)) && Number.isFinite(Number(cfg.pinPos.y))) {
        cfg.pinPos = { x: Number(cfg.pinPos.x), y: Number(cfg.pinPos.y) };
    } else {
        cfg.pinPos = null;
    }
    if (cfg.pinMin !== true) cfg.pinMin = false;
    // v27.2: user-resized floating window (explicit px size; null = auto,
    // the panel hugs its content like it always did).
    if (cfg.pinSize && typeof cfg.pinSize === "object" &&
        Number.isFinite(Number(cfg.pinSize.w)) && Number.isFinite(Number(cfg.pinSize.h))) {
        cfg.pinSize = { w: Number(cfg.pinSize.w), h: Number(cfg.pinSize.h) };
    } else {
        cfg.pinSize = null;
    }
    // v25: row chrome (drag handles + remove buttons) hidden by the 👁 toggle.
    if (cfg.hideChrome !== true) cfg.hideChrome = false;
    return cfg;
}

export function getActiveTabId(cfg) {
    if (cfg.activeTabId && cfg.tabs.find((t) => t.id === cfg.activeTabId)) {
        return cfg.activeTabId;
    }
    cfg.activeTabId = cfg.tabs?.[0]?.id ?? null;
    return cfg.activeTabId;
}

export function sortedTabs(cfg) {
    return [...cfg.tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function itemsOfTab(cfg, tabId) {
    return cfg.items
        .filter((i) => i.tabId === tabId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function nextOrder(cfg, tabId) {
    let order = 0;
    for (const item of cfg.items) {
        if (item.tabId === tabId) order = Math.max(order, (item.order ?? 0) + 1);
    }
    return order;
}

export function setOrders(items) {
    items.forEach((item, i) => { item.order = i; });
}

// ---------------------------------------------------------------------------
// Widget type detection (PROBLEM #1 FIX)
// ---------------------------------------------------------------------------
// LiteGraph / ComfyUI widget types come in every casing ("combo", "COMBO",
// "toggle", "customtext", ...) and some widget factories never fill `type`
// at all. Detection therefore relies on runtime facts first
// (options.values, typeof value) and only then on the lowercased type tag.

export function extractComboValues(widget) {
    const opts = widget?.options;
    if (!opts) return null;
    let values = opts.values;
    if (typeof values === "function") {
        try { values = values.call(widget); } catch { return null; }
    }
    if (!Array.isArray(values)) return null;
    // Stringify primitives so <option> comparisons stay consistent.
    return values.map((v) => (typeof v === "object" && v !== null ? v : String(v)));
}

const COMBO_TYPES = new Set(["combo", "combobox", "dropdown", "enum"]);
const BOOL_TYPES = new Set(["toggle", "boolean", "checkbox"]);
const TEXT_TYPES = new Set([
    "text", "string", "customtext", "textarea", "multiline",
]);

/**
 * True when the widget is a multiline text editor. ComfyUI expresses this in
 * two different ways depending on widget vintage:
 *   - options.multiline === true (canvas customtext widgets)
 *   - the widget itself carries a real <textarea> DOM element
 *     (DOM-based prompt widgets) - no flag at all.
 */
export function isMultilineWidget(widget) {
    if (!widget) return false;
    // v30: truthy flags of any kind count ("true"/1 travel through some
    // widget builders); an explicit false never vetoes a live textarea.
    if (widget.options?.multiline === true || widget.options?.multiline === "true") {
        return true;
    }
    // Any direct element reference that IS a textarea. Frontend versions
    // disagree on which reference carries the editor (element since
    // PR #8594, inputEl on older builds) - checking only the FIRST
    // non-null one made prompts with a wrapper div render as single-line
    // inputs (no resize grip in the hub).
    const refs = [widget.inputEl, widget.element, widget.contentEl];
    if (refs.some((el) => el && el.tagName === "TEXTAREA")) return true;
    // "customtext" IS the multiline canvas widget by definition (single-line
    // STRING is type "text"). Some builds expose neither the flag nor a
    // mounted element - still render it as a growing editor, not an input.
    const type = typeof widget.type === "string" ? widget.type.toLowerCase() : "";
    if (type === "customtext") return true;
    // v30: TEXT widgets whose CURRENT value already contains newlines are
    // de-facto multiline - catches packs that expose neither a flag nor a
    // mounted element (the multiline flag often stays in the node DEF only
    // and never reaches the widget object).
    if (TEXT_TYPES.has(type) && typeof widget.value === "string" &&
        widget.value.includes("\n")) {
        return true;
    }
    // v30: explicit name/label hint on a TEXT-family widget.
    if (TEXT_TYPES.has(type) &&
        /multiline/i.test(`${widget.name ?? ""} ${widget.label ?? ""}`)) {
        return true;
    }
    // A declared-TEXT widget may wrap the real editor in a container div:
    // a contained <textarea> counts too. Restricted to TEXT_TYPES so custom
    // PANELS that merely include a textarea never flip to text mirrors.
    if (!TEXT_TYPES.has(type)) return false;
    for (const el of refs) {
        try { if (el?.querySelector?.("textarea")) return true; } catch (_) {}
    }
    return false;
}

export function detectWidgetType(widget) {
    const rawType = widget?.type;
    const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
    const opts = widget?.options || {};

    // 1) Combo wins first: anything carrying a values list IS a combo,
    //    regardless of its declared type. This is what used to fall through
    //    to the slider branch and produce NaN.
    const hasValues =
        Array.isArray(opts.values) ||
        typeof opts.values === "function";
    if (hasValues || COMBO_TYPES.has(type)) return "combo";

    // 2) Booleans / toggles.
    if (BOOL_TYPES.has(type) || typeof widget?.value === "boolean") return "checkbox";

    // 2.6) Plain canvas ACTION BUTTONS (rgthree Seed "Randomize Each Time",
    //      "Use Last seed", etc.): litegraph widgets of type exactly "button"
    //      drawn on the canvas - no state to mirror, but their callback is
    //      worth invoking from the hub. Declared earlier as un-pinnable
    //      helpers; since v23 buttons WITH a handler are first-class pins.
    //      A type:"button" carrying a REAL DOM container stays out of this
    //      branch: it falls through to the portal classification below (the
    //      DOM-panel guarantee outranks the declared type string).
    if (type === "button") {
        const domEl = widget?.element ?? widget?.contentEl ?? null;
        const looksLikePanel =
            !!(domEl && typeof domEl.querySelector === "function" &&
                !isMultilineWidget(widget));
        if (!looksLikePanel) return "button";
    }

    // 2.7) Real DOM panel containers (addDOMWidget-based custom UIs).
    //      Their serialized value is OPAQUE application state ("[]" stacks,
    //      objects...) - never mirror it into a primitive editor just
    //      because the value happens to be a string. The LTX / MiniMax H3
    //      "LoRA Loader Stack" lives entirely inside one such container and
    //      used to render as a bare text field bound to its JSON blob.
    //      Guards: a real <textarea> prompt stays a multiline mirror, and
    //      widgets that DECLARE a primitive shape (values list, min/max/
    //      step, numeric family types, plain text inputs) keep their old
    //      classifications even when they carry an element.
    const panelEl = widget?.element ?? widget?.contentEl ?? null;
    const declaresPrimitiveShape =
        opts.min != null ||
        opts.max != null ||
        opts.step != null ||
        type.includes("number") ||
        type.includes("slider") ||
        type.includes("int") ||
        type.includes("float");
    if (
        panelEl &&
        typeof panelEl.querySelector === "function" &&
        !isMultilineWidget(widget) &&
        !declaresPrimitiveShape &&
        !COMBO_TYPES.has(type) &&
        !BOOL_TYPES.has(type) &&
        !TEXT_TYPES.has(type)
    ) {
        return "portal";
    }

    // 3) Strings and prompt boxes.
    const declaresText =
        TEXT_TYPES.has(type) ||
        opts.multiline === true ||
        typeof opts.placeholder === "string";
    if (declaresText || typeof widget?.value === "string") return "text";

    // 4) Numeric family.
    const numericHints =
        type.includes("number") ||
        type.includes("slider") ||
        type.includes("float") ||
        type.includes("int") ||
        opts.min != null ||
        opts.max != null ||
        opts.step != null ||
        opts.precision != null ||
        opts.round != null ||
        typeof widget?.value === "number";
    if (!numericHints) return "portal"; // unknown/custom -> live portal embed

    const stepRaw = opts.step != null ? Number(opts.step) : NaN;
    const step = Number.isFinite(stepRaw) ? Math.abs(stepRaw) : NaN;

    // Modern frontends describe floats via options.precision (decimal digits)
    // or options.round instead of step; a missing step must NOT silently
    // degrade such widgets to ints.
    const precision = opts.precision != null ? Number(opts.precision) : NaN;
    const roundV = opts.round != null ? Number(opts.round) : NaN;
    const wholeStep = Number.isFinite(step) ? step >= 1 : null;

    const suggestsInt = type.includes("int") || wholeStep === true;
    const suggestsFloat =
        type.includes("float") ||
        type.includes("slider") ||
        precision > 0 ||
        (Number.isFinite(roundV) && roundV > 0 && roundV < 1);

    if (suggestsInt && !suggestsFloat) return "int";
    if (suggestsFloat) return "slider";

    // No declarations at all: fall back to how the CURRENT value looks.
    const v = Number(widget?.value);
    return Number.isFinite(v) ? (Number.isInteger(v) ? "int" : "slider") : "int";
}

// ---------------------------------------------------------------------------
// Live numeric options merge (target widget options win over snapshot)
// ---------------------------------------------------------------------------

function pickNum(...candidates) {
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
}

export function stepDecimals(step) {
    if (!(step > 0)) return 2;
    if (step >= 1) return 0;
    const s = String(step);
    const i = s.indexOf(".");
    return i < 0 ? 2 : Math.min(4, s.length - i - 1);
}

/**
 * Merge numeric options: prefer the live target widget's options, fall back
 * to the snapshot stored in the binding item, then to derived defaults.
 *
 * The mirror must be FAITHFUL: whatever step/min/max the source declares is
 * what the mirror uses - no invented walls (the old code clamped everything
 * into an implicit [0..1]), no ×10 mangled steps. A side with NO declared
 * bound stays open-ended: min/max come out as ±Infinity so the renderer can
 * omit the attribute and coercion skips that clamp.
 *
 * Step resolution order: declared step -> round -> precision-derived
 * (10^-digits) -> range-based fallback. The merged snapshot is also written
 * back into item.options (self-heal) so orphaned rows keep real geometry.
 */
export function numericMerge(item, targetWidget) {
    const live = targetWidget?.options || {};
    const snap = item?.options || {};

    let min = pickNum(live.min, snap.min, NaN);
    let max = pickNum(live.max, snap.max, NaN);
    if (Number.isFinite(min) && Number.isFinite(max) && !(max > min)) {
        max = min + Math.abs(min || 1); // degenerate equal bounds - keep them usable
    }

    const declaredStep = pickNum(live.step, snap.step, NaN);
    const rangeKnown = Number.isFinite(min) && Number.isFinite(max);
    const range = rangeKnown ? max - min : NaN;
    const fallbackStep = rangeKnown
        ? (range <= 1 ? 0.01 : Math.max(range / 200, 0.01))
        : 0.01;

    let step = declaredStep;
    if (!(step > 0) && optsHas(live, snap, "round")) step = pickNum(live.round, snap.round, NaN);
    if (!(step > 0) && optsHas(live, snap, "precision")) {
        const p = pickNum(live.precision, snap.precision, NaN);
        if (p >= 0) step = Math.pow(10, -Math.min(p, 6));
    }
    if (!(step > 0)) step = fallbackStep;
    // Never override a DECLARED step with range math; only the synthetic
    // fallback may adapt itself to a tiny range.
    if (!(declaredStep > 0) && rangeKnown && step > range) step = range / 100 || 0.01;

    // SLIDER-STEP RELAXATION (v21 field report: PrimitiveFloat ships a
    // default options.step of 1 -> the mirror's range input locked drags to
    // the 0,1,2,... grid and "no other values are reachable").
    // Contract: an INTEGRAL step >=1 on a NON-int source encodes a whole-
    // unit convenience default (ComfyUI convention for seeds/steps), NOT a
    // wish to forbid decimals on a float mirror. `step` stays faithful to
    // the source, while `sliderStep` - what the range control and program
    // quantization actually use - falls back to the finer resolution chain:
    // fractional round -> precision-derived -> range-based -> 0.01.
    // True int bindings keep their exact coarse grid.
    const isIntFamily = item?.widgetType === "int";
    let sliderStep = step;
    if (!isIntFamily && Number.isInteger(step) && step >= 1) {
        let fine = NaN;
        const r = pickNum(live.round, snap.round, NaN);
        if (r > 0 && r < 1) fine = r;
        if (!(fine > 0) && optsHas(live, snap, "precision")) {
            const p = pickNum(live.precision, snap.precision, NaN);
            if (p >= 0) fine = Math.pow(10, -Math.min(p, 6));
        }
        if (!(fine > 0)) fine = fallbackStep;
        if (fine > 0 && fine < step) sliderStep = fine;
    }

    // Self-heal the persisted snapshot so pins survive orphaning.
    try {
        if (item && typeof item === "object") {
            const so = (item.options && typeof item.options === "object")
                ? item.options : (item.options = {});
            if (so.min !== min && Number.isFinite(min)) so.min = min;
            if (so.max !== max && Number.isFinite(max)) so.max = max;
            if (so.step !== step && step > 0) so.step = step;
        }
    } catch (_) { /* frozen configs must not break rendering */ }

    const decSrc = isIntFamily ? 1 : (sliderStep > 0 ? sliderStep : step);
    return {
        min, max, step,
        sliderStep: sliderStep > 0 ? sliderStep : step,
        decimals: stepDecimals(decSrc),
    };
}

function optsHas(a, b, key) {
    return a?.[key] != null || b?.[key] != null;
}

/**
 * Display window for the nudge-slider when the source widget declares NO
 * finite bounds (PrimitiveFloat et al: min/max are effectively ±infinity).
 * Mirrors never invent REAL walls - typed input stays unrestricted and
 * coercion ignores these numbers (only DECLARED bounds clamp). Initial
 * render centers the window on the current value; afterwards the window is
 * managed by growSynthWindow (sticky one-sided growth, no re-centering).
 */
export function synthSliderWindow(value) {
    const v = Number.isFinite(Number(value)) ? Number(value) : 0;
    const span = Math.max(Math.abs(v), 1);
    return { min: v - span, max: v + span };
}

/**
 * STICKY growth for an EXISTING adaptive window. v1.19 re-centered the
 * window on every commit, which kept snapping the thumb back to the visual
 * midpoint ("слайдер всегда по центру" field report) and shifted the scale
 * mid-gesture. New contract: initial render centers ONCE; afterwards the
 * window only EXPANDS on the side the value escapes to - the rest of the
 * scale (and the thumb's meaning) stays put, exactly like a declared
 * static slider behaves.
 */
export function growSynthWindow(min, max, value) {
    let lo = Number.isFinite(Number(min)) ? Number(min) : NaN;
    let hi = Number.isFinite(Number(max)) ? Number(max) : NaN;
    const n = Number(value);
    const v = Number.isFinite(n) ? n : null;

    // Degenerate seed -> synthesize a sane bracket around the value.
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) {
        const s = Math.max(Math.abs(v ?? 0), 1);
        return { min: (v ?? 0) - s, max: (v ?? 0) + s };
    }

    const eps = (hi - lo) * 0.02; // tiny inset so the thumb never hugs dead stop
    if (v !== null && v < lo) lo = v - eps;
    else if (v !== null && v > hi) hi = v + eps;
    return { min: lo, max: hi };
}

// ---------------------------------------------------------------------------
// Per-binding slider overrides: custom min / max / step for numeric mirrors
// ---------------------------------------------------------------------------
// item.sliderOverride = { min?, max?, step?, applySliderOverride? }
// Stored in the hub config, so it survives reloads/presets like every other
// per-item field. An absent side means "no wall on this end" (the source's
// own declared bound still applies in that case). `applySliderOverride` is
// the user's consent (checkbox in the gear popup) to PUSH these numbers onto
// the REAL node widgets; it defaults to ON and drives session re-apply.

const OV_KEYS = ["min", "max", "step"];

/**
 * Normalized view of an item's slider override - only genuinely finite
 * numbers survive here ("", null, undefined, NaN and non-positive steps are
 * silently dropped), so callers can trust `"min" in result`.
 */
export function getSliderOverride(item) {
    const raw = item?.sliderOverride;
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const k of OV_KEYS) {
        const n = Number(raw[k]);
        if (raw[k] == null || raw[k] === "") continue;
        if (!Number.isFinite(n)) continue;
        if (k === "step" && !(n > 0)) continue;
        out[k] = n;
    }
    return out;
}

/**
 * Write an override onto a binding item with MERGE semantics:
 *  - a field present in `patch`  -> sets that wall/step;
 *  - a field null / "" / undef  -> CLEARS that side (source semantics back);
 *  - a field omitted entirely    -> keeps the previously stored value.
 * A full clear removes the whole key unless auto-apply persistence must be
 * remembered. Returns the normalized snapshot after the change.
 */
export function setSliderOverride(item, patch = {}, { autoApply } = {}) {
    if (!item || typeof item !== "object") return {};
    const prevFlag = item.sliderOverride?.applySliderOverride;
    // The native-options snapshot (taken at the FIRST push) must survive
    // rebuilds of this object: every Apply replaces item.sliderOverride, and
    // losing "native" there would make the next push re-capture the ALREADY
    // overwritten values as if they were node originals.
    const prevNative = item.sliderOverride?.native;
    // Contract: a BARE patch (no min/max/step keys at all) means "wipe the
    // override" (API-level wipe; the renderer's Clear button routes through
    // clearSliderOverride, which also RESTORES natives). Any explicit key
    // turns the call into a MERGE where null/"" clears that side and omitted
    // keys keep the previous value.
    const hasExplicitKeys =
        !!patch && OV_KEYS.some((k) => k in patch);
    let want = {};
    if (hasExplicitKeys) {
        want = { ...getSliderOverride(item) }; // merge base
        for (const k of OV_KEYS) {
            if (!(k in (patch || {}))) continue;
            const rawV = patch[k];
            if (rawV == null || rawV === "") { delete want[k]; continue; }
            const n = Number(rawV);
            if (!Number.isFinite(n)) continue;
            if (k === "step" && !(n > 0)) continue;
            want[k] = n;
        }
    }
    const flag =
        autoApply === undefined ? prevFlag : (autoApply === true);
    const keys = Object.keys(want);
    const carryNative = () => {
        if (prevNative !== undefined && prevNative !== null) {
            item.sliderOverride.native = prevNative;
        }
    };
    if (keys.length) {
        item.sliderOverride = { ...want };
        carryNative();
    } else if (flag === false) {
        item.sliderOverride = {}; // remember "never touch real widgets"
        carryNative();
    } else {
        delete item.sliderOverride;
        return {};
    }
    if (flag !== undefined && flag !== null) {
        item.sliderOverride.applySliderOverride = flag;
    }
    return getSliderOverride(item);
}

/**
 * Remove the override AND give back whatever the real widget carried before
 * the first push (native snapshot). Returns what happened:
 *   wiped=true   - config no longer carries sliderOverride;
 *   restored=true - native min/max/step(/precision/round) written back to a
 *                   resolved live widget. Restoring is best-effort: when the
 *                   target cannot be resolved right now the config is still
 *                   wiped (user asked), only nothing can be reverted on-node.
 */
export function clearSliderOverride(item) {
    if (!item || typeof item !== "object") return { wiped: false, restored: false };
    const raw = item.sliderOverride;
    let restored = false;
    const nat = raw?.native && typeof raw.native === "object" ? raw.native : null;
    if (nat) {
        try {
            const tn = resolveBindingTarget(item);
            const tw = findWidgetOnNode(tn, item.widgetToBind, item.widgetOrd);
            if (tn && tw && tw.options && typeof tw.options === "object") {
                for (const k of Object.keys(nat)) tw.options[k] = nat[k];
                try { (tn.graph ?? app.graph)?.setDirtyCanvas?.(true, true); } catch (_) {}
                restored = true;
            }
        } catch (_) { /* keep wiping even if resolution exploded */ }
    }
    delete item.sliderOverride; // native snapshot dies with the override
    return { wiped: true, restored };
}

/** True when at least one overridden field exists on this binding. */
export function hasSliderOverride(item) {
    const ov = getSliderOverride(item);
    return OV_KEYS.some((k) => k in ov);
}

/**
 * Final numeric geometry for a mirror row: source merge (with slider-step
 * relaxation) overlaid by the user override. Shape mirrors numericMerge's
 * contract so renderers can switch transparently.
 */
export function effectiveSliderParams(item, targetWidget) {
    const base = numericMerge(item, targetWidget);
    const ov = getSliderOverride(item);
    let min = "min" in ov ? ov.min : base.min;
    let max = "max" in ov ? ov.max : base.max;
    if (Number.isFinite(min) && Number.isFinite(max) && !(max > min)) {
        max = min + Math.abs(min || 1);
    }
    const isIntFamily = item?.widgetType === "int";
    const ovStep = "step" in ov ? ov.step : NaN;
    let sliderStep = Number.isFinite(ovStep) && ovStep > 0 ? ovStep : base.sliderStep;
    if (!(sliderStep > 0)) sliderStep = base.step > 0 ? base.step : 0.01;
    return {
        min,
        max,
        step: base.step,
        sliderStep,
        decimals: isIntFamily ? 0 : stepDecimals(sliderStep),
        isIntFamily,
        overridden: OV_KEYS.some((k) => k in ov),
    };
}

/**
 * Push override values ONTO the live widget(s) resolved for this binding -
 * feature request #3 ("применять кастомные настройки к виджету в реальной
 * ноде"). Only explicitly present fields are written; missing ones leave the
 * node untouched. The target canvas is marked dirty so native sliders repaint.
 * Returns 1 when applied to a live widget, 0 when resolution failed.
 */
export function applyOverrideToTargetWidgets(item) {
    const ov = getSliderOverride(item);
    if (!OV_KEYS.some((k) => k in ov)) return 0;
    // resolveBindingTarget returns the TARGET NODE itself (or null):
    // destructure defensively, never assume a {tn,tw} pair shape.
    const tn = resolveBindingTarget(item ?? {});
    const tw = findWidgetOnNode(tn, item.widgetToBind, item.widgetOrd);
    if (!tn || !tw) return 0;
    try {
        if (!tw.options || typeof tw.options !== "object") tw.options = {};

        // NATIVE SNAPSHOT - taken exactly once, BEFORE the first write, so
        // Clear can give the node back what IT carried (field report v22:
        // "reset сбрасывает не к настоящим значениям виджета"). Besides the
        // three overridden keys we also snapshot precision/round whenever
        // they exist, because the step-coherence block below may refine them.
        try {
            const rawOv = item.sliderOverride;
            if (rawOv && typeof rawOv === "object" && !rawOv.native) {
                const nat = {};
                for (const k of [...OV_KEYS, "precision", "round"]) {
                    if (k in tw.options) nat[k] = tw.options[k];
                }
                rawOv.native = nat;
            }
        } catch (_) { /* frozen configs must not break pushing */ }

        for (const k of OV_KEYS) {
            if (k in ov) tw.options[k] = ov[k];
        }

        // STEP COHERENCE (field report v22: "min/max применяется, а step -
        // нет"). Several frontends drive number-widget drag granularity from
        // options.precision / options.round and only use raw step for the
        // arrow zones. Writing step alone therefore looks like a no-op on
        // those widgets. If the widget ITSELF declares these fields, bring
        // them in line with the pushed step; never invent missing fields.
        if ("step" in ov) {
            const dec = stepDecimals(ov.step);
            if (tw.options.round != null) tw.options.round = ov.step;
            if (tw.options.precision != null &&
                Number.isFinite(Number(tw.options.precision))) {
                // Only ever RAISE display precision to be able to EXPRESS the
                // step ("1" -> precision 0 with step .25 would fight); never
                // shrink an existing finer one.
                tw.options.precision =
                    Math.max(Number(tw.options.precision), dec);
            }
        }

        try { (tn.graph ?? app.graph)?.setDirtyCanvas?.(true, true); } catch (_) {}
        return 1;
    } catch (_) {
        return 0;
    }
}

// Session-latch so structural renders never spam patches onto widgets:
// one re-apply per binding per page life (a fresh reload resets it, which is
// exactly when ComfyUI rebuilds widgets from their definitions).
const _overrideApplied = new Set();

/**
 * Called from renderHub self-heal: silently restores overrides onto freshly
 * (re)created node widgets AFTER a page reload, honoring the user's flag and
 * applying once per binding per session.
 */
export function maybeReapplySliderOverride(item) {
    if (!item?.sliderOverride || typeof item.sliderOverride !== "object") return false;
    if (item.sliderOverride.applySliderOverride === false) return false;
    if (item.type !== "widget_binding") return false;
    if (item.widgetType !== "int" && item.widgetType !== "slider") return false;
    if (_overrideApplied.has(item.id)) return false;
    _overrideApplied.add(item.id); // latched even if resolution fails this round
    return applyOverrideToTargetWidgets(item) === 1;
}

/** Test hook: forget the per-session latch. */
export function resetOverrideAppliedTracking() {
    _overrideApplied.clear();
}

/**
 * Coerce any incoming value into a number against the REAL merged options.
 * quantize=false is used for MANUAL typed commits: values keep their exact
 * decimals (no step-grid snapping) and are only kept inside DECLARED bounds;
 * open-ended sides pass through untouched. Accepts comma decimals (ru).
 */
export function coerceNumeric(value, item, targetWidget, prevValue, opts = {}) {
    const o = numericMerge(item, targetWidget);
    const rawStr = typeof value === "string" && value.includes(",")
        ? value.replace(/\s/g, "").replace(",", ".")
        : value;
    let n = Number(typeof rawStr === "number" ? rawStr : parseFloat(String(rawStr)));
    if (!Number.isFinite(n)) n = Number(prevValue);
    if (!Number.isFinite(n)) n = Number.isFinite(o.min) ? o.min : 0;
    // User-authored slider overrides are DECLARED walls for this binding:
    // they clamp manual commits exactly like source-declared bounds do, on
    // top of (and in addition to) whatever the source widget declares.
    const ov = getSliderOverride(item);
    let lo = o.min;
    let hi = o.max;
    if ("min" in ov) lo = Number.isFinite(lo) ? Math.max(lo, ov.min) : ov.min;
    if ("max" in ov) hi = Number.isFinite(hi) ? Math.min(hi, ov.max) : ov.max;
    if (Number.isFinite(lo)) n = Math.max(lo, n);
    if (Number.isFinite(hi)) n = Math.min(hi, n);
    if (item?.widgetType === "int") n = Math.round(n);
    else if (opts.quantize !== false) n = Number(n.toFixed(o.decimals));
    else n = Number(n.toPrecision(10)); // strip float noise, keep user digits
    return n;
}

/** Fetch fresh combo values from the live widget, falling back to snapshot. */
export function liveComboValues(item, targetWidget) {
    const fresh = targetWidget ? extractComboValues(targetWidget) : null;
    if (fresh && fresh.length) return fresh;
    const snap = Array.isArray(item?.options?.values)
        ? item.options.values.map((v) => String(v))
        : [];
    return snap;
}

// ---------------------------------------------------------------------------
// Binding lifecycle
// ---------------------------------------------------------------------------

/**
 * True when the widget cannot be mirrored as a primitive control and must be
 * embedded as a live portal instead. Universal rule - no per-node code:
 * anything that is not combo/toggle/text/number and whose value is not a
 * primitive (rgthree Power Lora Loader lists, image pickers, custom panels)
 * qualifies.
 */
export function isPortalWidget(widget) {
    return detectWidgetType(widget) === "portal";
}

/** Portal embed flavor: real DOM element (relocate) vs canvas-drawn. */
export function portalKindOf(widget) {
    const el = widget?.element ?? widget?.inputEl ?? widget?.contentEl;
    return el && typeof el.appendChild === "function" ? "dom" : "canvas";
}

// ---------------------------------------------------------------------------
// Internal widgets (v26.1): the ComfyUI frontend parks hidden helper widgets
// on nodes with names like "$$canvas-image-preview" (the DOM container that
// actually SHOWS PreviewImage/SaveImage/VideoCombine previews). They are
// implementation details: binding one mirrors an opaque value into a useless
// text field, and they must never surface in pin menus. The same DOM
// container is exactly what a viewer embed wants - see findNodeMediaWidget.
// ---------------------------------------------------------------------------

/** True for frontend-internal helper widgets ("$$...") - never pinnable. */
export function isInternalWidget(widget) {
    try {
        const n = widget?.name;
        return typeof n === "string" && n.startsWith("$$");
    } catch (_) { return false; }
}

/**
 * The node's DOM widget that carries live MEDIA (img / video / canvas).
 * New-frontend PreviewImage / SaveImage / VideoCombine builds render their
 * preview through such a hidden widget - no canvas painter involved. Returns
 * the WIDGET so the portal can ghost-mirror its element (the media comes
 * along); null when the node owns no media widget.
 */
export function findNodeMediaWidget(node) {
    for (const w of node?.widgets ?? []) {
        const el = w?.element ?? w?.inputEl ?? w?.contentEl;
        if (!el) continue;
        try {
            if (el.tagName === "IMG" || el.tagName === "VIDEO"
                || el.tagName === "CANVAS") return w;
            if (typeof el.querySelector === "function"
                && el.querySelector("img,video,canvas")) return w;
        } catch (_) { /* exotic element - keep scanning */ }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Viewer nodes (v26): "вынести вьювер с картинкой/видео в хаб"
// ---------------------------------------------------------------------------
// Many viewers do NOT own a widget at all: classic PreviewImage / LoadImage /
// SaveImage builds paint their image straight in node.onDrawBackground, and
// plenty of custom nodes (video combiners, feed viewers, gallery panels) do
// the same. There is nothing to right-click, so pinning by widget can never
// see them. For those we offer a NODE-level pin: the portal canvas re-renders
// the node's own onDrawBackground, which reproduces the viewer 1:1 - exactly
// the pixels the user sees on the source node, custom node or not.

/** Sentinel widgetToBind for node-level viewer portals (no real widget). */
export const VIEWER_SENTINEL = "__viewer__";

const VIEWER_NAME_RE = /preview|viewer|image|video|media|combine|show/i;
const VIEWER_MEDIA_KEYS = [
    "images", "imgs", "image", "videos", "video", "media", "previewImages",
];

/**
 * A node that RENDERS media (a viewer). Two universal surfaces qualify:
 *   - classic builds paint media in node.onDrawBackground (canvas painter);
 *   - new-frontend builds show it through a hidden DOM media widget
 *     ("$$canvas-image-preview" container with img/video/canvas inside).
 * Qualification (either): the node already carries media state (post-exec),
 * its type name looks like a viewer, or it owns a DOM media widget. The name
 * check alone keeps the menu entry discoverable BEFORE the first generation
 * (PreviewImage / LoadImage / SaveImage / VHS_VideoCombine / ...).
 */
export function isViewerNode(node) {
    if (!node || node.type === HUB_NODE_NAME) return false;
    let painter = false;
    try { painter = typeof node.onDrawBackground === "function"; } catch (_) { painter = false; }
    let mediaWidget = false;
    try { mediaWidget = !!findNodeMediaWidget(node); } catch (_) { mediaWidget = false; }
    if (!painter && !mediaWidget) return false;
    for (const k of VIEWER_MEDIA_KEYS) {
        let v;
        try { v = node[k]; } catch (_) { continue; }
        if (Array.isArray(v) ? v.length > 0 : (v != null && v !== "" && v !== false)) return true;
    }
    try { return VIEWER_NAME_RE.test(String(node.type ?? "")); } catch (_) { return false; }
}

/**
 * Bind a VIEWER NODE (not a widget) as one live canvas embed. The portal
 * re-renders the node's own onDrawBackground - the universal viewer surface.
 * Persisted like every other item; presets deliberately skip portals.
 */
export function createViewerBinding(node, targetNode, tabId, label) {
    const cfg = getHubConfig(node);
    const item = {
        id: genId("item"),
        type: "widget_portal",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: label || targetNode?.title || "viewer",
        targetNodeId: targetNode.id,
        targetTitle: targetNode?.title ?? "",   // drift repair anchor
        widgetToBind: VIEWER_SENTINEL,
        widgetType: "portal",
        options: {
            portalKind: "canvas",
            viewer: true,
            srcH: Math.max(60, Math.round(Number(targetNode?.size?.[1]) || 200)),
        },
    };
    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

// ---------------------------------------------------------------------------
// v40 node-UI pins: canvas-drawn widgetless control nodes (Pixaroma
// Switch / Mute Switch pattern). Their rows are painted in
// node.onDrawForeground and hit-tested in node.onMouseDown - there is
// NO widget to pin, so the widget-based menus never saw them. The
// canvas portal already renders onDrawForeground 1:1 and forwards
// pointer events with node-local coordinates, so the whole node UI
// joins the hub LIVE: toggles keep working from the pinned embed.
// Reuses the viewer binding shape (VIEWER_SENTINEL + options.viewer)
// so row rendering / orphan handling / persistence behave identically;
// the extra options.controls flag routes the mount STRAIGHT to the
// foreground painter (no media/gallery attempts) and flips the row
// tag to "🎛 live".
// ---------------------------------------------------------------------------

/**
 * Bind a canvas-drawn widgetless node (Switch / Mute Switch pattern) as
 * ONE live node-UI embed. Same persistence as a viewer binding;
 * options.controls routes the portal mount to the onDrawForeground
 * painter directly. Persisted like every other item; presets skip
 * portals already.
 */
export function createNodeUIBinding(node, targetNode, tabId, label) {
    const cfg = getHubConfig(node);
    const item = {
        id: genId("item"),
        type: "widget_portal",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: label || targetNode?.title || "node UI",
        targetNodeId: targetNode.id,
        targetTitle: targetNode?.title ?? "",   // drift repair anchor
        widgetToBind: VIEWER_SENTINEL,
        widgetType: "portal",
        options: {
            portalKind: "canvas",
            viewer: true,
            controls: true,
            srcH: Math.max(60, Math.round(Number(targetNode?.size?.[1]) || 200)),
        },
    };
    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

// ---------------------------------------------------------------------------
// Group portals ("whole panel" embeds)
// ---------------------------------------------------------------------------
// Custom panels are often drawn by SEVERAL sibling widgets on one node
// (rgthree Power Lora Loader: a header widget, one widget per lora row, a
// divider). Pinning them individually reproduces fragments only - users want
// THE PANEL. A group portal binds all portal-classified widgets of a node
// into ONE item whose members are stacked onto a shared canvas, mirroring
// how the node itself stacks them vertically. Still fully universal.

/** Vertical breathing room LiteGraph leaves between stacked widget rows. */
export const PORTAL_ROW_GAP = 4;

/** Best-effort current painted height of a widget row, in px. */
export function widgetNativeHeight(widget, fallback = 30) {
    let h = Number(widget?.height);
    if (!Number.isFinite(h) || h <= 0) {
        try { h = Number(widget?.computeSize?.()?.[1]); } catch (_) { h = NaN; }
    }
    if (!Number.isFinite(h) || h <= 0) h = Number(widget?.options?.height);
    if (!Number.isFinite(h) || h <= 0) h = Number(fallback);
    return Number.isFinite(h) && h > 0 ? h : 30;
}

/**
 * Bind SEVERAL portal widgets of one node as a single live embed.
 * members[] persists name+height so reloads survive; live geometry is still
 * re-read every frame by the portal renderer (rows grow/shrink dynamically).
 */
// ---------------------------------------------------------------------------
// v30: media-source loaders (LoadImage / LoadVideo / LoadAudio + customs).
// Detection mirrors the frontend's own upload extension: media combos carry
// flags in their options (image_upload / video_upload / audio_upload /
// animated_image_upload). Fallback: the node carries its OWN onDragOver and
// onDrop instance props (installed by the upload composables) - or, v39,
// litegraph's own onDropFile file-drop hook (TrixLoader "Load Image AIO"
// wires that one; it has no flags, no upload widget, no composables) -
// next to a media-ish combo. Returns {combo, kind, folder} or null.
// ---------------------------------------------------------------------------

const MEDIA_FLAG_KINDS = [
    ["video_upload", "video"],
    ["audio_upload", "audio"],
    ["animated_image_upload", "image"],
    ["image_upload", "image"],
];

function mediaKindOfWidget(widget) {
    const o = widget?.options || {};
    for (const [flag, kind] of MEDIA_FLAG_KINDS) {
        if (o[flag]) return kind;
    }
    return null;
}

function isDeadButtonWidget(w) {
    const t = (typeof w?.type === "string" ? w.type : "").trim().toLowerCase();
    return t === "button" && typeof w?.callback !== "function";
}

export function mediaLoaderInfo(targetNode) {
    if (!targetNode || targetNode.type === HUB_NODE_NAME) return null;
    let flagged = null;
    let mediaish = null;
    for (const w of targetNode.widgets ?? []) {
        try {
            if (isDeadButtonWidget(w) || isInternalWidget(w)) continue;
            const kind = mediaKindOfWidget(w);
            if (kind) { flagged = { combo: w, kind }; break; }
            if (!mediaish && detectWidgetType(w) === "combo") {
                const nm = String(w.name ?? "");
                if (/image|video|audio|file/i.test(nm)) {
                    mediaish = {
                        combo: w,
                        kind: /video/i.test(nm) ? "video"
                            : /audio/i.test(nm) ? "audio" : "image",
                    };
                }
            }
        } catch (_) { /* exotic getters must not kill detection */ }
    }
    let hit = flagged;
    if (!hit && mediaish) {
        // Any real upload wiring qualifies the node: upload composables
        // install onDragOver/onDrop as INSTANCE props; the upload button
        // widget is named "upload" (modern) / carries "upload" (legacy);
        // classic LoadImage builds expose node.pasteFiles. Field report
        // v30.1: a plain Load Image showed no media entry - rely on more
        // than one signal.
        const ownDrop =
            Object.prototype.hasOwnProperty.call(targetNode, "onDragOver") &&
            Object.prototype.hasOwnProperty.call(targetNode, "onDrop");
        // v39: litegraph's own file-drop hook - an INSTANCE prop (TrixLoader
        // "Load Image AIO" sets node.onDropFile in onNodeCreated; the
        // prototype does not declare it, so the hasOwnProperty test stays
        // strict and nodes without the wiring keep qualifying as before).
        const ownDropFile =
            Object.prototype.hasOwnProperty.call(targetNode, "onDropFile");
        const hasUploadBtn = (targetNode.widgets || []).some((w) =>
            (typeof w?.type === "string" && w.type.toLowerCase() === "button") &&
            /upload/i.test(String(w.name ?? "")) &&
            typeof w.callback === "function");
        const hasPaste = typeof targetNode.pasteFiles === "function";
        if (ownDrop || ownDropFile || hasUploadBtn || hasPaste) hit = mediaish;
    }
    if (!hit) return null;
    return {
        combo: hit.combo,
        kind: hit.kind,
        folder: String(hit.combo?.options?.image_folder ?? "input"),
    };
}

/**
 * v30: pin a MEDIA-SOURCE loader as ONE enriched row - the searchable file
 * combo, an input-file preview (from the output store, type=input) and an
 * upload affordance (native picker + drag&drop routed through the node's
 * own onDrop pipeline, falling back to /upload/image).
 */
export function createMediaBinding(node, targetNode, info, tabId, label) {
    const cfg = getHubConfig(node);
    if (!info?.combo) return null;
    const item = {
        id: genId("item"),
        type: "widget_binding",
        widgetType: "media",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: label || targetNode?.title || info.combo.name || "media",
        targetNodeId: targetNode.id,
        targetTitle: targetNode?.title ?? "",
        widgetToBind: info.combo.name,
        widgetOrd: sameNameOrdinal(targetNode, info.combo),
        options: { media: { kind: info.kind || "image", folder: info.folder || "input" } },
    };
    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

/** Index of `widget` among the target node's widgets sharing its name
 * (0 for unique names). Stored on bindings so same-name widget families
 * resolve to the exact row they were pinned from (v30). */
function sameNameOrdinal(targetNode, widget) {
    // v34: hostile name getters (exotic custom widgets) must not kill the
    // binding - and via the scan below they must not kill the binding of
    // their INNOCENT SIBLINGS either (the batch picker walks whole nodes).
    let ownName;
    try { ownName = widget?.name; } catch (_) { return 0; }
    const list = [];
    for (const w of targetNode?.widgets || []) {
        try { if (w && w.name === ownName) list.push(w); } catch (_) {}
    }
    const i = list.indexOf(widget);
    return i > 0 ? i : 0;
}

export function createPortalBinding(node, targetNode, widgets, tabId, label) {
    const cfg = getHubConfig(node);
    const list = (Array.isArray(widgets) ? widgets : [widgets]).filter(Boolean);
    if (!list.length) return null;

    const primary = list[0];
    const item = {
        id: genId("item"),
        type: "widget_portal",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: label || primary.label || primary.name || targetNode?.title || "panel",
        targetNodeId: targetNode.id,
        targetTitle: targetNode?.title ?? "",  // drift repair anchor (see resolveBindingTarget)
        widgetToBind: primary.name ?? "",
        widgetType: "portal",
        members: list.map((w) => ({
            name: w.name ?? "",
            ord: sameNameOrdinal(targetNode, w),
            srcH: Math.round(widgetNativeHeight(w)),
        })),
    };
    const totalH =
        item.members.reduce((acc, m) => acc + m.srcH, 0) +
        PORTAL_ROW_GAP * (item.members.length - 1);
    item.options = { portalKind: "canvas", srcH: totalH };
    if (list.length > 1) item.options.grouped = true;

    cfg.items.push(item);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

function makeBindingItem(node, targetNode, widget, tabId, type, extra) {
    const cfg = getHubConfig(node);
    const item = {
        id: genId("item"),
        type: type || "widget_binding",
        tabId,
        order: nextOrder(cfg, tabId),
        customLabel: "",
    };
    if (type === "divider") {
        item.customLabel = extra?.label || "Section";
    } else if (isPortalWidget(widget)) {
        // Custom widget (custom panel, lora list, ...): live embed instead of
        // a value mirror. Presets deliberately do NOT cover portals - there
        // is no universal way to write complex widget states back.
        item.type = "widget_portal";
        item.targetNodeId = targetNode.id;
        item.widgetToBind = widget.name;
        item.widgetOrd = sameNameOrdinal(targetNode, widget);
        item.widgetType = "portal";
        item.customLabel = extra?.label || widget.label || widget.name || "panel";
        let srcH = Number(widget.height ?? widget.options?.height);
        if (!Number.isFinite(srcH) || srcH <= 0) srcH = 60;
        item.options = { portalKind: portalKindOf(widget), srcH: Math.round(srcH) };
    } else {
        item.targetNodeId = targetNode.id;
        item.targetTitle = targetNode?.title ?? ""; // drift repair anchor
        item.widgetToBind = widget.name;
        item.widgetOrd = sameNameOrdinal(targetNode, widget);
        item.widgetType = detectWidgetType(widget);           // fixed detection
        item.customLabel = extra?.label || widget.label || widget.name || "";
        const values = extractComboValues(widget);
        if (values) {
            item.options = { values };
        } else if (widget.options && (widget.options.min != null || widget.options.max != null)) {
            item.options = {
                min: widget.options.min,
                max: widget.options.max,
                step: widget.options.step,
            };
        } else {
            // Text-family binding: remember multiline so the hub renders a
            // growing <textarea> instead of a single-line input.
            item.options = isMultilineWidget(widget) ? { multiline: true } : {};
        }
    }
    cfg.items.push(item);
    return item;
}

export function createBinding(node, targetNode, widget, tabId, type, extra) {
    const item = makeBindingItem(node, targetNode, widget, tabId, type, extra);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
    return item;
}

/** v34 batch add: N widgets -> N items with ONE re-render. Mirrors the
 *  single createBinding side effects exactly (pin badges, canvas, sync),
 *  just coalesced - a 10-widget pick must not rebuild the hub 10 times.
 *  Portals among the widgets are created by makeBindingItem too (the same
 *  isPortalWidget branch as the single path); one exotic widget failing
 *  must not sink the rest of the batch. */
export function createBindingsBulk(node, targetNode, widgets, tabId) {
    const cfg = getHubConfig(node);
    const made = [];
    for (const w of Array.isArray(widgets) ? widgets : []) {
        try {
            const before = cfg.items.length;
            makeBindingItem(node, targetNode, w, tabId);
            if (cfg.items.length > before) made.push(cfg.items[cfg.items.length - 1]);
        } catch (_) { /* one exotic widget must not sink the batch */ }
    }
    if (made.length) {
        Pins.invalidatePins();
        node.setDirtyCanvas(true, true);
        syncNode(node);
    }
    return made;
}

/** Remove an item (binding or divider) from hub config with pin invalidation. */
export function removeItem(node, item) {
    const cfg = getHubConfig(node);
    const idx = cfg.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) cfg.items.splice(idx, 1);
    Pins.invalidatePins();
    node.setDirtyCanvas(true, true);
    syncNode(node);
}

// ---------------------------------------------------------------------------
// Hub creation helper (context menu -> Create New Settings Hub)
// ---------------------------------------------------------------------------

function getRootGraph() {
    const candidates = [];
    try {
        if (app && app.graph && typeof app.graph.add === "function") candidates.push(app.graph);
        if (app && app.canvas && app.canvas.graph) candidates.push(app.canvas.graph);
    } catch (_) {}
    try {
        const store = window.comfyAPI && window.comfyAPI.app;
        if (store && store.graph) candidates.push(store.graph);
    } catch (_) {}
    for (const g of candidates) {
        if (g && (typeof g.add === "function" || typeof g.addNode === "function")) return g;
    }
    return null;
}

/**
 * Create a hub node on the ROOT graph - the CANONICAL way.
 *
 * History: we used to call graph.addNode({ type }) with a plain CONFIG
 * OBJECT. Legacy builds tolerated it; the modern ComfyUI frontend's
 * LGraph.add() dereferences real-node methods on the argument and dies with
 * "TypeError: e.snapToGrid is not a function", leaving NOTHING behind.
 * The only correct sequence is LiteGraph.createNode(type) -> graph.add(
 * INSTANCE): the instance is a true LGraphNode subclass, so every graph
 * bookkeeping path works exactly like a manual drag-in.
 */
export function createNewHub() {
    const graph = getRootGraph();
    if (!graph) {
        alert("Create New Settings Hub: no graph available");
        return null;
    }

    let node = null;
    try {
        const LG = window.LiteGraph;
        if (LG && typeof LG.createNode === "function") {
            node = LG.createNode(HUB_NODE_NAME);
        }
    } catch (_) { /* fall through to the ctor fallback */ }

    if (!node) {
        try {
            const Ctor = window.LiteGraph?.registered_node_types?.[HUB_NODE_NAME];
            if (Ctor) node = new Ctor();
        } catch (err) {
            console.warn("Create New Settings Hub failed:", err);
        }
    }

    if (!node) {
        console.warn("Create New Settings Hub: node type not registered yet");
        alert("Settings Hub node type is still loading - try again in a second.");
        return null;
    }

    try {
        graph.add(node);   // real instance - NEVER a bare {type} config object
    } catch (err) {
        console.warn("Create New Settings Hub failed:", err);
        alert("Could not add the Settings Hub node to the canvas:\n" + err?.message);
        return null;
    }
    node.title = "Settings Hub";
    try {
        const canvas = app.canvas;
        const pos = (canvas && canvas.graph_mouse) || (app.graph && app.graph.pos);
        if (pos && pos.length >= 2) {
            node.pos = [pos[0] + 40, pos[1] + 40];
        }
    } catch (_) {}
    getHubConfig(node);
    Pins.invalidatePins();
    syncNode(node);
    // Registry safety net: normally extension nodeCreated does this during
    // graph.add - but programmatic adds must never depend on that dispatch.
    try { trackHubNode(node); } catch (_) {}
    return node;
}
