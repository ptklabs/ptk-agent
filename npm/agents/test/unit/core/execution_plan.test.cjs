'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildExecutionPlan,
  executionNoticeLines
} = require('../../../src/core/executionPlan.cjs');

function config({ inputType = null, agent = false } = {}) {
  return {
    scenario: inputType ? {
      enabled: true,
      file: inputType === 'macro' ? 'journey.zst' : 'journey.md',
      inputType
    } : {
      enabled: false,
      file: null,
      inputType: 'scenario'
    },
    agent: {
      enabled: agent,
      mode: agent ? 'provider' : 'off'
    },
    engines: {
      dast: { enabled: true },
      iast: { enabled: true },
      sast: { enabled: false },
      sca: { enabled: false }
    }
  };
}

test('scenario and Agent execute as scenario, crawler baseline, then Agent expansion', () => {
  const plan = buildExecutionPlan(config({ inputType: 'scenario', agent: true }));
  assert.deepEqual(plan.effective, {
    journey: 'scenario',
    crawlerExecuted: true,
    agentExecuted: true,
    securityEngines: ['DAST', 'IAST']
  });
  assert.deepEqual(plan.notices, []);
  assert.deepEqual(plan.stages, [
    'security-engines-start',
    'scenario',
    'crawler-baseline',
    'agent-llm-expansion',
    'security-engines-drain',
    'findings-export'
  ]);
});

test('macro plus scenario and Agent remains non-fatal and explains macro precedence', () => {
  const plan = buildExecutionPlan(config({ inputType: 'macro', agent: true }), {
    macroFile: 'journey.zst',
    scenario: 'journey.md'
  });
  assert.deepEqual(plan.requested, {
    macro: true,
    scenario: true,
    agentLlm: true
  });
  assert.deepEqual(plan.effective, {
    journey: 'macro',
    crawlerExecuted: false,
    agentExecuted: false,
    securityEngines: ['DAST', 'IAST']
  });
  assert.deepEqual(plan.notices.map(notice => notice.code), [
    'macro_precedence_scenario_skipped',
    'macro_precedence_agent_skipped'
  ]);
  const lines = executionNoticeLines(plan).join('\n');
  assert.match(lines, /macro_precedence_scenario_skipped/);
  assert.match(lines, /macro_precedence_agent_skipped/);
  assert.match(lines, /Effective journey: macro; crawler=false; Agent\/LLM=false/);
});

test('macro plus scenario emits only the scenario precedence notice', () => {
  const plan = buildExecutionPlan(config({ inputType: 'macro' }), {
    macroFile: 'journey.zst',
    scenario: 'journey.md'
  });
  assert.deepEqual(plan.notices.map(notice => notice.code), [
    'macro_precedence_scenario_skipped'
  ]);
  assert.equal(plan.effective.journey, 'macro');
  assert.equal(plan.effective.crawlerExecuted, false);
  assert.equal(plan.effective.agentExecuted, false);
});

test('macro plus Agent emits only the Agent precedence notice', () => {
  const plan = buildExecutionPlan(config({ inputType: 'macro', agent: true }), {
    macroFile: 'journey.zst'
  });
  assert.deepEqual(plan.notices.map(notice => notice.code), [
    'macro_precedence_agent_skipped'
  ]);
  assert.equal(plan.effective.journey, 'macro');
  assert.equal(plan.effective.crawlerExecuted, false);
  assert.equal(plan.effective.agentExecuted, false);
});

test('configured macro plus CLI scenario still explains that the scenario is skipped', () => {
  const plan = buildExecutionPlan(config({ inputType: 'macro' }), {
    scenario: 'journey.md'
  });
  assert.deepEqual(plan.requested, {
    macro: true,
    scenario: true,
    agentLlm: false
  });
  assert.deepEqual(plan.notices.map(notice => notice.code), [
    'macro_precedence_scenario_skipped'
  ]);
});

test('macro without conflicting inputs has no warning', () => {
  const plan = buildExecutionPlan(config({ inputType: 'macro' }), {
    macroFile: 'journey.zst'
  });
  assert.equal(plan.effective.journey, 'macro');
  assert.equal(plan.effective.crawlerExecuted, false);
  assert.equal(plan.effective.agentExecuted, false);
  assert.deepEqual(plan.notices, []);
  assert.deepEqual(executionNoticeLines(plan), []);
});
