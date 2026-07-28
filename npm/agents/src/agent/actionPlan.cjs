'use strict';

const { redactSecrets } = require('../core/config.cjs');

const STEP_TYPES = Object.freeze([
  'open_surface',
  'click_control',
  'fill_form',
  'submit_form',
  'visit_route',
  'recover_auth_state',
  'record_no_progress',
  'get_ptk_lifecycle_status'
]);

const RISK_MODES = Object.freeze(['safe', 'business', 'destructive']);
const REJECT_REASONS = Object.freeze([
  'invalid_json',
  'malformed_plan',
  'unknown_mission',
  'stale_handle',
  'raw_selector_denied',
  'policy_denied',
  'unsafe_risk_mode',
  'no_executable_steps'
]);

const RAW_SELECTOR_KEYS = /^(selector|css|xpath|locator|rawSelector|textSelector|nth)$/i;
const RAW_TARGET_KEYS = /^(url|href|target|rawTarget)$/i;
const SECRET_REF_RE = /(?:password|passwd|secret|token|cookie|authorization|auth[_-]?header|credential|session|cvv|card)/i;

function normalizeProviderPlan(input = {}, { mission = null, routeHandle = null } = {}) {
  const source = typeof input === 'string' ? safeParse(input) : input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, reason: 'invalid_json', plan: null, errors: ['plan must be an object'] };
  }
  const steps = Array.isArray(source.steps) ? source.steps.slice() : [];
  if (!steps.length && routeHandle) {
    steps.push({
      type: 'visit_route',
      target: {
        routeHandleId: routeHandle.id,
        routeKey: routeHandle.routeKey
      },
      success: { routeChanged: true }
    });
  }
  const plan = {
    missionId: mission && mission.id || source.missionId || source.mission_id || null,
    reason: typeof source.reason === 'string' ? source.reason.trim() : '',
    riskModeRequired: normalizeRiskMode(source.riskModeRequired || source.risk_mode_required || 'safe'),
    expectedDelta: normalizeDelta(source.expectedDelta || source.expected_delta),
    allowedCapability: source.allowedCapability || source.allowed_capability || source.capability || null,
    provider: source.provider || null,
    steps
  };
  return { ok: true, reason: 'normalized', plan, errors: [] };
}

function validateActionPlan(plan = {}, { missions = [], handles = null, turn = 0, agentConfig = {} } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return rejected('malformed_plan', ['plan must be an object'], plan);
  }
  if (!plan.missionId) errors.push('plan.missionId is required');
  if (!plan.reason) errors.push('plan.reason is required');
  if (!plan.expectedDelta) errors.push('plan.expectedDelta is required');
  if (!RISK_MODES.includes(plan.riskModeRequired)) errors.push('plan.riskModeRequired must be safe, business, or destructive');
  const mission = plan.missionId
    ? missions.find(candidate => candidate && candidate.id === plan.missionId)
    : null;
  if (plan.missionId && !mission) errors.push('plan.missionId does not match an available mission');
  if (containsRawSelector(plan)) {
    return rejected('raw_selector_denied', ['provider plan contains raw selector/locator/target fields'], plan, mission);
  }
  const riskDecision = evaluateRiskMode(plan.riskModeRequired, agentConfig);
  if (!riskDecision.allowed) {
    return rejected('unsafe_risk_mode', [riskDecision.reason], plan, mission);
  }
  const steps = coalesceFillSubmitSteps(Array.isArray(plan.steps) ? plan.steps : []);
  if (!steps.length) errors.push('plan.steps must contain at least one executable step');
  const maxSteps = Math.max(1, Number(agentConfig.maxStepsPerTurn) || 1);
  const selectedSteps = steps
    .slice(0, maxSteps)
    .map(step => normalizeStepHandleAliases(step, { handles, turn }))
    .map(normalizeFormValueReferences);
  for (const [index, step] of selectedSteps.entries()) {
    const stepErrors = validateStep(step, { handles, turn });
    for (const error of stepErrors) errors.push(`steps[${index}].${error}`);
    const policy = evaluateStepHandlePolicy(step, { handles, turn, agentConfig });
    if (!policy.allowed) {
      return rejected('policy_denied', [`steps[${index}].${policy.reason}`], { ...plan, steps: selectedSteps }, mission);
    }
  }
  if (errors.some(error => /stale_handle|unknown_handle/.test(error))) {
    return rejected('stale_handle', errors, { ...plan, steps: selectedSteps }, mission);
  }
  if (errors.length) return rejected(errors.some(error => /steps/.test(error)) ? 'no_executable_steps' : 'malformed_plan', errors, { ...plan, steps: selectedSteps }, mission);
  return {
    allowed: true,
    reason: 'plan_allowed',
    errors: [],
    plan: { ...plan, steps: selectedSteps },
    redactedPlan: redactPlanPreservingProfileRefs({ ...plan, steps: selectedSteps }),
    mission,
    rejectReason: null
  };
}

function validateStep(step = {}, { handles = null, turn = 0 } = {}) {
  const errors = [];
  if (!step || typeof step !== 'object' || Array.isArray(step)) return ['must be an object'];
  if (!STEP_TYPES.includes(step.type)) errors.push('type is unsupported');
  if (Array.isArray(step.valueValidationErrors)) {
    for (const error of step.valueValidationErrors) errors.push(error);
  }
  const target = step.target || {};
  if (step.type === 'open_surface') validateHandleField(target.surfaceId, 'surface', handles, turn, errors, 'target.surfaceId');
  if (step.type === 'click_control') validateHandleField(target.controlId, 'control', handles, turn, errors, 'target.controlId');
  if (step.type === 'fill_form' || step.type === 'submit_form') validateHandleField(target.formId, 'form', handles, turn, errors, 'target.formId');
  if (step.type === 'visit_route') {
    const routeHandleId = target.routeHandleId || target.routeId || null;
    if (routeHandleId) {
      validateHandleField(routeHandleId, 'route', handles, turn, errors, 'target.routeHandleId');
    } else if (target.routeKey) {
      const routeHandle = findRouteHandle(target.routeKey, handles, turn);
      if (!routeHandle.ok) errors.push(`target.routeKey ${routeHandle.reason}`);
    } else {
      errors.push('target.routeHandleId or target.routeKey is required');
    }
  }
  if (step.type === 'fill_form' || step.type === 'submit_form') {
    const values = target.values || step.values || {};
    for (const [field, value] of Object.entries(values)) {
      if (typeof value !== 'string' || !/^profile\.[A-Za-z0-9_.[\]-]+$/.test(value)) {
        errors.push(`values.${field} must be a profile reference`);
      }
      if (typeof value === 'string' && SECRET_REF_RE.test(value) && !value.startsWith('profile.')) {
        errors.push(`values.${field} cannot request a secret value`);
      }
    }
  }
  return errors;
}

function normalizeStepHandleAliases(step = {}, { handles = null, turn = 0 } = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  const target = step.target || {};

  // Providers only receive opaque SDK handles. If a valid surface handle is
  // placed under the click-control field, keep the plan strict but route it
  // through the correct typed tool instead of failing before execution.
  if (step.type === 'click_control' && target.controlId && handles && typeof handles.validate === 'function') {
    const result = handles.validate(target.controlId, { turn });
    if (result.ok && result.handle && result.handle.type === 'surface') {
      return {
        ...step,
        type: 'open_surface',
        target: {
          ...target,
          surfaceId: target.controlId
        },
        normalizedFrom: {
          type: 'click_control',
          targetField: 'controlId',
          reason: 'surface_handle_click_alias'
        }
      };
    }
    if (result.ok && result.handle && result.handle.type === 'route') {
      return {
        ...step,
        type: 'visit_route',
        target: {
          ...target,
          routeHandleId: target.controlId,
          routeKey: result.handle.routeKey || target.routeKey || null
        },
        normalizedFrom: {
          type: 'click_control',
          targetField: 'controlId',
          reason: 'route_handle_click_alias'
        }
      };
    }
  }

  if (step.type === 'open_surface' && target.surfaceId && handles && typeof handles.validate === 'function') {
    const result = handles.validate(target.surfaceId, { turn });
    if (result.ok && result.handle && result.handle.type === 'route') {
      return {
        ...step,
        type: 'visit_route',
        target: {
          ...target,
          routeHandleId: target.surfaceId,
          routeKey: result.handle.routeKey || target.routeKey || null
        },
        normalizedFrom: {
          type: 'open_surface',
          targetField: 'surfaceId',
          reason: 'route_handle_surface_alias'
        }
      };
    }
  }

  if (step.type === 'open_surface' && (target.routeHandleId || target.routeId) && handles && typeof handles.validate === 'function') {
    const routeHandleId = target.routeHandleId || target.routeId;
    const result = handles.validate(routeHandleId, { turn });
    if (result.ok && result.handle && result.handle.type === 'route') {
      return {
        ...step,
        type: 'visit_route',
        target: {
          ...target,
          routeHandleId,
          routeKey: result.handle.routeKey || target.routeKey || null
        },
        normalizedFrom: {
          type: 'open_surface',
          targetField: target.routeHandleId ? 'routeHandleId' : 'routeId',
          reason: 'route_handle_open_surface_alias'
        }
      };
    }
  }

  if ((step.type === 'fill_form' || step.type === 'submit_form') && target.formId && handles && typeof handles.validate === 'function') {
    const result = handles.validate(target.formId, { turn });
    if (!result.ok) {
      const alias = findFreshHandleAlias(target.formId, 'form', handles, turn);
      if (alias.ok && alias.handle) {
        return {
          ...step,
          target: {
            ...target,
            formId: alias.handle.id
          },
          normalizedFrom: {
            ...(step.normalizedFrom || {}),
            formHandle: {
              targetField: 'formId',
              reason: 'form_handle_summary_alias',
              aliasSource: alias.source
            }
          }
        };
      }
    }
  }

  return step;
}

function normalizeFormValueReferences(step = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  if (step.type !== 'fill_form' && step.type !== 'submit_form') return step;
  const sourceValues = step.target && step.target.values || step.values || null;
  if (!sourceValues || typeof sourceValues !== 'object' || Array.isArray(sourceValues)) return step;

  const kept = {};
  const ignored = [];
  const errors = [];
  for (const [field, value] of Object.entries(sourceValues)) {
    if (typeof value === 'string' && /^profile\.[A-Za-z0-9_.[\]-]+$/.test(value)) {
      kept[field] = value;
      continue;
    }
    if (SECRET_REF_RE.test(String(field || '')) || SECRET_REF_RE.test(String(value || ''))) {
      errors.push(`values.${field} cannot request a secret value`);
      continue;
    }
    ignored.push(field);
  }

  if (!ignored.length && !errors.length) return step;
  const nextTarget = { ...(step.target || {}) };
  if (Object.keys(kept).length) nextTarget.values = kept;
  else delete nextTarget.values;
  const next = {
    ...step,
    target: nextTarget,
    normalizedFrom: {
      ...(step.normalizedFrom || {}),
      formValues: {
        reason: 'provider_literals_ignored_sdk_local_form_resolution',
        ignoredFields: ignored
      }
    }
  };
  if (errors.length) next.valueValidationErrors = errors;
  if (step.values) delete next.values;
  return next;
}

function validateHandleField(id, type, handles, turn, errors, label) {
  if (!id) {
    errors.push(`${label} is required`);
    return;
  }
  if (!handles || typeof handles.validate !== 'function') {
    errors.push(`${label} cannot be validated`);
    return;
  }
  const result = handles.validate(id, { type, turn });
  if (!result.ok) errors.push(`${label} ${result.reason}`);
}

function findRouteHandle(routeKey, handles, turn) {
  if (!handles || typeof handles.all !== 'function') return { ok: false, reason: 'cannot_be_validated' };
  const handle = handles.all().find(item => item.type === 'route' && item.routeKey === routeKey);
  if (!handle) return { ok: false, reason: 'unknown_handle' };
  return handles.validate(handle.id, { type: 'route', turn });
}

function findFreshHandleAlias(alias, type, handles, turn) {
  const normalized = normalizeHandleAlias(alias);
  if (!normalized || !handles || typeof handles.all !== 'function' || typeof handles.validate !== 'function') {
    return { ok: false, reason: 'cannot_be_validated', handle: null };
  }
  const matches = [];
  for (const handle of handles.all()) {
    if (!handle || handle.type !== type || !handle.id) continue;
    const validation = handles.validate(handle.id, { type, turn });
    if (!validation.ok) continue;
    const matchSource = handleAliasMatchSource(normalized, handle);
    if (matchSource) matches.push({ handle, source: matchSource });
  }
  if (matches.length === 1) return { ok: true, reason: 'fresh_handle_alias', handle: matches[0].handle, source: matches[0].source };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous_handle_alias', handle: null };
  return { ok: false, reason: 'unknown_handle_alias', handle: null };
}

function handleAliasMatchSource(alias, handle = {}) {
  const paths = [
    ['summary', 'id'],
    ['summary', 'formId'],
    ['summary', 'name'],
    ['summary', 'domId'],
    ['target', 'id'],
    ['target', 'formId'],
    ['target', 'name'],
    ['target', 'domId']
  ];
  for (const path of paths) {
    const value = path.reduce((current, key) => current && current[key], handle);
    if (normalizeHandleAlias(value) === alias) return path.join('.');
  }
  return null;
}

function normalizeHandleAlias(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function evaluateStepHandlePolicy(step = {}, { handles = null, turn = 0, agentConfig = {} } = {}) {
  const tier = stepHandlePolicyTier(step, { handles, turn });
  return evaluateRiskMode(tier, agentConfig);
}

function stepHandlePolicyTier(step = {}, { handles = null, turn = 0 } = {}) {
  const target = step.target || {};
  const ids = [
    target.controlId,
    target.formId,
    target.surfaceId,
    target.routeHandleId || target.routeId
  ].filter(Boolean);
  let tier = 'safe';
  for (const id of ids) {
    const result = handles && typeof handles.validate === 'function'
      ? handles.validate(id, { turn })
      : { ok: false };
    const handle = result && result.handle
      ? result.handle
      : handles && typeof handles.get === 'function'
        ? handles.get(id)
        : null;
    tier = maxPolicyTier(tier, effectiveHandlePolicyTier(handle));
  }
  return tier;
}

function coalesceFillSubmitSteps(steps = []) {
  const out = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const next = steps[index + 1];
    if (
      step && step.type === 'fill_form' &&
      next && next.type === 'submit_form' &&
      step.target && next.target &&
      step.target.formId &&
      step.target.formId === next.target.formId
    ) {
      out.push({
        ...next,
        target: {
          ...next.target,
          values: {
            ...(step.target.values || step.values || {}),
            ...(next.target.values || next.values || {})
          }
        },
        normalizedFrom: {
          type: 'fill_form+submit_form',
          reason: 'same_form_submit_transaction'
        }
      });
      index += 1;
      continue;
    }
    out.push(step);
  }
  return out;
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

function maxPolicyTier(a = 'safe', b = 'safe') {
  const order = { safe: 0, business: 1, destructive: 2 };
  return (order[b] || 0) > (order[a] || 0) ? b : a;
}

function evaluateRiskMode(required, agentConfig = {}) {
  if (required === 'safe') return { allowed: true, reason: 'safe_allowed' };
  if (required === 'business') {
    return agentConfig.allowBusinessMutations || agentConfig.riskMode === 'business' || agentConfig.riskMode === 'destructive'
      ? { allowed: true, reason: 'business_allowed' }
      : { allowed: false, reason: 'business_risk_requires_aggressive_or_allowBusinessMutations' };
  }
  if (required === 'destructive') {
    return agentConfig.allowDestructiveActions === true
      ? { allowed: true, reason: 'destructive_allowed' }
      : { allowed: false, reason: 'destructive_risk_requires_allowDestructiveActions' };
  }
  return { allowed: false, reason: 'unknown_risk_mode' };
}

function containsRawSelector(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => containsRawSelector(item));
  for (const [key, item] of Object.entries(value)) {
    if (RAW_SELECTOR_KEYS.test(key)) return true;
    if (RAW_TARGET_KEYS.test(key) && typeof item === 'string') return true;
    if (containsRawSelector(item)) return true;
  }
  return false;
}

function normalizeRiskMode(value) {
  const text = String(value || 'safe').toLowerCase();
  return RISK_MODES.includes(text) ? text : text;
}

function normalizeDelta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['routes', 'routeShapes', 'endpoints', 'forms', 'actions', 'findings']) {
    if (value[key] !== undefined) out[key] = Number(value[key]) || 0;
  }
  return Object.keys(out).length ? out : null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function rejected(reason, errors, plan, mission = null) {
  return {
    allowed: false,
    reason,
    rejectReason: REJECT_REASONS.includes(reason) ? reason : 'malformed_plan',
    errors,
    plan: redactPlanPreservingProfileRefs(plan || null),
    mission
  };
}

function redactPlanPreservingProfileRefs(value) {
  if (Array.isArray(value)) return value.map(redactPlanPreservingProfileRefs);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^profile\.[A-Za-z0-9_.[\]-]+$/.test(item)) {
      out[key] = item;
    } else if (item && typeof item === 'object') {
      out[key] = redactPlanPreservingProfileRefs(item);
    } else {
      out[key] = redactSecrets({ [key]: item })[key];
    }
  }
  return out;
}

module.exports = {
  REJECT_REASONS,
  RISK_MODES,
  STEP_TYPES,
  normalizeProviderPlan,
  validateActionPlan
};
