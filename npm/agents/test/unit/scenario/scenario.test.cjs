'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { STEP_TYPES, validateScenario } = require('../../../src/scenario/scenarioValidator.cjs');
const { compileScenario, loadScenarioFile } = require('../../../src/scenario/scenarioCompiler.cjs');
const { topologicalSort } = require('../../../src/scenario/scenarioDag.cjs');
const { executeNavigateStep, runScenario } = require('../../../src/scenario/scenarioWorker.cjs');

const repoRoot = path.resolve(__dirname, '../../..');

const scenario = {
  version: 'ptk-scenario-v2',
  steps: [
    { id: 'open', type: 'navigate', success: { completed: true } },
    { id: 'search', type: 'search', value: 'apple', success: { 'result.surfaceType': 'search-results' } }
  ]
};

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

test('scenario validator rejects cycles and keyword-soup match hints', () => {
  const invalid = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'a', type: 'navigate', dependsOn: ['b'], success: { completed: true } },
      { id: 'b', type: 'search', dependsOn: ['a'], success: { completed: true }, match: 'search for stuff' }
    ]
  };
  const validation = validateScenario(invalid);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some(error => /cycle/.test(error)), true);
  assert.equal(validation.warnings.some(warning => /ignored/.test(warning)), true);
});

test('scenario compiler creates ordered DAG dependencies by default', () => {
  const compiled = compileScenario(scenario);
  assert.deepEqual(topologicalSort(compiled.dag).map(step => step.id), ['open', 'search']);
  assert.deepEqual(compiled.scenario.steps[1].dependsOn, ['open']);
});

test('scenario compiler default timeout is long enough for browser auth setup', () => {
  const compiled = compileScenario({
    version: 'ptk-scenario-v2',
    steps: [{ id: 'auth', type: 'auth', success: { completed: true } }]
  });
  assert.equal(compiled.scenario.steps[0].timeoutMs, 5000);
});

test('benchmark scenario files validate and compile into explicit DAGs', () => {
  for (const relativePath of [
    'benchmarks/juice-shop/auth.json',
    'benchmarks/juice-shop/scenario.json',
    'benchmarks/testfire/auth.json',
    'benchmarks/testfire/scenario.json',
    'benchmarks/brokencrystals/auth.json',
    'benchmarks/brokencrystals/scenario.json'
  ]) {
    const raw = readJson(relativePath);
    const validation = validateScenario(raw);
    assert.equal(validation.ok, true, `${relativePath}: ${validation.errors.join(', ')}`);

    const compiled = compileScenario(raw);
    assert.deepEqual(topologicalSort(compiled.dag).map(step => step.id), raw.steps.map(step => step.id));
    assert.equal(compiled.validation.ok, true);
  }
});

test('benchmark scenarios keep domain actions as concrete step types', () => {
  const juiceShop = compileScenario(readJson('benchmarks/juice-shop/scenario.json')).scenario;
  const testfire = compileScenario(readJson('benchmarks/testfire/scenario.json')).scenario;
  const brokencrystals = compileScenario(readJson('benchmarks/brokencrystals/scenario.json')).scenario;

  assert.equal(juiceShop.steps.find(step => step.id === 'add-apple-to-cart').type, 'add-to-cart');
  assert.notEqual(juiceShop.steps.find(step => step.id === 'add-apple-to-cart').type, 'submit-form');
  assert.equal(testfire.steps.find(step => step.id === 'transfer-funds').type, 'transfer-funds');
  assert.notEqual(testfire.steps.find(step => step.id === 'transfer-funds').type, 'submit-form');
  assert.equal(brokencrystals.steps.find(step => step.id === 'open-swagger').type, 'navigate');
  assert.equal(brokencrystals.steps.find(step => step.id === 'open-graphiql').type, 'navigate');
});

test('human-readable benchmark scenario docs compile for matrix scenario rows', () => {
  for (const relativePath of [
    'docs/scenario_juice_shop.md',
    'docs/scenario_demo.testfire.net.md',
    'docs/scenario_brokencrystals.md'
  ]) {
    const compiled = loadScenarioFile(path.join(repoRoot, relativePath));
    assert.equal(compiled.validation.ok, true, relativePath);
    assert.equal(compiled.scenario.metadata.source, 'markdown');
    assert.ok(compiled.scenario.steps.length > 0, relativePath);
    assert.ok(compiled.scenario.metadata.routeHints.length > 0, relativePath);
  }
});

test('human-readable Juice Shop scenario keeps add-to-cart and feedback as concrete workflows', () => {
  const compiled = loadScenarioFile(path.join(repoRoot, 'docs/scenario_juice_shop.md')).scenario;
  const addToCart = compiled.steps.find(step => /add.*cart|basket/.test(step.id));
  const searchApple = compiled.steps.find(step => /search-for-apple/.test(step.id));
  const feedback = compiled.steps.find(step => /feedback|customer/.test(step.id));

  assert.equal(addToCart && addToCart.type, 'add-to-cart');
  assert.equal(addToCart && addToCart.count, 2);
  assert.equal(searchApple && searchApple.value, 'apple');
  assert.deepEqual(searchApple && searchApple.target, { route: '/#/search' });
  assert.deepEqual(addToCart && addToCart.target, { surfaceType: 'product-card' });
  assert.equal(feedback && feedback.type, 'submit-feedback');
  assert.deepEqual(feedback && feedback.target, { route: '/#/contact', form: 'customer-feedback' });
  assert.equal(compiled.steps.find(step => step.id === 'do-not-delete-the-account').type, 'assert-state');
  assert.equal(compiled.steps.find(step => step.id === 'do-not-delete-the-account').metadata.policyConstraint, true);
  const broadCoverage = compiled.steps.find(step => /broad-coverage/.test(step.id));
  assert.equal(broadCoverage && broadCoverage.type, 'assert-state');
  assert.equal(broadCoverage && broadCoverage.metadata.coverageObjective, true);
  assert.equal(broadCoverage && broadCoverage.target, null);
  assert.equal(compiled.steps.some(step => step.type === 'submit-form' && /add.*cart|basket/.test(step.id)), false);
});

test('human-readable scenario compiler keeps narrative objectives and constraints non-executable', async () => {
  for (const relativePath of [
    'docs/scenario_juice_shop.md',
    'docs/scenario_demo.testfire.net.md',
    'docs/scenario_brokencrystals.md'
  ]) {
    const compiled = loadScenarioFile(path.join(repoRoot, relativePath)).scenario;
    const objectives = compiled.steps.filter(step => step.metadata && step.metadata.coverageObjective);
    const constraints = compiled.steps.filter(step => step.metadata && step.metadata.policyConstraint);
    assert.ok(objectives.length > 0, relativePath);
    assert.ok(constraints.length > 0, relativePath);
    for (const step of objectives) {
      assert.equal(step.type, 'assert-state', step.id);
      assert.equal(step.value, undefined, step.id);
      assert.equal(step.target, null, step.id);
    }
    for (const step of constraints) {
      assert.equal(step.type, 'assert-state', step.id);
      assert.equal(step.value, undefined, step.id);
    }
  }

  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: [{
        id: 'coverage-objective',
        type: 'assert-state',
        metadata: { coverageObjective: true, sourceText: 'Broad coverage: crawl the site.' },
        success: { completed: true }
      }, {
        id: 'policy-constraint',
        type: 'assert-state',
        metadata: { policyConstraint: true, sourceText: 'Do not delete the account.' },
        success: { completed: true }
      }]
    },
    page: {},
    modelExtractor: async () => ({
      url: 'http://localhost/',
      routeShape: '/',
      visibleTextSummary: 'Home',
      links: [],
      forms: [],
      actions: [],
      authSignals: []
    })
  });
  assert.equal(result.ok, true);
});

test('plain-text scenario files compile each line into executable ordered steps', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ptk-plain-scenario-'));
  const scenarioPath = path.join(dir, 'scenario.md');
  fs.writeFileSync(scenarioPath, [
    'Log in with the provided credentials.',
    'Search for "apple".',
    'Open one product page.',
    'Add the product to the basket.',
    'Open the basket.',
    'Do not checkout or pay.'
  ].join('\n'));

  const compiled = loadScenarioFile(scenarioPath).scenario;
  assert.equal(compiled.metadata.source, 'markdown');
  assert.equal(compiled.steps.length, 6);
  assert.equal(compiled.steps[0].type, 'auth');
  assert.deepEqual(compiled.steps[0].target, { route: '/#/login' });
  assert.equal(compiled.steps[1].type, 'search');
  assert.equal(compiled.steps[1].value, 'apple');
  assert.deepEqual(compiled.steps[1].dependsOn, [compiled.steps[0].id]);
  assert.equal(compiled.steps[3].type, 'add-to-cart');
  assert.equal(compiled.steps[4].type, 'navigate');
  assert.deepEqual(compiled.steps[4].target, { route: '/#/basket' });
  assert.equal(compiled.steps[5].type, 'assert-state');
  assert.equal(compiled.steps[5].metadata.policyConstraint, true);
});

test('human-readable BrokenCrystals scenario uses inline route literals before generic names', () => {
  const compiled = loadScenarioFile(path.join(repoRoot, 'docs/scenario_brokencrystals.md')).scenario;
  const auth = compiled.steps.find(step => /authentication/.test(step.id));
  const marketplace = compiled.steps.find(step => /marketplace-route/.test(step.id));
  const productSearch = compiled.steps.find(step => /product-search/.test(step.id));
  const profile = compiled.steps.find(step => /account-route/.test(step.id));
  const swagger = compiled.steps.find(step => /api-documentation/.test(step.id));
  const graphiql = compiled.steps.find(step => /graphql-documentation/.test(step.id));
  const routeHintObjective = compiled.steps.find(step => /user-and-partner-api/.test(step.id));

  assert.deepEqual(auth && auth.target, { route: '/userlogin' });
  assert.deepEqual(auth && auth.success, { authState: 'authenticated' });
  assert.deepEqual(marketplace && marketplace.target, { route: '/marketplace' });
  assert.equal(productSearch && productSearch.type, 'navigate');
  assert.deepEqual(productSearch && productSearch.target, { route: '/api/products/search?name=opal' });
  assert.deepEqual(profile && profile.target, { route: '/userprofile' });
  assert.deepEqual(swagger && swagger.target, { routes: ['/swagger', '/swagger-json'] });
  assert.equal(swagger && swagger.timeoutMs, 15000);
  assert.deepEqual(graphiql && graphiql.target, { routes: ['/graphiql', '/graphql'] });
  assert.equal(graphiql && graphiql.timeoutMs, 15000);
  assert.equal(routeHintObjective && routeHintObjective.metadata.coverageObjective, true);
});

test('human-readable TestFire scenario uses TestFire routes instead of SPA search defaults', () => {
  const compiled = loadScenarioFile(path.join(repoRoot, 'docs/scenario_demo.testfire.net.md')).scenario;
  const login = compiled.steps.find(step => step.id === 'login-using-provided-credentials');
  const account = compiled.steps.find(step => step.id === 'view-account-summary');
  const customize = compiled.steps.find(step => step.id === 'customize-site-language-select-different-languages');
  const news = compiled.steps.find(step => step.id === 'search-news-articles');
  const transactions = compiled.steps.find(step => step.id === 'view-and-search-recent-transactions');
  const logoutCoverage = compiled.steps.find(step => step.id === 'logout-and-crawl-the-whole-website');

  assert.equal(login && login.type, 'auth');
  assert.deepEqual(login && login.target, { route: '/login.jsp' });
  assert.deepEqual(account && account.target, { route: '/bank/main.jsp' });
  assert.equal(customize && customize.type, 'navigate');
  assert.deepEqual(customize && customize.target, {
    routes: [
      '/bank/customize.jsp',
      '/bank/customize.jsp?content=customize.jsp&lang=international',
      '/bank/customize.jsp?content=customize.jsp&lang=english'
    ]
  });
  assert.equal(news && news.type, 'search');
  assert.equal(news && news.value, 'News Articles');
  assert.deepEqual(news && news.target, { route: '/search.jsp?query=News+Articles' });
  assert.equal(transactions && transactions.type, 'navigate');
  assert.deepEqual(transactions && transactions.target, { route: '/bank/transaction.jsp' });
  assert.equal(logoutCoverage && logoutCoverage.type, 'assert-state');
  assert.equal(logoutCoverage && logoutCoverage.metadata.coverageObjective, true);
});

test('scenario navigate step treats same-origin document downloads as terminal visits', async () => {
  const result = await executeNavigateStep({
    id: 'common-files',
    type: 'navigate',
    target: { routes: ['https://example.test/.htaccess'] },
    success: { completed: true }
  }, {
    page: {
      url: () => 'https://example.test/',
      goto: async () => {
        throw new Error('page.goto: Download is starting');
      }
    },
    baseUrl: 'https://example.test/',
    config: {
      target: { baseUrl: 'https://example.test/' },
      crawler: { maxRouteMs: 1000, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => ({
      url: 'https://example.test/',
      routeShape: 'https://example.test/',
      title: 'Home',
      surfaceType: 'content',
      visibleTextSummary: 'Home',
      links: [],
      forms: [],
      actions: [],
      authSignals: []
    })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.routesVisited, ['https://example.test/.htaccess']);
  assert.deepEqual(result.terminalDownloads, [{ url: 'https://example.test/.htaccess', reason: 'download_started' }]);
});

test('conditional human-readable route steps continue when unavailable', async () => {
  const compiled = loadScenarioFile(path.join(repoRoot, 'docs/scenario_juice_shop.md')).scenario;
  const optionalStep = compiled.steps.find(step => /saved-address/.test(step.id));
  assert.equal(optionalStep && optionalStep.failureBehavior, 'continue');

  const result = await runScenario({
    scenario: {
      version: 'ptk-scenario-v2',
      steps: [
        { id: 'login', type: 'auth', success: { completed: true } },
        {
          id: 'optional-saved-address',
          type: 'navigate',
          dependsOn: ['login'],
          failureBehavior: 'continue',
          success: { completed: true }
        },
        { id: 'after', type: 'navigate', dependsOn: ['optional-saved-address'], success: { completed: true } }
      ]
    },
    handlers: {
      auth: async () => ({ ok: true, completed: true }),
      navigate: async step => (step.id === 'optional-saved-address'
        ? { ok: false, reason: 'route_not_available' }
        : { ok: true, completed: true })
    }
  });

  assert.equal(result.ok, true);
  const optionalResult = result.stepResults.find(step => step.stepId === 'optional-saved-address');
  assert.equal(optionalResult.optionalFailure, true);
  assert.equal(optionalResult.ok, true);
});

test('scenario schema documents concrete benchmark step types', () => {
  const schema = readJson('docs/scenario.schema.json');
  const schemaStepTypes = new Set(schema.$defs.step.properties.type.enum);
  const benchmarkStepTypes = new Set([
    ...readJson('benchmarks/juice-shop/scenario.json').steps.map(step => step.type),
    ...readJson('benchmarks/testfire/scenario.json').steps.map(step => step.type),
    ...readJson('benchmarks/brokencrystals/scenario.json').steps.map(step => step.type)
  ]);

  for (const stepType of benchmarkStepTypes) assert.equal(schemaStepTypes.has(stepType), true, stepType);
  assert.equal(STEP_TYPES.includes('add-to-cart'), true);
  assert.equal(STEP_TYPES.includes('transfer-funds'), true);
});

test('scenario worker executes registered handlers with structured success checks', async () => {
  const result = await runScenario({
    scenario,
    handlers: {
      navigate: async () => ({ ok: true }),
      search: async () => ({ ok: true, surfaceType: 'search-results' })
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
});

test('scenario worker fails honestly when a handler is missing', async () => {
  const result = await runScenario({
    scenario,
    handlers: {
      navigate: async () => ({ ok: true })
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedStepId, 'search');
  assert.match(result.stepResults[1].error, /No scenario handler/);
});
