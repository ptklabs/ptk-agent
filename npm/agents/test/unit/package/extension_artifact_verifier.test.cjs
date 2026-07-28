'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EXPECTED_DESCRIPTION,
  EXPECTED_FIREFOX_ID,
  EXPECTED_NAME,
  EXPECTED_SHORT_NAME,
  PROVENANCE_FILE,
  verifyExtensionArtifacts
} = require('../../../../scripts/verify-extension-artifacts.cjs');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(value);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const localPayload = Buffer.concat(localParts);
  const centralPayload = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralPayload.length, 12);
  end.writeUInt32LE(localPayload.length, 16);
  return Buffer.concat([localPayload, centralPayload, end]);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFixture() {
  const version = '9.9.8';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-release-artifacts-'));
  const icon = 'ptk/browser/assets/images/ptk_auto_icon_128.png';
  const popup = 'ptk/automation/popup.html';
  const chromiumManifest = {
    manifest_version: 3,
    name: EXPECTED_NAME,
    short_name: EXPECTED_SHORT_NAME,
    description: EXPECTED_DESCRIPTION,
    version,
    background: { service_worker: 'app_automation.js' },
    icons: { 128: icon },
    action: {
      default_icon: { 128: icon },
      default_title: 'PTK Auto',
      default_popup: popup
    }
  };
  const firefoxManifest = {
    manifest_version: 2,
    name: EXPECTED_NAME,
    short_name: EXPECTED_SHORT_NAME,
    description: EXPECTED_DESCRIPTION,
    version,
    background: { page: 'ptk/background_automation.html' },
    icons: { 128: icon },
    browser_action: {
      default_icon: { 128: icon },
      default_title: 'PTK Auto',
      default_popup: popup
    },
    browser_specific_settings: {
      gecko: {
        id: EXPECTED_FIREFOX_ID,
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['browsingActivity', 'websiteContent', 'authenticationInfo']
        }
      }
    }
  };
  const chromiumManifestBytes = Buffer.from(JSON.stringify(chromiumManifest));
  const firefoxManifestBytes = Buffer.from(JSON.stringify(firefoxManifest));
  const chromiumZip = createZip({
    'manifest.json': chromiumManifestBytes,
    'app_automation.js': 'globalThis.PTK_AGENT = {};',
    [icon]: 'icon',
    [popup]: '<script src="popup.js"></script>',
    'ptk/automation/popup.css': 'body {}',
    'ptk/automation/popup.js': 'globalThis.PTK_POPUP = true;'
  });
  const firefoxZip = createZip({
    'manifest.json': firefoxManifestBytes,
    'ptk/background_automation.html': '<script type="module" src="../app.js"></script>',
    'app.js': 'globalThis.PTK_AGENT = {};',
    [icon]: 'icon',
    [popup]: '<script src="popup.js"></script>',
    'ptk/automation/popup.css': 'body {}',
    'ptk/automation/popup.js': 'globalThis.PTK_POPUP = true;'
  });
  const crxHeader = Buffer.alloc(12);
  crxHeader.write('Cr24', 0, 'ascii');
  crxHeader.writeUInt32LE(3, 4);
  const crx = Buffer.concat([crxHeader, chromiumZip]);
  const files = {
    chromeZip: { name: `chrome_${version}_automation.zip`, bytes: chromiumZip },
    firefoxZip: { name: `firefox_${version}_automation.zip`, bytes: firefoxZip },
    crx: { name: 'ptk-latest-automation.crx', bytes: crx },
    xpi: { name: 'ptk-latest-automation.xpi', bytes: firefoxZip }
  };
  for (const file of Object.values(files)) fs.writeFileSync(path.join(root, file.name), file.bytes);
  const provenance = {
    schemaVersion: 'ptk-extension-artifact-provenance-v1',
    artifactKind: 'ptk-browser-extension',
    distribution: 'automation-agent',
    buildMode: 'automation-artifact',
    automationEnabledDefault: true,
    extensionVersion: version,
    manifests: {
      chromium: { version, manifestVersion: 3, sha256: sha256(chromiumManifestBytes) },
      firefox: { version, manifestVersion: 2, sha256: sha256(firefoxManifestBytes) }
    },
    artifacts: Object.fromEntries(Object.entries(files).map(([key, file]) => [
      key,
      { path: file.name, sha256: sha256(file.bytes), bytes: file.bytes.length }
    ]))
  };
  const provenancePath = path.join(root, PROVENANCE_FILE);
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { root, version, provenancePath };
}

test('release artifacts require pinned provenance, matching hashes, versions, and automation identities', () => {
  const fixture = createFixture();
  const result = verifyExtensionArtifacts({
    inputDir: fixture.root,
    version: fixture.version,
    provenanceSha256: sha256(fs.readFileSync(fixture.provenancePath))
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifests.chromium.shortName, EXPECTED_SHORT_NAME);
  assert.equal(result.manifests.firefox.geckoId, EXPECTED_FIREFOX_ID);
  assert.deepEqual(Object.keys(result.artifacts), ['chromeZip', 'firefoxZip', 'crx', 'xpi']);
});

test('release artifact verification rejects tampering and a stale provenance pin', () => {
  const fixture = createFixture();
  assert.throws(() => verifyExtensionArtifacts({
    inputDir: fixture.root,
    version: fixture.version,
    provenanceSha256: '0'.repeat(64)
  }), /provenance-automation\.json SHA-256 mismatch/);

  fs.appendFileSync(path.join(fixture.root, `chrome_${fixture.version}_automation.zip`), 'tamper');
  assert.throws(() => verifyExtensionArtifacts({
    inputDir: fixture.root,
    version: fixture.version
  }), /SHA-256 mismatch/);
});

test('release artifact verification rejects a different automation extension identity', () => {
  const fixture = createFixture();
  const provenance = JSON.parse(fs.readFileSync(fixture.provenancePath, 'utf8'));
  provenance.extensionVersion = '9.9.7';
  fs.writeFileSync(fixture.provenancePath, JSON.stringify(provenance));
  assert.throws(() => verifyExtensionArtifacts({
    inputDir: fixture.root,
    version: fixture.version
  }), /extensionVersion must be 9\.9\.8/);
});
