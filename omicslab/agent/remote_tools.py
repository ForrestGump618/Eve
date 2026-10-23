"""Route standard agent tools to SSH after the registry's approval check."""
import json
import shlex
import time
import base64
import uuid
from urllib.parse import quote

REMOTE_TOOLS = {"run_python_code", "run_shell", "list_files", "read_file", "write_file",
                "get_system_info", "submit_background_job", "job_status", "export_notebook"}


async def execute_remote(ctx, name, args):
    from .tools import ToolError, ToolResult, MAX_TOOL_CONTENT, MAX_WRITE_BYTES
    backend = ctx.backend
    if name == "run_python_code":
        data = await backend.execute_python(str(args.get("code") or ""), args.get("timeout_s"))
        content = "\n".join(str(data.get(k) or "") for k in ("stdout", "stderr", "result_repr", "error")).strip()
        figures = []
        for image in data.pop("images", []):
            encoded = image.get("data_base64")
            if not encoded:
                continue
            path = f"figures/remote_{uuid.uuid4().hex[:12]}.png"
            await backend.make_dir("figures")
            await backend._call(backend._manager().write_bytes, backend.profile_id,
                                backend._resolve_path(path), base64.b64decode(encoded))
            url = f"/api/workspaces/{quote(backend.workspace.workspace_id)}/files/raw?path={quote(path)}"
            figures.append({"name": path.split("/")[-1], "path": path, "url": url, "mime": "image/png"})
            content += f"\n![{path}]({url})"
        data["figures"] = figures
    elif name == "run_shell":
        if not ctx.settings.allow_shell:
            raise ToolError("当前配置禁用了 Shell 工具")
        data = await backend.shell(str(args.get("command") or ""), cwd=str(args.get("cwd") or ""),
                                   timeout_s=args.get("timeout_s", args.get("timeout")))
        content = json.dumps(data, ensure_ascii=False, default=str)
    elif name == "list_files":
        data = await backend.list_dir(str(args.get("path") or "."), show_hidden=bool(args.get("show_hidden")))
        content = json.dumps(data, ensure_ascii=False, default=str)
    elif name == "read_file":
        data = await backend.read_text(str(args.get("path") or ""), max_bytes=int(args.get("max_bytes") or 200000))
        content = data.get("content", "")
    elif name == "write_file":
        if not ctx.settings.allow_file_write:
            raise ToolError("当前配置禁用了文件写入")
        content = args.get("content")
        if content is None or not args.get("path"):
            raise ToolError("path 与 content 为必填参数")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, indent=2)
        if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
            raise ToolError("写入内容超过单次上限")
        data = await backend.write_text(str(args["path"]), content)
        content = json.dumps(data, ensure_ascii=False)
    elif name == "get_system_info":
        data = await backend.probe_environment()
        content = json.dumps(data, ensure_ascii=False, default=str)
    elif name == "submit_background_job":
        if not ctx.settings.allow_shell:
            raise ToolError("当前配置禁用了后台进程")
        kind = str(args.get("kind") or "python").lower()
        command = str(args.get("code") or args.get("command") or "")
        if kind in {"python", "py"}:
            python = backend._python or await backend._call(backend._detect_python)
            command = shlex.quote(python) + " -u -c " + shlex.quote(command)
        elif kind not in {"shell", "bash", "sh", "cmd"}:
            raise ToolError("kind 只支持 python 或 shell")
        data = await backend.spawn_process(command, name=str(args.get("name") or ""))
        content = json.dumps(data, ensure_ascii=False, default=str)
    elif name == "job_status":
        data = (await backend.process_log(str(args["job_id"]))) if args.get("job_id") else {"jobs": await backend.process_list()}
        content = json.dumps(data, ensure_ascii=False, default=str)
    else:
        if not ctx.settings.allow_file_write:
            raise ToolError("当前配置禁用了文件写入")
        path = str(args.get("path") or f"notebooks/export_{int(time.time())}.ipynb")
        data = await backend.build_notebook(path=path)
        content = f"已导出远端 notebook：{path}"
    ok = data.get("ok", data.get("exit_code", 0) == 0)
    return ToolResult(tool_call_id="", name=name, ok=bool(ok), content=(content or "（无输出）")[:MAX_TOOL_CONTENT],
                      data=data, error=str(data.get("error") or "远端执行失败") if not ok else None)
