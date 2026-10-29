"""Append Emil Kowalski's pinned interaction-design skills to Eve's shared pack."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path, PurePosixPath


spec = importlib.util.spec_from_file_location(
    "builder", Path(__file__).with_name("build-skill-library.py")
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

REVISION = "a81dbca07f2217b7103e510c0f13f8d5b017afc9"
REPOSITORY = "emilkowalski/skills"
EXPECTED = {
    "animate",
    "animate-expo",
    "animation-performance",
    "animation-vocabulary",
    "apple-design",
    "ask-sonner",
    "break-ui",
    "emil-design-eng",
    "find-animation-opportunities",
    "improve-animations",
    "mobile-native",
    "pick-ui-library",
    "prototype",
    "remove-animations",
    "review-animations",
    "write-swift",
}
KEYWORDS = {
    "animate": "动效 动画 缓动 交互 motion easing",
    "animate-expo": "React Native Expo 动画 手势",
    "animation-performance": "动画性能 掉帧 合成 transform",
    "animation-vocabulary": "动效词汇 设计沟通",
    "apple-design": "Apple iOS 流体交互 手势 弹簧 材质",
    "ask-sonner": "toast 通知 反馈 堆叠",
    "break-ui": "界面审查 视觉层级 布局",
    "emil-design-eng": "设计工程 动效 组件 交互细节",
    "find-animation-opportunities": "动效机会 交互反馈 转场",
    "improve-animations": "改进动画 节奏 缓动",
    "mobile-native": "移动端 原生交互 安全区 手势",
    "pick-ui-library": "组件库 选择 前端依赖",
    "prototype": "原型 交互验证 界面",
    "remove-animations": "删减动画 减少干扰 可访问性",
    "review-animations": "审查动画 性能 可访问性",
    "write-swift": "Swift iOS 原生界面",
}


def import_bundle(checkout: Path, output: Path) -> dict:
    def git(*args: str) -> bytes:
        return subprocess.check_output(
            ["git", "-C", str(checkout), *args],
            env={**__import__("os").environ, "GIT_LFS_SKIP_SMUDGE": "1"},
        )

    if git("rev-parse", "HEAD").decode().strip() != REVISION:
        raise ValueError("Emil skills checkout differs from the pinned revision")
    index = json.loads((output / "index.json").read_text(encoding="utf-8"))
    pack = bytearray((output / "library.pack").read_bytes())
    if hashlib.sha256(pack).hexdigest() != index["packSha256"]:
        raise ValueError("Existing skill pack is corrupt")

    paths = git("ls-tree", "-r", "--name-only", REVISION).decode().splitlines()
    license_text = git("show", f"{REVISION}:LICENSE")
    skills = []
    imported_names = set()
    for entry in sorted(path for path in paths if path.startswith("skills/") and path.endswith("/SKILL.md")):
        skill_root = str(PurePosixPath(entry).parent) + "/"
        instruction = git("show", f"{REVISION}:{entry}")
        text = instruction.decode("utf-8", errors="strict")
        meta = builder.metadata(text)
        name = str(meta.get("name") or PurePosixPath(skill_root).name).strip()
        if name not in EXPECTED:
            continue
        imported_names.add(name)
        files = {}
        for path in sorted(item for item in paths if item.startswith(skill_root)):
            relative = path[len(skill_root):]
            data = git("show", f"{REVISION}:{path}")
            suffix = PurePosixPath(path).suffix.lower()
            if suffix not in builder.TEXT_EXT or len(data) > 2_000_000:
                continue
            data.decode("utf-8", errors="strict")
            files[relative] = builder.add_object(index["objects"], pack, data)
        files["EVE-UPSTREAM-LICENSE.txt"] = builder.add_object(index["objects"], pack, license_text)
        digest = hashlib.sha256(instruction).hexdigest()
        skills.append(
            {
                "id": f"builtin:emil-{name}:{digest[:12]}",
                "name": name,
                "description": str(meta.get("description") or name).strip()[:1600],
                "keywords": KEYWORDS.get(name, "design engineering interaction motion"),
                "bundle": "emil-skills",
                "version": f"git-{REVISION[:12]}",
                "source": f"https://github.com/{REPOSITORY}/tree/{REVISION}/{skill_root.rstrip('/')}",
                "origin": {"repository": REPOSITORY, "commit": REVISION, "path": entry},
                "license": "MIT",
                "sha256": digest,
                "files": files,
                "omittedResources": [],
            }
        )
    missing = EXPECTED - imported_names
    if missing:
        raise ValueError("Pinned repository is missing expected skills: " + ", ".join(sorted(missing)))

    index["skills"] = [
        skill
        for skill in index["skills"]
        if skill.get("bundle") != "emil-skills"
        and (skill.get("origin") or {}).get("repository") != REPOSITORY
    ] + skills
    index["sources"] = [
        source
        for source in index["sources"]
        if source.get("repository") != REPOSITORY
    ] + [
        {
            "repository": REPOSITORY,
            "commit": REVISION,
            "version": f"git-{REVISION[:12]}",
            "license": "MIT",
        }
    ]
    index["packSha256"] = hashlib.sha256(pack).hexdigest()
    (output / "library.pack").write_bytes(pack)
    (output / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    report = {
        "bundle": "emil-skills",
        "commit": REVISION,
        "skills": len(skills),
        "names": sorted(imported_names),
        "packSha256": index["packSha256"],
        "packBytes": len(pack),
    }
    (output / "emil-import-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "skill-library",
    )
    args = parser.parse_args()
    print(json.dumps(import_bundle(args.checkout, args.output)))
