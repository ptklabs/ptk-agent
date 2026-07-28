'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { agentBaselineSkipReason } = require('../../../src/core/orchestrator.cjs');

test('agent handler skips provider when same-session scenario warmup failed', () => {
  const crawl = {
    status: 'completed_with_scenario_failure',
    coverage: {
      scenario: {
        ok: false,
        status: 'failed',
        failureReason: 'page.evaluate: Execution context was destroyed'
      }
    }
  };
  const context = {
    config: { scenario: { enabled: true } },
    options: {}
  };

  assert.equal(agentBaselineSkipReason(crawl, context), 'baseline_scenario_failed');
});

test('agent scenario-unblock option can override same-session baseline gate', () => {
  const crawl = {
    status: 'scenario_failed',
    coverage: {
      scenario: { ok: false, status: 'failed' }
    }
  };
  const context = {
    config: { scenario: { enabled: true } },
    options: { agentAllowScenarioUnblock: true }
  };

  assert.equal(agentBaselineSkipReason(crawl, context), null);
});
