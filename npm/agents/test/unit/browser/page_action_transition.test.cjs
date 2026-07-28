'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeActions, safeActions } = require('../../../src/browser/actionModel.cjs');
const { getExternalRedirectTarget, matchesPattern, normalizeScope, isInScope } = require('../../../src/browser/context.cjs');
const { graphqlOperationName } = require('../../../src/browser/eventCollector.cjs');
const { normalizePageModel, routeShape } = require('../../../src/browser/pageModel.cjs');
const { validateTransition } = require('../../../src/browser/transition.cjs');

test('scope matching supports double-star routes without leaving origin', () => {
  const scope = normalizeScope('http://localhost:3000/', ['http://localhost:3000/**'], []);

  assert.equal(matchesPattern('http://localhost:3000/a/b', 'http://localhost:3000/**'), true);
  assert.equal(isInScope('http://localhost:3000/a/b', scope), true);
  assert.equal(isInScope('http://evil.test/a', scope), false);
});

test('scope matching blocks same-origin redirectors that target another origin', () => {
  const scope = normalizeScope('http://localhost:3000/', ['http://localhost:3000/**'], []);
  const redirect = 'http://localhost:3000/redirect?to=https://github.com/example/project';

  assert.equal(getExternalRedirectTarget(redirect, scope), 'https://github.com/example/project');
  assert.equal(isInScope(redirect, scope), false);
  assert.equal(isInScope('http://localhost:3000/redirect?to=/local/path', scope), true);
});

test('page model infers route shape and login/search surfaces', () => {
  const login = normalizePageModel({
    url: 'http://localhost:3000/users/123',
    title: 'Login',
    forms: [{ id: 'login', kind: 'login', fields: [] }],
    links: [],
    actions: [],
    visibleTextSummary: 'Sign in'
  });

  assert.equal(routeShape('http://localhost:3000/users/123'), 'http://localhost:3000/users/:id');
  assert.equal(login.surfaceType, 'login');
});

test('page model infers transfer and virtual feedback form surfaces', () => {
  const model = normalizePageModel({
    url: 'http://localhost:3000/contact',
    title: 'Contact',
    forms: [
      { id: 'transfer', fields: [{ name: 'fromAccount' }, { name: 'toAccount' }, { name: 'amount' }] },
      { id: 'synthetic-feedback', synthetic: true, virtual: true, fields: [{ name: 'email' }, { name: 'comment' }] }
    ],
    links: [],
    actions: [],
    visibleTextSummary: 'Contact support'
  });

  assert.equal(model.forms[0].kind, 'transfer');
  assert.equal(model.forms[1].kind, 'feedback');
  assert.equal(model.forms[1].virtual, true);
});

test('action model separates safe actions from business mutations', () => {
  const model = normalizePageModel({
    url: 'http://localhost:3000/',
    links: [{ id: 'l1', href: 'http://localhost:3000/menu', text: 'Menu' }],
    actions: [{ id: 'delete', text: 'Delete account', type: 'button' }],
    forms: [{ id: 'contact', kind: 'generic', fields: [] }]
  });
  const actions = normalizeActions(model);

  assert.ok(actions.some(action => action.kind === 'click-link'));
  assert.ok(actions.some(action => action.riskTier === 'terminal-destructive'));
  assert.equal(safeActions(model).every(action => action.riskTier === 'safe-interaction'), true);
});

test('transition validation prefers strong state and endpoint signals', () => {
  const before = normalizePageModel({ url: 'http://localhost:3000/a', links: [], forms: [], actions: [] });
  const after = normalizePageModel({ url: 'http://localhost:3000/b', links: [], forms: [], actions: [] });
  const transition = validateTransition({
    before,
    after,
    events: [{ type: 'response', path: '/api/items', status: 200 }]
  });

  assert.equal(transition.changed, true);
  assert.ok(transition.signals.includes('route-changed'));
  assert.ok(transition.signals.includes('endpoint-observed'));
});

test('graphql operation names are extracted from request payloads', () => {
  assert.equal(graphqlOperationName({ query: 'query ProductList { products { id } }' }), 'ProductList');
  assert.equal(graphqlOperationName('{"operationName":"LoginUser","query":"mutation LoginUser { login }"}'), 'LoginUser');
});
