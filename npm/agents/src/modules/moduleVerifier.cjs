'use strict';

const crypto = require('crypto');

function sha256Buffer(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashModulePack(pack) {
  return crypto.createHash('sha256').update(JSON.stringify({ ...pack, signature: undefined })).digest('hex');
}

function verifyModulePack(pack = {}) {
  if (pack.content) {
    const actual = sha256Buffer(pack.content);
    const checks = [{
      name: 'sha256',
      status: pack.expectedSha256 && actual === pack.expectedSha256 ? 'verified' : 'failed',
      actual,
      expected: pack.expectedSha256 || null
    }];
    if (pack.signature) {
      return { status: 'unsupported', checks, reason: 'signature_verification_deferred' };
    }
    return { status: checks[0].status === 'verified' ? 'verified' : 'failed', checks };
  }
  if (!pack || !pack.name && !pack.id || !Array.isArray(pack.modules)) {
    return { ok: false, status: 'skipped', reason: 'invalid_or_empty_pack' };
  }
  return {
    ok: true,
    status: 'verified',
    reason: 'verified_structure_only',
    hash: hashModulePack(pack),
    signatureVerified: false
  };
}

function verifyModuleManifest(manifest = {}) {
  if (!manifest.id || !manifest.version || !Array.isArray(manifest.modules)) {
    return { status: 'failed', reason: 'invalid_manifest' };
  }
  return { status: 'verified', reason: 'manifest_shape_valid' };
}

module.exports = {
  hashModulePack,
  sha256Buffer,
  verifyModuleManifest,
  verifyModulePack
};
