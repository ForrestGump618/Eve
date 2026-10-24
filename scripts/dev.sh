#!/usr/bin/env bash
# Start Suwen in development mode (macOS / Linux).
#
# Runs `python -m omicslab serve --port <port> --reload` when the CLI supports
# --reload; otherwise falls back to a plain serve. Ctrl+C stops the server.
#
# Usage:
#   ./scripts/dev.sh
#   ./scripts/dev.sh --port 5078
#   ./scripts/dev.sh --workspace ~/data/pbmc
#   ./scripts/dev.sh --no-reload
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$ROOT/.venv/bin/python"

PORT=5077
WORKSPACE=""
NO_RELOAD=0

usage() {
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --port)
            [ $# -ge 2 ] || { echo "ERROR: --port needs a value" >&2; exit 1; }
            PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#*=}"; shift ;;
        --workspace)
            [ $# -ge 2 ] || { echo "ERROR: --workspace needs a path" >&2; exit 1; }
            WORKSPACE="$2"; shift 2 ;;
        --workspace=*) WORKSPACE="${1#*=}"; shift ;;
        --no-reload) NO_RELOAD=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; echo "Run ./scripts/dev.sh --help" >&2; exit 1 ;;
    esac
done

if [ ! -x "$VENV_PYTHON" ]; then
    printf 'ERROR: Virtual environment not found: %s\n  Run the bootstrap script first:  ./scripts/bootstrap.sh\n' "$VENV_PYTHON" >&2
    exit 1
fi

# --- Detect --reload support without starting the server ---------------------
SUPPORTS_RELOAD=0
if [ "$NO_RELOAD" -eq 0 ]; then
    if HELP_TEXT="$("$VENV_PYTHON" -m omicslab serve --help 2>&1)"; then
        case "$HELP_TEXT" in
            *--reload*) SUPPORTS_RELOAD=1 ;;
        esac
    fi
fi

ARGS=(-m omicslab serve --port "$PORT")
[ -n "$WORKSPACE" ] && ARGS+=(--workspace "$WORKSPACE")
if [ "$SUPPORTS_RELOAD" -eq 1 ]; then
    ARGS+=(--reload)
    echo "==> Dev mode: auto-reload enabled"
else
    echo "==> Dev mode: auto-reload not available, starting plain serve"
fi

echo "==> Starting server: http://127.0.0.1:$PORT"
[ -n "$WORKSPACE" ] && echo "==> Workspace: $WORKSPACE"
echo "    Press Ctrl+C to stop."
echo ""

exec "$VENV_PYTHON" "${ARGS[@]}"
