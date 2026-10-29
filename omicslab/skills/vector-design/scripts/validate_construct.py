"""Validate a supplied construct against versioned reference segments and CDS.

No sequence is inferred or optimized. Coordinates are zero-based, half-open;
circular feature ends may exceed sequence length by at most one traversal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


POLICY = {
    "version": 1,
    "io": {"fasta_bytes": 200000, "config_bytes": 100000, "encoding": "utf-8"},
    "resources": {"sequence_bases": 100000, "references": 20, "segments": 100,
                  "features": 100, "id_characters": 100, "junction_flank_bases": 60},
}


def rc(sequence):
    return sequence.translate(str.maketrans("ACGT", "TGCA"))[::-1]


def fasta(path):
    path = Path(path)
    if path.stat().st_size > POLICY["io"]["fasta_bytes"]:
        raise ValueError("FASTA exceeds policy byte budget")
    raw = path.read_bytes()
    lines = raw.decode(POLICY["io"]["encoding"]).splitlines()
    if not lines or not lines[0].startswith(">") or not lines[0][1:].strip() or any(l.startswith(">") for l in lines[1:]):
        raise ValueError("Supply one named FASTA record per reference/construct")
    seq = "".join(l.strip() for l in lines[1:]).upper()
    if not 1 <= len(seq) <= POLICY["resources"]["sequence_bases"] or set(seq) - set("ACGT"):
        raise ValueError("FASTA requires unambiguous DNA within policy length budget")
    return seq, hashlib.sha256(raw).hexdigest()


def interval(start, end, length, circular=False):
    if (type(start) is not int or type(end) is not int or not 0 <= start < length
            or not start < end <= (start + length if circular else length)):
        raise ValueError("Invalid zero-based half-open coordinates")


def identifier(value):
    if not isinstance(value, str) or not 1 <= len(value) <= POLICY["resources"]["id_characters"] or not re.fullmatch(r"[A-Za-z0-9_.-]+", value):
        raise ValueError("IDs require bounded ASCII letters/digits/underscore/dot/hyphen")
    return value


def validate(construct_path, config, base_directory):
    if not isinstance(config, dict) or config.get("topology") not in ("linear", "circular"):
        raise ValueError("Declare linear or circular topology")
    construct, construct_hash = fasta(construct_path)
    length, references, issues = len(construct), {}, []
    if config.get("constructSha256") and config["constructSha256"] != construct_hash:
        raise ValueError("Construct file SHA-256 mismatch")
    ref_inputs = config.get("references")
    if not isinstance(ref_inputs, list) or not 1 <= len(ref_inputs) <= POLICY["resources"]["references"]:
        raise ValueError("Supply versioned references within policy count budget")
    for item in ref_inputs:
        key = identifier(item["id"])
        if key in references or not re.fullmatch(r"[A-Za-z0-9_-]+\.\d+", item.get("accession", "")) or not item.get("source"):
            raise ValueError("References require unique IDs, versioned accessions and explicit sources")
        sequence, digest = fasta(Path(base_directory) / item["path"])
        if item.get("sha256") and item["sha256"] != digest:
            raise ValueError("Reference file SHA-256 mismatch: " + key)
        references[key] = {"sequence": sequence, "fileSha256": digest, "accession": item["accession"], "source": item["source"]}
    segments = config.get("segments")
    if not isinstance(segments, list) or not 1 <= len(segments) <= POLICY["resources"]["segments"]:
        raise ValueError("Supply ordered segments within policy count budget covering the construct")
    end, segment_ids, segment_results = 0, set(), []
    for segment in segments:
        key = identifier(segment["id"])
        if key in segment_ids or segment["reference"] not in references or segment.get("strand") not in ("+", "-"):
            raise ValueError("Segments require unique IDs, known reference and explicit strand")
        segment_ids.add(key)
        sequence = references[segment["reference"]]["sequence"]
        a, b, start, stop = (segment[k] for k in ("sourceStart", "sourceEnd", "start", "end"))
        interval(a, b, len(sequence))
        interval(start, stop, length)
        if start != end or stop - start != b - a:
            raise ValueError("Segments must tile construct without gaps/overlaps and match reference interval lengths")
        expected = sequence[a:b] if segment["strand"] == "+" else rc(sequence[a:b])
        matched = construct[start:stop] == expected
        if not matched:
            issues.append("Reference sequence mismatch: " + key)
        segment_results.append({**segment, "referenceMatched": matched, "sequenceSha256": hashlib.sha256(expected.encode()).hexdigest()})
        end = stop
    if end != length:
        raise ValueError("Segments do not cover the entire construct")
    adjacent = list(zip(segments, segments[1:]))
    if config["topology"] == "circular":
        adjacent.append((segments[-1], segments[0]))
    declared = config.get("junctions")
    if not isinstance(declared, list) or len(declared) != len(adjacent):
        raise ValueError("Declare expected sequence for every adjacent segment junction, including circular closure")
    junction_map = {}
    for junction in declared:
        key = (identifier(junction["left"]), identifier(junction["right"]))
        if key in junction_map:
            raise ValueError("Duplicate junction")
        junction_map[key] = junction
    junction_results = []
    for left, right in adjacent:
        key = (left["id"], right["id"])
        if key not in junction_map:
            raise ValueError("Expected junction IDs do not match construct adjacency")
        j = junction_map[key]
        flank = j.get("flank")
        if type(flank) is not int or not 1 <= flank <= min(POLICY["resources"]["junction_flank_bases"], left["end"] - left["start"], right["end"] - right["start"]):
            raise ValueError("Junction flank exceeds adjacent segments or policy length budget")
        expected = j.get("sequence")
        if not isinstance(expected, str) or len(expected) != flank * 2 or set(expected.upper()) - set("ACGT"):
            raise ValueError("Expected junction sequence must contain exactly 2*flank DNA bases")
        observed = construct[left["end"] - flank:left["end"]] + construct[right["start"]:right["start"] + flank]
        matched = observed == expected.upper()
        if not matched:
            issues.append("Junction sequence mismatch: " + "/".join(key))
        junction_results.append({"left": key[0], "right": key[1], "boundary": left["end"] % length,
                                 "flank": flank, "observedSequence": observed, "matched": matched})
    features = config.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= POLICY["resources"]["features"]:
        raise ValueError("Supply explicit features within policy count budget")
    feature_ids, feature_results = set(), []
    codons = [a + b + c for a in "TCAG" for b in "TCAG" for c in "TCAG"]
    code = dict(zip(codons, "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"))
    for feature in features:
        key = identifier(feature["id"])
        if key in feature_ids or feature.get("strand") not in ("+", "-") or not isinstance(feature.get("type"), str):
            raise ValueError("Features require unique IDs, type and explicit strand")
        feature_ids.add(key)
        start, end = feature["start"], feature["end"]
        interval(start, end, length, config["topology"] == "circular")
        sequence = (construct + construct)[start:end]
        if feature["strand"] == "-":
            sequence = rc(sequence)
        result = {"id": key, "type": feature["type"], "start": start, "end": end, "strand": feature["strand"],
                  "sequenceSha256": hashlib.sha256(sequence.encode()).hexdigest()}
        if "expectedSequence" in feature:
            if not isinstance(feature["expectedSequence"], str):
                raise ValueError("expectedSequence must be DNA text")
            result["expectedSequenceMatched"] = sequence == feature["expectedSequence"].upper()
            if not result["expectedSequenceMatched"]:
                issues.append("Feature sequence mismatch: " + key)
        if feature["type"] == "CDS":
            phase = feature.get("phase")
            if (type(phase) is not int or phase not in (0, 1, 2) or type(feature.get("geneticCode")) is not int
                    or feature["geneticCode"] != 1 or type(feature.get("requireStart")) is not bool
                    or type(feature.get("requireStop")) is not bool):
                raise ValueError("CDS requires phase=0..2, geneticCode=1, boolean requireStart/requireStop")
            coding = sequence[phase:]
            protein = "".join(code[coding[i:i+3]] for i in range(0, len(coding) - 2, 3))
            internal = [i for i, aa in enumerate(protein[:-1] if protein.endswith("*") else protein) if aa == "*"]
            frame_ok = bool(coding) and len(coding) % 3 == 0
            start_ok = not feature["requireStart"] or coding.startswith("ATG")
            stop_ok = not feature["requireStop"] or (frame_ok and coding[-3:] in ("TAA", "TAG", "TGA"))
            protein_ok = "expectedProtein" not in feature or feature["expectedProtein"] == protein
            if not (frame_ok and start_ok and stop_ok and not internal and protein_ok):
                issues.append("CDS frame/start/stop/protein check failed: " + key)
            crossings = []
            for j in junction_results:
                for boundary in (j["boundary"], j["boundary"] + length):
                    offset = (boundary - start if feature["strand"] == "+" else end - boundary) - phase
                    if start < boundary < end and 0 < offset < len(coding):
                        crossings.append({"left": j["left"], "right": j["right"], "boundary": boundary,
                                          "codingOffset": offset, "codonOffset": offset % 3})
            result.update(phase=phase, geneticCode=1, protein=protein, framePassed=frame_ok, startPassed=start_ok,
                          stopPassed=stop_ok, startRequired=feature["requireStart"], stopRequired=feature["requireStop"],
                          internalStopCodons=internal,
                          internalStopCoordinates=[{"codonIndex": i, "genomicBases": [
                              (start + phase + i * 3 + j if feature["strand"] == "+" else end - 1 - phase - i * 3 - j) % length
                              for j in range(3)]} for i in internal],
                          expectedProteinMatched=protein_ok if "expectedProtein" in feature else None,
                          junctionCrossings=crossings)
        feature_results.append(result)
    return {"ok": not issues, "status": "computed" if not issues else "failed", "kind": "construct_validation",
            "evidenceLabel": "computed_reference_and_coordinate_checks", "scientificStatus": "unverified", "policy": POLICY,
            "construct": {"fileSha256": construct_hash, "length": length, "topology": config["topology"]},
            "references": [{"id": k, **{a: b for a, b in v.items() if a != "sequence"}, "sourceVerifiedOnline": False} for k, v in references.items()],
            "coordinates": "zero-based half-open; circular features may end beyond length once",
            "segments": segment_results, "junctions": junction_results, "features": feature_results, "issues": issues,
            "cdsFeaturesChecked": sum(f["type"] == "CDS" for f in feature_results),
            "limits": ["Supplied references/provenance only; no live accession lookup", "Standard genetic code 1 only; no splicing or RNA editing",
                       "No restriction-enzyme compatibility, expression, assembly efficiency, biosafety or wet-lab validation",
                       "Junction codonOffset reports split codons; a nonzero offset alone is not a frameshift"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--construct", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.config.stat().st_size > POLICY["io"]["config_bytes"]:
            raise ValueError("Config exceeds policy byte budget")
        result = validate(args.construct, json.loads(args.config.read_text(encoding=POLICY["io"]["encoding"])), args.config.resolve().parent)
        result["configSha256"] = hashlib.sha256(args.config.read_bytes()).hexdigest()
        result["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        serialized = json.dumps(result, sort_keys=True, allow_nan=False)
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(serialized + "\n")
        print(serialized)
        return 0 if result["ok"] else 2
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(json.dumps({"ok": False, "status": "failed", "error": str(exc), "scientificStatus": "unverified"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
