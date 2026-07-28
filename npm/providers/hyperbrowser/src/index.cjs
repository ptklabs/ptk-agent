'use strict';

const https = require('https');
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

const DEFAULT_API_BASE = 'https://api.hyperbrowser.ai';
const MAX_EXTENSION_BYTES = 8 * 1024 * 1024;

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
      'playwright or playwright-core is required for Hyperbrowser Playwright sessions. Install it with "npm install -D playwright".'
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
      'puppeteer-core or puppeteer is required for Hyperbrowser Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function loadSeleniumWebDriver(options = {}) {
  return options.seleniumWebDriver || loadProjectModule(
    'selenium-webdriver',
    'selenium-webdriver is required for Hyperbrowser Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function loadSeleniumChrome(options = {}) {
  return options.seleniumChrome || loadProjectModule(
    'selenium-webdriver/chrome',
    'selenium-webdriver/chrome is required for Hyperbrowser Selenium sessions. Install selenium-webdriver.'
  );
}

function loadHyperbrowserSdk(options = {}) {
  if (options.Hyperbrowser) return options.Hyperbrowser;
  const mod = loadProjectModule(
    '@hyperbrowser/sdk',
    '@hyperbrowser/sdk is required for Hyperbrowser sessions. Install it with "npm install -D @hyperbrowser/sdk".'
  );
  return mod.Hyperbrowser || mod.default || mod;
}

function hyperbrowserCredentials(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY');
  if (!apiKey) throw new Error('HYPERBROWSER_API_KEY is required.');
  return { apiKey };
}

function createHyperbrowserClient(options = {}) {
  if (options.client) return options.client;
  const env = options.env || process.env;
  const { apiKey } = hyperbrowserCredentials({ ...options, env });
  const Hyperbrowser = loadHyperbrowserSdk(options);
  const config = {
    ...(options.clientOptions || {}),
    apiKey
  };
  const baseUrl = options.baseUrl || envValue(env, 'HYPERBROWSER_BASE_URL');
  const timeout = options.requestTimeoutMs || envValue(env, 'HYPERBROWSER_REQUEST_TIMEOUT_MS');
  if (baseUrl) config.baseUrl = baseUrl;
  if (timeout) config.timeout = toNumber(timeout, 30000);
  return new Hyperbrowser(config);
}

function assertHyperbrowserExtensionArtifact(artifact) {
  if (!artifact || (artifact.type !== 'zip' && artifact.format !== 'zip')) {
    throw new Error('Hyperbrowser requires a Chromium ZIP extension artifact.');
  }
  if (!Number.isFinite(Number(artifact.size)) || Number(artifact.size) < 1) {
    throw new Error('Hyperbrowser extension artifact size is unavailable.');
  }
  if (Number(artifact.size) > MAX_EXTENSION_BYTES) {
    throw new Error(`Hyperbrowser extension uploads must be 8 MB or smaller; received ${artifact.size} bytes.`);
  }
  return artifact;
}

function extensionIdFromResponse(response) {
  return response && (response.id || response.extensionId || response.extension_id);
}

async function resolveHyperbrowserExtensionId(client, options = {}) {
  const env = options.env || process.env;
  const explicit = options.extensionId || envValue(env, 'HYPERBROWSER_EXTENSION_ID');
  if (explicit) return { extensionId: explicit, source: 'env' };
  if (!client || !client.extensions || typeof client.extensions.create !== 'function') {
    throw new Error('A Hyperbrowser SDK client with extensions.create() is required.');
  }

  const artifact = assertHyperbrowserExtensionArtifact(resolveAutomationZipArtifact(options));
  const { apiKey } = hyperbrowserCredentials({ ...options, env });
  const cacheOptions = accountScopedOptions('hyperbrowser', {
    apiKey,
    baseUrl: options.baseUrl || envValue(env, 'HYPERBROWSER_BASE_URL', DEFAULT_API_BASE)
  }, options);
  const cached = readCachedUpload('hyperbrowser', artifact, cacheOptions);
  if (cached && cached.extensionId) return { ...cached, artifact, source: 'cache' };

  let uploaded;
  try {
    uploaded = await client.extensions.create({
      filePath: artifact.path,
      name: options.extensionName || envValue(env, 'HYPERBROWSER_EXTENSION_NAME', 'OWASP PTK Automation')
    });
  } catch (error) {
    throw new Error(`Hyperbrowser extension upload failed: ${safeProviderErrorMessage(error, [apiKey])}`);
  }
  const extensionId = extensionIdFromResponse(uploaded);
  if (!extensionId) throw new Error('Hyperbrowser extension upload did not return an extension id.');

  const cachePayload = {
    extensionId,
    name: uploaded.name || options.extensionName || 'OWASP PTK Automation'
  };
  writeCachedUpload('hyperbrowser', artifact, cachePayload, cacheOptions);
  return { ...cachePayload, artifact, source: 'upload' };
}

function hyperbrowserSessionOptions(extensionId, options = {}) {
  const supplied = options.sessionOptions && typeof options.sessionOptions === 'object'
    ? options.sessionOptions
    : {};
  const extensionIds = [
    ...(Array.isArray(supplied.extensionIds) ? supplied.extensionIds : []),
    ...(Array.isArray(extensionId) ? extensionId : [extensionId])
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return {
    ...supplied,
    extensionIds: Array.from(new Set(extensionIds))
  };
}

async function createHyperbrowserSessionWithExtension(options = {}) {
  const client = createHyperbrowserClient(options);
  const extension = options.extension && options.extension.extensionId
    ? options.extension
    : await resolveHyperbrowserExtensionId(client, options);
  if (!client.sessions || typeof client.sessions.create !== 'function') {
    throw new Error('A Hyperbrowser SDK client with sessions.create() is required.');
  }
  try {
    const session = await client.sessions.create(hyperbrowserSessionOptions(extension.extensionId, options));
    if (!session || !session.id) throw new Error('Hyperbrowser session creation did not return an id.');
    return { client, extension, session };
  } catch (error) {
    const env = options.env || process.env;
    throw new Error(`Hyperbrowser session creation failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY')
    ])}`);
  }
}

async function stopHyperbrowserSession(client, session, options = {}) {
  if (!client || !session || !session.id || !client.sessions || typeof client.sessions.stop !== 'function') return;
  try {
    await client.sessions.stop(session.id);
  } catch (error) {
    const env = options.env || process.env;
    console.warn(`Hyperbrowser session stop failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'),
      session.token,
      session.wsEndpoint,
      session.webdriverEndpoint
    ])}`);
  }
}

function hyperbrowserSessionInfo(session, options = {}) {
  const env = options.env || process.env;
  return safeProviderMetadata(session, [
    options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'),
    session && session.token,
    session && session.wsEndpoint,
    session && session.webdriverEndpoint
  ]);
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

async function connectHyperbrowserPlaywright(options = {}) {
  const cloud = await createHyperbrowserSessionWithExtension(options);
  let browser;
  try {
    if (!cloud.session.wsEndpoint) throw new Error('Hyperbrowser session did not return wsEndpoint.');
    const playwright = loadPlaywright(options);
    const chromium = options.chromium || playwright.chromium;
    browser = await chromium.connectOverCDP(cloud.session.wsEndpoint, options.connectOptions || {});
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('Hyperbrowser session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    const connection = {
      extension: cloud.extension,
      sessionInfo: hyperbrowserSessionInfo(cloud.session, options),
      browser,
      context,
      page,
      framework: 'playwright',
      async close() {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
        await stopHyperbrowserSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await stopHyperbrowserSession(cloud.client, cloud.session, options);
    const env = options.env || process.env;
    throw new Error(`Hyperbrowser Playwright connection failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'),
      cloud.session.token,
      cloud.session.wsEndpoint
    ])}`);
  }
}

async function connectHyperbrowserPuppeteer(options = {}) {
  const cloud = await createHyperbrowserSessionWithExtension(options);
  let browser;
  try {
    if (!cloud.session.wsEndpoint) throw new Error('Hyperbrowser session did not return wsEndpoint.');
    const puppeteer = loadPuppeteer(options);
    browser = await puppeteer.connect({
      browserWSEndpoint: cloud.session.wsEndpoint,
      defaultViewport: null,
      ...(options.connectOptions || {})
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => typeof candidate.isClosed !== 'function' || !candidate.isClosed()) || await browser.newPage();
    let closed = false;
    const connection = {
      extension: cloud.extension,
      sessionInfo: hyperbrowserSessionInfo(cloud.session, options),
      browser,
      page,
      framework: 'puppeteer',
      async close() {
        if (closed) return;
        closed = true;
        if (typeof browser.isConnected !== 'function' || browser.isConnected()) {
          await browser.close().catch(() => {});
        }
        await stopHyperbrowserSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      await browser.close().catch(() => {});
    }
    await stopHyperbrowserSession(cloud.client, cloud.session, options);
    const env = options.env || process.env;
    throw new Error(`Hyperbrowser Puppeteer connection failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'),
      cloud.session.token,
      cloud.session.wsEndpoint
    ])}`);
  }
}

function hyperbrowserHttpAgent(session) {
  if (!session || !session.webdriverEndpoint) throw new Error('Hyperbrowser session did not return webdriverEndpoint.');
  if (!session.token) throw new Error('Hyperbrowser session did not return its WebDriver token.');
  const endpoint = new URL(session.webdriverEndpoint);
  if (endpoint.protocol !== 'https:') {
    throw new Error('Hyperbrowser webdriverEndpoint must use https:// so its session token is not sent over an insecure connection.');
  }
  const Agent = https.Agent;
  const agent = new Agent({});
  const addRequest = Agent.prototype.addRequest;
  agent.addRequest = function addHyperbrowserRequest(request, requestOptions) {
    request.setHeader('x-hyperbrowser-token', session.token);
    return addRequest.call(this, request, requestOptions);
  };
  return agent;
}

function isHyperbrowserSeleniumReadinessError(error) {
  return /selenium server not ready after \d+s/i.test(String(error && error.message || error || ''));
}

async function createHyperbrowserSeleniumDriver(session, options = {}) {
  const webdriver = loadSeleniumWebDriver(options);
  const chrome = loadSeleniumChrome(options);
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const builder = new webdriver.Builder()
      .forBrowser(options.browserName || envValue(options.env || process.env, 'HYPERBROWSER_BROWSER_NAME', 'chrome'))
      .usingHttpAgent(hyperbrowserHttpAgent(session))
      .usingServer(session.webdriverEndpoint);
    if (typeof builder.setChromeOptions === 'function') {
      builder.setChromeOptions(options.chromeOptions || new chrome.Options());
    }
    if (options.capabilities && typeof options.capabilities === 'object' && typeof builder.withCapabilities === 'function') {
      builder.withCapabilities(options.capabilities);
    }
    try {
      return await builder.build();
    } catch (error) {
      if (!isHyperbrowserSeleniumReadinessError(error) || attempt === maxAttempts) throw error;
    }
  }
  throw new Error('Hyperbrowser Selenium driver did not become ready.');
}

async function connectHyperbrowserSelenium(options = {}) {
  const cloud = await createHyperbrowserSessionWithExtension(options);
  let driver;
  try {
    driver = await createHyperbrowserSeleniumDriver(cloud.session, options);
    const scriptTimeoutMs = toNumber(
      options.scriptTimeoutMs || envValue(options.env || process.env, 'HYPERBROWSER_SELENIUM_SCRIPT_TIMEOUT_MS'),
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
      extension: cloud.extension,
      sessionInfo: hyperbrowserSessionInfo(cloud.session, options),
      driver,
      framework: 'selenium',
      async close() {
        if (closed) return;
        closed = true;
        await driver.quit().catch(() => {});
        await stopHyperbrowserSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (driver) await driver.quit().catch(() => {});
    await stopHyperbrowserSession(cloud.client, cloud.session, options);
    const env = options.env || process.env;
    throw new Error(`Hyperbrowser Selenium connection failed: ${safeProviderErrorMessage(error, [
      options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'),
      cloud.session.token,
      cloud.session.webdriverEndpoint
    ])}`);
  }
}

function hyperbrowserResultsDir(framework, options = {}) {
  return resultsDir('hyperbrowser', framework, options);
}

function hyperbrowserValidationSummary(framework, options = {}) {
  const env = options.env || process.env;
  const normalizedFramework = String(framework || '').trim().toLowerCase();
  const frameworkSupported = ['playwright', 'puppeteer', 'selenium'].includes(normalizedFramework);
  const explicitExtensionId = options.extensionId || envValue(env, 'HYPERBROWSER_EXTENSION_ID');
  const artifact = explicitExtensionId ? null : assertHyperbrowserExtensionArtifact(resolveAutomationZipArtifact(options));
  return {
    ok: Boolean(options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY')) && frameworkSupported,
    framework,
    targetUrl: options.targetUrl || envValue(env, 'PTK_PROVIDER_TARGET_URL') || envValue(env, 'JUICE_SHOP_URL') || null,
    resultsDir: hyperbrowserResultsDir(framework, options),
    credentialsConfigured: {
      apiKey: Boolean(options.apiKey || envValue(env, 'HYPERBROWSER_API_KEY'))
    },
    hyperbrowser: {
      extensionIdConfigured: Boolean(explicitExtensionId),
      willUploadExtensionIfRun: !explicitExtensionId,
      frameworkSupported,
      seleniumAccountEnablementMayBeRequired: normalizedFramework === 'selenium'
    },
    extension: artifact ? {
      type: artifact.type,
      path: artifact.path,
      file: path.basename(artifact.path),
      size: artifact.size,
      version: artifact.version,
      manifestVersion: artifact.manifestVersion,
      automationEnabledDefault: artifact.automationEnabledDefault
    } : null
  };
}

module.exports = {
  DEFAULT_API_BASE,
  MAX_EXTENSION_BYTES,
  assertHyperbrowserExtensionArtifact,
  connectHyperbrowserPlaywright,
  connectHyperbrowserPuppeteer,
  connectHyperbrowserSelenium,
  createHyperbrowserClient,
  createHyperbrowserSeleniumDriver,
  createHyperbrowserSessionWithExtension,
  hyperbrowserCredentials,
  hyperbrowserHttpAgent,
  hyperbrowserResultsDir,
  hyperbrowserSessionOptions,
  hyperbrowserValidationSummary,
  isHyperbrowserSeleniumReadinessError,
  resolveHyperbrowserExtensionId,
  stopHyperbrowserSession,
  validateOnlyEnabled
};
