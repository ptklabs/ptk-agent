'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../../../src/cli/commands/scan.cjs');

function createIo() {
  const chunks = { stdout: '', stderr: '' };
  return {
    chunks,
    io: {
      stdout: { write: value => { chunks.stdout += String(value); } },
      stderr: { write: value => { chunks.stderr += String(value); } }
    }
  };
}

test('ptk-agent scan reports macro precedence and continues successfully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-scan-precedence-'));
  const configPath = path.join(dir, 'ptk.config.json');
  const outputDir = path.join(dir, 'artifacts');
  fs.writeFileSync(configPath, JSON.stringify({
    target: {
      baseUrl: 'http://app.test',
      scope: { include: ['http://app.test/**'], exclude: [] }
    },
    artifacts: { outputDir }
  }), 'utf8');
  const { io, chunks } = createIo();

  const exitCode = await run([
    '--config', configPath,
    '--scenario', 'scenario.md',
    '--macro-file', 'journey.zst',
    '--agent-mode', 'provider',
    '--dry-run'
  ], {
    cliName: 'ptk-agent',
    cwd: path.resolve(__dirname, '../../..'),
    env: process.env,
    io
  });

  assert.equal(exitCode, 0, chunks.stderr);
  assert.match(chunks.stderr, /macro_precedence_scenario_skipped/);
  assert.match(chunks.stderr, /macro_precedence_agent_skipped/);
  assert.match(chunks.stderr, /Effective journey: macro/);
  const plan = JSON.parse(fs.readFileSync(path.join(outputDir, 'execution-plan.json'), 'utf8'));
  assert.equal(plan.effective.journey, 'macro');
  assert.equal(plan.effective.crawlerExecuted, false);
  assert.equal(plan.effective.agentExecuted, false);
});
