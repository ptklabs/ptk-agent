'use strict';

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

function stringSchema(description = null) {
  return {
    type: 'string',
    ...(description ? { description } : {})
  };
}

function booleanSchema(description = null) {
  return {
    type: 'boolean',
    ...(description ? { description } : {})
  };
}

function integerSchema(minimum, maximum, description = null) {
  return {
    type: 'integer',
    minimum,
    ...(maximum !== null && maximum !== undefined ? { maximum } : {}),
    ...(description ? { description } : {})
  };
}

function enumSchema(values, description = null) {
  return {
    type: 'string',
    enum: values,
    ...(description ? { description } : {})
  };
}

function arraySchema(items, description = null) {
  return {
    type: 'array',
    items,
    ...(description ? { description } : {})
  };
}

const DEFAULT_SAFE_TOOLS = Object.freeze([
  {
    name: 'ptk_doctor_extension',
    title: 'PTK Extension Diagnostics',
    description: 'Return redacted PTK browser extension resolution details.',
    safety: 'safe',
    inputSchema: objectSchema({
      configPath: stringSchema('Optional config path used to resolve explicit extension settings.')
    })
  },
  {
    name: 'ptk_validate_config',
    title: 'Validate PTK Config',
    description: 'Validate and resolve a PTK config file with secrets redacted.',
    safety: 'safe',
    inputSchema: objectSchema({
      configPath: stringSchema('Config file path inside the MCP workspace.')
    }, ['configPath'])
  },
  {
    name: 'ptk_resolve_config',
    title: 'Resolve PTK Config',
    description: 'Resolve a PTK config file with a small safe override subset.',
    safety: 'safe',
    inputSchema: objectSchema({
      configPath: stringSchema('Config file path inside the MCP workspace.'),
      targetUrl: stringSchema('Optional target.baseUrl override.'),
      outputDir: stringSchema('Optional artifacts.outputDir override inside the workspace.'),
      maxRoutes: integerSchema(1, 500, 'Optional crawler.maxRoutes override.'),
      engines: arraySchema(enumSchema(['DAST', 'IAST', 'SAST', 'SCA']), 'Optional engine list override.')
    }, ['configPath'])
  },
  {
    name: 'ptk_resolve_modules',
    title: 'Resolve PTK Modules',
    description: 'Resolve PTK module packs for a config without exposing portal tokens.',
    safety: 'safe',
    inputSchema: objectSchema({
      configPath: stringSchema('Optional config file path inside the MCP workspace.')
    })
  },
  {
    name: 'ptk_list_artifacts',
    title: 'List PTK Artifacts',
    description: 'List recognized PTK artifact files under an output directory.',
    safety: 'safe',
    inputSchema: objectSchema({
      outputDir: stringSchema('Artifact output directory inside the MCP workspace.')
    }, ['outputDir'])
  },
  {
    name: 'ptk_read_scan_summary',
    title: 'Read PTK Scan Summary',
    description: 'Read a concise redacted scan summary from PTK artifacts.',
    safety: 'safe',
    inputSchema: objectSchema({
      outputDir: stringSchema('Artifact output directory inside the MCP workspace.')
    }, ['outputDir'])
  },
  {
    name: 'ptk_read_findings_summary',
    title: 'Read PTK Findings Summary',
    description: 'Read a redacted findings summary from PTK artifacts.',
    safety: 'safe',
    inputSchema: objectSchema({
      outputDir: stringSchema('Artifact output directory inside the MCP workspace.'),
      limit: integerSchema(1, 200, 'Maximum sample count. Default 50.')
    }, ['outputDir'])
  },
  {
    name: 'ptk_compare_artifacts',
    title: 'Compare PTK Artifacts',
    description: 'Compare two PTK artifact JSON files inside the workspace.',
    safety: 'safe',
    inputSchema: objectSchema({
      baselineArtifact: stringSchema('Baseline artifact path inside the MCP workspace.'),
      candidateArtifact: stringSchema('Candidate artifact path inside the MCP workspace.')
    }, ['baselineArtifact', 'candidateArtifact'])
  }
]);

const SCAN_TOOLS = Object.freeze([
  {
    name: 'ptk_run_scan',
    title: 'Run PTK Scan',
    description: 'Run a bounded PTK scan. Only available when the server starts with --allow-scan.',
    safety: 'mutation',
    inputSchema: objectSchema({
      configPath: stringSchema('Optional config file path inside the MCP workspace.'),
      url: stringSchema('Optional target URL override or target when no config is supplied.'),
      outputDir: stringSchema('Optional artifact output directory inside the MCP workspace.'),
      scenarioPath: stringSchema('Optional scenario file path inside the MCP workspace.'),
      engines: arraySchema(enumSchema(['DAST', 'IAST', 'SAST', 'SCA']), 'Optional engine list override.'),
      maxRoutes: integerSchema(1, 200, 'Maximum routes for MCP-triggered scans. Default 25, hard max 200.'),
      dryRun: booleanSchema('Resolve config and artifacts without launching a browser.')
    })
  }
]);

const BROWSER_ACTION_TOOLS = Object.freeze([
  {
    name: 'ptk_execute_policy_checked_browser_mission',
    title: 'Execute PTK Browser Mission',
    description: 'Reserved for policy-checked browser mission execution. Only available when the server starts with --allow-browser-actions.',
    safety: 'mutation',
    inputSchema: objectSchema({
      mission: {
        type: 'object',
        additionalProperties: true
      }
    }, ['mission'])
  }
]);

const UNSAFE_TOOLS = Object.freeze([
  {
    name: 'ptk_get_raw_debug_state',
    title: 'Raw PTK Debug State',
    description: 'Reserved unsafe debug surface. Hidden unless unsafe tools are explicitly enabled.',
    safety: 'unsafe',
    inputSchema: objectSchema({})
  }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripInternalFields(tool) {
  const { safety, ...mcpTool } = tool;
  return {
    ...mcpTool,
    annotations: {
      readOnlyHint: safety === 'safe',
      destructiveHint: safety !== 'safe'
    }
  };
}

function listMcpTools(options = {}) {
  const tools = [...DEFAULT_SAFE_TOOLS];
  if (options.allowScan) tools.push(...SCAN_TOOLS);
  if (options.allowBrowserActions) tools.push(...BROWSER_ACTION_TOOLS);
  if (options.includeUnsafe) tools.push(...UNSAFE_TOOLS);
  return tools.map(tool => stripInternalFields(clone(tool)));
}

function getMcpTool(name, options = {}) {
  return listMcpTools(options).find(tool => tool.name === name) || null;
}

function mcpToolRegistrySchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://pentestkit.local/schemas/mcp-tools.schema.json',
    title: 'PTK MCP Tool Registry',
    type: 'object',
    required: ['schemaVersion', 'tools'],
    properties: {
      schemaVersion: { const: 'ptk-agent-v2-mcp-tools' },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'description', 'inputSchema'],
          properties: {
            name: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            inputSchema: { type: 'object' },
            annotations: { type: 'object' }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  };
}

module.exports = {
  getMcpTool,
  listMcpTools,
  mcpToolRegistrySchema
};
