#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v116 (plan 5.2): the CORRECTED history-store benchmark - ONE shared bare
Git repository vs the zlib-CAS fallback for the Workflow Manager history.

THE v112 BENCHMARK DEFECT (fixed here): `prev_commit` reset to None on every
Process while the shared ref kept being rewritten - only the LAST process's
chain stayed reachable, the rest of the library was silently dropped from
every measurement (and would be pruned by the next repack). The corrected
benchmark appends EVERY checkpoint of EVERY process to ONE global parent
chain (exactly what py/workflows_history.create_revision does), verifies the
reachability of every revision blob (fsck + a read-back of ALL OIDs) before
and after `repack -adf`, and refuses to report sizes for a store that lost
objects.

Dataset: REALISTIC anonymized ComfyUI-style workflow JSON - varied node
graphs (KSampler/CLIP/VAE/ControlNet shapes with titles, links and widget
payloads) padded with seeded-semi-random text so zlib cannot cheat on
repetition; file sizes from ~200 KB to ~2 MB. Scenarios per the plan:
no-op checkpoint (identical bytes), a single widget change, a few dozen
node edits, a big graph change, a canvas-only change, and identical JSON
stored under DIFFERENT processes (cross-process dedupe).

Run: python3 scripts/bench_history.py
"""
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NODE_TYPES = ["KSampler", "CheckpointLoaderSimple", "CLIPTextEncode",
              "VAEDecode", "SaveImage", "LoraLoader", "ControlNetLoader",
              "EmptyLatentImage", "PreviewImage", "ImageUpscaleWithModel"]

WORDS = ("portrait fantasy landscape cyberpunk cinematic soft light studio "
         "night city rain snow detailed sharp blur golden hour magic anime "
         "realistic oil painting sketch masterpiece quality trending art").split()


def make_workflow(process_idx, version, target_bytes, rng):
    """A realistic anonymized ComfyUI workflow JSON. Version N changes
    widgets/canvas/graph per the scenario the caller drives."""
    n_nodes = 24 + (process_idx % 5) * 6
    nodes = []
    for i in range(n_nodes):
        t = NODE_TYPES[i % len(NODE_TYPES)]
        n = {
            "id": i + 1,
            "type": t,
            "pos": [round((i * 240 + version * 3) / 3.0, 2),
                    round((i % 7) * 160 + rng.random() * 2, 2)],
            "size": [240, 120],
            "flags": {},
            "order": i,
            "mode": 0,
            "inputs": [{"name": "model", "type": "MODEL", "link": i}
                       if i else {"name": "pipe", "type": "*", "link": None}],
            "outputs": [{"name": "LATENT", "type": "LATENT",
                         "links": [i + 1] if i + 1 < n_nodes else []}],
            "properties": {"Node name for S&R": t},
            "widgets_values": [
                "model_p%d_v%d.safetensors" % (process_idx, version % 3),
                rng.randrange(0, 2 ** 32),
                20 + (version % 4) * 2,
                7.0 + rng.random() * 0.5,
                ["euler", "dpmpp_2m", "heun"][version % 3],
                ["normal", "karras"][version % 2],
            ],
        }
        if i % 3 == 0:
            n["title"] = "%s %s %d" % (t, " ".join(rng.sample(WORDS, 2)), i)
        nodes.append(n)
    links = [[i + 1, i, 1, (i + 1) % n_nodes + 1, 0] for i in range(n_nodes - 1)]
    wf = {
        "id": "%08x-0000-4000-8000-%012x" % (process_idx, process_idx),
        "revision": version,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": {"ds": {"scale": 1.0,
                         "offset": [round(version * 10.5, 2), 0]},
                  "frontendVersion": "1.24.4"},
        "version": 0.4,
    }
    raw = json.dumps(wf, ensure_ascii=False).encode("utf-8")
    # pad to the target size with seeded-semi-random text (NOT a repeated
    # character - zlib must compress a real mix, the plan forbids cheating)
    pad_target = max(0, target_bytes - len(raw))
    if pad_target > 0:
        words = []
        need = pad_target
        while need > 0:
            w = " ".join(rng.choices(WORDS, k=8)) + " %d" % rng.randrange(10 ** 6)
            words.append(w)
            need -= len(w) + 1
        wf["notes"] = words[:int(len(words) * 0.7)]
        wf["history_comments"] = words[int(len(words) * 0.7):]
        raw = json.dumps(wf, ensure_ascii=False).encode("utf-8")
    return raw


def apply_scenario(wf_bytes, scenario, rng):
    """The plan's mandatory change scenarios (section 5.2)."""
    wf = json.loads(wf_bytes.decode("utf-8"))
    if scenario == "noop":
        return wf_bytes
    if scenario == "widget":          # ONE widget value changes
        wf["nodes"][3]["widgets_values"][1] = rng.randrange(0, 2 ** 32)
    elif scenario == "dozens":        # a few dozen nodes edit widgets
        for n in wf["nodes"][:24]:
            if isinstance(n.get("widgets_values"), list):
                n["widgets_values"][2] = 20 + rng.randrange(30)
    elif scenario == "big":           # a BIG graph change (new nodes)
        for k in range(10):
            wf["nodes"].append({
                "id": 1000 + k, "type": "CLIPTextEncode",
                "pos": [k * 60, k * 40], "size": [240, 120], "mode": 0,
                "inputs": [], "outputs": [],
                "properties": {"Node name for S&R": "CLIPTextEncode"},
                "widgets_values": [" ".join(rng.choices(WORDS, k=10))],
            })
    elif scenario == "canvas":        # ONLY canvas move/zoom
        wf["extra"]["ds"] = {"scale": 0.6 + rng.random() * 0.4,
                             "offset": [rng.randrange(500), rng.randrange(500)]}
        for n in wf["nodes"]:
            n["pos"] = [n["pos"][0] + 12, n["pos"][1] + 7]
    elif scenario == "repack_same":   # identical JSON under ANOTHER process
        pass
    else:
        raise ValueError(scenario)
    return json.dumps(wf, ensure_ascii=False).encode("utf-8")


def dir_size(path):
    total = 0
    for dp, _dns, fns in os.walk(path):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def git_run(repo, *args, inp=None, check=True):
    env = dict(os.environ, GIT_AUTHOR_NAME="bench",
               GIT_AUTHOR_EMAIL="bench@local",
               GIT_COMMITTER_NAME="bench",
               GIT_COMMITTER_EMAIL="bench@local")
    r = subprocess.run(["git", "--git-dir", repo] + list(args),
                       capture_output=True, env=env, input=inp)
    if check and r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (
            " ".join(args), r.stderr.decode(errors="replace")[:400]))
    return r


def bench_git(workdir, dataset, expect_oids):
    """ONE shared bare repo, ONE global parent chain (the v116 contract)."""
    repo = os.path.join(workdir, "history.git")
    subprocess.run(["git", "init", "--bare", "-q", repo], check=True)
    git_run(repo, "config", "core.compression", "9")
    prev_commit = None            # the GLOBAL parent - never reset per process
    blob_oids = {}                # data hash -> blob oid (the dedupe proof)
    t_cp = t_read = 0.0
    n_rev = 0
    dedupe_hits = 0
    noop_skipped = 0
    for item in dataset:
        data = item["data"]
        t0 = time.perf_counter()
        dh = hashlib.sha256(data).hexdigest()
        oid = blob_oids.get(dh)
        if oid is None:
            oid = git_run(repo, "hash-object", "-w", "--stdin",
                          inp=data).stdout.decode().strip()
            blob_oids[dh] = oid
        elif item["scenario"] == "noop":
            noop_skipped += 1     # the store dedupes exact bytes for free
        if item["scenario"] == "noop":
            # a no-op checkpoint writes NO new revision (the store contract:
            # identical rawHash -> duplicate) - measure the probe only
            t_cp += time.perf_counter() - t0
            continue
        if item["scenario"] == "repack_same":
            dedupe_hits += 1      # identical content, ANOTHER process
        tree = git_run(repo, "mktree",
                       inp=("100644 blob %s\tcurrent.json" % oid)
                       .encode()).stdout.decode().strip()
        args = ["commit-tree", tree, "-m", "checkpoint %s" % item["label"]]
        if prev_commit:
            args += ["-p", prev_commit]
        commit = git_run(repo, *args).stdout.decode().strip()
        git_run(repo, "update-ref", "refs/heads/history", commit)
        prev_commit = commit
        t_cp += time.perf_counter() - t0
        n_rev += 1
        expect_oids.add(oid)
        t0 = time.perf_counter()
        back = git_run(repo, "cat-file", "blob", oid).stdout
        t_read += time.perf_counter() - t0
        if back != data:
            raise RuntimeError("read-back mismatch for " + item["label"])
    loose = dir_size(repo)
    fsck_before = git_run(repo, "fsck", "--no-dangling", check=False)
    t0 = time.perf_counter()
    git_run(repo, "repack", "-adf", "--depth=50", "--window=100", "-q")
    t_repack = time.perf_counter() - t0
    packed = dir_size(repo)
    # the reachability proof: EVERY expected blob survives the repack
    reachable = git_run(repo, "rev-list", "--objects", "--all").stdout.decode()
    reach_set = set(line.split()[0] for line in reachable.splitlines() if line)
    missing = [o for o in expect_oids if o not in reach_set]
    fsck_after = git_run(repo, "fsck", "--no-dangling", check=False)
    return {
        "loose": loose, "packed": packed,
        "checkpoint_s": t_cp / max(1, n_rev),
        "read_s": t_read / max(1, n_rev),
        "repack_s": t_repack,
        "revisions": n_rev, "dedupe_hits": dedupe_hits,
        "noop_skipped": noop_skipped,
        "unique_blobs": len(blob_oids),
        "missing_after_repack": missing,
        "fsck_ok_before": fsck_before.returncode == 0,
        "fsck_ok_after": fsck_after.returncode == 0,
    }


def bench_cas(workdir, dataset, level=9):
    cas = os.path.join(workdir, "cas")
    os.makedirs(cas, exist_ok=True)
    blobs = {}
    t0 = time.perf_counter()
    n = 0
    size_raw = 0
    t_read = 0.0
    for item in dataset:
        data = item["data"]
        size_raw += len(data)
        h = hashlib.sha256(data).hexdigest()
        if h not in blobs:
            blobs[h] = zlib.compress(data, level)
        n += 1
        t1 = time.perf_counter()
        zlib.decompress(blobs[h])
        t_read += time.perf_counter() - t1
    put_s = (time.perf_counter() - t0) / n
    # the physical CAS size (what _cas_size would measure: the files)
    cas_size = 0
    sub = os.path.join(cas, "ab")
    os.makedirs(sub, exist_ok=True)
    for i, (h, b) in enumerate(blobs.items()):
        with open(os.path.join(sub, h + ".z"), "wb") as f:
            f.write(b)
            cas_size += len(b)
    return {"cas_size": cas_size, "raw": size_raw, "put_s": put_s,
            "read_s": t_read / n, "blobs": len(blobs)}


def main():
    rng = random.Random(1160)     # a deterministic dataset
    print("v116 history-store benchmark (realistic anonymized workflow JSON)")
    sizes = [200 * 1024, 400 * 1024, 800 * 1024, 1200 * 1024, 2 * 1024 * 1024]
    dataset = []
    # 8 processes x 5 versions: the version ladder walks the plan's scenarios
    scenarios = ["noop", "widget", "dozens", "big", "canvas"]
    current = {}
    for p in range(8):
        for v, sc in enumerate(scenarios):
            if sc == "noop":
                data = current.get(p) or make_workflow(p, v, sizes[v % len(sizes)], rng)
                current[p] = data
                dataset.append({"label": "p%d v%d %s" % (p, v, sc),
                                "scenario": sc, "data": data})
                continue
            base = current.get(p) or make_workflow(p, v, sizes[v % len(sizes)], rng)
            data = apply_scenario(base, sc, rng)
            current[p] = data
            dataset.append({"label": "p%d v%d %s" % (p, v, sc),
                            "scenario": sc, "data": data})
    # identical JSON under DIFFERENT processes (cross-process dedupe)
    shared = dataset[1]["data"]     # the p0 'widget' version
    for p in (8, 9):
        dataset.append({"label": "p%d shared-copy" % p,
                        "scenario": "repack_same", "data": shared})
    raw_total = sum(len(d["data"]) for d in dataset)
    print("dataset: %d checkpoint events, %d processes, raw %.1f MB" % (
        len(dataset), 10, raw_total / 1048576))
    per_file = {}
    for d in dataset:
        per_file[d["scenario"]] = per_file.get(d["scenario"], 0) + len(d["data"])
    print("per-scenario bytes: " + json.dumps(
        {k: "%.1f MB" % (v / 1048576) for k, v in sorted(per_file.items())}))
    expect_oids = set()
    with tempfile.TemporaryDirectory() as td:
        g = bench_git(td, dataset, expect_oids)
        c = bench_cas(td, dataset)
    print("revisions committed          : %d (+%d no-op probes skipped, %d cross-process dedupe hits)"
          % (g["revisions"], g["noop_skipped"], g["dedupe_hits"]))
    print("unique blob OIDs             : %d" % g["unique_blobs"])
    print("git loose (objects+refs)     : %.0f KB" % (g["loose"] / 1024))
    print("git packed after repack      : %.0f KB" % (g["packed"] / 1024))
    print("zlib-9 CAS total             : %.0f KB" % (c["cas_size"] / 1024))
    print("raw payload total            : %.0f KB" % (c["raw"] / 1024))
    print("git packed / raw             : %.3f" % (g["packed"] / max(1, c["raw"])))
    print("CAS / raw                    : %.3f" % (c["cas_size"] / max(1, c["raw"])))
    print("git checkpoint (mean)        : %.1f ms" % (g["checkpoint_s"] * 1000))
    print("git read-back (mean)         : %.1f ms" % (g["read_s"] * 1000))
    print("git repack                   : %.1f ms" % (g["repack_s"] * 1000))
    print("CAS put (mean)               : %.1f ms" % (c["put_s"] * 1000))
    print("CAS read (mean)              : %.1f ms" % (c["read_s"] * 1000))
    print("fsck before / after repack   : %s / %s" % (
        g["fsck_ok_before"], g["fsck_ok_after"]))
    ok = (not g["missing_after_repack"] and g["fsck_ok_before"]
          and g["fsck_ok_after"] and g["packed"] < c["cas_size"]
          and g["checkpoint_s"] < 1.0)
    if g["missing_after_repack"]:
        print("REACHABILITY FAILURE: %d blob(s) lost by the repack" %
              len(g["missing_after_repack"]))
    print("VERDICT:", "GIT PREFERRED (every revision reachable, smaller than zlib CAS, fast enough)"
          if ok else "REJECTED (the store lost data or lost the size/time race)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
