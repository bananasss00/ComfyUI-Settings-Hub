// ============================================================================
// SettingsHub - GLOBAL hub preferences ("⚙" popup)
// ----------------------------------------------------------------------------
// Settings here are GLOBAL (shared by every hub, persisted in localStorage -
// they are user preferences, not per-workflow state, so they must NOT travel
// with node.properties).
//
//   Mirror update rate - how often hub mirrors re-read their source values.
//
//   Why it exists: the reactive sync engine (sync.js / sync_manager.js) is
//   fully event-driven - a mirror follows its source within one animation
//   frame - but events only fire when the source widget's callback runs.
//   Plenty of real-world value changes never do that:
//     * node code that assigns widget.value directly (onExecuted patches,
//       seed randomizers, custom-node internals, frontend scripts);
//     * values arriving from the backend after a generation;
//     * exotic widget factories with no callback at all.
//   For those, mirrors used to wait for the next structural re-render. The
//   user-facing symptom is "the hub lags behind". The poller closes the gap:
//   the user picks a rate and every mirror catches up on it. Default is
//   "Events only" - zero background polling, the historical invariant.
//
//   The tick performs a VALUE-ONLY refresh (refreshNodeValues): no innerHTML
//   rebuilds, popups/inline editors survive, controls being actively edited
//   are skipped by the renderer itself.
// ============================================================================

import { allHubs } from "./core.js";
import { refreshNodeValues } from "./sync.js";

const LS_KEY = "settingshub.refreshMs";

/** Allowed rates (ms). 0 = events only (no polling). */
export const REFRESH_CHOICES = [0, 100, 250, 500, 1000, 2000];

let currentMs = 0;
let timer = null;

function tick() {
    if (typeof document !== "undefined" && document.hidden) return;
    for (const hub of allHubs()) {
        try { refreshNodeValues(hub); } catch (_) { /* one bad hub never starves the rest */ }
    }
}

function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (currentMs > 0) timer = setInterval(tick, currentMs);
}

/** Current mirror update rate in ms (0 = events only). */
export function getRefreshMs() { return currentMs; }

/**
 * Set the global mirror update rate. Unknown values normalize to 0
 * (events only). Persists to localStorage and (re)starts the poller.
 * Returns the applied value.
 */
export function setRefreshMs(ms) {
    const n = Math.round(Number(ms));
    currentMs = REFRESH_CHOICES.includes(n) ? n : 0;
    try {
        if (currentMs > 0) localStorage.setItem(LS_KEY, String(currentMs));
        else localStorage.removeItem(LS_KEY);
    } catch (_) { /* private mode etc. - session-only preference */ }
    restartTimer();
    return currentMs;
}

/** Human-readable label for the rate select. */
export function refreshLabel(ms) {
    if (!ms) return "Events only (default)";
    return ms >= 1000 ? `every ${ms / 1000} s` : `every ${ms} ms`;
}

// Boot: restore the persisted preference (if any) once per page load.
try {
    const saved = Number(localStorage.getItem(LS_KEY));
    if (Number.isFinite(saved) && REFRESH_CHOICES.includes(saved)) currentMs = saved;
} catch (_) { /* no storage - events-only default stands */ }
restartTimer();

/** Test hook: run one poller pass immediately (bypasses the hidden guard). */
export function __refreshTickForTest() {
    for (const hub of allHubs()) {
        try { refreshNodeValues(hub); } catch (_) {}
    }
}
