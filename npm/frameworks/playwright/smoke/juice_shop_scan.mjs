#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import helpers from '../../../scripts/framework-smoke-helpers.cjs';

const runtimeRequire = process.env.PTK_RELEASE_TEST_MODE === 'package' && process.env.PTK_PACKAGE_ROOT
  ? createRequire(path.join(process.env.PTK_PACKAGE_ROOT, 'package.json'))
  : createRequire(import.meta.url);
const { chromium } = runtimeRequire('playwright');

const {
  env,
  evaluateRequiredFindings,
  frameworkPayload,
  findingsFromPayload,
  logFindingGate,
  missingRequirementDescriptions,
  normalizeAppBaseUrl,
  normalizeEngines,
  requireSmokeCredentials,
  toBoolean,
  toOptionalBoolean,
  waitForProgressEvidence,
  waitForRequiredFindingGate,
  writeJsonArtifact
} = helpers;

const PORTAL_POLICY_ENGINES = ['DAST', 'IAST', 'SAST'];

async function loadPtkPlaywright() {
  const packageRoot = env('PTK_PACKAGE_ROOT');
  if (env('PTK_RELEASE_TEST_MODE') === 'package' && packageRoot) {
    return import(pathToFileURL(path.join(packageRoot, 'frameworks', 'playwright', 'index.mjs')).href);
  }
  try {
    return await import('pentestkit/playwright');
  } catch (_) {
    return await import('../src/index.mjs');
  }
}

function optionalPositiveNumber(name) {
  const raw = env(name);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number when provided.`);
  }
  return value;
}

function readConfig() {
  const extensionPath = env('PTK_EXTENSION_PATH') || env('PTK_EXTENSION_DIR');
  if (!extensionPath) throw new Error('Set PTK_EXTENSION_PATH to the unpacked PTK extension directory.');
  const profileDir = env('PTK_PROFILE_DIR') || fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-playwright-smoke-'));
  const portalBaseUrl = env('PTK_PORTAL_BASE_URL') || env('PTK_PORTAL_URL');
  return {
    framework: 'playwright',
    startedAt: new Date().toISOString(),
    sdkRoot: path.resolve(new URL('..', import.meta.url).pathname),
    baseUrl: normalizeAppBaseUrl(env('JUICE_SHOP_URL', 'http://localhost:3001')),
    browser: env('PTK_BROWSER', 'chromium'),
    project: env('PTK_PROJECT', 'juice-shop-playwright-smoke'),
    engines: normalizeEngines(env('PTK_ENGINES', 'DAST,IAST,SAST,SCA')),
    policyCode: env('PTK_POLICY_CODE'),
    extensionPath: path.resolve(extensionPath),
    profileDir: path.resolve(profileDir),
    executablePath: env('PTK_PLAYWRIGHT_EXECUTABLE_PATH') || env('PTK_EXECUTABLE_PATH') || env('PTK_CHROME_BINARY'),
    headless: toBoolean(env('PTK_HEADLESS'), false),
    immediateAnalysis: toOptionalBoolean(env('PTK_IMMEDIATE_ANALYSIS')),
    loginEmail: env('PTK_LOGIN_EMAIL', env('PTK_JUICE_USERNAME', 'YOUR_USERNAME')),
    loginPassword: env('PTK_LOGIN_PASSWORD', env('PTK_JUICE_PASSWORD', 'YOUR_PASSWORD')),
    searchTerm: env('PTK_SEARCH_TERM', 'test'),
    activateBridge: toBoolean(env('PTK_BRIDGE_ACTIVATE'), false),
    readyTimeoutMs: Number(env('PTK_READY_TIMEOUT_MS', '30000')),
    progressTimeoutMs: Number(env('PTK_PROGRESS_TIMEOUT_MS', '60000')),
    minScanSeconds: Number(env('PTK_MIN_SCAN_SECONDS', '30')),
    requiredFindingsTimeoutSeconds: Number(env('PTK_REQUIRED_FINDINGS_TIMEOUT', env('PTK_MAX_SCAN_SECONDS', '300'))),
    findingsLimit: Number(env('PTK_FINDINGS_LIMIT', '500')),
    portal: {
      baseUrl: portalBaseUrl ? portalBaseUrl.replace(/\/+$/, '') : null,
      token: env('PTK_PORTAL_TOKEN') || env('PTK_PORTAL_PAT'),
      policyIds: {
        DAST: env('PTK_PORTAL_DAST_POLICY_ID', env('PTK_PORTAL_POLICY_ID')),
        IAST: env('PTK_PORTAL_IAST_POLICY_ID'),
        SAST: env('PTK_PORTAL_SAST_POLICY_ID')
      },
      dast: {
        concurrency: optionalPositiveNumber('PTK_DAST_CONCURRENCY'),
        planningConcurrency: optionalPositiveNumber('PTK_DAST_PLANNING_CONCURRENCY'),
        maxRequestsPerSecond: optionalPositiveNumber('PTK_DAST_MAX_RPS')
      }
    }
  };
}

function launchArgs(extensionPath) {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions-file-access-check',
    '--disable-popup-blocking',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ];
}

function channelFor(browser) {
  if (browser === 'chrome') return 'chrome';
  if (browser === 'edge') return 'msedge';
  return undefined;
}

function selectedEngineSet(config) {
  return new Set((config.engines || []).map((engine) => String(engine || '').toUpperCase()));
}

function compactPortalError(payload, fallback) {
  if (payload && typeof payload === 'object') {
    for (const key of ['error', 'message', 'code']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim();
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 300);
  return fallback;
}

async function fetchPortalJson(config, pathName) {
  const url = new URL(pathName, `${config.portal.baseUrl}/`);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.portal.token}`
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new Error(`Portal request failed for ${url.pathname}: ${response.status} ${compactPortalError(payload, response.statusText)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Portal request for ${url.pathname} did not return a rulepack object.`);
  }
  return payload;
}

function countRulepackChildren(rulepack, childKey) {
  return (Array.isArray(rulepack?.modules) ? rulepack.modules : [])
    .reduce((sum, moduleDef) => sum + (Array.isArray(moduleDef?.[childKey]) ? moduleDef[childKey].length : 0), 0);
}

function summarizeRulepack(engine, policyId, rulepack) {
  const moduleCount = Array.isArray(rulepack?.modules) ? rulepack.modules.length : 0;
  const policy = rulepack?.policy && typeof rulepack.policy === 'object' ? rulepack.policy : {};
  const summary = {
    engine,
    policyId: String(policy?.id || policyId || ''),
    policyName: policy?.name || null,
    schema: rulepack?.schema || null,
    rulepackEngine: rulepack?.engine || null,
    version: rulepack?.version || null,
    modules: moduleCount
  };
  if (engine === 'DAST') summary.attacks = countRulepackChildren(rulepack, 'attacks');
  if (engine === 'IAST' || engine === 'SAST') summary.rules = countRulepackChildren(rulepack, 'rules');
  return summary;
}

function hasPortalPolicyInputs(config) {
  const ids = config.portal?.policyIds || {};
  return Object.values(ids).some(Boolean);
}

function addDefined(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

async function loadPortalEngineConfigs(config) {
  if (!hasPortalPolicyInputs(config)) return { engineConfigs: null, summary: null };
  if (!config.portal.baseUrl) throw new Error('Set PTK_PORTAL_BASE_URL when using PTK_PORTAL_*_POLICY_ID.');
  if (!config.portal.token) throw new Error('Set PTK_PORTAL_TOKEN when using PTK_PORTAL_*_POLICY_ID.');

  const selected = selectedEngineSet(config);
  const engineConfigs = {};
  const summary = {
    portalBaseUrl: config.portal.baseUrl,
    loadedAt: new Date().toISOString(),
    policies: []
  };

  for (const engine of PORTAL_POLICY_ENGINES) {
    if (!selected.has(engine)) continue;
    const policyId = config.portal.policyIds[engine];
    if (!policyId) continue;

    const rulepack = await fetchPortalJson(config, `/api/v1/policies/${encodeURIComponent(policyId)}`);
    const policy = rulepack?.policy && typeof rulepack.policy === 'object' ? rulepack.policy : {};
    const engineConfig = {
      policyId: String(policy?.id || policyId),
      rulepack
    };
    if (policy?.name) engineConfig.policyName = policy.name;
    if (engine === 'DAST') {
      engineConfig.dastScanPolicy = 'PORTAL';
      engineConfig.allowCaptureWithoutInteraction = true;
      addDefined(engineConfig, 'concurrency', config.portal.dast.concurrency);
      addDefined(engineConfig, 'planningConcurrency', config.portal.dast.planningConcurrency);
      addDefined(engineConfig, 'maxRequestsPerSecond', config.portal.dast.maxRequestsPerSecond);
    }

    engineConfigs[engine] = engineConfig;
    summary.policies.push(summarizeRulepack(engine, policyId, rulepack));
  }

  if (!summary.policies.length) {
    throw new Error('Portal smoke requested but no selected engine has a PTK_PORTAL_*_POLICY_ID value.');
  }

  return { engineConfigs, summary };
}

function summarizeEngineConfig(engine, value) {
  const summary = {
    hasRulepack: !!(value?.rulepack && typeof value.rulepack === 'object'),
    policyId: value?.policyId || null,
    policyName: value?.policyName || null
  };
  if (value?.rulepack && typeof value.rulepack === 'object') {
    Object.assign(summary, summarizeRulepack(engine, value.policyId, value.rulepack));
  }
  if (engine === 'DAST') {
    summary.dastScanPolicy = value?.dastScanPolicy || null;
    summary.allowCaptureWithoutInteraction = value?.allowCaptureWithoutInteraction === true;
    summary.concurrency = value?.concurrency || null;
    summary.planningConcurrency = value?.planningConcurrency || null;
    summary.maxRequestsPerSecond = value?.maxRequestsPerSecond || null;
  }
  return summary;
}

function summarizeStartOptions(options) {
  const engineConfigs = options.engineConfigs && typeof options.engineConfigs === 'object'
    ? Object.fromEntries(Object.entries(options.engineConfigs).map(([engine, value]) => [
      engine,
      summarizeEngineConfig(engine, value)
    ]))
    : null;
  return {
    project: options.project,
    engines: options.engines,
    policyCode: options.policyCode || null,
    hasEngineConfigs: !!engineConfigs,
    engineConfigs
  };
}

async function launchBrowser(config) {
  if (!fs.existsSync(config.extensionPath)) {
    throw new Error(`PTK extension directory not found: ${config.extensionPath}`);
  }
  fs.mkdirSync(config.profileDir, { recursive: true });
  const launchOptions = {
    headless: config.headless,
    viewport: { width: 1433, height: 990 },
    args: launchArgs(config.extensionPath)
  };
  const channel = channelFor(config.browser);
  if (channel) launchOptions.channel = channel;
  if (config.executablePath) launchOptions.executablePath = config.executablePath;

  const context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  return { context, page, launchOptions };
}

async function clickIfPresent(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000, force: true });
        return true;
      }
    } catch (_) {
      // Try the next selector.
    }
  }
  return false;
}

async function clickRequired(page, selectors, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: 5000 });
        await locator.click({ timeout: 5000, force: true });
        return;
      } catch (_) {
        // Try the next selector.
      }
    }
    await dismissOverlays(page);
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not locate ${label}. Tried: ${selectors.join(', ')}`);
}

async function typeRequired(page, selectors, value, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      await locator.click({ timeout: 5000, force: true });
      await locator.fill(String(value), { timeout: 5000 });
      return;
    } catch (_) {
      // Try the next selector.
    }
  }
  const diagnostic = await page.evaluate(() => ({
    url: window.location.href,
    readyState: document.readyState,
    bodyText: String(document.body?.innerText || '').slice(0, 500)
  })).catch(() => ({ url: page.url(), readyState: 'unavailable', bodyText: '' }));
  throw new Error(
    `Could not locate ${label}. Tried: ${selectors.join(', ')}. `
    + `Page: ${JSON.stringify(diagnostic)}`
  );
}

async function dismissOverlays(page) {
  await clickIfPresent(page, [
    "button[aria-label='Close Welcome Banner']",
    "button[aria-label='close Welcome Banner']",
    "button[aria-label='Close Dialog']",
    '.close-dialog',
    'mat-dialog-container button'
  ]);
  await clickIfPresent(page, [
    "a[aria-label='dismiss cookie message']",
    "button[aria-label='dismiss cookie message']",
    '.cc-dismiss'
  ]);
}

async function ensureSmokeUser(page, config) {
  requireSmokeCredentials(config);
  const response = await page.request.post(`${config.baseUrl}/api/Users/`, {
    data: {
      email: config.loginEmail,
      password: config.loginPassword,
      passwordRepeat: config.loginPassword,
      securityQuestion: {
        id: 2,
        question: "Mother's maiden name?"
      },
      securityAnswer: 'ptk'
    }
  }).catch((error) => ({ status: () => 0, error }));
  const status = typeof response.status === 'function' ? response.status() : 0;
  if (![200, 201, 400, 409].includes(status)) {
    throw new Error(`Could not prepare Juice Shop smoke user. Status: ${status}`);
  }
  console.log(`Smoke user fixture status: ${status}`);
}

async function clearSiteState(page, config) {
  await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => {});
}

async function waitForLoginSuccess(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const profileSelectors = [
    "[aria-label='Go to user profile']",
    "a[aria-label='Go to user profile']",
    "button[aria-label='Go to user profile']",
    '#navbarUser',
    "button[id='navbarUser']"
  ];
  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.toLowerCase().includes('login')) return true;
    await clickIfPresent(page, [
      '#navbarAccount',
      "button[aria-label='Show/hide account menu']",
      "button[aria-label*='Account']"
    ]);
    for (const selector of profileSelectors) {
      if (await page.locator(selector).count().catch(() => 0)) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function runLoginFlow(page, config) {
  await page.goto(`${config.baseUrl}/#/login`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await typeRequired(page, [
    '#email',
    'input#emailControl',
    "input[formcontrolname='email']",
    "input[type='email']"
  ], config.loginEmail, 'email input');
  await typeRequired(page, [
    '#password',
    'input#passwordControl',
    "input[formcontrolname='password']",
    "input[type='password']"
  ], config.loginPassword, 'password input');
  await clickRequired(page, [
    '#loginButton',
    'button#loginButton',
    "button[type='submit']",
    "button:has-text('Log in')"
  ], 'login submit button');
  await page.keyboard.press('Enter').catch(() => {});
  if (!await waitForLoginSuccess(page, 15000)) {
    throw new Error('Login did not complete. Verify PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD or the Juice Shop fixture user setup.');
  }
}

async function exerciseJwtCookieSurface(page, config) {
  const statuses = await page.evaluate(async (root) => {
    const results = await Promise.allSettled([
      fetch(`${root}/rest/user/whoami`, { credentials: 'include' }),
      fetch(`${root}/profile`, { credentials: 'include' })
    ]);
    return results.map((result) => result.status === 'fulfilled' ? result.value.status : 0);
  }, config.baseUrl).catch(() => []);
  console.log(`JWT cookie surface exercised: ${statuses.join(', ')}`);
}

async function goHome(page, config) {
  await page.goto(`${config.baseUrl}/#/`, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await page.waitForSelector('.mat-grid-tile, button[aria-label="Add to Basket"]', { timeout: 15000 }).catch(() => {});
}

async function clearBasket(page, config) {
  await page.goto(`${config.baseUrl}/#/basket`, { waitUntil: 'domcontentloaded' });
  for (let index = 0; index < 40; index += 1) {
    const removed = await page.evaluate(() => {
      const selectors = [
        'app-purchase-basket svg[data-icon="trash-alt"]',
        'app-purchase-basket i.fa-trash-alt',
        'app-purchase-basket .cdk-column-remove button',
        'app-purchase-basket mat-cell.cdk-column-remove button',
        'app-purchase-basket button[aria-label="Remove from Basket"]'
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        const button = selector.includes('trash-alt') ? element.closest('button') : element;
        if (button) {
          button.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (!removed) break;
    await page.waitForTimeout(300);
  }
  await goHome(page, config);
}

async function addProductsToBasket(page, count) {
  await page.waitForSelector("button[aria-label='Add to Basket']", { timeout: 15000 });
  for (let index = 0; index < count; index += 1) {
    const buttons = page.locator("button[aria-label='Add to Basket']");
    await buttons.nth(index).click({ timeout: 10000, force: true });
    await page.waitForTimeout(300);
  }
}

async function removeOneItemFromBasket(page, config) {
  await page.goto(`${config.baseUrl}/#/basket`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-purchase-basket mat-row, app-purchase-basket mat-table', { timeout: 15000 }).catch(() => {});
  for (let index = 0; index < 30; index += 1) {
    const clicked = await page.evaluate(() => {
      const selectors = [
        'app-purchase-basket svg[data-icon="trash-alt"]',
        'app-purchase-basket i.fa-trash-alt',
        'app-purchase-basket .cdk-column-remove button',
        'app-purchase-basket mat-cell.cdk-column-remove button',
        'app-purchase-basket mat-row mat-cell:nth-of-type(5) button',
        'app-purchase-basket button[aria-label="Remove from Basket"]'
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        const button = selector.includes('trash-alt') ? element.closest('button') : element;
        if (button) {
          button.click();
          return true;
        }
      }
      const firstRow = document.querySelector('app-purchase-basket mat-row');
      if (firstRow) {
        const rowButtons = firstRow.querySelectorAll('button');
        const button = rowButtons[rowButtons.length - 1];
        if (button) {
          button.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (clicked) return;
    await page.waitForTimeout(500);
  }
  throw new Error('Could not locate remove item button in basket');
}

async function searchFor(page, config) {
  await goHome(page, config);
  await clickRequired(page, [
    "button[aria-label='Search']",
    "mat-icon:has-text('search')",
    '.mat-search_icon-search',
    "button:has-text('Search')"
  ], 'search button');
  await typeRequired(page, [
    'input#searchQuery',
    '#searchQuery input',
    "input[id^='mat-input-']",
    "input[placeholder*='Search']",
    "input[aria-label='Search']",
    "input[type='search']"
  ], config.searchTerm, 'search input');
  await page.keyboard.press('Enter');
  await page.waitForURL(/search/i, { timeout: 15000 }).catch(() => {});
}

async function runUserFlow(page, config) {
  await clearSiteState(page, config);
  await ensureSmokeUser(page, config);
  await goHome(page, config);
  await runLoginFlow(page, config);
  await page.goto(`${config.baseUrl}/#/profile`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/profile/i, { timeout: 15000 }).catch(() => {});
  await exerciseJwtCookieSurface(page, config);
  await goHome(page, config);
  await clearBasket(page, config);
  await addProductsToBasket(page, 2);
  await removeOneItemFromBasket(page, config);
  await searchFor(page, config);
}

async function main() {
  const config = readConfig();
  const { createPtkBridge } = await loadPtkPlaywright();
  let context = null;
  let status = 'failed';
  let failureReason = null;
  let sessionStarted = false;

  writeJsonArtifact('framework-run.json', frameworkPayload(config, 'started'));

  try {
    const launched = await launchBrowser(config);
    context = launched.context;
    const page = launched.page;
    let browserVersion = null;
    try {
      browserVersion = context.browser() ? context.browser().version() : null;
    } catch (_) {
      browserVersion = null;
    }
    writeJsonArtifact('browser-launch.json', {
      browserName: config.browser,
      browserVersion,
      executablePath: launched.launchOptions.executablePath || null,
      headless: launched.launchOptions.headless,
      extensionPath: config.extensionPath,
      profileMode: 'persistent-context',
      profileDir: config.profileDir,
      launchArgs: launched.launchOptions.args,
      targetUrl: config.baseUrl
    });

    const portalPolicies = await loadPortalEngineConfigs(config);
    if (portalPolicies.summary) {
      writeJsonArtifact('portal-policy-summary.json', portalPolicies.summary);
    }
    const startOptions = {
      project: config.project,
      engines: config.engines,
      policyCode: config.policyCode
    };
    if (portalPolicies.engineConfigs) startOptions.engineConfigs = portalPolicies.engineConfigs;
    writeJsonArtifact('session_start_options.json', summarizeStartOptions(startOptions));

    await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const ptk = createPtkBridge(page);
    const bridgeInfo = await ptk.waitReady({
      timeoutMs: config.readyTimeoutMs,
      activate: config.activateBridge,
      activationReason: 'ptk_playwright_smoke'
    });
    console.log('PTK bridge ready:', {
      version: bridgeInfo.version,
      capabilities: bridgeInfo.capabilities
    });

    const startResult = await ptk.startSession(startOptions);
    sessionStarted = true;
    config.scanStartedAt = Date.now();
    writeJsonArtifact('session_start.json', {
      status: 'started',
      startedAt: new Date(config.scanStartedAt).toISOString(),
      sessionId: startResult.sessionId,
      response: startResult
    });

    await runUserFlow(page, config);

    const preStopFindingResult = await waitForRequiredFindingGate(ptk, config);
    const progress = await waitForProgressEvidence(ptk, config.engines, config.progressTimeoutMs);
    const engineGate = helpers.evaluateEngineGate(progress, config.engines);

    writeJsonArtifact('progress-summary.json', progress);
    writeJsonArtifact('engine_gate.json', engineGate);

    const stopResult = await ptk.endSession({
      wait: true,
      includeFindings: true,
      limit: config.findingsLimit,
      immediateAnalysis: config.immediateAnalysis
    });
    sessionStarted = false;
    const finalFindingPayload = Array.isArray(stopResult.findings)
      ? { findings: stopResult.findings, truncated: stopResult.truncated === true }
      : preStopFindingResult.payload;
    const finalFindingGate = evaluateRequiredFindings(findingsFromPayload(finalFindingPayload), config.engines);

    writeJsonArtifact('findings.json', finalFindingPayload);
    writeJsonArtifact('finding_gate.json', finalFindingGate);
    writeJsonArtifact('scan_stop.json', {
      requestedImmediateAnalysis: config.immediateAnalysis,
      requestedStopWait: true,
      stopSucceeded: stopResult.ok !== false,
      stopResponse: stopResult
    });
    writeJsonArtifact('session_stats.json', stopResult.stats || (stopResult.summary && stopResult.summary.stats) || {});
    logFindingGate(finalFindingGate);

    let gateError = null;
    if (!engineGate.passed) {
      gateError = new Error(`Playwright engine gate failed: missing ${engineGate.missingEngines.join(', ')}`);
    } else if (!finalFindingGate.ok) {
      gateError = new Error(
        `Required Juice Shop findings were not all observed: ${missingRequirementDescriptions(finalFindingGate).join(', ')}`
      );
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
    if (sessionStarted && context) {
      try {
        const page = context.pages()[0];
        if (page) {
          const ptk = createPtkBridge(page);
          await ptk.endSession({ wait: true, immediateAnalysis: config.immediateAnalysis }).catch(() => {});
        }
      } catch (_) {}
    }
    throw error;
  } finally {
    writeJsonArtifact('framework-run.json', frameworkPayload(config, status, failureReason));
    if (context) await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
