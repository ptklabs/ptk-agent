'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { closeBlockingSurfaces, dismissCommonOverlays, recoverToRoute } = require('../../../src/browser/recovery.cjs');
const {
  assertNavigationAllowed,
  evaluateNavigationScope,
  isScopeGuardError,
  isSessionDestructiveRoute
} = require('../../../src/browser/scopeGuard.cjs');

const config = {
  target: {
    baseUrl: 'http://app.test/',
    scope: { include: ['http://app.test/**'], exclude: [] }
  }
};

test('scope guard rejects same-origin redirectors with external targets before navigation', () => {
  const url = 'http://app.test/redirect?to=https://github.com/example/project';
  const evaluation = evaluateNavigationScope(url, { config, kind: 'navigation' });

  assert.equal(evaluation.allowed, false);
  assert.match(evaluation.reason, /external redirect target/);
  assert.throws(
    () => assertNavigationAllowed(url, { config, kind: 'navigation' }),
    error => isScopeGuardError(error) && /Out-of-scope navigation refused/.test(error.message)
  );
});

test('scope guard rejects session-destructive routes before navigation', () => {
  const url = 'http://app.test/logout.jsp';
  const evaluation = evaluateNavigationScope(url, { config, kind: 'navigation' });

  assert.equal(isSessionDestructiveRoute(url), true);
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.reason, 'session-destructive-route');
  assert.throws(
    () => assertNavigationAllowed(url, { config, kind: 'navigation' }),
    error => isScopeGuardError(error) && /session-destructive-route/.test(error.message)
  );
});

test('scope guard does not confuse login routes with session-destructive routes', () => {
  assert.equal(isSessionDestructiveRoute('http://app.test/login.jsp'), false);
  assert.equal(isSessionDestructiveRoute('http://app.test/sign-in'), false);
  assert.equal(evaluateNavigationScope('http://app.test/login.jsp', { config, kind: 'navigation' }).allowed, true);
});

test('recovery navigates back to the last route and uses commit for static documents', async () => {
  const calls = [];
  const page = {
    currentUrl: 'http://app.test/#/contact',
    url() {
      return this.currentUrl;
    },
    async goto(url, options) {
      calls.push({ url, options });
      this.currentUrl = url;
    }
  };

  const result = await recoverToRoute(page, 'http://app.test/ftp/legal.md', {
    config,
    timeoutMs: 50
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://app.test/ftp/legal.md');
  assert.equal(calls[0].options.waitUntil, 'commit');
});

test('overlay dismissal is bounded and delegates to browser helpers when available', async () => {
  const page = {
    async dismissCommonOverlays(options) {
      assert.equal(options.timeoutMs, 25);
      return { attempted: true, dismissed: 2 };
    }
  };

  const result = await dismissCommonOverlays(page, { timeoutMs: 25 });

  assert.equal(result.attempted, true);
  assert.equal(result.dismissed, 2);
});

test('blocking surface recovery presses escape and clicks generic backdrops without app labels', async () => {
  const calls = [];
  const page = {
    keyboard: {
      async press(key) {
        calls.push(['key', key]);
      }
    },
    locator(selector) {
      calls.push(['locator', selector]);
      return {
        first() {
          return this;
        },
        async click(options) {
          calls.push(['click', options.force]);
        }
      };
    },
    async evaluate() {
      calls.push(['evaluate']);
      return { blockerCount: 1, dispatchedEscape: true, clickedBackdrop: true };
    },
    async waitForTimeout(ms) {
      calls.push(['wait', ms]);
    }
  };

  const result = await closeBlockingSurfaces(page, { timeoutMs: 50 });

  assert.equal(result.attempted, true);
  assert.equal(result.closed, true);
  assert.equal(result.escapePressed, true);
  assert.equal(result.backdropClicked, true);
  assert.equal(result.backdropCount, 1);
  assert.ok(calls.some(call => call[0] === 'key' && call[1] === 'Escape'));
  assert.ok(calls.some(call => call[0] === 'click' && call[1] === true));
});
