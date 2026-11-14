#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SettingsHub release version tool (dev-side, no dependencies).

WHY THIS EXISTS
---------------
Owner decision (v81 feedback): per-file version stamps in EVERY web module
mean every release touches every file - "with each update the whole project
changes because of the version number". The v82 convention fixes the ROOT:

    the version literal lives ONLY in
      * web/settings_hub.js   (entry: banner + __SettingsHubBuild + styles.css?v=)
      * py/stack_store.py     (STACK_SERVER_VERSION)
      * py/workflows_store.py (WORKFLOWS_SERVER_VERSION, v101+)
      * README.md             (badge)
    and NOWHERE else. Submodules carry NO version literal; they self-report
    under __SettingsHubLoaded and the entry verifies the manifest, so stale
    cached files are still NAMED in F12 without per-file stamps.

This tool makes the release mechanical and auditable:

  python tools/version.py v82      # bump the mechanical version literals
  python tools/version.py --check  # audit stamp hygiene (CI-style, exit 1 on error)

The ROOT is always the folder that contains tools/ (the pack itself).
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "web" / "settings_hub.js"
PYSTORE = ROOT / "py" / "stack_store.py"
# v101: the Workflows Manager storage (the same bump-together rule)
WFSTORE = ROOT / "py" / "workflows_store.py"
README = ROOT / "README.md"

RE_ENTRY_STAMP = re.compile(r'(globalThis\.__SettingsHubBuild\s*=\s*")(v\d+)(")')
RE_CSS_QUERY = re.compile(r'(styles\.css\?v=)(\d+)')
RE_BANNER = re.compile(r'(web build: )(v\d+)( - )')
RE_PY_STAMP = re.compile(r'(STACK_SERVER_VERSION\s*=\s*")(v\d+)(")')
RE_WF_STAMP = re.compile(r'(WORKFLOWS_SERVER_VERSION\s*=\s*")(v\d+)(")')
RE_BADGE = re.compile(r'(web%20build-)(v\d+)(-\w+)\)')
RE_GUARD = re.compile(r'__SettingsHubBuild\s*!==\s*"(v\d+)"')
# v82: EXPECTED manifest in the entry + per-module self-report literals
RE_EXPECTED = re.compile(r'"(\w+)":\s*"(v\d+)"')
RE_SELFREPORT = re.compile(r'globalThis\.__SettingsHubLoaded\["(\w+)"\]\s*=\s*"(v\d+)"')
RE_FILES = re.compile(r'"\.\/(\w+)\.js"')


def parse_v(s):
    m = re.fullmatch(r"v(\d+)", s.strip().lower())
    if not m:
        print("ERROR: version must look like 'v82', got: %r" % s)
        sys.exit(2)
    return "v" + m.group(1)


def sub_once(pattern, repl, text, label, path):
    new, n = pattern.subn(repl, text, count=1)
    if n != 1:
        print("FAIL: %s not found in %s" % (label, path.name))
        sys.exit(1)
    return new


def bump(new_v):
    new_num = int(new_v[1:])
    changed = []

    t = ENTRY.read_text("utf-8")
    m = RE_ENTRY_STAMP.search(t)
    old = m.group(2) if m else None
    t = sub_once(RE_ENTRY_STAMP, r"\g<1>%s\g<3>" % new_v, t, "entry __SettingsHubBuild", ENTRY)
    t = sub_once(RE_CSS_QUERY, r"\g<1>%d" % new_num, t, "styles.css?v=", ENTRY)
    t = sub_once(RE_BANNER, r"\g<1>%s\g<3>" % new_v, t, "banner 'web build: vN -'", ENTRY)
    ENTRY.write_text(t, "utf-8")
    changed.append("%s: %s -> %s (stamp, css query, banner)" % (ENTRY.name, old, new_v))

    t = PYSTORE.read_text("utf-8")
    m = RE_PY_STAMP.search(t)
    old = m.group(2) if m else None
    t = sub_once(RE_PY_STAMP, r"\g<1>%s\g<3>" % new_v, t, "STACK_SERVER_VERSION", PYSTORE)
    PYSTORE.write_text(t, "utf-8")
    changed.append("%s: %s -> %s" % (PYSTORE.name, old, new_v))

    # v101: the workflows storage bumps together with the pack (the panel
    # compares it against the entry stamp exactly like the stack storage)
    if WFSTORE.exists():
        t = WFSTORE.read_text("utf-8")
        m = RE_WF_STAMP.search(t)
        old = m.group(2) if m else None
        t = sub_once(RE_WF_STAMP, r"\g<1>%s\g<3>" % new_v, t, "WORKFLOWS_SERVER_VERSION", WFSTORE)
        WFSTORE.write_text(t, "utf-8")
        changed.append("%s: %s -> %s" % (WFSTORE.name, old, new_v))

    if README.exists():
        t = README.read_text("utf-8")
        t2, n = RE_BADGE.subn(r"\g<1>%s\g<3>)" % new_v, t, count=1)
        if n == 1:
            README.write_text(t2, "utf-8")
            changed.append("README.md: badge -> %s" % new_v)
        else:
            print("WARN: README badge not found - skipped")

    for c in changed:
        print("bumped " + c)
    print("OK: version is now %s" % new_v)
    print("NOTE: the banner PROSE (the long changelog text) is NOT touched - "
          "write it by hand as part of the release commit.")


def check():
    errors, warnings = [], []
    versions = {}

    t = ENTRY.read_text("utf-8")
    stamps = RE_ENTRY_STAMP.findall(t)
    if len(stamps) != 1:
        errors.append("entry __SettingsHubBuild must appear EXACTLY once, found %d" % len(stamps))
    else:
        versions["entry"] = stamps[0][1]
    css = RE_CSS_QUERY.findall(t)
    if len(css) != 1:
        errors.append("styles.css?v= must appear EXACTLY once, found %d" % len(css))
    elif css[0][1] != str(int(versions.get("entry", "v0")[1:])):
        errors.append("styles.css?v=%s does not match entry %s" % (css[0][1], versions.get("entry")))
    banner = RE_BANNER.search(t)
    if not banner:
        errors.append("banner 'web build: vN - ' not found")
    elif versions.get("entry") and banner.group(2) != versions["entry"]:
        errors.append("banner %s != entry stamp %s" % (banner.group(2), versions["entry"]))

    t = PYSTORE.read_text("utf-8")
    py = RE_PY_STAMP.findall(t)
    if len(py) != 1:
        errors.append("STACK_SERVER_VERSION must appear EXACTLY once, found %d" % len(py))
    else:
        versions["py"] = py[0][1]

    # v101: the workflows storage must exist, appear once and match the entry
    if WFSTORE.exists():
        t = WFSTORE.read_text("utf-8")
        wf = RE_WF_STAMP.findall(t)
        if len(wf) != 1:
            errors.append("WORKFLOWS_SERVER_VERSION must appear EXACTLY once, found %d" % len(wf))
        else:
            versions["workflows_py"] = wf[0][1]

    if README.exists():
        badge = RE_BADGE.search(README.read_text("utf-8"))
        if not badge:
            warnings.append("README badge not found")
        elif versions.get("entry") and badge.group(2) != versions["entry"]:
            errors.append("README badge %s != entry %s" % (badge.group(2), versions["entry"]))

    # v82 convention: modules carry NO version literal except the self-report
    # of their last functional change; the entry EXPECTED manifest must match
    # exactly, and the old per-file guards must be gone.
    entry_text = ENTRY.read_text("utf-8")
    expected = dict(RE_EXPECTED.findall(entry_text))  # v82 EXPECTED manifest
    files = RE_FILES.findall(entry_text)
    for f in files:
        if f not in expected:
            errors.append("module %s.js is in FILES but has no EXPECTED entry" % f)
    for k in expected:
        if k not in files:
            errors.append("EXPECTED lists %s but it is not in FILES" % k)
    reports = {}
    for f in sorted((ROOT / "web").glob("*.js")):
        if f.name == "settings_hub.js":
            continue
        ft = f.read_text("utf-8")
        name = f.stem
        reps = RE_SELFREPORT.findall(ft)
        guards = RE_GUARD.findall(ft)
        if guards:
            errors.append("%s still carries per-file build guard(s) %s - "
                          "the v82 convention forbids them (docs/plan-versions.md)"
                          % (f.name, ",".join(guards)))
        if name in expected:
            if len(reps) != 1:
                errors.append("%s must self-report EXACTLY once as a version "
                              "string, found %d" % (f.name, len(reps)))
            else:
                reports[name] = reps[0][1]
                if reps[0][1] != expected[name]:
                    errors.append("%s self-reports %s but entry EXPECTS %s"
                                  % (f.name, reps[0][1], expected[name]))
    # version.py --check must also keep the fallback literal out of stack.js
    if 'globalThis.__SettingsHubBuild || "v' in (ROOT / "web" / "stack.js").read_text("utf-8"):
        errors.append("stack.js BUILD fallback carries a version literal - use \"\"")
    # release rule: py and web bump together (tools/version.py does both)
    if versions.get("entry") and versions.get("py") and versions["entry"] != versions["py"]:
        errors.append("py %s != entry %s - they must bump together" % (versions["py"], versions["entry"]))
    if versions.get("entry") and versions.get("workflows_py") and versions["entry"] != versions["workflows_py"]:
        errors.append("workflows py %s != entry %s - they must bump together"
                      % (versions["workflows_py"], versions["entry"]))

    for w in warnings:
        print("WARN: " + w)
    for e in errors:
        print("FAIL: " + e)
    if not errors:
        print("OK: entry=%s py=%s%s - single-source version is consistent; "
              "manifest %s" % (versions.get("entry"), versions.get("py"),
                               (" workflows_py=%s" % versions["workflows_py"]) if "workflows_py" in versions else "",
                               ", ".join("%s=%s" % (k, v) for k, v in sorted(expected.items()))))
        return 0
    return 1


def main():
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    if len(sys.argv) != 2 or sys.argv[1].startswith("-"):
        print(__doc__)
        sys.exit(2)
    bump(parse_v(sys.argv[1]))


if __name__ == "__main__":
    main()
