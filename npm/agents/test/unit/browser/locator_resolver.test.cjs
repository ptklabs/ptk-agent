'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertLocatorPlanSafe,
  clickLocator,
  fillLocator,
  locatorPlanFromControl,
  locatorPlanFromField
} = require('../../../src/browser/locatorResolver.cjs');

test('locator resolver rejects unsafe generic button for critical actions', () => {
  assert.throws(
    () => assertLocatorPlanSafe({ strategy: 'css', selector: 'button', critical: true }),
    /Unsafe generic selector/
  );
});

test('locator resolver prefers field labels and control roles over generic css', async () => {
  const calls = [];
  const page = {
    getByLabel(label) {
      calls.push(['label', label]);
      return { first: () => ({ fill: async value => calls.push(['fill', value]) }) };
    },
    getByRole(role, options) {
      calls.push(['role', role, options.name]);
      return { first: () => ({ click: async () => calls.push(['click']) }) };
    }
  };

  const fieldPlan = locatorPlanFromField({ label: 'Email', selector: 'input' }, { critical: true });
  const buttonPlan = locatorPlanFromControl({ role: 'button', label: 'Add to Basket', selector: 'button' }, { critical: true });

  await fillLocator(page, fieldPlan, 'ptk@example.test');
  await clickLocator(page, buttonPlan);

  assert.deepEqual(calls, [
    ['label', 'Email'],
    ['fill', 'ptk@example.test'],
    ['role', 'button', 'Add to Basket'],
    ['click']
  ]);
});
