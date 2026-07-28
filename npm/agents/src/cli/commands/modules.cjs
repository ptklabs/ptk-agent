'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, UsageError } = require('../args.cjs');
const { loadRuntimeModule } = require('../runtime-loader.cjs');
const { EXIT_INPUT, EXIT_OK, printResult, unimplemented, writeLine } = require('../status.cjs');

const name = 'modules';
const summary = 'Inspect or resolve module packs.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} modules [subcommand] [options]`,
    '',
    'Subcommands:',
    '  list       List resolved module definitions.',
    '  resolve    Resolve module packs from engine config.',
    '',
    'Options:',
    '  --config <path>    Optional engine config JSON path.',
    '  --registry <url>   Reserved for later portal-backed resolution.',
    '  -h, --help         Show help.',
    '',
    'Phase behavior:',
    '  Help works without browser dependencies. Runtime resolution uses src/modules/moduleResolver.cjs when present.'
  ].join('\n');
}

function readOptionalConfig(context, configPath) {
  if (!configPath) {
    return {};
  }

  const absolutePath = path.resolve(context.cwd, configPath);
  if (!fs.existsSync(absolutePath)) {
    const error = new Error(`Engine config file not found: ${configPath}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    error.message = `Invalid JSON in ${configPath}: ${error.message}`;
    error.exitCode = EXIT_INPUT;
    throw error;
  }
}

async function run(argv, context) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ['help'],
    strings: ['config', 'registry']
  });

  if (options.help) {
    writeLine(context.io.stdout, help(context.cliName));
    return EXIT_OK;
  }

  const subcommand = positionals[0] || 'list';
  if (!['list', 'resolve'].includes(subcommand)) {
    throw new UsageError(`Unknown modules subcommand "${subcommand}"`);
  }

  if (positionals.length > 1) {
    throw new UsageError(`modules ${subcommand} does not accept extra positional arguments: ${positionals.slice(1).join(', ')}`);
  }

  const moduleResolver = loadRuntimeModule('modules/moduleResolver.cjs');
  if (!moduleResolver.available) {
    return unimplemented(context, name, moduleResolver, [
      'Expected future export: resolveModules(config, options).',
      `Subcommand: ${subcommand}`
    ]);
  }

  if (typeof moduleResolver.module.resolveModules !== 'function') {
    const error = new Error('Runtime module resolver is present but does not export resolveModules.');
    error.exitCode = 70;
    throw error;
  }

  const engineConfig = readOptionalConfig(context, options.config);
  const result = moduleResolver.module.resolveModules(engineConfig, {
    registry: options.registry || null,
    cwd: context.cwd
  });
  printResult(context, result);
  return EXIT_OK;
}

module.exports = {
  help,
  name,
  run,
  summary
};
