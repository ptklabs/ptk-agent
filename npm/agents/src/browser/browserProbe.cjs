'use strict';

const { buildPageProbeScript, PROBE_VERSION } = require('./pageProbeScript.cjs');
const { normalizeUrl } = require('./pageModel.cjs');

function probeConfig(config = {}) {
  const raw = config.browserProbe || {};
  return {
    enabled: raw.enabled !== false,
    maxNodes: positiveInteger(raw.maxNodes, 1500),
    maxControls: positiveInteger(raw.maxControls, 300),
    maxRoutes: positiveInteger(raw.maxRoutes, 500),
    maxTextChars: positiveInteger(raw.maxTextChars, 8000),
    observeMutations: raw.observeMutations !== false,
    redactValues: raw.redactValues !== false
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function installBrowserProbe(page, config = {}) {
  const options = probeConfig(config);
  if (!options.enabled || !page) return { installed: false, reason: 'disabled' };
  const script = buildPageProbeScript(options);
  let addInitScript = false;
  let evaluated = false;
  if (typeof page.addInitScript === 'function') {
    await page.addInitScript({ content: script });
    addInitScript = true;
  }
  if (typeof page.evaluate === 'function') {
    await page.evaluate(source => {
      // eslint-disable-next-line no-new-func
      return Function(source)();
    }, script).catch(async () => {
      await page.evaluate(scriptSource => {
        const element = document.createElement('script');
        element.textContent = scriptSource;
        document.documentElement.appendChild(element);
        element.remove();
      }, script);
    });
    evaluated = true;
  }
  return {
    installed: addInitScript || evaluated,
    addInitScript,
    evaluated,
    version: PROBE_VERSION,
    reason: addInitScript || evaluated ? 'installed' : 'page_does_not_support_probe_install'
  };
}

async function verifyBrowserProbe(page, config = {}) {
  const options = probeConfig(config);
  if (!options.enabled || !page || typeof page.evaluate !== 'function') return { ok: false, reason: options.enabled ? 'evaluate_unavailable' : 'disabled' };
  const status = await page.evaluate(version => {
    const probe = window.__PTK_CRAWLER_V2__;
    return {
      exists: Boolean(probe),
      version: probe && probe.version || null,
      valid: Boolean(probe && probe.version === version && typeof probe.snapshot === 'function' && typeof probe.drainEvents === 'function')
    };
  }, PROBE_VERSION).catch(error => ({ exists: false, valid: false, reason: error.message }));
  if (status.valid) return { ok: true, ...status };
  const installed = await installBrowserProbe(page, config);
  const verified = await page.evaluate(version => {
    const probe = window.__PTK_CRAWLER_V2__;
    return {
      exists: Boolean(probe),
      version: probe && probe.version || null,
      valid: Boolean(probe && probe.version === version && typeof probe.snapshot === 'function')
    };
  }, PROBE_VERSION).catch(error => ({ exists: false, valid: false, reason: error.message }));
  return {
    ok: Boolean(verified.valid),
    reinstalled: true,
    install: installed,
    ...verified
  };
}

async function getBrowserProbeSnapshot(page, config = {}) {
  const options = probeConfig(config);
  if (!options.enabled || !page || typeof page.evaluate !== 'function') return null;
  const verification = await verifyBrowserProbe(page, config);
  if (!verification.ok) return null;
  const snapshot = await page.evaluate(() => {
    const probe = window.__PTK_CRAWLER_V2__;
    return probe && typeof probe.snapshot === 'function' ? probe.snapshot() : null;
  }).catch(() => null);
  return sanitizeProbeSnapshot(snapshot, config);
}

async function drainBrowserProbeEvents(page, config = {}) {
  const options = probeConfig(config);
  if (!options.enabled || !page || typeof page.evaluate !== 'function') return [];
  const verification = await verifyBrowserProbe(page, config);
  if (!verification.ok) return [];
  return page.evaluate(() => {
    const probe = window.__PTK_CRAWLER_V2__;
    return probe && typeof probe.drainEvents === 'function' ? probe.drainEvents() : [];
  }).catch(() => []);
}

function sanitizeProbeSnapshot(snapshot = null, config = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const options = probeConfig(config);
  const baseUrl = snapshot.url || config.target && config.target.baseUrl || undefined;
  const routeCandidates = [];
  const seenRoutes = new Set();
  for (const candidate of snapshot.routeCandidates || []) {
    if (routeCandidates.length >= options.maxRoutes) break;
    const href = normalizeUrl(candidate.href || candidate.url, baseUrl, {
      preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      spaHashBaseUrl: config.target && config.target.baseUrl || baseUrl
    });
    if (!href || seenRoutes.has(href)) continue;
    seenRoutes.add(href);
    routeCandidates.push({
      id: candidate.id || `probe-route:${routeCandidates.length}`,
      href: redactSensitiveUrl(href),
      text: compact(redactSecretText(candidate.text || candidate.label || href), 140),
      label: compact(redactSecretText(candidate.label || candidate.text || href), 140),
      selector: candidate.selector || null,
      source: candidate.source || 'browser-probe'
    });
  }
  const controls = (snapshot.newlyDiscoveredControls || []).slice(0, options.maxControls).map((control, index) => ({
    id: control.id || `probe-control:${index}`,
    tagName: control.tagName || null,
    role: control.role || null,
    type: control.type || '',
    label: compact(redactSecretText(control.label || control.text || ''), 160),
    ariaLabel: compact(redactSecretText(control.ariaLabel || ''), 160) || null,
    title: compact(redactSecretText(control.title || ''), 160) || null,
    href: control.href ? redactSensitiveUrl(control.href) : null,
    routeTarget: control.routeTarget ? redactSensitiveUrl(control.routeTarget) : null,
    selector: control.selector || null,
    hasPopup: control.hasPopup || null,
    expands: Boolean(control.expands),
    ariaExpanded: control.ariaExpanded,
    opensDialog: Boolean(control.opensDialog),
    formId: control.formId || null,
    semanticKind: control.semanticKind || null,
    semanticScore: Number.isFinite(Number(control.semanticScore)) ? Number(control.semanticScore) : null,
    semanticSignals: Array.isArray(control.semanticSignals) ? control.semanticSignals.slice(0, 12).map(signal => compact(signal, 80)) : [],
    source: control.source || 'browser-probe'
  }));
  const surfaces = (snapshot.surfaces || snapshot.surfaceState || []).slice(0, 50).map((surface, index) => ({
    id: surface.id || `surface:${index}`,
    kind: surface.kind || 'surface',
    label: compact(surface.label || '', 160),
    selector: surface.selector || null
  }));
  return {
    version: snapshot.version || PROBE_VERSION,
    url: snapshot.url || null,
    title: compact(snapshot.title || '', 180),
    routeCandidates,
    newlyDiscoveredControls: controls,
    interactionGraph: {
      controls,
      routes: routeCandidates
    },
    surfaces,
    surfaceState: surfaces,
    stateKey: compact(snapshot.stateKey || '', 300),
    mutationSummary: snapshot.mutationSummary || null,
    events: (snapshot.events || []).slice(-200).map(event => ({
      type: event.type || null,
      url: event.url || null,
      ts: event.ts || null,
      summary: event.summary || null
    })),
    visibleTextSummary: compact(snapshot.visibleTextSummary || '', options.maxTextChars)
  };
}

function compact(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function redactSecretText(value) {
  return String(value || '')
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s"'<>:@]+:[^\/\s"'<>@]+@/g, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-api-key]')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|cvv|card|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)[^:=\\s]{0,40}\\s*[:=]\\s*)[^\\s,;&}]+/gi, '$1[redacted]');
}

function redactSensitiveUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '[redacted]';
      parsed.password = '';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|cvv|card|jwt|bearer|googlemaps|map[_-]?key|db[_-]?url|database[_-]?url|mongo(?:db)?[_-]?uri)/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.href;
  } catch (_) {
    return redactSecretText(value);
  }
}

function buildBrowserProbeSummary(snapshots = []) {
  const valid = (snapshots || []).filter(Boolean);
  const routeCandidates = valid.reduce((sum, snapshot) => sum + (snapshot.routeCandidates || []).length, 0);
  const controls = valid.reduce((sum, snapshot) => sum + (snapshot.newlyDiscoveredControls || []).length, 0);
  const events = valid.reduce((sum, snapshot) => sum + (snapshot.events || []).length, 0);
  return {
    schemaVersion: 'ptk-agent-v2-browser-probe-summary',
    generatedAt: new Date().toISOString(),
    enabled: valid.length > 0,
    snapshots: valid.length,
    routeCandidates,
    controls,
    events,
    spaRouteEvents: valid.reduce((sum, snapshot) => sum + (snapshot.events || []).filter(event => /hashchange|pushState|replaceState|popstate/.test(event.type || '')).length, 0)
  };
}

module.exports = {
  PROBE_VERSION,
  buildBrowserProbeSummary,
  drainBrowserProbeEvents,
  getBrowserProbeSnapshot,
  installBrowserProbe,
  probeConfig,
  sanitizeProbeSnapshot,
  redactSensitiveUrl,
  verifyBrowserProbe
};
