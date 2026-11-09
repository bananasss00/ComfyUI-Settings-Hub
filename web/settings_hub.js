// ============================================================================
// SettingsHub - extension entry point (v35 loader)
// ----------------------------------------------------------------------------
// v35: this file is a LOADER, not a static importer. Field lesson from the
// v34 rollout: a stale cached module or a partially copied web/ folder kills
// the entire static import graph BEFORE the entry can log anything - the
// console stayed clean while the extension was completely dead. Now:
//   * the banner logs first, so entry freshness is always provable (F12);
//   * every submodule loads through its own try/catch - a failure names the
//     exact file and the error instead of dying silently;
//   * JS imports deliberately carry NO version query: submodules import
//     each other statically and a different specifier would create a SECOND
//     module instance (split state). styles.css has no such constraint.
// Loading this file via ComfyUI's WEB_DIRECTORY registers:
//   * the SettingsHub node type           (hub_node.js)
//   * the DOM UI renderer                 (hub_ui_renderer.js)
//   * the reactive two-way sync engine    (sync_manager.js + sync.js)
//   * the "📌 Pin to Settings Hub" menu   (context_menu.js)
//   * drag & drop reordering              (dnd_manager.js)
// ============================================================================

import { app } from "../../scripts/app.js";

// v30.3/v35: build banner - makes the running web build verifiable in F12
// (field debugging: "is the new file actually loaded?" stops being a guess;
// a stale cached module was a real suspect three times already).
console.info("[SettingsHub] web build: v90 - FONT SCALE + MODAL GUARD + VIRTUAL HUBS (owner requests 2026-11-09: 'a setting which allows regulating the font size in the hub, the stack and the chat - the main thing is that nothing goes out of bounds, the interfaces must adapt correctly to different font sizes' + 'when I open ComfyUI windows, like the Comfy settings, my stacker, hub and chat are on top of those windows, do not react to clicks and get in the way of interacting with the settings window' + 'the project was planned as control panels on the ComfyUI canvas, then the panel could be detached from the node - add the ability to create hubs in process (any number, for different tasks) without a node on the canvas, but the node way must stay'): v90 (web/settings_hub.js + web/styles.css + web/global_settings.js + web/core.js + web/hub_node.js + web/context_menu.js + web/hub_ui_renderer.js + web/stack.js + web/chat.js): FONT SIZE: a new 'Font size (hub - stack - chat)' row in ALL THREE gear popups (hub settings, the stack gear, the chat gear) drives ONE shared scale (localStorage settingshub.ui.fontScale, 75-250 percent, quick picks 80..200) through the --sh-fs CSS variable on :root - every font-size and every text-bearing control height in styles.css is now calc(var(--sh-fs, 1) * Npx), so the default 100 percent renders pixel-identically while 150+ reflows instead of breaking: rows re-wrap (the tab bar wraps), long values ellipsize with their tooltips, selects and number cells keep scaled max-widths, lists and panels scroll, media thumbnails and panel shells keep their sizes; MODAL GUARD: the entry installs a watcher (MutationObserver on html + a 400 ms scan) that toggles body.sh-modal-open whenever a ComfyUI modal (.comfy-modal visible / dialog[open]) is on screen, and a new styles.css block hides EVERY SettingsHub floating layer (hub pin panels, the stack, the chat, compare, all menus/popups/viewers/toasts - visibility hidden + pointer-events none, rects intact) while it is set - the Comfy settings window is never covered or blocked again and everything returns the moment it closes; VIRTUAL HUBS: the canvas right-click menu gains 'New virtual hub (floating, no canvas node)' - it creates a REAL SettingsHub node on the root graph (the canonical create path, the DOM-widget mount invariant intact) with cfg.phantom = true serialized in node.properties.hubConfig: the canvas hides it completely (hub_node skips drawNode AND getNodeOnPos hit-testing for phantoms - an invisible node can never swallow clicks, drag or selection), the hub is created cfg.pinned so renderHub floats its window the moment the UI mounts, and the flag survives reloads (the window re-floats through the normal pinned-hub path; phantom hubs of foreign workflows are pruned as usual); the floating header of a phantom gains a trash button (delete the hub, double-click confirm) and a double-click title rename (node.title, serialized), while the pin button MATERIALIZES: it clears the flag and homes the UI into the now-visible canvas node (same id, bindings and presets) - the node way stays exactly as it was. Includes v89 - NAMED FIELDS + CONTEXT FILL + CHAT SEARCH + OWN PROMPTS PATH + THE WAY BACK (owner corrections 2026-11-09: 'the chat settings are just fields without names - you only learn what a value is from the tooltip - the fields must have names' + 'display the used and the available context in the chat' + 'the saved-chat search must be flexible: multi-words, by the chat title, the content or all together' + 'the user must be able to set his own system-prompts path' + 'the system prompts list is unreadable - many files all squished together' + 'when the chat or the stack is hidden the user may not know where to bring it back - the info that it is in the ComfyUI settings must be there'): v89 (web/chat.js + web/stack.js + web/styles.css + py/chat_proxy.py): ⚙ CHAT SETTINGS = NAMED FIELDS: every number sits under its own visible mini label in a 2-column grid (temperature / top_p / max tokens / history depth / media depth / image max side / images per msg / video frames / video max side - the full explanation stays in the tooltip) + a 'context size (0 = auto)' row; CONTEXT FILL: every /send reply carries ctx {used, total, est} - used = the upstream usage.prompt_tokens when reported (exact), else the proxy's estimate (chars/4 + 8/msg + 750/image, shown with ≈), total = cfg 'ctx_size' (0 = auto: the PolyStrata /v1/status context.native, probed + cached 180 s server-side); the status line shows 'ctx 3.2k/32k' (⚠ past 90%) and the assistant message stores it so it survives reloads; 🕘 SAVED-CHATS SEARCH: a live search row - every word must hit the chat title OR the message content (together), each hit shows a snippet of the matching content line, the server scans (GET /chat/sessions?q=); PROMPTS PATH: ⚙ gains 'System prompt catalog' with a 'Prompts folder' row (Enter applies, [default] resets) - cfg 'prompts_dir' replaces the PolyStrata models/LLM/prompts for BOTH the listing and the per-send read; SQUISHED PROMPT LIST FIXED: .hub-cp-list is a flex COLUMN with max-height and the items kept the default flex-shrink:1 - with more files than fit every item collapsed to a few px (the owner's screenshot); flex: 0 0 auto pins them and the list scrolls instead; THE WAY BACK: hiding the chat or the stack toasts 'ComfyUI Settings → SettingsHub → ...' and both ⚙ popups spell it right under the switch. Includes v88 STANDALONE PANELS + PROMPT CATALOG + FULL MODEL LIST (owner corrections 2026-11-09: 'settingshub is not present in every workflow and managing the stacker and chat from it is inconvenient - they are separate useful utilities, how is it done right in ComfyUI?' + 'I did not ask you to invent system prompt presets - the PolyStrata nodes have a catalog of my own prompts, the txt path is the same as the nodes, with a refresh button and a live multi-word search' + 'the model list shows only ONE active model - look how the PolyStrata nodes get the models'): v88 (web/chat.js + web/stack.js + web/hub_ui_renderer.js + py/chat_proxy.py): the hub ⚙ popup loses the Stack and Chat sections - both panels are SELF-MANAGED utilities now: the stack header gains ⚙ opening ITS OWN settings popup (Panel On/Off, max entries, the v77 scope, the v84 storage folder - the exact rows the hub hosted), the chat ⚙ gains the Panel On/Off row; BOTH On/Off switches are registered as NATIVE ComfyUI settings (app.ui.settings.addSetting, ids SettingsHub.PasteStack.enabled / SettingsHub.Chat.enabled -> ComfyUI Settings → SettingsHub) - reachable in EVERY workflow, with or without a hub node, so a hidden panel can always be brought back; 📜 SYSTEM PROMPT = THE USER'S CATALOG: the invented preset chips are GONE - the popup lists the .txt files of ComfyUI/models/LLM/prompts (prompt_root() of the PolyStrata nodes, subdirs included) with a [↻] refresh re-scan and a LIVE MULTI-WORD search (every word must match the relative path), a click stores cfg.prompt_preset and the SERVER reads the file FRESH on every send with the node semantics (preset WINS over the custom text; unreadable = empty + a console note), 'none (custom text)' + textarea + Save/Clear stay; MODEL DROPDOWN = THE FULL LIST: [model ▾] + [↻] read the new GET /settings_hub/chat/models that tries /api/models FIRST - the PolyStrata registry of ALL installed models with statuses (available/loaded/unloaded/loading, broken ones hidden - exactly how the NODES fill their dropdowns), then /v1/models, then /v1/status; options carry status marks (● loaded/selected, ◐ loading, ○ available) and selecting a not-loaded registry model SWITCHES the server through POST /chat/load -> /api/models/load (the node way, may take minutes; /v1/load stays as the llama.cpp fallback). Includes v87 (web/chat.js + py/chat_proxy.py): the chat panel gains a TOOLBAR under its input - [model] fed by /v1/models with a [↻] refresh (a change applies + toasts, ⚡ can load it now), [think ▾] default/off/low/medium/high, [📜] system prompt (preset chips - concise/detailed/programmer/translator/SD-prompt-engineer - apply instantly, a textarea stores the custom text, Clear = none), [⚡] GPU & memory; the HEADER carries ⚙ = the full chat settings popup (URL + key + [Test], sampling, history/media depth, image/video limits, stream, keep-chats, timeout, storage folder - the exact rows the hub used to host, Enter applies / Esc reverts) while ⚙ Hub settings → Chat keeps ONLY the On/Off switch; the GPU popup talks to the new /settings_hub/chat/gpu routes that port the PolyStrata memory mechanics: POST /v1/vram {reserve_mib} keeps N MiB of VRAM FREE for ComfyUI (the server remembers and re-applies it after engine restarts), the proxy also syncs comfy.model_management.EXTRA_RESERVED_VRAM with the LLM's ACTUAL consumption (the llama.cpp-node method - ComfyUI plans its loads around the LLM and stops catching OOM), cfg.vram_reserve_mib > 0 is re-applied by the SERVER before EVERY chat message (best-effort, errors never fail the chat), [Unload model] POSTs /v1/unload (the engine stops, ALL of its VRAM + the reservation come back), [Load now] POSTs /v1/load, [Free ComfyUI memory] runs unload_all_models + soft_empty_cache + gc (ComfyUI's own button; the LLM is untouched); [＋] + a typed name + Enter now creates the tab UNDER THAT NAME (the title used to be dropped); the ⚙/📜/⚡ popups are body-level, single-instance, viewport-clamped; PAGE ZOOM: a devicePixelRatio change rescales the saved geometry (x/y/w/h/chip) of the chat panel, the stack panel and every floating pin window by the zoom factor before the usual refit - the windows keep their physical size and never drift off-screen (in-canvas hubs are LiteGraph DOM widgets and follow the canvas as always); the ⚙ Hub settings popup is viewport-capped with a styled scrollbar. Includes v86 (LLM CHAT PANEL: a floating panel EXACTLY like the Paste Stack (drag the header, resize by the grip, [–] chip, the v85 refit keeps it inside the viewport) whose TABS are separate dialogs: sessions live SERVER-side in user/settings_hub/chat/ (they survive reloads, are shared by every browser and travel with the ComfyUI folder), 🕘 reopens/deletes saved dialogs, dblclick renames a tab, [＋] starts one; answers render markdown-lite through an ESCAPING renderer (fenced code blocks with a copy button, `inline`, **bold**, *italic*, links - no external parser, no XSS surface), thinking models get a collapsed 💭 block (reasoning_content), replies STREAM as they arrive (SSE through the proxy) and ⏹ aborts - the server notices the vanished browser, cancels the upstream (PolyStrata frees the engine slot on 'client went away') and keeps the partial marked 'stopped'; attachments: images = VISION (the client downscales to the configured side, uploads a JPEG blob, the proxy sends OpenAI image_url data-URL parts), video = ffmpeg frames cut SERVER-side in the PolyStrata mtmd convention ([Video N] + <X.X seconds> + one image_url per frame, so the model sees a sequence), text files go inline capped at 300 KB; 📎 / Ctrl+V / drag&drop attach, chips preview above the input, sent messages keep clickable thumbnails opening the v83-style viewer (image wheel zoom, video player, text preview); message actions 📋 copy, ↻ regenerate, ✎ edit-and-resend (cuts the tail); the browser NEVER talks to the LLM directly - py/chat_proxy.py is the single proxy (/settings_hub/chat/*): no CORS setup on the LLM server, the API key lives ONLY in user/settings_hub/chat/config.json on the SERVER (the UI shows a mask), aborts propagate; the chat is NOT an agent: no tools, no queue or workflow access (owner decision - integrations parked). Includes v85 (ONE MAGNIFIER PER STACK CARD + THE STACKER STAYS ON-SCREEN WHEN THE WINDOW SHRINKS. (owner reports 2026-11-09: 'text elements show 2 loupes that show the full text' + 'when the browser window shrinks, the stacker disappears beyond the browser window'): cardHtml built the base action set WITH the v83 magnifier and then the video/audio/file/text branches PREPENDED their extras as viewAct + ... + acts - a SECOND magnifier on every non-image card; now the base set carries the ONE magnifier (type-aware tooltip - text keeps the 'Full text view' wording) and every kind only adds its own buttons in front of pin/edit: image [SEARCH][pin][edit], video/audio/file [SEARCH][send][download][pin][edit], text [SEARCH][insert][pin][edit]. AND the panel geometry now follows the window: on build and on EVERY window resize the saved w/h are capped to the viewport and the saved x/y re-clamped - clampIntoView prefers the FULL panel inside the viewport (falls back to the drag clamp's 64px sliver, the minimized chip re-clamps the same way), the reduced size is NOT persisted so a window growing back restores the saved w/h, the position persists debounced (150ms), teardown removes the hook. Includes v84 (CUSTOM STACK STORAGE FOLDER. (owner request: 'the default stays user\\settings_hub\\stack but the settings must let me re-point the path to my own - any folder, by absolute path'; owner follow-up: the first attempt landed OUTSIDE the settings - redone in the right place): ⚙ Hub settings -> Stack gains a 'Storage folder (v84)' row - type an ABSOLUTE folder (D:\\gen\\stack, /home/me/comfy_stack, ~/comfy_stack), Enter applies it (the inline-editor Enter/Esc contract), the [default] chip applies the empty path; py/stack_store.py v84 strips pasted quotes, expands ~, REFUSES relative paths, creates the folder and probes writability BEFORE switching (a rejected path can never leave the store half-moved) and persists the choice server-side in user/settings_hub/stack_root.json - always in the DEFAULT user dir, so a broken custom path cannot hide the way back; the answer comes from GET/POST /settings_hub/stack/root ({ok, root, custom, default, writable}); every stack route follows the active root through _stack_root() - the shared store, the per-workflow ?wf= stores, health (which now also answers 'custom'), eviction and blob serving; switching the folder NEVER moves entries - the new location starts empty and the old one keeps its files (AGENTS.md 5.1 rule 7, the scope-switch contract); the status line under the input shows the folder active right now, a server refusal (relative path / not writable) shows in red there, and an old py without the route says 'update the FULL pack and RESTART ComfyUI'). Includes v83 (COMPARE NEVER SHOWED ITS IMAGES + STACK MEDIA VIEWER. (owner report 2026-11-09: 'added two stack images to the compare - only the A/B labels show, the images never display'): since v73 the JS toggled visibility with style.display = \"\" which only REMOVES the inline override and lets the stylesheet's display:none default (.hub-cmp-slot/.hub-cmp-canvas/.hub-cmp-divider) win - slots, wipe divider and diff canvas were invisible FOREVER in a real browser while the jsdom tests' '!== none' check passed; all toggles now set explicit block/none, plus a natural-size caption (A 832x1216 / B 1024x1024) under the stage for different-resolution pairs and a diff hint that names B scaled to A's frame. (owner request: 'the text can be viewed - now images, video and files must be viewable too, the small thumb hides the details that matter'): every image/video/audio/file stack card carries a SEARCH button opening the LARGE media viewer - images: fit-to-screen with wheel zoom 0.2-8x around the cursor, drag pan, double-click 1:1<->fit and the natural dimensions in the meta line; video: big player (controls, muted autoplay); audio: big player; files: inline text preview for txt/md/json/csv/log/xml/yml/yaml/ini/tsv (session blob first, server file route fallback, capped 300 KB with a truncation marker, copy copies the shown text) and a plain 'binary file - no inline preview' + download note otherwise; Esc/x/backdrop close it, the v79 text viewer is unchanged and stays the SEARCH of text cards. Includes v82 (SINGLE-SOURCE VERSION (owner: 'with every update ALL project files change because of the version number' - the vNN stamp lived in EVERY web module and every release rewrote all of them, and the v78 tree even shipped guards whose error text said v77 while the stamp said v78): the version literal now lives ONLY in this entry (+ STACK_SERVER_VERSION in py/stack_store.py + the README badge), each submodule self-reports the version of its LAST FUNCTIONAL CHANGE under __SettingsHubLoaded (sync v71, pins v70, nav_points v69, hub_node v67, hub_ui_renderer v77, sync_manager v70, stack v83, compare v83, context_menu v70, core v70) and the entry EXPECTED manifest verifies the table after the imports - a browser-cached stale file is still NAMED in F12 with BOTH versions (the visible degradation banner too), while a release diff now touches only the files that actually changed. tools/version.py does the mechanical bump and audits the convention (--check), tools/compare.py diffs the installed custom_nodes folder against a new zip per-file with advice (RESTART on py change, Ctrl+F5 on web change). ONE-TIME MIGRATION COST: this v82 release touched every module file for the last time (self-report lines replaced the per-file guards).). Includes v80 (PASTE STACK MOVE MODE (owner: 'a toggle button that enables a move mode - sort the order of the stack entries'): the tools row gains a ⇅ TOGGLE - when ON every card (including file cards) becomes a REORDER handle: dragging computes a drop SLOT from the list positions (down = under the hovered card, up = above), a green insertion line shows the landing spot, the ordinary drag targets (nodes/mirrors/tab chips) are OFF while sorting and a plain card click does nothing (small action buttons keep working); the drop splices the pair in the GLOBAL order (inside a tab view exactly that pair moves, other views keep their relative order) and persists via the new POST /settings_hub/stack/reorder {order:[ids]} - the server applies the known ids in the payload order, appends unmentioned entries at the END (a stale client never loses entries) and answers with the rewritten list, which the client mirrors positionally; an old py keeps the new order session-only (one console.info, no scary note); the list autoscrolls near its edges; the mode is transient - always OFF after a reload.), Includes v79 (PASTE STACK TABS + FULL-TEXT VIEWER (owner: 'add tabs to the stack - entries are filled in for different tasks, there must be grouping' + 'no way to see the FULL content of a cell - long prompts start identically and look like duplicates'): a TAB BAR under the header - [All (total)] [Task A (n)] [+] - All is the default pre-v79 view, tab order = creation order remembered PER SCOPE (localStorage settingshub.stack.tabs), an empty tab is fine; CAPTURE lands in the OPEN tab (Ctrl+V / paste click / OS files); cards MOVE by dragging onto a tab chip (dropping on All ungroups) or the new tab field in the card editor; double-click a chip RENAMES (re-patches every entry, renaming onto an existing name merges), the chip x REMOVES (armed like the trash - entries fall back to All, never deleted - AGENTS.md 5.1 rule 9); the trash clears the ACTIVE view (a tab -> server clear?tab= wipes only that tab; All -> the whole store as before); text cards gained a 🔍 FULL-TEXT VIEWER - a centered overlay with the COMPLETE text, copy and insert buttons, closed by Esc/x/backdrop - no more identical-looking truncated prompts; the workflow embed carries each snippet's tab). Includes v78 (QUIET GREEN NOTES (owner: the green 'storage works / py predates v76' self-diagnosis note popped up on EVERY page reload and got annoying): the GREEN verdicts (legacy / mismatch - storage actually WORKS, nothing is broken) now show ONCE per state and self-retire - the seen flag lives in localStorage (settingshub.stack.noteSeen), a \u2715 dismiss button hides the current one immediately, and afterwards a single console.info carries the details instead of the panel block; the RED states (missing/network/http/nowrite) always stay visible because something IS broken. The legacy note now also spells out the actual fix: RESTART ComfyUI after a full-pack update (py/ loads only at server startup). Includes v77 (Paste Stack SCOPE MODES (owner request: the stack followed him across workflows and neither shared-only nor workflow-only is right - make it a switch): ⚙ Hub settings → Stack → 'Stack scope' = Shared (default, one stack for every workflow, as always) or Per-workflow (every workflow keeps its OWN stack: the binding id lives in the workflow file's extra_data.settingshubStackId - the stack is literally saved into the workflow - entries are stored server-side under user/settings_hub/stack/workflows/<id>/ via the new ?wf= parameter on every stack route, the header shows an @workflow badge, and 🗑 clears only the active scope). Text snippets are ALSO mirrored into the workflow file (extra_data.settingshubStack, inline texts only, 200KB budget) and are auto-restored when that workflow's server store comes up empty - prompts survive moving the workflow to another machine or wiping the user folder; a workflow switch (graph onConfigure/onClear) re-reads THAT workflow's store in per-workflow mode. Switching the scope NEVER migrates entries - each scope keeps its own (AGENTS.md 5.1 rule 7). Also fixed here: the window-focus re-sync carried no sequence id and has been a silent no-op since v70. Includes v76 (Paste Stack STORAGE SELF-DIAGNOSIS (owner report: 'storage unreachable' on every page reload, even after restarts): the panel now probes the new GET /settings_hub/stack/health py route ({ok, version, dir, writable, items}) and the degraded note names the EXACT cause and fix - py routes missing (old py/, typically only web/ was replaced during an update -> reinstall the FULL zip), no connection, HTTP <status>, storage folder not writable, legacy server (v70-v75 py: storage WORKS, green note), or a web-vs-py VERSION MISMATCH (half-updated install -> restart/reinstall) - plus a [check again] button that re-probes and re-syncs without a page reload). Includes v75 (Paste Stack header cleanup: the [✕] close button REMOVED - only [–] minimize-to-chip and 🗑 clear remain; the panel is disabled ONLY via ⚙ Hub settings → Stack → Off), v74 (the list SCROLLS for real (min-height:0 + a styled always-visible scrollbar), a 🗑 CLEAR button lives in the panel header (double-click confirm; removed from the settings popup), stack cards drag onto REAL nodes for every kind (image -> LoadImage, video -> VHS/native LoadVideo via options.video_upload, audio -> LoadAudio via options.audio_upload, all uploaded through /upload/image - ComfyUI has no /upload/audio), TEXT cards drop onto prompt nodes and write the string widget under the cursor, the inline rename/tags editor commits on Enter (Esc cancels), and a focused input (even inside the panel) wins Ctrl+V over capture; the eye toggle now also hides the nav authoring buttons (AGENTS.md 5.1)), v73 (IMAGE COMPARE: right-click a media row/gallery thumbnail/stack image card -> Add to Compare, a floating A/B panel with WIPE/FADE/BLINK/DIFF modes + gain, A/B swap, auto-refresh on executed), v72 (Paste Stack snippets: pins/rename/tags/search/kind filters/usage counter/into-the-string insert), v71 (files & drag + OS-clipboard helper + drag-to-Load-Image), v70 (Paste Stack standalone floating panel with server-side storage), v69 (nav points pin the CURRENT canvas zoom on create), v68 (hotkey capture fix), v67 (per-point hotkeys), v66 (fail-open registration), v65 (top-left jump anchor), v64 (fresh-add mount invariant)));");

// Load CSS via link tag to avoid module MIME type errors. The version query
// busts styles.css staleness on every build (safe: plain stylesheet, no
// module-instance semantics).
(function loadStyles() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css?v=90", import.meta.url).href;
    document.head.appendChild(link);
})();

// v82 SINGLE-SOURCE VERSION (docs/plan-versions.md): the stamp is set here,
// BEFORE any submodule import, and lives ONLY in this file (+ py + README
// badge). Submodules carry NO version literal - each self-reports the
// version of its LAST FUNCTIONAL CHANGE under globalThis.__SettingsHubLoaded
// and the EXPECTED manifest below verifies the table after the imports, so
// a half-updated module set (the browser serving a cached file next to fresh
// ones) still announces itself in F12 - with the stale files NAMED and both
// versions shown. Field lesson from the v63 rollout: "the fix did not work"
// was indistinguishable from "the fix never loaded" - the banner alone
// cannot prove the SUBMODULES are fresh.
// v66 FIELD LESSON (still in force): the v64 gate treated the mixed-build
// report as FATAL and skipped the registration entirely - after an update,
// ONE stale cached file silently removed every "Pin to Settings Hub" menu
// item and the sync hooks. The detector keeps its diagnostic value but is
// NO LONGER allowed to disable the pack.
globalThis.__SettingsHubBuild = "v90";
globalThis.__SettingsHubLoaded = {};

// Import order matters: core/sync first, then feature modules. A failure in
// one file is logged and does not prevent the rest from being attempted.
const FILES = [
    "./sync.js",            // internal bus (locks, rAF queue)
    "./pins.js",            // badge counter cache
    "./nav_points.js",      // v61: nav points - resolver/jump/aim/markers/RMB
    "./hub_node.js",        // node registration + drawNode badge painter
    "./hub_ui_renderer.js", // DOM widget rendering
    "./sync_manager.js",    // target-widget callback hooks (reactive sync)
    "./stack.js",           // v70: Paste Stack - floating clipboard panel
    "./chat.js",            // v89: LLM Chat - named settings fields + ctx fill + chat search + own prompts path
    "./compare.js",         // v73: Image Compare - A/B wipe/fade/blink/diff panel
    "./context_menu.js",    // "📌 Pin to Settings Hub" menus + batch picker
];

// v35 CRITICAL: top-level await, NOT a fire-and-forget async IIFE. ComfyUI
// awaits `import(entry)` until the entry's EVALUATION completes; an IIFE
// would resolve that promise before any submodule registered itself and the
// whole pack would hook in after app.setup() - too late. TLA keeps the
// registration timing identical to the old static import graph.
{
    const mods = {};
    const failed = [];
    for (const f of FILES) {
        try {
            mods[f] = await import(f);
        } catch (err) {
            failed.push(f);
            console.error("[SettingsHub] FAILED to load " + f + " - the pack is PARTIAL; re-copy web/ and hard-refresh (Ctrl+F5). Error:", err);
        }
    }

    // v82 MIXED-BUILD CHECK (replaces the v67 missing-self-report scan): a
    // module that loaded but reports a DIFFERENT version than EXPECTED is a
    // browser-cached stale file; both sides are named. NON-FATAL (v67
    // fail-open): the pack registers whatever actually loaded.
    const EXPECTED = {
        "sync": "v71",            // internal bus
        "pins": "v70",            // badge counter cache
        "nav_points": "v69",      // nav points (zoom pinning)
        "hub_node": "v90",        // node registration + badge painter + phantom hiding (virtual hubs)
        "hub_ui_renderer": "v90", // DOM widget rendering (+ phantom pin header, Interface font row)
        "sync_manager": "v70",    // reactive sync hooks
        "stack": "v90",           // Paste Stack (tabs + move mode + media viewer + zoom follow + own ⚙ popup + hide toast + font row)
        "chat": "v90",            // LLM Chat (toolbar + own settings + prompt catalog + full model list + zoom follow + named fields + ctx fill + sessions search + font row)
        "compare": "v83",         // Image Compare A/B panel (v83 display fix)
        "context_menu": "v90",    // "Pin to Settings Hub" menus (+ canvas "New virtual hub")
    };
    const stale = [];
    for (const k of Object.keys(EXPECTED)) {
        if (!mods["./" + k + ".js"]) continue; // load failure - already reported above
        const got = globalThis.__SettingsHubLoaded?.[k];
        if (!got) stale.push(k + ".js (no self-report - pre-v67 stale cache)");
        else if (got !== EXPECTED[k]) stale.push(k + ".js (is " + got + ", pack expects " + EXPECTED[k] + ")");
    }
    if (stale.length) {
        console.error("[SettingsHub] MIXED BUILD detected: STALE CACHED module(s) " +
            stale.join(", ") +
            ". The pack still registers what loaded (fail-open), but a HARD REFRESH (Ctrl+F5) is required after updating the extension folder.");
    }

    // v66/v67 FAIL-OPEN registration, per module: menus first (the most visible
    // feature), then the reactive-sync hooks; each guarded independently so
    // one dead file cannot take the others down with it (v60 semantics plus
    // the v64 diagnostics).
    if (mods["./context_menu.js"]?.attachContextMenu) {
        try { mods["./context_menu.js"].attachContextMenu(); }
        catch (err) { console.error("[SettingsHub] attachContextMenu failed:", err); }
    } else {
        console.error("[SettingsHub] context_menu.js unavailable - 'Pin to Settings Hub' menus CANNOT register (see the failed list above if any).");
    }

    if (mods["./sync_manager.js"]?.syncAll) {
        app.registerExtension({
            name: "Comfy.SettingsHub.hooks",
            setup() {
                mods["./sync_manager.js"].syncAll();
            },
            afterConfigureGraph() {
                mods["./sync_manager.js"].syncAll();
            },
        });
    } else {
        console.error("[SettingsHub] sync_manager.js unavailable - reactive sync CANNOT register (see the failed list above if any).");
    }

    // v70: the Paste Stack panel mounts in extension setup (AFTER the DOM is
    // ready, independent of any hub node). Fail-open like everything else: a
    // dead stack.js costs only the panel, never the menus or the sync.
    if (mods["./stack.js"]?.initStack) {
        app.registerExtension({
            name: "Comfy.SettingsHub.stack",
            setup() {
                try { mods["./stack.js"].initStack(); }
                catch (err) { console.error("[SettingsHub] stack panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] stack.js unavailable - the Paste Stack panel CANNOT register (see the failed list above if any).");
    }

    // v86: the LLM Chat panel mounts in extension setup like the stack - a
    // standalone floating window, independent of any hub node. Fail-open: a
    // dead chat.js costs only the chat panel.
    if (mods["./chat.js"]?.initChat) {
        app.registerExtension({
            name: "Comfy.SettingsHub.chat",
            setup() {
                try { mods["./chat.js"].initChat(); }
                catch (err) { console.error("[SettingsHub] chat panel init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] chat.js unavailable - the LLM Chat panel CANNOT register (see the failed list above if any).");
    }

    // v73: Image Compare installs its context-menu + executed listeners in
    // extension setup; the panel itself is built lazily on the first
    // "Add to Compare". Fail-open like the stack.
    if (mods["./compare.js"]?.initCompare) {
        app.registerExtension({
            name: "Comfy.SettingsHub.compare",
            setup() {
                try { mods["./compare.js"].initCompare(); }
                catch (err) { console.error("[SettingsHub] compare init failed:", err); }
            },
        });
    } else {
        console.error("[SettingsHub] compare.js unavailable - Image Compare CANNOT register (see the failed list above if any).");
    }

    // v66: the degradation is made VISIBLE - the field report proved an
    // F12-only error never gets seen ("the menus just disappeared"). Inline
    // styles only: styles.css itself may be the stale file here.
    if (failed.length || stale.length) {
        try {
            const parts = [];
            if (failed.length) {
                parts.push("failed to load: " + failed.map((f) => f.replace(/^\.\//, "")).join(", "));
            }
            if (stale.length) {
                parts.push("stale cached: " + stale.join(", "));
            }
            const el = document.createElement("div");
            el.textContent = "⚠ SettingsHub build degraded - " + parts.join(" · ") +
                " - HARD-REFRESH the page (Ctrl+F5); until then some menus may be missing. Click to dismiss.";
            el.title = "Click to dismiss";
            Object.assign(el.style, {
                position: "fixed", left: "12px", bottom: "12px", zIndex: "999999",
                maxWidth: "560px", padding: "10px 14px", borderRadius: "8px",
                background: "#4a1f1f", color: "#ffd9d9", border: "1px solid #a5533f",
                font: "12px/1.45 system-ui, sans-serif", cursor: "pointer",
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)", userSelect: "none",
            });
            el.addEventListener("click", () => el.remove());
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 25000);
        } catch (_) { /* the banner is best-effort; registration is done */ }
    }
}

// ---------------------------------------------------------------------------
// v90 MODAL GUARD (owner: "when I open some ComfyUI windows, like the Comfy
// settings, my stacker, hub and chat are ON TOP of those windows, do not
// react to clicks and get in the way of interacting with the settings window
// or other ComfyUI windows").
//
// Our floating layers (hub pin panels, the stack, the chat, the compare
// panel, menus, popups, viewers, toasts) carry z-index 99900..2147483000 so
// they always win over the canvas - and that also made them win over
// ComfyUI's own modal dialogs (.comfy-modal z-index ~10000), visually
// covering them and catching the clicks meant for the dialog.
//
// The guard watches for a VISIBLE modal (a .comfy-modal with display other
// than none, or a native <dialog open>) and toggles body.sh-modal-open; the
// v90 block in styles.css makes every SettingsHub floating layer
// visibility:hidden + pointer-events:none while the class is set. visibility
// (not display) keeps the layout boxes intact, so the geometry/clamp code
// never reads zero rects, and everything returns the moment the dialog
// closes. Event-driven through a MutationObserver on <html> (modal dialogs
// show/hide via class/style attribute changes or body childList) plus a
// 400 ms interval fallback for frontends that toggle modals in ways no
// mutation catches. Our own popups are NOT .comfy-modal elements, so they
// never trigger the guard against themselves.
// ---------------------------------------------------------------------------
function installModalGuard() {
    let open = false;
    const visibleIn = (list) => {
        for (const el of list) {
            try {
                const cs = getComputedStyle(el);
                if (cs.display !== "none" && cs.visibility !== "hidden") return true;
            } catch (_) { /* a broken element must not kill the scan */ }
        }
        return false;
    };
    const scan = () => {
        let any = false;
        try {
            if (document.querySelector) {
                any = visibleIn(document.querySelectorAll(".comfy-modal")) ||
                    visibleIn(document.querySelectorAll("dialog[open]"));
            }
        } catch (_) {}
        if (any === open) return;
        open = any;
        try { document.body.classList.toggle("sh-modal-open", open); } catch (_) {}
    };
    try {
        if (typeof MutationObserver === "function") {
            const mo = new MutationObserver(scan);
            const arm = () => {
                try {
                    mo.observe(document.documentElement, {
                        attributes: true, childList: true, subtree: true,
                    });
                } catch (_) {}
            };
            if (document.documentElement) arm();
            else document.addEventListener("DOMContentLoaded", arm, { once: true });
        }
    } catch (_) {}
    setInterval(scan, 400);   // belt-and-braces fallback (cheap query)
    scan();
}
try { installModalGuard(); } catch (err) {
    console.warn("[SettingsHub] modal guard unavailable:", err);
}
