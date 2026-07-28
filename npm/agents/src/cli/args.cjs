'use strict';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'PTK_USAGE_ERROR';
    this.exitCode = 64;
  }
}

function parseArgs(argv, spec) {
  const booleans = new Set(spec.booleans || []);
  const strings = new Set(spec.strings || []);
  const aliases = Object.assign({ h: 'help' }, spec.aliases || {});
  const allowed = new Set([...booleans, ...strings]);
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const rawName = equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex);
      const valueFromEquals = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

      if (!allowed.has(rawName)) {
        throw new UsageError(`Unknown option --${rawName}`);
      }

      if (booleans.has(rawName)) {
        if (valueFromEquals !== undefined) {
          throw new UsageError(`Boolean option --${rawName} does not take a value`);
        }
        options[rawName] = true;
        continue;
      }

      if (valueFromEquals !== undefined) {
        options[rawName] = valueFromEquals;
        continue;
      }

      const next = argv[index + 1];
      if (!next || next.startsWith('-')) {
        throw new UsageError(`Option --${rawName} requires a value`);
      }
      options[rawName] = next;
      index += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const alias = token.slice(1);
      const name = aliases[alias];
      if (!name || !allowed.has(name)) {
        throw new UsageError(`Unknown option -${alias}`);
      }
      if (!booleans.has(name)) {
        throw new UsageError(`Option -${alias} cannot be used as a short flag`);
      }
      options[name] = true;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function requireOption(options, name, commandName) {
  if (!options[name]) {
    throw new UsageError(`${commandName} requires --${name}`);
  }
}

function camelizeOptions(options) {
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[camelKey] = value;
  }
  return out;
}

module.exports = {
  UsageError,
  camelizeOptions,
  parseArgs,
  requireOption
};
