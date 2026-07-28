'use strict';

const { camelizeOptions, parseArgs, UsageError } = require('../args.cjs');
const { EXIT_OK, printResult, writeLine } = require('../status.cjs');

const name = 'benchmark';
const summary = 'Run the scanner benchmark matrix.';

function help(cliName) {
  return [
    'Usage:',
    `  ${cliName} benchmark [options]`,
    '',
    'Options:',
    '  --output-dir <path>          Matrix output directory.',
    '  --targets <list>             Comma-separated targets: juice-shop,testfire,brokencrystals.',
    '  --juice-url <url>            Juice Shop URL. Default: http://localhost:3001/',
    '  --testfire-url <url>         TestFire URL. Default: http://localhost:88/',
    '  --brokencrystals-url <url>   BrokenCrystals URL. Default: https://brokencrystals.com/',
    '  --juice-username <value>     Juice Shop benchmark username. Default: YOUR_USERNAME.',
    '  --juice-username-env <name>  Env var containing Juice Shop benchmark username.',
    '  --juice-password-env <name>  Env var containing Juice Shop benchmark password.',
    '  --testfire-username <value>  TestFire benchmark username. Default: YOUR_USERNAME.',
    '  --testfire-username-env <name> Env var containing TestFire benchmark username.',
    '  --testfire-password-env <name> Env var containing TestFire benchmark password.',
    '  --brokencrystals-username <value> BrokenCrystals benchmark username. Default: YOUR_USERNAME.',
    '  --brokencrystals-username-env <name> Env var containing BrokenCrystals benchmark username.',
    '  --brokencrystals-password-env <name> Env var containing BrokenCrystals benchmark password.',
    '  --agent-provider <name>      none, mock, opencode, codex, or all. Default: opencode.',
    '  --agent-model <model>        Provider model. Overrides --opencode-model.',
    '  --opencode-model <model>     Default: opencode/big-pickle.',
    '  --codex-model <model>        Default: gpt-5.3-codex-spark.',
    '  --scenario-mode <mode>       explicit, none, or all. Default: explicit.',
    '  --max-routes <n>             Routes per run. Default: config default.',
    '  --crawl-depth <n>            Max discovery depth. Default: config default.',
    '  --max-route-ms <ms>          Route navigation/lifecycle budget override.',
    '  --max-action-ms <ms>         Per-action budget override.',
    '  --max-actions-per-route <n>  Actions per route. Default: config default.',
    '  --max-forms-per-route <n>    Safe form submits per route.',
    '  --max-observation-ms <ms>    Observation budget. Default: config default.',
    '  --max-provider-ms <ms>       Provider budget. Default: 60000.',
    '  --max-agent-turns <n>        Agent turns per benchmark row. Default: 3 for agent providers.',
    '  --aggressive                 Allow business-tier agent mutations only.',
    '  --allow-destructive-actions  Allow destructive-tier agent actions.',
    '  --require-agent-success      Fail rows when agent execution fails.',
    '  --agent-allow-scenario-unblock Run provider rows even when the no-agent scenario baseline fails.',
    '  --ptk-extension-dir <dir>    Unpacked PTK extension directory. Auto-detected by default in this repo.',
    '  --scenario-continue-on-failure  Continue crawl after scenario setup failure.',
    '  --allow-missing-ptk          Do not mark matrix rows invalid when PTK bridge/export is missing.',
    '  --require-ptk-bridge         Require PTK bridge detection. Default for benchmark.',
    '  --require-ptk-findings-export Require PTK findings/export capability. Default for benchmark.',
    '  --ptk-drain-mode <mode>      off, brief, until-idle, or until-complete.',
    '  --ptk-drain-timeout-ms <ms>  Explicit PTK drain timeout.',
    '  --wait-for-ptk-complete      Alias for --ptk-drain-mode until-complete with a bounded default timeout.',
    '  --require-ptk-attack-completion Fail when PTK planned tasks are incomplete or cancelled.',
    '  -h, --help                   Show help.'
  ].join('\n');
}

async function run(argv, context) {
  const { options } = parseArgs(argv, {
    booleans: ['help', 'scenario-continue-on-failure', 'allow-missing-ptk', 'require-ptk-bridge', 'require-ptk-findings-export', 'wait-for-ptk-complete', 'require-ptk-attack-completion', 'agent-allow-scenario-unblock', 'aggressive', 'allow-destructive-actions', 'require-agent-success'],
    strings: [
      'output-dir',
      'targets',
      'juice-url',
      'testfire-url',
      'brokencrystals-url',
      'juice-username',
      'juice-username-env',
      'juice-password-env',
      'testfire-username',
      'testfire-username-env',
      'testfire-password-env',
      'brokencrystals-username',
      'brokencrystals-username-env',
      'brokencrystals-password-env',
      'agent-provider',
      'agent-model',
      'opencode-model',
      'codex-model',
      'scenario-mode',
      'max-routes',
      'crawl-depth',
      'max-route-ms',
      'max-action-ms',
      'max-actions-per-route',
      'max-forms-per-route',
      'max-observation-ms',
      'max-provider-ms',
      'max-agent-turns',
      'ptk-extension-dir',
      'ptk-drain-mode',
      'ptk-drain-timeout-ms'
    ]
  });
  if (options.help) {
    writeLine(context.io.stdout, help(context.cliName));
    return EXIT_OK;
  }
  const cliOptions = camelizeOptions(options);
  if (options['juice-username-env'] !== undefined) {
    cliOptions.juiceUsername = readRequiredEnv(options['juice-username-env'], '--juice-username-env');
  }
  if (options['juice-password-env'] !== undefined) {
    cliOptions.juicePassword = readRequiredEnv(options['juice-password-env'], '--juice-password-env');
  }
  if (options['testfire-username-env'] !== undefined) {
    cliOptions.testfireUsername = readRequiredEnv(options['testfire-username-env'], '--testfire-username-env');
  }
  if (options['testfire-password-env'] !== undefined) {
    cliOptions.testfirePassword = readRequiredEnv(options['testfire-password-env'], '--testfire-password-env');
  }
  if (options['brokencrystals-username-env'] !== undefined) {
    cliOptions.brokencrystalsUsername = readRequiredEnv(options['brokencrystals-username-env'], '--brokencrystals-username-env');
  }
  if (options['brokencrystals-password-env'] !== undefined) {
    cliOptions.brokencrystalsPassword = readRequiredEnv(options['brokencrystals-password-env'], '--brokencrystals-password-env');
  }
  const { runBenchmarkMatrix } = require('../../benchmarks/matrixRunner.cjs');
  const result = await runBenchmarkMatrix({
    ...cliOptions,
    cwd: context.cwd,
    runPtkAgent: context.runPtkAgent
  });
  printResult(context, {
    outputDir: result.outputDir,
    engines: result.matrix && result.matrix.engines || [],
    results: result.results.map(item => ({
      target: item.target,
      mode: item.mode,
      scenario: item.scenario,
      ok: item.ok,
      status: item.status,
      coverageSummary: item.coverageSummary,
      scenarioStatus: item.scenarioStatus,
      ptkValidity: item.ptkValidity,
      agentChoice: item.agent && item.agent.choices && item.agent.choices[0] || null,
      error: item.error || null
    })),
    comparisons: result.comparisons.map(item => ({
      target: item.target,
      skipped: Boolean(item.skipped),
      reason: item.reason || null,
      passed: item.comparison && item.comparison.passed,
      regressions: item.comparison && item.comparison.regressions || []
    }))
  });
  return EXIT_OK;
}

function readRequiredEnv(name, flag) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    throw new UsageError(`Environment variable ${name} is not set for ${flag}`);
  }
  return process.env[name];
}

module.exports = { help, name, run, summary };
