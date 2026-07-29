'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  documentationAudienceFindings,
  secretFindings,
  suspiciousFileReason
} = require('../../../../scripts/audit-repository.cjs');

test('repository audit rejects secret files and generated browser-extension archives', () => {
  assert.equal(suspiciousFileReason('.env'), 'environment secret file');
  assert.equal(suspiciousFileReason('examples/Untitled-1.sh'), 'unreviewed scratch or duplicate file');
  assert.equal(suspiciousFileReason('examples/basic_scan_copy.py'), 'unreviewed scratch or duplicate file');
  assert.equal(suspiciousFileReason('keys/extension.pem'), 'secret or generated artifact');
  assert.equal(suspiciousFileReason('release/ptk.xpi'), 'secret or generated artifact');
  assert.equal(suspiciousFileReason('docs/npm/providers.md'), null);
});

test('repository audit detects credential material but permits placeholders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-repository-audit-'));
  const bad = path.join(root, 'bad.txt');
  const placeholder = path.join(root, 'placeholder.md');
  fs.writeFileSync(bad, `token=${'npm_' + 'abcdefghijklmnopqrstuvwxyz123456'}\n`);
  fs.writeFileSync(placeholder, 'token=${NPM_TOKEN}\n');
  assert.match(secretFindings(bad, 'bad.txt')[0], /npm token/);
  assert.deepEqual(secretFindings(placeholder, 'placeholder.md'), []);
});

test('repository audit rejects developer-specific absolute home paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-repository-audit-home-'));
  const bad = path.join(root, 'example.md');
  fs.writeFileSync(bad, `Use ${'/Users' + '/example/private-profile'} for this test.\n`);
  assert.match(secretFindings(bad, 'example.md')[0], /developer-specific home path/);
});

test('repository documentation audit rejects internal operations and wrong package identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-doc-audit-'));
  const bad = path.join(root, 'bad.md');
  const good = path.join(root, 'good.md');
  fs.writeFileSync(bad, 'Install @ptklabs/agent, then do not commit the CRX private key.\n', 'utf8');
  fs.writeFileSync(good, 'Install pentestkit. Restrict scan evidence access and apply a retention policy.\n', 'utf8');
  assert.ok(documentationAudienceFindings(bad, 'docs/bad.md').length >= 3);
  assert.deepEqual(documentationAudienceFindings(good, 'docs/good.md'), []);
  fs.rmSync(root, { recursive: true, force: true });
});
