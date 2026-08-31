#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDKS_ROOT="$(cd "$PYTHON_ROOT/../.." && pwd)"
REPO_ROOT="$(cd "$SDKS_ROOT/.." && pwd)"
NPM_ROOT="$SDKS_ROOT/npm"
CORE_ROOT="$SDKS_ROOT/pypi/core"
PACKAGE_ROOT_CANDIDATE="${PTK_PACKAGE_ROOT:-}"

MODE="${PTK_RELEASE_TEST_MODE:-source}"
if [[ -n "$PACKAGE_ROOT_CANDIDATE" && -d "$PACKAGE_ROOT_CANDIDATE/extensions/chromium-unpacked" ]]; then
  MODE="${PTK_RELEASE_TEST_MODE:-package}"
fi

BROWSER="${1:-${PTK_BROWSER:-chromium}}"
case "$BROWSER" in
  chromium|chrome|edge|firefox)
    ;;
  *)
    echo "unsupported browser for this smoke wrapper: $BROWSER" >&2
    echo "supported: chromium, chrome, edge, firefox" >&2
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
if ! PYTHONPATH="$CORE_ROOT/src:$PYTHON_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" "$PYTHON_BIN" -c "import playwright.sync_api" >/dev/null 2>&1; then
  echo "missing Python Playwright package for $PYTHON_BIN" >&2
  echo "install the Playwright Python dependency or set PTK_PYTHON_BIN to the release-test virtualenv" >&2
  exit 1
fi

# Chrome branded builds no longer honor command-line unpacked-extension loading.
# Keep the release row deterministic by explicitly using Playwright's Chrome for
# Testing binary; Edge and Firefox continue to exercise their installed brands.
if [[ "$BROWSER" == "chrome" && -z "${PTK_EXECUTABLE_PATH:-}" && -z "${PTK_PLAYWRIGHT_EXECUTABLE_PATH:-}" && -z "${PTK_CHROME_BINARY:-}" ]]; then
  PTK_EXECUTABLE_PATH="$(PYTHONPATH="$CORE_ROOT/src:$PYTHON_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" "$PYTHON_BIN" -c 'from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()')"
  if [[ ! -x "$PTK_EXECUTABLE_PATH" ]]; then
    echo "Chrome for Testing binary not found: $PTK_EXECUTABLE_PATH" >&2
    exit 1
  fi
  export PTK_EXECUTABLE_PATH
fi

NODE_BIN="${PTK_NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "missing node runtime: $NODE_BIN" >&2
  exit 1
fi

if [[ "$MODE" == "package" ]]; then
  DEFAULT_EXTENSION_PATH="${PACKAGE_ROOT_CANDIDATE:-$REPO_ROOT}/extensions/chromium-unpacked"
  DEFAULT_FIREFOX_XPI="${PACKAGE_ROOT_CANDIDATE:-$REPO_ROOT}/extensions/ptk-latest.xpi"
else
  DEFAULT_EXTENSION_PATH="$REPO_ROOT/dist/ptk_extension_unpacked_automation"
  DEFAULT_FIREFOX_XPI="$REPO_ROOT/dist/ptk-latest-automation.xpi"
fi

if [[ -n "${PTK_EXTENSION_PATH:-}" ]]; then
  EXTENSION_PATH="$PTK_EXTENSION_PATH"
else
  EXTENSION_PATH="$DEFAULT_EXTENSION_PATH"
fi
FIREFOX_XPI="${PTK_FIREFOX_XPI:-$DEFAULT_FIREFOX_XPI}"
if [[ "$BROWSER" != "firefox" && ! -d "$EXTENSION_PATH" ]]; then
  echo "missing unpacked PTK extension directory: $EXTENSION_PATH" >&2
  exit 1
fi
if [[ "$BROWSER" == "firefox" && ! -f "$FIREFOX_XPI" ]]; then
  echo "missing Firefox PTK XPI: $FIREFOX_XPI" >&2
  echo "run npm run build_xpi or npm run build_pkg first" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
if [[ "$MODE" == "package" ]]; then
  DEFAULT_RUN_ROOT="$PWD/.ptk/juice-playwright-smoke"
else
  DEFAULT_RUN_ROOT="$REPO_ROOT/tmp/juice-playwright-smoke"
fi
RUN_ROOT="${PTK_SMOKE_RUN_ROOT:-$DEFAULT_RUN_ROOT}"
RUN_NAME="${PTK_SMOKE_RUN_NAME:-$STAMP-$BROWSER}"
RUN_DIR="${PTK_RUN_DIR:-$RUN_ROOT/$RUN_NAME}"
PROFILE_DIR="${PTK_PROFILE_DIR:-$RUN_DIR/profile}"
ARTIFACTS_DIR="${PTK_ARTIFACTS_DIR:-$RUN_DIR/artifacts}"
JUICE_SHOP_URL="${JUICE_SHOP_URL:-http://localhost:3001}"
PROJECT_NAME="${PTK_PROJECT:-juice-shop-smoke}"
HEADLESS="${PTK_HEADLESS:-0}"
BOOTSTRAP_LOG="${PTK_BOOTSTRAP_LOG:-$RUN_DIR/bootstrap.log}"
SMOKE_SCRIPT="$SCRIPT_DIR/juice_shop_scan.py"
SELENIUM_ROOT="$SDKS_ROOT/pypi/selenium"
SELENIUM_SMOKE_SCRIPT="$SELENIUM_ROOT/smoke/juice_shop_scan.py"
BOOTSTRAP_SCRIPT="${PTK_BOOTSTRAP_SCRIPT:-$NPM_ROOT/scripts/bootstrap-chromium-automation-profile.mjs}"

mkdir -p "$PROFILE_DIR" "$ARTIFACTS_DIR"

echo "Smoke run dir: $RUN_DIR"
echo "Browser: $BROWSER"
echo "Mode: $MODE"
echo "Profile: $PROFILE_DIR"
echo "Artifacts: $ARTIFACTS_DIR"
echo "Target: $JUICE_SHOP_URL"
echo "Extension: $EXTENSION_PATH"
if [[ "$BROWSER" == "firefox" ]]; then
  echo "Firefox XPI: $FIREFOX_XPI"
fi

# Bootstrap a fresh profile only when explicitly requested. The Playwright
# example normally enables PTK automation after the scan browser is launched,
# which avoids launching the same persistent profile twice.
if [[ "$BROWSER" == "firefox" ]]; then
  mkdir -p "$PROFILE_DIR/extensions"
  FIREFOX_ADDON_ID="$(unzip -p "$FIREFOX_XPI" manifest.json | "$PYTHON_BIN" -c 'import json, sys; print(json.load(sys.stdin).get("browser_specific_settings", {}).get("gecko", {}).get("id", ""))')"
  if [[ -z "$FIREFOX_ADDON_ID" || "$FIREFOX_ADDON_ID" == */* ]]; then
    echo "unable to resolve Firefox add-on ID from $FIREFOX_XPI" >&2
    exit 1
  fi
  cp "$FIREFOX_XPI" "$PROFILE_DIR/extensions/$FIREFOX_ADDON_ID.xpi"
  cat >"$PROFILE_DIR/user.js" <<EOF
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.installDistroAddons", true);
user_pref("extensions.webextensions.restrictedDomains", "");
user_pref("xpinstall.signatures.required", false);
EOF
  {
    echo "[ptk-profile] browser=firefox"
    echo "[ptk-profile] profile=$PROFILE_DIR"
    echo "[ptk-profile] xpi=$FIREFOX_XPI"
  } >"$BOOTSTRAP_LOG"
else
  if [[ "${PTK_PREBOOTSTRAP_PROFILE:-0}" =~ ^(1|true|yes|on)$ ]]; then
    if [[ ! -f "$BOOTSTRAP_SCRIPT" ]]; then
      echo "missing Chromium bootstrap helper: $BOOTSTRAP_SCRIPT" >&2
      exit 1
    fi
    PTK_BROWSER="$BROWSER" \
    PTK_PROFILE_DIR="$PROFILE_DIR" \
    PTK_EXTENSION_PATH="$EXTENSION_PATH" \
    PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR" \
    "$NODE_BIN" "$BOOTSTRAP_SCRIPT" \
      >"$BOOTSTRAP_LOG" 2>&1
  else
    {
      echo "[ptk-profile] browser=$BROWSER"
      echo "[ptk-profile] profile=$PROFILE_DIR"
      echo "[ptk-profile] extension=$EXTENSION_PATH"
      echo "[ptk-profile] prebootstrap=skipped"
      echo "[ptk-profile] reason=automation-enabled-artifact"
    } >"$BOOTSTRAP_LOG"
  fi
fi

echo "Bootstrap log: $BOOTSTRAP_LOG"

if [[ "$BROWSER" == "firefox" ]]; then
  if ! "$PYTHON_BIN" -c "import selenium" >/dev/null 2>&1; then
    echo "missing selenium in $PYTHON_BIN; install it to run Firefox runtime-XPI smoke" >&2
    exit 1
  fi

  if ! command -v geckodriver >/dev/null 2>&1; then
    for candidate in \
      "$REPO_ROOT"/tmp/edge-home-*/webdriver/macos/64/geckodriver
    do
      if [[ -x "$candidate" ]]; then
        export PATH="$(dirname "$candidate"):$PATH"
        break
      fi
    done
  fi

  PYTHONPATH="$CORE_ROOT/src:$SELENIUM_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  PTK_BROWSER="firefox" \
  PTK_HEADLESS="$HEADLESS" \
  PTK_INSTALL_MODE="${PTK_INSTALL_MODE:-temporary}" \
  PTK_EXTENSION_XPI_PATH="$FIREFOX_XPI" \
  PTK_PROFILE_DIR="$PROFILE_DIR" \
  PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR" \
  PTK_PROJECT="$PROJECT_NAME" \
  JUICE_SHOP_URL="$JUICE_SHOP_URL" \
  "$PYTHON_BIN" "$SELENIUM_SMOKE_SCRIPT"
  exit $?
fi

PYTHONPATH="$CORE_ROOT/src:$PYTHON_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
PTK_BROWSER="$BROWSER" \
PTK_HEADLESS="$HEADLESS" \
PTK_EXTENSION_PATH="$EXTENSION_PATH" \
PTK_PROFILE_DIR="$PROFILE_DIR" \
PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR" \
PTK_PROJECT="$PROJECT_NAME" \
JUICE_SHOP_URL="$JUICE_SHOP_URL" \
"$PYTHON_BIN" "$SMOKE_SCRIPT"
