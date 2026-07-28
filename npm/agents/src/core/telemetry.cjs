'use strict';

const crypto = require('crypto');

const TELEMETRY_SCHEMA_VERSION = 'ptk-agent-v2-telemetry';
const SECRET_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session)/i;

const TIMING_FIELDS = Object.freeze({
  navigation: 'navigationMs',
  observation: 'observationMs',
  action: 'actionMs',
  wait: 'waitMs',
  blocked: 'blockedMs'
});

function nowIso() {
  return new Date().toISOString();
}

function newRunId(prefix = 'ptk-v2') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactTelemetryValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactTelemetryValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactTelemetryValue(item);
  }
  return output;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

class RunTelemetry {
  constructor({
    requestedMode = 'crawl',
    actualMode = 'crawl',
    runId = null,
    now = Date.now,
    startMs = null
  } = {}) {
    this._now = now;
    this.runId = runId || newRunId();
    this.startedAtMs = Number.isFinite(startMs) ? startMs : this._now();
    this.startTime = isoFromMs(this.startedAtMs);
    this.endTime = null;
    this.durationMs = 0;
    this.mode = {
      requested: requestedMode,
      actual: actualMode,
      fallback: null,
      fallbackReason: null
    };
    this.counters = {
      routesVisited: 0,
      routeShapes: 0,
      endpointsObserved: 0,
      formsDiscovered: 0,
      actionsDiscovered: 0,
      scenarioStepsCompleted: 0,
      actionsAttempted: 0,
      actionsChangedState: 0,
      actionsDidNothing: 0,
      actionsNoProgress: 0,
      findings: 0,
      errors: 0
    };
    this.timing = {
      navigationMs: 0,
      observationMs: 0,
      actionMs: 0,
      waitMs: 0,
      blockedMs: 0,
      totalMs: 0
    };
    this.routes = [];
    this.routeShapeSet = new Set();
    this.endpointSet = new Set();
    this.forms = [];
    this.actions = [];
    this.errors = [];
    this.events = [];
  }

  setMode(update = {}) {
    if (update.requestedMode !== undefined) this.mode.requested = update.requestedMode;
    if (update.actualMode !== undefined) this.mode.actual = update.actualMode;
    if (update.fallbackMode !== undefined) this.mode.fallback = update.fallbackMode;
    if (update.fallbackReason !== undefined) this.mode.fallbackReason = update.fallbackReason;
    if (update.requested !== undefined) this.mode.requested = update.requested;
    if (update.actual !== undefined) this.mode.actual = update.actual;
    if (update.fallback !== undefined) this.mode.fallback = update.fallback;
    this.event('mode', {
      requestedMode: this.mode.requested,
      actualMode: this.mode.actual,
      fallbackMode: this.mode.fallback,
      fallbackReason: this.mode.fallbackReason
    });
  }

  inc(name, amount = 1) {
    this.counters[name] = (this.counters[name] || 0) + amount;
  }

  addTiming(name, ms) {
    const field = TIMING_FIELDS[name] || name;
    if (!Object.prototype.hasOwnProperty.call(this.timing, field)) {
      throw new Error(`Unsupported telemetry timing field: ${name}`);
    }
    this.timing[field] += nonNegativeNumber(ms);
  }

  recordTiming(kind, ms) {
    this.addTiming(kind, ms);
    this.event('timing', { kind, milliseconds: nonNegativeNumber(ms) });
  }

  event(type, data = {}) {
    const entry = {
      runId: this.runId,
      ts: isoFromMs(this._now()),
      time: isoFromMs(this._now()),
      type,
      data: redactTelemetryValue(data)
    };
    this.events.push(entry);
    return entry;
  }

  recordRoute(route = {}) {
    const record = redactTelemetryValue({
      url: route.url || route.href || null,
      routeShape: route.routeShape || route.shape || null,
      status: route.status || null
    });
    this.routes.push(record);
    this.counters.routesVisited += 1;
    if (record.routeShape && !this.routeShapeSet.has(record.routeShape)) {
      this.routeShapeSet.add(record.routeShape);
      this.counters.routeShapes = this.routeShapeSet.size;
    }
    this.event('route', record);
    return record;
  }

  recordRouteShape(shape) {
    if (!shape) {
      return;
    }
    this.routeShapeSet.add(String(shape));
    this.counters.routeShapes = this.routeShapeSet.size;
    this.event('route-shape', { routeShape: String(shape) });
  }

  recordEndpoint(endpoint = {}) {
    const record = typeof endpoint === 'string' ? { endpoint } : redactTelemetryValue(endpoint);
    const key = record.endpoint || record.url || record.href || JSON.stringify(record);
    this.endpointSet.add(key);
    this.counters.endpointsObserved = this.endpointSet.size;
    this.event('endpoint', record);
    return record;
  }

  recordForm(form = {}) {
    const record = redactTelemetryValue(form);
    this.forms.push(record);
    this.counters.formsDiscovered = this.forms.length;
    this.event('form', record);
    return record;
  }

  recordActionDiscovered(action = {}) {
    const record = redactTelemetryValue(action);
    this.actions.push(record);
    this.counters.actionsDiscovered = this.actions.length;
    this.event('action-discovered', record);
    return record;
  }

  recordActionAttempt(result = {}) {
    this.counters.actionsAttempted += 1;
    if (result.changedState) this.counters.actionsChangedState += 1;
    if (result.didNothing) this.counters.actionsDidNothing += 1;
    if (result.noProgress) this.counters.actionsNoProgress += 1;
    this.event('action-attempt', result);
  }

  recordScenarioStep(step = {}) {
    this.counters.scenarioStepsCompleted += 1;
    this.event('scenario-step', step);
  }

  setFindingsCount(count) {
    this.counters.findings = nonNegativeNumber(count);
    this.event('findings-count', { findingsCount: this.counters.findings });
  }

  error(err, context = {}) {
    const entry = redactTelemetryValue({
      ts: isoFromMs(this._now()),
      name: err && err.name ? err.name : 'Error',
      message: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
      context
    });
    this.errors.push(entry);
    this.counters.errors = this.errors.length;
    this.event('error', entry);
    return entry;
  }

  recordError(err, context = {}) {
    return this.error(err, context);
  }

  finish(endMs = null) {
    if (this.endTime === null) {
      const endedAtMs = Number.isFinite(endMs) ? endMs : this._now();
      this.endTime = isoFromMs(endedAtMs);
      this.durationMs = Math.max(0, endedAtMs - this.startedAtMs);
      this.timing.totalMs = this.durationMs;
      this.event('run-finished', { totalDurationMs: this.durationMs });
    }
    return this.snapshot();
  }

  snapshot() {
    return this.toSummary();
  }

  toSummary() {
    const durationMs = this.endTime === null
      ? Math.max(0, this._now() - this.startedAtMs)
      : this.durationMs;
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      runId: this.runId,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs,
      totalDurationMs: durationMs,
      mode: clone(this.mode),
      requestedMode: this.mode.requested,
      actualMode: this.mode.actual,
      fallbackMode: this.mode.fallback,
      fallbackReason: this.mode.fallbackReason,
      counters: clone(this.counters),
      routeCount: this.counters.routesVisited,
      routeShapeCount: this.counters.routeShapes,
      endpointCount: this.counters.endpointsObserved,
      formCount: this.counters.formsDiscovered,
      actionCount: this.counters.actionsDiscovered,
      scenarioStepsCompleted: this.counters.scenarioStepsCompleted,
      actionsAttempted: this.counters.actionsAttempted,
      actionsChangedState: this.counters.actionsChangedState,
      actionsDidNothing: this.counters.actionsDidNothing,
      noProgressActionCount: this.counters.actionsNoProgress,
      timing: clone(this.timing),
      navigationTimeMs: this.timing.navigationMs,
      observationTimeMs: this.timing.observationMs,
      actionTimeMs: this.timing.actionMs,
      waitTimeMs: this.timing.waitMs,
      blockedTimeMs: this.timing.blockedMs,
      errorCount: this.errors.length,
      findingsCount: this.counters.findings,
      routes: clone(this.routes),
      routeShapes: [...this.routeShapeSet],
      endpoints: [...this.endpointSet],
      errors: clone(this.errors)
    };
  }

  toTiming() {
    const summary = this.toSummary();
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      runId: this.runId,
      startTime: summary.startTime,
      endTime: summary.endTime,
      totalDurationMs: summary.totalDurationMs,
      navigationTimeMs: summary.navigationTimeMs,
      observationTimeMs: summary.observationTimeMs,
      actionTimeMs: summary.actionTimeMs,
      waitTimeMs: summary.waitTimeMs,
      blockedTimeMs: summary.blockedTimeMs,
      timing: clone(this.timing)
    };
  }

  toEvents() {
    return clone(this.events);
  }
}

async function timeAsync(telemetry, timingName, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    telemetry.addTiming(timingName, Date.now() - started);
  }
}

function createTelemetryRun(options = {}) {
  return new RunTelemetry(options);
}

function countValue(value) {
  if (Array.isArray(value)) return value.length;
  return nonNegativeNumber(value);
}

function normalizeTelemetrySummary(input = {}) {
  const summary = isPlainObject(input.summary) ? input.summary : input;
  const counters = summary.counters || {};
  const timing = summary.timing || {};
  return {
    runId: summary.runId || null,
    totalDurationMs: nonNegativeNumber(summary.totalDurationMs || summary.durationMs || timing.totalMs),
    requestedMode: summary.requestedMode || (summary.mode && summary.mode.requested) || null,
    actualMode: summary.actualMode || (summary.mode && summary.mode.actual) || null,
    fallbackMode: summary.fallbackMode || (summary.mode && summary.mode.fallback) || null,
    fallbackReason: summary.fallbackReason || (summary.mode && summary.mode.fallbackReason) || null,
    routeCount: countValue(summary.routeCount ?? counters.routesVisited ?? summary.routes),
    routeShapeCount: countValue(summary.routeShapeCount ?? counters.routeShapes ?? summary.routeShapes),
    endpointCount: countValue(summary.endpointCount ?? counters.endpointsObserved ?? summary.endpoints),
    formCount: countValue(summary.formCount ?? counters.formsDiscovered ?? summary.forms),
    actionCount: countValue(summary.actionCount ?? counters.actionsDiscovered ?? summary.actions),
    scenarioStepsCompleted: nonNegativeNumber(summary.scenarioStepsCompleted ?? counters.scenarioStepsCompleted),
    actionsAttempted: nonNegativeNumber(summary.actionsAttempted ?? counters.actionsAttempted),
    actionsChangedState: nonNegativeNumber(summary.actionsChangedState ?? counters.actionsChangedState),
    actionsDidNothing: nonNegativeNumber(summary.actionsDidNothing ?? counters.actionsDidNothing),
    noProgressActionCount: nonNegativeNumber(summary.noProgressActionCount ?? counters.actionsNoProgress ?? counters.noProgressActions),
    navigationTimeMs: nonNegativeNumber(summary.navigationTimeMs ?? timing.navigationMs),
    observationTimeMs: nonNegativeNumber(summary.observationTimeMs ?? timing.observationMs),
    actionTimeMs: nonNegativeNumber(summary.actionTimeMs ?? timing.actionMs),
    waitTimeMs: nonNegativeNumber(summary.waitTimeMs ?? timing.waitMs),
    blockedTimeMs: nonNegativeNumber(summary.blockedTimeMs ?? timing.blockedMs),
    errorCount: nonNegativeNumber(summary.errorCount ?? counters.errors ?? (Array.isArray(summary.errors) ? summary.errors.length : 0)),
    findingsCount: summary.findingsCount === null ? null : nonNegativeNumber(summary.findingsCount ?? counters.findings)
  };
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  TIMING_FIELDS,
  RunTelemetry,
  createRunId: newRunId,
  createTelemetryRun,
  newRunId,
  normalizeTelemetrySummary,
  nowIso,
  redactTelemetryValue,
  timeAsync
};
