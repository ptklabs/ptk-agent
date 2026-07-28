#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const benchmarkCommand = require('../agents/src/cli/commands/benchmark.cjs');

function parseDriverArgs(argv) {
  const forwarded = [];
  let packageRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--package-root') {
      packageRoot = path.resolve(argv[++index]);
    } else {
      forwarded.push(argv[index]);
    }
  }
  if (!packageRoot) {
    throw new Error('--package-root is required');
  }
  const cliPath = path.join(packageRoot, 'bin', 'ptk-scan');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Installed public ptk-scan CLI not found: ${cliPath}`);
  }
  return { packageRoot, cliPath, forwarded };
}

function addValue(args, flag, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(flag, String(value));
}

function createInstalledRunner({ packageRoot, cliPath }) {
  return async function runInstalledPtkScan(options = {}) {
    const outputDir = path.resolve(options.outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'installed-cli-result.json');
    const stdoutPath = path.join(outputDir, 'installed-cli.stdout.log');
    const stderrPath = path.join(outputDir, 'installed-cli.stderr.log');
    const args = [options.url];

    addValue(args, '--scenario', options.scenarioEnabled ? options.scenario : null);
    if (options.scenarioContinueOnFailure) args.push('--scenario-continue-on-failure');
    addValue(args, '--engines', (options.requestedEngines || ['DAST', 'IAST', 'SAST']).join(','));
    addValue(args, '--max-routes', options.maxRoutes);
    addValue(args, '--crawl-depth', options.maxDepth);
    addValue(args, '--max-route-ms', options.maxRouteMs);
    addValue(args, '--max-action-ms', options.maxActionMs);
    addValue(args, '--max-actions-per-route', options.maxActionsPerRoute);
    addValue(args, '--max-forms-per-route', options.maxFormsPerRoute);
    addValue(args, '--max-observation-ms', options.maxObservationMs);
    addValue(args, '--max-provider-ms', options.maxProviderMs);
    addValue(args, '--ptk-drain-mode', options.ptkDrainMode);
    addValue(args, '--ptk-drain-timeout-ms', options.ptkDrainTimeoutMs);
    addValue(args, '--ptk-extension-dir', options.ptkExtensionDir);
    addValue(args, '--route-hints-file', options.inlineConfig?.crawler?.routeHintsFile);
    addValue(args, '--agent-mode', options.agentMode || 'off');
    addValue(args, '--agent-provider', options.agentProvider);
    addValue(args, '--agent-model', options.agentModel);
    addValue(args, '--max-agent-turns', options.inlineConfig?.agent?.maxTurns);

    if (options.requirePtkBridge) args.push('--require-ptk-bridge');
    if (options.requirePtkFindingsExport) args.push('--require-ptk-findings-export');
    if (options.waitForPtkComplete) args.push('--wait-for-ptk-complete');
    if (options.requirePtkAttackCompletion) args.push('--require-ptk-attack-completion');
    if (options.inlineConfig?.agent?.allowDestructiveActions) {
      args.push('--allow-destructive-actions');
    } else if (options.inlineConfig?.agent?.allowBusinessMutations) {
      args.push('--aggressive');
    }

    const childEnv = {
      ...process.env,
      PTK_EXTENSION_DIR: '',
      PTK_EXTENSION_PATH: '',
      PTK_INSTALLED_MATRIX_USERNAME: String(options.username || ''),
      PTK_INSTALLED_MATRIX_PASSWORD: String(options.password || '')
    };
    if (options.username !== undefined) {
      args.push('--username-env', 'PTK_INSTALLED_MATRIX_USERNAME');
    }
    if (options.password !== undefined) {
      args.push('--password-env', 'PTK_INSTALLED_MATRIX_PASSWORD');
    }
    args.push('--output-dir', outputDir, '--format', 'json', '--output', reportPath);

    const execution = spawnSync(cliPath, args, {
      cwd: path.resolve(options.cwd || process.cwd()),
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: Number(process.env.PTK_INSTALLED_SCAN_TIMEOUT_MS || 900000)
    });
    fs.writeFileSync(stdoutPath, execution.stdout || '', 'utf8');
    fs.writeFileSync(stderrPath, execution.stderr || '', 'utf8');

    if (!fs.existsSync(reportPath)) {
      const reason = execution.error?.message
        || execution.signal
        || `exit ${execution.status}`;
      throw new Error(`Installed ptk-scan did not write its JSON result (${reason}); see ${stderrPath}`);
    }
    const result = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    result.installedCli = {
      packageRoot,
      cliPath,
      exitCode: execution.status,
      signal: execution.signal || null,
      stdoutPath,
      stderrPath,
      reportPath
    };
    return result;
  };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseDriverArgs(argv);
  return benchmarkCommand.run(parsed.forwarded, {
    cwd: process.cwd(),
    io: { stdout: process.stdout, stderr: process.stderr },
    cliName: 'ptk-installed-matrix',
    runPtkAgent: createInstalledRunner(parsed)
  });
}

if (require.main === module) {
  main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  createInstalledRunner,
  parseDriverArgs
};
