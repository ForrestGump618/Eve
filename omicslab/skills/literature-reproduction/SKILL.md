---
name: literature-reproduction
description: Reproduce a paper's analysis from the original methods, data, code and parameters, then audit whether the reported conclusion follows.
when_to_use: Use for deep literature review, method reproduction, result verification, or claims that require primary-source evidence.
---
# Literature reproduction

1. Identify the exact paper, version, DOI/PMID, datasets, code repository and supplements.
2. Build a claims table: claim, figure/table, input data, method, parameter, expected output, limitation.
3. Retrieve the primary text and data documentation. Never treat a search snippet as evidence.
4. Reproduce one minimal result first, recording environment, package versions, random seeds and command output.
5. Compare generated values and figures with the paper; report tolerances and irreproducible steps.
6. Separate reproduced, partially reproduced, contradicted and untested claims. Do not call a visual match scientific validation.
