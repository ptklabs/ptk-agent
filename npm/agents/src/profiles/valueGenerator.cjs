'use strict';

function generateValue(kind, seed = 'ptk') {
  const suffix = hashString(`${kind}:${seed}`).slice(0, 6);
  const values = {
    email: `${seed}.${suffix}@example.test`,
    username: `${seed}-${suffix}`,
    password: `Ptk-${suffix}-Pass1!`,
    name: `PTK ${suffix}`,
    search: 'test',
    text: `ptk-${suffix}`,
    phone: '5550100'
  };
  return values[kind] || values.text;
}

function fieldKind(field = {}) {
  const text = `${field.name || ''} ${field.id || ''} ${field.label || ''} ${field.type || ''}`.toLowerCase();
  if (/email/.test(text)) return 'email';
  if (/user|login/.test(text)) return 'username';
  if (/pass/.test(text)) return 'password';
  if (/name/.test(text)) return 'name';
  if (/search|query|q/.test(text)) return 'search';
  return 'text';
}

function createValueGenerator({ seed = 'ptk' } = {}) {
  return {
    valueForField(field = {}, persona = {}) {
      const kind = fieldKind(field);
      const values = persona.values || {};
      if (Object.prototype.hasOwnProperty.call(values, kind)) {
        return { value: values[kind], source: 'persona', kind };
      }
      if (Object.prototype.hasOwnProperty.call(values, field.name)) {
        return { value: values[field.name], source: 'persona', kind };
      }
      return { value: generateValue(kind, seed), source: 'generated', kind };
    }
  };
}

function hashString(text) {
  let hash = 5381;
  for (const ch of String(text)) hash = ((hash << 5) + hash) + ch.charCodeAt(0);
  return Math.abs(hash).toString(16);
}

module.exports = {
  createValueGenerator,
  generateValue,
  hashString
};
