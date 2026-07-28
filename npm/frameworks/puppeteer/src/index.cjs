'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const browserCore = require('../../../browser/src/index.cjs');

const REQUIRED_CAPABILITIES = [
  'startSession',
  'endSession',
  'getStats',
  'getFindings'
];

const VALID_ENGINES = new Set(['DAST', 'IAST', 'SAST', 'SCA']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeEngines(value, fallback = ['DAST']) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const engine = String(item || '').trim().toUpperCase();
    if (!VALID_ENGINES.has(engine) || seen.has(engine)) continue;
    seen.add(engine);
    out.push(engine);
  }
  return out.length ? out : fallback.slice();
}

function resolveOptionalModule(name) {
  try {
    return require(name);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

function resolvePuppeteer(options = {}) {
  if (options.puppeteer) return options.puppeteer;
  const candidates = [
    options.puppeteerPackage,
    env('PTK_PUPPETEER_PACKAGE'),
    'puppeteer',
    'puppeteer-core'
  ].filter(Boolean);
  const tried = [];
  for (const name of candidates) {
    if (tried.includes(name)) continue;
    tried.push(name);
    const mod = resolveOptionalModule(name);
    if (mod) return mod;
  }
  throw new Error(
    'Puppeteer is not installed. Install puppeteer or puppeteer-core in the project that runs pentestkit/puppeteer.'
  );
}

function resolveExtensionPath(options = {}) {
  const explicit = options.extensionPath || env('PTK_EXTENSION_PATH') || env('PTK_EXTENSION_DIR');
  if (explicit) return path.resolve(expandHome(explicit));

  const packageCandidate = path.resolve(__dirname, '..', '..', 'extensions', 'chromium-unpacked');
  if (fs.existsSync(packageCandidate)) return packageCandidate;

  const packageRoot = path.resolve(__dirname, '..', '..');
  const helperPath = path.join(packageRoot, 'extensions', 'index.cjs');
  if (fs.existsSync(helperPath)) {
    try {
      const helpers = require(helperPath);
      const result = helpers.ensureUnpackedPtkExtension({
        packageRoot,
        cacheRoot: env('PTK_EXTENSION_CACHE_DIR') || env('PTK_AUTOMATION_CACHE_DIR') || path.join(process.cwd(), '.ptk')
      });
      if (result && result.path && fs.existsSync(result.path)) return result.path;
    } catch (_) {
      // Fall through to local source detection.
    }
  }

  const sourceCandidate = path.resolve(__dirname, '..', '..', '..', 'src');
  if (fs.existsSync(sourceCandidate)) return sourceCandidate;

  return null;
}

function buildLaunchArgs(extensionPath, extraArgs = []) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--enable-unsafe-extension-debugging',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions-file-access-check',
    '--disable-popup-blocking',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`
  ];
  return args.concat(Array.isArray(extraArgs) ? extraArgs : []);
}

function resolveExecutablePath(options = {}) {
  return options.executablePath
    || env('PTK_PUPPETEER_EXECUTABLE_PATH')
    || env('PTK_EXECUTABLE_PATH')
    || env('PTK_CHROME_BINARY')
    || env('PTK_CYPRESS_BROWSER_PATH')
    || null;
}

async function launchPtkBrowser(options = {}) {
  const puppeteer = resolvePuppeteer(options);
  const extensionPath = resolveExtensionPath(options);
  if (!extensionPath || !fs.existsSync(extensionPath)) {
    throw new Error(`PTK unpacked extension directory not found: ${extensionPath || '(not configured)'}`);
  }

  const profileDir = path.resolve(
    expandHome(options.profileDir || env('PTK_PROFILE_DIR') || fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-puppeteer-')))
  );
  fs.mkdirSync(profileDir, { recursive: true });

  const launchOptionsInput = options.launchOptions || {};
  const headless = toBoolean(
    options.headless,
    toBoolean(env('PTK_HEADLESS'), false)
  );
  if (headless && options.allowHeadlessExtension !== true) {
    throw new Error('PTK Puppeteer extension runs are headed by default; pass allowHeadlessExtension for experimental headless launches.');
  }

  const viewport = options.defaultViewport || {
    width: Number(options.viewportWidth || env('PTK_VIEWPORT_WIDTH') || 1280),
    height: Number(options.viewportHeight || env('PTK_VIEWPORT_HEIGHT') || 720)
  };
  const launchOptions = {
    ...launchOptionsInput,
    headless,
    userDataDir: profileDir,
    defaultViewport: viewport,
    args: buildLaunchArgs(extensionPath, launchOptionsInput.args || options.args)
  };
  const executablePath = resolveExecutablePath(options);
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await puppeteer.launch(launchOptions);
  const page = options.page || await browser.newPage();
  return {
    browser,
    page,
    ptk: new PTKPuppeteerBridge(page),
    extensionPath,
    profileDir,
    launchOptions
  };
}

class PTKPuppeteerBridge {
  constructor(page) {
    this.page = page;
    this.bridgeInfo = null;
    this.sessionId = null;
  }

  async ping() {
    return this.page.evaluate(async () => {
      const bridge = window.PTK_AUTOMATION;
      if (!bridge) return { ok: false, error: 'bridge_not_found' };
      if (typeof bridge.ping === 'function') return bridge.ping();
      const capabilities = ['startSession', 'endSession', 'getStats', 'getFindings']
        .filter((name) => typeof bridge[name] === 'function');
      return {
        ok: capabilities.length >= 4,
        version: bridge.version || 'unknown',
        capabilities,
        automationEnabled: true
      };
    });
  }

  async requestActivation(options = {}) {
    return this.page.evaluate(async (activationOptions) => {
      const bridge = window.PTK_AUTOMATION;
      if (!bridge || typeof bridge.requestActivation !== 'function') {
        return { ok: false, allowed: false, error: 'request_activation_unavailable' };
      }
      try {
        return await bridge.requestActivation(activationOptions || {});
      } catch (error) {
        return { ok: false, allowed: false, error: error.message || String(error) };
      }
    }, options);
  }

  async waitReady(timeoutMs = 30000, options = {}) {
    const activate = options.activate === true;
    const pollMs = Number(options.pollMs || 500);
    const deadline = Date.now() + Number(timeoutMs || 30000);
    let last = null;

    while (Date.now() < deadline) {
      last = await this.ping();
      if (last && last.ok) {
        validateCapabilities(last);
        this.bridgeInfo = last;
        return last;
      }
      if (activate && last && last.error === 'automation_disabled') {
        await this.requestActivation({ reason: 'puppeteer_sdk_wait_ready' });
        last = await this.ping();
        if (last && last.ok) {
          validateCapabilities(last);
          this.bridgeInfo = last;
          return last;
        }
      }
      await sleep(pollMs);
    }

    throw new Error(
      `PTK bridge not ready after ${Math.round(Number(timeoutMs || 30000) / 1000)}s: ${JSON.stringify(last)}`
    );
  }

  async _call(method, options = {}) {
    return this.page.evaluate(async ({ method: bridgeMethod, options: bridgeOptions }) => {
      const bridge = window.PTK_AUTOMATION;
      if (!bridge || typeof bridge[bridgeMethod] !== 'function') {
        return { ok: false, error: `bridge_method_unavailable:${bridgeMethod}` };
      }
      try {
        const result = await bridge[bridgeMethod](bridgeOptions);
        if (result && typeof result === 'object') return result;
        return { ok: true, value: result };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }, { method, options });
  }

  async startSession(options = {}) {
    const result = await this._call('startSession', {
      project: options.project || env('PTK_PROJECT') || undefined,
      engines: normalizeEngines(options.engines || env('PTK_ENGINES') || 'DAST'),
      policyCode: options.policyCode || env('PTK_POLICY_CODE') || undefined,
      testRunId: options.testRunId,
      runCve: options.runCve === true,
      dastScanPolicy: options.dastScanPolicy,
      rulepack: options.rulepack,
      cveRulepack: options.cveRulepack,
      engineConfigs: options.engineConfigs,
      sessionScope: options.sessionScope
    });
    if (result.ok === false || result.status === 'error') {
      throw new Error(`PTK startSession failed: ${result.error || JSON.stringify(result)}`);
    }
    this.sessionId = result.sessionId || `ptk-started-${Date.now()}`;
    return { ok: true, ...result, sessionId: this.sessionId };
  }

  async endSession(options = {}) {
    const result = await this._call('endSession', {
      sessionId: options.sessionId || this.sessionId || undefined,
      sessionScope: options.sessionScope,
      wait: options.wait !== false,
      includeFindings: options.includeFindings === true,
      limit: options.limit,
      stopTimeoutMs: options.stopTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      immediateAnalysis: options.immediateAnalysis
    });
    if (result.ok === false) {
      throw new Error(`PTK endSession failed: ${result.error || JSON.stringify(result)}`);
    }
    if (options.wait !== false) this.sessionId = null;
    return { ok: true, ...result };
  }

  async getStats() {
    return this._call('getStats');
  }

  async getFindings(options = 100) {
    return this._call('getFindings', typeof options === 'number' ? { limit: options } : options);
  }

  async getSessionProgress(options = {}) {
    return this._call('getSessionProgress', {
      sessionId: options.sessionId || this.sessionId || undefined,
      sessionScope: options.sessionScope
    });
  }

  async exportScan(options = {}) {
    return this._call('exportScan', {
      sessionId: options.sessionId || this.sessionId || undefined,
      sessionScope: options.sessionScope,
      limit: options.limit,
      includeSecrets: options.includeSecrets,
      exportMode: options.exportMode,
      sensitive: options.sensitive
    });
  }
}

function validateCapabilities(info) {
  if (info.automationEnabled === false) {
    throw new Error('PTK automation is disabled. Use a PTK automation artifact, enable Automation Mode in PTK, or explicitly pass activate: true for a trusted page.');
  }
  const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
  const missing = REQUIRED_CAPABILITIES.filter((name) => !capabilities.includes(name));
  if (missing.length) {
    throw new Error(`PTK bridge missing capabilities: ${missing.join(', ')}`);
  }
}

module.exports = {
  PTKPuppeteerBridge,
  REQUIRED_CAPABILITIES,
  buildLaunchArgs,
  collectPtkResults: browserCore.collectPtkResults,
  countFindings: browserCore.countFindings,
  applyAutomationScanDefaults: browserCore.applyAutomationScanDefaults,
  armPtkIastForNavigation: browserCore.armPtkIastForNavigation,
  createPtkBridge: browserCore.createPtkBridge,
  launchPtkBrowser,
  normalizeEngines,
  resolveArtifactMode: browserCore.resolveArtifactMode,
  resolveExtensionPath,
  resolvePuppeteer,
  validateCapabilities,
  waitForPtk: browserCore.waitForPtk,
  withPtkScan: browserCore.withPtkScan,
  writePtkResults: browserCore.writePtkResults
};
