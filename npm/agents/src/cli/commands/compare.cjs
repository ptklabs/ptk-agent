'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, requireOption } = require('../args.cjs');
const { invokeRuntime, loadRuntimeModule } = require('../runtime-loader.cjs');
const { EXIT_INPUT, EXIT_OK, printResult, unimplemented, writeLine } = require('../status.cjs');

const name = 'compare';
const summary = 'Compare baseline and candidate artifacts.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} compare --baseline-artifact <path> --candidate-artifact <path> [options]`,
    '',
    'Options:',
    '  --baseline-artifact <path>   Baseline artifact JSON path.',
    '  --candidate-artifact <path>  Candidate artifact JSON path.',
    '  --format <json|text>         Output format. Default: json.',
    '  -h, --help                   Show help.'
  ].join('\n');
}

function assertFileExists(context, filePath, label) {
  const absolutePath = path.resolve(context.cwd, filePath);
  if (!fs.existsSync(absolutePath)) {
    const error = new Error(`${label} not found: ${filePath}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }
  return absolutePath;
}

async function run(argv, context) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ['help'],
    strings: ['baseline-artifact', 'candidate-artifact', 'format']
  });

  if (options.help) {
    writeLine(context.io.stdout, help(context.cliName));
    return EXIT_OK;
  }

  const baselineOption = options['baseline-artifact'];
  const candidateOption = options['candidate-artifact'];
  if (!baselineOption) requireOption(options, 'baseline-artifact', name);
  if (!candidateOption) requireOption(options, 'candidate-artifact', name);

  if (positionals.length > 0) {
    const error = new Error(`compare does not accept positional arguments: ${positionals.join(', ')}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  const baselineArtifact = assertFileExists(context, baselineOption, 'Baseline artifact');
  const candidateArtifact = assertFileExists(context, candidateOption, 'Candidate artifact');
  const comparison = loadRuntimeModule('core/comparison.cjs');

  if (!comparison.available) {
    return unimplemented(context, name, comparison, [
      'Expected future export: compareArtifacts(payload), compare(payload), or run(payload).',
      `Baseline artifact: ${baselineArtifact}`,
      `Candidate artifact: ${candidateArtifact}`
    ]);
  }

  const result = await invokeRuntime(comparison.module, ['compareArtifacts', 'compare', 'run'], {
    baselineArtifact,
    candidateArtifact,
    format: options.format || 'json',
    cwd: context.cwd
  });
  if (options.format === 'text' && typeof comparison.module.formatComparison === 'function') {
    writeLine(context.io.stdout, comparison.module.formatComparison(result));
    return EXIT_OK;
  }
  printResult(context, result);
  return EXIT_OK;
}

module.exports = {
  help,
  name,
  run,
  summary
};
