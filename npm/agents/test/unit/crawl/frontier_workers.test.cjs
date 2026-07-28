'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Frontier } = require('../../../src/crawl/frontier.cjs');
const { Coverage } = require('../../../src/crawl/coverage.cjs');
const { runRouteWorker } = require('../../../src/crawl/routeWorker.cjs');
const { executeSafeAction, runActionWorker } = require('../../../src/crawl/actionWorker.cjs');
const { runFormWorker, planFormSubmission } = require('../../../src/crawl/formWorker.cjs');
const { createRouteLifecycleRecorder } = require('../../../src/crawl/routeLifecycle.cjs');
const { normalizePageModel } = require('../../../src/browser/pageModel.cjs');
const fixtures = require('../../fixtures/browserSnapshots.cjs');

test('frontier keeps same-origin scoped URLs and enforces max routes', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 2 });
  assert.equal(frontier.enqueue('/catalog'), true);
  assert.equal(frontier.enqueue('http://external.test/'), false);
  assert.equal(frontier.enqueue('/contact'), true);
  assert.equal(frontier.enqueue('/profile'), false);
  assert.equal(frontier.size(), 2);
  assert.equal(frontier.rejected.some(entry => entry.reason === 'out-of-scope'), true);
  assert.equal(frontier.rejected.some(entry => entry.reason === 'max-routes'), true);
});

test('frontier rejects session-destructive routes without dropping safe auth routes', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('/logout.jsp', { source: 'link' }), false);
  assert.equal(frontier.enqueue('/account/signout', { source: 'surface-expansion' }), false);
  assert.equal(frontier.enqueue('/session?action=logout', { source: 'link' }), false);
  assert.equal(frontier.enqueue('/login.jsp', { source: 'scenario' }), true);
  assert.equal(frontier.enqueue('/bank/main.jsp', { source: 'scenario' }), true);

  assert.equal(frontier.rejected.filter(entry => entry.reason === 'session-destructive-route').length, 3);
  assert.equal(frontier.snapshot().queue.some(route => /logout|signout/.test(route.url)), false);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/login.jsp'));
});

test('frontier can explicitly allow session-destructive routes for destructive policy runs', () => {
  const frontier = new Frontier({
    baseUrl: 'http://app.test/',
    maxRoutes: 10,
    allowSessionDestructiveRoutes: true
  });

  assert.equal(frontier.enqueue('/logout.jsp', { source: 'scenario' }), true);
  assert.equal(frontier.snapshot().queue[0].url, 'http://app.test/logout.jsp');
});

test('frontier preserves SPA hash routes and normalizes non-route anchors', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('/#/catalog?sort=asc'), true);
  assert.equal(frontier.enqueue('/docs#install'), true);

  const queued = frontier.snapshot().queue.map(route => route.url);
  assert.ok(queued.includes('http://app.test/#/catalog?sort=asc'));
  assert.ok(queued.includes('http://app.test/docs'));
  assert.equal(queued.some(url => url === 'http://app.test/docs#install'), false);
});

test('frontier enforces configured crawl depth', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10, maxDepth: 1 });

  assert.equal(frontier.enqueue('/level-0', { depth: 0, source: 'target' }), true);
  assert.equal(frontier.enqueue('/level-1', { depth: 1, source: 'link' }), true);
  assert.equal(frontier.enqueue('/level-2', { depth: 2, source: 'surface-expansion' }), false);
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'http://app.test/level-2'), false);
  assert.equal(frontier.rejected.some(entry => entry.reason === 'max-depth' && entry.depth === 2 && entry.maxDepth === 1), true);
});

test('frontier serves explicit route hints before discovered surface routes', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('/menu-discovered', { source: 'surface-expansion', sourceTag: 'surface-expansion' }), true);
  assert.equal(frontier.enqueue('/api/config', { source: 'route-hint', sourceTag: 'route-hint' }), true);

  assert.equal(frontier.dequeue().url, 'http://app.test/api/config');
});

test('frontier canonicalizes SPA hash routes to the app base path from any current route', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('http://app.test/contact#/chatbot'), true);
  assert.equal(frontier.enqueue('http://app.test/complain#/chatbot'), false);
  assert.equal(frontier.enqueue({ href: 'http://app.test/chatbot#/contact' }), true);

  const queued = frontier.snapshot().queue.map(route => route.url);
  assert.deepEqual(queued, [
    'http://app.test/#/chatbot',
    'http://app.test/#/contact'
  ]);
});

test('frontier suppresses direct path duplicates after equivalent SPA hash route is known', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('http://app.test/#/chatbot'), true);
  assert.equal(frontier.enqueue('http://app.test/chatbot'), false);
  assert.equal(frontier.enqueue('http://app.test/assets/app.js'), true);
  assert.equal(frontier.enqueue('http://app.test/ftp/legal.md'), true);

  assert.equal(frontier.snapshot().seen.includes('http://app.test/chatbot'), false);
  assert.equal(frontier.rejected.some(entry => (
    entry.reason === 'spa-hash-duplicate'
      && entry.url === 'http://app.test/chatbot'
      && entry.canonicalUrl === 'http://app.test/#/chatbot'
  )), true);
});

test('route worker visits same-origin static documents with commit wait and bounded observation', async () => {
  const gotoCalls = [];
  const observeCalls = [];
  const page = {
    async goto(url, options) {
      gotoCalls.push({ url, options });
      return { status: () => 200 };
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    frontier,
    coverage,
    route: { url: 'http://app.test/ftp/legal.md', depth: 1, source: 'link' },
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 2500, maxObservationMs: 250, preserveSpaHashRoutes: true }
    },
    observe: async (_page, options) => {
      observeCalls.push(options);
      return { events: [], links: ['http://app.test/#/account'] };
    },
    modelExtractor: async () => normalizePageModel({
      url: 'http://app.test/ftp/legal.md',
      title: 'Legal',
      links: [{ href: 'http://app.test/#/account', text: 'Account' }],
      forms: [{ id: 'unexpected', fields: [] }],
      actions: [{ id: 'unexpected-action', kind: 'click-button', label: 'Unexpected' }]
    }, { baseUrl: 'http://app.test/ftp/legal.md', spaHashBaseUrl: 'http://app.test/' })
  });
  const snapshot = coverage.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.staticDocument, true);
  assert.equal(gotoCalls[0].options.waitUntil, 'commit');
  assert.equal(observeCalls[0].maxObservationMs, 100);
  assert.equal(snapshot.routes[0].surfaceType, 'static-document');
  assert.equal(result.pageModel.forms.length, 0);
  assert.equal(result.pageModel.actions.length, 0);
  assert.equal(snapshot.forms.length, 0);
  assert.equal(snapshot.actions.length, 0);
  assert.equal(frontier.size(), 0);
});

test('terminal document route records terminal status without raw content and can extract same-origin links', async () => {
  const gotoCalls = [];
  const page = {
    async goto(url, options) {
      gotoCalls.push({ url, options });
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/markdown' })
      };
    },
    async evaluate(_fn, arg) {
      if (typeof _fn === 'function') {
        return 'Legal notes password=super-secret dbUrl=postgres://dbuser:dbpass@db.test/app googlemaps=AIzaabcdefghijklmnopqrstuvwxyz123456 http://app.test/#/account https://external.test/skip';
      }
      return null;
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    frontier,
    coverage,
    route: { url: 'http://app.test/ftp/legal.md', depth: 1, source: 'link' },
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 2500, maxObservationMs: 250, preserveSpaHashRoutes: true, codeSignals: { enabled: false } }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => normalizePageModel({
      url: 'http://app.test/ftp/legal.md',
      title: 'Legal',
      links: [],
      forms: [{ id: 'unexpected', fields: [] }],
      actions: [{ id: 'unexpected-action', kind: 'click-button', label: 'Unexpected' }]
    }, { baseUrl: 'http://app.test/ftp/legal.md', spaHashBaseUrl: 'http://app.test/' })
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'terminal-document');
  assert.equal(result.terminalDocument.statusCode, 200);
  assert.equal(result.terminalDocument.contentType, 'text/markdown');
  assert.doesNotMatch(JSON.stringify(result.terminalDocument), /super-secret/);
  assert.doesNotMatch(JSON.stringify(result.terminalDocument), /dbpass/);
  assert.doesNotMatch(JSON.stringify(result.terminalDocument), /dbuser/);
  assert.doesNotMatch(JSON.stringify(result.terminalDocument), /AIzaabcdefghijklmnopqrstuvwxyz123456/);
  assert.match(result.terminalDocument.redactedSnippet, /password=\[redacted\]/);
  assert.equal(result.pageModel.forms.length, 0);
  assert.equal(result.pageModel.actions.length, 0);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/#/account'));
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'https://external.test/skip'), false);
  assert.equal(gotoCalls[0].options.waitUntil, 'commit');
});

test('route worker fetches same-origin download navigations as terminal documents', async () => {
  const gotoCalls = [];
  const requestCalls = [];
  const page = {
    async goto(url, options) {
      gotoCalls.push({ url, options });
      throw new Error(`page.goto: Download is starting\nCall log:\n - navigating to "${url}", waiting until "domcontentloaded"`);
    },
    context() {
      return {
        request: {
          async get(url, options) {
            requestCalls.push({ url, options });
            return {
              status: () => 200,
              headers: () => ({ 'content-type': 'application/octet-stream' }),
              text: async () => 'repository-format http://app.test/#/admin password=download-secret'
            };
          }
        }
      };
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    frontier,
    coverage,
    route: { url: 'http://app.test/.git/config', depth: 0, source: 'route-hint', sourceTag: 'route-hint' },
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 2500, maxObservationMs: 250, preserveSpaHashRoutes: true, codeSignals: { enabled: false } }
    }
  });
  const snapshot = coverage.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'terminal-document');
  assert.equal(result.terminalDocument.statusCode, 200);
  assert.equal(result.terminalDocument.contentType, 'application/octet-stream');
  assert.match(result.terminalDocument.redactedSnippet, /password=\[redacted\]/);
  assert.equal(result.pageModel.forms.length, 0);
  assert.equal(result.pageModel.actions.length, 0);
  assert.equal(snapshot.routes[0].surfaceType, 'static-document');
  assert.equal(snapshot.routes[0].timing.downloadFetched, true);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/#/admin'));
  assert.equal(gotoCalls[0].options.waitUntil, 'commit');
  assert.equal(requestCalls[0].url, 'http://app.test/.git/config');
});

test('route lifecycle finalizes a route exactly once and artifacts duplicate attempts', () => {
  const lifecycle = createRouteLifecycleRecorder();
  const route = { url: 'http://app.test/#/contact', routeShape: 'http://app.test/#/contact' };

  const first = lifecycle.finalize(route, 'no-progress', { durationMs: 10 });
  const second = lifecycle.finalize(route, 'visited', { durationMs: 12 });
  const summary = lifecycle.statusSummary();

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(summary.totalRoutesFinalized, 1);
  assert.equal(summary.statuses['no-progress'], 1);
  assert.equal(summary.duplicateFinalizeWarnings, 1);
  assert.equal(lifecycle.snapshot().warnings[0].finalizeAttemptIgnored, true);
});

test('frontier rejects same-origin redirectors with external targets', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('http://app.test/redirect?to=https://github.com/example/project'), false);
  assert.equal(frontier.rejected.some(entry => entry.reason === 'out-of-scope'), true);
});

test('frontier replaces queued direct fallback paths with equivalent SPA hash routes', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  assert.equal(frontier.enqueue('http://app.test/contact'), true);
  assert.equal(frontier.enqueue('http://app.test/#/contact'), true);

  const snapshot = frontier.snapshot();
  assert.deepEqual(snapshot.queue.map(route => route.url), ['http://app.test/#/contact']);
  assert.equal(snapshot.seen.includes('http://app.test/contact'), false);
  assert.equal(frontier.rejected.some(entry => (
    entry.reason === 'spa-hash-duplicate'
      && entry.url === 'http://app.test/contact'
      && entry.canonicalUrl === 'http://app.test/#/contact'
  )), true);
});

test('frontier allows one high-priority authenticated revisit of a protected route', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 3 });

  assert.equal(frontier.enqueue('/marketplace', { source: 'link' }), true);
  assert.equal(frontier.dequeue().url, 'http://app.test/marketplace');
  assert.equal(frontier.enqueue('/catalog-a', { source: 'plain-link' }), true);
  assert.equal(frontier.enqueue('/catalog-b', { source: 'plain-link' }), true);

  assert.equal(frontier.enqueue('/marketplace', {
    source: 'auth-retry',
    sourceTag: 'auth-retry',
    allowRevisit: true,
    revisitKey: 'auth',
    reason: 'post-auth-revisit'
  }), true);
  assert.equal(frontier.enqueue('/marketplace', {
    source: 'auth-retry',
    sourceTag: 'auth-retry',
    allowRevisit: true,
    revisitKey: 'auth',
    reason: 'post-auth-revisit'
  }), false);

  const snapshot = frontier.snapshot();
  assert.equal(snapshot.revisits.length, 1);
  assert.equal(snapshot.queue[0].url, 'http://app.test/marketplace');
  assert.equal(snapshot.queue[0].sourceTag, 'auth-retry');
  assert.equal(snapshot.queue[0].revisitKey, 'http://app.test/marketplace::auth');
  assert.equal(snapshot.rejected.some(entry => entry.reason === 'replaced-by-higher-priority'), true);
});

test('frontier allows one post-login confirmed revisit after an auth retry lands on login', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 4 });

  assert.equal(frontier.enqueue('/marketplace', { source: 'link' }), true);
  assert.equal(frontier.dequeue().url, 'http://app.test/marketplace');
  assert.equal(frontier.enqueue('/marketplace', {
    source: 'auth-retry',
    sourceTag: 'auth-retry',
    allowRevisit: true,
    revisitKey: 'auth',
    reason: 'post-auth-revisit'
  }), true);
  assert.equal(frontier.dequeue().sourceTag, 'auth-retry');
  assert.equal(frontier.enqueue('/marketplace', {
    source: 'auth-confirmed',
    sourceTag: 'auth-confirmed',
    allowRevisit: true,
    revisitKey: 'auth-confirmed',
    reason: 'post-auth-confirmed-revisit'
  }), true);
  assert.equal(frontier.enqueue('/marketplace', {
    source: 'auth-confirmed',
    sourceTag: 'auth-confirmed',
    allowRevisit: true,
    revisitKey: 'auth-confirmed',
    reason: 'post-auth-confirmed-revisit'
  }), false);

  const next = frontier.dequeue();
  assert.equal(next.url, 'http://app.test/marketplace');
  assert.equal(next.sourceTag, 'auth-confirmed');
  assert.equal(next.revisitKey, 'http://app.test/marketplace::auth-confirmed');
});

test('safe link action refuses same-origin redirectors with external targets', async () => {
  const page = {
    async goto() {
      throw new Error('goto should not be called');
    }
  };

  await assert.rejects(
    executeSafeAction(page, {
      id: 'github-redirect',
      kind: 'click-link',
      href: 'http://app.test/redirect?to=https://github.com/example/project',
      riskTier: 'safe-interaction'
    }, 50, {
      config: {
        target: {
          baseUrl: 'http://app.test/',
          scope: { include: ['http://app.test/**'], exclude: [] }
        }
      }
    }),
    /Out-of-scope action refused/
  );
});

test('safe link action opens same-origin static documents with commit wait', async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push({ url, options });
    }
  };

  await executeSafeAction(page, {
    id: 'legal',
    kind: 'click-link',
    href: 'http://app.test/ftp/legal.md',
    riskTier: 'safe-interaction'
  }, 50, {
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      }
    }
  });

  assert.equal(calls[0].url, 'http://app.test/ftp/legal.md');
  assert.equal(calls[0].options.waitUntil, 'commit');
});

test('route worker observes, models, records coverage, and enqueues links', async () => {
  const page = {
    currentUrl: null,
    overlayDismissals: 0,
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200 };
    },
    async dismissCommonOverlays() {
      this.overlayDismissals += 1;
      return { attempted: true, dismissed: 1 };
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/catalog', depth: 0 },
    frontier,
    coverage,
    config: { crawler: { maxRouteMs: 50, maxObservationMs: 1 } },
    observe: async () => ({
      events: [{ type: 'request', method: 'GET', url: 'http://app.test/api/catalog', path: '/api/catalog', resourceType: 'fetch' }],
      links: [{ href: 'http://app.test/help', text: 'Help' }]
    }),
    modelExtractor: async () => normalizePageModel(fixtures.catalogPage)
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovery.overlay.dismissed, 1);
  assert.equal(page.overlayDismissals, 1);
  assert.equal(frontier.size(), 3);
  assert.equal(coverage.summary().routesVisited, 1);
  assert.equal(coverage.summary().endpointsObserved, 1);
  assert.equal(coverage.summary().actionsDiscovered > 0, true);
});

test('route worker queues a retained owned child route for direct crawl coverage', async () => {
  const page = {
    async goto() {
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', include: ['http://app.test/**'], maxRoutes: 10 });
  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/catalog', depth: 0 },
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: { maxRouteMs: 50, maxObservationMs: 1, codeSignals: { enabled: false } }
    },
    observe: async () => ({
      events: [],
      links: [],
      popups: [{ url: 'http://app.test/child', inScope: true, retained: true, closed: false }]
    }),
    modelExtractor: async () => normalizePageModel({
      url: 'http://app.test/catalog',
      title: 'Catalog',
      visibleText: 'Catalog',
      links: [],
      forms: [],
      actions: []
    })
  });

  assert.equal(result.ok, true);
  assert.ok(frontier.snapshot().queue.some(route => (
    route.url === 'http://app.test/child' && route.sourceTag === 'owned-child'
  )));
});

test('route worker falls back when page model extraction stalls', async () => {
  const page = {
    currentUrl: null,
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    url() {
      return this.currentUrl;
    }
  };
  const coverage = new Coverage();
  const started = Date.now();
  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/about', depth: 1, source: 'link' },
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 50, maxObservationMs: 20, codeSignals: { enabled: false } }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => new Promise(() => {})
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'visited');
  assert.equal(result.pageModel.metadata.fallbackModel, true);
  assert.equal(result.pageModel.metadata.reason, 'page_model_timeout_or_error');
  assert.equal(coverage.summary().routesVisited, 1);
  assert.ok(Date.now() - started < 1000);
});

test('route worker salvages a timed-out navigation after same-origin page commit', async () => {
  const page = {
    currentUrl: 'about:blank',
    async goto(url) {
      this.currentUrl = url;
      throw new Error(`goto ${url} timed out after 50ms`);
    },
    url() {
      return this.currentUrl;
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/protected', depth: 0 },
    frontier,
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 50, maxObservationMs: 1, salvageTimedOutRoutes: true }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => normalizePageModel({
      url: page.currentUrl,
      title: 'Protected',
      visibleText: 'Protected page',
      links: [{ href: '/account', text: 'Account' }],
      forms: [],
      actions: []
    }, { baseUrl: page.currentUrl })
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, 'visited');
  assert.equal(result.navigation.timedOut, true);
  assert.equal(result.navigation.salvaged, true);
  assert.equal(result.pageModel.metadata.navigationTimedOut, true);
  assert.equal(coverage.snapshot().routes[0].timing.navigationTimedOut, true);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/account'));
});

test('route worker does not salvage a timed-out navigation that never leaves the previous page', async () => {
  const page = {
    currentUrl: 'http://app.test/catalog',
    async goto(url) {
      throw new Error(`goto ${url} timed out after 50ms`);
    },
    url() {
      return this.currentUrl;
    }
  };
  const coverage = new Coverage();
  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/protected', depth: 0 },
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxRouteMs: 50, maxObservationMs: 1, salvageTimedOutRoutes: true }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => {
      throw new Error('model extraction should not run');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.finalStatus, 'timeout');
  assert.equal(coverage.snapshot().routes.length, 0);
});

test('route worker feeds code-signal routes and endpoints into frontier and coverage', async () => {
  const page = {
    currentUrl: null,
    scriptUrls: ['http://app.test/src/app.js'],
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200 };
    },
    async fetchScript() {
      return "path: 'admin'; fetch('/api/admin');";
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();

  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/catalog', depth: 0 },
    frontier,
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRouteMs: 50,
        maxObservationMs: 1,
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 8, maxScriptBytes: 5000, maxTotalBytes: 5000, seedRoutes: true }
      }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => normalizePageModel({
      url: 'http://app.test/catalog',
      title: 'Catalog',
      visibleText: 'Catalog',
      links: [],
      forms: [],
      actions: []
    })
  });

  assert.equal(result.ok, true);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/admin' && route.source === 'code-signal'));
  assert.equal(coverage.snapshot().codeSignals.routes[0].sourceTag, 'code-signal');
  assert.ok(coverage.snapshot().endpoints.some(endpoint => endpoint.path === '/api/admin' && endpoint.source === 'code-signal'));
});

test('route worker records code-signal routes without seeding the frontier by default', async () => {
  const page = {
    async goto() {},
    async collectScriptUrls() {
      return ['http://app.test/main.js'];
    },
    async fetchScript() {
      return "path: 'admin'; fetch('/api/admin');";
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();

  const result = await runRouteWorker({
    page,
    route: { url: 'http://app.test/catalog', depth: 0 },
    frontier,
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRouteMs: 50,
        maxObservationMs: 1,
        codeSignals: { enabled: true, mode: 'safe', maxScripts: 8, maxScriptBytes: 5000, maxTotalBytes: 5000 }
      }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => normalizePageModel({
      url: 'http://app.test/catalog',
      title: 'Catalog',
      visibleText: 'Catalog',
      links: [],
      forms: [],
      actions: []
    })
  });

  assert.equal(result.ok, true);
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'http://app.test/admin'), false);
  assert.equal(coverage.snapshot().codeSignals.routes[0].url, 'http://app.test/admin');
});

test('action worker enqueues links discovered after a hidden-link action', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/catalog',
    title: 'Catalog',
    visibleText: 'Catalog More',
    links: [],
    forms: [],
    actions: [{ id: 'more', kind: 'open-menu', label: 'More', selector: '#more', riskTier: 'safe-interaction' }]
  });
  const after = normalizePageModel({
    ...before,
    visibleText: 'Catalog More Admin',
    links: [{ href: '/admin', text: 'Admin' }]
  });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const page = {
    actionCount: 0,
    async performAction() {
      this.actionCount += 1;
    }
  };

  const results = await runActionWorker({
    page,
    pageModel: before,
    frontier,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => page.actionCount > 0 ? after : before
  });

  assert.equal(results[0].ok, true);
  assert.ok(frontier.snapshot().seen.includes('http://app.test/admin'));
});

test('action worker enqueues the current URL after a route-changing action', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/catalog?page=1',
    title: 'Catalog',
    visibleText: 'Catalog Next',
    links: [],
    forms: [],
    actions: [{ id: 'next', kind: 'paginate', label: 'Next', selector: '#next', riskTier: 'safe-interaction' }]
  });
  const after = normalizePageModel({
    ...before,
    url: 'http://app.test/catalog?page=2',
    visibleText: 'Catalog Previous'
  });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const page = {
    changed: false,
    async performAction() {
      this.changed = true;
    }
  };

  const results = await runActionWorker({
    page,
    pageModel: before,
    frontier,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 1 } },
    observe: async () => ({ events: [{ type: 'navigation', url: after.url }] }),
    modelExtractor: async () => page.changed ? after : before
  });

  assert.equal(results[0].transition.changed, true);
  assert.ok(frontier.snapshot().seen.includes('http://app.test/catalog?page=2'));
});

test('action worker enqueues retained in-scope child pages and rejects out-of-scope children', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/catalog',
    title: 'Catalog',
    visibleText: 'Open details',
    links: [],
    forms: [],
    actions: [{ id: 'details', kind: 'open-modal', label: 'Open details', selector: '#details', riskTier: 'safe-interaction' }]
  });
  const frontier = new Frontier({
    baseUrl: 'http://app.test/',
    include: ['http://app.test/**'],
    maxRoutes: 10
  });
  const page = { async performAction() {} };

  const results = await runActionWorker({
    page,
    pageModel: model,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 1 }
    },
    observe: async () => ({
      events: [],
      popups: [
        { url: 'http://app.test/child', inScope: true, retained: true, closed: false },
        { url: 'http://external.test/child', inScope: false, retained: false, closed: true }
      ]
    }),
    modelExtractor: async () => model
  });

  assert.equal(results[0].ok, true);
  assert.ok(frontier.snapshot().queue.some(route => (
    route.url === 'http://app.test/child' && route.sourceTag === 'owned-child'
  )));
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'http://external.test/child'), false);
});

test('action worker artifacts scope-blocked actions without navigating', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/catalog',
    title: 'Catalog',
    visibleText: 'Catalog External',
    links: [],
    forms: [],
    actions: [{
      id: 'external-redirect',
      kind: 'click-link',
      href: 'http://app.test/redirect?to=https://github.com/example/project',
      riskTier: 'safe-interaction'
    }]
  });
  const coverage = new Coverage();
  const page = {
    async goto() {
      throw new Error('goto should not be called');
    }
  };

  const results = await runActionWorker({
    page,
    pageModel: model,
    coverage,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 1 }
    },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => model
  });

  const snapshot = coverage.snapshot();
  assert.equal(results[0].ok, false);
  assert.equal(results[0].blocked, true);
  assert.equal(snapshot.blockedActions.length, 1);
  assert.equal(snapshot.errors.length, 0);
});

test('failed action recovery returns to the last known good route without hiding failure', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/catalog',
    title: 'Catalog',
    visibleText: 'Catalog More',
    links: [],
    forms: [],
    actions: [{ id: 'more', kind: 'open-menu', label: 'More', selector: '#more', riskTier: 'safe-interaction' }]
  });
  const gotoCalls = [];
  const page = {
    currentUrl: 'http://app.test/catalog',
    async performAction() {
      this.currentUrl = 'http://app.test/catalog#broken';
      throw new Error('button detached');
    },
    async goto(url, options) {
      gotoCalls.push({ url, options });
      this.currentUrl = url;
    },
    url() {
      return this.currentUrl;
    }
  };

  const results = await runActionWorker({
    page,
    pageModel: model,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => model
  });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].blocked, false);
  assert.equal(results[0].recovery.ok, true);
  assert.equal(gotoCalls[0].url, 'http://app.test/catalog');
});

test('action worker stops after bounded no-progress actions', async () => {
  const model = normalizePageModel({
    ...fixtures.catalogPage,
    actions: [
      { id: 'filters', kind: 'open-menu', label: 'Filters', selector: '#filters', riskTier: 'safe-interaction' },
      { id: 'next', kind: 'paginate', label: 'Next', selector: '#next', riskTier: 'safe-interaction' }
    ]
  });
  const page = {
    async performAction() {}
  };
  const results = await runActionWorker({
    page,
    pageModel: model,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1, maxActionsPerRoute: 3, maxNoProgressActions: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => model
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].transition.noProgress, true);
});

test('action worker bounds page-model extraction around actions', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/about',
    title: 'About',
    visibleText: 'About More',
    links: [],
    forms: [],
    actions: [{ id: 'more', kind: 'open-menu', label: 'More', selector: '#more', riskTier: 'safe-interaction' }]
  });
  const page = {
    actionCount: 0,
    async performAction() {
      this.actionCount += 1;
    }
  };
  const telemetryEvents = [];
  const started = Date.now();
  const results = await runActionWorker({
    page,
    pageModel: model,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 10, maxActionsPerRoute: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => new Promise(() => {}),
    telemetry: {
      event(name, payload) {
        telemetryEvents.push({ name, payload });
      },
      inc() {},
      addTiming() {},
      error() {}
    }
  });

  assert.equal(results.length, 1);
  assert.equal(page.actionCount, 1);
  assert.equal(results[0].ok, true);
  assert.equal(telemetryEvents.filter(event => event.name === 'action.pageModel.timeout').length, 2);
  assert.ok(Date.now() - started < 500);
});

test('form worker plans values and refuses generic submission unless enabled', async () => {
  const genericForm = {
    id: 'profile-edit',
    method: 'post',
    action: '/profile',
    selector: '#profile-edit',
    fields: [{ name: 'email', type: 'email', required: true, selector: '[name="email"]' }]
  };
  const plan = planFormSubmission(genericForm, { values: { email: 'YOUR_USERNAME' } });
  assert.equal(plan.canSubmit, true);
  assert.equal(plan.fields.some(entry => entry.kind === 'email' && entry.value === 'YOUR_USERNAME'), true);
  const result = await runFormWorker({
    form: genericForm,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } }
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /disabled/);
});
