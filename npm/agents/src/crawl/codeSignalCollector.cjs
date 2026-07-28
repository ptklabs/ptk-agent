'use strict';

const { normalizeUrl: normalizePageUrl } = require('../browser/pageModel.cjs');

const DEFAULT_CODE_SIGNAL_CONFIG = Object.freeze({
  enabled: false,
  mode: 'off',
  maxScripts: 8,
  maxScriptBytes: 2000000,
  maxTotalBytes: 5000000,
  maxSignalMs: 500,
  seedRoutes: false,
  includeSourceMaps: false,
  includeExternalScripts: false
});

const VENDOR_STATIC_RE = /(?:^|\/)(?:node_modules|vendor|vendors|third[-_]?party|polyfills|runtime|webpack|chunk[-_.]?vendors?|assets|static|dist|build)\b|(?:\.min|bundle|chunk)\.js(?:$|\?)/i;
const STATIC_ASSET_RE = /\.(?:css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(?:$|\?)/i;
const ROUTE_FILE_RE = /\.(?:js|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip|gz)(?:$|\?)/i;
const ENDPOINT_PATH_RE = /^\/(?:api|rest|graphql|v\d+\/(?:api|rest)|oauth|auth|login|logout|users?|products?|orders?|basket|cart)(?:\/|$|\?)/i;

function resolveCodeSignalConfig(config = {}) {
  const input = config.crawler && config.crawler.codeSignals || {};
  const resolved = {
    ...DEFAULT_CODE_SIGNAL_CONFIG,
    ...input
  };
  resolved.mode = ['off', 'safe', 'wide'].includes(resolved.mode) ? resolved.mode : DEFAULT_CODE_SIGNAL_CONFIG.mode;
  resolved.enabled = resolved.enabled === true && resolved.mode !== 'off';
  resolved.maxScripts = positiveInteger(resolved.maxScripts, DEFAULT_CODE_SIGNAL_CONFIG.maxScripts);
  resolved.maxScriptBytes = positiveInteger(resolved.maxScriptBytes, DEFAULT_CODE_SIGNAL_CONFIG.maxScriptBytes);
  resolved.maxTotalBytes = positiveInteger(resolved.maxTotalBytes, DEFAULT_CODE_SIGNAL_CONFIG.maxTotalBytes);
  resolved.maxSignalMs = positiveInteger(resolved.maxSignalMs, DEFAULT_CODE_SIGNAL_CONFIG.maxSignalMs);
  resolved.seedRoutes = Boolean(resolved.seedRoutes);
  resolved.includeSourceMaps = Boolean(resolved.includeSourceMaps);
  resolved.includeExternalScripts = Boolean(resolved.includeExternalScripts);
  return resolved;
}

async function collectCodeSignals({ page = null, pageUrl = null, baseUrl = null, observation = {}, config = {} } = {}) {
  const options = resolveCodeSignalConfig(config);
  const targetBaseUrl = baseUrl || config.target && config.target.baseUrl || pageUrl;
  const summary = emptySummary(options, targetBaseUrl, pageUrl);
  if (!options.enabled || !targetBaseUrl) return summary;

  const deadline = createDeadline(options.maxSignalMs);
  const cache = codeSignalCache(config);
  let candidates = [];
  try {
    candidates = await withSignalTimeout(
      collectScriptCandidates(page, observation, targetBaseUrl, options),
      deadline.remainingMs(),
      'collect-script-urls'
    );
  } catch (err) {
    summary.skippedScripts.push({ url: null, reason: 'script-discovery-timeout', message: err.message });
    summary.timedOut = true;
    return summary;
  }
  summary.candidateCount = candidates.length;

  const accepted = [];
  const skipped = summary.skippedScripts;
  const seen = new Set();
  for (const candidate of candidates) {
    const url = normalizeScriptUrl(candidate.url, targetBaseUrl);
    if (!url) {
      skipped.push({ url: candidate.url || null, reason: 'invalid-url', source: candidate.source || null });
      continue;
    }
    if (seen.has(url)) {
      skipped.push({ url, reason: 'duplicate', source: candidate.source || null });
      continue;
    }
    seen.add(url);
    if (!options.includeSourceMaps && isSourceMap(url)) {
      skipped.push({ url, reason: 'source-map', source: candidate.source || null });
      continue;
    }
    const sameOrigin = isSameOrigin(url, targetBaseUrl);
    if (!sameOrigin && (options.mode === 'safe' || !options.includeExternalScripts)) {
      skipped.push({ url, reason: 'external-script', source: candidate.source || null });
      continue;
    }
    accepted.push({
      url,
      source: candidate.source || 'dom-script',
      sameOrigin,
      vendorStatic: isVendorStaticScript(url)
    });
  }

  accepted.sort((a, b) => scriptPriority(a) - scriptPriority(b));

  let totalBytes = 0;
  for (const [index, candidate] of accepted.entries()) {
    if (summary.scripts.length >= options.maxScripts) {
      skipped.push({ url: candidate.url, reason: 'max-scripts', source: candidate.source });
      continue;
    }
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      skipped.push({ url: candidate.url, reason: 'max-signal-ms', source: candidate.source });
      summary.timedOut = true;
      continue;
    }

    let text = '';
    try {
      text = await fetchScriptTextCached(page, candidate.url, options.maxScriptBytes + 1, {
        cache,
        timeoutMs: remainingMs
      });
    } catch (err) {
      skipped.push({
        url: candidate.url,
        reason: err.code === 'ERR_PTK_CODE_SIGNAL_TIMEOUT' ? 'fetch-timeout' : 'fetch-failed',
        source: candidate.source,
        message: err.message
      });
      continue;
    }

    if (typeof text !== 'string' || text.length === 0) {
      skipped.push({ url: candidate.url, reason: 'empty-script', source: candidate.source });
      continue;
    }
    if (text.length > options.maxScriptBytes) {
      skipped.push({ url: candidate.url, reason: 'max-script-bytes', source: candidate.source, bytes: text.length });
      continue;
    }
    if (totalBytes + text.length > options.maxTotalBytes) {
      skipped.push({ url: candidate.url, reason: 'max-total-bytes', source: candidate.source, bytes: text.length });
      continue;
    }

    totalBytes += text.length;
    const extracted = extractCodeSignalLiterals(text, {
      baseUrl: targetBaseUrl,
      scriptUrl: candidate.url
    });
    summary.scripts.push({
      url: candidate.url,
      source: candidate.source,
      index,
      bytes: text.length,
      sameOrigin: candidate.sameOrigin,
      vendorStatic: candidate.vendorStatic,
      routeHintCount: extracted.routes.length,
      endpointHintCount: extracted.endpoints.length
    });
    mergeHints(summary.routes, extracted.routes, 'url');
    mergeHints(summary.endpoints, extracted.endpoints, 'key');
  }

  summary.totalBytes = totalBytes;
  return summary;
}

function emptySummary(options, baseUrl, pageUrl) {
  return {
    schemaVersion: 'ptk-agent-v2-code-signals',
    enabled: Boolean(options.enabled),
    mode: options.mode,
    baseUrl: baseUrl || null,
    pageUrl: pageUrl || null,
    limits: {
      maxScripts: options.maxScripts,
      maxScriptBytes: options.maxScriptBytes,
      maxTotalBytes: options.maxTotalBytes,
      includeSourceMaps: options.includeSourceMaps,
      includeExternalScripts: options.includeExternalScripts,
      seedRoutes: options.seedRoutes,
      maxSignalMs: options.maxSignalMs
    },
    candidateCount: 0,
    totalBytes: 0,
    scripts: [],
    skippedScripts: [],
    routes: [],
    endpoints: []
  };
}

async function collectScriptCandidates(page, observation = {}, baseUrl, options = {}) {
  const candidates = [];
  for (const event of observation.events || []) {
    const url = event && (event.url || event.href);
    if (!url) continue;
    const resourceType = String(event.resourceType || '').toLowerCase();
    if (resourceType === 'script' || /\.m?js(?:$|\?)/i.test(url)) {
      candidates.push({ url, source: `event:${event.type || 'request'}` });
    }
  }
  for (const url of observation.scripts || []) candidates.push({ url, source: 'observation' });
  for (const url of await collectFixtureScriptUrls(page)) candidates.push({ url, source: 'fixture-script' });
  return candidates;
}

async function collectFixtureScriptUrls(page) {
  if (!page) return [];
  if (typeof page.collectScriptUrls === 'function') {
    const urls = await page.collectScriptUrls();
    return Array.isArray(urls) ? urls : [];
  }
  if (Array.isArray(page.scriptUrls)) return page.scriptUrls.slice();
  return [];
}

async function fetchScriptText(page, url, maxBytes, timeoutMs = DEFAULT_CODE_SIGNAL_CONFIG.maxSignalMs) {
  if (page && typeof page.fetchScript === 'function') return page.fetchScript(url, { maxBytes });
  if (page && typeof page.fetchText === 'function') return page.fetchText(url, { maxBytes });
  if (typeof fetch !== 'function') return '';
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      signal: controller ? controller.signal : undefined
    });
    const text = await response.text();
    return text.slice(0, maxBytes);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchScriptTextCached(page, url, maxBytes, options = {}) {
  const cache = options.cache || null;
  const cacheKey = `${url}|${maxBytes}`;
  if (cache && cache.text.has(cacheKey)) return cache.text.get(cacheKey);
  if (cache && cache.failures.has(cacheKey)) throw cache.failures.get(cacheKey);
  try {
    const text = await withSignalTimeout(fetchScriptText(page, url, maxBytes, options.timeoutMs), options.timeoutMs, `fetch ${url}`);
    if (cache) cache.text.set(cacheKey, text);
    return text;
  } catch (err) {
    if (cache) cache.failures.set(cacheKey, err);
    throw err;
  }
}

function codeSignalCache(config = {}) {
  if (!config || typeof config !== 'object') return { text: new Map(), failures: new Map() };
  if (!config._codeSignalCache) {
    Object.defineProperty(config, '_codeSignalCache', {
      value: { text: new Map(), failures: new Map() },
      enumerable: false,
      configurable: true
    });
  }
  return config._codeSignalCache;
}

function createDeadline(ms) {
  const started = Date.now();
  const budgetMs = positiveInteger(ms, DEFAULT_CODE_SIGNAL_CONFIG.maxSignalMs);
  return {
    remainingMs() {
      return Math.max(0, budgetMs - (Date.now() - started));
    }
  };
}

function withSignalTimeout(promise, ms, label = 'code-signal operation') {
  const timeoutMs = Math.max(1, Number(ms) || 1);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${timeoutMs}ms`);
        err.code = 'ERR_PTK_CODE_SIGNAL_TIMEOUT';
        reject(err);
      }, timeoutMs);
    })
  ]);
}

function normalizeScriptUrl(rawUrl, baseUrl) {
  const normalized = normalizePageUrl(rawUrl, baseUrl, {
    preserveSpaHashRoutes: false
  });
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function isSameOrigin(url, baseUrl) {
  try {
    return new URL(url, baseUrl).origin === new URL(baseUrl).origin;
  } catch (_) {
    return false;
  }
}

function isSourceMap(url) {
  return /\.map(?:$|\?)/i.test(url);
}

function isVendorStaticScript(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return VENDOR_STATIC_RE.test(path) || STATIC_ASSET_RE.test(path.replace(/\.m?js(?:$|\?)/i, '.js'));
  } catch (_) {
    return VENDOR_STATIC_RE.test(String(url || ''));
  }
}

function scriptPriority(candidate) {
  if (!candidate.sameOrigin) return 20;
  return candidate.vendorStatic ? 10 : 0;
}

function extractCodeSignalLiterals(sourceText, { baseUrl, scriptUrl } = {}) {
  const routes = [];
  const endpoints = [];
  const literals = extractStringLiterals(sourceText);
  const routeLiterals = [
    ...extractPathPropertyRoutes(sourceText),
    ...extractRouterLinkRoutes(sourceText),
    ...extractNavigateRoutes(sourceText),
    ...literals.filter(value => isHashRoute(value))
  ];
  for (const literal of routeLiterals) {
    const route = normalizeRouteHint(literal, baseUrl, scriptUrl);
    if (route) routes.push(route);
  }
  for (const literal of literals) {
    const endpoint = normalizeEndpointHint(literal, baseUrl, scriptUrl);
    if (endpoint) endpoints.push(endpoint);
  }
  return {
    routes: dedupeBy(routes, 'url'),
    endpoints: dedupeBy(endpoints, 'key')
  };
}

function extractStringLiterals(text) {
  const values = [];
  const pattern = /(['"`])((?:\\.|(?!\1).){1,500})\1/gms;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const value = match[2].replace(/\\(['"`/])/g, '$1');
    if (!value.includes('${')) values.push(value);
  }
  return values;
}

function extractPathPropertyRoutes(text) {
  const values = [];
  const pattern = /\bpath\s*:\s*(['"`])([^'"`]{1,240})\1/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) values.push(match[2]);
  return values;
}

function extractRouterLinkRoutes(text) {
  const values = [];
  const stringPattern = /\brouterLink\b[^\n=:{]{0,40}(?:=|:)\s*(['"`])([^'"`]{1,240})\1/g;
  let match;
  while ((match = stringPattern.exec(String(text || '')))) values.push(match[2]);
  const arrayPattern = /\brouterLink\b[^\n=:{]{0,40}(?:=|:)\s*(['"`])\s*\[([^\]]{1,300})\]\s*\1/g;
  while ((match = arrayPattern.exec(String(text || '')))) {
    const joined = routeFromStringArray(match[2]);
    if (joined) values.push(joined);
  }
  return values;
}

function extractNavigateRoutes(text) {
  const values = [];
  const pattern = /\bnavigate(?:ByUrl)?\s*\(\s*(?:\[([^\]]{1,300})\]|(['"`])([^'"`]{1,240})\2)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    if (match[1]) {
      const joined = routeFromStringArray(match[1]);
      if (joined) values.push(joined);
    } else if (match[3]) {
      values.push(match[3]);
    }
  }
  return values;
}

function routeFromStringArray(text) {
  const parts = extractStringLiterals(text)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !part.startsWith('..') && !part.includes('${'));
  if (!parts.length) return null;
  if (parts[0].startsWith('#/')) return parts.join('/');
  const cleaned = parts.map((part, index) => index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''));
  const first = cleaned[0].startsWith('/') ? cleaned[0] : `/${cleaned[0]}`;
  return [first, ...cleaned.slice(1)].filter(Boolean).join('/');
}

function normalizeRouteHint(literal, baseUrl, scriptUrl) {
  let value = String(literal || '').trim();
  if (!value || value.includes('${') || value.startsWith('//')) return null;
  value = expandSimpleDynamicParams(value);
  if (isEndpointPath(value)) return null;
  if (!isHashRoute(value) && !value.startsWith('/')) value = `/${value.replace(/^\/+/, '')}`;
  if (ROUTE_FILE_RE.test(value)) return null;
  try {
    const normalized = isHashRoute(value)
      ? normalizePageUrl(value, baseUrl, { preserveSpaHashRoutes: true, spaHashBaseUrl: baseUrl })
      : normalizePageUrl(value, baseUrl, { preserveSpaHashRoutes: true, spaHashBaseUrl: baseUrl });
    if (!normalized) return null;
    return {
      url: normalized,
      literal,
      source: 'code-signal',
      sourceTag: 'code-signal',
      scriptUrl
    };
  } catch (_) {
    return null;
  }
}

function normalizeEndpointHint(literal, baseUrl, scriptUrl) {
  const value = String(literal || '').trim();
  if (!value || value.includes('${')) return null;
  let parsed = null;
  let path = value;
  try {
    parsed = new URL(value, baseUrl);
    path = `${parsed.pathname}${parsed.search || ''}`;
  } catch (_) {}
  if (!isEndpointPath(path)) return null;
  if (parsed && parsed.origin !== new URL(baseUrl).origin) return null;
  const method = inferMethodFromLiteral(value);
  const url = parsed ? parsed.href : null;
  return {
    key: `${method} ${path}`,
    method,
    path,
    url,
    literal: value,
    resourceType: 'script-literal',
    source: 'code-signal',
    sourceTag: 'code-signal',
    scriptUrl
  };
}

function isHashRoute(value) {
  return value === '#/' || value.startsWith('#/') || value.startsWith('#!/');
}

function isEndpointPath(value) {
  return ENDPOINT_PATH_RE.test(String(value || ''));
}

function inferMethodFromLiteral() {
  return 'GET';
}

function expandSimpleDynamicParams(value) {
  return String(value || '')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => /id$/i.test(name) ? '1' : 'sample')
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => /id$/i.test(name) ? '1' : 'sample');
}

function mergeHints(target, hints, key) {
  const seen = new Set(target.map(item => item && item[key]));
  for (const hint of hints || []) {
    if (!hint || !hint[key] || seen.has(hint[key])) continue;
    seen.add(hint[key]);
    target.push(hint);
  }
}

function dedupeBy(items, key) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item || !item[key] || seen.has(item[key])) continue;
    seen.add(item[key]);
    out.push(item);
  }
  return out;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  DEFAULT_CODE_SIGNAL_CONFIG,
  collectCodeSignals,
  collectScriptCandidates,
  extractCodeSignalLiterals,
  extractStringLiterals,
  isVendorStaticScript,
  normalizeEndpointHint,
  normalizeRouteHint,
  resolveCodeSignalConfig
};
