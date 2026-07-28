'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFindingFingerprintDiff,
  findingSourceSummary
} = require('../../../src/core/findingDiff.cjs');

function finding(overrides = {}) {
  return {
    engine: 'DAST',
    ruleId: overrides.ruleId || 'xss_1',
    title: overrides.title || 'XSS',
    severity: overrides.severity || 'high',
    confidence: overrides.confidence || 'confirmed',
    url: overrides.url || 'http://app.test/search',
    method: overrides.method || 'GET',
    parameter: overrides.parameter || 'q',
    evidence: { proof: 'redacted' },
    ...overrides
  };
}

test('pre-agent findings API snapshot is treated as diagnostic, not reliable export baseline', () => {
  const before = finding({ ruleId: 'jwt_1', title: 'JWT None', url: 'http://app.test/rest/user/whoami', parameter: 'token' });
  const after = finding({ ruleId: 'xss_1', title: 'XSS', url: 'http://app.test/api/Feedbacks/', parameter: 'rating' });

  const diff = createFindingFingerprintDiff({
    baseline: {
      agentPtkSignals: {
        diagnosticOnly: true,
        findingsCount: 1,
        findings: [before]
      }
    },
    final: {
      ptk: {
        exported: true,
        evidence: {
          export: {
            findings: [before, after]
          }
        }
      }
    },
    agent: {
      coverageDelta: {
        total: { findings: 1 }
      }
    }
  });

  assert.equal(diff.baselineUniqueFindings, 1);
  assert.equal(diff.finalUniqueFindings, 2);
  assert.equal(diff.baselineSource.source, 'pre-agent-findings-api');
  assert.equal(diff.finalSource.source, 'export');
  assert.equal(diff.comparisonReliable, false);
  assert.equal(diff.agentAddedUniqueFindings, 0);
  assert.equal(diff.agentRegression, false);
});

test('complete export baseline can produce reliable unique finding delta', () => {
  const before = finding({ ruleId: 'jwt_1', title: 'JWT None', url: 'http://app.test/rest/user/whoami', parameter: 'token' });
  const after = finding({ ruleId: 'xss_1', title: 'XSS', url: 'http://app.test/api/Feedbacks/', parameter: 'rating' });

  const diff = createFindingFingerprintDiff({
    baseline: {
      ptk: {
        exported: true,
        evidence: {
          export: {
            findings: [before]
          }
        }
      }
    },
    final: {
      ptk: {
        exported: true,
        evidence: {
          export: {
            findings: [before, after]
          }
        }
      }
    }
  });

  assert.equal(diff.comparisonReliable, true);
  assert.equal(diff.agentAddedUniqueFindings, 1);
  assert.equal(diff.agentLostUniqueFindings, 0);
  assert.equal(diff.newUniqueFindings.length, 1);
});

test('unique finding delta is computed from final coverage, not agent reported finding count', () => {
  const before = finding({ ruleId: 'jwt_1', title: 'JWT None', url: 'http://app.test/rest/user/whoami', parameter: 'token' });
  const after = finding({ ruleId: 'sql_1', title: 'SQL Injection', url: 'http://app.test/rest/user/login', parameter: 'email' });

  const diff = createFindingFingerprintDiff({
    baseline: {
      ptk: {
        exported: true,
        evidence: { export: { findings: [before] } }
      }
    },
    final: {
      ptk: {
        exported: true,
        evidence: { export: { findings: [before, after] } }
      }
    },
    agent: {
      coverageDelta: {
        total: { findings: 0 }
      }
    }
  });

  assert.equal(diff.comparisonReliable, true);
  assert.equal(diff.agentAddedUniqueFindings, 1);
  assert.equal(diff.newUniqueFindings.length, 1);
});

test('finding source summary reports final export source', () => {
  const summary = findingSourceSummary({
    ptk: {
      exported: true,
      evidence: {
        export: {
          findings: [finding()]
        }
      }
    }
  });

  assert.equal(summary.source, 'export');
  assert.equal(summary.complete, true);
  assert.equal(summary.count, 1);
});
