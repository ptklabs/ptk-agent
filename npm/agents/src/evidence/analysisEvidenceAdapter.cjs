'use strict';

const { createEvidenceRecord, stableHash } = require('./evidenceModel.cjs');

const ANALYSIS_EVIDENCE_SCHEMA_VERSION = 'ptk-agent-v2-analysis-evidence';

const SOURCE_PRIORITIES = Object.freeze({
  scenario: 700,
  'ptk-analysis': 600,
  sast: 500,
  runtime: 400,
  'code-signal': 300,
  memory: 200,
  link: 100,
  action: 90,
  'route-hint': 80,
  unknown: 10
});

const SOURCE_TAGS = new Set(Object.keys(SOURCE_PRIORITIES));

function adaptAnalysisEvidence(input = {}, options = {}) {
  const state = {
    baseUrl: options.baseUrl || null,
    defaultSourceTag: normalizeSourceTag(options.defaultSourceTag || 'ptk-analysis'),
    routeHints: [],
    endpoints: [],
    graphqlOperations: [],
    hiddenParams: [],
    surfaces: [],
    gadgets: [],
    runtimeSignals: [],
    skipped: [],
    seenObjects: new Set()
  };

  for (const payload of asArray(input)) ingestPayload(payload, state, {
    sourceTag: sourceTagFrom(payload, state.defaultSourceTag)
  });

  const routeHints = dedupeBy(sortByPriority(state.routeHints), route => route.url);
  const endpoints = dedupeBy(state.endpoints, endpoint => endpointKey(endpoint));
  const graphqlOperations = dedupeBy(state.graphqlOperations, operation => graphqlKey(operation));
  const hiddenParams = dedupeBy(state.hiddenParams, param => hiddenParamKey(param));
  const surfaces = dedupeBy(state.surfaces, surface => surface.id || surface.url || JSON.stringify(surface));
  const gadgets = dedupeBy(state.gadgets, gadget => gadget.id || gadget.name || JSON.stringify(gadget));
  const runtimeSignals = dedupeBy(state.runtimeSignals, signal => signal.id || signal.url || signal.path || JSON.stringify(signal));
  const evidenceRecords = [
    ...routeHints.map(routeHint => recordFor('route-hint', 'route', routeHint.url, routeHint.sourceTag, routeHint)),
    ...endpoints.map(endpoint => recordFor('endpoint', 'endpoint', endpointKey(endpoint), endpoint.sourceTag, endpoint)),
    ...graphqlOperations.map(operation => recordFor('graphql-operation', 'endpoint', graphqlKey(operation), operation.sourceTag, operation)),
    ...hiddenParams.map(param => recordFor('hidden-param', 'parameter', hiddenParamKey(param), param.sourceTag, param)),
    ...surfaces.map(surface => recordFor('surface', 'surface', surface.id || surface.url || stableHash(JSON.stringify(surface)), surface.sourceTag, surface)),
    ...gadgets.map(gadget => recordFor('gadget', 'gadget', gadget.id || gadget.name || stableHash(JSON.stringify(gadget)), gadget.sourceTag, gadget)),
    ...runtimeSignals.map(signal => recordFor('runtime-signal', 'runtime', signal.id || signal.url || signal.path || stableHash(JSON.stringify(signal)), signal.sourceTag, signal))
  ];

  return {
    schemaVersion: ANALYSIS_EVIDENCE_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    routeHints,
    endpoints,
    graphqlOperations,
    hiddenParams,
    surfaces,
    gadgets,
    runtimeSignals,
    evidenceRecords,
    counts: {
      routeHints: routeHints.length,
      endpoints: endpoints.length,
      graphqlOperations: graphqlOperations.length,
      hiddenParams: hiddenParams.length,
      surfaces: surfaces.length,
      gadgets: gadgets.length,
      runtimeSignals: runtimeSignals.length,
      evidenceRecords: evidenceRecords.length,
      totalHints: routeHints.length + endpoints.length + graphqlOperations.length + hiddenParams.length
    },
    skipped: state.skipped
  };
}

function seedFrontierFromAnalysisEvidence(frontier, analysisEvidence = {}, config = {}) {
  const routeHints = sortByPriority(analysisEvidence.routeHints || []);
  const summary = {
    schemaVersion: 'ptk-agent-v2-analysis-frontier-seed',
    candidates: routeHints.length,
    added: 0,
    skipped: [],
    routeHints: []
  };
  if (!frontier || typeof frontier.enqueue !== 'function') return summary;

  for (const routeHint of routeHints) {
    if (!routeHint || !routeHint.url) continue;
    const rejectedBefore = Array.isArray(frontier.rejected) ? frontier.rejected.length : 0;
    const added = frontier.enqueue(routeHint.url, {
      depth: 0,
      source: routeHint.sourceTag || routeHint.source || 'ptk-analysis',
      sourceTag: routeHint.sourceTag || routeHint.source || 'ptk-analysis',
      evidenceRefs: routeHint.evidenceRefs || [],
      reason: routeHint.reason || 'analysis-evidence',
      hintKind: routeHint.kind || 'route'
    });
    const record = {
      url: routeHint.url,
      sourceTag: routeHint.sourceTag || routeHint.source || 'ptk-analysis',
      priority: routeHint.priority,
      evidenceRefs: routeHint.evidenceRefs || [],
      added: Boolean(added)
    };
    summary.routeHints.push(record);
    if (added) {
      summary.added += 1;
      continue;
    }
    const rejected = Array.isArray(frontier.rejected) && frontier.rejected.length > rejectedBefore
      ? frontier.rejected[frontier.rejected.length - 1]
      : null;
    summary.skipped.push({
      ...record,
      reason: rejected && rejected.reason || 'duplicate-or-not-enqueued',
      canonicalUrl: rejected && rejected.canonicalUrl || null
    });
  }

  if (config && config._analysisEvidenceSeed !== undefined) {
    try {
      Object.defineProperty(config, '_analysisEvidenceSeed', {
        value: summary,
        enumerable: false,
        configurable: true
      });
    } catch (_) {}
  }
  return summary;
}

function ingestPayload(payload, state, context = {}) {
  if (!payload) return;
  if (typeof payload === 'string') {
    addRouteHint(payload, state, context);
    return;
  }
  if (!isPlainObject(payload) && !Array.isArray(payload)) return;
  if (state.seenObjects.has(payload)) return;
  state.seenObjects.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) ingestPayload(item, state, context);
    return;
  }

  const sourceTag = sourceTagFrom(payload, context.sourceTag || state.defaultSourceTag);
  const nextContext = { ...context, sourceTag };

  ingestExplorer(payload, state, nextContext);
  ingestExplorer(payload.analysis && payload.analysis.explorer, state, { ...nextContext, sourceTag: 'ptk-analysis' });
  ingestExplorer(payload.source && payload.source.analysis && payload.source.analysis.explorer, state, { ...nextContext, sourceTag: 'ptk-analysis' });
  ingestExplorer(payload.source && payload.source.explorer, state, nextContext);
  ingestExplorer(payload.explorer, state, nextContext);
  ingestExplorer(payload.evidence && payload.evidence.analysis && payload.evidence.analysis.explorer, state, { ...nextContext, sourceTag: 'ptk-analysis' });
  ingestExplorer(payload.export && payload.export.analysis && payload.export.analysis.explorer, state, { ...nextContext, sourceTag: 'ptk-analysis' });
  ingestExplorer(payload.crawlerOutputs, state, nextContext);
  ingestExplorer(payload.crawler, state, nextContext);
  ingestExplorer(payload.crawl, state, nextContext);

  for (const finding of collectionValues(payload.findings)) addFindingEntryPoint(finding, state, { ...nextContext, sourceTag: 'ptk-analysis' });
  for (const finding of collectionValues(payload.entryPoints)) addFindingEntryPoint(finding, state, nextContext);
  for (const finding of collectionValues(payload.findingEntryPoints)) addFindingEntryPoint(finding, state, { ...nextContext, sourceTag: 'ptk-analysis' });
}

function ingestExplorer(explorer, state, context = {}) {
  if (!explorer) return;
  if (typeof explorer === 'string') {
    addRouteHint(explorer, state, context);
    return;
  }
  if (Array.isArray(explorer)) {
    for (const item of explorer) ingestExplorer(item, state, context);
    return;
  }
  if (!isPlainObject(explorer)) return;

  for (const value of collectMany(explorer, ['routes', 'routeHints', 'urls', 'paths', 'sitemap', 'hiddenRoutes'])) {
    addRouteHint(value, state, context);
  }
  for (const value of collectMany(explorer, ['entryPoints', 'findingEntryPoints'])) {
    addFindingEntryPoint(value, state, context);
  }
  for (const value of collectMany(explorer, ['endpoints', 'apiEndpoints', 'apis', 'requests'])) {
    addEndpoint(value, state, context);
  }
  for (const value of collectMany(explorer, ['graphql', 'graphqlOperations', 'operations'])) {
    addGraphqlOperation(value, state, context);
  }
  for (const value of collectMany(explorer, ['hiddenParams', 'hiddenParameters', 'params', 'hiddenInputs'])) {
    addHiddenParam(value, state, context);
  }
  for (const value of collectMany(explorer, ['surfaces'])) addSurface(value, state, context);
  for (const value of collectMany(explorer, ['gadgets'])) addGadget(value, state, context);
  for (const value of collectMany(explorer, ['runtimeSignals', 'signals'])) addRuntimeSignal(value, state, { ...context, sourceTag: 'runtime' });

  if (looksLikeRouteHint(explorer)) addRouteHint(explorer, state, context);
  if (looksLikeEndpoint(explorer)) addEndpoint(explorer, state, context);
  if (looksLikeGraphql(explorer)) addGraphqlOperation(explorer, state, context);
  if (looksLikeHiddenParam(explorer)) addHiddenParam(explorer, state, context);
}

function addFindingEntryPoint(value, state, context = {}) {
  if (!value) return;
  if (typeof value === 'string') {
    addRouteHint({ url: value, evidenceRefs: [] }, state, { ...context, sourceTag: context.sourceTag || 'ptk-analysis' });
    return;
  }
  if (!isPlainObject(value)) return;
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs || value.evidenceRef || value.id || value.findingId || value.ruleId);
  const route = firstPresent(value.url, value.href, value.route, value.path, value.entryPoint, value.entrypoint, value.pageUrl, value.requestUrl, value.location && value.location.url);
  if (route) {
    addRouteHint({
      ...value,
      url: route,
      evidenceRefs,
      reason: value.reason || 'finding-entry-point'
    }, state, { ...context, sourceTag: context.sourceTag || 'ptk-analysis' });
  }
  const endpoint = firstPresent(value.endpoint, value.request && value.request.url, value.evidence && value.evidence.url);
  if (endpoint) addEndpoint({ ...value, url: endpoint, evidenceRefs }, state, { ...context, sourceTag: context.sourceTag || 'ptk-analysis' });
}

function addRouteHint(value, state, context = {}) {
  const object = typeof value === 'string' ? { url: value } : value;
  if (!isPlainObject(object)) return;
  const rawUrl = firstPresent(object.url, object.href, object.route, object.path, object.entryPoint, object.entrypoint);
  const url = resolveUrl(rawUrl, state.baseUrl);
  if (!url) {
    state.skipped.push({ kind: 'route', reason: 'missing-or-invalid-url', value: summarizeValue(value) });
    return;
  }
  if (isStaticAssetPath(url)) {
    state.skipped.push({ kind: 'route', url, reason: 'static-asset' });
    return;
  }
  const sourceTag = sourceTagFrom(object, context.sourceTag || state.defaultSourceTag);
  state.routeHints.push({
    kind: 'route',
    url,
    path: routePath(url),
    source: sourceTag,
    sourceTag,
    priority: priorityForSource(sourceTag),
    evidenceRefs: normalizeEvidenceRefs(object.evidenceRefs || object.evidenceRef),
    reason: object.reason || object.sourceReason || 'analysis-evidence',
    rawKind: object.kind || object.type || null
  });
}

function addEndpoint(value, state, context = {}) {
  const object = typeof value === 'string' ? { path: value } : value;
  if (!isPlainObject(object)) return;
  const rawPath = firstPresent(object.url, object.href, object.endpoint, object.path, object.route);
  const resolved = resolveEndpoint(rawPath, state.baseUrl);
  if (!resolved) {
    state.skipped.push({ kind: 'endpoint', reason: 'missing-or-invalid-path', value: summarizeValue(value) });
    return;
  }
  if (isStaticAssetPath(resolved.path || resolved.url)) {
    state.skipped.push({ kind: 'endpoint', path: resolved.path || resolved.url, reason: 'static-asset' });
    return;
  }
  const sourceTag = sourceTagFrom(object, context.sourceTag || state.defaultSourceTag);
  const endpoint = {
    kind: isGraphqlPath(resolved.path || resolved.url) ? 'graphql' : 'endpoint',
    method: String(object.method || object.httpMethod || 'GET').toUpperCase(),
    url: resolved.url,
    path: resolved.path,
    source: sourceTag,
    sourceTag,
    resourceType: object.resourceType || object.type || 'unknown',
    evidenceRefs: normalizeEvidenceRefs(object.evidenceRefs || object.evidenceRef),
    paramNames: collectionValues(object.paramNames || object.params).map(String).filter(Boolean),
    bodyKeys: collectionValues(object.bodyKeys).map(String).filter(Boolean),
    headerNames: collectionValues(object.headerNames).map(String).filter(Boolean)
  };
  if (endpoint.kind === 'graphql') addGraphqlOperation(object, state, { ...context, sourceTag, endpoint });
  state.endpoints.push(endpoint);
}

function addGraphqlOperation(value, state, context = {}) {
  const object = typeof value === 'string' ? { operationName: value } : value;
  if (!isPlainObject(object)) return;
  const endpoint = context.endpoint || resolveEndpoint(firstPresent(object.endpoint, object.url, object.path, '/graphql'), state.baseUrl);
  const sourceTag = sourceTagFrom(object, context.sourceTag || state.defaultSourceTag);
  const names = collectionValues(object.operationNames || object.operations || object.names);
  const operationName = firstPresent(object.graphqlOperationName, object.operationName, object.name, names[0]);
  const operationType = firstPresent(object.operationType, object.type, inferGraphqlOperationType(object.query || object.body || object.document));
  state.graphqlOperations.push({
    kind: 'graphql',
    method: String(object.method || 'POST').toUpperCase(),
    url: endpoint && endpoint.url || null,
    path: endpoint && endpoint.path || '/graphql',
    graphqlOperationName: operationName ? String(operationName) : null,
    operationName: operationName ? String(operationName) : null,
    operationType: operationType ? String(operationType).toLowerCase() : null,
    source: sourceTag,
    sourceTag,
    evidenceRefs: normalizeEvidenceRefs(object.evidenceRefs || object.evidenceRef),
    variableNames: collectionValues(object.variableNames || object.variables).map(variableName).filter(Boolean)
  });
}

function addHiddenParam(value, state, context = {}) {
  if (!value) return;
  if (typeof value === 'string') {
    state.hiddenParams.push({
      kind: 'hidden-param',
      name: value,
      location: 'query',
      endpoint: null,
      source: context.sourceTag || state.defaultSourceTag,
      sourceTag: context.sourceTag || state.defaultSourceTag,
      evidenceRefs: []
    });
    return;
  }
  if (!isPlainObject(value)) return;
  const names = collectionValues(value.names || value.paramNames || value.params || value.keys);
  const singleName = firstPresent(value.name, value.param, value.parameter, value.key);
  const sourceTag = sourceTagFrom(value, context.sourceTag || state.defaultSourceTag);
  const endpoint = normalizeHiddenParamEndpoint(value.endpoint || value.target || value.url || value.path, state.baseUrl);
  for (const rawName of singleName ? [singleName] : names) {
    const name = variableName(rawName);
    if (!name) continue;
    state.hiddenParams.push({
      kind: 'hidden-param',
      name,
      location: value.location || value.in || 'query',
      endpoint,
      source: sourceTag,
      sourceTag,
      evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs || value.evidenceRef),
      valueHint: value.valueHint || value.example || null
    });
  }
}

function addSurface(value, state, context = {}) {
  if (!value) return;
  const object = typeof value === 'string' ? { id: value } : value;
  if (!isPlainObject(object)) return;
  const sourceTag = sourceTagFrom(object, context.sourceTag || state.defaultSourceTag);
  state.surfaces.push({ ...object, source: sourceTag, sourceTag });
}

function addGadget(value, state, context = {}) {
  if (!value) return;
  const object = typeof value === 'string' ? { name: value } : value;
  if (!isPlainObject(object)) return;
  const sourceTag = sourceTagFrom(object, context.sourceTag || state.defaultSourceTag);
  state.gadgets.push({ ...object, source: sourceTag, sourceTag });
}

function addRuntimeSignal(value, state, context = {}) {
  if (!value) return;
  const object = typeof value === 'string' ? { id: value } : value;
  if (!isPlainObject(object)) return;
  const sourceTag = sourceTagFrom(object, context.sourceTag || 'runtime');
  state.runtimeSignals.push({ ...object, source: sourceTag, sourceTag });
  if (looksLikeRouteHint(object)) addRouteHint(object, state, { ...context, sourceTag });
  if (looksLikeEndpoint(object)) addEndpoint(object, state, { ...context, sourceTag });
}

function collectMany(object, keys) {
  const out = [];
  if (!isPlainObject(object)) return out;
  for (const key of keys) out.push(...collectionValues(object[key]));
  return out;
}

function looksLikeRouteHint(value = {}) {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'route' || value.type === 'route' || value.routeKind === 'route') return true;
  return Boolean(value.route || value.pageUrl || value.entryPoint || value.entrypoint || (value.url && !looksLikeEndpoint(value)));
}

function looksLikeEndpoint(value = {}) {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'endpoint' || value.kind === 'graphql') return true;
  const candidate = firstPresent(value.endpoint, value.path, value.url);
  return Boolean(candidate && (/\/(?:api|rest|graphql)(?:[/?#]|$)/i.test(String(candidate)) || value.method || value.httpMethod || value.resourceType));
}

function looksLikeGraphql(value = {}) {
  if (!isPlainObject(value)) return false;
  return value.kind === 'graphql'
    || Boolean(value.graphqlOperationName || value.operationName || value.operationNames)
    || isGraphqlPath(firstPresent(value.endpoint, value.path, value.url));
}

function looksLikeHiddenParam(value = {}) {
  if (!isPlainObject(value)) return false;
  return value.kind === 'hidden-param'
    || Boolean(value.paramNames || value.hiddenParams || value.hiddenParameters)
    || Boolean((value.name || value.param || value.parameter) && (value.location || value.in));
}

function resolveUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return new URL(value, baseUrl || undefined).href;
  } catch (_) {
    return null;
  }
}

function resolveEndpoint(value, baseUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value, baseUrl || undefined);
    return {
      url: url.href,
      path: `${url.pathname}${url.search || ''}`
    };
  } catch (_) {
    if (/^\//.test(value)) return { url: baseUrl ? resolveUrl(value, baseUrl) : null, path: value };
    return null;
  }
}

function normalizeHiddenParamEndpoint(value, baseUrl) {
  if (!value) return null;
  if (typeof value === 'string') return resolveEndpoint(value, baseUrl) || { path: value };
  if (!isPlainObject(value)) return null;
  const resolved = resolveEndpoint(firstPresent(value.url, value.endpoint, value.path, value.route), baseUrl);
  return {
    ...value,
    url: resolved && resolved.url || value.url || null,
    path: resolved && resolved.path || value.path || null
  };
}

function sourceTagFrom(value, fallback = 'ptk-analysis') {
  const raw = isPlainObject(value)
    ? firstPresent(value.sourceTag, value.source, value.engine, value.type, value.kind)
    : null;
  const text = String(raw || fallback || 'unknown').toLowerCase();
  if (SOURCE_TAGS.has(text)) return text;
  if (/scenario/.test(text)) return 'scenario';
  if (/sast|static/.test(text)) return 'sast';
  if (/runtime|xhr|fetch|request|response|iast/.test(text)) return 'runtime';
  if (/code/.test(text)) return 'code-signal';
  if (/memory/.test(text)) return 'memory';
  if (/link|anchor/.test(text)) return 'link';
  if (/action|click|button/.test(text)) return 'action';
  if (/ptk|analysis|dast|finding|entry/.test(text)) return 'ptk-analysis';
  return normalizeSourceTag(fallback);
}

function normalizeSourceTag(value) {
  const text = String(value || 'unknown').toLowerCase();
  return SOURCE_TAGS.has(text) ? text : 'unknown';
}

function priorityForSource(sourceTag) {
  return SOURCE_PRIORITIES[sourceTag] || SOURCE_PRIORITIES.unknown;
}

function sortByPriority(values = []) {
  return values.slice().sort((left, right) => {
    const priorityDelta = Number(right.priority || 0) - Number(left.priority || 0);
    if (priorityDelta) return priorityDelta;
    return String(left.url || left.path || '').localeCompare(String(right.url || right.path || ''));
  });
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return Array.from(value.values());
  if (isPlainObject(value)) return Object.values(value);
  return [value];
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function normalizeEvidenceRefs(value) {
  return collectionValues(value).map(ref => {
    if (typeof ref === 'string' || typeof ref === 'number') return String(ref);
    if (isPlainObject(ref)) return firstPresent(ref.id, ref.ref, ref.evidenceId, ref.findingId) || stableHash(JSON.stringify(ref));
    return null;
  }).filter(Boolean);
}

function routePath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`;
  } catch (_) {
    return url;
  }
}

function endpointKey(endpoint = {}) {
  return [
    String(endpoint.method || 'GET').toUpperCase(),
    endpoint.path || endpoint.url || '',
    endpoint.graphqlOperationName || endpoint.operationName || ''
  ].filter(Boolean).join(' ');
}

function graphqlKey(operation = {}) {
  return [
    operation.path || operation.url || '/graphql',
    operation.operationType || '',
    operation.graphqlOperationName || operation.operationName || ''
  ].filter(Boolean).join(' ');
}

function hiddenParamKey(param = {}) {
  const endpoint = param.endpoint || {};
  return [
    param.location || 'query',
    param.name || '',
    endpoint.path || endpoint.url || ''
  ].join(':');
}

function recordFor(kind, subjectType, subjectId, sourceTag, data) {
  return createEvidenceRecord({
    kind,
    source: sourceTag || 'ptk-analysis',
    subject: {
      type: subjectType,
      id: subjectId || 'unknown'
    },
    data
  });
}

function isGraphqlPath(value) {
  return /\/graphql(?:[/?#]|$)/i.test(String(value || ''));
}

function inferGraphqlOperationType(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/\b(query|mutation|subscription)\b/);
  return match ? match[1] : null;
}

function variableName(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isPlainObject(value)) return firstPresent(value.name, value.key, value.variable, value.param);
  return null;
}

function isStaticAssetPath(value) {
  const text = String(value || '').split(/[?#]/)[0].toLowerCase();
  return /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|pdf|zip|gz|br)$/i.test(text);
}

function summarizeValue(value) {
  if (typeof value === 'string') return value.slice(0, 160);
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch (_) {
    return String(value).slice(0, 160);
  }
}

module.exports = {
  ANALYSIS_EVIDENCE_SCHEMA_VERSION,
  SOURCE_PRIORITIES,
  adaptAnalysisEvidence,
  seedFrontierFromAnalysisEvidence,
  sourceTagFrom,
  priorityForSource
};
