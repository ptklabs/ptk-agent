'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createMcpServer } = require('../../../src/agent/mcpStdioServer.cjs');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-mcp-test-'));
}

function writeConfig(workspace, extra = {}) {
  const config = {
    version: 'ptk-agent-v2-config',
    target: {
      baseUrl: 'http://localhost:3001'
    },
    ...extra
  };
  fs.writeFileSync(path.join(workspace, 'ptk.config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function callTool(server, id, name, args = {}) {
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  return response.result;
}

test('MCP server handles initialize and lists read-only safe tools by default', async () => {
  const workspace = makeWorkspace();
  const server = createMcpServer({ workspace, cwd: workspace, version: '9.9.1' });

  const init = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' }
    }
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.capabilities.tools.listChanged, false);
  assert.equal(init.result.serverInfo.name, 'pentestkit');

  const initialized = await server.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });
  assert.equal(initialized, null);

  const listed = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes('ptk_doctor_extension'));
  assert.ok(names.includes('ptk_validate_config'));
  assert.ok(names.includes('ptk_read_findings_summary'));
  assert.ok(!names.includes('ptk_run_scan'));
  assert.ok(!names.includes('ptk_execute_policy_checked_browser_mission'));
  assert.ok(!names.includes('ptk_get_raw_debug_state'));
});

test('MCP opt-in flags expose scan, browser-action, and unsafe tools only when enabled', async () => {
  const workspace = makeWorkspace();
  const server = createMcpServer({
    workspace,
    cwd: workspace,
    allowScan: true,
    allowBrowserActions: true,
    includeUnsafe: true
  });

  const listed = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  });
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes('ptk_run_scan'));
  assert.ok(names.includes('ptk_execute_policy_checked_browser_mission'));
  assert.ok(names.includes('ptk_get_raw_debug_state'));
});

test('MCP validate-config returns redacted resolved config', async () => {
  const workspace = makeWorkspace();
  writeConfig(workspace, {
    profile: {
      username: 'user@example.test',
      password: 'secret-password',
      includeSecrets: true
    }
  });
  const server = createMcpServer({ workspace, cwd: workspace });
  const result = await callTool(server, 1, 'ptk_validate_config', {
    configPath: 'ptk.config.json'
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.config.target.baseUrl, 'http://localhost:3001');
  assert.equal(result.structuredContent.config.profile.password, '[REDACTED]');
  assert.match(result.content[0].text, /\[REDACTED\]/);
  assert.doesNotMatch(result.content[0].text, /secret-password/);
});

test('MCP rejects paths outside the workspace as tool errors', async () => {
  const workspace = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-mcp-outside-'));
  fs.writeFileSync(path.join(outside, 'ptk.config.json'), '{"version":"ptk-agent-v2-config"}', 'utf8');
  const server = createMcpServer({ workspace, cwd: workspace });
  const result = await callTool(server, 1, 'ptk_validate_config', {
    configPath: path.join(outside, 'ptk.config.json')
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'path_outside_workspace');
});

test('MCP reads artifact and findings summaries without leaking obvious secrets', async () => {
  const workspace = makeWorkspace();
  const outputDir = path.join(workspace, '.ptk', 'artifacts');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'crawl-summary.json'), JSON.stringify({
    runId: 'run-1',
    routeCount: 2,
    endpointCount: 3,
    formCount: 1,
    findingsCount: 1,
    errorCount: 0
  }), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'coverage.json'), JSON.stringify({
    runId: 'run-1',
    routes: [{ url: 'http://localhost:3001/#/' }],
    endpoints: [],
    forms: [],
    actions: [],
    ptk: {
      evidence: {
        findings: [
          {
            engine: 'DAST',
            title: 'XSS',
            severity: 'high',
            url: 'http://localhost:3001/search?q=1&token=secret-token'
          }
        ]
      }
    }
  }), 'utf8');

  const server = createMcpServer({ workspace, cwd: workspace });
  const summary = await callTool(server, 1, 'ptk_read_scan_summary', {
    outputDir: '.ptk/artifacts'
  });
  assert.equal(summary.isError, false);
  assert.equal(summary.structuredContent.counts.routes, 2);
  assert.equal(summary.structuredContent.counts.findings, 1);

  const findings = await callTool(server, 2, 'ptk_read_findings_summary', {
    outputDir: '.ptk/artifacts'
  });
  assert.equal(findings.isError, false);
  assert.equal(findings.structuredContent.findingsCount, 1);
  assert.match(findings.content[0].text, /XSS/);
  assert.doesNotMatch(findings.content[0].text, /secret-token/);
});

test('ptk-agent-mcp-server --stdio speaks newline-delimited JSON-RPC on stdout', async () => {
  const workspace = makeWorkspace();
  const bin = path.resolve(__dirname, '../../../bin/ptk-agent-mcp-server');
  const child = spawn(process.execPath, [bin, '--stdio', '--workspace', workspace], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdoutLines = [];
  let stdoutBuffer = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) stdoutLines.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } }
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`);
  child.stdin.end();

  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  assert.match(stderr, /stdio mode started/);
  assert.equal(stdoutLines.length, 3);
  assert.equal(stdoutLines[0].id, 1);
  assert.equal(stdoutLines[0].result.serverInfo.name, 'pentestkit');
  assert.equal(stdoutLines[1].id, 2);
  assert.ok(stdoutLines[1].result.tools.some(tool => tool.name === 'ptk_doctor_extension'));
  assert.equal(stdoutLines[2].id, 3);
});
