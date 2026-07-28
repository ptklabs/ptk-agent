'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyProfileOverrides,
  createPersonaSession,
  createValueGenerator,
  loadCrawlData,
  loadProfile,
  normalizeCrawlData,
  redactProfile,
  resolvePersona
} = require('../../../src/profiles/index.cjs');

const profileInput = {
  version: 'ptk-profile-v2',
  name: 'shop',
  personas: [
    {
      id: 'buyer',
      role: 'customer',
      credentials: {
        username: 'buyer@example.test',
        password: 'secret-password'
      },
      values: {
        email: 'buyer@example.test'
      }
    },
    {
      id: 'admin',
      role: 'admin',
      credentials: {
        token: 'admin-token'
      }
    }
  ]
};

test('profile loader normalizes personas and redacts secrets', () => {
  const profile = loadProfile(profileInput);
  const buyer = resolvePersona(profile, 'buyer');
  const redacted = redactProfile(profile);

  assert.equal(buyer.credentials.password, 'secret-password');
  assert.equal(redacted.personas[0].credentials.password, '[redacted]');
  assert.equal(redacted.personas[1].credentials.token, '[redacted]');
});

test('persona session exposes redacted persona data and refuses fake switches', async () => {
  const session = createPersonaSession({ profile: profileInput, activePersonaId: 'buyer' });

  assert.equal(session.getActivePersona().credentials.password, '[redacted]');
  assert.equal(session.getCredential('password'), '[redacted]');
  assert.equal(session.getCredential('password', { includeSecrets: true }), 'secret-password');

  const switchResult = await session.switchPersona('admin');
  assert.equal(switchResult.status, 'unsupported');
});

test('value generator is deterministic and respects persona field overrides', () => {
  const generator = createValueGenerator({ seed: 'fixed' });
  const buyer = resolvePersona(loadProfile(profileInput), 'buyer');
  const generated = generator.valueForField({ name: 'username' }, buyer);
  const overridden = generator.valueForField({ name: 'email' }, buyer);

  assert.equal(generated.value, createValueGenerator({ seed: 'fixed' }).valueForField({ name: 'username' }, buyer).value);
  assert.equal(generated.source, 'generated');
  assert.equal(overridden.value, 'buyer@example.test');
  assert.equal(overridden.source, 'persona');
});

test('crawl-data loader normalizes multi-persona workflow data', () => {
  const crawlData = normalizeCrawlData({
    activePersonaId: 'buyer',
    searchTerms: ['apple'],
    personas: [
      {
        id: 'buyer',
        credentials: { username: 'buyer@test.com', password: 'secret' },
        addresses: [{ city: 'London' }],
        paymentMethods: [{ type: 'visa', last4: '4242' }],
        workflowHints: [{ kind: 'checkout' }]
      },
      {
        id: 'viewer',
        credentials: { username: 'viewer@test.com' }
      }
    ]
  });

  assert.equal(crawlData.activePersonaId, 'buyer');
  assert.equal(crawlData.personas[0].credentials.username, 'buyer@test.com');
  assert.equal(crawlData.personas[0].addresses[0].city, 'London');
  assert.equal(crawlData.searchTerms[0], 'apple');
});

test('crawl-data file loads and CLI overrides active persona credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-crawl-data-'));
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({
    activePersonaId: 'buyer',
    personas: [
      { id: 'buyer', credentials: { username: 'old@test.com', password: 'old-secret' }, values: { search: 'banana' } }
    ]
  }), 'utf8');

  const loaded = loadCrawlData(file);
  const overridden = applyProfileOverrides(loaded, {
    username: 'new@test.com',
    password: 'new-secret'
  });

  assert.equal(overridden.personas[0].credentials.username, 'new@test.com');
  assert.equal(overridden.personas[0].credentials.password, 'new-secret');
  assert.equal(overridden.personas[0].values.search, 'banana');
  assert.equal(redactProfile(overridden).personas[0].credentials.password, '[redacted]');
  fs.rmSync(dir, { recursive: true, force: true });
});
