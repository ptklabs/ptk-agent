'use strict';

const { createEvidenceRecord, stableHash } = require('./evidenceModel.cjs');
const { createEndpointGraph } = require('./endpointGraph.cjs');
const { createRouteGraph } = require('./routeGraph.cjs');
const { createEntityGraph } = require('./entityGraph.cjs');
const { writeJson } = require('../core/artifacts.cjs');

const PTK_FINDINGS_COUNT_ARTIFACT = 'ptk-findings-count.json';
const PTK_FINDINGS_COUNT_SCHEMA_VERSION = 'ptk-agent-v2-findings-count';
const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|jwt|bearer)/i;
const FINDING_ARRAY_KEYS = Object.freeze([
  'findings',
  'alerts',
  'issues',
  'results',
  'vulnerabilities',
  'items',
  'entryPoints',
  'findingEntryPoints'
]);
const ENDPOINT_ARRAY_KEYS = Object.freeze(['endpoints', 'requests', 'urls']);
const ENGINE_KEYS = Object.freeze(['DAST', 'IAST', 'SAST', 'SCA', 'dast', 'iast', 'sast', 'sca']);

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

function firstString(...values) {
  const value = firstPresent(...values);
  return value === null ? null : String(value);
}

function compact(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function redactSecretString(value) {
  return String(value)
    .replace(/((?:authorization|auth[_-]?header)=)(?:Bearer|Basic)\s+[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|jwt)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');
}

function redactPtkSecrets(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key))) return REDACTED;
  if (Array.isArray(value)) return value.map(item => redactPtkSecrets(item));
  if (isPlainObject(value)) {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redactPtkSecrets(childValue, childKey);
    return output;
  }
  if (typeof value === 'string') return redactSecretString(value);
  return value;
}

function normalizeSeverity(value) {
  const severity = compact(value, 40).toLowerCase();
  if (!severity) return 'unknown';
  if (/crit/.test(severity)) return 'critical';
  if (/high/.test(severity)) return 'high';
  if (/med|moderate/.test(severity)) return 'medium';
  if (/low/.test(severity)) return 'low';
  if (/info|note|debug/.test(severity)) return 'info';
  return severity;
}

function normalizeConfidence(value) {
  const confidence = compact(value, 40).toLowerCase();
  return confidence || null;
}

function normalizeEngine(value, fallback = 'UNKNOWN') {
  const text = compact(value, 80).toUpperCase();
  if (/(^|[^A-Z])IAST([^A-Z]|$)/.test(text)) return 'IAST';
  if (/(^|[^A-Z])SAST([^A-Z]|$)/.test(text)) return 'SAST';
  if (/(^|[^A-Z])SCA([^A-Z]|$)/.test(text)) return 'SCA';
  if (/(^|[^A-Z])DAST([^A-Z]|$)|ACTIVE|PASSIVE/.test(text)) return 'DAST';
  return fallback;
}

function findingUrl(finding = {}) {
  const location = isPlainObject(finding.location) ? finding.location : {};
  const request = isPlainObject(finding.request) ? finding.request : {};
  const evidence = isPlainObject(finding.evidence) ? finding.evidence : {};
  const source = isPlainObject(finding.source) ? finding.source : {};
  const sink = isPlainObject(finding.sink) ? finding.sink : {};
  return firstString(
    finding.url,
    finding.href,
    finding.pageUrl,
    finding.requestUrl,
    finding.endpoint,
    location.url,
    location.runtimeUrl,
    location.route,
    request.url,
    evidence.url,
    evidence.request && evidence.request.url,
    source.url,
    sink.url
  );
}

function findingMethod(finding = {}) {
  const location = isPlainObject(finding.location) ? finding.location : {};
  const request = isPlainObject(finding.request) ? finding.request : {};
  const method = firstString(finding.method, location.method, request.method);
  return method ? method.toUpperCase() : null;
}

function findingParameter(finding = {}) {
  const location = isPlainObject(finding.location) ? finding.location : {};
  const evidence = isPlainObject(finding.evidence) ? finding.evidence : {};
  const dast = isPlainObject(evidence.dast) ? evidence.dast : {};
  return firstString(
    finding.param,
    finding.parameter,
    location.param,
    location.parameter,
    evidence.param,
    evidence.parameter,
    dast.param,
    dast.parameter
  );
}

function looksLikeFinding(item = {}) {
  if (!isPlainObject(item)) return false;
  if (looksLikeScanResultContainer(item)) return false;
  if (item.outputKind && !/finding|alert|issue/i.test(String(item.outputKind))) return false;
  if (item.type && /^dast_(request|response|task|traffic)/i.test(String(item.type))) return false;
  const keys = Object.keys(item);
  const hasRisk = Boolean(item.severity || item.risk || item.level);
  const hasRule = Boolean(item.engine || item.scan || item.scanType || item.ruleId || item.rule || item.vulnId || item.moduleName || item.pluginName || item.cwe);
  const hasTitle = Boolean(item.title || item.name || item.issue || item.message || item.description || item.category);
  const hasEvidence = keys.some(key => /confidence|evidence|finding|sink|source|callsite|attack|proof|payload/i.test(key));
  return (hasRisk && (hasRule || hasTitle || hasEvidence)) || (hasRule && hasEvidence);
}

function looksLikeScanResultContainer(item = {}) {
  const type = String(item.type || '').toLowerCase().replace(/[_\s]+/g, '-');
  if (type === 'scan-result') return true;
  if (!Array.isArray(item.findings)) return false;
  if (!isPlainObject(item.stats)) return false;
  const hasScanMetadata = Boolean(item.scanId || item.startedAt || item.finishedAt || item.settings || item.toolVersion);
  if (!hasScanMetadata) return false;
  const hasFindingIdentity = Boolean(item.ruleId || item.ruleName || item.vulnId || item.findingId || item.moduleId || item.moduleName);
  return !hasFindingIdentity;
}

function collectFromKnownKeys(value, out, seen) {
  for (const key of FINDING_ARRAY_KEYS) {
    if (Array.isArray(value[key])) collectFindings(value[key], out, seen);
  }
  for (const key of ENGINE_KEYS) {
    if (value[key]) collectFindings(value[key], out, seen);
  }
  if (value.scan) collectFindings(value.scan, out, seen);
  if (value.value) collectFindings(value.value, out, seen);
  if (value.evidence) collectFindings(value.evidence, out, seen);
  if (value.export) collectFindings(value.export, out, seen);
  if (value.content) collectFindings(value.content, out, seen);
  if (Array.isArray(value.scans)) collectFindings(value.scans, out, seen);
  return out;
}

function collectFindings(value, out = [], seen = new Set()) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFindings(item, out, seen);
    return out;
  }
  if (!isPlainObject(value)) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (looksLikeFinding(value)) out.push(value);
  return collectFromKnownKeys(value, out, seen);
}

function extractPtkFindings(ptkExport = {}) {
  const byKey = new Map();
  for (const finding of collectFindings(ptkExport)) {
    const redacted = redactPtkSecrets(finding);
    const key = stableHash(JSON.stringify(redacted));
    if (!byKey.has(key)) byKey.set(key, redacted);
  }
  return Array.from(byKey.values());
}

function normalizeFinding(finding = {}) {
  const raw = typeof finding === 'string' ? { title: finding } : redactPtkSecrets(finding);
  const engine = normalizeEngine(firstString(raw.engine, raw.scan, raw.scanType, raw.type, raw.source), 'UNKNOWN');
  const title = compact(firstString(raw.title, raw.name, raw.issue, raw.ruleName, raw.rule, raw.moduleName, raw.pluginName, raw.category, raw.message, raw.description), 180) || 'Finding';
  const severity = normalizeSeverity(firstString(raw.severity, raw.risk, raw.level));
  const confidence = normalizeConfidence(firstString(raw.confidence, raw.certainty));
  const url = findingUrl(raw);
  const method = findingMethod(raw);
  const parameter = findingParameter(raw);
  const ruleId = firstString(raw.ruleId, raw.rule, raw.vulnId, raw.id, raw.findingId, raw.moduleId);
  const cwe = firstString(raw.cwe, raw.cweId);
  const category = firstString(raw.category, raw.family, raw.type);
  const fingerprint = findingFingerprint(raw);
  const id = compact(firstString(raw.id, raw.findingId, raw.vulnId) || fingerprint || stableHash([
    engine,
    title,
    severity,
    confidence,
    url,
    method,
    parameter,
    ruleId
  ]), 120);

  return {
    id,
    fingerprint,
    engine,
    title,
    severity,
    confidence,
    ruleId: ruleId ? compact(ruleId, 120) : null,
    cwe: cwe ? compact(cwe, 40) : null,
    category: category ? compact(category, 120) : null,
    url: url ? compact(url, 1000) : null,
    method,
    parameter: parameter ? compact(parameter, 160) : null,
    raw
  };
}

function findingFingerprint(finding = {}) {
  const raw = typeof finding === 'string' ? { title: finding } : redactPtkSecrets(finding || {});
  const explicit = firstString(raw.fingerprint, raw.dedupeKey, raw.uniqueKey);
  if (explicit) return compact(explicit, 180);
  const engine = normalizeEngine(firstString(raw.engine, raw.scan, raw.scanType, raw.type, raw.source), 'UNKNOWN');
  const ruleId = firstString(raw.ruleId, raw.rule, raw.vulnId, raw.moduleId, raw.pluginId, raw.id, raw.findingId);
  const title = compact(firstString(raw.title, raw.name, raw.issue, raw.ruleName, raw.moduleName, raw.pluginName, raw.category, raw.message, raw.description), 180) || 'Finding';
  const severity = normalizeSeverity(firstString(raw.severity, raw.risk, raw.level));
  const confidence = normalizeConfidence(firstString(raw.confidence, raw.certainty));
  const url = findingUrl(raw);
  const method = findingMethod(raw);
  const parameter = findingParameter(raw);
  const source = isPlainObject(raw.source) ? firstString(raw.source.file, raw.source.url, raw.source.name) : null;
  const sink = isPlainObject(raw.sink) ? firstString(raw.sink.file, raw.sink.url, raw.sink.name) : null;
  return stableHash(JSON.stringify([
    engine,
    ruleId,
    title,
    severity,
    confidence,
    url,
    method,
    parameter,
    source,
    sink
  ]));
}

function adaptFinding(finding = {}) {
  const normalized = normalizeFinding(finding);
  return createEvidenceRecord({
    kind: 'finding',
    source: 'ptk-export',
    subject: {
      type: normalized.url ? 'endpoint' : 'route',
      id: normalized.url || normalized.id || 'unknown'
    },
    severity: normalized.severity === 'unknown' ? null : normalized.severity,
    confidence: normalized.confidence,
    data: normalized
  });
}

function adaptEndpoint(endpoint = {}) {
  const safeEndpoint = redactPtkSecrets(endpoint);
  return createEvidenceRecord({
    kind: 'endpoint',
    source: 'ptk-export',
    subject: {
      type: 'endpoint',
      id: `${safeEndpoint.method || 'GET'} ${safeEndpoint.url || safeEndpoint.endpoint || safeEndpoint.path || ''}`
    },
    data: safeEndpoint
  });
}

function collectEndpoints(ptkExport = {}) {
  const endpoints = [];
  for (const key of ENDPOINT_ARRAY_KEYS) endpoints.push(...asArray(ptkExport[key]));
  if (ptkExport.evidence && isPlainObject(ptkExport.evidence)) endpoints.push(...collectEndpoints(ptkExport.evidence));
  if (ptkExport.value && isPlainObject(ptkExport.value)) endpoints.push(...collectEndpoints(ptkExport.value));
  if (ptkExport.export && isPlainObject(ptkExport.export)) endpoints.push(...collectEndpoints(ptkExport.export));
  if (ptkExport.content && isPlainObject(ptkExport.content)) endpoints.push(...collectEndpoints(ptkExport.content));
  if (Array.isArray(ptkExport.scans)) {
    for (const scan of ptkExport.scans) {
      if (scan && isPlainObject(scan.content)) endpoints.push(...collectEndpoints(scan.content));
    }
  }
  return endpoints.filter(endpoint => endpoint && (typeof endpoint === 'string' || isPlainObject(endpoint)));
}

function normalizeEndpoint(endpoint = {}) {
  if (typeof endpoint === 'string') {
    return { method: 'GET', url: redactSecretString(endpoint) };
  }
  const safeEndpoint = redactPtkSecrets(endpoint);
  return {
    ...safeEndpoint,
    method: safeEndpoint.method || 'GET',
    url: safeEndpoint.url || safeEndpoint.endpoint || safeEndpoint.href || safeEndpoint.path || ''
  };
}

function adaptPtkEvidence(ptkExport = {}) {
  const rawFindings = extractPtkFindings(ptkExport);
  const findings = rawFindings.map(adaptFinding);
  const endpoints = collectEndpoints(ptkExport).map(normalizeEndpoint).map(adaptEndpoint);
  return { records: [...findings, ...endpoints], counts: { findings: findings.length, endpoints: endpoints.length } };
}

function summarizeFindings(input = []) {
  const rawFindings = Array.isArray(input) ? input : extractPtkFindings(input);
  const findings = rawFindings.map(normalizeFinding);
  const bySeverity = {};
  const byEngine = {};
  for (const finding of findings) {
    const severity = finding.severity || 'unknown';
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    const engine = finding.engine || 'UNKNOWN';
    byEngine[engine] = (byEngine[engine] || 0) + 1;
  }
  return {
    count: findings.length,
    findingsCount: findings.length,
    bySeverity,
    byEngine,
    truncated: Boolean(input && !Array.isArray(input) && (input.truncated === true || input.truncatedAny === true)),
    samples: findings.slice(0, 20).map(finding => ({
      id: finding.id,
      engine: finding.engine,
      title: finding.title,
      severity: finding.severity,
      url: finding.url,
      method: finding.method,
      parameter: finding.parameter
    }))
  };
}

function createFindingsCountArtifact(input = {}, options = {}) {
  const ptkExport = input.ptkExport || input.evidence || input;
  const summary = summarizeFindings(ptkExport);
  const exportValue = input.export || input.exportResult || ptkExport.export || null;
  const scans = exportValue && Array.isArray(exportValue.scans) ? exportValue.scans : [];
  return {
    schemaVersion: PTK_FINDINGS_COUNT_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: options.source || input.source || 'ptk',
    findingsCount: summary.count,
    bySeverity: summary.bySeverity,
    byEngine: summary.byEngine,
    truncated: summary.truncated,
    samples: summary.samples,
    bridge: input.bridge ? redactPtkSecrets(input.bridge) : null,
    status: input.status ? redactPtkSecrets(input.status) : ptkExport.status ? redactPtkSecrets(ptkExport.status) : null,
    export: exportValue ? redactPtkSecrets({
      exported: input.exported === true || Boolean(exportValue),
      mode: exportValue.mode || exportValue.exportMode || null,
      scanCount: scans.length,
      truncatedAny: exportValue.truncatedAny === true,
      warnings: Array.isArray(exportValue.warnings) ? exportValue.warnings : []
    }) : null
  };
}

function writeFindingsCountArtifact(outputDirOrWriter, input = {}, options = {}) {
  const artifact = createFindingsCountArtifact(input, options);
  const name = options.name || PTK_FINDINGS_COUNT_ARTIFACT;
  const filePath = outputDirOrWriter && typeof outputDirOrWriter.writeJson === 'function'
    ? outputDirOrWriter.writeJson(name, artifact)
    : writeJson(outputDirOrWriter, name, artifact);
  return { filePath, artifact };
}

function applyFindingsCountToTelemetry(telemetry, input = {}) {
  const summary = summarizeFindings(input.ptkExport || input.evidence || input);
  if (telemetry && typeof telemetry.setFindingsCount === 'function') {
    telemetry.setFindingsCount(summary.count);
  } else if (telemetry && telemetry.counters && typeof telemetry.counters === 'object') {
    telemetry.counters.findings = summary.count;
  }
  return summary.count;
}

function buildEvidenceGraphs(input = {}) {
  const coverage = input.coverage || {};
  const ptk = adaptPtkEvidence(input.ptkExport);
  const endpointGraph = createEndpointGraph();
  const routeGraph = createRouteGraph();
  const entityGraph = createEntityGraph();
  for (const route of coverage.routes || []) {
    routeGraph.recordRoute(route);
    entityGraph.ingestPageModel(route.pageModel || route.model || {
      url: route.url,
      routeShape: route.routeShape,
      surfaceType: route.surfaceType,
      forms: [],
      actions: []
    });
  }
  for (const endpoint of coverage.endpoints || []) endpointGraph.linkRouteToEndpoint(endpoint.routeUrl, endpoint, { observedAt: endpoint.observedAt });
  for (const transition of coverage.transitions || coverage.edges || []) {
    if (transition.fromUrl && transition.toUrl) routeGraph.recordTransition(transition.fromUrl, transition.toUrl, transition);
  }
  return {
    evidenceRecords: ptk.records,
    counts: ptk.counts,
    endpointGraph: endpointGraph.toJSON(),
    routeGraph: routeGraph.toJSON(),
    entityGraph: entityGraph.toJSON()
  };
}

module.exports = {
  PTK_FINDINGS_COUNT_ARTIFACT,
  PTK_FINDINGS_COUNT_SCHEMA_VERSION,
  redactPtkSecrets,
  extractPtkFindings,
  normalizeFinding,
  findingFingerprint,
  adaptFinding,
  adaptEndpoint,
  adaptPtkEvidence,
  applyFindingsCountToTelemetry,
  buildEvidenceGraphs,
  createFindingsCountArtifact,
  writeFindingsCountArtifact,
  summarizeFindings
};
