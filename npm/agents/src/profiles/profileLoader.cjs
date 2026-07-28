'use strict';

const fs = require('fs');
const { normalizeCrawlData } = require('./crawlData.cjs');

function loadProfile(input) {
  const profile = typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : JSON.parse(JSON.stringify(input || {}));
  const normalized = normalizeCrawlData(profile);
  validateProfile(normalized);
  return normalized;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('profile must be an object');
  if (profile.personas && !Array.isArray(profile.personas)) throw new Error('profile.personas must be an array');
  return true;
}

function redactProfile(profile) {
  const clone = JSON.parse(JSON.stringify(profile || {}));
  if (clone.password) clone.password = '[redacted]';
  if (clone.credentials) {
    for (const key of Object.keys(clone.credentials)) {
      if (/password|token|secret|cookie|authorization/i.test(key)) clone.credentials[key] = '[redacted]';
    }
  }
  for (const persona of clone.personas || []) {
    if (persona.password) persona.password = '[redacted]';
    if (persona.credentials) {
      for (const key of Object.keys(persona.credentials)) {
        if (/password|token|secret|cookie|authorization/i.test(key)) persona.credentials[key] = '[redacted]';
      }
    }
    if (persona.token) persona.token = '[redacted]';
  }
  return clone;
}

module.exports = {
  loadProfile,
  validateProfile,
  redactProfile
};
