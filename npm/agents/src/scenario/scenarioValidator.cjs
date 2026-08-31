'use strict';

const STEP_TYPES = Object.freeze([
  'auth',
  'navigate',
  'search',
  'open-surface',
  'click-action',
  'add-to-cart',
  'submit-feedback',
  'transfer-funds',
  'submit-form',
  'create-record',
  'edit-record',
  'upload-file',
  'cart-add',
  'checkout-advance',
  'assert-state',
  'macro-navigate',
  'macro-click',
  'macro-doubleClick',
  'macro-fill',
  'macro-select',
  'macro-submit',
  'macro-keyPress',
  'macro-scroll',
  'macro-hover',
  'macro-waitForElement',
  'macro-waitForNavigation',
  'macro-delay',
  'macro-setWindowSize',
  'macro-selectWindow',
  'macro-assertText',
  'macro-assertUrl',
  'macro-assertElement',
  'macro-comment'
]);

const STEP_TYPE_SET = new Set(STEP_TYPES);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function collectDependencies(step) {
  return asArray(step.dependsOn || step.after).filter(Boolean).map(String);
}

function validateStep(step, index, options = {}) {
  const errors = [];
  const path = `steps[${index}]`;
  if (!step || typeof step !== 'object') return [`${path} must be an object.`];
  if (!step.id || typeof step.id !== 'string') errors.push(`${path}.id is required.`);
  else if (!/^[A-Za-z0-9_.:-]+$/.test(step.id)) errors.push(`${path}.id contains unsupported characters.`);
  if (!STEP_TYPE_SET.has(step.type)) errors.push(`${path}.type must be one of: ${STEP_TYPES.join(', ')}.`);
  if (options.requireSuccess !== false && (!step.success || typeof step.success !== 'object')) {
    errors.push(`${path}.success must be a structured object.`);
  }
  if (step.failure !== undefined && step.failure !== null && typeof step.failure !== 'object') {
    errors.push(`${path}.failure must be a structured object when provided.`);
  }
  if (step.timeoutMs !== undefined) {
    const timeout = Number(step.timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) {
      errors.push(`${path}.timeoutMs must be between 1 and 60000.`);
    }
  }
  if (step.retry !== undefined) {
    if (!step.retry || typeof step.retry !== 'object') errors.push(`${path}.retry must be an object.`);
    else if (step.retry.maxAttempts !== undefined && (!Number.isInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1 || step.retry.maxAttempts > 5)) {
      errors.push(`${path}.retry.maxAttempts must be an integer from 1 to 5.`);
    }
  }
  return errors;
}

function detectDependencyErrors(steps) {
  const errors = [];
  const ids = new Set();
  const graph = new Map();
  for (const step of steps) {
    if (!step || !step.id) continue;
    if (ids.has(step.id)) errors.push(`Duplicate scenario step id: ${step.id}.`);
    ids.add(step.id);
    graph.set(step.id, collectDependencies(step));
  }
  for (const [id, dependencies] of graph.entries()) {
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) errors.push(`Scenario step ${id} depends on unknown step ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, stack) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`Scenario dependency cycle detected: ${stack.concat(id).join(' -> ')}.`);
      return;
    }
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency, stack.concat(id));
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id, []);
  return errors;
}

function validateScenario(scenario, options = {}) {
  const errors = [];
  const warnings = [];
  if (!scenario || typeof scenario !== 'object') return { ok: false, errors: ['Scenario must be an object.'], warnings };
  if (scenario.version !== 'ptk-scenario-v2') errors.push('Scenario version must be ptk-scenario-v2.');
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    errors.push('Scenario steps must be a non-empty array.');
  } else {
    scenario.steps.forEach((step, index) => {
      errors.push(...validateStep(step, index, options));
      if (step && step.match) warnings.push(`steps[${index}].match is ignored; v2 scenarios require structured step contracts.`);
    });
    errors.push(...detectDependencyErrors(scenario.steps));
  }
  return { ok: errors.length === 0, errors, warnings };
}

function assertValidScenario(scenario, options = {}) {
  const validation = validateScenario(scenario, options);
  if (!validation.ok) {
    const error = new Error(`Invalid PTK scenario:\n${validation.errors.join('\n')}`);
    error.validation = validation;
    throw error;
  }
  return validation;
}

module.exports = {
  STEP_TYPES,
  STEP_TYPE_SET,
  asArray,
  collectDependencies,
  validateStep,
  validateScenario,
  assertValidScenario
};
