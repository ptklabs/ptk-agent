'use strict';

const REQUIRED_CAPABILITIES = [
  'startSession',
  'endSession',
  'getStats',
  'getFindings'
];

const VALID_ENGINES = new Set(['DAST', 'IAST', 'SAST', 'SCA']);

class PtkBridgeError extends Error {
  constructor(message, code, details = null, cause = null) {
    super(message);
    this.name = 'PtkBridgeError';
    this.code = code || 'PTK_BRIDGE_ERROR';
    this.details = details;
    this.cause = cause || undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeSessionId(result) {
  if (!result || typeof result !== 'object') return null;
  return result.sessionId || (result.session && result.session.id) || result.id || null;
}

function isFailureResult(result) {
  return result && typeof result === 'object' && (result.ok === false || result.status === 'error');
}

function errorMessage(result, fallback) {
  if (!result || typeof result !== 'object') return fallback;
  return result.error || result.message || result.reason || fallback;
}

function bridgeErrorCode(errorText, fallback) {
  const normalized = String(errorText || '').toLowerCase();
  if (normalized.includes('automation_disabled')) return 'PTK_AUTOMATION_DISABLED';
  if (normalized.includes('bridge_not_found')) return 'PTK_BRIDGE_NOT_FOUND';
  if (normalized.includes('method_unavailable') || normalized.includes('capability')) return 'PTK_CAPABILITY_MISSING';
  return fallback;
}

function validateCapabilities(info, required = REQUIRED_CAPABILITIES) {
  if (info && info.automationEnabled === false) {
    throw new PtkBridgeError(
      'PTK automation is disabled. Use a PTK automation artifact, enable Automation Mode in PTK, or explicitly pass activate: true for a trusted page.',
      'PTK_AUTOMATION_DISABLED',
      info
    );
  }
  const capabilities = Array.isArray(info && info.capabilities) ? info.capabilities : [];
  const missing = required.filter((name) => !capabilities.includes(name));
  if (missing.length) {
    throw new PtkBridgeError(
      `PTK bridge missing capabilities: ${missing.join(', ')}`,
      'PTK_CAPABILITY_MISSING',
      { info, missing }
    );
  }
}

class PTKBridge {
  constructor(page, options = {}) {
    if (!page || typeof page.evaluate !== 'function') {
      throw new PtkBridgeError('PTK bridge requires a page-like object with evaluate()', 'PTK_BRIDGE_NOT_FOUND');
    }
    this.page = page;
    this.options = options || {};
    this.sessionId = null;
    this.bridgeInfo = null;
  }

  async _evaluate(fn, arg) {
    try {
      return await this.page.evaluate(fn, arg);
    } catch (error) {
      throw new PtkBridgeError(
        error && error.message ? error.message : String(error),
        'PTK_BROWSER_CLOSED',
        null,
        error
      );
    }
  }

  async ping() {
    return this._evaluate(async () => {
      const bridge = window.PTK_AUTOMATION;
      if (!bridge) return { ok: false, error: 'bridge_not_found' };
      if (typeof bridge.ping === 'function') return bridge.ping();
      const capabilities = ['startSession', 'endSession', 'getStats', 'getFindings', 'getSessionProgress', 'exportScan']
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
    return this._evaluate(async (activationOptions) => {
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

  async waitReady(options = {}) {
    const timeoutMs = Number(options.timeoutMs || options.timeout || this.options.timeoutMs || 30000);
    const pollMs = Number(options.pollMs || this.options.pollMs || 500);
    const activate = options.activate === true || this.options.activate === true;
    const requiredCapabilities = options.requiredCapabilities || this.options.requiredCapabilities || REQUIRED_CAPABILITIES;
    const deadline = Date.now() + timeoutMs;
    let last = null;

    while (Date.now() <= deadline) {
      last = await this.ping().catch((error) => ({ ok: false, error: error.message, code: error.code }));
      if (last && last.ok) {
        validateCapabilities(last, requiredCapabilities);
        this.bridgeInfo = last;
        return last;
      }
      if (activate && last && last.error === 'automation_disabled') {
        await this.requestActivation({ reason: options.activationReason || 'ptk_sdk_wait_ready' }).catch(() => null);
        last = await this.ping().catch((error) => ({ ok: false, error: error.message, code: error.code }));
        if (last && last.ok) {
          validateCapabilities(last, requiredCapabilities);
          this.bridgeInfo = last;
          return last;
        }
      }
      await sleep(pollMs);
    }

    throw new PtkBridgeError(
      `PTK bridge not ready after ${Math.round(timeoutMs / 1000)}s: ${JSON.stringify(last)}`,
      bridgeErrorCode(last && last.error, 'PTK_BRIDGE_NOT_FOUND'),
      last
    );
  }

  async call(method, options = {}) {
    const result = await this._evaluate(async ({ bridgeMethod, bridgeOptions }) => {
      const bridge = window.PTK_AUTOMATION;
      if (!bridge || typeof bridge[bridgeMethod] !== 'function') {
        return { ok: false, error: `bridge_method_unavailable:${bridgeMethod}` };
      }
      try {
        const value = await bridge[bridgeMethod](bridgeOptions || {});
        if (value && typeof value === 'object') return value;
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }, { bridgeMethod: method, bridgeOptions: options });
    return result;
  }

  async startSession(options = {}) {
    const result = await this.call('startSession', {
      ...options,
      engines: normalizeEngines(options.engines || process.env.PTK_ENGINES || 'DAST')
    });
    if (isFailureResult(result)) {
      throw new PtkBridgeError(
        `PTK startSession failed: ${errorMessage(result, 'unknown_error')}`,
        'PTK_START_FAILED',
        result
      );
    }
    this.sessionId = normalizeSessionId(result);
    if (!this.sessionId) {
      this.sessionId = `ptk-started-${Date.now()}`;
    }
    return { ok: true, ...result, sessionId: this.sessionId };
  }

  async endSession(options = {}) {
    const sessionId = options.sessionId || this.sessionId || null;
    if (!sessionId) {
      throw new PtkBridgeError('PTK session id is required to stop a scan', 'PTK_SESSION_ID_MISSING');
    }
    const result = await this.call('endSession', {
      ...options,
      sessionId,
      wait: options.wait === true
    });
    if (isFailureResult(result)) {
      throw new PtkBridgeError(
        `PTK endSession failed: ${errorMessage(result, 'unknown_error')}`,
        'PTK_STOP_FAILED',
        result
      );
    }
    if (options.wait !== false) this.sessionId = null;
    return { ok: true, ...result };
  }

  getStats(options = {}) {
    return this.call('getStats', options);
  }

  getFindings(options = {}) {
    return this.call('getFindings', typeof options === 'number' ? { limit: options } : options);
  }

  getSessionProgress(options = {}) {
    return this.call('getSessionProgress', {
      ...options,
      sessionId: options.sessionId || this.sessionId || undefined
    });
  }

  exportScan(options = {}) {
    return this.call('exportScan', {
      ...options,
      sessionId: options.sessionId || this.sessionId || undefined
    });
  }
}

function createPtkBridge(page, options = {}) {
  return new PTKBridge(page, options);
}

async function waitForPtk(page, options = {}) {
  const bridge = page instanceof PTKBridge ? page : createPtkBridge(page, options);
  return bridge.waitReady(options);
}

module.exports = {
  PTKBridge,
  PtkBridgeError,
  REQUIRED_CAPABILITIES,
  VALID_ENGINES,
  createPtkBridge,
  normalizeEngines,
  normalizeSessionId,
  sleep,
  validateCapabilities,
  waitForPtk
};
