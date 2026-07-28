'use strict';

const {
  createBrowserContext,
  closeBrowserSession,
  createBrowserSummary,
  enablePtkAutomationInExtension,
  scopeFromConfig
} = require('./context.cjs');
const { waitForPtkBridge, startPtkScan, stopPtkScan } = require('./ptkBridge.cjs');
const { armPtkIastForNavigation } = require('../../../browser/src/preNavigation.cjs');

function lazyRequirePlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      return require('@playwright/test');
    } catch (err) {
      const missing = new Error('Playwright is required for browser launch. Install playwright or run --dry-run.');
      missing.code = 'PLAYWRIGHT_MISSING';
      throw missing;
    }
  }
}

function loadChromium() {
  const playwright = lazyRequirePlaywright();
  if (!playwright.chromium) {
    const missing = new Error('Playwright chromium browser type is unavailable.');
    missing.code = 'PLAYWRIGHT_CHROMIUM_MISSING';
    throw missing;
  }
  return playwright.chromium;
}

function resolveTargetUrl(config = {}, options = {}) {
  return options.url || config.url || config.target && config.target.baseUrl || null;
}

function resolveRouteTimeout(config = {}, options = {}) {
  const value = options.maxRouteMs || config.crawler && config.crawler.maxRouteMs || config.maxRouteMs || 30000;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
}

function scanOptionsFromAgentConfig(config = {}) {
  const engines = Object.entries(config.engines || {})
    .filter(([, value]) => value && value.enabled === true)
    .map(([name]) => String(name).toUpperCase());
  return {
    engines,
    policyCode: config.ptk && config.ptk.policyCode || null,
    engineConfigs: config.ptk && config.ptk.engineConfigs || {}
  };
}

async function launchBrowser(options = {}) {
  if (options.playwright || options.config) {
    const playwright = options.playwright || lazyRequirePlaywright();
    const session = await createBrowserContext(playwright, options.config || {}, options);
    const page = options.page || await session.context.newPage();
    return { ...session, page, close: async () => closeBrowserSession(session) };
  }
  const chromium = loadChromium();
  return chromium.launch({ headless: options.headless !== false });
}

async function openTarget(config = {}, options = {}) {
  const targetUrl = resolveTargetUrl(config, options);
  if (!targetUrl) throw new Error('Browser launcher requires target.baseUrl or options.url.');
  const timeout = resolveRouteTimeout(config, options);
  const startedAt = Date.now();
  const session = options.session || await launchBrowser({ ...options, config });
  const page = session.page;
  let bridgeStatus = null;
  let scanStartStatus = null;
  try {
    if (!page || typeof page.goto !== 'function') throw new Error('Browser launcher requires a Playwright-like page with goto().');
    const preNavigationScanOptions = options.scanOptions || scanOptionsFromAgentConfig(config);
    const preNavigationArm = await armPtkIastForNavigation(page, {
      targetUrl,
      scanOptions: preNavigationScanOptions,
      extensionPath: session.extensionPath,
      timeoutMs: Math.min(Math.max(timeout, 1000), 10000)
    });
    session.preNavigationArm = preNavigationArm;
    if (
      session.extensionPath
      && preNavigationScanOptions.engines.includes('IAST')
      && preNavigationArm.ok === false
    ) {
      throw new Error(`PTK IAST pre-navigation arm failed: ${preNavigationArm.error || 'unknown_error'}`);
    }
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });
    bridgeStatus = await waitForPtkBridge(page, { ...(config.ptk || {}), timeoutMs: Math.min(timeout, 1000) });
    if (!bridgeStatus.available && session.extensionPath && session.context) {
      if (typeof page.bringToFront === 'function') await page.bringToFront().catch(() => null);
      const authoritativeTargetUrl = typeof page.url === 'function' ? page.url() : targetUrl;
      const extensionAutomation = await enablePtkAutomationInExtension(session.context, {
        extensionPath: session.extensionPath,
        timeoutMs: Math.min(Math.max(timeout, 1000), 10000),
        targetUrl: authoritativeTargetUrl,
        targetScope: scopeFromConfig(config),
        ttlMs: 60000
      }).catch(error => ({ ok: false, code: 'ptk_automation_enable_failed', message: error.message }));
      session.extensionAutomation = extensionAutomation;
      if (extensionAutomation && extensionAutomation.ok && typeof page.reload === 'function') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout }).catch(() => null);
      }
      bridgeStatus = await waitForPtkBridge(page, { ...(config.ptk || {}), timeoutMs: Math.min(timeout, 1000) });
    }
    if (bridgeStatus && typeof bridgeStatus === 'object') {
      bridgeStatus.extensionMode = session.extensionMode || null;
      bridgeStatus.extensionAutomation = session.extensionAutomation || null;
      bridgeStatus.preNavigationArm = session.preNavigationArm || null;
    }
    session.browserSummary = {
      ...(session.browserSummary || createBrowserSummary(config, session)),
      ptkBridgeDetected: Boolean(bridgeStatus && bridgeStatus.available),
      ptkBridgeReason: bridgeStatus && (bridgeStatus.reason || bridgeStatus.code || bridgeStatus.error) || null
    };
    if (options.startPtkScan === true) {
      scanStartStatus = await startPtkScan(page, { timeoutMs: Math.min(timeout, 1000), scanOptions: options.scanOptions || {} });
    }
    return {
      ok: true,
      requestedUrl: targetUrl,
      url: typeof page.url === 'function' ? page.url() : targetUrl,
      title: typeof page.title === 'function' ? await page.title().catch(() => '') : '',
      status: response && typeof response.status === 'function' ? response.status() : null,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        budgetMs: timeout
      },
      bridgeStatus,
      scanStartStatus,
      browserSummary: session.browserSummary,
      session
    };
  } catch (err) {
    if (session) {
      session.browserSummary = {
        ...(session.browserSummary || createBrowserSummary(config, session)),
        ptkBridgeDetected: false,
        ptkBridgeReason: err.message
      };
    }
    return {
      ok: false,
      requestedUrl: targetUrl,
      error: err.message,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        budgetMs: timeout
      },
      bridgeStatus,
      scanStartStatus,
      browserSummary: session && session.browserSummary || createBrowserSummary(config, {}, { ptkBridgeReason: err.message }),
      session
    };
  } finally {
    if (options.startPtkScan === true && options.stopPtkScanOnFinish !== false && page) {
      await stopPtkScan(page, { timeoutMs: Math.min(timeout, 1000) }).catch(() => null);
    }
    if (!options.keepOpen && !options.session && session && typeof session.close === 'function') {
      await session.close();
    }
  }
}

async function openBrowserTarget({ config, telemetry, logger } = {}) {
  const opened = await openTarget(config, { keepOpen: true });
  if (!opened.ok) throw new Error(opened.error);
  if (telemetry) telemetry.addTiming('navigationMs', opened.timing.durationMs);
  if (logger) logger.debug('Opened browser target', opened.url);
  return {
    browser: opened.session.browser,
    context: opened.session.context,
    page: opened.session.page,
    url: opened.url,
    title: opened.title,
    ptkBridge: opened.bridgeStatus,
    browserSummary: opened.browserSummary,
    async close() {
      await opened.session.close();
    }
  };
}

module.exports = {
  lazyRequirePlaywright,
  loadChromium,
  resolveTargetUrl,
  resolveRouteTimeout,
  launchBrowser,
  openTarget,
  openBrowserTarget
};
