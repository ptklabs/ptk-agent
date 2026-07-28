'use strict';

const { extractPtkFindings, findingFingerprint } = require('../evidence/ptkEvidenceAdapter.cjs');

function recordActionEffect({ mission = {}, action = null, beforeCoverage = {}, afterCoverage = {}, transition = null, startedAt = null, endedAt = null } = {}) {
  const before = coverageCounts(beforeCoverage);
  const after = coverageCounts(afterCoverage);
  const delta = coverageDelta(beforeCoverage, afterCoverage, before, after);
  const changed = hasMeaningfulCoverageDelta(delta) || Boolean(transition && (transition.changed || transition.changedState));
  const noProgress = Boolean(transition && transition.noProgress) || !changed;
  return {
    schemaVersion: 'ptk-agent-v2-action-effect',
    missionId: mission.id || null,
    missionKind: mission.kind || null,
    noProgressKey: mission.noProgressKey || mission.attemptKey || null,
    action,
    startedAt,
    endedAt,
    transition: summarizeTransition(transition),
    before,
    after,
    delta,
    status: changed ? 'progress' : 'no_progress',
    noProgress
  };
}

function coverageCounts(coverage = {}) {
  const summary = coverage && coverage.summary || {};
  return {
    routes: count(coverage.routes, summary.routesVisited || coverage.routeCount),
    routeShapes: count(coverage.routeShapes, summary.routeShapes || coverage.routeShapeCount),
    endpoints: count(coverage.endpoints, summary.endpointsObserved || coverage.endpointCount),
    forms: count(coverage.forms, summary.formsDiscovered || coverage.formCount),
    actions: count(coverage.actions, summary.actionsDiscovered || coverage.actionCount),
    findings: findingFingerprints(coverage).length
  };
}

function count(value, fallback) {
  if (Array.isArray(value)) return value.length;
  const number = Number(fallback);
  return Number.isFinite(number) ? number : 0;
}

function hasCoverageDelta(delta = {}) {
  return Object.values(delta).some(value => Number(value) > 0);
}

function hasMeaningfulCoverageDelta(delta = {}) {
  return ['routes', 'routeShapes', 'endpoints', 'forms', 'findings']
    .some(key => Number(delta[key]) > 0);
}

function coverageDelta(beforeCoverage = {}, afterCoverage = {}, before = coverageCounts(beforeCoverage), after = coverageCounts(afterCoverage)) {
  return {
    routes: setDelta(beforeCoverage.routes, afterCoverage.routes, routeKey, after.routes - before.routes),
    routeShapes: setDelta(beforeCoverage.routeShapes, afterCoverage.routeShapes, valueKey, after.routeShapes - before.routeShapes),
    endpoints: setDelta(beforeCoverage.endpoints, afterCoverage.endpoints, endpointKey, after.endpoints - before.endpoints),
    forms: setDelta(beforeCoverage.forms, afterCoverage.forms, formKey, after.forms - before.forms),
    actions: setDelta(beforeCoverage.actions, afterCoverage.actions, actionKey, after.actions - before.actions),
    findings: setDelta(findingFingerprints(beforeCoverage), findingFingerprints(afterCoverage), valueKey, after.findings - before.findings)
  };
}

function findingFingerprints(coverage = {}) {
  const ptk = coverage && coverage.ptk || {};
  const sources = [
    ptk.evidence,
    ptk.evidence && ptk.evidence.export,
    ptk.export,
    ptk.findings,
    ptk.findings && ptk.findings.findings,
    coverage.agentPtkSignals,
    coverage.agentPtkSignals && coverage.agentPtkSignals.findings,
    coverage.findings
  ].filter(Boolean);
  const out = new Set();
  for (const source of sources) {
    for (const finding of extractPtkFindings(source)) {
      const fp = findingFingerprint(finding);
      if (fp) out.add(fp);
    }
  }
  return Array.from(out);
}

function setDelta(beforeValues, afterValues, keyFn, fallbackDelta = 0) {
  if (!Array.isArray(beforeValues) || !Array.isArray(afterValues)) return Math.max(0, Number(fallbackDelta) || 0);
  const before = new Set(beforeValues.map(keyFn).filter(Boolean));
  let count = 0;
  for (const value of afterValues) {
    const key = keyFn(value);
    if (key && !before.has(key)) count += 1;
  }
  return count;
}

function routeKey(route) {
  if (!route) return null;
  if (typeof route === 'string') return route;
  return route.url || route.href || route.path || null;
}

function endpointKey(endpoint) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') return endpoint;
  return endpoint.key || [endpoint.method, endpoint.path || endpoint.url || endpoint.href].filter(Boolean).join(' ') || null;
}

function formKey(form) {
  if (!form) return null;
  if (typeof form === 'string') return form;
  return [form.url || form.routeUrl || '', form.id || form.selector || form.kind || 'form'].join('#');
}

function actionKey(action) {
  if (!action) return null;
  if (typeof action === 'string') return action;
  return [action.url || action.routeUrl || '', action.id || action.selector || action.text || action.kind || 'action'].join('#');
}

function valueKey(value) {
  return value ? String(value) : null;
}

function summarizeTransition(transition = null) {
  if (!transition) return null;
  return {
    changed: Boolean(transition.changed || transition.changedState),
    noProgress: Boolean(transition.noProgress),
    reason: transition.reason || null,
    signals: Array.isArray(transition.signals) ? transition.signals.slice() : Array.isArray(transition.reasons) ? transition.reasons.slice() : []
  };
}

module.exports = {
  coverageCounts,
  coverageDelta,
  findingFingerprints,
  hasCoverageDelta,
  hasMeaningfulCoverageDelta,
  recordActionEffect
};
