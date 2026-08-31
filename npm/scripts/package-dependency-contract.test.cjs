'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const { writePackageJson } = require('./prepare-npm-package.cjs');

test('generated package keeps Puppeteer implementations optional', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-package-contract-'));
  try {
    writePackageJson(root, '9.9.9', { publishable: true });
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    for (const name of ['puppeteer', 'puppeteer-core']) {
      assert.equal(packageJson.dependencies?.[name], undefined);
      assert.equal(packageJson.optionalDependencies?.[name], undefined);
      assert.equal(packageJson.peerDependencies?.[name], '>=22.0.0');
      assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Puppeteer framework and provider modules load without an implementation', () => {
  const originalLoad = Module._load;
  let dependencyLoads = 0;
  Module._load = function optionalPuppeteerGuard(request, parent, isMain) {
    if (request === 'puppeteer' || request === 'puppeteer-core') {
      dependencyLoads += 1;
      const error = new Error(`Cannot find module '${request}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const adapter = require('../frameworks/puppeteer/src/index.cjs');
    const providerModules = [
      '../providers/browserbase/src/index.cjs',
      '../providers/browserless/src/index.cjs',
      '../providers/browserstack/src/index.cjs',
      '../providers/hyperbrowser/src/index.cjs',
      '../providers/steel/src/index.cjs',
      '../providers/testmu/src/index.cjs'
    ].map((file) => require(file));

    assert.equal(typeof adapter.launchPtkBrowser, 'function');
    assert.equal(providerModules.length, 6);
    assert.equal(dependencyLoads, 0, 'module import must not resolve Puppeteer');

    assert.throws(
      () => adapter.resolvePuppeteer(),
      /Puppeteer is not installed\. Install puppeteer or puppeteer-core/
    );
    assert.equal(dependencyLoads, 2, 'runtime selection checks both supported implementations');

    const supplied = { launch() {} };
    assert.equal(adapter.resolvePuppeteer({ puppeteer: supplied }), supplied);
  } finally {
    Module._load = originalLoad;
  }
});
