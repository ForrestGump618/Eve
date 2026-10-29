"""Normalize candidate fields without discarding raw provenance."""
from __future__ import annotations

import argparse
import copy
from pathlib import Path

from common import clean, load_json, write_json

FIELDS = (
    "source",
    "accession",
    "title",
    "species",
    "tissue",
    "disease",
    "platform",
    "data_level",
    "license",
    "access",
    "url",
    "version",
)


def curate(candidates_payload: dict, evaluation_payload: dict) -> dict:
    evaluations = {row.get("candidate_id"): row for row in evaluation_payload.get("candidates", [])}
    curated = []
    conflicts = []
    for raw in candidates_payload.get("candidates", []):
        candidate_id = raw.get("candidate_id")
        evaluation = evaluations.get(candidate_id)
        if not evaluation:
            raise ValueError(f"missing evaluation for {candidate_id}")
        normalized = {field: clean(raw.get(field), 4_000) for field in FIELDS}
        normalized["candidate_id"] = candidate_id
        normalized["sample_count"] = raw.get("sample_count") if isinstance(raw.get("sample_count"), int) else None
        normalized["metadata"] = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        normalized["files"] = raw.get("files") if isinstance(raw.get("files"), list) else []
        normalized["download_state"] = raw.get("download_state", "metadata_only")
        normalized["raw_record"] = copy.deepcopy({
            key: value for key, value in raw.items()
            if key not in {"evaluation", "provenance", "raw_record"}
        })
        normalized["provenance"] = {
            "collector": raw.get("collector") or {},
            "source_metadata_sha256": (raw.get("collector") or {}).get("metadata_sha256"),
            "download_state": normalized["download_state"],
        }
        normalized["evaluation"] = evaluation
        for field in FIELDS:
            metadata_value = normalized["metadata"].get(field)
            if metadata_value and normalized[field] and str(metadata_value) != normalized[field]:
                conflicts.append(
                    {
                        "candidate_id": candidate_id,
                        "field": field,
                        "selected": normalized[field],
                        "metadata": str(metadata_value),
                        "resolution": "kept collector value; raw metadata retained",
                    }
                )
        curated.append(normalized)
    return {
        "schema_version": 1,
        "query": candidates_payload.get("query", ""),
        "candidates": curated,
        "conflicts": conflicts,
        "rules": {
            "source_metadata_is_immutable": True,
            "unknown_values_remain_null_or_empty": True,
            "controlled_data_must_not_be_downloaded": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--evaluation", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = curate(load_json(args.candidates), load_json(args.evaluation))
    write_json(args.out, result)
    print(f"curated {len(result['candidates'])} candidates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
