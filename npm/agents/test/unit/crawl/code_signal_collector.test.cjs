'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectCodeSignals,
  extractCodeSignalLiterals,
  isVendorStaticScript
} = require('../../../src/crawl/codeSignalCollector.cjs');

test('code signal collector extracts SPA routes and API endpoints from same-origin app scripts', async () => {
  const page = {
    scriptUrls: ['http://app.test/assets/app.js'],
    async fetchScript() {
      return `
        const routes = [{ path: 'admin' }, { path: 'products/:id' }];
        router.navigate(['/search']);
        const help = '#/chatbot';
        fetch('/api/search?q=test');
        fetch('/rest/products/1');
        fetch('/graphql');
      `;
    }
  };

  const signals = await collectCodeSignals({
    page,
    pageUrl: 'http://app.test/',
    baseUrl: 'http://app.test/',
    config: {
      crawler: {
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 8, maxScriptBytes: 5000, maxTotalBytes: 5000 }
      }
    }
  });

  assert.equal(signals.scripts.length, 1);
  assert.ok(signals.routes.some(route => route.url === 'http://app.test/admin'));
  assert.ok(signals.routes.some(route => route.url === 'http://app.test/products/1'));
  assert.ok(signals.routes.some(route => route.url === 'http://app.test/#/chatbot'));
  assert.ok(signals.endpoints.some(endpoint => endpoint.path === '/api/search?q=test'));
  assert.ok(signals.endpoints.some(endpoint => endpoint.path === '/graphql'));
  assert.equal(signals.routes.every(route => route.source === 'code-signal'), true);
  assert.equal(signals.endpoints.every(endpoint => endpoint.source === 'code-signal'), true);
});

test('code signal collector deprioritizes vendor and static scripts', async () => {
  const fetched = [];
  const page = {
    scriptUrls: [
      'http://app.test/assets/vendor.bundle.js',
      'http://app.test/src/app.js'
    ],
    async fetchScript(url) {
      fetched.push(url);
      return url.includes('/src/app.js') ? "path: 'settings'" : "path: 'vendor-only'";
    }
  };

  const signals = await collectCodeSignals({
    page,
    pageUrl: 'http://app.test/',
    baseUrl: 'http://app.test/',
    config: {
      crawler: {
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 1, maxScriptBytes: 5000, maxTotalBytes: 5000 }
      }
    }
  });

  assert.deepEqual(fetched, ['http://app.test/src/app.js']);
  assert.equal(isVendorStaticScript('http://app.test/assets/vendor.bundle.js'), true);
  assert.ok(signals.routes.some(route => route.url === 'http://app.test/settings'));
  assert.ok(signals.skippedScripts.some(script => script.reason === 'max-scripts' && script.url.includes('vendor.bundle.js')));
});

test('code signal collector honors limits and artifacts skipped script reasons', async () => {
  const page = {
    scriptUrls: [
      'http://app.test/app.js.map',
      'http://app.test/app.js',
      'http://cdn.test/external.js'
    ],
    async fetchScript(url) {
      return url.endsWith('/app.js') ? 'x'.repeat(20) : "path: 'ignored'";
    }
  };

  const signals = await collectCodeSignals({
    page,
    pageUrl: 'http://app.test/',
    baseUrl: 'http://app.test/',
    config: {
      crawler: {
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 2, maxScriptBytes: 10, maxTotalBytes: 100 }
      }
    }
  });

  assert.equal(signals.scripts.length, 0);
  assert.ok(signals.skippedScripts.some(script => script.reason === 'source-map'));
  assert.ok(signals.skippedScripts.some(script => script.reason === 'external-script'));
  assert.ok(signals.skippedScripts.some(script => script.reason === 'max-script-bytes'));
});

test('code signal collector bounds hanging script fetches', async () => {
  const page = {
    scriptUrls: ['http://app.test/app.js'],
    async fetchScript() {
      return new Promise(() => {});
    }
  };

  const signals = await collectCodeSignals({
    page,
    pageUrl: 'http://app.test/',
    baseUrl: 'http://app.test/',
    config: {
      crawler: {
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 1, maxScriptBytes: 5000, maxTotalBytes: 5000, maxSignalMs: 5 }
      }
    }
  });

  assert.equal(signals.scripts.length, 0);
  assert.ok(signals.skippedScripts.some(script => script.reason === 'fetch-timeout' || script.reason === 'max-signal-ms'));
});

test('code signal collector caches script fetches for repeated SPA routes in one run', async () => {
  let fetches = 0;
  const config = {
    crawler: {
      codeSignals: { enabled: true, mode: 'safe', maxScripts: 1, maxScriptBytes: 5000, maxTotalBytes: 5000, maxSignalMs: 50 }
    }
  };
  const page = {
    scriptUrls: ['http://app.test/app.js'],
    async fetchScript() {
      fetches += 1;
      return "path: 'cached'";
    }
  };

  await collectCodeSignals({ page, pageUrl: 'http://app.test/', baseUrl: 'http://app.test/', config });
  await collectCodeSignals({ page, pageUrl: 'http://app.test/#/contact', baseUrl: 'http://app.test/', config });

  assert.equal(fetches, 1);
});

test('code signal literal extraction skips endpoints as routes and keeps endpoint hints', () => {
  const extracted = extractCodeSignalLiterals(`
    const api = '/api/users';
    const route = '#!/account';
    const routes = [{ path: '/profile' }];
  `, {
    baseUrl: 'http://app.test/',
    scriptUrl: 'http://app.test/app.js'
  });

  assert.equal(extracted.routes.some(route => route.url === 'http://app.test/api/users'), false);
  assert.ok(extracted.routes.some(route => route.url === 'http://app.test/#!/account'));
  assert.ok(extracted.routes.some(route => route.url === 'http://app.test/profile'));
  assert.ok(extracted.endpoints.some(endpoint => endpoint.path === '/api/users'));
});
