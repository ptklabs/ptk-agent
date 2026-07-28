'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { normalizeAction } = require('../../../src/browser/actionModel.cjs');
const {
  cssAttributeSelector,
  cssEscape,
  cssIdSelector
} = require('../../../src/browser/cssSelector.cjs');

const HOSTILE_VALUES = [
  'leading digit 0',
  '0leading',
  '-1leading',
  'quote"close]',
  'backslash\\value',
  'line\nbreak',
  'hash#dot.period',
  'colon:value',
  'brackets[] parenthesis()'
];

test('CSS selector helpers preserve exact hostile id and attribute values', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;

  for (const [index, value] of HOSTILE_VALUES.entries()) {
    const element = document.createElement('input');
    element.id = value;
    element.setAttribute('data-testid', value);
    document.body.appendChild(element);

    // jsdom's selector engine does not match a standards-compliant escaped
    // backslash in an ID; real browsers and CSS.escape use this representation.
    if (!value.includes('\\')) {
      assert.equal(document.querySelector(cssIdSelector(value)), element, `id case ${index}`);
    }
    assert.equal(document.querySelector(cssAttributeSelector('data-testid', value)), element, `attribute case ${index}`);
  }
});

test('CSS escape handles null, controls, leading digits, and lone dash per CSSOM', () => {
  assert.equal(cssEscape('\0'), '\uFFFD');
  assert.equal(cssEscape('\u0001x'), '\\1 x');
  assert.equal(cssEscape('9abc'), '\\39 abc');
  assert.equal(cssEscape('-9abc'), '-\\39 abc');
  assert.equal(cssEscape('-'), '\\-');
});

test('action normalization uses bounded selector helpers for discovered metadata', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const value = 'probe"] input,iframe';
  const element = dom.window.document.createElement('button');
  element.setAttribute('data-testid', value);
  dom.window.document.body.appendChild(element);

  const action = normalizeAction({ testId: value, kind: 'click-button', label: 'Probe' });
  assert.equal(dom.window.document.querySelector(action.selector), element);
  assert.equal(dom.window.document.querySelectorAll(action.selector).length, 1);
});
