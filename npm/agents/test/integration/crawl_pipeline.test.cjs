'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Frontier } = require('../../src/crawl/frontier.cjs');
const { Coverage } = require('../../src/crawl/coverage.cjs');
const { orchestrateRun } = require('../../src/core/orchestrator.cjs');
const { runRouteWorker } = require('../../src/crawl/routeWorker.cjs');
const { normalizePageModel } = require('../../src/browser/pageModel.cjs');

test('fake crawl pipeline visits scoped routes and records coverage without Playwright', async () => {
  const snapshots = new Map([
    ['http://app.test/', normalizePageModel({
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Catalog',
      links: [{ href: 'http://app.test/catalog', text: 'Catalog' }, { href: 'http://external.test/', text: 'External' }],
      forms: [],
      actions: []
    })],
    ['http://app.test/catalog', normalizePageModel({
      url: 'http://app.test/catalog',
      title: 'Catalog',
      visibleText: 'Catalog',
      links: [],
      forms: [],
      actions: [{ id: 'filters', kind: 'open-menu', label: 'Filters', riskTier: 'safe-interaction' }]
    })]
  ]);
  const page = {
    currentUrl: null,
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200 };
    }
  };
  const frontier = new Frontier({ baseUrl: 'http://app.test/', maxRoutes: 10 });
  const coverage = new Coverage();
  frontier.enqueue('http://app.test/', { source: 'seed' });

  while (!frontier.isEmpty()) {
    const route = frontier.dequeue();
    await runRouteWorker({
      page,
      route,
      frontier,
      coverage,
      config: { crawler: { maxRouteMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [], links: [] }),
      modelExtractor: async () => snapshots.get(page.currentUrl)
    });
  }

  const snapshot = coverage.snapshot();
  assert.equal(snapshot.summary.routesVisited, 2);
  assert.equal(snapshot.routes.some(route => route.url === 'http://external.test/'), false);
  assert.equal(snapshot.summary.actionsDiscovered, 1);
});

test('scenario mode executes the scenario before starting crawl coverage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-agent-scenario-first-'));
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify({
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'login', type: 'auth', target: '/login', success: { 'result.authState': 'authenticated' } }
    ]
  }), 'utf8');

  const states = {
    home: {
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Login Catalog',
      links: [{ href: '/login', text: 'Login' }],
      forms: [],
      actions: []
    },
    login: {
      url: 'http://app.test/login',
      title: 'Login',
      visibleText: 'Login Email Password',
      links: [],
      forms: [{
        id: 'login',
        method: 'post',
        action: '/login',
        selector: '#login',
        fields: [
          { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
          { name: 'password', type: 'password', required: true, selector: '[name="password"]' }
        ]
      }],
      actions: []
    },
    account: {
      url: 'http://app.test/account',
      title: 'Account',
      visibleText: 'My account Profile Logout',
      links: [],
      forms: [],
      actions: []
    }
  };
  const page = {
    state: 'home',
    calls: [],
    async goto(url) {
      this.calls.push({ type: 'goto', url });
      const parsed = new URL(url, 'http://app.test/');
      this.state = parsed.pathname === '/login' ? 'login' : 'home';
      return { status: () => 200 };
    },
    async snapshot() {
      return states[this.state];
    },
    async collectDomSnapshot() {
      return states[this.state];
    },
    async submitForm(form) {
      this.calls.push({ type: 'submitForm', formId: form.id });
      this.state = 'account';
    }
  };

  const result = await orchestrateRun({
    page,
    options: { cwd: dir },
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 1,
        maxRouteMs: 50,
        maxActionMs: 50,
        maxObservationMs: 0,
        maxActionsPerRoute: 0
      },
      scenario: { enabled: true, file: scenarioFile },
      profile: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
      ptk: { enabled: false }
    }
  });

  assert.equal(result.scenario.ok, true);
  assert.deepEqual(
    page.calls.slice(0, 2),
    [
      { type: 'goto', url: 'http://app.test/login' },
      { type: 'submitForm', formId: 'login' }
    ]
  );
});

test('crawl pipeline finalizes terminal documents once and continues to queued SPA route', async () => {
  const states = {
    home: {
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Legal',
      links: [{ href: 'http://app.test/ftp/legal.md', text: 'Legal' }],
      forms: [],
      actions: []
    },
    legal: {
      url: 'http://app.test/ftp/legal.md',
      title: 'Legal',
      visibleText: 'Legal notes http://app.test/#/contact',
      links: [],
      forms: [],
      actions: []
    },
    contact: {
      url: 'http://app.test/#/contact',
      title: 'Contact',
      visibleText: 'Contact',
      links: [],
      forms: [],
      actions: []
    }
  };
  const page = {
    currentUrl: 'http://app.test/',
    gotoCalls: [],
    async goto(url) {
      this.gotoCalls.push(url);
      this.currentUrl = url;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': url.endsWith('.md') ? 'text/markdown' : 'text/html' })
      };
    },
    async evaluate(fn) {
      if (typeof fn === 'function') return states[this.currentUrl.includes('/ftp/legal.md') ? 'legal' : this.currentUrl.includes('#/contact') ? 'contact' : 'home'].visibleText;
      return null;
    },
    async snapshot() {
      if (this.currentUrl.includes('/ftp/legal.md')) return states.legal;
      if (this.currentUrl.includes('#/contact')) return states.contact;
      return states.home;
    },
    async collectDomSnapshot() {
      if (this.currentUrl.includes('/ftp/legal.md')) return states.legal;
      if (this.currentUrl.includes('#/contact')) return states.contact;
      return states.home;
    }
  };

  const result = await orchestrateRun({
    page,
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 5,
        maxRouteMs: 50,
        maxActionMs: 50,
        maxObservationMs: 1,
        maxActionsPerRoute: 3,
        maxFormsPerRoute: 2,
        preserveSpaHashRoutes: true
      },
      browserProbe: { enabled: false },
      scenario: { enabled: false },
      ptk: { enabled: false }
    }
  });

  const statusSummary = result.coverage.routeStatusSummary;
  assert.equal(result.status, 'completed');
  assert.equal(statusSummary.routes.filter(route => route.routeUrl === 'http://app.test/ftp/legal.md').length, 1);
  assert.equal(statusSummary.routes.find(route => route.routeUrl === 'http://app.test/ftp/legal.md').status, 'terminal-document');
  assert.equal(statusSummary.routes.some(route => route.routeUrl === 'http://app.test/#/contact'), true);
  const lifecycleEvents = result.coverage.routeLifecycle.events;
  assert.equal(lifecycleEvents.some(event => event.type === 'forms_started' && event.routeUrl === 'http://app.test/ftp/legal.md'), false);
  assert.equal(lifecycleEvents.some(event => event.type === 'actions_started' && event.routeUrl === 'http://app.test/ftp/legal.md'), false);
  assert.deepEqual(
    lifecycleEvents
      .filter(event => event.type === 'actions_completed' && event.routeUrl === 'http://app.test/ftp/legal.md')
      .map(event => event.reason),
    ['terminal_document']
  );
  assert.equal(statusSummary.routes.find(route => route.routeUrl === 'http://app.test/ftp/legal.md').actions.attempted, 0);
  assert.equal(result.coverage.terminalDocumentSummary.total, 1);
  assert.equal(result.coverage.terminalDocumentSummary.terminalDocuments[0].terminalDocument.redactionApplied, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.coverage.terminalDocumentSummary.terminalDocuments[0].terminalDocument, 'body'), false);
});

test('crawl pipeline finalizes with the queued route shape when observed page state is stale', async () => {
  const page = {
    async goto() {
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    }
  };

  const result = await orchestrateRun({
    page,
    runRouteWorker: async ({ route }) => ({
      route,
      ok: true,
      finalStatus: 'visited',
      terminalDocument: null,
      observation: { events: [], links: [] },
      pageModel: normalizePageModel({
        url: 'http://app.test/#/stale-after-action',
        routeShape: 'http://app.test/#/stale-after-action',
        title: 'Stale',
        links: [{ href: 'http://app.test/#/next', text: 'Next' }],
        forms: [],
        actions: []
      }, { baseUrl: 'http://app.test/', spaHashBaseUrl: 'http://app.test/' })
    }),
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 1,
        maxRouteMs: 50,
        maxActionMs: 50,
        maxObservationMs: 1,
        maxActionsPerRoute: 0,
        maxFormsPerRoute: 0,
        preserveSpaHashRoutes: true
      },
      browserProbe: { enabled: false },
      scenario: { enabled: false },
      ptk: { enabled: false }
    }
  });

  const route = result.coverage.routeStatusSummary.routes[0];
  assert.equal(route.routeUrl, 'http://app.test/');
  assert.equal(route.routeShape, 'http://app.test/');
});

test('crawl pipeline suppresses repeated contact no-progress work and finalizes route', async () => {
  const contact = normalizePageModel({
    url: 'http://app.test/#/contact',
    title: 'Contact',
    visibleText: 'Contact message captcha',
    links: [],
    forms: [{
      id: 'contact',
      kind: 'contact',
      method: 'post',
      action: '/contact',
      selector: '#contact',
      fields: [{ name: 'message', type: 'text', required: true, selector: '[name="message"]' }]
    }],
    actions: [{ id: 'send', kind: 'click-button', label: 'Send', selector: '#send' }],
    validationFeedback: { messages: ['Captcha required'] }
  });
  let submitCount = 0;
  const page = {
    currentUrl: 'http://app.test/#/contact',
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    async snapshot() {
      return contact;
    },
    async collectDomSnapshot() {
      return contact;
    },
    async submitForm() {
      submitCount += 1;
    },
    async evaluate() {
      return { messages: ['Captcha required'], invalidFields: [] };
    }
  };

  const result = await orchestrateRun({
    page,
    startUrls: ['http://app.test/#/contact'],
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 2,
        maxRouteMs: 50,
        maxActionMs: 50,
        maxObservationMs: 1,
        maxActionsPerRoute: 1,
        maxFormsPerRoute: 1,
        maxNoProgressActions: 1,
        preserveSpaHashRoutes: true,
        forms: { enabled: true, allowSearch: true, allowContact: true, allowFeedback: true, allowAuth: false, allowBusinessMutation: false },
        surfaceExplorer: { enabled: false }
      },
      browserProbe: { enabled: false },
      scenario: { enabled: false },
      ptk: { enabled: false },
      profile: { values: { message: 'Bounded contact message' } }
    }
  });

  const route = result.coverage.routeStatusSummary.routes.find(item => item.routeUrl === 'http://app.test/#/contact');
  assert.equal(submitCount, 1);
  assert.equal(route.status, 'no-progress');
  assert.equal(result.coverage.formAttemptSummary.invalid, 1);
  assert.equal(result.coverage.routeLifecycle.events.some(event => event.type === 'actions_completed' && event.skipped === true), true);
});

test('surface exploration runs before form no-progress so navigation routes are not starved', async () => {
  const contact = normalizePageModel({
    url: 'http://app.test/#/contact',
    title: 'Contact',
    visibleText: 'Contact message',
    links: [],
    forms: [{
      id: 'contact',
      kind: 'contact',
      method: 'post',
      action: '/contact',
      selector: '#contact',
      fields: [{ name: 'message', type: 'text', required: true, selector: '[name="message"]' }]
    }],
    actions: [],
    probeSnapshot: {
      routeCandidates: [],
      newlyDiscoveredControls: [{ id: 'menu', label: 'Menu', selector: '#menu', hasPopup: 'menu', ariaExpanded: 'false' }]
    }
  }, { baseUrl: 'http://app.test/', preserveSpaHashRoutes: true });
  const menuOpen = normalizePageModel({
    url: 'http://app.test/#/contact',
    title: 'Contact',
    visibleText: 'Contact Profile',
    links: [{ href: 'http://app.test/profile', text: 'Profile' }],
    forms: contact.forms,
    actions: []
  }, { baseUrl: 'http://app.test/', preserveSpaHashRoutes: true });
  const profile = normalizePageModel({
    url: 'http://app.test/profile',
    title: 'Profile',
    visibleText: 'Profile',
    links: [],
    forms: [],
    actions: []
  }, { baseUrl: 'http://app.test/' });
  let submitCount = 0;
  const page = {
    state: 'contact',
    currentUrl: 'http://app.test/#/contact',
    url() {
      return this.currentUrl;
    },
    async goto(url) {
      this.currentUrl = url;
      this.state = url.includes('/profile') ? 'profile' : 'contact';
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    async snapshot() {
      if (this.state === 'menu') return menuOpen;
      if (this.state === 'profile') return profile;
      return contact;
    },
    async collectDomSnapshot() {
      return this.snapshot();
    },
    async submitForm() {
      submitCount += 1;
      this.state = 'contact';
    },
    async evaluate() {
      return { messages: ['Captcha required'], invalidFields: [] };
    },
    locator(selector) {
      return {
        first: () => ({
          click: async () => {
            if (selector === '#menu') this.state = 'menu';
          }
        })
      };
    },
    keyboard: {
      press: async () => {
        page.state = 'contact';
      }
    }
  };

  const result = await orchestrateRun({
    page,
    startUrls: ['http://app.test/#/contact'],
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 3,
        maxRouteMs: 50,
        maxActionMs: 50,
        maxObservationMs: 1,
        maxActionsPerRoute: 0,
        maxFormsPerRoute: 1,
        maxNoProgressActions: 1,
        preserveSpaHashRoutes: true,
        forms: { enabled: true, allowSearch: true, allowContact: true, allowFeedback: true, allowAuth: false, allowBusinessMutation: false },
        surfaceExplorer: { enabled: true, maxExpansionsPerRoute: 1, maxNestedExpansions: 0, maxMenuActionsPerSurface: 0, maxRouteChangingMenuActions: 0, reopenSurfaceBetweenMenuActions: true, maxExpansionMs: 10 }
      },
      browserProbe: { enabled: false },
      scenario: { enabled: false },
      ptk: { enabled: false },
      profile: { values: { message: 'Bounded contact message' } }
    }
  });

  assert.equal(submitCount, 1);
  assert.equal(result.coverage.routeStatusSummary.routes.some(route => route.routeUrl === 'http://app.test/profile'), true);
  assert.equal(result.coverage.formAttemptSummary.invalid, 1);
});

test('route deadline skips optional actions instead of exhausting the route watchdog', async () => {
  const model = normalizePageModel({
    url: 'http://app.test/about',
    title: 'About',
    visibleText: 'About page',
    links: [],
    forms: [],
    actions: [{ id: 'slow-menu', kind: 'open-menu', label: 'Slow menu', selector: '#slow', riskTier: 'safe-interaction' }]
  }, { baseUrl: 'http://app.test/about' });
  let clicked = false;
  const page = {
    currentUrl: 'http://app.test/about',
    async goto(url) {
      this.currentUrl = url;
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    async snapshot() {
      return model;
    },
    async collectDomSnapshot() {
      return model;
    },
    locator() {
      return {
        first: () => ({
          click: async () => {
            clicked = true;
          }
        })
      };
    }
  };

  const result = await orchestrateRun({
    page,
    startUrls: ['http://app.test/about'],
    config: {
      target: {
        baseUrl: 'http://app.test/',
        scope: { include: ['http://app.test/**'], exclude: [] }
      },
      crawler: {
        maxRoutes: 1,
        maxRouteMs: 300,
        maxActionMs: 100,
        maxObservationMs: 1,
        maxActionsPerRoute: 1,
        maxFormsPerRoute: 0,
        maxNoProgressActions: 1,
        preserveSpaHashRoutes: true,
        forms: { enabled: true, allowSearch: true, allowContact: true, allowFeedback: true, allowAuth: false, allowBusinessMutation: false },
        surfaceExplorer: { enabled: false }
      },
      browserProbe: { enabled: false },
      scenario: { enabled: false },
      ptk: { enabled: false }
    },
    runRouteWorker: async ({ route }) => {
      await new Promise(resolve => setTimeout(resolve, 550));
      return {
        route,
        ok: true,
        finalStatus: 'visited',
        reason: 'visited',
        pageModel: model,
        observation: { events: [], links: [] }
      };
    }
  });

  assert.equal(clicked, false);
  assert.equal(result.coverage.routeStatusSummary.statuses.timeout || 0, 0);
  assert.equal(result.coverage.routeLifecycle.events.some(event => event.type === 'actions_completed' && event.budgetSkipped === true), true);
});
