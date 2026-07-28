'use strict';

const { verifyModulePack } = require('./moduleVerifier.cjs');
const { downloadModulePack } = require('./moduleDownloader.cjs');

const ENGINE_IDS = Object.freeze(['dast', 'iast', 'sast', 'sca']);

const FREE_MODULES = Object.freeze([
  { id: 'ptk.dast.discovery', engine: 'dast', tier: 'free', capabilities: ['dast:discover'] },
  { id: 'ptk.dast.basic-xss', engine: 'dast', tier: 'free', capabilities: ['dast:xss'] },
  { id: 'ptk.dast.basic-sqli', engine: 'dast', tier: 'free', capabilities: ['dast:sqli'] },
  { id: 'ptk.sast.dom-xss', engine: 'sast', tier: 'free', capabilities: ['sast:dom-xss'] },
  { id: 'ptk.iast.dom-reachability', engine: 'iast', tier: 'free', capabilities: ['iast:dom-reachability'] }
]);

function listModules() {
  return {
    packs: [
      {
        id: 'bundled-free',
        name: 'bundled-free',
        version: '0.0.0-v2',
        status: 'resolved',
        modules: FREE_MODULES
      }
    ]
  };
}

function unique(items = []) {
  return Array.from(new Set((Array.isArray(items) ? items : [items]).filter(Boolean).map(String)));
}

function normalizeEnabledEngines(config = {}) {
  if (Array.isArray(config.engines)) {
    return unique(config.engines.map(engine => String(engine).toLowerCase()))
      .filter(engine => ENGINE_IDS.includes(engine));
  }
  if (config.engines && typeof config.engines === 'object') {
    return ENGINE_IDS.filter(engine => config.engines[engine] && config.engines[engine].enabled === true);
  }
  return ['dast'];
}

function normalizeRequestedPacks(config = {}, enabledEngines = []) {
  const packs = [];
  if (config.modules && Array.isArray(config.modules.packs)) {
    packs.push(...config.modules.packs);
  }
  if (Array.isArray(config.modulePacks)) {
    packs.push(...config.modulePacks);
  }
  if (config.engines && typeof config.engines === 'object' && !Array.isArray(config.engines)) {
    for (const engine of enabledEngines) {
      const enginePacks = config.engines[engine] && config.engines[engine].modulePacks;
      if (Array.isArray(enginePacks)) packs.push(...enginePacks);
    }
  }
  return unique(packs.length ? packs : ['bundled-free']);
}

function normalizeModuleOptions(config = {}, options = {}) {
  const modules = config.modules || {};
  return {
    cacheDir: modules.cacheDir || '.ptk/modules',
    verifySignatures: modules.verifySignatures !== false,
    allowUnsigned: modules.allowUnsigned === true,
    allowNetworkDownloads: modules.allowNetworkDownloads === true,
    portal: {
      baseUrl: modules.portal && modules.portal.baseUrl || null,
      tokenEnv: modules.portal && modules.portal.tokenEnv || 'PTK_PORTAL_TOKEN',
      tokenPresent: Boolean(modules.portal && modules.portal.tokenEnv && options.env && options.env[modules.portal.tokenEnv])
    }
  };
}

function buildMissingPack(packId, moduleOptions = {}) {
  const isPro = String(packId).toLowerCase() === 'pro';
  const reason = moduleOptions.allowNetworkDownloads
    ? 'network-download-not-implemented'
    : isPro
      ? 'pro-module-download-disabled'
      : 'module-pack-missing';
  return {
    id: packId,
    name: packId,
    status: 'missing',
    reason,
    modules: []
  };
}

function resolveModules(engineConfig = {}, options = {}) {
  const engines = normalizeEnabledEngines(engineConfig);
  const requestedPacks = normalizeRequestedPacks(engineConfig, engines);
  const moduleOptions = normalizeModuleOptions(engineConfig, options);
  const packs = [];
  const warnings = [];
  const errors = [];
  for (const packId of requestedPacks) {
    if (packId === 'bundled-free' || packId === 'free') {
      packs.push({
        ...listModules().packs[0],
        id: 'free',
        name: 'bundled-free',
        requestedAs: packId,
        modules: FREE_MODULES.filter(module => engines.includes(module.engine))
      });
      continue;
    }
    const cached = options.cache && options.cache.getPack(packId);
    if (cached) {
      packs.push({ id: packId, name: packId, status: 'resolved', source: 'cache', version: cached.version, modules: cached.modules || [] });
      continue;
    }
    const missing = buildMissingPack(packId, moduleOptions);
    packs.push(missing);
    errors.push(`Module pack "${packId}" is unavailable: ${missing.reason}`);
  }
  if (moduleOptions.verifySignatures && moduleOptions.allowUnsigned) {
    warnings.push('modules.allowUnsigned=true weakens signature verification policy');
  }
  return {
    schemaVersion: 'ptk-agent-v2-module-resolution',
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    engines,
    requestedPacks,
    moduleOptions,
    packs,
    modules: packs.flatMap(pack => pack.modules.map(module => ({ ...module, pack: pack.name }))),
    warnings,
    errors
  };
}

function enabledEngineMap(config = {}) {
  const out = {};
  for (const engine of ENGINE_IDS) {
    out[engine] = Boolean(config.engines && config.engines[engine] && config.engines[engine].enabled);
  }
  return out;
}

function buildPtkScanOptions(config = {}, moduleResolution = null) {
  const engines = Object.entries(enabledEngineMap(config))
    .filter(([, enabled]) => enabled)
    .map(([engine]) => engine.toUpperCase());
  return {
    engines,
    engineConfigs: {
      modulePacks: moduleResolution && moduleResolution.requestedPacks || normalizeRequestedPacks(config, engines.map(engine => engine.toLowerCase())),
      modules: moduleResolution ? moduleResolution.modules.map(module => ({
        id: module.id,
        engine: module.engine,
        pack: module.pack,
        capabilities: module.capabilities || []
      })) : []
    }
  };
}

function ptkEngineSelectionStatus(lifecycle = null) {
  if (!lifecycle) {
    return {
      engineSelectionAppliedToPtk: false,
      reason: 'PTK lifecycle did not run'
    };
  }
  if (lifecycle.engineSelectionAppliedToPtk !== undefined) {
    return {
      engineSelectionAppliedToPtk: Boolean(lifecycle.engineSelectionAppliedToPtk),
      reason: lifecycle.engineSelectionReason || lifecycle.reason || null
    };
  }
  return {
    engineSelectionAppliedToPtk: false,
    reason: 'PTK lifecycle did not report engine selection status'
  };
}

function buildEngineSummary(config = {}, moduleResolution = null, lifecycle = null, requestedEngines = []) {
  const enabled = enabledEngineMap(config);
  const requested = requestedEngines.length
    ? requestedEngines.map(engine => String(engine).toUpperCase())
    : Object.entries(enabled).filter(([, value]) => value).map(([engine]) => engine.toUpperCase());
  return {
    schemaVersion: 'ptk-agent-v2-engine-summary',
    requestedEngines: requested,
    enabled,
    modules: moduleResolution ? {
      ok: Boolean(moduleResolution.ok),
      requestedPacks: moduleResolution.requestedPacks || [],
      resolvedPacks: (moduleResolution.packs || []).filter(pack => pack.status === 'resolved').map(pack => pack.name || pack.id),
      moduleCount: Array.isArray(moduleResolution.modules) ? moduleResolution.modules.length : 0,
      warnings: moduleResolution.warnings || [],
      errors: moduleResolution.errors || []
    } : null,
    ptkLifecycle: ptkEngineSelectionStatus(lifecycle)
  };
}

async function installModulePacks({ packs = [] } = {}) {
  const results = [];
  for (const packName of packs) {
    if (packName === 'free') {
      const pack = listModules().packs[0];
      results.push({ packName, installed: true, verification: verifyModulePack(pack) });
    } else {
      results.push(await downloadModulePack({ packName }));
    }
  }
  return { results };
}

function verifyModuleCache() {
  return {
    ok: true,
    reason: 'no_external_cache_required_for_free_modules',
    packs: listModules().packs.map(pack => ({ name: pack.name, verification: verifyModulePack(pack) }))
  };
}

module.exports = {
  ENGINE_IDS,
  FREE_MODULES,
  buildEngineSummary,
  buildPtkScanOptions,
  listModules,
  resolveModules,
  installModulePacks,
  verifyModuleCache
};
