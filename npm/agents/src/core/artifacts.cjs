'use strict';

const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./config.cjs');

const ARTIFACT_FILENAMES = Object.freeze({
  resolvedConfig: 'resolved-config.json',
  timing: 'timing.json',
  summary: 'crawl-summary.json',
  events: 'crawl-events.jsonl',
  coverage: 'coverage.json',
  scenarioResult: 'scenario-result.json',
  authPreflight: 'auth-preflight.json',
  ptkLifecycle: 'ptk-lifecycle.json',
  ptkLifecycleNormalized: 'ptk-lifecycle-normalized.json',
  ptkDrainSummary: 'ptk-drain-summary.json',
  ptkFindingsCount: 'ptk-findings-count.json',
  browserSummary: 'browser-summary.json',
  compatibilitySummary: 'compatibility-summary.json',
  engineSummary: 'engine-summary.json',
  moduleResolution: 'module-resolution.json',
  siteMemory: 'site-memory.json',
  codeSignals: 'code-signals.json',
  analysisEvidence: 'analysis-evidence.json',
  agentManager: 'agent-manager.json',
  agentSummary: 'agent-summary.json',
  agentTurns: 'agent-turns.jsonl',
  agentActionPlans: 'agent-action-plans.jsonl',
  agentExecutionResults: 'agent-execution-results.jsonl',
  agentCoverageDelta: 'agent-coverage-delta.json',
  providerDecisionQuality: 'provider-decision-quality.json',
  agentBaselinePreservation: 'agent-baseline-preservation.json',
  agentRiskPolicy: 'agent-risk-policy.json',
  agentMissionCompilerSummary: 'agent-mission-compiler-summary.json',
  agentExecutorRecoverySummary: 'agent-executor-recovery-summary.json',
  formRepairSummary: 'form-repair-summary.json',
  businessLogicSummary: 'business-logic-summary.json',
  sarif: 'ptk-results.sarif',
  findingThreshold: 'finding-threshold.json',
  findingFingerprintDiff: 'finding-fingerprint-diff.json',
  findingQualityGate: 'finding-quality-gate.json',
  runHeartbeat: 'run-heartbeat.json',
  browserRuntimeSummary: 'browser-runtime-summary.json',
  rowLifecycleEvents: 'row-lifecycle-events.jsonl',
  routeLifecycleEvents: 'route-lifecycle-events.jsonl',
  routeStatusSummary: 'route-status-summary.json',
  terminalDocumentSummary: 'terminal-document-summary.json',
  formAttemptSummary: 'form-attempt-summary.json',
  browserProbeSummary: 'browser-probe-summary.json',
  surfaceExplorerSummary: 'surface-explorer-summary.json',
  authSurfaceSummary: 'auth-surface-summary.json',
  routeSourceSummary: 'route-source-summary.json',
  stateKeySummary: 'state-key-summary.json',
  comparison: 'run-comparison.json'
});

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function artifactPath(outputDir, name) {
  return path.resolve(outputDir, name);
}

function stableJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function writeJson(outputDir, name, data, options = {}) {
  ensureDir(outputDir);
  const filePath = artifactPath(outputDir, name);
  const payload = options.redact === false ? data : redactSecrets(data);
  fs.writeFileSync(filePath, stableJson(payload), 'utf8');
  return filePath;
}

function appendJsonl(outputDir, name, event, options = {}) {
  ensureDir(outputDir);
  const filePath = artifactPath(outputDir, name);
  const payload = options.redact === false ? event : redactSecrets(event);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  return filePath;
}

function writeJsonl(outputDir, name, events = [], options = {}) {
  ensureDir(outputDir);
  const filePath = artifactPath(outputDir, name);
  const lines = (Array.isArray(events) ? events : [])
    .map((event) => JSON.stringify(options.redact === false ? event : redactSecrets(event)));
  fs.writeFileSync(filePath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return filePath;
}

function readJsonArtifact(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clearStandardArtifacts(outputDir) {
  ensureDir(outputDir);
  for (const name of Object.values(ARTIFACT_FILENAMES)) {
    const filePath = artifactPath(outputDir, name);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
}

function telemetrySummary(telemetry) {
  if (!telemetry) return {};
  if (typeof telemetry.toSummary === 'function') return telemetry.toSummary();
  if (typeof telemetry.snapshot === 'function') return telemetry.snapshot();
  return telemetry;
}

function telemetryTiming(telemetry) {
  if (!telemetry) return {};
  if (typeof telemetry.toTiming === 'function') return telemetry.toTiming();
  const summary = telemetrySummary(telemetry);
  return {
    schemaVersion: summary.schemaVersion || 'ptk-agent-v2-telemetry',
    runId: summary.runId || null,
    startTime: summary.startTime || null,
    endTime: summary.endTime || null,
    totalDurationMs: summary.totalDurationMs || summary.durationMs || 0,
    navigationTimeMs: summary.navigationTimeMs || (summary.timing && summary.timing.navigationMs) || 0,
    observationTimeMs: summary.observationTimeMs || (summary.timing && summary.timing.observationMs) || 0,
    actionTimeMs: summary.actionTimeMs || (summary.timing && summary.timing.actionMs) || 0,
    waitTimeMs: summary.waitTimeMs || (summary.timing && summary.timing.waitMs) || 0,
    blockedTimeMs: summary.blockedTimeMs || (summary.timing && summary.timing.blockedMs) || 0
  };
}

function telemetryEvents(telemetry, events) {
  if (Array.isArray(events)) return events;
  if (telemetry && typeof telemetry.toEvents === 'function') return telemetry.toEvents();
  if (telemetry && Array.isArray(telemetry.events)) return telemetry.events;
  return [];
}

function createEmptyCoverage(summary = {}) {
  return {
    schemaVersion: 'ptk-agent-v2-coverage',
    runId: summary.runId || null,
    routeCount: summary.routeCount || 0,
    routeShapeCount: summary.routeShapeCount || 0,
    endpointCount: summary.endpointCount || 0,
    formCount: summary.formCount || 0,
    actionCount: summary.actionCount || 0,
    routes: Array.isArray(summary.routes) ? summary.routes.slice() : [],
    routeShapes: Array.isArray(summary.routeShapes) ? summary.routeShapes.slice() : [],
    endpoints: Array.isArray(summary.endpoints) ? summary.endpoints.slice() : [],
    forms: [],
    actions: []
  };
}

function writeStandardArtifacts(outputDir, { config, telemetry, coverage = null, events = [] } = {}) {
  clearStandardArtifacts(outputDir);
  const summary = telemetrySummary(telemetry);
  const files = {};
  files.resolvedConfig = writeJson(outputDir, ARTIFACT_FILENAMES.resolvedConfig, config);
  files.timing = writeJson(outputDir, ARTIFACT_FILENAMES.timing, telemetryTiming(telemetry));
  files.summary = writeJson(outputDir, ARTIFACT_FILENAMES.summary, summary);
  files.coverage = writeJson(outputDir, ARTIFACT_FILENAMES.coverage, coverage || createEmptyCoverage(summary));
  if (coverage && coverage.scenario) files.scenarioResult = writeJson(outputDir, ARTIFACT_FILENAMES.scenarioResult, coverage.scenario);
  if (coverage && coverage.authPreflight) files.authPreflight = writeJson(outputDir, ARTIFACT_FILENAMES.authPreflight, coverage.authPreflight);
  if (coverage && coverage.browser) files.browserSummary = writeJson(outputDir, ARTIFACT_FILENAMES.browserSummary, coverage.browser);
  if (coverage && coverage.siteMemory) files.siteMemory = writeJson(outputDir, ARTIFACT_FILENAMES.siteMemory, coverage.siteMemory);
  if (coverage && coverage.codeSignals) files.codeSignals = writeJson(outputDir, ARTIFACT_FILENAMES.codeSignals, coverage.codeSignals);
  if (coverage && coverage.analysisEvidence) files.analysisEvidence = writeJson(outputDir, ARTIFACT_FILENAMES.analysisEvidence, coverage.analysisEvidence);
  if (coverage && coverage.runHeartbeat) files.runHeartbeat = writeJson(outputDir, ARTIFACT_FILENAMES.runHeartbeat, coverage.runHeartbeat);
  if (coverage && coverage.browserRuntimeSummary) files.browserRuntimeSummary = writeJson(outputDir, ARTIFACT_FILENAMES.browserRuntimeSummary, coverage.browserRuntimeSummary);
  if (coverage && coverage.routeLifecycle) files.routeLifecycleEvents = writeJsonl(outputDir, ARTIFACT_FILENAMES.routeLifecycleEvents, coverage.routeLifecycle.events || []);
  if (coverage && coverage.routeStatusSummary) files.routeStatusSummary = writeJson(outputDir, ARTIFACT_FILENAMES.routeStatusSummary, coverage.routeStatusSummary);
  if (coverage && coverage.terminalDocumentSummary) files.terminalDocumentSummary = writeJson(outputDir, ARTIFACT_FILENAMES.terminalDocumentSummary, coverage.terminalDocumentSummary);
  if (coverage && coverage.formAttemptSummary) files.formAttemptSummary = writeJson(outputDir, ARTIFACT_FILENAMES.formAttemptSummary, coverage.formAttemptSummary);
  if (coverage && coverage.browserProbeSummary) files.browserProbeSummary = writeJson(outputDir, ARTIFACT_FILENAMES.browserProbeSummary, coverage.browserProbeSummary);
  if (coverage && coverage.surfaceExplorerSummary) files.surfaceExplorerSummary = writeJson(outputDir, ARTIFACT_FILENAMES.surfaceExplorerSummary, coverage.surfaceExplorerSummary);
  if (coverage && coverage.authSurfaceSummary) files.authSurfaceSummary = writeJson(outputDir, ARTIFACT_FILENAMES.authSurfaceSummary, coverage.authSurfaceSummary);
  if (coverage && coverage.routeSourceSummary) files.routeSourceSummary = writeJson(outputDir, ARTIFACT_FILENAMES.routeSourceSummary, coverage.routeSourceSummary);
  if (coverage && coverage.stateKeySummary) files.stateKeySummary = writeJson(outputDir, ARTIFACT_FILENAMES.stateKeySummary, coverage.stateKeySummary);
  files.events = writeJsonl(outputDir, ARTIFACT_FILENAMES.events, telemetryEvents(telemetry, events));
  return files;
}

function createArtifactWriter(outputDir) {
  ensureDir(outputDir);
  return {
    outputDir,
    writeJson(name, data, options = {}) {
      return writeJson(outputDir, name, data, options);
    },
    writeJsonl(name, rows, options = {}) {
      return writeJsonl(outputDir, name, rows, options);
    },
    writeResolvedConfig(config) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.resolvedConfig, config);
    },
    writeTiming(timing) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.timing, timing);
    },
    writeSummary(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.summary, summary);
    },
    writeCoverage(coverage) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.coverage, coverage);
    },
    writePtkLifecycle(lifecycle) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.ptkLifecycle, lifecycle);
    },
    writePtkLifecycleNormalized(lifecycle) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.ptkLifecycleNormalized, lifecycle);
    },
    writeBrowserSummary(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.browserSummary, summary);
    },
    writeCompatibilitySummary(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.compatibilitySummary, summary);
    },
    writeEngineSummary(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.engineSummary, summary);
    },
    writeModuleResolution(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.moduleResolution, summary);
    },
    writeSiteMemory(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.siteMemory, summary);
    },
    writeCodeSignals(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.codeSignals, summary);
    },
    writeAnalysisEvidence(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.analysisEvidence, summary);
    },
    writeAgentManager(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.agentManager, summary);
    },
    writeRunHeartbeat(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.runHeartbeat, summary);
    },
    writeBrowserRuntimeSummary(summary) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.browserRuntimeSummary, summary);
    },
    writeEvents(rows) {
      return writeJsonl(outputDir, ARTIFACT_FILENAMES.events, rows);
    },
    writeComparison(comparison) {
      return writeJson(outputDir, ARTIFACT_FILENAMES.comparison, comparison);
    }
  };
}

module.exports = {
  ARTIFACT_FILENAMES,
  appendJsonl,
  artifactPath,
  createArtifactWriter,
  createEmptyCoverage,
  clearStandardArtifacts,
  ensureDir,
  readJsonArtifact,
  stableJson,
  writeJson,
  writeJsonl,
  writeStandardArtifacts
};
