'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BudgetTimeoutError,
  BudgetValidationError,
  budgetedScenarioConfig,
  getBudgetFields,
  getDefaultBudgets,
  normalizeBudgets,
  resolveOperationBudget,
  withTimeout
} = require('../../../src/core/budgets.cjs');

test('normalizeBudgets applies defaults and derived wait budget', () => {
  const { budgets } = normalizeBudgets();

  assert.equal(budgets.maxRoutes, 100);
  assert.equal(budgets.maxDepth, 5);
  assert.equal(budgets.maxRouteMs, 30000);
  assert.equal(budgets.maxActionMs, 1000);
  assert.equal(budgets.maxObservationMs, 800);
  assert.equal(budgets.maxActionsPerRoute, 3);
  assert.equal(budgets.maxFormsPerRoute, 1);
  assert.equal(budgets.maxNoProgressActions, 2);
  assert.equal(budgets.waitStrategy, 'event-window');
  assert.equal(budgets.waitBudgetMs, 800);
  assert.equal(budgets.perRouteBudgetMs, 34800);
});

test('normalizeBudgets accepts a full config object and numeric strings', () => {
  const { budgets } = normalizeBudgets({
    crawler: {
      maxRoutes: '12',
      maxDepth: '4',
      maxRouteMs: '100',
      maxActionMs: '50',
      maxObservationMs: '20',
      maxActionsPerRoute: '4',
      maxFormsPerRoute: '2',
      maxNoProgressActions: '0'
    }
  });

  assert.equal(budgets.maxRoutes, 12);
  assert.equal(budgets.maxDepth, 4);
  assert.equal(budgets.maxRouteMs, 100);
  assert.equal(budgets.maxActionMs, 50);
  assert.equal(budgets.maxObservationMs, 20);
  assert.equal(budgets.maxActionsPerRoute, 4);
  assert.equal(budgets.maxFormsPerRoute, 2);
  assert.equal(budgets.maxNoProgressActions, 0);
  assert.equal(budgets.perRouteBudgetMs, 420);
});

test('normalizeBudgets rejects hidden networkidle waits', () => {
  assert.throws(
    () => normalizeBudgets({ waitStrategy: 'networkidle' }),
    (error) => {
      assert.ok(error instanceof BudgetValidationError);
      assert.match(error.message, /waitStrategy/);
      return true;
    }
  );
});

test('getDefaultBudgets and getBudgetFields expose copies', () => {
  const defaults = getDefaultBudgets();
  defaults.maxRoutes = 1;
  assert.equal(getDefaultBudgets().maxRoutes, 100);
  assert.ok(getBudgetFields().count.includes('maxDepth'));
  assert.deepEqual(getBudgetFields().derived, ['waitBudgetMs', 'perRouteBudgetMs']);
});

test('scenario operation budgets are owned by the scenario step timeout', () => {
  const config = {
    crawler: {
      maxRouteMs: 25,
      maxActionMs: 25,
      maxObservationMs: 5
    }
  };

  const action = resolveOperationBudget(config, 'scenario-form-submit', {
    step: { id: 'login', timeoutMs: 500 }
  });
  const observation = resolveOperationBudget(config, 'scenario-observation', {
    step: { id: 'login', timeoutMs: 500 }
  });

  assert.equal(action.budgetMs, 500);
  assert.equal(action.source, 'scenario.step.timeoutMs');
  assert.equal(observation.budgetMs, 5);
  assert.equal(observation.source, 'crawler.maxObservationMs capped by step timeout');
});

test('budgetedScenarioConfig prevents crawler action budget from clipping scenario work', () => {
  const config = budgetedScenarioConfig({
    crawler: {
      maxRouteMs: 25,
      maxActionMs: 25,
      maxObservationMs: 5
    }
  }, { id: 'login', timeoutMs: 500 });

  assert.equal(config.crawler.maxRouteMs, 500);
  assert.equal(config.crawler.maxActionMs, 500);
  assert.equal(config.crawler.maxObservationMs, 5);
  assert.equal(config._budgetPolicy.formSubmit.source, 'scenario.step.timeoutMs');
});

test('crawler operation budgets remain strict for exploratory actions', () => {
  const budget = resolveOperationBudget({
    crawler: {
      maxActionMs: 25
    }
  }, 'crawler-form-submit');

  assert.equal(budget.budgetMs, 25);
  assert.equal(budget.source, 'crawler.maxActionMs');
});

test('withTimeout exposes timeout budget ownership', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(resolve => setTimeout(resolve, 30)), 1, 'slow op', {
      operation: 'scenario-form-submit',
      source: 'scenario.step.timeoutMs'
    }),
    error => {
      assert.ok(error instanceof BudgetTimeoutError);
      assert.equal(error.operation, 'scenario-form-submit');
      assert.equal(error.budgetSource, 'scenario.step.timeoutMs');
      assert.match(error.message, /scenario\.step\.timeoutMs/);
      return true;
    }
  );
});
