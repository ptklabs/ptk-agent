'use strict';

const EXECUTION_PLAN_SCHEMA = 'ptk-agent-v2-execution-plan';

function buildExecutionPlan(config = {}, options = {}) {
  const macroConfigured = Boolean(
    config.scenario
    && config.scenario.enabled
    && config.scenario.file
    && config.scenario.inputType === 'macro'
  );
  const scenarioConfigured = Boolean(
    config.scenario
    && config.scenario.enabled
    && config.scenario.file
    && config.scenario.inputType !== 'macro'
  );
  const macroRequested = macroConfigured || Boolean(options.macroFile);
  const scenarioRequested = scenarioConfigured || Boolean(options.scenario || options.scenarioFile);
  const agentRequested = Boolean(
    config.agent
    && config.agent.enabled
    && config.agent.mode !== 'off'
  );
  const notices = [];

  if (macroConfigured && scenarioRequested) {
    notices.push({
      level: 'warning',
      code: 'macro_precedence_scenario_skipped',
      message: 'Both macro and scenario inputs were provided. PTK will run the macro as the exclusive browser journey; the scenario and crawler phases are skipped.'
    });
  }

  if (macroConfigured && agentRequested) {
    notices.push({
      level: 'warning',
      code: 'macro_precedence_agent_skipped',
      message: 'Macro mode is exclusive. PTK will run the macro with the selected security engines; the configured Agent/LLM expansion phase is skipped.'
    });
  }

  let journey;
  let crawlerExecuted;
  let agentExecuted;
  let stages;
  if (macroConfigured) {
    journey = 'macro';
    crawlerExecuted = false;
    agentExecuted = false;
    stages = ['security-engines-start', 'macro-replay', 'security-engines-drain', 'findings-export'];
  } else if (scenarioConfigured && agentRequested) {
    journey = 'scenario';
    crawlerExecuted = true;
    agentExecuted = true;
    stages = ['security-engines-start', 'scenario', 'crawler-baseline', 'agent-llm-expansion', 'security-engines-drain', 'findings-export'];
  } else if (scenarioConfigured) {
    journey = 'scenario';
    crawlerExecuted = true;
    agentExecuted = false;
    stages = ['security-engines-start', 'scenario', 'crawler', 'security-engines-drain', 'findings-export'];
  } else if (agentRequested) {
    journey = 'crawler';
    crawlerExecuted = true;
    agentExecuted = true;
    stages = ['security-engines-start', 'crawler-baseline', 'agent-llm-expansion', 'security-engines-drain', 'findings-export'];
  } else {
    journey = 'crawler';
    crawlerExecuted = true;
    agentExecuted = false;
    stages = ['security-engines-start', 'crawler', 'security-engines-drain', 'findings-export'];
  }

  return {
    schemaVersion: EXECUTION_PLAN_SCHEMA,
    requested: {
      macro: macroRequested,
      scenario: scenarioRequested,
      agentLlm: agentRequested
    },
    effective: {
      journey,
      crawlerExecuted,
      agentExecuted,
      securityEngines: enabledEngines(config)
    },
    stages,
    notices
  };
}

function enabledEngines(config = {}) {
  const engines = config.engines || {};
  return Object.entries(engines)
    .filter(([, value]) => value && value.enabled === true)
    .map(([name]) => String(name).toUpperCase());
}

function executionNoticeLines(plan = {}) {
  const notices = Array.isArray(plan.notices) ? plan.notices : [];
  if (!notices.length) return [];
  const lines = notices.map((notice) => (
    `PTK execution notice [${notice.code || 'journey_precedence'}]: ${notice.message || 'The effective journey differs from the requested combination.'}`
  ));
  const effective = plan.effective || {};
  lines.push(
    `Effective journey: ${effective.journey || 'unknown'}; crawler=${Boolean(effective.crawlerExecuted)}; Agent/LLM=${Boolean(effective.agentExecuted)}.`
  );
  return lines;
}

module.exports = {
  EXECUTION_PLAN_SCHEMA,
  buildExecutionPlan,
  enabledEngines,
  executionNoticeLines
};
