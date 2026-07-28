'use strict';

const SENSITIVE_KEY = /password|pass|secret|token|authorization|cookie|session|api[_-]?key/i;

function stableHash(value) {
  const input = Array.isArray(value) ? value.join('|') : String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function redactSensitiveValue(value, key) {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(entry => redactSensitiveValue(entry));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redactSensitiveValue(childValue, childKey);
    return output;
  }
  return value;
}

function createEvidenceId(record) {
  return `evidence:${stableHash([
    record.kind,
    record.source,
    record.subject && record.subject.type,
    record.subject && record.subject.id,
    JSON.stringify(record.data || {})
  ])}`;
}

function createEvidenceRecord(input = {}) {
  const record = {
    id: input.id || null,
    kind: input.kind || 'observation',
    source: input.source || 'ptk-agents-v2',
    subject: input.subject || { type: 'unknown', id: 'unknown' },
    data: redactSensitiveValue(input.data || {}),
    severity: input.severity || null,
    confidence: input.confidence || null,
    observedAt: input.observedAt || new Date().toISOString()
  };
  record.id = record.id || createEvidenceId(record);
  return record;
}

function mergeEvidenceRecords(records) {
  const byId = new Map();
  for (const record of records || []) {
    const normalized = createEvidenceRecord(record);
    byId.set(normalized.id, { ...(byId.get(normalized.id) || {}), ...normalized });
  }
  return Array.from(byId.values());
}

function createGraphNode(type, id, data = {}) {
  return { id: `${type}:${id}`, type, key: String(id), data: redactSensitiveValue(data) };
}

function createGraphEdge(type, from, to, data = {}) {
  return { id: `edge:${stableHash([type, from, to, JSON.stringify(data)])}`, type, from, to, data: redactSensitiveValue(data) };
}

function normalizeEndpoint(event = {}) {
  let path = event.path || event.url || '';
  try {
    const parsed = new URL(path);
    path = `${parsed.pathname}${parsed.search}`;
  } catch (_) {}
  return {
    method: event.method || null,
    path,
    status: event.status || null,
    resourceType: event.resourceType || null,
    graphqlOperationName: event.graphqlOperationName || null
  };
}

module.exports = {
  SENSITIVE_KEY,
  stableHash,
  redactSensitiveValue,
  normalizeEndpoint,
  createEvidenceId,
  createEvidenceRecord,
  mergeEvidenceRecords,
  createGraphNode,
  createGraphEdge
};
