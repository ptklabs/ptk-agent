'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertSupportedSkeleton,
  determineRequestedMode,
  isMacroOnlyRun,
  macroArtifactSensitiveValues,
  orchestrateRun
} = require('../../../src/core/orchestrator.cjs');

function macroConfig(overrides = {}) {
  return {
    scenario: {
      enabled: true,
      file: '/tmp/journey.zst',
      inputType: 'macro'
    },
    agent: {
      enabled: false,
      mode: 'off'
    },
    ...overrides
  };
}

test('macro input is an explicit macro-only execution mode', () => {
  const config = macroConfig();
  assert.equal(isMacroOnlyRun(config), true);
  assert.equal(determineRequestedMode({}, config), 'macro');
});

test('macro artifact redaction selects credential fields without changing replay data', () => {
  const password = 'literal-password-value';
  const search = 'ordinary-search-value';
  const runtime = {
    flow: {
      steps: [{
        type: 'fill',
        locators: [{ type: 'id', value: 'passwordControl' }],
        data: { kind: 'literal', value: password }
      }, {
        type: 'fill',
        locators: [{ type: 'id', value: 'searchQuery' }],
        data: { kind: 'literal', value: search }
      }]
    }
  };

  assert.deepEqual(macroArtifactSensitiveValues(runtime), [password]);
  assert.equal(runtime.flow.steps[0].data.value, password);
  assert.equal(runtime.flow.steps[1].data.value, search);
});

test('macro artifact redaction includes imported secret values without changing replay data', () => {
  const password = 'imported-password-value';
  const runtime = {
    flow: {
      steps: [{
        type: 'fill',
        locators: [{ type: 'id', value: 'password' }],
        data: { kind: 'secret', name: 'PASSWORD' }
      }]
    },
    secrets: {
      PASSWORD: password
    }
  };

  assert.deepEqual(macroArtifactSensitiveValues(runtime), [password]);
  assert.equal(runtime.secrets.PASSWORD, password);
});

test('macro execution takes precedence over configured agent and crawler handlers', async () => {
  const calls = [];
  const config = macroConfig({ agent: { enabled: true, mode: 'provider' } });
  const result = await orchestrateRun({
    config,
    handlers: {
      scenario: async () => {
        calls.push('macro');
        return { status: 'completed' };
      },
      agent: async () => {
        calls.push('agent');
        return { status: 'unexpected-agent' };
      },
      crawl: async () => {
        calls.push('crawl');
        return { status: 'unexpected-crawl' };
      }
    }
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['macro']);
});

test('macro-only validation requires the scenario handler but not agent execution', () => {
  const config = macroConfig({ agent: { enabled: true, mode: 'provider' } });
  assert.doesNotThrow(() => assertSupportedSkeleton(config, {}, {
    scenario: async () => {},
    crawl: async () => {}
  }));
  assert.throws(
    () => assertSupportedSkeleton(config, {}, { crawl: async () => {} }),
    /scenario execution requires a scenario handler/
  );
});
