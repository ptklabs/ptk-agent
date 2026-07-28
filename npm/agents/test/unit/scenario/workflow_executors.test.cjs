'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runScenario } = require('../../../src/scenario/scenarioWorker.cjs');
const { addToCart, feedbackSubmissionObserved, openSurface, search, submitFeedback, transferFunds } = require('../../../src/scenario/workflowExecutors.cjs');

function createWorkflowPage(initialState = 'catalog') {
  const calls = [];
  const states = {
    catalog: () => ({
      url: 'http://app.test/#/search?q=apple',
      title: 'Catalog',
      visibleText: `Catalog Apple Juice Your Basket ${calls.filter(call => call[0] === 'click' && /add/i.test(call[1].name || '')).length}`,
      links: [],
      forms: [],
      actions: [
        {
          id: 'add-apple',
          kind: 'click-button',
          label: 'Add to Basket',
          role: 'button',
          locatorPlan: { strategy: 'role', role: 'button', name: 'Add to Basket', critical: true }
        }
      ]
    }),
    transfer: () => ({
      url: 'http://app.test/bank/transfer.jsp',
      title: 'Transfer',
      visibleText: 'Transfer Funds From Account To Account Amount',
      links: [],
      actions: [],
      forms: [{
        id: 'transfer',
        kind: 'generic',
        selector: '#transfer',
        action: '/bank/doTransfer',
        method: 'post',
        fields: [
          { name: 'fromAccount', type: 'select', label: 'From Account', selector: '[name="fromAccount"]' },
          { name: 'toAccount', type: 'select', label: 'To Account', selector: '[name="toAccount"]' },
          { name: 'amount', type: 'text', label: 'Amount', selector: '[name="amount"]' }
        ]
      }]
    }),
    transferDone: () => ({
      url: 'http://app.test/bank/transfer.jsp',
      title: 'Transfer Complete',
      visibleText: 'Transfer was successfully transferred',
      links: [],
      forms: [],
      actions: []
    }),
    basket: () => ({
      url: 'http://app.test/#/basket',
      title: 'Basket',
      visibleText: 'Your Basket 2 Checkout',
      links: [],
      forms: [],
      actions: []
    })
  };
  return {
    calls,
    state: initialState,
    async snapshot() {
      return states[this.state]();
    },
    async goto(url, options = {}) {
      calls.push(['goto', url, options]);
      if (String(url).includes('transfer')) this.state = 'transfer';
      else if (String(url).includes('basket')) this.state = 'basket';
      return { status: () => 200 };
    },
    async clickLocator(plan) {
      calls.push(['click', plan]);
    },
    async search(term) {
      calls.push(['search', term]);
    },
    async submitForm(form, profile) {
      calls.push(['submitForm', form.id, profile.values]);
      if (form.id === 'transfer') this.state = 'transferDone';
    }
  };
}

test('add-to-cart workflow is action/API based, not submit-form', async () => {
  const page = createWorkflowPage('catalog');
  const result = await addToCart(
    { id: 'add-two', type: 'add-to-cart', count: 2, success: { cartCountAtLeast: 2 } },
    { page, config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxActionMs: 50, maxObservationMs: 1 } }, observe: async () => ({ events: [] }) }
  );

  assert.equal(result.ok, true);
  assert.equal(page.calls.filter(call => call[0] === 'click').length, 2);
  assert.equal(page.calls.some(call => call[0] === 'submitForm'), false);
});

test('add-to-cart workflow honors scenario quantity values', async () => {
  const page = createWorkflowPage('catalog');
  const result = await addToCart(
    { id: 'add-two', type: 'add-to-cart', value: { quantity: 2 }, success: { cartCountAtLeast: 2 } },
    { page, config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxActionMs: 50, maxObservationMs: 1 } }, observe: async () => ({ events: [] }) }
  );

  assert.equal(result.ok, true);
  assert.equal(page.calls.filter(call => call[0] === 'click').length, 2);
});

test('add-to-cart workflow retries after transient click interception', async () => {
  const page = createWorkflowPage('catalog');
  let clickAttempts = 0;
  page.clickLocator = async (plan, options) => {
    clickAttempts += 1;
    page.calls.push(['click', plan, options]);
    if (clickAttempts === 1) throw new Error('element intercepted by transient overlay');
  };
  page.dismissCommonOverlays = async () => {
    page.calls.push(['dismissCommonOverlays']);
    return { attempted: true, dismissed: 1 };
  };

  const result = await addToCart(
    { id: 'add-one', type: 'add-to-cart', count: 1, timeoutMs: 5000 },
    { page, config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxActionMs: 5000, maxObservationMs: 1 } }, observe: async () => ({ events: [] }) }
  );

  assert.equal(result.ok, true);
  assert.equal(clickAttempts, 2);
  assert.equal(page.calls.some(call => call[0] === 'dismissCommonOverlays'), true);
  assert.equal(page.calls.every(call => call[0] !== 'click' || call[2].timeout <= 1800), true);
});

test('transfer-funds workflow submits the transfer form after opening the surface', async () => {
  const page = createWorkflowPage('catalog');
  const result = await transferFunds(
    {
      id: 'transfer',
      type: 'transfer-funds',
      value: {
        amountClass: 'small',
        fromAccount: 'first-available',
        toAccount: 'different-available'
      },
      success: { confirmationVisible: true }
    },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async fakePage => fakePage.snapshot()
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.confirmationVisible, true);
  assert.equal(page.calls.some(call => call[0] === 'goto' && String(call[1]).includes('/bank/transfer.jsp')), true);
  assert.equal(page.calls.some(call => call[0] === 'submitForm' && call[1] === 'transfer'), true);
  const submit = page.calls.find(call => call[0] === 'submitForm' && call[1] === 'transfer');
  assert.equal(submit[2].fromAccount, 'first-available');
  assert.equal(submit[2].toAccount, 'different-available');
  assert.equal(submit[2].amount, '1.00');
});

test('transfer-funds workflow retries a no-progress POST with a DOM submit fallback', async () => {
  const page = createWorkflowPage('catalog');
  page.submitForm = async (form, profile) => {
    page.calls.push(['submitForm', form.id, profile.values]);
  };
  page.evaluate = async () => {
    page.calls.push(['domSubmitFallback']);
    page.state = 'transferDone';
    return { submitted: true };
  };
  page.waitForNavigation = async () => ({ navigated: true });

  const result = await transferFunds(
    {
      id: 'transfer',
      type: 'transfer-funds',
      value: {
        amountClass: 'small',
        fromAccount: 'first-available',
        toAccount: 'different-available'
      },
      success: { confirmationVisible: true }
    },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async fakePage => fakePage.snapshot()
    }
  );

  assert.equal(result.confirmationVisible, true);
  assert.equal(result.form.fallback, 'dom-submit-after-no-progress');
  assert.equal(page.calls.some(call => call[0] === 'domSubmitFallback'), true);
});

test('open-surface can navigate to basket routes', async () => {
  const page = createWorkflowPage('catalog');
  const result = await openSurface(
    { id: 'basket', type: 'open-surface', surface: 'basket', success: { surfaceType: 'cart' } },
    { page, config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxObservationMs: 1 } }, observe: async () => ({ events: [] }) }
  );

  assert.equal(result.url, 'http://app.test/#/basket');
  assert.equal(page.calls.some(call => call[0] === 'goto' && String(call[1]).includes('/#/basket')), true);
});

test('feedback workflow accepts endpoint-backed submit confirmation', () => {
  assert.equal(feedbackSubmissionObserved({
    events: [
      { type: 'request', method: 'POST', path: '/api/Feedbacks/', resourceType: 'fetch' },
      { type: 'response', method: 'POST', path: '/api/Feedbacks/', status: 201, resourceType: 'fetch' }
    ]
  }), true);
  assert.equal(feedbackSubmissionObserved({
    events: [
      { type: 'request', method: 'POST', path: '/api/Feedbacks/', resourceType: 'fetch' }
    ]
  }), true);
  assert.equal(feedbackSubmissionObserved({
    events: [
      { type: 'request', method: 'POST', path: '/api/Feedbacks/', resourceType: 'fetch' },
      { type: 'response', method: 'POST', path: '/api/Feedbacks/', status: 400, resourceType: 'fetch' }
    ]
  }), false);
  assert.equal(feedbackSubmissionObserved({
    events: [
      { type: 'request', method: 'GET', path: '/api/Feedbacks/', resourceType: 'fetch' },
      { type: 'response', method: 'GET', path: '/api/Feedbacks/', status: 200, resourceType: 'fetch' }
    ]
  }), false);
});

test('feedback workflow ignores unrelated page errors after confirmed submit', async () => {
  const page = {
    async goto() {},
    async evaluate() {
      return {
        submitted: true,
        captchaAnswer: '7',
        captchaDebug: { expression: '3+4' },
        disabledBeforeClick: false
      };
    }
  };
  const feedbackModel = {
    url: 'http://app.test/#/contact',
    title: 'Customer Feedback',
    visibleText: 'Customer Feedback CAPTCHA Comment You can order only up to 5 items of this product.',
    visibleTextSummary: 'Customer Feedback CAPTCHA Comment You can order only up to 5 items of this product.',
    links: [],
    forms: [{
      id: 'synthetic-feedback',
      kind: 'feedback',
      synthetic: true,
      fields: [{ id: 'comment', label: 'Comment' }, { id: 'captchaControl', label: 'Result' }]
    }],
    actions: []
  };

  const result = await submitFeedback(
    { id: 'submit-feedback', type: 'submit-feedback', timeoutMs: 100 },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({
        events: [
          { type: 'response', method: 'PUT', path: '/api/BasketItems/11', status: 400 },
          { type: 'console', text: 'unrelated page error' },
          { type: 'request', method: 'POST', path: '/api/Feedbacks/' },
          { type: 'response', method: 'POST', path: '/api/Feedbacks/', status: 201 }
        ]
      }),
      modelExtractor: async () => feedbackModel
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.confirmationVisible, true);
});

test('feedback workflow does not fall through to generic submit when captcha solver is not ready', async () => {
  const calls = [];
  const page = {
    async goto(url) {
      calls.push(['goto', url]);
    },
    async evaluate() {
      calls.push(['evaluate']);
      return {
        submitted: false,
        reason: 'captcha_expression_not_ready',
        captchaAnswer: '0',
        captchaDebug: { expression: null }
      };
    },
    async submitForm() {
      calls.push(['submitForm']);
    }
  };
  const feedbackModel = {
    url: 'http://app.test/#/contact',
    title: 'Customer Feedback',
    visibleText: 'Customer Feedback CAPTCHA Comment',
    visibleTextSummary: 'Customer Feedback CAPTCHA Comment',
    links: [],
    forms: [{
      id: 'synthetic-feedback',
      kind: 'feedback',
      synthetic: true,
      fields: [{ id: 'comment', label: 'Comment' }, { id: 'captchaControl', label: 'Result' }]
    }],
    actions: []
  };

  const result = await submitFeedback(
    { id: 'submit-feedback', type: 'submit-feedback', timeoutMs: 100 },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async () => feedbackModel
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'captcha_expression_not_ready');
  assert.equal(calls.some(call => call[0] === 'submitForm'), false);
});

test('workflow search uses profile values and search terms', async () => {
  const page = createWorkflowPage('catalog');
  const result = await search(
    { id: 'search', type: 'search' },
    {
      page,
      profile: { values: { search: 'banana smoothie' }, searchTerms: ['fallback term'] },
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] })
    }
  );

  assert.equal(result.searchTerm, 'banana smoothie');
  assert.equal(page.calls.some(call => call[0] === 'goto' && String(call[1]).includes('banana%20smoothie')), true);
});

test('workflow search does not accept URL query alone as result evidence and falls back to visible search input', async () => {
  const page = createWorkflowPage('catalog');
  let filled = false;
  page.snapshot = async () => ({
    url: 'http://app.test/#/search?q=apple',
    title: 'Catalog',
    visibleText: filled ? 'Search Results - apple Apple Juice Add to Basket' : 'Catalog results loading',
    visibleTextSummary: filled ? 'Search Results - apple Apple Juice Add to Basket' : 'Catalog results loading',
    links: [],
    forms: [],
    actions: [{
      id: 'search-input',
      kind: 'type-search',
      label: 'Search',
      locatorPlan: { strategy: 'role', role: 'textbox', name: 'Search' }
    }]
  });
  page.fillLocator = async (plan, value) => {
    page.calls.push(['fill', plan, value]);
    filled = true;
  };

  const result = await search(
    { id: 'search', type: 'search', value: 'apple', target: { route: '/#/search' } },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async fakePage => fakePage.snapshot()
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.searchTerm, 'apple');
  assert.equal(page.calls.some(call => call[0] === 'fill' && call[2] === 'apple'), true);
});

test('workflow search waits for direct route product evidence', async () => {
  const page = createWorkflowPage('catalog');
  let snapshots = 0;
  page.snapshot = async () => {
    snapshots += 1;
    if (snapshots < 2) {
      return {
        url: 'http://app.test/#/search?q=apple',
        title: 'Catalog',
        visibleText: 'Catalog results loading',
        visibleTextSummary: 'Catalog results loading',
        links: [],
        forms: [],
        actions: []
      };
    }
    return {
      url: 'http://app.test/#/search?q=apple',
      title: 'Catalog',
      visibleText: 'Search Results - apple Apple Juice Add to Basket',
      visibleTextSummary: 'Search Results - apple Apple Juice Add to Basket',
      links: [],
      forms: [],
      actions: [{
        id: 'add-apple',
        kind: 'click-button',
        label: 'Add to Basket',
        role: 'button',
        locatorPlan: { strategy: 'role', role: 'button', name: 'Add to Basket', critical: true }
      }]
    };
  };

  const result = await search(
    { id: 'search', type: 'search', value: 'apple', target: { route: '/#/search' }, timeoutMs: 1000 },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 50, maxActionMs: 50, maxObservationMs: 1 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async fakePage => fakePage.snapshot()
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.transition.signals.includes('product-action-visible'), true);
});

test('workflow search preserves evidence wait budget during direct route navigation', async () => {
  const page = createWorkflowPage('catalog');
  page.snapshot = async () => ({
    url: 'http://app.test/#/search?q=apple',
    title: 'Catalog',
    visibleText: 'Catalog results loading',
    visibleTextSummary: 'Catalog results loading',
    links: [],
    forms: [],
    actions: []
  });

  const result = await search(
    { id: 'search', type: 'search', value: 'apple', target: { route: '/#/search' }, timeoutMs: 5000 },
    {
      page,
      config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxRouteMs: 5000, maxActionMs: 2000, maxObservationMs: 800 } },
      observe: async () => ({ events: [] }),
      modelExtractor: async fakePage => fakePage.snapshot(),
      _operationDeadline: {
        remainingMs: () => 300,
        operation: 'scenario-step'
      }
    }
  );

  const gotoCall = page.calls.find(call => call[0] === 'goto');
  assert.equal(result.ok, false);
  assert.equal(gotoCall[2].timeout < 5000, true);
  assert.equal(gotoCall[2].timeout > 0, true);
});

test('scenario search uses active persona search terms when step has no value', async () => {
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'search', type: 'search' }
    ]
  };
  const page = createWorkflowPage('catalog');
  const result = await runScenario({
    scenario,
    page,
    profile: { searchTerms: ['profile supplied term'] },
    config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [] })
  });

  assert.equal(result.ok, true);
  assert.equal(result.stepResults[0].result.searchTerm, 'profile supplied term');
  assert.equal(page.calls.some(call => call[0] === 'goto' && String(call[1]).includes('profile%20supplied%20term')), true);
});

test('scenario step success requires the expected state transition result', async () => {
  const scenario = {
    version: 'ptk-scenario-v2',
    steps: [
      { id: 'add', type: 'add-to-cart', count: 1, success: { cartCountAtLeast: 2 } }
    ]
  };
  const page = createWorkflowPage('catalog');
  const result = await runScenario({
    scenario,
    page,
    config: { target: { baseUrl: 'http://app.test/' }, crawler: { maxActionMs: 50, maxObservationMs: 1 } },
    observe: async () => ({ events: [] })
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStepId, 'add');
  assert.equal(result.stepResults[0].success.ok, false);
});
