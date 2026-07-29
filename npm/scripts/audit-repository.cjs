#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.release',
  '.release-input',
  '.ptk',
  '.ptk-agent',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'tmp',
  'venv'
]);
const REQUIRED_GITIGNORE_ENTRIES = [
  '.private-docs/',
  '.env',
  '.env.*',
  '!.env.example',
  '.release/',
  '.release-input/',
  '.ptk/',
  '.ptk-agent/',
  'dist/',
  'tmp/',
  'node_modules/',
  'build/',
  '.venv/',
  '.pytest_cache/',
  '.mypy_cache/',
  'coverage/',
  'playwright-report/',
  'test-results/',
  '*.log',
  '*.tgz',
  '*.crx',
  '*.xpi',
  '*.pem',
  '*.key',
  '__pycache__/',
  '*.egg-info/'
];

function walkRepository(root = REPOSITORY_ROOT) {
  const files = [];
  const errors = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && entry.name !== '.env.example' && /^\.env(?:\..+)?$/.test(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        errors.push(`Symlink is not allowed in initial repository contents: ${relative}`);
      } else if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relative });
      }
    }
  }
  visit(root);
  return { files, errors };
}

function suspiciousFileReason(relative) {
  const name = path.basename(relative);
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return 'environment secret file';
  if (/^untitled(?:[-_.]|$)/i.test(name) || /(?:^|[-_.])copy(?:[-_.]|$)/i.test(name)) return 'unreviewed scratch or duplicate file';
  if (/\.(?:pem|key|p12|pfx|sqlite|sqlite3|har|tgz|crx|xpi)$/i.test(name)) return 'secret or generated artifact';
  if (/\.(?:zip)$/i.test(name) && !relative.startsWith('npm/agents/test/fixtures/')) return 'generated archive';
  if (/^(?:playwright-report|test-results|coverage)(?:\/|$)/.test(relative)) return 'generated test output';
  return null;
}

function secretFindings(filePath, relative) {
  if (relative === 'npm/scripts/audit-repository.cjs') return [];
  if (!/\.(?:cjs|js|json|md|mjs|py|sh|toml|txt|ya?ml)$/i.test(relative)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const findings = [];
  const patterns = [
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
    ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/g],
    ['npm auth token setting', /\/\/[\w.-]+\/?\s*:_authToken\s*=\s*[^$\s][^\s]*/g],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['developer-specific home path', /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//g],
    ['known local test credential', /\b(?:ptk@test\.com|P@ssword)\b/g]
  ];
  for (const [label, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (relative === 'npm/scripts/prepare-npm-package.cjs' && label === 'known local test credential') continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(`${label} in ${relative}:${line}`);
    }
  }
  return findings;
}

function documentationAudienceFindings(filePath, relative) {
  if (!relative.endsWith('.md')) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const findings = [];
  const patterns = [
    ['repository housekeeping', /\b(?:do not commit|must stay out of source control)\b/i],
    ['local release path', /(?:^|[\s`'"(])(?:npm\/)?\.release(?:\/|\b)/im],
    ['local extension source path', /(?:^|[\s`'"(])(?:\/[^\s`'")]+\/)?ptk-agent\/dist(?:\/|\b)/im],
    ['release provenance input', /extension-provenance-automation\.json/i],
    ['extension signing operation', /\bCRX private key\b/i],
    ['provider cache implementation', /\b(?:provider-cache|account-context fingerprint)\b/i],
    ['account-specific test evidence', /\b(?:live matrix|release[- ]candidate (?:matrix|result|evidence))\b/i],
    ['incorrect npm package identity', /@ptklabs\/agent\b/i],
    ['obsolete GitHub Action repository', /ptklabs\/owasp-ptk-action\b/i]
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${label} in ${relative}`);
  }
  return findings;
}

function verifyGitignore(root = REPOSITORY_ROOT) {
  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return ['Missing repository .gitignore'];
  const entries = new Set(fs.readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')));
  return REQUIRED_GITIGNORE_ENTRIES
    .filter((entry) => !entries.has(entry))
    .map((entry) => `.gitignore must exclude ${entry}`);
}

function auditRepository(root = REPOSITORY_ROOT) {
  const resolvedRoot = path.resolve(root);
  const walked = walkRepository(resolvedRoot);
  const errors = [...walked.errors, ...verifyGitignore(resolvedRoot)];
  for (const file of walked.files) {
    const reason = suspiciousFileReason(file.relative);
    if (reason) errors.push(`${reason}: ${file.relative}`);
    errors.push(...secretFindings(file.fullPath, file.relative));
    errors.push(...documentationAudienceFindings(file.fullPath, file.relative));
  }
  if (errors.length) {
    throw new Error(`Repository audit failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
  return {
    ok: true,
    repositoryRoot: resolvedRoot,
    scannedFiles: walked.files.length,
    excludedDirectories: Array.from(EXCLUDED_DIRECTORIES).sort()
  };
}

function main() {
  try {
    console.log(JSON.stringify(auditRepository(), null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EXCLUDED_DIRECTORIES,
  REPOSITORY_ROOT,
  auditRepository,
  documentationAudienceFindings,
  secretFindings,
  suspiciousFileReason,
  verifyGitignore,
  walkRepository
};
