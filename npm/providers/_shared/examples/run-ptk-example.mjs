import { countFindings } from "../../../browser/src/index.mjs";

export const REQUIRED_ENGINES = Object.freeze(["DAST", "SAST", "IAST", "SCA"]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeTargetUrl(value) {
  const url = new URL(String(value || ""));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PTK provider examples require an http:// or https:// target.');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function assertInScope(actualUrl, targetUrl) {
  const actual = new URL(String(actualUrl || ''));
  const target = new URL(targetUrl);
  if (actual.origin !== target.origin) {
    throw new Error(`PTK provider example refused out-of-scope navigation to ${actual.origin}.`);
  }
  return actual.toString();
}

function progressEngines(progress) {
  return progress && progress.engines && typeof progress.engines === 'object'
    ? progress.engines
    : {};
}

export function engineParticipation(progress, requiredEngines = REQUIRED_ENGINES) {
  const engines = progressEngines(progress);
  const observed = Object.keys(engines).map((name) => String(name).toUpperCase());
  const missing = requiredEngines.filter((name) => !observed.includes(name));
  const failed = Object.entries(engines)
    .filter(([, state]) => /error|failed/i.test(String(state && state.status || '')))
    .map(([name]) => String(name).toUpperCase());
  const pending = [];
  for (const engine of requiredEngines) {
    const state = engines[engine] || engines[engine.toLowerCase()] || null;
    if (!state) continue;
    const details = state.progress && typeof state.progress === 'object' ? state.progress : state;
    const status = String(state.status || state.phase || '').toLowerCase();
    const done = Number(details.done === undefined ? details.completed : details.done);
    const total = Number(details.total === undefined ? details.planned : details.total);
    const remaining = Number(details.remaining);
    if (engine === 'SAST') {
      const complete = /complete|completed|done|idle|finished/.test(status) ||
        (Number.isFinite(total) && total > 0 && Number.isFinite(done) && done >= total) ||
        (Number.isFinite(remaining) && remaining <= 0);
      if (!complete) pending.push(engine);
    } else if (engine === 'DAST') {
      const active = /complete|completed|done|idle|finished/.test(status) ||
        (Number.isFinite(done) && done > 0) ||
        (Number.isFinite(remaining) && remaining <= 0);
      if (!active) pending.push(engine);
    }
  }
  return {
    required: requiredEngines.slice(),
    observed: observed.sort(),
    missing,
    failed,
    pending,
    passed: missing.length === 0 && failed.length === 0 && pending.length === 0
  };
}

export async function waitForEngineParticipation(ptk, options = {}) {
  const requiredEngines = options.engines || REQUIRED_ENGINES;
  const timeoutMs = positiveInteger(
    options.timeoutMs || process.env.PTK_PROVIDER_ENGINE_TIMEOUT_MS,
    45000
  );
  const pollMs = positiveInteger(options.pollMs || process.env.PTK_PROVIDER_POLL_MS, 1000);
  const deadline = Date.now() + timeoutMs;
  let progress = null;
  let gate = engineParticipation(progress, requiredEngines);
  do {
    progress = await ptk.getSessionProgress();
    gate = engineParticipation(progress, requiredEngines);
    if (gate.passed || gate.failed.length > 0) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (!gate.passed) {
    throw new Error(
      `PTK engines did not all participate: missing=${gate.missing.join(',') || 'none'} ` +
      `failed=${gate.failed.join(',') || 'none'} pending=${gate.pending.join(',') || 'none'}`
    );
  }
  return { progress, gate };
}

function bestFindings(result) {
  const after = result && result.afterStop && result.afterStop.findings;
  const before = result && result.beforeStop && result.beforeStop.findings;
  return countFindings(after) >= countFindings(before) ? after : before;
}

export async function runPtkProviderExample(options) {
  const targetUrl = normalizeTargetUrl(options.targetUrl);
  const targetOrigin = new URL(targetUrl).origin;
  const searchUrl = `${targetOrigin}/#/search?q=ptk-provider-example`;
  const result = await options.withPtkScan(options.scanTarget, {
    project: options.project,
    engines: REQUIRED_ENGINES,
    deferStart: true,
    resultsDir: options.resultsDir,
    wait: { activate: false },
    stop: { wait: true },
    collect: {
      beforeStop: { progress: true, findings: true, stats: true },
      afterStop: { progress: true, findings: true, stats: true },
      export: true,
      timeoutMs: 0,
      pollMs: 1000
    }
  }, async ({ ptk, startPtkScan }) => {
    await options.navigate(`${targetOrigin}/`);
    assertInScope(await options.currentUrl(), targetUrl);
    await startPtkScan();

    // Same-origin child routes are intentionally eligible for PTK coverage.
    await options.navigate(searchUrl);
    assertInScope(await options.currentUrl(), targetUrl);
    return waitForEngineParticipation(ptk, { engines: REQUIRED_ENGINES });
  });

  const participation = result.journeyResult && result.journeyResult.gate;
  const findings = bestFindings(result);
  return {
    result,
    participation,
    findings,
    findingsCount: countFindings(findings)
  };
}

export function printPtkProviderExampleSummary(summary) {
  console.log(`PTK engines: ${summary.participation.observed.join(', ')}`);
  console.log(`PTK findings: ${summary.findingsCount}`);
  console.log(`PTK results: ${summary.result.resultsDir}`);
}
