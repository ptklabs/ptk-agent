'use strict';

const fs = require('fs');
const { writeJson } = require('./artifacts.cjs');
const { normalizeTelemetrySummary } = require('./telemetry.cjs');

const COMPARISON_SCHEMA_VERSION = 'ptk-agent-v2-comparison';
const METRIC_FIELDS = Object.freeze([
  'totalDurationMs',
  'routeCount',
  'routeShapeCount',
  'endpointCount',
  'formCount',
  'actionCount',
  'findingsCount',
  'waitTimeMs',
  'noProgressActionCount',
  'errorCount'
]);

function readArtifact(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadArtifact(input) {
  return typeof input === 'string' ? readArtifact(input) : input;
}

function metricNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRunMetrics(artifact = {}) {
  const loaded = loadArtifact(artifact) || {};
  const summary = loaded.summary || loaded.crawlSummary || loaded;
  const normalized = normalizeTelemetrySummary(summary);
  return {
    totalDurationMs: metricNumber(normalized.totalDurationMs),
    routeCount: metricNumber(normalized.routeCount),
    routeShapeCount: metricNumber(normalized.routeShapeCount),
    endpointCount: metricNumber(normalized.endpointCount),
    formCount: metricNumber(normalized.formCount),
    actionCount: metricNumber(normalized.actionCount),
    findingsCount: summary.findingsCount === null ? null : metricNumber(normalized.findingsCount),
    waitTimeMs: metricNumber(normalized.waitTimeMs),
    noProgressActionCount: metricNumber(normalized.noProgressActionCount),
    errorCount: metricNumber(normalized.errorCount)
  };
}

function compareMetric(field, baselineValue, candidateValue) {
  if (baselineValue === null && candidateValue === null) {
    return { field, baseline: null, candidate: null, delta: null, ratio: null };
  }
  const baseline = baselineValue === null ? 0 : baselineValue;
  const candidate = candidateValue === null ? 0 : candidateValue;
  return {
    field,
    baseline: baselineValue,
    candidate: candidateValue,
    delta: candidate - baseline,
    ratio: baseline === 0 ? null : candidate / baseline
  };
}

function defaultRegressionRules() {
  return {
    coverageDropTolerance: 0,
    routeShapeDropTolerance: 0,
    endpointDropTolerance: 0,
    findingDropTolerance: 0,
    maxDurationRatio: 1.5,
    maxWaitTimeIncreaseMs: 0,
    maxNoProgressIncrease: 0
  };
}

function detectRegressions(metrics, rules = {}) {
  const merged = { ...defaultRegressionRules(), ...rules };
  const regressions = [];
  function addIf(condition, field, message) {
    if (condition) regressions.push({ field, message });
  }

  addIf(metrics.routeCount.delta < -merged.coverageDropTolerance, 'routeCount', `candidate visited ${Math.abs(metrics.routeCount.delta)} fewer routes than baseline`);
  addIf(metrics.routeShapeCount.delta < -merged.routeShapeDropTolerance, 'routeShapeCount', `candidate observed ${Math.abs(metrics.routeShapeCount.delta)} fewer route shapes than baseline`);
  addIf(metrics.endpointCount.delta < -merged.endpointDropTolerance, 'endpointCount', `candidate observed ${Math.abs(metrics.endpointCount.delta)} fewer endpoints than baseline`);
  if (metrics.findingsCount.baseline !== null && metrics.findingsCount.candidate !== null) {
    addIf(metrics.findingsCount.delta < -merged.findingDropTolerance, 'findingsCount', `candidate reported ${Math.abs(metrics.findingsCount.delta)} fewer findings than baseline`);
  }
  if (metrics.totalDurationMs.ratio !== null) {
    addIf(metrics.totalDurationMs.ratio > merged.maxDurationRatio, 'totalDurationMs', `candidate duration ratio ${metrics.totalDurationMs.ratio.toFixed(2)} exceeded ${merged.maxDurationRatio}`);
  }
  addIf(metrics.waitTimeMs.delta > merged.maxWaitTimeIncreaseMs, 'waitTimeMs', `candidate waited ${metrics.waitTimeMs.delta}ms longer than baseline`);
  addIf(metrics.noProgressActionCount.delta > merged.maxNoProgressIncrease, 'noProgressActionCount', `candidate had ${metrics.noProgressActionCount.delta} more no-progress actions than baseline`);
  return regressions;
}

function compareRunArtifacts(baselineArtifact, candidateArtifact, options = {}) {
  const baseline = normalizeRunMetrics(baselineArtifact);
  const candidate = normalizeRunMetrics(candidateArtifact);
  const metrics = {};
  for (const field of METRIC_FIELDS) {
    metrics[field] = compareMetric(field, baseline[field], candidate[field]);
  }
  const regressions = detectRegressions(metrics, options.regressionRules);
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    baseline,
    candidate,
    metrics,
    regressions,
    passed: regressions.length === 0
  };
}

function compareArtifacts({ baselineArtifact, candidateArtifact, regressionRules = null }) {
  return compareRunArtifacts(baselineArtifact, candidateArtifact, { regressionRules });
}

function formatComparison(comparison) {
  const lines = [`PTK Agents SDK comparison: ${comparison.passed ? 'passed' : 'regressions detected'}`];
  for (const field of METRIC_FIELDS) {
    const metric = comparison.metrics[field];
    lines.push(`${field}: baseline=${metric.baseline ?? 'n/a'} candidate=${metric.candidate ?? 'n/a'} delta=${metric.delta ?? 'n/a'}`);
  }
  if (comparison.regressions.length) {
    lines.push('Regressions:');
    for (const regression of comparison.regressions) {
      lines.push(`- ${regression.field}: ${regression.message}`);
    }
  }
  return lines.join('\n');
}

function writeComparison(outputDir, comparison) {
  return writeJson(outputDir, 'run-comparison.json', comparison);
}

module.exports = {
  COMPARISON_SCHEMA_VERSION,
  METRIC_FIELDS,
  compareArtifacts,
  compareMetric,
  compareRunArtifacts,
  defaultRegressionRules,
  detectRegressions,
  formatComparison,
  normalizeRunMetrics,
  readArtifact,
  writeComparison
};
