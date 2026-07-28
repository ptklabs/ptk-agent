'use strict';

const fs = require('fs');
const path = require('path');

function cacheDir(baseDir = '.ptk/module-cache') {
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

function cachePath(name, baseDir) {
  return path.join(cacheDir(baseDir), `${name}.json`);
}

function writeModulePack(pack, baseDir) {
  const file = cachePath(pack.name, baseDir);
  fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`);
  return file;
}

function readModulePack(name, baseDir) {
  const file = cachePath(name, baseDir);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createModuleCache({ cacheDir: baseDir = '.ptk/module-cache' } = {}) {
  const packs = new Map();
  return {
    cacheDir: baseDir,
    recordPack(id, pack) {
      packs.set(id, { id, ...pack });
      return packs.get(id);
    },
    getPack(id) {
      return packs.get(id) || null;
    },
    listPacks() {
      return Array.from(packs.values());
    }
  };
}

module.exports = {
  cacheDir,
  cachePath,
  createModuleCache,
  writeModulePack,
  readModulePack
};
