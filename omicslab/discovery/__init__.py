"""RSI (Recursive Self-Improvement) discovery subsystem.

Public surface:

- :class:`~omicslab.discovery.ledger.ProjectStore` – durable per-project ledger
  (hypotheses, evidence, insights, rounds, strategy bank, report).
- :class:`~omicslab.discovery.engine.DiscoveryEngine` – the closed research loop
  (observe → hypothesize → prioritize → pre-register → execute → evaluate →
  reflect/report).
- :class:`~omicslab.discovery.evidence.AnalysisResult` – structured analysis
  record (hashes, seed, test, effect size, CI, p/q, execution status, ...).
- :class:`~omicslab.discovery.evidence.EvidenceEvaluator` – the only authority
  that turns structured numbers + pre-registered criteria into a verdict.
- :func:`~omicslab.discovery.tools.register_discovery_tools` – agent tools.
"""

from __future__ import annotations

from .engine import DEFAULT_STRATEGIES, DiscoveryEngine
from .evidence import AnalysisResult, EvidenceEvaluator, REPRODUCIBILITY_LEVELS
from .ledger import ProjectNotFound, ProjectStore

__all__ = [
    "AnalysisResult",
    "DEFAULT_STRATEGIES",
    "DiscoveryEngine",
    "EvidenceEvaluator",
    "ProjectNotFound",
    "ProjectStore",
    "REPRODUCIBILITY_LEVELS",
]
