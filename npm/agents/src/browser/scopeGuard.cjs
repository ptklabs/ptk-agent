'use strict';

const { describeScopeFailure, isInScope, scopeFromConfig } = require('./context.cjs');

const SESSION_DESTRUCTIVE_SEGMENTS = new Set([
  'logout',
  'log-out',
  'logoff',
  'log-off',
  'signout',
  'sign-out',
  'signoff',
  'sign-off',
  'end-session',
  'invalidate-session',
  'destroy-session'
]);

const SESSION_DESTRUCTIVE_PARAM_NAMES = new Set([
  'logout',
  'logoff',
  'signout',
  'signoff'
]);

const SESSION_DESTRUCTIVE_ACTION_PARAMS = new Set([
  'action',
  'cmd',
  'command',
  'do',
  'event',
  'method',
  'mode',
  'op',
  'operation',
  'task'
]);

class ScopeGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScopeGuardError';
    this.code = 'ERR_PTK_SCOPE_GUARD';
    this.details = details;
  }
}

function normalizeRouteSegment(segment) {
  const value = String(segment || '').trim().toLowerCase();
  if (!value) return '';
  return value.replace(/\.[a-z0-9]{1,12}$/i, '');
}

function collectRouteSegments(parsed) {
  const routeTexts = [parsed.pathname || '/'];
  const hash = String(parsed.hash || '');
  if (hash === '#/' || hash.startsWith('#/') || hash.startsWith('#!/')) {
    routeTexts.push(hash.replace(/^#!/, '').replace(/^#/, '').split(/[?#]/)[0]);
  }
  return routeTexts
    .flatMap(text => String(text || '').split('/'))
    .map(normalizeRouteSegment)
    .filter(Boolean);
}

function isSessionDestructiveRoute(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url, options.baseUrl || undefined);
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const segments = collectRouteSegments(parsed);
  if (segments.some(segment => SESSION_DESTRUCTIVE_SEGMENTS.has(segment))) return true;

  for (const [name, value] of parsed.searchParams.entries()) {
    const normalizedName = String(name || '').trim().toLowerCase();
    const normalizedValue = normalizeRouteSegment(value);
    if (SESSION_DESTRUCTIVE_PARAM_NAMES.has(normalizedName)) return true;
    if (SESSION_DESTRUCTIVE_ACTION_PARAMS.has(normalizedName) && SESSION_DESTRUCTIVE_SEGMENTS.has(normalizedValue)) {
      return true;
    }
  }

  return false;
}

function allowsSessionDestructiveRoutes(config = {}, options = {}) {
  if (options.allowSessionDestructiveRoutes === true) return true;
  if (options.allowDestructiveActions === true) return true;
  if (config.crawler && config.crawler.allowSessionDestructiveRoutes === true) return true;
  if (config.agent && config.agent.allowDestructiveActions === true) return true;
  return false;
}

function evaluateNavigationScope(url, { config = {}, scope = null, kind = 'navigation' } = {}) {
  const effectiveScope = scope || scopeFromConfig(config || {});
  if (isSessionDestructiveRoute(url, {
    baseUrl: effectiveScope && effectiveScope.baseUrl || config.target && config.target.baseUrl
  }) && !allowsSessionDestructiveRoutes(config)) {
    return {
      allowed: false,
      reason: 'session-destructive-route',
      scope: effectiveScope
        ? {
          origin: effectiveScope.origin,
          include: effectiveScope.include || [],
          exclude: effectiveScope.exclude || []
        }
        : null,
      kind,
      url
    };
  }
  if (!effectiveScope) {
    return {
      allowed: true,
      reason: 'scope_unavailable',
      scope: null,
      url
    };
  }
  const allowed = isInScope(url, effectiveScope);
  return {
    allowed,
    reason: allowed ? 'in-scope' : describeScopeFailure(url, effectiveScope),
    scope: {
      origin: effectiveScope.origin,
      include: effectiveScope.include || [],
      exclude: effectiveScope.exclude || []
    },
    kind,
    url
  };
}

function assertNavigationAllowed(url, options = {}) {
  const evaluation = evaluateNavigationScope(url, options);
  if (!evaluation.allowed) {
    throw new ScopeGuardError(`Out-of-scope ${evaluation.kind || 'navigation'} refused for ${url}: ${evaluation.reason}.`, evaluation);
  }
  return evaluation;
}

function isScopeGuardError(error) {
  return Boolean(error && (error.code === 'ERR_PTK_SCOPE_GUARD' || error.name === 'ScopeGuardError'));
}

module.exports = {
  ScopeGuardError,
  assertNavigationAllowed,
  evaluateNavigationScope,
  isSessionDestructiveRoute,
  isScopeGuardError
};
