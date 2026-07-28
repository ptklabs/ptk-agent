'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { buildPageProbeScript } = require('../../../src/browser/pageProbeScript.cjs');
const {
  buildBrowserProbeSummary,
  sanitizeProbeSnapshot
} = require('../../../src/browser/browserProbe.cjs');
const { normalizePageModel } = require('../../../src/browser/pageModel.cjs');

test('browser probe snapshot sanitization redacts values and normalizes route candidates', () => {
  const snapshot = sanitizeProbeSnapshot({
    version: 'probe',
    url: 'http://app.test/#/contact',
    title: 'Contact',
    routeCandidates: [
      { href: '#/basket', text: 'Basket', selector: '#basket', source: 'location.hash' },
      { href: '/profile?token=secret', text: 'Profile token=secret', selector: '#profile', source: 'data-route' }
    ],
    newlyDiscoveredControls: [
      { id: 'password', type: 'password', label: 'Password', value: 'super-secret', selector: '#password' },
      { id: 'menu', label: 'Account menu', selector: '#menu', expands: true, semanticKind: 'menu-toggle', semanticScore: 65, semanticSignals: ['header'] }
    ],
    events: [
      { type: 'hashchange', url: 'http://app.test/#/contact' },
      { type: 'history.pushState', url: 'http://app.test/#/basket' }
    ],
    surfaces: [{ id: 'menu', kind: 'menu', label: 'Account' }],
    stateKey: 'http://app.test / #/contact ? menu'
  }, {
    target: { baseUrl: 'http://app.test/' },
    crawler: { preserveSpaHashRoutes: true },
    browserProbe: { enabled: true, maxRoutes: 10, maxControls: 10, maxTextChars: 1000 }
  });

  assert.equal(snapshot.routeCandidates[0].href, 'http://app.test/#/basket');
  assert.equal(snapshot.routeCandidates.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /super-secret/);
  assert.equal(snapshot.newlyDiscoveredControls.find(control => control.id === 'menu').semanticKind, 'menu-toggle');
  assert.equal(snapshot.events.length, 2);
});

test('page model merges browser probe route candidates and controls', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [{ href: 'http://app.test/#/contact', text: 'Contact', source: 'probe' }],
      newlyDiscoveredControls: [{ id: 'menu', label: 'Menu', selector: '#menu', expands: true }],
      surfaces: [{ id: 'nav', kind: 'nav', label: 'Navigation' }],
      stateKey: 'state-home-nav',
      events: [{ type: 'hashchange' }]
    }
  }, {
    baseUrl: 'http://app.test/',
    spaHashBaseUrl: 'http://app.test/',
    preserveSpaHashRoutes: true
  });

  assert.equal(model.links.some(link => link.href === 'http://app.test/#/contact'), true);
  assert.equal(model.routeCandidates.length, 1);
  assert.equal(model.newlyDiscoveredControls.length, 1);
  assert.equal(model.actions.some(action => action.id === 'menu' && action.safe), true);
  assert.equal(model.stateKey, 'state-home-nav');
  assert.equal(model.metadata.probe, true);
});

test('page model keeps safe probe controls as actions without promoting form widgets', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'menuItem', tagName: 'BUTTON', role: 'menuitem', label: 'Profile', selector: '#profile' },
        { id: 'password', tagName: 'INPUT', type: 'password', label: 'Password', selector: '#password', semanticKind: 'form-widget' },
        { id: 'plain', tagName: 'BUTTON', label: 'Plain button', selector: '#plain', semanticKind: 'generic-control' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  assert.equal(model.newlyDiscoveredControls.length, 3);
  assert.equal(model.actions.some(action => action.id === 'menuItem' && action.safe), true);
  assert.equal(model.actions.some(action => action.id === 'password'), false);
  assert.equal(model.actions.some(action => action.id === 'plain'), false);
});

test('browser probe summary counts SPA route events', () => {
  const summary = buildBrowserProbeSummary([
    {
      routeCandidates: [{ href: 'http://app.test/#/contact' }],
      newlyDiscoveredControls: [{ id: 'menu' }],
      events: [{ type: 'hashchange' }, { type: 'history.pushState' }]
    }
  ]);

  assert.equal(summary.enabled, true);
  assert.equal(summary.routeCandidates, 1);
  assert.equal(summary.controls, 1);
  assert.equal(summary.spaRouteEvents, 2);
});

test('browser probe prunes stale controls before maxControls blocks new controls', () => {
  function element(id, visible = true) {
    return {
      id,
      visible,
      tagName: 'BUTTON',
      parentElement: null,
      children: [],
      offsetWidth: visible ? 10 : 0,
      offsetHeight: visible ? 10 : 0,
      innerText: id,
      textContent: id,
      form: null,
      href: null,
      nodeType: 1,
      getAttribute(name) {
        if (name === 'id') return this.id;
        if (name === 'aria-label') return id;
        return null;
      },
      matches(selector) {
        return selector === 'button,[role="button"],[role="tab"],input[type="button"],input[type="submit"],input[type="search"],summary,[aria-expanded],[aria-haspopup]'
          || selector === '*';
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect() {
        return { top: 0, width: this.visible ? 10 : 0, height: this.visible ? 10 : 0 };
      },
      getClientRects() {
        return this.visible ? [this.getBoundingClientRect()] : [];
      }
    };
  }

  const oldControl = element('old', true);
  const newControl = element('new', false);
  const elements = [oldControl, newControl];
  const document = {
    title: 'Probe',
    body: { innerText: 'Probe page' },
    documentElement: null,
    querySelectorAll(selector) {
      if (selector === '*') return elements;
      return [];
    },
    querySelector(selector) {
      if (selector === '#old') return oldControl;
      if (selector === '#new') return newControl;
      return null;
    }
  };
  document.documentElement = document;
  const context = {
    window: {
      addEventListener() {},
      getComputedStyle(target) {
        return {
          display: target.visible === false ? 'none' : 'block',
          visibility: target.visible === false ? 'hidden' : 'visible',
          position: 'static'
        };
      }
    },
    document,
    location: { href: 'http://app.test/', hash: '', origin: 'http://app.test', pathname: '/', search: '' },
    history: { pushState() {}, replaceState() {} },
    CSS: { escape: value => String(value) },
    Date,
    Array,
    Object,
    String,
    Number,
    Math,
    RegExp,
    Set,
    Map,
    Boolean,
    JSON,
    URL
  };
  context.window.CSS = context.CSS;
  context.window.innerWidth = 1280;
  context.window.innerHeight = 800;

  vm.runInNewContext(buildPageProbeScript({ maxControls: 1, maxNodes: 10, observeMutations: false }), context);
  assert.deepEqual(context.window.__PTK_CRAWLER_V2__.snapshot().newlyDiscoveredControls.map(control => control.id), ['old']);

  oldControl.visible = false;
  oldControl.offsetWidth = 0;
  oldControl.offsetHeight = 0;
  newControl.visible = true;
  newControl.offsetWidth = 10;
  newControl.offsetHeight = 10;

  assert.deepEqual(context.window.__PTK_CRAWLER_V2__.snapshot().newlyDiscoveredControls.map(control => control.id), ['new']);
});
