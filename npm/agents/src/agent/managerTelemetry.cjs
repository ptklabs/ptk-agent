'use strict';

function buildManagerTelemetryArtifact(agent = {}) {
  return {
    schemaVersion: 'ptk-agent-v2-manager-telemetry',
    generatedAt: new Date().toISOString(),
    status: agent.status || null,
    requested: agent.requested || null,
    actual: agent.actual || null,
    provider: agent.provider || agent.telemetry && agent.telemetry.provider || null,
    telemetry: agent.telemetry || null,
    missionCount: Array.isArray(agent.missions) ? agent.missions.length : 0,
    missionSummary: agent.missionCompilerSummary || null,
    missions: (agent.missions || []).map(summarizeMission),
    choices: (agent.choices || []).map(summarizeChoice),
    results: (agent.results || []).map(summarizeResult),
    runMemory: agent.runMemory || null,
    actionEffects: agent.actionEffects || collectEffects(agent.results)
  };
}

function summarizeMission(mission = {}) {
  return {
    id: mission.id || null,
    kind: mission.kind || null,
    priority: mission.priority || 0,
    reason: mission.reason || null,
    source: mission.source || null,
    route: mission.route || null
  };
}

function summarizeChoice(choice = {}) {
  return {
    missionId: choice.missionId || null,
    reason: choice.reason || null,
    provider: choice.provider || null,
    expectedDelta: choice.expectedDelta || null,
    allowedCapability: choice.allowedCapability || null,
    timeoutMs: choice.timeoutMs || null,
    error: choice.error || null
  };
}

function summarizeResult(result = {}) {
  return {
    missionId: result.missionId || null,
    kind: result.kind || null,
    ok: Boolean(result.ok),
    status: result.status || null,
    reason: result.reason || null,
    action: result.action || null,
    effectCount: Array.isArray(result.effects) ? result.effects.length : 0,
    intentCount: Array.isArray(result.intents) ? result.intents.length : 0
  };
}

function collectEffects(results = []) {
  const effects = [];
  for (const result of results || []) {
    for (const effect of result && result.effects || []) effects.push(effect);
  }
  return effects;
}

module.exports = {
  buildManagerTelemetryArtifact
};
