#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const NPM_ROOT = path.resolve(__dirname, "..");
const SDKS_ROOT = path.resolve(NPM_ROOT, "..");
const PYPI_ROOT = path.resolve(SDKS_ROOT, "pypi");
const SOURCE_PTK_ROOT = SDKS_ROOT;
const DEFAULT_STAGE_ROOT = path.resolve(NPM_ROOT, ".release", "npm", "pentestkit");

const SOURCE_NPM_REQUIRED = [
  "agents/src/browser/ptkBridge.cjs",
  "browser/src/index.cjs",
  "browser/src/index.d.ts",
  "frameworks/cypress/smoke/run_juice_shop_smoke.sh",
  "frameworks/cypress/examples/cypress.config.js",
  "frameworks/cypress/examples/support/e2e.js",
  "frameworks/cypress/examples/juice-shop.cy.js",
  "frameworks/cypress/smoke/juice-shop-smoke.cy.js",
  "frameworks/playwright/src/index.cjs",
  "frameworks/playwright/src/index.d.ts",
  "frameworks/playwright/examples/juice-shop-with-ptk.mjs",
  "frameworks/playwright/smoke/run_juice_shop_smoke.sh",
  "frameworks/playwright/smoke/juice_shop_scan.mjs",
  "frameworks/puppeteer/src/index.cjs",
  "frameworks/puppeteer/src/index.d.ts",
  "frameworks/puppeteer/smoke/run_juice_shop_smoke.sh",
  "frameworks/puppeteer/smoke/juice_shop_scan.cjs",
  "frameworks/puppeteer/examples/juice-shop-with-ptk.cjs",
  "frameworks/selenium/src/index.cjs",
  "frameworks/selenium/src/index.d.ts",
  "frameworks/selenium/examples/juice-shop-selenium.cjs",
  "frameworks/selenium/smoke/run_juice_shop_smoke.sh",
  "frameworks/selenium/smoke/juice_shop_scan.cjs",
  "providers/testmu/index.cjs",
  "providers/testmu/examples/README.md",
  "providers/testmu/examples/cypress-juice-shop/README.md",
  "providers/testmu/examples/cypress-juice-shop/package.json",
  "providers/testmu/examples/cypress-juice-shop/lambdatest-config.json",
  "providers/testmu/examples/cypress-juice-shop/cypress.config.js",
  "providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js",
  "providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js",
  "providers/testmu/examples/k6-browser-juice-shop.js",
  "providers/testmu/examples/playwright-juice-shop.mjs",
  "providers/testmu/examples/puppeteer-juice-shop.mjs",
  "providers/testmu/examples/selenium-juice-shop.mjs",
  "providers/browserstack/index.cjs",
  "providers/browserstack/examples/README.md",
  "providers/browserstack/examples/playwright-juice-shop.mjs",
  "providers/browserstack/examples/puppeteer-juice-shop.mjs",
  "providers/browserstack/examples/selenium-juice-shop.mjs",
  "providers/browserbase/index.cjs",
  "providers/browserbase/examples/README.md",
  "providers/browserbase/examples/playwright-juice-shop.mjs",
  "providers/browserbase/examples/puppeteer-juice-shop.mjs",
  "providers/browserbase/examples/selenium-juice-shop.mjs",
  "providers/browserless/index.cjs",
  "providers/browserless/examples/README.md",
  "providers/browserless/examples/playwright-juice-shop.mjs",
  "providers/browserless/examples/puppeteer-juice-shop.mjs",
  "providers/steel/index.cjs",
  "providers/steel/examples/README.md",
  "providers/steel/examples/playwright-juice-shop.mjs",
  "providers/steel/examples/puppeteer-juice-shop.mjs",
  "providers/steel/examples/selenium-juice-shop.mjs",
  "providers/hyperbrowser/index.cjs",
  "providers/hyperbrowser/examples/README.md",
  "providers/hyperbrowser/examples/playwright-juice-shop.mjs",
  "providers/hyperbrowser/examples/puppeteer-juice-shop.mjs",
  "providers/hyperbrowser/examples/selenium-juice-shop.mjs",
  "examples/github-actions/local-app-dast/README.md",
  "examples/github-actions/local-app-dast/ptk-security-scan.yml",
  "examples/github-actions/playwright-ptk/README.md",
  "examples/github-actions/playwright-ptk/playwright-ptk-smoke.mjs",
  "examples/github-actions/playwright-ptk/ptk-playwright.yml",
  "examples/github-actions/sast-js/README.md",
  "examples/github-actions/sast-js/ptk-sast-js.yml",
  "agents/src/reporting/sarif.cjs",
  "scripts/bootstrap-chromium-automation-profile.mjs",
  "scripts/framework-smoke-helpers.cjs",
  "scripts/verify-framework-artifacts.cjs",
  "scripts/test-release-frameworks.cjs",
  "scripts/prepare-npm-package.cjs"
];

const SOURCE_PYPI_REQUIRED = [
  "pentestkit/pyproject.toml",
  "pentestkit/src/pentestkit/__init__.py",
  "pentestkit/src/pentestkit/core/__init__.py",
  "pentestkit/src/pentestkit/extensions/__init__.py",
  "pentestkit/src/pentestkit/playwright/__init__.py",
  "pentestkit/src/pentestkit/selenium/__init__.py",
  "core/pyproject.toml",
  "core/src/ptk_core/__init__.py",
  "scripts/smoke_packages.py",
  "playwright/pyproject.toml",
  "playwright/examples/juice_shop_scan.py",
  "playwright/smoke/run_juice_shop_smoke.sh",
  "playwright/smoke/juice_shop_scan.py",
  "selenium/pyproject.toml",
  "selenium/examples/juice_shop_scan.py",
  "selenium/smoke/run_juice_shop_smoke.sh",
  "selenium/smoke/juice_shop_scan.py"
];

const PACKAGE_REQUIRED = [
  "index.cjs",
  "index.mjs",
  "index.d.ts",
  "agents/index.cjs",
  "browser/index.cjs",
  "browser/index.mjs",
  "browser/index.d.ts",
  "frameworks/cypress/index.cjs",
  "frameworks/cypress/examples/juice-shop.cy.js",
  "frameworks/playwright/index.cjs",
  "frameworks/playwright/index.mjs",
  "frameworks/playwright/index.d.ts",
  "frameworks/puppeteer/index.cjs",
  "frameworks/puppeteer/index.mjs",
  "frameworks/puppeteer/index.d.ts",
  "frameworks/selenium/index.cjs",
  "frameworks/selenium/index.mjs",
  "frameworks/selenium/index.d.ts",
  "providers/testmu/index.cjs",
  "providers/testmu/examples/README.md",
  "providers/testmu/examples/cypress-juice-shop/README.md",
  "providers/testmu/examples/cypress-juice-shop/package.json",
  "providers/testmu/examples/cypress-juice-shop/lambdatest-config.json",
  "providers/testmu/examples/cypress-juice-shop/cypress.config.js",
  "providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js",
  "providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js",
  "providers/testmu/examples/k6-browser-juice-shop.js",
  "providers/testmu/examples/playwright-juice-shop.mjs",
  "providers/testmu/examples/puppeteer-juice-shop.mjs",
  "providers/testmu/examples/selenium-juice-shop.mjs",
  "providers/browserstack/index.cjs",
  "providers/browserstack/examples/README.md",
  "providers/browserstack/examples/playwright-juice-shop.mjs",
  "providers/browserstack/examples/puppeteer-juice-shop.mjs",
  "providers/browserstack/examples/selenium-juice-shop.mjs",
  "providers/browserbase/index.cjs",
  "providers/browserbase/examples/README.md",
  "providers/browserbase/examples/playwright-juice-shop.mjs",
  "providers/browserbase/examples/puppeteer-juice-shop.mjs",
  "providers/browserbase/examples/selenium-juice-shop.mjs",
  "providers/browserless/index.cjs",
  "providers/browserless/examples/README.md",
  "providers/browserless/examples/playwright-juice-shop.mjs",
  "providers/browserless/examples/puppeteer-juice-shop.mjs",
  "providers/steel/index.cjs",
  "providers/steel/examples/README.md",
  "providers/steel/examples/playwright-juice-shop.mjs",
  "providers/steel/examples/puppeteer-juice-shop.mjs",
  "providers/steel/examples/selenium-juice-shop.mjs",
  "providers/hyperbrowser/index.cjs",
  "providers/hyperbrowser/examples/README.md",
  "providers/hyperbrowser/examples/playwright-juice-shop.mjs",
  "providers/hyperbrowser/examples/puppeteer-juice-shop.mjs",
  "providers/hyperbrowser/examples/selenium-juice-shop.mjs",
  "examples/github-actions/local-app-dast/README.md",
  "examples/github-actions/local-app-dast/ptk-security-scan.yml",
  "examples/github-actions/playwright-ptk/README.md",
  "examples/github-actions/playwright-ptk/playwright-ptk-smoke.mjs",
  "examples/github-actions/playwright-ptk/ptk-playwright.yml",
  "examples/github-actions/sast-js/README.md",
  "examples/github-actions/sast-js/ptk-sast-js.yml",
  "docs/npm/github-actions.md",
  "docs/npm/provider-browser-matrix.md",
  "docs/npm/providers.md",
  "docs/npm/sarif.md",
  "extensions/index.cjs",
  "extensions/ptk-latest.zip",
  "extensions/ptk-latest-firefox.zip",
  "extensions/ptk-latest.crx",
  "extensions/ptk-latest.xpi",
  "extensions/manifests/manifest.automation.chromium.json",
  "extensions/manifests/manifest.automation.firefox.json",
  "extensions/manifests/chromium-mv3.json",
  "extensions/manifests/firefox-mv2.json",
  "extensions/extension-provenance.json"
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: "source",
    packageRoot: DEFAULT_STAGE_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--package-root") options.packageRoot = path.resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function help() {
  return [
    "Usage:",
    "  node scripts/preflight-release-frameworks.cjs [--mode source|package|both]",
    "",
    "Options:",
    "  --package-root <path>  Installed/staged package root for package mode",
  ].join("\n");
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function hasExecutableBit(root, relativePath) {
  const stat = fs.statSync(path.join(root, relativePath));
  return (stat.mode & 0o111) !== 0;
}

function pushIfMissing(errors, root, relativePath, label) {
  if (!exists(root, relativePath)) errors.push(`${label} missing ${relativePath}`);
}

function requireExecutable(errors, root, relativePath, label) {
  if (exists(root, relativePath) && !hasExecutableBit(root, relativePath)) {
    errors.push(`${label} ${relativePath} is not executable`);
  }
}

function checkSource() {
  const errors = [];
  for (const relative of SOURCE_NPM_REQUIRED) pushIfMissing(errors, NPM_ROOT, relative, "source npm");
  for (const relative of SOURCE_PYPI_REQUIRED) pushIfMissing(errors, PYPI_ROOT, relative, "source pypi");

  for (const relative of [
    "frameworks/cypress/smoke/run_juice_shop_smoke.sh",
    "frameworks/playwright/smoke/run_juice_shop_smoke.sh",
    "frameworks/puppeteer/smoke/run_juice_shop_smoke.sh",
    "frameworks/selenium/smoke/run_juice_shop_smoke.sh",
    "frameworks/puppeteer/examples/juice-shop-with-ptk.cjs",
    "frameworks/selenium/examples/juice-shop-selenium.cjs",
    "scripts/bootstrap-chromium-automation-profile.mjs",
    "scripts/preflight-release-frameworks.cjs",
    "scripts/verify-framework-artifacts.cjs",
    "scripts/test-release-frameworks.cjs"
  ]) {
    requireExecutable(errors, NPM_ROOT, relative, "source npm");
  }
  for (const relative of [
    "scripts/smoke_packages.py",
    "playwright/smoke/run_juice_shop_smoke.sh",
    "selenium/smoke/run_juice_shop_smoke.sh"
  ]) {
    requireExecutable(errors, PYPI_ROOT, relative, "source pypi");
  }

  if (exists(NPM_ROOT, "frameworks/cypress/examples/juice-shop.cy.js")) {
    const text = read(NPM_ROOT, "frameworks/cypress/examples/juice-shop.cy.js");
    if (!text.includes('pentestkit/cypress')) errors.push("Public Cypress example does not import pentestkit/cypress");
    if (text.includes("finding_gate") || text.includes("engine_gate")) {
      errors.push("Public Cypress example still contains release-gate logic");
    }
  }

  if (exists(NPM_ROOT, "frameworks/cypress/examples/cypress.config.js")) {
    const text = read(NPM_ROOT, "frameworks/cypress/examples/cypress.config.js");
    if (!text.includes("setupPtkCypress")) {
      errors.push("Cypress example config does not use setupPtkCypress");
    }
  }

  if (exists(NPM_ROOT, "frameworks/cypress/src/plugin.js")) {
    const text = read(NPM_ROOT, "frameworks/cypress/src/plugin.js");
    if (!text.includes("function setupPtkCypress") || !text.includes("prepareCypressExtension")) {
      errors.push("Cypress plugin does not expose automatic setup/prepared extension support");
    }
  }

  if (exists(NPM_ROOT, "frameworks/cypress/smoke/run_juice_shop_smoke.sh")) {
    const text = read(NPM_ROOT, "frameworks/cypress/smoke/run_juice_shop_smoke.sh");
    if (!text.includes("smoke/juice-shop-smoke.cy.js")) {
      errors.push("Cypress smoke wrapper does not use the separate smoke fixture");
    }
    if (!text.includes("PTK_CYPRESS_EXTENSION_DIR")) {
      errors.push("Cypress smoke wrapper does not provide a run-local extension destination");
    }
    if (text.includes("dev.local.json") || text.includes("automationAllowChildFrameBootstrap")) {
      errors.push("Cypress smoke wrapper still generates dev.local.json instead of delegating to setupPtkCypress");
    }
  }

  if (exists(NPM_ROOT, "frameworks/cypress/README.md")) {
    const text = read(NPM_ROOT, "frameworks/cypress/README.md");
    if (!text.includes("setupPtkCypress")) {
      errors.push("Cypress README does not document setupPtkCypress");
    }
    if (text.includes('"automationChildFrameBootstrapOrigins": ["http://127.0.0.1:3001"]')) {
      errors.push("Cypress README still documents a hardcoded child-frame bootstrap origin");
    }
  }

  if (exists(NPM_ROOT, "browser/src/index.cjs")) {
    const text = read(NPM_ROOT, "browser/src/index.cjs");
    if (!text.includes("withPtkScan") || !text.includes("writePtkResults")) {
      errors.push("Browser core does not expose withPtkScan/writePtkResults");
    }
    if (!text.includes("deferStart") || !text.includes("startPtkScan")) {
      errors.push("Browser core does not expose deferred PTK scan start support");
    }
  }

  if (exists(NPM_ROOT, "providers/testmu/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/testmu/src/index.cjs");
    for (const helper of ["connectTestMuPlaywright", "connectTestMuPuppeteer", "connectTestMuSelenium"]) {
      if (!text.includes(helper)) errors.push(`TestMu provider does not expose ${helper}`);
    }
  }

  for (const relative of [
    "providers/testmu/examples/playwright-juice-shop.mjs",
    "providers/testmu/examples/puppeteer-juice-shop.mjs",
    "providers/testmu/examples/selenium-juice-shop.mjs"
  ]) {
    if (exists(NPM_ROOT, relative)) {
      const text = read(NPM_ROOT, relative);
      if (!text.includes('from "pentestkit/')) {
        errors.push(`TestMu npm example does not import from pentestkit package: ${relative}`);
      }
      if (text.includes("integrations/") || text.includes("integrations/shared") || text.includes("run-example")) {
        errors.push(`TestMu npm example references integration harness: ${relative}`);
      }
      if (text.includes("bootstrapUrl") || text.includes("bootstrap:")) {
        errors.push(`TestMu npm example uses PTK-owned bootstrap: ${relative}`);
      }
      if (!text.includes("connectTestMu")) {
        errors.push(`TestMu npm example does not use provider helper: ${relative}`);
      }
    }
  }

  for (const relative of [
    "providers/testmu/examples/cypress-juice-shop/cypress.config.js",
    "providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js",
    "providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js"
  ]) {
    if (exists(NPM_ROOT, relative)) {
      const text = read(NPM_ROOT, relative);
      if (text.includes("integrations/") || text.includes("integrations/shared") || text.includes("run-example")) {
        errors.push(`TestMu Cypress npm example references integration harness: ${relative}`);
      }
      if (text.includes("bootstrapUrl") || text.includes("bootstrap:")) {
        errors.push(`TestMu Cypress npm example uses PTK-owned bootstrap: ${relative}`);
      }
    }
  }

  if (exists(NPM_ROOT, "providers/testmu/examples/cypress-juice-shop/cypress.config.js")) {
    const text = read(NPM_ROOT, "providers/testmu/examples/cypress-juice-shop/cypress.config.js");
    if (!text.includes('require("pentestkit/cypress")') || !text.includes("setupPtkCypress")) {
      errors.push("TestMu Cypress npm example does not configure the PTK Cypress plugin");
    }
  }

  if (exists(NPM_ROOT, "providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js")) {
    const text = read(NPM_ROOT, "providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js");
    if (!text.includes('require("pentestkit/cypress")') || !text.includes("registerCommands")) {
      errors.push("TestMu Cypress npm example does not register PTK Cypress commands");
    }
  }

  if (exists(NPM_ROOT, "providers/testmu/examples/k6-browser-juice-shop.js")) {
    const relative = "providers/testmu/examples/k6-browser-juice-shop.js";
    const text = read(NPM_ROOT, relative);
    if (!text.includes('from "k6/experimental/browser"') || !text.includes("wss://cdp.lambdatest.com/k6")) {
      errors.push("TestMu k6 npm example does not follow the documented TestMu k6 Browser CDP flow");
    }
    if (!text.includes("window.PTK_AGENT") || !text.includes("startScan") || !text.includes("stopScan")) {
      errors.push("TestMu k6 npm example does not use the PTK browser bridge when available");
    }
    if (text.includes('from "pentestkit/') || text.includes("require(\"pentestkit/")) {
      errors.push("TestMu k6 npm example imports the Node npm SDK, which is not available inside k6");
    }
    if (text.includes("integrations/") || text.includes("integrations/shared") || text.includes("run-example")) {
      errors.push(`TestMu k6 npm example references integration harness: ${relative}`);
    }
  }

  if (exists(NPM_ROOT, "providers/browserstack/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/browserstack/src/index.cjs");
    for (const helper of ["connectBrowserStackPlaywright", "connectBrowserStackPuppeteer", "connectBrowserStackSelenium"]) {
      if (!text.includes(helper)) errors.push(`BrowserStack provider does not expose ${helper}`);
    }
  }

  if (exists(NPM_ROOT, "providers/browserbase/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/browserbase/src/index.cjs");
    for (const helper of ["connectBrowserbasePlaywright", "connectBrowserbasePuppeteer", "connectBrowserbaseSelenium"]) {
      if (!text.includes(helper)) errors.push(`Browserbase provider does not expose ${helper}`);
    }
  }

  if (exists(NPM_ROOT, "providers/browserless/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/browserless/src/index.cjs");
    for (const helper of ["connectBrowserlessPlaywright", "connectBrowserlessPuppeteer", "browserlessWsEndpoint"]) {
      if (!text.includes(helper)) errors.push(`Browserless provider does not expose ${helper}`);
    }
    if (!text.includes("BROWSERLESS_EXTENSION_NAME") || !text.includes("launch.extensions") && !text.includes("extensions: extensionNames")) {
      errors.push("Browserless provider does not model uploaded extension names in launch options");
    }
  }

  if (exists(NPM_ROOT, "providers/steel/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/steel/src/index.cjs");
    for (const helper of ["connectSteelPlaywright", "connectSteelPuppeteer", "connectSteelSelenium", "resolveSteelExtensionId"]) {
      if (!text.includes(helper)) errors.push(`Steel provider does not expose ${helper}`);
    }
  }

  if (exists(NPM_ROOT, "providers/hyperbrowser/src/index.cjs")) {
    const text = read(NPM_ROOT, "providers/hyperbrowser/src/index.cjs");
    for (const helper of ["connectHyperbrowserPlaywright", "connectHyperbrowserPuppeteer", "connectHyperbrowserSelenium", "resolveHyperbrowserExtensionId"]) {
      if (!text.includes(helper)) errors.push(`Hyperbrowser provider does not expose ${helper}`);
    }
    if (!text.includes("extensions.create") || !text.includes("extensionIds") || !text.includes("x-hyperbrowser-token")) {
      errors.push("Hyperbrowser provider does not implement the documented extension upload/session/WebDriver contracts");
    }
  }

  const providerExampleChecks = [
    ["providers/browserstack/examples/playwright-juice-shop.mjs", "connectBrowserStackPlaywright"],
    ["providers/browserstack/examples/puppeteer-juice-shop.mjs", "connectBrowserStackPuppeteer"],
    ["providers/browserstack/examples/selenium-juice-shop.mjs", "connectBrowserStackSelenium"],
    ["providers/browserbase/examples/playwright-juice-shop.mjs", "connectBrowserbasePlaywright"],
    ["providers/browserbase/examples/puppeteer-juice-shop.mjs", "connectBrowserbasePuppeteer"],
    ["providers/browserbase/examples/selenium-juice-shop.mjs", "connectBrowserbaseSelenium"],
    ["providers/browserless/examples/playwright-juice-shop.mjs", "connectBrowserlessPlaywright"],
    ["providers/browserless/examples/puppeteer-juice-shop.mjs", "connectBrowserlessPuppeteer"],
    ["providers/steel/examples/playwright-juice-shop.mjs", "connectSteelPlaywright"],
    ["providers/steel/examples/puppeteer-juice-shop.mjs", "connectSteelPuppeteer"],
    ["providers/steel/examples/selenium-juice-shop.mjs", "connectSteelSelenium"],
    ["providers/hyperbrowser/examples/playwright-juice-shop.mjs", "connectHyperbrowserPlaywright"],
    ["providers/hyperbrowser/examples/puppeteer-juice-shop.mjs", "connectHyperbrowserPuppeteer"],
    ["providers/hyperbrowser/examples/selenium-juice-shop.mjs", "connectHyperbrowserSelenium"]
  ];
  for (const [relative, helper] of providerExampleChecks) {
    if (!exists(NPM_ROOT, relative)) continue;
    const text = read(NPM_ROOT, relative);
    if (!text.includes('from "pentestkit/')) {
      errors.push(`Provider npm example does not import from pentestkit package: ${relative}`);
    }
    if (!text.includes(helper)) {
      errors.push(`Provider npm example does not use ${helper}: ${relative}`);
    }
    if (text.includes("integrations/") || text.includes("integrations/shared") || text.includes("run-example")) {
      errors.push(`Provider npm example references integration harness: ${relative}`);
    }
    if (text.includes("bootstrapUrl") || text.includes("bootstrap:")) {
      errors.push(`Provider npm example uses PTK-owned bootstrap: ${relative}`);
    }
  }

  for (const relative of [
    "frameworks/playwright/examples/juice-shop-with-ptk.mjs",
    "frameworks/selenium/examples/juice-shop-selenium.cjs"
  ]) {
    if (exists(NPM_ROOT, relative)) {
      const text = read(NPM_ROOT, relative);
      if (text.includes("finding_gate") || text.includes("engine_gate")) {
        errors.push(`Public npm example still contains release-gate logic: ${relative}`);
      }
    }
  }

  if (exists(NPM_ROOT, "frameworks/selenium/src/index.cjs")) {
    const text = read(NPM_ROOT, "frameworks/selenium/src/index.cjs");
    if (!text.includes("executeAsyncScript")) {
      errors.push("Selenium JS adapter does not use executeAsyncScript");
    }
    if (!text.includes("defaultContent")) {
      errors.push("Selenium JS adapter does not handle/document default content switching");
    }
  }

  for (const relative of ["playwright/pyproject.toml", "selenium/pyproject.toml"]) {
    if (exists(PYPI_ROOT, relative)) {
      const text = read(PYPI_ROOT, relative);
      if (/name\s*=\s*"(playwright|selenium)"/.test(text)) {
        errors.push(`PyPI package ${relative} uses a non-PTK distribution name`);
      }
    }
  }

  if (exists(PYPI_ROOT, "pentestkit/pyproject.toml")) {
    const text = read(PYPI_ROOT, "pentestkit/pyproject.toml");
    if (!/name\s*=\s*"pentestkit"/.test(text)) {
      errors.push("Public PyPI package must be named pentestkit");
    }
  }

  if (!exists(SOURCE_PTK_ROOT, "dist/ptk-latest-automation.crx")) {
    errors.push("source SDK Chromium automation CRX is missing dist/ptk-latest-automation.crx");
  }
  if (!exists(SOURCE_PTK_ROOT, "dist/ptk-latest-automation.xpi")) {
    errors.push("source SDK Firefox automation XPI is missing dist/ptk-latest-automation.xpi");
  }

  return {
    ok: errors.length === 0,
    mode: "source",
    root: SDKS_ROOT,
    errors,
  };
}

function checkPackage(packageRoot) {
  const errors = [];
  if (!fs.existsSync(packageRoot)) {
    errors.push(`package root does not exist: ${packageRoot}`);
  } else {
    for (const relative of PACKAGE_REQUIRED) pushIfMissing(errors, packageRoot, relative, "package");
    for (const relative of [
      "bin/ptk-scan",
      "bin/ptk-agent",
      "bin/ptk-agent-mcp-server"
    ]) {
      requireExecutable(errors, packageRoot, relative, "package");
    }
    for (const forbidden of [
      "integrations",
      "pypi",
      "scripts",
      "agents/bin",
      "agents/benchmarks",
      "agents/src/benchmarks",
      "agents/src/cli/commands/benchmark.cjs",
      "cypress",
      "playwright",
      "puppeteer",
      "selenium",
      "frameworks/cypress/smoke",
      "frameworks/cypress/package.json",
      "frameworks/playwright/smoke",
      "frameworks/puppeteer/smoke",
      "frameworks/selenium/smoke",
      ".runs",
      ".cache"
    ]) {
      if (exists(packageRoot, forbidden)) errors.push(`package contains forbidden path ${forbidden}`);
    }
    if (exists(packageRoot, "extensions/extension-provenance.json")) {
      const provenance = JSON.parse(read(packageRoot, "extensions/extension-provenance.json"));
      if (provenance.automationEnabledDefault !== true) {
        errors.push("package extension provenance does not mark automationEnabledDefault: true");
      }
      if (provenance.artifactSource !== "automation-artifact") {
        errors.push("package extension provenance does not use automation-artifact source");
      }
    }
    if (!exists(packageRoot, "extensions/ptk-latest.zip")) {
      errors.push("package is missing canonical Chromium automation ZIP extensions/ptk-latest.zip");
    }
    if (!exists(packageRoot, "extensions/ptk-latest-firefox.zip")) {
      errors.push("package is missing canonical Firefox automation ZIP extensions/ptk-latest-firefox.zip");
    }
    if (!exists(packageRoot, "extensions/ptk-latest.crx")) {
      errors.push("package is missing canonical automation CRX extensions/ptk-latest.crx");
    }
    if (!exists(packageRoot, "extensions/ptk-latest.xpi")) {
      errors.push("package is missing canonical automation XPI extensions/ptk-latest.xpi");
    }
    if (!exists(packageRoot, "extensions/manifests/chromium-mv3.json")) {
      errors.push("package is missing Chromium MV3 manifest template");
    }
    if (!exists(packageRoot, "extensions/manifests/firefox-mv2.json")) {
      errors.push("package is missing Firefox MV2 manifest template");
    }
    if (!exists(packageRoot, "extensions/manifests/manifest.automation.chromium.json")) {
      errors.push("package is missing reviewed Chromium automation manifest template");
    }
    if (!exists(packageRoot, "extensions/manifests/manifest.automation.firefox.json")) {
      errors.push("package is missing reviewed Firefox automation manifest template");
    }
    if (exists(packageRoot, "agents/src/cli/index.cjs")) {
      const cli = read(packageRoot, "agents/src/cli/index.cjs");
      if (cli.includes("commands/benchmark.cjs") || /\bbenchmark\b/.test(cli)) {
        errors.push("package ptk-agent CLI still exposes source-only benchmark command");
      }
    }
    if (exists(packageRoot, "agents/package.json")) {
      const agentPackage = JSON.parse(read(packageRoot, "agents/package.json"));
      if (agentPackage.scripts || agentPackage.devDependencies || agentPackage.files) {
        errors.push("package agents/package.json contains source-only scripts, devDependencies, or files metadata");
      }
    }
  }

  return {
    ok: errors.length === 0,
    mode: "package",
    root: packageRoot,
    errors,
  };
}

function runPreflight(options) {
  const modes = options.mode === "both" ? ["source", "package"] : [options.mode];
  const results = modes.map((mode) => {
    if (mode === "source") return checkSource();
    if (mode === "package") return checkPackage(options.packageRoot);
    throw new Error("--mode must be source, package, or both");
  });
  return {
    ok: results.every((result) => result.ok),
    results,
    errors: results.flatMap((result) => result.errors.map((error) => `[${result.mode}] ${error}`)),
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(help());
      return 0;
    }
    const result = runPreflight(options);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  runPreflight,
};
