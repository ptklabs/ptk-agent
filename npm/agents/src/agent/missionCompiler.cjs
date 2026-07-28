'use strict';

const { extractPtkFindings, normalizeFinding, redactPtkSecrets } = require('../evidence/ptkEvidenceAdapter.cjs');

function compileMissions({ coverage = {}, scenarioStatus = null, evidence = {} } = {}) {
  const missions = [];
  const seen = new Set();
  const visitedRoutes = new Set(collectionValues(coverage.routes).map(routeKey).filter(Boolean));
  const routeHints = collectRouteHints({ coverage, evidence });

  for (const gap of collectScenarioGaps(scenarioStatus)) {
    const route = routeKey(gap);
    if (isAuthScenarioGap(gap)) {
      addMission(missions, seen, {
        id: `mission:auth-flow:${stableToken(gap.stepId || gap.id || gap.name || gap.label || route || 'scenario-gap')}`,
        kind: 'auth-flow',
        priority: 120,
        reason: 'scenario auth gap requires session progress',
        source: 'scenario',
        route,
        scenarioGap: gap
      });
      continue;
    }
    if (route && !visitedRoutes.has(route)) {
      addMission(missions, seen, {
        id: `mission:scenario-route-gap:${stableToken(route)}`,
        kind: 'hidden-route-verification',
        priority: 118,
        reason: 'scenario gap route has not been covered',
        source: 'scenario',
        route,
        routeHint: { ...gap, url: route }
      });
      continue;
    }
    addMission(missions, seen, {
      id: `mission:auth-flow:${stableToken(gap.stepId || gap.id || gap.name || gap.label || 'scenario-gap')}`,
      kind: 'auth-flow',
      priority: 120,
      reason: 'scenario gap requires auth/session progress',
      source: 'scenario',
      scenarioGap: gap
    });
  }

  for (const finding of collectFindingEntryPoints({ coverage, evidence })) {
    const route = finding.route || finding.url;
    addMission(missions, seen, {
      id: `mission:ptk-finding-entrypoint:${stableToken(`${finding.engine}:${finding.ruleId || finding.title}:${route || finding.parameter || finding.fingerprint}`)}`,
      kind: 'ptk-finding-entrypoint-reproduction',
      priority: severityPriority(finding.severity, 126),
      reason: 'PTK finding entry point can be revisited through the live browser session',
      source: finding.source || 'ptk-finding',
      route,
      finding,
      routeHint: route ? { kind: 'route', url: route, source: finding.source || 'ptk-finding', evidenceRef: finding.id || finding.fingerprint || null } : null,
      executable: Boolean(route),
      allowCoveredRouteReplay: true,
      expectedDeltaHint: { routes: 0, endpoints: 1, forms: 0, actions: 1, findings: 0 },
      allowedCapabilities: ['route.visit', 'mission:plan']
    });
  }

  for (const surfaceGap of collectAuthSurfaceGaps(coverage)) {
    addMission(missions, seen, {
      id: `mission:auth-surface-gap:${stableToken(`${surfaceGap.route}:${surfaceGap.reason}:${surfaceGap.actionLabel || ''}`)}`,
      kind: 'auth-surface-traversal',
      priority: authSurfaceGapPriority(surfaceGap),
      reason: 'authenticated surface had safe menu actions that were skipped or not fully explored',
      source: 'auth-surface-summary',
      route: surfaceGap.route,
      surfaceGap,
      executable: Boolean(surfaceGap.route),
      allowCoveredRouteReplay: authSurfaceGapCanAddNonRouteDelta(surfaceGap),
      expectedDeltaHint: { routes: 0, endpoints: 1, forms: 0, actions: 1, findings: 0 },
      allowedCapabilities: ['route.visit', 'surface.open', 'control.click', 'mission:plan']
    });
  }

  for (const formMission of collectHistoricalFormMissions(coverage)) {
    addMission(missions, seen, formMission);
  }

  for (const routeHint of routeHints) {
    if (!isRouteHintCandidate(routeHint, visitedRoutes)) continue;
    const route = routeKey(routeHint);
    addMission(missions, seen, {
      id: `mission:route-hint:${stableToken(route)}`,
      kind: 'hidden-route-verification',
      priority: routeHint.source === 'coverage-gap' ? 115 : 110,
      reason: routeHint.source === 'coverage-gap'
        ? 'coverage gap route has not been visited'
        : 'route hint was not covered',
      source: routeHint.source || 'route-hint',
      route,
      routeHint
    });
  }

  for (const endpoint of collectEndpoints({ coverage, evidence })) {
    if (!isApplicationEndpoint(endpoint)) continue;
    const isGraphql = isGraphqlEndpoint(endpoint);
    const executable = endpointHasExecutableUiPath(endpoint);
    addMission(missions, seen, {
      id: `mission:${isGraphql ? 'graphql' : 'endpoint'}:${stableToken(endpointKey(endpoint))}`,
      kind: isGraphql ? 'graphql-operation-flow' : 'endpoint-backed-ui-flow',
      priority: isGraphql ? 100 : 90,
      reason: isGraphql
        ? executable
          ? 'GraphQL operation endpoint has an executable UI path or finding entrypoint'
          : 'GraphQL operation endpoint was observed without an executable UI path'
        : executable
          ? 'application/API endpoint has an executable UI path or finding entrypoint'
          : 'application/API endpoint was observed without an executable UI path',
      source: endpoint.source || 'coverage-endpoint',
      endpoint,
      executable,
      notExecutableReason: executable ? null : 'endpoint_without_ui_path'
    });
  }

  const hiddenParams = collectHiddenParams({ coverage, evidence });
  if (hiddenParams.length) {
    addMission(missions, seen, {
      id: 'mission:hidden-param-flow',
      kind: 'hidden-param-flow',
      priority: 80,
      reason: 'hidden parameters were inferred from evidence',
      source: 'evidence',
      params: hiddenParams,
      executable: false,
      notExecutableReason: 'intent_only_without_executor'
    });
  }

  addMission(missions, seen, {
    id: 'mission:broad-coverage-tail',
    kind: 'broad-coverage-tail',
    priority: 10,
    reason: 'continue direct crawling'
  });

  return missions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function compileMissionCandidates(context = {}) {
  return compileMissions({
    coverage: context.coverage || {},
    scenarioStatus: context.scenarioStatus || null,
    evidence: context.evidence || {}
  });
}

function summarizeMissionCompiler({ offered = [], suppressed = [], skipped = [] } = {}) {
  const suppressionReasons = {
    already_covered_no_delta: 0,
    endpoint_without_ui_path: 0,
    intent_only_without_executor: 0,
    stale_handle: 0,
    policy_denied: 0,
    low_value: 0,
    no_scenario_gating: 0
  };
  for (const item of [...suppressed, ...skipped]) {
    const reason = item.reason || 'low_value';
    suppressionReasons[reason] = (suppressionReasons[reason] || 0) + 1;
  }
  return {
    schemaVersion: 'ptk-agent-v2-mission-compiler-summary',
    generatedAt: new Date().toISOString(),
    offered: offered.map(summarizeMission),
    suppressed: suppressed.map(summarizeSuppressedMission),
    skipped: skipped.map(summarizeSuppressedMission),
    countsByKind: countBy(offered, mission => mission.kind || 'unknown'),
    suppressionReasons
  };
}

function summarizeMission(mission = {}) {
  return {
    id: mission.id || null,
    kind: mission.kind || null,
    priority: mission.priority || 0,
    source: mission.source || null,
    reason: mission.reason || null,
    executable: mission.executable !== false,
    route: mission.route || mission.routeHint && (mission.routeHint.url || mission.routeHint.route || mission.routeHint.path) || null,
    endpoint: mission.endpoint && (mission.endpoint.key || mission.endpoint.path || mission.endpoint.url) || null
  };
}

function summarizeSuppressedMission(item = {}) {
  return {
    ...summarizeMission(item.mission || item),
    reason: item.reason || item.mission && item.mission.reason || null
  };
}

function countBy(values = [], keyFn) {
  const out = {};
  for (const value of values || []) {
    const key = keyFn(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function isApplicationEndpoint(endpoint = {}) {
  if (!endpoint) return false;
  if (isGraphqlEndpoint(endpoint)) return true;
  if (isStaticEndpoint(endpoint)) return false;

  const resourceType = String(endpoint.resourceType || '').toLowerCase();
  if (['xhr', 'fetch', 'document', 'beacon'].includes(resourceType)) return true;

  const path = endpointPath(endpoint);
  if (isApiLikePath(path)) return true;

  const method = String(endpoint.method || '').toUpperCase();
  if (endpoint.kind === 'endpoint') return true;
  if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;

  return resourceType === 'unknown' && isApiLikePath(path);
}

function endpointHasExecutableUiPath(endpoint = {}) {
  if (!endpoint) return false;
  if (endpoint.route || endpoint.routeUrl || endpoint.uiRoute || endpoint.entryRoute || endpoint.entrypointRoute) return true;
  if (Array.isArray(endpoint.candidateRoutes) && endpoint.candidateRoutes.length) return true;
  if (Array.isArray(endpoint.candidateControls) && endpoint.candidateControls.length) return true;
  if (Array.isArray(endpoint.candidateForms) && endpoint.candidateForms.length) return true;
  if (endpoint.uiPath || endpoint.uiTrigger || endpoint.controlId || endpoint.formId) return true;
  const source = String(endpoint.source || endpoint.evidenceSource || '').toLowerCase();
  if (/ptk|sast|finding|entrypoint|analysis/.test(source)) return true;
  if (endpoint.findingId || endpoint.findingRef || endpoint.evidenceRef || endpoint.evidenceRefs) return true;
  return false;
}

function collectScenarioGaps(scenarioStatus) {
  if (!scenarioStatus) return [];
  const gaps = [];
  for (const key of ['blockedSteps', 'gaps', 'missingSteps', 'pendingSteps', 'incompleteSteps']) {
    for (const gap of collectionValues(scenarioStatus[key])) {
      if (!gap) continue;
      gaps.push(normalizeScenarioGap(gap, key));
    }
  }
  if (!gaps.length && scenarioStatus.ok === false) {
    gaps.push(normalizeScenarioGap({
      id: scenarioStatus.currentStepId || scenarioStatus.stepId || 'scenario-gap',
      label: scenarioStatus.reason || scenarioStatus.message || 'scenario has incomplete step',
      route: scenarioStatus.route || scenarioStatus.url || null
    }, 'status'));
  }
  return dedupeBy(gaps, gap => stableToken(gap.stepId || gap.id || gap.name || gap.label || routeKey(gap)));
}

function normalizeScenarioGap(gap, source) {
  if (typeof gap === 'string') return { id: gap, stepId: gap, label: gap, source };
  return { ...gap, source };
}

function isAuthScenarioGap(gap) {
  const text = [
    gap.stepId,
    gap.id,
    gap.name,
    gap.label,
    gap.reason,
    routeKey(gap)
  ].filter(Boolean).join(' ').toLowerCase();
  return /auth|login|log in|sign[ -]?in|session|credential|password|mfa|signup|sign[ -]?up|register/.test(text);
}

function collectRouteHints({ coverage = {}, evidence = {} } = {}) {
  const hints = [];
  for (const gap of collectionValues(coverage.gaps)) {
    const route = routeKey(gap) || String(gap || '');
    if (!route) continue;
    hints.push({ kind: 'route', url: route, source: 'coverage-gap' });
  }
  for (const hint of [
    ...routeHintValues(evidence.routeHints),
    ...routeHintValues(evidence.hints),
    ...routeHintValues(coverage.routeHints)
  ]) {
    if (!hint) continue;
    if (typeof hint === 'string') {
      hints.push({ kind: 'route', url: hint, source: 'route-hint' });
      continue;
    }
    const kind = hint.kind || 'route';
    if (kind !== 'route' && kind !== 'surface') continue;
    hints.push({ ...hint, kind, source: hint.source || 'route-hint' });
  }
  return dedupeBy(hints, hint => routeKey(hint));
}

function routeHintValues(value) {
  if (value && Array.isArray(value.hints)) return value.hints;
  return collectionValues(value);
}

function isRouteHintCandidate(routeHint, visitedRoutes) {
  const route = routeKey(routeHint);
  if (!route || visitedRoutes.has(route)) return false;
  const coverageStatus = routeHint.coverage && routeHint.coverage.status;
  if (coverageStatus === 'visited' || String(coverageStatus || '').startsWith('skipped_')) return false;
  return !isStaticAssetPath(route);
}

function collectEndpoints({ coverage = {}, evidence = {} } = {}) {
  const endpoints = [];
  for (const endpoint of collectionValues(coverage.endpoints)) {
    const normalized = normalizeEndpoint(endpoint, 'coverage-endpoint');
    if (normalized) endpoints.push(normalized);
  }
  for (const hint of [
    ...routeHintValues(evidence.routeHints),
    ...routeHintValues(evidence.hints),
    ...routeHintValues(coverage.routeHints)
  ]) {
    if (!hint || typeof hint === 'string') continue;
    if (hint.kind !== 'endpoint' && hint.kind !== 'graphql') continue;
    const normalized = normalizeEndpoint(hint, hint.source || `route-hint:${hint.kind}`);
    if (normalized) endpoints.push(normalized);
  }
  return dedupeBy(endpoints, endpointKey);
}

function normalizeEndpoint(endpoint, source) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') return { path: endpoint, source };
  return {
    ...endpoint,
    source: endpoint.source || source,
    resourceType: endpoint.resourceType || (endpoint.kind ? 'unknown' : endpoint.resourceType),
    graphqlOperationName: endpoint.graphqlOperationName || firstValue(endpoint.operationNames)
  };
}

function collectHiddenParams({ coverage = {}, evidence = {} } = {}) {
  const params = [];
  for (const param of collectionValues(evidence.hiddenParams)) {
    params.push(normalizeHiddenParam(param, 'evidence.hiddenParams'));
  }
  for (const param of collectionValues(coverage.hiddenParams)) {
    params.push(normalizeHiddenParam(param, 'coverage.hiddenParams'));
  }
  for (const hint of [
    ...routeHintValues(evidence.routeHints),
    ...routeHintValues(evidence.hints),
    ...routeHintValues(coverage.routeHints)
  ]) {
    if (!hint || typeof hint === 'string' || hint.kind !== 'hidden-param') continue;
    if (isStaticAssetPath(endpointPath(hint))) continue;
    for (const name of collectionValues(hint.paramNames)) {
      params.push(normalizeHiddenParam({ name, location: 'query', endpoint: hint }, hint.source || 'route-hint:hidden-param'));
    }
    for (const name of collectionValues(hint.bodyKeys)) {
      params.push(normalizeHiddenParam({ name, location: 'body', endpoint: hint }, hint.source || 'route-hint:hidden-param'));
    }
    for (const name of collectionValues(hint.headerNames)) {
      params.push(normalizeHiddenParam({ name, location: 'header', endpoint: hint }, hint.source || 'route-hint:hidden-param'));
    }
    for (const name of collectionValues(hint.variableNames)) {
      params.push(normalizeHiddenParam({ name, location: 'graphql-variable', endpoint: hint }, hint.source || 'route-hint:hidden-param'));
    }
  }
  return dedupeBy(params.filter(param => {
    if (!param || (!param.name && !param.endpoint)) return false;
    return !param.endpoint || !isStaticAssetPath(endpointPath(param.endpoint));
  }), param => [
    param.location || '',
    param.name || '',
    endpointKey(param.endpoint || param)
  ].join(':')).sort((a, b) => `${a.location || ''}:${a.name || ''}`.localeCompare(`${b.location || ''}:${b.name || ''}`));
}

function collectFindingEntryPoints({ coverage = {}, evidence = {} } = {}) {
  const sources = [
    evidence.ptkSignals,
    evidence.findings,
    evidence.evidenceRecords,
    coverage.agentPtkSignals,
    coverage.ptk,
    coverage.ptk && coverage.ptk.evidence,
    coverage.ptk && coverage.ptk.findings
  ].filter(Boolean);
  const findings = [];
  for (const source of sources) {
    for (const raw of extractPtkFindings(source)) {
      const normalized = normalizeFinding(raw);
      const route = preferredFindingRoute(raw, normalized);
      if (!route || isStaticAssetPath(route) || !isBrowserNavigableFindingRoute(route)) continue;
      findings.push({
        id: normalized.id,
        fingerprint: normalized.fingerprint,
        engine: normalized.engine,
        title: normalized.title,
        severity: normalized.severity,
        confidence: normalized.confidence,
        ruleId: normalized.ruleId,
        category: normalized.category,
        url: normalized.url,
        route,
        method: normalized.method,
        parameter: normalized.parameter,
        source: `ptk-${String(normalized.engine || 'finding').toLowerCase()}`
      });
    }
  }
  return dedupeBy(
    findings.sort((a, b) => severityPriority(b.severity, 0) - severityPriority(a.severity, 0)),
    finding => finding.route || finding.url || finding.fingerprint
  ).slice(0, 8);
}

function preferredFindingRoute(raw = {}, normalized = {}) {
  const safeRaw = redactPtkSecrets(raw);
  const location = safeRaw.location || {};
  const candidates = [
    location.runtimeUrl,
    firstValue(location.runtimeUrls),
    location.pageUrl,
    firstValue(location.pageUrls),
    location.route,
    normalized.url
  ].filter(Boolean);
  return candidates.find(candidate => !isStaticAssetPath(candidate)) || null;
}

function collectAuthSurfaceGaps(coverage = {}) {
  const summary = coverage.authSurfaceSummary || {};
  const gaps = [];
  for (const action of collectionValues(summary.menuActions)) {
    const reason = String(action && action.reason || '');
    const route = authSurfaceTargetRoute(action);
    if (!route) continue;
    if (!/surface_reopen_failed|surface_explorer_budget_exhausted|no_progress|timeout|not_executed/i.test(reason)) continue;
    if (/logout|sign[ -]?out|delete|destroy|password reset/i.test(`${action.label || ''} ${action.actionId || ''}`)) continue;
    gaps.push({
      route,
      reason,
      actionLabel: action.label || null,
      actionId: action.actionId || null,
      depth: action.depth ?? null
    });
  }
  return dedupeBy(gaps, gap => `${gap.route}:${gap.reason}:${gap.actionLabel || gap.actionId || ''}`).slice(0, 12);
}

function authSurfaceTargetRoute(action = {}) {
  if (!action || typeof action !== 'object') return null;
  const direct = action.targetRoute || action.targetRouteUrl || action.discoveredRoute || action.discoveredRouteUrl || action.href || action.url || action.route || null;
  if (direct && direct !== action.routeUrl) return direct;
  const routerLink = routerLinkFromText(`${action.actionId || ''} ${action.selector || ''}`);
  if (routerLink) return absoluteSpaRoute(action.routeUrl || action.pageUrl || action.url, routerLink);
  if (action.routeUrl && !action.actionId && !action.selector) return action.routeUrl;
  return null;
}

function authSurfaceGapCanAddNonRouteDelta(surfaceGap = {}) {
  const reason = String(surfaceGap.reason || '').toLowerCase();
  return /surface_explorer_budget_exhausted|not_executed|timeout|no_progress/.test(reason);
}

function authSurfaceGapPriority(surfaceGap = {}) {
  return authSurfaceGapCanAddNonRouteDelta(surfaceGap) ? 136 : 124;
}

function routerLinkFromText(text) {
  const source = String(text || '');
  const match = source.match(/routerlink\s*=\s*(?:"|')([^"']+)(?:"|')/i);
  if (!match) return null;
  return match[1].replace(/\\\//g, '/');
}

function absoluteSpaRoute(baseRoute, route) {
  if (!route) return null;
  const value = String(route);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (!baseRoute) return value;
  try {
    const url = new URL(baseRoute);
    if (value.startsWith('#')) {
      url.hash = value;
    } else {
      url.hash = value.startsWith('/') ? `#${value}` : `#/${value}`;
    }
    return url.toString();
  } catch (_) {
    return value;
  }
}

function collectHistoricalFormMissions(coverage = {}) {
  const missions = [];
  for (const form of collectionValues(coverage.forms)) {
    if (!form || typeof form !== 'object') continue;
    if (!hasHistoricalFormRepairSignal(form)) continue;
    if (isHistoricalUploadForm(form)) continue;
    const route = form.routeUrl || form.pageUrl || form.url || form.action || null;
    if (!route || isStaticAssetPath(route)) continue;
    const kind = historicalFormMissionKind(form);
    if (kind === 'captcha-blocked') continue;
    missions.push({
      id: `mission:${kind}:${stableToken(`${route}:${form.id || form.kind || 'form'}`)}`,
      kind,
      priority: historicalFormPriority(kind),
      reason: historicalFormReason(kind),
      source: 'form-summary',
      route,
      form: summarizeHistoricalForm(form),
      executable: true,
      allowedCapabilities: ['route.visit', 'form.fill', 'form.submit', 'mission:plan']
    });
  }
  return dedupeBy(missions, mission => mission.id).slice(0, 12);
}

function hasHistoricalFormRepairSignal(form = {}) {
  const text = JSON.stringify({
    id: form.id,
    kind: form.kind,
    status: form.status,
    result: form.result,
    reason: form.reason,
    failureReason: form.failureReason,
    validation: form.validation,
    validationMessages: form.validationMessages,
    errors: form.errors,
    noProgress: form.noProgress,
    captcha: form.captcha
  }).toLowerCase();
  return /validation|required|invalid|error|captcha|no[_ -]?progress|submitted-no-transition|blocked|failed|missing|required/.test(text);
}

function isHistoricalUploadForm(form = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const text = JSON.stringify({
    id: form.id,
    kind: form.kind,
    semanticKind: form.semanticKind,
    intent: form.intent,
    formPurpose: form.formPurpose,
    action: form.action,
    fields
  }).toLowerCase();
  return /file[ -]?upload|upload[ -]?file|\battachment\b|input[^\n\r]{0,40}type[^\n\r]{0,10}file/.test(text) ||
    fields.some(field => String(field && (field.type || field.inputType) || '').toLowerCase() === 'file');
}

function historicalFormMissionKind(form = {}) {
  const text = JSON.stringify({
    id: form.id,
    kind: form.kind,
    validation: form.validation,
    fields: form.fields
  }).toLowerCase();
  if (/captcha/.test(text)) return 'captcha-blocked';
  if (/validation|required|invalid|error/.test(text)) return 'form-validation-repair';
  if (/credential|email|username|password|login|auth/.test(text)) return 'wrong-credential-field';
  if (/next|step|wizard/.test(text)) return 'multi-step-form-next';
  return 'missing-required-fields';
}

function historicalFormPriority(kind) {
  if (kind === 'wrong-credential-field') return 113;
  if (kind === 'form-validation-repair') return 112;
  if (kind === 'multi-step-form-next') return 110;
  return 104;
}

function historicalFormReason(kind) {
  if (kind === 'wrong-credential-field') return 'previously observed credential-like form may need profile-backed field mapping';
  if (kind === 'form-validation-repair') return 'previously observed form showed validation or missing-field signals';
  if (kind === 'multi-step-form-next') return 'previously observed multi-step form may need next-step continuation';
  return 'previously observed business form can be revisited and submitted through fresh handles';
}

function summarizeHistoricalForm(form = {}) {
  return {
    id: form.id || null,
    kind: form.kind || null,
    routeUrl: form.routeUrl || form.pageUrl || form.url || null,
    action: form.action || null,
    method: form.method || null,
    fieldCount: Array.isArray(form.fields) ? form.fields.length : 0
  };
}

function severityPriority(severity, base = 100) {
  const value = String(severity || '').toLowerCase();
  if (value === 'critical') return base + 6;
  if (value === 'high') return base + 4;
  if (value === 'medium') return base + 2;
  return base;
}

function normalizeHiddenParam(param, source) {
  if (!param) return null;
  if (typeof param === 'string') return { name: param, location: 'query', source };
  const endpoint = param.endpoint || param.target || null;
  return {
    name: param.name || param.param || param.key || param.parameter || null,
    location: param.location || param.in || 'query',
    source: param.source || source,
    endpoint,
    evidenceRef: param.evidenceRef || param.evidenceRefs || null,
    valueHint: param.valueHint || param.example || null
  };
}

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return Array.from(value.values());
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function addMission(missions, seen, mission) {
  if (!mission || !mission.id || seen.has(mission.id)) return;
  seen.add(mission.id);
  missions.push(mission);
}

function routeKey(route) {
  if (!route) return null;
  if (typeof route === 'string') return route;
  return route.url || route.href || route.path || route.route || route.coverage && route.coverage.url || route.routeKey || null;
}

function endpointKey(endpoint = {}) {
  if (!endpoint) return 'unknown';
  if (typeof endpoint === 'string') return endpoint;
  const method = endpoint.method ? String(endpoint.method).toUpperCase() : '';
  const path = endpointPath(endpoint) || endpoint.key || endpoint.id || endpoint.routeKey || 'unknown';
  const operation = endpoint.graphqlOperationName || endpoint.operationName || firstValue(endpoint.operationNames) || '';
  return [method, path, operation].filter(Boolean).join(' ');
}

function endpointPath(endpoint = {}) {
  if (!endpoint) return '';
  if (typeof endpoint === 'string') return endpoint;
  return String(endpoint.path || endpoint.url || endpoint.href || endpoint.route || endpoint.coverage && endpoint.coverage.url || endpoint.key || '');
}

function isGraphqlEndpoint(endpoint = {}) {
  if (!endpoint) return false;
  if (endpoint.kind === 'graphql') return true;
  if (endpoint.graphqlOperationName || endpoint.operationName || firstValue(endpoint.operationNames)) return true;
  const path = endpointPath(endpoint).toLowerCase();
  if (/\/graphql(?:[/?#]|$)/.test(path)) return true;
  const text = `${endpoint.query || ''} ${endpoint.body || ''} ${endpoint.postData || ''}`.toLowerCase();
  return /\b(query|mutation|subscription)\b/.test(text) && /\{/.test(text);
}

function isStaticEndpoint(endpoint = {}) {
  const resourceType = String(endpoint.resourceType || '').toLowerCase();
  if (['stylesheet', 'script', 'image', 'font', 'media', 'manifest'].includes(resourceType)) return true;
  return isStaticAssetPath(endpointPath(endpoint));
}

function isStaticAssetPath(pathValue) {
  const path = String(pathValue || '').toLowerCase();
  if (!path) return false;
  if (/\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|bmp|avif|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot)(?:[?#]|$)/.test(path)) {
    return true;
  }
  return /\/(?:assets|static|images|img|fonts|_next\/static|vite|webpack)\//.test(path);
}

function isApiLikePath(pathValue) {
  const path = String(pathValue || '').toLowerCase();
  return /\/(?:api|apis|graphql|gql|rest|ajax|rpc|bank|user|users|account|accounts|cart|basket|checkout|feedback|login|logout|signin|signup|search|transfer|transaction|transactions|profile|profiles|admin|session|sessions)\b/.test(path);
}

function isBrowserNavigableFindingRoute(routeValue) {
  const route = String(routeValue || '').toLowerCase();
  if (!route) return false;
  if (/#\//.test(route)) return true;
  try {
    const url = new URL(route, 'http://local.invalid');
    return !/^\/(?:api|apis|rest|graphql|gql|socket\.io)(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return !/^\/(?:api|apis|rest|graphql|gql|socket\.io)(?:\/|$)/i.test(route);
  }
}

function stableToken(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
    .replace(/[^a-zA-Z0-9._~/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

function firstValue(value) {
  const values = collectionValues(value);
  return values.length ? values[0] : null;
}

module.exports = {
  compileMissions,
  compileMissionCandidates,
  summarizeMissionCompiler,
  isApplicationEndpoint,
  isGraphqlEndpoint,
  isStaticAssetPath,
  endpointHasExecutableUiPath
};
