"""Provider factory."""

from __future__ import annotations

from ...config import LLMTarget
from .anthropic import AnthropicProvider
from .base import BaseProvider, LLMError, ProviderConfig
from .mock import MockProvider
from .openai_compat import OpenAICompatProvider

__all__ = [
    "BaseProvider",
    "LLMError",
    "ProviderConfig",
    "OpenAICompatProvider",
    "AnthropicProvider",
    "MockProvider",
    "make_provider",
]


def make_provider(target: LLMTarget) -> BaseProvider:
    family = (target.family or "").lower()
    provider = (target.provider or "").lower()
    if family == "mock" or provider == "mock":
        return MockProvider(target)
    if family == "anthropic":
        return AnthropicProvider(target)
    return OpenAICompatProvider(target)
