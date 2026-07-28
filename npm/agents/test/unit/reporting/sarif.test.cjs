'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSarif,
  evaluateSeverityThreshold,
  normalizedFindingsFromResult,
  normalizeThreshold
} = require('../../../src/reporting/sarif.cjs');

function sampleResult() {
  return {
    ok: true,
    config: {
      target: {
        baseUrl: 'https://app.test'
      }
    },
    coverage: {
      ptk: {
        findings: [
          {
            engine: 'DAST',
            ruleId: 'xss-reflected',
            title: 'Reflected XSS',
            severity: 'High',
            confidence: 'high',
            url: 'https://app.test/search?q=test',
            method: 'GET',
            parameter: 'q',
            cwe: '79'
          },
          {
            engine: 'SCA',
            ruleId: 'legacy-lib',
            title: 'Legacy dependency',
            severity: 'medium',
            confidence: 'medium'
          },
          {
            engine: 'SAST',
            ruleId: 'dom-xss',
            title: 'DOM XSS sink',
            severity: 'low',
            source: {
              file: 'src/app.js',
              line: 42,
              column: 7
            }
          },
          {
            engine: 'IAST',
            ruleId: 'dom-reachability',
            title: 'Runtime reachability',
            severity: 'info',
            location: {
              runtimeUrl: 'https://app.test/#/search'
            }
          },
          {
            ruleId: 'unknown-shape',
            title: 'Unknown shaped issue',
            evidence: {
              finding: true
            }
          }
        ]
      }
    },
    telemetry: {
      endTime: '2026-06-18T12:00:00.000Z'
    }
  };
}

test('buildSarif converts PTK findings to SARIF 2.1.0 results', () => {
  const sarif = buildSarif(sampleResult());

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].tool.driver.name, 'OWASP PTK');
  assert.equal(sarif.runs[0].tool.driver.informationUri, 'https://github.com/ptklabs/ptk-agent');
  assert.equal(sarif.runs[0].results.length, 5);
  assert.equal(sarif.runs[0].results[0].ruleId, 'DAST/xss-reflected');
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.equal(sarif.runs[0].results[0].properties.url, 'https://app.test/search?q=test');
  const sourceResult = sarif.runs[0].results.find(result => result.ruleId === 'SAST/dom-xss');
  assert.equal(sourceResult.locations[0].physicalLocation.artifactLocation.uri, 'src/app.js');
  assert.equal(sourceResult.locations[0].physicalLocation.region.startLine, 42);
  assert.equal(sarif.runs[0].properties.target, 'https://app.test');
});

test('normalizedFindingsFromResult deduplicates findings by fingerprint', () => {
  const result = sampleResult();
  result.coverage.ptk.evidence = {
    findings: [
      result.coverage.ptk.findings[0]
    ]
  };

  const findings = normalizedFindingsFromResult(result);
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.map(finding => finding.severity).sort(), ['high', 'info', 'low', 'medium', 'unknown']);
});

test('evaluateSeverityThreshold fails when findings meet threshold', () => {
  const findings = normalizedFindingsFromResult(sampleResult());
  const high = evaluateSeverityThreshold(findings, 'high');
  const critical = evaluateSeverityThreshold(findings, 'critical');

  assert.equal(high.ok, false);
  assert.equal(high.failingCount, 1);
  assert.equal(high.failingFindings[0].severity, 'high');
  assert.equal(critical.ok, true);
  assert.equal(critical.failingCount, 0);
});

test('normalizeThreshold rejects unsupported values', () => {
  assert.equal(normalizeThreshold('LOW'), 'low');
  assert.equal(normalizeThreshold('none'), 'none');
  assert.throws(() => normalizeThreshold('warning'), /--fail-on must be one of/);
});
