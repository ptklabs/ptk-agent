'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  validateReleaseIntent,
  verifyRegistryAvailability
} = require('../../../../scripts/verify-release-intent.cjs');

const provenanceSha256 = 'a'.repeat(64);

test('next release intent requires a matching extension tag and prerelease package version', () => {
  assert.deepEqual(validateReleaseIntent({
    extensionTag: '9.9.8',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8-rc.1',
    distTag: 'next',
    provenanceSha256
  }), {
    extensionTag: '9.9.8',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8-rc.1',
    distTag: 'next',
    provenanceSha256
  });
  assert.throws(() => validateReleaseIntent({
    extensionTag: '9.9.8',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8',
    distTag: 'next',
    provenanceSha256
  }), /requires a prerelease/);
});

test('latest release intent requires an exact final version match', () => {
  assert.equal(validateReleaseIntent({
    extensionTag: 'v9.9.8',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8',
    distTag: 'latest',
    provenanceSha256
  }).distTag, 'latest');
  assert.throws(() => validateReleaseIntent({
    extensionTag: '9.9.7',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8',
    distTag: 'latest',
    provenanceSha256
  }), /extension-tag/);
  assert.throws(() => validateReleaseIntent({
    extensionTag: '9.9.8',
    extensionVersion: '9.9.8',
    packageVersion: '9.9.8-rc.1',
    distTag: 'latest',
    provenanceSha256
  }), /final package version/);
});

test('registry gate checks the complete published version list without npm identity assumptions', () => {
  const npmRunner = (_command, args) => {
    assert.deepEqual(args, ['view', 'pentestkit', 'versions', '--json']);
    return {
      status: 0,
      stdout: JSON.stringify(['9.9.6', '9.9.7']),
      stderr: ''
    };
  };
  assert.deepEqual(verifyRegistryAvailability('9.9.8-rc.1', { npmRunner }), {
    packageName: 'pentestkit',
    packageVersion: '9.9.8-rc.1',
    versionAvailable: true,
    maximumPublishedCore: '9.9.7'
  });
});

test('registry gate rejects an existing or regressed version', () => {
  const existingRunner = () => ({
    status: 0,
    stdout: JSON.stringify(['9.9.7', '9.9.8-rc.1']),
    stderr: ''
  });
  assert.throws(
    () => verifyRegistryAvailability('9.9.8-rc.1', { npmRunner: existingRunner }),
    /already exists/
  );
  const regressionRunner = () => ({
    status: 0,
    stdout: JSON.stringify(['9.9.7']),
    stderr: ''
  });
  assert.throws(
    () => verifyRegistryAvailability('9.9.6', { npmRunner: regressionRunner }),
    /lower than the published core/
  );
});
