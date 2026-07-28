'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePtkExtensionPath } = require('../browser/extensionResolver.cjs');
const { resolveConfig, redactSecrets } = require('../core/config.cjs');
const { ARTIFACT_FILENAMES, readJsonArtifact } = require('../core/artifacts.cjs');
const { compareArtifacts } = require('../core/comparison.cjs');
const { runPtkAgent } = require('../core/runner.cjs');
const { resolveModules } = require('../modules/moduleResolver.cjs');
const { summarizeFindings } = require('../evidence/ptkEvidenceAdapter.cjs');

const MAX_JSON_BYTES = 2_000_000;
const DEFAULT_FINDING_LIMIT = 50;
const MAX_FINDING_LIMIT = 200;
const DEFAULT_MCP_SCAN_MAX_ROUTES = 25;
const MAX_MCP_SCAN_ROUTES = 200;

function createMcpToolHandlers(options = {}) {
  const context = createMcpToolContext(options);
  return {
    context,
    async call(name, args = {}) {
      switch (name) {
        case 'ptk_doctor_extension':
          return doctorExtension(args, context);
        case 'ptk_validate_config':
          return validateConfigTool(args, context);
        case 'ptk_resolve_config':
          return resolveConfigTool(args, context);
        case 'ptk_resolve_modules':
          return resolveModulesTool(args, context);
        case 'ptk_list_artifacts':
          return listArtifactsTool(args, context);
        case 'ptk_read_scan_summary':
          return readScanSummaryTool(args, context);
        case 'ptk_read_findings_summary':
          return readFindingsSummaryTool(args, context);
        case 'ptk_compare_artifacts':
          return compareArtifactsTool(args, context);
        case 'ptk_run_scan':
          return runScanTool(args, context);
        case 'ptk_execute_policy_checked_browser_mission':
          return unsupportedBrowserMissionTool(args, context);
        case 'ptk_get_raw_debug_state':
          return unsafeDebugTool(args, context);
        default:
          throw toolError(`Unknown PTK MCP tool: ${name}`, 'unknown_tool');
      }
    }
  };
}

function createMcpToolContext(options = {}) {
  const workspace = realpathExistingDirectory(options.workspace || options.cwd || process.cwd(), 'workspace');
  return {
    workspace,
    cwd: workspace,
    env: options.env || process.env,
    allowScan: options.allowScan === true,
    allowBrowserActions: options.allowBrowserActions === true,
    includeUnsafe: options.includeUnsafe === true,
    stderr: options.stderr || process.stderr
  };
}

function realpathExistingDirectory(candidate, label) {
  const resolved = fs.realpathSync(path.resolve(candidate));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw toolError(`${label} is not a directory: ${candidate}`, `${label}_not_directory`);
  }
  return resolved;
}

function assertPlainObject(value, label = 'arguments') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw toolError(`${label} must be an object`, 'invalid_arguments');
  }
  return value;
}

function safeWorkspacePath(input, context, options = {}) {
  const label = options.label || 'path';
  if (typeof input !== 'string' || input.trim() === '') {
    throw toolError(`${label} must be a non-empty path`, 'invalid_path');
  }
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(context.workspace, input);
  if (!isInsidePath(resolved, context.workspace)) {
    throw toolError(`${label} must resolve inside MCP workspace`, 'path_outside_workspace', {
      workspace: context.workspace
    });
  }
  if (options.mustExist !== false) {
    if (!fs.existsSync(resolved)) {
      throw toolError(`${label} not found: ${input}`, 'path_not_found');
    }
    const real = fs.realpathSync(resolved);
    if (!isInsidePath(real, context.workspace)) {
      throw toolError(`${label} resolves outside MCP workspace`, 'path_symlink_escapes_workspace', {
        workspace: context.workspace
      });
    }
    if (options.directory === true && !fs.statSync(real).isDirectory()) {
      throw toolError(`${label} must be a directory: ${input}`, 'path_not_directory');
    }
    if (options.file === true && !fs.statSync(real).isFile()) {
      throw toolError(`${label} must be a file: ${input}`, 'path_not_file');
    }
    return real;
  }
  return resolved;
}

function isInsidePath(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readJsonBounded(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_JSON_BYTES) {
    throw toolError(`Artifact is too large for MCP summary read: ${path.basename(filePath)}`, 'artifact_too_large', {
      bytes: stat.size,
      maxBytes: MAX_JSON_BYTES
    });
  }
  return readJsonArtifact(filePath);
}

function maybeReadJson(outputDir, artifactKey) {
  const fileName = ARTIFACT_FILENAMES[artifactKey];
  if (!fileName) return null;
  const filePath = path.join(outputDir, fileName);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return readJsonBounded(filePath);
}

function relativeToWorkspace(filePath, context) {
  return path.relative(context.workspace, filePath).replace(/\\/g, '/');
}

function toolError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function readOptionalConfigFile(args, context) {
  if (!args.configPath) return {};
  const configPath = safeWorkspacePath(args.configPath, context, {
    label: 'configPath',
    file: true
  });
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw toolError(`Invalid JSON in configPath: ${error.message}`, 'invalid_config_json');
  }
}

async function doctorExtension(args = {}, context) {
  assertPlainObject(args);
  const config = readOptionalConfigFile(args, context);
  const configPath = args.configPath ? safeWorkspacePath(args.configPath, context, {
    label: 'configPath',
    file: true
  }) : null;
  const ptk = config.ptk && typeof config.ptk === 'object' ? config.ptk : {};
  return redactSecrets(resolvePtkExtensionPath({
    cwd: context.workspace,
    configPath,
    configuredPath: ptk.extensionPath || null,
    autoDetectExtension: ptk.autoDetectExtension !== false,
    env: context.env
  }));
}

function validateConfigTool(args = {}, context) {
  assertPlainObject(args);
  const configPath = safeWorkspacePath(args.configPath, context, {
    label: 'configPath',
    file: true
  });
  const resolved = resolveConfig({
    configPath,
    cwd: context.workspace
  });
  return redactSecrets({
    ok: true,
    config: resolved
  });
}

function buildMcpOverrides(args = {}, context) {
  const overrides = {};
  if (args.targetUrl !== undefined) {
    if (typeof args.targetUrl !== 'string' || !/^https?:\/\//i.test(args.targetUrl)) {
      throw toolError('targetUrl must be an absolute http(s) URL', 'invalid_target_url');
    }
    overrides.target = { baseUrl: args.targetUrl };
  }
  if (args.outputDir !== undefined) {
    const outputDir = safeWorkspacePath(args.outputDir, context, {
      label: 'outputDir',
      mustExist: false
    });
    overrides.artifacts = { outputDir: path.relative(context.workspace, outputDir) || '.' };
  }
  if (args.maxRoutes !== undefined) {
    const maxRoutes = Number(args.maxRoutes);
    if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 500) {
      throw toolError('maxRoutes must be an integer between 1 and 500', 'invalid_max_routes');
    }
    overrides.crawler = { maxRoutes };
  }
  if (args.engines !== undefined) {
    if (!Array.isArray(args.engines)) throw toolError('engines must be an array', 'invalid_engines');
    const engineSet = new Set(args.engines.map(engine => String(engine).toUpperCase()));
    for (const engine of engineSet) {
      if (!['DAST', 'IAST', 'SAST', 'SCA'].includes(engine)) throw toolError(`Unsupported engine: ${engine}`, 'invalid_engine');
    }
    overrides.engines = {
      dast: { enabled: engineSet.has('DAST'), modulePacks: ['free'] },
      iast: { enabled: engineSet.has('IAST'), modulePacks: ['free'] },
      sast: { enabled: engineSet.has('SAST'), modulePacks: ['free'] },
      sca: { enabled: engineSet.has('SCA'), modulePacks: [] }
    };
  }
  return overrides;
}

function resolveConfigTool(args = {}, context) {
  assertPlainObject(args);
  const configPath = safeWorkspacePath(args.configPath, context, {
    label: 'configPath',
    file: true
  });
  const resolved = resolveConfig({
    configPath,
    overrides: buildMcpOverrides(args, context),
    cwd: context.workspace
  });
  return redactSecrets({
    ok: true,
    config: resolved
  });
}

function resolveModulesTool(args = {}, context) {
  assertPlainObject(args);
  const config = args.configPath
    ? resolveConfig({
      configPath: safeWorkspacePath(args.configPath, context, {
        label: 'configPath',
        file: true
      }),
      cwd: context.workspace
    })
    : {};
  return redactSecrets(resolveModules(config, {
    cwd: context.workspace,
    env: context.env
  }));
}

function listArtifactsTool(args = {}, context) {
  assertPlainObject(args);
  const outputDir = safeWorkspacePath(args.outputDir, context, {
    label: 'outputDir',
    directory: true
  });
  const artifacts = [];
  for (const [key, fileName] of Object.entries(ARTIFACT_FILENAMES)) {
    const filePath = path.join(outputDir, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const stat = fs.statSync(filePath);
    artifacts.push({
      key,
      fileName,
      path: relativeToWorkspace(filePath, context),
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: fileName.endsWith('.jsonl') ? 'jsonl' : 'json'
    });
  }
  return {
    ok: true,
    outputDir: relativeToWorkspace(outputDir, context) || '.',
    count: artifacts.length,
    artifacts
  };
}

function readScanSummaryTool(args = {}, context) {
  assertPlainObject(args);
  const outputDir = safeWorkspacePath(args.outputDir, context, {
    label: 'outputDir',
    directory: true
  });
  const summary = maybeReadJson(outputDir, 'summary') || {};
  const coverage = maybeReadJson(outputDir, 'coverage') || {};
  const engineSummary = maybeReadJson(outputDir, 'engineSummary') || null;
  const lifecycle = maybeReadJson(outputDir, 'ptkLifecycleNormalized') || maybeReadJson(outputDir, 'ptkLifecycle') || null;
  const scenario = maybeReadJson(outputDir, 'scenarioResult') || coverage.scenario || null;
  const agentSummary = maybeReadJson(outputDir, 'agentSummary') || null;
  return redactSecrets({
    ok: true,
    outputDir: relativeToWorkspace(outputDir, context) || '.',
    status: summary.status || summary.mode && summary.mode.actual || null,
    runId: summary.runId || coverage.runId || null,
    counts: {
      routes: number(summary.routeCount, coverage.routeCount, arrayLength(coverage.routes)),
      routeShapes: number(summary.routeShapeCount, coverage.routeShapeCount, arrayLength(coverage.routeShapes)),
      endpoints: number(summary.endpointCount, coverage.endpointCount, arrayLength(coverage.endpoints)),
      forms: number(summary.formCount, coverage.formCount, arrayLength(coverage.forms)),
      actions: number(summary.actionCount, coverage.actionCount, arrayLength(coverage.actions)),
      findings: number(summary.findingsCount, coverage.ptk && coverage.ptk.findings && coverage.ptk.findings.count),
      errors: number(summary.errorCount, summary.counters && summary.counters.errors)
    },
    engines: engineSummary && {
      requestedEngines: engineSummary.requestedEngines || [],
      enabled: engineSummary.enabled || {},
      modules: engineSummary.modules || null
    },
    ptk: lifecycle && {
      status: lifecycle.status || null,
      bridgeDetected: Boolean(lifecycle.bridgeDetected),
      scanStarted: Boolean(lifecycle.scanStarted),
      scanStopped: Boolean(lifecycle.scanStopped),
      exportSucceeded: Boolean(lifecycle.exportSucceeded),
      exportFailureReason: lifecycle.exportFailureReason || null,
      inconsistencies: lifecycle.inconsistencies || []
    },
    scenario: scenario && {
      status: scenario.status || null,
      ok: scenario.ok !== false,
      completed: scenario.completed || scenario.completedSteps || null,
      failedStep: scenario.failedStep || scenario.failedStepId || null,
      failureReason: scenario.failureReason || null
    },
    agent: agentSummary && {
      status: agentSummary.status || null,
      actual: agentSummary.actual || null,
      stopReason: agentSummary.stopReason || null,
      missionCount: agentSummary.missionCount || 0,
      choiceCount: agentSummary.choiceCount || 0,
      resultCount: agentSummary.resultCount || 0,
      addedCoverage: agentSummary.addedCoverage || null
    }
  });
}

function readFindingsSummaryTool(args = {}, context) {
  assertPlainObject(args);
  const outputDir = safeWorkspacePath(args.outputDir, context, {
    label: 'outputDir',
    directory: true
  });
  const limit = clampLimit(args.limit, DEFAULT_FINDING_LIMIT, MAX_FINDING_LIMIT);
  const findingsCountArtifact = maybeReadJson(outputDir, 'ptkFindingsCount');
  const coverage = maybeReadJson(outputDir, 'coverage') || {};
  const summary = findingsCountArtifact || summarizeFindings(coverage.ptk && coverage.ptk.evidence || coverage.ptk || coverage);
  const samples = Array.isArray(summary.samples) ? summary.samples.slice(0, limit) : [];
  return redactSecrets({
    ok: true,
    outputDir: relativeToWorkspace(outputDir, context) || '.',
    findingsCount: number(summary.findingsCount, summary.count, samples.length),
    bySeverity: summary.bySeverity || {},
    byEngine: summary.byEngine || {},
    truncated: Boolean(summary.truncated || (summary.samples && summary.samples.length > limit)),
    samples
  });
}

function compareArtifactsTool(args = {}, context) {
  assertPlainObject(args);
  const baselineArtifact = safeWorkspacePath(args.baselineArtifact, context, {
    label: 'baselineArtifact',
    file: true
  });
  const candidateArtifact = safeWorkspacePath(args.candidateArtifact, context, {
    label: 'candidateArtifact',
    file: true
  });
  return redactSecrets(compareArtifacts({
    baselineArtifact,
    candidateArtifact
  }));
}

async function runScanTool(args = {}, context) {
  assertPlainObject(args);
  if (!context.allowScan) {
    throw toolError('ptk_run_scan requires server flag --allow-scan', 'scan_not_allowed');
  }
  const configPath = args.configPath ? safeWorkspacePath(args.configPath, context, {
    label: 'configPath',
    file: true
  }) : null;
  if (!configPath && !args.url) {
    throw toolError('ptk_run_scan requires configPath or url', 'missing_scan_target');
  }
  const maxRoutes = clampLimit(args.maxRoutes, DEFAULT_MCP_SCAN_MAX_ROUTES, MAX_MCP_SCAN_ROUTES);
  const overrides = {};
  if (args.url !== undefined) {
    if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
      throw toolError('url must be an absolute http(s) URL', 'invalid_url');
    }
    overrides.target = { baseUrl: args.url };
  }
  if (args.outputDir !== undefined) {
    overrides.artifacts = {
      outputDir: path.relative(context.workspace, safeWorkspacePath(args.outputDir, context, {
        label: 'outputDir',
        mustExist: false
      })) || '.'
    };
  }
  if (args.scenarioPath !== undefined) {
    overrides.scenario = {
      enabled: true,
      file: path.relative(context.workspace, safeWorkspacePath(args.scenarioPath, context, {
        label: 'scenarioPath',
        file: true
      }))
    };
  }
  if (args.engines !== undefined) {
    if (!Array.isArray(args.engines)) throw toolError('engines must be an array', 'invalid_engines');
    const engineSet = new Set(args.engines.map(engine => String(engine).toUpperCase()));
    for (const engine of engineSet) {
      if (!['DAST', 'IAST', 'SAST', 'SCA'].includes(engine)) throw toolError(`Unsupported engine: ${engine}`, 'invalid_engine');
    }
    overrides.engines = {
      dast: { enabled: engineSet.has('DAST'), modulePacks: ['free'] },
      iast: { enabled: engineSet.has('IAST'), modulePacks: ['free'] },
      sast: { enabled: engineSet.has('SAST'), modulePacks: ['free'] },
      sca: { enabled: engineSet.has('SCA'), modulePacks: [] }
    };
  }
  overrides.crawler = {
    ...(overrides.crawler || {}),
    maxRoutes
  };
  const options = {
    cwd: context.workspace,
    configPath,
    overrides,
    dryRun: args.dryRun === true,
    throwOnError: false,
    quiet: true,
  };
  const result = await runPtkAgent(options);
  return redactSecrets({
    ok: result.ok,
    status: result.status,
    error: result.error,
    summary: {
      routes: result.telemetry && result.telemetry.routeCount || 0,
      endpoints: result.telemetry && result.telemetry.endpointCount || 0,
      forms: result.telemetry && result.telemetry.formCount || 0,
      findings: result.telemetry && result.telemetry.findingsCount || 0,
      errors: result.telemetry && result.telemetry.errorCount || 0
    },
    artifacts: result.artifacts,
    outputDir: result.config && result.config.artifacts && result.config.artifacts.outputDir || null
  });
}

function unsupportedBrowserMissionTool(_args = {}, context) {
  if (!context.allowBrowserActions) {
    throw toolError('Browser action tools require server flag --allow-browser-actions', 'browser_actions_not_allowed');
  }
  throw toolError('Policy-checked browser mission execution is not available in standalone MCP v1; use ptk_run_scan with --allow-scan.', 'browser_mission_not_available');
}

function unsafeDebugTool(_args = {}, context) {
  if (!context.includeUnsafe) {
    throw toolError('Unsafe debug tools require --include-unsafe', 'unsafe_not_allowed');
  }
  return {
    ok: true,
    workspace: context.workspace,
    allowScan: context.allowScan,
    allowBrowserActions: context.allowBrowserActions,
    includeUnsafe: context.includeUnsafe
  };
}

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw toolError(`limit must be an integer between 1 and ${max}`, 'invalid_limit');
  }
  return Math.min(numberValue, max);
}

function number(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function safeToolError(error) {
  return {
    ok: false,
    error: {
      message: error && error.message ? String(error.message) : String(error),
      code: error && error.code ? String(error.code) : 'tool_error',
      details: redactSecrets(error && error.details || {})
    }
  };
}

module.exports = {
  MAX_MCP_SCAN_ROUTES,
  createMcpToolContext,
  createMcpToolHandlers,
  safeToolError,
  safeWorkspacePath,
  toolError
};
