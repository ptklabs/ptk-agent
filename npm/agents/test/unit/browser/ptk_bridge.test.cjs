'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const {
  detectPtkBridge,
  exportPtkEvidence,
  getPtkFindings,
  invokeBridgeMethod,
  readPtkStatus,
  startPtkScan,
  stopPtkScan
} = require('../../../src/browser/ptkBridge.cjs');

function createMockPage(windowState) {
  return {
    evaluate: async (fn, arg) => {
      const previous = global.window;
      global.window = windowState;
      try {
        return await fn(arg);
      } finally {
        if (previous === undefined) delete global.window;
        else global.window = previous;
      }
    }
  };
}

test('PTK bridge detection discovers PTK_AGENT metadata, capabilities, and method groups', async () => {
  const page = createMockPage({
    PTK_AGENT: {
      capabilities: ['getFindings'],
      describe() {
        return { ok: true, api: 'PTK_AGENT', agentApiVersion: 1 };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      startScan() {},
      scanStatus() {},
      stopScan() {},
      getFindings() {},
      exportFullReport() {}
    }
  });

  const bridge = await detectPtkBridge(page);

  assert.equal(bridge.available, true);
  assert.equal(bridge.source, 'PTK_AGENT');
  assert.equal(bridge.reason, 'detected');
  assert.ok(bridge.methods.includes('startScan'));
  assert.deepEqual(bridge.methodGroups.findings, ['getFindings']);
  assert.deepEqual(bridge.capabilities, ['getFindings']);
  assert.equal(bridge.metadata.value.api, 'PTK_AGENT');
  assert.equal(bridge.preflight.value.ready, true);
});

test('PTK bridge lifecycle uses nested mock APIs when PTK_AGENT is absent', async () => {
  const calls = [];
  const page = createMockPage({
    PTK: {
      agent: {
        start(options) {
          calls.push(['start', options.project]);
          return { ok: true, sessionId: 'session-1', status: 'running' };
        },
        status() {
          calls.push(['status']);
          return { ok: true, status: 'running' };
        },
        stop(options) {
          calls.push(['stop', options.wait]);
          return { ok: true, status: 'completed' };
        },
        findings(options) {
          calls.push(['findings', options.limit]);
          return {
            ok: true,
            findings: [{ engine: 'DAST', title: 'SQL Injection', severity: 'high' }]
          };
        },
        exportEvidence(options) {
          calls.push(['exportEvidence', options.engine]);
          return {
            ok: true,
            findings: [{ engine: 'DAST', title: 'SQL Injection', severity: 'high' }]
          };
        }
      }
    }
  });

  const start = await startPtkScan(page, { scanOptions: { project: 'demo' } });
  const status = await readPtkStatus(page);
  const findings = await getPtkFindings(page, { limit: 25 });
  const exported = await exportPtkEvidence(page, { exportOptions: { engine: 'ALL' } });
  const stop = await stopPtkScan(page, { stopOptions: { wait: false } });

  assert.equal(start.started, true);
  assert.equal(start.invocation.method, 'start');
  assert.equal(status.status.status, 'running');
  assert.equal(findings.findings.length, 1);
  assert.equal(exported.exported, true);
  assert.equal(exported.evidence.findings.length, 1);
  assert.equal(stop.stopped, true);
  assert.deepEqual(calls.map(call => call[0]), ['start', 'status', 'findings', 'status', 'exportEvidence', 'findings', 'stop']);
});

test('PTK bridge forwards immediate analysis stop option', async () => {
  const calls = [];
  const page = createMockPage({
    PTK: {
      agent: {
        stop(options) {
          calls.push(options);
          return { ok: true, status: 'completed' };
        }
      }
    }
  });

  const stop = await stopPtkScan(page, {
    wait: false,
    immediateAnalysis: false
  });

  assert.equal(stop.stopped, true);
  assert.equal(calls[0].wait, false);
  assert.equal(calls[0].immediateAnalysis, false);
});

test('PTK bridge supports low-level PTK_AUTOMATION method names', async () => {
  const page = createMockPage({
    PTK_AUTOMATION: {
      startSession() {
        return { ok: true, sessionId: 'low-1' };
      },
      getSessionProgress() {
        return { ok: true, status: 'completed' };
      },
      endSession() {
        return { ok: true, status: 'completed' };
      },
      getFindings() {
        return { ok: true, findings: [{ engine: 'IAST', title: 'innerHTML sink', risk: 'medium' }] };
      }
    }
  });

  const bridge = await detectPtkBridge(page);
  const start = await startPtkScan(page);
  const findings = await getPtkFindings(page);

  assert.equal(bridge.source, 'PTK_AUTOMATION');
  assert.deepEqual(bridge.methodGroups.start, ['startSession']);
  assert.equal(start.started, true);
  assert.equal(start.invocation.method, 'startSession');
  assert.equal(findings.findings[0].engine, 'IAST');
});

test('PTK scan start requests activation and retries the owned tab when automation bridge is disabled', async () => {
  const calls = [];
  const automation = {
    _automationEnabled: false,
    ping() {
      calls.push(['ping', this._automationEnabled]);
      return {
        ok: this._automationEnabled,
        automationEnabled: this._automationEnabled
      };
    },
    requestActivation(options = {}) {
      calls.push(['requestActivation', options.reason]);
      this._automationEnabled = true;
      return { ok: true, allowed: true, reason: 'manual_activation_granted' };
    },
    startSession(options = {}) {
      calls.push(['startSession', this._automationEnabled, options.project]);
      if (!this._automationEnabled) throw new Error('automation_disabled');
      return { ok: true, sessionId: 'activated-session', status: 'running' };
    }
  };
  const page = createMockPage({ PTK_AUTOMATION: automation });

  const start = await startPtkScan(page, {
    scanOptions: { project: 'demo' },
    timeoutMs: 1000
  });

  assert.equal(start.started, true);
  assert.equal(start.reason, 'started');
  assert.equal(start.activation.allowed, true);
  assert.equal(start.invocation.retryAfterActivation, true);
  assert.deepEqual(calls.map(call => call[0]), ['startSession', 'requestActivation', 'ping', 'startSession']);
});

test('PTK scan start leaves automation_disabled visible when activation is denied', async () => {
  const calls = [];
  const automation = {
    _automationEnabled: false,
    requestActivation() {
      calls.push('requestActivation');
      return { ok: false, allowed: false, reason: 'other_scan_active' };
    },
    startSession() {
      calls.push('startSession');
      throw new Error('automation_disabled');
    }
  };
  const page = createMockPage({ PTK_AUTOMATION: automation });

  const start = await startPtkScan(page, { timeoutMs: 1000 });

  assert.equal(start.started, false);
  assert.equal(start.reason, 'automation_disabled');
  assert.equal(start.activation.allowed, false);
  assert.deepEqual(calls, ['startSession', 'requestActivation']);
});

test('PTK bridge invocation fails closed when returned value exceeds clone budget', async () => {
  const page = createMockPage({
    PTK_AGENT: {
      exportFullReport() {
        return {
          ok: true,
          report: Array.from({ length: 200 }, (_, index) => ({
            id: index,
            nested: { value: `finding-${index}` }
          }))
        };
      }
    }
  });

  const invocation = await invokeBridgeMethod(page, 'export', [{ transfer: 'inline' }], {
    maxCloneNodes: 20,
    maxCloneArrayItems: 200,
    maxCloneMs: 1000
  });

  assert.equal(invocation.called, true);
  assert.equal(invocation.ok, true);
  assert.equal(invocation.value.ok, false);
  assert.equal(invocation.value.code, 'bridge_value_truncated');
});

test('PTK stop falls back to low-level automation when Agent API stop fails', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      describe() {
        return { ok: true, api: 'PTK_AGENT' };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      stopScan() {
        calls.push('agent-stop');
        return { ok: false, code: 'session_not_found' };
      }
    },
    PTK_AUTOMATION: {
      endSession() {
        calls.push('automation-stop');
        return { ok: true, status: 'stopping' };
      }
    }
  });

  const stopped = await stopPtkScan(page, { stopOptions: { wait: false } });

  assert.equal(stopped.stopped, true);
  assert.equal(stopped.invocation.source, 'PTK_AUTOMATION');
  assert.equal(stopped.invocation.fallbackFrom, 'PTK_AGENT');
  assert.deepEqual(calls, ['agent-stop', 'automation-stop']);
});

test('PTK export can force low-level automation with chunked retrieval options', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      describe() {
        return { ok: true, api: 'PTK_AGENT' };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        calls.push('agent-export');
        return { ok: false, code: 'session_not_found' };
      },
      getFindings() {
        return { ok: true, findings: [] };
      }
    },
    PTK_AUTOMATION: {
      exportScan(options) {
        calls.push(['automation-export', options.allowChunked, options.maxExportBytes, options.sessionId]);
        return {
          ok: true,
          scans: [
            {
              engine: 'DAST',
              findings: [{ engine: 'DAST', title: 'SQL Injection', severity: 'high' }]
            }
          ],
          sessionLookup: { lookupSource: 'explicit-session' }
        };
      },
      getFindings() {
        return { ok: true, findings: [] };
      }
    }
  });

  const exported = await exportPtkEvidence(page, {
    exportSource: 'PTK_AUTOMATION',
    exportOptions: {
      sessionId: 'session-1',
      engine: 'ALL'
    }
  });

  assert.equal(exported.exported, true);
  assert.equal(exported.invocation.source, 'PTK_AUTOMATION');
  assert.deepEqual(calls, [['automation-export', true, 1, 'session-1']]);
  assert.equal(exported.exportLookupSource, 'explicit-session');
});

test('PTK status polling prefers the Agent API when PTK_AGENT is present', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      describe() {
        return { ok: true, api: 'PTK_AGENT' };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      scanStatus() {
        calls.push('agent-status');
        return {
          ok: true,
          status: 'running',
          engines: {
            DAST: {
              status: 'running',
              progress: { done: 1, total: 2, remaining: 1 }
            }
          }
        };
      }
    },
    PTK_AUTOMATION: {
      getSessionProgress() {
        calls.push('automation-progress');
        throw new Error('low-level status should not be preferred over PTK_AGENT');
      }
    }
  });

  const bridge = await detectPtkBridge(page);
  const status = await readPtkStatus(page, { bridge });

  assert.equal(bridge.source, 'PTK_AGENT');
  assert.equal(status.ok, true);
  assert.equal(status.invocation.source, 'PTK_AGENT');
  assert.equal(status.status.status, 'running');
  assert.deepEqual(calls, ['agent-status']);
});

test('PTK status polling falls back to low-level automation when PTK_AGENT status stalls', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      describe() {
        return { ok: true, api: 'PTK_AGENT' };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      async scanStatus() {
        calls.push('agent-status');
        await new Promise(resolve => setTimeout(resolve, 25));
        return { ok: true, status: 'running' };
      }
    },
    PTK_AUTOMATION: {
      getSessionProgress() {
        calls.push('automation-progress');
        return {
          ok: true,
          status: 'idle',
          engines: {
            DAST: {
              status: 'idle',
              progress: { done: 3, total: 3, remaining: 0 }
            }
          }
        };
      }
    }
  });

  const bridge = await detectPtkBridge(page);
  const status = await readPtkStatus(page, { bridge, timeoutMs: 5, lowLevelTimeoutMs: 5 });

  assert.equal(status.ok, true);
  assert.equal(status.invocation.source, 'PTK_AUTOMATION');
  assert.equal(status.invocation.fallbackFrom, 'PTK_AGENT');
  assert.equal(status.status.status, 'idle');
  assert.deepEqual(calls, ['agent-status', 'automation-progress']);
});

test('PTK status polling passes explicit session id options to the Agent API', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      describe() {
        return { ok: true, api: 'PTK_AGENT' };
      },
      preflight() {
        return { ok: true, ready: true };
      },
      scanStatus(options) {
        calls.push(options);
        return { ok: true, sessionId: options && options.sessionId, status: 'completed' };
      }
    }
  });

  const bridge = await detectPtkBridge(page);
  const status = await readPtkStatus(page, {
    bridge,
    statusOptions: { sessionId: 'scan-session-1' }
  });

  assert.equal(status.ok, true);
  assert.equal(status.status.sessionId, 'scan-session-1');
  assert.deepEqual(calls, [{ sessionId: 'scan-session-1' }]);
});

test('PTK bridge lifecycle does not treat ok:false method results as success', async () => {
  const page = createMockPage({
    PTK_AGENT: {
      startScan() {
        return { ok: false, code: 'automation_disabled' };
      }
    }
  });

  const start = await startPtkScan(page);

  assert.equal(start.available, true);
  assert.equal(start.started, false);
  assert.equal(start.reason, 'automation_disabled');
});

test('PTK findings/export validity distinguishes missing bridge and missing export', async () => {
  const missing = await exportPtkEvidence(createMockPage({}));
  assert.equal(missing.validity.status, 'invalid_no_ptk_bridge');
  assert.equal(missing.validity.hasPtkBridge, false);

  const noExport = await exportPtkEvidence(createMockPage({
    PTK_AGENT: {
      startScan() {}
    }
  }));
  assert.equal(noExport.available, true);
  assert.equal(noExport.validity.status, 'invalid_no_findings_export');
  assert.equal(noExport.validity.hasPtkBridge, true);
  assert.equal(noExport.validity.hasFindingsExport, false);
});

test('PTK findings API fallback does not validate a failed full export invocation', async () => {
  const exported = await exportPtkEvidence(createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        return { ok: false, reason: 'session_not_found' };
      },
      getFindings() {
        return {
          ok: true,
          findings: [{ engine: 'DAST', title: 'Finding from findings API', severity: 'high' }]
        };
      }
    }
  }));

  assert.equal(exported.exported, false);
  assert.equal(exported.findings.length, 1);
  assert.equal(exported.validity.status, 'invalid_no_findings_export');
  assert.equal(exported.validity.hasFindingsExport, false);
});

test('PTK_AGENT retrieval-plan exports are fetched through PTK_AUTOMATION chunks', async () => {
  const calls = [];
  const report = {
    findings: [{ engine: 'DAST', title: 'DOM XSS', severity: 'high' }],
    endpoints: [{ method: 'GET', url: 'http://app.test/api/products' }]
  };
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));
  const page = createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport(options) {
        calls.push(['exportFullReport', options.transfer]);
        return {
          ok: true,
          mode: 'retrieval-plan',
          scans: [{
            engine: 'DAST',
            exportMode: 'chunked',
            exportId: 'exp-1',
            fileName: 'PTK_DAST_scan.json.gz',
            size: payload.byteLength,
            chunkSize: payload.byteLength,
            chunkCount: 1,
            contentType: 'application/gzip',
            compression: 'gzip'
          }],
          truncatedAny: false,
          warnings: []
        };
      },
      getFindings() {
        calls.push(['getFindings']);
        return { ok: true, findings: [] };
      }
    },
    PTK_AUTOMATION: {
      exportScanChunk(options) {
        calls.push(['exportScanChunk', options.engine, options.exportId, options.index]);
        return {
          ok: true,
          exportId: options.exportId,
          index: options.index,
          chunkCount: 1,
          encoding: 'base64',
          byteLength: payload.byteLength,
          chunkBase64: payload.toString('base64')
        };
      },
      releaseExportScan(options) {
        calls.push(['releaseExportScan', options.engine, options.exportId]);
        return { ok: true };
      }
    }
  });

  const exported = await exportPtkEvidence(page);

  assert.equal(exported.exported, true);
  assert.equal(exported.retrieval.ok, true);
  assert.equal(exported.retrieval.resolved, true);
  assert.equal(exported.reason, 'exported_retrieval_plan_resolved');
  assert.equal(exported.validity.status, 'valid');
  assert.equal(exported.findings.length, 1);
  assert.equal(exported.findings[0].title, 'DOM XSS');
  assert.equal(exported.evidence.export.scans[0].retrievalResolved, true);
  assert.equal(exported.evidence.export.scans[0].content.endpoints[0].url, 'http://app.test/api/products');
  assert.deepEqual(calls.map(call => call[0]), ['exportFullReport', 'exportScanChunk', 'releaseExportScan', 'getFindings']);
});

test('PTK retrieval-plan export extracts findings from engine-grouped reports', async () => {
  const report = {
    DAST: {
      findings: [{ engine: 'DAST', title: 'SQL Injection', severity: 'high' }]
    },
    IAST: {
      items: [{ engine: 'IAST', title: 'Runtime sink', severity: 'medium', evidence: { sink: 'innerHTML' } }]
    },
    SAST: {
      vulnerabilities: [{ engine: 'SAST', ruleName: 'DOM sink', risk: 'low', source: 'main.js' }]
    }
  };
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));
  const page = createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        return {
          ok: true,
          mode: 'retrieval-plan',
          scans: [{
            engine: 'ALL',
            exportMode: 'chunked',
            exportId: 'exp-engines',
            fileName: 'PTK_full_report.json.gz',
            size: payload.byteLength,
            chunkSize: payload.byteLength,
            chunkCount: 1,
            contentType: 'application/gzip',
            compression: 'gzip'
          }]
        };
      },
      getFindings() {
        return { ok: true, findings: [] };
      }
    },
    PTK_AUTOMATION: {
      exportScanChunk(options) {
        return {
          ok: true,
          exportId: options.exportId,
          index: options.index,
          chunkCount: 1,
          encoding: 'base64',
          byteLength: payload.byteLength,
          chunkBase64: payload.toString('base64')
        };
      },
      releaseExportScan() {
        return { ok: true };
      }
    }
  });

  const exported = await exportPtkEvidence(page);

  assert.equal(exported.exported, true);
  assert.equal(exported.exportRetrievalResolved, true);
  assert.equal(exported.validity.status, 'valid');
  assert.equal(exported.findings.length, 3);
  assert.deepEqual(exported.findings.map(finding => finding.engine).sort(), ['DAST', 'IAST', 'SAST']);
  assert.equal(exported.findingsExportValiditySource, 'export');
  assert.equal(exported.findingsApiFallbackUsed, false);
});

test('export falls back to PTK_AUTOMATION when PTK_AGENT export is unavailable', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        calls.push(['exportFullReport']);
        return { ok: false, code: 'export_timeout' };
      },
      getFindings() {
        calls.push(['agentGetFindings']);
        return { ok: false, code: 'findings_timeout' };
      }
    },
    PTK_AUTOMATION: {
      exportScan() {
        calls.push(['exportScan']);
        return {
          ok: true,
          findings: [{ engine: 'DAST', title: 'Fallback finding', severity: 'high' }]
        };
      },
      getFindings() {
        calls.push(['automationGetFindings']);
        return {
          ok: true,
          findings: [{ engine: 'DAST', title: 'Fallback finding', severity: 'high' }]
        };
      }
    }
  });

  const exported = await exportPtkEvidence(page);

  assert.equal(exported.exported, true);
  assert.equal(exported.validity.status, 'valid');
  assert.equal(exported.invocation.source, 'PTK_AUTOMATION');
  assert.equal(exported.invocation.fallbackFrom, 'PTK_AGENT');
  assert.equal(exported.findings.length, 1);
  assert.deepEqual(calls.map(call => call[0]), ['exportFullReport', 'exportScan', 'agentGetFindings', 'automationGetFindings']);
});

test('PTK_AGENT retrieval-plan failure does not claim export evidence success', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        calls.push(['exportFullReport']);
        return {
          ok: true,
          mode: 'retrieval-plan',
          scans: [{
            engine: 'DAST',
            exportMode: 'chunked',
            exportId: 'exp-2',
            size: 10,
            chunkCount: 1,
            contentType: 'application/gzip',
            compression: 'gzip'
          }]
        };
      },
      getFindings() {
        calls.push(['getFindings']);
        return { ok: false, code: 'get_findings_failed' };
      }
    },
    PTK_AUTOMATION: {
      exportScanChunk(options) {
        calls.push(['exportScanChunk', options.index]);
        return { ok: false, error: 'export_not_found_or_expired' };
      },
      releaseExportScan(options) {
        calls.push(['releaseExportScan', options.exportId]);
        return { ok: true };
      }
    }
  });

  const exported = await exportPtkEvidence(page);

  assert.equal(exported.exported, true);
  assert.equal(exported.retrieval.ok, false);
  assert.equal(exported.validity.status, 'invalid_no_findings_export');
  assert.equal(exported.evidence.retrieval.reason, 'retrieval_plan_failed');
  assert.deepEqual(calls.map(call => call[0]), ['exportFullReport', 'exportScanChunk', 'releaseExportScan', 'getFindings']);
});

test('PTK retrieval-plan timeout may collect findings API fallback without validating export', async () => {
  const calls = [];
  const page = createMockPage({
    PTK_AGENT: {
      scanStatus() {
        return { ok: true, status: 'completed' };
      },
      exportFullReport() {
        calls.push(['exportFullReport']);
        return {
          ok: true,
          mode: 'retrieval-plan',
          scans: [{
            engine: 'DAST',
            exportMode: 'chunked',
            exportId: 'exp-slow',
            size: 100,
            chunkCount: 4,
            contentType: 'application/gzip',
            compression: 'gzip'
          }]
        };
      },
      getFindings() {
        calls.push(['getFindings']);
        return {
          ok: true,
          findings: [{ engine: 'DAST', title: 'Finding from findings API', severity: 'high' }]
        };
      }
    },
    PTK_AUTOMATION: {
      async exportScanChunk(options) {
        calls.push(['exportScanChunk', options.index]);
        await new Promise(resolve => setTimeout(resolve, 25));
        return { ok: false, error: 'slow_chunk' };
      },
      releaseExportScan(options) {
        calls.push(['releaseExportScan', options.exportId]);
        return { ok: true };
      }
    }
  });

  const exported = await exportPtkEvidence(page, { timeoutMs: 50, retrievalTimeoutMs: 10 });

  assert.equal(exported.exported, true);
  assert.equal(exported.retrieval.ok, false);
  assert.equal(exported.validity.status, 'invalid_no_findings_export');
  assert.equal(exported.findingsApiFallbackUsed, true);
  assert.equal(exported.findingsExportValiditySource, 'findings-api');
  assert.equal(exported.findings.length, 1);
  assert.equal(exported.findings[0].title, 'Finding from findings API');
  assert.deepEqual(calls.map(call => call[0]), ['exportFullReport', 'exportScanChunk', 'releaseExportScan', 'getFindings']);
});
