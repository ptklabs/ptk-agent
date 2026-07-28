'use strict';

const { compileMissions, compileMissionCandidates, summarizeMissionCompiler } = require('./missionCompiler.cjs');
const { createManagerProvider } = require('./managerProvider.cjs');
const { executeMission, notExecutableMission } = require('./missionExecutor.cjs');
const { createAgentRunMemory } = require('./runMemory.cjs');
const { loadRuntimeSkill } = require('./skills.cjs');
const { validateProviderDecision } = require('./providerDecisionGuard.cjs');
const { createAgentHandleRegistry, issueHandlesForMissions } = require('./handles.cjs');
const { normalizeProviderPlan, validateActionPlan } = require('./actionPlan.cjs');
const { createAgentToolExecutor } = require('./toolExecutor.cjs');
const { coverageCounts, hasCoverageDelta, hasMeaningfulCoverageDelta } = require('./actionEffectRecorder.cjs');
const { createFindingFingerprintDiff, findingMap } = require('../core/findingDiff.cjs');

async function runAgentManagerV2({ config, coverage, scenarioStatus, evidence, telemetry, provider = null, context = {}, handlers = {} } = {}) {
  const agentConfig = {
    enabled: false,
    mode: 'off',
    maxTurns: 1,
    maxStepsPerTurn: 1,
    riskMode: 'safe',
    allowBusinessMutations: false,
    allowDestructiveActions: false,
    requireSuccess: false,
    ...(config && config.agent || {})
  };
  if (context.cwd && !agentConfig.cwd) agentConfig.cwd = context.cwd;
  if (!agentConfig.enabled || agentConfig.mode === 'off') {
    return {
      status: 'skipped',
      requested: agentConfig.mode || 'off',
      actual: 'off',
      telemetry: { actualMode: 'off', fallbackReason: 'agent-disabled' },
      missions: [],
      choices: [],
      reason: 'agent_disabled'
    };
  }
  if (context.baselineComplete === false) {
    return {
      status: 'skipped',
      telemetry: { actualMode: 'off', fallbackReason: 'baseline-not-complete' },
      missions: [],
      results: []
    };
  }
  if (provider && provider.kind && !['mock', 'opencode', 'codex'].includes(provider.kind)) {
    return {
      status: 'fallback',
      telemetry: {
        actualMode: 'off',
        fallbackMode: agentConfig.fallback || 'fail',
        fallbackReason: `Unsupported manager provider: ${provider.kind}`
      },
      missions: [],
      results: []
    };
  }
  let chosenProvider;
  try {
    chosenProvider = provider || createManagerProvider(agentConfig);
  } catch (err) {
    return {
      status: 'fallback',
      requested: agentConfig.mode,
      actual: 'off',
      telemetry: {
        actualMode: 'off',
        fallbackMode: agentConfig.fallback || 'fail',
        fallbackReason: err && err.message ? err.message : String(err)
      },
      missions: [],
      choices: [],
      results: [],
      reason: 'provider_create_failed'
    };
  }
  const skill = loadRuntimeSkill();
  const runMemory = context.runMemory || createAgentRunMemory(agentConfig.runMemory || {});
  const baselineCoverage = context.coverage || coverage || {};
  const baselineCounts = coverageCounts(baselineCoverage);
  const choices = [];
  const results = [];
  const turnRecords = [];
  const actionPlans = [];
  const executionResults = [];
  const providerDecisionQuality = [];
  const missionCompilerRecords = [];
  const completedMissionIds = new Set();
  const suppressedMissionIds = new Set();
  const totalActualDelta = emptyDelta();
  let turnIndex = 0;
  let stopReason = null;
  let finalStatus = 'stopped';
  let lastResult = null;
  const providerTimeoutMs = Number(agentConfig.maxProviderMs) > 0 ? Number(agentConfig.maxProviderMs) : 60000;
  while (turnIndex < agentConfig.maxTurns) {
    turnIndex += 1;
    const handles = createAgentHandleRegistry({ turn: turnIndex });
    const observation = await executorSafeObserve({ config, context, handles, turn: turnIndex, telemetry });
    const missionResolution = resolveTurnMissions({
      context,
      coverage: context.coverage || coverage,
      scenarioStatus,
      evidence,
      runMemory,
      completedMissionIds,
      suppressedMissionIds,
      handles,
      observation,
      agentConfig
    });
    const missions = missionResolution.missions;
    missionCompilerRecords.push(missionResolution.summary);
    if (!missions.length) {
      stopReason = missionResolution.skipReason || 'no_executable_missions';
      finalStatus = results.length ? 'completed' : 'no_executable_missions';
      break;
    }
    const handlesByMission = issueHandlesForMissions(handles, missions);
    const turnRecord = {
      turn: turnIndex,
      missionCount: missions.length,
      handleCount: handles.snapshot().length,
      observationSummary: observation && observation.currentPage || null,
      startedAt: new Date().toISOString()
    };
    let choice;
    try {
      emitAgentLifecycle(context, 'provider_started', {
        turn: turnIndex,
        provider: chosenProvider && chosenProvider.kind || null,
        timeoutMs: providerTimeoutMs,
        missionCount: missions.length
      });
      choice = await withProviderTimeout(chosenProvider.chooseMission({
        missions,
        missionCandidates: missions,
        coverage: context.coverage || coverage,
        scenarioStatus,
        evidence,
        handles: handles.snapshot(),
        observation,
        handlesByMission,
        skill: { name: skill.name, version: skill.version, hash: skill.hash }
      }), providerTimeoutMs);
      emitAgentLifecycle(context, 'provider_completed', {
        turn: turnIndex,
        provider: chosenProvider && chosenProvider.kind || null,
        missionId: choice && choice.missionId || null,
        reason: choice && choice.reason || null
      });
    } catch (err) {
      const providerKind = chosenProvider && chosenProvider.kind || 'manager';
      if (err && err.code === 'ERR_PTK_AGENT_PROVIDER_TIMEOUT') {
        telemetry && telemetry.event('agent.provider.timeout', {
          provider: providerKind,
          timeoutMs: providerTimeoutMs
        });
        emitAgentLifecycle(context, 'provider_timeout', {
          turn: turnIndex,
          provider: providerKind,
          timeoutMs: providerTimeoutMs,
          error: err.message
        });
        choice = {
          missionId: null,
          reason: 'provider_timeout',
          provider: providerKind,
          timeoutMs: providerTimeoutMs,
          error: err.message
        };
      } else {
        emitAgentLifecycle(context, 'provider_failed', {
          turn: turnIndex,
          provider: providerKind,
          error: err && err.message ? err.message : String(err)
        });
        choice = {
          missionId: null,
          reason: `${providerKind}_provider_exception`,
          provider: chosenProvider && chosenProvider.kind || null,
          error: err && err.message ? err.message : String(err)
        };
      }
    }
    if (choice && choice.missionId) {
      choice = resolveChoiceMissionAlias(choice, {
        missions,
        handles,
        turn: turnIndex
      });
    }
    if (!choice || !choice.missionId) {
      choices.push(choice);
      providerDecisionQuality.push({
        turn: turnIndex,
        provider: choice && choice.provider || chosenProvider && chosenProvider.kind || null,
        missionId: null,
        decisionAllowed: false,
        decisionReason: choice && choice.reason || 'provider_returned_no_mission',
        errors: choice && choice.error ? [choice.error] : []
      });
      const result = {
        ok: false,
        status: 'provider_failed',
        missionId: null,
        kind: 'provider-choice',
        reason: choice && choice.reason || 'provider_returned_no_mission',
        provider: choice && choice.provider || chosenProvider && chosenProvider.kind || null,
        error: choice && choice.error || null,
        timeoutMs: choice && choice.timeoutMs || null,
        stdout: choice && choice.stdout || null,
        stderr: choice && choice.stderr || null
      };
      results.push(result);
      lastResult = result;
      stopReason = result.reason;
      finalStatus = finalStatusAfterProviderFailure(results);
      turnRecord.choice = choice;
      turnRecord.result = result;
      turnRecord.endedAt = new Date().toISOString();
      turnRecords.push(turnRecord);
      telemetry && telemetry.event('agent.choice', { choice, result });
      break;
    }
    const decision = validateProviderDecision(choice, { missions });
    choice = decision.choice;
    choices.push(choice);
    providerDecisionQuality.push({
      turn: turnIndex,
      provider: choice.provider || chosenProvider && chosenProvider.kind || null,
      missionId: choice.missionId,
      decisionAllowed: Boolean(decision.allowed),
      decisionReason: decision.reason,
      errors: decision.errors || []
    });
    if (!decision.allowed) {
      const result = {
        ok: false,
        status: 'provider_failed',
        missionId: choice && choice.missionId || null,
        kind: 'provider-choice',
        reason: decision.reason,
        errors: decision.errors,
        provider: choice && choice.provider || chosenProvider && chosenProvider.kind || null
      };
      results.push(result);
      lastResult = result;
      stopReason = result.reason;
      finalStatus = finalStatusAfterProviderFailure(results);
      turnRecord.choice = choice;
      turnRecord.result = result;
      turnRecord.endedAt = new Date().toISOString();
      turnRecords.push(turnRecord);
      telemetry && telemetry.event('agent.choice.rejected', { choice, errors: decision.errors });
      break;
    }
    const mission = missions.find(candidate => candidate.id === choice.missionId);
    if (!mission) {
      const result = {
        ok: false,
        status: 'provider_failed',
        missionId: choice.missionId,
        kind: 'provider-choice',
        reason: 'provider_selected_unknown_mission',
        provider: choice.provider || chosenProvider && chosenProvider.kind || null
      };
      results.push(result);
      lastResult = result;
      stopReason = result.reason;
      finalStatus = finalStatusAfterProviderFailure(results);
      turnRecord.choice = choice;
      turnRecord.result = result;
      turnRecord.endedAt = new Date().toISOString();
      turnRecords.push(turnRecord);
      telemetry && telemetry.event('agent.choice', { choice, result });
      break;
    }
    const routeHandle = handlesByMission.get(mission.id) || null;
    const normalized = normalizeProviderPlan(choice, { mission, routeHandle });
    if (!normalized.ok) {
      const result = {
        ok: false,
        status: 'provider_failed',
        missionId: mission.id,
        kind: 'provider-plan',
        reason: normalized.reason,
        errors: normalized.errors,
        provider: choice.provider || chosenProvider && chosenProvider.kind || null
      };
      results.push(result);
      lastResult = result;
      stopReason = result.reason;
      finalStatus = finalStatusAfterProviderFailure(results);
      turnRecord.choice = choice;
      turnRecord.result = result;
      turnRecord.endedAt = new Date().toISOString();
      turnRecords.push(turnRecord);
      break;
    }
    const planDecision = validateActionPlan(normalized.plan, {
      missions,
      handles,
      turn: turnIndex,
      agentConfig
    });
    actionPlans.push({
      turn: turnIndex,
      plan: planDecision.redactedPlan || planDecision.plan || normalized.plan,
      allowed: Boolean(planDecision.allowed),
      rejectReason: planDecision.rejectReason || null,
      errors: planDecision.errors || []
    });
    if (!planDecision.allowed) {
      const result = {
        ok: false,
        status: 'provider_failed',
        missionId: mission.id,
        kind: 'provider-plan',
        reason: planDecision.rejectReason || planDecision.reason,
        errors: planDecision.errors,
        provider: choice.provider || chosenProvider && chosenProvider.kind || null
      };
      results.push(result);
      lastResult = result;
      stopReason = result.reason;
      finalStatus = finalStatusAfterProviderFailure(results);
      turnRecord.choice = choice;
      turnRecord.result = result;
      turnRecord.endedAt = new Date().toISOString();
      turnRecords.push(turnRecord);
      telemetry && telemetry.event('agent.plan.rejected', { missionId: mission.id, errors: planDecision.errors });
      break;
    }
    const executorContext = {
      ...context,
      coverage: context.coverage || coverage || {}
    };
    const executor = createAgentToolExecutor({
      config,
      session: context.session || context.liveSession && context.session || context.livePage && { page: context.livePage } || null,
      context: executorContext,
      handles,
      telemetry,
      executeRoute: createRouteExecutor({ mission, context, handlers }),
      profileResolver: context.profileResolver || null
    });
    const stepResults = [];
    for (const step of planDecision.plan.steps || []) {
      const execution = await executor.executeStep({
        mission,
        plan: planDecision.plan,
        step,
        turn: turnIndex
      });
      stepResults.push(execution);
      executionResults.push({ turn: turnIndex, ...execution });
      addDelta(totalActualDelta, execution.actualDelta || {});
      if (execution.status !== 'completed') break;
    }
    context.coverage = executorContext.coverage;
    const result = missionResultFromExecutions({ mission, plan: planDecision.plan, stepResults });
    if (result.effects) {
      for (const effect of result.effects) runMemory.recordEffect(effect);
    }
    if (result.status === 'completed') completedMissionIds.add(mission.id);
    if (result.status === 'no_progress' || result.status === 'not_executable') suppressedMissionIds.add(mission.id);
    results.push(result);
    lastResult = result;
    turnRecord.choice = choice;
    turnRecord.result = result;
    turnRecord.endedAt = new Date().toISOString();
    turnRecords.push(turnRecord);
    telemetry && telemetry.event('agent.choice', { choice, result });
    if (result.status === 'completed') {
      finalStatus = 'completed';
      continue;
    }
    if (result.status === 'no_progress') {
      finalStatus = 'no_progress';
      if (countNoProgress(results) >= Number(agentConfig.maxNoProgress || 2)) {
        stopReason = 'no_progress_limit';
        break;
      }
      continue;
    }
    if (result.status === 'recover_auth_required' || result.status === 'failed') {
      finalStatus = result.status;
      stopReason = result.reason || result.status;
      break;
    }
  }
  if (!stopReason && turnIndex >= agentConfig.maxTurns) stopReason = 'max_turns';
  const returnStatus = finalStatusAfterLoop(finalStatus, results);
  return managerReturn({
    agentConfig,
    chosenProvider,
    status: returnStatus || 'stopped',
    telemetryExtra: returnStatus === 'provider_failed' ? { fallbackReason: stopReason, provider: chosenProvider && chosenProvider.kind || null } : {},
    missions: context.missionCandidates
      ? context.missionCandidates.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id || '').localeCompare(String(b.id || '')))
      : compileMissions({ coverage: context.coverage || coverage, scenarioStatus, evidence }),
    choices,
    results,
    result: lastResult,
    skill,
    runMemory,
    turns: turnRecords,
    actionPlans,
    executionResults,
    providerDecisionQuality,
    totalActualDelta,
    stopReason,
    baselineCoverage,
    finalCoverage: context.coverage || coverage || baselineCoverage,
    missionCompilerRecords
  });
}

function hasUsefulAgentResult(results = []) {
  return (results || []).some(result => {
    if (!result || result.status !== 'completed') return false;
    if (hasMeaningfulCoverageDelta(result.actualDelta || result.coverageDelta || {})) return true;
    return Array.isArray(result.results) && result.results.some(step => step && step.browserActionRan && step.transitionValidated);
  });
}

function finalStatusAfterProviderFailure(results = []) {
  return hasUsefulAgentResult(results) ? 'completed_with_agent_failure' : 'provider_failed';
}

function finalStatusAfterLoop(status, results = []) {
  if (status === 'no_progress' && hasUsefulAgentResult(results)) return 'completed';
  if ((status === 'failed' || status === 'recover_auth_required') && hasUsefulAgentResult(results)) {
    return 'completed_with_agent_failure';
  }
  return status;
}

function resolveChoiceMissionAlias(choice = {}, { missions = [], handles = null, turn = 0 } = {}) {
  if (!choice || !choice.missionId) return choice;
  if ((missions || []).some(mission => mission && mission.id === choice.missionId)) {
    return choice;
  }
  if (!handles || typeof handles.validate !== 'function') return choice;
  const handleIds = collectChoiceStepHandleIds(choice);
  if (!handleIds.length) return choice;
  const candidates = new Map();
  for (const handleId of handleIds) {
    const validation = handles.validate(handleId, { turn });
    if (!validation.ok || !validation.handle) continue;
    for (const mission of missionsForHandle(validation.handle, missions)) {
      candidates.set(mission.id, { mission, handle: validation.handle });
    }
  }
  if (candidates.size !== 1) return choice;
  const [{ mission, handle }] = Array.from(candidates.values());
  return {
    ...choice,
    providerMissionId: choice.missionId,
    missionId: mission.id,
    missionAliasResolved: {
      reason: 'fresh_handle_unambiguous_mission',
      originalMissionId: choice.missionId,
      resolvedMissionId: mission.id,
      handleId: handle.id,
      handleType: handle.type,
      handleSource: handle.source || null
    }
  };
}

function collectChoiceStepHandleIds(choice = {}) {
  const ids = [];
  for (const step of Array.isArray(choice.steps) ? choice.steps : []) {
    const target = step && step.target || {};
    for (const key of ['surfaceId', 'controlId', 'formId', 'routeHandleId', 'routeId']) {
      if (target[key]) ids.push(target[key]);
    }
  }
  return ids;
}

function missionsForHandle(handle = {}, missions = []) {
  const directMatches = missions.filter(mission => missionDirectlyOwnsHandle(mission, handle));
  if (directMatches.length > 0) return directMatches;
  const summaryMissionId = handle.summary && handle.summary.missionId;
  if (summaryMissionId) return missions.filter(mission => mission && mission.id === summaryMissionId);
  return missions.filter(mission => missionMatchesHandle(mission, handle));
}

function missionDirectlyOwnsHandle(mission = {}, handle = {}) {
  if (!mission || !handle || !handle.id) return false;
  if (handle.type === 'surface') return mission.surfaceHandleId === handle.id;
  if (handle.type === 'control') return mission.controlHandleId === handle.id;
  if (handle.type === 'form') return mission.formHandleId === handle.id;
  if (handle.type === 'route') return mission.routeHandleId === handle.id;
  return false;
}

function missionMatchesHandle(mission = {}, handle = {}) {
  if (!mission || !handle) return false;
  if (handle.type === 'route') {
    return Boolean(handle.routeKey && mission.route && sameRouteKey(mission.route, handle.routeKey));
  }
  if (handle.type === 'surface' || handle.type === 'control') {
    return Boolean(handle.routeKey && mission.route && sameRouteKey(mission.route, handle.routeKey) && [
      'auth-surface-traversal',
      'surface-expanded-route',
      'business-flow-continuation',
      'scenario-unblock'
    ].includes(mission.kind));
  }
  if (handle.type === 'form') {
    return Boolean(handle.routeKey && mission.route && sameRouteKey(mission.route, handle.routeKey) && /form|captcha|credential|required|no-transition|multi-step|business-flow/.test(String(mission.kind || '')));
  }
  return false;
}

function sameRouteKey(left, right) {
  return String(left || '') === String(right || '');
}

function resolveTurnMissions({
  context = {},
  coverage = {},
  scenarioStatus = null,
  evidence = {},
  runMemory = null,
  completedMissionIds = new Set(),
  suppressedMissionIds = new Set(),
  handles = null,
  observation = null,
  agentConfig = {}
} = {}) {
  const baseCompiled = context.missionCandidates
    ? context.missionCandidates.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id || '').localeCompare(String(b.id || '')))
    : compileMissions({ coverage, scenarioStatus, evidence });
  const noScenarioMode = context.noScenarioMode === true || context.scenarioVariant === 'no-scenario' || context.scenarioSetup === 'auth-only';
  const compiled = mergeMissions(baseCompiled, liveHandleMissions({
    handles,
    observation,
    coverage,
    noScenarioMode,
    agentConfig
  }));
  const suppressed = [];
  const filtered = compiled.filter(mission => {
    if (!mission || !mission.id) return false;
    if (completedMissionIds.has(mission.id) || suppressedMissionIds.has(mission.id)) {
      suppressed.push({ mission, reason: 'already_covered_no_delta' });
      return false;
    }
    if (runMemory && runMemory.shouldSuppress && runMemory.shouldSuppress(mission)) {
      suppressed.push({ mission, reason: 'already_covered_no_delta' });
      return false;
    }
    if (mission.kind === 'broad-coverage-tail') {
      suppressed.push({ mission, reason: 'low_value' });
      return false;
    }
    const lowValue = lowValueMissionReason(mission, coverage);
    if (lowValue) {
      suppressed.push({ mission, reason: lowValue });
      return false;
    }
    const policyDenied = missionPolicySuppressionReason(mission, agentConfig);
    if (policyDenied) {
      suppressed.push({ mission, reason: policyDenied });
      return false;
    }
    return true;
  });
  const sorted = sortMissionsWithRunMemory(filtered, runMemory);
  const providerMissions = deferPtkRouteReplayWhenBusinessWorkExists(sorted, suppressed);
  if (noScenarioMode && !providerMissions.some(isHighConfidenceExecutableMission)) {
    return {
      missions: [],
      skipReason: 'no_high_confidence_executable_missions',
      summary: summarizeMissionCompiler({
        offered: [],
        suppressed,
        skipped: providerMissions.map(mission => ({ mission, reason: 'no_scenario_gating' }))
      })
    };
  }
  return {
    missions: providerMissions,
    skipReason: null,
    summary: summarizeMissionCompiler({ offered: providerMissions, suppressed, skipped: [] })
  };
}

function deferPtkRouteReplayWhenBusinessWorkExists(missions = [], suppressed = []) {
  const hasBusinessWork = missions.some(isBusinessPlanningMission);
  if (!hasBusinessWork) return missions;
  return missions.filter(mission => {
    if (mission.kind !== 'ptk-finding-entrypoint-reproduction') return true;
    suppressed.push({ mission, reason: 'deferred_for_business_mission' });
    return false;
  });
}

function isBusinessPlanningMission(mission = {}) {
  if (!mission || mission.executable === false) return false;
  if (mission.surfaceHandleId || mission.controlHandleId || mission.formHandleId) return true;
  return new Set([
    'scenario-unblock',
    'auth-surface-traversal',
    'surface-expanded-route',
    'business-flow-continuation',
    'form-validation-repair',
    'missing-required-fields',
    'wrong-credential-field',
    'submitted-no-transition',
    'multi-step-form-next'
  ]).has(mission.kind);
}

function mergeMissions(base = [], extra = []) {
  const seen = new Set();
  const out = [];
  for (const mission of [...(base || []), ...(extra || [])]) {
    if (!mission || !mission.id || seen.has(mission.id)) continue;
    seen.add(mission.id);
    out.push(mission);
  }
  return out.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id || '').localeCompare(String(b.id || '')));
}

function liveHandleMissions({ handles = null, observation = null, coverage = {}, noScenarioMode = false, agentConfig = {} } = {}) {
  if (!handles || typeof handles.all !== 'function') return [];
  const missions = [];
  const currentPage = observation && observation.currentPage || {};
  const authSignals = currentPage && Array.isArray(currentPage.authSignals) ? currentPage.authSignals : [];
  const authenticated = authSignals.some(signal => /auth|login|account|profile|session/i.test(String(signal || '')));
  for (const handle of handles.all()) {
    if (!handle || handle.type === 'route') continue;
    if (handle.type === 'surface') {
      missions.push({
        id: `mission:auth-surface-traversal:${stableHandleToken(handle)}`,
        kind: 'auth-surface-traversal',
        priority: authenticated ? 150 : 138,
        reason: authenticated
          ? 'authenticated surface can expose multiple safe account or navigation routes'
          : 'navigation surface can expose additional same-origin routes',
        source: handle.source || 'live-handle',
        route: handle.routeKey || null,
        executable: true,
        policyTier: handle.policyTier || 'safe',
        riskModeRequired: handle.policyTier || 'safe',
        surfaceHandleId: handle.id,
        noProgressKey: liveHandleNoProgressKey(handle),
        noProgressSuppressAfter: 1,
        allowedCapabilities: ['surface.open', 'control.click', 'mission:plan'],
        liveHandleSummary: handle.summary || null
      });
      continue;
    }
    if (handle.type === 'form') {
      const kind = formMissionKind(handle);
      const decision = formMissionDecision(handle, kind, { noScenarioMode, agentConfig });
      missions.push({
        id: `mission:${kind}:${stableHandleToken(handle)}`,
        kind,
        priority: liveFormMissionPriority(kind, decision.priority),
        reason: decision.reason || formMissionReason(kind),
        source: handle.source || 'live-handle',
        route: handle.routeKey || null,
        executable: decision.executable,
        notExecutableReason: decision.notExecutableReason || null,
        policyTier: decision.policyTier,
        riskModeRequired: decision.policyTier,
        formHandleId: handle.id,
        noProgressKey: liveHandleNoProgressKey(handle),
        noProgressSuppressAfter: 1,
        allowedCapabilities: decision.executable ? ['form.fill', 'form.submit', 'mission:plan'] : ['mission:plan'],
        liveHandleSummary: handle.summary || null
      });
      continue;
    }
    if (handle.type === 'control' && controlLooksExecutable(handle, coverage, currentPage)) {
      const tier = handle.policyTier || 'safe';
      missions.push({
        id: `mission:business-flow-continuation:${stableHandleToken(handle)}`,
        kind: tier === 'safe' ? 'surface-expanded-route' : 'business-flow-continuation',
        priority: tier === 'safe' ? 140 : 132,
        reason: tier === 'safe'
          ? 'fresh control appears to navigate or reveal additional surface state'
          : 'fresh business-tier control may continue an executable workflow',
        source: handle.source || 'live-handle',
        route: handle.routeKey || null,
        executable: true,
        policyTier: tier,
        riskModeRequired: tier,
        controlHandleId: handle.id,
        noProgressKey: liveHandleNoProgressKey(handle),
        noProgressSuppressAfter: 1,
        allowedCapabilities: ['control.click', 'mission:plan'],
        liveHandleSummary: handle.summary || null
      });
    }
  }
  return missions;
}

function liveFormMissionPriority(kind, fallback = 116) {
  if (kind === 'wrong-credential-field') return 146;
  if (kind === 'form-validation-repair') return 144;
  if (kind === 'multi-step-form-next') return 142;
  if (kind === 'missing-required-fields') return 136;
  return Math.max(Number(fallback) || 0, 132);
}

function stableHandleToken(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const stableParts = {
    type: handle.type || 'handle',
    routeKey: normalizeComparableRoute(handle.routeKey || ''),
    stateKey: stableStateKey(handle.stateKey || ''),
    source: handle.source || null,
    kind: summary.kind || target.kind || null,
    semanticKind: summary.semanticKind || target.semanticKind || null,
    label: summary.label || target.label || target.text || target.ariaLabel || null,
    href: summary.href || target.href || null,
    expectedEffect: summary.expectedEffect || target.expectedEffect || target.expectedEffectGuess || null,
    policyTier: handle.policyTier || null
  };
  return String(JSON.stringify(stableParts))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'handle';
}

function liveHandleNoProgressKey(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const semanticKind = summary.semanticKind || target.semanticKind || target.kind || summary.kind || null;
  const label = summary.label || target.label || target.text || target.ariaLabel || target.name || null;
  const href = summary.href || target.href || target.url || null;
  const formSignature = summary.fieldSignature || target.fieldSignature || summary.formSignature || target.formSignature || null;
  const stableParts = {
    routeKey: normalizeComparableRoute(handle.routeKey || ''),
    stateKey: stableStateKey(handle.stateKey || ''),
    policyTier: handle.policyTier || null,
    semanticKind,
    label,
    href,
    formSignature,
    expectedEffect: summary.expectedEffect || target.expectedEffect || target.expectedEffectGuess || null
  };
  return String(JSON.stringify(stableParts))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || null;
}

function stableStateKey(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function formMissionKind(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const text = JSON.stringify({
    summary: compactFormSignalSummary(summary),
    target: compactFormSignalSummary(target)
  }).toLowerCase();
  if (/captcha/.test(text)) return 'captcha-blocked';
  if (formHasStructuredRepairSignal(handle)) return 'form-validation-repair';
  if (/credential|email|username|password|login|auth/.test(text)) return 'wrong-credential-field';
  return 'missing-required-fields';
}

function formMissionDecision(handle = {}, kind = 'missing-required-fields', { noScenarioMode = false, agentConfig = {} } = {}) {
  const baseTier = handle.policyTier || 'safe';
  const accountCreation = isAccountCreationFormHandle(handle);
  const fileUpload = isFileUploadFormHandle(handle);
  if (kind === 'captcha-blocked') {
    return {
      executable: false,
      notExecutableReason: 'captcha_blocked',
      policyTier: 'safe',
      priority: 96,
      reason: formMissionReason(kind)
    };
  }
  if (fileUpload && agentConfig.allowFileUploadMissions !== true) {
    return {
      executable: false,
      notExecutableReason: 'upload_fixture_required',
      policyTier: 'business',
      priority: 78,
      reason: 'file upload forms require an explicit upload fixture or scenario intent before agent repair'
    };
  }
  if (accountCreation) {
    const businessAllowed = Boolean(
      agentConfig.allowBusinessMutations ||
      agentConfig.allowDestructiveActions ||
      agentConfig.riskMode === 'business' ||
      agentConfig.riskMode === 'destructive'
    );
    if (!businessAllowed || noScenarioMode) {
      return {
        executable: false,
        notExecutableReason: noScenarioMode ? 'account_creation_not_high_confidence' : 'business_policy_required',
        policyTier: 'business',
        priority: 82,
        reason: 'account creation forms are not safe default form-repair missions'
      };
    }
    return {
      executable: true,
      notExecutableReason: null,
      policyTier: 'business',
      priority: 96,
      reason: 'business-tier account creation form may require explicit policy'
    };
  }
  if (['missing-required-fields', 'form-validation-repair'].includes(kind) && isWeakGenericFormHandle(handle)) {
    return {
      executable: false,
      notExecutableReason: 'generic_form_without_repair_signal',
      policyTier: baseTier,
      priority: 70,
      reason: 'generic form lacks validation, required-field, or business-flow evidence'
    };
  }
  return {
    executable: true,
    notExecutableReason: null,
    policyTier: baseTier,
    priority: kind === 'wrong-credential-field' ? 110 : 116,
    reason: formMissionReason(kind)
  };
}

function isWeakGenericFormHandle(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const kind = String(summary.kind || target.kind || '').toLowerCase();
  const semanticKind = String(summary.semanticKind || target.semanticKind || '').toLowerCase();
  const text = JSON.stringify({
    summary,
    fields: target.fields,
    action: target.action,
    route: handle.routeKey
  }).toLowerCase();
  const knownBusinessKind = /(feedback|contact|search|login|auth|transfer|checkout|cart|profile|address|payment|wallet|order|settings)/.test(`${kind} ${semanticKind}`);
  const hasRepairSignal = formHasStructuredRepairSignal(handle);
  const requiredField = [
    ...(Array.isArray(summary.fields) ? summary.fields : []),
    ...(Array.isArray(target.fields) ? target.fields : [])
  ].some(field => field && (field.required === true || String(field.ariaRequired || field.required || '').toLowerCase() === 'true'));
  return !knownBusinessKind && !hasRepairSignal && !requiredField;
}

function compactFormSignalSummary(value = {}) {
  if (!value || typeof value !== 'object') return {};
  return {
    id: value.id || null,
    kind: value.kind || null,
    semanticKind: value.semanticKind || null,
    label: value.label || null,
    intent: value.intent || null,
    formPurpose: value.formPurpose || null,
    fieldNames: Array.isArray(value.fieldNames) ? value.fieldNames : null,
    fields: Array.isArray(value.fields)
      ? value.fields.map(field => ({
        name: field && field.name || null,
        id: field && field.id || null,
        label: field && field.label || null,
        type: field && (field.type || field.inputType) || null,
        required: field && (field.required === true || String(field.required || '').toLowerCase() === 'true') || false,
        ariaRequired: field && (field.ariaRequired === true || String(field.ariaRequired || '').toLowerCase() === 'true') || false
      }))
      : null
  };
}

function formHasStructuredRepairSignal(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  return Boolean(
    hasNonEmptySignal(summary.validation) ||
    hasNonEmptySignal(target.validation) ||
    hasNonEmptySignal(summary.validationMessage) ||
    hasNonEmptySignal(target.validationMessage) ||
    hasNonEmptySignal(summary.validationMessages) ||
    hasNonEmptySignal(target.validationMessages) ||
    hasNonEmptySignal(summary.errors) ||
    hasNonEmptySignal(target.errors) ||
    hasNonEmptySignal(summary.errorMessages) ||
    hasNonEmptySignal(target.errorMessages) ||
    summary.failedSubmission === true ||
    target.failedSubmission === true ||
    summary.noProgress === true ||
    target.noProgress === true ||
    summary.submittedNoTransition === true ||
    target.submittedNoTransition === true ||
    fieldsHaveRequiredSignal(summary.fields) ||
    fieldsHaveRequiredSignal(target.fields)
  );
}

function hasNonEmptySignal(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.some(hasNonEmptySignal);
  if (typeof value === 'object') return Object.keys(value).some(key => hasNonEmptySignal(value[key]));
  return String(value).trim().length > 0;
}

function fieldsHaveRequiredSignal(fields) {
  return Array.isArray(fields) && fields.some(field => field && (
    field.required === true ||
    String(field.required || '').toLowerCase() === 'true' ||
    field.ariaRequired === true ||
    String(field.ariaRequired || '').toLowerCase() === 'true'
  ));
}

function isAccountCreationFormHandle(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const text = [
    handle.routeKey,
    summary.id,
    summary.kind,
    summary.action,
    summary.label,
    summary.intent,
    summary.formPurpose,
    ...(Array.isArray(summary.fieldNames) ? summary.fieldNames : []),
    ...(Array.isArray(target.fields) ? target.fields.map(field => [field.name, field.id, field.label, field.placeholder, field.autocomplete].filter(Boolean).join(' ')) : [])
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:^|[\/#?&_\-\s])(register|registration|sign[ -]?up|signup|create[ -]?account|new[ -]?account)(?:$|[\/#?&_\-\s])/.test(text);
}

function isFileUploadFormHandle(handle = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const fields = [
    ...(Array.isArray(summary.fields) ? summary.fields : []),
    ...(Array.isArray(target.fields) ? target.fields : [])
  ];
  const fieldText = fields.map(field => {
    if (!field || typeof field !== 'object') return String(field || '');
    return [
      field.type,
      field.inputType,
      field.name,
      field.id,
      field.label,
      field.placeholder,
      field.autocomplete,
      field.accept
    ].filter(Boolean).join(' ');
  }).join(' ');
  const text = [
    handle.routeKey,
    summary.id,
    summary.kind,
    summary.semanticKind,
    summary.action,
    summary.label,
    summary.intent,
    summary.formPurpose,
    summary.fieldSignature,
    target.id,
    target.kind,
    target.semanticKind,
    target.action,
    target.label,
    target.intent,
    target.formPurpose,
    target.fieldSignature,
    ...(Array.isArray(summary.fieldNames) ? summary.fieldNames : []),
    fieldText
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:^|[\s_-])(file[ -]?upload|upload[ -]?file|attachment|input[^\n\r]{0,40}type[^\n\r]{0,10}file)(?:$|[\s_-])/.test(text) ||
    fields.some(field => String(field && (field.type || field.inputType) || '').toLowerCase() === 'file');
}

function formMissionReason(kind) {
  if (kind === 'captcha-blocked') return 'form appears blocked by captcha and should be classified, not solved';
  if (kind === 'form-validation-repair') return 'form has validation feedback or failed submission state';
  if (kind === 'wrong-credential-field') return 'credential-like form may need profile field mapping';
  return 'form has required fields that may need profile-backed values';
}

function controlLooksExecutable(handle = {}, coverage = {}, currentPage = {}) {
  const summary = handle.summary || {};
  if (isOffOriginControl(handle, currentPage)) return false;
  const text = [
    summary.kind,
    summary.label,
    summary.href,
    summary.expectedEffect,
    summary.semanticKind,
    summary.riskTier
  ].filter(Boolean).join(' ').toLowerCase();
  if (/logout|sign[ -]?out|delete|destroy|password reset/.test(text)) return false;
  if (/navigate|route|link|menu|drawer|tab|modal|account|profile|order|history|wallet|payment|address|setting|search|filter|next/.test(text)) return true;
  if (summary.href && !routeAlreadyCovered(summary.href, coverage)) return true;
  return false;
}

function isOffOriginControl(handle = {}, currentPage = {}) {
  const summary = handle.summary || {};
  const target = handle.target || {};
  const href = summary.href || target.href || summary.url || target.url || null;
  if (!href || typeof href !== 'string') return false;
  const trimmed = href.trim();
  if (!trimmed || /^(?:#|\/#)/.test(trimmed)) return false;
  if (/^(?:javascript|mailto|tel|data):/i.test(trimmed)) return true;
  const base = currentPage.url || currentPage.route || handle.routeKey || null;
  if (!base) return false;
  try {
    const resolved = new URL(trimmed, base);
    const origin = new URL(base).origin;
    return Boolean(resolved.origin && origin && resolved.origin !== origin);
  } catch (_) {
    return false;
  }
}

function routeAlreadyCovered(route, coverage = {}) {
  const wanted = new Set(routeComparableKeys(route));
  if (!wanted.size) return false;
  return Array.isArray(coverage.routes) && coverage.routes.some(item => {
    for (const candidate of coverageRouteCandidates(item)) {
      for (const key of routeComparableKeys(candidate)) {
        if (wanted.has(key)) return true;
      }
    }
    return false;
  });
}

function endpointRouteCandidates(mission = {}) {
  const endpoint = mission.endpoint || {};
  const candidates = [
    mission.route,
    endpoint.routeUrl,
    endpoint.route,
    endpoint.uiRoute,
    endpoint.entryRoute,
    endpoint.entrypointRoute,
    endpoint.uiPath,
    ...(Array.isArray(endpoint.candidateRoutes) ? endpoint.candidateRoutes : [])
  ];
  return candidates.map(candidate => {
    if (!candidate) return null;
    if (typeof candidate === 'string') return candidate;
    return candidate.url || candidate.href || candidate.route || candidate.path || candidate.routeKey || null;
  }).filter(Boolean);
}

function nonEmpty(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function normalizeComparableRoute(route) {
  return routeComparableKeys(route)[0] || null;
}

function routeComparableKeys(route) {
  if (!route) return [];
  const raw = typeof route === 'string'
    ? route
    : route.url || route.href || route.path || route.route || route.routeKey || route.routeShape || null;
  if (!raw) return [];
  const value = String(raw).trim();
  if (!value) return [];
  const keys = new Set();
  const add = candidate => {
    const normalized = String(candidate || '').trim().replace(/\/+$/, '') || '/';
    keys.add(normalized);
  };
  add(value);
  if (value.startsWith('#/')) add(`/${value}`);
  if (value.startsWith('#!/')) add(`/#${value.slice(2)}`);
  try {
    const url = new URL(value, 'http://ptk.local');
    add(`${url.pathname || '/'}${url.search || ''}${url.hash || ''}`);
    if (url.hash && /^#!?\//.test(url.hash)) {
      add(`${url.pathname || '/'}${url.search || ''}${url.hash.replace(/^#!/, '#/')}`);
    }
  } catch (_) {}
  return Array.from(keys);
}

function coverageRouteCandidates(item = {}) {
  if (!item) return [];
  if (typeof item === 'string') return [item];
  return [
    item.url,
    item.href,
    item.path,
    item.route,
    item.routeKey,
    item.routeShape,
    item.shape,
    item.coverage && item.coverage.url
  ].filter(Boolean);
}

function isLowValueMission(mission = {}, coverage = {}) {
  return Boolean(lowValueMissionReason(mission, coverage));
}

function lowValueMissionReason(mission = {}, coverage = {}) {
  if (mission.executable === false) {
    return mission.notExecutableReason || 'no_executable_steps';
  }
  const route = mission.route || mission.routeHint && (mission.routeHint.url || mission.routeHint.route || mission.routeHint.path);
  if (route && routeCoveredNoDeltaSuppressesMission(mission) && routeAlreadyCovered(route, coverage)) {
    return 'already_covered_no_delta';
  }
  if (/logout|sign[ -]?out|delete|destroy|password reset/i.test(`${mission.id || ''} ${mission.reason || ''}`)) {
    return 'policy_denied';
  }
  if (mission.kind === 'endpoint-backed-ui-flow') {
    if (mission.executable === false || mission.notExecutableReason === 'endpoint_without_ui_path') {
      return 'endpoint_without_ui_path';
    }
    const endpoint = mission.endpoint || {};
    const routeCandidates = endpointRouteCandidates(mission);
    const hasControlOrFormCandidate = Boolean(
      nonEmpty(endpoint.candidateControls) ||
      nonEmpty(endpoint.candidateForms) ||
      endpoint.uiTrigger ||
      endpoint.controlId ||
      endpoint.formId
    );
    if (!routeCandidates.length && !hasControlOrFormCandidate) return 'endpoint_without_ui_path';
    if (routeCandidates.length && routeCandidates.every(candidate => routeAlreadyCovered(candidate, coverage)) && !hasControlOrFormCandidate) {
      return 'already_covered_no_delta';
    }
  }
  if (mission.kind === 'graphql-operation-flow') {
    if (mission.executable === false || mission.notExecutableReason === 'endpoint_without_ui_path') {
      return 'endpoint_without_ui_path';
    }
  }
  if (mission.kind === 'hidden-param-flow') {
    return mission.notExecutableReason || 'intent_only_without_executor';
  }
  return null;
}

function missionPolicySuppressionReason(mission = {}, agentConfig = {}) {
  const tier = mission.policyTier || mission.riskModeRequired || 'safe';
  if (tier === 'destructive' && agentConfig.allowDestructiveActions !== true) return 'policy_denied';
  if (tier === 'business' && !(agentConfig.allowBusinessMutations || agentConfig.allowDestructiveActions || agentConfig.riskMode === 'business' || agentConfig.riskMode === 'destructive')) {
    return 'policy_denied';
  }
  return null;
}

function routeCoveredNoDeltaSuppressesMission(mission = {}) {
  if (mission.surfaceHandleId || mission.controlHandleId || mission.formHandleId) return false;
  if (mission.allowCoveredRouteReplay === true) return false;
  if (mission.kind === 'ptk-finding-entrypoint-reproduction') return false;
  if (mission.kind === 'auth-surface-traversal') {
    if (authSurfaceMissionCanAddNonRouteDelta(mission)) return false;
    return mission.source === 'auth-surface-summary'
      && !mission.surfaceHandleId
      && !mission.controlHandleId
      && !mission.formHandleId;
  }
  return !new Set([
    'form-validation-repair',
    'missing-required-fields',
    'wrong-credential-field',
    'submitted-no-transition',
    'multi-step-form-next',
    'scenario-unblock'
  ]).has(mission.kind);
}

function authSurfaceMissionCanAddNonRouteDelta(mission = {}) {
  const reason = String(
    mission.surfaceGap && mission.surfaceGap.reason ||
    mission.reason ||
    ''
  ).toLowerCase();
  return /surface_explorer_budget_exhausted|not_executed|timeout|no_progress/.test(reason);
}

function isHighConfidenceExecutableMission(mission = {}) {
  if (!mission || mission.executable === false) return false;
  if (mission.kind === 'surface-expanded-route') return surfaceExpandedRouteMissionIsHighConfidence(mission);
  if (/scenario|auth|form|repair|finding|business/i.test(`${mission.kind || ''} ${mission.id || ''} ${mission.source || ''}`)) return true;
  if (mission.kind === 'endpoint-backed-ui-flow') {
    if (mission.executable === false || mission.notExecutableReason === 'endpoint_without_ui_path') return false;
    const endpoint = mission.endpoint || {};
    return Boolean(
      mission.route ||
      endpoint.routeUrl ||
      endpoint.route ||
      endpoint.uiPath ||
      endpoint.uiTrigger ||
      (endpoint.candidateRoutes || []).length ||
      (endpoint.candidateControls || []).length ||
      (endpoint.candidateForms || []).length
    );
  }
  if (mission.kind === 'hidden-route-verification') {
    const source = String(mission.source || mission.routeHint && mission.routeHint.source || '').toLowerCase();
    return /surface|code-signal|ptk|sast|finding|auth/.test(source);
  }
  return false;
}

function surfaceExpandedRouteMissionIsHighConfidence(mission = {}) {
  if (!mission || mission.executable === false) return false;
  if (!mission.controlHandleId && !mission.surfaceHandleId) return false;
  if (mission.highConfidence === true) return true;
  const summary = mission.liveHandleSummary || {};
  const text = [
    summary.kind,
    summary.semanticKind,
    summary.expectedEffect,
    summary.label,
    summary.href,
    summary.action,
    summary.intent,
    summary.formPurpose
  ].filter(Boolean).join(' ').toLowerCase();
  if (/account|profile|order|history|wallet|payment|address|setting|search|filter|menu|drawer|modal|route|navigate|next|auth/.test(text)) {
    return true;
  }
  const source = String(mission.source || '').toLowerCase();
  return /surface|probe|code-signal|ptk|sast|finding|auth/.test(source)
    && /href|route|navigate|router|link/.test(text);
}

async function executorSafeObserve({ config, context, handles, turn, telemetry } = {}) {
  try {
    const { createAgentToolExecutor } = require('./toolExecutor.cjs');
    const executor = createAgentToolExecutor({
      config,
      session: context.session || context.liveSession && context.session || context.livePage && { page: context.livePage } || null,
      context,
      handles,
      telemetry
    });
    return await executor.observeCrawlerState();
  } catch (error) {
    return { error: error && error.message || String(error || 'observe_failed') };
  }
}

function createRouteExecutor({ mission, context = {}, handlers = {} } = {}) {
  return async function executeRoute(routeKey, input = {}) {
    if (typeof context.executeRoute === 'function') {
      return context.executeRoute(routeKey, { mission: input.mission || mission, step: input.step || null });
    }
    if (typeof handlers.__visitRoute === 'function') {
      return handlers.__visitRoute(routeKey, { mission: input.mission || mission, step: input.step || null, context });
    }
    if (mission && handlers[mission.kind]) {
      const result = await handlers[mission.kind]({ ...mission, route: mission.route || routeKey }, {
        ...context,
        routeKey
      });
      return {
        ok: result && result.ok !== false,
        status: result && result.status || 'completed',
        reason: result && result.reason || null,
        coverage: result && result.coverage || context.coverage || {},
        transition: result && result.transition || { changed: result && result.status !== 'no_progress', noProgress: result && result.status === 'no_progress', reason: 'mission_handler_executed' },
        result
      };
    }
    const result = await executeMission({
      mission: { ...mission, route: mission && mission.route || routeKey },
      context,
      handlers
    });
    return {
      ok: result && result.ok !== false,
      status: result && result.status || 'not_executable',
      reason: result && result.reason || null,
      coverage: result && result.coverage || context.coverage || {},
      transition: result && result.status === 'completed'
        ? { changed: true, noProgress: false, reason: 'mission_executor_completed' }
        : { changed: false, noProgress: true, reason: result && result.reason || 'mission_executor_not_executable' },
      result
    };
  };
}

function missionResultFromExecutions({ mission = {}, plan = {}, stepResults = [] } = {}) {
  if (!stepResults.length) {
    const result = notExecutableMission(mission, 'no_executable_steps', [], []);
    return {
      ...result,
      executed: false,
      transitionValidated: false,
      coverageDelta: emptyDelta()
    };
  }
  const total = emptyDelta();
  const effects = [];
  let browserActionRan = false;
  let transitionValidated = false;
  let blocked = null;
  let noProgress = false;
  for (const result of stepResults) {
    addDelta(total, result.actualDelta || {});
    if (result.effect) effects.push(result.effect);
    if (result.browserActionRan) browserActionRan = true;
    if (result.transitionValidated) transitionValidated = true;
    if (result.status === 'blocked' || result.status === 'recover_auth_required' || result.status === 'failed' || result.status === 'not_executable') blocked = result;
    if (result.status === 'no_progress') noProgress = true;
  }
  const hasDelta = hasMeaningfulCoverageDelta(total);
  let status = 'no_progress';
  if (blocked) status = blocked.status;
  else if (browserActionRan && transitionValidated && hasDelta) status = 'completed';
  else if (!browserActionRan) status = 'not_executable';
  else if (noProgress || !hasDelta) status = 'no_progress';
  return {
    ok: status === 'completed',
    missionId: mission.id,
    kind: mission.kind,
    executed: browserActionRan,
    status,
    transitionValidated,
    coverageDelta: total,
    expectedDelta: plan.expectedDelta || null,
    actualDelta: total,
    deltaMatchedExpectation: deltaMatches(plan.expectedDelta, total),
    reason: status === 'completed' ? null : blocked && blocked.reason || status,
    effects,
    results: stepResults
  };
}

function emptyDelta() {
  return { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 };
}

function addDelta(target, delta = {}) {
  for (const key of Object.keys(target)) {
    target[key] += Number(delta[key]) || 0;
  }
  return target;
}

function deltaMatches(expected = {}, actual = {}) {
  if (!expected || !actual) return false;
  for (const [key, value] of Object.entries(expected)) {
    if ((Number(actual[key]) || 0) < (Number(value) || 0)) return false;
  }
  return true;
}

function countNoProgress(results = []) {
  return results.filter(result => result && result.status === 'no_progress').length;
}

function withProviderTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`provider choice timed out after ${timeoutMs}ms`);
        error.code = 'ERR_PTK_AGENT_PROVIDER_TIMEOUT';
        reject(error);
      }, timeoutMs);
    })
  ]);
}

function emitAgentLifecycle(context = {}, type, details = {}) {
  if (!context || typeof context.writeRowLifecycle !== 'function') return null;
  try {
    return context.writeRowLifecycle(type, details);
  } catch (_) {
    return null;
  }
}

function sortMissionsWithRunMemory(missions = [], runMemory) {
  return missions.slice().sort((a, b) => {
    const aSuppressed = runMemory && runMemory.shouldSuppress(a) ? 1 : 0;
    const bSuppressed = runMemory && runMemory.shouldSuppress(b) ? 1 : 0;
    if (aSuppressed !== bSuppressed) return aSuppressed - bSuppressed;
    const aScore = (a.priority || 0) + (runMemory ? runMemory.scoreMission(a) : 0);
    const bScore = (b.priority || 0) + (runMemory ? runMemory.scoreMission(b) : 0);
    return bScore - aScore || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function managerReturn({
  agentConfig,
  chosenProvider,
  status,
  telemetryExtra = {},
  missions,
  choices,
  results,
  result,
  skill,
  runMemory = null,
  turns = [],
  actionPlans = [],
  executionResults = [],
  providerDecisionQuality = [],
  totalActualDelta = emptyDelta(),
  stopReason = null,
  baselineCoverage = {},
  baselineCounts = coverageCounts(baselineCoverage),
  finalCoverage = baselineCoverage,
  missionCompilerRecords = []
}) {
  const actualMode = resolveActualMode(agentConfig, chosenProvider);
  const actionEffects = collectActionEffects(results);
  const finalCounts = coverageCounts(finalCoverage || {});
  const baselinePreservation = {
    schemaVersion: 'ptk-agent-v2-baseline-preservation',
    baselineRoutes: baselineCounts.routes,
    baselineRouteShapes: baselineCounts.routeShapes,
    baselineEndpoints: baselineCounts.endpoints,
    baselineForms: baselineCounts.forms,
    baselineActions: baselineCounts.actions,
    baselineFindings: countFindings(baselineCoverage),
    finalRoutes: finalCounts.routes,
    finalRouteShapes: finalCounts.routeShapes,
    finalEndpoints: finalCounts.endpoints,
    finalForms: finalCounts.forms,
    finalActions: finalCounts.actions,
    finalFindings: countFindings(finalCoverage),
    agentAddedRoutes: totalActualDelta.routes,
    agentAddedRouteShapes: totalActualDelta.routeShapes,
    agentAddedEndpoints: totalActualDelta.endpoints,
    agentAddedForms: totalActualDelta.forms,
    agentAddedActions: totalActualDelta.actions,
    agentAddedFindings: totalActualDelta.findings,
    agentFailureAffectedBaseline: false
  };
  const findingFingerprintDiff = {
    ...createFindingFingerprintDiff({
    baseline: baselineCoverage,
    final: finalCoverage || baselineCoverage
    }),
  };
  return {
    status,
    requested: agentConfig.mode,
    actual: actualMode,
    telemetry: { actualMode, stopReason, ...telemetryExtra },
    missions,
    choices,
    results,
    result,
    turns,
    actionPlans,
    executionResults,
    coverageDelta: {
      schemaVersion: 'ptk-agent-v2-coverage-delta',
      total: totalActualDelta,
      perTurn: executionResults.map(result => ({
        turn: result.turn,
        missionId: result.missionId,
        stepType: result.stepType,
        actualDelta: result.actualDelta || emptyDelta(),
        status: result.status
      }))
    },
    providerDecisionQuality: {
      schemaVersion: 'ptk-agent-v2-provider-decision-quality',
      decisions: providerDecisionQuality
    },
    baselinePreservation,
    findingFingerprintDiff,
    missionCompilerSummary: mergeMissionCompilerSummaries(missionCompilerRecords),
    executorRecoverySummary: buildExecutorRecoverySummary(executionResults),
    formRepairSummary: buildFormRepairSummary({ missions, results, executionResults }),
    businessLogicSummary: buildBusinessLogicSummary({ missions, results, executionResults }),
    riskPolicy: {
      schemaVersion: 'ptk-agent-v2-risk-policy',
      riskMode: agentConfig.riskMode || 'safe',
      allowBusinessMutations: Boolean(agentConfig.allowBusinessMutations),
      allowDestructiveActions: Boolean(agentConfig.allowDestructiveActions),
      requireSuccess: Boolean(agentConfig.requireSuccess)
    },
    runMemory: runMemory && runMemory.snapshot ? runMemory.snapshot() : null,
    actionEffects,
    skill: { name: skill.name, version: skill.version, hash: skill.hash, included: true }
  };
}

function buildExecutorRecoverySummary(executionResults = []) {
  const recoveries = [];
  for (const result of executionResults || []) {
    const recovery = result && result.toolResult && result.toolResult.recovery;
    if (!recovery) continue;
    recoveries.push({
      turn: result.turn || null,
      missionId: result.missionId || null,
      stepType: result.stepType || null,
      status: result.status || null,
      reason: result.reason || null,
      attempted: recovery.attempted !== false,
      closed: Boolean(recovery.closed),
      backdropClicked: Boolean(recovery.backdropClicked),
      escapePressed: Boolean(recovery.escapePressed),
      backdropCount: Number(recovery.backdropCount || 0),
      recoveredRetry: Boolean(result.toolResult.recoveredRetry)
    });
  }
  return {
    schemaVersion: 'ptk-agent-v2-executor-recovery-summary',
    generatedAt: new Date().toISOString(),
    attempts: recoveries.length,
    recoveredRetries: recoveries.filter(item => item.recoveredRetry).length,
    closedBlockingSurfaces: recoveries.filter(item => item.closed).length,
    byStatus: countBy(recoveries, item => item.status || 'unknown'),
    recoveries
  };
}

function buildFormRepairSummary({ missions = [], results = [], executionResults = [] } = {}) {
  const formKinds = new Set([
    'form-validation-repair',
    'missing-required-fields',
    'wrong-credential-field',
    'captcha-blocked',
    'submitted-no-transition',
    'multi-step-form-next'
  ]);
  const formMissions = (missions || []).filter(mission => formKinds.has(mission && mission.kind));
  const executions = (executionResults || []).filter(result => formKinds.has(missionKindForExecution(result, missions)));
  return {
    schemaVersion: 'ptk-agent-v2-form-repair-summary',
    generatedAt: new Date().toISOString(),
    missionsOffered: formMissions.length,
    repairsAttempted: executions.filter(result => ['fill_form', 'submit_form'].includes(result.stepType)).length,
    captchaBlocked: formMissions.filter(mission => mission.kind === 'captcha-blocked').length + executions.filter(result => /captcha/i.test(String(result.reason || ''))).length,
    noProgressAttempts: executions.filter(result => result.status === 'no_progress').length,
    blockedAttempts: executions.filter(result => result.status === 'blocked' || result.status === 'not_executable').length,
    completedRepairs: executions.filter(result => result.status === 'completed').length,
    statuses: countBy(executions, result => result.status || 'unknown'),
    missionKinds: countBy(formMissions, mission => mission.kind || 'unknown'),
    executionMissionKinds: countBy(executions, result => missionKindForExecution(result, missions) || 'unknown')
  };
}

function buildBusinessLogicSummary({ missions = [], results = [], executionResults = [] } = {}) {
  const businessKinds = new Set([
    'auth-surface-traversal',
    'surface-expanded-route',
    'business-flow-continuation',
    'endpoint-backed-ui-flow',
    'scenario-unblock'
  ]);
  const businessMissions = (missions || []).filter(mission => businessKinds.has(mission && mission.kind));
  const executions = (executionResults || []).filter(result => businessKinds.has(missionKindForExecution(result, missions)));
  const risky = executions.filter(result => result.policy && result.policy.tier && result.policy.tier !== 'safe');
  return {
    schemaVersion: 'ptk-agent-v2-business-logic-summary',
    generatedAt: new Date().toISOString(),
    missionsOffered: businessMissions.length,
    safeActionsExecuted: executions.filter(result => result.browserActionRan && (!result.policy || result.policy.tier === 'safe')).length,
    riskyActionsEvaluated: risky.length,
    riskyActionsAllowed: risky.filter(result => result.policy && result.policy.allowed).length,
    riskyActionsBlocked: risky.filter(result => result.status === 'blocked').length,
    authenticatedSurfacesAttempted: executions.filter(result => result.stepType === 'open_surface').length,
    controlsClicked: executions.filter(result => result.stepType === 'click_control').length,
    routesVisited: executions.filter(result => result.stepType === 'visit_route').length,
    completed: executions.filter(result => result.status === 'completed').length,
    noProgress: executions.filter(result => result.status === 'no_progress').length,
    statuses: countBy(executions, result => result.status || 'unknown'),
    missionKinds: countBy(businessMissions, mission => mission.kind || 'unknown'),
    executionMissionKinds: countBy(executions, result => missionKindForExecution(result, missions) || 'unknown')
  };
}

function missionKindForExecution(result = {}, missions = []) {
  return result.missionKind
    || result.effect && result.effect.missionKind
    || result.toolResult && result.toolResult.missionKind
    || missionKindFor(result.missionId, missions);
}

function missionKindFor(missionId, missions = []) {
  const mission = (missions || []).find(item => item && item.id === missionId);
  return mission && mission.kind || null;
}

function countBy(values = [], keyFn = value => value) {
  const out = {};
  for (const value of values || []) {
    const key = keyFn(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function mergeMissionCompilerSummaries(records = []) {
  if (!records.length) return summarizeMissionCompiler();
  const offered = [];
  const suppressed = [];
  const skipped = [];
  for (const record of records || []) {
    offered.push(...(record && record.offered || []));
    suppressed.push(...(record && record.suppressed || []));
    skipped.push(...(record && record.skipped || []));
  }
  return summarizeMissionCompiler({ offered, suppressed, skipped });
}

function collectActionEffects(results = []) {
  const effects = [];
  for (const result of results || []) {
    for (const effect of result && result.effects || []) effects.push(effect);
  }
  return effects;
}

function resolveActualMode(agentConfig = {}, chosenProvider = {}) {
  if (agentConfig.mode === 'mock' || chosenProvider && chosenProvider.kind === 'mock') return 'agent-mock';
  if (chosenProvider && (chosenProvider.kind === 'opencode' || chosenProvider.kind === 'codex')) {
    return `provider:${chosenProvider.kind}`;
  }
  return 'manager';
}

function countFindings(coverage = {}) {
  const ptk = coverage && coverage.ptk || {};
  return Number(
    ptk.findings && (ptk.findings.count || ptk.findings.findingsCount)
    || ptk.validity && ptk.validity.findingsCount
    || coverage.agentPtkSignals && coverage.agentPtkSignals.findingsCount
    || findingMap(coverage).size
    || 0
  ) || 0;
}

module.exports = {
  runAgentManagerV2,
  sortMissionsWithRunMemory,
  withProviderTimeout,
  emitAgentLifecycle,
  finalStatusAfterProviderFailure,
  finalStatusAfterLoop,
  resolveChoiceMissionAlias,
  resolveTurnMissions,
  liveHandleMissions,
  isAccountCreationFormHandle
};
