'use strict';

const { MockProvider } = require('./mockProvider.cjs');
const { OpencodeProvider } = require('./opencodeProvider.cjs');
const { CodexProvider } = require('./codexProvider.cjs');

function createManagerProvider(config = {}) {
  if (!config.enabled || config.mode === 'off') return null;
  if (config.mode === 'mock' || config.mode === 'manager') return new MockProvider(config.mock || {});
  if ((config.mode === 'provider' || config.mode === 'browser') && config.provider === 'opencode') {
    return new OpencodeProvider({
      model: config.model,
      maxProviderMs: config.maxProviderMs,
      cwd: config.cwd || process.cwd()
    });
  }
  if ((config.mode === 'provider' || config.mode === 'browser') && config.provider === 'codex') {
    return new CodexProvider({
      model: config.model,
      maxProviderMs: config.maxProviderMs,
      cwd: config.cwd || process.cwd()
    });
  }
  if (config.mode === 'provider') {
    throw new Error(`Unsupported v2 provider: ${config.provider || '(missing)'}`);
  }
  throw new Error(`Unknown agent mode: ${config.mode}`);
}

module.exports = { createManagerProvider };
