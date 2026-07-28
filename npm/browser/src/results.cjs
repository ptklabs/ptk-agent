'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact.cjs');

const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low', 'info'];
const DEBUG_ARTIFACT_FILES = [
  'session_start.json',
  'progress_before_stop.json',
  'findings_before_stop.json',
  'stats_before_stop.json',
  'scan_stop.json',
  'progress_after_stop.json',
  'findings_after_stop.json',
  'stats_after_stop.json',
  'export.json',
  'ptk-result.json'
];

class PtkScanError extends Error {
  constructor(message, result = null, cause = null) {
    super(message);
    this.name = 'PtkScanError';
    this.result = result;
    this.cause = cause || undefined;
  }
}

function countFindings(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload && payload.findings)) return payload.findings.length;
  if (Array.isArray(payload && payload.items)) return payload.items.length;
  if (Array.isArray(payload && payload.data)) return payload.data.length;
  return 0;
}

function normalizeCollectionError(error, code) {
  return {
    ok: false,
    collectionError: {
      message: error && error.message ? error.message : String(error),
      code
    },
    findings: null
  };
}

async function waitForFindings(bridge, sessionId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const pollMs = Number(options.pollMs || 1000);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Date.now();
  let last = null;
  do {
    last = await bridge.getFindings({
      sessionId,
      limit: options.limit || options.findingsLimit || 500,
      strict: options.strict !== false
    });
    if (countFindings(last) > 0 || timeoutMs <= 0) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() <= deadline);
  return last;
}

async function maybeCollect(label, fn, code) {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      label,
      collectionError: {
        message: error && error.message ? error.message : String(error),
        code
      }
    };
  }
}

function shouldCollect(value, field, defaultValue) {
  if (value === true) return true;
  if (value === false) return false;
  if (value && typeof value === 'object' && value[field] === false) return false;
  if (value && typeof value === 'object' && value[field] === true) return true;
  return defaultValue;
}

async function collectPtkResults(pageOrBridge, session, options = {}) {
  const bridge = pageOrBridge && typeof pageOrBridge.call === 'function'
    ? pageOrBridge
    : (options.createBridge || require('./ptkBridge.cjs').createPtkBridge)(pageOrBridge);
  const sessionId = options.sessionId || (session && session.sessionId) || bridge.sessionId || undefined;
  const collect = options.collect || {};
  const beforeStop = collect.beforeStop;
  const afterStop = collect.afterStop;
  const result = {};
  const target = options.phase === 'afterStop' ? afterStop : beforeStop;
  const defaultEnabled = options.defaultEnabled === true;

  if (shouldCollect(target, 'progress', defaultEnabled)) {
    result.progress = await maybeCollect('progress', () => bridge.getSessionProgress({ sessionId }), 'PTK_PROGRESS_COLLECTION_FAILED');
  }
  if (shouldCollect(target, 'findings', defaultEnabled)) {
    try {
      result.findings = await waitForFindings(bridge, sessionId, {
        timeoutMs: collect.timeoutMs,
        pollMs: collect.pollMs,
        limit: collect.limit || options.findingsLimit
      });
    } catch (error) {
      result.findings = normalizeCollectionError(error, 'PTK_FINDINGS_COLLECTION_FAILED');
    }
  }
  if (shouldCollect(target, 'stats', defaultEnabled)) {
    result.stats = await maybeCollect('stats', () => bridge.getStats({ sessionId }), 'PTK_STATS_COLLECTION_FAILED');
  }
  if (collect.export === true) {
    result.export = await maybeCollect('export', () => bridge.exportScan({ sessionId }), 'PTK_EXPORT_FAILED');
  }
  return result;
}

function writeJsonArtifact(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(redact(value), null, 2)}\n`, 'utf8');
  return filePath;
}

function writeIfPresent(resultsDir, name, value) {
  if (value === undefined || value === null) return null;
  return writeJsonArtifact(path.join(resultsDir, name), value);
}

function artifactMode(options = {}) {
  const envMode = typeof process !== 'undefined' && process.env
    ? process.env.PTK_ARTIFACT_MODE
    : null;
  const raw = options.artifactMode
    || options.mode
    || (options.artifacts && options.artifacts.mode)
    || envMode
    || 'report';
  const normalized = String(raw || '').trim().toLowerCase();
  if (['debug', 'diagnostic', 'diagnostics', 'full', 'legacy'].includes(normalized)) return 'debug';
  return 'report';
}

function emptySeverityCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function findingsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.findings)) return payload.findings;
  if (Array.isArray(payload && payload.items)) return payload.items;
  if (Array.isArray(payload && payload.data)) return payload.data;
  return [];
}

function bestFindingsPayload(result) {
  const candidates = [
    result && result.afterStop && result.afterStop.findings,
    result && result.beforeStop && result.beforeStop.findings
  ].filter((value) => value !== undefined && value !== null);
  if (!candidates.length) return { ok: true, findings: [] };
  return candidates.reduce((best, current) => (
    countFindings(current) > countFindings(best) ? current : best
  ), candidates[0]);
}

function countSeverities(findings) {
  const counts = emptySeverityCounts();
  for (const finding of findings || []) {
    const sev = String(
      (finding && (finding.severity || finding.effectiveSeverity || finding.risk || finding.level))
      || 'info'
    ).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev] += 1;
    else counts.info += 1;
  }
  return counts;
}

function countEngines(findings) {
  const counts = {};
  for (const finding of findings || []) {
    const engine = String((finding && finding.engine) || 'unknown').trim().toUpperCase() || 'unknown';
    counts[engine] = (counts[engine] || 0) + 1;
  }
  return counts;
}

function severityTotal(bySeverity) {
  return SEVERITY_KEYS.reduce((sum, key) => sum + Number((bySeverity && bySeverity[key]) || 0), 0);
}

function normalizeStats(stats, findings) {
  const derived = {
    findingsCount: findings.length,
    bySeverity: countSeverities(findings)
  };
  const normalized = {
    findingsCount: Number(stats && stats.findingsCount) || derived.findingsCount,
    bySeverity: Object.assign(emptySeverityCounts(), stats && stats.bySeverity)
  };
  if (derived.findingsCount > 0 && severityTotal(normalized.bySeverity) === 0) {
    normalized.bySeverity = derived.bySeverity;
  }
  if (normalized.findingsCount <= 0 && derived.findingsCount > 0) {
    normalized.findingsCount = derived.findingsCount;
  }
  return normalized;
}

function bestStats(result, findings) {
  const candidates = [
    result && result.stop && result.stop.stats,
    result && result.afterStop && result.afterStop.stats,
    result && result.beforeStop && result.beforeStop.stats
  ].filter((value) => value && typeof value === 'object');
  const best = candidates.reduce((selected, current) => (
    Number(current.findingsCount || 0) > Number((selected && selected.findingsCount) || 0)
      ? current
      : selected
  ), null);
  return normalizeStats(best, findings);
}

function normalizeFindingsArtifact(payload) {
  const findings = findingsFromPayload(payload);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return Object.assign({}, payload, {
      findings,
      findingsCount: Number(payload.findingsCount || payload.count || findings.length)
    });
  }
  return {
    ok: true,
    findings,
    findingsCount: findings.length
  };
}

function buildReport(result, options = {}) {
  const findingsPayload = bestFindingsPayload(result);
  const findings = findingsFromPayload(findingsPayload);
  const stats = bestStats(result, findings);
  const engines = Array.isArray(options.engines)
    ? options.engines
    : (Array.isArray(result && result.session && result.session.engines) ? result.session.engines : null);
  const sessionId = (result && result.session && (result.session.sessionId || result.session.id))
    || (result && result.stop && result.stop.sessionId)
    || null;

  return {
    ok: result && result.ok === true,
    generatedAt: new Date().toISOString(),
    project: options.project || null,
    sessionId,
    targetUrl: result && result.bootstrap ? result.bootstrap.url || null : null,
    deferred: Boolean(result && result.deferred),
    lifecycleStatus: result && result.lifecycleStatus || null,
    scanStarted: Boolean(result && result.scanStarted),
    scanStartedAt: result && result.scanStartedAt || null,
    scanStartUrl: result && result.scanStartUrl || null,
    sessionStarted: Boolean(result && result.sessionStarted),
    sessionStopped: Boolean(result && result.sessionStopped),
    engines,
    status: result && result.stop ? result.stop.status || null : null,
    releaseStatus: result && result.stop ? result.stop.releaseStatus || null : null,
    findings: {
      file: 'findings.json',
      count: stats.findingsCount,
      bySeverity: stats.bySeverity,
      byEngine: countEngines(findings),
      truncated: Boolean(findingsPayload && findingsPayload.truncated)
    },
    errors: {
      journey: result && result.error ? result.error : null,
      stop: result && result.stopError ? result.stopError : null,
      artifacts: result && result.artifactError ? result.artifactError : null
    }
  };
}

function removeKnownArtifacts(resultsDir, names) {
  for (const name of names) {
    const filePath = path.join(resultsDir, name);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {
      // Stale debug files should not block writing the user report.
    }
  }
}

function createArtifactWriter(resultsDir, written) {
  return (name, value) => {
    const filePath = writeIfPresent(resultsDir, name, value);
    if (filePath) written.push(filePath);
  };
}

function writeDebugArtifacts(result, resultsDir, options = {}) {
  const written = [];
  const write = createArtifactWriter(resultsDir, written);
  write('session_start.json', result.session);
  write('progress_before_stop.json', result.beforeStop && result.beforeStop.progress);
  write('findings_before_stop.json', result.beforeStop && result.beforeStop.findings);
  write('stats_before_stop.json', result.beforeStop && result.beforeStop.stats);
  write('scan_stop.json', result.stop);
  write('progress_after_stop.json', result.afterStop && result.afterStop.progress);
  write('findings_after_stop.json', result.afterStop && result.afterStop.findings);
  write('stats_after_stop.json', result.afterStop && result.afterStop.stats);
  write('export.json', (result.beforeStop && result.beforeStop.export) || (result.afterStop && result.afterStop.export));
  write('ptk-result.json', {
    ...result,
    artifacts: undefined,
    resultsDir,
    writeOptions: options
  });
  return written;
}

function writeReportArtifacts(result, resultsDir, options = {}) {
  const written = [];
  const write = createArtifactWriter(resultsDir, written);
  removeKnownArtifacts(resultsDir, DEBUG_ARTIFACT_FILES);
  const findingsPayload = bestFindingsPayload(result);
  write('report.json', buildReport(result, options));
  write('findings.json', normalizeFindingsArtifact(findingsPayload));
  return written;
}

function writePtkResults(result, resultsDir, options = {}) {
  if (!resultsDir) return [];
  const target = path.resolve(resultsDir);
  if (artifactMode(options) === 'debug') {
    return writeDebugArtifacts(result, target, options);
  }
  return writeReportArtifacts(result, target, options);
}

module.exports = {
  PtkScanError,
  collectPtkResults,
  countFindings,
  redact,
  resolveArtifactMode: artifactMode,
  waitForFindings,
  writeJsonArtifact,
  writePtkResults
};
