'use strict';

const fs = require('fs');
const path = require('path');

function runtimePath(relativePath) {
  return path.join(__dirname, '..', relativePath);
}

function loadRuntimeModule(relativePath) {
  const absolutePath = runtimePath(relativePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      available: false,
      relativePath: path.join('src', relativePath),
      absolutePath
    };
  }

  return {
    available: true,
    relativePath: path.join('src', relativePath),
    absolutePath,
    module: require(absolutePath)
  };
}

async function invokeRuntime(runtimeModule, exportNames, payload) {
  for (const exportName of exportNames) {
    if (runtimeModule && typeof runtimeModule[exportName] === 'function') {
      return runtimeModule[exportName](payload);
    }
  }

  if (typeof runtimeModule === 'function') {
    return runtimeModule(payload);
  }

  const error = new Error(`Runtime module is present but does not export one of: ${exportNames.join(', ')}`);
  error.code = 'PTK_RUNTIME_API_ERROR';
  error.exitCode = 70;
  throw error;
}

module.exports = {
  invokeRuntime,
  loadRuntimeModule
};
