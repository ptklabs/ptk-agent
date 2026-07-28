'use strict';

const { executeMission } = require('./missionExecutor.cjs');
const { getManagerTool, listManagerTools } = require('./managerToolRegistry.cjs');
const { createPolicyEngine } = require('../policy/policyEngine.cjs');

function createManagerTools(context = {}) {
  const includeUnsafe = context.includeUnsafe === true;
  const policy = context.policyEngine || createPolicyEngine(context.policy || {});
  return {
    listTools() {
      return listManagerTools({ includeUnsafe });
    },
    async callTool(name, input = {}) {
      const tool = getManagerTool(name, { includeUnsafe });
      if (!tool) {
        return {
          ok: false,
          status: 'not_found',
          reason: 'tool_not_available'
        };
      }
      return dispatchTool(name, input, { ...context, policy });
    }
  };
}

async function dispatchTool(name, input, context) {
  switch (name) {
    case 'observe_state':
      return ok({
        coverageSummary: coverageSummary(context.coverage),
        scenario: scenarioStatus(context.coverage),
        ptk: ptkStatus(context.coverage),
        agent: agentStatus(context.agent)
      });
    case 'list_route_graph':
      return ok({
        routes: limitArray(context.coverage && context.coverage.routes, input.limit).map(summarizeRoute),
        edges: limitArray(context.coverage && context.coverage.edges, input.limit).map(summarizeEdge)
      });
    case 'list_endpoint_graph':
      return ok({
        endpoints: limitArray(context.coverage && context.coverage.endpoints, input.limit).map(summarizeEndpoint)
      });
    case 'execute_allowed_mission':
      return executeAllowedMission(input.mission, context);
    case 'get_ptk_lifecycle_status':
      return ok(ptkStatus(context.coverage));
    case 'get_scenario_status':
      return ok(scenarioStatus(context.coverage));
    case 'get_recent_action_effects':
      return ok({
        effects: limitArray(context.actionEffects || context.agent && context.agent.actionEffects, input.limit).map(summarizeEffect)
      });
    case 'get_raw_debug_state':
      return context.includeUnsafe === true
        ? ok({ coverage: context.coverage || null, agent: context.agent || null })
        : { ok: false, status: 'blocked', reason: 'unsafe_tool_not_enabled' };
    default:
      return { ok: false, status: 'not_found', reason: 'tool_not_available' };
  }
}

async function executeAllowedMission(mission = {}, context = {}) {
  const decision = context.policy.evaluateMission(mission, {
    baselineComplete: context.baselineComplete !== false
  });
  if (!decision.allowed) {
    return {
      ok: false,
      status: 'blocked',
      reason: decision.reason,
      policy: decision
    };
  }
  const result = await executeMission({
    mission,
    context,
    telemetry: context.telemetry || null,
    handlers: context.handlers || {}
  });
  return {
    ok: result.ok !== false,
    status: result.status || (result.ok === false ? 'failed' : 'completed'),
    result
  };
}

function ok(data) {
  return { ok: true, status: 'completed', data };
}

function coverageSummary(coverage = {}) {
  return coverage && coverage.summary || {
    routesVisited: Array.isArray(coverage && coverage.routes) ? coverage.routes.length : 0,
    routeShapes: Array.isArray(coverage && coverage.routeShapes) ? coverage.routeShapes.length : 0,
    endpointsObserved: Array.isArray(coverage && coverage.endpoints) ? coverage.endpoints.length : 0,
    formsDiscovered: Array.isArray(coverage && coverage.forms) ? coverage.forms.length : 0,
    actionsDiscovered: Array.isArray(coverage && coverage.actions) ? coverage.actions.length : 0
  };
}

function scenarioStatus(coverage = {}) {
  const scenario = coverage && coverage.scenario;
  if (!scenario) return null;
  return {
    status: scenario.status || null,
    ok: Boolean(scenario.ok),
    completedSteps: scenario.completedSteps || scenario.completed || 0,
    totalSteps: scenario.totalSteps || 0,
    failedStep: scenario.failedStep || scenario.failedStepId || null,
    failureReason: scenario.failureReason || null
  };
}

function ptkStatus(coverage = {}) {
  const ptk = coverage && coverage.ptk;
  if (!ptk) return null;
  return {
    bridge: ptk.bridge ? {
      available: Boolean(ptk.bridge.available),
      source: ptk.bridge.source || null,
      reason: ptk.bridge.reason || null
    } : null,
    lifecycle: ptk.lifecycle || null,
    validity: ptk.validity || ptk.evidence && ptk.evidence.validity || null,
    findings: ptk.findings ? {
      count: ptk.findings.count || ptk.findings.findingsCount || 0,
      bySeverity: ptk.findings.bySeverity || {},
      byEngine: ptk.findings.byEngine || {}
    } : null
  };
}

function agentStatus(agent = {}) {
  if (!agent) return null;
  return {
    status: agent.status || null,
    actual: agent.actual || null,
    choiceCount: Array.isArray(agent.choices) ? agent.choices.length : 0,
    resultCount: Array.isArray(agent.results) ? agent.results.length : 0
  };
}

function summarizeRoute(route = {}) {
  return {
    url: route.url || null,
    source: route.source || route.sourceTag || null,
    routeShape: route.routeShape || null,
    surfaceType: route.surfaceType || null,
    depth: route.depth || 0
  };
}

function summarizeEdge(edge = {}) {
  return {
    from: edge.from || null,
    to: edge.to || null,
    kind: edge.kind || edge.type || null
  };
}

function summarizeEndpoint(endpoint = {}) {
  return {
    key: endpoint.key || null,
    method: endpoint.method || null,
    path: endpoint.path || endpoint.url || null,
    status: endpoint.status || null,
    resourceType: endpoint.resourceType || null,
    routeUrl: endpoint.routeUrl || null,
    graphqlOperationName: endpoint.graphqlOperationName || null
  };
}

function summarizeEffect(effect = {}) {
  return {
    missionId: effect.missionId || null,
    missionKind: effect.missionKind || null,
    action: effect.action || null,
    delta: effect.delta || null,
    status: effect.status || null,
    noProgress: Boolean(effect.noProgress)
  };
}

function limitArray(value, limit) {
  const array = Array.isArray(value) ? value : [];
  const count = Math.max(1, Math.min(Number(limit) || 100, 500));
  return array.slice(0, count);
}

module.exports = {
  createManagerTools
};
