---
name: primer-design
description: Design and review PCR/qPCR primers with explicit sequence provenance, amplicon constraints, specificity checks and ordering-ready output.
when_to_use: Use when a user requests primer design, qPCR assay planning, amplicon validation or primer review.
---
# Primer design

Require the target accession/version, organism, transcript or exon boundaries, product size, chemistry, and intended assay. Retrieve the reference sequence from a primary database. Report every candidate's sequence, length, Tm method, GC%, product coordinates, hairpin/dimer warnings, off-target search status and unresolved checks. Treat candidates as design proposals until a specificity search and wet-lab validation are completed. Never infer a sequence from a gene symbol alone.

## Optional local CLI

Run `python scripts/primer_check.py check --reference target.fa --config assay.json` from this skill directory. `design` and `--thermodynamics` use real optional `primer3-py`; absence fails explicitly and no Tm estimate is substituted. No installation or network request occurs automatically. See [Primer3 API](https://libnano.github.io/primer3-py/api/bindings.html).

Config contains `reference: {accession: "SYNTHETIC.1", source: "synthetic fixture"}`, integer `minProduct`/`maxProduct`, and `pairs: [{id, forward, reverse, forwardTail?, reverseTail?, expected?: {start, end, strand}}]`. Oligos are 5-prime-to-3-prime ACGT annealing cores; optional tails are separate. Coordinates are zero-based, half-open on one linear FASTA. The checker enumerates non-overlapping exact products in both orientations and reports GC and tailed-product hashes. It does not establish whole-genome specificity, mismatch tolerance or wet-lab performance; missing Tm remains null.

Primer3 modes also require explicit `chemistry: {mv_conc: 50, dv_conc: 1.5, dntp_conc: 0.6, dna_conc: 50, temp_c: 37}` (salts/dNTP in mM; DNA in nM; temperature in Celsius). `design` accepts `numReturn` (1..10), reports Primer3 version and fixed design constraints, and checks returned primers against the same reference. Thermodynamic values are calculations, not assay acceptance thresholds. Optional `--output` creates a new JSON file; exit 2 means invalid input, unavailable dependency, or failed local checks. These scripts are optional workspace tools, outside the compressed JS skill bundle.

The script's named `POLICY` mapping defines IO/resource ceilings, chemistry bounds, design defaults and supported overrides. `design: {minSize, optSize, maxSize, minTm, optTm, maxTm, minGc, maxGc, maxPolyX, maxPairTmDiff}` may override defaults within those bounds; inconsistent or unknown options fail. Effective Primer3 settings and policy are included in the result. These source scripts may also be imported by the separate Eve supplement pack; the original DeepMind skill remains separate.
