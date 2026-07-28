'use strict';

const { stableHash } = require('../browser/actionModel.cjs');

const FINAL_STATUSES = new Set([
  'visited',
  'terminal-document',
  'blocked',
  'failed',
  'timeout',
  'no-action-surfaces',
  'no-progress'
]);

const SENSITIVE_TEXT_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|cvv|card\s*number|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^:=\s"'{}]{0,40}\s*[:=]\s*["']?([^"',\s}]+)/gi;

function nowIso() {
  return new Date().toISOString();
}

function boundedString(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function redactSecretLikeText(value) {
  if (value === null || value === undefined) return value;
  return redactSensitiveUrl(boundedString(value, 800))
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s"'<>:@]+:[^\/\s"'<>@]+@/g, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-api-key]')
    .replace(SENSITIVE_TEXT_RE, match => {
      const key = match.split(/[:=]/)[0] || 'secret';
      return `${key.trim()}=[redacted]`;
    });
}

function sanitize(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecretLikeText(redactSensitiveUrl(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return boundedString(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(body|html|dom|raw|content|text|value|cookie|authorization|password|token|secret|cvv|card)$/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function redactSensitiveUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.username || parsed.password) {
      parsed.username = '[redacted]';
      parsed.password = '';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|cvv|card|username|email|login|user|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.href;
  } catch (_) {
    return String(value)
      .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s"'<>:@]+:[^\/\s"'<>@]+@/g, '$1[redacted]@')
      .replace(/([?&](?:username|email|login|user|password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|cvv|card|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^=]*=)[^&\s"']+/gi, '$1[redacted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
      .replace(/\b[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
  }
}

function routeKey(routeOrUrl) {
  if (!routeOrUrl) return null;
  if (typeof routeOrUrl === 'string') return routeOrUrl;
  return routeOrUrl.url || routeOrUrl.href || null;
}

function createRouteLifecycleRecorder(options = {}) {
  const events = [];
  const finalized = new Map();
  const warnings = [];
  const maxEvents = Number(options.maxEvents) > 0 ? Number(options.maxEvents) : 10000;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  function emit(type, data = {}) {
    if (events.length >= maxEvents) return null;
    const event = sanitize({
      type,
      ts: nowIso(),
      ...data
    });
    events.push(event);
    if (onEvent) {
      try {
        onEvent(event);
      } catch (_) {}
    }
    return event;
  }

  function finalize(route, status, data = {}) {
    const key = routeKey(route);
    const normalizedStatus = FINAL_STATUSES.has(status) ? status : 'failed';
    if (!key) return null;
    if (finalized.has(key)) {
      const previous = finalized.get(key);
      const warning = emit('route_finalize_warning', {
        routeKey: key,
        routeUrl: key,
        attemptedStatus: normalizedStatus,
        existingStatus: previous.status,
        finalizeAttemptIgnored: true
      });
      warnings.push(warning);
      return { ok: false, warning, previous };
    }
    const record = sanitize({
      routeKey: key,
      routeUrl: key,
      status: normalizedStatus,
      finalizedAt: nowIso(),
      durationMs: data.durationMs || 0,
      routeShape: data.routeShape || route.routeShape || null,
      source: route.source || route.sourceTag || null,
      sourceTag: route.sourceTag || route.source || null,
      depth: route.depth || 0,
      reason: data.reason || null,
      terminalDocument: data.terminalDocument || null,
      forms: data.forms || null,
      actions: data.actions || null
    });
    finalized.set(key, record);
    emit('route_finalized', record);
    return { ok: true, record };
  }

  function snapshot() {
    return {
      schemaVersion: 'ptk-agent-v2-route-lifecycle',
      generatedAt: nowIso(),
      eventCount: events.length,
      finalizedCount: finalized.size,
      warningCount: warnings.length,
      events: events.slice(),
      finalizedRoutes: Array.from(finalized.values()),
      warnings: warnings.filter(Boolean)
    };
  }

  function statusSummary() {
    const statuses = {};
    const routes = [];
    for (const record of finalized.values()) {
      statuses[record.status] = (statuses[record.status] || 0) + 1;
      routes.push(record);
    }
    return {
      schemaVersion: 'ptk-agent-v2-route-status-summary',
      generatedAt: nowIso(),
      totalRoutesFinalized: routes.length,
      statuses,
      routes,
      duplicateFinalizeWarnings: warnings.filter(Boolean).length
    };
  }

  function terminalDocumentSummary() {
    const terminalDocuments = Array.from(finalized.values())
      .filter(record => record.status === 'terminal-document')
      .map(record => ({
        routeUrl: record.routeUrl,
        routeShape: record.routeShape || null,
        source: record.source || null,
        terminalDocument: record.terminalDocument || null,
        finalizedAt: record.finalizedAt
      }));
    return {
      schemaVersion: 'ptk-agent-v2-terminal-document-summary',
      generatedAt: nowIso(),
      total: terminalDocuments.length,
      terminalDocuments
    };
  }

  return {
    emit,
    finalize,
    snapshot,
    statusSummary,
    terminalDocumentSummary,
    events,
    finalized,
    warnings
  };
}

function createDocumentHash(value) {
  return stableHash(String(value || ''));
}

module.exports = {
  FINAL_STATUSES,
  createDocumentHash,
  createRouteLifecycleRecorder,
  redactSecretLikeText,
  redactSensitiveUrl,
  routeKey,
  sanitize
};
