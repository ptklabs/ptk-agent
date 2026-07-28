'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DEV_LOCAL_FILE = 'dev.local.json';
const PROVENANCE_FILE = 'extension-provenance.json';
const CANONICAL_ZIP_FILE = 'ptk-latest.zip';
const CANONICAL_FIREFOX_ZIP_FILE = 'ptk-latest-firefox.zip';
const CANONICAL_CRX_FILE = 'ptk-latest.crx';
const CANONICAL_XPI_FILE = 'ptk-latest.xpi';
const PTKLABS_AUTOMATION_ARTIFACT_SOURCE = 'ptklabs-automation-artifact';
const PTKLABS_AUTOMATION_SERVICE_WORKER = 'automation/background/automation-background-entry.js';
const CHROMIUM_MANIFEST_FILE = path.join('manifests', 'manifest.automation.chromium.json');
const FIREFOX_MANIFEST_FILE = path.join('manifests', 'manifest.automation.firefox.json');
const CHROMIUM_MANIFEST_COMPAT_FILE = path.join('manifests', 'chromium-mv3.json');
const FIREFOX_MANIFEST_COMPAT_FILE = path.join('manifests', 'firefox-mv2.json');
const ALLOWED_DEV_LOCAL_KEYS = new Set([
  'automation',
  'automationEnabled',
  'automationAllowChildFrameBootstrap',
  'automationChildFrameBootstrapOrigins',
  'portalBaseUrl',
  'portalUrl'
]);

function packageRoot(options = {}) {
  return path.resolve(options.packageRoot || PACKAGE_ROOT);
}

function extensionsDir(options = {}) {
  return path.join(packageRoot(options), 'extensions');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sanitizePathPart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function assertCacheRootOutsideNodeModules(cacheRoot) {
  const parts = path.resolve(cacheRoot).split(path.sep);
  if (parts.includes('node_modules')) {
    throw new Error(`PTK extension cache root must not be inside node_modules: ${cacheRoot}`);
  }
}

function automationCacheRoot(options = {}) {
  const root = path.resolve(options.cacheRoot || process.env.PTK_EXTENSION_CACHE_DIR || process.env.PTK_AUTOMATION_CACHE_DIR || path.join(process.cwd(), '.ptk'));
  assertCacheRootOutsideNodeModules(root);
  return root;
}

function safeZipEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  return normalized;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error('Invalid ZIP payload: end of central directory was not found');
}

function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP payload: central directory entry ${index} is corrupt`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = safeZipEntryName(buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8'));
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localOffset,
      directory: name.endsWith('/')
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { buffer, entries };
}

function readZipEntryContent(zipPayload, entry) {
  const { buffer } = zipPayload;
  const localOffset = entry.localOffset;
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP payload: local file header is corrupt for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.slice(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

function readZipFile(zipPath, entryName) {
  const wanted = String(entryName).replace(/\\/g, '/').toLowerCase();
  const zipPayload = readZipEntries(zipPath);
  const entry = zipPayload.entries.find((candidate) => candidate.name.toLowerCase() === wanted);
  return entry ? readZipEntryContent(zipPayload, entry) : null;
}

function readZipJson(zipPath, entryName) {
  const bytes = readZipFile(zipPath, entryName);
  if (!bytes) throw new Error(`ZIP entry not found: ${entryName}`);
  return JSON.parse(bytes.toString('utf8'));
}

function extractZipToDir(zipPath, destination) {
  const resolvedDestination = path.resolve(destination);
  const zipPayload = readZipEntries(zipPath);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  for (const entry of zipPayload.entries) {
    const outputPath = path.resolve(resolvedDestination, entry.name);
    if (outputPath !== resolvedDestination && !outputPath.startsWith(`${resolvedDestination}${path.sep}`)) {
      throw new Error(`Unsafe ZIP entry path: ${entry.name}`);
    }
    if (entry.directory) {
      fs.mkdirSync(outputPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, readZipEntryContent(zipPayload, entry));
    const mode = (entry.externalAttributes >>> 16) & 0o777;
    if (mode) fs.chmodSync(outputPath, mode);
  }
}

function validateManifest(manifest, label) {
  if (!manifest || typeof manifest !== 'object') throw new Error(`${label} manifest.json is invalid`);
  if (![2, 3].includes(Number(manifest.manifest_version))) {
    throw new Error(`${label} manifest_version is unsupported: ${manifest.manifest_version}`);
  }
  const name = `${manifest.name || ''} ${manifest.short_name || ''}`.toLowerCase();
  if (!name.includes('ptk') && !name.includes('penetration testing kit')) {
    throw new Error(`${label} does not look like a PTK extension artifact`);
  }
  return manifest;
}

function validateAutomationDevLocal(payload, label) {
  if (!payload) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} ${DEV_LOCAL_FILE} is invalid`);
  }
  const unexpected = Object.keys(payload).filter((key) => !ALLOWED_DEV_LOCAL_KEYS.has(key));
  if (unexpected.length) {
    throw new Error(`${label} ${DEV_LOCAL_FILE} contains unsupported keys: ${unexpected.join(', ')}`);
  }
  if (payload.automationEnabled !== true) {
    throw new Error(`${label} ${DEV_LOCAL_FILE} must set automationEnabled: true when present`);
  }
  if (payload.automationAllowChildFrameBootstrap === true) {
    throw new Error(`${label} ${DEV_LOCAL_FILE} must not enable child-frame bootstrap globally`);
  }
  return payload;
}

function validateAutomationExtensionDir(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const devLocalPath = path.join(extensionDir, DEV_LOCAL_FILE);
  if (!fs.existsSync(manifestPath)) throw new Error(`PTK extension directory is missing manifest.json: ${extensionDir}`);
  const manifest = validateManifest(readJson(manifestPath), `Extension directory ${extensionDir}`);
  const devLocal = fs.existsSync(devLocalPath)
    ? validateAutomationDevLocal(readJson(devLocalPath), `Extension directory ${extensionDir}`)
    : null;
  const serviceWorker = manifest?.background?.service_worker || '';
  const backgroundPage = manifest?.background?.page || '';
  if (serviceWorker === 'app_automation.js' && !fs.existsSync(path.join(extensionDir, 'app_automation.js'))) {
    throw new Error(`PTK automation extension directory is missing app_automation.js: ${extensionDir}`);
  }
  if (serviceWorker === PTKLABS_AUTOMATION_SERVICE_WORKER && !fs.existsSync(path.join(extensionDir, PTKLABS_AUTOMATION_SERVICE_WORKER))) {
    throw new Error(`PTK Labs automation extension directory is missing ${PTKLABS_AUTOMATION_SERVICE_WORKER}: ${extensionDir}`);
  }
  if (backgroundPage === 'ptk/background_automation.html' && !fs.existsSync(path.join(extensionDir, backgroundPage))) {
    throw new Error(`PTK automation extension directory is missing ${backgroundPage}: ${extensionDir}`);
  }
  return { manifest, devLocal };
}

function readProvenance(options = {}) {
  const filePath = path.join(extensionsDir(options), PROVENANCE_FILE);
  if (!fs.existsSync(filePath)) throw new Error(`PTK extension provenance not found: ${filePath}`);
  return readJson(filePath);
}

function canonicalZipPath(options = {}) {
  return path.join(extensionsDir(options), CANONICAL_ZIP_FILE);
}

function canonicalFirefoxZipPath(options = {}) {
  return path.join(extensionsDir(options), CANONICAL_FIREFOX_ZIP_FILE);
}

function validateAutomationZipArtifact(filePath, options = {}) {
  const provenance = fs.existsSync(path.join(extensionsDir(options), PROVENANCE_FILE))
    ? readProvenance(options)
    : {};
  const manifest = validateManifest(readZipJson(filePath, 'manifest.json'), 'Chromium ZIP');
  let devLocal = null;
  try {
    devLocal = validateAutomationDevLocal(readZipJson(filePath, DEV_LOCAL_FILE), 'Chromium ZIP');
  } catch (error) {
    if (!/ZIP entry not found/.test(error?.message || '')) throw error;
  }
  const serviceWorker = manifest?.background?.service_worker || '';
  const expectedServiceWorker = provenance.artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE
    ? PTKLABS_AUTOMATION_SERVICE_WORKER
    : 'app_automation.js';
  if (serviceWorker !== expectedServiceWorker) {
    if (provenance.artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE) {
      throw new Error(`Chromium ZIP must use ${PTKLABS_AUTOMATION_SERVICE_WORKER}`);
    }
    throw new Error('Chromium ZIP must use app_automation.js');
  }
  return {
    browser: 'chromium',
    format: 'zip',
    type: 'zip',
    path: path.resolve(filePath),
    version: manifest.version || provenance.extensionVersion || null,
    packageVersion: provenance.packageVersion || provenance?.npm?.packageVersion || null,
    sha256: sha256File(filePath),
    size: fs.statSync(filePath).size,
    manifestVersion: Number(manifest.manifest_version) || null,
    automationEnabled: serviceWorker === expectedServiceWorker || devLocal?.automationEnabled === true,
    automationEnabledDefault: provenance.automationEnabledDefault !== false,
    provenance,
    source: options.path ? 'explicit' : 'bundled-package'
  };
}

function resolvePtkExtensionArtifact(options = {}) {
  const zipPath = options.path || canonicalZipPath(options);
  if (!fs.existsSync(zipPath)) throw new Error(`PTK automation ZIP not found: ${zipPath}`);
  const artifact = validateAutomationZipArtifact(zipPath, options);
  if (!options.path && artifact.provenance?.hashes?.zipSha256 && artifact.provenance.hashes.zipSha256 !== artifact.sha256) {
    throw new Error('Bundled PTK Chromium ZIP hash does not match extension provenance.');
  }
  return artifact;
}

function resolvePtkFirefoxZipArtifact(options = {}) {
  const explicit = options.firefoxZipPath || process.env.PTK_EXTENSION_FIREFOX_ZIP_PATH;
  const zipPath = explicit ? path.resolve(explicit) : canonicalFirefoxZipPath(options);
  if (!fs.existsSync(zipPath)) throw new Error(`PTK Firefox automation ZIP not found: ${zipPath}`);
  const provenance = fs.existsSync(path.join(extensionsDir(options), PROVENANCE_FILE))
    ? readProvenance(options)
    : {};
  const manifest = validateManifest(readZipJson(zipPath, 'manifest.json'), 'Firefox ZIP');
  if (Number(manifest.manifest_version) !== 2 || manifest?.background?.page !== 'ptk/background_automation.html') {
    throw new Error('Firefox automation ZIP must use the MV2 automation background page');
  }
  let devLocal = null;
  try {
    devLocal = readZipJson(zipPath, DEV_LOCAL_FILE);
  } catch (error) {
    if (!/ZIP entry not found/.test(error?.message || '')) throw error;
  }
  if (!explicit && devLocal) {
    throw new Error(`Bundled PTK Firefox ZIP must not include ${DEV_LOCAL_FILE}`);
  }
  const sha256 = sha256File(zipPath);
  if (!explicit && provenance?.hashes?.firefoxZipSha256 && provenance.hashes.firefoxZipSha256 !== sha256) {
    throw new Error('Bundled PTK Firefox ZIP hash does not match extension provenance.');
  }
  return {
    browser: 'firefox',
    format: 'zip',
    type: 'zip',
    path: zipPath,
    version: manifest.version || provenance.extensionVersion || null,
    packageVersion: provenance.packageVersion || provenance?.npm?.packageVersion || null,
    sha256,
    size: fs.statSync(zipPath).size,
    manifestVersion: Number(manifest.manifest_version) || null,
    automationEnabled: true,
    automationEnabledDefault: provenance.automationEnabledDefault !== false,
    provenance,
    source: explicit ? 'explicit' : 'bundled-package'
  };
}

function getPtkExtensionMetadata(options = {}) {
  const chromiumManifestPath = path.join(extensionsDir(options), CHROMIUM_MANIFEST_FILE);
  const firefoxManifestPath = path.join(extensionsDir(options), FIREFOX_MANIFEST_FILE);
  const artifact = resolvePtkExtensionArtifact(options);
  return {
    packageName: artifact.provenance.packageName || 'pentestkit',
    packageVersion: artifact.packageVersion,
    extensionVersion: artifact.version,
    manifestVersion: artifact.manifestVersion,
    automationEnabledDefault: artifact.automationEnabledDefault,
    artifact,
    manifests: {
      chromiumMv3: fs.existsSync(chromiumManifestPath)
        ? chromiumManifestPath
        : path.join(extensionsDir(options), CHROMIUM_MANIFEST_COMPAT_FILE),
      firefoxMv2: fs.existsSync(firefoxManifestPath)
        ? firefoxManifestPath
        : path.join(extensionsDir(options), FIREFOX_MANIFEST_COMPAT_FILE)
    },
    provenance: artifact.provenance
  };
}

function ensureUnpackedPtkExtension(options = {}) {
  const explicit = options.extensionPath || process.env.PTK_EXTENSION_PATH || process.env.PTK_EXTENSION_DIR;
  if (explicit) {
    const resolved = path.resolve(explicit);
    const { manifest } = validateAutomationExtensionDir(resolved);
    return {
      browser: 'chromium',
      format: 'unpacked',
      type: 'directory',
      path: resolved,
      version: manifest.version || null,
      packageVersion: null,
      sha256: '',
      size: 0,
      manifestVersion: Number(manifest.manifest_version) || null,
      automationEnabled: true,
      automationEnabledDefault: true,
      provenance: null,
      source: 'explicit'
    };
  }
  const artifact = resolvePtkExtensionArtifact(options);
  const destination = path.join(
    automationCacheRoot(options),
    'extensions',
    `ptk-chromium-${sanitizePathPart(artifact.version)}-${artifact.sha256.slice(0, 16)}`
  );
  const markerPath = path.join(destination, '.ptk-artifact.json');
  if (fs.existsSync(markerPath)) {
    try {
      const marker = readJson(markerPath);
      if (marker.artifactSha256 === artifact.sha256) {
        validateAutomationExtensionDir(destination);
        return { ...artifact, format: 'unpacked', type: 'directory', path: destination, source: 'cache' };
      }
    } catch (_) {
      // Re-extract below.
    }
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  extractZipToDir(artifact.path, destination);
  validateAutomationExtensionDir(destination);
  writeJson(markerPath, {
    artifactSha256: artifact.sha256,
    artifactPath: artifact.path,
    extractedAt: new Date().toISOString()
  });
  return { ...artifact, format: 'unpacked', type: 'directory', path: destination, source: 'extracted' };
}

function resolvePtkCrxKeyPath(options = {}) {
  const explicit = options.keyPath || process.env.PTK_CRX_KEY;
  if (explicit) return path.resolve(explicit);
  return path.join(automationCacheRoot(options), 'keys', 'ptk-automation-crx.pem');
}

function chromeCandidates(options = {}) {
  return [
    options.chromeBinary,
    process.env.CHROME_BIN,
    'google-chrome',
    'google-chrome-stable',
    'chrome',
    'chromium',
    'chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  ].filter(Boolean);
}

function findChromeBinary(options = {}) {
  for (const candidate of chromeCandidates(options)) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Unable to locate Chrome/Chromium for CRX generation. Set CHROME_BIN or provide chromeBinary.');
}

function keyHash(keyPath) {
  return fs.existsSync(keyPath) ? sha256File(keyPath).slice(0, 16) : 'new-key';
}

function resolvedPtkCrxPath(options = {}) {
  const explicit = options.crxPath || process.env.PTK_EXTENSION_CRX;
  return {
    explicit: Boolean(explicit),
    path: explicit ? path.resolve(explicit) : path.join(extensionsDir(options), CANONICAL_CRX_FILE)
  };
}

function validateResolvedPtkCrxArtifact(bundledPath, explicit, options = {}) {
  const header = fs.readFileSync(bundledPath).subarray(0, 4).toString('ascii');
  if (header !== 'Cr24') throw new Error(`PTK CRX has an invalid header: ${bundledPath}`);
  const canonical = resolvePtkExtensionArtifact(options);
  const sha256 = sha256File(bundledPath);
  const provenance = canonical.provenance || {};
  if (!explicit && provenance?.hashes?.crxSha256 && provenance.hashes.crxSha256 !== sha256) {
    throw new Error('Bundled PTK CRX hash does not match extension provenance.');
  }
  return {
    ...canonical,
    format: 'crx',
    type: 'crx',
    path: bundledPath,
    sha256,
    size: fs.statSync(bundledPath).size,
    source: explicit ? 'explicit' : 'bundled-package'
  };
}

function ensurePtkCrx(options = {}) {
  const resolved = resolvedPtkCrxPath(options);
  if (fs.existsSync(resolved.path)) {
    return validateResolvedPtkCrxArtifact(resolved.path, resolved.explicit, options);
  }
  const unpacked = ensureUnpackedPtkExtension(options);
  const keyPath = resolvePtkCrxKeyPath(options);
  const keyExists = fs.existsSync(keyPath);
  const keyPart = keyHash(keyPath);
  const crxPath = path.join(
    automationCacheRoot(options),
    'extensions',
    `ptk-chromium-${sanitizePathPart(unpacked.version)}-${unpacked.sha256.slice(0, 16)}-${keyPart}.crx`
  );
  if (fs.existsSync(crxPath)) {
    return { ...unpacked, format: 'crx', type: 'crx', path: crxPath, size: fs.statSync(crxPath).size, sha256: sha256File(crxPath), keyPath, source: 'cache' };
  }

  const chromeBinary = findChromeBinary(options);
  const generatedCrx = `${unpacked.path}.crx`;
  const generatedPem = `${unpacked.path}.pem`;
  fs.rmSync(generatedCrx, { force: true });
  fs.rmSync(generatedPem, { force: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const args = [`--pack-extension=${unpacked.path}`];
  if (keyExists) args.push(`--pack-extension-key=${keyPath}`);
  const result = spawnSync(chromeBinary, args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`Chrome failed to generate PTK CRX: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status}`}`);
  }
  if (!fs.existsSync(generatedCrx)) {
    throw new Error('Chrome did not produce a PTK CRX.');
  }
  if (!keyExists) {
    if (!fs.existsSync(generatedPem)) throw new Error('Chrome did not produce a CRX private key.');
    fs.renameSync(generatedPem, keyPath);
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch (_) {
      // Best effort for platforms without POSIX modes.
    }
  }
  const finalCrxPath = keyExists ? crxPath : path.join(
    automationCacheRoot(options),
    'extensions',
    `ptk-chromium-${sanitizePathPart(unpacked.version)}-${unpacked.sha256.slice(0, 16)}-${keyHash(keyPath)}.crx`
  );
  fs.renameSync(generatedCrx, finalCrxPath);
  return { ...unpacked, format: 'crx', type: 'crx', path: finalCrxPath, size: fs.statSync(finalCrxPath).size, sha256: sha256File(finalCrxPath), keyPath, source: 'generated' };
}

function resolvePtkCrxArtifact(options = {}) {
  const resolved = resolvedPtkCrxPath(options);
  if (!fs.existsSync(resolved.path)) return ensurePtkCrx(options);
  return validateResolvedPtkCrxArtifact(resolved.path, resolved.explicit, options);
}

function resolvePtkXpiArtifact(options = {}) {
  const explicit = options.xpiPath || process.env.PTK_EXTENSION_XPI_PATH || process.env.PTK_FIREFOX_XPI;
  const bundledPath = explicit
    ? path.resolve(explicit)
    : path.join(extensionsDir(options), CANONICAL_XPI_FILE);
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`PTK Firefox XPI not found: ${bundledPath}`);
  }
  const header = fs.readFileSync(bundledPath).subarray(0, 4).toString('binary');
  if (!header.startsWith('PK')) throw new Error(`PTK XPI is not a ZIP archive: ${bundledPath}`);
  const canonical = resolvePtkFirefoxZipArtifact(options);
  const manifest = validateManifest(readZipJson(bundledPath, 'manifest.json'), 'Firefox XPI');
  const canonicalManifest = readZipJson(canonical.path, 'manifest.json');
  if (JSON.stringify(manifest) !== JSON.stringify(canonicalManifest)) {
    throw new Error('Bundled PTK XPI manifest does not match the Firefox ZIP manifest.');
  }
  if (readZipFile(bundledPath, DEV_LOCAL_FILE)) {
    throw new Error(`PTK Firefox XPI must not include ${DEV_LOCAL_FILE}`);
  }
  const sha256 = sha256File(bundledPath);
  const provenance = canonical.provenance || {};
  if (!explicit && provenance?.hashes?.xpiSha256 && provenance.hashes.xpiSha256 !== sha256) {
    throw new Error('Bundled PTK XPI hash does not match extension provenance.');
  }
  return {
    ...canonical,
    format: 'xpi',
    type: 'xpi',
    path: bundledPath,
    sha256,
    size: fs.statSync(bundledPath).size,
    manifestVersion: Number(manifest.manifest_version) || null,
    source: explicit ? 'explicit' : 'bundled-package'
  };
}

function runZip(sourceDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const result = spawnSync('zip', ['-q', '-r', zipPath, '.'], {
    cwd: sourceDir,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`zip failed while generating PTK XPI: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status}`}`);
  }
}

function ensurePtkXpi(options = {}) {
  const explicit = options.xpiPath || process.env.PTK_EXTENSION_XPI_PATH || process.env.PTK_FIREFOX_XPI;
  const bundledPath = explicit
    ? path.resolve(explicit)
    : path.join(extensionsDir(options), CANONICAL_XPI_FILE);
  if (fs.existsSync(bundledPath)) return resolvePtkXpiArtifact(options);
  const artifact = resolvePtkExtensionArtifact(options);
  if (artifact.provenance?.artifactSource === PTKLABS_AUTOMATION_ARTIFACT_SOURCE) {
    throw new Error('PTK Labs automation artifacts do not include a Firefox/XPI build yet.');
  }
  const preferredFirefoxManifestPath = path.join(extensionsDir(options), FIREFOX_MANIFEST_FILE);
  const firefoxManifestPath = fs.existsSync(preferredFirefoxManifestPath)
    ? preferredFirefoxManifestPath
    : path.join(extensionsDir(options), FIREFOX_MANIFEST_COMPAT_FILE);
  if (!fs.existsSync(firefoxManifestPath)) throw new Error(`Firefox MV2 manifest template not found: ${firefoxManifestPath}`);
  const xpiPath = path.join(
    automationCacheRoot(options),
    'extensions',
    `ptk-firefox-${sanitizePathPart(artifact.version)}-${artifact.sha256.slice(0, 16)}.xpi`
  );
  if (fs.existsSync(xpiPath)) {
    return { ...artifact, browser: 'firefox', format: 'xpi', type: 'xpi', path: xpiPath, size: fs.statSync(xpiPath).size, sha256: sha256File(xpiPath), manifestVersion: 2, source: 'cache' };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-firefox-xpi-'));
  try {
    extractZipToDir(artifact.path, tempDir);
    fs.copyFileSync(firefoxManifestPath, path.join(tempDir, 'manifest.json'));
    validateAutomationExtensionDir(tempDir);
    runZip(tempDir, xpiPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return { ...artifact, browser: 'firefox', format: 'xpi', type: 'xpi', path: xpiPath, size: fs.statSync(xpiPath).size, sha256: sha256File(xpiPath), manifestVersion: 2, source: 'generated' };
}

module.exports = {
  PTKLABS_AUTOMATION_ARTIFACT_SOURCE,
  PTKLABS_AUTOMATION_SERVICE_WORKER,
  automationCacheRoot,
  ensurePtkCrx,
  ensurePtkXpi,
  ensureUnpackedPtkExtension,
  getPtkExtensionMetadata,
  resolvePtkCrxKeyPath,
  resolvePtkCrxArtifact,
  resolvePtkExtensionArtifact,
  resolvePtkFirefoxZipArtifact,
  resolvePtkXpiArtifact,
  sha256File,
  validateAutomationExtensionDir,
  validateAutomationZipArtifact
};
