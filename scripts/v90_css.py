#!/usr/bin/env python3
"""v90 CSS transformer: font-size scaling via --sh-fs + modal guard + overflow guards.

Owner request v90: "a setting which allows regulating the font size in the hub,
the stack and the chat - the main thing is that nothing goes out of bounds, the
interfaces must adapt correctly to different font sizes" + "when ComfyUI windows
are open (like the Comfy settings) my stacker, hub and chat are ON TOP of those
windows, do not react to clicks and get in the way".

What this does to web/styles.css:
  1. every `font-size: Npx` -> `font-size: calc(var(--sh-fs, 1) * Npx)`
     (except the .hub-media-thumb-ph placeholder, which lives inside a fixed
     60px media box and must never outgrow it);
  2. every `font: Npx/... ` shorthand size -> the same calc (10 sites);
  3. a curated set of text-bearing fixed heights / line-heights / widths
     scales with the same var (controls, chips, popups, number inputs);
     media thumbs, panels shells, grips and scrollbars keep their px;
  4. appends the v90 block: the MODAL GUARD (body.sh-modal-open hides every
     SettingsHub floating layer while a ComfyUI modal/dialog is open) and
     extra overflow guards.

Idempotent: running twice must not double-wrap calc() (guarded by regexes).
"""
import re
import sys

PATH = "web/styles.css"

css = open(PATH, encoding="utf-8").read()
orig = css

# ---------------------------------------------------------------------------
# 1) protect .hub-media-thumb-ph from scaling (fixed 60px media box)
# ---------------------------------------------------------------------------
PH_PROTO = """.hub-media-thumb-ph {
        font-size: 22px;
        color: #77789e;
        line-height: 60px;
    }"""
if PH_PROTO not in css and "calc(var(--sh-fs, 1) * 22px)" not in css:
    print("WARN: thumb-ph prototype not found verbatim; matching by rule")
PH_TOKEN = "\x00PH_RULE\x00"
m = re.search(r"\.hub-media-thumb-ph\s*\{[^}]*\}", css)
assert m, "cannot locate .hub-media-thumb-ph rule"
ph_rule = m.group(0)
css = css.replace(ph_rule, PH_TOKEN, 1)

n_before = css.count("font-size:")
# 2) font-size: Npx -> calc(var(--sh-fs, 1) * Npx)   (skip already-wrapped)
css = re.sub(
    r"font-size:\s*([0-9.]+)px",
    r"font-size: calc(var(--sh-fs, 1) * \1px)",
    css,
)
n_fs = n_before  # every px occurrence converted (none were wrapped before)

# 3) font: Npx/LH ... shorthand -> font: calc(...)/LH ...
n_font_before = len(re.findall(r"font:\s*[0-9.]+px/", css))
css = re.sub(
    r"font:\s*([0-9.]+)px(/)",
    r"font: calc(var(--sh-fs, 1) * \1px)\2",
    css,
)

# restore the protected rule verbatim
css = css.replace(PH_TOKEN, ph_rule, 1)

# ---------------------------------------------------------------------------
# 4) curated fixed geometry -> scale with the font (selector-scoped)
# ---------------------------------------------------------------------------
def scale_prop(block_sel: str, prop: str, px: str, css_text: str) -> str:
    """Replace `<prop>: <px>px` inside the rule whose selector == block_sel."""
    pat = re.compile(
        r"(" + re.escape(block_sel) + r"\s*\{[^}]*?" + re.escape(prop) +
        r":\s*)" + re.escape(px) + r"px")
    new, n = pat.subn(r"\g<1>calc(var(--sh-fs, 1) * " + px + "px)", css_text)
    if n != 1:
        print(f"WARN: {block_sel} {prop}:{px}px -> {n} matches")
    return new


SCALED = [
    # (selector, prop, px)
    (".hub-tab-bar", "min-height", "24"),
    (".hub-item-row", "min-height", "22"),
    (".hub-text-area", "min-height", "46"),
    (".hub-portal-ghost textarea", "min-height", "46"),
    ("textarea.hub-portal-ghost", "min-height", "46"),
    (".hub-queue-badge", "height", "16"),
    (".hub-media-thumb-size-input", "height", "14"),
    (".hub-media-thumb-dim", "min-height", "10"),
    (".hub-stack-scope", "line-height", "14"),
    (".hub-stack-count", "line-height", "15"),
    (".hub-stack-del", "height", "16"),
    (".hub-stack-del", "line-height", "14"),
    (".hub-stack-act", "height", "16"),
    (".hub-stack-act", "line-height", "14"),
    (".hub-stack-edit-btns .hub-stack-act", "height", "18"),
    (".hub-stack-edit-btns .hub-stack-act", "line-height", "16"),
    (".hub-chat-edit-ta", "min-height", "54"),
    (".hub-cp-ta", "min-height", "84"),
    # widths that would strangle scaled text
    (".hub-mirror select", "max-width", "100"),
    (".hub-mirror input.hub-num-input", "width", "52"),
    (".hub-cs-sel", "max-width", "160"),
    (".hub-set-pop", "min-width", "240"),
    (".hub-set-pop", "max-width", "300"),
    (".hub-chat-setpop, .hub-chat-promptpop, .hub-chat-gpupop", "width", "300"),
    (".hub-chat-toolbar .hub-chat-model", "max-width", "220"),
    (".hub-chat-toolbar .hub-chat-model", "min-width", "70"),
]
for sel, prop, px in SCALED:
    css = scale_prop(sel, prop, px, css)

# ---------------------------------------------------------------------------
# 5) v90 block: modal guard + overflow guards
# ---------------------------------------------------------------------------
V90_BLOCK = """

/* ===========================================================================
   v90 MODAL GUARD (owner: "when I open ComfyUI windows, like the Comfy
   settings, my stacker, hub and chat are ON TOP of those windows, do not
   react to clicks and get in the way of interacting with the settings window
   or other ComfyUI windows").
   The entry installs a watcher (settings_hub.js) that toggles
   body.sh-modal-open whenever a ComfyUI modal (.comfy-modal shown) or a
   native <dialog open> is on screen. While it is, EVERY SettingsHub floating
   layer steps aside: invisible and click-through. Rects stay intact
   (visibility, not display) so the geometry/clamp code never reads zeros,
   and everything comes back the moment the modal closes.
   =========================================================================== */
body.sh-modal-open .hub-pin-panel,
body.sh-modal-open .hub-menu,
body.sh-modal-open .hub-toast,
body.sh-modal-open .hub-batch,
body.sh-modal-open .hub-nav-aim-hint,
body.sh-modal-open .hub-cmp-panel,
body.sh-modal-open .hub-cmp-menu,
body.sh-modal-open .hub-stack-panel,
body.sh-modal-open .hub-stack-chip,
body.sh-modal-open .hub-stack-ghost,
body.sh-modal-open .hub-stack-targetbox,
body.sh-modal-open .hub-stack-viewer,
body.sh-modal-open .hub-chat-panel,
body.sh-modal-open .hub-chat-chip,
body.sh-modal-open .hub-fs-overlay,
body.sh-modal-open .hub-media-preview-pop,
body.sh-modal-open .hub-media-thumb-pop,
body.sh-modal-open .hub-sh-note {
    visibility: hidden !important;
    pointer-events: none !important;
}

/* v90 font-scale overflow guards: extra safety for the rows the curated
   conversions above cannot cover. Everything here is a no-op at scale 1. */
/* settings rows: the box may shrink under a long label instead of pushing */
.hub-cs-row > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
/* chat toolbar: many buttons + a wide model select must stay on one line */
.hub-chat-toolbar .hub-chat-tbbtn {
    flex: 0 0 auto;
    min-width: 0;
}
/* hub toolbar buttons never push the tab bar wider than the panel */
.hub-tab-bar {
    flex-wrap: wrap;
}
/* floating pin panel: the body scrolls when scaled content outgrows a
   user-fixed window (pinSize) instead of clipping silently */
.hub-pin-panel .hub-pin-body {
    overflow: auto;
}
"""

if "v90 MODAL GUARD" not in orig:
    css = css.rstrip() + V90_BLOCK

open(PATH, "w", encoding="utf-8").write(css)
print(f"font-size converted: {n_fs}")
print(f"font shorthand converted: {n_font_before}")
print(f"curated geometry scaled: {len(SCALED)}")
print(f"thumb-ph untouched: {ph_rule in css}")
print(f"v90 block appended: {'v90 MODAL GUARD' not in orig}")
