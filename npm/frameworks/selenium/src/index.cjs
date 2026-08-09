'use strict';

const browser = require('../../../browser/src/index.cjs');

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

async function waitForPtk(driver, options = {}) {
  return createSeleniumPtkBridge(driver, options).waitReady(options);
}

async function withPtkScan(driver, options = {}, runJourney) {
  const page = createSeleniumPageLike(driver, options);
  const bridge = browser.createPtkBridge(page, options.bridgeOptions || {});
  return browser.withPtkScan(page, {
    ...options,
    bridge
  }, async ({ ptk, session, startPtkScan }) => {
    return runJourney({
      driver,
      ptk,
      session,
      startPtkScan
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
  waitForPtk,
  withPtkScan,
  collectPtkResults
};
