'use strict';

async function executeMission({ mission, context = {}, telemetry, handlers = {} }) {
  if (!mission) return { ok: false, status: 'failed', reason: 'no_mission' };
  telemetry && telemetry.event('agent.mission.execute', { missionId: mission.id, kind: mission.kind });
  if (handlers[mission.kind]) {
    const result = await handlers[mission.kind](mission, context);
    return { ok: result && result.ok !== false, missionId: mission.id, ...result };
  }
  switch (mission.kind) {
    case 'auth-flow':
    case 'scenario-unblock':
      return buildAuthFlowResult(mission, context);
    case 'hidden-route-verification':
    case 'route-hint-flow':
      return buildRouteHintResult(mission, context);
    case 'endpoint-backed-ui-flow':
      return buildEndpointBackedUiResult(mission, context);
    case 'graphql-operation-flow':
      return buildGraphqlOperationResult(mission, context);
    case 'hidden-param-flow':
      return buildHiddenParamResult(mission, context);
    case 'broad-coverage-tail':
      return buildBroadCoverageTailResult(mission, context);
    default:
      return {
        ok: false,
        status: 'failed',
        missionId: mission.id,
        kind: mission.kind,
        reason: 'unsupported_mission_kind',
        intents: [],
        results: []
      };
  }
}

function buildAuthFlowResult(mission, context) {
  const gap = mission.scenarioGap || mission.gap || {};
  const routes = uniqueStrings([
    mission.route,
    routeKey(gap),
    routeKey(context.authHint),
    ...collectionValues(context.evidence && context.evidence.authRoutes).map(routeKey)
  ]).filter(Boolean);
  const intents = [
    {
      kind: 'auth.assess-scenario-gap',
      capability: 'state.assert',
      source: mission.source || gap.source || 'scenario',
      scenarioGapId: gap.stepId || gap.id || mission.stepId || null,
      label: gap.label || gap.name || null
    }
  ];
  for (const route of routes) {
    intents.push({
      kind: 'route.visit',
      capability: 'route.visit',
      route,
      purpose: 'auth-flow-surface',
      source: 'auth-flow'
    });
  }
  if (context.profile && context.profile.credentialRef || mission.credentialRef) {
    intents.push({
      kind: 'auth.use-credential-ref',
      capability: 'mission:plan',
      credentialRef: mission.credentialRef || context.profile.credentialRef,
      purpose: 'scenario-auth-flow'
    });
  }
  return notExecutableMission(mission, 'emit_auth_flow_intents', intents, [{
    kind: 'auth-flow-ready',
    scenarioGapId: gap.stepId || gap.id || mission.stepId || null,
    routeCount: routes.length,
    credentialRef: mission.credentialRef || context.profile && context.profile.credentialRef || null
  }]);
}

function buildRouteHintResult(mission) {
  const route = routeKey(mission.routeHint) || routeKey(mission.route) || routeKey(mission);
  const intents = route ? [{
    kind: 'route.visit',
    capability: 'route.visit',
    route,
    purpose: 'route-hint-verification',
    source: mission.source || 'route-hint'
  }] : [];
  if (mission.routeHint && mission.routeHint.authHints && mission.routeHint.authHints.length) {
    intents.push({
      kind: 'auth.requirement-note',
      capability: 'mission:plan',
      route,
      authHints: mission.routeHint.authHints.slice()
    });
  }
  return notExecutableMission(mission, 'emit_route_hint_intents', intents, [{
    kind: 'route-hint-ready',
    route,
    expectedSignals: ['route-loaded', 'route-shape-observed', 'endpoint-observed']
  }]);
}

function buildEndpointBackedUiResult(mission) {
  const endpoint = mission.endpoint || {};
  const routeCandidates = uniqueStrings([
    mission.route,
    endpoint.routeUrl,
    endpoint.route,
    endpoint.referrer,
    ...collectionValues(endpoint.candidateRoutes).map(routeKey)
  ]).filter(Boolean);
  const summarizedEndpoint = summarizeEndpoint(endpoint);
  const intents = [{
    kind: 'endpoint.map-to-ui',
    capability: 'mission:plan',
    endpoint: summarizedEndpoint,
    routeCandidates,
    purpose: 'find-ui-surface-backed-by-endpoint'
  }];
  if (routeCandidates.length) {
    intents.push({
      kind: 'route.visit',
      capability: 'route.visit',
      route: routeCandidates[0],
      purpose: 'endpoint-backed-ui-flow',
      endpoint: summarizedEndpoint
    });
  } else {
    intents.push({
      kind: 'endpoint.observe',
      capability: 'mission:plan',
      endpoint: summarizedEndpoint,
      purpose: 'endpoint-backed-ui-flow'
    });
  }
  return notExecutableMission(mission, 'emit_endpoint_backed_ui_intents', intents, [{
    kind: 'endpoint-backed-ui-flow-ready',
    endpoint: summarizedEndpoint,
    routeCandidateCount: routeCandidates.length
  }]);
}

function buildGraphqlOperationResult(mission) {
  const endpoint = mission.endpoint || {};
  const operationName = endpoint.graphqlOperationName || endpoint.operationName || firstValue(endpoint.operationNames) || null;
  const operationType = inferGraphqlOperationType(endpoint);
  const summarizedEndpoint = summarizeEndpoint(endpoint);
  const safety = operationType === 'query' ? 'read-only' : 'requires-policy-approval';
  const intents = [
    {
      kind: 'graphql.operation.inspect',
      capability: 'mission:plan',
      endpoint: summarizedEndpoint,
      operationName,
      operationType,
      rootFields: collectionValues(endpoint.rootFields),
      variableNames: collectionValues(endpoint.variableNames)
    },
    {
      kind: 'graphql.operation.execute',
      capability: 'http.request',
      endpoint: summarizedEndpoint,
      operationName,
      operationType,
      safety,
      purpose: 'graphql-operation-flow'
    }
  ];
  return notExecutableMission(mission, 'emit_graphql_operation_intents', intents, [{
    kind: 'graphql-operation-flow-ready',
    endpoint: summarizedEndpoint,
    operationName,
    operationType,
    safety
  }]);
}

function buildHiddenParamResult(mission) {
  const params = collectionValues(mission.params).map(normalizeParam).filter(Boolean);
  const intents = params.map(param => ({
    kind: 'hidden-param.probe',
    capability: 'http.request',
    name: param.name,
    location: param.location,
    endpoint: summarizeEndpoint(param.endpoint || mission.endpoint || {}),
    valueHint: param.valueHint || null,
    safety: 'baseline-differential',
    source: param.source || mission.source || 'evidence'
  }));
  return notExecutableMission(mission, 'emit_hidden_param_intents', intents, [{
    kind: 'hidden-param-flow-ready',
    paramCount: params.length,
    params: params.map(param => ({
      name: param.name,
      location: param.location,
      endpoint: summarizeEndpoint(param.endpoint || mission.endpoint || {})
    }))
  }]);
}

function buildBroadCoverageTailResult(mission) {
  return notExecutableMission(mission, 'defer_to_direct_crawler', [{
    kind: 'crawler.continue',
    capability: 'crawl:direct',
    strategy: 'broad-coverage-tail',
    purpose: 'continue deterministic frontier exploration'
  }], [{
    kind: 'broad-coverage-tail-ready',
    strategy: 'direct-frontier'
  }]);
}

function notExecutableMission(mission, action, intents, results) {
  return {
    ok: false,
    status: 'not_executable',
    missionId: mission.id,
    kind: mission.kind,
    action,
    reason: 'intent_only_mission_requires_live_session_handler',
    intents,
    results
  };
}

function summarizeEndpoint(endpoint = {}) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') return { path: endpoint };
  return {
    key: endpoint.key || null,
    method: endpoint.method || null,
    path: endpoint.path || endpoint.url || endpoint.href || endpoint.route || null,
    status: endpoint.status || null,
    resourceType: endpoint.resourceType || null,
    graphqlOperationName: endpoint.graphqlOperationName || endpoint.operationName || firstValue(endpoint.operationNames) || null
  };
}

function normalizeParam(param) {
  if (!param) return null;
  if (typeof param === 'string') return { name: param, location: 'query' };
  return {
    name: param.name || param.param || param.key || param.parameter || null,
    location: param.location || param.in || 'query',
    endpoint: param.endpoint || param.target || null,
    valueHint: param.valueHint || param.example || null,
    source: param.source || null
  };
}

function routeKey(route) {
  if (!route) return null;
  if (typeof route === 'string') return route;
  return route.url || route.href || route.path || route.route || route.coverage && route.coverage.url || route.routeKey || null;
}

function inferGraphqlOperationType(endpoint = {}) {
  const explicit = firstValue(endpoint.operationTypes) || endpoint.operationType || endpoint.graphqlOperationType;
  if (explicit) return String(explicit).toLowerCase();
  const text = `${endpoint.query || ''} ${endpoint.body || ''} ${endpoint.postData || ''}`.toLowerCase();
  if (/\bmutation\b/.test(text)) return 'mutation';
  if (/\bsubscription\b/.test(text)) return 'subscription';
  return 'query';
}

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return Array.from(value.values());
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function firstValue(value) {
  const values = collectionValues(value);
  return values.length ? values[0] : null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

module.exports = {
  executeMission,
  notExecutableMission,
  summarizeEndpoint
};
