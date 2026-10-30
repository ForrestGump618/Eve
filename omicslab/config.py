"""Configuration, paths and LLM provider resolution for SuWen.

Design goals:
- zero-config startup: if a known API key exists in the environment or in
  ``~/.omicslab/auth.json``, a sensible provider/model pair is inferred;
- explicit override always wins (settings file > env > inference);
- every failure carries an actionable message that the UI can display verbatim.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any
from .utils import atomic_write_text

APP_SLUG = "omicslab"
DEFAULT_PORT = 5077
DEFAULT_HOST = "127.0.0.1"

# ---------------------------------------------------------------------------
# Provider catalogue
# ---------------------------------------------------------------------------
# ``api_base`` is the OpenAI-compatible base URL (or Anthropic base URL for the
# ``anthropic`` family). ``env_key`` is the environment variable holding the key.
PROVIDERS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "label": "DeepSeek",
        "family": "openai",
        "api_base": "https://api.deepseek.com/v1",
        "env_key": "DEEPSEEK_API_KEY",
        "default_model": "deepseek-chat",
        "models": ["deepseek-chat", "deepseek-reasoner"],
    },
    "openai": {
        "label": "OpenAI",
        "family": "openai",
        "api_base": "https://api.openai.com/v1",
        "env_key": "OPENAI_API_KEY",
        "default_model": "gpt-4o-mini",
        "models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "o4-mini"],
    },
    "anthropic": {
        "label": "Anthropic",
        "family": "anthropic",
        "api_base": "https://api.anthropic.com",
        "env_key": "ANTHROPIC_API_KEY",
        "default_model": "claude-3-5-sonnet-latest",
        "models": ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-sonnet-4-20250514"],
    },
    "qwen": {
        "label": "通义千问 (DashScope)",
        "family": "openai",
        "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "env_key": "QWEN_API_KEY",
        "default_model": "qwen-plus",
        "models": ["qwen-plus", "qwen-max", "qwen-turbo", "qwen2.5-72b-instruct"],
    },
    "zhipu": {
        "label": "智谱 GLM",
        "family": "openai",
        "api_base": "https://open.bigmodel.cn/api/paas/v4",
        "env_key": "ZHIPU_API_KEY",
        "default_model": "glm-4-flash",
        "models": ["glm-4-flash", "glm-4-plus", "glm-4-air"],
    },
    "ark": {
        "label": "火山方舟 (Volcengine Ark)",
        "family": "openai",
        "api_base": "https://ark.cn-beijing.volces.com/api/v3",
        "env_key": "ARK_API_KEY",
        "fallback_env_key": "VOLCENGINE_API_KEY",
        "default_model": "",
        "models": [],
        "needs_model": True,
        "hint": "在火山方舟控制台创建推理接入点（ep-...）或使用模型 ID，填入模型名；Key 形如 ark-xxxx。",
    },
    "moonshot": {
        "label": "Moonshot Kimi",
        "family": "openai",
        "api_base": "https://api.moonshot.cn/v1",
        "env_key": "MOONSHOT_API_KEY",
        "default_model": "moonshot-v1-32k",
        "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    },
    "ollama": {
        "label": "Ollama (本地)",
        "family": "openai",
        "api_base": "http://127.0.0.1:11434/v1",
        "env_key": "OLLAMA_API_KEY",
        "default_model": "qwen2.5:7b",
        "models": ["qwen2.5:7b", "llama3.1:8b", "deepseek-r1:8b", "gemma2:9b"],
        "keyless_placeholder": "ollama",
    },
    "openrouter": {
        "label": "OpenRouter",
        "family": "openai",
        "api_base": "https://openrouter.ai/api/v1",
        "env_key": "OPENROUTER_API_KEY",
        "default_model": "deepseek/deepseek-chat",
        "models": ["deepseek/deepseek-chat", "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"],
    },
    "siliconflow": {
        "label": "SiliconFlow 硅基流动",
        "family": "openai",
        "api_base": "https://api.siliconflow.cn/v1",
        "env_key": "SILICONFLOW_API_KEY",
        "default_model": "Qwen/Qwen2.5-7B-Instruct",
        "models": ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3"],
    },
    "google": {
        "label": "Google Gemini (OpenAI 兼容)",
        "family": "openai",
        "api_base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env_key": "GOOGLE_API_KEY",
        "default_model": "gemini-2.0-flash",
        "models": ["gemini-2.0-flash", "gemini-1.5-pro"],
    },
    "custom_openai": {
        "label": "自定义 OpenAI 兼容端点",
        "family": "openai",
        "api_base": "http://127.0.0.1:8000/v1",
        "env_key": "CUSTOM_OPENAI_API_KEY",
        "default_model": "local-model",
        "models": [],
        "fallback_env_key": "OPENAI_API_KEY",
    },
    "custom_anthropic": {
        "label": "自定义 Anthropic 兼容端点",
        "family": "anthropic",
        "api_base": "",
        "env_key": "CUSTOM_ANTHROPIC_API_KEY",
        "default_model": "claude-3-5-sonnet-latest",
        "models": [],
        "fallback_env_key": "ANTHROPIC_API_KEY",
    },
    "mock": {
        "label": "Mock (离线测试)",
        "family": "mock",
        "api_base": "",
        "env_key": "MOCK_API_KEY",
        "default_model": "mock-model",
        "models": ["mock-model"],
        "no_key_required": True,
    },
}

_KEY_INFERENCE_ORDER = [
    "deepseek",
    "ark",
    "openai",
    "qwen",
    "zhipu",
    "moonshot",
    "anthropic",
    "google",
    "openrouter",
    "siliconflow",
]

# Keys that identify a provider even before an API base is configured.
_ARK_KEY_PREFIXES = ("ark-", "ark_")


class ConfigError(RuntimeError):
    """Raised when configuration is missing or invalid."""


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        pass
    return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def _probe_writable(directory: Path) -> bool:
    """Return True when ``directory`` exists (or can be created) and is writable."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / f".write-probe-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _env_first(*names: str) -> str:
    """Return the first non-empty environment variable from ``names``."""
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return ""


def default_home() -> Path:
    """Pick a writable data directory for settings, conversations and figures.

    Preference order: ``OMICSLAB_HOME`` (or ``OMICSLAB_DATA_DIR``) →
    ``~/.omicslab`` → ``%LOCALAPPDATA%/OmicsLab`` → ``$XDG_DATA_HOME/omicslab``
    → ``<cwd>/.omicslab``.  Sandboxed or partially read-only user profiles
    therefore degrade gracefully instead of failing at startup.
    """
    candidates: list[Path] = []
    env = os.environ.get("OMICSLAB_HOME") or os.environ.get("OMICSLAB_DATA_DIR")
    if env:
        candidates.append(Path(env).expanduser())
    else:
        candidates.append(Path.home() / f".{APP_SLUG}")
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates.append(Path(local) / "OmicsLab")
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            candidates.append(Path(xdg) / APP_SLUG)
        candidates.append(Path.cwd() / f".{APP_SLUG}")
    for candidate in candidates:
        if _probe_writable(candidate):
            return candidate.resolve()
    return candidates[-1].resolve()


@dataclass
class LLMTarget:
    """Fully resolved LLM endpoint."""

    provider: str
    model: str
    family: str
    api_base: str
    api_key: str = ""
    label: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "family": self.family,
            "api_base": self.api_base,
            "has_key": bool(self.api_key),
            "label": self.label,
        }


@dataclass
class Settings:
    """Runtime settings. Persisted as JSON, merged over environment defaults."""

    workspace: Path = field(default_factory=lambda: Path.cwd())
    home: Path = field(default_factory=default_home)
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT

    # LLM
    provider: str = "auto"
    model: str = "auto"
    api_base: str = ""
    provider_connections: dict[str, Any] = field(default_factory=dict)
    temperature: float = 0.0
    max_tokens: int = 0  # 0 -> provider default
    # Legacy read-only compatibility value from older settings files. The
    # runtime does not use it as an iteration, tool-call, or no-progress limit.
    max_iterations: int = 0
    request_timeout_s: int = 180
    vision_model: str = ""
    vision_base_url: str = ""
    vision_api_key: str = ""
    vision_enabled: bool = True

    # Runtime
    kernel_python: str = ""
    kernel_timeout_s: int = 180
    shell_timeout_s: int = 120
    approval_policy: str = "auto"  # auto | ask
    allow_shell: bool = True
    allow_file_write: bool = True
    sandbox_root_only: bool = True
    max_parallel_runs: int = 8
    max_child_tasks: int = 4
    max_child_depth: int = 2
    max_workspace_scopes: int = 4

    # Product
    ui: dict[str, Any] = field(default_factory=dict)
    default_agent: str = "lead"
    language: str = "zh"

    # -- persistence -------------------------------------------------------
    @property
    def settings_path(self) -> Path:
        return self.home / "settings.json"

    @property
    def auth_path(self) -> Path:
        return self.home / "auth.json"

    def reload(self) -> "Settings":
        data = _read_json(self.settings_path)
        scalars = {
            "host": str,
            "port": int,
            "provider": str,
            "model": str,
            "api_base": str,
            "temperature": float,
            "max_tokens": int,
            "request_timeout_s": int,
            "vision_model": str,
            "vision_base_url": str,
            "vision_api_key": str,
            "vision_enabled": bool,
            "kernel_python": str,
            "kernel_timeout_s": int,
            "shell_timeout_s": int,
            "approval_policy": str,
            "allow_shell": bool,
            "allow_file_write": bool,
            "sandbox_root_only": bool,
            "max_parallel_runs": int,
            "max_child_tasks": int,
            "max_child_depth": int,
            "max_workspace_scopes": int,
            "default_agent": str,
            "language": str,
        }
        for key, caster in scalars.items():
            if key not in data:
                continue
            try:
                setattr(self, key, caster(data[key]))
            except (TypeError, ValueError):
                continue
        if isinstance(data.get("ui"), dict):
            self.ui = data["ui"]
        if isinstance(data.get("provider_connections"), dict):
            self.provider_connections = {k: v for k, v in data["provider_connections"].items()
                                         if k in PROVIDERS and isinstance(v, dict)}
        if data.get("workspace"):
            try:
                self.workspace = Path(data["workspace"]).expanduser().resolve()
            except (OSError, RuntimeError):
                pass
        return self

    def save(self) -> None:
        payload = asdict(self)
        payload["workspace"] = str(self.workspace)
        payload["home"] = str(self.home)
        _write_json(self.settings_path, payload)

    def update(self, patch: dict[str, Any]) -> "Settings":
        """Apply a partial settings dict from the UI, coercing and validating types.

        Raises :class:`ConfigError` for values that would leave the app in an
        unusable state instead of silently swallowing the problem (the HTTP
        layer turns that into an actionable 400 message for the settings page).
        """
        if not isinstance(patch, dict):
            raise ConfigError("设置内容必须是 JSON 对象")
        if "max_iterations" in patch:
            raise ConfigError("迭代上限由每轮运行时自动管理，无需手动设置")
        allowed: dict[str, Any] = {
            "host": str,
            "port": int,
            "provider": str,
            "model": str,
            "api_base": str,
            "temperature": float,
            "max_tokens": int,
            "request_timeout_s": int,
            "vision_model": str,
            "vision_base_url": str,
            "vision_api_key": str,
            "vision_enabled": bool,
            "kernel_python": str,
            "kernel_timeout_s": int,
            "shell_timeout_s": int,
            "approval_policy": str,
            "allow_shell": bool,
            "allow_file_write": bool,
            "sandbox_root_only": bool,
            "max_parallel_runs": int,
            "max_child_tasks": int,
            "max_child_depth": int,
            "max_workspace_scopes": int,
            "default_agent": str,
            "language": str,
        }
        string_fields = {
            "host", "provider", "model", "api_base", "vision_model",
            "vision_base_url", "vision_api_key", "kernel_python",
            "approval_policy", "default_agent", "language",
        }
        previous_provider = self.provider
        requested_provider = patch.get("provider")
        if requested_provider is not None:
            requested_provider = str(requested_provider).strip() or "auto"
            if requested_provider != "auto" and requested_provider not in PROVIDERS:
                raise ConfigError(
                    f"未知 provider: {requested_provider}。可用: {', '.join(sorted(PROVIDERS))}"
                )
        for key, caster in allowed.items():
            if key not in patch:
                continue
            value = patch[key]
            if key in string_fields and value is not None:
                value = str(value).strip()
            try:
                coerced = caster(value)
            except (TypeError, ValueError) as exc:
                raise ConfigError(f"字段 {key} 的值无效: {value!r}") from exc
            if key == "port" and not (1 <= coerced <= 65535):
                raise ConfigError("端口必须在 1-65535 之间")
            if key == "request_timeout_s" and not (5 <= coerced <= 3600):
                raise ConfigError("request_timeout_s 必须在 5-3600 之间")
            if key == "kernel_timeout_s" and not (5 <= coerced <= 3600):
                raise ConfigError("kernel_timeout_s 必须在 5-3600 之间")
            if key == "shell_timeout_s" and not (5 <= coerced <= 3600):
                raise ConfigError("shell_timeout_s 必须在 5-3600 之间")
            if key == "temperature":
                coerced = max(0.0, min(2.0, coerced))
            if key == "max_tokens" and coerced < 0:
                coerced = 0
            if key == "approval_policy" and coerced not in {"auto", "ask"}:
                raise ConfigError("approval_policy 只能是 auto 或 ask")
            if key == "max_parallel_runs" and not (1 <= coerced <= 64):
                raise ConfigError("max_parallel_runs 必须在 1-64 之间")
            if key == "max_child_tasks" and not (1 <= coerced <= 16):
                raise ConfigError("max_child_tasks 必须在 1-16 之间")
            if key == "max_child_depth" and not (1 <= coerced <= 4):
                raise ConfigError("max_child_depth 必须在 1-4 之间")
            if key == "max_workspace_scopes" and not (1 <= coerced <= 16):
                raise ConfigError("max_workspace_scopes 必须在 1-16 之间")
            if key == "language" and coerced not in {"zh", "en"}:
                coerced = "zh"
            if key == "vision_api_key" and coerced and getattr(self,'_secure_vault',None) is not None:
                self.set_keys({'VISION_API_KEY':coerced})
                coerced = ""
            setattr(self, key, coerced)
        # Switching provider must not silently reuse the previous endpoint or
        # model: otherwise the UI shows "saved" while the request still goes to
        # the old (possibly dead) service.  Custom endpoints keep their base.
        if requested_provider is not None and requested_provider != previous_provider:
            if "model" not in patch or not str(patch.get("model") or "").strip():
                self.model = "auto"
            if "api_base" not in patch:
                self.api_base = ""
        if isinstance(patch.get("ui"), dict):
            merged = dict(self.ui or {})
            merged.update(patch["ui"])
            self.ui = merged
        if "workspace" in patch and patch["workspace"]:
            try:
                self.workspace = Path(str(patch["workspace"])).expanduser().resolve()
            except (OSError, RuntimeError):
                pass
        self.save()
        return self

    # -- secrets -----------------------------------------------------------
    def auth(self) -> dict[str, str]:
        """Return configured secrets, with environment variables winning over file."""
        data = _read_json(self.auth_path)
        out = {str(k): str(v) for k, v in data.items() if isinstance(v, str) and v.strip()}
        vault = getattr(self, '_secure_vault', None)
        for name, value in list(out.items()):
            if value.startswith('suwen-vault:'):
                if vault is None:
                    from .suwen.store import PlatformStore
                    from .suwen.vault import Vault
                    temporary_store = PlatformStore(self.home)
                    try:
                        out[name] = Vault(temporary_store).get(value.split(':', 1)[1])
                    finally:
                        temporary_store.close()
                else:
                    out[name] = vault.get(value.split(':', 1)[1])
        volatile = getattr(self, '_volatile_keys', None)
        if isinstance(volatile, dict):
            out.update({str(k): str(v) for k, v in volatile.items()
                        if isinstance(v, str) and v.strip()})
        # environment wins over the file, matching typical CLI conventions
        for provider, meta in PROVIDERS.items():
            env_key = str(meta.get("env_key") or "")
            fallback = str(meta.get("fallback_env_key") or "")
            for name in (env_key, fallback):
                if name and os.environ.get(name):
                    out[env_key or name] = os.environ[name]
        for extra in ("VISION_API_KEY", "CUSTOM_OPENAI_API_KEY", "CUSTOM_ANTHROPIC_API_KEY",
                      "CUSTOM_OPENAI_API_BASE", "CUSTOM_ANTHROPIC_API_BASE"):
            if os.environ.get(extra):
                out[extra] = os.environ[extra]
        return out

    def set_keys(self, keys: dict[str, str]) -> None:
        data = _read_json(self.auth_path)
        volatile = getattr(self, '_volatile_keys', None)
        if not isinstance(volatile, dict):
            volatile = {}
            self._volatile_keys = volatile
        for key, value in keys.items():
            if not key or not isinstance(key, str):
                continue
            key = key.strip()
            if not key:
                continue
            if isinstance(value, str) and value.strip():
                vault = getattr(self, '_secure_vault', None)
                if vault is not None:
                    reference = 'legacy_' + re.sub(r'[^A-Za-z0-9_-]', '_', key)[:60]
                    try:
                        result = vault.put(reference, value.strip(), persist=True)
                    except (OSError, RuntimeError, ValueError):
                        # Keep the app usable without writing plaintext when the
                        # host has no supported OS credential vault.
                        volatile[key] = value.strip()
                        data.pop(key, None)
                    else:
                        if isinstance(result, dict) and result.get('stored'):
                            data[key] = 'suwen-vault:' + reference
                            volatile.pop(key, None)
                        else:
                            volatile[key] = value.strip()
                            data.pop(key, None)
                else:
                    data[key] = value.strip()
            else:
                data.pop(key, None)
                volatile.pop(key, None)
        _write_json(self.auth_path, data)

    # -- vision ------------------------------------------------------------
    def vision_key(self) -> str:
        """Resolve the vision API key (settings > auth.json > env > OpenAI key)."""
        explicit = (self.vision_api_key or "").strip()
        if explicit:
            return explicit
        keys = self.auth()
        for name in ("VISION_API_KEY", "OMICSLAB_VISION_API_KEY", "OPENAI_API_KEY"):
            value = str(keys.get(name, "") or "").strip()
            if value:
                return value
        return _env_first("VISION_API_KEY", "OMICSLAB_VISION_API_KEY")

    def vision_config(self) -> dict[str, Any]:
        """Public vision-model status used by the settings page and chat page."""
        key = self.vision_key()
        model = (self.vision_model or "").strip()
        if not model and key:
            model = "gpt-4o-mini"
        base_url = (self.vision_base_url or "").strip()
        if key and not base_url:
            base_url = "https://api.openai.com/v1"
        configured = bool(self.vision_enabled and key and model)
        error: str | None = None
        if self.vision_enabled and not configured:
            if not key:
                error = ("未配置视觉模型 API Key：请在设置页“视觉模型”卡片填写，"
                         "或设置环境变量 VISION_API_KEY。")
            elif not model:
                error = "请填写视觉模型名称，例如 gpt-4o-mini、qwen-vl-plus 或 gemini-2.0-flash。"
        return {
            "enabled": bool(self.vision_enabled),
            "model": model,
            "base_url": base_url,
            "has_key": bool(key),
            "configured": configured,
            "error": error,
        }

    # -- LLM resolution ----------------------------------------------------
    def provider_meta(self, provider: str) -> dict[str, Any]:
        return {**PROVIDERS.get(provider, {}), **self.provider_connections.get(provider, {})}

    def save_provider_connection(self, provider, model="", api_base="", models=None):
        from urllib.parse import urlsplit
        if provider not in PROVIDERS or provider == "mock":
            raise ConfigError("请选择有效的供应商")
        current = dict(self.provider_connections.get(provider, {}))
        if api_base:
            url = urlsplit(api_base)
            if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"})) or url.username or url.password or url.query or url.fragment:
                raise ConfigError("模型地址需要 HTTPS 或本地 HTTP，且不能包含凭据或查询参数")
            current["api_base"] = api_base.rstrip("/")
        values = models if models is not None else current.get("models", [])
        if not isinstance(values, list) or len(values) > 500:
            raise ConfigError("模型列表必须是最多 500 项的数组")
        values = [model, *values]
        if any(not isinstance(x, str) or len(x) > 160 or any(ord(c) < 32 for c in x) for x in values):
            raise ConfigError("模型名称无效")
        values = list(dict.fromkeys(values))
        current["models"] = [x.strip() for x in values if x.strip()]
        if model:
            current["default_model"] = model
        self.provider_connections[provider] = current

    def _infer_provider(self, model: str, keys: dict[str, str]) -> str:
        """Infer a provider from an explicit model name hint or the first known key."""
        lowered = (model or "").lower()
        if lowered not in {"", "auto"}:
            hints = [
                ("claude", "anthropic"),
                ("gpt", "openai"),
                ("o1", "openai"),
                ("o3", "openai"),
                ("o4", "openai"),
                ("deepseek", "deepseek"),
                ("qwen", "qwen"),
                ("glm", "zhipu"),
                ("moonshot", "moonshot"),
                ("kimi", "moonshot"),
                ("gemini", "google"),
                ("llama", "ollama"),
                ("mixtral", "ollama"),
                ("ark-", "ark"),
            ]
            for token, candidate in hints:
                if token in lowered:
                    return candidate
        for candidate in _KEY_INFERENCE_ORDER:
            meta = PROVIDERS[candidate]
            if keys.get(str(meta.get("env_key", ""))):
                return candidate
            fallback = meta.get("fallback_env_key")
            if fallback and keys.get(str(fallback)):
                return candidate
        # Custom endpoints: an ark-style key identifies Volcengine Ark even
        # without an explicit API base, everything else needs an address.
        custom_key = str(keys.get("CUSTOM_OPENAI_API_KEY", "") or "")
        if custom_key:
            if custom_key.lower().startswith(_ARK_KEY_PREFIXES):
                return "ark"
            if (self.api_base or "").strip() or _env_first("CUSTOM_OPENAI_API_BASE"):
                return "custom_openai"
            raise ConfigError(
                "检测到自定义 OpenAI 兼容 API Key（CUSTOM_OPENAI_API_KEY），但缺少 API 地址。"
                "请打开设置页 → Provider 选“自定义 OpenAI 兼容端点” → 填写 API 地址与模型 → 保存并测试；"
                "如果这是火山方舟 Key（ark-...），请直接选择“火山方舟 (Volcengine Ark)”。"
            )
        anthropic_key = str(keys.get("CUSTOM_ANTHROPIC_API_KEY", "") or "")
        if anthropic_key:
            if (self.api_base or "").strip() or _env_first("CUSTOM_ANTHROPIC_API_BASE"):
                return "custom_anthropic"
            raise ConfigError(
                "检测到自定义 Anthropic API Key，但缺少 API 地址：请在设置页填写 API Base。"
            )
        return ""

    def resolve_llm(self, provider: str | None = None, model: str | None = None,
                    *, api_base_override: str | None = None, api_key_override: str | None = None) -> LLMTarget:
        """Resolve an explicit provider/model/key/base into a callable target.

        Every failure raises :class:`ConfigError` with an actionable Chinese
        message that the UI can show verbatim; a fresh install with no keys at
        all falls back to the offline ``mock`` provider so the app is usable
        immediately.
        """
        requested_provider = (provider or "").strip()
        provider = requested_provider or (self.provider or "auto").strip()
        model = (model or "").strip() or ((self.model or "auto").strip() if not requested_provider or requested_provider == self.provider else "auto")

        env_provider = _env_first("OMICSLAB_LLM_PROVIDER", "OMICSLAB_PROVIDER")
        if provider in {"", "auto"} and env_provider:
            provider = env_provider
        env_model = _env_first("OMICSLAB_LLM_MODEL", "OMICSLAB_MODEL")
        if model in {"", "auto"} and env_model:
            model = env_model

        keys = self.auth()
        if provider in {"", "auto"}:
            provider = self._infer_provider(model, keys) or "mock"
        if provider not in PROVIDERS:
            raise ConfigError(
                f"未知 provider: {provider}。可用: {', '.join(sorted(PROVIDERS))}"
            )

        meta = self.provider_meta(provider)
        family = str(meta.get("family", "openai"))
        api_base = (api_base_override if api_base_override is not None else self.provider_connections.get(provider, {}).get("api_base") or (self.api_base if provider == self.provider else "") or "").strip()
        if not api_base:
            if provider == "custom_openai":
                api_base = _env_first("CUSTOM_OPENAI_API_BASE") or str(meta.get("api_base") or "")
            elif provider == "custom_anthropic":
                api_base = _env_first("CUSTOM_ANTHROPIC_API_BASE")
            elif provider == "ark":
                api_base = _env_first("ARK_BASE_URL", "ARK_API_BASE") or str(meta.get("api_base") or "")
            elif provider == "ollama":
                api_base = _env_first("OLLAMA_BASE_URL") or str(meta.get("api_base") or "")
            else:
                api_base = _env_first(f"{provider.upper()}_API_BASE") or str(meta.get("api_base") or "")
        api_base = api_base.rstrip("/")
        if family == "anthropic" and api_base.endswith("/v1"):
            api_base = api_base[: -len("/v1")]
        if not api_base and family != "mock":
            raise ConfigError(
                f"provider '{provider}' 缺少 API 地址：请在设置页填写 API Base，"
                "或设置对应的环境变量（如 CUSTOM_OPENAI_API_BASE）。"
            )

        api_key = ""
        if not meta.get("no_key_required"):
            api_key = api_key_override if api_key_override is not None else keys.get(str(meta.get("env_key", "")), "") or ""
            if not api_key and meta.get("fallback_env_key"):
                api_key = keys.get(str(meta["fallback_env_key"]), "") or ""
            if not api_key and meta.get("keyless_placeholder"):
                api_key = str(meta["keyless_placeholder"])
            if not api_key:
                raise ConfigError(
                    f"provider '{provider}' 缺少 API Key。请在设置页选择该 Provider 并填入 Key"
                    f"（保存后会自动测试连通性），或设置环境变量 {meta.get('env_key')}。"
                )

        if model in {"", "auto"}:
            model = (
                _env_first("OMICSLAB_LLM_MODEL")
                or _env_first(f"{provider.upper()}_MODEL")
                or str(meta.get("default_model") or "")
            )
        if not model:
            raise ConfigError(
                f"provider '{provider}' 需要指定模型名称。"
                + (str(meta.get("hint") or "") if meta.get("hint") else "")
            )

        return LLMTarget(
            provider=provider,
            model=model,
            family=family,
            api_base=api_base,
            api_key=api_key,
            label=str(meta.get("label", provider)),
        )

    # -- provider listing --------------------------------------------------
    def provider_catalog(self) -> list[dict[str, Any]]:
        """Describe every selectable provider for the settings page.

        Each entry carries enough information for the UI to render a working
        form (prefilled base URL, model suggestions, whether a key/base/model is
        required) and to show whether the provider is already usable.
        """
        keys = self.auth()
        saved_base = (self.api_base or "").strip()
        out: list[dict[str, Any]] = []
        for provider, meta in PROVIDERS.items():
            meta = self.provider_meta(provider)
            connection_base = str(meta.get("api_base") or "")
            effective_base = connection_base or (saved_base if provider == self.provider else "")
            env_key = str(meta.get("env_key", ""))
            fallback = str(meta.get("fallback_env_key") or "")
            has_key = bool(keys.get(env_key)) or bool(fallback and keys.get(fallback))
            no_key_required = bool(meta.get("no_key_required"))
            needs_api_base = provider.startswith("custom")
            needs_model = bool(meta.get("needs_model")) or not str(meta.get("default_model") or "")
            if provider == "custom_openai":
                has_base = bool(effective_base or _env_first("CUSTOM_OPENAI_API_BASE"))
            elif provider == "custom_anthropic":
                has_base = bool(effective_base or _env_first("CUSTOM_ANTHROPIC_API_BASE"))
            else:
                has_base = True
            configured = no_key_required or (has_key and has_base)
            out.append(
                {
                    "id": provider,
                    "label": meta.get("label", provider),
                    "family": meta.get("family"),
                    "api_base": effective_base,
                    "default_model": meta.get("default_model"),
                    "models": meta.get("models", []),
                    "env_key": env_key,
                    "has_key": has_key,
                    "no_key_required": no_key_required,
                    "needs_api_base": needs_api_base and not has_base,
                    "needs_model": needs_model,
                    "configured": configured,
                    "hint": str(meta.get("hint") or ""),
                }
            )
        return out

    def provider_catalog_map(self) -> dict[str, dict[str, Any]]:
        """Same as :meth:`provider_catalog` but keyed by provider id."""
        return {str(item["id"]): item for item in self.provider_catalog()}

    # -- kernel ------------------------------------------------------------
    def resolve_kernel_python(self) -> str:
        if self.kernel_python:
            path = Path(self.kernel_python).expanduser()
            if path.is_file():
                return str(path)
            raise ConfigError(f"配置的 kernel python 不存在: {path}")
        candidates: list[Path] = []
        env_python = os.environ.get("OMICSLAB_KERNEL_PYTHON")
        if env_python:
            candidates.append(Path(env_python).expanduser())
        # our own venv (the process interpreter) is the safest default
        candidates.append(Path(sys.executable))
        # a sibling .venv next to the workspace
        for root in (self.workspace, Path.cwd()):
            candidates.append(root / ".venv" / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python3"))
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
        raise ConfigError("找不到可用的 kernel Python 解释器，请设置 --python 或 OMICSLAB_KERNEL_PYTHON。")

    # -- paths -------------------------------------------------------------
    def ensure_dirs(self) -> None:
        subs = (
            "", "conversations", "trajectories", "figures", "jobs", "memory",
            "logs", "kernels", "uploads", "discovery", "registry", "tmp",
        )
        try:
            for sub in subs:
                (self.home / sub).mkdir(parents=True, exist_ok=True)
            self.workspace.mkdir(parents=True, exist_ok=True)
            return
        except OSError as exc:
            fallback = Path.cwd() / f".{APP_SLUG}"
            if self.home != fallback and _probe_writable(fallback):
                self.home = fallback
                self.reload()
                try:
                    for sub in subs:
                        (self.home / sub).mkdir(parents=True, exist_ok=True)
                    self.workspace.mkdir(parents=True, exist_ok=True)
                    return
                except OSError:
                    pass
            raise ConfigError(
                f"数据目录不可写：{self.home}（{exc}）。"
                "请设置环境变量 OMICSLAB_HOME 或通过 --home 指定一个可写目录。"
            ) from exc

    @property
    def figures_dir(self) -> Path:
        return self.home / "figures"

    @property
    def conversations_dir(self) -> Path:
        return self.home / "conversations"

    @property
    def trajectories_dir(self) -> Path:
        return self.home / "trajectories"

    @property
    def jobs_dir(self) -> Path:
        return self.home / "jobs"

    @property
    def memory_dir(self) -> Path:
        return self.home / "memory"

    @property
    def kernels_dir(self) -> Path:
        return self.home / "kernels"

    @property
    def discovery_dir(self) -> Path:
        return self.home / "discovery"

    @property
    def registry_dir(self) -> Path:
        return self.home / "registry"

    @property
    def uploads_dir(self) -> Path:
        return self.home / "uploads"

    @property
    def tmp_dir(self) -> Path:
        return self.home / "tmp"

    @property
    def ssh_path(self) -> Path:
        return self.home / "ssh.json"

    @property
    def ssh_known_hosts_path(self) -> Path:
        return self.home / "ssh_known_hosts.json"

    @property
    def log_path(self) -> Path:
        return self.home / "logs" / "server.log"


def load_settings(workspace: str | Path | None = None, home: str | Path | None = None) -> Settings:
    settings = Settings(
        workspace=Path(workspace).expanduser().resolve() if workspace else Path.cwd(),
        home=Path(home).expanduser().resolve() if home else default_home(),
    )
    settings.reload()
    if workspace:
        settings.workspace = Path(workspace).expanduser().resolve()
    settings.ensure_dirs()
    return settings
