'use strict';

const path = require('path');

const { classifyField, isSensitiveField } = require('../crawl/formStrategy.cjs');

const COMMON_PROFILE_KEYS = Object.freeze([
  'username',
  'user',
  'login',
  'email',
  'password',
  'name',
  'firstName',
  'lastName',
  'phone',
  'tel',
  'mobile',
  'search',
  'query',
  'q',
  'text',
  'message',
  'subject',
  'amount',
  'accountFrom',
  'accountTo',
  'fromAccount',
  'toAccount',
  'address',
  'city',
  'state',
  'postalCode',
  'zip',
  'country'
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalarEntries(source = {}, keys = COMMON_PROFILE_KEYS) {
  const out = {};
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] === 'string' || typeof source[key] === 'number' || typeof source[key] === 'boolean') {
      out[key] = source[key];
    }
  }
  return out;
}

function selectPersona(profile = {}, personaId = null) {
  if (!Array.isArray(profile.personas) || profile.personas.length === 0) return null;
  if (!personaId && profile.personas.length === 1) return profile.personas[0];
  return profile.personas.find(persona => persona && (persona.id === personaId || persona.name === personaId)) || null;
}

function assignValues(target, source, valueSource) {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value) || Array.isArray(value)) continue;
    target.values[key] = value;
    target.sources[key] = valueSource;
  }
}

function assignAlias(target, alias, value, source) {
  if (value === undefined || value === null || value === '') return;
  if (target.values[alias] !== undefined) return;
  target.values[alias] = value;
  target.sources[alias] = source;
}

function firstPlainObject(...values) {
  for (const value of values) {
    if (Array.isArray(value) && isPlainObject(value[0])) return value[0];
    if (isPlainObject(value)) return value;
  }
  return null;
}

function assignStructuredProfileValues(target, profile = {}, source = 'profile') {
  const address = firstPlainObject(profile.addresses, profile.address, profile.profile && profile.profile.addresses);
  if (address) {
    assignAlias(target, 'address', address.address || address.street || address.line1, `${source}.address`);
    assignAlias(target, 'street', address.street || address.line1 || address.address, `${source}.address`);
    assignAlias(target, 'city', address.city, `${source}.address`);
    assignAlias(target, 'state', address.state || address.province || address.region, `${source}.address`);
    assignAlias(target, 'postalCode', address.postalCode || address.zip || address.postcode, `${source}.address`);
    assignAlias(target, 'zip', address.zip || address.postalCode || address.postcode, `${source}.address`);
    assignAlias(target, 'country', address.country, `${source}.address`);
  }
  const payment = firstPlainObject(profile.paymentMethods, profile.paymentMethod);
  if (payment) {
    assignAlias(target, 'cardNumber', payment.cardNumber || payment.number, `${source}.paymentMethod`);
    assignAlias(target, 'cardCvv', payment.cvv || payment.cvc, `${source}.paymentMethod`);
    assignAlias(target, 'cardExpiry', payment.expiry || payment.expiration, `${source}.paymentMethod`);
  }
  const transfer = firstPlainObject(profile.transfer, profile.transferFunds, profile.workflowValues && profile.workflowValues.transfer);
  if (transfer) {
    assignAlias(target, 'accountFrom', transfer.from || transfer.fromAccount || transfer.sourceAccount, `${source}.transfer`);
    assignAlias(target, 'fromAccount', transfer.from || transfer.fromAccount || transfer.sourceAccount, `${source}.transfer`);
    assignAlias(target, 'accountTo', transfer.to || transfer.toAccount || transfer.destinationAccount, `${source}.transfer`);
    assignAlias(target, 'toAccount', transfer.to || transfer.toAccount || transfer.destinationAccount, `${source}.transfer`);
    assignAlias(target, 'amount', transfer.amount, `${source}.transfer`);
  }
  if (Array.isArray(profile.searchTerms) && profile.searchTerms.length > 0) {
    assignAlias(target, 'search', profile.searchTerms[0], `${source}.searchTerms`);
    assignAlias(target, 'query', profile.searchTerms[0], `${source}.searchTerms`);
    assignAlias(target, 'q', profile.searchTerms[0], `${source}.searchTerms`);
  }
}

function resolveProfileValues(profile = {}, personaId = null) {
  const resolved = { values: {}, sources: {}, personaId: null, uploadFixtures: [] };
  const persona = selectPersona(profile, personaId || profile.personaId || profile.activePersonaId);
  assignValues(resolved, profile.values, 'profile.values');
  assignValues(resolved, profile.credentials, 'profile.credentials');
  assignValues(resolved, scalarEntries(profile), 'profile');
  assignStructuredProfileValues(resolved, profile, 'profile');
  if (persona) {
    resolved.personaId = persona.id || persona.name || null;
    assignValues(resolved, persona.values, 'persona.values');
    assignValues(resolved, persona.credentials, 'persona.credentials');
    assignValues(resolved, scalarEntries(persona), 'persona');
    assignStructuredProfileValues(resolved, persona, 'persona');
  }
  if (resolved.values.email === undefined && typeof resolved.values.username === 'string' && resolved.values.username.includes('@')) {
    resolved.values.email = resolved.values.username;
    resolved.sources.email = resolved.sources.username || 'profile';
  }
  if (resolved.values.username === undefined && resolved.values.email !== undefined) {
    resolved.values.username = resolved.values.email;
    resolved.sources.username = resolved.sources.email || 'profile';
  }
  if (resolved.values.user === undefined && resolved.values.username !== undefined) {
    resolved.values.user = resolved.values.username;
    resolved.sources.user = resolved.sources.username || 'profile';
  }
  if (resolved.values.login === undefined && resolved.values.username !== undefined) {
    resolved.values.login = resolved.values.username;
    resolved.sources.login = resolved.sources.username || 'profile';
  }
  if (resolved.values.fromAccount === undefined && resolved.values.accountFrom !== undefined) {
    resolved.values.fromAccount = resolved.values.accountFrom;
    resolved.sources.fromAccount = resolved.sources.accountFrom || 'profile';
  }
  if (resolved.values.accountFrom === undefined && resolved.values.fromAccount !== undefined) {
    resolved.values.accountFrom = resolved.values.fromAccount;
    resolved.sources.accountFrom = resolved.sources.fromAccount || 'profile';
  }
  if (resolved.values.toAccount === undefined && resolved.values.accountTo !== undefined) {
    resolved.values.toAccount = resolved.values.accountTo;
    resolved.sources.toAccount = resolved.sources.accountTo || 'profile';
  }
  if (resolved.values.accountTo === undefined && resolved.values.toAccount !== undefined) {
    resolved.values.accountTo = resolved.values.toAccount;
    resolved.sources.accountTo = resolved.sources.toAccount || 'profile';
  }
  if (resolved.values.query === undefined && resolved.values.search !== undefined) {
    resolved.values.query = resolved.values.search;
    resolved.sources.query = resolved.sources.search || 'profile';
  }
  if (resolved.values.q === undefined && resolved.values.query !== undefined) {
    resolved.values.q = resolved.values.query;
    resolved.sources.q = resolved.sources.query || 'profile';
  }
  resolved.uploadFixtures = [
    ...(Array.isArray(profile.uploadFixtures) ? profile.uploadFixtures : []),
    ...(persona && Array.isArray(persona.uploadFixtures) ? persona.uploadFixtures : [])
  ];
  return resolved;
}

function candidateValueKeys(field = {}, kind = classifyField(field)) {
  const aliases = {
    username: ['username', 'user', 'login', 'email', 'uid', 'userid', 'user_id', 'user-name', 'user_name'],
    email: ['email', 'username', 'user', 'login'],
    password: ['password', 'passwd', 'pwd', 'passw', 'pass'],
    search: ['search', 'query', 'q'],
    phone: ['phone', 'tel', 'mobile'],
    amount: ['amount', 'amt', 'value', 'number'],
    accountFrom: ['accountFrom', 'fromAccount', 'from', 'sourceAccount', 'debitAccount'],
    accountTo: ['accountTo', 'toAccount', 'to', 'destinationAccount', 'creditAccount'],
    number: ['number', 'quantity', 'qty', 'amount'],
    name: ['name', 'fullName'],
    firstName: ['firstName', 'givenName'],
    lastName: ['lastName', 'familyName', 'surname'],
    subject: ['subject', 'title'],
    message: ['message', 'comment', 'feedback', 'description', 'text'],
    address: ['address', 'street', 'line1'],
    postalCode: ['postalCode', 'zip', 'postcode'],
    text: ['text', 'message']
  };
  const rawKeys = [
    field.name,
    field.id,
    field.label,
    kind
  ].filter(Boolean);
  const semanticKeys = [kind, ...(aliases[kind] || [])];
  const keys = ['email', 'password'].includes(kind)
    ? [...semanticKeys, ...rawKeys]
    : [...rawKeys, ...semanticKeys];
  return Array.from(new Set(keys.map(String).map(key => key.trim()).filter(Boolean)));
}

function defaultValueForKind(kind) {
  const defaults = {
    email: 'ptk@example.test',
    username: 'ptk-user',
    password: null,
    search: 'test',
    phone: '5550100',
    amount: '1.00',
    accountFrom: '0',
    accountTo: '1',
    number: '1',
    checkbox: true,
    radio: true,
    firstName: 'PTK',
    lastName: 'User',
    name: 'PTK User',
    subject: 'PTK test feedback',
    message: 'PTK automated feedback message',
    address: '1 PTK Street',
    city: 'Test City',
    state: 'Test State',
    postalCode: '10001',
    country: 'United States',
    text: 'ptk test value',
    file: null
  };
  return defaults[kind] !== undefined ? defaults[kind] : defaults.text;
}

function lookupValue(resolved, key) {
  if (Object.prototype.hasOwnProperty.call(resolved.values, key)) {
    return { value: resolved.values[key], key, source: resolved.sources[key] || 'profile' };
  }
  const lower = String(key).toLowerCase();
  const existing = Object.keys(resolved.values).find(candidate => String(candidate).toLowerCase() === lower);
  if (!existing) return null;
  return { value: resolved.values[existing], key: existing, source: resolved.sources[existing] || 'profile' };
}

function resolveUploadFixture(field = {}, profile = {}, resolved = null) {
  resolved = resolved || resolveProfileValues(profile, profile.personaId || profile.activePersonaId);
  const fixtures = resolved.uploadFixtures || [];
  if (!fixtures.length) return null;
  const text = `${field.name || ''} ${field.id || ''} ${field.label || ''}`.toLowerCase();
  const fixture = fixtures.find(item => {
    if (typeof item === 'string') return true;
    const label = `${item.id || ''} ${item.name || ''} ${item.kind || ''} ${item.purpose || ''}`.toLowerCase();
    return label && text && (label.includes(text) || text.includes(label));
  }) || fixtures[0];
  if (typeof fixture === 'string') return fixture;
  return fixture.path || fixture.file || fixture.filePath || null;
}

function resolveFieldValue(field, profile = {}) {
  const kind = classifyField(field || {});
  const resolved = resolveProfileValues(profile, profile.personaId || profile.activePersonaId);
  if (kind === 'file') {
    const fixture = resolveUploadFixture(field, profile, resolved);
    return {
      value: fixture,
      kind,
      source: fixture ? 'profile.uploadFixtures' : 'default',
      key: fixture ? path.basename(String(fixture)) : kind,
      sensitive: false
    };
  }
  for (const key of candidateValueKeys(field || {}, kind)) {
    const match = lookupValue(resolved, key);
    if (match) {
      return {
        value: match.value,
        kind,
        source: match.source,
        key: match.key,
        sensitive: isSensitiveField(field, kind)
      };
    }
  }
  return {
    value: defaultValueForKind(kind),
    kind,
    source: 'default',
    key: kind,
    sensitive: isSensitiveField(field, kind)
  };
}

function valueForField(field, profile = {}) {
  return resolveFieldValue(field, profile).value;
}

module.exports = {
  COMMON_PROFILE_KEYS,
  candidateValueKeys,
  defaultValueForKind,
  resolveFieldValue,
  resolveProfileValues,
  resolveUploadFixture,
  valueForField
};
