'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { withPtkScan } = require('../../../../browser/src/index.cjs');

function createMockPage() {
  return {
    url: 'about:blank',
    gotoCalls: [],
    async goto(url) {
      this.url = url;
      this.gotoCalls.push(url);
    },
    async evaluate(fn) {
      const source = typeof fn === 'function' ? fn.toString() : String(fn || '');
      if (source.includes('window.location')) return this.url;
      return null;
    }
  };
}

function createMockBridge() {
  const calls = {
    waitReady: 0,
    startSession: 0,
    endSession: 0,
    getFindings: 0,
    getStats: 0
  };
  return {
    calls,
    async waitReady() {
      calls.waitReady += 1;
      return { ok: true };
    },
    async startSession(options = {}) {
      calls.startSession += 1;
      return {
        ok: true,
        sessionId: 'session-1',
        engines: options.engines || ['DAST']
      };
    },
    async endSession(options = {}) {
      calls.endSession += 1;
      return {
        ok: true,
        status: options.wait ? 'completed' : 'stopped',
        sessionId: options.sessionId
      };
    },
    async getFindings() {
      calls.getFindings += 1;
      return { ok: true, findings: [] };
    },
    async getStats() {
      calls.getStats += 1;
      return { ok: true, findingsCount: 0 };
    },
    async call() {
      return { ok: true };
    }
  };
}

test('withPtkScan deferred mode starts scan only when startPtkScan is called', async () => {
  const page = createMockPage();
  const bridge = createMockBridge();

  const result = await withPtkScan(page, {
    deferStart: true,
    bridge,
    engines: ['DAST', 'IAST'],
    stop: { wait: false },
    collect: { beforeStop: true }
  }, async ({ startPtkScan }) => {
    assert.equal(bridge.calls.startSession, 0);
    await page.goto('https://example.test/');
    const first = await startPtkScan();
    const second = await startPtkScan();
    assert.equal(first.session, second.session);
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.scanStarted, true);
  assert.equal(result.scanStartUrl, 'https://example.test/');
  assert.equal(result.sessionStarted, true);
  assert.equal(result.sessionStopped, true);
  assert.equal(bridge.calls.waitReady, 1);
  assert.equal(bridge.calls.startSession, 1);
  assert.equal(bridge.calls.endSession, 1);
  assert.equal(page.gotoCalls.length, 1);
});

test('withPtkScan deferred mode reports PTK_SCAN_NOT_STARTED when callback never starts', async () => {
  const page = createMockPage();
  const bridge = createMockBridge();

  const result = await withPtkScan(page, {
    deferStart: true,
    bridge,
    throwOnError: false
  }, async () => {
    await page.goto('https://example.test/');
  });

  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.scanStarted, false);
  assert.equal(result.sessionStarted, false);
  assert.equal(result.sessionStopped, false);
  assert.equal(result.error.code, 'PTK_SCAN_NOT_STARTED');
  assert.equal(bridge.calls.waitReady, 0);
  assert.equal(bridge.calls.startSession, 0);
  assert.equal(bridge.calls.endSession, 0);
});

test('withPtkScan invokes the framework pre-navigation arm before bootstrap navigation', async () => {
  const page = createMockPage();
  const bridge = createMockBridge();
  const order = [];
  page.goto = async function goto(url) {
    order.push(`goto:${url}`);
    this.url = url;
    this.gotoCalls.push(url);
  };
  const originalWaitReady = bridge.waitReady;
  bridge.waitReady = async () => {
    order.push('waitReady');
    return originalWaitReady();
  };

  const result = await withPtkScan(page, {
    bridge,
    bootstrapUrl: 'https://example.test/scoped/',
    engines: ['IAST'],
    preNavigationArmOperation: async (targetUrl, options) => {
      order.push(`arm:${targetUrl}`);
      assert.deepEqual(options.scanOptions.engines, ['IAST']);
      return { ok: true, applicable: true, armed: true };
    },
    stop: { wait: false }
  }, async () => null);

  assert.equal(result.ok, true);
  assert.deepEqual(order.slice(0, 3), [
    'arm:https://example.test/scoped/',
    'goto:https://example.test/scoped/',
    'waitReady'
  ]);
  assert.equal(result.preNavigationArm.armed, true);
});
