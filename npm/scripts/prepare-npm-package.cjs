#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractZipPayload, readZipFile, readZipManifest } = require('./unpack-crx.cjs');

const SDK_ROOT = path.resolve(__dirname, '..');
const SOURCE_PTK_ROOT = path.resolve(SDK_ROOT, '..');
const DEFAULT_INPUT_DIR = path.resolve(SOURCE_PTK_ROOT, 'dist');
const DEFAULT_OUT_DIR = path.resolve(SDK_ROOT, '.release', 'npm');
const NPM_DOCS_ROOT = path.resolve(SOURCE_PTK_ROOT, 'docs', 'npm');
const PACKAGE_NAME = 'pentestkit';
const AUTOMATION_ARTIFACT_SOURCE = 'automation-artifact';
const PTKLABS_AUTOMATION_ARTIFACT_SOURCE = 'ptklabs-automation-artifact';
const PTKLABS_AUTOMATION_SERVICE_WORKER = 'automation/background/automation-background-entry.js';
const AUTOMATION_CRX_FILE = 'ptk-latest-automation.crx';
const AUTOMATION_XPI_FILE = 'ptk-latest-automation.xpi';
const AUTOMATION_PROVENANCE_FILE = 'extension-provenance-automation.json';
const PACKAGE_ZIP_FILE = 'ptk-latest.zip';
const PACKAGE_FIREFOX_ZIP_FILE = 'ptk-latest-firefox.zip';
const PACKAGE_CRX_FILE = 'ptk-latest.crx';
const PACKAGE_XPI_FILE = 'ptk-latest.xpi';
const PACKAGE_PROVENANCE_FILE = 'extension-provenance.json';
const PACKAGE_CHROMIUM_MANIFEST_FILE = 'manifests/manifest.automation.chromium.json';
const PACKAGE_FIREFOX_MANIFEST_FILE = 'manifests/manifest.automation.firefox.json';
const PACKAGE_CHROMIUM_MANIFEST_COMPAT_FILE = 'manifests/chromium-mv3.json';
const PACKAGE_FIREFOX_MANIFEST_COMPAT_FILE = 'manifests/firefox-mv2.json';
const DEV_LOCAL_CONFIG_FILE = 'dev.local.json';
const NPM_PUBLIC_REPOSITORY_URL = 'https://github.com/ptklabs/ptk-agent';
const NPM_PUBLIC_DOCS_BASE_URL = `${NPM_PUBLIC_REPOSITORY_URL}/blob/main/docs/npm`;
const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set([
  'prepack',
  'prepare',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
  'install',
  'preinstall',
  'postinstall'
]);
const PACKAGE_FILE_ALLOWLIST = [
  'index.cjs',
  'index.mjs',
  'index.d.ts',
  'bin/',
  'agents/',
  'browser/',
  'frameworks/',
  'extensions/',
  'providers/',
  'docs/',
  'examples/',
  'README.md',
  'LICENSE'
];
const PUBLIC_DOC_EXAMPLE_ALLOWLIST = new Set([
  'extension-loading-matrix.md',
  'docs/npm/README.md',
  'docs/npm/authenticated-scans.md',
  'docs/npm/cli.md',
  'docs/npm/configuration.md',
  'docs/npm/extension-loading.md',
  'docs/npm/frameworks.md',
  'docs/npm/github-actions.md',
  'docs/npm/mcp-server.md',
  'docs/npm/provider-browser-matrix.md',
  'docs/npm/providers.md',
  'docs/npm/sarif.md',
  'docs/npm/scenarios.md',
  'docs/npm/troubleshooting.md',
  'examples/github-actions/local-app-dast/README.md',
  'examples/github-actions/local-app-dast/ptk-security-scan.yml',
  'examples/github-actions/playwright-ptk/README.md',
  'examples/github-actions/playwright-ptk/playwright-ptk-smoke.mjs',
  'examples/github-actions/playwright-ptk/ptk-playwright.yml',
  'examples/github-actions/sast-js/README.md',
  'examples/github-actions/sast-js/ptk-sast-js.yml',
  'agents/docs/agent-tools.schema.json',
  'agents/docs/config.schema.json',
  'agents/docs/crawl-data.schema.json',
  'agents/docs/engine-config.schema.json',
  'agents/docs/module-pack.schema.json',
  'agents/docs/ptk-findings-count.schema.json',
  'agents/docs/scenario.schema.json',
  'agents/docs/scenario_brokencrystals.md',
  'agents/docs/scenario_demo.testfire.net.md',
  'agents/docs/scenario_juice_shop.md',
  'agents/docs/site-memory.schema.json',
  'agents/docs/telemetry.schema.json',
  'agents/examples/github-action.yml',
  'agents/examples/ptk.config.json',
  'browser/README.md',
  'browser/index.cjs',
  'browser/index.mjs',
  'browser/index.d.ts',
  'browser/src/index.cjs',
  'browser/src/index.mjs',
  'browser/src/index.d.ts',
  'browser/src/preNavigation.cjs',
  'browser/src/ptkBridge.cjs',
  'browser/src/results.cjs',
  'browser/src/redact.cjs',
  'frameworks/cypress/README.md',
  'frameworks/cypress/examples/cypress.config.js',
  'frameworks/cypress/examples/juice-shop.cy.js',
  'frameworks/cypress/examples/support/e2e.js',
  'frameworks/playwright/README.md',
  'frameworks/playwright/index.cjs',
  'frameworks/playwright/index.mjs',
  'frameworks/playwright/index.d.ts',
  'frameworks/playwright/src/index.cjs',
  'frameworks/playwright/src/index.mjs',
  'frameworks/playwright/src/index.d.ts',
  'frameworks/playwright/examples/juice-shop-with-ptk.mjs',
  'frameworks/puppeteer/README.md',
  'frameworks/puppeteer/index.cjs',
  'frameworks/puppeteer/index.mjs',
  'frameworks/puppeteer/index.d.ts',
  'frameworks/puppeteer/src/index.cjs',
  'frameworks/puppeteer/src/index.mjs',
  'frameworks/puppeteer/src/index.d.ts',
  'frameworks/puppeteer/examples/juice-shop-with-ptk.cjs',
  'providers/README.md',
  'providers/_shared/examples/run-ptk-example.mjs',
  'providers/testmu/examples/README.md',
  'providers/testmu/examples/cypress-juice-shop/README.md',
  'providers/testmu/examples/cypress-juice-shop/package.json',
  'providers/testmu/examples/cypress-juice-shop/lambdatest-config.json',
  'providers/testmu/examples/cypress-juice-shop/cypress.config.js',
  'providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js',
  'providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js',
  'providers/testmu/examples/k6-browser-juice-shop.js',
  'providers/testmu/examples/playwright-juice-shop.mjs',
  'providers/testmu/examples/puppeteer-juice-shop.mjs',
  'providers/testmu/examples/selenium-juice-shop.mjs',
  'providers/browserstack/examples/README.md',
  'providers/browserstack/examples/playwright-juice-shop.mjs',
  'providers/browserstack/examples/puppeteer-juice-shop.mjs',
  'providers/browserstack/examples/selenium-juice-shop.mjs',
  'providers/browserbase/examples/README.md',
  'providers/browserbase/examples/playwright-juice-shop.mjs',
  'providers/browserbase/examples/puppeteer-juice-shop.mjs',
  'providers/browserbase/examples/selenium-juice-shop.mjs',
  'providers/browserless/examples/README.md',
  'providers/browserless/examples/playwright-juice-shop.mjs',
  'providers/browserless/examples/puppeteer-juice-shop.mjs',
  'providers/steel/examples/README.md',
  'providers/steel/examples/playwright-juice-shop.mjs',
  'providers/steel/examples/puppeteer-juice-shop.mjs',
  'providers/steel/examples/selenium-juice-shop.mjs',
  'providers/hyperbrowser/examples/README.md',
  'providers/hyperbrowser/examples/playwright-juice-shop.mjs',
  'providers/hyperbrowser/examples/puppeteer-juice-shop.mjs',
  'providers/hyperbrowser/examples/selenium-juice-shop.mjs',
  'frameworks/selenium/README.md',
  'frameworks/selenium/index.cjs',
  'frameworks/selenium/index.mjs',
  'frameworks/selenium/index.d.ts',
  'frameworks/selenium/src/index.cjs',
  'frameworks/selenium/src/index.mjs',
  'frameworks/selenium/src/index.d.ts',
  'frameworks/selenium/examples/juice-shop-selenium.cjs'
]);
const REDACTED_ALLOWLIST = new Set([
  'YOUR_USERNAME',
  'YOUR_PASSWORD',
  'PTK_EXTENSION_DIR',
  'PTK_EXTENSION_PATH',
  'PTK_JUICE_USERNAME',
  'PTK_JUICE_PASSWORD',
  'PTK_LOGIN_EMAIL',
  'PTK_LOGIN_PASSWORD',
  'PTK_PORTAL_PAT',
  'PTK_PORTAL_TOKEN',
  'ptk-automation-agent@ptklabs.com'
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    inputDir: DEFAULT_INPUT_DIR,
    outDir: DEFAULT_OUT_DIR,
    packageVersion: null,
    artifactSource: AUTOMATION_ARTIFACT_SOURCE,
    publishable: false,
    skipSmoke: false,
    inputDirExplicit: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input-dir') {
      options.inputDir = path.resolve(argv[++index]);
      options.inputDirExplicit = true;
    } else if (arg === '--out-dir') options.outDir = path.resolve(argv[++index]);
    else if (arg === '--package-version') options.packageVersion = argv[++index];
    else if (arg === '--artifact-source') options.artifactSource = argv[++index];
    else if (arg === '--publishable') options.publishable = true;
    else if (arg === '--skip-smoke') options.skipSmoke = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function help() {
  return [
    'Usage:',
    '  node scripts/prepare-npm-package.cjs [options]',
    '',
    'Options:',
    '  --input-dir <dir>                 Extension artifact dir. Default: ../dist',
    '  --out-dir <dir>                   Release output dir. Default: .release/npm',
    '  --package-version <semver>        Override non-semver extension version.',
    '  --artifact-source <name>          automation-artifact or ptklabs-automation-artifact. Default: automation-artifact',
    '  --publishable                     Generate staged private:false from automation artifacts.',
    '  --skip-smoke                      Skip tarball install smoke.'
  ].join('\n');
}

function assertSemver(version, label = 'version') {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    throw new Error(`${label} must be valid npm semver: ${version || '(empty)'}`);
  }
  return String(version);
}

function semverCore(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareSemverCore(a, b) {
  const left = semverCore(a);
  const right = semverCore(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function resolvePackageVersion(manifestVersion, override) {
  if (override) return assertSemver(override, '--package-version');
  return assertSemver(manifestVersion, 'manifest.version');
}

function resolvePackageVersionInfo(manifestVersion, override) {
  if (override) {
    const validManifestVersion = (() => {
      try {
        assertSemver(manifestVersion, 'manifest.version');
        return true;
      } catch (_) {
        return false;
      }
    })();
    return {
      packageVersion: assertSemver(override, '--package-version'),
      packageVersionSource: 'override',
      versionMappingReason: validManifestVersion
        ? 'operator override'
        : 'extension manifest version is not valid npm semver'
    };
  }
  return {
    packageVersion: assertSemver(manifestVersion, 'manifest.version'),
    packageVersionSource: 'extension-manifest',
    versionMappingReason: null
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkFiles(root) {
  const out = [];
  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  visit(root);
  return out;
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const filePath of walkFiles(root)) {
    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Cannot hash tree with symlink: ${relative}`);
    }
    const content = fs.readFileSync(filePath);
    bytes += content.length;
    const fileSha256 = crypto.createHash('sha256').update(content).digest('hex');
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    hash.update(relative);
    hash.update('\0');
    hash.update(mode);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(fileSha256);
    hash.update('\0');
  }
  return {
    sha256: hash.digest('hex'),
    bytes
  };
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode);
}

function rewriteNpmReadmeLinksForPackageRoot(markdown) {
  return String(markdown).replace(
    /\]\((?:docs\/npm\/)?(cli|configuration|extension-loading|authenticated-scans|scenarios|frameworks|github-actions|mcp-server|providers|provider-browser-matrix|sarif|troubleshooting)\.md(#[^)]+)?\)/g,
    (_match, doc, anchor = '') => `](${NPM_PUBLIC_DOCS_BASE_URL}/${doc}.md${anchor})`
  );
}

function findRelativeMarkdownLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)\s]+\.md(?:#[^)]+)?)\)/g;
  let match;
  while ((match = pattern.exec(String(markdown))) !== null) {
    links.push(match[1]);
  }
  return links;
}

function isRuntimeProfilesPath(normalized) {
  return normalized.startsWith('src/profiles/') || normalized.startsWith('agents/src/profiles/');
}

function shouldSkip(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => [
    'node_modules',
    '.venv',
    'venv',
    '.ptk',
    '.ptk-agent',
    '.release',
    '.release-input',
    '.private-docs',
    '__pycache__',
    '.git',
    '.gitignore',
    '.github',
    '.vscode',
    '.idea',
    '.cache',
    '.mypy_cache',
    '.pytest_cache',
    '.nyc_output',
    'build',
    'dist',
    'coverage',
    'smoke',
    'test',
    'tests',
    'artifacts',
    'scan-artifacts',
    'tmp'
  ].includes(part))) return true;
  if (parts.includes('profiles') && !isRuntimeProfilesPath(normalized)) return true;
  if (parts.some((part) => part.endsWith('.egg-info'))) return true;
  if (/\.log$/i.test(normalized)) return true;
  if (/\.pyc$/i.test(normalized)) return true;
  if (/\.(?:pem|key|p12|sqlite|sqlite3|har)$/i.test(normalized)) return true;
  if (/\.trace\.zip$/i.test(normalized)) return true;
  if (/agents\.zip$/i.test(normalized)) return true;
  if (/^AGENTS\.md$/i.test(normalized)) return true;
  if (/package-lock\.json$/i.test(normalized)) return true;
  return false;
}

function shouldSkipPublicDocOrExample(packageRelativePath) {
  const normalized = packageRelativePath.replace(/\\/g, '/');
  const isDocsPath = normalized.startsWith('docs/') || normalized.includes('/docs/');
  const isExamplesPath = normalized.startsWith('examples/') || normalized.includes('/examples/');
  if (!isDocsPath && !isExamplesPath && !normalized.endsWith('/README.md') && normalized !== 'extension-loading-matrix.md') {
    return false;
  }
  return !PUBLIC_DOC_EXAMPLE_ALLOWLIST.has(normalized);
}

function shouldSkipPackageOnlyInternalPath(packageRelativePath) {
  const normalized = packageRelativePath.replace(/\\/g, '/');
  const forbiddenExact = new Set([
    'agents/src/cli/commands/benchmark.cjs',
    'frameworks/cypress/package.json'
  ]);
  if (forbiddenExact.has(normalized)) return true;
  return [
    'agents/bin/',
    'agents/benchmarks/',
    'agents/src/benchmarks/'
  ].some((prefix) => normalized.startsWith(prefix));
}

function copyDir(source, destination, options = {}) {
  const root = path.resolve(source);
  for (const filePath of walkFiles(root)) {
    const relative = path.relative(root, filePath);
    if (shouldSkip(relative)) continue;
    const normalizedRelative = relative.replace(/\\/g, '/');
    const packageRelative = options.packagePrefix ? `${options.packagePrefix}/${normalizedRelative}` : normalizedRelative;
    if (shouldSkipPackageOnlyInternalPath(packageRelative)) continue;
    if (shouldSkipPublicDocOrExample(packageRelative)) continue;
    if (options.include && !options.include(normalizedRelative)) continue;
    copyFile(filePath, path.join(destination, relative));
  }
}

function stripSourceOnlyAgentCommands(stageRoot) {
  const cliIndexPath = path.join(stageRoot, 'agents', 'src', 'cli', 'index.cjs');
  if (!fs.existsSync(cliIndexPath)) return;
  let text = fs.readFileSync(cliIndexPath, 'utf8');
  text = text
    .replace("const benchmark = require('./commands/benchmark.cjs');\n", '')
    .replace(",\n  benchmark\n};", '\n};')
    .replace("    '  benchmark         Run scanner benchmark matrix.',\n", '');
  if (/commands\s*=\s*\{[\s\S]*\bbenchmark\b[\s\S]*\}/.test(text) || text.includes("commands/benchmark.cjs")) {
    throw new Error('Failed to strip source-only benchmark command from packaged ptk-agent CLI');
  }
  fs.writeFileSync(cliIndexPath, text, 'utf8');
}

function prunePublishedPackageSurface(stageRoot, options = {}) {
  for (const relative of [
    'agents/bin',
    'agents/benchmarks',
    'agents/src/benchmarks',
    'agents/src/cli/commands/benchmark.cjs',
    'agents/.gitignore',
    'frameworks/cypress/package.json'
  ]) {
    fs.rmSync(path.join(stageRoot, relative), { recursive: true, force: true });
  }
  stripSourceOnlyAgentCommands(stageRoot);
}

function createWrappers(stageRoot) {
  const frameworkPath = (folder, ...parts) => path.join(stageRoot, 'frameworks', folder, ...parts);
  fs.writeFileSync(path.join(stageRoot, 'index.cjs'), [
    "'use strict';",
    "module.exports = {",
    "  agents: require('./agents/index.cjs'),",
    "  browser: require('./browser/index.cjs'),",
    "  cypress: require('./frameworks/cypress/index.cjs'),",
    "  playwright: require('./frameworks/playwright/index.cjs'),",
    "  puppeteer: require('./frameworks/puppeteer/index.cjs'),",
    "  selenium: require('./frameworks/selenium/index.cjs'),",
    "  extensionProvenance: require('./extensions/extension-provenance.json')",
    "};",
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(stageRoot, 'index.mjs'), [
    "import cjs from './index.cjs';",
    '',
    'export const agents = cjs.agents;',
    'export const browser = cjs.browser;',
    'export const cypress = cjs.cypress;',
    'export const playwright = cjs.playwright;',
    'export const puppeteer = cjs.puppeteer;',
    'export const selenium = cjs.selenium;',
    'export const extensionProvenance = cjs.extensionProvenance;',
    'export default cjs;',
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(stageRoot, 'index.d.ts'), [
    "export * as browser from './browser';",
    "export * as playwright from './frameworks/playwright';",
    "export * as puppeteer from './frameworks/puppeteer';",
    "export * as selenium from './frameworks/selenium';",
    'export const agents: unknown;',
    'export const cypress: unknown;',
    'export const extensionProvenance: unknown;',
    'declare const api: {',
    '  agents: unknown;',
    '  browser: typeof browser;',
    '  cypress: unknown;',
    '  playwright: typeof playwright;',
    '  puppeteer: typeof puppeteer;',
    '  selenium: typeof selenium;',
    '  extensionProvenance: unknown;',
    '};',
    'export default api;',
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(stageRoot, 'agents', 'index.cjs'), [
    "'use strict';",
    "module.exports = {",
    "  cli: require('./src/cli/index.cjs'),",
    "  agent: require('./src/agent/index.cjs')",
    "};",
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(frameworkPath('cypress', 'index.cjs'), [
    "'use strict';",
    "module.exports = require('./src/index.js');",
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(stageRoot, 'browser', 'index.cjs'), [
    "'use strict';",
    "module.exports = require('./src/index.cjs');",
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(stageRoot, 'browser', 'index.mjs'), [
    "import cjs from './index.cjs';",
    '',
    'export const PTKBridge = cjs.PTKBridge;',
    'export const PtkBridgeError = cjs.PtkBridgeError;',
    'export const PtkScanError = cjs.PtkScanError;',
    'export const createPtkBridge = cjs.createPtkBridge;',
    'export const waitForPtk = cjs.waitForPtk;',
    'export const bootstrapPtkPage = cjs.bootstrapPtkPage;',
    'export const armPtkIastForNavigation = cjs.armPtkIastForNavigation;',
    'export const withPtkScan = cjs.withPtkScan;',
    'export const collectPtkResults = cjs.collectPtkResults;',
    'export const applyAutomationScanDefaults = cjs.applyAutomationScanDefaults;',
    'export const writePtkResults = cjs.writePtkResults;',
    'export const resolveArtifactMode = cjs.resolveArtifactMode;',
    'export const countFindings = cjs.countFindings;',
    'export default cjs;',
    ''
  ].join('\n'), 'utf8');

  const declarationSource = path.join(stageRoot, 'browser', 'src', 'index.d.ts');
  if (fs.existsSync(declarationSource)) {
    copyFile(declarationSource, path.join(stageRoot, 'browser', 'index.d.ts'));
  }

  for (const folder of ['playwright', 'selenium']) {
    fs.writeFileSync(frameworkPath(folder, 'index.cjs'), [
      "'use strict';",
      "module.exports = require('./src/index.cjs');",
      ''
    ].join('\n'), 'utf8');

    fs.writeFileSync(frameworkPath(folder, 'index.mjs'), [
      "import cjs from './index.cjs';",
      '',
      'export const PTKBridge = cjs.PTKBridge;',
      'export const PtkBridgeError = cjs.PtkBridgeError;',
      'export const PtkScanError = cjs.PtkScanError;',
      'export const createPtkBridge = cjs.createPtkBridge;',
      'export const waitForPtk = cjs.waitForPtk;',
      'export const bootstrapPtkPage = cjs.bootstrapPtkPage;',
      'export const armPtkIastForNavigation = cjs.armPtkIastForNavigation;',
      'export const withPtkScan = cjs.withPtkScan;',
      'export const collectPtkResults = cjs.collectPtkResults;',
      'export const applyAutomationScanDefaults = cjs.applyAutomationScanDefaults;',
      'export const writePtkResults = cjs.writePtkResults;',
      'export const resolveArtifactMode = cjs.resolveArtifactMode;',
      'export const countFindings = cjs.countFindings;',
      folder === 'selenium' ? 'export const createSeleniumPtkBridge = cjs.createSeleniumPtkBridge;' : null,
      folder === 'selenium' ? 'export const discoverSeleniumExtensionOrigin = cjs.discoverSeleniumExtensionOrigin;' : null,
      'export default cjs;',
      ''
    ].filter(Boolean).join('\n'), 'utf8');

    if (folder === 'playwright') {
      fs.writeFileSync(frameworkPath(folder, 'index.d.ts'), [
        "export * from '../../browser';",
        "export { default } from '../../browser';",
        ''
      ].join('\n'), 'utf8');
    } else if (folder === 'selenium') {
      fs.writeFileSync(frameworkPath(folder, 'index.d.ts'), [
        "import type { PtkBridge, PtkPageLike, PtkScanOptions, PtkScanResult, PtkScanSuccess } from '../../browser';",
        "export * from '../../browser';",
        'export interface PtkSeleniumDriverLike {',
        '  get(url: string): Promise<void> | void;',
        '  executeScript<T = unknown>(script: string | Function, ...args: unknown[]): Promise<T> | T;',
        '  executeAsyncScript<T = unknown>(script: string | Function, ...args: unknown[]): Promise<T>;',
        '  sleep?(ms: number): Promise<void>;',
        '  switchTo?(): { frame?(frame: unknown): Promise<void> | void; defaultContent?(): Promise<void> | void };',
        '  manage?(): { setTimeouts?(timeouts: { script?: number }): Promise<void> | void };',
        '}',
        'export function createSeleniumPageLike(driver: PtkSeleniumDriverLike, options?: object): PtkPageLike;',
        'export function createSeleniumPtkBridge(driver: PtkSeleniumDriverLike, options?: object): PtkBridge;',
        'export function discoverSeleniumExtensionOrigin(driver: PtkSeleniumDriverLike, options?: object): Promise<string | null>;',
        'export function armPtkIastForNavigation(driver: PtkSeleniumDriverLike, options?: object): Promise<unknown>;',
        'export function waitForPtk(driver: PtkSeleniumDriverLike, options?: object): Promise<unknown>;',
        'export function collectPtkResults(driverOrBridge: PtkSeleniumDriverLike | PtkBridge, session?: unknown, options?: object): Promise<unknown>;',
        'export function withPtkScan<T>(',
        '  driver: PtkSeleniumDriverLike,',
        '  options: PtkScanOptions & { throwOnError: false },',
        '  runJourney: (ctx: { driver: PtkSeleniumDriverLike; ptk: PtkBridge; session: unknown }) => Promise<T>',
        '): Promise<PtkScanResult<T>>;',
        'export function withPtkScan<T>(',
        '  driver: PtkSeleniumDriverLike,',
        '  options: PtkScanOptions,',
        '  runJourney: (ctx: { driver: PtkSeleniumDriverLike; ptk: PtkBridge; session: unknown }) => Promise<T>',
        '): Promise<PtkScanSuccess<T>>;',
        'declare const api: unknown;',
        'export default api;',
        ''
      ].join('\n'), 'utf8');
    }
  }

  fs.writeFileSync(frameworkPath('puppeteer', 'index.cjs'), [
    "'use strict';",
    "module.exports = require('./src/index.cjs');",
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(frameworkPath('puppeteer', 'index.mjs'), [
    "import cjs from './index.cjs';",
    '',
    'export const PTKPuppeteerBridge = cjs.PTKPuppeteerBridge;',
    'export const launchPtkBrowser = cjs.launchPtkBrowser;',
    'export const resolvePuppeteer = cjs.resolvePuppeteer;',
    'export const resolveExtensionPath = cjs.resolveExtensionPath;',
    'export const buildLaunchArgs = cjs.buildLaunchArgs;',
    'export const createPtkBridge = cjs.createPtkBridge;',
    'export const waitForPtk = cjs.waitForPtk;',
    'export const bootstrapPtkPage = cjs.bootstrapPtkPage;',
    'export const armPtkIastForNavigation = cjs.armPtkIastForNavigation;',
    'export const withPtkScan = cjs.withPtkScan;',
    'export const collectPtkResults = cjs.collectPtkResults;',
    'export const applyAutomationScanDefaults = cjs.applyAutomationScanDefaults;',
    'export const writePtkResults = cjs.writePtkResults;',
    'export const resolveArtifactMode = cjs.resolveArtifactMode;',
    'export const countFindings = cjs.countFindings;',
    'export default cjs;',
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(frameworkPath('puppeteer', 'index.d.ts'), [
    "import type { PtkPageLike } from '../../browser';",
    "export * from '../../browser';",
    'export interface LaunchPtkBrowserOptions {',
    '  puppeteer?: unknown;',
    '  puppeteerPackage?: string;',
    '  extensionPath?: string;',
    '  profileDir?: string;',
    '  executablePath?: string;',
    '  headless?: boolean;',
    '  allowHeadlessExtension?: boolean;',
    '  launchOptions?: object;',
    '  args?: string[];',
    '  page?: unknown;',
    '  [key: string]: unknown;',
    '}',
    'export class PTKPuppeteerBridge {',
    '  constructor(page: PtkPageLike);',
    '  sessionId?: string | null;',
    '  ping(): Promise<unknown>;',
    '  waitReady(timeoutMs?: number, options?: object): Promise<unknown>;',
    '  requestActivation(options?: object): Promise<unknown>;',
    '  startSession(options?: object): Promise<unknown>;',
    '  endSession(options?: object): Promise<unknown>;',
    '  getStats(): Promise<unknown>;',
    '  getFindings(options?: object | number): Promise<unknown>;',
    '  getSessionProgress(options?: object): Promise<unknown>;',
    '  exportScan(options?: object): Promise<unknown>;',
    '}',
    'export function launchPtkBrowser(options?: LaunchPtkBrowserOptions): Promise<{ browser: unknown; page: PtkPageLike; ptk: PTKPuppeteerBridge; extensionPath: string; profileDir: string; launchOptions: object }>; ',
    'export function resolvePuppeteer(options?: object): unknown;',
    'export function resolveExtensionPath(options?: object): string | null;',
    'export function buildLaunchArgs(extensionPath: string, extraArgs?: string[]): string[];',
    "export { bootstrapPtkPage } from '../../browser';",
    'declare const api: unknown;',
    'export default api;',
    ''
  ].join('\n'), 'utf8');
}

function writeRootBin(stageRoot, name, lines) {
  const target = path.join(stageRoot, 'bin', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  fs.chmodSync(target, 0o755);
}

function createRootBinWrappers(stageRoot) {
  writeRootBin(stageRoot, 'ptk-scan', [
    '#!/usr/bin/env node',
    "'use strict';",
    '',
    "const { UsageError } = require('../agents/src/cli/args.cjs');",
    "const { writeLine } = require('../agents/src/cli/status.cjs');",
    "const { run } = require('../agents/src/cli/compat/ptkScan.cjs');",
    '',
    'run(process.argv.slice(2), {',
    "  cliName: 'ptk-scan',",
    '  cwd: process.cwd(),',
    '  io: { stdout: process.stdout, stderr: process.stderr }',
    '}).then((exitCode) => {',
    '  process.exitCode = exitCode;',
    '}).catch((error) => {',
    "  const label = error instanceof UsageError ? 'Usage error' : 'Command failed';",
    '  writeLine(process.stderr, `${label}: ${error.message}`);',
    '  if (process.env.PTK_AGENT_DEBUG && !(error instanceof UsageError)) {',
    '    writeLine(process.stderr, error.stack || String(error));',
    '  }',
    '  process.exitCode = error.exitCode || 70;',
    '});'
  ]);

  writeRootBin(stageRoot, 'ptk-agent', [
    '#!/usr/bin/env node',
    "'use strict';",
    '',
    "require('../agents/src/cli/index.cjs').main()",
    '  .then((exitCode) => {',
    '    process.exitCode = exitCode;',
    '  })',
    '  .catch((error) => {',
    "    const { UsageError } = require('../agents/src/cli/args.cjs');",
    "    const { writeLine } = require('../agents/src/cli/status.cjs');",
    "    const label = error instanceof UsageError ? 'Usage error' : 'Command failed';",
    '    writeLine(process.stderr, `${label}: ${error.message}`);',
    '    process.exitCode = error.exitCode || 70;',
    '  });'
  ]);

  writeRootBin(stageRoot, 'ptk-agent-mcp-server', [
    '#!/usr/bin/env node',
    "'use strict';",
    '',
    "const { UsageError } = require('../agents/src/cli/args.cjs');",
    "const { writeLine } = require('../agents/src/cli/status.cjs');",
    "const { run } = require('../agents/src/agent/mcpServer.cjs');",
    '',
    'run(process.argv.slice(2), {',
    "  cliName: 'ptk-agent-mcp-server',",
    '  cwd: process.cwd(),',
    '  io: { stdout: process.stdout, stderr: process.stderr }',
    '}).then((exitCode) => {',
    '  process.exitCode = exitCode;',
    '}).catch((error) => {',
    "  const label = error instanceof UsageError ? 'Usage error' : 'Command failed';",
    '  writeLine(process.stderr, `${label}: ${error.message}`);',
    '  process.exitCode = error.exitCode || 70;',
    '});'
  ]);
}

function stageSdkFolders(stageRoot) {
  const npmReadmePath = path.join(NPM_DOCS_ROOT, 'README.md');
  if (!fs.existsSync(npmReadmePath)) {
    throw new Error(`NPM package README not found: ${npmReadmePath}`);
  }
  fs.writeFileSync(
    path.join(stageRoot, 'README.md'),
    rewriteNpmReadmeLinksForPackageRoot(fs.readFileSync(npmReadmePath, 'utf8')),
    'utf8'
  );
  const licensePath = path.resolve(SOURCE_PTK_ROOT, 'LICENSE.txt');
  if (fs.existsSync(licensePath)) copyFile(licensePath, path.join(stageRoot, 'LICENSE'));
  fs.mkdirSync(path.join(stageRoot, 'docs'), { recursive: true });
  copyFile(path.join(SDK_ROOT, 'extension-loading-matrix.md'), path.join(stageRoot, 'docs', 'extension-loading-matrix.md'));
  copyDir(NPM_DOCS_ROOT, path.join(stageRoot, 'docs', 'npm'), {
    packagePrefix: 'docs/npm'
  });

  for (const folder of ['agents', 'browser']) {
    copyDir(path.join(SDK_ROOT, folder), path.join(stageRoot, folder), {
      packagePrefix: folder
    });
  }
  copyDir(path.join(SDK_ROOT, 'frameworks'), path.join(stageRoot, 'frameworks'), {
    packagePrefix: 'frameworks'
  });

  copyDir(path.join(SDK_ROOT, 'extensions'), path.join(stageRoot, 'extensions'), {
    packagePrefix: 'extensions'
  });

  copyDir(path.join(SDK_ROOT, 'providers'), path.join(stageRoot, 'providers'), {
    packagePrefix: 'providers'
  });

  const examplesRoot = path.join(SDK_ROOT, 'examples');
  if (fs.existsSync(examplesRoot)) {
    copyDir(examplesRoot, path.join(stageRoot, 'examples'), {
      packagePrefix: 'examples'
    });
  }

  fs.mkdirSync(path.join(stageRoot, 'bin'), { recursive: true });
  createRootBinWrappers(stageRoot);
  createWrappers(stageRoot);
}

function writePackageJson(stageRoot, version, options = {}) {
  const exportsMap = {
    '.': {
      types: './index.d.ts',
      import: './index.mjs',
      require: './index.cjs',
      default: './index.cjs'
    },
    './package.json': './package.json',
    './agents': {
      require: './agents/index.cjs',
      default: './agents/index.cjs'
    },
    './browser': {
      types: './browser/index.d.ts',
      import: './browser/index.mjs',
      require: './browser/index.cjs',
      default: './browser/index.cjs'
    },
    './cypress': {
      require: './frameworks/cypress/index.cjs',
      default: './frameworks/cypress/index.cjs'
    },
    './playwright': {
      types: './frameworks/playwright/index.d.ts',
      import: './frameworks/playwright/index.mjs',
      require: './frameworks/playwright/index.cjs',
      default: './frameworks/playwright/index.cjs'
    },
    './puppeteer': {
      types: './frameworks/puppeteer/index.d.ts',
      import: './frameworks/puppeteer/index.mjs',
      require: './frameworks/puppeteer/index.cjs',
      default: './frameworks/puppeteer/index.cjs'
    },
    './selenium': {
      types: './frameworks/selenium/index.d.ts',
      import: './frameworks/selenium/index.mjs',
      require: './frameworks/selenium/index.cjs',
      default: './frameworks/selenium/index.cjs'
    },
    './extensions': {
      types: './extensions/index.d.ts',
      import: './extensions/index.mjs',
      require: './extensions/index.cjs',
      default: './extensions/index.cjs'
    },
    './extensions/provenance': './extensions/extension-provenance.json'
  };
  Object.assign(exportsMap, {
    './providers/testmu': {
      types: './providers/testmu/index.d.ts',
      import: './providers/testmu/index.mjs',
      require: './providers/testmu/index.cjs',
      default: './providers/testmu/index.cjs'
    },
    './providers/browserstack': {
      types: './providers/browserstack/index.d.ts',
      import: './providers/browserstack/index.mjs',
      require: './providers/browserstack/index.cjs',
      default: './providers/browserstack/index.cjs'
    },
    './providers/browserbase': {
      types: './providers/browserbase/index.d.ts',
      import: './providers/browserbase/index.mjs',
      require: './providers/browserbase/index.cjs',
      default: './providers/browserbase/index.cjs'
    },
    './providers/browserless': {
      types: './providers/browserless/index.d.ts',
      import: './providers/browserless/index.mjs',
      require: './providers/browserless/index.cjs',
      default: './providers/browserless/index.cjs'
    },
    './providers/steel': {
      types: './providers/steel/index.d.ts',
      import: './providers/steel/index.mjs',
      require: './providers/steel/index.cjs',
      default: './providers/steel/index.cjs'
    },
    './providers/hyperbrowser': {
      types: './providers/hyperbrowser/index.d.ts',
      import: './providers/hyperbrowser/index.mjs',
      require: './providers/hyperbrowser/index.cjs',
      default: './providers/hyperbrowser/index.cjs'
    }
  });
  const peerDependencies = {
    cypress: '>=12.0.0',
    puppeteer: '>=22.0.0'
  };
  const peerDependenciesMeta = {
    cypress: {
      optional: true
    },
    puppeteer: {
      optional: true
    }
  };
  peerDependencies['@testmuai/testmu-cloud'] = '>=1.0.1 <2.0.0';
  peerDependencies['@testmuai/browser-cloud'] = '>=1.0.0 <2.0.0';
  peerDependencies['steel-sdk'] = '>=0.18.0 <1.0.0';
  peerDependencies['@hyperbrowser/sdk'] = '>=0.91.0 <1.0.0';
  peerDependenciesMeta['@testmuai/testmu-cloud'] = {
    optional: true
  };
  peerDependenciesMeta['@testmuai/browser-cloud'] = {
    optional: true
  };
  peerDependenciesMeta['steel-sdk'] = {
    optional: true
  };
  peerDependenciesMeta['@hyperbrowser/sdk'] = {
    optional: true
  };
  const packageJson = {
    name: PACKAGE_NAME,
    version,
    description: 'PTK SDKs and PTK-backed scan CLI for browser security automation.',
    type: 'commonjs',
    private: options.publishable ? false : true,
    main: 'index.cjs',
    module: 'index.mjs',
    types: 'index.d.ts',
    exports: exportsMap,
    bin: {
      'ptk-scan': 'bin/ptk-scan',
      'ptk-agent': 'bin/ptk-agent',
      'ptk-agent-mcp-server': 'bin/ptk-agent-mcp-server'
    },
    files: PACKAGE_FILE_ALLOWLIST,
    dependencies: {
      playwright: '^1.58.1',
      'puppeteer-core': '24.10.0',
      'selenium-webdriver': '4.26.0'
    },
    peerDependencies,
    peerDependenciesMeta,
    engines: {
      node: '>=18'
    },
    license: 'AGPL-3.0-only',
    author: {
      name: 'Denis Podgurskii'
    },
    contributors: [
      {
        name: 'PTK Labs',
        url: 'https://github.com/ptklabs'
      }
    ],
    repository: {
      type: 'git',
      url: `git+${NPM_PUBLIC_REPOSITORY_URL}.git`,
      directory: 'npm'
    },
    homepage: `${NPM_PUBLIC_REPOSITORY_URL}#readme`,
    bugs: {
      url: `${NPM_PUBLIC_REPOSITORY_URL}/issues`
    },
    publishConfig: {
      access: 'public',
      provenance: true
    }
  };
  writeJson(path.join(stageRoot, 'package.json'), packageJson);
}

function syncNestedPackageMetadata(stageRoot, version) {
  const agentPackagePath = path.join(stageRoot, 'agents', 'package.json');
  if (fs.existsSync(path.dirname(agentPackagePath))) {
    writeJson(agentPackagePath, {
      name: '@pentestkit/agents',
      version,
      description: 'PTK Agent runtime bundled inside the pentestkit package.',
      type: 'commonjs',
      private: true
    });
  }
  fs.rmSync(path.join(stageRoot, 'frameworks', 'cypress', 'package.json'), { force: true });
}

function writeProvenance(stageRoot, inputDir, chromiumManifest, firefoxManifest, version, options = {}) {
  const extensionsDir = path.join(stageRoot, 'extensions');
  const zipPath = path.join(extensionsDir, PACKAGE_ZIP_FILE);
  const firefoxZipPath = path.join(extensionsDir, PACKAGE_FIREFOX_ZIP_FILE);
  const crxPath = path.join(extensionsDir, PACKAGE_CRX_FILE);
  const xpiPath = path.join(extensionsDir, PACKAGE_XPI_FILE);
  const chromiumManifestPath = path.join(extensionsDir, PACKAGE_CHROMIUM_MANIFEST_FILE);
  const firefoxManifestPath = path.join(extensionsDir, PACKAGE_FIREFOX_MANIFEST_FILE);
  const zipManifestBytes = readZipFile(zipPath, 'manifest.json');
  const inputDirRelative = path.relative(SDK_ROOT, inputDir).replace(/\\/g, '/') || '.';
  const sourceChromeZip = options.sourceChromeZipName || null;
  const sourceFirefoxZip = options.sourceFirefoxZipName || null;
  const sourceProvenance = options.sourceProvenanceName || AUTOMATION_PROVENANCE_FILE;
  const provenance = {
    schemaVersion: 'ptk-extension-provenance-v1',
    packageName: PACKAGE_NAME,
    packageVersion: version,
    packageVersionSource: options.packageVersionSource || 'extension-manifest',
    versionMappingReason: options.versionMappingReason || null,
    extensionVersion: chromiumManifest.version || null,
    manifestVersion: chromiumManifest.manifest_version || null,
    automationEnabledDefault: true,
    automationArtifactProvenance: options.inputProvenance || null,
    createdAt: new Date().toISOString(),
    artifactSource: options.artifactSource || AUTOMATION_ARTIFACT_SOURCE,
    inputDir: inputDirRelative,
    npm: {
      packageName: PACKAGE_NAME,
      packageVersion: version,
      publishable: Boolean(options.publishable),
      private: !options.publishable
    },
    source: {
      artifactSource: options.artifactSource || AUTOMATION_ARTIFACT_SOURCE,
      inputDir: inputDirRelative,
      chromeZip: sourceChromeZip,
      crx: options.sourceCrxName || null,
      firefoxZip: sourceFirefoxZip,
      xpi: options.sourceXpiName || null,
      provenance: sourceProvenance
    },
    manifests: {
      chromium: {
        version: chromiumManifest.version || null,
        manifestVersion: chromiumManifest.manifest_version || null,
        sha256: sha256File(chromiumManifestPath)
      },
      firefox: {
        version: firefoxManifest.version || null,
        manifestVersion: firefoxManifest.manifest_version || null,
        sha256: sha256File(firefoxManifestPath),
        browserSpecificSettings: firefoxManifest.browser_specific_settings || firefoxManifest.applications || null
      }
    },
    hashes: {
      zipSha256: sha256File(zipPath),
      firefoxZipSha256: fs.existsSync(firefoxZipPath) ? sha256File(firefoxZipPath) : null,
      crxSha256: fs.existsSync(crxPath) ? sha256File(crxPath) : null,
      xpiSha256: fs.existsSync(xpiPath) ? sha256File(xpiPath) : null,
      chromiumManifestSha256: sha256File(chromiumManifestPath),
      firefoxManifestSha256: sha256File(firefoxManifestPath),
      chromiumZipManifestSha256: crypto.createHash('sha256').update(zipManifestBytes || Buffer.alloc(0)).digest('hex'),
    },
    sizes: {
      zipBytes: fs.statSync(zipPath).size,
      firefoxZipBytes: fs.existsSync(firefoxZipPath) ? fs.statSync(firefoxZipPath).size : null,
      crxBytes: fs.existsSync(crxPath) ? fs.statSync(crxPath).size : null,
      xpiBytes: fs.existsSync(xpiPath) ? fs.statSync(xpiPath).size : null,
      chromiumManifestBytes: fs.statSync(chromiumManifestPath).size,
      firefoxManifestBytes: fs.statSync(firefoxManifestPath).size,
      chromiumZipManifestBytes: zipManifestBytes ? zipManifestBytes.length : 0,
    },
    paths: {
      zip: `extensions/${PACKAGE_ZIP_FILE}`,
      firefoxZip: fs.existsSync(firefoxZipPath) ? `extensions/${PACKAGE_FIREFOX_ZIP_FILE}` : null,
      crx: fs.existsSync(crxPath) ? `extensions/${PACKAGE_CRX_FILE}` : null,
      xpi: fs.existsSync(xpiPath) ? `extensions/${PACKAGE_XPI_FILE}` : null,
      chromiumManifest: `extensions/${PACKAGE_CHROMIUM_MANIFEST_FILE}`,
      firefoxManifest: `extensions/${PACKAGE_FIREFOX_MANIFEST_FILE}`,
      provenance: `extensions/${PACKAGE_PROVENANCE_FILE}`
    },
    extensionId: null
  };
  writeJson(path.join(extensionsDir, PACKAGE_PROVENANCE_FILE), provenance);
  return provenance;
}

function containsForbiddenPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/(^|\/)dev\.local\.json$/i.test(normalized)) return true;
  if (/^(?:cypress|playwright|puppeteer|selenium)(?:\/|$)/.test(normalized)) return true;
  if ([
    'agents/bin',
    'agents/src/cli/commands/benchmark.cjs',
    'frameworks/cypress/package.json'
  ].includes(normalized)) return true;
  if (normalized.startsWith('agents/bin/')) return true;
  if (normalized.startsWith('agents/benchmarks/') || normalized === 'agents/benchmarks') return true;
  if (normalized.startsWith('agents/src/benchmarks/') || normalized === 'agents/src/benchmarks') return true;
  const parts = normalized.split('/');
  const forbiddenParts = new Set([
    'node_modules',
    '.venv',
    'venv',
    '.ptk',
    '.ptk-agent',
    '.release-input',
    '.private-docs',
    'agents_v1',
    '.git',
    '.gitignore',
    '.github',
    '.npmrc',
    '.vscode',
    '.idea',
    '.cache',
    '.mypy_cache',
    '.pytest_cache',
    '.nyc_output',
    'scan-artifacts',
    'artifacts',
    'cookies',
    'storageState',
    'tmp',
    '__pycache__',
    'playwright-report',
    'test-results',
    'downloads',
    'videos',
    'screenshots'
  ]);
  if (parts.some((part) => forbiddenParts.has(part))) return true;
  if (parts.includes('profiles') && !isRuntimeProfilesPath(normalized)) return true;
  if (/\.log$/i.test(normalized)) return true;
  if (/\.(?:pem|key|p12|sqlite|sqlite3|har)$/i.test(normalized)) return true;
  if (/\.trace\.zip$/i.test(normalized)) return true;
  if (/\.env$/i.test(normalized) || normalized.includes('/.env')) return true;
  if (/\.egg-info(?:\/|$)/i.test(normalized)) return true;
  if (/implementation-plan\.md$/i.test(normalized)) return true;
  if (/milestone-reports\//i.test(normalized)) return true;
  if (/docs\/.*(?:overnight|blocker|followup|hardening|capability-plan|publish-checklist)/i.test(normalized)) return true;
  return false;
}

function scanTextForSecrets(filePath, relativePath) {
  if (!/\.(?:cjs|js|json|md|py|toml|yml|yaml|txt|sh)$/i.test(relativePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const errors = [];
  const suspicious = [
    /\bP@ssword\b/g,
    /\bptk@test\.com\b/gi,
    /\b(?:password|token|secret|cookie|authorization)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  ];
  for (const pattern of suspicious) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if ([...REDACTED_ALLOWLIST].some((allowed) => value.includes(allowed))) continue;
      if (/pentestkit@DenisPodgurskii/i.test(value)) continue;
      if (/@example\./i.test(value) || /\.example\b/i.test(value)) continue;
      if (/YOUR_[A-Z_]+/.test(value)) continue;
      if (/\[redacted\]/i.test(value)) continue;
      errors.push(`${relativePath}: suspicious value "${value.slice(0, 80)}"`);
    }
  }
  return errors;
}

function verifyStagedPackage(stageRoot) {
  const errors = [];
  const rootReadmePath = path.join(stageRoot, 'README.md');
  if (fs.existsSync(rootReadmePath)) {
    const relativeMarkdownLinks = findRelativeMarkdownLinks(fs.readFileSync(rootReadmePath, 'utf8'));
    for (const link of relativeMarkdownLinks) {
      errors.push(`README.md has npmjs-broken relative markdown link: ${link}`);
    }
  }
  for (const filePath of walkFiles(stageRoot)) {
    const relative = path.relative(stageRoot, filePath).replace(/\\/g, '/');
    if (containsForbiddenPath(relative)) {
      errors.push(`Forbidden file in staged package: ${relative}`);
      continue;
    }
    if (relative.endsWith('.md')) {
      const markdown = fs.readFileSync(filePath, 'utf8');
      for (const link of findRelativeMarkdownLinks(markdown)) {
        const target = decodeURIComponent(link.split('#')[0]);
        const resolvedTarget = path.resolve(path.dirname(filePath), target);
        const insideStage = resolvedTarget === stageRoot || resolvedTarget.startsWith(`${stageRoot}${path.sep}`);
        if (!insideStage || !fs.existsSync(resolvedTarget)) {
          errors.push(`${relative} has broken staged-package markdown link: ${link}`);
        }
      }
    }
    errors.push(...scanTextForSecrets(filePath, relative));
  }
  if (errors.length) {
    throw new Error(`Staged package verification failed:\n${errors.map((line) => `- ${line}`).join('\n')}`);
  }
}

function verifyPackageJson(stageRoot) {
  const packageJson = readJson(path.join(stageRoot, 'package.json'));
  const scripts = packageJson.scripts || {};
  const forbiddenScripts = Object.keys(scripts).filter((name) => FORBIDDEN_LIFECYCLE_SCRIPTS.has(name));
  if (forbiddenScripts.length) {
    throw new Error(`Generated package.json contains forbidden lifecycle scripts: ${forbiddenScripts.join(', ')}`);
  }
  for (const [name, relativePath] of Object.entries(packageJson.bin || {})) {
    const binPath = path.join(stageRoot, relativePath);
    if (!fs.existsSync(binPath)) throw new Error(`Missing bin target for ${name}: ${relativePath}`);
    const content = fs.readFileSync(binPath, 'utf8');
    if (!content.startsWith('#!')) throw new Error(`Bin target ${name} is missing a shebang: ${relativePath}`);
    const mode = fs.statSync(binPath).mode;
    if ((mode & 0o111) === 0) throw new Error(`Bin target ${name} is not executable: ${relativePath}`);
  }
}

function isAllowedPackedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^package\//, '');
  return PACKAGE_FILE_ALLOWLIST.some((allowed) => {
    if (allowed.endsWith('/')) return normalized.startsWith(allowed);
    return normalized === allowed;
  }) || normalized === 'package.json';
}

function packedFilePaths(packResult) {
  return (Array.isArray(packResult.files) ? packResult.files : [])
    .map((file) => (file.path || file).replace(/\\/g, '/').replace(/^package\//, ''))
    .sort();
}

function parseNpmPackJson(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    throw new Error(`npm pack did not return parseable JSON: ${error.message}\n${stdout}`);
  }
}

function verifyPackFileList(packResult) {
  const unexpected = packedFilePaths(packResult)
    .filter((filePath) => !isAllowedPackedPath(filePath));
  if (unexpected.length) {
    throw new Error(`npm pack would include files outside allowlist:\n${unexpected.map((filePath) => `- ${filePath}`).join('\n')}`);
  }
}

function verifyPackFileListsMatch(dryRunPackResult, actualPackResult) {
  const dryRunFiles = packedFilePaths(dryRunPackResult);
  const actualFiles = packedFilePaths(actualPackResult);
  if (JSON.stringify(dryRunFiles) !== JSON.stringify(actualFiles)) {
    const drySet = new Set(dryRunFiles);
    const actualSet = new Set(actualFiles);
    const onlyDryRun = dryRunFiles.filter((filePath) => !actualSet.has(filePath));
    const onlyActual = actualFiles.filter((filePath) => !drySet.has(filePath));
    throw new Error([
      'npm pack file list does not match dry-run output',
      onlyDryRun.length ? `Only in dry-run:\n${onlyDryRun.map((filePath) => `- ${filePath}`).join('\n')}` : null,
      onlyActual.length ? `Only in actual pack:\n${onlyActual.map((filePath) => `- ${filePath}`).join('\n')}` : null
    ].filter(Boolean).join('\n'));
  }
}

function runNpmPack(stageRoot, dryRun = false) {
  const packCwd = path.dirname(stageRoot);
  const args = ['pack', '--json'];
  if (dryRun) args.push('--dry-run');
  else args.push('--pack-destination', packCwd);
  args.push(stageRoot);
  const npmCache = path.join(packCwd, '.npm-cache');
  fs.mkdirSync(npmCache, { recursive: true });
  const result = spawnSync('npm', args, {
    cwd: packCwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_cache: npmCache
    }
  });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  const packJson = parseNpmPackJson(result.stdout);
  verifyPackFileList(packJson);
  const tarball = dryRun ? null : path.resolve(packCwd, packJson.filename || `${packJson.name}-${packJson.version}.tgz`);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    json: packJson,
    tarball: tarball ? path.resolve(packCwd, tarball) : null
  };
}

function readAutomationArtifactProvenance(inputDir) {
  return readAutomationArtifactProvenanceForSource(inputDir, AUTOMATION_ARTIFACT_SOURCE);
}

function readAutomationArtifactProvenanceForSource(inputDir, artifactSource = AUTOMATION_ARTIFACT_SOURCE) {
  const provenancePath = path.join(inputDir, AUTOMATION_PROVENANCE_FILE);
  if (!fs.existsSync(provenancePath)) {
    throw new Error(`Automation artifact provenance not found: ${provenancePath}`);
  }
  const provenance = readJson(provenancePath);
  if (provenance.automationEnabledDefault !== true) {
    throw new Error(`${AUTOMATION_PROVENANCE_FILE} must set automationEnabledDefault: true`);
  }
  const expectedSource = artifactSource || AUTOMATION_ARTIFACT_SOURCE;
  if (provenance.artifactSource && provenance.artifactSource !== expectedSource) {
    throw new Error(`${AUTOMATION_PROVENANCE_FILE} artifactSource must be ${expectedSource}`);
  }
  if (provenance.buildMode && provenance.buildMode !== expectedSource) {
    throw new Error(`${AUTOMATION_PROVENANCE_FILE} buildMode must be ${expectedSource}`);
  }
  return provenance;
}

function resolveProvenanceArtifactPath(inputDir, provenance, artifactKey) {
  const rawPath = provenance?.artifacts?.[artifactKey]?.path || provenance?.source?.[artifactKey];
  if (!rawPath) return null;
  const candidate = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(inputDir, path.basename(rawPath));
  return fs.existsSync(candidate) ? candidate : null;
}

function findLatestAutomationChromeZip(inputDir) {
  const matches = fs.readdirSync(inputDir)
    .map((name) => {
      const match = name.match(/^chrome_(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)_automation\.zip$/);
      return match ? { name, version: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareSemverCore(b.version, a.version) || a.name.localeCompare(b.name));
  return matches.length ? path.join(inputDir, matches[0].name) : null;
}

function findLatestAutomationFirefoxZip(inputDir) {
  const matches = fs.readdirSync(inputDir)
    .map((name) => {
      const match = name.match(/^firefox_(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)_automation\.zip$/);
      return match ? { name, version: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareSemverCore(b.version, a.version) || a.name.localeCompare(b.name));
  return matches.length ? path.join(inputDir, matches[0].name) : null;
}

function resolveAutomationChromeZip(inputDir, provenance) {
  const fromProvenance = resolveProvenanceArtifactPath(inputDir, provenance, 'chromeZip');
  if (fromProvenance) return fromProvenance;
  const fallback = findLatestAutomationChromeZip(inputDir);
  if (fallback) return fallback;
  throw new Error(`Chromium automation ZIP not found in ${inputDir}; expected chrome_<version>_automation.zip`);
}

function resolveAutomationFirefoxZip(inputDir, provenance) {
  const fromProvenance = resolveProvenanceArtifactPath(inputDir, provenance, 'firefoxZip');
  if (fromProvenance) return fromProvenance;
  const fallback = findLatestAutomationFirefoxZip(inputDir);
  if (fallback) return fallback;
  throw new Error(`Firefox automation ZIP not found in ${inputDir}; expected firefox_<version>_automation.zip`);
}

function resolveAutomationCrx(inputDir, provenance) {
  const fromProvenance = resolveProvenanceArtifactPath(inputDir, provenance, 'crx');
  if (fromProvenance) return fromProvenance;
  const fallback = path.join(inputDir, AUTOMATION_CRX_FILE);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`Chromium automation CRX not found in ${inputDir}; expected ${AUTOMATION_CRX_FILE}`);
}

function resolveAutomationXpi(inputDir, provenance) {
  const fromProvenance = resolveProvenanceArtifactPath(inputDir, provenance, 'xpi');
  if (fromProvenance) return fromProvenance;
  const fallback = path.join(inputDir, AUTOMATION_XPI_FILE);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`Firefox automation XPI not found in ${inputDir}; expected ${AUTOMATION_XPI_FILE}`);
}

function validateAutomationCrx(crxPath, expectedManifest) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-crx-validate-'));
  const zipPath = path.join(tempRoot, 'payload.zip');
  try {
    extractZipPayload(crxPath, zipPath);
    const manifest = readZipManifest(zipPath);
    if (manifest.version !== expectedManifest.version) {
      throw new Error(`Chromium automation CRX version ${manifest.version} does not match ZIP version ${expectedManifest.version}`);
    }
    if (manifest?.background?.service_worker !== expectedManifest?.background?.service_worker) {
      throw new Error('Chromium automation CRX service worker does not match the canonical ZIP');
    }
    if (readZipFile(zipPath, DEV_LOCAL_CONFIG_FILE)) {
      throw new Error(`Chromium automation CRX must not include ${DEV_LOCAL_CONFIG_FILE}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateAutomationXpi(xpiPath, expectedManifest) {
  const manifest = readZipManifest(xpiPath);
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('Firefox automation XPI manifest does not match the canonical Firefox ZIP');
  }
  if (readZipFile(xpiPath, DEV_LOCAL_CONFIG_FILE)) {
    throw new Error(`Firefox automation XPI must not include ${DEV_LOCAL_CONFIG_FILE}`);
  }
}

function validateAutomationPopup(manifest, label, actionKey, archivePath) {
  if (manifest.options_ui) {
    throw new Error(`${label} automation manifest must not expose options_ui`);
  }
  const otherActionKey = actionKey === 'action' ? 'browser_action' : 'action';
  if (manifest[otherActionKey]) {
    throw new Error(`${label} automation manifest must use ${actionKey}, not ${otherActionKey}`);
  }
  const expectedIcon = 'ptk/browser/assets/images/ptk_auto_icon_128.png';
  const expectedPopup = 'ptk/automation/popup.html';
  const expectedAction = {
    default_icon: { 128: expectedIcon },
    default_title: 'PTK Auto',
    default_popup: expectedPopup
  };
  if (JSON.stringify(manifest.icons) !== JSON.stringify({ 128: expectedIcon })) {
    throw new Error(`${label} automation manifest must use the PTK Auto icon`);
  }
  if (JSON.stringify(manifest[actionKey]) !== JSON.stringify(expectedAction)) {
    throw new Error(`${label} automation manifest must expose only the passive PTK Auto diagnostic popup`);
  }
  for (const entry of [expectedIcon, expectedPopup, 'ptk/automation/popup.css', 'ptk/automation/popup.js']) {
    if (!readZipFile(archivePath, entry)) {
      throw new Error(`${label} automation archive is missing ${entry}`);
    }
  }
}

function validatePackagedAutomationExtension(stageRoot, options = {}) {
  const artifactSource = options.artifactSource || AUTOMATION_ARTIFACT_SOURCE;
  const extensionsDir = path.join(stageRoot, 'extensions');
  const zipPath = path.join(extensionsDir, PACKAGE_ZIP_FILE);
  const firefoxZipPath = path.join(extensionsDir, PACKAGE_FIREFOX_ZIP_FILE);
  const xpiPath = path.join(extensionsDir, PACKAGE_XPI_FILE);
  const zipDevLocalBytes = readZipFile(zipPath, DEV_LOCAL_CONFIG_FILE);
  if (zipDevLocalBytes) throw new Error(`Chromium ZIP must not include ${DEV_LOCAL_CONFIG_FILE}`);
  if (artifactSource === AUTOMATION_ARTIFACT_SOURCE && readZipFile(firefoxZipPath, DEV_LOCAL_CONFIG_FILE)) {
    throw new Error(`Firefox ZIP must not include ${DEV_LOCAL_CONFIG_FILE}`);
  }

  const chromiumManifest = readJson(path.join(extensionsDir, PACKAGE_CHROMIUM_MANIFEST_FILE));
  const firefoxManifest = readJson(path.join(extensionsDir, PACKAGE_FIREFOX_MANIFEST_FILE));
  if (Number(chromiumManifest.manifest_version) !== 3) {
    throw new Error('Chromium manifest template must be MV3');
  }
  const expectedServiceWorker = artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE
    ? PTKLABS_AUTOMATION_SERVICE_WORKER
    : 'app_automation.js';
  if (chromiumManifest?.background?.service_worker !== expectedServiceWorker) {
    if (artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE) {
      throw new Error(`Chromium PTK Labs automation manifest must use ${PTKLABS_AUTOMATION_SERVICE_WORKER}`);
    }
    throw new Error('Chromium automation manifest must use app_automation.js');
  }
  if (artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE) {
    if (Number(firefoxManifest.manifest_version) !== 3) {
      throw new Error('PTK Labs compatibility manifest must stay MV3 until a Firefox artifact exists');
    }
    if (firefoxManifest?.background?.service_worker !== PTKLABS_AUTOMATION_SERVICE_WORKER) {
      throw new Error(`PTK Labs compatibility manifest must use ${PTKLABS_AUTOMATION_SERVICE_WORKER}`);
    }
  } else if (Number(firefoxManifest.manifest_version) !== 2) {
    throw new Error('Firefox manifest template must be MV2');
  } else if (firefoxManifest?.background?.page !== 'ptk/background_automation.html') {
    throw new Error('Firefox automation manifest must use ptk/background_automation.html');
  }
  if (artifactSource === AUTOMATION_ARTIFACT_SOURCE) {
    validateAutomationPopup(chromiumManifest, 'Chromium', 'action', zipPath);
    validateAutomationPopup(firefoxManifest, 'Firefox', 'browser_action', firefoxZipPath);
  } else {
    for (const [label, manifest] of [['Chromium', chromiumManifest], ['Firefox', firefoxManifest]]) {
      if (manifest.action || manifest.browser_action || manifest.options_ui) {
        throw new Error(`${label} PTK Labs automation manifest must not expose action/browser_action/options_ui`);
      }
    }
  }
  const zipManifest = readZipManifest(zipPath);
  if (JSON.stringify(zipManifest) !== JSON.stringify(chromiumManifest)) {
    throw new Error(`Canonical PTK ZIP manifest.json must match ${PACKAGE_CHROMIUM_MANIFEST_FILE}`);
  }
  if (artifactSource === AUTOMATION_ARTIFACT_SOURCE) {
    const firefoxZipManifest = readZipManifest(firefoxZipPath);
    if (JSON.stringify(firefoxZipManifest) !== JSON.stringify(firefoxManifest)) {
      throw new Error(`Canonical Firefox ZIP manifest.json must match ${PACKAGE_FIREFOX_MANIFEST_FILE}`);
    }
    validateAutomationXpi(xpiPath, firefoxManifest);
  }
}

function validateExtensionManifests(chromiumManifest, firefoxManifest) {
  if (firefoxManifest.version !== chromiumManifest.version) {
    throw new Error(`XPI manifest.version ${firefoxManifest.version || '(empty)'} does not match CRX manifest.version ${chromiumManifest.version || '(empty)'}`);
  }
  for (const [label, manifest] of [['CRX', chromiumManifest], ['XPI', firefoxManifest]]) {
    if (![2, 3].includes(Number(manifest.manifest_version))) {
      throw new Error(`${label} manifest_version ${manifest.manifest_version || '(empty)'} is not supported`);
    }
    const name = `${manifest.name || ''} ${manifest.short_name || ''}`.toLowerCase();
    if (!name.includes('ptk') && !name.includes('penetration testing kit')) {
      throw new Error(`${label} manifest does not look like a PTK extension artifact`);
    }
  }
  return true;
}

function preparePackage(rawOptions = {}) {
  const options = {
    inputDir: rawOptions.inputDir ? path.resolve(rawOptions.inputDir) : DEFAULT_INPUT_DIR,
    outDir: rawOptions.outDir ? path.resolve(rawOptions.outDir) : DEFAULT_OUT_DIR,
    packageVersion: rawOptions.packageVersion || null,
    artifactSource: rawOptions.artifactSource || AUTOMATION_ARTIFACT_SOURCE,
    publishable: Boolean(rawOptions.publishable),
    skipSmoke: Boolean(rawOptions.skipSmoke),
    inputDirExplicit: Boolean(rawOptions.inputDirExplicit)
  };
  if (![AUTOMATION_ARTIFACT_SOURCE, PTKLABS_AUTOMATION_ARTIFACT_SOURCE].includes(options.artifactSource)) {
    throw new Error(`--artifact-source must be ${AUTOMATION_ARTIFACT_SOURCE} or ${PTKLABS_AUTOMATION_ARTIFACT_SOURCE}`);
  }

  const inputProvenance = readAutomationArtifactProvenanceForSource(options.inputDir, options.artifactSource);
  const chromeZipPath = resolveAutomationChromeZip(options.inputDir, inputProvenance);
  const usingPtkLabsArtifact = options.artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE;
  const crxPath = usingPtkLabsArtifact ? null : resolveAutomationCrx(options.inputDir, inputProvenance);
  const firefoxZipPath = usingPtkLabsArtifact ? null : resolveAutomationFirefoxZip(options.inputDir, inputProvenance);
  const xpiPath = usingPtkLabsArtifact ? null : resolveAutomationXpi(options.inputDir, inputProvenance);

  const stageRoot = path.join(options.outDir, PACKAGE_NAME);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageRoot, 'extensions'), { recursive: true });

  stageSdkFolders(stageRoot);
  copyFile(chromeZipPath, path.join(stageRoot, 'extensions', PACKAGE_ZIP_FILE));
  if (firefoxZipPath) copyFile(firefoxZipPath, path.join(stageRoot, 'extensions', PACKAGE_FIREFOX_ZIP_FILE));
  if (crxPath) copyFile(crxPath, path.join(stageRoot, 'extensions', PACKAGE_CRX_FILE));
  if (xpiPath) copyFile(xpiPath, path.join(stageRoot, 'extensions', PACKAGE_XPI_FILE));
  fs.mkdirSync(path.join(stageRoot, 'extensions', 'manifests'), { recursive: true });
  fs.writeFileSync(
    path.join(stageRoot, 'extensions', PACKAGE_CHROMIUM_MANIFEST_FILE),
    `${JSON.stringify(readZipManifest(chromeZipPath), null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(stageRoot, 'extensions', PACKAGE_CHROMIUM_MANIFEST_COMPAT_FILE),
    `${JSON.stringify(readZipManifest(chromeZipPath), null, 2)}\n`,
    'utf8'
  );
  const firefoxCompatibilityManifest = usingPtkLabsArtifact
    ? readZipManifest(chromeZipPath)
    : readZipManifest(firefoxZipPath);
  fs.writeFileSync(
    path.join(stageRoot, 'extensions', PACKAGE_FIREFOX_MANIFEST_FILE),
    `${JSON.stringify(firefoxCompatibilityManifest, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(stageRoot, 'extensions', PACKAGE_FIREFOX_MANIFEST_COMPAT_FILE),
    `${JSON.stringify(firefoxCompatibilityManifest, null, 2)}\n`,
    'utf8'
  );
  validatePackagedAutomationExtension(stageRoot, {
    artifactSource: options.artifactSource
  });

  const manifest = readZipManifest(path.join(stageRoot, 'extensions', PACKAGE_ZIP_FILE));
  const firefoxManifest = readJson(path.join(stageRoot, 'extensions', PACKAGE_FIREFOX_MANIFEST_FILE));
  if (crxPath) validateAutomationCrx(path.join(stageRoot, 'extensions', PACKAGE_CRX_FILE), manifest);
  validateExtensionManifests(manifest, firefoxManifest);
  const versionInfo = resolvePackageVersionInfo(manifest.version, options.packageVersion);
  const version = versionInfo.packageVersion;
  const publishability = options.publishable
    ? {
        ok: true,
        registryPreflight: 'deferred-to-protected-publish-workflow',
        reason: 'trusted-publishing-identity-is-only-available-at-npm-publish'
      }
    : {
        ok: false,
        skipped: true,
        reason: 'not_publishable'
      };
  writePackageJson(stageRoot, version, options);
  prunePublishedPackageSurface(stageRoot, options);
  syncNestedPackageMetadata(stageRoot, version);
  const provenance = writeProvenance(stageRoot, options.inputDir, manifest, firefoxManifest, version, {
    ...options,
    packageVersionSource: versionInfo.packageVersionSource,
    versionMappingReason: versionInfo.versionMappingReason,
    inputProvenance,
    sourceChromeZipName: path.basename(chromeZipPath),
    sourceCrxName: crxPath ? path.basename(crxPath) : null,
    sourceFirefoxZipName: firefoxZipPath ? path.basename(firefoxZipPath) : null,
    sourceXpiName: xpiPath ? path.basename(xpiPath) : null,
    sourceProvenanceName: AUTOMATION_PROVENANCE_FILE
  });
  verifyStagedPackage(stageRoot);
  verifyPackageJson(stageRoot);

  const dryRun = runNpmPack(stageRoot, true);
  const packed = runNpmPack(stageRoot, false);
  verifyPackFileListsMatch(dryRun.json, packed.json);
  let smoke = null;
  if (!options.skipSmoke) {
    smoke = require('./smoke-packed-package.cjs').smokePackedPackage(packed.tarball);
  }
  return {
    stageRoot,
    tarball: packed.tarball,
    packageName: PACKAGE_NAME,
    packageVersion: version,
    provenance,
    dryRunOutput: dryRun.stdout,
    packOutput: packed.stdout,
    packJson: packed.json,
    publishability,
    readyForManualPublishApproval: Boolean(options.publishable && !options.skipSmoke && publishability.ok),
    smoke
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(help());
      return 0;
    }
    const result = preparePackage(options);
    console.log(JSON.stringify({
      ok: true,
      stageRoot: result.stageRoot,
      tarball: result.tarball,
      packageName: result.packageName,
      packageVersion: result.packageVersion,
      artifactSource: result.provenance.artifactSource,
      extensionVersion: result.provenance.extensionVersion,
      hashes: result.provenance.hashes,
      sizes: result.provenance.sizes,
      publishability: result.publishability,
      readyForManualPublishApproval: result.readyForManualPublishApproval,
      smoke: result.smoke,
      skippedSmokeMeansNotPublishReady: options.skipSmoke ? true : undefined
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  AUTOMATION_ARTIFACT_SOURCE,
  AUTOMATION_CRX_FILE,
  AUTOMATION_PROVENANCE_FILE,
  AUTOMATION_XPI_FILE,
  DEFAULT_INPUT_DIR,
  DEFAULT_OUT_DIR,
  NPM_DOCS_ROOT,
  NPM_PUBLIC_DOCS_BASE_URL,
  NPM_PUBLIC_REPOSITORY_URL,
  PACKAGE_CHROMIUM_MANIFEST_FILE,
  PACKAGE_FIREFOX_MANIFEST_FILE,
  PACKAGE_FIREFOX_ZIP_FILE,
  PACKAGE_PROVENANCE_FILE,
  PACKAGE_ZIP_FILE,
  PACKAGE_CRX_FILE,
  PACKAGE_XPI_FILE,
  PTKLABS_AUTOMATION_ARTIFACT_SOURCE,
  PTKLABS_AUTOMATION_SERVICE_WORKER,
  assertSemver,
  compareSemverCore,
  containsForbiddenPath,
  findLatestAutomationChromeZip,
  findLatestAutomationFirefoxZip,
  findRelativeMarkdownLinks,
  hashTree,
  isAllowedPackedPath,
  parseArgs,
  packedFilePaths,
  preparePackage,
  readAutomationArtifactProvenance,
  readAutomationArtifactProvenanceForSource,
  rewriteNpmReadmeLinksForPackageRoot,
  resolveAutomationChromeZip,
  resolveAutomationFirefoxZip,
  resolvePackageVersionInfo,
  resolvePackageVersion,
  scanTextForSecrets,
  shouldSkipPublicDocOrExample,
  validateExtensionManifests,
  verifyPackageJson,
  verifyPackFileList,
  verifyPackFileListsMatch,
  verifyStagedPackage,
  writePackageJson,
  walkFiles
};
