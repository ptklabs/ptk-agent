'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PROVIDERS_ROOT = path.resolve(__dirname, '../../../../providers');
const loadProvider = name => require(path.join(PROVIDERS_ROOT, name, 'index.cjs'));

const REQUIRED_EXPORTS = {
  testmu: [
    'connectTestMuPlaywright',
    'connectTestMuPuppeteer',
    'connectTestMuSelenium',
    'createTestMuBrowserCloudSession',
    'resolveTestMuBrowserCloudExtension'
  ],
  browserstack: [
    'connectBrowserStackPlaywright',
    'connectBrowserStackPuppeteer',
    'connectBrowserStackSelenium',
    'browserStackWsEndpoint'
  ],
  browserbase: [
    'connectBrowserbasePlaywright',
    'connectBrowserbasePuppeteer',
    'connectBrowserbaseSelenium',
    'resolveBrowserbaseExtensionId'
  ],
  browserless: [
    'connectBrowserlessPlaywright',
    'connectBrowserlessPuppeteer',
    'browserlessWsEndpoint'
  ],
  hyperbrowser: [
    'connectHyperbrowserPlaywright',
    'connectHyperbrowserPuppeteer',
    'connectHyperbrowserSelenium',
    'resolveHyperbrowserExtensionId'
  ],
  steel: [
    'connectSteelPlaywright',
    'connectSteelPuppeteer',
    'connectSteelSelenium',
    'resolveSteelExtensionId'
  ]
};

test('all promoted cloud-provider modules expose their supported framework contracts', () => {
  for (const [providerName, exports] of Object.entries(REQUIRED_EXPORTS)) {
    const provider = loadProvider(providerName);
    for (const exportName of exports) {
      assert.equal(typeof provider[exportName], 'function', `${providerName}.${exportName}`);
    }
  }
});

test('TestMu accepts explicit registered extensions and resolves them without upload', async () => {
  const provider = loadProvider('testmu');
  const result = await provider.resolveTestMuBrowserCloudExtension({
    extensions: {
      async getCloudUrls(ids) {
        assert.deepEqual(ids, ['registered-ptk-extension']);
        return ['https://extensions.example.test/ptk.zip'];
      }
    }
  }, {
    env: {},
    extensionId: 'registered-ptk-extension'
  });
  assert.deepEqual(result, {
    source: 'env-id',
    extensionIds: ['registered-ptk-extension'],
    cloudUrls: ['https://extensions.example.test/ptk.zip']
  });
  assert.throws(() => provider.credentialsFromOptions({ env: {} }), /LT_USERNAME|TESTMU_USERNAME/);
});

test('TestMu supports the documented object registration shape with explicit artifact version', async () => {
  const provider = loadProvider('testmu');
  const registrations = [];
  const result = await provider.resolveTestMuBrowserCloudExtension({
    extensions: {
      async register(payload) {
        registrations.push(payload);
        return { id: 'documented-registration-id' };
      }
    }
  }, {
    env: {},
    extensionUrls: ['https://extensions.example.test/ptk-automation.zip'],
    extensionVersion: '9.9.8'
  });
  assert.deepEqual(registrations, [{
    name: 'OWASP Penetration Testing Kit Automation',
    version: '9.9.8',
    cloudUrl: 'https://extensions.example.test/ptk-automation.zip'
  }]);
  assert.deepEqual(result, {
    source: 'env-url',
    extensionIds: ['documented-registration-id'],
    cloudUrls: ['https://extensions.example.test/ptk-automation.zip']
  });
});

test('TestMu prefers SDK upload and limits curl fallback to recognized transport failures', async () => {
  const provider = loadProvider('testmu');
  const uploadedPaths = [];
  const sdkResult = await provider.uploadTestMuExtensionWithFallback({
    extensions: {
      async uploadToLambdaTest(filePath) {
        uploadedPaths.push(filePath);
        return 'https://extensions.example.test/sdk-upload.zip';
      }
    }
  }, { path: '/tmp/ptk-automation.zip' }, {
    username: 'provider-user',
    accessKey: 'provider-access-key'
  });
  assert.deepEqual(uploadedPaths, ['/tmp/ptk-automation.zip']);
  assert.deepEqual(sdkResult, {
    cloudUrl: 'https://extensions.example.test/sdk-upload.zip',
    uploadMethod: 'sdk'
  });
  assert.equal(provider.isTestMuSdkUploadFallbackError(new Error('400 - Unable to upload file')), true);
  assert.equal(provider.isTestMuSdkUploadFallbackError(new Error('fetch failed: socket hang up')), true);
  assert.equal(provider.isTestMuSdkUploadFallbackError(new Error('401 Unauthorized')), false);
  assert.equal(provider.isTestMuSdkUploadFallbackError(new Error('403 Forbidden')), false);
  await assert.rejects(() => provider.uploadTestMuExtensionWithFallback({
    extensions: {
      async uploadToLambdaTest() {
        throw new Error('401 Unauthorized');
      }
    }
  }, { path: '/tmp/ptk-automation.zip' }, {
    username: 'provider-user',
    accessKey: 'provider-access-key'
  }), /401 Unauthorized/);
});

test('TestMu session setup does not mutate process credentials', async () => {
  const provider = loadProvider('testmu');
  const beforeUsername = process.env.LT_USERNAME;
  const beforeAccessKey = process.env.LT_ACCESS_KEY;
  const extensionConfigs = [];
  const sessionRequests = [];
  const client = {
    extensions: {
      setConfig(config) {
        extensionConfigs.push(config);
      },
      async getCloudUrls(ids) {
        assert.deepEqual(ids, ['registered-ptk-extension']);
        return ['https://extensions.example.test/ptk.zip'];
      }
    },
    sessions: {
      async create(payload) {
        sessionRequests.push(payload);
        return { id: 'testmu-session', websocketUrl: 'wss://browser.example.test/session' };
      },
      async release() {}
    }
  };
  const cloud = await provider.createTestMuBrowserCloudSession('puppeteer', {
    client,
    env: {
      LT_USERNAME: 'provider-user',
      LT_ACCESS_KEY: 'provider-access-key'
    },
    extensionId: 'registered-ptk-extension',
    extensionsDir: '/tmp/testmu-extension-metadata'
  });
  assert.equal(extensionConfigs.length, 1);
  assert.equal(sessionRequests.length, 1);
  assert.equal(sessionRequests[0].adapter, 'puppeteer');
  assert.deepEqual(sessionRequests[0].extensionIds, ['registered-ptk-extension']);
  assert.equal(cloud.sdkPackageName, 'injected');
  assert.equal(process.env.LT_USERNAME, beforeUsername);
  assert.equal(process.env.LT_ACCESS_KEY, beforeAccessKey);
});

test('TestMu recommended Playwright connection metadata redacts SDK user aliases', async () => {
  const provider = loadProvider('testmu');
  const username = 'testmu-user-secret';
  const accessKey = 'testmu-access-secret';
  const websocketUrl = `wss://${username}:${accessKey}@provider.example.test/session`;
  const page = { isClosed() { return false; } };
  const context = { pages() { return [page]; } };
  const client = {
    extensions: {
      setConfig() {},
      async getCloudUrls() { return ['https://provider.example.test/extension.zip']; }
    },
    sessions: {
      async create() {
        return {
          id: 'testmu-session',
          websocketUrl,
          config: { lambdatestOptions: { 'LT:Options': { user: username, accessKey } } }
        };
      },
      async release() {}
    }
  };
  const connection = await provider.connectTestMuPlaywright({
    env: {},
    username,
    accessKey,
    extensionId: 'registered-extension',
    client,
    extensionsDir: '/tmp/testmu-extension-metadata',
    playwright: { chromium: {} },
    chromium: {
      async connectOverCDP() {
        return {
          contexts() { return [context]; },
          async close() {}
        };
      }
    }
  });
  const serialized = JSON.stringify(connection);
  assert.doesNotMatch(serialized, /testmu-user-secret|testmu-access-secret/);
  assert.match(serialized, /\[redacted\]/);
  await connection.close();
});

test('BrowserStack builds an extension-enabled CDP contract and rejects missing credentials', () => {
  const provider = loadProvider('browserstack');
  assert.throws(() => provider.credentialsFromOptions({ env: {} }), /BROWSERSTACK_USERNAME/);
  const result = provider.browserStackWsEndpoint('playwright', {
    env: {},
    username: 'provider-user',
    accessKey: 'provider-access-key',
    extension: { mediaUrl: 'media://ptk-extension' }
  });
  assert.match(result.wsEndpoint, /^wss:\/\/cdp\.browserstack\.com\/playwright\?caps=/);
  assert.equal(result.capabilities['browserstack.username'], 'provider-user');
  assert.equal(result.capabilities['browserstack.accessKey'], 'provider-access-key');
  assert.deepEqual(result.capabilities['browserstack.uploadMedia'], ['media://ptk-extension']);
});

test('Browserbase explicit extension IDs bypass upload and preserve validation state', async () => {
  const provider = loadProvider('browserbase');
  assert.deepEqual(await provider.resolveBrowserbaseExtensionId({
    env: {},
    extensionId: 'ext_ptk_123'
  }), {
    extensionId: 'ext_ptk_123',
    source: 'env'
  });
  const summary = provider.browserbaseValidationSummary('playwright', {
    env: {},
    apiKey: 'provider-api-key',
    extensionId: 'ext_ptk_123'
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.targetUrl, null);
  assert.equal(summary.browserbase.extensionIdConfigured, true);
  assert.equal(summary.browserbase.willUploadExtensionIfRun, false);
});

test('Browserbase releases a created session when browser connection setup fails', async () => {
  const provider = loadProvider('browserbase');
  const originalFetch = global.fetch;
  const requests = [];
  let browserCloseCount = 0;
  global.fetch = async (url, request) => {
    requests.push({ url: String(url), body: request && request.body });
    const releasing = typeof request.body === 'string' && request.body.includes('REQUEST_RELEASE');
    const payload = releasing
      ? { status: 'RELEASE_REQUESTED' }
      : {
          id: 'browserbase-session',
          connectUrl: 'wss://connect.browserbase.test?token=provider-session-token',
          signingKey: 'provider-signing-key'
        };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(payload); }
    };
  };
  try {
    await assert.rejects(() => provider.connectBrowserbasePlaywright({
      env: {},
      apiKey: 'browserbase-api-key',
      extensionId: 'browserbase-extension',
      playwright: { chromium: {} },
      chromium: {
        async connectOverCDP() {
          return {
            contexts() { return []; },
            async close() { browserCloseCount += 1; }
          };
        }
      }
    }), /extension-bearing default Playwright context/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(browserCloseCount, 1);
  assert.equal(requests.filter((request) => String(request.body).includes('REQUEST_RELEASE')).length, 1);
});

test('Browserbase Selenium extends the async script timeout for PTK stop and export', async () => {
  const provider = loadProvider('browserbase');
  const originalFetch = global.fetch;
  let configuredTimeouts = null;
  global.fetch = async (_url, request) => {
    const releasing = typeof request.body === 'string' && request.body.includes('REQUEST_RELEASE');
    const payload = releasing
      ? { status: 'RELEASE_REQUESTED' }
      : {
          id: 'browserbase-selenium-session',
          seleniumRemoteUrl: 'https://selenium.browserbase.test/wd/hub',
          signingKey: 'provider-signing-key'
        };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(payload); }
    };
  };
  class Builder {
    forBrowser() { return this; }
    usingHttpAgent() { return this; }
    usingServer() { return this; }
    withCapabilities() { return this; }
    async build() {
      return {
        manage() {
          return {
            async setTimeouts(value) { configuredTimeouts = value; }
          };
        },
        async quit() {}
      };
    }
  }
  try {
    const connection = await provider.connectBrowserbaseSelenium({
      env: {},
      apiKey: 'provider-api-key',
      extensionId: 'provider-extension',
      seleniumWebDriver: { Builder }
    });
    assert.deepEqual(configuredTimeouts, { script: 120000 });
    await connection.close();
  } finally {
    global.fetch = originalFetch;
  }
});

test('Browserless endpoint includes the configured PTK extension and bounded timeouts', () => {
  const provider = loadProvider('browserless');
  assert.throws(() => provider.credentialsFromOptions({ env: {} }), /BROWSERLESS_API_KEY/);
  const result = provider.browserlessWsEndpoint({
    env: {},
    apiKey: 'provider-api-key',
    endpoint: 'wss://production-sfo.browserless.io',
    extensionName: 'ptk-automation',
    timeoutMs: 45000
  });
  const url = new URL(result.wsEndpoint);
  assert.equal(url.searchParams.get('token'), 'provider-api-key');
  assert.equal(url.searchParams.get('timeout'), '45000');
  assert.deepEqual(JSON.parse(url.searchParams.get('launch')).extensions, ['ptk-automation']);
  assert.equal(result.connectTimeoutMs, 75000);
  assert.equal(provider.browserlessValidationSummary('playwright', {
    env: {},
    apiKey: 'provider-api-key',
    extensionName: 'ptk-automation'
  }).targetUrl, null);
  const selenium = provider.browserlessValidationSummary('selenium', {
    env: {},
    apiKey: 'provider-api-key',
    extensionName: 'ptk-automation'
  });
  assert.equal(selenium.ok, false);
  assert.equal(selenium.browserless.frameworkSupported, false);
  assert.match(selenium.browserless.unsupportedReason, /does not expose Selenium\/WebDriver/);
});

test('Hyperbrowser accepts explicit extension ids and builds the documented session contract', async () => {
  const provider = loadProvider('hyperbrowser');
  const client = { extensions: {}, sessions: {} };
  assert.equal(provider.createHyperbrowserClient({ client }), client);
  assert.throws(() => provider.hyperbrowserCredentials({ env: {} }), /HYPERBROWSER_API_KEY/);
  assert.deepEqual(await provider.resolveHyperbrowserExtensionId(client, {
    env: {},
    extensionId: 'hyperbrowser-extension'
  }), {
    extensionId: 'hyperbrowser-extension',
    source: 'env'
  });
  assert.deepEqual(provider.hyperbrowserSessionOptions('hyperbrowser-extension', {
    sessionOptions: {
      acceptCookies: true,
      extensionIds: ['existing-extension']
    }
  }), {
    acceptCookies: true,
    extensionIds: ['existing-extension', 'hyperbrowser-extension']
  });
});

test('Hyperbrowser enforces its documented Chromium ZIP and 8 MB upload boundary', () => {
  const provider = loadProvider('hyperbrowser');
  const artifact = { type: 'zip', format: 'zip', size: 3_399_644 };
  assert.equal(provider.assertHyperbrowserExtensionArtifact(artifact), artifact);
  assert.throws(
    () => provider.assertHyperbrowserExtensionArtifact({ type: 'crx', size: 1000 }),
    /Chromium ZIP/
  );
  assert.throws(
    () => provider.assertHyperbrowserExtensionArtifact({ type: 'zip', size: 8 * 1024 * 1024 + 1 }),
    /8 MB or smaller/
  );
});

test('Hyperbrowser releases a paid session when the extension-bearing Playwright context is missing', async () => {
  const provider = loadProvider('hyperbrowser');
  const stopped = [];
  let browserCloseCount = 0;
  const client = {
    extensions: {},
    sessions: {
      async create(payload) {
        assert.deepEqual(payload, { extensionIds: ['hyperbrowser-extension'] });
        return {
          id: 'hyperbrowser-session',
          token: 'hyperbrowser-session-token',
          wsEndpoint: 'wss://connect.hyperbrowser.test?token=hyperbrowser-session-token'
        };
      },
      async stop(id) { stopped.push(id); }
    }
  };
  await assert.rejects(() => provider.connectHyperbrowserPlaywright({
    client,
    env: {},
    apiKey: 'hyperbrowser-api-key',
    extensionId: 'hyperbrowser-extension',
    playwright: { chromium: {} },
    chromium: {
      async connectOverCDP() {
        return {
          contexts() { return []; },
          async close() { browserCloseCount += 1; }
        };
      }
    }
  }), /extension-bearing default Playwright context/);
  assert.equal(browserCloseCount, 1);
  assert.deepEqual(stopped, ['hyperbrowser-session']);
});

test('Hyperbrowser Selenium authenticates WebDriver commands and cleans up idempotently', async () => {
  const provider = loadProvider('hyperbrowser');
  const originalAddRequest = https.Agent.prototype.addRequest;
  const headers = new Map();
  https.Agent.prototype.addRequest = () => {};
  try {
    const agent = provider.hyperbrowserHttpAgent({
      webdriverEndpoint: 'https://webdriver.hyperbrowser.test',
      token: 'hyperbrowser-session-token'
    });
    agent.addRequest({ setHeader(name, value) { headers.set(name, value); } }, {});
  } finally {
    https.Agent.prototype.addRequest = originalAddRequest;
  }
  assert.equal(headers.get('x-hyperbrowser-token'), 'hyperbrowser-session-token');

  const stopped = [];
  let configuredTimeouts = null;
  let quitCount = 0;
  let configuredAgent = null;
  let configuredServer = null;
  let configuredChromeOptions = null;
  let buildAttempts = 0;
  const client = {
    extensions: {},
    sessions: {
      async create(payload) {
        assert.deepEqual(payload, { extensionIds: ['hyperbrowser-extension'] });
        return {
          id: 'hyperbrowser-selenium-session',
          token: 'hyperbrowser-session-token',
          webdriverEndpoint: 'https://webdriver.hyperbrowser.test'
        };
      },
      async stop(id) { stopped.push(id); }
    }
  };
  class Options {}
  class Builder {
    forBrowser(name) { assert.equal(name, 'chrome'); return this; }
    usingHttpAgent(agent) { configuredAgent = agent; return this; }
    usingServer(server) { configuredServer = server; return this; }
    setChromeOptions(options) { configuredChromeOptions = options; return this; }
    withCapabilities() { return this; }
    async build() {
      buildAttempts += 1;
      if (buildAttempts < 3) {
        throw new Error('Unable to parse new session response: {"code":"internal_error","message":"selenium server not ready after 5s","retryable":false}');
      }
      return {
        manage() {
          return { async setTimeouts(value) { configuredTimeouts = value; } };
        },
        async quit() { quitCount += 1; }
      };
    }
  }
  const connection = await provider.connectHyperbrowserSelenium({
    client,
    env: {},
    apiKey: 'hyperbrowser-api-key',
    extensionId: 'hyperbrowser-extension',
    seleniumWebDriver: { Builder },
    seleniumChrome: { Options }
  });
  assert.ok(configuredAgent instanceof https.Agent);
  assert.equal(buildAttempts, 3);
  assert.equal(configuredServer, 'https://webdriver.hyperbrowser.test');
  assert.ok(configuredChromeOptions instanceof Options);
  assert.deepEqual(configuredTimeouts, { script: 120000 });
  assert.doesNotMatch(JSON.stringify(connection), /hyperbrowser-api-key|hyperbrowser-session-token/);
  await connection.close();
  await connection.close();
  assert.equal(quitCount, 1);
  assert.deepEqual(stopped, ['hyperbrowser-selenium-session']);
  assert.equal(provider.isHyperbrowserSeleniumReadinessError(new Error('selenium server not ready after 5s')), true);
  assert.equal(provider.isHyperbrowserSeleniumReadinessError(new Error('401 Unauthorized')), false);
});

test('Steel accepts injected clients and explicit extension IDs without SDK lookup or upload', async () => {
  const provider = loadProvider('steel');
  const client = { sessions: {}, extensions: {} };
  assert.equal(provider.createSteelClient({ client }), client);
  assert.deepEqual(await provider.resolveSteelExtensionId(client, {
    env: {},
    extensionId: 'steel_ptk_123'
  }), {
    extensionId: 'steel_ptk_123',
    source: 'env'
  });
  assert.deepEqual(provider.steelSessionOptions('steel_ptk_123', {
    env: {},
    timeoutMs: 60000
  }), {
    extensionIds: ['steel_ptk_123'],
    timeout: 60000
  });
  assert.equal(
    provider.steelConnectUrl({ id: 'session-id', websocketUrl: 'wss://connect.steel.dev?sessionId=session-id' }, {
      env: {},
      apiKey: 'steel-api-key'
    }),
    'wss://connect.steel.dev?sessionId=session-id&apiKey=steel-api-key'
  );
  assert.equal(
    provider.steelSeleniumRemoteUrl({ env: {} }),
    'https://connect.steelbrowser.com/selenium'
  );
});

test('Steel uses the SDK uploadable stream path instead of recursively expanding a Buffer', () => {
  const source = fs.readFileSync(path.join(PROVIDERS_ROOT, 'steel', 'src', 'index.cjs'), 'utf8');
  assert.match(source, /file:\s*fs\.createReadStream\(artifact\.path\)/);
  assert.doesNotMatch(source, /file:\s*fs\.readFileSync\(artifact\.path\)/);
});

test('Steel Selenium passes the packaged extension through ChromeDriver capabilities', () => {
  const provider = loadProvider('steel');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-steel-selenium-'));
  try {
    const artifactPath = path.join(tempRoot, 'automation.zip');
    fs.writeFileSync(artifactPath, Buffer.from('extension-zip'));
    const capabilities = provider.steelSeleniumCapabilities({
      env: {},
      extension: { seleniumArtifact: { path: artifactPath } },
      capabilities: {
        'goog:chromeOptions': {
          args: ['--window-size=1280,800'],
          extensions: ['existing-extension']
        }
      }
    });
    assert.deepEqual(capabilities['goog:chromeOptions'], {
      args: ['--window-size=1280,800'],
      extensions: ['existing-extension', Buffer.from('extension-zip').toString('base64')]
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Steel Selenium provisions an extension-bearing WebDriver session with authenticated commands', async () => {
  const provider = loadProvider('steel');
  const created = [];
  const released = [];
  let requestClient = null;
  let configuredTimeouts = null;
  let quitCount = 0;
  let sessionAttempts = 0;
  const readinessWaits = [];
  const client = {
    extensions: {},
    sessions: {
      async create(payload) {
        created.push(payload);
        return { id: 'steel-selenium-session' };
      },
      async release(id) { released.push(id); }
    }
  };
  class HttpClient {
    constructor(url) { this.url = url; }
    async send(request) {
      assert.equal(request.headers.get('steel-api-key'), 'steel-secret');
      assert.equal(request.headers.get('session-id'), 'steel-selenium-session');
      return { body: '{}' };
    }
  }
  class Executor {
    constructor(httpClient) {
      requestClient = httpClient;
    }
  }
  const seleniumWebDriver = {
    WebDriver: {
      createSession(executor, capabilities) {
        assert.ok(executor instanceof Executor);
        assert.deepEqual(capabilities, {
          browserName: 'chrome',
          'goog:chromeOptions': { extensions: ['steel-selenium-crx'] }
        });
        sessionAttempts += 1;
        const currentAttempt = sessionAttempts;
        return {
          async getSession() {
            if (currentAttempt < 3) {
              throw new Error('connect ECONNREFUSED 127.0.0.1:4444');
            }
            return { id: 'webdriver-session' };
          },
          manage() {
            return {
              async setTimeouts(value) { configuredTimeouts = value; }
            };
          },
          async quit() { quitCount += 1; }
        };
      }
    }
  };
  const connection = await provider.connectSteelSelenium({
    client,
    env: {},
    apiKey: 'steel-secret',
    extensionId: 'steel-extension',
    extensionBase64: 'steel-selenium-crx',
    seleniumWebDriver,
    seleniumHttp: { HttpClient, Executor },
    seleniumReadinessWait: async (milliseconds) => { readinessWaits.push(milliseconds); }
  });
  assert.deepEqual(created, [{
    extensionIds: ['steel-extension'],
    timeout: 900000,
    isSelenium: true
  }]);
  assert.deepEqual(configuredTimeouts, { script: 120000 });
  assert.equal(sessionAttempts, 3);
  assert.deepEqual(readinessWaits, [500, 1000]);
  const request = { headers: new Map() };
  await requestClient.send(request);
  assert.equal(request.headers.get('steel-api-key'), 'steel-secret');
  assert.equal(request.headers.get('session-id'), 'steel-selenium-session');
  assert.doesNotMatch(JSON.stringify(connection), /steel-secret/);
  await connection.close();
  await connection.close();
  assert.equal(quitCount, 3);
  assert.deepEqual(released, ['steel-selenium-session']);
});

test('BrowserStack Playwright uses the documented extension capability casing and runtime diagnostics', async () => {
  const provider = loadProvider('browserstack');
  const endpoint = provider.browserStackWsEndpoint('playwright', {
    env: {},
    username: 'provider-user',
    accessKey: 'provider-access-key',
    extension: { mediaUrl: 'media://ptk-extension' },
    osVersion: '10'
  });
  assert.equal(endpoint.capabilities.osVersion, '10');
  assert.equal(endpoint.capabilities.os_version, undefined);
  assert.equal(endpoint.capabilities.os, 'windows');
  assert.equal(endpoint.capabilities.browser_version, undefined);
  const diagnostics = await provider.inspectBrowserStackExtensionRuntime({
    framework: 'puppeteer',
    browser: {
      targets() {
        return [
          { type: () => 'service_worker', url: () => 'chrome-extension://abcdefghijklmnop/background.js' },
          { type: () => 'page', url: () => 'https://example.test/' }
        ];
      }
    }
  });
  assert.deepEqual(diagnostics, {
    extensionTargetCount: 1,
    extensionTargets: [{ type: 'service_worker', origin: 'chrome-extension://abcdefghijklmnop' }],
    extensionLoaded: true,
    sessionDetails: null
  });
});

test('provider upload caches are isolated by opaque account fingerprints', () => {
  const shared = require(path.join(PROVIDERS_ROOT, '_shared', 'src', 'index.cjs'));
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-provider-cache-contract-'));
  const artifact = { type: 'zip', sha256: 'a'.repeat(64) };
  try {
    const first = shared.accountScopedOptions('browserbase', {
      apiKey: 'account-a-secret',
      projectId: 'project-a'
    }, { cacheRoot });
    const second = shared.accountScopedOptions('browserbase', {
      apiKey: 'account-b-secret',
      projectId: 'project-b'
    }, { cacheRoot });
    const firstPath = shared.cacheFileFor('browserbase', artifact, first);
    const secondPath = shared.cacheFileFor('browserbase', artifact, second);
    assert.notEqual(firstPath, secondPath);
    assert.doesNotMatch(firstPath, /account-a-secret|project-a/);
    assert.doesNotMatch(secondPath, /account-b-secret|project-b/);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('Browserless rejects an extensionless Playwright context and closes the browser', async () => {
  const provider = loadProvider('browserless');
  let closeCount = 0;
  const browser = {
    contexts() { return []; },
    async close() { closeCount += 1; }
  };
  await assert.rejects(() => provider.connectBrowserlessPlaywright({
    env: {},
    apiKey: 'browserless-secret',
    extensionName: 'ptk-automation',
    playwright: { chromium: {} },
    chromium: {
      async connectOverCDP() { return browser; }
    }
  }), /extension-bearing default Playwright context/);
  assert.equal(closeCount, 1);
});

test('recommended BrowserStack connection metadata is safe to serialize', async () => {
  const provider = loadProvider('browserstack');
  let closeCount = 0;
  const page = { isClosed() { return false; } };
  const context = { pages() { return [page]; } };
  const cloud = await provider.connectBrowserStackPlaywright({
    env: {},
    username: 'provider-user',
    accessKey: 'provider-access-key',
    extension: { mediaUrl: 'media://ptk-extension' },
    playwright: { chromium: {} },
    chromium: {
      async connectOverCDP() {
        return {
          contexts() { return [context]; },
          async close() { closeCount += 1; }
        };
      }
    }
  });
  const serialized = JSON.stringify({
    capabilities: cloud.capabilities,
    extension: cloud.extension
  });
  assert.doesNotMatch(serialized, /provider-access-key/);
  assert.match(serialized, /\[redacted\]/);
  await cloud.close();
  await cloud.close();
  assert.equal(closeCount, 1);
});

test('Steel releases a paid session when the extension-bearing context is missing', async () => {
  const provider = loadProvider('steel');
  let browserCloseCount = 0;
  const released = [];
  const client = {
    extensions: {},
    sessions: {
      async create() {
        return {
          id: 'steel-session',
          websocketUrl: 'wss://connect.steel.dev?sessionId=steel-session'
        };
      },
      async release(id) { released.push(id); }
    }
  };
  await assert.rejects(() => provider.connectSteelPlaywright({
    client,
    env: {},
    apiKey: 'steel-secret',
    extensionId: 'steel-extension',
    playwright: { chromium: {} },
    chromium: {
      async connectOverCDP() {
        return {
          contexts() { return []; },
          async close() { browserCloseCount += 1; }
        };
      }
    }
  }), /extension-bearing default Playwright context/);
  assert.equal(browserCloseCount, 1);
  assert.deepEqual(released, ['steel-session']);
});

test('shipped provider examples allow same-origin child routes and reject external scope', async () => {
  const helperPath = path.join(PROVIDERS_ROOT, '_shared', 'examples', 'run-ptk-example.mjs');
  const helper = await import(`file://${helperPath}`);
  assert.equal(
    helper.assertInScope('https://app.example.test/child/path', 'https://app.example.test/root'),
    'https://app.example.test/child/path'
  );
  assert.throws(
    () => helper.assertInScope('https://external.example.test/', 'https://app.example.test/root'),
    /refused out-of-scope navigation/
  );

  let calls = 0;
  const evidence = await helper.waitForEngineParticipation({
    async getSessionProgress() {
      calls += 1;
      return calls === 1
        ? { engines: { DAST: { status: 'running' } } }
        : {
            engines: {
              DAST: { status: 'running', progress: { done: 1, total: 5, remaining: 4 } },
              SAST: { status: 'completed', progress: { done: 5, total: 5, remaining: 0 } },
              IAST: { status: 'running' },
              SCA: { status: 'running' }
            }
          };
    }
  }, { timeoutMs: 100, pollMs: 1 });
  assert.equal(evidence.gate.passed, true);
  assert.deepEqual(evidence.gate.observed, ['DAST', 'IAST', 'SAST', 'SCA']);
});

test('shipped provider examples require an explicitly selected target', () => {
  const files = [];
  for (const providerName of Object.keys(REQUIRED_EXPORTS)) {
    const examplesRoot = path.join(PROVIDERS_ROOT, providerName, 'examples');
    if (!fs.existsSync(examplesRoot)) continue;
    const pending = [examplesRoot];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else if (/\.(?:c?js|mjs)$/.test(entry.name)) files.push(candidate);
      }
    }
  }
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /https:\/\/preview\.owasp-juice\.shop/, path.relative(PROVIDERS_ROOT, file));
  }
});
