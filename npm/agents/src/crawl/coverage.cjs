'use strict';

const { redactSensitiveUrl } = require('./routeLifecycle.cjs');

function redactUrl(value) {
  return value ? redactSensitiveUrl(value) : value;
}

class Coverage {
  constructor() {
    this.routes = new Map();
    this.routeShapes = new Set();
    this.endpoints = new Map();
    this.forms = new Map();
    this.actions = new Map();
    this.transitions = [];
    this.edges = this.transitions;
    this.errors = [];
    this.blockedRoutes = [];
    this.blockedActions = [];
    this.codeSignals = {
      scripts: [],
      skippedScripts: [],
      routes: [],
      endpoints: []
    };
  }

  recordRoute(route = {}, model = {}, timing = {}) {
    const url = route.url || model.url;
    if (!url) return null;
    const record = {
      url: redactUrl(url),
      source: route.source || route.reason || 'unknown',
      sourceTag: route.sourceTag || route.source || route.reason || 'unknown',
      priority: route.priority !== undefined ? route.priority : null,
      evidenceRefs: Array.isArray(route.evidenceRefs) ? route.evidenceRefs.slice() : [],
      reason: route.reason || null,
      hintKind: route.hintKind || null,
      depth: route.depth || 0,
      routeShape: redactUrl(model.routeShape || route.routeShape),
      title: model.title || '',
      surfaceType: model.surfaceType || 'unknown',
      timing,
      visitedAt: new Date().toISOString()
    };
    this.routes.set(record.url, record);
    if (record.routeShape) this.routeShapes.add(record.routeShape);
    return record;
  }

  recordEndpoint(event, routeUrl = null) {
    if (!event) return null;
    const url = event.url || event.path;
    const path = event.path || url;
    if (!url && !path) return null;
    const method = String(event.method || (event.type === 'response' ? 'RESPONSE' : 'GET')).toUpperCase();
    const key = `${method} ${path}`;
    const record = {
      key,
      method,
      url: redactUrl(event.url || null),
      path: redactUrl(path),
      status: event.status || null,
      resourceType: event.resourceType || 'unknown',
      graphqlOperationName: event.graphqlOperationName || null,
      source: event.source || event.sourceTag || event.type || null,
      routeUrl: redactUrl(routeUrl),
      observedAt: new Date().toISOString()
    };
    this.endpoints.set(key, record);
    return record;
  }

  recordCodeSignals(codeSignals = {}, routeUrl = null) {
    if (!codeSignals || codeSignals.enabled === false) return null;
    for (const script of codeSignals.scripts || []) this.codeSignals.scripts.push({ ...script, routeUrl: redactUrl(routeUrl) });
    for (const skipped of codeSignals.skippedScripts || []) this.codeSignals.skippedScripts.push({ ...skipped, routeUrl: redactUrl(routeUrl) });
    for (const route of codeSignals.routes || []) this.codeSignals.routes.push({ ...route, routeUrl: redactUrl(routeUrl) });
    for (const endpoint of codeSignals.endpoints || []) {
      this.codeSignals.endpoints.push({ ...endpoint, routeUrl });
      this.recordEndpoint(endpoint, routeUrl);
    }
    return this.codeSignals;
  }

  recordForm(form, routeUrl) {
    if (!form) return null;
    const key = `${routeUrl || ''}#${form.id || form.action || form.selector || 'form'}`;
    const record = { ...form, routeUrl: redactUrl(routeUrl || null), observedAt: new Date().toISOString() };
    this.forms.set(key, record);
    return record;
  }

  recordAction(action, routeUrl, transition = null) {
    if (!action) return null;
    const key = `${routeUrl || ''}#${action.id || action.selector || action.label || 'action'}`;
    const record = { ...action, routeUrl: redactUrl(routeUrl || null), transition, observedAt: new Date().toISOString() };
    this.actions.set(key, record);
    return record;
  }

  recordTransition(transition) {
    if (!transition) return null;
    const record = { ...transition, observedAt: new Date().toISOString() };
    this.transitions.push(record);
    return record;
  }

  recordEdge(edge) {
    return this.recordTransition(edge);
  }

  recordError(error, context = {}) {
    const record = {
      message: error && error.message ? error.message : String(error),
      context,
      observedAt: new Date().toISOString()
    };
    this.errors.push(record);
    return record;
  }

  recordBlockedRoute(route = {}, reason = 'blocked', details = {}) {
    if (!route || !route.url) return null;
    const record = {
      url: route.url,
      source: route.source || route.sourceTag || 'unknown',
      sourceTag: route.sourceTag || route.source || 'unknown',
      depth: route.depth || 0,
      routeShape: route.routeShape || null,
      reason,
      details,
      observedAt: new Date().toISOString()
    };
    this.blockedRoutes.push(record);
    return record;
  }

  recordBlockedAction(action = {}, routeUrl = null, reason = 'blocked', details = {}) {
    if (!action) return null;
    const record = {
      id: action.id || action.selector || action.href || action.label || 'action',
      kind: action.kind || null,
      href: action.href || null,
      label: action.label || null,
      routeUrl: routeUrl || null,
      reason,
      details,
      observedAt: new Date().toISOString()
    };
    this.blockedActions.push(record);
    return record;
  }

  routeCount() {
    return this.routes.size;
  }

  summary() {
    return {
      routesVisited: this.routes.size,
      routeShapes: this.routeShapes.size,
      endpointsObserved: this.endpoints.size,
      formsDiscovered: this.forms.size,
      actionsDiscovered: this.actions.size,
      codeSignalRoutes: this.codeSignals.routes.length,
      codeSignalEndpoints: this.codeSignals.endpoints.length,
      blockedRoutes: this.blockedRoutes.length,
      blockedActions: this.blockedActions.length,
      transitionsObserved: this.transitions.length,
      errors: this.errors.length
    };
  }

  snapshot() {
    return {
      summary: this.summary(),
      routes: Array.from(this.routes.values()),
      routeShapes: Array.from(this.routeShapes),
      endpoints: Array.from(this.endpoints.values()),
      forms: Array.from(this.forms.values()),
      actions: Array.from(this.actions.values()),
      blockedRoutes: this.blockedRoutes.slice(),
      blockedActions: this.blockedActions.slice(),
      codeSignals: {
        scripts: this.codeSignals.scripts.slice(),
        skippedScripts: this.codeSignals.skippedScripts.slice(),
        routes: this.codeSignals.routes.slice(),
        endpoints: this.codeSignals.endpoints.slice()
      },
      transitions: this.transitions.slice(),
      edges: this.transitions.slice(),
      errors: this.errors.slice()
    };
  }

  toJSON() {
    return this.snapshot();
  }
}

function createCoverageTracker() {
  return new Coverage();
}

module.exports = {
  Coverage,
  CoverageTracker: Coverage,
  createCoverageTracker
};
