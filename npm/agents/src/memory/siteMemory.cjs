'use strict';

const fs = require('fs');
const path = require('path');
const { createSiteFingerprint, stableHash } = require('./siteFingerprint.cjs');

const SCHEMA_VERSION = 'ptk-agent-v2-site-memory';
const SDK_VERSION = '0.0.0-v2';
const DEFAULT_STALE_AFTER_DAYS = 14;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function resolveMemoryConfig(config = {}) {
  const memory = config.memory || {};
  return {
    mode: ['off', 'read', 'read-write'].includes(memory.mode) ? memory.mode : 'off',
    storageDir: memory.storageDir || '.ptk/site-memory',
    reset: Boolean(memory.reset),
    staleAfterDays: Number(memory.staleAfterDays) > 0 ? Number(memory.staleAfterDays) : DEFAULT_STALE_AFTER_DAYS,
    minConfidence: Number(memory.minConfidence) >= 0 ? Number(memory.minConfidence) : 0.25,
    maxSeedRoutes: Number(memory.maxSeedRoutes) >= 0 ? Number(memory.maxSeedRoutes) : 25
  };
}

function createEmptySiteMemory(config = {}, options = {}) {
  const fingerprint = options.fingerprint || createSiteFingerprint({
    baseUrl: config.target && config.target.baseUrl
  });
  const generatedAt = options.generatedAt || nowIso(options.now);
  return {
    schemaVersion: SCHEMA_VERSION,
    sdkVersion: SDK_VERSION,
    siteFingerprint: fingerprint,
    appBuildFingerprint: fingerprint.appBuildFingerprint || null,
    generatedAt,
    updatedAt: generatedAt,
    routes: [],
    selectors: [],
    workflowTraces: [],
    endpoints: [],
    negativeMemory: [],
    personaSummary: personaSummary(config.profile || {})
  };
}

function personaSummary(profile = {}) {
  const active = profile.activePersonaId || 'default';
  const persona = (profile.personas || []).find(item => item && item.id === active) || {};
  return {
    activePersonaId: active,
    authBucket: profile.username || persona.credentials && persona.credentials.username ? 'credentialed' : 'anonymous',
    searchTermCount: Array.isArray(profile.searchTerms) ? profile.searchTerms.length : 0
  };
}

function siteMemoryPath(config = {}, options = {}) {
  const memoryConfig = resolveMemoryConfig(config);
  const fingerprint = options.fingerprint || createSiteFingerprint({
    baseUrl: config.target && config.target.baseUrl
  });
  const cwd = options.cwd || process.cwd();
  const storageDir = path.isAbsolute(memoryConfig.storageDir)
    ? memoryConfig.storageDir
    : path.resolve(cwd, memoryConfig.storageDir);
  return path.join(storageDir, `${fingerprint.siteKey}.json`);
}

function normalizeRecord(record = {}, fallback = {}, options = {}) {
  const successCount = Number(record.successCount || 0);
  const failureCount = Number(record.failureCount || 0);
  const confidence = Number.isFinite(Number(record.confidence))
    ? clamp(Number(record.confidence), 0, 1)
    : confidenceFromCounts(successCount, failureCount);
  return {
    schemaVersion: record.schemaVersion || `${SCHEMA_VERSION}-record`,
    sdkVersion: record.sdkVersion || SDK_VERSION,
    siteFingerprint: record.siteFingerprint || fallback.siteFingerprint || null,
    appBuildFingerprint: record.appBuildFingerprint || fallback.appBuildFingerprint || null,
    lastValidatedAt: record.lastValidatedAt || fallback.lastValidatedAt || null,
    successCount,
    failureCount,
    confidence,
    staleAfterDays: Number(record.staleAfterDays || options.staleAfterDays || DEFAULT_STALE_AFTER_DAYS),
    ...record
  };
}

function normalizeSiteMemory(raw = {}, config = {}, options = {}) {
  const empty = createEmptySiteMemory(config, options);
  const memoryConfig = resolveMemoryConfig(config);
  const memory = {
    ...empty,
    ...(raw && typeof raw === 'object' ? raw : {}),
    schemaVersion: SCHEMA_VERSION,
    sdkVersion: SDK_VERSION,
    siteFingerprint: raw.siteFingerprint || empty.siteFingerprint,
    routes: [],
    selectors: [],
    workflowTraces: Array.isArray(raw.workflowTraces) ? raw.workflowTraces : [],
    endpoints: [],
    negativeMemory: [],
    personaSummary: raw.personaSummary || empty.personaSummary
  };
  const fallback = {
    siteFingerprint: memory.siteFingerprint,
    appBuildFingerprint: memory.appBuildFingerprint
  };
  memory.routes = (raw.routes || []).map(record => normalizeRecord(record, fallback, memoryConfig));
  memory.selectors = (raw.selectors || []).map(record => normalizeRecord(record, fallback, memoryConfig));
  memory.endpoints = (raw.endpoints || []).map(record => normalizeRecord(record, fallback, memoryConfig));
  memory.negativeMemory = (raw.negativeMemory || []).map(record => normalizeRecord(record, fallback, memoryConfig));
  return memory;
}

function loadSiteMemory(config = {}, options = {}) {
  const memoryConfig = resolveMemoryConfig(config);
  const fingerprint = createSiteFingerprint({ baseUrl: config.target && config.target.baseUrl });
  const filePath = siteMemoryPath(config, { ...options, fingerprint });
  if (memoryConfig.mode === 'off') {
    return {
      enabled: false,
      filePath,
      loaded: false,
      reset: false,
      memory: createEmptySiteMemory(config, { ...options, fingerprint })
    };
  }
  if (memoryConfig.reset && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (!fs.existsSync(filePath)) {
    return {
      enabled: true,
      filePath,
      loaded: false,
      reset: memoryConfig.reset,
      memory: createEmptySiteMemory(config, { ...options, fingerprint })
    };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    enabled: true,
    filePath,
    loaded: true,
    reset: memoryConfig.reset,
    memory: normalizeSiteMemory(raw, config, { ...options, fingerprint })
  };
}

function saveSiteMemory(memory, config = {}, options = {}) {
  const memoryConfig = resolveMemoryConfig(config);
  const filePath = options.filePath || siteMemoryPath(config, options);
  if (memoryConfig.mode !== 'read-write') return { saved: false, filePath, reason: 'memory_not_writable' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = normalizeSiteMemory({
    ...memory,
    updatedAt: options.updatedAt || nowIso(options.now)
  }, config, options);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { saved: true, filePath };
}

function seedFrontierFromMemory(frontier, memory, config = {}, options = {}) {
  const memoryConfig = resolveMemoryConfig(config);
  if (!frontier || memoryConfig.mode === 'off') return { added: 0, skipped: 0, candidates: 0 };
  const now = options.now || Date.now;
  let added = 0;
  let skipped = 0;
  const candidates = (memory && memory.routes || [])
    .filter(route => route && route.url)
    .filter(route => route.confidence >= memoryConfig.minConfidence)
    .filter(route => !isStale(route, now))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, memoryConfig.maxSeedRoutes);
  for (const route of candidates) {
    if (frontier.enqueue(route.url, { depth: 0, source: 'memory' })) added += 1;
    else skipped += 1;
  }
  return { added, skipped, candidates: candidates.length };
}

function recordRouteOutcome(memory, routeResult = {}, config = {}, options = {}) {
  if (!memory || !routeResult || !routeResult.route || !routeResult.route.url) return null;
  const now = options.now || Date.now;
  const route = routeResult.route;
  const pageModel = routeResult.pageModel || {};
  const record = upsert(memory.routes, 'url', route.url, () => ({
    url: route.url,
    routeShape: pageModel.routeShape || route.routeShape || null,
    source: route.source || 'discovered'
  }));
  applyOutcome(record, Boolean(routeResult.ok), {
    now,
    staleAfterDays: resolveMemoryConfig(config).staleAfterDays,
    siteFingerprint: memory.siteFingerprint,
    appBuildFingerprint: memory.appBuildFingerprint,
    failureReason: routeResult.error || null
  });
  return record;
}

function recordActionOutcome(memory, actionResult = {}, config = {}, options = {}) {
  if (!memory || !actionResult || !actionResult.action) return null;
  const now = options.now || Date.now;
  const action = actionResult.action;
  const routeUrl = actionResult.before && actionResult.before.url || null;
  const signature = actionSignature(action, routeUrl);
  const changed = Boolean(actionResult.ok && actionResult.transition && actionResult.transition.changed);
  const noProgress = Boolean(actionResult.transition && actionResult.transition.noProgress) || !changed;
  const record = upsert(memory.selectors, 'signature', signature, () => ({
    signature,
    routeUrl,
    actionId: action.id || null,
    kind: action.kind || null,
    label: action.label || null,
    selector: action.selector || null
  }));
  applyOutcome(record, changed, {
    now,
    staleAfterDays: resolveMemoryConfig(config).staleAfterDays,
    siteFingerprint: memory.siteFingerprint,
    appBuildFingerprint: memory.appBuildFingerprint,
    failureReason: actionResult.error || (noProgress ? 'no_progress' : null)
  });
  if (noProgress || actionResult.error) {
    const negative = upsert(memory.negativeMemory, 'signature', signature, () => ({
      signature,
      routeUrl,
      actionId: action.id || null,
      kind: action.kind || null,
      label: action.label || null,
      selector: action.selector || null,
      reason: actionResult.error || 'no_progress'
    }));
    applyOutcome(negative, false, {
      now,
      staleAfterDays: resolveMemoryConfig(config).staleAfterDays,
      siteFingerprint: memory.siteFingerprint,
      appBuildFingerprint: memory.appBuildFingerprint,
      failureReason: actionResult.error || 'no_progress'
    });
  }
  return record;
}

function recordFormOutcome(memory, formResult = {}, routeUrl = null, config = {}, options = {}) {
  if (!memory || !formResult || !formResult.formId) return null;
  const now = options.now || Date.now;
  const signature = `form|${routeUrl || ''}|${formResult.formId}`;
  const success = Boolean(formResult.submitted && !(formResult.invalid || formResult.validationFeedback && formResult.validationFeedback.hasFeedback));
  const record = upsert(memory.selectors, 'signature', signature, () => ({
    signature,
    routeUrl,
    formId: formResult.formId,
    kind: 'form',
    reason: formResult.reason || null
  }));
  applyOutcome(record, success, {
    now,
    staleAfterDays: resolveMemoryConfig(config).staleAfterDays,
    siteFingerprint: memory.siteFingerprint,
    appBuildFingerprint: memory.appBuildFingerprint,
    failureReason: success ? null : formResult.reason || 'form_not_successful'
  });
  return record;
}

function recordEndpoints(memory, events = [], routeUrl = null, config = {}, options = {}) {
  if (!memory || !Array.isArray(events)) return 0;
  let added = 0;
  for (const event of events) {
    const url = event && (event.url || event.href);
    const pathValue = event && (event.path || event.pathname);
    if (!url && !pathValue) continue;
    const signature = `${event.method || 'GET'} ${pathValue || url}`;
    const record = upsert(memory.endpoints, 'signature', signature, () => ({
      signature,
      routeUrl,
      method: event.method || 'GET',
      path: pathValue || null,
      url: url || null,
      source: event.type || 'runtime'
    }));
    applyOutcome(record, true, {
      now: options.now || Date.now,
      staleAfterDays: resolveMemoryConfig(config).staleAfterDays,
      siteFingerprint: memory.siteFingerprint,
      appBuildFingerprint: memory.appBuildFingerprint
    });
    added += 1;
  }
  return added;
}

function shouldSuppressAction(memory, action = {}, routeUrl = null, config = {}, options = {}) {
  const memoryConfig = resolveMemoryConfig(config);
  if (!memory || memoryConfig.mode === 'off') return false;
  const signature = actionSignature(action, routeUrl);
  const record = (memory.negativeMemory || []).find(item => item.signature === signature);
  if (!record) return false;
  if (isStale(record, options.now || Date.now)) return false;
  return Number(record.failureCount || 0) > 0 && Number(record.failureCount || 0) >= Number(record.successCount || 0);
}

function summarizeSiteMemory(memory, loadResult = {}, saveResult = {}) {
  const source = memory || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: Boolean(loadResult.enabled),
    mode: loadResult.mode || null,
    filePath: loadResult.filePath || saveResult.filePath || null,
    loaded: Boolean(loadResult.loaded),
    saved: Boolean(saveResult.saved),
    reset: Boolean(loadResult.reset),
    siteFingerprint: source.siteFingerprint || null,
    counts: {
      routes: Array.isArray(source.routes) ? source.routes.length : 0,
      selectors: Array.isArray(source.selectors) ? source.selectors.length : 0,
      endpoints: Array.isArray(source.endpoints) ? source.endpoints.length : 0,
      negativeMemory: Array.isArray(source.negativeMemory) ? source.negativeMemory.length : 0
    },
    routes: (source.routes || []).slice(0, 50),
    negativeMemory: (source.negativeMemory || []).slice(0, 50)
  };
}

function actionSignature(action = {}, routeUrl = null) {
  return stableHash([
    routeUrl || '',
    action.kind || '',
    action.selector || '',
    action.href || '',
    action.id || '',
    action.label || ''
  ].join('|'), 24);
}

function applyOutcome(record, success, options = {}) {
  record.schemaVersion = record.schemaVersion || `${SCHEMA_VERSION}-record`;
  record.sdkVersion = SDK_VERSION;
  record.siteFingerprint = options.siteFingerprint || record.siteFingerprint || null;
  record.appBuildFingerprint = options.appBuildFingerprint || record.appBuildFingerprint || null;
  record.staleAfterDays = Number(options.staleAfterDays || record.staleAfterDays || DEFAULT_STALE_AFTER_DAYS);
  record.lastValidatedAt = nowIso(options.now);
  if (success) record.successCount = Number(record.successCount || 0) + 1;
  else record.failureCount = Number(record.failureCount || 0) + 1;
  record.confidence = confidenceFromCounts(record.successCount, record.failureCount);
  if (options.failureReason) record.lastFailureReason = options.failureReason;
}

function upsert(collection, key, value, create) {
  let record = collection.find(item => item && item[key] === value);
  if (!record) {
    record = create();
    collection.push(record);
  }
  return record;
}

function confidenceFromCounts(successCount = 0, failureCount = 0) {
  const successes = Number(successCount || 0);
  const failures = Number(failureCount || 0);
  if (successes + failures === 0) return 0.5;
  return clamp((successes + 1) / (successes + failures + 2), 0, 1);
}

function isStale(record = {}, now = Date.now) {
  if (!record.lastValidatedAt) return false;
  const staleAfterDays = Number(record.staleAfterDays || DEFAULT_STALE_AFTER_DAYS);
  const ageMs = now() - new Date(record.lastValidatedAt).getTime();
  return ageMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  SCHEMA_VERSION,
  SDK_VERSION,
  actionSignature,
  createEmptySiteMemory,
  isStale,
  loadSiteMemory,
  normalizeSiteMemory,
  recordActionOutcome,
  recordEndpoints,
  recordFormOutcome,
  recordRouteOutcome,
  resolveMemoryConfig,
  saveSiteMemory,
  seedFrontierFromMemory,
  shouldSuppressAction,
  siteMemoryPath,
  summarizeSiteMemory
};
