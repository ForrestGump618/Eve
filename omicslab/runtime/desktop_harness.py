"""Adapter from the full research UI to the desktop's single durable chat harness.

No model or tool loop lives here: Python owns the existing conversation/trace
projection, TypeScript Engine owns execution, budgets, tools and terminal state.
The authenticated pipe connection is injected in memory by the trusted launcher.
"""
from __future__ import annotations
import asyncio
import json
import os
import socket
import time
from pathlib import Path
from typing import Any


class DesktopHarness:
    def __init__(self, connection: dict[str, Any]):
        self._connection = connection

    def _request(self, method: str, params: dict[str, Any]) -> Any:
        wire = json.dumps({"token": self._connection["token"], "method": method, "params": params}).encode() + b"\n"
        if os.name == "nt":
            stream = open(self._connection["pipe"], "r+b", buffering=0)
        else:
            sock = socket.socket(socket.AF_UNIX)
            sock.settimeout(15)
            sock.connect(self._connection["pipe"])
            stream = sock.makefile("rwb", buffering=0)
        try:
            stream.write(wire)
            response = bytearray()
            while not response.endswith(b"\n"):
                chunk = stream.read(65536)
                if not chunk:
                    raise RuntimeError("Desktop harness closed its response")
                response.extend(chunk)
                if len(response) > 8_000_000:
                    raise RuntimeError("Desktop harness response exceeded limit")
            result = json.loads(response)
            if result.get("error"):
                raise RuntimeError(str(result["error"])[:600])
            return result.get("result")
        finally:
            stream.close()
            if os.name != "nt":
                sock.close()

    async def rpc(self, method: str, **params: Any) -> Any:
        return await asyncio.wait_for(asyncio.to_thread(self._request, method, params), 20)

    async def run(self, loop: Any, conv: Any, user_text: str, **kwargs: Any) -> dict[str, Any]:
        from ..agent.types import AgentEvent, ChatMessage
        emit = kwargs.get("emit")
        cancel = kwargs.get("cancel_event") or asyncio.Event()
        async def event(kind: str, data: dict[str, Any]) -> None:
            if emit:
                await emit(AgentEvent(kind, data))
        # Paid requests use the same unlocked desktop credentials. Settings saved
        # in the full UI remain authoritative and are passed only over the pipe.
        settings = loop.settings
        selected = settings.resolve_llm(provider=kwargs.get("provider"), model=kwargs.get("model"))
        # Configuration validation and API-key lookup stay in the existing provider layer.
        key = selected.api_key
        model_config = None
        if selected.provider != "mock" and key:
            requested_output = int(settings.max_tokens or 8192)
            model_config = dict(provider="anthropic" if selected.family=="anthropic" else "openai", baseUrl=selected.api_base, model=selected.model, apiKey=key, contextWindow=65536, maxOutput=max(128, min(requested_output, 32767)))
        messages = [{"role": m.role, "content": m.content} for m in conv.messages[-40:] if m.role in ("user", "assistant") and m.content]
        conv.messages.append(ChatMessage(role="user", content=user_text))
        if not conv.title or conv.title == "新会话":
            conv.title = user_text[:80]
        conv.updated_at = time.time()
        loop._save(conv)
        files = []
        workspace = Path(kwargs.get("workspace") or settings.workspace).resolve()
        for attachment in kwargs.get("attachments") or []:
            candidate = (workspace / str(attachment.get("path") or "")).resolve()
            if candidate.is_file() and candidate.is_relative_to(workspace):
                files.append(str(candidate))
        task = await self.rpc("create", name=user_text[:120], steps=[{"id":"reply","kind":"model","input":{"prompt":user_text,"messages":messages,"allowedFiles":files,"workspaceRoots":[str(workspace)]},"sideEffect":True,"maxAttempts":1,"timeoutMs":360000}], limits={"maxCalls":32,"maxTokens":240000,"maxWallMs":390000}, **({"modelConfig":model_config} if model_config else {}))
        task_id = task["id"]
        await event("status", {"text":"正在执行 · 统一 Harness", "task_id":task_id})
        seen = set()
        tool_results = {}
        last_text = ""
        try:
            while True:
                if cancel.is_set():
                    await self.rpc("control", id=task_id, action="cancel")
                    return {"finish_reason":"cancelled", "text":""}
                snapshot = await self.rpc("snapshot")
                current = next((x for x in snapshot["tasks"] if x["id"] == task_id), None)
                if current is None:
                    raise RuntimeError("Desktop task disappeared")
                stream_text = (current.get("stream") or {}).get("text", "")
                if stream_text != last_text:
                    last_text = stream_text
                    await event("text_snapshot", {"text":stream_text,"task_id":task_id})
                for trace in current.get("events", []):
                    if trace["sequence"] in seen:
                        continue
                    seen.add(trace["sequence"])
                    data = trace.get("data") or {}
                    kind = trace["type"]
                    if kind == "tool.started":
                        await event("tool_call", {"id":data.get("callId"),"name":data.get("name"),"arguments":{},"trace_id":data.get("traceId")})
                    elif kind in ("tool.completed", "tool.failed"):
                        preview = data.get("error") or "执行完成；原始结果保存在 Harness 产物中"
                        artifact_event = next((x for x in current.get("events",[]) if x["type"]=="agent.tool_artifact" and x.get("data",{}).get("callId")==data.get("callId")),None)
                        if artifact_event:
                            try:
                                raw = await self.rpc("artifact.read", taskId=task_id, artifactId=artifact_event["data"]["artifact"]["id"])
                                preview = str(raw.get("text") or preview)[:4000]
                            except Exception:
                                pass
                        tool_results[data.get("callId")] = {"ok":kind=="tool.completed","preview":preview,"duration_ms":data.get("durationMs")}
                        await event("tool_result", {"id":data.get("callId"),"tool_call_id":data.get("callId"),"name":data.get("name"),**tool_results[data.get("callId")],"data":data})
                    elif kind == "agent.verifying":
                        await event("status", {"text":"正在验证结果与引用"})
                    elif kind == "model.continuing":
                        await event("status", {"text":"正在接续长回答"})
                status = current["status"]
                if status == "completed":
                    output = current["steps"][-1].get("output") or {}
                    text = output.get("text") or ""
                    if not text.strip() or not output.get("verification",{}).get("passed"):
                        raise RuntimeError("Harness returned an unverified or empty answer")
                    tool_steps = []
                    for item in current.get("events", []):
                        if item["type"] != "tool.started":
                            continue
                        detail = item.get("data", {})
                        result = next((x.get("data", {}) for x in reversed(current.get("events", [])) if x["type"] in ("tool.completed", "tool.failed") and x.get("data", {}).get("callId") == detail.get("callId")), {})
                        tool_steps.append({"id":detail.get("callId"),"name":detail.get("name"),"result":tool_results.get(detail.get("callId")) or ({"ok":not bool(result.get("error")),"duration_ms":result.get("durationMs"),"preview":result.get("error") or "结果已回传模型；原始记录保存在 Harness 产物中"} if result else None)})
                    conv.messages.append(ChatMessage(role="assistant",content=text,meta={"run_id":kwargs.get("run_id"),"harness_task_id":task_id,"trace_id":output.get("traceId"),"sources":output.get("sources",[]),"tool_steps":tool_steps}))
                    conv.updated_at=time.time();loop._save(conv)
                    # Emit only verified final text; interim model preambles may be
                    # replaced between tool rounds and must not duplicate in this UI.
                    await event("text_snapshot", {"text":text,"task_id":task_id,"verified":True})
                    return {"finish_reason":"stop","text":text,"usage":{"total_tokens":current.get("tokens",0)},"evidence_gate":output.get("verification")}
                if status in ("failed","cancelled","waiting_approval","paused"):
                    error = next((x.get("error") for x in current["steps"] if x.get("error")), None) or status
                    await event("error", {"message":error,"code":"harness_"+status})
                    return {"finish_reason":"cancelled" if status=="cancelled" else "error","text":"","error":{"message":error}}
                await asyncio.sleep(.15)
        except BaseException:
            try:
                await self.rpc("control",id=task_id,action="cancel")
            except Exception:
                pass
            raise
