'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clickMacroLocator,
  fillMacroLocator,
  initialMacroDestinationMatchesCurrent,
  playwrightMacroKeyValue,
  runScenario,
  submitMacroLocator
} = require('../../../src/scenario/scenarioWorker.cjs');

test('macro initial navigation preserves an already-open destination and the SPA root alias', () => {
  assert.equal(initialMacroDestinationMatchesCurrent(
    'http://localhost:3001/#/',
    'http://localhost:3001/#/'
  ), true);
  assert.equal(initialMacroDestinationMatchesCurrent(
    'http://localhost:3001/#/',
    'http://localhost:3001/'
  ), true);
  assert.equal(initialMacroDestinationMatchesCurrent(
    'http://localhost:3001/#/login',
    'http://localhost:3001/#/'
  ), false);
  assert.equal(initialMacroDestinationMatchesCurrent(
    'http://localhost:3001/#/',
    'http://example.test:3001/#/'
  ), false);
});

function fakePage() {
  let url = 'http://localhost:3001/';
  const actions = [];
  const locator = {
    first() { return this; },
    async count() { return 1; },
    async fill(value) { actions.push({ type: 'fill', value }); }
  };
  const page = {
    actions,
    url() { return url; },
    async goto(next) { url = next; actions.push({ type: 'navigate', url: next }); },
    async waitForTimeout() {},
    locator() { return locator; },
    getByRole() { return locator; },
    getByText() { return locator; },
    context() { return { pages: () => [page] }; }
  };
  return page;
}

test('macro scenario actions execute while retaining runtime secrets outside scenario results', async () => {
  const page = fakePage();
  const flowSteps = [{
    id: 'open', type: 'navigate', url: 'http://localhost:3001/#/login', durationMs: 0, timeoutMs: 5000,
    window: { index: 0, handle: '' }, frameChain: [], locators: [], data: null
  }, {
    id: 'password', type: 'fill', durationMs: 0, timeoutMs: 5000,
    window: { index: 0, handle: '' }, frameChain: [], locators: [{ type: 'id', value: 'passwordControl' }],
    data: { kind: 'secret', name: 'PASSWORD' }
  }];
  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: [{ id: 'macro:open', type: 'macro-navigate', success: { completed: true }, metadata: { macroStepId: 'open' } },
        { id: 'macro:password', type: 'macro-fill', success: { completed: true }, metadata: { macroStepId: 'password' } }]
    },
    context: {
      page,
      config: {
        target: { baseUrl: 'http://localhost:3001', scope: { include: ['http://localhost:3001/**'], exclude: [] } }
      },
      macroRuntime: {
        stepsById: new Map(flowSteps.map(step => [step.id, step])),
        secrets: { PASSWORD: 'runtime-only' },
        variables: {},
        targetOrigin: 'http://localhost:3001'
      }
    },
    stopOnFailure: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(page.actions, [
    { type: 'navigate', url: 'http://localhost:3001/#/login' },
    { type: 'fill', value: 'runtime-only' }
  ]);
  assert.equal(JSON.stringify(result).includes('runtime-only'), false);
});

test('macro scenario replays an imported literal while redacting it from results', async () => {
  const page = fakePage();
  const literal = 'fixture-password-value';
  const flowSteps = [{
    id: 'password', type: 'fill', durationMs: 0, timeoutMs: 5000,
    window: { index: 0, handle: '' }, frameChain: [], locators: [{ type: 'id', value: 'passwordControl' }],
    data: { kind: 'literal', value: literal }
  }];
  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: [{ id: 'macro:password', type: 'macro-fill', success: { completed: true }, metadata: { macroStepId: 'password' } }]
    },
    context: {
      page,
      config: {
        target: { baseUrl: 'http://localhost:3001', scope: { include: ['http://localhost:3001/**'], exclude: [] } }
      },
      macroRuntime: {
        flow: { steps: flowSteps },
        stepsById: new Map(flowSteps.map(step => [step.id, step])),
        secrets: {},
        variables: {},
        targetOrigin: 'http://localhost:3001'
      }
    },
    stopOnFailure: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(page.actions, [{ type: 'fill', value: literal }]);
  assert.equal(JSON.stringify(result).includes(literal), false);
});

test('recorder-generated preparatory focus clicks are retained but do not toggle the target', async () => {
  const page = fakePage();
  const macroStep = {
    id: 'focus', type: 'click', durationMs: 0, timeoutMs: 5000,
    window: { index: 0, handle: '' }, frameChain: [], locators: [{ type: 'id', value: 'search' }],
    data: null, source: { format: 'zest', preparatory: true }
  };
  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: [{ id: 'macro:focus', type: 'macro-click', success: { completed: true }, metadata: { macroStepId: 'focus' } }]
    },
    context: {
      page,
      config: { target: { baseUrl: 'http://localhost:3001', scope: { include: ['http://localhost:3001/**'], exclude: [] } } },
      macroRuntime: {
        stepsById: new Map([[macroStep.id, macroStep]]), secrets: {}, variables: {}, targetOrigin: 'http://localhost:3001'
      }
    },
    stopOnFailure: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(page.actions, []);
});

test('macro click falls back to the already-resolved DOM control when its screen point is obstructed', async () => {
  const calls = [];
  const locator = {
    async evaluate(fn) {
      if (String(fn).includes('elementFromPoint')) return false;
      calls.push('dom-click');
      return null;
    },
    async click() { calls.push('driver-click'); }
  };
  await clickMacroLocator(locator, 5000);
  assert.deepEqual(calls, ['dom-click']);
});

test('macro fill and submit use bounded DOM fallbacks for animated SPA controls', async () => {
  const calls = [];
  const locator = {
    async fill() { throw new Error('not actionable'); },
    async evaluate(fn, value) {
      calls.push({ kind: String(fn).includes('KeyboardEvent') ? 'submit' : 'fill', value });
    }
  };
  await fillMacroLocator(locator, 'literal-value', 5000);
  await submitMacroLocator(locator);
  assert.deepEqual(calls, [
    { kind: 'fill', value: 'literal-value' },
    { kind: 'submit', value: undefined }
  ]);
});

test('macro key tokens use Playwright key names and reject unknown placeholders', () => {
  assert.equal(playwrightMacroKeyValue('${KEY_ENTER}'), 'Enter');
  assert.equal(playwrightMacroKeyValue('KEY_TAB'), 'Tab');
  assert.equal(playwrightMacroKeyValue('Escape'), 'Escape');
  assert.throws(() => playwrightMacroKeyValue('${KEY_UNKNOWN}'), /Unsupported macro key token/);
});

test('macro worker preserves visibility, absolute, and relative scroll semantics', async () => {
  const actions = [];
  let url = 'http://localhost:3001/';
  const locator = {
    first() { return this; },
    async count() { return 1; },
    async scrollIntoViewIfNeeded() { actions.push({ type: 'intoView' }); },
    async evaluate(_fn, value) { actions.push({ type: 'elementScroll', ...value }); }
  };
  const page = {
    url() { return url; },
    async goto(next) { url = next; },
    async waitForTimeout() {},
    async evaluate(_fn, value) { actions.push({ type: 'windowScroll', ...value }); },
    locator() { return locator; },
    getByRole() { return locator; },
    getByText() { return locator; },
    context() { return { pages: () => [page] }; }
  };
  const flowSteps = [{
    id: 'window', type: 'scroll', scrollMode: 'to', x: 0, y: 500,
    durationMs: 0, timeoutMs: 5000, window: { index: 0, handle: '' }, frameChain: [], locators: [], data: null
  }, {
    id: 'view', type: 'scroll', scrollMode: 'intoView',
    durationMs: 0, timeoutMs: 5000, window: { index: 0, handle: '' }, frameChain: [],
    locators: [{ type: 'id', value: 'late-control' }], data: null
  }, {
    id: 'relative', type: 'scroll', scrollMode: 'by', x: -5, y: 180,
    durationMs: 0, timeoutMs: 5000, window: { index: 0, handle: '' }, frameChain: [],
    locators: [{ type: 'css', value: '#results' }], data: null
  }];
  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: flowSteps.map(step => ({
        id: `macro:${step.id}`,
        type: 'macro-scroll',
        success: { completed: true },
        metadata: { macroStepId: step.id }
      }))
    },
    context: {
      page,
      config: { target: { baseUrl: 'http://localhost:3001', scope: { include: ['http://localhost:3001/**'], exclude: [] } } },
      macroRuntime: {
        stepsById: new Map(flowSteps.map(step => [step.id, step])), secrets: {}, variables: {}, targetOrigin: 'http://localhost:3001'
      }
    },
    stopOnFailure: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(actions, [
    { type: 'windowScroll', x: 0, y: 500 },
    { type: 'intoView' },
    { type: 'elementScroll', mode: 'by', x: -5, y: 180 }
  ]);
});
