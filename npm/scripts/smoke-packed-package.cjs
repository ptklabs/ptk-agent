#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readZipFile } = require('./unpack-crx.cjs');
const SDK_ROOT = path.resolve(__dirname, '..');
const SOURCE_PTK_ROOT = path.resolve(SDK_ROOT, '..');
const PTKLABS_AUTOMATION_ARTIFACT_SOURCE = 'ptklabs-automation-artifact';
const PTKLABS_AUTOMATION_SERVICE_WORKER = 'automation/background/automation-background-entry.js';

function listTarballFiles(tarball) {
  const result = run('tar', ['-tf', tarball], { cwd: path.dirname(tarball) });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
}

function assertTarballContents(tarball) {
  const files = listTarballFiles(tarball);
  const has = (prefix) => files.some((file) => file === prefix || file.startsWith(prefix));
  const required = [
    'package/index.cjs',
    'package/index.mjs',
    'package/index.d.ts',
    'package/agents/',
    'package/browser/',
    'package/frameworks/cypress/',
    'package/frameworks/playwright/',
    'package/frameworks/puppeteer/',
    'package/frameworks/selenium/',
    'package/providers/testmu/index.cjs',
    'package/providers/_shared/examples/run-ptk-example.mjs',
    'package/providers/testmu/examples/README.md',
    'package/providers/testmu/examples/cypress-juice-shop/README.md',
    'package/providers/testmu/examples/cypress-juice-shop/package.json',
    'package/providers/testmu/examples/cypress-juice-shop/lambdatest-config.json',
    'package/providers/testmu/examples/cypress-juice-shop/cypress.config.js',
    'package/providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js',
    'package/providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js',
    'package/providers/testmu/examples/k6-browser-juice-shop.js',
    'package/providers/testmu/examples/playwright-juice-shop.mjs',
    'package/providers/testmu/examples/puppeteer-juice-shop.mjs',
    'package/providers/testmu/examples/selenium-juice-shop.mjs',
    'package/providers/browserstack/index.cjs',
    'package/providers/browserstack/examples/README.md',
    'package/providers/browserstack/examples/playwright-juice-shop.mjs',
    'package/providers/browserstack/examples/puppeteer-juice-shop.mjs',
    'package/providers/browserstack/examples/selenium-juice-shop.mjs',
    'package/providers/browserbase/index.cjs',
    'package/providers/browserbase/examples/README.md',
    'package/providers/browserbase/examples/playwright-juice-shop.mjs',
    'package/providers/browserbase/examples/puppeteer-juice-shop.mjs',
    'package/providers/browserbase/examples/selenium-juice-shop.mjs',
    'package/providers/browserless/index.cjs',
    'package/providers/browserless/examples/README.md',
    'package/providers/browserless/examples/playwright-juice-shop.mjs',
    'package/providers/browserless/examples/puppeteer-juice-shop.mjs',
    'package/providers/steel/index.cjs',
    'package/providers/steel/examples/README.md',
    'package/providers/steel/examples/playwright-juice-shop.mjs',
    'package/providers/steel/examples/puppeteer-juice-shop.mjs',
    'package/providers/steel/examples/selenium-juice-shop.mjs',
    'package/providers/hyperbrowser/index.cjs',
    'package/providers/hyperbrowser/examples/README.md',
    'package/providers/hyperbrowser/examples/playwright-juice-shop.mjs',
    'package/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs',
    'package/providers/hyperbrowser/examples/selenium-juice-shop.mjs',
    'package/examples/github-actions/local-app-dast/README.md',
    'package/examples/github-actions/local-app-dast/ptk-security-scan.yml',
    'package/examples/github-actions/playwright-ptk/README.md',
    'package/examples/github-actions/playwright-ptk/playwright-ptk-smoke.mjs',
    'package/examples/github-actions/playwright-ptk/ptk-playwright.yml',
    'package/examples/github-actions/sast-js/README.md',
    'package/examples/github-actions/sast-js/ptk-sast-js.yml',
    'package/docs/npm/github-actions.md',
    'package/docs/npm/provider-browser-matrix.md',
    'package/docs/npm/providers.md',
    'package/docs/npm/sarif.md',
    'package/bin/ptk-scan',
    'package/bin/ptk-agent',
    'package/bin/ptk-agent-mcp-server',
    'package/extensions/index.cjs',
    'package/extensions/index.mjs',
    'package/extensions/index.d.ts',
    'package/extensions/extension-provenance.json',
    'package/extensions/ptk-latest.zip',
    'package/extensions/ptk-latest-firefox.zip',
    'package/extensions/ptk-latest.crx',
    'package/extensions/ptk-latest.xpi',
    'package/extensions/manifests/manifest.automation.chromium.json',
    'package/extensions/manifests/manifest.automation.firefox.json',
    'package/extensions/manifests/chromium-mv3.json',
    'package/extensions/manifests/firefox-mv2.json'
  ];
  const missing = required.filter((entry) => !has(entry));
  if (missing.length) throw new Error(`Tarball missing required entries:\n${missing.map((item) => `- ${item}`).join('\n')}`);

  const forbidden = [
    /^package\/integrations(?:\/|$)/,
    /^package\/sdks\/pypi(?:\/|$)/,
    /^package\/pypi(?:\/|$)/,
    /^package\/scripts(?:\/|$)/,
    /^package\/agents\/bin(?:\/|$)/,
    /^package\/agents\/benchmarks(?:\/|$)/,
    /^package\/agents\/src\/benchmarks(?:\/|$)/,
    /^package\/agents\/src\/cli\/commands\/benchmark\.cjs$/,
    /^package\/cypress(?:\/|$)/,
    /^package\/playwright(?:\/|$)/,
    /^package\/puppeteer(?:\/|$)/,
    /^package\/selenium(?:\/|$)/,
    /^package\/frameworks\/cypress\/package\.json$/,
    /^package\/frameworks\/(?:cypress|playwright|puppeteer|selenium)\/smoke(?:\/|$)/,
    /(?:^|\/)\.runs(?:\/|$)/,
    /(?:^|\/)\.cache(?:\/|$)/,
    /(?:^|\/)\.env$/,
    /dev\.local\.json$/
  ];
  const forbiddenMatches = files.filter((file) => isForbiddenTarballPath(file, forbidden));
  if (forbiddenMatches.length) {
    throw new Error(`Tarball contains forbidden entries:\n${forbiddenMatches.map((item) => `- ${item}`).join('\n')}`);
  }
}

function isForbiddenTarballPath(file, extraPatterns = []) {
  return extraPatterns.some((pattern) => pattern.test(file)) ||
    /^package\/extensions\/chromium-unpacked(?:\/|$)/.test(file) ||
    /^package\/extensions\/ptk-latest-(?:chromium|firefox)\.(?:crx|xpi)$/.test(file) ||
    /^package\/extensions\/ptk-latest-chromium\.zip$/.test(file);
}

function matchesAsteriskPattern(value, pattern) {
  const text = String(value ?? '');
  const wildcard = String(pattern ?? '');
  let textIndex = 0;
  let patternIndex = 0;
  let lastStarIndex = -1;
  let retryTextIndex = -1;

  while (textIndex < text.length) {
    if (patternIndex < wildcard.length && wildcard[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
      continue;
    }
    if (patternIndex < wildcard.length && wildcard[patternIndex] === '*') {
      lastStarIndex = patternIndex;
      patternIndex += 1;
      retryTextIndex = textIndex;
      continue;
    }
    if (lastStarIndex >= 0) {
      patternIndex = lastStarIndex + 1;
      retryTextIndex += 1;
      textIndex = retryTextIndex;
      continue;
    }
    return false;
  }

  while (patternIndex < wildcard.length && wildcard[patternIndex] === '*') patternIndex += 1;
  return patternIndex === wildcard.length;
}

function collectTarballCandidates(value) {
  if (!value) return [];
  const resolved = path.resolve(value);
  if (!value.includes('*')) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return fs.readdirSync(resolved)
        .filter((name) => /\.tgz$/i.test(name))
        .map((name) => path.join(resolved, name));
    }
    return [resolved];
  }
  const dir = path.resolve(path.dirname(value));
  const pattern = path.basename(value);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => matchesAsteriskPattern(name, pattern))
    .map((name) => path.join(dir, name));
}

function pickLatestTarball(candidates) {
  return candidates
    .filter((candidate) => candidate && fs.existsSync(candidate) && /\.tgz$/i.test(candidate))
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      if (leftStat.mtimeMs !== rightStat.mtimeMs) return leftStat.mtimeMs - rightStat.mtimeMs;
      return left.localeCompare(right);
    })
    .pop() || null;
}

function expandTarballArg(value) {
  return pickLatestTarball(collectTarballCandidates(value));
}

function expandTarballArgs(values) {
  const args = values && values.length ? values : [path.join(SDK_ROOT, '.release', 'npm')];
  return pickLatestTarball(args.flatMap(collectTarballCandidates));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout,
    env: {
      ...process.env,
      ...(options.env || {}),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_fetch_retries: options.npmFetchRetries || process.env.npm_config_fetch_retries || '0',
      npm_config_fetch_timeout: options.npmFetchTimeout || process.env.npm_config_fetch_timeout || '10000',
      npm_config_cache: options.npmCache || path.join(options.cwd || process.cwd(), '.npm-cache')
    }
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}${result.error ? `\n${result.error.message}` : ''}`);
    error.status = result.status;
    error.signal = result.signal;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.cause = result.error;
    throw error;
  }
  return result;
}

function installPackageByExtraction(tarball, tempRoot) {
  const packageRoot = path.join(tempRoot, 'node_modules', 'pentestkit');
  fs.mkdirSync(packageRoot, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', packageRoot, '--strip-components', '1'], { cwd: tempRoot });
  return packageRoot;
}

function isInstallEnvironmentFailure(error) {
  const text = `${error && error.message ? error.message : ''}\n${error && error.stderr ? error.stderr : ''}`.toLowerCase();
  return error && (
    error.signal === 'SIGTERM' ||
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('eai_again') ||
    text.includes('enotfound') ||
    text.includes('network') ||
    text.includes('fetch failed')
  );
}

function runPublicExportSmoke(tempRoot) {
  run('node', ['-e', 'const fs=require("fs"),path=require("path"); const packageJsonPath=require.resolve("pentestkit/package.json"); const p=require(packageJsonPath); if (p.license !== "AGPL-3.0-only") throw new Error(`unexpected license ${p.license}`); if (p.repository?.url !== "git+https://github.com/ptklabs/ptk-agent.git" || p.repository?.directory !== "npm") throw new Error("unexpected repository metadata"); if (p.publishConfig?.provenance !== true) throw new Error("npm provenance is not enabled"); if (p.peerDependencies?.["steel-sdk"] !== ">=0.18.0 <1.0.0") throw new Error("unexpected Steel SDK peer range"); if (p.peerDependencies?.["@testmuai/testmu-cloud"] !== ">=1.0.1 <2.0.0") throw new Error("unexpected TestMu SDK peer range"); if (p.peerDependencies?.["@hyperbrowser/sdk"] !== ">=0.91.0 <1.0.0") throw new Error("unexpected Hyperbrowser SDK peer range"); const license=fs.readFileSync(path.join(path.dirname(packageJsonPath), "LICENSE"), "utf8"); if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) throw new Error("AGPL license text is missing");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/browser");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/cypress");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/playwright");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/puppeteer");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/selenium");'], { cwd: tempRoot });
  run('node', ['-e', 'const ext = require("pentestkit/extensions"); if (typeof ext.ensureUnpackedPtkExtension !== "function") throw new Error("missing extension helpers");'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/testmu"); for (const name of ["createTestMuBrowserCloudSession","connectTestMuPlaywright","connectTestMuPuppeteer","connectTestMuSelenium"]) if (typeof p[name] !== "function") throw new Error(`missing testmu provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/browserstack"); for (const name of ["connectBrowserStackPlaywright","connectBrowserStackPuppeteer","connectBrowserStackSelenium"]) if (typeof p[name] !== "function") throw new Error(`missing browserstack provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/browserbase"); for (const name of ["connectBrowserbasePlaywright","connectBrowserbasePuppeteer","connectBrowserbaseSelenium","resolveBrowserbaseExtensionId"]) if (typeof p[name] !== "function") throw new Error(`missing browserbase provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/browserless"); for (const name of ["connectBrowserlessPlaywright","connectBrowserlessPuppeteer","browserlessWsEndpoint"]) if (typeof p[name] !== "function") throw new Error(`missing browserless provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/steel"); for (const name of ["connectSteelPlaywright","connectSteelPuppeteer","connectSteelSelenium","resolveSteelExtensionId"]) if (typeof p[name] !== "function") throw new Error(`missing steel provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'const p = require("pentestkit/providers/hyperbrowser"); for (const name of ["connectHyperbrowserPlaywright","connectHyperbrowserPuppeteer","connectHyperbrowserSelenium","resolveHyperbrowserExtensionId"]) if (typeof p[name] !== "function") throw new Error(`missing hyperbrowser provider ${name}`);'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/extensions/provenance");'], { cwd: tempRoot });
  run('node', ['-e', 'require("pentestkit/package.json");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { withPtkScan, bootstrapPtkPage, armPtkIastForNavigation } from "pentestkit/playwright"; if (typeof withPtkScan !== "function") throw new Error("missing withPtkScan"); if (typeof bootstrapPtkPage !== "function") throw new Error("missing bootstrapPtkPage"); if (typeof armPtkIastForNavigation !== "function") throw new Error("missing Playwright IAST pre-navigation arm");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { withPtkScan, armPtkIastForNavigation } from "pentestkit/selenium"; if (typeof withPtkScan !== "function") throw new Error("missing selenium withPtkScan"); if (typeof armPtkIastForNavigation !== "function") throw new Error("missing Selenium IAST pre-navigation arm");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { withPtkScan, armPtkIastForNavigation } from "pentestkit/puppeteer"; if (typeof withPtkScan !== "function") throw new Error("missing puppeteer withPtkScan"); if (typeof armPtkIastForNavigation !== "function") throw new Error("missing Puppeteer IAST pre-navigation arm");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { createTestMuBrowserCloudSession, connectTestMuPlaywright } from "pentestkit/providers/testmu"; if (typeof createTestMuBrowserCloudSession !== "function" || typeof connectTestMuPlaywright !== "function") throw new Error("missing testmu import");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import("./node_modules/pentestkit/providers/_shared/examples/run-ptk-example.mjs").then((m) => { if (typeof m.runPtkProviderExample !== "function") throw new Error("missing provider example helper"); });'], { cwd: tempRoot });
  for (const example of [
    'providers/testmu/examples/playwright-juice-shop.mjs',
    'providers/testmu/examples/puppeteer-juice-shop.mjs',
    'providers/testmu/examples/selenium-juice-shop.mjs',
    'providers/testmu/examples/cypress-juice-shop/cypress.config.js',
    'providers/testmu/examples/cypress-juice-shop/cypress/e2e/juice-shop-with-ptk.cy.js',
    'providers/testmu/examples/cypress-juice-shop/cypress/support/e2e.js',
    'providers/browserstack/examples/playwright-juice-shop.mjs',
    'providers/browserstack/examples/puppeteer-juice-shop.mjs',
    'providers/browserstack/examples/selenium-juice-shop.mjs',
    'providers/browserbase/examples/playwright-juice-shop.mjs',
    'providers/browserbase/examples/puppeteer-juice-shop.mjs',
    'providers/browserbase/examples/selenium-juice-shop.mjs',
    'providers/browserless/examples/playwright-juice-shop.mjs',
    'providers/browserless/examples/puppeteer-juice-shop.mjs',
    'providers/steel/examples/playwright-juice-shop.mjs',
    'providers/steel/examples/puppeteer-juice-shop.mjs',
    'providers/steel/examples/selenium-juice-shop.mjs',
    'providers/hyperbrowser/examples/playwright-juice-shop.mjs',
    'providers/hyperbrowser/examples/puppeteer-juice-shop.mjs',
    'providers/hyperbrowser/examples/selenium-juice-shop.mjs',
    'examples/github-actions/playwright-ptk/playwright-ptk-smoke.mjs'
  ]) {
    run('node', ['--check', path.join('node_modules', 'pentestkit', example)], { cwd: tempRoot });
  }
  const k6Example = path.join(tempRoot, 'node_modules', 'pentestkit', 'providers/testmu/examples/k6-browser-juice-shop.js');
  run('node', ['--input-type=module', '--check'], {
    cwd: tempRoot,
    input: fs.readFileSync(k6Example, 'utf8')
  });
  run('node', ['--input-type=module', '-e', 'import { connectBrowserStackPlaywright } from "pentestkit/providers/browserstack"; if (typeof connectBrowserStackPlaywright !== "function") throw new Error("missing browserstack import");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { connectBrowserbasePlaywright } from "pentestkit/providers/browserbase"; if (typeof connectBrowserbasePlaywright !== "function") throw new Error("missing browserbase import");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { connectBrowserlessPlaywright } from "pentestkit/providers/browserless"; if (typeof connectBrowserlessPlaywright !== "function") throw new Error("missing browserless import");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { connectSteelPlaywright, connectSteelSelenium } from "pentestkit/providers/steel"; if (typeof connectSteelPlaywright !== "function" || typeof connectSteelSelenium !== "function") throw new Error("missing steel import");'], { cwd: tempRoot });
  run('node', ['--input-type=module', '-e', 'import { connectHyperbrowserPlaywright, connectHyperbrowserSelenium } from "pentestkit/providers/hyperbrowser"; if (typeof connectHyperbrowserPlaywright !== "function" || typeof connectHyperbrowserSelenium !== "function") throw new Error("missing hyperbrowser import");'], { cwd: tempRoot });
}

function runMcpStdioSmoke(tempRoot) {
  const input = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ptk-npm-smoke', version: '0.0.0' }
      }
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'shutdown'
    }
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
  const result = run('npx', ['ptk-agent-mcp-server', '--stdio', '--workspace', tempRoot], {
    cwd: tempRoot,
    input
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (lines.length !== 3) throw new Error(`expected 3 MCP responses, got ${lines.length}`);
  if (lines[0].id !== 1 || !lines[0].result || lines[0].result.serverInfo.name !== 'pentestkit') {
    throw new Error('MCP initialize smoke failed');
  }
  if (lines[1].id !== 2 || !lines[1].result || !Array.isArray(lines[1].result.tools)) {
    throw new Error('MCP tools/list smoke failed');
  }
  if (!lines[1].result.tools.some(tool => tool.name === 'ptk_doctor_extension')) {
    throw new Error('MCP tools/list did not include ptk_doctor_extension');
  }
  if (lines[1].result.tools.some(tool => tool.name === 'ptk_run_scan')) {
    throw new Error('MCP tools/list exposed ptk_run_scan without --allow-scan');
  }
  if (lines[2].id !== 3) throw new Error('MCP shutdown smoke failed');
  return true;
}

function smokePackedPackage(tarballPath) {
  const tarball = expandTarballArg(tarballPath);
  if (!tarball || !fs.existsSync(tarball)) {
    throw new Error(`Package tarball not found: ${tarballPath}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-npm-smoke-'));
  let installMode = 'npm';
  try {
    run('npm', ['init', '-y'], { cwd: tempRoot });
    assertTarballContents(tarball);
    let packageRoot = path.join(tempRoot, 'node_modules', 'pentestkit');
    try {
      run('npm', [
        'install',
        tarball,
        '--package-lock=false',
        '--ignore-scripts',
        '--prefer-offline',
        '--fetch-retries=0',
        '--fetch-timeout=10000'
      ], {
        cwd: tempRoot,
        timeout: Number(process.env.PTK_NPM_SMOKE_INSTALL_TIMEOUT_MS || 45000)
      });
    } catch (error) {
      if (process.env.PTK_NPM_SMOKE_REQUIRE_INSTALL === '1' || !isInstallEnvironmentFailure(error)) {
        throw error;
      }
      installMode = 'tar-extract';
      packageRoot = installPackageByExtraction(tarball, tempRoot);
    }
    const resolvedPackageRoot = fs.realpathSync(packageRoot);
    const resolvedSourceRoot = fs.realpathSync(SOURCE_PTK_ROOT);
    if (resolvedPackageRoot === resolvedSourceRoot || resolvedPackageRoot.startsWith(`${resolvedSourceRoot}${path.sep}`)) {
      throw new Error(`Installed package resolved inside monorepo: ${resolvedPackageRoot}`);
    }
    const installedPackageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    runPublicExportSmoke(tempRoot);
    if (installMode === 'npm') {
      run('npx', ['ptk-scan', '--help'], { cwd: tempRoot });
      const agentHelp = run('npx', ['ptk-agent', '--help'], { cwd: tempRoot });
      if (/\bbenchmark\b/.test(agentHelp.stdout)) {
        throw new Error('ptk-agent --help exposed source-only benchmark command');
      }
      const versionResult = run('npx', ['ptk-agent', '--version'], { cwd: tempRoot });
      if (versionResult.stdout.trim() !== installedPackageJson.version) {
        throw new Error(`ptk-agent --version mismatch: expected ${installedPackageJson.version}, got ${versionResult.stdout.trim()}`);
      }
      const doctorResult = run('npx', ['ptk-agent', '--doctor-extension'], {
        cwd: tempRoot,
        env: {
          ...process.env,
          PTK_EXTENSION_DIR: '',
          PTK_EXTENSION_PATH: ''
        }
      });
      const doctor = JSON.parse(doctorResult.stdout);
      if (doctor.source !== 'bundled-package') {
        throw new Error(`expected doctor source bundled-package, got ${doctor.source}`);
      }
      run('npx', ['ptk-agent-mcp-server', '--help'], { cwd: tempRoot });
      run('npx', ['ptk-agent-mcp-server', '--list-tools'], { cwd: tempRoot });
      runMcpStdioSmoke(tempRoot);
      run('node', ['-e', 'require("pentestkit");'], { cwd: tempRoot });
      run('node', ['-e', 'require("pentestkit/agents");'], { cwd: tempRoot });
      run('node', ['--input-type=module', '-e', 'import ptk from "pentestkit"; if (!ptk.playwright) throw new Error("missing default playwright");'], { cwd: tempRoot });
    }

    for (const relative of [
      'extensions/ptk-latest.zip',
      'extensions/ptk-latest-firefox.zip',
      'extensions/ptk-latest.crx',
      'extensions/ptk-latest.xpi',
      'extensions/manifests/manifest.automation.chromium.json',
      'extensions/manifests/manifest.automation.firefox.json',
      'extensions/manifests/chromium-mv3.json',
      'extensions/manifests/firefox-mv2.json',
      'extensions/extension-provenance.json'
    ]) {
      const filePath = path.join(packageRoot, relative);
      if (!fs.existsSync(filePath)) throw new Error(`Installed package missing ${relative}`);
    }
    for (const relative of [
      'extensions/chromium-unpacked',
      'extensions/ptk-latest-chromium.zip',
      'extensions/ptk-latest-chromium.crx',
      'extensions/ptk-latest-firefox.xpi'
    ]) {
      const filePath = path.join(packageRoot, relative);
      if (fs.existsSync(filePath)) throw new Error(`Installed package must not include ${relative}`);
    }
    const provenance = JSON.parse(fs.readFileSync(path.join(packageRoot, 'extensions', 'extension-provenance.json'), 'utf8'));
    if (provenance.automationEnabledDefault !== true) {
      throw new Error('Installed package extension provenance does not mark automationEnabledDefault: true');
    }
    const zipManifest = JSON.parse(readZipFile(path.join(packageRoot, 'extensions', 'ptk-latest.zip'), 'manifest.json').toString('utf8'));
    const expectedServiceWorker = provenance.artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE
      ? PTKLABS_AUTOMATION_SERVICE_WORKER
      : 'app_automation.js';
    if (zipManifest?.background?.service_worker !== expectedServiceWorker) {
      throw new Error(`Installed package ZIP does not use ${expectedServiceWorker}`);
    }
    const zipDevLocalBytes = readZipFile(path.join(packageRoot, 'extensions', 'ptk-latest.zip'), 'dev.local.json');
    if (zipDevLocalBytes) {
      const zipDevLocal = JSON.parse(zipDevLocalBytes.toString('utf8'));
      if (zipDevLocal.automationEnabled !== true) {
        throw new Error('Installed package ZIP dev.local.json must set automationEnabled when present');
      }
      if (zipDevLocal.automationAllowChildFrameBootstrap === true) {
        throw new Error('Installed package ZIP must not enable child-frame bootstrap globally');
      }
    }
    const extensionScript = [
      'const fs = require("fs");',
      'const ext = require("pentestkit/extensions");',
      `const packageRoot = ${JSON.stringify(packageRoot)};`,
      `const cacheRoot = ${JSON.stringify(path.join(tempRoot, '.ptk'))};`,
      `const expectedServiceWorker = ${JSON.stringify(expectedServiceWorker)};`,
      'const zip = ext.resolvePtkExtensionArtifact({ packageRoot });',
      'if (!zip.automationEnabled) throw new Error("zip automation disabled");',
      'const firefoxZip = ext.resolvePtkFirefoxZipArtifact({ packageRoot });',
      'if (!fs.existsSync(firefoxZip.path) || firefoxZip.source !== "bundled-package") throw new Error("bundled Firefox ZIP was not resolved");',
      'const crx = ext.resolvePtkCrxArtifact({ packageRoot, cacheRoot });',
      'if (!fs.existsSync(crx.path) || crx.source !== "bundled-package") throw new Error("bundled crx was not resolved");',
      'const xpi = ext.resolvePtkXpiArtifact({ packageRoot, cacheRoot });',
      'if (!fs.existsSync(xpi.path) || xpi.source !== "bundled-package") throw new Error("bundled xpi was not resolved");',
      'const ensuredXpi = ext.ensurePtkXpi({ packageRoot, cacheRoot });',
      'if (ensuredXpi.path !== xpi.path || ensuredXpi.source !== "bundled-package") throw new Error("ensurePtkXpi did not preserve the signed bundled XPI");',
      'const unpacked = ext.ensureUnpackedPtkExtension({ packageRoot, cacheRoot });',
      'if (!fs.existsSync(require("path").join(unpacked.path, expectedServiceWorker))) throw new Error(`unpacked service worker missing: ${expectedServiceWorker}`);'
    ].join('\n');
    run('node', ['-e', extensionScript], { cwd: tempRoot });
    for (const relative of [
      'bin/ptk-scan',
      'bin/ptk-agent',
      'bin/ptk-agent-mcp-server'
    ]) {
      const filePath = path.join(packageRoot, relative);
      if ((fs.statSync(filePath).mode & 0o111) === 0) {
        throw new Error(`Installed package bin is not executable: ${relative}`);
      }
    }

    const resolverPath = path.join(packageRoot, 'agents', 'src', 'browser', 'extensionResolver.cjs');
    const script = [
      `const resolver = require(${JSON.stringify(resolverPath)});`,
      'delete process.env.PTK_EXTENSION_DIR;',
      'delete process.env.PTK_EXTENSION_PATH;',
      `const result = resolver.resolvePtkExtensionPath({ packageRoot: ${JSON.stringify(packageRoot)}, autoDetectExtension: false, env: {} });`,
      'if (result.source !== "bundled-package") throw new Error(`expected bundled-package, got ${result.source}`);',
      'if (!result.path) throw new Error("bundled extension path was not resolved");',
      'if (result.manifestVersion !== 3) throw new Error(`expected MV3 bundled extension, got ${result.manifestVersion}`);'
    ].join('\n');
    run('node', ['-e', script], { cwd: tempRoot });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    return {
      ok: true,
      tempRoot,
      cleanedUp: true,
      tarball,
      installMode,
      fullInstallSmoke: installMode === 'npm'
    };
  } catch (error) {
    error.tempRoot = tempRoot;
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    const result = smokePackedPackage(expandTarballArgs(argv));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    if (error.tempRoot) console.error(`Smoke workspace left at: ${error.tempRoot}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  expandTarballArg,
  expandTarballArgs,
  isForbiddenTarballPath,
  matchesAsteriskPattern,
  smokePackedPackage
};
