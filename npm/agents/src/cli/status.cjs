'use strict';

const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_INPUT = 66;
const EXIT_SOFTWARE = 70;
const EXIT_UNIMPLEMENTED = 78;

let redactSecrets = value => value;
try {
  ({ redactSecrets } = require('../core/config.cjs'));
} catch (_) {
  redactSecrets = value => value;
}

function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

function printExecutionPlanNotices(context, plan) {
  const { executionNoticeLines } = require('../core/executionPlan.cjs');
  for (const line of executionNoticeLines(plan)) {
    writeLine(context.io.stderr, line);
  }
}

function printBlock(stream, lines) {
  for (const line of lines) {
    writeLine(stream, line);
  }
}

function unimplemented(context, commandName, missingModule, details) {
  const lines = [
    `ptk-agent ${commandName}: runtime module is unavailable.`,
    `Missing runtime module: ${missingModule.relativePath}`,
    'This is a packaging/runtime loading issue, not a failed crawl or scan.'
  ];

  if (details && details.length > 0) {
    lines.push('');
    lines.push(...details);
  }

  printBlock(context.io.stderr, lines);
  return EXIT_UNIMPLEMENTED;
}

function printResult(context, result) {
  if (result === undefined) {
    return;
  }

  if (typeof result === 'string') {
    writeLine(context.io.stdout, result);
    return;
  }

  writeLine(context.io.stdout, JSON.stringify(redactSecrets(result), null, 2));
}

function printRunResult(context, result, options = {}) {
  if (options.verbose || options.json) {
    printResult(context, result);
    return;
  }

  const safe = redactSecrets(result || {});
  if (safe && safe.ok === false) {
    printRunFailure(context, safe);
    return;
  }

  printRunSuccess(context, safe);
}

function printRunFailure(context, result) {
  const error = result.error || {};
  const status = result.status || 'failed';
  const stream = context.io.stderr;
  writeLine(stream, `PTK scan failed (${status}).`);

  const scenario = scenarioFailure(result);
  const ptk = ptkFailure(result);
  const reason = firstLine(error.summary || error.message || scenario.reason || ptk.reason || result.fallbackReason || 'Unknown error');
  if (reason) writeLine(stream, `Reason: ${reason}`);
  if (scenario.step) writeLine(stream, `Scenario step: ${scenario.step}`);
  if (ptk.status && ptk.status !== status) writeLine(stream, `PTK status: ${ptk.status}`);

  if (error.category) writeLine(stream, `Category: ${error.category}`);
  if (error.hint) writeLine(stream, `Fix: ${oneLine(error.hint)}`);
  else if (error.command) writeLine(stream, `Fix: ${error.command}`);
  if (error.command && (!error.hint || !error.hint.includes(error.command))) {
    writeLine(stream, `Command: ${error.command}`);
  }

  const artifactDir = artifactOutputDir(result);
  if (artifactDir) writeLine(stream, `Artifacts: ${artifactDir}`);
  writeLine(stream, 'Use --verbose for full JSON output.');
}

function printRunSuccess(context, result) {
  const status = result.status || 'completed';
  const counters = result.telemetry && result.telemetry.counters || {};
  const coverage = result.coverage || {};
  const routeCount = numberOrFallback(result.telemetry && result.telemetry.routeCount, counters.routesVisited, arrayLength(coverage.routes));
  const endpointCount = numberOrFallback(result.telemetry && result.telemetry.endpointCount, counters.endpointsObserved, arrayLength(coverage.endpoints));
  const formCount = numberOrFallback(result.telemetry && result.telemetry.formCount, counters.formsDiscovered, arrayLength(coverage.forms));
  const findingCount = numberOrFallback(result.telemetry && result.telemetry.findingsCount, counters.findings, findingsCount(result));
  const errorCount = numberOrFallback(result.telemetry && result.telemetry.errorCount, counters.errors, 0);
  const stream = context.io.stdout;

  writeLine(stream, `PTK scan ${status}.`);
  writeLine(stream, `Routes: ${routeCount} | Endpoints: ${endpointCount} | Forms: ${formCount} | Findings: ${findingCount} | Errors: ${errorCount}`);

  const artifactDir = artifactOutputDir(result);
  if (artifactDir) writeLine(stream, `Artifacts: ${artifactDir}`);
  writeLine(stream, 'Use --verbose for full JSON output.');
}

function artifactOutputDir(result = {}) {
  return result.config && result.config.artifacts && result.config.artifacts.outputDir
    || result.artifacts && firstArtifactDir(result.artifacts)
    || null;
}

function firstArtifactDir(artifacts = {}) {
  for (const value of Object.values(artifacts)) {
    if (typeof value === 'string' && value.trim()) {
      const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
      return index > 0 ? value.slice(0, index) : null;
    }
  }
  return null;
}

function findingsCount(result = {}) {
  const ptk = result.coverage && result.coverage.ptk || {};
  return ptk.findings && (ptk.findings.count || ptk.findings.findingsCount)
    || ptk.evidence && Array.isArray(ptk.evidence.findings) && ptk.evidence.findings.length
    || 0;
}

function scenarioFailure(result = {}) {
  const scenario = result.coverage && result.coverage.scenario
    || result.result && result.result.coverage && result.result.coverage.scenario
    || result.result && result.result.scenario
    || result.scenario
    || null;
  if (!scenario || scenario.ok !== false && scenario.status !== 'failed') return {};
  const failed = scenario.failedStepResult || {};
  const blocked = Array.isArray(scenario.blockedSteps) ? scenario.blockedSteps[0] || {} : {};
  return {
    step: scenario.failedStep || scenario.failedStepId || failed.stepId || blocked.stepId || null,
    reason: scenario.failureReason
      || failed.error
      || failed.reason
      || failed.authFailure && failed.authFailure.classification
      || blocked.reason
      || null
  };
}

function ptkFailure(result = {}) {
  const ptk = result.coverage && result.coverage.ptk
    || result.result && result.result.coverage && result.result.coverage.ptk
    || null;
  const lifecycle = ptk && ptk.lifecycle
    || result.coverage && result.coverage.ptkLifecycle
    || null;
  const validity = ptk && ptk.validity || lifecycle && lifecycle.validity || null;
  return {
    status: validity && validity.status || lifecycle && lifecycle.status || null,
    reason: validity && validity.reason
      || lifecycle && lifecycle.exportFailureReason
      || lifecycle && lifecycle.reason
      || ptk && ptk.reason
      || null
  };
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrFallback(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0].trim();
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  EXIT_INPUT,
  EXIT_OK,
  EXIT_SOFTWARE,
  EXIT_UNIMPLEMENTED,
  EXIT_USAGE,
  printBlock,
  printExecutionPlanNotices,
  printRunResult,
  printResult,
  unimplemented,
  writeLine
};
