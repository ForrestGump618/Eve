"""Task-scoped permissions. Tool arguments can never select their own mode."""
from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

MODES = {"ask", "review", "full"}
READ_TOOLS = {"workspace_info", "list_directory", "read_file", "search_files",
              "web_search", "web_fetch", "database_search", "skill_search",
              "skill_load", "skill_read_resource", "mcp_tools"}


def validate_mode(value: Any) -> str:
    if value not in MODES:
        raise ValueError("permission_mode 必须是 ask、review 或 full")
    return str(value)


def needs_approval(mode: str, tool: str, arguments: dict[str, Any]) -> tuple[bool, str]:
    validate_mode(mode)
    if tool in READ_TOOLS:
        return False, "只读工具"
    if mode == "full":
        return False, "用户为本任务授予完全权限"
    if mode == "review":
        # Only positively identified operations qualify. No shell parsing guesses,
        # pipelines, substitutions, executable files or unknown tools are allowed.
        if tool == "write_file":
            path = str(arguments.get("path") or "")
            suffix = PurePosixPath(path.replace("\\", "/")).suffix.lower()
            parts = PurePosixPath(path.replace("\\", "/")).parts
            sensitive = any(p.startswith('.') and p not in {'.', '..'} for p in parts) or PurePosixPath(path).name.lower() in {'agents.md', 'skill.md', 'requirements.txt'}
            if not sensitive and suffix in {".txt", ".md", ".csv", ".tsv"} and len(str(arguments.get("content") or "")) <= 200_000:
                return False, "审核通过：工作区内普通数据文件；执行时仍校验范围和文件版本"
        if tool == "run_shell":
            command = str(arguments.get("command") or "").strip()
            if re.fullmatch(r"(?:pwd|whoami|hostname|ls(?: -[alh]+)?|git (?:status(?: --short)?|diff(?: --stat)?|log -[1-9][0-9]?)|python3? --version)", command):
                return False, "审核通过：已识别的只读命令"
    return True, "请求批准：执行代码、修改文件、安装技能或未被明确识别的操作"
