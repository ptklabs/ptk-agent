'use strict';

const fs = require('fs');
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
  writeCachedUpload
} = require('../../_shared/src/index.cjs');

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
      'playwright or playwright-core is required for Steel Playwright sessions. Install it with "npm install -D playwright".'
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
      'puppeteer-core or puppeteer is required for Steel Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function loadSeleniumWebDriver(options = {}) {
  return options.seleniumWebDriver || loadProjectModule(
    'selenium-webdriver',
    'selenium-webdriver is required for Steel Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function loadSeleniumHttp(options = {}) {
  return options.seleniumHttp || loadProjectModule(
    'selenium-webdriver/http',
    'selenium-webdriver/http is required for Steel Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function loadSteelSdk(options = {}) {
  if (options.Steel) return options.Steel;
  const mod = loadProjectModule(
    'steel-sdk',
    'steel-sdk is required for Steel sessions. Install it with "npm install -D steel-sdk".'
  );
  return mod.default || mod.Steel || mod;
}

function loadPtkExtensions(options = {}) {
  if (options.ptkExtensions) return options.ptkExtensions;
  return require('../../../extensions/index.cjs');
}

function createSteelClient(options = {}) {
  if (options.client) return options.client;
  const env = options.env || process.env;
  const apiKey = options.apiKey || envValue(env, 'STEEL_API_KEY');
  if (!apiKey) throw new Error('STEEL_API_KEY is required.');
  const Steel = loadSteelSdk(options);
  return new Steel({ steelAPIKey: apiKey });
}

function extensionIdFromResponse(response) {
  return response && (response.id || response.extensionId || response.extension_id);
}

async function resolveSteelExtensionId(client, options = {}) {
  const env = options.env || process.env;
  const explicit = options.extensionId || envValue(env, 'STEEL_EXTENSION_ID');
  if (explicit) return { extensionId: explicit, source: 'env' };
  if (!client || !client.extensions || typeof client.extensions.upload !== 'function') {
    throw new Error('A Steel SDK client with extensions.upload() is required.');
  }

  const artifact = resolveAutomationZipArtifact(options);
  if (artifact.type !== 'zip' && artifact.format !== 'zip') {
    throw new Error('Steel requires a ZIP extension artifact.');
  }

  const apiKey = options.apiKey || envValue(env, 'STEEL_API_KEY');
  const cacheOptions = accountScopedOptions('steel', apiKey ? {
    apiKey,
    baseURL: options.baseURL || envValue(env, 'STEEL_BASE_URL') || 'https://api.steel.dev'
  } : '', options);
  const cached = readCachedUpload('steel', artifact, cacheOptions);
  if (cached && cached.extensionId) return { ...cached, artifact, source: 'cache' };

  const uploaded = await client.extensions.upload({
    // steel-sdk@0.18.0 does not classify Buffer as Uploadable and recursively
    // expands it into multipart fields. A Node ReadStream follows the SDK's
    // actual isFsReadStream upload path and keeps large extension ZIPs bounded.
    file: fs.createReadStream(artifact.path)
  }, {
    timeout: toNumber(options.uploadTimeoutMs || envValue(env, 'STEEL_UPLOAD_TIMEOUT_MS'), 120000),
    maxRetries: toNumber(options.uploadMaxRetries || envValue(env, 'STEEL_UPLOAD_MAX_RETRIES'), 0)
  });
  const extensionId = extensionIdFromResponse(uploaded);
  if (!extensionId) throw new Error('Steel extension upload did not return an extension id.');

  const cachePayload = {
    extensionId,
    name: uploaded.name,
    source: 'upload'
  };
  writeCachedUpload('steel', artifact, cachePayload, cacheOptions);
  return { ...cachePayload, artifact };
}

function steelConnectUrl(session, options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || envValue(env, 'STEEL_API_KEY');
  if (!apiKey) throw new Error('STEEL_API_KEY is required.');
  if (session.websocketUrl) {
    const joiner = session.websocketUrl.includes('?') ? '&' : '?';
    return session.websocketUrl.includes('apiKey=')
      ? session.websocketUrl
      : `${session.websocketUrl}${joiner}apiKey=${encodeURIComponent(apiKey)}`;
  }
  if (session.id) {
    return `wss://connect.steel.dev?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(session.id)}`;
  }
  throw new Error('Steel session did not include websocketUrl or id.');
}

function steelSessionOptions(extensionId, options = {}) {
  const env = options.env || process.env;
  const sessionOptions = {
    extensionIds: Array.isArray(extensionId) ? extensionId : [extensionId],
    timeout: toNumber(options.timeoutMs || envValue(env, 'STEEL_TIMEOUT_MS'), 900000),
    ...(options.sessionOptions || {})
  };
  if (options.framework === 'selenium') sessionOptions.isSelenium = true;
  return sessionOptions;
}

function steelSeleniumRemoteUrl(options = {}) {
  const env = options.env || process.env;
  const value = options.seleniumRemoteUrl || options.remoteUrl ||
    envValue(env, 'STEEL_SELENIUM_URL', 'https://connect.steelbrowser.com/selenium');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('STEEL_SELENIUM_URL must use http:// or https://.');
  }
  return url.toString();
}

function steelSeleniumCapabilities(options = {}) {
  const env = options.env || process.env;
  const capabilities = {
    browserName: options.browserName || envValue(env, 'STEEL_BROWSER_NAME', 'chrome'),
    ...(options.capabilities && typeof options.capabilities === 'object' ? options.capabilities : {})
  };
  const artifactPath = options.extensionBase64
    ? null
    : options.seleniumExtensionPath ||
      (options.extension && options.extension.seleniumArtifact && options.extension.seleniumArtifact.path);
  const extensionBase64 = options.extensionBase64 || (artifactPath
    ? fs.readFileSync(artifactPath).toString('base64')
    : null);
  if (extensionBase64) {
    const chromeOptions = capabilities['goog:chromeOptions'] && typeof capabilities['goog:chromeOptions'] === 'object'
      ? capabilities['goog:chromeOptions']
      : {};
    capabilities['goog:chromeOptions'] = {
      ...chromeOptions,
      extensions: [
        ...(Array.isArray(chromeOptions.extensions) ? chromeOptions.extensions : []),
        extensionBase64
      ]
    };
  }
  return capabilities;
}

function createSteelSeleniumExecutor(session, options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || envValue(env, 'STEEL_API_KEY');
  if (!apiKey) throw new Error('STEEL_API_KEY is required.');
  if (!session || !session.id) throw new Error('Steel Selenium session did not include an id.');
  const seleniumHttp = loadSeleniumHttp(options);
  const client = new seleniumHttp.HttpClient(steelSeleniumRemoteUrl({ ...options, env }));
  const authenticatedClient = {
    send(request) {
      request.headers.set('steel-api-key', apiKey);
      request.headers.set('session-id', session.id);
      return client.send(request);
    }
  };
  return new seleniumHttp.Executor(authenticatedClient);
}

function isSteelSeleniumReadinessError(error) {
  const message = String(error && error.message || error || '');
  return /connect\s+ECONNREFUSED\s+127\.0\.0\.1:4444/i.test(message);
}

async function createSteelSeleniumDriver(session, options = {}) {
  const env = options.env || process.env;
  const webdriver = loadSeleniumWebDriver(options);
  const readinessTimeoutMs = toNumber(
    options.readinessTimeoutMs || envValue(env, 'STEEL_SELENIUM_READINESS_TIMEOUT_MS'),
    45000
  );
  const wait = typeof options.seleniumReadinessWait === 'function'
    ? options.seleniumReadinessWait
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const deadline = Date.now() + readinessTimeoutMs;
  let attempt = 0;

  while (true) {
    attempt += 1;
    let driver;
    try {
      const executor = createSteelSeleniumExecutor(session, options);
      driver = webdriver.WebDriver.createSession(executor, steelSeleniumCapabilities(options));
      if (driver && typeof driver.getSession === 'function') await driver.getSession();
      return driver;
    } catch (error) {
      if (driver && typeof driver.quit === 'function') await driver.quit().catch(() => {});
      const remainingMs = deadline - Date.now();
      if (!isSteelSeleniumReadinessError(error) || remainingMs <= 0) throw error;
      const backoffMs = Math.min(500 * (2 ** Math.min(attempt - 1, 3)), 4000, remainingMs);
      await wait(backoffMs);
    }
  }
}

function steelResultsDir(framework, options = {}) {
  return resultsDir('steel', framework, options);
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

async function createSteelSessionWithExtension(framework, options = {}) {
  const client = createSteelClient(options);
  const extension = options.extension && options.extension.extensionId
    ? options.extension
    : await resolveSteelExtensionId(client, options);
  const session = await client.sessions.create(steelSessionOptions(extension.extensionId, {
    ...options,
    framework
  }));
  return { client, extension, session };
}

async function releaseSteelSession(client, session, options = {}) {
  if (client && session && session.id && client.sessions && typeof client.sessions.release === 'function') {
    await client.sessions.release(session.id).catch((error) => {
      const env = options.env || process.env;
      console.warn(`Steel release failed: ${safeProviderErrorMessage(error, [
        options.apiKey || envValue(env, 'STEEL_API_KEY')
      ])}`);
    });
  }
}

async function connectSteelPlaywright(options = {}) {
  const cloud = await createSteelSessionWithExtension('playwright', options);
  let browser;
  try {
    const playwright = loadPlaywright(options);
    const chromium = options.chromium || playwright.chromium;
    browser = await chromium.connectOverCDP(steelConnectUrl(cloud.session, options), options.connectOptions || {});
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('Steel session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    const connection = {
      extension: cloud.extension,
      sessionInfo: safeProviderMetadata(cloud.session, [
        cloud.session.websocketUrl,
        cloud.session.debugUrl,
        cloud.session.sessionViewerUrl
      ]),
      browser,
      context,
      page,
      framework: 'playwright',
      async close() {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
        await releaseSteelSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await releaseSteelSession(cloud.client, cloud.session, options);
    throw error;
  }
}

async function connectSteelPuppeteer(options = {}) {
  const cloud = await createSteelSessionWithExtension('puppeteer', options);
  let browser;
  try {
    const puppeteer = loadPuppeteer(options);
    browser = await puppeteer.connect({
      browserWSEndpoint: steelConnectUrl(cloud.session, options),
      ...(options.connectOptions || {})
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => typeof candidate.isClosed !== 'function' || !candidate.isClosed()) || await browser.newPage();
    let closed = false;
    const connection = {
      extension: cloud.extension,
      sessionInfo: safeProviderMetadata(cloud.session, [
        cloud.session.websocketUrl,
        cloud.session.debugUrl,
        cloud.session.sessionViewerUrl
      ]),
      browser,
      page,
      framework: 'puppeteer',
      async close() {
        if (closed) return;
        closed = true;
        if (typeof browser.isConnected !== 'function' || browser.isConnected()) {
          await browser.close().catch(() => {});
        }
        await releaseSteelSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      await browser.close().catch(() => {});
    }
    await releaseSteelSession(cloud.client, cloud.session, options);
    throw error;
  }
}

async function connectSteelSelenium(options = {}) {
  const cloud = await createSteelSessionWithExtension('selenium', options);
  let driver;
  try {
    const seleniumArtifact = options.extensionBase64
      ? null
      : loadPtkExtensions(options).resolvePtkCrxArtifact({
          packageRoot: options.packageRoot,
          cacheRoot: options.cacheRoot,
          crxPath: options.seleniumExtensionPath,
          keyPath: options.keyPath,
          chromeBinary: options.chromeBinary
        });
    driver = await createSteelSeleniumDriver(cloud.session, {
      ...options,
      extension: {
        ...cloud.extension,
        seleniumArtifact
      }
    });
    const scriptTimeoutMs = toNumber(
      options.scriptTimeoutMs || envValue(options.env || process.env, 'STEEL_SELENIUM_SCRIPT_TIMEOUT_MS'),
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
      seleniumExtension: safeProviderMetadata(seleniumArtifact ? {
        format: seleniumArtifact.format,
        source: seleniumArtifact.source,
        sha256: seleniumArtifact.sha256,
        size: seleniumArtifact.size
      } : null),
      sessionInfo: safeProviderMetadata(cloud.session, [
        cloud.session.websocketUrl,
        cloud.session.debugUrl,
        cloud.session.sessionViewerUrl
      ]),
      remoteUrl: safeProviderMetadata(steelSeleniumRemoteUrl(options)),
      driver,
      framework: 'selenium',
      async close() {
        if (closed) return;
        closed = true;
        await driver.quit().catch(() => {});
        await releaseSteelSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (driver) await driver.quit().catch(() => {});
    await releaseSteelSession(cloud.client, cloud.session, options);
    throw error;
  }
}

async function inspectSteelExtensionRuntime(connection) {
  if (!connection || connection.framework !== 'selenium' || !connection.driver) {
    return { extensionLoaded: false, diagnosticError: 'Steel extension diagnostics require a Selenium connection.' };
  }
  try {
    await connection.driver.get('chrome://extensions/');
    const installedExtensions = await connection.driver.executeScript(`
      const manager = document.querySelector('extensions-manager');
      const list = manager && manager.shadowRoot && manager.shadowRoot.querySelector('extensions-item-list');
      const items = list && list.shadowRoot ? Array.from(list.shadowRoot.querySelectorAll('extensions-item')) : [];
      return items.map((item) => ({
        id: item.getAttribute('id'),
        name: item.shadowRoot && item.shadowRoot.querySelector('#name')
          ? item.shadowRoot.querySelector('#name').textContent.trim()
          : null
      }));
    `);
    const safeExtensions = Array.isArray(installedExtensions)
      ? installedExtensions.map((item) => safeProviderMetadata(item))
      : [];
    return {
      extensionLoaded: safeExtensions.length > 0,
      installedExtensionCount: safeExtensions.length,
      installedExtensions: safeExtensions,
      steelExtensionIdRequested: Boolean(connection.extension && connection.extension.extensionId),
      chromeDriverCrxSupplied: Boolean(connection.seleniumExtension)
    };
  } catch (error) {
    return {
      extensionLoaded: false,
      installedExtensionCount: 0,
      installedExtensions: [],
      diagnosticError: safeProviderErrorMessage(error)
    };
  }
}

module.exports = {
  connectSteelPlaywright,
  connectSteelPuppeteer,
  connectSteelSelenium,
  createSteelSeleniumExecutor,
  createSteelSeleniumDriver,
  inspectSteelExtensionRuntime,
  createSteelClient,
  resolveSteelExtensionId,
  releaseSteelSession,
  steelConnectUrl,
  steelResultsDir,
  steelSeleniumCapabilities,
  steelSeleniumRemoteUrl,
  steelSessionOptions
};
