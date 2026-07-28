'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePageModel, normalizeUrl, routeShape, normalizeRouteShape } = require('../../../src/browser/pageModel.cjs');
const { normalizeActions, safeActions, riskTierForAction } = require('../../../src/browser/actionModel.cjs');
const { comparePageModels, validateTransition } = require('../../../src/browser/transition.cjs');
const fixtures = require('../../fixtures/browserSnapshots.cjs');

test('page model detects login surfaces and stable route shapes', () => {
  const model = normalizePageModel(fixtures.loginPage);
  assert.equal(model.surfaceType, 'login');
  assert.equal(routeShape('http://app.test/catalog/123?x=1'), 'http://app.test/catalog/:id');
  assert.equal(normalizeRouteShape('http://app.test/catalog/123?x=1'), '/catalog/:id');
  assert.equal(model.forms[0].kind, 'login');
  assert.ok(model.authSignals.includes('password-field'));
});

test('page model canonicalizes SPA hash routes to the app base path', () => {
  assert.equal(
    normalizeUrl('http://app.test/contact#/contact', 'http://app.test/contact#/', {
      preserveSpaHashRoutes: true,
      spaHashBaseUrl: 'http://app.test/'
    }),
    'http://app.test/#/contact'
  );
  assert.equal(
    normalizeUrl('#/about', 'http://app.test/contact#/', {
      preserveSpaHashRoutes: true,
      spaHashBaseUrl: 'http://app.test/app/'
    }),
    'http://app.test/app/#/about'
  );
});

test('action model normalizes safe and destructive actions', () => {
  const model = normalizePageModel(fixtures.catalogPage);
  const actions = normalizeActions(model);
  assert.ok(actions.some(action => action.kind === 'open-menu' && action.safe));
  assert.equal(riskTierForAction({ label: 'Delete item' }), 'terminal-destructive');
  assert.equal(safeActions(model).some(action => /Delete/.test(action.label)), false);
});

test('action model does not treat null aria-expanded as an expansion signal', () => {
  const actions = normalizeActions([
    { id: 'logo', tagName: 'IMG', role: 'button', selector: 'img.logo', ariaExpanded: null, label: null },
    { id: 'account', tagName: 'BUTTON', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false', label: 'Account menu' }
  ]);

  assert.equal(actions.find(action => action.id === 'logo').kind, 'click-button');
  assert.equal(actions.find(action => action.id === 'account').kind, 'open-menu');
});

test('transition model detects modal progress and new links', () => {
  const before = normalizePageModel(fixtures.modalPageBefore);
  const after = normalizePageModel(fixtures.modalPageAfter);
  const transition = comparePageModels(before, after, { events: [{ type: 'dialog' }] });
  assert.equal(transition.changedState, true);
  assert.equal(transition.modalOpened, true);
  assert.equal(transition.newLinksAppeared, true);
  const transitionShape = validateTransition({ before, after, events: [{ type: 'dialog' }], action: { id: 'details' } });
  assert.equal(transitionShape.changed, true);
  assert.equal(transitionShape.actionId, 'details');
});
