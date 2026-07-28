'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BENCHMARK_ENGINE_NAMES,
  benchmarkAgentConfig,
  buildBenchmarkInlineConfig,
  compareMatrixResults,
  comparisonSkipReason,
  credentialPreflightForMatrixRow,
  defaultMatrix,
  matrixComparisonMetrics,
  normalizeTargetList,
  normalizeScenarioMode,
  prepareMatrixRunOutputDir,
  providerBaselineGate,
  renderMatrixMarkdown,
  runBenchmarkMatrix,
  scenarioFileForVariant,
  scenarioVariants,
  isProviderTimeoutReason,
  summarizePtkLifecycle
} = require('../../../src/benchmarks/matrixRunner.cjs');

test('benchmark scenario mode resolves explicit, none, and all variants', () => {
  assert.equal(normalizeScenarioMode(undefined), 'explicit');
  assert.equal(normalizeScenarioMode('scenario'), 'explicit');
  assert.equal(normalizeScenarioMode('no-scenario'), 'none');
  assert.equal(normalizeScenarioMode('both'), 'all');
  assert.deepEqual(scenarioVariants({ scenarioMode: 'all' }).map(item => item.id), ['scenario', 'no-scenario']);
  assert.deepEqual(scenarioVariants({ scenarioMode: 'none' }).map(item => item.label), ['none']);
  assert.throws(() => normalizeScenarioMode('later'), /Unsupported benchmark scenario mode/);
});

test('benchmark row output directory is prepared without stale artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-matrix-row-'));
  const row = path.join(root, 'juice-shop-scenario-no-agent');
  fs.mkdirSync(row, { recursive: true });
  fs.writeFileSync(path.join(row, 'ptk-drain-summary.json'), '{"status":"stale"}', 'utf8');

  prepareMatrixRunOutputDir(row);

  assert.equal(fs.existsSync(row), true);
  assert.equal(fs.existsSync(path.join(row, 'ptk-drain-summary.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('benchmark target filter supports the first agent gate target set', () => {
  const matrix = defaultMatrix({
    scenarioMode: 'explicit',
    agentProvider: 'mock',
    targets: 'juice-shop,testfire',
    rootDir: '/repo'
  });
  assert.deepEqual(matrix.targets.map(item => item.id), ['juice-shop', 'testfire']);
  assert.deepEqual(matrix.modes.map(item => item.id), ['no-agent', 'agent-mock']);
  assert.equal(matrix.modes[1].agentMode, 'mock');
  assert.equal(matrix.modes[1].agentProvider, 'mock');
  assert.deepEqual(normalizeTargetList('juice,test-fire,broken-crystals'), ['juice-shop', 'testfire', 'brokencrystals']);
});

test('benchmark target filter rejects unknown targets clearly', () => {
  assert.throws(() => defaultMatrix({
    targets: 'juice-shop,unknown-app',
    rootDir: '/repo'
  }), /Unsupported benchmark target\(s\): unknown-app/);
});

test('default matrix records scenario variants without enabling agent rows when disabled', () => {
  const matrix = defaultMatrix({ scenarioMode: 'all', agentProvider: 'none', rootDir: '/repo' });
  assert.equal(matrix.scenarioMode, 'all');
  assert.deepEqual(matrix.scenarioVariants.map(item => item.label), ['explicit', 'none']);
  assert.deepEqual(matrix.targets.map(item => item.id), ['juice-shop', 'testfire', 'brokencrystals']);
  assert.ok(matrix.targets.every(item => /\.md$/.test(item.scenario)), 'human-readable markdown scenarios remain available for user/agent guidance');
  assert.ok(matrix.targets.every(item => /\.json$/.test(item.executableScenario)), 'benchmark gates use executable JSON scenario fixtures for deterministic truth');
  assert.ok(matrix.targets.every(item => item.authScenario));
  assert.deepEqual(matrix.engines, ['DAST', 'IAST', 'SAST']);
  assert.deepEqual(matrix.modes.map(item => item.id), ['no-agent']);
});

test('no-scenario benchmark rows use auth-only setup by default', () => {
  const target = {
    scenario: '/repo/docs/scenario_app.md',
    executableScenario: '/repo/benchmarks/app/scenario.json',
    authScenario: '/repo/benchmarks/app/auth.json'
  };

  assert.deepEqual(scenarioFileForVariant(target, { file: true }), {
    file: '/repo/benchmarks/app/scenario.json',
    setup: 'explicit-json',
    descriptionFile: '/repo/docs/scenario_app.md'
  });
  assert.deepEqual(scenarioFileForVariant(target, { file: false }), {
    file: '/repo/benchmarks/app/auth.json',
    setup: 'auth-only'
  });
  assert.deepEqual(scenarioFileForVariant(target, { file: false }, { authSetup: false }), {
    file: null,
    setup: 'none'
  });
});

test('explicit benchmark rows require executable JSON scenarios and do not use markdown as truth', () => {
  const missingExecutable = scenarioFileForVariant({
    scenario: '/repo/docs/scenario_app.md'
  }, { file: true });

  assert.equal(missingExecutable.file, null);
  assert.equal(missingExecutable.setup, 'explicit-json-missing');
  assert.equal(missingExecutable.descriptionFile, '/repo/docs/scenario_app.md');
  assert.equal(missingExecutable.error, 'executable_scenario_missing');
});

test('benchmark run config enables DAST, IAST, and SAST with target route hints', () => {
  assert.deepEqual(BENCHMARK_ENGINE_NAMES, ['DAST', 'IAST', 'SAST']);
  const config = buildBenchmarkInlineConfig({
    routeHintsFile: '/repo/benchmarks/brokencrystals/route-hints.json'
  }, {
    agentProvider: 'all',
    inlineConfig: {
      engines: {
        sca: { enabled: true }
      },
      crawler: {
        maxRoutes: 12
      }
    }
  });

  assert.equal(config.engines.dast.enabled, true);
  assert.equal(config.engines.iast.enabled, true);
  assert.equal(config.engines.sast.enabled, true);
  assert.equal(config.engines.sca.enabled, false);
  assert.equal(config.crawler.maxRoutes, 12);
  assert.equal(config.crawler.routeHintsFile, '/repo/benchmarks/brokencrystals/route-hints.json');
  assert.equal(config.agent.maxTurns, 3);
  assert.deepEqual(benchmarkAgentConfig({ agentProvider: 'none' }), {});
  assert.equal(benchmarkAgentConfig({ agentProvider: 'codex' }).maxTurns >= 3, true);
  assert.deepEqual(benchmarkAgentConfig({ agentProvider: 'all', maxAgentTurns: '2' }), { maxTurns: 2 });
  assert.deepEqual(benchmarkAgentConfig({ agentProvider: 'opencode', aggressive: true }), {
    maxTurns: 3,
    riskMode: 'business',
    allowBusinessMutations: true,
    allowDestructiveActions: false
  });
  assert.deepEqual(benchmarkAgentConfig({ agentProvider: 'opencode', allowDestructiveActions: true, requireAgentSuccess: true }), {
    maxTurns: 3,
    riskMode: 'destructive',
    allowBusinessMutations: true,
    allowDestructiveActions: true,
    requireSuccess: true
  });
});

test('benchmark auth preflight rejects placeholder credentials before a normal row runs', () => {
  const preflight = credentialPreflightForMatrixRow({
    target: {
      id: 'juice-shop',
      url: 'http://localhost:3001/',
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    mode: { id: 'no-agent' },
    scenarioVariant: { id: 'scenario' },
    scenarioResolution: { file: '/repo/scenario.json', setup: 'explicit' }
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.classification, 'credentials_missing_or_placeholder');
  assert.deepEqual(preflight.redactedEvidence.missingFields, ['username', 'password']);
  assert.doesNotMatch(JSON.stringify(preflight), /YOUR_PASSWORD/);
});

test('benchmark provider rows are gated when deterministic scenario baseline fails', () => {
  const baseline = {
    status: 'scenario_failed',
    scenarioStatus: {
      ok: false,
      status: 'failed',
      failureReason: 'target_rejected_credentials'
    }
  };
  const gate = providerBaselineGate({
    mode: { id: 'agent-opencode-big-pickle' },
    scenarioResolution: { file: '/repo/scenario.json', setup: 'explicit' },
    baseline
  });

  assert.equal(gate.skip, true);
  assert.equal(gate.reason, 'baseline_scenario_failed');
  assert.equal(providerBaselineGate({
    mode: { id: 'agent-opencode-big-pickle' },
    scenarioResolution: { file: '/repo/scenario.json', setup: 'explicit' },
    baseline,
    options: { agentAllowScenarioUnblock: true }
  }).skip, false);
});

test('benchmark matrix writes invalid auth baseline and skips providers before live run', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-matrix-auth-gate-'));
  const matrix = await runBenchmarkMatrix({
    outputDir,
    rootDir: path.resolve(__dirname, '../../..'),
    targets: 'juice-shop',
    scenarioMode: 'explicit',
    agentProvider: 'all'
  });

  assert.deepEqual(matrix.results.map(row => row.status), [
    'invalid_auth_credentials_missing',
    'skipped_invalid_auth',
    'skipped_invalid_auth'
  ]);
  assert.equal(matrix.results[0].authFailureReason, 'credentials_missing_or_placeholder');
  assert.equal(matrix.results[1].agent.telemetry.stopReason, 'invalid_auth');
  assert.equal(matrix.results[1].rowFinalizationStatus, 'finalized_skipped_invalid_auth');
  assert.equal(fs.existsSync(path.join(outputDir, 'juice-shop-scenario-no-agent', 'auth-preflight.json')), true);
  assert.equal(fs.existsSync(path.join(outputDir, 'juice-shop-scenario-opencode-opencode-big-pickle', 'row-lifecycle-events.jsonl')), true);

  fs.rmSync(outputDir, { recursive: true, force: true });
});

test('benchmark matrix separates package fixture root from caller cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-matrix-cwd-'));
  const packageRoot = path.resolve(__dirname, '../../..');
  const matrix = await runBenchmarkMatrix({
    cwd,
    outputDir: 'matrix-out',
    rootDir: packageRoot,
    targets: 'juice-shop',
    scenarioMode: 'explicit',
    agentProvider: 'none'
  });

  assert.equal(matrix.outputDir, path.join(cwd, 'matrix-out'));
  assert.equal(matrix.results[0].scenarioFile, 'benchmarks/juice-shop/scenario.json');
  assert.equal(fs.existsSync(path.join(cwd, 'matrix-out', 'test-matrix.json')), true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('benchmark matrix can delegate each scan to an external installed-package runner', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-matrix-installed-runner-'));
  let observed = null;
  const matrix = await runBenchmarkMatrix({
    outputDir,
    rootDir: path.resolve(__dirname, '../../..'),
    targets: 'juice-shop',
    scenarioMode: 'explicit',
    agentProvider: 'none',
    juiceUsername: 'fixture@example.test',
    juicePassword: 'fixture-password',
    runPtkAgent: async (options) => {
      observed = options;
      return {
        ok: true,
        status: 'completed',
        telemetry: { durationMs: 1 },
        coverage: {
          summary: { routesVisited: 1 },
          scenario: { ok: true, status: 'completed', completedSteps: 1, totalSteps: 1 },
          ptk: {
            available: true,
            validity: { valid: true, status: 'valid', findingsCount: 1 },
            bridge: { available: true, source: 'installed-public-cli' },
            findings: { count: 1 }
          }
        },
        artifacts: {}
      };
    }
  });

  assert.equal(matrix.results[0].ok, true);
  assert.equal(observed.url, 'http://localhost:3001/');
  assert.equal(observed.outputDir, path.join(outputDir, 'juice-shop-scenario-no-agent'));
  assert.deepEqual(observed.requestedEngines, ['DAST', 'IAST', 'SAST']);

  fs.rmSync(outputDir, { recursive: true, force: true });
});

test('matrix markdown uses required M13 columns and no-scenario status', () => {
  const markdown = renderMatrixMarkdown({
    generatedAt: '2026-05-04T00:00:00.000Z',
    results: [{
      target: 'juice-shop',
      mode: 'no-agent',
      scenario: 'none',
      ok: true,
      status: 'completed',
      coverageSummary: {
        routesVisited: 40,
        routeShapes: 18,
        endpointsObserved: 70,
        formsDiscovered: 7
      },
      scenarioStatus: null,
      ptkBridge: { available: true, source: 'PTK_AGENT' },
      ptkLifecycle: { scanStarted: true, exported: true },
      ptkValidity: { valid: true, findingsCount: 11 },
      findings: { count: 11 },
      durationMs: 1234
    }],
    comparisons: []
  });

  assert.match(markdown, /\| Target \| Mode \| Scenario \| AuthPreflight \| AuthFailureReason \| BaselineScenarioStatus \| BaselineScenarioFailureReason \| Routes \| Shapes \| Endpoints \| Forms \| ScenarioStatus \| FailedStep \| PTKBridge \| PTKLifecycle \| PTKScanStarted \| PTKExportBeforeStop \| ExportBeforeStopAttempted \| ExportBeforeStopSucceeded \| ExportRecoveredAfterStop \| ExportFailureBeforeStop \| PTKExported .* AgentFailureReason \| ProviderTimedOut \| PostBaselineTimedOut \| RiskyActions .* RowFinalizationStatus \| Duration \| Result \|/);
  assert.match(markdown, /\| juice-shop \| no-agent \| none \| {2}\| {2}\| {2}\| {2}\| 40 \| 18 \| 70 \| 7 \| not-run .* 0\/0\/0\/0 .* 1234 \| pass: completed \|/);
});

test('matrix comparisons are grouped by target and scenario variant', () => {
  const comparisons = compareMatrixResults([
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'no-agent',
      telemetry: { summary: { routeCount: 4, endpointCount: 10 } },
      coverageSummary: { routesVisited: 4, routeShapes: 3, endpointsObserved: 5, formsDiscovered: 1, actionsDiscovered: 2, errors: 0 },
      findings: { count: 4 },
      durationMs: 1000
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'no-scenario',
      mode: 'no-agent',
      telemetry: { summary: { routeCount: 7 } },
      coverageSummary: { routesVisited: 7, routeShapes: 3, endpointsObserved: 7, formsDiscovered: 1, actionsDiscovered: 2, errors: 0 }
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'opencode',
      telemetry: { summary: { routeCount: 5, endpointCount: 1 } },
      coverageSummary: { routesVisited: 5, routeShapes: 4, endpointsObserved: 6, formsDiscovered: 2, actionsDiscovered: 3, errors: 0 },
      findings: { count: 2 },
      durationMs: 3000
    }
  ]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].scenarioVariant, 'scenario');
  assert.equal(comparisons[0].comparison.passed, false);
  assert.equal(comparisons[0].comparison.metrics.endpointCount.delta, 1);
  assert.equal(comparisons[0].comparison.metrics.findingsCount.delta, -2);
  assert.equal(comparisons[0].comparison.regressions.some(item => item.field === 'findingsCount'), true);
});

test('matrix comparisons are skipped when baseline auth or PTK validity is invalid', () => {
  assert.equal(comparisonSkipReason({
    status: 'invalid_auth_credentials_missing',
    authPreflight: { ok: false, classification: 'credentials_missing_or_placeholder' }
  }, {
    status: 'completed'
  }), 'baseline_auth_invalid');

  assert.equal(comparisonSkipReason({
    status: 'completed',
    ptkValidity: { valid: false }
  }, {
    status: 'completed'
  }), 'baseline_ptk_invalid');
});

test('matrix comparisons are skipped when agent provider did not execute useful work', () => {
  assert.equal(comparisonSkipReason({
    status: 'completed',
    ptkValidity: { valid: true }
  }, {
    status: 'completed',
    ptkValidity: { valid: true },
    agent: {
      status: 'no_executable_missions',
      telemetry: { stopReason: 'no_high_confidence_executable_missions' },
      coverageDelta: {
        total: { routes: 0, endpoints: 0, forms: 0, findings: 0 }
      }
    }
  }), 'no_high_confidence_executable_missions');

  const comparisons = compareMatrixResults([
    {
      target: 'juice-shop',
      scenarioVariant: 'no-scenario',
      mode: 'no-agent',
      status: 'completed',
      ptkValidity: { valid: true },
      coverageSummary: { routesVisited: 14, routeShapes: 13, endpointsObserved: 63, formsDiscovered: 2 }
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'no-scenario',
      mode: 'opencode',
      status: 'completed',
      ptkValidity: { valid: true },
      coverageSummary: { routesVisited: 15, routeShapes: 15, endpointsObserved: 55, formsDiscovered: 2 },
      agent: {
        status: 'no_executable_missions',
        telemetry: { stopReason: 'no_high_confidence_executable_missions' }
      }
    }
  ]);

  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].skipped, true);
  assert.equal(comparisons[0].reason, 'no_high_confidence_executable_missions');

  assert.equal(comparisonSkipReason({
    status: 'completed',
    ptkValidity: { valid: true }
  }, {
    status: 'completed',
    ptkValidity: { valid: true },
    agent: {
      status: 'provider_failed',
      telemetry: { stopReason: 'codex_provider_failed' },
      coverageDelta: {
        total: { routes: 0, endpoints: 0, forms: 0, findings: 0 }
      }
    }
  }), 'codex_provider_failed');

  assert.equal(comparisonSkipReason({
    status: 'completed',
    ptkValidity: { valid: true }
  }, {
    status: 'completed',
    ptkValidity: { valid: true },
    agent: {
      status: 'provider_failed',
      telemetry: { stopReason: 'provider_choice_rejected' },
      coverageDelta: {
        total: { routes: 0, endpoints: 0, forms: 0, findings: 0 }
      }
    }
  }), 'provider_choice_rejected');

  assert.equal(comparisonSkipReason({
    status: 'completed',
    ptkValidity: { valid: true }
  }, {
    status: 'completed',
    ptkValidity: { valid: true },
    agent: {
      status: 'provider_failed',
      telemetry: { stopReason: 'opencode_provider_parse_failed' },
      coverageDelta: {
        total: { routes: 0, endpoints: 0, forms: 0, findings: 0 }
      },
      executionResults: []
    }
  }), 'opencode_provider_parse_failed');
});

test('provider timeout classification does not treat browser action timeouts as provider timeouts', () => {
  assert.equal(isProviderTimeoutReason('provider_timeout'), true);
  assert.equal(isProviderTimeoutReason('opencode provider timed out after 90000ms'), true);
  assert.equal(isProviderTimeoutReason('submit form complaint-form timed out after 1000ms (crawler.maxActionMs)'), false);
});

test('matrix comparison does not blame agent for cross-run coverage variance when row baseline is preserved', () => {
  const comparisons = compareMatrixResults([
    {
      target: 'juice-shop',
      scenarioVariant: 'no-scenario',
      mode: 'no-agent',
      status: 'completed',
      ptkValidity: { valid: true },
      durationMs: 1000,
      coverageSummary: {
        routesVisited: 31,
        routeShapes: 29,
        endpointsObserved: 136,
        formsDiscovered: 14,
        actionsDiscovered: 346,
        errors: 3
      },
      findings: { count: 104 }
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'no-scenario',
      mode: 'opencode',
      status: 'completed',
      ptkValidity: { valid: true },
      durationMs: 1200,
      coverageSummary: {
        routesVisited: 31,
        routeShapes: 29,
        endpointsObserved: 135,
        formsDiscovered: 14,
        actionsDiscovered: 349,
        errors: 3
      },
      findings: { count: 104 },
      agent: {
        status: 'completed',
        telemetry: { stopReason: 'max_turns' },
        baselinePreservation: {
          baselineEndpoints: 134,
          agentAddedEndpoints: 1,
          agentFailureAffectedBaseline: false
        },
        coverageDelta: {
          total: { routes: 0, routeShapes: 0, endpoints: 1, forms: 0, actions: 3, findings: 0 }
        },
        executionResults: [{ browserActionRan: true, transitionValidated: true }]
      }
    }
  ]);

  assert.equal(comparisons[0].comparison.passed, true);
  assert.equal(comparisons[0].comparison.agentBaselinePreserved, true);
  assert.deepEqual(comparisons[0].comparison.regressions, []);
});

test('matrix comparison still reports finding drops when row baseline is preserved', () => {
  const comparisons = compareMatrixResults([
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'no-agent',
      status: 'completed',
      ptkValidity: { valid: true },
      durationMs: 1000,
      coverageSummary: {
        routesVisited: 31,
        routeShapes: 29,
        endpointsObserved: 136,
        formsDiscovered: 14,
        actionsDiscovered: 346,
        errors: 3
      },
      findings: { count: 104 }
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'codex',
      status: 'completed',
      ptkValidity: { valid: true },
      durationMs: 1200,
      coverageSummary: {
        routesVisited: 31,
        routeShapes: 29,
        endpointsObserved: 135,
        formsDiscovered: 14,
        actionsDiscovered: 349,
        errors: 3
      },
      findings: { count: 103 },
      agent: {
        status: 'completed',
        telemetry: { stopReason: 'max_turns' },
        baselinePreservation: {
          baselineFindings: 104,
          agentFailureAffectedBaseline: false
        },
        coverageDelta: {
          total: { routes: 0, routeShapes: 0, endpoints: 1, forms: 0, actions: 3, findings: 0 }
        },
        executionResults: [{ browserActionRan: true, transitionValidated: true }]
      }
    }
  ]);

  assert.equal(comparisons[0].comparison.agentBaselinePreserved, true);
  assert.equal(comparisons[0].comparison.passed, false);
  assert.deepEqual(comparisons[0].comparison.regressions.map(item => item.field), ['findingsCount']);
});

test('matrix comparison does not fail finding count churn when required finding gate is preserved', () => {
  const comparisons = compareMatrixResults([
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'no-agent',
      status: 'completed',
      ptkValidity: { valid: true },
      coverageSummary: { routesVisited: 31, routeShapes: 25, endpointsObserved: 119, formsDiscovered: 17, actionsDiscovered: 306 },
      findings: { count: 111, uniqueFindings: 111 },
      findingQualityGate: { applicable: true, passed: true, status: 'passed', missing: [] }
    },
    {
      target: 'juice-shop',
      scenarioVariant: 'scenario',
      mode: 'codex',
      status: 'completed',
      ptkValidity: { valid: true },
      coverageSummary: { routesVisited: 31, routeShapes: 23, endpointsObserved: 127, formsDiscovered: 26, actionsDiscovered: 378 },
      findings: { count: 111, uniqueFindings: 110 },
      findingQualityGate: { applicable: true, passed: true, status: 'passed', missing: [] },
      agent: {
        status: 'completed',
        telemetry: { stopReason: 'max_turns' },
        baselinePreservation: { agentFailureAffectedBaseline: false },
        coverageDelta: { total: { routes: 0, routeShapes: 0, endpoints: 9, forms: 0, actions: 6, findings: 0 } },
        executionResults: [{ browserActionRan: true, transitionValidated: true }]
      }
    }
  ]);

  assert.equal(comparisons[0].comparison.passed, true);
  assert.equal(comparisons[0].comparison.requiredFindingGatePreserved, true);
  assert.deepEqual(comparisons[0].comparison.regressions, []);
});

test('matrix comparison metrics use displayed coverage summary instead of raw telemetry', () => {
  assert.deepEqual(matrixComparisonMetrics({
    durationMs: 1234,
    coverageSummary: {
      routesVisited: 4,
      routeShapes: 2,
      endpointsObserved: 9,
      formsDiscovered: 3,
      actionsDiscovered: 7,
      errors: 1
    },
    findings: { count: 5 }
  }).summary, {
    totalDurationMs: 1234,
    routeCount: 4,
    routeShapeCount: 2,
    endpointCount: 9,
    formCount: 3,
    actionCount: 7,
    findingsCount: 5,
    waitTimeMs: 0,
    noProgressActionCount: 0,
    errorCount: 1
  });
});

test('matrix comparison metrics prefer unique findings over raw count', () => {
  assert.equal(matrixComparisonMetrics({
    findings: {
      count: 107,
      uniqueFindings: 140
    }
  }).summary.findingsCount, 140);
});

test('ptk lifecycle summary exposes scan started and export status', () => {
  assert.deepEqual(summarizePtkLifecycle({
    coverage: {
      ptk: {
        exported: false,
        lifecycle: {
          scanStarted: true,
          exportAttempted: true,
          exportSucceeded: false,
          exportAttemptStage: 'before-stop',
          exportLookupSource: 'none',
          exportRetrievalResolved: false,
          findingsApiFallbackUsed: true,
          findingsExportValiditySource: 'findings-api',
          lookupDiagnostics: { lookupSource: 'none' },
          rawStatusSamples: [{
            stage: 'during-drain',
            status: {
              engines: {
                SAST: {
                  status: 'running',
                  runtime: {
                    collectionState: 'waiting_for_page_activity',
                    analysisState: 'complete'
                  }
                }
              }
            }
          }],
          inconsistencies: ['findings_api_used_without_export', 'sast_waiting_for_page_activity'],
          drain: { mode: 'until-complete', status: 'timeout' },
          attackCompletion: {
            partial: true,
            engines: {
              SAST: { status: 'running', phase: null, partial: false },
              DAST: { status: 'stopped', phase: 'idle', partial: true, cancelled: 2 }
            }
          },
          reason: 'session_not_found'
        }
      }
    }
  }), {
    lifecycleStatus: 'inconsistent',
    scanStarted: true,
    exported: false,
    exportAttempted: true,
    exportBeforeStop: true,
    exportBeforeStopAttempted: true,
    exportBeforeStopSucceeded: false,
    exportRecoveredAfterStop: false,
    exportFailureBeforeStop: true,
    ptkLookupSource: 'none',
    exportValiditySource: 'findings-api',
    findingsApiFallbackUsed: true,
    exportLookupSource: 'none',
    exportRetrievalResolved: false,
    inconsistencies: ['findings_api_used_without_export', 'sast_waiting_for_page_activity'],
    ptkInconsistencies: ['findings_api_used_without_export', 'sast_waiting_for_page_activity'],
    dastState: 'stopped/idle',
    iastState: null,
    sastState: 'running',
    sastCollectionState: 'waiting_for_page_activity',
    sastAnalysisState: 'complete',
    engineParticipation: {
      DAST: {
        evidence: true,
        runningObserved: false,
        failedObserved: true,
        lastStatus: null,
        completionStatus: 'partial'
      },
      IAST: {
        evidence: false,
        runningObserved: false,
        failedObserved: false,
        lastStatus: null,
        completionStatus: null
      },
      SAST: {
        evidence: true,
        runningObserved: true,
        failedObserved: false,
        lastStatus: 'running',
        completionStatus: 'running'
      }
    },
    engineIncomplete: true,
    exportFailureReason: 'session_not_found',
    scanStopped: false,
    drain: { mode: 'until-complete', status: 'timeout' },
    attackCompletion: {
      partial: true,
      engines: {
        SAST: { status: 'running', phase: null, partial: false },
        DAST: { status: 'stopped', phase: 'idle', partial: true, cancelled: 2 }
      }
    },
    attackCancelled: 2
  });
});

test('ptk lifecycle summary treats retry-status-page export as pre-stop export attempt', () => {
  const summary = summarizePtkLifecycle({
    coverage: {
      ptk: {
        exported: true,
        lifecycle: {
          scanStarted: true,
          exportAttempted: true,
          exportSucceeded: true,
          exportAttemptStage: 'retry-status-page',
          exportLookupSource: 'completed-tab',
          exportRetrievalResolved: true,
          findingsExportValiditySource: 'export'
        }
      }
    }
  });

  assert.equal(summary.exportBeforeStop, true);
  assert.equal(summary.exportBeforeStopAttempted, true);
  assert.equal(summary.exportBeforeStopSucceeded, true);
  assert.equal(summary.exportRecoveredAfterStop, false);
  assert.equal(summary.exportFailureBeforeStop, false);
});

test('ptk lifecycle summary does not treat clean stopped/cancelled engine labels as failures', () => {
  const summary = summarizePtkLifecycle({
    coverage: {
      ptk: {
        lifecycle: {
          scanStarted: true,
          exported: true,
          exportSucceeded: true,
          rawStatusSamples: [{
            stage: 'before-export',
            status: {
              engines: {
                DAST: {
                  status: 'cancelled',
                  phase: 'stopped',
                  partial: false,
                  cancelled: 0,
                  progress: { done: 4, total: 10, remaining: 0 }
                }
              }
            }
          }],
          attackCompletion: {
            partial: false,
            engines: {
              DAST: {
                status: 'cancelled',
                phase: 'stopped',
                partial: false,
                cancelled: 0
              }
            }
          }
        }
      }
    }
  });

  assert.equal(summary.engineParticipation.DAST.evidence, true);
  assert.equal(summary.engineParticipation.DAST.failedObserved, false);
  assert.equal(summary.engineParticipation.DAST.completionStatus, 'completed');
});

test('ptk lifecycle summary reads root SAST lifecycle fields before progress counters', () => {
  const summary = summarizePtkLifecycle({
    coverage: {
      ptk: {
        exported: true,
        lifecycle: {
          scanStarted: true,
          exportSucceeded: true,
          rawStatusSamples: [{
            stage: 'during-drain',
            status: {
              engines: {
                SAST: {
                  status: 'running',
                  phase: 'waiting',
                  collectionState: 'waiting_for_page_activity',
                  analysisState: 'complete',
                  isAnalysisRunning: false,
                  progress: {
                    done: 11,
                    total: 11,
                    remaining: 0
                  }
                }
              }
            }
          }],
          attackCompletion: {
            partial: false,
            engines: {
              SAST: {
                status: 'running',
                phase: 'waiting',
                planned: 11,
                completed: 11,
                remaining: 0,
                partial: false
              }
            }
          }
        }
      }
    }
  });

  assert.equal(summary.sastState, 'idle/waiting');
  assert.equal(summary.sastCollectionState, 'waiting_for_page_activity');
  assert.equal(summary.sastAnalysisState, 'complete');
  assert.equal(summary.engineIncomplete, false);
});

test('ptk lifecycle summary prefers complete SAST counters over stale raw analyzing state', () => {
  const summary = summarizePtkLifecycle({
    coverage: {
      ptk: {
        exported: true,
        lifecycle: {
          scanStarted: true,
          exportSucceeded: true,
          rawStatusSamples: [{
            stage: 'after-stop',
            status: {
              engines: {
                SAST: {
                  status: 'running',
                  phase: 'file',
                  runtime: {
                    collectionState: 'analysis_running',
                    analysisState: 'analyzing'
                  },
                  progress: {
                    done: 6,
                    total: 6,
                    remaining: 0
                  }
                }
              }
            }
          }],
          attackCompletion: {
            partial: false,
            engines: {
              SAST: {
                status: 'idle',
                phase: 'waiting',
                planned: 6,
                completed: 6,
                remaining: 0,
                partial: false
              }
            }
          }
        }
      }
    }
  });

  assert.equal(summary.sastState, 'idle/waiting');
  assert.equal(summary.sastCollectionState, 'completed');
  assert.equal(summary.sastAnalysisState, 'complete');
  assert.equal(summary.engineIncomplete, false);
});

test('ptk lifecycle summary normalizes complete SAST counters away from running file state', () => {
  const summary = summarizePtkLifecycle({
    coverage: {
      ptk: {
        exported: true,
        lifecycle: {
          scanStarted: true,
          exportSucceeded: true,
          rawStatusSamples: [{
            stage: 'during-drain',
            status: {
              engines: {
                SAST: {
                  status: 'running',
                  phase: 'file',
                  collectionState: 'completed',
                  analysisState: 'complete',
                  progress: { done: 6, total: 6, remaining: 0 }
                }
              }
            }
          }],
          attackCompletion: {
            partial: false,
            engines: {
              SAST: {
                status: 'running',
                phase: 'file',
                planned: 6,
                completed: 6,
                remaining: 0,
                partial: false
              }
            }
          }
        }
      }
    }
  });

  assert.equal(summary.sastState, 'complete');
  assert.equal(summary.sastCollectionState, 'completed');
  assert.equal(summary.sastAnalysisState, 'complete');
  assert.equal(summary.engineIncomplete, false);
});
