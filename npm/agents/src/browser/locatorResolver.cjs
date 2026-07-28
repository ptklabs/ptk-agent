'use strict';

const { cssAttributeSelector, cssIdSelector } = require('./cssSelector.cjs');

const GENERIC_SELECTOR_RE = /^(?:a|button|input|select|textarea|form|summary)$/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  if (value instanceof RegExp) return value;
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function isGenericSelector(selector) {
  return GENERIC_SELECTOR_RE.test(String(selector || '').trim());
}

function locatorPlanFromControl(control = {}, options = {}) {
  if (!control) return null;
  if (control.locatorPlan) return control.locatorPlan;
  const critical = options.critical === true;
  const testId = control.testId || control.dataTestId || control.dataTest || control.raw && (control.raw.testId || control.raw.dataTestId);
  if (testId) return { strategy: 'testid', value: String(testId), critical };
  const selector = control.selector || control.css || control.internalSelector;
  if (selector && !isGenericSelector(selector)) return { strategy: 'css', selector, strict: Boolean(options.strict), critical };
  if (control.role && (control.ariaLabel || control.label || control.name || control.text)) {
    return { strategy: 'role', role: control.role, name: normalizeName(control.ariaLabel || control.label || control.name || control.text), critical };
  }
  if (control.kind === 'click-link' && control.href) return { strategy: 'href', href: control.href, name: normalizeName(control.label || control.text), critical };
  if (control.ariaLabel || control.label || control.name || control.text) {
    const text = normalizeName(control.ariaLabel || control.label || control.name || control.text);
    if (control.kind && /link/i.test(control.kind)) return { strategy: 'role', role: 'link', name: text, critical };
    return { strategy: 'role', role: control.type === 'submit' ? 'button' : 'button', name: text, critical };
  }
  if (selector) return { strategy: 'css', selector, strict: false, critical };
  return null;
}

function locatorPlanFromField(field = {}, options = {}) {
  if (!field) return null;
  if (field.locatorPlan) return field.locatorPlan;
  const critical = options.critical === true;
  if (field.testId || field.dataTestId) return { strategy: 'testid', value: String(field.testId || field.dataTestId), critical };
  if (field.label) return { strategy: 'label', label: String(field.label), critical };
  if (field.selector && !isGenericSelector(field.selector)) return { strategy: 'css', selector: field.selector, strict: Boolean(options.strict), critical };
  if (field.name) return { strategy: 'css', selector: cssAttributeSelector('name', field.name), strict: Boolean(options.strict), critical };
  if (field.id) return { strategy: 'css', selector: cssIdSelector(field.id), strict: Boolean(options.strict), critical };
  return null;
}

function assertLocatorPlanSafe(plan = {}, options = {}) {
  if (!plan || !isPlainObject(plan)) throw new Error('locator plan is required');
  const critical = options.critical === true || plan.critical === true;
  if (plan.strategy === 'css' && critical && isGenericSelector(plan.selector)) {
    throw new Error(`Unsafe generic selector refused for critical action: ${plan.selector}`);
  }
  if (!plan.strategy) throw new Error('locator plan strategy is required');
  return true;
}

function resolveLocator(page, plan = {}, options = {}) {
  assertLocatorPlanSafe(plan, options);
  if (!page) throw new Error('page is required to resolve locator');
  if (page.resolveLocator) return page.resolveLocator(plan, options);
  if (plan.strategy === 'testid' && typeof page.getByTestId === 'function') return page.getByTestId(plan.value);
  if (plan.strategy === 'role' && typeof page.getByRole === 'function') {
    const locatorOptions = {};
    const name = normalizeName(plan.name);
    if (name) locatorOptions.name = name;
    return page.getByRole(plan.role || 'button', locatorOptions);
  }
  if (plan.strategy === 'label' && typeof page.getByLabel === 'function') return page.getByLabel(plan.label);
  if (plan.strategy === 'text' && typeof page.getByText === 'function') return page.getByText(plan.text || plan.name);
  if (plan.strategy === 'href' && typeof page.locator === 'function') return page.locator(cssAttributeSelector('href', plan.href, 'a'));
  if (plan.strategy === 'css' && typeof page.locator === 'function') return page.locator(plan.selector);
  throw new Error(`Unsupported locator strategy: ${plan.strategy}`);
}

async function clickLocator(page, plan = {}, options = {}) {
  if (page.clickLocator) return page.clickLocator(plan, options);
  const locator = resolveLocator(page, plan, options);
  const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
  if (!target || typeof target.click !== 'function') throw new Error('resolved locator cannot click');
  return target.click({ timeout: options.timeout });
}

async function fillLocator(page, plan = {}, value, options = {}) {
  if (page.fillLocator) return page.fillLocator(plan, value, options);
  const locator = resolveLocator(page, plan, options);
  const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
  if (!target || typeof target.fill !== 'function') throw new Error('resolved locator cannot fill');
  return target.fill(String(value ?? ''), { timeout: options.timeout });
}

async function selectLocator(page, plan = {}, value, options = {}) {
  if (page.selectLocator) return page.selectLocator(plan, value, options);
  const locator = resolveLocator(page, plan, options);
  const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
  if (target && typeof target.selectOption === 'function') return target.selectOption(String(value), { timeout: options.timeout });
  if (target && typeof target.fill === 'function') return target.fill(String(value), { timeout: options.timeout });
  throw new Error('resolved locator cannot select or fill');
}

module.exports = {
  assertLocatorPlanSafe,
  clickLocator,
  fillLocator,
  isGenericSelector,
  locatorPlanFromControl,
  locatorPlanFromField,
  resolveLocator,
  selectLocator
};
