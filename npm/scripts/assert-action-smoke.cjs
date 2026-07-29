#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Missing required file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertActionSmoke(outputDirectoryValue, sarifFileValue) {
  const outputDirectory = path.resolve(outputDirectoryValue);
  const sarifFile = path.resolve(sarifFileValue);
  const engineSummary = readJson(path.join(outputDirectory, 'engine-summary.json'));
  const lifecycle = readJson(path.join(outputDirectory, 'ptk-lifecycle-normalized.json'));
  const expected = ['DAST', 'IAST', 'SAST', 'SCA'].sort();
  const actual = [...(engineSummary.requestedEngines || [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected requested engines: ${actual.join(',')}`);
  for (const engine of ['dast', 'iast', 'sast', 'sca']) {
    if (!engineSummary.enabled || engineSummary.enabled[engine] !== true) throw new Error(`${engine.toUpperCase()} was not enabled`);
  }
  if (!engineSummary.ptkLifecycle || engineSummary.ptkLifecycle.engineSelectionAppliedToPtk !== true) {
    throw new Error('PTK did not apply the requested engines');
  }
  if (!lifecycle.bridgeDetected || !lifecycle.scanStarted || !lifecycle.scanStopped) {
    throw new Error('PTK lifecycle did not complete through the browser bridge');
  }
  if (!lifecycle.exportSucceeded || !lifecycle.safeToStop) throw new Error('PTK findings export did not drain safely');
  const sarif = readJson(sarifFile);
  if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs)) throw new Error('SARIF output is invalid');
  return { requestedEngines: actual, sarifRuns: sarif.runs.length };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('Usage: node assert-action-smoke.cjs <artifact-directory> <sarif-file>\n');
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(assertActionSmoke(argv[0], argv[1]), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { assertActionSmoke, readJson };

