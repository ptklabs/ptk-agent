'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PTK_AUTOMATION_CONTROL_PATH = '/ptk/automation/control.html';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasIastEngine(scanOptions = {}) {
  const engines = Array.isArray(scanOptions.engines)
    ? scanOptions.engines
    : String(scanOptions.engines || '').split(',');
  return engines.some((value) => String(value || '').trim().toUpperCase() === 'IAST');
}

function workerOrigin(worker) {
  try {
    const raw = typeof worker?.url === 'function' ? worker.url() : worker?.url;
    const parsed = new URL(String(raw || ''));
    if (parsed.protocol !== 'chrome-extension:') return null;
    if (parsed.pathname !== '/app.js' && parsed.pathname !== '/app_automation.js') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return null;
  }
}

function extensionOriginFromPage(page) {
  try {
    const context = typeof page?.context === 'function' ? page.context() : null;
    const workers = context && typeof context.serviceWorkers === 'function'
      ? context.serviceWorkers()
      : [];
    for (const worker of workers || []) {
      const origin = workerOrigin(worker);
      if (origin) return origin;
    }
  } catch (_) {
    // Try Puppeteer targets below.
  }
  try {
    const browser = typeof page?.browser === 'function' ? page.browser() : null;
    const targets = browser && typeof browser.targets === 'function' ? browser.targets() : [];
    for (const target of targets || []) {
      const origin = workerOrigin({ url: () => target.url() });
      if (origin) return origin;
    }
  } catch (_) {
    // No browser-owned extension target is available.
  }
  return null;
}

function chromiumUnpackedExtensionOrigin(extensionPath) {
  if (!extensionPath) return null;
  let normalized;
  try {
    normalized = fs.realpathSync(path.resolve(String(extensionPath)));
    if (!fs.statSync(normalized).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  const digest = crypto.createHash('sha256').update(normalized).digest().subarray(0, 16);
  let extensionId = '';
  for (const byte of digest) {
    extensionId += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  }
  return `chrome-extension://${extensionId}`;
}

async function resolvePtkExtensionOrigin(page, options = {}) {
  if (options.extensionOrigin) {
    try {
      const parsed = new URL(String(options.extensionOrigin));
      if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch (_) {
      return null;
    }
  }
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 10000));
  const deadline = Date.now() + timeoutMs;
  do {
    const origin = extensionOriginFromPage(page);
    if (origin) return origin;
    if (Date.now() >= deadline) break;
    await sleep(100);
  } while (true);
  return null;
}

async function armPtkIastForNavigation(page, options = {}) {
  const scanOptions = options.scanOptions && typeof options.scanOptions === 'object'
    ? options.scanOptions
    : options;
  if (!hasIastEngine(scanOptions)) {
    return { ok: true, applicable: false, reason: 'iast_not_requested' };
  }
  const targetUrl = options.targetUrl
    || scanOptions.bootstrapUrl
    || scanOptions.bootstrap?.url
    || null;
  let parsedTarget;
  try {
    parsedTarget = new URL(String(targetUrl || ''));
  } catch (_) {
    return { ok: false, applicable: true, error: 'ptk_target_url_invalid' };
  }
  if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
    return { ok: false, applicable: true, error: 'ptk_target_url_unsupported' };
  }
  if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
    return { ok: false, applicable: false, error: 'ptk_pre_navigation_page_unsupported' };
  }

  let extensionOrigin = await resolvePtkExtensionOrigin(page, options);
  const usedUnpackedFallback = !extensionOrigin;
  if (!extensionOrigin) {
    extensionOrigin = chromiumUnpackedExtensionOrigin(options.extensionPath);
  }
  if (!extensionOrigin) {
    return { ok: false, applicable: false, error: 'ptk_extension_origin_not_found' };
  }
  let controlUrl = `${extensionOrigin}${PTK_AUTOMATION_CONTROL_PATH}`;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
  try {
    if (usedUnpackedFallback) {
      // Initialize Chrome for Testing's lazily registered command-line
      // extension before requesting its deterministic private URL.
      await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      extensionOrigin = await resolvePtkExtensionOrigin(page, { ...options, timeoutMs }) || extensionOrigin;
      controlUrl = `${extensionOrigin}${PTK_AUTOMATION_CONTROL_PATH}`;
    }
    await page.goto(controlUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const result = await page.evaluate(async (request) => {
      const control = globalThis.PTK_AUTOMATION_CONTROL;
      if (!control || typeof control.armIastForNavigation !== 'function') {
        return { ok: false, error: 'ptk_automation_control_unavailable' };
      }
      return control.armIastForNavigation(request);
    }, {
      targetUrl: parsedTarget.href,
      scanOptions,
      ttlMs: Math.max(1000, Math.min(Number(options.ttlMs || 60000), 60000))
    });
    return {
      ...(result && typeof result === 'object' ? result : { ok: false, error: 'ptk_pre_navigation_invalid_response' }),
      applicable: true,
      controlUrl
    };
  } catch (error) {
    return {
      ok: false,
      applicable: true,
      error: 'ptk_iast_pre_navigation_arm_failed',
      message: error?.message || String(error),
      controlUrl
    };
  }
}

module.exports = {
  PTK_AUTOMATION_CONTROL_PATH,
  armPtkIastForNavigation,
  chromiumUnpackedExtensionOrigin,
  extensionOriginFromPage,
  hasIastEngine,
  resolvePtkExtensionOrigin
};
