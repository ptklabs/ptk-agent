'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const baseline = require('../../fixtures/pentestkit-9.9.7-public-surface.json');
const {
  NPM_PUBLIC_REPOSITORY_URL,
  writePackageJson
} = require('../../../../scripts/prepare-npm-package.cjs');

const PROVIDER_EXPORTS = [
  './providers/testmu',
  './providers/browserstack',
  './providers/browserbase',
  './providers/browserless',
  './providers/steel'
];

test('publishable 9.9.8 manifest preserves the published 9.9.7 surface and adds providers', () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-published-parity-'));
  writePackageJson(stageRoot, '9.9.8', { publishable: true });
  const candidate = JSON.parse(fs.readFileSync(path.join(stageRoot, 'package.json'), 'utf8'));

  assert.equal(candidate.name, baseline.name);
  assert.equal(candidate.version, '9.9.8');
  assert.equal(candidate.main, baseline.main);
  for (const exportName of baseline.exports) {
    assert.ok(Object.hasOwn(candidate.exports, exportName), `missing 9.9.7 export ${exportName}`);
  }
  for (const binName of baseline.bin) {
    assert.ok(Object.hasOwn(candidate.bin, binName), `missing 9.9.7 bin ${binName}`);
  }
  for (const dependencyName of baseline.dependencies) {
    assert.ok(Object.hasOwn(candidate.dependencies, dependencyName), `missing 9.9.7 dependency ${dependencyName}`);
  }
  assert.equal(candidate.engines.node, baseline.nodeEngine);

  for (const exportName of PROVIDER_EXPORTS) {
    assert.ok(Object.hasOwn(candidate.exports, exportName), `missing provider export ${exportName}`);
  }
  assert.equal(candidate.peerDependencies['@testmuai/testmu-cloud'], '>=1.0.1 <2.0.0');
  assert.equal(candidate.peerDependencies['@testmuai/browser-cloud'], '>=1.0.0 <2.0.0');
  assert.equal(candidate.peerDependencies['steel-sdk'], '>=0.18.0 <1.0.0');
  assert.equal(candidate.peerDependenciesMeta['@testmuai/testmu-cloud'].optional, true);
  assert.equal(candidate.peerDependenciesMeta['@testmuai/browser-cloud'].optional, true);
  assert.equal(candidate.peerDependenciesMeta['steel-sdk'].optional, true);
  assert.equal(candidate.license, 'AGPL-3.0-only');
  assert.equal(candidate.author.name, 'Denis Podgurskii');
  assert.equal(candidate.contributors[0].name, 'PTK Labs');
  assert.equal(candidate.repository.url, `git+${NPM_PUBLIC_REPOSITORY_URL}.git`);
  assert.equal(candidate.repository.directory, 'npm');
  assert.equal(candidate.homepage, `${NPM_PUBLIC_REPOSITORY_URL}#readme`);
  assert.equal(candidate.bugs.url, `${NPM_PUBLIC_REPOSITORY_URL}/issues`);
  assert.deepEqual(candidate.publishConfig, {
    access: 'public',
    provenance: true
  });
});
