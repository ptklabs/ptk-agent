#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');
const runtimeRequire = process.env.PTK_RELEASE_TEST_MODE === 'package' && process.env.PTK_PACKAGE_ROOT
  ? createRequire(path.join(process.env.PTK_PACKAGE_ROOT, 'package.json'))
  : require;
const { Builder, By, Key } = runtimeRequire('selenium-webdriver');
const chrome = runtimeRequire('selenium-webdriver/chrome');
const edge = runtimeRequire('selenium-webdriver/edge');
const firefox = runtimeRequire('selenium-webdriver/firefox');
const helpers = require('../../../scripts/framework-smoke-helpers.cjs');

const {
  env,
  evaluateRequiredFindings,
  frameworkPayload,
  findingsFromPayload,
  logFindingGate,
  missingRequirementDescriptions,
  normalizeEngines,
  requireSmokeCredentials,
  toBoolean,
  toOptionalBoolean,
  waitForProgressEvidence,
  waitForRequiredFindingGate,
  writeJsonArtifact
} = helpers;

function loadPtkSelenium() {
  const packageRoot = process.env.PTK_PACKAGE_ROOT;
  if (process.env.PTK_RELEASE_TEST_MODE === 'package' && packageRoot) {
    return require(path.join(packageRoot, 'frameworks', 'selenium', 'index.cjs'));
  }
  try {
    return require('pentestkit/selenium');
  } catch (_) {
    return require('../src/index.cjs');
  }
}

function readConfig() {
  const browser = env('PTK_BROWSER', 'chrome');
  const extensionPath = env('PTK_EXTENSION_PATH') || env('PTK_EXTENSION_DIR');
  const extensionXpiPath = env('PTK_EXTENSION_XPI_PATH') || env('PTK_FIREFOX_XPI');
  if (browser === 'firefox' && !extensionXpiPath) {
    throw new Error('Set PTK_EXTENSION_XPI_PATH to the packaged Firefox PTK extension.')
  }
  if (browser !== 'firefox' && !extensionPath) {
    throw new Error('Set PTK_EXTENSION_PATH to the unpacked PTK extension directory.')
  }
  const profileDir = env('PTK_PROFILE_DIR') || fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-selenium-smoke-'));
  return {
    framework: 'selenium',
    startedAt: new Date().toISOString(),
    sdkRoot: path.resolve(__dirname, '..'),
    baseUrl: env('JUICE_SHOP_URL', 'http://localhost:3001').replace(/\/$/, ''),
    browser,
    project: env('PTK_PROJECT', 'juice-shop-selenium-smoke'),
    engines: normalizeEngines(env('PTK_ENGINES', 'DAST,IAST,SAST,SCA')),
    policyCode: env('PTK_POLICY_CODE'),
    extensionPath: extensionPath ? path.resolve(extensionPath) : null,
    extensionXpiPath: extensionXpiPath ? path.resolve(extensionXpiPath) : null,
    profileDir: path.resolve(profileDir),
    executablePath: env('PTK_SELENIUM_EXECUTABLE_PATH') || env('PTK_EXECUTABLE_PATH') || (browser === 'firefox' ? env('PTK_FIREFOX_BINARY') : env('PTK_CHROME_BINARY')),
    headless: toBoolean(env('PTK_HEADLESS'), false),
    activateBridge: toBoolean(env('PTK_BRIDGE_ACTIVATE'), false),
    immediateAnalysis: toOptionalBoolean(env('PTK_IMMEDIATE_ANALYSIS')),
    loginEmail: env('PTK_LOGIN_EMAIL', env('PTK_JUICE_USERNAME', 'YOUR_USERNAME')),
    loginPassword: env('PTK_LOGIN_PASSWORD', env('PTK_JUICE_PASSWORD', 'YOUR_PASSWORD')),
    searchTerm: env('PTK_SEARCH_TERM', 'test'),
    readyTimeoutMs: Number(env('PTK_READY_TIMEOUT_MS', '30000')),
    progressTimeoutMs: Number(env('PTK_PROGRESS_TIMEOUT_MS', '60000')),
    minScanSeconds: Number(env('PTK_MIN_SCAN_SECONDS', '30')),
    requiredFindingsTimeoutSeconds: Number(env('PTK_REQUIRED_FINDINGS_TIMEOUT', env('PTK_MAX_SCAN_SECONDS', '300'))),
    findingsLimit: Number(env('PTK_FINDINGS_LIMIT', '500'))
  };
}

function chromeArguments(config) {
  const args = [
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
    `--user-data-dir=${config.profileDir}`,
    `--disable-extensions-except=${config.extensionPath}`,
    `--load-extension=${config.extensionPath}`
  ];
  if (config.headless) args.push('--headless=new');
  return args;
}

async function launchDriver(config) {
  fs.mkdirSync(config.profileDir, { recursive: true });

  if (config.browser === 'firefox') {
    if (!config.extensionXpiPath || !fs.existsSync(config.extensionXpiPath)) {
      throw new Error(`PTK Firefox XPI not found: ${config.extensionXpiPath}`)
    }
    const options = new firefox.Options()
      .addArguments('-profile', config.profileDir, '-no-remote')
      .setPreference('browser.shell.checkDefaultBrowser', false)
      .setPreference('browser.startup.homepage_override.mstone', 'ignore')
      .setPreference('toolkit.telemetry.reportingpolicy.firstRun', false)
      .setPreference('datareporting.policy.dataSubmissionEnabled', false)
      .setPreference('extensions.autoDisableScopes', 0)
      .setPreference('extensions.enabledScopes', 15)
      .setPreference('extensions.webextensions.restrictedDomains', '')
      .setPreference('extensions.webextensions.uuids', JSON.stringify({
        'pentestkit@DenisPodgurskii': env('PTK_FIREFOX_EXTENSION_UUID', '7b4b556d-55d0-4db7-bf08-7c1ec1a0f5c5'),
        'ptk-automation-agent@ptklabs.com': env('PTK_FIREFOX_EXTENSION_UUID', '7b4b556d-55d0-4db7-bf08-7c1ec1a0f5c5')
      }))
      .setPreference('xpinstall.signatures.required', false)
    if (config.executablePath) options.setBinary(config.executablePath)
    if (config.headless) options.addArguments('-headless')
    const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build()
    await driver.installAddon(config.extensionXpiPath, true)
    await driver.manage().setTimeouts({
      implicit: 0,
      pageLoad: Number(env('PTK_SELENIUM_PAGELOAD_TIMEOUT_MS', '45000')),
      script: Number(env('PTK_SELENIUM_SCRIPT_TIMEOUT_MS', '300000'))
    })
    return {
      driver,
      launchArgs: ['-profile', config.profileDir, '-no-remote', ...(config.headless ? ['-headless'] : [])]
    }
  }

  if (!config.extensionPath || !fs.existsSync(config.extensionPath)) {
    throw new Error(`PTK extension directory not found: ${config.extensionPath}`);
  }

  const browser = config.browser === 'edge' ? 'MicrosoftEdge' : 'chrome';
  const options = config.browser === 'edge' ? new edge.Options() : new chrome.Options();
  for (const arg of chromeArguments(config)) options.addArguments(arg);
  if (config.executablePath && typeof options.setChromeBinaryPath === 'function') {
    options.setChromeBinaryPath(config.executablePath);
  } else if (config.executablePath && typeof options.setBinaryPath === 'function') {
    options.setBinaryPath(config.executablePath);
  }

  let builder = new Builder().forBrowser(browser);
  if (config.browser === 'edge') {
    builder = builder.setEdgeOptions(options);
  } else {
    builder = builder.setChromeOptions(options);
  }
  const driver = await builder.build();
  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: Number(env('PTK_SELENIUM_PAGELOAD_TIMEOUT_MS', '45000')),
    script: Number(env('PTK_SELENIUM_SCRIPT_TIMEOUT_MS', '300000'))
  });
  return { driver, launchArgs: chromeArguments(config) };
}

async function displayedElements(driver, selector) {
  const elements = await driver.findElements(By.css(selector)).catch(() => []);
  const out = [];
  for (const element of elements) {
    if (await element.isDisplayed().catch(() => false)) out.push(element);
  }
  return out;
}

async function waitForAnyDisplayed(driver, selectors, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const elements = await displayedElements(driver, selector);
      if (elements.length > 0) return elements;
    }
    await driver.sleep(500);
  }
  return [];
}

async function clickIfPresent(driver, selectors) {
  for (const selector of selectors) {
    const elements = await displayedElements(driver, selector);
    for (const element of elements) {
      try {
        await element.click();
        return true;
      } catch (_) {
        // Try the next element.
      }
    }
  }
  return false;
}

async function clickRequired(driver, selectors, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const selector of selectors) {
      const elements = await displayedElements(driver, selector);
      for (const element of elements) {
        try {
          await element.click();
          return;
        } catch (_) {
          // Try the next element.
        }
      }
    }
    await dismissOverlays(driver);
    await driver.sleep(500);
  }
  throw new Error(`Could not locate ${label}. Tried: ${selectors.join(', ')}`);
}

async function typeRequired(driver, selectors, value, label) {
  for (const selector of selectors) {
    const elements = await displayedElements(driver, selector);
    for (const element of elements) {
      try {
        await element.click();
        await element.clear().catch(() => {});
        await element.sendKeys(String(value));
        return;
      } catch (_) {
        // Try the next element.
      }
    }
  }
  throw new Error(`Could not locate ${label}. Tried: ${selectors.join(', ')}`);
}

async function dismissOverlays(driver) {
  await clickIfPresent(driver, [
    '.cdk-overlay-backdrop.cdk-overlay-backdrop-showing',
    "button[aria-label='Close Welcome Banner']",
    "button[aria-label='close Welcome Banner']",
    "button[aria-label='Close Dialog']",
    '.close-dialog',
    'mat-dialog-container button'
  ]);
  await clickIfPresent(driver, [
    "a[aria-label='dismiss cookie message']",
    "button[aria-label='dismiss cookie message']",
    '.cc-dismiss'
  ]);
}

async function executeAsync(driver, script, arg) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const arg = arguments[0];
    Promise.resolve()
      .then(() => (${script})(arg))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({
        ok: false,
        error: error && error.message ? error.message : String(error)
      }));
  `, arg).then((result) => {
    if (result && result.ok === false) throw new Error(result.error || 'executeAsync failed');
    return result ? result.value : result;
  });
}

async function ensureSmokeUser(driver, config) {
  requireSmokeCredentials(config);
  await driver.get(`${config.baseUrl}/`);
  const status = await executeAsync(driver, async ({ root, email, password }) => {
    const response = await fetch(`${root}/api/Users/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        passwordRepeat: password,
        securityQuestion: {
          id: 2,
          question: "Mother's maiden name?"
        },
        securityAnswer: 'ptk'
      })
    });
    return response.status;
  }, {
    root: config.baseUrl,
    email: config.loginEmail,
    password: config.loginPassword
  });
  if (![200, 201, 400, 409].includes(Number(status))) {
    throw new Error(`Could not prepare Juice Shop smoke user. Status: ${status}`);
  }
  console.log(`Smoke user fixture status: ${status}`);
}

async function clearSiteState(driver, config) {
  await driver.get(`${config.baseUrl}/`);
  await driver.manage().deleteAllCookies().catch(() => {});
  await driver.executeScript('window.localStorage.clear(); window.sessionStorage.clear();').catch(() => {});
}

async function waitForLoginSuccess(driver, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const profileSelectors = [
    "[aria-label='Go to user profile']",
    "a[aria-label='Go to user profile']",
    "button[aria-label='Go to user profile']",
    '#navbarUser',
    "button[id='navbarUser']"
  ];
  while (Date.now() < deadline) {
    const url = await driver.getCurrentUrl();
    if (!url.toLowerCase().includes('login')) return true;
    await clickIfPresent(driver, [
      '#navbarAccount',
      "button[aria-label='Show/hide account menu']",
      "button[aria-label*='Account']"
    ]);
    for (const selector of profileSelectors) {
      if ((await displayedElements(driver, selector)).length > 0) return true;
    }
    await driver.sleep(500);
  }
  return false;
}

async function runLoginFlow(driver, config) {
  await driver.get(`${config.baseUrl}/#/login`);
  await dismissOverlays(driver);
  await typeRequired(driver, [
    '#email',
    'input#emailControl',
    "input[formcontrolname='email']",
    "input[type='email']"
  ], config.loginEmail, 'email input');
  await typeRequired(driver, [
    '#password',
    'input#passwordControl',
    "input[formcontrolname='password']",
    "input[type='password']"
  ], config.loginPassword, 'password input');
  await clickRequired(driver, [
    '#loginButton',
    'button#loginButton',
    "button[type='submit']"
  ], 'login submit button');
  await driver.actions().sendKeys(Key.ENTER).perform().catch(() => {});
  if (!await waitForLoginSuccess(driver, 15000)) {
    throw new Error('Login did not complete. Verify PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD or the Juice Shop fixture user setup.');
  }
}

async function exerciseJwtCookieSurface(driver, config) {
  const statuses = await executeAsync(driver, async (root) => {
    const results = await Promise.allSettled([
      fetch(`${root}/rest/user/whoami`, { credentials: 'include' }),
      fetch(`${root}/profile`, { credentials: 'include' })
    ]);
    return results.map((result) => result.status === 'fulfilled' ? result.value.status : 0);
  }, config.baseUrl).catch(() => []);
  console.log(`JWT cookie surface exercised: ${statuses.join(', ')}`);
}

async function goHome(driver, config) {
  await driver.get(`${config.baseUrl}/#/`);
  await dismissOverlays(driver);
  await waitForAnyDisplayed(driver, [
    "button[aria-label='Add to Basket']",
    '.mat-grid-tile',
    'mat-grid-tile'
  ], 15000);
}

async function clearBasket(driver, config) {
  await driver.get(`${config.baseUrl}/#/basket`);
  for (let index = 0; index < 40; index += 1) {
    const removed = await driver.executeScript(`
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
    `).catch(() => false);
    if (!removed) break;
    await driver.sleep(300);
  }
  await goHome(driver, config);
}

async function addProductsToBasket(driver, count) {
  await dismissOverlays(driver);
  for (let index = 0; index < count; index += 1) {
    const buttons = await waitForAnyDisplayed(driver, ["button[aria-label='Add to Basket']"], 15000);
    if (buttons.length <= index) {
      throw new Error(`Could not locate Add to Basket button ${index + 1}`);
    }
    try {
      await buttons[index].click();
    } catch (_) {
      await dismissOverlays(driver);
      await driver.executeScript('arguments[0].click();', buttons[index]);
    }
    await driver.sleep(300);
  }
}

async function removeOneItemFromBasket(driver, config) {
  await driver.get(`${config.baseUrl}/#/basket`);
  for (let index = 0; index < 30; index += 1) {
    const clicked = await driver.executeScript(`
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
    `).catch(() => false);
    if (clicked) return;
    await driver.sleep(500);
  }
  throw new Error('Could not locate remove item button in basket');
}

async function searchFor(driver, config) {
  await goHome(driver, config);
  try {
    await clickRequired(driver, [
      "button[aria-label='Search']",
      '.mat-search_icon-search',
      "button[aria-label*='Search']"
    ], 'search button');
    await typeRequired(driver, [
      'input#searchQuery',
      '#searchQuery input',
      "input[id^='mat-input-']",
      "input[placeholder*='Search']",
      "input[aria-label='Search']",
      "input[type='search']"
    ], config.searchTerm, 'search input');
    await driver.actions().sendKeys(Key.ENTER).perform();
  } catch (error) {
    console.log(`Search control fallback: ${error.message}`);
    await driver.get(`${config.baseUrl}/#/search?q=${encodeURIComponent(config.searchTerm)}`);
  }
  await driver.sleep(1500);
}

async function runUserFlow(driver, config) {
  await clearSiteState(driver, config);
  await ensureSmokeUser(driver, config);
  await goHome(driver, config);
  await runLoginFlow(driver, config);
  await driver.get(`${config.baseUrl}/#/profile`);
  await driver.sleep(1000);
  await exerciseJwtCookieSurface(driver, config);
  await goHome(driver, config);
  await clearBasket(driver, config);
  await addProductsToBasket(driver, 2);
  await removeOneItemFromBasket(driver, config);
  await searchFor(driver, config);
}

async function main() {
  const config = readConfig();
  const { armPtkIastForNavigation, createSeleniumPtkBridge } = loadPtkSelenium();
  let driver = null;
  let status = 'failed';
  let failureReason = null;
  let sessionStarted = false;

  writeJsonArtifact('framework-run.json', frameworkPayload(config, 'started'));

  try {
    const launched = await launchDriver(config);
    driver = launched.driver;
    const capabilities = await driver.getCapabilities();
    writeJsonArtifact('browser-launch.json', {
      browserName: config.browser,
      browserVersion: capabilities.get('browserVersion') || capabilities.get('version') || null,
      executablePath: config.executablePath || null,
      headless: config.headless,
      extensionPath: config.extensionPath,
      extensionXpiPath: config.extensionXpiPath,
      profileMode: config.browser === 'firefox' ? 'temporary-xpi' : 'user-data-dir',
      profileDir: config.profileDir,
      launchArgs: launched.launchArgs,
      targetUrl: config.baseUrl
    });

    const startOptions = {
      project: config.project,
      engines: config.engines,
      policyCode: config.policyCode
    };
    const armResult = await armPtkIastForNavigation(driver, {
      browser: config.browser,
      targetUrl: `${config.baseUrl}/`,
      scanOptions: startOptions,
      extensionPath: config.extensionPath,
      timeoutMs: config.readyTimeoutMs
    });
    if (config.engines.includes('IAST') && !armResult.ok) {
      throw new Error(`PTK IAST pre-navigation arm failed: ${JSON.stringify(armResult)}`);
    }
    console.log('PTK IAST pre-navigation arm:', armResult);
    await driver.get(`${config.baseUrl}/`);
    const ptk = createSeleniumPtkBridge(driver);
    const bridgeInfo = await ptk.waitReady({
      timeoutMs: config.readyTimeoutMs,
      activate: config.activateBridge,
      activationReason: 'ptk_selenium_smoke'
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

    await runUserFlow(driver, config);

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
      gateError = new Error(`Selenium engine gate failed: missing ${engineGate.missingEngines.join(', ')}`);
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
    if (sessionStarted && driver) {
      try {
        const ptk = createSeleniumPtkBridge(driver);
        await ptk.endSession({ wait: true, immediateAnalysis: config.immediateAnalysis }).catch(() => {});
      } catch (_) {}
    }
    throw error;
  } finally {
    writeJsonArtifact('framework-run.json', frameworkPayload(config, status, failureReason));
    if (driver) await driver.quit().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
