'use strict';

const { resolveConfig, configOverridesFromCli, redactSecrets } = require('./config.cjs');
const { RunTelemetry } = require('./telemetry.cjs');
const { ARTIFACT_FILENAMES, writeJson, writeJsonl, writeStandardArtifacts } = require('./artifacts.cjs');
const { createLogger, createNullLogger } = require('./logger.cjs');
const { createOrchestrator } = require('./orchestrator.cjs');
const { buildEngineSummary, resolveModules } = require('../modules/moduleResolver.cjs');
const { buildExecutionPlan } = require('./executionPlan.cjs');

async function runPtkAgent(options = {}) {
  const logger = options.logger || (options.quiet === undefined && options.verbose === undefined
    ? createNullLogger()
    : createLogger({ quiet: options.quiet, verbose: options.verbose }));
  const config = resolveConfig({
    configPath: options.configPath || options.config || null,
    config: options.inlineConfig || options.configObject || null,
    overrides: options.overrides || configOverridesFromCli(options),
    cliOverrides: options.cliOverrides || null,
    cwd: options.cwd || process.cwd(),
    generatedAt: options.generatedAt || null
  });
  const executionPlan = buildExecutionPlan(config, options);
  config._resolved = {
    ...(config._resolved || {}),
    executionPlan
  };
  if (typeof options.onExecutionPlan === 'function') {
    options.onExecutionPlan(executionPlan);
  }

  const requestedMode = options.openOnly ? 'open-only' : options.dryRun ? 'dry-run' : (options.requestedMode || options.mode || 'crawl');
  const telemetry = options.telemetry || new RunTelemetry({
    runId: options.runId || null,
    requestedMode,
    actualMode: requestedMode,
    now: options.now || Date.now,
    startMs: options.startMs || null
  });
  telemetry.event('config.resolved', {
    target: config.target.baseUrl,
    budgets: config._resolved.budgets
  });

  const orchestrator = options.orchestrator || createOrchestrator({
    handlers: options.handlers || {},
    logger
  });

  let coverage = null;
  let result = null;
  let error = null;
  let moduleResolution = null;
  try {
    moduleResolution = resolveRuntimeModules(config, options);
    telemetry.event('modules.resolved', {
      ok: Boolean(moduleResolution.ok),
      engines: moduleResolution.engines,
      requestedPacks: moduleResolution.requestedPacks,
      moduleCount: Array.isArray(moduleResolution.modules) ? moduleResolution.modules.length : 0
    });
    result = await orchestrator.orchestrate({
      config,
      telemetry,
      logger,
      options: {
        ...options,
        moduleResolution
      },
      handlers: options.handlers || {}
    });
    coverage = result && result.coverage ? result.coverage : null;
  } catch (err) {
    error = err;
    if (err && err.moduleResolution) moduleResolution = err.moduleResolution;
    telemetry.error(err, { phase: 'runner' });
  } finally {
    telemetry.finish(options.endMs || null);
  }

  const terminalStatus = determineTerminalStatus({ error, result, coverage, config, options });

  const artifacts = options.writeArtifacts === false
    ? null
    : writeStandardArtifacts(config.artifacts.outputDir, {
      config,
      telemetry,
      coverage,
      events: telemetry.events
    });
  if (artifacts) {
    artifacts.executionPlan = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.executionPlan, executionPlan);
  }
  const ptkLifecycle = createPtkLifecycle({ coverage, config, options, status: terminalStatus });
  if (artifacts && ptkLifecycle) {
    artifacts.ptkLifecycle = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.ptkLifecycle, ptkLifecycle);
    artifacts.ptkLifecycleNormalized = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.ptkLifecycleNormalized, createPtkLifecycleNormalized(ptkLifecycle));
  }
  const engineSummary = buildEngineSummary(config, moduleResolution, ptkLifecycle && ptkLifecycle.lifecycle || null, options.requestedEngines || []);
  if (artifacts) {
    if (moduleResolution) artifacts.moduleResolution = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.moduleResolution, moduleResolution);
    artifacts.engineSummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.engineSummary, engineSummary);
  }
  if (artifacts && coverage && coverage.ptk && coverage.ptk.evidence) {
    const { writeFindingsCountArtifact } = require('../evidence/ptkEvidenceAdapter.cjs');
    const written = writeFindingsCountArtifact(config.artifacts.outputDir, {
      evidence: coverage.ptk.evidence,
      bridge: coverage.ptk.bridge,
      exported: coverage.ptk.exported,
      status: coverage.ptk.evidence.status,
      export: coverage.ptk.evidence.export
    });
    artifacts.ptkFindingsCount = written.filePath;
  }
  if (artifacts && result && result.agent) {
    const { buildManagerTelemetryArtifact } = require('../agent/managerTelemetry.cjs');
    artifacts.agentManager = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentManager, buildManagerTelemetryArtifact(result.agent));
    artifacts.agentSummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentSummary, {
      schemaVersion: 'ptk-agent-v2-agent-summary',
      status: result.agent.status || null,
      actual: result.agent.actual || null,
      stopReason: result.agent.telemetry && result.agent.telemetry.stopReason || null,
      effectiveMaxTurns: config.agent && config.agent.maxTurns || null,
      missionCount: Array.isArray(result.agent.missions) ? result.agent.missions.length : 0,
      choiceCount: Array.isArray(result.agent.choices) ? result.agent.choices.length : 0,
      resultCount: Array.isArray(result.agent.results) ? result.agent.results.length : 0,
      addedCoverage: result.agent.coverageDelta && result.agent.coverageDelta.total || null,
      missionSummary: result.agent.missionCompilerSummary || null
    });
    artifacts.agentTurns = writeJsonl(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentTurns, result.agent.turns || []);
    artifacts.agentActionPlans = writeJsonl(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentActionPlans, result.agent.actionPlans || []);
    artifacts.agentExecutionResults = writeJsonl(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentExecutionResults, result.agent.executionResults || []);
    if (result.agent.coverageDelta) artifacts.agentCoverageDelta = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentCoverageDelta, result.agent.coverageDelta);
    if (result.agent.providerDecisionQuality) artifacts.providerDecisionQuality = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.providerDecisionQuality, result.agent.providerDecisionQuality);
    if (result.agent.baselinePreservation) artifacts.agentBaselinePreservation = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentBaselinePreservation, result.agent.baselinePreservation);
    if (result.agent.riskPolicy) artifacts.agentRiskPolicy = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentRiskPolicy, result.agent.riskPolicy);
    if (result.agent.missionCompilerSummary) artifacts.agentMissionCompilerSummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentMissionCompilerSummary, result.agent.missionCompilerSummary);
    if (result.agent.executorRecoverySummary) artifacts.agentExecutorRecoverySummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.agentExecutorRecoverySummary, result.agent.executorRecoverySummary);
    if (result.agent.formRepairSummary) artifacts.formRepairSummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.formRepairSummary, result.agent.formRepairSummary);
    if (result.agent.businessLogicSummary) artifacts.businessLogicSummary = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.businessLogicSummary, result.agent.businessLogicSummary);
    if (result.agent.findingFingerprintDiff) artifacts.findingFingerprintDiff = writeJson(config.artifacts.outputDir, ARTIFACT_FILENAMES.findingFingerprintDiff, result.agent.findingFingerprintDiff);
  }

  if (error && options.throwOnError) {
    throw error;
  }

  return {
    ok: !error && isSuccessfulStatus(terminalStatus),
    status: terminalStatus,
    error: serializeRunError(error, { config }),
    config,
    telemetry: telemetry.snapshot(),
    artifacts,
    moduleResolution,
    executionPlan,
    engineSummary,
    coverage: coverage || { routes: [], endpoints: [], actions: [], forms: [] },
    result
  };
}

function resolveRuntimeModules(config = {}, options = {}) {
  const resolution = resolveModules(config, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    cache: options.moduleCache || null
  });
  if (!resolution.ok) {
    const error = new Error(`Module resolution failed: ${(resolution.errors || []).join('; ') || 'unknown error'}`);
    error.code = 'ERR_PTK_MODULE_RESOLUTION';
    error.moduleResolution = resolution;
    throw error;
  }
  return resolution;
}

function serializeRunError(error, context = {}) {
  if (!error) return null;
  const message = error && error.message ? String(error.message) : String(error);
  const serialized = {
    name: error && error.name ? String(error.name) : 'Error',
    message,
    code: error && error.code ? String(error.code) : null
  };

  const classification = classifyRunError(message, context);
  if (classification) {
    Object.assign(serialized, classification);
  }

  if (error && error.errors && Array.isArray(error.errors)) {
    serialized.errors = error.errors.map(item => String(item));
  }
  if (process.env.PTK_AGENT_DEBUG && error && error.stack) {
    serialized.stack = String(error.stack);
  }

  return redactSecrets(serialized);
}

function classifyRunError(message = '', context = {}) {
  if (isPlaywrightBrowserMissingError(message)) {
    const browserName = context.config && context.config.browser && context.config.browser.name || 'chromium';
    const installTarget = playwrightInstallTarget(browserName);
    return {
      category: 'browser_install_missing',
      summary: `Playwright ${installTarget} browser binaries are not installed.`,
      hint: `Run "npx playwright install ${installTarget}" in the project where pentestkit is installed, then retry the scan. You can also pass --chrome-binary, --edge-binary, or browser.executablePath to use an existing browser.`,
      command: `npx playwright install ${installTarget}`
    };
  }
  if (isPlaywrightBrowserLaunchTimeoutError(message)) {
    const timeoutMs = context.config && context.config.browser && context.config.browser.launchTimeoutMs || null;
    return {
      category: 'browser_launch_timeout',
      summary: `Browser did not finish starting within ${timeoutMs || 'the configured'}ms launch timeout.`,
      hint: 'Retry once after install/reinstall, close any browser using the same profile, or increase startup budget with --browser-launch-timeout-ms 60000. You can also pass --chrome-binary or --edge-binary to use an existing browser.',
      command: 'npx ptk-scan <target-url> --browser-launch-timeout-ms 60000'
    };
  }
  return null;
}

function isPlaywrightBrowserMissingError(message = '') {
  return /browserType\.launch(?:PersistentContext)?: Executable doesn't exist/i.test(message)
    || /Looks like Playwright was just installed or updated/i.test(message)
    || /Please run the following command to download new browsers/i.test(message);
}

function isPlaywrightBrowserLaunchTimeoutError(message = '') {
  return /browserType\.launch(?:PersistentContext)?: Timeout \d+ms exceeded/i.test(message);
}

function playwrightInstallTarget(browserName = 'chromium') {
  const normalized = String(browserName || '').toLowerCase();
  if (normalized === 'firefox') return 'firefox';
  return 'chromium';
}

function determineTerminalStatus({ error, result, coverage, config = {}, options = {} } = {}) {
  if (error) return 'failed';
  const ptkStatus = requiredPtkStatus(coverage, config, options);
  if (ptkStatus) return ptkStatus;
  if (config.agent && config.agent.requireSuccess === true && result && result.agent && result.agent.status !== 'completed') {
    return 'agent_failed';
  }
  return (result && result.status) || 'completed';
}

function requiredPtkStatus(coverage, config = {}, options = {}) {
  if (options.dryRun) return null;
  const ptkConfig = config.ptk || {};
  const requireBridge = options.requirePtkBridge === true || ptkConfig.requireBridge === true;
  const requireFindingsExport = options.requirePtkFindingsExport === true || ptkConfig.requireFindingsExport === true;
  const allowMissing = options.allowMissingPtk === true || (ptkConfig.allowMissing === true && !requireBridge && !requireFindingsExport);
  if (ptkConfig.enabled === false || allowMissing) return null;
  if (!requireBridge && !requireFindingsExport) return null;
  const ptk = coverage && coverage.ptk;
  const validity = ptk && ptk.validity || ptk && ptk.evidence && ptk.evidence.validity || null;
  const hasBridge = Boolean(validity ? validity.hasPtkBridge : ptk && ptk.available);
  const exportValiditySource = ptk && ptk.lifecycle && ptk.lifecycle.findingsExportValiditySource
    || ptk && ptk.evidence && ptk.evidence.findingsExportValiditySource
    || null;
  const hasFindingsExport = Boolean(validity ? validity.hasFindingsExport && exportValiditySource !== 'findings-api' : ptk && ptk.exported);
  if (requireBridge && !hasBridge) return 'invalid_no_ptk_bridge';
  if (requireFindingsExport && !hasFindingsExport) return 'invalid_no_findings_export';
  const requireAttackCompletion = options.requirePtkAttackCompletion === true || ptkConfig.requireAttackCompletion === true;
  if (requireAttackCompletion && ptkAttackCompletionIncomplete(ptk)) return 'invalid_ptk_attack_incomplete';
  return null;
}

function isSuccessfulStatus(status) {
  return ![
    'failed',
    'scenario_failed',
    'completed_with_scenario_failure',
    'invalid_no_ptk_bridge',
    'invalid_no_findings_export',
    'invalid_ptk_attack_incomplete'
  ].includes(status);
}

function ptkAttackCompletionIncomplete(ptk = {}) {
  const attack = ptk && ptk.lifecycle && ptk.lifecycle.attackCompletion || null;
  if (!attack || attack.available === false) return true;
  if (attack.partial === true) return true;
  for (const engine of Object.values(attack.engines || {})) {
    if (Number(engine.cancelled || 0) > 0) return true;
    if (engine.partial === true) return true;
    const planned = Number(engine.planned);
    const completed = Number(engine.completed);
    const remaining = Number(engine.remaining);
    if (
      Number.isFinite(planned)
      && Number.isFinite(completed)
      && planned > completed
      && (!Number.isFinite(remaining) || remaining > 0)
    ) return true;
  }
  return false;
}

function createPtkLifecycle({ coverage, config = {}, options = {}, status } = {}) {
  const ptkConfig = config.ptk || {};
  if (options.dryRun) return null;
  if (ptkConfig.enabled === false) return null;
  const ptk = coverage && coverage.ptk || null;
  const required = Boolean(options.requirePtkBridge === true || ptkConfig.requireBridge === true || options.requirePtkFindingsExport === true || ptkConfig.requireFindingsExport === true);
  if (!ptk && !required) return null;
  const validity = ptk && ptk.validity || ptk && ptk.evidence && ptk.evidence.validity || {
    valid: false,
    status: 'invalid_no_ptk_bridge',
    hasPtkBridge: false,
    hasFindingsExport: false,
    findingsCount: 0,
    reason: ptk ? ptk.reason || 'not_available' : 'not_collected'
  };
  const lifecycle = ptk && ptk.lifecycle || {};
  const exportBeforeStopAttempted = lifecycle.exportBeforeStopAttempted !== undefined
    ? Boolean(lifecycle.exportBeforeStopAttempted)
    : isPreStopExportStage(lifecycle.exportAttemptStage);
  const exportBeforeStopSucceeded = lifecycle.exportBeforeStopSucceeded !== undefined
    ? Boolean(lifecycle.exportBeforeStopSucceeded)
    : isPreStopExportStage(lifecycle.exportAttemptStage) && Boolean(lifecycle.exportSucceeded);
  return {
    schemaVersion: 'ptk-agent-v2-ptk-lifecycle',
    generatedAt: new Date().toISOString(),
    status,
    bridgeDetected: Boolean(lifecycle.bridgeDetected || validity.hasPtkBridge),
    scanStarted: Boolean(lifecycle.scanStarted),
    scanStopped: Boolean(lifecycle.scanStopped),
    exportAttempted: lifecycle.exportAttempted !== undefined ? Boolean(lifecycle.exportAttempted) : Boolean(ptk),
    exportSucceeded: Boolean(lifecycle.exportSucceeded || ptk && ptk.exported),
    exportAttemptStage: lifecycle.exportAttemptStage || null,
    exportBeforeStopAttempted,
    exportBeforeStopSucceeded,
    exportRecoveredAfterStop: Boolean(lifecycle.exportRecoveredAfterStop),
    exportFailureBeforeStop: lifecycle.exportFailureBeforeStop !== undefined ? Boolean(lifecycle.exportFailureBeforeStop) : isPreStopExportStage(lifecycle.exportAttemptStage) && lifecycle.exportSucceeded === false,
    exportAttempts: Array.isArray(lifecycle.exportAttempts) ? lifecycle.exportAttempts : [],
    exportLookupSource: lifecycle.exportLookupSource || null,
    exportRetrievalResolved: lifecycle.exportRetrievalResolved === true,
    findingsApiFallbackUsed: lifecycle.findingsApiFallbackUsed === true,
    findingsExportValiditySource: lifecycle.findingsExportValiditySource || (validity.hasFindingsExport ? 'export' : 'none'),
    rawStatusSamples: Array.isArray(lifecycle.rawStatusSamples) ? lifecycle.rawStatusSamples : [],
    inconsistencies: Array.isArray(lifecycle.inconsistencies) ? lifecycle.inconsistencies : [],
    findingsCount: Number(validity.findingsCount || lifecycle.findingsCount || 0),
    required: {
      bridge: Boolean(options.requirePtkBridge === true || ptkConfig.requireBridge === true),
      findingsExport: Boolean(options.requirePtkFindingsExport === true || ptkConfig.requireFindingsExport === true),
      allowMissing: Boolean(options.allowMissingPtk === true || (ptkConfig.allowMissing === true && !(options.requirePtkBridge === true || ptkConfig.requireBridge === true || options.requirePtkFindingsExport === true || ptkConfig.requireFindingsExport === true)))
    },
    lifecycle,
    validity,
    bridge: ptk && ptk.bridge || null,
    exported: Boolean(ptk && ptk.exported),
    collected: Boolean(ptk && ptk.collected),
    counts: ptk && ptk.counts || null,
    findings: ptk && ptk.findings ? {
      count: ptk.findings.count || ptk.findings.findingsCount || 0,
      bySeverity: ptk.findings.bySeverity || {},
      byEngine: ptk.findings.byEngine || {},
      truncated: Boolean(ptk.findings.truncated)
    } : null,
    reason: ptk && ptk.reason || validity.reason || null
  };
}

function createPtkLifecycleNormalized(ptkLifecycle = {}) {
  const lifecycle = ptkLifecycle.lifecycle || {};
  const validity = ptkLifecycle.validity || {};
  const exportBeforeStopAttempted = lifecycle.exportBeforeStopAttempted !== undefined
    ? Boolean(lifecycle.exportBeforeStopAttempted)
    : isPreStopExportStage(lifecycle.exportAttemptStage);
  const exportBeforeStopSucceeded = lifecycle.exportBeforeStopSucceeded !== undefined
    ? Boolean(lifecycle.exportBeforeStopSucceeded)
    : isPreStopExportStage(lifecycle.exportAttemptStage) && Boolean(lifecycle.exportSucceeded);
  return {
    schemaVersion: 'ptk-agent-v2-ptk-lifecycle-normalized',
    generatedAt: ptkLifecycle.generatedAt || new Date().toISOString(),
    status: ptkLifecycle.status || null,
    sessionId: lifecycle.lookupDiagnostics && lifecycle.lookupDiagnostics.requestedSessionId || null,
    scanStarted: Boolean(ptkLifecycle.scanStarted || lifecycle.scanStarted),
    scanStopped: Boolean(ptkLifecycle.scanStopped || lifecycle.scanStopped),
    bridgeDetected: Boolean(ptkLifecycle.bridgeDetected || lifecycle.bridgeDetected),
    enabledEngines: Array.isArray(lifecycle.engineSelectionRequested) ? lifecycle.engineSelectionRequested : [],
    engineStates: lifecycle.attackCompletion && lifecycle.attackCompletion.engines || {},
    rawStatusSamples: Array.isArray(lifecycle.rawStatusSamples) ? lifecycle.rawStatusSamples : [],
    drainState: lifecycle.drain && lifecycle.drain.status || null,
    drainSource: lifecycle.drain && lifecycle.drain.classification || null,
    completionCounters: lifecycle.attackCompletion || null,
    exportBeforeStop: exportBeforeStopAttempted,
    exportBeforeStopAttempted,
    exportBeforeStopSucceeded,
    exportRecoveredAfterStop: Boolean(lifecycle.exportRecoveredAfterStop || ptkLifecycle.exportRecoveredAfterStop),
    exportFailureBeforeStop: lifecycle.exportFailureBeforeStop !== undefined ? Boolean(lifecycle.exportFailureBeforeStop) : isPreStopExportStage(lifecycle.exportAttemptStage) && lifecycle.exportSucceeded === false,
    exportAttempts: Array.isArray(lifecycle.exportAttempts) ? lifecycle.exportAttempts : Array.isArray(ptkLifecycle.exportAttempts) ? ptkLifecycle.exportAttempts : [],
    exportAttemptStage: lifecycle.exportAttemptStage || ptkLifecycle.exportAttemptStage || null,
    exportLookupSource: lifecycle.exportLookupSource || ptkLifecycle.exportLookupSource || null,
    exportRetrievalResolved: Boolean(lifecycle.exportRetrievalResolved || ptkLifecycle.exportRetrievalResolved),
    findingsApiFallbackUsed: Boolean(lifecycle.findingsApiFallbackUsed || ptkLifecycle.findingsApiFallbackUsed),
    findingsExportValiditySource: lifecycle.findingsExportValiditySource || ptkLifecycle.findingsExportValiditySource || (validity.hasFindingsExport ? 'export' : 'none'),
    exportAttempted: ptkLifecycle.exportAttempted !== undefined ? Boolean(ptkLifecycle.exportAttempted) : Boolean(lifecycle.exportAttempted),
    exportSucceeded: Boolean(ptkLifecycle.exportSucceeded || lifecycle.exportSucceeded),
    exportFailureReason: validity.hasFindingsExport ? null : validity.reason || lifecycle.reason || ptkLifecycle.reason || null,
    safeToStop: Boolean(lifecycle.exportRetrievalResolved || ptkLifecycle.exportRetrievalResolved),
    inconsistencies: Array.isArray(lifecycle.inconsistencies) ? lifecycle.inconsistencies : []
  };
}

function isPreStopExportStage(stage) {
  return stage === 'before-stop' || stage === 'retry-status-page';
}

async function runCrawler(cliOptions = {}) {
  return runPtkAgent({
    ...cliOptions,
    throwOnError: cliOptions.throwOnError !== undefined ? cliOptions.throwOnError : true
  });
}

function runDryRun(options = {}) {
  return runPtkAgent({
    ...options,
    dryRun: true,
    throwOnError: options.throwOnError !== undefined ? options.throwOnError : false
  });
}

module.exports = {
  createPtkLifecycle,
  determineTerminalStatus,
  isSuccessfulStatus,
  requiredPtkStatus,
  ptkAttackCompletionIncomplete,
  runCrawler,
  runDryRun,
  resolveRuntimeModules,
  serializeRunError,
  runPtkAgent
};
