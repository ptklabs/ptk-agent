#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUPPETEER_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_OR_PACKAGE_ROOT="$(cd "$PUPPETEER_ROOT/../.." && pwd)"
SOURCE_PTK_ROOT="$(cd "$NPM_OR_PACKAGE_ROOT/.." && pwd)"

if [[ "${PTK_RELEASE_TEST_MODE:-}" == "package" && -n "${PTK_PACKAGE_ROOT:-}" ]]; then
  PENTESTKIT_ROOT="$(cd "$PTK_PACKAGE_ROOT" && pwd)"
  SDK_ROOT="$PENTESTKIT_ROOT"
elif [[ -f "$NPM_OR_PACKAGE_ROOT/extensions/index.cjs" ]]; then
  PENTESTKIT_ROOT="$NPM_OR_PACKAGE_ROOT"
  SDK_ROOT="$NPM_OR_PACKAGE_ROOT"
else
  PENTESTKIT_ROOT="$SOURCE_PTK_ROOT"
  SDK_ROOT="$NPM_OR_PACKAGE_ROOT"
fi

MODE="${PTK_RELEASE_TEST_MODE:-source}"
if [[ -f "$PENTESTKIT_ROOT/extensions/index.cjs" ]]; then
  MODE="${PTK_RELEASE_TEST_MODE:-package}"
fi

BROWSER="${1:-${PTK_BROWSER:-chrome-for-testing}}"
case "$BROWSER" in
  chromium|chrome|chrome-for-testing)
    ;;
  *)
    echo "unsupported browser for Puppeteer experimental smoke wrapper: $BROWSER" >&2
    echo "supported: chromium, chrome, chrome-for-testing" >&2
    exit 1
    ;;
esac

NODE_BIN="${PTK_NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "missing node runtime: $NODE_BIN" >&2
  exit 1
fi

if ! "$NODE_BIN" -e 'const path=require("path"); const {createRequire}=require("module"); const root=process.argv[1]; const load=root ? createRequire(path.join(root,"package.json")) : require; try { load("puppeteer"); } catch (a) { try { load("puppeteer-core"); } catch (b) { process.exit(1); } }' "${PTK_PACKAGE_ROOT:-}" >/dev/null 2>&1; then
  echo "missing optional Puppeteer dependency" >&2
  echo "install puppeteer or puppeteer-core in the project that runs this experimental smoke test" >&2
  exit 80
fi

resolve_package_extension_path() {
  "$NODE_BIN" -e 'const path=require("path"); const root=process.argv[1]; const ext=require(path.join(root,"extensions","index.cjs")); const result=ext.ensureUnpackedPtkExtension({packageRoot:root, cacheRoot:process.env.PTK_EXTENSION_CACHE_DIR || path.join(process.cwd(), ".ptk")}); process.stdout.write(result.path);' "$PENTESTKIT_ROOT"
}

resolve_chrome_for_testing_binary() {
  if [[ -n "${PTK_PUPPETEER_EXECUTABLE_PATH:-}" && -x "$PTK_PUPPETEER_EXECUTABLE_PATH" ]]; then
    printf '%s\n' "$PTK_PUPPETEER_EXECUTABLE_PATH"
    return 0
  fi
  if [[ -n "${PTK_EXECUTABLE_PATH:-}" && -x "$PTK_EXECUTABLE_PATH" ]]; then
    printf '%s\n' "$PTK_EXECUTABLE_PATH"
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
  DEFAULT_RUN_ROOT="$PWD/.ptk/juice-puppeteer-smoke"
else
  DEFAULT_EXTENSION_PATH="$PENTESTKIT_ROOT/dist/ptk_extension_unpacked_automation"
  DEFAULT_RUN_ROOT="$PENTESTKIT_ROOT/tmp/juice-puppeteer-smoke"
fi

EXTENSION_PATH="${PTK_EXTENSION_PATH:-$DEFAULT_EXTENSION_PATH}"
if [[ ! -d "$EXTENSION_PATH" ]]; then
  echo "missing unpacked PTK extension directory: $EXTENSION_PATH" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
RUN_ROOT="${PTK_SMOKE_RUN_ROOT:-$DEFAULT_RUN_ROOT}"
RUN_NAME="${PTK_SMOKE_RUN_NAME:-$STAMP-$BROWSER}"
RUN_DIR="${PTK_RUN_DIR:-$RUN_ROOT/$RUN_NAME}"
PROFILE_DIR="${PTK_PROFILE_DIR:-$RUN_DIR/profile}"
ARTIFACTS_DIR="${PTK_ARTIFACTS_DIR:-$RUN_DIR/artifacts}"
JUICE_SHOP_URL="${JUICE_SHOP_URL:-http://localhost:3001}"
PROJECT_NAME="${PTK_PROJECT:-juice-shop-puppeteer-smoke}"

mkdir -p "$PROFILE_DIR" "$ARTIFACTS_DIR"

if [[ "$BROWSER" == "chrome-for-testing" && -z "${PTK_PUPPETEER_EXECUTABLE_PATH:-}" && -z "${PTK_EXECUTABLE_PATH:-}" ]]; then
  if CHROME_FOR_TESTING_BINARY="$(resolve_chrome_for_testing_binary)" && [[ -n "$CHROME_FOR_TESTING_BINARY" && -x "$CHROME_FOR_TESTING_BINARY" ]]; then
    export PTK_PUPPETEER_EXECUTABLE_PATH="$CHROME_FOR_TESTING_BINARY"
  fi
fi

echo "Smoke run dir: $RUN_DIR"
echo "Browser: $BROWSER"
echo "Mode: $MODE"
echo "Profile: $PROFILE_DIR"
echo "Artifacts: $ARTIFACTS_DIR"
echo "Target: $JUICE_SHOP_URL"
echo "Extension: $EXTENSION_PATH"
if [[ -n "${PTK_PUPPETEER_EXECUTABLE_PATH:-}" ]]; then
  echo "Puppeteer executable: $PTK_PUPPETEER_EXECUTABLE_PATH"
fi

PTK_RELEASE_TEST_MODE="$MODE" \
PTK_BROWSER="$BROWSER" \
PTK_EXTENSION_PATH="$EXTENSION_PATH" \
PTK_PROFILE_DIR="$PROFILE_DIR" \
PTK_ARTIFACTS_DIR="$ARTIFACTS_DIR" \
PTK_PROJECT="$PROJECT_NAME" \
JUICE_SHOP_URL="$JUICE_SHOP_URL" \
"$NODE_BIN" "$SCRIPT_DIR/juice_shop_scan.cjs"
