'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ADAPTER_FILES,
  assertMacroFlowScope,
  loadMacroScenario,
  macroEnvironmentName,
  runtimeValues
} = require('../../../src/scenario/macroLoader.cjs');

function flow(origin = 'http://localhost:3001') {
  return {
    schema: 'ptk-flow/v1',
    metadata: { name: 'Login' },
    startUrl: `${origin}/#/login`,
    variables: [{ name: 'PASSWORD', secret: true }],
    steps: [{
      id: 'open', type: 'navigate', enabled: true, optional: false, durationMs: 0, timeoutMs: 5000,
      window: { index: 0, handle: '' }, frameChain: [], locators: [], data: null, url: `${origin}/#/login`
    }, {
      id: 'password', type: 'fill', enabled: true, optional: false, durationMs: 0, timeoutMs: 5000,
      window: { index: 0, handle: '' }, frameChain: [], locators: [{ type: 'id', value: 'passwordControl' }],
      data: { kind: 'secret', name: 'PASSWORD' }
    }]
  };
}

function adapterFixture(root, importedFlow) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of ADAPTER_FILES) fs.writeFileSync(path.join(root, name), 'export const fixture = true;\n');
  fs.writeFileSync(path.join(root, 'formatRegistry.js'), [
    `const flow = ${JSON.stringify(importedFlow)};`,
    "export function parseMacroDocument() { return { acceptable: true, format: 'ptk-flow', flow, diagnostics: [], secretValues: {} }; }"
  ].join('\n'));
}

test('macro loader acquires packaged adapters, compiles a bounded scenario, and keeps secrets runtime-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-macro-loader-'));
  const adapterRoot = path.join(dir, 'adapters');
  const macroFile = path.join(dir, 'login.json');
  adapterFixture(adapterRoot, flow());
  fs.writeFileSync(macroFile, '{}');
  const loaded = await loadMacroScenario(macroFile, {
    config: { target: { baseUrl: 'http://localhost:3001' } },
    adapterRoot,
    cacheRoot: path.join(dir, 'cache'),
    env: { PTK_MACRO_SECRET_PASSWORD: 'runtime-only' }
  });
  assert.deepEqual(loaded.scenario.steps.map(step => step.type), ['macro-navigate', 'macro-fill']);
  assert.equal(loaded.macroRuntime.secrets.PASSWORD, 'runtime-only');
  assert.equal(JSON.stringify(loaded.scenario).includes('runtime-only'), false);
  assert.equal(JSON.stringify(loaded.dagJson).includes('runtime-only'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('macro loader preserves imported literal values without environment prompts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-macro-literal-loader-'));
  const adapterRoot = path.join(dir, 'adapters');
  const macroFile = path.join(dir, 'login.json');
  const literalFlow = flow();
  literalFlow.variables = [];
  literalFlow.steps[1].data = { kind: 'literal', value: 'fixture-password-value' };
  adapterFixture(adapterRoot, literalFlow);
  fs.writeFileSync(macroFile, '{}');
  try {
    const loaded = await loadMacroScenario(macroFile, {
      config: { target: { baseUrl: 'http://localhost:3001' } },
      adapterRoot,
      cacheRoot: path.join(dir, 'cache'),
      env: {}
    });
    assert.deepEqual(loaded.macroRuntime.secrets, {});
    assert.equal(loaded.macroRuntime.flow.steps[1].data.value, 'fixture-password-value');
    assert.equal(JSON.stringify(loaded.scenario).includes('fixture-password-value'), false);
    assert.equal(JSON.stringify(loaded.dagJson).includes('fixture-password-value'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('macro loader enforces exact target origin and explicit runtime values', () => {
  assert.equal(assertMacroFlowScope(flow(), { target: { baseUrl: 'http://localhost:3001/' } }), 'http://localhost:3001');
  assert.throws(
    () => assertMacroFlowScope(flow('https://example.invalid'), { target: { baseUrl: 'http://localhost:3001/' } }),
    /outside the exact target origin/
  );
  assert.equal(macroEnvironmentName('secret', 'PASSWORD'), 'PTK_MACRO_SECRET_PASSWORD');
  assert.throws(() => runtimeValues(flow(), {}, {}), /PTK_MACRO_SECRET_PASSWORD/);
  assert.equal(runtimeValues(flow(), {}, { PTK_MACRO_SECRET_PASSWORD: 'value' }).secrets.PASSWORD, 'value');
});

const realAdapterRoot = path.resolve(__dirname, '../../../../../../pentestkit/src/ptk/background/macro');
test('current PTK adapters import a representative Zest macro into PTK Agent', {
  skip: !fs.existsSync(path.join(realAdapterRoot, 'formatRegistry.js'))
}, async () => {
  const fixture = path.resolve(__dirname, '../../../../../../pentestkit/test/fixtures/macro/zest-client-login.zst');
  const loaded = await loadMacroScenario(fixture, {
    config: { target: { baseUrl: 'http://localhost:3001' } },
    adapterRoot: realAdapterRoot,
    cacheRoot: path.join(os.tmpdir(), 'ptk-real-macro-loader-test'),
    env: { PTK_MACRO_SECRET_PASSWORD: 'runtime-only' }
  });
  assert.equal(loaded.scenario.metadata.sourceFormat, 'zest');
  assert.equal(loaded.scenario.steps.some(step => step.type === 'macro-click'), true);
  assert.equal(loaded.macroRuntime.flow.steps.some(step => step.source && step.source.preparatory === true), true);
});

test('current PTK adapters preserve both official Zest scroll statements for Agent replay', {
  skip: !fs.existsSync(path.join(realAdapterRoot, 'formatRegistry.js'))
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-zest-scroll-loader-'));
  const macroFile = path.join(dir, 'scroll.zst');
  fs.writeFileSync(macroFile, JSON.stringify({
    zestVersion: '0.3', title: 'Scroll', elementType: 'ZestScript', statements: [
      { elementType: 'ZestClientLaunch', url: 'http://localhost:3001/', windowHandle: 'main', enabled: true },
      { elementType: 'ZestClientElementScrollTo', type: 'id', element: 'late-control', windowHandle: 'main', enabled: true },
      { elementType: 'ZestClientElementScroll', type: 'cssSelector', element: '#results', x: -5, y: 180, windowHandle: 'main', enabled: true }
    ]
  }));
  try {
    const loaded = await loadMacroScenario(macroFile, {
      config: { target: { baseUrl: 'http://localhost:3001' } },
      adapterRoot: realAdapterRoot,
      cacheRoot: path.join(dir, 'cache'),
      env: {}
    });
    const scrolls = loaded.macroRuntime.flow.steps.filter(step => step.type === 'scroll');
    assert.deepEqual(scrolls.map(step => [step.scrollMode, step.optional, step.x, step.y]), [
      ['intoView', true, undefined, undefined],
      ['by', false, -5, 180]
    ]);
    assert.deepEqual(loaded.scenario.steps.filter(step => step.type === 'macro-scroll').map(step => step.failureBehavior), [
      'continue', null
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('current PTK adapters import every supported structured macro format into bounded Agent steps', {
  skip: !fs.existsSync(path.join(realAdapterRoot, 'formatRegistry.js'))
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-real-macro-formats-'));
  const fixtureRoot = path.resolve(__dirname, '../../../../../../pentestkit/test/fixtures/macro');
  const flowFile = path.join(dir, 'login-flow.json');
  fs.writeFileSync(flowFile, `${JSON.stringify(flow(), null, 2)}\n`, 'utf8');
  const cases = [
    { format: 'ptk-flow', file: flowFile },
    { format: 'xml', file: path.join(fixtureRoot, 'legacy-login.rec') },
    { format: 'zest', file: path.join(fixtureRoot, 'zest-client-login.zst') },
    { format: 'xml', file: path.join(fixtureRoot, 'katalon-juice-shop.xml') },
    { format: 'side', file: path.join(fixtureRoot, 'selenium-login.side') },
    { format: 'chrome-recorder', file: path.join(fixtureRoot, 'chrome-recorder-login.json') }
  ];
  try {
    for (const entry of cases) {
      const loaded = await loadMacroScenario(entry.file, {
        config: { target: { baseUrl: 'http://localhost:3001' } },
        format: entry.format,
        adapterRoot: realAdapterRoot,
        cacheRoot: path.join(dir, 'cache'),
        env: { PTK_MACRO_SECRET_PASSWORD: 'runtime-only' }
      });
      assert.equal(loaded.scenario.metadata.sourceFormat, entry.format);
      assert.equal(loaded.scenario.steps.length > 0, true);
      assert.equal(loaded.scenario.steps.every(step => step.type.startsWith('macro-')), true);
      assert.equal(JSON.stringify(loaded.scenario).includes('runtime-only'), false);
      assert.equal(JSON.stringify(loaded.dagJson).includes('runtime-only'), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release Juice Shop fixtures stay byte-pinned and compile through every accepted macro adapter', {
  skip: !fs.existsSync(path.join(realAdapterRoot, 'formatRegistry.js'))
}, async () => {
  const fixtureRoot = path.resolve(__dirname, '../../fixtures/macro/juice-shop');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture-set.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-release-macro-fixtures-'));
  try {
    for (const entry of manifest.requiredRecordings.filter(item => item.status === 'accepted')) {
      const macroFile = path.join(fixtureRoot, entry.file);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(macroFile)).digest('hex');
      assert.equal(digest, entry.sha256, `${entry.id} fixture hash changed`);

      const loaded = await loadMacroScenario(macroFile, {
        config: { target: { baseUrl: 'http://localhost:3001' } },
        format: entry.format,
        adapterRoot: realAdapterRoot,
        cacheRoot: path.join(dir, 'cache'),
        env: {}
      });

      assert.equal(loaded.scenario.metadata.sourceFormat, entry.format, `${entry.id} source format`);
      assert.equal(loaded.scenario.steps.length > 0, true, `${entry.id} has executable steps`);
      assert.equal(
        loaded.scenario.steps.every(step => step.type.startsWith('macro-')),
        true,
        `${entry.id} compiles only macro steps`
      );
      const passwordStep = loaded.macroRuntime.flow.steps.find(step =>
        step.data && step.data.kind === 'literal'
        && (step.locators || []).some(locator => /password/i.test(String(locator.value || '')))
      );
      const recordedPassword = passwordStep && passwordStep.data && passwordStep.data.value;
      assert.equal(typeof recordedPassword === 'string' && recordedPassword.length > 0, true,
        `${entry.id} preserves the recorded password in the runtime-only flow`);
      assert.equal(JSON.stringify(loaded.scenario).includes(recordedPassword), false, `${entry.id} scenario redacts values`);
      assert.equal(JSON.stringify(loaded.dagJson).includes(recordedPassword), false, `${entry.id} DAG redacts values`);
      assert.equal(loaded.macroRuntime.secrets.PASSWORD, undefined, `${entry.id} needs no secret prompt`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
