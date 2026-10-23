"""Shared Jupyter kernel management for OmicsLab.

A single long-lived kernel is used per server workspace so that every agent turn,
notebook cell and variable inspection shares the same live Python state.

The kernel is launched through jupyter_client's async manager against our own
generated kernelspec (pointing at the resolved Python interpreter), because we
do not want to depend on a globally installed kernelspec.
"""

from .manager import KernelService

__all__ = ["KernelService"]
