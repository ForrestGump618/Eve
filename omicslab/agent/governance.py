"""Per-turn safety policy. Model instructions and workspace settings cannot override it."""
from __future__ import annotations

import hashlib
import json
import posixpath
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .types import ToolResult


@dataclass(frozen=True)
class TurnPolicy:
    steps: int = 24
    tools: int = 48
    tokens: int = 120_000
    warning_ratio: float = .8
    no_progress: int = 6
    same_output: int = 3
    seconds: float = 900


def canonical(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: canonical(v, k) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, str) and key in {"path", "cwd", "directory"}:
        return posixpath.normpath(value.replace("\\", "/") or ".")
    return value


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def recovery(name: str, args: dict, result: ToolResult | None = None) -> dict:
    error = str(result.error or result.content).lower() if result and not result.ok else ""
    if any(s in error for s in ("filenotfound", "no such file", "不存在", "not found", "errno 2")):
        path = canonical(str(args.get("path") or "."), "path")
        parent = posixpath.dirname(path) or "."
        # Never propose a path outside the selected workspace.
        if parent.startswith(("..", "/")) or ":" in parent:
            parent = "."
        return {"category": "path_not_found", "next_calls": [{"name": "list_files", "arguments": {"path": parent}}],
                "strategy": "检查父目录或工作区根目录；只根据实际返回的 entries 选择路径。若目标不在 entries 中，报告缺失，不猜测路径。"}
    if any(s in error for s in ("permission", "denied", "拒绝", "权限")):
        return {"category": "permission_denied", "strategy": "报告缺少的权限，使用已授权的替代操作；禁止相同参数重试。"}
    if any(s in error for s in ("ssh", "connect", "timeout", "timed out", "远端", "连接", "超时")):
        return {"category": "remote_unavailable", "strategy": "报告远端或网络不可用及已尝试参数；等待连接状态变化，或使用另一个已连接工作区，禁止原样重试。"}
    return {"category": "tool_error" if error else "unchanged_result",
            "strategy": "利用已返回的结果收尾，或选择输入和目标不同的工具获取新证据；禁止无状态变化的重试。"}


@dataclass
class TurnGuard:
    policy: TurnPolicy = field(default_factory=TurnPolicy)
    steps: int = 0
    calls: int = 0
    tokens: int = 0
    stalled: int = 0
    epoch: int = 0
    started: float = field(default_factory=time.monotonic)
    seen: dict = field(default_factory=dict)
    history: list = field(default_factory=list)
    outputs: Counter = field(default_factory=Counter)
    attempted: list = field(default_factory=list)
    finalizing: bool = False
    final_reason: str = ""
    inflight: set = field(default_factory=set)
    last_recovery: dict = field(default_factory=dict)
    last_outputs: dict = field(default_factory=dict)

    def snapshot(self) -> dict:
        return {"steps": self.steps, "tool_calls": self.calls, "tokens": self.tokens,
                "consecutive_no_progress": self.stalled, "degraded": self.degraded}

    @property
    def degraded(self) -> bool:
        return self.tokens >= int(self.policy.tokens * self.policy.warning_ratio)

    def pre_step(self) -> str | None:
        if time.monotonic() - self.started >= self.policy.seconds:
            return "turn_deadline"
        if self.steps >= self.policy.steps:
            return "step_budget"
        if self.tokens >= self.policy.tokens:
            return "token_budget"
        if self.stalled >= self.policy.no_progress and not self.finalizing:
            return "no_progress"
        self.steps += 1
        return None

    def add_usage(self, usage: dict) -> None:
        def number(key):
            try:
                return max(0, int(usage.get(key) or 0))
            except (ValueError, TypeError, OverflowError):
                return 0
        self.tokens += max(number("total_tokens"), number("prompt_tokens") + number("completion_tokens"))

    def state(self, ctx, name: str, args: dict) -> str:
        stamps = []
        if name in {"list_files", "read_file"} and getattr(getattr(ctx, "backend", None), "kind", "local") != "ssh":
            try:
                path = ctx.resolve_in_workspace(str(args.get("path") or "."))
                for p in (path, path.parent):
                    try:
                        s = p.stat()
                        stamps.append((str(p), s.st_mtime_ns, s.st_size))
                    except OSError:
                        stamps.append((str(p), "missing"))
            except (OSError, ValueError):
                pass
        return digest([self.epoch, stamps])

    def refuse(self, name: str, args: dict, code: str, previous: dict | None = None) -> ToolResult:
        self.stalled += 1
        detail = {"code": code, "retryable": False, "executed": False,
                  "attempted_arguments": canonical(args), "counters": self.snapshot(),
                  "recovery": (previous or {}).get("recovery") or recovery(name, args)}
        if previous:
            detail["previous_result_fingerprint"] = previous["fingerprint"]
        message = "工具调用已由运行时拒绝；请采用 recovery 中的替代策略。"
        return ToolResult("", name, False, json.dumps({"error": detail}, ensure_ascii=False),
                          data={"guard": detail}, error=code)

    def before(self, ctx, name: str, args: dict) -> tuple[ToolResult | None, tuple]:
        self.calls += 1  # Includes rejected requests: varying invalid calls cannot escape limits.
        key = digest([name, canonical(args)])
        state = self.state(ctx, name, args)
        slot = (key, state)
        self.attempted.append({"name": name, "arguments": canonical(args)})
        self.attempted[:] = self.attempted[-64:]
        if self.calls > self.policy.tools or self.finalizing:
            self.final_reason = "tool_budget" if not self.final_reason else self.final_reason
            return self.refuse(name, args, self.final_reason), slot
        if self.tokens >= self.policy.tokens or time.monotonic() - self.started >= self.policy.seconds:
            self.final_reason = "token_budget" if self.tokens >= self.policy.tokens else "turn_deadline"
            return self.refuse(name, args, self.final_reason), slot
        if self.stalled >= self.policy.no_progress:
            return self.refuse(name, args, "no_progress"), slot
        if slot in self.inflight:
            return self.refuse(name, args, "duplicate_inflight_call"), slot
        self.history.append(slot)
        self.history[:] = self.history[-24:]
        for width in range(2, 7):
            if len(self.history) >= width * 2 and self.history[-width:] == self.history[-2*width:-width]:
                return self.refuse(name, args, "tool_cycle", self.seen.get(slot)), slot
        if slot in self.seen:
            return self.refuse(name, args, "duplicate_tool_call", self.seen[slot]), slot
        if any(tool == name and count >= self.policy.same_output for (tool, _), count in self.outputs.items()):
            return self.refuse(name, args, "output_stagnation"), slot
        self.inflight.add(slot)
        return None, slot

    def observe(self, ctx, name: str, args: dict, slot: tuple, result: ToolResult) -> None:
        # Timing/IDs are excluded; changing telemetry is not new evidence.
        ignored = {"duration_ms", "ts", "timestamp", "execution_count", "tool_call_id"}
        data = {k: v for k, v in (result.data or {}).items() if k not in ignored}
        output = digest([result.ok, result.content, result.error, data])
        repeated = self.last_outputs.get(name) == output
        if not repeated:
            for key in [key for key in self.outputs if key[0] == name]:
                del self.outputs[key]
        self.last_outputs[name] = output
        self.outputs[(name, output)] += 1
        self.stalled = self.stalled + 1 if repeated or not result.ok else 0
        info = {"fingerprint": digest([slot[0], output]), "recovery": recovery(name, args, result)}
        if not result.ok:
            self.last_recovery = info["recovery"]
            result.data["recovery"] = info["recovery"]
            result.content += "\n" + json.dumps({"recovery": info["recovery"], "attempted_arguments": canonical(args)}, ensure_ascii=False)
        # Only actual successful state-changing tools invalidate cached reads.
        if result.ok and not repeated and name in {"write_file", "run_python_code", "run_shell", "submit_background_job", "export_notebook",
                "memory_create", "memory_edit", "ssh_exec", "ssh_upload", "ssh_download", "discovery_run",
                "discovery_create_project", "discovery_record_analysis_result", "discovery_record_evidence"}:
            self.epoch += 1
        self.seen[slot] = info
        self.seen[(slot[0], self.state(ctx, name, args))] = info
