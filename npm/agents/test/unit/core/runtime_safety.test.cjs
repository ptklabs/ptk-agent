'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { ARTIFACT_FILENAMES, readJsonArtifact } = require('../../../src/core/artifacts.cjs');
const { resolveConfig } = require('../../../src/core/config.cjs');
const { createOrchestrator } = require('../../../src/core/orchestrator.cjs');
const { createRuntimeSafetyMonitor, resolveRouteWatchdogMs } = require('../../../src/core/runtimeSafety.cjs');
const { createTelemetryRun } = require('../../../src/core/telemetry.cjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('runtime safety monitor writes heartbeat and flush-on-failure artifacts', () => {
  let now = 1000;
  const dir = tmpDir('ptk-runtime-safety-');
  const config = resolveConfig({
    generatedAt: '2026-05-05T00:00:00.000Z',
    overrides: {
      target: { baseUrl: 'http://example.test' },
      ptk: { enabled: false },
      artifacts: { outputDir: dir }
    }
  });
  const telemetry = createTelemetryRun({ runId: 'runtime-safety', now: () => now });
  const monitor = createRuntimeSafetyMonitor({
    config,
    telemetry,
    now: () => now
  });

  monitor.start({ phase: 'test' });
  now += 10;
  monitor.routeStarted({ url: 'http://example.test/a', routeShape: '/a', source: 'test' });
  now += 10;
  monitor.flushOnFailure(new Error('password=secret route stall'), { phase: 'route', status: 'failed' });

  const heartbeat = readJsonArtifact(path.join(dir, ARTIFACT_FILENAMES.runHeartbeat));
  const summary = readJsonArtifact(path.join(dir, ARTIFACT_FILENAMES.browserRuntimeSummary));

  assert.equal(heartbeat.schemaVersion, 'ptk-agent-v2-run-heartbeat');
  assert.equal(heartbeat.runStatus, 'failed');
  assert.equal(summary.schemaVersion, 'ptk-agent-v2-browser-runtime-summary');
  assert.equal(summary.status, 'failed');
  assert.ok(summary.statuses.some(status => status.status === 'artifact_flush_on_failure'));
  assert.equal(summary.error.includes('secret'), false);
});

test('crawl route watchdog finalizes a stalled route and writes runtime artifacts', async () => {
  const dir = tmpDir('ptk-runtime-watchdog-');
  const config = resolveConfig({
    generatedAt: '2026-05-05T00:00:00.000Z',
    overrides: {
      target: { baseUrl: 'http://example.test' },
      crawler: {
        maxRoutes: 1,
        maxRouteMs: 1,
        maxObservationMs: 1,
        maxActionMs: 1,
        maxActionsPerRoute: 0,
        maxFormsPerRoute: 0,
        surfaceExplorer: { enabled: false }
      },
      ptk: { enabled: false },
      artifacts: { outputDir: dir }
    }
  });
  const telemetry = createTelemetryRun({ runId: 'route-watchdog' });
  const page = {
    url() {
      return 'http://example.test';
    }
  };
  const neverResolves = () => new Promise(() => {});

  const result = await createOrchestrator().orchestrate({
    config,
    telemetry,
    page,
    runRouteWorker: neverResolves,
    options: { cwd: dir }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.routeStatusSummary.statuses.timeout, 1);
  assert.equal(result.coverage.routeLifecycle.finalizedCount, 1);
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.runHeartbeat)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.browserRuntimeSummary)));

  const runtime = readJsonArtifact(path.join(dir, ARTIFACT_FILENAMES.browserRuntimeSummary));
  assert.equal(runtime.status, 'completed');
  assert.ok(runtime.statuses.some(status => status.status === 'route_timeout'));
  assert.equal(runtime.routeWatchdog.routeTimeouts.length, 1);
});

test('crawl route watchdog finalizes one stalled route and continues the frontier', async () => {
  const dir = tmpDir('ptk-runtime-watchdog-continue-');
  const config = resolveConfig({
    generatedAt: '2026-05-05T00:00:00.000Z',
    overrides: {
      target: {
        baseUrl: 'http://example.test',
        scope: { include: ['http://example.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 2,
        maxRouteMs: 1,
        maxObservationMs: 1,
        maxActionMs: 1,
        maxActionsPerRoute: 0,
        maxFormsPerRoute: 0,
        surfaceExplorer: { enabled: false }
      },
      ptk: { enabled: false },
      artifacts: { outputDir: dir }
    }
  });
  const telemetry = createTelemetryRun({ runId: 'route-watchdog-continue' });
  const page = {
    url() {
      return 'http://example.test';
    }
  };
  const seenRoutes = [];

  const result = await createOrchestrator().orchestrate({
    config,
    telemetry,
    page,
    startUrls: ['http://example.test/stall', 'http://example.test/next'],
    runRouteWorker: async ({ route }) => {
      seenRoutes.push(route.url);
      if (route.url.endsWith('/next')) return new Promise(() => {});
      return {
        route,
        ok: true,
        finalStatus: 'visited',
        reason: 'visited',
        pageModel: {
          url: route.url,
          routeShape: route.url,
          links: [],
          forms: [],
          actions: []
        },
        observation: { events: [], links: [] }
      };
    },
    options: { cwd: dir }
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(seenRoutes, ['http://example.test/next', 'http://example.test/stall']);
  assert.equal(result.coverage.routeStatusSummary.statuses.timeout, 1);
  assert.equal(result.coverage.routeStatusSummary.statuses['no-action-surfaces'], 1);
  assert.equal(result.coverage.routeLifecycle.finalizedCount, 2);
});

test('route watchdog budget is derived from crawler budgets', () => {
  const config = resolveConfig({
    generatedAt: '2026-05-05T00:00:00.000Z',
    overrides: {
      target: { baseUrl: 'http://example.test' },
      crawler: {
        maxRouteMs: 10,
        maxObservationMs: 20,
        maxActionMs: 30,
        maxActionsPerRoute: 1,
        maxFormsPerRoute: 1,
        surfaceExplorer: {
          enabled: true,
          maxExpansionsPerRoute: 2,
          maxExpansionMs: 40
        }
      },
      ptk: { enabled: false }
    }
  });

  assert.equal(resolveRouteWatchdogMs(config), config.crawler.perRouteBudgetMs + 400 + 500);
});
