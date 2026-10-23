#!/usr/bin/env python
"""Suwen 端到端冒烟测试（离线、无需 API key、不污染你的数据目录）。

启动一个真实的服务进程（使用 mock 模型），在临时工作区里跑一遍核心链路：

  - 健康检查与会话列表
  - 对话流式事件（text / tool_call / tool_result / figure / done）
  - Python 内核执行、变量列表
  - 工作区文件写入 / 读取 / 删除
  - 图表画廊、技能库、智能体、记忆、模型连通性
  - 二期能力：设置/Provider 目录、视觉配置、函数注册表、RSI 科研发现、轨迹、SSH 档案

用法：

  python scripts/smoke.py            # 正常跑，结束后清理临时文件
  python scripts/smoke.py --keep     # 保留临时目录便于排查
  python scripts/smoke.py --port 5091

退出码：0 全部通过；1 有检查未通过；2 服务未能启动。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PASSED: list[str] = []
FAILED: list[str] = []
INFO: list[str] = []


def ok(name: str, detail: str = "") -> None:
    PASSED.append(name)
    print(f"  [ ok ] {name}{(' — ' + detail) if detail else ''}")


def fail(name: str, detail: str) -> None:
    FAILED.append(f"{name}: {detail}")
    print(f"  [fail] {name} — {detail}")


def info(text: str) -> None:
    INFO.append(text)
    print(f"  [info] {text}")


def expect(name: str, condition: Any, detail: str = "") -> bool:
    if condition:
        ok(name, detail)
        return True
    fail(name, detail or "检查未通过")
    return False


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_health(client: httpx.Client, proc: subprocess.Popen, timeout: float) -> dict[str, Any] | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        try:
            resp = client.get("/api/health", timeout=5)
            if resp.status_code == 200:
                return resp.json()
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    return None


def parse_sse(lines: Iterator[str]) -> Iterator[dict[str, Any]]:
    """Parse ``data:`` lines into flat event dicts.

    The wire format is ``{"type": ..., "data": {...}, "ts": ...}``; flattening
    the payload keeps assertions readable (``event["ok"]`` instead of
    ``event["data"]["ok"]``) while keeping the original nested ``data``.
    """
    for line in lines:
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            envelope = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if not isinstance(envelope, dict) or not isinstance(envelope.get("type"), str):
            continue
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        event = dict(data)
        event["type"] = envelope["type"]
        event.setdefault("data", data)
        if "ts" in envelope:
            event["ts"] = envelope["ts"]
        yield event


def chat(client: httpx.Client, message: str, timeout: float = 300) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with client.stream("POST", "/api/chat", json={"message": message, "agent": "lead"}, timeout=timeout) as resp:
        resp.raise_for_status()
        for event in parse_sse(resp.iter_lines()):
            events.append(event)
            if event["type"] in ("done", "error"):
                break
    return events


def main() -> int:  # noqa: C901 - keep the smoke script linear and readable
    # Windows consoles often default to GBK; force UTF-8 so Chinese output and the
    # final ✅ marker never raise UnicodeEncodeError.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            pass

    parser = argparse.ArgumentParser(description="Suwen end-to-end smoke test")
    parser.add_argument("--port", type=int, default=0, help="服务端口（默认随机空闲端口）")
    parser.add_argument("--timeout", type=float, default=240, help="等待服务就绪的秒数")
    parser.add_argument("--keep", action="store_true", help="结束后保留临时工作区")
    args = parser.parse_args()

    port = args.port or free_port()
    tmpdir = Path(tempfile.mkdtemp(prefix="omicslab-smoke-"))
    workspace = tmpdir / "workspace"
    home = tmpdir / "home"
    workspace.mkdir(parents=True)
    home.mkdir(parents=True)
    log_path = tmpdir / "server.log"
    log_file = log_path.open("w", encoding="utf-8", errors="replace")

    env = dict(os.environ)
    env["OMICSLAB_HOME"] = str(home)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # Keep the smoke test hermetic: never reach a real provider even if keys exist.
    env["OMICSLAB_LLM_PROVIDER"] = "mock"
    env["OMICSLAB_PROVIDER"] = "mock"

    cmd = [
        sys.executable, "-m", "omicslab", "serve",
        "--port", str(port), "--no-open", "--workspace", str(workspace),
    ]
    print(f"启动服务：{' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=str(ROOT), env=env,
        stdout=log_file, stderr=subprocess.STDOUT,
    )

    base = f"http://127.0.0.1:{port}"
    passed = True
    try:
        with httpx.Client(base_url=base, trust_env=False) as client:
            health = wait_health(client, proc, args.timeout)
            if health is None:
                print("\n服务未能就绪，日志末尾：")
                try:
                    print(log_path.read_text(encoding="utf-8", errors="replace")[-4000:])
                except OSError:
                    pass
                return 2
            ok("服务就绪", base)
            kernel = health.get("kernel") or {}
            expect("健康检查", health.get("ok") is True, f"version={health.get('version')}")
            if not kernel.get("running"):
                info(f"内核未运行：{health.get('startup_error') or '未知原因'}（内核相关检查将跳过）")
            else:
                ok("内核已启动", str(kernel.get("python") or ""))

            # ---------------------------------------------------------- chat
            events = chat(client, "按照内置演示流程跑一次分析，并画一张正弦波图表。")
            kinds = [event["type"] for event in events]
            errors = [event for event in events if event["type"] == "error"]
            done = next((event for event in events if event["type"] == "done"), {})
            if errors:
                info(f"错误事件：{json.dumps(errors[-1].get('data'), ensure_ascii=False)[:500]}")
            expect("对话流式输出", "text" in kinds, f"事件 {len(kinds)} 个")
            expect("工具调用", "tool_call" in kinds and "tool_result" in kinds)
            tool_results = [event for event in events if event["type"] == "tool_result"]
            if tool_results:
                last = tool_results[-1]
                if not last.get("ok"):
                    info(f"工具失败详情：{json.dumps(last.get('data'), ensure_ascii=False)[:500]}")
                    info(f"工具输出预览：{str(last.get('preview') or '')[:500]}")
                expect("工具执行成功", bool(last.get("ok")), str(last.get("name") or ""))
            expect("对话正常结束", done.get("finish_reason") in ("stop", "cancelled"), str(done.get("finish_reason")))

            convs = client.get("/api/conversations").json()
            items = convs.get("conversations") if isinstance(convs, dict) else convs
            expect("会话已保存", bool(items), f"{len(items or [])} 个会话")
            conv_id = (items[0] or {}).get("id") if items else None
            if conv_id:
                detail = client.get(f"/api/conversations/{conv_id}").json()
                messages = detail.get("messages") or []
                expect("会话含消息记录", len(messages) >= 2, f"{len(messages)} 条消息")

            # -------------------------------------------------------- kernel
            if kernel.get("running"):
                result = client.post("/api/kernel/execute", json={
                    "code": "import math\nsmoke_value = 6 * 7\nprint('smoke', smoke_value)\nmath.sqrt(4)",
                }).json()
                expect("内核执行", result.get("ok") is True, str(result.get("error") or ""))
                expect("产出 stdout", any(o.get("type") == "stream" for o in result.get("outputs") or []))
                variables = client.get("/api/kernel/vars").json()
                names = [item.get("name") for item in variables.get("vars") or []]
                expect("变量列表", "smoke_value" in names, ", ".join(str(n) for n in names[:8]))

                figure_dir = workspace / "figures"
                client.post("/api/kernel/execute", json={
                    "code": "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\n"
                            "ax.plot([0, 1, 2], [0, 1, 4])\nax.set_title('smoke')\nplt.show()\n",
                })
                time.sleep(0.5)
                figures = client.get("/api/figures").json()
                figure_items = figures.get("figures") if isinstance(figures, dict) else figures
                expect("图表入库", bool(figure_items or figure_dir.exists()),
                       f"{len(figure_items or [])} 张图")

            # --------------------------------------------------------- files
            write = client.post("/api/files/write", json={"path": "smoke/hello.txt", "content": "hello omicslab\n"})
            expect("文件写入", write.status_code == 200, str(write.status_code))
            read = client.get("/api/files/read", params={"path": "smoke/hello.txt"}).json()
            expect("文件读取", "hello omicslab" in (read.get("text") or ""))
            tree = client.get("/api/files/tree", params={"path": "."}).json()
            expect("目录树", isinstance(tree.get("entries"), list))
            deleted = client.delete("/api/files", params={"path": "smoke/hello.txt"})
            expect("文件删除", deleted.status_code == 200, str(deleted.status_code))

            # ----------------------------------------------------- catalogs
            agents = client.get("/api/agents").json()
            agent_items = agents.get("agents") if isinstance(agents, dict) else agents
            expect("智能体加载", len(agent_items or []) >= 7, f"{len(agent_items or [])} 个")
            skills = client.get("/api/skills").json()
            skill_items = skills.get("skills") if isinstance(skills, dict) else skills
            expect("技能加载", len(skill_items or []) >= 10, f"{len(skill_items or [])} 个")

            # ------------------------------------------------------- memory
            put = client.put("/api/memory/smoke-note", json={"title": "冒烟", "body": "smoke memory"})
            expect("记忆写入", put.status_code == 200, str(put.status_code))
            memory = client.get("/api/memory").json() if put.status_code == 200 else {}
            memory_items = memory.get("items") or []
            names = [item.get("slug") or item.get("name") for item in memory_items]
            expect("记忆列表", "smoke-note" in names, ", ".join(str(n) for n in names[:6]))
            client.delete("/api/memory/smoke-note")

            # ----------------------------------------------------- settings
            settings = client.get("/api/settings").json()
            llm = settings.get("llm") or {}
            expect("设置读取", settings.get("settings") is not None, f"provider={llm.get('provider')}")
            providers = settings.get("providers") or {}
            provider_ids = list(providers) if isinstance(providers, dict) else [
                item.get("id") for item in providers if isinstance(item, dict)
            ]
            expect(
                "Provider 目录",
                "ark" in provider_ids and "custom_openai" in provider_ids,
                ", ".join(str(item) for item in provider_ids[:10]),
            )
            expect("视觉配置信息", isinstance(settings.get("vision"), dict))
            vision_test = client.post("/api/settings/test_vision", json={}).json()
            expect("视觉连通性返回结构", "ok" in vision_test, str(vision_test.get("error") or "")[:120])
            saved = client.post(
                "/api/settings/keys",
                json={"key": "", "provider": "mock", "model": "mock-model", "api_base": ""},
            ).json()
            expect("密钥原子保存", saved.get("ok") is True and "saved_keys" in saved)
            test = client.post("/api/settings/test_llm", json={"provider": "mock", "model": "mock-model"}).json()
            expect("模型连通性", test.get("ok") is True, str(test.get("error") or test.get("reply"))[:80])

            # -------------------------------------------------- stage-2 APIs
            registry = client.post("/api/registry/refresh", json={"packages": ["json"]}).json()
            registry_items = (registry.get("stats") or {}).get("items") or 0
            expect("函数注册表构建", registry.get("ok") is True and registry_items > 0, f"{registry_items} 项")
            found = client.get("/api/registry/search", params={"q": "dumps", "limit": 5}).json()
            expect("函数注册表搜索", bool(found.get("items")), f"{len(found.get('items') or [])} 条结果")

            created = client.post(
                "/api/discovery/projects",
                json={
                    "title": "冒烟发现",
                    "objective": "比较两组模拟数据的组间差异并判断是否显著",
                    "max_rounds": 1,
                    "budget_minutes": 5,
                },
            ).json()
            project = created.get("project") or created
            project_id = project.get("id")
            expect("发现项目创建", bool(project_id), str(project_id))
            if project_id:
                events: list[dict[str, Any]] = []
                with client.stream(
                    "POST",
                    f"/api/discovery/projects/{project_id}/run",
                    json={},
                    timeout=600,
                ) as resp:
                    resp.raise_for_status()
                    for event in parse_sse(resp.iter_lines()):
                        events.append(event)
                        if event["type"] == "done":
                            break
                kinds = [event.get("kind") for event in events if event["type"] == "discovery"]
                expect(
                    "RSI 七步闭环运行",
                    any(kind in kinds for kind in ("hypothesis", "evidence", "reflection", "report", "finished")),
                    f"事件 {len(events)} 个，阶段 {', '.join(str(k) for k in kinds[:8])}",
                )
                report = client.get(f"/api/discovery/projects/{project_id}/report").json()
                report_text = report.get("report") or report.get("markdown") or report.get("content") or ""
                expect("发现报告生成", len(report_text) > 80, f"{len(report_text)} 字符")
                snapshot = client.get(f"/api/discovery/projects/{project_id}").json()
                expect(
                    "发现项目台账",
                    bool(snapshot.get("hypotheses")),
                    f"{len(snapshot.get('hypotheses') or [])} 条假设",
                )

            trajectories = client.get("/api/trajectories", params={"conversation_id": conv_id or ""}).json()
            expect("轨迹记录", (trajectories.get("count") or 0) >= 1, f"{trajectories.get('count')} 条轨迹")

            profiles = client.get("/api/ssh/profiles").json()
            expect("SSH 档案列表", isinstance(profiles.get("profiles"), list), f"{len(profiles.get('profiles') or [])} 个档案")

            # -------------------------------------------------------- runtime
            runtime = client.get("/api/runtime/diagnostics").json()
            runtime_info = runtime.get("runtime") or {}
            expect(
                "运行时诊断",
                runtime_info.get("schema_version") == 3,
                f"schema={runtime_info.get('schema_version')} active={runtime_info.get('active_runs')}",
            )
            workspaces = client.get("/api/workspaces").json()
            default_id = workspaces.get("default_id")
            created_ws = client.post("/api/workspaces", json={"name": "冒烟工作区"})
            ws_body = created_ws.json()
            ws = ws_body.get("workspace") or ws_body
            ws_id = ws.get("workspace_id") or ws.get("id")
            expect("工作区创建", bool(ws_id) and ws_id != default_id, str(ws_id))
            if ws_id:
                probe = client.post(f"/api/workspaces/{ws_id}/probe").json()
                expect("工作区探测", bool(probe.get("ok")), str(probe.get("path") or probe.get("error")))
                client.delete(f"/api/workspaces/{ws_id}")

            config_payload = client.get("/api/runtime/config").json()
            config_body = config_payload.get("config") or config_payload
            expect("运行限制读取", "max_child_tasks" in config_body, "")
            patched = client.put("/api/runtime/config", json={"patch": {"max_child_tasks": 3}})
            patched_body = patched.json().get("config") or patched.json()
            expect(
                "运行限制更新",
                int(patched_body.get("max_child_tasks") or 0) == 3,
                str(patched_body.get("max_child_tasks")),
            )

            if conv_id:
                request_id = f"smoke-{int(time.time() * 1000)}"
                first = client.post(
                    f"/api/sessions/{conv_id}/runs",
                    json={"message": "运行时幂等与重放检查", "client_request_id": request_id},
                    timeout=60,
                ).json()
                run_body = first.get("run") or {}
                run_id = first.get("run_id") or run_body.get("run_id")
                trace_id = first.get("trace_id") or run_body.get("trace_id")
                expect("会话运行提交", bool(run_id), str(run_id))
                duplicate = client.post(
                    f"/api/sessions/{conv_id}/runs",
                    json={"message": "运行时幂等与重放检查", "client_request_id": request_id},
                    timeout=60,
                ).json()
                duplicate_id = duplicate.get("run_id") or (duplicate.get("run") or {}).get("run_id")
                expect("幂等提交", duplicate.get("idempotent") is True and duplicate_id == run_id)
                status = ""
                deadline = time.time() + 120
                while time.time() < deadline:
                    row = client.get(f"/api/runs/{run_id}").json()
                    status = row.get("status") or ""
                    if status in ("succeeded", "failed", "cancelled", "interrupted"):
                        break
                    time.sleep(0.5)
                expect("运行完成", status == "succeeded", status)
                replay = client.get(f"/api/traces/{trace_id}/events").json()
                frames = replay.get("events") or []
                expect("断线可重放", len(frames) >= 4, f"{len(frames)} 帧")
                children = client.get(f"/api/runs/{run_id}/children").json()
                expect("子任务查询", isinstance(children.get("children"), list), f"{children.get('count')} 个子任务")

            # --------------------------------------------------------- jobs
            job = client.post("/api/jobs", json={"kind": "python", "code": "print('job ok')", "name": "smoke"}).json()
            job_id = job.get("id")
            if job_id:
                log = ""
                deadline = time.time() + 30
                while time.time() < deadline:
                    payload = client.get(f"/api/jobs/{job_id}/log").json()
                    log += payload.get("text") or ""
                    if payload.get("eof"):
                        break
                    time.sleep(0.3)
                expect("后台任务", "job ok" in log or "smoke" in log,
                       (log or payload.get("text") or "").strip()[:300] or "无输出")
            else:
                fail("后台任务", f"提交失败：{job}")
    except Exception as exc:  # noqa: BLE001 - smoke script reports any failure clearly
        fail("未预期的异常", f"{type(exc).__name__}: {exc}")
        passed = False
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=20)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log_file.close()
        if args.keep:
            info(f"临时目录保留在 {tmpdir}")
        else:
            shutil.rmtree(tmpdir, ignore_errors=True)

    print()
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if INFO:
        for line in INFO:
            print(f"注：{line}")
    if FAILED:
        for line in FAILED:
            print(f"失败：{line}")
        return 1 if passed else 2
    print("冒烟测试全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
