'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { Coverage } = require('../../../src/crawl/coverage.cjs');
const { Frontier } = require('../../../src/crawl/frontier.cjs');

test('frontier enqueues in-scope URLs once and preserves source metadata', () => {
  const frontier = new Frontier({
    baseUrl: 'http://localhost:3000/',
    include: ['http://localhost:3000/**'],
    exclude: ['http://localhost:3000/logout']
  });

  assert.equal(frontier.enqueue('/a', { source: 'fixture' }), true);
  assert.equal(frontier.enqueue('/a', { source: 'duplicate' }), false);
  assert.equal(frontier.enqueue('http://evil.test/a'), false);
  assert.equal(frontier.enqueue('/logout'), false);

  const item = frontier.dequeue();
  assert.equal(item.url, 'http://localhost:3000/a');
  assert.equal(item.source, 'fixture');
});

test('coverage records routes, endpoints, forms, actions, and edges', () => {
  const coverage = new Coverage();
  coverage.recordRoute({ url: 'http://localhost:3000/' }, {
    routeShape: 'http://localhost:3000/',
    title: 'Home',
    surfaceType: 'content'
  });
  coverage.recordEndpoint({ method: 'GET', path: '/api/items', status: 200 });
  coverage.recordForm({ id: 'search', fields: [] }, 'http://localhost:3000/');
  coverage.recordAction({ id: 'open-menu', kind: 'click-button' }, 'http://localhost:3000/', { changed: true });
  coverage.recordEdge({ from: 'open-menu', to: '/api/items' });

  const snapshot = coverage.snapshot();
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.endpoints.length, 1);
  assert.equal(snapshot.forms.length, 1);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.edges.length, 1);
});
