"""Shared validation and provenance helpers for the public-data pipeline."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_PLAN_BYTES = 2_000_000
MAX_CANDIDATES = 100
MAX_FILES_PER_CANDIDATE = 50
MAX_DOWNLOAD_BYTES = 250_000_000
MIN_DOWNLOAD_BYTES = 1_024
MAX_DOWNLOAD_REQUEST_BYTES = 2_000_000_000
USER_AGENT = "Eve-PublicDataSkill/1.0"
CONTROLLED_WORDS = ("controlled", "dbgap", "authorized access", "data use agreement", "dua")
RESTRICTED_WORDS = ("proprietary", "non-commercial", "noncommercial", "all rights reserved")
PUBLIC_LICENSES = ("cc0", "cc-by", "cc by", "mit", "apache", "bsd", "public domain", "open")


def load_json(path: str | Path) -> dict:
    source = Path(path)
    if source.stat().st_size > MAX_PLAN_BYTES:
        raise ValueError("plan exceeds the 2 MB metadata limit")
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("plan must be a JSON object")
    return value


def write_json(path: str | Path, value: object) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def candidates(plan: dict) -> list[dict]:
    rows = plan.get("candidates")
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_CANDIDATES:
        raise ValueError("plan.candidates must contain 1..100 objects")
    result = []
    seen = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"candidate {index} must be an object")
        accession = clean(row.get("accession"), 200)
        source = clean(row.get("source"), 80)
        if not accession or not source:
            raise ValueError(f"candidate {index} requires source and accession")
        key = (source.lower(), accession.lower())
        if key in seen:
            raise ValueError(f"duplicate candidate: {source}:{accession}")
        seen.add(key)
        files = row.get("files") or []
        if not isinstance(files, list) or len(files) > MAX_FILES_PER_CANDIDATE:
            raise ValueError(f"candidate {index}.files must be a list of at most 50 entries")
        result.append({**row, "source": source, "accession": accession, "files": files})
    return result


def clean(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def access_state(row: dict) -> str:
    text = " ".join(
        str(row.get(key) or "") for key in ("access", "license", "notes", "url")
    ).lower()
    if any(word in text for word in CONTROLLED_WORDS):
        return "controlled"
    return "public" if clean(row.get("access"), 40).lower() in {"", "public", "open"} else "restricted"


def license_state(value: object) -> str:
    text = clean(value, 500).lower()
    if not text or text in {"unknown", "unspecified", "not reported"}:
        return "unknown"
    if any(word in text for word in RESTRICTED_WORDS):
        return "restricted"
    return "public" if any(word in text for word in PUBLIC_LICENSES) else "declared"


def validate_url_syntax(value: object) -> str:
    url = clean(value, 4_000)
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("download URLs must be credential-free HTTPS URLs")
    if parsed.port is not None and not 1 <= parsed.port <= 65_535:
        raise ValueError("download URL has an invalid port")
    return url


def validate_public_url(value: object) -> str:
    """Resolve a URL and require every answer to be globally routable."""
    url = validate_url_syntax(value)
    parsed = urlparse(url)
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except OSError as exc:
        raise ValueError(f"cannot resolve download host: {parsed.hostname}") from exc
    if not addresses:
        raise ValueError("download host resolved to no addresses")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ValueError("download URL resolves to a non-public address")
    return url


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def normalize_max_bytes(value: object) -> int:
    if type(value) is not int or not MIN_DOWNLOAD_BYTES <= value <= MAX_DOWNLOAD_REQUEST_BYTES:
        raise ValueError(
            f"max_bytes must be an integer between {MIN_DOWNLOAD_BYTES} and {MAX_DOWNLOAD_REQUEST_BYTES}"
        )
    return value


class SafeRedirectHandler(HTTPRedirectHandler):
    """Reject redirects before urllib opens a different origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        absolute = urljoin(req.full_url, newurl)
        validate_public_url(absolute)
        return super().redirect_request(req, fp, code, msg, headers, absolute)


def download(url: str, destination: Path, max_bytes: int = MAX_DOWNLOAD_BYTES) -> dict:
    """Stream one public HTTPS file while enforcing a hard byte ceiling."""
    max_bytes = normalize_max_bytes(max_bytes)
    safe_url = validate_public_url(url)
    request = Request(safe_url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    opener = build_opener(SafeRedirectHandler())
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    digest = hashlib.sha256()
    size = 0
    started = time.time()
    try:
        with opener.open(request, timeout=30) as response:
            final_url = validate_public_url(response.geturl())
            content_type = response.headers.get("Content-Type", "")
            declared = response.headers.get("Content-Length")
            if declared:
                try:
                    declared_bytes = int(declared)
                except ValueError as exc:
                    raise ValueError("response has an invalid Content-Length") from exc
                if declared_bytes < 0 or declared_bytes > max_bytes:
                    raise ValueError("declared response exceeds download budget")
            with partial.open("wb") as handle:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError("response exceeds download budget")
                    digest.update(chunk)
                    handle.write(chunk)
        partial.replace(destination)
        return {
            "url": safe_url,
            "final_url": final_url,
            "path": destination.as_posix(),
            "bytes": size,
            "sha256": digest.hexdigest(),
            "content_type": content_type,
            "retrieved_at": time.time(),
            "elapsed_seconds": round(time.time() - started, 3),
            "state": "downloaded",
        }
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def file_entries(row: dict) -> list[dict]:
    entries = []
    for item in row.get("files") or []:
        if isinstance(item, str):
            item = {"url": item}
        if not isinstance(item, dict):
            raise ValueError("file entries must be URLs or objects")
        normalized = {
            "url": clean(item.get("url"), 4_000),
            "name": clean(item.get("name"), 240),
            "kind": clean(item.get("kind"), 80),
        }
        for key, value in item.items():
            if key not in normalized:
                normalized[str(key)[:120]] = value
        entries.append(normalized)
    return entries
