'use strict';

const fs = require('fs');
const path = require('path');
const { runPtkAgent } = require('../core/runner.cjs');
const { compareRunArtifacts } = require('../core/comparison.cjs');
const { ARTIFACT_FILENAMES, appendJsonl, ensureDir, writeJson } = require('../core/artifacts.cjs');
const { findingFingerprints } = require('../agent/actionEffectRecorder.cjs');
const { evaluateFindingQualityGate } = require('./findingQualityGate.cjs');

const PLACEHOLDER_USERNAME = 'YOUR_USERNAME';
const PLACEHOLDER_PASSWORD = 'YOUR_PASSWORD';
const BENCHMARK_ENGINE_IDS = Object.freeze(['dast', 'iast', 'sast']);
const BENCHMARK_ENGINE_NAMES = Object.freeze(BENCHMARK_ENGINE_IDS.map(engine => engine.toUpperCase()));

function defaultMatrix(options = {}) {
  const root = options.rootDir || path.resolve(__dirname, '../..');
  return {
    generatedAt: new Date().toISOString(),
    scenarioMode: normalizeScenarioMode(options.scenarioMode),
    scenarioVariants: scenarioVariants(options),
    targets: filterTargets([
      {
        id: 'juice-shop',
        url: options.juiceUrl || 'http://localhost:3001/',
        scenario: path.join(root, 'docs/scenario_juice_shop.md'),
        executableScenario: path.join(root, 'benchmarks/juice-shop/scenario.json'),
        authScenario: path.join(root, 'benchmarks/juice-shop/auth.json'),
        username: options.juiceUsername || PLACEHOLDER_USERNAME,
        password: options.juicePassword || PLACEHOLDER_PASSWORD
      },
      {
        id: 'testfire',
        url: options.testfireUrl || 'http://localhost:88/',
        scenario: path.join(root, 'docs/scenario_demo.testfire.net.md'),
        executableScenario: path.join(root, 'benchmarks/testfire/scenario.json'),
        authScenario: path.join(root, 'benchmarks/testfire/auth.json'),
        username: options.testfireUsername || PLACEHOLDER_USERNAME,
        password: options.testfirePassword || PLACEHOLDER_PASSWORD
      },
      {
        id: 'brokencrystals',
        url: options.brokencrystalsUrl || 'https://brokencrystals.com/',
        scenario: path.join(root, 'docs/scenario_brokencrystals.md'),
        executableScenario: path.join(root, 'benchmarks/brokencrystals/scenario.json'),
        authScenario: path.join(root, 'benchmarks/brokencrystals/auth.json'),
        routeHintsFile: path.join(root, 'benchmarks/brokencrystals/route-hints.json'),
        username: options.brokencrystalsUsername || PLACEHOLDER_USERNAME,
        password: options.brokencrystalsPassword || PLACEHOLDER_PASSWORD
      }
    ], options.targets),
    engines: BENCHMARK_ENGINE_NAMES.slice(),
    modes: [
      { id: 'no-agent', agentMode: 'off' },
      ...agentModes(options)
    ]
  };
}

function agentModes(options = {}) {
  if (['none', 'off', 'no-agent'].includes(String(options.agentProvider || '').toLowerCase())) return [];
  if (String(options.agentProvider || '').toLowerCase() === 'mock') {
    return [{
      id: 'agent-mock',
      agentMode: 'mock',
      agentProvider: 'mock',
      agentModel: null
    }];
  }
  if (options.agentProvider === 'all') {
    return [
      {
        id: makeAgentModeId('opencode', options.opencodeModel || 'opencode/big-pickle'),
        agentMode: 'browser',
        agentProvider: 'opencode',
        agentModel: options.opencodeModel || 'opencode/big-pickle'
      },
      {
        id: makeAgentModeId('codex', options.codexModel || 'gpt-5.3-codex-spark'),
        agentMode: 'browser',
        agentProvider: 'codex',
        agentModel: options.codexModel || 'gpt-5.3-codex-spark'
      }
    ];
  }
  const provider = options.agentProvider || 'opencode';
  const model = options.agentModel || (provider === 'codex'
    ? options.codexModel || 'gpt-5.3-codex-spark'
    : options.opencodeModel || 'opencode/big-pickle');
  return [{
    id: options.agentModeId || makeAgentModeId(provider, model),
    agentMode: 'browser',
    agentProvider: provider,
    agentModel: model
  }];
}

function filterTargets(targets, requested) {
  const requestedIds = normalizeTargetList(requested);
  if (!requestedIds) return targets;
  const known = new Map(targets.map(target => [target.id, target]));
  const missing = requestedIds.filter(id => !known.has(id));
  if (missing.length > 0) {
    throw new Error(`Unsupported benchmark target(s): ${missing.join(', ')}. Supported targets: ${targets.map(target => target.id).join(', ')}`);
  }
  return requestedIds.map(id => known.get(id));
}

function normalizeTargetList(value) {
  if (value === undefined || value === null || value === '') return null;
  const aliases = new Map([
    ['juice', 'juice-shop'],
    ['juice-shop', 'juice-shop'],
    ['juiceshop', 'juice-shop'],
    ['testfire', 'testfire'],
    ['test-fire', 'testfire'],
    ['altoro', 'testfire'],
    ['brokencrystals', 'brokencrystals'],
    ['broken-crystals', 'brokencrystals'],
    ['brokencrystal', 'brokencrystals']
  ]);
  const source = Array.isArray(value) ? value : String(value).split(',');
  const ids = [];
  for (const item of source) {
    const key = String(item || '').trim().toLowerCase();
    if (!key) continue;
    const resolved = aliases.get(key) || key;
    if (!ids.includes(resolved)) ids.push(resolved);
  }
  return ids.length > 0 ? ids : null;
}

async function runBenchmarkMatrix(options = {}) {
  const root = options.rootDir || path.resolve(__dirname, '../..');
  const cwd = path.resolve(options.cwd || process.cwd());
  const executePtkAgent = typeof options.runPtkAgent === 'function'
    ? options.runPtkAgent
    : runPtkAgent;
  const outputDir = path.resolve(cwd, options.outputDir || path.join('.ptk/matrix', timestamp()));
  ensureDir(outputDir);
  const matrix = defaultMatrix({ ...options, rootDir: root });
  const results = [];
  for (const target of matrix.targets) {
    for (const scenarioVariant of matrix.scenarioVariants) {
      const scenarioResolution = scenarioFileForVariant(target, scenarioVariant, options);
      const scenarioFile = scenarioResolution.file;
      let baselineResult = null;
      for (const mode of matrix.modes) {
      const runId = `${target.id}-${scenarioVariant.id}-${mode.id}`;
      const runOutputDir = path.join(outputDir, runId);
      prepareMatrixRunOutputDir(runOutputDir);
      const startedAt = new Date().toISOString();
      const inlineConfig = buildBenchmarkInlineConfig(target, options);
      writeRowLifecycle(runOutputDir, 'row_started', {
        target: target.id,
        mode: mode.id,
        scenarioVariant: scenarioVariant.id,
        scenarioSetup: scenarioResolution.setup
      });
      const baselineGate = providerBaselineGate({
        mode,
        baseline: baselineResult,
        scenarioResolution,
        options
      });
      if (baselineGate.skip) {
        const skip = baselineGateSkipResult(baselineGate.reason);
        writeRowLifecycle(runOutputDir, 'row_skipped', {
          status: skip.status,
          reason: baselineGate.reason,
          agentSkipReason: skip.agentSkipReason
        });
        writeRowLifecycle(runOutputDir, 'row_finalized', {
          status: skip.status,
          reason: baselineGate.reason,
          agentSkipReason: skip.agentSkipReason
        });
        const row = buildMatrixResult({
          root,
          target,
          mode,
          scenarioVariant,
          scenarioResolution,
          scenarioFile,
          startedAt,
          result: skippedRunResult({
            status: skip.status,
            reason: baselineGate.reason,
            runOutputDir,
            agentSkipReason: skip.agentSkipReason
          }),
          baseline: baselineResult,
          rowFinalizationStatus: skip.rowFinalizationStatus
        });
        results.push(row);
        continue;
      }
      if (scenarioResolution.error) {
        const status = scenarioResolution.error;
        writeRowLifecycle(runOutputDir, 'row_finalized', {
          status,
          reason: scenarioResolution.error,
          scenarioSetup: scenarioResolution.setup
        });
        const row = buildMatrixResult({
          root,
          target,
          mode,
          scenarioVariant,
          scenarioResolution,
          scenarioFile,
          startedAt,
          result: skippedRunResult({
            status,
            reason: scenarioResolution.error,
            runOutputDir
          }),
          rowFinalizationStatus: `finalized_${status}`
        });
        results.push(row);
        if (mode.id === 'no-agent') baselineResult = row;
        continue;
      }
      const credentialPreflight = credentialPreflightForMatrixRow({
        target,
        mode,
        scenarioVariant,
        scenarioResolution
      });
      if (!credentialPreflight.ok) {
        writeJson(runOutputDir, ARTIFACT_FILENAMES.authPreflight, credentialPreflight);
        writeRowLifecycle(runOutputDir, 'row_finalized', {
          status: 'invalid_auth_credentials_missing',
          reason: credentialPreflight.classification
        });
        const row = buildMatrixResult({
          root,
          target,
          mode,
          scenarioVariant,
          scenarioResolution,
          scenarioFile,
          startedAt,
          result: skippedRunResult({
            status: 'invalid_auth_credentials_missing',
            reason: credentialPreflight.classification,
            authPreflight: credentialPreflight,
            runOutputDir
          }),
          authPreflight: summarizeAuthPreflight(credentialPreflight),
          rowFinalizationStatus: 'finalized_invalid_auth'
        });
        results.push(row);
        if (mode.id === 'no-agent') baselineResult = row;
        continue;
      }
      let result;
      try {
        writeRowLifecycle(runOutputDir, 'runner_started', {
          target: target.id,
          mode: mode.id
        });
        result = await executePtkAgent({
          cwd,
          url: target.url,
          scenario: scenarioFile,
          scenarioEnabled: Boolean(scenarioFile),
          username: target.username,
          password: target.password,
          includeSecrets: false,
          outputDir: runOutputDir,
          maxRoutes: options.maxRoutes,
          maxDepth: options.crawlDepth,
          maxRouteMs: options.maxRouteMs,
          maxActionMs: options.maxActionMs,
          maxActionsPerRoute: options.maxActionsPerRoute,
          maxFormsPerRoute: options.maxFormsPerRoute,
          maxObservationMs: options.maxObservationMs,
          maxProviderMs: options.maxProviderMs || 60000,
          scenarioContinueOnFailure: options.scenarioContinueOnFailure !== false,
          requirePtkBridge: options.allowMissingPtk === true ? false : options.requirePtkBridge !== false,
          requirePtkFindingsExport: options.allowMissingPtk === true ? false : options.requirePtkFindingsExport !== false,
          ptkDrainMode: options.ptkDrainMode,
          ptkDrainTimeoutMs: options.ptkDrainTimeoutMs,
          waitForPtkComplete: options.waitForPtkComplete,
          requirePtkAttackCompletion: options.requirePtkAttackCompletion,
          allowMissingPtk: options.allowMissingPtk === true,
          ptkExtensionDir: options.ptkExtensionDir,
          inlineConfig,
          requestedEngines: BENCHMARK_ENGINE_NAMES.slice(),
          agentMode: mode.agentMode,
          agentProvider: mode.agentProvider,
          agentModel: mode.agentModel,
          scenarioVariant: scenarioVariant.id,
          scenarioSetup: scenarioResolution.setup,
          throwOnError: false,
          quiet: true
        });
        writeRowLifecycle(runOutputDir, 'runner_completed', {
          status: result && result.status || null,
          ok: Boolean(result && result.ok)
        });
      } catch (err) {
        result = {
          ok: false,
          status: 'failed',
          error: { message: err.message, code: err.code || null },
          telemetry: null,
          coverage: null,
          artifacts: null
        };
        writeRowLifecycle(runOutputDir, 'runner_failed', {
          error: err.message,
          code: err.code || null
        });
      }
      writeRowLifecycle(runOutputDir, 'row_finalized', {
        status: result && result.status || 'failed',
        ok: Boolean(result && result.ok)
      });
      attachFindingQualityGate({
        target,
        result,
        runOutputDir
      });
      const row = buildMatrixResult({
        root,
        target,
        mode,
        scenarioVariant,
        scenarioResolution,
        scenarioFile,
        startedAt,
        result,
        baseline: baselineResult,
        rowFinalizationStatus: 'finalized'
      });
      results.push(row);
      if (mode.id === 'no-agent') baselineResult = row;
      }
    }
  }
  const comparisons = compareMatrixResults(results);
  const artifact = {
    version: 'ptk-agent-test-matrix',
    generatedAt: new Date().toISOString(),
    outputDir,
    matrix,
    results,
    comparisons
  };
  writeJson(outputDir, 'test-matrix.json', artifact, { redact: true });
  fs.writeFileSync(path.join(outputDir, 'test-matrix.md'), renderMatrixMarkdown(artifact), 'utf8');
  return artifact;
}

function attachFindingQualityGate({ target = {}, result = {}, runOutputDir = null } = {}) {
  if (!result || !result.coverage) return null;
  const gate = evaluateFindingQualityGate({
    targetId: target.id,
    coverage: result.coverage
  });
  if (!gate.applicable) return gate;
  result.findingQualityGate = gate;
  if (runOutputDir) {
    const filePath = writeJson(runOutputDir, ARTIFACT_FILENAMES.findingQualityGate, gate, { redact: true });
    result.artifacts = { ...(result.artifacts || {}), findingQualityGate: filePath };
  }
  return gate;
}

function buildMatrixResult({
  root,
  target,
  mode,
  scenarioVariant,
  scenarioResolution,
  scenarioFile,
  startedAt,
  result = {},
  baseline = null,
  authPreflight = null,
  rowFinalizationStatus = null
} = {}) {
  const coverageAuthPreflight = summarizeAuthPreflight(result.coverage && result.coverage.authPreflight);
  const effectiveAuthPreflight = authPreflight || coverageAuthPreflight;
  const agent = result.result && result.result.agent || result.agent || null;
  const agentFailureReason = agentComparisonStopReason({ ...result, agent });
  const providerTimedOut = isProviderTimeoutReason(agentFailureReason, result && result.error);
  const postBaselineTimedOut = isPostBaselineTimeoutReason(agentFailureReason, result && (result.status || result.error));
  return {
    target: target.id,
    mode: mode.id,
    scenario: scenarioVariant.label,
    scenarioVariant: scenarioVariant.id,
    scenarioSetup: scenarioResolution.setup,
    authenticatedSetup: scenarioResolution.setup === 'auth-only',
    scenarioFile: scenarioFile ? path.relative(root, scenarioFile) : null,
    url: target.url,
    startedAt,
    endedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    status: result.status,
    error: result.error && (result.error.message || String(result.error)),
    telemetry: summarizeTelemetry(result.telemetry),
    coverageSummary: summarizeCoverage(result.coverage),
    scenarioStatus: summarizeScenario(result.coverage),
    baselineScenarioStatus: baseline && baseline.scenarioStatus && baseline.scenarioStatus.status || null,
    baselineScenarioFailureReason: baseline && baseline.scenarioStatus && baseline.scenarioStatus.failureReason || baseline && baseline.authFailureReason || null,
    authPreflight: effectiveAuthPreflight,
    authFailureReason: effectiveAuthPreflight && effectiveAuthPreflight.ok === false
      ? effectiveAuthPreflight.classification || effectiveAuthPreflight.reason || null
      : null,
    ptkValidity: summarizePtkValidity(result),
    ptkBridge: summarizePtkBridge(result),
    ptkLifecycle: summarizePtkLifecycle(result),
    findings: summarizePtkFindings(result),
    findingQualityGate: summarizeFindingQualityGate(result.findingQualityGate),
    durationMs: summarizeDurationMs(result, startedAt),
    artifacts: result.artifacts,
    agent: summarizeAgentForMatrix(agent),
    agentEffectiveMaxTurns: result.config && result.config.agent && result.config.agent.maxTurns || agent && agent.effectiveMaxTurns || null,
    agentFailureReason,
    providerTimedOut,
    postBaselineTimedOut,
    rowFinalizationStatus
  };
}

function summarizeTelemetry(telemetry = null) {
  if (!telemetry || typeof telemetry !== 'object') return telemetry || null;
  return {
    runId: telemetry.runId || null,
    requestedMode: telemetry.requestedMode || telemetry.mode && telemetry.mode.requestedMode || null,
    actualMode: telemetry.actualMode || telemetry.mode && telemetry.mode.actualMode || null,
    startTime: telemetry.startTime || null,
    endTime: telemetry.endTime || null,
    durationMs: telemetry.durationMs || telemetry.totalDurationMs || null,
    eventCount: Array.isArray(telemetry.events) ? telemetry.events.length : undefined
  };
}

function summarizeAgentForMatrix(agent = null) {
  if (!agent || typeof agent !== 'object') return agent || null;
  return {
    status: agent.status || null,
    actual: agent.actual || null,
    requested: agent.requested || null,
    effectiveMaxTurns: agent.effectiveMaxTurns || null,
    telemetry: agent.telemetry ? {
      actualMode: agent.telemetry.actualMode || null,
      stopReason: agent.telemetry.stopReason || null,
      fallbackReason: agent.telemetry.fallbackReason || null
    } : null,
    turns: Array.isArray(agent.turns) ? agent.turns.map(turn => ({
      turn: turn.turn || turn.index || null,
      provider: turn.provider || null,
      missionId: turn.missionId || turn.choice && turn.choice.missionId || null,
      status: turn.status || null,
      stopReason: turn.stopReason || null
    })) : [],
    choices: Array.isArray(agent.choices) ? agent.choices.map(choice => ({
      provider: choice.provider || null,
      missionId: choice.missionId || null,
      reason: choice.reason || null,
      code: choice.code || null
    })) : [],
    executionResults: Array.isArray(agent.executionResults) ? agent.executionResults.map(result => ({
      missionId: result.missionId || null,
      kind: result.kind || null,
      status: result.status || null,
      ok: result.ok !== undefined ? Boolean(result.ok) : undefined,
      browserActionRan: Boolean(result.browserActionRan),
      transitionValidated: Boolean(result.transitionValidated)
    })) : [],
    coverageDelta: agent.coverageDelta || null,
    baselinePreservation: agent.baselinePreservation || null,
    findingFingerprintDiff: agent.findingFingerprintDiff || null,
    riskPolicy: agent.riskPolicy || null,
    providerDecisionQuality: agent.providerDecisionQuality ? {
      status: agent.providerDecisionQuality.status || null,
      reason: agent.providerDecisionQuality.reason || null,
      decisions: Array.isArray(agent.providerDecisionQuality.decisions) ? agent.providerDecisionQuality.decisions.length : undefined
    } : null,
    missionCount: Array.isArray(agent.missions) ? agent.missions.length : 0
  };
}

function skippedRunResult({
  status,
  reason,
  authPreflight = null,
  runOutputDir = null,
  agentSkipReason = null
} = {}) {
  const artifacts = {};
  if (runOutputDir && authPreflight) artifacts.authPreflight = path.join(runOutputDir, ARTIFACT_FILENAMES.authPreflight);
  const agent = agentSkipReason ? {
    status: 'skipped',
    telemetry: { stopReason: agentSkipReason },
    coverageDelta: {
      total: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, findings: 0 }
    },
    baselinePreservation: {
      agentAddedRoutes: 0,
      agentAddedFindings: 0,
      agentFailureAffectedBaseline: false
    }
  } : null;
  return {
    ok: false,
    status,
    error: reason ? { message: reason } : null,
    telemetry: null,
    coverage: authPreflight ? { authPreflight } : null,
    artifacts,
    result: agent ? { agent } : null
  };
}

function prepareMatrixRunOutputDir(runOutputDir) {
  if (!runOutputDir) return null;
  fs.rmSync(runOutputDir, { recursive: true, force: true });
  ensureDir(runOutputDir);
  return runOutputDir;
}

function writeRowLifecycle(outputDir, type, details = {}) {
  if (!outputDir || !type) return null;
  return appendJsonl(outputDir, ARTIFACT_FILENAMES.rowLifecycleEvents, {
    schemaVersion: 'ptk-agent-v2-benchmark-row-lifecycle',
    timestamp: new Date().toISOString(),
    type,
    ...details
  });
}

function credentialPreflightForMatrixRow({ target = {}, mode = {}, scenarioVariant = {}, scenarioResolution = {} } = {}) {
  const requiresCredentials = Boolean(scenarioResolution.file && scenarioResolution.setup !== 'none');
  const base = {
    schemaVersion: 'ptk-agent-v2-auth-preflight',
    generatedAt: new Date().toISOString(),
    target: target.id || null,
    url: target.url || null,
    scenarioVariant: scenarioVariant.id || null,
    scenarioSetup: scenarioResolution.setup || null,
    mode: mode.id || null,
    attempts: []
  };
  if (!requiresCredentials) {
    return {
      ...base,
      ok: true,
      classification: 'not_required',
      retryable: false,
      summary: {
        status: 'not_required',
        reason: null
      }
    };
  }
  const missingFields = [];
  if (isMissingOrPlaceholderCredential(target.username, PLACEHOLDER_USERNAME)) missingFields.push('username');
  if (isMissingOrPlaceholderCredential(target.password, PLACEHOLDER_PASSWORD)) missingFields.push('password');
  if (missingFields.length > 0) {
    return {
      ...base,
      ok: false,
      classification: 'credentials_missing_or_placeholder',
      retryable: false,
      redactedEvidence: {
        missingFields,
        usernameProvided: Boolean(target.username && !isMissingOrPlaceholderCredential(target.username, PLACEHOLDER_USERNAME)),
        passwordProvided: Boolean(target.password && !isMissingOrPlaceholderCredential(target.password, PLACEHOLDER_PASSWORD))
      },
      summary: {
        status: 'invalid',
        reason: 'credentials_missing_or_placeholder',
        missingFields
      }
    };
  }
  return {
    ...base,
    ok: true,
    classification: 'credentials_available',
    retryable: false,
    summary: {
      status: 'ok',
      reason: null
    }
  };
}

function isMissingOrPlaceholderCredential(value, placeholder) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  if (!text) return true;
  return text === placeholder;
}

function summarizeAuthPreflight(authPreflight = null) {
  if (!authPreflight || typeof authPreflight !== 'object') return null;
  if (typeof authPreflight.ok === 'boolean' || authPreflight.classification) {
    return {
      ok: authPreflight.ok !== false,
      classification: authPreflight.classification || authPreflight.summary && authPreflight.summary.reason || null,
      reason: authPreflight.summary && authPreflight.summary.reason || authPreflight.classification || null,
      retryable: Boolean(authPreflight.retryable),
      summary: authPreflight.summary || null
    };
  }
  const attempts = Array.isArray(authPreflight.attempts) ? authPreflight.attempts : [];
  const failedAttempt = attempts.find(attempt => attempt && attempt.classification && attempt.classification !== 'authenticated') || null;
  const authenticated = attempts.some(attempt => attempt && attempt.classification === 'authenticated');
  return {
    ok: attempts.length === 0 ? null : authenticated && !failedAttempt,
    classification: failedAttempt ? failedAttempt.classification : authenticated ? 'authenticated' : null,
    reason: failedAttempt ? failedAttempt.classification : null,
    retryable: failedAttempt ? Boolean(failedAttempt.retryable) : false,
    summary: authPreflight.summary || null
  };
}

function providerBaselineGate({ mode = {}, baseline = null, scenarioResolution = {}, options = {} } = {}) {
  if (mode.id === 'no-agent') return { skip: false, reason: null };
  if (options.agentAllowScenarioUnblock === true) return { skip: false, reason: null };
  if (!baseline) return { skip: true, reason: 'baseline_missing' };
  if (baseline.status === 'invalid_auth_credentials_missing' || baseline.authPreflight && baseline.authPreflight.ok === false) {
    return { skip: true, reason: 'baseline_auth_invalid' };
  }
  const scenario = baseline.scenarioStatus || null;
  const scenarioWasExpected = Boolean(scenarioResolution.file && scenarioResolution.setup !== 'none');
  if (scenarioWasExpected && scenario && scenario.ok === false) {
    return { skip: true, reason: 'baseline_scenario_failed' };
  }
  if (scenarioWasExpected && baseline.ok === false && /scenario_failed|auth/i.test(String(baseline.status || baseline.error || ''))) {
    return { skip: true, reason: 'baseline_scenario_failed' };
  }
  return { skip: false, reason: null };
}

function baselineGateSkipResult(reason) {
  if (reason === 'baseline_auth_invalid') {
    return {
      status: 'skipped_invalid_auth',
      agentSkipReason: 'invalid_auth',
      rowFinalizationStatus: 'finalized_skipped_invalid_auth'
    };
  }
  if (reason === 'baseline_missing') {
    return {
      status: 'skipped_baseline_missing',
      agentSkipReason: 'baseline_missing',
      rowFinalizationStatus: 'finalized_skipped_baseline_missing'
    };
  }
  return {
    status: 'skipped_baseline_scenario_failed',
    agentSkipReason: 'baseline_scenario_failed',
    rowFinalizationStatus: 'finalized_skipped_baseline_scenario_failed'
  };
}

function scenarioFileForVariant(target = {}, scenarioVariant = {}, options = {}) {
  if (scenarioVariant.file !== false) {
    if (target.executableScenario) {
      return {
        file: target.executableScenario,
        setup: 'explicit-json',
        descriptionFile: target.scenario || null
      };
    }
    return {
      file: null,
      setup: 'explicit-json-missing',
      descriptionFile: target.scenario || null,
      error: 'executable_scenario_missing'
    };
  }
  if (options.authenticated === false || options.authSetup === false) {
    return { file: null, setup: 'none' };
  }
  if (target.authScenario) {
    return { file: target.authScenario, setup: 'auth-only' };
  }
  return { file: null, setup: 'none' };
}

function buildBenchmarkInlineConfig(target = {}, options = {}) {
  const base = clonePlainObject(options.inlineConfig || options.configObject || {});
  const benchmarkConfig = {
    engines: benchmarkEngineConfig(),
    crawler: {},
    agent: benchmarkAgentConfig(options)
  };
  if (target.routeHintsFile) benchmarkConfig.crawler.routeHintsFile = target.routeHintsFile;
  return deepMerge(base, benchmarkConfig);
}

function benchmarkAgentConfig(options = {}) {
  const config = {};
  const maxTurns = Number(options.maxAgentTurns);
  if (Number.isFinite(maxTurns) && maxTurns > 0) {
    config.maxTurns = Math.floor(maxTurns);
  } else if (options.agentProvider && !['none', 'off', 'no-agent'].includes(String(options.agentProvider).toLowerCase())) {
    config.maxTurns = 3;
  }
  if (options.allowDestructiveActions === true) {
    config.riskMode = 'destructive';
    config.allowBusinessMutations = true;
    config.allowDestructiveActions = true;
  } else if (options.aggressive === true || options.allowBusinessMutations === true) {
    config.riskMode = 'business';
    config.allowBusinessMutations = true;
    config.allowDestructiveActions = false;
  }
  if (options.requireAgentSuccess !== undefined) config.requireSuccess = Boolean(options.requireAgentSuccess);
  return config;
}

function benchmarkEngineConfig() {
  return {
    dast: { enabled: true, modulePacks: ['free'] },
    iast: { enabled: true, modulePacks: ['free'] },
    sast: { enabled: true, modulePacks: ['free'] },
    sca: { enabled: false, modulePacks: [] }
  };
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, overrides) {
  const out = clonePlainObject(base);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeScenarioMode(value) {
  const mode = String(value || 'explicit').toLowerCase();
  if (['explicit', 'scenario'].includes(mode)) return 'explicit';
  if (['none', 'no-scenario', 'without-scenario'].includes(mode)) return 'none';
  if (['all', 'both'].includes(mode)) return 'all';
  throw new Error(`Unsupported benchmark scenario mode: ${value}`);
}

function scenarioVariants(options = {}) {
  const mode = normalizeScenarioMode(options.scenarioMode);
  if (mode === 'explicit') return [{ id: 'scenario', label: 'explicit', file: true }];
  if (mode === 'none') return [{ id: 'no-scenario', label: 'none', file: false }];
  return [
    { id: 'scenario', label: 'explicit', file: true },
    { id: 'no-scenario', label: 'none', file: false }
  ];
}

function summarizeScenario(coverage = {}) {
  const scenario = coverage && coverage.scenario;
  if (!scenario) return null;
  return {
    status: scenario.status || (scenario.ok ? 'completed' : 'failed'),
    ok: Boolean(scenario.ok),
    completedSteps: scenario.completedSteps || scenario.completed || 0,
    totalSteps: scenario.totalSteps || 0,
    failedStep: scenario.failedStep || scenario.failedStepId || null,
    failureReason: scenario.failureReason || scenario.blockedSteps && scenario.blockedSteps[0] && scenario.blockedSteps[0].reason || null
  };
}

function summarizeCoverage(coverage = {}) {
  if (!coverage) return null;
  if (coverage.summary) return coverage.summary;
  return {
    routesVisited: Array.isArray(coverage.routes) ? coverage.routes.length : 0,
    routeShapes: Array.isArray(coverage.routeShapes) ? coverage.routeShapes.length : 0,
    endpointsObserved: Array.isArray(coverage.endpoints) ? coverage.endpoints.length : 0,
    formsDiscovered: Array.isArray(coverage.forms) ? coverage.forms.length : 0,
    actionsDiscovered: Array.isArray(coverage.actions) ? coverage.actions.length : 0
  };
}

function summarizePtkValidity(result = {}) {
  const ptk = result.coverage && result.coverage.ptk;
  const lifecycle = ptk && (ptk.validity || ptk.evidence && ptk.evidence.validity);
  return lifecycle || {
    valid: false,
    status: result.status === 'invalid_no_findings_export' ? 'invalid_no_findings_export' : 'invalid_no_ptk_bridge',
    hasPtkBridge: false,
    hasFindingsExport: false,
    findingsCount: 0,
    reason: result.status || 'not_collected'
  };
}

function summarizePtkBridge(result = {}) {
  const ptk = result.coverage && result.coverage.ptk;
  const bridge = ptk && ptk.bridge;
  if (!bridge) {
    return {
      available: Boolean(ptk && ptk.available),
      source: null,
      reason: ptk && ptk.reason || null
    };
  }
  return {
    available: Boolean(bridge.available),
    source: bridge.source || null,
    methods: Array.isArray(bridge.methods) ? bridge.methods.slice() : [],
    reason: bridge.reason || null
  };
}

function summarizePtkFindings(result = {}) {
  const artifactSummary = readFindingsCountSummary(result);
  if (artifactSummary) return artifactSummary;

  const ptk = result.coverage && result.coverage.ptk;
  const findings = ptk && ptk.findings;
  const uniqueFindings = findingFingerprints(result.coverage || {}).length;
  if (!findings) {
    const validity = summarizePtkValidity(result);
    return {
      count: validity.findingsCount || 0,
      uniqueFindings,
      bySeverity: {},
      byEngine: {},
      truncated: false
    };
  }
  return {
    count: findings.count || findings.findingsCount || 0,
    uniqueFindings,
    bySeverity: findings.bySeverity || {},
    byEngine: findings.byEngine || {},
    truncated: Boolean(findings.truncated)
  };
}

function readFindingsCountSummary(result = {}) {
  const artifactPath = result.artifacts && result.artifacts.ptkFindingsCount;
  if (!artifactPath || typeof artifactPath !== 'string') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const findingsCount = Number(parsed.findingsCount || parsed.count || 0) || 0;
    const uniqueFindings = Number(parsed.uniqueFindings || parsed.unique || findingsCount) || 0;
    return {
      count: findingsCount,
      uniqueFindings,
      bySeverity: parsed.bySeverity || {},
      byEngine: parsed.byEngine || {},
      truncated: Boolean(parsed.truncated)
    };
  } catch (_) {
    return null;
  }
}

function summarizeFindingQualityGate(gate = null) {
  if (!gate || typeof gate !== 'object') return null;
  return {
    applicable: Boolean(gate.applicable),
    status: gate.status || (gate.applicable ? gate.passed ? 'passed' : 'failed' : 'not_applicable'),
    passed: typeof gate.passed === 'boolean' ? gate.passed : null,
    missing: Array.isArray(gate.missing) ? gate.missing.slice() : [],
    requiredCount: Array.isArray(gate.required) ? gate.required.length : 0,
    satisfiedCount: Array.isArray(gate.required) ? gate.required.filter(item => item && item.satisfied).length : 0
  };
}

function summarizePtkLifecycle(result = {}) {
  const ptk = result.coverage && result.coverage.ptk || null;
  const lifecycle = ptk && ptk.lifecycle || {};
  const engineSummary = summarizePtkEngineStates(lifecycle);
  const inconsistencies = Array.isArray(lifecycle.inconsistencies) ? lifecycle.inconsistencies.slice() : [];
  const exportFailureReason = lifecycle.exportSucceeded === false
    ? lifecycle.reason || lifecycle.exportFailureReason || ptk && ptk.reason || null
    : null;
  const exportBeforeStopAttempted = lifecycle.exportBeforeStopAttempted !== undefined
    ? Boolean(lifecycle.exportBeforeStopAttempted)
    : isPreStopExportStage(lifecycle.exportAttemptStage) && (lifecycle.exportAttempted !== false);
  const exportBeforeStopSucceeded = lifecycle.exportBeforeStopSucceeded !== undefined
    ? Boolean(lifecycle.exportBeforeStopSucceeded)
    : isPreStopExportStage(lifecycle.exportAttemptStage) && Boolean(lifecycle.exportSucceeded);
  return {
    lifecycleStatus: summarizePtkLifecycleStatus(lifecycle, ptk),
    scanStarted: Boolean(lifecycle.scanStarted),
    exported: Boolean(lifecycle.exportSucceeded || ptk && ptk.exported),
    exportAttempted: lifecycle.exportAttempted !== undefined ? Boolean(lifecycle.exportAttempted) : Boolean(ptk),
    exportBeforeStop: exportBeforeStopAttempted,
    exportBeforeStopAttempted,
    exportBeforeStopSucceeded,
    exportRecoveredAfterStop: Boolean(lifecycle.exportRecoveredAfterStop || lifecycle.exportAttemptStage === 'after-stop' && lifecycle.exportSucceeded),
    exportFailureBeforeStop: lifecycle.exportFailureBeforeStop !== undefined
      ? Boolean(lifecycle.exportFailureBeforeStop)
      : isPreStopExportStage(lifecycle.exportAttemptStage) && lifecycle.exportSucceeded === false,
    ptkLookupSource: lifecycle.lookupDiagnostics && lifecycle.lookupDiagnostics.lookupSource || null,
    exportValiditySource: lifecycle.findingsExportValiditySource || ptk && ptk.evidence && ptk.evidence.findingsExportValiditySource || null,
    findingsApiFallbackUsed: Boolean(lifecycle.findingsApiFallbackUsed || ptk && ptk.evidence && ptk.evidence.findingsApiFallbackUsed),
    exportLookupSource: lifecycle.exportLookupSource || ptk && ptk.evidence && ptk.evidence.exportLookupSource || null,
    exportRetrievalResolved: Boolean(lifecycle.exportRetrievalResolved || ptk && ptk.evidence && ptk.evidence.exportRetrievalResolved),
    inconsistencies,
    ptkInconsistencies: inconsistencies,
    dastState: engineSummary.dastState,
    iastState: engineSummary.iastState,
    sastState: engineSummary.sastState,
    sastCollectionState: engineSummary.sastCollectionState,
    sastAnalysisState: engineSummary.sastAnalysisState,
    engineParticipation: engineSummary.engineParticipation,
    engineIncomplete: Boolean(engineSummary.engineIncomplete || lifecycle.drain && lifecycle.drain.classification === 'engine_incomplete'),
    exportFailureReason,
    scanStopped: Boolean(lifecycle.scanStopped),
    drain: lifecycle.drain || null,
    attackCompletion: lifecycle.attackCompletion || null,
    attackCancelled: attackCancelledCount(lifecycle.attackCompletion)
  };
}

function isPreStopExportStage(stage) {
  return stage === 'before-stop' || stage === 'retry-status-page';
}

function summarizePtkLifecycleStatus(lifecycle = {}, ptk = null) {
  if (!ptk) return 'not_collected';
  if (lifecycle.inconsistencies && lifecycle.inconsistencies.length) return 'inconsistent';
  if (lifecycle.exportSucceeded === false) return 'export_failed';
  if (lifecycle.drain && lifecycle.drain.timedOut) return 'drain_timeout';
  if (lifecycle.attackCompletion && lifecycle.attackCompletion.partial) return 'partial';
  if (lifecycle.scanStarted && lifecycle.exportSucceeded) return 'exported';
  if (lifecycle.scanStarted) return 'started';
  return 'unknown';
}

function summarizePtkEngineStates(lifecycle = {}) {
  const latestStatus = latestRawPtkStatus(lifecycle);
  const rawEngines = latestStatus && latestStatus.engines && typeof latestStatus.engines === 'object'
    ? latestStatus.engines
    : {};
  const completionEngines = lifecycle.attackCompletion && lifecycle.attackCompletion.engines || {};
  const engineState = (name) => {
    const raw = rawEngines[name.toUpperCase()] || rawEngines[name.toLowerCase()] || rawEngines[name] || null;
    const completion = completionEngines[name.toUpperCase()] || completionEngines[name.toLowerCase()] || completionEngines[name] || null;
    return engineStateLabel(raw, completion);
  };
  const sastRaw = rawEngines.SAST || rawEngines.sast || null;
  const sastCompletion = completionEngines.SAST || completionEngines.sast || null;
  const sastRuntime = engineRuntimeForMatrix(sastRaw) || {};
  const sastComplete = engineCompletionLooksComplete(sastCompletion);
  const staleActiveSastRuntime = sastRuntimeLooksActive(sastRuntime);
  const sastCollectionState = sastComplete
    ? (staleActiveSastRuntime ? 'completed' : stringOrNull(sastRuntime.collectionState))
    : stringOrNull(sastRuntime.collectionState);
  const sastAnalysisState = sastComplete
    ? (staleActiveSastRuntime ? 'complete' : stringOrNull(sastRuntime.analysisState))
    : stringOrNull(sastRuntime.analysisState);
  const activeSastCollection = /collection_pending|payload_received|analyzing|running/i.test(`${sastCollectionState || ''} ${sastAnalysisState || ''}`);
  const incomplete = Boolean(
    Object.values(completionEngines || {}).some(engine => engine && engine.partial === true)
    || lifecycle.drain && lifecycle.drain.timedOut && activeSastCollection
  );
  return {
    dastState: engineState('dast'),
    iastState: engineState('iast'),
    sastState: engineState('sast'),
    sastCollectionState,
    sastAnalysisState,
    engineParticipation: engineParticipationForMatrix(lifecycle, BENCHMARK_ENGINE_NAMES),
    engineIncomplete: incomplete
  };
}

function engineParticipationForMatrix(lifecycle = {}, engineNames = BENCHMARK_ENGINE_NAMES) {
  const result = {};
  const samples = Array.isArray(lifecycle.rawStatusSamples) ? lifecycle.rawStatusSamples : [];
  const completionEngines = lifecycle.attackCompletion && lifecycle.attackCompletion.engines || {};
  for (const engineName of engineNames) {
    const engine = String(engineName || '').toUpperCase();
    if (!engine) continue;
    result[engine] = {
      evidence: false,
      runningObserved: false,
      failedObserved: false,
      lastStatus: null,
      completionStatus: null
    };
  }

  for (const sample of samples) {
    const status = unwrapPtkStatus(sample && sample.status);
    const engines = status && status.engines && typeof status.engines === 'object' ? status.engines : {};
    for (const engine of Object.keys(result)) {
      const data = engines[engine] || engines[engine.toLowerCase()] || null;
      recordEngineParticipation(result[engine], data);
    }
  }

  for (const engine of Object.keys(result)) {
    const completion = completionEngines[engine] || completionEngines[engine.toLowerCase()] || null;
    if (completion) {
      result[engine].evidence = true;
      result[engine].completionStatus = engineCompletionStatusForMatrix(completion);
      if (completion.partial === true || Number(completion.cancelled || 0) > 0) {
        result[engine].failedObserved = true;
      }
    }
  }

  return result;
}

function recordEngineParticipation(summary, engineData = null) {
  if (!summary || !engineData || typeof engineData !== 'object') return;
  summary.evidence = true;
  const status = stringOrNull(engineData.status);
  const phase = stringOrNull(engineData.phase);
  if (status) summary.lastStatus = [status, phase].filter(Boolean).join('/');
  if (engineLooksRunningForMatrix(engineData)) summary.runningObserved = true;
  if (engineLooksFailedForMatrix(engineData)) summary.failedObserved = true;
}

function engineLooksRunningForMatrix(engineData = {}) {
  const text = `${engineData.status || ''} ${engineData.phase || ''} ${engineData.collectionState || ''} ${engineData.analysisState || ''}`.toLowerCase();
  if (engineData.isRunning === true || engineData.isAnalysisRunning === true) return true;
  return /running|analyz|collecting|collection_pending|payload_received/.test(text);
}

function engineLooksFailedForMatrix(engineData = {}) {
  const text = `${engineData.status || ''} ${engineData.phase || ''} ${engineData.completionStatus || ''}`.toLowerCase();
  if (/error|failed|engine_incomplete|publisher_incomplete/.test(text)) return true;
  if (!/cancelled/.test(text)) return false;
  return engineData.partial === true || Number(engineData.cancelled || 0) > 0;
}

function engineCompletionStatusForMatrix(completion = {}) {
  if (completion.partial === true) return 'partial';
  if (Number(completion.cancelled || 0) > 0) return 'cancelled';
  if (engineCompletionLooksComplete(completion)) return 'completed';
  return stringOrNull(completion.status) || null;
}

function engineRuntimeForMatrix(engine = null) {
  if (!engine || typeof engine !== 'object') return null;
  if (engine.runtime && typeof engine.runtime === 'object') return engine.runtime;
  if (engine.collectionState || engine.analysisState || typeof engine.isAnalysisRunning !== 'undefined') return engine;
  if (engine.progress && typeof engine.progress === 'object') return engine.progress;
  return engine;
}

function engineStateLabel(raw = null, completion = null) {
  const partial = completion && completion.partial === true;
  const preferCompletion = completion && !partial && engineCompletionLooksComplete(completion);
  const status = stringOrNull(
    preferCompletion
      ? completion && completion.status || raw && raw.status
      : raw && raw.status || completion && completion.status
  );
  const phase = stringOrNull(
    preferCompletion
      ? completion && completion.phase || raw && raw.phase
      : raw && raw.phase || completion && completion.phase
  );
  if (partial) return [status || 'partial', phase].filter(Boolean).join('/');
  if (preferCompletion && /running|analyz|file/i.test(`${status || ''} ${phase || ''}`)) {
    const normalizedStatus = /idle|waiting/i.test(`${phase || ''}`) || completion && completion.idle === true
      ? 'idle'
      : 'complete';
    const normalizedPhase = /file|analyz/i.test(`${phase || ''}`) ? null : phase;
    return [normalizedStatus, normalizedPhase].filter(Boolean).join('/');
  }
  return [status, phase].filter(Boolean).join('/') || null;
}

function engineCompletionLooksComplete(completion = null) {
  if (!completion || completion.partial === true) return false;
  const planned = Number(completion.planned);
  const completed = Number(completion.completed);
  const remaining = Number(completion.remaining);
  const finiteComplete = Number.isFinite(planned) && Number.isFinite(completed) && completed >= planned;
  const noRemaining = !Number.isFinite(remaining) || remaining === 0;
  return noRemaining && (
    finiteComplete ||
    /idle|waiting|complete|completed|done|stopped/i.test(`${completion.status || ''} ${completion.phase || ''}`)
  );
}

function sastRuntimeLooksActive(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return false;
  if (runtime.isAnalysisRunning === true) return true;
  const stateText = `${runtime.collectionState || ''} ${runtime.analysisState || ''}`.toLowerCase();
  return /analysis_running|analyzing|collection_pending|payload_received|collecting/.test(stateText);
}

function latestRawPtkStatus(lifecycle = {}) {
  const samples = Array.isArray(lifecycle.rawStatusSamples) ? lifecycle.rawStatusSamples : [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const status = unwrapPtkStatus(samples[index] && samples[index].status);
    if (status && typeof status === 'object') return status;
  }
  const drainLatest = lifecycle.drain && lifecycle.drain.latest;
  return unwrapPtkStatus(drainLatest && (drainLatest.status || drainLatest)) || null;
}

function unwrapPtkStatus(value) {
  if (!value || typeof value !== 'object') return value || null;
  if (value.status && typeof value.status === 'object' && value.status.engines) return value.status;
  if (value.value && typeof value.value === 'object') return unwrapPtkStatus(value.value);
  if (value.invocation && typeof value.invocation === 'object') return unwrapPtkStatus(value.invocation.value || value.invocation);
  return value;
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function attackCancelledCount(attackCompletion = null) {
  if (!attackCompletion || !attackCompletion.engines) return 0;
  let count = 0;
  for (const engine of Object.values(attackCompletion.engines)) {
    count += Number(engine && engine.cancelled || 0);
  }
  return count;
}

function summarizeDurationMs(result = {}, startedAt) {
  if (result.telemetry && Number.isFinite(Number(result.telemetry.durationMs))) {
    return Number(result.telemetry.durationMs);
  }
  const startMs = Date.parse(startedAt);
  if (Number.isFinite(startMs)) return Math.max(0, Date.now() - startMs);
  return 0;
}

function compareMatrixResults(results) {
  const comparisons = [];
  const keys = Array.from(new Set(results.map(result => `${result.target}:${result.scenarioVariant || 'scenario'}`)));
  for (const key of keys) {
    const [target, scenarioVariant] = key.split(':');
    const direct = results.find(result => result.target === target && (result.scenarioVariant || 'scenario') === scenarioVariant && result.mode === 'no-agent');
    for (const agent of results.filter(result => result.target === target && (result.scenarioVariant || 'scenario') === scenarioVariant && result.mode !== 'no-agent')) {
      if (!direct || !agent) continue;
      const skipReason = comparisonSkipReason(direct, agent);
      if (skipReason) {
        comparisons.push({
          target,
          scenarioVariant,
          directMode: direct.mode,
          agentMode: agent.mode,
          skipped: true,
          reason: skipReason
        });
        continue;
      }
      comparisons.push({
        target,
        scenarioVariant,
        directMode: direct.mode,
        agentMode: agent.mode,
        comparison: normalizeAgentComparisonForMatrix(compareRunArtifacts(matrixComparisonMetrics(direct), matrixComparisonMetrics(agent), {
          regressionRules: {
            maxDurationRatio: Number.POSITIVE_INFINITY
          }
        }), { direct, agent })
      });
    }
  }
  return comparisons;
}

function normalizeAgentComparisonForMatrix(comparison = {}, { direct = {}, agent = {} } = {}) {
  const coverageFields = new Set(['routeCount', 'routeShapeCount', 'endpointCount', 'formCount', 'actionCount']);
  const regressions = (comparison.regressions || []).filter(regression => {
    if (agentBaselinePreserved(agent) && coverageFields.has(regression.field)) return false;
    if (requiredFindingGatePreserved(direct, agent) && regression.field === 'findingsCount') return false;
    return true;
  });
  return {
    ...comparison,
    regressions,
    passed: regressions.length === 0,
    agentBaselinePreserved: agentBaselinePreserved(agent) || undefined,
    requiredFindingGatePreserved: requiredFindingGatePreserved(direct, agent) || undefined
  };
}

function normalizeAgentComparisonWithBaselinePreservation(comparison = {}, agentResult = {}) {
  return normalizeAgentComparisonForMatrix(comparison, { agent: agentResult });
}

function agentBaselinePreserved(result = {}) {
  const agent = result.agent || {};
  const preservation = agent.baselinePreservation || {};
  const findingDiff = agent.findingFingerprintDiff || {};
  if (preservation.agentFailureAffectedBaseline === true) return false;
  if (findingDiff.agentRegression === true) return false;
  if (agent.status === 'provider_failed' || agent.status === 'failed') return false;
  return preservation.agentFailureAffectedBaseline === false;
}

function requiredFindingGatePreserved(direct = {}, agent = {}) {
  const directGate = direct.findingQualityGate || {};
  const agentGate = agent.findingQualityGate || {};
  return directGate.applicable === true &&
    agentGate.applicable === true &&
    directGate.passed === true &&
    agentGate.passed === true;
}

function comparisonSkipReason(direct = {}, agent = {}) {
  if (direct.status === 'invalid_auth_credentials_missing' || direct.authPreflight && direct.authPreflight.ok === false) {
    return 'baseline_auth_invalid';
  }
  const agentReason = agentComparisonStopReason(agent);
  if (agent.status === 'skipped_baseline_scenario_failed' || agentReason) {
    if (/baseline_/.test(String(agentReason))) return agentReason;
    if (isNonComparableAgentStopReason(agentReason) && !agentHasUsefulExecution(agent)) return agentReason;
  }
  if (direct.scenarioSetup !== 'none' && direct.scenarioStatus && direct.scenarioStatus.ok === false) {
    return 'baseline_scenario_failed';
  }
  if (agent.status && /^skipped_/.test(agent.status)) return agent.status;
  if (direct.ptkValidity && direct.ptkValidity.valid === false) return 'baseline_ptk_invalid';
  if (agent.ptkValidity && agent.ptkValidity.valid === false) return 'agent_ptk_invalid';
  return null;
}

function agentComparisonStopReason(result = {}) {
  const agent = result.agent || {};
  return agent.telemetry && agent.telemetry.stopReason
    || agent.skipReason
    || agent.status
    || null;
}

function isNonComparableAgentStopReason(reason) {
  const value = String(reason || '').trim();
  if (/(?:^|_)provider_(?:timeout|failed|error|unavailable|parse_failed|parse_error)$/.test(value)) return true;
  if (/provider.*parse.*fail/i.test(value)) return true;
  if (/^(?:invalid|malformed)_provider_decision$/.test(value)) return true;
  return [
    'no_high_confidence_executable_missions',
    'no_executable_missions',
    'provider_timeout',
    'provider_failed',
    'provider_error',
    'provider_unavailable',
    'provider_choice_rejected',
    'invalid_provider_decision',
    'malformed_provider_decision',
    'no_executable_steps'
  ].includes(value);
}

function isProviderTimeoutReason(reason, fallback = null) {
  const text = String(reason || fallback || '');
  return reason === 'provider_timeout'
    || /provider.*(?:timeout|timed out)|(?:timeout|timed out).*provider/i.test(text);
}

function agentHasUsefulExecution(result = {}) {
  const agent = result.agent || {};
  const delta = agent.coverageDelta && agent.coverageDelta.total || {};
  const executionResults = Array.isArray(agent.executionResults) ? agent.executionResults : [];
  return executionResults.some(item => item && item.browserActionRan && item.transitionValidated)
    || Object.values(delta).some(value => Number(value) > 0);
}

function isPostBaselineTimeoutReason(reason, fallback = null) {
  const text = String(reason || fallback || '');
  return /post_baseline_timeout|provider_or_post_baseline_timeout/i.test(text);
}

function matrixComparisonMetrics(result = {}) {
  const coverage = result.coverageSummary || {};
  const findings = result.findings || result.ptkValidity || {};
  const comparableFindings = findings.uniqueFindings !== undefined
    ? findings.uniqueFindings
    : findings.count !== undefined ? findings.count : findings.findingsCount;
  return {
    summary: {
      totalDurationMs: result.durationMs,
      routeCount: coverage.routesVisited,
      routeShapeCount: coverage.routeShapes,
      endpointCount: coverage.endpointsObserved,
      formCount: coverage.formsDiscovered,
      actionCount: coverage.actionsDiscovered,
      findingsCount: comparableFindings,
      waitTimeMs: 0,
      noProgressActionCount: 0,
      errorCount: coverage.errors
    }
  };
}

function makeAgentModeId(provider, model) {
  const value = `${provider || 'agent'}-${model || 'default'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'agent';
}

function renderMatrixMarkdown(artifact) {
  const lines = [
    '# PTK Agents SDK Test Matrix',
    '',
    `Generated: ${artifact.generatedAt}`,
    '',
    '| Target | Mode | Scenario | AuthPreflight | AuthFailureReason | BaselineScenarioStatus | BaselineScenarioFailureReason | Routes | Shapes | Endpoints | Forms | ScenarioStatus | FailedStep | PTKBridge | PTKLifecycle | PTKScanStarted | PTKExportBeforeStop | ExportBeforeStopAttempted | ExportBeforeStopSucceeded | ExportRecoveredAfterStop | ExportFailureBeforeStop | PTKExported | PTKLookupSource | ExportLookupSource | ExportRetrievalResolved | ExportValiditySource | FindingsApiFallbackUsed | PTKInconsistencies | DASTState | IASTState | SASTState | SASTCollectionState | SASTAnalysisState | EngineIncomplete | ExportFailureReason | FindingsValid | Findings | UniqueFindings | RequiredFindingsGate | MissingRequiredFindings | AgentMaxTurns | AgentTurns | AgentExecutedSteps | AgentCoverageDelta | AgentAddedRoutes | AgentAddedEndpoints | AgentAddedUniqueFindings | AgentLostUniqueFindings | AgentRegression | AgentSkipReason | AgentFailureReason | ProviderTimedOut | PostBaselineTimedOut | RiskyActions | AttackCompletion | AttackCancelled | RowFinalizationStatus | Duration | Result |',
    '|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---:|---:|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|---|---|---:|---|---:|---|---:|---|'
  ];
  for (const result of artifact.results) {
    const c = result.coverageSummary || {};
    const scenario = result.scenarioStatus || {};
    const validity = result.ptkValidity || {};
    const bridge = result.ptkBridge || {};
    const lifecycle = result.ptkLifecycle || {};
    const findings = result.findings || {};
    const requiredGate = result.findingQualityGate || {};
    const agent = result.agent || {};
    const agentDelta = agent.coverageDelta && agent.coverageDelta.total || {};
    const findingDiff = agent.findingFingerprintDiff || {};
    const executedSteps = Array.isArray(agent.executionResults) ? agent.executionResults.length : 0;
    const agentDeltaText = `${agentDelta.routes || 0}/${agentDelta.endpoints || 0}/${agentDelta.forms || 0}/${agentDelta.findings || 0}`;
    const riskyActions = countRiskyAgentActions(agent);
    const agentReason = result.agentFailureReason || agentComparisonStopReason(result);
    const providerTimedOut = result.providerTimedOut !== undefined
      ? Boolean(result.providerTimedOut)
      : isProviderTimeoutReason(agentReason, result.error);
    const postBaselineTimedOut = result.postBaselineTimedOut !== undefined
      ? Boolean(result.postBaselineTimedOut)
      : isPostBaselineTimeoutReason(agentReason, result.status || result.error);
    const authPreflight = result.authPreflight || {};
    const scenarioStatus = scenario.status
      ? `${scenario.status}${scenario.totalSteps ? ` ${scenario.completedSteps || 0}/${scenario.totalSteps}` : ''}`
      : 'not-run';
    const ptkBridge = bridge.available ? bridge.source || 'detected' : 'missing';
    const attack = lifecycle.attackCompletion || {};
    const attackStatus = attack.available === false
      ? 'unavailable'
      : attack.partial === true
        ? 'partial'
        : attack.available ? 'complete' : '';
    const resultText = [
      result.ok ? 'pass' : 'fail',
      result.status || '',
      result.error || scenario.failureReason || validity.reason || ''
    ].filter(Boolean).join(': ');
    lines.push(`| ${cell(result.target)} | ${cell(result.mode)} | ${cell(result.scenario || '')} | ${cell(authPreflight.classification || '')} | ${cell(result.authFailureReason || '')} | ${cell(result.baselineScenarioStatus || '')} | ${cell(result.baselineScenarioFailureReason || '')} | ${c.routesVisited || 0} | ${c.routeShapes || 0} | ${c.endpointsObserved || 0} | ${c.formsDiscovered || 0} | ${cell(scenarioStatus)} | ${cell(scenario.failedStep || '')} | ${cell(ptkBridge)} | ${cell(lifecycle.lifecycleStatus || '')} | ${lifecycle.scanStarted ? 'yes' : 'no'} | ${lifecycle.exportBeforeStop ? 'yes' : 'no'} | ${lifecycle.exportBeforeStopAttempted ? 'yes' : 'no'} | ${lifecycle.exportBeforeStopSucceeded ? 'yes' : 'no'} | ${lifecycle.exportRecoveredAfterStop ? 'yes' : 'no'} | ${lifecycle.exportFailureBeforeStop ? 'yes' : 'no'} | ${lifecycle.exported ? 'yes' : 'no'} | ${cell(lifecycle.ptkLookupSource || '')} | ${cell(lifecycle.exportLookupSource || '')} | ${lifecycle.exportRetrievalResolved ? 'yes' : 'no'} | ${cell(lifecycle.exportValiditySource || '')} | ${lifecycle.findingsApiFallbackUsed ? 'yes' : 'no'} | ${cell((lifecycle.ptkInconsistencies || lifecycle.inconsistencies || []).join(','))} | ${cell(lifecycle.dastState || '')} | ${cell(lifecycle.iastState || '')} | ${cell(lifecycle.sastState || '')} | ${cell(lifecycle.sastCollectionState || '')} | ${cell(lifecycle.sastAnalysisState || '')} | ${lifecycle.engineIncomplete ? 'yes' : 'no'} | ${cell(lifecycle.exportFailureReason || '')} | ${validity.valid ? 'yes' : 'no'} | ${findings.count || validity.findingsCount || 0} | ${findings.uniqueFindings || 0} | ${cell(requiredGate.status || '')} | ${cell((requiredGate.missing || []).join(','))} | ${result.agentEffectiveMaxTurns || ''} | ${(agent.turns || []).length || 0} | ${executedSteps} | ${cell(agentDeltaText)} | ${agentDelta.routes || 0} | ${agentDelta.endpoints || 0} | ${findingDiff.agentAddedUniqueFindings || agentDelta.findings || 0} | ${findingDiff.agentLostUniqueFindings || 0} | ${findingDiff.agentRegression ? 'yes' : 'no'} | ${cell(agentReason || '')} | ${cell(agent.status === 'provider_failed' || agent.status === 'failed' ? agentReason || agent.result && agent.result.reason || '' : '')} | ${providerTimedOut ? 'yes' : 'no'} | ${postBaselineTimedOut ? 'yes' : 'no'} | ${riskyActions} | ${cell(attackStatus)} | ${lifecycle.attackCancelled || 0} | ${cell(result.rowFinalizationStatus || '')} | ${result.durationMs || 0} | ${cell(resultText)} |`);
  }
  if (artifact.comparisons.length) {
    lines.push('', '## Comparisons', '');
    for (const item of artifact.comparisons) {
      lines.push(`### ${item.target} ${item.scenarioVariant || 'scenario'} ${item.agentMode}`, '');
      if (item.skipped) {
        lines.push(`- skipped: ${item.reason || 'not_comparable'}`);
        continue;
      }
      lines.push(`- result: ${item.comparison.passed ? 'passed' : 'regressions detected'}`);
      for (const metric of Object.values(item.comparison.metrics || {})) {
        lines.push(`- ${metric.field}: direct=${metric.baseline ?? 'n/a'} agent=${metric.candidate ?? 'n/a'} delta=${metric.delta ?? 'n/a'}`);
      }
      if (Array.isArray(item.comparison.regressions) && item.comparison.regressions.length > 0) {
        lines.push('- regressions:');
        for (const regression of item.comparison.regressions) {
          lines.push(`  - ${regression.field}: ${regression.message}`);
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
}

function countRiskyAgentActions(agent = {}) {
  const results = Array.isArray(agent.executionResults) ? agent.executionResults : [];
  return results.filter(result => result && result.policy && result.policy.tier && result.policy.tier !== 'safe').length;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  defaultMatrix,
  PLACEHOLDER_PASSWORD,
  PLACEHOLDER_USERNAME,
  BENCHMARK_ENGINE_NAMES,
  agentModes,
  benchmarkEngineConfig,
  benchmarkAgentConfig,
  buildBenchmarkInlineConfig,
  filterTargets,
  matrixComparisonMetrics,
  normalizeScenarioMode,
  normalizeTargetList,
  scenarioVariants,
  attackCancelledCount,
  makeAgentModeId,
  prepareMatrixRunOutputDir,
  runBenchmarkMatrix,
  renderMatrixMarkdown,
  scenarioFileForVariant,
  summarizePtkLifecycle,
  summarizePtkBridge,
  summarizePtkFindings,
  summarizePtkValidity,
  compareMatrixResults,
  comparisonSkipReason,
  agentComparisonStopReason,
  isNonComparableAgentStopReason,
  isProviderTimeoutReason,
  credentialPreflightForMatrixRow,
  providerBaselineGate,
  summarizeAuthPreflight
};
