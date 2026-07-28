'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Frontier } = require('../../../src/crawl/frontier.cjs');
const { normalizePageModel } = require('../../../src/browser/pageModel.cjs');
const {
  buildAuthSurfaceSummary,
  closeExpandedSurface,
  enqueueSurfaceRoutes,
  isSafeExpansion,
  nestedSurfaceActionCandidates,
  runSurfaceExplorer,
  surfaceExpansionCandidates
} = require('../../../src/crawl/surfaceExplorer.cjs');

test('surface explorer candidates allow menus and block logout/payment controls', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'menu', label: 'Account menu', selector: '#menu', expands: true },
        { id: 'ordersPaymentMenu', label: 'Show Orders and Payment Menu', selector: '#orders-payment', expands: true, hasPopup: 'menu', semanticKind: 'menu-toggle' },
        { id: 'logout', label: 'Logout', selector: '#logout', expands: true },
        { id: 'pay', label: 'Submit payment', selector: '#pay', expands: true }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  const candidates = surfaceExpansionCandidates(model, {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } }
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['ordersPaymentMenu', 'menu']);
  assert.equal(isSafeExpansion(candidates[0]), true);
  assert.equal(candidates.some(candidate => candidate.id === 'logout'), false);
  assert.equal(candidates.some(candidate => candidate.id === 'pay'), false);
});

test('nested surface candidates allow saved payment routes but block payment mutations', () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: { routeCandidates: [], newlyDiscoveredControls: [] }
  }, { baseUrl: 'http://app.test/' });
  const after = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'savedPayment', tagName: 'BUTTON', label: 'Go to saved payment methods page', routeTarget: '/saved-payment-methods', semanticKind: 'route-control', selector: '#savedPayment' },
        { id: 'payNow', tagName: 'BUTTON', label: 'Submit payment now', selector: '#payNow' },
        { id: 'ordersPaymentMenu', tagName: 'BUTTON', label: 'Show Orders and Payment Menu', selector: '#orders-payment', hasPopup: 'menu', semanticKind: 'menu-toggle' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  const candidates = nestedSurfaceActionCandidates(before, after, {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
    crawler: { preserveSpaHashRoutes: true }
  });

  assert.equal(candidates.some(candidate => candidate.id === 'savedPayment' && candidate.href === 'http://app.test/saved-payment-methods'), true);
  assert.equal(candidates.some(candidate => candidate.id === 'ordersPaymentMenu' && candidate.kind === 'open-menu'), true);
  assert.equal(candidates.some(candidate => candidate.id === 'payNow'), false);
});

test('nested surface candidates resolve router-style route targets against hash SPA base', () => {
  const before = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: { routeCandidates: [], newlyDiscoveredControls: [] }
  }, { baseUrl: 'http://app.test/#/', preserveSpaHashRoutes: true });
  const after = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'orderHistory', tagName: 'BUTTON', role: 'menuitem', label: 'Order history', routeTarget: '/order-history', semanticKind: 'route-control', selector: 'button[routerlink="/order-history"]' },
        { id: 'savedAddress', tagName: 'BUTTON', role: 'menuitem', label: 'Saved address', routeTarget: '/address/saved', semanticKind: 'route-control', selector: 'button[routerlink="/address/saved"]' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/', preserveSpaHashRoutes: true });

  const candidates = nestedSurfaceActionCandidates(before, after, {
    target: { baseUrl: 'http://app.test/#/', scope: { include: ['http://app.test/**'], exclude: [] } },
    crawler: { preserveSpaHashRoutes: true }
  });

  assert.equal(candidates.find(candidate => candidate.id === 'orderHistory').href, 'http://app.test/#/order-history');
  assert.equal(candidates.find(candidate => candidate.id === 'savedAddress').href, 'http://app.test/#/address/saved');
});

test('page model normalizes probe route controls to hash SPA routes', () => {
  const model = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'wallet', tagName: 'BUTTON', role: 'menuitem', label: 'Wallet', selector: 'button[routerlink="/wallet"]', routeTarget: '/wallet', semanticKind: 'route-control' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/', preserveSpaHashRoutes: true });

  assert.equal(model.actions.find(action => action.id === 'wallet').href, 'http://app.test/#/wallet');
});

test('surface explorer ignores generic images and form fields without expansion signals', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'logo', tagName: 'IMG', role: 'button', ariaExpanded: null, label: '', selector: 'img.logo' },
        { id: 'email', tagName: 'INPUT', type: 'email', label: 'Email', selector: '#email' },
        { id: 'realMenu', tagName: 'BUTTON', label: 'More menu', selector: '#realMenu', hasPopup: 'menu' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  const candidates = surfaceExpansionCandidates(model, {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } }
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['realMenu']);
});

test('surface explorer prioritizes app drawer controls and rejects select widgets', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'learnMore', tagName: 'A', role: 'button', label: 'Learn more', ariaLabel: 'learn more about cookies', selector: 'main > a:nth-of-type(1)', href: 'https://external.test/more' },
        { id: 'homeRoute', tagName: 'BUTTON', label: 'Home', selector: 'header button:nth-of-type(2)', semanticKind: 'route-control', routeTarget: '/home' },
        { id: 'nextPage', tagName: 'BUTTON', label: 'Next page', selector: '.paginator button:nth-of-type(2)', semanticKind: 'pagination-control' },
        { id: 'navbarAccount', tagName: 'BUTTON', label: 'Account', ariaLabel: 'Show/hide account menu', selector: '#navbarAccount', hasPopup: 'menu', ariaExpanded: 'false' },
        { id: 'mat-select-1', tagName: 'MAT-SELECT', role: 'combobox', label: '12', selector: '#mat-select-1', hasPopup: 'listbox', ariaExpanded: 'false' },
        { id: 'navToggle', tagName: 'BUTTON', label: '☰', selector: 'header button:nth-of-type(1)', semanticKind: 'navigation-toggle', semanticScore: 100 },
        { id: 'navbarLanguageButton', tagName: 'BUTTON', label: 'Language selection menu', selector: '#navbarLanguageButton', hasPopup: 'menu', ariaExpanded: 'false' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  const candidates = surfaceExpansionCandidates(model, {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } }
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['navToggle', 'navbarAccount', 'navbarLanguageButton']);
  assert.equal(candidates[0].semanticKind, 'navigation-toggle');
  assert.equal(candidates.some(candidate => candidate.id === 'mat-select-1'), false);
  assert.equal(candidates.some(candidate => candidate.id === 'learnMore'), false);
  assert.equal(candidates.some(candidate => candidate.id === 'homeRoute'), false);
  assert.equal(candidates.some(candidate => candidate.id === 'nextPage'), false);
});

test('surface explorer does not infer expansion from label text alone', () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'labelOnly', tagName: 'BUTTON', label: 'Open Sidenav', ariaLabel: 'Open Sidenav', selector: '#labelOnly' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });

  const candidates = surfaceExpansionCandidates(model, {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } }
  });

  assert.deepEqual(candidates, []);
});

test('surface route enqueue records surface-expansion priority before plain links', () => {
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  frontier.enqueue('http://app.test/plain', { source: 'plain-link' });

  const result = enqueueSurfaceRoutes({
    frontier,
    before: { url: 'http://app.test/' },
    after: { links: [{ href: 'http://app.test/profile' }] },
    observation: {},
    action: { id: 'menu' }
  });

  assert.equal(result.added, 1);
  assert.deepEqual(frontier.snapshot().queue.map(route => route.url), [
    'http://app.test/profile',
    'http://app.test/plain'
  ]);
  assert.equal(frontier.snapshot().queue[0].source, 'surface-expansion');
});

test('surface explorer suppresses repeated surface attempts across routes through run state', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'navToggle', label: '☰', selector: '#nav', semanticKind: 'navigation-toggle', semanticScore: 100 }]
    }
  }, { baseUrl: 'http://app.test/' });
  const after = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile',
    links: [{ href: 'http://app.test/profile', text: 'Profile' }],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  const config = {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
    crawler: { surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxExpansionMs: 10 }, preserveSpaHashRoutes: true },
    browserProbe: { enabled: false }
  };
  const surfaceState = { attemptedSignatures: new Set() };
  const page = {
    clicked: false,
    locator() {
      return {
        first: () => ({
          click: async () => {
            this.clicked = true;
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const first = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config,
    surfaceState,
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : before
  });
  page.clicked = false;
  const second = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config,
    surfaceState,
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : before
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('surface explorer retries a surface after auth state changes', async () => {
  const anonymous = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/' });
  const authenticated = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile Dashboard',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/' });
  authenticated.authSignals = ['authenticated-text'];
  const after = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile',
    links: [{ href: 'http://app.test/profile', text: 'Profile' }],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  const config = {
    target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
    crawler: { surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxExpansionMs: 10 }, preserveSpaHashRoutes: true },
    browserProbe: { enabled: false }
  };
  const surfaceState = { attemptedSignatures: new Set() };
  const page = {
    clicked: false,
    locator() {
      return {
        first: () => ({
          click: async () => {
            this.clicked = true;
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const first = await runSurfaceExplorer({
    page,
    pageModel: anonymous,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config,
    surfaceState,
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : anonymous
  });
  page.clicked = false;
  const second = await runSurfaceExplorer({
    page,
    pageModel: authenticated,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config,
    surfaceState,
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : authenticated
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test('surface explorer clicks menu, enqueues newly revealed links, and blocks logout', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'menu', label: 'Account menu', selector: '#menu', expands: true }]
    }
  }, { baseUrl: 'http://app.test/' });
  const after = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile Logout',
    links: [
      { href: 'http://app.test/profile', text: 'Profile' },
      { href: 'http://app.test/logout', text: 'Logout' },
      { href: 'https://external.test/', text: 'External' }
    ],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const page = {
    clicked: false,
    locator() {
      return {
        first: () => ({
          click: async () => {
            this.clicked = true;
          }
        })
      };
    }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: ['http://app.test/logout'] } },
      crawler: { surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxExpansionMs: 10 }, preserveSpaHashRoutes: true },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : before
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/profile'));
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'http://app.test/logout'), false);
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'https://external.test/'), false);
});

test('surface explorer clicks one safe nested menu action and enqueues resulting route', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/' });
  const menuOpen = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile Logout',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'profileAction', tagName: 'BUTTON', role: 'menuitem', label: 'Profile', selector: '#profileAction' },
        { id: 'logoutAction', tagName: 'BUTTON', role: 'menuitem', label: 'Logout', selector: '#logoutAction' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });
  const profile = normalizePageModel({
    url: 'http://app.test/profile',
    title: 'Profile',
    visibleText: 'Profile',
    links: [],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const page = {
    clicked: [],
    locator(selector) {
      return {
        first: () => ({
          click: async () => {
            this.clicked.push(selector);
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: { surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxNestedExpansions: 1, maxExpansionMs: 10 }, preserveSpaHashRoutes: true },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => {
      if (page.clicked.includes('#profileAction')) return profile;
      if (page.clicked.includes('#account')) return menuOpen;
      return before;
    }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].nestedResults.filter(result => result.ok).length, 1);
  assert.equal(results[0].nestedResults.find(result => result.ok).action.id, 'profileAction');
  assert.equal(results[0].nestedResults.some(result => result.blocked && result.action.id === 'logoutAction'), true);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/profile'));
  assert.equal(page.clicked.includes('#logoutAction'), false);
});

test('surface explorer executes multiple safe authenticated menu actions and reopens the surface', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile Dashboard',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/' });
  before.authSignals = ['authenticated-text'];
  const menuOpen = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile Wallet Orders Logout',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'profileAction', tagName: 'BUTTON', role: 'menuitem', label: 'Profile', selector: '#profileAction' },
        { id: 'walletAction', tagName: 'BUTTON', role: 'menuitem', label: 'Wallet', selector: '#walletAction' },
        { id: 'ordersAction', tagName: 'BUTTON', role: 'menuitem', label: 'Orders', selector: '#ordersAction' },
        { id: 'logoutAction', tagName: 'BUTTON', role: 'menuitem', label: 'Sign out', selector: '#logoutAction' }
      ]
    }
  }, { baseUrl: 'http://app.test/' });
  const routes = {
    '#profileAction': normalizePageModel({ url: 'http://app.test/profile', title: 'Profile', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/' }),
    '#walletAction': normalizePageModel({ url: 'http://app.test/wallet', title: 'Wallet', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/' }),
    '#ordersAction': normalizePageModel({ url: 'http://app.test/orders', title: 'Orders', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/' })
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 20 });
  const page = {
    state: 'before',
    clicked: [],
    currentUrl: 'http://app.test/',
    url() {
      return this.currentUrl;
    },
    async goto(url) {
      this.currentUrl = url;
      const normalized = String(url);
      if (normalized.endsWith('/profile')) this.state = '#profileAction';
      else if (normalized.endsWith('#/order-history')) this.state = '#orderHistory';
      else if (normalized.endsWith('#/address/saved')) this.state = '#savedAddress';
      return { status: () => 200 };
    },
    async recoverToRoute(url) {
      this.state = 'before';
      this.currentUrl = url;
      return { ok: true, url };
    },
    locator(selector) {
      return {
        first: () => ({
          click: async () => {
            this.clicked.push(selector);
            if (selector === '#account') {
              this.state = 'menu';
              this.currentUrl = 'http://app.test/';
              return;
            }
            if (selector === '#logoutAction') throw new Error('logout should be blocked');
            if (routes[selector]) {
              this.state = selector;
              this.currentUrl = routes[selector].url;
            }
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: {
        surfaceExplorer: {
          enabled: true,
          maxExpansionsPerRoute: 5,
          maxNestedExpansions: 1,
          maxMenuActionsPerSurface: 8,
          maxRouteChangingMenuActions: 8,
          reopenSurfaceBetweenMenuActions: true,
          maxExpansionMs: 10
        },
        preserveSpaHashRoutes: true,
        maxNoProgressActions: 2
      },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => {
      if (page.state === 'menu') return menuOpen;
      return routes[page.state] || before;
    },
    surfaceState: { attemptedSignatures: new Set(), nestedAttemptedSignatures: new Set() }
  });

  const nestedOk = results[0].nestedResults.filter(result => result.ok);
  assert.equal(nestedOk.length, 3);
  assert.equal(results[0].nestedResults.some(result => result.blocked && result.action.id === 'logoutAction'), true);
  assert.equal(page.clicked.filter(selector => selector === '#account').length >= 3, true);
  assert.equal(page.clicked.includes('#logoutAction'), false);
  const queued = frontier.snapshot().queue.map(route => route.url);
  assert.ok(queued.includes('http://app.test/profile'));
  assert.ok(queued.includes('http://app.test/wallet'));
  assert.ok(queued.includes('http://app.test/orders'));
});

test('surface explorer recursively enumerates second-level authenticated menu routes within crawl depth', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Account',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/#/' });
  before.authSignals = ['authenticated-text'];

  const accountOpen = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Profile Orders',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'ordersMenu', tagName: 'BUTTON', role: 'menuitem', label: 'Orders and account history', selector: '#ordersMenu', hasPopup: 'menu', semanticKind: 'menu-toggle', ariaExpanded: 'false' },
        { id: 'profileAction', tagName: 'BUTTON', role: 'menuitem', label: 'Profile', selector: '#profileAction', routeTarget: '/profile', semanticKind: 'route-control' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/' });

  const ordersOpen = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Order history Saved addresses Sign out',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'ordersMenu', tagName: 'BUTTON', role: 'menuitem', label: 'Orders and account history', selector: '#ordersMenu', hasPopup: 'menu', semanticKind: 'menu-toggle', ariaExpanded: 'true' },
        { id: 'orderHistory', tagName: 'BUTTON', role: 'menuitem', label: 'Order history', selector: '#orderHistory', routeTarget: '/order-history', semanticKind: 'route-control' },
        { id: 'savedAddress', tagName: 'BUTTON', role: 'menuitem', label: 'Saved addresses', selector: '#savedAddress', routeTarget: '/address/saved', semanticKind: 'route-control' },
        { id: 'logoutAction', tagName: 'BUTTON', role: 'menuitem', label: 'Sign out', selector: '#logoutAction' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/' });

  const routeModels = {
    '#profileAction': normalizePageModel({ url: 'http://app.test/profile', title: 'Profile', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/#/' }),
    '#orderHistory': normalizePageModel({ url: 'http://app.test/#/order-history', title: 'Order history', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/#/' }),
    '#savedAddress': normalizePageModel({ url: 'http://app.test/#/address/saved', title: 'Saved addresses', links: [], forms: [], actions: [] }, { baseUrl: 'http://app.test/#/' })
  };

  const frontier = new Frontier({ baseUrl: 'http://app.test/#/', maxRoutes: 20, maxDepth: 5 });
  const page = {
    state: 'before',
    currentUrl: 'http://app.test/#/',
    clicked: [],
    url() {
      return this.currentUrl;
    },
    async goto(url) {
      this.currentUrl = url;
      const normalized = String(url);
      if (normalized.endsWith('/profile')) this.state = '#profileAction';
      else if (normalized.endsWith('#/order-history')) this.state = '#orderHistory';
      else if (normalized.endsWith('#/address/saved')) this.state = '#savedAddress';
      return { status: () => 200 };
    },
    async recoverToRoute(url) {
      this.state = 'before';
      this.currentUrl = url;
      return { ok: true, url };
    },
    locator(selector) {
      return {
        first: () => ({
          click: async () => {
            this.clicked.push(selector);
            if (selector === '#account') {
              this.state = 'account';
              this.currentUrl = 'http://app.test/#/';
              return;
            }
            if (selector === '#ordersMenu') {
              this.state = 'orders';
              this.currentUrl = 'http://app.test/#/';
              return;
            }
            if (selector === '#logoutAction') throw new Error('logout should be blocked');
            if (routeModels[selector]) {
              this.state = selector;
              this.currentUrl = routeModels[selector].url;
            }
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/#/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: {
        maxDepth: 5,
        preserveSpaHashRoutes: true,
        maxNoProgressActions: 2,
        surfaceExplorer: {
          enabled: true,
          maxExpansionsPerRoute: 5,
          maxNestedExpansions: 5,
          maxMenuActionsPerSurface: 8,
          maxRouteChangingMenuActions: 8,
          reopenSurfaceBetweenMenuActions: true,
          maxExpansionMs: 10
        }
      },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => {
      if (page.state === 'account') return accountOpen;
      if (page.state === 'orders') return ordersOpen;
      return routeModels[page.state] || before;
    },
    surfaceState: { attemptedSignatures: new Set(), nestedAttemptedSignatures: new Set() }
  });

  assert.equal(results.length, 1);
  const nestedOk = results[0].nestedResults.filter(result => result.ok);
  assert.equal(nestedOk.some(result => result.action.id === 'ordersMenu'), true);
  assert.equal(nestedOk.some(result => result.action.id === 'orderHistory'), true);
  assert.equal(nestedOk.some(result => result.action.id === 'savedAddress'), true);
  assert.equal(results[0].nestedResults.some(result => result.blocked && result.action.id === 'logoutAction'), true);
  assert.equal(page.clicked.filter(selector => selector === '#account').length >= 2, true);
  assert.equal(page.clicked.filter(selector => selector === '#ordersMenu').length >= 2, true);
  assert.equal(page.clicked.includes('#logoutAction'), false);
  const queued = frontier.snapshot().queue;
  assert.ok(queued.some(route => route.url === 'http://app.test/#/order-history' && route.depth === 2));
  assert.ok(queued.some(route => route.url === 'http://app.test/#/address/saved' && route.depth === 2));
  assert.ok(queued.some(route => route.url === 'http://app.test/profile' && route.depth === 1));
});

test('surface explorer does not execute second-level menu routes beyond crawl depth', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Account',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/#/' });
  const accountOpen = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Orders',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'ordersMenu', tagName: 'BUTTON', role: 'menuitem', label: 'Orders', selector: '#ordersMenu', hasPopup: 'menu', semanticKind: 'menu-toggle', ariaExpanded: 'false' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/' });
  const ordersOpen = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Home Order history',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'account', tagName: 'BUTTON', label: 'Account', selector: '#account', hasPopup: 'menu', ariaExpanded: 'true' },
        { id: 'ordersMenu', tagName: 'BUTTON', role: 'menuitem', label: 'Orders', selector: '#ordersMenu', hasPopup: 'menu', semanticKind: 'menu-toggle', ariaExpanded: 'true' },
        { id: 'orderHistory', tagName: 'BUTTON', role: 'menuitem', label: 'Order history', selector: '#orderHistory', routeTarget: '/order-history', semanticKind: 'route-control' }
      ]
    }
  }, { baseUrl: 'http://app.test/#/' });
  const frontier = new Frontier({ baseUrl: 'http://app.test/#/', maxRoutes: 20, maxDepth: 1 });
  const page = {
    state: 'before',
    clicked: [],
    async goto(url) {
      this.clicked.push(`goto:${url}`);
      if (String(url).endsWith('#/order-history')) throw new Error('second-level route should be blocked by depth');
      return { status: () => 200 };
    },
    async recoverToRoute() {
      this.state = 'before';
      return { ok: true };
    },
    locator(selector) {
      return {
        first: () => ({
          click: async () => {
            this.clicked.push(selector);
            if (selector === '#account') this.state = 'account';
            if (selector === '#ordersMenu') this.state = 'orders';
            if (selector === '#orderHistory') throw new Error('second-level route should be blocked by depth');
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/#/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: {
        maxDepth: 1,
        preserveSpaHashRoutes: true,
        surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxNestedExpansions: 5, maxMenuActionsPerSurface: 8, maxRouteChangingMenuActions: 8, reopenSurfaceBetweenMenuActions: true, maxExpansionMs: 10 }
      },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.state === 'account' ? accountOpen : page.state === 'orders' ? ordersOpen : before,
    surfaceState: { attemptedSignatures: new Set(), nestedAttemptedSignatures: new Set() }
  });

  assert.equal(results[0].nestedResults.some(result => result.action.id === 'ordersMenu' && result.ok), true);
  assert.equal(results[0].nestedResults.some(result => result.action.id === 'orderHistory' && result.reason === 'max_depth'), true);
  assert.equal(page.clicked.includes('#orderHistory'), false);
  assert.equal(frontier.snapshot().queue.some(route => route.url === 'http://app.test/#/order-history'), false);
});

test('auth surface summary reports executed, blocked, and discovered authenticated menu actions', () => {
  const pageModel = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'My account Profile',
    links: [],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  pageModel.authSignals = ['authenticated-text'];
  const summary = buildAuthSurfaceSummary([
    {
      pageModel,
      surfaceResults: [
        {
          ok: true,
          action: { id: 'account', label: 'Account' },
          nestedResults: [
            { ok: true, action: { id: 'profile', label: 'Profile', selector: '#profile' }, transition: { routeChanged: true }, enqueuedRoutes: { added: 1 } },
            { ok: false, blocked: true, skipped: true, action: { id: 'logout', label: 'Sign out', selector: '#logout' }, reason: 'unsafe_menu_action' }
          ]
        }
      ]
    }
  ]);

  assert.equal(summary.authenticatedSurfacesOpened, 1);
  assert.equal(summary.menuActionsDiscovered, 2);
  assert.equal(summary.menuActionsExecuted, 1);
  assert.equal(summary.routesDiscoveredFromAuthMenus, 1);
  assert.equal(summary.blockedUnsafeMenuActions.length, 1);
});

test('auth surface summary counts route transitions from authenticated menus even when route was already queued', () => {
  const pageModel = normalizePageModel({
    url: 'http://app.test/#/',
    title: 'Home',
    visibleText: 'Account',
    links: [],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/#/' });
  const summary = buildAuthSurfaceSummary([
    {
      pageModel,
      surfaceResults: [
        {
          ok: true,
          action: { id: 'account', label: 'Account' },
          nestedResults: [
            { ok: true, action: { id: 'orders', label: 'Order history', selector: '#orders' }, transition: { routeChanged: true }, enqueuedRoutes: { added: 0 } },
            { ok: false, blocked: true, skipped: true, action: { id: 'signout', label: 'Sign out', selector: '#signout' }, reason: 'unsafe_menu_action' }
          ]
        }
      ]
    }
  ]);

  assert.equal(summary.authenticatedSurfacesOpened, 1);
  assert.equal(summary.routesDiscoveredFromAuthMenus, 1);
});

test('surface explorer treats post-click surface change as success after action timeout', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'navToggle', label: '☰', selector: '#nav', semanticKind: 'navigation-toggle', semanticScore: 100 }]
    }
  }, { baseUrl: 'http://app.test/' });
  const after = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home Profile',
    links: [{ href: 'http://app.test/profile', text: 'Profile' }],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const page = {
    clicked: false,
    locator() {
      return {
        first: () => ({
          click: async () => {
            this.clicked = true;
            throw new Error('pointer intercepted after surface opened');
          }
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: before,
    frontier,
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: { surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 5, maxExpansionMs: 10 }, preserveSpaHashRoutes: true },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => page.clicked ? after : before
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.match(results[0].warning, /pointer intercepted/);
  assert.ok(frontier.snapshot().queue.some(route => route.url === 'http://app.test/profile'));
});

test('surface explorer yields budget exhaustion instead of holding the route watchdog', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/',
    title: 'Home',
    visibleText: 'Home',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'navToggle', label: 'Navigation', selector: '#nav', semanticKind: 'navigation-toggle', semanticScore: 100 }
      ]
    }
  }, { baseUrl: 'http://app.test/' });
  const page = {
    locator() {
      return {
        first: () => ({
          click: async () => {}
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const results = await runSurfaceExplorer({
    page,
    pageModel: model,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: {
        preserveSpaHashRoutes: true,
        surfaceExplorer: {
          enabled: true,
          maxExpansionsPerRoute: 3,
          maxNestedExpansions: 0,
          maxExpansionMs: 20,
          maxSurfaceMs: 10
        }
      },
      browserProbe: { enabled: false }
    },
    observe: async () => new Promise(resolve => setTimeout(() => resolve({ events: [], links: [] }), 30)),
    modelExtractor: async () => model
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].budgetExhausted, true);
  assert.equal(results[0].reason, 'surface_explorer_budget_exhausted');
});

test('closeExpandedSurface treats DOM fallback timeout as non-fatal cleanup', async () => {
  const startedAt = Date.now();
  const page = {
    evaluate: async () => new Promise(resolve => setTimeout(() => resolve({ dispatchedEscape: true }), 40))
  };

  const closed = await closeExpandedSurface(page, 5);

  assert.equal(closed, false);
  assert.ok(Date.now() - startedAt < 100);
});

test('surface explorer bounds a hanging surface click with its own budget', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/about',
    title: 'About',
    visibleText: 'About',
    links: [],
    forms: [],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [
        { id: 'about-menu', label: 'About menu', selector: '#about-menu', semanticKind: 'navigation-toggle', semanticScore: 100 }
      ]
    }
  }, { baseUrl: 'http://app.test/about' });

  const page = {
    locator() {
      return {
        first: () => ({
          click: async () => new Promise(() => {})
        })
      };
    },
    keyboard: { press: async () => {} }
  };

  const startedAt = Date.now();
  const results = await runSurfaceExplorer({
    page,
    pageModel: model,
    frontier: new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 }),
    config: {
      target: { baseUrl: 'http://app.test/', scope: { include: ['http://app.test/**'], exclude: [] } },
      crawler: {
        preserveSpaHashRoutes: true,
        surfaceExplorer: {
          enabled: true,
          maxExpansionsPerRoute: 1,
          maxNestedExpansions: 0,
          maxExpansionMs: 10,
          maxSurfaceMs: 25
        }
      },
      browserProbe: { enabled: false }
    },
    observe: async () => ({ events: [], links: [] }),
    modelExtractor: async () => model
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].budgetExhausted, true);
  assert.equal(results[0].reason, 'surface_explorer_budget_exhausted');
  assert.ok(Date.now() - startedAt < 500);
});
