'use strict';

const fs = require('fs');
const path = require('path');
const extensionResolver = require('../browser/extensionResolver.cjs');
const {
  BudgetValidationError,
  DEFAULT_CRAWLER_BUDGETS,
  normalizeBudgets,
  normalizeCrawlerBudgets
} = require('./budgets.cjs');

const CONFIG_VERSION = 'ptk-agent-v2-config';
const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)/i;
const PRIVATE_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ENCODED_PRIVATE_VALUE_PATTERN = /\b[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PRIVATE_KEY_PATTERN = /^(?:username|email|login|user)$/i;
const PRIVATE_QUERY_KEY_PATTERN = /^(?:username|email|login|user)$/i;
const SAFE_SENSITIVE_BOOLEAN_KEY_PATTERN = /^(?:sessionLost)$/i;

const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  target: {
    baseUrl: 'http://localhost:3000',
    scope: {
      include: ['http://localhost:3000/**'],
      exclude: []
    }
  },
  crawler: {
    enabled: true,
    ...DEFAULT_CRAWLER_BUDGETS,
    preserveSpaHashRoutes: true,
    salvageTimedOutRoutes: true,
    routeHints: [],
    routeHintsFile: null,
    forms: {
      enabled: true,
      allowSearch: true,
      allowContact: true,
      allowFeedback: true,
      allowAuth: false,
      allowBusinessMutation: false
    },
    codeSignals: {
      enabled: false,
      mode: 'off',
      maxScripts: 8,
      maxScriptBytes: 2000000,
      maxTotalBytes: 5000000,
      maxSignalMs: 500,
      seedRoutes: false,
      includeSourceMaps: false,
      includeExternalScripts: false
    },
    surfaceExplorer: {
      enabled: true,
      maxExpansionsPerRoute: 5,
      maxNestedExpansions: 5,
      maxMenuActionsPerSurface: 8,
      maxRouteChangingMenuActions: 8,
      reopenSurfaceBetweenMenuActions: true,
      maxExpansionMs: 1000
    }
  },
  browserProbe: {
    enabled: true,
    maxNodes: 1500,
    maxControls: 300,
    maxRoutes: 500,
    maxTextChars: 8000,
    observeMutations: true,
    redactValues: true
  },
  scenario: {
    enabled: false,
    file: null,
    continueOnFailure: false
  },
  agent: {
    enabled: false,
    mode: 'off',
    provider: 'mock',
    model: null,
    maxTurns: 3,
    maxStepsPerTurn: 1,
    fallback: 'fail',
    maxProviderMs: 60000,
    riskMode: 'safe',
    allowBusinessMutations: false,
    allowDestructiveActions: false,
    requireSuccess: false
  },
  profile: {
    file: null,
    activePersonaId: null,
    username: null,
    password: null,
    includeSecrets: false,
    credentials: {},
    values: {},
    personas: [],
    addresses: [],
    paymentMethods: [],
    businessEntities: [],
    searchTerms: [],
    uploadFixtures: [],
    workflowHints: []
  },
  memory: {
    mode: 'off',
    storageDir: '.ptk/site-memory',
    reset: false,
    staleAfterDays: 14,
    minConfidence: 0.25,
    maxSeedRoutes: 25
  },
  engines: {
    dast: { enabled: true, modulePacks: ['free'] },
    iast: { enabled: true, modulePacks: ['free'] },
    sast: { enabled: false, modulePacks: ['free'] },
    sca: { enabled: false, modulePacks: [] }
  },
  modules: {
    packs: ['free'],
    cacheDir: '.ptk/modules',
    verifySignatures: true,
    allowUnsigned: false,
    allowNetworkDownloads: false,
    portal: {
      baseUrl: null,
      tokenEnv: 'PTK_PORTAL_TOKEN'
    }
  },
  browser: {
    name: 'chromium',
    headless: true,
    executablePath: null,
    profileDir: null,
    firefoxXpi: null,
    launchTimeoutMs: 30000,
    viewport: { width: 1280, height: 800 }
  },
  ptk: {
    enabled: true,
    extensionPath: null,
    autoDetectExtension: true,
    requireBridge: false,
    requireFindingsExport: false,
    allowMissing: true,
    exportDrainMs: 30000,
    drainMode: 'off',
    drainTimeoutMs: 0,
    requireAttackCompletion: false,
    stopWaitForIdle: false,
    immediateAnalysis: true
  },
  artifacts: {
    outputDir: '.ptk/artifacts',
    formats: ['json']
  },
  ci: {
    failOn: {
      severity: ['critical', 'high'],
      confidence: ['confirmed', 'high']
    },
    noFail: false
  }
});

const TOP_LEVEL_KEYS = Object.freeze(['version', 'target', 'crawler', 'browserProbe', 'scenario', 'agent', 'profile', 'memory', 'engines', 'modules', 'browser', 'ptk', 'artifacts', 'ci']);
const NESTED_KEYS = Object.freeze({
  target: ['baseUrl', 'scope'],
  'target.scope': ['include', 'exclude'],
  crawler: ['enabled', ...Object.keys(DEFAULT_CRAWLER_BUDGETS), 'waitBudgetMs', 'perRouteBudgetMs', 'preserveSpaHashRoutes', 'salvageTimedOutRoutes', 'routeHints', 'routeHintsFile', 'forms', 'codeSignals', 'surfaceExplorer'],
  'crawler.forms': ['enabled', 'allowSearch', 'allowContact', 'allowFeedback', 'allowAuth', 'allowBusinessMutation'],
  'crawler.codeSignals': ['enabled', 'mode', 'maxScripts', 'maxScriptBytes', 'maxTotalBytes', 'maxSignalMs', 'seedRoutes', 'includeSourceMaps', 'includeExternalScripts'],
  'crawler.surfaceExplorer': ['enabled', 'maxExpansionsPerRoute', 'maxNestedExpansions', 'maxMenuActionsPerSurface', 'maxRouteChangingMenuActions', 'reopenSurfaceBetweenMenuActions', 'maxExpansionMs', 'maxSurfaceMs'],
  browserProbe: ['enabled', 'maxNodes', 'maxControls', 'maxRoutes', 'maxTextChars', 'observeMutations', 'redactValues'],
  scenario: ['enabled', 'file', 'continueOnFailure'],
  agent: ['enabled', 'mode', 'provider', 'model', 'maxTurns', 'maxStepsPerTurn', 'fallback', 'maxProviderMs', 'riskMode', 'allowBusinessMutations', 'allowDestructiveActions', 'requireSuccess'],
  profile: ['file', 'activePersonaId', 'username', 'password', 'includeSecrets', 'credentials', 'values', 'personas', 'addresses', 'paymentMethods', 'businessEntities', 'searchTerms', 'uploadFixtures', 'workflowHints'],
  memory: ['mode', 'storageDir', 'reset', 'staleAfterDays', 'minConfidence', 'maxSeedRoutes'],
  engines: ['dast', 'iast', 'sast', 'sca'],
  'engines.engine': ['enabled', 'modulePacks'],
  modules: ['packs', 'cacheDir', 'verifySignatures', 'allowUnsigned', 'allowNetworkDownloads', 'portal'],
  'modules.portal': ['baseUrl', 'tokenEnv'],
  browser: ['name', 'headless', 'executablePath', 'profileDir', 'firefoxXpi', 'launchTimeoutMs', 'viewport'],
  'browser.viewport': ['width', 'height'],
  ptk: ['enabled', 'extensionPath', 'autoDetectExtension', 'requireBridge', 'requireFindingsExport', 'allowMissing', 'exportDrainMs', 'drainMode', 'drainTimeoutMs', 'requireAttackCompletion', 'stopWaitForIdle', 'immediateAnalysis'],
  artifacts: ['outputDir', 'formats'],
  ci: ['failOn', 'noFail'],
  'ci.failOn': ['severity', 'confidence']
});

class ConfigValidationError extends Error {
  constructor(errors) {
    super(`Invalid PTK Agents SDK config: ${errors.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.code = 'ERR_PTK_AGENT_CONFIG';
    this.errors = errors;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (override === undefined || override === null) {
    return clone(base);
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return Array.isArray(override) ? override.slice() : clone(override);
  }

  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigValidationError([`Invalid JSON in ${filePath}: ${err.message}`]);
  }
}

function makeScopeGlob(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/**`;
}

function validateUnknownKeys(object, allowed, label, errors) {
  if (!isPlainObject(object)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push(`${label}.${key} is not a supported config key`);
    }
  }
}

function normalizeBaseUrl(value, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push('target.baseUrl must be a non-empty absolute http(s) URL');
    return value;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push('target.baseUrl must use http or https');
    }
    return url.href.replace(/\/$/, '');
  } catch (_err) {
    errors.push('target.baseUrl must be a valid absolute URL');
    return value;
  }
}

function normalizeStringArray(value, label, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`${label}[${index}] must be a non-empty string`);
    }
  }
  if (options.minItems && value.length < options.minItems) {
    errors.push(`${label} must contain at least ${options.minItems} item`);
  }
  return value.slice();
}

function normalizeArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  return value.slice();
}

function normalizeRouteHints(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of route-hint strings or objects`);
    return [];
  }
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      if (item.trim() === '') errors.push(`${label}[${index}] must be a non-empty route hint`);
      continue;
    }
    if (!isPlainObject(item)) {
      errors.push(`${label}[${index}] must be a route-hint string or object`);
      continue;
    }
    const candidate = item.url || item.href || item.route || item.path || item.entryPoint || item.entrypoint;
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      errors.push(`${label}[${index}] must include url, href, route, path, entryPoint, or entrypoint`);
    }
  }
  return value.slice();
}

function normalizeNullableString(value, label, errors) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} must be null or a non-empty string`);
    return value;
  }
  return value;
}

function isPtkExtensionDir(candidate) {
  return extensionResolver.isPtkExtensionDir(candidate);
}

function ancestorDirs(startDir) {
  const out = [];
  let current = path.resolve(startDir || process.cwd());
  while (!out.includes(current)) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function findPtkExtensionPath({ cwd = process.cwd(), configPath = null } = {}) {
  return extensionResolver.findLocalDevExtensionPath({ cwd, configPath });
}

function resolvePtkExtensionPath(config = {}, { cwd = process.cwd(), configPath = null } = {}) {
  if (!config.ptk || config.ptk.enabled === false) return config;
  const resolution = extensionResolver.resolvePtkExtensionPath({
    configuredPath: config.ptk.extensionPath,
    autoDetectExtension: config.ptk.autoDetectExtension,
    cwd,
    configPath
  });
  config.ptk.extensionPath = resolution.path;
  Object.defineProperty(config, '_ptkExtensionResolution', {
    configurable: true,
    enumerable: false,
    value: resolution
  });
  return config;
}

function routeHintsFromFilePayload(payload) {
  if (Array.isArray(payload)) return payload.slice();
  if (!isPlainObject(payload)) return [payload];
  for (const key of ['routeHints', 'routes', 'urls', 'paths', 'sitemap', 'hiddenRoutes']) {
    if (Array.isArray(payload[key])) return payload[key].slice();
  }
  return [payload];
}

function resolveCrawlerRouteHints(config = {}, { cwd = process.cwd(), configPath = null } = {}) {
  const crawler = config.crawler || {};
  if (!crawler.routeHintsFile) return config;
  if (typeof crawler.routeHintsFile !== 'string' || crawler.routeHintsFile.trim() === '') return config;
  const baseDir = configPath ? path.dirname(path.resolve(configPath)) : cwd;
  const hintsPath = path.isAbsolute(crawler.routeHintsFile)
    ? crawler.routeHintsFile
    : path.resolve(baseDir, crawler.routeHintsFile);
  if (!fs.existsSync(hintsPath)) {
    throw new ConfigValidationError([`crawler.routeHintsFile not found: ${crawler.routeHintsFile}`]);
  }
  const payload = readJson(hintsPath);
  crawler.routeHints = [
    ...(Array.isArray(crawler.routeHints) ? crawler.routeHints : []),
    ...routeHintsFromFilePayload(payload)
  ];
  config.crawler = crawler;
  return config;
}

function resolveProfileData(config = {}, { cwd = process.cwd() } = {}) {
  const { applyProfileOverrides, loadCrawlData } = require('../profiles/crawlData.cjs');
  const profile = config.profile || {};
  const loaded = profile.file ? loadCrawlData(profile.file, { cwd }) : loadCrawlData(profile);
  const merged = deepMerge(loaded, {
    ...profile,
    personas: Array.isArray(profile.personas) && profile.personas.length ? profile.personas : loaded.personas
  });
  config.profile = applyProfileOverrides(merged, {
    username: profile.username,
    password: profile.password
  });
  config.profile.includeSecrets = profile.includeSecrets === true;
  if (profile.activePersonaId) config.profile.activePersonaId = profile.activePersonaId;
  return config;
}

function normalizeBoolean(value, label, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return Boolean(value);
  }
  return value;
}

function normalizeInteger(value, label, errors, minimum) {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : NaN);
  if (!Number.isInteger(number) || number < minimum) {
    errors.push(`${label} must be an integer >= ${minimum}`);
    return value;
  }
  return number;
}

function validateConfig(config) {
  const errors = [];
  validateUnknownKeys(config, TOP_LEVEL_KEYS, 'config', errors);

  if (config.version !== CONFIG_VERSION) {
    errors.push(`version must be "${CONFIG_VERSION}"`);
  }

  validateUnknownKeys(config.target, NESTED_KEYS.target, 'target', errors);
  validateUnknownKeys(config.target && config.target.scope, NESTED_KEYS['target.scope'], 'target.scope', errors);
  validateUnknownKeys(config.crawler, NESTED_KEYS.crawler, 'crawler', errors);
  validateUnknownKeys(config.browserProbe, NESTED_KEYS.browserProbe, 'browserProbe', errors);
  validateUnknownKeys(config.scenario, NESTED_KEYS.scenario, 'scenario', errors);
  validateUnknownKeys(config.agent, NESTED_KEYS.agent, 'agent', errors);
  validateUnknownKeys(config.profile, NESTED_KEYS.profile, 'profile', errors);
  validateUnknownKeys(config.memory, NESTED_KEYS.memory, 'memory', errors);
  validateUnknownKeys(config.engines, NESTED_KEYS.engines, 'engines', errors);
  validateUnknownKeys(config.modules, NESTED_KEYS.modules, 'modules', errors);
  validateUnknownKeys(config.browser, NESTED_KEYS.browser, 'browser', errors);
  validateUnknownKeys(config.ptk, NESTED_KEYS.ptk, 'ptk', errors);
  validateUnknownKeys(config.artifacts, NESTED_KEYS.artifacts, 'artifacts', errors);
  validateUnknownKeys(config.ci, NESTED_KEYS.ci, 'ci', errors);

  if (isPlainObject(config.target)) {
    config.target.baseUrl = normalizeBaseUrl(config.target.baseUrl, errors);
    if (isPlainObject(config.target.scope)) {
      config.target.scope.include = normalizeStringArray(config.target.scope.include, 'target.scope.include', errors, {
        minItems: 1
      });
      config.target.scope.exclude = normalizeStringArray(config.target.scope.exclude, 'target.scope.exclude', errors);
    }
  }

  if (isPlainObject(config.crawler)) {
    config.crawler.enabled = normalizeBoolean(config.crawler.enabled, 'crawler.enabled', errors);
    config.crawler.preserveSpaHashRoutes = normalizeBoolean(config.crawler.preserveSpaHashRoutes, 'crawler.preserveSpaHashRoutes', errors);
    config.crawler.salvageTimedOutRoutes = normalizeBoolean(config.crawler.salvageTimedOutRoutes, 'crawler.salvageTimedOutRoutes', errors);
    config.crawler.routeHints = normalizeRouteHints(config.crawler.routeHints, 'crawler.routeHints', errors);
    config.crawler.routeHintsFile = normalizeNullableString(config.crawler.routeHintsFile, 'crawler.routeHintsFile', errors);
    validateUnknownKeys(config.crawler.forms, NESTED_KEYS['crawler.forms'], 'crawler.forms', errors);
    if (isPlainObject(config.crawler.forms)) {
      config.crawler.forms.enabled = normalizeBoolean(config.crawler.forms.enabled, 'crawler.forms.enabled', errors);
      config.crawler.forms.allowSearch = normalizeBoolean(config.crawler.forms.allowSearch, 'crawler.forms.allowSearch', errors);
      config.crawler.forms.allowContact = normalizeBoolean(config.crawler.forms.allowContact, 'crawler.forms.allowContact', errors);
      config.crawler.forms.allowFeedback = normalizeBoolean(config.crawler.forms.allowFeedback, 'crawler.forms.allowFeedback', errors);
      config.crawler.forms.allowAuth = normalizeBoolean(config.crawler.forms.allowAuth, 'crawler.forms.allowAuth', errors);
      config.crawler.forms.allowBusinessMutation = normalizeBoolean(config.crawler.forms.allowBusinessMutation, 'crawler.forms.allowBusinessMutation', errors);
    }
    validateUnknownKeys(config.crawler.codeSignals, NESTED_KEYS['crawler.codeSignals'], 'crawler.codeSignals', errors);
    if (isPlainObject(config.crawler.codeSignals)) {
      config.crawler.codeSignals.enabled = normalizeBoolean(config.crawler.codeSignals.enabled, 'crawler.codeSignals.enabled', errors);
      if (!['off', 'safe', 'wide'].includes(config.crawler.codeSignals.mode)) {
        errors.push('crawler.codeSignals.mode must be one of: off, safe, wide');
      }
      config.crawler.codeSignals.maxScripts = normalizeInteger(config.crawler.codeSignals.maxScripts, 'crawler.codeSignals.maxScripts', errors, 1);
      config.crawler.codeSignals.maxScriptBytes = normalizeInteger(config.crawler.codeSignals.maxScriptBytes, 'crawler.codeSignals.maxScriptBytes', errors, 1);
      config.crawler.codeSignals.maxTotalBytes = normalizeInteger(config.crawler.codeSignals.maxTotalBytes, 'crawler.codeSignals.maxTotalBytes', errors, 1);
      config.crawler.codeSignals.maxSignalMs = normalizeInteger(config.crawler.codeSignals.maxSignalMs, 'crawler.codeSignals.maxSignalMs', errors, 1);
      config.crawler.codeSignals.seedRoutes = normalizeBoolean(config.crawler.codeSignals.seedRoutes, 'crawler.codeSignals.seedRoutes', errors);
      config.crawler.codeSignals.includeSourceMaps = normalizeBoolean(config.crawler.codeSignals.includeSourceMaps, 'crawler.codeSignals.includeSourceMaps', errors);
      config.crawler.codeSignals.includeExternalScripts = normalizeBoolean(config.crawler.codeSignals.includeExternalScripts, 'crawler.codeSignals.includeExternalScripts', errors);
    }
    validateUnknownKeys(config.crawler.surfaceExplorer, NESTED_KEYS['crawler.surfaceExplorer'], 'crawler.surfaceExplorer', errors);
    if (isPlainObject(config.crawler.surfaceExplorer)) {
      config.crawler.surfaceExplorer.enabled = normalizeBoolean(config.crawler.surfaceExplorer.enabled, 'crawler.surfaceExplorer.enabled', errors);
      config.crawler.surfaceExplorer.maxExpansionsPerRoute = normalizeInteger(config.crawler.surfaceExplorer.maxExpansionsPerRoute, 'crawler.surfaceExplorer.maxExpansionsPerRoute', errors, 0);
      config.crawler.surfaceExplorer.maxNestedExpansions = normalizeInteger(config.crawler.surfaceExplorer.maxNestedExpansions, 'crawler.surfaceExplorer.maxNestedExpansions', errors, 0);
      config.crawler.surfaceExplorer.maxMenuActionsPerSurface = normalizeInteger(config.crawler.surfaceExplorer.maxMenuActionsPerSurface, 'crawler.surfaceExplorer.maxMenuActionsPerSurface', errors, 0);
      config.crawler.surfaceExplorer.maxRouteChangingMenuActions = normalizeInteger(config.crawler.surfaceExplorer.maxRouteChangingMenuActions, 'crawler.surfaceExplorer.maxRouteChangingMenuActions', errors, 0);
      config.crawler.surfaceExplorer.reopenSurfaceBetweenMenuActions = normalizeBoolean(config.crawler.surfaceExplorer.reopenSurfaceBetweenMenuActions, 'crawler.surfaceExplorer.reopenSurfaceBetweenMenuActions', errors);
      config.crawler.surfaceExplorer.maxExpansionMs = normalizeInteger(config.crawler.surfaceExplorer.maxExpansionMs, 'crawler.surfaceExplorer.maxExpansionMs', errors, 1);
      if (config.crawler.surfaceExplorer.maxSurfaceMs !== undefined && config.crawler.surfaceExplorer.maxSurfaceMs !== null) {
        config.crawler.surfaceExplorer.maxSurfaceMs = normalizeInteger(config.crawler.surfaceExplorer.maxSurfaceMs, 'crawler.surfaceExplorer.maxSurfaceMs', errors, 1);
      } else {
        config.crawler.surfaceExplorer.maxSurfaceMs = null;
      }
    }
    try {
      config.crawler = normalizeCrawlerBudgets(config.crawler);
    } catch (error) {
      if (error instanceof BudgetValidationError) {
        errors.push(...error.errors);
      } else {
        throw error;
      }
    }
  }

  if (isPlainObject(config.browserProbe)) {
    config.browserProbe.enabled = normalizeBoolean(config.browserProbe.enabled, 'browserProbe.enabled', errors);
    config.browserProbe.maxNodes = normalizeInteger(config.browserProbe.maxNodes, 'browserProbe.maxNodes', errors, 1);
    config.browserProbe.maxControls = normalizeInteger(config.browserProbe.maxControls, 'browserProbe.maxControls', errors, 1);
    config.browserProbe.maxRoutes = normalizeInteger(config.browserProbe.maxRoutes, 'browserProbe.maxRoutes', errors, 1);
    config.browserProbe.maxTextChars = normalizeInteger(config.browserProbe.maxTextChars, 'browserProbe.maxTextChars', errors, 0);
    config.browserProbe.observeMutations = normalizeBoolean(config.browserProbe.observeMutations, 'browserProbe.observeMutations', errors);
    config.browserProbe.redactValues = normalizeBoolean(config.browserProbe.redactValues, 'browserProbe.redactValues', errors);
  }

  if (isPlainObject(config.scenario)) {
    config.scenario.enabled = normalizeBoolean(config.scenario.enabled, 'scenario.enabled', errors);
    config.scenario.file = normalizeNullableString(config.scenario.file, 'scenario.file', errors);
    config.scenario.continueOnFailure = normalizeBoolean(config.scenario.continueOnFailure, 'scenario.continueOnFailure', errors);
    if (config.scenario.enabled && config.scenario.file === null) {
      errors.push('scenario.file must be set when scenario.enabled is true');
    }
  }

  if (isPlainObject(config.agent)) {
    config.agent.enabled = normalizeBoolean(config.agent.enabled, 'agent.enabled', errors);
    if (!['off', 'mock', 'manager', 'provider', 'browser'].includes(config.agent.mode)) {
      errors.push('agent.mode must be one of: off, mock, manager, provider, browser');
    }
    if (config.agent.enabled && config.agent.mode === 'off') {
      errors.push('agent.enabled cannot be true when agent.mode is off');
    }
    config.agent.provider = normalizeNullableString(config.agent.provider, 'agent.provider', errors) || 'mock';
    config.agent.model = normalizeNullableString(config.agent.model, 'agent.model', errors);
    config.agent.maxTurns = normalizeInteger(config.agent.maxTurns, 'agent.maxTurns', errors, 0);
    config.agent.maxStepsPerTurn = normalizeInteger(config.agent.maxStepsPerTurn, 'agent.maxStepsPerTurn', errors, 1);
    config.agent.maxProviderMs = normalizeInteger(config.agent.maxProviderMs, 'agent.maxProviderMs', errors, 1);
    if (!['safe', 'business', 'destructive'].includes(config.agent.riskMode)) {
      errors.push('agent.riskMode must be one of: safe, business, destructive');
    }
    config.agent.allowBusinessMutations = normalizeBoolean(config.agent.allowBusinessMutations, 'agent.allowBusinessMutations', errors);
    config.agent.allowDestructiveActions = normalizeBoolean(config.agent.allowDestructiveActions, 'agent.allowDestructiveActions', errors);
    config.agent.requireSuccess = normalizeBoolean(config.agent.requireSuccess, 'agent.requireSuccess', errors);
    if (config.agent.allowDestructiveActions && !config.agent.allowBusinessMutations) {
      config.agent.allowBusinessMutations = true;
    }
    if (config.agent.riskMode === 'destructive' && !config.agent.allowDestructiveActions) {
      errors.push('agent.riskMode destructive requires agent.allowDestructiveActions=true');
    }
    if (config.agent.riskMode === 'business' && !config.agent.allowBusinessMutations) {
      config.agent.allowBusinessMutations = true;
    }
    if (config.agent.fallback !== 'fail') {
      errors.push('agent.fallback must be fail; hidden fallback is not supported');
    }
  }

  if (isPlainObject(config.profile)) {
    config.profile.file = normalizeNullableString(config.profile.file, 'profile.file', errors);
    config.profile.activePersonaId = normalizeNullableString(config.profile.activePersonaId, 'profile.activePersonaId', errors);
    config.profile.username = normalizeNullableString(config.profile.username, 'profile.username', errors);
    config.profile.password = normalizeNullableString(config.profile.password, 'profile.password', errors);
    config.profile.includeSecrets = normalizeBoolean(config.profile.includeSecrets, 'profile.includeSecrets', errors);
    if (!isPlainObject(config.profile.credentials)) errors.push('profile.credentials must be an object');
    if (!isPlainObject(config.profile.values)) errors.push('profile.values must be an object');
    config.profile.personas = normalizeArray(config.profile.personas, 'profile.personas', errors);
    config.profile.addresses = normalizeArray(config.profile.addresses, 'profile.addresses', errors);
    config.profile.paymentMethods = normalizeArray(config.profile.paymentMethods, 'profile.paymentMethods', errors);
    config.profile.businessEntities = normalizeArray(config.profile.businessEntities, 'profile.businessEntities', errors);
    config.profile.searchTerms = normalizeArray(config.profile.searchTerms, 'profile.searchTerms', errors);
    config.profile.uploadFixtures = normalizeArray(config.profile.uploadFixtures, 'profile.uploadFixtures', errors);
    config.profile.workflowHints = normalizeArray(config.profile.workflowHints, 'profile.workflowHints', errors);
  }

  if (isPlainObject(config.memory)) {
    if (!['off', 'read', 'read-write'].includes(config.memory.mode)) {
      errors.push('memory.mode must be one of: off, read, read-write');
    }
    if (typeof config.memory.storageDir !== 'string' || config.memory.storageDir.trim() === '') {
      errors.push('memory.storageDir must be a non-empty string');
    }
    config.memory.reset = normalizeBoolean(config.memory.reset, 'memory.reset', errors);
    config.memory.staleAfterDays = normalizeInteger(config.memory.staleAfterDays, 'memory.staleAfterDays', errors, 1);
    const minConfidence = typeof config.memory.minConfidence === 'number'
      ? config.memory.minConfidence
      : (typeof config.memory.minConfidence === 'string' && config.memory.minConfidence.trim() !== '' ? Number(config.memory.minConfidence) : NaN);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      errors.push('memory.minConfidence must be a number between 0 and 1');
    } else {
      config.memory.minConfidence = minConfidence;
    }
    config.memory.maxSeedRoutes = normalizeInteger(config.memory.maxSeedRoutes, 'memory.maxSeedRoutes', errors, 0);
  }

  if (isPlainObject(config.engines)) {
    for (const engineName of NESTED_KEYS.engines) {
      validateUnknownKeys(config.engines[engineName], NESTED_KEYS['engines.engine'], `engines.${engineName}`, errors);
      if (isPlainObject(config.engines[engineName])) {
        config.engines[engineName].enabled = normalizeBoolean(config.engines[engineName].enabled, `engines.${engineName}.enabled`, errors);
        config.engines[engineName].modulePacks = normalizeStringArray(config.engines[engineName].modulePacks, `engines.${engineName}.modulePacks`, errors);
      }
    }
  }

  if (isPlainObject(config.modules)) {
    validateUnknownKeys(config.modules, NESTED_KEYS.modules, 'modules', errors);
    config.modules.packs = normalizeStringArray(config.modules.packs, 'modules.packs', errors);
    if (typeof config.modules.cacheDir !== 'string' || config.modules.cacheDir.trim() === '') {
      errors.push('modules.cacheDir must be a non-empty string');
    }
    config.modules.verifySignatures = normalizeBoolean(config.modules.verifySignatures, 'modules.verifySignatures', errors);
    config.modules.allowUnsigned = normalizeBoolean(config.modules.allowUnsigned, 'modules.allowUnsigned', errors);
    config.modules.allowNetworkDownloads = normalizeBoolean(config.modules.allowNetworkDownloads, 'modules.allowNetworkDownloads', errors);
    validateUnknownKeys(config.modules.portal, NESTED_KEYS['modules.portal'], 'modules.portal', errors);
    if (isPlainObject(config.modules.portal)) {
      config.modules.portal.baseUrl = normalizeNullableString(config.modules.portal.baseUrl, 'modules.portal.baseUrl', errors);
      if (typeof config.modules.portal.tokenEnv !== 'string' || config.modules.portal.tokenEnv.trim() === '') {
        errors.push('modules.portal.tokenEnv must be a non-empty string');
      }
    }
  }

  if (isPlainObject(config.browser)) {
    if (!['chromium', 'chrome', 'edge', 'firefox'].includes(config.browser.name)) {
      errors.push('browser.name must be one of: chromium, chrome, edge, firefox');
    }
    config.browser.headless = normalizeBoolean(config.browser.headless, 'browser.headless', errors);
    config.browser.executablePath = normalizeNullableString(config.browser.executablePath, 'browser.executablePath', errors);
    config.browser.profileDir = normalizeNullableString(config.browser.profileDir, 'browser.profileDir', errors);
    config.browser.firefoxXpi = normalizeNullableString(config.browser.firefoxXpi, 'browser.firefoxXpi', errors);
    config.browser.launchTimeoutMs = normalizeInteger(config.browser.launchTimeoutMs, 'browser.launchTimeoutMs', errors, 1);
    validateUnknownKeys(config.browser.viewport, NESTED_KEYS['browser.viewport'], 'browser.viewport', errors);
    if (isPlainObject(config.browser.viewport)) {
      config.browser.viewport.width = normalizeInteger(config.browser.viewport.width, 'browser.viewport.width', errors, 1);
      config.browser.viewport.height = normalizeInteger(config.browser.viewport.height, 'browser.viewport.height', errors, 1);
    }
    if (config.browser.firefoxXpi && config.browser.name !== 'firefox') {
      errors.push('browser.firefoxXpi requires browser.name to be firefox');
    }
  }

  if (isPlainObject(config.ptk)) {
    config.ptk.enabled = normalizeBoolean(config.ptk.enabled, 'ptk.enabled', errors);
    config.ptk.extensionPath = normalizeNullableString(config.ptk.extensionPath, 'ptk.extensionPath', errors);
    config.ptk.autoDetectExtension = normalizeBoolean(config.ptk.autoDetectExtension, 'ptk.autoDetectExtension', errors);
    config.ptk.requireBridge = normalizeBoolean(config.ptk.requireBridge, 'ptk.requireBridge', errors);
    config.ptk.requireFindingsExport = normalizeBoolean(config.ptk.requireFindingsExport, 'ptk.requireFindingsExport', errors);
    config.ptk.allowMissing = normalizeBoolean(config.ptk.allowMissing, 'ptk.allowMissing', errors);
    config.ptk.exportDrainMs = normalizeInteger(config.ptk.exportDrainMs, 'ptk.exportDrainMs', errors, 0);
    if (!['off', 'brief', 'until-idle', 'until-complete'].includes(config.ptk.drainMode)) {
      errors.push('ptk.drainMode must be one of: off, brief, until-idle, until-complete');
    }
    config.ptk.drainTimeoutMs = normalizeInteger(config.ptk.drainTimeoutMs, 'ptk.drainTimeoutMs', errors, 0);
    config.ptk.requireAttackCompletion = normalizeBoolean(config.ptk.requireAttackCompletion, 'ptk.requireAttackCompletion', errors);
    config.ptk.stopWaitForIdle = normalizeBoolean(config.ptk.stopWaitForIdle, 'ptk.stopWaitForIdle', errors);
    config.ptk.immediateAnalysis = normalizeBoolean(config.ptk.immediateAnalysis, 'ptk.immediateAnalysis', errors);
    if (['until-idle', 'until-complete'].includes(config.ptk.drainMode) && config.ptk.drainTimeoutMs <= 0) {
      errors.push('ptk.drainTimeoutMs must be greater than 0 when ptk.drainMode is until-idle or until-complete');
    }
  }

  if (isPlainObject(config.artifacts)) {
    if (typeof config.artifacts.outputDir !== 'string' || config.artifacts.outputDir.trim() === '') {
      errors.push('artifacts.outputDir must be a non-empty string');
    }
    config.artifacts.formats = normalizeStringArray(config.artifacts.formats, 'artifacts.formats', errors, {
      minItems: 1
    });
    if (Array.isArray(config.artifacts.formats) && !config.artifacts.formats.includes('json')) {
      errors.push('artifacts.formats must include json');
    }
  }

  if (isPlainObject(config.ci)) {
    validateUnknownKeys(config.ci, NESTED_KEYS.ci, 'ci', errors);
    config.ci.noFail = normalizeBoolean(config.ci.noFail, 'ci.noFail', errors);
    validateUnknownKeys(config.ci.failOn, NESTED_KEYS['ci.failOn'], 'ci.failOn', errors);
    if (isPlainObject(config.ci.failOn)) {
      config.ci.failOn.severity = normalizeStringArray(config.ci.failOn.severity, 'ci.failOn.severity', errors);
      config.ci.failOn.confidence = normalizeStringArray(config.ci.failOn.confidence, 'ci.failOn.confidence', errors);
    }
  }

  if (errors.length) {
    throw new ConfigValidationError(errors);
  }
  return true;
}

function shouldReplaceDefaultScope(previousConfig, overrides) {
  const previousInclude = previousConfig
    && previousConfig.target
    && previousConfig.target.scope
    && Array.isArray(previousConfig.target.scope.include)
    && previousConfig.target.scope.include.length === 1
    ? previousConfig.target.scope.include[0]
    : null;
  const previousBaseUrl = previousConfig && previousConfig.target && previousConfig.target.baseUrl;
  return overrides
    && overrides.target
    && typeof overrides.target.baseUrl === 'string'
    && (!overrides.target.scope || !overrides.target.scope.include)
    && previousInclude
    && (
      previousInclude === DEFAULT_CONFIG.target.scope.include[0]
      || previousInclude === makeScopeGlob(previousBaseUrl)
    );
}

function redactSecrets(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactSecrets(item, seen));
  }
  if (typeof value === 'string') {
    return redactSecretString(value);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (!isJsonPlainObject(value)) {
    return redactNonPlainObject(value, seen);
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = (SECRET_KEY_PATTERN.test(key) || PRIVATE_KEY_PATTERN.test(key)) && shouldRedactValueForKey(key, item)
      ? REDACTED
      : redactSecrets(item, seen);
  }
  return output;
}

function isJsonPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactNonPlainObject(value, seen = new WeakSet()) {
  if (value instanceof Date) return value.toISOString();
  if (typeof URL !== 'undefined' && value instanceof URL) return redactSecretString(value.toString());
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return redactSecrets({
      name: value.name || 'Error',
      message: value.message || '',
      code: value.code || null
    }, seen);
  }
  const constructorName = value && value.constructor && value.constructor.name
    ? value.constructor.name
    : 'Object';
  return `[${constructorName}]`;
}

function shouldRedactValueForKey(key, value) {
  if (typeof value === 'boolean' && SAFE_SENSITIVE_BOOLEAN_KEY_PATTERN.test(key)) {
    return false;
  }
  return value !== null;
}

function redactSecretString(value) {
  const raw = String(value);
  let redacted = raw
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s"'<>:@]+:[^\/\s"'<>@]+@/g, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^:=\s"'{}]{0,40}\s*[:=]\s*["']?)([^"',\s}]+)/gi, `$1${REDACTED}`);
  try {
    const parsed = new URL(redacted);
    let changed = false;
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = '';
      changed = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SECRET_KEY_PATTERN.test(key) || PRIVATE_QUERY_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (changed) redacted = parsed.href;
  } catch (_) {
    redacted = redacted
      .replace(/([?&][^=]*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|credential|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^=]*=)[^&\s"']+/gi, `$1${REDACTED}`)
      .replace(/([?&](?:username|email|login|user)=)[^&\s"']+/gi, `$1${REDACTED}`);
  }
  return redacted
    .replace(PRIVATE_VALUE_PATTERN, '[REDACTED_EMAIL]')
    .replace(ENCODED_PRIVATE_VALUE_PATTERN, '[REDACTED_EMAIL]');
}

function addResolvedMetadata(config, metadata) {
  const { budgets } = normalizeBudgets(config);
  const resolved = clone(config);
  resolved._resolved = {
    generatedAt: metadata.generatedAt,
    configPath: metadata.configPath || null,
    cwd: metadata.cwd,
    cliOverrides: redactSecrets(metadata.overrides || {}),
    budgets,
    ptkExtension: metadata.ptkExtensionResolution || null
  };
  return resolved;
}

function resolveConfig({ configPath = null, config: inlineConfig = null, overrides = {}, cliOverrides = null, cwd = process.cwd(), generatedAt = null } = {}) {
  let fileConfig = {};
  let absoluteConfigPath = null;
  if (configPath) {
    absoluteConfigPath = path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
    fileConfig = readJson(absoluteConfigPath);
  }

  let config = deepMerge(DEFAULT_CONFIG, fileConfig);
  if (inlineConfig) {
    config = deepMerge(config, inlineConfig);
  }

  const mergedOverrides = deepMerge(cliOverrides || {}, overrides || {});
  const beforeOverrides = clone(config);
  config = deepMerge(config, mergedOverrides);
  if (shouldReplaceDefaultScope(beforeOverrides, mergedOverrides)) {
    config.target.scope.include = [makeScopeGlob(mergedOverrides.target.baseUrl)];
  }
  config = resolveCrawlerRouteHints(config, { cwd, configPath: absoluteConfigPath });
  config = resolveProfileData(config, { cwd, configPath: absoluteConfigPath });
  config = resolvePtkExtensionPath(config, { cwd, configPath: absoluteConfigPath });
  const ptkExtensionResolution = config._ptkExtensionResolution || null;

  validateConfig(config);
  return addResolvedMetadata(config, {
    generatedAt: generatedAt || new Date().toISOString(),
    configPath: absoluteConfigPath,
    cwd,
    overrides: mergedOverrides,
    ptkExtensionResolution
  });
}

function loadConfig(options = {}) {
  return resolveConfig(options);
}

function configOverridesFromCli(args = {}) {
  const overrides = {};
  function set(pathParts, value) {
    if (value === undefined) {
      return;
    }
    let cursor = overrides;
    for (const part of pathParts.slice(0, -1)) {
      if (!isPlainObject(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[pathParts[pathParts.length - 1]] = value;
  }

  set(['target', 'baseUrl'], args.url || args.baseUrl);
  set(['artifacts', 'outputDir'], args.outputDir);
  set(['crawler', 'enabled'], args.crawlerEnabled);
  set(['crawler', 'maxDepth'], args.maxDepth !== undefined ? args.maxDepth : args.crawlDepth);
  for (const key of [
    'maxRoutes',
    'maxRouteMs',
    'maxActionMs',
    'maxObservationMs',
    'maxActionsPerRoute',
    'maxFormsPerRoute',
    'maxNoProgressActions'
  ]) {
    set(['crawler', key], args[key]);
  }
  set(['crawler', 'waitStrategy'], args.waitStrategy);
  set(['crawler', 'routeHintsFile'], args.routeHintsFile || args.routeHints);
  set(['crawler', 'salvageTimedOutRoutes'], args.salvageTimedOutRoutes);
  const scenarioFile = args.scenarioFile || args.scenario;
  set(['scenario', 'enabled'], args.scenarioEnabled !== undefined ? args.scenarioEnabled : (scenarioFile ? true : undefined));
  set(['scenario', 'file'], scenarioFile);
  set(['scenario', 'continueOnFailure'], args.scenarioContinueOnFailure);
  set(['agent', 'enabled'], args.agentEnabled !== undefined ? args.agentEnabled : (args.agentMode && args.agentMode !== 'off' ? true : undefined));
  set(['agent', 'mode'], args.agentMode);
  set(['agent', 'provider'], args.agentProvider);
  set(['agent', 'model'], args.agentModel);
  set(['agent', 'maxTurns'], args.maxTurns !== undefined ? args.maxTurns : args.maxAgentTurns);
  set(['agent', 'maxStepsPerTurn'], args.maxStepsPerTurn);
  set(['agent', 'maxProviderMs'], args.maxProviderMs);
  set(['agent', 'riskMode'], args.allowDestructiveActions ? 'destructive' : args.aggressive ? 'business' : args.agentRiskMode);
  set(['agent', 'allowBusinessMutations'], args.allowBusinessMutations !== undefined ? args.allowBusinessMutations : args.aggressive);
  set(['agent', 'allowDestructiveActions'], args.allowDestructiveActions);
  set(['agent', 'requireSuccess'], args.requireAgentSuccess);
  set(['profile', 'username'], args.username);
  set(['profile', 'password'], args.password);
  set(['profile', 'includeSecrets'], args.includeSecrets);
  set(['profile', 'file'], args.profileFile || args.crawlData);
  set(['profile', 'activePersonaId'], args.persona || args.activePersonaId);
  set(['memory', 'mode'], args.memoryMode);
  set(['memory', 'storageDir'], args.memoryStorage || args.memoryStorageDir);
  set(['memory', 'reset'], args.memoryReset);
  set(['browser', 'name'], args.browserName || args.browser || (args.chromeBinary ? 'chrome' : args.edgeBinary ? 'edge' : args.firefoxXpi ? 'firefox' : undefined));
  set(['browser', 'executablePath'], args.executablePath || args.chromeBinary || args.edgeBinary);
  set(['browser', 'profileDir'], args.profileDir);
  set(['browser', 'firefoxXpi'], args.firefoxXpi);
  set(['browser', 'headless'], args.headless);
  set(['browser', 'launchTimeoutMs'], args.browserLaunchTimeoutMs || args.launchTimeoutMs);
  set(['ptk', 'extensionPath'], args.ptkExtensionDir || args.ptkExtensionPath || args.extensionPath);
  set(['ptk', 'autoDetectExtension'], args.autoDetectExtension);
  set(['ptk', 'enabled'], args.ptkEnabled);
  set(['ptk', 'requireBridge'], args.requirePtkBridge);
  set(['ptk', 'requireFindingsExport'], args.requirePtkFindingsExport);
  set(['ptk', 'allowMissing'], args.allowMissingPtk);
  set(['ptk', 'drainMode'], args.waitForPtkComplete ? 'until-complete' : args.ptkDrainMode);
  set(['ptk', 'drainTimeoutMs'], args.waitForPtkComplete && args.ptkDrainTimeoutMs === undefined ? 60000 : args.ptkDrainTimeoutMs);
  set(['ptk', 'requireAttackCompletion'], args.requirePtkAttackCompletion);
  set(['ptk', 'stopWaitForIdle'], args.stopWaitForIdle);
  set(['ptk', 'immediateAnalysis'], args.immediateAnalysis);

  if (args.scopeInclude !== undefined) {
    set(['target', 'scope', 'include'], Array.isArray(args.scopeInclude) ? args.scopeInclude : [args.scopeInclude]);
  }
  if (args.scopeExclude !== undefined) {
    set(['target', 'scope', 'exclude'], Array.isArray(args.scopeExclude) ? args.scopeExclude : [args.scopeExclude]);
  }
  return overrides;
}

function getDefaultConfig() {
  return clone(DEFAULT_CONFIG);
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  REDACTED,
  SECRET_KEY_PATTERN,
  ConfigValidationError,
  buildCliOverrides: configOverridesFromCli,
  configOverridesFromCli,
  deepMerge,
  getDefaultConfig,
  findPtkExtensionPath,
  loadConfig,
  makeScopeGlob,
  readJson,
  redactSecrets,
  resolveConfig,
  resolvePtkExtensionPath,
  validateConfig
};
