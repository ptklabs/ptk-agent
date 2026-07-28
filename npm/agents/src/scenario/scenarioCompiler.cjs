'use strict';

const fs = require('fs');
const { validateScenario } = require('./scenarioValidator.cjs');
const { buildScenarioDag, serializeDag } = require('./scenarioDag.cjs');

const DEFAULT_STEP_TIMEOUT_MS = 5000;

function normalizeRetry(retry) {
  return { maxAttempts: retry && Number.isInteger(retry.maxAttempts) ? retry.maxAttempts : 1 };
}

function normalizeStep(step, index, previousStep, options = {}) {
  const explicitDependencies = step.dependsOn !== undefined || step.after !== undefined;
  const dependsOn = explicitDependencies
    ? step.dependsOn || step.after
    : options.sequential === false || !previousStep ? [] : [previousStep.id];
  return {
    id: step.id,
    type: step.type,
    persona: step.persona || null,
    value: step.value,
    target: step.target || null,
    surface: step.surface || null,
    action: step.action || null,
    count: step.count,
    fromAccount: step.fromAccount,
    toAccount: step.toAccount,
    amount: step.amount,
    failureBehavior: step.failureBehavior || null,
    actionId: step.actionId || null,
    formId: step.formId || null,
    postAuthProbes: Array.isArray(step.postAuthProbes) ? step.postAuthProbes.slice() : undefined,
    dependsOn,
    success: step.success || { completed: true },
    failure: step.failure || null,
    retry: normalizeRetry(step.retry),
    timeoutMs: Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : Number(options.defaultTimeoutMs) || DEFAULT_STEP_TIMEOUT_MS,
    metadata: step.metadata && typeof step.metadata === 'object' ? { ...step.metadata } : {}
  };
}

function compileScenario(rawScenario, options = {}) {
  const raw = rawScenario || {};
  const steps = [];
  for (const [index, step] of (raw.steps || []).entries()) {
    steps.push(normalizeStep(step, index, steps[index - 1], options));
  }
  const scenario = {
    version: raw.version || 'ptk-scenario-v2',
    steps,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {}
  };
  const validation = validateScenario(scenario, { requireSuccess: true });
  if (!validation.ok) {
    const error = new Error(`Invalid compiled PTK scenario:\n${validation.errors.join('\n')}`);
    error.validation = validation;
    throw error;
  }
  const dag = buildScenarioDag(scenario, { requireSuccess: true });
  return { scenario, dag, dagJson: serializeDag(dag), validation };
}

function slug(value, fallback) {
  const text = String(value || fallback || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return text || fallback || 'step';
}

function inferStepType(text) {
  const lower = String(text || '').toLowerCase();
  if (isCoverageObjectiveText(lower) || isPolicyConstraintText(lower)) return 'assert-state';
  if (/login|authentication|credentials/.test(lower)) return 'auth';
  if (/\b(recent transactions|transactions)\b/.test(lower)) return 'navigate';
  if (/\b(customize|language)\b/.test(lower) && /testfire|altoro|site/i.test(lower)) return 'navigate';
  if (extractInlineRoutes(text).length > 0 && /\b(?:api|graphql|file|metadata|configuration|documentation|surface|surfaces|visit)\b/.test(lower)) return 'navigate';
  if (/search/.test(lower)) return 'search';
  if (/(?:add|put).{0,40}(?:cart|basket)|(?:cart|basket).{0,40}(?:add|product item)/.test(lower)) return 'add-to-cart';
  if (/feedback|customer-feedback|contact form/.test(lower)) return 'submit-feedback';
  if (/transfer/.test(lower)) return 'transfer-funds';
  if (/checkout/.test(lower)) return 'open-surface';
  if (/open|view|visit|route|crawl|return|logout|basket|profile|account|history|wallet|payment|address|settings/.test(lower)) return 'navigate';
  if (/submit|review|add|remove|select|language/.test(lower)) return 'submit-form';
  return 'assert-state';
}

function inferStepValue(text, type) {
  const source = String(text || '');
  if (type === 'assert-state' && (isCoverageObjectiveText(source) || isPolicyConstraintText(source))) return undefined;
  const quoted = source.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
  if (quoted && (type === 'search' || type === 'submit-feedback')) return quoted[1] || quoted[2] || quoted[3];
  if (type === 'search' && /\bnews articles?\b/i.test(source)) return 'News Articles';
  return source;
}

function inferStepCount(text, type) {
  if (type !== 'add-to-cart') return undefined;
  const match = String(text || '').match(/\b(\d{1,2})\b/);
  return match ? Number(match[1]) : undefined;
}

function inferStepTarget(text, type) {
  const lower = String(text || '').toLowerCase();
  if (isCoverageObjectiveText(lower) || isPolicyConstraintText(lower)) return undefined;
  const inlineRoutes = extractInlineRoutes(text);
  if ((type === 'auth' || type === 'navigate' || type === 'open-surface') && inlineRoutes.length === 1) return { route: inlineRoutes[0] };
  if ((type === 'auth' || type === 'navigate' || type === 'open-surface') && inlineRoutes.length > 1) return { routes: inlineRoutes };
  if (/\baccount summary\b/.test(lower)) return { route: '/bank/main.jsp' };
  if (/\b(recent transactions|transactions)\b/.test(lower)) return { route: '/bank/transaction.jsp' };
  if (/\bnews articles?\b/.test(lower)) return { route: '/search.jsp?query=News+Articles' };
  if (/\btransfer\b/.test(lower)) return { route: '/bank/transfer.jsp' };
  if (/\b(customize|language)\b/.test(lower) && /testfire|altoro|site/i.test(lower)) {
    return {
      routes: [
        '/bank/customize.jsp',
        '/bank/customize.jsp?content=customize.jsp&lang=international',
        '/bank/customize.jsp?content=customize.jsp&lang=english'
      ]
    };
  }
  if (type === 'search') return { route: '/#/search' };
  if (type === 'submit-feedback') return { route: '/#/contact', form: 'customer-feedback' };
  if (type === 'add-to-cart') return { surfaceType: 'product-card' };
  if (type !== 'navigate' && type !== 'open-surface') return undefined;
  if (/\bprofile\b/.test(lower)) return { route: '/profile' };
  if (/\b(cart|basket)\b/.test(lower)) return { route: '/#/basket' };
  if (/\border history|orders\b/.test(lower)) return { route: '/#/order-history' };
  if (/\bwallet\b/.test(lower)) return { route: '/#/wallet' };
  if (/\baddress\b/.test(lower)) return { route: '/#/address/saved' };
  if (/\bpayment|card\b/.test(lower)) return { route: '/#/saved-payment-methods' };
  if (/\bscore board|scoreboard\b/.test(lower)) return { route: '/#/score-board' };
  if (/\bcomplain|complaint\b/.test(lower)) return { route: '/#/complain' };
  if (/\bsupport\b/.test(lower)) return { route: '/#/support' };
  return undefined;
}

function inferFailureBehavior(text, type) {
  const lower = String(text || '').toLowerCase();
  if (type === 'assert-state' && (isCoverageObjectiveText(lower) || isPolicyConstraintText(lower))) return 'continue';
  if (type === 'navigate' && /\bwhen\b.{0,80}\b(?:expose|available|reachable|present|visible)\b/.test(lower)) {
    return 'continue';
  }
  return undefined;
}

function inferStepTimeoutMs(type, target) {
  if (type === 'navigate' && target && Array.isArray(target.routes) && target.routes.length > 1) return 15000;
  return undefined;
}

function isCoverageObjectiveText(text) {
  const lower = String(text || '').toLowerCase();
  return /\bbroad coverage\b/.test(lower)
    || /\bcrawl\b.{0,80}\b(?:whole|site|website|target|deterministic)\b/.test(lower)
    || /\bfind as many\b.{0,80}\b(?:links|routes|endpoints|surfaces)\b/.test(lower)
    || /\bcontinue deterministic crawling\b/.test(lower)
    || /\bfrom route hints\b/.test(lower);
}

function isPolicyConstraintText(text) {
  const lower = String(text || '').toLowerCase().trim();
  return /^(?:do not|don't|stay on|never|use\s+`?--|use benchmark-specific|do not write|do not execute|do not rely)\b/.test(lower);
}

function extractInlineRoutes(text) {
  const routes = [];
  for (const match of String(text || '').matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (/^(?:\/|#\/|https?:\/\/)/i.test(value)) routes.push(value);
  }
  return Array.from(new Set(routes));
}

function extractRouteHints(markdown) {
  const hints = new Set();
  for (const match of String(markdown || '').matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (/^(\/|#\/|https?:\/\/)/.test(value)) hints.add(value);
  }
  const lower = markdown.toLowerCase();
  const addIf = (pattern, values) => {
    if (pattern.test(lower)) for (const value of values) hints.add(value);
  };
  addIf(/juice shop|basket|score board|digital wallet|saved address|payment method|customer-feedback|feedback/, [
    '/#/login',
    '/profile',
    '/#/contact',
    '/#/search?q=apple',
    '/#/search?q=juice',
    '/#/basket',
    '/#/checkout',
    '/#/score-board',
    '/#/support',
    '/#/complain',
    '/#/order-history',
    '/#/wallet',
    '/#/address/saved',
    '/#/saved-payment-methods'
  ]);
  addIf(/testfire|altoro|account summary|transfer funds|recent transactions|news articles/, [
    '/login.jsp',
    '/bank/main.jsp',
    '/bank/transfer.jsp',
    '/bank/transaction.jsp',
    '/search.jsp?query=News+Articles',
    '/index.jsp'
  ]);
  return Array.from(hints);
}

function compileMarkdownScenario(markdown, options = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const goal = lines.find(line => /^goal:/i.test(line)) || '';
  const routeHints = extractRouteHints(markdown);
  const stepLines = extractMarkdownStepLines(lines);
  const steps = stepLines.map((text, index) => {
    const type = inferStepType(text);
    const coverageObjective = isCoverageObjectiveText(text);
    const policyConstraint = isPolicyConstraintText(text);
    const target = inferStepTarget(text, type) || inferStepTargetFromScenarioHints(type, routeHints);
    return {
      id: slug(text, `step-${index + 1}`).slice(0, 64),
      type,
      value: inferStepValue(text, type),
      target,
      count: inferStepCount(text, type),
      timeoutMs: inferStepTimeoutMs(type, target),
      failureBehavior: inferFailureBehavior(text, type),
      success: type === 'auth' ? { authState: 'authenticated' } : { completed: true },
      metadata: {
        sourceText: text,
        ...(coverageObjective ? { coverageObjective: true } : {}),
        ...(policyConstraint ? { policyConstraint: true } : {})
      }
    };
  });
  const rawScenario = {
    version: 'ptk-scenario-v2',
    steps: steps.length ? steps : [{
      id: 'crawl',
      type: 'navigate',
      value: goal || 'crawl target',
      success: { completed: true }
    }],
    metadata: {
      source: 'markdown',
      goal: goal.replace(/^goal:\s*/i, ''),
      routeHints
    }
  };
  return compileScenario(rawScenario, options);
}

function extractMarkdownStepLines(lines = []) {
  const bulletLines = lines
    .map(line => line.match(/^\s*(?:\d+\.|-|\*)\s+(.+?)\s*$/))
    .filter(Boolean)
    .map(match => match[1].trim())
    .filter(Boolean);
  if (bulletLines.length > 0) return bulletLines;

  const narrative = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) continue;
    if (/^goal:/i.test(trimmed)) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^\|/.test(trimmed)) continue;
    if (/^>/.test(trimmed)) continue;
    if (/^[-*_]{3,}$/.test(trimmed)) continue;
    narrative.push(trimmed.replace(/\s+$/, ''));
  }
  return narrative;
}

function inferStepTargetFromScenarioHints(type, routeHints = []) {
  if (type !== 'auth') return undefined;
  const loginRoute = (routeHints || []).find(route => /(?:^|\/|#\/)(?:login|signin|sign-in|userlogin|auth)(?:[/?#.]|$)/i.test(String(route || '')));
  return loginRoute ? { route: loginRoute } : undefined;
}

function loadScenarioFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (/\.md$/i.test(filePath)) return compileMarkdownScenario(text, options);
  return compileScenario(JSON.parse(text), options);
}

module.exports = {
  DEFAULT_STEP_TIMEOUT_MS,
  normalizeRetry,
  normalizeStep,
  compileScenario,
  compileMarkdownScenario,
  loadScenarioFile,
  extractMarkdownStepLines,
  extractRouteHints,
  inferStepType,
  inferStepTargetFromScenarioHints
};
