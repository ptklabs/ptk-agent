#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CYPRESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_OR_PACKAGE_ROOT="$(cd "$CYPRESS_ROOT/../.." && pwd)"
SOURCE_PTK_ROOT="$(cd "$NPM_OR_PACKAGE_ROOT/.." && pwd)"
REPO_OR_NODE_ROOT="$(cd "$SOURCE_PTK_ROOT/.." && pwd)"

MODE="${PTK_RELEASE_TEST_MODE:-source}"
if [[ "$MODE" == "package" && -n "${PTK_PACKAGE_ROOT:-}" ]]; then
  PENTESTKIT_ROOT="$(cd "$PTK_PACKAGE_ROOT" && pwd)"
elif [[ -f "$NPM_OR_PACKAGE_ROOT/extensions/index.cjs" ]]; then
  PENTESTKIT_ROOT="$NPM_OR_PACKAGE_ROOT"
  MODE="${PTK_RELEASE_TEST_MODE:-package}"
else
  PENTESTKIT_ROOT="$SOURCE_PTK_ROOT"
fi

BROWSER="${1:-${PTK_BROWSER:-chrome-for-testing}}"
case "$BROWSER" in
  chrome-for-testing|chromium|edge|firefox)
    ;;
  electron)
    echo "Electron does not support PTK browser-extension release smoke tests" >&2
    exit 1
    ;;
  *)
    echo "unsupported browser for Cypress smoke wrapper: $BROWSER" >&2
    echo "supported: chrome-for-testing, chromium, edge, firefox" >&2
    exit 1
    ;;
esac

HEADLESS="${PTK_HEADLESS:-0}"
if [[ "$BROWSER" != "firefox" && "$HEADLESS" =~ ^(1|true|yes|on)$ ]]; then
  echo "Cypress Chromium-family baseline must run headed for reliable extension loading" >&2
  exit 1
fi

NODE_BIN="${PTK_NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "missing node runtime: $NODE_BIN" >&2
  exit 1
fi

resolve_package_extension_path() {
  "$NODE_BIN" -e 'const path=require("path"); const root=process.argv[1]; const ext=require(path.join(root,"extensions","index.cjs")); const result=ext.ensureUnpackedPtkExtension({packageRoot:root, cacheRoot:process.env.PTK_EXTENSION_CACHE_DIR || path.join(process.cwd(), ".ptk")}); process.stdout.write(result.path);' "$PENTESTKIT_ROOT"
}

resolve_chrome_for_testing_binary() {
  if [[ -n "${PTK_CYPRESS_BROWSER_PATH:-}" && -x "$PTK_CYPRESS_BROWSER_PATH" ]]; then
    printf '%s\n' "$PTK_CYPRESS_BROWSER_PATH"
    return 0
  fi
  if [[ -n "${PTK_CHROME_BINARY:-}" && -x "$PTK_CHROME_BINARY" ]]; then
    printf '%s\n' "$PTK_CHROME_BINARY"
    return 0
  fi
  "$NODE_BIN" -e 'const path=require("path"); const {createRequire}=require("module"); const root=process.argv[1]; try { const load=root ? createRequire(path.join(root,"package.json")) : require; const p=load("playwright").chromium.executablePath(); if (p) console.log(p); } catch (_) {}' "${PTK_PACKAGE_ROOT:-}"
}

if [[ "$MODE" == "package" ]]; then
  DEFAULT_EXTENSION_PATH="$(resolve_package_extension_path)"
  DEFAULT_RUN_ROOT="$PWD/.ptk/juice-cypress-smoke"
else
  DEFAULT_EXTENSION_PATH="$PENTESTKIT_ROOT/dist/ptk_extension_unpacked_automation"
  DEFAULT_RUN_ROOT="$REPO_OR_NODE_ROOT/tmp/juice-cypress-smoke"
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
RUN_ROOT="${PTK_SMOKE_RUN_ROOT:-$DEFAULT_RUN_ROOT}"
RUN_NAME="${PTK_SMOKE_RUN_NAME:-$STAMP-$BROWSER}"
RUN_DIR="${PTK_RUN_DIR:-$RUN_ROOT/$RUN_NAME}"
ARTIFACTS_DIR="${PTK_ARTIFACTS_DIR:-$RUN_DIR/artifacts}"
JUICE_SHOP_URL="${JUICE_SHOP_URL:-http://localhost:3001}"
EXTENSION_PATH="${PTK_EXTENSION_PATH:-$DEFAULT_EXTENSION_PATH}"

if [[ "$MODE" != "package" && ! -d "$EXTENSION_PATH" ]]; then
  echo "missing unpacked PTK extension directory: $EXTENSION_PATH" >&2
  exit 1
fi

mkdir -p "$ARTIFACTS_DIR" "$RUN_DIR/videos" "$RUN_DIR/screenshots"

echo "Smoke run dir: $RUN_DIR"
echo "Browser: $BROWSER"
echo "Mode: $MODE"
echo "Artifacts: $ARTIFACTS_DIR"
echo "Target: $JUICE_SHOP_URL"
echo "Extension: $EXTENSION_PATH"

CYPRESS_BROWSER="$BROWSER"
if [[ "$BROWSER" == "chrome-for-testing" ]]; then
  if CHROME_FOR_TESTING_BINARY="$(resolve_chrome_for_testing_binary)" && [[ -n "$CHROME_FOR_TESTING_BINARY" && -x "$CHROME_FOR_TESTING_BINARY" ]]; then
    CYPRESS_BROWSER="$CHROME_FOR_TESTING_BINARY"
    echo "Chrome for Testing: $CYPRESS_BROWSER"
  fi
elif [[ "$BROWSER" == "firefox" ]]; then
  FIREFOX_BINARY="${PTK_CYPRESS_FIREFOX_BINARY:-${PTK_FIREFOX_BINARY:-}}"
  if [[ -n "$FIREFOX_BINARY" && -x "$FIREFOX_BINARY" ]]; then
    CYPRESS_BROWSER="$FIREFOX_BINARY"
    echo "Firefox executable: $CYPRESS_BROWSER"
  fi
fi

if [[ -n "${PTK_CYPRESS_BIN:-}" ]]; then
  CYPRESS_BIN="$PTK_CYPRESS_BIN"
elif [[ -x "$CYPRESS_ROOT/node_modules/.bin/cypress" ]]; then
  CYPRESS_BIN="$CYPRESS_ROOT/node_modules/.bin/cypress"
elif [[ -x "$REPO_OR_NODE_ROOT/node_modules/.bin/cypress" ]]; then
  CYPRESS_BIN="$REPO_OR_NODE_ROOT/node_modules/.bin/cypress"
elif command -v cypress >/dev/null 2>&1; then
  CYPRESS_BIN="$(command -v cypress)"
else
  CYPRESS_BIN="npx"
fi

if [[ "$CYPRESS_BIN" != "npx" && ! -x "$CYPRESS_BIN" ]]; then
  echo "configured Cypress binary is not executable: $CYPRESS_BIN" >&2
  exit 1
fi

if [[ "$CYPRESS_BIN" != "npx" ]]; then
  CYPRESS_BIN_DIR="$(cd "$(dirname "$CYPRESS_BIN")" && pwd)"
  CYPRESS_NODE_MODULES="$(cd "$CYPRESS_BIN_DIR/.." && pwd)"
  if [[ -d "$CYPRESS_NODE_MODULES/cypress" ]]; then
    export NODE_PATH="$CYPRESS_NODE_MODULES${NODE_PATH:+:$NODE_PATH}"
  fi
fi

export PTK_RELEASE_TEST_MODE="$MODE"
export PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR"
export JUICE_SHOP_URL="$JUICE_SHOP_URL"
export PTK_BROWSER="$BROWSER"
export PTK_HEADLESS="$HEADLESS"
export PTK_CYPRESS_COMPAT_MODE="${PTK_CYPRESS_COMPAT_MODE:-strict}"
export PTK_CYPRESS_EXTENSION_DIR="${PTK_CYPRESS_EXTENSION_DIR:-$RUN_DIR/cypress-extension}"
unset ELECTRON_RUN_AS_NODE || true
if [[ "$BROWSER" != "firefox" || "$MODE" != "package" || -n "${PTK_EXTENSION_PATH:-}" ]]; then
  export PTK_EXTENSION_PATH="$EXTENSION_PATH"
else
  unset PTK_EXTENSION_PATH || true
fi

COMMON_ARGS=(
  "cypress" "run"
  "--browser" "$CYPRESS_BROWSER"
  "--headed"
  "--project" "$CYPRESS_ROOT"
  "--config-file" "$CYPRESS_ROOT/examples/cypress.config.js"
  "--spec" "$CYPRESS_ROOT/smoke/juice-shop-smoke.cy.js"
  "--config" "baseUrl=$JUICE_SHOP_URL,videosFolder=$RUN_DIR/videos,screenshotsFolder=$RUN_DIR/screenshots"
)

if [[ "$CYPRESS_BIN" == "npx" ]]; then
  npx "${COMMON_ARGS[@]}"
else
  "$CYPRESS_BIN" "${COMMON_ARGS[@]:1}"
fi
