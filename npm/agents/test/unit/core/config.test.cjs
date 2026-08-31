'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  ConfigValidationError,
  configOverridesFromCli,
  findPtkExtensionPath,
  getDefaultConfig,
  resolveConfig,
  redactSecrets
} = require('../../../src/core/config.cjs');

test('resolveConfig returns v2 defaults with visible budgets', () => {
  const config = resolveConfig({ generatedAt: '2026-05-04T00:00:00.000Z' });

  assert.equal(config.version, 'ptk-agent-v2-config');
  assert.equal(config.target.baseUrl, 'http://localhost:3000');
  assert.equal(config.crawler.maxRouteMs, 30000);
  assert.equal(config.crawler.maxDepth, 5);
  assert.equal(config.crawler.maxActionMs, 1000);
  assert.equal(config.crawler.maxObservationMs, 800);
  assert.equal(config.crawler.maxFormsPerRoute, 1);
  assert.equal(config.crawler.codeSignals.enabled, false);
  assert.equal(config.crawler.codeSignals.mode, 'off');
  assert.equal(config.crawler.codeSignals.maxScripts, 8);
  assert.equal(config.crawler.codeSignals.maxSignalMs, 500);
  assert.equal(config.crawler.codeSignals.seedRoutes, false);
  assert.equal(config.crawler.surfaceExplorer.maxMenuActionsPerSurface, 8);
  assert.equal(config.crawler.surfaceExplorer.maxNestedExpansions, 5);
  assert.equal(config.crawler.surfaceExplorer.maxRouteChangingMenuActions, 8);
  assert.equal(config.crawler.surfaceExplorer.reopenSurfaceBetweenMenuActions, true);
  assert.equal(config.engines.dast.enabled, true);
  assert.equal(config.engines.iast.enabled, true);
  assert.equal(config.engines.sast.enabled, false);
  assert.equal(config.engines.sca.enabled, false);
  assert.equal(config.browser.name, 'chromium');
  assert.equal(config.browser.headless, true);
  assert.equal(config.browser.viewport.width, 1280);
  assert.equal(config.ptk.drainMode, 'off');
  assert.equal(config.ptk.drainTimeoutMs, 0);
  assert.equal(config.ptk.requireAttackCompletion, false);
  assert.equal(config.ptk.stopWaitForIdle, false);
  assert.equal(config.ptk.immediateAnalysis, true);
  assert.equal(config.memory.mode, 'off');
  assert.equal(config.memory.storageDir, '.ptk/site-memory');
  assert.equal(config.scenario.inputType, 'scenario');
  assert.equal(config.scenario.format, 'auto');
  assert.equal(config._resolved.budgets.waitBudgetMs, 800);
  assert.equal(config._resolved.budgets.perRouteBudgetMs, 34800);
});

test('config and CLI select macro input without changing ordinary scenario defaults', () => {
  const overrides = configOverridesFromCli({
    macroFile: 'login.zst',
    macroFormat: 'zest',
    scenarioContinueOnFailure: true
  });
  const config = resolveConfig({
    overrides,
    config: {
      target: {
        baseUrl: 'http://localhost:3001',
        scope: { include: ['http://localhost:3001/**'], exclude: [] }
      }
    }
  });
  assert.equal(config.scenario.enabled, true);
  assert.equal(config.scenario.file, 'login.zst');
  assert.equal(config.scenario.inputType, 'macro');
  assert.equal(config.scenario.format, 'zest');
  assert.equal(config.scenario.continueOnFailure, true);
  assert.throws(() => resolveConfig({
    config: { scenario: { enabled: true, file: 'login.js', inputType: 'macro', format: 'playwright' } }
  }), ConfigValidationError);
});

test('resolveConfig merges a config file and normalizes numeric budgets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-config-'));
  const configPath = path.join(dir, 'ptk.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    target: {
      baseUrl: 'https://example.test/app/',
      scope: {
        include: ['https://example.test/app/**'],
        exclude: ['https://example.test/app/logout']
      }
    },
    crawler: {
      maxRoutes: '7',
      maxActionsPerRoute: '2'
    },
    artifacts: {
      outputDir: 'out'
    }
  }), 'utf8');

  const config = resolveConfig({
    cwd: dir,
    configPath,
    generatedAt: '2026-05-04T00:00:00.000Z'
  });

  assert.equal(config.target.baseUrl, 'https://example.test/app');
  assert.deepEqual(config.target.scope.include, ['https://example.test/app/**']);
  assert.equal(config.crawler.maxRoutes, 7);
  assert.equal(config.crawler.maxActionsPerRoute, 2);
  assert.equal(config.artifacts.outputDir, 'out');
  assert.equal(config._resolved.configPath, configPath);
});

test('CLI overrides update target scope when scope is still default', () => {
  const overrides = configOverridesFromCli({
    url: 'https://shop.example.test',
    outputDir: 'artifacts',
    maxRoutes: '5',
    crawlDepth: '3'
  });
  const config = resolveConfig({
    overrides,
    generatedAt: '2026-05-04T00:00:00.000Z'
  });

  assert.equal(config.target.baseUrl, 'https://shop.example.test');
  assert.deepEqual(config.target.scope.include, ['https://shop.example.test/**']);
  assert.equal(config.artifacts.outputDir, 'artifacts');
  assert.equal(config.crawler.maxRoutes, 5);
  assert.equal(config.crawler.maxDepth, 3);
  assert.equal(config._resolved.cliOverrides.target.baseUrl, 'https://shop.example.test');
});

test('resolveConfig loads route hints from config and file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-route-hints-'));
  const hintsFile = path.join(dir, 'route-hints.json');
  fs.writeFileSync(hintsFile, JSON.stringify({
    routeHints: [
      '/swagger-json',
      { url: '/api/config', sourceTag: 'route-hint', reason: 'api-inventory' }
    ]
  }), 'utf8');

  const config = resolveConfig({
    cwd: dir,
    config: {
      target: {
        baseUrl: 'http://app.test',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        routeHints: ['/inline'],
        routeHintsFile: 'route-hints.json',
        salvageTimedOutRoutes: false
      }
    },
    generatedAt: '2026-05-05T00:00:00.000Z'
  });

  assert.equal(config.crawler.salvageTimedOutRoutes, false);
  assert.equal(config.crawler.routeHints.length, 3);
  assert.equal(config.crawler.routeHints[0], '/inline');
  assert.equal(config.crawler.routeHints[1], '/swagger-json');
  assert.equal(config.crawler.routeHints[2].url, '/api/config');
  assert.equal(configOverridesFromCli({ routeHintsFile: hintsFile }).crawler.routeHintsFile, hintsFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config auto-detects a fixture PTK extension and supports CLI override alias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-extension-fixture-'));
  const extensionDir = path.join(dir, 'src');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'PTK fixture', version: '1.0.0', background: { service_worker: 'app.js' } }), 'utf8');
  fs.writeFileSync(path.join(extensionDir, 'app.js'), 'globalThis.PTK_AGENT = globalThis.PTK_AGENT || {};', 'utf8');

  const detected = findPtkExtensionPath({ cwd: dir });
  assert.ok(detected);
  assert.equal(path.basename(detected), 'src');
  assert.ok(fs.existsSync(path.join(detected, 'manifest.json')));

  const config = resolveConfig({
    cwd: dir,
    generatedAt: '2026-05-04T00:00:00.000Z'
  });
  assert.equal(config.ptk.extensionPath, detected);

  const overrides = configOverridesFromCli({ ptkExtensionDir: detected });
  assert.equal(overrides.ptk.extensionPath, detected);
});

test('resolveConfig supports M1 minimal engine config', () => {
  const config = resolveConfig({
    config: {
      engines: {
        dast: { enabled: false },
        iast: { enabled: false },
        sast: { enabled: true },
        sca: { enabled: false }
      }
    }
  });

  assert.equal(config.engines.dast.enabled, false);
  assert.equal(config.engines.iast.enabled, false);
  assert.equal(config.engines.sast.enabled, true);
  assert.equal(config.engines.sca.enabled, false);
  assert.deepEqual(config.engines.sast.modulePacks, ['free']);
});

test('resolveConfig supports M3 modules and CI config', () => {
  const config = resolveConfig({
    config: {
      modules: {
        packs: ['free'],
        cacheDir: '.ptk/custom-modules',
        verifySignatures: true,
        allowUnsigned: false,
        allowNetworkDownloads: false,
        portal: {
          baseUrl: null,
          tokenEnv: 'PTK_PORTAL_TOKEN'
        }
      },
      ci: {
        failOn: {
          severity: ['high'],
          confidence: ['confirmed']
        },
        noFail: false
      },
      engines: {
        dast: { enabled: true, modulePacks: ['free'] },
        iast: { enabled: false, modulePacks: ['free'] },
        sast: { enabled: true, modulePacks: ['free'] },
        sca: { enabled: false, modulePacks: [] }
      }
    }
  });

  assert.deepEqual(config.modules.packs, ['free']);
  assert.equal(config.modules.cacheDir, '.ptk/custom-modules');
  assert.deepEqual(config.ci.failOn.severity, ['high']);
  assert.equal(config.engines.sast.enabled, true);
  assert.deepEqual(config.engines.sast.modulePacks, ['free']);
});

test('resolveConfig supports M5 site memory config and CLI aliases', () => {
  const overrides = configOverridesFromCli({
    memoryMode: 'read-write',
    memoryStorage: '.ptk/custom-memory',
    memoryReset: true
  });
  const config = resolveConfig({
    overrides,
    generatedAt: '2026-05-04T00:00:00.000Z'
  });

  assert.equal(config.memory.mode, 'read-write');
  assert.equal(config.memory.storageDir, '.ptk/custom-memory');
  assert.equal(config.memory.reset, true);
});

test('resolveConfig loads crawl-data profile file and applies CLI persona overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-profile-config-'));
  const profileFile = path.join(dir, 'crawl-data.json');
  fs.writeFileSync(profileFile, JSON.stringify({
    activePersonaId: 'buyer',
    personas: [
      {
        id: 'buyer',
        credentials: {
          username: 'buyer@test.com',
          password: 'file-secret'
        },
        values: {
          search: 'apple'
        }
      },
      {
        id: 'admin',
        credentials: {
          username: 'admin@test.com',
          password: 'admin-secret'
        }
      }
    ]
  }), 'utf8');

  const config = resolveConfig({
    overrides: configOverridesFromCli({
      url: 'http://app.test',
      profileFile,
      persona: 'admin',
      username: 'override@test.com',
      password: 'override-secret'
    })
  });

  const admin = config.profile.personas.find(persona => persona.id === 'admin');
  const buyer = config.profile.personas.find(persona => persona.id === 'buyer');
  assert.equal(config.profile.file, profileFile);
  assert.equal(config.profile.activePersonaId, 'admin');
  assert.equal(admin.credentials.username, 'override@test.com');
  assert.equal(admin.credentials.password, 'override-secret');
  assert.equal(buyer.values.search, 'apple');
  assert.ok(!JSON.stringify(redactSecrets(config)).includes('override-secret'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveConfig supports M2 browser config and CLI aliases', () => {
  const overrides = configOverridesFromCli({
    browser: 'edge',
    edgeBinary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    profileDir: '/tmp/ptk-profile',
    headless: false
  });
  const config = resolveConfig({
    overrides,
    generatedAt: '2026-05-04T00:00:00.000Z'
  });

  assert.equal(config.browser.name, 'edge');
  assert.equal(config.browser.executablePath, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  assert.equal(config.browser.profileDir, '/tmp/ptk-profile');
  assert.equal(config.browser.headless, false);
});

test('resolveConfig supports M14 PTK drain policy and CLI aliases', () => {
  const overrides = configOverridesFromCli({
    ptkDrainMode: 'until-idle',
    ptkDrainTimeoutMs: '1500',
    requirePtkAttackCompletion: true
  });
  const config = resolveConfig({ overrides });

  assert.equal(config.ptk.drainMode, 'until-idle');
  assert.equal(config.ptk.drainTimeoutMs, 1500);
  assert.equal(config.ptk.requireAttackCompletion, true);

  const waitAlias = resolveConfig({
    overrides: configOverridesFromCli({ waitForPtkComplete: true })
  });
  assert.equal(waitAlias.ptk.drainMode, 'until-complete');
  assert.equal(waitAlias.ptk.drainTimeoutMs, 60000);

  assert.throws(
    () => resolveConfig({ config: { ptk: { drainMode: 'until-complete', drainTimeoutMs: 0 } } }),
    /drainTimeoutMs/
  );
});

test('resolveConfig supports immediate analysis stop policy override', () => {
  const config = resolveConfig({
    overrides: configOverridesFromCli({ immediateAnalysis: false })
  });
  assert.equal(config.ptk.immediateAnalysis, false);
});

test('invalid config fails before runtime execution', () => {
  assert.throws(
    () => resolveConfig({
      config: {
        crawler: {
          maxRouteMs: -1,
          waitStrategy: 'networkidle'
        },
        agent: {
          fallback: 'direct-reset'
        }
      }
    }),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /maxRouteMs/);
      assert.match(error.message, /waitStrategy/);
      assert.match(error.message, /fallback/);
      return true;
    }
  );
});

test('redactSecrets removes sensitive values recursively', () => {
  const redacted = redactSecrets({
    token: 'abc',
    nested: {
      password: 'secret',
      safe: 'visible',
      url: 'https://app.test/contact?email=user%40example.test&subject=hello',
      partner: 'https://app.test/api/partners/login?user=test&password=test',
      payload: 'Bearer abcdefghijklmnopqrstuvwxyz',
      database: 'postgres://dbuser:dbpass@app.test/app',
      mapConfig: 'googlemaps:AIzaabcdefghijklmnopqrstuvwxyz123456'
    },
    sessionLost: false,
    tokenPresent: true
  });

  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.password, '[REDACTED]');
  assert.equal(redacted.nested.safe, 'visible');
  assert.equal(redacted.nested.url, 'https://app.test/contact?email=%5BREDACTED%5D&subject=hello');
  assert.equal(redacted.nested.partner, 'https://app.test/api/partners/login?user=%5BREDACTED%5D&password=%5BREDACTED%5D');
  assert.match(redacted.nested.payload, /Bearer \[REDACTED\]/);
  assert.ok(!JSON.stringify(redacted).includes('dbpass'));
  assert.ok(!JSON.stringify(redacted).includes('dbuser'));
  assert.ok(!JSON.stringify(redacted).includes('AIzaabcdefghijklmnopqrstuvwxyz123456'));
  assert.equal(redacted.sessionLost, false);
  assert.equal(redacted.tokenPresent, '[REDACTED]');
});

test('redactSecrets handles circular and runtime objects without walking internals', () => {
  class BrowserRuntime {}
  const runtime = new BrowserRuntime();
  runtime.token = 'should-not-be-walked';
  const payload = {
    url: new URL('https://app.test/path?token=abc'),
    runtime,
    nested: {}
  };
  payload.nested.parent = payload;
  payload.list = [payload.nested];

  const redacted = redactSecrets(payload);

  assert.equal(redacted.url, 'https://app.test/path?token=%5BREDACTED%5D');
  assert.equal(redacted.runtime, '[BrowserRuntime]');
  assert.equal(redacted.nested.parent, '[Circular]');
  assert.equal(redacted.list[0], '[Circular]');
  assert.doesNotThrow(() => JSON.stringify(redacted));
  assert.ok(!JSON.stringify(redacted).includes('should-not-be-walked'));
});

test('getDefaultConfig returns an isolated copy', () => {
  const config = getDefaultConfig();
  config.crawler.maxRoutes = 1;
  assert.equal(getDefaultConfig().crawler.maxRoutes, 100);
});
