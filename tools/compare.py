#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SettingsHub install compare tool (no dependencies, pure Python 3.6+).

WHAT IT IS FOR
--------------
Answers the only question that matters after updating the pack:
"WHAT is actually different between the zip I downloaded and the folder
that is installed in ComfyUI/custom_nodes?" - per file, with the web/py
version stamps of BOTH sides, so a half-updated install (the thing that
produced the annoying 'storage works / version mismatch' notes) is visible
in seconds instead of guesswork.

USAGE (Windows example)
-----------------------
  1. Unpack the NEW zip anywhere (or stay inside the unpacked folder).
  2. Run:

     python tools\\compare.py --installed "C:\\ComfyUI\\custom_nodes\\ComfyUI-Settings-Hub"

     (the pack side defaults to the folder that contains tools\\, i.e. the
      unpacked zip itself)

  Compare against a zip WITHOUT unpacking:

     python tools\\compare.py --zip ComfyUI-Settings-Hub-v82.zip --installed "C:\\...\\ComfyUI-Settings-Hub"

  Pointing --installed at custom_nodes itself is also fine - the tool
  descends into the ComfyUI-Settings-Hub subfolder automatically.

OUTPUT VERDICTS (per file)
--------------------------
  SAME       byte-identical on both sides (not printed)
  DIFFERS    exists on both sides but content/size differs (version stamps
             of both sides are shown for web/*.js and py/*.py when known)
  NEW        exists only in the PACK (your install is missing this file)
  EXTRA      exists only in the INSTALL (leftover from an older release)

ADVICE BLOCK (end of report)
----------------------------
  * py/ changed  -> RESTART ComfyUI (python loads only at server start)
  * web/ changed -> hard refresh the browser page (Ctrl+F5)
  * NEW py file  -> the install is partial, re-unpack the zip over the folder
  * installed NEWER than the pack -> you are about to DOWNGRADE

Exit code: 0 = identical, 1 = differences found, 2 = usage/path error.
"""

import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

PACK_FOLDER_NAME = "ComfyUI-Settings-Hub"
SKIP_DIRS = {"__pycache__", ".git", ".gitignore"}
SKIP_SUFFIX = (".pyc",)

# --- version stamp extractors (best effort, purely informative) -------------

RE_ENTRY_STAMP = re.compile(r'__SettingsHubBuild\s*=\s*"(v\d+)"')
RE_PY_STAMP = re.compile(r'STACK_SERVER_VERSION\s*=\s*"(v\d+)"')
RE_GUARD_STAMP = re.compile(r'__SettingsHubBuild\s*!==\s*"(v\d+)"')
RE_SELFREPORT = re.compile(r'globalThis\.__SettingsHubLoaded\["\w+"\]\s*=\s*"(v\d+)"')


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def zip_sha256(zf, name):
    h = hashlib.sha256()
    with zf.open(name) as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def stamp_for(rel, text):
    """Best-effort version stamp of a pack file, e.g. 'v82' or None."""
    if rel == "web/settings_hub.js":
        m = RE_ENTRY_STAMP.search(text)
        return m.group(1) if m else None
    if rel == "py/stack_store.py":
        m = RE_PY_STAMP.search(text)
        return m.group(1) if m else None
    if rel.startswith("web/") and rel.endswith(".js"):
        # v82+: the module stamp is its self-report (last functional change);
        # pre-v82 packs exposed the per-file guard literal instead.
        m = RE_SELFREPORT.search(text) or RE_GUARD_STAMP.search(text)
        return m.group(1) if m else None
    return None


def read_text_from_zip(zf, name):
    try:
        return zf.read(name).decode("utf-8", "replace")
    except KeyError:
        return ""


def walk_dir(root):
    root = Path(root)
    out = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        parts = set(rel.split("/"))
        if parts & SKIP_DIRS or rel.endswith(SKIP_SUFFIX):
            continue
        out[rel] = p
    return out


def walk_zip(zpath):
    zf = zipfile.ZipFile(zpath)
    out = {}
    for info in zf.infolist():
        if info.is_dir():
            continue
        rel = PurePosixPath(info.filename)
        parts = [x for x in rel.parts if x not in ("/", "")]
        # strip the leading ComfyUI-Settings-Hub/ wrapper if present
        if parts and parts[0] == PACK_FOLDER_NAME:
            parts = parts[1:]
        if not parts:
            continue
        rel = "/".join(parts)
        if set(rel.split("/")) & SKIP_DIRS or rel.endswith(SKIP_SUFFIX):
            continue
        out[rel] = (zf, info.filename)
    return out, zf


def resolve_installed(raw):
    """Accept the pack folder, or custom_nodes containing it - descend once."""
    p = Path(raw)
    if not p.exists():
        return None
    if p.is_dir():
        if (p / "web").is_dir() or (p / "py").is_dir():
            return p
        sub = p / PACK_FOLDER_NAME
        if sub.is_dir():
            return sub
    return p


def collect_pack(args):
    """Returns (files{rel: origin}, hashes{rel: sha}, texts{rel: str})."""
    side = args.zip or args.pack
    if not side:
        default = Path(__file__).resolve().parent.parent
        if (default / "web").is_dir():
            side = str(default)
        else:
            return None
    pdir = Path(side)
    if pdir.is_file() and pdir.suffix == ".zip":
        try:
            files, zf = walk_zip(pdir)
        except (zipfile.BadZipFile, OSError):
            return None
        hashes = {rel: zip_sha256(zf, orig) for rel, (zf, orig) in files.items()}
        texts = {rel: read_text_from_zip(zf, orig) for rel, (zf, orig) in files.items()}
        return str(pdir), files, hashes, texts
    if pdir.is_dir():
        files = walk_dir(pdir)
        hashes = {rel: file_sha256(p) for rel, p in files.items()}
        texts = {rel: p.read_text("utf-8", "replace") for rel, p in files.items()}
        return str(pdir), files, hashes, texts
    return None


def main():
    ap = argparse.ArgumentParser(
        description="Compare a SettingsHub pack (dir or zip) against the installed copy.")
    ap.add_argument("--zip", help="path to the NEW pack zip")
    ap.add_argument("--pack", help="path to the NEW unpacked pack folder "
                                   "(default: the folder containing tools/)")
    ap.add_argument("--installed", required=True,
                    help="path to custom_nodes/ComfyUI-Settings-Hub (or custom_nodes)")
    args = ap.parse_args()

    collected = collect_pack(args)
    if not collected:
        ap.error("pack side not found - run from inside the unpacked pack "
                 "or pass --zip/--pack with a valid path")
    pack_side, _files, pack_hash, pack_text = collected

    installed = resolve_installed(args.installed)
    if installed is None or not installed.is_dir():
        print("ERROR: --installed folder not found: %s" % args.installed)
        return 2

    inst_files = walk_dir(installed)
    inst_hash = {rel: file_sha256(p) for rel, p in inst_files.items()}
    inst_text = {rel: p.read_text("utf-8", "replace") for rel, p in inst_files.items()}

    # ---- headline versions
    pack_web = stamp_for("web/settings_hub.js", pack_text.get("web/settings_hub.js", "")) or "?"
    inst_web = stamp_for("web/settings_hub.js", inst_text.get("web/settings_hub.js", "")) or "?"
    pack_py = stamp_for("py/stack_store.py", pack_text.get("py/stack_store.py", "")) or "?"
    inst_py = stamp_for("py/stack_store.py", inst_text.get("py/stack_store.py", "")) or "?"

    print("=" * 72)
    print("SettingsHub INSTALL COMPARE")
    print("  pack (new)      : %s   web=%s  py=%s" % (pack_side, pack_web, pack_py))
    print("  installed (now) : %s   web=%s  py=%s" % (installed, inst_web, inst_py))
    print("=" * 72)

    all_rels = sorted(set(pack_hash) | set(inst_hash))
    n = {"DIFFERS": 0, "NEW": 0, "EXTRA": 0}
    py_changed, web_changed, missing_py = False, False, False

    for rel in all_rels:
        in_pack, in_inst = rel in pack_hash, rel in inst_hash
        if in_pack and in_inst:
            if pack_hash[rel] == inst_hash[rel]:
                continue  # SAME - stay quiet, only problems are printed
            n["DIFFERS"] += 1
            ps = stamp_for(rel, pack_text.get(rel, "")) or "?"
            is_ = stamp_for(rel, inst_text.get(rel, "")) or "?"
            extra = "   [pack %s / installed %s]" % (ps, is_) if (ps, is_) != ("?", "?") else ""
            if rel.startswith("py/"):
                py_changed = True
            if rel.startswith("web/"):
                web_changed = True
            print("DIFFERS  %s%s" % (rel, extra))
        elif in_pack:
            n["NEW"] += 1
            print("NEW      %s   (missing in your install)" % rel)
            if rel.startswith("py/"):
                missing_py = True
        else:
            n["EXTRA"] += 1
            print("EXTRA    %s   (not part of the pack - old leftover?)" % rel)

    print("-" * 72)
    print("Summary: %d differ, %d new (pack-only), %d extra (install-only), "
          "%d identical" % (n["DIFFERS"], n["NEW"], n["EXTRA"],
                            len(all_rels) - n["DIFFERS"] - n["NEW"] - n["EXTRA"]))

    advice = []
    if not (n["DIFFERS"] or n["NEW"] or n["EXTRA"]):
        advice.append("Install matches the pack byte-for-byte. Nothing to do.")
    else:
        if inst_web != "?" and pack_web != "?" and inst_web > pack_web:
            advice.append("WARNING: the INSTALLED copy is NEWER than this pack "
                          "(installed web %s > pack web %s) - you would DOWNGRADE."
                          % (inst_web, pack_web))
        if missing_py:
            advice.append("py/ file(s) MISSING in the install - the pack was only "
                          "partially copied. Re-unpack the zip over the folder "
                          "(replace all files).")
        if py_changed or missing_py:
            advice.append("py/ changed -> RESTART ComfyUI completely (python code "
                          "loads only at server start; a page refresh is NOT enough).")
        if web_changed:
            advice.append("web/ changed -> after the files are copied, hard refresh "
                          "the browser tab (Ctrl+F5) so cached old js is dropped.")
        if n["EXTRA"]:
            advice.append("EXTRA files are not in the pack - usually harmless "
                          "leftovers of an older release; removing them is optional.")
    for a in advice:
        print("* " + a)

    return 0 if not (n["DIFFERS"] or n["NEW"] or n["EXTRA"]) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # output was piped into `head`/`more` and closed early - not an error
        sys.exit(0)
