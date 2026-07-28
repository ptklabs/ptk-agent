"use strict";

/**
 * Custom Cypress commands for PTK bridge interaction.
 *
 * After calling registerCommands(), tests can use:
 *   cy.ptkWaitReady(timeout?)
 *   cy.ptkStartSession(options)
 *   cy.ptkEndSession(options?)
 *   cy.ptkGetStats()
 *   cy.ptkGetFindings(limit?)
 *   cy.ptkGetSessionProgress()
 *   cy.ptkExportScan(options?)
 */

var bridge = require("./bridge");

/* ---------- internal helpers ---------- */

var POLL_INTERVAL = 500;
var PROGRESS_POLL_INTERVAL = 2000;
var DEFAULT_MAX_WAIT = 600;
var DEFAULT_STUCK_THRESHOLD = 60;
var VALID_ENGINES = ["DAST", "IAST", "SAST", "SCA"];

function safeJson(value, maxLen) {
  var text;
  try {
    text = JSON.stringify(value);
  } catch (_) {
    text = String(value);
  }
  if (!Number.isFinite(maxLen) || maxLen <= 0) return text;
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function getBridge(win) {
  var b = win.PTK_AUTOMATION;
  if (!b) {
    throw new Error(
      "PTK bridge not found on window. Call cy.ptkWaitReady() first and ensure the extension is loaded."
    );
  }
  return b;
}

function toEngineArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  if (value == null) {
    return [];
  }
  return [value];
}

function normalizeEngines(value) {
  var input = toEngineArray(value);
  var normalized = [];
  var seen = new Set();

  input.forEach(function (item) {
    String(item || "")
      .split(",")
      .map(function (v) { return v.trim().toUpperCase(); })
      .filter(Boolean)
      .forEach(function (engine) {
        if (VALID_ENGINES.indexOf(engine) === -1) return;
        if (seen.has(engine)) return;
        seen.add(engine);
        normalized.push(engine);
      });
  });

  return normalized.length ? normalized : ["DAST"];
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  var normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].indexOf(normalized) >= 0) return true;
  if (["0", "false", "no", "off"].indexOf(normalized) >= 0) return false;
  return fallback;
}

function toMs(value, fallback) {
  var num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.trunc(num);
}

function resolveThenTimeout(maxWaitMs) {
  var defaultTimeout = toMs(Cypress.config("defaultCommandTimeout"), 4000);
  var guardMs = 10000;
  return Math.max(defaultTimeout, maxWaitMs + guardMs);
}

function resolveStartTimeoutMs(opts) {
  return toMs(
    opts && opts.timeoutMs,
    toMs(Cypress.env("PTK_START_TIMEOUT_MS"), 60000)
  );
}

function resolveBridgeCommandTimeoutMs(env, specificName, fallback) {
  var envFn = typeof env === "function" ? env : function () {};
  return toMs(envFn(specificName), toMs(envFn("PTK_BRIDGE_TIMEOUT_MS"), fallback));
}

function normalizeOrigin(value) {
  try {
    var parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch (_) {
    return "";
  }
}

function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map(function (item) {
      return normalizeOrigin(item.trim());
    })
    .filter(Boolean);
}

function assertCurrentOriginAllowed(win) {
  var allowed = parseAllowedOrigins(Cypress.env("PTK_CYPRESS_ALLOWED_ORIGINS"));
  if (!allowed.length) return;
  var currentOrigin = normalizeOrigin(win && win.location && win.location.href);
  if (!currentOrigin || allowed.indexOf(currentOrigin) >= 0) return;
  throw new Error(
    "PTK Cypress bridge is not enabled for " + currentOrigin + ". " +
      "Add this origin to setupPtkCypress(..., { allowedOrigins: [...] }) " +
      "or PTK_CYPRESS_ALLOWED_ORIGINS. Current allowed origins: " + allowed.join(", ")
  );
}

function formatBridgeFailure(op, payload) {
  if (!payload || typeof payload !== "object") {
    return op + " failed with non-object payload: " + safeJson(payload, 800);
  }
  var err = payload.error || payload.message || payload.reason || "unknown_error";
  var status = payload.status ? " status=" + payload.status : "";
  return op + " failed: " + err + status + " payload=" + safeJson(payload, 1200);
}

function getEngineDone(eng) {
  if (!eng || typeof eng !== "object") return 0;
  if (typeof eng.done === "number") return eng.done;
  if (eng.progress && typeof eng.progress.done === "number") return eng.progress.done;
  return 0;
}

function extractDoneCount(progress) {
  if (!progress || !progress.engines || typeof progress.engines !== "object") return 0;
  var total = 0;
  Object.keys(progress.engines).forEach(function (key) {
    total += getEngineDone(progress.engines[key]);
  });
  return total;
}

function extractFindingsCount(progress) {
  if (!progress || typeof progress !== "object") return 0;
  if (typeof progress?.summary?.findingsCount === "number") {
    return progress.summary.findingsCount;
  }
  var total = 0;
  if (progress.engines && typeof progress.engines === "object") {
    Object.keys(progress.engines).forEach(function (key) {
      var eng = progress.engines[key];
      if (eng && typeof eng.findingsCount === "number") {
        total += eng.findingsCount;
      }
    });
  }
  return total;
}

function extractProgressSnapshot(progress) {
  if (!progress || typeof progress !== "object") return "invalid";
  var engines = progress.engines && typeof progress.engines === "object" ? progress.engines : {};
  var engineParts = Object.keys(engines)
    .sort()
    .map(function (name) {
      var eng = engines[name] || {};
      var done = getEngineDone(eng);
      var total = eng?.progress?.total;
      var status = eng.status || "unknown";
      var findings = typeof eng.findingsCount === "number" ? eng.findingsCount : 0;
      var activity = eng.lastActivityAt || "";
      return [name, status, done, total, findings, activity].join(":");
    });

  return [
    progress.status || "unknown",
    extractDoneCount(progress),
    extractFindingsCount(progress),
    progress.lastUpdatedAt || progress.lastActivityAt || "",
    engineParts.join("|"),
  ].join("::");
}

function buildSessionOptions(opts, cypressEnv) {
  var enginesInput = opts.engines != null ? opts.engines : cypressEnv("PTK_ENGINES");
  return {
    project: opts.project || cypressEnv("PTK_PROJECT"),
    engines: normalizeEngines(enginesInput),
    policyCode: opts.policyCode || cypressEnv("PTK_POLICY_CODE") || undefined,
    testRunId: opts.testRunId || undefined,
    runCve: toBoolean(opts.runCve, toBoolean(cypressEnv("PTK_RUN_CVE"), false)) === true,
  };
}

/* ---------- command implementations ---------- */

function ptkWaitReady(timeout) {
  var maxMs = timeout || 30000;
  var started = Date.now();

  function poll() {
    var elapsed = Date.now() - started;
    if (elapsed > maxMs) {
      throw new Error(
        "PTK bridge not available after " +
          Math.round(maxMs / 1000) +
          "s. Ensure extension is loaded and automation is enabled."
      );
    }

    return cy.window({ log: false }).then(function (win) {
      assertCurrentOriginAllowed(win);
      if (!win.PTK_AUTOMATION) {
        return cy.wait(POLL_INTERVAL, { log: false }).then(poll);
      }

      return new Cypress.Promise(function (resolve) {
        Promise.resolve()
          .then(function () {
            var b = win.PTK_AUTOMATION;
            if (typeof b.ping === "function") {
              return b.ping();
            }
            var caps = [];
            bridge.REQUIRED_CAPABILITIES
              .concat(bridge.OPTIONAL_CAPABILITIES)
              .forEach(function (m) {
                if (typeof b[m] === "function") caps.push(m);
              });
            return {
              ok: caps.length >= bridge.REQUIRED_CAPABILITIES.length,
              version: b.version || "unknown",
              capabilities: caps,
              automationEnabled: true,
            };
          })
          .then(resolve)
          .catch(function () {
            resolve({ ok: false, error: "ping_failed" });
          });
      }).then(function (info) {
        if (info && info.ok) {
          bridge.validateCapabilities(info);
          Cypress.log({
            name: "ptkWaitReady",
            message: "Bridge v" + (info.version || "?") + " ready",
            consoleProps: function () {
              return info;
            },
          });
          return info;
        }
        return cy.wait(POLL_INTERVAL, { log: false }).then(poll);
      });
    });
  }

  return poll();
}

function ptkStartSession(options) {
  var opts = options || {};
  var sessionOpts = buildSessionOptions(opts, Cypress.env.bind(Cypress));
  var startTimeoutMs = resolveStartTimeoutMs(opts);
  var thenTimeout = resolveThenTimeout(startTimeoutMs);

  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    return new Cypress.Promise(function (resolve, reject) {
      var timeoutId = setTimeout(function () {
        reject(new Error("PTK startSession timed out after " + Math.round(startTimeoutMs / 1000) + "s"));
      }, startTimeoutMs);

      Promise.resolve()
        .then(function () {
          return b.startSession(sessionOpts);
        })
        .then(function (result) {
          clearTimeout(timeoutId);
          if (result && (result.ok === false || result.error || result.status === "error")) {
            throw new Error(formatBridgeFailure("startSession", result));
          }
          if (result && !result.sessionId && String(result.status || "").toLowerCase() === "started") {
            result.sessionId = "ptk-started-" + Date.now();
          }
          if (result && result.sessionId) {
            Cypress.env("PTK_SESSION_ID", result.sessionId);
          }
          Cypress.log({
            name: "ptkStartSession",
            message: "Session started" + (result && result.sessionId ? " (" + result.sessionId + ")" : ""),
            consoleProps: function () {
              return result;
            },
          });
          resolve(result);
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  });
}

function ptkEndSession(options) {
  var opts = options || {};
  var shouldWait = opts.wait !== false;
  var maxWait = (opts.maxWait || DEFAULT_MAX_WAIT) * 1000;
  var stuckThreshold = (opts.stuckThreshold || DEFAULT_STUCK_THRESHOLD) * 1000;
  var pollInterval = opts.pollInterval || PROGRESS_POLL_INTERVAL;
  var thenTimeout = resolveThenTimeout(maxWait);

  function buildStopOptions(waitValue) {
    var stopOptions = { wait: waitValue };
    if (typeof opts.immediateAnalysis === "boolean") {
      stopOptions.immediateAnalysis = opts.immediateAnalysis;
    }
    return stopOptions;
  }

  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    var hasProgress = typeof b.getSessionProgress === "function";

    if (shouldWait && hasProgress) {
      return new Cypress.Promise(function (resolve, reject) {
        Promise.resolve()
          .then(function () {
            return b.endSession(buildStopOptions(false));
          })
          .then(function (stopResult) {
            if (stopResult && (stopResult.ok === false || stopResult.error)) {
              throw new Error(formatBridgeFailure("endSession(wait:false)", stopResult));
            }

            var started = Date.now();
            var lastSnapshot = null;
            var lastChangeAt = Date.now();
            var lastPollError = null;

            function poll() {
              var elapsed = Date.now() - started;
              if (elapsed > maxWait) {
                return reject(
                  new Error(
                    "PTK session end timed out after " +
                      Math.round(maxWait / 1000) +
                      "s. Last error=" +
                      (lastPollError ? String(lastPollError.message || lastPollError) : "none")
                  )
                );
              }

              Promise.resolve()
                .then(function () {
                  return b.getSessionProgress();
                })
                .then(function (progress) {
                  if (!progress || typeof progress !== "object") {
                    lastPollError = new Error("invalid_progress_payload");
                    setTimeout(poll, pollInterval);
                    return;
                  }

                  var status = progress.status;
                  if (status === "completed") {
                    Cypress.log({
                      name: "ptkEndSession",
                      message: "Session completed",
                      consoleProps: function () {
                        return progress;
                      },
                    });
                    return resolve(progress);
                  }

                  if (status === "error") {
                    return reject(new Error(formatBridgeFailure("getSessionProgress", progress)));
                  }

                  var snapshot = extractProgressSnapshot(progress);
                  if (snapshot !== lastSnapshot) {
                    lastSnapshot = snapshot;
                    lastChangeAt = Date.now();
                  } else if (Date.now() - lastChangeAt > stuckThreshold) {
                    return reject(
                      new Error(
                        "PTK session appears stuck (no progress for " +
                          Math.round(stuckThreshold / 1000) +
                          "s). progress=" +
                          safeJson(progress, 1200)
                      )
                    );
                  }

                  setTimeout(poll, pollInterval);
                })
                .catch(function (err) {
                  lastPollError = err;
                  if (Date.now() - lastChangeAt > stuckThreshold) {
                    return reject(
                      new Error(
                        "PTK progress polling failed repeatedly for " +
                          Math.round(stuckThreshold / 1000) +
                          "s: " +
                          String(err?.message || err)
                      )
                    );
                  }
                  setTimeout(poll, pollInterval);
                });
            }

            setTimeout(poll, pollInterval);
          })
          .catch(reject);
      });
    }

    return new Cypress.Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () {
          return b.endSession(buildStopOptions(shouldWait));
        })
        .then(function (result) {
          if (result && (result.ok === false || result.error)) {
            throw new Error(formatBridgeFailure("endSession", result));
          }
          Cypress.log({
            name: "ptkEndSession",
            message: "Session ended",
            consoleProps: function () {
              return result;
            },
          });
          resolve(result);
        })
        .catch(reject);
    });
  });
}

function ptkGetStats() {
  var timeoutMs = resolveBridgeCommandTimeoutMs(Cypress.env.bind(Cypress), "PTK_STATS_TIMEOUT_MS", 60000);
  var thenTimeout = resolveThenTimeout(timeoutMs);
  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    return new Cypress.Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () {
          return b.getStats();
        })
        .then(function (result) {
          Cypress.log({
            name: "ptkGetStats",
            message: (result && result.findingsCount) + " findings",
            consoleProps: function () {
              return result;
            },
          });
          resolve(result);
        })
        .catch(reject);
    });
  });
}

function ptkGetFindings(limit) {
  var timeoutMs = resolveBridgeCommandTimeoutMs(Cypress.env.bind(Cypress), "PTK_FINDINGS_TIMEOUT_MS", 60000);
  var thenTimeout = resolveThenTimeout(timeoutMs);
  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    return new Cypress.Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () {
          return b.getFindings(limit);
        })
        .then(resolve)
        .catch(reject);
    });
  });
}

function ptkGetSessionProgress() {
  var timeoutMs = resolveBridgeCommandTimeoutMs(Cypress.env.bind(Cypress), "PTK_PROGRESS_TIMEOUT_MS", 60000);
  var thenTimeout = resolveThenTimeout(timeoutMs);
  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    if (typeof b.getSessionProgress !== "function") {
      throw new Error("getSessionProgress not available. Update PTK extension to use this feature.");
    }
    return new Cypress.Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () {
          return b.getSessionProgress({
            sessionId: Cypress.env("PTK_SESSION_ID"),
            sessionScope: "current-tab",
          });
        })
        .then(resolve)
        .catch(reject);
    });
  });
}

function buildExportOptions(options, env) {
  var exportOptions = options || {};
  if (
    exportOptions.includeSecrets === true ||
    String(exportOptions.exportMode || "").toLowerCase() === "replayable" ||
    exportOptions.sensitive === true
  ) {
    throw new Error("replayable_export_requires_privileged_extension_export");
  }
  return Object.assign({}, exportOptions, {
    sessionId: exportOptions.sessionId || env("PTK_SESSION_ID"),
    sessionScope: "current-tab",
    exportMode: "evidence",
    includeSecrets: false,
  });
}

function ptkExportScan(options) {
  var timeoutMs = resolveBridgeCommandTimeoutMs(Cypress.env.bind(Cypress), "PTK_EXPORT_TIMEOUT_MS", 120000);
  var thenTimeout = resolveThenTimeout(timeoutMs);
  return cy.window({ log: false }).then({ timeout: thenTimeout }, function (win) {
    var b = getBridge(win);
    if (typeof b.exportScan !== "function") {
      throw new Error(
        "exportScan not available. Update PTK extension to use this feature."
      );
    }
    var safeOptions = buildExportOptions(options, Cypress.env);
    return new Cypress.Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () {
          return b.exportScan(safeOptions);
        })
        .then(function (result) {
          Cypress.log({
            name: "ptkExportScan",
            message: "Export complete",
            consoleProps: function () {
              return result;
            },
          });
          resolve(result);
        })
        .catch(reject);
    });
  });
}

/* ---------- registration ---------- */

function registerCommands() {
  Cypress.Commands.add("ptkWaitReady", ptkWaitReady);
  Cypress.Commands.add("ptkStartSession", ptkStartSession);
  Cypress.Commands.add("ptkEndSession", ptkEndSession);
  Cypress.Commands.add("ptkGetStats", ptkGetStats);
  Cypress.Commands.add("ptkGetFindings", ptkGetFindings);
  Cypress.Commands.add("ptkGetSessionProgress", ptkGetSessionProgress);
  Cypress.Commands.add("ptkExportScan", ptkExportScan);
}

module.exports = {
  registerCommands,
  _private: {
    normalizeEngines,
    toBoolean,
    buildSessionOptions,
    getEngineDone,
    extractDoneCount,
    extractFindingsCount,
    extractProgressSnapshot,
    formatBridgeFailure,
    buildExportOptions,
    resolveBridgeCommandTimeoutMs,
    normalizeOrigin,
    parseAllowedOrigins,
    assertCurrentOriginAllowed,
  },
};
