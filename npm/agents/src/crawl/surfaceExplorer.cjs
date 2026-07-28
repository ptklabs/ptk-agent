'use strict';

const { normalizeAction } = require('../browser/actionModel.cjs');
const { extractPageModel } = require('../browser/pageModel.cjs');
const { validateTransition } = require('../browser/transition.cjs');
const { observePage } = require('../browser/eventCollector.cjs');
const { assertNavigationAllowed, isScopeGuardError } = require('../browser/scopeGuard.cjs');
const { dismissCommonOverlays, recoverToRoute } = require('../browser/recovery.cjs');
const { withTimeout } = require('../core/budgets.cjs');
const { enqueueActionDiscoveries, executeSafeAction } = require('./actionWorker.cjs');

const SAFE_EXPANSION_KIND = new Set([
  'open-menu',
  'open-tab',
  'open-accordion',
  'open-modal',
  'type-search'
]);

const TERMINAL_ACTION_RE = /\b(?:buy|checkout|transfer|delete|remove|logout|log out|sign out|signout|purchase|place order|close account)\b/i;
const PAYMENT_MUTATION_RE = /\b(?:submit|send|pay|add|create|save|update|edit|remove|delete)\b.*\b(?:payment|card|account)\b|\b(?:payment|card|account)\b.*\b(?:submit|send|pay|add|create|save|update|edit|remove|delete)\b/i;
const SEMANTIC_EXPANSION_KINDS = new Set(['navigation-toggle', 'menu-toggle', 'tab-toggle', 'accordion-toggle', 'modal-toggle']);

function resolveSurfaceExplorerConfig(config = {}) {
  const crawler = config.crawler || {};
  const raw = config.crawler && config.crawler.surfaceExplorer || {};
  const maxDepth = number(crawler.maxDepth, 5);
  const maxExpansionMs = number(raw.maxExpansionMs, 1000);
  const maxExpansionsPerRoute = number(raw.maxExpansionsPerRoute, 5);
  const maxMenuActionsPerSurface = number(raw.maxMenuActionsPerSurface, 8);
  const maxRouteChangingMenuActions = number(raw.maxRouteChangingMenuActions, 8);
  const maxSurfaceMs = Number(raw.maxSurfaceMs);
  return {
    enabled: raw.enabled === true,
    maxExpansionsPerRoute,
    maxNestedExpansions: number(raw.maxNestedExpansions, maxDepth),
    maxMenuActionsPerSurface,
    maxRouteChangingMenuActions,
    reopenSurfaceBetweenMenuActions: raw.reopenSurfaceBetweenMenuActions !== false,
    maxExpansionMs,
    maxSurfaceMs: Number.isFinite(maxSurfaceMs) && maxSurfaceMs > 0
      ? maxSurfaceMs
      : defaultSurfaceExplorerBudgetMs({
        maxExpansionMs,
        maxExpansionsPerRoute,
        maxMenuActionsPerSurface,
        maxRouteChangingMenuActions
      }),
    maxDepth
  };
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultSurfaceExplorerBudgetMs({
  maxExpansionMs = 1000,
  maxExpansionsPerRoute = 5,
  maxMenuActionsPerSurface = 8,
  maxRouteChangingMenuActions = 8
} = {}) {
  const topLevel = Math.max(1, maxExpansionsPerRoute);
  const nested = Math.max(1, Math.min(maxMenuActionsPerSurface, maxRouteChangingMenuActions));
  return Math.max(maxExpansionMs, maxExpansionMs * (topLevel + nested));
}

function createSurfaceDeadline(config = {}) {
  const budgetMs = Math.max(1, Number(config.maxSurfaceMs) || defaultSurfaceExplorerBudgetMs(config));
  const startedAt = Date.now();
  return {
    budgetMs,
    startedAt,
    elapsedMs() {
      return Math.max(0, Date.now() - startedAt);
    },
    remainingMs(fallback = budgetMs) {
      return Math.max(1, Math.min(Math.max(1, Number(fallback) || budgetMs), budgetMs - this.elapsedMs()));
    },
    expired() {
      return this.elapsedMs() >= budgetMs;
    }
  };
}

function surfaceBudgetResult(action = null, detail = {}) {
  return {
    ok: false,
    skipped: true,
    budgetExhausted: true,
    reason: 'surface_explorer_budget_exhausted',
    action,
    ...detail
  };
}

function isBudgetTimeout(error = {}) {
  return error && error.code === 'ERR_PTK_AGENT_BUDGET_TIMEOUT';
}

async function withSurfaceDeadline(promise, deadline, fallbackMs, label) {
  if (deadline && deadline.expired()) {
    const error = new Error(`${label || 'surface explorer'} budget exhausted`);
    error.code = 'ERR_PTK_AGENT_SURFACE_BUDGET_EXHAUSTED';
    throw error;
  }
  const budgetMs = deadline ? deadline.remainingMs(fallbackMs) : fallbackMs;
  return withTimeout(promise, budgetMs, label || 'surface explorer');
}

async function executeSurfaceAction(page, action, deadline, fallbackMs, config = {}) {
  if (deadline && deadline.expired()) {
    const error = new Error(`surface action ${action && action.id || 'unknown'} budget exhausted`);
    error.code = 'ERR_PTK_AGENT_SURFACE_BUDGET_EXHAUSTED';
    throw error;
  }
  const budgetMs = deadline ? deadline.remainingMs(fallbackMs) : fallbackMs;
  await withTimeout(
    executeSafeAction(page, action, Math.max(1, budgetMs), { config }),
    Math.max(1, budgetMs),
    `surface action ${action && action.id || 'unknown'}`
  );
}

async function runSurfaceExplorer({ page, pageModel, frontier, coverage, config = {}, telemetry = null, logger = null, modelExtractor = extractPageModel, observe = observePage, surfaceState = null } = {}) {
  const explorerConfig = resolveSurfaceExplorerConfig(config);
  if (!explorerConfig.enabled || !pageModel || !page) return [];
  const deadline = createSurfaceDeadline(explorerConfig);
  const attemptedSurfaces = getSurfaceAttemptSet(config, surfaceState);
  const routeDepth = routeDepthForModel(pageModel);
  const candidates = surfaceExpansionCandidates(pageModel, config)
    .filter(candidate => !attemptedSurfaces.has(surfaceAttemptSignature(candidate, pageModel)))
    .slice(0, explorerConfig.maxExpansionsPerRoute);
  const results = [];
  for (const candidate of candidates) {
    if (deadline.expired()) {
      results.push(surfaceBudgetResult(candidate, { depth: routeDepth, elapsedMs: deadline.elapsedMs(), budgetMs: deadline.budgetMs }));
      break;
    }
    attemptedSurfaces.add(surfaceAttemptSignature(candidate, pageModel));
    let before = null;
    let overlayDismissal = null;
    try {
      before = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
        baseUrl: pageModel.url,
        spaHashBaseUrl: config.target && config.target.baseUrl,
        preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
        config,
        browserProbe: config.browserProbe
      }), deadline, explorerConfig.maxExpansionMs, `surface before model ${candidate.id}`), routeDepth);
      if (candidate.href) {
        assertNavigationAllowed(candidate.href, { config, kind: 'surface-expansion' });
      }
      overlayDismissal = await withSurfaceDeadline(dismissCommonOverlays(page, {
        timeoutMs: Math.min(250, explorerConfig.maxExpansionMs)
      }).catch(error => ({ attempted: true, dismissed: 0, reason: error.message || String(error) })), deadline, Math.min(250, explorerConfig.maxExpansionMs), `surface overlay dismissal ${candidate.id}`);
      await executeSurfaceAction(page, candidate, deadline, explorerConfig.maxExpansionMs, config);
      const observation = await withSurfaceDeadline(observe(page, { maxObservationMs: Math.min(explorerConfig.maxExpansionMs, deadline.remainingMs(explorerConfig.maxExpansionMs)), config }), deadline, explorerConfig.maxExpansionMs, `surface observation ${candidate.id}`);
      const after = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
        baseUrl: before.url,
        spaHashBaseUrl: config.target && config.target.baseUrl,
        preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
        config,
        browserProbe: config.browserProbe
      }), deadline, explorerConfig.maxExpansionMs, `surface after model ${candidate.id}`), routeDepth + 1);
      const transition = validateTransition({ before, after, events: observation.events || observation, action: candidate });
      const enqueuedRoutes = enqueueSurfaceRoutes({ frontier, before, after, observation, action: candidate, depth: routeDepth + 1 });
      const nestedResults = explorerConfig.maxNestedExpansions > 0
        ? await exploreNestedSurfaceControls({
          page,
          before,
          after,
          frontier,
          coverage,
          config,
          observe,
          modelExtractor,
          surfaceState,
          surfaceAction: candidate,
          surfaceActionChain: [candidate],
          maxNested: explorerConfig.maxNestedExpansions,
          maxMenuActions: explorerConfig.maxMenuActionsPerSurface,
          maxRouteChangingActions: explorerConfig.maxRouteChangingMenuActions,
          reopenSurfaceBetweenMenuActions: explorerConfig.reopenSurfaceBetweenMenuActions,
          timeoutMs: explorerConfig.maxExpansionMs,
          deadline,
          currentDepth: routeDepth,
          maxDepth: explorerConfig.maxDepth
        }).catch(error => [{ ok: false, error: error.message || String(error), nested: true }])
        : [];
      if (coverage) {
        coverage.recordAction(candidate, before.url, transition);
        coverage.recordTransition({
          actionId: candidate.id,
          routeUrl: before.url,
          transition,
          enqueuedRoutes: addNestedRouteCounts(enqueuedRoutes, nestedResults),
          source: 'surface-expansion'
        });
        for (const event of observation.events || []) coverage.recordEndpoint(event, before.url);
      }
      await closeExpandedSurface(page, Math.min(250, explorerConfig.maxExpansionMs)).catch(() => {});
      const result = {
        ok: true,
        action: candidate,
        before,
        after,
        transition,
        observation,
        enqueuedRoutes,
        nestedResults,
        overlayDismissal
      };
      results.push(result);
      if (telemetry) telemetry.event('surface.expanded', {
        actionId: candidate.id,
        enqueuedRoutes: enqueuedRoutes.added,
        changed: Boolean(transition.changed)
      });
    } catch (err) {
      if (isBudgetTimeout(err) || err.code === 'ERR_PTK_AGENT_SURFACE_BUDGET_EXHAUSTED') {
        results.push(surfaceBudgetResult(candidate, { error: err.message, depth: routeDepth, elapsedMs: deadline.elapsedMs(), budgetMs: deadline.budgetMs }));
        break;
      }
      const blocked = isScopeGuardError(err);
      if (!blocked) {
        const salvaged = await salvageChangedSurfaceAfterActionError({
          page,
          before,
          observationTimeoutMs: explorerConfig.maxExpansionMs,
          modelExtractor,
          observe,
          config,
          action: candidate,
          frontier,
          coverage,
          overlayDismissal,
          originalError: err,
          deadline
        }).catch(() => null);
        if (salvaged && salvaged.ok) {
          results.push(salvaged);
          if (telemetry) telemetry.event('surface.expanded_after_action_error', {
            actionId: candidate.id,
            enqueuedRoutes: salvaged.enqueuedRoutes && salvaged.enqueuedRoutes.added || 0,
            reason: err.message
          });
          continue;
        }
      }
      let recovery = null;
      if (!blocked && before && before.url) {
        recovery = await withSurfaceDeadline(recoverToRoute(page, before.url, {
          config,
          timeoutMs: Math.min(explorerConfig.maxExpansionMs, 1000)
        }), deadline, Math.min(explorerConfig.maxExpansionMs, 1000), `surface recovery ${candidate.id}`).catch(recoveryError => ({
          attempted: true,
          ok: false,
          reason: recoveryError.message || String(recoveryError),
          url: before.url
        }));
      }
      if (coverage && blocked) coverage.recordBlockedAction(candidate, before && before.url, 'scope_guard', err.details || {});
      if (telemetry) telemetry.event(blocked ? 'surface.blocked' : 'surface.failed', { actionId: candidate.id, reason: err.message });
      if (logger && typeof logger.debug === 'function') logger.debug('Surface expansion failed', candidate.id, err.message);
      results.push({ ok: false, action: candidate, blocked, error: err.message, recovery });
    }
  }
  return results;
}

async function exploreNestedSurfaceControls({
  page,
  before = {},
  after = {},
  frontier,
  coverage,
  config = {},
  observe = observePage,
  modelExtractor = extractPageModel,
  surfaceState = null,
  surfaceAction = null,
  surfaceActionChain = null,
  maxNested = 1,
  maxMenuActions = 8,
  maxRouteChangingActions = 8,
  reopenSurfaceBetweenMenuActions = true,
  timeoutMs = 1000,
  deadline = null,
  currentDepth = 0,
  maxDepth = 5
} = {}) {
  if (!page || maxNested <= 0) return [];
  const attempted = getNestedAttemptSet(config, surfaceState);
  const initialSkippedUnsafe = blockedNestedSurfaceActionCandidates(before, after);
  const plan = nestedSurfaceActionCandidates(before, after, config)
    .filter(candidate => !attempted.has(nestedAttemptSignature(candidate)))
    .slice(0, maxMenuActions);
  const results = [];
  for (const skipped of initialSkippedUnsafe) {
    attempted.add(nestedAttemptSignature(skipped));
    results.push({
      ok: false,
      nested: true,
      blocked: true,
      skipped: true,
      reason: 'unsafe_menu_action',
      depth: currentDepth + 1,
      action: skipped
    });
  }
  let routeChangingActions = 0;
  let noProgressActions = 0;
  let executedMenuActions = 0;
  for (const plannedCandidate of plan) {
    if (deadline && deadline.expired()) {
      results.push(surfaceBudgetResult(plannedCandidate, { nested: true, depth: currentDepth + 1, elapsedMs: deadline.elapsedMs(), budgetMs: deadline.budgetMs }));
      break;
    }
    if (routeChangingActions >= maxRouteChangingActions) break;
    if (noProgressActions >= number(config.crawler && config.crawler.maxNoProgressActions, 2)) break;
    const actionDepth = currentDepth + 1;
    if (actionDepth > maxDepth) {
      results.push({
        ok: false,
        nested: true,
        skipped: true,
        reason: 'max_depth',
        depth: actionDepth,
        maxDepth,
        action: plannedCandidate
      });
      continue;
    }
    let candidate = plannedCandidate;
    if (executedMenuActions > 0 && reopenSurfaceBetweenMenuActions && surfaceAction) {
      const reopened = await reopenSurfaceChain({
        page,
        surfaceActionChain: Array.isArray(surfaceActionChain) && surfaceActionChain.length ? surfaceActionChain : [surfaceAction],
        before,
        config,
        observe,
        modelExtractor,
        timeoutMs,
        deadline
      }).catch(error => ({ ok: false, error: error.message || String(error) }));
      if (!reopened.ok) {
        results.push({
          ok: false,
          nested: true,
          action: plannedCandidate,
          error: reopened.error || 'surface_reopen_failed',
          reason: 'surface_reopen_failed'
        });
        continue;
      }
      candidate = findEquivalentNestedCandidate(plannedCandidate, nestedSurfaceActionCandidates(before, reopened.after || after, config))
        || plannedCandidate;
    }
    attempted.add(nestedAttemptSignature(candidate));
    const nestedBefore = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
      baseUrl: before.url,
      spaHashBaseUrl: config.target && config.target.baseUrl,
      preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      config,
      browserProbe: config.browserProbe
    }), deadline, timeoutMs, `nested before model ${candidate.id}`), currentDepth);
    try {
      await executeSurfaceAction(page, candidate, deadline, timeoutMs, config);
      const observation = await withSurfaceDeadline(observe(page, { maxObservationMs: deadline ? deadline.remainingMs(timeoutMs) : timeoutMs, config }), deadline, timeoutMs, `nested surface observation ${candidate.id}`);
      const nestedAfter = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
        baseUrl: nestedBefore.url,
        spaHashBaseUrl: config.target && config.target.baseUrl,
        preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
        config,
        browserProbe: config.browserProbe
      }), deadline, timeoutMs, `nested after model ${candidate.id}`), actionDepth);
      const transition = validateTransition({ before: nestedBefore, after: nestedAfter, events: observation.events || observation, action: candidate });
      const enqueuedRoutes = enqueueActionDiscoveries({ frontier, action: candidate, before: nestedBefore, after: nestedAfter, observation, depth: actionDepth });
      let childResults = [];
      if (!transition.routeChanged && transition.changed && shouldRecurseIntoNestedSurface(candidate, nestedBefore, nestedAfter) && maxNested > 1 && actionDepth <= maxDepth) {
        childResults = await exploreNestedSurfaceControls({
          page,
          before: nestedBefore,
          after: nestedAfter,
          frontier,
          coverage,
          config,
          observe,
          modelExtractor,
          surfaceState,
          surfaceAction: candidate,
          surfaceActionChain: [
            ...(Array.isArray(surfaceActionChain) && surfaceActionChain.length ? surfaceActionChain : surfaceAction ? [surfaceAction] : []),
            candidate
          ],
          maxNested: maxNested - 1,
          maxMenuActions,
          maxRouteChangingActions: Math.max(0, maxRouteChangingActions - routeChangingActions),
          reopenSurfaceBetweenMenuActions,
          timeoutMs,
          deadline,
          currentDepth: actionDepth,
          maxDepth
        }).catch(error => [{ ok: false, error: error.message || String(error), nested: true, depth: actionDepth + 1 }]);
      }
      if (coverage) {
        coverage.recordAction(candidate, nestedBefore.url, transition);
        coverage.recordTransition({ actionId: candidate.id, routeUrl: nestedBefore.url, transition, enqueuedRoutes: addNestedRouteCounts(enqueuedRoutes, childResults), source: 'surface-nested-action', depth: actionDepth });
        for (const event of observation.events || []) coverage.recordEndpoint(event, nestedBefore.url);
      }
      results.push({ ok: true, nested: true, action: candidate, before: nestedBefore, after: nestedAfter, transition, observation, enqueuedRoutes, childResults, depth: actionDepth });
      results.push(...childResults);
      executedMenuActions += 1;
      if (transition.routeChanged || nestedAfter.url && nestedAfter.url !== nestedBefore.url) routeChangingActions += 1;
      routeChangingActions += childResults.filter(result => result.ok && result.transition && result.transition.routeChanged).length;
      if (transition.noProgress || !transition.changed) noProgressActions += 1;
      else noProgressActions = 0;
      if (transition.routeChanged && before.url) {
        await withSurfaceDeadline(recoverToRoute(page, before.url, {
          config,
          timeoutMs: Math.min(timeoutMs, 1000)
        }), deadline, Math.min(timeoutMs, 1000), `nested route recovery ${candidate.id}`).catch(() => {});
      }
    } catch (error) {
      if (isBudgetTimeout(error) || error.code === 'ERR_PTK_AGENT_SURFACE_BUDGET_EXHAUSTED') {
        results.push(surfaceBudgetResult(candidate, { nested: true, depth: actionDepth, error: error.message || String(error), elapsedMs: deadline && deadline.elapsedMs(), budgetMs: deadline && deadline.budgetMs }));
        break;
      }
      results.push({ ok: false, nested: true, action: candidate, error: error.message || String(error) });
    }
  }
  return results;
}

async function reopenSurface({ page, surfaceAction, before = {}, config = {}, observe = observePage, modelExtractor = extractPageModel, timeoutMs = 1000 } = {}) {
  return reopenSurfaceChain({
    page,
    surfaceActionChain: surfaceAction ? [surfaceAction] : [],
    before,
    config,
    observe,
    modelExtractor,
    timeoutMs
  });
}

async function reopenSurfaceChain({ page, surfaceActionChain = [], before = {}, config = {}, observe = observePage, modelExtractor = extractPageModel, timeoutMs = 1000, deadline = null } = {}) {
  const chain = (surfaceActionChain || []).filter(Boolean);
  if (!page || chain.length === 0) return { ok: false, error: 'missing_surface_action' };
  if (before.url) {
    await withSurfaceDeadline(recoverToRoute(page, before.url, {
      config,
      timeoutMs: Math.min(timeoutMs, 1000)
    }), deadline, Math.min(timeoutMs, 1000), 'reopen surface route recovery').catch(() => {});
  }
  await withSurfaceDeadline(closeExpandedSurface(page, Math.min(250, timeoutMs)), deadline, Math.min(250, timeoutMs), 'reopen close expanded surface').catch(() => {});
  let observation = { events: [], links: [] };
  let after = before;
  for (const [index, action] of chain.entries()) {
    await executeSurfaceAction(page, action, deadline, timeoutMs, config);
    observation = await withSurfaceDeadline(observe(page, { maxObservationMs: deadline ? deadline.remainingMs(timeoutMs) : timeoutMs, config }), deadline, timeoutMs, `reopen surface observation ${action.id}`);
    after = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
      baseUrl: before.url,
      spaHashBaseUrl: config.target && config.target.baseUrl,
      preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      config,
      browserProbe: config.browserProbe
    }), deadline, timeoutMs, `reopen surface model ${action.id}`), routeDepthForModel(before) + index + 1);
  }
  return { ok: true, after, observation };
}

function findEquivalentNestedCandidate(planned = {}, candidates = []) {
  const plannedSignature = nestedAttemptSignature(planned);
  return candidates.find(candidate => nestedAttemptSignature(candidate) === plannedSignature)
    || candidates.find(candidate => candidate.selector && planned.selector && candidate.selector === planned.selector)
    || candidates.find(candidate => candidate.id && planned.id && candidate.id === planned.id)
    || null;
}

function routeDepthForModel(model = {}) {
  const value = model.depth !== undefined ? model.depth : model.routeDepth;
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function withRouteDepth(model = {}, depth = 0) {
  if (!model || typeof model !== 'object') return model;
  const normalizedDepth = Number.isFinite(Number(depth)) && Number(depth) >= 0 ? Number(depth) : 0;
  model.depth = normalizedDepth;
  model.routeDepth = normalizedDepth;
  return model;
}

function shouldRecurseIntoNestedSurface(action = {}, before = {}, after = {}) {
  if (!action || !after) return false;
  if (after.url && before.url && after.url !== before.url) return false;
  const kind = String(action.kind || '').toLowerCase();
  const expectedEffect = String(action.expectedEffect || '').toLowerCase();
  const semanticKind = String(action.semanticKind || action.raw && action.raw.semanticKind || '').toLowerCase();
  return kind.startsWith('open-')
    || expectedEffect.includes('surface')
    || expectedEffect.includes('toggle')
    || expectedEffect.includes('modal')
    || SEMANTIC_EXPANSION_KINDS.has(semanticKind)
    || hasExpansionSignal(action, candidateText(action));
}

async function salvageChangedSurfaceAfterActionError({ page, before, observationTimeoutMs, modelExtractor, observe, config, action, frontier, coverage, overlayDismissal, originalError, deadline = null } = {}) {
  if (!before || !page) return null;
  const observation = await withSurfaceDeadline(
    observe(page, { maxObservationMs: observationTimeoutMs, config }),
    deadline,
    observationTimeoutMs,
    `surface salvage observation ${action && action.id || 'unknown'}`
  );
  const depth = routeDepthForModel(before) + 1;
  const after = withRouteDepth(await withSurfaceDeadline(modelExtractor(page, {
    baseUrl: before.url,
    spaHashBaseUrl: config.target && config.target.baseUrl,
    preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
    config,
    browserProbe: config.browserProbe
  }), deadline, observationTimeoutMs, `surface salvage model ${action && action.id || 'unknown'}`), depth);
  const transition = validateTransition({ before, after, events: observation.events || observation, action });
  if (!transition.changed) return null;
  const enqueuedRoutes = enqueueSurfaceRoutes({ frontier, before, after, observation, action, depth });
  if (coverage) {
    coverage.recordAction(action, before.url, transition);
    coverage.recordTransition({
      actionId: action.id,
      routeUrl: before.url,
      transition,
      enqueuedRoutes,
      source: 'surface-expansion',
      depth,
      warning: originalError && originalError.message || null
    });
    for (const event of observation.events || []) coverage.recordEndpoint(event, before.url);
  }
  await withSurfaceDeadline(
    closeExpandedSurface(page, Math.min(250, observationTimeoutMs)),
    deadline,
    Math.min(250, observationTimeoutMs),
    `surface salvage close ${action && action.id || 'unknown'}`
  ).catch(() => {});
  return {
    ok: true,
    action,
    before,
    after,
    transition,
    observation,
    enqueuedRoutes,
    overlayDismissal,
    warning: originalError && originalError.message || null
  };
}

async function closeExpandedSurface(page, timeoutMs = 250) {
  if (!page) return false;
  let attempted = false;
  if (page.keyboard && typeof page.keyboard.press === 'function') {
    await withTimeout(page.keyboard.press('Escape'), timeoutMs, 'close expanded surface').catch(() => {});
    attempted = true;
  }
  if (typeof page.locator === 'function') {
    const locator = page.locator('[class*="backdrop"],[data-backdrop],[role="presentation"]');
    const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
    if (target && typeof target.click === 'function') {
      attempted = await withTimeout(
        target.click({ timeout: Math.min(150, timeoutMs), force: true }).then(() => true).catch(() => false),
        timeoutMs,
        'close surface backdrop'
      );
    }
  }
  if (typeof page.evaluate === 'function') {
    const domResult = await withTimeout(page.evaluate(() => {
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && (element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      };
      const backdrops = Array.from(document.querySelectorAll('[class*="backdrop" i],[data-backdrop],[role="presentation"]'))
        .filter(element => visible(element));
      for (const backdrop of backdrops) {
        const PointerLikeEvent = window.PointerEvent || window.MouseEvent;
        backdrop.dispatchEvent(new PointerLikeEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        backdrop.dispatchEvent(new PointerLikeEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      return { clickedBackdrop: backdrops.length > 0, backdropCount: backdrops.length, dispatchedEscape: true };
    }), timeoutMs, 'close expanded surface').catch(() => null);
    if (page.waitForTimeout && timeoutMs > 25) {
      await withTimeout(page.waitForTimeout(Math.min(75, timeoutMs)), timeoutMs, 'settle closed surface').catch(() => {});
    }
    return attempted || Boolean(domResult && (domResult.clickedBackdrop || domResult.dispatchedEscape));
  }
  return attempted;
}

function surfaceExpansionCandidates(pageModel = {}, config = {}) {
  const rawControls = [
    ...(pageModel.newlyDiscoveredControls || []),
    ...(pageModel.actions || [])
  ];
  const normalized = [];
  const seen = new Set();
  for (const [index, control] of rawControls.entries()) {
    const kind = control.kind || inferExpansionKind(control);
    if (!kind) continue;
    const candidate = normalizeAction({
      ...control,
      kind,
      riskTier: 'safe-interaction',
      expectedEffect: 'surface-expansion',
      source: control.source || 'surface-explorer'
    }, index);
    if (!isSafeExpansion(candidate)) continue;
    if (candidate.href) {
      try {
        assertNavigationAllowed(candidate.href, { config, kind: 'surface-expansion' });
      } catch (_) {
        continue;
      }
    }
    const signature = surfaceAttemptSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    normalized.push({
      ...candidate,
      surfacePriority: surfaceCandidatePriority(candidate)
    });
  }
  return normalized.sort((left, right) => left.surfacePriority - right.surfacePriority || String(left.id).localeCompare(String(right.id)));
}

function inferExpansionKind(control = {}) {
  if (isFormFieldControl(control)) return null;
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  if (semanticKind === 'route-control' || semanticKind === 'pagination-control') return null;
  if (semanticKind === 'navigation-toggle' || semanticKind === 'menu-toggle') return 'open-menu';
  if (semanticKind === 'tab-toggle') return 'open-tab';
  if (semanticKind === 'accordion-toggle') return 'open-accordion';
  if (semanticKind === 'modal-toggle') return 'open-modal';
  const role = String(control.role || '').toLowerCase();
  const tag = String(control.tagName || control.tag || '').toLowerCase();
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  if (role === 'tab') return 'open-tab';
  if (control.opensDialog || hasPopup === 'dialog') return 'open-modal';
  if (tag === 'summary' || control.controlsAccordion) return 'open-accordion';
  if (control.expands || hasAriaExpanded(control) || hasPopup === 'menu') {
    if (tag === 'a' && control.href && !control.expands && !hasAriaExpanded(control) && !hasPopup) return null;
    return 'open-menu';
  }
  return null;
}

function isFormFieldControl(control = {}) {
  if (String(control.semanticKind || '').toLowerCase() === 'form-widget') return true;
  const tag = String(control.tagName || control.tag || '').toLowerCase();
  const role = String(control.role || '').toLowerCase();
  const type = String(control.type || '').toLowerCase();
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  if (['input', 'textarea', 'select', 'option', 'mat-select'].includes(tag)) return true;
  if (role === 'combobox' || role === 'listbox' || hasPopup === 'listbox') return true;
  if (['text', 'email', 'password', 'search', 'number', 'tel', 'url', 'hidden'].includes(type)) return true;
  if (control.formId && !control.expands && !hasAriaExpanded(control) && !control.hasPopup) return true;
  return false;
}

function isToggleLikeControl(control = {}) {
  const tag = String(control.tagName || control.tag || '').toLowerCase();
  const role = String(control.role || '').toLowerCase();
  return ['button', 'a', 'summary'].includes(tag) || ['button', 'menuitem', 'tab', 'link'].includes(role) || Boolean(control.selector || control.testId);
}

function isSafeExpansion(action = {}) {
  const label = `${candidateText(action)} ${action.id || ''} ${action.selector || ''}`.toLowerCase();
  const raw = action.raw || {};
  const rawLabel = `${candidateText(raw)} ${raw.id || ''} ${raw.selector || ''}`.toLowerCase();
  if (isUnsafeSurfaceAction(action, { allowExpansion: true })) return false;
  if (isFormFieldControl(raw) || isFormFieldControl(action)) return false;
  if (!SAFE_EXPANSION_KIND.has(action.kind)) return false;
  if (action.formId || action.kind === 'submit-form') return false;
  if (action.expectedEffect && !/surface|modal|toggle|search|route-change/.test(action.expectedEffect)) return false;
  const rawHasExpansionSignal = hasExpansionSignal(raw, rawLabel);
  if (action.kind === 'open-menu' && !rawHasExpansionSignal) return false;
  if (isSemanticExpansion(action) || isSemanticExpansion(raw)) return true;
  return action.kind !== 'open-menu' || rawHasExpansionSignal || action.hasPopup || action.expands || hasAriaExpanded(action);
}

function hasExpansionSignal(control = {}, label = '') {
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  if (SEMANTIC_EXPANSION_KINDS.has(semanticKind)) return true;
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  if (control.expands || hasAriaExpanded(control) || hasPopup === 'menu' || hasPopup === 'dialog' || control.opensDialog) return true;
  return false;
}

function hasAriaExpanded(control = {}) {
  return control.ariaExpanded !== undefined && control.ariaExpanded !== null && control.ariaExpanded !== '';
}

function isSemanticExpansion(control = {}) {
  return SEMANTIC_EXPANSION_KINDS.has(String(control.semanticKind || '').toLowerCase());
}

function nestedSurfaceActionCandidates(before = {}, after = {}, config = {}) {
  const beforeSignatures = new Set([
    ...(before.newlyDiscoveredControls || []),
    ...(before.actions || [])
  ].map(nestedControlSignature));
  const rawControls = [
    ...(after.newlyDiscoveredControls || []),
    ...(after.actions || [])
  ].filter(control => !beforeSignatures.has(nestedControlSignature(control)));
  const normalized = [];
  const seen = new Set();
  for (const [index, control] of rawControls.entries()) {
    if (!isSafeNestedSurfaceControl(control)) continue;
    const href = resolveControlRoute(control, after.url || before.url);
    const kind = nestedActionKind(control, href);
    const candidate = normalizeAction({
      ...control,
      href,
      kind,
      riskTier: 'safe-interaction',
      expectedEffect: href ? 'route-change' : kind === 'open-menu' ? 'surface-expansion' : 'route-change',
      source: control.source || 'surface-nested-action'
    }, index);
    if (candidate.href) {
      try {
        assertNavigationAllowed(candidate.href, { config, kind: 'surface-nested-action' });
      } catch (_) {
        continue;
      }
    }
    const signature = nestedAttemptSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    normalized.push({
      ...candidate,
      nestedPriority: nestedCandidatePriority(candidate)
    });
  }
  return normalized.sort((left, right) => left.nestedPriority - right.nestedPriority || String(left.id).localeCompare(String(right.id)));
}

function blockedNestedSurfaceActionCandidates(before = {}, after = {}) {
  const beforeSignatures = new Set([
    ...(before.newlyDiscoveredControls || []),
    ...(before.actions || [])
  ].map(nestedControlSignature));
  const blocked = [];
  const seen = new Set();
  const rawControls = [
    ...(after.newlyDiscoveredControls || []),
    ...(after.actions || [])
  ].filter(control => !beforeSignatures.has(nestedControlSignature(control)));
  for (const [index, control] of rawControls.entries()) {
    if (isFormFieldControl(control)) continue;
    if (!isUnsafeSurfaceAction(control, { allowExpansion: true })) continue;
    const candidate = normalizeAction({
      ...control,
      kind: nestedActionKind(control, resolveControlRoute(control, after.url || before.url)),
      riskTier: 'terminal-destructive',
      expectedEffect: 'blocked-unsafe-menu-action',
      source: control.source || 'surface-nested-action'
    }, index);
    const signature = nestedAttemptSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    blocked.push(candidate);
  }
  return blocked;
}

function isSafeNestedSurfaceControl(control = {}) {
  if (!control || isFormFieldControl(control)) return false;
  const text = `${candidateText(control)} ${control.id || ''} ${control.selector || ''} ${control.routeTarget || ''} ${control.href || ''}`.toLowerCase();
  if (isUnsafeSurfaceAction(control, { allowExpansion: true })) return false;
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  const role = String(control.role || '').toLowerCase();
  const tag = String(control.tagName || control.tag || '').toLowerCase();
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  if (semanticKind === 'pagination-control' || semanticKind === 'form-widget') return false;
  if (semanticKind === 'route-control' || SEMANTIC_EXPANSION_KINDS.has(semanticKind)) return true;
  if (role === 'menuitem' || role === 'option') return true;
  if (['button', 'a', 'summary'].includes(tag) && (control.selector || control.href || control.routeTarget)) return true;
  if (hasPopup === 'menu' || hasPopup === 'dialog' || control.expands || hasAriaExpanded(control)) return true;
  return false;
}

function isUnsafeSurfaceAction(control = {}, { allowExpansion = false } = {}) {
  const text = `${candidateText(control)} ${control.id || ''} ${control.selector || ''} ${control.routeTarget || ''} ${control.href || ''}`.toLowerCase();
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  const expansion = SEMANTIC_EXPANSION_KINDS.has(semanticKind)
    || hasPopup === 'menu'
    || hasPopup === 'dialog'
    || control.expands
    || hasAriaExpanded(control);
  if (allowExpansion && expansion) return false;
  if (TERMINAL_ACTION_RE.test(text)) return true;
  if (PAYMENT_MUTATION_RE.test(text)) return true;
  return false;
}

function nestedActionKind(control = {}, href = null) {
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  if (href || semanticKind === 'route-control') return href ? 'click-link' : 'click-button';
  if (semanticKind === 'navigation-toggle' || semanticKind === 'menu-toggle') return 'open-menu';
  if (semanticKind === 'tab-toggle') return 'open-tab';
  if (semanticKind === 'accordion-toggle') return 'open-accordion';
  if (semanticKind === 'modal-toggle') return 'open-modal';
  if (String(control.hasPopup || control.ariaHasPopup || '').toLowerCase() === 'menu' || control.expands || hasAriaExpanded(control)) return 'open-menu';
  return 'click-button';
}

function resolveControlRoute(control = {}, baseUrl = '') {
  const rawRouteTarget = control.routeTarget
    || control.raw && (control.raw.routeTarget || control.raw.dataRoute)
    || control.dataRoute
    || null;
  const raw = rawRouteTarget || control.href || control.url || control.raw && (control.raw.href || control.raw.url) || null;
  if (!raw) return null;
  const isAttributeRouteTarget = Boolean(rawRouteTarget);
  const normalized = resolveSpaAwareRouteTarget(raw, baseUrl, { isAttributeRouteTarget });
  if (normalized) return normalized;
  try {
    return new URL(String(raw), baseUrl || 'http://localhost/').href;
  } catch (_) {
    return null;
  }
}

function resolveSpaAwareRouteTarget(raw, baseUrl = '', { isAttributeRouteTarget = false } = {}) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const base = new URL(baseUrl || 'http://localhost/');
    if ((value.startsWith('#/') || value.startsWith('#!/'))) {
      base.hash = value;
      return base.href;
    }
    if (isAttributeRouteTarget && value.startsWith('/') && isSpaHashUrl(base.href)) {
      base.hash = value;
      return base.href;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isSpaHashUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hash === '#/' || parsed.hash.startsWith('#/') || parsed.hash.startsWith('#!/');
  } catch (_) {
    return false;
  }
}

function nestedCandidatePriority(action = {}) {
  if (action.href) return 0;
  const semanticKind = String(action.semanticKind || action.raw && action.raw.semanticKind || '').toLowerCase();
  if (semanticKind === 'route-control') return 5;
  if (SEMANTIC_EXPANSION_KINDS.has(semanticKind)) return 10;
  if (action.kind && action.kind.startsWith('open-')) return 20;
  return 30;
}

function nestedControlSignature(control = {}) {
  return [
    control.selector || '',
    control.href || '',
    control.routeTarget || '',
    control.semanticKind || '',
    control.id || ''
  ].join('|');
}

function nestedAttemptSignature(action = {}) {
  return [
    action.selector || action.locatorPlan && action.locatorPlan.selector || '',
    action.href || '',
    action.semanticKind || '',
    action.kind || '',
    action.id || ''
  ].join('|');
}

function candidateText(control = {}) {
  return String([
    control.ariaLabel,
    control.title,
    control.label,
    control.text,
    control.name,
    control.id,
    control.selector
  ].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim().toLowerCase();
}

function surfaceCandidatePriority(action = {}) {
  const semanticKind = String(action.semanticKind || action.raw && action.raw.semanticKind || '').toLowerCase();
  const semanticScore = Number(action.semanticScore ?? (action.raw && action.raw.semanticScore));
  if (semanticKind === 'navigation-toggle') return 0 - (Number.isFinite(semanticScore) ? Math.min(semanticScore, 100) / 1000 : 0);
  if (semanticKind === 'tab-toggle' || semanticKind === 'accordion-toggle' || semanticKind === 'modal-toggle') return 20;
  if (semanticKind === 'menu-toggle') return 40 - (Number.isFinite(semanticScore) ? Math.min(semanticScore, 100) / 1000 : 0);
  if (action.kind === 'open-tab' || action.kind === 'open-accordion' || action.kind === 'open-modal') return 20;
  return 60;
}

function getSurfaceAttemptSet(config = {}, surfaceState = null) {
  if (surfaceState && surfaceState.attemptedSignatures instanceof Set) return surfaceState.attemptedSignatures;
  if (!config || typeof config !== 'object') return new Set();
  if (config._surfaceExplorerAttemptedSignatures instanceof Set) return config._surfaceExplorerAttemptedSignatures;
  const set = new Set();
  try {
    Object.defineProperty(config, '_surfaceExplorerAttemptedSignatures', {
      value: set,
      enumerable: false,
      configurable: true
    });
    return set;
  } catch (_) {
    return set;
  }
}

function getNestedAttemptSet(config = {}, surfaceState = null) {
  if (surfaceState) {
    if (!(surfaceState.nestedAttemptedSignatures instanceof Set)) surfaceState.nestedAttemptedSignatures = new Set();
    return surfaceState.nestedAttemptedSignatures;
  }
  if (!config || typeof config !== 'object') return new Set();
  if (config._surfaceExplorerNestedAttemptedSignatures instanceof Set) return config._surfaceExplorerNestedAttemptedSignatures;
  const set = new Set();
  try {
    Object.defineProperty(config, '_surfaceExplorerNestedAttemptedSignatures', {
      value: set,
      enumerable: false,
      configurable: true
    });
    return set;
  } catch (_) {
    return set;
  }
}

function surfaceAttemptSignature(action = {}) {
  const pageModel = arguments.length > 1 && arguments[1] ? arguments[1] : {};
  const semanticKind = String(action.semanticKind || '').toLowerCase();
  const selector = action.selector || action.locatorPlan && action.locatorPlan.selector || '';
  const href = action.href || '';
  const fallbackId = selector || href ? '' : action.id || '';
  return [
    authBucketForPageModel(pageModel),
    semanticKind === 'navigation-toggle' ? 'global-navigation' : pageModel.routeShape || pageModel.url || '',
    action.kind || '',
    semanticKind,
    selector,
    href,
    fallbackId
  ].join('|');
}

function authBucketForPageModel(pageModel = {}) {
  const signals = Array.isArray(pageModel.authSignals) ? pageModel.authSignals : [];
  if (signals.includes('authenticated-text')) return 'authenticated';
  if (signals.includes('login-form') || signals.includes('password-field')) return 'login-required';
  return 'anonymous-or-unknown';
}

function enqueueSurfaceRoutes({ frontier, before = {}, after = {}, observation = {}, action = {}, depth = null } = {}) {
  if (!frontier) return { added: 0, source: 'surface-expansion' };
  const routeDepth = Number.isFinite(Number(depth)) ? Number(depth) : Number(before.depth || 0) + 1;
  let added = 0;
  const source = 'surface-expansion';
  for (const link of after.links || []) {
    if (isUnsafeSurfaceAction({ label: link.text || link.label, href: link.href || link.url })) continue;
    if (frontier.enqueue(link.href || link.url, { depth: routeDepth, source, sourceTag: source, reason: action.id || action.label })) added += 1;
  }
  for (const candidate of after.routeCandidates || []) {
    if (isUnsafeSurfaceAction({ label: candidate.text || candidate.label, href: candidate.href || candidate.url })) continue;
    if (frontier.enqueue(candidate.href || candidate.url, { depth: routeDepth, source, sourceTag: source, reason: action.id || action.label })) added += 1;
  }
  for (const link of observation.links || []) {
    if (isUnsafeSurfaceAction({ label: link.text || link.label, href: link.href || link.url })) continue;
    if (frontier.enqueue(link.href || link.url, { depth: routeDepth, source, sourceTag: source, reason: action.id || action.label })) added += 1;
  }
  for (const popup of observation.popups || []) {
    if (!popup || popup.closed === true || popup.inScope !== true || !popup.url) continue;
    if (frontier.enqueue(popup.url, {
      depth: routeDepth,
      source: 'owned-child',
      sourceTag: 'owned-child',
      reason: action.id || action.label || 'surface-popup'
    })) added += 1;
  }
  return { added, source };
}

function addNestedRouteCounts(enqueuedRoutes = {}, nestedResults = []) {
  const nestedAdded = (nestedResults || []).reduce((sum, result) => sum + (result.enqueuedRoutes && result.enqueuedRoutes.added || 0), 0);
  return {
    ...(enqueuedRoutes || {}),
    added: (enqueuedRoutes && enqueuedRoutes.added || 0) + nestedAdded,
    nestedAdded
  };
}

function buildSurfaceExplorerSummary(routeResults = []) {
  const expansions = [];
  for (const route of routeResults || []) {
    for (const result of route.surfaceResults || []) {
      const nestedAdded = (result.nestedResults || []).reduce((sum, item) => sum + (item.enqueuedRoutes && item.enqueuedRoutes.added || 0), 0);
      expansions.push({
        routeUrl: route.pageModel && route.pageModel.url || route.route && route.route.url || null,
        actionId: result.action && result.action.id || null,
        label: result.action && result.action.label || null,
        ok: Boolean(result.ok),
        blocked: Boolean(result.blocked),
        error: result.error || null,
        warning: result.warning || null,
        enqueuedRoutes: (result.enqueuedRoutes && result.enqueuedRoutes.added || 0) + nestedAdded,
        nestedActions: (result.nestedResults || []).length,
        nestedExecuted: (result.nestedResults || []).filter(item => item.ok).length,
        nestedBlocked: (result.nestedResults || []).filter(item => item.blocked).length,
        nestedNoProgress: (result.nestedResults || []).filter(item => item.transition && item.transition.noProgress).length,
        nestedRoutes: nestedAdded,
        overlaysDismissed: result.overlayDismissal && result.overlayDismissal.dismissed || 0,
        changed: Boolean(result.transition && result.transition.changed)
      });
    }
  }
  return {
    schemaVersion: 'ptk-agent-v2-surface-explorer-summary',
    generatedAt: new Date().toISOString(),
    total: expansions.length,
    expanded: expansions.filter(item => item.ok).length,
    blocked: expansions.filter(item => item.blocked).length,
    routesDiscovered: expansions.reduce((sum, item) => sum + item.enqueuedRoutes, 0),
    expansions
  };
}

function buildAuthSurfaceSummary(routeResults = []) {
  const menuActions = [];
  const blockedUnsafeMenuActions = [];
  const noProgressMenuActions = [];
  let authenticatedSurfacesOpened = 0;
  let routesDiscoveredFromAuthMenus = 0;
  for (const route of routeResults || []) {
    const pageModel = route.pageModel || {};
    for (const result of route.surfaceResults || []) {
      const authenticated = authBucketForPageModel(pageModel) === 'authenticated' || surfaceResultHasAuthenticatedSignal(result);
      if (authenticated && result.ok) authenticatedSurfacesOpened += 1;
      for (const nested of result.nestedResults || []) {
        const record = {
          routeUrl: pageModel.url || route.route && route.route.url || null,
          surfaceActionId: result.action && result.action.id || null,
          actionId: nested.action && nested.action.id || null,
          label: nested.action && nested.action.label || null,
          selector: nested.action && nested.action.selector || nested.action && nested.action.locatorPlan && nested.action.locatorPlan.selector || null,
          ok: Boolean(nested.ok),
          blocked: Boolean(nested.blocked),
          skipped: Boolean(nested.skipped),
          reason: nested.reason || nested.error || null,
          depth: nested.depth !== undefined ? nested.depth : null,
          routeChanged: Boolean(nested.transition && nested.transition.routeChanged),
          enqueuedRoutes: nested.enqueuedRoutes && nested.enqueuedRoutes.added || 0
        };
        menuActions.push(record);
        if (record.blocked) blockedUnsafeMenuActions.push(record);
        if (nested.transition && nested.transition.noProgress) noProgressMenuActions.push(record);
        if (authenticated) routesDiscoveredFromAuthMenus += record.enqueuedRoutes > 0 ? record.enqueuedRoutes : record.routeChanged ? 1 : 0;
      }
    }
  }
  return {
    schemaVersion: 'ptk-agent-v2-auth-surface-summary',
    generatedAt: new Date().toISOString(),
    authenticatedSurfacesOpened,
    menuActionsDiscovered: menuActions.length,
    menuActionsExecuted: menuActions.filter(action => action.ok).length,
    routesDiscoveredFromAuthMenus,
    blockedUnsafeMenuActions,
    noProgressMenuActions,
    menuActions
  };
}

function surfaceResultHasAuthenticatedSignal(result = {}) {
  const nested = result.nestedResults || [];
  return nested.some(item => {
    const text = candidateText(item.action || {});
    return /\b(?:logout|log out|sign out|signout)\b/i.test(text);
  });
}

module.exports = {
  buildAuthSurfaceSummary,
  buildSurfaceExplorerSummary,
  closeExpandedSurface,
  createSurfaceDeadline,
  defaultSurfaceExplorerBudgetMs,
  enqueueSurfaceRoutes,
  isSafeExpansion,
  nestedSurfaceActionCandidates,
  reopenSurfaceChain,
  resolveSurfaceExplorerConfig,
  runSurfaceExplorer,
  surfaceCandidatePriority,
  surfaceExpansionCandidates
};
