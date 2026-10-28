"""Bound-host, read-only scientific intake. No dependency installation or shell."""
from __future__ import annotations

import inspect
import json


def inspect_scientific(payload):
    import csv
    import gzip
    import hashlib
    import importlib.util
    import io
    import math
    import pathlib
    import shutil
    import sys

    root = pathlib.Path(payload["workspace"]).resolve(strict=True)
    kind = payload.get("kind")
    if kind == "environment":
        modules = ["numpy", "pandas", "scipy", "matplotlib", "scanpy", "anndata",
                   "scvi", "Bio", "rdkit", "allotropy", "pysam", "pydeseq2", "torch"]
        tools = ["uv", "Rscript", "nextflow", "docker", "singularity", "apptainer",
                 "fastqc", "multiqc", "fastp", "samtools", "STAR", "salmon",
                 "bcftools", "bedtools", "blastn", "mafft", "iqtree", "sbatch"]
        def present(name):
            try:
                return importlib.util.find_spec(name) is not None
            except (ValueError, ImportError, ModuleNotFoundError):
                return False
        return {"kind": kind, "workspace": str(root), "python": sys.version.split()[0],
                "modules": {k: present(k) for k in modules},
                "tools": {k: bool(shutil.which(k)) for k in tools},
                "status": "inspected", "executedAnalysis": False,
                "note": "Presence in the selected host kernel/PATH only; isolated uv environments and functional correctness are not tested."}
    if kind not in {"fasta", "fastq", "counts", "structure"}:
        raise ValueError("Unknown scientific inspection")
    value = payload.get("path")
    if not isinstance(value, str) or not value or len(value) > 1000 or "\0" in value:
        raise ValueError("A workspace file path is required")
    path = (root / value).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Scientific input must be a file in the bound workspace")
    if path.stat().st_size > 20_000_000:
        raise ValueError("Preview input exceeds 20 MB; use the scientific skill for full analysis")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if path.suffix.lower() == ".gz":
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
            data = stream.read(5_000_001)
    else:
        data = raw
    if len(data) > 5_000_000:
        raise ValueError("Decoded input exceeds 5 MB; use the scientific skill for full analysis")
    text = data.decode("utf-8-sig")
    if not text.strip() or "\0" in text:
        raise ValueError("Input is empty or not scientific text")
    result = {"kind": kind, "path": value, "workspace": str(root), "sha256": digest,
              "bytes": len(raw), "status": "inspected", "scientificStatus": "unverified"}
    if kind == "fasta":
        records = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if len(records) >= 50:
                    raise ValueError("FASTA preview supports at most 50 records")
                records.append({"id": line[1:][:200], "sequence": ""})
            elif records and line.isascii() and all(c.isalpha() or c in "-.*" for c in line):
                records[-1]["sequence"] += line.upper()
            else:
                raise ValueError("Malformed FASTA record")
        if not records or any(not r["id"] or not r["sequence"] for r in records):
            raise ValueError("FASTA has no complete named sequence")
        budget = 8000
        for record in records:
            sequence = record["sequence"]
            preview = sequence[:min(2000, budget)]
            budget -= len(preview)
            dna = set(sequence) <= set("ACGTUNRYKMSWBDHV-.*")
            record.update(length=len(sequence), alphabet="nucleotide" if dna else "protein",
                          gcFraction=(sequence.count("G") + sequence.count("C")) / len(sequence) if dna else None,
                          sequence=preview, previewTruncated=len(sequence) > len(preview))
        return {**result, "records": records, "equalLengths": len({r["length"] for r in records}) == 1,
                "note": "Equal lengths do not establish biological alignment; gaps and symbols are retained."}
    if kind == "fastq":
        lines = text.splitlines()
        if len(lines) % 4:
            raise ValueError("Incomplete FASTQ record (four-line FASTQ required)")
        count, bases, gc, n, q30, total_q = 0, 0, 0, 0, 0, 0
        lengths = []
        for i in range(0, len(lines), 4):
            header, sequence, plus, quality = lines[i:i+4]
            sequence = sequence.upper()
            if (not header.startswith("@") or not plus.startswith("+") or not sequence
                    or len(sequence) != len(quality) or set(sequence) - set("ACGTN")
                    or any(not 33 <= ord(c) <= 126 for c in quality)):
                raise ValueError(f"Malformed FASTQ record {i//4+1}")
            qs = [ord(c)-33 for c in quality]
            count += 1
            bases += len(sequence)
            lengths.append(len(sequence))
            gc += sequence.count("G")+sequence.count("C")
            n += sequence.count("N")
            q30 += sum(q >= 30 for q in qs)
            total_q += sum(qs)
        return {**result, "reads": count, "bases": bases, "lengthMin": min(lengths),
                "lengthMax": max(lengths), "gcFraction": gc/bases, "nFraction": n/bases,
                "q30Fraction": q30/bases, "meanPhred": total_q/bases,
                "qualityEncoding": "Phred+33 assumed; user must confirm",
                "note": "Input integrity and basic quality only; not adapter, duplication, contamination or assay validation."}
    if kind == "structure":
        atoms = []
        for line in text.splitlines():
            if line.startswith("ENDMDL"):
                break  # Only first structural model.
            if not line.startswith(("ATOM  ", "HETATM")):
                continue
            if len(line) < 54:
                raise ValueError("Truncated PDB atom")
            if line[16] not in {" ", "A"}:
                continue
            try:
                coords = [float(line[a:b]) for a, b in [(30, 38), (38, 46), (46, 54)]]
                if not all(math.isfinite(v) for v in coords):
                    raise ValueError()
            except ValueError:
                raise ValueError("Invalid PDB coordinates") from None
            atoms.append({"name": line[12:16].strip(), "residue": line[17:20].strip(),
                          "chain": line[21], "position": line[22:27].strip(), "xyz": coords,
                          "element": line[76:78].strip() if len(line) >= 78 else ""})
            if len(atoms) > 5000:
                raise ValueError("PDB preview limit is 5000 atoms; use a structure skill for larger structures")
        if not atoms:
            raise ValueError("No atoms in PDB input; mmCIF requires conversion")
        return {**result, "atoms": atoms[:180], "atomCount": len(atoms), "previewTruncated": len(atoms) > 180,
                "model": "first", "note": "Coordinate preview; no inferred bonds or structure-quality validation."}
    rows = csv.reader(io.StringIO(text), delimiter="\t" if "\t" in text.splitlines()[0] else ",")
    header = next(rows)
    if not 3 <= len(header) <= 201 or len(set(header)) != len(header) or any(not h.strip() for h in header):
        raise ValueError("Counts require a feature column and at least two uniquely named sample columns")
    totals = [0.0] * (len(header)-1)
    zeros, count, seen, preview = 0, 0, set(), []
    for row in rows:
        if not row:
            continue
        if len(row) != len(header) or not row[0].strip() or row[0] in seen:
            raise ValueError("Counts have duplicate features or inconsistent columns")
        seen.add(row[0])
        try:
            values = [float(v) for v in row[1:]]
        except ValueError:
            raise ValueError("Counts contain nonnumeric values") from None
        if any(not math.isfinite(v) or v < 0 or not v.is_integer() for v in values):
            raise ValueError("Raw counts must be finite nonnegative integers")
        totals = [a+b for a, b in zip(totals, values)]
        zeros += sum(v == 0 for v in values)
        count += 1
        if len(preview) < 10:
            preview.append([row[0], *values])
    if not count:
        raise ValueError("Counts have no features")
    return {**result, "features": count, "samples": header[1:], "librarySizes": totals,
            "zeroFraction": zeros/(count*len(totals)), "preview": preview,
            "note": "No differential expression without sample groups, biological replication and design/covariates."}


def runtime_source(workspace: str, arguments: dict) -> str:
    if set(arguments) - {"kind", "path"}:
        raise ValueError("Unexpected scientific inspection argument")
    payload = {"workspace": workspace, **arguments}
    return inspect.getsource(inspect_scientific) + "\nprint(__import__('json').dumps(inspect_scientific(" + repr(payload) + ")))\n"
