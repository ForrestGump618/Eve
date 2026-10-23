"""Workspace registry, binding and scope resolution."""

from .service import (
    DEFAULT_WORKSPACE_ID,
    STATUSES,
    Workspace,
    WorkspaceError,
    WorkspaceService,
)

# The execution backends receive a ``WorkspaceContext``; it is the same record.
WorkspaceContext = Workspace

__all__ = [
    "DEFAULT_WORKSPACE_ID",
    "STATUSES",
    "Workspace",
    "WorkspaceContext",
    "WorkspaceError",
    "WorkspaceService",
]
