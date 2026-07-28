'use strict';

const { isInScope, scopeFromConfig } = require('./context.cjs');

const DEFAULT_OBSERVATION_MS = 800;
const SENSITIVE_HEADER = /authorization|cookie|token|secret|key|session/i;
const SENSITIVE_PARAM = /token|secret|password|pass|key|session|auth|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function boundedMs(value, fallback = DEFAULT_OBSERVATION_MS) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, 10000);
}

async function boundedValue(work, timeoutMs, fallback) {
  const budgetMs = Math.max(1, boundedMs(timeoutMs, DEFAULT_OBSERVATION_MS));
  let timer = null;
  const task = Promise.resolve()
    .then(() => typeof work === 'function' ? work() : work);
  task.catch(() => {});
  return Promise.race([
    task,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), budgetMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function safeCall(obj, name) {
  try {
    return obj && typeof obj[name] === 'function' ? obj[name]() : null;
  } catch (_) {
    return null;
  }
}

function popupScopeDecision(rawUrl, config = {}) {
  const url = String(rawUrl || '').trim();
  if (!url || url === 'about:blank') {
    return { inScope: null, disposition: 'pending-navigation' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { inScope: false, disposition: 'closed-invalid-url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { inScope: false, disposition: 'closed-non-http' };
  }
  const scope = scopeFromConfig(config || {});
  if (!scope) {
    return { inScope: false, disposition: 'closed-scope-unavailable' };
  }
  return isInScope(parsed.href, scope)
    ? { inScope: true, disposition: 'retained-in-scope' }
    : { inScope: false, disposition: 'closed-out-of-scope' };
}

function redactUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.username || parsed.password) {
      parsed.username = '[redacted]';
      parsed.password = '';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.href;
  } catch (_) {
    return String(rawUrl)
      .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s"'<>:@]+:[^\/\s"'<>@]+@/g, '$1[redacted]@')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-api-key]')
      .replace(/([?&][^=]*(?:token|secret|password|pass|key|session|auth|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^=]*=)[^&\s"']+/gi, '$1[redacted]');
  }
}

function redactHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    output[name] = SENSITIVE_HEADER.test(name) ? '[redacted]' : String(value);
  }
  return output;
}

function pathFromUrl(url) {
  try {
    const parsed = new URL(redactUrl(url));
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return redactUrl(url || '');
  }
}

function extractOperationName(query) {
  if (typeof query !== 'string') return null;
  const match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
  return match ? match[2] : null;
}

function graphqlOperationName(payload) {
  if (!payload) return null;
  if (typeof payload === 'object') return payload.operationName || extractOperationName(payload.query);
  if (typeof payload === 'string') {
    if (payload.length > 4096) return null;
    try {
      return graphqlOperationName(JSON.parse(payload));
    } catch (_) {
      return extractOperationName(payload);
    }
  }
  return null;
}

function normalizeRequest(request) {
  const method = safeCall(request, 'method') || 'GET';
  const url = safeCall(request, 'url') || '';
  const resourceType = safeCall(request, 'resourceType') || 'unknown';
  const postData = safeCall(request, 'postData') || null;
  return {
    type: 'request',
    ts: Date.now(),
    method,
    url: redactUrl(url),
    path: pathFromUrl(url),
    resourceType,
    headers: redactHeaders(safeCall(request, 'headers') || {}),
    graphqlOperationName: graphqlOperationName(postData)
  };
}

function normalizeResponse(response) {
  const request = safeCall(response, 'request');
  const url = safeCall(response, 'url') || request && safeCall(request, 'url') || '';
  return {
    type: 'response',
    ts: Date.now(),
    url: redactUrl(url),
    path: pathFromUrl(url),
    status: safeCall(response, 'status') || 0,
    method: request ? safeCall(request, 'method') || null : null,
    resourceType: request ? safeCall(request, 'resourceType') || 'unknown' : 'unknown'
  };
}

async function installDomMutationObserver(page) {
  if (!page || typeof page.evaluate !== 'function') return false;
  try {
    await page.evaluate(() => {
      if (window.__PTK_V2_MUTATION_OBSERVER__) return;
      window.__PTK_V2_MUTATION_SUMMARY__ = { addedNodes: 0, removedNodes: 0, textChanges: 0 };
      window.__PTK_V2_MUTATION_OBSERVER__ = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          window.__PTK_V2_MUTATION_SUMMARY__.addedNodes += mutation.addedNodes ? mutation.addedNodes.length : 0;
          window.__PTK_V2_MUTATION_SUMMARY__.removedNodes += mutation.removedNodes ? mutation.removedNodes.length : 0;
          if (mutation.type === 'characterData') window.__PTK_V2_MUTATION_SUMMARY__.textChanges += 1;
        }
      });
      window.__PTK_V2_MUTATION_OBSERVER__.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function extractLinks(page) {
  if (page && typeof page.collectDomSnapshot === 'function') {
    const snapshot = await page.collectDomSnapshot();
    return snapshot.links || [];
  }
  if (!page || typeof page.evaluate !== 'function') return [];
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map(a => ({
    href: a.href,
    text: (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  })));
}

async function mutationSummary(page) {
  if (page && typeof page.collectDomSnapshot === 'function') {
    const snapshot = await page.collectDomSnapshot();
    return snapshot.mutationSummary || null;
  }
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(() => window.__PTK_V2_MUTATION_SUMMARY__ || {
    nodeCount: document.querySelectorAll('*').length,
    textLength: document.body && document.body.innerText ? document.body.innerText.length : 0
  });
}

class EventCollector {
  constructor(page, options = {}) {
    this.page = page;
    this.options = options || {};
    this.events = [];
    this.handlers = [];
    this.popupCandidates = [];
    this.started = false;
  }

  start() {
    if (!this.page || this.started || typeof this.page.on !== 'function') return;
    this.started = true;
    installDomMutationObserver(this.page).catch(() => {});
    try {
      const { installBrowserProbe } = require('./browserProbe.cjs');
      installBrowserProbe(this.page, this.options.config || {}).catch(() => {});
    } catch (_) {}
    this.add('request', request => this.events.push(normalizeRequest(request)));
    this.add('response', response => this.events.push(normalizeResponse(response)));
    this.add('framenavigated', frame => {
      if (typeof frame.parentFrame === 'function' && frame.parentFrame()) return;
      const url = safeCall(frame, 'url') || '';
      this.events.push({ type: 'navigation', ts: Date.now(), url: redactUrl(url), path: pathFromUrl(url) });
    });
    this.add('console', msg => {
      const level = safeCall(msg, 'type') || 'log';
      if (level !== 'error') return;
      this.events.push({ type: 'console', ts: Date.now(), level, text: String(safeCall(msg, 'text') || '').slice(0, 500) });
    });
    this.add('download', download => {
      this.events.push({
        type: 'download',
        ts: Date.now(),
        url: redactUrl(safeCall(download, 'url')),
        suggestedFilename: safeCall(download, 'suggestedFilename') || null,
        detected: true
      });
    });
    this.add('popup', popup => {
      const rawUrl = safeCall(popup, 'url') || '';
      const decision = popupScopeDecision(rawUrl, this.options.config || {});
      const record = {
        type: 'popup',
        ts: Date.now(),
        url: redactUrl(rawUrl),
        inScope: decision.inScope,
        retained: decision.inScope === true,
        disposition: decision.disposition,
        closed: false
      };
      this.popupCandidates.push({ popup, record });
      this.events.push(record);
    });
    this.add('dialog', dialog => {
      this.events.push({
        type: 'dialog',
        ts: Date.now(),
        dialogType: safeCall(dialog, 'type') || 'unknown',
        message: String(safeCall(dialog, 'message') || '').slice(0, 500)
      });
    });
  }

  add(name, handler) {
    this.page.on(name, handler);
    this.handlers.push([name, handler]);
  }

  stop() {
    if (!this.page) return;
    for (const [name, handler] of this.handlers) {
      if (typeof this.page.off === 'function') this.page.off(name, handler);
      else if (typeof this.page.removeListener === 'function') this.page.removeListener(name, handler);
    }
    this.handlers = [];
    this.started = false;
  }

  async closePopup(popup, record) {
    if (!popup || typeof popup.close !== 'function' || record.closed) return false;
    try {
      const timedOut = Object.freeze({ timedOut: true });
      const result = await boundedValue(() => popup.close(), 250, timedOut);
      if (result === timedOut) {
        record.closeError = 'popup_close_timeout';
        return false;
      }
      record.closed = true;
      record.retained = false;
      return true;
    } catch (err) {
      record.closed = false;
      record.closeError = err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
      return false;
    }
  }

  async settlePopups() {
    for (const candidate of this.popupCandidates) {
      const { popup, record } = candidate;
      if (record.closed) continue;
      const rawUrl = safeCall(popup, 'url') || '';
      const decision = popupScopeDecision(rawUrl, this.options.config || {});
      record.url = redactUrl(rawUrl);
      record.inScope = decision.inScope;
      record.retained = decision.inScope === true;
      record.disposition = decision.inScope === null ? 'closed-unresolved-target' : decision.disposition;
      if (decision.inScope !== true) await this.closePopup(popup, record);
    }
  }

  async observe(maxObservationMs) {
    const budgetMs = boundedMs(maxObservationMs || this.options.maxObservationMs);
    this.start();
    const started = Date.now();
    const extractionBudgetMs = Math.max(100, Math.min(500, Math.floor(budgetMs / 2) || budgetMs));
    const settleMs = Math.max(0, budgetMs - extractionBudgetMs);
    await sleep(settleMs);
    await this.settlePopups();
    const links = (await boundedValue(
      () => extractLinks(this.page),
      extractionBudgetMs,
      []
    ).catch(() => [])).map(link => ({
      href: redactUrl(link.href),
      text: String(link.text || link.label || '').replace(/\s+/g, ' ').trim().slice(0, 140)
    }));
    const domMutationSummary = await boundedValue(
      () => mutationSummary(this.page),
      extractionBudgetMs,
      null
    ).catch(() => null);
    let probeEvents = [];
    let probeSnapshot = null;
    try {
      const { drainBrowserProbeEvents, getBrowserProbeSnapshot } = require('./browserProbe.cjs');
      probeEvents = await boundedValue(
        () => drainBrowserProbeEvents(this.page, this.options.config || {}),
        extractionBudgetMs,
        []
      ).catch(() => []);
      probeSnapshot = await boundedValue(
        () => getBrowserProbeSnapshot(this.page, this.options.config || {}),
        extractionBudgetMs,
        null
      ).catch(() => null);
    } catch (_) {
      probeEvents = [];
      probeSnapshot = null;
    }
    this.stop();
    const events = [
      ...this.events.slice(),
      ...probeEvents.map(event => ({ type: `probe.${event.type || 'event'}`, ts: event.ts || Date.now(), url: event.url || null, summary: event.summary || null }))
    ];
    return {
      durationMs: Date.now() - started,
      budgetMs,
      events,
      links,
      probeEvents,
      probeSnapshot,
      routeCandidates: probeSnapshot && probeSnapshot.routeCandidates || [],
      domMutationSummary,
      mutationSummary: domMutationSummary,
      navigations: events.filter(event => event.type === 'navigation'),
      requests: events.filter(event => event.type === 'request'),
      responses: events.filter(event => event.type === 'response'),
      endpoints: events.filter(event => ['request', 'response'].includes(event.type) && ['xhr', 'fetch', 'document', 'unknown'].includes(event.resourceType || 'unknown')),
      consoleErrors: events.filter(event => event.type === 'console' && event.level === 'error'),
      downloads: events.filter(event => event.type === 'download'),
      popups: events.filter(event => event.type === 'popup'),
      dialogs: events.filter(event => event.type === 'dialog')
    };
  }
}

async function observePage(page, optionsOrMs) {
  const maxObservationMs = typeof optionsOrMs === 'number' ? optionsOrMs : optionsOrMs && optionsOrMs.maxObservationMs;
  const collector = new EventCollector(page, typeof optionsOrMs === 'object' ? optionsOrMs : {});
  return collector.observe(maxObservationMs);
}

function createEventCollector(page, options) {
  return new EventCollector(page, options);
}

module.exports = {
  DEFAULT_OBSERVATION_MS,
  EventCollector,
  createEventCollector,
  observePage,
  sleep,
  boundedMs,
  redactUrl,
  redactHeaders,
  normalizeRequest,
  normalizeResponse,
  graphqlOperationName,
  extractOperationName,
  extractLinks,
  mutationSummary,
  pathFromUrl,
  popupScopeDecision
};
