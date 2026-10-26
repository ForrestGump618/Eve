"""Optional integrations that expose the SuWen agent to external runtimes.

Currently shipped:

``omicslab.integrations.dsh``
    A headless stdio (NDJSON) control plane used by the DeepSeek Harness
    plugin.  It reuses the exact same ``AppState`` / ``AgentLoop`` objects as
    the CLI and the local web workbench, so a DSH session drives the same
    conversations, skills, kernels, memory and discovery ledger that SuWen
    itself uses.  Nothing in this package imports FastAPI/uvicorn, therefore it
    works in a minimal Python environment.
"""

from __future__ import annotations

__all__ = ["dsh"]
