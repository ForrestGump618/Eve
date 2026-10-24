#!/usr/bin/env python
"""校验 Suwen 发布产物（wheel / sdist）。

检查内容：
  - wheel 版本与 ``omicslab.__version__`` 一致，包含 Web 资源、技能、智能体、示例数据；
  - sdist 包含文档、测试、发布脚本等源码包应有内容；
  - 若同目录存在 ``SHA256SUMS.txt``，逐项校验哈希。

用法：

  python scripts/check_dist.py            # 默认检查 dist/
  python scripts/check_dist.py build/dist

退出码：0 通过；1 有缺失/不一致。
"""

from __future__ import annotations

import hashlib
import re
import sys
import tarfile
import zipfile
from pathlib import Path

DIST = Path(__file__).resolve().parents[1] / "dist"

REQUIRED_WHEEL = [
    "omicslab/__init__.py",
    "omicslab/__main__.py",
    "omicslab/web/index.html",
    "omicslab/web/css/base.css",
    "omicslab/web/js/app.js",
    "omicslab/agents/lead.md",
    "omicslab/agents/single-cell-analyst.md",
    "omicslab/skills/single-cell-upstream/SKILL.md",
    "omicslab/skills/report-writing/SKILL.md",
    "omicslab/data/README.md",
]

REQUIRED_SDIST = [
    "pyproject.toml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "docs/ARCHITECTURE.md",
    "docs/API.md",
    "tests/test_tools.py",
    "scripts/publish.ps1",
    "scripts/publish.sh",
    "scripts/smoke.py",
    "scripts/check_dist.py",
]

problems: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  [ ok ] {name}{(' — ' + detail) if detail else ''}")
    else:
        problems.append(f"{name}: {detail or '检查未通过'}")
        print(f"  [fail] {name} — {detail}")


def read_version() -> str:
    text = (Path(__file__).resolve().parents[1] / "omicslab" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    return match.group(1) if match else ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_wheel(version: str, folder: Path) -> None:
    wheels = sorted(folder.glob("omicslab-*.whl")) or sorted(folder.glob("*.whl"))
    print("\nwheel:")
    if not wheels:
        check("wheel 存在", False, f"{folder} 下没有 .whl")
        return
    wheel = wheels[0]
    check("wheel 存在", True, f"{wheel.name}（{wheel.stat().st_size / 1024:.0f} KB）")
    if version:
        check("wheel 版本匹配", f"-{version}-" in wheel.name, f"期望 {version}")
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        normalized = {name.replace("\\", "/") for name in names}
        for required in REQUIRED_WHEEL:
            check(f"包含 {required}", required in normalized)
        skill_md = [n for n in normalized if n.startswith("omicslab/skills/") and n.endswith("/SKILL.md")]
        check("技能数量 >= 10", len(skill_md) >= 10, f"{len(skill_md)} 个")
        agents = [n for n in normalized if n.startswith("omicslab/agents/") and n.endswith(".md")]
        check("智能体数量 >= 7", len(agents) >= 7, f"{len(agents)} 个")
        data_files = [n for n in normalized if n.startswith("omicslab/data/") and not n.endswith("/")]
        check("示例数据存在", len(data_files) >= 2, f"{len(data_files)} 个文件")
        check("无 __pycache__", not any("__pycache__" in n for n in normalized))
        metadata = next((n for n in normalized if n.endswith(".dist-info/METADATA")), "")
        if metadata:
            meta = archive.read(metadata).decode("utf-8", "replace").replace("\r\n", "\n")
            check("METADATA 名称", re.search(r"^Name: omicslab$", meta, re.M) is not None)
            if version:
                check("METADATA 版本", re.search(rf"^Version: {re.escape(version)}$", meta, re.M) is not None)
            license_ok = "Apache" in meta or "License-File: LICENSE" in meta or "License-Expression: Apache-2.0" in meta
            check("METADATA 许可证", license_ok)
        check("含 console script 入口", any(n.endswith("entry_points.txt") for n in normalized))


def check_sdist(version: str, folder: Path) -> None:
    sdists = sorted(folder.glob("omicslab-*.tar.gz")) or sorted(folder.glob("*.tar.gz"))
    print("\nsdist:")
    if not sdists:
        check("sdist 存在", False, f"{folder} 下没有 .tar.gz")
        return
    sdist = sdists[0]
    check("sdist 存在", True, f"{sdist.name}（{sdist.stat().st_size / 1024:.0f} KB）")
    if version:
        check("sdist 版本匹配", f"-{version}" in sdist.name, f"期望 {version}")
    with tarfile.open(sdist, "r:gz") as archive:
        names = archive.getnames()
        prefix = names[0].split("/")[0] + "/" if names else ""
        relative = {n[len(prefix):] for n in names if n.startswith(prefix)}
        for required in REQUIRED_SDIST:
            check(f"包含 {required}", required in relative)


def check_sums(folder: Path) -> None:
    sums_file = folder / "SHA256SUMS.txt"
    print("\n校验和:")
    if not sums_file.exists():
        print("  [info] 未找到 SHA256SUMS.txt（构建时由发布脚本生成），跳过")
        return
    entries = 0
    for line in sums_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            problems.append(f"SHA256SUMS 行格式错误：{line}")
            continue
        digest, name = parts[0], parts[1].lstrip("*")
        target = folder / name
        entries += 1
        if not target.exists():
            check(f"校验和文件存在 {name}", False)
            continue
        actual = sha256(target)
        check(f"校验和匹配 {name}", actual == digest, f"{actual[:12]}… vs {digest[:12]}…")
    check("SHA256SUMS 有内容", entries > 0, f"{entries} 个文件")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:  # pragma: no cover - 老旧解释器/重定向流
                pass
    folder = Path(argv[1]).resolve() if len(argv) > 1 else DIST
    print(f"检查发布产物：{folder}")
    if not folder.is_dir():
        print(f"目录不存在：{folder}")
        return 1
    version = read_version()
    print(f"当前版本：{version or '未知'}")
    check_wheel(version, folder)
    check_sdist(version, folder)
    check_sums(folder)
    print()
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for item in problems:
            print(f"  - {item}")
        return 1
    print("发布产物校验通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
