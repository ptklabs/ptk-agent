'use strict';

const { compileScenario } = require('./scenarioCompiler.cjs');
const { createScenarioState, getReadySteps, markStepResult, serializeDag } = require('./scenarioDag.cjs');
const { executeSafeAction } = require('../crawl/actionWorker.cjs');
const { createFormAttemptLedger, hasValidationFeedback, runFormWorker } = require('../crawl/formWorker.cjs');
const { gotoRoute } = require('../crawl/routeWorker.cjs');
const { observePage } = require('../browser/eventCollector.cjs');
const { extractPageModel, normalizeUrl } = require('../browser/pageModel.cjs');
const { dismissCommonOverlays } = require('../browser/recovery.cjs');
const { validateTransition } = require('../browser/transition.cjs');
const {
  budgetedScenarioConfig,
  createDeadline,
  withTimeout
} = require('../core/budgets.cjs');
const {
  addToCart,
  openSurface,
  search: workflowSearch,
  submitFeedback,
  transferFunds
} = require('./workflowExecutors.cjs');

const REDACTED = '[redacted]';
const SENSITIVE_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session)/i;

function getPathValue(source, path) {
  const parts = String(path).split('.');
  let value = source;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    value = value[part];
  }
  return value;
}

function evaluateCondition(condition, result, context = {}) {
  if (!condition) return { ok: true, mismatches: [] };
  const source = {
    completed: Boolean(result && result.ok !== false),
    result: result || {},
    state: context.state || {},
    pageModel: context.pageModel || null
  };
  const mismatches = [];
  for (const [path, expected] of Object.entries(condition)) {
    const actual = conditionActualValue(source, result, context, path);
    if (!conditionValueMatches(path, actual, expected)) mismatches.push({ path, expected, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function conditionActualValue(source, result, context, path) {
  if (path === 'text') {
    return result && (result.text || result.visibleTextSummary || result.pageModel && result.pageModel.visibleTextSummary)
      || context.pageModel && context.pageModel.visibleTextSummary;
  }
  if (path === 'cartCountAtLeast') {
    return result && (result.cartCountAtLeast || result.cartCount || 0);
  }
  let actual = getPathValue(source, path);
  if (actual !== undefined) return actual;
  if (!String(path).includes('.')) {
    actual = result && result[path];
    if (actual !== undefined) return actual;
    actual = context.pageModel && context.pageModel[path];
    if (actual !== undefined) return actual;
    actual = result && result.pageModel && result.pageModel[path];
    if (actual !== undefined) return actual;
  }
  return actual;
}

function conditionValueMatches(path, actual, expected) {
  if (expected === undefined) return true;
  if (typeof expected === 'string') {
    const actualText = String(actual === undefined || actual === null ? '' : actual);
    if (path === 'url' || path.endsWith('.url')) return actualText.includes(expected);
    if (path === 'text' || path.endsWith('.text')) return actualText.toLowerCase().includes(expected.toLowerCase());
  }
  if (path === 'confirmationVisible' || path === 'cartCountAtLeast') {
    if (path === 'confirmationVisible') return Boolean(actual) === Boolean(expected);
    return Number(actual || 0) >= Number(expected || 0);
  }
  return actual === expected;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectKnownSecrets(source, out = new Set()) {
  if (Array.isArray(source)) {
    for (const item of source) collectKnownSecrets(item, out);
    return out;
  }
  if (!isPlainObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (SENSITIVE_KEY_RE.test(key) && typeof value === 'string' && value) out.add(value);
    else collectKnownSecrets(value, out);
  }
  return out;
}

function redactString(value, secrets = []) {
  let output = String(value);
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

function redactScenarioValue(value, options = {}, key = '', seen = new WeakSet()) {
  const secrets = options.secrets || [];
  if (SENSITIVE_KEY_RE.test(key)) return value === null || value === undefined || value === '' ? value : REDACTED;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactScenarioValue(item, options, key, seen));
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactScenarioValue(childValue, options, childKey, seen);
  }
  seen.delete(value);
  return out;
}

function scenarioSecrets(context = {}) {
  return Array.from(collectKnownSecrets(context.profile || context.config && context.config.profile || {}));
}

function contextFromInput(input = {}) {
  const context = { ...(input.context || {}) };
  for (const key of ['page', 'profile', 'config', 'telemetry', 'logger', 'coverage', 'observe', 'modelExtractor', 'feedbackExtractor', 'formAttemptLedger', 'personaSession', 'baseUrl']) {
    if (input[key] !== undefined) context[key] = input[key];
  }
  if (!context.profile && context.config && context.config.profile) context.profile = context.config.profile;
  return context;
}

async function executeStep(step, input = {}) {
  const handlers = input.handlers || {};
  const context = input.context || {};
  const handler = handlers[step.id] || handlers[step.type];
  if (typeof handler !== 'function') {
    return { ok: false, stepId: step.id, type: step.type, error: `No scenario handler registered for step ${step.id} (${step.type}).` };
  }
  const started = Date.now();
  const previousDeadline = context._operationDeadline;
  context._operationDeadline = createDeadline(step.timeoutMs, {
    operation: 'scenario-step',
    source: 'scenario.step.timeoutMs',
    stepId: step.id
  });
  try {
    const handlerResult = await withTimeout(handler(step, context), step.timeoutMs, `scenario step ${step.id}`, {
      operation: 'scenario-step',
      source: 'scenario.step.timeoutMs',
      stepId: step.id
    });
    const failure = evaluateCondition(step.failure, handlerResult, context);
    const redaction = { secrets: scenarioSecrets(context) };
    const redactedHandlerResult = redactScenarioValue(handlerResult, redaction);
    if (step.failure && failure.ok) {
      return { ok: false, stepId: step.id, type: step.type, result: redactedHandlerResult, error: 'Scenario failure condition matched.', timing: { durationMs: Date.now() - started, timeoutMs: step.timeoutMs } };
    }
    const success = evaluateCondition(step.success, handlerResult, context);
    return {
      ok: Boolean(handlerResult && handlerResult.ok !== false && success.ok),
      stepId: step.id,
      type: step.type,
      result: redactedHandlerResult,
      success,
      timing: { durationMs: Date.now() - started, timeoutMs: step.timeoutMs }
    };
  } catch (err) {
    return { ok: false, stepId: step.id, type: step.type, error: redactString(err.message, scenarioSecrets(context)), timing: { durationMs: Date.now() - started, timeoutMs: step.timeoutMs } };
  } finally {
    if (previousDeadline) context._operationDeadline = previousDeadline;
    else delete context._operationDeadline;
  }
}

async function executeStepWithRetry(step, input = {}) {
  const maxAttempts = step.retry && step.retry.maxAttempts ? step.retry.maxAttempts : 1;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeStep(step, input);
    attempts.push({ attempt, ...result });
    if (result.ok) return { ...result, attempts };
  }
  return { ...attempts[attempts.length - 1], attempts };
}

async function runScenario(input = {}) {
  const compiled = input.dag
    ? { scenario: input.scenario, dag: input.dag, dagJson: serializeDag(input.dag) }
    : compileScenario(input.scenario, input.compilerOptions);
  const context = contextFromInput(input);
  const browserHandlers = shouldUseBrowserHandlers(context) ? createBrowserScenarioHandlers(context) : {};
  const handlers = { ...browserHandlers, ...(input.handlers || {}) };
  const state = createScenarioState(compiled.dag);
  const stepResults = [];
  const started = Date.now();
  while (true) {
    const readySteps = getReadySteps(compiled.dag, state);
    if (readySteps.length === 0) break;
    for (const step of readySteps) {
      state.statusById.set(step.id, 'running');
      const result = await executeStepWithRetry(step, { handlers, context });
      const effectiveResult = applyFailureBehavior(step, result);
      markStepResult(state, step.id, effectiveResult);
      stepResults.push(effectiveResult);
      if (!effectiveResult.ok && input.stopOnFailure !== false) {
        return { ok: false, completed: stepResults.filter(entry => entry.ok).length, failedStepId: step.id, blockedSteps: blockedSteps(stepResults), stepResults, dag: compiled.dagJson, timing: { durationMs: Date.now() - started } };
      }
    }
  }
  const pending = Array.from(state.statusById.entries()).filter(([, status]) => status === 'pending');
  return {
    ok: pending.length === 0 && stepResults.every(entry => entry.ok),
    completed: stepResults.filter(entry => entry.ok).length,
    pending: pending.map(([id]) => id),
    blockedSteps: blockedSteps(stepResults, pending.map(([id]) => id)),
    stepResults,
    dag: compiled.dagJson,
    timing: { durationMs: Date.now() - started }
  };
}

function applyFailureBehavior(step = {}, result = {}) {
  if (!result || result.ok || step.failureBehavior !== 'continue') return result;
  return {
    ...result,
    ok: true,
    optionalFailure: true,
    originalOk: false,
    optionalFailureReason: result.error || result.reason || result.result && (result.result.reason || result.result.error) || 'scenario_step_optional_failure',
    result: result.result && typeof result.result === 'object'
      ? {
        ...result.result,
        ok: result.result.ok !== false,
        optionalFailure: true,
        optionalFailureReason: result.error || result.reason || result.result.reason || result.result.error || 'scenario_step_optional_failure'
      }
      : result.result
  };
}

function createScenarioWorker(defaults = {}) {
  const formAttemptLedger = defaults.formAttemptLedger || createFormAttemptLedger();
  return {
    runScenario: input => runScenario({ formAttemptLedger, ...defaults, ...(input || {}) })
  };
}

function shouldUseBrowserHandlers(context = {}) {
  return Boolean(context.page);
}

function blockedSteps(stepResults = [], pending = []) {
  const blocked = stepResults.filter(result => !result.ok).map(result => {
    const feedback = result.result && result.result.validationFeedback || result.result && result.result.form && result.result.form.validationFeedback || null;
    return {
      stepId: result.stepId,
      type: result.type,
      reason: result.error || result.result && (result.result.reason || result.result.error) || 'scenario_step_failed',
      validationFeedback: feedback || undefined
    };
  });
  for (const stepId of pending) blocked.push({ stepId, reason: 'dependency_not_completed' });
  return blocked;
}

function resolveCrawlerConfig(context = {}, step = {}) {
  const config = context.config || {};
  return budgetedScenarioConfig(config, step, {
    scope: 'scenario',
    parentDeadline: context._operationDeadline || null
  });
}

function ensureScenarioRuntime(context = {}) {
  if (!context.formAttemptLedger) context.formAttemptLedger = createFormAttemptLedger();
  return context;
}

function createBrowserScenarioHandlers(defaultContext = {}) {
  ensureScenarioRuntime(defaultContext);
  const bind = executor => async (step, context = {}) => {
    const runtime = context === defaultContext ? context : Object.assign(defaultContext, context);
    return executor(step, ensureScenarioRuntime(runtime));
  };
  return {
    auth: bind(executeAuthStep),
    navigate: bind(executeNavigateStep),
    search: bind((step, context) => workflowSearch(step, context).catch(() => executeSearchStep(step, context))),
    'open-surface': bind(openSurface),
    'add-to-cart': bind(addToCart),
    'cart-add': bind(addToCart),
    'submit-feedback': bind(submitFeedback),
    'transfer-funds': bind(transferFunds),
    'click-action': bind(executeClickActionStep),
    'submit-form': bind(executeSubmitFormStep),
    'assert-state': bind(executeAssertStateStep)
  };
}

function compactPageModel(pageModel = {}) {
  return {
    url: pageModel.url || '',
    routeShape: pageModel.routeShape || '',
    title: pageModel.title || '',
    surfaceType: pageModel.surfaceType || '',
    visibleTextSummary: pageModel.visibleTextSummary || '',
    authSignals: pageModel.authSignals || [],
    blockers: pageModel.blockers || [],
    counts: {
      links: (pageModel.links || []).length,
      forms: (pageModel.forms || []).length,
      actions: (pageModel.actions || []).length
    }
  };
}

function observationSummary(observation = {}) {
  const events = observation.events || observation || [];
  return {
    events: Array.isArray(events) ? events.slice(0, 20).map(event => ({
      type: event.type || null,
      method: event.method || null,
      url: event.url || null,
      path: event.path || null,
      status: event.status
    })) : [],
    links: (observation.links || []).slice(0, 20)
  };
}

function mergeObservations(...observations) {
  const merged = {
    events: [],
    links: []
  };
  for (const observation of observations) {
    if (!observation) continue;
    const events = Array.isArray(observation.events) ? observation.events : Array.isArray(observation) ? observation : [];
    const links = Array.isArray(observation.links) ? observation.links : [];
    merged.events.push(...events);
    merged.links.push(...links);
  }
  return merged;
}

function normalizePostAuthProbes(step = {}, context = {}) {
  const probes = step.postAuthProbes || step.authProbes || step.target && step.target.postAuthProbes;
  if (!Array.isArray(probes)) return [];
  const baseUrl = context.config && context.config.target && context.config.target.baseUrl
    || context.baseUrl
    || context.page && typeof context.page.url === 'function' && context.page.url()
    || null;
  if (!baseUrl) return [];
  let base;
  try {
    base = new URL(baseUrl);
  } catch (_) {
    return [];
  }
  const normalized = [];
  for (const probe of probes) {
    const raw = typeof probe === 'string' ? { url: probe } : probe;
    if (!raw || typeof raw !== 'object' || !raw.url) continue;
    let url;
    try {
      url = new URL(String(raw.url), base.href);
    } catch (_) {
      continue;
    }
    if (url.origin !== base.origin) continue;
    const method = String(raw.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) continue;
    normalized.push({
      url: url.href,
      method,
      credentials: raw.credentials === 'same-origin' ? 'same-origin' : 'include'
    });
  }
  return normalized.slice(0, 5);
}

async function runPostAuthProbes(step = {}, context = {}) {
  const probes = normalizePostAuthProbes(step, context);
  if (probes.length === 0 || !context.page || typeof context.page.evaluate !== 'function') return [];
  return context.page.evaluate(async probeList => {
    const results = [];
    for (const probe of probeList) {
      try {
        const response = await fetch(probe.url, {
          method: probe.method || 'GET',
          credentials: probe.credentials || 'include',
          cache: 'no-store'
        });
        results.push({ url: probe.url, method: probe.method || 'GET', status: response.status, ok: response.ok });
      } catch (error) {
        results.push({ url: probe.url, method: probe.method || 'GET', status: 0, ok: false, error: error && error.message || 'fetch_failed' });
      }
    }
    return results;
  }, probes);
}

function authEvidenceFromObservation(observation = {}) {
  const events = Array.isArray(observation.events) ? observation.events : Array.isArray(observation) ? observation : [];
  const responses = events.filter(event => event && event.type === 'response');
  const requests = events.filter(event => event && event.type === 'request');
  const statusOk = event => Number(event.status) >= 200 && Number(event.status) < 300;
  const pathOf = event => String(event.path || event.url || '').toLowerCase();
  const looksAuthenticatedUserPath = event => {
    const path = pathOf(event);
    return /\/api\/(?:users?|profile|account|me)\b|\/rest\/user\/whoami\b|\/rest\/basket\/\d+\b|\/bank\/main\.jsp\b/.test(path);
  };
  const loginResponse = responses.some(event => {
    const path = pathOf(event);
    const method = String(event.method || '').toUpperCase();
    return statusOk(event) && method === 'POST' && /\/api\/auth\/.*login\b|\/api\/auth\/login\b|\/login\b|\/signin\b/.test(path);
  });
  const authenticatedFetch = responses.some(event => statusOk(event) && looksAuthenticatedUserPath(event));
  const authenticatedRequest = requests.some(event => looksAuthenticatedUserPath(event));
  return {
    ok: loginResponse && (authenticatedFetch || authenticatedRequest),
    loginResponse,
    authenticatedFetch,
    authenticatedRequest
  };
}

function authFailureFromObservation({ authState = null, invalid = false, formResult = {}, pageModel = {}, observation = {} } = {}) {
  if (authState === 'authenticated') return null;
  const events = Array.isArray(observation.events) ? observation.events : Array.isArray(observation) ? observation : [];
  const responses = events.filter(event => event && event.type === 'response');
  const loginResponses = responses.filter(event => {
    const method = String(event.method || '').toUpperCase();
    const path = String(event.path || event.url || '').toLowerCase();
    return method === 'POST' && /login|signin|auth|session/.test(path);
  });
  const statusCodes = loginResponses
    .map(event => Number(event.status))
    .filter(status => Number.isFinite(status));
  const statusCode = statusCodes.find(status => status >= 400) || statusCodes[0] || null;
  const text = [
    pageModel && pageModel.visibleTextSummary,
    pageModel && pageModel.visibleText,
    pageModel && pageModel.title,
    JSON.stringify(formResult && formResult.validationFeedback || {})
  ].filter(Boolean).join(' ').toLowerCase();
  let classification = 'unknown';
  let retryable = false;
  if (statusCode === 429 || /rate limit|too many/.test(text)) {
    classification = 'rate_limited';
    retryable = true;
  } else if (statusCode === 423 || /account locked|locked/.test(text)) {
    classification = 'account_locked';
  } else if (statusCode === 401 || statusCode === 403) {
    classification = 'target_rejected_credentials';
  } else if (/csrf|token/.test(text)) {
    classification = 'csrf_missing';
  } else if (/captcha|recaptcha/.test(text)) {
    classification = 'captcha_blocked';
  } else if (invalid) {
    classification = 'target_rejected_credentials';
  } else if (formResult && formResult.submitted && authState === 'submitted') {
    const redirectedBackToLogin = responses.some(event => Number(event.status) >= 300 && Number(event.status) < 400)
      && authStateFromModel(pageModel) === 'login-required';
    classification = redirectedBackToLogin ? 'target_rejected_credentials' : 'unknown';
  }
  return {
    classification,
    retryable,
    statusCode,
    redactedEvidence: {
      loginResponseStatuses: statusCodes,
      loginResponsePaths: loginResponses.map(event => event.path || event.url || null).filter(Boolean).slice(0, 5),
      finalAuthState: authState,
      formSubmitted: Boolean(formResult && formResult.submitted),
      validation: invalid ? 'present' : 'none'
    }
  };
}

async function readPageModel(context = {}, options = {}) {
  if (context.pageModel && options.refresh !== true) return context.pageModel;
  const modelExtractor = context.modelExtractor || extractPageModel;
  const extractorOptions = {
    baseUrl: options.baseUrl || baseUrlForContext(context),
    spaHashBaseUrl: context.config && context.config.target && context.config.target.baseUrl
  };
  let pageModel;
  try {
    pageModel = await modelExtractor(context.page, extractorOptions);
  } catch (error) {
    if (!isNavigationRaceError(error) || options.retryNavigationRace === false) throw error;
    await settleScenarioNavigationRace(context.page, context.config).catch(() => null);
    pageModel = await modelExtractor(context.page, {
      ...extractorOptions,
      baseUrl: options.baseUrl || baseUrlForContext(context) || extractorOptions.baseUrl
    });
  }
  context.pageModel = pageModel;
  return pageModel;
}

function isNavigationRaceError(error) {
  const message = error && error.message || String(error || '');
  return /execution context was destroyed|navigation|frame was detached|target closed/i.test(message);
}

async function settleScenarioNavigationRace(page, config = {}) {
  if (!page) return;
  const waitMs = Math.max(100, Math.min(Number(config && config.crawler && config.crawler.maxObservationMs) || 500, 1000));
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('domcontentloaded', { timeout: waitMs }).catch(() => null);
  }
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(waitMs).catch(() => null);
  }
}

async function observeScenarioPage(context = {}, step = {}) {
  const observe = context.observe || observePage;
  const config = resolveCrawlerConfig(context, step);
  return observe(context.page, { maxObservationMs: config.crawler.maxObservationMs });
}

function baseUrlForContext(context = {}) {
  if (context.config && context.config.target && context.config.target.baseUrl) return context.config.target.baseUrl;
  if (context.baseUrl) return context.baseUrl;
  if (context.page && typeof context.page.url === 'function') {
    try {
      return context.page.url();
    } catch (_) {
      return null;
    }
  }
  if (context.pageModel && context.pageModel.url) return context.pageModel.url;
  return null;
}

function stepText(step = {}) {
  const target = isPlainObject(step.target) ? Object.values(step.target).join(' ') : step.target;
  return [step.value, target, step.metadata && step.metadata.sourceText].filter(Boolean).join(' ').trim();
}

function resolveUrlCandidate(candidate, baseUrl) {
  if (!candidate) return null;
  const raw = isPlainObject(candidate)
    ? candidate.url || candidate.href || candidate.route || candidate.path
    : candidate;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (!/^(?:https?:\/\/|\/|#\/|\?)/i.test(value)) return null;
  return normalizeUrl(value, baseUrl) || value;
}

function stepUrl(step = {}, context = {}) {
  const baseUrl = baseUrlForContext(context);
  return resolveUrlCandidate(step.target, baseUrl)
    || resolveUrlCandidate(step.value, baseUrl)
    || resolveUrlCandidate(step.metadata && (step.metadata.url || step.metadata.route || step.metadata.href), baseUrl);
}

function scenarioRouteHint(step = {}, context = {}, pattern = null) {
  const baseUrl = baseUrlForContext(context);
  const hints = (context.scenarioRouteHints || [])
    .map(hint => resolveUrlCandidate(hint, baseUrl))
    .filter(Boolean);
  if (!pattern) return hints[0] || null;
  return hints.find(hint => pattern.test(String(hint).toLowerCase())) || null;
}

function scenarioRoutePatternForStep(step = {}) {
  const text = stepText(step).toLowerCase();
  if (/\b(login|sign[ -]?in|authentication|credentials)\b/.test(text)) return /(?:#\/)?(?:login|signin|sign-in|auth|account)/;
  if (/\b(account summary|main account|dashboard|account route|profile)\b/.test(text)) return /(?:bank\/main|#\/profile|\/profile|account|dashboard)/;
  if (/\btransfer\b/.test(text)) return /(?:bank\/transfer|transfer)/;
  if (/\b(recent transactions|transactions)\b/.test(text)) return /(?:bank\/transaction|transaction)/;
  if (/\b(news|search)\b/.test(text)) return /(?:search|news)/;
  if (/\b(cart|basket)\b/.test(text)) return /(?:#\/basket|\/basket|cart)/;
  if (/\bcheckout\b/.test(text)) return /(?:#\/checkout|\/checkout)/;
  if (/\b(feedback|contact|complain|support)\b/.test(text)) return /(?:#\/contact|\/contact|complain|support|feedback)/;
  if (/\b(order history|orders|review)\b/.test(text)) return /(?:order-history|orders|review)/;
  if (/\b(wallet)\b/.test(text)) return /(?:wallet)/;
  if (/\b(address)\b/.test(text)) return /(?:address)/;
  if (/\b(payment|card)\b/.test(text)) return /(?:payment|card)/;
  return null;
}

function scenarioRouteHintForStep(step = {}, context = {}) {
  const pattern = scenarioRoutePatternForStep(step);
  return pattern ? scenarioRouteHint(step, context, pattern) : null;
}

function textMatches(item = {}, query = '') {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return false;
  const haystack = [
    item.id,
    item.label,
    item.text,
    item.title,
    item.href,
    item.url,
    item.selector,
    item.kind
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle) || needle.includes(haystack);
}

function findLink(pageModel = {}, step = {}) {
  const query = step.actionId || stepText(step);
  return (pageModel.links || []).find(link => step.actionId && link.id === step.actionId)
    || (pageModel.links || []).find(link => textMatches(link, query));
}

function findAction(pageModel = {}, step = {}, predicate = null) {
  const query = step.actionId || stepText(step);
  return (pageModel.actions || []).find(action => step.actionId && action.id === step.actionId)
    || (pageModel.actions || []).find(action => predicate && predicate(action))
    || (pageModel.actions || []).find(action => textMatches(action, query));
}

function findForm(pageModel = {}, step = {}, predicate = null) {
  if (step.formId) {
    const exact = (pageModel.forms || []).find(form => form.id === step.formId || form.selector === step.formId);
    if (exact) return exact;
  }
  const query = stepText(step);
  return (pageModel.forms || []).find(form => predicate && predicate(form))
    || (pageModel.forms || []).find(form => textMatches(form, query))
    || null;
}

function profileForStep(step = {}, context = {}, overrides = {}) {
  const base = context.profile || context.config && context.config.profile || {};
  const metadataValues = step.metadata && isPlainObject(step.metadata.values) ? step.metadata.values : {};
  const stepValues = isPlainObject(step.value) ? step.value : {};
  return {
    ...base,
    personaId: step.persona || base.personaId || base.activePersonaId,
    values: {
      ...(base.values || {}),
      ...metadataValues,
      ...stepValues,
      ...(overrides.values || {})
    },
    credentials: {
      ...(base.credentials || {}),
      ...(overrides.credentials || {})
    }
  };
}

function authStateFromModel(pageModel = {}) {
  const signals = pageModel.authSignals || [];
  if (signals.includes('authenticated-text')) return 'authenticated';
  if (signals.includes('login-form') || signals.includes('password-field')) return 'login-required';
  return 'unknown';
}

function resultFromPageModel(pageModel = {}, extra = {}) {
  return {
    ok: true,
    completed: true,
    url: pageModel.url || '',
    routeShape: pageModel.routeShape || '',
    surfaceType: pageModel.surfaceType || '',
    title: pageModel.title || '',
    authState: authStateFromModel(pageModel),
    pageModel: compactPageModel(pageModel),
    ...extra
  };
}

function routeCandidatesFromStep(step = {}, context = {}) {
  const baseUrl = baseUrlForContext(context);
  const candidates = [];
  const target = step.target;
  if (isPlainObject(target)) {
    if (target.route) candidates.push(target.route);
    if (Array.isArray(target.routes)) candidates.push(...target.routes);
    if (target.url) candidates.push(target.url);
  }
  const explicit = stepUrl(step, context);
  if (explicit) candidates.unshift(explicit);
  return Array.from(new Set(candidates.map(candidate => resolveUrlCandidate(candidate, baseUrl)).filter(Boolean)));
}

async function executeNavigateStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario navigate step requires context.page.');
  const config = resolveCrawlerConfig(context, step);
  const before = await readPageModel(context, { refresh: true });
  const routeCandidates = routeCandidatesFromStep(step, context);
  const url = routeCandidates[0] || scenarioRouteHintForStep(step, context);
  let action = null;
  const terminalDownloads = [];
  if (url) {
    for (const candidate of routeCandidates.length ? routeCandidates : [url]) {
      try {
        await gotoRoute(context.page, { url: candidate }, config.crawler.maxRouteMs, { config });
      } catch (err) {
        if (!/download is starting/i.test(err && err.message || String(err || ''))) throw err;
        terminalDownloads.push({ url: candidate, reason: 'download_started' });
      }
      await observeScenarioPage(context, step).catch(() => null);
    }
  } else {
    const link = findLink(before, step);
    if (link && link.href) await gotoRoute(context.page, { url: link.href }, config.crawler.maxRouteMs, { config });
    else {
      action = findAction(before, step);
      if (!action) throw new Error(`No navigation target found for scenario step ${step.id}.`);
      await executeSafeAction(context.page, action, config.crawler.maxActionMs, { config });
    }
  }
  const observation = await observeScenarioPage(context, step);
  const after = await readPageModel(context, { refresh: true, baseUrl: before.url || baseUrlForContext(context) });
  const transition = validateTransition({ before, after, events: observation.events || observation, action: action || { id: step.id, kind: 'navigate' } });
  return resultFromPageModel(after, {
    transition,
    routesVisited: routeCandidates,
    terminalDownloads,
    observation: observationSummary(observation)
  });
}

async function executeClickActionStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario click-action step requires context.page.');
  const config = resolveCrawlerConfig(context, step);
  const before = await readPageModel(context, { refresh: true });
  const targetText = [
    step.actionId,
    step.action,
    step.target && step.target.action,
    step.value
  ].filter(Boolean).join(' ');
  const action = findAction(before, step, candidate => {
    const haystack = `${candidate.id || ''} ${candidate.kind || ''} ${candidate.label || ''} ${candidate.href || ''}`.toLowerCase();
    return targetText && haystack.includes(String(targetText).toLowerCase());
  });
  if (!action) return resultFromPageModel(before, { ok: false, reason: 'action_not_found' });
  await executeSafeAction(context.page, action, config.crawler.maxActionMs, { config });
  const observation = await observeScenarioPage(context, step);
  const after = await readPageModel(context, { refresh: true, baseUrl: before.url });
  const transition = validateTransition({ before, after, events: observation.events || observation, action });
  return resultFromPageModel(after, {
    transition,
    action: { id: action.id, kind: action.kind, label: action.label },
    observation: observationSummary(observation)
  });
}

async function executeSearchStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario search step requires context.page.');
  const config = resolveCrawlerConfig(context, step);
  const term = searchTermForStep(step, context);
  const before = await readPageModel(context, { refresh: true });
  const searchForm = findForm(before, step, form => form.kind === 'search' || (form.fields || []).some(field => /search|query|q\b/i.test(`${field.name || ''} ${field.label || ''} ${field.type || ''}`)));
  let formResult = null;
  let action = null;
  if (searchForm) {
    formResult = await runFormWorker({
      page: context.page,
      form: searchForm,
      profile: profileForStep(step, context, { values: { search: term, query: term, q: term } }),
      config,
      telemetry: context.telemetry,
      allowSubmit: true,
      submissionLedger: context.formAttemptLedger,
      observe: context.observe || observePage,
      modelExtractor: context.modelExtractor || extractPageModel,
      feedbackExtractor: context.feedbackExtractor,
      operation: 'scenario-form-submit',
      step,
      parentDeadline: context._operationDeadline || null
    });
  } else if (context.page && typeof context.page.search === 'function') {
    await context.page.search(term, { timeout: config.crawler.maxActionMs });
  } else {
    action = findAction(before, step, candidate => candidate.kind === 'type-search' || /search/i.test(candidate.label || candidate.kind || ''));
    if (action) await executeSafeAction(context.page, { ...action, value: term }, config.crawler.maxActionMs, { config });
    else await gotoRoute(context.page, { url: fallbackSearchUrl(term, context) }, config.crawler.maxRouteMs, { config });
  }
  const observation = formResult ? formResult.observation || { events: [] } : await observeScenarioPage(context, step);
  const after = formResult && formResult.after ? formResult.after : await readPageModel(context, { refresh: true, baseUrl: before.url });
  const invalid = formResult && hasValidationFeedback(formResult.validationFeedback);
  return resultFromPageModel(after, {
    ok: !invalid,
    searchTerm: term,
    form: formResult && {
      formId: formResult.formId,
      submitted: formResult.submitted,
      skipped: formResult.skipped,
      reason: formResult.reason,
      validationFeedback: formResult.validationFeedback,
      plan: formResult.plan,
      budget: formResult.budget
    },
    validationFeedback: formResult && formResult.validationFeedback,
    transition: formResult ? formResult.transition : validateTransition({ before, after, events: observation.events || observation, action: action || { id: step.id, kind: 'search' } }),
    observation: observationSummary(observation)
  });
}

function searchTermForStep(step = {}, context = {}) {
  if (isPlainObject(step.target) && step.target.query) return String(step.target.query);
  if (typeof step.value === 'string' && step.value.trim()) {
    const quoted = step.value.match(/"([^"]+)"/);
    if (quoted && quoted[1]) return quoted[1].trim();
    const explicit = step.value.match(/\bsearch\s+(?:for|news articles for)?\s*([a-z0-9][a-z0-9 _.-]{0,60})/i);
    if (explicit && explicit[1]) return explicit[1].replace(/[.。]+$/, '').trim();
    if (/news articles/i.test(step.value)) return 'News Articles';
    return step.value.trim();
  }
  if (step.metadata && step.metadata.query) return String(step.metadata.query);
  const profile = context.profile || context.config && context.config.profile || {};
  const values = profile.values || {};
  if (profile.search || profile.query || profile.q) return profile.search || profile.query || profile.q;
  if (values.search || values.query || values.q) return values.search || values.query || values.q;
  if (Array.isArray(profile.searchTerms) && profile.searchTerms.length > 0) return String(profile.searchTerms[0]);
  return 'test';
}

function fallbackSearchUrl(term, context = {}) {
  const baseUrl = baseUrlForContext(context) || 'http://localhost/';
  try {
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', term);
    return url.href;
  } catch (_) {
    return `/search?q=${encodeURIComponent(term)}`;
  }
}

async function executeAuthStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario auth step requires context.page.');
  const url = stepUrl(step, context) || scenarioRouteHintForStep(step, context);
  if (url) {
    const config = resolveCrawlerConfig(context, step);
    await gotoRoute(context.page, { url }, config.crawler.maxRouteMs, { config });
    await observeScenarioPage(context, step).catch(() => null);
  }
  let lastResult = null;
  const maxAttempts = Number(step && step.retry && step.retry.maxAttempts) > 0 ? Number(step.retry.maxAttempts) : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await dismissCommonBlockers(context.page).catch(() => null);
    let before = await readPageModel(context, { refresh: true });
    if (authStateFromModel(before) === 'authenticated') {
      if (context.personaSession && typeof context.personaSession.markAuthenticated === 'function') context.personaSession.markAuthenticated('already_authenticated');
      const postAuthProbes = await runPostAuthProbes(step, context).catch(error => [{ ok: false, error: error.message || 'post_auth_probe_failed' }]);
      return resultFromPageModel(before, { authState: 'authenticated', postAuthProbes });
    }
    let loginForm = findForm(before, step, form => form.kind === 'login' || (form.fields || []).some(field => field.type === 'password'));
    if (!loginForm) {
      await observeScenarioPage(context, step).catch(() => null);
      before = await readPageModel(context, { refresh: true });
      loginForm = findForm(before, step, form => form.kind === 'login' || (form.fields || []).some(field => field.type === 'password'));
    }
    if (!loginForm) return resultFromPageModel(before, { ok: false, reason: 'login_form_not_found', authState: authStateFromModel(before) });
    const config = resolveCrawlerConfig(context, step);
    const formResult = await runFormWorker({
      page: context.page,
      form: loginForm,
      profile: profileForStep(step, context),
      config,
      telemetry: context.telemetry,
      allowSubmit: true,
      submissionLedger: context.formAttemptLedger,
      observe: context.observe || observePage,
      modelExtractor: context.modelExtractor || extractPageModel,
      feedbackExtractor: context.feedbackExtractor,
      operation: 'scenario-form-submit',
      step,
      parentDeadline: context._operationDeadline || null
    });
    await dismissCommonBlockers(context.page).catch(() => null);
    const postSubmitObservation = await observeScenarioPage(context, step).catch(() => null);
    const after = await readPageModel(context, { refresh: true, baseUrl: before.url });
    const invalid = hasValidationFeedback(formResult.validationFeedback);
    const modelAuthState = authStateFromModel(after);
    const combinedObservation = mergeObservations(formResult.observation || {}, postSubmitObservation || {});
    const authEvidence = authEvidenceFromObservation(combinedObservation);
    const authState = modelAuthState === 'authenticated'
      || (formResult.submitted && invalid !== true && (authEvidence.ok || authEvidence.authenticatedFetch))
      ? 'authenticated'
      : invalid
        ? 'blocked'
        : formResult.submitted ? 'submitted' : 'not_authenticated';
    const authFailure = authFailureFromObservation({
      authState,
      invalid,
      formResult,
      pageModel: after,
      observation: combinedObservation
    });
    lastResult = resultFromPageModel(after, {
      ok: authState === 'authenticated',
      authState,
      authFailure,
      form: {
        formId: formResult.formId,
        submitted: formResult.submitted,
        skipped: formResult.skipped,
        reason: formResult.reason,
        validationFeedback: formResult.validationFeedback,
        plan: formResult.plan,
        budget: formResult.budget
      },
      validationFeedback: formResult.validationFeedback,
      transition: formResult.transition,
      authEvidence,
      observation: observationSummary(combinedObservation)
    });
    if (authState === 'authenticated') {
      if (context.personaSession && typeof context.personaSession.markAuthenticated === 'function') {
        context.personaSession.markAuthenticated('scenario_auth_success');
      }
      lastResult.postAuthProbes = await runPostAuthProbes(step, context).catch(error => [{ ok: false, error: error.message || 'post_auth_probe_failed' }]);
      return lastResult;
    }
    if (invalid || !formResult.submitted) return lastResult;
  }
  return lastResult || resultFromPageModel(await readPageModel(context, { refresh: true }), { ok: false, authState: 'not_authenticated' });
}

async function dismissCommonBlockers(page) {
  await dismissCommonOverlays(page, { timeoutMs: 500 }).catch(() => null);
  if (!page || typeof page.evaluate !== 'function') return;
  return page.evaluate(() => {
    const patterns = [/dismiss/i, /accept/i, /close/i, /got it/i, /continue/i, /agree/i, /allow/i, /\bok\b/i];
    const controls = Array.from(document.querySelectorAll('button,[role="button"],a'));
    for (const pattern of patterns) {
      const target = controls.find(element => pattern.test((element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
      if (target) target.click();
    }
  });
}

async function executeSubmitFormStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario submit-form step requires context.page.');
  const config = resolveCrawlerConfig(context, step);
  const routeCandidates = routeCandidatesFromStep(step, context);
  if (routeCandidates.length) {
    for (const candidate of routeCandidates) {
      await gotoRoute(context.page, { url: candidate }, config.crawler.maxRouteMs, { config });
      await observeScenarioPage(context, step).catch(() => null);
    }
  }
  const pageModel = await readPageModel(context, { refresh: true });
  const form = findForm(pageModel, step, candidate => candidate.kind !== 'search' && candidate.kind !== 'login') || findForm(pageModel, step);
  if (!form) return resultFromPageModel(pageModel, { ok: false, reason: 'form_not_found' });
  const formResult = await runFormWorker({
    page: context.page,
    form,
    profile: profileForStep(step, context),
    config,
    telemetry: context.telemetry,
    allowSubmit: step.metadata && step.metadata.allowSubmit === false ? false : true,
    submissionLedger: context.formAttemptLedger,
    observe: context.observe || observePage,
    modelExtractor: context.modelExtractor || extractPageModel,
    feedbackExtractor: context.feedbackExtractor,
    operation: 'scenario-form-submit',
    step,
    parentDeadline: context._operationDeadline || null
  });
  const after = formResult.after || await readPageModel(context, { refresh: true, baseUrl: pageModel.url });
  const invalid = hasValidationFeedback(formResult.validationFeedback);
  return resultFromPageModel(after, {
    ok: formResult.submitted === true && invalid !== true,
    form: {
      formId: formResult.formId,
      submitted: formResult.submitted,
      skipped: formResult.skipped,
      reason: formResult.reason,
      validationFeedback: formResult.validationFeedback,
      plan: formResult.plan,
      budget: formResult.budget
    },
    validationFeedback: formResult.validationFeedback,
    transition: formResult.transition,
    observation: observationSummary(formResult.observation || {})
  });
}

async function executeAssertStateStep(step, context = {}) {
  if (!context.page) throw new Error('Browser scenario assert-state step requires context.page.');
  const pageModel = await readPageModel(context, { refresh: true });
  if (step.metadata && (step.metadata.coverageObjective || step.metadata.policyConstraint)) {
    return resultFromPageModel(pageModel, {
      assertionType: step.metadata.coverageObjective ? 'coverage-objective' : 'policy-constraint',
      sourceText: step.metadata.sourceText || null
    });
  }
  const checks = expectedStateChecks(step);
  const failures = [];
  const visible = `${pageModel.title || ''} ${pageModel.url || ''} ${pageModel.visibleTextSummary || ''}`.toLowerCase();
  for (const check of checks) {
    if (check.kind === 'contains' && !visible.includes(check.value.toLowerCase())) failures.push(check);
    if (check.kind === 'surfaceType' && pageModel.surfaceType !== check.value) failures.push(check);
    if (check.kind === 'authState' && authStateFromModel(pageModel) !== check.value) failures.push(check);
    if (check.kind === 'url' && !String(pageModel.url || '').includes(check.value)) failures.push(check);
  }
  return resultFromPageModel(pageModel, {
    ok: failures.length === 0,
    assertions: checks.map(check => ({ ...check, passed: !failures.some(failure => JSON.stringify(failure) === JSON.stringify(check)) })),
    failures
  });
}

function expectedStateChecks(step = {}) {
  const checks = [];
  if (isPlainObject(step.target)) {
    if (step.target.text) checks.push({ kind: 'contains', value: String(step.target.text) });
    if (step.target.contains) checks.push({ kind: 'contains', value: String(step.target.contains) });
    if (step.target.surfaceType) checks.push({ kind: 'surfaceType', value: String(step.target.surfaceType) });
    if (step.target.authState) checks.push({ kind: 'authState', value: String(step.target.authState) });
    if (step.target.url) checks.push({ kind: 'url', value: String(step.target.url) });
  }
  if (typeof step.value === 'string' && step.value.trim()) checks.push({ kind: 'contains', value: step.value.trim() });
  if (step.metadata && step.metadata.contains) checks.push({ kind: 'contains', value: String(step.metadata.contains) });
  return checks;
}

module.exports = {
  createBrowserScenarioHandlers,
  createScenarioWorker,
  runScenario,
  executeStep,
  executeStepWithRetry,
  executeAuthStep,
  executeNavigateStep,
  executeSearchStep,
  executeSubmitFormStep,
  executeAssertStateStep,
  evaluateCondition,
  redactScenarioValue,
  withTimeout
};
