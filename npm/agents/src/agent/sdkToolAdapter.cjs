'use strict';

const { RISK_TIERS, normalizeAction } = require('../browser/actionModel.cjs');
const { extractPageModel } = require('../browser/pageModel.cjs');
const { validateTransition } = require('../browser/transition.cjs');
const { observePage } = require('../browser/eventCollector.cjs');
const { executeSafeAction } = require('../crawl/actionWorker.cjs');
const { runFormWorker, valueForField } = require('../crawl/formWorker.cjs');
const { surfaceExpansionCandidates } = require('../crawl/surfaceExplorer.cjs');
const { closeBlockingSurfaces } = require('../browser/recovery.cjs');
const { redactSecrets } = require('../core/config.cjs');
const { cssAttributeSelector, cssIdSelector } = require('../browser/cssSelector.cjs');

function createSdkToolAdapter({
  page = null,
  config = {},
  context = {},
  telemetry = null,
  logger = null
} = {}) {
  const adapter = context.sdkToolAdapter || {};

  async function observe({ handles = null, turn = 0 } = {}) {
    if (typeof adapter.observe === 'function') return adapter.observe({ page, config, context, handles, turn, telemetry, logger });
    const pageModel = await latestPageModel({
      page,
      config,
      context,
      forceFresh: Boolean(page && typeof page.evaluate === 'function')
    });
    if (handles && pageModel) issuePageModelHandles({ handles, pageModel, coverage: context.coverage, config, turn });
    return redactSecrets({
      currentPage: summarizePageModel(pageModel),
      coverage: summarizeCoverage(context.coverage || {}),
      handles: handles && handles.snapshot ? handles.snapshot() : []
    });
  }

  async function executeControlHandle({ handle, step = {} } = {}) {
    if (typeof adapter.executeControlHandle === 'function') return adapter.executeControlHandle({ handle, step, page, config, context, telemetry, logger });
    const routeCheck = await validateHandleStillOnPage({ handle, page });
    if (!routeCheck.ok) return notExecutable(routeCheck.reason);
    const action = normalizeHandleActionForExecution(normalizeAction(handle && handle.target || {}, 0), handle);
    return executeActionLike({ action, reason: 'click_control', page, config, context, telemetry, logger });
  }

  async function executeSurfaceHandle({ handle, step = {} } = {}) {
    if (typeof adapter.executeSurfaceHandle === 'function') return adapter.executeSurfaceHandle({ handle, step, page, config, context, telemetry, logger });
    const routeCheck = await validateHandleStillOnPage({ handle, page });
    if (!routeCheck.ok) return notExecutable(routeCheck.reason);
    const action = normalizeHandleActionForExecution(normalizeAction(handle && handle.target || {}, 0), handle);
    return executeActionLike({ action, reason: 'open_surface', page, config, context, telemetry, logger });
  }

  async function executeFormHandle({ handle, values = {}, submit = true, step = {} } = {}) {
    if (typeof adapter.executeFormHandle === 'function') return adapter.executeFormHandle({ handle, values, submit, step, page, config, context, telemetry, logger });
    if (!page || typeof page.evaluate !== 'function') {
      return notExecutable('form_adapter_requires_live_page');
    }
    const form = handle && handle.target || null;
    if (!form) return notExecutable('form_handle_missing_target');
    const routeCheck = await validateHandleStillOnPage({ handle, page });
    if (!routeCheck.ok) return notExecutable(routeCheck.reason);
    if (!submit) {
      const authStateBefore = inferAuthStateFromContext(context);
      const profile = profileFromResolvedValues(values, context.profile || {});
      const fillResult = await fillFormFieldsOnly(page, form, profile, config, values).catch(error => ({
        ok: false,
        reason: error && error.message || String(error || 'fill_form_failed'),
        filled: 0,
        planned: 0
      }));
      const coverage = mergeCoverage(context.coverage || {}, {
        forms: [form],
        routeUrl: form.routeUrl || safePageUrl(page),
        action: { id: form.id || 'form', kind: 'fill-form', label: form.id || 'form' },
        transition: {
          changed: Boolean(fillResult.ok && fillResult.filled > 0),
          changedState: Boolean(fillResult.ok && fillResult.filled > 0),
          noProgress: !(fillResult.ok && fillResult.filled > 0),
          reason: fillResult.ok ? 'form_fields_filled' : fillResult.reason || 'form_fill_failed'
        }
      });
      context.coverage = coverage;
      return {
        ok: Boolean(fillResult.ok),
        status: fillResult.ok ? 'completed' : 'no_progress',
        reason: fillResult.ok ? 'form_fields_filled' : fillResult.reason || 'form_fill_failed',
        browserActionRan: Boolean(fillResult.ok && fillResult.filled > 0),
        coverage,
        transition: {
          changed: Boolean(fillResult.ok && fillResult.filled > 0),
          changedState: Boolean(fillResult.ok && fillResult.filled > 0),
          noProgress: !(fillResult.ok && fillResult.filled > 0),
          reason: fillResult.ok ? 'form_fields_filled' : fillResult.reason || 'form_fill_failed'
        },
        valuesResolvedLocally: Object.keys(values || {}).length,
        authStateBefore,
        authStateAfter: authStateBefore,
        authStatePreserved: authStateBefore === 'unknown' ? null : true,
        result: fillResult
      };
    }
    clearPageModelCache(context);
    const profile = profileFromResolvedValues(values, context.profile || {});
    const result = await runFormWorker({
      page,
      form,
      profile,
      config,
      telemetry,
      allowSubmit: true
    });
    clearPageModelCache(context);
    const authStateBefore = inferAuthStateFromPageModel(result.before) || inferAuthStateFromContext(context);
    const authStateAfter = inferAuthStateFromPageModel(result.after) || authStateBefore;
    const coverage = mergeCoverage(context.coverage || {}, {
      forms: [form],
      endpoints: (result.observation && (result.observation.events || result.observation.endpoints)) || [],
      routeUrl: result.before && result.before.url || form.routeUrl || null,
      afterPageModel: result.after || null,
      action: { id: form.id, kind: 'submit-form', label: form.id || 'form' },
      transition: result.transition || null
    });
    context.coverage = coverage;
    return {
      ok: result.ok !== false && result.submitted !== false,
      status: result.skipped ? 'blocked' : result.ok === false ? 'no_progress' : 'completed',
      reason: result.reason || (result.validationFeedback && hasValidation(result.validationFeedback) ? 'validation_feedback' : null),
      browserActionRan: Boolean(result.submitted),
      coverage,
      transition: result.transition || { changed: false, noProgress: true, reason: 'form_submit_no_transition' },
      valuesResolvedLocally: Object.keys(values || {}).length,
      authStateBefore,
      authStateAfter,
      authStatePreserved: compareAuthStates(authStateBefore, authStateAfter),
      result
    };
  }

  async function visitRoute({ routeKey, executeRoute, mission, step } = {}) {
    if (typeof adapter.visitRoute === 'function') return adapter.visitRoute({ routeKey, executeRoute, mission, step, page, config, context, telemetry, logger });
    if (typeof executeRoute === 'function') return executeRoute(routeKey, { mission, step });
    return notExecutable('route_adapter_requires_execute_route');
  }

  async function recoverAuthState() {
    if (typeof adapter.recoverAuthState === 'function') return adapter.recoverAuthState({ page, config, context, telemetry, logger });
    return notExecutable('recover_auth_adapter_not_available');
  }

  return {
    observe,
    executeControlHandle,
    executeSurfaceHandle,
    executeFormHandle,
    visitRoute,
    recoverAuthState
  };
}

function issuePageModelHandles({ handles, pageModel = {}, coverage = {}, config = {}, turn = 0 } = {}) {
  if (!handles || typeof handles.issue !== 'function') return [];
  const issued = [];
  const routeKey = pageModel.url || null;
  for (const form of pageModel.forms || []) {
    issued.push(handles.issue({
      type: 'form',
      routeKey,
      stateKey: pageModel.stateKey || null,
      source: 'pageModel',
      policyTier: formPolicyTier(form, routeKey),
      createdAtTurn: turn,
      expiresAfterTurn: turn,
      stable: false,
      target: form,
      summary: summarizeForm(form)
    }));
  }
  for (const raw of [...(pageModel.newlyDiscoveredControls || []), ...(pageModel.actions || [])]) {
    const action = normalizeAction(raw, issued.length);
    const policyTier = actionPolicyTier(action);
    const handleAction = normalizeHandleActionForExecution(action, { policyTier, summary: summarizeAction(action) });
    issued.push(handles.issue({
      type: 'control',
      routeKey,
      stateKey: pageModel.stateKey || null,
      source: raw.source || 'pageModel',
      policyTier,
      createdAtTurn: turn,
      expiresAfterTurn: turn,
      stable: false,
      target: handleAction,
      summary: summarizeAction(handleAction)
    }));
  }
  for (const surface of surfaceExpansionCandidates(pageModel, config || {})) {
    issued.push(handles.issue({
      type: 'surface',
      routeKey,
      stateKey: pageModel.stateKey || null,
      source: 'surfaceExplorer',
      policyTier: 'safe',
      createdAtTurn: turn,
      expiresAfterTurn: turn,
      stable: false,
      target: surface,
      summary: summarizeAction(surface)
    }));
  }
  for (const route of [...(coverage.routes || []), ...(pageModel.routeCandidates || []), ...(pageModel.links || [])]) {
    const url = typeof route === 'string' ? route : route.url || route.href || route.path || null;
    if (!url) continue;
    issued.push(handles.issue({
      type: 'route',
      routeKey: url,
      stateKey: pageModel.stateKey || null,
      source: route.source || route.sourceTag || 'routeGraph',
      policyTier: 'safe',
      createdAtTurn: turn,
      expiresAfterTurn: turn,
      stable: true,
      summary: {
        url,
        source: route.source || route.sourceTag || null,
        routeShape: route.routeShape || route.shape || null
      }
    }));
  }
  return issued;
}

async function executeActionLike({ action, reason, page, config, context, telemetry, logger } = {}) {
  if (!action) return notExecutable(`${reason}_handle_missing_target`);
  if (!page) return notExecutable(`${reason}_adapter_requires_live_page`);
  const before = await latestPageModel({
    page,
    config,
    context,
    forceFresh: Boolean(page && typeof page.evaluate === 'function')
  });
  let actionError = null;
  let recovery = null;
  let retryError = null;
  let recoveredRetry = false;
  try {
    await executeSafeAction(page, action, config.crawler && config.crawler.maxActionMs || 1000, {
      config,
      allowBusinessMutation: agentAllowsBusinessMutation(config, action)
    });
  } catch (error) {
    actionError = error;
    if (isRecoverableClickBlockerError(error)) {
      recovery = await closeBlockingSurfaces(page, {
        timeoutMs: Math.min(350, config.crawler && config.crawler.maxActionMs || 1000)
      }).catch(recoveryError => ({
        attempted: true,
        closed: false,
        reason: recoveryError && recoveryError.message || String(recoveryError || 'blocker_recovery_failed')
      }));
      if (telemetry && typeof telemetry.event === 'function') {
        telemetry.event('agent.sdkTool.clickBlockerRecovery', {
          actionId: action.id || null,
          reason,
          recovery
        });
      }
      try {
        await executeSafeAction(page, action, config.crawler && config.crawler.maxActionMs || 1000, {
          config,
          allowBusinessMutation: agentAllowsBusinessMutation(config, action)
        });
        recoveredRetry = true;
        actionError = null;
      } catch (retryFailure) {
        retryError = retryFailure;
        actionError = retryFailure;
      }
    }
  }
  clearPageModelCache(context);
  const observation = await observePage(page, { maxObservationMs: config.crawler && config.crawler.maxObservationMs || 800, config }).catch(() => ({ events: [] }));
  const after = await safeExtractPageModel(page, modelOptions(config, before && before.url), { config, context, logger, reason: 'agent_action_after_model' }).catch(error => {
    if (logger && typeof logger.debug === 'function') logger.debug('agent action after model failed', error.message);
    return before || { url: null, links: [], forms: [], actions: [] };
  });
  const transition = validateTransition({ before, after, events: observation.events || observation, action });
  const authStateBefore = inferAuthStateFromPageModel(before);
  const authStateAfter = inferAuthStateFromPageModel(after);
  const changed = Boolean(transition && (transition.changed || transition.changedState || !transition.noProgress));
  const coverage = mergeCoverage(context.coverage || {}, {
    endpoints: (observation.events || []).concat(observation.endpoints || []),
    routeUrl: before && before.url || null,
    afterPageModel: after,
    action,
    transition
  });
  context.coverage = coverage;
  clearPageModelCache(context);
  if (telemetry && typeof telemetry.event === 'function') telemetry.event('agent.sdkTool.action', { actionId: action.id, reason, transition });
  return {
    ok: !actionError || changed,
    status: changed ? 'completed' : actionError ? 'no_progress' : transition && transition.noProgress ? 'no_progress' : 'completed',
    reason: actionError && !changed
      ? actionError.message
      : transition && transition.reason || actionError && actionError.message || null,
    browserActionRan: true,
    coverage,
    transition,
    authStateBefore,
    authStateAfter,
    authStatePreserved: compareAuthStates(authStateBefore, authStateAfter),
    actionError: actionError ? actionError.message : null,
    recovery,
    recoveredRetry,
    retryError: retryError ? retryError.message : null,
    result: {
      action: summarizeAction(action),
      before: summarizePageModel(before),
      after: summarizePageModel(after),
      actionError: actionError ? actionError.message : null,
      recovery,
      recoveredRetry
    }
  };
}

function isRecoverableClickBlockerError(error) {
  const text = String(error && error.message || error || '');
  return /intercepts pointer events|element.*not.*receiv|not receiving pointer|backdrop|overlay|modal|drawer|Timeout .*click|click .*timed out|locator\.click: Timeout|page\.click: Timeout/i.test(text);
}

async function latestPageModel({ page, config, context, forceFresh = false } = {}) {
  if (!forceFresh && context.currentPageModel) return context.currentPageModel;
  if (!forceFresh && context.latestPageModel) return context.latestPageModel;
  if (!forceFresh && context.coverage && Array.isArray(context.coverage.routes) && context.coverage.routes.length) {
    const last = context.coverage.routes[context.coverage.routes.length - 1];
    if (last && last.pageModel) return last.pageModel;
  }
  if (!page || typeof page.evaluate !== 'function') return null;
  const model = await safeExtractPageModel(page, modelOptions(config), {
    config,
    context,
    reason: 'agent_observe_page_model'
  });
  context.latestPageModel = model;
  return model;
}

async function safeExtractPageModel(page, options = {}, { config = {}, context = {}, logger = null, reason = 'page_model' } = {}) {
  const timeoutMs = pageModelTimeoutMs(config);
  try {
    return await withTimeout(extractPageModel(page, options), timeoutMs, 'page_model_extraction_timeout');
  } catch (error) {
    const message = error && error.message || String(error || 'page_model_failed');
    if (logger && typeof logger.debug === 'function') logger.debug(`${reason} failed`, message);
    if (context && typeof context === 'object') {
      context.agentObservationErrors = Array.isArray(context.agentObservationErrors) ? context.agentObservationErrors : [];
      context.agentObservationErrors.push({
        reason,
        error: message,
        timeoutMs,
        observedAt: new Date().toISOString()
      });
    }
    const url = safePageUrl(page);
    return {
      url,
      routeShape: url,
      stateKey: url || null,
      surfaceType: null,
      links: [],
      forms: [],
      actions: [],
      routeCandidates: [],
      authSignals: [],
      extractionError: message
    };
  }
}

function pageModelTimeoutMs(config = {}) {
  const explicit = Number(config.agent && config.agent.pageModelTimeoutMs);
  if (explicit > 0) return explicit;
  const observation = Number(config.crawler && config.crawler.maxObservationMs);
  if (observation > 0) return Math.max(1000, Math.min(5000, observation * 3));
  return 2500;
}

function withTimeout(promise, timeoutMs, reason) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${reason} after ${timeoutMs}ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function safePageUrl(page = null) {
  try {
    return page && typeof page.url === 'function' ? page.url() : null;
  } catch (_) {
    return null;
  }
}

function clearPageModelCache(context = {}) {
  if (!context || typeof context !== 'object') return;
  delete context.currentPageModel;
  delete context.latestPageModel;
}

function modelOptions(config = {}, baseUrl = null) {
  const probeConfig = config.agent && config.agent.useBrowserProbeInAgentObservation === true
    ? config.browserProbe
    : { ...(config.browserProbe || {}), enabled: false };
  const scopedConfig = { ...config, browserProbe: probeConfig };
  return {
    baseUrl,
    spaHashBaseUrl: config.target && config.target.baseUrl,
    preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
    config: scopedConfig,
    browserProbe: probeConfig
  };
}

function mergeCoverage(base = {}, update = {}) {
  const coverage = cloneCoverage(base);
  const routeUrl = update.routeUrl || update.afterPageModel && update.afterPageModel.url || null;
  for (const route of update.routes || []) addUnique(coverage.routes, route, item => item.url || item.href || item.path);
  for (const routeShape of update.routeShapes || []) addUnique(coverage.routeShapes, routeShape, item => typeof item === 'string' ? item : item.shape || item.routeShape || item.url);
  if (update.afterPageModel && update.afterPageModel.url) addUnique(coverage.routes, {
    url: update.afterPageModel.url,
    routeShape: update.afterPageModel.routeShape || null,
    source: 'agent-tool',
    surfaceType: update.afterPageModel.surfaceType || null
  }, item => item.url);
  for (const endpoint of update.endpoints || []) addUnique(coverage.endpoints, endpointRecord(endpoint, routeUrl), item => item.key || `${item.method || ''} ${item.path || item.url || ''}`);
  for (const form of update.afterPageModel && update.afterPageModel.forms || []) addUnique(coverage.forms, { ...form, routeUrl: update.afterPageModel.url }, item => `${item.routeUrl || ''}#${item.id || item.selector || item.kind || 'form'}`);
  for (const form of update.forms || []) addUnique(coverage.forms, { ...form, routeUrl: form.routeUrl || routeUrl }, item => `${item.routeUrl || ''}#${item.id || item.selector || item.kind || 'form'}`);
  for (const action of update.afterPageModel && update.afterPageModel.actions || []) addUnique(coverage.actions, { ...action, routeUrl: update.afterPageModel.url }, item => `${item.routeUrl || ''}#${item.id || item.selector || item.label || item.kind || 'action'}`);
  for (const action of update.actions || []) addUnique(coverage.actions, { ...action, routeUrl: action.routeUrl || routeUrl }, item => `${item.routeUrl || ''}#${item.id || item.selector || item.label || item.kind || 'action'}`);
  for (const transition of update.transitions || []) addUnique(coverage.transitions, transition, item => [item.routeUrl || '', item.observedAt || '', item.source || '', item.transition && item.transition.reason || ''].join('#'));
  for (const error of update.errors || []) addUnique(coverage.errors, error, item => [item.routeUrl || item.url || '', item.message || item.reason || JSON.stringify(item)].join('#'));
  if (update.action) addUnique(coverage.actions, { ...update.action, routeUrl, transition: update.transition || null }, item => `${item.routeUrl || ''}#${item.id || item.selector || item.label || item.kind || 'action'}`);
  if (update.transition) coverage.transitions.push({ routeUrl, transition: update.transition, source: 'agent-tool', observedAt: new Date().toISOString() });
  coverage.summary = summarizeCoverage(coverage);
  return coverage;
}

function cloneCoverage(base = {}) {
  return {
    ...base,
    routes: Array.isArray(base.routes) ? base.routes.slice() : [],
    routeShapes: Array.isArray(base.routeShapes) ? base.routeShapes.slice() : [],
    endpoints: Array.isArray(base.endpoints) ? base.endpoints.slice() : [],
    forms: Array.isArray(base.forms) ? base.forms.slice() : [],
    actions: Array.isArray(base.actions) ? base.actions.slice() : [],
    transitions: Array.isArray(base.transitions) ? base.transitions.slice() : [],
    errors: Array.isArray(base.errors) ? base.errors.slice() : []
  };
}

function addUnique(list, item, keyFn) {
  const key = keyFn(item);
  if (!key) return;
  if (!list.some(existing => keyFn(existing) === key)) list.push(item);
}

function endpointRecord(endpoint = {}, routeUrl = null) {
  const method = String(endpoint.method || (endpoint.type === 'response' ? 'RESPONSE' : 'GET')).toUpperCase();
  const path = endpoint.path || endpoint.url || endpoint.href || '';
  return {
    key: endpoint.key || `${method} ${path}`,
    method,
    url: endpoint.url || null,
    path,
    status: endpoint.status || null,
    resourceType: endpoint.resourceType || endpoint.type || 'unknown',
    source: endpoint.source || endpoint.sourceTag || endpoint.type || 'agent-tool',
    routeUrl
  };
}

function summarizeCoverage(coverage = {}) {
  return {
    routes: Array.isArray(coverage.routes) ? coverage.routes.length : 0,
    routeShapes: Array.isArray(coverage.routeShapes) ? coverage.routeShapes.length : 0,
    endpoints: Array.isArray(coverage.endpoints) ? coverage.endpoints.length : 0,
    forms: Array.isArray(coverage.forms) ? coverage.forms.length : 0,
    actions: Array.isArray(coverage.actions) ? coverage.actions.length : 0
  };
}

function summarizePageModel(model = null) {
  if (!model) return null;
  return {
    url: model.url || null,
    routeShape: model.routeShape || null,
    stateKey: model.stateKey || null,
    surfaceType: model.surfaceType || null,
    links: (model.links || []).length,
    forms: (model.forms || []).length,
    actions: (model.actions || []).length,
    routeCandidates: (model.routeCandidates || []).length,
    authSignals: model.authSignals || [],
    extractionError: model.extractionError || null
  };
}

function inferAuthStateFromContext(context = {}) {
  return inferAuthStateFromPageModel(context && (context.latestPageModel || context.currentPageModel));
}

function inferAuthStateFromPageModel(model = null) {
  if (!model) return 'unknown';
  const signals = Array.isArray(model.authSignals) ? model.authSignals : [];
  const text = [
    model.url,
    model.routeShape,
    model.surfaceType,
    ...signals
  ].filter(Boolean).join(' ').toLowerCase();
  if (!text) return 'unknown';
  if (/\b(?:logout|log out|sign out|account|profile|basket|order|wallet|address|saved payment|change password|authenticated|session)\b/.test(text)) {
    return 'authenticated';
  }
  if (/\b(?:login|log in|signin|sign in|register|anonymous|guest|unauthenticated)\b/.test(text)) {
    return 'anonymous';
  }
  return 'unknown';
}

function compareAuthStates(before = 'unknown', after = 'unknown') {
  if (before === 'unknown' || after === 'unknown') return null;
  if (before === 'authenticated' && after !== 'authenticated') return false;
  return before === after || after === 'authenticated';
}

function summarizeAction(action = {}) {
  return {
    id: action.id || null,
    kind: action.kind || null,
    label: action.label || action.text || action.name || null,
    href: action.href || null,
    expectedEffect: action.expectedEffect || action.expectedEffectGuess || null,
    semanticKind: action.semanticKind || null,
    riskTier: action.riskTier || null
  };
}

function summarizeForm(form = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return {
    id: form.id || null,
    kind: form.kind || null,
    method: form.method || null,
    action: form.action || null,
    fieldCount: fields.length,
    requiredCount: fields.filter(field => field && field.required).length,
    fieldNames: fields.map(field => field && (field.name || field.id || field.autocomplete || field.type)).filter(Boolean).slice(0, 12),
    fieldTypes: fields.map(field => field && field.type).filter(Boolean).slice(0, 12),
    validation: form.validation || null
  };
}

function actionPolicyTier(action = {}) {
  if (isDestructiveActionLike(action)) return 'destructive';
  const risk = String(action.riskTier || '').toLowerCase();
  if (/terminal|destructive/.test(risk)) return 'destructive';
  if (/business|mutation/.test(risk)) return 'business';
  if (/safe/.test(risk)) return 'safe';
  if (isSafeAgentHandleAction(action)) return 'safe';
  return 'safe';
}

function normalizeHandleActionForExecution(action = {}, handle = {}) {
  const tier = handle.policyTier || actionPolicyTier(action);
  if (tier === 'safe' && isSafeAgentHandleAction(action, handle)) {
    return {
      ...action,
      riskTier: RISK_TIERS.SAFE,
      safe: true
    };
  }
  if (tier === 'business') {
    return {
      ...action,
      riskTier: RISK_TIERS.BUSINESS_MUTATION,
      safe: false
    };
  }
  if (tier === 'destructive') {
    return {
      ...action,
      riskTier: RISK_TIERS.TERMINAL_DESTRUCTIVE,
      safe: false
    };
  }
  return action;
}

function isSafeAgentHandleAction(action = {}, handle = {}) {
  if (isDestructiveActionLike(action, handle)) return false;
  const summary = handle.summary || {};
  const text = [
    action.kind,
    action.href,
    action.routeTarget,
    action.expectedEffect,
    action.expectedEffectGuess,
    action.semanticKind,
    action.label,
    summary.kind,
    summary.href,
    summary.expectedEffect,
    summary.semanticKind,
    summary.label
  ].filter(Boolean).join(' ').toLowerCase();
  if (action.href || action.routeTarget) return true;
  if (/(?:^|[ _-])(click-link|open-menu|open-tab|open-accordion|open-modal|paginate|spa-navigate|type-search)(?:$|[ _-])/.test(String(action.kind || ''))) {
    return true;
  }
  if (/route-change|surface-expansion|surface-change|toggle-surface|modal-open|search-results|pagination/.test(text)) {
    return true;
  }
  return /\b(navigate|route|link|menu|drawer|tab|modal|account|profile|order|history|wallet|payment|address|setting|search|filter|next)\b/.test(text);
}

function isDestructiveActionLike(action = {}, handle = {}) {
  const summary = handle.summary || {};
  const text = [
    action.kind,
    action.href,
    action.routeTarget,
    action.expectedEffect,
    action.expectedEffectGuess,
    action.semanticKind,
    action.label,
    action.text,
    action.name,
    action.id,
    summary.kind,
    summary.href,
    summary.expectedEffect,
    summary.semanticKind,
    summary.label,
    summary.id
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(?:logout|log out|sign out|signout|delete|destroy|password reset|remove account|close account|checkout|purchase|buy now|place order|transfer|pay)\b/.test(text);
}

function agentAllowsBusinessMutation(config = {}, action = {}) {
  const agent = config.agent || {};
  if (actionPolicyTier(action) !== 'business') return false;
  return Boolean(agent.allowBusinessMutations || agent.allowDestructiveActions || agent.riskMode === 'business' || agent.riskMode === 'destructive');
}

function formPolicyTier(form = {}, routeKey = '') {
  const kind = String(form.kind || '').toLowerCase();
  const text = [
    routeKey,
    form.id,
    form.kind,
    form.action,
    ...(Array.isArray(form.fields) ? form.fields.map(field => [field.name, field.id, field.label, field.placeholder, field.autocomplete].filter(Boolean).join(' ')) : [])
  ].filter(Boolean).join(' ').toLowerCase();
  if (/delete|password-reset|destructive/.test(kind)) return 'destructive';
  if (/(?:^|[\/#?&_\-\s])(register|registration|sign[ -]?up|signup|create[ -]?account|new[ -]?account)(?:$|[\/#?&_\-\s])/.test(text)) return 'business';
  if (['search', 'login', 'auth'].includes(kind)) return 'safe';
  return 'business';
}

async function validateHandleStillOnPage({ handle = null, page = null } = {}) {
  if (!handle || !handle.routeKey || !page || typeof page.url !== 'function') return { ok: true };
  let currentUrl = null;
  try {
    currentUrl = page.url();
  } catch (_) {
    return { ok: true };
  }
  if (!currentUrl) return { ok: true };
  const expected = comparableHandleRoute(handle.routeKey);
  const current = comparableHandleRoute(currentUrl);
  if (!expected || !current || expected === current) return { ok: true };
  return { ok: false, reason: 'stale_handle_route_changed' };
}

function comparableHandleRoute(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, 'http://ptk.local');
    const hash = url.hash && /^#!?\//.test(url.hash) ? url.hash : '';
    return `${url.origin === 'http://ptk.local' ? '' : url.origin}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}${hash}`;
  } catch (_) {
    return raw.replace(/\/+$/, '') || '/';
  }
}

async function fillFormFieldsOnly(page, form = {}, profile = {}, config = {}, explicitValues = {}) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('form_adapter_requires_live_page');
  const fields = (form.fields || []).map(field => ({
    key: field.name || field.id || field.selector || field.label,
    selector: field.selector || null,
    name: field.name || null,
    id: field.id || null,
    type: field.type || null,
    value: explicitValueForField(field, explicitValues, profile)
  })).filter(field => field.key && field.value !== undefined && field.value !== null);
  if (!fields.length) return { ok: false, reason: 'no_fillable_fields', filled: 0, planned: 0 };
  const timeoutMs = Math.max(250, Math.min(2000, Number(config.crawler && config.crawler.maxActionMs) || 1000));
  if (typeof page.locator === 'function') {
    let filled = 0;
    for (const field of fields) {
      const selector = field.selector || selectorForField(field);
      if (!selector) continue;
      const type = String(field.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      const locator = page.locator(selector).first();
      const ok = await fillLocatorValue(locator, field.value, type, timeoutMs).catch(() => false);
      if (ok) filled += 1;
    }
    if (filled > 0) return { ok: true, reason: 'locator_fill', filled, planned: fields.length };
  }
  return page.evaluate(({ formId, selector, fields: plannedFields }) => {
    const forms = Array.from(document.querySelectorAll('form'));
    const root = selector
      ? document.querySelector(selector)
      : forms.find(candidate => candidate.id === formId || candidate.name === formId) || document;
    const findField = field => {
      if (field.selector) {
        const bySelector = root && root.querySelector
          ? root.querySelector(field.selector)
          : document.querySelector(field.selector);
        if (bySelector) return bySelector;
      }
      if (field.id) {
        const byId = document.getElementById(String(field.id));
        if (byId && (!root || root === document || root.contains(byId))) return byId;
      }
      if (field.name) {
        const byName = Array.from(document.getElementsByName(String(field.name)))
          .find(element => !root || root === document || root.contains(element));
        if (byName) return byName;
      }
      return null;
    };
    const setValue = (element, value) => {
      if (!element) return false;
      const tag = String(element.tagName || '').toLowerCase();
      const type = String(element.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;
      if (type === 'checkbox') element.checked = Boolean(value);
      else if (type === 'radio') element.checked = true;
      else if (tag === 'select') {
        const option = Array.from(element.options || []).find(candidate => candidate.value === String(value) || candidate.text === String(value));
        element.value = option ? option.value : String(value);
      } else {
        element.value = String(value);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    let filled = 0;
    for (const field of plannedFields || []) {
      if (setValue(findField(field), field.value)) filled += 1;
    }
    return { ok: filled > 0, reason: filled > 0 ? 'dom_fill' : 'no_fields_filled', filled, planned: (plannedFields || []).length };
  }, {
    formId: form.id || null,
    selector: form.selector || null,
    fields
  });
}

async function fillLocatorValue(locator, value, type, timeoutMs) {
  if (!locator) return false;
  if (type === 'checkbox') {
    if (value && typeof locator.check === 'function') await locator.check({ timeout: timeoutMs });
    else if (!value && typeof locator.uncheck === 'function') await locator.uncheck({ timeout: timeoutMs });
    else return false;
    return true;
  }
  if (type === 'radio') {
    if (typeof locator.check === 'function') {
      await locator.check({ timeout: timeoutMs });
      return true;
    }
    return false;
  }
  if (type === 'select' && typeof locator.selectOption === 'function') {
    await locator.selectOption(String(value), { timeout: timeoutMs });
    return true;
  }
  if (typeof locator.fill === 'function') {
    await locator.fill(String(value), { timeout: timeoutMs });
    return true;
  }
  return false;
}

function selectorForField(field = {}) {
  if (field.selector) return field.selector;
  if (field.id) return cssIdSelector(field.id);
  if (field.name) return cssAttributeSelector('name', field.name);
  return null;
}

function profileFromResolvedValues(values = {}, base = {}) {
  const profile = { ...(base || {}) };
  profile.values = { ...((base && base.values) || {}) };
  for (const [key, value] of Object.entries(values || {})) {
    const actual = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
      ? value.value
      : value;
    if (actual === undefined || actual === null) continue;
    if (typeof actual === 'string' || typeof actual === 'number' || typeof actual === 'boolean') {
      profile[key] = actual;
      profile.values[key] = actual;
    }
  }
  return profile;
}

function explicitValueForField(field = {}, explicitValues = {}, profile = {}) {
  const explicit = findExplicitFieldValue(field, explicitValues);
  if (explicit.found) return explicit.value;
  return valueForField(field, profile);
}

function findExplicitFieldValue(field = {}, explicitValues = {}) {
  if (!explicitValues || typeof explicitValues !== 'object') return { found: false, value: undefined };
  for (const key of explicitFieldValueKeys(field)) {
    if (!Object.prototype.hasOwnProperty.call(explicitValues, key)) continue;
    const value = explicitValues[key];
    return {
      found: true,
      value: value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
        ? value.value
        : value
    };
  }
  const lowerKeys = Object.keys(explicitValues).reduce((acc, key) => {
    acc[String(key).toLowerCase()] = key;
    return acc;
  }, {});
  for (const key of explicitFieldValueKeys(field).map(item => String(item).toLowerCase())) {
    const actualKey = lowerKeys[key];
    if (!actualKey) continue;
    const value = explicitValues[actualKey];
    return {
      found: true,
      value: value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
        ? value.value
        : value
    };
  }
  return { found: false, value: undefined };
}

function explicitFieldValueKeys(field = {}) {
  const text = [
    field.name,
    field.id,
    field.label,
    field.placeholder,
    field.autocomplete,
    field.type,
    field.selector
  ].filter(Boolean).map(String);
  const keys = [...text];
  const joined = text.join(' ').toLowerCase();
  if (/\be-?mail\b/.test(joined) || String(field.type || '').toLowerCase() === 'email') keys.push('email', 'username', 'login');
  if (/password|passwd|pwd/.test(joined) || String(field.type || '').toLowerCase() === 'password') keys.push('password');
  if (/message|comment|feedback|description|body|text/.test(joined)) keys.push('message', 'comment', 'feedback', 'description', 'text');
  if (/search|query|\bq\b/.test(joined) || String(field.type || '').toLowerCase() === 'search') keys.push('search', 'query', 'q');
  if (/subject|title/.test(joined)) keys.push('subject', 'title');
  if (/name/.test(joined)) keys.push('name');
  return Array.from(new Set(keys.map(key => String(key).trim()).filter(Boolean)));
}

function hasValidation(value = {}) {
  return Boolean(value && Object.keys(value).length);
}

function notExecutable(reason) {
  return {
    ok: false,
    status: 'not_executable',
    reason,
    browserActionRan: false,
    coverage: null,
    transition: { changed: false, noProgress: true, reason }
  };
}

module.exports = {
  createSdkToolAdapter,
  issuePageModelHandles,
  mergeCoverage
};
