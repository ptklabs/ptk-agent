'use strict';

const { redactSecrets } = require('../core/config.cjs');

const HANDLE_TYPES = Object.freeze(['control', 'form', 'surface', 'route']);
const POLICY_TIERS = Object.freeze(['safe', 'business', 'destructive']);

function createAgentHandleRegistry({ turn = 0, maxAgeTurns = 0 } = {}) {
  const handles = new Map();
  let sequence = 0;

  function issue(input = {}) {
    const type = HANDLE_TYPES.includes(input.type) ? input.type : 'control';
    const policyTier = POLICY_TIERS.includes(input.policyTier) ? input.policyTier : 'safe';
    const id = input.id || `${prefixForType(type)}_${turn}_${++sequence}`;
    const handle = redactSecrets({
      id,
      type,
      routeKey: input.routeKey || null,
      stateKey: input.stateKey || null,
      source: input.source || 'pageModel',
      createdAtTurn: Number.isFinite(Number(input.createdAtTurn)) ? Number(input.createdAtTurn) : turn,
      expiresAfterTurn: Number.isFinite(Number(input.expiresAfterTurn)) ? Number(input.expiresAfterTurn) : turn + maxAgeTurns,
      policyTier,
      stable: input.stable === true,
      summary: input.summary || null,
      locatorPlanRef: input.locatorPlanRef || 'internal-only',
      target: input.target || null
    });
    handles.set(id, handle);
    return handle;
  }

  function get(id) {
    return id ? handles.get(id) || null : null;
  }

  function validate(id, options = {}) {
    const handle = get(id);
    if (!handle) return { ok: false, reason: 'unknown_handle', handle: null };
    const currentTurn = Number.isFinite(Number(options.turn)) ? Number(options.turn) : turn;
    if (currentTurn > Number(handle.expiresAfterTurn)) {
      return { ok: false, reason: 'stale_handle', handle };
    }
    if (options.type && handle.type !== options.type) {
      return { ok: false, reason: 'wrong_handle_type', handle };
    }
    return { ok: true, reason: 'fresh_handle', handle };
  }

  function invalidateMutatingStep() {
    for (const handle of handles.values()) {
      if (handle.type === 'control' || handle.type === 'form' || handle.type === 'surface') {
        handle.expiresAfterTurn = Math.min(Number(handle.expiresAfterTurn), turn - 1);
      }
    }
  }

  function snapshot() {
    return Array.from(handles.values()).map(handle => redactSecrets({
      id: handle.id,
      type: handle.type,
      routeKey: handle.routeKey,
      stateKey: handle.stateKey,
      source: handle.source,
      createdAtTurn: handle.createdAtTurn,
      expiresAfterTurn: handle.expiresAfterTurn,
      policyTier: handle.policyTier,
      stable: Boolean(handle.stable),
      summary: handle.summary || null
    }));
  }

  function all() {
    return Array.from(handles.values());
  }

  return {
    issue,
    get,
    validate,
    invalidateMutatingStep,
    snapshot,
    all,
    turn
  };
}

function issueHandlesForMissions(registry, missions = []) {
  const handlesByMission = new Map();
  for (const mission of missions || []) {
    if (!mission || !mission.id) continue;
    const route = executableRouteForMission(mission);
    if (!route) continue;
    const handle = registry.issue({
      type: 'route',
      routeKey: route,
      source: mission.source || 'missionCompiler',
      policyTier: 'safe',
      summary: {
        missionId: mission.id,
        missionKind: mission.kind,
        reason: mission.reason || null
      }
    });
    handlesByMission.set(mission.id, handle);
  }
  return handlesByMission;
}

function executableRouteForMission(mission = {}) {
  if (!mission) return null;
  if (mission.route) return mission.route;
  const routeHint = mission.routeHint || {};
  if (routeHint.url || routeHint.path || routeHint.route || routeHint.href) return routeHint.url || routeHint.path || routeHint.route || routeHint.href;
  const endpoint = mission.endpoint || {};
  if (endpoint.routeUrl || endpoint.route || endpoint.referrer) return endpoint.routeUrl || endpoint.route || endpoint.referrer;
  if (Array.isArray(endpoint.candidateRoutes) && endpoint.candidateRoutes.length) return endpoint.candidateRoutes[0];
  return null;
}

function prefixForType(type) {
  if (type === 'control') return 'ctrl';
  if (type === 'form') return 'form';
  if (type === 'surface') return 'surface';
  if (type === 'route') return 'route';
  return 'handle';
}

module.exports = {
  HANDLE_TYPES,
  POLICY_TIERS,
  createAgentHandleRegistry,
  executableRouteForMission,
  issueHandlesForMissions
};
