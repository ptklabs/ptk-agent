'use strict';

const DEFAULT_CRAWLER_BUDGETS = Object.freeze({
  maxRoutes: 100,
  maxDepth: 5,
  maxRouteMs: 30000,
  maxActionMs: 1000,
  maxObservationMs: 800,
  maxActionsPerRoute: 3,
  maxFormsPerRoute: 1,
  maxNoProgressActions: 2,
  waitStrategy: 'event-window'
});

const DEFAULT_BUDGETS = DEFAULT_CRAWLER_BUDGETS;
const TIME_BUDGET_FIELDS = Object.freeze(['maxRouteMs', 'maxActionMs', 'maxObservationMs']);
const COUNT_BUDGET_FIELDS = Object.freeze(['maxRoutes', 'maxDepth', 'maxActionsPerRoute', 'maxFormsPerRoute', 'maxNoProgressActions']);
const WAIT_STRATEGIES = Object.freeze(['event-window']);

class BudgetValidationError extends Error {
  constructor(errors) {
    super(`Invalid crawler budget configuration: ${errors.join('; ')}`);
    this.name = 'BudgetValidationError';
    this.code = 'ERR_PTK_AGENT_BUDGETS';
    this.errors = errors;
  }
}

class BudgetTimeoutError extends Error {
  constructor(label, budgetMs, budget = {}) {
    const source = budget.source ? ` (${budget.source})` : '';
    super(`${label} timed out after ${budgetMs}ms${source}`);
    this.name = 'BudgetTimeoutError';
    this.code = 'ERR_PTK_AGENT_BUDGET_TIMEOUT';
    this.operation = budget.operation || null;
    this.budgetSource = budget.source || null;
    this.budgetMs = budgetMs;
    this.remainingMs = budget.remainingMs;
    this.parentOperation = budget.parentOperation || null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function coerceInteger(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : NaN;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return NaN;
}

function positiveInteger(value) {
  const number = coerceInteger(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sourceFromConfig(input) {
  if (!isPlainObject(input)) {
    return {};
  }
  if (isPlainObject(input.crawler)) {
    return input.crawler;
  }
  return input;
}

function normalizeBudgetNumber(source, field, errors, minimum) {
  const value = source[field];
  const number = coerceInteger(value);
  if (!Number.isFinite(number) || number < minimum) {
    const label = field.endsWith('Ms') ? 'milliseconds' : 'count';
    errors.push(`crawler.${field} must be an integer ${label} >= ${minimum}`);
    return DEFAULT_CRAWLER_BUDGETS[field];
  }
  return number;
}

function normalizeBudgets(input = {}, options = {}) {
  const source = {
    ...DEFAULT_CRAWLER_BUDGETS,
    ...sourceFromConfig(input)
  };
  const errors = [];
  const budgets = {};

  for (const field of TIME_BUDGET_FIELDS) {
    budgets[field] = normalizeBudgetNumber(source, field, errors, 1);
  }
  budgets.maxRoutes = normalizeBudgetNumber(source, 'maxRoutes', errors, 1);
  budgets.maxDepth = normalizeBudgetNumber(source, 'maxDepth', errors, 0);
  budgets.maxActionsPerRoute = normalizeBudgetNumber(source, 'maxActionsPerRoute', errors, 0);
  budgets.maxFormsPerRoute = normalizeBudgetNumber(source, 'maxFormsPerRoute', errors, 0);
  budgets.maxNoProgressActions = normalizeBudgetNumber(source, 'maxNoProgressActions', errors, 0);

  if (!WAIT_STRATEGIES.includes(source.waitStrategy)) {
    errors.push(`crawler.waitStrategy must be one of: ${WAIT_STRATEGIES.join(', ')}`);
  }
  budgets.waitStrategy = WAIT_STRATEGIES.includes(source.waitStrategy)
    ? source.waitStrategy
    : DEFAULT_CRAWLER_BUDGETS.waitStrategy;

  budgets.waitBudgetMs = budgets.maxObservationMs;
  budgets.perRouteBudgetMs = budgets.maxRouteMs
    + budgets.maxObservationMs
    + ((budgets.maxActionsPerRoute + budgets.maxFormsPerRoute) * budgets.maxActionMs);

  if (errors.length > 0 && options.throwOnError !== false) {
    throw new BudgetValidationError(errors);
  }

  return { budgets, errors };
}

function normalizeCrawlerBudgets(crawler = {}) {
  const { budgets } = normalizeBudgets(crawler);
  const codeSignals = crawler.codeSignals || {};
  const surfaceExplorer = crawler.surfaceExplorer || {};
  return {
    enabled: crawler.enabled !== false,
    maxRoutes: budgets.maxRoutes,
    maxDepth: budgets.maxDepth,
    maxRouteMs: budgets.maxRouteMs,
    maxActionMs: budgets.maxActionMs,
    maxObservationMs: budgets.maxObservationMs,
    maxActionsPerRoute: budgets.maxActionsPerRoute,
    maxFormsPerRoute: budgets.maxFormsPerRoute,
    maxNoProgressActions: budgets.maxNoProgressActions,
    waitStrategy: budgets.waitStrategy,
    preserveSpaHashRoutes: crawler.preserveSpaHashRoutes !== false,
    salvageTimedOutRoutes: crawler.salvageTimedOutRoutes !== false,
    routeHints: Array.isArray(crawler.routeHints) ? crawler.routeHints.slice() : [],
    routeHintsFile: crawler.routeHintsFile || null,
    forms: {
      enabled: !crawler.forms || crawler.forms.enabled !== false,
      allowSearch: !crawler.forms || crawler.forms.allowSearch !== false,
      allowContact: !crawler.forms || crawler.forms.allowContact !== false,
      allowFeedback: !crawler.forms || crawler.forms.allowFeedback !== false,
      allowAuth: Boolean(crawler.forms && crawler.forms.allowAuth),
      allowBusinessMutation: Boolean(crawler.forms && crawler.forms.allowBusinessMutation)
    },
    codeSignals: {
      enabled: codeSignals.enabled === true,
      mode: ['off', 'safe', 'wide'].includes(codeSignals.mode) ? codeSignals.mode : 'off',
      maxScripts: Number.isInteger(Number(codeSignals.maxScripts)) && Number(codeSignals.maxScripts) > 0 ? Number(codeSignals.maxScripts) : 8,
      maxScriptBytes: Number.isInteger(Number(codeSignals.maxScriptBytes)) && Number(codeSignals.maxScriptBytes) > 0 ? Number(codeSignals.maxScriptBytes) : 2000000,
      maxTotalBytes: Number.isInteger(Number(codeSignals.maxTotalBytes)) && Number(codeSignals.maxTotalBytes) > 0 ? Number(codeSignals.maxTotalBytes) : 5000000,
      maxSignalMs: Number.isInteger(Number(codeSignals.maxSignalMs)) && Number(codeSignals.maxSignalMs) > 0 ? Number(codeSignals.maxSignalMs) : 500,
      seedRoutes: Boolean(codeSignals.seedRoutes),
      includeSourceMaps: Boolean(codeSignals.includeSourceMaps),
      includeExternalScripts: Boolean(codeSignals.includeExternalScripts)
    },
    surfaceExplorer: {
      enabled: surfaceExplorer.enabled === true,
      maxExpansionsPerRoute: Number.isInteger(Number(surfaceExplorer.maxExpansionsPerRoute)) && Number(surfaceExplorer.maxExpansionsPerRoute) >= 0 ? Number(surfaceExplorer.maxExpansionsPerRoute) : 5,
      maxNestedExpansions: Number.isInteger(Number(surfaceExplorer.maxNestedExpansions)) && Number(surfaceExplorer.maxNestedExpansions) >= 0 ? Number(surfaceExplorer.maxNestedExpansions) : budgets.maxDepth,
      maxMenuActionsPerSurface: Number.isInteger(Number(surfaceExplorer.maxMenuActionsPerSurface)) && Number(surfaceExplorer.maxMenuActionsPerSurface) >= 0 ? Number(surfaceExplorer.maxMenuActionsPerSurface) : 8,
      maxRouteChangingMenuActions: Number.isInteger(Number(surfaceExplorer.maxRouteChangingMenuActions)) && Number(surfaceExplorer.maxRouteChangingMenuActions) >= 0 ? Number(surfaceExplorer.maxRouteChangingMenuActions) : 8,
      reopenSurfaceBetweenMenuActions: surfaceExplorer.reopenSurfaceBetweenMenuActions !== false,
      maxExpansionMs: Number.isInteger(Number(surfaceExplorer.maxExpansionMs)) && Number(surfaceExplorer.maxExpansionMs) > 0 ? Number(surfaceExplorer.maxExpansionMs) : 1000,
      maxSurfaceMs: Number.isInteger(Number(surfaceExplorer.maxSurfaceMs)) && Number(surfaceExplorer.maxSurfaceMs) > 0 ? Number(surfaceExplorer.maxSurfaceMs) : null
    },
    waitBudgetMs: budgets.waitBudgetMs,
    perRouteBudgetMs: budgets.perRouteBudgetMs
  };
}

function crawlerBudgetValue(config = {}, field, fallback) {
  const source = sourceFromConfig(config);
  const value = positiveInteger(source[field]);
  return value || fallback;
}

function operationKind(operation = '') {
  const normalized = String(operation || '').toLowerCase();
  if (/observation|observe|settle/.test(normalized)) return 'observation';
  if (/route|navigation|navigate|goto/.test(normalized)) return 'route';
  if (/form|submit|action|click|surface|expansion|search/.test(normalized)) return 'action';
  return 'action';
}

function operationScope(operation = '') {
  const normalized = String(operation || '').toLowerCase();
  if (normalized.startsWith('scenario-')) return 'scenario';
  if (normalized.startsWith('workflow-')) return 'workflow';
  if (normalized.startsWith('ptk-')) return 'ptk';
  return 'crawler';
}

function remainingDeadlineMs(deadline = null) {
  if (!deadline || typeof deadline.remainingMs !== 'function') return null;
  const remaining = Math.floor(deadline.remainingMs());
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 1;
}

function capByParent(budgetMs, budget = {}, parentDeadline = null) {
  const remaining = remainingDeadlineMs(parentDeadline);
  if (!remaining) return { ...budget, budgetMs };
  return {
    ...budget,
    budgetMs: Math.max(1, Math.min(budgetMs, remaining)),
    remainingMs: remaining,
    parentOperation: parentDeadline.operation || budget.parentOperation || null,
    source: budget.source === 'scenario.step.timeoutMs' || budget.source === 'workflow.step.timeoutMs'
      ? `${budget.source}.remaining`
      : budget.source
  };
}

function resolveOperationBudget(config = {}, operation = 'crawler-action', options = {}) {
  const kind = operationKind(operation);
  const scope = operationScope(operation);
  const stepTimeoutMs = positiveInteger(options.stepTimeoutMs)
    || positiveInteger(options.step && options.step.timeoutMs)
    || null;
  const parentDeadline = options.parentDeadline || config._operationDeadline || null;
  let budgetMs;
  let source;

  if ((scope === 'scenario' || scope === 'workflow') && kind !== 'observation' && stepTimeoutMs) {
    budgetMs = stepTimeoutMs;
    source = `${scope}.step.timeoutMs`;
  } else if (kind === 'route') {
    budgetMs = crawlerBudgetValue(config, 'maxRouteMs', DEFAULT_CRAWLER_BUDGETS.maxRouteMs);
    source = 'crawler.maxRouteMs';
  } else if (kind === 'observation') {
    budgetMs = crawlerBudgetValue(config, 'maxObservationMs', DEFAULT_CRAWLER_BUDGETS.maxObservationMs);
    source = 'crawler.maxObservationMs';
    if ((scope === 'scenario' || scope === 'workflow') && stepTimeoutMs) {
      budgetMs = Math.min(budgetMs, stepTimeoutMs);
      source = 'crawler.maxObservationMs capped by step timeout';
    }
  } else {
    budgetMs = crawlerBudgetValue(config, 'maxActionMs', DEFAULT_CRAWLER_BUDGETS.maxActionMs);
    source = 'crawler.maxActionMs';
  }

  const budget = {
    operation,
    kind,
    scope,
    budgetMs,
    source,
    stepTimeoutMs,
    stepId: options.step && options.step.id || options.stepId || null
  };
  return capByParent(budgetMs, budget, parentDeadline);
}

function serializeBudget(budget = {}) {
  return {
    operation: budget.operation || null,
    kind: budget.kind || null,
    scope: budget.scope || null,
    budgetMs: budget.budgetMs || null,
    source: budget.source || null,
    stepId: budget.stepId || null,
    stepTimeoutMs: budget.stepTimeoutMs || null,
    remainingMs: budget.remainingMs || null,
    parentOperation: budget.parentOperation || null
  };
}

function budgetedScenarioConfig(config = {}, step = {}, options = {}) {
  const scope = options.scope || 'scenario';
  const parentDeadline = options.parentDeadline || null;
  const route = resolveOperationBudget(config, `${scope}-route`, { step, parentDeadline });
  const action = resolveOperationBudget(config, `${scope}-action`, { step, parentDeadline });
  const formSubmit = resolveOperationBudget(config, `${scope}-form-submit`, { step, parentDeadline });
  const observation = resolveOperationBudget(config, `${scope}-observation`, { step, parentDeadline });
  const crawler = config.crawler || config || {};
  return {
    ...config,
    crawler: {
      ...crawler,
      maxRouteMs: route.budgetMs,
      maxActionMs: action.budgetMs,
      maxObservationMs: observation.budgetMs
    },
    _budgetPolicy: {
      ...(config._budgetPolicy || {}),
      scope,
      stepId: step && step.id || null,
      route,
      action,
      formSubmit,
      observation
    }
  };
}

function getDefaultBudgets() {
  return clone(DEFAULT_CRAWLER_BUDGETS);
}

function getBudgetFields() {
  return {
    time: [...TIME_BUDGET_FIELDS],
    count: [...COUNT_BUDGET_FIELDS],
    waitStrategies: [...WAIT_STRATEGIES],
    derived: ['waitBudgetMs', 'perRouteBudgetMs']
  };
}

function createDeadline(ms, options = {}, now = Date.now) {
  if (typeof options === 'function') {
    now = options;
    options = {};
  }
  const budgetMs = coerceInteger(ms);
  if (!Number.isFinite(budgetMs) || budgetMs < 1) {
    throw new BudgetValidationError(['budget must be an integer milliseconds >= 1']);
  }
  const start = now();
  return {
    start,
    budgetMs,
    remainingMs() {
      return Math.max(0, budgetMs - (now() - start));
    },
    expired() {
      return this.remainingMs() <= 0;
    },
    operation: options.operation || null,
    source: options.source || null,
    stepId: options.stepId || null
  };
}

function withTimeout(promise, ms, label = 'operation', budget = {}) {
  const budgetMs = coerceInteger(ms);
  if (!Number.isFinite(budgetMs) || budgetMs < 1) {
    throw new BudgetValidationError(['timeout budget must be an integer milliseconds >= 1']);
  }
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BudgetTimeoutError(label, budgetMs, budget)), budgetMs);
    })
  ]);
}

module.exports = {
  BudgetTimeoutError,
  BudgetValidationError,
  COUNT_BUDGET_FIELDS,
  DEFAULT_BUDGETS,
  DEFAULT_CRAWLER_BUDGETS,
  TIME_BUDGET_FIELDS,
  WAIT_STRATEGIES,
  budgetedScenarioConfig,
  createDeadline,
  getBudgetFields,
  getDefaultBudgets,
  normalizeBudgets,
  normalizeCrawlerBudgets,
  resolveOperationBudget,
  serializeBudget,
  withTimeout
};
