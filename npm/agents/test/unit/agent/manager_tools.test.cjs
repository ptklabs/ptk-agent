'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createManagerTools,
  listManagerTools,
  toolRegistrySchema
} = require('../../../src/agent/index.cjs');

test('tool registry returns safe default tools and hides unsafe tools', () => {
  const safe = listManagerTools();
  assert.ok(safe.some(tool => tool.name === 'observe_state'));
  assert.ok(safe.some(tool => tool.name === 'execute_allowed_mission'));
  assert.equal(safe.some(tool => tool.safety === 'unsafe'), false);

  const withUnsafe = listManagerTools({ includeUnsafe: true });
  assert.ok(withUnsafe.some(tool => tool.name === 'get_raw_debug_state'));
});

test('tool registry schema matches the checked-in schema document', () => {
  const schemaPath = path.resolve(__dirname, '../../../docs/agent-tools.schema.json');
  const fromFile = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(toolRegistrySchema(), fromFile);
});

test('safe tools summarize state without raw secrets or HTML', async () => {
  const tools = createManagerTools({
    coverage: {
      summary: { routesVisited: 1, endpointsObserved: 1 },
      routes: [{ url: 'http://app.test/', title: '<secret>raw</secret>' }],
      endpoints: [{ key: 'GET /api/me', method: 'GET', path: '/api/me', body: 'password=secret' }],
      ptk: {
        bridge: { available: true, source: 'PTK_AGENT' },
        validity: { valid: true, status: 'valid', findingsCount: 2 },
        findings: { count: 2 }
      }
    },
    agent: { status: 'completed', actual: 'agent-mock', choices: [{}], results: [{}] }
  });

  const state = await tools.callTool('observe_state');
  assert.equal(state.ok, true);
  assert.equal(JSON.stringify(state).includes('password=secret'), false);
  assert.equal(JSON.stringify(state).includes('<secret>raw</secret>'), false);

  const endpoints = await tools.callTool('list_endpoint_graph');
  assert.equal(endpoints.ok, true);
  assert.deepEqual(endpoints.data.endpoints[0], {
    key: 'GET /api/me',
    method: 'GET',
    path: '/api/me',
    status: null,
    resourceType: null,
    routeUrl: null,
    graphqlOperationName: null
  });
});

test('unsafe tool is blocked unless explicitly enabled', async () => {
  const safeTools = createManagerTools({ coverage: { rawHtml: '<html></html>' } });
  assert.equal((await safeTools.callTool('get_raw_debug_state')).status, 'not_found');

  const unsafeTools = createManagerTools({ includeUnsafe: true, coverage: { rawHtml: '<html></html>' } });
  const result = await unsafeTools.callTool('get_raw_debug_state');
  assert.equal(result.ok, true);
  assert.equal(result.data.coverage.rawHtml, '<html></html>');
});

test('mission execution tool respects policy before executing', async () => {
  const blocked = createManagerTools({
    baselineComplete: false
  });
  const blockedResult = await blocked.callTool('execute_allowed_mission', {
    mission: { id: 'm1', kind: 'hidden-route-verification', route: '/admin' }
  });
  assert.equal(blockedResult.status, 'blocked');
  assert.equal(blockedResult.reason, 'baseline-not-complete');

  const allowed = createManagerTools({
    baselineComplete: true,
    handlers: {
      'hidden-route-verification': mission => ({
        ok: true,
        status: 'completed',
        missionId: mission.id,
        effects: [{ missionId: mission.id, status: 'progress' }]
      })
    }
  });
  const allowedResult = await allowed.callTool('execute_allowed_mission', {
    mission: { id: 'm2', kind: 'hidden-route-verification', route: '/admin' }
  });
  assert.equal(allowedResult.status, 'completed');
  assert.equal(allowedResult.result.status, 'completed');
});
