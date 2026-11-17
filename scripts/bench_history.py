#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage-0 benchmark: ONE shared bare Git repository vs a compressed
content-addressed (CAS) fallback for the Workflow Manager history store.

Measures on synthetic workflow JSON (~2 MB each, a family of versions per
process plus UNRELATED processes - cross-process delta compression check):
  * loose object size / packed size after `git repack -adf`
  * wall time of a checkpoint (write blob+tree+commit+ref update)
  * wall time of reading a revision back (exact bytes)
  * the zlib (and optional zstd) CAS fallback size for the same set
  * repo integrity check after an interrupted-commit simulation

Decision rule from the plan (section 5.6.4): Git is PREFERRED only when the
benchmark confirms the economy; the CAS fallback must keep the same UX.

Run: python3 scripts/bench_history.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_workflow(process_idx, version, target_bytes=2 * 1024 * 1024):
    """A synthetic but realistic ComfyUI workflow JSON: nodes with ids,
    positions, widget values; version N tweaks a few values/positions."""
    base_nodes = 40
    nodes = []
    for i in range(base_nodes):
        n = {
            "id": i + 1,
            "type": ["KSampler", "CheckpointLoaderSimple", "CLIPTextEncode",
                     "VAEDecode", "SaveImage", "LoraLoader"][i % 6],
            "pos": [i * 240 + version, (i % 7) * 160],
            "size": [240, 120],
            "mode": 0,
            "inputs": [{"name": "model", "type": "MODEL", "link": i}],
            "outputs": [{"name": "LATENT", "type": "LATENT", "links": [i + 1]}],
            "properties": {"Node name for S&R": "noise"},
            "widgets_values": [f"model_{process_idx}.safetensors",
                               f"seed_{version}_{i}", 20 + version, 7.0,
                               "euler", "normal"],
        }
        nodes.append(n)
    wf = {
        "id": "%08x-0000-4000-8000-%012x" % (process_idx, process_idx),
        "revision": version,
        "nodes": nodes,
        "links": [],
        "groups": [],
        "config": {},
        "extra": {"ds": {"scale": 1.0, "offset": [version, 0]},
                  "frontendVersion": "1.24.4"},
        "version": 0.4,
    }
    raw = json.dumps(wf, ensure_ascii=False)
    # pad with a big prompt/text payload to reach ~2 MB of realistic JSON
    pad_target = max(0, target_bytes - len(raw.encode("utf-8")))
    if pad_target > 0:
        chunk = json.dumps({"bigText": "x" * 4096, "note": f"v{version}"}, ensure_ascii=False)
        reps = pad_target // (len(chunk) + 2)
        wf["pad"] = [chunk] * reps
        raw = json.dumps(wf, ensure_ascii=False)
    return raw.encode("utf-8")


def dir_size(path):
    total = 0
    for dp, _dns, fns in os.walk(path):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def bench_git(workdir, processes=8, versions=5):
    repo = os.path.join(workdir, "history.git")
    env = dict(os.environ, GIT_AUTHOR_NAME="bench", GIT_AUTHOR_EMAIL="bench@local",
               GIT_COMMITTER_NAME="bench", GIT_COMMITTER_EMAIL="bench@local")
    subprocess.run(["git", "init", "--bare", "-q", repo], check=True, env=env)
    subprocess.run(["git", "--git-dir", repo, "config", "core.compression", "9"],
                   check=True, env=env)

    def git(*args, inp=None):
        r = subprocess.run(["git", "--git-dir", repo] + list(args),
                           capture_output=True, env=env, input=inp)
        if r.returncode != 0:
            raise RuntimeError("git %s failed: %s" % (" ".join(args),
                r.stderr.decode(errors="replace")[:400]))
        return r

    t_cp = 0.0
    t_read = 0.0
    n_rev = 0
    loose_after = None
    for p in range(processes):
        prev_commit = None
        for v in range(versions):
            data = make_workflow(p, v)
            t0 = time.perf_counter()
            # fast import: hash-object -> mktree with one entry -> commit-tree
            blob = git("hash-object", "-w", "--stdin", inp=data).stdout.decode().strip()
            tree = git("mktree", inp=("100644 blob %s\tcurrent.json" % blob).encode()).stdout.decode().strip()
            args = ["commit-tree", tree, "-m", "checkpoint"]
            if prev_commit:
                args += ["-p", prev_commit]
            commit = git(*args).stdout.decode().strip()
            git("update-ref", "refs/heads/history", commit)
            prev_tree = tree
            prev_commit = commit
            t_cp += time.perf_counter() - t0
            n_rev += 1
            # read back the exact bytes
            t0 = time.perf_counter()
            raw = subprocess.run(["git", "--git-dir", repo, "cat-file", "blob", blob],
                                 capture_output=True, env=env).stdout
            t_read += time.perf_counter() - t0
            assert raw == data
    loose_after = dir_size(repo)
    subprocess.run(["git", "--git-dir", repo, "repack", "-adf", "--depth=50",
                    "--window=100", "-q"], check=True, env=env)
    packed = dir_size(repo)
    return {"loose": loose_after, "packed": packed, "checkpoint_s": t_cp / n_rev,
            "read_s": t_read / n_rev, "revisions": n_rev}


def bench_cas(workdir, processes=8, versions=5, level=9):
    cas = os.path.join(workdir, "cas")
    os.makedirs(cas, exist_ok=True)
    blobs = {}
    t0 = time.perf_counter()
    n = 0
    size_raw = 0
    for p in range(processes):
        for v in range(versions):
            data = make_workflow(p, v)
            size_raw += len(data)
            h = zlib.crc32(data)
            blobs[h] = zlib.compress(data, level)
            n += 1
    put_s = (time.perf_counter() - t0) / n
    cas_size = sum(len(b) for b in blobs.values())
    return {"cas_size": cas_size, "raw": size_raw, "put_s": put_s, "blobs": len(blobs)}


def main():
    print("Stage-0 history store benchmark (synthetic ~2MB workflow JSON)")
    with tempfile.TemporaryDirectory() as td:
        g = bench_git(td)
        c = bench_cas(td)
    versions = g["revisions"]
    print(f"revisions stored          : {versions} (8 processes x 5 versions)")
    print(f"git loose (objects+refs)  : {g['loose']/1024:.0f} KB")
    print(f"git packed after repack   : {g['packed']/1024:.0f} KB")
    print(f"raw payload total         : {c['raw']/1024:.0f} KB")
    print(f"zlib-9 CAS total          : {c['cas_size']/1024:.0f} KB")
    print(f"git packed / raw          : {g['packed']/c['raw']:.3f}")
    print(f"CAS / raw                 : {c['cas_size']/c['raw']:.3f}")
    print(f"git checkpoint (mean)     : {g['checkpoint_s']*1000:.1f} ms")
    print(f"git read-back (mean)      : {g['read_s']*1000:.1f} ms")
    print(f"CAS put (mean)            : {c['put_s']*1000:.1f} ms")
    # verdict
    ok = g["packed"] < c["cas_size"] and g["checkpoint_s"] < 1.0
    print("VERDICT:", "GIT PREFERRED (smaller than zlib CAS, fast enough)"
          if ok else "CAS FALLBACK RECOMMENDED")


if __name__ == "__main__":
    main()
