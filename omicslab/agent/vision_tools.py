"""Vision tools exposed to the agent (``analyze_image``).

The handler is deliberately thin: it resolves the image inside the workspace (or
figure gallery), calls :class:`~omicslab.agent.vision.VisionClient`, and returns
a normal :class:`ToolResult` so text-only chat models can reason about images.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from ..config import Settings
from .types import ToolResult
from .vision import MAX_IMAGE_BYTES, VisionClient, VisionError

logger = logging.getLogger("omicslab.agent.vision_tools")


def _resolve_image_path(ctx, raw: str) -> Path:
    """Resolve ``raw`` from workspace or figure gallery, rejecting traversal."""
    candidate = Path(str(raw or "")).expanduser()
    if candidate.is_file():
        return candidate
    try:
        workspace_path = ctx.resolve_in_workspace(raw)
    except Exception:
        workspace_path = None
    if workspace_path is not None and workspace_path.is_file():
        return workspace_path
    figures = Path(ctx.settings.figures_dir) / Path(str(raw or "")).name
    if figures.is_file():
        return figures
    raise VisionError(f"找不到图片：{raw}（可传工作区相对路径或图库文件名）")


async def _tool_analyze_image(ctx, args: dict) -> ToolResult:
    raw = str(args.get("path") or "").strip()
    if not raw:
        return ToolResult(tool_call_id="", name="analyze_image", ok=False, content="缺少参数 path")
    question = str(args.get("question") or "").strip()
    client = VisionClient(ctx.settings)
    if not client.configured:
        return ToolResult(
            tool_call_id="",
            name="analyze_image",
            ok=False,
            content=(
                "视觉模型尚未配置。请在设置页“视觉模型”卡片填写模型名、API 地址与 Key，"
                "或设置环境变量 VISION_API_KEY；配置后重试。"
            ),
        )
    try:
        path = _resolve_image_path(ctx, raw)
        if path.stat().st_size > MAX_IMAGE_BYTES:
            return ToolResult(
                tool_call_id="", name="analyze_image", ok=False,
                content=f"图片过大（>{MAX_IMAGE_BYTES // 1024 // 1024}MB），请压缩后重试。",
            )
        ctx.check_cancelled()
        description = await client.describe(
            path,
            question
            or "请详细描述这张图，并解读其中与生物医学分析相关的信息（坐标轴、分组、趋势、统计标注、可能结论与局限）。",
            timeout_s=120,
        )
    except VisionError as exc:
        return ToolResult(tool_call_id="", name="analyze_image", ok=False, content=str(exc))
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("analyze_image 调用失败")
        return ToolResult(
            tool_call_id="", name="analyze_image", ok=False, content=f"视觉模型调用失败：{exc}"
        )
    return ToolResult(
        tool_call_id="",
        name="analyze_image",
        ok=True,
        content=f"【视觉模型解读】{path.name}\n\n{description}",
        data={"path": str(path), "chars": len(description)},
    )


def register_vision_tools(registry, settings: Settings) -> None:
    """Register vision tools on ``registry`` (idempotent for safety)."""
    from .tools import ToolSpec

    if registry.has("analyze_image"):
        return
    registry.register(
        ToolSpec(
            name="analyze_image",
            description=(
                "调用视觉模型描述/解读一张图片（图表、显微图像、截图等）。"
                "path 为工作区相对路径或图库文件名；question 可指定想问的问题，"
                "适合在文本模型无法直接看图时获取图像信息。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "图片路径（工作区相对路径或图库文件名）。"},
                    "question": {"type": "string", "description": "针对图片的问题，可省略。"},
                },
                "required": ["path"],
            },
            toolset="vision",
            handler=_tool_analyze_image,
        )
    )
    logger.debug("已注册视觉工具 analyze_image")
