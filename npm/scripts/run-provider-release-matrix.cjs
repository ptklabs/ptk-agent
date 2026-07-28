#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

const REQUIRED_ENGINES = ['DAST', 'SAST', 'IAST', 'SCA'];
const ROWS = Object.freeze([
  { provider: 'browserbase', framework: 'playwright', browser: 'Chromium', required: true },
  { provider: 'browserbase', framework: 'puppeteer', browser: 'Chromium', required: true },
  { provider: 'browserbase', framework: 'selenium', browser: 'Chrome', required: true },
  { provider: 'browserless', framework: 'playwright', browser: 'Chromium', required: true },
  { provider: 'browserless', framework: 'puppeteer', browser: 'Chromium', required: true },
  { provider: 'hyperbrowser', framework: 'playwright', browser: 'Chromium', required: true },
  { provider: 'hyperbrowser', framework: 'puppeteer', browser: 'Chromium', required: true },
  { provider: 'hyperbrowser', framework: 'selenium', browser: 'Chrome', required: false },
  { provider: 'browserstack', framework: 'playwright', browser: 'Chrome', required: false },
  { provider: 'browserstack', framework: 'puppeteer', browser: 'Chrome', required: false },
  { provider: 'browserstack', framework: 'selenium', browser: 'Chrome', required: true },
  { provider: 'steel', framework: 'playwright', browser: 'Chromium', required: true },
  { provider: 'steel', framework: 'puppeteer', browser: 'Chromium', required: true },
  { provider: 'steel', framework: 'selenium', browser: 'Chrome', required: false },
  { provider: 'testmu', framework: 'playwright', browser: 'Chrome', required: false },
  { provider: 'testmu', framework: 'puppeteer', browser: 'Chrome', required: false },
  { provider: 'testmu', framework: 'selenium', browser: 'Chrome', required: false }
]);

function parseArgs(argv) {
  const options = { providers: [], frameworks: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package-root') options.packageRoot = argv[++index];
    else if (arg === '--env-file') options.envFile = argv[++index];
    else if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--provider') options.providers.push(String(argv[++index] || '').toLowerCase());
    else if (arg === '--framework') options.frameworks.push(String(argv[++index] || '').toLowerCase());
    else if (arg === '--list') options.list = true;
    else if (arg === '--all') options.all = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function loadEnvironment(envFile) {
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) throw new Error(`Provider matrix env file was not found: ${resolved}`);
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('The internal provider matrix runner requires Node.js 20.12 or newer for process.loadEnvFile().');
  }
  process.loadEnvFile(resolved);
  return resolved;
}

function resolveTarget() {
  const raw = process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL;
  if (!raw) {
    throw new Error('PTK_PROVIDER_TARGET_URL or JUICE_SHOP_URL must explicitly select the approved provider-reachable target.');
  }
  const target = new URL(raw);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Provider matrix target must use http:// or https://.');
  return target.toString();
}

function connectionTarget(connection, framework) {
  return framework === 'selenium' ? connection.driver : connection.page;
}

function navigationContract(connection, framework) {
  if (framework === 'selenium') {
    return {
      navigate: (url) => connection.driver.get(url),
      currentUrl: () => connection.driver.getCurrentUrl()
    };
  }
  if (framework === 'puppeteer' && connection.page.setDefaultNavigationTimeout) {
    connection.page.setDefaultNavigationTimeout(90000);
  }
  return {
    navigate: (url) => connection.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }),
    currentUrl: () => connection.page.url()
  };
}

function connectorName(row) {
  const providerNames = {
    browserbase: 'Browserbase',
    browserless: 'Browserless',
    hyperbrowser: 'Hyperbrowser',
    browserstack: 'BrowserStack',
    steel: 'Steel',
    testmu: 'TestMu'
  };
  const frameworkNames = {
    playwright: 'Playwright',
    puppeteer: 'Puppeteer',
    selenium: 'Selenium'
  };
  return `connect${providerNames[row.provider]}${frameworkNames[row.framework]}`;
}

function providerOptions(row, packageRoot, outputDir) {
  const common = {
    packageRoot,
    cacheRoot: path.join(outputDir, '.extension-cache'),
    project: `ptk-provider-matrix-${row.provider}-${row.framework}`,
    build: `PTK 9.9.8 provider matrix ${timestamp()}`,
    name: `PTK ${row.provider} ${row.framework}`
  };
  if (row.provider === 'browserless') {
    common.timeoutMs = Number(process.env.BROWSERLESS_TIMEOUT_MS || 60000);
  }
  if (row.provider === 'steel') {
    common.timeoutMs = Number(process.env.STEEL_TIMEOUT_MS || 180000);
  }
  if (row.provider === 'browserbase') {
    common.timeoutSeconds = Number(process.env.BROWSERBASE_TIMEOUT_SECONDS || 180);
  }
  return common;
}

function findingsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.findings)) return payload.findings;
  if (Array.isArray(payload && payload.items)) return payload.items;
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload && payload.data && payload.data.findings)) return payload.data.findings;
  return [];
}

function bestPayload(result, field) {
  const after = result && result.afterStop && result.afterStop[field];
  const before = result && result.beforeStop && result.beforeStop[field];
  if (field === 'findings') {
    return findingsFromPayload(after).length >= findingsFromPayload(before).length ? after : before;
  }
  return after && after.ok !== false ? after : before;
}

function engineName(finding) {
  return String(finding && (finding.engine || finding.scanEngine || finding.sourceEngine) || 'UNKNOWN').toUpperCase();
}

function findingCounts(payload) {
  const counts = Object.fromEntries(REQUIRED_ENGINES.map((engine) => [engine, 0]));
  for (const finding of findingsFromPayload(payload)) {
    const name = engineName(finding);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function progressEngines(progress) {
  return progress && progress.engines && typeof progress.engines === 'object' ? progress.engines : {};
}

function engineEvidence(progress) {
  const engines = progressEngines(progress);
  const normalized = {};
  for (const engine of REQUIRED_ENGINES) {
    const state = engines[engine] || engines[engine.toLowerCase()] || null;
    const details = state && state.progress && typeof state.progress === 'object' ? state.progress : state || {};
    const status = String(state && (state.status || state.phase) || '').toLowerCase();
    const running = state && (state.isRunning === true || state.running === true);
    const remaining = Number(details.remaining);
    const done = Number(details.done === undefined ? details.completed : details.done);
    const total = Number(details.total === undefined ? details.planned : details.total);
    const terminal = Boolean(state) && (
      /complete|completed|done|stopped|idle|finished/.test(status) ||
      (!running && Number.isFinite(remaining) && remaining <= 0) ||
      (!running && Number.isFinite(done) && Number.isFinite(total) && done >= total)
    );
    normalized[engine] = {
      observed: Boolean(state),
      status: status || null,
      terminal,
      failed: /error|failed/.test(status),
      done: Number.isFinite(done) ? done : null,
      total: Number.isFinite(total) ? total : null,
      remaining: Number.isFinite(remaining) ? remaining : null
    };
  }
  return normalized;
}

function exportSucceeded(result) {
  const candidates = [
    result && result.beforeStop && result.beforeStop.export,
    result && result.afterStop && result.afterStop.export
  ];
  return candidates.some((payload) => payload && payload.ok !== false && !payload.collectionError);
}

function collectionDiagnostics(result) {
  const diagnostics = {};
  for (const phase of ['beforeStop', 'afterStop']) {
    const collected = result && result[phase];
    if (!collected || typeof collected !== 'object') continue;
    for (const field of ['progress', 'findings', 'stats', 'export']) {
      const value = collected[field];
      if (!value || typeof value !== 'object' || value.ok !== false) continue;
      const error = value.collectionError || {};
      diagnostics[`${phase}.${field}`] = {
        code: error.code || value.code || null,
        message: error.message || value.error || value.message || 'collection_failed'
      };
    }
  }
  return diagnostics;
}

function stopDiagnostic(result) {
  const stop = result && result.stop;
  if (!stop || typeof stop !== 'object') return null;
  return {
    ok: stop.ok !== false,
    status: stop.status || stop.completionStatus || stop.summary && stop.summary.status || null,
    error: stop.error || null
  };
}

function secretValues() {
  return [
    'BROWSERBASE_API_KEY',
    'BROWSERLESS_API_KEY',
    'BROWSERLESS_TOKEN',
    'HYPERBROWSER_API_KEY',
    'BROWSERSTACK_USERNAME',
    'BROWSERSTACK_ACCESS_KEY',
    'STEEL_API_KEY',
    'LT_USERNAME',
    'LT_ACCESS_KEY'
  ].map((name) => process.env[name]).filter((value) => typeof value === 'string' && value.length >= 4);
}

function containsSecret(payload) {
  const text = JSON.stringify(payload);
  return secretValues().some((secret) => text.includes(secret) || text.includes(encodeURIComponent(secret)));
}

function sanitizeEvidence(payload, redact) {
  const secrets = secretValues()
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .sort((a, b) => b.length - a.length);
  function visit(value) {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, visit(nested)]));
  }
  return redact(visit(payload));
}

function classifyFailure(error) {
  const text = String(error && error.message || error || '').toLowerCase();
  if (/required|credential|api key|access key|username/.test(text)) return 'credentials_missing';
  if (/extension-bearing default.*context/.test(text)) return 'default_context_missing';
  if (/ptk.*not.*ready|bridge/.test(text)) return 'bridge_not_available';
  if (/engine.*participate/.test(text)) return 'engine_incomplete';
  if (/extension.*upload|upload.*extension/.test(text)) return 'extension_upload_failed';
  if (/connect|websocket|cdp|browser.*start/.test(text)) return 'browser_connect_failed';
  if (/timeout|timed out/.test(text)) return 'scan_timeout';
  return 'test_assertion_failed';
}

function safeConnectionDiagnostic(connection) {
  if (!connection) return null;
  return {
    framework: connection.framework || null,
    connectMode: connection.connectMode || null,
    extensionSource: connection.extension && connection.extension.source || null,
    endpoint: connection.endpoint || null,
    sessionInfo: connection.sessionInfo || null
  };
}

async function runRow(row, context) {
  const rowDir = path.join(context.outputDir, row.provider, row.framework);
  fs.mkdirSync(rowDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const provider = context.packageRequire(`pentestkit/providers/${row.provider}`);
  const framework = context.packageRequire(`pentestkit/${row.framework}`);
  const connector = provider[connectorName(row)];
  if (typeof connector !== 'function') throw new Error(`Installed package does not export ${connectorName(row)}.`);

  let connection = null;
  let providerRuntimeDiagnostics = null;
  let scanSummary = null;
  let failure = null;
  let cleanup = { attempted: false, succeeded: false };
  try {
    connection = await connector(providerOptions(row, context.packageRoot, context.outputDir));
    const navigation = navigationContract(connection, row.framework);
    scanSummary = await context.runPtkProviderExample({
      withPtkScan: framework.withPtkScan,
      scanTarget: connectionTarget(connection, row.framework),
      targetUrl: context.targetUrl,
      project: `ptk-provider-matrix-${row.provider}-${row.framework}`,
      resultsDir: path.join(rowDir, 'ptk'),
      ...navigation
    });
  } catch (error) {
    failure = error;
    const inspectExtensionRuntime = provider.inspectBrowserStackExtensionRuntime || provider.inspectSteelExtensionRuntime;
    if (connection && typeof inspectExtensionRuntime === 'function') {
      providerRuntimeDiagnostics = await inspectExtensionRuntime(connection);
    }
  } finally {
    if (connection && typeof connection.close === 'function') {
      cleanup.attempted = true;
      try {
        await connection.close();
        await connection.close();
        cleanup.succeeded = true;
      } catch (error) {
        cleanup.error = { message: error.message || String(error) };
        if (!failure) failure = error;
      }
    } else if (!connection) {
      cleanup = { attempted: false, succeeded: true, handledByConnector: true };
    }
  }

  const result = scanSummary && scanSummary.result;
  const progress = bestPayload(result, 'progress');
  const engines = engineEvidence(progress);
  const allObserved = REQUIRED_ENGINES.every((engine) => engines[engine].observed);
  const noEngineFailures = REQUIRED_ENGINES.every((engine) => !engines[engine].failed);
  const allTerminal = REQUIRED_ENGINES.every((engine) => engines[engine].terminal);
  const participationPassed = Boolean(scanSummary && scanSummary.participation && scanSummary.participation.passed);
  const exported = exportSucceeded(result);
  // PTK rejects exportScan with session_not_completed until the background
  // session is terminal, so a successful export is stronger completion
  // evidence than a stale provider-side progress snapshot.
  const completionEvidence = allTerminal ? 'terminal_progress' : exported ? 'completed_export' : 'none';
  const summary = {
    schemaVersion: 'ptk-provider-release-row-v1',
    provider: row.provider,
    framework: row.framework,
    browser: row.browser,
    required: row.required,
    packageVersion: context.packageJson.version,
    extensionVersion: context.provenance.extensionVersion,
    extensionSha256: context.provenance.hashes && context.provenance.hashes.zipSha256 || null,
    targetOrigin: new URL(context.targetUrl).origin,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    providerConnection: safeConnectionDiagnostic(connection),
    providerRuntimeDiagnostics,
    sessionCreated: Boolean(connection),
    bridgeAvailable: Boolean(result && result.scanStarted),
    scanStarted: Boolean(result && result.scanStarted),
    scanStopped: Boolean(result && result.sessionStopped),
    stopDiagnostic: stopDiagnostic(result),
    requiredEngines: REQUIRED_ENGINES,
    participationPassed,
    completionEvidence,
    engines,
    findingsByEngine: findingCounts(bestPayload(result, 'findings')),
    findingsTotal: scanSummary ? scanSummary.findingsCount : 0,
    collectionDiagnostics: collectionDiagnostics(result),
    exportSucceeded: exported,
    scopeStatus: result && result.scanStartUrl && new URL(result.scanStartUrl).origin === new URL(context.targetUrl).origin ? 'pass' : 'not_proven',
    cleanup,
    failureClass: failure ? classifyFailure(failure) : null,
    failure: failure ? { message: failure.message || String(failure), code: failure.code || null } : null
  };
  summary.redactionAuditPassed = !containsSecret(summary);
  summary.status = !failure && result && result.ok && participationPassed && allObserved && noEngineFailures && completionEvidence !== 'none' && exported && cleanup.succeeded && summary.redactionAuditPassed
    ? 'pass'
    : 'fail';
  if (summary.status === 'fail' && !summary.failureClass) {
    summary.failureClass = !participationPassed || !allObserved || !noEngineFailures || completionEvidence === 'none'
      ? 'engine_incomplete'
      : !exported
        ? 'export_failed'
        : !cleanup.succeeded
          ? 'cleanup_failed'
          : !summary.redactionAuditPassed
            ? 'test_assertion_failed'
            : 'test_assertion_failed';
  }

  const safeSummary = context.sanitize(summary);
  writeJson(path.join(rowDir, 'summary.json'), safeSummary);
  writeJson(path.join(rowDir, 'engine-participation.json'), context.sanitize({ engines, findingsByEngine: summary.findingsByEngine }));
  writeJson(path.join(rowDir, 'cleanup.json'), context.sanitize(cleanup));
  writeJson(path.join(rowDir, 'redaction-audit.json'), { passed: summary.redactionAuditPassed });
  return safeSummary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const row of ROWS) console.log(`${row.provider}\t${row.framework}\t${row.browser}\t${row.required ? 'required' : 'candidate'}`);
    return;
  }
  const envFile = loadEnvironment(options.envFile || path.resolve(__dirname, '../../.env'));
  const packageRoot = path.resolve(options.packageRoot || process.env.PTK_PACKAGE_ROOT || '');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!packageRoot || !fs.existsSync(packageJsonPath)) {
    throw new Error('--package-root must point to the pentestkit package installed from the release tarball.');
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.name !== 'pentestkit') throw new Error(`Unexpected installed package: ${packageJson.name || 'unknown'}`);
  const provenance = JSON.parse(fs.readFileSync(path.join(packageRoot, 'extensions', 'extension-provenance.json'), 'utf8'));
  const packageRequire = createRequire(packageJsonPath);
  const redact = packageRequire(path.join(packageRoot, 'browser', 'src', 'redact.cjs')).redact;
  const helper = await import(pathToFileURL(path.join(packageRoot, 'providers', '_shared', 'examples', 'run-ptk-example.mjs')).href);
  const targetUrl = resolveTarget();
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), '.runs', 'provider-release-matrix', timestamp()));
  const selected = ROWS.filter((row) => (
    (options.all || options.providers.length === 0 || options.providers.includes(row.provider)) &&
    (options.frameworks.length === 0 || options.frameworks.includes(row.framework))
  ));
  if (!selected.length) throw new Error('No provider matrix rows matched the requested filters.');

  const context = {
    envFile,
    outputDir,
    packageRoot,
    packageJson,
    provenance,
    packageRequire,
    redact,
    sanitize: (payload) => sanitizeEvidence(payload, redact),
    runPtkProviderExample: helper.runPtkProviderExample,
    targetUrl
  };
  const results = [];
  for (const row of selected) {
    process.stdout.write(`Running ${row.provider}/${row.framework} ... `);
    const result = await runRow(row, context);
    results.push(result);
    process.stdout.write(`${result.status}\n`);
  }
  const matrixPath = path.join(outputDir, 'matrix.json');
  let priorRows = [];
  if (fs.existsSync(matrixPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
      if (prior.packageVersion === packageJson.version && prior.targetOrigin === new URL(targetUrl).origin && Array.isArray(prior.rows)) {
        priorRows = prior.rows;
      }
    } catch {
      priorRows = [];
    }
  }
  const summarizedResults = results.map((row) => ({
    provider: row.provider,
    framework: row.framework,
    browser: row.browser,
    required: row.required,
    status: row.status,
    failureClass: row.failureClass,
    findingsByEngine: row.findingsByEngine,
    participationPassed: row.participationPassed,
    completionEvidence: row.completionEvidence,
    exportSucceeded: row.exportSucceeded,
    cleanup: row.cleanup && row.cleanup.succeeded ? 'pass' : 'fail'
  }));
  const mergedRows = new Map(priorRows.map((row) => [`${row.provider}/${row.framework}`, row]));
  for (const row of summarizedResults) mergedRows.set(`${row.provider}/${row.framework}`, row);
  const matrix = {
    schemaVersion: 'ptk-provider-release-matrix-v1',
    generatedAt: new Date().toISOString(),
    packageVersion: packageJson.version,
    extensionVersion: provenance.extensionVersion,
    targetOrigin: new URL(targetUrl).origin,
    rows: [...mergedRows.values()].sort((left, right) => (
      ROWS.findIndex((row) => row.provider === left.provider && row.framework === left.framework) -
      ROWS.findIndex((row) => row.provider === right.provider && row.framework === right.framework)
    ))
  };
  matrix.redactionAuditPassed = !containsSecret(matrix);
  writeJson(matrixPath, sanitizeEvidence(matrix, redact));
  console.log(`Provider matrix evidence: ${outputDir}`);
  if (results.some((row) => row.required && row.status !== 'pass')) process.exitCode = 1;
}

main().catch((error) => {
  const message = String(error && error.message || error || 'Provider matrix failed');
  let safeMessage = message;
  for (const secret of secretValues()) {
    safeMessage = safeMessage.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  }
  console.error(`Provider matrix failed: ${safeMessage}`);
  process.exitCode = 1;
});
