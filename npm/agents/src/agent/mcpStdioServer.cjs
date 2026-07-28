'use strict';

const readline = require('readline');
const { createMcpToolHandlers, safeToolError } = require('./mcpToolHandlers.cjs');
const { listMcpTools } = require('./mcpToolRegistry.cjs');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-06-18';

function createMcpServer(options = {}) {
  const registryOptions = {
    allowScan: options.allowScan === true,
    allowBrowserActions: options.allowBrowserActions === true,
    includeUnsafe: options.includeUnsafe === true
  };
  const handlers = options.handlers || createMcpToolHandlers(options);
  let initialized = false;
  let shuttingDown = false;

  async function handleMessage(message) {
    if (Array.isArray(message)) {
      const responses = [];
      for (const item of message) {
        const response = await handleSingleMessage(item);
        if (response) responses.push(response);
      }
      return responses.length ? responses : null;
    }
    return handleSingleMessage(message);
  }

  async function handleSingleMessage(message) {
    if (!message || message.jsonrpc !== JSONRPC_VERSION) {
      return errorResponse(message && message.id, -32600, 'Invalid JSON-RPC message');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = message.id;
    const method = message.method;
    if (!method) {
      return hasId ? errorResponse(id, -32600, 'JSON-RPC request missing method') : null;
    }

    try {
      if (method === 'initialize') {
        initialized = true;
        return hasId ? resultResponse(id, initializeResult(message.params, options)) : null;
      }
      if (method === 'notifications/initialized') {
        initialized = true;
        return null;
      }
      if (method === 'ping') {
        return hasId ? resultResponse(id, {}) : null;
      }
      if (method === 'tools/list') {
        return hasId ? resultResponse(id, { tools: listMcpTools(registryOptions) }) : null;
      }
      if (method === 'tools/call') {
        if (!hasId) return null;
        const result = await callTool(message.params || {}, handlers);
        return resultResponse(id, result);
      }
      if (method === 'shutdown') {
        shuttingDown = true;
        return hasId ? resultResponse(id, null) : null;
      }
      if (method === 'exit') {
        shuttingDown = true;
        return null;
      }
      return hasId ? errorResponse(id, -32601, `Method not found: ${method}`) : null;
    } catch (error) {
      return hasId ? errorResponse(id, -32603, error && error.message ? error.message : String(error)) : null;
    }
  }

  return {
    handleMessage,
    isInitialized() {
      return initialized;
    },
    isShuttingDown() {
      return shuttingDown;
    },
    registryOptions
  };
}

function initializeResult(params = {}, options = {}) {
  const requestedVersion = params && params.protocolVersion;
  const protocolVersion = typeof requestedVersion === 'string' && requestedVersion
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    serverInfo: {
      name: 'pentestkit',
      version: options.version || '0.0.0'
    }
  };
}

async function callTool(params, handlers) {
  const name = params && params.name;
  if (typeof name !== 'string' || !name) {
    return toolResult(safeToolError(new Error('tools/call params.name must be a non-empty string')), true);
  }
  const args = params.arguments || {};
  try {
    const output = await handlers.call(name, args);
    return toolResult(output, false);
  } catch (error) {
    return toolResult(safeToolError(error), true);
  }
}

function toolResult(value, isError = false) {
  const safeValue = value === undefined ? null : value;
  return {
    content: [
      {
        type: 'text',
        text: typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue, null, 2)
      }
    ],
    structuredContent: typeof safeValue === 'object' && safeValue !== null ? safeValue : { value: safeValue },
    isError
  };
}

function resultResponse(id, result) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result
  };
}

function errorResponse(id, code, message, data = undefined) {
  const response = {
    jsonrpc: JSONRPC_VERSION,
    id: id === undefined ? null : id,
    error: {
      code,
      message
    }
  };
  if (data !== undefined) response.error.data = data;
  return response;
}

function parseLine(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function runStdioServer(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const server = createMcpServer(options);
  stderr.write(`ptk-agent-mcp-server: stdio mode started; workspace=${options.workspace || options.cwd || process.cwd()}\n`);

  const rl = readline.createInterface({
    input: stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  for await (const line of rl) {
    if (!line || !String(line).trim()) continue;
    const parsed = parseLine(line);
    if (!parsed.ok) {
      writeJsonRpc(stdout, errorResponse(null, -32700, `Parse error: ${parsed.error.message}`));
      continue;
    }
    const response = await server.handleMessage(parsed.value);
    if (response) writeJsonRpc(stdout, response);
    if (server.isShuttingDown()) break;
  }
  return 0;
}

function writeJsonRpc(stdout, message) {
  const payload = JSON.stringify(message);
  stdout.write(`${payload}\n`);
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  callTool,
  createMcpServer,
  errorResponse,
  initializeResult,
  resultResponse,
  runStdioServer,
  toolResult,
  writeJsonRpc
};
