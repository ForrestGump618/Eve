#!/usr/bin/env python3
"""SuWen vNext research worker (v2).

A long-lived, line-delimited JSON-RPC worker used by the TypeScript WorkerClient
in ``desktop/src/research-worker.ts``.

Protocol (one JSON object per line, UTF-8, no other stdout output)::

    -> {"id": 1, "op": "health", "input": {}}
    <- {"id": 1, "ok": true, "result": {...}}
    <- {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}

Required operations: ``health``, ``describe``, ``flowSummary``,
``datasetProfile``, ``discoveryScan``, ``runScript``.

The worker intentionally depends on the Python standard library only.  It is
*not* an operating-system security sandbox: ``runScript`` isolates a child
process by working directory, environment allowlist and lack of a shell, but a
malicious script still runs with the user's permissions.
"""

from __future__ import annotations

import array
import base64
import binascii
import csv
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

PROTOCOL = "suwen-research-worker/2"
WORKER_VERSION = "2.0.0"

MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_STDOUT_BYTES = 256 * 1024
MAX_STDERR_BYTES = 256 * 1024
DEFAULT_TIMEOUT_MS = 120_000
MIN_TIMEOUT_MS = 100
MAX_TIMEOUT_MS = 600_000

MAX_FCS_BYTES = 512 * 1024 * 1024
MAX_FCS_EVENTS = 1_000_000
MAX_FCS_EVENT_OVERRIDE = 5_000_000
MAX_FCS_CHANNELS = 256

MAX_DATASET_BYTES = 256 * 1024 * 1024
MAX_DATASET_ROWS = 200_000

MAX_SCAN_FILES = 50_000
MAX_SCAN_BYTES = 4 * 1024 * 1024 * 1024

MAX_INPUT_FILES = 64
MAX_INPUT_FILE_BYTES = 5 * 1024 * 1024
MAX_INPUT_TOTAL_BYTES = 20 * 1024 * 1024
MAX_SCRIPT_BYTES = 1_000_000
MAX_ARTIFACTS = 256
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

OPS = ("health", "describe", "flowSummary", "datasetProfile", "discoveryScan", "runScript")
DEFAULT_DATA_EXTENSIONS = (".csv", ".tsv", ".txt", ".json", ".jsonl", ".fcs", ".dat")
DEFAULT_MISSING_TOKENS = ("", "NA", "N/A", "null", "NULL", "None", "NaN", "nan")
COMPARATORS = (">", ">=", "<", "<=", "==", "!=")
RESERVED_SCRIPT_NAMES = ("main.py", "main.mjs", "main.cjs")
WINDOWS_RESERVED_NAMES = frozenset(
    ["CON", "PRN", "AUX", "NUL"]
    + ["COM%d" % i for i in range(1, 10)]
    + ["LPT%d" % i for i in range(1, 10)]
)
ENV_ALLOWLIST = (
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "COMSPEC",
    "PATHEXT",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
)

ISOLATION_NOTE = (
    "subprocess with a fresh working directory, allowlisted environment and no shell; "
    "not an OS security sandbox"
)


class WorkerError(Exception):
    """A structured error that becomes ``{"ok": false, "error": ...}`` on the wire."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = str(message)[:800]


# ---------------------------------------------------------------------------
# Small generic helpers
# ---------------------------------------------------------------------------


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _input_int(
    data: Dict[str, Any], key: str, default: Optional[int], minimum: int, maximum: int
) -> Optional[int]:
    value = data.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkerError("INVALID_INPUT", "'%s' must be an integer" % key)
    if value < minimum or value > maximum:
        raise WorkerError(
            "INVALID_INPUT", "'%s' must be between %d and %d" % (key, minimum, maximum)
        )
    return value


def _input_str(
    data: Dict[str, Any], key: str, default: Optional[str] = None, max_len: int = 4000
) -> Optional[str]:
    value = data.get(key)
    if value is None:
        return default
    if not isinstance(value, str):
        raise WorkerError("INVALID_INPUT", "'%s' must be a string" % key)
    if len(value) > max_len:
        raise WorkerError("INVALID_INPUT", "'%s' exceeds %d characters" % (key, max_len))
    return value


def _input_bool(data: Dict[str, Any], key: str, default: bool) -> bool:
    value = data.get(key)
    if value is None:
        return default
    if not isinstance(value, bool):
        raise WorkerError("INVALID_INPUT", "'%s' must be a boolean" % key)
    return value


def _input_abs_path(
    data: Dict[str, Any], key: str, *, must_exist: bool, want_dir: bool = False
) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise WorkerError("INVALID_INPUT", "'%s' must be a non-empty absolute path string" % key)
    if "\x00" in value:
        raise WorkerError("INVALID_INPUT", "'%s' contains a NUL byte" % key)
    if not os.path.isabs(value):
        raise WorkerError("INVALID_INPUT", "'%s' must be an absolute path: %r" % (key, value))
    path = os.path.normpath(value)
    if must_exist:
        if want_dir:
            if not os.path.isdir(path):
                raise WorkerError("NOT_FOUND", "'%s' is not an existing directory: %s" % (key, path))
        elif not os.path.isfile(path):
            raise WorkerError("NOT_FOUND", "'%s' is not an existing file: %s" % (key, path))
    elif want_dir and os.path.exists(path) and not os.path.isdir(path):
        raise WorkerError("INVALID_INPUT", "'%s' exists and is not a directory: %s" % (key, path))
    return path


def _file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _text_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _json_safe(value: Any) -> Any:
    """Convert values to strict-JSON-safe data (non-finite floats become null)."""

    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, array.array):
        return [_json_safe(item) for item in value]
    return str(value)


def _package_version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except Exception:  # PackageNotFoundError and malformed distributions alike
        return None


def _limits() -> Dict[str, Any]:
    return {
        "maxRequestBytes": MAX_LINE_BYTES,
        "maxResponseBytes": MAX_RESPONSE_BYTES,
        "maxStdoutBytes": MAX_STDOUT_BYTES,
        "maxStderrBytes": MAX_STDERR_BYTES,
        "defaultTimeoutMs": DEFAULT_TIMEOUT_MS,
        "maxTimeoutMs": MAX_TIMEOUT_MS,
        "maxFcsBytes": MAX_FCS_BYTES,
        "maxFcsEvents": MAX_FCS_EVENTS,
        "maxFcsEventsOverride": MAX_FCS_EVENT_OVERRIDE,
        "maxDatasetBytes": MAX_DATASET_BYTES,
        "maxDatasetRows": MAX_DATASET_ROWS,
        "maxScanFiles": MAX_SCAN_FILES,
        "maxArtifacts": MAX_ARTIFACTS,
    }


def _features() -> Dict[str, bool]:
    return {
        "fcs": True,
        "fcsSpillover": True,
        "datasetProfile": True,
        "discoveryScan": True,
        "runScript": True,
        "runScriptLanguage": True,
        "externalDependencies": any(
            _package_version(name) for name in ("numpy", "pandas", "flowio")
        ),
    }


# ---------------------------------------------------------------------------
# health / describe
# ---------------------------------------------------------------------------


def op_health(_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "ok",
        "python": platform.python_version(),
        "version": WORKER_VERSION,
        "protocol": PROTOCOL,
        "platform": platform.platform(),
        "system": platform.system(),
        "machine": platform.machine(),
        "executable": sys.executable,
        "capabilities": list(OPS),
        "features": _features(),
        "deps": {
            name: _package_version(name)
            for name in ("numpy", "pandas", "flowio", "flowkit", "scipy")
        },
        "isolation": ISOLATION_NOTE,
        "limits": _limits(),
    }


def _op_docs() -> Dict[str, Any]:
    return {
        "health": {
            "description": "Report worker status, Python version and optional dependency versions.",
            "input": {},
            "output": "WorkerHealth-shaped object.",
        },
        "describe": {
            "description": "Describe protocol, versions, supported ops and limits.",
            "input": {},
            "output": "Protocol description object.",
        },
        "flowSummary": {
            "description": "Parse an FCS 2.0/3.0/3.1 file and summarize channels, per-channel statistics and threshold populations.",
            "input": {
                "path": "absolute path to an FCS file",
                "populations": "optional list of {name?, channel, op?, value} or {name?, rules: [{channel, op, value}]}",
                "maxEvents": "optional event cap override (default 1000000, max 5000000)",
            },
            "output": "File identity, channel list, statistics and populations.",
        },
        "datasetProfile": {
            "description": "Profile a CSV/TSV/delimited/JSON/JSONL dataset: row and column counts, dtypes, missingness and basic statistics.",
            "input": {
                "path": "absolute path to a dataset file",
                "format": "auto|csv|tsv|delimited|json|jsonl",
                "delimiter": "optional single delimiter character",
                "hasHeader": "boolean for delimited data (default true)",
                "maxRows": "optional profiling row cap (default 200000)",
                "missingTokens": "optional list of strings treated as missing",
            },
            "output": "Dataset shape, column profiles and missingness.",
        },
        "discoveryScan": {
            "description": "Walk a directory tree, hash data files and report a deterministic manifest with inferred row counts.",
            "input": {
                "root": "absolute directory to scan",
                "maxDepth": "optional depth cap (default 4, max 32)",
                "maxFiles": "optional file cap (default 5000, max 50000)",
                "extensions": "optional list of lower-case extensions such as ['.csv']",
                "hash": "boolean, hash each file (default true)",
                "includeHidden": "boolean, include dot-files/directories (default false)",
            },
            "output": "Manifest with file counts, hashes, duplicate groups and row counts.",
        },
        "runScript": {
            "description": "Run a user script in an isolated working directory with a bounded environment and output.",
            "input": {
                "language": "python|node",
                "source": "script source text",
                "args": "optional list of string arguments",
                "files": "optional list of {name, text} or {name, dataBase64} input files",
                "sandboxRoot": "absolute directory in which to create the run sandbox",
                "nodePath": "optional node/electron executable path",
                "timeoutMs": "optional timeout in ms (default 120000)",
                "seed": "optional integer seed",
            },
            "output": "Exit status, bounded stdout/stderr, artifact hashes and versions.",
        },
    }


def op_describe(_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "version": WORKER_VERSION,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "ops": _op_docs(),
        "limits": _limits(),
        "features": _features(),
        "isolation": ISOLATION_NOTE,
    }


# ---------------------------------------------------------------------------
# FCS parsing
# ---------------------------------------------------------------------------

_FCS_VERSION_RE = re.compile(r"FCS(\d+\.\d+)")
_FCS_HEADER_FIELD_RE = re.compile(r"\d{1,12}")
_FCS_TEXT_KEY_RE = re.compile(r"\$[A-Z0-9]+")


def _parse_fcs_header(raw: bytes) -> Tuple[str, List[Optional[int]]]:
    if len(raw) < 58:
        raise WorkerError("NOT_FCS", "File is too short to contain an FCS header")
    version_text = raw[0:6].decode("ascii", "replace").strip()
    match = _FCS_VERSION_RE.fullmatch(version_text)
    if not match:
        raise WorkerError(
            "NOT_FCS",
            "Missing FCS version header in the first 6 bytes (saw %r)" % version_text,
        )
    fields: List[Optional[int]] = []
    for index in range(6):
        chunk = raw[10 + index * 8 : 18 + index * 8].decode("ascii", "replace").strip()
        if not chunk:
            fields.append(None)
            continue
        if not _FCS_HEADER_FIELD_RE.fullmatch(chunk):
            raise WorkerError(
                "INVALID_FCS",
                "Invalid numeric value in FCS header field %d: %r" % (index, chunk),
            )
        fields.append(int(chunk))
    return match.group(1), fields


def _parse_fcs_text_bytes(segment: bytes) -> Dict[str, str]:
    if not segment:
        raise WorkerError("INVALID_FCS", "Empty FCS TEXT segment")
    delimiter = segment[0:1]
    if delimiter in (b"\x00", b"\n", b"\r"):
        raise WorkerError("INVALID_FCS", "Invalid FCS TEXT delimiter byte")
    text = segment.decode("latin-1")
    delim = text[0]
    body = text[1:]
    if not body.endswith(delim):
        body += delim
    parts = body.split(delim)
    keywords: Dict[str, str] = {}
    for index in range(0, len(parts) - 1, 2):
        key = parts[index].strip()
        if key and _FCS_TEXT_KEY_RE.fullmatch(key):
            keywords[key.upper()] = parts[index + 1].strip()
    return keywords


def _parse_fcs_text_segment(
    raw: bytes, start: Optional[int], end: Optional[int], label: str
) -> Dict[str, str]:
    if start is None or end is None:
        raise WorkerError("INVALID_FCS", "Missing %s offsets" % label)
    if start < 58 or end < start or end >= len(raw):
        raise WorkerError(
            "INVALID_FCS",
            "Invalid %s offsets %r..%r for a %d byte file" % (label, start, end, len(raw)),
        )
    return _parse_fcs_text_bytes(raw[start : end + 1])


def _keyword_int(
    keywords: Dict[str, str],
    key: str,
    minimum: int,
    maximum: int,
    label: Optional[str] = None,
) -> Optional[int]:
    raw = keywords.get(key)
    if raw is None or raw.strip() == "":
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        raise WorkerError("INVALID_FCS", "%s is not an integer: %r" % (key, raw)) from None
    if value < minimum or value > maximum:
        raise WorkerError(
            "INVALID_FCS", "%s value %d is outside %d..%d" % (key, value, minimum, maximum)
        )
    del label
    return value


def _parse_pne(raw: Optional[str]) -> Tuple[float, float]:
    if not raw:
        return (1.0, 0.0)
    parts = re.split(r"[,\s]+", raw.strip())
    try:
        first = float(parts[0]) if parts and parts[0] else 1.0
        second = float(parts[1]) if len(parts) > 1 and parts[1] else 0.0
    except ValueError:
        return (1.0, 0.0)
    return (first, second)


def _parse_byte_order(keywords: Dict[str, str]) -> str:
    raw = keywords.get("$BYTEORD", "").strip()
    if not raw:
        return "little"
    try:
        numbers = [int(part) for part in re.split(r"[,\s]+", raw) if part]
    except ValueError:
        raise WorkerError("UNSUPPORTED_ENCODING", "Unsupported $BYTEORD value %r" % raw) from None
    if not numbers:
        return "little"
    count = len(numbers)
    if all(numbers[index] == index + 1 for index in range(count)):
        return "little"
    if all(numbers[index] == count - index for index in range(count)):
        return "big"
    raise WorkerError("UNSUPPORTED_ENCODING", "Unsupported $BYTEORD value %r" % raw)


def _parse_spillover(keywords: Dict[str, str]) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    raw = keywords.get("$SPILLOVER")
    if not raw:
        return None, []
    parts = [part.strip() for part in raw.split(",")]
    try:
        count = int(parts[0])
    except ValueError:
        return None, ["$SPILLOVER is malformed: missing channel count"]
    if count <= 0 or count > MAX_FCS_CHANNELS:
        return None, ["$SPILLOVER has an invalid channel count %r" % parts[0]]
    expected = 1 + count + count * count
    if len(parts) < expected:
        return None, [
            "$SPILLOVER declares %d channels but only carries %d values"
            % (count, len(parts) - 1)
        ]
    names = parts[1 : 1 + count]
    try:
        values = [float(part) for part in parts[1 + count : expected]]
    except ValueError:
        return None, ["$SPILLOVER contains non-numeric values"]
    matrix = [values[index * count : (index + 1) * count] for index in range(count)]
    return {"channels": names, "matrix": matrix}, []


def _parse_fcs(raw: bytes) -> Dict[str, Any]:
    warnings: List[str] = []
    version, header_fields = _parse_fcs_header(raw)

    if header_fields[0] is None or header_fields[1] is None:
        raise WorkerError("INVALID_FCS", "Header is missing TEXT segment offsets")
    keywords = _parse_fcs_text_segment(raw, header_fields[0], header_fields[1], "TEXT")

    supplemental_start = _keyword_int(keywords, "$BEGINSTEXT", 0, len(raw))
    supplemental_end = _keyword_int(keywords, "$ENDSTEXT", 0, len(raw))
    if supplemental_start and supplemental_end and supplemental_end > supplemental_start:
        try:
            supplemental = _parse_fcs_text_segment(
                raw, supplemental_start, supplemental_end, "supplemental TEXT"
            )
        except WorkerError:
            warnings.append("Supplemental TEXT segment could not be parsed")
        else:
            for key, value in supplemental.items():
                keywords.setdefault(key, value)

    mode = (keywords.get("$MODE") or "L").strip().upper()
    if mode != "L":
        raise WorkerError(
            "UNSUPPORTED_ENCODING",
            "Only list-mode FCS data are supported (saw $MODE %r)" % mode,
        )

    par = _keyword_int(keywords, "$PAR", 1, MAX_FCS_CHANNELS)
    if par is None:
        raise WorkerError("INVALID_FCS", "Missing required $PAR keyword")
    total = _keyword_int(keywords, "$TOT", 0, MAX_FCS_EVENT_OVERRIDE)
    if total is None:
        raise WorkerError("INVALID_FCS", "Missing required $TOT keyword")

    datatype = (keywords.get("$DATATYPE") or "").strip().upper()
    if datatype not in ("F", "I"):
        raise WorkerError(
            "UNSUPPORTED_ENCODING",
            "Unsupported $DATATYPE %r (only F and I are supported)" % datatype,
        )
    byteord_raw = (keywords.get("$BYTEORD") or "").strip()
    byteord = _parse_byte_order(keywords)

    channels: List[Dict[str, Any]] = []
    for index in range(1, par + 1):
        name = keywords.get("$P%dN" % index) or "P%d" % index
        marker = keywords.get("$P%dS" % index) or name
        bits_raw = keywords.get("$P%dB" % index)
        if bits_raw is None or not bits_raw.strip():
            bits = 32 if datatype == "F" else 16
        else:
            try:
                bits = int(bits_raw.strip())
            except ValueError:
                raise WorkerError(
                    "INVALID_FCS", "$P%dB is not an integer: %r" % (index, bits_raw)
                ) from None
        range_raw = keywords.get("$P%dR" % index)
        try:
            channel_range = int(range_raw.strip()) if range_raw and range_raw.strip() else 0
        except ValueError:
            channel_range = 0
        gain_raw = keywords.get("$P%dG" % index)
        try:
            gain = float(gain_raw.strip()) if gain_raw and gain_raw.strip() else 1.0
        except ValueError:
            gain = 1.0
        channels.append(
            {
                "index": index,
                "name": name,
                "marker": marker,
                "bits": bits,
                "range": channel_range,
                "gain": gain,
                "pne": keywords.get("$P%dE" % index),
            }
        )

    if datatype == "F":
        bit_set = sorted({channel["bits"] for channel in channels})
        if bit_set not in ([32], [64]):
            raise WorkerError(
                "UNSUPPORTED_ENCODING",
                "Float FCS data must be uniformly 32- or 64-bit (saw %r)" % bit_set,
            )
        bits = bit_set[0]
    else:
        bit_set = sorted({channel["bits"] for channel in channels})
        if len(bit_set) != 1 or bit_set[0] not in (8, 16, 32):
            raise WorkerError(
                "UNSUPPORTED_ENCODING",
                "Integer FCS data must be uniformly 8-, 16- or 32-bit (saw %r)" % bit_set,
            )
        bits = bit_set[0]

    data_start = _keyword_int(keywords, "$BEGINDATA", 0, len(raw))
    if data_start is None or data_start == 0:
        data_start = header_fields[2]
    data_end = _keyword_int(keywords, "$ENDDATA", 0, len(raw))
    if data_end is None or data_end == 0:
        data_end = header_fields[3]
    if data_start is None or data_start <= 0:
        raise WorkerError("INVALID_FCS", "Missing $BEGINDATA data offset")
    if data_start >= len(raw):
        raise WorkerError("INVALID_FCS", "Data offset is beyond the end of the file")
    if data_end is None or data_end <= 0 or data_end >= len(raw):
        if data_end is not None and data_end >= len(raw):
            warnings.append("$ENDDATA was clamped to the end of the file")
        data_end = len(raw) - 1
    if data_end < data_start:
        raise WorkerError("INVALID_FCS", "Data offsets are inverted")

    needed = total * par * (bits // 8)
    available = data_end - data_start + 1
    if available < needed:
        raise WorkerError(
            "INVALID_FCS",
            "DATA segment is %d bytes but %d events x %d channels x %d bits require %d"
            % (available, total, par, bits, needed),
        )

    return {
        "version": version,
        "keywords": keywords,
        "header_fields": header_fields,
        "par": par,
        "total": total,
        "datatype": datatype,
        "bits": bits,
        "byteord": byteord_raw,
        "endian": byteord,
        "channels": channels,
        "data_start": data_start,
        "data_end": data_end,
        "warnings": warnings,
    }


def _decode_fcs_columns(raw: bytes, parsed: Dict[str, Any]) -> List[array.array]:
    channels = parsed["channels"]
    par = parsed["par"]
    total = parsed["total"]
    bits = parsed["bits"]
    endian = parsed["endian"]
    datatype = parsed["datatype"]
    data = raw[parsed["data_start"] : parsed["data_end"] + 1]
    needed = total * par * (bits // 8)
    data = data[:needed]
    swap = (endian == "little") != (sys.byteorder == "little")

    if datatype == "F":
        floats = array.array("f" if bits == 32 else "d")
        floats.frombytes(data)
        if swap:
            floats.byteswap()
        return [floats[index::par] for index in range(par)]

    typecode = {8: "B", 16: "H", 32: "I"}[bits]
    integers = array.array(typecode)
    integers.frombytes(data)
    if swap:
        integers.byteswap()
    columns: List[array.array] = []
    for index, channel in enumerate(channels):
        raw_column = integers[index::par]
        first, second = _parse_pne(channel["pne"])
        gain = channel["gain"] if channel["gain"] else 1.0
        if second == 0.0:
            scale = gain * (first if first else 1.0)
            columns.append(array.array("d", (float(value) * scale for value in raw_column)))
        else:
            decades = first if first else 1.0
            columns.append(
                array.array(
                    "d",
                    (10.0 ** (second * float(value) * gain / decades) for value in raw_column),
                )
            )
    return columns


def _channel_stats(channel: Dict[str, Any], column: array.array) -> Dict[str, Any]:
    count = len(column)
    finite: List[float] = []
    non_finite = 0
    total = 0.0
    minimum = math.inf
    maximum = -math.inf
    for value in column:
        if math.isfinite(value):
            finite.append(value)
            total += value
            if value < minimum:
                minimum = value
            if value > maximum:
                maximum = value
        else:
            non_finite += 1
    if not finite:
        return {
            "channel": channel["name"],
            "marker": channel["marker"],
            "count": count,
            "finiteCount": 0,
            "nonFinite": non_finite,
            "mean": None,
            "median": None,
            "min": None,
            "max": None,
            "stddev": None,
        }
    return {
        "channel": channel["name"],
        "marker": channel["marker"],
        "count": count,
        "finiteCount": len(finite),
        "nonFinite": non_finite,
        "mean": total / len(finite),
        "median": statistics.median(finite),
        "min": minimum,
        "max": maximum,
        "stddev": statistics.stdev(finite) if len(finite) > 1 else None,
    }


def _otsu_threshold(values: Sequence[float], bins: int = 256) -> Optional[float]:
    """Otsu's threshold over ``bins`` equal-width histogram bins."""

    count = len(values)
    if count == 0:
        return None
    low = min(values)
    high = max(values)
    span = high - low
    if span <= 0:
        return float(low)
    histogram = [0] * bins
    for value in values:
        index = int((value - low) / span * (bins - 1))
        if index < 0:
            index = 0
        elif index >= bins:
            index = bins - 1
        histogram[index] += 1
    total = count
    sum_all = sum(index * histogram[index] for index in range(bins))
    sum_background = 0.0
    weight_background = 0
    best_variance = -1.0
    best_index = 0
    for index in range(bins - 1):
        weight_background += histogram[index]
        if weight_background == 0:
            continue
        weight_foreground = total - weight_background
        if weight_foreground == 0:
            break
        sum_background += index * histogram[index]
        mean_background = sum_background / weight_background
        mean_foreground = (sum_all - sum_background) / weight_foreground
        variance = (
            weight_background
            * weight_foreground
            * (mean_background - mean_foreground) ** 2
        )
        if variance > best_variance:
            best_variance = variance
            best_index = index
    return low + (best_index + 0.5) * (span / (bins - 1))


def _compare(value: float, op: str, threshold: float) -> bool:
    if op == ">":
        return value > threshold
    if op == ">=":
        return value >= threshold
    if op == "<":
        return value < threshold
    if op == "<=":
        return value <= threshold
    if op == "==":
        return value == threshold
    if op == "!=":
        return value != threshold
    raise WorkerError("INVALID_INPUT", "Unsupported comparison operator %r" % op)


def _parse_rule(rule: Any, channel_lookup: Dict[str, Dict[str, Any]], label: str) -> Dict[str, Any]:
    if not isinstance(rule, dict):
        raise WorkerError("INVALID_INPUT", "%s must be an object" % label)
    channel = rule.get("channel")
    if not isinstance(channel, str) or channel not in channel_lookup:
        raise WorkerError(
            "INVALID_INPUT",
            "%s references an unknown channel %r; available: %s"
            % (label, channel, ", ".join(channel_lookup)),
        )
    op = rule.get("op", rule.get("operator", ">="))
    if op not in COMPARATORS:
        raise WorkerError(
            "INVALID_INPUT", "%s has an unsupported op %r" % (label, op)
        )
    value = rule.get("value", rule.get("threshold"))
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WorkerError("INVALID_INPUT", "%s must provide a numeric value" % label)
    if not math.isfinite(float(value)):
        raise WorkerError("INVALID_INPUT", "%s must provide a finite value" % label)
    return {"channel": channel, "op": op, "value": float(value)}


def _parse_population_specs(
    data: Dict[str, Any], channel_lookup: Dict[str, Dict[str, Any]]
) -> Optional[List[Dict[str, Any]]]:
    raw = data.get("populations")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise WorkerError("INVALID_INPUT", "'populations' must be an array")
    if len(raw) > 64:
        raise WorkerError("LIMIT_EXCEEDED", "'populations' supports at most 64 entries")
    specs: List[Dict[str, Any]] = []
    for index, item in enumerate(raw):
        label = "populations[%d]" % index
        if not isinstance(item, dict):
            raise WorkerError("INVALID_INPUT", "%s must be an object" % label)
        name = item.get("name")
        if name is not None and not isinstance(name, str):
            raise WorkerError("INVALID_INPUT", "%s.name must be a string" % label)
        rules_raw = item.get("rules")
        if rules_raw is not None:
            if not isinstance(rules_raw, list) or not rules_raw:
                raise WorkerError("INVALID_INPUT", "%s.rules must be a non-empty array" % label)
            if len(rules_raw) > 32:
                raise WorkerError("LIMIT_EXCEEDED", "%s.rules supports at most 32 rules" % label)
            rules = [
                _parse_rule(rule, channel_lookup, "%s.rules[%d]" % (label, rule_index))
                for rule_index, rule in enumerate(rules_raw)
            ]
        else:
            rules = [_parse_rule(item, channel_lookup, label)]
        specs.append({"name": name or "population_%d" % (index + 1), "rules": rules})
    return specs


def _evaluate_populations(
    specs: List[Dict[str, Any]],
    channel_index: Dict[str, int],
    columns: List[array.array],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for spec in specs:
        rules = spec["rules"]
        rule_columns = [columns[channel_index[rule["channel"]]] for rule in rules]
        count = 0
        for values in zip(*rule_columns):
            matched = True
            for rule, value in zip(rules, values):
                if not _compare(value, rule["op"], rule["value"]):
                    matched = False
                    break
            if matched:
                count += 1
        total = len(rule_columns[0])
        out.append(
            {
                "name": spec["name"],
                "rules": rules,
                "count": count,
                "fraction": (count / total) if total else None,
                "method": "threshold",
            }
        )
    return out


def op_flow_summary(data: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_ms()
    path = _input_abs_path(data, "path", must_exist=True)
    size = os.path.getsize(path)
    if size <= 0:
        raise WorkerError("INVALID_FCS", "FCS file is empty: %s" % path)
    if size > MAX_FCS_BYTES:
        raise WorkerError(
            "LIMIT_EXCEEDED",
            "FCS file is %d bytes; the limit is %d bytes" % (size, MAX_FCS_BYTES),
        )
    max_events = _input_int(data, "maxEvents", MAX_FCS_EVENTS, 1, MAX_FCS_EVENT_OVERRIDE)

    with open(path, "rb") as handle:
        raw = handle.read()
    file_hash = _text_sha256(raw)
    parsed = _parse_fcs(raw)
    total = parsed["total"]
    if total > max_events:
        raise WorkerError(
            "LIMIT_EXCEEDED",
            "FCS declares %d events; this call allows %d. Pass maxEvents (max %d) to raise the cap."
            % (total, max_events, MAX_FCS_EVENT_OVERRIDE),
        )

    channels = parsed["channels"]
    columns = _decode_fcs_columns(raw, parsed)
    stats = [_channel_stats(channel, columns[index]) for index, channel in enumerate(channels)]
    warnings = list(parsed["warnings"])
    non_finite_total = sum(entry["nonFinite"] for entry in stats)
    if non_finite_total:
        warnings.append(
            "%d non-finite channel values were excluded from statistics" % non_finite_total
        )

    channel_lookup = {channel["name"]: channel for channel in channels}
    channel_index = {channel["name"]: index for index, channel in enumerate(channels)}
    specs = _parse_population_specs(data, channel_lookup)
    if specs is None:
        populations: List[Dict[str, Any]] = []
        for channel, column in zip(channels, columns):
            values = [value for value in column if math.isfinite(value)]
            threshold = _otsu_threshold(values)
            if threshold is None:
                continue
            count = sum(1 for value in values if value > threshold)
            populations.append(
                {
                    "name": "above:%s" % channel["name"],
                    "channel": channel["name"],
                    "op": ">",
                    "threshold": threshold,
                    "count": count,
                    "fraction": (count / len(values)) if values else None,
                    "method": "otsu",
                }
            )
    else:
        populations = _evaluate_populations(specs, channel_index, columns)

    spillover, spillover_warnings = _parse_spillover(parsed["keywords"])
    warnings.extend(spillover_warnings)

    return {
        "file": {"path": path, "bytes": size, "sha256": file_hash},
        "fcsVersion": parsed["version"],
        "par": parsed["par"],
        "eventCount": total,
        "eventCountDeclared": total,
        "datatype": parsed["datatype"],
        "mode": "L",
        "byteord": parsed["byteord"],
        "endian": parsed["endian"],
        "channels": [
            {
                "index": channel["index"],
                "name": channel["name"],
                "marker": channel["marker"],
                "bits": channel["bits"],
                "range": channel["range"],
            }
            for channel in channels
        ],
        "channelNames": [channel["name"] for channel in channels],
        "markers": [channel["marker"] for channel in channels],
        "stats": stats,
        "populations": populations,
        "spillover": spillover,
        "nextData": _keyword_int(parsed["keywords"], "$NEXTDATA", 0, 2**63 - 1) or 0,
        "textKeywordCount": len(parsed["keywords"]),
        "warnings": warnings,
        "limits": {"maxEvents": max_events, "maxBytes": MAX_FCS_BYTES},
        "elapsedMs": _now_ms() - started,
    }


# ---------------------------------------------------------------------------
# datasetProfile
# ---------------------------------------------------------------------------


def _missing_tokens(data: Dict[str, Any]) -> set:
    raw = data.get("missingTokens")
    if raw is None:
        return set(DEFAULT_MISSING_TOKENS)
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise WorkerError("INVALID_INPUT", "'missingTokens' must be an array of strings")
    if len(raw) > 128:
        raise WorkerError("LIMIT_EXCEEDED", "'missingTokens' supports at most 128 entries")
    return set(raw)


def _sniff_delimiter(sample: str) -> str:
    line = ""
    for candidate_line in sample.splitlines():
        if candidate_line.strip():
            line = candidate_line
            break
    if not line:
        return ","
    best = ","
    best_count = -1
    for candidate in (",", "\t", ";", "|"):
        count = line.count(candidate)
        if count > best_count:
            best = candidate
            best_count = count
    return best if best_count > 0 else ","


_INT_RE = re.compile(r"[+-]?\d+")
_NUMBER_RE = re.compile(r"[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?")


def _infer_text_dtype(value: str) -> str:
    if _INT_RE.fullmatch(value):
        return "integer"
    if _NUMBER_RE.fullmatch(value):
        return "number"
    lowered = value.lower()
    if lowered in ("true", "false"):
        return "boolean"
    return "string"


def _new_column_stats(names: Sequence[str]) -> List[Dict[str, Any]]:
    return [
        {
            "name": name,
            "nonNull": 0,
            "missing": 0,
            "types": set(),
            "numericCount": 0,
            "numericSum": 0.0,
            "minimum": math.inf,
            "maximum": -math.inf,
            "distinct": set(),
            "distinctTruncated": False,
            "examples": [],
        }
        for name in names
    ]


DISTINCT_CAP = 4096
EXAMPLE_CAP = 3


def _collect_value(stats: Dict[str, Any], raw_value: Any, missing: set) -> None:
    if raw_value is None:
        stats["missing"] += 1
        return
    if isinstance(raw_value, bool):
        stats["types"].add("boolean")
        stats["nonNull"] += 1
        if len(stats["examples"]) < EXAMPLE_CAP:
            stats["examples"].append("true" if raw_value else "false")
        _add_distinct(stats, "true" if raw_value else "false")
        return
    if isinstance(raw_value, (int, float)):
        if isinstance(raw_value, float) and not math.isfinite(raw_value):
            stats["missing"] += 1
            return
        stats["types"].add("integer" if isinstance(raw_value, int) else "number")
        stats["nonNull"] += 1
        numeric = float(raw_value)
        stats["numericCount"] += 1
        stats["numericSum"] += numeric
        if numeric < stats["minimum"]:
            stats["minimum"] = numeric
        if numeric > stats["maximum"]:
            stats["maximum"] = numeric
        text = repr(raw_value)
        _add_distinct(stats, text)
        if len(stats["examples"]) < EXAMPLE_CAP:
            stats["examples"].append(text)
        return
    text = str(raw_value).strip()
    if text in missing:
        stats["missing"] += 1
        return
    dtype = _infer_text_dtype(text)
    stats["types"].add(dtype)
    stats["nonNull"] += 1
    _add_distinct(stats, text)
    if len(stats["examples"]) < EXAMPLE_CAP:
        stats["examples"].append(text[:80])
    if dtype in ("integer", "number"):
        try:
            numeric = float(text)
        except ValueError:
            return
        if not math.isfinite(numeric):
            return
        stats["numericCount"] += 1
        stats["numericSum"] += numeric
        if numeric < stats["minimum"]:
            stats["minimum"] = numeric
        if numeric > stats["maximum"]:
            stats["maximum"] = numeric


def _add_distinct(stats: Dict[str, Any], text: str) -> None:
    if stats["distinctTruncated"]:
        return
    if text in stats["distinct"]:
        return
    if len(stats["distinct"]) >= DISTINCT_CAP:
        stats["distinctTruncated"] = True
        return
    stats["distinct"].add(text)


def _finalize_dtype(stats: Dict[str, Any]) -> str:
    types = stats["types"]
    if not types:
        return "empty"
    if "string" in types:
        return "string"
    if types == {"boolean"}:
        return "boolean"
    if types == {"integer"}:
        return "integer"
    if types <= {"integer", "number"}:
        return "number"
    return "string"


def _finalize_columns(
    stats: List[Dict[str, Any]], row_count: int
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    columns: List[Dict[str, Any]] = []
    total_missing = 0
    cells = 0
    by_column: List[Dict[str, Any]] = []
    for index, entry in enumerate(stats):
        dtype = _finalize_dtype(entry)
        numeric = dtype in ("integer", "number") and entry["numericCount"] > 0
        column = {
            "index": index,
            "name": entry["name"],
            "dtype": dtype,
            "nonNull": entry["nonNull"],
            "missing": entry["missing"],
            "missingRate": (entry["missing"] / row_count) if row_count else None,
            "distinct": (
                None if entry["distinctTruncated"] else len(entry["distinct"])
            ),
            "distinctTruncated": entry["distinctTruncated"],
            "min": entry["minimum"] if numeric else None,
            "max": entry["maximum"] if numeric else None,
            "mean": (
                (entry["numericSum"] / entry["numericCount"]) if numeric else None
            ),
            "examples": entry["examples"],
        }
        columns.append(column)
        total_missing += entry["missing"]
        by_column.append({"name": entry["name"], "count": entry["missing"]})
        cells += row_count
    return columns, {
        "total": total_missing,
        "cells": cells,
        "rate": (total_missing / cells) if cells else None,
        "byColumn": by_column,
    }


def _profile_delimited(
    path: str, data: Dict[str, Any], format_name: str, max_rows: int, missing: set
) -> Dict[str, Any]:
    size = os.path.getsize(path)
    warnings: List[str] = []
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        delimiter_input = _input_str(data, "delimiter", None, 4)
        if format_name == "tsv":
            delimiter = "\t"
        else:
            sample = handle.read(65536)
            handle.seek(0)
            delimiter = delimiter_input or _sniff_delimiter(sample)
        if delimiter is not None:
            if len(delimiter) != 1:
                raise WorkerError("INVALID_INPUT", "'delimiter' must be a single character")
            if delimiter in ("\r", "\n", "\x00"):
                raise WorkerError("INVALID_INPUT", "Invalid delimiter %r" % delimiter)
        has_header = _input_bool(data, "hasHeader", True)
        reader = csv.reader(handle, delimiter=delimiter)
        try:
            first = next(reader)
        except StopIteration:
            first = None
        if first is None:
            return _empty_profile(path, size, format_name, delimiter, max_rows)
        if has_header:
            names = [cell.strip() or "column_%d" % (index + 1) for index, cell in enumerate(first)]
            rows: Iterable[List[str]] = reader
        else:
            names = ["column_%d" % (index + 1) for index in range(len(first))]
            rows = _prepend(first, reader)

        stats = _new_column_stats(names)
        total_rows = 0
        scanned = 0
        width = len(names)
        for row in rows:
            if not row:
                continue
            total_rows += 1
            if total_rows <= max_rows:
                scanned += 1
                if len(row) > width:
                    names.extend(
                        "column_%d" % (index + 1) for index in range(width, len(row))
                    )
                    stats.extend(_new_column_stats(names[width:]))
                    width = len(row)
                for index in range(width):
                    value = row[index] if index < len(row) else ""
                    _collect_value(stats[index], value.strip(), missing)
            if total_rows >= max_rows and width < len(row):
                pass
        if total_rows > max_rows:
            warnings.append(
                "Profiled the first %d of %d rows; aggregates cover the profiled rows only"
                % (max_rows, total_rows)
            )
    columns, missing_summary = _finalize_columns(stats, scanned)
    return {
        "file": {"path": path, "bytes": size, "sha256": _file_sha256(path)},
        "format": format_name,
        "delimiter": delimiter,
        "rowCount": total_rows,
        "columnCount": len(columns),
        "columns": columns,
        "missing": missing_summary,
        "scannedRows": scanned,
        "maxRows": max_rows,
        "truncated": total_rows > max_rows,
        "warnings": warnings,
        "elapsedMs": 0,
    }


def _prepend(first: List[str], iterator: Iterable[List[str]]) -> Iterable[List[str]]:
    yield first
    for row in iterator:
        yield row


def _empty_profile(
    path: str, size: int, format_name: str, delimiter: Optional[str], max_rows: int
) -> Dict[str, Any]:
    return {
        "file": {"path": path, "bytes": size, "sha256": _file_sha256(path)},
        "format": format_name,
        "delimiter": delimiter,
        "rowCount": 0,
        "columnCount": 0,
        "columns": [],
        "missing": {"total": 0, "cells": 0, "rate": None, "byColumn": []},
        "scannedRows": 0,
        "maxRows": max_rows,
        "truncated": False,
        "warnings": ["Dataset is empty"],
        "elapsedMs": 0,
    }


def _json_rows(data: Any) -> Tuple[List[Any], int]:
    """Return (first rows for profiling, declared row count) for a parsed JSON value."""

    if isinstance(data, list):
        return data, len(data)
    if isinstance(data, dict):
        return [data], 1
    raise WorkerError(
        "INVALID_INPUT",
        "JSON dataset must be an array of objects/arrays or an object",
    )


def _profile_records(
    records: Sequence[Any],
    declared_rows: int,
    column_names: Optional[Sequence[str]],
    data: Dict[str, Any],
    max_rows: int,
    missing: set,
    warnings: List[str],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any], int]:
    scanned = min(len(records), max_rows) if max_rows >= 0 else len(records)
    sample = records[:max_rows] if max_rows >= 0 else records
    first = sample[0] if sample else None
    names: List[str] = []
    accessor: Any = None
    if first is None:
        return [], {"total": 0, "cells": 0, "rate": None, "byColumn": []}, 0
    if isinstance(first, dict):
        if column_names:
            names = [str(name) for name in column_names]
        else:
            for record in sample:
                if not isinstance(record, dict):
                    raise WorkerError("INVALID_INPUT", "JSON array mixes objects with other values")
                for key in record:
                    if key not in names:
                        names.append(str(key))
                        if len(names) > 4096:
                            raise WorkerError("LIMIT_EXCEEDED", "JSON dataset has more than 4096 columns")
        accessor = "object"
    elif isinstance(first, (list, tuple)):
        width = max(len(record) for record in sample if isinstance(record, (list, tuple)))
        if column_names:
            names = [str(name) for name in column_names]
            if len(names) < width:
                names.extend("column_%d" % (index + 1) for index in range(len(names), width))
        else:
            names = ["column_%d" % (index + 1) for index in range(width)]
        accessor = "array"
        for record in sample:
            if not isinstance(record, (list, tuple)):
                raise WorkerError("INVALID_INPUT", "JSON array mixes arrays with other values")
    elif isinstance(first, (str, int, float, bool)) or first is None:
        names = ["value"]
        accessor = "scalar"
    else:
        raise WorkerError("INVALID_INPUT", "Unsupported JSON row type %r" % type(first).__name__)
    if column_names and accessor == "object":
        names = [str(name) for name in column_names]
    stats = _new_column_stats(names)
    for record in sample:
        if accessor == "object":
            for index, name in enumerate(names):
                _collect_value(stats[index], record.get(name) if isinstance(record, dict) else None, missing)
        elif accessor == "array":
            for index in range(len(names)):
                value = record[index] if isinstance(record, (list, tuple)) and index < len(record) else None
                _collect_value(stats[index], value, missing)
        else:
            _collect_value(stats[0], record, missing)
    del data
    del warnings
    columns, missing_summary = _finalize_columns(stats, scanned)
    return columns, missing_summary, scanned


def _profile_json(
    path: str, data: Dict[str, Any], lines_mode: bool, max_rows: int, missing: set
) -> Dict[str, Any]:
    size = os.path.getsize(path)
    warnings: List[str] = []
    column_names = data.get("header")
    if column_names is not None and (
        not isinstance(column_names, list) or any(not isinstance(item, str) for item in column_names)
    ):
        raise WorkerError("INVALID_INPUT", "'header' must be an array of strings")
    if lines_mode:
        records: List[Any] = []
        total = 0
        with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            for line in handle:
                if not line.strip():
                    continue
                total += 1
                if len(records) < max_rows:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError as exc:
                        raise WorkerError(
                            "INVALID_JSON",
                            "Invalid JSONL at line %d: %s" % (total, exc.msg),
                        ) from None
        columns, missing_summary, scanned = _profile_records(
            records, total, column_names, data, max_rows, missing, warnings
        )
        total_rows = total
    else:
        try:
            with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
                parsed = json.load(handle)
        except json.JSONDecodeError as exc:
            raise WorkerError("INVALID_JSON", "Invalid JSON: %s at char %d" % (exc.msg, exc.pos)) from None
        records, total_rows = _json_rows(parsed)
        columns, missing_summary, scanned = _profile_records(
            records, total_rows, column_names, data, max_rows, missing, warnings
        )
    if total_rows > scanned:
        warnings.append(
            "Profiled the first %d of %d rows; aggregates cover the profiled rows only"
            % (scanned, total_rows)
        )
    return {
        "file": {"path": path, "bytes": size, "sha256": _file_sha256(path)},
        "format": "jsonl" if lines_mode else "json",
        "delimiter": None,
        "rowCount": total_rows,
        "columnCount": len(columns),
        "columns": columns,
        "missing": missing_summary,
        "scannedRows": scanned,
        "maxRows": max_rows,
        "truncated": total_rows > scanned,
        "warnings": warnings,
        "elapsedMs": 0,
    }


def _resolve_dataset_format(path: str, data: Dict[str, Any]) -> Tuple[str, bool]:
    fmt = _input_str(data, "format", "auto", 32)
    fmt = (fmt or "auto").strip().lower()
    allowed = ("auto", "csv", "tsv", "json", "jsonl", "delimited")
    if fmt not in allowed:
        raise WorkerError(
            "INVALID_INPUT", "'format' must be one of %s" % ", ".join(allowed)
        )
    extension = os.path.splitext(path)[1].lower()
    if fmt == "auto":
        if extension == ".csv":
            return "csv", False
        if extension == ".tsv":
            return "tsv", False
        if extension == ".json":
            return "json", False
        if extension in (".jsonl", ".ndjson"):
            return "jsonl", True
        with open(path, "rb") as handle:
            head = handle.read(65536)
        text = head.decode("utf-8-sig", "replace").lstrip()
        if text.startswith("["):
            return "json", False
        if text.startswith("{"):
            try:
                with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
                    json.load(handle)
                return "json", False
            except json.JSONDecodeError:
                return "jsonl", True
        return "delimited", False
    if fmt == "jsonl":
        return "jsonl", True
    if fmt == "json":
        return "json", False
    return fmt, False


def op_dataset_profile(data: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_ms()
    path = _input_abs_path(data, "path", must_exist=True)
    size = os.path.getsize(path)
    if size > MAX_DATASET_BYTES:
        raise WorkerError(
            "LIMIT_EXCEEDED",
            "Dataset is %d bytes; the limit is %d bytes" % (size, MAX_DATASET_BYTES),
        )
    max_rows = _input_int(data, "maxRows", MAX_DATASET_ROWS, 1, MAX_DATASET_ROWS)
    missing = _missing_tokens(data)
    format_name, lines_mode = _resolve_dataset_format(path, data)
    if format_name in ("json", "jsonl"):
        result = _profile_json(path, data, lines_mode, max_rows, missing)
    else:
        result = _profile_delimited(path, data, format_name, max_rows, missing)
    result["elapsedMs"] = _now_ms() - started
    return result


# ---------------------------------------------------------------------------
# discoveryScan
# ---------------------------------------------------------------------------

_EXTENSION_RE = re.compile(r"\.[A-Za-z0-9._-]{1,16}")


def _scan_extensions(data: Dict[str, Any]) -> set:
    raw = data.get("extensions")
    if raw is None:
        return set(DEFAULT_DATA_EXTENSIONS)
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise WorkerError("INVALID_INPUT", "'extensions' must be an array of strings")
    if not raw or len(raw) > 64:
        raise WorkerError("INVALID_INPUT", "'extensions' must contain 1..64 entries")
    extensions = set()
    for item in raw:
        lowered = item.strip().lower()
        if not lowered.startswith("."):
            lowered = "." + lowered
        if not _EXTENSION_RE.fullmatch(lowered):
            raise WorkerError("INVALID_INPUT", "Invalid extension %r" % item)
        extensions.add(lowered)
    return extensions


def _count_newlines(path: str, limit_bytes: Optional[int] = None) -> Tuple[int, bool]:
    newlines = 0
    total = 0
    last_byte = b"\n"
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            newlines += chunk.count(b"\n")
            last_byte = chunk[-1:]
            if limit_bytes is not None and total >= limit_bytes:
                break
    return newlines, last_byte not in (b"\n", b"\r")


def _fcs_event_count_from_path(path: str) -> Optional[int]:
    try:
        with open(path, "rb") as handle:
            header = handle.read(58)
            if len(header) < 58:
                return None
            version, fields = _parse_fcs_header(header)
            del version
            text_start = fields[0]
            text_end = fields[1]
            if not text_start or text_end is None or text_end < text_start:
                return None
            handle.seek(text_start)
            segment = handle.read(text_end - text_start + 1)
            keywords = _parse_fcs_text_bytes(segment)
            raw_total = keywords.get("$TOT")
            if raw_total is None or not raw_total.strip().isdigit():
                return None
            return int(raw_total.strip())
    except (OSError, WorkerError, ValueError):
        return None


def _json_row_count(path: str, size: int) -> Optional[int]:
    if size > 32 * 1024 * 1024:
        return None
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            parsed = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(parsed, list):
        return len(parsed)
    if isinstance(parsed, dict):
        return 1
    return None


def _jsonl_row_count(path: str) -> Optional[int]:
    try:
        count = 0
        with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            for line in handle:
                if line.strip():
                    count += 1
        return count
    except OSError:
        return None


def _infer_rows(path: str, extension: str, size: int) -> Optional[int]:
    if extension in (".csv", ".tsv"):
        newlines, missing_final_newline = _count_newlines(path)
        rows = newlines + (1 if missing_final_newline else 0)
        return max(rows - 1, 0)
    if extension == ".fcs":
        return _fcs_event_count_from_path(path)
    if extension == ".json":
        return _json_row_count(path, size)
    if extension in (".jsonl", ".ndjson"):
        return _jsonl_row_count(path)
    return None


def op_discovery_scan(data: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_ms()
    root = _input_abs_path(data, "root", must_exist=True, want_dir=True)
    max_depth = _input_int(data, "maxDepth", 4, 0, 32)
    max_files = _input_int(data, "maxFiles", 5000, 1, MAX_SCAN_FILES)
    extensions = _scan_extensions(data)
    hash_enabled = _input_bool(data, "hash", True)
    include_hidden = _input_bool(data, "includeHidden", False)
    warnings: List[str] = []
    skipped: Dict[str, List[str]] = {"symlinks": [], "depthExceeded": [], "unreadable": []}
    manifest: List[Dict[str, Any]] = []
    directory_count = 0
    total_bytes = 0
    truncated = False
    stack: List[Tuple[str, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            with os.scandir(current) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError:
            skipped["unreadable"].append(_relpath(current, root))
            continue
        nested_directories: List[Tuple[str, int]] = []
        for entry in entries:
            rel = _relpath(entry.path, root)
            try:
                if entry.is_symlink():
                    skipped["symlinks"].append(rel)
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if not include_hidden and entry.name.startswith("."):
                        continue
                    directory_count += 1
                    if depth >= max_depth:
                        skipped["depthExceeded"].append(rel)
                        continue
                    nested_directories.append((entry.path, depth + 1))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                if not include_hidden and entry.name.startswith("."):
                    continue
                extension = os.path.splitext(entry.name)[1].lower()
                if extension not in extensions:
                    continue
                if len(manifest) >= max_files:
                    truncated = True
                    continue
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    skipped["unreadable"].append(rel)
                    continue
                if total_bytes + stat.st_size > MAX_SCAN_BYTES:
                    truncated = True
                    warnings.append(
                        "Stopped collecting files after %d bytes" % MAX_SCAN_BYTES
                    )
                    continue
                entry_hash: Optional[str] = None
                if hash_enabled:
                    try:
                        entry_hash = _file_sha256(entry.path)
                    except OSError:
                        skipped["unreadable"].append(rel)
                        continue
                rows = _infer_rows(entry.path, extension, stat.st_size)
                total_bytes += stat.st_size
                manifest.append(
                    {
                        "path": rel.replace(os.sep, "/"),
                        "bytes": stat.st_size,
                        "modifiedAt": int(stat.st_mtime * 1000),
                        "sha256": entry_hash,
                        "kind": extension[1:] if extension else "file",
                        "rows": rows,
                    }
                )
            except OSError:
                skipped["unreadable"].append(rel)
                continue
        for item in reversed(nested_directories):
            stack.append(item)

    manifest.sort(key=lambda item: item["path"])
    by_extension: Dict[str, int] = {}
    for item in manifest:
        by_extension[item["kind"]] = by_extension.get(item["kind"], 0) + 1
    duplicates: List[Dict[str, Any]] = []
    if hash_enabled:
        groups: Dict[str, List[str]] = {}
        for item in manifest:
            digest = item["sha256"]
            if digest:
                groups.setdefault(digest, []).append(item["path"])
        duplicates = [
            {"sha256": digest, "paths": paths}
            for digest, paths in sorted(groups.items())
            if len(paths) > 1
        ]
    rows_known = sum(1 for item in manifest if item["rows"] is not None)
    rows_total = sum(item["rows"] for item in manifest if item["rows"] is not None)
    return {
        "root": root,
        "files": manifest,
        "fileCount": len(manifest),
        "directoryCount": directory_count,
        "totalBytes": total_bytes,
        "byExtension": dict(sorted(by_extension.items())),
        "duplicates": duplicates,
        "skipped": skipped,
        "maxDepth": max_depth,
        "truncated": truncated,
        "hash": "sha256" if hash_enabled else None,
        "rowsTotal": rows_total,
        "rowsKnownFiles": rows_known,
        "warnings": warnings,
        "limits": {"maxFiles": max_files, "maxBytes": MAX_SCAN_BYTES},
        "elapsedMs": _now_ms() - started,
    }


def _relpath(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root)
    except ValueError:
        return path


# ---------------------------------------------------------------------------
# runScript
# ---------------------------------------------------------------------------


def _validate_file_name(name: str) -> None:
    if not isinstance(name, str) or not name:
        raise WorkerError("INVALID_INPUT", "Input file name must be a non-empty string")
    if len(name) > 100:
        raise WorkerError("INVALID_INPUT", "Input file name is longer than 100 characters")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", name):
        raise WorkerError(
            "INVALID_INPUT",
            "Input file name %r may only contain letters, digits, '.', '_' and '-'" % name,
        )
    if name in (".", "..") or name.endswith(".") or name.endswith(" "):
        raise WorkerError("INVALID_INPUT", "Input file name %r is not a valid file name" % name)
    stem = name.split(".")[0].upper()
    if stem in WINDOWS_RESERVED_NAMES:
        raise WorkerError("INVALID_INPUT", "Input file name %r is reserved on Windows" % name)
    if name in RESERVED_SCRIPT_NAMES:
        raise WorkerError(
            "INVALID_INPUT", "Input file name %r collides with the script entry point" % name
        )


def _decode_input_file(spec: Any, label: str) -> Optional[bytes]:
    if not isinstance(spec, dict):
        raise WorkerError("INVALID_INPUT", "%s must be an object" % label)
    name = spec.get("name")
    _validate_file_name(name)
    text = spec.get("text")
    encoded = spec.get("dataBase64")
    if text is not None and encoded is not None:
        raise WorkerError(
            "INVALID_INPUT", "%s must provide either 'text' or 'dataBase64', not both" % label
        )
    if text is not None:
        if not isinstance(text, str):
            raise WorkerError("INVALID_INPUT", "%s.text must be a string" % label)
        payload = text.encode("utf-8")
    elif encoded is not None:
        if not isinstance(encoded, str):
            raise WorkerError("INVALID_INPUT", "%s.dataBase64 must be a string" % label)
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise WorkerError(
                "INVALID_INPUT", "%s.dataBase64 is not valid base64" % label
            ) from None
    else:
        payload = b""
    if len(payload) > MAX_INPUT_FILE_BYTES:
        raise WorkerError(
            "LIMIT_EXCEEDED", "%s is larger than %d bytes" % (label, MAX_INPUT_FILE_BYTES)
        )
    return payload


def _write_input_files(
    data: Dict[str, Any], sandbox: str
) -> List[Dict[str, Any]]:
    specs = data.get("files")
    if specs is None:
        return []
    if not isinstance(specs, list):
        raise WorkerError("INVALID_INPUT", "'files' must be an array")
    if len(specs) > MAX_INPUT_FILES:
        raise WorkerError(
            "LIMIT_EXCEEDED", "'files' supports at most %d entries" % MAX_INPUT_FILES
        )
    written: List[Dict[str, Any]] = []
    total = 0
    for index, spec in enumerate(specs):
        label = "files[%d]" % index
        payload = _decode_input_file(spec, label)
        assert payload is not None
        total += len(payload)
        if total > MAX_INPUT_TOTAL_BYTES:
            raise WorkerError(
                "LIMIT_EXCEEDED",
                "Input files exceed the %d byte total limit" % MAX_INPUT_TOTAL_BYTES,
            )
        name = spec["name"]
        with open(os.path.join(sandbox, name), "wb") as handle:
            handle.write(payload)
        written.append({"name": name, "bytes": len(payload), "sha256": _text_sha256(payload)})
    return written


def _create_sandbox(data: Dict[str, Any]) -> Tuple[str, str]:
    root_value = data.get("sandboxRoot")
    if not isinstance(root_value, str) or not root_value.strip():
        raise WorkerError(
            "INVALID_INPUT",
            "'sandboxRoot' must be a non-empty absolute path string",
        )
    if "\x00" in root_value:
        raise WorkerError("INVALID_INPUT", "'sandboxRoot' contains a NUL byte")
    if not os.path.isabs(root_value):
        raise WorkerError(
            "INVALID_INPUT", "'sandboxRoot' must be an absolute path: %r" % root_value
        )
    root = os.path.normpath(root_value)
    if os.path.exists(root) and not os.path.isdir(root):
        raise WorkerError(
            "INVALID_INPUT", "'sandboxRoot' exists and is not a directory: %s" % root
        )
    try:
        os.makedirs(root, exist_ok=True)
    except OSError as exc:
        raise WorkerError(
            "SANDBOX_UNAVAILABLE", "Could not create sandbox root %s: %s" % (root, exc)
        ) from None
    try:
        root_real = os.path.realpath(root)
        sandbox = tempfile.mkdtemp(prefix="run-", dir=root_real)
    except OSError as exc:
        raise WorkerError(
            "SANDBOX_UNAVAILABLE", "Could not create a run sandbox: %s" % exc
        ) from None
    sandbox_real = os.path.realpath(sandbox)
    if not (sandbox_real == root_real or sandbox_real.startswith(root_real + os.sep)):
        raise WorkerError(
            "SANDBOX_UNAVAILABLE", "Run sandbox escaped its root: %s" % sandbox_real
        )
    return root_real, sandbox_real


def _build_environment(
    sandbox: str, tmpdir: str, seed: int, extra: Optional[Dict[str, str]] = None
) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for key in ENV_ALLOWLIST:
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    env["TEMP"] = tmpdir
    env["TMP"] = tmpdir
    env["HOME"] = os.environ.get("USERPROFILE") or sandbox
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONHASHSEED"] = str(seed % (2**32))
    env["SUWEN_SEED"] = str(seed)
    env["SUWEN_SANDBOX"] = sandbox
    env["SUWEN_RUN_ID"] = uuid.uuid4().hex
    if extra:
        env.update(extra)
    return env


def _node_version(node_path: Optional[str]) -> Optional[str]:
    if not node_path:
        return None
    try:
        completed = subprocess.run(
            [node_path, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            shell=False,
            creationflags=_creation_flags(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = completed.stdout.decode("utf-8", "replace").strip()
    return text or None


def _creation_flags() -> int:
    if os.name == "nt":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def _resolve_node(data: Dict[str, Any]) -> Optional[str]:
    candidate = data.get("nodePath")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = os.environ.get("SUWEN_NODE_PATH")
    if not isinstance(candidate, str) or not candidate.strip():
        candidate = shutil.which("node")
    if not candidate:
        return None
    path = os.path.normpath(candidate)
    if not os.path.isfile(path):
        raise WorkerError("NODE_NOT_FOUND", "Node executable not found: %s" % path)
    return path


def _kill_tree(proc: "subprocess.Popen[bytes]") -> None:
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                shell=False,
                creationflags=_creation_flags(),
            )
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            proc.kill()
        except OSError:
            pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except OSError:
            pass


def _capture_stream(stream: Any, cap: int, sink: Dict[str, Any], key: str) -> None:
    buffer = bytearray()
    total = 0
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if len(buffer) < cap:
                buffer.extend(chunk[: cap - len(buffer)])
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass
    sink[key] = (bytes(buffer), total)


def _execute_process(
    command: Sequence[str],
    cwd: str,
    env: Dict[str, str],
    timeout_ms: int,
) -> Dict[str, Any]:
    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            list(command),
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            creationflags=_creation_flags(),
            start_new_session=os.name != "nt",
        )
    except FileNotFoundError:
        raise WorkerError("EXECUTABLE_NOT_FOUND", "Executable not found: %s" % command[0]) from None
    except OSError as exc:
        raise WorkerError("EXEC_FAILED", "Could not start the script process: %s" % exc) from None

    sink: Dict[str, Any] = {}
    stdout_thread = threading.Thread(
        target=_capture_stream,
        args=(proc.stdout, MAX_STDOUT_BYTES, sink, "stdout"),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=_capture_stream,
        args=(proc.stderr, MAX_STDERR_BYTES, sink, "stderr"),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    timed_out = False
    try:
        proc.wait(timeout=max(timeout_ms, 1) / 1000.0)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    stdout_thread.join(timeout=10)
    stderr_thread.join(timeout=10)
    stdout_bytes, stdout_total = sink.get("stdout", (b"", 0))
    stderr_bytes, stderr_total = sink.get("stderr", (b"", 0))
    return {
        "exitCode": None if timed_out else proc.returncode,
        "signal": None,
        "timedOut": timed_out,
        "stdout": stdout_bytes.decode("utf-8", "replace"),
        "stderr": stderr_bytes.decode("utf-8", "replace"),
        "stdoutTruncated": stdout_total > len(stdout_bytes),
        "stderrTruncated": stderr_total > len(stderr_bytes),
        "stdoutBytes": stdout_total,
        "stderrBytes": stderr_total,
        "durationMs": int((time.monotonic() - started) * 1000),
    }


def _collect_artifacts(
    sandbox: str, entry_name: str, input_names: Sequence[str]
) -> Tuple[List[Dict[str, Any]], bool]:
    artifacts: List[Dict[str, Any]] = []
    truncated = False
    input_set = set(input_names)
    for directory, dirnames, filenames in os.walk(sandbox, followlinks=False):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if not os.path.islink(os.path.join(directory, name))
        )
        filenames.sort()
        for filename in filenames:
            full = os.path.join(directory, filename)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, sandbox).replace(os.sep, "/")
            if rel == entry_name:
                continue
            if not os.path.isfile(full):
                continue
            if len(artifacts) >= MAX_ARTIFACTS:
                truncated = True
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size > MAX_ARTIFACT_BYTES:
                artifacts.append(
                    {
                        "path": rel,
                        "bytes": size,
                        "sha256": None,
                        "input": rel in input_set,
                        "error": "artifact-too-large",
                    }
                )
                continue
            try:
                digest = _file_sha256(full)
            except OSError:
                continue
            artifacts.append(
                {
                    "path": rel,
                    "bytes": size,
                    "sha256": digest,
                    "input": rel in input_set,
                }
            )
    artifacts.sort(key=lambda item: item["path"])
    return artifacts, truncated


def op_run_script(data: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_ms()
    language = data.get("language")
    if language not in ("python", "node"):
        raise WorkerError("INVALID_INPUT", "'language' must be 'python' or 'node'")
    source = data.get("source")
    if not isinstance(source, str) or not source.strip():
        raise WorkerError("INVALID_INPUT", "'source' must be a non-empty string")
    if len(source.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise WorkerError(
            "LIMIT_EXCEEDED", "Script source is larger than %d bytes" % MAX_SCRIPT_BYTES
        )
    args_raw = data.get("args")
    args: List[str] = []
    if args_raw is not None:
        if not isinstance(args_raw, list) or any(not isinstance(item, str) for item in args_raw):
            raise WorkerError("INVALID_INPUT", "'args' must be an array of strings")
        if len(args_raw) > 64:
            raise WorkerError("LIMIT_EXCEEDED", "'args' supports at most 64 entries")
        for item in args_raw:
            if len(item) > 4096 or "\x00" in item:
                raise WorkerError("INVALID_INPUT", "Each argument must be <4096 chars without NUL")
        args = list(args_raw)
    timeout_ms = _input_int(data, "timeoutMs", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    seed_raw = data.get("seed")
    if seed_raw is None:
        seed = int.from_bytes(os.urandom(4), "little")
    else:
        if isinstance(seed_raw, bool) or not isinstance(seed_raw, int):
            raise WorkerError("INVALID_INPUT", "'seed' must be an integer")
        if seed_raw < 0 or seed_raw > 2**32 - 1:
            raise WorkerError("INVALID_INPUT", "'seed' must be between 0 and 4294967295")
        seed = seed_raw
    timeout_ms = int(timeout_ms or DEFAULT_TIMEOUT_MS)

    node_path = _resolve_node(data) if language == "node" else None
    if language == "node" and node_path is None:
        raise WorkerError(
            "NODE_NOT_FOUND",
            "Node executable was not provided, is not set via SUWEN_NODE_PATH, and is not on PATH",
        )

    _root, sandbox = _create_sandbox(data)
    tmpdir = os.path.join(sandbox, "tmp")
    os.makedirs(tmpdir, exist_ok=True)
    warnings: List[str] = []
    try:
        input_files = _write_input_files(data, sandbox)
        if language == "python":
            entry_name = "main.py"
        elif re.search(r"\brequire\s*\(|\bmodule\.exports\b", source):
            entry_name = "main.cjs"
        else:
            entry_name = "main.mjs"
        entry_path = os.path.join(sandbox, entry_name)
        with open(entry_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(source)
        if language == "python":
            executable = sys.executable
            if not executable:
                raise WorkerError("PYTHON_NOT_FOUND", "The worker has no Python executable")
            command = [executable, "-u", "-B", entry_name] + args
            extra_env: Dict[str, str] = {}
        else:
            assert node_path is not None
            executable = node_path
            command = [node_path, entry_name] + args
            basename = os.path.basename(node_path).lower()
            extra_env = {}
            if basename.startswith("electron"):
                extra_env["ELECTRON_RUN_AS_NODE"] = "1"
        env = _build_environment(sandbox, tmpdir, seed, extra_env)
        result = _execute_process(command, sandbox, env, timeout_ms)
    except Exception:
        shutil.rmtree(sandbox, ignore_errors=True)
        raise
    artifacts, artifacts_truncated = _collect_artifacts(
        sandbox, entry_name, [item["name"] for item in input_files]
    )
    if result["timedOut"]:
        warnings.append(
            "Script exceeded its %d ms timeout and was killed; output is partial" % timeout_ms
        )
    versions: Dict[str, Any] = {"python": platform.python_version(), "node": None}
    if language == "node":
        versions["node"] = _node_version(node_path)
    return {
        "language": language,
        "sandbox": sandbox,
        "script": entry_name,
        "seed": seed,
        "timeoutMs": timeout_ms,
        "durationMs": _now_ms() - started,
        "exitCode": result["exitCode"],
        "signal": result["signal"],
        "timedOut": result["timedOut"],
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "stdoutTruncated": result["stdoutTruncated"],
        "stderrTruncated": result["stderrTruncated"],
        "stdoutBytes": result["stdoutBytes"],
        "stderrBytes": result["stderrBytes"],
        "files": artifacts,
        "inputFiles": input_files,
        "artifactsTruncated": artifacts_truncated,
        "versions": versions,
        "isolation": ISOLATION_NOTE,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Protocol loop
# ---------------------------------------------------------------------------


HANDLERS = {
    "health": op_health,
    "describe": op_describe,
    "flowSummary": op_flow_summary,
    "datasetProfile": op_dataset_profile,
    "discoveryScan": op_discovery_scan,
    "runScript": op_run_script,
}


def _dispatch(request: Dict[str, Any]) -> Any:
    op = request.get("op", request.get("operation"))
    if not isinstance(op, str) or not op.strip():
        raise WorkerError("INVALID_REQUEST", "Request must include a non-empty 'op'")
    op = op.strip()
    raw_input = request.get("input")
    if raw_input is None:
        raw_input = {}
    if not isinstance(raw_input, dict):
        raise WorkerError("INVALID_INPUT", "'input' must be a JSON object")
    handler = HANDLERS.get(op)
    if handler is None:
        raise WorkerError(
            "UNKNOWN_OP",
            "Unknown op %r. Supported ops: %s" % (op, ", ".join(OPS)),
        )
    return handler(raw_input)


def _decode_request(line: bytes) -> Any:
    try:
        text = line.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkerError("BAD_JSON", "Request line is not valid UTF-8: %s" % exc) from None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise WorkerError(
            "BAD_JSON", "Request line is not valid JSON: %s at char %d" % (exc.msg, exc.pos)
        ) from None


def _write_response(stream: Any, payload: Dict[str, Any]) -> None:
    safe = _json_safe(payload)
    try:
        line = json.dumps(
            safe, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        fallback = {
            "id": payload.get("id"),
            "ok": False,
            "error": {"code": "INTERNAL", "message": "Could not encode response: %s" % exc},
        }
        line = json.dumps(fallback, separators=(",", ":")).encode("utf-8")
    if len(line) > MAX_RESPONSE_BYTES:
        too_large = {
            "id": payload.get("id"),
            "ok": False,
            "error": {
                "code": "RESPONSE_TOO_LARGE",
                "message": "Response exceeds %d bytes" % MAX_RESPONSE_BYTES,
            },
        }
        line = json.dumps(too_large, separators=(",", ":")).encode("utf-8")
    stream.write(line + b"\n")
    stream.flush()


def _read_line(stream: Any) -> Optional[bytes]:
    line = stream.readline(MAX_LINE_BYTES + 1)
    if not line:
        return None
    if len(line) > MAX_LINE_BYTES:
        while line and not line.endswith(b"\n"):
            line = stream.readline(MAX_LINE_BYTES + 1)
        return b""
    return line


def main() -> int:
    stream = sys.stdin.buffer
    out = sys.stdout.buffer
    while True:
        line = _read_line(stream)
        if line is None:
            return 0
        if line == b"":
            _write_response(
                out,
                {
                    "id": None,
                    "ok": False,
                    "error": {
                        "code": "LINE_TOO_LARGE",
                        "message": "Request line exceeds %d bytes" % MAX_LINE_BYTES,
                    },
                },
            )
            continue
        request_id: Any = None
        try:
            request = _decode_request(line)
            if not isinstance(request, dict):
                raise WorkerError("INVALID_REQUEST", "Request must be a JSON object")
            request_id = request.get("id")
            result = _dispatch(request)
            payload: Dict[str, Any] = {"id": request_id, "ok": True, "result": result}
        except WorkerError as exc:
            payload = {
                "id": request_id,
                "ok": False,
                "error": {"code": exc.code, "message": exc.message},
            }
        except Exception as exc:  # noqa: BLE001 - the worker must never crash
            payload = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": "INTERNAL",
                    "message": "%s: %s" % (type(exc).__name__, str(exc)[:600]),
                },
            }
        _write_response(out, payload)


if __name__ == "__main__":
    sys.exit(main())
