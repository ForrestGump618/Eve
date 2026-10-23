"""Function registry: index the scientific Python stack for discoverability.

The registry lets an agent (or the user) ask *"what is available for X?"*
without guessing module names. It introspects the interpreter that runs the
analysis kernel and stores a compact JSON index, so downstream tools can search
functions and classes by name, module, signature or docstring summary.
"""

from .index import RegistryIndex, RegistryError

__all__ = ["RegistryIndex", "RegistryError"]
