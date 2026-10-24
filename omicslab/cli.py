"""素问 SuWen command line entry point.

Subcommands
-----------
``serve``   Start the local web workbench (default).
``cli``     Interactive terminal chat with the agent (plus a one-shot ``-p`` mode).
``env``     Environment doctor: dependencies, paths, model configuration, kernel.
``config``  Inspect or change persisted settings and API keys.
``skills``  List or inspect bundled / user skills.
``agents``  List available agents.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import platform
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Iterable

from . import __app_name__, __version__
from .config import DEFAULT_HOST, DEFAULT_PORT, PROVIDERS, ConfigError, Settings, load_settings

# ---------------------------------------------------------------------------
# console helpers (rich is optional)
# ---------------------------------------------------------------------------
try:  # pragma: no cover - rich is part of the default install
    from rich.console import Console
    from rich.table import Table

    _RICH = True
except Exception:  # pragma: no cover
    Console = None  # type: ignore[assignment,misc]
    Table = None  # type: ignore[assignment,misc]
    _RICH = False


def _console():
    if _RICH:
        return Console(highlight=False, soft_wrap=True)
    return _PlainConsole()


class _PlainConsole:
    """Minimal fallback used when rich is unavailable."""

    def print(self, *args: Any, **kwargs: Any) -> None:
        sep = kwargs.get("sep", " ")
        print(sep.join(str(a) for a in args))

    def rule(self, title: str = "") -> None:
        print(f"--- {title} ---" if title else "---")


def _paint(console: Any, text: str, style: str = "") -> None:
    if _RICH and style:
        console.print(f"[{style}]{text}[/{style}]")
    else:
        console.print(text)


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="suwen",
        description=f"{__app_name__} {__version__} - 本地优先的生物医学分析智能体工作台",
    )
    parser.add_argument("--version", action="version", version=f"{__app_name__} {__version__}")

    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="启动本地 Web 工作台")
    _add_common(serve)
    serve.add_argument("--host", default=None, help=f"监听地址（默认 {DEFAULT_HOST}）")
    serve.add_argument("--port", type=int, default=None, help=f"监听端口（默认 {DEFAULT_PORT}）")
    serve.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    serve.add_argument("--log-level", default="info", choices=["critical", "error", "warning", "info", "debug"])
    serve.set_defaults(handler=cmd_serve)

    chat = sub.add_parser("cli", help="在终端里与智能体对话")
    _add_common(chat)
    chat.add_argument("-p", "--prompt", default=None, help="单次提问后退出（非交互模式）")
    chat.add_argument("--agent", default=None, help="使用的智能体 id")
    chat.add_argument("--provider", default=None, help="本次会话使用的模型供应商")
    chat.add_argument("--model", default=None, help="本次会话使用的模型名")
    chat.add_argument("--new", action="store_true", help="强制新建会话")
    chat.set_defaults(handler=cmd_cli)

    env = sub.add_parser("env", help="环境自检（依赖 / 路径 / 模型 / 内核）")
    _add_common(env)
    env.add_argument("--json", action="store_true", help="以 JSON 输出")
    env.add_argument("--strict", action="store_true", help="依赖缺失时返回非零退出码")
    env.add_argument(
        "action",
        nargs="?",
        default=None,
        choices=["doctor"],
        help="可选：doctor（兼容 `omicslab env doctor` 写法）",
    )
    env.set_defaults(handler=cmd_env)

    doctor = sub.add_parser("doctor", help="env 的别名")
    _add_common(doctor)
    doctor.add_argument("--json", action="store_true", help="以 JSON 输出")
    doctor.add_argument("--strict", action="store_true", help="依赖缺失时返回非零退出码")
    doctor.set_defaults(handler=cmd_env)

    config = sub.add_parser("config", help="查看/修改设置与 API Key")
    _add_common(config)
    cfg_sub = config.add_subparsers(dest="config_action")
    cfg_show = cfg_sub.add_parser("show", help="显示当前设置（默认）")
    cfg_show.add_argument("--json", action="store_true")
    cfg_set = cfg_sub.add_parser("set", help="设置一个配置项")
    cfg_set.add_argument("key")
    cfg_set.add_argument("value")
    cfg_keys = cfg_sub.add_parser("keys", help="查看已配置的 API Key（掩码）")
    cfg_keys.add_argument("--json", action="store_true")
    cfg_set_key = cfg_sub.add_parser("set-key", help="写入某个供应商的 API Key")
    cfg_set_key.add_argument("provider", help="供应商 id（如 deepseek / openai / qwen / anthropic）或环境变量名")
    cfg_set_key.add_argument("value", help="API Key")
    config.set_defaults(handler=cmd_config, config_action="show")

    skills = sub.add_parser("skills", help="列出内置/自定义技能")
    _add_common(skills)
    skills.add_argument("name", nargs="?", default=None, help="查看某个技能的完整内容")
    skills.add_argument("--json", action="store_true")
    skills.set_defaults(handler=cmd_skills)

    agents = sub.add_parser("agents", help="列出可用智能体")
    _add_common(agents)
    agents.add_argument("name", nargs="?", default=None, help="查看某个智能体的详情")
    agents.add_argument("--json", action="store_true")
    agents.set_defaults(handler=cmd_agents)

    discovery = sub.add_parser("discovery", help="RSI 科研发现项目（假设→实验→证据→报告）")
    _add_common(discovery)
    dsub = discovery.add_subparsers(dest="discovery_action")
    dsub.add_parser("list", help="列出发现项目（默认）")
    d_create = dsub.add_parser("create", help="创建发现项目")
    d_create.add_argument("objective", help="可检验的研究目标")
    d_create.add_argument("--title", default="", help="项目标题")
    d_create.add_argument("--domain", default="biomedicine", help="领域（single-cell/spatial/flow/clinical…）")
    d_create.add_argument("--hints", default="", help="数据文件路径，逗号分隔")
    d_create.add_argument("--rounds", type=int, default=3, help="最多迭代轮次")
    d_create.add_argument("--budget", type=int, default=30, help="时间预算（分钟）")
    d_create.add_argument("--agent", default="lead", help="执行智能体 id")
    d_run = dsub.add_parser("run", help="运行 RSI 发现循环（需可用模型与内核）")
    d_run.add_argument("project_id", help="发现项目 ID")
    d_run.add_argument("--max-rounds", type=int, default=None, help="本次最多轮次")
    d_status = dsub.add_parser("status", help="查看项目台账")
    d_status.add_argument("project_id")
    d_report = dsub.add_parser("report", help="打印项目报告")
    d_report.add_argument("project_id")
    d_delete = dsub.add_parser("delete", help="删除项目")
    d_delete.add_argument("project_id")
    discovery.set_defaults(handler=cmd_discovery, discovery_action="list")

    return parser


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", default=None, help="工作区目录（默认当前目录）")
    parser.add_argument("--home", default=None, help="素问 SuWen 用户数据目录（默认 ~/.omicslab）")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _load_settings(args: argparse.Namespace) -> Settings:
    settings = load_settings(workspace=args.workspace, home=getattr(args, "home", None))
    settings.ensure_dirs()
    return settings


def _mask(value: str) -> str:
    value = value or ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def _short(text: str, limit: int = 160) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _have(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


_REQUIRED = ["fastapi", "uvicorn", "jupyter_client", "ipykernel", "nbformat"]
_NICE_TO_HAVE = [
    "httpx",
    "yaml",
    "rich",
    "prompt_toolkit",
    "numpy",
    "pandas",
    "matplotlib",
    "websockets",
    "multipart",
    "pytest",
]


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------
def cmd_serve(args: argparse.Namespace) -> int:
    from .server import create_app

    settings = _load_settings(args)
    if args.host:
        settings.update({"host": args.host})
    if args.port:
        settings.update({"port": args.port})
    host, port = settings.host, int(settings.port)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    console = _console()

    model_line = "未配置模型（可用 mock 演示模式，或运行 suwen config set-key deepseek <KEY>）"
    try:
        target = settings.resolve_llm()
        configured = bool(target.api_key) or target.family == "mock"
        model_line = f"{target.provider} / {target.model}" + ("" if configured else "（未检测到 API Key）")
    except Exception as exc:  # pragma: no cover - defensive
        model_line = f"模型配置异常：{exc}"

    _paint(console, f"{__app_name__} {__version__}", "bold")
    console.print(f"  工作区   {settings.workspace}")
    console.print(f"  数据目录 {settings.home}")
    console.print(f"  模型     {model_line}")
    console.print(f"  界面     {url}")
    console.print("  按 Ctrl+C 停止服务")
    console.rule("")

    if not args.no_open:
        def _open() -> None:
            time.sleep(1.2)
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=_open, daemon=True, name="omicslab-open-browser").start()

    app = create_app(settings)
    _configure_event_loop()
    try:
        import uvicorn

        uvicorn.run(
            app,
            host=host,
            port=port,
            log_level=args.log_level,
            access_log=False,
            loop="omicslab.server.loop:selector_loop_factory",
        )
    except KeyboardInterrupt:  # pragma: no cover - interactive
        console.print("\n已停止。")
        return 0
    except SystemExit as exc:  # pragma: no cover - uvicorn exit
        return int(getattr(exc, "code", 0) or 0)
    except OSError as exc:  # pragma: no cover - port conflict
        _paint(console, f"启动失败：{exc}", "red")
        console.print(f"提示：端口 {port} 可能已被占用，可尝试 `suwen serve --port {port + 1}`。")
        return 2
    return 0


# ---------------------------------------------------------------------------
# env doctor
# ---------------------------------------------------------------------------
def collect_env_report(settings: Settings) -> dict[str, Any]:
    missing_required = [name for name in _REQUIRED if not _have(name)]
    missing_optional = [name for name in _NICE_TO_HAVE if not _have(name)]

    kernel_python = ""
    kernel_python_exists = False
    try:
        kernel_python = settings.resolve_kernel_python()
        kernel_python_exists = Path(kernel_python).exists()
    except Exception as exc:  # pragma: no cover - defensive
        kernel_python = f"<无法解析：{exc}>"

    llm: dict[str, Any] = {}
    try:
        target = settings.resolve_llm()
        llm = {
            "provider": target.provider,
            "model": target.model,
            "api_base": target.api_base,
            "configured": bool(target.api_key) or target.family == "mock",
            "demo_mode": target.family == "mock",
        }
    except Exception as exc:
        llm = {"error": str(exc)}

    keys: dict[str, bool] = {}
    try:
        auth = settings.auth()
        for pid, meta in PROVIDERS.items():
            env_key = str(meta.get("env_key") or "")
            keys[pid] = bool(auth.get(env_key) or auth.get(pid))
    except Exception:  # pragma: no cover - defensive
        pass

    agents: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    try:
        from .agent.templates import load_agents

        agents = [{"id": agent_id, "name": agent.name, "description": agent.description} for agent_id, agent in load_agents(settings).items()]
    except Exception:
        pass
    try:
        from .agent.skills import load_skills

        skills = [{"name": skill.name, "description": skill.description} for skill in load_skills(settings).values()]
    except Exception:
        pass

    paths = {
        "workspace": str(settings.workspace),
        "home": str(settings.home),
        "settings": str(settings.settings_path),
        "auth": str(settings.auth_path),
        "log": str(settings.log_path),
        "figures": str(settings.figures_dir),
        "conversations": str(settings.conversations_dir),
        "jobs": str(settings.jobs_dir),
        "memory": str(settings.memory_dir),
        "kernels": str(settings.kernels_dir),
    }
    return {
        "version": __version__,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "cwd": os.getcwd(),
        },
        "dependencies": {
            "required": {name: name not in missing_required for name in _REQUIRED},
            "optional": {name: name not in missing_optional for name in _NICE_TO_HAVE},
            "missing_required": missing_required,
            "missing_optional": missing_optional,
        },
        "kernel": {
            "python": kernel_python,
            "exists": kernel_python_exists,
            "configured": settings.kernel_python,
        },
        "llm": llm,
        "keys": keys,
        "paths": paths,
        "counts": {"agents": len(agents), "skills": len(skills)},
        "agents": agents,
        "skills": skills,
        "settings_paths_exist": {key: Path(value).exists() for key, value in paths.items()},
    }


def cmd_env(args: argparse.Namespace) -> int:
    settings = _load_settings(args)
    report = collect_env_report(settings)
    if getattr(args, "json", False):
        print(json.dumps(report, ensure_ascii=False, indent=2))
        missing = report["dependencies"]["missing_required"]
        return 1 if (missing and getattr(args, "strict", False)) else 0

    console = _console()
    _paint(console, f"{__app_name__} {__version__} 环境自检", "bold")
    console.rule("运行环境")
    console.print(f"  系统       {report['platform']['system']} {report['platform']['release']}")
    console.print(f"  Python     {report['platform']['python']}  ({report['platform']['executable']})")
    console.print(f"  当前目录   {report['platform']['cwd']}")

    console.rule("依赖")
    for group_name, group in (("必需", report["dependencies"]["required"]), ("可选", report["dependencies"]["optional"])):
        line = "  " + group_name + "  " + "  ".join(
            (f"[green]{name}[/green]" if ok else f"[red]{name}[/red]") if _RICH else (f"{name}" if ok else f"{name}(缺失)")
            for name, ok in group.items()
        )
        console.print(line) if _RICH else console.print(line)

    console.rule("模型")
    llm = report["llm"]
    if "error" in llm:
        _paint(console, f"  配置错误：{llm['error']}", "red")
    else:
        status = "已配置" if llm["configured"] else "未配置（可用演示模式）"
        console.print(f"  当前      {llm['provider']} / {llm['model']}  [{status}]")
        console.print(f"  接口      {llm['api_base'] or '(默认)'}")
    configured_keys = [name for name, ok in report["keys"].items() if ok]
    console.print(f"  已存 Key  {', '.join(configured_keys) if configured_keys else '(无)'}")

    console.rule("内核")
    kernel = report["kernel"]
    mark = "✔" if kernel["exists"] else "✘"
    console.print(f"  Python    {kernel['python']} {mark}")
    console.print(f"  配置项    {kernel['configured'] or '(自动)'}")

    console.rule("扩展与路径")
    console.print(f"  工作区    {report['paths']['workspace']}")
    console.print(f"  数据目录  {report['paths']['home']}")
    console.print(f"  设置文件  {report['paths']['settings']}  {'存在' if report['settings_paths_exist']['settings'] else '不存在'}")
    console.print(f"  智能体    {report['counts']['agents']} 个")
    console.print(f"  技能      {report['counts']['skills']} 个")
    return 1 if (report["dependencies"]["missing_required"] and getattr(args, "strict", False)) else 0


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
def cmd_config(args: argparse.Namespace) -> int:
    settings = _load_settings(args)
    action = getattr(args, "config_action", None) or "show"
    console = _console()

    if action == "set":
        value = _coerce(args.value)
        try:
            settings.update({args.key: value})
            settings.save()
        except Exception as exc:
            _paint(console, f"设置失败：{exc}", "red")
            return 1
        console.print(f"已设置 {args.key} = {args.value}")
        return 0

    if action == "set-key":
        provider = args.provider.strip()
        env_key = str(PROVIDERS.get(provider, {}).get("env_key") or "").strip()
        if not env_key:
            if provider.isupper() or provider.endswith("_KEY"):
                env_key = provider
            else:
                _paint(console, f"未知供应商：{provider}（可用：{', '.join(sorted(PROVIDERS))}）", "red")
                return 1
        try:
            settings.set_keys({env_key: args.value.strip()})
            settings.save()
        except Exception as exc:
            _paint(console, f"写入失败：{exc}", "red")
            return 1
        console.print(f"已为 {provider if provider in PROVIDERS else env_key} 保存 API Key（{_mask(args.value.strip())}）")
        return 0

    keys = _collected_keys(settings)
    if action == "keys":
        if getattr(args, "json", False):
            print(json.dumps({name: _mask(value) for name, value in keys.items()}, ensure_ascii=False, indent=2))
            return 0
        console.rule("已保存的 API Key")
        if not keys:
            console.print("  (无)")
        for name, value in sorted(keys.items()):
            console.print(f"  {name:<28} {_mask(value)}")
        return 0

    # show
    data = {
        "version": __version__,
        "provider": settings.provider,
        "model": settings.model,
        "api_base": settings.api_base,
        "temperature": settings.temperature,
        "max_tokens": settings.max_tokens,
        "approval_policy": settings.approval_policy,
        "allow_shell": settings.allow_shell,
        "allow_file_write": settings.allow_file_write,
        "default_agent": settings.default_agent,
        "workspace": str(settings.workspace),
        "home": str(settings.home),
        "settings_path": str(settings.settings_path),
    }
    if getattr(args, "json", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    console.rule("当前设置")
    for key, value in data.items():
        console.print(f"  {key:<18} {value}")
    return 0


def _coerce(value: str) -> Any:
    lowered = value.strip().lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def _collected_keys(settings: Settings) -> dict[str, str]:
    try:
        auth = settings.auth()
    except Exception:
        return {}
    result = {}
    for name, value in auth.items():
        if isinstance(value, str) and value.strip():
            result[name] = value
    return result


# ---------------------------------------------------------------------------
# skills / agents listing
# ---------------------------------------------------------------------------
def cmd_skills(args: argparse.Namespace) -> int:
    settings = _load_settings(args)
    from .agent.skills import load_skills

    skills = load_skills(settings)
    console = _console()
    if args.name:
        skill = skills.get(args.name)
        if skill is None:
            _paint(console, f"技能不存在：{args.name}", "red")
            _print_skill_names(console, skills)
            return 1
        if getattr(args, "json", False):
            print(json.dumps(skill.to_dict() | {"body": skill.body, "files": skill.files}, ensure_ascii=False, indent=2))
            return 0
        _paint(console, f"{skill.name}", "bold")
        console.print(f"  来源：{skill.source}")
        console.print(f"  路径：{skill.path}")
        if skill.description:
            console.print(f"  说明：{skill.description}")
        console.print("")
        console.print(skill.body or "(空)")
        if skill.files:
            console.print("\n附带文件：" + ", ".join(skill.files))
        return 0

    if getattr(args, "json", False):
        print(json.dumps([skill.to_dict() for skill in skills.values()], ensure_ascii=False, indent=2))
        return 0
    console.rule(f"技能（{len(skills)}）")
    if not skills:
        console.print("  (未找到技能，可在 <workspace>/skills/ 下新增)")
        return 0
    for name, skill in sorted(skills.items()):
        console.print(f"  {name:<28} {_short(skill.description or skill.when_to_use or '', 70)}")
    console.print("\n使用 `suwen skills <name>` 查看完整内容。")
    return 0


def _print_skill_names(console: Any, skills: dict[str, Any]) -> None:
    if skills:
        console.print("可用技能：" + ", ".join(sorted(skills)))


def cmd_agents(args: argparse.Namespace) -> int:
    settings = _load_settings(args)
    from .agent.templates import load_agents

    agents = load_agents(settings)
    console = _console()
    if args.name:
        agent = agents.get(args.name)
        if agent is None:
            _paint(console, f"智能体不存在：{args.name}", "red")
            if agents:
                console.print("可用智能体：" + ", ".join(sorted(agents)))
            return 1
        if getattr(args, "json", False):
            print(json.dumps(agent.to_dict(), ensure_ascii=False, indent=2))
            return 0
        _paint(console, f"{agent.name} ({agent.id})", "bold")
        if agent.description:
            console.print(f"  说明：{agent.description}")
        if agent.toolsets:
            console.print(f"  工具集：{', '.join(agent.toolsets)}")
        if agent.skills:
            console.print(f"  技能：{', '.join(agent.skills)}")
        if agent.category:
            console.print(f"  分类：{agent.category}")
        console.print("")
        console.print(agent.instructions or "(无附加指令)")
        return 0

    if getattr(args, "json", False):
        print(json.dumps([agent.to_dict() for agent in agents.values()], ensure_ascii=False, indent=2))
        return 0
    console.rule(f"智能体（{len(agents)}）")
    for agent_id, agent in sorted(agents.items()):
        console.print(f"  {agent_id:<26} {agent.name:<20} {_short(agent.description or '', 60)}")
    return 0


# ---------------------------------------------------------------------------
# discovery (RSI research loop)
# ---------------------------------------------------------------------------
def _discovery_event_line(console: Any, event: Any) -> None:
    kind = getattr(event, "type", "")
    data = getattr(event, "data", {}) or {}
    if kind != "discovery":
        if kind == "error":
            _paint(console, f"[错误] {data.get('message') or ''}", "red")
        return
    sub = str(data.get("kind") or "")
    if sub == "status":
        console.print(f"[发现] {data.get('text') or ''}")
    elif sub == "round":
        phase = data.get("phase")
        index = data.get("index") or ""
        if phase == "observe":
            strategy = (data.get("strategy") or {}).get("name") or "（无）"
            console.print(f"[第 {index} 轮] 观察完成，策略：{strategy}")
        elif phase == "preregister":
            console.print(f"[第 {index} 轮] 预注册：{_short(str(data.get('plan') or ''), 120)}")
    elif sub == "hypothesis":
        hypothesis = data.get("hypothesis") or {}
        console.print(
            f"[假设/{hypothesis.get('status') or ''}] {_short(str(hypothesis.get('statement') or ''), 160)}"
        )
    elif sub == "evidence":
        evidence = data.get("evidence") or {}
        console.print(
            f"[证据/{evidence.get('kind')}/{evidence.get('strength')}] "
            f"{_short(str(evidence.get('summary') or ''), 140)}"
        )
    elif sub == "insight":
        insight = data.get("insight") or {}
        console.print(f"[洞察] {_short(str(insight.get('text') or ''), 160)}")
    elif sub == "reflection":
        console.print(f"[反思] {_short(str(data.get('reflection') or ''), 160)}")
    elif sub == "strategy":
        strategy = data.get("strategy") or {}
        console.print(
            f"[策略/{data.get('phase') or ''}] {strategy.get('name') or ''} "
            f"(reward={strategy.get('reward')})"
        )
    elif sub == "report":
        console.print(
            f"[报告] 状态={data.get('status')}　路径={data.get('report_path') or '（未生成）'}"
        )
    elif sub == "finished":
        result = data.get("result") or {}
        console.print(f"[完成] {result.get('status')}，轮次={result.get('rounds')}")
    elif sub == "project":
        project = data.get("project") or {}
        console.print(f"[项目] {project.get('title') or ''} 状态={project.get('status') or data.get('phase')}")


async def _discovery_run_cli(settings: Settings, store: Any, project_id: str, max_rounds: int | None) -> int:
    from .agent.loop import AgentLoop
    from .agent.memory import MemoryStore
    from .agent.skills import load_skills
    from .agent.templates import load_agents
    from .agent.tools import build_registry
    from .discovery.engine import DiscoveryEngine
    from .kernel.manager import KernelService
    from .session.jobs import JobManager
    from .session.store import ConversationStore

    console = _console()
    try:
        project = store.get(project_id)
    except Exception:
        _paint(console, f"发现项目不存在：{project_id}", "red")
        return 1
    if max_rounds:
        project.max_rounds = max(1, min(int(max_rounds), 12))
        store.save(project)

    kernel = KernelService(settings)
    jobs = JobManager(settings)
    memory = MemoryStore(settings)
    conversations = ConversationStore(settings)
    agents = load_agents(settings)
    skills = load_skills(settings)
    registry = build_registry(settings)
    loop = AgentLoop(settings, kernel, conversations, registry, memory, jobs, agents, skills)
    engine = DiscoveryEngine(
        settings,
        kernel,
        registry,
        store,
        agents=agents,
        skills=skills,
        loop=loop,
        conversation_store=conversations,
    )
    try:
        registry.discovery_store = store
        registry.discovery_engine = engine
        registry.agent_loop = loop
    except Exception:  # pragma: no cover - defensive
        pass

    llm = "mock（启发式回退）"
    try:
        target = settings.resolve_llm()
        llm = f"{target.provider}/{target.model}"
    except Exception as exc:
        _paint(console, f"模型配置不可用：{exc}（将使用启发式假设 + 真实内核执行）", "yellow")

    async def emit(event: Any) -> None:
        _discovery_event_line(console, event)

    _paint(
        console,
        f"开始 RSI 发现循环：{project.title}（最多 {project.max_rounds} 轮，模型 {llm}）",
        "bold",
    )
    try:
        await asyncio.wait_for(kernel.start(), timeout=90)
    except Exception as exc:
        _paint(console, f"内核启动失败：{exc}（实验执行可能无法完成）", "yellow")

    result: dict[str, Any] = {"status": "failed"}
    try:
        result = await engine.run(
            project_id,
            emit=emit,
            cancel_event=None,
            approver=CliApprover(policy="auto"),
        )
    except KeyboardInterrupt:
        _paint(console, "已取消", "yellow")
        result = {"status": "cancelled", "rounds": 0}
    finally:
        try:
            jobs.shutdown()
        except Exception:
            pass
        try:
            await kernel.stop()
        except Exception:
            pass

    final = store.get(project_id)
    console.rule("发现结果")
    console.print(f"状态：{result.get('status')}　轮次：{result.get('rounds')}　摘要：{final.summary or '（无）'}")
    report_path = result.get("report_path") or ""
    if report_path:
        _paint(console, f"报告：{report_path}", "green")
    return 0 if result.get("status") == "done" else 1


def cmd_discovery(args: argparse.Namespace) -> int:
    """List / create / run / inspect RSI discovery projects."""
    from .discovery.ledger import ProjectNotFound, ProjectStore

    settings = _load_settings(args)
    store = ProjectStore(settings)
    console = _console()
    action = getattr(args, "discovery_action", None) or "list"

    if action == "list":
        projects = store.list_projects()
        if not projects:
            _paint(
                console,
                '尚无发现项目。用 `suwen discovery create "研究目标" --hints data.csv` 创建。',
                "yellow",
            )
            return 0
        console.rule(f"发现项目（{len(projects)}）")
        for project in projects:
            console.print(
                f"  {project.id:<14} {project.status:<10} "
                f"{project.rounds_count}/{project.max_rounds}  {_short(project.title, 64)}"
            )
        return 0

    if action == "create":
        hints = [item.strip() for item in str(getattr(args, "hints", "") or "").replace("\n", ",").split(",") if item.strip()]
        project = store.create(
            title=str(getattr(args, "title", "") or ""),
            objective=str(getattr(args, "objective", "") or ""),
            domain=str(getattr(args, "domain", "") or "biomedicine"),
            agent=str(getattr(args, "agent", "") or "lead"),
            data_hints=hints,
            max_rounds=int(getattr(args, "rounds", 3) or 3),
            budget_minutes=int(getattr(args, "budget", 30) or 30),
        )
        _paint(console, f"已创建发现项目 {project.id}：{project.title}", "green")
        console.print(f"运行：suwen discovery run {project.id}")
        return 0

    project_id = str(getattr(args, "project_id", "") or "")
    try:
        project = store.get(project_id)
    except ProjectNotFound:
        _paint(console, f"发现项目不存在：{project_id}", "red")
        return 1

    if action == "delete":
        store.delete(project_id)
        _paint(console, f"已删除发现项目 {project_id}", "green")
        return 0

    if action == "status":
        snapshot = store.snapshot(project_id)
        console.rule(f"{project.title}（{project.id}）")
        console.print(
            f"状态：{project.status}　轮次：{project.rounds_count}/{project.max_rounds}　"
            f"目标：{project.objective}"
        )
        console.print(f"摘要：{project.summary or '（无）'}")
        console.print(f"\n假设（{len(snapshot['hypotheses'])}）：")
        for item in snapshot["hypotheses"]:
            console.print(
                f"  [{item['round']}] {item['status']:<12} {item['confidence']:.2f}  "
                f"{_short(str(item['statement']), 140)}"
            )
        console.print(f"\n证据（{len(snapshot['evidence'])}）：")
        for item in snapshot["evidence"][-10:]:
            console.print(
                f"  {item['id']}  {item['kind']}/{item['strength']}  {_short(str(item['summary']), 140)}"
            )
        console.print(f"\n洞察（{len(snapshot['insights'])}）：")
        for item in snapshot["insights"][-8:]:
            console.print(f"  - {_short(str(item['text']), 160)}")
        return 0

    if action == "report":
        markdown = store.read_report(project_id)
        if not markdown:
            _paint(console, "该项目尚未生成报告，请先运行 discovery run。", "yellow")
            return 1
        print(markdown)
        return 0

    if action == "run":
        return asyncio.run(
            _discovery_run_cli(settings, store, project_id, getattr(args, "max_rounds", None))
        )

    _paint(console, f"未知操作：{action}", "red")
    return 1


# ---------------------------------------------------------------------------
# interactive CLI
# ---------------------------------------------------------------------------
class CliApprover:
    """Terminal approver for the CLI (no browser round-trip available)."""

    def __init__(self, policy: str = "ask"):
        self.policy = policy or "ask"
        self._console = _console()

    async def request(self, ctx: Any, tool: str, arguments: dict[str, Any], reason: str) -> bool:
        if self.policy == "deny":
            return False
        if self.policy != "ask":
            return True
        payload = json.dumps(arguments or {}, ensure_ascii=False)
        if len(payload) > 600:
            payload = payload[:600] + "…"
        question = f"\n[审批] 工具 {tool}\n  参数：{payload}\n  原因：{reason or '无'}\n  允许吗？[y/N] "
        try:
            answer = await asyncio.to_thread(input, question)
        except (EOFError, KeyboardInterrupt):
            return False
        return answer.strip().lower() in ("y", "yes", "是", "允许")

    def resolve(self, approval_id: str, approved: bool) -> bool:  # pragma: no cover - unused in CLI
        return False

    def cancel_all(self, reason: str = "") -> None:  # pragma: no cover
        return None

    def pending(self) -> list[dict[str, Any]]:  # pragma: no cover
        return []


class CliPrinter:
    """Renders agent events in the terminal as they stream in."""

    def __init__(self, console: Any):
        self.console = console
        self._needs_newline = False
        self._in_text = False

    def _write(self, text: str, style: str = "") -> None:
        if _RICH and style:
            self.console.print(text, style=style, end="")
        else:
            self.console.print(text, end="")
        self._needs_newline = True

    def __call__(self, event: Any) -> None:
        kind = getattr(event, "type", "")
        data = getattr(event, "data", {}) or {}
        if kind == "text":
            delta = str(data.get("delta") or "")
            if delta:
                self._in_text = True
                self._write(delta)
        elif kind == "reasoning":
            return
        elif kind == "tool_call":
            self._break_line()
            name = data.get("name") or "tool"
            args_text = json.dumps(data.get("arguments") or {}, ensure_ascii=False)
            self.console.print(f"[工具] {name} {_short(args_text, 180)}")
        elif kind == "tool_result":
            self._break_line()
            ok = data.get("ok")
            mark = "OK" if ok else "FAIL"
            preview = _short(str(data.get("preview") or ""), 300)
            self.console.print(f"[结果] {data.get('name') or ''} {mark} {preview}")
        elif kind == "figure":
            self._break_line()
            self.console.print(f"[图] {data.get('title') or data.get('name') or ''} -> {data.get('url') or ''}")
        elif kind == "error":
            self._break_line()
            self.console.print(f"[错误] {data.get('message') or ''}")
        elif kind == "approval_request":
            self._break_line()
            self.console.print(f"[待审批] {data.get('tool')} {data.get('reason') or ''}")

    def _break_line(self) -> None:
        if self._needs_newline:
            self.console.print("")
            self._needs_newline = False
            self._in_text = False


REPL_HELP = """可用命令：
  /new            新建会话
  /open [序号]    列出或打开历史会话
  /agent [id]     查看或切换智能体
  /vars           查看当前内核变量
  /skills         列出技能
  /help           显示帮助
  /exit           退出
直接输入内容即可向智能体提问。"""


async def _repl(settings: Settings, args: argparse.Namespace) -> int:
    from .agent.types import AgentEvent, Conversation
    from .server.state import AppState

    console = _console()
    state = await AppState.create(settings)
    printer = CliPrinter(console)
    approver = CliApprover(settings.approval_policy)
    agent_id = args.agent or settings.default_agent or "lead"

    try:
        target = settings.resolve_llm(args.provider, args.model)
        model_line = f"{target.provider} / {target.model}"
    except Exception as exc:
        model_line = f"未配置（{exc}）"

    conv: Conversation | None = None
    if not args.new:
        try:
            existing = state.store.list()
        except Exception:
            existing = []
        if existing:
            try:
                conv = state.store.get(existing[0].get("id"))
            except Exception:
                conv = None
    if conv is None:
        conv = state.store.create(agent=agent_id, title="新会话")

    async def emit(event: AgentEvent) -> None:
        printer(event)

    async def run_turn(text: str) -> None:
        nonlocal conv
        assert conv is not None
        try:
            result = await state.loop.run(
                conv,
                text,
                emit=emit,
                cancel_event=None,
                approver=approver,
                agent_id=agent_id,
                provider=args.provider,
                model=args.model,
            )
        except KeyboardInterrupt:  # pragma: no cover - interactive
            console.print("\n[已中断]")
            return
        except Exception as exc:
            printer._break_line()
            _paint(console, f"[错误] {exc}", "red")
            return
        printer._break_line()
        try:
            state.store.save(conv)
        except Exception:
            pass
        usage = result.get("usage") or {}
        tokens = usage.get("total_tokens")
        if tokens:
            console.print(f"[完成] {result.get('finish_reason')} · {tokens} tokens")
        else:
            console.print(f"[完成] {result.get('finish_reason')}")

    try:
        if args.prompt:
            _paint(console, f"{__app_name__} {__version__} · {model_line}", "bold")
            console.print(f"工作区：{settings.workspace}")
            console.print("")
            await run_turn(args.prompt)
            return 0

        _paint(console, f"{__app_name__} {__version__} 终端会话", "bold")
        console.print(f"  模型   {model_line}")
        console.print(f"  工作区 {settings.workspace}")
        console.print("  输入 /help 查看命令，/exit 退出。")
        console.print("")

        while True:
            try:
                raw = await asyncio.to_thread(input, "你 > ")
            except (EOFError, KeyboardInterrupt):
                console.print("")
                break
            text = raw.strip()
            if not text:
                continue
            if text in ("/exit", "/quit", ":q"):
                break
            if text == "/help":
                console.print(REPL_HELP)
                continue
            if text == "/new":
                conv = state.store.create(agent=agent_id, title="新会话")
                console.print(f"已新建会话 {conv.id}")
                continue
            if text.startswith("/open"):
                parts = text.split()
                items = []
                try:
                    items = state.store.list()
                except Exception:
                    items = []
                if len(parts) == 1:
                    for index, item in enumerate(items[:20], start=1):
                        console.print(f"  {index:>2}. {item.get('title') or '(无标题)'}  {item.get('id')}")
                    continue
                try:
                    picked = items[int(parts[1]) - 1]
                    conv = state.store.get(picked["id"])
                    console.print(f"已打开会话：{conv.title}")
                except Exception:
                    _paint(console, "无效的会话序号", "red")
                continue
            if text.startswith("/agent"):
                parts = text.split(maxsplit=1)
                if len(parts) == 1:
                    for aid, agent in sorted(state.agents.items()):
                        mark = "→" if aid == agent_id else " "
                        console.print(f" {mark} {aid:<26} {agent.name}")
                    continue
                candidate = parts[1].strip()
                if candidate in state.agents:
                    agent_id = candidate
                    console.print(f"已切换到智能体：{agent_id}")
                else:
                    _paint(console, f"未知智能体：{candidate}", "red")
                continue
            if text == "/vars":
                try:
                    variables = await state.kernel.list_vars()
                except Exception as exc:
                    _paint(console, f"读取变量失败：{exc}", "red")
                    continue
                if not variables:
                    console.print("(内核中暂无变量)")
                for item in variables:
                    console.print(f"  {item.get('name'):<24} {item.get('type'):<22} {str(item.get('repr') or '')[:80]}")
                continue
            if text == "/skills":
                for name, skill in sorted(state.skills.items()):
                    console.print(f"  {name:<28} {_short(skill.description or '', 70)}")
                continue
            await run_turn(text)
            console.print("")
    finally:
        await state.shutdown()
    return 0


def cmd_cli(args: argparse.Namespace) -> int:
    settings = _load_settings(args)
    try:
        return asyncio.run(_repl(settings, args))
    except KeyboardInterrupt:  # pragma: no cover - interactive
        print("\n已退出。")
        return 0
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - defensive
        print(f"启动失败：{exc}", file=sys.stderr)
        return 1


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def _configure_event_loop() -> None:
    """Pick an event loop policy compatible with the ZMQ kernel client.

    On Windows the default Proactor loop cannot provide ``add_reader``, which
    ``jupyter_client`` needs to talk to the kernel. Any entry point that may
    start a kernel therefore selects the selector policy first.
    """

    if sys.platform != "win32":
        return
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:  # pragma: no cover - non standard builds
        pass


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 0
    _configure_event_loop()
    try:
        return int(handler(args) or 0)
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover - interactive
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
