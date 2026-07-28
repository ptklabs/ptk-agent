'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ptkAttackCompletionIncomplete, runPtkAgent, serializeRunError } = require('../../../src/core/runner.cjs');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('runner resolves modules during normal run setup and writes M3 artifacts', async () => {
  const outputDir = tmpDir('ptk-agent-runner-modules-');
  const result = await runPtkAgent({
    url: 'http://app.test',
    dryRun: true,
    outputDir,
    env: { PTK_PORTAL_TOKEN: 'secret-token' },
    throwOnError: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.moduleResolution.ok, true);
  assert.ok(result.artifacts.moduleResolution);
  assert.ok(result.artifacts.engineSummary);

  const moduleResolution = readJson(result.artifacts.moduleResolution);
  const engineSummary = readJson(result.artifacts.engineSummary);
  const artifactText = fs.readFileSync(result.artifacts.moduleResolution, 'utf8');

  assert.equal(moduleResolution.ok, true);
  assert.ok(moduleResolution.modules.length > 0);
  assert.equal(result.moduleResolution.moduleOptions.portal.tokenEnv, 'PTK_PORTAL_TOKEN');
  assert.equal(result.moduleResolution.moduleOptions.portal.tokenPresent, true);
  assert.equal(moduleResolution.moduleOptions.portal.tokenEnv, '[REDACTED]');
  assert.equal(moduleResolution.moduleOptions.portal.tokenPresent, '[REDACTED]');
  assert.ok(!artifactText.includes('secret-token'));
  assert.equal(engineSummary.modules.ok, true);
});

test('runner fails clearly when Pro modules are requested without download support', async () => {
  const outputDir = tmpDir('ptk-agent-runner-pro-fail-');
  const result = await runPtkAgent({
    url: 'http://app.test',
    dryRun: true,
    outputDir,
    inlineConfig: {
      modules: {
        packs: ['pro'],
        allowNetworkDownloads: false
      },
      engines: {
        dast: { enabled: true, modulePacks: ['pro'] }
      }
    },
    throwOnError: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'ERR_PTK_MODULE_RESOLUTION');
  assert.ok(result.artifacts.moduleResolution);
  const resolution = readJson(result.artifacts.moduleResolution);
  assert.equal(resolution.ok, false);
  assert.match(resolution.errors[0], /Module pack "pro" is unavailable/);
});

test('runner serializes browser launch errors with actionable install hint', async () => {
  const outputDir = tmpDir('ptk-agent-runner-browser-missing-');
  const browserError = new Error([
    "browserType.launchPersistentContext: Executable doesn't exist at /tmp/ms-playwright/chromium-1223/chrome",
    'Looks like Playwright was just installed or updated.',
    'Please run the following command to download new browsers:',
    '    npx playwright install'
  ].join('\n'));
  const result = await runPtkAgent({
    url: 'http://app.test',
    outputDir,
    throwOnError: false,
    handlers: {
      crawl: async () => {
        throw browserError;
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.name, 'Error');
  assert.match(result.error.message, /Executable doesn't exist/);
  assert.equal(result.error.category, 'browser_install_missing');
  assert.match(result.error.hint, /npx playwright install chromium/);
  assert.equal(result.error.command, 'npx playwright install chromium');
  assert.match(JSON.stringify(result), /Executable doesn't exist/);
  assert.match(result.telemetry.errors[0].message, /Executable doesn't exist/);
});

test('serializeRunError preserves generic message and code without default stack noise', () => {
  const error = new Error('generic failure');
  error.code = 'ERR_GENERIC';
  const serialized = serializeRunError(error);

  assert.deepEqual(serialized, {
    name: 'Error',
    message: 'generic failure',
    code: 'ERR_GENERIC'
  });
});

test('runner classifies browser launch timeout with startup budget hint', () => {
  const error = new Error('browserType.launchPersistentContext: Timeout 10000ms exceeded.');
  const serialized = serializeRunError(error, {
    config: {
      browser: {
        launchTimeoutMs: 10000
      }
    }
  });

  assert.equal(serialized.category, 'browser_launch_timeout');
  assert.match(serialized.summary, /10000ms/);
  assert.match(serialized.hint, /--browser-launch-timeout-ms 60000/);
});

test('runner fails when PTK attack completion is required but engine work is partial', async () => {
  const outputDir = tmpDir('ptk-agent-runner-attack-partial-');
  const result = await runPtkAgent({
    url: 'http://app.test',
    outputDir,
    requirePtkBridge: true,
    requirePtkFindingsExport: true,
    requirePtkAttackCompletion: true,
    throwOnError: false,
    handlers: {
      crawl: async () => ({
        status: 'completed',
        coverage: {
          routes: [],
          endpoints: [],
          forms: [],
          actions: [],
          ptk: {
            available: true,
            exported: true,
            collected: true,
            bridge: { available: true, source: 'PTK_AGENT' },
            validity: {
              valid: true,
              status: 'valid',
              hasPtkBridge: true,
              hasFindingsExport: true,
              findingsCount: 1,
              reason: 'exported'
            },
            lifecycle: {
              attackCompletion: {
                available: true,
                partial: true,
                engines: {
                  DAST: {
                    planned: 10,
                    completed: 4,
                    cancelled: 6,
                    partial: true
                  }
                }
              }
            },
            findings: { count: 1 }
          }
        }
      })
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_ptk_attack_incomplete');
});

test('runner attack completion gate accepts zero-remaining post-stop engine progress', () => {
  assert.equal(ptkAttackCompletionIncomplete({
    lifecycle: {
      attackCompletion: {
        available: true,
        partial: false,
        engines: {
          DAST: {
            planned: 5514,
            completed: 3775,
            remaining: 0,
            cancelled: 0,
            partial: false
          }
        }
      }
    }
  }), false);
});
