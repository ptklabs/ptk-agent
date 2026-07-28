#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED_FILES = [
  "findings.json",
  "finding_gate.json",
  "engine_gate.json",
  "progress-summary.json",
  "scan_stop.json",
  "session_start.json",
  "session_stats.json",
  "framework-run.json",
  "browser-launch.json",
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    artifactsDir: null,
    requireEngines: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifacts-dir") options.artifactsDir = path.resolve(argv[++index]);
    else if (arg === "--no-require-engines") options.requireEngines = false;
    else if (!arg.startsWith("-") && !options.artifactsDir) options.artifactsDir = path.resolve(arg);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function help() {
  return [
    "Usage:",
    "  node scripts/verify-framework-artifacts.cjs --artifacts-dir <dir>",
    "",
    "Options:",
    "  --no-require-engines    Do not require engine_gate.passed",
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function verifyArtifacts(options) {
  if (!options.artifactsDir) {
    throw new Error("--artifacts-dir is required");
  }
  const artifactsDir = path.resolve(options.artifactsDir);
  const errors = [];
  const loaded = {};

  for (const name of REQUIRED_FILES) {
    const filePath = path.join(artifactsDir, name);
    if (!fs.existsSync(filePath)) {
      errors.push(`missing artifact: ${name}`);
      continue;
    }
    try {
      loaded[name] = readJson(filePath);
    } catch (error) {
      errors.push(`invalid JSON in ${name}: ${error.message}`);
    }
  }

  const findingGate = loaded["finding_gate.json"];
  if (findingGate && findingGate.ok !== true) {
    errors.push("finding_gate.json did not pass");
  }

  const engineGate = loaded["engine_gate.json"];
  if (options.requireEngines && engineGate && engineGate.passed !== true) {
    errors.push("engine_gate.json did not pass");
  }

  const stop = loaded["scan_stop.json"];
  if (stop && stop.stopSucceeded !== true) {
    errors.push("scan_stop.json did not report stopSucceeded=true");
  }

  const sessionStart = loaded["session_start.json"];
  if (sessionStart && sessionStart.status !== "started") {
    errors.push("session_start.json did not report status=started");
  }

  const frameworkRun = loaded["framework-run.json"];
  if (frameworkRun && frameworkRun.status && frameworkRun.status !== "passed") {
    errors.push(`framework-run.json status is ${frameworkRun.status}`);
  }

  const browserLaunch = loaded["browser-launch.json"];
  if (
    browserLaunch &&
    !browserLaunch.extensionPath &&
    !["firefox-profile", "preinstalled-profile"].includes(browserLaunch.profileMode)
  ) {
    errors.push("browser-launch.json is missing extensionPath");
  }

  const result = {
    ok: errors.length === 0,
    artifactsDir,
    checkedFiles: REQUIRED_FILES,
    errors,
  };
  if (errors.length) {
    const error = new Error(
      `Framework artifact verification failed:\n${errors.map((line) => `- ${line}`).join("\n")}`
    );
    error.result = result;
    throw error;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(help());
      return 0;
    }
    console.log(JSON.stringify(verifyArtifacts(options), null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  REQUIRED_FILES,
  verifyArtifacts,
};
