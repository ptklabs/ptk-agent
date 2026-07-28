#!/usr/bin/env node
'use strict';

const packageJson = require('../../package.json');
const crawl = require('./commands/crawl.cjs');
const scan = require('./commands/scan.cjs');
const compare = require('./commands/compare.cjs');
const validateConfig = require('./commands/validate-config.cjs');
const modules = require('./commands/modules.cjs');
const benchmark = require('./commands/benchmark.cjs');
const { UsageError } = require('./args.cjs');
const { EXIT_SOFTWARE, writeLine } = require('./status.cjs');
const { resolvePtkExtensionPath } = require('../browser/extensionResolver.cjs');

const commands = {
  crawl,
  scan,
  compare,
  'validate-config': validateConfig,
  modules,
  benchmark
};

function globalHelp(cliName) {
  return [
    'PTK Agents SDK',
    '',
    'Usage:',
    `  ${cliName} <command> [options]`,
    '',
    'Commands:',
    '  crawl             Run deterministic crawl, dry-run, or open-only flow.',
    '  scan              Run a configured PTK Agent scan.',
    '  compare           Compare baseline and candidate artifacts.',
    '  validate-config   Validate and resolve a PTK Agent config.',
    '  modules           Inspect or resolve module packs.',
    '  benchmark         Run scanner benchmark matrix.',
    '',
    'Global options:',
    '  -h, --help        Show help.',
    '  --version         Show package version.',
    '  --doctor-extension  Print bundled/resolved PTK extension diagnostics as JSON.',
    '',
    `Run "${cliName} <command> --help" for command options.`
  ].join('\n');
}

async function main(argv, io) {
  const args = argv || process.argv.slice(2);
  const streams = io || { stdout: process.stdout, stderr: process.stderr };
  const cliName = 'ptk-agent';
  const context = {
    cliName,
    cwd: process.cwd(),
    io: streams
  };

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    writeLine(streams.stdout, globalHelp(cliName));
    return 0;
  }

  if (args[0] === '--version') {
    writeLine(streams.stdout, packageJson.version);
    return 0;
  }

  if (args[0] === '--doctor-extension') {
    writeLine(streams.stdout, JSON.stringify(resolvePtkExtensionPath({
      cwd: context.cwd
    }), null, 2));
    return 0;
  }

  const commandName = args[0];
  const command = commands[commandName];
  if (!command) {
    throw new UsageError(`Unknown command "${commandName}"`);
  }

  return command.run(args.slice(1), context);
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const label = error instanceof UsageError ? 'Usage error' : 'Command failed';
      writeLine(process.stderr, `${label}: ${error.message}`);

      if (error instanceof UsageError) {
        writeLine(process.stderr, 'Run "ptk-agent --help" or "ptk-agent <command> --help".');
      } else if (process.env.PTK_AGENT_DEBUG) {
        writeLine(process.stderr, error.stack || String(error));
      }

      process.exitCode = error.exitCode || EXIT_SOFTWARE;
    });
}

module.exports = {
  commands,
  globalHelp,
  main
};
