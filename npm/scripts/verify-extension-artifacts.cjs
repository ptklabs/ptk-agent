#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractZipPayload,
  readZipFile,
  readZipManifest
} = require('./unpack-crx.cjs');

const PROVENANCE_FILE = 'extension-provenance-automation.json';
const EXPECTED_NAME = 'OWASP Penetration Testing Kit Automation';
const EXPECTED_SHORT_NAME = 'PTK Auto';
const EXPECTED_DESCRIPTION = 'OWASP Penetration Testing Kit Automation';
const EXPECTED_FIREFOX_ID = 'ptk-automation-agent@ptklabs.com';
const EXPECTED_ICON = 'ptk/browser/assets/images/ptk_auto_icon_128.png';
const EXPECTED_POPUP = 'ptk/automation/popup.html';
const EXPECTED_FIREFOX_DATA_COLLECTION = [
  'browsingActivity',
  'websiteContent',
  'authenticationInfo'
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    inputDir: null,
    version: null,
    provenanceSha256: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input-dir') options.inputDir = path.resolve(argv[++index]);
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--provenance-sha256') options.provenanceSha256 = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function help() {
  return [
    'Usage:',
    '  node scripts/verify-extension-artifacts.cjs --input-dir <dir> --version <version> [options]',
    '',
    'Options:',
    '  --provenance-sha256 <sha256>  Pin the provenance file downloaded from a release.'
  ].join('\n');
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function assertSha256(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character SHA-256 digest`);
  }
  return normalized;
}

function assertVersion(value) {
  const version = String(value || '').trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version must be valid extension semver: ${version || '(empty)'}`);
  }
  return version;
}

function expectedArtifacts(version) {
  return {
    chromeZip: `chrome_${version}_automation.zip`,
    firefoxZip: `firefox_${version}_automation.zip`,
    crx: 'ptk-latest-automation.crx',
    xpi: 'ptk-latest-automation.xpi'
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read JSON ${filePath}: ${error.message}`);
  }
}

function verifyArtifactFile(inputDir, provenance, key, expectedName) {
  const entry = provenance?.artifacts?.[key];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${PROVENANCE_FILE} is missing artifacts.${key}`);
  }
  if (path.basename(String(entry.path || '')) !== expectedName) {
    throw new Error(`artifacts.${key}.path must be ${expectedName}`);
  }
  const artifactPath = path.join(inputDir, expectedName);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error(`Required automation artifact not found: ${artifactPath}`);
  }
  const expectedSha256 = assertSha256(entry.sha256, `artifacts.${key}.sha256`);
  const actualSha256 = sha256File(artifactPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${expectedName} SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`);
  }
  const actualBytes = fs.statSync(artifactPath).size;
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== actualBytes) {
    throw new Error(`${expectedName} size mismatch: expected ${entry.bytes}, received ${actualBytes}`);
  }
  return {
    key,
    path: artifactPath,
    name: expectedName,
    sha256: actualSha256,
    bytes: actualBytes
  };
}

function readCrxManifest(crxPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-artifact-crx-'));
  const zipPath = path.join(tempDir, 'payload.zip');
  try {
    extractZipPayload(crxPath, zipPath);
    return readZipManifest(zipPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readCrxFile(crxPath, entryName) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-artifact-crx-entry-'));
  const zipPath = path.join(tempDir, 'payload.zip');
  try {
    extractZipPayload(crxPath, zipPath);
    return readZipFile(zipPath, entryName);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertIdentity(manifest, label, version, manifestVersion) {
  if (!manifest || typeof manifest !== 'object') throw new Error(`${label} manifest is missing`);
  if (manifest.name !== EXPECTED_NAME) throw new Error(`${label} manifest.name must be ${EXPECTED_NAME}`);
  if (manifest.short_name !== EXPECTED_SHORT_NAME) throw new Error(`${label} manifest.short_name must be ${EXPECTED_SHORT_NAME}`);
  if (manifest.description !== EXPECTED_DESCRIPTION) {
    throw new Error(`${label} manifest.description must be ${EXPECTED_DESCRIPTION}`);
  }
  if (manifest.version !== version) throw new Error(`${label} manifest.version must be ${version}`);
  if (Number(manifest.manifest_version) !== manifestVersion) {
    throw new Error(`${label} manifest_version must be ${manifestVersion}`);
  }
}

function assertAutomationPopup(manifest, label, actionKey) {
  const otherActionKey = actionKey === 'action' ? 'browser_action' : 'action';
  if (manifest[otherActionKey] || manifest.options_ui) {
    throw new Error(`${label} must expose only the browser-appropriate passive action`);
  }
  if (JSON.stringify(manifest.icons) !== JSON.stringify({ 128: EXPECTED_ICON })) {
    throw new Error(`${label} must use the PTK Auto icon`);
  }
  const expectedAction = {
    default_icon: { 128: EXPECTED_ICON },
    default_title: 'PTK Auto',
    default_popup: EXPECTED_POPUP
  };
  if (JSON.stringify(manifest[actionKey]) !== JSON.stringify(expectedAction)) {
    throw new Error(`${label} must expose the passive PTK Auto diagnostic popup`);
  }
}

function verifyManifests(artifacts, provenance, version) {
  const chromiumManifest = readZipManifest(artifacts.chromeZip.path);
  const firefoxManifest = readZipManifest(artifacts.firefoxZip.path);
  const crxManifest = readCrxManifest(artifacts.crx.path);
  const xpiManifest = readZipManifest(artifacts.xpi.path);

  assertIdentity(chromiumManifest, 'Chromium ZIP', version, 3);
  assertIdentity(crxManifest, 'Chromium CRX', version, 3);
  assertIdentity(firefoxManifest, 'Firefox ZIP', version, 2);
  assertIdentity(xpiManifest, 'Firefox XPI', version, 2);
  assertAutomationPopup(chromiumManifest, 'Chromium ZIP', 'action');
  assertAutomationPopup(crxManifest, 'Chromium CRX', 'action');
  assertAutomationPopup(firefoxManifest, 'Firefox ZIP', 'browser_action');
  assertAutomationPopup(xpiManifest, 'Firefox XPI', 'browser_action');

  if (chromiumManifest?.background?.service_worker !== 'app_automation.js') {
    throw new Error('Chromium automation manifest must use app_automation.js');
  }
  if (firefoxManifest?.background?.page !== 'ptk/background_automation.html') {
    throw new Error('Firefox automation manifest must use ptk/background_automation.html');
  }
  const firefoxId = firefoxManifest?.browser_specific_settings?.gecko?.id
    || firefoxManifest?.applications?.gecko?.id;
  if (firefoxId !== EXPECTED_FIREFOX_ID) {
    throw new Error(`Firefox automation manifest must use Gecko id ${EXPECTED_FIREFOX_ID}`);
  }
  const firefoxGecko = firefoxManifest?.browser_specific_settings?.gecko;
  if (firefoxGecko?.strict_min_version !== '140.0') {
    throw new Error('Firefox automation manifest strict_min_version must be 140.0');
  }
  if (JSON.stringify(firefoxGecko?.data_collection_permissions) !== JSON.stringify({ required: EXPECTED_FIREFOX_DATA_COLLECTION })) {
    throw new Error('Firefox automation manifest must declare the reviewed built-in data-consent categories');
  }
  if (JSON.stringify(crxManifest) !== JSON.stringify(chromiumManifest)) {
    throw new Error('Chromium CRX manifest does not match Chromium ZIP manifest');
  }
  if (JSON.stringify(xpiManifest) !== JSON.stringify(firefoxManifest)) {
    throw new Error('Firefox XPI manifest does not match Firefox ZIP manifest');
  }
  for (const [label, readEntry] of [
    ['Chromium ZIP', (entry) => readZipFile(artifacts.chromeZip.path, entry)],
    ['Chromium CRX', (entry) => readCrxFile(artifacts.crx.path, entry)],
    ['Firefox ZIP', (entry) => readZipFile(artifacts.firefoxZip.path, entry)],
    ['Firefox XPI', (entry) => readZipFile(artifacts.xpi.path, entry)]
  ]) {
    if (readEntry('dev.local.json')) throw new Error(`${label} must not include dev.local.json`);
    for (const entry of [EXPECTED_ICON, EXPECTED_POPUP, 'ptk/automation/popup.css', 'ptk/automation/popup.js']) {
      if (!readEntry(entry)) throw new Error(`${label} is missing ${entry}`);
    }
  }

  for (const [key, artifact, expectedManifest] of [
    ['chromium', artifacts.chromeZip, chromiumManifest],
    ['firefox', artifacts.firefoxZip, firefoxManifest]
  ]) {
    const declared = provenance?.manifests?.[key];
    if (!declared) throw new Error(`${PROVENANCE_FILE} is missing manifests.${key}`);
    if (declared.version !== version) throw new Error(`manifests.${key}.version must be ${version}`);
    if (Number(declared.manifestVersion) !== Number(expectedManifest.manifest_version)) {
      throw new Error(`manifests.${key}.manifestVersion does not match the archive manifest`);
    }
    const rawManifest = readZipFile(artifact.path, 'manifest.json');
    const rawSha256 = sha256Buffer(rawManifest || Buffer.alloc(0));
    if (rawSha256 !== assertSha256(declared.sha256, `manifests.${key}.sha256`)) {
      throw new Error(`manifests.${key}.sha256 does not match the archive manifest`);
    }
  }

  return { chromium: chromiumManifest, firefox: firefoxManifest };
}

function verifyExtensionArtifacts(options = {}) {
  const inputDir = path.resolve(options.inputDir || '');
  const version = assertVersion(options.version);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`--input-dir does not exist or is not a directory: ${inputDir}`);
  }
  const provenancePath = path.join(inputDir, PROVENANCE_FILE);
  if (!fs.existsSync(provenancePath)) throw new Error(`Required provenance file not found: ${provenancePath}`);
  const provenanceSha256 = sha256File(provenancePath);
  if (options.provenanceSha256) {
    const expected = assertSha256(options.provenanceSha256, '--provenance-sha256');
    if (provenanceSha256 !== expected) {
      throw new Error(`${PROVENANCE_FILE} SHA-256 mismatch: expected ${expected}, received ${provenanceSha256}`);
    }
  }
  const provenance = readJson(provenancePath);
  if (provenance.schemaVersion !== 'ptk-extension-artifact-provenance-v1') {
    throw new Error(`${PROVENANCE_FILE} has an unsupported schemaVersion`);
  }
  if (provenance.artifactKind !== 'ptk-browser-extension' || provenance.distribution !== 'automation-agent') {
    throw new Error(`${PROVENANCE_FILE} is not an automation-agent browser-extension release`);
  }
  if (provenance.buildMode !== 'automation-artifact' || provenance.automationEnabledDefault !== true) {
    throw new Error(`${PROVENANCE_FILE} must describe an automation-artifact build enabled by default`);
  }
  if (provenance.extensionVersion !== version) {
    throw new Error(`${PROVENANCE_FILE} extensionVersion must be ${version}`);
  }

  const expected = expectedArtifacts(version);
  const artifacts = Object.fromEntries(Object.entries(expected).map(([key, name]) => [
    key,
    verifyArtifactFile(inputDir, provenance, key, name)
  ]));
  const manifests = verifyManifests(artifacts, provenance, version);
  return {
    ok: true,
    version,
    provenancePath,
    provenanceSha256,
    artifacts,
    manifests: {
      chromium: {
        name: manifests.chromium.name,
        shortName: manifests.chromium.short_name,
        manifestVersion: manifests.chromium.manifest_version
      },
      firefox: {
        name: manifests.firefox.name,
        shortName: manifests.firefox.short_name,
        manifestVersion: manifests.firefox.manifest_version,
        geckoId: manifests.firefox.browser_specific_settings?.gecko?.id
          || manifests.firefox.applications?.gecko?.id
      }
    }
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(help());
      return 0;
    }
    if (!options.inputDir || !options.version) throw new Error('--input-dir and --version are required');
    console.log(JSON.stringify(verifyExtensionArtifacts(options), null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EXPECTED_DESCRIPTION,
  EXPECTED_FIREFOX_ID,
  EXPECTED_NAME,
  EXPECTED_SHORT_NAME,
  PROVENANCE_FILE,
  assertIdentity,
  assertSha256,
  expectedArtifacts,
  parseArgs,
  verifyExtensionArtifacts
};
