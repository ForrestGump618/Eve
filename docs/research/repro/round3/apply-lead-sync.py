#!/usr/bin/env python
"""Apply the Lead's 2026-10-25 protocol/version clarifications to round-3 docs.

Read-only w.r.t. code. Edits only D-owned docs:
release-gates.md, release-notes-v3.2.0.md, final-acceptance-report.md, github-publication.md,
master-requirements.csv (row metadata only; statuses untouched), feature-parity-matrix.csv,
traceability.md (append), progress.md (append bullet), CHANGELOG.md (append bullet).
Does NOT change G3/G4/G5 statuses or fill PENDING_LEAD slots.
"""
from __future__ import annotations

import csv
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DOCS = ROOT / "docs"
changes: list[str] = []


def patch(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {label}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    changes.append(f"{path.relative_to(ROOT)}: {label}")


def append(path: Path, text: str, label: str) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as f:
        f.write(text)
    changes.append(f"{path.relative_to(ROOT)}: {label}")


# ---------------- release-gates.md: G3 evidence + blocker (status stays UNVERIFIED)
patch(
    DOCS / "release" / "release-gates.md",
    "| No quantitative matrix (100/1,000/10,000 deltas), no composer-displacement or scroll-intent measurement, no duplicate/out-of-order/replay E2E |",
    "Main-process bridge per Lead 2026-10-25: `events.stream` is **main-process-only**; renderer gap replay goes through the main bridge `window.suwen.call('events.replay', {since, limit})`; daemon auto-reconnect uses bounded backoff **300 ms…12 s**, re-pushes the encrypted model config + safeStorage credential refs, and emits `window.suwen.onConnection({state:'reconnecting'|'restored'|'lost'})`; protocol contract in `docs/architecture/streaming-events.md`. | No quantitative matrix (100/1,000/10,000 deltas), no composer-displacement or scroll-intent measurement, no duplicate/out-of-order/replay E2E run; auto-reconnect timing not measured on a final build |",
    "G3 evidence/blocker: main bridge replay + bounded auto-reconnect",
)

# ---------------- release-notes: version line corrected (package.json already 3.2.0)
patch(
    DOCS / "release" / "release-notes-v3.2.0.md",
    "| Version | 3.2.0 (package version currently still `3.1.0` until the Lead bumps it) |",
    "| Version | 3.2.0 — confirmed in `desktop/package.json:3` and the package-lock root (bumped by the Lead); the rebuilt installer is still pending |",
    "installer version row: 3.2.0 confirmed",
)
patch(
    DOCS / "release" / "release-notes-v3.2.0.md",
    "  `events.stream` with a versioned envelope (`StreamEnvelope` v1) and cursor/replay semantics; the\n  main process forwards incremental batches to a frozen preload API (`onEvent`, `onConnection`).",
    "  `events.stream` (main-process-only) with a versioned envelope (`StreamEnvelope` v1) and\n  cursor/replay semantics; renderer gap replay uses the main bridge\n  `window.suwen.call('events.replay', {since, limit})`; the main process forwards incremental batches\n  to a frozen preload API (`onEvent`, `onConnection`), auto-reconnects the daemon with bounded\n  backoff (300 ms…12 s), re-pushes the encrypted model config + safeStorage credential refs, and emits\n  `onConnection({state:'reconnecting'|'restored'|'lost'})`.",
    "streaming section: replay bridge + auto-reconnect",
)

# ---------------- final-acceptance: add package-version row (B section)
patch(
    DOCS / "release" / "final-acceptance-report.md",
    "| Checksums | `desktop/release/SHA256SUMS` + committed mirror `docs/release/SHA256SUMS.txt` |",
    "| Checksums | `desktop/release/SHA256SUMS` + committed mirror `docs/release/SHA256SUMS.txt` |\n| Package version | **3.2.0 confirmed** in `desktop/package.json:3` and package-lock root (Lead, 2026-10-25); installer rebuild still PENDING_LEAD |",
    "package version row 3.2.0 confirmed",
)
patch(
    DOCS / "release" / "final-acceptance-report.md",
    "| Streaming protocol | implemented code + unit test (`stream-events.test.ts`), RPC `events.stream` merged into daemon (daemon.ts:194); runtime UI verification pending |",
    "| Streaming protocol | implemented code + unit test (`stream-events.test.ts`), RPC `events.stream` merged into daemon (daemon.ts:194) and main-process-only; renderer gap replay via main bridge `window.suwen.call('events.replay', {since, limit})`; bounded auto-reconnect 300 ms…12 s re-pushes encrypted model config + credential refs and emits `onConnection` states; runtime UI verification pending |",
    "streaming protocol bridge facts",
)

# ---------------- github-publication: bump no longer pending
patch(
    DOCS / "release" / "github-publication.md",
    "6. 3.2.0 version bump + `docs/release/CHANGELOG.md` entry + installer rebuilt, checksummed and\n   independently re-hashed.",
    "6. 3.2.0 version bump **already applied** (`desktop/package.json:3`, package-lock root) — rebuild the\n   installer, checksum it and re-hash independently; `docs/release/CHANGELOG.md` entry present.",
    "checklist item 6: bump already applied",
)
patch(
    DOCS / "release" / "github-publication.md",
    "# 2) version bump is a source change (Lead/T1 owns package.json): 3.2.0, then rebuild\n#    record new exe path/bytes/SHA256 and regenerate SHA256SUMS",
    "# 2) 3.2.0 version bump already applied by the Lead (package.json + package-lock root); rebuild now,\n#    record new exe path/bytes/SHA256 and regenerate SHA256SUMS",
    "procedure comment: bump applied",
)

# ---------------- master CSV: enrich R122 metadata only (status untouched)
master_path = DOCS / "requirements" / "master-requirements.csv"
raw = master_path.read_bytes()
bom = raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8-sig")
rows = list(csv.DictReader(io.StringIO(text)))
fieldnames = list(rows[0].keys())
for row in rows:
    if row["Requirement ID"] == "R122":
        row["IPC/RPC"] = ("daemon events.stream (main-process-only, MAIN_ONLY); main bridge "
                          "window.suwen.call('events.replay', {since,limit}); onConnection states")
        row["Backend Handler"] = ("stream-events.ts collectStreamEvents + daemon dispatch; main.ts polls "
                                  "events.stream, auto-reconnects daemon with bounded backoff 300ms..12s, "
                                  "re-pushes encrypted model config + safeStorage credential refs")
        row["Evidence"] = (row["Evidence"] + "; docs/architecture/streaming-events.md (protocol v1, "
                           "main-process-only + events.replay bridge + onConnection)")
    if row["Requirement ID"] == "R130":
        row["Backend Handler"] = (row.get("Backend Handler", "") + "; main.ts reconnect backoff 300ms..12s "
                                  "with config/credential re-push, onConnection(reconnecting|restored|lost)")
with master_path.open("w", encoding="utf-8-sig" if bom else "utf-8", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
changes.append("docs/requirements/master-requirements.csv: R122/R130 main-bridge metadata (statuses unchanged)")

# ---------------- parity CSV: enrich the typed-protocol row (status untouched)
parity_path = DOCS / "migration" / "feature-parity-matrix.csv"
praw = parity_path.read_bytes()
pbom = praw.startswith(b"\xef\xbb\xbf")
ptext = praw.decode("utf-8-sig")
prows = list(csv.DictReader(io.StringIO(ptext)))
pfields = list(prows[0].keys())
for row in prows:
    if row.get("capability", "").startswith("Typed streaming event protocol"):
        row["vnext_code"] = ("desktop/src/stream-events.ts; shared/contract.ts; daemon.ts events.stream "
                             "(main-process-only); main.ts events.replay bridge + auto-reconnect 300ms..12s; "
                             "docs/architecture/streaming-events.md")
        row["gaps"] = ("Runtime UI matrix pending; replay goes through main bridge "
                       "window.suwen.call('events.replay',{since,limit}); auto-reconnect/onConnection timing "
                       "not measured")
with parity_path.open("w", encoding="utf-8-sig" if pbom else "utf-8", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=pfields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(prows)
changes.append("docs/migration/feature-parity-matrix.csv: typed-protocol row bridge metadata (status untouched)")

# ---------------- traceability: append round-3 bridge clarification section
reconnect_feature = next((r["Feature"] for r in rows if r["Requirement ID"] == "R130"), "")
append(
    DOCS / "requirements" / "traceability.md",
    "\n## 8. Round-3 main-process bridge and streaming protocol (Lead clarification, 2026-10-25)\n\n"
    "Lead-supplied protocol facts incorporated after the first coherent pass (statuses in §3 unchanged):\n\n"
    "1. **`events.stream` is main-process-only** (`desktop/src/main.ts` `MAIN_ONLY` set; renderer cannot call it).\n"
    "2. **Renderer gap replay** goes through the main bridge:\n"
    "   `window.suwen.call('events.replay', {since, limit})` — same response shape as `events.stream`.\n"
    "3. **Daemon auto-reconnect**: the main process reconnects the daemon on crash with bounded backoff\n"
    "   **300 ms…12 s**, re-pushes the encrypted model config + safeStorage credential refs, and emits\n"
    "   `window.suwen.onConnection({state:'reconnecting'|'restored'|'lost'})`.\n"
    "4. Protocol contract: `docs/architecture/streaming-events.md` (main-process-only rule at :10,\n"
    "   polling/backoff at :27-31, replay bridge at :36-37 and gap rule at :103-104).\n\n"
    "Requirement mapping: **R122** (typed protocol; IPC/RPC + Backend Handler columns now name the\n"
    "main bridge), **R123** (ordering/dedupe/reset/gap replay) and **R130**\n"
    f"(\"{reconnect_feature}\") — auto-reconnect/`onConnection` evidence is code-level only and remains\n"
    "UNVERIFIED until T1/T2 runtime evidence lands; **R129–R131** streaming matrix rows stay unchanged.\n"
    "G3 in `docs/release/release-gates.md` references the same facts and remains **UNVERIFIED**.\n"
    "Package version confirmed as **3.2.0** (`desktop/package.json:3`, package-lock root); installer\n"
    "rebuild and SHA256 remain `PENDING_LEAD`.\n",
    "§8 bridge clarification + R122/R123/R130 mapping",
)

# ---------------- progress: append implementation bullet in the round-3 "completed" block
patch(
    DOCS / "progress.md",
    "- **Source inspection for this pass (read-only)**: `desktop/src/stream-events.ts`,",
    "- **Main-process bridge facts (Lead, 2026-10-25; code-level, runtime unverified)**: `events.stream` is\n"
    "  main-process-only; renderer gap replay uses `window.suwen.call('events.replay', {since, limit})`;\n"
    "  the main process auto-reconnects the daemon with bounded backoff **300 ms…12 s**, re-pushes the\n"
    "  encrypted model config + safeStorage credential refs, and emits\n"
    "  `window.suwen.onConnection({state:'reconnecting'|'restored'|'lost'})`. Protocol contract:\n"
    "  `docs/architecture/streaming-events.md`. G3 remains UNVERIFIED until T2 runtime evidence.\n"
    "- **Source inspection for this pass (read-only)**: `desktop/src/stream-events.ts`,",
    "round-3 bridge implementation bullet",
)

# ---------------- CHANGELOG: append bridge bullet after the main-process event bridge bullet
changelog = DOCS / "release" / "CHANGELOG.md"
lines = changelog.read_text(encoding="utf-8").splitlines()
insert_at = None
for i, line in enumerate(lines):
    if line.startswith("- Main-process event bridge:"):
        insert_at = i
        break
if insert_at is None:
    raise SystemExit("CHANGELOG bridge bullet anchor not found")
lines[insert_at + 2:insert_at + 2] = [
    "- Renderer recovery bridge: `events.stream` stays main-process-only; gap replay is the main bridge",
    "  `window.suwen.call('events.replay', {since, limit})`; daemon auto-reconnect uses bounded backoff",
    "  (300 ms…12 s), re-pushes the encrypted model config + safeStorage credential refs, and reports",
    "  `onConnection` states `reconnecting|restored|lost`.",
]
changelog.write_text("\n".join(lines) + "\n", encoding="utf-8")
changes.append("docs/release/CHANGELOG.md: replay/auto-reconnect bullet")

print(f"applied {len(changes)} changes:")
for c in changes:
    print(" -", c)
