'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { classifyFailure, ROWS } = require(path.resolve(
  __dirname,
  '../../../../scripts/run-provider-release-matrix.cjs'
));

test('provider matrix classifies provider infrastructure failures precisely', () => {
  assert.equal(
    classifyFailure(new Error('BrowserStack upload-media response did not include media_url: User has reached their upload limit')),
    'provider_quota_exhausted'
  );
  assert.equal(
    classifyFailure(new Error('503 Service Unavailable: The API is temporarily at connection capacity. Retry shortly.')),
    'provider_unavailable'
  );
  assert.equal(
    classifyFailure(new Error("timeout exceeds your plan's maximum session time; upgrade your plan")),
    'provider_plan_limit'
  );
  assert.equal(
    classifyFailure(new Error('page.evaluate: Target page, context or browser has been closed')),
    'provider_session_expired'
  );
});

test('provider matrix distinguishes missing SDKs from missing credentials', () => {
  assert.equal(
    classifyFailure(new Error('@hyperbrowser/sdk is required. Install it with npm install -D @hyperbrowser/sdk.')),
    'sdk_missing'
  );
  assert.equal(classifyFailure(new Error('HYPERBROWSER_API_KEY is required.')), 'credentials_missing');
});

test('live-proven BrowserStack framework rows are required release gates', () => {
  const rows = ROWS.filter((row) => row.provider === 'browserstack');
  assert.deepEqual(
    rows.map((row) => [row.framework, row.required]),
    [['playwright', true], ['puppeteer', true], ['selenium', true]]
  );
});
