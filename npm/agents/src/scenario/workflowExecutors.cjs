'use strict';

const { createEventCollector, observePage } = require('../browser/eventCollector.cjs');
const { extractPageModel, normalizeUrl } = require('../browser/pageModel.cjs');
const { validateTransition } = require('../browser/transition.cjs');
const { gotoRoute } = require('../crawl/routeWorker.cjs');
const {
  hasValidationFeedback,
  navigationWaitMsForFormSubmit,
  runFormWorker,
  valueForField
} = require('../crawl/formWorker.cjs');
const { clickLocator, fillLocator, locatorPlanFromControl } = require('../browser/locatorResolver.cjs');
const { budgetedScenarioConfig } = require('../core/budgets.cjs');
const { dismissCommonOverlays } = require('../browser/recovery.cjs');

const SURFACE_ROUTES = Object.freeze({
  login: ['/#/login', '/login', '/login.jsp'],
  basket: ['/#/basket', '/basket', '/cart'],
  cart: ['/#/basket', '/basket', '/cart'],
  checkout: ['/#/checkout', '/checkout'],
  feedback: ['/#/contact', '/#/complain', '/contact', '/complain', '/feedback.jsp', '/index.jsp?content=inside_contact.htm'],
  contact: ['/#/contact', '/#/complain', '/contact', '/complain', '/feedback.jsp', '/index.jsp?content=inside_contact.htm'],
  profile: ['/profile', '/account', '/bank/main.jsp'],
  settings: ['/profile', '/settings'],
  'account-summary': ['/bank/main.jsp', '/account', '/profile'],
  transactions: ['/bank/transaction.jsp', '/transactions'],
  transfer: ['/bank/transfer.jsp', '/transfer'],
  search: ['/#/search', '/search', '/search.jsp']
});

function resolveCrawlerConfig(context = {}, step = {}) {
  const config = context.config || {};
  return budgetedScenarioConfig(config, step, {
    scope: 'workflow',
    parentDeadline: context._operationDeadline || null
  });
}

function baseUrlForContext(context = {}) {
  if (context.config && context.config.target && context.config.target.baseUrl) return context.config.target.baseUrl;
  if (context.baseUrl) return context.baseUrl;
  if (context.page && typeof context.page.url === 'function') {
    try {
      return context.page.url();
    } catch (_) {
      return null;
    }
  }
  return null;
}

async function readPageModel(context = {}, options = {}) {
  const extractor = context.modelExtractor || extractPageModel;
  return extractor(context.page, {
    baseUrl: options.baseUrl || baseUrlForContext(context),
    spaHashBaseUrl: context.config && context.config.target && context.config.target.baseUrl,
    preserveSpaHashRoutes: context.config && context.config.crawler && context.config.crawler.preserveSpaHashRoutes !== false
  });
}

async function observe(context = {}, step = {}) {
  const observeFn = context.observe || observePage;
  const config = resolveCrawlerConfig(context, step);
  return observeFn(context.page, { maxObservationMs: config.crawler.maxObservationMs });
}

function routeForSurface(surface, context = {}) {
  const baseUrl = baseUrlForContext(context);
  const candidates = SURFACE_ROUTES[String(surface || '').toLowerCase()] || [];
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate, baseUrl, { preserveSpaHashRoutes: true });
    if (url) return url;
  }
  return null;
}

function surfaceFromStep(step = {}) {
  return step.surface || step.target && step.target.surface || step.value || step.id;
}

function compactResult(pageModel = {}, extra = {}) {
  return {
    ok: true,
    completed: true,
    url: pageModel.url || '',
    routeShape: pageModel.routeShape || '',
    surfaceType: pageModel.surfaceType || '',
    title: pageModel.title || '',
    visibleTextSummary: pageModel.visibleTextSummary || '',
    pageModel: {
      url: pageModel.url || '',
      routeShape: pageModel.routeShape || '',
      title: pageModel.title || '',
      surfaceType: pageModel.surfaceType || '',
      counts: {
        links: (pageModel.links || []).length,
        forms: (pageModel.forms || []).length,
        actions: (pageModel.actions || []).length
      }
    },
    ...extra
  };
}

function actionText(action = {}) {
  return `${action.id || ''} ${action.kind || ''} ${action.label || ''} ${action.selector || ''} ${action.href || ''}`.toLowerCase();
}

function findAction(pageModel = {}, predicate) {
  return (pageModel.actions || []).find(predicate) || null;
}

function findForm(pageModel = {}, predicate) {
  return (pageModel.forms || []).find(predicate) || null;
}

function cartCountFromModel(pageModel = {}) {
  const text = `${pageModel.visibleTextSummary || ''} ${pageModel.title || ''}`;
  const basket = text.match(/\b(?:basket|cart)\D{0,20}(\d{1,3})\b/i);
  if (basket) return Number(basket[1]);
  const count = text.match(/\bYour Basket\s+(\d{1,3})\b/i);
  return count ? Number(count[1]) : 0;
}

function confirmationVisible(pageModel = {}, observation = {}) {
  const text = `${pageModel.visibleTextSummary || ''} ${pageModel.title || ''} ${JSON.stringify(observation.events || [])}`.toLowerCase();
  return /\b(success|successful|successfully|confirmed|confirmation|thank|submitted|complete|completed|transferred|transfer complete|feedback.*received)\b/.test(text);
}

function observationEvents(observation = {}) {
  if (Array.isArray(observation)) return observation;
  if (Array.isArray(observation.events)) return observation.events;
  return [
    ...(observation.requests || []),
    ...(observation.responses || []),
    ...(observation.endpoints || [])
  ];
}

function remainingStepMs(context = {}, fallback = 1000, reserveMs = 150) {
  const deadline = context._operationDeadline;
  if (deadline && typeof deadline.remainingMs === 'function') {
    const remaining = Math.floor(deadline.remainingMs()) - reserveMs;
    return Number.isFinite(remaining) && remaining > 0 ? remaining : 1;
  }
  return fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function feedbackSubmissionObserved(observation = {}) {
  let sawSubmissionRequest = false;
  let sawSuccessfulResponse = false;
  let sawFailureResponse = false;
  for (const event of observationEvents(observation)) {
    const method = String(event.method || '').toUpperCase();
    const path = String(event.path || event.url || '').toLowerCase();
    const status = Number(event.status);
    if (!/(feedback|contact|complain)/.test(path)) continue;
    if (!['POST', 'PUT', 'PATCH'].includes(method)) continue;
    if (event.type === 'response' && Number.isFinite(status) && status >= 400) sawFailureResponse = true;
    if (event.type === 'response' && (!Number.isFinite(status) || status < 400)) sawSuccessfulResponse = true;
    if (event.type === 'request') sawSubmissionRequest = true;
  }
  if (sawFailureResponse) return false;
  return sawSuccessfulResponse || sawSubmissionRequest;
}

function feedbackValidationVisible(pageModel = {}, observation = {}) {
  const events = observationEvents(observation);
  const feedbackEndpointFailed = events.some(event => {
    const method = String(event.method || '').toUpperCase();
    const path = String(event.path || event.url || '').toLowerCase();
    const status = Number(event.status);
    return /(feedback|contact|complain)/.test(path)
      && ['POST', 'PUT', 'PATCH'].includes(method)
      && event.type === 'response'
      && Number.isFinite(status)
      && status >= 400;
  });
  if (feedbackEndpointFailed) return true;
  const text = `${pageModel.visibleTextSummary || ''} ${pageModel.title || ''}`.toLowerCase();
  return /\b(captcha.*(?:wrong|invalid|incorrect|failed|try again)|(?:wrong|invalid|incorrect|failed).*captcha|(?:feedback|contact|comment|message|rating).{0,40}(?:required|invalid|incorrect|failed|error)|(?:required|invalid|incorrect|failed|error).{0,40}(?:feedback|contact|comment|message|rating))\b/.test(text);
}

function feedbackObservationBudget(step = {}, config = {}) {
  const base = Number(config.crawler && config.crawler.maxObservationMs);
  const stepBudget = Number(step.timeoutMs);
  const fallback = Number.isFinite(base) && base >= 0 ? base : 800;
  if (!Number.isFinite(stepBudget) || stepBudget <= fallback) return fallback;
  return Math.max(fallback, Math.min(stepBudget, 2000));
}

async function openSurface(step = {}, context = {}) {
  const config = resolveCrawlerConfig(context, step);
  const before = await readPageModel(context);
  const surface = surfaceFromStep(step);
  const route = step.target && typeof step.target === 'string'
    ? normalizeUrl(step.target, baseUrlForContext(context), { preserveSpaHashRoutes: true })
    : routeForSurface(surface, context);
  let action = null;
  if (route) {
    await gotoRoute(context.page, { url: route }, config.crawler.maxRouteMs);
  } else {
    const needle = String(surface || '').toLowerCase();
    action = findAction(before, candidate => actionText(candidate).includes(needle));
    if (!action) return compactResult(before, { ok: false, reason: 'surface_target_not_found', surface });
    await clickLocator(context.page, action.locatorPlan || locatorPlanFromControl(action, { critical: true }), { timeout: config.crawler.maxActionMs, critical: true });
  }
  const observation = await observe(context, step);
  const after = await readPageModel(context, { baseUrl: before.url });
  const transition = validateTransition({ before, after, events: observation.events || observation, action: action || { id: step.id, kind: 'open-surface' } });
  return compactResult(after, {
    surface,
    transition,
    observation,
    confirmationVisible: confirmationVisible(after, observation),
    cartCount: cartCountFromModel(after)
  });
}

async function search(step = {}, context = {}) {
  const config = resolveCrawlerConfig(context, step);
  const value = step.value || step.target && step.target.query || searchValueFromProfile(context.profile) || 'test';
  const targetUrl = searchTargetUrl(step, context, value);
  let directRouteFailure = null;
  if (targetUrl) {
    await gotoRoute(context.page, { url: targetUrl }, searchRouteBudgetMs(context, config), { config }).catch(() => null);
    const routeReady = await waitForSearchRouteEvidence(step, context, config, value);
    if (routeReady.ready) {
      return compactResult(routeReady.pageModel, {
        searchTerm: value,
        surfaceType: routeReady.pageModel.surfaceType || 'search-results',
        transition: { valid: true, signals: routeReady.signals },
        observation: routeReady.observation
      });
    }
    if (targetUrlHasSearchValue(targetUrl, value)) {
      directRouteFailure = compactResult(routeReady.pageModel, {
        ok: false,
        reason: 'search_results_not_ready',
        searchTerm: value,
        surfaceType: routeReady.pageModel.surfaceType || 'search-results',
        transition: { valid: false, noProgress: true, reason: 'search-results-not-ready', signals: routeReady.signals },
        observation: routeReady.observation
      });
    }
  }
  const before = await readPageModel(context);
  if (targetUrl && pageContainsSearchResult(before, value)) {
    return compactResult(before, {
      searchTerm: value,
      surfaceType: before.surfaceType || 'search-results',
      transition: { valid: true, signals: ['search-route-loaded'] },
      observation: { events: [] }
    });
  }
  const searchForm = findForm(before, form => form.kind === 'search');
  if (searchForm) {
    const result = await runFormWorker({
      page: context.page,
      form: searchForm,
      profile: { ...(context.profile || {}), values: { ...(context.profile && context.profile.values || {}), search: value, query: value, q: value } },
      config,
      telemetry: context.telemetry,
      allowSubmit: true,
      submissionLedger: context.formAttemptLedger,
      observe: context.observe || observePage,
      modelExtractor: context.modelExtractor || extractPageModel,
      feedbackExtractor: context.feedbackExtractor,
      operation: 'workflow-form-submit',
      step,
      parentDeadline: context._operationDeadline || null
    });
    const after = result.after || await readPageModel(context, { baseUrl: before.url });
    return compactResult(after, {
      ok: !hasValidationFeedback(result.validationFeedback),
      searchTerm: value,
      surfaceType: after.surfaceType || 'search-results',
      transition: result.transition,
      observation: result.observation
    });
  }
  const action = findAction(before, candidate => /search/.test(actionText(candidate)));
  if (action) {
    if (/input|type-search/.test(action.kind || '')) await fillLocator(context.page, action.locatorPlan, value, { timeout: config.crawler.maxActionMs });
    else await clickLocator(context.page, action.locatorPlan || locatorPlanFromControl(action, { critical: true }), { timeout: config.crawler.maxActionMs, critical: true });
    const observation = await observe(context, step);
    const after = await readPageModel(context, { baseUrl: before.url });
    const signals = searchResultSignals(after, value, observation);
    if (signals.includes('visible-search-result-text') || signals.includes('product-action-visible') || signals.includes('search-endpoint-observed')) {
      return compactResult(after, {
        searchTerm: value,
        surfaceType: after.surfaceType || 'search-results',
        transition: { valid: true, signals },
        observation
      });
    }
    return directRouteFailure || compactResult(after, { searchTerm: value, transition: validateTransition({ before, after, events: observation.events || observation, action }), observation });
  }
  await gotoRoute(context.page, { url: normalizeUrl(`/search?q=${encodeURIComponent(value)}`, baseUrlForContext(context), { preserveSpaHashRoutes: true }) }, config.crawler.maxRouteMs);
  const observation = await observe(context, step);
  const after = await readPageModel(context, { baseUrl: before.url });
  return directRouteFailure || compactResult(after, { searchTerm: value, transition: validateTransition({ before, after, events: observation.events || observation, action: { id: step.id, kind: 'search' } }), observation });
}

function searchRouteBudgetMs(context = {}, config = {}) {
  const maxRouteMs = Number(config.crawler && config.crawler.maxRouteMs) || 1000;
  if (!context._operationDeadline || typeof context._operationDeadline.remainingMs !== 'function') return maxRouteMs;
  const reserveMs = Math.max(
    1000,
    Math.min(2500, (Number(config.crawler && config.crawler.maxObservationMs) || 500) * 2)
  );
  const remaining = remainingStepMs(context, maxRouteMs, reserveMs);
  return Math.max(1, Math.min(maxRouteMs, remaining));
}

function searchValueFromProfile(profile = {}) {
  if (!profile) return null;
  if (profile.search || profile.query || profile.q) return profile.search || profile.query || profile.q;
  const values = profile.values || {};
  if (values.search || values.query || values.q) return values.search || values.query || values.q;
  if (Array.isArray(profile.searchTerms) && profile.searchTerms.length > 0) return profile.searchTerms[0];
  return null;
}

function searchTargetUrl(step = {}, context = {}, value = '') {
  const route = step.target && (step.target.route || step.target.url);
  if (!route || !/search/i.test(String(route))) return null;
  let candidate = String(route);
  if (!/[?&](?:q|query|search)=/i.test(candidate) && value) {
    const separator = candidate.includes('?') ? '&' : '?';
    candidate = `${candidate}${separator}q=${encodeURIComponent(String(value))}`;
  }
  return normalizeUrl(candidate, baseUrlForContext(context), { preserveSpaHashRoutes: true });
}

function targetUrlHasSearchValue(url, value = '') {
  try {
    const parsed = new URL(url);
    const query = parsed.search || parsed.hash && parsed.hash.includes('?') ? parsed.href : '';
    return String(query).toLowerCase().includes(encodeURIComponent(String(value || '')).toLowerCase())
      || String(query).toLowerCase().includes(String(value || '').toLowerCase());
  } catch (_) {
    return false;
  }
}

function pageContainsSearchResult(pageModel = {}, value = '') {
  const text = `${pageModel.visibleTextSummary || ''} ${pageModel.visibleText || ''} ${pageModel.title || ''}`.toLowerCase();
  const needle = String(value || '').toLowerCase();
  return needle ? text.includes(needle) : false;
}

function searchResultSignals(pageModel = {}, value = '', observation = {}) {
  const signals = [];
  if (pageContainsSearchResult(pageModel, value)) signals.push('visible-search-result-text');
  if ((pageModel.actions || []).some(candidate => /\b(add|put).{0,30}(cart|basket)\b|\b(cart|basket).{0,30}(add)\b/i.test(actionText(candidate)))) {
    signals.push('product-action-visible');
  }
  if (observationEvents(observation).some(event => {
    const method = String(event.method || '').toUpperCase();
    const path = String(event.path || event.url || '').toLowerCase();
    const status = Number(event.status);
    if (method && method !== 'GET') return false;
    if (!/(?:product|catalog|search)/.test(path)) return false;
    if (Number.isFinite(status) && status >= 400) return false;
    return String(path).includes(String(value || '').toLowerCase()) || /\/search\b/.test(path);
  })) {
    signals.push('search-endpoint-observed');
  }
  return Array.from(new Set(signals));
}

async function waitForSearchRouteEvidence(step = {}, context = {}, config = {}, value = '') {
  const started = Date.now();
  const maxWaitMs = Math.max(1, Math.min(remainingStepMs(context, config.crawler && config.crawler.maxActionMs || 1000), 4500));
  let latestModel = await readPageModel(context).catch(() => ({ url: baseUrlForContext(context), actions: [], forms: [] }));
  let latestObservation = { events: [] };
  let latestSignals = searchResultSignals(latestModel, value, latestObservation);
  while (Date.now() - started < maxWaitMs) {
    if (latestSignals.includes('visible-search-result-text') || latestSignals.includes('product-action-visible')) {
      return { ready: true, pageModel: latestModel, observation: latestObservation, signals: latestSignals };
    }
    latestObservation = await observe(context, {
      ...step,
      timeoutMs: Math.min(Number(step.timeoutMs) || maxWaitMs, config.crawler && config.crawler.maxObservationMs || 500)
    }).catch(error => ({ events: [], error: error.message }));
    latestModel = await readPageModel(context, { baseUrl: latestModel.url || baseUrlForContext(context) })
      .catch(() => latestModel);
    latestSignals = searchResultSignals(latestModel, value, latestObservation);
    if (latestSignals.includes('visible-search-result-text') || latestSignals.includes('product-action-visible')) {
      return { ready: true, pageModel: latestModel, observation: latestObservation, signals: latestSignals };
    }
    await sleep(Math.min(150, Math.max(0, maxWaitMs - (Date.now() - started))));
  }
  return { ready: false, pageModel: latestModel, observation: latestObservation, signals: latestSignals };
}

async function addToCart(step = {}, context = {}) {
  const config = resolveCrawlerConfig(context, step);
  const stepValue = step && typeof step.value === 'object' && !Array.isArray(step.value) ? step.value : {};
  const successTarget = step && typeof step.success === 'object' && !Array.isArray(step.success) ? step.success : {};
  const count = Math.max(1, Number(
    step.count
      || stepValue.quantity
      || stepValue.count
      || stepValue.items
      || step.target && step.target.count
      || successTarget.cartCountAtLeast
      || 1
  ));
  let before = await readPageModel(context);
  let cartCount = cartCountFromModel(before);
  const clicked = [];
  await dismissCommonOverlays(context.page, { timeoutMs: Math.min(500, config.crawler.maxActionMs || 500) }).catch(() => null);
  for (let index = 0; index < count; index += 1) {
    const model = index === 0 ? before : await readPageModel(context, { baseUrl: before.url });
    const action = await waitForAddToCartAction(step, context, config, model, before.url);
    if (!action) {
      return compactResult(model, { ok: false, reason: 'add_to_cart_control_not_found', clicked, cartCount });
    }
    const clickResult = await clickAddToCartAction(context, action, config);
    if (!clickResult.ok) {
      return compactResult(model, {
        ok: false,
        reason: 'add_to_cart_click_failed',
        clicked,
        cartCount,
        error: clickResult.error
      });
    }
    clicked.push(action.id || action.label);
    await observe(context, step);
    cartCount = Math.max(cartCount, cartCountFromModel(await readPageModel(context, { baseUrl: before.url })));
  }
  const observation = await observe(context, step);
  const after = await readPageModel(context, { baseUrl: before.url });
  const afterCount = Math.max(cartCount, cartCountFromModel(after));
  return compactResult(after, {
    ok: afterCount >= count || clicked.length >= count,
    clicked,
    cartCount: afterCount,
    cartCountAtLeast: afterCount,
    transition: validateTransition({ before, after, events: observation.events || observation, action: { id: step.id, kind: 'add-to-cart' } }),
    observation
  });
}

async function clickAddToCartAction(context = {}, action = {}, config = {}) {
  const plan = action.locatorPlan || locatorPlanFromControl(action, { critical: true });
  const timeout = Math.max(1, Math.min(1800, remainingStepMs(context, config.crawler && config.crawler.maxActionMs || 1000, 250)));
  try {
    await clickLocator(context.page, plan, { timeout, critical: true });
    return { ok: true };
  } catch (error) {
    await dismissCommonOverlays(context.page, { timeoutMs: Math.min(500, timeout) }).catch(() => null);
    const retryTimeout = Math.max(1, Math.min(1800, remainingStepMs(context, config.crawler && config.crawler.maxActionMs || 1000, 250)));
    try {
      await clickLocator(context.page, plan, { timeout: retryTimeout, critical: true });
      return { ok: true, retried: true };
    } catch (retryError) {
      return { ok: false, error: retryError.message || error.message || 'click_failed' };
    }
  }
}

async function waitForAddToCartAction(step = {}, context = {}, config = {}, initialModel = {}, baseUrl = null) {
  const started = Date.now();
  const maxWaitMs = Math.max(1, Math.min(remainingStepMs(context, config.crawler && config.crawler.maxActionMs || 1000), 3500));
  let model = initialModel || {};
  while (Date.now() - started < maxWaitMs) {
    const action = (model.actions || []).find(candidate => /\b(add|put).{0,30}(cart|basket)\b|\b(cart|basket).{0,30}(add)\b/i.test(actionText(candidate)));
    if (action) return action;
    await observe(context, {
      ...step,
      timeoutMs: Math.min(Number(step.timeoutMs) || maxWaitMs, config.crawler && config.crawler.maxObservationMs || 500)
    }).catch(() => null);
    model = await readPageModel(context, { baseUrl: baseUrl || model.url || baseUrlForContext(context) }).catch(() => model);
    await sleep(Math.min(150, Math.max(0, maxWaitMs - (Date.now() - started))));
  }
  return null;
}

async function submitFeedback(step = {}, context = {}) {
  await openSurface({ ...step, surface: step.surface || 'feedback' }, context);
  const config = resolveCrawlerConfig(context, step);
  let before = await readPageModel(context);
  const domFeedbackResult = await submitFeedbackDomFallback(step, context, config, before);
  if (domFeedbackResult) return domFeedbackResult;
  let form = findFeedbackForm(before);
  if (!form) {
    for (const candidate of feedbackFallbackRoutes(context)) {
      await gotoRoute(context.page, { url: candidate }, config.crawler.maxRouteMs).catch(() => null);
      await observe(context, step).catch(() => null);
      before = await readPageModel(context, { baseUrl: before.url });
      form = findFeedbackForm(before);
      if (form) break;
    }
  }
  if (!form) return compactResult(before, { ok: false, reason: 'feedback_form_not_found' });
  const result = await runFormWorker({
    page: context.page,
    form,
    profile: {
      ...(context.profile || {}),
      values: {
        name: 'PTK User',
        email: 'ptk@example.test',
        message: 'PTK benign feedback message',
        comment: 'PTK benign feedback message',
        ...(context.profile && context.profile.values || {})
      }
    },
    config,
    telemetry: context.telemetry,
    allowSubmit: true,
    submissionLedger: context.formAttemptLedger,
    observe: context.observe || observePage,
    modelExtractor: context.modelExtractor || extractPageModel,
    feedbackExtractor: context.feedbackExtractor,
    operation: 'workflow-form-submit',
    step,
    parentDeadline: context._operationDeadline || null
  });
  const after = result.after || await readPageModel(context, { baseUrl: before.url });
  const confirmed = confirmationVisible(after, result.observation || {}) || feedbackSubmissionObserved(result.observation || {});
  return compactResult(after, {
    ok: result.submitted === true && !hasValidationFeedback(result.validationFeedback) && !feedbackValidationVisible(after, result.observation || {}),
    confirmationVisible: confirmed,
    form: { formId: result.formId, submitted: result.submitted, reason: result.reason || null },
    validationFeedback: result.validationFeedback,
    transition: result.transition,
    observation: result.observation
  });
}

async function submitFeedbackDomFallback(step = {}, context = {}, config = {}, beforeModel = {}) {
  if (!context.page || typeof context.page.evaluate !== 'function') return null;
  const hasFeedbackSurface = /customer feedback|captcha|comment|feedback/i.test(`${beforeModel.visibleTextSummary || ''} ${beforeModel.title || ''}`);
  if (!hasFeedbackSurface) return null;
  const before = beforeModel;
  const observationMs = feedbackObservationBudget(step, config);
  const collector = context.page && typeof context.page.on === 'function'
    ? createEventCollector(context.page, { maxObservationMs: observationMs })
    : null;
  if (collector) collector.start();
  const submitStatus = await context.page.evaluate(async ({ message }) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const nativeSet = (element, value) => {
      if (!element) return;
      const proto = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : element.tagName === 'SELECT'
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(element, String(value));
      else element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const captchaDebug = {};
    const solveMathCaptcha = text => {
      captchaDebug.scoped = null;
      captchaDebug.expression = null;
      captchaDebug.normalized = null;
      captchaDebug.tokens = [];
      const cleaned = clean(text);
      const lower = cleaned.toLowerCase();
      const captchaIndex = lower.lastIndexOf('captcha');
      const scoped = captchaIndex >= 0 ? cleaned.slice(captchaIndex, captchaIndex + 160) : cleaned;
      const expression = scoped.match(/(\d{1,3}(?:\s*[+\-*/xX÷]\s*\d{1,3}){1,6})/);
      captchaDebug.scoped = scoped.slice(0, 160);
      captchaDebug.expression = expression && expression[1] || null;
      if (!expression) return '0';
      const normalized = expression[1].replace(/[xX]/g, '*').replace(/÷/g, '/');
      captchaDebug.normalized = normalized;
      if (!/^[0-9+\-*/\s]+$/.test(normalized)) return '0';
      const tokens = normalized.match(/\d{1,3}|[+\-*/]/g) || [];
      captchaDebug.tokens = tokens;
      if (tokens.length < 3 || tokens.length % 2 === 0) return '0';
      const values = [Number(tokens[0])];
      const ops = [];
      for (let index = 1; index < tokens.length; index += 2) {
        const op = tokens[index];
        const right = Number(tokens[index + 1]);
        if (op === '*') values[values.length - 1] *= right;
        else if (op === '/') values[values.length - 1] = right === 0 ? 0 : values[values.length - 1] / right;
        else {
          ops.push(op);
          values.push(right);
        }
      }
      let total = values[0];
      for (let index = 0; index < ops.length; index += 1) {
        total = ops[index] === '+' ? total + values[index + 1] : total - values[index + 1];
      }
      return Number.isFinite(total) ? String(total) : '0';
    };
    const collectCaptchaHints = () => [
      document.querySelector('#captcha') && document.querySelector('#captcha').textContent,
      captcha.closest('mat-form-field') && captcha.closest('mat-form-field').innerText,
      captcha.parentElement && captcha.parentElement.innerText,
      document.body && document.body.innerText
    ].filter(Boolean).join(' ');
    const clickByText = pattern => {
      for (const element of Array.from(document.querySelectorAll('button,[role="button"],a')).slice(0, 80)) {
        const text = clean(element.innerText || element.textContent || element.getAttribute('aria-label'));
        if (pattern.test(text)) {
          element.click();
          return true;
        }
      }
      return false;
    };
    const dismissBlockingDialogs = async () => {
      const patterns = [/me want it/i, /dismiss/i, /close/i, /ok/i, /got it/i, /accept/i, /agree/i];
      for (let round = 0; round < 3; round += 1) {
        let clicked = false;
        const controls = Array.from(document.querySelectorAll(
          'mat-dialog-container button, [role="dialog"] button, button,[role="button"],a'
        )).slice(0, 120);
        for (const pattern of patterns) {
          const control = controls.find(element => {
            const text = clean(element.innerText || element.textContent || element.getAttribute('aria-label') || element.id || element.className);
            return pattern.test(text);
          });
          if (control) {
            control.click();
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          const dialogButton = document.querySelector('mat-dialog-container mat-dialog-actions button, [role="dialog"] button');
          if (dialogButton) {
            dialogButton.click();
            clicked = true;
          }
        }
        if (!clicked) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    };
    await dismissBlockingDialogs();
    clickByText(/me want it|dismiss|close/i);
    const comment = document.querySelector('#comment, textarea[placeholder*="like" i], textarea[aria-label*="comment" i], textarea');
    const captcha = document.querySelector('#captchaControl, input[placeholder*="captcha" i], input[aria-label*="captcha" i]');
    const submit = document.querySelector('#submitButton') || Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).find(element => /submit|send/i.test(clean(element.innerText || element.textContent || element.value || element.id)));
    if (!comment || !captcha || !submit) return { submitted: false, reason: 'feedback_controls_not_found' };
    let answer = '0';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      answer = solveMathCaptcha(collectCaptchaHints());
      if (captchaDebug.expression) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!captchaDebug.expression) {
      return { submitted: false, reason: 'captcha_expression_not_ready', captchaAnswer: answer, captchaDebug };
    }
    if (captchaDebug.expression) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const rating = document.querySelector('input[type="range"]');
    if (rating) {
      nativeSet(rating, rating.max || '5');
    }
    nativeSet(comment, String(message || 'PTK benign feedback message').slice(0, 120));
    nativeSet(captcha, answer);
    await new Promise(resolve => setTimeout(resolve, 75));
    submit.scrollIntoView({ block: 'center', inline: 'center' });
    const disabledBeforeClick = Boolean(submit.disabled || submit.getAttribute('aria-disabled') === 'true');
    submit.click();
    return { submitted: true, captchaAnswer: answer, captchaDebug, disabledBeforeClick };
  }, { message: step.value && step.value.message || 'PTK benign feedback message' }).catch(() => false);
  if (!submitStatus) {
    if (collector) collector.stop();
    return null;
  }
  if (submitStatus.submitted === false) {
    if (collector) collector.stop();
    if (submitStatus.reason && submitStatus.reason !== 'feedback_controls_not_found') {
      const after = await readPageModel(context, { baseUrl: before.url }).catch(() => before);
      return compactResult(after, {
        ok: false,
        reason: submitStatus.reason,
        confirmationVisible: false,
        form: { formId: 'dom-feedback', submitted: false, reason: submitStatus.reason, submitStatus },
        observation: { events: [] }
      });
    }
    return null;
  }
  const observation = collector ? await collector.observe(observationMs) : await observe(context, { ...step, timeoutMs: observationMs });
  const after = await readPageModel(context, { baseUrl: before.url });
  const confirmed = confirmationVisible(after, observation) || feedbackSubmissionObserved(observation);
  return compactResult(after, {
    ok: confirmed && !feedbackValidationVisible(after, observation),
    confirmationVisible: confirmed,
    form: { formId: 'dom-feedback', submitted: true, reason: null, submitStatus },
    transition: validateTransition({ before, after, events: observation.events || observation, action: { id: step.id, kind: 'submit-feedback' } }),
    observation
  });
}

function findFeedbackForm(pageModel = {}) {
  return findForm(pageModel, candidate => {
    const fieldText = (candidate.fields || []).map(field => `${field.name || ''} ${field.id || ''} ${field.label || ''} ${field.type || ''}`).join(' ');
    const haystack = `${candidate.id || ''} ${candidate.kind || ''} ${candidate.action || ''} ${fieldText}`.toLowerCase();
    return /feedback|contact|complain|complaint|message|comment|subject|generic/.test(haystack);
  });
}

function feedbackFallbackRoutes(context = {}) {
  const baseUrl = baseUrlForContext(context);
  return Array.from(new Set((SURFACE_ROUTES.feedback || [])
    .map(candidate => normalizeUrl(candidate, baseUrl, { preserveSpaHashRoutes: true }))
    .filter(Boolean)));
}

async function transferFunds(step = {}, context = {}) {
  await openSurface({ ...step, surface: step.surface || 'transfer' }, context);
  const config = resolveCrawlerConfig(context, step);
  const before = await readPageModel(context);
  const form = findForm(before, candidate => /transfer|from|to|amount|generic/i.test(`${candidate.id || ''} ${candidate.action || ''} ${(candidate.fields || []).map(field => `${field.name || ''} ${field.label || ''}`).join(' ')}`));
  if (!form) return compactResult(before, { ok: false, reason: 'transfer_form_not_found' });
  const stepValue = step && typeof step.value === 'object' && !Array.isArray(step.value) ? step.value : {};
  const fromAccount = step.fromAccount || stepValue.fromAccount || stepValue.from || stepValue.sourceAccount || 'first-available';
  const toAccount = step.toAccount || stepValue.toAccount || stepValue.to || stepValue.destinationAccount || 'different-available';
  const amount = step.amount || stepValue.amount || (stepValue.amountClass === 'small' ? '1.00' : null) || '1.00';
  const transferProfile = {
    ...(context.profile || {}),
    values: {
      fromAccount,
      from: fromAccount,
      accountFrom: fromAccount,
      toAccount,
      to: toAccount,
      accountTo: toAccount,
      amount,
      ...(context.profile && context.profile.values || {})
    }
  };
  const result = await runFormWorker({
    page: context.page,
    form,
    profile: transferProfile,
    config,
    telemetry: context.telemetry,
    allowSubmit: true,
    submissionLedger: context.formAttemptLedger,
    observe: context.observe || observePage,
    modelExtractor: context.modelExtractor || extractPageModel,
    feedbackExtractor: context.feedbackExtractor,
    operation: 'workflow-form-submit',
    step,
    parentDeadline: context._operationDeadline || null
  });
  let after = result.after || await readPageModel(context, { baseUrl: before.url });
  let observation = result.observation || {};
  let transition = result.transition;
  let fallback = null;
  if (result.submitted === true
    && transition && transition.noProgress
    && !hasValidationFeedback(result.validationFeedback)
    && shouldRetryNoProgressPostForm(form)) {
    fallback = await submitPostFormDomFallback({
      context,
      form,
      profile: transferProfile,
      config,
      before,
      step
    }).catch(error => ({ ok: false, reason: error.message }));
    if (fallback && fallback.ok !== false && fallback.submitted) {
      after = fallback.after || after;
      observation = fallback.observation || observation;
      transition = fallback.transition || transition;
    }
  }
  return compactResult(after, {
    ok: result.submitted === true && !hasValidationFeedback(result.validationFeedback),
    confirmationVisible: confirmationVisible(after, observation || {}),
    form: {
      formId: result.formId,
      submitted: result.submitted,
      reason: result.reason || null,
      fallback: fallback && fallback.submitted ? 'dom-submit-after-no-progress' : null
    },
    validationFeedback: result.validationFeedback,
    transition,
    observation
  });
}

function shouldRetryNoProgressPostForm(form = {}) {
  const method = String(form.method || '').toUpperCase();
  if (method !== 'POST') return false;
  const kind = String(form.kind || '').toLowerCase();
  return /transfer|business|mutation|generic/.test(kind);
}

async function submitPostFormDomFallback({ context = {}, form = {}, profile = {}, config = {}, before = {}, step = {} } = {}) {
  const page = context.page;
  if (!page || typeof page.evaluate !== 'function') return null;
  const fields = (form.fields || []).map(field => ({
    id: field.id || null,
    name: field.name || null,
    selector: field.selector || null,
    type: field.type || null,
    value: valueForField(field, profile)
  })).filter(field => !/submit|button|hidden|file/i.test(String(field.type || '')) && field.value !== null && field.value !== undefined);
  const navigationPromise = typeof page.waitForNavigation === 'function'
    ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navigationWaitMsForFormSubmit(config.crawler && config.crawler.maxActionMs || 1000) })
      .then(() => ({ navigated: true }))
      .catch(error => ({ navigated: false, timeout: true, error }))
    : Promise.resolve({ navigated: false });
  const submitStatus = await page.evaluate(({ formId, selector, submitSelector, fields }) => {
    const findField = planned => {
      if (planned.selector) {
        const bySelector = document.querySelector(planned.selector);
        if (bySelector) return bySelector;
      }
      if (planned.id) {
        const byId = document.getElementById(planned.id);
        if (byId) return byId;
      }
      if (planned.name) {
        const byName = Array.from(document.getElementsByName(String(planned.name)))
          .find(candidate => !form || form.contains(candidate));
        if (byName) return byName;
      }
      return null;
    };
    const forms = Array.from(document.querySelectorAll('form'));
    const form = selector ? document.querySelector(selector) : forms.find(candidate => candidate.id === formId || candidate.name === formId) || forms[0];
    if (!form) return { submitted: false, reason: 'form_not_found' };
    for (const planned of fields) {
      const field = findField(planned);
      if (!field) continue;
      const value = String(planned.value);
      if (field.tagName && field.tagName.toLowerCase() === 'select') {
        const options = Array.from(field.options || []).filter(option => !option.disabled);
        const exact = options.find(option => option.value === value || String(option.textContent || '').trim() === value);
        const key = String(field.name || field.id || '').toLowerCase();
        const desired = value.toLowerCase();
        const index = /second|different|destination|credit|\bto\b/.test(desired) || /\bto\b|destination|credit/.test(key) ? 1 : 0;
        const selected = exact || options[index] || options[0];
        if (selected) field.value = selected.value;
      } else {
        field.value = value;
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const submit = submitSelector ? document.querySelector(submitSelector) : form.querySelector('button,input[type="submit"],[role="button"]');
    if (typeof form.requestSubmit === 'function') form.requestSubmit(submit || undefined);
    else if (submit && typeof submit.click === 'function') submit.click();
    else if (typeof form.submit === 'function') form.submit();
    else return { submitted: false, reason: 'submit_control_not_found' };
    return { submitted: true };
  }, {
    formId: form.id || null,
    selector: form.selector || null,
    submitSelector: form.submitSelector || null,
    fields
  });
  await navigationPromise;
  if (!submitStatus || submitStatus.submitted !== true) return { ok: false, submitted: false, reason: submitStatus && submitStatus.reason || 'dom_submit_failed' };
  const observation = await observe(context, step);
  const after = await readPageModel(context, { baseUrl: before.url });
  const transition = validateTransition({ before, after, events: observation.events || observation, action: { id: form.id, kind: 'submit-form-dom-fallback' } });
  return {
    ok: true,
    submitted: true,
    after,
    observation,
    transition,
    confirmationVisible: confirmationVisible(after, observation)
  };
}

function createWorkflowExecutors(defaultContext = {}) {
  return {
    openSurface: (step, context = {}) => openSurface(step, { ...defaultContext, ...context }),
    search: (step, context = {}) => search(step, { ...defaultContext, ...context }),
    addToCart: (step, context = {}) => addToCart(step, { ...defaultContext, ...context }),
    submitFeedback: (step, context = {}) => submitFeedback(step, { ...defaultContext, ...context }),
    transferFunds: (step, context = {}) => transferFunds(step, { ...defaultContext, ...context })
  };
}

module.exports = {
  SURFACE_ROUTES,
  addToCart,
  cartCountFromModel,
  confirmationVisible,
  createWorkflowExecutors,
  feedbackSubmissionObserved,
  openSurface,
  search,
  shouldRetryNoProgressPostForm,
  submitFeedback,
  submitPostFormDomFallback,
  transferFunds
};
