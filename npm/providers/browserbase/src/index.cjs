'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createRequire } = require('module');
const {
  accountScopedOptions,
  definePrivateProperty,
  envValue,
  readCachedUpload,
  resolveAutomationZipArtifact,
  resultsDir,
  safeProviderErrorMessage,
  safeProviderMetadata,
  toNumber,
  validateOnlyEnabled,
  writeCachedUpload
} = require('../../_shared/src/index.cjs');

const API_BASE = 'https://api.browserbase.com';
const VALID_REGIONS = new Set(['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1']);

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
      'playwright or playwright-core is required for Browserbase Playwright sessions. Install it with "npm install -D playwright".'
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
      'puppeteer-core or puppeteer is required for Browserbase Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function loadSeleniumWebDriver(options = {}) {
  return options.seleniumWebDriver || loadProjectModule(
    'selenium-webdriver',
    'selenium-webdriver is required for Browserbase Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function requireFetchGlobals() {
  if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
    throw new Error('Browserbase provider helpers require Node.js fetch, FormData, and Blob globals. Use Node.js 18 or newer.');
  }
}

async function browserbaseFetch(pathname, requestOptions = {}, providerOptions = {}) {
  requireFetchGlobals();
  const env = providerOptions.env || process.env;
  const apiKey = providerOptions.apiKey || envValue(env, 'BROWSERBASE_API_KEY');
  if (!apiKey) throw new Error('BROWSERBASE_API_KEY is required.');

  const response = await fetch(`${providerOptions.apiBase || API_BASE}${pathname}`, {
    ...requestOptions,
    headers: {
      'X-BB-API-Key': apiKey,
      ...(requestOptions.headers || {})
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `Browserbase API ${pathname} failed with ${response.status}: ` +
      safeProviderErrorMessage(text, [apiKey])
    );
  }
  return payload;
}

async function resolveBrowserbaseExtensionId(options = {}) {
  const env = options.env || process.env;
  const explicit = options.extensionId || envValue(env, 'BROWSERBASE_EXTENSION_ID');
  if (explicit) return { extensionId: explicit, source: 'env' };

  const artifact = resolveAutomationZipArtifact(options);
  if (artifact.type !== 'zip' && artifact.format !== 'zip') {
    throw new Error('Browserbase requires a ZIP extension artifact.');
  }

  const apiKey = options.apiKey || envValue(env, 'BROWSERBASE_API_KEY');
  const cacheOptions = accountScopedOptions('browserbase', {
    apiBase: options.apiBase || API_BASE,
    apiKey,
    projectId: options.projectId || envValue(env, 'BROWSERBASE_PROJECT_ID'),
    region: options.region || envValue(env, 'BROWSERBASE_REGION')
  }, options);
  const cached = readCachedUpload('browserbase', artifact, cacheOptions);
  if (cached && cached.extensionId) return { ...cached, artifact, source: 'cache' };

  requireFetchGlobals();
  const form = new FormData();
  form.set(
    'file',
    new Blob([fs.readFileSync(artifact.path)], { type: 'application/zip' }),
    path.basename(artifact.path)
  );

  const extension = await browserbaseFetch('/v1/extensions', {
    method: 'POST',
    body: form
  }, options);
  const extensionId = extension.id;
  if (!extensionId) throw new Error('Browserbase extension upload did not return an id.');

  const cachePayload = {
    extensionId,
    fileName: extension.fileName || path.basename(artifact.path),
    projectId: extension.projectId
  };
  writeCachedUpload('browserbase', artifact, cachePayload, cacheOptions);
  return { ...cachePayload, artifact, source: 'upload' };
}

function browserbaseRegion(options = {}) {
  const env = options.env || process.env;
  const region = options.region || envValue(env, 'BROWSERBASE_REGION');
  if (!region) return null;
  if (!VALID_REGIONS.has(region)) {
    throw new Error(`Invalid BROWSERBASE_REGION: ${region}. Expected one of: ${Array.from(VALID_REGIONS).join(', ')}`);
  }
  return region;
}

async function createBrowserbaseSession(extensionIdOrOptions, options = {}) {
  const sessionOptions = typeof extensionIdOrOptions === 'object' && extensionIdOrOptions !== null
    ? extensionIdOrOptions
    : {
        ...options,
        extensionId: extensionIdOrOptions
      };
  const env = sessionOptions.env || process.env;
  const extensionId = sessionOptions.extensionId || envValue(env, 'BROWSERBASE_EXTENSION_ID');
  if (!extensionId) throw new Error('Browserbase extensionId is required. Use resolveBrowserbaseExtensionId() first.');

  const body = {
    extensionId,
    timeout: toNumber(sessionOptions.timeoutSeconds || envValue(env, 'BROWSERBASE_TIMEOUT_SECONDS'), 900),
    userMetadata: {
      purpose: sessionOptions.purpose || 'ptk-browserbase-example',
      provider: 'browserbase',
      framework: sessionOptions.framework || 'unknown',
      ...(sessionOptions.userMetadata || {})
    }
  };
  const projectId = sessionOptions.projectId || envValue(env, 'BROWSERBASE_PROJECT_ID');
  const region = browserbaseRegion(sessionOptions);
  if (projectId) body.projectId = projectId;
  if (region) body.region = region;

  return browserbaseFetch('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, sessionOptions);
}

async function releaseBrowserbaseSession(sessionId, options = {}) {
  if (!sessionId) return null;
  return browserbaseFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'REQUEST_RELEASE' })
  }, options).catch((error) => {
    const env = options.env || process.env;
    console.warn(`Browserbase release failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'BROWSERBASE_API_KEY')
    ])}`);
    return null;
  });
}

function browserbaseHttpAgent(session) {
  if (!session.signingKey) throw new Error('Browserbase session did not return signingKey');
  const agent = new http.Agent({});
  const addRequest = http.Agent.prototype.addRequest;
  agent.addRequest = function addBrowserbaseRequest(request, options) {
    request.setHeader('x-bb-signing-key', session.signingKey);
    return addRequest.call(this, request, options);
  };
  return agent;
}

function browserbaseResultsDir(framework, options = {}) {
  return resultsDir('browserbase', framework, options);
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

async function createBrowserbaseSessionWithExtension(framework, options = {}) {
  const extension = options.extension && options.extension.extensionId
    ? options.extension
    : await resolveBrowserbaseExtensionId(options);
  const session = await createBrowserbaseSession({
    ...options,
    framework,
    extensionId: extension.extensionId
  });
  return { extension, session };
}

async function connectBrowserbasePlaywright(options = {}) {
  const { extension, session } = await createBrowserbaseSessionWithExtension('playwright', options);
  let browser;
  try {
    if (!session.connectUrl) throw new Error('Browserbase session did not return connectUrl.');
    const playwright = loadPlaywright(options);
    const chromium = options.chromium || playwright.chromium;
    browser = await chromium.connectOverCDP(session.connectUrl, options.connectOptions || {});
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('Browserbase session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    const connection = {
      extension,
      sessionInfo: safeProviderMetadata(session, [session.connectUrl, session.signingKey]),
      browser,
      context,
      page,
      framework: 'playwright',
      async close() {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
        await releaseBrowserbaseSession(session.id, options);
      }
    };
    return definePrivateProperty(connection, 'session', session);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserbaseSession(session.id, options);
    throw error;
  }
}

async function connectBrowserbasePuppeteer(options = {}) {
  const { extension, session } = await createBrowserbaseSessionWithExtension('puppeteer', options);
  let browser;
  try {
    if (!session.connectUrl) throw new Error('Browserbase session did not return connectUrl.');
    const puppeteer = loadPuppeteer(options);
    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      ...(options.connectOptions || {})
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => typeof candidate.isClosed !== 'function' || !candidate.isClosed()) || await browser.newPage();
    let closed = false;
    const connection = {
      extension,
      sessionInfo: safeProviderMetadata(session, [session.connectUrl, session.signingKey]),
      browser,
      page,
      framework: 'puppeteer',
      async close() {
        if (closed) return;
        closed = true;
        if (typeof browser.isConnected !== 'function' || browser.isConnected()) {
          await browser.close().catch(() => {});
        }
        await releaseBrowserbaseSession(session.id, options);
      }
    };
    return definePrivateProperty(connection, 'session', session);
  } catch (error) {
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      await browser.close().catch(() => {});
    }
    await releaseBrowserbaseSession(session.id, options);
    throw error;
  }
}

async function connectBrowserbaseSelenium(options = {}) {
  const { extension, session } = await createBrowserbaseSessionWithExtension('selenium', options);
  let driver;
  try {
    if (!session.seleniumRemoteUrl) throw new Error('Browserbase session did not return seleniumRemoteUrl.');
    const webdriver = loadSeleniumWebDriver(options);
    const builder = new webdriver.Builder()
      .forBrowser(options.browserName || envValue(options.env || process.env, 'BROWSERBASE_BROWSER_NAME', 'chrome'))
      .usingHttpAgent(browserbaseHttpAgent(session))
      .usingServer(session.seleniumRemoteUrl);
    if (options.capabilities && typeof options.capabilities === 'object') {
      builder.withCapabilities(options.capabilities);
    }
    driver = await builder.build();
    const scriptTimeoutMs = toNumber(
      options.scriptTimeoutMs || envValue(options.env || process.env, 'BROWSERBASE_SELENIUM_SCRIPT_TIMEOUT_MS'),
      120000
    );
    if (driver.manage && typeof driver.manage === 'function') {
      const manager = driver.manage();
      if (manager && typeof manager.setTimeouts === 'function') {
        await manager.setTimeouts({ script: scriptTimeoutMs });
      }
    }
    let closed = false;
    const connection = {
      extension,
      sessionInfo: safeProviderMetadata(session, [session.seleniumRemoteUrl, session.signingKey]),
      driver,
      framework: 'selenium',
      async close() {
        if (closed) return;
        closed = true;
        await driver.quit().catch(() => {});
        await releaseBrowserbaseSession(session.id, options);
      }
    };
    return definePrivateProperty(connection, 'session', session);
  } catch (error) {
    if (driver) await driver.quit().catch(() => {});
    await releaseBrowserbaseSession(session.id, options);
    throw error;
  }
}

function browserbaseValidationSummary(framework, options = {}) {
  const env = options.env || process.env;
  const explicitExtensionId = options.extensionId || envValue(env, 'BROWSERBASE_EXTENSION_ID');
  const artifact = explicitExtensionId ? null : resolveAutomationZipArtifact(options);
  return {
    ok: Boolean(options.apiKey || envValue(env, 'BROWSERBASE_API_KEY')),
    framework,
    targetUrl: options.targetUrl || envValue(env, 'PTK_PROVIDER_TARGET_URL') || envValue(env, 'JUICE_SHOP_URL') || null,
    resultsDir: browserbaseResultsDir(framework, options),
    credentialsConfigured: {
      apiKey: Boolean(options.apiKey || envValue(env, 'BROWSERBASE_API_KEY')),
      projectId: Boolean(options.projectId || envValue(env, 'BROWSERBASE_PROJECT_ID'))
    },
    browserbase: {
      extensionIdConfigured: Boolean(explicitExtensionId),
      willUploadExtensionIfRun: !explicitExtensionId,
      region: options.region || envValue(env, 'BROWSERBASE_REGION') || null,
      timeoutSeconds: toNumber(options.timeoutSeconds || envValue(env, 'BROWSERBASE_TIMEOUT_SECONDS'), 900)
    },
    extension: artifact
      ? {
          type: artifact.type,
          path: artifact.path,
          file: path.basename(artifact.path),
          size: artifact.size,
          version: artifact.version,
          manifestVersion: artifact.manifestVersion,
          automationEnabledDefault: artifact.automationEnabledDefault
        }
      : null
  };
}

module.exports = {
  VALID_REGIONS,
  browserbaseFetch,
  browserbaseHttpAgent,
  browserbaseResultsDir,
  browserbaseValidationSummary,
  connectBrowserbasePlaywright,
  connectBrowserbasePuppeteer,
  connectBrowserbaseSelenium,
  createBrowserbaseSession,
  releaseBrowserbaseSession,
  resolveBrowserbaseExtensionId,
  validateOnlyEnabled
};
