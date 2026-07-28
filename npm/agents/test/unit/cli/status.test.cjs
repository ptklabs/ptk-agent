'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { printRunResult } = require('../../../src/cli/status.cjs');

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

test('printRunResult prints concise failed scan message by default', () => {
  const { io, chunks } = createIo();
  printRunResult({ io }, {
    ok: false,
    status: 'failed',
    error: {
      name: 'Error',
      message: 'browserType.launchPersistentContext: Executable does not exist\nlarge Playwright banner',
      category: 'browser_install_missing',
      summary: 'Playwright chromium browser binaries are not installed.',
      hint: 'Run "npx playwright install chromium" in the project where pentestkit is installed, then retry the scan.',
      command: 'npx playwright install chromium'
    },
    config: {
      artifacts: {
        outputDir: '.ptk/artifacts'
      }
    }
  });

  assert.equal(chunks.stdout, '');
  assert.match(chunks.stderr, /PTK scan failed \(failed\)\./);
  assert.match(chunks.stderr, /Reason: Playwright chromium browser binaries are not installed\./);
  assert.match(chunks.stderr, /Category: browser_install_missing/);
  assert.match(chunks.stderr, /Fix: Run "npx playwright install chromium"/);
  assert.match(chunks.stderr, /Artifacts: \.ptk\/artifacts/);
  assert.match(chunks.stderr, /Use --verbose for full JSON output\./);
  assert.doesNotMatch(chunks.stderr, /large Playwright banner/);
});

test('printRunResult uses scenario failure reason when no thrown error exists', () => {
  const { io, chunks } = createIo();
  printRunResult({ io }, {
    ok: false,
    status: 'scenario_failed',
    error: null,
    coverage: {
      scenario: {
        status: 'failed',
        ok: false,
        failedStep: 'login-with-provided-credentials',
        failureReason: 'target_rejected_credentials'
      }
    },
    config: {
      artifacts: {
        outputDir: '.ptk/artifacts'
      }
    }
  });

  assert.equal(chunks.stdout, '');
  assert.match(chunks.stderr, /PTK scan failed \(scenario_failed\)\./);
  assert.match(chunks.stderr, /Reason: target_rejected_credentials/);
  assert.match(chunks.stderr, /Scenario step: login-with-provided-credentials/);
  assert.doesNotMatch(chunks.stderr, /Unknown error/);
});

test('printRunResult uses PTK validity reason when strict PTK export fails without thrown error', () => {
  const { io, chunks } = createIo();
  printRunResult({ io }, {
    ok: false,
    status: 'invalid_no_ptk_bridge',
    error: null,
    coverage: {
      ptk: {
        validity: {
          valid: false,
          status: 'invalid_no_ptk_bridge',
          reason: 'detect_failed:PTK bridge detection exceeded 30000ms budget'
        }
      }
    },
    config: {
      artifacts: {
        outputDir: '.ptk/artifacts'
      }
    }
  });

  assert.equal(chunks.stdout, '');
  assert.match(chunks.stderr, /PTK scan failed \(invalid_no_ptk_bridge\)\./);
  assert.match(chunks.stderr, /Reason: detect_failed:PTK bridge detection exceeded 30000ms budget/);
  assert.doesNotMatch(chunks.stderr, /Unknown error/);
});

test('printRunResult prints full JSON when verbose is requested', () => {
  const { io, chunks } = createIo();
  printRunResult({ io }, {
    ok: false,
    status: 'failed',
    error: {
      message: 'full error details'
    }
  }, {
    verbose: true
  });

  assert.equal(chunks.stderr, '');
  assert.match(chunks.stdout, /"status": "failed"/);
  assert.match(chunks.stdout, /"message": "full error details"/);
});

test('printRunResult prints concise success summary by default', () => {
  const { io, chunks } = createIo();
  printRunResult({ io }, {
    ok: true,
    status: 'completed',
    telemetry: {
      routeCount: 3,
      endpointCount: 4,
      formCount: 1,
      findingsCount: 2,
      errorCount: 0
    },
    config: {
      artifacts: {
        outputDir: '.ptk/artifacts'
      }
    }
  });

  assert.equal(chunks.stderr, '');
  assert.match(chunks.stdout, /PTK scan completed\./);
  assert.match(chunks.stdout, /Routes: 3 \| Endpoints: 4 \| Forms: 1 \| Findings: 2 \| Errors: 0/);
  assert.match(chunks.stdout, /Artifacts: \.ptk\/artifacts/);
});
