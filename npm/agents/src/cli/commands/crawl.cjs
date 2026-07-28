'use strict';

const { camelizeOptions, parseArgs, UsageError } = require('../args.cjs');
const { invokeRuntime, loadRuntimeModule } = require('../runtime-loader.cjs');
const { EXIT_OK, EXIT_SOFTWARE, printRunResult, unimplemented, writeLine } = require('../status.cjs');

const name = 'crawl';
const summary = 'Run deterministic crawl, dry-run, or open-only flow.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} crawl --url <url> [options]`,
    `  ${cliName} crawl --config <path> [options]`,
    '',
    'Options:',
    '  --url <url>                   Target URL override.',
    '  --config <path>               Optional config file path.',
    '  --output-dir <path>           Artifact output directory override.',
    '  --max-routes <count>          Max routes override.',
    '  --crawl-depth <count>         Max discovery depth. Default is 5.',
    '  --max-route-ms <ms>           Route navigation budget override.',
    '  --max-action-ms <ms>          Action budget override.',
    '  --max-observation-ms <ms>     Observation budget override.',
    '  --max-actions-per-route <n>   Action count override per route.',
    '  --max-forms-per-route <n>     Safe form submit override per route.',
    '  --max-no-progress-actions <n> No-progress action limit override.',
    '  --wait-strategy <name>        Wait strategy override.',
    '  --route-hints-file <path>     JSON route/API surface hints to seed deterministic crawling.',
    '  --scenario <path>             Scenario file path; markdown is compiled to executable steps.',
    '  --scenario-continue-on-failure Continue crawl after scenario setup failure.',
    '  --username <value>            Persona username for scenario/form/auth steps.',
    '  --username-env <name>         Read persona username from environment.',
    '  --password <value>            Persona password for scenario/form/auth steps.',
    '  --password-env <name>         Read persona password from environment.',
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
    '  --headed                      Run browser headed.',
    '  --headless                    Run browser headless.',
    '  --ptk-extension-dir <dir>     Unpacked PTK extension directory. Auto-detected by default in this repo.',
    '  --allow-missing-ptk           Do not fail validity when PTK bridge/export is missing.',
    '  --require-ptk-bridge          Mark run invalid when PTK bridge is missing.',
    '  --require-ptk-findings-export Mark run invalid when findings/export is unavailable.',
    '  --ptk-drain-mode <mode>       off, brief, until-idle, or until-complete.',
    '  --ptk-drain-timeout-ms <ms>   Explicit PTK drain timeout.',
    '  --wait-for-ptk-complete       Alias for --ptk-drain-mode until-complete with a bounded default timeout.',
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
    '  --dry-run                     Resolve config and write dry-run artifacts.',
    '  --open-only                   Open target page without crawling.',
    '  --quiet                       Reduce runtime logging.',
    '  --verbose                     Print full JSON result instead of concise CLI summary.',
    '  -h, --help                    Show help.',
    ''
  ].join('\n');
}

async function run(argv, context) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ['help', 'dry-run', 'open-only', 'quiet', 'verbose', 'include-secrets', 'scenario-continue-on-failure', 'allow-missing-ptk', 'require-ptk-bridge', 'require-ptk-findings-export', 'wait-for-ptk-complete', 'require-ptk-attack-completion', 'memory-reset', 'headed', 'headless', 'aggressive', 'allow-destructive-actions', 'require-agent-success'],
    strings: [
      'url',
      'config',
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
      'password-env',
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

  if (positionals.length > 0) {
    throw new UsageError(`crawl does not accept positional arguments: ${positionals.join(', ')}`);
  }

  if (!options.url && !options.config) {
    throw new UsageError('crawl requires --url or --config');
  }

  const runner = loadRuntimeModule('core/runner.cjs');
  if (!runner.available) {
    return unimplemented(context, name, runner, [
      'Expected future export: runCrawler(cliOptions), runCrawl(payload), crawl(payload), or run(payload).',
      `Requested URL: ${options.url || '(from config)'}`,
      `Dry run requested: ${Boolean(options['dry-run'])}`,
      `Open only requested: ${Boolean(options['open-only'])}`
    ]);
  }

  const runtimeOptions = camelizeOptions(options);
  delete runtimeOptions.verbose;
  const cliOptions = Object.assign(runtimeOptions, {
    cwd: context.cwd,
    throwOnError: false
  });
  if (options['crawl-depth'] !== undefined) cliOptions.crawlDepth = options['crawl-depth'];
  if (options['username-env'] !== undefined) {
    const envName = options['username-env'];
    const env = context.env || process.env;
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      throw new UsageError(`Environment variable ${envName} is not set for --username-env`);
    }
    cliOptions.username = env[envName];
  }
  if (options['password-env'] !== undefined) {
    const envName = options['password-env'];
    const env = context.env || process.env;
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      throw new UsageError(`Environment variable ${envName} is not set for --password-env`);
    }
    cliOptions.password = env[envName];
  }
  if (options.headed && options.headless) throw new UsageError('Use either --headed or --headless, not both.');
  if (options.headed) cliOptions.headless = false;
  if (options.headless) cliOptions.headless = true;
  if (options['browser-launch-timeout-ms'] !== undefined) cliOptions.browserLaunchTimeoutMs = options['browser-launch-timeout-ms'];
  const result = await invokeRuntime(runner.module, ['runCrawler', 'runCrawl', 'crawl', 'run'], cliOptions);
  printRunResult(context, result, {
    verbose: Boolean(options.verbose)
  });
  return result && result.ok === false ? EXIT_SOFTWARE : EXIT_OK;
}

module.exports = {
  help,
  name,
  run,
  summary
};
