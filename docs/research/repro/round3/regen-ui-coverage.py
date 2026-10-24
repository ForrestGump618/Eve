# -*- coding: utf-8 -*-
"""Regenerate docs/verification/ui-action-coverage.csv from actions.json (file was truncated by a bad patch)."""
import importlib.util, sys
from pathlib import Path

ROOT = Path(r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext")
sys.path.insert(0, str(ROOT / "docs" / "research" / "repro" / "round3"))
spec = importlib.util.spec_from_file_location("round3data", ROOT / "docs" / "research" / "repro" / "round3" / "round3-data.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

rows, counts = mod.ui_coverage()
for r in rows:
    r["evidence"] = ("desktop/ui/actions.json (144 actions) + contract.ts RPC_METHODS 81 + "
                     "node scripts/ui-dom-qa.mjs -> 19 passed / 0 failed / 12 warnings (Lead run 2026-10-25)")
    r["runtime_verified"] = ("not individually click-through-recorded; covered by ui-dom-qa.mjs and "
                             "T2 streaming/visual suites (docs/verification/ui-e2e.md, ui-visual-audit.md)")
mod.write_csv(mod.UI_COV, rows, list(rows[0].keys()))
print("regenerated", mod.UI_COV, len(rows), "rows", counts)
