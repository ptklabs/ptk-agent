'use strict';

const browser = require('../../../browser/src/index.cjs');
const preNavigation = require('../../../browser/src/preNavigation.cjs');

function scriptSource(pageFunction) {
  if (typeof pageFunction === 'string') return pageFunction;
  return `return (${pageFunction.toString()})(arguments[0]);`;
}

function createSeleniumPageLike(driver, options = {}) {
  return {
    async evaluate(pageFunction, arg) {
      if (options.switchToDefaultContent !== false && driver.switchTo && typeof driver.switchTo === 'function') {
        try {
          const target = driver.switchTo();
          if (target && typeof target.defaultContent === 'function') await target.defaultContent();
        } catch (_) {
          // Some drivers do not expose defaultContent for the current context.
        }
      }
      const source = scriptSource(pageFunction);
      return driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        const arg = arguments[0];
        Promise.resolve()
          .then(() => {
            ${source}
          })
          .then((value) => done({ ok: true, value }))
          .catch((error) => done({
            ok: false,
            error: error && error.message ? error.message : String(error),
            stack: error && error.stack ? error.stack : null
          }));
      `, arg).then((result) => {
        if (result && result.ok === false) {
          const error = new Error(result.error || 'Selenium PTK evaluate failed');
          error.stack = result.stack || error.stack;
          throw error;
        }
        return result ? result.value : result;
      });
    },
    waitForTimeout(ms) {
      if (typeof driver.sleep === 'function') return driver.sleep(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    async goto(url) {
      return driver.get(url);
    }
  };
}

function createSeleniumPtkBridge(driver, options = {}) {
  return browser.createPtkBridge(createSeleniumPageLike(driver, options), options);
}

async function discoverSeleniumExtensionOrigin(driver, options = {}) {
  if (options.extensionOrigin) return String(options.extensionOrigin).replace(/\/$/, '');
  const browserName = String(options.browser || options.browserName || '').toLowerCase();
  if (browserName === 'firefox') {
    const uuid = options.firefoxExtensionUuid
      || process.env.PTK_FIREFOX_EXTENSION_UUID
      || '7b4b556d-55d0-4db7-bf08-7c1ec1a0f5c5';
    return `moz-extension://${uuid}`;
  }
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 10000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let response = null;
    try {
      if (typeof driver.sendAndGetDevToolsCommand === 'function') {
        response = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
      } else if (typeof driver.executeCdpCommand === 'function') {
        response = await driver.executeCdpCommand('Target.getTargets', {});
      }
    } catch (_) {
      response = null;
    }
    for (const target of response?.targetInfos || []) {
      try {
        const parsed = new URL(String(target?.url || ''));
        if (
          parsed.protocol === 'chrome-extension:'
          && (parsed.pathname === '/app.js' || parsed.pathname === '/app_automation.js')
        ) {
          return `${parsed.protocol}//${parsed.host}`;
        }
      } catch (_) {
        // Ignore non-extension targets.
      }
    }
    if (Date.now() >= deadline) break;
    if (typeof driver.sleep === 'function') await driver.sleep(100);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function armPtkIastForNavigation(driver, options = {}) {
  const extensionOrigin = await discoverSeleniumExtensionOrigin(driver, options);
  const browserName = String(options.browser || options.browserName || '').toLowerCase();
  if (browserName === 'firefox') {
    const scanOptions = options.scanOptions && typeof options.scanOptions === 'object'
      ? options.scanOptions
      : options;
    if (!preNavigation.hasIastEngine(scanOptions)) {
      return { ok: true, applicable: false, reason: 'iast_not_requested' };
    }
    let parsedTarget;
    try {
      parsedTarget = new URL(String(options.targetUrl || scanOptions.bootstrapUrl || scanOptions.bootstrap?.url || ''));
    } catch (_) {
      return { ok: false, applicable: true, error: 'ptk_target_url_invalid' };
    }
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return { ok: false, applicable: true, error: 'ptk_target_url_unsupported' };
    }
    if (!extensionOrigin) {
      return { ok: false, applicable: false, error: 'ptk_extension_origin_not_found' };
    }

    const controlUrl = `${extensionOrigin}${preNavigation.PTK_AUTOMATION_CONTROL_PATH}`;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
    try {
      await driver.get('about:blank');
      await driver.executeScript(`
        const frame = document.createElement('iframe');
        frame.id = 'ptk-automation-control-frame';
        frame.name = 'ptk-automation-control-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;opacity:0;pointer-events:none;border:0';
        frame.src = arguments[0];
        document.documentElement.appendChild(frame);
      `, controlUrl);
      await driver.switchTo().frame('ptk-automation-control-frame');
      await driver.manage().setTimeouts({ script: timeoutMs });
      const result = await driver.executeAsyncScript(`
        const request = arguments[0];
        const done = arguments[arguments.length - 1];
        const deadline = Date.now() + arguments[1];
        const run = () => {
          const control = globalThis.PTK_AUTOMATION_CONTROL;
          if (control && typeof control.armIastForNavigation === 'function') {
            Promise.resolve(control.armIastForNavigation(request))
              .then(done)
              .catch((error) => done({ ok: false, error: error?.message || String(error) }));
            return;
          }
          if (Date.now() >= deadline) {
            done({ ok: false, error: 'ptk_automation_control_unavailable' });
            return;
          }
          setTimeout(run, 25);
        };
        run();
      `, {
        targetUrl: parsedTarget.href,
        scanOptions,
        ttlMs: Math.max(1000, Math.min(Number(options.ttlMs || 60000), 60000))
      }, timeoutMs);
      return {
        ...(result && typeof result === 'object'
          ? result
          : { ok: false, error: 'ptk_pre_navigation_invalid_response' }),
        applicable: true,
        controlUrl,
        transport: 'firefox_extension_frame'
      };
    } catch (error) {
      return {
        ok: false,
        applicable: true,
        error: 'ptk_iast_pre_navigation_arm_failed',
        message: error?.message || String(error),
        controlUrl,
        transport: 'firefox_extension_frame'
      };
    } finally {
      try {
        await driver.switchTo().defaultContent();
      } catch (_) {
        // Target navigation replaces this private bootstrap document regardless.
      }
    }
  }
  return browser.armPtkIastForNavigation(createSeleniumPageLike(driver, options), {
    ...options,
    extensionOrigin
  });
}

async function waitForPtk(driver, options = {}) {
  return createSeleniumPtkBridge(driver, options).waitReady(options);
}

async function withPtkScan(driver, options = {}, runJourney) {
  const page = createSeleniumPageLike(driver, options);
  const bridge = browser.createPtkBridge(page, options.bridgeOptions || {});
  const preNavigationArmOperation = (targetUrl, armOptions = {}) => armPtkIastForNavigation(driver, {
    ...options,
    ...armOptions,
    targetUrl,
    scanOptions: armOptions.scanOptions || options
  });
  return browser.withPtkScan(page, {
    ...options,
    bridge,
    preNavigationArmOperation
  }, async ({ ptk, session, startPtkScan, armPtkIastForNavigation: armIast }) => {
    return runJourney({
      driver,
      ptk,
      session,
      startPtkScan,
      armPtkIastForNavigation: armIast
    });
  });
}

async function collectPtkResults(driverOrBridge, session, options = {}) {
  const bridge = driverOrBridge && typeof driverOrBridge.call === 'function'
    ? driverOrBridge
    : createSeleniumPtkBridge(driverOrBridge, options);
  return browser.collectPtkResults(bridge, session, options);
}

module.exports = {
  ...browser,
  createSeleniumPageLike,
  createSeleniumPtkBridge,
  discoverSeleniumExtensionOrigin,
  armPtkIastForNavigation,
  waitForPtk,
  withPtkScan,
  collectPtkResults
};
