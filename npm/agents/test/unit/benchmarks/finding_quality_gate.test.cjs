'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateFindingQualityGate,
  requirementsForTarget
} = require('../../../src/benchmarks/findingQualityGate.cjs');

function finding(overrides = {}) {
  return {
    engine: 'DAST',
    severity: 'high',
    confidence: 'confirmed',
    ...overrides
  };
}

test('Juice Shop required finding gate passes when all threshold findings are present', () => {
  const gate = evaluateFindingQualityGate({
    targetId: 'juice-shop',
    coverage: {
      ptk: {
        evidence: {
          findings: [
            finding({
              title: 'JWT None Algorithm (Cookie)',
              location: { url: 'http://localhost:3001/profile' }
            }),
            finding({
              title: 'JWT None Algorithm (Authorization header)',
              location: { url: 'http://localhost:3001/rest/basket/6' }
            }),
            finding({
              title: 'SQL Injection - Single Quote',
              location: { url: 'http://localhost:3001/rest/user/login' },
              parameter: 'email'
            }),
            finding({
              title: 'XSS - Unfiltered script tag',
              location: { url: 'http://localhost:3001/api/Challenges/?sort=name' }
            }),
            finding({
              title: 'DOM XSS via innerHTML',
              location: {
                runtimeUrl: 'http://localhost:3001/#/search?q=<img>',
                param: 'snapshot.queryParams.q'
              }
            })
          ]
        }
      }
    }
  });

  assert.equal(gate.applicable, true);
  assert.equal(gate.status, 'passed');
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.missing, []);
  assert.deepEqual(gate.required.map(item => item.id), [
    'jwt-none-cookie',
    'jwt-none-header',
    'sql-injection-login',
    'xss-feedback-or-challenges',
    'spa-dom-xss-search'
  ]);
  assert.equal(gate.required.every(item => item.satisfied), true);
});

test('Juice Shop required finding gate lists missing threshold findings', () => {
  const gate = evaluateFindingQualityGate({
    targetId: 'juice-shop',
    coverage: {
      ptk: {
        evidence: {
          findings: [
            finding({
              title: 'JWT None Algorithm (Cookie)',
              location: { url: 'http://localhost:3001/profile' }
            })
          ]
        }
      }
    }
  });

  assert.equal(gate.status, 'failed');
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.missing, [
    'jwt-none-header',
    'sql-injection-login',
    'xss-feedback-or-challenges',
    'spa-dom-xss-search'
  ]);
});

test('required finding gate is not applicable for non-threshold targets', () => {
  const gate = evaluateFindingQualityGate({
    targetId: 'testfire',
    coverage: {
      ptk: {
        evidence: {
          findings: [finding({ title: 'SQL Injection', location: { url: 'https://demo.testfire.net/login.jsp' } })]
        }
      }
    }
  });

  assert.equal(gate.applicable, false);
  assert.equal(gate.status, 'not_applicable');
  assert.equal(gate.passed, null);
  assert.deepEqual(gate.missing, []);
  assert.deepEqual(requirementsForTarget('testfire'), []);
});
