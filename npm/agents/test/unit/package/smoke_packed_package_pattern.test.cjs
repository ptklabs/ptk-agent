'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  expandTarballArg,
  isForbiddenTarballPath,
  matchesAsteriskPattern
} = require('../../../../scripts/smoke-packed-package.cjs');

test('tarball filter allows the canonical signed XPI and rejects legacy duplicate names', () => {
  assert.equal(isForbiddenTarballPath('package/extensions/ptk-latest.xpi'), false);
  assert.equal(isForbiddenTarballPath('package/extensions/ptk-latest-firefox.xpi'), true);
  assert.equal(isForbiddenTarballPath('package/extensions/ptk-latest-chromium.crx'), true);
});

test('tarball wildcard matcher treats regular-expression syntax as literal text', () => {
  assert.equal(matchesAsteriskPattern('pentestkit-[release](v1)+?.tgz', 'pentestkit-[release](v1)+?.tgz'), true);
  assert.equal(matchesAsteriskPattern('pentestkit-releasev11.tgz', 'pentestkit-[release](v1)+?.tgz'), false);
  assert.equal(matchesAsteriskPattern('pentestkit-a.b[1].tgz', 'pentestkit-*.b[1].tgz'), true);
  assert.equal(matchesAsteriskPattern('pentestkit-aXb1.tgz', 'pentestkit-*.b[1].tgz'), false);
});

test('tarball wildcard expansion supports multiple asterisks without constructing a RegExp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-package-pattern-'));
  try {
    const expected = path.join(root, 'pentestkit-[release](v1)+?.9.9.8.tgz');
    const decoy = path.join(root, 'pentestkit-releasev11.9.9.8.tgz');
    fs.writeFileSync(expected, 'expected');
    fs.writeFileSync(decoy, 'decoy');
    const selected = expandTarballArg(path.join(root, 'pentestkit-[release](v1)+?.*.tgz'));
    assert.equal(selected, expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
