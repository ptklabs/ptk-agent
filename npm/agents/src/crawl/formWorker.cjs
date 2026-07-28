'use strict';

const { validateTransition } = require('../browser/transition.cjs');
const { extractPageModel } = require('../browser/pageModel.cjs');
const { createEventCollector, observePage } = require('../browser/eventCollector.cjs');
const { resolveOperationBudget, serializeBudget, withTimeout } = require('../core/budgets.cjs');
const { compactText, stableHash } = require('../browser/actionModel.cjs');
const { cssAttributeSelector, cssIdSelector } = require('../browser/cssSelector.cjs');
const {
  classifyField: classifyFieldStrategy,
  isSensitiveField: isSensitiveFieldStrategy,
  resolveFormSubmitPermission: resolveFormSubmitPermissionStrategy
} = require('./formStrategy.cjs');
const {
  resolveFieldValue: resolveProfileFieldValue,
  resolveProfileValues: resolveProfileValuesFromProfile,
  valueForField: valueForProfileField
} = require('../profiles/profileValueResolver.cjs');

const REDACTED = '[redacted]';
const SENSITIVE_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session)/i;
const PAGE_FORM_LEDGERS = new WeakMap();
const COMMON_PROFILE_KEYS = Object.freeze([
  'username',
  'user',
  'login',
  'email',
  'password',
  'name',
  'firstName',
  'lastName',
  'phone',
  'tel',
  'mobile',
  'search',
  'query',
  'q',
  'text',
  'message'
]);

function resolveFormBudgets(config = {}, options = {}) {
  const crawler = config.crawler || config;
  const policy = config._budgetPolicy || {};
  const useFreshOperationBudget = Boolean(options.step || options.parentDeadline || options.operation);
  const observationOperation = options.observationOperation || observationOperationFor(options.operation);
  const actionBudget = useFreshOperationBudget ? resolveOperationBudget(config, options.operation || 'crawler-form-submit', {
    step: options.step,
    parentDeadline: options.parentDeadline
  }) : policy.formSubmit || resolveOperationBudget(config, options.operation || 'crawler-form-submit', {
    step: options.step,
    parentDeadline: options.parentDeadline
  });
  const observationBudget = useFreshOperationBudget ? resolveOperationBudget(config, observationOperation, {
    step: options.step,
    parentDeadline: options.parentDeadline
  }) : policy.observation || resolveOperationBudget(config, observationOperation, {
    step: options.step,
    parentDeadline: options.parentDeadline
  });
  return {
    maxActionMs: actionBudget.budgetMs || (Number(crawler.maxActionMs) > 0 ? Number(crawler.maxActionMs) : 1000),
    maxObservationMs: observationBudget.budgetMs || (Number(crawler.maxObservationMs) >= 0 ? Number(crawler.maxObservationMs) : 800),
    actionBudget,
    observationBudget
  };
}

function observationOperationFor(operation = '') {
  const text = String(operation || '').toLowerCase();
  if (text.startsWith('scenario-')) return 'scenario-observation';
  if (text.startsWith('workflow-')) return 'workflow-observation';
  return 'crawler-observation';
}

function classifyField(field) {
  return classifyFieldStrategy(field || {});
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveField(field, kind = classifyField(field || {})) {
  return isSensitiveFieldStrategy(field || {}, kind);
}

function redactValue(value) {
  if (value === null || value === undefined || value === '') return value;
  return REDACTED;
}

function scalarEntries(source = {}, keys = COMMON_PROFILE_KEYS) {
  const out = {};
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] === 'string' || typeof source[key] === 'number' || typeof source[key] === 'boolean') {
      out[key] = source[key];
    }
  }
  return out;
}

function selectPersona(profile = {}, personaId = null) {
  if (!Array.isArray(profile.personas) || profile.personas.length === 0) return null;
  if (!personaId && profile.personas.length === 1) return profile.personas[0];
  return profile.personas.find(persona => persona && (persona.id === personaId || persona.name === personaId)) || null;
}

function assignValues(target, source, valueSource) {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value) || Array.isArray(value)) continue;
    target.values[key] = value;
    target.sources[key] = valueSource;
  }
}

function resolveProfileValues(profile = {}, personaId = null) {
  return resolveProfileValuesFromProfile(profile, personaId);
}

function candidateValueKeys(field, kind) {
  const keys = [
    field.name,
    field.id,
    kind
  ].filter(Boolean);
  const aliases = {
    username: ['username', 'user', 'login', 'email', 'uid', 'userid', 'user_id', 'user-name', 'user_name'],
    email: ['email', 'username', 'user', 'login'],
    password: ['password', 'passwd', 'pwd', 'passw', 'pass'],
    search: ['search', 'query', 'q'],
    phone: ['phone', 'tel', 'mobile'],
    number: ['number', 'amount', 'quantity', 'qty'],
    name: ['name', 'fullName'],
    text: ['text', 'message']
  };
  for (const key of aliases[kind] || []) keys.push(key);
  return Array.from(new Set(keys.map(String)));
}

function defaultValueForKind(kind) {
  const defaults = {
    email: 'ptk@example.test',
    username: 'ptk-user',
    password: null,
    search: 'test',
    phone: '5550100',
    number: '1',
    checkbox: true,
    radio: true,
    name: 'PTK User',
    text: 'ptk test value',
    file: null
  };
  return defaults[kind] !== undefined ? defaults[kind] : defaults.text;
}

function resolveFieldValue(field, profile = {}) {
  return resolveProfileFieldValue(field || {}, profile || {});
}

function valueForField(field, profile = {}) {
  return valueForProfileField(field || {}, profile || {});
}

function fieldValueHash(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return stableHash(String(value));
}

function createSubmissionSignature(form, plannedFields) {
  const material = {
    formId: form.id || null,
    selector: form.selector || null,
    action: form.action || null,
    method: String(form.method || 'GET').toUpperCase(),
    fields: plannedFields.map(entry => ({
      key: entry.field.name || entry.field.id || entry.field.label || entry.kind,
      kind: entry.kind,
      required: Boolean(entry.field.required),
      valueHash: entry.valueHash
    }))
  };
  return `form-submit:${stableHash(JSON.stringify(material))}`;
}

function planFormSubmission(form, profile = {}, options = {}) {
  const signatureFields = [];
  const fields = (form.fields || []).map(field => {
    const resolved = resolveFieldValue(field, profile);
    const value = resolved.kind === 'file' && resolved.value
      ? '[file-fixture]'
      : resolved.sensitive && options.includeSecrets !== true ? redactValue(resolved.value) : resolved.value;
    signatureFields.push({
      field,
      kind: resolved.kind,
      valueHash: fieldValueHash(resolved.value)
    });
    return {
      field,
      kind: resolved.kind,
      value,
      redacted: (resolved.kind === 'file' || resolved.sensitive) && resolved.value !== null && resolved.value !== undefined,
      valueSource: resolved.source,
      valueKey: resolved.kind === 'file' && resolved.value ? 'file-fixture' : resolved.sensitive ? null : resolved.key,
      fillable: Boolean(field.selector || field.name || field.id) && resolved.value !== null && resolved.value !== undefined
    };
  });
  const missingRequired = fields
    .filter(entry => entry.field.required && (valueForField(entry.field, profile) === null || valueForField(entry.field, profile) === undefined || valueForField(entry.field, profile) === ''))
    .map(entry => entry.field.name || entry.field.id || entry.field.label || 'unknown');
  return {
    formId: form.id || null,
    selector: form.selector || null,
    action: form.action || null,
    method: form.method || 'GET',
    fields,
    missingRequired,
    canSubmit: missingRequired.length === 0,
    signature: createSubmissionSignature(form, signatureFields)
  };
}

function createFormAttemptLedger() {
  return {
    invalidSubmits: new Map(),
    submissions: new Map()
  };
}

function defaultSubmissionLedgerForPage(page) {
  if (!page || typeof page !== 'object') return null;
  let ledger = PAGE_FORM_LEDGERS.get(page);
  if (!ledger) {
    ledger = createFormAttemptLedger();
    PAGE_FORM_LEDGERS.set(page, ledger);
  }
  return ledger;
}

function getLedgerMap(ledger, key) {
  if (!ledger) return null;
  if (ledger instanceof Map && key === 'invalidSubmits') return ledger;
  if (ledger[key] instanceof Map) return ledger[key];
  if (isPlainObject(ledger[key])) return ledger[key];
  return null;
}

function getLedgerEntry(ledger, key, signature) {
  const map = getLedgerMap(ledger, key);
  if (!map) return null;
  if (map instanceof Map) return map.get(signature) || null;
  return map[signature] || null;
}

function setLedgerEntry(ledger, key, signature, value) {
  const map = getLedgerMap(ledger, key);
  if (!map) return;
  if (map instanceof Map) map.set(signature, value);
  else map[signature] = value;
}

function recordSubmission(ledger, signature, value) {
  setLedgerEntry(ledger, 'submissions', signature, value);
}

function recordInvalidSubmit(ledger, signature, value) {
  setLedgerEntry(ledger, 'invalidSubmits', signature, value);
}

function validationItemsFromForm(form = {}) {
  const messages = [];
  const invalidFields = [];
  for (const message of form.errors || form.feedback || form.validationMessages || []) {
    if (message) messages.push(typeof message === 'string' ? compactText(message, 240) : message);
  }
  for (const field of form.fields || []) {
    const invalid = field.invalid === true || field.ariaInvalid === true || field.ariaInvalid === 'true' || Boolean(field.validationMessage);
    if (!invalid) continue;
    invalidFields.push({
      field: field.name || field.id || field.label || 'unknown',
      message: compactText(field.validationMessage || field.error || field.hint || 'field marked invalid', 240)
    });
  }
  return { messages, invalidFields };
}

function normalizeFeedbackItem(item) {
  if (!item) return null;
  if (typeof item === 'string') return compactText(item, 240);
  if (isPlainObject(item)) return { ...item };
  return compactText(String(item), 240);
}

function mergeValidationFeedback(...items) {
  const merged = {
    blockers: [],
    authSignals: [],
    messages: [],
    invalidFields: [],
    requiredMissing: []
  };
  const seen = {
    blockers: new Set(),
    authSignals: new Set(),
    messages: new Set(),
    invalidFields: new Set(),
    requiredMissing: new Set()
  };
  const pushUnique = (key, item) => {
    const normalized = normalizeFeedbackItem(item);
    if (!normalized) return;
    const signature = JSON.stringify(normalized);
    if (seen[key].has(signature)) return;
    seen[key].add(signature);
    merged[key].push(normalized);
  };
  for (const item of items) {
    if (!item) continue;
    for (const blocker of item.blockers || []) pushUnique('blockers', blocker);
    for (const signal of item.authSignals || []) pushUnique('authSignals', signal);
    for (const message of [
      ...(item.messages || []),
      ...(item.validationMessages || []),
      ...(item.errors || [])
    ]) pushUnique('messages', message);
    for (const field of item.invalidFields || []) pushUnique('invalidFields', field);
    for (const field of item.requiredMissing || []) pushUnique('requiredMissing', field);
  }
  merged.hasValidation = hasValidationFeedback(merged);
  return merged;
}

function hasValidationFeedback(feedback = {}) {
  if ((feedback.invalidFields || []).length > 0) return true;
  if ((feedback.requiredMissing || []).length > 0) return true;
  if ((feedback.messages || []).some(isValidationMessage)) return true;
  return (feedback.blockers || []).some(blocker => {
    const text = `${blocker.kind || blocker.type || ''} ${blocker.text || blocker.message || ''}`.toLowerCase();
    return /validation|invalid|required|captcha|authorization|auth|error|denied|forbidden/.test(text);
  });
}

function isValidationMessage(message) {
  const text = typeof message === 'string'
    ? message
    : `${message && (message.text || message.message || message.error || message.reason) || ''}`;
  return /\b(validation|invalid|required|captcha|authorization|auth|error|denied|forbidden|incorrect|wrong|failed|missing)\b/i.test(text);
}

function extractValidationFeedback(pageModel = {}) {
  pageModel = pageModel || {};
  const fromForms = { messages: [], invalidFields: [] };
  for (const form of pageModel.forms || []) {
    const formFeedback = validationItemsFromForm(form);
    fromForms.messages.push(...formFeedback.messages);
    fromForms.invalidFields.push(...formFeedback.invalidFields);
  }
  return mergeValidationFeedback({
    blockers: pageModel.blockers || [],
    authSignals: pageModel.authSignals || []
  }, pageModel.validationFeedback, pageModel.feedback, fromForms);
}

async function collectDomValidationFeedback(page, form) {
  if (page && typeof page.collectValidationFeedback === 'function') return page.collectValidationFeedback(form);
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(({ formId, selector }) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const forms = Array.from(document.querySelectorAll('form'));
    const form = selector ? document.querySelector(selector) : forms.find(candidate => candidate.id === formId || candidate.name === formId) || forms[0];
    const roots = form ? [form, document] : [document];
    const messages = [];
    const invalidFields = [];
    const requiredMissing = [];
    for (const root of roots) {
      for (const element of Array.from(root.querySelectorAll('[role="alert"],.error,.invalid,.validation,.field-error,.text-danger,[aria-live="assertive"],[aria-live="polite"]')).slice(0, 50)) {
        const text = clean(element.innerText || element.textContent || element.getAttribute('aria-label'));
        if (text) messages.push(text);
      }
    }
    if (form) {
      for (const field of Array.from(form.querySelectorAll('input,textarea,select')).slice(0, 80)) {
        const key = field.name || field.id || field.getAttribute('aria-label') || field.tagName.toLowerCase();
        if (field.required && !field.value && !/checkbox|radio|file|hidden|submit|button/i.test(field.type || '')) requiredMissing.push(key);
        const message = clean(field.validationMessage || field.getAttribute('aria-errormessage') || '');
        if (message || field.getAttribute('aria-invalid') === 'true' || /\b(error|invalid|validation)\b/i.test(String(field.className || ''))) {
          invalidFields.push({ field: key, message: message || 'field marked invalid' });
        }
      }
    }
    return { messages, invalidFields, requiredMissing };
  }, { formId: form && form.id || null, selector: form && form.selector || null });
}

function resolveFormSubmitPermission(form = {}, { allowSubmit, authIntent = null, config = {} } = {}) {
  return resolveFormSubmitPermissionStrategy(form, { allowSubmit, authIntent, config });
}

async function runFormWorker({ page, form, profile = {}, config, telemetry, allowSubmit = undefined, authIntent = null, allowRepeatInvalid = false, submissionLedger = null, observe = observePage, modelExtractor = extractPageModel, feedbackExtractor = collectDomValidationFeedback, operation = 'crawler-form-submit', step = null, parentDeadline = null } = {}) {
  if (!form) throw new Error('runFormWorker requires form.');
  submissionLedger = submissionLedger || defaultSubmissionLedgerForPage(page);
  const budgets = resolveFormBudgets(config || {}, { operation, step, parentDeadline });
  const budgetSummary = {
    submit: serializeBudget(budgets.actionBudget),
    observation: serializeBudget(budgets.observationBudget)
  };
  const plan = planFormSubmission(form, profile);
  const permission = resolveFormSubmitPermission(form, { allowSubmit, authIntent, config });
  if (!permission.allowed) {
    return {
      formId: form.id,
      submitted: false,
      skipped: true,
      reason: permission.reason,
      plan,
      budget: budgetSummary
    };
  }
  if (!plan.canSubmit) {
    return {
      formId: form.id,
      submitted: false,
      skipped: true,
      reason: 'missing required values',
      plan,
      budget: budgetSummary,
      validationFeedback: mergeValidationFeedback({ requiredMissing: plan.missingRequired })
    };
  }
  const previousInvalid = allowRepeatInvalid ? null : getLedgerEntry(submissionLedger, 'invalidSubmits', plan.signature);
  if (previousInvalid) {
    return {
      formId: form.id,
      ok: false,
      submitted: false,
      skipped: true,
      reason: 'previous_invalid_submit',
      plan,
      budget: budgetSummary,
      validationFeedback: previousInvalid.validationFeedback || null,
      previousAttempt: {
        submittedAt: previousInvalid.submittedAt || null,
        reason: previousInvalid.reason || 'validation_feedback'
      }
    };
  }
  const modelOptions = {
    spaHashBaseUrl: config && config.target && config.target.baseUrl,
    preserveSpaHashRoutes: config && config.crawler && config.crawler.preserveSpaHashRoutes !== false,
    config,
    browserProbe: config && config.browserProbe
  };
  const before = await modelExtractor(page, modelOptions);
  const collector = observe === observePage && page && typeof page.on === 'function'
    ? createEventCollector(page, { maxObservationMs: budgets.maxObservationMs, config })
    : null;
  if (collector) collector.start();
  let observation = null;
  try {
    await submitFormWithNavigationAwareness(page, form, profile, budgets.maxActionMs, budgets.actionBudget);
    observation = collector
      ? await collector.observe(budgets.maxObservationMs)
      : await observe(page, { maxObservationMs: budgets.maxObservationMs, config });
  } catch (error) {
    if (collector) collector.stop();
    throw error;
  }
  const after = await modelExtractor(page, { ...modelOptions, baseUrl: before.url });
  const transition = validateTransition({ before, after, events: observation.events || observation, action: { id: form.id, kind: 'submit-form' } });
  const domFeedback = feedbackExtractor
    ? await withTimeout(feedbackExtractor(page, form, after), Math.max(1, budgets.maxObservationMs || 1), `collect validation feedback ${form.id}`, budgets.observationBudget).catch(() => null)
    : null;
  const validationFeedback = mergeValidationFeedback(extractValidationFeedback(after), domFeedback);
  const invalid = hasValidationFeedback(validationFeedback);
  const submittedAt = new Date().toISOString();
  recordSubmission(submissionLedger, plan.signature, { formId: form.id, submittedAt, transition, invalid });
  if (invalid) {
    recordInvalidSubmit(submissionLedger, plan.signature, {
      formId: form.id,
      submittedAt,
      reason: 'validation_feedback',
      validationFeedback
    });
  }
  if (telemetry) telemetry.event('form.submitted', { formId: form.id, transition, validation: { hasValidation: invalid } });
  return {
    formId: form.id,
    ok: !invalid,
    submitted: true,
    skipped: false,
    plan,
    budget: budgetSummary,
    transition,
    validationFeedback,
    observation,
    before,
    after
  };
}

async function submitFormWithNavigationAwareness(page, form, profile, timeoutMs, budget) {
  const beforeUrl = safePageUrl(page);
  if (!shouldWaitForFormNavigation(form) || !page || typeof page.waitForNavigation !== 'function') {
    try {
      const submitPromise = fillAndSubmitForm(page, form, profile);
      await withTimeout(submitPromise, timeoutMs, `submit form ${form.id}`, budget);
    } catch (error) {
      if (isNavigationContextError(error) && await submitNavigationRecovered(page, beforeUrl, timeoutMs)) return;
      throw error;
    }
    return;
  }
  const navigationTimeoutMs = navigationWaitMsForFormSubmit(timeoutMs);
  const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
    .then(() => ({ navigated: true }))
    .catch(error => ({ navigated: false, timeout: true, error }));
  const submitPromise = fillAndSubmitForm(page, form, profile);
  let submitError = null;
  try {
    await withTimeout(submitPromise, timeoutMs, `submit form ${form.id}`, budget);
  } catch (error) {
    submitError = error;
  }
  const navigationResult = await navigationPromise;
  if (submitError) {
    if (isNavigationContextError(submitError) && (navigationResult.navigated || await submitNavigationRecovered(page, beforeUrl, timeoutMs))) return;
    throw submitError;
  }
}

function safePageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? page.url() : null;
  } catch (_) {
    return null;
  }
}

function isNavigationContextError(error) {
  const message = String(error && error.message || error || '');
  return /execution context was destroyed|most likely because of a navigation|cannot find context with specified id/i.test(message);
}

async function submitNavigationRecovered(page, beforeUrl, timeoutMs) {
  if (!page) return false;
  const waitMs = Math.max(250, Math.min(1500, Number(timeoutMs) || 1000));
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('domcontentloaded', { timeout: waitMs }).catch(() => null);
  } else {
    await new Promise(resolve => setTimeout(resolve, Math.min(250, waitMs)));
  }
  const afterUrl = safePageUrl(page);
  return Boolean(afterUrl && beforeUrl && afterUrl !== beforeUrl);
}

function shouldWaitForFormNavigation(form = {}) {
  const method = String(form.method || 'GET').toUpperCase();
  const kind = String(form.kind || '').toLowerCase();
  if (kind === 'search' || method === 'GET') return false;
  return Boolean(form.action || method === 'POST');
}

function navigationWaitMsForFormSubmit(timeoutMs) {
  const budget = Number(timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) return 1500;
  return Math.max(250, Math.min(1500, budget));
}

function shouldPreferDomSubmit(form = {}) {
  const kind = String(form.kind || '').toLowerCase();
  if (kind === 'feedback' || kind === 'contact') return true;
  if (form.synthetic || form.virtual || /^synthetic-/.test(String(form.id || ''))) return true;
  return (form.fields || []).some(field => isCaptchaLikeField(field));
}

async function fillAndSubmitForm(page, form, profile) {
  if (page && typeof page.submitForm === 'function') return page.submitForm(form, profile);
  if (!page || typeof page.evaluate !== 'function') throw new Error('page cannot submit form');
  if (typeof page.locator === 'function' && !shouldPreferDomSubmit(form)) {
    const locatorSubmitted = await fillAndSubmitFormWithLocators(page, form, profile).catch(() => false);
    if (locatorSubmitted) return;
  }
  const fields = (form.fields || []).map(field => ({
    key: field.name || field.id || field.selector || field.label,
    selector: field.selector || null,
    name: field.name || null,
    id: field.id || null,
    type: field.type || null,
    value: valueForField(field, profile)
  }));
  const values = {};
  for (const field of fields) values[field.key] = field.value;
  if (typeof page.setInputFiles === 'function') {
    for (const field of fields) {
      if (String(field.type || '').toLowerCase() !== 'file' || !field.value) continue;
      const selector = field.selector || (field.id
        ? cssIdSelector(field.id)
        : field.name
          ? cssAttributeSelector('name', field.name)
          : null);
      if (selector) await page.setInputFiles(selector, field.value);
    }
  }
  return page.evaluate(({ formId, selector, submitSelector, fields: plannedFields, values: fieldValues }) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const findPlannedField = key => plannedFields.find(planned => planned.key === key || planned.id === key || planned.name === key) || {};
    const labelTextForInput = input => {
      const labels = [];
      if (input.id) {
        const explicit = Array.from(document.querySelectorAll('label[for]'))
          .find(label => label.htmlFor === input.id);
        if (explicit) labels.push(explicit.innerText || explicit.textContent);
      }
      for (const label of Array.from(input.labels || [])) labels.push(label.innerText || label.textContent);
      labels.push(input.getAttribute('aria-label'), input.getAttribute('placeholder'), input.name, input.id);
      const field = input.closest('mat-form-field,[role="group"],.form-group,.field');
      if (field) labels.push(field.innerText || field.textContent);
      return clean(labels.filter(Boolean).join(' '));
    };
    const isCaptchaInput = (input, key, planned = {}) => {
      const text = clean([
        key,
        planned.key,
        planned.id,
        planned.name,
        planned.type,
        labelTextForInput(input)
      ].filter(Boolean).join(' ')).toLowerCase();
      return /\bcaptcha\b|captcha[_-]?control|\bresult\b/.test(text);
    };
    const collectCaptchaHints = input => {
      const hints = [
        document.querySelector('#captcha') && document.querySelector('#captcha').textContent,
        labelTextForInput(input)
      ];
      for (const root of [
        input.closest('form'),
        input.closest('mat-card'),
        input.closest('section'),
        input.closest('main'),
        document.body
      ]) {
        if (root) hints.push(root.innerText || root.textContent);
      }
      return clean(hints.filter(Boolean).join(' '));
    };
    const solveMathCaptcha = text => {
      const cleaned = clean(text);
      const lower = cleaned.toLowerCase();
      const captchaIndex = lower.lastIndexOf('captcha');
      const scoped = captchaIndex >= 0 ? cleaned.slice(captchaIndex, captchaIndex + 220) : cleaned;
      const expression = scoped.match(/(\d{1,3}(?:\s*[+\-*/xX÷]\s*\d{1,3}){1,6})/);
      if (!expression) return null;
      const normalized = expression[1].replace(/[xX]/g, '*').replace(/÷/g, '/');
      if (!/^[0-9+\-*/\s]+$/.test(normalized)) return null;
      const tokens = normalized.match(/\d{1,3}|[+\-*/]/g) || [];
      if (tokens.length < 3 || tokens.length % 2 === 0) return null;
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
      for (let index = 0; index < ops.length; index += 1) total = ops[index] === '+' ? total + values[index + 1] : total - values[index + 1];
      return Number.isFinite(total) ? String(total) : null;
    };
    const forms = Array.from(document.querySelectorAll('form'));
    const form = selector ? document.querySelector(selector) : forms.find(candidate => candidate.id === formId || candidate.name === formId) || forms[0];
    const resolveField = planned => {
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
    const inputs = form
      ? Array.from(form.querySelectorAll('input,textarea,select')).map(input => ({ input, key: input.name || input.id }))
      : plannedFields.map(planned => ({ input: resolveField(planned), key: planned.key })).filter(entry => entry.input);
    if (!inputs.length) throw new Error('form fields not found');
    for (const { input, key } of inputs) {
      if (!key || input.type === 'hidden' || input.type === 'submit' || input.type === 'button' || input.type === 'file') continue;
      if (Object.prototype.hasOwnProperty.call(fieldValues, key) && fieldValues[key] !== null) {
        const planned = findPlannedField(key);
        let value = fieldValues[key];
        if (isCaptchaInput(input, key, planned)) {
          const solved = solveMathCaptcha(collectCaptchaHints(input));
          if (solved !== null) value = solved;
        }
        if (input.type === 'checkbox' || input.type === 'radio') input.checked = Boolean(value);
        else if (input.tagName && input.tagName.toLowerCase() === 'select') {
          const desired = String(value);
          const options = Array.from(input.options || []).filter(option => !option.disabled);
          const exact = options.find(option => option.value === desired || (option.textContent || '').trim() === desired);
          const index = /second|different|to/i.test(desired) || /to/i.test(key) ? 1 : 0;
          const selected = exact || options[index] || options[0];
          if (selected) input.value = selected.value;
        } else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (form) {
      const explicitSubmit = submitSelector ? document.querySelector(submitSelector) : null;
      const submit = explicitSubmit || Array.from(form.querySelectorAll('button,input[type="submit"],[role="button"]')).find(control => {
        if (!control || control.disabled) return false;
        const tag = String(control.tagName || '').toLowerCase();
        const type = String(control.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' && type !== 'submit') return false;
        if (tag === 'button' && type && !['submit', 'button'].includes(type)) return false;
        const rects = typeof control.getClientRects === 'function' ? control.getClientRects() : [];
        return !rects || rects.length > 0;
      });
      if (submit && typeof submit.click === 'function') {
        submit.click();
        return;
      }
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (typeof form.submit === 'function') form.submit();
      return;
    }
    const submit = submitSelector ? document.querySelector(submitSelector) : null;
    if (submit) {
      submit.click();
      return;
    }
    const fallback = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).find(button => /log\s*in|login|sign\s*in|signin|search|submit|send|continue/i.test(button.innerText || button.textContent || button.value || button.id || button.name || ''));
    if (fallback) {
      fallback.click();
      return true;
    }
    const enterInput = inputs
      .map(entry => entry.input)
      .reverse()
      .find(input => input && !input.disabled && !input.readOnly && !['hidden', 'submit', 'button', 'file'].includes(String(input.type || '').toLowerCase()));
    if (enterInput) {
      enterInput.focus();
      enterInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      enterInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }, { formId: form.id, selector: form.selector, submitSelector: form.submitSelector, fields, values });
}

function selectorForField(field = {}) {
  if (field.selector) return field.selector;
  if (field.id) return cssAttributeSelector('id', field.id);
  if (field.name) return cssAttributeSelector('name', field.name);
  return null;
}

function isCaptchaLikeField(field = {}) {
  const text = `${field.name || ''} ${field.id || ''} ${field.label || ''} ${field.placeholder || ''} ${field.type || ''}`.toLowerCase();
  return /\bcaptcha\b|captcha[_-]?control|\bresult\b/.test(text);
}

function isCredentialLikeField(field = {}) {
  const type = String(field.type || '').toLowerCase();
  const text = `${field.name || ''} ${field.id || ''} ${field.label || ''} ${field.placeholder || ''} ${field.autocomplete || ''}`.toLowerCase();
  if (type === 'password' || type === 'email') return true;
  return /\b(e-?mail|user(name)?|login|account)\b/.test(text);
}

async function solveMathCaptchaFromPage(page, field = {}) {
  if (!isCaptchaLikeField(field) || !page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(({ selector }) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const input = selector ? document.querySelector(selector) : null;
    const hints = [
      document.querySelector('#captcha') && document.querySelector('#captcha').textContent
    ];
    for (const root of [
      input && input.closest('form'),
      input && input.closest('mat-card'),
      input && input.closest('section'),
      input && input.closest('main'),
      document.body
    ]) {
      if (root) hints.push(root.innerText || root.textContent);
    }
    const text = clean(hints.filter(Boolean).join(' '));
    const lower = text.toLowerCase();
    const captchaIndex = lower.lastIndexOf('captcha');
    const scoped = captchaIndex >= 0 ? text.slice(captchaIndex, captchaIndex + 220) : text;
    const expression = scoped.match(/(\d{1,3}(?:\s*[+\-*/xX÷]\s*\d{1,3}){1,6})/);
    if (!expression) return null;
    const normalized = expression[1].replace(/[xX]/g, '*').replace(/÷/g, '/');
    if (!/^[0-9+\-*/\s]+$/.test(normalized)) return null;
    const tokens = normalized.match(/\d{1,3}|[+\-*/]/g) || [];
    if (tokens.length < 3 || tokens.length % 2 === 0) return null;
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
    for (let index = 0; index < ops.length; index += 1) total = ops[index] === '+' ? total + values[index + 1] : total - values[index + 1];
    return Number.isFinite(total) ? String(total) : null;
  }, { selector: selectorForField(field) }).catch(() => null);
}

async function fillAndSubmitFormWithLocators(page, form, profile) {
  const optionalFieldTimeoutMs = 250;
  const credentialFieldTimeoutMs = 750;
  const plannedFields = (form.fields || []).map(field => ({
    field,
    selector: selectorForField(field),
    value: valueForField(field, profile)
  })).filter(entry => entry.selector && entry.value !== null && entry.value !== undefined);
  if (plannedFields.length === 0) return false;
  let filledCount = 0;
  let credentialFieldCount = 0;
  let filledCredentialCount = 0;
  for (const planned of plannedFields) {
    const field = planned.field || {};
    const type = String(field.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'file'].includes(type)) continue;
    const credentialField = isCredentialLikeField(field);
    if (credentialField) credentialFieldCount += 1;
    const fieldTimeoutMs = credentialField ? credentialFieldTimeoutMs : optionalFieldTimeoutMs;
    const locator = page.locator(planned.selector).first();
    let value = planned.value;
    const captchaValue = await solveMathCaptchaFromPage(page, field);
    if (captchaValue !== null) value = captchaValue;
    try {
      const tagName = await locator
        .evaluate(element => String(element && element.tagName ? element.tagName : '').toLowerCase(), undefined, { timeout: fieldTimeoutMs })
        .catch(() => String(field.tagName || '').toLowerCase());
      if (type === 'checkbox' || type === 'radio') {
        if (value === false && typeof locator.uncheck === 'function') await locator.uncheck({ timeout: fieldTimeoutMs }).catch(() => {});
        else if (typeof locator.check === 'function') await locator.check({ timeout: fieldTimeoutMs }).catch(() => {});
        filledCount += 1;
        if (credentialField) filledCredentialCount += 1;
        continue;
      }
      if (type === 'select' || tagName === 'select') {
        const selected = await locator.selectOption(String(value), { timeout: fieldTimeoutMs })
          .then(() => true)
          .catch(() => locator.evaluate((element, desired) => {
            if (!element || !element.options) return false;
            const options = Array.from(element.options).filter(option => !option.disabled);
            const exact = options.find(option => option.value === desired || String(option.textContent || '').trim() === desired);
            const key = String(element.name || element.id || element.getAttribute('aria-label') || '').toLowerCase();
            const desiredText = String(desired || '').toLowerCase();
            const index = /second|different|destination|credit|\bto\b/.test(desiredText) || /\bto\b|destination|credit/.test(key) ? 1 : 0;
            const selectedOption = exact || options[index] || options[0];
            if (!selectedOption) return false;
            element.value = selectedOption.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, String(value), { timeout: fieldTimeoutMs }).catch(() => false));
        if (selected) {
          filledCount += 1;
          if (credentialField) filledCredentialCount += 1;
        }
        continue;
      }
      await locator.fill(String(value), { timeout: fieldTimeoutMs });
      filledCount += 1;
      if (credentialField) filledCredentialCount += 1;
    } catch (error) {
      if (credentialField) return false;
    }
  }
  if (filledCount === 0) return false;
  if (credentialFieldCount > 0 && filledCredentialCount < credentialFieldCount) return false;
  const submitSelector = form.submitSelector || 'button[type="submit"],input[type="submit"],button:not([type]),[role="button"]';
  const beforeSubmitUrl = safePageUrl(page);
  const submit = form.selector
    ? page.locator(form.selector).first().locator(submitSelector).first()
    : page.locator(submitSelector).first();
  const clicked = await submit.click({ timeout: 600 })
    .then(() => true)
    .catch(async error => {
      if (isNavigationContextError(error) && await submitNavigationRecovered(page, beforeSubmitUrl, 1000)) return true;
      const fallbackClicked = await page.locator(submitSelector).first().click({ timeout: 1000 })
        .then(() => true)
        .catch(async fallbackError => {
          if (isNavigationContextError(fallbackError) && await submitNavigationRecovered(page, beforeSubmitUrl, 1000)) return true;
          return false;
        });
      if (fallbackClicked) return true;
      return submitNavigationRecovered(page, beforeSubmitUrl, 1000);
    });
  if (clicked) return true;
  const enterTarget = [...plannedFields]
    .reverse()
    .find(entry => entry && entry.selector && !['hidden', 'submit', 'button', 'file'].includes(String(entry.field && entry.field.type || '').toLowerCase()));
  if (enterTarget) {
    const pressed = await page.locator(enterTarget.selector).first().press('Enter', { timeout: 750 })
      .then(() => true)
      .catch(() => false);
    if (pressed) return true;
  }
  return false;
}

function createFormWorker(defaults = {}) {
  const submissionLedger = defaults.submissionLedger || createFormAttemptLedger();
  return {
    runFormWorker: input => runFormWorker({ submissionLedger, ...defaults, ...(input || {}) })
  };
}

module.exports = {
  createFormWorker,
  createFormAttemptLedger,
  classifyField,
  collectDomValidationFeedback,
  createSubmissionSignature,
  extractValidationFeedback,
  hasValidationFeedback,
  mergeValidationFeedback,
  valueForField,
  resolveFieldValue,
  resolveProfileValues,
  planFormSubmission,
  resolveFormSubmitPermission,
  runFormWorker,
  shouldWaitForFormNavigation,
  navigationWaitMsForFormSubmit,
  fillAndSubmitForm,
  recordInvalidSubmit,
  resolveFormBudgets
};
