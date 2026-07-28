'use strict';

const { redactSecrets } = require('./config.cjs');

const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

function normalizeLevel(level) {
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level) ? level : 'info';
}

function shouldLog(configuredLevel, messageLevel) {
  return LOG_LEVELS[messageLevel] >= LOG_LEVELS[configuredLevel];
}

function serializeLogLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

function createLogger({ quiet = false, verbose = false, level = null, stream = process.stdout, errorStream = process.stderr, fields = {}, clock = null } = {}) {
  const configuredLevel = quiet ? 'error' : normalizeLevel(level || (verbose ? 'debug' : 'info'));
  const now = clock || (() => new Date().toISOString());

  function write(messageLevel, args) {
    if (!shouldLog(configuredLevel, messageLevel)) {
      return false;
    }
    const values = Array.from(args);
    const message = values
      .filter((value) => !value || typeof value !== 'object' || Array.isArray(value))
      .map(String)
      .join(' ');
    const data = values
      .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
      .reduce((acc, value) => Object.assign(acc, value), {});
    const entry = redactSecrets({
      time: now(),
      level: messageLevel,
      message,
      ...fields,
      ...data
    });
    const target = messageLevel === 'error' ? errorStream : stream;
    target.write(serializeLogLine(entry));
    return true;
  }

  return {
    level: configuredLevel,
    debug(...args) {
      return write('debug', args);
    },
    info(...args) {
      return write('info', args);
    },
    warn(...args) {
      return write('warn', args);
    },
    error(...args) {
      return write('error', args);
    },
    child(childFields = {}) {
      return createLogger({
        level: configuredLevel,
        stream,
        errorStream,
        fields: {
          ...fields,
          ...childFields
        },
        clock: now
      });
    }
  };
}

function createNullLogger() {
  return createLogger({
    level: 'silent',
    stream: { write() {} },
    errorStream: { write() {} }
  });
}

module.exports = {
  LOG_LEVELS,
  createLogger,
  createNullLogger,
  normalizeLevel,
  redactLogData: redactSecrets,
  serializeLogLine,
  shouldLog
};
