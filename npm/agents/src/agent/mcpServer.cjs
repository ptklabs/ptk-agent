'use strict';

const { parseArgs } = require('../cli/args.cjs');
const { writeLine } = require('../cli/status.cjs');
const { listMcpTools, mcpToolRegistrySchema } = require('./mcpToolRegistry.cjs');
const { runStdioServer } = require('./mcpStdioServer.cjs');
const packageJson = require('../../package.json');

function help(cliName = 'ptk-agent-mcp-server') {
  return [
    'Usage:',
    `  ${cliName} [options]`,
    '',
    'Options:',
    '  --stdio            Run as a real MCP stdio server.',
    '  --workspace <dir>  Workspace root for MCP file operations. Default: current directory.',
    '  --allow-scan       Expose ptk_run_scan in MCP stdio mode.',
    '  --allow-browser-actions Expose browser action tools in MCP stdio mode.',
    '  --list-tools       Print the safe default tool registry as JSON.',
    '  --schema           Print the tool registry JSON schema.',
    '  --include-unsafe   Include unsafe/debug tools in --list-tools output.',
    '  -h, --help         Show help.',
    '',
    'In --stdio mode stdout is reserved for MCP JSON-RPC messages. Logs go to stderr.',
    'Safe default MCP tools never expose raw HTML, DOM snapshots, request bodies, or secrets.'
  ].join('\n');
}

async function run(argv = [], context = {}) {
  const { options } = parseArgs(argv, {
    booleans: ['help', 'stdio', 'list-tools', 'schema', 'include-unsafe', 'allow-scan', 'allow-browser-actions'],
    strings: ['workspace']
  });
  const cliName = context.cliName || 'ptk-agent-mcp-server';
  const stdout = context.io && context.io.stdout || process.stdout;
  const stderr = context.io && context.io.stderr || process.stderr;
  if (options.stdio) {
    if (options['list-tools'] || options.schema) {
      const error = new Error('--stdio cannot be combined with --list-tools or --schema');
      error.exitCode = 64;
      throw error;
    }
    return runStdioServer({
      cwd: context.cwd || process.cwd(),
      workspace: options.workspace || context.cwd || process.cwd(),
      stdin: context.io && context.io.stdin || process.stdin,
      stdout,
      stderr,
      env: context.env || process.env,
      version: packageJson.version,
      allowScan: options['allow-scan'] === true,
      allowBrowserActions: options['allow-browser-actions'] === true,
      includeUnsafe: options['include-unsafe'] === true
    });
  }
  if (options.help || (!options['list-tools'] && !options.schema)) {
    writeLine(stdout, help(cliName));
    return 0;
  }
  if (options.schema) {
    writeLine(stdout, JSON.stringify(mcpToolRegistrySchema(), null, 2));
    return 0;
  }
  if (options['list-tools']) {
    writeLine(stdout, JSON.stringify({
      schemaVersion: 'ptk-agent-v2-mcp-tools',
      tools: listMcpTools({
        allowScan: options['allow-scan'] === true,
        allowBrowserActions: options['allow-browser-actions'] === true,
        includeUnsafe: options['include-unsafe'] === true
      })
    }, null, 2));
    return 0;
  }
  return 0;
}

module.exports = {
  help,
  run
};
