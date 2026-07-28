'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const extensions = require('../../../extensions/index.cjs');
const { redact, redactString } = require('../../../browser/src/redact.cjs');

function envValue(env, name, fallback = '') {
  const value = env && env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listEnv(env, name) {
  const value = envValue(env, name);
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function resolvePath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function resolveAutomationZipArtifact(options = {}) {
  const env = options.env || process.env;
  const explicit = resolvePath(
    options.extensionZip ||
      envValue(env, 'PTK_EXTENSION_ZIP') ||
      envValue(env, 'PTK_AUTOMATION_EXTENSION_ZIP')
  );
  if (explicit) {
    return extensions.validateAutomationZipArtifact(explicit, {
      packageRoot: options.packageRoot
    });
  }
  return extensions.resolvePtkExtensionArtifact({
    packageRoot: options.packageRoot
  });
}

function providerCacheRoot(options = {}) {
  return path.join(
    extensions.automationCacheRoot({
      cacheRoot: options.cacheRoot
    }),
    'provider-cache'
  );
}

function normalizeUploadCacheMode(value) {
  const mode = String(value || 'reuse').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'reuse', 'read-write'].includes(mode)) return 'reuse';
  if (['0', 'false', 'no', 'off', 'none', 'disabled'].includes(mode)) return 'off';
  if (['refresh', 'force', 'force-upload', 'replace'].includes(mode)) return 'refresh';
  throw new Error(`Invalid PTK_EXTENSION_UPLOAD_CACHE: ${value}. Expected reuse, refresh, or off.`);
}

function extensionUploadCacheMode(options = {}) {
  const env = options.env || process.env;
  return normalizeUploadCacheMode(options.extensionUploadCache || envValue(env, 'PTK_EXTENSION_UPLOAD_CACHE') || 'reuse');
}

function stableIdentity(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(stableIdentity).join('\0');
  if (typeof value === 'object') {
    return Object.keys(value).sort().map((key) => `${key}=${stableIdentity(value[key])}`).join('\0');
  }
  return String(value);
}

function cacheScopeFingerprint(options = {}) {
  const identity = stableIdentity(options.uploadCacheScope || 'unscoped');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function accountScopedOptions(provider, identity, options = {}) {
  const normalized = stableIdentity(identity);
  if (!normalized) {
    return {
      ...options,
      extensionUploadCache: 'off'
    };
  }
  return {
    ...options,
    uploadCacheScope: [provider, normalized]
  };
}

function cacheFileFor(provider, artifact, options = {}) {
  return path.join(
    providerCacheRoot(options),
    String(provider || 'provider').replace(/[^A-Za-z0-9_.-]/g, '_'),
    `scope-${cacheScopeFingerprint(options)}`,
    `${artifact.type || artifact.format || 'zip'}-${artifact.sha256}.json`
  );
}

function readCachedUpload(provider, artifact, options = {}) {
  const mode = extensionUploadCacheMode(options);
  if (mode === 'off' || mode === 'refresh') return null;
  const filePath = cacheFileFor(provider, artifact, options);
  if (!fs.existsSync(filePath)) return null;
  const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (cached.artifactSha256 && cached.artifactSha256 !== artifact.sha256) return null;
  if (cached.artifactType && cached.artifactType !== (artifact.type || artifact.format)) return null;
  return cached;
}

function writeCachedUpload(provider, artifact, payload, options = {}) {
  if (extensionUploadCacheMode(options) === 'off') return null;
  const filePath = cacheFileFor(provider, artifact, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    provider,
    cacheScope: cacheScopeFingerprint(options),
    artifactType: artifact.type || artifact.format,
    artifactSha256: artifact.sha256,
    cachedAt: new Date().toISOString(),
    ...payload
  }, null, 2)}\n`, 'utf8');
  return filePath;
}

function redactSecrets(value, secrets = []) {
  let redacted = redact(value);
  if (!Array.isArray(secrets) || secrets.length === 0) return redacted;
  const secretValues = secrets
    .flatMap((secret) => {
      const value = String(secret || '');
      return [value, encodeURIComponent(value)];
    })
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  function visit(item) {
    if (typeof item === 'string') {
      let text = redactString(item);
      for (const secret of secretValues) text = text.split(secret).join('[redacted]');
      return text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]));
  }
  redacted = visit(redacted);
  return redacted;
}

function safeProviderErrorMessage(error, secrets = []) {
  return redactSecrets(String(error && error.message || error || 'Provider request failed'), secrets);
}

function safeProviderMetadata(value, secrets = []) {
  return redactSecrets(value, secrets);
}

function definePrivateProperty(target, name, value) {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: false,
    writable: false,
    value
  });
  return target;
}

function walkFiles(root) {
  const out = [];
  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  visit(root);
  return out;
}

function hashDirectory(root) {
  const hash = crypto.createHash('sha256');
  for (const filePath of walkFiles(root)) {
    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createZipFromDirectory(sourceDir, zipPath, options = {}) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) return zipPath;
  const args = ['-q', '-r'];
  if (options.compressionLevel !== undefined) args.push(`-${Number(options.compressionLevel)}`);
  args.push(zipPath, '.');
  if (Array.isArray(options.exclude) && options.exclude.length) args.push('-x', ...options.exclude);
  const result = spawnSync('zip', args, {
    cwd: sourceDir,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Unable to run zip while packaging ${sourceDir}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`zip failed while packaging ${sourceDir}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return zipPath;
}

function recompressAutomationZip(options = {}) {
  const unpacked = extensions.ensureUnpackedPtkExtension({
    packageRoot: options.packageRoot,
    cacheRoot: options.cacheRoot
  });
  const validation = extensions.validateAutomationExtensionDir(unpacked.path);
  const treeHash = hashDirectory(unpacked.path);
  const version = String(validation.manifest.version || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const suffix = options.excludeSourceMaps === true ? 'zip9-nomap' : 'zip9';
  const zipPath = path.join(
    extensions.automationCacheRoot({ cacheRoot: options.cacheRoot }),
    'generated',
    `ptk-automation-${version}-${suffix}-${treeHash.slice(0, 16)}.zip`
  );
  createZipFromDirectory(unpacked.path, zipPath, {
    compressionLevel: 9,
    exclude: options.excludeSourceMaps === true ? ['*.map', '*/*.map', '*/*/*.map', '*/*/*/*.map'] : []
  });
  return {
    ...extensions.validateAutomationZipArtifact(zipPath, {
      packageRoot: options.packageRoot
    }),
    source: options.excludeSourceMaps === true ? 'package-recompressed-without-source-maps' : 'package-recompressed'
  };
}

function resultsDir(provider, framework, options = {}) {
  const env = options.env || process.env;
  const key = `PTK_${String(framework || '').toUpperCase()}_RESULTS_DIR`;
  const root = (envValue(env, 'PTK_RESULTS_ROOT') || envValue(env, 'PTK_RESULTS_DIR') || `.runs/${provider}`).replace(/\/$/, '');
  return envValue(env, key, `${root}/${framework}`);
}

function validateOnlyEnabled(options = {}) {
  const env = options.env || process.env;
  return toBoolean(envValue(env, 'PTK_VALIDATE_ONLY'), false);
}

module.exports = {
  accountScopedOptions,
  cacheFileFor,
  cacheScopeFingerprint,
  createZipFromDirectory,
  envValue,
  extensionUploadCacheMode,
  listEnv,
  providerCacheRoot,
  readCachedUpload,
  recompressAutomationZip,
  resolveAutomationZipArtifact,
  resultsDir,
  safeProviderErrorMessage,
  safeProviderMetadata,
  definePrivateProperty,
  toBoolean,
  toNumber,
  validateOnlyEnabled,
  writeCachedUpload
};
