'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, UsageError } = require('../args.cjs');
const { EXIT_OK, printResult, printRunResult, writeLine } = require('../status.cjs');
const { runPtkAgent } = require('../../core/runner.cjs');
const { ARTIFACT_FILENAMES, ensureDir, stableJson, writeJson } = require('../../core/artifacts.cjs');
const { redactSecrets } = require('../../core/config.cjs');
const { buildEngineSummary: buildRuntimeEngineSummary } = require('../../modules/moduleResolver.cjs');
const {
  buildSarif,
  evaluateSeverityThreshold,
  normalizedFindingsFromResult,
  normalizeThreshold
} = require('../../reporting/sarif.cjs');

const SUPPORTED_ENGINES = Object.freeze(['dast', 'iast', 'sast', 'sca']);

const UNSUPPORTED_FLAGS = Object.freeze({
  'agent-profile': 'Flag --agent-profile is not implemented by ptk-scan yet. Use --agent-mode, --agent-provider, --agent-model, and --max-provider-ms for supported agent settings.',
  'agent-transport': 'Flag --agent-transport is not implemented by ptk-scan yet. Provider transport is selected by the configured provider runtime.',
  'agent-steps': 'Flag --agent-steps is not implemented by ptk-scan yet. Use explicit crawler and provider budgets instead.',
  'agent-tool-rounds': 'Flag --agent-tool-rounds is not implemented by ptk-scan yet. Tool-round limits are not a product scan flag.',
  'agent-verbose': 'Flag --agent-verbose is not implemented by ptk-scan yet. Use --verbose on lower-level commands where supported.',
  'crawl-timeout': 'Flag --crawl-timeout is not implemented. Use route, action, observation, provider, and PTK drain budgets.'
});

const STRING_FLAGS = Object.freeze([
  'url',
  'config',
  'engine',
  'engines',
  'username',
  'username-env',
  'password',
  'password-env',
  'scenario',
  'crawl-pages',
  'crawl-depth',
  'route-hints-file',
  'max-routes',
  'max-route-ms',
  'max-action-ms',
  'max-actions-per-route',
  'max-forms-per-route',
  'max-no-progress-actions',
  'max-observation-ms',
  'ptk-drain-mode',
  'ptk-drain-timeout-ms',
  'output-dir',
  'ptk-extension-dir',
  'browser',
  'chrome-binary',
  'edge-binary',
  'firefox-xpi',
  'profile-dir',
  'browser-launch-timeout-ms',
  'crawl-timeout',
  'crawl-data',
  'profile-file',
  'persona',
  'memory-storage',
  'memory-mode',
  'agent-profile',
  'agent-transport',
  'agent-steps',
  'agent-tool-rounds',
  'agent-mode',
  'agent-provider',
  'agent-model',
  'max-agent-turns',
  'max-provider-ms',
  'max-steps-per-turn',
  'agent-risk-mode',
  'format',
  'output',
  'fail-on'
]);

const BOOLEAN_FLAGS = Object.freeze([
  'help',
  'dry-run',
  'print-config',
  'scenario-continue-on-failure',
  'require-ptk-bridge',
  'require-ptk-findings-export',
  'wait-for-ptk-complete',
  'require-ptk-attack-completion',
  'immediate-analysis',
  'defer-analysis',
  'include-secrets',
  'memory-reset',
  'agent-verbose',
  'aggressive',
  'allow-destructive-actions',
  'require-agent-success',
  'headed',
  'headless',
  'verbose'
]);

function help(cliName = 'ptk-scan') {
  return [
    'Usage:',
    `  ${cliName} <target-url> [options]`,
    `  ${cliName} --url <target-url> [options]`,
    `  ${cliName} --config <path> [options]`,
    '',
    'Core options:',
    '  --url <url>                     Target URL override.',
    '  --config <path>                 Config file path. CLI overrides win.',
    '  --engine, --engines <list>      Comma-separated DAST, IAST, SAST, SCA.',
    '  --scenario <path>               Scenario JSON/markdown path.',
    '  --scenario-continue-on-failure  Continue crawl after scenario setup failure.',
    '  --username <value>              Active persona username.',
    '  --username-env <name>           Read username from environment. Never artifact value.',
    '  --password <value>              Active persona password. Redacted in artifacts.',
    '  --password-env <name>           Read password from environment. Never artifact value.',
    '  --profile-file <path>           Profile/crawl-data JSON file.',
    '  --crawl-data <path>             Alias for --profile-file.',
    '  --persona <id>                  Active persona id.',
    '  --crawl-pages <n>               Alias for --max-routes.',
    '  --max-routes <n>                Max route count.',
    '  --crawl-depth <n>               Max discovery depth. Default is 5.',
    '  --route-hints-file <path>       JSON route/API surface hints to seed deterministic crawling.',
    '  --max-route-ms <ms>             Per-route navigation budget.',
    '  --max-action-ms <ms>            Per-action budget.',
    '  --max-actions-per-route <n>     Max safe actions per route.',
    '  --max-forms-per-route <n>       Max safe form submissions per route.',
    '  --max-no-progress-actions <n>   Stop after repeated no-progress actions.',
    '  --max-observation-ms <ms>       Observation budget.',
    '  --require-ptk-bridge            Mark run invalid when PTK bridge is missing.',
    '  --require-ptk-findings-export   Mark run invalid when findings export is missing.',
    '  --ptk-drain-mode <mode>         off, brief, until-idle, or until-complete.',
    '  --ptk-drain-timeout-ms <ms>     Explicit PTK drain timeout.',
    '  --wait-for-ptk-complete         Alias for --ptk-drain-mode until-complete with a bounded default timeout.',
    '  --require-ptk-attack-completion Fail when PTK planned tasks are incomplete or cancelled.',
    '  --defer-analysis                Skip immediate post-stop analysis; import/recompute later in PTK.',
    '  --immediate-analysis            Force immediate post-stop analysis. This is the normal automation default.',
    '  --agent-mode <mode>             off, mock, manager, provider, or browser.',
    '  --agent-provider <name>         Provider name, e.g. opencode or codex.',
    '  --agent-model <name>            Provider model.',
    '  --max-agent-turns <n>           Agent turns. Default: 3.',
    '  --max-provider-ms <ms>          Provider choice budget.',
    '  --max-steps-per-turn <n>        Agent tool steps per turn. Default: 1.',
    '  --aggressive                    Allow business-tier agent mutations only.',
    '  --allow-destructive-actions     Allow destructive-tier agent actions.',
    '  --require-agent-success         Fail scan if agent execution fails.',
    '  --include-secrets               Allow browser execution to use supplied secrets; artifacts/providers stay redacted.',
    '  --browser <name>                chromium, chrome, edge, or firefox.',
    '  --chrome-binary <path>          Chrome executable path.',
    '  --edge-binary <path>            Edge executable path.',
    '  --firefox-xpi <path>            Firefox XPI path; fails clearly until supported.',
    '  --profile-dir <path>            Browser persistent profile directory.',
    '  --browser-launch-timeout-ms <ms> Browser startup timeout. Default: 30000.',
    '  --memory-mode <mode>            off, read, or read-write site memory.',
    '  --memory-storage <dir>          Site memory storage directory.',
    '  --memory-reset                  Clear selected site memory before run.',
    '  --format <sarif|json>           Write an additional machine-readable report.',
    '  --output <path>                 Report path for --format; SARIF defaults to ptk-results.sarif in --output-dir.',
    '  --fail-on <severity|none>       Exit non-zero when findings meet critical, high, medium, low, or info.',
    '  --headed                        Run browser headed.',
    '  --headless                      Run browser headless.',
    '  --ptk-extension-dir <dir>       PTK unpacked extension directory.',
    '  --output-dir <dir>              Artifact output directory.',
    '  --dry-run                       Resolve config and write artifacts without launching browser.',
    '  --print-config                  Print redacted resolved config and CLI mapping summary.',
    '  --verbose                       Print full JSON result instead of concise CLI summary.',
    '  -h, --help                      Show help.',
    '',
    'Unsupported flags fail explicitly.'
  ].join('\n');
}

function toCamel(flag) {
  return flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseEngineList(value) {
  const raw = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    throw new UsageError('--engine requires at least one engine name');
  }
  const engines = [];
  for (const item of raw) {
    const engine = item.toLowerCase();
    if (!SUPPORTED_ENGINES.includes(engine)) {
      throw new UsageError(`Unknown engine "${item}". Supported engines: DAST, IAST, SAST, SCA.`);
    }
    if (!engines.includes(engine)) engines.push(engine);
  }
  return engines;
}

function engineOverrides(enabledEngines) {
  const engines = {};
  for (const engine of SUPPORTED_ENGINES) {
    engines[engine] = { enabled: enabledEngines.includes(engine) };
  }
  return engines;
}

function buildEngineSummary(config, requestedEngines = [], moduleResolution = null, lifecycle = null) {
  return buildRuntimeEngineSummary(config, moduleResolution, lifecycle, requestedEngines);
}

function normalizeReportFormat(value, outputPath = null) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (outputPath && /\.sarif(?:\.json)?$/i.test(String(outputPath))) return 'sarif';
    if (outputPath) return 'json';
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== 'sarif' && normalized !== 'json') {
    throw new UsageError('--format must be one of: sarif, json');
  }
  return normalized;
}

function resolveReportOutputPath(outputPath, { cwd = process.cwd(), outputDir, format } = {}) {
  if (outputPath) {
    return path.resolve(cwd, outputPath);
  }
  if (format === 'sarif') {
    return path.resolve(outputDir, ARTIFACT_FILENAMES.sarif);
  }
  return null;
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, stableJson(data), 'utf8');
  return filePath;
}

function createCompatibilitySummary({ mappedFlags = [], unsupportedFlags = [], warnings = [], errors = [], configSource = null, cliOverrides = [] } = {}) {
  return {
    wrapper: 'ptk-scan',
    scanMode: 'product-cli',
    mappedFlags: mappedFlags.slice(),
    unsupportedFlags: unsupportedFlags.slice(),
    warnings: warnings.slice(),
    errors: errors.slice(),
    configSource,
    cliOverrides: cliOverrides.slice()
  };
}

function throwForUnsupported(options) {
  for (const flag of Object.keys(UNSUPPORTED_FLAGS)) {
    if (options[flag] !== undefined) {
      throw new UsageError(UNSUPPORTED_FLAGS[flag]);
    }
  }
}

function mapPtkScanArgs(argv = [], env = process.env) {
  const { options, positionals } = parseArgs(argv, {
    booleans: BOOLEAN_FLAGS,
    strings: STRING_FLAGS
  });

  if (options.help) {
    return {
      help: true,
      cliOptions: {},
      compatibilitySummary: createCompatibilitySummary()
    };
  }

  throwForUnsupported(options);

  if (positionals.length > 1) {
    throw new UsageError(`ptk-scan accepts at most one positional URL; received: ${positionals.join(', ')}`);
  }

  const mappedFlags = [];
  const cliOverrides = [];
  const cliOptions = {};

  function mapFlag(flag, optionName, value, overridePath) {
    if (value === undefined) return;
    cliOptions[optionName] = value;
    mappedFlags.push(flag);
    if (overridePath) cliOverrides.push(overridePath);
  }

  const positionalUrl = positionals[0] || null;
  if (positionalUrl && options.url) {
    throw new UsageError('Use either a positional URL or --url, not both.');
  }
  if (positionalUrl) {
    mapFlag('positional URL', 'url', positionalUrl, 'target.baseUrl');
  } else {
    mapFlag('--url', 'url', options.url, 'target.baseUrl');
  }

  mapFlag('--config', 'config', options.config, null);
  mapFlag('--scenario', 'scenario', options.scenario, 'scenario.file');
  mapFlag('--scenario-continue-on-failure', 'scenarioContinueOnFailure', options['scenario-continue-on-failure'], 'scenario.continueOnFailure');
  mapFlag('--username', 'username', options.username, 'profile.username');
  mapFlag('--password', 'password', options.password, 'profile.password');
  mapFlag('--profile-file', 'profileFile', options['profile-file'], 'profile.file');
  mapFlag('--crawl-data', 'crawlData', options['crawl-data'], 'profile.file');
  mapFlag('--persona', 'persona', options.persona, 'profile.activePersonaId');

  if (options['username-env'] !== undefined) {
    const envName = options['username-env'];
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      throw new UsageError(`Environment variable ${envName} is not set for --username-env`);
    }
    cliOptions.username = env[envName];
    mappedFlags.push('--username-env');
    cliOverrides.push('profile.username');
  }

  if (options['password-env'] !== undefined) {
    const envName = options['password-env'];
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      throw new UsageError(`Environment variable ${envName} is not set for --password-env`);
    }
    cliOptions.password = env[envName];
    mappedFlags.push('--password-env');
    cliOverrides.push('profile.password');
  }

  const maxRoutes = options['max-routes'] !== undefined ? options['max-routes'] : options['crawl-pages'];
  if (maxRoutes !== undefined) {
    cliOptions.maxRoutes = maxRoutes;
    mappedFlags.push(options['max-routes'] !== undefined ? '--max-routes' : '--crawl-pages');
    cliOverrides.push('crawler.maxRoutes');
  }
  mapFlag('--crawl-depth', 'crawlDepth', options['crawl-depth'], 'crawler.maxDepth');
  mapFlag('--route-hints-file', 'routeHintsFile', options['route-hints-file'], 'crawler.routeHintsFile');

  mapFlag('--max-route-ms', 'maxRouteMs', options['max-route-ms'], 'crawler.maxRouteMs');
  mapFlag('--max-action-ms', 'maxActionMs', options['max-action-ms'], 'crawler.maxActionMs');
  mapFlag('--max-actions-per-route', 'maxActionsPerRoute', options['max-actions-per-route'], 'crawler.maxActionsPerRoute');
  mapFlag('--max-forms-per-route', 'maxFormsPerRoute', options['max-forms-per-route'], 'crawler.maxFormsPerRoute');
  mapFlag('--max-no-progress-actions', 'maxNoProgressActions', options['max-no-progress-actions'], 'crawler.maxNoProgressActions');
  mapFlag('--max-observation-ms', 'maxObservationMs', options['max-observation-ms'], 'crawler.maxObservationMs');
  mapFlag('--output-dir', 'outputDir', options['output-dir'], 'artifacts.outputDir');
  mapFlag('--ptk-extension-dir', 'ptkExtensionDir', options['ptk-extension-dir'], 'ptk.extensionPath');
  mapFlag('--browser', 'browser', options.browser, 'browser.name');
  mapFlag('--chrome-binary', 'chromeBinary', options['chrome-binary'], 'browser.executablePath');
  mapFlag('--edge-binary', 'edgeBinary', options['edge-binary'], 'browser.executablePath');
  mapFlag('--firefox-xpi', 'firefoxXpi', options['firefox-xpi'], 'browser.firefoxXpi');
  mapFlag('--profile-dir', 'profileDir', options['profile-dir'], 'browser.profileDir');
  mapFlag('--browser-launch-timeout-ms', 'browserLaunchTimeoutMs', options['browser-launch-timeout-ms'], 'browser.launchTimeoutMs');
  mapFlag('--memory-mode', 'memoryMode', options['memory-mode'], 'memory.mode');
  mapFlag('--memory-storage', 'memoryStorage', options['memory-storage'], 'memory.storageDir');
  mapFlag('--memory-reset', 'memoryReset', options['memory-reset'], 'memory.reset');
  mapFlag('--require-ptk-bridge', 'requirePtkBridge', options['require-ptk-bridge'], 'ptk.requireBridge');
  mapFlag('--require-ptk-findings-export', 'requirePtkFindingsExport', options['require-ptk-findings-export'], 'ptk.requireFindingsExport');
  mapFlag('--ptk-drain-mode', 'ptkDrainMode', options['ptk-drain-mode'], 'ptk.drainMode');
  mapFlag('--ptk-drain-timeout-ms', 'ptkDrainTimeoutMs', options['ptk-drain-timeout-ms'], 'ptk.drainTimeoutMs');
  mapFlag('--wait-for-ptk-complete', 'waitForPtkComplete', options['wait-for-ptk-complete'], 'ptk.drainMode');
  mapFlag('--require-ptk-attack-completion', 'requirePtkAttackCompletion', options['require-ptk-attack-completion'], 'ptk.requireAttackCompletion');
  if (options['immediate-analysis'] && options['defer-analysis']) {
    throw new UsageError('Use either --immediate-analysis or --defer-analysis, not both.');
  }
  if (options['immediate-analysis']) {
    mapFlag('--immediate-analysis', 'immediateAnalysis', true, 'ptk.immediateAnalysis');
  }
  if (options['defer-analysis']) {
    mapFlag('--defer-analysis', 'immediateAnalysis', false, 'ptk.immediateAnalysis');
  }
  mapFlag('--include-secrets', 'includeSecrets', options['include-secrets'], 'profile.includeSecrets');
  mapFlag('--agent-mode', 'agentMode', options['agent-mode'], 'agent.mode');
  mapFlag('--agent-provider', 'agentProvider', options['agent-provider'], 'agent.provider');
  mapFlag('--agent-model', 'agentModel', options['agent-model'], 'agent.model');
  mapFlag('--max-agent-turns', 'maxAgentTurns', options['max-agent-turns'], 'agent.maxTurns');
  mapFlag('--max-provider-ms', 'maxProviderMs', options['max-provider-ms'], 'agent.maxProviderMs');
  mapFlag('--max-steps-per-turn', 'maxStepsPerTurn', options['max-steps-per-turn'], 'agent.maxStepsPerTurn');
  mapFlag('--aggressive', 'aggressive', options.aggressive, 'agent.allowBusinessMutations');
  mapFlag('--allow-destructive-actions', 'allowDestructiveActions', options['allow-destructive-actions'], 'agent.allowDestructiveActions');
  mapFlag('--require-agent-success', 'requireAgentSuccess', options['require-agent-success'], 'agent.requireSuccess');
  mapFlag('--verbose', 'verbose', options.verbose, null);

  const reportFormat = normalizeReportFormat(options.format, options.output);
  if (reportFormat) {
    cliOptions.format = reportFormat;
    mappedFlags.push('--format');
  }
  if (options.output !== undefined) {
    cliOptions.output = options.output;
    mappedFlags.push('--output');
  }
  if (options['fail-on'] !== undefined) {
    try {
      cliOptions.failOn = normalizeThreshold(options['fail-on']);
    } catch (error) {
      throw new UsageError(error.message);
    }
    mappedFlags.push('--fail-on');
  }

  if (options['dry-run']) {
    cliOptions.dryRun = true;
    mappedFlags.push('--dry-run');
  }
  if (options['print-config']) {
    cliOptions.dryRun = true;
    cliOptions.printConfig = true;
    mappedFlags.push('--print-config');
  }
  if (options.headed && options.headless) {
    throw new UsageError('Use either --headed or --headless, not both.');
  }
  if (options.headed) {
    cliOptions.headless = false;
    mappedFlags.push('--headed');
    cliOverrides.push('browser.headless');
  }
  if (options.headless) {
    cliOptions.headless = true;
    mappedFlags.push('--headless');
    cliOverrides.push('browser.headless');
  }

  const engineValue = options.engines !== undefined ? options.engines : options.engine;
  const requestedEngines = engineValue !== undefined ? parseEngineList(engineValue) : [];
  if (engineValue !== undefined) {
    cliOptions.inlineConfig = {
      engines: engineOverrides(requestedEngines)
    };
    mappedFlags.push(options.engines !== undefined ? '--engines' : '--engine');
    for (const engine of SUPPORTED_ENGINES) {
      cliOverrides.push(`engines.${engine}.enabled`);
    }
  }

  if (!cliOptions.url && !cliOptions.config) {
    throw new UsageError('ptk-scan requires a target URL, --url, or --config');
  }

  const compatibilitySummary = createCompatibilitySummary({
    mappedFlags,
    configSource: cliOptions.config || null,
    cliOverrides
  });

  return {
    help: false,
    cliOptions,
    requestedEngines,
    compatibilitySummary
  };
}

function writeCompatibilityArtifacts(outputDir, compatibilitySummary, engineSummary) {
  const files = {
    compatibilitySummary: writeJson(outputDir, ARTIFACT_FILENAMES.compatibilitySummary, compatibilitySummary),
    engineSummary: writeJson(outputDir, ARTIFACT_FILENAMES.engineSummary, engineSummary)
  };
  return files;
}

async function run(argv = [], context = {}) {
  const io = context.io || { stdout: process.stdout, stderr: process.stderr };
  const cliName = context.cliName || 'ptk-scan';
  const mapped = mapPtkScanArgs(argv, context.env || process.env);
  if (mapped.help) {
    writeLine(io.stdout, help(cliName));
    return EXIT_OK;
  }

  const verboseOutput = Boolean(mapped.cliOptions.verbose);
  const reportFormat = mapped.cliOptions.format || null;
  const reportOutput = mapped.cliOptions.output || null;
  const failOn = mapped.cliOptions.failOn || 'none';
  const thresholdRequested = mapped.cliOptions.failOn !== undefined;
  const runOptions = { ...mapped.cliOptions };
  delete runOptions.verbose;
  delete runOptions.format;
  delete runOptions.output;
  delete runOptions.failOn;
  const executeRun = context.runPtkAgent || runPtkAgent;
  const result = await executeRun({
    ...runOptions,
    cwd: context.cwd || process.cwd(),
    throwOnError: mapped.cliOptions.throwOnError !== undefined ? mapped.cliOptions.throwOnError : false
  });
  const outputDir = result.config.artifacts.outputDir;
  const engineSummary = buildEngineSummary(
    result.config,
    mapped.requestedEngines || [],
    result.moduleResolution || null,
    result.coverage && result.coverage.ptk && result.coverage.ptk.lifecycle || null
  );
  const files = writeCompatibilityArtifacts(outputDir, mapped.compatibilitySummary, engineSummary);
  result.artifacts = Object.assign({}, result.artifacts || {}, files);

  const findings = reportFormat || thresholdRequested ? normalizedFindingsFromResult(result) : [];
  let thresholdSummary = null;
  if (thresholdRequested) {
    thresholdSummary = evaluateSeverityThreshold(findings, failOn);
    result.threshold = thresholdSummary;
    result.artifacts.findingThreshold = writeJson(outputDir, ARTIFACT_FILENAMES.findingThreshold, thresholdSummary);
  }

  if (reportFormat === 'sarif') {
    const sarifPath = resolveReportOutputPath(reportOutput, {
      cwd: context.cwd || process.cwd(),
      outputDir,
      format: reportFormat
    });
    result.artifacts.sarif = writeJsonFile(sarifPath, buildSarif(result, { findings }));
  } else if (reportFormat === 'json' && reportOutput) {
    const jsonPath = resolveReportOutputPath(reportOutput, {
      cwd: context.cwd || process.cwd(),
      outputDir,
      format: reportFormat
    });
    result.artifacts.report = jsonPath;
    writeJsonFile(jsonPath, redactSecrets(result));
  }

  if (mapped.cliOptions.printConfig) {
    printResult({ io }, {
      config: redactSecrets(result.config),
      compatibilitySummary: mapped.compatibilitySummary,
      engineSummary
    });
  } else {
    printRunResult({ io }, redactSecrets(result), {
      verbose: verboseOutput
    });
  }
  if (thresholdSummary && thresholdSummary.failed) {
    writeLine(io.stderr, `PTK fail-on threshold triggered: ${thresholdSummary.failingCount} finding(s) at ${thresholdSummary.failOn} or higher.`);
  }
  return result.ok && (!thresholdSummary || thresholdSummary.ok) ? EXIT_OK : 70;
}

module.exports = {
  SUPPORTED_ENGINES,
  UNSUPPORTED_FLAGS,
  buildEngineSummary,
  createCompatibilitySummary,
  engineOverrides,
  help,
  mapPtkScanArgs,
  normalizeReportFormat,
  parseEngineList,
  resolveReportOutputPath,
  run,
  writeCompatibilityArtifacts
};
