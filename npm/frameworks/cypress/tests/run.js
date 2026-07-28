"use strict";

const { runPluginSpec } = require("./plugin.spec");
const { runCommandsSpec } = require("./commands.spec");

function run(name, fn) {
  try {
    fn();
    process.stdout.write("[PASS] " + name + "\n");
  } catch (err) {
    process.stderr.write("[FAIL] " + name + ": " + String(err && err.stack ? err.stack : err) + "\n");
    process.exitCode = 1;
  }
}

run("plugin.spec", runPluginSpec);
run("commands.spec", runCommandsSpec);

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
