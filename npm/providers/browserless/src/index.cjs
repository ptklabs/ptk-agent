'use strict';

const path = require('path');
const { createRequire } = require('module');
const {
  envValue,
  listEnv,
  resultsDir,
  safeProviderMetadata,
  toNumber,
  validateOnlyEnabled
} = require('../../_shared/src/index.cjs');

const DEFAULT_ENDPOINT = 'wss://production-sfo.browserless.io';

function loadProjectModule(name, installHint) {
  try {
    return require(name);
  } catch (_) {
    try {
      return createRequire(path.join(process.cwd(), 'package.json'))(name);
    } catch (error) {
      throw new Error(installHint || `${name} is required. Install it in your project.`);
    }
  }
}

function loadPlaywright(options = {}) {
  if (options.playwright) return options.playwright;
  try {
    return loadProjectModule('playwright');
  } catch (_) {
    return loadProjectModule(
      'playwright-core',
      'playwright or playwright-core is required for Browserless Playwright sessions. Install it with "npm install -D playwright".'
    );
  }
}

function loadPuppeteer(options = {}) {
  if (options.puppeteer) return options.puppeteer;
  try {
    return loadProjectModule('puppeteer-core');
  } catch (_) {
    return loadProjectModule(
      'puppeteer',
      'puppeteer-core or puppeteer is required for Browserless Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function credentialsFromOptions(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || options.token || envValue(env, 'BROWSERLESS_API_KEY') || envValue(env, 'BROWSERLESS_TOKEN');
  if (!apiKey) throw new Error('BROWSERLESS_API_KEY or BROWSERLESS_TOKEN is required.');
  return { apiKey };
}

function normalizeList(value) {
  if (!value) return [];
  const input = Array.isArray(value) ? value : String(value).split(',');
  return input.map((item) => String(item || '').trim()).filter(Boolean);
}

function browserlessExtensionNames(options = {}) {
  const env = options.env || process.env;
  const names = [
    ...normalizeList(options.extensionNames),
    ...normalizeList(options.extensionName),
    ...normalizeList(options.extensionIds),
    ...normalizeList(options.extensionId),
    ...listEnv(env, 'BROWSERLESS_EXTENSION_NAME'),
    ...listEnv(env, 'BROWSERLESS_EXTENSION_NAMES'),
    ...listEnv(env, 'BROWSERLESS_EXTENSION_ID'),
    ...listEnv(env, 'BROWSERLESS_EXTENSION_IDS')
  ];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,99}$/.test(name)) {
      throw new Error('Browserless extension names must contain 1-99 letters, digits, underscores, or hyphens.');
    }
  }
  return Array.from(new Set(names));
}

function positiveInteger(value, sourceName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${sourceName} must resolve to a positive integer number of milliseconds.`);
  }
  return number;
}

function browserlessTimeoutMs(options = {}) {
  const env = options.env || process.env;
  if (options.timeoutMs !== undefined) return positiveInteger(options.timeoutMs, 'timeoutMs');
  if (envValue(env, 'BROWSERLESS_TIMEOUT_MS')) {
    return positiveInteger(envValue(env, 'BROWSERLESS_TIMEOUT_MS'), 'BROWSERLESS_TIMEOUT_MS');
  }
  if (options.timeoutSeconds !== undefined) return positiveInteger(Number(options.timeoutSeconds) * 1000, 'timeoutSeconds');
  if (envValue(env, 'BROWSERLESS_TIMEOUT_SECONDS')) {
    return positiveInteger(Number(envValue(env, 'BROWSERLESS_TIMEOUT_SECONDS')) * 1000, 'BROWSERLESS_TIMEOUT_SECONDS');
  }
  return 60000;
}

function browserlessConnectTimeoutMs(timeoutMs, options = {}) {
  const env = options.env || process.env;
  const configured = options.connectTimeoutMs || envValue(env, 'BROWSERLESS_CONNECT_TIMEOUT_MS');
  return configured ? positiveInteger(configured, 'BROWSERLESS_CONNECT_TIMEOUT_MS') : timeoutMs + 30000;
}

function parseJsonEnv(env, name, fallback = {}) {
  const raw = envValue(env, name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function browserlessLaunchOptions(options = {}) {
  const env = options.env || process.env;
  const extensionNames = browserlessExtensionNames(options);
  if (!extensionNames.length) {
    throw new Error('BROWSERLESS_EXTENSION_NAME is required for Browserless PTK sessions with an uploaded extension.');
  }
  return {
    ...parseJsonEnv(env, 'BROWSERLESS_LAUNCH_JSON', {}),
    ...(options.launch || {}),
    ...(options.launchOptions || {}),
    extensions: extensionNames
  };
}

function browserlessWsEndpoint(options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions({ ...options, env });
  const endpoint = options.endpoint || envValue(env, 'BROWSERLESS_ENDPOINT', DEFAULT_ENDPOINT);
  const timeoutMs = browserlessTimeoutMs({ ...options, env });
  const connectTimeoutMs = browserlessConnectTimeoutMs(timeoutMs, { ...options, env });
  const launch = browserlessLaunchOptions({ ...options, env });
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:') {
    throw new Error('BROWSERLESS_ENDPOINT must use wss://.');
  }
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (!['/', '/chromium'].includes(route)) {
    throw new Error('Browserless PTK automation supports only the Chromium CDP root or /chromium endpoint.');
  }
  url.searchParams.set('token', credentials.apiKey);
  url.searchParams.set('timeout', String(timeoutMs));
  url.searchParams.set('launch', JSON.stringify(launch));
  return {
    wsEndpoint: url.toString(),
    endpoint,
    launch,
    timeoutMs,
    connectTimeoutMs,
    extensionNames: Array.isArray(launch.extensions) ? launch.extensions.slice() : []
  };
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

async function connectBrowserlessPlaywright(options = {}) {
  const endpoint = browserlessWsEndpoint(options);
  const playwright = loadPlaywright(options);
  const chromium = options.chromium || playwright.chromium;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint.wsEndpoint, {
      timeout: endpoint.connectTimeoutMs,
      ...(options.connectOptions || {})
    });
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('Browserless session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    return {
      browser,
      context,
      page,
      endpoint: safeProviderMetadata({
        endpoint: endpoint.endpoint,
        launch: endpoint.launch,
        timeoutMs: endpoint.timeoutMs,
        connectTimeoutMs: endpoint.connectTimeoutMs,
        extensionNames: endpoint.extensionNames
      }),
      framework: 'playwright',
      async close() {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
      }
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  }
}

async function connectBrowserlessPuppeteer(options = {}) {
  const endpoint = browserlessWsEndpoint(options);
  const puppeteer = loadPuppeteer(options);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint.wsEndpoint,
      ...(options.connectOptions || {})
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => typeof candidate.isClosed !== 'function' || !candidate.isClosed()) || await browser.newPage();
    let closed = false;
    return {
      browser,
      page,
      endpoint: safeProviderMetadata({
        endpoint: endpoint.endpoint,
        launch: endpoint.launch,
        timeoutMs: endpoint.timeoutMs,
        connectTimeoutMs: endpoint.connectTimeoutMs,
        extensionNames: endpoint.extensionNames
      }),
      framework: 'puppeteer',
      async close() {
        if (closed) return;
        closed = true;
        if (typeof browser.isConnected !== 'function' || browser.isConnected()) {
          await browser.close().catch(() => {});
        }
      }
    };
  } catch (error) {
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
}

function browserlessResultsDir(framework, options = {}) {
  return resultsDir('browserless', framework, options);
}

function browserlessValidationSummary(framework, options = {}) {
  const env = options.env || process.env;
  const extensionNames = browserlessExtensionNames({ ...options, env });
  const normalizedFramework = String(framework || '').trim().toLowerCase();
  const frameworkSupported = ['playwright', 'puppeteer'].includes(normalizedFramework);
  return {
    ok: Boolean(options.apiKey || options.token || envValue(env, 'BROWSERLESS_API_KEY') || envValue(env, 'BROWSERLESS_TOKEN')) &&
      extensionNames.length > 0 && frameworkSupported,
    framework,
    targetUrl: options.targetUrl || envValue(env, 'PTK_PROVIDER_TARGET_URL') || envValue(env, 'JUICE_SHOP_URL') || null,
    resultsDir: browserlessResultsDir(framework, options),
    credentialsConfigured: {
      apiKey: Boolean(options.apiKey || options.token || envValue(env, 'BROWSERLESS_API_KEY') || envValue(env, 'BROWSERLESS_TOKEN'))
    },
    browserless: {
      endpoint: options.endpoint || envValue(env, 'BROWSERLESS_ENDPOINT', DEFAULT_ENDPOINT),
      extensionNamesConfigured: extensionNames.length > 0,
      frameworkSupported,
      unsupportedReason: frameworkSupported
        ? null
        : 'Browserless v2 does not expose Selenium/WebDriver; PTK extensions require Chromium CDP through Playwright or Puppeteer.',
      timeoutMs: toNumber(options.timeoutMs || envValue(env, 'BROWSERLESS_TIMEOUT_MS'), browserlessTimeoutMs({ ...options, env }))
    }
  };
}

module.exports = {
  browserlessConnectTimeoutMs,
  browserlessExtensionNames,
  browserlessLaunchOptions,
  browserlessResultsDir,
  browserlessTimeoutMs,
  browserlessValidationSummary,
  browserlessWsEndpoint,
  connectBrowserlessPlaywright,
  connectBrowserlessPuppeteer,
  credentialsFromOptions,
  validateOnlyEnabled
};
