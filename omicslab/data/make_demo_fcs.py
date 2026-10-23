#!/usr/bin/env python
"""Generate ``demo.fcs``: a small synthetic FCS 3.1 flow-cytometry file.

The file mimics a 5-channel, 3-population PBMC-like acquisition so that the
``flow-cytometry`` skill, the ``flow-cytometrist`` agent and the unit tests can
exercise real parsing / compensation / gating without shipping clinical data.

Channels (PnN / PnS)
    1. FSC-A / FSC-A   forward scatter          (linear, a.u.)
    2. SSC-A / SSC-A   side scatter             (linear, a.u.)
    3. FL1-A / CD3     FITC anti-CD3            (logicle-friendly intensities)
    4. FL2-A / CD19    PE anti-CD19             (logicle-friendly intensities)
    5. FL3-A / CD14    APC anti-CD14            (logicle-friendly intensities)

Populations (6,000 events by default)
    lymphocytes   ~45%  low SSC, CD3+ (T cells) and CD19+ (B cells)
    monocytes     ~22%  mid FSC/SSC, CD14 bright
    granulocytes  ~33%  high SSC, CD14 dim

A lower-triangular spillover matrix (FL1 -> FL2, FL1 -> FL3, FL2 -> FL3) is
written as ``$SPILLOVER`` so that compensation can be demonstrated.  FlowKit
exposes it as ``sample.metadata["spillover"]``::

    import flowkit as fk
    sample = fk.Sample("demo.fcs")
    spill = sample.metadata.get("spillover")
    sample.apply_compensation(spill)
    sample.apply_transform(fk.generate_transforms(sample))

Requirements
    pip install flowio numpy        # flowio >= 1.3 writes FCS 3.1
    pip install flowkit            # optional, only needed for compensation demo

Usage
    python make_demo_fcs.py                 # writes demo.fcs next to this file
    python make_demo_fcs.py --out x.fcs --events 20000 --seed 7
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np

# Spillover matrix, rows = source fluorochrome, columns = detector.
# observed = true @ SPILL; compensation multiplies by inv(SPILL).
SPILL = np.array(
    [
        [1.00, 0.12, 0.05],  # FL1 (CD3 FITC) leaks into FL2 and FL3
        [0.00, 1.00, 0.20],  # FL2 (CD19 PE) leaks into FL3
        [0.00, 0.00, 1.00],
    ],
    dtype=np.float64,
)
SPILL_CHANNELS = ["FL1-A", "FL2-A", "FL3-A"]

CHANNELS = ["FSC-A", "SSC-A", "FL1-A", "FL2-A", "FL3-A"]
MARKERS = ["FSC-A", "SSC-A", "CD3", "CD19", "CD14"]


def simulate_events(n_events: int, seed: int = 42) -> tuple[np.ndarray, np.ndarray]:
    """Return (event_matrix n x 5, population_label n)."""
    rng = np.random.default_rng(seed)
    n_lym = int(round(n_events * 0.45))
    n_mono = int(round(n_events * 0.22))
    n_gran = n_events - n_lym - n_mono

    # --- lymphocytes: split into T (CD3+), B (CD19+), double negative ---
    lym_true = np.zeros((n_lym, 3))
    is_t = rng.random(n_lym) < 0.60
    is_b = (~is_t) & (rng.random(n_lym) < 0.60)
    lym_true[is_t, 0] = rng.normal(2400, 480, is_t.sum())   # CD3
    lym_true[is_b, 1] = rng.normal(1900, 420, is_b.sum())   # CD19
    lym_true[:, 2] = rng.normal(120, 70, n_lym)             # CD14
    lym = np.column_stack(
        [
            rng.normal(35000, 3500, n_lym),   # FSC
            rng.normal(9000, 2000, n_lym),    # SSC
            lym_true,
        ]
    )

    # --- monocytes: CD14 bright ---
    mono = np.column_stack(
        [
            rng.normal(55000, 4000, n_mono),
            rng.normal(26000, 4000, n_mono),
            rng.normal(130, 80, n_mono),
            rng.normal(120, 70, n_mono),
            rng.normal(2100, 450, n_mono),
        ]
    )

    # --- granulocytes: high SSC, CD14 dim ---
    gran = np.column_stack(
        [
            rng.normal(68000, 6000, n_gran),
            rng.normal(62000, 8000, n_gran),
            rng.normal(140, 90, n_gran),
            rng.normal(110, 70, n_gran),
            rng.normal(550, 250, n_gran),
        ]
    )

    events = np.vstack([lym, mono, gran])
    labels = np.array(
        ["lymphocyte"] * n_lym + ["monocyte"] * n_mono + ["granulocyte"] * n_gran
    )

    # detector cross-talk on the three fluorescence channels
    events[:, 2:5] = events[:, 2:5] @ SPILL

    # instrument noise + negative-value cut (logicle needs the negative region)
    events[:, 2:5] += rng.normal(0, 12, (events.shape[0], 3))
    events = np.clip(events, 0, None)
    events = np.round(events, 3).astype(np.float32)

    order = rng.permutation(events.shape[0])
    return events[order], labels[order]


def spillover_string() -> str:
    """FCS ``$SPILLOVER`` value: n,ch1..chn, m11..mnn (row-major)."""
    rows = ",".join(f"{v:g}" for v in SPILL.ravel())
    return f"{len(SPILL_CHANNELS)}," + ",".join(SPILL_CHANNELS) + "," + rows


def write_fcs(path: Path, events: np.ndarray, seed: int) -> None:
    import flowio  # imported lazily so --help works without the dependency

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        flowio.create_fcs(
            fh,
            events.ravel().tolist(),
            CHANNELS,
            opt_channel_names=MARKERS,
            metadata_dict={
                "$CYT": "OmicsLab-Synthetic",
                "$SRC": "make_demo_fcs.py",
                "$SPILLOVER": spillover_string(),
            },
        )
    # flowio cannot take a seed; note it in a companion file for reproducibility
    (path.parent / (path.stem + ".provenance.txt")).write_text(
        f"generator=make_demo_fcs.py\nseed={seed}\nevents={events.shape[0]}\n"
        f"channels={len(CHANNELS)}\nspillover={spillover_string()}\n",
        encoding="utf-8",
    )


def verify(path: Path) -> None:
    """Re-read the file and print a compact QC summary."""
    import flowio

    fd = flowio.FlowData(path)
    print(f"file      : {path} ({path.stat().st_size:,} bytes)")
    print(f"version   : FCS {fd.version}")
    print(f"events    : {fd.event_count} x {fd.channel_count} channels")
    print(f"PnN       : {fd.pnn_labels}")
    print(f"PnS       : {fd.pns_labels}")
    spill_key = next((k for k in fd.text if "spill" in k), None)
    print(f"spill key : {spill_key}")
    data = np.asarray(fd.events).reshape(fd.event_count, fd.channel_count)
    print("channel medians:", np.round(np.median(data, axis=0), 1).tolist())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).with_name("demo.fcs"),
        help="output FCS path (default: demo.fcs next to this script)",
    )
    parser.add_argument("--events", type=int, default=6000, help="number of events")
    parser.add_argument("--seed", type=int, default=42, help="random seed")
    args = parser.parse_args()

    events, labels = simulate_events(args.events, args.seed)
    write_fcs(args.out, events, args.seed)
    verify(args.out)

    counts = {k: int((labels == k).sum()) for k in np.unique(labels)}
    print("populations:", counts)
    print("done. try:  fk.Sample('%s').metadata['spillover']" % os.fspath(args.out))


if __name__ == "__main__":
    main()
