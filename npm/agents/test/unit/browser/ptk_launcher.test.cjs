'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { lazyRequirePlaywright, resolveRouteTimeout, resolveTargetUrl } = require('../../../src/browser/launcher.cjs');
const {
  enablePtkAutomationInExtension,
  automationGrantScope,
  createBrowserContext,
  createBrowserSummary,
  resolvePtkServiceWorkerPath,
  resolveBrowserChannel,
  resolveBrowserName,
  resolveLaunchOptions,
  waitForPtkServiceWorker
} = require('../../../src/browser/context.cjs');
const { detectPtkBridge, startPtkScanIfAvailable } = require('../../../src/browser/ptkBridge.cjs');

test('launcher exposes clear target and timeout resolution', () => {
  assert.equal(resolveTargetUrl({ target: { baseUrl: 'http://app.test' } }), 'http://app.test');
  assert.equal(resolveRouteTimeout({ crawler: { maxRouteMs: 123 } }), 123);
});

test('missing Playwright error is clear when lazy require fails or module is available', () => {
  try {
    const loaded = lazyRequirePlaywright();
    assert.ok(loaded.chromium || loaded.request || loaded.test);
  } catch (err) {
    assert.equal(err.code, 'PLAYWRIGHT_MISSING');
    assert.match(err.message, /Playwright is required/);
  }
});

test('PTK bridge reports unavailable and can start when bridge exists', async () => {
  const missingPage = { evaluate: async fn => fn() };
  const missing = await detectPtkBridge(missingPage);
  assert.equal(missing.available, false);

  let started = false;
  const bridgePage = {
    evaluate: async (fn, arg) => {
      global.window = {
        PTK_AGENT: {
          startScan() {
            started = true;
          }
        }
      };
      try {
        return await fn(arg);
      } finally {
        delete global.window;
      }
    }
  };
  const result = await startPtkScanIfAvailable(bridgePage);
  assert.equal(result.started, true);
  assert.equal(started, true);
});

test('PTK extension launch options use persistent Chromium extension flags', () => {
  const options = resolveLaunchOptions({
    ptk: { extensionPath: '/tmp/ptk-extension' }
  });

  assert.equal(options.headless, false);
  assert.equal(options.timeout, 30000);
  assert.deepEqual(options.ignoreDefaultArgs, ['--disable-extensions']);
  assert.ok(options.args.includes('--enable-unsafe-extension-debugging'));
  assert.ok(options.args.includes('--disable-features=DisableLoadExtensionCommandLineSwitch'));
  assert.ok(options.args.includes('--disable-extensions-except=/tmp/ptk-extension'));
  assert.ok(options.args.includes('--load-extension=/tmp/ptk-extension'));
});

test('browser config resolves chrome and edge launch channels honestly', () => {
  assert.equal(resolveBrowserName({ browser: { name: 'edge' } }), 'edge');
  assert.equal(resolveBrowserChannel('chrome'), 'chrome');
  assert.equal(resolveBrowserChannel('edge'), 'msedge');

  const options = resolveLaunchOptions({
    browser: { name: 'edge', headless: true, launchTimeoutMs: 5000 },
    ptk: { extensionPath: null }
  });
  assert.equal(options.channel, 'msedge');
  assert.equal(options.headless, true);
  assert.equal(options.timeout, 5000);
});

test('browser summary records launch and extension load modes', () => {
  const summary = createBrowserSummary({
    browser: { name: 'chromium', headless: false, executablePath: null },
    ptk: { extensionPath: '/tmp/ptk-extension' }
  }, {
    launchMode: 'extension-loaded-persistent-context',
    extensionLoadMode: 'unpacked-chromium-persistent-context',
    profileMode: 'temporary-extension-profile'
  }, {
    ptkBridgeDetected: true
  });

  assert.equal(summary.requestedBrowser, 'chromium');
  assert.equal(summary.launchMode, 'extension-loaded-persistent-context');
  assert.equal(summary.extensionLoadMode, 'unpacked-chromium-persistent-context');
  assert.equal(summary.ptkBridgeDetected, true);
});

test('firefox and XPI modes fail clearly until implemented', async () => {
  await assert.rejects(
    () => createBrowserContext({ firefox: { launch: async () => ({}) } }, {
      browser: { name: 'firefox' },
      ptk: { extensionPath: null }
    }),
    /Firefox browser support/
  );
});

test('PTK automation bootstrap verifies automation through the extension service worker', async () => {
  const storage = {};
  const worker = {
    url: () => 'chrome-extension://abc/app.js',
    evaluate: async (fn, arg) => {
      const previousBrowser = global.browser;
      const previousChrome = global.chrome;
      const previousPtkApp = global.ptk_app;
      global.browser = {
        storage: {
          local: {
            async get(key) {
              return { [key]: storage[key] };
            },
            async set(value) {
              Object.assign(storage, value);
            }
          }
        },
        runtime: {
          getURL(file) {
            return `chrome-extension://abc/${file}`;
          }
        }
      };
      global.ptk_app = {
        ready: Promise.resolve(),
        settings: {
          automation: {
            enable: true
          }
        }
      };
      try {
        return await fn(arg);
      } finally {
        if (previousBrowser === undefined) delete global.browser;
        else global.browser = previousBrowser;
        if (previousChrome === undefined) delete global.chrome;
        else global.chrome = previousChrome;
        if (previousPtkApp === undefined) delete global.ptk_app;
        else global.ptk_app = previousPtkApp;
      }
    }
  };
  const context = {
    serviceWorkers: () => [worker]
  };

  const result = await enablePtkAutomationInExtension(context, { timeoutMs: 10 });

  assert.equal(result.ok, true);
  assert.equal(result.memoryEnabled, true);
  assert.equal(result.storageEnabled, false);
  assert.equal(storage.pentestkit8_settings, undefined);
  assert.equal(result.extensionUrl, 'chrome-extension://abc/manifest.json');
});

test('PTK Labs automation uses current-document activation without service-worker access', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-current-document-'));
  fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'PTK Automation Extension',
    version: '0.0.0',
    background: {
      service_worker: 'automation/background/automation-background-entry.js',
      type: 'module'
    },
    content_scripts: [{
      matches: ['<all_urls>'],
      js: [
        'runtime/content/iast-document-start-relay.js',
        'automation/content/automation-content-entry.js'
      ],
      run_at: 'document_start',
      all_frames: true
    }]
  }), 'utf8');

  const context = {
    serviceWorkers() {
      throw new Error('current-document activation must not inspect private extension workers');
    }
  };
  const result = await enablePtkAutomationInExtension(context, {
    extensionPath: extensionDir,
    timeoutMs: 10
  });

  assert.deepEqual(result, {
    ok: true,
    implementation: 'ptklabs',
    activation: 'current-document-page-bridge',
    workerUrl: null
  });
});

test('automation grant scope maps Agent include/exclude rules without widening them', () => {
  assert.deepEqual(automationGrantScope({
    baseUrl: 'https://shop.example.test/',
    origin: 'https://shop.example.test',
    include: ['https://shop.example.test/**'],
    exclude: ['https://shop.example.test/admin/**']
  }), {
    origins: [],
    urls: ['https://shop.example.test/**'],
    excludeUrls: ['https://shop.example.test/admin/**']
  });
});

test('PTK service worker detection follows the extension manifest entry', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-worker-manifest-'));
  fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'OWASP Penetration Testing Kit Automation',
    short_name: 'PTK Auto',
    description: 'OWASP Penetration Testing Kit Automation',
    version: '1.0.0',
    background: { service_worker: 'app_automation.js' }
  }), 'utf8');
  fs.writeFileSync(path.join(extensionDir, 'app_automation.js'), 'globalThis.ptk_app = {};', 'utf8');

  const worker = {
    url: () => 'chrome-extension://abc/app_automation.js'
  };
  const context = {
    serviceWorkers: () => [worker]
  };

  assert.equal(resolvePtkServiceWorkerPath(extensionDir), '/app_automation.js');
  assert.equal(await waitForPtkServiceWorker(context, { extensionPath: extensionDir, timeoutMs: 10 }), worker);
});
