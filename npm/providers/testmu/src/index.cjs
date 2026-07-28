'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const { resolvePtkCrxArtifact } = require('../../../extensions/index.cjs');
const {
  definePrivateProperty,
  envValue,
  listEnv,
  recompressAutomationZip,
  resolveAutomationZipArtifact,
  safeProviderErrorMessage,
  safeProviderMetadata,
  toBoolean,
  toNumber
} = require('../../_shared/src/index.cjs');

const DEFAULT_EXTENSION_UPLOAD_MAX_BYTES = 10000000;
const LAMBDATEST_EXTENSION_UPLOAD_URL = 'https://api.lambdatest.com/automation/api/v1/files/extensions';
const TESTMU_PLAYWRIGHT_NATIVE_SESSION_ADAPTER = 'playwright';
const TESTMU_PLAYWRIGHT_CDP_SESSION_ADAPTER = 'puppeteer';
const TESTMU_PUPPETEER_SESSION_ADAPTER = 'puppeteer';
const TESTMU_SDK_PACKAGES = [
  '@testmuai/testmu-cloud',
  '@testmuai/browser-cloud'
];

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

function tryLoadProjectModule(name) {
  try {
    return require(name);
  } catch (_) {
    try {
      return createRequire(path.join(process.cwd(), 'package.json'))(name);
    } catch (_) {
      return null;
    }
  }
}

function loadBrowserCloudSdk() {
  for (const packageName of TESTMU_SDK_PACKAGES) {
    const sdk = tryLoadProjectModule(packageName);
    if (!sdk) continue;
    const Browser = sdk.Browser || (sdk.default && sdk.default.Browser) || sdk.default;
    if (typeof Browser !== 'function') {
      throw new Error(`${packageName} does not export the TestMu Browser constructor.`);
    }
    return {
      Browser,
      packageName,
      sdk
    };
  }
  throw new Error(
    '@testmuai/testmu-cloud is required for TestMu Browser Cloud sessions. ' +
    'Install it with "npm install -D @testmuai/testmu-cloud". ' +
    'The legacy @testmuai/browser-cloud package remains accepted for compatibility.'
  );
}

function loadPlaywright(options = {}) {
  return options.playwright || loadProjectModule(
    'playwright',
    'playwright is required for TestMu Playwright sessions. Install it with "npm install -D playwright".'
  );
}

function loadPuppeteer(options = {}) {
  if (options.puppeteer) return options.puppeteer;
  try {
    return loadProjectModule('puppeteer-core');
  } catch (_) {
    return loadProjectModule(
      'puppeteer',
      'puppeteer-core or puppeteer is required for TestMu Puppeteer sessions. Install one with "npm install -D puppeteer-core".'
    );
  }
}

function loadSeleniumWebDriver(options = {}) {
  return options.seleniumWebDriver || loadProjectModule(
    'selenium-webdriver',
    'selenium-webdriver is required for TestMu Selenium sessions. Install it with "npm install -D selenium-webdriver".'
  );
}

function objectValue(value) {
  return value && typeof value === 'object' ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function capabilityOptions(options = {}) {
  const env = options.env || process.env;
  return options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : parseJsonEnv(env, 'TESTMU_CAPABILITIES_JSON', {});
}

function mergedLtOptions(options = {}) {
  const capabilities = capabilityOptions(options);
  const lambdatestOptions = objectValue(options.lambdatestOptions);
  return {
    ...objectValue(capabilities['LT:Options']),
    ...objectValue(lambdatestOptions['LT:Options']),
    ...objectValue(options.ltOptions)
  };
}

function credentialsFromOptions(options = {}) {
  const env = options.env || process.env;
  const ltOptions = mergedLtOptions(options);
  const username = options.username ||
    envValue(env, 'LT_USERNAME') ||
    envValue(env, 'TESTMU_USERNAME') ||
    stringValue(ltOptions.user) ||
    stringValue(ltOptions.username);
  const accessKey = options.accessKey ||
    envValue(env, 'LT_ACCESS_KEY') ||
    envValue(env, 'TESTMU_ACCESS_KEY') ||
    stringValue(ltOptions.accessKey);
  if (!username) throw new Error('LT_USERNAME or TESTMU_USERNAME is required');
  if (!accessKey) throw new Error('LT_ACCESS_KEY or TESTMU_ACCESS_KEY is required');
  return { username, accessKey };
}

function normalizeList(value) {
  if (!value) return [];
  const input = Array.isArray(value) ? value : String(value).split(',');
  return input.map((item) => String(item || '').trim()).filter(Boolean);
}

function extensionConfigFromOptions(options = {}) {
  return options.extension && typeof options.extension === 'object' ? options.extension : {};
}

function extensionUrlsFromEnv(env) {
  return [
    ...listEnv(env, 'TESTMU_EXTENSION_CLOUD_URL'),
    ...listEnv(env, 'TESTMU_EXTENSION_URL'),
    ...listEnv(env, 'TESTMU_LAMBDA_LOAD_EXTENSION')
  ].filter((url) => /^https?:\/\//i.test(url));
}

function extensionUrlsFromOptions(options = {}) {
  const extension = extensionConfigFromOptions(options);
  return [
    ...normalizeList(options.extensionUrls),
    ...normalizeList(extension.cloudUrls),
    ...normalizeList(extension.cloudUrl),
    ...normalizeList(extension.url),
    ...extensionUrlsFromEnv(options.env || process.env)
  ].filter((url) => /^https?:\/\//i.test(url));
}

function extensionIdsFromOptions(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  return [
    ...normalizeList(options.extensionIds),
    ...normalizeList(options.extensionId),
    ...normalizeList(extension.ids),
    ...normalizeList(extension.id),
    ...listEnv(env, 'TESTMU_EXTENSION_ID'),
    ...listEnv(env, 'TESTMU_EXTENSION_IDS'),
    ...listEnv(env, 'TESTMU_LAMBDA_EXTENSION_IDS')
  ];
}

function testMuExtensionVersion(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  const explicit = stringValue(options.extensionVersion) ||
    stringValue(extension.version) ||
    envValue(env, 'TESTMU_EXTENSION_VERSION');
  if (explicit) return explicit;
  return stringValue(resolveAutomationZipArtifact(options).version) || 'unknown';
}

async function registerCloudUrls(client, urls, options = {}) {
  const extensionIds = [];
  for (const url of urls) {
    let extension;
    if (client.extensions && typeof client.extensions.registerCloudExtension === 'function') {
      extension = await client.extensions.registerCloudExtension(url, {
        name: 'OWASP Penetration Testing Kit Automation',
        description: 'OWASP Penetration Testing Kit Automation'
      });
    } else if (client.extensions && typeof client.extensions.register === 'function') {
      extension = await client.extensions.register({
        name: 'OWASP Penetration Testing Kit Automation',
        version: testMuExtensionVersion(options),
        cloudUrl: url
      });
    } else {
      throw new Error('TestMu Browser Cloud SDK does not expose an extension cloud registration method.');
    }
    if (!extension || !extension.id) throw new Error('TestMu cloud extension registration did not return an id.');
    extensionIds.push(extension.id);
  }
  return {
    source: 'env-url',
    extensionIds,
    cloudUrls: urls.slice()
  };
}

async function resolveRegisteredExtensionIds(client, extensionIds) {
  if (!extensionIds.length) return null;
  if (!client.extensions || typeof client.extensions.getCloudUrls !== 'function') {
    throw new Error('TestMu Browser Cloud SDK does not expose extension ID lookup.');
  }
  const cloudUrls = await client.extensions.getCloudUrls(extensionIds);
  if (cloudUrls.length >= extensionIds.length) {
    return {
      source: 'env-id',
      extensionIds: extensionIds.slice(),
      cloudUrls
    };
  }
  throw new Error(
    'TESTMU_EXTENSION_ID/TESTMU_EXTENSION_IDS did not resolve to a cloud extension URL. ' +
    'TestMu extension IDs are local SDK registry IDs; set TESTMU_EXTENSIONS_DIR to the directory containing their metadata, ' +
    'or use TESTMU_EXTENSION_CLOUD_URL / TESTMU_UPLOAD_EXTENSION=1.'
  );
}

function curlConfigValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sanitizeUploadResponse(text) {
  return String(text || '').replace(/https?:\/\/[^"\s]+/g, '[url]');
}

function parseLambdaTestUploadResponse(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch (_) {
    throw new Error(`Invalid TestMu extension upload response: ${sanitizeUploadResponse(text)}`);
  }
  if (result.data && Array.isArray(result.data) && result.data.length > 0) {
    const entry = result.data[0];
    if (entry.error) throw new Error(`TestMu extension upload error: ${entry.error}`);
    if (entry.s3_url) return entry.s3_url;
    if (entry.url) return entry.url;
  }
  if (result.data && result.data.s3_url) return result.data.s3_url;
  if (result.data && result.data.url) return result.data.url;
  throw new Error(`TestMu extension upload did not return a cloud URL: ${sanitizeUploadResponse(text)}`);
}

function uploadTestMuExtension(artifact, credentials, options = {}) {
  const uploadUrl = options.uploadUrl || LAMBDATEST_EXTENSION_UPLOAD_URL;
  const curlConfig = [
    'silent',
    'show-error',
    'location',
    `request = ${curlConfigValue('POST')}`,
    `url = ${curlConfigValue(uploadUrl)}`,
    `user = ${curlConfigValue(`${credentials.username}:${credentials.accessKey}`)}`,
    `form = ${curlConfigValue(`extensions=@${artifact.path}`)}`
  ].join('\n');

  const result = spawnSync('curl', ['--config', '-'], {
    input: `${curlConfig}\n`,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Unable to run curl for TestMu extension upload: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `TestMu extension upload failed with curl exit ${result.status}: ` +
      sanitizeUploadResponse(result.stderr || result.stdout || '')
    );
  }
  return parseLambdaTestUploadResponse(result.stdout);
}

function isTestMuSdkUploadFallbackError(error) {
  const message = String(error && error.message || error || '');
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|credentials? not configured|invalid credentials?/i.test(message)) {
    return false;
  }
  return /\b400\b.*unable to upload file|unable to upload file|fetch failed|form-data|multipart|econn(?:reset|refused|aborted)|etimedout|timed?\s*out|socket hang up/i.test(message);
}

async function uploadTestMuExtensionWithFallback(client, artifact, credentials, options = {}) {
  const sdkUploader = client && client.extensions && client.extensions.uploadToLambdaTest;
  if (typeof sdkUploader === 'function') {
    try {
      const cloudUrl = await sdkUploader.call(client.extensions, artifact.path);
      if (!/^https:\/\//i.test(String(cloudUrl || ''))) {
        throw new Error('TestMu SDK upload did not return an HTTPS cloud URL.');
      }
      return {
        cloudUrl,
        uploadMethod: 'sdk'
      };
    } catch (error) {
      if (!isTestMuSdkUploadFallbackError(error)) throw error;
    }
  }

  return {
    cloudUrl: uploadTestMuExtension(artifact, credentials, options),
    uploadMethod: typeof sdkUploader === 'function' ? 'curl-fallback' : 'curl-sdk-unavailable'
  };
}

function prepareTestMuUploadZip(options = {}, sourceArtifact = null) {
  const env = options.env || process.env;
  const artifact = sourceArtifact || resolveAutomationZipArtifact(options);
  const maxUploadBytes = toNumber(envValue(env, 'TESTMU_EXTENSION_UPLOAD_MAX_BYTES'), DEFAULT_EXTENSION_UPLOAD_MAX_BYTES);
  if (maxUploadBytes <= 0 || artifact.size <= maxUploadBytes) return artifact;
  if (!toBoolean(envValue(env, 'TESTMU_RECOMPRESS_EXTENSION_ZIP'), true)) return artifact;

  const recompressed = {
    ...recompressAutomationZip(options),
    sourceArtifact: artifact
  };
  if (recompressed.size <= maxUploadBytes) return recompressed;

  const withoutSourceMaps = {
    ...recompressAutomationZip({
      ...options,
      excludeSourceMaps: true
    }),
    sourceArtifact: artifact
  };
  if (withoutSourceMaps.size <= maxUploadBytes) return withoutSourceMaps;

  throw new Error(
    `Packaged PTK extension ZIP is too large for TestMu upload (${artifact.size} bytes), and ` +
    `the smallest generated upload ZIP is still ${withoutSourceMaps.size} bytes. ` +
    'Set TESTMU_EXTENSION_CLOUD_URL to an already hosted extension ZIP or increase TESTMU_EXTENSION_UPLOAD_MAX_BYTES.'
  );
}

async function resolveTestMuBrowserCloudExtension(client, options = {}) {
  const env = options.env || process.env;
  const ids = extensionIdsFromOptions({ ...options, env });
  if (ids.length) return resolveRegisteredExtensionIds(client, ids);

  const urls = extensionUrlsFromOptions({ ...options, env });
  if (urls.length) return registerCloudUrls(client, urls, options);

  const extension = extensionConfigFromOptions(options);
  const shouldUpload = toBoolean(
    options.upload === undefined && extension.upload === undefined
      ? envValue(env, 'TESTMU_UPLOAD_EXTENSION')
      : (options.upload === undefined ? extension.upload : options.upload),
    false
  );
  if (!shouldUpload) {
    throw new Error(
      'TestMu Playwright/Puppeteer needs a provider-hosted PTK extension ZIP. ' +
      'Set TESTMU_EXTENSION_CLOUD_URL, or set TESTMU_UPLOAD_EXTENSION=1 to explicitly upload ' +
      'the packaged automation ZIP to TestMu Browser Cloud.'
    );
  }

  const artifact = prepareTestMuUploadZip(options);
  const credentials = credentialsFromOptions(options);
  const upload = await uploadTestMuExtensionWithFallback(client, artifact, credentials, options);
  const cloudUrl = upload.cloudUrl;
  const registered = await registerCloudUrls(client, [cloudUrl], {
    ...options,
    extensionVersion: artifact.version
  });
  return {
    ...registered,
    source: 'upload',
    uploadMethod: upload.uploadMethod,
    artifact
  };
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

function dimensionsFromEnv(env) {
  const raw = envValue(env, 'TESTMU_RESOLUTION', '1366x768');
  const match = raw.match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function extensionMetadataDir(options = {}) {
  const env = options.env || process.env;
  const extension = extensionConfigFromOptions(options);
  return options.extensionsDir || extension.extensionsDir || envValue(env, 'TESTMU_EXTENSIONS_DIR') || null;
}

function testMuSessionOptions(adapter, credentials, options = {}) {
  const env = options.env || process.env;
  const idleTimeout = toNumber(envValue(env, 'TESTMU_IDLE_TIMEOUT'), 300);
  const platform = envValue(env, 'TESTMU_PLATFORM', envValue(env, 'TESTMU_PLATFORM_NAME', 'Windows 10'));
  const capabilities = capabilityOptions({ ...options, env });
  const capabilityLtOptions = capabilities['LT:Options'] && typeof capabilities['LT:Options'] === 'object'
    ? capabilities['LT:Options']
    : {};
  const { 'LT:Options': _removed, ...capabilityRest } = capabilities;
  const lambdatestOptions = options.lambdatestOptions && typeof options.lambdatestOptions === 'object'
    ? options.lambdatestOptions
    : {};
  const optionLtOptions = options.ltOptions && typeof options.ltOptions === 'object'
    ? options.ltOptions
    : {};
  const lambdatestLtOptions = lambdatestOptions['LT:Options'] && typeof lambdatestOptions['LT:Options'] === 'object'
    ? lambdatestOptions['LT:Options']
    : {};
  const { 'LT:Options': _removedLtOptions, ...lambdatestRest } = lambdatestOptions;
  const frameworkLabel = options.frameworkName || options.frameworkLabel || adapter;
  const build = options.build ||
    envValue(env, 'TESTMU_BUILD') ||
    stringValue(capabilityRest.build) ||
    stringValue(lambdatestRest.build) ||
    stringValue(capabilityLtOptions.build) ||
    stringValue(lambdatestLtOptions.build) ||
    stringValue(optionLtOptions.build) ||
    `PTK ${frameworkLabel} Build`;
  const name = options.name ||
    envValue(env, 'TESTMU_NAME') ||
    stringValue(capabilityRest.name) ||
    stringValue(lambdatestRest.name) ||
    stringValue(capabilityLtOptions.name) ||
    stringValue(lambdatestLtOptions.name) ||
    stringValue(optionLtOptions.name) ||
    `PTK Juice Shop ${frameworkLabel}`;
  return {
    idleTimeout,
    session: {
      timeout: idleTimeout * 1000,
      headless: toBoolean(options.headless === undefined ? envValue(env, 'TESTMU_HEADLESS') : options.headless, false),
      dimensions: dimensionsFromEnv(env),
      lambdatestOptions: {
        ...capabilityRest,
        ...lambdatestRest,
        build,
        name,
        'LT:Options': {
          user: credentials.username,
          username: credentials.username,
          accessKey: credentials.accessKey,
          platform,
          platformName: platform,
          build,
          name,
          network: true,
          video: true,
          console: true,
          idleTimeout,
          ...capabilityLtOptions,
          ...lambdatestLtOptions,
          ...optionLtOptions
        }
      }
    }
  };
}

async function createTestMuBrowserCloudSession(adapter, options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const sdk = options.client ? null : loadBrowserCloudSdk();
  const client = options.client || new sdk.Browser();
  if (!client.extensions || typeof client.extensions.setConfig !== 'function') {
    throw new Error('TestMu Browser Cloud SDK does not expose extension configuration.');
  }
  const configuredExtensionsDir = extensionMetadataDir({ ...options, env });
  const sdkExtensionsDir = configuredExtensionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-testmu-browser-cloud-extensions-'));

  client.extensions.setConfig({
    username: credentials.username,
    accessKey: credentials.accessKey,
    extensionsDir: sdkExtensionsDir,
    verbose: false
  });

  try {
    const extension = await resolveTestMuBrowserCloudExtension(client, {
      ...options,
      env
    });
    const resolved = testMuSessionOptions(adapter, credentials, { ...options, env });
    const session = await client.sessions.create({
      adapter,
      extensionIds: extension.extensionIds,
      ...resolved.session
    });
    if (!configuredExtensionsDir) session.ptkSdkExtensionsDir = sdkExtensionsDir;

    return {
      client,
      extension,
      session,
      sdkExtensionsDir,
      sdkPackageName: sdk ? sdk.packageName : 'injected'
    };
  } catch (error) {
    if (!configuredExtensionsDir) {
      fs.rmSync(sdkExtensionsDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function releaseTestMuBrowserCloudSession(client, session, options = {}) {
  if (client && session && session.id) {
    await client.sessions.release(session.id).catch((error) => {
      const env = options.env || process.env;
      console.warn(`TestMu Browser Cloud release failed: ${safeProviderErrorMessage(error, [
        options.username || envValue(env, 'LT_USERNAME') || envValue(env, 'TESTMU_USERNAME'),
        options.accessKey || envValue(env, 'LT_ACCESS_KEY') || envValue(env, 'TESTMU_ACCESS_KEY')
      ])}`);
    });
  }
  if (session && session.ptkSdkExtensionsDir) {
    fs.rmSync(session.ptkSdkExtensionsDir, { recursive: true, force: true });
  }
}

function existingPlaywrightPage(browser) {
  const context = browser.contexts()[0] || null;
  const page = context && context.pages().find((candidate) => !candidate.isClosed()) || null;
  return { context, page };
}

function safeTestMuExtension(extension) {
  const cloudUrls = Array.isArray(extension && extension.cloudUrls) ? extension.cloudUrls : [];
  return safeProviderMetadata(extension, cloudUrls);
}

function testMuSessionAdapterForPlaywrightTransport(playwrightTransport) {
  // TestMu Browser Cloud exposes its CDP websocket through this SDK adapter.
  return playwrightTransport === 'playwright'
    ? TESTMU_PLAYWRIGHT_NATIVE_SESSION_ADAPTER
    : TESTMU_PLAYWRIGHT_CDP_SESSION_ADAPTER;
}

async function connectTestMuPlaywright(options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const rawMode = options.connectMode || envValue(env, 'TESTMU_PLAYWRIGHT_CONNECT_MODE') || 'cdp';
  const playwrightTransport = String(rawMode).trim().toLowerCase() === 'playwright' ? 'playwright' : 'cdp';
  const cloud = await createTestMuBrowserCloudSession(testMuSessionAdapterForPlaywrightTransport(playwrightTransport), {
    ...options,
    env,
    frameworkName: options.frameworkName || 'Playwright'
  });
  const playwright = loadPlaywright(options);
  const chromium = options.chromium || playwright.chromium;
  const timeout = toNumber(options.connectTimeoutMs || envValue(env, 'TESTMU_CONNECT_TIMEOUT_MS'), 60000);
  let browser;
  try {
    browser = playwrightTransport === 'playwright'
      ? await chromium.connect({
          wsEndpoint: cloud.session.websocketUrl,
          timeout,
          ...(options.connectOptions || {})
        })
      : await chromium.connectOverCDP(cloud.session.websocketUrl, {
          timeout,
          ...(options.connectOptions || {})
        });
    const existing = existingPlaywrightPage(browser);
    if (!existing.context) {
      throw new Error('TestMu session did not expose the extension-bearing default Playwright context.');
    }
    const context = existing.context;
    const page = existing.page || await context.newPage();
    let closed = false;
    const connection = {
      extension: safeTestMuExtension(cloud.extension),
      sessionInfo: safeProviderMetadata(cloud.session, [
        cloud.session.websocketUrl,
        credentials.username,
        credentials.accessKey
      ]),
      sdkExtensionsDir: cloud.sdkExtensionsDir,
      sdkPackageName: cloud.sdkPackageName,
      browser,
      context,
      page,
      framework: 'playwright',
      connectMode: playwrightTransport,
      playwrightTransport,
      testMuSessionKind: playwrightTransport === 'playwright' ? 'playwright-native' : 'playwright-cdp',
      async close() {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
        await releaseTestMuBrowserCloudSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await releaseTestMuBrowserCloudSession(cloud.client, cloud.session, options);
    throw error;
  }
}

async function connectTestMuPuppeteer(options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const cloud = await createTestMuBrowserCloudSession(TESTMU_PUPPETEER_SESSION_ADAPTER, {
    ...options,
    env,
    frameworkName: options.frameworkName || 'Puppeteer'
  });
  const puppeteer = loadPuppeteer(options);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: cloud.session.websocketUrl,
      ...(options.connectOptions || {})
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => typeof candidate.isClosed !== 'function' || !candidate.isClosed()) || await browser.newPage();
    let closed = false;
    const connection = {
      extension: safeTestMuExtension(cloud.extension),
      sessionInfo: safeProviderMetadata(cloud.session, [
        cloud.session.websocketUrl,
        credentials.username,
        credentials.accessKey
      ]),
      sdkExtensionsDir: cloud.sdkExtensionsDir,
      sdkPackageName: cloud.sdkPackageName,
      browser,
      page,
      framework: 'puppeteer',
      async close() {
        if (closed) return;
        closed = true;
        if (typeof browser.isConnected !== 'function' || browser.isConnected()) {
          await browser.close().catch(() => {});
        }
        await releaseTestMuBrowserCloudSession(cloud.client, cloud.session, options);
      }
    };
    definePrivateProperty(connection, 'client', cloud.client);
    return definePrivateProperty(connection, 'session', cloud.session);
  } catch (error) {
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      await browser.close().catch(() => {});
    }
    await releaseTestMuBrowserCloudSession(cloud.client, cloud.session, options);
    throw error;
  }
}

function testMuSeleniumRemoteUrl(options = {}) {
  const env = options.env || process.env;
  const explicit = options.remoteUrl || envValue(env, 'TESTMU_REMOTE_URL');
  if (explicit) return explicit;
  const credentials = credentialsFromOptions(options);
  return `https://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.accessKey)}@hub.lambdatest.com/wd/hub`;
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

function createTestMuSeleniumCapabilities(options = {}) {
  const env = options.env || process.env;
  const credentials = credentialsFromOptions(options);
  const custom = options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : parseJsonEnv(env, 'TESTMU_CAPABILITIES_JSON', {});
  const crx = resolvePtkCrxArtifact({
    packageRoot: options.packageRoot,
    cacheRoot: options.cacheRoot || envValue(env, 'PTK_EXTENSION_CACHE_DIR') || path.resolve('.ptk'),
    keyPath: options.keyPath
  });
  const ptkExtension = fs.readFileSync(crx.path).toString('base64');
  const baseLtOptions = {
    username: credentials.username,
    accessKey: credentials.accessKey,
    build: options.build || envValue(env, 'TESTMU_BUILD', 'PTK Selenium Build'),
    name: options.name || envValue(env, 'TESTMU_NAME', 'PTK Selenium'),
    project: options.project || envValue(env, 'PTK_PROJECT', 'ptk-testmu-selenium'),
    network: true,
    video: true,
    console: true,
    w3c: true
  };
  const customChrome = custom['goog:chromeOptions'] && typeof custom['goog:chromeOptions'] === 'object'
    ? custom['goog:chromeOptions']
    : {};
  const customEdge = custom['ms:edgeOptions'] && typeof custom['ms:edgeOptions'] === 'object'
    ? custom['ms:edgeOptions']
    : {};
  const customLt = custom['LT:Options'] && typeof custom['LT:Options'] === 'object'
    ? custom['LT:Options']
    : {};
  const { 'goog:chromeOptions': _chrome, 'ms:edgeOptions': _edge, 'LT:Options': _lt, ...restCustom } = custom;
  const browserName = options.browserName ||
    stringValue(custom.browserName) ||
    envValue(env, 'TESTMU_BROWSER', envValue(env, 'TESTMU_BROWSER_NAME', 'Chrome'));
  const extensionOptionsKey = isEdgeBrowserName(browserName) ? 'ms:edgeOptions' : 'goog:chromeOptions';
  const extensionOptions = mergeChromeOptions({
    extensions: [ptkExtension]
  }, extensionOptionsKey === 'ms:edgeOptions' ? customEdge : customChrome);
  return {
    browserName,
    browserVersion: options.browserVersion || envValue(env, 'TESTMU_BROWSER_VERSION', 'latest'),
    platformName: options.platformName || envValue(env, 'TESTMU_PLATFORM_NAME', envValue(env, 'TESTMU_PLATFORM', 'Windows 10')),
    ...restCustom,
    [extensionOptionsKey]: extensionOptions,
    'LT:Options': {
      ...baseLtOptions,
      ...customLt
    }
  };
}

async function connectTestMuSelenium(options = {}) {
  const webdriver = loadSeleniumWebDriver(options);
  const credentials = credentialsFromOptions(options);
  const remoteUrl = testMuSeleniumRemoteUrl(options);
  const capabilities = createTestMuSeleniumCapabilities(options);
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

module.exports = {
  connectTestMuPlaywright,
  connectTestMuPuppeteer,
  connectTestMuSelenium,
  createTestMuSeleniumCapabilities,
  createTestMuBrowserCloudSession,
  credentialsFromOptions,
  prepareTestMuUploadZip,
  releaseTestMuBrowserCloudSession,
  resolveTestMuBrowserCloudExtension,
  isTestMuSdkUploadFallbackError,
  testMuSeleniumRemoteUrl,
  uploadTestMuExtension,
  uploadTestMuExtensionWithFallback
};
