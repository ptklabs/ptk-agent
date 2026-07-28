'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  ARTIFACT_FILENAMES,
  createArtifactWriter,
  readJsonArtifact,
  writeStandardArtifacts
} = require('../../../src/core/artifacts.cjs');
const { resolveConfig } = require('../../../src/core/config.cjs');
const { createLogger } = require('../../../src/core/logger.cjs');
const { createTelemetryRun } = require('../../../src/core/telemetry.cjs');

test('telemetry records required counts, timings, modes, and redacted events', () => {
  let now = 1000;
  const telemetry = createTelemetryRun({
    runId: 'run-1',
    requestedMode: 'crawl',
    actualMode: 'crawl',
    now: () => now
  });

  telemetry.setMode({
    requestedMode: 'crawl',
    actualMode: 'crawl',
    fallbackMode: null,
    fallbackReason: null
  });
  telemetry.recordRoute({ url: 'https://example.test/a', routeShape: '/a' });
  telemetry.recordEndpoint({ url: 'https://example.test/api/items', authorization: 'bearer secret' });
  telemetry.recordForm({ id: 'login' });
  telemetry.recordActionDiscovered({ id: 'menu', kind: 'open-menu' });
  telemetry.recordActionAttempt({ changedState: true });
  telemetry.recordActionAttempt({ didNothing: true, noProgress: true });
  telemetry.recordScenarioStep({ id: 'login' });
  telemetry.recordTiming('navigation', 11);
  telemetry.recordTiming('observation', 12);
  telemetry.recordTiming('action', 13);
  telemetry.recordTiming('wait', 14);
  telemetry.recordTiming('blocked', 15);
  telemetry.setFindingsCount(2);
  now = 1100;
  telemetry.finish();

  const summary = telemetry.toSummary();
  assert.equal(summary.runId, 'run-1');
  assert.equal(summary.totalDurationMs, 100);
  assert.equal(summary.routeCount, 1);
  assert.equal(summary.routeShapeCount, 1);
  assert.equal(summary.endpointCount, 1);
  assert.equal(summary.formCount, 1);
  assert.equal(summary.actionCount, 1);
  assert.equal(summary.scenarioStepsCompleted, 1);
  assert.equal(summary.actionsAttempted, 2);
  assert.equal(summary.actionsChangedState, 1);
  assert.equal(summary.actionsDidNothing, 1);
  assert.equal(summary.noProgressActionCount, 1);
  assert.equal(summary.navigationTimeMs, 11);
  assert.equal(summary.observationTimeMs, 12);
  assert.equal(summary.actionTimeMs, 13);
  assert.equal(summary.waitTimeMs, 14);
  assert.equal(summary.blockedTimeMs, 15);
  assert.equal(summary.findingsCount, 2);
  assert.equal(
    telemetry.toEvents().find((event) => event.type === 'endpoint').data.authorization,
    '[REDACTED]'
  );
});

test('writeStandardArtifacts writes dry-run artifact files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-artifacts-'));
  const config = resolveConfig({
    generatedAt: '2026-05-04T00:00:00.000Z',
    overrides: {
      artifacts: {
        outputDir: dir
      }
    }
  });
  const telemetry = createTelemetryRun({
    runId: 'run-artifacts',
    now: () => 1000
  });
  telemetry.finish(1000);

  const files = writeStandardArtifacts(dir, {
    config,
    telemetry,
    coverage: {
      schemaVersion: 'ptk-agent-v2-coverage',
      runHeartbeat: { schemaVersion: 'ptk-agent-v2-run-heartbeat', runStatus: 'completed' },
      browserRuntimeSummary: { schemaVersion: 'ptk-agent-v2-browser-runtime-summary', status: 'completed' }
    },
    events: telemetry.events
  });

  assert.ok(fs.existsSync(files.resolvedConfig));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.timing)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.summary)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.coverage)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.events)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.runHeartbeat)));
  assert.ok(fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.browserRuntimeSummary)));
  assert.equal(readJsonArtifact(files.summary).runId, 'run-artifacts');
});

test('writeStandardArtifacts removes stale known artifacts before writing a new run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-artifacts-stale-'));
  const staleRouteLifecycle = path.join(dir, ARTIFACT_FILENAMES.routeLifecycleEvents);
  fs.writeFileSync(staleRouteLifecycle, '{"type":"old_route"}\n', 'utf8');

  const config = resolveConfig({
    generatedAt: '2026-05-04T00:00:00.000Z',
    overrides: {
      artifacts: {
        outputDir: dir
      }
    }
  });
  const telemetry = createTelemetryRun({
    runId: 'run-artifacts-clean',
    now: () => 1000
  });
  telemetry.finish(1000);

  writeStandardArtifacts(dir, {
    config,
    telemetry,
    coverage: {
      schemaVersion: 'ptk-agent-v2-coverage'
    },
    events: []
  });

  assert.equal(fs.existsSync(staleRouteLifecycle), false);
  assert.equal(readJsonArtifact(path.join(dir, ARTIFACT_FILENAMES.summary)).runId, 'run-artifacts-clean');
});

test('createArtifactWriter redacts secrets in resolved config artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-redact-'));
  const writer = createArtifactWriter(dir);
  const filePath = writer.writeResolvedConfig({
    safe: 'visible',
    apiToken: 'secret'
  });
  const payload = readJsonArtifact(filePath);

  assert.equal(payload.safe, 'visible');
  assert.equal(payload.apiToken, '[REDACTED]');
});

test('createArtifactWriter writes M1 compatibility and engine summary artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-compat-artifacts-'));
  const writer = createArtifactWriter(dir);
  const compatibilityPath = writer.writeCompatibilitySummary({
    wrapper: 'ptk-scan',
    password: 'secret'
  });
  const enginePath = writer.writeEngineSummary({
    requestedEngines: ['DAST'],
    enabled: { dast: true }
  });

  assert.equal(path.basename(compatibilityPath), ARTIFACT_FILENAMES.compatibilitySummary);
  assert.equal(path.basename(enginePath), ARTIFACT_FILENAMES.engineSummary);
  assert.equal(readJsonArtifact(compatibilityPath).password, '[REDACTED]');
  assert.equal(readJsonArtifact(enginePath).enabled.dast, true);
});

test('createArtifactWriter writes M2 browser summary artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-browser-artifacts-'));
  const writer = createArtifactWriter(dir);
  const browserPath = writer.writeBrowserSummary({
    requestedBrowser: 'chromium',
    launchMode: 'normal-chromium-context',
    extensionLoadMode: 'none'
  });

  assert.equal(path.basename(browserPath), ARTIFACT_FILENAMES.browserSummary);
  assert.equal(readJsonArtifact(browserPath).launchMode, 'normal-chromium-context');
});

test('createArtifactWriter writes Phase 0 runtime safety artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-runtime-artifacts-'));
  const writer = createArtifactWriter(dir);
  const heartbeatPath = writer.writeRunHeartbeat({
    schemaVersion: 'ptk-agent-v2-run-heartbeat',
    runStatus: 'running'
  });
  const runtimePath = writer.writeBrowserRuntimeSummary({
    schemaVersion: 'ptk-agent-v2-browser-runtime-summary',
    status: 'running'
  });

  assert.equal(path.basename(heartbeatPath), ARTIFACT_FILENAMES.runHeartbeat);
  assert.equal(path.basename(runtimePath), ARTIFACT_FILENAMES.browserRuntimeSummary);
  assert.equal(readJsonArtifact(heartbeatPath).runStatus, 'running');
  assert.equal(readJsonArtifact(runtimePath).status, 'running');
});

test('createArtifactWriter writes M5 site memory artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-site-memory-artifacts-'));
  const writer = createArtifactWriter(dir);
  const memoryPath = writer.writeSiteMemory({
    schemaVersion: 'ptk-agent-v2-site-memory',
    routes: []
  });

  assert.equal(path.basename(memoryPath), ARTIFACT_FILENAMES.siteMemory);
  assert.equal(readJsonArtifact(memoryPath).schemaVersion, 'ptk-agent-v2-site-memory');
});

test('createArtifactWriter writes M6 code signals artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-code-signals-artifacts-'));
  const writer = createArtifactWriter(dir);
  const signalPath = writer.writeCodeSignals({
    schemaVersion: 'ptk-agent-v2-code-signals',
    skippedScripts: [{ url: 'http://app.test/vendor.js', reason: 'max-scripts' }]
  });

  assert.equal(path.basename(signalPath), ARTIFACT_FILENAMES.codeSignals);
  assert.equal(readJsonArtifact(signalPath).skippedScripts[0].reason, 'max-scripts');
});

test('createArtifactWriter writes M7 analysis evidence artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-analysis-evidence-artifacts-'));
  const writer = createArtifactWriter(dir);
  const analysisPath = writer.writeAnalysisEvidence({
    schemaVersion: 'ptk-agent-v2-analysis-evidence',
    routeHints: [{ url: 'http://app.test/admin', sourceTag: 'sast' }]
  });

  assert.equal(path.basename(analysisPath), ARTIFACT_FILENAMES.analysisEvidence);
  assert.equal(readJsonArtifact(analysisPath).routeHints[0].sourceTag, 'sast');
});

test('logger writes structured redacted JSON lines', () => {
  let output = '';
  const stream = {
    write(chunk) {
      output += chunk;
    }
  };
  const logger = createLogger({
    level: 'debug',
    stream,
    errorStream: stream,
    clock: () => '2026-05-04T00:00:00.000Z'
  });

  assert.equal(logger.info('message', { password: 'secret', safe: 'ok' }), true);
  const entry = JSON.parse(output);
  assert.equal(entry.level, 'info');
  assert.equal(entry.password, '[REDACTED]');
  assert.equal(entry.safe, 'ok');
});
