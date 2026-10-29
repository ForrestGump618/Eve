"""Offline mock provider used for demos and tests.

The mock provider requires no API key and exercises the full agent loop:
it plans, calls ``run_python_code`` once, then summarises the tool output.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from ...config import LLMTarget
from .base import BaseProvider, ProviderConfig


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for item in reversed(messages):
        if item.get("role") == "user":
            return str(item.get("content") or "")
    return ""


def _has_tool_result(messages: list[dict[str, Any]]) -> bool:
    return any(item.get("role") == "tool" for item in messages)


class MockProvider(BaseProvider):
    name = "mock"
    family = "mock"

    def __init__(self, target: LLMTarget) -> None:
        super().__init__(target)
        self._sleep = 0.012

    async def _emit_text(self, text: str, *, reasoning: str | None = None) -> AsyncIterator[dict[str, Any]]:
        if reasoning:
            for piece in reasoning.split():
                yield {"type": "reasoning", "delta": piece + " "}
                await asyncio.sleep(self._sleep)
        chunk = ""
        for char in text:
            chunk += char
            if len(chunk) >= 6 or char in "\n。！？":
                yield {"type": "text", "delta": chunk}
                chunk = ""
                await asyncio.sleep(self._sleep)
        if chunk:
            yield {"type": "text", "delta": chunk}

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        config: ProviderConfig | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        user_text = _last_user_text(messages)
        wanted_tools = {((t.get("function") or {}).get("name")) for t in (tools or [])}
        has_python = "run_python_code" in wanted_tools

        if _has_tool_result(messages):
            last_tool = ""
            for item in reversed(messages):
                if item.get("role") == "tool":
                    last_tool = str(item.get("content") or "")
                    break
            summary = (
                "已完成本轮执行。工具输出摘要：\n\n```\n"
                + (last_tool[:1200] or "(无输出)")
                + "\n```\n\n"
                + "接下来可以：\n1. 继续调整参数复算；\n2. 把结果画成图保存到 figures/；\n"
                + "3. 让我整理成报告。\n\n"
                + "> 当前使用内置演示模型（mock），配置真实模型 Key 后即可获得完整推理能力。"
            )
            async for event in self._emit_text(summary, reasoning="工具结果已返回，整理摘要"):
                yield event
            yield {"type": "usage", "usage": self.estimate_usage(messages, summary)}
            yield {"type": "done", "finish_reason": "stop"}
            return

        lower = user_text.lower()
        wants_plot = any(k in lower for k in ("图", "plot", "画", "可视化", "chart"))
        wants_data = any(k in lower for k in ("数据", "统计", "计算", "分析", "python", "代码", "csv", "矩阵"))

        if has_python and (wants_plot or wants_data or len(messages) <= 2):
            if wants_plot:
                code = (
                    "import numpy as np\n"
                    "import matplotlib.pyplot as plt\n\n"
                    "x = np.linspace(0, 6 * np.pi, 400)\n"
                    "fig, ax = plt.subplots(figsize=(7, 3.2))\n"
                    "ax.plot(x, np.sin(x), label='sin(x)', lw=1.8)\n"
                    "ax.plot(x, np.cos(x), label='cos(x)', lw=1.8, alpha=0.85)\n"
                    "ax.set_xlabel('x'); ax.set_ylabel('value')\n"
                    "ax.set_title('Eve mock demo figure')\n"
                    "ax.legend(frameon=False); ax.spines[['top','right']].set_visible(False)\n"
                    "plt.tight_layout(); plt.show()\n"
                    "print('figure generated:', int(len(x)))\n"
                )
                plan = "我将先画一张演示图，并把图表保存到工作区。"
            else:
                code = (
                    "import numpy as np\n"
                    "rng = np.random.default_rng(7)\n"
                    "x = rng.normal(0, 1, (200, 50))\n"
                    "print('shape:', x.shape)\n"
                    "print('mean:', round(float(x.mean()), 4), 'std:', round(float(x.std()), 4))\n"
                    "df = __import__('pandas').DataFrame(x, columns=[f'g{i}' for i in range(50)])\n"
                    "print(df.iloc[:3, :5].round(3).to_string())\n"
                )
                plan = "我先用共享内核跑一段演示计算，再解读结果。"
            async for event in self._emit_text(
                plan, reasoning="用户请求涉及分析，考虑调用 Python 内核工具"
            ):
                yield event
            call = {
                "id": "call_mock_1",
                "type": "function",
                "function": {"name": "run_python_code", "arguments": json.dumps({"code": code})},
            }
            yield {"type": "tool_calls", "tool_calls": [call]}
            yield {"type": "done", "finish_reason": "tool_calls"}
            return

        answer = (
            "当前为离线 mock 模型，未连接外部服务。\n\n"
            "可在本地执行 Python、读取工作区文件并生成图表。"
            "配置真实模型后可获得完整推理与工具链。"
        )
        async for event in self._emit_text(answer, reasoning="演示模型：返回欢迎与使用引导"):
            yield event
        yield {"type": "usage", "usage": self.estimate_usage(messages, answer)}
        yield {"type": "done", "finish_reason": "stop"}
