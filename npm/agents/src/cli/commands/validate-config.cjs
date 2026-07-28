'use strict';

const fs = require('fs');
const path = require('path');
const { camelizeOptions, parseArgs, requireOption } = require('../args.cjs');
const { loadRuntimeModule } = require('../runtime-loader.cjs');
const { EXIT_INPUT, EXIT_OK, printResult, unimplemented, writeLine } = require('../status.cjs');

const name = 'validate-config';
const summary = 'Validate and resolve a PTK Agent config.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} validate-config --config <path> [options]`,
    '',
    'Options:',
    '  --config <path>               Config file path.',
    '  --url <url>                   Target URL override.',
    '  --output-dir <path>           Artifact output directory override.',
    '  --max-routes <count>          Max routes override.',
    '  --crawl-depth <count>         Max discovery depth override.',
    '  --max-route-ms <ms>           Route navigation budget override.',
    '  --max-action-ms <ms>          Action budget override.',
    '  --max-observation-ms <ms>     Observation budget override.',
    '  --max-actions-per-route <n>   Action count override per route.',
    '  --max-forms-per-route <n>     Safe form submit override per route.',
    '  --max-no-progress-actions <n> No-progress action limit override.',
    '  --wait-strategy <name>        Wait strategy override.',
    '  --route-hints-file <path>     JSON route/API surface hints to seed deterministic crawling.',
    '  --scenario <path>             Scenario file path.',
    '  --scenario-continue-on-failure Continue crawl after scenario setup failure.',
    '  --username <value>            Persona username.',
    '  --username-env <name>         Read persona username from environment.',
    '  --password <value>            Persona password.',
    '  --profile-file <path>         Profile/crawl-data JSON file.',
    '  --crawl-data <path>           Alias for --profile-file.',
    '  --persona <id>                Active persona id.',
    '  --memory-mode <mode>          off, read, or read-write site memory.',
    '  --memory-storage <dir>        Site memory storage directory.',
    '  --memory-reset                Clear selected site memory before run.',
    '  --include-secrets             Allow secrets in runtime execution where explicitly supported.',
    '  --browser <name>              chromium, chrome, edge, or firefox.',
    '  --chrome-binary <path>        Chrome executable path.',
    '  --edge-binary <path>          Edge executable path.',
    '  --firefox-xpi <path>          Firefox XPI path; fails clearly until supported.',
    '  --profile-dir <path>          Browser persistent profile directory.',
    '  --browser-launch-timeout-ms <ms> Browser startup timeout. Default: 30000.',
    '  --headed                      Resolve browser.headless=false.',
    '  --headless                    Resolve browser.headless=true.',
    '  --ptk-extension-dir <dir>     Unpacked PTK extension directory. Auto-detected by default in this repo.',
    '  --allow-missing-ptk           Do not fail validity when PTK bridge/export is missing.',
    '  --require-ptk-bridge          Mark run invalid when PTK bridge is missing.',
    '  --require-ptk-findings-export Mark run invalid when findings/export is unavailable.',
    '  --ptk-drain-mode <mode>       off, brief, until-idle, or until-complete.',
    '  --ptk-drain-timeout-ms <ms>   Explicit PTK drain timeout.',
    '  --wait-for-ptk-complete       Resolve PTK drain mode to until-complete.',
    '  --require-ptk-attack-completion Fail when PTK planned tasks are incomplete or cancelled.',
    '  --agent-mode <mode>           off, mock, manager, provider, or browser.',
    '  --agent-provider <name>       Provider name, e.g. opencode or codex.',
    '  --agent-model <name>          Provider model, e.g. opencode/big-pickle or gpt-5.3-codex-spark.',
    '  --max-agent-turns <n>         Agent turns. Default: 3.',
    '  --max-provider-ms <ms>        Provider choice budget.',
    '  --max-steps-per-turn <n>      Agent tool steps per turn. Default: 1.',
    '  --aggressive                  Allow business-tier agent mutations only.',
    '  --allow-destructive-actions   Allow destructive-tier agent actions.',
    '  --require-agent-success       Fail scan if agent execution fails.',
    '  --json                        Print resolved config as JSON.',
    '  -h, --help                    Show help.',
    ''
  ].join('\n');
}

async function run(argv, context) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ['help', 'json', 'include-secrets', 'scenario-continue-on-failure', 'allow-missing-ptk', 'require-ptk-bridge', 'require-ptk-findings-export', 'wait-for-ptk-complete', 'require-ptk-attack-completion', 'memory-reset', 'headed', 'headless', 'aggressive', 'allow-destructive-actions', 'require-agent-success'],
    strings: [
      'config',
      'url',
      'output-dir',
      'max-routes',
      'crawl-depth',
      'max-route-ms',
      'max-action-ms',
      'max-observation-ms',
      'max-actions-per-route',
      'max-forms-per-route',
      'max-no-progress-actions',
      'wait-strategy',
      'route-hints-file',
      'scenario',
      'username',
      'username-env',
      'password',
      'profile-file',
      'crawl-data',
      'persona',
      'memory-mode',
      'memory-storage',
      'browser',
      'chrome-binary',
      'edge-binary',
      'firefox-xpi',
      'profile-dir',
      'browser-launch-timeout-ms',
      'ptk-extension-dir',
      'ptk-drain-mode',
      'ptk-drain-timeout-ms',
      'agent-mode',
      'agent-provider',
      'agent-model',
      'max-agent-turns',
      'max-provider-ms',
      'max-steps-per-turn',
      'agent-risk-mode'
    ]
  });

  if (options.help) {
    writeLine(context.io.stdout, help(context.cliName));
    return EXIT_OK;
  }

  requireOption(options, 'config', name);

  if (positionals.length > 0) {
    const error = new Error(`validate-config does not accept positional arguments: ${positionals.join(', ')}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  const configPath = path.resolve(context.cwd, options.config);
  if (!fs.existsSync(configPath)) {
    const error = new Error(`Config file not found: ${options.config}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  const configModule = loadRuntimeModule('core/config.cjs');
  if (!configModule.available) {
    return unimplemented(context, name, configModule, [
      'Expected future export: resolveConfig({ configPath, overrides, cwd }) and configOverridesFromCli(cliOptions).',
      `Config path: ${configPath}`
    ]);
  }

  const cliOptions = Object.assign(camelizeOptions(options), {
    config: configPath,
    cwd: context.cwd
  });
  if (options['crawl-depth'] !== undefined) cliOptions.crawlDepth = options['crawl-depth'];
  if (options['username-env'] !== undefined) {
    const envName = options['username-env'];
    const env = context.env || process.env;
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      const error = new Error(`Environment variable ${envName} is not set for --username-env`);
      error.exitCode = EXIT_INPUT;
      throw error;
    }
    cliOptions.username = env[envName];
  }
  if (options.headed && options.headless) {
    const error = new Error('Use either --headed or --headless, not both.');
    error.exitCode = EXIT_INPUT;
    throw error;
  }
  if (options.headed) cliOptions.headless = false;
  if (options.headless) cliOptions.headless = true;
  if (options['browser-launch-timeout-ms'] !== undefined) cliOptions.browserLaunchTimeoutMs = options['browser-launch-timeout-ms'];

  if (typeof configModule.module.resolveConfig !== 'function') {
    const error = new Error('Runtime config module is present but does not export resolveConfig.');
    error.exitCode = 70;
    throw error;
  }

  const overrides = typeof configModule.module.configOverridesFromCli === 'function'
    ? configModule.module.configOverridesFromCli(cliOptions)
    : {};
  const resolved = configModule.module.resolveConfig({
    configPath,
    overrides,
    cwd: context.cwd
  });

  const redactor = typeof configModule.module.redactSecrets === 'function'
    ? configModule.module.redactSecrets
    : value => value;
  printResult(context, options['include-secrets'] ? resolved : redactor(resolved));
  return EXIT_OK;
}

module.exports = {
  help,
  name,
  run,
  summary
};
