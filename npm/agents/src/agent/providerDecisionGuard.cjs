'use strict';

const CAPABILITIES_BY_KIND = Object.freeze({
  'auth-flow': ['state.assert', 'route.visit', 'mission:plan'],
  'scenario-unblock': ['state.assert', 'route.visit', 'mission:plan'],
  'auth-surface-traversal': ['surface.open', 'control.click', 'mission:plan'],
  'surface-expanded-route': ['control.click', 'route.visit', 'mission:plan'],
  'business-flow-continuation': ['surface.open', 'control.click', 'form.submit', 'mission:plan'],
  'form-validation-repair': ['form.fill', 'form.submit', 'mission:plan'],
  'missing-required-fields': ['form.fill', 'form.submit', 'mission:plan'],
  'wrong-credential-field': ['form.fill', 'form.submit', 'mission:plan'],
  'captcha-blocked': ['mission:plan'],
  'submitted-no-transition': ['form.submit', 'mission:plan'],
  'multi-step-form-next': ['control.click', 'form.submit', 'mission:plan'],
  'ptk-finding-entrypoint-reproduction': ['route.visit', 'mission:plan'],
  'hidden-route-verification': ['route.visit', 'mission:plan'],
  'route-hint-flow': ['route.visit', 'mission:plan'],
  'endpoint-backed-ui-flow': ['route.visit', 'mission:plan'],
  'graphql-operation-flow': ['http.request', 'mission:plan'],
  'hidden-param-flow': ['http.request'],
  'broad-coverage-tail': ['crawl:direct']
});

function validateProviderDecision(choice = {}, { missions = [] } = {}) {
  const errors = [];
  const normalized = normalizeChoice(choice);
  if (!normalized.missionId) errors.push('choice.missionId is required');
  if (!normalized.reason) errors.push('choice.reason is required');
  if (!normalized.expectedDelta) errors.push('choice.expectedDelta is required');
  if (!normalized.allowedCapability) errors.push('choice.allowedCapability is required');

  const mission = normalized.missionId
    ? missions.find(candidate => candidate && candidate.id === normalized.missionId)
    : null;
  if (normalized.missionId && !mission) errors.push('choice.missionId does not match an available mission');

  if (mission && normalized.allowedCapability) {
    const allowed = allowedCapabilitiesForMission(mission);
    if (!allowed.includes(normalized.allowedCapability)) {
      errors.push(`choice.allowedCapability ${normalized.allowedCapability} is not allowed for ${mission.kind}`);
    }
  }

  return {
    allowed: errors.length === 0,
    reason: errors.length ? 'provider_choice_rejected' : 'provider_choice_allowed',
    errors,
    choice: normalized,
    mission
  };
}

function normalizeChoice(choice = {}) {
  const expectedDelta = choice.expectedDelta !== undefined
    ? choice.expectedDelta
    : choice.expected_delta !== undefined
      ? choice.expected_delta
      : null;
  const allowedCapability = choice.allowedCapability || choice.allowed_capability || choice.capability || null;
  return {
    ...choice,
    missionId: choice.missionId || choice.mission_id || null,
    reason: typeof choice.reason === 'string' ? choice.reason.trim() : '',
    expectedDelta: normalizeExpectedDelta(expectedDelta),
    allowedCapability: allowedCapability ? String(allowedCapability).trim() : ''
  };
}

function normalizeExpectedDelta(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { description: text } : null;
  }
  if (typeof value !== 'object') return null;
  const output = { ...value };
  const keys = Object.keys(output).filter(key => output[key] !== undefined && output[key] !== null && output[key] !== '');
  return keys.length ? output : null;
}

function allowedCapabilitiesForMission(mission = {}) {
  const explicit = Array.isArray(mission.allowedCapabilities) ? mission.allowedCapabilities : [];
  const derived = CAPABILITIES_BY_KIND[mission.kind] || [];
  return Array.from(new Set([...explicit, ...derived]));
}

module.exports = {
  allowedCapabilitiesForMission,
  normalizeChoice,
  validateProviderDecision
};
