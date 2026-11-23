"""Train on annotated tuning queries and run paired held-out file searches."""

import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import platform
import random
import statistics
import subprocess
import tarfile
from time import perf_counter_ns

from file_search import FIXED, LIMIT, SearchSnapshot, classify, run_search
from skill_decisions import search_decisions

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/research/file-search"
REVISIONS = {
    "metaaco": "85a501d25fa74e35a5846d78ca9bfc89ef87b52b",
    "harness": "22ddee3792402c3e70ec5f86a63c3e3e895a2f60",
}
SEEDS = (42, 43, 44)
EVALUATIONS = 60
REPEATS = 3
MAX_BYTES = 128 * 1024
LOCAL_MODES = ("B", "C", "D")
A_REASON = "Stock model-driven Harness was not run; the offline series has no authorized model budget."


def elapsed(start):
    return (perf_counter_ns() - start) / 1e6


def digest(data):
    return hashlib.sha256(data).hexdigest()


def documents(repo, revision):
    archive = subprocess.check_output(["git", "-C", str(repo), "archive", revision],
                                      timeout=120)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        for entry in tree:
            if entry.isfile() and entry.size <= MAX_BYTES:
                raw = tree.extractfile(entry).read()
                if b"\0" not in raw:
                    try:
                        yield entry.name, raw.decode("utf-8")
                    except UnicodeDecodeError:
                        continue


def rank(result, targets):
    return next((i for i, file in enumerate(result["files"], 1)
                 if file["path"] in targets), None)


def order(action):
    return (action, *(item for item in FIXED if item != action))


def train(rows, snapshots, seed):
    started = perf_counter_ns()
    policy, traces = {}, {}
    groups = {state: [f"{state}:{action}" for action in allowed]
              for state, allowed in (("start", FIXED), ("strong", (*FIXED, "stop")),
                                     ("weak", FIXED))}
    for context in ("file", "identifier", "description"):
        cases = [row for row in rows if classify(row["query"]) == context]
        if not cases:
            continue
        scores = {}

        def evaluate(choices):
            route = tuple(order(choices[state].split(":")[1]) for state in groups)
            if route not in scores:
                misses5 = misses1 = steps = 0
                for row in cases:
                    result = run_search(snapshots[row["repo"]], row["query"], policy={context: route})
                    position = rank(result, row["target"].split("|"))
                    misses5 += position is None
                    misses1 += position != 1
                    steps += len(result["steps"])
                # Lexicographic objective: preserve Hit@5, then Hit@1, then minimize tool steps.
                scores[route] = 1 + ((len(cases) + 1) * misses5 + misses1) * (LIMIT * len(cases) + 1) + steps
            return scores[route]

        fitted = search_decisions(groups, evaluate, seed=seed, max_evaluations=EVALUATIONS)
        policy[context] = tuple(order(fitted["choices"][state].split(":")[1]) for state in groups)
        traces[context] = {**fitted, "unique_policies": len(scores), "queries": len(cases)}
    return policy, {"seed": seed, "ms": elapsed(started), "contexts": traces}


def summary(rows):
    completed = [row for row in rows if row["status"] == "completed"]
    if not completed:
        return {"n": len(rows), "completed": 0, "hit1": None, "hit5": None,
                "median_ms": None, "p95_ms": None, "steps_mean": None,
                "model_calls": None, "model_input_bytes": None,
                "input_tokens": None, "output_tokens": None}
    times = sorted(row["ms"] for row in completed)
    return {"n": len(rows), "completed": len(completed),
            "hit1": sum(row["rank"] == 1 for row in completed) / len(rows),
            "hit5": sum(row["rank"] is not None for row in completed) / len(rows),
            "median_ms": statistics.median(times), "p95_ms": times[math.ceil(.95 * len(times)) - 1],
            "steps_mean": statistics.mean(len(row["steps"]) for row in completed),
            **{key: sum(row[key] for row in completed) for key in
               ("model_calls", "model_input_bytes", "input_tokens", "output_tokens")}}


def load_queries():
    with (DATA / "queries.tsv").open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def benchmark(repos, output):
    queries = load_queries()
    tune = [row for row in queries if row["split"] == "tune"]
    test = [row for row in queries if row["split"] == "test"]
    snapshots, index = {}, {}
    for name, revision in REVISIONS.items():
        started = perf_counter_ns()
        corpus = dict(documents(repos[name], revision))
        read_ms = elapsed(started)
        started = perf_counter_ns()
        snapshots[name] = SearchSnapshot(corpus)
        build_ms = elapsed(started)
        for row in queries:
            if row["repo"] == name and not set(row["target"].split("|")).issubset(corpus):
                raise ValueError(f"Invalid target for {row['id']} at {revision}")
        touch = next(iter(corpus))
        started = perf_counter_ns()
        snapshots[name].update({touch: corpus[touch] + "\nfile_search_update_probe\n"})
        update_ms = elapsed(started)
        snapshots[name].update({touch: corpus[touch]})
        index[name] = {"revision": revision, "files": len(corpus), "read_ms": read_ms,
                       "build_ms": build_ms, "update_ms": update_ms, "update_path": touch}

    fits = [train(tune, snapshots, seed) for seed in SEEDS]
    rows = []
    randomizer = random.Random(SEEDS[0])
    for repeat in range(REPEATS):
        for query in randomizer.sample(test, len(test)):
            snapshot = snapshots[query["repo"]]
            for mode in randomizer.sample(LOCAL_MODES, len(LOCAL_MODES)):
                snapshot.search.cache_clear()
                result = run_search(snapshot, query["query"], indexed=mode != "D",
                                    policy=fits[repeat][0] if mode == "C" else None)
                rows.append({**query, "mode": mode, "repeat": repeat, "status": "completed",
                             **result, "rank": rank(result, query["target"].split("|"))})
            rows.append({**query, "mode": "A", "repeat": repeat, "status": "unavailable",
                         "rank": None, "ms": None, "steps": None, "model_calls": None,
                         "model_input_bytes": None, "input_tokens": None, "output_tokens": None,
                         "reason": A_REASON})
    # The only difference between B and D is how each tool enumerates matching files.
    by_key = {(row["id"], row["repeat"], row["mode"]): row for row in rows}
    for query in test:
        for repeat in range(REPEATS):
            if by_key[query["id"], repeat, "B"]["files"] != by_key[query["id"], repeat, "D"]["files"]:
                raise AssertionError(f"Index changed fixed-route ranking for {query['id']}")
    modes = ("A", *LOCAL_MODES)
    kinds = sorted({row["kind"] for row in test})
    manifest_files = [DATA / "queries.tsv", Path(__file__), ROOT / "python/file_search.py",
                      ROOT / "python/skill_decisions.py", ROOT / "python/vendor/rcpsp/core.py",
                      ROOT / "python/vendor/rcpsp/metaACO.py", ROOT / "test/search/test_file_search.py"]
    report = {"schema_version": 1, "python": platform.python_version(),
              "system": f"{platform.system()} {platform.machine()}",
              "hashes": {str(path.relative_to(ROOT)): digest(path.read_bytes()) for path in manifest_files},
              "seeds": SEEDS, "repeats": REPEATS, "max_tool_steps": LIMIT,
              "max_solver_evaluations_per_context_and_seed": EVALUATIONS,
              "training_queries": len(tune), "test_queries": len(test), "index": index,
              "training": [trace for _, trace in fits], "a_missing_reason": A_REASON,
              "overall": {mode: summary([row for row in rows if row["mode"] == mode]) for mode in modes},
              "by_kind": {kind: {mode: summary([row for row in rows if row["mode"] == mode
                                               and row["kind"] == kind]) for mode in modes}
                          for kind in kinds}}
    output.mkdir(parents=True, exist_ok=True)
    (output / "policy.json").write_text(json.dumps(fits[0][0], indent=2) + "\n", encoding="utf-8")
    (output / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    with (output / "results.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    compare = commands.add_parser("compare")
    compare.add_argument("--metaaco", type=Path, default=ROOT)
    compare.add_argument("--harness", type=Path, required=True)
    compare.add_argument("--output", type=Path, required=True)
    search = commands.add_parser("search")
    search.add_argument("--repo", type=Path, default=ROOT)
    search.add_argument("--revision", default="HEAD")
    search.add_argument("--policy", type=Path)
    search.add_argument("query")
    args = parser.parse_args()
    if args.command == "compare":
        benchmark({"metaaco": args.metaaco, "harness": args.harness}, args.output)
    else:
        snapshot = SearchSnapshot(dict(documents(args.repo, args.revision)))
        policy = json.loads(args.policy.read_text(encoding="utf-8")) if args.policy else None
        print(json.dumps(run_search(snapshot, args.query, policy=policy), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
