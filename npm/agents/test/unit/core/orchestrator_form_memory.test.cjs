'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configForAgentRouteMission,
  coverageAfterAgentWork,
  mergeCoverage,
  runNormalCrawlFormHooks,
  shouldRecenterAgentLivePage
} = require('../../../src/core/orchestrator.cjs');
const { createEmptySiteMemory } = require('../../../src/memory/siteMemory.cjs');

test('normal crawl form hooks record site memory outcomes and endpoints', async () => {
  const config = {
    target: {
      baseUrl: 'http://app.test/',
      scope: { include: ['http://app.test/**'], exclude: [] }
    },
    crawler: {
      maxFormsPerRoute: 1,
      forms: { enabled: true, allowSearch: true },
      maxObservationMs: 0
    },
    memory: {
      mode: 'read-write',
      staleAfterDays: 14
    }
  };
  const siteMemory = createEmptySiteMemory(config);
  const routeResult = {
    route: { url: 'http://app.test/', depth: 0 },
    formResults: []
  };

  const results = await runNormalCrawlFormHooks({
    page: {},
    pageModel: {
      url: 'http://app.test/',
      forms: [{ id: 'search', kind: 'search', fields: [] }]
    },
    routeResult,
    config,
    frontier: { enqueue() {}, enqueueMany() {} },
    formAttemptLedger: {},
    hasValidationFeedback: () => false,
    runFormWorker: async () => ({
      formId: 'search',
      submitted: true,
      observation: {
        events: [{ type: 'request', method: 'GET', url: 'http://app.test/api/search' }]
      },
      after: { url: 'http://app.test/', links: [] }
    }),
    siteMemory
  });

  assert.equal(results.length, 1);
  assert.equal(routeResult.formResults.length, 1);
  assert.equal(siteMemory.selectors.length, 1);
  assert.equal(siteMemory.selectors[0].formId, 'search');
  assert.equal(siteMemory.selectors[0].successCount, 1);
  assert.equal(siteMemory.endpoints.length, 1);
  assert.equal(siteMemory.endpoints[0].url, 'http://app.test/api/search');
});

test('agent route mission config keeps bounded surface discovery for selected route', () => {
  const config = {
    artifacts: { outputDir: '.ptk/out' },
    crawler: {
      maxRoutes: 100,
      maxDepth: 5,
      maxActionsPerRoute: 3,
      maxFormsPerRoute: 2,
      maxNoProgressActions: 2,
      forms: { enabled: true, allowFeedback: true },
      surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5 }
    }
  };

  const narrowed = configForAgentRouteMission(config, { id: 'mission endpoint GET /api/addresss' });
  assert.equal(narrowed.crawler.maxRoutes, 1);
  assert.equal(narrowed.crawler.maxDepth, 0);
  assert.equal(narrowed.crawler.maxActionsPerRoute, 1);
  assert.equal(narrowed.crawler.maxFormsPerRoute, 0);
  assert.equal(narrowed.crawler.forms.enabled, false);
  assert.equal(narrowed.crawler.surfaceExplorer.enabled, true);
  assert.match(narrowed.artifacts.outputDir, /agent-missions\/mission-endpoint-get-api-addresss$/);
  assert.equal(config.crawler.maxRoutes, 100);
});

test('agent planning recenter returns to app entrypoint from non-entry SPA and terminal routes', () => {
  assert.deepEqual(
    shouldRecenterAgentLivePage('http://app.test/#/wallet', 'http://app.test/'),
    { recenter: true, reason: 'agent_planning_entrypoint' }
  );
  assert.deepEqual(
    shouldRecenterAgentLivePage('http://app.test/ftp/legal.md', 'http://app.test/'),
    { recenter: true, reason: 'terminal_or_static_document' }
  );
  assert.deepEqual(
    shouldRecenterAgentLivePage('http://app.test/#/', 'http://app.test/'),
    { recenter: false, reason: 'current_page_is_app_surface' }
  );
});

test('agent mission coverage merge preserves baseline runtime artifacts', () => {
  const baseline = {
    routes: [{ url: 'http://app.test/' }, { url: 'http://app.test/#/orders' }],
    routeShapes: ['/', '/#/orders'],
    endpoints: [{ key: 'GET /api/orders', method: 'GET', path: '/api/orders' }],
    forms: [{ id: 'login' }],
    actions: [{ id: 'menu' }],
    transitions: [],
    errors: [],
    runHeartbeat: { finalizedRouteCount: 2, source: 'baseline' },
    routeStatusSummary: { total: 2 },
    routeLifecycle: { events: [{ type: 'route_finalized', route: 'http://app.test/' }] },
    browserRuntimeSummary: { routeTimeoutCount: 0 }
  };
  const mission = {
    routes: [{ url: 'http://app.test/#/orders' }],
    routeShapes: ['/#/orders'],
    endpoints: [{ key: 'GET /api/orders', method: 'GET', path: '/api/orders' }],
    forms: [],
    actions: [],
    transitions: [],
    errors: [],
    runHeartbeat: { finalizedRouteCount: 1, source: 'agent-mission' },
    routeStatusSummary: { total: 1 },
    routeLifecycle: { events: [{ type: 'route_finalized', route: 'http://app.test/#/orders' }] },
    browserRuntimeSummary: { routeTimeoutCount: 0 }
  };

  const merged = mergeCoverage(baseline, mission);

  assert.equal(merged.routes.length, 2);
  assert.equal(merged.summary.routesVisited, 2);
  assert.equal(merged.runHeartbeat.source, 'baseline');
  assert.equal(merged.runHeartbeat.finalizedRouteCount, 2);
  assert.equal(merged.routeStatusSummary.total, 2);
  assert.equal(merged.routeLifecycle.events.length, 1);
});

test('agent final coverage includes typed tool deltas even without mini-crawl mission coverage', () => {
  const baseline = {
    routes: [{ url: 'http://app.test/' }],
    routeShapes: ['/'],
    endpoints: [{ key: 'GET /api/products', method: 'GET', path: '/api/products' }],
    forms: [],
    actions: [{ id: 'menu' }],
    transitions: [],
    errors: [],
    runHeartbeat: { source: 'baseline' },
    routeStatusSummary: { total: 1 }
  };
  const agentCoverage = {
    ...baseline,
    endpoints: [
      ...baseline.endpoints,
      { key: 'GET /api/orders', method: 'GET', path: '/api/orders' }
    ],
    actions: [
      ...baseline.actions,
      { id: 'account-menu' }
    ]
  };

  const merged = coverageAfterAgentWork({
    baselineCoverage: baseline,
    agentContext: { coverage: agentCoverage }
  });

  assert.equal(merged.summary.endpointsObserved, 2);
  assert.equal(merged.summary.actionsDiscovered, 2);
  assert.equal(merged.runHeartbeat.source, 'baseline');
  assert.equal(merged.routeStatusSummary.total, 1);
});
