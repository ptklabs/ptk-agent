'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

function scalarEntries(source = {}) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function firstSearchTerm(source = {}) {
  const terms = asArray(source.searchTerms || source.searches || source.queries)
    .map(item => typeof item === 'string' ? item : item && (item.value || item.term || item.query))
    .filter(Boolean);
  return terms[0] || null;
}

function normalizeCredentials(source = {}) {
  const credentials = {
    ...(isPlainObject(source.credentials) ? source.credentials : {})
  };
  for (const key of ['username', 'email', 'user', 'login', 'password', 'token']) {
    if (source[key] !== undefined && source[key] !== null && credentials[key] === undefined) {
      credentials[key] = source[key];
    }
  }
  if (credentials.username === undefined && credentials.email !== undefined) credentials.username = credentials.email;
  if (credentials.email === undefined && typeof credentials.username === 'string' && credentials.username.includes('@')) credentials.email = credentials.username;
  return credentials;
}

function normalizeValues(source = {}) {
  const values = {
    ...(isPlainObject(source.profile) ? scalarEntries(source.profile) : {}),
    ...(isPlainObject(source.values) ? source.values : {})
  };
  const search = firstSearchTerm(source);
  if (search && values.search === undefined) values.search = search;
  if (values.query === undefined && values.search !== undefined) values.query = values.search;
  if (values.q === undefined && values.query !== undefined) values.q = values.query;
  return values;
}

function normalizePersona(input = {}, index = 0) {
  const persona = clone(input);
  const id = persona.id || persona.name || `persona-${index + 1}`;
  const credentials = normalizeCredentials(persona);
  const values = normalizeValues(persona);
  return {
    id,
    name: persona.name || id,
    role: persona.role || persona.type || null,
    credentials,
    values,
    addresses: asArray(persona.addresses || persona.address || persona.profile && persona.profile.addresses),
    paymentMethods: asArray(persona.paymentMethods || persona.payment || persona.cards),
    businessEntities: asArray(persona.businessEntities || persona.businesses || persona.organizations),
    searchTerms: asArray(persona.searchTerms || persona.searches || persona.queries),
    uploadFixtures: asArray(persona.uploadFixtures || persona.uploads || persona.files),
    workflowHints: asArray(persona.workflowHints || persona.workflows || persona.hints)
  };
}

function synthesizeDefaultPersona(profile = {}) {
  const credentials = normalizeCredentials(profile);
  const values = normalizeValues(profile);
  return normalizePersona({
    id: profile.activePersonaId || profile.personaId || 'default',
    name: 'default',
    credentials,
    values,
    searchTerms: profile.searchTerms || (values.search ? [values.search] : [])
  }, 0);
}

function normalizeCrawlData(input = {}) {
  const source = clone(input);
  const rootProfile = isPlainObject(source.profile) ? source.profile : {};
  const root = {
    file: source.file || null,
    activePersonaId: source.activePersonaId || source.personaId || null,
    username: source.username || rootProfile.username || null,
    password: source.password || rootProfile.password || null,
    includeSecrets: source.includeSecrets === true,
    credentials: normalizeCredentials({ ...rootProfile, ...(source.credentials || {}), username: source.username, password: source.password }),
    values: normalizeValues({ ...rootProfile, values: source.values || rootProfile.values, searchTerms: source.searchTerms || rootProfile.searchTerms }),
    addresses: asArray(source.addresses || rootProfile.addresses),
    paymentMethods: asArray(source.paymentMethods || rootProfile.paymentMethods),
    businessEntities: asArray(source.businessEntities || rootProfile.businessEntities),
    searchTerms: asArray(source.searchTerms || rootProfile.searchTerms),
    uploadFixtures: asArray(source.uploadFixtures || rootProfile.uploadFixtures),
    workflowHints: asArray(source.workflowHints || rootProfile.workflowHints),
    personas: []
  };
  const personas = asArray(source.personas).map(normalizePersona);
  root.personas = personas.length ? personas : [synthesizeDefaultPersona(root)];
  if (!root.activePersonaId && root.personas[0]) root.activePersonaId = root.personas[0].id;
  return root;
}

function loadCrawlData(input, { cwd = process.cwd() } = {}) {
  if (!input) return normalizeCrawlData({});
  if (typeof input === 'string') {
    const absolutePath = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Profile/crawl-data file not found: ${input}`);
    }
    return {
      ...normalizeCrawlData(readJson(absolutePath)),
      file: absolutePath
    };
  }
  return normalizeCrawlData(input);
}

function applyProfileOverrides(profile = {}, overrides = {}) {
  const normalized = normalizeCrawlData(profile);
  const username = overrides.username !== undefined && overrides.username !== null ? overrides.username : normalized.username;
  const password = overrides.password !== undefined && overrides.password !== null ? overrides.password : normalized.password;
  normalized.username = username || null;
  normalized.password = password || null;
  normalized.credentials = {
    ...(normalized.credentials || {})
  };
  if (username !== undefined && username !== null) normalized.credentials.username = username;
  if (password !== undefined && password !== null) normalized.credentials.password = password;
  const active = normalized.personas.find(persona => persona.id === normalized.activePersonaId || persona.name === normalized.activePersonaId) || normalized.personas[0];
  if (active) {
    active.credentials = {
      ...(active.credentials || {})
    };
    if (username !== undefined && username !== null) active.credentials.username = username;
    if (password !== undefined && password !== null) active.credentials.password = password;
    if (active.credentials.email === undefined && typeof active.credentials.username === 'string' && active.credentials.username.includes('@')) {
      active.credentials.email = active.credentials.username;
    }
  }
  return normalized;
}

module.exports = {
  applyProfileOverrides,
  loadCrawlData,
  normalizeCrawlData,
  normalizePersona,
  synthesizeDefaultPersona
};
