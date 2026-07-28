'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEvidenceRecord, redactSensitiveValue } = require('../../../src/evidence/evidenceModel.cjs');
const { createEndpointGraph } = require('../../../src/evidence/endpointGraph.cjs');
const { createRouteGraph } = require('../../../src/evidence/routeGraph.cjs');
const { createEntityGraph } = require('../../../src/evidence/entityGraph.cjs');
const { createTelemetryRun } = require('../../../src/core/telemetry.cjs');
const {
  PTK_FINDINGS_COUNT_ARTIFACT,
  adaptPtkEvidence,
  applyFindingsCountToTelemetry,
  buildEvidenceGraphs,
  createFindingsCountArtifact,
  extractPtkFindings,
  normalizeFinding,
  redactPtkSecrets,
  summarizeFindings,
  writeFindingsCountArtifact
} = require('../../../src/evidence/ptkEvidenceAdapter.cjs');

test('evidence records redact sensitive values', () => {
  const record = createEvidenceRecord({
    kind: 'finding',
    subject: { type: 'endpoint', id: 'GET /api' },
    data: { token: 'secret', nested: { password: 'hidden', value: 'visible' } }
  });
  assert.equal(record.data.token, '[redacted]');
  assert.equal(record.data.nested.password, '[redacted]');
  assert.equal(redactSensitiveValue({ cookie: 'abc' }).cookie, '[redacted]');
});

test('endpoint, route, and entity graphs produce nodes and edges', () => {
  const endpointGraph = createEndpointGraph();
  endpointGraph.linkRouteToEndpoint('http://app.test/catalog', { method: 'GET', url: 'http://app.test/api/catalog', resourceType: 'fetch' });
  assert.equal(endpointGraph.toJSON().edges.length, 1);

  const routeGraph = createRouteGraph();
  routeGraph.recordTransition('http://app.test/a', 'http://app.test/b', { actionId: 'next' });
  assert.equal(routeGraph.toJSON().edges.length, 1);

  const entityGraph = createEntityGraph();
  entityGraph.ingestPageModel({ url: 'http://app.test/form', routeShape: '/form', surfaceType: 'form', forms: [{ id: 'f', fields: [{ name: 'email' }] }], actions: [{ id: 'a' }] });
  assert.equal(entityGraph.toJSON().nodes.length >= 4, true);
});

test('PTK evidence adapter converts findings and builds coverage graphs', () => {
  const adapted = adaptPtkEvidence({
    findings: [{ name: 'XSS', url: 'http://app.test/x', severity: 'high', token: 'secret' }],
    requests: [{ method: 'POST', url: 'http://app.test/api' }]
  });
  assert.equal(adapted.counts.findings, 1);
  assert.equal(adapted.counts.endpoints, 1);
  assert.equal(adapted.records[0].data.raw.token, '[redacted]');

  const graphs = buildEvidenceGraphs({
    coverage: {
      routes: [{ url: 'http://app.test/x', routeShape: '/x', surfaceType: 'content' }],
      endpoints: [{ routeUrl: 'http://app.test/x', method: 'GET', url: 'http://app.test/api' }]
    }
  });
  assert.equal(graphs.endpointGraph.edges.length, 1);
  assert.equal(graphs.routeGraph.nodes.length, 1);
});

test('PTK evidence adapter normalizes nested findings and redacts secrets', () => {
  const payload = {
    findings: [{
      engine: 'DAST',
      title: 'SQL Injection',
      risk: 'High',
      url: 'https://app.test/login?token=abc123',
      request: {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token-value'
        }
      }
    }],
    SAST: {
      results: [{
        engine: 'SAST',
        title: 'DOM XSS innerHTML',
        severity: 'medium',
        sink: 'innerHTML',
        cookie: 'session=secret'
      }]
    }
  };

  const findings = extractPtkFindings(payload);
  const normalized = findings.map(normalizeFinding);
  const summary = summarizeFindings(payload);

  assert.equal(findings.length, 2);
  assert.equal(normalized[0].severity, 'high');
  assert.equal(normalized[0].method, 'POST');
  assert.match(normalized[0].url, /token=\[redacted\]/);
  assert.equal(normalized[0].raw.request.headers.Authorization, '[redacted]');
  assert.equal(normalized[1].raw.cookie, '[redacted]');
  assert.equal(summary.count, 2);
  assert.equal(summary.bySeverity.high, 1);
  assert.equal(summary.byEngine.SAST, 1);
  assert.equal(redactPtkSecrets({ evidence: 'Authorization=Bearer abcdefghijk' }).evidence, 'Authorization=[redacted]');
});

test('PTK evidence adapter recurses into scan result containers without counting containers as findings', () => {
  const payload = {
    DAST: {
      version: '1.0',
      type: 'scan_result',
      engine: 'DAST',
      scanId: 'scan-dast',
      startedAt: '2026-05-19T00:00:00.000Z',
      finishedAt: '2026-05-19T00:01:00.000Z',
      stats: { findingsCount: 1 },
      settings: { scanStrategy: 'SMART' },
      findings: [{
        engine: 'DAST',
        ruleName: 'SPA hash DOM XSS',
        severity: 'high',
        url: 'https://app.test/#/search?q=apple',
        parameter: 'q'
      }]
    },
    SAST: {
      version: '1.0',
      engine: 'SAST',
      scanId: 'scan-sast',
      startedAt: '2026-05-19T00:00:00.000Z',
      finishedAt: '2026-05-19T00:01:00.000Z',
      stats: { findingsCount: 1 },
      settings: { policyCode: 'SMART' },
      findings: [{
        engine: 'SAST',
        ruleName: 'Review uses of innerHTML',
        severity: 'low',
        location: { file: 'https://app.test/main.js' }
      }]
    }
  };

  const findings = extractPtkFindings(payload);
  const normalized = findings.map(normalizeFinding);
  const summary = summarizeFindings(payload);

  assert.equal(findings.length, 2);
  assert.deepEqual(normalized.map(finding => finding.title), [
    'SPA hash DOM XSS',
    'Review uses of innerHTML'
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.byEngine.DAST, 1);
  assert.equal(summary.byEngine.SAST, 1);
});

test('PTK findings count artifact helper writes comparable redacted count artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-findings-count-'));
  const ptkExport = {
    findings: [
      { engine: 'DAST', name: 'JWT none accepted', severity: 'high', url: 'https://app.test/api?api_key=secret' },
      { engine: 'IAST', title: 'innerHTML sink', risk: 'medium', evidence: { token: 'hidden' } }
    ],
    truncated: true
  };
  const telemetry = createTelemetryRun({ runId: 'findings-run', now: () => 1000 });
  const count = applyFindingsCountToTelemetry(telemetry, ptkExport);
  const artifact = createFindingsCountArtifact({
    evidence: ptkExport,
    bridge: { source: 'PTK_AGENT', sessionId: 'secret-session' },
    exported: true,
    export: { mode: 'retrieval-plan', scans: [{ engine: 'DAST' }], warnings: [] }
  }, { generatedAt: '2026-05-04T00:00:00.000Z' });
  const written = writeFindingsCountArtifact(dir, {
    evidence: ptkExport,
    bridge: { source: 'PTK_AGENT', sessionId: 'secret-session' }
  }, { generatedAt: '2026-05-04T00:00:00.000Z' });
  const saved = JSON.parse(fs.readFileSync(written.filePath, 'utf8'));

  assert.equal(count, 2);
  assert.equal(telemetry.toSummary().findingsCount, 2);
  assert.equal(artifact.findingsCount, 2);
  assert.equal(artifact.bridge.sessionId, '[redacted]');
  assert.match(artifact.samples[0].url, /api_key=\[redacted\]/);
  assert.equal(path.basename(written.filePath), PTK_FINDINGS_COUNT_ARTIFACT);
  assert.equal(saved.findingsCount, 2);
});
