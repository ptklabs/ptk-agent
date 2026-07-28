'use strict';

const crypto = require('crypto');

function stableHash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function normalizeOrigin(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function createSiteFingerprint({ baseUrl, appBuildFingerprint = null } = {}) {
  const origin = normalizeOrigin(baseUrl);
  const siteKey = stableHash(origin || baseUrl || 'unknown-site');
  return {
    schemaVersion: 'ptk-agent-v2-site-fingerprint',
    siteKey,
    origin,
    baseUrl: baseUrl || null,
    appBuildFingerprint: appBuildFingerprint || null
  };
}

module.exports = {
  createSiteFingerprint,
  normalizeOrigin,
  stableHash
};
