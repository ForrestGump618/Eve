"""Workspace-bound sidebar adapters. Reuse the same backend and write verifier."""
import inspect
import json
import re
from pathlib import Path
from fastapi import APIRouter, Request, HTTPException
from .routes_platform import platform, body
from .routes_harness import backend_stdout, execute_backend

router = APIRouter(tags=["sidebar"])


def git_policy():
    return json.loads((Path(__file__).parents[1] / "data" / "sidebar-policy.json").read_text(encoding="utf-8"))


def _git_worker(req):
    """Runs entirely on the selected backend, including all Git and path checks."""
    import fnmatch
    import hashlib
    import json
    import os
    from pathlib import Path
    import subprocess
    import tempfile
    import time

    cfg = req["policy"]
    deadline = time.monotonic() + cfg["operation_timeout_s"]
    root = Path(req["root"]).resolve(strict=True)
    # Ignore inherited repository/index routing, pagers, editors and external diffs.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_LITERAL_PATHSPECS="1", GIT_OPTIONAL_LOCKS="0")
    argv = ["git", "--no-pager", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false",
            "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"]

    def git(*args, data=None, missing=False):
        timeout = min(cfg["command_timeout_s"], deadline - time.monotonic())
        if timeout <= 0:
            raise ValueError("Git operation timed out; refresh status before retrying")
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            result = subprocess.run(argv + list(args), cwd=str(root), env=env, input=data,
                                    stdout=out, stderr=err, timeout=timeout, shell=False)
            out.seek(0)
            err.seek(0)
            output = out.read(cfg["output_bytes"] + 1)
            error = err.read(cfg["error_bytes"] + 1)
        if len(output) > cfg["output_bytes"] or len(error) > cfg["error_bytes"]:
            raise ValueError("Git output exceeds policy limit; narrow the changes before retrying")
        if result.returncode and not missing:
            raise ValueError(error.decode("utf-8", "replace") or "Git command failed")
        return output if not result.returncode else b""

    def text(value):
        return value.decode("utf-8", "strict")

    def blocked(path):
        return any(fnmatch.fnmatchcase(part.lower(), pattern)
                   for part in path.replace("\\", "/").split("/") for pattern in cfg["blocked_names"])

    def safe_path(path):
        if not isinstance(path, str) or not path or len(path.encode("utf-8")) > cfg["path_bytes"]:
            raise ValueError("Invalid file path")
        parts = path.replace("\\", "/").split("/")
        if "\0" in path or ":" in path or any(p in {"", ".", ".."} for p in parts) or blocked(path):
            raise ValueError("Unsafe or secret file path")
        target = root.joinpath(*parts)
        if not target.resolve().is_relative_to(root) or target.is_symlink() or target.is_dir():
            raise ValueError("Only individual workspace files may be staged")
        # Symlink parents could redirect an otherwise valid-looking path.
        if any(parent.is_symlink() for parent in target.parents if parent != root and parent.is_relative_to(root)):
            raise ValueError("Symlink paths are not supported")
        return "/".join(parts)

    def snapshot():
        head = git("rev-parse", "--verify", "HEAD", missing=True).strip()
        ref = git("symbolic-ref", "-q", "HEAD", missing=True).strip() or b"HEAD"
        status = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
        index = git("ls-files", "--stage", "-z")
        entries = []
        for item in status.split(b"\0"):
            if not item:
                continue
            path = text(item[3:])
            entries.append({"path": path, "index": text(item[:1]), "worktree": text(item[1:2]),
                            "blocked": blocked(path)})
        if len(entries) > cfg["file_limit"]:
            raise ValueError("Too many changed files for the Git panel")
        staged = [text(item) for item in git("diff", "--cached", "--name-only", "--no-renames", "-z").split(b"\0") if item]
        secrets = any(blocked(path) for path in staged)
        diff = b"" if secrets else git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary")
        if len(diff) > cfg["diff_bytes"]:
            raise ValueError("Staged diff exceeds review limit; reduce staged files before committing")
        index_digest = hashlib.sha256(index).hexdigest()
        digest = hashlib.sha256(json.dumps([str(root), text(ref), text(head), text(status), index_digest,
                                           hashlib.sha256(diff).hexdigest()], ensure_ascii=True).encode()).hexdigest()
        return {"digest": digest, "index_digest": index_digest, "head": text(head), "ref": text(ref), "entries": entries,
                "staged_paths": staged, "staged_diff": diff.decode("utf-8", "replace"),
                "reviewable": not secrets, "message_bytes": cfg["message_bytes"],
                "request_timeout_ms": cfg["request_timeout_ms"]}

    lock = None
    private = None
    index_path = None
    action = req["action"]
    changed = False
    try:
        if Path(text(git("rev-parse", "--show-toplevel")).strip()).resolve() != root:
            raise ValueError("Workspace root must be the Git repository root")
        index_path = Path(text(git("rev-parse", "--git-path", "index")).strip())
        if not index_path.is_absolute():
            index_path = root / index_path
        if action != "review":
            # Hold Git's real lock through validation and publication. Work only
            # on a private index so Git cannot consume/release our lock early.
            lock_path = Path(str(index_path) + ".lock")
            lock = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        before = snapshot()
        if action == "review":
            return {"ok": True, **before}
        if req.get("digest") != before["digest"] or req.get("index_digest") != before["index_digest"]:
            raise ValueError("Git status/index changed; refresh and review the staged diff again")
        fd, name = tempfile.mkstemp(prefix="eve-sidebar-index-", dir=str(index_path.parent))
        private = Path(name)
        with os.fdopen(fd, "wb") as handle:
            if index_path.exists():
                if index_path.stat().st_size > cfg["index_bytes"]:
                    raise ValueError("Git index exceeds policy limit")
                handle.write(index_path.read_bytes())
        if not index_path.exists():
            private.unlink()
        env["GIT_INDEX_FILE"] = str(private)
        if action in {"stage", "unstage"}:
            path = safe_path(req.get("path"))
            if path not in {entry["path"] for entry in before["entries"]}:
                raise ValueError("File is not in the reviewed status")
            if action == "stage":
                if (root / path).exists() and (root / path).stat().st_size > cfg["file_bytes"]:
                    raise ValueError("File exceeds staging size limit")
                git("add", "--", path)
            elif before["head"]:
                git("restore", "--source=" + before["head"], "--staged", "--", path)
            else:
                # An unborn branch has no source tree; remove only this index entry.
                git("update-index", "-z", "--index-info", data=b"0 " + b"0" * 40 + b"\t" + path.encode("utf-8") + b"\0")
            os.replace(private, index_path)
            changed = True
            env.pop("GIT_INDEX_FILE", None)
            after = snapshot()
            present = path in after["staged_paths"]
            if action == "unstage" and present:
                raise ValueError("Unstage readback failed")
            if action == "stage" and git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "--", path):
                raise ValueError("File changed during staging; refresh and review again")
            return {"ok": True, "verified": True, "action": action, **after}
        if not before["reviewable"] or not before["staged_paths"]:
            raise ValueError("No reviewable staged changes to commit")
        message = req.get("message")
        if not isinstance(message, str) or not message.strip() or "\0" in message or len(message.encode("utf-8")) > cfg["message_bytes"]:
            raise ValueError("Commit message is empty or exceeds policy limit")
        # Plumbing avoids hooks/clean filters changing a reviewed index. The ref
        # advances with compare-and-swap, using exactly the reviewed staged tree.
        tree = text(git("write-tree")).strip()
        parent = ["-p", before["head"]] if before["head"] else []
        commit = text(git("commit-tree", tree, *parent, data=message.encode("utf-8"))).strip()
        if snapshot()["digest"] != before["digest"]:
            raise ValueError("Git status/index changed during commit; refresh and review again")
        git("update-ref", "-m", "sidebar: reviewed commit", before["ref"], commit, before["head"] or "0" * len(commit))
        changed = True
        if text(git("rev-parse", "HEAD")).strip() != commit or text(git("rev-parse", "HEAD^{tree}")).strip() != tree:
            raise ValueError("Commit readback failed; refresh history before retrying")
        env.pop("GIT_INDEX_FILE", None)
        return {"ok": True, "verified": True, "commit": commit, "committed_paths": before["staged_paths"], **snapshot()}
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": str(exc)[:cfg["error_bytes"]], "may_have_changed": changed}
    finally:
        if private is not None:
            private.unlink(missing_ok=True)
            Path(str(private) + ".lock").unlink(missing_ok=True)
        if lock is not None:
            os.close(lock)
            Path(str(index_path) + ".lock").unlink(missing_ok=True)


async def _sidebar_git_operation(request, id, action, payload):
    p = platform(request)
    cfg = git_policy()
    try:
        ws = p.require_workspace(id)
        permissions = p.config.get("permissions", id)["value"]
        mutate = action != "review"
        for category, tool in (("files", "write_file" if mutate else "read_file"), ("shell", "run_shell")):
            values = (permissions.get(category), permissions.get("tools", {}).get(tool))
            if "deny" in values or (mutate and "read_only" in values):
                raise HTTPException(403, "当前工作区文件或 Shell 权限禁止此 Git 操作")
        if mutate and payload.get("confirmed") is not True:
            raise HTTPException(422, "请明确确认此 Git 操作；提交前必须检查暂存差异")
        if mutate and any(not re.fullmatch(r"[a-f0-9]{64}", str(payload.get(key) or "")) for key in ("digest", "index_digest")):
            raise HTTPException(422, "缺少当前状态和暂存区摘要，请刷新后重试")
        backend = await p.backend(id)
        if backend.kind != ws.backend:
            raise HTTPException(409, "所选工作区后端不匹配，拒绝回退执行")
        req = {**payload, "root": str(backend.root), "action": action, "policy": cfg}
        source = inspect.getsource(_git_worker) + "\nprint(json.dumps(_git_worker(json.loads(" + repr(json.dumps(req, ensure_ascii=True)) + ")), ensure_ascii=True))"
        # A separate namespace keeps payload functions/data out of notebook globals.
        code = "exec(" + repr("import json\n" + source) + ", {})"
        result = await backend.execute_python(code, timeout_s=cfg["backend_timeout_s"])
        if not result.get("ok") or result.get("truncated"):
            raise ValueError("Git 后端执行未完成，请刷新状态后再操作")
        output = json.loads(backend_stdout(result))
        if not output.get("ok"):
            raise ValueError(output.get("error") or "Git 操作失败")
        can_write = all(permissions.get(category) not in {"deny", "read_only"}
                        and permissions.get("tools", {}).get(tool) not in {"deny", "read_only"}
                        for category, tool in (("files", "write_file"), ("shell", "run_shell")))
        return {**output, "workspace_id": id, "backend": backend.kind, "can_write": can_write}
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(409, str(exc)[:cfg["error_bytes"]]) from exc


@router.get("/api/workspaces/{id}/sidebar/git/review")
async def sidebar_git_review(request: Request, id: str):
    return await _sidebar_git_operation(request, id, "review", {})


@router.post("/api/workspaces/{id}/sidebar/git/{action}")
async def sidebar_git_write(request: Request, id: str, action: str):
    if action not in {"stage", "unstage", "commit"}:
        raise HTTPException(422, "未知 Git 操作")
    return await _sidebar_git_operation(request, id, action, await body(request))


@router.get("/api/workspaces/{id}/sidebar/files")
async def sidebar_files(request: Request, id: str, query: str = "", path: str = "."):
    if not query.strip() or len(query) > 500:
        raise HTTPException(422, "请输入 1—500 字符的检索词")
    p = platform(request)
    try:
        return await execute_backend(await p.backend(id), "search_files", {"query": query, "path": path})
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)[:500]) from exc


@router.api_route("/api/workspaces/{id}/sidebar/editor", methods=["GET", "POST"])
async def sidebar_editor(request: Request, id: str, path: str = ""):
    p = platform(request)
    try:
        backend = await p.backend(id)
        if request.method == "GET":
            return await execute_backend(backend, "read_file", {"path": path, "limit": 2000})
        payload = await body(request)
        return await execute_backend(backend, "write_file", payload)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)[:500]) from exc


@router.get("/api/workspaces/{id}/sidebar/git")
async def sidebar_git(request: Request, id: str, commit: str = ""):
    p = platform(request)
    cfg = git_policy()
    if commit and not re.fullmatch(r"[a-f0-9]{7,40}", commit):
        raise HTTPException(422, "提交 ID 无效")
    backend = await p.backend(id)
    commands = ([("detail", f"git --no-pager show --no-ext-diff --no-textconv --stat --format=fuller {commit}")] if commit else [
        ("status", "git --no-optional-locks -c core.quotepath=false status --short"),
        ("graph", f"git --no-pager log --all -n {int(cfg['history_limit'])} --decorate --oneline --graph"),
        ("branches", "git branch --all --no-color"),
    ])
    results = {}
    for key, command in commands:
        result = await backend.shell(command, timeout_s=cfg["command_timeout_s"])
        if not result.get("ok") or result.get("truncated"):
            raise HTTPException(409, f"Git {key} 未完成：{str(result.get('stderr') or result.get('status') or '非 Git 工作区')[:500]}")
        results[key] = str(result.get("stdout") or "")[:cfg["history_bytes"]]
    return {**results, "workspace_id": id, "read_only": True, "history_limit": cfg["history_limit"]}
