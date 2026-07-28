'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  compareRunArtifacts,
  formatComparison,
  normalizeRunMetrics
} = require('../../../src/core/comparison.cjs');
const { createNullLogger } = require('../../../src/core/logger.cjs');
const { UnsupportedExecutionError, determineRequestedMode } = require('../../../src/core/orchestrator.cjs');
const { runDryRun, runPtkAgent } = require('../../../src/core/runner.cjs');

test('normalizeRunMetrics extracts comparison fields from summary artifacts', () => {
  const metrics = normalizeRunMetrics({
    totalDurationMs: 100,
    routes: [{ url: '/a' }, { url: '/b' }],
    routeShapes: ['/a', '/b'],
    endpoints: ['/api'],
    formCount: 3,
    actionCount: 4,
    findingsCount: 1,
    waitTimeMs: 5,
    noProgressActionCount: 2,
    errorCount: 0
  });

  assert.equal(metrics.totalDurationMs, 100);
  assert.equal(metrics.routeCount, 2);
  assert.equal(metrics.routeShapeCount, 2);
  assert.equal(metrics.endpointCount, 1);
  assert.equal(metrics.formCount, 3);
  assert.equal(metrics.actionCount, 4);
});

test('compareRunArtifacts reports plain regressions', () => {
  const comparison = compareRunArtifacts(
    {
      totalDurationMs: 100,
      routeCount: 5,
      routeShapeCount: 5,
      endpointCount: 4,
      waitTimeMs: 0,
      noProgressActionCount: 0
    },
    {
      totalDurationMs: 300,
      routeCount: 3,
      routeShapeCount: 4,
      endpointCount: 2,
      waitTimeMs: 10,
      noProgressActionCount: 2
    },
    {
      generatedAt: '2026-05-04T00:00:00.000Z'
    }
  );

  assert.equal(comparison.passed, false);
  assert.ok(comparison.regressions.some((item) => item.field === 'routeCount'));
  assert.match(formatComparison(comparison), /regressions detected/);
});

test('determineRequestedMode keeps scenario and agent explicit', () => {
  assert.equal(determineRequestedMode({}, { scenario: { enabled: true } }), 'scenario');
  assert.equal(determineRequestedMode({}, { agent: { enabled: true } }), 'agent');
  assert.equal(determineRequestedMode({ mode: 'scan' }, { agent: { enabled: true } }), 'scan');
});

test('runDryRun writes core artifacts without browser or crawler handlers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-runner-'));
  const result = await runDryRun({
    logger: createNullLogger(),
    runId: 'run-dry',
    now: () => 1000,
    startMs: 1000,
    endMs: 1000,
    overrides: {
      artifacts: {
        outputDir: dir
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.telemetry.mode.actual, 'dry-run');
  assert.ok(fs.existsSync(path.join(dir, 'resolved-config.json')));
  assert.ok(fs.existsSync(path.join(dir, 'timing.json')));
  assert.ok(fs.existsSync(path.join(dir, 'crawl-summary.json')));
});

test('runPtkAgent runs an injected crawler handler and writes telemetry', async () => {
  const result = await runPtkAgent({
    logger: createNullLogger(),
    writeArtifacts: false,
    runId: 'run-fail',
    now: () => 1000,
    startMs: 1000,
    endMs: 1000,
    handlers: {
      crawl: () => ({
        status: 'completed',
        coverage: {
          routes: [{ url: 'http://localhost:3000/' }],
          endpoints: [],
          actions: [],
          forms: []
        }
      })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.routes.length, 1);
  assert.equal(result.telemetry.errorCount, 0);
});

test('runPtkAgent writes PTK findings-count artifact when PTK evidence is available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-findings-'));
  const result = await runPtkAgent({
    logger: createNullLogger(),
    runId: 'run-findings',
    now: () => 1000,
    startMs: 1000,
    endMs: 1000,
    overrides: {
      artifacts: {
        outputDir: dir
      }
    },
    handlers: {
      crawl: () => ({
        status: 'completed',
        coverage: {
          routes: [],
          endpoints: [],
          actions: [],
          forms: [],
          ptk: {
            exported: true,
            evidence: {
              findings: [
                { title: 'DOM XSS', severity: 'high', engine: 'DAST', url: 'http://localhost/#/search?q=x' }
              ]
            }
          }
        }
      })
    }
  });

  const filePath = path.join(dir, 'ptk-findings-count.json');
  const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.ptkFindingsCount, filePath);
  assert.equal(artifact.findingsCount, 1);
  assert.equal(artifact.bySeverity.high, 1);
});

test('runPtkAgent marks required missing PTK bridge invalid and writes lifecycle artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-lifecycle-'));
  const result = await runPtkAgent({
    logger: createNullLogger(),
    runId: 'run-required-ptk',
    now: () => 1000,
    startMs: 1000,
    endMs: 1000,
    requirePtkBridge: true,
    overrides: {
      artifacts: {
        outputDir: dir
      }
    },
    handlers: {
      crawl: () => ({
        status: 'completed',
        coverage: {
          routes: [],
          endpoints: [],
          actions: [],
          forms: []
        }
      })
    }
  });

  const lifecyclePath = path.join(dir, 'ptk-lifecycle.json');
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_no_ptk_bridge');
  assert.equal(result.artifacts.ptkLifecycle, lifecyclePath);
  assert.equal(lifecycle.validity.status, 'invalid_no_ptk_bridge');
  assert.equal(lifecycle.required.bridge, true);
});

test('assertSupportedSkeleton still reports missing explicit handlers when requested', () => {
  const { assertSupportedSkeleton } = require('../../../src/core/orchestrator.cjs');

  assert.throws(
    () => assertSupportedSkeleton({ crawler: { enabled: true } }, {}, {}),
    UnsupportedExecutionError
  );
});
