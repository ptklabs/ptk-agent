'use strict';

const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { EventCollector, graphqlOperationName, redactHeaders, redactUrl } = require('../../../src/browser/eventCollector.cjs');

class FakePage extends EventEmitter {
  async collectDomSnapshot() {
    return {
      links: [{ href: 'http://app.test/a?token=secret', text: 'A' }],
      mutationSummary: { addedNodes: 1, removedNodes: 0, textChanges: 0 }
    };
  }
}

function fakeRequest() {
  return {
    method: () => 'POST',
    url: () => 'http://app.test/graphql?token=secret',
    resourceType: () => 'fetch',
    headers: () => ({ authorization: 'Bearer secret', accept: 'json' }),
    postData: () => JSON.stringify({ operationName: 'CatalogQuery', query: 'query CatalogQuery { items { id } }' })
  };
}

test('event collector captures requests, GraphQL names, links, and redacts secrets', async () => {
  const page = new FakePage();
  const collector = new EventCollector(page);
  const observed = collector.observe(5);
  page.emit('request', fakeRequest());
  const batch = await observed;
  assert.equal(batch.requests.length, 1);
  assert.equal(batch.requests[0].graphqlOperationName, 'CatalogQuery');
  assert.equal(batch.requests[0].headers.authorization, '[redacted]');
  assert.match(batch.links[0].href, /token=%5Bredacted%5D/);
  assert.equal(batch.mutationSummary.addedNodes, 1);
});

test('event collector detects downloads and closes out-of-scope popups', async () => {
  const page = new FakePage();
  const collector = new EventCollector(page);
  let popupClosed = false;
  const observed = collector.observe(5);

  page.emit('popup', {
    url: () => 'http://external.test/popup',
    close: () => {
      popupClosed = true;
    }
  });
  page.emit('download', {
    url: () => 'http://app.test/export?token=secret',
    suggestedFilename: () => 'export.zip'
  });

  const batch = await observed;
  assert.equal(popupClosed, true);
  assert.equal(batch.popups[0].closed, true);
  assert.equal(batch.downloads[0].detected, true);
  assert.match(batch.downloads[0].url, /token=%5Bredacted%5D/);
});

test('event collector retains in-scope child pages for session attack coverage', async () => {
  const page = new FakePage();
  const collector = new EventCollector(page, {
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      }
    }
  });
  let popupClosed = false;
  const observed = collector.observe(5);

  page.emit('popup', {
    url: () => 'http://app.test/child',
    close: () => {
      popupClosed = true;
    }
  });

  const batch = await observed;
  assert.equal(popupClosed, false);
  assert.equal(batch.popups[0].closed, false);
  assert.equal(batch.popups[0].retained, true);
  assert.equal(batch.popups[0].inScope, true);
  assert.equal(batch.popups[0].disposition, 'retained-in-scope');
});

test('event collector resolves about:blank child navigation before applying scope', async () => {
  const page = new FakePage();
  const collector = new EventCollector(page, {
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      }
    }
  });
  let popupUrl = 'about:blank';
  let popupClosed = false;
  const observed = collector.observe(20);
  page.emit('popup', {
    url: () => popupUrl,
    close: () => {
      popupClosed = true;
    }
  });
  popupUrl = 'http://app.test/child-after-blank';

  const batch = await observed;
  assert.equal(popupClosed, false);
  assert.equal(batch.popups[0].url, 'http://app.test/child-after-blank');
  assert.equal(batch.popups[0].retained, true);
});

test('redaction and GraphQL helpers are pure', () => {
  assert.equal(graphqlOperationName('mutation SaveThing { save { id } }'), 'SaveThing');
  assert.equal(redactHeaders({ cookie: 'abc', accept: 'text/html' }).cookie, '[redacted]');
  assert.match(redactUrl('http://app.test/?password=hunter2'), /password=%5Bredacted%5D/);
  const redacted = redactUrl('postgres://dbuser:dbpass@app.test/app?googlemaps=AIzaabcdefghijklmnopqrstuvwxyz123456');
  assert.ok(!redacted.includes('dbuser'));
  assert.ok(!redacted.includes('dbpass'));
  assert.ok(!redacted.includes('AIzaabcdefghijklmnopqrstuvwxyz123456'));
  assert.match(redactUrl('Bearer abcdefghijklmnopqrstuvwxyz'), /Bearer \[redacted\]/);
});
