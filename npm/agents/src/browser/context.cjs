'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPattern(url, pattern) {
  const doubleStar = '__PTK_DOUBLE_STAR__';
  const source = escapeRegExp(String(pattern || '').replace(/\*\*/g, doubleStar))
    .replace(/\*/g, '[^?#]*')
    .replace(new RegExp(doubleStar, 'g'), '.*');
  return new RegExp(`^${source}$`).test(String(url || ''));
}

function normalizeScope(baseUrl, include = [], exclude = []) {
  const parsed = new URL(baseUrl);
  return {
    baseUrl: parsed.href,
    origin: parsed.origin,
    include: include.length ? include : [`${parsed.origin}/**`],
    exclude
  };
}

const EXTERNAL_REDIRECT_PARAM_NAMES = new Set([
  'continue',
  'dest',
  'destination',
  'next',
  'r',
  'redirect',
  'redirect_to',
  'redirect_uri',
  'redirect_url',
  'return',
  'return_to',
  'returnto',
  'target',
  'to',
  'url'
]);

const STATIC_DOCUMENT_EXTENSIONS = new Set([
  '.7z',
  '.atom',
  '.avi',
  '.bmp',
  '.br',
  '.bz2',
  '.css',
  '.csv',
  '.doc',
  '.docx',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.rar',
  '.rss',
  '.svg',
  '.tar',
  '.tgz',
  '.tsv',
  '.ttf',
  '.txt',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.xml',
  '.zip'
]);

function getExternalRedirectTarget(url, scope) {
  let parsed;
  let scopeOrigin;
  try {
    parsed = new URL(url, scope && scope.baseUrl ? scope.baseUrl : undefined);
    scopeOrigin = scope && scope.origin
      ? scope.origin
      : scope && scope.baseUrl
        ? new URL(scope.baseUrl).origin
        : parsed.origin;
  } catch (_) {
    return null;
  }

  for (const [name, value] of parsed.searchParams.entries()) {
    const normalizedName = String(name || '').toLowerCase();
    if (!EXTERNAL_REDIRECT_PARAM_NAMES.has(normalizedName)) continue;
    const rawTarget = String(value || '').trim();
    if (!rawTarget) continue;
    let target;
    try {
      if (/^\/\//.test(rawTarget)) target = new URL(`${parsed.protocol}${rawTarget}`);
      else if (/^https?:\/\//i.test(rawTarget)) target = new URL(rawTarget);
      else continue;
    } catch (_) {
      continue;
    }
    if (target.origin !== scopeOrigin) return target.href;
  }
  return null;
}

function scopeFromConfig(config = {}) {
  if (!config || !config.target || !config.target.baseUrl) return null;
  const scope = config.target.scope || {};
  return normalizeScope(config.target.baseUrl, scope.include || [], scope.exclude || []);
}

function automationGrantScope(scope = null, targetUrl = null) {
  let normalized = scope;
  if (!normalized && targetUrl) normalized = normalizeScope(targetUrl);
  if (!normalized) return null;
  const origin = normalized.origin || (normalized.baseUrl ? new URL(normalized.baseUrl).origin : null);
  const urls = Array.isArray(normalized.include) ? normalized.include.slice() : [];
  return {
    origins: urls.length === 0 && origin ? [origin] : [],
    urls,
    excludeUrls: Array.isArray(normalized.exclude) ? normalized.exclude.slice() : []
  };
}

function describeScopeFailure(url, scope) {
  const redirectTarget = getExternalRedirectTarget(url, scope);
  if (redirectTarget) return `external redirect target ${redirectTarget}`;
  return 'out-of-scope target';
}

function staticDocumentExtension(url, baseUrl = null) {
  let parsed;
  try {
    parsed = new URL(url, baseUrl || undefined);
  } catch (_) {
    return null;
  }
  const candidates = [parsed.pathname];
  const hash = String(parsed.hash || '');
  if (hash === '#/' || hash.startsWith('#/') || hash.startsWith('#!/')) {
    candidates.push(hash.replace(/^#!/, '').replace(/^#/, '').split(/[?#]/)[0]);
  }
  for (const candidate of candidates) {
    const lastSegment = String(candidate || '').split('/').filter(Boolean).pop() || '';
    const match = lastSegment.match(/(\.[a-z0-9]{1,12})$/i);
    if (match && STATIC_DOCUMENT_EXTENSIONS.has(match[1].toLowerCase())) return match[1].toLowerCase();
  }
  return null;
}

function isStaticDocumentUrl(url, baseUrl = null) {
  return Boolean(staticDocumentExtension(url, baseUrl));
}

function describeStaticDocumentUrl(url, baseUrl = null) {
  const extension = staticDocumentExtension(url, baseUrl);
  return extension ? `static document/asset extension ${extension}` : null;
}

function isInScope(url, scope) {
  let parsed;
  try {
    parsed = new URL(url, scope && scope.baseUrl ? scope.baseUrl : undefined);
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (scope && scope.origin && parsed.origin !== scope.origin) return false;
  if (getExternalRedirectTarget(parsed.href, scope)) return false;
  const text = parsed.href;
  for (const pattern of scope && scope.exclude || []) {
    if (matchesPattern(text, pattern)) return false;
  }
  const include = scope && scope.include || [];
  return include.length === 0 ? true : include.some(pattern => matchesPattern(text, pattern));
}

function resolveBrowserName(config = {}) {
  return (config.browser && config.browser.name) || 'chromium';
}

function resolvePlaywrightBrowserTypeName(browserName) {
  if (browserName === 'firefox') return 'firefox';
  return 'chromium';
}

function resolveBrowserChannel(browserName) {
  if (browserName === 'chrome') return 'chrome';
  if (browserName === 'edge') return 'msedge';
  return null;
}

function resolveLaunchOptions(config = {}, options = {}) {
  const browserConfig = config.browser || {};
  const ptkConfig = config.ptk || {};
  const extensionPath = ptkConfig.extensionPath || null;
  const browserName = options.browserName || resolveBrowserName(config);
  const launchOptions = {
    headless: options.headless !== undefined ? options.headless : browserConfig.headless !== false,
    timeout: Number(browserConfig.launchTimeoutMs || 30000),
    args: Array.isArray(browserConfig.args) ? browserConfig.args.slice() : []
  };
  if (browserConfig.executablePath) {
    launchOptions.executablePath = path.resolve(browserConfig.executablePath);
  } else {
    const channel = resolveBrowserChannel(browserName);
    if (channel) launchOptions.channel = channel;
  }
  if (extensionPath) {
    launchOptions.headless = false;
    launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
    launchOptions.args.push(
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--ignore-certificate-errors',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    );
  }
  return { ...launchOptions, ...(options.launchOptions || {}) };
}

function resolveContextOptions(config = {}, options = {}) {
  const browserConfig = config.browser || {};
  const contextConfig = browserConfig.context || {};
  return {
    baseURL: config.target && config.target.baseUrl,
    viewport: contextConfig.viewport || browserConfig.viewport || { width: 1280, height: 800 },
    ignoreHTTPSErrors: Boolean(contextConfig.ignoreHTTPSErrors),
    locale: contextConfig.locale,
    storageState: contextConfig.storageState,
    ...(options.contextOptions || {})
  };
}

function ensureExtensionPath(extensionPath) {
  if (!extensionPath) return null;
  const resolved = path.resolve(extensionPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Configured PTK extensionPath does not exist: ${resolved}`);
  }
  if (!fs.existsSync(path.join(resolved, 'manifest.json'))) {
    throw new Error(`Configured PTK extensionPath is not an unpacked extension directory: ${resolved}`);
  }
  return resolved;
}

function browserProfileMode(config = {}, options = {}) {
  const browserConfig = config.browser || {};
  if (browserConfig.profileDir || options.userDataDir) return 'configured-profile';
  if (config.ptk && config.ptk.extensionPath) return 'temporary-extension-profile';
  return 'ephemeral';
}

function createBrowserSummary(config = {}, session = {}, extras = {}) {
  const browserConfig = config.browser || {};
  const requestedBrowser = resolveBrowserName(config);
  const extensionPath = config.ptk && config.ptk.extensionPath || null;
  const browserSummary = {
    schemaVersion: 'ptk-agent-v2-browser-summary',
    requestedBrowser,
    actualBrowser: session.actualBrowser || requestedBrowser,
    browserType: session.browserTypeName || resolvePlaywrightBrowserTypeName(requestedBrowser),
    executablePath: browserConfig.executablePath || null,
    channel: session.channel || resolveBrowserChannel(requestedBrowser),
    headless: session.headless !== undefined ? Boolean(session.headless) : browserConfig.headless !== false,
    profileMode: session.profileMode || browserProfileMode(config),
    launchMode: session.launchMode || 'unsupported',
    extensionLoadMode: session.extensionLoadMode || (extensionPath ? 'unsupported' : 'none'),
    extensionPath,
    ptkBridgeDetected: Boolean(extras.ptkBridgeDetected),
    ptkBridgeReason: extras.ptkBridgeReason || null
  };
  return browserSummary;
}

function resolvePtkServiceWorkerPath(extensionPath) {
  if (!extensionPath) return null;
  try {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const serviceWorker = manifest && manifest.background && manifest.background.service_worker;
    if (!serviceWorker) return null;
    return `/${String(serviceWorker).replace(/^\/+/, '')}`;
  } catch (_) {
    return null;
  }
}

function normalizeWorkerWaitOptions(options = {}) {
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    return {
      timeoutMs: options.timeoutMs || 10000,
      extensionPath: options.extensionPath || null
    };
  }
  return {
    timeoutMs: options || 10000,
    extensionPath: null
  };
}

async function waitForPtkServiceWorker(context, options = 10000) {
  const { timeoutMs, extensionPath } = normalizeWorkerWaitOptions(options);
  const expectedPath = resolvePtkServiceWorkerPath(extensionPath);
  const isPtkWorker = worker => {
    try {
      const workerUrl = new URL(typeof worker.url === 'function' ? worker.url() : '');
      if (workerUrl.protocol !== 'chrome-extension:') return false;
      if (expectedPath) return workerUrl.pathname === expectedPath;
      return workerUrl.pathname === '/app.js' || workerUrl.pathname === '/app_automation.js';
    } catch (_) {
      return false;
    }
  };
  const existing = typeof context.serviceWorkers === 'function'
    ? context.serviceWorkers().find(isPtkWorker)
    : null;
  if (existing) return existing;
  if (!context || typeof context.waitForEvent !== 'function') return null;
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10000);
  while (Date.now() < deadline) {
    const remaining = Math.max(250, deadline - Date.now());
    const worker = await context.waitForEvent('serviceworker', { timeout: remaining }).catch(() => null);
    if (worker && isPtkWorker(worker)) return worker;
    const found = typeof context.serviceWorkers === 'function'
      ? context.serviceWorkers().find(isPtkWorker)
      : null;
    if (found) return found;
  }
  return null;
}

async function enablePtkAutomationInExtension(context, options = {}) {
  const worker = await waitForPtkServiceWorker(context, {
    extensionPath: options.extensionPath || null,
    timeoutMs: options.timeoutMs || 10000
  });
  if (!worker) {
    return {
      ok: false,
      code: 'ptk_service_worker_missing',
      message: 'PTK extension service worker was not found'
    };
  }
  const targetUrl = options.targetUrl ? String(options.targetUrl) : null;
  const targetScope = automationGrantScope(options.targetScope || null, targetUrl);
  const result = await worker.evaluate(async ({ targetUrl: expectedTargetUrl, targetScope: expectedTargetScope, ttlMs }) => {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const candidate = [
      globalThis.PTK_EXTENSION_AUTOMATION,
      globalThis.PTK_EXTENSION_FULL,
      globalThis.PTK_EXTENSION_FULL_DEV
    ].find(owner => typeof owner?.extension?.contentRuntime?.armPrimaryTab === 'function') || null;
    const contentRuntime = candidate && candidate.extension && candidate.extension.contentRuntime || null;
    if (contentRuntime && typeof contentRuntime.armPrimaryTab === 'function') {
      if (!expectedTargetUrl) {
        return {
          ok: false,
          code: 'ptk_target_tab_required',
          message: 'PTK Labs automation requires an explicit target tab before activation',
          implementation: 'ptklabs'
        };
      }
      let normalizedTargetUrl;
      try {
        normalizedTargetUrl = new URL(expectedTargetUrl).href;
      } catch (_) {
        return {
          ok: false,
          code: 'ptk_target_url_invalid',
          message: 'PTK Labs automation target URL is invalid',
          implementation: 'ptklabs'
        };
      }
      if (!['http:', 'https:'].includes(new URL(normalizedTargetUrl).protocol)) {
        return {
          ok: false,
          code: 'ptk_target_url_unsupported',
          message: 'PTK Labs automation target must use HTTP or HTTPS',
          implementation: 'ptklabs'
        };
      }
      const sameUrl = tab => {
        try {
          return new URL(tab && tab.url || '').href === normalizedTargetUrl;
        } catch (_) {
          return false;
        }
      };
      const activeTabs = api.tabs && typeof api.tabs.query === 'function'
        ? await api.tabs.query({ active: true, currentWindow: true })
        : [];
      let matches = (Array.isArray(activeTabs) ? activeTabs : []).filter(sameUrl);
      if (matches.length !== 1 && api.tabs && typeof api.tabs.query === 'function') {
        const allTabs = await api.tabs.query({});
        matches = (Array.isArray(allTabs) ? allTabs : []).filter(sameUrl);
      }
      if (matches.length !== 1) {
        return {
          ok: false,
          code: matches.length > 1 ? 'ptk_target_tab_ambiguous' : 'ptk_target_tab_not_found',
          message: matches.length > 1
            ? 'More than one browser tab matches the PTK automation target URL'
            : 'No browser tab matches the PTK automation target URL',
          implementation: 'ptklabs',
          matchCount: matches.length
        };
      }
      const tab = matches[0];
      let resolvedGrant;
      try {
        const grant = contentRuntime.armPrimaryTab({
          caller: {
            trusted: true,
            source: 'ptk-agent-service-worker'
          },
          tab,
          tabId: tab.id,
          url: tab.url || normalizedTargetUrl,
          targetScope: expectedTargetScope,
          ttlMs
        });
        resolvedGrant = grant && typeof grant.then === 'function' ? await grant : grant;
      } catch (error) {
        return {
          ok: false,
          code: error && error.code || 'ptk_target_arm_failed',
          message: error && error.message || 'PTK Labs automation target grant was not created',
          implementation: 'ptklabs'
        };
      }
      if (!resolvedGrant || resolvedGrant.ok === false) {
        return {
          ok: false,
          code: resolvedGrant && (resolvedGrant.code || resolvedGrant.error) || 'ptk_target_arm_failed',
          message: resolvedGrant && resolvedGrant.message || 'PTK Labs automation target grant was not created',
          implementation: 'ptklabs'
        };
      }
      return {
        ok: true,
        implementation: 'ptklabs',
        armed: true,
        tabId: tab.id,
        targetUrl: tab.url || normalizedTargetUrl,
        grantId: resolvedGrant.grantId || null,
        expiresAt: resolvedGrant.expiresAt || null,
        extensionUrl: api.runtime.getURL('manifest.json')
      };
    }
    const app = globalThis.ptk_app || null;
    if (app && app.ready && typeof app.ready.then === 'function') {
      await app.ready.catch(() => null);
    }
    const current = await api.storage.local.get('pentestkit8_settings');
    const settings = current && current.pentestkit8_settings || {};
    const storageEnabled = settings && settings.automation && settings.automation.enable === true;
    const memoryEnabled = app && app.settings && app.settings.automation && app.settings.automation.enable === true;
    return {
      ok: Boolean(memoryEnabled || storageEnabled),
      memoryEnabled: Boolean(memoryEnabled),
      storageEnabled: Boolean(storageEnabled),
      extensionUrl: api.runtime.getURL('manifest.json')
    };
  }, {
    targetUrl,
    targetScope,
    ttlMs: Math.max(1, Math.min(Number(options.ttlMs || 60000), 60000))
  });
  return {
    ...result,
    workerUrl: typeof worker.url === 'function' ? worker.url() : null
  };
}

async function createBrowserContext(playwright, config = {}, options = {}) {
  const browserName = options.browserName || resolveBrowserName(config);
  const browserTypeName = resolvePlaywrightBrowserTypeName(browserName);
  if (browserName === 'firefox') {
    throw new Error('Firefox browser support is not implemented by this CLI runtime yet.');
  }
  const browserType = playwright && playwright[browserTypeName];
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new Error(`Playwright browser type is unavailable: ${browserTypeName}`);
  }
  if (config.browser && config.browser.firefoxXpi) {
    throw new Error('Firefox XPI loading is not implemented by this CLI runtime yet.');
  }
  const extensionPath = ensureExtensionPath(config.ptk && config.ptk.extensionPath);
  const launchOptions = resolveLaunchOptions(config, options);
  const contextOptions = resolveContextOptions(config, options);
  const browserConfig = config.browser || {};
  const profileMode = browserProfileMode(config, options);

  if ((extensionPath || browserConfig.profileDir) && browserTypeName === 'chromium' && typeof browserType.launchPersistentContext === 'function') {
    const userDataDir = options.userDataDir || browserConfig.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agents-v2-'));
    const context = await browserType.launchPersistentContext(userDataDir, {
      ...launchOptions,
      ...contextOptions
    });
    const extensionAutomation = await enablePtkAutomationInExtension(context, {
      extensionPath,
      timeoutMs: options.extensionAutomationTimeoutMs || 10000
    }).catch(error => ({ ok: false, code: 'ptk_automation_enable_failed', message: error.message }));
    return {
      browser: null,
      context,
      requestedBrowser: browserName,
      actualBrowser: browserName,
      browserTypeName,
      channel: launchOptions.channel || null,
      headless: launchOptions.headless,
      launchMode: extensionPath ? 'extension-loaded-persistent-context' : 'persistent-chromium-context',
      extensionMode: extensionPath ? 'persistent-context' : 'none',
      extensionLoadMode: extensionPath ? 'unpacked-chromium-persistent-context' : 'none',
      extensionPath,
      extensionAutomation,
      profileMode,
      userDataDir,
      browserSummary: createBrowserSummary(config, {
        actualBrowser: browserName,
        browserTypeName,
        channel: launchOptions.channel || null,
        headless: launchOptions.headless,
        launchMode: extensionPath ? 'extension-loaded-persistent-context' : 'persistent-chromium-context',
        extensionLoadMode: extensionPath ? 'unpacked-chromium-persistent-context' : 'none',
        profileMode
      })
    };
  }

  const browser = await browserType.launch(launchOptions);
  const context = await browser.newContext(contextOptions);
  return {
    browser,
    context,
    requestedBrowser: browserName,
    actualBrowser: browserName,
    browserTypeName,
    channel: launchOptions.channel || null,
    headless: launchOptions.headless,
    launchMode: browserTypeName === 'chromium' ? 'normal-chromium-context' : 'unsupported',
    extensionMode: extensionPath ? 'not-attached-non-persistent-context' : 'none',
    extensionLoadMode: extensionPath ? 'unsupported-non-persistent-context' : 'none',
    extensionPath,
    extensionAutomation: null,
    profileMode,
    userDataDir: null,
    browserSummary: createBrowserSummary(config, {
      actualBrowser: browserName,
      browserTypeName,
      channel: launchOptions.channel || null,
      headless: launchOptions.headless,
      launchMode: browserTypeName === 'chromium' ? 'normal-chromium-context' : 'unsupported',
      extensionLoadMode: extensionPath ? 'unsupported-non-persistent-context' : 'none',
      profileMode
    })
  };
}

async function closeBrowserSession(session) {
  if (!session) return;
  if (session.context && typeof session.context.close === 'function') await session.context.close().catch(() => {});
  if (session.browser && typeof session.browser.close === 'function') await session.browser.close().catch(() => {});
}

module.exports = {
  normalizeScope,
  automationGrantScope,
  isInScope,
  getExternalRedirectTarget,
  isStaticDocumentUrl,
  describeStaticDocumentUrl,
  scopeFromConfig,
  describeScopeFailure,
  matchesPattern,
  browserProfileMode,
  createBrowserSummary,
  resolveBrowserName,
  resolveBrowserChannel,
  resolvePlaywrightBrowserTypeName,
  resolveLaunchOptions,
  resolveContextOptions,
  ensureExtensionPath,
  resolvePtkServiceWorkerPath,
  enablePtkAutomationInExtension,
  createBrowserContext,
  closeBrowserSession,
  waitForPtkServiceWorker
};
