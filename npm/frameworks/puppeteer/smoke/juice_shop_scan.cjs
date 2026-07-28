#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPtkPuppeteer() {
  const packageRoot = process.env.PTK_PACKAGE_ROOT;
  if (process.env.PTK_RELEASE_TEST_MODE === 'package' && packageRoot) {
    return require(path.join(packageRoot, 'frameworks', 'puppeteer', 'index.cjs'));
  }
  return require('../src/index.cjs');
}

const { armPtkIastForNavigation, launchPtkBrowser, normalizeEngines } = loadPtkPuppeteer();

function env(name, fallback = null) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return toBoolean(value, undefined);
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactDir() {
  const dir = path.resolve(env('PTK_ARTIFACTS_DIR', path.join(process.cwd(), '.ptk', 'artifacts', 'puppeteer-juice-shop')));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function writeJsonArtifact(name, payload) {
  const filePath = path.join(artifactDir(), safeName(name));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Artifact written: ${filePath}`);
  return filePath;
}

function frameworkPayload(config, status, failureReason = null) {
  return {
    framework: 'puppeteer',
    browser: config.browser,
    mode: env('PTK_RELEASE_TEST_MODE', 'source'),
    packageRoot: env('PTK_PACKAGE_ROOT'),
    sdkRoot: path.resolve(__dirname, '..'),
    extensionPath: config.extensionPath,
    targetUrl: config.baseUrl,
    profileDir: config.profileDir,
    artifactsDir: artifactDir(),
    startedAt: config.startedAt,
    endedAt: status === 'started' ? null : isoNow(),
    status,
    failureReason
  };
}

function progressEngines(progress) {
  return progress && progress.engines && typeof progress.engines === 'object' ? progress.engines : {};
}

function evaluateEngineGate(progress, requiredEngines) {
  const engines = progressEngines(progress);
  const observed = Object.keys(engines).map((name) => name.toUpperCase()).sort();
  const required = Array.from(new Set(requiredEngines.map((name) => String(name).toUpperCase()))).sort();
  const missing = required.filter((name) => !observed.includes(name));
  const errorEngines = Object.entries(engines)
    .filter(([, payload]) => payload && payload.status === 'error')
    .map(([name]) => name.toUpperCase())
    .sort();
  return {
    requiredEngines: required,
    observedEngines: observed,
    missingEngines: missing,
    errorEngines,
    passed: missing.length === 0 && errorEngines.length === 0
  };
}

function findingsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.findings)) return payload.findings;
  if (Array.isArray(payload && payload.data && payload.data.findings)) return payload.data.findings;
  return [];
}

function evaluateFindingGate(findings) {
  const count = findings.length;
  return {
    ok: count > 0,
    totalFindings: count,
    requirements: [
      {
        id: 'any_ptk_finding',
        description: 'At least one PTK finding',
        minimum: 1,
        count,
        ok: count > 0
      }
    ]
  };
}

async function clickIfPresent(page, selectors) {
  for (const selector of selectors) {
    let element = null;
    try {
      element = await page.$(selector);
    } catch (_) {
      continue;
    }
    if (!element) continue;
    try {
      await withTimeout(element.click(), 3000);
      return true;
    } catch (_) {
      // Try the next selector.
    }
  }
  return false;
}

async function typeIfPresent(page, selectors, value) {
  for (const selector of selectors) {
    let element = null;
    try {
      element = await page.$(selector);
    } catch (_) {
      continue;
    }
    if (!element) continue;
    try {
      await withTimeout(element.click({ clickCount: 3 }), 3000);
      await withTimeout(element.type(value), 3000);
      return true;
    } catch (_) {
      // Try the next selector.
    }
  }
  return false;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function dismissOverlays(page) {
  await clickIfPresent(page, [
    "button[aria-label='Close Welcome Banner']",
    "button[aria-label='close Welcome Banner']",
    '.close-dialog',
    'mat-dialog-container button'
  ]);
  await clickIfPresent(page, [
    "a[aria-label='dismiss cookie message']",
    "button[aria-label='dismiss cookie message']",
    '.cc-dismiss'
  ]);
}

async function runUserFlow(page, config) {
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  await page.setViewport({ width: 1433, height: 990 });
  await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.mat-grid-tile, .mat-search_icon-search', { timeout: 15000 }).catch(() => {});
  await dismissOverlays(page);

  await page.goto(`${config.baseUrl}/#/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#email, input#emailControl', { timeout: 15000 }).catch(() => {});
  await typeIfPresent(page, ['#email', 'input#emailControl'], config.loginEmail);
  await typeIfPresent(page, ['#password', 'input#passwordControl'], config.loginPassword);
  await clickIfPresent(page, ['#loginButton', 'button#loginButton']);
  await sleep(3000);

  await page.goto(`${config.baseUrl}/#/profile`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(1500);
  await withTimeout(page.evaluate((root) => {
    return Promise.allSettled([
      fetch(`${root}/profile`, { credentials: 'include' }),
      fetch(`${root}/rest/user/whoami`, { credentials: 'include' })
    ]);
  }, config.baseUrl), 3000).catch(() => {});

  await page.goto(`${config.baseUrl}/#/search?q=${encodeURIComponent(config.searchTerm)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2000);
}

async function waitForProgress(ptk, requiredEngines, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await ptk.getSessionProgress();
    const gate = evaluateEngineGate(last, requiredEngines);
    if (gate.missingEngines.length === 0) return last;
    await sleep(2000);
  }
  return last || {};
}

async function waitForFindings(ptk, config) {
  const deadline = Date.now() + config.requiredFindingsTimeoutMs;
  let payload = await ptk.getFindings({ limit: config.findingsLimit });
  let findings = findingsFromPayload(payload);
  while (findings.length === 0 && Date.now() < deadline) {
    await sleep(2000);
    payload = await ptk.getFindings({ limit: config.findingsLimit });
    findings = findingsFromPayload(payload);
  }
  return { payload, findings };
}

function readConfig() {
  const engines = normalizeEngines(env('PTK_ENGINES', 'DAST,IAST,SAST,SCA'));
  return {
    startedAt: isoNow(),
    baseUrl: env('JUICE_SHOP_URL', 'http://localhost:3001'),
    browser: env('PTK_BROWSER', 'chrome-for-testing'),
    project: env('PTK_PROJECT', 'juice-shop-puppeteer-smoke'),
    engines,
    policyCode: env('PTK_POLICY_CODE'),
    extensionPath: env('PTK_EXTENSION_PATH') || env('PTK_EXTENSION_DIR'),
    profileDir: env('PTK_PROFILE_DIR') || path.join(os.tmpdir(), `ptk-puppeteer-profile-${Date.now()}`),
    executablePath: env('PTK_PUPPETEER_EXECUTABLE_PATH') || env('PTK_EXECUTABLE_PATH') || env('PTK_CHROME_BINARY'),
    headless: toBoolean(env('PTK_HEADLESS'), false),
    immediateAnalysis: toOptionalBoolean(env('PTK_IMMEDIATE_ANALYSIS')),
    loginEmail: env('PTK_LOGIN_EMAIL', env('PTK_JUICE_USERNAME', 'YOUR_USERNAME')),
    loginPassword: env('PTK_LOGIN_PASSWORD', env('PTK_JUICE_PASSWORD', 'YOUR_PASSWORD')),
    searchTerm: env('PTK_SEARCH_TERM', 'test'),
    readyTimeoutMs: Number(env('PTK_READY_TIMEOUT_MS', '30000')),
    progressTimeoutMs: Number(env('PTK_PROGRESS_TIMEOUT_MS', '60000')),
    requiredFindingsTimeoutMs: Number(env('PTK_REQUIRED_FINDINGS_TIMEOUT', '120')) * 1000,
    findingsLimit: Number(env('PTK_FINDINGS_LIMIT', '500'))
  };
}

async function main() {
  const config = readConfig();
  let browser = null;
  let status = 'failed';
  let failureReason = null;

  writeJsonArtifact('framework-run.json', frameworkPayload(config, 'started'));

  try {
    const launched = await launchPtkBrowser({
      extensionPath: config.extensionPath,
      profileDir: config.profileDir,
      executablePath: config.executablePath,
      headless: config.headless
    });
    browser = launched.browser;
    config.extensionPath = launched.extensionPath;
    config.profileDir = launched.profileDir;

    writeJsonArtifact('browser-launch.json', {
      browserName: config.browser,
      browserVersion: await launched.browser.version().catch(() => null),
      executablePath: launched.launchOptions.executablePath || null,
      headless: launched.launchOptions.headless,
      extensionPath: launched.extensionPath,
      profileMode: 'user-data-dir',
      profileDir: launched.profileDir,
      launchArgs: launched.launchOptions.args,
      targetUrl: config.baseUrl
    });
    writeJsonArtifact('framework-run.json', frameworkPayload(config, 'started'));

    const { page, ptk } = launched;
    const startOptions = {
      project: config.project,
      engines: config.engines,
      policyCode: config.policyCode
    };
    const armResult = await armPtkIastForNavigation(page, {
      targetUrl: `${config.baseUrl}/`,
      scanOptions: startOptions,
      extensionPath: config.extensionPath,
      timeoutMs: config.readyTimeoutMs
    });
    if (config.engines.includes('IAST') && !armResult.ok) {
      throw new Error(`PTK IAST pre-navigation arm failed: ${JSON.stringify(armResult)}`);
    }
    console.log('PTK IAST pre-navigation arm:', armResult);
    await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const bridgeInfo = await ptk.waitReady(config.readyTimeoutMs);
    console.log('PTK bridge ready:', {
      version: bridgeInfo.version,
      capabilities: bridgeInfo.capabilities
    });

    const startResult = await ptk.startSession(startOptions);
    writeJsonArtifact('session_start.json', {
      status: 'started',
      startedAt: isoNow(),
      sessionId: startResult.sessionId,
      response: startResult
    });

    await runUserFlow(page, config);

    const progress = await waitForProgress(ptk, config.engines, config.progressTimeoutMs);
    const engineGate = evaluateEngineGate(progress, config.engines);
    const preStopFindingsResult = await waitForFindings(ptk, config);

    writeJsonArtifact('progress-summary.json', progress);
    writeJsonArtifact('engine_gate.json', engineGate);

    const stopResult = await ptk.endSession({
      wait: true,
      includeFindings: true,
      limit: config.findingsLimit,
      immediateAnalysis: config.immediateAnalysis
    });
    const finalFindingPayload = Array.isArray(stopResult.findings)
      ? { findings: stopResult.findings, truncated: stopResult.truncated === true }
      : preStopFindingsResult.payload;
    const finalFindings = findingsFromPayload(finalFindingPayload);
    const findingGate = evaluateFindingGate(finalFindings);

    writeJsonArtifact('findings.json', finalFindingPayload);
    writeJsonArtifact('finding_gate.json', findingGate);
    writeJsonArtifact('scan_stop.json', {
      stopSucceeded: stopResult.ok !== false,
      response: stopResult
    });
    writeJsonArtifact('session_stats.json', stopResult.stats || (stopResult.summary && stopResult.summary.stats) || {});

    let gateError = null;
    if (!engineGate.passed) {
      gateError = new Error(`Puppeteer engine gate failed: missing ${engineGate.missingEngines.join(', ')}`);
    } else if (!findingGate.ok) {
      gateError = new Error('Puppeteer finding gate failed: no PTK findings observed');
    }

    if (gateError) throw gateError;
    status = 'passed';
  } catch (error) {
    failureReason = error && error.message ? error.message : String(error);
    try {
      writeJsonArtifact('failure.json', {
        error: failureReason,
        stack: error && error.stack ? error.stack : null
      });
    } catch (_) {}
    throw error;
  } finally {
    writeJsonArtifact('framework-run.json', frameworkPayload(config, status, failureReason));
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
