'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  armPtkIastForNavigation,
  chromiumUnpackedExtensionOrigin,
  hasIastEngine
} = require('../../../../browser/src/preNavigation.cjs');
const selenium = require('../../../../frameworks/selenium/src/index.cjs');

test('IAST pre-navigation helper uses the private extension page before target navigation', async () => {
  const navigations = [];
  const requests = [];
  const page = {
    context() {
      return {
        serviceWorkers() {
          return [{ url: () => 'chrome-extension://ptk-id/app_automation.js' }];
        }
      };
    },
    async goto(url) {
      navigations.push(url);
    },
    async evaluate(fn, request) {
      const previous = globalThis.PTK_AUTOMATION_CONTROL;
      globalThis.PTK_AUTOMATION_CONTROL = {
        async armIastForNavigation(value) {
          requests.push(value);
          return { ok: true, armed: true, tabId: 7 };
        }
      };
      try {
        return await fn(request);
      } finally {
        globalThis.PTK_AUTOMATION_CONTROL = previous;
      }
    }
  };

  const result = await armPtkIastForNavigation(page, {
    targetUrl: 'http://localhost:3001/#/',
    scanOptions: {
      engines: ['DAST', 'IAST'],
      policyCode: 'SMART'
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(navigations, ['chrome-extension://ptk-id/ptk/automation/control.html']);
  assert.equal(requests[0].targetUrl, 'http://localhost:3001/#/');
  assert.deepEqual(requests[0].scanOptions.engines, ['DAST', 'IAST']);
})

test('pre-navigation helper is a no-op when IAST is not selected', async () => {
  assert.equal(hasIastEngine({ engines: ['DAST', 'SAST'] }), false);
  const result = await armPtkIastForNavigation({}, {
    targetUrl: 'https://example.test/',
    scanOptions: { engines: ['DAST'] }
  });
  assert.deepEqual(result, { ok: true, applicable: false, reason: 'iast_not_requested' });
})

test('Chromium pre-navigation wakes a suspended worker through the deterministic unpacked id', async () => {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-unpacked-id-'));
  const origin = chromiumUnpackedExtensionOrigin(extensionPath);
  assert.match(origin, /^chrome-extension:\/\/[a-p]{32}$/);
  const navigations = [];
  const page = {
    context() {
      return { serviceWorkers: () => [] };
    },
    async goto(url) {
      navigations.push(url);
    },
    async evaluate(fn, request) {
      const previous = globalThis.PTK_AUTOMATION_CONTROL;
      globalThis.PTK_AUTOMATION_CONTROL = {
        armIastForNavigation: async () => ({ ok: true, armed: true })
      };
      try {
        return await fn(request);
      } finally {
        globalThis.PTK_AUTOMATION_CONTROL = previous;
      }
    }
  };

  const result = await armPtkIastForNavigation(page, {
    extensionPath,
    targetUrl: 'https://example.test/',
    scanOptions: { engines: ['IAST'] },
    timeoutMs: 1
  });

  assert.equal(result.ok, true);
  assert.deepEqual(navigations, [
    'chrome://extensions/',
    `${origin}/ptk/automation/control.html`
  ]);
});

test('Firefox Selenium arms through an extension iframe in a fresh about:blank tab', async () => {
  const navigations = [];
  const frameSwitches = [];
  const driver = {
    async get(url) {
      navigations.push(url);
    },
    async executeScript(_source, controlUrl) {
      assert.equal(
        controlUrl,
        'moz-extension://ptk-fixed/ptk/automation/control.html'
      );
    },
    async executeAsyncScript(_source, request, timeoutMs) {
      assert.equal(request.targetUrl, 'https://example.test/scoped/');
      assert.equal(timeoutMs, 10000);
      return { ok: true, armed: true, tabId: 11 };
    },
    switchTo() {
      return {
        async frame(value) {
          frameSwitches.push(['frame', value]);
        },
        async defaultContent() {
          frameSwitches.push(['default']);
        }
      };
    },
    manage() {
      return { async setTimeouts() {} };
    }
  };

  const result = await selenium.armPtkIastForNavigation(driver, {
    browser: 'firefox',
    extensionOrigin: 'moz-extension://ptk-fixed',
    targetUrl: 'https://example.test/scoped/',
    scanOptions: { engines: ['IAST'] }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport, 'firefox_extension_frame');
  assert.deepEqual(navigations, ['about:blank']);
  assert.deepEqual(frameSwitches, [
    ['frame', 'ptk-automation-control-frame'],
    ['default']
  ]);
})
