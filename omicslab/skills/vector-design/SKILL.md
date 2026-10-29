---
name: vector-design
description: Turn a biological expression or cloning goal into a traceable vector map and cloning plan with regulatory elements, junctions and validation checks.
when_to_use: Use for plasmid/vector design, cloning strategy, construct review, or an ordering-ready experimental plan.
---
# Vector design

Capture host, cargo, promoter, tag, localization, selection, backbone, cloning method, biosafety constraints and expected expression. Use an accessioned backbone sequence when available. Emit a feature table, junction sequences, reading-frame checks, restriction/assembly conflicts, control constructs, sequencing primers and a validation checklist. Mark unknown backbone sequence and all wet-lab assumptions explicitly.

## Optional local construct validator

Run `python scripts/validate_construct.py --construct construct.fa --config construct.json` from this skill directory. This standard-library CLI checks actual ACGT sequences; it never generates a backbone or invents features. It remains outside the compressed JS skill bundle.

The JSON contract declares `topology` (`linear` or `circular`), `references: [{id, path, accession, source, sha256?}]` (paths relative to the config; versioned accession), and ordered `segments: [{id, reference, sourceStart, sourceEnd, strand, start, end}]` tiling the entire construct. Each segment must match its reference interval, reverse-complemented for strand `-`. Declare every adjacency as `junctions: [{left, right, flank, sequence}]`, including circular closure; sequence is the expected last/first `flank` bases across that boundary. `features: [{id, type, start, end, strand, expectedSequence?}]` checks actual coordinates.

CDS features additionally require `phase` (0..2 bases skipped from the oriented 5-prime end), `geneticCode: 1`, `requireStart` and `requireStop` booleans; optional `expectedProtein` includes a terminal `*` when present. The tool translates both strands, rejects incomplete frames/internal stops and unmet start/stop/protein expectations, and reports coding offsets at crossed junctions. Coordinates are zero-based, half-open; circular features use an unwrapped end greater than length for a single origin crossing. A split codon at a junction alone does not imply a frameshift.

JSON results include source hashes, observed junctions, reference matches, translated CDS and explicit limits. Optional `--output` creates a new file. Exit 2 marks invalid input or failed checks. This validates supplied references and coordinates only; it does not verify accession existence, restriction-enzyme compatibility, expression, assembly efficiency or wet-lab success. A construct without CDS has no reading-frame validation.

The script's named `POLICY` mapping centralizes IO/resource ceilings and is included in the result; coordinates, topology, reference provenance, junction expectations and feature/CDS requirements come from the input config. The optional Eve supplement pack may expose this same source script through the existing scientific runtime; it does not replace imported DeepMind skills.
