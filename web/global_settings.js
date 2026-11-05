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
//
//   v57 adds the GLOBAL media-preview timing preferences: the hover dwell
//   (how long the cursor must rest on a hub media-row thumb or a picker
//   thumbnail cell before the enlarged preview popup opens) and the hide
//   grace (how long the popup lingers after the cursor leaves, allowing a
//   move INTO the popup). Both were hardcoded module constants in the
//   renderer (MEDIA_PREVIEW_SHOW_MS=200 / MEDIA_PREVIEW_HIDE_MS=300) and
//   are now user preferences following the same contract: localStorage,
//   normalized on read/write, one shared value for every hub (picker AND
//   hub rows on purpose - one mental model, see the ⚙ popup hint).
//
//   v58 continues the family: the preview popup SIZE (S/M/L/XL presets, one
//   class on the popup root), the preview media AUTOPLAY toggle (video +
//   audio popups start paused when Off) and the PIN auto-collapse timings
//   (fold delay after the cursor leaves + re-open hover intent on the
//   folded title - historically hardcoded 450/220 ms in the renderer).
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

// ---------------------------------------------------------------------------
// v57: GLOBAL media-preview hover timings (dwell + hide grace)
// ---------------------------------------------------------------------------
// Consumers: hub_ui_renderer.js reads the values through the getters at
// EVENT TIME (never caches them at module load), so a change in the ⚙ popup
// affects the very next hover without any re-render. 0 ms dwell = the popup
// opens on the first pointerover; 0 ms grace = the popup closes as soon as
// the cursor leaves (moving into the popup still keeps it open while the
// cursor is over it - that part is not timer-driven).

const LS_PREVIEW_SHOW = "settingshub.previewShowMs";
const LS_PREVIEW_HIDE = "settingshub.previewHideMs";

/** Allowed dwell values (ms). 0 = open immediately on hover. */
export const PREVIEW_SHOW_CHOICES = [0, 100, 200, 300, 500, 800, 1200];
/** Allowed hide-grace values (ms). 0 = close as soon as the cursor leaves. */
export const PREVIEW_HIDE_CHOICES = [0, 150, 300, 500, 800];

const PREVIEW_SHOW_DEFAULT = 200;  // historical hardcoded dwell
const PREVIEW_HIDE_DEFAULT = 300;  // historical hardcoded grace

let previewShowMs = PREVIEW_SHOW_DEFAULT;
let previewHideMs = PREVIEW_HIDE_DEFAULT;

// Boot: restore the persisted preferences (if any) once per page load.
try {
    const v = Number(localStorage.getItem(LS_PREVIEW_SHOW));
    if (Number.isFinite(v) && PREVIEW_SHOW_CHOICES.includes(v)) previewShowMs = v;
} catch (_) { /* no storage - the default dwell stands */ }
try {
    const v = Number(localStorage.getItem(LS_PREVIEW_HIDE));
    if (Number.isFinite(v) && PREVIEW_HIDE_CHOICES.includes(v)) previewHideMs = v;
} catch (_) { /* no storage - the default grace stands */ }

/** Current hover dwell before a preview popup opens (ms). */
export function getPreviewShowMs() { return previewShowMs; }

/**
 * Set the global hover dwell. Unknown values normalize to the default
 * (200). Persists to localStorage. Returns the applied value.
 */
export function setPreviewShowMs(ms) {
    const n = Math.round(Number(ms));
    previewShowMs = PREVIEW_SHOW_CHOICES.includes(n) ? n : PREVIEW_SHOW_DEFAULT;
    try { localStorage.setItem(LS_PREVIEW_SHOW, String(previewShowMs)); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return previewShowMs;
}

/** Current hide grace before a preview popup closes (ms). */
export function getPreviewHideMs() { return previewHideMs; }

/**
 * Set the global hide grace. Unknown values normalize to the default
 * (300). Persists to localStorage. Returns the applied value.
 */
export function setPreviewHideMs(ms) {
    const n = Math.round(Number(ms));
    previewHideMs = PREVIEW_HIDE_CHOICES.includes(n) ? n : PREVIEW_HIDE_DEFAULT;
    try { localStorage.setItem(LS_PREVIEW_HIDE, String(previewHideMs)); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return previewHideMs;
}

/** Human-readable label for the preview delay selects. */
export function previewDelayLabel(ms) {
    if (!ms) return "Instant (0 ms)";
    return `${ms} ms`;
}

// ---------------------------------------------------------------------------
// v58: GLOBAL preview popup size + media autoplay, pin auto-collapse timings
// ---------------------------------------------------------------------------
// Three more user preferences in the same contract family as v57 (localStorage,
// whitelisted values, read by the renderer at EVENT TIME - never cached):
//
//   * Preview popup size - S/M/L/XL presets for the enlarged hover preview
//     (hub row preview AND picker cells, one shared choice). The renderer
//     lands the choice as a .hub-preview-{s,m,l,xl} class on the popup root;
//     styles.css scales the popup box + the media element's max-height through
//     CSS variables. M is the historical 340x280 box and the default.
//
//   * Preview autoplay - the hover popups used to mount <video controls
//     autoplay muted loop> / <audio controls autoplay> unconditionally
//     (v47/v53). Off drops the autoplay attribute: the element shows its
//     first frame (video) / sits silent (audio) with the native controls
//     visible - the user clicks play. Muted stays ON either way (browser
//     autoplay policy; the v27 audio preference governs hub viewer players,
//     NOT these quick hover popups).
//
//   * Pin auto-collapse timings - the v41 auto-collapse engine had two
//     hardcoded delays: how long the cursor may stay away from a floating
//     pinned window before it folds (450ms) and how long the folded title
//     must be hovered before it re-opens (220ms hover intent). Both are now
//     global preferences; the per-hub ⇲ toggle in the pin header keeps
//     working exactly as before (it turns the MODE on/off, the timings are
//     global calibration).

const LS_PREVIEW_SIZE = "settingshub.previewSize";
const LS_PREVIEW_AUTOPLAY = "settingshub.previewAutoplay";
const LS_PIN_FOLD_LEAVE = "settingshub.pinFoldLeaveMs";
const LS_PIN_FOLD_HOVER = "settingshub.pinFoldHoverMs";

/** Allowed popup-size presets (class suffix in styles.css). */
export const PREVIEW_SIZE_CHOICES = ["S", "M", "L", "XL"];
const PREVIEW_SIZE_DEFAULT = "M";

let previewSize = PREVIEW_SIZE_DEFAULT;

// Boot: restore the persisted preference (if any) once per page load.
try {
    const v = String(localStorage.getItem(LS_PREVIEW_SIZE) || "").toUpperCase();
    if (PREVIEW_SIZE_CHOICES.includes(v)) previewSize = v;
} catch (_) { /* no storage - the default size stands */ }

/** Current preview popup size preset ("S" | "M" | "L" | "XL"). */
export function getPreviewSize() { return previewSize; }

/**
 * Set the global preview popup size. Unknown values normalize to the
 * default (M). Persists to localStorage. Returns the applied value.
 */
export function setPreviewSize(sz) {
    const v = String(sz ?? "").toUpperCase();
    previewSize = PREVIEW_SIZE_CHOICES.includes(v) ? v : PREVIEW_SIZE_DEFAULT;
    try { localStorage.setItem(LS_PREVIEW_SIZE, previewSize); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return previewSize;
}

// Default ON: the historical behavior (v47/v53 popups always autoplayed).
let previewAutoplay = true;

// Boot: restore the persisted preference (if any) once per page load.
try {
    const m = localStorage.getItem(LS_PREVIEW_AUTOPLAY);
    if (m === "0") previewAutoplay = false;
    else if (m === "1") previewAutoplay = true;
} catch (_) { /* no storage - autoplay default stands */ }

/** Current preview autoplay preference (true = media starts playing). */
export function getPreviewAutoplay() { return previewAutoplay; }

/**
 * Set the global preview autoplay preference (boolean). Persists to
 * localStorage. Returns the applied value.
 */
export function setPreviewAutoplay(on) {
    previewAutoplay = !!on;
    try { localStorage.setItem(LS_PREVIEW_AUTOPLAY, previewAutoplay ? "1" : "0"); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return previewAutoplay;
}

/** Allowed fold delays (ms) after the cursor leaves a pinned window. */
export const PIN_FOLD_LEAVE_CHOICES = [0, 200, 450, 800, 1500, 3000];
/** Historical hardcoded leave grace - the default + select label marker. */
export const PIN_FOLD_LEAVE_DEFAULT = 450;

/** Allowed re-open hover-intent delays (ms) on a folded pin title. */
export const PIN_FOLD_HOVER_CHOICES = [0, 100, 220, 400, 800];
/** Historical hardcoded hover intent - the default + select label marker. */
export const PIN_FOLD_HOVER_DEFAULT = 220;

let pinFoldLeaveMs = PIN_FOLD_LEAVE_DEFAULT;
let pinFoldHoverMs = PIN_FOLD_HOVER_DEFAULT;

// Boot: restore the persisted preferences (if any) once per page load.
try {
    const v = Number(localStorage.getItem(LS_PIN_FOLD_LEAVE));
    if (Number.isFinite(v) && PIN_FOLD_LEAVE_CHOICES.includes(v)) pinFoldLeaveMs = v;
} catch (_) { /* no storage - the default fold delay stands */ }
try {
    const v = Number(localStorage.getItem(LS_PIN_FOLD_HOVER));
    if (Number.isFinite(v) && PIN_FOLD_HOVER_CHOICES.includes(v)) pinFoldHoverMs = v;
} catch (_) { /* no storage - the default re-open delay stands */ }

/** Current fold delay after the cursor leaves a pinned window (ms). */
export function getPinFoldLeaveMs() { return pinFoldLeaveMs; }

/**
 * Set the global fold delay. Unknown values normalize to the default
 * (450). Persists to localStorage. Returns the applied value.
 */
export function setPinFoldLeaveMs(ms) {
    const n = Math.round(Number(ms));
    pinFoldLeaveMs = PIN_FOLD_LEAVE_CHOICES.includes(n) ? n : PIN_FOLD_LEAVE_DEFAULT;
    try { localStorage.setItem(LS_PIN_FOLD_LEAVE, String(pinFoldLeaveMs)); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return pinFoldLeaveMs;
}

/** Current re-open hover-intent delay on a folded pin title (ms). */
export function getPinFoldHoverMs() { return pinFoldHoverMs; }

/**
 * Set the global re-open hover-intent delay. Unknown values normalize to
 * the default (220). Persists to localStorage. Returns the applied value.
 */
export function setPinFoldHoverMs(ms) {
    const n = Math.round(Number(ms));
    pinFoldHoverMs = PIN_FOLD_HOVER_CHOICES.includes(n) ? n : PIN_FOLD_HOVER_DEFAULT;
    try { localStorage.setItem(LS_PIN_FOLD_HOVER, String(pinFoldHoverMs)); }
    catch (_) { /* private mode etc. - session-only preference */ }
    return pinFoldHoverMs;
}

/** Test hook: run one poller pass immediately (bypasses the hidden guard). */
export function __refreshTickForTest() {
    for (const hub of allHubs()) {
        try { refreshNodeValues(hub); } catch (_) {}
    }
}

// ============================================================================
// v61: NAVIGATION preferences (nav points feature)
// ----------------------------------------------------------------------------
// Two global switches for the 🧭 nav-point feature (same philosophy as the
// rest of this file: a USER preference, never workflow state - localStorage,
// normalized on read/write, one value for every hub):
//   * navMarkers   - paint nav points of the graph being browsed as small
//                    draggable markers on the canvas (default ON);
//   * navCanvasMenu- offer "🧭 Add navigation point here" in the canvas
//                    right-click menu (default ON).
// ============================================================================

const LS_NAV_MARKERS = "settingshub.navMarkers";
const LS_NAV_MENU = "settingshub.navCanvasMenu";

function readBoolFlag(key, def) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;   // absent key ≠ false
        return raw === "1";
    } catch (_) { return def; }
}

function writeBoolFlag(key, v) {
    try { localStorage.setItem(key, v ? "1" : "0"); }
    catch (_) { /* private mode etc. - session-only preference */ }
}

let navMarkersOn = readBoolFlag(LS_NAV_MARKERS, true);
let navMenuOn = readBoolFlag(LS_NAV_MENU, true);

export function getNavMarkersOn() { return navMarkersOn; }

export function setNavMarkersOn(on) {
    navMarkersOn = on !== false;
    writeBoolFlag(LS_NAV_MARKERS, navMarkersOn);
    return navMarkersOn;
}

export function getNavMenuOn() { return navMenuOn; }

export function setNavMenuOn(on) {
    navMenuOn = on !== false;
    writeBoolFlag(LS_NAV_MENU, navMenuOn);
    return navMenuOn;
}
