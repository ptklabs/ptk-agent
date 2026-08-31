'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  mapPtkScanArgs,
  parseEngineList,
  run
} = require('../../../src/cli/compat/ptkScan.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'ptk-scan');

function tmpDir(prefix = 'ptk-scan-compat-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createIo() {
  const chunks = { stdout: '', stderr: '' };
  return {
    chunks,
    io: {
      stdout: { write(chunk) { chunks.stdout += chunk; } },
      stderr: { write(chunk) { chunks.stderr += chunk; } }
    }
  };
}

test('ptk-scan help works', () => {
  const output = execFileSync(process.execPath, [binPath, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.match(output, /Usage:/);
  assert.match(output, /ptk-scan <target-url>/);
  assert.match(output, /\$\{PTK_SECRET:NAME\} -> PTK_MACRO_SECRET_NAME/);
  assert.match(output, /\$\{NAME\} -> PTK_MACRO_VAR_NAME/);
});

test('positional URL maps to target.baseUrl', () => {
  const mapped = mapPtkScanArgs(['http://app.test/', '--dry-run']);
  assert.equal(mapped.cliOptions.url, 'http://app.test/');
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('positional URL'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('target.baseUrl'));
});

test('--url maps to target.baseUrl', () => {
  const mapped = mapPtkScanArgs(['--url', 'http://app.test/', '--dry-run']);
  assert.equal(mapped.cliOptions.url, 'http://app.test/');
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--url'));
});

test('--engine DAST enables only DAST in the M1 inline engine config', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--engine', 'DAST', '--dry-run']);
  assert.deepEqual(mapped.requestedEngines, ['dast']);
  assert.deepEqual(mapped.cliOptions.inlineConfig.engines, {
    dast: { enabled: true },
    iast: { enabled: false },
    sast: { enabled: false },
    sca: { enabled: false }
  });
});

test('--engine DAST,IAST,SAST enables all three and engine names are case-insensitive', () => {
  assert.deepEqual(parseEngineList('dast,IAST,Sast'), ['dast', 'iast', 'sast']);
  const mapped = mapPtkScanArgs(['http://app.test', '--engines', 'dast,IAST,SAST', '--dry-run']);
  assert.equal(mapped.cliOptions.inlineConfig.engines.dast.enabled, true);
  assert.equal(mapped.cliOptions.inlineConfig.engines.iast.enabled, true);
  assert.equal(mapped.cliOptions.inlineConfig.engines.sast.enabled, true);
  assert.equal(mapped.cliOptions.inlineConfig.engines.sca.enabled, false);
});

test('unknown engine fails clearly', () => {
  assert.throws(
    () => mapPtkScanArgs(['http://app.test', '--engine', 'DAST,BOGUS']),
    /Unknown engine "BOGUS"/
  );
});

test('--password-env reads env var without putting value in compatibility summary', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--password-env', 'PTK_SCAN_PASSWORD', '--dry-run'], {
    PTK_SCAN_PASSWORD: 'SuperSecret!'
  });
  assert.equal(mapped.cliOptions.password, 'SuperSecret!');
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--password-env'));
  assert.doesNotMatch(JSON.stringify(mapped.compatibilitySummary), /SuperSecret/);
});

test('--username-env reads env var without putting value in compatibility summary', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--username-env', 'PTK_SCAN_USERNAME', '--dry-run'], {
    PTK_SCAN_USERNAME: 'user@example.test'
  });
  assert.equal(mapped.cliOptions.username, 'user@example.test');
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--username-env'));
  assert.doesNotMatch(JSON.stringify(mapped.compatibilitySummary), /user@example/);
});

test('password value is not written to resolved config or compatibility summary', async () => {
  const dir = tmpDir();
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--password-env', 'PTK_SCAN_PASSWORD',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    env: { PTK_SCAN_PASSWORD: 'SuperSecret!' },
    io
  });

  assert.equal(exitCode, 0, chunks.stderr);
  const resolved = fs.readFileSync(path.join(dir, 'resolved-config.json'), 'utf8');
  const compatibility = fs.readFileSync(path.join(dir, 'compatibility-summary.json'), 'utf8');
  assert.doesNotMatch(resolved, /SuperSecret/);
  assert.doesNotMatch(compatibility, /SuperSecret/);
  assert.equal(readJson(path.join(dir, 'resolved-config.json')).profile.password, '[REDACTED]');
});

test('--crawl-pages maps to crawler.maxRoutes and --output-dir maps artifacts.outputDir', async () => {
  const dir = tmpDir();
  const { io } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--crawl-pages', '12',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });
  assert.equal(exitCode, 0);
  const resolved = readJson(path.join(dir, 'resolved-config.json'));
  assert.equal(resolved.crawler.maxRoutes, 12);
  assert.equal(resolved.artifacts.outputDir, dir);
});

test('--crawl-depth maps to crawler.maxDepth', async () => {
  const dir = tmpDir();
  const { io } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--crawl-depth', '4',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0);
  const resolved = readJson(path.join(dir, 'resolved-config.json'));
  const compatibility = readJson(path.join(dir, 'compatibility-summary.json'));
  assert.equal(resolved.crawler.maxDepth, 4);
  assert.ok(compatibility.mappedFlags.includes('--crawl-depth'));
  assert.ok(compatibility.cliOverrides.includes('crawler.maxDepth'));
});

test('route/action/form budget flags map to crawler config', () => {
  const mapped = mapPtkScanArgs([
    'http://app.test',
    '--max-route-ms', '8000',
    '--max-action-ms', '6000',
    '--max-forms-per-route', '2',
    '--max-no-progress-actions', '4',
    '--dry-run'
  ]);

  assert.equal(mapped.cliOptions.maxRouteMs, '8000');
  assert.equal(mapped.cliOptions.maxActionMs, '6000');
  assert.equal(mapped.cliOptions.maxFormsPerRoute, '2');
  assert.equal(mapped.cliOptions.maxNoProgressActions, '4');
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('crawler.maxRouteMs'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('crawler.maxActionMs'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('crawler.maxFormsPerRoute'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('crawler.maxNoProgressActions'));
});

test('--scenario-continue-on-failure maps to scenario config', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--scenario', 'scenario.md', '--scenario-continue-on-failure']);

  assert.equal(mapped.cliOptions.scenarioContinueOnFailure, true);
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('scenario.continueOnFailure'));
});

test('--macro-file maps to macro input and takes non-fatal precedence over --scenario', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--macro-file', 'login.zst', '--macro-format', 'zest']);
  assert.equal(mapped.cliOptions.macroFile, 'login.zst');
  assert.equal(mapped.cliOptions.macroFormat, 'zest');
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('scenario.file'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('scenario.inputType'));
  const combined = mapPtkScanArgs(['http://app.test', '--scenario', 'scenario.md', '--macro-file', 'login.zst']);
  assert.equal(combined.cliOptions.scenario, 'scenario.md');
  assert.equal(combined.cliOptions.macroFile, 'login.zst');
  assert.throws(
    () => mapPtkScanArgs(['http://app.test', '--macro-format', 'zest']),
    /requires --macro-file/
  );
});

test('macro, scenario, and Agent conflict emits notices, writes execution plan, and exits successfully', async () => {
  const dir = tmpDir('ptk-scan-macro-precedence-');
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--scenario', 'scenario.md',
    '--macro-file', 'journey.zst',
    '--agent-mode', 'provider',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0, chunks.stderr);
  assert.match(chunks.stderr, /macro_precedence_scenario_skipped/);
  assert.match(chunks.stderr, /macro_precedence_agent_skipped/);
  assert.match(chunks.stderr, /Effective journey: macro/);

  const plan = readJson(path.join(dir, 'execution-plan.json'));
  assert.equal(plan.effective.journey, 'macro');
  assert.equal(plan.effective.crawlerExecuted, false);
  assert.equal(plan.effective.agentExecuted, false);
  assert.deepEqual(plan.notices.map(notice => notice.code), [
    'macro_precedence_scenario_skipped',
    'macro_precedence_agent_skipped'
  ]);

  const compatibility = readJson(path.join(dir, 'compatibility-summary.json'));
  assert.deepEqual(compatibility.warnings.map(warning => warning.code), [
    'macro_precedence_scenario_skipped',
    'macro_precedence_agent_skipped'
  ]);
});

test('--max-routes overrides config maxRoutes and positional URL overrides config target.baseUrl', async () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'ptk.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    target: {
      baseUrl: 'http://config.test',
      scope: {
        include: ['http://config.test/**'],
        exclude: []
      }
    },
    crawler: {
      maxRoutes: 3
    },
    artifacts: {
      outputDir: path.join(dir, 'from-config')
    }
  }), 'utf8');

  const outputDir = path.join(dir, 'out');
  const { io } = createIo();
  const exitCode = await run([
    'http://cli.test',
    '--config', configPath,
    '--max-routes', '9',
    '--output-dir', outputDir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });
  assert.equal(exitCode, 0);
  const resolved = readJson(path.join(outputDir, 'resolved-config.json'));
  assert.equal(resolved.target.baseUrl, 'http://cli.test');
  assert.deepEqual(resolved.target.scope.include, ['http://cli.test/**']);
  assert.equal(resolved.crawler.maxRoutes, 9);
});

test('--require-ptk-findings-export maps to ptk.requireFindingsExport=true', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--require-ptk-findings-export']);
  assert.equal(mapped.cliOptions.requirePtkFindingsExport, true);
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('ptk.requireFindingsExport'));
});

test('PTK drain flags map to M14 drain config overrides', () => {
  const mapped = mapPtkScanArgs([
    'http://app.test',
    '--ptk-drain-mode', 'until-complete',
    '--ptk-drain-timeout-ms', '1500',
    '--require-ptk-attack-completion'
  ]);
  assert.equal(mapped.cliOptions.ptkDrainMode, 'until-complete');
  assert.equal(mapped.cliOptions.ptkDrainTimeoutMs, '1500');
  assert.equal(mapped.cliOptions.requirePtkAttackCompletion, true);
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('ptk.drainMode'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('ptk.drainTimeoutMs'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('ptk.requireAttackCompletion'));
});

test('immediate analysis flags map to PTK stop analysis config', () => {
  const deferred = mapPtkScanArgs(['http://app.test', '--defer-analysis']);
  assert.equal(deferred.cliOptions.immediateAnalysis, false);
  assert.ok(deferred.compatibilitySummary.mappedFlags.includes('--defer-analysis'));
  assert.ok(deferred.compatibilitySummary.cliOverrides.includes('ptk.immediateAnalysis'));

  const immediate = mapPtkScanArgs(['http://app.test', '--immediate-analysis']);
  assert.equal(immediate.cliOptions.immediateAnalysis, true);
  assert.ok(immediate.compatibilitySummary.mappedFlags.includes('--immediate-analysis'));

  assert.throws(
    () => mapPtkScanArgs(['http://app.test', '--immediate-analysis', '--defer-analysis']),
    /Use either --immediate-analysis or --defer-analysis/
  );
});

test('multiple positional URLs fail clearly', () => {
  assert.throws(
    () => mapPtkScanArgs(['http://one.test', 'http://two.test']),
    /at most one positional URL/
  );
});

test('--browser and headed flags map to browser config overrides', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--browser', 'edge', '--headed', '--browser-launch-timeout-ms', '60000']);
  assert.equal(mapped.cliOptions.browser, 'edge');
  assert.equal(mapped.cliOptions.headless, false);
  assert.equal(mapped.cliOptions.browserLaunchTimeoutMs, '60000');
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('browser.name'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('browser.headless'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('browser.launchTimeoutMs'));
});

test('--verbose enables full JSON result output for ptk-scan', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--verbose']);
  assert.equal(mapped.cliOptions.verbose, true);
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--verbose'));
});

test('--format, --output, and --fail-on map to ptk-scan report settings', () => {
  const mapped = mapPtkScanArgs([
    'http://app.test',
    '--format', 'sarif',
    '--output', 'ptk-results.sarif',
    '--fail-on', 'high',
    '--dry-run'
  ]);

  assert.equal(mapped.cliOptions.format, 'sarif');
  assert.equal(mapped.cliOptions.output, 'ptk-results.sarif');
  assert.equal(mapped.cliOptions.failOn, 'high');
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--format'));
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--output'));
  assert.ok(mapped.compatibilitySummary.mappedFlags.includes('--fail-on'));
});

test('invalid report format and fail-on values fail clearly', () => {
  assert.throws(
    () => mapPtkScanArgs(['http://app.test', '--format', 'xml']),
    /--format must be one of/
  );
  assert.throws(
    () => mapPtkScanArgs(['http://app.test', '--fail-on', 'warning']),
    /--fail-on must be one of/
  );
});

test('ptk-scan dry-run prints concise CLI summary by default', async () => {
  const dir = tmpDir();
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0);
  assert.match(chunks.stdout, /PTK scan dry-run\./);
  assert.match(chunks.stdout, /Use --verbose for full JSON output\./);
  assert.doesNotMatch(chunks.stdout, /"config":/);
});

test('ptk-scan --verbose preserves full JSON output', async () => {
  const dir = tmpDir();
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--output-dir', dir,
    '--dry-run',
    '--verbose'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0);
  assert.match(chunks.stdout, /"status": "dry-run"/);
  assert.match(chunks.stdout, /"config":/);
});

test('ptk-scan --format sarif writes a SARIF report before exiting', async () => {
  const dir = tmpDir();
  const sarifPath = path.join(dir, 'ptk-results.sarif');
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--output-dir', dir,
    '--format', 'sarif',
    '--output', sarifPath,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0, chunks.stderr);
  const sarif = readJson(sarifPath);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.name, 'OWASP PTK');
});

test('ptk-scan --fail-on writes threshold artifact', async () => {
  const dir = tmpDir();
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--output-dir', dir,
    '--fail-on', 'high',
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });

  assert.equal(exitCode, 0, chunks.stderr);
  const threshold = readJson(path.join(dir, 'finding-threshold.json'));
  assert.equal(threshold.ok, true);
  assert.equal(threshold.failOn, 'high');
  assert.equal(threshold.findingCount, 0);
});

test('ptk-scan writes SARIF before fail-on threshold returns non-zero', async () => {
  const dir = tmpDir();
  const sarifPath = path.join(dir, 'ptk-results.sarif');
  const { io, chunks } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--output-dir', dir,
    '--format', 'sarif',
    '--output', sarifPath,
    '--fail-on', 'high'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io,
    runPtkAgent: async () => ({
      ok: true,
      status: 'completed',
      config: {
        target: { baseUrl: 'http://app.test' },
        artifacts: { outputDir: dir },
        engines: {
          dast: { enabled: true },
          iast: { enabled: false },
          sast: { enabled: false },
          sca: { enabled: false }
        }
      },
      coverage: {
        ptk: {
          findings: [
            {
              engine: 'DAST',
              ruleId: 'xss-reflected',
              title: 'Reflected XSS',
              severity: 'high',
              url: 'http://app.test/search?q=x'
            }
          ]
        }
      },
      artifacts: {}
    })
  });

  assert.equal(exitCode, 70);
  assert.match(chunks.stderr, /fail-on threshold triggered/);
  assert.equal(readJson(sarifPath).runs[0].results.length, 1);
  const threshold = readJson(path.join(dir, 'finding-threshold.json'));
  assert.equal(threshold.failed, true);
  assert.equal(threshold.failingCount, 1);
});

test('--crawl-data, --profile-file, and --persona map to profile config', () => {
  const mapped = mapPtkScanArgs(['http://app.test', '--crawl-data', 'data.json', '--persona', 'buyer']);
  assert.equal(mapped.cliOptions.crawlData, 'data.json');
  assert.equal(mapped.cliOptions.persona, 'buyer');
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('profile.file'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('profile.activePersonaId'));

  const profileFile = mapPtkScanArgs(['http://app.test', '--profile-file', 'profile.json']);
  assert.equal(profileFile.cliOptions.profileFile, 'profile.json');
});

test('--memory-mode, --memory-storage, and --memory-reset map to memory config', () => {
  const mapped = mapPtkScanArgs([
    'http://app.test',
    '--memory-mode', 'read-write',
    '--memory-storage', '.ptk/memory',
    '--memory-reset'
  ]);

  assert.equal(mapped.cliOptions.memoryMode, 'read-write');
  assert.equal(mapped.cliOptions.memoryStorage, '.ptk/memory');
  assert.equal(mapped.cliOptions.memoryReset, true);
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('memory.mode'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('memory.storageDir'));
  assert.ok(mapped.compatibilitySummary.cliOverrides.includes('memory.reset'));
});

test('unknown flag fails, not ignored', () => {
  const result = spawnSync(process.execPath, [binPath, 'http://app.test', '--totally-unknown'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option --totally-unknown/);
});

test('compatibility-summary.json and engine-summary.json are produced', async () => {
  const dir = tmpDir();
  const { io } = createIo();
  const exitCode = await run([
    'http://app.test',
    '--engine', 'DAST,IAST,SAST',
    '--output-dir', dir,
    '--dry-run'
  ], {
    cliName: 'ptk-scan',
    cwd: repoRoot,
    io
  });
  assert.equal(exitCode, 0);

  const compatibility = readJson(path.join(dir, 'compatibility-summary.json'));
  const engineSummary = readJson(path.join(dir, 'engine-summary.json'));
  assert.equal(compatibility.wrapper, 'ptk-scan');
  assert.deepEqual(engineSummary.requestedEngines, ['DAST', 'IAST', 'SAST']);
  assert.deepEqual(engineSummary.enabled, {
    dast: true,
    iast: true,
    sast: true,
    sca: false
  });
});
