#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDKS_ROOT="$(cd "$PYTHON_ROOT/../.." && pwd)"
REPO_ROOT="$(cd "$SDKS_ROOT/.." && pwd)"
CORE_ROOT="$SDKS_ROOT/pypi/core"
PACKAGE_ROOT_CANDIDATE="${PTK_PACKAGE_ROOT:-}"

MODE="${PTK_RELEASE_TEST_MODE:-source}"
if [[ -n "$PACKAGE_ROOT_CANDIDATE" && -d "$PACKAGE_ROOT_CANDIDATE/extensions/chromium-unpacked" ]]; then
  MODE="${PTK_RELEASE_TEST_MODE:-package}"
fi

BROWSER="${1:-${PTK_BROWSER:-chrome}}"
case "$BROWSER" in
  chrome|edge|firefox)
    ;;
  *)
    echo "unsupported browser for Selenium smoke wrapper: $BROWSER" >&2
    echo "supported: chrome, edge, firefox" >&2
    exit 1
    ;;
esac

if [[ -n "${PTK_PYTHON_BIN:-}" ]]; then
  PYTHON_BIN="$PTK_PYTHON_BIN"
elif [[ -x "$PYTHON_ROOT/.venv/bin/python" ]]; then
  PYTHON_BIN="$PYTHON_ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  PYTHON_BIN="$(command -v python || true)"
fi
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "missing Python interpreter; set PTK_PYTHON_BIN or install python3" >&2
  exit 1
fi

if ! PYTHONPATH="$CORE_ROOT/src:$PYTHON_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" "$PYTHON_BIN" -c "import selenium" >/dev/null 2>&1; then
  echo "missing selenium package for $PYTHON_BIN" >&2
  echo "install Selenium in the test environment before running this wrapper" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
if [[ "$MODE" == "package" ]]; then
  DEFAULT_RUN_ROOT="$PWD/.ptk/juice-selenium-smoke"
else
  DEFAULT_RUN_ROOT="$REPO_ROOT/tmp/juice-selenium-smoke"
fi
RUN_ROOT="${PTK_SMOKE_RUN_ROOT:-$DEFAULT_RUN_ROOT}"
RUN_NAME="${PTK_SMOKE_RUN_NAME:-$STAMP-$BROWSER}"
RUN_DIR="${PTK_RUN_DIR:-$RUN_ROOT/$RUN_NAME}"
ARTIFACTS_DIR="${PTK_ARTIFACTS_DIR:-$RUN_DIR/artifacts}"
JUICE_SHOP_URL="${JUICE_SHOP_URL:-http://localhost:3001}"
PROJECT_NAME="${PTK_PROJECT:-juice-shop-smoke}"
HEADLESS="${PTK_HEADLESS:-0}"
SMOKE_SCRIPT="$SCRIPT_DIR/juice_shop_scan.py"

if [[ "$MODE" == "package" ]]; then
  DEFAULT_FIREFOX_XPI="${PACKAGE_ROOT_CANDIDATE:-$REPO_ROOT}/extensions/ptk-latest.xpi"
else
  DEFAULT_FIREFOX_XPI="$REPO_ROOT/dist/ptk-latest-automation.xpi"
fi
FIREFOX_XPI="${PTK_EXTENSION_XPI_PATH:-${PTK_FIREFOX_XPI:-$DEFAULT_FIREFOX_XPI}}"

if [[ "$BROWSER" == "firefox" ]]; then
  PROFILE_DIR="${PTK_PROFILE_DIR:-$RUN_DIR/profile}"
  if [[ ! -f "$FIREFOX_XPI" ]]; then
    echo "missing Firefox PTK XPI: $FIREFOX_XPI" >&2
    exit 1
  fi
else
  if [[ -z "${PTK_PROFILE_DIR:-}" ]]; then
    echo "Selenium $BROWSER requires PTK_PROFILE_DIR with PTK installed and Automation Mode enabled" >&2
    echo "Use a dedicated prepared profile; do not use a daily browser profile." >&2
    exit 1
  fi
  PROFILE_DIR="$PTK_PROFILE_DIR"
fi

mkdir -p "$PROFILE_DIR" "$ARTIFACTS_DIR"

echo "Smoke run dir: $RUN_DIR"
echo "Browser: $BROWSER"
echo "Mode: $MODE"
echo "Profile: $PROFILE_DIR"
echo "Artifacts: $ARTIFACTS_DIR"
echo "Target: $JUICE_SHOP_URL"
if [[ "$BROWSER" == "firefox" ]]; then
  echo "Firefox XPI: $FIREFOX_XPI"
fi

PYTHONPATH="$CORE_ROOT/src:$PYTHON_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
PTK_BROWSER="$BROWSER" \
PTK_HEADLESS="$HEADLESS" \
PTK_PROFILE_DIR="$PROFILE_DIR" \
PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR" \
PTK_PROJECT="$PROJECT_NAME" \
PTK_INSTALL_MODE="${PTK_INSTALL_MODE:-${PTK_FIREFOX_INSTALL_MODE:-temporary}}" \
PTK_EXTENSION_XPI_PATH="$FIREFOX_XPI" \
JUICE_SHOP_URL="$JUICE_SHOP_URL" \
"$PYTHON_BIN" "$SMOKE_SCRIPT"
