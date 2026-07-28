'use strict';

const SECRET_KEY_PATTERN = /(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?key|signing[_-]?key|credential|secret|token|securityToken|connectUrl|wsEndpoint|password)/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const URL_TOKEN_PATTERN = /\b(?:wss?|https?):\/\/[^\s"'<>]+[?&](?:token|api[_-]?key|key|secret)=([^\s"'<>]+)/gi;

function redactString(value) {
  return String(value)
    .replace(JWT_PATTERN, '[redacted-jwt]')
    .replace(URL_TOKEN_PATTERN, (match) => {
      try {
        const url = new URL(match);
        for (const key of url.searchParams.keys()) {
          if (/token|api[_-]?key|key|secret/i.test(key)) url.searchParams.set(key, '[redacted]');
        }
        return url.toString();
      } catch (_) {
        return '[redacted-url]';
      }
    });
}

function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) || /^PTK_/i.test(key) || /_(?:API_KEY|SECRET|TOKEN)$/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(item, seen);
    }
  }
  return out;
}

module.exports = {
  redact,
  redactString
};
