'use strict';

const {
  PTKBridge,
  PtkBridgeError,
  REQUIRED_CAPABILITIES,
  VALID_ENGINES,
  createPtkBridge,
  normalizeEngines,
  sleep,
  validateCapabilities,
  waitForPtk
} = require('./ptkBridge.cjs');
const {
  PtkScanError,
  collectPtkResults,
  countFindings,
  resolveArtifactMode,
  writePtkResults
} = require('./results.cjs');
const {
  armPtkIastForNavigation
} = require('./preNavigation.cjs');

function resolveBootstrap(scanOptions = {}) {
  const bootstrapUrl = scanOptions.bootstrapUrl
    || (scanOptions.bootstrap && scanOptions.bootstrap.url)
    || (scanOptions.wait && scanOptions.wait.bootstrapUrl)
    || null;
  if (!bootstrapUrl) return null;
  const bootstrap = scanOptions.bootstrap && typeof scanOptions.bootstrap === 'object'
    ? scanOptions.bootstrap
    : {};
  return {
    url: String(bootstrapUrl),
    options: {
      waitUntil: bootstrap.waitUntil || scanOptions.bootstrapWaitUntil || 'domcontentloaded',
      timeout: Number(bootstrap.timeoutMs || bootstrap.timeout || scanOptions.bootstrapTimeoutMs || 30000)
    },
    retries: Math.max(0, Math.floor(numberOption([
      bootstrap.retries,
      bootstrap.maxRetries,
      scanOptions.bootstrapRetries
    ], 0))),
    retryDelayMs: Math.max(0, Math.floor(numberOption([
      bootstrap.retryDelayMs,
      bootstrap.retryDelay,
      scanOptions.bootstrapRetryDelayMs
    ], 1000)))
  };
}

function numberOption(values, fallback) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isRetriableBootstrapError(error) {
  const text = String((error && error.message) || error || '').toLowerCase();
  return text.includes('net::')
    || text.includes('err_connection_refused')
    || text.includes('err_connection_reset')
    || text.includes('err_connection_timed_out')
    || text.includes('err_timed_out')
    || text.includes('err_network_changed')
    || text.includes('timeout')
    || text.includes('timed out');
}

async function bootstrapPtkPage(page, scanOptions = {}) {
  const bootstrap = resolveBootstrap(scanOptions);
  if (!bootstrap) return null;
  if (!page || typeof page.goto !== 'function') {
    throw new PtkBridgeError('bootstrapUrl requires a page-like object with goto()', 'PTK_BOOTSTRAP_UNSUPPORTED', {
      bootstrapUrl: bootstrap.url
    });
  }
  for (let attempt = 0; attempt <= bootstrap.retries; attempt += 1) {
    try {
      await page.goto(bootstrap.url, bootstrap.options);
      return {
        url: bootstrap.url,
        waitUntil: bootstrap.options.waitUntil,
        timeout: bootstrap.options.timeout,
        attempts: attempt + 1
      };
    } catch (error) {
      if (attempt >= bootstrap.retries || !isRetriableBootstrapError(error)) throw error;
      if (bootstrap.retryDelayMs > 0) await sleep(bootstrap.retryDelayMs);
    }
  }
  return {
    url: bootstrap.url,
    waitUntil: bootstrap.options.waitUntil,
    timeout: bootstrap.options.timeout,
    attempts: bootstrap.retries + 1
  };
}

function reportCollectTarget(target) {
  if (target === false) return false;
  if (target === true) {
    return {
      findings: true,
      stats: true
    };
  }
  if (target && typeof target === 'object') {
    return {
      findings: true,
      stats: true,
      ...target
    };
  }
  return {
    findings: true,
    stats: true
  };
}

function collectOptionsForArtifactMode(collect = {}, mode = 'report') {
  if (mode === 'debug') {
    return {
      collect,
      defaultEnabled: true
    };
  }
  return {
    collect: {
      ...collect,
      beforeStop: reportCollectTarget(collect.beforeStop),
      afterStop: reportCollectTarget(collect.afterStop)
    },
    defaultEnabled: false
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function applyAutomationScanDefaults(scanOptions = {}) {
  const engines = normalizeEngines(scanOptions.engines);
  if (!engines.includes('DAST')) return scanOptions;

  const existingEngineConfigs = scanOptions.engineConfigs && typeof scanOptions.engineConfigs === 'object'
    ? scanOptions.engineConfigs
    : {};
  const existingDastConfig = existingEngineConfigs.DAST && typeof existingEngineConfigs.DAST === 'object'
    ? existingEngineConfigs.DAST
    : {};

  if (hasOwn(existingDastConfig, 'allowCaptureWithoutInteraction')) return scanOptions;

  return {
    ...scanOptions,
    engineConfigs: {
      ...existingEngineConfigs,
      DAST: {
        ...existingDastConfig,
        allowCaptureWithoutInteraction: true
      }
    }
  };
}

function normalizeError(error, fallbackCode) {
  return {
    message: error && error.message ? error.message : String(error),
    name: error && error.name ? error.name : 'Error',
    code: error && error.code ? error.code : fallbackCode
  };
}

function scanStartOptions(scanOptions = {}) {
  return {
    project: scanOptions.project,
    engines: scanOptions.engines,
    policyCode: scanOptions.policyCode,
    testRunId: scanOptions.testRunId,
    runCve: scanOptions.runCve,
    dastScanPolicy: scanOptions.dastScanPolicy,
    rulepack: scanOptions.rulepack,
    cveRulepack: scanOptions.cveRulepack,
    engineConfigs: scanOptions.engineConfigs,
    sessionScope: scanOptions.sessionScope
  };
}

async function readPageUrl(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const value = await page.evaluate(() => window.location && window.location.href || null);
    return typeof value === 'string' && value ? value : null;
  } catch (_) {
    return null;
  }
}

function makeScanNotStartedError() {
  const error = new PtkScanError(
    'PTK deferred scan was not started. Call startPtkScan() after navigating to a real application page.',
    null
  );
  error.code = 'PTK_SCAN_NOT_STARTED';
  return error;
}

async function withPtkScan(page, scanOptions = {}, runJourney) {
  if (typeof runJourney !== 'function') {
    throw new TypeError('withPtkScan requires a runJourney callback');
  }
  scanOptions = applyAutomationScanDefaults(scanOptions);
  const bridge = scanOptions.bridge || createPtkBridge(page, scanOptions.bridgeOptions || {});
  const deferred = scanOptions.deferStart === true;
  const result = {
    ok: false,
    deferred,
    lifecycleStatus: 'created',
    scanStarted: false,
    scanStartedAt: null,
    scanStartUrl: null,
    sessionStarted: false,
    sessionStopped: false,
    session: null,
    beforeStop: null,
    afterStop: null,
    stop: null,
    error: null,
    stopError: null,
    bootstrap: null,
    preNavigationArm: null,
    resultsDir: scanOptions.resultsDir || null
  };
  let journeyError = null;
  let startPromise = null;
  const preNavigationArmOperation = typeof scanOptions.preNavigationArmOperation === 'function'
    ? scanOptions.preNavigationArmOperation
    : (targetUrl, options = {}) => armPtkIastForNavigation(page, {
      ...options,
      targetUrl,
      scanOptions: options.scanOptions || scanOptions
    });
  const artifactMode = resolveArtifactMode({
    artifactMode: scanOptions.artifactMode,
    artifacts: scanOptions.artifacts
  });

  const startPtkScan = async (startOptions = {}) => {
    if (result.session) {
      return {
        session: result.session,
        ptk: bridge
      };
    }
    if (startPromise) return startPromise;
    startPromise = (async () => {
      result.lifecycleStatus = 'scan_starting';
      await bridge.waitReady(startOptions.wait || scanOptions.wait || {});
      const session = await bridge.startSession({
        ...scanStartOptions(scanOptions),
        ...(startOptions.session || startOptions.scan || startOptions.scanOptions || {})
      });
      result.session = session;
      result.scanStarted = true;
      result.sessionStarted = true;
      result.scanStartedAt = new Date().toISOString();
      result.scanStartUrl = await readPageUrl(page);
      result.lifecycleStatus = 'scan_started';
      return {
        session,
        ptk: bridge
      };
    })().catch((error) => {
      startPromise = null;
      result.lifecycleStatus = 'failed';
      throw error;
    });
    return startPromise;
  };

  try {
    result.lifecycleStatus = 'journey_started';
    if (!deferred) {
      const bootstrap = resolveBootstrap(scanOptions);
      if (bootstrap && scanOptions.preNavigationArm !== false) {
        result.preNavigationArm = await preNavigationArmOperation(bootstrap.url, {
          ...(scanOptions.preNavigationArm && typeof scanOptions.preNavigationArm === 'object'
            ? scanOptions.preNavigationArm
            : {}),
          scanOptions,
          timeoutMs: scanOptions.preNavigationArmTimeoutMs || bootstrap.options.timeout
        });
        if (result.preNavigationArm.applicable && result.preNavigationArm.ok === false) {
          const error = new PtkBridgeError(
            `PTK IAST pre-navigation arm failed: ${result.preNavigationArm.error || 'unknown_error'}`,
            'PTK_IAST_PRE_NAVIGATION_ARM_FAILED',
            result.preNavigationArm
          );
          throw error;
        }
      }
      result.bootstrap = await bootstrapPtkPage(page, scanOptions);
      await startPtkScan();
    }
    result.journeyResult = await runJourney({
      page,
      ptk: bridge,
      session: result.session,
      startPtkScan,
      armPtkIastForNavigation: preNavigationArmOperation
    });
    if (deferred && !result.session) {
      throw makeScanNotStartedError();
    }
    result.lifecycleStatus = 'journey_finished';
  } catch (error) {
    journeyError = error;
    if (journeyError instanceof PtkScanError && !journeyError.result) {
      journeyError.result = result;
    }
    result.error = normalizeError(error);
    result.lifecycleStatus = 'failed';
  } finally {
    if (result.session) {
      const collectBeforeStop = scanOptions.resultsDir || scanOptions.collect;
      if (collectBeforeStop) {
        const collection = collectOptionsForArtifactMode(scanOptions.collect || {}, artifactMode);
        result.beforeStop = await collectPtkResults(bridge, result.session, {
          collect: collection.collect,
          defaultEnabled: collection.defaultEnabled,
          findingsLimit: scanOptions.findingsLimit
        });
      }
      try {
        result.lifecycleStatus = journeyError ? 'stopping_after_failure' : 'stopping';
        result.stop = await bridge.endSession({
          ...(scanOptions.stop || {}),
          sessionId: result.session.sessionId,
          wait: Boolean(scanOptions.stop && scanOptions.stop.wait === true),
          immediateAnalysis: scanOptions.stop && scanOptions.stop.immediateAnalysis
        });
        result.sessionStopped = true;
        result.lifecycleStatus = journeyError ? 'stopped_after_failure' : 'stopped';
      } catch (error) {
        result.stopError = normalizeError(error);
        result.lifecycleStatus = 'failed';
      }
      const shouldCollectAfterStop = Boolean((scanOptions.stop && scanOptions.stop.wait === true) || (scanOptions.collect && scanOptions.collect.afterStop === true));
      if (shouldCollectAfterStop) {
        const collection = collectOptionsForArtifactMode(scanOptions.collect || {}, artifactMode);
        result.afterStop = await collectPtkResults(bridge, result.session, {
          collect: collection.collect,
          defaultEnabled: collection.defaultEnabled,
          phase: 'afterStop',
          findingsLimit: scanOptions.findingsLimit
        });
      }
    }

    result.ok = !journeyError && !result.stopError;
    if (scanOptions.resultsDir) {
      try {
        result.artifacts = writePtkResults(result, scanOptions.resultsDir, {
          mode: scanOptions.artifactMode,
          artifacts: scanOptions.artifacts,
          artifactMode,
          project: scanOptions.project,
          engines: scanOptions.engines
        });
      } catch (error) {
        result.artifactError = {
          message: error && error.message ? error.message : String(error),
          name: error && error.name ? error.name : 'Error'
        };
      }
    }
  }

  if (!result.ok && scanOptions.throwOnError !== false) {
    if (journeyError && result.stopError) {
      throw new PtkScanError('PTK scan journey and stop failed', result, journeyError);
    }
    if (journeyError) throw journeyError;
    throw new PtkScanError(result.stopError.message || 'PTK scan stop failed', result);
  }
  return result;
}

module.exports = {
  PTKBridge,
  PtkBridgeError,
  PtkScanError,
  REQUIRED_CAPABILITIES,
  VALID_ENGINES,
  collectPtkResults,
  countFindings,
  createPtkBridge,
  applyAutomationScanDefaults,
  armPtkIastForNavigation,
  bootstrapPtkPage,
  normalizeEngines,
  resolveArtifactMode,
  sleep,
  validateCapabilities,
  waitForPtk,
  withPtkScan,
  writePtkResults
};
