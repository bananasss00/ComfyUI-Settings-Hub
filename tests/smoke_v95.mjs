// ============================================================================
// tests/smoke_v95.mjs - v95 regression suite (1 owner follow-up fix to v94)
// ----------------------------------------------------------------------------
// Covers the owner request that shipped in v95:
//   PA  build/manifest: the entry reports v95; NO module self-report moved
//       (CSS-only round); styles.css?v= and the py stamp follow the entry;
//   PB  RENAME POPUP Z-ORDER (owner: "сам попап находится под хабом и
//       приходится сам хаб отодвигать в сторону чтобы он не перекрывал"):
//       the popup stacked at 99920 - BELOW the floating hub window
//       (.hub-pin-panel, 99990) - and it is anchored to the window's
//       top-left corner, so whenever they overlapped the window covered the
//       input. The popup must stack above the hub window AND above every
//       other hub floating layer it can legally coexist with, and the v90
//       modal guard must still hide it when a ComfyUI modal is open;
//   PC  the popup source (hubRenameFlow in hub_ui_renderer.js) is unchanged
//       in shape: same class, same anchor, wired to both openers.
//
// Run: node tests/smoke_v95.mjs   (no jsdom needed - source-level checks)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");

let PASS = 0, FAIL = 0;
const FAILURES = [];
const check = (name, cond, detail) => {
    if (cond) { PASS++; console.log("  ok  " + name); }
    else { FAIL++; FAILURES.push(name + (detail ? " :: " + detail : "")); console.log("  FAIL " + name + (detail ? " :: " + detail : "")); }
};
const phase = (t) => console.log("\n[" + t + "]");

const num = (css, sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}"));
    if (!m) return null;
    const z = m[0].match(/z-index:\s*(\d+)/);
    return z ? parseInt(z[1], 10) : null;
};

// ---------------------------------------------------------------------------
phase("PA build v95 + version manifest");
{
    const entry = fs.readFileSync(path.join(WEB, "settings_hub.js"), "utf8");
    check("PA the entry reports v103 (exactly once)",
        (entry.match(/globalThis\.__SettingsHubBuild = "v103"/g) || []).length === 1);
    check("PA the banner names the v103 workflows round",
        entry.includes("web build: v103 - WORKFLOWS MANAGER FEEDBACK ROUND 2"));
    check("PA styles.css?v= follows the entry (cache-bust for the layout fix)",
        entry.includes("styles.css?v=103"));
    check("PA stack stays v100, chat stays v98, launcher stays v101, workflows are v103",
        entry.includes('"chat": "v98"') && entry.includes('"stack": "v100"') && entry.includes('"hub_ui_renderer": "v94"') &&
        entry.includes('"launcher": "v101"') && entry.includes('"workflows": "v103"') && entry.includes('"core": "v93"'));
    const py = fs.readFileSync(path.join(ROOT, "py", "stack_store.py"), "utf8");
    check("PA py STACK_SERVER_VERSION = v103 (bumps together with the entry)",
        py.includes('STACK_SERVER_VERSION = "v103"'));
    const wpy = fs.readFileSync(path.join(ROOT, "py", "workflows_store.py"), "utf8");
    check("PA py WORKFLOWS_SERVER_VERSION = v103 (bumps together with the entry)",
        wpy.includes('WORKFLOWS_SERVER_VERSION = "v103"'));
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    check("PA README badge is v103", /web%20build-v103-/.test(readme));
}

// ---------------------------------------------------------------------------
phase("PB rename popup stacks ABOVE the hub window (owner bug)");
{
    const css = fs.readFileSync(path.join(WEB, "styles.css"), "utf8");
    const pop = num(css, ".hub-hub-rename-pop");
    const panel = num(css, ".hub-pin-panel");
    const menu = num(css, ".hub-menu");
    const cmp = num(css, ".hub-cmp-menu");
    check("PB .hub-hub-rename-pop carries a z-index", pop !== null);
    check("PB .hub-pin-panel (the floating hub window) carries a z-index", panel !== null);
    check("PB the popup is ABOVE the hub window (was 99920 vs 99990)",
        pop !== null && panel !== null && pop > panel, `pop=${pop} panel=${panel}`);
    check("PB the popup is ABOVE .hub-menu (100000)",
        pop !== null && menu !== null && pop > menu, `pop=${pop} menu=${menu}`);
    check("PB the popup is ABOVE .hub-cmp-menu (100001)",
        pop !== null && cmp !== null && pop > cmp, `pop=${pop} cmp=${cmp}`);
    check("PB the popup z-index is set EXACTLY once (no later override)",
        (css.match(/\.hub-hub-rename-pop\s*\{[\s\S]*?\}/g) || []).filter((b) => /z-index:/.test(b)).length === 1);
    check("PB the v90 modal guard still hides the popup over ComfyUI modals",
        /body\.sh-modal-open \.hub-hub-rename-pop,[\s\S]{0,200}visibility: hidden !important/.test(css));
}

// ---------------------------------------------------------------------------
phase("PC hubRenameFlow wiring unchanged (both openers hit the same popup)");
{
    const rsrc = fs.readFileSync(path.join(WEB, "hub_ui_renderer.js"), "utf8");
    check("PC the popup carries .hub-hub-rename-pop",
        rsrc.includes('pop.className = "hub-menu hub-hub-rename-pop"'));
    check("PC the popup anchors to the hub window, else the hub DOM root",
        rsrc.includes("pinPanels.get(node)?.panel || stateMap.get(node)?.root"));
    check("PC the window right-click menu opens the same popup",
        rsrc.includes('registerHubAction("rename", hubRenameFlow)'));
    check("PC the double-tap on the title opens the same popup",
        rsrc.includes("try { hubRenameFlow(node); } catch (_) {}"));
    check("PC Enter commits, Esc cancels (the keydown capture handler)",
        /onKey = \(e\) => \{[\s\S]{0,200}Escape[\s\S]{0,200}Enter[\s\S]{0,200}\};/.test(rsrc));
}

// ---------------------------------------------------------------------------
console.log(`\nsmoke_v95: ${PASS} passed, ${FAIL} failed`);
if (FAIL) {
    for (const f of FAILURES) console.log("  FAIL: " + f);
    process.exit(1);
}
process.exit(0);
