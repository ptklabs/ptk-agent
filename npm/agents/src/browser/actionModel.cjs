'use strict';

const { locatorPlanFromControl } = require('./locatorResolver.cjs');
const { cssAttributeSelector, cssIdSelector } = require('./cssSelector.cjs');

const ACTION_KINDS = Object.freeze({
  CLICK_LINK: 'click-link',
  CLICK_BUTTON: 'click-button',
  SUBMIT_FORM: 'submit-form',
  TYPE_SEARCH: 'type-search',
  OPEN_MENU: 'open-menu',
  OPEN_TAB: 'open-tab',
  OPEN_ACCORDION: 'open-accordion',
  OPEN_MODAL: 'open-modal',
  PAGINATE: 'paginate',
  SPA_NAVIGATE: 'spa-navigate'
});

const RISK_TIERS = Object.freeze({
  SAFE: 'safe-interaction',
  BUSINESS_MUTATION: 'business-mutation',
  TERMINAL_DESTRUCTIVE: 'terminal-destructive',
  UNKNOWN: 'unknown'
});

const SAFE_ACTION_KINDS = new Set([
  ACTION_KINDS.CLICK_LINK,
  ACTION_KINDS.OPEN_MENU,
  ACTION_KINDS.OPEN_TAB,
  ACTION_KINDS.OPEN_ACCORDION,
  ACTION_KINDS.OPEN_MODAL,
  ACTION_KINDS.PAGINATE,
  ACTION_KINDS.SPA_NAVIGATE,
  ACTION_KINDS.TYPE_SEARCH
]);

function compactText(value, maxLength = 140) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function stableHash(value) {
  const input = Array.isArray(value) ? value.join('|') : String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function inferActionKind(action) {
  const tag = String(action.tagName || action.tag || '').toLowerCase();
  const role = String(action.role || '').toLowerCase();
  const type = String(action.type || '').toLowerCase();
  const text = compactText(action.ariaLabel || action.label || action.text || action.name, 160).toLowerCase();

  if (action.kind) return String(action.kind);
  if (tag === 'a' || action.href) return ACTION_KINDS.CLICK_LINK;
  if (role === 'tab') return ACTION_KINDS.OPEN_TAB;
  if (tag === 'summary' || action.controlsAccordion) return ACTION_KINDS.OPEN_ACCORDION;
  if (action.opensDialog || action.hasPopup === 'dialog') return ACTION_KINDS.OPEN_MODAL;
  if (action.expands || hasAriaExpanded(action) || action.hasPopup === 'menu') return ACTION_KINDS.OPEN_MENU;
  if (type === 'search' || /\bsearch\b/.test(text)) return ACTION_KINDS.TYPE_SEARCH;
  if (type === 'submit' || action.formId || action.formAction) return ACTION_KINDS.SUBMIT_FORM;
  if (/\b(next|previous|more|load more|page)\b/.test(text)) return ACTION_KINDS.PAGINATE;
  if (action.spaRoute || action.dataRoute) return ACTION_KINDS.SPA_NAVIGATE;
  return ACTION_KINDS.CLICK_BUTTON;
}

function hasAriaExpanded(action = {}) {
  return action.ariaExpanded !== undefined && action.ariaExpanded !== null && action.ariaExpanded !== '';
}

function riskTierForAction(action) {
  const kind = inferActionKind(action || {});
  const text = compactText(`${action && (action.ariaLabel || action.label || action.text || action.name || '')} ${action && (action.type || '')}`, 220).toLowerCase();
  if (/\b(delete|remove|destroy|drop|reset|revoke|disable|deactivate|cancel account|transfer|pay|purchase|buy now|place order)\b/.test(text)) {
    return RISK_TIERS.TERMINAL_DESTRUCTIVE;
  }
  if (kind === ACTION_KINDS.SUBMIT_FORM || /\b(submit|save|create|update|checkout|buy)\b/.test(text)) {
    return RISK_TIERS.BUSINESS_MUTATION;
  }
  if (SAFE_ACTION_KINDS.has(kind)) return RISK_TIERS.SAFE;
  return RISK_TIERS.UNKNOWN;
}

function expectedEffect(action) {
  const kind = inferActionKind(action || {});
  if (action && action.expectedEffect) return action.expectedEffect;
  if (kind === ACTION_KINDS.CLICK_LINK || kind === ACTION_KINDS.SPA_NAVIGATE) return 'route-change';
  if (kind === ACTION_KINDS.OPEN_MENU) return 'surface-expansion';
  if (kind === ACTION_KINDS.OPEN_TAB) return 'surface-change';
  if (kind === ACTION_KINDS.OPEN_ACCORDION) return 'toggle-surface';
  if (kind === ACTION_KINDS.OPEN_MODAL) return 'modal-open';
  if (kind === ACTION_KINDS.PAGINATE) return 'pagination';
  if (kind === ACTION_KINDS.TYPE_SEARCH) return 'search-results';
  if (kind === ACTION_KINDS.SUBMIT_FORM) return 'form-submit';
  return 'unknown';
}

function selectorForAction(action) {
  if (!action) return null;
  if (action.selector || action.internalSelector || action.css) return action.selector || action.internalSelector || action.css;
  if (action.testId) return cssAttributeSelector('data-testid', action.testId);
  if (action.id && !String(action.id).includes(':')) return cssIdSelector(action.id);
  if (action.name) return cssAttributeSelector('name', action.name);
  return null;
}

function normalizeAction(rawAction, index = 0, options = {}) {
  const raw = rawAction || {};
  const kind = inferActionKind(raw);
  const label = compactText(raw.ariaLabel || raw.label || raw.text || raw.name || raw.href || kind, 160);
  const selector = selectorForAction(raw);
  const riskTier = raw.riskTier || raw.risk || riskTierForAction(raw);
  const id = raw.actionId || raw.id || `${kind}:${stableHash([kind, label, selector || raw.href || index])}`;
  const normalized = {
    id,
    kind,
    label,
    href: raw.href || raw.url || null,
    routeTarget: raw.routeTarget || raw.dataRoute || null,
    selector,
    formId: raw.formId || null,
    riskTier,
    safe: isSafeAction({ kind, riskTier }, options),
    expectedEffect: raw.expectedEffect || expectedEffect({ ...raw, kind }),
    expectedEffectGuess: raw.expectedEffectGuess || raw.expectedEffect || expectedEffect({ ...raw, kind }),
    source: raw.source || 'dom',
    semanticKind: raw.semanticKind || null,
    semanticScore: Number.isFinite(Number(raw.semanticScore)) ? Number(raw.semanticScore) : null,
    locatorPlan: raw.locatorPlan || locatorPlanFromControl({ ...raw, kind, selector, label, href: raw.href || raw.url || null }, { critical: false }),
    raw
  };
  return normalized;
}

function rawActionsFromPageModel(pageModel) {
  if (Array.isArray(pageModel)) return pageModel;
  const model = pageModel || {};
  const raw = [];
  for (const link of model.links || []) {
    if (link.sameOrigin === false) continue;
    raw.push({
      id: link.id,
      kind: ACTION_KINDS.CLICK_LINK,
      label: link.text || link.label || link.href,
      href: link.href,
      selector: link.selector,
      source: 'link'
    });
  }
  for (const action of model.actions || []) raw.push(action);
  for (const form of model.forms || []) {
    raw.push({
      id: `form:${form.id}`,
      kind: form.kind === 'search' ? ACTION_KINDS.TYPE_SEARCH : ACTION_KINDS.SUBMIT_FORM,
      label: form.id || form.action,
      formId: form.id,
      selector: form.selector,
      riskTier: form.kind === 'search' || form.kind === 'login' ? RISK_TIERS.SAFE : RISK_TIERS.BUSINESS_MUTATION,
      expectedEffect: form.kind === 'search' ? 'search-results' : 'form-submit',
      source: 'form'
    });
  }
  return raw;
}

function normalizeActions(pageModelOrActions, options = {}) {
  const maxActions = Number.isFinite(options.maxActions) ? options.maxActions : 100;
  const seen = new Set();
  const normalized = [];
  for (const [index, raw] of rawActionsFromPageModel(pageModelOrActions).entries()) {
    const action = normalizeAction(raw, index, options);
    const signature = [action.kind, action.selector || '', action.href || '', action.label || ''].join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    normalized.push(action);
    if (normalized.length >= maxActions) break;
  }
  return normalized;
}

function isSafeAction(action, options = {}) {
  const riskTier = String(action.riskTier || RISK_TIERS.UNKNOWN);
  if (riskTier === RISK_TIERS.TERMINAL_DESTRUCTIVE) return false;
  if (riskTier === RISK_TIERS.BUSINESS_MUTATION) return Boolean(options.allowBusinessMutation);
  if (riskTier === RISK_TIERS.SAFE) return true;
  return SAFE_ACTION_KINDS.has(action.kind) && options.allowUnknownRisk === true;
}

function safeActions(pageModelOrActions, options = {}) {
  return normalizeActions(pageModelOrActions, options).filter(action => isSafeAction(action, options));
}

module.exports = {
  ACTION_KINDS,
  RISK_TIERS,
  SAFE_ACTION_KINDS,
  compactText,
  stableHash,
  inferActionKind,
  normalizeAction,
  normalizeActions,
  safeActions,
  isSafeAction,
  riskTierForAction,
  expectedEffect
};
