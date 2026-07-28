"use strict";

/**
 * PTK Automation Bridge helpers for Cypress.
 *
 * Bridge contract (matches Playwright / Selenium SDKs):
 *   window.PTK_AUTOMATION.version        — string
 *   window.PTK_AUTOMATION.ping()          — { ok, version, capabilities, automationEnabled, bridgeId }
 *   window.PTK_AUTOMATION.startSession()  — { sessionId, status, … }
 *   window.PTK_AUTOMATION.endSession()    — { status, stats, … }
 *   window.PTK_AUTOMATION.getStats()      — { findingsCount, bySeverity }
 *   window.PTK_AUTOMATION.getFindings()   — { findings, truncated }
 *   window.PTK_AUTOMATION.exportScan()    — { ok, scans, truncatedAny, warnings }
 *   window.PTK_AUTOMATION.getSessionProgress() — { status, engines, … }
 */

const REQUIRED_CAPABILITIES = [
  "startSession",
  "endSession",
  "getStats",
  "getFindings",
];

const OPTIONAL_CAPABILITIES = ["exportScan", "getSessionProgress"];

const ALL_CAPABILITIES = REQUIRED_CAPABILITIES.concat(OPTIONAL_CAPABILITIES);

/**
 * JavaScript snippet executed inside the browser to check if bridge is ready.
 * Returns a bridge-info object or { ok: false, error }.
 */
const CHECK_BRIDGE_SCRIPT = `
  (function (timeoutMs) {
    var bridge = window.PTK_AUTOMATION;
    if (!bridge) return { ok: false, error: "bridge_not_found" };

    function enumCapabilities() {
      var caps = [];
      ${JSON.stringify(ALL_CAPABILITIES)}.forEach(function (m) {
        if (typeof bridge[m] === "function") caps.push(m);
      });
      return caps;
    }

    function ping() {
      if (typeof bridge.ping === "function") {
        return Promise.resolve().then(function () { return bridge.ping(); });
      }
      var caps = enumCapabilities();
      return Promise.resolve({
        ok: caps.length >= ${REQUIRED_CAPABILITIES.length},
        version: bridge.version || "unknown",
        capabilities: caps,
        automationEnabled: true,
      });
    }

    if (!timeoutMs || timeoutMs <= 0) return ping();

    var timer;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, timeoutMs);
    });

    return Promise.race([ping(), timeoutPromise])
      .then(function (r) { clearTimeout(timer); return r; })
      .catch(function (e) {
        clearTimeout(timer);
        if (e && e.message === "timeout") return { ok: false, error: "timeout" };
        return { ok: false, error: "ping_failed", message: e.message || String(e) };
      });
  })
`;

/**
 * Validate that a bridge-info object has the required capabilities.
 *
 * @param {object} info – result from bridge ping / check
 * @throws {Error} if automation is disabled or required capabilities are missing
 */
function validateCapabilities(info) {
  if (info.automationEnabled === false) {
    throw new Error(
      "PTK automation is disabled. Enable in PTK Settings → Automation."
    );
  }

  var capabilities = info.capabilities || [];
  var missing = REQUIRED_CAPABILITIES.filter(function (c) {
    return capabilities.indexOf(c) === -1;
  });

  if (missing.length) {
    throw new Error(
      "PTK bridge missing capabilities: " +
        missing.join(", ") +
        ". Available: " +
        capabilities.join(", ") +
        ". Update PTK extension or check automation is enabled."
    );
  }
}

module.exports = {
  REQUIRED_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  CHECK_BRIDGE_SCRIPT,
  validateCapabilities,
};
