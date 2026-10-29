"""Version module graph and entry assets so upgrades cannot reuse stale UI modules."""
from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = re.search(
    r'__version__\s*=\s*"([^"]+)"',
    (ROOT / "omicslab/__init__.py").read_text(encoding="utf-8"),
).group(1)
WEB = ROOT / "omicslab/web"
WEB_IMPORT = re.compile(
    r"""(["'])(\.{1,2}/[^"'\n]+?\.js)(?:\?v=[\w.\-]+)?(["'])"""
)
ENTRY_ASSET = re.compile(
    r'((?:src|href)="(?:js|css|assets)/[^"?]+\.(?:js|css|svg))(?:\?v=[\w.\-]+)?(")'
)
TEST_IMPORT = re.compile(
    r"(?<![A-Za-z0-9_.-])(/js/[^\"'\n]+?\.js)(?:\?v=[\w.\-]+)?"
)


def versioned(text: str, pattern: re.Pattern[str], replacement) -> str:
    return pattern.sub(replacement, text)


def main(check: bool) -> int:
    mismatches: list[str] = []

    def apply(path: Path, transform) -> None:
        original = path.read_text(encoding="utf-8")
        updated = transform(original)
        if updated == original:
            return
        mismatches.append(str(path.relative_to(ROOT)))
        if not check:
            path.write_text(updated, encoding="utf-8")

    for path in (WEB / "js").rglob("*.js"):
        apply(
            path,
            lambda text: versioned(
                text,
                WEB_IMPORT,
                lambda match: f"{match.group(1)}{match.group(2)}?v={VERSION}{match.group(3)}",
            ),
        )
    apply(
        WEB / "index.html",
        lambda text: versioned(
            text,
            ENTRY_ASSET,
            lambda match: f"{match.group(1)}?v={VERSION}{match.group(2)}",
        ),
    )
    for path in (ROOT / "tests").glob("frontend-*.mjs"):
        apply(
            path,
            lambda text: versioned(
                text,
                TEST_IMPORT,
                lambda match: f"{match.group(1)}?v={VERSION}",
            ),
        )

    if check and mismatches:
        print("Web asset version drift:")
        for path in mismatches:
            print(f"- {path}")
        print(f"stamp_web_assets: FAIL ({len(mismatches)} file(s), expected {VERSION})")
        return 1
    if check:
        print(f"stamp_web_assets: PASS ({VERSION})")
    else:
        print("Web asset version:", VERSION)
        if mismatches:
            print(f"Updated {len(mismatches)} file(s).")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()
    raise SystemExit(main(args.check))
