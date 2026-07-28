'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileMissionCandidates } = require('../../../src/agent/index.cjs');
const { Coverage } = require('../../../src/crawl/coverage.cjs');
const { Frontier } = require('../../../src/crawl/frontier.cjs');
const {
  adaptAnalysisEvidence,
  seedFrontierFromAnalysisEvidence
} = require('../../../src/evidence/analysisEvidenceAdapter.cjs');
const { importSastHints } = require('../../../src/evidence/sastHintImporter.cjs');
const { collectAnalysisEvidenceInputs, mergeMissionEvidence } = require('../../../src/core/orchestrator.cjs');

test('analysis adapter imports v2-shaped PTK explorer routes, endpoints, GraphQL, hidden params, and finding entry points', () => {
  const evidence = adaptAnalysisEvidence({
    analysis: {
      explorer: {
        routes: ['/catalog'],
        endpoints: [{ method: 'GET', path: '/api/products', resourceType: 'fetch' }],
        graphqlOperations: [{ endpoint: '/graphql', operationName: 'Products', operationType: 'query', variableNames: ['id'] }],
        hiddenParams: [{ name: 'debug', endpoint: '/api/products', evidenceRefs: ['param-ref'] }]
      }
    },
    findings: [{ id: 'finding-xss', title: 'DOM XSS', url: '/search?q=xss' }]
  }, { baseUrl: 'http://app.test' });

  assert.equal(evidence.counts.routeHints, 2);
  const findingRoute = evidence.routeHints.find(route => route.url === 'http://app.test/search?q=xss');
  assert.equal(findingRoute.sourceTag, 'ptk-analysis');
  assert.deepEqual(findingRoute.evidenceRefs, ['finding-xss']);
  assert.equal(evidence.endpoints[0].path, '/api/products');
  assert.equal(evidence.endpoints[0].sourceTag, 'ptk-analysis');
  assert.equal(evidence.graphqlOperations[0].operationName, 'Products');
  assert.equal(evidence.graphqlOperations[0].path, '/graphql');
  assert.equal(evidence.hiddenParams[0].name, 'debug');
  assert.deepEqual(evidence.hiddenParams[0].evidenceRefs, ['param-ref']);
  assert.equal(evidence.evidenceRecords.some(record => record.kind === 'graphql-operation'), true);
});

test('analysis adapter imports older explorer exports safely', () => {
  const evidence = adaptAnalysisEvidence({
    source: {
      explorer: {
        urls: ['/archive-admin'],
        apiEndpoints: ['/rest/user/whoami'],
        hiddenInputs: [{ param: 'coupon', in: 'query', target: '/rest/basket' }]
      }
    }
  }, { baseUrl: 'http://app.test', defaultSourceTag: 'sast' });

  assert.equal(evidence.routeHints[0].url, 'http://app.test/archive-admin');
  assert.equal(evidence.routeHints[0].sourceTag, 'sast');
  assert.equal(evidence.endpoints[0].path, '/rest/user/whoami');
  assert.equal(evidence.hiddenParams[0].name, 'coupon');
  assert.equal(evidence.hiddenParams[0].endpoint.path, '/rest/basket');
});

test('analysis route hints preserve source priority order and source tags', () => {
  const evidence = adaptAnalysisEvidence({
    routes: [
      { url: '/from-link', sourceTag: 'link' },
      { url: '/from-memory', sourceTag: 'memory' },
      { url: '/from-code', sourceTag: 'code-signal' },
      { url: '/from-runtime', sourceTag: 'runtime' },
      { url: '/from-sast', sourceTag: 'sast' },
      { url: '/from-ptk', sourceTag: 'ptk-analysis' },
      { url: '/from-scenario', sourceTag: 'scenario' }
    ]
  }, { baseUrl: 'http://app.test' });

  assert.deepEqual(evidence.routeHints.map(hint => hint.sourceTag), [
    'scenario',
    'ptk-analysis',
    'sast',
    'runtime',
    'code-signal',
    'memory',
    'link'
  ]);
});

test('analysis frontier seed keeps tags and rejects off-origin routes through normal scope checks', () => {
  const evidence = adaptAnalysisEvidence({
    routes: [
      { url: '/admin', sourceTag: 'sast', evidenceRefs: ['sast-1'] },
      { url: 'https://github.com/example/repo', sourceTag: 'link' }
    ]
  }, { baseUrl: 'http://app.test' });
  const frontier = new Frontier({
    baseUrl: 'http://app.test',
    include: ['http://app.test/**'],
    exclude: [],
    maxRoutes: 10
  });
  const seed = seedFrontierFromAnalysisEvidence(frontier, evidence);
  const route = frontier.dequeue();
  const coverage = new Coverage();
  coverage.recordRoute(route, { url: route.url, routeShape: '/admin' });

  assert.equal(seed.added, 1);
  assert.equal(seed.skipped.length, 1);
  assert.equal(seed.skipped[0].reason, 'out-of-scope');
  assert.equal(route.url, 'http://app.test/admin');
  assert.equal(route.sourceTag, 'sast');
  assert.deepEqual(route.evidenceRefs, ['sast-1']);
  assert.deepEqual(coverage.snapshot().routes[0].evidenceRefs, ['sast-1']);
});

test('config route hints feed analysis evidence inputs with route-hint source', () => {
  const inputs = collectAnalysisEvidenceInputs({
    config: {
      crawler: {
        routeHints: [
          '/swagger-json',
          { url: '/api/config', reason: 'api-surface' }
        ]
      }
    }
  });
  const evidence = adaptAnalysisEvidence(inputs, { baseUrl: 'http://app.test' });

  assert.equal(inputs.length, 1);
  assert.equal(evidence.routeHints.length, 2);
  assert.deepEqual(evidence.routeHints.map(route => route.sourceTag), ['route-hint', 'route-hint']);
  assert.ok(evidence.routeHints.some(route => route.url === 'http://app.test/swagger-json'));
  assert.ok(evidence.routeHints.some(route => route.url === 'http://app.test/api/config'));
});

test('analysis route hint seeding uses frontier source priority instead of analysis score', () => {
  const evidence = adaptAnalysisEvidence({
    sourceTag: 'route-hint',
    routes: [{ url: '/api/config', reason: 'explicit-hint' }]
  }, { baseUrl: 'http://app.test' });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  frontier.enqueue('/menu-discovered', { source: 'surface-expansion', sourceTag: 'surface-expansion' });
  seedFrontierFromAnalysisEvidence(frontier, evidence);

  assert.equal(frontier.dequeue().url, 'http://app.test/api/config');
});

test('SAST hint importer tags hidden routes and params as SAST evidence', () => {
  const evidence = importSastHints({
    hiddenRoutes: ['/admin'],
    hiddenParams: [{ name: 'debug', endpoint: '/api/admin' }]
  }, { baseUrl: 'http://app.test' });

  assert.equal(evidence.routeHints[0].sourceTag, 'sast');
  assert.equal(evidence.hiddenParams[0].sourceTag, 'sast');
});

test('analysis evidence feeds mission compiler without losing endpoint and hidden param hints', () => {
  const analysis = adaptAnalysisEvidence({
    routes: [{ url: '/admin', sourceTag: 'sast' }],
    endpoints: [{ method: 'GET', path: '/api/admin', sourceTag: 'runtime' }],
    graphqlOperations: [{ endpoint: '/graphql', operationName: 'Admin', sourceTag: 'runtime' }],
    hiddenParams: [{ name: 'debug', endpoint: '/api/admin', sourceTag: 'sast' }]
  }, { baseUrl: 'http://app.test' });
  const missions = compileMissionCandidates({
    coverage: { routes: [{ url: 'http://app.test/' }] },
    evidence: mergeMissionEvidence({}, analysis)
  });

  assert.equal(missions.some(mission => mission.kind === 'hidden-route-verification' && /admin/.test(mission.id)), true);
  assert.equal(missions.some(mission => mission.kind === 'endpoint-backed-ui-flow' && /api\/admin/.test(mission.id)), true);
  assert.equal(missions.some(mission => mission.kind === 'graphql-operation-flow'), true);
  assert.equal(missions.some(mission => mission.kind === 'hidden-param-flow'), true);
});
