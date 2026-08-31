'use strict';

const { ARTIFACT_FILENAMES, appendJsonl, createEmptyCoverage, writeJson, writeStandardArtifacts } = require('./artifacts.cjs');
const path = require('path');

class UnsupportedExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsupportedExecutionError';
    this.code = 'ERR_PTK_AGENT_UNSUPPORTED_EXECUTION';
    this.details = details;
  }
}

function determineRequestedMode(options = {}, config = {}) {
  if (options.mode) return options.mode;
  if (options.requestedMode) return options.requestedMode;
  if (options.openOnly) return 'open-only';
  if (options.dryRun) return 'dry-run';
  if (isMacroOnlyRun(config)) return 'macro';
  if (config.agent && config.agent.enabled) return 'agent';
  if (config.scenario && config.scenario.enabled) return 'scenario';
  return 'crawl';
}

function isMacroOnlyRun(config = {}) {
  return Boolean(
    config.scenario
    && config.scenario.enabled
    && config.scenario.file
    && config.scenario.inputType === 'macro'
  );
}

function assertSupportedSkeleton(config = {}, options = {}, handlers = {}) {
  if (options.dryRun) return;
  if (!isMacroOnlyRun(config) && config.agent && config.agent.enabled && typeof handlers.agent !== 'function') {
    throw new UnsupportedExecutionError('agent execution requires an agent handler', {
      requestedMode: 'agent'
    });
  }
  if (config.scenario && config.scenario.enabled && typeof handlers.scenario !== 'function') {
    throw new UnsupportedExecutionError('scenario execution requires a scenario handler', {
      requestedMode: 'scenario'
    });
  }
  if (options.openOnly && typeof handlers.openOnly !== 'function') {
    throw new UnsupportedExecutionError('open-only browser execution requires an openOnly handler', {
      requestedMode: 'open-only'
    });
  }
  if (!options.openOnly && typeof handlers.crawl !== 'function') {
    throw new UnsupportedExecutionError('crawler execution requires a crawl handler', {
      requestedMode: determineRequestedMode(options, config)
    });
  }
}

async function orchestrateRun(context = {}) {
  const config = context.config || {};
  const telemetry = context.telemetry;
  const logger = context.logger;
  const options = context.options || {};
  const handlers = context.handlers || {};
  const requestedMode = determineRequestedMode(options, config);
  const actualMode = options.dryRun ? 'dry-run' : requestedMode;

  if (telemetry && typeof telemetry.setMode === 'function') {
    telemetry.setMode({
      requestedMode,
      actualMode,
      fallbackMode: null,
      fallbackReason: null
    });
  }

  if (options.dryRun) {
    if (logger && typeof logger.info === 'function') {
      logger.info('PTK Agents SDK dry run completed', { requestedMode });
    }
    return {
      status: 'dry-run',
      requestedMode,
      actualMode,
      coverage: createEmptyCoverage(telemetry && telemetry.toSummary ? telemetry.toSummary() : {})
    };
  }

  const effectiveHandlers = {
    ...createDefaultHandlers(),
    ...handlers
  };

  if (options.openOnly) return effectiveHandlers.openOnly(context);
  if (isMacroOnlyRun(config)) return effectiveHandlers.scenario(context);
  if (config.agent && config.agent.enabled) return effectiveHandlers.agent(context);
  if (config.scenario && config.scenario.enabled) return effectiveHandlers.scenario(context);
  return effectiveHandlers.crawl(context);
}

function createOrchestrator(dependencies = {}) {
  return {
    orchestrate(context = {}) {
      return orchestrateRun({
        ...dependencies,
        ...context,
        handlers: {
          ...(dependencies.handlers || {}),
          ...(context.handlers || {})
        }
      });
    }
  };
}

function createDefaultHandlers() {
  return {
    openOnly: openOnlyHandler,
    crawl: crawlHandler,
    scenario: scenarioHandler,
    agent: agentHandler
  };
}

async function openOnlyHandler(context = {}) {
  const { openBrowserTarget } = require('../browser/launcher.cjs');
  const session = await openBrowserTarget(context);
  try {
    return {
      status: 'open-only',
      browser: {
        url: session.url,
        title: session.title,
        ptkBridge: session.ptkBridge,
        summary: session.browserSummary || null
      },
      coverage: {
        ...createEmptyCoverage(context.telemetry && context.telemetry.toSummary ? context.telemetry.toSummary() : {}),
        browser: session.browserSummary || null
      }
    };
  } finally {
    if (session && session.close) await session.close();
  }
}

async function crawlHandler(context = {}) {
  const { openBrowserTarget } = require('../browser/launcher.cjs');
  const { Frontier } = require('../crawl/frontier.cjs');
  const { Coverage } = require('../crawl/coverage.cjs');
  const { runRouteWorker } = require('../crawl/routeWorker.cjs');
  const { runActionWorker } = require('../crawl/actionWorker.cjs');
  const { buildAuthSurfaceSummary, buildSurfaceExplorerSummary, runSurfaceExplorer } = require('../crawl/surfaceExplorer.cjs');
  const { buildBrowserProbeSummary } = require('../browser/browserProbe.cjs');
  const { extractPageModel } = require('../browser/pageModel.cjs');
  const { createFormAttemptLedger, hasValidationFeedback, runFormWorker } = require('../crawl/formWorker.cjs');
  const { createRouteLifecycleRecorder } = require('../crawl/routeLifecycle.cjs');
  const { withTimeout } = require('./budgets.cjs');
  const { createRuntimeSafetyMonitor } = require('./runtimeSafety.cjs');
  const {
    loadSiteMemory,
    recordActionOutcome,
    recordEndpoints,
    recordFormOutcome,
    recordRouteOutcome,
    resolveMemoryConfig,
    saveSiteMemory,
    seedFrontierFromMemory,
    summarizeSiteMemory
  } = require('../memory/siteMemory.cjs');
  const {
    seedFrontierFromAnalysisEvidence
  } = require('../evidence/analysisEvidenceAdapter.cjs');
  const config = context.config;
  const telemetry = context.telemetry;
  const logger = context.logger;
  const ownSession = !context.page && !context.session;
  const session = context.page
    ? { page: context.page, close: async () => {} }
    : context.session || await openBrowserTarget(context);
  const lifecycle = createRouteLifecycleRecorder({
    onEvent: event => appendJsonl(config.artifacts && config.artifacts.outputDir || '.ptk/artifacts', ARTIFACT_FILENAMES.routeLifecycleEvents, event)
  });
  const runtimeSafety = createRuntimeSafetyMonitor({ config, telemetry, lifecycle });
  const routeWorker = context.runRouteWorker || runRouteWorker;
  const frontier = new Frontier({
    baseUrl: config.target.baseUrl,
    include: config.target.scope.include,
    exclude: config.target.scope.exclude,
    maxRoutes: config.crawler.maxRoutes,
    maxDepth: config.crawler.maxDepth,
    preserveSpaHashRoutes: config.crawler.preserveSpaHashRoutes,
    allowSessionDestructiveRoutes: Boolean(config.agent && config.agent.allowDestructiveActions),
    onEvent: event => lifecycle.emit(event.type, event)
  });
  const coverage = new Coverage();
  const analysisEvidence = resolveAnalysisEvidenceForRun(config, context);
  let analysisSeed = null;
  const memoryConfig = resolveMemoryConfig(config);
  const memoryLoad = loadSiteMemory(config, {
    cwd: context.options && context.options.cwd || process.cwd()
  });
  const siteMemory = memoryLoad.memory;
  Object.defineProperty(config, '_siteMemory', {
    value: siteMemory,
    enumerable: false,
    configurable: true
  });
  const formAttemptLedger = context.formAttemptLedger || createFormAttemptLedger();
  const surfaceExplorerState = context.surfaceExplorerState || { attemptedSignatures: new Set() };
  runtimeSafety.start({
    phase: 'crawl',
    browser: session.browserSummary || null
  });
  const ptkStart = context.skipPtkCollection ? null : context.ptkLifecycleStart || await beginPtkScan(session.page, {
    config,
    telemetry,
    logger,
    moduleResolution: context.options && context.options.moduleResolution || null
  });
  const scenarioAuthIntent = context.scenarioAuthIntent !== undefined
    ? Boolean(context.scenarioAuthIntent)
    : hasScenarioAuthIntent(config, context.options || {});
  const startUrls = Array.isArray(context.startUrls) && context.startUrls.length
    ? context.startUrls
    : [config.target.baseUrl];
  for (const [index, startUrl] of startUrls.entries()) {
    frontier.enqueue(startUrl, { depth: 0, source: index === 0 ? 'target' : 'start' });
  }
  const routeHints = [
    ...resolveScenarioRouteHints(config, context.options || {}),
    ...(context.extraRoutes || context.options && context.options.extraRoutes || [])
  ];
  for (const hint of routeHints) {
    frontier.enqueue(resolveRouteHint(config.target.baseUrl, hint), { depth: 0, source: 'hint' });
  }
  if (hasAnalysisEvidence(analysisEvidence)) {
    analysisSeed = seedFrontierFromAnalysisEvidence(frontier, analysisEvidence, config);
    if (telemetry) telemetry.event('analysis.seeded', {
      candidates: analysisSeed.candidates,
      added: analysisSeed.added,
      skipped: analysisSeed.skipped.length,
      routeHints: analysisEvidence.counts.routeHints,
      endpoints: analysisEvidence.counts.endpoints,
      graphqlOperations: analysisEvidence.counts.graphqlOperations,
      hiddenParams: analysisEvidence.counts.hiddenParams
    });
  }
  const memorySeed = seedFrontierFromMemory(frontier, siteMemory, config);
  if (telemetry) telemetry.event('memory.seeded', {
    mode: memoryConfig.mode,
    loaded: Boolean(memoryLoad.loaded),
    added: memorySeed.added,
    skipped: memorySeed.skipped,
    candidates: memorySeed.candidates
  });
  const routeResults = [];
  let memorySave = null;
  try {
    while (!frontier.isEmpty() && coverage.routeCount() < config.crawler.maxRoutes) {
      const frontierBefore = frontier.stats();
      const route = frontier.dequeue();
      const routeStartedAt = Date.now();
      const routeDeadline = createRoutePhaseDeadline(routeStartedAt, runtimeSafety.routeWatchdogMs);
      lifecycle.emit('route_started', {
        routeUrl: route.url,
        routeShape: route.routeShape,
        source: route.source,
        sourceTag: route.sourceTag,
        priority: route.priority,
        frontierBefore
      });
      runtimeSafety.routeStarted(route, { frontierBefore });
      let routeWasFinalized = false;
      let routeTimedOut = false;
      let stopAfterRouteTimeout = false;
      try {
        await withTimeout((async () => {
          lifecycle.emit('route_worker_started', {
            routeUrl: route.url
          });
          const routeResult = await routeWorker({ page: session.page, route, frontier, coverage, config, telemetry, logger });
          if (routeTimedOut) return;
          lifecycle.emit('route_worker_completed', {
            routeUrl: route.url,
            durationMs: Date.now() - routeStartedAt,
            ok: Boolean(routeResult && routeResult.ok),
            finalStatus: routeResult && routeResult.finalStatus || null
          });
          routeResults.push(routeResult);
          lifecycle.emit('route_classified', {
            routeUrl: route.url,
            finalStatus: routeResult.finalStatus || null,
            staticDocument: Boolean(routeResult.staticDocument),
            terminalDocument: Boolean(routeResult.terminalDocument),
            reason: routeResult.reason || routeResult.error || null
          });
          if (routeResult.pageModel) runtimeSafety.inspectPageModel(routeResult.pageModel);
          if (routeResult.terminalDocument) {
            lifecycle.emit('terminal_document_detected', {
              routeUrl: route.url,
              terminalDocument: routeResult.terminalDocument
            });
            lifecycle.emit('surface_exploration_skipped', {
              routeUrl: route.url,
              reason: 'terminal_document'
            });
          }
          recordRouteOutcome(siteMemory, routeResult, config);
          recordEndpoints(siteMemory, routeResult.observation && routeResult.observation.events || [], routeResult.pageModel && routeResult.pageModel.url || route.url, config);
          let formResults = [];
          let surfaceResults = [];
          if (!routeResult.terminalDocument && routeResult.ok && routeResult.pageModel && config.crawler.surfaceExplorer && config.crawler.surfaceExplorer.enabled !== false) {
            if (!routeDeadline.hasBudget(config.crawler.surfaceExplorer.maxExpansionMs + config.crawler.maxObservationMs + 500)) {
              lifecycle.emit('surface_exploration_skipped', {
                routeUrl: route.url,
                reason: 'route_budget_remaining_too_low',
                remainingMs: routeDeadline.remainingMs()
              });
            } else {
            lifecycle.emit('surface_exploration_started', {
              routeUrl: route.url,
              remainingMs: routeDeadline.remainingMs()
            });
            surfaceResults = await runSurfaceExplorer({
              page: session.page,
              pageModel: routeResult.pageModel,
              frontier,
              coverage,
              config,
              telemetry,
              logger,
              surfaceState: surfaceExplorerState
            });
            if (routeTimedOut) return;
            if (routeResult) routeResult.surfaceResults = surfaceResults;
            lifecycle.emit('surface_exploration_completed', {
              routeUrl: route.url,
              attempted: surfaceResults.length,
              budgetExhausted: surfaceResults.some(result => result && result.budgetExhausted),
              remainingMs: routeDeadline.remainingMs()
            });
            }
          }
          if (!routeResult.terminalDocument && routeResult.ok && routeResult.pageModel && config.crawler.maxFormsPerRoute > 0) {
            const formConfig = configForAffordablePhase(config, routeDeadline, {
              countField: 'maxFormsPerRoute',
              count: config.crawler.maxFormsPerRoute,
              attemptMs: config.crawler.maxActionMs + config.crawler.maxObservationMs + 50
            });
            lifecycle.emit('forms_started', {
              routeUrl: route.url,
              candidateCount: (routeResult.pageModel.forms || []).length,
              allowedAttempts: formConfig.allowedCount,
              remainingMs: routeDeadline.remainingMs()
            });
            if (formConfig.allowedCount > 0) {
              formResults = await runNormalCrawlFormHooks({
                page: session.page,
                pageModel: routeResult.pageModel,
                routeResult,
                coverage,
                config: formConfig.config,
                telemetry,
                logger,
                frontier,
                scenarioAuthIntent,
                formAttemptLedger,
                runFormWorker,
                hasValidationFeedback,
                siteMemory
              });
            }
            if (routeTimedOut) return;
            lifecycle.emit('forms_completed', {
              routeUrl: route.url,
              attempted: formResults.length,
              submitted: formResults.filter(result => result.submitted).length,
              skipped: formResults.filter(result => result.skipped).length,
              budgetSkipped: formConfig.allowedCount === 0,
              remainingMs: routeDeadline.remainingMs()
            });
          }
          const formChangedPage = formResults.some(result => result.submitted && result.transition && result.transition.changedState);
          const formNoProgress = formResults.some(result => result.submitted && (result.invalid || result.noProgress || result.transition && result.transition.noProgress));
          if (!routeResult.terminalDocument && formChangedPage && routeResult.ok && config.crawler.surfaceExplorer && config.crawler.surfaceExplorer.enabled !== false) {
            const postFormModel = await withTimeout(extractPageModel(session.page, {
              baseUrl: routeResult.pageModel && routeResult.pageModel.url || route.url,
              spaHashBaseUrl: config.target && config.target.baseUrl,
              preserveSpaHashRoutes: config.crawler && config.crawler.preserveSpaHashRoutes !== false,
              config,
              browserProbe: config.browserProbe
            }), config.crawler.maxObservationMs || 800, `post-form page model ${route.url}`).catch(error => {
              runtimeSafety.recordStatus('runtime_stalled', {
                reason: 'page_model_extraction_timeout_or_error',
                routeUrl: route.url,
                error: error.message
              });
              return null;
            });
            if (postFormModel) {
              runtimeSafety.inspectPageModel(postFormModel);
              const postSurfaceResults = await runSurfaceExplorer({
                page: session.page,
                pageModel: postFormModel,
                frontier,
                coverage,
                config,
                telemetry,
                logger,
                surfaceState: surfaceExplorerState
              });
              if (routeTimedOut) return;
              surfaceResults = surfaceResults.concat(postSurfaceResults);
              routeResult.surfaceResults = surfaceResults;
            }
          }
          if (!routeResult.terminalDocument && !formChangedPage && !formNoProgress && routeResult.ok && routeResult.pageModel && config.crawler.maxActionsPerRoute > 0) {
            const actionConfig = configForAffordablePhase(config, routeDeadline, {
              countField: 'maxActionsPerRoute',
              count: config.crawler.maxActionsPerRoute,
              attemptMs: config.crawler.maxActionMs + config.crawler.maxObservationMs + 50
            });
            lifecycle.emit('actions_started', {
              routeUrl: route.url,
              candidateCount: (routeResult.pageModel.actions || []).length,
              allowedAttempts: actionConfig.allowedCount,
              remainingMs: routeDeadline.remainingMs()
            });
            const actionResults = actionConfig.allowedCount > 0
              ? await runActionWorker({ page: session.page, pageModel: routeResult.pageModel, frontier, coverage, config: actionConfig.config, telemetry, logger })
              : [];
            if (routeTimedOut) return;
            for (const actionResult of actionResults || []) recordActionOutcome(siteMemory, actionResult, config);
            routeResult.actionResults = actionResults || [];
            lifecycle.emit('actions_completed', {
              routeUrl: route.url,
              attempted: (actionResults || []).length,
              changed: (actionResults || []).filter(result => result.transition && result.transition.changed).length,
              noProgress: (actionResults || []).filter(result => result.transition && result.transition.noProgress).length,
              budgetSkipped: actionConfig.allowedCount === 0,
              remainingMs: routeDeadline.remainingMs()
            });
          } else if (formNoProgress) {
            lifecycle.emit('actions_completed', {
              routeUrl: route.url,
              attempted: 0,
              skipped: true,
              reason: 'form_no_progress_or_invalid'
            });
          } else if (routeResult.terminalDocument) {
            lifecycle.emit('forms_completed', {
              routeUrl: route.url,
              attempted: 0,
              submitted: 0,
              skipped: 0,
              budgetSkipped: true,
              reason: 'terminal_document'
            });
            lifecycle.emit('actions_completed', {
              routeUrl: route.url,
              attempted: 0,
              skipped: true,
              reason: 'terminal_document'
            });
          }
          const finalStatus = resolveRouteFinalStatus(routeResult, formResults, routeResult.actionResults || [], surfaceResults);
          routeResult.finalStatus = finalStatus;
          lifecycle.finalize(route, finalStatus, {
            durationMs: Date.now() - routeStartedAt,
            routeShape: route.routeShape || routeResult.pageModel && routeResult.pageModel.routeShape,
            reason: routeResult.reason || routeResult.error || finalStatus,
            terminalDocument: routeResult.terminalDocument,
            forms: summarizeRouteForms(formResults),
            actions: summarizeRouteActions(routeResult.actionResults || [])
          });
          routeWasFinalized = true;
          runtimeSafety.routeFinalized(route, finalStatus, {
            durationMs: Date.now() - routeStartedAt,
            reason: routeResult.reason || routeResult.error || finalStatus
          });
        })(), runtimeSafety.routeWatchdogMs, `crawler route ${route.url}`, {
          operation: 'crawler-route-lifecycle',
          source: 'runtime.routeWatchdog',
          budgetMs: runtimeSafety.routeWatchdogMs
        });
      } catch (error) {
        const timedOut = error && error.code === 'ERR_PTK_AGENT_BUDGET_TIMEOUT';
        const finalStatus = timedOut ? 'timeout' : 'failed';
        const reason = timedOut ? 'route_timeout' : 'runtime_stalled';
        routeTimedOut = timedOut;
        if (timedOut) {
          runtimeSafety.recordRouteTimeout(route, error, {
            budgetMs: runtimeSafety.routeWatchdogMs,
            elapsedMs: Date.now() - routeStartedAt
          });
          stopAfterRouteTimeout = false;
        } else {
          runtimeSafety.recordStatus('runtime_stalled', {
            routeUrl: route.url,
            error: error && error.message || String(error || 'route failure')
          });
        }
        const routeResult = {
          route,
          ok: false,
          finalStatus,
          reason,
          error: error && error.message || String(error || reason),
          routeWatchdog: timedOut ? {
            budgetMs: runtimeSafety.routeWatchdogMs,
            elapsedMs: Date.now() - routeStartedAt
          } : null
        };
        routeResults.push(routeResult);
        if (!routeWasFinalized) {
          lifecycle.finalize(route, finalStatus, {
            durationMs: Date.now() - routeStartedAt,
            routeShape: route.routeShape,
            reason,
            terminalDocument: null,
            forms: null,
            actions: null
          });
          runtimeSafety.routeFinalized(route, finalStatus, {
            durationMs: Date.now() - routeStartedAt,
            reason
          });
          routeWasFinalized = true;
        }
        if (coverage && typeof coverage.recordError === 'function') coverage.recordError(error, { route: route.url, phase: 'route-lifecycle' });
        if (telemetry && typeof telemetry.error === 'function') telemetry.error(error, { route: route.url, phase: 'route-lifecycle' });
      }
      if (stopAfterRouteTimeout) break;
    }
    const coverageSnapshot = coverage.snapshot();
    if (hasAnalysisEvidence(analysisEvidence)) {
      coverageSnapshot.analysisEvidence = {
        ...analysisEvidence,
        frontierSeed: analysisSeed || {
          candidates: 0,
          added: 0,
          skipped: [],
          routeHints: []
        }
      };
    }
    memorySave = saveSiteMemory(siteMemory, config, {
      cwd: context.options && context.options.cwd || process.cwd(),
      filePath: memoryLoad.filePath
    });
    coverageSnapshot.siteMemory = summarizeSiteMemory(siteMemory, {
      ...memoryLoad,
      mode: memoryConfig.mode
    }, memorySave);
    coverageSnapshot.routeLifecycle = lifecycle.snapshot();
    coverageSnapshot.routeStatusSummary = lifecycle.statusSummary();
    coverageSnapshot.terminalDocumentSummary = lifecycle.terminalDocumentSummary();
    coverageSnapshot.formAttemptSummary = buildFormAttemptSummary(routeResults);
    coverageSnapshot.routeSourceSummary = buildRouteSourceSummary(frontier, coverageSnapshot);
    coverageSnapshot.browserProbeSummary = buildBrowserProbeSummary(routeResults.map(result => result.pageModel && result.pageModel.probe ? {
      routeCandidates: result.pageModel.routeCandidates || [],
      newlyDiscoveredControls: result.pageModel.newlyDiscoveredControls || [],
      events: result.pageModel.probe.events || []
    } : null).filter(Boolean));
    coverageSnapshot.surfaceExplorerSummary = buildSurfaceExplorerSummary(routeResults);
    coverageSnapshot.authSurfaceSummary = buildAuthSurfaceSummary(routeResults);
    coverageSnapshot.stateKeySummary = buildStateKeySummary(routeResults);
    if (session.browserSummary) {
      coverageSnapshot.browser = session.browserSummary;
    }
    const runtimeSnapshots = runtimeSafety.snapshot({
      status: 'completed',
      browser: session.browserSummary || null
    });
    coverageSnapshot.runHeartbeat = runtimeSnapshots.runHeartbeat;
    coverageSnapshot.browserRuntimeSummary = runtimeSnapshots.browserRuntimeSummary;
    runtimeSafety.writeHeartbeat(coverageSnapshot.runHeartbeat);
    runtimeSafety.writeBrowserRuntimeSummary(coverageSnapshot.browserRuntimeSummary);
    const ptk = context.skipPtkCollection ? null : await collectPtkEvidence(session.page, { config, telemetry, logger, lifecycleStart: ptkStart });
    if (ptk) {
      coverageSnapshot.ptk = ptk;
    }
    const result = {
      status: 'completed',
      routes: routeResults,
      coverage: coverageSnapshot
    };
    if (context.keepSession) {
      Object.defineProperty(result, 'session', {
        value: session,
        enumerable: false
      });
    }
    return result;
  } catch (error) {
    runtimeSafety.flushOnFailure(error, {
      phase: 'crawl',
      status: 'failed',
      browser: session.browserSummary || null
    });
    throw error;
  } finally {
    if (!memorySave) {
      try {
        saveSiteMemory(siteMemory, config, {
          cwd: context.options && context.options.cwd || process.cwd(),
          filePath: memoryLoad.filePath
        });
      } catch (_) {}
    }
    if (ownSession && !context.keepSession && session && session.close) await session.close();
  }
}

function normalCrawlFormCandidates(pageModel = {}, config = {}, options = {}) {
  const maxForms = Number(config.crawler && config.crawler.maxFormsPerRoute);
  if (!Number.isFinite(maxForms) || maxForms <= 0) return [];
  const formPolicy = config.crawler && config.crawler.forms || {};
  if (formPolicy.enabled === false) return [];
  return (pageModel.forms || [])
    .filter(form => {
      if (!form) return false;
      if (isDestructiveForm(form)) return false;
      if (form.kind === 'search') return formPolicy.allowSearch !== false;
      if (form.kind === 'contact') return formPolicy.allowContact !== false;
      if (form.kind === 'feedback') return formPolicy.allowFeedback !== false;
      if (form.kind === 'login') return options.scenarioAuthIntent === true || formPolicy.allowAuth === true;
      if (form.kind === 'generic') return formPolicy.allowBusinessMutation === true;
      return false;
    })
    .slice(0, maxForms);
}

function createRoutePhaseDeadline(startedAtMs, budgetMs) {
  const start = Number(startedAtMs) || Date.now();
  const budget = Math.max(1, Number(budgetMs) || 1);
  return {
    budgetMs: budget,
    elapsedMs() {
      return Math.max(0, Date.now() - start);
    },
    remainingMs() {
      return Math.max(0, budget - this.elapsedMs());
    },
    hasBudget(minimumMs = 1, reserveMs = 50) {
      return this.remainingMs() > Math.max(1, Number(minimumMs) || 1) + Math.max(0, Number(reserveMs) || 0);
    }
  };
}

function configForAffordablePhase(config = {}, deadline, {
  countField,
  count = 0,
  attemptMs = 1,
  reserveMs = 250
} = {}) {
  const originalCount = Math.max(0, Number(count) || 0);
  if (!deadline || originalCount <= 0) return { config, allowedCount: originalCount };
  const availableMs = Math.max(0, deadline.remainingMs() - Math.max(0, Number(reserveMs) || 0));
  const perAttemptMs = Math.max(1, Number(attemptMs) || 1);
  const allowedCount = Math.max(0, Math.min(originalCount, Math.floor(availableMs / perAttemptMs)));
  if (allowedCount === originalCount) return { config, allowedCount };
  return {
    allowedCount,
    config: {
      ...config,
      crawler: {
        ...(config.crawler || {}),
        [countField]: allowedCount
      }
    }
  };
}

function hasScenarioAuthIntent(config = {}, options = {}) {
  if (!config.scenario || !config.scenario.enabled || !config.scenario.file) return false;
  try {
    const { loadScenarioFile } = require('../scenario/scenarioCompiler.cjs');
    const compiled = loadScenarioFile(resolveScenarioFile(config, options));
    return hasScenarioAuthStep(compiled.scenario);
  } catch (_) {
    return false;
  }
}

function hasScenarioAuthStep(scenario = {}) {
  return (scenario.steps || []).some(step => {
    if (!step) return false;
    if (step.type === 'auth') return true;
    const target = step.target && typeof step.target === 'object'
      ? Object.values(step.target).join(' ')
      : step.target;
    const text = `${step.id || ''} ${step.type || ''} ${step.formId || ''} ${target || ''}`.toLowerCase();
    return /\blogin|sign[ -]?in|auth\b/.test(text);
  });
}

async function runNormalCrawlFormHooks({
  page,
  pageModel,
  routeResult,
  coverage,
  config,
  telemetry,
  logger,
  frontier,
  scenarioAuthIntent,
  formAttemptLedger,
  runFormWorker,
  hasValidationFeedback,
  siteMemory
} = {}) {
  const { recordEndpoints, recordFormOutcome } = require('../memory/siteMemory.cjs');
  const candidates = normalCrawlFormCandidates(pageModel, config, { scenarioAuthIntent });
  if (candidates.length === 0) return [];
  const results = [];
  for (const form of candidates) {
    try {
      const result = await runFormWorker({
        page,
        form,
        profile: config.profile || {},
        config,
        telemetry,
        authIntent: form.kind === 'login' && (scenarioAuthIntent || config.crawler && config.crawler.forms && config.crawler.forms.allowAuth === true)
          ? { kind: 'auth.login' }
          : null,
        submissionLedger: formAttemptLedger
      });
      const record = {
        formId: result.formId,
        submitted: Boolean(result.submitted),
        skipped: Boolean(result.skipped),
        reason: result.reason || null,
        invalid: hasValidationFeedback(result.validationFeedback),
        noProgress: Boolean(result.transition && result.transition.noProgress),
        transition: result.transition || null,
        attemptKey: result.plan && result.plan.signature || null,
        failureReason: result.reason || (hasValidationFeedback(result.validationFeedback) ? 'validation_feedback' : result.transition && result.transition.noProgress ? 'no_progress' : null)
      };
      results.push(record);
      recordFormOutcome(siteMemory, {
        ...record,
        validationFeedback: result.validationFeedback || null
      }, pageModel.url, config);
      recordEndpoints(siteMemory, result.observation && result.observation.events || [], pageModel.url, config);
      if (routeResult) {
        if (!routeResult.formResults) routeResult.formResults = [];
        routeResult.formResults.push(record);
      }
      if (coverage && result.transition) coverage.recordTransition(result.transition);
      for (const event of result.observation && result.observation.events || []) {
        if (coverage) coverage.recordEndpoint(event, pageModel.url);
      }
      if (frontier && result.after) {
        const source = `form:${form.id || form.selector || form.kind || 'unknown'}`;
        const depth = (routeResult && routeResult.route && routeResult.route.depth || 0) + 1;
        if (result.after.url && result.after.url !== pageModel.url) {
          frontier.enqueue(result.after.url, { depth, source });
        }
        frontier.enqueueMany(result.after.links || [], { depth, source });
        frontier.enqueueMany(
          (result.observation && result.observation.popups || [])
            .filter(popup => popup && popup.inScope === true && popup.closed !== true)
            .map(popup => popup.url),
          { depth, source: 'owned-child', sourceTag: 'owned-child', reason: form.id || form.kind || 'form-popup' }
        );
        const authRetry = enqueuePostAuthRetry({
          frontier,
          form,
          result,
          pageModel,
          routeResult,
          hasValidationFeedback
        });
        if (authRetry.authSucceeded) {
          record.authSucceeded = true;
          record.authRetryQueued = authRetry.queued;
          record.authRetryUrl = authRetry.url || null;
          record.authRetrySource = authRetry.source || null;
          record.authRetryReason = authRetry.reason || null;
          if (telemetry) telemetry.event('auth.retry', authRetry);
        }
      }
    } catch (err) {
      const context = { route: pageModel.url, formId: form.id, worker: 'form' };
      if (coverage) coverage.recordError(err, context);
      if (telemetry) telemetry.error(err, context);
      if (logger && typeof logger.warn === 'function') logger.warn('Form worker failed', form.id, err.message);
      results.push({ formId: form.id, submitted: false, skipped: true, reason: err.message });
      recordFormOutcome(siteMemory, { formId: form.id, submitted: false, skipped: true, reason: err.message }, pageModel.url, config);
    }
  }
  return results;
}

function isLoginLikeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return /\b(login|signin|sign-in|auth)\b/i.test(`${parsed.pathname} ${parsed.hash}`);
  } catch (_) {
    return /\b(login|signin|sign-in|auth)\b/i.test(String(url || ''));
  }
}

function hasSuccessfulAuthResponse(events = []) {
  return (events || []).some(event => {
    if (!event || event.type !== 'response') return false;
    const status = Number(event.status);
    if (!Number.isFinite(status) || status < 200 || status >= 400) return false;
    const target = `${event.path || ''} ${event.url || ''}`;
    return /\b(auth|login|signin|sign-in|session)\b/i.test(target);
  });
}

function isPostAuthRetryRoute(route = {}) {
  const source = `${route.source || ''} ${route.sourceTag || ''} ${route.reason || ''}`.toLowerCase();
  return source.includes('auth-retry') || source.includes('post-auth-revisit');
}

function formResultSuggestsAuthSuccess(form = {}, result = {}, hasValidationFeedbackFn = null) {
  if (!form || form.kind !== 'login') return false;
  if (!result || result.submitted !== true || result.skipped === true) return false;
  if (typeof hasValidationFeedbackFn === 'function' && hasValidationFeedbackFn(result.validationFeedback)) return false;
  if (result.transition && result.transition.noProgress) return false;
  const signals = result.after && Array.isArray(result.after.authSignals) ? result.after.authSignals : [];
  if (signals.includes('authenticated-text')) return true;
  if (hasSuccessfulAuthResponse(result.observation && result.observation.events || [])) return true;
  return Boolean(result.transition && result.transition.changedState && (result.transition.routeChanged || result.transition.routeShapeChanged));
}

function enqueuePostAuthRetry({ frontier, form, result, pageModel, routeResult, hasValidationFeedback: hasValidationFeedbackFn } = {}) {
  const authSucceeded = formResultSuggestsAuthSuccess(form, result, hasValidationFeedbackFn);
  if (!authSucceeded || !frontier || !routeResult || !routeResult.route) {
    return { authSucceeded, queued: false, reason: authSucceeded ? 'frontier_or_route_missing' : 'auth_not_confirmed' };
  }
  const originalUrl = routeResult.route.url;
  if (!originalUrl || isLoginLikeUrl(originalUrl)) {
    return { authSucceeded, queued: false, reason: 'original_route_is_login', url: originalUrl || null };
  }
  const currentUrl = pageModel && pageModel.url || null;
  if (currentUrl && !isLoginLikeUrl(currentUrl) && currentUrl === originalUrl) {
    return { authSucceeded, queued: false, reason: 'already_on_original_route', url: originalUrl };
  }
  const confirmedRetry = isPostAuthRetryRoute(routeResult.route);
  const source = confirmedRetry ? 'auth-confirmed' : 'auth-retry';
  const reason = confirmedRetry ? 'post-auth-confirmed-revisit' : 'post-auth-revisit';
  const queued = frontier.enqueue(originalUrl, {
    depth: routeResult.route.depth || 0,
    source,
    sourceTag: source,
    reason,
    allowRevisit: true,
    revisitKey: confirmedRetry ? 'auth-confirmed' : 'auth'
  });
  return { authSucceeded, queued, url: originalUrl, source, reason: queued ? reason : 'not_queued' };
}

function isDestructiveForm(form = {}) {
  const text = `${form.id || ''} ${form.selector || ''} ${form.action || ''} ${form.method || ''} ${(form.fields || []).map(field => `${field.name || ''} ${field.label || ''}`).join(' ')}`.toLowerCase();
  return /\b(delete|remove|destroy|logout|signout|transfer|payment|purchase|checkout|order|admin)\b/.test(text);
}

function ptkSessionIdFromLifecycleStart(lifecycleStart = null) {
  const candidates = [
    lifecycleStart && lifecycleStart.sessionId,
    lifecycleStart && lifecycleStart.start && lifecycleStart.start.sessionId,
    lifecycleStart && lifecycleStart.start && lifecycleStart.start.invocation && lifecycleStart.start.invocation.value && lifecycleStart.start.invocation.value.sessionId,
    lifecycleStart && lifecycleStart.start && lifecycleStart.start.invocation && lifecycleStart.start.invocation.value && lifecycleStart.start.invocation.value.session && lifecycleStart.start.invocation.value.session.id,
    lifecycleStart && lifecycleStart.start && lifecycleStart.start.invocation && lifecycleStart.start.invocation.value && lifecycleStart.start.invocation.value.session && lifecycleStart.start.invocation.value.session.sessionId
  ];
  const found = candidates.find(value => typeof value === 'string' && value.trim());
  return found ? found.trim() : null;
}

async function beginPtkScan(page, { config = {}, telemetry = null, logger = null, moduleResolution = null } = {}) {
  if (!page || !config.ptk || config.ptk.enabled === false) return null;
  try {
    const { startPtkScan } = require('../browser/ptkBridge.cjs');
    const { buildPtkScanOptions } = require('../modules/moduleResolver.cjs');
    const scanOptions = buildPtkScanOptions(config, moduleResolution);
    const started = await startPtkScan(page, {
      ...(config.ptk || {}),
      timeoutMs: ptkOperationTimeoutMs(config),
      scanOptions
    });
    if (telemetry) telemetry.event('ptk.scan.start', {
      bridgeDetected: Boolean(started.available),
      scanStarted: Boolean(started.started),
      reason: started.reason || null
    });
    return {
      bridgeDetected: Boolean(started.available),
      scanStarted: Boolean(started.started),
      start: started,
      scanOptions,
      engineSelectionRequested: scanOptions.engines || [],
      engineSelectionAppliedToPtk: Boolean(started.started && scanOptions.engines && scanOptions.engines.length),
      engineSelectionReason: started.started
        ? 'PTK bridge startScan accepted scanOptions.engines'
        : started.reason || 'PTK bridge start did not accept engine selection',
      reason: started.reason || null
    };
  } catch (err) {
    if (logger && typeof logger.debug === 'function') logger.debug('PTK scan start failed', err.message);
    return {
      bridgeDetected: false,
      scanStarted: false,
      start: null,
      reason: err.message
    };
  }
}

async function collectPtkEvidence(page, {
  config = {},
  telemetry = null,
  logger = null,
  lifecycleStart = null,
  preferStatusPage = false,
  ignoreSessionId = false,
  preDrain = undefined,
  redactValues = []
} = {}) {
  if (!page || !config.ptk || config.ptk.enabled === false) return null;
  let stopped = null;
  let drain = null;
  let ptkOperationPage = null;
  const exportAttempts = [];
  const ptkSessionId = ptkSessionIdFromLifecycleStart(lifecycleStart);
  const sessionOption = ptkSessionId && ignoreSessionId !== true ? { sessionId: ptkSessionId } : {};
  const ensurePtkOperationPage = async () => {
    if (ptkOperationPage) return ptkOperationPage;
    ptkOperationPage = await openPtkStatusPage(page, config, ptkDrainStatusReadTimeoutMs(config)).catch(() => null);
    return ptkOperationPage || page;
  };
  const closePtkOperationPage = async () => {
    if (ptkOperationPage && typeof ptkOperationPage.close === 'function') {
      await ptkOperationPage.close().catch(() => {});
    }
  };
  try {
    const { exportPtkEvidence, stopPtkScan } = require('../browser/ptkBridge.cjs');
    const {
      adaptPtkEvidence,
      applyFindingsCountToTelemetry,
      summarizeFindings
    } = require('../evidence/ptkEvidenceAdapter.cjs');
    drain = preDrain !== undefined
      ? preDrain
      : lifecycleStart && lifecycleStart.bridgeDetected
        ? await drainPtkBeforeStop(page, config, logger, telemetry, lifecycleStart.start && lifecycleStart.start.bridge, ptkSessionId)
        : null;
    let evidencePage = preferStatusPage || ptkDrainUsedStatusPage(drain) ? await ensurePtkOperationPage() : page;
    const tagExportAttempt = (result, stage) => {
      if (!result || typeof result !== 'object') return result;
      const evidence = result.evidence && typeof result.evidence === 'object'
        ? { ...result.evidence, exportAttemptStage: stage }
        : result.evidence;
      return {
        ...result,
        exportAttemptStage: stage,
        evidence
      };
    };
    const recordExportAttempt = (result, stage, details = {}) => {
      const tagged = tagExportAttempt(result, stage);
      if (tagged && typeof tagged === 'object') {
        const recorded = {
          ...tagged,
          exportAttemptId: exportAttempts.length + 1,
          exportAttemptDetails: details
        };
        exportAttempts.push(recorded);
        return recorded;
      }
      return tagged;
    };
    const exportFromEvidencePage = async (initialStage = 'before-stop') => {
      let attemptStage = initialStage;
      const pageRole = () => evidencePage === page ? 'primary-page' : 'status-page';
      const exportWithSessionScope = async (useSessionScope, extra = {}) => {
        const scopedSessionOption = useSessionScope ? sessionOption : {};
        return exportPtkEvidence(evidencePage, {
          ...(config.ptk || {}),
          exportSource: extra.exportSource || null,
          timeoutMs: ptkExportOperationTimeoutMs(config),
          statusOptions: scopedSessionOption,
          findingsOptions: {
            ...scopedSessionOption,
            limit: Number(config.ptk && config.ptk.findingsLimit || config.ptk && config.ptk.limit || 100)
          },
          exportOptions: {
            ...scopedSessionOption,
            engine: config.ptk && config.ptk.engine || 'ALL',
            transfer: config.ptk && config.ptk.transfer || 'retrieval-plan',
            allowChunked: true,
            maxExportBytes: 1,
            includeSecrets: false
          }
        });
      };
      let result = recordExportAttempt(await exportWithSessionScope(true), attemptStage, {
        page: pageRole(),
        sessionScoped: true,
        source: 'auto'
      });
      if (ptkSessionId && ptkExportSessionNotFound(result)) {
        result = recordExportAttempt(await exportWithSessionScope(false), attemptStage, {
          page: pageRole(),
          sessionScoped: false,
          source: 'auto',
          reason: 'explicit_session_lookup_failed'
        });
      }
      if (ptkSessionId && ptkExportSessionNotFound(result)) {
        result = recordExportAttempt(await exportWithSessionScope(true, { exportSource: 'PTK_AUTOMATION' }), attemptStage, {
          page: pageRole(),
          sessionScoped: true,
          source: 'PTK_AUTOMATION',
          reason: 'low_level_explicit_session_retry'
        });
      }
      if (ptkSessionId && evidencePage !== page && ptkOperationShouldRetryOnPrimaryPage(result)) {
        const statusPage = evidencePage;
        evidencePage = page;
        attemptStage = 'retry-primary-page';
        result = recordExportAttempt(await exportWithSessionScope(true), attemptStage, {
          page: pageRole(),
          sessionScoped: true,
          source: 'auto',
          reason: 'session_scoped_status_page_retry'
        });
        if (ptkOperationShouldReloadPrimaryForBridge(result)) {
          await preparePrimaryPageForPtkExport(page, config, logger);
          result = recordExportAttempt(await exportWithSessionScope(true), attemptStage, {
            page: pageRole(),
            sessionScoped: true,
            source: 'auto',
            reason: 'primary_page_reload_retry'
          });
        }
        if (!result || result.exported !== true) evidencePage = statusPage;
      }
      if (!ptkSessionId && ptkOperationShouldRetryOnStatusPage(result) && evidencePage === page) {
        evidencePage = await ensurePtkOperationPage();
        if (evidencePage !== page) {
          attemptStage = 'retry-status-page';
          result = recordExportAttempt(await exportWithSessionScope(true, { exportSource: 'PTK_AUTOMATION' }), attemptStage, {
            page: pageRole(),
            sessionScoped: true,
            source: 'PTK_AUTOMATION',
            reason: 'status_page_low_level_retry'
          });
          if (ptkSessionId && ptkExportSessionNotFound(result)) {
            result = recordExportAttempt(await exportWithSessionScope(false, { exportSource: 'PTK_AUTOMATION' }), attemptStage, {
              page: pageRole(),
              sessionScoped: false,
              source: 'PTK_AUTOMATION',
              reason: 'status_page_low_level_no_session_retry'
            });
          }
        }
      }
      if (ptkExportNeedsDrain(result)) {
        result = recordExportAttempt(await retryPtkEvidenceExport(evidencePage, config, result, logger, ptkSessionId), attemptStage, {
          page: pageRole(),
          sessionScoped: Boolean(ptkSessionId),
          source: 'auto',
          reason: 'export_wait_retry'
        });
      }
      if (ptkSessionId && ptkExportShouldRetryWithoutSessionScope(result, ptkSessionId)) {
        result = recordExportAttempt(await exportWithSessionScope(false, { exportSource: 'PTK_AUTOMATION' }), attemptStage, {
          page: pageRole(),
          sessionScoped: false,
          source: 'PTK_AUTOMATION',
          reason: 'completed_session_unscoped_retry'
        });
        if (ptkExportNeedsDrain(result)) {
          result = recordExportAttempt(await retryPtkEvidenceExport(evidencePage, config, result, logger, null), attemptStage, {
            page: pageRole(),
            sessionScoped: false,
            source: 'auto',
            reason: 'completed_session_unscoped_wait_retry'
          });
        }
      }
      return result;
    };
    let exported = null;
    if (lifecycleStart && lifecycleStart.bridgeDetected) {
      exported = await exportFromEvidencePage('before-stop');
    }
    stopped = lifecycleStart && lifecycleStart.bridgeDetected
      ? await stopPtkScan(evidencePage, {
        ...(config.ptk || {}),
        timeoutMs: ptkOperationTimeoutMs(config),
        stopOptions: {
          ...sessionOption,
          wait: false,
          immediateAnalysis: config.ptk.immediateAnalysis,
          stopTimeoutMs: ptkBridgeStopTimeoutMs(config)
        }
      }).catch(error => ({ available: true, stopped: false, reason: error.message }))
      : null;
    if (ptkSessionId && ptkExportSessionNotFound(stopped)) {
      stopped = await stopPtkScan(evidencePage, {
        ...(config.ptk || {}),
        timeoutMs: ptkOperationTimeoutMs(config),
        stopOptions: {
          wait: false,
          immediateAnalysis: config.ptk.immediateAnalysis,
          stopTimeoutMs: ptkBridgeStopTimeoutMs(config)
        }
      }).catch(error => ({ available: true, stopped: false, reason: error.message }));
    }
    if (lifecycleStart && lifecycleStart.bridgeDetected && ptkOperationShouldRetryOnStatusPage(stopped) && evidencePage === page) {
      evidencePage = await ensurePtkOperationPage();
      if (evidencePage !== page) {
        stopped = await stopPtkScan(evidencePage, {
          ...(config.ptk || {}),
          timeoutMs: ptkOperationTimeoutMs(config),
          stopOptions: {
            ...sessionOption,
            wait: false,
            immediateAnalysis: config.ptk.immediateAnalysis,
            stopTimeoutMs: ptkBridgeStopTimeoutMs(config)
          }
        }).catch(error => ({ available: true, stopped: false, reason: error.message }));
        if (ptkSessionId && ptkExportSessionNotFound(stopped)) {
          stopped = await stopPtkScan(evidencePage, {
            ...(config.ptk || {}),
            timeoutMs: ptkOperationTimeoutMs(config),
            stopOptions: {
              wait: false,
              immediateAnalysis: config.ptk.immediateAnalysis,
              stopTimeoutMs: ptkBridgeStopTimeoutMs(config)
            }
          }).catch(error => ({ available: true, stopped: false, reason: error.message }));
        }
      }
    }
    const stopStatus = stopped && stopped.stopped
      ? await waitForPtkScanStop(evidencePage, config, logger)
      : null;
    if ((!exported || exported.exported !== true) && ptkSessionId && evidencePage !== page) evidencePage = page;
    if (!exported || exported.exported !== true) exported = await exportFromEvidencePage('after-stop');
    const lifecycle = ptkLifecycleFromResults({ lifecycleStart, stopped, stopStatus, exported, exportAttempts, findings: exported.findings || [], drain });
    if (!exported.available || !exported.collected || !exported.evidence) {
      return {
        available: Boolean(exported.available),
        exported: false,
        collected: false,
        bridge: exported.bridge || null,
        lifecycle,
        validity: exported.validity || {
          valid: false,
          status: exported.available ? 'invalid_no_findings_export' : 'invalid_no_ptk_bridge',
          hasPtkBridge: Boolean(exported.available),
          hasFindingsExport: false,
          findingsCount: 0,
          reason: exported.bridge && exported.bridge.reason || exported.reason || exported.invocation && exported.invocation.reason || 'not_available'
        },
        reason: exported.bridge && exported.bridge.reason || exported.reason || exported.invocation && exported.invocation.reason || 'not_available'
      };
    }
    const safeEvidence = redactValues.length
      ? require('../evidence/ptkEvidenceAdapter.cjs').redactPtkSecretsWithValues(exported.evidence, redactValues)
      : exported.evidence;
    const adapted = adaptPtkEvidence(safeEvidence);
    const findings = summarizeFindings(safeEvidence);
    applyFindingsCountToTelemetry(telemetry, safeEvidence);
    return {
      available: true,
      exported: Boolean(exported.exported),
      collected: Boolean(exported.collected),
      bridge: exported.bridge,
      lifecycle,
      validity: exported.validity || safeEvidence.validity || {
        valid: true,
        status: 'valid',
        hasPtkBridge: true,
        hasFindingsExport: true,
        findingsCount: findings.count || findings.findingsCount || 0,
        reason: exported.reason || 'exported'
      },
      counts: adapted.counts,
      findings,
      evidence: safeEvidence
    };
  } catch (err) {
    if (logger && typeof logger.debug === 'function') logger.debug('PTK evidence export failed', err.message);
    return {
      available: false,
      exported: false,
      reason: err.message,
      lifecycle: ptkLifecycleFromResults({
        lifecycleStart,
        stopped,
        drain,
        stopStatus: null,
        exported: null,
        exportAttempts,
        findings: [],
        reason: err.message
      }),
      validity: {
        valid: false,
        status: 'invalid_no_ptk_bridge',
        hasPtkBridge: false,
        hasFindingsExport: false,
        findingsCount: 0,
        reason: err.message
      }
    };
  } finally {
    await closePtkOperationPage();
  }
}

function ptkDrainUsedStatusPage(drain = null) {
  return Boolean(drain && (
    drain.latest && drain.latest.statusPageFallback && drain.latest.statusPageFallback.used === true
      || drain.latest && drain.latest.primaryStatusFailure
  ));
}

function ptkOperationShouldRetryOnStatusPage(result = null) {
  if (!result) return false;
  const failed = result.ok === false
    || result.available === false
    || result.exported === false
    || result.stopped === false
    || result.collected === false;
  if (!failed) return false;
  const reason = String(
    result.reason
      || result.error
      || result.bridge && result.bridge.reason
      || result.invocation && (result.invocation.reason || result.invocation.error)
      || result.validity && result.validity.reason
      || ''
  );
  return /bridge_missing|not_detected|detect_failed|bridge detection exceeded|session[_ -]?not[_ -]?found|timeout|exceeded .*budget|execution context|browser_renderer_hot|target page.*closed|context.*closed|browser.*closed|target closed/i.test(reason);
}

function ptkOperationShouldRetryOnPrimaryPage(result = null) {
  if (!result || result.exported === true) return false;
  const reason = String(
    result.reason
      || result.error
      || result.bridge && result.bridge.reason
      || result.invocation && (result.invocation.reason || result.invocation.error)
      || result.validity && result.validity.reason
      || ''
  );
  return /session[_ -]?belongs[_ -]?to[_ -]?another[_ -]?tab|session[_ -]?not[_ -]?found|strict[_ -]?current[_ -]?tab|cross[_ -]?tab/i.test(reason);
}

function ptkOperationShouldReloadPrimaryForBridge(result = null) {
  if (!result || result.exported === true) return false;
  const reason = String(
    result.reason
      || result.error
      || result.bridge && result.bridge.reason
      || result.invocation && (result.invocation.reason || result.invocation.error)
      || result.validity && result.validity.reason
      || ''
  );
  return /bridge_missing|not_detected|detect_failed|bridge detection exceeded|execution context|browser_renderer_hot|target page.*closed|context.*closed|browser.*closed|target closed/i.test(reason);
}

function ptkOperationTimeoutMs(config = {}) {
  const routeMs = Number(config.crawler && config.crawler.maxRouteMs) || 30000;
  return Math.max(1000, Math.min(routeMs, 5000));
}

function ptkDrainStatusReadTimeoutMs(config = {}) {
  const ptk = config.ptk || {};
  const configured = Number(ptk.drainStatusReadTimeoutMs || ptk.statusReadTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1000, Math.min(configured, 60000));
  }
  const routeMs = Number(config.crawler && config.crawler.maxRouteMs) || 30000;
  const drainMode = String(ptk.drainMode || '').toLowerCase();
  const explicitDrain = drainMode && drainMode !== 'off';
  if (explicitDrain || ptk.stopWaitForIdle === true) {
    return Math.max(ptkOperationTimeoutMs(config), Math.min(Math.max(routeMs, 10000), 10000));
  }
  return ptkOperationTimeoutMs(config);
}

function ptkDrainBridgeMethodTimeoutMs(config = {}) {
  const readTimeout = ptkDrainStatusReadTimeoutMs(config);
  if (readTimeout <= 6000) return Math.max(1000, Math.min(readTimeout, 5000));
  return Math.max(1000, Math.min(readTimeout - 4000, 5000));
}

function ptkDrainLowLevelStatusTimeoutMs(config = {}) {
  const readTimeout = ptkDrainStatusReadTimeoutMs(config);
  const primaryTimeout = ptkDrainBridgeMethodTimeoutMs(config);
  const remaining = readTimeout - primaryTimeout - 250;
  if (remaining >= 1000) return Math.min(4000, remaining);
  return Math.max(500, Math.min(1000, readTimeout));
}

function ptkExportOperationTimeoutMs(config = {}) {
  const exportMs = ptkExportDrainMs(config);
  if (exportMs > 0) return Math.max(1000, exportMs);
  return ptkOperationTimeoutMs(config);
}

function ptkExportDrainMs(config = {}) {
  const defaultMs = 30000;
  const maxMs = 60000;
  const value = Number(config.ptk && config.ptk.exportDrainMs);
  if (Number.isFinite(value) && value >= 0) return Math.min(value, maxMs);
  return defaultMs;
}

function ptkBridgeStopTimeoutMs(config = {}) {
  const drainMs = ptkExportDrainMs(config);
  if (drainMs <= 0) return 250;
  return Math.max(250, Math.floor(drainMs / 4));
}

function ptkExportFailureText(exported = {}) {
  return [
    exported && exported.reason,
    exported && exported.error,
    exported && exported.bridge && exported.bridge.reason,
    exported && exported.invocation && (exported.invocation.reason || exported.invocation.error),
    exported && exported.validity && exported.validity.reason,
    exported && exported.evidence && exported.evidence.reason,
    exported && exported.evidence && exported.evidence.validity && exported.evidence.validity.reason
  ].filter(Boolean).join(' ').toLowerCase();
}

function ptkExportNeedsDrain(exported = {}) {
  if (!exported || exported.exported === true) return false;
  const reason = ptkExportFailureText(exported);
  return /session_not_completed|stopping|in[_ -]?progress|not[_ -]?completed/.test(reason);
}

function ptkExportShouldRetryWithoutSessionScope(exported = {}, requestedSessionId = null) {
  if (!ptkExportNeedsDrain(exported)) return false;
  const reason = ptkExportFailureText(exported);
  if (!/session_not_completed|not[_ -]?completed/.test(reason)) return false;
  const diagnostics = exported.lookupDiagnostics
    || exported.evidence && exported.evidence.lookupDiagnostics
    || exported.invocation && exported.invocation.lookupDiagnostics
    || null;
  if (!diagnostics || typeof diagnostics !== 'object') return false;
  const requested = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
  if (requested) {
    const completedIds = [
      diagnostics.completedSessionIdForTab,
      diagnostics.globalCompletedSessionId
    ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
    if (!completedIds.includes(requested)) return false;
  }
  return Boolean(
    !diagnostics.activeSessionIdForTab &&
    (
      diagnostics.completedSessionIdForTab ||
      diagnostics.globalCompletedSessionId ||
      diagnostics.sessionFinishedAt ||
      diagnostics.stopRequestedAt
    )
  );
}

function ptkExportSessionNotFound(exported = {}) {
  if (!exported || exported.exported === true) return false;
  const reason = ptkExportFailureText(exported);
  return /session[_ -]?not[_ -]?found/.test(reason);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function retryPtkEvidenceExport(page, config = {}, firstResult = {}, logger = null, ptkSessionId = null) {
  const { exportPtkEvidence } = require('../browser/ptkBridge.cjs');
  const deadline = Date.now() + ptkExportDrainMs(config);
  let latest = firstResult;
  const sessionOption = ptkSessionId ? { sessionId: ptkSessionId } : {};
  while (Date.now() < deadline && ptkExportNeedsDrain(latest)) {
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
    latest = await exportPtkEvidence(page, {
      ...(config.ptk || {}),
      timeoutMs: ptkExportOperationTimeoutMs(config),
      statusOptions: sessionOption,
      findingsOptions: {
        ...sessionOption,
        limit: Number(config.ptk && config.ptk.findingsLimit || config.ptk && config.ptk.limit || 100)
      },
      exportOptions: {
        ...sessionOption,
        engine: config.ptk && config.ptk.engine || 'ALL',
        transfer: config.ptk && config.ptk.transfer || 'retrieval-plan',
        includeSecrets: false
      }
    }).catch(error => ({
      ...latest,
      reason: error.message || latest.reason || 'export_retry_failed'
    }));
    if (logger && typeof logger.debug === 'function') logger.debug('PTK evidence export retry', latest.reason || latest.validity && latest.validity.reason || '');
  }
  return latest || firstResult;
}

function ptkDrainPolicy(config = {}) {
  const ptk = config.ptk || {};
  const configuredMode = ptk.drainMode || 'off';
  const mode = ptk.stopWaitForIdle === true && configuredMode === 'off'
    ? 'until-idle'
    : configuredMode;
  let timeoutMs = Number(ptk.drainTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 0;
  if (mode === 'brief' && timeoutMs === 0) timeoutMs = 2000;
  if (mode === 'until-idle' && timeoutMs === 0 && ptk.stopWaitForIdle === true) timeoutMs = ptkExportDrainMs(config);
  return {
    mode,
    timeoutMs,
    intervalMs: Math.max(250, Math.min(1000, Math.floor(Math.max(timeoutMs, 1000) / 10)))
  };
}

async function drainPtkBeforeStop(page, config = {}, logger = null, telemetry = null, bridge = null, ptkSessionId = null) {
  const policy = ptkDrainPolicy(config);
  const outputDir = config.artifacts && config.artifacts.outputDir;
  const statusOptions = ptkSessionId ? { sessionId: ptkSessionId } : {};
  if (policy.mode === 'off' || policy.timeoutMs <= 0) {
    const skipped = {
      mode: policy.mode,
      status: 'skipped',
      timedOut: false,
      timeoutMs: policy.timeoutMs,
      polls: 0,
      reason: policy.mode === 'off' ? 'drain_mode_off' : 'drain_timeout_not_configured'
    };
    writePtkDrainSummary(outputDir, skipped);
    return skipped;
  }

  const statusReader = createPtkDrainStatusReader({
    page,
    config,
    bridge,
    statusOptions
  });
  if (telemetry) telemetry.event('ptk.drain.start', { mode: policy.mode, timeoutMs: policy.timeoutMs });
  writePtkDrainSummary(outputDir, {
    mode: policy.mode,
    status: 'running',
    timedOut: false,
    timeoutMs: policy.timeoutMs,
    polls: 0,
    startedAt: new Date().toISOString(),
    reason: 'ptk_drain_started'
  });
  let drained;
  try {
    drained = await pollPtkDrainStatus({
      mode: policy.mode,
      timeoutMs: policy.timeoutMs,
      intervalMs: policy.intervalMs,
      readTimeoutMs: ptkDrainStatusReadTimeoutMs(config),
      onPoll: summary => writePtkDrainSummary(outputDir, summary),
      readStatus: statusReader.readStatus
    });
  } finally {
    await statusReader.close();
  }
  if (logger && typeof logger.debug === 'function') logger.debug('PTK drain result', drained.status, drained.reason || '');
  if (telemetry) telemetry.event('ptk.drain.end', {
    mode: drained.mode,
    status: drained.status,
    timedOut: Boolean(drained.timedOut),
    polls: drained.polls,
    reason: drained.reason || null
  });
  writePtkDrainSummary(outputDir, drained);
  return drained;
}

function shouldUsePtkStatusPageFallback(result = {}, { sessionScoped = false } = {}) {
  const reason = String(result.reason || result.error || result.invocation && (result.invocation.reason || result.invocation.error) || '');
  return result && result.ok !== true && (
    result.readTimedOut === true
      || /timeout|timed out|exceeded .*budget|browser_renderer_hot|target page.*closed|context.*closed|browser.*closed|target closed|execution context|bridge_missing|not_detected|method_missing/i.test(reason)
      || (sessionScoped && /automation_disabled/i.test(reason))
  );
}

function ptkStatusReadPageClosed(result = {}) {
  const reason = [
    result && result.reason,
    result && result.error,
    result && result.invocation && (result.invocation.reason || result.invocation.error),
    result && result.primaryStatusFailure && result.primaryStatusFailure.reason
  ].filter(Boolean).join(' ');
  return /target page.*closed|context.*closed|browser.*closed|target closed/i.test(reason);
}

function ptkStatusAutomationDisabled(result = {}) {
  const reason = [
    result.reason,
    result.error,
    result.invocation && (result.invocation.reason || result.invocation.error),
    result.invocation && result.invocation.value && (result.invocation.value.error || result.invocation.value.code || result.invocation.value.reason)
  ].filter(Boolean).join(' ');
  return /automation_disabled/i.test(reason);
}

async function requestPtkAutomationActivationForDrain(page, timeoutMs = 1000) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, reason: 'page_evaluate_missing' };
  const timeout = Math.max(250, Math.min(Number(timeoutMs) || 1000, 5000));
  let timer = null;
  const timeoutMarker = Symbol('ptk-drain-activation-timeout');
  const result = await Promise.race([
    page.evaluate(async () => {
      const bridge = typeof window !== 'undefined' ? window.PTK_AUTOMATION : null;
      if (!bridge || typeof bridge.requestActivation !== 'function') {
        return { ok: false, reason: 'request_activation_missing' };
      }
      try {
        return await Promise.resolve(bridge.requestActivation({ reason: 'ptk_drain_recovery' }));
      } catch (error) {
        return { ok: false, reason: error && error.message || String(error || 'request_activation_failed') };
      }
    }).catch(error => ({ ok: false, reason: error && error.message || 'request_activation_failed' })),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(timeoutMarker), timeout);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (result === timeoutMarker) return { ok: false, reason: `request_activation_timeout_${timeout}ms` };
  return result && typeof result === 'object' ? result : { ok: false, reason: 'request_activation_invalid_response' };
}

async function openPtkStatusPage(page, config = {}, timeoutMs = 5000) {
  const context = page && typeof page.context === 'function' ? page.context() : null;
  if (!context || typeof context.newPage !== 'function') return null;
  const baseUrl = config.target && config.target.baseUrl;
  if (!baseUrl) return null;
  let statusPage = null;
  try {
    statusPage = await context.newPage();
  } catch (_) {
    return null;
  }
  try {
    await statusPage.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1000, Math.min(Number(timeoutMs) || 5000, 5000))
    });
  } catch (_) {
    // The status page only needs the PTK bridge script to be available. A page
    // load failure is still worth trying before giving up on a hot crawler page.
  }
  return statusPage;
}

async function preparePrimaryPageForPtkExport(page, config = {}, logger = null) {
  if (!page) return { ok: false, reason: 'page_missing' };
  const { waitForPtkBridge } = require('../browser/ptkBridge.cjs');
  const waitTimeoutMs = Math.max(1000, Math.min(ptkDrainStatusReadTimeoutMs(config), 5000));
  const detected = await waitForPtkBridge(page, {
    ...(config.ptk || {}),
    timeoutMs: waitTimeoutMs
  }).catch(error => ({ available: false, reason: error.message }));
  if (detected && detected.available) return { ok: true, navigated: false, bridge: detected };
  const baseUrl = config.target && config.target.baseUrl;
  if (!baseUrl || typeof page.goto !== 'function') return { ok: false, navigated: false, reason: detected && detected.reason || 'bridge_not_detected' };
  try {
    await page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1000, Math.min(Number(config.crawler && config.crawler.maxRouteMs) || 30000, 10000))
    });
  } catch (error) {
    if (logger && typeof logger.debug === 'function') logger.debug('PTK primary page export recovery navigation failed', error.message);
  }
  const afterNavigation = await waitForPtkBridge(page, {
    ...(config.ptk || {}),
    timeoutMs: waitTimeoutMs
  }).catch(error => ({ available: false, reason: error.message }));
  return {
    ok: Boolean(afterNavigation && afterNavigation.available),
    navigated: true,
    bridge: afterNavigation && afterNavigation.available ? afterNavigation : null,
    reason: afterNavigation && afterNavigation.reason || null
  };
}

function createPtkDrainStatusReader({ page, config = {}, bridge = null, statusOptions = {}, readPtkStatusFn = null } = {}) {
  let statusPage = null;
  let statusPageAttempted = false;
  let statusPageEnabled = false;
  let primaryRecoveryAttempted = false;
  const allowDisabledPrimaryStatusPageFallback = Boolean(statusOptions && statusOptions.sessionId) || Boolean(bridge && bridge.available);
  const readStatusImpl = readPtkStatusFn || require('../browser/ptkBridge.cjs').readPtkStatus;
  const readOptions = targetPage => ({
    ...(config.ptk || {}),
    bridge: targetPage === page ? bridge : null,
    statusOptions,
    timeoutMs: ptkDrainBridgeMethodTimeoutMs(config),
    lowLevelTimeoutMs: ptkDrainLowLevelStatusTimeoutMs(config)
  });

  async function detectFreshBridgeForDrain(targetPage, timeoutMs) {
    if (readPtkStatusFn) return null;
    const { waitForPtkBridge } = require('../browser/ptkBridge.cjs');
    return waitForPtkBridge(targetPage, {
      ...(config.ptk || {}),
      timeoutMs: Math.max(500, Math.min(Number(timeoutMs) || 1000, 3000)),
      probeMetadata: false
    }).catch(() => null);
  }

  async function readFrom(targetPage, extra = {}) {
    const options = readOptions(targetPage);
    if (extra.statusPageFallback && !readPtkStatusFn && !options.bridge) {
      const detected = await detectFreshBridgeForDrain(targetPage, Math.max(1000, Math.min(ptkDrainBridgeMethodTimeoutMs(config), 5000)));
      if (detected && detected.available) options.bridge = detected;
    }
    let result = await readStatusImpl(targetPage, options);
    if (!readPtkStatusFn && result && result.ok !== true && options.bridge && targetPage === page) {
      const detected = await detectFreshBridgeForDrain(targetPage, ptkDrainBridgeMethodTimeoutMs(config));
      if (detected && detected.available) {
        const retry = await readStatusImpl(targetPage, {
          ...options,
          bridge: detected
        });
        result = retry && retry.ok === true
          ? {
              ...retry,
              refreshedBridge: true,
              staleBridgeFailure: {
                reason: result.reason || result.error || null,
                invocation: result.invocation || null
              }
            }
          : {
              ...retry,
              staleBridgeFailure: {
                reason: result.reason || result.error || null,
                invocation: result.invocation || null
              }
            };
      }
    }
    return extra.statusPageFallback
      ? {
          ...result,
          statusPageFallback: extra.statusPageFallback
        }
      : result;
  }

  return {
    async readStatus() {
      const primary = await readFrom(page);
      if (primary && primary.ok) return primary;

      if (!primaryRecoveryAttempted && allowDisabledPrimaryStatusPageFallback && ptkStatusAutomationDisabled(primary)) {
        primaryRecoveryAttempted = true;
        const activation = await requestPtkAutomationActivationForDrain(page, ptkDrainBridgeMethodTimeoutMs(config)).catch(error => ({
          ok: false,
          reason: error && error.message || 'request_activation_failed'
        }));
        if (activation && (activation.ok === true || activation.allowed === true)) {
          const activated = await readFrom(page);
          if (activated && activated.ok) {
            return {
              ...activated,
              primaryActivationRecovery: {
                used: true,
                reason: primary.reason || 'automation_disabled'
              }
            };
          }
        }
        const baseUrl = config.target && config.target.baseUrl;
        if (baseUrl && page && typeof page.goto === 'function') {
          try {
            await page.goto(baseUrl, {
              waitUntil: 'domcontentloaded',
              timeout: Math.max(1000, Math.min(ptkDrainStatusReadTimeoutMs(config), 5000))
            });
            const recovered = await readFrom(page);
            if (recovered && recovered.ok) {
              return {
                ...recovered,
                primaryPageRecovery: {
                  used: true,
                  reason: primary.reason || 'automation_disabled'
                }
              };
            }
          } catch (_) {
            // Continue to the status-page fallback path below.
          }
        }
      }

      if (statusPageEnabled && statusPage) {
        const fallback = await readFrom(statusPage, {
          statusPageFallback: {
            used: true,
            reason: primary && primary.reason || 'status_page_already_enabled'
          }
        });
        return fallback && fallback.ok ? fallback : {
          ...fallback,
          primaryStatusFailure: {
            reason: primary && primary.reason || null,
            invocation: primary && primary.invocation || null
          }
        };
      }

      if (!shouldUsePtkStatusPageFallback(primary, {
        sessionScoped: allowDisabledPrimaryStatusPageFallback
      })) return primary;

      if (!statusPageAttempted) {
        statusPageAttempted = true;
        statusPage = await openPtkStatusPage(page, config, ptkDrainStatusReadTimeoutMs(config)).catch(() => null);
        statusPageEnabled = Boolean(statusPage);
      }
      if (!statusPageEnabled || !statusPage) return primary;

      const fallback = await readFrom(statusPage, {
        statusPageFallback: {
          used: true,
          reason: primary.reason || 'primary_status_unavailable'
        }
      });
      return fallback && fallback.ok ? fallback : {
        ...fallback,
        primaryStatusFailure: {
          reason: primary.reason || null,
          invocation: primary.invocation || null
        }
      };
    },
    async close() {
      if (statusPage && typeof statusPage.close === 'function') {
        await Promise.race([
          statusPage.close().catch(() => {}),
          delay(1000)
        ]).catch(() => {});
      }
    }
  };
}

function writePtkDrainSummary(outputDir, summary = {}) {
  if (!outputDir) return null;
  try {
    return writeJson(outputDir, ARTIFACT_FILENAMES.ptkDrainSummary, {
      schemaVersion: 'ptk-agent-v2-ptk-drain-summary',
      updatedAt: new Date().toISOString(),
      ...summary
    });
  } catch (_) {
    return null;
  }
}

async function readPtkStatusWithinDeadline({ readStatus, timeoutMs = 1000, timeoutFn = null } = {}) {
  const timeout = Math.max(1, Number(timeoutMs) || 1000);
  const timeoutMarker = Symbol('ptk-status-read-timeout');
  let timer = null;
  const timeoutPromise = timeoutFn
    ? Promise.resolve().then(() => timeoutFn(timeout)).then(() => timeoutMarker)
    : new Promise(resolve => {
      timer = setTimeout(() => resolve(timeoutMarker), timeout);
    });
  const result = await Promise.race([
    Promise.resolve()
      .then(() => readStatus())
      .catch(error => ({
        ok: false,
        reason: error.message || 'status_read_failed',
        status: null
      })),
    timeoutPromise
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (result === timeoutMarker) {
    return {
      ok: false,
      reason: `status_read_timeout_${timeout}ms`,
      status: null,
      readTimedOut: true
    };
  }
  return result;
}

async function pollPtkDrainStatus({ mode = 'off', timeoutMs = 0, intervalMs = 500, readTimeoutMs = 1000, readStatus, sleepFn = delay, readTimeoutFn = null, now = Date.now, onPoll = null } = {}) {
  if (mode === 'off' || timeoutMs <= 0) {
    return {
      mode,
      status: 'skipped',
      timedOut: false,
      timeoutMs,
      polls: 0,
      reason: mode === 'off' ? 'drain_mode_off' : 'drain_timeout_not_configured'
    };
  }
  if (typeof readStatus !== 'function') {
    return {
      mode,
      status: 'unavailable',
      timedOut: false,
      timeoutMs,
      polls: 0,
      reason: 'status_reader_missing'
    };
  }

  const startedAtMs = now();
  const deadline = startedAtMs + timeoutMs;
  let latest = null;
  let classification = classifyPtkDrainStatus(null);
  let polls = 0;
  while (now() <= deadline) {
    polls += 1;
    const remainingBeforeRead = Math.max(1, deadline - now());
    latest = await readPtkStatusWithinDeadline({
      readStatus,
      timeoutFn: readTimeoutFn,
      timeoutMs: Math.min(Math.max(1, Number(readTimeoutMs) || 1000), remainingBeforeRead)
    });
    if (now() > deadline) {
      classification = classifyPtkDrainStatus(latest && latest.status !== undefined ? latest.status : latest);
      break;
    }
    classification = classifyPtkDrainStatus(latest && latest.status !== undefined ? latest.status : latest);
    if (typeof onPoll === 'function') onPoll({
      mode,
      status: 'running',
      timedOut: false,
      timeoutMs,
      elapsedMs: Math.max(0, now() - startedAtMs),
      polls,
      latest,
      classification,
      attackCompletion: summarizePtkAttackCompletion(latest && latest.status !== undefined ? latest.status : latest),
      reason: classification.reason || latest && latest.reason || 'ptk_drain_poll'
    });
    if (!classification.complete && ptkStatusReadPageClosed(latest)) {
      return {
        mode,
        status: 'unavailable',
        timedOut: false,
        timeoutMs,
        elapsedMs: Math.max(0, now() - startedAtMs),
        polls,
        latest,
        classification,
        attackCompletion: summarizePtkAttackCompletion(latest && latest.status !== undefined ? latest.status : latest),
        reason: 'ptk_status_page_closed'
      };
    }
    const reached = mode === 'until-complete'
      ? classification.complete
      : mode === 'until-idle'
        ? classification.idle
        : classification.complete || classification.idle;
    if (reached) {
      return {
        mode,
        status: classification.complete ? 'completed' : 'idle',
        timedOut: false,
        timeoutMs,
        elapsedMs: Math.max(0, now() - startedAtMs),
        polls,
        latest,
        classification,
        attackCompletion: summarizePtkAttackCompletion(latest && latest.status !== undefined ? latest.status : latest),
        reason: classification.reason
      };
    }
    if (now() >= deadline) break;
    await sleepFn(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
  return {
    mode,
    status: 'timeout',
    timedOut: true,
    timeoutMs,
    elapsedMs: Math.max(0, now() - startedAtMs),
    polls,
    latest,
    classification,
    attackCompletion: summarizePtkAttackCompletion(latest && latest.status !== undefined ? latest.status : latest),
    reason: classification.reason || 'ptk_drain_timeout'
  };
}

function classifyPtkDrainStatus(status = null) {
  const value = unwrapPtkStatus(status);
  const statusText = String(value && value.status || status && status.status || '').toLowerCase();
  const engines = value && value.engines && typeof value.engines === 'object' ? value.engines : {};
  const engineEntries = Object.entries(engines);
  if (!engineEntries.length) {
    const terminal = ['completed', 'complete', 'done', 'none'].includes(statusText);
    const idle = terminal || ['idle', 'stopped'].includes(statusText);
    return {
      available: Boolean(value),
      status: statusText || null,
      complete: terminal,
      idle,
      partial: false,
      planned: 0,
      completed: 0,
      cancelled: 0,
      engines: {},
      reason: terminal ? 'ptk_status_completed' : idle ? 'ptk_status_idle' : 'ptk_engine_status_unavailable'
    };
  }

  const out = {};
  let allComplete = true;
  let allIdle = true;
  let partial = false;
  let plannedTotal = 0;
  let completedTotal = 0;
  let cancelledTotal = 0;
  for (const [engine, engineStatus] of engineEntries) {
    const progress = engineStatus && engineStatus.progress || {};
    const done = Number(progress.done);
    const total = Number(progress.total);
    const remainingValue = Number(progress.remaining ?? engineStatus.remaining);
    const planned = Number.isFinite(total) ? total : null;
    const completed = Number.isFinite(done) ? done : null;
    const remaining = Number.isFinite(remainingValue) ? remainingValue : null;
    const stateText = String(engineStatus && (engineStatus.status || engineStatus.phase) || '');
    const phaseText = String(engineStatus && engineStatus.phase || '');
    const statusPhaseText = `${stateText} ${phaseText}`.trim();
    const running = engineStatus && engineStatus.isRunning === true || /running|starting|queued|planning/i.test(statusPhaseText);
    const queueCount = ['activeTasks', 'taskQueue', 'requestQueue', 'pendingPlans', 'planning']
      .map(key => Number(engineStatus && engineStatus[key]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    const explicitIdle = engineStatus && engineStatus.idle === true;
    const stoppedOrCancelled = /stopp|cancel/i.test(statusPhaseText);
    const finitePlanComplete = planned !== null && completed !== null && completed >= planned;
    const queueEmpty = queueCount === 0 && (remaining === null || remaining === 0);
    const idleNoRemaining = explicitIdle && queueEmpty && !stoppedOrCancelled;
    const stoppedNoRemaining = stoppedOrCancelled && queueEmpty;
    const finiteWaitingComplete = finitePlanComplete && queueEmpty && /idle|waiting|completed|complete|done/i.test(statusPhaseText);
    const passiveRuntimeComplete = ['IAST', 'SCA'].includes(String(engine || '').toUpperCase())
      && planned === null
      && remaining === null
      && queueCount === 0
      && !stoppedOrCancelled;
    const engineIdle = explicitIdle || stoppedNoRemaining || finiteWaitingComplete || passiveRuntimeComplete || (!running && queueEmpty);
    const engineComplete = finitePlanComplete || idleNoRemaining || stoppedNoRemaining || finiteWaitingComplete || passiveRuntimeComplete || (engineIdle && !running);
    const cancelled = planned !== null && completed !== null && planned > completed && stoppedOrCancelled && !engineComplete
      ? planned - completed
      : 0;
    if (!engineComplete) allComplete = false;
    if (!engineIdle) allIdle = false;
    const enginePartial = planned !== null && completed !== null && planned > completed && !engineComplete;
    if (enginePartial) partial = true;
    plannedTotal += planned || 0;
    completedTotal += completed || 0;
    cancelledTotal += cancelled;
    out[engine] = {
      status: engineStatus && engineStatus.status || null,
      phase: engineStatus && engineStatus.phase || null,
      planned,
      completed,
      remaining,
      idle: engineIdle,
      complete: engineComplete,
      running,
      cancelled,
      partial: enginePartial
    };
  }

  return {
    available: true,
    status: statusText || null,
    complete: allComplete || ['completed', 'complete', 'done'].includes(statusText),
    idle: allIdle,
    partial,
    planned: plannedTotal,
    completed: completedTotal,
    cancelled: cancelledTotal,
    engines: out,
    reason: allComplete ? 'ptk_engines_complete' : allIdle ? 'ptk_engines_idle' : 'ptk_engines_incomplete'
  };
}

async function waitForPtkScanStop(page, config = {}, logger = null) {
  const { readPtkStatus } = require('../browser/ptkBridge.cjs');
  const deadline = Date.now() + ptkExportDrainMs(config);
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await readPtkStatusWithinDeadline({
      timeoutMs: Math.min(ptkOperationTimeoutMs(config), Math.max(1, deadline - Date.now())),
      readStatus: () => readPtkStatus(page, {
        ...(config.ptk || {}),
        timeoutMs: ptkOperationTimeoutMs(config)
      })
    });
    const status = extractPtkScanStatus(latest);
    if (logger && typeof logger.debug === 'function') logger.debug('PTK scan stop poll', status || latest.reason || '');
    if (status === 'completed' || status === 'error' || status === 'none') {
      return {
        completed: status === 'completed' || status === 'none',
        status,
        latest,
        reason: status
      };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  return {
    completed: false,
    status: extractPtkScanStatus(latest) || null,
    latest,
    reason: 'stop_wait_timeout'
  };
}

function extractPtkScanStatus(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value !== 'object') return null;
  if (typeof value.status === 'string') return value.status.toLowerCase();
  if (value.status && typeof value.status === 'object') return extractPtkScanStatus(value.status);
  if (value.value && typeof value.value === 'object') return extractPtkScanStatus(value.value);
  if (value.invocation && typeof value.invocation === 'object') return extractPtkScanStatus(value.invocation.value || value.invocation);
  return null;
}

function ptkRawStatusSamples({ lifecycleStart = null, drain = null, exported = null, exportAttempts = [], stopStatus = null, stopped = null } = {}) {
  const samples = [];
  const push = (stage, status) => {
    if (status === undefined) return;
    samples.push({ stage, status: status || null });
  };
  push('after-start', lifecycleStart && (lifecycleStart.status || lifecycleStart.start && lifecycleStart.start.status || lifecycleStart.start));
  if (drain && Array.isArray(drain.samples)) {
    drain.samples.forEach((sample, index) => push(`during-drain:${index}`, sample && (sample.status || sample)));
  } else {
    push('during-drain', drain && drain.latest && (drain.latest.status || drain.latest));
  }
  const attempts = Array.isArray(exportAttempts) && exportAttempts.length ? exportAttempts : exported ? [exported] : [];
  attempts.forEach((attempt, index) => {
    const stage = attempt && attempt.exportAttemptStage || `attempt-${index + 1}`;
    push(`export:${index + 1}:${stage}`, summarizePtkExportAttempt(attempt));
  });
  push('before-export', exported && exported.status && exported.status.status);
  push('after-export', exported && exported.evidence && exported.evidence.status);
  push('before-stop', stopped && (stopped.status || stopped.invocation && stopped.invocation.value));
  push('after-stop', stopStatus && (stopStatus.latest && (stopStatus.latest.status || stopStatus.latest) || stopStatus.status));
  return samples;
}

function summarizePtkExportAttempt(attempt = null) {
  if (!attempt || typeof attempt !== 'object') return null;
  const lookupDiagnostics = attempt.lookupDiagnostics || attempt.evidence && attempt.evidence.lookupDiagnostics || null;
  const invocation = attempt.invocation || null;
  return {
    id: attempt.exportAttemptId || null,
    stage: attempt.exportAttemptStage || null,
    page: attempt.exportAttemptDetails && attempt.exportAttemptDetails.page || null,
    source: attempt.exportAttemptDetails && attempt.exportAttemptDetails.source || invocation && invocation.source || null,
    sessionScoped: attempt.exportAttemptDetails && typeof attempt.exportAttemptDetails.sessionScoped === 'boolean'
      ? attempt.exportAttemptDetails.sessionScoped
      : null,
    exported: Boolean(attempt.exported),
    collected: Boolean(attempt.collected),
    reason: attempt.reason || attempt.validity && attempt.validity.reason || invocation && (invocation.reason || invocation.error) || null,
    invocationSource: invocation && invocation.source || null,
    invocationMethod: invocation && invocation.method || null,
    invocationOk: invocation && typeof invocation.ok === 'boolean' ? invocation.ok : null,
    invocationCalled: invocation && typeof invocation.called === 'boolean' ? invocation.called : null,
    lookupSource: attempt.exportLookupSource || attempt.evidence && attempt.evidence.exportLookupSource || lookupDiagnostics && lookupDiagnostics.lookupSource || null,
    lookupDiagnostics: lookupDiagnostics || null,
    retrievalResolved: Boolean(attempt.exportRetrievalResolved || attempt.evidence && attempt.evidence.exportRetrievalResolved),
    validityStatus: attempt.validity && attempt.validity.status || attempt.evidence && attempt.evidence.validity && attempt.evidence.validity.status || null,
    findingsExportValiditySource: attempt.findingsExportValiditySource || attempt.evidence && attempt.evidence.findingsExportValiditySource || null,
    findingsApiFallbackUsed: Boolean(attempt.findingsApiFallbackUsed || attempt.evidence && attempt.evidence.findingsApiFallbackUsed)
  };
}

function ptkLifecycleInconsistencies({ exported = null, exportAttempts = [], drain = null, attackCompletion = null } = {}) {
  const inconsistencies = [];
  const validity = exported && exported.validity || exported && exported.evidence && exported.evidence.validity || null;
  const source = exported && (exported.findingsExportValiditySource || exported.evidence && exported.evidence.findingsExportValiditySource) || null;
  const fallbackUsed = Boolean(exported && (exported.findingsApiFallbackUsed || exported.evidence && exported.evidence.findingsApiFallbackUsed));
  if (fallbackUsed && source !== 'export') inconsistencies.push('findings_api_used_without_export');
  if (exported && exported.exported === false && exported.lookupDiagnostics) inconsistencies.push('export_session_lookup_failed');
  for (const attempt of Array.isArray(exportAttempts) ? exportAttempts : []) {
    if (attempt && attempt.exported === false && (attempt.lookupDiagnostics || attempt.evidence && attempt.evidence.lookupDiagnostics)) {
      inconsistencies.push('export_session_lookup_failed');
    }
    if (attempt && (attempt.findingsApiFallbackUsed || attempt.evidence && attempt.evidence.findingsApiFallbackUsed)) {
      inconsistencies.push('findings_api_used_without_export');
    }
  }
  if (validity && validity.hasFindingsExport === false && source === 'findings-api') inconsistencies.push('findings_api_used_without_export');
  for (const [engineName, engine] of Object.entries(attackCompletion && attackCompletion.engines || {})) {
    const name = String(engineName || '').toUpperCase();
    const planned = Number(engine && engine.planned);
    const completed = Number(engine && engine.completed);
    if (!Number.isFinite(planned) || planned <= 0 || !Number.isFinite(completed)) continue;
    const latestStatus = drain && drain.latest && (drain.latest.status || drain.latest) || null;
    const rawEngines = latestStatus && latestStatus.engines || {};
    const raw = rawEngines[name] || rawEngines[name.toLowerCase()] || rawEngines[name.toUpperCase()] || null;
    const runtime = engineRuntimeForLifecycle(raw);
    const collectionState = String(runtime && runtime.collectionState || '');
    const analysisState = String(runtime && runtime.analysisState || '');
    const activeCollectionCount = Number(runtime && runtime.activeCollectionCount || 0);
    const sastWaitingForPageActivity = name === 'SAST'
      && /waiting_for_page_activity|complete|completed/i.test(`${collectionState} ${analysisState}`)
      && activeCollectionCount <= 0;
    if (sastWaitingForPageActivity) continue;
    if (engine && completed >= planned && engine.partial === false && /running|analy/i.test(String(engine.status || ''))) {
      inconsistencies.push('raw_running_but_counters_complete');
    }
  }
  const latestStatus = drain && drain.latest && (drain.latest.status || drain.latest) || null;
  const sast = latestStatus && latestStatus.engines && (latestStatus.engines.SAST || latestStatus.engines.sast) || null;
  const sastRuntime = engineRuntimeForLifecycle(sast);
  const collectionState = String(sastRuntime && sastRuntime.collectionState || '');
  const analysisState = String(sastRuntime && sastRuntime.analysisState || '');
  if (drain && drain.timedOut && /waiting_for_page_activity/i.test(collectionState)) inconsistencies.push('sast_waiting_for_page_activity');
  if (drain && drain.timedOut && /analysis_running|collecting|payload_received/i.test(`${collectionState} ${analysisState}`)) {
    inconsistencies.push('sast_active_collection_after_timeout');
  }
  return Array.from(new Set(inconsistencies));
}

function engineRuntimeForLifecycle(engine = null) {
  if (!engine || typeof engine !== 'object') return null;
  if (engine.runtime && typeof engine.runtime === 'object') return engine.runtime;
  if (engine.collectionState || engine.analysisState || typeof engine.isAnalysisRunning !== 'undefined') return engine;
  if (engine.progress && typeof engine.progress === 'object') return engine.progress;
  return engine;
}

function ptkLifecycleFromResults({ lifecycleStart = null, stopped = null, stopStatus = null, exported = null, exportAttempts = [], findings = [], drain = null, reason = null } = {}) {
  const validity = exported && exported.validity || null;
  const findingsCount = Array.isArray(findings) ? findings.length : 0;
  const bridgeDetected = Boolean((lifecycleStart && lifecycleStart.bridgeDetected) || (exported && exported.available));
  const stopCompleted = stopStatus ? stopStatus.completed === true : Boolean(stopped && stopped.stopped);
  const drainedComplete = drain && drain.status === 'completed' && drain.latest;
  const attackCompletionSource = drainedComplete
    ? drain.latest.status !== undefined ? drain.latest.status : drain.latest
    : exported && exported.evidence && exported.evidence.status || stopStatus && stopStatus.latest && stopStatus.latest.status || drain && drain.latest && drain.latest.status || null;
  const attackCompletion = summarizePtkAttackCompletion(attackCompletionSource);
  const exportLookupDiagnostics = exported && (exported.lookupDiagnostics || exported.evidence && exported.evidence.lookupDiagnostics) || null;
  const exportLookupSource = exported && (exported.exportLookupSource || exported.evidence && exported.evidence.exportLookupSource) || exportLookupDiagnostics && exportLookupDiagnostics.lookupSource || null;
  const exportRetrievalResolved = Boolean(exported && (exported.exportRetrievalResolved || exported.evidence && exported.evidence.exportRetrievalResolved));
  const findingsApiFallbackUsed = Boolean(exported && (exported.findingsApiFallbackUsed || exported.evidence && exported.evidence.findingsApiFallbackUsed));
  const findingsExportValiditySource = exported && (exported.findingsExportValiditySource || exported.evidence && exported.evidence.findingsExportValiditySource)
    || (exportRetrievalResolved ? 'export' : findingsApiFallbackUsed ? 'findings-api' : 'none');
  const attemptSummaries = (Array.isArray(exportAttempts) && exportAttempts.length ? exportAttempts : exported ? [exported] : [])
    .map(summarizePtkExportAttempt)
    .filter(Boolean);
  const beforeStopAttempts = attemptSummaries.filter(attempt => ['before-stop', 'retry-status-page'].includes(attempt.stage));
  const rawStatusSamples = ptkRawStatusSamples({ lifecycleStart, drain, exported, exportAttempts, stopStatus, stopped });
  const inconsistencies = ptkLifecycleInconsistencies({ exported, exportAttempts, drain, attackCompletion });
  return {
    bridgeDetected,
    scanStarted: Boolean(lifecycleStart && lifecycleStart.scanStarted),
    scanStopped: stopCompleted,
    stopRequested: Boolean(stopped && stopped.stopped),
    stopStatus: stopStatus && stopStatus.status || null,
    exportAttempted: true,
    exportSucceeded: Boolean(exported && exported.exported),
    exportAttemptStage: exported && exported.exportAttemptStage || null,
    exportAttempts: attemptSummaries,
    exportBeforeStopAttempted: beforeStopAttempts.length > 0,
    exportBeforeStopSucceeded: beforeStopAttempts.some(attempt => attempt.exported === true),
    exportRecoveredAfterStop: Boolean(exported && exported.exported && exported.exportAttemptStage === 'after-stop'),
    exportFailureBeforeStop: beforeStopAttempts.some(attempt => attempt.exported === false),
    exportLookupSource,
    exportRetrievalResolved,
    findingsApiFallbackUsed,
    findingsExportValiditySource,
    lookupDiagnostics: exportLookupDiagnostics,
    rawStatusSamples,
    inconsistencies,
    findingsCount: validity && Number.isFinite(Number(validity.findingsCount)) ? Number(validity.findingsCount) : findingsCount,
    engineSelectionRequested: lifecycleStart && lifecycleStart.engineSelectionRequested || [],
    engineSelectionAppliedToPtk: Boolean(lifecycleStart && lifecycleStart.engineSelectionAppliedToPtk),
    engineSelectionReason: lifecycleStart && lifecycleStart.engineSelectionReason || null,
    drain: drain ? {
      mode: drain.mode || 'off',
      status: drain.status || null,
      timedOut: Boolean(drain.timedOut),
      timeoutMs: drain.timeoutMs || 0,
      elapsedMs: drain.elapsedMs || 0,
      polls: drain.polls || 0,
      reason: drain.reason || null,
      classification: drain.classification || null
    } : null,
    attackCompletion,
    reason: reason || exported && exported.reason || beforeStopAttempts.find(attempt => attempt.reason) && beforeStopAttempts.find(attempt => attempt.reason).reason || stopStatus && stopStatus.reason || stopped && stopped.reason || lifecycleStart && lifecycleStart.reason || null
  };
}

function summarizePtkAttackCompletion(status = null) {
  const statusValue = unwrapPtkStatus(status);
  const engines = statusValue && statusValue.engines && typeof statusValue.engines === 'object' ? statusValue.engines : null;
  if (!engines) {
    return {
      available: false,
      partial: false,
      reason: 'ptk_status_missing_engine_progress',
      engines: {}
    };
  }
  const out = {};
  let partial = false;
  for (const [engine, engineStatus] of Object.entries(engines)) {
    const engineUpper = String(engine || '').toUpperCase();
    const progress = engineStatus && engineStatus.progress || {};
    const done = Number(progress.done);
    const total = Number(progress.total);
    const remaining = Number(progress.remaining);
    const planned = Number.isFinite(total) ? total : null;
    const completed = Number.isFinite(done) ? done : null;
    const remainingValue = Number.isFinite(remaining) ? remaining : null;
    const statusPhaseText = `${String(engineStatus && engineStatus.status || '')} ${String(engineStatus && engineStatus.phase || '')}`.trim();
    const stoppedOrCancelled = /stopp|cancel/i.test(statusPhaseText);
    const queueCount = ['activeTasks', 'taskQueue', 'requestQueue', 'pendingPlans', 'planning']
      .map(key => Number(engineStatus && engineStatus[key]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    const explicitIdle = engineStatus && engineStatus.idle === true;
  const runtime = engineRuntimeForLifecycle(engineStatus);
  const runtimeCollection = String(runtime && runtime.collectionState || '').toLowerCase();
  const runtimeAnalysis = String(runtime && runtime.analysisState || '').toLowerCase();
  const runtimeStateText = `${runtimeCollection} ${runtimeAnalysis}`;
  const runtimeLooksComplete = /waiting_for_page_activity|complete|completed|idle/.test(runtimeStateText)
    && !/analysis_running|analyzing|collection_pending|payload_received|collecting/.test(runtimeStateText);
  const runtimeAnalysisRunning = runtime && runtime.isAnalysisRunning === true && !runtimeLooksComplete;
  const sastWaitingForActivity = engineUpper === 'SAST'
      && runtimeAnalysisRunning !== true
      && runtimeLooksComplete;
    const queueEmpty = queueCount === 0 && (remainingValue === null || remainingValue === 0);
    const finitePlanComplete = planned !== null && completed !== null && completed >= planned;
    const idleNoRemaining = explicitIdle && queueEmpty && !stoppedOrCancelled;
    const stoppedNoRemaining = stoppedOrCancelled && queueEmpty;
    const finiteWaitingComplete = finitePlanComplete && queueEmpty && /idle|waiting|completed|complete|done/i.test(statusPhaseText);
    const passiveRuntimeComplete = ['IAST', 'SCA'].includes(String(engine || '').toUpperCase())
      && planned === null
      && remainingValue === null
      && queueCount === 0
      && !stoppedOrCancelled;
    const engineComplete = finitePlanComplete || idleNoRemaining || stoppedNoRemaining || finiteWaitingComplete || passiveRuntimeComplete;
    const cancelled = planned !== null && completed !== null && planned > completed && stoppedOrCancelled && !engineComplete
      ? planned - completed
      : 0;
    const enginePartial = planned !== null && completed !== null && planned > completed && !engineComplete;
    if (enginePartial) partial = true;
    out[engine] = {
      status: sastWaitingForActivity ? 'idle' : engineStatus && engineStatus.status || null,
      phase: sastWaitingForActivity ? 'waiting' : engineStatus && engineStatus.phase || null,
      planned,
      completed,
      remaining: remainingValue,
      cancelled,
      partial: enginePartial
    };
  }
  return {
    available: true,
    partial,
    reason: partial
      ? 'ptk_scan_stopped_before_all_planned_engine_tasks_completed'
      : 'ptk_engine_progress_complete_or_not_planned',
    engines: out
  };
}

function unwrapPtkStatus(value) {
  if (!value || typeof value !== 'object') return value || null;
  if (value.status && typeof value.status === 'object' && value.status.engines) return value.status;
  if (value.value && typeof value.value === 'object') return unwrapPtkStatus(value.value);
  if (value.invocation && typeof value.invocation === 'object') return unwrapPtkStatus(value.invocation.value || value.invocation);
  return value;
}

async function scenarioHandler(context = {}) {
  const { openBrowserTarget } = require('../browser/launcher.cjs');
  const ownSession = !context.page && !context.session;
  const session = context.page
    ? { page: context.page, close: async () => {} }
    : context.session || await openBrowserTarget(context);
  try {
    let preparedMacro = null;
    if (context.config.scenario
        && context.config.scenario.file
        && context.config.scenario.inputType === 'macro') {
      const macroPath = resolveScenarioFile(context.config, context.options || {});
      preparedMacro = await require('../scenario/macroLoader.cjs').loadMacroScenario(macroPath, {
        config: context.config,
        format: context.config.scenario.format || 'auto',
        cwd: context.options && context.options.cwd || process.cwd(),
        env: context.options && context.options.env || process.env
      });
    }
    const ptkStart = context.skipPtkCollection
      ? context.ptkLifecycleStart || null
      : context.ptkLifecycleStart || await beginPtkScan(session && session.page, {
        config: context.config,
        telemetry: context.telemetry,
        logger: context.logger,
        moduleResolution: context.options && context.options.moduleResolution || null
      });
    if (!context.config.scenario || !context.config.scenario.file) {
      const crawl = await crawlHandler({ ...context, session, ptkLifecycleStart: ptkStart });
      return attachSessionIfRequested({ ...crawl, scenario: { ok: false, reason: 'scenario_file_missing' } }, session, context.keepSession);
    }
    const { runScenario } = require('../scenario/scenarioWorker.cjs');
    const { createFormAttemptLedger } = require('../crawl/formWorker.cjs');
    const scenarioPath = resolveScenarioFile(context.config, context.options || {});
    const compiled = preparedMacro
      || require('../scenario/scenarioCompiler.cjs').loadScenarioFile(scenarioPath);
    const formAttemptLedger = createFormAttemptLedger();
    const scenario = await runScenario({
      scenario: compiled.scenario,
      dag: compiled.dag,
      context: {
        config: context.config,
        telemetry: context.telemetry,
        logger: context.logger,
        page: session && session.page,
        profile: context.config.profile || {},
        formAttemptLedger,
        macroRuntime: compiled.macroRuntime || null,
        scenarioRouteHints: compiled.scenario.metadata && compiled.scenario.metadata.routeHints || []
      },
      stopOnFailure: false
    });
    if (isMacroOnlyRun(context.config)) {
      const coverage = createEmptyCoverage(context.telemetry && context.telemetry.toSummary ? context.telemetry.toSummary() : {});
      coverage.scenario = summarizeScenarioStatus(scenario);
      coverage.authPreflight = buildAuthPreflightArtifact(coverage.scenario, context.config);
      coverage.execution = {
        mode: 'macro-only',
        crawlerExecuted: false,
        agentExecuted: false
      };
      if (session && session.browserSummary) coverage.browser = session.browserSummary;
      const ptk = context.skipPtkCollection ? null : await collectPtkEvidence(session && session.page, {
        config: context.config,
        telemetry: context.telemetry,
        logger: context.logger,
        lifecycleStart: ptkStart,
        redactValues: macroArtifactSensitiveValues(compiled.macroRuntime)
      });
      if (ptk) coverage.ptk = ptk;
      return attachSessionIfRequested({
        status: scenario.ok ? 'completed' : 'scenario_failed',
        routes: [],
        coverage,
        scenario
      }, session, context.keepSession);
    }
    if (!scenario.ok && context.config.scenario.continueOnFailure !== true) {
      const coverage = createEmptyCoverage(context.telemetry && context.telemetry.toSummary ? context.telemetry.toSummary() : {});
      coverage.scenario = summarizeScenarioStatus(scenario);
      coverage.authPreflight = buildAuthPreflightArtifact(coverage.scenario, context.config);
      const ptk = context.skipPtkCollection ? null : await collectPtkEvidence(session && session.page, {
        config: context.config,
        telemetry: context.telemetry,
        logger: context.logger,
        lifecycleStart: ptkStart
      });
      if (ptk) coverage.ptk = ptk;
      return attachSessionIfRequested({
        status: 'scenario_failed',
        routes: [],
        coverage,
        scenario
      }, session, context.keepSession);
    }
    const currentUrl = await currentPageUrl(session && session.page) || context.config.target.baseUrl;
    const crawl = await crawlHandler({
      ...context,
      session,
      formAttemptLedger,
      skipPtkCollection: true,
      scenarioAuthIntent: hasScenarioAuthStep(compiled.scenario),
      startUrls: [currentUrl, context.config.target.baseUrl],
      extraRoutes: compiled.scenario.metadata && compiled.scenario.metadata.routeHints || []
    });
    const coverage = { ...(crawl.coverage || {}) };
    coverage.scenario = summarizeScenarioStatus(scenario);
    coverage.authPreflight = buildAuthPreflightArtifact(coverage.scenario, context.config);
    const ptk = context.skipPtkCollection ? null : await collectPtkEvidence(session && session.page, {
      config: context.config,
      telemetry: context.telemetry,
      logger: context.logger,
      lifecycleStart: ptkStart
    });
    if (ptk) coverage.ptk = ptk;
    return attachSessionIfRequested({
      ...crawl,
      status: !scenario.ok ? 'completed_with_scenario_failure' : crawl.status,
      coverage,
      scenario
    }, session, context.keepSession);
  } finally {
    if (ownSession && !context.keepSession && session && session.close) await session.close();
  }
}

function attachSessionIfRequested(result, session, keepSession) {
  if (keepSession && result && session) {
    Object.defineProperty(result, 'session', {
      value: session,
      enumerable: false
    });
  }
  return result;
}

async function currentPageUrl(page) {
  if (!page || typeof page.url !== 'function') return null;
  try {
    return page.url();
  } catch (_) {
    return null;
  }
}

function macroArtifactSensitiveValues(macroRuntime = null) {
  const steps = macroRuntime && macroRuntime.flow && Array.isArray(macroRuntime.flow.steps)
    ? macroRuntime.flow.steps
    : [];
  const sensitiveField = /(?:password|passwd|pwd|passw|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session|jwt|bearer)/i;
  const values = Object.values(macroRuntime && macroRuntime.secrets || {})
    .filter(value => typeof value === 'string' && value.length > 0);
  for (const step of steps) {
    if (!step || step.data && step.data.kind !== 'literal') continue;
    const locatorIdentity = (step.locators || [])
      .map(locator => `${locator && locator.type || ''} ${locator && locator.value || ''}`)
      .join(' ');
    const sourceIdentity = step.source && typeof step.source === 'object'
      ? Object.entries(step.source)
        .filter(([key]) => !/value|text|data/i.test(key))
        .map(([key, value]) => `${key} ${typeof value === 'string' ? value : ''}`)
        .join(' ')
      : '';
    if (!sensitiveField.test(`${locatorIdentity} ${sourceIdentity}`)) continue;
    const value = step.data && step.data.value;
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return Array.from(new Set(values));
}

function summarizeScenarioStatus(scenario = {}) {
  const failed = (scenario.blockedSteps || []).find(step => step.type) || (scenario.blockedSteps || [])[0] || null;
  const totalSteps = scenario.dag && Array.isArray(scenario.dag.nodes) ? scenario.dag.nodes.length : (scenario.completed || 0) + (scenario.pending || []).length + (failed ? 1 : 0);
  const stepResults = (scenario.stepResults || []).map(summarizeScenarioStepResult);
  const failedStepResult = stepResults.find(step => step.ok === false) || null;
  const classifiedFailureReason = failedStepResult && failedStepResult.type === 'auth' && failedStepResult.authFailure
    ? failedStepResult.authFailure.classification
    : failed && failed.reason || null;
  return {
    status: scenario.ok ? 'completed' : 'failed',
    ok: Boolean(scenario.ok),
    completed: scenario.completed || 0,
    completedSteps: scenario.completed || 0,
    totalSteps,
    failedStepId: scenario.failedStepId || null,
    failedStep: scenario.failedStepId || failed && failed.stepId || null,
    failureReason: classifiedFailureReason,
    continueOnFailure: true,
    pending: scenario.pending || [],
    blockedSteps: scenario.blockedSteps || [],
    failedStepResult,
    stepResults,
    durationMs: scenario.timing && scenario.timing.durationMs || 0
  };
}

function summarizeScenarioStepResult(step = {}) {
  const attempt = Array.isArray(step.attempts) && step.attempts.length ? step.attempts[step.attempts.length - 1] : step;
  const result = attempt.result || {};
  return {
    stepId: step.stepId || attempt.stepId || null,
    type: step.type || attempt.type || null,
    ok: Boolean(step.ok || attempt.ok),
    error: step.error || attempt.error || null,
    success: attempt.success || null,
    reason: result.reason || result.error || null,
    url: result.url || result.pageModel && result.pageModel.url || null,
    surfaceType: result.surfaceType || result.pageModel && result.pageModel.surfaceType || null,
    authState: result.authState || null,
    authFailure: result.authFailure || null,
    confirmationVisible: result.confirmationVisible,
    cartCountAtLeast: result.cartCountAtLeast,
    cartCount: result.cartCount,
    form: summarizeScenarioFormResult(result.form),
    validationFeedback: result.validationFeedback || result.form && result.form.validationFeedback || null,
    transition: summarizeScenarioTransition(result.transition),
    observation: summarizeScenarioObservation(result.observation),
    timing: attempt.timing || null
  };
}

function buildAuthPreflightArtifact(scenarioSummary = {}, config = {}) {
  const authSteps = (scenarioSummary.stepResults || []).filter(step => step.type === 'auth');
  return {
    schemaVersion: 'ptk-agent-v2-auth-preflight',
    generatedAt: new Date().toISOString(),
    target: config.target && config.target.baseUrl || null,
    personaId: config.profile && (config.profile.activePersonaId || config.profile.personaId) || null,
    attempts: authSteps.map(step => ({
      stepId: step.stepId || null,
      loginRoute: step.url || null,
      statusCode: step.authFailure && step.authFailure.statusCode || null,
      cookieOrSessionChanged: step.authState === 'authenticated',
      classification: step.authState === 'authenticated'
        ? 'authenticated'
        : step.authFailure && step.authFailure.classification || 'unknown',
      retryable: step.authFailure ? Boolean(step.authFailure.retryable) : false,
      redactedEvidence: step.authFailure && step.authFailure.redactedEvidence || null
    })),
    summary: {
      total: authSteps.length,
      authenticated: authSteps.filter(step => step.authState === 'authenticated').length,
      rejected: authSteps.filter(step => step.authFailure && step.authFailure.classification === 'target_rejected_credentials').length,
      blocked: authSteps.filter(step => step.authFailure && /blocked|csrf|locked|rate/.test(step.authFailure.classification || '')).length
    }
  };
}

function summarizeScenarioFormResult(form = null) {
  if (!form) return null;
  return {
    formId: form.formId || null,
    submitted: form.submitted,
    skipped: form.skipped,
    reason: form.reason || null,
    submitStatus: form.submitStatus || null
  };
}

function summarizeScenarioTransition(transition = null) {
  if (!transition) return null;
  return {
    changed: transition.changed,
    noProgress: transition.noProgress,
    reason: transition.reason || null,
    signals: transition.signals || transition.reasons || []
  };
}

function summarizeScenarioObservation(observation = null) {
  if (!observation) return null;
  const events = Array.isArray(observation.events) ? observation.events : [];
  return {
    eventCount: events.length,
    events: events.slice(0, 12).map(event => ({
      type: event.type || null,
      method: event.method || null,
      path: event.path || event.url || null,
      status: event.status
    })),
    linkCount: Array.isArray(observation.links) ? observation.links.length : 0
  };
}

async function agentHandler(context = {}) {
  let missionCrawl = null;
  const { openBrowserTarget } = require('../browser/launcher.cjs');
  const ownSession = !context.page && !context.session;
  const session = context.page
    ? { page: context.page, close: async () => {} }
    : context.session || await openBrowserTarget(context);
  const ptkStart = await beginPtkScan(session && session.page, {
    config: context.config,
    telemetry: context.telemetry,
    logger: context.logger,
    moduleResolution: context.options && context.options.moduleResolution || null
  });
  writeAgentRowLifecycle(context, 'baseline_started', {
    agentProvider: context.config && context.config.agent && context.config.agent.provider || null,
    scenarioEnabled: Boolean(context.config && context.config.scenario && context.config.scenario.enabled)
  });
  const baselineContext = {
    ...context,
    session,
    keepSession: true,
    skipPtkCollection: true,
    ptkLifecycleStart: ptkStart,
    config: {
      ...context.config,
      agent: {
        ...(context.config.agent || {}),
        enabled: false,
        mode: 'off'
      }
    }
  };
  const crawl = context.config && context.config.scenario && context.config.scenario.enabled
    ? await scenarioHandler(baselineContext)
    : await crawlHandler(baselineContext);
  writeAgentRowLifecycle(context, 'baseline_completed', {
    status: crawl && crawl.status || null,
    scenarioStatus: crawl && crawl.coverage && crawl.coverage.scenario && crawl.coverage.scenario.status || null,
    routesVisited: crawl && crawl.coverage && crawl.coverage.summary && crawl.coverage.summary.routesVisited || 0
  });
  flushAgentBaselineArtifacts(context, crawl);
  const baselineSkipReason = agentBaselineSkipReason(crawl, context);
  if (baselineSkipReason) {
    writeAgentRowLifecycle(context, 'agent_skipped', {
      reason: baselineSkipReason,
      baselineStatus: crawl && crawl.status || null,
      scenarioStatus: crawl && crawl.coverage && crawl.coverage.scenario && crawl.coverage.scenario.status || null,
      scenarioFailureReason: crawl && crawl.coverage && crawl.coverage.scenario && crawl.coverage.scenario.failureReason || null
    });
    const coverage = await collectFinalPtkCoverageForAgentSkip({
      baselineCoverage: crawl.coverage,
      context,
      session,
      lifecycleStart: ptkStart,
      reason: baselineSkipReason
    });
    const skippedAgent = finalizeAgentFindingArtifacts({
      agent: buildAgentSkippedForBaseline(crawl.coverage, baselineSkipReason),
      baselineCoverage: crawl.coverage,
      finalCoverage: coverage
    });
    return {
      ...crawl,
      status: baselineSkipReason === 'baseline_scenario_failed'
        ? 'skipped_baseline_scenario_failed'
        : 'skipped_baseline_incomplete',
      coverage,
      agent: skippedAgent
    };
  }
  try {
    const analysisEvidence = resolveAnalysisEvidenceForRun(context.config, context);
    const agentLivePageRecenter = await recenterAgentLivePageForPlanning({
      session,
      context
    });
    const preAgentPtkDrain = await drainPtkForAgentPlanning({
      page: session && session.page,
      context,
      lifecycleStart: ptkStart
    });
    const preAgentPtkSignals = await collectAgentPlanningPtkSignals(session && session.page, {
      config: context.config,
      lifecycleStart: ptkStart,
      planningDrain: preAgentPtkDrain,
      telemetry: context.telemetry,
      logger: context.logger
    });
    if (preAgentPtkSignals) {
      writeAgentRowLifecycle(context, 'ptk_agent_signals_collected', {
        findingsCount: preAgentPtkSignals.findingsCount || 0,
        statusOk: Boolean(preAgentPtkSignals.statusOk),
        reason: preAgentPtkSignals.reason || null
      });
    }
    const { runAgentManagerV2 } = require('../agent/managerLoop.cjs');
    const explicitScenarioSetup = context.options && context.options.scenarioSetup === 'explicit';
    const missionCoverage = preAgentPtkSignals
      ? { ...(crawl.coverage || {}), agentPtkSignals: preAgentPtkSignals }
      : crawl.coverage;
    const missionEvidence = mergeMissionEvidence({
      routeHints: explicitScenarioSetup
        ? resolveScenarioRouteHints(context.config, context.options || {}).map(hint => resolveRouteHint(context.config.target.baseUrl, hint))
        : [],
      ptkSignals: preAgentPtkSignals || null
    }, analysisEvidence);
    const agentExecutionContext = {
      baselineComplete: true,
      coverage: missionCoverage,
      cwd: context.options && context.options.cwd || process.cwd(),
      liveSession: Boolean(session && session.page),
      session,
      agentPtkSignals: preAgentPtkSignals || null,
      scenarioVariant: context.options && context.options.scenarioVariant || null,
      scenarioSetup: context.options && context.options.scenarioSetup || null,
      noScenarioMode: context.options && (context.options.scenarioVariant === 'no-scenario' || context.options.scenarioSetup === 'auth-only'),
      agentLivePageRecenter,
      writeRowLifecycle(type, details = {}) {
        return writeAgentRowLifecycle(context, type, details);
      }
    };
    writeAgentRowLifecycle(context, 'agent_started', {
      effectiveMaxTurns: context.config && context.config.agent && context.config.agent.maxTurns || null
    });
    let agent;
    try {
      agent = await runAgentManagerV2({
      config: context.config,
      coverage: missionCoverage,
      evidence: missionEvidence,
      context: agentExecutionContext,
      telemetry: context.telemetry,
      handlers: createAgentMissionHandlers({
        context,
        session,
        baselineCoverage: crawl.coverage,
        setMissionCrawl(value) {
          missionCrawl = value;
        }
      })
      });
      writeAgentRowLifecycle(context, 'agent_completed', {
        status: agent && agent.status || null,
        stopReason: agent && agent.telemetry && agent.telemetry.stopReason || null,
        turns: Array.isArray(agent && agent.turns) ? agent.turns.length : 0
      });
    } catch (err) {
      writeAgentRowLifecycle(context, 'agent_failed', {
        error: err.message,
        code: err.code || null
      });
      agent = buildAgentFailureForBaseline(crawl.coverage, err);
    }
    const selectedMission = agent && agent.choices && agent.choices[0]
      ? (agent.missions || []).find(mission => mission.id === agent.choices[0].missionId)
      : null;
    const coverage = coverageAfterAgentWork({
      baselineCoverage: crawl.coverage,
      missionCrawl,
      agentContext: agentExecutionContext
    });
    const agentPtkSignalReason = [
      preAgentPtkSignals && preAgentPtkSignals.reason,
      preAgentPtkSignals && preAgentPtkSignals.statusReason
    ].filter(Boolean).join(' ');
    const recoverFromSessionLookup = /session[_ -]?not[_ -]?found/i.test(agentPtkSignalReason);
    const postAgentPtkDrain = await drainPtkForAgentFinalExport({
      page: session && session.page,
      context,
      lifecycleStart: ptkStart
    });
    writeAgentRowLifecycle(context, 'ptk_collect_started', {
      preferStatusPage: recoverFromSessionLookup,
      ignoreSessionId: recoverFromSessionLookup,
      reason: recoverFromSessionLookup ? 'pre_agent_session_lookup_failed' : null,
      postAgentDrainStatus: postAgentPtkDrain && postAgentPtkDrain.status || null,
      postAgentDrainReason: postAgentPtkDrain && postAgentPtkDrain.reason || null
    });
    const ptk = await collectPtkEvidence(session && session.page, {
      config: context.config,
      telemetry: context.telemetry,
      logger: context.logger,
      lifecycleStart: ptkStart,
      preferStatusPage: recoverFromSessionLookup,
      ignoreSessionId: recoverFromSessionLookup,
      preDrain: postAgentPtkDrain === undefined ? undefined : postAgentPtkDrain
    });
    writeAgentRowLifecycle(context, 'ptk_collect_completed', {
      exported: Boolean(ptk && ptk.exported),
      reason: ptk && ptk.reason || null
    });
    if (ptk) coverage.ptk = ptk;
    const finalizedAgent = finalizeAgentFindingArtifacts({
      agent,
      baselineCoverage: missionCoverage,
      finalCoverage: coverage
    });
    return {
      ...crawl,
      coverage,
      agent: {
        ...finalizedAgent,
        selectedMission,
        missionCrawl: missionCrawl && {
          status: missionCrawl.status,
          coverageSummary: missionCrawl.coverage && missionCrawl.coverage.summary
        }
      }
    };
  } finally {
    if (ownSession && !context.keepSession && session && session.close) await session.close();
  }
}

async function recenterAgentLivePageForPlanning({ session = null, context = {} } = {}) {
  const page = session && session.page;
  const config = context.config || {};
  const baseUrl = config.target && config.target.baseUrl;
  if (!page || !baseUrl || typeof page.url !== 'function') return { recentered: false, reason: 'page_or_base_url_missing' };
  const currentUrl = safePageUrl(page);
  const recenterDecision = shouldRecenterAgentLivePage(currentUrl, baseUrl);
  if (!recenterDecision.recenter) {
    return { recentered: false, reason: 'current_page_is_app_surface', fromUrl: currentUrl };
  }
  writeAgentRowLifecycle(context, 'agent_live_page_recenter_started', {
    fromUrl: currentUrl,
    toUrl: baseUrl,
    reason: recenterDecision.reason
  });
  const timeout = Math.max(1000, Math.min(Number(config.crawler && config.crawler.maxRouteMs) || 5000, 5000));
  try {
    await page.goto(baseUrl, {
      waitUntil: 'commit',
      timeout
    });
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(Math.min(Number(config.crawler && config.crawler.maxObservationMs) || 500, 500)).catch(() => {});
    }
    const toUrl = safePageUrl(page);
    writeAgentRowLifecycle(context, 'agent_live_page_recenter_completed', {
      fromUrl: currentUrl,
      toUrl,
      sameSession: true
    });
    return {
      recentered: true,
      reason: recenterDecision.reason,
      fromUrl: currentUrl,
      toUrl,
      sameSession: true
    };
  } catch (error) {
    const fallback = await fallbackRecenterWithLocationAssign(page, baseUrl, config).catch(fallbackError => ({
      ok: false,
      error: fallbackError && fallbackError.message || String(fallbackError || 'fallback_recenter_failed')
    }));
    if (fallback && fallback.ok) {
      const toUrl = safePageUrl(page);
      writeAgentRowLifecycle(context, 'agent_live_page_recenter_completed', {
        fromUrl: currentUrl,
        toUrl,
        sameSession: true,
        fallback: fallback.method,
        initialError: error && error.message || String(error || 'recenter_failed')
      });
      return {
        recentered: true,
        reason: recenterDecision.reason,
        fromUrl: currentUrl,
        toUrl,
        sameSession: true,
        fallback: fallback.method,
        initialError: error && error.message || String(error || 'recenter_failed')
      };
    }
    const postErrorCheck = await checkRecenterAfterNavigationRace(page, baseUrl, config).catch(checkError => ({
      ok: false,
      error: checkError && checkError.message || String(checkError || 'post_error_recenter_check_failed')
    }));
    if (postErrorCheck && postErrorCheck.ok) {
      const toUrl = safePageUrl(page);
      writeAgentRowLifecycle(context, 'agent_live_page_recenter_completed', {
        fromUrl: currentUrl,
        toUrl,
        sameSession: true,
        fallback: postErrorCheck.method,
        initialError: error && error.message || String(error || 'recenter_failed'),
        fallbackError: fallback && fallback.error || null
      });
      return {
        recentered: true,
        reason: recenterDecision.reason,
        fromUrl: currentUrl,
        toUrl,
        sameSession: true,
        fallback: postErrorCheck.method,
        initialError: error && error.message || String(error || 'recenter_failed'),
        fallbackError: fallback && fallback.error || null
      };
    }
    writeAgentRowLifecycle(context, 'agent_live_page_recenter_failed', {
      fromUrl: currentUrl,
      toUrl: baseUrl,
      error: error && error.message || String(error || 'recenter_failed'),
      fallbackError: fallback && fallback.error || null
    });
    return {
      recentered: false,
      reason: 'recenter_failed',
      fromUrl: currentUrl,
      toUrl: baseUrl,
      error: error && error.message || String(error || 'recenter_failed'),
      fallbackError: fallback && fallback.error || null
    };
  }
}

async function checkRecenterAfterNavigationRace(page, baseUrl, config = {}) {
  if (!page || !baseUrl) return { ok: false, error: 'page_or_base_url_missing' };
  const waitMs = Math.max(100, Math.min(Number(config.crawler && config.crawler.maxObservationMs) || 500, 1000));
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('domcontentloaded', { timeout: waitMs }).catch(() => {});
  }
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(waitMs).catch(() => {});
  const currentUrl = safePageUrl(page);
  const decision = shouldRecenterAgentLivePage(currentUrl, baseUrl);
  return {
    ok: decision.recenter === false,
    method: 'post-error-url-check',
    currentUrl,
    decision
  };
}

async function fallbackRecenterWithLocationAssign(page, baseUrl, config = {}) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, error: 'page_evaluate_unavailable' };
  await page.evaluate(url => {
    window.location.assign(url);
  }, baseUrl);
  const waitMs = Math.max(100, Math.min(Number(config.crawler && config.crawler.maxObservationMs) || 500, 1000));
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(waitMs).catch(() => {});
  const currentUrl = safePageUrl(page);
  const decision = shouldRecenterAgentLivePage(currentUrl, baseUrl);
  return {
    ok: decision.recenter === false,
    method: 'location.assign',
    currentUrl,
    decision
  };
}

function shouldRecenterAgentLivePage(currentUrl, baseUrl) {
  if (!currentUrl || !baseUrl) return { recenter: false, reason: 'missing_url' };
  let current;
  let base;
  try {
    base = new URL(baseUrl);
    current = new URL(currentUrl, base);
  } catch (_) {
    return { recenter: false, reason: 'invalid_url' };
  }
  if (current.origin !== base.origin) return { recenter: true, reason: 'off_origin' };
  const pathname = current.pathname || '/';
  if (/\/(?:ftp|assets?|static|public|uploads?|download)(?:\/|$)/i.test(pathname)) return { recenter: true, reason: 'terminal_or_static_document' };
  if (/\.(?:md|txt|json|xml|csv|log|pdf|zip|gz|tar|7z|xls|xlsx|doc|docx|png|jpe?g|gif|svg|webp|ico|map|js|css)$/i.test(pathname)) {
    return { recenter: true, reason: 'terminal_or_static_document' };
  }
  if (!isAgentPlanningEntrypoint(current, base)) {
    return { recenter: true, reason: 'agent_planning_entrypoint' };
  }
  return { recenter: false, reason: 'current_page_is_app_surface' };
}

function isAgentPlanningEntrypoint(current, base) {
  if (!current || !base) return false;
  const basePath = normalizePathForCompare(base.pathname || '/');
  const currentPath = normalizePathForCompare(current.pathname || '/');
  if (current.origin !== base.origin || currentPath !== basePath) return false;
  const hash = String(current.hash || '');
  return !hash || hash === '#/' || hash === '#!/';
}

function normalizePathForCompare(pathname = '/') {
  const normalized = String(pathname || '/').replace(/\/+$/, '');
  return normalized || '/';
}

function safePageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? page.url() : null;
  } catch (_) {
    return null;
  }
}

function finalizeAgentFindingArtifacts({ agent = null, baselineCoverage = {}, finalCoverage = {} } = {}) {
  if (!agent || typeof agent !== 'object') return agent;
  const { createFindingFingerprintDiff } = require('./findingDiff.cjs');
  const findingFingerprintDiff = createFindingFingerprintDiff({
    baseline: baselineCoverage || {},
    final: finalCoverage || {},
    agent
  });
  return {
    ...agent,
    findingFingerprintDiff,
    baselinePreservation: {
      ...(agent.baselinePreservation || {}),
      baselineUniqueFindings: findingFingerprintDiff.baselineUniqueFindings,
      finalUniqueFindings: findingFingerprintDiff.finalUniqueFindings,
      agentAddedUniqueFindings: findingFingerprintDiff.agentAddedUniqueFindings,
      agentLostUniqueFindings: findingFingerprintDiff.agentLostUniqueFindings,
      agentRegression: findingFingerprintDiff.agentRegression,
      findingComparisonReliable: findingFingerprintDiff.comparisonReliable,
      findingComparisonReason: findingFingerprintDiff.comparisonReason,
      findingBaselineSource: findingFingerprintDiff.baselineSource,
      findingFinalSource: findingFingerprintDiff.finalSource
    }
  };
}

function coverageAfterAgentWork({ baselineCoverage = {}, missionCrawl = null, agentContext = null } = {}) {
  let coverage = { ...(baselineCoverage || {}) };
  const agentCoverage = agentContext && agentContext.coverage;
  if (agentCoverage && agentCoverage !== baselineCoverage) {
    coverage = preserveBaselineRuntimeCoverage(mergeCoverage({}, agentCoverage), baselineCoverage);
  }
  if (missionCrawl && missionCrawl.coverage) {
    coverage = mergeCoverage(coverage, missionCrawl.coverage);
  }
  return coverage;
}

function preserveBaselineRuntimeCoverage(coverage = {}, baselineCoverage = {}) {
  for (const key of [
    'runHeartbeat',
    'browserRuntimeSummary',
    'routeLifecycle',
    'routeStatusSummary',
    'terminalDocumentSummary',
    'formAttemptSummary',
    'browserProbeSummary',
    'surfaceExplorerSummary',
    'authSurfaceSummary',
    'routeSourceSummary',
    'stateKeySummary'
  ]) {
    if (baselineCoverage[key] !== undefined && baselineCoverage[key] !== null) {
      coverage[key] = baselineCoverage[key];
    }
  }
  return coverage;
}

async function drainPtkForAgentPlanning({ page = null, context = {}, lifecycleStart = null } = {}) {
  return drainPtkForAgentPhase({
    page,
    context,
    lifecycleStart,
    eventPrefix: 'ptk_agent_planning_drain',
    failureReason: 'ptk_agent_planning_drain_failed'
  });
}

async function drainPtkForAgentFinalExport({ page = null, context = {}, lifecycleStart = null } = {}) {
  return drainPtkForAgentPhase({
    page,
    context,
    lifecycleStart,
    eventPrefix: 'ptk_agent_post_actions_drain',
    failureReason: 'ptk_agent_post_actions_drain_failed'
  });
}

async function drainPtkForAgentPhase({ page = null, context = {}, lifecycleStart = null, eventPrefix = 'ptk_agent_drain', failureReason = 'ptk_agent_drain_failed' } = {}) {
  const config = context.config || {};
  const ptk = config.ptk || {};
  if (!page || !ptk || ptk.enabled === false || !lifecycleStart || !lifecycleStart.bridgeDetected) return null;
  const drainMode = String(ptk.drainMode || '').toLowerCase();
  const explicitDrain = drainMode && drainMode !== 'off';
  if (!explicitDrain && ptk.requireAttackCompletion !== true && ptk.stopWaitForIdle !== true) return null;
  const sessionId = ptkSessionIdFromLifecycleStart(lifecycleStart);
  const bridge = lifecycleStart.start && lifecycleStart.start.bridge || null;
  writeAgentRowLifecycle(context, `${eventPrefix}_started`, {
    mode: drainMode || null,
    requireAttackCompletion: Boolean(ptk.requireAttackCompletion),
    sessionId: sessionId ? '[REDACTED]' : null
  });
  try {
    const drain = await drainPtkBeforeStop(page, config, context.logger, context.telemetry, bridge, sessionId);
    writeAgentRowLifecycle(context, `${eventPrefix}_completed`, {
      status: drain && drain.status || null,
      reason: drain && drain.reason || null,
      timedOut: Boolean(drain && drain.timedOut),
      classification: drain && drain.classification || null
    });
    return drain;
  } catch (error) {
    writeAgentRowLifecycle(context, `${eventPrefix}_failed`, {
      error: error && error.message || String(error || failureReason)
    });
    return {
      status: 'failed',
      reason: error && error.message || String(error || failureReason),
      timedOut: false
    };
  }
}

async function collectAgentPlanningPtkSignals(page, { config = {}, lifecycleStart = null, planningDrain = null, telemetry = null, logger = null } = {}) {
  if (!page || !config.ptk || config.ptk.enabled === false) return null;
  const sessionId = ptkSessionIdFromLifecycleStart(lifecycleStart);
  const sessionOption = sessionId ? { sessionId } : {};
  const lifecycleBridge = lifecycleStart && lifecycleStart.start && lifecycleStart.start.bridge && lifecycleStart.start.bridge.available
    ? lifecycleStart.start.bridge
    : null;
  const primaryTimeoutMs = Math.max(500, Math.min(ptkOperationTimeoutMs(config), 5000));
  const fallbackTimeoutMs = Math.max(primaryTimeoutMs, Math.min(ptkDrainStatusReadTimeoutMs(config), 15000));
  const { readPtkStatus, getPtkFindings, waitForPtkBridge } = require('../browser/ptkBridge.cjs');
  const { redactPtkSecrets } = require('../evidence/ptkEvidenceAdapter.cjs');
  const readSnapshot = async (targetPage, { bridge = null, source = 'current-page', timeoutMs = primaryTimeoutMs } = {}) => {
    const readOnce = async (bridgeOverride = null, attemptSource = source) => {
      const bridgeOption = bridgeOverride && bridgeOverride.available ? { bridge: bridgeOverride } : {};
      let status = null;
      let findings = null;
      try {
        status = await readPtkStatus(targetPage, {
          ...(config.ptk || {}),
          ...bridgeOption,
          timeoutMs,
          lowLevelTimeoutMs: Math.max(500, Math.min(timeoutMs, 4000)),
          statusOptions: sessionOption
        });
      } catch (error) {
        status = {
          ok: false,
          reason: error && error.message || String(error || 'ptk_status_read_failed')
        };
      }
      try {
        findings = await getPtkFindings(targetPage, {
          ...(config.ptk || {}),
          ...bridgeOption,
          timeoutMs,
          limit: Math.min(Number(config.ptk && config.ptk.findingsLimit || config.ptk && config.ptk.limit || 50) || 50, 50),
          findingsOptions: {
            ...sessionOption,
            limit: Math.min(Number(config.ptk && config.ptk.findingsLimit || config.ptk && config.ptk.limit || 50) || 50, 50)
          }
        });
      } catch (error) {
        findings = {
          ok: false,
          findings: [],
          reason: error && error.message || String(error || 'ptk_findings_read_failed')
        };
      }
      return { source: attemptSource, status, findings, timeoutMs };
    };
    const first = await readOnce(bridge, source);
    if (!agentPlanningSnapshotBridgeMissing(first)) return first;
    const bridgeWaitTimeoutMs = Math.max(500, Math.min(timeoutMs, 3000));
    const waitedBridge = await waitForPtkBridge(targetPage, {
      ...(config.ptk || {}),
      timeoutMs: bridgeWaitTimeoutMs,
      probeMetadata: false
    }).catch(() => null);
    if (!waitedBridge || !waitedBridge.available) return first;
    const retry = await readOnce(waitedBridge, `${source}-bridge-wait`);
    return {
      ...retry,
      bridgeWaited: true,
      bridgeWait: {
        attempted: true,
        timeoutMs: bridgeWaitTimeoutMs,
        source: waitedBridge.source || null,
        initialStatusReason: first.status && first.status.reason || null,
        initialFindingsReason: first.findings && first.findings.reason || null
      }
    };
  };
  const attempts = [];
  let snapshot = await readSnapshot(page, {
    bridge: lifecycleBridge,
    source: lifecycleBridge ? 'current-page-lifecycle-bridge' : 'current-page',
    timeoutMs: primaryTimeoutMs
  });
  attempts.push(summarizeAgentPlanningSignalAttempt(snapshot));
  let statusPage = null;
  if (shouldRetryAgentPlanningSignals(snapshot)) {
    statusPage = await openPtkStatusPage(page, config, fallbackTimeoutMs).catch(() => null);
    if (statusPage) {
      const fallbackSnapshot = await readSnapshot(statusPage, {
        bridge: null,
        source: 'status-page',
        timeoutMs: fallbackTimeoutMs
      });
      attempts.push(summarizeAgentPlanningSignalAttempt(fallbackSnapshot));
      if (agentPlanningSnapshotScore(fallbackSnapshot) >= agentPlanningSnapshotScore(snapshot)) {
        snapshot = fallbackSnapshot;
      }
    }
  }
  if (shouldTryAgentPlanningExport(snapshot, config)) {
    const exportPage = statusPage || page;
    const exportSnapshot = await readAgentPlanningExportSnapshot(exportPage, {
      config,
      sessionOption,
      bridge: exportPage === page ? lifecycleBridge : null,
      source: exportPage === page ? 'current-page-export' : 'status-page-export',
      timeoutMs: Math.max(fallbackTimeoutMs, Math.min(ptkExportOperationTimeoutMs(config), 15000)),
      previousStatus: snapshot.status
    });
    attempts.push(summarizeAgentPlanningSignalAttempt(exportSnapshot));
    if (agentPlanningSnapshotScore(exportSnapshot) >= agentPlanningSnapshotScore(snapshot)) {
      snapshot = exportSnapshot;
    }
  }
  if (statusPage && typeof statusPage.close === 'function') {
    await statusPage.close().catch(() => {});
  }
  const status = snapshot.status;
  const findings = snapshot.findings;
  const findingsList = Array.isArray(findings && findings.findings) ? findings.findings : [];
  const statusValue = status && status.status || null;
  const bridgeDetected = Boolean(
    status && status.available ||
    findings && findings.available ||
    lifecycleBridge && lifecycleBridge.available
  );
  const findingsCount = findingsList.length;
  const reason = findings && findings.reason || status && status.reason || null;
  const artifact = {
    schemaVersion: 'ptk-agent-v2-agent-planning-ptk-signals',
    generatedAt: new Date().toISOString(),
    source: 'pre-agent-ptk-snapshot',
    signalSource: snapshot.source,
    sessionId,
    bridgeSource: lifecycleBridge && lifecycleBridge.source || status && status.bridge && status.bridge.source || findings && findings.bridge && findings.bridge.source || null,
    bridgeReusedFromLifecycleStart: Boolean(lifecycleBridge && snapshot.source !== 'status-page'),
    statusOk: Boolean(status && status.ok),
    statusReason: status && status.reason || null,
    findingsOk: Boolean(findings && findings.ok),
    findingsCount,
    findings: redactPtkSecrets(findingsList.slice(0, 50)),
    lookupDiagnostics: findings && findings.lookupDiagnostics || status && status.lookupDiagnostics || null,
    exportLookupSource: findings && findings.exportLookupSource || null,
    findingsApiFallbackUsed: Boolean(findings && findings.findingsApiFallbackUsed),
    findingsExportValiditySource: findings && findings.findingsExportValiditySource || 'none',
    signalCollectionAttempts: attempts,
    planningDrain: planningDrain ? {
      mode: planningDrain.mode || null,
      status: planningDrain.status || null,
      reason: planningDrain.reason || null,
      timedOut: Boolean(planningDrain.timedOut),
      classification: planningDrain.classification || null
    } : null,
    lifecycle: {
      bridgeDetected,
      scanStarted: Boolean(lifecycleStart && lifecycleStart.scanStarted),
      status: statusValue
    },
    reason,
    diagnosticOnly: true
  };
  if (telemetry && typeof telemetry.event === 'function') {
    telemetry.event('agent.ptkSignals.snapshot', {
      statusOk: artifact.statusOk,
      findingsOk: artifact.findingsOk,
      findingsCount: artifact.findingsCount,
      signalSource: artifact.signalSource
    });
  }
  if (logger && typeof logger.debug === 'function' && !artifact.statusOk && !artifact.findingsOk) {
    logger.debug('agent PTK planning signals unavailable', artifact.reason);
  }
  return artifact;
}

function shouldRetryAgentPlanningSignals(snapshot = {}) {
  if (!snapshot) return false;
  const status = snapshot.status || {};
  const findings = snapshot.findings || {};
  if (findings.ok && Array.isArray(findings.findings)) return false;
  return shouldUsePtkStatusPageFallback(status) || shouldUsePtkStatusPageFallback(findings);
}

function agentPlanningSnapshotBridgeMissing(snapshot = {}) {
  if (!snapshot) return false;
  const status = snapshot.status || {};
  const findings = snapshot.findings || {};
  if (status.ok || findings.ok) return false;
  const reason = [
    status.reason,
    status.error,
    status.invocation && (status.invocation.reason || status.invocation.error),
    findings.reason,
    findings.error,
    findings.invocation && (findings.invocation.reason || findings.invocation.error)
  ].filter(Boolean).join(' ');
  return /bridge_missing|not_detected|method_missing/i.test(reason);
}

function shouldTryAgentPlanningExport(snapshot = {}, config = {}) {
  if (!config || !config.ptk || config.ptk.allowPlanningExportFallback !== true) return false;
  const findings = snapshot && snapshot.findings || {};
  if (findings.ok && Array.isArray(findings.findings)) return false;
  return shouldRetryAgentPlanningSignals(snapshot);
}

async function readAgentPlanningExportSnapshot(page, { config = {}, sessionOption = {}, bridge = null, source = 'export', timeoutMs = 10000, previousStatus = null } = {}) {
  const { exportPtkEvidence } = require('../browser/ptkBridge.cjs');
  const bridgeOption = bridge && bridge.available ? { bridge } : {};
  let exported = null;
  try {
    exported = await exportPtkEvidence(page, {
      ...(config.ptk || {}),
      ...bridgeOption,
      timeoutMs,
      includeStatus: false,
      includeFindings: false,
      exportOptions: {
        ...sessionOption,
        engine: config.ptk && config.ptk.engine || 'ALL',
        transfer: config.ptk && config.ptk.transfer || 'retrieval-plan',
        includeSecrets: false
      }
    });
  } catch (error) {
    exported = {
      available: true,
      exported: false,
      findings: [],
      reason: error && error.message || String(error || 'agent_planning_export_failed')
    };
  }
  const findings = Array.isArray(exported && exported.findings) ? exported.findings : [];
  return {
    source,
    status: previousStatus || {
      ok: false,
      reason: 'status_not_read_for_export_fallback'
    },
    findings: {
      available: Boolean(exported && exported.available),
      ok: Boolean(exported && (exported.exportRetrievalResolved || exported.exported || findings.length > 0)),
      findings,
      reason: exported && exported.reason || (findings.length ? 'findings_collected_from_export' : 'agent_planning_export_unavailable'),
      bridge: exported && exported.bridge || null,
      lookupDiagnostics: exported && exported.lookupDiagnostics || null,
      exportLookupSource: exported && exported.exportLookupSource || null,
      findingsApiFallbackUsed: false,
      findingsExportValiditySource: exported && exported.findingsExportValiditySource || (findings.length ? 'export' : 'none')
    },
    timeoutMs,
    exportAttempted: true,
    exportSucceeded: Boolean(exported && exported.exported),
    exportRetrievalResolved: Boolean(exported && exported.exportRetrievalResolved)
  };
}

function agentPlanningSnapshotScore(snapshot = {}) {
  const status = snapshot.status || {};
  const findings = snapshot.findings || {};
  const findingsCount = Array.isArray(findings.findings) ? findings.findings.length : 0;
  return (findings.ok ? 1000 : 0)
    + Math.min(findingsCount, 100)
    + (status.ok ? 50 : 0)
    + (status.available || findings.available ? 10 : 0);
}

function summarizeAgentPlanningSignalAttempt(snapshot = {}) {
  const findings = snapshot.findings || {};
  const status = snapshot.status || {};
  return {
    source: snapshot.source || null,
    timeoutMs: snapshot.timeoutMs || null,
    statusOk: Boolean(status.ok),
    statusReason: status.reason || null,
    findingsOk: Boolean(findings.ok),
    findingsCount: Array.isArray(findings.findings) ? findings.findings.length : 0,
    findingsReason: findings.reason || null,
    bridgeSource: status.bridge && status.bridge.source || findings.bridge && findings.bridge.source || null,
    bridgeWaited: Boolean(snapshot.bridgeWaited),
    bridgeWait: snapshot.bridgeWait || null,
    exportAttempted: Boolean(snapshot.exportAttempted),
    exportSucceeded: Boolean(snapshot.exportSucceeded),
    exportRetrievalResolved: Boolean(snapshot.exportRetrievalResolved)
  };
}

function writeAgentRowLifecycle(context = {}, type, details = {}) {
  const outputDir = context.config && context.config.artifacts && context.config.artifacts.outputDir;
  if (!outputDir || !type) return null;
  try {
    return appendJsonl(outputDir, ARTIFACT_FILENAMES.rowLifecycleEvents, {
      schemaVersion: 'ptk-agent-v2-agent-row-lifecycle',
      timestamp: new Date().toISOString(),
      type,
      ...details
    });
  } catch (_) {
    return null;
  }
}

function flushAgentBaselineArtifacts(context = {}, crawl = {}) {
  const outputDir = context.config && context.config.artifacts && context.config.artifacts.outputDir;
  if (!outputDir || !crawl || !crawl.coverage) return null;
  try {
    const files = writeStandardArtifacts(outputDir, {
      config: context.config,
      telemetry: context.telemetry,
      coverage: crawl.coverage,
      events: context.telemetry && context.telemetry.events || []
    });
    writeJson(outputDir, ARTIFACT_FILENAMES.agentBaselinePreservation, {
      schemaVersion: 'ptk-agent-v2-agent-baseline-preservation',
      stage: 'post-baseline-pre-agent',
      generatedAt: new Date().toISOString(),
      baselineRoutes: crawl.coverage && crawl.coverage.summary && crawl.coverage.summary.routesVisited || 0,
      baselineEndpoints: crawl.coverage && crawl.coverage.summary && crawl.coverage.summary.endpointsObserved || 0,
      baselineFindings: crawl.coverage && crawl.coverage.ptk && crawl.coverage.ptk.findings && crawl.coverage.ptk.findings.count || 0,
      agentAddedRoutes: 0,
      agentAddedFindings: 0,
      agentFailureAffectedBaseline: false
    });
    return files;
  } catch (_) {
    return null;
  }
}

function agentBaselineSkipReason(crawl = {}, context = {}) {
  if (context && context.options && context.options.agentAllowScenarioUnblock === true) return null;
  const scenarioEnabled = Boolean(context && context.config && context.config.scenario && context.config.scenario.enabled);
  if (!scenarioEnabled) return null;
  const scenario = crawl && crawl.coverage && crawl.coverage.scenario || null;
  if (scenario && scenario.ok === false) return 'baseline_scenario_failed';
  const status = String(crawl && crawl.status || '');
  if (/scenario_failed|completed_with_scenario_failure/i.test(status)) return 'baseline_scenario_failed';
  return null;
}

async function collectFinalPtkCoverageForAgentSkip({ baselineCoverage = {}, context = {}, session = null, lifecycleStart = null, reason = 'agent_skipped' } = {}) {
  const coverage = { ...(baselineCoverage || {}) };
  const postAgentPtkDrain = await drainPtkForAgentFinalExport({
    page: session && session.page,
    context,
    lifecycleStart
  });
  writeAgentRowLifecycle(context, 'ptk_collect_started', {
    preferStatusPage: false,
    ignoreSessionId: false,
    reason,
    postAgentDrainStatus: postAgentPtkDrain && postAgentPtkDrain.status || null,
    postAgentDrainReason: postAgentPtkDrain && postAgentPtkDrain.reason || null
  });
  const ptk = await collectPtkEvidence(session && session.page, {
    config: context.config,
    telemetry: context.telemetry,
    logger: context.logger,
    lifecycleStart,
    preDrain: postAgentPtkDrain === undefined ? undefined : postAgentPtkDrain
  });
  writeAgentRowLifecycle(context, 'ptk_collect_completed', {
    exported: Boolean(ptk && ptk.exported),
    reason: ptk && ptk.reason || null
  });
  if (ptk) coverage.ptk = ptk;
  return coverage;
}

function buildAgentSkippedForBaseline(baselineCoverage = {}, reason = 'baseline_incomplete') {
  return {
    status: 'skipped',
    actual: 'off',
    requested: 'agent',
    telemetry: {
      actualMode: 'off',
      stopReason: reason,
      fallbackReason: reason
    },
    turns: [],
    choices: [],
    results: [],
    executionResults: [],
    actionPlans: [],
    missions: [],
    coverageDelta: {
      schemaVersion: 'ptk-agent-v2-coverage-delta',
      total: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 },
      perTurn: []
    },
    baselinePreservation: {
      schemaVersion: 'ptk-agent-v2-baseline-preservation',
      baselineRoutes: baselineCoverage && baselineCoverage.summary && baselineCoverage.summary.routesVisited || 0,
      baselineEndpoints: baselineCoverage && baselineCoverage.summary && baselineCoverage.summary.endpointsObserved || 0,
      baselineFindings: baselineCoverage && baselineCoverage.ptk && baselineCoverage.ptk.findings && baselineCoverage.ptk.findings.count || 0,
      agentAddedRoutes: 0,
      agentAddedEndpoints: 0,
      agentAddedFindings: 0,
      agentFailureAffectedBaseline: false,
      skipReason: reason
    },
    providerDecisionQuality: {
      schemaVersion: 'ptk-agent-v2-provider-decision-quality',
      status: 'skipped',
      reason,
      decisions: []
    },
    missionCompilerSummary: {
      schemaVersion: 'ptk-agent-v2-mission-compiler-summary',
      offered: [],
      suppressed: [],
      skipped: [],
      countsByKind: {},
      suppressionReasons: {}
    },
    riskPolicy: {
      schemaVersion: 'ptk-agent-v2-risk-policy',
      riskMode: 'safe',
      allowBusinessMutations: false,
      allowDestructiveActions: false,
      requireSuccess: false
    }
  };
}

function buildAgentFailureForBaseline(baselineCoverage = {}, err = {}) {
  return {
    status: 'failed',
    telemetry: {
      stopReason: err && err.code === 'ETIMEDOUT' ? 'provider_timeout' : 'agent_execution_failed'
    },
    turns: [],
    choices: [],
    results: [],
    executionResults: [],
    actionPlans: [],
    coverageDelta: {
      total: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, findings: 0 }
    },
    baselinePreservation: {
      baselineRoutes: baselineCoverage && baselineCoverage.summary && baselineCoverage.summary.routesVisited || 0,
      baselineFindings: baselineCoverage && baselineCoverage.ptk && baselineCoverage.ptk.findings && baselineCoverage.ptk.findings.count || 0,
      agentAddedRoutes: 0,
      agentAddedFindings: 0,
      agentFailureAffectedBaseline: false
    },
    providerDecisionQuality: {
      status: 'failed',
      reason: err && err.message || 'agent_execution_failed'
    }
  };
}

function createAgentMissionHandlers({ context = {}, session = null, baselineCoverage = {}, setMissionCrawl = () => {} } = {}) {
  const routeHandler = mission => executeLiveRouteMission({ mission, context, session, baselineCoverage, setMissionCrawl });
  return {
    'hidden-route-verification': routeHandler,
    'route-hint-flow': routeHandler,
    'endpoint-backed-ui-flow': routeHandler,
    'ptk-finding-entrypoint-reproduction': routeHandler,
    'auth-surface-traversal': routeHandler,
    'surface-expanded-route': routeHandler,
    'business-flow-continuation': routeHandler,
    'form-validation-repair': routeHandler,
    'missing-required-fields': routeHandler,
    'wrong-credential-field': routeHandler,
    'submitted-no-transition': routeHandler,
    'multi-step-form-next': routeHandler,
    'broad-coverage-tail': routeHandler
  };
}

async function executeLiveRouteMission({ mission = {}, context = {}, session = null, baselineCoverage = {}, setMissionCrawl = () => {} } = {}) {
  const route = executableRouteForMission(mission);
  if (!session || !session.page) {
    return {
      ok: false,
      status: 'not_executable',
      missionId: mission.id,
      kind: mission.kind,
      reason: 'live_sdk_session_missing',
      intents: missionIntentsForRoute(mission, route),
      results: []
    };
  }
  if (!route) {
    return {
      ok: false,
      status: 'not_executable',
      missionId: mission.id,
      kind: mission.kind,
      reason: 'mission_has_no_concrete_route_for_live_execution',
      intents: missionIntentsForRoute(mission, null),
      results: []
    };
  }
  const { recordActionEffect, hasCoverageDelta } = require('../agent/actionEffectRecorder.cjs');
  const startedAt = new Date().toISOString();
  const absoluteRoute = resolveRouteHint(context.config.target.baseUrl, route);
  const missionConfig = configForAgentRouteMission(context.config, mission);
  const missionCrawl = await crawlHandler({
    ...context,
    config: missionConfig,
    session,
    startUrls: [absoluteRoute],
    extraRoutes: [],
    skipPtkCollection: true,
    keepSession: true,
    options: {
      ...(context.options || {}),
      extraRoutes: []
    }
  });
  setMissionCrawl(missionCrawl);
  const endedAt = new Date().toISOString();
  const mergedCoverage = mergeCoverage(baselineCoverage, missionCrawl.coverage);
  const effect = recordActionEffect({
    mission,
    action: { kind: 'route.visit', route: absoluteRoute },
    beforeCoverage: baselineCoverage,
    afterCoverage: mergedCoverage,
    transition: {
      changed: true,
      noProgress: false,
      reason: 'live_route_mission_completed',
      signals: ['route-visited']
    },
    startedAt,
    endedAt
  });
  const progressed = hasCoverageDelta(effect.delta);
  effect.status = progressed ? 'progress' : 'no_progress';
  effect.noProgress = !progressed;
  return {
    ok: progressed,
    status: progressed ? 'completed' : 'no_progress',
    missionId: mission.id,
    kind: mission.kind,
    action: 'live_route_visit',
    route: absoluteRoute,
    reason: progressed ? null : 'live_route_visit_produced_no_new_coverage',
    effects: [effect],
    coverage: mergedCoverage,
    transition: {
      changed: progressed,
      noProgress: !progressed,
      reason: progressed ? 'live_route_mission_completed' : 'live_route_visit_produced_no_new_coverage',
      signals: ['route-visited']
    },
    results: [{
      kind: 'live-route-visit',
      route: absoluteRoute,
      coverageSummary: missionCrawl.coverage && missionCrawl.coverage.summary || null
    }]
  };
}

function configForAgentRouteMission(config = {}, mission = {}) {
  const outputDir = config.artifacts && config.artifacts.outputDir;
  const missionId = slugForPath(mission.id || mission.kind || 'mission');
  const crawler = config.crawler || {};
  const profile = agentRouteMissionProfile(mission);
  return {
    ...config,
    crawler: {
      ...crawler,
      maxRoutes: profile.maxRoutes,
      maxDepth: profile.maxDepth,
      maxActionsPerRoute: profile.maxActionsPerRoute,
      maxFormsPerRoute: profile.maxFormsPerRoute,
      maxNoProgressActions: profile.maxNoProgressActions,
      forms: {
        ...(crawler.forms || {}),
        enabled: profile.formsEnabled
      },
      surfaceExplorer: {
        ...(crawler.surfaceExplorer || {}),
        enabled: profile.surfaceExplorerEnabled
      }
    },
    artifacts: outputDir
      ? {
          ...(config.artifacts || {}),
          outputDir: path.join(outputDir, 'agent-missions', missionId)
        }
      : config.artifacts
  };
}

function agentRouteMissionProfile(mission = {}) {
  const kind = String(mission.kind || '').toLowerCase();
  if (kind === 'broad-coverage-tail') {
    return {
      maxRoutes: 3,
      maxDepth: 1,
      maxActionsPerRoute: 2,
      maxFormsPerRoute: 1,
      maxNoProgressActions: 1,
      formsEnabled: true,
      surfaceExplorerEnabled: true
    };
  }
  if (/endpoint|finding|scenario|business|surface/.test(kind)) {
    return {
      maxRoutes: 2,
      maxDepth: 1,
      maxActionsPerRoute: 2,
      maxFormsPerRoute: /form|business|scenario/.test(kind) ? 1 : 0,
      maxNoProgressActions: 1,
      formsEnabled: /form|business|scenario/.test(kind),
      surfaceExplorerEnabled: true
    };
  }
  return {
    maxRoutes: 1,
    maxDepth: 0,
    maxActionsPerRoute: 1,
    maxFormsPerRoute: 0,
    maxNoProgressActions: 1,
    formsEnabled: false,
    surfaceExplorerEnabled: true
  };
}

function slugForPath(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'item';
}

function executableRouteForMission(mission = {}) {
  if (!mission) return null;
  if (mission.route) return mission.route;
  const routeHint = mission.routeHint || {};
  if (routeHint.url || routeHint.path || routeHint.route || routeHint.href) return routeHint.url || routeHint.path || routeHint.route || routeHint.href;
  const endpoint = mission.endpoint || {};
  if (endpoint.routeUrl || endpoint.route || endpoint.referrer) return endpoint.routeUrl || endpoint.route || endpoint.referrer;
  if (Array.isArray(endpoint.candidateRoutes) && endpoint.candidateRoutes.length) return endpoint.candidateRoutes[0];
  return null;
}

function missionIntentsForRoute(mission = {}, route = null) {
  return route ? [{
    kind: 'route.visit',
    capability: 'route.visit',
    route,
    purpose: mission.kind || 'agent-mission'
  }] : [];
}

function resolveScenarioFile(config = {}, options = {}) {
  const file = config.scenario && config.scenario.file;
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.resolve(options.cwd || process.cwd(), file);
}

function resolveScenarioRouteHints(config = {}, options = {}) {
  if (!config.scenario || !config.scenario.enabled || !config.scenario.file) return [];
  if (config.scenario.inputType === 'macro') return [];
  try {
    const { loadScenarioFile } = require('../scenario/scenarioCompiler.cjs');
    const compiled = loadScenarioFile(resolveScenarioFile(config, options));
    return [
      ...(compiled.scenario.metadata && compiled.scenario.metadata.routeHints || []),
      ...routeHintsFromScenarioSteps(compiled.scenario)
    ];
  } catch (_) {
    return [];
  }
}

function resolveAnalysisEvidenceForRun(config = {}, context = {}) {
  const inputs = collectAnalysisEvidenceInputs({ ...context, config });
  if (!inputs.length) return null;
  const { adaptAnalysisEvidence } = require('../evidence/analysisEvidenceAdapter.cjs');
  return adaptAnalysisEvidence(inputs, {
    baseUrl: config.target && config.target.baseUrl || null
  });
}

function collectAnalysisEvidenceInputs(context = {}) {
  const options = context.options || {};
  const config = context.config || {};
  const inputs = [];
  addAnalysisInput(inputs, context.analysisEvidence);
  addAnalysisInput(inputs, context.analysisHints);
  addAnalysisInput(inputs, context.evidence);
  addAnalysisInput(inputs, options.analysisEvidence);
  addAnalysisInput(inputs, options.analysisHints);
  addAnalysisInput(inputs, options.routeHints);
  if (config.crawler && Array.isArray(config.crawler.routeHints) && config.crawler.routeHints.length > 0) {
    addAnalysisInput(inputs, {
      sourceTag: 'route-hint',
      routeHints: config.crawler.routeHints
    });
  }

  const moduleResolution = options.moduleResolution || context.moduleResolution || null;
  if (moduleResolution) {
    addAnalysisInput(inputs, moduleResolution.analysis);
    addAnalysisInput(inputs, moduleResolution.crawlerOutputs);
    addAnalysisInput(inputs, moduleResolution.routeHints);
    addAnalysisInput(inputs, moduleResolution.outputs && moduleResolution.outputs.crawler);
  }
  return inputs;
}

function addAnalysisInput(inputs, value) {
  if (!value) return;
  if (Array.isArray(value) && value.length === 0) return;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
  inputs.push(value);
}

function hasAnalysisEvidence(analysisEvidence = null) {
  return Boolean(analysisEvidence && analysisEvidence.counts && Number(analysisEvidence.counts.totalHints) > 0);
}

function mergeMissionEvidence(base = {}, analysisEvidence = null) {
  if (!hasAnalysisEvidence(analysisEvidence)) return base;
  return {
    ...base,
    routeHints: [
      ...(base.routeHints || []),
      ...(analysisEvidence.routeHints || [])
    ],
    hiddenParams: [
      ...(base.hiddenParams || []),
      ...(analysisEvidence.hiddenParams || [])
    ],
    hints: [
      ...(base.hints || []),
      ...(analysisEvidence.endpoints || []),
      ...(analysisEvidence.graphqlOperations || []),
      ...(analysisEvidence.hiddenParams || [])
    ],
    evidenceRecords: [
      ...(base.evidenceRecords || []),
      ...(analysisEvidence.evidenceRecords || [])
    ]
  };
}

function routeHintsFromScenarioSteps(scenario = {}) {
  const hints = [];
  for (const step of scenario.steps || []) {
    const target = step && step.target;
    if (typeof target === 'string') hints.push(target);
    if (target && typeof target === 'object') {
      if (target.route) hints.push(target.route);
      if (target.url) hints.push(target.url);
      if (Array.isArray(target.routes)) hints.push(...target.routes);
    }
  }
  return hints.filter(Boolean);
}

function hasScenarioAuthIntent(config = {}, options = {}) {
  if (!config.scenario || !config.scenario.enabled || !config.scenario.file) return false;
  try {
    const { loadScenarioFile } = require('../scenario/scenarioCompiler.cjs');
    const compiled = loadScenarioFile(resolveScenarioFile(config, options));
    return hasScenarioAuthStep(compiled.scenario);
  } catch (_) {
    return false;
  }
}

function hasScenarioAuthStep(scenario = {}) {
  return (scenario.steps || []).some(step => step && step.type === 'auth');
}

function resolveRouteHint(baseUrl, hint) {
  try {
    return new URL(hint, baseUrl).href;
  } catch (_) {
    return hint;
  }
}

function mergeCoverage(a = {}, b = {}) {
  const byUrl = new Map();
  for (const route of [...(a.routes || []), ...(b.routes || [])]) byUrl.set(route.url, route);
  const byEndpoint = new Map();
  for (const endpoint of [...(a.endpoints || []), ...(b.endpoints || [])]) byEndpoint.set(endpoint.key || `${endpoint.method} ${endpoint.path}`, endpoint);
  const forms = [...(a.forms || []), ...(b.forms || [])];
  const actions = [...(a.actions || []), ...(b.actions || [])];
  const routeShapes = Array.from(new Set([...(a.routeShapes || []), ...(b.routeShapes || [])]));
  const merged = {
    ...a,
    ...b,
    summary: {
      routesVisited: byUrl.size,
      routeShapes: routeShapes.length,
      endpointsObserved: byEndpoint.size,
      formsDiscovered: forms.length,
      actionsDiscovered: actions.length,
      transitionsObserved: ((a.transitions || []).length + (b.transitions || []).length),
      errors: ((a.errors || []).length + (b.errors || []).length)
    },
    routes: Array.from(byUrl.values()),
    routeShapes,
    endpoints: Array.from(byEndpoint.values()),
    forms,
    actions,
    transitions: [...(a.transitions || []), ...(b.transitions || [])],
    edges: [...(a.edges || []), ...(b.edges || [])],
    errors: [...(a.errors || []), ...(b.errors || [])],
    scenario: a.scenario || b.scenario || null,
    ptk: a.ptk || b.ptk || null,
    browser: a.browser || b.browser || null,
    siteMemory: a.siteMemory || b.siteMemory || null,
    codeSignals: a.codeSignals || b.codeSignals || null,
    analysisEvidence: a.analysisEvidence || b.analysisEvidence || null
  };
  for (const key of [
    'runHeartbeat',
    'browserRuntimeSummary',
    'routeLifecycle',
    'routeStatusSummary',
    'terminalDocumentSummary',
    'formAttemptSummary',
    'browserProbeSummary',
    'surfaceExplorerSummary',
    'authSurfaceSummary',
    'routeSourceSummary',
    'stateKeySummary'
  ]) {
    if (a[key] !== undefined && a[key] !== null) merged[key] = a[key];
  }
  return merged;
}

function resolveRouteFinalStatus(routeResult = {}, formResults = [], actionResults = [], surfaceResults = []) {
  if (routeResult.finalStatus === 'terminal-document') return 'terminal-document';
  if (routeResult.skipped) return 'blocked';
  if (!routeResult.ok) return routeResult.finalStatus || (/timed out/i.test(routeResult.error || '') ? 'timeout' : 'failed');
  if ((formResults || []).some(result => result.submitted && (result.invalid || result.noProgress || result.transition && result.transition.noProgress))) {
    return 'no-progress';
  }
  if ((actionResults || []).some(result => result.transition && result.transition.noProgress) && !(actionResults || []).some(result => result.transition && result.transition.changed)) {
    return 'no-progress';
  }
  if ((surfaceResults || []).some(result => result.transition && result.transition.noProgress) && !(surfaceResults || []).some(result => result.enqueuedRoutes && result.enqueuedRoutes.added > 0)) {
    return 'no-progress';
  }
  const model = routeResult.pageModel || {};
  const hasSurfaces = (model.forms || []).length > 0 || (model.actions || []).length > 0 || (model.links || []).length > 0;
  return hasSurfaces ? 'visited' : 'no-action-surfaces';
}

function summarizeRouteForms(formResults = []) {
  return {
    attempted: formResults.length,
    submitted: formResults.filter(result => result.submitted).length,
    skipped: formResults.filter(result => result.skipped).length,
    invalid: formResults.filter(result => result.invalid).length,
    noProgress: formResults.filter(result => result.noProgress || result.transition && result.transition.noProgress).length
  };
}

function summarizeRouteActions(actionResults = []) {
  return {
    attempted: actionResults.length,
    blocked: actionResults.filter(result => result.blocked).length,
    failed: actionResults.filter(result => result.ok === false && !result.blocked).length,
    changed: actionResults.filter(result => result.transition && result.transition.changed).length,
    noProgress: actionResults.filter(result => result.transition && result.transition.noProgress).length
  };
}

function buildFormAttemptSummary(routeResults = []) {
  const attempts = [];
  for (const routeResult of routeResults || []) {
    for (const form of routeResult.formResults || []) {
      attempts.push({
        routeUrl: routeResult.pageModel && routeResult.pageModel.url || routeResult.route && routeResult.route.url || null,
        formId: form.formId || null,
        submitted: Boolean(form.submitted),
        skipped: Boolean(form.skipped),
        invalid: Boolean(form.invalid),
        noProgress: Boolean(form.noProgress || form.transition && form.transition.noProgress),
        reason: form.reason || null,
        attemptKey: form.attemptKey || null,
        failureReason: form.failureReason || null,
        authSucceeded: Boolean(form.authSucceeded),
        authRetryQueued: Boolean(form.authRetryQueued),
        authRetrySource: form.authRetrySource || null,
        authRetryReason: form.authRetryReason || null
      });
    }
  }
  return {
    schemaVersion: 'ptk-agent-v2-form-attempt-summary',
    generatedAt: new Date().toISOString(),
    total: attempts.length,
    submitted: attempts.filter(attempt => attempt.submitted).length,
    skipped: attempts.filter(attempt => attempt.skipped).length,
    invalid: attempts.filter(attempt => attempt.invalid).length,
    noProgress: attempts.filter(attempt => attempt.noProgress).length,
    attempts
  };
}

function buildRouteSourceSummary(frontier = null, coverageSnapshot = {}) {
  const bySource = {};
  const byPriority = {};
  for (const route of coverageSnapshot.routes || []) {
    const source = route.sourceTag || route.source || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
    const priority = route.priority !== undefined && route.priority !== null ? String(route.priority) : 'unknown';
    byPriority[priority] = (byPriority[priority] || 0) + 1;
  }
  const rejected = frontier && typeof frontier.snapshot === 'function' ? frontier.snapshot().rejected || [] : [];
  const rejectedBySource = {};
  const rejectedByPriority = {};
  for (const route of rejected) {
    const source = route.source || route.sourceTag || 'unknown';
    rejectedBySource[source] = (rejectedBySource[source] || 0) + 1;
    const priority = route.priority !== undefined && route.priority !== null ? String(route.priority) : 'unknown';
    rejectedByPriority[priority] = (rejectedByPriority[priority] || 0) + 1;
  }
  return {
    schemaVersion: 'ptk-agent-v2-route-source-summary',
    generatedAt: new Date().toISOString(),
    visitedBySource: bySource,
    visitedByPriority: byPriority,
    rejectedBySource,
    rejectedByPriority,
    rejectedRoutes: rejected
  };
}

function buildStateKeySummary(routeResults = []) {
  const states = [];
  const seen = new Set();
  for (const result of routeResults || []) {
    const model = result.pageModel || {};
    if (!model.stateKey) continue;
    const key = model.stateKey;
    states.push({
      routeUrl: model.url || result.route && result.route.url || null,
      stateKey: key,
      routeShape: model.routeShape || null,
      surfaceType: model.surfaceType || null,
      surfaces: model.surfaces || []
    });
    seen.add(key);
  }
  return {
    schemaVersion: 'ptk-agent-v2-state-key-summary',
    generatedAt: new Date().toISOString(),
    total: states.length,
    distinct: seen.size,
    states
  };
}

async function runOrchestrator(context = {}) {
  return orchestrateRun(context);
}

module.exports = {
  UnsupportedExecutionError,
  assertSupportedSkeleton,
  createDefaultHandlers,
  createOrchestrator,
  determineRequestedMode,
  isMacroOnlyRun,
  macroArtifactSensitiveValues,
  resolveRouteHint,
  resolveScenarioRouteHints,
  hasScenarioAuthIntent,
  hasScenarioAuthStep,
  ptkSessionIdFromLifecycleStart,
  ptkDrainPolicy,
  ptkDrainBridgeMethodTimeoutMs,
  ptkDrainLowLevelStatusTimeoutMs,
  ptkDrainStatusReadTimeoutMs,
  createPtkDrainStatusReader,
  ptkDrainUsedStatusPage,
  ptkOperationShouldRetryOnStatusPage,
  ptkOperationShouldRetryOnPrimaryPage,
  ptkOperationShouldReloadPrimaryForBridge,
  ptkExportOperationTimeoutMs,
  collectPtkEvidence,
  agentBaselineSkipReason,
  configForAgentRouteMission,
  coverageAfterAgentWork,
  mergeCoverage,
  pollPtkDrainStatus,
  classifyPtkDrainStatus,
  summarizePtkAttackCompletion,
  normalCrawlFormCandidates,
  runNormalCrawlFormHooks,
  mergeCoverage,
  resolveAnalysisEvidenceForRun,
  collectAnalysisEvidenceInputs,
  mergeMissionEvidence,
  collectAgentPlanningPtkSignals,
  shouldRecenterAgentLivePage,
  resolveRouteFinalStatus,
  buildFormAttemptSummary,
  buildRouteSourceSummary,
  buildStateKeySummary,
  orchestrateRun,
  runOrchestrator
};
