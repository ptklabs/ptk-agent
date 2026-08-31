'use strict';

const fs = require('fs');
const path = require('path');
const { camelizeOptions, parseArgs, requireOption, UsageError } = require('../args.cjs');
const { invokeRuntime, loadRuntimeModule } = require('../runtime-loader.cjs');
const { EXIT_INPUT, EXIT_OK, EXIT_SOFTWARE, printExecutionPlanNotices, printRunResult, unimplemented, writeLine } = require('../status.cjs');

const name = 'scan';
const summary = 'Run a configured PTK Agent scan.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} scan --config <path> [options]`,
    '',
    'Options:',
    '  --config <path>      Config file path.',
    '  --output-dir <path>  Artifact output directory override.',
    '  --url <url>          Target URL override.',
    '  --scenario <path>    Scenario file path.',
    '  --macro-file <path>  Replay only this PTK Flow, XML, Zest, Selenium IDE, or Chrome Recorder journey while scans run.',
    '  --macro-format <id>  Macro format override; default is automatic detection.',
    '  --scenario-continue-on-failure Continue crawl after scenario setup failure.',
    '  --crawl-depth <count> Max discovery depth. Default is 5.',
    '  --route-hints-file <path> JSON route/API surface hints to seed deterministic crawling.',
    '  --username <value>   Persona username.',
    '  --username-env <name> Read persona username from environment.',
    '  --password <value>   Persona password.',
    '  --password-env <name> Read persona password from environment.',
    '  --profile-file <path> Profile/crawl-data JSON file.',
    '  --crawl-data <path>  Alias for --profile-file.',
    '  --persona <id>       Active persona id.',
    '  --memory-mode <mode> off, read, or read-write site memory.',
    '  --memory-storage <dir> Site memory storage directory.',
    '  --memory-reset       Clear selected site memory before run.',
    '  --include-secrets    Allow secrets in runtime execution where explicitly supported.',
    '  --browser <name>     chromium, chrome, edge, or firefox.',
    '  --chrome-binary <path> Chrome executable path.',
    '  --edge-binary <path> Edge executable path.',
    '  --firefox-xpi <path> Firefox XPI path; fails clearly until supported.',
    '  --profile-dir <path> Browser persistent profile directory.',
    '  --browser-launch-timeout-ms <ms> Browser startup timeout. Default: 30000.',
    '  --headed             Run browser headed.',
    '  --headless           Run browser headless.',
    '  --ptk-extension-dir <dir> Unpacked PTK extension directory. Auto-detected by default in this repo.',
    '  --allow-missing-ptk  Do not fail validity when PTK bridge/export is missing.',
    '  --require-ptk-bridge Mark run invalid when PTK bridge is missing.',
    '  --require-ptk-findings-export Mark run invalid when findings/export is unavailable.',
    '  --ptk-drain-mode <mode> off, brief, until-idle, or until-complete.',
    '  --ptk-drain-timeout-ms <ms> Explicit PTK drain timeout.',
    '  --wait-for-ptk-complete Alias for --ptk-drain-mode until-complete with a bounded default timeout.',
    '  --require-ptk-attack-completion Fail when PTK planned tasks are incomplete or cancelled.',
    '  --agent-mode <mode>  off, mock, manager, provider, or browser.',
    '  --agent-provider <name> Provider name, e.g. opencode or codex.',
    '  --agent-model <name> Provider model, e.g. opencode/big-pickle or gpt-5.3-codex-spark.',
    '  --max-agent-turns <n> Agent turns. Default: 3.',
    '  --max-provider-ms <ms> Provider choice budget.',
    '  --max-steps-per-turn <n> Agent tool steps per turn. Default: 1.',
    '  --aggressive         Allow business-tier agent mutations only.',
    '  --allow-destructive-actions Allow destructive-tier agent actions.',
    '  --require-agent-success Fail scan if agent execution fails.',
    '',
    'Journey order:',
    '  scenario -> crawler; scenario + Agent -> crawler baseline -> Agent expansion.',
    '  macro -> macro only; conflicting scenario/Agent inputs are skipped with a pre-browser notice.',
    '  --dry-run            Resolve config and write dry-run artifacts.',
    '  --quiet              Reduce runtime logging.',
    '  --verbose            Print full JSON result instead of concise CLI summary.',
    '  -h, --help           Show help.',
    ''
  ].join('\n');
}

async function run(argv, context) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ['help', 'dry-run', 'quiet', 'verbose', 'include-secrets', 'scenario-continue-on-failure', 'allow-missing-ptk', 'require-ptk-bridge', 'require-ptk-findings-export', 'wait-for-ptk-complete', 'require-ptk-attack-completion', 'memory-reset', 'headed', 'headless', 'aggressive', 'allow-destructive-actions', 'require-agent-success'],
    strings: ['config', 'output-dir', 'url', 'scenario', 'macro-file', 'macro-format', 'crawl-depth', 'route-hints-file', 'username', 'username-env', 'password', 'password-env', 'profile-file', 'crawl-data', 'persona', 'memory-mode', 'memory-storage', 'browser', 'chrome-binary', 'edge-binary', 'firefox-xpi', 'profile-dir', 'browser-launch-timeout-ms', 'ptk-extension-dir', 'ptk-drain-mode', 'ptk-drain-timeout-ms', 'agent-mode', 'agent-provider', 'agent-model', 'max-agent-turns', 'max-provider-ms', 'max-steps-per-turn', 'agent-risk-mode']
  });

  if (options.help) {
    writeLine(context.io.stdout, help(context.cliName));
    return EXIT_OK;
  }

  requireOption(options, 'config', name);

  if (positionals.length > 0) {
    const error = new Error(`scan does not accept positional arguments: ${positionals.join(', ')}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  if (options['macro-format'] && !options['macro-file']) {
    throw new UsageError('--macro-format requires --macro-file.');
  }

  const configPath = path.resolve(context.cwd, options.config);
  if (!fs.existsSync(configPath)) {
    const error = new Error(`Config file not found: ${options.config}`);
    error.exitCode = EXIT_INPUT;
    throw error;
  }

  const runner = loadRuntimeModule('core/runner.cjs');
  if (!runner.available) {
    return unimplemented(context, name, runner, [
      'Expected future export: runCrawler(cliOptions), runScan(payload), scan(payload), or run(payload).',
      `Config path: ${configPath}`,
      `Dry run requested: ${Boolean(options['dry-run'])}`
    ]);
  }

  const runtimeOptions = camelizeOptions(options);
  delete runtimeOptions.verbose;
  const cliOptions = Object.assign(runtimeOptions, {
    config: configPath,
    cwd: context.cwd,
    throwOnError: false,
    onExecutionPlan: plan => printExecutionPlanNotices(context, plan)
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
  if (options.headed && options.headless) throw new Error('Use either --headed or --headless, not both.');
  if (options.headed) cliOptions.headless = false;
  if (options.headless) cliOptions.headless = true;
  if (options['browser-launch-timeout-ms'] !== undefined) cliOptions.browserLaunchTimeoutMs = options['browser-launch-timeout-ms'];
  const result = await invokeRuntime(runner.module, ['runScan', 'runCrawler', 'scan', 'run'], cliOptions);
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
