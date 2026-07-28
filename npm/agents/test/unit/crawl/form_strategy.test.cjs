'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyField,
  classifyFormSurface,
  isBusinessMutationForm,
  isDestructiveForm,
  isVirtualFormSurface,
  resolveFormSubmitPermission
} = require('../../../src/crawl/formStrategy.cjs');

test('form strategy classifies transfer, feedback, and file fields', () => {
  assert.equal(classifyField({ name: 'fromAccount' }), 'accountFrom');
  assert.equal(classifyField({ name: 'toAccount' }), 'accountTo');
  assert.equal(classifyField({ name: 'amount', type: 'number' }), 'amount');
  assert.equal(classifyField({ name: 'comment', label: 'Feedback message' }), 'message');
  assert.equal(classifyField({ name: 'attachment', type: 'file' }), 'file');
});

test('form strategy classifies virtual and mutation form surfaces', () => {
  const transfer = {
    synthetic: true,
    fields: [
      { name: 'fromAccount' },
      { name: 'toAccount' },
      { name: 'amount' }
    ]
  };
  const feedback = { fields: [{ name: 'email' }, { name: 'comment' }] };
  const destructive = { id: 'delete-account', fields: [{ name: 'confirm' }] };

  assert.equal(classifyFormSurface(transfer), 'transfer');
  assert.equal(classifyFormSurface(feedback), 'feedback');
  assert.equal(isVirtualFormSurface(transfer), true);
  assert.equal(isBusinessMutationForm(feedback), true);
  assert.equal(isDestructiveForm(destructive), true);
});

test('form submission permission keeps search/contact default and requires intent for heavier mutations', () => {
  assert.equal(resolveFormSubmitPermission({ kind: 'search' }).allowed, true);
  assert.equal(resolveFormSubmitPermission({ kind: 'feedback' }).allowed, true);
  assert.equal(resolveFormSubmitPermission({ kind: 'contact' }).allowed, true);
  assert.equal(resolveFormSubmitPermission({ kind: 'login' }, {
    authIntent: { kind: 'auth.login' },
    config: { auth: { allowLogin: true } }
  }).allowed, true);
  assert.equal(resolveFormSubmitPermission({ kind: 'transfer' }).allowed, false);
  assert.equal(resolveFormSubmitPermission({ kind: 'transfer' }, {
    config: { crawler: { forms: { allowBusinessMutation: true } } }
  }).allowed, true);
  assert.equal(resolveFormSubmitPermission({ kind: 'destructive' }, {
    config: { crawler: { forms: { allowBusinessMutation: true } } }
  }).allowed, false);
});
