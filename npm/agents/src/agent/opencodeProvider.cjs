'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractPtkFindings, normalizeFinding, redactPtkSecrets } = require('../evidence/ptkEvidenceAdapter.cjs');

const MAX_PROVIDER_OUTPUT_CHARS = 200000;
const MAX_PROVIDER_PARSE_CHARS = 65536;
const MAX_PROVIDER_SNIPPET_CHARS = 2000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60000;
const MAX_PROMPT_MISSIONS = 5;
const MAX_PROMPT_HANDLES = 24;
const OPENCODE_RUN_TITLE = 'ptk-agent-provider';

class OpencodeProvider {
  constructor({ model = null, maxProviderMs = DEFAULT_PROVIDER_TIMEOUT_MS, cwd = process.cwd() } = {}) {
    this.kind = 'opencode';
    this.model = model;
    this.maxProviderMs = maxProviderMs;
    this.cwd = cwd;
    this.runtimeDir = createOpencodeRuntimeDir();
  }

  async chooseMission(context = {}) {
    const prompt = buildMissionPrompt(context);
    const args = buildOpencodeArgs({ model: this.model, prompt });
    const result = await runCommand('opencode', args, {
      cwd: this.cwd,
      timeoutMs: this.maxProviderMs,
      env: buildOpencodeEnvironment(this.runtimeDir)
    });
    return choiceFromOpencodeResult(result);
  }
}

function choiceFromOpencodeResult(result = {}) {
  const parsed = parseProviderChoice(result.stdout);
  const warnings = classifyOpencodeWarnings(result);
  if (parsed && parsed.missionId) {
    return {
      provider: 'opencode',
      ...parsed,
      raw: providerSnippet(result.stdout),
      providerWarnings: warnings,
      providerExitCode: result.code == null ? null : result.code,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    };
  }
  if (!result.ok) {
    const timedOut = result.code === 'ERR_PTK_AGENT_PROVIDER_TIMEOUT';
    const classified = classifyOpencodeFailure(result);
    return {
      missionId: null,
      reason: classified.reason || (timedOut ? 'provider_timeout' : 'opencode_provider_failed'),
      provider: 'opencode',
      error: classified.error || result.error,
      code: result.code || null,
      stdout: providerSnippet(result.stdout),
      stderr: providerSnippet(result.stderr),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    };
  }
  return {
    missionId: null,
    reason: 'opencode_provider_parse_failed',
    provider: 'opencode',
    providerWarnings: warnings,
    stdout: providerSnippet(result.stdout),
    stderr: providerSnippet(result.stderr),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  };
}

function buildOpencodeArgs({ model = null, prompt = '' } = {}) {
  const args = ['--pure', '--print-logs', '--log-level', 'ERROR', 'run', '--agent', 'plan', '--title', OPENCODE_RUN_TITLE];
  if (model) args.push('-m', model);
  args.push(prompt);
  return args;
}

function createOpencodeRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-opencode-provider-'));
}

function buildOpencodeEnvironment(runtimeDir) {
  const base = runtimeDir || createOpencodeRuntimeDir();
  return {
    XDG_DATA_HOME: path.join(base, 'data'),
    XDG_STATE_HOME: path.join(base, 'state'),
    XDG_CACHE_HOME: path.join(base, 'cache')
  };
}

function classifyOpencodeFailure(result = {}) {
  const combined = `${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  if (/CreditsError|No payment method|billing|statusCode["']?:\s*401|HTTP\s*401/i.test(combined)) {
    return {
      reason: 'opencode_provider_unavailable',
      error: 'opencode provider unavailable: billing or credits error'
    };
  }
  if (/readonly database|PRAGMA wal_checkpoint|attempt to write a readonly database/i.test(combined)) {
    return {
      reason: 'opencode_provider_environment_error',
      error: 'opencode provider environment error: local database is not writable'
    };
  }
  return { reason: null, error: null };
}

function classifyOpencodeWarnings(result = {}) {
  const combined = `${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  const warnings = [];
  if (/CreditsError|No payment method|billing|statusCode["']?:\s*401|HTTP\s*401/i.test(combined)) {
    warnings.push({
      reason: 'opencode_background_billing_error',
      message: 'opencode emitted a billing/credits error in logs after producing a provider plan'
    });
  }
  if (/statusCode["']?:\s*503|HTTP\s*503|Service is too busy/i.test(combined)) {
    warnings.push({
      reason: 'opencode_background_service_busy',
      message: 'opencode emitted a transient service-busy error in logs'
    });
  }
  if (/readonly database|PRAGMA wal_checkpoint|attempt to write a readonly database/i.test(combined)) {
    warnings.push({
      reason: 'opencode_local_state_warning',
      message: 'opencode emitted a local state/database warning in logs'
    });
  }
  return warnings;
}

function buildMissionPrompt(context = {}) {
  const selectedMissions = selectPromptMissions(context.missions || [], MAX_PROMPT_MISSIONS);
  const missions = selectedMissions.map(mission => ({
    id: mission.id,
    kind: mission.kind,
    priority: mission.priority,
    reason: boundedString(mission.reason || '', 180) || null,
    allowedCapabilities: allowedCapabilitiesForKind(mission.kind),
    route: mission.route || null,
    routeHint: summarizeRouteHint(mission.routeHint),
    endpoint: summarizeEndpoint(mission.endpoint),
    params: summarizeParams(mission.params),
    scenarioGap: summarizeScenarioGap(mission.scenarioGap),
    liveHandleSummary: summarizeHandleSummary(mission.liveHandleSummary)
  }));
  const handles = summarizeHandles(selectRelevantHandles(context.handles || [], selectedMissions));
  const observation = summarizeObservation(context.observation || {});
  return [
    'You are the PTK Agents SDK crawl manager.',
    'Your job is to analyze the current website state and recommend the next crawl-improving browser action.',
    'Think like a business-flow crawler: identify navigation/account menus, authenticated surfaces, forms with validation, endpoint-to-UI gaps, PTK finding entrypoints, scenario gaps, and unvisited route shapes.',
    'Agent plans; SDK executes in the existing live browser session. You do not control the browser directly.',
    'Choose one executable mission and return compact JSON only.',
    'Prefer fresh live surface/control/form handles over route replay when those handles can reveal business logic or authenticated navigation.',
    'Prefer actions that can add endpoints, forms, route shapes, authenticated surfaces, or finding reproduction evidence; more raw findings are not the only value.',
    'Prefer scenario unblock, authenticated surfaces, form repair, endpoint-backed UI with a UI path, PTK finding entrypoints, and unvisited auth routes.',
    'Do not choose endpoint/document-only work when no UI path or route handle exists.',
    'Do not choose a PTK route replay while an executable fresh business/UI handle is available, unless the replay is the only high-confidence mission.',
    'Use fresh handle IDs only. Do not invent selectors, XPath, CSS, text selectors, URLs, cookies, auth headers, raw DOM, screenshots, or secret values.',
    'Use only mission IDs listed in missions. Do not invent mission IDs. If a fresh handle is relevant, choose the listed mission that owns that handle.',
    'Allowed step types: open_surface, click_control, fill_form, submit_form, visit_route, recover_auth_state, record_no_progress, get_ptk_lifecycle_status.',
    'Default to one mutating step. Menus and forms often invalidate handles after a click.',
    'For form steps, use only the opaque SDK form handle from freshHandles, for example {"formId":"form_1_1"}. Page/model form refs from summaries are not executable handles. Let the SDK fill/submit locally. If a field value is truly needed, it must be a profile reference such as profile.email, profile.password, or profile.searchTerms[0]. Never provide literal form values.',
    'Captchas must be classified as blocked; do not attempt to solve them.',
    'expectedDelta is advisory; actualDelta is computed by the SDK.',
    'In the reason, state what website gap you are trying to unlock and why this step improves crawling.',
    'Return one JSON object: {"missionId":"...","reason":"...","riskModeRequired":"safe","expectedDelta":{"routes":1},"allowedCapability":"mission:plan","steps":[{"type":"open_surface","target":{"surfaceId":"surface_1_1"},"success":{"newSurface":true}}]}.',
    'For click steps use {"type":"click_control","target":{"controlId":"ctrl_1_1"}}. For forms use {"type":"submit_form","target":{"formId":"form_1_1"}} unless profile references are necessary. For routes use a routeHandleId from freshHandles.',
    JSON.stringify({
      skill: context.skill || null,
      coverageSummary: summarizeCoverage(context.coverage || {}),
      evidenceSummary: summarizeEvidenceSignals(context),
      currentPage: observation.currentPage || null,
      scenarioStatus: summarizeScenarioStatus(context.scenarioStatus),
      recentFailures: summarizeRecentFailures(context),
      freshHandles: handles,
      missions
    })
  ].join('\n');
}

function selectPromptMissions(missions = [], limit = MAX_PROMPT_MISSIONS) {
  const ordered = (missions || []).filter(Boolean);
  const selected = [];
  const selectedIds = new Set();
  const buckets = [
    mission => missionBucket(mission) === 'scenario',
    mission => missionBucket(mission) === 'business',
    mission => missionBucket(mission) === 'form',
    mission => missionBucket(mission) === 'ptk',
    mission => missionBucket(mission) === 'endpoint'
  ];

  for (const predicate of buckets) {
    const mission = ordered.find(candidate => predicate(candidate) && !selectedIds.has(candidate.id));
    if (!mission) continue;
    selected.push(mission);
    selectedIds.add(mission.id);
    if (selected.length >= limit) return selected;
  }

  for (const mission of ordered) {
    if (!mission || selectedIds.has(mission.id)) continue;
    selected.push(mission);
    selectedIds.add(mission.id);
    if (selected.length >= limit) break;
  }

  return selected;
}

function missionBucket(mission = {}) {
  const kind = String(mission.kind || '');
  if (/scenario|auth-flow/.test(kind)) return 'scenario';
  if (/form|captcha|credential|required|no-transition|multi-step/.test(kind)) return 'form';
  if (/auth-surface|surface-expanded|business-flow/.test(kind) || mission.surfaceHandleId || mission.controlHandleId) return 'business';
  if (/ptk-finding-entrypoint/.test(kind)) return 'ptk';
  if (/endpoint|graphql|hidden-param/.test(kind)) return 'endpoint';
  return 'route';
}

function summarizeHandles(handles = []) {
  return handles.slice(0, MAX_PROMPT_HANDLES).map(handle => ({
    id: handle.id,
    type: handle.type,
    routeKey: handle.routeKey || null,
    stateKey: handle.stateKey || null,
    source: handle.source || null,
    createdAtTurn: handle.createdAtTurn,
    expiresAfterTurn: handle.expiresAfterTurn,
    policyTier: handle.policyTier || 'safe',
    stable: Boolean(handle.stable),
    summary: summarizeHandleSummary(handle.summary)
  }));
}

function selectRelevantHandles(handles = [], missions = []) {
  const missionIds = new Set(missions.map(mission => mission && mission.id).filter(Boolean));
  const directHandleIds = new Set();
  for (const mission of missions || []) {
    for (const key of ['surfaceHandleId', 'controlHandleId', 'formHandleId', 'routeHandleId']) {
      if (mission && mission[key]) directHandleIds.add(mission[key]);
    }
  }
  const scored = (handles || []).map((handle, index) => {
    let score = 0;
    const summaryMissionId = handle.summary && handle.summary.missionId;
    const directlyOwned = directHandleIds.has(handle.id) || Boolean(summaryMissionId && missionIds.has(summaryMissionId));
    if (directlyOwned) score += 100;
    const missionRelated = handleRelevantToMission(handle, missions);
    if (handle.type === 'route' && missionRelated) score += 80;
    if (directlyOwned && handle.type === 'surface' && surfaceHandleIsUsefulForMission(handle, missions)) score += 20;
    if (directlyOwned && handle.type === 'form') score += 16;
    if (directlyOwned && handle.type === 'control') score += 12;
    if (directlyOwned && handle.summary && /order|address|wallet|payment|profile|account|setting|security|search|feedback|contact|complain/i.test(JSON.stringify(handle.summary))) score += 10;
    return { handle, score, index };
  });
  const relevant = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.handle);
  return relevant.length ? relevant : (missions.length ? [] : handles);
}

function handleRelevantToMission(handle = {}, missions = []) {
  if (!handle) return false;
  const summaryMissionId = handle.summary && handle.summary.missionId;
  if (summaryMissionId && missions.some(mission => mission && mission.id === summaryMissionId)) return true;
  return missions.some(mission => missionMatchesHandle(handle, mission));
}

function missionMatchesHandle(handle = {}, mission = {}) {
  if (!handle || !mission) return false;
  const missionRoute = mission.route || mission.routeHint && (mission.routeHint.url || mission.routeHint.route || mission.routeHint.path) || null;
  if (!missionRoute || !handle.routeKey) return false;
  if (!sameRoute(missionRoute, handle.routeKey)) return false;
  if (handle.type === 'route') return true;
  if (handle.type === 'form') return /form|captcha|credential|required|no-transition|multi-step|business-flow/.test(String(mission.kind || ''));
  if (handle.type === 'surface' || handle.type === 'control') {
    return /surface|auth|business|scenario|route|finding/i.test(String(mission.kind || ''));
  }
  return false;
}

function surfaceHandleIsUsefulForMission(handle = {}, missions = []) {
  if (!handle || handle.type !== 'surface') return false;
  const text = JSON.stringify(handle.summary || {}).toLowerCase();
  if (/account|profile|order|payment|wallet|address|setting|security|menu|drawer|nav|surface/.test(text)) {
    return missions.some(mission => /auth|surface|business|scenario/.test(String(mission && mission.kind || '')));
  }
  return false;
}

function sameRoute(left, right) {
  const leftKeys = new Set(routeComparableKeys(left));
  if (!leftKeys.size) return false;
  return routeComparableKeys(right).some(key => leftKeys.has(key));
}

function routeComparableKeys(route) {
  if (!route) return [];
  const value = String(route).trim();
  if (!value) return [];
  const keys = new Set();
  const add = candidate => keys.add(String(candidate || '').trim().replace(/\/+$/, '') || '/');
  add(value);
  if (value.startsWith('#/')) add(`/${value}`);
  if (value.startsWith('#!/')) add(`/#${value.slice(2)}`);
  try {
    const url = new URL(value, 'http://ptk.local');
    add(`${url.pathname || '/'}${url.search || ''}${url.hash || ''}`);
    if (url.hash && /^#!?\//.test(url.hash)) {
      add(`${url.pathname || '/'}${url.search || ''}${url.hash.replace(/^#!/, '#/')}`);
    }
  } catch (_) {}
  return Array.from(keys);
}

function summarizeHandleSummary(summary = null) {
  if (!summary || typeof summary !== 'object') return summary || null;
  const out = {};
  for (const key of ['missionId', 'missionKind', 'kind', 'semanticKind', 'riskTier', 'label', 'href', 'expectedEffect']) {
    if (summary[key] !== undefined && summary[key] !== null) out[key] = boundedString(summary[key], 160);
  }
  return Object.keys(out).length ? out : null;
}

function summarizeObservation(observation = {}) {
  return {
    currentPage: observation.currentPage || null,
    coverage: observation.coverage || null
  };
}

function summarizeScenarioStatus(status = null) {
  if (!status) return null;
  return {
    status: status.status || (status.ok ? 'completed' : 'failed'),
    ok: status.ok !== false,
    failedStep: status.failedStep || status.failedStepId || null,
    failureReason: status.failureReason || status.reason || null,
    pendingCount: Array.isArray(status.pending) ? status.pending.length : 0
  };
}

function summarizeRecentFailures(context = {}) {
  const runMemory = context.runMemory || null;
  if (runMemory && typeof runMemory.snapshot === 'function') {
    const snapshot = runMemory.snapshot();
    return {
      noProgress: snapshot.noProgress || [],
      suppressed: snapshot.suppressed || []
    };
  }
  return [];
}

function summarizeEvidenceSignals(context = {}) {
  const coverage = context.coverage || {};
  const evidence = context.evidence || {};
  return {
    ptkLifecycle: summarizePtkLifecycle({ coverage, evidence }),
    findingEntryPoints: summarizeFindingEntryPoints({ coverage, evidence }),
    authSurface: summarizeAuthSurface(coverage.authSurfaceSummary),
    forms: summarizeForms(coverage.forms),
    routeSources: summarizeRouteSources(coverage)
  };
}

function summarizePtkLifecycle({ coverage = {}, evidence = {} } = {}) {
  const ptkSignals = evidence.ptkSignals || coverage.agentPtkSignals || {};
  const ptk = coverage.ptk || {};
  const lifecycle = ptk.lifecycle || ptkSignals.lifecycle || ptkSignals.status || {};
  const validity = ptk.validity || ptkSignals.validity || {};
  return {
    bridgeDetected: Boolean(
      ptk.bridgeDetected ||
      validity.bridgeDetected ||
      lifecycle.bridgeDetected ||
      ptkSignals.bridgeDetected
    ),
    scanStarted: Boolean(
      ptk.scanStarted ||
      validity.scanStarted ||
      lifecycle.scanStarted ||
      ptkSignals.scanStarted
    ),
    findingsValid: Boolean(validity.findingsValid || ptk.findingsValid || ptkSignals.findingsValid),
    findingsCount: Number(
      ptk.findings && (ptk.findings.count || ptk.findings.findingsCount) ||
      validity.findingsCount ||
      ptkSignals.findingsCount ||
      extractPtkFindings(ptkSignals).length ||
      0
    ) || 0,
    enabledEngines: boundedStrings(
      lifecycle.enabledEngines ||
      ptkSignals.enabledEngines ||
      ptk.engines ||
      []
    ),
    drainState: lifecycle.drainState || ptkSignals.drainState || null,
    exportValiditySource: validity.findingsExportValiditySource || ptkSignals.findingsExportValiditySource || null
  };
}

function summarizeFindingEntryPoints({ coverage = {}, evidence = {} } = {}) {
  const sources = [
    evidence.ptkSignals,
    evidence.findings,
    evidence.evidenceRecords,
    coverage.agentPtkSignals,
    coverage.ptk,
    coverage.ptk && coverage.ptk.evidence,
    coverage.ptk && coverage.ptk.findings
  ].filter(Boolean);
  const findings = [];
  const seen = new Set();
  for (const source of sources) {
    for (const raw of extractPtkFindings(source)) {
      const normalized = normalizeFinding(raw);
      const route = findingRoute(raw, normalized);
      if (route && !isBrowserNavigableFindingRoute(route)) continue;
      const key = [normalized.engine, normalized.ruleId || normalized.title, route || normalized.url, normalized.parameter].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        engine: normalized.engine,
        title: normalized.title,
        severity: normalized.severity,
        confidence: normalized.confidence,
        ruleId: normalized.ruleId || null,
        route: route || normalized.url || null,
        method: normalized.method || null,
        parameter: normalized.parameter || null
      });
      if (findings.length >= 6) return findings;
    }
  }
  return findings;
}

function isBrowserNavigableFindingRoute(routeValue) {
  const route = String(routeValue || '').toLowerCase();
  if (!route) return false;
  if (/#\//.test(route)) return true;
  try {
    const url = new URL(route, 'http://local.invalid');
    return !/^\/(?:api|apis|rest|graphql|gql|socket\.io)(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return !/^\/(?:api|apis|rest|graphql|gql|socket\.io)(?:\/|$)/i.test(route);
  }
}

function findingRoute(raw = {}, normalized = {}) {
  const safeRaw = redactPtkSecrets(raw);
  const location = safeRaw.location || {};
  const values = [
    location.runtimeUrl,
    firstArrayValue(location.runtimeUrls),
    location.pageUrl,
    firstArrayValue(location.pageUrls),
    location.route,
    normalized.url
  ].filter(Boolean);
  return values[0] || null;
}

function summarizeAuthSurface(summary = {}) {
  const actions = Array.isArray(summary && summary.menuActions) ? summary.menuActions : [];
  const blocked = Array.isArray(summary && summary.blockedUnsafeMenuActions) ? summary.blockedUnsafeMenuActions : [];
  const noProgress = Array.isArray(summary && summary.noProgressMenuActions) ? summary.noProgressMenuActions : [];
  return {
    authenticatedSurfacesOpened: Number(summary.authenticatedSurfacesOpened || 0) || 0,
    menuActionsDiscovered: Number(summary.menuActionsDiscovered || actions.length || 0) || 0,
    menuActionsExecuted: Number(summary.menuActionsExecuted || actions.filter(action => /executed|completed/i.test(String(action && action.status || ''))).length || 0) || 0,
    routesDiscoveredFromAuthMenus: Number(summary.routesDiscoveredFromAuthMenus || 0) || 0,
    skippedMenuActionCount: actions.filter(action => /surface_reopen_failed|budget|timeout|no_progress|not_executed/i.test(String(action && action.reason || ''))).length,
    blockedUnsafeMenuActionCount: blocked.length,
    noProgressMenuActionCount: noProgress.length,
    skippedSamples: actions
      .filter(action => /surface_reopen_failed|budget|timeout|no_progress|not_executed/i.test(String(action && action.reason || '')))
      .slice(0, 8)
      .map(action => ({
        label: action.label || null,
        route: action.routeUrl || action.route || action.url || null,
        reason: action.reason || null
      }))
  };
}

function summarizeForms(forms = []) {
  return (Array.isArray(forms) ? forms : []).slice(0, 12).map(form => ({
    id: form.id || null,
    kind: form.kind || null,
    route: form.routeUrl || form.pageUrl || form.url || null,
    method: form.method || null,
    fieldCount: Array.isArray(form.fields) ? form.fields.length : 0,
    hasValidation: /validation|required|invalid|error|captcha/i.test(JSON.stringify({
      kind: form.kind,
      validation: form.validation,
      status: form.status,
      reason: form.reason
    }))
  }));
}

function summarizeRouteSources(coverage = {}) {
  const summary = coverage.routeSourceSummary || coverage.routeSources || {};
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    return Object.fromEntries(Object.entries(summary).slice(0, 16).map(([key, value]) => [key, Number(value) || 0]));
  }
  const routes = Array.isArray(coverage.routes) ? coverage.routes : [];
  const counts = {};
  for (const route of routes) {
    const source = route.source || route.discoverySource || route.coverage && route.coverage.source || 'unknown';
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

function summarizeEndpoint(endpoint) {
  if (!endpoint) return null;
  return {
    key: endpoint.key || null,
    method: endpoint.method || null,
    path: endpoint.path || null,
    status: endpoint.status || null,
    resourceType: endpoint.resourceType || null,
    graphqlOperationName: endpoint.graphqlOperationName || null
  };
}

function summarizeRouteHint(routeHint) {
  if (!routeHint) return null;
  if (typeof routeHint === 'string') return { url: routeHint };
  return {
    kind: routeHint.kind || null,
    url: routeHint.url || routeHint.path || routeHint.route || null,
    source: routeHint.source || null,
    coverageStatus: routeHint.coverage && routeHint.coverage.status || null
  };
}

function summarizeParams(params) {
  if (!Array.isArray(params)) return [];
  return params.slice(0, 8).map(param => typeof param === 'string'
    ? { name: param, location: 'query' }
    : {
        name: param.name || param.param || param.key || null,
        location: param.location || param.in || null,
        source: param.source || null
      });
}

function summarizeScenarioGap(gap) {
  if (!gap) return null;
  if (typeof gap === 'string') return { id: gap };
  return {
    id: gap.id || gap.stepId || null,
    label: gap.label || gap.name || null,
    route: gap.route || gap.url || gap.path || null,
    source: gap.source || null
  };
}

function summarizeCoverage(coverage = {}) {
  return {
    routes: Array.isArray(coverage.routes) ? coverage.routes.length : coverage.summary && coverage.summary.routesVisited || 0,
    routeShapes: Array.isArray(coverage.routeShapes) ? coverage.routeShapes.length : coverage.summary && coverage.summary.routeShapes || 0,
    endpoints: Array.isArray(coverage.endpoints) ? coverage.endpoints.length : coverage.summary && coverage.summary.endpointsObserved || 0,
    forms: Array.isArray(coverage.forms) ? coverage.forms.length : coverage.summary && coverage.summary.formsDiscovered || 0,
    actions: Array.isArray(coverage.actions) ? coverage.actions.length : coverage.summary && coverage.summary.actionsDiscovered || 0
  };
}

function boundedStrings(values = []) {
  return (Array.isArray(values) ? values : Object.keys(values || {})).slice(0, 12).map(value => String(value));
}

function boundedString(value, maxChars = 200) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function parseProviderChoice(text) {
  const raw = boundedProviderText(text, MAX_PROVIDER_PARSE_CHARS).trim();
  const candidates = [raw];
  for (const fenced of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(...extractJsonObjectCandidates(raw));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && (parsed.missionId || parsed.mission_id)) {
        return {
          ...parsed,
          missionId: parsed.missionId || parsed.mission_id,
          expectedDelta: parsed.expectedDelta || parsed.expected_delta || null,
          allowedCapability: parsed.allowedCapability || parsed.allowed_capability || parsed.capability || null
        };
      }
    } catch (_) {}
  }
  return null;
}

function boundedProviderText(text, maxChars = MAX_PROVIDER_OUTPUT_CHARS) {
  const raw = String(text || '');
  if (raw.length <= maxChars) return raw;
  return raw.slice(raw.length - maxChars);
}

function providerSnippet(text, maxChars = MAX_PROVIDER_SNIPPET_CHARS) {
  return boundedProviderText(text, maxChars);
}

function appendBoundedProviderOutput(current, chunk, maxChars = MAX_PROVIDER_OUTPUT_CHARS) {
  const next = `${current || ''}${chunk == null ? '' : chunk.toString()}`;
  if (next.length <= maxChars) {
    return { value: next, truncated: false };
  }
  return {
    value: next.slice(next.length - maxChars),
    truncated: true
  };
}

function extractJsonObjectCandidates(raw, maxCandidates = 8) {
  const candidates = [];
  const starts = [];
  let inString = false;
  let escape = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      starts.push(index);
      continue;
    }
    if (char !== '}' || starts.length === 0) continue;
    const start = starts.pop();
    const candidate = raw.slice(start, index + 1).trim();
    if (candidate.includes('missionId') || candidate.includes('mission_id')) {
      candidates.unshift(candidate);
      if (candidates.length >= maxCandidates) break;
    }
  }
  return candidates;
}

function allowedCapabilitiesForKind(kind) {
  if (kind === 'hidden-route-verification' || kind === 'route-hint-flow') return ['route.visit'];
  if (kind === 'ptk-finding-entrypoint-reproduction') return ['route.visit', 'mission:plan'];
  if (kind === 'endpoint-backed-ui-flow') return ['route.visit', 'mission:plan'];
  if (kind === 'graphql-operation-flow' || kind === 'hidden-param-flow') return ['http.request'];
  if (kind === 'broad-coverage-tail') return ['crawl:direct'];
  if (kind === 'auth-flow' || kind === 'scenario-unblock') return ['state.assert', 'route.visit', 'mission:plan'];
  if (kind === 'auth-surface-traversal') return ['surface.open', 'control.click', 'mission:plan'];
  if (kind === 'surface-expanded-route') return ['control.click', 'route.visit', 'mission:plan'];
  if (kind === 'business-flow-continuation') return ['surface.open', 'control.click', 'form.submit', 'mission:plan'];
  if (/form|captcha|credential|required|no-transition|multi-step/.test(String(kind || ''))) return ['form.fill', 'form.submit', 'mission:plan'];
  return ['mission:plan'];
}

function runCommand(command, args, { cwd, timeoutMs, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2000);
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      const bounded = appendBoundedProviderOutput(stdout, chunk);
      stdout = bounded.value;
      stdoutTruncated = stdoutTruncated || bounded.truncated;
    });
    child.stderr.on('data', chunk => {
      const bounded = appendBoundedProviderOutput(stderr, chunk);
      stderr = bounded.value;
      stderrTruncated = stderrTruncated || bounded.truncated;
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ok: false, error: err.message, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) {
        resolve({ ok: false, code: 'ERR_PTK_AGENT_PROVIDER_TIMEOUT', error: `${command} timed out after ${timeoutMs}ms`, stdout, stderr, stdoutTruncated, stderrTruncated });
        return;
      }
      resolve({ ok: code === 0, code, error: code === 0 ? null : `${command} exited with ${code}`, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

module.exports = {
  MAX_PROVIDER_OUTPUT_CHARS,
  MAX_PROVIDER_PARSE_CHARS,
  OpencodeProvider,
  appendBoundedProviderOutput,
  buildMissionPrompt,
  buildOpencodeEnvironment,
  buildOpencodeArgs,
  boundedProviderText,
  classifyOpencodeFailure,
  classifyOpencodeWarnings,
  choiceFromOpencodeResult,
  extractJsonObjectCandidates,
  parseProviderChoice,
  providerSnippet,
  runCommand,
  selectPromptMissions
};
