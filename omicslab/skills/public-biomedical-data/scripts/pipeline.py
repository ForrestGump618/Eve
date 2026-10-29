"""Run Collector, Evaluator and Curator into one auditable manifest."""
from __future__ import annotations

import argparse
from pathlib import Path

from collect import collect
from common import load_json, write_json
from common import canonical_hash, normalize_max_bytes
from curate import curate
from evaluate import evaluate


def run(plan_path: Path, out: Path, *, download_files: bool, max_bytes: int) -> dict:
    plan = load_json(plan_path)
    max_bytes = normalize_max_bytes(max_bytes)
    plan_sha256 = canonical_hash(plan)
    candidates = collect(plan, out, download_files=download_files, max_bytes=max_bytes)
    evaluation = evaluate(candidates)
    curated = curate(candidates, evaluation)
    write_json(out / "evaluation.json", evaluation)
    write_json(out / "curated.json", curated)
    manifest = {
        "schema_version": 1,
        "query": plan.get("query", ""),
        "source_plan_sha256": plan_sha256,
        "candidates": curated["candidates"],
        "conflicts": curated["conflicts"],
        "evaluation_summary": evaluation["summary"],
        "provenance": {
            "pipeline": "Collector -> Evaluator -> Curator",
            "network_used": download_files,
            "metadata_no_download_is_metadata_only": True,
        },
    }
    write_json(out / "manifest.json", manifest)
    write_json(
        out / "provenance.json",
        {
            "query": plan.get("query", ""),
            "plan_path": str(plan_path),
            "source_plan_sha256": plan_sha256,
            "stages": ["collect", "evaluate", "curate"],
            "stage_sha256": {
                "collect": canonical_hash(candidates),
                "evaluate": canonical_hash(evaluation),
                "curate": canonical_hash(curated),
            },
            "candidates": [
                {
                    "candidate_id": row["candidate_id"],
                    "collector": row["provenance"]["collector"],
                    "files": row["files"],
                }
                for row in curated["candidates"]
            ],
        },
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=["run"], default="run")
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=250_000_000)
    args = parser.parse_args()
    manifest = run(args.plan, args.out, download_files=args.download, max_bytes=args.max_bytes)
    print(f"manifest: {args.out / 'manifest.json'}")
    print(f"included: {manifest['evaluation_summary']['include']} / {len(manifest['candidates'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
