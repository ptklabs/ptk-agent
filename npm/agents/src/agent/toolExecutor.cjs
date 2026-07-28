'use strict';

const { coverageCounts, coverageDelta, hasMeaningfulCoverageDelta, recordActionEffect } = require('./actionEffectRecorder.cjs');
const { redactSecrets } = require('../core/config.cjs');
const { createSdkToolAdapter, mergeCoverage } = require('./sdkToolAdapter.cjs');

const PAGE_IDS = new WeakMap();
const CONTEXT_IDS = new WeakMap();
let nextLiveObjectId = 1;

function createAgentToolExecutor({
  config = {},
  session = null,
  context = {},
  handles = null,
  telemetry = null,
  executeRoute = null,
  profileResolver = null
} = {}) {
  const livePage = session && session.page || context.page || null;
  const sdkAdapter = createSdkToolAdapter({
    page: livePage,
    config,
    context,
    telemetry
  });

  async function executeStep({ mission = {}, plan = {}, step = {}, turn = 0 } = {}) {
    const beforeCoverage = snapshotCoverage(context.coverage);
    const startedAt = new Date().toISOString();
    const beforeState = summarizeExecutionState({ coverage: beforeCoverage, page: livePage });
    const liveProofBefore = captureLiveSessionProof({ page: livePage, context });
    const policy = policyDecision(step, { config, handles, turn });
    if (!policy.allowed) {
      return buildExecutionResult({
        mission,
        plan,
        step,
        startedAt,
        beforeState,
        beforeCoverage,
        afterCoverage: beforeCoverage,
        status: 'blocked',
        reason: policy.reason,
        policy,
        browserActionRan: false,
        liveContext: buildLiveContextProof({ step, livePage, browserActionRan: false, before: liveProofBefore, after: liveProofBefore })
      });
    }
    if (requiresLiveSession(step) && !livePage) {
      return buildExecutionResult({
        mission,
        plan,
        step,
        startedAt,
        beforeState,
        beforeCoverage,
        afterCoverage: beforeCoverage,
        status: 'recover_auth_required',
        reason: 'same_session_page_missing',
        policy,
        browserActionRan: false,
        liveContext: buildLiveContextProof({ step, livePage, browserActionRan: false, before: liveProofBefore, after: liveProofBefore })
      });
    }

    const targetHandle = validateStepHandle(step, handles, turn);
    if (!targetHandle.ok) {
      return buildExecutionResult({
        mission,
        plan,
        step,
        startedAt,
        beforeState,
        beforeCoverage,
        afterCoverage: beforeCoverage,
        status: 'blocked',
        reason: targetHandle.reason,
        policy,
        browserActionRan: false,
        liveContext: buildLiveContextProof({ step, livePage, browserActionRan: false, before: liveProofBefore, after: liveProofBefore })
      });
    }

    let toolResult;
    let browserActionRan = false;
    try {
      toolResult = await dispatchStep(step, {
        mission,
        livePage,
        handles,
        context,
        executeRoute,
        profileResolver,
        sdkAdapter,
        turn
      });
      browserActionRan = Boolean(toolResult.browserActionRan);
    } catch (error) {
      const classified = classifyToolException(error);
      toolResult = {
        ok: false,
        status: classified.status,
        reason: classified.reason,
        error: error && error.message || String(error || 'tool_failed'),
        coverage: context.coverage || beforeCoverage,
        transition: { changed: false, noProgress: true, reason: classified.transitionReason }
      };
    }

    const rawAfterCoverage = toolResult.coverage || context.coverage || beforeCoverage;
    const afterCoverage = snapshotCoverage(mergeCoverage(beforeCoverage, rawAfterCoverage));
    const liveProofAfter = captureLiveSessionProof({ page: livePage, context });
    const result = buildExecutionResult({
      mission,
      plan,
      step,
      startedAt,
      beforeState,
      beforeCoverage,
      afterCoverage,
      status: toolResult.status || (toolResult.ok === false ? 'failed' : 'completed'),
      reason: toolResult.reason || null,
      policy,
      browserActionRan,
      transition: toolResult.transition || null,
      toolResult,
      liveContext: buildLiveContextProof({ step, livePage, browserActionRan, toolResult, before: liveProofBefore, after: liveProofAfter })
    });
    if (isMutatingStep(step) && handles && typeof handles.invalidateMutatingStep === 'function') {
      handles.invalidateMutatingStep();
      result.handlesInvalidated = true;
    }
    if (telemetry && typeof telemetry.event === 'function') {
      telemetry.event('agent.tool.transaction', {
        missionId: mission.id,
        stepType: step.type,
        status: result.status,
        actualDelta: result.actualDelta,
        transitionValidated: result.transitionValidated,
        browserActionRan
      });
    }
    context.coverage = afterCoverage;
    return result;
  }

  function observeCrawlerState() {
    return sdkAdapter.observe({ handles, turn: handles && handles.turn || 0 });
  }

  return {
    executeStep,
    observeCrawlerState,
    listReachableSurfaces: () => listHandles(handles, 'surface'),
    listFormsWithValidation: () => listHandles(handles, 'form'),
    getPtkLifecycleStatus: () => context.coverage && context.coverage.ptk && context.coverage.ptk.lifecycle || null
  };
}

function classifyToolException(error) {
  const message = error && error.message ? error.message : String(error || '');
  if (/target.*closed|browser.*closed|context.*closed|page.*closed|same_session_page_missing/i.test(message)) {
    return {
      status: 'recover_auth_required',
      reason: 'same_session_lost_or_closed',
      transitionReason: 'session_lost'
    };
  }
  if (/timed out|timeout|exceeded .*budget/i.test(message)) {
    return {
      status: 'no_progress',
      reason: 'tool_timeout',
      transitionReason: 'tool_timeout'
    };
  }
  return {
    status: 'failed',
    reason: message || 'tool_failed',
    transitionReason: 'tool_exception'
  };
}

async function dispatchStep(step, env) {
  switch (step.type) {
    case 'visit_route':
      return visitRoute(step, env);
    case 'open_surface':
      return executeSurfaceHandle(step, env);
    case 'click_control':
      return executeControlHandle(step, env);
    case 'fill_form':
      return fillForm(step, env);
    case 'submit_form':
      return executeFormHandle(step, env, { submit: true });
    case 'recover_auth_state':
      return env.sdkAdapter.recoverAuthState();
    case 'record_no_progress':
      return {
        ok: false,
        status: 'no_progress',
        reason: step.reason || 'provider_recorded_no_progress',
        browserActionRan: false,
        coverage: env.context.coverage || {},
        transition: { changed: false, noProgress: true, reason: 'record_no_progress' }
      };
    case 'get_ptk_lifecycle_status':
      return {
        ok: true,
        status: 'completed',
        browserActionRan: false,
        coverage: env.context.coverage || {},
        transition: { changed: false, noProgress: false, reason: 'ptk_lifecycle_observed' },
        ptk: env.context.coverage && env.context.coverage.ptk || null
      };
    default:
      return {
        ok: false,
        status: 'failed',
        reason: 'unsupported_tool_step',
        browserActionRan: false,
        coverage: env.context.coverage || {},
        transition: { changed: false, noProgress: true, reason: 'unsupported_tool_step' }
      };
  }
}

async function visitRoute(step, env) {
  const target = step.target || {};
  const routeKey = target.routeKey || routeKeyFromHandle(target.routeHandleId || target.routeId, env.handles);
  if (!routeKey) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'route_handle_missing',
      browserActionRan: false,
      coverage: env.context.coverage || {},
      transition: { changed: false, noProgress: true, reason: 'route_handle_missing' }
    };
  }
  const result = await env.sdkAdapter.visitRoute({
    routeKey,
    executeRoute: env.executeRoute,
    mission: env.mission,
    step
  });
  return {
    ok: result && result.ok !== false,
    status: result && result.status || 'completed',
    reason: result && result.reason || null,
    browserActionRan: Boolean(result && result.browserActionRan !== false),
    coverage: result && result.coverage || env.context.coverage || {},
    transition: result && result.transition || { changed: true, noProgress: false, reason: 'route_visit_executed' },
    authStateBefore: result && result.authStateBefore || null,
    authStateAfter: result && result.authStateAfter || null,
    authStatePreserved: booleanOrNull(result && result.authStatePreserved),
    result
  };
}

async function executeControlHandle(step, env) {
  const target = step.target || {};
  const handle = env.handles && env.handles.get(target.controlId);
  const result = await env.sdkAdapter.executeControlHandle({ handle, step });
  return {
    ok: result && result.ok !== false,
    status: result && result.status || 'completed',
    reason: result && result.reason || null,
    browserActionRan: Boolean(result && result.browserActionRan !== false),
    coverage: result && result.coverage || env.context.coverage || {},
    transition: result && result.transition || { changed: true, noProgress: false, reason: 'click_control_executed' },
    authStateBefore: result && result.authStateBefore || null,
    authStateAfter: result && result.authStateAfter || null,
    authStatePreserved: booleanOrNull(result && result.authStatePreserved),
    result
  };
}

async function executeSurfaceHandle(step, env) {
  const target = step.target || {};
  const handle = env.handles && env.handles.get(target.surfaceId);
  const result = await env.sdkAdapter.executeSurfaceHandle({ handle, step });
  return {
    ok: result && result.ok !== false,
    status: result && result.status || 'completed',
    reason: result && result.reason || null,
    browserActionRan: Boolean(result && result.browserActionRan !== false),
    coverage: result && result.coverage || env.context.coverage || {},
    transition: result && result.transition || { changed: true, noProgress: false, reason: 'open_surface_executed' },
    authStateBefore: result && result.authStateBefore || null,
    authStateAfter: result && result.authStateAfter || null,
    authStatePreserved: booleanOrNull(result && result.authStatePreserved),
    result
  };
}

async function fillForm(step, env) {
  return executeFormHandle(step, env, { submit: false });
}

async function executeFormHandle(step, env, { submit = false } = {}) {
  const target = step.target || {};
  const values = resolveProfileRefs(
    target.values || step.values || {},
    env.profileResolver || env.context.profileResolver,
    env.context && env.context.profile || {}
  );
  const handle = env.handles && env.handles.get(target.formId);
  const result = await env.sdkAdapter.executeFormHandle({ handle, values, submit, step });
  return {
    ok: result && result.ok !== false,
    status: result && result.status || 'completed',
    reason: result && result.reason || null,
    browserActionRan: Boolean(result && result.browserActionRan),
    coverage: result && result.coverage || env.context.coverage || {},
    transition: result && result.transition || { changed: true, noProgress: false, reason: 'fill_form_executed' },
    authStateBefore: result && result.authStateBefore || null,
    authStateAfter: result && result.authStateAfter || null,
    authStatePreserved: booleanOrNull(result && result.authStatePreserved),
    valuesResolvedLocally: Object.keys(values).length,
    result
  };
}

function buildExecutionResult({
  mission,
  plan,
  step,
  startedAt,
  beforeState,
  beforeCoverage,
  afterCoverage,
  status,
  reason,
  policy,
  browserActionRan,
  transition = null,
  toolResult = null,
  liveContext = null
}) {
  const endedAt = new Date().toISOString();
  const effect = recordActionEffect({
    mission,
    action: { type: step.type, target: safeTargetSummary(step.target || {}) },
    beforeCoverage,
    afterCoverage,
    transition,
    startedAt,
    endedAt
  });
  const actualDelta = effect.delta;
  const meaningfulDelta = hasMeaningfulCoverageDelta(actualDelta);
  const toolSucceeded = !toolResult || toolResult.ok !== false;
  const transitionValidated = Boolean(browserActionRan && (meaningfulDelta || toolSucceeded && transition && (transition.changed || transition.changedState)));
  const normalizedStatus = normalizeStatus({ status, browserActionRan, transitionValidated, meaningfulDelta, toolSucceeded, transition });
  const payload = {
    schemaVersion: 'ptk-agent-v2-execution-result',
    missionId: mission.id || null,
    planReason: plan.reason || null,
    stepType: step.type || null,
    status: normalizedStatus,
    reason: reason || normalizedStatus,
    beforeState,
    afterState: summarizeExecutionState({ coverage: afterCoverage }),
    policy,
    liveContext,
    authStatePreserved: liveContext && liveContext.authStatePreserved,
    browserActionRan,
    transitionValidated,
    expectedDelta: plan.expectedDelta || null,
    actualDelta,
    deltaMatchedExpectation: deltaMatches(plan.expectedDelta, actualDelta),
    effect,
    toolResult: summarizeToolResult(toolResult),
    startedAt,
    endedAt
  };
  const redacted = redactSecrets(payload);
  if (redacted.liveContext && payload.liveContext && typeof payload.liveContext.sessionLost === 'boolean') {
    redacted.liveContext.sessionLost = payload.liveContext.sessionLost;
  }
  return redacted;
}

function buildLiveContextProof({ step = {}, livePage = null, browserActionRan = false, toolResult = null, before = null, after = null } = {}) {
  const required = requiresLiveSession(step);
  const beforeProof = before || captureLiveSessionProof({ page: livePage });
  const afterProof = after || beforeProof;
  const samePage = Boolean(beforeProof.pageId && afterProof.pageId && beforeProof.pageId === afterProof.pageId);
  const sameBrowserContext = Boolean(
    beforeProof.contextId && afterProof.contextId
      ? beforeProof.contextId === afterProof.contextId
      : samePage && livePage
  );
  const authStateBefore = toolResult && toolResult.authStateBefore || beforeProof.authState || 'unknown';
  const authStateAfter = toolResult && toolResult.authStateAfter || afterProof.authState || 'unknown';
  const authStatePreserved = inferAuthStatePreserved({ toolResult, before: authStateBefore, after: authStateAfter });
  return {
    invariant: 'same-live-page-context',
    required,
    livePageAvailable: Boolean(livePage),
    usedExistingPage: Boolean(required && livePage && browserActionRan),
    createdNewContext: false,
    sameBrowserContext,
    samePage,
    pageIdBefore: beforeProof.pageId || null,
    pageIdAfter: afterProof.pageId || null,
    browserContextIdBefore: beforeProof.contextId || null,
    browserContextIdAfter: afterProof.contextId || null,
    pageUrlBefore: beforeProof.url || null,
    pageUrlAfter: afterProof.url || null,
    authStateBefore,
    authStateAfter,
    authStatePreserved,
    sessionLost: Boolean(required && (samePage === false || sameBrowserContext === false || authStatePreserved === false))
  };
}

function captureLiveSessionProof({ page = null, context = {} } = {}) {
  const pageId = objectIdentity(page, PAGE_IDS, 'page');
  const browserContext = safeCall(() => page && typeof page.context === 'function' ? page.context() : null);
  const contextId = objectIdentity(browserContext, CONTEXT_IDS, 'context') || (pageId ? `${pageId}:context-unknown` : null);
  const url = page && typeof page.url === 'function' ? safeCall(() => page.url()) : null;
  const model = context && (context.currentPageModel || context.latestPageModel) || null;
  return {
    pageId,
    contextId,
    url,
    authState: inferAuthState({ pageModel: model, url })
  };
}

function objectIdentity(value, map, prefix) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (!map.has(value)) {
    map.set(value, `${prefix}_${nextLiveObjectId++}`);
  }
  return map.get(value);
}

function inferAuthStatePreserved({ toolResult = null, before = 'unknown', after = 'unknown' } = {}) {
  if (toolResult && typeof toolResult.authStatePreserved === 'boolean') return toolResult.authStatePreserved;
  if (before === 'unknown' || after === 'unknown') return null;
  if (before === 'authenticated' && after !== 'authenticated') return false;
  if (before !== 'authenticated' && after === 'authenticated') return true;
  return before === after;
}

function inferAuthState({ pageModel = null, url = null } = {}) {
  const signals = Array.isArray(pageModel && pageModel.authSignals) ? pageModel.authSignals : [];
  const text = signals.concat(url ? [url] : []).filter(Boolean).join(' ').toLowerCase();
  if (!text) return 'unknown';
  if (/\b(?:logout|log out|sign out|account|profile|basket|order|wallet|address|saved payment|change password|authenticated|session)\b/.test(text)) return 'authenticated';
  if (/\b(?:login|log in|signin|sign in|register|anonymous|guest|unauthenticated)\b/.test(text)) return 'anonymous';
  return 'unknown';
}

function normalizeStatus({ status, browserActionRan, transitionValidated, meaningfulDelta, toolSucceeded, transition }) {
  if (status === 'blocked' || status === 'recover_auth_required' || status === 'not_executable') return status;
  if (!browserActionRan) return status === 'completed' ? 'not_executable' : status || 'failed';
  if (meaningfulDelta) return 'completed';
  if (toolSucceeded === false) return status === 'failed' ? 'failed' : 'no_progress';
  if (status === 'no_progress' || transition && transition.noProgress) return 'no_progress';
  return status === 'failed' ? 'failed' : 'no_progress';
}

function policyDecision(step, { config = {}, handles = null, turn = 0 } = {}) {
  const tier = tierForStep(step, handles);
  const agent = config.agent || {};
  if (tier === 'destructive' && agent.allowDestructiveActions !== true) {
    return { allowed: false, tier, reason: 'destructive_action_denied' };
  }
  if (tier === 'business' && !(agent.allowBusinessMutations || agent.allowDestructiveActions || agent.riskMode === 'business' || agent.riskMode === 'destructive')) {
    return { allowed: false, tier, reason: 'business_action_denied' };
  }
  return { allowed: true, tier, reason: 'policy_allowed', turn };
}

function validateStepHandle(step = {}, handles = null, turn = 0) {
  const target = step.target || {};
  const refs = [
    { id: target.controlId, type: 'control' },
    { id: target.formId, type: 'form' },
    { id: target.surfaceId, type: 'surface' },
    { id: target.routeHandleId || target.routeId, type: 'route' }
  ].filter(ref => ref.id);
  if (!refs.length) return { ok: true, reason: 'no_handle_required' };
  if (!handles || typeof handles.validate !== 'function') return { ok: false, reason: 'handle_registry_missing' };
  for (const ref of refs) {
    const result = handles.validate(ref.id, { type: ref.type, turn });
    if (!result.ok) return { ok: false, reason: result.reason || 'invalid_handle', handle: result.handle || null };
  }
  return { ok: true, reason: 'fresh_handle' };
}

function tierForStep(step = {}, handles = null) {
  const target = step.target || {};
  const id = target.controlId || target.formId || target.surfaceId || target.routeHandleId || target.routeId || null;
  const handle = id && handles && typeof handles.get === 'function' ? handles.get(id) : null;
  return effectiveHandlePolicyTier(handle);
}

function effectiveHandlePolicyTier(handle = null) {
  if (!handle) return 'safe';
  const text = JSON.stringify({
    policyTier: handle.policyTier,
    summary: handle.summary,
    target: handle.target
  }).toLowerCase();
  if (/\b(?:logout|log out|sign out|signout|delete|destroy|password reset|remove account|close account|checkout|purchase|buy now|place order|transfer|pay)\b/.test(text)) {
    return 'destructive';
  }
  return handle.policyTier || 'safe';
}

function requiresLiveSession(step = {}) {
  return ['open_surface', 'click_control', 'fill_form', 'submit_form', 'visit_route', 'recover_auth_state'].includes(step.type);
}

function isMutatingStep(step = {}) {
  return ['open_surface', 'click_control', 'fill_form', 'submit_form', 'visit_route', 'recover_auth_state'].includes(step.type);
}

function routeKeyFromHandle(id, handles) {
  const handle = id && handles && typeof handles.get === 'function' ? handles.get(id) : null;
  return handle && handle.routeKey || null;
}

function snapshotCoverage(coverage = {}) {
  return JSON.parse(JSON.stringify(coverage || {}));
}

function summarizeExecutionState({ coverage = {}, page = null } = {}) {
  return {
    coverage: coverageCounts(coverage),
    url: page && typeof page.url === 'function' ? safeCall(() => page.url()) : null
  };
}

function safeCall(fn) {
  try {
    return fn();
  } catch (_) {
    return null;
  }
}

function safeTargetSummary(target = {}) {
  return {
    controlId: target.controlId || null,
    formId: target.formId || null,
    surfaceId: target.surfaceId || null,
    routeHandleId: target.routeHandleId || target.routeId || null,
    routeKey: target.routeKey || null
  };
}

function deltaMatches(expected = {}, actual = {}) {
  if (!expected || !actual) return false;
  for (const [key, value] of Object.entries(expected)) {
    if ((Number(actual[key]) || 0) < (Number(value) || 0)) return false;
  }
  return true;
}

function summarizeToolResult(result = null) {
  if (!result) return null;
  return redactSecrets({
    ok: result.ok,
    status: result.status,
    reason: result.reason || null,
    recovery: result.recovery || result.result && result.result.recovery || null,
    recoveredRetry: Boolean(result.recoveredRetry || result.result && result.result.recoveredRetry),
    valuesResolvedLocally: result.valuesResolvedLocally || 0
  });
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function resolveProfileRefs(values = {}, resolver = null, profile = {}) {
  const output = {};
  for (const [field, ref] of Object.entries(values || {})) {
    output[field] = typeof resolver === 'function'
      ? resolver(ref)
      : resolveProfileRefLocally(ref, profile);
  }
  return output;
}

function resolveProfileRefLocally(ref, profile = {}) {
  if (typeof ref !== 'string' || !ref.startsWith('profile.')) {
    return { ref, resolvedLocally: false, reason: 'unsupported_profile_ref' };
  }
  const path = ref.slice('profile.'.length);
  const value = readProfilePath(profile, path);
  return {
    ref,
    value,
    resolvedLocally: true,
    missing: value === undefined || value === null,
    source: ref
  };
}

function readProfilePath(source = {}, path = '') {
  if (!path) return undefined;
  const parts = [];
  String(path).replace(/([^[.\]]+)|\[(\d+)\]/g, (_match, key, index) => {
    parts.push(key !== undefined ? key : Number(index));
    return '';
  });
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function listHandles(handles, type) {
  return handles && handles.all ? handles.all().filter(handle => handle.type === type).map(handle => redactSecrets({
    id: handle.id,
    type: handle.type,
    routeKey: handle.routeKey,
    stateKey: handle.stateKey,
    source: handle.source,
    policyTier: handle.policyTier,
    summary: handle.summary || null
  })) : [];
}

module.exports = {
  createAgentToolExecutor,
  isMutatingStep,
  requiresLiveSession
};
