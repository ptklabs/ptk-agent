'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const {
  getCrxZipOffset,
  readZipEntries,
  readZipManifest,
  unpackCrx
} = require('../../../scripts/unpack-crx.cjs');
const {
  AUTOMATION_ARTIFACT_SOURCE,
  AUTOMATION_CRX_FILE,
  AUTOMATION_PROVENANCE_FILE,
  AUTOMATION_XPI_FILE,
  DEFAULT_INPUT_DIR,
  NPM_DOCS_ROOT,
  NPM_PUBLIC_DOCS_BASE_URL,
  PACKAGE_FIREFOX_ZIP_FILE,
  PACKAGE_XPI_FILE,
  assertSemver,
  containsForbiddenPath,
  findRelativeMarkdownLinks,
  isAllowedPackedPath,
  parseArgs,
  packedFilePaths,
  preparePackage,
  readAutomationArtifactProvenance,
  rewriteNpmReadmeLinksForPackageRoot,
  resolvePackageVersionInfo,
  resolvePackageVersion,
  scanTextForSecrets,
  shouldSkipPublicDocOrExample,
  verifyStagedPackage
} = require('../../../scripts/prepare-npm-package.cjs');
const {
  extensionVariantsForMode,
  prepareSourceFirefoxXpi,
  validateAutomationExtensionDir,
  writeFullExtensionAutomationConfig
} = require('../../../scripts/test-release-frameworks.cjs');
const {
  ensurePtkCrx,
  ensurePtkXpi,
  resolvePtkCrxArtifact,
  resolvePtkExtensionArtifact,
  resolvePtkFirefoxZipArtifact,
  resolvePtkXpiArtifact
} = require('../../../extensions/index.cjs');

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
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contentValue] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(contentValue);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const localPayload = Buffer.concat(localParts);
  const centralPayload = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralPayload.length, 12);
  end.writeUInt32LE(localPayload.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localPayload, centralPayload, end]);
}

function createCrx3(zipPayload) {
  const header = Buffer.alloc(12);
  header.write('Cr24', 0, 'ascii');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(0, 8);
  return Buffer.concat([header, zipPayload]);
}

function createCrx2(zipPayload) {
  const publicKey = Buffer.from('test-public-key');
  const signature = Buffer.from('test-signature');
  const header = Buffer.alloc(16);
  header.write('Cr24', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(publicKey.length, 8);
  header.writeUInt32LE(signature.length, 12);
  return Buffer.concat([header, publicKey, signature, zipPayload]);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('package version validation accepts semver and rejects extension four-part versions', () => {
  assert.equal(assertSemver('1.2.3'), '1.2.3');
  assert.equal(resolvePackageVersion('1.2.3', null), '1.2.3');
  assert.equal(resolvePackageVersion('1.2.3.4', '1.2.3'), '1.2.3');
  assert.throws(() => resolvePackageVersion('1.2.3.4', null), /valid npm semver/);
  assert.deepEqual(resolvePackageVersionInfo('1.2.3.4', '1.2.3'), {
    packageVersion: '1.2.3',
    packageVersionSource: 'override',
    versionMappingReason: 'extension manifest version is not valid npm semver'
  });
  assert.deepEqual(resolvePackageVersionInfo('1.2.3', null), {
    packageVersion: '1.2.3',
    packageVersionSource: 'extension-manifest',
    versionMappingReason: null
  });
});

test('default package input uses ptk-agent dist directory', () => {
  assert.equal(path.basename(DEFAULT_INPUT_DIR), 'dist');
  assert.equal(path.basename(path.dirname(DEFAULT_INPUT_DIR)), 'ptk-agent');
  assert.equal(parseArgs([]).artifactSource, AUTOMATION_ARTIFACT_SOURCE);
  assert.equal(AUTOMATION_CRX_FILE, 'ptk-latest-automation.crx');
  assert.equal(AUTOMATION_XPI_FILE, 'ptk-latest-automation.xpi');
  assert.equal(AUTOMATION_PROVENANCE_FILE, 'extension-provenance-automation.json');
  assert.equal(PACKAGE_FIREFOX_ZIP_FILE, 'ptk-latest-firefox.zip');
  assert.equal(PACKAGE_XPI_FILE, 'ptk-latest.xpi');
});

test('CRX3 payload unpacks and exposes manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-crx-test-'));
  const crx = path.join(dir, 'ptk-latest.crx');
  const dest = path.join(dir, 'out');
  const zip = createZip({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'OWASP PTK',
      version: '1.2.3',
      background: { service_worker: 'app.js' }
    }),
    'app.js': 'globalThis.PTK_AGENT = {};'
  });
  fs.writeFileSync(crx, createCrx3(zip));

  assert.equal(getCrxZipOffset(fs.readFileSync(crx)), 12);
  const result = unpackCrx(crx, dest);
  assert.equal(result.manifestPath, path.join(dest, 'manifest.json'));
  assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).version, '1.2.3');
});

test('CRX2 payload offset is handled', () => {
  const zip = createZip({
    'manifest.json': JSON.stringify({
      manifest_version: 2,
      name: 'OWASP PTK',
      version: '1.2.3'
    })
  });
  const crx2 = createCrx2(zip);
  assert.equal(getCrxZipOffset(crx2), 16 + 'test-public-key'.length + 'test-signature'.length);
});

test('invalid CRX fails clearly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-invalid-crx-'));
  const crx = path.join(dir, 'bad.crx');
  fs.writeFileSync(crx, 'not a zip');
  assert.throws(() => unpackCrx(crx, path.join(dir, 'out')), /Invalid ZIP payload|Invalid CRX payload/);
});

test('ZIP safety rejects path traversal and duplicate normalized paths', () => {
  assert.throws(() => readZipEntries(createZip({
    '../manifest.json': '{}'
  })), /path traversal/);
  assert.throws(() => readZipEntries(createZip({
    'manifest.json': '{}',
    './manifest.json': '{}'
  })), /duplicate path/);
});

test('XPI manifest is inspected from ZIP payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-xpi-manifest-'));
  const xpi = path.join(dir, 'ptk-latest.xpi');
  fs.writeFileSync(xpi, createZip({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'OWASP PTK',
      version: '1.2.3',
      browser_specific_settings: {
        gecko: {
          id: 'ptk@example.test'
        }
      }
    })
  }));
  const manifest = readZipManifest(xpi);
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.manifest_version, 3);
});

test('installed package resolves all four provenance-pinned browser artifacts without rebuilding CRX or XPI', () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-four-artifacts-'));
  const extensionsDir = path.join(packageRoot, 'extensions');
  const manifestsDir = path.join(extensionsDir, 'manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });
  const chromiumManifest = {
    manifest_version: 3,
    name: 'OWASP Penetration Testing Kit Automation',
    version: '9.9.8',
    background: { service_worker: 'app_automation.js' }
  };
  const firefoxManifest = {
    manifest_version: 2,
    name: 'OWASP Penetration Testing Kit Automation',
    version: '9.9.8',
    background: { page: 'ptk/background_automation.html' }
  };
  const chromiumZip = createZip({
    'manifest.json': JSON.stringify(chromiumManifest),
    'app_automation.js': 'globalThis.PTK_AGENT = {};'
  });
  const firefoxZip = createZip({
    'manifest.json': JSON.stringify(firefoxManifest),
    'ptk/background_automation.html': '<script src="../app.js"></script>'
  });
  const crx = createCrx3(chromiumZip);
  const files = {
    'ptk-latest.zip': chromiumZip,
    'ptk-latest-firefox.zip': firefoxZip,
    'ptk-latest.crx': crx,
    'ptk-latest.xpi': firefoxZip
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(extensionsDir, name), bytes);
  fs.writeFileSync(path.join(manifestsDir, 'manifest.automation.firefox.json'), JSON.stringify(firefoxManifest));
  fs.writeFileSync(path.join(extensionsDir, 'extension-provenance.json'), JSON.stringify({
    schemaVersion: 'ptk-extension-provenance-v1',
    packageVersion: '9.9.8',
    extensionVersion: '9.9.8',
    automationEnabledDefault: true,
    hashes: {
      zipSha256: sha256(chromiumZip),
      firefoxZipSha256: sha256(firefoxZip),
      crxSha256: sha256(crx),
      xpiSha256: sha256(firefoxZip)
    }
  }));

  assert.equal(resolvePtkExtensionArtifact({ packageRoot }).source, 'bundled-package');
  assert.equal(resolvePtkFirefoxZipArtifact({ packageRoot }).source, 'bundled-package');
  assert.equal(resolvePtkCrxArtifact({ packageRoot }).source, 'bundled-package');
  assert.equal(resolvePtkXpiArtifact({ packageRoot }).source, 'bundled-package');
  assert.equal(ensurePtkCrx({ packageRoot }).path, path.join(extensionsDir, 'ptk-latest.crx'));
  assert.equal(ensurePtkXpi({ packageRoot }).path, path.join(extensionsDir, 'ptk-latest.xpi'));
});

test('staged package safety checks detect forbidden paths and obvious secrets', () => {
  assert.equal(containsForbiddenPath('agents_v1/README.md'), true);
  assert.equal(containsForbiddenPath('agents/docs/implementation-plan.md'), true);
  assert.equal(containsForbiddenPath('agents/.ptk/artifact.json'), true);
  assert.equal(containsForbiddenPath('agents/src/core/config.cjs'), false);
  assert.equal(containsForbiddenPath('src/dev.local.json'), true);
  assert.equal(containsForbiddenPath('extensions/chromium-unpacked/dev.local.json'), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-secret-scan-'));
  const file = path.join(dir, 'bad.md');
  fs.writeFileSync(file, 'password = "real-secret-value"', 'utf8');
  assert.ok(scanTextForSecrets(file, 'bad.md').length > 0);
});

test('staged package safety rejects relative Markdown links lost during packaging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-staged-doc-links-'));
  try {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '[Public docs](https://example.test/docs)\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '[Missing](../not-packaged.md)\n', 'utf8');
    assert.throws(() => verifyStagedPackage(dir), /broken staged-package markdown link/);
    fs.writeFileSync(path.join(dir, 'not-packaged.md'), '# Included\n', 'utf8');
    assert.doesNotThrow(() => verifyStagedPackage(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('framework release smoke selects both source extensions and package automation only', () => {
  assert.deepEqual(extensionVariantsForMode('source', {}), ['full', 'automation']);
  assert.deepEqual(extensionVariantsForMode('source', { extension: 'automation' }), ['automation']);
  assert.deepEqual(extensionVariantsForMode('source', { extension: 'full' }), ['full']);
  assert.deepEqual(extensionVariantsForMode('package', {}), ['automation']);
  assert.deepEqual(extensionVariantsForMode('package', { extension: 'both' }), ['automation']);
  assert.throws(
    () => extensionVariantsForMode('package', { extension: 'full' }),
    /Package-mode smoke cannot run the full extension/
  );
});

test('Selenium package smoke resolves Firefox through the packaged extension API', () => {
  const wrapperPath = path.resolve(
    __dirname,
    '../../../frameworks/selenium/smoke/run_juice_shop_smoke.sh'
  );
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  assert.match(wrapper, /ensurePtkXpi/);
  assert.doesNotMatch(
    wrapper,
    /DEFAULT_EXTENSION_PATH="\$PENTESTKIT_ROOT\/extensions\/ptk-latest\.xpi"/
  );
});

test('framework release smoke rejects bypass flags', () => {
  const releaseScript = path.resolve(__dirname, '../../../scripts/test-release-frameworks.cjs');
  const verifierScript = path.resolve(__dirname, '../../../scripts/verify-framework-artifacts.cjs');
  const cases = [
    [releaseScript, ['--require-findings', 'false']],
    [releaseScript, ['--skip-preflight']],
    [verifierScript, ['--no-require-findings']]
  ];

  for (const [script, args] of cases) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option/);
  }
});

test('full extension smoke writes dev.local.json with automation enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-full-smoke-extension-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'OWASP PTK',
    version: '1.0.0',
    background: { service_worker: 'app.js' }
  }), 'utf8');

  assert.throws(() => validateAutomationExtensionDir(dir, 'full'), /provide dev\.local\.json/);
  writeFullExtensionAutomationConfig(dir);
  validateAutomationExtensionDir(dir, 'full');

  const devLocal = JSON.parse(fs.readFileSync(path.join(dir, 'dev.local.json'), 'utf8'));
  assert.deepEqual(devLocal, { automationEnabled: true });
});

test('full Firefox smoke stages an MV2 XPI with scoped automation enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-full-firefox-smoke-'));
  const sourceXpi = path.join(dir, 'source.xpi');
  fs.writeFileSync(sourceXpi, createZip({
    'manifest.json': JSON.stringify({
      manifest_version: 2,
      name: 'OWASP PTK',
      version: '1.0.0',
      background: { page: 'ptk/background.html' }
    }),
    'ptk/background.html': '<script type="module" src="../app.js"></script>',
    'ptk/settings.default.js': 'const defaults = { automation: { enable: false } }; export default defaults;',
    'app.js': 'globalThis.PTK_AGENT = {};'
  }));

  const stagedXpi = prepareSourceFirefoxXpi({
    mode: 'source',
    fullFirefoxXpi: sourceXpi,
    firefoxXpi: null
  }, path.join(dir, 'row'), 'full');
  const unpacked = path.join(dir, 'unpacked');
  unpackCrx(stagedXpi, unpacked);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(unpacked, 'dev.local.json'), 'utf8')),
    { automationEnabled: true }
  );
  assert.match(
    fs.readFileSync(path.join(unpacked, 'ptk', 'settings.default.js'), 'utf8'),
    /automation:\s*\{\s*enable:\s*true\s*\}/
  );
  validateAutomationExtensionDir(unpacked, 'full');
});

test('package staging requires automation artifact source and provenance', () => {
  assert.throws(() => preparePackage({
    inputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-missing-input-')),
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-out-')),
    publishable: true,
    artifactSource: 'published-store',
    skipSmoke: true
  }), /automation-artifact/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-automation-artifact-'));
  assert.throws(() => preparePackage({
    inputDir: dir,
    inputDirExplicit: true,
    artifactSource: AUTOMATION_ARTIFACT_SOURCE,
    skipSmoke: true
  }), /Automation artifact provenance not found/);

  fs.writeFileSync(path.join(dir, AUTOMATION_PROVENANCE_FILE), JSON.stringify({
    schemaVersion: 'ptk-extension-artifact-provenance-v1',
    buildMode: AUTOMATION_ARTIFACT_SOURCE,
    automationEnabledDefault: false
  }), 'utf8');
  assert.throws(() => readAutomationArtifactProvenance(dir), /automationEnabledDefault/);

  fs.writeFileSync(path.join(dir, AUTOMATION_PROVENANCE_FILE), JSON.stringify({
    schemaVersion: 'ptk-extension-artifact-provenance-v1',
    buildMode: AUTOMATION_ARTIFACT_SOURCE,
    automationEnabledDefault: true
  }), 'utf8');
  assert.equal(readAutomationArtifactProvenance(dir).automationEnabledDefault, true);
});

test('pack allowlist accepts package files and rejects stray files', () => {
  assert.equal(isAllowedPackedPath('package/index.cjs'), true);
  assert.equal(isAllowedPackedPath('package/package.json'), true);
  assert.equal(isAllowedPackedPath('package/README.md'), true);
  assert.equal(isAllowedPackedPath('package/LICENSE'), true);
  assert.equal(isAllowedPackedPath('package/agents/src/cli/index.cjs'), true);
  assert.equal(isAllowedPackedPath('package/providers/testmu/index.cjs'), true);
  assert.equal(isAllowedPackedPath('package/.npmrc'), false);
  assert.equal(isAllowedPackedPath('package/release-input/ptk-latest.crx'), false);
  assert.deepEqual(packedFilePaths({
    files: [{ path: 'package/README.md' }, { path: 'package/index.cjs' }]
  }), ['README.md', 'index.cjs']);
});

test('argument parser tracks an explicit extension artifact input directory', () => {
  const options = parseArgs(['--input-dir', '/tmp/store-artifacts']);
  assert.equal(options.inputDirExplicit, true);
});

test('public docs and examples use a positive allowlist', () => {
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/README.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/cli.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/configuration.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/mcp-server.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/providers.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('docs/npm/private-plan.md'), true);
  assert.equal(shouldSkipPublicDocOrExample('agents/README.md'), true);
  assert.equal(shouldSkipPublicDocOrExample('agents/docs/architecture.md'), true);
  assert.equal(shouldSkipPublicDocOrExample('agents/docs/pro-modules.md'), true);
  assert.equal(shouldSkipPublicDocOrExample('agents/docs/new-internal-plan.md'), true);
  assert.equal(shouldSkipPublicDocOrExample('agents/examples/ptk.config.json'), false);
  assert.equal(shouldSkipPublicDocOrExample('agents/examples/private-profile.json'), true);
  assert.equal(shouldSkipPublicDocOrExample('providers/README.md'), false);
  assert.equal(shouldSkipPublicDocOrExample('agents/src/core/config.cjs'), false);
});

test('npm package documentation exists and is npm-install oriented', () => {
  const readme = fs.readFileSync(path.join(NPM_DOCS_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npm install -D pentestkit/);
  assert.match(readme, /npx ptk-scan/);
  assert.match(readme, /ptk-agent-mcp-server --stdio/);
  assert.match(readme, /bundled-package/);
  assert.match(readme, /\]\(extension-loading\.md\)/);
  assert.match(readme, /\]\(mcp-server\.md\)/);
  assert.match(readme, /\]\(providers\.md\)/);
  assert.doesNotMatch(readme, /\]\(docs\/npm\/extension-loading\.md\)/);
});

test('staged root npm README links are rewritten to public docs URLs', () => {
  const source = 'See [extension loading](extension-loading.md), [MCP](mcp-server.md), [providers](providers.md), [CLI](cli.md), and [troubleshooting](troubleshooting.md#browser-launch-fails).';
  assert.equal(
    rewriteNpmReadmeLinksForPackageRoot(source),
    `See [extension loading](${NPM_PUBLIC_DOCS_BASE_URL}/extension-loading.md), [MCP](${NPM_PUBLIC_DOCS_BASE_URL}/mcp-server.md), [providers](${NPM_PUBLIC_DOCS_BASE_URL}/providers.md), [CLI](${NPM_PUBLIC_DOCS_BASE_URL}/cli.md), and [troubleshooting](${NPM_PUBLIC_DOCS_BASE_URL}/troubleshooting.md#browser-launch-fails).`
  );
});

test('staged root npm README rejects relative markdown links', () => {
  assert.deepEqual(findRelativeMarkdownLinks('[CLI](cli.md) [anchor](#usage) [site](https://example.test/readme.md)'), ['cli.md']);
  assert.deepEqual(findRelativeMarkdownLinks(rewriteNpmReadmeLinksForPackageRoot('[CLI](cli.md) [MCP](docs/npm/mcp-server.md)')), []);
});
