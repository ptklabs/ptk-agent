#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { unpackCrx } = require("./unpack-crx.cjs");
const { runPreflight } = require("./preflight-release-frameworks.cjs");
const { verifyArtifacts } = require("./verify-framework-artifacts.cjs");

const NPM_ROOT = path.resolve(__dirname, "..");
const SDKS_ROOT = path.resolve(NPM_ROOT, "..");
const PYPI_ROOT = path.resolve(SDKS_ROOT, "pypi");
const SOURCE_PTK_ROOT = SDKS_ROOT;
const DEFAULT_STAGE_ROOT = path.resolve(NPM_ROOT, ".release", "npm", "pentestkit");

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    framework: "all",
    browser: null,
    targetUrl: process.env.JUICE_SHOP_URL || "http://localhost:3001",
    runId: new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14),
    artifactsRoot: path.resolve(SOURCE_PTK_ROOT, "tmp", "sdk-release-tests"),
    immediateAnalysis: null,
    mode: "source",
    packageTarball: null,
    packageRoot: null,
    baselineOnly: false,
    includeOptional: false,
    extension: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--framework") options.framework = argv[++index];
    else if (arg === "--browser") options.browser = argv[++index];
    else if (arg === "--target-url") options.targetUrl = argv[++index];
    else if (arg === "--run-id") options.runId = argv[++index];
    else if (arg === "--artifacts-root") options.artifactsRoot = path.resolve(argv[++index]);
    else if (arg === "--immediate-analysis") options.immediateAnalysis = parseBool(argv[++index]);
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--package-tarball") options.packageTarball = path.resolve(argv[++index]);
    else if (arg === "--package-root") options.packageRoot = path.resolve(argv[++index]);
    else if (arg === "--baseline-only") options.baselineOnly = true;
    else if (arg === "--include-optional") options.includeOptional = true;
    else if (arg === "--extension") options.extension = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function parseBool(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

function help() {
  return [
    "Usage:",
    "  node scripts/test-release-frameworks.cjs [options]",
    "",
    "Options:",
    "  --framework playwright|selenium|cypress|puppeteer|all",
    "  --browser <name>",
    "  --target-url <url>",
    "  --run-id <id>",
    "  --artifacts-root <path>",
    "  --immediate-analysis true|false",
    "  --mode source|package|both",
    "  --package-tarball <path>",
    "  --package-root <path>",
    "  --baseline-only",
    "  --include-optional",
    "  --extension full|automation|both",
  ].join("\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    encoding: "utf8",
    timeout: options.timeout,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const error = new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status || result.signal}`
    );
    error.result = result;
    throw error;
  }
  return result;
}

function newestTarball() {
  const dir = path.resolve(NPM_ROOT, ".release", "npm");
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir)
    .filter((name) => /^pentestkit-.*\.tgz$/.test(name))
    .sort()
    .map((name) => path.join(dir, name))
    .pop() || null;
}

function installPackageMode(options) {
  if (options.packageRoot) {
    return {
      tempRoot: null,
      packageRoot: options.packageRoot,
      tarball: options.packageTarball || null,
    };
  }
  const tarball = options.packageTarball || newestTarball();
  if (!tarball || !fs.existsSync(tarball)) {
    throw new Error("Package mode requires --package-tarball or a staged .release/npm/pentestkit-*.tgz");
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptk-sdk-framework-package-"));
  run("npm", ["init", "-y"], { cwd: tempRoot, capture: true });
  run("npm", [
    "install",
    tarball,
    "--package-lock=false",
    "--ignore-scripts",
    "--prefer-offline",
    "--fetch-retries=0",
    "--fetch-timeout=10000",
  ], {
    cwd: tempRoot,
    capture: false,
    timeout: Number(process.env.PTK_NPM_INSTALL_TIMEOUT_MS || 120000),
    env: {
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "10000",
      npm_config_cache: path.join(tempRoot, ".npm-cache"),
    },
  });
  const installedPackageRoot = path.join(tempRoot, "node_modules", "pentestkit");
  const runnablePackageRoot = path.join(tempRoot, "pentestkit-package");
  fs.cpSync(installedPackageRoot, runnablePackageRoot, {
    recursive: true,
    dereference: true,
  });
  return {
    tempRoot,
    packageRoot: fs.realpathSync(runnablePackageRoot),
    tarball,
  };
}

function rowsFor(options) {
  const rows = [
    {
      framework: "playwright",
      browser: options.browser || "chromium",
      optional: false,
    },
    {
      framework: "selenium",
      browser: options.browser || process.env.PTK_SELENIUM_BASELINE_BROWSER || "chrome",
      optional: false,
    },
    {
      framework: "cypress",
      browser: options.browser || "chrome-for-testing",
      optional: false,
    },
    {
      framework: "puppeteer",
      browser: options.browser || "chrome-for-testing",
      optional: true,
    },
  ];
  return rows.filter((row) => {
    if (options.framework === "all") return !row.optional || options.includeOptional;
    return row.framework === options.framework;
  });
}

function rootsForMode(mode, packageInfo) {
  if (mode === "source") {
    return {
      mode,
      packageRoot: null,
      ptkRoot: SOURCE_PTK_ROOT,
      sdkRoot: NPM_ROOT,
      pypiRoot: PYPI_ROOT,
      extensionPath: null,
      fullCrx: path.join(SOURCE_PTK_ROOT, "dist", "ptk-latest.crx"),
      automationCrx: path.join(SOURCE_PTK_ROOT, "dist", "ptk-latest-automation.crx"),
      fullFirefoxXpi: path.join(SOURCE_PTK_ROOT, "dist", "ptk-latest.xpi"),
      firefoxXpi: path.join(SOURCE_PTK_ROOT, "dist", "ptk-latest-automation.xpi"),
    };
  }
  const packageRoot = packageInfo.packageRoot || DEFAULT_STAGE_ROOT;
  return {
    mode,
    packageRoot,
    ptkRoot: packageRoot,
    // Package smoke runners are release-test fixtures and are deliberately not
    // shipped. Keep the runner outside the tarball while PTK_PACKAGE_ROOT points
    // every public SDK/extension load at the installed package.
    sdkRoot: NPM_ROOT,
    pypiRoot: PYPI_ROOT,
    extensionPath: null,
    automationCrx: null,
    firefoxXpi: null,
  };
}

function extensionVariantsForMode(mode, options) {
  const requested = options.extension || (mode === "source" ? "both" : "automation");
  if (!["full", "automation", "both"].includes(requested)) {
    throw new Error("--extension must be full, automation, or both");
  }
  if (mode === "package") {
    if (requested === "full") {
      throw new Error("Package-mode smoke cannot run the full extension because the npm package ships the automation artifact only.");
    }
    return ["automation"];
  }
  return requested === "both" ? ["full", "automation"] : [requested];
}

function scriptFor(row, roots) {
  if (row.framework === "playwright") {
    return path.join(roots.sdkRoot, "frameworks", "playwright", "smoke", "run_juice_shop_smoke.sh");
  }
  if (row.framework === "selenium") {
    return path.join(roots.sdkRoot, "frameworks", "selenium", "smoke", "run_juice_shop_smoke.sh");
  }
  if (row.framework === "cypress") {
    return path.join(roots.sdkRoot, "frameworks", "cypress", "smoke", "run_juice_shop_smoke.sh");
  }
  if (row.framework === "puppeteer") {
    return path.join(roots.sdkRoot, "frameworks", "puppeteer", "smoke", "run_juice_shop_smoke.sh");
  }
  throw new Error(`Unsupported framework: ${row.framework}`);
}

function validateAutomationExtensionDir(extensionPath, variant = "automation") {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const devLocalPath = path.join(extensionPath, "dev.local.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Automation extension manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const backgroundEntry = manifest?.background?.service_worker || manifest?.background?.page || null;
  const fullEntries = new Set(["app.js", "ptk/background.html"]);
  const automationEntries = new Set(["app_automation.js", "ptk/background_automation.html"]);
  if (variant === "full" && !fullEntries.has(backgroundEntry)) {
    throw new Error(`Full extension smoke expected a full background entry: ${extensionPath}`);
  }
  if (variant === "automation" && !automationEntries.has(backgroundEntry)) {
    throw new Error(`Automation extension smoke expected an automation background entry: ${extensionPath}`);
  }
  if (variant === "full" && !fs.existsSync(devLocalPath)) {
    throw new Error(`Automation extension must use app_automation.js or provide dev.local.json: ${extensionPath}`);
  }
  if (fs.existsSync(devLocalPath)) {
    const devLocal = JSON.parse(fs.readFileSync(devLocalPath, "utf8"));
    if (devLocal.automationEnabled !== true) {
      throw new Error(`Automation extension dev.local.json must set automationEnabled: true: ${devLocalPath}`);
    }
    if (devLocal.automationAllowChildFrameBootstrap === true) {
      throw new Error(`Automation extension dev.local.json must not enable child-frame bootstrap globally: ${devLocalPath}`);
    }
  }
}

function writeFullExtensionAutomationConfig(extensionPath) {
  fs.writeFileSync(
    path.join(extensionPath, "dev.local.json"),
    `${JSON.stringify({ automationEnabled: true }, null, 2)}\n`,
    "utf8"
  );
}

function enableStagedFullExtensionAutomationSetting(extensionPath) {
  const settingsPath = path.join(extensionPath, "ptk", "settings.default.js");
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Full extension settings defaults not found: ${settingsPath}`);
  }
  const source = fs.readFileSync(settingsPath, "utf8");
  const updated = source.replace(
    /(automation\s*:\s*\{\s*enable\s*:\s*)false(\s*\})/,
    "$1true$2"
  );
  if (updated === source) {
    throw new Error(`Could not enable the staged full extension automation setting: ${settingsPath}`);
  }
  fs.writeFileSync(settingsPath, updated, "utf8");
}

function exposeStagedFirefoxAutomationControl(extensionPath) {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const resource = "ptk/automation/control.html";
  if (!Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources = [];
  }
  if (!manifest.web_accessible_resources.includes(resource)) {
    manifest.web_accessible_resources.push(resource);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function prepareSourceExtension(roots, rowRoot, variant) {
  if (roots.mode !== "source") return roots.extensionPath;
  const sourceCrx = variant === "full" ? roots.fullCrx : roots.automationCrx;
  if (!sourceCrx || !fs.existsSync(sourceCrx)) {
    throw new Error(`Source-mode ${variant} CRX not found: ${sourceCrx}. Run npm run build_pkg first.`);
  }
  const extensionPath = path.join(rowRoot, `extension-${variant}`);
  fs.rmSync(extensionPath, { recursive: true, force: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  unpackCrx(sourceCrx, extensionPath);
  if (variant === "full") {
    writeFullExtensionAutomationConfig(extensionPath);
  }
  validateAutomationExtensionDir(extensionPath, variant);
  return fs.realpathSync(extensionPath);
}

function prepareSourceFirefoxXpi(roots, rowRoot, variant) {
  if (roots.mode !== "source") return null;
  const sourceXpi = variant === "full" ? roots.fullFirefoxXpi : roots.firefoxXpi;
  if (!sourceXpi || !fs.existsSync(sourceXpi)) {
    throw new Error(`Source-mode ${variant} Firefox XPI not found: ${sourceXpi}. Run npm run build_pkg first.`);
  }
  if (variant === "automation") return fs.realpathSync(sourceXpi);

  const extensionPath = path.join(rowRoot, "extension-full-firefox");
  const stagedXpi = path.join(rowRoot, "ptk-full-firefox-smoke.xpi");
  fs.rmSync(extensionPath, { recursive: true, force: true });
  fs.rmSync(stagedXpi, { force: true });
  fs.mkdirSync(extensionPath, { recursive: true });
  unpackCrx(sourceXpi, extensionPath);
  writeFullExtensionAutomationConfig(extensionPath);
  // Firefox MV2 does not reliably consume a late-added dev.local.json from a
  // temporary XPI. Simulate the user's explicit Automation setting in this
  // staged test artifact, then require the trusted page activation handshake.
  enableStagedFullExtensionAutomationSetting(extensionPath);
  // The published full Firefox build intentionally keeps this private page
  // non-web-accessible. This automation-enabled test-only XPI needs the same
  // inert about:blank iframe transport used by the automation build.
  exposeStagedFirefoxAutomationControl(extensionPath);
  validateAutomationExtensionDir(extensionPath, variant);

  const packed = spawnSync("zip", ["-q", "-r", stagedXpi, "."], {
    cwd: extensionPath,
    encoding: "utf8",
  });
  if (packed.error || packed.status !== 0) {
    throw new Error(
      `Could not stage full Firefox smoke XPI: ${packed.stderr || packed.stdout || packed.error?.message || `exit ${packed.status}`}`
    );
  }
  return fs.realpathSync(stagedXpi);
}

function runRow(row, roots, options, extensionVariant) {
  const rowRoot = path.join(options.artifactsRoot, options.runId, roots.mode, extensionVariant, row.framework, row.browser);
  const artifactsDir = path.join(rowRoot, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const script = scriptFor(row, roots);
  if (!fs.existsSync(script)) throw new Error(`Runner not found: ${script}`);
  const extensionPath = row.browser === "firefox"
    ? roots.extensionPath
    : prepareSourceExtension(roots, rowRoot, extensionVariant);
  const extensionXpiPath = row.browser === "firefox"
    ? prepareSourceFirefoxXpi(roots, rowRoot, extensionVariant)
    : null;

  const env = {
    PTK_RELEASE_TEST_MODE: roots.mode,
    PTK_EXTENSION_VARIANT: extensionVariant,
    PTK_RUN_DIR: rowRoot,
    PTK_ARTIFACTS_DIR: artifactsDir,
    PTK_BROWSER: row.browser,
    PTK_BRIDGE_ACTIVATE: extensionVariant === "full" ? "1" : "0",
    PTK_PACKAGE_ROOT: roots.packageRoot || "",
    PTK_EXTENSION_CACHE_DIR: path.join(rowRoot, ".ptk"),
    JUICE_SHOP_URL: options.targetUrl,
  };

  // Do not pass null values through child_process env: Node coerces them to
  // the literal string "null", which overrides the package runner's resolver.
  if (extensionXpiPath) {
    env.PTK_FIREFOX_XPI = extensionXpiPath;
    env.PTK_EXTENSION_XPI_PATH = extensionXpiPath;
  }

  if (row.framework === "cypress") {
    env.PTK_CYPRESS_EXTENSION_DIR = path.join(rowRoot, "cypress-extension");
  }

  if (options.immediateAnalysis !== null) {
    env.PTK_IMMEDIATE_ANALYSIS = options.immediateAnalysis ? "1" : "0";
  }

  if (extensionPath && (row.framework !== "cypress" || roots.mode !== "package" || extensionPath !== roots.extensionPath)) {
    env.PTK_EXTENSION_PATH = extensionPath;
  }

  if (["playwright", "selenium", "puppeteer"].includes(row.framework)) {
    env.PTK_PROFILE_DIR = path.join(rowRoot, "profile");
  } else if (row.browser === "firefox") {
    env.PTK_PROFILE_DIR = process.env.PTK_PROFILE_DIR || path.join(rowRoot, "profile");
  } else if (row.framework === "cypress") {
    env.PTK_PROFILE_DIR = "";
  }

  const startedAt = new Date().toISOString();
  let status = "passed";
  let failureReason = null;
  try {
    run(script, [row.browser], { cwd: path.dirname(script), env });
    verifyArtifacts({
      artifactsDir,
      requireEngines: true,
    });
  } catch (error) {
    status = "failed";
    failureReason = error.message;
  }
  const endedAt = new Date().toISOString();
  return {
    framework: row.framework,
    browser: row.browser,
    mode: roots.mode,
    extension: extensionVariant,
    status,
    failureReason,
    runDir: rowRoot,
    artifactsDir,
    startedAt,
    endedAt,
  };
}

function runFrameworkRelease(options) {
  if (!["source", "package", "both"].includes(options.mode)) {
    throw new Error("--mode must be source, package, or both");
  }
  const modes = options.mode === "both" ? ["source", "package"] : [options.mode];
  const packageInfo = modes.includes("package") ? installPackageMode(options) : {};

  const preflight = runPreflight({
    mode: options.mode === "both" ? "both" : options.mode,
    packageRoot: packageInfo.packageRoot || DEFAULT_STAGE_ROOT,
  });
  if (!preflight.ok) {
    throw new Error(
      `Preflight failed:\n${preflight.errors.map((line) => `- ${line}`).join("\n")}`
    );
  }

  const rowResults = [];
  for (const mode of modes) {
    const roots = rootsForMode(mode, packageInfo);
    const extensionVariants = extensionVariantsForMode(mode, options);
    for (const row of rowsFor(options)) {
      for (const extensionVariant of extensionVariants) {
        rowResults.push(runRow(row, roots, options, extensionVariant));
      }
    }
  }

  const summary = {
    ok: rowResults.every((row) => row.status === "passed"),
    runId: options.runId,
    artifactsRoot: path.join(options.artifactsRoot, options.runId),
    targetUrl: options.targetUrl,
    mode: options.mode,
    packageRoot: packageInfo.packageRoot || null,
    packageTarball: packageInfo.tarball || null,
    rows: rowResults,
  };
  fs.mkdirSync(summary.artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(summary.artifactsRoot, "framework-release-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );
  return summary;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(help());
      return 0;
    }
    const summary = runFrameworkRelease(options);
    console.log(JSON.stringify(summary, null, 2));
    return summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  runFrameworkRelease,
  extensionVariantsForMode,
  enableStagedFullExtensionAutomationSetting,
  exposeStagedFirefoxAutomationControl,
  prepareSourceFirefoxXpi,
  validateAutomationExtensionDir,
  writeFullExtensionAutomationConfig,
};
