// ============================================================================
// SettingsHub - v27 BATCH IMAGE GALLERY viewer (own gallery, live store feed)
// ----------------------------------------------------------------------------
// FIELD PROBLEM (v26.2 left this open): in the current frontend
// PreviewImage / SaveImage (and KSampler-style previews) render through the
// SERVICE CANVAS WIDGET "$$canvas-image-preview" (canvasImagePreviewTypes.ts:
// CANVAS_IMAGE_PREVIEW_WIDGET). That widget is CANVAS-ONLY - BaseWidget with
// options {canvasOnly: true} - it has NO element / inputEl / contentEl, so
// there is NO DOM media to find:
//
//   * findSourceMedia()  -> null (nothing to mirror / blit);
//   * the painter route -> onDrawBackground is only the frontend's
//     updatePreviews() shim (litegraphService.addDrawBackgroundHandler is
//     installed on EVERY node class) - it paints NO pixels;
//   * the node.imgs alt painter -> a decode/probe race (imgs populate only
//     after updatePreviews ran on a VISIBLE node, and the alt-probe war
//     exhausts before the first Image() finishes decoding).
//
// Result: the pinned viewer sat on "waiting for the source preview" forever.
//
// THE FIX - feed the hub's OWN gallery from the frontend's SOURCE OF TRUTH:
// the output store. The frontend persists every node's outputs there:
//
//   app.nodeOutputs[locatorId]      -> { images: [{filename,subfolder,type}] }
//   app.nodePreviewImages[locatorId] -> ["blob:...", ...]  (live preview)
//
// locatorId is String(node.id) for root nodes, "<subgraphUuid>:<nodeId>"
// for subgraph nodes (createNodeLocatorId). We read BOTH stores, mirror the
// frontend's own /view URL building (nodeOutputStore.buildImageUrls) and
// fall back to the legacy node fields (node.images specs, node.imgs srcs)
// for older frontends. This is a READ of live data - no polling of widget
// values (invariant #1 untouched), the watcher re-resolves on the same 1s
// cadence the v26.2 video watcher already established.
//
// UX (user request): batches must be first-class - the row shows a real
// GALLERY: main image + hover nav arrows + "i/N" counter + thumbnail strip,
// and every gallery opens FULLSCREEN (body-level overlay + Fullscreen API,
// arrow-key / wheel navigation).
// ============================================================================

import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Live source resolution
// ---------------------------------------------------------------------------

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|svg)$/i;
const MEDIA_EXT_RE = /\.(mp4|webm|mov|mkv|avi|m4v|mp3|wav|ogg|flac|aac)$/i;

/** True for URLs that a plain <img> can display (filters video/audio output
 *  specs out of the gallery - those belong to the <video> viewer route). */
function isImageUrl(u) {
    if (typeof u !== "string" || !u) return false;
    if (u.startsWith("blob:") || u.startsWith("data:")) return true;
    try {
        const path = u.split("?")[0].split("#")[0];
        if (MEDIA_EXT_RE.test(path)) return false;
        if (IMG_EXT_RE.test(path)) return true;
        // /view?filename=... - the extension lives in the QUERY, not the path.
        if (path.endsWith("/view") || path.includes("/view")) {
            const m = /[?&]filename=([^&]+)/.exec(u);
            const name = m ? decodeURIComponent(m[1]) : "";
            if (!name) return true;               // opaque - let <img> try
            return !MEDIA_EXT_RE.test(name);
        }
        return false;
    } catch (_) { return false; }
}

/** Mirror of the frontend's api.apiURL resolution (desktop builds prefix an
 *  origin); plain path when the API object is not reachable. */
function apiUrl(path) {
    try {
        const u = app?.api?.apiURL?.(path);
        if (typeof u === "string" && u) return u;
    } catch (_) {}
    try {
        const u = globalThis.api?.apiURL?.(path);
        if (typeof u === "string" && u) return u;
    } catch (_) {}
    return path;
}

/** /view URL for one output spec ({filename, subfolder, type}) - mirrors
 *  nodeOutputStore.buildImageUrls (preview-format/rand params omitted: the
 *  gallery wants full-quality, cacheable finals). */
function viewUrlFromSpec(spec) {
    try {
        if (!spec || typeof spec !== "object" || !spec.filename) return "";
        const q = new URLSearchParams();
        q.set("filename", String(spec.filename));
        q.set("subfolder", String(spec.subfolder ?? ""));
        q.set("type", String(spec.type ?? "output"));
        return apiUrl(`/view?${q.toString()}`);
    } catch (_) { return ""; }
}

// ---------------------------------------------------------------------------
// v27.3: media download - shared by the gallery, the fullscreen overlay and
// the self-rendered video/img viewer (portal_manager.js imports this).
// ---------------------------------------------------------------------------

const MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp",
    "image/svg+xml": "svg", "image/tiff": "tif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "video/x-matroska": "mkv", "video/avi": "avi",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/wave": "wav",
    "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
    "audio/aac": "aac", "audio/mp4": "m4a",
};

function extFromMime(m) {
    const base = String(m || "").split(";")[0].trim().toLowerCase();
    return MIME_EXT[base] || "";
}

/** Best-effort download name for a media URL: the /view filename param,
 *  else the URL basename, else "" (the caller falls back to the blob mime
 *  or a timestamped default). blob:/data: URLs carry no name by design. */
export function mediaNameFromUrl(u) {
    try {
        if (u.startsWith("blob:") || u.startsWith("data:")) return "";
        const m = /[?&]filename=([^&]+)/.exec(u);
        if (m) {
            const name = decodeURIComponent(m[1]).trim();
            if (name) return name;
        }
        const path = u.split("?")[0].split("#")[0];
        const base = path.slice(path.lastIndexOf("/") + 1).trim();
        if (base) return base;
    } catch (_) {}
    return "";
}

/**
 * Download the media behind `url`. Preferred route: fetch -> blob -> object
 * URL anchor (exact bytes, honest filename even when the browser would
 * ignore the download attribute); a direct `<a download>` click is the
 * fallback (same-origin /view and blob: still download). Returns true when
 * a download was triggered.
 */
export async function downloadMediaUrl(url, fallbackBase = "settingshub_media") {
    if (typeof url !== "string" || !url) return false;
    const fallback = `${fallbackBase}-${Date.now()}`;
    const trigger = (href, name) => {
        const a = document.createElement("a");
        a.href = href;
        if (name) a.download = name;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        try { a.remove(); } catch (_) {}
    };
    try {
        if (typeof fetch === "function") {
            const r = await fetch(url);
            if (r && r.ok) {
                const blob = await r.blob();
                let name = mediaNameFromUrl(url);
                if (!name) {
                    const ext = extFromMime(blob?.type);
                    name = `${fallback}${ext ? "." + ext : ""}`;
                }
                const obj = URL.createObjectURL(blob);
                trigger(obj, name);
                try { setTimeout(() => URL.revokeObjectURL(obj), 30000); } catch (_) {}
                return true;
            }
        }
    } catch (_) { /* offline / CORS / no fetch - the anchor below still works */ }
    try {
        trigger(url, mediaNameFromUrl(url) || fallback);
        return true;
    } catch (_) { return false; }
}

/** Candidate store keys for a node: exact root key plus every subgraph
 *  "<uuid>:<id>" key that points at this local id. */
function locatorCandidates(tn) {
    const id = String(tn?.id ?? "");
    if (!id) return [];
    const out = [id];
    try {
        const stores = [app?.nodeOutputs, app?.nodePreviewImages];
        for (const st of stores) {
            if (!st || typeof st !== "object") continue;
            for (const k of Object.keys(st)) {
                if (k !== id && k.endsWith(`:${id}`) && !out.includes(k)) out.push(k);
            }
        }
    } catch (_) { /* exotic store - the exact key still works */ }
    return out;
}

function firstStoreEntry(tn, store) {
    if (!store || typeof store !== "object") return undefined;
    for (const k of locatorCandidates(tn)) {
        const v = store[k];
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

/**
 * The FULL batch of image URLs behind a viewer node, from the live frontend
 * output store (final outputs first, then the streaming preview frames,
 * then the legacy node fields). Returns [] when the node currently owns no
 * images - the caller keeps its fallback routes.
 */
export function findOutputImages(tn) {
    if (!tn) return [];
    const out = [];
    const seen = new Set();
    const push = (u) => {
        if (typeof u === "string" && u && !seen.has(u) && isImageUrl(u)) {
            seen.add(u);
            out.push(u);
        }
    };

    // 1. Final outputs: specs from the output store (full batch, survives
    //    reload via the workflow's output history) ...
    const outputs = firstStoreEntry(tn, app?.nodeOutputs)
        ?? (typeof tn.images !== "undefined" ? { images: tn.images } : undefined);
    const specs = Array.isArray(outputs?.images) ? outputs.images : [];
    for (const s of specs) push(viewUrlFromSpec(s));

    // 2. ... or direct URLs (some builds store resolved urls / blobs there).
    if (!out.length) {
        for (const s of specs) {
            if (typeof s === "string") push(s);
        }
    }

    // 3. Live preview frames (execution streaming, blob: object URLs).
    if (!out.length) {
        const previews = firstStoreEntry(tn, app?.nodePreviewImages);
        if (Array.isArray(previews)) for (const u of previews) push(u);
    }

    // 4. Legacy fields: specs synced onto the node by updatePreviews, then
    //    the already-loaded elements' srcs (node.imgs).
    if (!out.length) {
        for (const s of (Array.isArray(tn.images) ? tn.images : [])) {
            push(viewUrlFromSpec(s));
            if (typeof s === "string") push(s);
        }
    }
    if (!out.length) {
        for (const im of (Array.isArray(tn.imgs) ? tn.imgs : [])) {
            try { push(im?.currentSrc || im?.src || ""); } catch (_) {}
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Fullscreen overlay (SINGLETON on document.body - invariant #7: fixed,
// never clipped by the hub scroll viewport)
// ---------------------------------------------------------------------------

let fsOverlay = null;      // the overlay element while open
let fsRec = null;          // gallery rec the overlay is fed from
let fsIdx = 0;
let fsPrevFocus = null;
let fsKeyHandler = null;
let fsFsChangeHandler = null;

function fsPaint() {
    if (!fsOverlay || !fsRec) return;
    const urls = fsRec.urls || [];
    if (!urls.length) { closeGalleryFullscreen(); return; }
    if (fsIdx >= urls.length) fsIdx = urls.length - 1;
    if (fsIdx < 0) fsIdx = 0;
    try {
        fsOverlay.querySelector(".hub-fs-img").src = urls[fsIdx];
        fsOverlay.querySelector(".hub-fs-counter").textContent =
            urls.length > 1 ? `${fsIdx + 1} / ${urls.length}` : "";
        const has = urls.length > 1;
        fsOverlay.querySelector(".hub-fs-prev").style.display = has ? "" : "none";
        fsOverlay.querySelector(".hub-fs-next").style.display = has ? "" : "none";
    } catch (_) {}
    try { fsRec.setIndex(fsIdx); } catch (_) {}   // row gallery follows along
}

function fsNav(delta) {
    if (!fsRec) return;
    const n = (fsRec.urls || []).length;
    if (!n) return;
    fsIdx = (fsIdx + delta + n) % n;
    fsPaint();
}

/** Open the body-level fullscreen viewer for a gallery rec at `index`. */
export function openGalleryFullscreen(rec, index = 0) {
    if (!rec || !Array.isArray(rec.urls) || !rec.urls.length) return;
    closeGalleryFullscreen();
    const ov = document.createElement("div");
    ov.className = "hub-fs-overlay";
    ov.innerHTML =
        `<img class="hub-fs-img" draggable="false" alt="">` +
        `<button type="button" class="hub-fs-btn hub-fs-prev" title="Previous (←)">◀</button>` +
        `<button type="button" class="hub-fs-btn hub-fs-next" title="Next (→)">▶</button>` +
        `<span class="hub-fs-counter"></span>` +
                `<button type="button" class="hub-fs-btn hub-fs-dl" title="Download this image (S)">\u2b07</button>` +
        `<button type="button" class="hub-fs-btn hub-fs-close" title="Close (Esc)">✕</button>`;
    const close = () => closeGalleryFullscreen();
    ov.querySelector(".hub-fs-close").addEventListener("click", close);
    ov.querySelector(".hub-fs-prev").addEventListener("click", () => fsNav(-1));
    ov.querySelector(".hub-fs-next").addEventListener("click", () => fsNav(1));
    ov.querySelector(".hub-fs-dl").addEventListener("click", () => {
        if (fsRec) { downloadMediaUrl(fsRec.urls[fsIdx], "settingshub_image"); }
    });
    // Click on the backdrop closes; clicks on the image / buttons do not.
    ov.addEventListener("pointerdown", (e) => {
        if (e.target === ov) close();
    });
    ov.addEventListener("wheel", (e) => {
        e.preventDefault();
        fsNav(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
    }, { passive: false });
    document.body.appendChild(ov);

    fsOverlay = ov;
    fsRec = rec;
    fsIdx = Math.min(Math.max(0, index | 0), rec.urls.length - 1);
    fsPrevFocus = document.activeElement;

    // Arrow keys / Home / End / Esc - capture so ComfyUI shortcuts don't eat
    // them while the overlay is up.
    fsKeyHandler = (e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); fsNav(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); fsNav(1); }
        else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); fsIdx = 0; fsPaint(); }
        else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); fsIdx = (fsRec?.urls?.length || 1) - 1; fsPaint(); }
        else if (e.code === "KeyS") { e.preventDefault(); e.stopPropagation(); if (fsRec) downloadMediaUrl(fsRec.urls[fsIdx], "settingshub_image"); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", fsKeyHandler, true);

    // True fullscreen when the browser grants it; the overlay is a fixed
    // body-level sheet either way. Exiting fullscreen closes the viewer.
    try {
        const el = fsOverlay;
        if (el.requestFullscreen?.call && !document.fullscreenElement) {
            const p = el.requestFullscreen();
            p?.catch?.(() => {});   // denied - the fixed sheet still shows
        }
    } catch (_) {}
    fsFsChangeHandler = () => {
        if (!document.fullscreenElement) close();
    };
    try { document.addEventListener("fullscreenchange", fsFsChangeHandler); } catch (_) {}

    fsPaint();
}

/** Close the fullscreen viewer (idempotent, safe from anywhere). */
export function closeGalleryFullscreen() {
    const ov = fsOverlay;
    fsOverlay = null;
    fsRec = null;
    if (fsKeyHandler) {
        try { document.removeEventListener("keydown", fsKeyHandler, true); } catch (_) {}
        fsKeyHandler = null;
    }
    if (fsFsChangeHandler) {
        try { document.removeEventListener("fullscreenchange", fsFsChangeHandler); } catch (_) {}
        fsFsChangeHandler = null;
    }
    if (ov) {
        try {
            if (document.fullscreenElement === ov) document.exitFullscreen?.();
        } catch (_) {}
        try { ov.remove(); } catch (_) {}
    }
    try { fsPrevFocus?.focus?.(); } catch (_) {}
    fsPrevFocus = null;
}

// ---------------------------------------------------------------------------
// Row gallery mount
// ---------------------------------------------------------------------------

/** Session-persistent per-item view state (current index). Survives the
 *  structural re-render churn of the hub (mountPortals remounts every
 *  portal); deliberately NOT part of the serialized config - which image
 *  the user was looking at is not workflow data. */
const viewState = new Map();   // item.id -> { idx }

/**
 * Mount the hub-owned batch image gallery into `host`. Returns a viewer
 * rec (kind "viewer") or null when the source node currently exposes no
 * images (caller falls back to the canvas-blit / painter routes).
 */
export function mountImageGallery(node, item, tn, host) {
    let urls = null;
    try { urls = findOutputImages(tn); } catch (_) { urls = null; }
    if (!urls || !urls.length) return null;

    // Keep the "🖼 live" tag that itemRowHtml put above the embed.
    const tag = host?.querySelector?.(".hub-portal-tag") ?? null;
    host.textContent = "";
    if (tag) { try { host.appendChild(tag); } catch (_) {} }

    // --- DOM skeleton ------------------------------------------------------
    const wrap = document.createElement("div");
    wrap.className = "hub-gallery";
    wrap.dataset.role = "viewer-media";

    const stage = document.createElement("div");
    stage.className = "hub-gallery-stage";
    const img = document.createElement("img");
    img.className = "hub-gallery-img";
    img.draggable = false;
    img.alt = "";
    stage.appendChild(img);

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "hub-gal-btn hub-gal-prev";
    prevBtn.title = "Previous image (←)";
    prevBtn.textContent = "◀";
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "hub-gal-btn hub-gal-next";
    nextBtn.title = "Next image (→)";
    nextBtn.textContent = "▶";
    const counter = document.createElement("span");
    counter.className = "hub-gal-counter";
    const fsBtn = document.createElement("button");
    fsBtn.type = "button";
    fsBtn.className = "hub-gal-btn hub-gal-fs";
    fsBtn.title = "Fullscreen viewer";
    fsBtn.textContent = "⛶";
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "hub-gal-btn hub-gal-dl";
    dlBtn.title = "Download this image";
    dlBtn.textContent = "\u2b07";
    stage.append(prevBtn, nextBtn, counter, fsBtn, dlBtn);

    const thumbs = document.createElement("div");
    thumbs.className = "hub-gallery-thumbs";

    wrap.append(stage, thumbs);
    host.appendChild(wrap);

    // --- state -------------------------------------------------------------
    const rec = {
        kind: "viewer", item, tn, host,
        media: img, srcKind: "gallery",
        urls, idx: 0, dead: false, timer: null,
        release: null, set: null,
    };
    const st = viewState.get(item.id);
    rec.idx = (st && Number.isFinite(st.idx)) ? st.idx : 0;
    if (rec.idx >= urls.length) rec.idx = 0;

    const thumbEls = [];

    const paint = () => {
        if (rec.dead) return;
        const n = rec.urls.length;
        if (!n) return;
        if (rec.idx >= n) rec.idx = n - 1;
        if (rec.idx < 0) rec.idx = 0;
        try { img.src = rec.urls[rec.idx]; } catch (_) {}
        counter.textContent = n > 1 ? `${rec.idx + 1} / ${n}` : "";
        const nav = n > 1;
        prevBtn.style.display = nav ? "" : "none";
        nextBtn.style.display = nav ? "" : "none";
        fsBtn.style.display = "";
        thumbs.style.display = n > 1 ? "" : "none";
        for (let i = 0; i < thumbEls.length; i++) {
            const t = thumbEls[i];
            if (!t) continue;
            try { t.classList.toggle("hub-gal-thumb-on", i === rec.idx); } catch (_) {}
        }
        try {
            thumbEls[rec.idx]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        } catch (_) {}
        try { viewState.set(item.id, { idx: rec.idx }); } catch (_) {}
        // Preload the neighbours - navigation must feel instant even on
        // full-resolution /view payloads.
        try {
            const Ctor = globalThis.Image ?? globalThis.window?.Image;
            if (typeof Ctor === "function") {
                for (const d of [-1, 1]) {
                    const u = rec.urls[(rec.idx + d + n) % n];
                    if (u) { const im = new Ctor(); im.src = u; }
                }
            }
        } catch (_) {}
    };

    const goto = (i) => { rec.idx = i; paint(); };
    rec.setIndex = (i) => { if (!rec.dead) { rec.idx = i; paint(); } };

    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); goto((rec.idx - 1 + rec.urls.length) % rec.urls.length); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); goto((rec.idx + 1) % rec.urls.length); });
    fsBtn.addEventListener("click", (e) => { e.stopPropagation(); openGalleryFullscreen(rec, rec.idx); });
    dlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const u = rec.urls[rec.idx];
        if (u) { downloadMediaUrl(u, "settingshub_image"); }
    });
    // Click on the image itself = fullscreen (the universal gesture).
    img.addEventListener("click", () => openGalleryFullscreen(rec, rec.idx));
    stage.addEventListener("wheel", (e) => {
        if (rec.urls.length < 2) return;
        e.preventDefault();
        goto((rec.idx + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) + rec.urls.length) % rec.urls.length);
    }, { passive: false });
    let keyHandler = (e) => {
        if (fsOverlay) return;                    // the overlay owns keys now
        if (!wrap.isConnected) return;
        if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); goto((rec.idx - 1 + rec.urls.length) % rec.urls.length); }
        else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); goto((rec.idx + 1) % rec.urls.length); }
    };
    // Keyboard works as soon as the row has pointer focus (click anywhere).
    stage.setAttribute("tabindex", "0");
    stage.addEventListener("keydown", keyHandler);

    // Thumbnail strip (batches only)
    const buildThumbs = () => {
        thumbs.textContent = "";
        thumbEls.length = 0;
        rec.urls.forEach((u, i) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "hub-gal-thumb";
            b.title = `Image ${i + 1}`;
            const t = document.createElement("img");
            t.draggable = false;
            t.alt = "";
            t.src = u;
            b.appendChild(t);
            b.addEventListener("click", (e) => { e.stopPropagation(); goto(i); });
            thumbs.appendChild(b);
            thumbEls.push(b);
        });
    };
    buildThumbs();

    // --- watcher: new generations swap the URL list in place ----------------
    // Same contract as the v26.2 video watcher: re-resolve the LIVE urls and
    // re-point only when the list actually changed (signature = length +
    // first/last + total joined hash light enough for a 1s cadence).
    const sig = (list) => list.length
        ? `${list.length}|${list[0]}|${list[list.length >> 1]}|${list[list.length - 1]}`
        : "";
    let lastSig = sig(rec.urls);
    const apply = () => {
        if (rec.dead) return;
        // NOTE: no document.hidden guard here (unlike the canvas blit) - same
        // contract as the v26.2 video watcher: the resolve is a cheap store
        // read, and jsdom-based smoke harnesses run "hidden".
        let live = null;
        try { live = findOutputImages(tn); } catch (_) { live = null; }
        if (!live || !live.length) return;        // transient (store swap mid-frame)
        const s = sig(live);
        if (s === lastSig) return;
        lastSig = s;
        rec.urls = live;
        rec.idx = 0;                              // a NEW batch starts at its first image
        buildThumbs();
        paint();
        if (fsRec === rec) fsPaint();             // keep the open fullscreen in sync
    };
    rec.timer = setInterval(apply, 1000);

    paint();
    rec.release = () => {
        rec.dead = true;
        if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
        try { stage.removeEventListener("keydown", keyHandler); } catch (_) {}
        keyHandler = null;
        if (fsRec === rec) closeGalleryFullscreen();
        try { wrap.remove(); } catch (_) {}
    };
    return rec;
}

/** Test hook: gallery state without reaching into closures. */
export function __galleryTestState() {
    return {
        viewState,
        fsOpen: !!fsOverlay,
        fsRec: fsRec ? { idx: fsIdx, count: fsRec.urls?.length ?? 0 } : null,
    };
}
