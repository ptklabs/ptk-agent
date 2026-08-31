'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { secretFindings } = require('./audit-repository.cjs');

test('repository audit permits only the known credential inside the local macro release fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-audit-fixture-'));
  const file = path.join(dir, 'fixture.json');
  try {
    const email = ['ptk', 'test.com'].join('@');
    const password = ['P', 'ssword'].join('@');
    fs.writeFileSync(file, JSON.stringify({ email, password }));
    assert.deepEqual(secretFindings(file, 'npm/agents/test/fixtures/macro/juice-shop/recordings/fixture.json'), []);
    assert.equal(secretFindings(file, 'npm/agents/test/unit/fixture.json').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local macro fixture exception does not permit unrelated token patterns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-audit-token-'));
  const file = path.join(dir, 'fixture.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ token: `ghp_${'A'.repeat(20)}` }));
    const findings = secretFindings(file, 'npm/agents/test/fixtures/macro/juice-shop/recordings/fixture.json');
    assert.equal(findings.some(finding => finding.startsWith('GitHub token')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
