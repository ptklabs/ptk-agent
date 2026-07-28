'use strict';

const crypto = require('crypto');
const { ARTIFACT_FILENAMES, writeJson } = require('./artifacts.cjs');
const { sanitize } = require('../crawl/routeLifecycle.cjs');

const RUNTIME_STATUSES = Object.freeze([
  'running',
  'completed',
  'runtime_stalled',
  'browser_renderer_hot',
  'probe_limit_exceeded',
  'route_timeout',
  'artifact_flush_on_failure'
]);

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function resolveRouteWatchdogMs(config = {}) {
  const crawler = config.crawler || {};
  const surface = crawler.surfaceExplorer || {};
  const base = positiveNumber(crawler.perRouteBudgetMs, null)
    || positiveNumber(crawler.maxRouteMs, 30000)
      + positiveNumber(crawler.maxObservationMs, 800)
      + ((positiveNumber(crawler.maxActionsPerRoute, 0) + positiveNumber(crawler.maxFormsPerRoute, 0))
        * positiveNumber(crawler.maxActionMs, 1000));
  const surfaceBudget = surface.enabled === false
    ? 0
    : resolveSurfaceExplorerWatchdogMs(surface);
  return Math.max(1, Math.ceil(base + surfaceBudget + 500));
}

function resolveSurfaceExplorerWatchdogMs(surface = {}) {
  const explicit = positiveNumber(surface.maxSurfaceMs, null);
  if (explicit) return explicit;
  const expansionMs = positiveNumber(surface.maxExpansionMs, 1000);
  const topLevel = Math.max(1, positiveNumber(surface.maxExpansionsPerRoute, 5));
  const nestedActions = Math.max(1, Math.min(
    positiveNumber(surface.maxMenuActionsPerSurface, 8),
    positiveNumber(surface.maxRouteChangingMenuActions, 8)
  ));
  return expansionMs * (topLevel + nestedActions);
}

function hashSnapshot(value) {
  return crypto.createHash('sha1').update(JSON.stringify(sanitize(value))).digest('hex');
}

function summarizeRoute(route = {}) {
  return sanitize({
    url: route.url || route.href || null,
    routeShape: route.routeShape || route.shape || null,
    source: route.source || route.sourceTag || null,
    sourceTag: route.sourceTag || route.source || null,
    depth: route.depth || 0,
    priority: route.priority || null
  });
}

function createRuntimeSafetyMonitor({
  config = {},
  telemetry = null,
  lifecycle = null,
  now = Date.now
} = {}) {
  const outputDir = config.artifacts && config.artifacts.outputDir || '.ptk/artifacts';
  const routeWatchdogMs = resolveRouteWatchdogMs(config);
  const startedAtMs = now();
  const statuses = [];
  const routeTimeouts = [];
  const probeLimitEvents = [];
  const snapshotRepeats = [];
  const routeFinalStatuses = new Map();
  let activeRoute = null;
  let activeRouteStartedAtMs = null;
  let lastSnapshotHash = null;
  let lastSnapshotRepeatCount = 0;
  let heartbeat = null;
  let browserRuntimeSummary = null;

  function recordStatus(status, detail = {}) {
    const normalized = RUNTIME_STATUSES.includes(status) ? status : 'runtime_stalled';
    const record = sanitize({
      status: normalized,
      ts: nowIso(now),
      ...detail
    });
    statuses.push(record);
    if (lifecycle && typeof lifecycle.emit === 'function') {
      lifecycle.emit('runtime_status', record);
    }
    if (telemetry && typeof telemetry.event === 'function') {
      telemetry.event('runtime.status', record);
    }
    return record;
  }

  function heartbeatSnapshot(update = {}) {
    heartbeat = sanitize({
      schemaVersion: 'ptk-agent-v2-run-heartbeat',
      generatedAt: nowIso(now),
      runStatus: update.status || (heartbeat && heartbeat.runStatus) || 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      updatedAt: nowIso(now),
      activeRoute,
      activeRouteElapsedMs: activeRouteStartedAtMs ? Math.max(0, now() - activeRouteStartedAtMs) : 0,
      routeWatchdogMs,
      statuses,
      routeTimeoutCount: routeTimeouts.length,
      probeLimitExceededCount: probeLimitEvents.length,
      finalizedRouteCount: routeFinalStatuses.size,
      ...update
    });
    return heartbeat;
  }

  function writeHeartbeat(update = {}) {
    const snapshot = heartbeatSnapshot(update);
    writeJson(outputDir, ARTIFACT_FILENAMES.runHeartbeat, snapshot);
    return snapshot;
  }

  function runtimeSummary(update = {}) {
    const lifecycleSnapshot = lifecycle && typeof lifecycle.snapshot === 'function'
      ? lifecycle.snapshot()
      : null;
    browserRuntimeSummary = sanitize({
      schemaVersion: 'ptk-agent-v2-browser-runtime-summary',
      generatedAt: nowIso(now),
      startedAt: new Date(startedAtMs).toISOString(),
      updatedAt: nowIso(now),
      endedAt: update.status === 'completed' || update.status === 'failed' ? nowIso(now) : null,
      status: update.status || (heartbeat && heartbeat.runStatus) || 'running',
      statuses,
      supportedRuntimeStatuses: RUNTIME_STATUSES.filter(status => status !== 'running' && status !== 'completed'),
      routeWatchdog: {
        routeWatchdogMs,
        routeTimeouts
      },
      pageModel: {
        extractionTimeoutMs: positiveNumber(config.crawler && config.crawler.maxObservationMs, 800)
      },
      probe: {
        enabled: Boolean(config.browserProbe && config.browserProbe.enabled),
        maxRoutes: config.browserProbe && config.browserProbe.maxRoutes || null,
        maxControls: config.browserProbe && config.browserProbe.maxControls || null,
        maxNodes: config.browserProbe && config.browserProbe.maxNodes || null,
        maxTextChars: config.browserProbe && config.browserProbe.maxTextChars || null,
        probeLimitEvents,
        repeatedIdenticalSnapshots: snapshotRepeats
      },
      browser: update.browser || null,
      activeRoute,
      finalizedRoutes: Array.from(routeFinalStatuses.values()),
      lifecycle: lifecycleSnapshot ? {
        eventCount: lifecycleSnapshot.eventCount,
        finalizedCount: lifecycleSnapshot.finalizedCount,
        warningCount: lifecycleSnapshot.warningCount
      } : null,
      ...update
    });
    return browserRuntimeSummary;
  }

  function writeBrowserRuntimeSummary(update = {}) {
    const snapshot = runtimeSummary(update);
    writeJson(outputDir, ARTIFACT_FILENAMES.browserRuntimeSummary, snapshot);
    return snapshot;
  }

  function start(update = {}) {
    recordStatus('running', { phase: update.phase || 'crawl' });
    writeHeartbeat({ status: 'running' });
    writeBrowserRuntimeSummary({ status: 'running', browser: update.browser || null });
  }

  function routeStarted(route, detail = {}) {
    activeRoute = summarizeRoute(route);
    activeRouteStartedAtMs = now();
    writeHeartbeat({
      status: 'running',
      activeRoute,
      frontierBefore: detail.frontierBefore || null
    });
  }

  function routeFinalized(route, status, detail = {}) {
    const summary = summarizeRoute(route);
    const routeKey = summary.url || detail.routeKey || null;
    if (routeKey && !routeFinalStatuses.has(routeKey)) {
      routeFinalStatuses.set(routeKey, sanitize({
        ...summary,
        status,
        durationMs: detail.durationMs || 0,
        finalizedAt: nowIso(now),
        reason: detail.reason || null
      }));
    }
    if (activeRoute && routeKey && activeRoute.url === routeKey) {
      activeRoute = null;
      activeRouteStartedAtMs = null;
    }
    writeHeartbeat({ status: 'running' });
  }

  function recordRouteTimeout(route, error, detail = {}) {
    const record = sanitize({
      route: summarizeRoute(route),
      error: error && error.message || String(error || 'route timeout'),
      budgetMs: detail.budgetMs || routeWatchdogMs,
      elapsedMs: detail.elapsedMs || null
    });
    routeTimeouts.push(record);
    recordStatus('route_timeout', record);
    return record;
  }

  function inspectPageModel(pageModel = {}) {
    const probe = pageModel && pageModel.probe || {};
    const eventCount = Array.isArray(probe.events) ? probe.events.length : 0;
    const candidateCount = Array.isArray(pageModel.routeCandidates) ? pageModel.routeCandidates.length : 0;
    const controlCount = Array.isArray(pageModel.newlyDiscoveredControls) ? pageModel.newlyDiscoveredControls.length : 0;
    if (config.browserProbe && config.browserProbe.enabled) {
      if (eventCount > Number(config.browserProbe.maxRoutes || 500) || candidateCount > Number(config.browserProbe.maxRoutes || 500) || controlCount > Number(config.browserProbe.maxControls || 300)) {
        const record = recordStatus('probe_limit_exceeded', {
          eventCount,
          candidateCount,
          controlCount
        });
        probeLimitEvents.push(record);
      }
      const snapshotHash = hashSnapshot({
        url: pageModel.url || null,
        stateKey: pageModel.stateKey || null,
        routeCandidates: pageModel.routeCandidates || [],
        controls: pageModel.newlyDiscoveredControls || []
      });
      if (snapshotHash === lastSnapshotHash) {
        lastSnapshotRepeatCount += 1;
        if (lastSnapshotRepeatCount >= 3) {
          const record = recordStatus('runtime_stalled', {
            reason: 'repeated_identical_page_model_snapshot',
            repeatCount: lastSnapshotRepeatCount,
            routeUrl: pageModel.url || null
          });
          snapshotRepeats.push(record);
        }
      } else {
        lastSnapshotHash = snapshotHash;
        lastSnapshotRepeatCount = 0;
      }
    }
  }

  function flushOnFailure(error, detail = {}) {
    recordStatus('artifact_flush_on_failure', {
      error: error && error.message || String(error || 'failure'),
      phase: detail.phase || null
    });
    const hb = writeHeartbeat({
      status: detail.status || 'failed'
    });
    const summary = writeBrowserRuntimeSummary({
      status: detail.status || 'failed',
      browser: detail.browser || null,
      error: error && error.message || String(error || 'failure')
    });
    return { heartbeat: hb, browserRuntimeSummary: summary };
  }

  function snapshot(update = {}) {
    return {
      runHeartbeat: heartbeatSnapshot(update),
      browserRuntimeSummary: runtimeSummary(update)
    };
  }

  return {
    routeWatchdogMs,
    start,
    recordStatus,
    routeStarted,
    routeFinalized,
    recordRouteTimeout,
    inspectPageModel,
    writeHeartbeat,
    writeBrowserRuntimeSummary,
    flushOnFailure,
    heartbeatSnapshot,
    runtimeSummary,
    snapshot
  };
}

module.exports = {
  RUNTIME_STATUSES,
  createRuntimeSafetyMonitor,
  resolveRouteWatchdogMs
};
