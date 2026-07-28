'use strict';

function resolvePersona(profile = {}, personaId) {
  const personas = profile.personas || [];
  if (!personaId && personas.length === 1) return personas[0];
  if (!personaId && profile.activePersonaId) return resolvePersona(profile, profile.activePersonaId);
  const persona = personas.find(item => item.id === personaId || item.name === personaId);
  if (!persona) throw new Error(`Persona not found: ${personaId || '(default)'}`);
  return persona;
}

function redactPersona(persona) {
  const clone = JSON.parse(JSON.stringify(persona || {}));
  if (clone.credentials) {
    for (const key of Object.keys(clone.credentials)) {
      if (/password|token|secret|cookie|authorization/i.test(key)) clone.credentials[key] = '[redacted]';
    }
  }
  return clone;
}

class PersonaSession {
  constructor(persona) {
    this.persona = persona;
    this.authenticated = false;
    this.reason = 'not_started';
  }

  markAuthenticated(reason = 'scenario_auth_success') {
    this.authenticated = true;
    this.reason = reason;
  }

  snapshot() {
    return {
      personaId: this.persona.id || this.persona.name,
      authenticated: this.authenticated,
      reason: this.reason
    };
  }
}

function createPersonaSession({ profile, activePersonaId } = {}) {
  const normalized = require('./profileLoader.cjs').loadProfile(profile || { personas: [] });
  let active = resolvePersona(normalized, activePersonaId);
  return {
    getActivePersona({ includeSecrets = false } = {}) {
      return includeSecrets ? active : redactPersona(active);
    },
    getCredential(name, { includeSecrets = false } = {}) {
      const value = active.credentials && active.credentials[name];
      if (!includeSecrets && /password|token|secret|cookie|authorization/i.test(name)) return '[redacted]';
      return value;
    },
    async switchPersona(personaId) {
      const next = resolvePersona(normalized, personaId);
      return {
        status: 'unsupported',
        reason: 'actual_session_switch_not_implemented',
        requestedPersonaId: next.id || next.name
      };
    }
  };
}

module.exports = {
  createPersonaSession,
  resolvePersona,
  PersonaSession
};
