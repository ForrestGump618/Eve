"""Collect public biomedical-data metadata and optional downloads."""
from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

from common import (
    access_state,
    candidates,
    canonical_hash,
    download,
    file_entries,
    load_json,
    normalize_max_bytes,
    validate_url_syntax,
    write_json,
)


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")[:160] or "dataset"


def collect(plan: dict, out: Path, *, download_files: bool = False, max_bytes: int = 250_000_000) -> dict:
    max_bytes = normalize_max_bytes(max_bytes)
    records = []
    out.mkdir(parents=True, exist_ok=True)
    for index, row in enumerate(candidates(plan)):
        files = file_entries(row)
        collected_files = []
        errors = []
        network_attempted = False
        for file_index, entry in enumerate(files):
            item = {**entry, "state": "metadata_only"}
            if entry["url"]:
                try:
                    validate_url_syntax(entry["url"])
                    item["url_validation"] = "https_syntax"
                    if access_state(row) != "public":
                        item["state"] = "blocked_non_public"
                    elif download_files:
                        network_attempted = True
                        name = safe_name(entry["name"] or Path(entry["url"].split("?")[0]).name)
                        destination = out / "files" / safe_name(row["source"]) / safe_name(row["accession"]) / f"{file_index:02d}-{name}"
                        item = {**item, **download(entry["url"], destination, max_bytes)}
                        item["url_validation"] = "public_dns"
                except Exception as exc:
                    item.update(state="failed", error=str(exc)[:1_000])
                    errors.append(item["error"])
            collected_files.append(item)
        record = {
            **row,
            "candidate_id": f"{row['source'].lower()}:{row['accession']}",
            "access": access_state(row),
            "files": collected_files,
            "download_state": "downloaded" if any(f["state"] == "downloaded" for f in collected_files)
            else "metadata_only",
            "collector": {
                "retrieved_at": time.time(),
                "metadata_sha256": canonical_hash(row),
                "errors": errors,
                "network_used": network_attempted,
                "network_mode": "download" if network_attempted else "metadata_only",
            },
        }
        records.append(record)
    result = {
        "schema_version": 1,
        "query": str(plan.get("query") or "")[:4_000],
        "created_at": time.time(),
        "download_requested": download_files,
        "max_bytes_per_file": max_bytes,
        "candidates": records,
    }
    write_json(out / "candidates.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=250_000_000)
    args = parser.parse_args()
    result = collect(load_json(args.plan), args.out, download_files=args.download, max_bytes=args.max_bytes)
    print(f"collected {len(result['candidates'])} candidates into {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
