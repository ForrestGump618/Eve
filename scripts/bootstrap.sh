#!/usr/bin/env bash
# Bootstrap a local Suwen development environment (macOS / Linux).
#
# Locates a Python >= 3.10 interpreter, creates .venv in the repository root,
# upgrades pip, and installs the project in editable mode. Safe to re-run.
#
# Usage:
#   ./scripts/bootstrap.sh
#   ./scripts/bootstrap.sh --extras "bio,dev"
#   ./scripts/bootstrap.sh --no-install
#   ./scripts/bootstrap.sh --python /usr/bin/python3.11
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV="$ROOT/.venv"
VENV_PYTHON="$VENV/bin/python"

NO_INSTALL=0
EXTRAS=""
PYTHON_OVERRIDE=""

usage() {
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --no-install) NO_INSTALL=1; shift ;;
        --extras)
            [ $# -ge 2 ] || { echo "ERROR: --extras needs a value, e.g. --extras \"bio,dev\"" >&2; exit 1; }
            EXTRAS="$2"; shift 2 ;;
        --extras=*) EXTRAS="${1#*=}"; shift ;;
        --python)
            [ $# -ge 2 ] || { echo "ERROR: --python needs a path" >&2; exit 1; }
            PYTHON_OVERRIDE="$2"; shift 2 ;;
        --python=*) PYTHON_OVERRIDE="${1#*=}"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; echo "Run ./scripts/bootstrap.sh --help" >&2; exit 1 ;;
    esac
done

step() { printf '==> %s\n' "$1"; }
ok()   { printf 'OK  %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

step "Suwen bootstrap (project: $ROOT)"

# --- 1. Locate a usable Python interpreter -----------------------------------
check_python() {
    "$@" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' >/dev/null 2>&1
}

PYTHON=""
if [ -n "$PYTHON_OVERRIDE" ]; then
    check_python "$PYTHON_OVERRIDE" || fail "Not a usable Python >= 3.10: $PYTHON_OVERRIDE"
    PYTHON="$PYTHON_OVERRIDE"
else
    for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 && check_python "$candidate"; then
            PYTHON="$candidate"
            break
        fi
    done
    [ -n "$PYTHON" ] || fail $'No Python >= 3.10 found.\n  - Install it: https://www.python.org/downloads/ (or your package manager)\n  - Or pass one explicitly: ./scripts/bootstrap.sh --python /usr/bin/python3.11'
fi

PY_VERSION="$("$PYTHON" -c 'import sys; print(sys.version.split()[0])')"
ok "Using Python $PY_VERSION ($PYTHON)"

# --- 2. Create or reuse the virtual environment ------------------------------
if [ -x "$VENV_PYTHON" ]; then
    ok "Reusing existing virtual environment: $VENV"
else
    step "Creating virtual environment at $VENV"
    "$PYTHON" -m venv "$VENV" || fail $'Failed to create the virtual environment.\n  - Debian/Ubuntu: sudo apt install python3-venv\n  - Or: '"$PYTHON"' -m venv "'"$VENV"'"'
    ok "Virtual environment created"
fi

# --- 3. Upgrade pip ----------------------------------------------------------
step "Upgrading pip"
"$VENV_PYTHON" -m pip install --upgrade pip || fail $'pip upgrade failed (network or proxy problem?).\n  Retry manually: "'"$VENV_PYTHON"'" -m pip install --upgrade pip'
ok "pip is up to date"

# --- 4. Install the project --------------------------------------------------
if [ "$NO_INSTALL" -eq 1 ]; then
    ok "Skipping dependency installation (--no-install)"
else
    TARGET="."
    if [ -n "$EXTRAS" ]; then
        EXTRAS_CLEAN="$(printf '%s' "$EXTRAS" | tr -d '[:space:]' | sed 's/^,//; s/,$//')"
        [ -n "$EXTRAS_CLEAN" ] && TARGET=".[${EXTRAS_CLEAN}]"
    fi

    step "Installing Suwen in editable mode: $TARGET"
    ( cd "$ROOT" && "$VENV_PYTHON" -m pip install -e "$TARGET" ) || fail $'Dependency installation failed.\n  Retry manually from "'"$ROOT"'":\n    "'"$VENV_PYTHON"'" -m pip install -e "'"$TARGET"'"'
    ok "Dependencies installed"
fi

# --- 5. Next steps -----------------------------------------------------------
cat <<EOF

Next steps
  1) Configure an LLM provider (pick one):
       export DEEPSEEK_API_KEY="sk-..."     # this shell session only
       or start the server and use the Settings page
  2) Start the server:
       .venv/bin/python -m omicslab serve --port 5077
  3) Open:  http://127.0.0.1:5077

Health check:  .venv/bin/python -m omicslab env
Dev mode:      ./scripts/dev.sh
EOF
exit 0
