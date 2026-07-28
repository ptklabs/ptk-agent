"use strict";

const assert = require("assert");
const commands = require("../src/commands");

function runCommandsSpec() {
  const p = commands._private;
  assert.ok(p, "commands private exports should exist");

  assert.deepStrictEqual(p.normalizeEngines("dast"), ["DAST"]);
  assert.deepStrictEqual(p.normalizeEngines("dast,iast"), ["DAST", "IAST"]);
  assert.deepStrictEqual(
    p.normalizeEngines(["dast", " iast,sast ", "invalid", "SCA", "DAST"]),
    ["DAST", "IAST", "SAST", "SCA"]
  );
  assert.deepStrictEqual(p.normalizeEngines(null), ["DAST"]);

  assert.strictEqual(p.toBoolean(true, false), true);
  assert.strictEqual(p.toBoolean("yes", false), true);
  assert.strictEqual(p.toBoolean("0", true), false);
  assert.strictEqual(p.toBoolean(undefined, true), true);
  assert.strictEqual(
    p.resolveBridgeCommandTimeoutMs((key) => ({ PTK_BRIDGE_TIMEOUT_MS: "45000" })[key], "PTK_FINDINGS_TIMEOUT_MS", 60000),
    45000
  );
  assert.strictEqual(
    p.resolveBridgeCommandTimeoutMs((key) => ({ PTK_FINDINGS_TIMEOUT_MS: "90000" })[key], "PTK_FINDINGS_TIMEOUT_MS", 60000),
    90000
  );
  assert.strictEqual(p.normalizeOrigin("https://example.com/a?b=1"), "https://example.com");
  assert.strictEqual(p.normalizeOrigin("ftp://example.com"), "");
  assert.deepStrictEqual(
    p.parseAllowedOrigins("https://example.com/a,http://localhost:3001/path"),
    ["https://example.com", "http://localhost:3001"]
  );

  const env = function (key) {
    const map = {
      PTK_PROJECT: "proj",
      PTK_ENGINES: "DAST,IAST",
      PTK_POLICY_CODE: "SMART",
      PTK_RUN_CVE: "true",
    };
    return map[key];
  };
  assert.deepStrictEqual(p.buildSessionOptions({}, env), {
    project: "proj",
    engines: ["DAST", "IAST"],
    policyCode: "SMART",
    testRunId: undefined,
    runCve: true,
  });

  assert.strictEqual(p.getEngineDone({ done: 2 }), 2);
  assert.strictEqual(p.getEngineDone({ progress: { done: 3 } }), 3);
  assert.strictEqual(p.getEngineDone({}), 0);

  const progress = {
    status: "running",
    summary: { findingsCount: 5 },
    engines: {
      DAST: { status: "running", progress: { done: 2, total: 10 }, findingsCount: 3 },
      IAST: { status: "running", done: 1, findingsCount: 2 },
    },
  };
  assert.strictEqual(p.extractDoneCount(progress), 3);
  assert.strictEqual(p.extractFindingsCount(progress), 5);

  const snapshotA = p.extractProgressSnapshot(progress);
  const snapshotB = p.extractProgressSnapshot({
    status: "running",
    summary: { findingsCount: 6 },
    engines: {
      DAST: { status: "running", progress: { done: 3, total: 10 }, findingsCount: 4 },
      IAST: { status: "running", done: 1, findingsCount: 2 },
    },
  });
  assert.notStrictEqual(snapshotA, snapshotB, "snapshot should change when progress changes");

  const failure = p.formatBridgeFailure("endSession", {
    status: "error",
    error: "session_failed",
    detail: "x",
  });
  assert.ok(failure.includes("session_failed"));
  assert.ok(failure.includes("status=error"));

  const exportOptions = p.buildExportOptions({ engine: "ALL" }, function (key) {
    return key === "PTK_SESSION_ID" ? "sess-1" : undefined;
  });
  assert.deepStrictEqual(exportOptions, {
    engine: "ALL",
    sessionId: "sess-1",
    sessionScope: "current-tab",
    exportMode: "evidence",
    includeSecrets: false,
  });

  assert.throws(
    function () {
      p.buildExportOptions({ includeSecrets: true }, function () {});
    },
    /replayable_export_requires_privileged_extension_export/
  );
}

module.exports = { runCommandsSpec };
