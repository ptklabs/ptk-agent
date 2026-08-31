'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { compileScenario } = require('./scenarioCompiler.cjs');

const ADAPTER_FILES = Object.freeze([
  'flow.js',
  'ptkFlowAdapter.js',
  'xmlAdapter.js',
  'zestAdapter.js',
  'sideAdapter.js',
  'chromeRecorderAdapter.js',
  'codeGenerators.js',
  'formatRegistry.js'
]);

const IMPORTABLE_FORMATS = new Set(['auto', 'ptk-flow', 'json', 'xml', 'zest', 'side', 'chrome-recorder']);

function macroAdapterRoot(config = {}) {
  const extensionPath = config.ptk && config.ptk.extensionPath
    || config._resolved && config._resolved.ptkExtension && config._resolved.ptkExtension.path
    || null;
  if (!extensionPath) throw new Error('PTK Auto extension is required to import macro files.');
  const root = path.join(extensionPath, 'ptk', 'background', 'macro');
  for (const name of ADAPTER_FILES) {
    if (!fs.existsSync(path.join(root, name))) {
      throw new Error(`The installed PTK Auto artifact does not include macro adapter ${name}.`);
    }
  }
  return root;
}

function rewriteAdapterImports(source, knownFiles) {
  return source.replace(/(['"])\.\/([A-Za-z0-9_-]+)\.js\1/g, (match, quote, base) => {
    const file = `${base}.js`;
    if (!knownFiles.has(file)) throw new Error(`PTK macro adapter imports unsupported module ${file}.`);
    return `${quote}./${base}.mjs${quote}`;
  });
}

async function loadMacroRegistry(config = {}, options = {}) {
  const sourceRoot = options.adapterRoot || macroAdapterRoot(config);
  const knownFiles = new Set(ADAPTER_FILES);
  const sources = ADAPTER_FILES.map((name) => {
    const source = fs.readFileSync(path.join(sourceRoot, name), 'utf8');
    if (/\b(?:from\s+|import\s*\()\s*['"](?:https?:|data:|blob:)/i.test(source)) {
      throw new Error(`PTK macro adapter ${name} contains a remote module reference.`);
    }
    return { name, source };
  });
  const digest = crypto.createHash('sha256');
  for (const entry of sources) digest.update(entry.name).update('\0').update(entry.source).update('\0');
  const cacheRoot = options.cacheRoot
    || process.env.PTK_MACRO_CACHE_DIR
    || path.resolve(options.cwd || process.cwd(), '.ptk', 'macro-runtime');
  const targetRoot = path.join(cacheRoot, digest.digest('hex').slice(0, 24));
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of sources) {
    const outputName = entry.name.replace(/\.js$/, '.mjs');
    const outputPath = path.join(targetRoot, outputName);
    if (!fs.existsSync(outputPath)) {
      fs.writeFileSync(outputPath, rewriteAdapterImports(entry.source, knownFiles), { encoding: 'utf8', mode: 0o600 });
    }
  }
  return import(`${pathToFileURL(path.join(targetRoot, 'formatRegistry.mjs')).href}?v=${path.basename(targetRoot)}`);
}

function exactTargetOrigin(config = {}) {
  let parsed;
  try {
    parsed = new URL(String(config.target && config.target.baseUrl || ''));
  } catch (_) {
    throw new Error('target.baseUrl must be an absolute HTTP or HTTPS URL before importing a macro.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('target.baseUrl must use HTTP or HTTPS.');
  return parsed.origin;
}

function assertMacroFlowScope(flow, config = {}) {
  const origin = exactTargetOrigin(config);
  const urls = [];
  if (flow.startUrl) urls.push({ stepId: 'startUrl', url: flow.startUrl });
  for (const step of flow.steps || []) {
    if ((step.type === 'navigate' || step.type === 'waitForNavigation') && step.url) {
      urls.push({ stepId: step.id, url: step.url });
    }
    if (Number(step.durationMs || 0) > 60000 || Number(step.timeoutMs || 0) > 60000) {
      throw new Error(`Macro step ${step.id} exceeds PTK Agent's 60000 ms per-step limit.`);
    }
  }
  for (const entry of urls) {
    let parsed;
    try {
      parsed = new URL(String(entry.url || ''));
    } catch (_) {
      throw new Error(`Macro step ${entry.stepId} has an invalid URL.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Macro step ${entry.stepId} is outside the exact target origin ${origin}.`);
    }
  }
  return origin;
}

function macroEnvironmentName(kind, name) {
  return `PTK_MACRO_${kind === 'secret' ? 'SECRET' : 'VAR'}_${name}`;
}

function runtimeValues(flow, importedSecrets = {}, env = process.env) {
  const secrets = { ...(importedSecrets || {}) };
  const variables = {};
  const missing = [];
  for (const entry of flow.variables || []) {
    const kind = entry.secret ? 'secret' : 'variable';
    const envName = macroEnvironmentName(kind, entry.name);
    if (Object.prototype.hasOwnProperty.call(env, envName)) {
      (entry.secret ? secrets : variables)[entry.name] = String(env[envName]);
      continue;
    }
    const bucket = entry.secret ? secrets : variables;
    if (!Object.prototype.hasOwnProperty.call(bucket, entry.name)) missing.push(envName);
  }
  if (missing.length) {
    throw new Error(`Macro runtime values are missing: ${missing.join(', ')}.`);
  }
  return { secrets, variables };
}

function macroScenarioStep(step) {
  const requestedTimeout = Number(step.timeoutMs || 0);
  const defaultTimeout = step.type === 'navigate' || step.type === 'waitForNavigation'
    ? 30000
    : Math.max(5000, Number(step.durationMs || 0) + 1000);
  const timeoutMs = Math.max(1, Math.min(60000, requestedTimeout > 0 ? requestedTimeout : defaultTimeout));
  return {
    id: `macro:${step.id}`,
    type: `macro-${step.type}`,
    failureBehavior: step.optional ? 'continue' : null,
    timeoutMs,
    success: { completed: true },
    metadata: {
      macroStepId: step.id
    }
  };
}

async function loadMacroScenario(filePath, { config = {}, format = 'auto', cwd = process.cwd(), env = process.env, adapterRoot = null, cacheRoot = null } = {}) {
  const selectedFormat = String(format || 'auto').trim();
  if (!IMPORTABLE_FORMATS.has(selectedFormat)) {
    throw new Error(`Unsupported macro import format ${selectedFormat}.`);
  }
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`Macro file not found: ${filePath}`);
  }
  const registry = await loadMacroRegistry(config, { cwd, adapterRoot, cacheRoot });
  const imported = registry.parseMacroDocument(fs.readFileSync(absolutePath, 'utf8'), {
    format: selectedFormat,
    fileName: path.basename(absolutePath)
  });
  if (!imported.acceptable) {
    const blocking = imported.diagnostics.find((entry) => entry.level === 'error');
    throw new Error(blocking && blocking.message || 'The macro contains blocking conversion errors.');
  }
  const targetOrigin = assertMacroFlowScope(imported.flow, config);
  const runtime = runtimeValues(imported.flow, imported.secretValues, env);
  const enabledSteps = imported.flow.steps.filter((step) => step.enabled !== false);
  if (!enabledSteps.length) throw new Error('The macro does not contain enabled steps.');
  const compiled = compileScenario({
    version: 'ptk-scenario-v2',
    steps: enabledSteps.map(macroScenarioStep),
    metadata: {
      source: 'macro',
      sourceFormat: imported.format,
      sourceFile: path.basename(absolutePath),
      targetOrigin,
      routeHints: enabledSteps
        .filter((step) => step.type === 'navigate' && step.url)
        .map((step) => step.url)
    }
  });
  return {
    ...compiled,
    macroRuntime: {
      flow: imported.flow,
      stepsById: new Map(imported.flow.steps.map((step) => [step.id, step])),
      secrets: runtime.secrets,
      variables: runtime.variables,
      targetOrigin,
      sourceFormat: imported.format,
      diagnostics: imported.diagnostics
    }
  };
}

module.exports = {
  ADAPTER_FILES,
  IMPORTABLE_FORMATS,
  assertMacroFlowScope,
  loadMacroRegistry,
  loadMacroScenario,
  macroAdapterRoot,
  macroEnvironmentName,
  runtimeValues
};
