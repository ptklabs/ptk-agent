'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createFormAttemptLedger,
  fillAndSubmitForm,
  navigationWaitMsForFormSubmit,
  planFormSubmission,
  runFormWorker,
  shouldWaitForFormNavigation
} = require('../../../src/crawl/formWorker.cjs');
const { normalizePageModel } = require('../../../src/browser/pageModel.cjs');
const fixtures = require('../../fixtures/browserSnapshots.cjs');

test('search form submissions run by default', async () => {
  const searchModel = normalizePageModel({
    url: 'http://app.test/catalog',
    title: 'Catalog',
    visibleText: 'Catalog Search',
    links: [],
    forms: [{
      id: 'search',
      kind: 'search',
      method: 'get',
      action: '/search',
      selector: '#search',
      fields: [{ name: 'q', type: 'search', required: true, selector: '[name="q"]' }]
    }],
    actions: []
  });
  const resultsModel = normalizePageModel({
    url: 'http://app.test/search?q=apple',
    title: 'Search results',
    visibleText: 'Search results for apple',
    surfaceType: 'search-results',
    links: [],
    forms: [],
    actions: []
  });
  const calls = [];
  const page = {
    async submitForm(form, profile) {
      calls.push({ formId: form.id, profile });
    }
  };

  const result = await runFormWorker({
    page,
    form: searchModel.forms[0],
    profile: { values: { query: 'apple' } },
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [{ type: 'request', method: 'GET', url: 'http://app.test/search?q=apple' }] }),
    modelExtractor: async (_page, options) => options && options.baseUrl ? resultsModel : searchModel
  });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(calls.length, 1);
  assert.equal(result.plan.fields[0].value, 'apple');
});

test('login form is skipped by default', async () => {
  const loginModel = normalizePageModel(fixtures.loginPage);
  let submitted = false;

  const result = await runFormWorker({
    page: {
      async submitForm() {
        submitted = true;
      }
    },
    form: loginModel.forms[0],
    profile: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.submitted, false);
  assert.equal(submitted, false);
  assert.match(result.reason, /disabled/);
});

test('form worker observes fast submit network events from before the click', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/login',
    title: 'Login',
    visibleText: 'Login',
    links: [],
    forms: [{
      id: 'login',
      kind: 'login',
      method: 'post',
      action: '/login',
      selector: '#login',
      fields: [
        { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
        { name: 'password', type: 'password', required: true, selector: '[name="password"]' }
      ]
    }],
    actions: []
  });
  const after = normalizePageModel({
    url: 'http://app.test/account',
    title: 'Account',
    visibleText: 'Account profile',
    links: [],
    forms: [],
    actions: []
  });
  const page = new EventEmitter();
  page.submitForm = async () => {
    const request = {
      method: () => 'POST',
      url: () => 'http://app.test/login',
      resourceType: () => 'fetch',
      headers: () => ({}),
      postData: () => null
    };
    const response = {
      request: () => request,
      url: () => 'http://app.test/login',
      status: () => 200
    };
    page.emit('request', request);
    page.emit('response', response);
  };

  const result = await runFormWorker({
    page,
    form: before.forms[0],
    profile: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    allowSubmit: true,
    modelExtractor: async (_page, options) => options && options.baseUrl ? after : before
  });

  assert.equal(result.submitted, true);
  assert.equal(result.observation.events.some(event => event.type === 'request' && event.method === 'POST'), true);
  assert.equal(result.observation.events.some(event => event.type === 'response' && event.status === 200), true);
});

test('login form runs when auth intent and profile config allow it', async () => {
  const loginModel = normalizePageModel(fixtures.loginPage);
  const accountModel = normalizePageModel({
    url: 'http://app.test/profile',
    title: 'Profile',
    visibleText: 'Profile My account Logout',
    links: [{ href: '/logout', text: 'Logout' }],
    forms: [],
    actions: []
  });
  const calls = [];
  const page = {
    async submitForm(form, profile) {
      calls.push({ formId: form.id, profile });
    }
  };

  const result = await runFormWorker({
    page,
    form: loginModel.forms[0],
    profile: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
    authIntent: { kind: 'auth.login' },
    config: {
      auth: { intent: 'login', allowLogin: true },
      crawler: { maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [{ type: 'request', method: 'POST', url: 'http://app.test/login', status: 302 }] }),
    modelExtractor: async (_page, options) => options && options.baseUrl ? accountModel : loginModel
  });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.password, 'YOUR_PASSWORD');
  assert.doesNotMatch(JSON.stringify(result.plan), /YOUR_PASSWORD/);
});

test('form worker uses profile credentials while redacting sensitive plan values', async () => {
  const loginModel = normalizePageModel(fixtures.loginPage);
  const accountModel = normalizePageModel({
    url: 'http://app.test/profile',
    title: 'Profile',
    visibleText: 'Profile My account Logout',
    links: [{ href: '/logout', text: 'Logout' }],
    forms: [],
    actions: []
  });
  const calls = [];
  const page = {
    async submitForm(form, profile) {
      calls.push({ formId: form.id, profile });
    }
  };

  const result = await runFormWorker({
    page,
    form: loginModel.forms[0],
    profile: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
    allowSubmit: true,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [{ type: 'request', method: 'POST', url: 'http://app.test/login', status: 302 }] }),
    modelExtractor: async (_page, options) => options && options.baseUrl ? accountModel : loginModel
  });

  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.password, 'YOUR_PASSWORD');
  const passwordField = result.plan.fields.find(field => field.kind === 'password');
  assert.equal(passwordField.value, '[redacted]');
  assert.doesNotMatch(JSON.stringify(result.plan), /YOUR_PASSWORD/);
});

test('form submit treats navigation context destruction as submitted when the URL changes', async () => {
  const before = normalizePageModel({
    url: 'http://app.test/login',
    title: 'Login',
    visibleText: 'Login',
    links: [],
    forms: [{
      id: 'login',
      kind: 'login',
      method: 'post',
      action: '/login',
      fields: [
        { name: 'email', type: 'email', required: true },
        { name: 'password', type: 'password', required: true }
      ]
    }],
    actions: []
  });
  const after = normalizePageModel({
    url: 'http://app.test/account',
    title: 'Account',
    visibleText: 'Account Logout',
    links: [],
    forms: [],
    actions: []
  });
  let currentUrl = before.url;
  const page = {
    url: () => currentUrl,
    async evaluate() {
      currentUrl = after.url;
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    },
    async waitForLoadState() {}
  };

  const result = await runFormWorker({
    page,
    form: before.forms[0],
    profile: { email: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' },
    authIntent: { kind: 'auth.login' },
    config: {
      auth: { intent: 'login', allowLogin: true },
      crawler: { maxActionMs: 50, maxObservationMs: 1 }
    },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => currentUrl === after.url ? after : before
  });

  assert.equal(result.submitted, true);
  assert.equal(result.after.url, after.url);
});

test('locator submit navigation race does not fall through to stale DOM fallback', async () => {
  let currentUrl = 'http://app.test/login';
  let evaluateCalled = false;
  const filled = {};
  const form = {
    id: 'login',
    selector: '#login',
    kind: 'login',
    method: 'POST',
    action: '/doLogin',
    submitSelector: 'input[name="btnSubmit"]',
    fields: [
      { id: 'uid', name: 'uid', selector: '#uid', type: 'text' },
      { id: 'passw', name: 'passw', selector: '#passw', type: 'password' }
    ]
  };
  const makeLocator = selector => ({
    first() {
      return makeLocator(selector);
    },
    locator(childSelector) {
      return makeLocator(`${selector} ${childSelector}`);
    },
    async evaluate() {
      return 'input';
    },
    async fill(value) {
      filled[selector] = value;
    },
    async click() {
      if (/btnSubmit/.test(selector)) {
        currentUrl = 'http://app.test/bank/main.jsp';
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
    },
    async press() {
      throw new Error('press should not be needed');
    }
  });
  const page = {
    url: () => currentUrl,
    locator: selector => makeLocator(selector),
    async waitForLoadState() {},
    async evaluate() {
      evaluateCalled = true;
      throw new Error('DOM fallback should not run after submit navigation');
    }
  };

  await fillAndSubmitForm(page, form, {
    username: 'jsmith',
    password: 'Demo1234',
    credentials: { username: 'jsmith', password: 'Demo1234' }
  });

  assert.equal(evaluateCalled, false);
  assert.equal(currentUrl, 'http://app.test/bank/main.jsp');
  assert.equal(filled['#uid'], 'jsmith');
  assert.equal(filled['#passw'], 'Demo1234');
});

test('form worker skips a repeated submit after validation feedback for same planned values', async () => {
  const before = normalizePageModel(fixtures.formPage);
  const afterInvalid = {
    ...before,
    validationFeedback: {
      messages: ['Email is invalid'],
      invalidFields: [{ field: 'email', message: 'Email is invalid' }]
    }
  };
  const ledger = createFormAttemptLedger();
  let submitCount = 0;
  const page = {
    async submitForm() {
      submitCount += 1;
    }
  };
  const input = {
    page,
    form: before.forms[0],
    profile: { values: { email: 'bad', name: 'PTK User' } },
    allowSubmit: true,
    submissionLedger: ledger,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async (_page, options) => options && options.baseUrl ? afterInvalid : before
  };

  const first = await runFormWorker(input);
  const second = await runFormWorker(input);

  assert.equal(first.submitted, true);
  assert.equal(first.ok, false);
  assert.equal(first.validationFeedback.hasValidation, true);
  assert.equal(second.submitted, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'previous_invalid_submit');
  assert.equal(submitCount, 1);
});

test('form plan resolves search aliases from profile values', () => {
  const form = {
    id: 'search',
    fields: [{ name: 'q', type: 'search', required: true, selector: '[name="q"]' }]
  };
  const plan = planFormSubmission(form, { values: { query: 'apple' } });
  assert.equal(plan.canSubmit, true);
  assert.equal(plan.fields[0].value, 'apple');
});

test('form plan maps TestFire uid/passw fields to profile credentials', () => {
  const form = {
    id: 'login',
    fields: [
      { name: 'uid', type: 'text', selector: '#uid' },
      { name: 'passw', type: 'password', selector: '#passw' }
    ]
  };
  const plan = planFormSubmission(form, { username: 'admin', password: 'admin' });
  assert.equal(plan.canSubmit, true);
  assert.equal(plan.fields[0].kind, 'username');
  assert.equal(plan.fields[0].value, 'admin');
  assert.equal(plan.fields[1].kind, 'password');
  assert.equal(plan.fields[1].value, '[redacted]');
});

test('form plan maps transfer, contact, and feedback fields to meaningful profile values', () => {
  const transfer = {
    id: 'transfer',
    fields: [
      { name: 'fromAccount', selector: '#from' },
      { name: 'toAccount', selector: '#to' },
      { name: 'amount', type: 'number', selector: '#amount' }
    ]
  };
  const feedback = {
    id: 'feedback',
    fields: [
      { name: 'email', selector: '#email' },
      { name: 'subject', selector: '#subject' },
      { name: 'comment', selector: '#comment' }
    ]
  };
  const profile = {
    username: 'buyer@example.test',
    values: {
      subject: 'Security feedback',
      message: 'This is a bounded PTK feedback submission.'
    },
    transfer: {
      fromAccount: '1001',
      toAccount: '1002',
      amount: '9.99'
    }
  };

  const transferPlan = planFormSubmission(transfer, profile);
  const feedbackPlan = planFormSubmission(feedback, profile);

  assert.deepEqual(transferPlan.fields.map(field => field.value), ['1001', '1002', '9.99']);
  assert.equal(feedbackPlan.fields.find(field => field.kind === 'email').value, 'buyer@example.test');
  assert.equal(feedbackPlan.fields.find(field => field.kind === 'subject').value, 'Security feedback');
  assert.equal(feedbackPlan.fields.find(field => field.kind === 'message').value, 'This is a bounded PTK feedback submission.');
});

test('form worker resolves file upload fixtures and keeps artifact plan redacted', async () => {
  const form = {
    id: 'upload',
    kind: 'file-upload',
    fields: [
      { name: 'attachment', type: 'file', selector: '#attachment' },
      { name: 'description', selector: '#description' }
    ]
  };
  const model = normalizePageModel({
    url: 'http://app.test/upload',
    title: 'Upload',
    visibleText: 'Upload complete',
    links: [],
    forms: [form],
    actions: []
  });
  const setInputFiles = [];
  const page = {
    async setInputFiles(selector, filePath) {
      setInputFiles.push({ selector, filePath });
    },
    async evaluate() {}
  };

  const result = await runFormWorker({
    page,
    form: model.forms[0],
    profile: {
      uploadFixtures: [{ id: 'attachment', path: '/tmp/fixture.txt' }],
      values: { description: 'Fixture upload' }
    },
    allowSubmit: true,
    config: { crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [] }),
    modelExtractor: async () => model
  });

  assert.equal(result.submitted, true);
  assert.equal(setInputFiles[0].selector, '#attachment');
  assert.equal(setInputFiles[0].filePath, '/tmp/fixture.txt');
  assert.equal(result.plan.fields[0].value, '[file-fixture]');
  assert.doesNotMatch(JSON.stringify(result.plan), /fixture\.txt/);
});

test('form submit fills bounded arithmetic captcha fields from visible page text', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`
    <main>
      <form id="feedback">
        <label for="comment">Comment</label>
        <textarea id="comment"></textarea>
        <div id="captcha">CAPTCHA 7 + 5</div>
        <label for="captchaControl">Result</label>
        <input id="captchaControl" placeholder="Please enter the result of the CAPTCHA.">
        <button id="submitButton" type="button">Submit</button>
      </form>
    </main>
  `);
  const previous = {
    window: global.window,
    document: global.document,
    Event: global.Event,
    CSS: global.CSS
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.Event = dom.window.Event;
  global.CSS = dom.window.CSS;
  let clicked = false;
  dom.window.document.getElementById('submitButton').addEventListener('click', () => {
    clicked = true;
  });
  dom.window.document.getElementById('feedback').requestSubmit = () => {
    clicked = true;
  };
  const page = {
    async evaluate(callback, args) {
      return callback(args);
    }
  };
  try {
    await fillAndSubmitForm(page, {
      id: 'feedback',
      selector: '#feedback',
      submitSelector: '#submitButton',
      fields: [
        { id: 'comment', selector: '#comment', type: 'textarea' },
        { id: 'captchaControl', selector: '#captchaControl', type: 'text', label: 'Result', placeholder: 'Please enter the result of the CAPTCHA.' }
      ]
    }, { values: { message: 'hello' } });
    assert.equal(dom.window.document.getElementById('captchaControl').value, '12');
    assert.equal(clicked, true);
  } finally {
    global.window = previous.window;
    global.document = previous.document;
    global.Event = previous.Event;
    global.CSS = previous.CSS;
  }
});

test('feedback form submit uses DOM path instead of slow locator retries', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`
    <main>
      <form id="feedback">
        <textarea id="comment"></textarea>
        <div id="captcha">CAPTCHA 4 + 6</div>
        <input id="captchaControl" placeholder="captcha result">
        <button id="submitButton" type="button">Submit</button>
      </form>
    </main>
  `);
  const previous = {
    window: global.window,
    document: global.document,
    Event: global.Event,
    CSS: global.CSS
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.Event = dom.window.Event;
  global.CSS = dom.window.CSS;
  let clicked = false;
  dom.window.document.getElementById('submitButton').addEventListener('click', () => {
    clicked = true;
  });
  const page = {
    locator() {
      throw new Error('locator path should be skipped for feedback forms');
    },
    async evaluate(callback, args) {
      return callback(args);
    }
  };
  try {
    await fillAndSubmitForm(page, {
      id: 'synthetic-feedback',
      kind: 'feedback',
      selector: '#feedback',
      submitSelector: '#submitButton',
      synthetic: true,
      fields: [
        { id: 'comment', selector: '#comment', type: 'textarea' },
        { id: 'captchaControl', selector: '#captchaControl', type: 'text', label: 'Result', placeholder: 'captcha result' }
      ]
    }, { values: { message: 'hello' } });
    assert.equal(dom.window.document.getElementById('captchaControl').value, '10');
    assert.equal(clicked, true);
  } finally {
    global.window = previous.window;
    global.document = previous.document;
    global.Event = previous.Event;
    global.CSS = previous.CSS;
  }
});

test('form submit uses trusted locator click even when non-critical select fill is imperfect', async () => {
  const calls = [];
  const makeLocator = selector => ({
    first() {
      return this;
    },
    locator(childSelector) {
      return makeLocator(`${selector} ${childSelector}`);
    },
    async evaluate(callback, arg) {
      if (selector === '#op') {
        if (arg !== undefined) return false;
        return 'select';
      }
      return 'input';
    },
    async selectOption() {
      throw new Error('select option unavailable');
    },
    async fill(value) {
      if (selector === '#op') throw new Error('cannot fill select');
      calls.push({ type: 'fill', selector, value });
    },
    async click() {
      calls.push({ type: 'click', selector });
    }
  });
  const page = {
    locator: makeLocator,
    async evaluate() {
      throw new Error('DOM fallback should not run');
    }
  };

  await fillAndSubmitForm(page, {
    id: 'login',
    selector: '#login',
    fields: [
      { id: 'op', selector: '#op', type: 'select-one' },
      { id: 'user', selector: '#user', type: 'email', label: 'Email' },
      { id: 'password', selector: '#password', type: 'password', label: 'Password' }
    ]
  }, { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' });

  assert.deepEqual(calls.filter(call => call.type === 'fill').map(call => call.selector), ['#user', '#password']);
  assert.equal(calls.some(call => call.type === 'click'), true);
});

test('form submit falls back to Enter on a filled field when submit controls are unavailable', async () => {
  const calls = [];
  const makeLocator = selector => ({
    first() {
      return this;
    },
    locator(childSelector) {
      return makeLocator(`${selector} ${childSelector}`);
    },
    async evaluate() {
      return 'input';
    },
    async fill(value) {
      calls.push({ type: 'fill', selector, value });
    },
    async click() {
      throw new Error('submit control unavailable');
    },
    async press(key) {
      calls.push({ type: 'press', selector, key });
    }
  });
  const page = {
    locator: makeLocator,
    async evaluate() {
      throw new Error('DOM fallback should not run');
    }
  };

  await fillAndSubmitForm(page, {
    id: 'login',
    selector: '#login',
    fields: [
      { id: 'user', selector: '#user', type: 'email', label: 'Email' },
      { id: 'password', selector: '#password', type: 'password', label: 'Password' }
    ]
  }, { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' });

  assert.deepEqual(calls.filter(call => call.type === 'fill').map(call => call.selector), ['#user', '#password']);
  assert.deepEqual(calls.find(call => call.type === 'press'), { type: 'press', selector: '#password', key: 'Enter' });
});

test('select fallback chooses a different destination account for transfer-style fields', async () => {
  const selected = {};
  const makeLocator = selector => ({
    first() {
      return this;
    },
    locator(childSelector) {
      return makeLocator(`${selector} ${childSelector}`);
    },
    async evaluate(callback, arg) {
      if (arg === undefined) return 'select';
      const element = {
        name: selector === '#to' ? 'toAccount' : 'fromAccount',
        id: selector.slice(1),
        options: [
          { value: '800001', textContent: '800001', disabled: false },
          { value: '800002', textContent: '800002', disabled: false }
        ],
        getAttribute() {
          return '';
        },
        dispatchEvent() {}
      };
      const ok = callback(element, arg);
      selected[selector] = element.value;
      return ok;
    },
    async selectOption() {
      throw new Error('force evaluate fallback');
    },
    async click() {}
  });
  const page = {
    locator: makeLocator,
    async evaluate() {
      throw new Error('DOM fallback should not run');
    }
  };

  await fillAndSubmitForm(page, {
    id: 'transfer',
    selector: '#transfer',
    fields: [
      { id: 'from', name: 'fromAccount', selector: '#from', type: 'select' },
      { id: 'to', name: 'toAccount', selector: '#to', type: 'select' }
    ]
  }, {
    values: {
      fromAccount: 'first-available',
      toAccount: 'different-available'
    }
  });

  assert.equal(selected['#from'], '800001');
  assert.equal(selected['#to'], '800002');
});

test('post style forms wait for bounded navigation after submit', async () => {
  assert.equal(shouldWaitForFormNavigation({ kind: 'transfer', method: 'POST', action: '/submit' }), true);
  assert.equal(shouldWaitForFormNavigation({ kind: 'search', method: 'GET', action: '/search' }), false);
  assert.equal(navigationWaitMsForFormSubmit(8000), 1500);
  assert.equal(navigationWaitMsForFormSubmit(100), 250);
});
