'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { prepareActionSmokeInput } = require('../../../../scripts/prepare-action-smoke-input.cjs');
const { assertActionSmoke } = require('../../../../scripts/assert-action-smoke.cjs');

function temporaryDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-action-support-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createInstalledPackage(root, options = {}) {
  const packageRoot = path.join(root, 'installed', 'pentestkit');
  const extensionRoot = path.join(packageRoot, 'extensions');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'pentestkit', version: '9.9.8' }));
  const sources = {
    chromeZip: ['ptk-latest.zip', Buffer.from('chromium zip')],
    firefoxZip: ['ptk-latest-firefox.zip', Buffer.from('firefox zip')],
    crx: ['ptk-latest.crx', Buffer.from('signed crx')],
    xpi: ['ptk-latest.xpi', Buffer.from('signed xpi')]
  };
  const artifacts = {};
  const destinationNames = {
    chromeZip: 'chrome_9.9.8.1_automation.zip',
    firefoxZip: 'firefox_9.9.8_automation.zip',
    crx: 'ptk-latest-automation.crx',
    xpi: 'ptk-latest-automation.xpi'
  };
  for (const [key, [name, bytes]] of Object.entries(sources)) {
    fs.writeFileSync(path.join(extensionRoot, name), bytes);
    artifacts[key] = { path: destinationNames[key], sha256: hash(bytes), bytes: bytes.length };
  }
  if (options.invalidHash) artifacts.chromeZip.sha256 = '0'.repeat(64);
  const automationArtifactProvenance = {
    schemaVersion: 'ptk-extension-artifact-provenance-v1',
    buildMode: 'automation-artifact',
    automationEnabledDefault: true,
    extensionVersion: '9.9.8.1',
    manifests: {
      chromium: { version: '9.9.8.1' },
      firefox: { version: '9.9.8' }
    },
    artifacts
  };
  fs.writeFileSync(path.join(extensionRoot, 'extension-provenance.json'), JSON.stringify({
    automationEnabledDefault: true,
    extensionVersion: '9.9.8.1',
    manifests: {
      chromium: { version: '9.9.8.1' },
      firefox: { version: '9.9.8' }
    },
    automationArtifactProvenance
  }));
  return packageRoot;
}

test('reconstructs verified four-artifact build input from an installed release', t => {
  const repository = temporaryDirectory(t);
  const packageRoot = createInstalledPackage(repository);
  const output = path.join(repository, '.release', 'input');
  const result = prepareActionSmokeInput(packageRoot, output, { repositoryRoot: repository });
  assert.equal(result.packageVersion, '9.9.8');
  assert.equal(result.chromiumExtensionVersion, '9.9.8.1');
  assert.equal(result.firefoxExtensionVersion, '9.9.8');
  assert.deepEqual(result.artifacts.sort(), [
    'chrome_9.9.8.1_automation.zip',
    'firefox_9.9.8_automation.zip',
    'ptk-latest-automation.crx',
    'ptk-latest-automation.xpi'
  ].sort());
  for (const file of [...result.artifacts, 'extension-provenance-automation.json']) {
    assert.ok(fs.statSync(path.join(output, file)).isFile(), `${file} was not reconstructed`);
  }
});

test('rejects released artifacts that do not match embedded provenance', t => {
  const repository = temporaryDirectory(t);
  const packageRoot = createInstalledPackage(repository, { invalidHash: true });
  assert.throws(
    () => prepareActionSmokeInput(packageRoot, path.join(repository, '.release', 'input'), { repositoryRoot: repository }),
    /SHA-256 does not match/
  );
});

test('rejects destructive action-input output locations', t => {
  const repository = temporaryDirectory(t);
  const packageRoot = createInstalledPackage(repository);
  assert.throws(
    () => prepareActionSmokeInput(packageRoot, repository, { repositoryRoot: repository }),
    /must not be the repository root/
  );
});

test('asserts all four engines, PTK lifecycle, and parseable SARIF', t => {
  const root = temporaryDirectory(t);
  const output = path.join(root, 'artifacts');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'engine-summary.json'), JSON.stringify({
    requestedEngines: ['DAST', 'IAST', 'SAST', 'SCA'],
    enabled: { dast: true, iast: true, sast: true, sca: true },
    ptkLifecycle: { engineSelectionAppliedToPtk: true }
  }));
  fs.writeFileSync(path.join(output, 'ptk-lifecycle-normalized.json'), JSON.stringify({
    bridgeDetected: true,
    scanStarted: true,
    scanStopped: true,
    exportSucceeded: true,
    safeToStop: true
  }));
  const sarif = path.join(root, 'ptk.sarif');
  fs.writeFileSync(sarif, JSON.stringify({ version: '2.1.0', runs: [] }));
  const result = assertActionSmoke(output, sarif);
  assert.equal(result.sarifRuns, 0);
  assert.deepEqual(result.requestedEngines.sort(), ['DAST', 'IAST', 'SAST', 'SCA'].sort());
});
