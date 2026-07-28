'use strict';

function createAgentRunMemory(options = {}) {
  const maxNoProgress = Number.isFinite(Number(options.maxNoProgress))
    ? Math.max(1, Number(options.maxNoProgress))
    : 2;
  const records = new Map();
  return {
    recordEffect(effect = {}) {
      const keys = effectKeys(effect);
      if (!keys.length) return null;
      let primary = null;
      for (const key of keys) {
        const record = records.get(key) || {
          key,
          missionId: effect.missionId || null,
          missionKind: effect.missionKind || null,
          noProgressKey: effect.noProgressKey || null,
          noProgressCount: 0,
          progressCount: 0,
          lastStatus: null
        };
        if (effect.noProgress || effect.status === 'no_progress') record.noProgressCount += 1;
        else record.progressCount += 1;
        record.lastStatus = effect.status || null;
        records.set(key, record);
        if (!primary) primary = record;
      }
      return primary;
    },
    scoreMission(mission = {}) {
      const record = firstRecord(records, missionKeys(mission));
      if (!record) return 0;
      return (record.progressCount * 10) - (record.noProgressCount * 25);
    },
    shouldSuppress(mission = {}) {
      const record = firstRecord(records, missionKeys(mission));
      const suppressAfter = Number.isFinite(Number(mission.noProgressSuppressAfter))
        ? Math.max(1, Number(mission.noProgressSuppressAfter))
        : maxNoProgress;
      return Boolean(record && record.noProgressCount >= suppressAfter && record.progressCount === 0);
    },
    snapshot() {
      return {
        schemaVersion: 'ptk-agent-v2-run-memory',
        maxNoProgress,
        records: Array.from(records.values())
      };
    }
  };
}

function effectKeys(effect = {}) {
  return uniqueKeys([
    effect.noProgressKey ? `no-progress:${effect.noProgressKey}` : null,
    effect.missionId || null,
    effect.missionKind ? `kind:${effect.missionKind}` : null
  ]);
}

function missionKeys(mission = {}) {
  return uniqueKeys([
    mission.noProgressKey ? `no-progress:${mission.noProgressKey}` : null,
    mission.id || null,
    mission.kind ? `kind:${mission.kind}` : null
  ]);
}

function uniqueKeys(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function firstRecord(records, keys = []) {
  for (const key of keys) {
    const record = records.get(key);
    if (record) return record;
  }
  return null;
}

module.exports = {
  createAgentRunMemory
};
