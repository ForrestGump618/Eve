"""Bounded linear-reference primer checks and optional real Primer3 design.

All positions are zero-based, half-open on the supplied FASTA. Exact local
matches are not genome-wide specificity evidence. No dependency is installed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import math
from pathlib import Path
import re


POLICY = {
    "version": 1,
    "io": {"reference_bytes": 200000, "config_bytes": 100000, "encoding": "utf-8"},
    "resources": {"reference_bases": 100000, "design_template_bases": 20000, "pairs": 20,
                  "id_characters": 100, "binding_sites_per_oligo": 200, "products": 1000,
                  "core_min_bases": 8, "core_max_bases": 60, "tail_max_bases": 40,
                  "thermodynamic_oligo_bases": 60, "design_pairs": 10},
    "defaults": {"min_product": 100, "max_product": 1000, "design_pairs": 3},
    "chemistry_ranges": {"mv_conc": (0, 10000), "dv_conc": (0, 10000), "dntp_conc": (0, 10000),
                         "dna_conc": (0.01, 10000), "temp_c": (0, 100)},
    "design_options": {
        "minSize": ("PRIMER_MIN_SIZE", 18, 8, 60, True),
        "optSize": ("PRIMER_OPT_SIZE", 20, 8, 60, True),
        "maxSize": ("PRIMER_MAX_SIZE", 25, 8, 60, True),
        "minTm": ("PRIMER_MIN_TM", 57, -20, 100, False),
        "optTm": ("PRIMER_OPT_TM", 60, -20, 100, False),
        "maxTm": ("PRIMER_MAX_TM", 63, -20, 100, False),
        "minGc": ("PRIMER_MIN_GC", 20, 0, 100, False),
        "maxGc": ("PRIMER_MAX_GC", 80, 0, 100, False),
        "maxPolyX": ("PRIMER_MAX_POLY_X", 5, 1, 100, True),
        "maxPairTmDiff": ("PRIMER_PAIR_MAX_DIFF_TM", 100, 0, 100, False),
    },
}


def dna(value, label, minimum=1, maximum=None):
    maximum = POLICY["resources"]["reference_bases"] if maximum is None else maximum
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or set(value.upper()) - set("ACGT"):
        raise ValueError(f"{label} requires {minimum}..{maximum} unambiguous DNA bases")
    return value.upper()


def reverse_complement(value):
    return value.translate(str.maketrans("ACGT", "TGCA"))[::-1]


def load_reference(path):
    path = Path(path)
    if path.stat().st_size > POLICY["io"]["reference_bytes"]:
        raise ValueError("Reference exceeds policy byte budget")
    raw = path.read_bytes()
    lines = raw.decode(POLICY["io"]["encoding"]).splitlines()
    if not lines or not lines[0].startswith(">") or not lines[0][1:].strip() or any(l.startswith(">") for l in lines[1:]):
        raise ValueError("Supply exactly one named FASTA record")
    sequence = dna("".join(l.strip() for l in lines[1:]), "Reference")
    return sequence, {"record": lines[0][1:], "fileSha256": hashlib.sha256(raw).hexdigest(),
                      "sequenceSha256": hashlib.sha256(sequence.encode()).hexdigest(), "length": len(sequence)}


def number(value, low, high, label, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"Invalid {label}: expected {low}..{high}")
    return value


def primer3_engine():
    try:
        return importlib.import_module("primer3")
    except ImportError as exc:
        raise ValueError("primer3-py is required for design/thermodynamics; install it explicitly in an optional environment. No Tm was calculated.") from exc


def chemistry(config):
    values = config.get("chemistry")
    if not isinstance(values, dict) or set(values) != set(POLICY["chemistry_ranges"]):
        raise ValueError("Declare chemistry: mv_conc/dv_conc/dntp_conc in mM, dna_conc in nM, temp_c in Celsius")
    return {k: number(v, *POLICY["chemistry_ranges"][k], k)
            for k, v in values.items()}


def design_options(config):
    overrides = config.get("design", {})
    options = POLICY["design_options"]
    if not isinstance(overrides, dict) or set(overrides) - options.keys():
        raise ValueError("Unknown design option; use names from POLICY.design_options")
    values = {key: number(overrides.get(key, default), low, high, key, integer)
              for key, (_, default, low, high, integer) in options.items()}
    if (not values["minSize"] <= values["optSize"] <= values["maxSize"]
            or not values["minTm"] <= values["optTm"] <= values["maxTm"] or values["minGc"] > values["maxGc"]):
        raise ValueError("Design minimum/optimum/maximum settings are inconsistent")
    return {options[key][0]: value for key, value in values.items()}


def positions(sequence, oligo):
    result, start = [], 0
    while True:
        start = sequence.find(oligo, start)
        if start < 0:
            return result
        result.append(start)
        if len(result) > POLICY["resources"]["binding_sites_per_oligo"]:
            raise ValueError("Too many exact binding sites; local search is incomplete")
        start += 1


def oligo_metrics(core, tail, engine, conditions):
    full = tail + core
    result = {"core": core, "tail": tail, "orderSequence": full, "coreLength": len(core),
              "gcPercent": 100 * (core.count("G") + core.count("C")) / len(core),
              "tmCelsius": None, "tmMethod": "not_calculated"}
    if engine:
        tm_args = {k: v for k, v in conditions.items() if k != "temp_c"}
        result.update(tmCelsius=engine.calc_tm(core, **tm_args, tm_method="santalucia", salt_corrections_method="santalucia"),
                      tmMethod="primer3 SantaLucia nearest-neighbor on annealing core",
                      fullOligoHairpinTmCelsius=engine.calc_hairpin(full, **conditions).tm,
                      fullOligoHomodimerTmCelsius=engine.calc_homodimer(full, **conditions).tm)
    return result


def analyze(reference, config, mode="check", thermodynamics=False):
    if not isinstance(config, dict):
        raise ValueError("Config must be an object")
    provenance = config.get("reference")
    if (not isinstance(provenance, dict) or not isinstance(provenance.get("accession"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+\.\d+", provenance["accession"])
            or not isinstance(provenance.get("source"), str) or not provenance["source"].strip()):
        raise ValueError("Declare versioned reference accession and source; synthetic fixtures must be labeled")
    sequence, source = load_reference(reference)
    if provenance.get("sha256") and provenance["sha256"] != source["fileSha256"]:
        raise ValueError("Reference file SHA-256 mismatch")
    source.update(accession=provenance["accession"], source=provenance["source"], sourceVerifiedOnline=False)
    low = number(config.get("minProduct", POLICY["defaults"]["min_product"]), 1, POLICY["resources"]["reference_bases"], "minProduct", True)
    high = number(config.get("maxProduct", POLICY["defaults"]["max_product"]), low, POLICY["resources"]["reference_bases"], "maxProduct", True)
    engine = primer3_engine() if thermodynamics or mode == "design" else None
    conditions = chemistry(config) if engine else None
    design = None
    design_settings = None
    pairs = config.get("pairs")
    if mode == "design":
        if len(sequence) > POLICY["resources"]["design_template_bases"]:
            raise ValueError("Primer3 design exceeds policy template budget")
        count = number(config.get("numReturn", POLICY["defaults"]["design_pairs"]), 1, POLICY["resources"]["design_pairs"], "numReturn", True)
        design_settings = {
            "PRIMER_TASK": "generic", "PRIMER_PICK_LEFT_PRIMER": 1, "PRIMER_PICK_RIGHT_PRIMER": 1,
            "PRIMER_NUM_RETURN": count, "PRIMER_PRODUCT_SIZE_RANGE": [[low, high]],
            **design_options(config), "PRIMER_TM_FORMULA": 1, "PRIMER_SALT_CORRECTIONS": 1,
            "PRIMER_SALT_MONOVALENT": conditions["mv_conc"], "PRIMER_SALT_DIVALENT": conditions["dv_conc"],
            "PRIMER_DNTP_CONC": conditions["dntp_conc"], "PRIMER_DNA_CONC": conditions["dna_conc"],
        }
        design = engine.bindings.design_primers({"SEQUENCE_ID": source["accession"], "SEQUENCE_TEMPLATE": sequence}, design_settings)
        if design.get("PRIMER_ERROR") or not design.get("PRIMER_PAIR_NUM_RETURNED"):
            raise ValueError("Primer3 returned no candidate pairs: " + str(design.get("PRIMER_ERROR") or design.get("PRIMER_PAIR_EXPLAIN", "constraints unsatisfied")))
        pairs = [{"id": f"primer3-{i}", "forward": design[f"PRIMER_LEFT_{i}_SEQUENCE"],
                  "reverse": design[f"PRIMER_RIGHT_{i}_SEQUENCE"]} for i in range(design["PRIMER_PAIR_NUM_RETURNED"])]
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= POLICY["resources"]["pairs"]:
        raise ValueError("Primer pair count exceeds policy bounds")
    results, ids, total_products = [], set(), 0
    for pair in pairs:
        if not isinstance(pair, dict) or not isinstance(pair.get("id"), str) or not 1 <= len(pair["id"]) <= POLICY["resources"]["id_characters"] or pair["id"] in ids:
            raise ValueError("Primer pair IDs must be bounded and unique")
        ids.add(pair["id"])
        forward, reverse = (dna(pair.get(k), k, POLICY["resources"]["core_min_bases"], POLICY["resources"]["core_max_bases"]) for k in ("forward", "reverse"))
        tails = [dna(pair[k], k, 1, POLICY["resources"]["tail_max_bases"]) if pair.get(k) else "" for k in ("forwardTail", "reverseTail")]
        if engine and any(len(tail + core) > POLICY["resources"]["thermodynamic_oligo_bases"] for tail, core in zip(tails, (forward, reverse))):
            raise ValueError("Full oligo thermodynamics exceeds policy length budget")
        products = []
        sites = {"forwardPlus": positions(sequence, forward), "forwardMinus": positions(sequence, reverse_complement(forward)),
                 "reversePlus": positions(sequence, reverse), "reverseMinus": positions(sequence, reverse_complement(reverse))}
        for strand, left, right, left_len, right_len in (
                ("+", sites["forwardPlus"], sites["reverseMinus"], len(forward), len(reverse)),
                ("-", sites["reversePlus"], sites["forwardMinus"], len(reverse), len(forward))):
            for start in left:
                for rstart in right:
                    end = rstart + right_len
                    if start + left_len <= rstart and low <= end - start <= high:
                        amplified = sequence[start:end] if strand == "+" else reverse_complement(sequence[start:end])
                        product = tails[0] + amplified + reverse_complement(tails[1])
                        products.append({"start": start, "end": end, "strand": strand, "templateLength": end - start,
                                         "leftBinding": [start, start + left_len], "rightBinding": [rstart, end],
                                         "tailedProductLength": len(product), "tailedProductSha256": hashlib.sha256(product.encode()).hexdigest()})
                        total_products += 1
                        if total_products > POLICY["resources"]["products"]:
                            raise ValueError("Amplicon budget exceeded; no complete local result")
        expected = pair.get("expected")
        expected_match = None
        if expected is not None:
            if (not isinstance(expected, dict) or set(expected) != {"start", "end", "strand"}
                    or type(expected["start"]) is not int or type(expected["end"]) is not int
                    or not 0 <= expected["start"] < expected["end"] <= len(sequence) or expected["strand"] not in ("+", "-")):
                raise ValueError("Expected product requires valid zero-based start/end/strand")
            expected_match = any(all(p[k] == expected[k] for k in expected) for p in products)
        item = {"id": pair["id"], "forward": oligo_metrics(forward, tails[0], engine, conditions),
                "reverse": oligo_metrics(reverse, tails[1], engine, conditions), "bindingSites": sites,
                "products": products, "expectedProductFound": expected_match,
                "localExactProductCount": len(products), "localCheckPassed": bool(products) and expected_match is not False}
        if engine:
            item["fullOligoHeterodimerTmCelsius"] = engine.calc_heterodimer(tails[0] + forward, tails[1] + reverse, **conditions).tm
        results.append(item)
    ok = all(r["localCheckPassed"] for r in results)
    version = getattr(engine, "__version__", None) if engine else None
    if engine and not version:
        version = importlib.metadata.version("primer3-py")
    return {"ok": ok, "status": "computed" if ok else "failed", "kind": "primer_reference_check",
            "evidenceLabel": "computed_local_exact_matches", "scientificStatus": "unverified", "mode": mode,
            "reference": source, "coordinates": "zero-based half-open on supplied linear FASTA",
            "chemistry": conditions, "primer3Version": version, "pairs": results,
            "designSettings": design_settings, "policy": POLICY,
            "designExplain": {k: v for k, v in (design or {}).items() if k.endswith("EXPLAIN")},
            "specificity": {"status": "not_established", "scope": "Exact ACGT matches on this single linear reference only; both product orientations, non-overlapping primer sites, declared product range.",
                            "unperformed": ["mismatch/indel/3-prime off-target screening", "genome/transcriptome and paralog search", "circular templates", "wet-lab validation"]}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "design"))
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--thermodynamics", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.config.stat().st_size > POLICY["io"]["config_bytes"]:
            raise ValueError("Config exceeds policy byte budget")
        config = json.loads(args.config.read_text(encoding=POLICY["io"]["encoding"]))
        result = analyze(args.reference, config, args.mode, args.thermodynamics)
        result["configSha256"] = hashlib.sha256(args.config.read_bytes()).hexdigest()
        result["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        serialized = json.dumps(result, sort_keys=True, allow_nan=False)
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(serialized + "\n")
        print(serialized)
        return 0 if result["ok"] else 2
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as exc:
        print(json.dumps({"ok": False, "status": "failed", "error": str(exc), "scientificStatus": "unverified"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
