'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  findBundledExtensionPath,
  resolvePtkExtensionPath
} = require('../../../src/browser/extensionResolver.cjs');

function writeExtension(dir, version = '1.2.3') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'OWASP PTK',
    version,
    background: { service_worker: 'app.js' }
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'app.js'), 'globalThis.PTK_AGENT = {};', 'utf8');
}

function writeAutomationExtension(dir, version = '1.2.3') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'OWASP Penetration Testing Kit Automation',
    short_name: 'PTK Auto',
    description: 'OWASP Penetration Testing Kit Automation',
    version,
    background: { service_worker: 'app_automation.js' }
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'app_automation.js'), 'globalThis.ptk_app = {};', 'utf8');
}

test('bundled extension resolves relative to installed package root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-bundled-extension-'));
  const bundled = path.join(root, 'extensions', 'chromium-unpacked');
  writeExtension(bundled);
  fs.writeFileSync(path.join(root, 'extensions', 'extension-provenance.json'), JSON.stringify({
    schemaVersion: 'ptk-extension-provenance-v1',
    packageName: 'pentestkit',
    packageVersion: '1.2.3'
  }), 'utf8');

  assert.equal(findBundledExtensionPath({ packageRoot: root }), fs.realpathSync(bundled));
  const result = resolvePtkExtensionPath({
    packageRoot: root,
    env: {},
    autoDetectExtension: false,
    cwd: root
  });

  assert.equal(result.source, 'bundled-package');
  assert.equal(result.path, fs.realpathSync(bundled));
  assert.equal(result.extensionVersion, '1.2.3');
  assert.equal(result.provenance.packageName, 'pentestkit');
});

test('bundled automation extension resolves without legacy app.js', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-bundled-automation-extension-'));
  const bundled = path.join(root, 'extensions', 'chromium-unpacked');
  writeAutomationExtension(bundled, '2.3.4');

  assert.equal(findBundledExtensionPath({ packageRoot: root }), fs.realpathSync(bundled));
});

test('explicit and env extension paths override bundled extension', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-extension-priority-'));
  const bundled = path.join(root, 'extensions', 'chromium-unpacked');
  const explicit = path.join(root, 'explicit');
  const envDir = path.join(root, 'env');
  writeExtension(bundled, '1.0.0');
  writeExtension(explicit, '2.0.0');
  writeExtension(envDir, '3.0.0');

  const explicitResult = resolvePtkExtensionPath({
    packageRoot: root,
    configuredPath: explicit,
    env: { PTK_EXTENSION_DIR: envDir },
    cwd: root
  });
  assert.equal(explicitResult.source, 'explicit');
  assert.equal(explicitResult.path, fs.realpathSync(explicit));
  assert.equal(explicitResult.extensionVersion, '2.0.0');

  const envResult = resolvePtkExtensionPath({
    packageRoot: root,
    env: { PTK_EXTENSION_DIR: envDir },
    cwd: root
  });
  assert.equal(envResult.source, 'env:PTK_EXTENSION_DIR');
  assert.equal(envResult.path, fs.realpathSync(envDir));
  assert.equal(envResult.extensionVersion, '3.0.0');
});

test('local-dev extension is last fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-local-dev-extension-'));
  const sourceExtension = path.join(root, 'pentestkit', 'src');
  writeExtension(sourceExtension, '4.0.0');

  const result = resolvePtkExtensionPath({
    packageRoot: path.join(root, 'missing-package-root'),
    env: {},
    cwd: root,
    autoDetectExtension: true
  });

  assert.equal(result.source, 'local-dev');
  assert.equal(result.path, fs.realpathSync(sourceExtension));
});

test('local-dev fallback is disabled for installed package unless explicitly allowed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-local-dev-installed-'));
  const sourceExtension = path.join(root, 'pentestkit', 'src');
  writeExtension(sourceExtension, '4.0.0');

  const denied = resolvePtkExtensionPath({
    packageRoot: path.join(root, 'node_modules', 'pentestkit'),
    env: {},
    cwd: root,
    autoDetectExtension: true
  });
  assert.equal(denied.source, 'none');

  const allowed = resolvePtkExtensionPath({
    packageRoot: path.join(root, 'node_modules', 'pentestkit'),
    env: { PTK_ALLOW_LOCAL_DEV_EXTENSION: '1' },
    cwd: root,
    autoDetectExtension: true
  });
  assert.equal(allowed.source, 'local-dev');
  assert.equal(allowed.path, fs.realpathSync(sourceExtension));
});
