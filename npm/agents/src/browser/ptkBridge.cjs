'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_BRIDGE_TIMEOUT_MS = 1000;
const DEFAULT_EXPORT_MAX_CHUNKS = 128;
const DEFAULT_EXPORT_MAX_BYTES = 50 * 1024 * 1024;

const BRIDGE_CANDIDATE_PATHS = Object.freeze([
  ['PTK_AGENT'],
  ['__PTK_AGENT__'],
  ['PTK', 'agent'],
  ['PTK', 'automation'],
  ['PTK', 'bridge'],
  ['PTK'],
  ['PTK_AUTOMATION'],
  ['__PTK_AUTOMATION__'],
  ['__PTK_BRIDGE__'],
  ['PTKAgent'],
  ['ptkAgent'],
  ['ptkBridge']
]);

const BRIDGE_METHOD_GROUPS = Object.freeze({
  describe: ['describe', 'getMetadata', 'metadata', 'info'],
  preflight: ['preflight', 'isReady', 'ready'],
  start: ['startScan', 'scan', 'start', 'startSession'],
  status: ['scanStatus', 'getStatus', 'status', 'getSessionProgress'],
  stop: ['stopScan', 'stop', 'endSession'],
  findings: ['getFindings', 'findings', 'getAlerts', 'getIssues'],
  analysis: ['getAnalysisSnapshot', 'analysisSnapshot', 'getAnalysisExplorer'],
  export: ['exportFullReport', 'exportEvidence', 'exportScan', 'exportReport', 'export']
});

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms budget`)), timeoutMs);
    })
  ]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function methodNamesFor(methodNames) {
  if (typeof methodNames === 'string' && BRIDGE_METHOD_GROUPS[methodNames]) {
    return BRIDGE_METHOD_GROUPS[methodNames];
  }
  return Array.isArray(methodNames) ? methodNames : [methodNames];
}

function bridgeValueOk(value) {
  return !(value && typeof value === 'object' && value.ok === false);
}

function bridgeFailureReason(invocation, fallback) {
  if (!invocation) return fallback;
  const value = invocation.value;
  if (value && typeof value === 'object') {
    return value.code || value.error || value.message || invocation.reason || fallback;
  }
  return invocation.reason || fallback;
}

function bridgeFailureIsAutomationDisabled(invocation = null) {
  if (!invocation) return false;
  const reason = bridgeFailureReason(invocation, '');
  if (String(reason || '') === 'automation_disabled') return true;
  const value = invocation.value;
  return Boolean(value && typeof value === 'object' && (
    value.code === 'automation_disabled'
      || value.error === 'automation_disabled'
      || value.reason === 'automation_disabled'
  ));
}

function bridgeCandidateSupports(bridge = {}, source = '', group = '') {
  const candidates = Array.isArray(bridge.candidates) ? bridge.candidates : [];
  const candidate = candidates.find(item => item && item.source === source);
  if (!candidate) return false;
  const groups = candidate.methodGroups && candidate.methodGroups[group];
  if (Array.isArray(groups) && groups.length > 0) return true;
  const known = BRIDGE_METHOD_GROUPS[group] || [];
  const methods = Array.isArray(candidate.methods) ? candidate.methods : [];
  return methods.some(method => known.includes(method));
}

function bridgeCandidateHasKey(bridge = {}, source = '', key = '') {
  const candidates = Array.isArray(bridge.candidates) ? bridge.candidates : [];
  const candidate = candidates.find(item => item && item.source === source);
  return Boolean(candidate && Array.isArray(candidate.keys) && candidate.keys.includes(key));
}

function activationBridgeAvailable(bridge = {}) {
  return bridge.source === 'PTK_AUTOMATION'
    || bridgeCandidateHasKey(bridge, 'PTK_AUTOMATION', 'requestActivation');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function extractFindingsFromBridgeValue(value) {
  if (!value) return [];
  try {
    const { extractPtkFindings } = require('../evidence/ptkEvidenceAdapter.cjs');
    const findings = extractPtkFindings(value);
    if (findings.length) return findings;
  } catch (_) {
    // Keep the bridge usable in minimal environments; fall back to the local extractor.
  }
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  for (const key of ['findings', 'alerts', 'issues', 'results', 'vulnerabilities', 'items']) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.value) return extractFindingsFromBridgeValue(value.value);
  if (value.evidence) return extractFindingsFromBridgeValue(value.evidence);
  if (value.export) return extractFindingsFromBridgeValue(value.export);
  if (value.content) return extractFindingsFromBridgeValue(value.content);
  if (Array.isArray(value.scans)) return value.scans.flatMap(scan => extractFindingsFromBridgeValue(scan));
  return [];
}

function bridgeTruncated(value) {
  return Boolean(value && typeof value === 'object' && (value.truncated === true || value.truncatedAny === true));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRetrievalPlan(value) {
  return Boolean(value && typeof value === 'object' && (
    value.mode === 'retrieval-plan'
      || Array.isArray(value.scans) && value.scans.some(scan => scan && scan.exportMode === 'chunked' && scan.exportId)
  ));
}

function shouldGunzipScan(scan = {}) {
  return String(scan.compression || '').toLowerCase() === 'gzip'
    || /gzip/i.test(String(scan.contentType || ''))
    || /\.gz$/i.test(String(scan.fileName || ''));
}

function parseExportBytes(scan = {}, bytes) {
  const decoded = shouldGunzipScan(scan) ? zlib.gunzipSync(bytes) : bytes;
  const text = decoded.toString('utf8');
  const metadata = {
    byteLength: bytes.byteLength,
    decodedByteLength: decoded.byteLength,
    sha256: sha256(decoded),
    compression: scan.compression || null,
    contentType: scan.contentType || null,
    fileName: scan.fileName || null
  };
  try {
    return {
      ...metadata,
      parsed: true,
      content: JSON.parse(text)
    };
  } catch (error) {
    return {
      ...metadata,
      parsed: false,
      parseError: String(error && error.message ? error.message : error)
    };
  }
}

function chunkCountForScan(scan = {}) {
  const count = Number(scan.chunkCount);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function sessionIdForScan(scan = {}, options = {}) {
  return scan.sessionId
    || (scan.meta && scan.meta.automation && scan.meta.automation.sessionId)
    || options.sessionId
    || null;
}

function exportTooLarge(scans = [], options = {}) {
  const maxChunks = Number.isFinite(Number(options.maxExportChunks))
    ? Number(options.maxExportChunks)
    : DEFAULT_EXPORT_MAX_CHUNKS;
  const maxBytes = Number.isFinite(Number(options.maxExportBytes))
    ? Number(options.maxExportBytes)
    : DEFAULT_EXPORT_MAX_BYTES;
  const chunkCount = scans.reduce((sum, scan) => sum + chunkCountForScan(scan), 0);
  const byteCount = scans.reduce((sum, scan) => {
    const size = Number(scan && scan.size);
    return sum + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  if (chunkCount > maxChunks) {
    return { tooLarge: true, reason: `retrieval_plan_chunk_count_exceeds_${maxChunks}`, chunkCount, byteCount, maxChunks, maxBytes };
  }
  if (byteCount > maxBytes) {
    return { tooLarge: true, reason: `retrieval_plan_size_exceeds_${maxBytes}`, chunkCount, byteCount, maxChunks, maxBytes };
  }
  return { tooLarge: false, chunkCount, byteCount, maxChunks, maxBytes };
}

async function releaseExportScan(page, scan = {}, options = {}) {
  if (!scan.exportId) return { ok: false, called: false, reason: 'missing_export_id' };
  const remaining = remainingRetrievalTimeoutMs(options);
  const timeoutMs = remaining === null
    ? options.timeoutMs
    : Math.max(1, Math.min(Number(options.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS), remaining || 250));
  return invokeBridgeMethod(page, ['releaseExportScan'], [{
    engine: scan.engine || options.engine || 'ALL',
    exportId: scan.exportId,
    sessionId: sessionIdForScan(scan, options),
    sessionScope: 'current-tab',
    exportMode: 'evidence',
    includeSecrets: false
  }], {
    ...options,
    timeoutMs,
    source: 'PTK_AUTOMATION',
    preferredSource: 'PTK_AUTOMATION'
  });
}

async function fetchExportScan(page, scan = {}, options = {}) {
  const chunkCount = chunkCountForScan(scan);
  if (!scan.exportId) return { ok: false, scan, reason: 'missing_export_id' };
  if (!chunkCount) return { ok: false, scan, reason: 'missing_chunk_count' };
  const chunks = [];
  let result = null;
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const remaining = remainingRetrievalTimeoutMs(options);
      if (remaining !== null && remaining <= 0) {
        result = {
          ok: false,
          scan,
          reason: 'retrieval_plan_timeout'
        };
        return result;
      }
      const timeoutMs = remaining === null
        ? options.timeoutMs
        : Math.max(1, Math.min(Number(options.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS), remaining));
      const chunk = await invokeBridgeMethod(page, ['exportScanChunk'], [{
        engine: scan.engine || options.engine || 'ALL',
        exportId: scan.exportId,
        index,
        sessionId: sessionIdForScan(scan, options),
        sessionScope: 'current-tab',
        exportMode: 'evidence',
        includeSecrets: false
      }], {
        ...options,
        timeoutMs,
        source: 'PTK_AUTOMATION',
        preferredSource: 'PTK_AUTOMATION'
      });
      if (!chunk.ok || !chunk.called || !bridgeValueOk(chunk.value)) {
        result = {
          ok: false,
          scan,
          chunk,
          reason: bridgeFailureReason(chunk, `export_chunk_${index}_unavailable`)
        };
        return result;
      }
      const chunkBase64 = chunk.value && chunk.value.chunkBase64;
      if (typeof chunkBase64 !== 'string' || !chunkBase64) {
        result = {
          ok: false,
          scan,
          chunk,
          reason: `export_chunk_${index}_missing_base64`
        };
        return result;
      }
      chunks.push(Buffer.from(chunkBase64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    const parsed = parseExportBytes(scan, bytes);
    result = {
      ok: true,
      scan: {
        ...scan,
        retrievalResolved: true,
        content: parsed.content || null,
        parse: {
          parsed: parsed.parsed,
          parseError: parsed.parseError || null,
          byteLength: parsed.byteLength,
          decodedByteLength: parsed.decodedByteLength,
          sha256: parsed.sha256,
          compression: parsed.compression,
          contentType: parsed.contentType,
          fileName: parsed.fileName
        }
      },
      reason: parsed.parsed ? 'resolved' : 'resolved_unparsed'
    };
    return result;
  } finally {
    const released = await releaseExportScan(page, scan, options).catch(error => ({
      ok: false,
      reason: String(error && error.message ? error.message : error)
    }));
    if (result && typeof result === 'object') {
      result.released = released;
      if (!released.ok || !bridgeValueOk(released.value)) {
        result.releaseWarning = bridgeFailureReason(released, 'release_failed');
      }
    }
  }
}

async function resolveRetrievalPlan(page, plan = {}, options = {}) {
  if (!isRetrievalPlan(plan)) {
    return { ok: true, resolved: false, export: plan, reason: 'inline_export' };
  }
  const retrievalDeadlineMs = options.retrievalDeadlineMs || (Date.now() + retrievalTimeoutMs(options));
  const scans = Array.isArray(plan.scans) ? plan.scans : [];
  const sizeCheck = exportTooLarge(scans, options);
  if (sizeCheck.tooLarge) {
    return {
      ok: false,
      resolved: false,
      export: plan,
      reason: sizeCheck.reason,
      retrieval: sizeCheck
    };
  }
  const resolvedScans = [];
  const failures = [];
  for (const scan of scans) {
    if (Date.now() >= retrievalDeadlineMs) {
      failures.push({
        engine: scan && scan.engine || null,
        exportId: scan && scan.exportId || null,
        reason: 'retrieval_plan_timeout'
      });
      continue;
    }
    const result = await fetchExportScan(page, scan, { ...options, retrievalDeadlineMs });
    if (result.ok) resolvedScans.push(result.scan);
    else failures.push({
      engine: scan && scan.engine || null,
      exportId: scan && scan.exportId || null,
      reason: result.reason || 'chunk_retrieval_failed'
    });
  }
  const ok = failures.length === 0;
  return {
    ok,
    resolved: ok,
    export: {
      ...plan,
      retrievalResolved: ok,
      scans: ok ? resolvedScans : scans,
      retrieval: {
        ...sizeCheck,
        resolved: ok,
        failures
      }
    },
    reason: ok ? 'retrieval_plan_resolved' : 'retrieval_plan_failed',
    failures
  };
}

function retrievalTimeoutMs(options = {}) {
  const configured = Number(options.retrievalTimeoutMs || options.exportRetrievalTimeoutMs || options.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, configured);
  return DEFAULT_BRIDGE_TIMEOUT_MS;
}

function remainingRetrievalTimeoutMs(options = {}) {
  const deadline = Number(options.retrievalDeadlineMs);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return Math.max(0, deadline - Date.now());
}

function ptkValidity(fields = {}) {
  const hasPtkBridge = Boolean(fields.hasPtkBridge);
  const hasFindingsExport = Boolean(fields.hasFindingsExport);
  const findingsCount = Number.isFinite(Number(fields.findingsCount)) ? Number(fields.findingsCount) : 0;
  const status = !hasPtkBridge
    ? 'invalid_no_ptk_bridge'
    : !hasFindingsExport
      ? 'invalid_no_findings_export'
      : 'valid';
  return {
    valid: status === 'valid',
    status,
    hasPtkBridge,
    hasFindingsExport,
    findingsCount,
    reason: fields.reason || status
  };
}

function bridgeValueLookupDiagnostics(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (value.sessionLookup && typeof value.sessionLookup === 'object') return value.sessionLookup;
  if (value.value && typeof value.value === 'object') {
    const nested = bridgeValueLookupDiagnostics(value.value, depth + 1);
    if (nested) return nested;
  }
  if (value.status && typeof value.status === 'object') {
    const nested = bridgeValueLookupDiagnostics(value.status, depth + 1);
    if (nested) return nested;
  }
  if (value.invocation && typeof value.invocation === 'object') {
    const nested = bridgeValueLookupDiagnostics(value.invocation, depth + 1);
    if (nested) return nested;
  }
  if (value.findingsResult && typeof value.findingsResult === 'object') {
    const nested = bridgeValueLookupDiagnostics(value.findingsResult, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function invocationLookupDiagnostics(invocation = null) {
  return bridgeValueLookupDiagnostics(invocation) || bridgeValueLookupDiagnostics(invocation && invocation.value) || null;
}

function lookupSourceFromDiagnostics(lookup = null) {
  return lookup && typeof lookup === 'object' && lookup.lookupSource
    ? String(lookup.lookupSource)
    : null;
}

async function detectPtkBridge(page, ptkConfig = {}) {
  const timeoutMs = Number(ptkConfig.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS);
  const base = {
    available: false,
    source: null,
    methods: [],
    methodGroups: {},
    capabilities: [],
    extensionPath: ptkConfig.extensionPath || null,
    autoDetectExtension: ptkConfig.autoDetectExtension !== false,
    reason: 'not_detected'
  };
  if (!page || typeof page.evaluate !== 'function') return { ...base, reason: 'no_page' };
  try {
    const status = await withTimeout(page.evaluate(async ({ candidatePaths, methodGroups, probeMetadata }) => {
      const root = typeof window !== 'undefined' ? window : globalThis;

      function readPath(path) {
        let value = root;
        for (const part of path) {
          if (!value || typeof value !== 'object' && typeof value !== 'function') return undefined;
          value = value[part];
        }
        return value;
      }

      function cloneSerializable(value, depth = 0, seen = []) {
        if (value === null || value === undefined) return value === undefined ? null : value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
        if (depth >= 6) return '[truncated]';
        if (seen.includes(value)) return '[circular]';
        if (Array.isArray(value)) {
          return value.slice(0, 80).map(item => cloneSerializable(item, depth + 1, seen.concat([value])));
        }
        if (typeof value === 'object') {
          const output = {};
          for (const [key, item] of Object.entries(value).slice(0, 80)) {
            output[key] = cloneSerializable(item, depth + 1, seen.concat([value]));
          }
          return output;
        }
        return String(value);
      }

      async function callOptional(candidate, names) {
        const method = names.find(name => typeof candidate.value[name] === 'function');
        if (!method) return null;
        try {
          const value = await Promise.resolve(candidate.value[method].call(candidate.value));
          return { method, ok: true, value: cloneSerializable(value) };
        } catch (error) {
          return { method, ok: false, error: String(error && error.message ? error.message : error) };
        }
      }

      const candidates = [];
      for (const path of candidatePaths) {
        const value = readPath(path);
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
        const source = path.join('.');
        if (candidates.some(candidate => candidate.value === value)) continue;
        const methods = [];
        const groups = {};
        for (const [group, names] of Object.entries(methodGroups)) {
          groups[group] = names.filter(name => typeof value[name] === 'function');
          methods.push(...groups[group]);
        }
        const capabilities = Array.isArray(value.capabilities) ? value.capabilities.map(String) : [];
        const keys = Object.keys(value).slice(0, 40);
        const score = (source === 'PTK_AGENT' ? 100 : 0)
          + (source.includes('AGENT') ? 30 : 0)
          + Object.values(groups).filter(group => group.length > 0).length * 10
          + methods.length
          + capabilities.length;
        candidates.push({
          source,
          value,
          available: methods.length > 0 || capabilities.length > 0,
          methods: Array.from(new Set(methods)),
          methodGroups: groups,
          capabilities,
          keys,
          score
        });
      }

      const visibleCandidates = candidates
        .map(candidate => ({
          source: candidate.source,
          available: candidate.available,
          methods: candidate.methods,
          methodGroups: candidate.methodGroups,
          capabilities: candidate.capabilities,
          keys: candidate.keys,
          score: candidate.score
        }))
        .sort((left, right) => right.score - left.score);

      const found = candidates
        .filter(candidate => candidate.available)
        .sort((left, right) => right.score - left.score)[0];
      if (!found) {
        return { available: false, source: null, methods: [], candidates: visibleCandidates };
      }

      const metadata = probeMetadata === false ? null : await callOptional(found, methodGroups.describe);
      const preflight = probeMetadata === false ? null : await callOptional(found, methodGroups.preflight);
      return {
        available: true,
        source: found.source,
        methods: found.methods,
        methodGroups: found.methodGroups,
        capabilities: found.capabilities,
        keys: found.keys,
        candidates: visibleCandidates,
        metadata,
        preflight
      };
    }, {
      candidatePaths: BRIDGE_CANDIDATE_PATHS,
      methodGroups: BRIDGE_METHOD_GROUPS,
      probeMetadata: ptkConfig.probeMetadata
    }), timeoutMs, 'PTK bridge detection');
    return {
      ...base,
      ...status,
      available: Boolean(status.available),
      reason: status.available ? 'detected' : 'not_detected'
    };
  } catch (err) {
    return { ...base, reason: `detect_failed:${err.message}`, error: err.message };
  }
}

async function waitForPtkBridge(page, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS);
  const intervalMs = Math.max(25, Math.min(100, Number(options.intervalMs || 50)));
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let last = null;
  while (Date.now() <= deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    last = await detectPtkBridge(page, { ...options, timeoutMs: Math.min(remaining, Math.max(100, timeoutMs)) });
    if (last.available) return last;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return last || await detectPtkBridge(page, options);
}

async function requestPtkAutomationActivation(page, options = {}) {
  const reason = options.activationReason || options.reason || 'ptk_agent_start';
  const invocation = await invokeBridgeMethod(page, ['requestActivation'], [{ reason }], {
    ...options,
    source: 'PTK_AUTOMATION',
    preferredSource: 'PTK_AUTOMATION'
  });
  const value = invocation && invocation.value;
  const allowed = Boolean(invocation.ok && invocation.called && value && typeof value === 'object' && value.allowed === true && value.ok !== false);
  return {
    ok: allowed,
    allowed,
    invocation,
    reason: allowed ? value.reason || 'activation_granted' : bridgeFailureReason(invocation, 'activation_denied')
  };
}

async function waitForPtkAutomationEnabled(page, options = {}) {
  const timeoutMs = Number(options.activationTimeoutMs || options.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS);
  const intervalMs = Math.max(25, Math.min(100, Number(options.activationIntervalMs || options.intervalMs || 50)));
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let lastBridge = null;
  let lastPing = null;
  while (Date.now() <= deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    lastBridge = await detectPtkBridge(page, {
      ...options,
      timeoutMs: Math.min(remaining, Math.max(100, timeoutMs)),
      probeMetadata: false
    });
    if (lastBridge.available && lastBridge.source === 'PTK_AGENT') {
      return { enabled: true, bridge: lastBridge, ping: lastPing, reason: 'agent_bridge_ready' };
    }
    if (lastBridge.available && activationBridgeAvailable(lastBridge)) {
      lastPing = await invokeBridgeMethod(page, ['ping'], [], {
        ...options,
        timeoutMs: Math.min(remaining, Math.max(100, timeoutMs)),
        source: 'PTK_AUTOMATION',
        preferredSource: 'PTK_AUTOMATION'
      });
      if (lastPing.ok && lastPing.called && lastPing.value && lastPing.value.automationEnabled === true) {
        const refreshed = await detectPtkBridge(page, {
          ...options,
          timeoutMs: Math.min(Math.max(100, timeoutMs), Math.max(1, deadline - Date.now())),
          probeMetadata: false
        });
        return {
          enabled: true,
          bridge: refreshed.available ? refreshed : lastBridge,
          ping: lastPing,
          reason: 'automation_bridge_enabled'
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return {
    enabled: false,
    bridge: lastBridge,
    ping: lastPing,
    reason: lastPing ? bridgeFailureReason(lastPing, 'activation_not_observed') : 'activation_not_observed'
  };
}

async function invokeBridgeMethod(page, methodNames, args = [], options = {}) {
  const names = methodNamesFor(methodNames).filter(Boolean);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_BRIDGE_TIMEOUT_MS);
  if (!page || typeof page.evaluate !== 'function') return { ok: false, called: false, reason: 'no_page' };
  if (!names.length) return { ok: false, called: false, reason: 'no_methods_requested' };
  try {
    return await withTimeout(page.evaluate(async ({ names: candidateNames, args: methodArgs, candidatePaths, preferredSource, cloneBudget }) => {
      const root = typeof window !== 'undefined' ? window : globalThis;

      function readPath(path) {
        let value = root;
        for (const part of path) {
          if (!value || typeof value !== 'object' && typeof value !== 'function') return undefined;
          value = value[part];
        }
        return value;
      }

      function cloneSerializable(value, depth = 0, seen = [], state = null) {
        state = state || {
          startedAt: Date.now(),
          nodes: 0,
          truncated: false,
          maxNodes: cloneBudget && cloneBudget.maxNodes || 20000,
          maxArrayItems: cloneBudget && cloneBudget.maxArrayItems || 500,
          maxObjectKeys: cloneBudget && cloneBudget.maxObjectKeys || 200,
          maxCloneMs: cloneBudget && cloneBudget.maxCloneMs || 1500
        };
        state.nodes += 1;
        if (state.nodes > state.maxNodes || Date.now() - state.startedAt > state.maxCloneMs) {
          state.truncated = true;
          return '[truncated:clone-budget]';
        }
        if (value === null || value === undefined) return value === undefined ? null : value;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
        if (depth >= 8) return '[truncated]';
        if (seen.includes(value)) return '[circular]';
        if (Array.isArray(value)) {
          return value.slice(0, state.maxArrayItems).map(item => cloneSerializable(item, depth + 1, seen.concat([value]), state));
        }
        if (typeof value === 'object') {
          const output = {};
          for (const [key, item] of Object.entries(value).slice(0, state.maxObjectKeys)) {
            output[key] = cloneSerializable(item, depth + 1, seen.concat([value]), state);
            if (state.truncated) break;
          }
          return output;
        }
        return String(value);
      }

      function cloneBridgeValue(value) {
        const state = {
          startedAt: Date.now(),
          nodes: 0,
          truncated: false,
          maxNodes: cloneBudget && cloneBudget.maxNodes || 20000,
          maxArrayItems: cloneBudget && cloneBudget.maxArrayItems || 500,
          maxObjectKeys: cloneBudget && cloneBudget.maxObjectKeys || 200,
          maxCloneMs: cloneBudget && cloneBudget.maxCloneMs || 1500
        };
        const cloned = cloneSerializable(value, 0, [], state);
        if (state.truncated) {
          return {
            ok: false,
            code: 'bridge_value_truncated',
            message: 'PTK bridge value exceeded clone budget'
          };
        }
        return cloned;
      }

      const candidates = [];
      for (const path of candidatePaths) {
        const value = readPath(path);
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
        const source = path.join('.');
        if (candidates.some(candidate => candidate.value === value)) continue;
        candidates.push({ source, value });
      }
      candidates.sort((left, right) => {
        if (preferredSource && left.source === preferredSource) return -1;
        if (preferredSource && right.source === preferredSource) return 1;
        if (left.source === 'PTK_AGENT') return -1;
        if (right.source === 'PTK_AGENT') return 1;
        return 0;
      });

      if (!candidates.length) return { ok: false, called: false, reason: 'bridge_missing' };
      for (const candidate of candidates) {
        const method = candidateNames.find(name => typeof candidate.value[name] === 'function');
        if (!method) continue;
        try {
          const value = await Promise.resolve(candidate.value[method](...(methodArgs || [])));
          return {
            ok: true,
            called: true,
            source: candidate.source,
            method,
            value: cloneBridgeValue(value)
          };
        } catch (error) {
          return {
            ok: false,
            called: true,
            source: candidate.source,
            method,
            reason: String(error && error.message ? error.message : error),
            error: String(error && error.message ? error.message : error)
          };
        }
      }
      return { ok: false, called: false, reason: `method_missing:${candidateNames.join(',')}` };
    }, {
      names,
      args,
      candidatePaths: BRIDGE_CANDIDATE_PATHS,
      preferredSource: options.source || options.preferredSource || null,
      cloneBudget: {
        maxNodes: Number(options.maxCloneNodes) > 0 ? Number(options.maxCloneNodes) : 20000,
        maxArrayItems: Number(options.maxCloneArrayItems) > 0 ? Number(options.maxCloneArrayItems) : 500,
        maxObjectKeys: Number(options.maxCloneObjectKeys) > 0 ? Number(options.maxCloneObjectKeys) : 200,
        maxCloneMs: Number(options.maxCloneMs) > 0 ? Number(options.maxCloneMs) : Math.max(250, Math.min(1500, Math.floor(timeoutMs / 2)))
      }
    }), timeoutMs, `PTK bridge method ${names.join('/')}`);
  } catch (err) {
    return { ok: false, called: false, reason: err.message, error: err.message };
  }
}

async function startPtkScan(page, options = {}) {
  const bridge = options.waitForBridge === false
    ? await detectPtkBridge(page, options)
    : await waitForPtkBridge(page, options);
  if (!bridge.available) return { available: false, started: false, bridge, reason: bridge.reason };
  let invocation = await invokeBridgeMethod(page, 'start', [options.scanOptions || {}], { ...options, source: bridge.source });
  let activation = null;
  let activationWait = null;
  let retryBridge = null;
  if ((!invocation.ok || !invocation.called || !bridgeValueOk(invocation.value))
      && bridgeFailureIsAutomationDisabled(invocation)
      && activationBridgeAvailable(bridge)) {
    activation = await requestPtkAutomationActivation(page, {
      ...options,
      activationReason: options.activationReason || 'ptk_agent_start'
    });
    if (activation.allowed === true) {
      activationWait = await waitForPtkAutomationEnabled(page, options);
      retryBridge = activationWait.bridge && activationWait.bridge.available ? activationWait.bridge : bridge;
      const retry = await invokeBridgeMethod(page, 'start', [options.scanOptions || {}], {
        ...options,
        source: retryBridge.source || 'PTK_AUTOMATION'
      });
      if (retry.ok && retry.called && bridgeValueOk(retry.value)) {
        invocation = {
          ...retry,
          retryAfterActivation: true,
          initialFailureReason: bridgeFailureReason(invocation, 'start_failed')
        };
      }
    }
  }
  const started = Boolean(invocation.ok && invocation.called && bridgeValueOk(invocation.value));
  return {
    available: true,
    started,
    bridge: retryBridge || bridge,
    invocation,
    activation,
    activationWait,
    reason: started ? 'started' : bridgeFailureReason(invocation, 'start_failed')
  };
}

async function stopPtkScan(page, options = {}) {
  const bridge = options.waitForBridge === false
    ? await detectPtkBridge(page, options)
    : await waitForPtkBridge(page, options);
  if (!bridge.available) return { available: false, stopped: false, bridge, reason: bridge.reason };
  const stopOptions = {
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.stopOptions || {})
  };
  if (typeof options.immediateAnalysis === 'boolean' && typeof stopOptions.immediateAnalysis !== 'boolean') {
    stopOptions.immediateAnalysis = options.immediateAnalysis;
  }
  let invocation = await invokeBridgeMethod(page, 'stop', [stopOptions], { ...options, source: bridge.source });
  if ((!invocation.ok || !invocation.called || !bridgeValueOk(invocation.value)) && bridge.source !== 'PTK_AUTOMATION' && bridgeCandidateSupports(bridge, 'PTK_AUTOMATION', 'stop')) {
    const fallback = await invokeBridgeMethod(page, 'stop', [stopOptions], {
      ...options,
      source: 'PTK_AUTOMATION',
      preferredSource: 'PTK_AUTOMATION'
    });
    if (fallback.ok && fallback.called && bridgeValueOk(fallback.value)) {
      invocation = {
        ...fallback,
        fallbackFrom: bridge.source,
        fallbackReason: bridgeFailureReason(invocation, 'stop_primary_failed')
      };
    }
  }
  const stopped = Boolean(invocation.ok && invocation.called && bridgeValueOk(invocation.value));
  return {
    available: true,
    stopped,
    bridge,
    invocation,
    reason: stopped ? 'stopped' : bridgeFailureReason(invocation, 'stop_failed')
  };
}

async function readPtkStatus(page, options = {}) {
  const bridge = options.bridge && options.bridge.available ? options.bridge : await detectPtkBridge(page, options);
  if (!bridge.available) return { available: false, ok: false, bridge, status: null, reason: bridge.reason };
  const statusOptions = options.statusOptions || {};
  const primarySource = bridge.source;
  const sources = [primarySource];
  if (primarySource === 'PTK_AGENT' && bridgeCandidateSupports(bridge, 'PTK_AUTOMATION', 'status')) {
    sources.push('PTK_AUTOMATION');
  } else if (primarySource !== 'PTK_AGENT' && bridgeCandidateSupports(bridge, 'PTK_AGENT', 'status')) {
    sources.push('PTK_AGENT');
  }

  let invocation = null;
  let firstFailure = null;
  for (const source of sources) {
    const isFallback = source !== primarySource;
    const sourceOptions = source === 'PTK_AUTOMATION' && primarySource === 'PTK_AGENT'
      ? {
          ...options,
          timeoutMs: Math.max(1, Number(options.lowLevelTimeoutMs || Math.min(Number(options.timeoutMs) || DEFAULT_BRIDGE_TIMEOUT_MS, 4000)))
        }
      : options;
    const candidateInvocation = await invokeBridgeMethod(page, 'status', [statusOptions], {
      ...sourceOptions,
      source,
      preferredSource: source
    });
    if (candidateInvocation && candidateInvocation.ok && candidateInvocation.called && bridgeValueOk(candidateInvocation.value)) {
      invocation = isFallback
        ? {
            ...candidateInvocation,
            fallbackFrom: firstFailure && (firstFailure.source || primarySource),
            fallbackReason: bridgeFailureReason(firstFailure, 'primary_status_unavailable')
          }
        : candidateInvocation;
      break;
    }
    if (!firstFailure) firstFailure = candidateInvocation;
    invocation = candidateInvocation;
  }
  const ok = Boolean(invocation.ok && invocation.called && bridgeValueOk(invocation.value));
  return {
    available: true,
    ok,
    bridge,
    status: ok ? invocation.value : null,
    invocation,
    reason: ok ? 'status_read' : bridgeFailureReason(invocation, 'status_unavailable')
  };
}

async function getPtkFindings(page, options = {}) {
  const bridge = options.bridge && options.bridge.available ? options.bridge : await detectPtkBridge(page, options);
  if (!bridge.available) {
    const reason = bridge.reason || 'not_detected';
    return {
      available: false,
      ok: false,
      bridge,
      findings: [],
      truncated: false,
      reason,
      validity: ptkValidity({ hasPtkBridge: false, hasFindingsExport: false, findingsCount: 0, reason })
    };
  }
  const findingsOptions = options.findingsOptions || { limit: Number(options.limit || 100) };
  let invocation = await invokeBridgeMethod(page, 'findings', [findingsOptions], { ...options, source: bridge.source });
  if ((!invocation.ok || !invocation.called || !bridgeValueOk(invocation.value)) && bridge.source !== 'PTK_AUTOMATION' && bridgeCandidateSupports(bridge, 'PTK_AUTOMATION', 'findings')) {
    const fallback = await invokeBridgeMethod(page, 'findings', [findingsOptions], {
      ...options,
      source: 'PTK_AUTOMATION',
      preferredSource: 'PTK_AUTOMATION'
    });
    if (fallback.ok && fallback.called && bridgeValueOk(fallback.value)) {
      invocation = {
        ...fallback,
        fallbackFrom: bridge.source,
        fallbackReason: bridgeFailureReason(invocation, 'findings_primary_failed')
      };
    }
  }
  const ok = Boolean(invocation.ok && invocation.called && bridgeValueOk(invocation.value));
  const findings = ok ? extractFindingsFromBridgeValue(invocation.value) : [];
  const reason = ok ? 'findings_collected' : bridgeFailureReason(invocation, 'findings_unavailable');
  const lookupDiagnostics = invocationLookupDiagnostics(invocation);
  return {
    available: true,
    ok,
    bridge,
    findings,
    truncated: ok ? bridgeTruncated(invocation.value) : false,
    invocation,
    lookupDiagnostics,
    exportLookupSource: lookupSourceFromDiagnostics(lookupDiagnostics),
    findingsApiFallbackUsed: ok,
    findingsExportValiditySource: ok ? 'findings-api' : 'none',
    reason,
    validity: ptkValidity({
      hasPtkBridge: true,
      hasFindingsExport: false,
      findingsCount: findings.length,
      reason
    })
  };
}

async function exportPtkEvidence(page, options = {}) {
  if (
    options.includeSecrets === true
    || String(options.exportMode || '').toLowerCase() === 'replayable'
    || (options.exportOptions && options.exportOptions.includeSecrets === true)
    || String(options.exportOptions && options.exportOptions.exportMode || '').toLowerCase() === 'replayable'
  ) {
    const reason = 'replayable_export_requires_privileged_extension_export';
    return {
      available: false,
      exported: false,
      collected: false,
      bridge: null,
      evidence: null,
      findings: [],
      reason,
      validity: ptkValidity({ hasPtkBridge: false, hasFindingsExport: false, findingsCount: 0, reason })
    };
  }
  const bridge = options.waitForBridge === false
    ? await detectPtkBridge(page, options)
    : await waitForPtkBridge(page, options);
  if (!bridge.available) {
    const reason = bridge.reason || 'not_detected';
    return {
      available: false,
      exported: false,
      collected: false,
      bridge,
      evidence: null,
      findings: [],
      reason,
      validity: ptkValidity({ hasPtkBridge: false, hasFindingsExport: false, findingsCount: 0, reason })
    };
  }

  const status = options.includeStatus === false
    ? null
    : await readPtkStatus(page, { ...options, bridge }).catch(error => ({
      available: true,
      ok: false,
      bridge,
      status: null,
      reason: String(error && error.message ? error.message : error)
    }));

  const exportOptions = options.exportOptions || {
    engine: options.engine || 'ALL',
    transfer: options.transfer || 'retrieval-plan',
    includeSecrets: false,
    exportMode: 'evidence',
    sessionScope: 'current-tab',
    sessionId: options.sessionId || undefined
  };
  const exportOptionsForSource = source => source === 'PTK_AUTOMATION'
    ? {
        ...exportOptions,
        includeSecrets: false,
        exportMode: 'evidence',
        sessionScope: 'current-tab',
        allowChunked: exportOptions.allowChunked !== false,
        maxExportBytes: Number.isFinite(Number(exportOptions.maxExportBytes)) ? Number(exportOptions.maxExportBytes) : 1
      }
    : exportOptions;
  const primaryExportSource = options.exportSource || options.preferredExportSource || bridge.source;
  let invocation = await invokeBridgeMethod(page, 'export', [exportOptionsForSource(primaryExportSource)], {
    ...options,
    source: primaryExportSource,
    preferredSource: primaryExportSource
  });
  if ((!invocation.ok || !invocation.called || !bridgeValueOk(invocation.value)) && primaryExportSource !== 'PTK_AUTOMATION' && bridgeCandidateSupports(bridge, 'PTK_AUTOMATION', 'export')) {
    const fallback = await invokeBridgeMethod(page, 'export', [exportOptionsForSource('PTK_AUTOMATION')], {
      ...options,
      source: 'PTK_AUTOMATION',
      preferredSource: 'PTK_AUTOMATION'
    });
    if (fallback.ok && fallback.called && bridgeValueOk(fallback.value)) {
      invocation = {
        ...fallback,
        fallbackFrom: bridge.source,
        fallbackReason: bridgeFailureReason(invocation, 'export_primary_failed')
      };
    }
  }
  const exported = Boolean(invocation.ok && invocation.called && bridgeValueOk(invocation.value));
  const retrieval = exported
    ? await resolveRetrievalPlan(page, invocation.value, options).catch(error => ({
      ok: false,
      resolved: false,
      export: invocation.value,
      reason: String(error && error.message ? error.message : error)
    }))
    : null;
  const exportValue = retrieval && retrieval.ok ? retrieval.export : invocation.value;

  const findingsResult = options.includeFindings === false
    ? null
    : await getPtkFindings(page, { ...options, bridge }).catch(error => ({
      available: true,
      ok: false,
      bridge,
      findings: [],
      truncated: false,
      reason: String(error && error.message ? error.message : error)
    }));

  const exportFindings = exported ? extractFindingsFromBridgeValue(exportValue) : [];
  const apiFindings = findingsResult && findingsResult.ok ? findingsResult.findings : [];
  const findings = exportFindings.length >= apiFindings.length ? exportFindings : apiFindings;
  const exportResolved = Boolean(exported && (!isRetrievalPlan(invocation.value) || retrieval && retrieval.ok));
  const exportLookupDiagnostics = invocationLookupDiagnostics(invocation);
  const findingsLookupDiagnostics = findingsResult && (findingsResult.lookupDiagnostics || invocationLookupDiagnostics(findingsResult.invocation)) || null;
  const statusLookupDiagnostics = status && (status.lookupDiagnostics || invocationLookupDiagnostics(status.invocation)) || null;
  const lookupDiagnostics = exportLookupDiagnostics || statusLookupDiagnostics || findingsLookupDiagnostics || null;
  const findingsApiFallbackUsed = Boolean(!exportResolved && findingsResult && findingsResult.ok && apiFindings.length > 0);
  const findingsExportValiditySource = exportResolved ? 'export' : findingsApiFallbackUsed ? 'findings-api' : 'none';
  const hasFindingsExport = Boolean(exportResolved);
  const reason = exportResolved
    ? (retrieval && retrieval.resolved ? 'exported_retrieval_plan_resolved' : 'exported')
    : bridgeFailureReason(invocation, findings.length > 0 ? 'findings_collected' : 'export_unavailable');
  const validity = ptkValidity({
    hasPtkBridge: true,
    hasFindingsExport,
    findingsCount: findings.length,
    reason
  });
  const evidence = {
    status: status && status.ok ? status.status : null,
    export: exported ? exportValue : null,
    retrieval: retrieval ? {
      ok: retrieval.ok,
      resolved: retrieval.resolved,
      reason: retrieval.reason,
      failures: retrieval.failures || []
    } : null,
    findings,
    truncated: Boolean((findingsResult && findingsResult.truncated) || bridgeTruncated(exportValue)),
    exportRetrievalResolved: exportResolved,
    findingsApiFallbackUsed,
    findingsExportValiditySource,
    exportLookupSource: lookupSourceFromDiagnostics(exportLookupDiagnostics || lookupDiagnostics),
    lookupDiagnostics,
    validity
  };

  return {
    available: true,
    exported,
    collected: exported || findings.length > 0 || Boolean(evidence.status),
    bridge,
    evidence,
    findings,
    status,
    invocation,
    retrieval,
    findingsResult,
    exportRetrievalResolved: exportResolved,
    findingsApiFallbackUsed,
    findingsExportValiditySource,
    exportLookupSource: lookupSourceFromDiagnostics(exportLookupDiagnostics || lookupDiagnostics),
    lookupDiagnostics,
    validity,
    reason
  };
}

async function startPtkScanIfAvailable(page, options = {}) {
  const result = await startPtkScan(page, options);
  return { started: result.started, reason: result.reason || result.invocation && result.invocation.reason || (result.started ? 'started' : 'bridge_missing'), bridge: result.bridge };
}

async function stopPtkScanIfAvailable(page, options = {}) {
  const result = await stopPtkScan(page, options);
  return { stopped: result.stopped, reason: result.reason || result.invocation && result.invocation.reason || (result.stopped ? 'stopped' : 'bridge_missing'), bridge: result.bridge };
}

module.exports = {
  BRIDGE_CANDIDATE_PATHS,
  BRIDGE_METHOD_GROUPS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  withTimeout,
  bridgeValueOk,
  isRetrievalPlan,
  ptkValidity,
  resolveRetrievalPlan,
  detectPtkBridge,
  waitForPtkBridge,
  invokeBridgeMethod,
  requestPtkAutomationActivation,
  waitForPtkAutomationEnabled,
  startPtkScan,
  stopPtkScan,
  readPtkStatus,
  getPtkFindings,
  exportPtkEvidence,
  startPtkScanIfAvailable,
  stopPtkScanIfAvailable
};
