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
//
//   v27 also hosts the GLOBAL video-audio preference for hub viewer players:
//   muted on/off + volume, persisted across sessions. Every NEW <video> the
//   hub mounts starts from this preference, and any change made through a
//   player's native controls (volumechange event) is written back here -
//   so the user mutes/unmutes/adjusts volume ONCE and every future video
//   follows. Same philosophy as refreshMs: a user preference, NOT workflow
//   state (localStorage, never node.properties).
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

// ---------------------------------------------------------------------------
// v27: GLOBAL video audio preference (muted + volume) for hub viewer players
// ---------------------------------------------------------------------------

const LS_VIDEO_MUTED = "settingshub.videoMuted";
const LS_VIDEO_VOLUME = "settingshub.videoVolume";

// Defaults: muted ON (browser autoplay policy blocks unmuted autoplay - the
// user can unmute from the native controls; that choice then sticks).
let videoMuted = true;
let videoVolume = 1;

// Boot: restore the persisted preference (if any) once per page load.
try {
    const m = localStorage.getItem(LS_VIDEO_MUTED);
    if (m === "0") videoMuted = false;
    else if (m === "1") videoMuted = true;
} catch (_) { /* no storage - muted default stands */ }
try {
    const raw = localStorage.getItem(LS_VIDEO_VOLUME);
    // Number(null) === 0 - an absent key must NOT clamp the default to 0.
    const v = (raw === null || raw === "") ? NaN : Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 1) videoVolume = v;
} catch (_) { /* no storage - full volume stands */ }

/** Current global video audio preference ({ muted: boolean, volume: 0..1 }). */
export function getVideoAudio() {
    return { muted: videoMuted, volume: videoVolume };
}

/**
 * Update the global video audio preference. Unknown/out-of-range fields are
 * ignored (a patch may carry only one of the two). Persists to localStorage
 * and returns the applied preference.
 */
export function setVideoAudio(patch = {}) {
    if (typeof patch.muted === "boolean") {
        videoMuted = patch.muted;
        try { localStorage.setItem(LS_VIDEO_MUTED, videoMuted ? "1" : "0"); }
        catch (_) { /* private mode etc. - session-only preference */ }
    }
    const vol = Number(patch.volume);
    if (Number.isFinite(vol) && vol >= 0 && vol <= 1) {
        videoVolume = Math.min(1, Math.max(0, vol));
        try { localStorage.setItem(LS_VIDEO_VOLUME, String(videoVolume)); }
        catch (_) { /* private mode etc. - session-only preference */ }
    }
    return getVideoAudio();
}

/** Push the global preference onto a player element (muted + volume). */
export function applyVideoAudio(el) {
    try {
        if (!el) return null;
        el.muted = videoMuted;
        el.volume = videoVolume;
    } catch (_) { /* exotic element - keep mounting */ }
    return el;
}

/** Test hook: run one poller pass immediately (bypasses the hidden guard). */
export function __refreshTickForTest() {
    for (const hub of allHubs()) {
        try { refreshNodeValues(hub); } catch (_) {}
    }
}
