#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARTIFACTS = Object.freeze([
  ['chromeZip', 'ptk-latest.zip'],
  ['firefoxZip', 'ptk-latest-firefox.zip'],
  ['crx', 'ptk-latest.crx'],
  ['xpi', 'ptk-latest.xpi']
]);
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireDirectory(value, label) {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${root}`);
  }
}

function nearestExistingAncestor(value) {
  let current = value;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve an existing parent for ${value}`);
    current = parent;
  }
  return current;
}

function verifyArtifact(source, metadata, label) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`${label} is missing: ${source}`);
  if (!metadata || !/^[0-9a-f]{64}$/.test(String(metadata.sha256 || ''))) {
    throw new Error(`${label} provenance is missing a valid SHA-256`);
  }
  const actualHash = sha256(source);
  if (actualHash !== metadata.sha256) throw new Error(`${label} SHA-256 does not match published package provenance`);
  const bytes = fs.statSync(source).size;
  if (Number(metadata.bytes) !== bytes) throw new Error(`${label} size does not match published package provenance`);
}

function prepareActionSmokeInput(packageRootValue, outputDirectoryValue, options = {}) {
  const repositoryRoot = requireDirectory(options.repositoryRoot || REPOSITORY_ROOT, 'repository root');
  const packageRoot = requireDirectory(packageRootValue, 'installed pentestkit package');
  const outputDirectory = path.resolve(outputDirectoryValue);
  assertContained(repositoryRoot, outputDirectory, 'output directory');
  if (outputDirectory === repositoryRoot) throw new Error('output directory must not be the repository root');
  const outputAncestor = fs.realpathSync(nearestExistingAncestor(outputDirectory));
  assertContained(repositoryRoot, outputAncestor, 'output directory');
  if (fs.existsSync(outputDirectory) && fs.lstatSync(outputDirectory).isSymbolicLink()) {
    throw new Error('output directory must not be a symbolic link');
  }
  const relativeToPackage = path.relative(packageRoot, outputDirectory);
  if (relativeToPackage === '' || (!relativeToPackage.startsWith(`..${path.sep}`) && relativeToPackage !== '..' && !path.isAbsolute(relativeToPackage))) {
    throw new Error('output directory must not be inside the installed pentestkit package');
  }

  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (manifest.name !== 'pentestkit' || !EXACT_SEMVER.test(String(manifest.version || ''))) {
    throw new Error('installed package must be an exact-version pentestkit package');
  }
  const extensions = path.join(packageRoot, 'extensions');
  const packagedProvenance = readJson(path.join(extensions, 'extension-provenance.json'));
  const sourceProvenance = packagedProvenance.automationArtifactProvenance;
  if (packagedProvenance.automationEnabledDefault !== true || !sourceProvenance || sourceProvenance.automationEnabledDefault !== true) {
    throw new Error('installed pentestkit package is not backed by an automation extension release');
  }
  const sourceChromiumVersion = sourceProvenance?.manifests?.chromium?.version;
  const sourceFirefoxVersion = sourceProvenance?.manifests?.firefox?.version;
  const packagedChromiumVersion = packagedProvenance?.manifests?.chromium?.version;
  const packagedFirefoxVersion = packagedProvenance?.manifests?.firefox?.version;
  if (
    !sourceChromiumVersion
    || !sourceFirefoxVersion
    || sourceProvenance.extensionVersion !== sourceChromiumVersion
    || packagedProvenance.extensionVersion !== sourceChromiumVersion
    || packagedChromiumVersion !== sourceChromiumVersion
    || packagedFirefoxVersion !== sourceFirefoxVersion
  ) {
    throw new Error('packaged and source extension provenance versions do not match');
  }

  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [key, packagedName] of ARTIFACTS) {
    const metadata = sourceProvenance.artifacts && sourceProvenance.artifacts[key];
    const source = path.join(extensions, packagedName);
    verifyArtifact(source, metadata, key);
    const destinationName = path.basename(String(metadata.path || ''));
    if (!destinationName || destinationName !== metadata.path || !/^[A-Za-z0-9._+-]+$/.test(destinationName)) {
      throw new Error(`${key} provenance contains an unsafe artifact path`);
    }
    fs.copyFileSync(source, path.join(outputDirectory, destinationName));
  }
  fs.writeFileSync(
    path.join(outputDirectory, 'extension-provenance-automation.json'),
    `${JSON.stringify(sourceProvenance, null, 2)}\n`,
    'utf8'
  );
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    extensionVersion: sourceProvenance.extensionVersion,
    chromiumExtensionVersion: sourceChromiumVersion,
    firefoxExtensionVersion: sourceFirefoxVersion,
    outputDirectory,
    artifacts: ARTIFACTS.map(([key]) => sourceProvenance.artifacts[key].path)
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('Usage: node prepare-action-smoke-input.cjs <installed-pentestkit-root> <output-directory>\n');
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(prepareActionSmokeInput(argv[0], argv[1]), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ARTIFACTS,
  REPOSITORY_ROOT,
  prepareActionSmokeInput,
  sha256,
  verifyArtifact
};
