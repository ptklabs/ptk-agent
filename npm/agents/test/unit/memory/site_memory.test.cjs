'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Frontier } = require('../../../src/crawl/frontier.cjs');
const { createSiteFingerprint } = require('../../../src/memory/siteFingerprint.cjs');
const {
  createEmptySiteMemory,
  loadSiteMemory,
  recordActionOutcome,
  recordRouteOutcome,
  saveSiteMemory,
  seedFrontierFromMemory,
  shouldSuppressAction
} = require('../../../src/memory/siteMemory.cjs');

function config(overrides = {}) {
  return {
    target: {
      baseUrl: 'http://app.test/',
      scope: { include: ['http://app.test/**'], exclude: [] }
    },
    profile: {},
    memory: {
      mode: 'read-write',
      storageDir: '.ptk/site-memory',
      reset: false,
      staleAfterDays: 14,
      minConfidence: 0.25,
      maxSeedRoutes: 25,
      ...(overrides.memory || {})
    },
    ...(overrides.root || {})
  };
}

test('site fingerprint is stable for an origin', () => {
  assert.equal(
    createSiteFingerprint({ baseUrl: 'http://app.test/a' }).siteKey,
    createSiteFingerprint({ baseUrl: 'http://app.test/b' }).siteKey
  );
});

test('site memory writes and loads route records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-site-memory-'));
  const cfg = config({ memory: { storageDir: dir } });
  const loaded = loadSiteMemory(cfg, { cwd: dir, now: () => 1000 });

  assert.equal(loaded.loaded, false);
  recordRouteOutcome(loaded.memory, {
    ok: true,
    route: { url: 'http://app.test/#/catalog', source: 'link' },
    pageModel: { routeShape: 'http://app.test/#/catalog' }
  }, cfg, { now: () => 1000 });
  const saved = saveSiteMemory(loaded.memory, cfg, { cwd: dir, filePath: loaded.filePath, now: () => 2000 });
  assert.equal(saved.saved, true);

  const reloaded = loadSiteMemory(cfg, { cwd: dir });
  assert.equal(reloaded.loaded, true);
  assert.equal(reloaded.memory.routes[0].url, 'http://app.test/#/catalog');
});

test('memory route seeds go through frontier scope and SPA dedupe', () => {
  const cfg = config({ memory: { mode: 'read', minConfidence: 0.1 } });
  const memory = createEmptySiteMemory(cfg, { now: () => 1000 });
  memory.routes.push({
    url: 'http://app.test/#/chatbot',
    lastValidatedAt: new Date(1000).toISOString(),
    successCount: 2,
    failureCount: 0,
    confidence: 0.75,
    staleAfterDays: 14
  }, {
    url: 'http://external.test/',
    lastValidatedAt: new Date(1000).toISOString(),
    successCount: 2,
    failureCount: 0,
    confidence: 0.75,
    staleAfterDays: 14
  });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  assert.equal(frontier.enqueue('http://app.test/chatbot'), true);

  const seeded = seedFrontierFromMemory(frontier, memory, cfg, { now: () => 2000 });

  assert.equal(seeded.added, 1);
  assert.deepEqual(frontier.snapshot().queue.map(route => route.url), ['http://app.test/#/chatbot']);
  assert.equal(frontier.rejected.some(entry => entry.reason === 'out-of-scope'), true);
});

test('stale memory route seeds are skipped', () => {
  const cfg = config({ memory: { mode: 'read', staleAfterDays: 1, minConfidence: 0.1 } });
  const memory = createEmptySiteMemory(cfg, { now: () => 1000 });
  memory.routes.push({
    url: 'http://app.test/#/stale',
    lastValidatedAt: '2026-05-01T00:00:00.000Z',
    successCount: 5,
    failureCount: 0,
    confidence: 0.9,
    staleAfterDays: 1
  });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });

  const seeded = seedFrontierFromMemory(frontier, memory, cfg, {
    now: () => new Date('2026-05-04T00:00:00.000Z').getTime()
  });

  assert.equal(seeded.added, 0);
  assert.equal(frontier.size(), 0);
});

test('negative no-progress memory suppresses repeated action', () => {
  const cfg = config({ memory: { mode: 'read-write' } });
  const memory = createEmptySiteMemory(cfg, { now: () => 1000 });
  const action = {
    id: 'menu',
    kind: 'open-menu',
    label: 'Menu',
    selector: '#menu'
  };

  recordActionOutcome(memory, {
    ok: true,
    action,
    before: { url: 'http://app.test/#/' },
    transition: { changed: false, noProgress: true }
  }, cfg, { now: () => 1000 });

  assert.equal(shouldSuppressAction(memory, action, 'http://app.test/#/', cfg, { now: () => 2000 }), true);
});
