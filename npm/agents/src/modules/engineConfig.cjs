'use strict';

const VALID_ENGINES = new Set(['DAST', 'SAST', 'IAST', 'SCA', 'dast', 'sast', 'iast', 'sca']);

function resolveEngineConfig(config = {}) {
  const requested = Array.isArray(config.engines)
    ? config.engines
    : config.engines && typeof config.engines === 'object'
      ? Object.entries(config.engines).filter(([, value]) => value && value.enabled === true).map(([engine]) => engine)
      : ['dast'];
  const engines = {};
  for (const engine of ['dast', 'sast', 'iast', 'sca']) {
    const source = config.engines && !Array.isArray(config.engines) ? config.engines[engine] || {} : {};
    engines[engine] = {
      enabled: requested.map(String).map(item => item.toLowerCase()).includes(engine) || engine === 'dast',
      modulePacks: Array.isArray(source.modulePacks) ? source.modulePacks.slice() : ['bundled-free']
    };
  }
  for (const engine of requested) {
    if (!VALID_ENGINES.has(engine)) throw new Error(`Unknown engine: ${engine}`);
  }
  return {
    engines,
    modules: {
      packs: config.modules && config.modules.packs || ['bundled-free'],
      cacheDir: config.modules && config.modules.cacheDir || '.ptk/modules',
      verifySignatures: config.modules && config.modules.verifySignatures !== undefined ? Boolean(config.modules.verifySignatures) : true,
      allowUnsigned: config.modules && config.modules.allowUnsigned === true,
      allowNetworkDownloads: config.modules && config.modules.allowNetworkDownloads === true,
      portal: config.modules && config.modules.portal || { baseUrl: null, tokenEnv: 'PTK_PORTAL_TOKEN' }
    },
    ci: {
      failOn: config.ci && config.ci.failOn || {
        severity: ['critical', 'high'],
        confidence: ['confirmed', 'high']
      },
      noFail: config.ci && config.ci.noFail === true
    }
  };
}

function redactEngineConfig(config) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  if (clone.modules && clone.modules.portal && clone.modules.portal.token) {
    clone.modules.portal.token = '[redacted]';
  }
  return clone;
}

function resolveEngineList(config = {}) {
  const engines = config.engines || ['DAST'];
  for (const engine of engines) {
    if (!VALID_ENGINES.has(engine)) throw new Error(`Unknown engine: ${engine}`);
  }
  return {
    engines,
    modulePacks: config.modulePacks || ['free']
  };
}

module.exports = {
  VALID_ENGINES,
  redactEngineConfig,
  resolveEngineConfig,
  resolveEngineList
};
