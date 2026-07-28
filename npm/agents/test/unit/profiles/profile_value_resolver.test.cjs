'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveFieldValue,
  resolveProfileValues,
  resolveUploadFixture
} = require('../../../src/profiles/profileValueResolver.cjs');

test('profile value resolver maps transfer fields from structured workflow values', () => {
  const profile = {
    transfer: {
      fromAccount: '800001',
      toAccount: '800002',
      amount: '25.50'
    }
  };

  assert.equal(resolveFieldValue({ name: 'fromAccount' }, profile).value, '800001');
  assert.equal(resolveFieldValue({ name: 'toAccount' }, profile).value, '800002');
  assert.equal(resolveFieldValue({ name: 'amount' }, profile).value, '25.50');
});

test('profile value resolver flattens persona addresses and search terms', () => {
  const profile = {
    activePersonaId: 'buyer',
    personas: [{
      id: 'buyer',
      addresses: [{ street: '1 Example Road', city: 'London', postalCode: 'SW1A 1AA' }],
      searchTerms: ['apple juice']
    }]
  };
  const resolved = resolveProfileValues(profile);

  assert.equal(resolved.personaId, 'buyer');
  assert.equal(resolved.values.address, '1 Example Road');
  assert.equal(resolved.values.city, 'London');
  assert.equal(resolved.values.search, 'apple juice');
});

test('profile value resolver resolves upload fixtures without exposing them as secrets', () => {
  const profile = {
    uploadFixtures: [{ id: 'avatar', path: '/tmp/avatar.png' }]
  };

  assert.equal(resolveUploadFixture({ name: 'avatar' }, profile), '/tmp/avatar.png');
  assert.deepEqual(resolveFieldValue({ name: 'avatar', type: 'file' }, profile), {
    value: '/tmp/avatar.png',
    kind: 'file',
    source: 'profile.uploadFixtures',
    key: 'avatar.png',
    sensitive: false
  });
});

test('profile value resolver prefers semantic email over misleading raw user field names', () => {
  const profile = {
    values: {
      email: 'buyer@example.test',
      user: 'not-an-email'
    }
  };

  const resolved = resolveFieldValue({
    name: 'user',
    id: 'email',
    label: 'Email',
    type: 'text'
  }, profile);

  assert.equal(resolved.kind, 'email');
  assert.equal(resolved.key, 'email');
  assert.equal(resolved.value, 'buyer@example.test');
});
