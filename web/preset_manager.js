import { app } from "../../scripts/app.js";
import {
    getHubConfig, getActiveTabId, itemsOfTab, resolveBindingTarget,
    liveComboValues, coerceNumeric, findWidgetOnNode,
} from "./core.js";
import { writeTargetValue } from "./sync_manager.js";
import { syncNode, refreshNodeValues } from "./sync.js";
import * as Pins from "./pins.js";

/**
 * Presets 2.0 (v28) - tab-scoped presets with metadata, per-row opt-out,
 * inspect-before-apply and undo.
 *
 * Storage stays in cfg.presets (rides with the graph), but the FORMAT is now:
 *
 *   cfg.presets[name] = {
 *       v: 2,                 // format version
 *       ts: <epoch ms>,       // when captured
 *       scope: "<tabId>",     // ACTIVE tab at capture time
 *       entries: [{           // value bindings of that tab only
 *           itemId,           // hub row reference
 *           label,            // human-readable (for the apply popover)
 *           widgetType,       // combo/text/int/float/slider/checkbox
 *           value,            // captured value
 *           nodeId, widget,   // stable-key fallback (see resolveEntryItem)
 *       }],
 *   };
 *
 * Rows are excluded from capture via the per-row 💾 chip (v29: a BUTTON,
 * not a checkbox - on checkbox rows it used to read as a second value
 * box): chip off -> item.inPreset === false (never captured); absent flag
 * = participates. Records also carry optional capture-time metadata:
 * excluded (how many value rows were opted out at capture) and fav
 * (picker favorite).
 * The old flat {itemId: value} format is NOT migrated on purpose - no v1
 * presets exist in the wild (user decision, plan v28).
 */

// ---------------------------------------------------------------------------
// Capture (💾)
// ---------------------------------------------------------------------------

/**
 * Snapshot the value bindings of the ACTIVE tab into a v2 preset record.
 * Buttons carry no value state, portals are not widget bindings, and rows
 * opted out via the per-row checkbox are skipped.
 */
export function captureActiveTab(node) {
    const cfg = getHubConfig(node);
    const tabId = getActiveTabId(cfg);
    const entries = [];
    let excluded = 0; // v29: value rows opted out via the chip (meta only)
    for (const item of itemsOfTab(cfg, tabId)) {
        if (item.type !== "widget_binding" || item.widgetType === "button") continue;
        if (item.inPreset === false) { excluded++; continue; }
        // Prefer live value mirrored on the target node; fall back to the
        // hub's own DOM mirror (same fallback chain as v1 snapshots).
        const targetNode = resolveBindingTarget(item);
        const widget = findWidgetOnNode(targetNode, item.widgetToBind, item.widgetOrd);
        let value;
        if (widget && widget.value !== undefined) {
            value = widget.value;
        } else {
            const input = document.querySelector(
                `[data-hub-item="${item.id}"] [data-hub-control]`,
            );
            if (!input) continue;
            value = input.type === "checkbox" ? input.checked : input.value;
        }
        entries.push({
            itemId: item.id,
            label: item.customLabel || widget?.label || item.widgetToBind || item.id,
            widgetType: item.widgetType || "text",
            value,
            nodeId: targetNode ? targetNode.id : null,
            widget: item.widgetToBind || null,
        });
    }
    return { v: 2, ts: Date.now(), scope: tabId, excluded, entries };
}

function tabNameOf(cfg, tabId) {
    return cfg.tabs?.find((t) => t.id === tabId)?.name || tabId || "?";
}

/**
 * Save the ACTIVE tab snapshot under `name` (overwrite of an existing name
 * is confirmed). v29: the NAME always comes from the quick-save popover -
 * the native prompt() is gone; a null/empty name is a no-op. Returns the
 * name or null (declined / nothing to save under).
 */
export function presetSave(node, name) {
    const cfg = getHubConfig(node);
    name = String(name ?? "").trim();
    if (!name) return null;
    const exists = (n) => Object.prototype.hasOwnProperty.call(cfg.presets, n);

    const snap = captureActiveTab(node);
    // v28: overwriting an existing preset is CONFIRMED (was silent before).
    if (exists(name)) {
        const ok = confirm(
            `Overwrite preset "${name}"?\n` +
            `${snap.entries.length} value(s) from tab "${tabNameOf(cfg, snap.scope)}" ` +
            `will replace its current content.`,
        );
        if (!ok) return null;
    }

    cfg.presets[name] = snap;
    Pins.repaint(app);
    syncNode(node);
    node.setDirtyCanvas(true, true);
    return name;
}

/**
 * v29 merge capture: snapshot the ACTIVE tab and merge it into an EXISTING
 * preset. An incoming entry updates an existing one matched by itemId,
 * falling back to the stable key (nodeId + widget); unmatched entries are
 * appended. scope/ts/excluded refresh from the snapshot (last capture
 * wins). Returns {added, updated} or null when the target is missing.
 */
export function presetMergeInto(node, name) {
    const cfg = getHubConfig(node);
    const dst = cfg.presets[name];
    if (!dst || typeof dst !== "object" || !Array.isArray(dst.entries)) return null;
    const snap = captureActiveTab(node);
    let updated = 0;
    for (const inc of snap.entries) {
        const at = dst.entries.findIndex((e) =>
            e.itemId === inc.itemId ||
            (inc.nodeId != null && inc.widget &&
                e.nodeId === inc.nodeId && e.widget === inc.widget));
        if (at >= 0) { dst.entries[at] = { ...inc }; updated++; }
        else dst.entries.push({ ...inc });
    }
    dst.ts = snap.ts;
    dst.scope = snap.scope;
    if (snap.excluded) dst.excluded = snap.excluded; else delete dst.excluded;
    persistAndRepaint(node);
    return { added: snap.entries.length - updated, updated };
}

export function presetDelete(node, name) {
    const cfg = getHubConfig(node);
    if (!name || cfg.presets[name] === undefined) return false;
    delete cfg.presets[name];
    syncNode(node);
    node.setDirtyCanvas(true, true);
    return true;
}

// ---------------------------------------------------------------------------
// Apply: build a plan -> user inspects -> selected rows are written
// ---------------------------------------------------------------------------

/**
 * Stable-key resolution (plan v28, phase 3): resolve an entry's hub row by
 * itemId first; if the row died (unpinned + re-pinned), fall back to the
 * SAME widget binding identified by nodeId + widget name.
 */
function resolveEntryItem(cfg, entry) {
    const byId = cfg.items.find((i) => i.id === entry.itemId);
    if (byId) return byId;
    if (entry.nodeId == null || !entry.widget) return null;
    return cfg.items.find((i) =>
        i.type === "widget_binding" &&
        i.widgetToBind === entry.widget &&
        resolveBindingTarget(i)?.id === entry.nodeId) || null;
}

/**
 * Build the inspection model for the apply popover. Every entry gets a row:
 *   ok            - will apply (value validated / clamped)
 *   missing-item  - hub row gone entirely (shown ⚠, not applied)
 *   missing-widget- target node/widget not found (shown ⚠, not applied)
 *   combo-invalid - value is not among the CURRENT combo options (⚠, skipped)
 * plus a drift flag when the widget value changed since capture.
 */
export function buildApplyPlan(node, presetName) {
    const cfg = getHubConfig(node);
    const preset = cfg.presets?.[presetName];
    if (!preset || typeof preset !== "object" || !Array.isArray(preset.entries)) return null;

    const rows = preset.entries.map((entry) => {
        const row = { entry, status: "ok", value: entry.value, drift: false };
        const item = resolveEntryItem(cfg, entry);
        if (!item || item.type !== "widget_binding" || item.widgetType === "button") {
            row.status = "missing-item";
            return row;
        }
        row.item = item;
        const targetNode = resolveBindingTarget(item);
        const widget = findWidgetOnNode(targetNode, item.widgetToBind, item.widgetOrd);
        if (!targetNode || !widget) {
            row.status = "missing-widget";
            return row;
        }
        row.targetNode = targetNode;
        row.widget = widget;
        row.drift = widget.value !== undefined &&
            String(widget.value) !== String(entry.value);

        // Validation + clamping (plan v28, phase 2). Combo options come from
        // the LIVE widget; numeric values are clamped by coerceNumeric which
        // also honors the hub's per-row slider overrides.
        const t = item.widgetType;
        if (t === "combo") {
            const vals = liveComboValues(item, widget).map(String);
            if (vals.length && !vals.includes(String(entry.value))) {
                row.status = "combo-invalid";
                return row;
            }
            row.value = String(entry.value);
        } else if (t === "slider" || t === "int" || t === "float" || t === "number") {
            row.value = coerceNumeric(entry.value, item, widget, widget.value, { quantize: false });
        } else if (t === "checkbox") {
            row.value = !!entry.value;
        } else {
            row.value = String(entry.value);
        }
        return row;
    });

    return {
        name: presetName,
        preset,
        rows,
        scopeName: tabNameOf(cfg, preset.scope),
    };
}

/**
 * Write the selected rows of a plan. `selected` is an array of row indexes
 * (partial apply); null/undefined applies every ok row. Rows are validated
 * AGAIN at write time (they may have gone stale since the popover opened),
 * deduplicated per item, and every write goes through writeTargetValue so
 * the shared edit-lock contract holds.
 */
export function applyPlan(node, plan, selected) {
    if (!plan?.preset) return { applied: 0, skipped: 0 };
    const idxs = Array.isArray(selected)
        ? selected
        : plan.rows.map((_, i) => i);

    const writable = [];
    const seenItems = new Set();
    let skipped = 0;
    for (const i of idxs) {
        const row = plan.rows[i];
        if (!row || row.status !== "ok" || !row.targetNode || !row.widget) {
            skipped++;
            continue;
        }
        if (seenItems.has(row.item.id)) { skipped++; continue; }
        seenItems.add(row.item.id);
        writable.push(row);
    }

    // Undo snapshot BEFORE the first write: CURRENT values of exactly the
    // rows we are about to change (plan v28: one level, session memory).
    const undoEntries = writable.map((row) => ({
        itemId: row.item.id,
        value: row.widget.value,
    }));

    for (const row of writable) {
        writeTargetValue(row.targetNode, row.widget, row.value);
    }

    if (writable.length) {
        undoState = { node, name: plan.name, entries: undoEntries, ts: Date.now() };
    }
    // The wrapped target callbacks stay silent while the edit lock is held,
    // so the hub mirrors must be refreshed explicitly once ALL writes are
    // done (same contract as the v1 presetApply).
    refreshNodeValues(node);
    (node.graph ?? app.graph)?.setDirtyCanvas?.(true, true);
    return { applied: writable.length, skipped };
}

// ---------------------------------------------------------------------------
// Undo (one level, session memory - deliberately NOT in cfg: undo must not
// bloat the workflow JSON and intentionally does not survive a reload)
// ---------------------------------------------------------------------------

let undoState = null; // { node, name, entries: [{itemId, value}], ts }

export function presetUndoAvailable(node) {
    return !!(undoState && undoState.node === node);
}

/** Preset name the pending undo came from (for the button tooltip). */
export function presetUndoLabel() {
    return undoState ? undoState.name : null;
}

export function presetUndo(node) {
    if (!presetUndoAvailable(node)) return false;
    const st = undoState;
    undoState = null; // consume: one level deep
    const cfg = getHubConfig(node);
    let restored = 0;
    for (const e of st.entries) {
        const item = cfg.items.find((i) => i.id === e.itemId);
        if (!item) continue;
        const tn = resolveBindingTarget(item);
        const w = findWidgetOnNode(tn, item.widgetToBind, item.widgetOrd);
        if (!w) continue;
        writeTargetValue(tn, w, e.value);
        restored++;
    }
    if (restored) {
        refreshNodeValues(node);
        (node.graph ?? app.graph)?.setDirtyCanvas?.(true, true);
    }
    return restored > 0;
}

/** Test hook: drop the pending undo (smoke tests). */
export function resetPresetUndo() {
    undoState = null;
}

// ---------------------------------------------------------------------------
// Tools: rename / duplicate / clean dead entries / export / import
// ---------------------------------------------------------------------------

function persistAndRepaint(node) {
    syncNode(node);
    node.setDirtyCanvas(true, true);
}

export function presetRename(node, oldName, newName) {
    const cfg = getHubConfig(node);
    newName = String(newName ?? "").trim();
    if (!oldName || !cfg.presets[oldName] || !newName) return false;
    if (newName === oldName) return true;
    if (cfg.presets[newName] &&
        !confirm(`Preset "${newName}" exists. Replace it with the renamed "${oldName}"?`)) {
        return false;
    }
    // Rebuild the key map in place to PRESERVE the dropdown order.
    const next = {};
    for (const [k, v] of Object.entries(cfg.presets)) {
        next[k === oldName ? newName : k] = v;
    }
    cfg.presets = next;
    persistAndRepaint(node);
    return true;
}

export function presetDuplicate(node, name, newName) {
    const cfg = getHubConfig(node);
    newName = String(newName ?? "").trim();
    const src = name ? cfg.presets[name] : null;
    if (!src || !newName) return false;
    if (cfg.presets[newName] &&
        !confirm(`Preset "${newName}" exists. Overwrite it with the copy of "${name}"?`)) {
        return false;
    }
    cfg.presets[newName] = JSON.parse(JSON.stringify(src));
    persistAndRepaint(node);
    return true;
}

/** Count entries whose hub row cannot be resolved anymore (id + stable key). */
export function presetCountDead(node, name) {
    const cfg = getHubConfig(node);
    const preset = cfg.presets?.[name];
    if (!preset || !Array.isArray(preset.entries)) return 0;
    return preset.entries.filter((entry) => !resolveEntryItem(cfg, entry)).length;
}

export function presetCleanDead(node, name) {
    const cfg = getHubConfig(node);
    const preset = cfg.presets?.[name];
    if (!preset || !Array.isArray(preset.entries)) return 0;
    const alive = preset.entries.filter((entry) => !!resolveEntryItem(cfg, entry));
    const removed = preset.entries.length - alive.length;
    if (removed > 0) {
        preset.entries = alive;
        persistAndRepaint(node);
    }
    return removed;
}

/** v29: toggle the picker favorite flag (favorites float to the top). */
export function presetFavToggle(node, name) {
    const cfg = getHubConfig(node);
    const p = cfg.presets?.[name];
    if (!p || typeof p !== "object") return false;
    if (p.fav) delete p.fav; else p.fav = true;
    persistAndRepaint(node);
    return !!p.fav;
}

/** v29: single-preset export (same wrapped envelope, one entry). Import
 * reads it back unchanged (presetImportFromText accepts wrapped maps). */
export function presetExportOne(node, name) {
    const cfg = getHubConfig(node);
    const p = cfg.presets?.[name];
    if (!p || typeof p !== "object") return null;
    return JSON.stringify(
        { kind: "settings-hub-presets", version: 2, presets: { [name]: p } },
        null,
        2,
    );
}

/**
 * v29 bulk opt: include/exclude EVERY value binding of the ACTIVE tab in
 * preset captures (the ⋯ tools menu). Returns how many rows changed.
 */
export function presetBulkOpt(node, include) {
    const cfg = getHubConfig(node);
    const tabId = getActiveTabId(cfg);
    let changed = 0;
    for (const item of itemsOfTab(cfg, tabId)) {
        if (item.type !== "widget_binding" || item.widgetType === "button") continue;
        if (include) {
            if (item.inPreset === false) { delete item.inPreset; changed++; }
        } else if (item.inPreset !== false) { item.inPreset = false; changed++; }
    }
    if (changed) persistAndRepaint(node);
    return changed;
}

/**
 * v29 picker model: presets split by tab scope. Each record carries the
 * entry count, the dead-entry count (id AND stable key both failed) and
 * the favorite flag. Favorites float to the top; the insertion order is
 * preserved otherwise (Array#sort is stable in modern engines).
 */
export function presetPickerModel(node) {
    const cfg = getHubConfig(node);
    const tabId = getActiveTabId(cfg);
    const tab = [];
    const other = [];
    for (const [name, p] of Object.entries(cfg.presets || {})) {
        if (!p || typeof p !== "object" || !Array.isArray(p.entries)) continue;
        const rec = {
            name,
            count: p.entries.length,
            dead: presetCountDead(node, name),
            fav: !!p.fav,
            scopeName: tabNameOf(cfg, p.scope),
        };
        (p.scope === tabId ? tab : other).push(rec);
    }
    const favFirst = (a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0);
    tab.sort(favFirst);
    other.sort(favFirst);
    return {
        tabId,
        tabName: tabNameOf(cfg, tabId),
        tab, other,
        total: tab.length + other.length,
    };
}

/** Whole-hub export: one JSON string with every preset (wrapped format). */
export function presetExportAll(node) {
    const cfg = getHubConfig(node);
    return JSON.stringify(
        { kind: "settings-hub-presets", version: 2, presets: cfg.presets },
        null,
        2,
    );
}

/**
 * Import presets from exported JSON (wrapped format, or a bare
 * {name: preset} map). Existing names are only overwritten after a confirm.
 */
export function presetImportFromText(node, text) {
    const cfg = getHubConfig(node);
    let data;
    try {
        data = JSON.parse(String(text));
    } catch (_) {
        return { error: "Invalid JSON" };
    }
    const incoming = data && typeof data === "object" &&
        data.presets && typeof data.presets === "object" && !Array.isArray(data.presets)
        ? data.presets
        : (data && typeof data === "object" && !Array.isArray(data) ? data : null);
    if (!incoming) return { error: "No presets found" };
    const names = Object.keys(incoming)
        .filter((n) => incoming[n] && typeof incoming[n] === "object");
    if (!names.length) return { error: "No presets found" };
    const overwritten = names.filter((n) => cfg.presets[n]);
    if (overwritten.length &&
        !confirm(`Overwrite existing preset(s): ${overwritten.join(", ")}?`)) {
        return { cancelled: true };
    }
    for (const n of names) {
        cfg.presets[n] = JSON.parse(JSON.stringify(incoming[n]));
    }
    persistAndRepaint(node);
    return { imported: names.length, overwritten };
}
