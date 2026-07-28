'use strict';

const { createEventCollector, observePage } = require('../browser/eventCollector.cjs');
const { extractPageModel, routeShape } = require('../browser/pageModel.cjs');
const {
  describeStaticDocumentUrl,
  isStaticDocumentUrl,
  scopeFromConfig
} = require('../browser/context.cjs');
const { dismissCommonOverlays } = require('../browser/recovery.cjs');
const { assertNavigationAllowed, isScopeGuardError } = require('../browser/scopeGuard.cjs');
const { withTimeout } = require('../core/budgets.cjs');
const { createCoverageTracker } = require('./coverage.cjs');
const { collectCodeSignals } = require('./codeSignalCollector.cjs');
const {
  contentTypeFromResponse,
  extractSameOriginLinksFromText,
  isTerminalDocumentCandidate,
  readBoundedDocumentText,
  responseStatus,
  shouldTreatAsTerminalDocument,
  summarizeTerminalDocument
} = require('./terminalDocument.cjs');

function resolveCrawlerBudgets(config = {}) {
  const crawler = config.crawler || config;
  return {
    maxRouteMs: Number(crawler.maxRouteMs) > 0 ? Number(crawler.maxRouteMs) : 30000,
    maxObservationMs: Number(crawler.maxObservationMs) >= 0 ? Number(crawler.maxObservationMs) : 800
  };
}

function isTimeoutError(error) {
  return /timed out|timeout/i.test(error && error.message || String(error || ''));
}

function isDownloadStartingError(error) {
  return /download is starting/i.test(error && error.message || String(error || ''));
}

function currentPageUrl(page) {
  try {
    if (page && typeof page.url === 'function') return page.url();
    if (page && typeof page.currentUrl === 'string') return page.currentUrl;
  } catch (_) {}
  return null;
}

function sameOriginUrl(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (_) {
    return false;
  }
}

function equivalentRouteUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin
      && left.pathname === right.pathname
      && left.search === right.search
      && left.hash === right.hash;
  } catch (_) {
    return false;
  }
}

function canSalvageTimedOutNavigation({ page, route, beforeUrl, config = {} } = {}) {
  if (config && config.crawler && config.crawler.salvageTimedOutRoutes === false) return false;
  const currentUrl = currentPageUrl(page);
  if (!currentUrl || currentUrl === 'about:blank') return false;
  if (!sameOriginUrl(currentUrl, route && route.url)) return false;
  if (equivalentRouteUrl(currentUrl, route.url)) return true;
  return Boolean(beforeUrl && currentUrl !== beforeUrl);
}

async function gotoRoute(page, route, maxRouteMs, options = {}) {
  const scope = options.scope || scopeFromConfig(options.config || {});
  assertNavigationAllowed(route.url, { config: options.config || {}, scope, kind: 'navigation' });
  const waitUntil = options.waitUntil || 'domcontentloaded';
  if (page && typeof page.gotoRoute === 'function') {
    return page.gotoRoute(route.url, { waitUntil, timeout: maxRouteMs });
  }
  if (!page || typeof page.goto !== 'function') throw new Error('Route worker requires a Playwright-like page with goto().');
  return page.goto(route.url, { waitUntil, timeout: maxRouteMs });
}

async function fetchTerminalDocumentAfterDownload(page, url, timeoutMs = 2500) {
  const context = page && typeof page.context === 'function' ? page.context() : null;
  const request = (context && context.request) || (page && page.request);
  if (!request || typeof request.get !== 'function') return null;
  const response = await request.get(url, { timeout: timeoutMs });
  const text = response && typeof response.text === 'function'
    ? await response.text().catch(() => '')
    : '';
  return { response, text };
}

function createTerminalPageModel(route, config, extractedLinks = [], metadata = {}) {
  return {
    url: route.url,
    routeShape: routeShape(route.url, {
      preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      spaHashBaseUrl: config && config.target && config.target.baseUrl || route.url
    }),
    title: '',
    surfaceType: 'static-document',
    links: extractedLinks,
    forms: [],
    actions: [],
    metadata: {
      staticDocument: true,
      terminalDocument: true,
      ...metadata
    },
    depth: Number.isFinite(Number(route.depth)) ? Number(route.depth) : 0,
    routeDepth: Number.isFinite(Number(route.depth)) ? Number(route.depth) : 0
  };
}

function createFallbackPageModel(route, config = {}, metadata = {}) {
  const currentUrl = metadata.currentUrl || route.url;
  return {
    url: currentUrl,
    routeShape: routeShape(currentUrl, {
      preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      spaHashBaseUrl: config && config.target && config.target.baseUrl || route.url
    }),
    title: '',
    surfaceType: 'unknown',
    links: [],
    forms: [],
    actions: [],
    visibleTextSummary: '',
    authSignals: [],
    blockers: [],
    routeCandidates: [],
    newlyDiscoveredControls: [],
    interactionGraph: null,
    surfaces: [],
    stateKey: null,
    metadata: {
      fallbackModel: true,
      ...metadata
    },
    depth: Number.isFinite(Number(route.depth)) ? Number(route.depth) : 0,
    routeDepth: Number.isFinite(Number(route.depth)) ? Number(route.depth) : 0
  };
}

async function runRouteWorker({ page, route, frontier, coverage, config, telemetry, logger, observe = null, modelExtractor = extractPageModel } = {}) {
  if (!route || !route.url) throw new Error('runRouteWorker requires route.url.');
  const budgets = resolveCrawlerBudgets(config || {});
  const cov = coverage || createCoverageTracker();
  const started = Date.now();
  const staticDocumentDetail = isStaticDocumentUrl(route.url, config && config.target && config.target.baseUrl)
    ? describeStaticDocumentUrl(route.url, config && config.target && config.target.baseUrl)
    : null;
  const terminalCandidate = isTerminalDocumentCandidate(route.url, config && config.target && config.target.baseUrl);
  const result = {
    route,
    ok: false,
    skipped: false,
    reason: null,
    staticDocument: Boolean(staticDocumentDetail),
    terminalDocument: null,
    finalStatus: null,
    pageModel: null,
    observation: null,
    error: null
  };
  let collector = null;
  let response = null;
  let navigationMs = 0;
  let navigationTimedOut = false;
  let navigationError = null;
  let navigationSalvaged = false;
  let fetchedTerminalDocument = null;
  try {
    if (!observe && page && typeof page.on === 'function') {
      collector = createEventCollector(page, { maxObservationMs: budgets.maxObservationMs, config });
      collector.start();
    }
    const waitUntil = staticDocumentDetail || terminalCandidate ? 'commit' : 'domcontentloaded';
    const beforeUrl = currentPageUrl(page);
    try {
      response = await withTimeout(gotoRoute(page, route, budgets.maxRouteMs, { config, waitUntil }), budgets.maxRouteMs, `goto ${route.url}`);
    } catch (navigationErr) {
      if (isDownloadStartingError(navigationErr)) {
        fetchedTerminalDocument = await fetchTerminalDocumentAfterDownload(page, route.url, budgets.maxRouteMs)
          .catch(() => null);
        if (fetchedTerminalDocument && fetchedTerminalDocument.response) {
          response = fetchedTerminalDocument.response;
          navigationError = navigationErr.message;
          result.navigation = {
            downloadStarted: true,
            fetchedAsTerminalDocument: true,
            requestedUrl: route.url,
            error: navigationError
          };
          if (telemetry) telemetry.event('route.download-terminal-document-fetched', result.navigation);
          if (logger) logger.warn('Route navigation started a download; fetched as terminal document', route.url);
        } else {
          throw navigationErr;
        }
      } else
      if (!isTimeoutError(navigationErr) || !canSalvageTimedOutNavigation({ page, route, beforeUrl, config })) {
        throw navigationErr;
      } else {
        navigationTimedOut = true;
        navigationSalvaged = true;
        navigationError = navigationErr.message;
        result.navigation = {
          timedOut: true,
          salvaged: true,
          requestedUrl: route.url,
          currentUrl: currentPageUrl(page),
          error: navigationError
        };
        if (telemetry) telemetry.event('route.navigation-timeout-salvaged', result.navigation);
        if (logger) logger.warn('Route navigation timed out after commit; salvaging page model', route.url, navigationError);
      }
    }
    navigationMs = Date.now() - started;
    if (telemetry) telemetry.addTiming('navigationMs', navigationMs);

    if (fetchedTerminalDocument) {
      const responseContentType = contentTypeFromResponse(response);
      const terminalDocumentText = String(fetchedTerminalDocument.text || '').slice(0, config && config.crawler && config.crawler.maxTerminalDocumentChars || 12000);
      const extractedTerminalLinks = terminalDocumentText
        ? extractSameOriginLinksFromText(terminalDocumentText, config && config.target && config.target.baseUrl || route.url, {
          preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
          spaHashBaseUrl: config && config.target && config.target.baseUrl || route.url
        })
        : [];
      const pageModel = createTerminalPageModel(route, config, extractedTerminalLinks, {
        downloadNavigation: true,
        navigationError
      });
      result.terminalDocument = summarizeTerminalDocument({
        url: route.url,
        response,
        contentType: responseContentType,
        text: terminalDocumentText,
        extractedLinks: extractedTerminalLinks,
        redactionApplied: true
      });
      result.finalStatus = 'terminal-document';
      result.ok = true;
      result.pageModel = pageModel;
      result.observation = { events: [], endpoints: [], links: [] };
      if (frontier) frontier.enqueueMany(extractedTerminalLinks || [], { depth: (route.depth || 0) + 1, source: 'terminal-document' });
      cov.recordEndpoint({
        type: 'terminal-document',
        method: 'GET',
        url: route.url,
        path: new URL(route.url).pathname,
        status: responseStatus(response),
        resourceType: 'document',
        source: 'terminal-document'
      }, pageModel.url);
      cov.recordRoute(route, pageModel, {
        navigationMs,
        observationMs: 0,
        totalMs: Date.now() - started,
        navigationTimedOut: false,
        navigationSalvaged: false,
        downloadFetched: true
      });
      if (telemetry) {
        telemetry.inc('routesVisited');
        telemetry.counters.routeShapes = cov.routeShapes.size;
        telemetry.counters.endpointsObserved = cov.endpoints.size;
        telemetry.event('route.terminal-document', {
          url: route.url,
          statusCode: result.terminalDocument.statusCode,
          contentType: result.terminalDocument.contentType,
          extractedLinks: result.terminalDocument.extractedLinks.length,
          downloadFetched: true
        });
      }
      result.coverage = cov.snapshot();
      if (collector) collector.stop();
      return result;
    }

    if (!staticDocumentDetail && config && (!config.crawler || config.crawler.dismissOverlays !== false)) {
      const overlay = await dismissCommonOverlays(page, {
        timeoutMs: config.crawler && config.crawler.maxRecoveryMs || Math.min(250, budgets.maxObservationMs)
      }).catch(err => ({ attempted: true, dismissed: 0, reason: err.message }));
      if (overlay && overlay.dismissed > 0) {
        result.recovery = { overlay };
        if (telemetry) telemetry.event('recovery.overlay-dismissed', { url: route.url, overlay });
      }
    }

    const observationStarted = Date.now();
    const observationBudgetMs = staticDocumentDetail
      ? Math.min(budgets.maxObservationMs, 100)
      : budgets.maxObservationMs;
    const observationPhaseBudgetMs = Math.max(250, observationBudgetMs + Math.min(500, observationBudgetMs));
    const observation = await withTimeout(
      observe
        ? observe(page, { maxObservationMs: observationBudgetMs, staticDocument: Boolean(staticDocumentDetail) })
        : collector
          ? collector.observe(observationBudgetMs)
          : observePage(page, { maxObservationMs: observationBudgetMs, config }),
      observationPhaseBudgetMs,
      `observe route ${route.url}`
    ).catch(error => {
      result.observationError = error.message;
      if (telemetry) telemetry.event('route.observation-timeout', {
        url: route.url,
        error: error.message,
        budgetMs: observationPhaseBudgetMs
      });
      return {
        durationMs: Date.now() - observationStarted,
        budgetMs: observationBudgetMs,
        events: [],
        links: [],
        endpoints: [],
        timedOut: true,
        error: error.message
      };
    });
    const observationMs = Date.now() - observationStarted;
    if (telemetry) telemetry.addTiming('observationMs', observationMs);

    const modelBudgetMs = Math.max(250, budgets.maxObservationMs);
    let pageModel = await withTimeout(modelExtractor(page, {
      baseUrl: route.url,
      spaHashBaseUrl: config && config.target && config.target.baseUrl,
      preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
      config,
      browserProbe: config && config.browserProbe
    }), modelBudgetMs, `extract page model ${route.url}`).catch(error => {
      result.modelExtractionError = error.message;
      if (telemetry) telemetry.event('route.page-model-timeout', {
        url: route.url,
        error: error.message,
        budgetMs: modelBudgetMs
      });
      return createFallbackPageModel(route, config, {
        reason: 'page_model_timeout_or_error',
        error: error.message,
        currentUrl: currentPageUrl(page)
      });
    });
    if (navigationTimedOut) {
      pageModel.metadata = {
        ...(pageModel.metadata || {}),
        navigationTimedOut: true,
        navigationSalvaged: true,
        navigationError,
        requestedUrl: route.url
      };
    }
    pageModel.depth = Number.isFinite(Number(route.depth)) ? Number(route.depth) : 0;
    pageModel.routeDepth = pageModel.depth;
    const responseContentType = contentTypeFromResponse(response);
    const shouldReadTerminalText = terminalCandidate
      || /(?:text\/plain|text\/markdown|text\/csv|application\/json|application\/xml|text\/xml|application\/rss\+xml|application\/atom\+xml|application\/x-yaml|text\/yaml)/i.test(String(responseContentType || ''));
    const terminalDocumentText = shouldReadTerminalText
      ? await withTimeout(
        readBoundedDocumentText(page, config && config.crawler && config.crawler.maxTerminalDocumentChars || 12000),
        Math.max(250, budgets.maxObservationMs),
        `read terminal document text ${route.url}`
      ).catch(error => {
        result.terminalDocumentReadError = error.message;
        return '';
      })
      : '';
    const extractedTerminalLinks = terminalDocumentText
      ? extractSameOriginLinksFromText(terminalDocumentText, config && config.target && config.target.baseUrl || route.url, {
        preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
        spaHashBaseUrl: config && config.target && config.target.baseUrl || route.url
      })
      : [];
    const terminalDocument = shouldTreatAsTerminalDocument({
      url: route.url,
      baseUrl: config && config.target && config.target.baseUrl,
      response,
      pageModel
    });
    if (terminalDocument || staticDocumentDetail) {
      pageModel.surfaceType = 'static-document';
      pageModel.links = terminalDocument ? extractedTerminalLinks : [];
      pageModel.forms = [];
      pageModel.actions = [];
      pageModel.metadata = {
        ...(pageModel.metadata || {}),
        staticDocument: true,
        staticDocumentDetail,
        terminalDocument
      };
    }
    if (terminalDocument) {
      result.terminalDocument = summarizeTerminalDocument({
        url: route.url,
        response,
        contentType: responseContentType,
        text: terminalDocumentText,
        extractedLinks: extractedTerminalLinks,
        redactionApplied: true
      });
      result.finalStatus = 'terminal-document';
      if (telemetry) telemetry.event('route.terminal-document', {
        url: route.url,
        statusCode: result.terminalDocument.statusCode,
        contentType: result.terminalDocument.contentType,
        extractedLinks: result.terminalDocument.extractedLinks.length
      });
    }
    if (frontier) {
      if (terminalDocument) {
        frontier.enqueueMany(extractedTerminalLinks || [], { depth: (route.depth || 0) + 1, source: 'terminal-document' });
      } else if (!staticDocumentDetail) {
        frontier.enqueueMany(pageModel.links || [], { depth: (route.depth || 0) + 1, source: 'link' });
        frontier.enqueueMany(observation.links || [], { depth: (route.depth || 0) + 1, source: 'observed-link' });
        frontier.enqueueMany(
          (observation.popups || [])
            .filter(popup => popup && popup.inScope === true && popup.closed !== true)
            .map(popup => popup.url),
          { depth: (route.depth || 0) + 1, source: 'owned-child', sourceTag: 'owned-child' }
        );
      }
    }
    for (const event of observation.events || []) cov.recordEndpoint(event, pageModel.url);
    for (const endpoint of observation.endpoints || []) cov.recordEndpoint(endpoint, pageModel.url);
    if (terminalDocument) {
      cov.recordEndpoint({
        type: 'terminal-document',
        method: 'GET',
        url: route.url,
        path: new URL(route.url).pathname,
        status: responseStatus(response),
        resourceType: 'document',
        source: 'terminal-document'
      }, pageModel.url);
    }
    if (!terminalDocument && !staticDocumentDetail) {
      const codeSignals = await collectCodeSignals({
        page,
        pageUrl: pageModel.url,
        baseUrl: config && config.target && config.target.baseUrl || route.url,
        observation,
        config
      });
      if (codeSignals.enabled) {
        if (frontier && codeSignals.limits && codeSignals.limits.seedRoutes === true) {
          for (const hint of codeSignals.routes || []) {
            frontier.enqueue(hint.url, { depth: (route.depth || 0) + 1, source: 'code-signal' });
          }
        }
        cov.recordCodeSignals(codeSignals, pageModel.url);
        result.codeSignals = codeSignals;
      }
    }
    if (!staticDocumentDetail && !terminalDocument) {
      for (const form of pageModel.forms || []) cov.recordForm(form, pageModel.url);
      for (const action of pageModel.actions || []) cov.recordAction(action, pageModel.url);
    }
    cov.recordRoute(route, pageModel, {
      navigationMs,
      observationMs,
      totalMs: Date.now() - started,
      navigationTimedOut,
      navigationSalvaged
    });

    if (telemetry) {
      telemetry.inc('routesVisited');
      telemetry.counters.routeShapes = cov.routeShapes.size;
      telemetry.counters.endpointsObserved = cov.endpoints.size;
      telemetry.counters.formsDiscovered = cov.forms.size;
      telemetry.counters.actionsDiscovered = cov.actions.size;
      telemetry.event('route.visited', {
        url: pageModel.url,
        routeShape: pageModel.routeShape,
        surfaceType: pageModel.surfaceType,
        staticDocument: Boolean(staticDocumentDetail),
        navigationTimedOut,
        navigationSalvaged
      });
    }
    result.ok = true;
    if (!result.finalStatus && staticDocumentDetail) result.finalStatus = 'no-action-surfaces';
    if (!result.finalStatus) result.finalStatus = 'visited';
    result.pageModel = pageModel;
    result.observation = observation;
    result.coverage = cov.snapshot();
  } catch (err) {
    if (collector) collector.stop();
    result.error = err.message;
    if (isScopeGuardError(err)) {
      result.skipped = true;
      result.reason = 'scope_guard';
      result.finalStatus = 'blocked';
      cov.recordBlockedRoute(route, 'scope_guard', err.details || {});
      if (telemetry) telemetry.event('route.blocked', { route: route.url, reason: 'scope_guard', details: err.details || {} });
    } else {
      result.finalStatus = /timed out/i.test(err.message || '') ? 'timeout' : 'failed';
      cov.recordError(err, { route: route.url, worker: 'route' });
      if (telemetry) telemetry.error(err, { route: route.url, worker: 'route' });
    }
    if (logger) logger.warn('Route worker failed', route.url, err.message);
    result.coverage = cov.snapshot();
  }
  return result;
}

function createRouteWorker(defaults = {}) {
  return {
    visitRoute: input => runRouteWorker({ ...defaults, ...(input || {}) }),
    runRouteWorker: input => runRouteWorker({ ...defaults, ...(input || {}) })
  };
}

module.exports = {
  createRouteWorker,
  runRouteWorker,
  visitRoute: runRouteWorker,
  gotoRoute,
  canSalvageTimedOutNavigation,
  resolveCrawlerBudgets
};
