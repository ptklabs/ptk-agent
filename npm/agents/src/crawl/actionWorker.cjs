'use strict';

const { safeActions, isSafeAction } = require('../browser/actionModel.cjs');
const { extractPageModel } = require('../browser/pageModel.cjs');
const { createEventCollector, observePage } = require('../browser/eventCollector.cjs');
const { validateTransition } = require('../browser/transition.cjs');
const { isStaticDocumentUrl, scopeFromConfig } = require('../browser/context.cjs');
const { recoverToRoute } = require('../browser/recovery.cjs');
const { assertNavigationAllowed, isScopeGuardError } = require('../browser/scopeGuard.cjs');
const { withTimeout } = require('../core/budgets.cjs');
const { clickLocator, fillLocator, isGenericSelector } = require('../browser/locatorResolver.cjs');
const { shouldSuppressAction } = require('../memory/siteMemory.cjs');

function resolveActionBudgets(config = {}) {
  const crawler = config.crawler || config;
  return {
    maxActionMs: Number(crawler.maxActionMs) > 0 ? Number(crawler.maxActionMs) : 1000,
    maxObservationMs: Number(crawler.maxObservationMs) >= 0 ? Number(crawler.maxObservationMs) : 800,
    maxActionsPerRoute: Number(crawler.maxActionsPerRoute) >= 0 ? Number(crawler.maxActionsPerRoute) : 3,
    maxNoProgressActions: Number(crawler.maxNoProgressActions) >= 0 ? Number(crawler.maxNoProgressActions) : 2
  };
}

async function runActionWorker({ page, pageModel, actions, frontier, coverage, config, telemetry, logger, observe = null, modelExtractor = extractPageModel } = {}) {
  const budgets = resolveActionBudgets(config || {});
  const modelOptions = {
    spaHashBaseUrl: config && config.target && config.target.baseUrl,
    preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
    config,
    browserProbe: config && config.browserProbe
  };
  const seedModel = pageModel || await modelExtractor(page, modelOptions);
  const candidates = (actions || safeActions(seedModel))
    .filter(action => isSafeAction(action))
    .filter(action => !shouldSuppressAction(config && config._siteMemory, action, seedModel.url, config))
    .slice(0, budgets.maxActionsPerRoute);
  const results = [];
  let noProgress = 0;
  for (const action of candidates) {
    if (noProgress >= budgets.maxNoProgressActions) break;
    const started = Date.now();
    const before = await extractActionPageModel({
      page,
      modelExtractor,
      modelOptions: { ...modelOptions, baseUrl: seedModel.url },
      timeoutMs: budgets.maxObservationMs,
      fallback: seedModel,
      label: `before action ${action.id}`,
      telemetry,
      logger
    });
    let collector = null;
    let observation = { events: [] };
    let after = before;
    let transition;
    try {
      if (!observe && page && typeof page.on === 'function') {
        collector = createEventCollector(page, { maxObservationMs: budgets.maxObservationMs, config });
        collector.start();
      }
      await executeSafeAction(page, action, budgets.maxActionMs, { config });
      observation = observe
        ? await observe(page, { maxObservationMs: budgets.maxObservationMs })
        : collector
          ? await collector.observe(budgets.maxObservationMs)
          : await observePage(page, { maxObservationMs: budgets.maxObservationMs, config });
      after = await extractActionPageModel({
        page,
        modelExtractor,
        modelOptions: { ...modelOptions, baseUrl: before.url },
        timeoutMs: budgets.maxObservationMs,
        fallback: before,
        label: `after action ${action.id}`,
        telemetry,
        logger
      });
      transition = validateTransition({ before, after, events: observation.events || observation, action });
      const enqueued = enqueueActionDiscoveries({ frontier, action, before, after, observation });
      if (coverage) {
        for (const event of observation.events || []) coverage.recordEndpoint(event, before.url);
        for (const endpoint of observation.endpoints || []) coverage.recordEndpoint(endpoint, before.url);
        for (const form of after.forms || []) coverage.recordForm(form, after.url || before.url);
        for (const discoveredAction of after.actions || []) coverage.recordAction(discoveredAction, after.url || before.url);
        coverage.recordAction(action, before.url, transition);
        coverage.recordTransition({ actionId: action.id, routeUrl: before.url, transition, enqueuedRoutes: enqueued });
      }
      if (transition.changed) {
        if (telemetry) telemetry.inc('actionsChangedState');
        noProgress = 0;
      } else {
        noProgress += 1;
        if (telemetry) telemetry.inc('actionsNoProgress');
      }
      if (telemetry) telemetry.event('action.attempted', { actionId: action.id, transition });
      results.push({ ok: true, action, before, after, transition, observation, enqueuedRoutes: enqueued });
    } catch (err) {
      if (collector) collector.stop();
      noProgress += 1;
      const blocked = isScopeGuardError(err);
      let recovery = null;
      if (blocked) {
        if (coverage) coverage.recordBlockedAction(action, before && before.url, 'scope_guard', err.details || {});
        if (telemetry) telemetry.event('action.blocked', { actionId: action.id, reason: 'scope_guard', details: err.details || {} });
      } else {
        if (coverage) coverage.recordError(err, { worker: 'action', actionId: action.id });
        if (telemetry) telemetry.error(err, { worker: 'action', actionId: action.id });
        if (before && before.url) {
          recovery = await recoverToRoute(page, before.url, {
            config,
            timeoutMs: Math.min(budgets.maxActionMs, 1000)
          }).catch(recoveryError => ({
            attempted: true,
            ok: false,
            reason: recoveryError && recoveryError.message ? recoveryError.message : String(recoveryError),
            url: before.url
          }));
          if (telemetry) telemetry.event('recovery.action', { actionId: action.id, recovery });
        }
      }
      if (logger) logger.debug('Action failed', action.id, err.message);
      results.push({ ok: false, action, blocked, error: err.message, recovery });
    } finally {
      if (telemetry) telemetry.inc('actionsAttempted');
      if (telemetry) telemetry.addTiming('actionMs', Date.now() - started);
    }
  }
  return results;
}

async function extractActionPageModel({ page, modelExtractor, modelOptions, timeoutMs, fallback, label, telemetry, logger } = {}) {
  const budgetMs = Math.max(100, Number(timeoutMs) > 0 ? Number(timeoutMs) : 800);
  try {
    const model = await withTimeout(
      modelExtractor(page, modelOptions || {}),
      budgetMs,
      `page model ${label || 'action'}`
    );
    return model || fallback || { url: '', links: [], forms: [], actions: [] };
  } catch (err) {
    if (telemetry) telemetry.event('action.pageModel.timeout', { label, error: err && err.message ? err.message : String(err) });
    if (logger && typeof logger.debug === 'function') logger.debug('Action page model extraction failed', label, err.message);
    return fallback || { url: '', links: [], forms: [], actions: [] };
  }
}

function enqueueActionDiscoveries({ frontier, action = {}, before = {}, after = {}, observation = {}, depth = null } = {}) {
  if (!frontier) return { added: 0, source: null };
  const source = `action:${action.id || action.label || action.kind || 'unknown'}`;
  const discoveryDepth = Number.isFinite(Number(depth)) ? Number(depth) : Number(before.depth || 0) + 1;
  let added = 0;
  if (after.url && after.url !== before.url) {
    if (frontier.enqueue(after.url, { depth: discoveryDepth, source })) added += 1;
  }
  added += frontier.enqueueMany(after.links || [], { depth: discoveryDepth, source });
  added += frontier.enqueueMany(observation.links || [], { depth: discoveryDepth, source });
  for (const popup of observation.popups || []) {
    if (!popup || popup.closed === true || popup.inScope !== true || !popup.url) continue;
    if (frontier.enqueue(popup.url, {
      depth: discoveryDepth,
      source: 'owned-child',
      sourceTag: 'owned-child',
      reason: action.id || action.label || action.kind || 'action-popup'
    })) added += 1;
  }
  return { added, source };
}

async function executeSafeAction(page, action, maxActionMs, options = {}) {
  if (!isSafeAction(action, {
    allowBusinessMutation: options.allowBusinessMutation === true,
    allowUnknownRisk: options.allowUnknownRisk === true
  })) throw new Error(`Unsafe action refused: ${action.id || action.label}`);
  const scope = options.scope || scopeFromConfig(options.config || {});
  if (action.href) assertNavigationAllowed(action.href, { config: options.config || {}, scope, kind: 'action' });
  if (page && typeof page.performAction === 'function') {
    await withTimeout(page.performAction(action, { timeout: maxActionMs }), maxActionMs, `action ${action.id}`);
    return;
  }
  if (action.kind === 'click-link' && action.href) {
    const waitUntil = isStaticDocumentUrl(action.href, options.config && options.config.target && options.config.target.baseUrl)
      ? 'commit'
      : 'domcontentloaded';
    await withTimeout(page.goto(action.href, { waitUntil, timeout: maxActionMs }), maxActionMs, `click link ${action.id}`);
    return;
  }
  if (action.locatorPlan && page && typeof page.locator === 'function') {
    if (action.kind === 'type-search') await withTimeout(fillLocator(page, action.locatorPlan, action.value || 'test', { timeout: maxActionMs }), maxActionMs, `fill ${action.id}`);
    else await withTimeout(clickLocator(page, action.locatorPlan, { timeout: maxActionMs }), maxActionMs, `click ${action.id}`);
    return;
  }
  if (action.selector && isGenericSelector(action.selector)) throw new Error(`Unsafe generic selector refused for action ${action.id}: ${action.selector}`);
  if (action.selector && page && typeof page.locator === 'function') {
    const locator = page.locator(action.selector).first();
    if (action.kind === 'type-search' && typeof locator.fill === 'function') {
      await withTimeout(locator.fill(action.value || 'test', { timeout: maxActionMs }), maxActionMs, `fill ${action.id}`);
    } else {
      await withTimeout(locator.click({ timeout: maxActionMs }), maxActionMs, `click ${action.id}`);
    }
    return;
  }
  if (action.selector && page && typeof page.click === 'function') {
    await withTimeout(page.click(action.selector, { timeout: maxActionMs }), maxActionMs, `click ${action.id}`);
    return;
  }
  if (action.kind === 'click-button' || action.kind.startsWith('open-') || action.kind === 'paginate' || action.kind === 'type-search') {
    await withTimeout(clickByText(page, action.label), maxActionMs, `click ${action.id}`);
    return;
  }
  throw new Error(`Unsupported safe action kind: ${action.kind}`);
}

async function clickByText(page, label) {
  if (typeof page.getByRole === 'function') {
    const locator = page.getByRole('button', { name: label || /.*/ });
    await locator.first().click({ timeout: 800 });
    return;
  }
  if (typeof page.evaluate === 'function') {
    return page.evaluate(text => {
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],summary,[aria-expanded],[role="tab"]'));
      const target = buttons.find(el => (el.textContent || el.getAttribute('aria-label') || '').trim() === text) || buttons[0];
      if (!target) throw new Error('button not found');
      target.click();
    }, label);
  }
  throw new Error('page cannot click');
}

function createActionWorker(defaults = {}) {
  return {
    runActionWorker: input => runActionWorker({ ...defaults, ...(input || {}) }),
    runSafeActions: input => runActionWorker({ ...defaults, ...(input || {}) })
  };
}

module.exports = {
  createActionWorker,
  runActionWorker,
  runSafeActions: runActionWorker,
  enqueueActionDiscoveries,
  executeSafeAction,
  clickByText,
  extractActionPageModel,
  resolveActionBudgets
};
