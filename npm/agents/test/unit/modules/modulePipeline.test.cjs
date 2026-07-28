'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createModuleCache,
  createModuleDownloader,
  createPortalClient,
  buildEngineSummary,
  buildPtkScanOptions,
  redactEngineConfig,
  resolveEngineConfig,
  resolveModules,
  sha256Buffer,
  verifyModuleManifest,
  verifyModulePack
} = require('../../../src/modules/index.cjs');

test('engine config resolves defaults and redacts portal token values', () => {
  const config = resolveEngineConfig({
    modules: {
      portal: {
        token: 'secret-token'
      }
    }
  });

  assert.equal(config.engines.dast.enabled, true);
  assert.deepEqual(config.modules.packs, ['bundled-free']);
  assert.equal(redactEngineConfig(config).modules.portal.token, '[redacted]');
});

test('module resolver returns bundled free DAST skeleton modules', () => {
  const result = resolveModules();

  assert.deepEqual(result.engines, ['dast']);
  assert.equal(result.ok, true);
  assert.ok(result.modules.some((moduleDef) => moduleDef.id === 'ptk.dast.discovery'));
  assert.equal(result.packs[0].status, 'resolved');
});

test('module resolver accepts main runtime engine and module config', () => {
  const result = resolveModules({
    engines: {
      dast: { enabled: true, modulePacks: ['free'] },
      iast: { enabled: true, modulePacks: ['free'] },
      sast: { enabled: false, modulePacks: ['free'] },
      sca: { enabled: false, modulePacks: [] }
    },
    modules: {
      packs: ['free'],
      cacheDir: '.ptk/modules',
      verifySignatures: true,
      allowUnsigned: false,
      allowNetworkDownloads: false,
      portal: { baseUrl: null, tokenEnv: 'PTK_PORTAL_TOKEN' }
    }
  }, { env: { PTK_PORTAL_TOKEN: 'secret-token' } });

  assert.equal(result.ok, true);
  assert.deepEqual(result.engines, ['dast', 'iast']);
  assert.equal(result.moduleOptions.portal.tokenEnv, 'PTK_PORTAL_TOKEN');
  assert.equal(result.moduleOptions.portal.tokenPresent, true);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
  assert.ok(result.modules.some((moduleDef) => moduleDef.engine === 'iast'));
});

test('missing Pro module pack fails explicitly without network download', () => {
  const result = resolveModules({
    engines: {
      dast: { enabled: true, modulePacks: ['pro'] }
    },
    modules: {
      packs: ['pro'],
      allowNetworkDownloads: false,
      portal: { tokenEnv: 'PTK_PORTAL_TOKEN' }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.packs[0].reason, 'pro-module-download-disabled');
  assert.match(result.errors[0], /Module pack "pro" is unavailable/);
});

test('PTK scan options and engine summary carry module and lifecycle status', () => {
  const config = {
    engines: {
      dast: { enabled: true, modulePacks: ['free'] },
      iast: { enabled: true, modulePacks: ['free'] },
      sast: { enabled: false, modulePacks: ['free'] },
      sca: { enabled: false, modulePacks: [] }
    },
    modules: {
      packs: ['free']
    }
  };
  const resolution = resolveModules(config);
  const scanOptions = buildPtkScanOptions(config, resolution);
  const summary = buildEngineSummary(config, resolution, {
    engineSelectionAppliedToPtk: true,
    engineSelectionReason: 'accepted'
  });

  assert.deepEqual(scanOptions.engines, ['DAST', 'IAST']);
  assert.equal(scanOptions.engineConfigs.modulePacks[0], 'free');
  assert.equal(summary.ptkLifecycle.engineSelectionAppliedToPtk, true);
  assert.equal(summary.modules.ok, true);
  assert.equal(summary.modules.moduleCount, resolution.modules.length);
});

test('module cache can satisfy external pack resolution', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agents-modules-'));
  const cache = createModuleCache({ cacheDir });
  cache.recordPack('pro', {
    version: '1.0.0',
    modules: [
      {
        id: 'ptk.dast.pro-check',
        engine: 'dast',
        pack: 'pro',
        version: '1.0.0',
        capabilities: ['dast:pro-check']
      }
    ]
  });

  const result = resolveModules({ modules: { packs: ['pro'] } }, { cache });

  assert.equal(result.packs.find((pack) => pack.id === 'pro').status, 'resolved');
  assert.ok(result.modules.some((moduleDef) => moduleDef.id === 'ptk.dast.pro-check'));
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('module verifier checks sha256 and manifest shape without signature integration', () => {
  const content = Buffer.from('module-pack');
  const expectedSha256 = sha256Buffer(content);
  const verification = verifyModulePack({ content, expectedSha256, signature: 'sig' });

  assert.equal(verification.status, 'unsupported');
  assert.equal(verification.checks[0].status, 'verified');
  assert.equal(verifyModulePack({}).status, 'skipped');
  assert.equal(verifyModuleManifest({ id: 'p', version: '1', modules: [] }).status, 'verified');
});

test('portal client and downloader skip network by default', async () => {
  const portalClient = createPortalClient({ token: 'secret' });
  const downloader = createModuleDownloader({ portalClient });

  assert.equal(portalClient.config.token, '[redacted]');
  assert.equal((await portalClient.checkEntitlement('pro')).status, 'skipped');
  assert.deepEqual(await downloader.installPack('pro'), {
    status: 'skipped',
    packId: 'pro',
    reason: 'network-downloads-disabled'
  });
});
