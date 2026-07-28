'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPtkExtensionDir(candidate) {
  if (!candidate) return false;
  try {
    const resolved = fs.realpathSync(candidate);
    const manifestPath = path.join(resolved, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = readJson(manifestPath);
    const serviceWorker = manifest.background && manifest.background.service_worker;
    const backgroundPage = manifest.background && manifest.background.page;
    const backgroundEntry = serviceWorker || backgroundPage;
    if (!backgroundEntry) return false;
    if (!fs.existsSync(path.join(resolved, backgroundEntry))) return false;
    const name = `${manifest.name || ''} ${manifest.short_name || ''} ${manifest.description || ''}`.toLowerCase();
    return name.includes('penetration testing kit')
      || name.includes('owasp ptk')
      || name.includes('ptk');
  } catch (_) {
    return false;
  }
}

function readExtensionManifest(extensionPath) {
  if (!extensionPath) return null;
  try {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return readJson(manifestPath);
  } catch (_) {
    return null;
  }
}

function ancestorDirs(startDir) {
  const out = [];
  let current = path.resolve(startDir || process.cwd());
  while (!out.includes(current)) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function resolvePath(value, baseDir) {
  if (!value) return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir || process.cwd(), value);
}

function realpathIfExists(candidate) {
  if (!candidate) return null;
  try {
    return fs.realpathSync(candidate);
  } catch (_) {
    return path.resolve(candidate);
  }
}

function findLocalDevExtensionPath({ cwd = process.cwd(), configPath = null } = {}) {
  const roots = new Set();
  roots.add(cwd || process.cwd());
  if (configPath) roots.add(path.dirname(path.resolve(configPath)));
  for (const root of Array.from(roots)) {
    for (const dir of ancestorDirs(root)) {
      for (const candidate of [
        path.join(dir, 'src'),
        path.join(dir, 'pentestkit', 'src')
      ]) {
        if (isPtkExtensionDir(candidate)) return realpathIfExists(candidate);
      }
    }
  }
  return null;
}

function bundledPackageRootFromHere() {
  return path.resolve(__dirname, '..', '..', '..');
}

function isInstalledPackageRoot(packageRoot) {
  return path.resolve(packageRoot || '').split(path.sep).includes('node_modules');
}

function findBundledExtensionPath({ packageRoot = bundledPackageRootFromHere() } = {}) {
  const candidate = path.resolve(packageRoot, 'extensions', 'chromium-unpacked');
  return isPtkExtensionDir(candidate) ? realpathIfExists(candidate) : null;
}

function ensureBundledExtensionPath({ packageRoot = bundledPackageRootFromHere(), cwd = process.cwd(), env = process.env } = {}) {
  const legacy = findBundledExtensionPath({ packageRoot });
  if (legacy) return legacy;
  const helperPath = path.resolve(packageRoot, 'extensions', 'index.cjs');
  if (!fs.existsSync(helperPath)) return null;
  try {
    const helpers = require(helperPath);
    const result = helpers.ensureUnpackedPtkExtension({
      packageRoot,
      cacheRoot: env.PTK_EXTENSION_CACHE_DIR || env.PTK_AUTOMATION_CACHE_DIR || path.join(cwd, '.ptk')
    });
    return result && result.path && isPtkExtensionDir(result.path) ? realpathIfExists(result.path) : null;
  } catch (_) {
    return null;
  }
}

function readBundledProvenance({ packageRoot = bundledPackageRootFromHere() } = {}) {
  const provenancePath = path.resolve(packageRoot, 'extensions', 'extension-provenance.json');
  if (!fs.existsSync(provenancePath)) return null;
  try {
    return readJson(provenancePath);
  } catch (_) {
    return null;
  }
}

function buildResolution(source, extensionPath, extra = {}) {
  const resolvedPath = extensionPath ? realpathIfExists(extensionPath) : null;
  const manifest = readExtensionManifest(resolvedPath);
  return {
    source,
    path: resolvedPath,
    kind: resolvedPath && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory() ? 'unpacked-directory' : 'artifact-file',
    extensionVersion: manifest && manifest.version || null,
    manifestVersion: manifest && manifest.manifest_version || null,
    provenance: extra.provenance || null,
    reason: extra.reason || null
  };
}

function resolvePtkExtensionPath(options = {}) {
  const cwd = options.cwd || process.cwd();
  const configPath = options.configPath || null;
  const env = options.env || process.env;
  const packageRoot = options.packageRoot || bundledPackageRootFromHere();
  const autoDetectExtension = options.autoDetectExtension !== false;
  const explicitPath = options.extensionPath || options.configuredPath || null;

  if (explicitPath) {
    const baseDir = configPath ? path.dirname(path.resolve(configPath)) : cwd;
    return buildResolution('explicit', resolvePath(explicitPath, baseDir));
  }

  const envPath = env.PTK_EXTENSION_DIR || env.PTK_EXTENSION_PATH || null;
  if (envPath) {
    return buildResolution(env.PTK_EXTENSION_DIR ? 'env:PTK_EXTENSION_DIR' : 'env:PTK_EXTENSION_PATH', resolvePath(envPath, cwd));
  }

  const bundled = ensureBundledExtensionPath({ packageRoot, cwd, env });
  if (bundled) {
    return buildResolution('bundled-package', bundled, {
      provenance: readBundledProvenance({ packageRoot })
    });
  }

  const allowLocalDev = env.PTK_ALLOW_LOCAL_DEV_EXTENSION === '1' || !isInstalledPackageRoot(packageRoot);
  if (autoDetectExtension && allowLocalDev) {
    const localDev = findLocalDevExtensionPath({ cwd, configPath });
    if (localDev) return buildResolution('local-dev', localDev);
  }

  return buildResolution('none', null, { reason: 'ptk_extension_not_found' });
}

module.exports = {
  ancestorDirs,
  findBundledExtensionPath,
  ensureBundledExtensionPath,
  findLocalDevExtensionPath,
  findPtkExtensionPath: findLocalDevExtensionPath,
  isPtkExtensionDir,
  isInstalledPackageRoot,
  readBundledProvenance,
  readExtensionManifest,
  realpathIfExists,
  resolvePtkExtensionPath
};
