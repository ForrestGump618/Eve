#!/usr/bin/env bash
# Build Suwen release artifacts (sdist + wheel + SHA256SUMS.txt).
#
# Usage:
#   ./scripts/publish.sh                 # tests + clean build + checks
#   ./scripts/publish.sh --skip-tests    # build only
#   ./scripts/publish.sh --no-clean      # keep dist/ and build/
#   PYTHON=python3.11 ./scripts/publish.sh
set -euo pipefail
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
    if [[ -x "$ROOT/.venv/bin/python" ]]; then
        PYTHON="$ROOT/.venv/bin/python"
    else
        PYTHON="python3"
    fi
fi
echo "使用 Python: $PYTHON"
echo "仓库根目录: $ROOT"

SKIP_TESTS=0
CLEAN=1
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=1 ;;
        --no-clean) CLEAN=0 ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "未知参数：$arg" >&2
            exit 2
            ;;
    esac
done

if [[ "$SKIP_TESTS" -eq 0 ]]; then
    echo -e "\n== 1/5 运行测试 =="
    "$PYTHON" -m pytest -q
else
    echo -e "\n== 1/5 跳过测试 =="
fi

echo -e "\n== 2/5 准备构建工具 =="
if ! "$PYTHON" -c "import build, setuptools, wheel" >/dev/null 2>&1; then
    echo "未安装 build/setuptools/wheel，正在安装..."
    "$PYTHON" -m pip install --no-cache-dir --progress-bar off "build>=1.0" "setuptools>=68" wheel
fi

if [[ "$CLEAN" -eq 1 ]]; then
    echo -e "\n== 3/5 清理旧产物 =="
    rm -rf "$ROOT/dist" "$ROOT/build" "$ROOT/omicslab.egg-info"
    echo "  已清理 dist/ build/ omicslab.egg-info/"
fi

echo -e "\n== 4/5 构建 sdist + wheel =="
# 使用 --no-isolation：构建依赖已安装到当前虚拟环境，避免隔离环境联网安装依赖时卡住。
"$PYTHON" -m build --no-isolation --outdir dist

echo -e "\n== 5/5 生成校验和并校验产物 =="
(
    cd dist
    shopt -s nullglob
    files=(omicslab-*)
    if [[ ${#files[@]} -eq 0 ]]; then
        echo "构建完成但 dist/ 下没有产物" >&2
        exit 1
    fi
    : > SHA256SUMS.txt
    for file in "${files[@]}"; do
        if [[ "$file" == "SHA256SUMS.txt" || -d "$file" ]]; then
            continue
        fi
        if command -v sha256sum >/dev/null 2>&1; then
            digest=$(sha256sum "$file" | awk '{print $1}')
        else
            digest=$(shasum -a 256 "$file" | awk '{print $1}')
        fi
        printf '%s  %s\n' "$digest" "$file" >> SHA256SUMS.txt
    done
    cat SHA256SUMS.txt
)
"$PYTHON" "$ROOT/scripts/check_dist.py" "$ROOT/dist"

echo -e "\n发布产物已生成："
ls -lh "$ROOT/dist"
