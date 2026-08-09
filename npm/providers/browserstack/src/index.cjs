'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const extensions = require('../../../extensions/index.cjs');
const { resolvePtkCrxArtifact } = extensions;
const {
  accountScopedOptions,
  createZipFromDirectory,
  envValue,
  listEnv,
  readCachedUpload,
  resolveAutomationZipArtifact,
  safeProviderMetadata,
  toBoolean,
  toNumber,
  writeCachedUpload
} = require('../../_shared/src/index.cjs');

const BROWSERSTACK_UPLOAD_MEDIA_URL = 'https://api-cloud.browserstack.com/automate/upload-media';
const BROWSERSTACK_EXTENSION_PARENT = 'ptk-automation';

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
  return options.playwright || loadProjectModule(
    'playwright',
    'playwright is required for BrowserStack Playwright sessions. Install it with "npm install -D playwright".'
  );
}

function loadPuppeteer(options = {}) {
  if (options.puppeteer) return options.puppeteer;
  try {
    return loadProjectModule('puppeteer-core');
  } catch (_) {
    return loadProjectModule(
      'puppeteer',
      'puppeteer-core or puppeteer is required for BrowserStack Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function loadSeleniumWebDriver(options = {}) {
  return options.seleniumWebDriver || loadProjectModule(
    'selenium-webdriver',
    'selenium-webdriver is required for BrowserStack Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function credentialsFromOptions(options = {}) {
  const env = options.env || process.env;
  const username = options.username || envValue(env, 'BROWSERSTACK_USERNAME') || envValue(env, 'BROWSERSTACK_USER');
  const accessKey = options.accessKey || envValue(env, 'BROWSERSTACK_ACCESS_KEY');
  if (!username) throw new Error('BROWSERSTACK_USERNAME is required');
  if (!accessKey) throw new Error('BROWSERSTACK_ACCESS_KEY is required');
  return { username, accessKey };
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

function normalizeList(value) {
  if (!value) return [];
  const input = Array.isArray(value) ? value : String(value).split(',');
  return input.map((item) => String(item || '').trim()).filter(Boolean);
}

function extensionConfigFromOptions(options = {}) {
  return options.extension && typeof options.extension === 'object' ? options.extension : {};
}

function extensionValuesFromOptions(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  return [
    ...normalizeList(options.extensionValues),
    ...normalizeList(options.extensionValue),
    ...normalizeList(options.extensionUrls),
    ...normalizeList(options.extensionUrl),
    ...normalizeList(options.extensionIds),
    ...normalizeList(options.extensionId),
    ...normalizeList(extension.values),
    ...normalizeList(extension.value),
    ...normalizeList(extension.urls),
    ...normalizeList(extension.url),
    ...normalizeList(extension.cloudUrl),
    ...normalizeList(extension.mediaUrl),
    ...normalizeList(extension.mediaUrls),
    ...normalizeList(extension.id),
    ...normalizeList(extension.ids),
    ...listEnv(env, 'BROWSERSTACK_UPLOAD_MEDIA_URL'),
    ...listEnv(env, 'BROWSERSTACK_MEDIA_URL'),
    ...listEnv(env, 'BROWSERSTACK_EXTENSION_MEDIA_URL'),
    ...listEnv(env, 'BROWSERSTACK_LOAD_EXTENSION'),
    ...listEnv(env, 'BROWSERSTACK_EXTENSION_CLOUD_URL'),
    ...listEnv(env, 'BROWSERSTACK_EXTENSION_URL'),
    ...listEnv(env, 'BROWSERSTACK_EXTENSION_UPLOAD_ID'),
    ...listEnv(env, 'BROWSERSTACK_EXTENSION_ID')
  ];
}

function curlConfigValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sanitizeUploadResponse(text) {
  return String(text || '').replace(/https?:\/\/[^"\s]+/g, '[url]');
}

function parseBrowserStackUploadResponse(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch (_) {
    throw new Error(`Invalid BrowserStack upload-media response: ${sanitizeUploadResponse(text)}`);
  }
  const mediaUrl = result && (result.media_url || result.mediaUrl || result.url);
  if (typeof mediaUrl === 'string' && mediaUrl.trim()) return mediaUrl.trim();
  throw new Error(`BrowserStack upload-media response did not include media_url: ${sanitizeUploadResponse(text)}`);
}

function uploadBrowserStackExtension(artifact, credentials, options = {}) {
  const env = options.env || process.env;
  const uploadUrl = options.uploadUrl || envValue(env, 'BROWSERSTACK_UPLOAD_MEDIA_API_URL', BROWSERSTACK_UPLOAD_MEDIA_URL);
  const curlConfig = [
    'silent',
    'show-error',
    'location',
    `request = ${curlConfigValue('POST')}`,
    `url = ${curlConfigValue(uploadUrl)}`,
    `user = ${curlConfigValue(`${credentials.username}:${credentials.accessKey}`)}`,
    `form = ${curlConfigValue(`file=@${artifact.path}`)}`
  ].join('\n');

  const result = spawnSync('curl', ['--config', '-'], {
    input: `${curlConfig}\n`,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Unable to run curl for BrowserStack upload-media: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `BrowserStack upload-media failed with curl exit ${result.status}: ` +
      sanitizeUploadResponse(result.stderr || result.stdout || '')
    );
  }
  return parseBrowserStackUploadResponse(result.stdout);
}

function browserStackZipEntries(zipPath) {
  const result = spawnSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Unable to inspect BrowserStack extension ZIP: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect BrowserStack extension ZIP: ${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function validateBrowserStackUploadZip(zipPath, parentDirectory = BROWSERSTACK_EXTENSION_PARENT) {
  const prefix = `${parentDirectory}/`;
  const entries = browserStackZipEntries(zipPath);
  if (!entries.length) throw new Error('BrowserStack extension ZIP is empty.');
  const invalid = entries.filter((entry) => entry !== prefix && !entry.startsWith(prefix));
  if (invalid.length) {
    throw new Error(
      `BrowserStack extension ZIP must contain exactly one parent directory (${parentDirectory}); ` +
      `found root entry ${invalid[0]}`
    );
  }
  if (!entries.includes(`${prefix}manifest.json`)) {
    throw new Error(`BrowserStack extension ZIP is missing ${prefix}manifest.json`);
  }
  return {
    parentDirectory,
    entries: entries.length
  };
}

function extractBrowserStackSourceZip(sourceZip, destination) {
  const result = spawnSync('unzip', ['-q', sourceZip, '-d', destination], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Unable to unpack PTK for BrowserStack: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to unpack PTK for BrowserStack: ${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
}

function prepareBrowserStackUploadArtifact(options = {}) {
  const source = resolveAutomationZipArtifact(options);
  const version = String(source.version || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const generatedRoot = path.join(
    extensions.automationCacheRoot({ cacheRoot: options.cacheRoot }),
    'generated',
    'browserstack'
  );
  const zipPath = path.join(
    generatedRoot,
    `ptk-browserstack-${version}-${source.sha256.slice(0, 16)}.zip`
  );

  if (!fs.existsSync(zipPath)) {
    fs.mkdirSync(generatedRoot, { recursive: true });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-browserstack-extension-'));
    const tempZip = `${tempRoot}.zip`;
    try {
      const extensionRoot = path.join(tempRoot, BROWSERSTACK_EXTENSION_PARENT);
      fs.mkdirSync(extensionRoot, { recursive: true });
      extractBrowserStackSourceZip(source.path, extensionRoot);
      createZipFromDirectory(tempRoot, tempZip, { compressionLevel: 9 });
      validateBrowserStackUploadZip(tempZip);
      fs.renameSync(tempZip, zipPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempZip, { force: true });
    }
  }

  const layout = validateBrowserStackUploadZip(zipPath);
  return {
    ...source,
    path: zipPath,
    sha256: extensions.sha256File(zipPath),
    size: fs.statSync(zipPath).size,
    source: 'browserstack-parent-folder',
    sourceArtifactSha256: source.sha256,
    parentDirectory: layout.parentDirectory,
    entries: layout.entries
  };
}

function resolveBrowserStackUploadMedia(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  const shouldUpload = toBoolean(
    options.upload === undefined && extension.upload === undefined
      ? envValue(env, 'BROWSERSTACK_UPLOAD_EXTENSION')
      : (options.upload === undefined ? extension.upload : options.upload),
    false
  );
  if (!shouldUpload) return { source: 'none', values: [] };

  const artifact = prepareBrowserStackUploadArtifact(options);
  if (artifact.type !== 'zip' && artifact.format !== 'zip') {
    throw new Error('BrowserStack upload-media requires a ZIP extension artifact.');
  }

  const credentials = credentialsFromOptions(options);
  const cacheOptions = accountScopedOptions('browserstack', {
    accessKey: credentials.accessKey,
    uploadUrl: options.uploadUrl || envValue(env, 'BROWSERSTACK_UPLOAD_MEDIA_API_URL', BROWSERSTACK_UPLOAD_MEDIA_URL),
    username: credentials.username
  }, options);
  const cached = readCachedUpload('browserstack', artifact, cacheOptions);
  if (cached && cached.mediaUrl) {
    return {
      source: 'cache',
      values: [cached.mediaUrl],
      mediaUrl: cached.mediaUrl,
      artifact
    };
  }

  const mediaUrl = uploadBrowserStackExtension(artifact, credentials, { ...options, env });
  writeCachedUpload('browserstack', artifact, { mediaUrl }, cacheOptions);
  return {
    source: 'upload',
    values: [mediaUrl],
    mediaUrl,
    artifact
  };
}

function resolveBrowserStackExtensionValues(options = {}) {
  const explicit = extensionValuesFromOptions(options);
  if (explicit.length) {
    return {
      source: 'capability',
      values: explicit
    };
  }
  return resolveBrowserStackUploadMedia(options);
}

function hasExtensionHint(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = String(key).toLowerCase();
    if (normalized.includes('extension') || normalized.includes('uploadmedia') || normalized === 'load-extension') return true;
    return hasExtensionHint(nested);
  });
}

function setNestedCapability(target, dottedPath, value) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) throw new Error('BrowserStack extension capability path is empty');
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift();
    cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {};
    cursor = cursor[part];
  }
  cursor[parts[0]] = value;
}

function setBrowserStackExtensionCapability(target, capabilityPath, value) {
  const key = String(capabilityPath || '').trim();
  if (!key) throw new Error('BrowserStack extension capability path is empty');
  if (/^browserstack\./i.test(key)) {
    target[key] = value;
    return;
  }
  setNestedCapability(target, key, value);
}

function extensionCapabilityPath(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  return options.extensionCapabilityPath ||
    extension.capabilityPath ||
    envValue(env, 'BROWSERSTACK_EXTENSION_CAPABILITY_PATH', 'browserstack.uploadMedia');
}

function applyBrowserStackExtensionCapability(capabilities, options = {}) {
  const resolved = resolveBrowserStackExtensionValues(options);
  const values = resolved.values || [];
  if (!values.length) return {
    source: hasExtensionHint(capabilities) ? 'custom-capabilities' : 'none',
    values: []
  };

  const capabilityPath = extensionCapabilityPath(options);
  const capabilityValue = values.length > 1 || /(?:\.extensions|uploadMedia)$/i.test(capabilityPath)
    ? values
    : values[0];
  setBrowserStackExtensionCapability(capabilities, capabilityPath, capabilityValue);
  return {
    ...resolved,
    source: resolved.source || 'capability',
    capabilityPath,
    values
  };
}

function browserStackExtensionRequirement(framework, capabilities, options = {}) {
  const env = options.env || process.env;
  const specificEndpoint = browserStackWsEndpointFromEnv(framework, { ...options, env });
  if (specificEndpoint) return { source: 'preloaded-ws-endpoint' };
  const values = extensionValuesFromOptions({ ...options, env });
  if (values.length) return { source: 'capability', values };
  if (hasExtensionHint(capabilities)) return { source: 'custom-capabilities' };

  const requireExtension = toBoolean(
    options.requireExtension === undefined
      ? envValue(env, 'BROWSERSTACK_REQUIRE_EXTENSION', 'true')
      : options.requireExtension,
    true
  );
  if (!requireExtension) return { source: 'none' };

  const label = framework === 'playwright' ? 'Playwright' : 'Puppeteer';
  throw new Error(
    `BrowserStack ${label} needs a session that already loads the PTK automation extension. ` +
    `Set BROWSERSTACK_${label.toUpperCase()}_WS_ENDPOINT to a preloaded session endpoint, or set ` +
    'BROWSERSTACK_UPLOAD_EXTENSION=1 to upload the packaged ZIP through BrowserStack upload-media, or set ' +
    'BROWSERSTACK_MEDIA_URL/BROWSERSTACK_UPLOAD_MEDIA_URL to an existing media:// value.'
  );
}

function browserStackCdpCapabilities(framework, options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const custom = options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : parseJsonEnv(env, 'BROWSERSTACK_CAPABILITIES_JSON', {});
  const title = framework === 'playwright' ? 'Playwright' : 'Puppeteer';
  const browserVersion = options.browserVersion || envValue(env, 'BROWSERSTACK_BROWSER_VERSION');
  const osVersion = options.osVersion || envValue(env, 'BROWSERSTACK_OS_VERSION', framework === 'playwright' ? '10' : '11');
  const caps = {
    browser: options.browserName || envValue(env, 'BROWSERSTACK_BROWSER_NAME', 'chrome'),
    ...(browserVersion || framework === 'puppeteer' ? { browser_version: browserVersion || 'latest' } : {}),
    os: options.os || envValue(env, 'BROWSERSTACK_OS', framework === 'playwright' ? 'windows' : 'Windows'),
    ...(framework === 'playwright' ? { osVersion } : { os_version: osVersion }),
    project: options.project || envValue(env, 'BROWSERSTACK_PROJECT', envValue(env, 'PTK_PROJECT', 'PTK BrowserStack')),
    build: options.build || envValue(env, 'BROWSERSTACK_BUILD', `PTK ${title} Build`),
    name: options.name || envValue(env, 'BROWSERSTACK_NAME', `PTK Juice Shop ${title}`),
    'browserstack.username': credentials.username,
    'browserstack.accessKey': credentials.accessKey,
    'browserstack.local': String(options.local === undefined ? envValue(env, 'BROWSERSTACK_LOCAL', 'false') : options.local),
    ...custom
  };

  const playwrightConnectMode = String(options.connectMode || envValue(env, 'BROWSERSTACK_PLAYWRIGHT_CONNECT_MODE', 'cdp')).trim().toLowerCase();
  if (framework === 'playwright' && playwrightConnectMode === 'playwright') {
    if (!caps['browserstack.playwrightVersion']) {
      caps['browserstack.playwrightVersion'] = envValue(env, 'BROWSERSTACK_PLAYWRIGHT_VERSION', '1.latest');
    }
    if (!caps['client.playwrightVersion']) {
      caps['client.playwrightVersion'] = envValue(env, 'BROWSERSTACK_CLIENT_PLAYWRIGHT_VERSION', '1.latest');
    }
  }

  const extension = applyBrowserStackExtensionCapability(caps, { ...options, env });
  return {
    capabilities: caps,
    extension
  };
}

async function inspectBrowserStackExtensionRuntime(connection) {
  const extensionTargets = [];
  let sessionDetails = null;
  const addTarget = (type, value) => {
    const raw = String(value || '');
    if (!raw.startsWith('chrome-extension://')) return;
    const url = new URL(raw);
    extensionTargets.push({ type: type || 'unknown', origin: `${url.protocol}//${url.host}` });
  };
  try {
    if (connection && connection.page && typeof connection.page.evaluate === 'function') {
      try {
        const raw = await connection.page.evaluate(
          () => {},
          `browserstack_executor: ${JSON.stringify({ action: 'getSessionDetails' })}`
        );
        const details = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (details && typeof details === 'object') {
          sessionDetails = safeProviderMetadata({
            name: details.name,
            duration: details.duration,
            os: details.os,
            osVersion: details.os_version,
            browser: details.browser,
            browserVersion: details.browser_version,
            status: details.status,
            reason: details.reason,
            sessionId: details.hashed_id,
            buildId: details.build_hashed_id,
            projectName: details.project_name
          });
        }
      } catch (_) {
        // Target diagnostics below remain useful when the executor is unavailable.
      }
    }
    if (connection && connection.framework === 'playwright' && connection.browser) {
      if (connection.context && typeof connection.context.serviceWorkers === 'function') {
        for (const worker of connection.context.serviceWorkers()) addTarget('service_worker', worker.url());
      }
      if (typeof connection.browser.newBrowserCDPSession === 'function') {
        const cdp = await connection.browser.newBrowserCDPSession();
        try {
          const result = await cdp.send('Target.getTargets');
          for (const target of result && result.targetInfos || []) addTarget(target.type, target.url);
        } finally {
          if (typeof cdp.detach === 'function') await cdp.detach().catch(() => {});
        }
      }
    } else if (connection && connection.framework === 'puppeteer' && connection.browser && typeof connection.browser.targets === 'function') {
      for (const target of connection.browser.targets()) {
        addTarget(typeof target.type === 'function' ? target.type() : 'unknown', typeof target.url === 'function' ? target.url() : '');
      }
    }
    const unique = Array.from(new Map(extensionTargets.map((target) => [`${target.type}:${target.origin}`, target])).values());
    return {
      extensionTargetCount: unique.length,
      extensionTargets: unique,
      extensionLoaded: unique.length > 0,
      sessionDetails
    };
  } catch (error) {
    return {
      extensionTargetCount: 0,
      extensionTargets: [],
      extensionLoaded: false,
      sessionDetails,
      diagnosticError: safeProviderMetadata(error && error.message ? error.message : String(error))
    };
  }
}

function browserStackWsEndpointFromEnv(framework, options = {}) {
  const env = options.env || process.env;
  if (framework === 'playwright') {
    return options.wsEndpoint || envValue(env, 'BROWSERSTACK_PLAYWRIGHT_WS_ENDPOINT');
  }
  return options.wsEndpoint || envValue(env, 'BROWSERSTACK_PUPPETEER_WS_ENDPOINT');
}

function browserStackWsEndpoint(framework, options = {}) {
  const env = options.env || process.env;
  const explicit = browserStackWsEndpointFromEnv(framework, { ...options, env });
  if (explicit) {
    return {
      wsEndpoint: explicit,
      capabilities: null,
      extension: { source: 'preloaded-ws-endpoint' }
    };
  }
  const built = browserStackCdpCapabilities(framework, { ...options, env });
  const extension = browserStackExtensionRequirement(framework, built.capabilities, { ...options, env });
  const endpointFramework = framework === 'playwright' ? 'playwright' : 'puppeteer';
  return {
    wsEndpoint: `wss://cdp.browserstack.com/${endpointFramework}?caps=${encodeURIComponent(JSON.stringify(built.capabilities))}`,
    capabilities: built.capabilities,
    extension: built.extension.source === 'none' ? extension : built.extension
  };
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

async function connectBrowserStackPlaywright(options = {}) {
  const env = options.env || process.env;
  const endpoint = browserStackWsEndpoint('playwright', { ...options, env });
  const playwright = loadPlaywright(options);
  const chromium = options.chromium || playwright.chromium;
  const timeout = toNumber(options.connectTimeoutMs || envValue(env, 'BROWSERSTACK_CONNECT_TIMEOUT_MS'), 60000);
  const connectMode = String(options.connectMode || envValue(env, 'BROWSERSTACK_PLAYWRIGHT_CONNECT_MODE', 'cdp')).trim().toLowerCase();
  let browser;
  try {
    browser = connectMode === 'playwright'
      ? await chromium.connect({
          wsEndpoint: endpoint.wsEndpoint,
          timeout,
          ...(options.connectOptions || {})
        })
      : await chromium.connectOverCDP(endpoint.wsEndpoint, {
          timeout,
          ...(options.connectOptions || {})
        });
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('BrowserStack session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    return {
      browser,
      context,
      page,
      capabilities: safeProviderMetadata(endpoint.capabilities),
      extension: safeProviderMetadata(endpoint.extension),
      framework: 'playwright',
      connectMode: connectMode === 'playwright' ? 'playwright' : 'cdp',
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

async function connectBrowserStackPuppeteer(options = {}) {
  const env = options.env || process.env;
  const endpoint = browserStackWsEndpoint('puppeteer', { ...options, env });
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
      capabilities: safeProviderMetadata(endpoint.capabilities),
      extension: safeProviderMetadata(endpoint.extension),
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

function browserStackSeleniumRemoteUrl(options = {}) {
  const env = options.env || process.env;
  const explicit = options.remoteUrl || envValue(env, 'BROWSERSTACK_REMOTE_URL') || envValue(env, 'BROWSERSTACK_SELENIUM_URL');
  if (explicit) return explicit;
  const credentials = credentialsFromOptions(options);
  return `https://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.accessKey)}@hub-cloud.browserstack.com/wd/hub`;
}

function mergeChromeOptions(base, override) {
  const merged = {
    ...(base || {}),
    ...(override || {})
  };
  const baseExtensions = Array.isArray(base && base.extensions) ? base.extensions : [];
  const overrideExtensions = Array.isArray(override && override.extensions) ? override.extensions : [];
  merged.extensions = [...baseExtensions, ...overrideExtensions];
  return merged;
}

function isEdgeBrowserName(browserName) {
  const normalized = String(browserName || '').trim().toLowerCase();
  return normalized === 'edge' || normalized === 'microsoftedge';
}

function createBrowserStackSeleniumCapabilities(options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const custom = options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : parseJsonEnv(env, 'BROWSERSTACK_CAPABILITIES_JSON', {});
  const customChrome = custom['goog:chromeOptions'] && typeof custom['goog:chromeOptions'] === 'object'
    ? custom['goog:chromeOptions']
    : {};
  const customEdge = custom['ms:edgeOptions'] && typeof custom['ms:edgeOptions'] === 'object'
    ? custom['ms:edgeOptions']
    : {};
  const customBstack = custom['bstack:options'] && typeof custom['bstack:options'] === 'object'
    ? custom['bstack:options']
    : {};
  const { 'goog:chromeOptions': _chrome, 'ms:edgeOptions': _edge, 'bstack:options': _bstack, ...restCustom } = custom;
  const crx = resolvePtkCrxArtifact({
    packageRoot: options.packageRoot,
    cacheRoot: options.cacheRoot || envValue(env, 'PTK_EXTENSION_CACHE_DIR') || path.resolve('.ptk'),
    keyPath: options.keyPath
  });
  const ptkExtension = fs.readFileSync(crx.path).toString('base64');
  const seleniumVersion = options.seleniumVersion || envValue(env, 'BROWSERSTACK_SELENIUM_VERSION');
  const browserName = options.browserName ||
    (typeof custom.browserName === 'string' && custom.browserName.trim() ? custom.browserName.trim() : '') ||
    envValue(env, 'BROWSERSTACK_BROWSER_NAME', 'Chrome');
  const extensionOptionsKey = isEdgeBrowserName(browserName) ? 'ms:edgeOptions' : 'goog:chromeOptions';
  const extensionOptions = mergeChromeOptions({
    extensions: [ptkExtension]
  }, extensionOptionsKey === 'ms:edgeOptions' ? customEdge : customChrome);
  return {
    browserName,
    browserVersion: options.browserVersion || envValue(env, 'BROWSERSTACK_BROWSER_VERSION', 'latest'),
    ...restCustom,
    [extensionOptionsKey]: extensionOptions,
    'bstack:options': {
      userName: credentials.username,
      accessKey: credentials.accessKey,
      os: options.os || envValue(env, 'BROWSERSTACK_OS', 'Windows'),
      osVersion: options.osVersion || envValue(env, 'BROWSERSTACK_OS_VERSION', '11'),
      projectName: options.project || envValue(env, 'BROWSERSTACK_PROJECT', envValue(env, 'PTK_PROJECT', 'PTK BrowserStack')),
      buildName: options.build || envValue(env, 'BROWSERSTACK_BUILD', 'PTK Selenium Build'),
      sessionName: options.name || envValue(env, 'BROWSERSTACK_NAME', 'PTK Selenium'),
      local: String(options.local === undefined ? envValue(env, 'BROWSERSTACK_LOCAL', 'false') : options.local),
      ...(seleniumVersion ? { seleniumVersion } : {}),
      ...customBstack
    }
  };
}

async function connectBrowserStackSelenium(options = {}) {
  const webdriver = loadSeleniumWebDriver(options);
  const credentials = credentialsFromOptions(options);
  const remoteUrl = browserStackSeleniumRemoteUrl(options);
  const capabilities = createBrowserStackSeleniumCapabilities(options);
  let driver;
  try {
    driver = await new webdriver.Builder()
      .usingServer(remoteUrl)
      .withCapabilities(capabilities)
      .build();
    let closed = false;
    return {
      driver,
      remoteUrl: safeProviderMetadata(remoteUrl, [credentials.username, credentials.accessKey]),
      capabilities: safeProviderMetadata(capabilities, [credentials.username, credentials.accessKey]),
      framework: 'selenium',
      async close() {
        if (closed) return;
        closed = true;
        await driver.quit().catch(() => {});
      }
    };
  } catch (error) {
    if (driver) await driver.quit().catch(() => {});
    throw error;
  }
}

async function setBrowserStackSessionStatus(target, status, reason) {
  const payload = {
    action: 'setSessionStatus',
    arguments: {
      status,
      reason: reason || status
    }
  };
  const command = `browserstack_executor: ${JSON.stringify(payload)}`;
  if (target && typeof target.evaluate === 'function') {
    return target.evaluate(() => {}, command);
  }
  if (target && typeof target.executeScript === 'function') {
    return target.executeScript(command);
  }
  throw new Error('BrowserStack session status target must be a Playwright/Puppeteer page or Selenium driver.');
}

module.exports = {
  applyBrowserStackExtensionCapability,
  browserStackCdpCapabilities,
  browserStackSeleniumRemoteUrl,
  browserStackWsEndpoint,
  connectBrowserStackPlaywright,
  connectBrowserStackPuppeteer,
  connectBrowserStackSelenium,
  createBrowserStackSeleniumCapabilities,
  credentialsFromOptions,
  inspectBrowserStackExtensionRuntime,
  prepareBrowserStackUploadArtifact,
  resolveBrowserStackUploadMedia,
  uploadBrowserStackExtension,
  validateBrowserStackUploadZip,
  setBrowserStackSessionStatus
};
