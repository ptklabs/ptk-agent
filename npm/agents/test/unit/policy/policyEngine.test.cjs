'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyActionRisk,
  createPolicyEngine,
  defaultCapabilities
} = require('../../../src/policy/index.cjs');

test('default capabilities omit provider-native and destructive mutation permissions', () => {
  const capabilities = defaultCapabilities();

  assert.ok(capabilities.includes('mission:plan'));
  assert.ok(!capabilities.includes('provider:native'));
  assert.ok(!capabilities.includes('mutation:destructive'));
});

test('policy allows deterministic skeleton missions after baseline completion', () => {
  const policy = createPolicyEngine();
  const decision = policy.evaluateMission(
    { id: 'm1', kind: 'scenario-unblock', inputs: {} },
    { baselineComplete: true }
  );

  assert.equal(decision.allowed, true);
});

test('policy blocks missions before baseline completion', () => {
  const policy = createPolicyEngine();
  const decision = policy.evaluateMission(
    { id: 'm1', kind: 'scenario-unblock', inputs: {} },
    { baselineComplete: false }
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'baseline-not-complete');
});

test('policy blocks destructive actions unless explicitly allowed', () => {
  const policy = createPolicyEngine();
  const mission = {
    id: 'm1',
    kind: 'endpoint-backed-ui-flow',
    inputs: {
      actions: [{ label: 'Delete account' }]
    }
  };

  assert.equal(classifyActionRisk({ label: 'Delete account' }), 'destructive');
  assert.equal(policy.evaluateMission(mission, { baselineComplete: true }).allowed, false);
});
