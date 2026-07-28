'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileScenario } = require('../../../src/scenario/scenarioCompiler.cjs');
const { runScenario } = require('../../../src/scenario/scenarioWorker.cjs');

function createScenarioMockPage(initialState = 'home') {
  const states = {
    home: {
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Login Catalog Contact',
      links: [
        { href: '/login', text: 'Login' },
        { href: '/catalog', text: 'Catalog' },
        { href: '/contact', text: 'Contact' }
      ],
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
      links: [{ href: '/catalog', text: 'Catalog' }],
      forms: [],
      actions: []
    },
    loginSubmittedNoAuth: {
      url: 'http://app.test/login',
      title: 'Login',
      visibleText: 'Login request submitted',
      links: [],
      forms: [],
      actions: []
    },
    catalog: {
      url: 'http://app.test/catalog',
      title: 'Catalog',
      visibleText: 'Catalog Search products',
      links: [{ href: '/contact', text: 'Contact' }],
      forms: [{
        id: 'search',
        kind: 'search',
        method: 'get',
        action: '/search',
        selector: '#search',
        fields: [{ name: 'q', type: 'search', required: true, selector: '[name="q"]' }]
      }],
      actions: []
    },
    searchResults: {
      url: 'http://app.test/search?q=apple',
      title: 'Search results',
      surfaceType: 'search-results',
      visibleText: 'Search results for apple',
      links: [{ href: '/contact', text: 'Contact' }],
      forms: [],
      actions: []
    },
    contact: {
      url: 'http://app.test/contact',
      title: 'Contact',
      visibleText: 'Contact us Name Email Message',
      links: [],
      forms: [{
        id: 'contact',
        method: 'post',
        action: '/contact',
        selector: '#contact',
        fields: [
          { name: 'name', type: 'text', required: true, selector: '[name="name"]' },
          { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
          { name: 'message', type: 'textarea', required: false, selector: '[name="message"]' }
        ]
      }],
      actions: []
    },
    thanks: {
      url: 'http://app.test/contact/thanks',
      title: 'Thanks',
      visibleText: 'Thanks Message received',
      links: [],
      forms: [],
      actions: []
    },
    invalidContact: {
      url: 'http://app.test/contact',
      title: 'Contact',
      visibleText: 'Contact us Email is invalid',
      links: [],
      blockers: [{ kind: 'validation', text: 'Email is invalid' }],
      validationFeedback: {
        messages: ['Email is invalid'],
        invalidFields: [{ field: 'email', message: 'Email is invalid' }]
      },
      forms: [{
        id: 'contact',
        method: 'post',
        action: '/contact',
        selector: '#contact',
        fields: [
          { name: 'name', type: 'text', required: true, selector: '[name="name"]' },
          { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
          { name: 'message', type: 'textarea', required: false, selector: '[name="message"]' }
        ]
      }],
      actions: []
    }
  };
  const calls = [];
  return {
    calls,
    state: initialState,
    async snapshot() {
      return states[this.state];
    },
    async goto(url) {
      calls.push({ type: 'goto', url });
      const parsed = new URL(url, 'http://app.test/');
      if (parsed.pathname === '/login') this.state = 'login';
      else if (parsed.pathname === '/catalog') this.state = 'catalog';
      else if (parsed.pathname === '/contact') this.state = 'contact';
      else this.state = 'home';
      return { status: () => 200 };
    },
    async submitForm(form, profile) {
      calls.push({ type: 'submitForm', formId: form.id, profile });
      if (form.id === 'login') this.state = 'account';
      else if (form.id === 'search') this.state = 'searchResults';
      else if (form.id === 'contact' && profile.values && profile.values.email === 'bad') this.state = 'invalidContact';
      else if (form.id === 'contact') this.state = 'thanks';
    }
  };
}

test('scenario compiler validates ordered executable DAG steps', () => {
  const dag = compileScenario({
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'login', type: 'auth', success: { authState: 'authenticated' } },
      { id: 'search', type: 'search', success: { surfaceType: 'search-results' } }
    ]
  });

  assert.equal(dag.scenario.steps.length, 2);
  assert.deepEqual(dag.scenario.steps[1].dependsOn, ['login']);
});

test('scenario worker executes handlers and validates success conditions', async () => {
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'login', type: 'auth', success: { 'result.authState': 'authenticated' } },
      { id: 'search', type: 'search', success: { 'result.surfaceType': 'search-results' } }
    ]
  };

  const result = await runScenario({
    scenario,
    handlers: {
      auth: async () => ({ ok: true, authState: 'authenticated' }),
      search: async () => ({ ok: true, authState: 'authenticated', surfaceType: 'search-results' })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
});

test('scenario worker executes browser-backed auth, navigate, search, submit, and assert steps', async () => {
  const page = createScenarioMockPage();
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'login', type: 'auth', target: '/login', success: { 'result.authState': 'authenticated' } },
      { id: 'catalog', type: 'navigate', target: '/catalog', success: { completed: true } },
      { id: 'search', type: 'search', value: 'apple', success: { 'result.surfaceType': 'search-results' } },
      { id: 'contact', type: 'navigate', target: '/contact', success: { completed: true } },
      { id: 'submit-contact', type: 'submit-form', formId: 'contact', success: { completed: true } },
      { id: 'thanks', type: 'assert-state', value: 'Thanks', success: { completed: true } }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD',
      values: { name: 'PTK User', email: 'YOUR_USERNAME', message: 'hello' }
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] })
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 6);
  assert.equal(page.calls.filter(call => call.type === 'submitForm').length, 3);
  assert.equal(page.calls.find(call => call.formId === 'login').profile.password, 'YOUR_PASSWORD');
  assert.doesNotMatch(JSON.stringify(result), /YOUR_PASSWORD/);
  assert.match(JSON.stringify(result), /\[redacted\]/);
});

test('scenario auth form submit is not clipped by crawler action budget', async () => {
  const page = createScenarioMockPage();
  const originalSubmitForm = page.submitForm.bind(page);
  page.submitForm = async (form, profile) => {
    if (form.id === 'login') await new Promise(resolve => setTimeout(resolve, 80));
    return originalSubmitForm(form, profile);
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        timeoutMs: 500,
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 25, maxActionMs: 25, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] })
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.stepResults[0].result.form.budget.submit.budgetMs > 25, true);
  assert.match(result.stepResults[0].result.form.budget.submit.source, /scenario\.step\.timeoutMs/);
});

test('scenario auth submit without authenticated state does not pass', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  let authenticatedMarks = 0;
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    personaSession: {
      markAuthenticated: () => {
        authenticatedMarks += 1;
      }
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] })
  });

  assert.equal(result.ok, false);
  assert.equal(result.completed, 0);
  assert.equal(result.stepResults[0].result.authState, 'submitted');
  assert.equal(result.stepResults[0].result.form.submitted, true);
  assert.equal(authenticatedMarks, 0);
});

test('scenario auth classifies rejected target credentials from login response', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({
      events: [
        { type: 'request', method: 'POST', path: '/api/auth/login' },
        { type: 'response', method: 'POST', path: '/api/auth/login', status: 403 }
      ]
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.stepResults[0].result.authState, 'submitted');
  assert.equal(result.stepResults[0].result.authFailure.classification, 'target_rejected_credentials');
  assert.doesNotMatch(JSON.stringify(result), /YOUR_PASSWORD/);
});

test('scenario auth can use login plus authenticated user API evidence', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({
      events: [
        { type: 'response', method: 'POST', path: '/api/auth/login', status: 201 },
        { type: 'response', method: 'GET', path: '/api/users/one/YOUR_USERNAME', status: 200 }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.stepResults[0].result.authState, 'authenticated');
  assert.equal(result.stepResults[0].result.authEvidence.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /YOUR_PASSWORD/);
});

test('scenario auth can exercise same-origin post-auth probes', async () => {
  const page = createScenarioMockPage();
  const evaluatedProbes = [];
  page.evaluate = async (_fn, probes) => {
    evaluatedProbes.push(...probes);
    return probes.map(probe => ({
      url: probe.url,
      method: probe.method,
      status: 200,
      ok: true
    }));
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        postAuthProbes: [
          '/rest/user/whoami',
          { url: '/profile', method: 'GET' },
          { url: 'https://attacker.test/profile', method: 'GET' },
          { url: '/api/update', method: 'POST' }
        ],
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({
      events: [
        { type: 'response', method: 'POST', path: '/api/auth/login', status: 201 },
        { type: 'response', method: 'GET', path: '/api/users/one/YOUR_USERNAME', status: 200 }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepResults[0].result.authState, 'authenticated');
  const postAuthProbeCalls = evaluatedProbes.filter(probe => probe && probe.url);
  assert.deepEqual(postAuthProbeCalls.map(probe => new URL(probe.url).pathname), ['/rest/user/whoami', '/profile']);
  assert.equal(postAuthProbeCalls.every(probe => probe.credentials === 'include'), true);
  assert.deepEqual(result.stepResults[0].result.postAuthProbes.map(probe => probe.status), [200, 200]);
  assert.doesNotMatch(JSON.stringify(result), /YOUR_PASSWORD/);
});

test('scenario auth accepts login response followed by authenticated user requests', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({
      events: [
        { type: 'response', method: 'POST', path: '/api/auth/login', status: 201 },
        { type: 'request', method: 'GET', path: '/api/users/one/[redacted]' },
        { type: 'request', method: 'GET', path: '/api/users/ldap?query=(email%3D[redacted])' }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.stepResults[0].result.authState, 'authenticated');
  assert.equal(result.stepResults[0].result.authEvidence.loginResponse, true);
  assert.equal(result.stepResults[0].result.authEvidence.authenticatedRequest, true);
});

test('scenario auth merges submit and post-submit observations for fast login flows', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };
  let observations = 0;

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => {
      observations += 1;
      if (observations === 1) {
        return { events: [{ type: 'request', method: 'POST', path: '/api/auth/login' }] };
      }
      return {
        events: [
          { type: 'response', method: 'POST', path: '/api/auth/login', status: 201 },
          { type: 'request', method: 'GET', path: '/api/users/one/[redacted]' }
        ]
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.stepResults[0].result.authState, 'authenticated');
  assert.equal(result.stepResults[0].result.authEvidence.loginResponse, true);
  assert.equal(result.stepResults[0].result.authEvidence.authenticatedRequest, true);
});

test('scenario auth can use submitted authenticated API traffic without visible account text', async () => {
  const page = createScenarioMockPage();
  page.submitForm = async (form, profile) => {
    page.calls.push({ type: 'submitForm', formId: form.id, profile });
    if (form.id === 'login') page.state = 'loginSubmittedNoAuth';
  };
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      {
        id: 'login',
        type: 'auth',
        target: '/login',
        success: { 'result.authState': 'authenticated' }
      }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({
      events: [
        { type: 'response', method: 'GET', path: '/rest/user/whoami', status: 200 },
        { type: 'response', method: 'GET', path: '/rest/basket/6', status: 200 }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.stepResults[0].result.authState, 'authenticated');
  assert.equal(result.stepResults[0].result.authEvidence.authenticatedFetch, true);
});

test('scenario submit retry does not repeat an invalid form submission', async () => {
  const page = createScenarioMockPage('contact');
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'submit-contact', type: 'submit-form', formId: 'contact', retry: { maxAttempts: 2 }, success: { completed: true } }
    ]
  };

  const result = await runScenario({
    scenario,
    page,
    profile: { values: { name: 'PTK User', email: 'bad' } },
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] })
  });

  const submits = page.calls.filter(call => call.type === 'submitForm' && call.formId === 'contact');
  assert.equal(result.ok, false);
  assert.equal(submits.length, 1);
  assert.equal(result.stepResults[0].attempts.length, 2);
  assert.equal(result.stepResults[0].attempts[1].result.form.reason, 'previous_invalid_submit');
});
