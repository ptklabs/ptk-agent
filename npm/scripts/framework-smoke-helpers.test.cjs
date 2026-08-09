'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateRequiredFindings } = require('./framework-smoke-helpers.cjs');

test('required finding gate enforces engine ownership', () => {
  const falsePositive = {
    engine: 'SAST',
    ruleId: 'no-appendchild',
    ruleName: 'Review uses of appendChild',
    source: 'SPA DOM XSS fixture text that must not satisfy DAST'
  };
  const gate = evaluateRequiredFindings([falsePositive], ['DAST']);

  assert.equal(gate.ok, false);
  assert.equal(
    gate.requirements.find((item) => item.key === 'dast_spa_dom_xss').count,
    0
  );
});

test('required finding gate accepts the same evidence from its owning engine', () => {
  const finding = {
    engine: 'PTK_DAST',
    ruleId: 'spa_dom_xss_default',
    ruleName: 'SPA hash DOM XSS'
  };
  const gate = evaluateRequiredFindings([finding], ['DAST']);

  assert.equal(
    gate.requirements.find((item) => item.key === 'dast_spa_dom_xss').count,
    1
  );
});

test('required finding gate rejects evidence without authoritative engine identity', () => {
  const gate = evaluateRequiredFindings([{
    ruleId: 'dom_innerhtml_xss',
    ruleName: 'DOM XSS via Element.innerHTML'
  }], ['IAST']);

  assert.equal(gate.ok, false);
  assert.equal(gate.requirements[0].count, 0);
});
