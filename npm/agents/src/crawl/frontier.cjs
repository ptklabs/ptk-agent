'use strict';

const { normalizeScope, isInScope, matchesPattern } = require('../browser/context.cjs');
const { normalizeUrl: normalizePageUrl, routeShape } = require('../browser/pageModel.cjs');
const { isSessionDestructiveRoute } = require('../browser/scopeGuard.cjs');

const SOURCE_PRIORITY = Object.freeze({
  scenario: 10,
  'route-hint': 18,
  'ptk-finding-entrypoint': 20,
  'ptk-analysis': 25,
  sast: 30,
  'sast-hidden-route': 30,
  'surface-expansion': 40,
  'code-signal': 50,
  'owned-child': 55,
  'action-discovered': 60,
  action: 60,
  'auth-confirmed': 12,
  'auth-retry': 15,
  memory: 70,
  link: 80,
  'observed-link': 85,
  'plain-link': 90,
  'low-value': 100,
  target: 0,
  start: 5,
  hint: 10
});

function priorityForMeta(meta = {}) {
  if (Number.isFinite(Number(meta.priority))) return Number(meta.priority);
  const source = String(meta.sourceTag || meta.source || meta.reason || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, source)) return SOURCE_PRIORITY[source];
  if (source.startsWith('action:')) return SOURCE_PRIORITY.action;
  if (source.includes('surface')) return SOURCE_PRIORITY['surface-expansion'];
  if (source.includes('code-signal')) return SOURCE_PRIORITY['code-signal'];
  if (source.includes('memory')) return SOURCE_PRIORITY.memory;
  if (source.includes('link')) return SOURCE_PRIORITY.link;
  return 75;
}

function normalizeUrl(url, baseUrl, options = {}) {
  const normalized = normalizePageUrl(url, baseUrl, {
    preserveSpaHashRoutes: options.preserveSpaHashRoutes !== false,
    spaHashBaseUrl: options.spaHashBaseUrl || baseUrl
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

function directPathToSpaHashEquivalent(url, spaHashBaseUrl) {
  if (!url || !spaHashBaseUrl) return null;
  try {
    const parsed = new URL(url);
    const spaBase = new URL(spaHashBaseUrl);
    if (parsed.origin !== spaBase.origin) return null;
    if (parsed.hash) return null;

    const basePath = spaBase.pathname.endsWith('/') ? spaBase.pathname : `${spaBase.pathname}/`;
    const path = parsed.pathname;
    if (path === spaBase.pathname || path === basePath) return null;
    if (!path.startsWith(basePath)) return null;

    const relativePath = path.slice(basePath.length);
    if (!relativePath || relativePath.startsWith('.')) return null;
    const lastSegment = relativePath.split('/').filter(Boolean).pop() || '';
    if (/\.[a-z0-9]{1,12}$/i.test(lastSegment)) return null;

    const equivalent = new URL(spaBase.href);
    equivalent.search = '';
    equivalent.hash = `#/${relativePath}${parsed.search || ''}`;
    return equivalent.href;
  } catch (_) {
    return null;
  }
}

function spaHashToDirectPathEquivalent(url, spaHashBaseUrl) {
  if (!url || !spaHashBaseUrl) return null;
  try {
    const parsed = new URL(url);
    const spaBase = new URL(spaHashBaseUrl);
    if (parsed.origin !== spaBase.origin) return null;
    const hash = String(parsed.hash || '');
    if (!(hash === '#/' || hash.startsWith('#/') || hash.startsWith('#!/'))) return null;

    let route = hash.slice(1);
    if (route.startsWith('!')) route = route.slice(1);
    if (!route.startsWith('/')) route = `/${route}`;
    const routeUrl = new URL(route, parsed.origin);
    const basePath = spaBase.pathname.endsWith('/') ? spaBase.pathname : `${spaBase.pathname}/`;
    const equivalent = new URL(spaBase.href);
    equivalent.pathname = `${basePath}${routeUrl.pathname.replace(/^\/+/, '')}`;
    equivalent.search = routeUrl.search || '';
    equivalent.hash = '';
    return equivalent.href;
  } catch (_) {
    return null;
  }
}

class Frontier {
  constructor({ baseUrl, include = [], exclude = [], maxRoutes = 100, maxDepth = 5, preserveSpaHashRoutes = true, spaHashBaseUrl = null, allowSessionDestructiveRoutes = false, onEvent = null } = {}) {
    if (!baseUrl) throw new Error('Frontier requires baseUrl.');
    this.baseUrl = baseUrl;
    this.spaHashBaseUrl = spaHashBaseUrl || baseUrl;
    this.scope = normalizeScope(baseUrl, include, exclude);
    this.maxRoutes = Number.isFinite(maxRoutes) ? maxRoutes : 100;
    this.maxDepth = Number.isFinite(Number(maxDepth)) && Number(maxDepth) >= 0 ? Number(maxDepth) : 5;
    this.preserveSpaHashRoutes = preserveSpaHashRoutes !== false;
    this.allowSessionDestructiveRoutes = allowSessionDestructiveRoutes === true;
    this.queue = [];
    this.seen = new Set();
    this.revisitSeen = new Set();
    this.visited = new Set();
    this.rejected = [];
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
  }

  emit(type, data = {}) {
    if (this.onEvent) this.onEvent({ type, ...data });
  }

  evictLowerPriorityRoute(priority, replacementUrl, replacementMeta = {}) {
    let worstIndex = -1;
    let worstPriority = priority;
    for (let index = 0; index < this.queue.length; index += 1) {
      const route = this.queue[index];
      const routePriority = Number(route.priority || 75);
      if (routePriority <= worstPriority) continue;
      worstIndex = index;
      worstPriority = routePriority;
    }
    if (worstIndex < 0) return false;
    const [removed] = this.queue.splice(worstIndex, 1);
    if (removed.revisitKey) this.revisitSeen.delete(removed.revisitKey);
    else this.seen.delete(removed.url);
    const rejection = {
      url: removed.url,
      reason: 'replaced-by-higher-priority',
      source: removed.source || 'queued',
      sourceTag: removed.sourceTag || removed.source || 'queued',
      priority: removed.priority,
      replacementUrl,
      replacementSource: replacementMeta.sourceTag || replacementMeta.source || 'discovered',
      replacementPriority: priority
    };
    this.rejected.push(rejection);
    this.emit('route_rejected', rejection);
    return true;
  }

  enqueue(url, meta = {}) {
    const priority = priorityForMeta(meta);
    const rejectionMeta = reason => ({
      source: meta.source || meta.sourceTag || meta.reason || 'discovered',
      sourceTag: meta.sourceTag || meta.source || meta.reason || 'discovered',
      priority,
      reason
    });
    const normalized = normalizeUrl(typeof url === 'string' ? url : url && url.href, this.baseUrl, {
      preserveSpaHashRoutes: this.preserveSpaHashRoutes,
      spaHashBaseUrl: this.spaHashBaseUrl
    });
    if (!normalized) {
      const rejection = { url, ...rejectionMeta('invalid-url') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
      return false;
    }
    if (!isInScope(normalized, this.scope)) {
      const rejection = { url: normalized, ...rejectionMeta('out-of-scope') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
      return false;
    }
    if (!this.allowSessionDestructiveRoutes && isSessionDestructiveRoute(normalized, { baseUrl: this.baseUrl })) {
      const rejection = { url: normalized, ...rejectionMeta('session-destructive-route') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
      return false;
    }
    const spaHashEquivalent = this.preserveSpaHashRoutes
      ? directPathToSpaHashEquivalent(normalized, this.spaHashBaseUrl)
      : null;
    if (spaHashEquivalent && (this.seen.has(spaHashEquivalent) || this.visited.has(spaHashEquivalent))) {
      const rejection = { url: normalized, canonicalUrl: spaHashEquivalent, ...rejectionMeta('spa-hash-duplicate') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
      return false;
    }
    const directEquivalent = this.preserveSpaHashRoutes
      ? spaHashToDirectPathEquivalent(normalized, this.spaHashBaseUrl)
      : null;
    if (directEquivalent && this.seen.has(directEquivalent) && !this.visited.has(directEquivalent)) {
      this.seen.delete(directEquivalent);
      this.queue = this.queue.filter(route => route.url !== directEquivalent);
      const rejection = { url: directEquivalent, canonicalUrl: normalized, ...rejectionMeta('spa-hash-duplicate') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
    }
    const depth = Number.isFinite(Number(meta.depth)) && Number(meta.depth) >= 0 ? Number(meta.depth) : 0;
    if (depth > this.maxDepth) {
      const rejection = { url: normalized, depth, maxDepth: this.maxDepth, ...rejectionMeta('max-depth') };
      this.rejected.push(rejection);
      this.emit('route_rejected', rejection);
      return false;
    }
    const duplicate = this.seen.has(normalized) || this.visited.has(normalized);
    const allowRevisit = meta.allowRevisit === true;
    const revisitKey = allowRevisit
      ? `${normalized}::${meta.revisitKey || meta.authBucket || meta.sourceTag || meta.source || 'revisit'}`
      : null;
    if (duplicate && !allowRevisit) return false;
    if (duplicate && this.revisitSeen.has(revisitKey)) return false;
    if (this.seen.size + this.revisitSeen.size >= this.maxRoutes) {
      if (!this.evictLowerPriorityRoute(priority, normalized, meta)) {
        const rejection = { url: normalized, reason: 'max-routes', source: meta.source || meta.reason || 'discovered', priority };
        this.rejected.push(rejection);
        this.emit('route_rejected', rejection);
        return false;
      }
    }
    if (duplicate) this.revisitSeen.add(revisitKey);
    else this.seen.add(normalized);
    const route = {
      url: normalized,
      depth,
      source: meta.source || meta.reason || 'discovered',
      sourceTag: meta.sourceTag || meta.source || meta.reason || 'discovered',
      priority,
      evidenceRefs: Array.isArray(meta.evidenceRefs) ? meta.evidenceRefs.slice() : [],
      reason: meta.reason || null,
      hintKind: meta.hintKind || null,
      revisitKey: duplicate ? revisitKey : null,
      routeShape: routeShape(normalized, {
        preserveSpaHashRoutes: this.preserveSpaHashRoutes,
        spaHashBaseUrl: this.spaHashBaseUrl
      }),
      enqueuedAt: new Date().toISOString()
    };
    this.queue.push(route);
    this.queue.sort((a, b) => {
      const priorityDelta = (a.priority || 75) - (b.priority || 75);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
    });
    this.emit('route_queued', route);
    return true;
  }

  enqueueMany(urls, meta = {}) {
    let added = 0;
    for (const url of urls || []) {
      if (this.enqueue(url, meta)) added += 1;
    }
    return added;
  }

  dequeue() {
    const route = this.queue.shift() || null;
    if (route) this.visited.add(route.url);
    if (route) this.emit('next_route_selected', { routeUrl: route.url, routeShape: route.routeShape, source: route.source, sourceTag: route.sourceTag, priority: route.priority, remaining: this.queue.length });
    return route;
  }

  next() {
    return this.dequeue();
  }

  isEmpty() {
    return this.queue.length === 0;
  }

  hasNext() {
    return !this.isEmpty();
  }

  size() {
    return this.queue.length;
  }

  stats() {
    return {
      queued: this.queue.length,
      seen: this.seen.size,
      revisits: this.revisitSeen.size,
      visited: this.visited.size,
      rejected: this.rejected.length,
      maxRoutes: this.maxRoutes,
      maxDepth: this.maxDepth,
      rejectedBySource: countBy(this.rejected, 'source'),
      rejectedByPriority: countBy(this.rejected, 'priority')
    };
  }

  snapshot() {
    return {
      queued: this.queue.length,
      queue: this.queue.slice(),
      seen: Array.from(this.seen),
      revisits: Array.from(this.revisitSeen),
      visited: Array.from(this.visited),
      rejected: this.rejected.slice(),
      stats: this.stats()
    };
  }

  toJSON() {
    return this.snapshot();
  }
}

function countBy(items = [], key) {
  const out = {};
  for (const item of items || []) {
    const value = item && item[key] !== undefined && item[key] !== null ? String(item[key]) : 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function createFrontier(options) {
  return new Frontier(options);
}

module.exports = {
  Frontier,
  createFrontier,
  normalizeUrl,
  priorityForMeta,
  SOURCE_PRIORITY,
  directPathToSpaHashEquivalent,
  spaHashToDirectPathEquivalent,
  matchesPattern,
  isInScope
};
