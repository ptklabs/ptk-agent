'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectAgentPlanningPtkSignals,
  collectPtkEvidence,
  classifyPtkDrainStatus,
  createPtkDrainStatusReader,
  pollPtkDrainStatus,
  ptkDrainBridgeMethodTimeoutMs,
  ptkDrainLowLevelStatusTimeoutMs,
  ptkDrainStatusReadTimeoutMs,
  ptkDrainUsedStatusPage,
  ptkOperationShouldRetryOnPrimaryPage,
  ptkExportOperationTimeoutMs,
  ptkOperationShouldRetryOnStatusPage,
  ptkSessionIdFromLifecycleStart,
  summarizePtkAttackCompletion
} = require('../../../src/core/orchestrator.cjs');
const ptkBridge = require('../../../src/browser/ptkBridge.cjs');

test('PTK export timeout uses PTK export budget, not crawler route budget', () => {
  const timeoutMs = ptkExportOperationTimeoutMs({
    crawler: { maxRouteMs: 2500 },
    ptk: { exportDrainMs: 10000 }
  });

  assert.equal(timeoutMs, 10000);
});

test('PTK export timeout defaults to a full evidence export budget', () => {
  const timeoutMs = ptkExportOperationTimeoutMs({
    crawler: { maxRouteMs: 2500 },
    ptk: {}
  });

  assert.equal(timeoutMs, 30000);
});

test('PTK export timeout caps unusually large export budgets', () => {
  const timeoutMs = ptkExportOperationTimeoutMs({
    crawler: { maxRouteMs: 2500 },
    ptk: { exportDrainMs: 120000 }
  });

  assert.equal(timeoutMs, 60000);
});

test('PTK explicit drain uses a bounded status-read budget separate from total drain time', () => {
  const timeoutMs = ptkDrainStatusReadTimeoutMs({
    crawler: { maxRouteMs: 30000 },
    ptk: { drainMode: 'until-complete' }
  });

  assert.equal(timeoutMs, 10000);
});

test('PTK drain caps per-status bridge calls and keeps low-level fallback bounded', () => {
  const config = {
    crawler: { maxRouteMs: 30000 },
    ptk: { drainMode: 'until-complete' }
  };

  assert.equal(ptkDrainStatusReadTimeoutMs(config), 10000);
  assert.equal(ptkDrainBridgeMethodTimeoutMs(config), 5000);
  assert.equal(ptkDrainLowLevelStatusTimeoutMs(config), 4000);
});

test('agent planning PTK signals reuse lifecycle bridge instead of redetecting', async () => {
  const previous = globalThis.PTK_AGENT;
  let describeCalls = 0;
  try {
    globalThis.PTK_AGENT = {
      describe() {
        describeCalls += 1;
        throw new Error('detect should not run for planning snapshot');
      },
      scanStatus(options = {}) {
        assert.equal(options.sessionId, 'session-123');
        return { ok: true, status: 'running' };
      },
      getFindings(options = {}) {
        assert.equal(options.sessionId, 'session-123');
        return {
          ok: true,
          findings: [
            {
              engine: 'DAST',
              title: 'SPA hash DOM XSS',
              severity: 'high',
              location: { pageUrl: 'http://app.test/#/search?q=apple' }
            }
          ]
        };
      }
    };
    const page = {
      async evaluate(fn, args) {
        return fn(args);
      }
    };
    const artifact = await collectAgentPlanningPtkSignals(page, {
      config: { ptk: { enabled: true } },
      lifecycleStart: {
        sessionId: 'session-123',
        start: {
          bridge: {
            available: true,
            source: 'PTK_AGENT',
            methods: ['scanStatus', 'getFindings'],
            methodGroups: {
              status: ['scanStatus'],
              findings: ['getFindings']
            },
            candidates: []
          }
        }
      }
    });

    assert.equal(describeCalls, 0);
    assert.equal(artifact.bridgeReusedFromLifecycleStart, true);
    assert.equal(artifact.bridgeSource, 'PTK_AGENT');
    assert.equal(artifact.statusOk, true);
    assert.equal(artifact.findingsOk, true);
    assert.equal(artifact.findingsCount, 1);
  } finally {
    if (previous === undefined) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = previous;
    }
  }
});

test('agent planning PTK signals retry from status page when current page bridge is hot', async () => {
  const previous = globalThis.PTK_AGENT;
  const hotAgent = {
    scanStatus() {
      throw new Error('PTK bridge method scanStatus/getStatus/status/getSessionProgress exceeded 4000ms budget');
    },
    getFindings() {
      throw new Error('PTK bridge method getFindings/findings/getAlerts/getIssues exceeded 5000ms budget');
    }
  };
  const statusPageAgent = {
    describe() {
      return {
        ok: true,
        source: 'PTK_AGENT',
        methods: ['scanStatus', 'getFindings'],
        methodGroups: {
          status: ['scanStatus'],
          findings: ['getFindings']
        }
      };
    },
    scanStatus(options = {}) {
      assert.equal(options.sessionId, 'session-456');
      return { ok: true, status: 'running' };
    },
    getFindings(options = {}) {
      assert.equal(options.sessionId, 'session-456');
      return {
        ok: true,
        findings: [
          {
            engine: 'IAST',
            title: 'SPA DOM XSS',
            severity: 'high',
            location: { runtimeUrl: 'http://app.test/#/search?q=xss' }
          }
        ]
      };
    }
  };
  const evaluateWithAgent = agent => async (fn, args) => {
    const original = globalThis.PTK_AGENT;
    globalThis.PTK_AGENT = agent;
    try {
      return await fn(args);
    } finally {
      globalThis.PTK_AGENT = original;
    }
  };
  const statusPage = {
    async goto() {},
    async close() {
      this.closed = true;
    },
    evaluate: evaluateWithAgent(statusPageAgent)
  };
  const page = {
    evaluate: evaluateWithAgent(hotAgent),
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  try {
    globalThis.PTK_AGENT = previous;
    const artifact = await collectAgentPlanningPtkSignals(page, {
      config: {
        target: { baseUrl: 'http://app.test/' },
        ptk: { enabled: true, drainMode: 'until-complete' }
      },
      lifecycleStart: {
        sessionId: 'session-456',
        scanStarted: true,
        start: {
          bridge: {
            available: true,
            source: 'PTK_AGENT',
            methods: ['scanStatus', 'getFindings'],
            methodGroups: {
              status: ['scanStatus'],
              findings: ['getFindings']
            },
            candidates: []
          }
        }
      }
    });

    assert.equal(artifact.signalSource, 'status-page');
    assert.equal(artifact.bridgeReusedFromLifecycleStart, false);
    assert.equal(artifact.statusOk, true);
    assert.equal(artifact.findingsOk, true);
    assert.equal(artifact.findingsCount, 1);
    assert.equal(statusPage.closed, true);
    assert.equal(artifact.signalCollectionAttempts.length, 2);
    assert.equal(artifact.signalCollectionAttempts[0].source, 'current-page-lifecycle-bridge');
    assert.equal(artifact.signalCollectionAttempts[1].source, 'status-page');
  } finally {
    if (previous === undefined) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = previous;
    }
  }
});

test('agent planning PTK signals retry from status page when lifecycle bridge is missing on current page', async () => {
  const previous = globalThis.PTK_AGENT;
  const statusPageAgent = {
    describe() {
      return {
        ok: true,
        source: 'PTK_AGENT',
        methods: ['scanStatus', 'getFindings'],
        methodGroups: {
          status: ['scanStatus'],
          findings: ['getFindings']
        }
      };
    },
    scanStatus(options = {}) {
      assert.equal(options.sessionId, 'session-bridge-missing');
      return { ok: true, status: 'running' };
    },
    getFindings(options = {}) {
      assert.equal(options.sessionId, 'session-bridge-missing');
      return {
        ok: true,
        findings: [
          {
            engine: 'DAST',
            title: 'JWT None Algorithm',
            severity: 'high',
            location: { pageUrl: 'http://app.test/#/profile' }
          }
        ]
      };
    }
  };
  const evaluateWithAgent = agent => async (fn, args) => {
    const original = globalThis.PTK_AGENT;
    if (agent === null) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = agent;
    }
    try {
      return await fn(args);
    } finally {
      if (original === undefined) {
        delete globalThis.PTK_AGENT;
      } else {
        globalThis.PTK_AGENT = original;
      }
    }
  };
  const statusPage = {
    async goto() {},
    async close() {
      this.closed = true;
    },
    evaluate: evaluateWithAgent(statusPageAgent)
  };
  const page = {
    evaluate: evaluateWithAgent(null),
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  try {
    globalThis.PTK_AGENT = previous;
    const artifact = await collectAgentPlanningPtkSignals(page, {
      config: {
        target: { baseUrl: 'http://app.test/' },
        ptk: { enabled: true, drainMode: 'until-complete' }
      },
      lifecycleStart: {
        sessionId: 'session-bridge-missing',
        scanStarted: true,
        start: {
          bridge: {
            available: true,
            source: 'PTK_AGENT',
            methods: ['scanStatus', 'getFindings'],
            methodGroups: {
              status: ['scanStatus'],
              findings: ['getFindings']
            },
            candidates: []
          }
        }
      }
    });

    assert.equal(artifact.signalSource, 'status-page');
    assert.equal(artifact.statusOk, true);
    assert.equal(artifact.findingsOk, true);
    assert.equal(artifact.findingsCount, 1);
    assert.equal(statusPage.closed, true);
    assert.equal(artifact.signalCollectionAttempts.length, 2);
    assert.equal(artifact.signalCollectionAttempts[0].statusReason, 'bridge_missing');
    assert.equal(artifact.signalCollectionAttempts[1].source, 'status-page');
  } finally {
    if (previous === undefined) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = previous;
    }
  }
});

test('agent planning PTK signals can fall back to diagnostic export before stop', async () => {
  const previous = globalThis.PTK_AGENT;
  const hotAgent = {
    scanStatus() {
      throw new Error('PTK bridge method scanStatus/getStatus/status/getSessionProgress exceeded 4000ms budget');
    },
    getFindings() {
      throw new Error('PTK bridge method getFindings/findings/getAlerts/getIssues exceeded 5000ms budget');
    }
  };
  const exportAgent = {
    describe() {
      return {
        ok: true,
        source: 'PTK_AGENT',
        methods: ['scanStatus', 'getFindings', 'exportFullReport'],
        methodGroups: {
          status: ['scanStatus'],
          findings: ['getFindings'],
          export: ['exportFullReport']
        }
      };
    },
    scanStatus() {
      throw new Error('PTK bridge method scanStatus/getStatus/status/getSessionProgress exceeded 4000ms budget');
    },
    getFindings() {
      throw new Error('PTK bridge method getFindings/findings/getAlerts/getIssues exceeded 5000ms budget');
    },
    exportFullReport(options = {}) {
      assert.equal(options.sessionId, 'session-789');
      return {
        ok: true,
        findings: [
          {
            engine: 'IAST',
            title: 'SPA DOM XSS',
            severity: 'high',
            location: { runtimeUrl: 'http://app.test/#/search?q=export' }
          }
        ],
        exportRetrievalResolved: true,
        exportLookupSource: 'explicit-session'
      };
    }
  };
  const evaluateWithAgent = agent => async (fn, args) => {
    const original = globalThis.PTK_AGENT;
    globalThis.PTK_AGENT = agent;
    try {
      return await fn(args);
    } finally {
      globalThis.PTK_AGENT = original;
    }
  };
  const statusPage = {
    async goto() {},
    async close() {
      this.closed = true;
    },
    evaluate: evaluateWithAgent(exportAgent)
  };
  const page = {
    evaluate: evaluateWithAgent(hotAgent),
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  try {
    globalThis.PTK_AGENT = previous;
    const artifact = await collectAgentPlanningPtkSignals(page, {
      config: {
        target: { baseUrl: 'http://app.test/' },
        ptk: { enabled: true, drainMode: 'until-complete', allowPlanningExportFallback: true }
      },
      lifecycleStart: {
        sessionId: 'session-789',
        scanStarted: true,
        start: {
          bridge: {
            available: true,
            source: 'PTK_AGENT',
            methods: ['scanStatus', 'getFindings', 'exportFullReport'],
            methodGroups: {
              status: ['scanStatus'],
              findings: ['getFindings'],
              export: ['exportFullReport']
            },
            candidates: []
          }
        }
      }
    });

    assert.equal(artifact.signalSource, 'status-page-export');
    assert.equal(artifact.findingsOk, true);
    assert.equal(artifact.findingsCount, 1);
    assert.equal(artifact.findingsApiFallbackUsed, false);
    assert.equal(artifact.signalCollectionAttempts.some(attempt => attempt.exportAttempted), true);
    assert.equal(statusPage.closed, true);
  } finally {
    if (previous === undefined) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = previous;
    }
  }
});

test('agent planning PTK signals do not use diagnostic export by default', async () => {
  const previous = globalThis.PTK_AGENT;
  let exportCalls = 0;
  const hotAgent = {
    scanStatus() {
      throw new Error('PTK bridge method scanStatus/getStatus/status/getSessionProgress exceeded 4000ms budget');
    },
    getFindings() {
      throw new Error('PTK bridge method getFindings/findings/getAlerts/getIssues exceeded 5000ms budget');
    }
  };
  const exportAgent = {
    describe() {
      return {
        ok: true,
        source: 'PTK_AGENT',
        methods: ['scanStatus', 'getFindings', 'exportFullReport'],
        methodGroups: {
          status: ['scanStatus'],
          findings: ['getFindings'],
          export: ['exportFullReport']
        }
      };
    },
    scanStatus() {
      throw new Error('PTK bridge method scanStatus/getStatus/status/getSessionProgress exceeded 4000ms budget');
    },
    getFindings() {
      throw new Error('PTK bridge method getFindings/findings/getAlerts/getIssues exceeded 5000ms budget');
    },
    exportFullReport() {
      exportCalls += 1;
      return { ok: true, findings: [{ title: 'should not be used' }], exportRetrievalResolved: true };
    }
  };
  const evaluateWithAgent = agent => async (fn, args) => {
    const original = globalThis.PTK_AGENT;
    globalThis.PTK_AGENT = agent;
    try {
      return await fn(args);
    } finally {
      globalThis.PTK_AGENT = original;
    }
  };
  const statusPage = {
    async goto() {},
    async close() {
      this.closed = true;
    },
    evaluate: evaluateWithAgent(exportAgent)
  };
  const page = {
    evaluate: evaluateWithAgent(hotAgent),
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  try {
    globalThis.PTK_AGENT = previous;
    const artifact = await collectAgentPlanningPtkSignals(page, {
      config: {
        target: { baseUrl: 'http://app.test/' },
        ptk: { enabled: true, drainMode: 'until-complete', requireFindingsExport: true }
      },
      lifecycleStart: {
        sessionId: 'session-no-planning-export',
        scanStarted: true,
        start: {
          bridge: {
            available: true,
            source: 'PTK_AGENT',
            methods: ['scanStatus', 'getFindings', 'exportFullReport'],
            methodGroups: {
              status: ['scanStatus'],
              findings: ['getFindings'],
              export: ['exportFullReport']
            },
            candidates: []
          }
        }
      }
    });

    assert.equal(exportCalls, 0);
    assert.equal(artifact.findingsOk, false);
    assert.equal(artifact.findingsCount, 0);
    assert.equal(artifact.signalCollectionAttempts.some(attempt => attempt.exportAttempted), false);
    assert.equal(statusPage.closed, true);
  } finally {
    if (previous === undefined) {
      delete globalThis.PTK_AGENT;
    } else {
      globalThis.PTK_AGENT = previous;
    }
  }
});

test('PTK drain status reader falls back to a same-context status page when current page status hangs', async () => {
  const statusPage = {
    url: null,
    closed: false,
    async goto(url) {
      this.url = url;
    },
    async close() {
      this.closed = true;
    }
  };
  const page = {
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  const calls = [];
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      crawler: { maxRouteMs: 30000 },
      ptk: { drainMode: 'until-complete' }
    },
    bridge: { available: true, source: 'PTK_AGENT' },
    readPtkStatusFn: async (target, options) => {
      calls.push({ target, bridge: options.bridge || null });
      if (target === page) {
        assert.equal(options.bridge && options.bridge.source, 'PTK_AGENT');
        return {
          ok: false,
          reason: 'PTK bridge method scanStatus exceeded 5000ms budget',
          status: null
        };
      }
      assert.equal(options.bridge, null);
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    }
  });

  const result = await reader.readStatus();
  await reader.close();

  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'completed');
  assert.equal(result.statusPageFallback.used, true);
  assert.equal(statusPage.url, 'http://example.test/');
  assert.equal(statusPage.closed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, page);
  assert.equal(calls[1].target, statusPage);
});

test('PTK drain status reader uses status page when session-scoped primary bridge is disabled', async () => {
  const statusPage = {
    url: null,
    closed: false,
    async goto(url) {
      this.url = url;
    },
    async close() {
      this.closed = true;
    }
  };
  const page = {
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  const calls = [];
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      crawler: { maxRouteMs: 30000 },
      ptk: { drainMode: 'until-complete' }
    },
    bridge: { available: true, source: 'PTK_AUTOMATION' },
    statusOptions: { sessionId: 'ptk-session-1' },
    readPtkStatusFn: async (target, options) => {
      calls.push({ target, statusOptions: options.statusOptions || null });
      if (target === page) {
        return {
          ok: false,
          reason: 'automation_disabled',
          invocation: {
            value: {
              ok: false,
              error: 'automation_disabled'
            }
          },
          status: null
        };
      }
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    }
  });

  const result = await reader.readStatus();
  await reader.close();

  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'completed');
  assert.equal(result.statusPageFallback.used, true);
  assert.equal(result.statusPageFallback.reason, 'automation_disabled');
  assert.equal(statusPage.url, 'http://example.test/');
  assert.equal(statusPage.closed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, page);
  assert.equal(calls[1].target, statusPage);
  assert.deepEqual(calls[0].statusOptions, { sessionId: 'ptk-session-1' });
  assert.deepEqual(calls[1].statusOptions, { sessionId: 'ptk-session-1' });
});

test('PTK drain status reader uses status page when lifecycle bridge is disabled on current page', async () => {
  const statusPage = {
    async goto(url) {
      this.url = url;
    },
    async close() {
      this.closed = true;
    }
  };
  const page = {
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  const calls = [];
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      ptk: { drainMode: 'until-complete' }
    },
    bridge: { available: true, source: 'PTK_AUTOMATION' },
    readPtkStatusFn: async target => {
      calls.push(target === page ? 'primary' : 'status-page');
      if (target === page) {
        return {
          ok: false,
          reason: 'automation_disabled',
          status: null
        };
      }
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    }
  });

  const result = await reader.readStatus();
  await reader.close();

  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'completed');
  assert.equal(result.statusPageFallback.used, true);
  assert.equal(result.statusPageFallback.reason, 'automation_disabled');
  assert.equal(statusPage.url, 'http://example.test/');
  assert.equal(statusPage.closed, true);
  assert.deepEqual(calls, ['primary', 'status-page']);
});

test('PTK drain status reader recovers disabled owner page before opening status page', async () => {
  let navigated = false;
  let statusPageOpened = false;
  const page = {
    async goto(url) {
      assert.equal(url, 'http://example.test/');
      navigated = true;
    },
    context() {
      return {
        async newPage() {
          statusPageOpened = true;
          return {
            async goto() {},
            async close() {}
          };
        }
      };
    }
  };
  const calls = [];
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      ptk: { drainMode: 'until-complete', statusReadTimeoutMs: 3000 }
    },
    bridge: { available: true, source: 'PTK_AUTOMATION' },
    readPtkStatusFn: async target => {
      assert.equal(target, page);
      calls.push(navigated ? 'after-navigation' : 'before-navigation');
      if (!navigated) {
        return {
          ok: false,
          reason: 'automation_disabled',
          status: null
        };
      }
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    }
  });

  const result = await reader.readStatus();
  await reader.close();

  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'completed');
  assert.equal(result.primaryPageRecovery.used, true);
  assert.equal(result.primaryPageRecovery.reason, 'automation_disabled');
  assert.equal(statusPageOpened, false);
  assert.deepEqual(calls, ['before-navigation', 'after-navigation']);
});

test('PTK drain status reader requests activation before navigating disabled owner page', async () => {
  let activated = false;
  let navigated = false;
  const page = {
    async evaluate() {
      activated = true;
      return { ok: true, allowed: true, reason: 'terminal_session_tab' };
    },
    async goto() {
      navigated = true;
    },
    context() {
      return {
        async newPage() {
          throw new Error('status page should not be opened');
        }
      };
    }
  };
  const calls = [];
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      ptk: { drainMode: 'until-complete', statusReadTimeoutMs: 3000 }
    },
    bridge: { available: true, source: 'PTK_AUTOMATION' },
    readPtkStatusFn: async target => {
      assert.equal(target, page);
      calls.push(activated ? 'after-activation' : 'before-activation');
      if (!activated) {
        return {
          ok: false,
          reason: 'automation_disabled',
          status: null
        };
      }
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    }
  });

  const result = await reader.readStatus();
  await reader.close();

  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'completed');
  assert.equal(result.primaryActivationRecovery.used, true);
  assert.equal(result.primaryActivationRecovery.reason, 'automation_disabled');
  assert.equal(navigated, false);
  assert.deepEqual(calls, ['before-activation', 'after-activation']);
});

test('PTK drain status reader rechecks primary page after status-page fallback was opened', async () => {
  const statusPage = {
    async goto() {},
    async close() {
      this.closed = true;
    }
  };
  const page = {
    context() {
      return {
        async newPage() {
          return statusPage;
        }
      };
    }
  };
  const calls = [];
  let primaryOk = false;
  const reader = createPtkDrainStatusReader({
    page,
    config: {
      target: { baseUrl: 'http://example.test/' },
      crawler: { maxRouteMs: 30000 },
      ptk: { drainMode: 'until-complete' }
    },
    bridge: { available: true, source: 'PTK_AGENT' },
    readPtkStatusFn: async target => {
      calls.push(target === page ? 'primary' : 'status-page');
      if (target === page && !primaryOk) {
        return {
          ok: false,
          reason: 'PTK bridge method scanStatus exceeded 5000ms budget',
          status: null
        };
      }
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed', source: target === page ? 'primary' : 'status-page' }
      };
    }
  });

  const first = await reader.readStatus();
  primaryOk = true;
  const second = await reader.readStatus();
  await reader.close();

  assert.equal(first.ok, true);
  assert.equal(first.status.source, 'status-page');
  assert.equal(first.statusPageFallback.used, true);
  assert.equal(second.ok, true);
  assert.equal(second.status.source, 'primary');
  assert.equal(second.statusPageFallback, undefined);
  assert.deepEqual(calls, ['primary', 'status-page', 'primary']);
  assert.equal(statusPage.closed, true);
});

test('PTK drain status reader refreshes a stale primary-page bridge before status-page fallback', async () => {
  const originalReadPtkStatus = ptkBridge.readPtkStatus;
  const originalWaitForPtkBridge = ptkBridge.waitForPtkBridge;
  let statusPageOpened = false;
  const page = {
    context() {
      return {
        async newPage() {
          statusPageOpened = true;
          return {
            async goto() {},
            async close() {}
          };
        }
      };
    }
  };
  const calls = [];
  try {
    ptkBridge.readPtkStatus = async (target, options = {}) => {
      calls.push({ target, bridge: options.bridge || null });
      if (options.bridge && options.bridge.source === 'PTK_AGENT_STALE') {
        return {
          ok: false,
          reason: 'Execution context was destroyed',
          status: null
        };
      }
      assert.equal(options.bridge && options.bridge.source, 'PTK_AGENT');
      return {
        ok: true,
        reason: 'status_read',
        status: { status: 'completed' }
      };
    };
    ptkBridge.waitForPtkBridge = async () => ({
      available: true,
      source: 'PTK_AGENT',
      methods: ['scanStatus']
    });
    const reader = createPtkDrainStatusReader({
      page,
      config: {
        target: { baseUrl: 'http://example.test/' },
        ptk: { drainMode: 'until-complete' }
      },
      bridge: { available: true, source: 'PTK_AGENT_STALE' }
    });

    const result = await reader.readStatus();
    await reader.close();

    assert.equal(result.ok, true);
    assert.equal(result.status.status, 'completed');
    assert.equal(result.refreshedBridge, true);
    assert.equal(result.staleBridgeFailure.reason, 'Execution context was destroyed');
    assert.equal(statusPageOpened, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].bridge.source, 'PTK_AGENT_STALE');
    assert.equal(calls[1].bridge.source, 'PTK_AGENT');
  } finally {
    ptkBridge.readPtkStatus = originalReadPtkStatus;
    ptkBridge.waitForPtkBridge = originalWaitForPtkBridge;
  }
});

test('PTK evidence collection helpers detect status-page fallback and bridge retry cases', () => {
  assert.equal(ptkDrainUsedStatusPage({
    latest: {
      statusPageFallback: { used: true }
    }
  }), true);
  assert.equal(ptkDrainUsedStatusPage({
    latest: {
      reason: 'status_read'
    }
  }), false);
  assert.equal(ptkOperationShouldRetryOnStatusPage({
    available: false,
    exported: false,
    reason: 'detect_failed:PTK bridge detection exceeded 10000ms budget'
  }), true);
  assert.equal(ptkOperationShouldRetryOnStatusPage({
    available: true,
    stopped: false,
    reason: 'PTK bridge method stopScan exceeded 5000ms budget'
  }), true);
  assert.equal(ptkOperationShouldRetryOnStatusPage({
    available: true,
    exported: false,
    reason: 'session_not_found'
  }), true);
  assert.equal(ptkOperationShouldRetryOnStatusPage({
    available: true,
    exported: true,
    collected: true,
    reason: 'exported'
  }), false);
  assert.equal(ptkOperationShouldRetryOnPrimaryPage({
    available: true,
    exported: false,
    reason: 'session_belongs_to_another_tab'
  }), true);
  assert.equal(ptkOperationShouldRetryOnPrimaryPage({
    available: true,
    exported: false,
    reason: 'session_not_found'
  }), true);
  assert.equal(ptkOperationShouldRetryOnPrimaryPage({
    available: true,
    exported: false,
    reason: 'export_unavailable'
  }), false);
});

test('PTK lifecycle session id is carried from start result for explicit status/export calls', () => {
  assert.equal(ptkSessionIdFromLifecycleStart({
    start: {
      invocation: {
        value: {
          sessionId: 'session-123'
        }
      }
    }
  }), 'session-123');
  assert.equal(ptkSessionIdFromLifecycleStart({
    start: {
      invocation: {
        value: {
          session: { id: 'nested-session' }
        }
      }
    }
  }), 'nested-session');
  assert.equal(ptkSessionIdFromLifecycleStart({
    start: {
      invocation: {
        value: {
          scanId: 'engine-scan-id',
          id: 'ambiguous-id'
        }
      }
    }
  }), null);
});

test('PTK evidence is exported before stopping scan so finalized sessions are not lost', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-export-before-stop-'));
  const finding = {
    engine: 'DAST',
    severity: 'high',
    title: 'test finding',
    url: 'https://example.test/'
  };

  ptkBridge.exportPtkEvidence = async () => {
    calls.push('export');
    return {
      available: true,
      exported: true,
      collected: true,
      bridge: { available: true, source: 'PTK_AGENT' },
      evidence: {
        status: { status: 'running' },
        export: { findings: [finding] },
        findings: [finding],
        validity: {
          valid: true,
          status: 'valid',
          hasPtkBridge: true,
          hasFindingsExport: true,
          findingsCount: 1,
          reason: 'exported'
        }
      },
      findings: [finding],
      validity: {
        valid: true,
        status: 'valid',
        hasPtkBridge: true,
        hasFindingsExport: true,
        findingsCount: 1,
        reason: 'exported'
      },
      reason: 'exported'
    };
  };
  ptkBridge.stopPtkScan = async () => {
    calls.push('stop');
    return {
      available: true,
      stopped: true,
      reason: 'stopped'
    };
  };
  ptkBridge.readPtkStatus = async () => {
    calls.push('status');
    return {
      ok: true,
      status: { status: 'completed' },
      reason: 'completed'
    };
  };

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1000,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' }
        }
      }
    });

    assert.equal(result.exported, true);
    assert.equal(result.validity.status, 'valid');
    assert.equal(calls[0], 'export');
    assert.equal(calls[1], 'stop');
    assert.ok(calls.includes('status'));
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK evidence collection can reuse an explicit post-agent drain result', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-pre-drain-'));
  let statusCalls = 0;
  const preDrain = {
    mode: 'until-complete',
    status: 'completed',
    timedOut: false,
    timeoutMs: 1000,
    elapsedMs: 25,
    polls: 1,
    reason: 'pre_supplied_post_agent_drain',
    latest: {
      status: {
        engines: {
          DAST: {
            status: 'idle',
            progress: { done: 1, total: 1, remaining: 0 },
            idle: true
          }
        }
      }
    },
    classification: {
      available: true,
      complete: true,
      partial: false,
      reason: 'pre_supplied_post_agent_drain'
    }
  };

  ptkBridge.exportPtkEvidence = async () => ({
    available: true,
    exported: true,
    collected: true,
    bridge: { available: true, source: 'PTK_AGENT' },
    evidence: {
      export: { findings: [] },
      findings: [],
      validity: {
        valid: true,
        status: 'valid',
        hasPtkBridge: true,
        hasFindingsExport: true,
        findingsCount: 0,
        reason: 'exported'
      }
    },
    findings: [],
    validity: {
      valid: true,
      status: 'valid',
      hasPtkBridge: true,
      hasFindingsExport: true,
      findingsCount: 0,
      reason: 'exported'
    },
    reason: 'exported'
  });
  ptkBridge.stopPtkScan = async () => ({
    available: true,
    stopped: false,
    reason: 'not_stopped_for_test'
  });
  ptkBridge.readPtkStatus = async () => {
    statusCalls += 1;
    return { ok: true, status: { status: 'running' } };
  };

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'until-complete',
          drainTimeoutMs: 1000,
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' }
        }
      },
      preDrain
    });

    assert.equal(result.exported, true);
    assert.equal(result.lifecycle.drain.status, 'completed');
    assert.equal(result.lifecycle.drain.reason, 'pre_supplied_post_agent_drain');
    assert.equal(result.lifecycle.drain.classification.reason, 'pre_supplied_post_agent_drain');
    assert.equal(statusCalls, 0);
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK lifecycle preserves failed before-stop export attempts when after-stop retry also fails', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-export-attempts-'));

  ptkBridge.exportPtkEvidence = async () => {
    calls.push('export');
    return {
      available: true,
      exported: false,
      collected: false,
      lookupDiagnostics: { lookupSource: 'none' },
      validity: {
        valid: false,
        status: 'invalid_no_findings_export',
        hasPtkBridge: true,
        hasFindingsExport: false,
        findingsCount: 0,
        reason: 'session_not_found'
      },
      reason: 'session_not_found'
    };
  };
  ptkBridge.stopPtkScan = async () => {
    calls.push('stop');
    return {
      available: true,
      stopped: true,
      reason: 'stopped'
    };
  };
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, false);
    assert.equal(result.lifecycle.exportBeforeStopAttempted, true);
    assert.equal(result.lifecycle.exportBeforeStopSucceeded, false);
    assert.equal(result.lifecycle.exportFailureBeforeStop, true);
    assert.ok(result.lifecycle.exportAttempts.length >= 2);
    assert.equal(result.lifecycle.exportAttempts[0].stage, 'before-stop');
    assert.equal(result.lifecycle.exportAttempts.at(-1).stage, 'after-stop');
    assert.ok(result.lifecycle.inconsistencies.includes('export_session_lookup_failed'));
    assert.ok(calls.indexOf('export') < calls.indexOf('stop'));
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK evidence export retries without explicit session after completed-session lookup remains not completed', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-completed-session-export-'));
  let stoppedCalled = false;

  ptkBridge.exportPtkEvidence = async (_page, options = {}) => {
    const sessionScoped = Boolean(options.exportOptions && options.exportOptions.sessionId);
    calls.push({
      sessionScoped,
      stage: sessionScoped ? 'session-scoped' : 'unscoped',
      source: options.exportSource || null
    });
    if (!sessionScoped) {
      return {
        available: true,
        exported: true,
        collected: true,
        findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
        bridge: { available: true, source: 'PTK_AUTOMATION' },
        evidence: {
          findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
          validity: {
            valid: true,
            status: 'valid',
            hasPtkBridge: true,
            hasFindingsExport: true,
            findingsCount: 1,
            reason: 'exported'
          }
        },
        validity: {
          valid: true,
          status: 'valid',
          hasPtkBridge: true,
          hasFindingsExport: true,
          findingsCount: 1,
          reason: 'exported'
        },
        reason: 'exported'
      };
    }
    const afterStop = stoppedCalled;
    return {
      available: true,
      exported: false,
      collected: true,
      findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
      bridge: { available: true, source: 'PTK_AGENT' },
      lookupDiagnostics: {
        lookupSource: 'explicit-session',
        activeSessionIdForTab: afterStop ? null : 'session-1',
        completedSessionIdForTab: afterStop ? 'session-1' : null,
        globalCompletedSessionId: afterStop ? 'session-1' : null,
        sessionFinishedAt: afterStop ? '2026-05-31T00:00:00.000Z' : null,
        stopRequestedAt: afterStop ? '2026-05-31T00:00:00.000Z' : null
      },
      validity: {
        valid: false,
        status: 'invalid_no_findings_export',
        hasPtkBridge: true,
        hasFindingsExport: false,
        findingsCount: 1,
        reason: 'session_not_completed'
      },
      reason: 'session_not_completed'
    };
  };
  ptkBridge.stopPtkScan = async () => {
    stoppedCalled = true;
    return {
      available: true,
      stopped: true,
      reason: 'stopped'
    };
  };
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, true);
    assert.equal(result.lifecycle.exportRecoveredAfterStop, true);
    assert.equal(result.lifecycle.exportAttempts.at(-1).stage, 'after-stop');
    assert.equal(result.lifecycle.exportAttempts.at(-1).source, 'PTK_AUTOMATION');
    assert.equal(result.lifecycle.exportAttempts.at(-1).sessionScoped, false);
    assert.equal(calls.at(-1).sessionScoped, false);
    assert.ok(calls.slice(0, -1).every(call => call.sessionScoped));
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK evidence export retries completed-session lookup when session_not_completed is only in validity', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-completed-session-validity-export-'));
  let stoppedCalled = false;

  ptkBridge.exportPtkEvidence = async (_page, options = {}) => {
    const sessionScoped = Boolean(options.exportOptions && options.exportOptions.sessionId);
    calls.push({ sessionScoped, source: options.exportSource || null });
    if (!sessionScoped) {
      return {
        available: true,
        exported: true,
        collected: true,
        findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
        bridge: { available: true, source: 'PTK_AUTOMATION' },
        evidence: {
          findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
          validity: {
            valid: true,
            status: 'valid',
            hasPtkBridge: true,
            hasFindingsExport: true,
            findingsCount: 1,
            reason: 'exported'
          }
        },
        validity: {
          valid: true,
          status: 'valid',
          hasPtkBridge: true,
          hasFindingsExport: true,
          findingsCount: 1,
          reason: 'exported'
        },
        reason: 'exported'
      };
    }
    const afterStop = stoppedCalled;
    return {
      available: true,
      exported: false,
      collected: true,
      findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
      bridge: { available: true, source: 'PTK_AGENT' },
      lookupDiagnostics: {
        lookupSource: 'explicit-session',
        activeSessionIdForTab: afterStop ? null : 'session-1',
        completedSessionIdForTab: afterStop ? 'session-1' : null,
        globalCompletedSessionId: afterStop ? 'session-1' : null,
        sessionFinishedAt: afterStop ? '2026-06-03T00:00:00.000Z' : null,
        stopRequestedAt: afterStop ? '2026-06-03T00:00:00.000Z' : null
      },
      validity: {
        valid: false,
        status: 'invalid_no_findings_export',
        hasPtkBridge: true,
        hasFindingsExport: false,
        findingsCount: 1,
        reason: 'session_not_completed'
      },
      reason: 'findings_collected'
    };
  };
  ptkBridge.stopPtkScan = async () => {
    stoppedCalled = true;
    return { available: true, stopped: true, reason: 'stopped' };
  };
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, true);
    assert.equal(result.lifecycle.exportRecoveredAfterStop, true);
    assert.equal(calls.at(-1).sessionScoped, false);
    assert.equal(calls.at(-1).source, 'PTK_AUTOMATION');
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK evidence export does not retry unscoped when completed-session diagnostics do not match explicit session', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-completed-session-mismatch-'));
  let stoppedCalled = false;

  ptkBridge.exportPtkEvidence = async (_page, options = {}) => {
    const sessionScoped = Boolean(options.exportOptions && options.exportOptions.sessionId);
    calls.push({ sessionScoped, source: options.exportSource || null });
    if (!sessionScoped) {
      return {
        available: true,
        exported: true,
        collected: true,
        findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high' }],
        validity: {
          valid: true,
          status: 'valid',
          hasPtkBridge: true,
          hasFindingsExport: true,
          findingsCount: 1,
          reason: 'exported'
        },
        reason: 'exported'
      };
    }
    return {
      available: true,
      exported: false,
      collected: true,
      findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high' }],
      bridge: { available: true, source: 'PTK_AGENT' },
      lookupDiagnostics: {
        lookupSource: 'explicit-session',
        activeSessionIdForTab: stoppedCalled ? null : 'session-1',
        completedSessionIdForTab: stoppedCalled ? 'other-session' : null,
        globalCompletedSessionId: stoppedCalled ? 'other-session' : null,
        sessionFinishedAt: stoppedCalled ? '2026-06-01T00:00:00.000Z' : null,
        stopRequestedAt: stoppedCalled ? '2026-06-01T00:00:00.000Z' : null
      },
      validity: {
        valid: false,
        status: 'invalid_no_findings_export',
        hasPtkBridge: true,
        hasFindingsExport: false,
        findingsCount: 1,
        reason: 'session_not_completed'
      },
      reason: 'session_not_completed'
    };
  };
  ptkBridge.stopPtkScan = async () => {
    stoppedCalled = true;
    return { available: true, stopped: true, reason: 'stopped' };
  };
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence({}, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, false);
    assert.equal(calls.some(call => call.sessionScoped === false), false);
    assert.ok(result.lifecycle.exportAttempts.every(attempt => attempt.sessionScoped === true));
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK session-scoped evidence export does not retry through status page', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-session-export-'));
  let statusPages = 0;
  const exportPages = [];
  const page = {
    role: 'primary',
    context() {
      return {
        async newPage() {
          statusPages += 1;
          return {
            role: 'status',
            async goto() {},
            async close() {}
          };
        }
      };
    }
  };

  ptkBridge.exportPtkEvidence = async exportPage => {
    exportPages.push(exportPage.role || 'unknown');
    return {
      available: true,
      exported: false,
      collected: false,
      bridge: { available: true, source: 'PTK_AGENT' },
      validity: {
        valid: false,
        status: 'invalid_no_findings_export',
        hasPtkBridge: true,
        hasFindingsExport: false,
        findingsCount: 0,
        reason: 'PTK bridge method exportFullReport exceeded 30000ms budget'
      },
      reason: 'PTK bridge method exportFullReport exceeded 30000ms budget'
    };
  };
  ptkBridge.stopPtkScan = async () => ({
    available: true,
    stopped: true,
    reason: 'stopped'
  });
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence(page, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'off',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, false);
    assert.equal(statusPages, 0);
    assert.deepEqual([...new Set(exportPages)], ['primary']);
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK session-scoped status-page export retries the original page before stop', async () => {
  const originalExport = ptkBridge.exportPtkEvidence;
  const originalStop = ptkBridge.stopPtkScan;
  const originalStatus = ptkBridge.readPtkStatus;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-status-primary-export-'));
  const exportPages = [];
  let statusPages = 0;
  const page = {
    role: 'primary',
    context() {
      return {
        async newPage() {
          statusPages += 1;
          return {
            role: 'status',
            async goto() {},
            async close() {}
          };
        }
      };
    }
  };

  ptkBridge.exportPtkEvidence = async exportPage => {
    exportPages.push(exportPage.role || 'unknown');
    if (exportPage.role === 'status') {
      return {
        available: true,
        exported: false,
        collected: true,
        findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
        bridge: { available: true, source: 'PTK_AGENT' },
        validity: {
          valid: false,
          status: 'invalid_no_findings_export',
          hasPtkBridge: true,
          hasFindingsExport: false,
          findingsCount: 1,
          reason: 'session_belongs_to_another_tab'
        },
        reason: 'session_belongs_to_another_tab'
      };
    }
    return {
      available: true,
      exported: true,
      collected: true,
      findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
      bridge: { available: true, source: 'PTK_AGENT' },
      evidence: {
        findings: [{ engine: 'DAST', ruleName: 'XSS', severity: 'high', url: 'https://example.test/#/search' }],
        validity: {
          valid: true,
          status: 'valid',
          hasPtkBridge: true,
          hasFindingsExport: true,
          findingsCount: 1,
          reason: 'exported'
        }
      },
      validity: {
        valid: true,
        status: 'valid',
        hasPtkBridge: true,
        hasFindingsExport: true,
        findingsCount: 1,
        reason: 'exported'
      },
      reason: 'exported'
    };
  };
  ptkBridge.stopPtkScan = async stopPage => ({
    available: true,
    stopped: true,
    reason: `stopped:${stopPage.role || 'unknown'}`
  });
  ptkBridge.readPtkStatus = async () => ({
    ok: true,
    status: { status: 'completed' },
    reason: 'completed'
  });

  try {
    const result = await collectPtkEvidence(page, {
      config: {
        target: { baseUrl: 'https://example.test/' },
        artifacts: { outputDir },
        crawler: { maxRouteMs: 30000 },
        ptk: {
          enabled: true,
          drainMode: 'until-complete',
          exportDrainMs: 1,
          requireBridge: true,
          requireFindingsExport: true
        }
      },
      preDrain: {
        latest: {
          statusPageFallback: { used: true }
        }
      },
      lifecycleStart: {
        bridgeDetected: true,
        scanStarted: true,
        start: {
          bridge: { available: true, source: 'PTK_AGENT' },
          invocation: { value: { sessionId: 'session-1' } }
        }
      }
    });

    assert.equal(result.exported, true);
    assert.equal(result.validity.valid, true);
    assert.equal(statusPages, 1);
    assert.deepEqual(exportPages.slice(0, 2), ['status', 'primary']);
    assert.equal(result.lifecycle.exportAttempts[1].stage, 'retry-primary-page');
    assert.equal(result.lifecycle.exportAttempts[1].page, 'primary-page');
    assert.equal(result.lifecycle.exportAttempts[1].source, 'auto');
  } finally {
    ptkBridge.exportPtkEvidence = originalExport;
    ptkBridge.stopPtkScan = originalStop;
    ptkBridge.readPtkStatus = originalStatus;
  }
});

test('PTK drain classifier detects completed engine state', () => {
  const status = classifyPtkDrainStatus({
    status: 'completed',
    engines: {
      DAST: {
        status: 'completed',
        idle: true,
        isRunning: false,
        progress: { done: 10, total: 10, remaining: 0 }
      },
      IAST: {
        status: 'idle',
        idle: true,
        isRunning: false,
        progress: { done: 2, total: null }
      }
    }
  });

  assert.equal(status.complete, true);
  assert.equal(status.idle, true);
  assert.equal(status.partial, false);
});

test('PTK drain classifier treats idle zero-remaining DAST and passive IAST as complete', () => {
  const rawStatus = {
    status: 'running',
    engines: {
      DAST: {
        status: 'idle',
        phase: 'idle',
        idle: true,
        isRunning: true,
        activeTasks: 0,
        taskQueue: 0,
        requestQueue: 0,
        pendingPlans: 0,
        planning: 0,
        progress: { done: 3724, total: 5436, remaining: 0 }
      },
      IAST: {
        status: 'running',
        isRunning: true,
        progress: { done: 21, total: null }
      },
      SAST: {
        status: 'running',
        phase: 'waiting',
        isRunning: true,
        runtime: {
          collectionState: 'waiting_for_page_activity',
          analysisState: 'complete',
          isAnalysisRunning: false,
          activeCollectionCount: 0
        },
        progress: { done: 8, total: 8, remaining: 0 }
      }
    }
  };
  const status = classifyPtkDrainStatus(rawStatus);

  assert.equal(status.complete, true);
  assert.equal(status.partial, false);
  assert.equal(status.engines.DAST.complete, true);
  assert.equal(status.engines.IAST.complete, true);
  assert.equal(status.engines.SAST.complete, true);
  const attack = summarizePtkAttackCompletion(rawStatus);
  assert.equal(attack.engines.SAST.status, 'idle');
  assert.equal(attack.engines.SAST.phase, 'waiting');
});

test('PTK drain classifier detects partial or cancelled engine state', () => {
  const attack = summarizePtkAttackCompletion({
    engines: {
      DAST: {
        status: 'stopped',
        phase: 'stopped',
        progress: { done: 4, total: 10, remaining: 6 }
      }
    }
  });

  assert.equal(attack.available, true);
  assert.equal(attack.partial, true);
  assert.equal(attack.engines.DAST.cancelled, 6);
});

test('PTK attack classifier treats post-completion stop with zero remaining as complete', () => {
  const attack = summarizePtkAttackCompletion({
    engines: {
      DAST: {
        status: 'stopped',
        phase: 'stopped',
        activeTasks: 0,
        taskQueue: 0,
        requestQueue: 0,
        pendingPlans: 0,
        planning: 0,
        progress: { done: 3775, total: 5514, remaining: 0 }
      },
      SAST: {
        status: 'stopped',
        phase: 'waiting',
        progress: { done: 6, total: 6, remaining: 0 }
      }
    }
  });

  assert.equal(attack.available, true);
  assert.equal(attack.partial, false);
  assert.equal(attack.engines.DAST.cancelled, 0);
  assert.equal(attack.engines.DAST.partial, false);
});

test('PTK drain poller stops when completion is observed before timeout', async () => {
  const statuses = [
    { status: { status: 'running', engines: { DAST: { status: 'running', isRunning: true, progress: { done: 1, total: 2, remaining: 1 } } } } },
    { status: { status: 'completed', engines: { DAST: { status: 'completed', idle: true, progress: { done: 2, total: 2, remaining: 0 } } } } }
  ];
  let index = 0;
  let nowValue = 0;
  const result = await pollPtkDrainStatus({
    mode: 'until-complete',
    timeoutMs: 1000,
    intervalMs: 10,
    now: () => nowValue,
    sleepFn: async ms => { nowValue += ms; },
    readStatus: async () => statuses[Math.min(index++, statuses.length - 1)]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.timedOut, false);
  assert.equal(result.polls, 2);
});

test('PTK drain poller reports timeout without claiming completion', async () => {
  let nowValue = 0;
  const result = await pollPtkDrainStatus({
    mode: 'until-complete',
    timeoutMs: 25,
    intervalMs: 10,
    now: () => nowValue,
    sleepFn: async ms => { nowValue += ms; },
    readStatus: async () => ({
      status: {
        status: 'running',
        engines: {
          DAST: {
            status: 'running',
            isRunning: true,
            progress: { done: 1, total: 10, remaining: 9 }
          }
        }
      }
    })
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(result.attackCompletion.partial, true);
});

test('PTK drain poller stops when the PTK page/context is already closed', async () => {
  let polls = 0;
  let slept = false;
  const result = await pollPtkDrainStatus({
    mode: 'until-complete',
    timeoutMs: 600000,
    intervalMs: 1000,
    readStatus: async () => {
      polls += 1;
      return {
        ok: false,
        status: null,
        reason: 'page.evaluate: Target page, context or browser has been closed',
        invocation: {
          ok: false,
          called: false,
          reason: 'page.evaluate: Target page, context or browser has been closed'
        }
      };
    },
    sleepFn: async () => {
      slept = true;
    }
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ptk_status_page_closed');
  assert.equal(result.timedOut, false);
  assert.equal(result.polls, 1);
  assert.equal(polls, 1);
  assert.equal(slept, false);
});

test('PTK drain poller honors timeout when a status read hangs', async () => {
  let nowValue = 0;
  let polls = 0;
  const pollSummaries = [];
  const result = await pollPtkDrainStatus({
    mode: 'until-complete',
    timeoutMs: 30,
    intervalMs: 10,
    readTimeoutMs: 5,
    now: () => nowValue,
    sleepFn: async ms => { nowValue += ms; },
    readTimeoutFn: async ms => { nowValue += ms; },
    onPoll: summary => pollSummaries.push(summary),
    readStatus: async () => {
      polls += 1;
      return new Promise(() => {});
    }
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.ok(result.elapsedMs >= 30);
  assert.ok(polls > 0);
  assert.ok(pollSummaries.length > 0);
  assert.equal(result.latest.readTimedOut, true);
});
