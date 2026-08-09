#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const PACKAGE_NAME = 'pentestkit';
const DIST_TAGS = new Set(['next', 'latest']);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    extensionTag: null,
    extensionVersion: null,
    chromiumExtensionVersion: null,
    firefoxExtensionVersion: null,
    packageVersion: null,
    distTag: null,
    provenanceSha256: null,
    checkRegistry: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--extension-tag') options.extensionTag = argv[++index];
    else if (arg === '--extension-version') options.extensionVersion = argv[++index];
    else if (arg === '--chromium-extension-version') options.chromiumExtensionVersion = argv[++index];
    else if (arg === '--firefox-extension-version') options.firefoxExtensionVersion = argv[++index];
    else if (arg === '--package-version') options.packageVersion = argv[++index];
    else if (arg === '--dist-tag') options.distTag = argv[++index];
    else if (arg === '--provenance-sha256') options.provenanceSha256 = argv[++index];
    else if (arg === '--check-registry') options.checkRegistry = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function parseBrowserExtensionVersion(value, label) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/);
  if (!match) {
    throw new Error(`${label} must contain three or four numeric version components: ${normalized || '(empty)'}`);
  }
  return {
    value: normalized,
    core: match.slice(1, 4).join('.'),
    numbers: match.slice(1, 5).filter((part) => part !== undefined).map((part) => Number.parseInt(part, 10))
  };
}

function parseSemver(value, label) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`${label} must be valid npm semver: ${normalized || '(empty)'}`);
  return {
    value: normalized,
    core: match.slice(1, 4).join('.'),
    numbers: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    prerelease: match[4] || null
  };
}

function compareCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] > right.numbers[index]) return 1;
    if (left.numbers[index] < right.numbers[index]) return -1;
  }
  return 0;
}

function validateReleaseIntent(options = {}) {
  const extension = parseSemver(options.extensionVersion, '--extension-version');
  if (extension.prerelease) {
    throw new Error('--extension-version must be a final three-part release version');
  }
  const chromiumExtension = parseBrowserExtensionVersion(
    options.chromiumExtensionVersion || extension.value,
    '--chromium-extension-version'
  );
  const firefoxExtension = parseBrowserExtensionVersion(
    options.firefoxExtensionVersion || extension.value,
    '--firefox-extension-version'
  );
  const packageVersion = parseSemver(options.packageVersion, '--package-version');
  const extensionTag = String(options.extensionTag || '').trim();
  if (!/^v?[0-9A-Za-z.+-]+$/.test(extensionTag) || extensionTag.replace(/^v/, '') !== extension.value) {
    throw new Error(`--extension-tag must be ${extension.value} or v${extension.value}`);
  }
  const distTag = String(options.distTag || '').trim();
  if (!DIST_TAGS.has(distTag)) throw new Error('--dist-tag must be next or latest');
  if (packageVersion.core !== extension.core) {
    throw new Error(`Package core version ${packageVersion.core} must match extension version ${extension.core}`);
  }
  for (const [label, browserVersion] of [
    ['Chromium', chromiumExtension],
    ['Firefox', firefoxExtension]
  ]) {
    if (browserVersion.core !== extension.core) {
      throw new Error(`${label} extension version ${browserVersion.value} must belong to release family ${extension.core}`);
    }
  }
  if (distTag === 'next' && !packageVersion.prerelease) {
    throw new Error('The next dist-tag requires a prerelease package version such as 9.9.8-rc.1');
  }
  if (distTag === 'latest' && packageVersion.prerelease) {
    throw new Error('The latest dist-tag requires a final package version');
  }
  if (distTag === 'latest' && packageVersion.value !== extension.value) {
    throw new Error('A latest release package version must exactly match the extension version');
  }
  const provenanceSha256 = String(options.provenanceSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provenanceSha256)) {
    throw new Error('--provenance-sha256 must be a 64-character SHA-256 digest');
  }
  return {
    extensionTag,
    extensionVersion: extension.value,
    chromiumExtensionVersion: chromiumExtension.value,
    firefoxExtensionVersion: firefoxExtension.value,
    packageVersion: packageVersion.value,
    distTag,
    provenanceSha256
  };
}

function npmJson(args, options = {}) {
  const runner = options.npmRunner || spawnSync;
  const result = runner('npm', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  });
  const stdout = String(result.stdout || '').trim();
  if (result.status !== 0) return { ok: false, stdout, stderr: String(result.stderr || '').trim() };
  try {
    return { ok: true, value: stdout ? JSON.parse(stdout) : null };
  } catch (error) {
    throw new Error(`npm ${args.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

function verifyRegistryAvailability(packageVersion, options = {}) {
  const versionsResult = npmJson(['view', PACKAGE_NAME, 'versions', '--json'], options);
  if (!versionsResult.ok || !Array.isArray(versionsResult.value)) {
    throw new Error(`Unable to read ${PACKAGE_NAME} versions from npm: ${versionsResult.stderr || versionsResult.stdout || 'unknown error'}`);
  }
  if (versionsResult.value.includes(packageVersion)) {
    throw new Error(`${PACKAGE_NAME}@${packageVersion} already exists on npm`);
  }
  const candidate = parseSemver(packageVersion, '--package-version');
  const published = versionsResult.value.map((version) => {
    try {
      return parseSemver(version, 'published version');
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  const maximumCore = published.sort((left, right) => compareCore(right, left))[0] || null;
  if (maximumCore && compareCore(candidate, maximumCore) < 0) {
    throw new Error(`${PACKAGE_NAME}@${packageVersion} is lower than the published core version ${maximumCore.core}`);
  }
  return {
    packageName: PACKAGE_NAME,
    packageVersion,
    versionAvailable: true,
    maximumPublishedCore: maximumCore?.core || null
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log([
        'Validate an npm release request and optionally confirm version availability with --check-registry.',
        'Browser versions default to --extension-version; override an exceptional store version with',
        '--chromium-extension-version or --firefox-extension-version.'
      ].join('\n'));
      return 0;
    }
    const intent = validateReleaseIntent(options);
    const registry = options.checkRegistry ? verifyRegistryAvailability(intent.packageVersion) : null;
    console.log(JSON.stringify({ ok: true, ...intent, registry }, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DIST_TAGS,
  PACKAGE_NAME,
  compareCore,
  parseArgs,
  parseBrowserExtensionVersion,
  parseSemver,
  validateReleaseIntent,
  verifyRegistryAvailability
};
