"""Score public biomedical-data candidates with an explainable heuristic."""
from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import urlparse

from common import clean, license_state, load_json, write_json

REQUIRED_METADATA = ("species", "tissue", "disease", "platform")


def evaluate_candidate(row: dict) -> dict:
    score = 0
    signals = []
    missing = []
    files = row.get("files") or []
    license_value = license_state(row.get("license"))
    access = clean(row.get("access"), 40) or "unknown"
    data_level = clean(row.get("data_level"), 100).lower()
    sample_count = row.get("sample_count")

    if access == "public":
        score += 20
        signals.append((20, "public access"))
    else:
        signals.append((0, f"access is {access}"))
    if license_value == "public":
        score += 20
        signals.append((20, "recognized public license"))
    elif license_value == "declared":
        score += 10
        signals.append((10, "license declared but requires review"))
    else:
        missing.append("recognized license")

    url = clean(row.get("url"), 4_000)
    if url and urlparse(url).scheme == "https":
        score += 10
        signals.append((10, "stable HTTPS source"))
    else:
        missing.append("HTTPS source URL")

    if row.get("accession"):
        score += 10
        signals.append((10, "accession present"))
    else:
        missing.append("accession")

    if isinstance(sample_count, int) and sample_count >= 3:
        points = 15 if sample_count >= 20 else 10
        score += points
        signals.append((points, f"sample count {sample_count}"))
    else:
        missing.append("sample count >= 3")

    if any(word in data_level for word in ("raw", "count", "bam", "fastq", "matrix")):
        score += 15
        signals.append((15, f"analysis-ready data level: {data_level}"))
    else:
        missing.append("explicit raw/processed data level")

    present = [field for field in REQUIRED_METADATA if clean(row.get(field), 2_000)]
    points = min(10, len(present) * 2)
    score += points
    if points:
        signals.append((points, "metadata fields: " + ", ".join(present)))
    missing.extend(field for field in REQUIRED_METADATA if field not in present)

    downloaded = [item for item in files if item.get("state") == "downloaded"]
    if downloaded and all(item.get("sha256") for item in downloaded):
        score += 10
        signals.append((10, "downloaded files have SHA256"))
    elif files:
        score += 3
        signals.append((3, "file manifest present without verified download"))

    decision = "exclude"
    if access == "public" and license_value in {"public", "declared"} and score >= 65:
        decision = "include"
    elif score >= 45:
        decision = "review"
    return {
        "candidate_id": row.get("candidate_id"),
        "score": min(100, score),
        "decision": decision,
        "signals": [{"points": points, "reason": reason} for points, reason in signals],
        "missing": sorted(set(missing)),
        "access": access,
        "license": license_value,
        "download_state": row.get("download_state", "metadata_only"),
        "limitations": [
            "Score is a screening heuristic, not scientific validation.",
            "Metadata completeness does not prove sample independence or fitness for the research question.",
        ],
    }


def evaluate(payload: dict) -> dict:
    rows = payload.get("candidates")
    if not isinstance(rows, list):
        raise ValueError("candidates payload is invalid")
    evaluated = [evaluate_candidate(row) for row in rows]
    return {
        "schema_version": 1,
        "query": payload.get("query", ""),
        "evaluated_at": payload.get("created_at"),
        "candidates": evaluated,
        "summary": {
            "total": len(evaluated),
            "include": sum(item["decision"] == "include" for item in evaluated),
            "review": sum(item["decision"] == "review" for item in evaluated),
            "exclude": sum(item["decision"] == "exclude" for item in evaluated),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = evaluate(load_json(args.candidates))
    write_json(args.out, result)
    print(f"evaluated {len(result['candidates'])} candidates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
