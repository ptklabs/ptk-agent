'use strict';

const SAFE_TOOLS = Object.freeze([
  {
    name: 'observe_state',
    description: 'Return redacted coverage, scenario, PTK, and agent state summary.',
    safety: 'safe',
    inputSchema: objectSchema({})
  },
  {
    name: 'list_route_graph',
    description: 'List observed routes and route edges without DOM snapshots.',
    safety: 'safe',
    inputSchema: objectSchema({ limit: integerSchema(1, 500) })
  },
  {
    name: 'list_endpoint_graph',
    description: 'List observed endpoints without request bodies or secrets.',
    safety: 'safe',
    inputSchema: objectSchema({ limit: integerSchema(1, 500) })
  },
  {
    name: 'execute_allowed_mission',
    description: 'Execute or evaluate a deterministic mission through policy-controlled SDK handlers.',
    safety: 'safe',
    inputSchema: objectSchema({
      mission: {
        type: 'object',
        additionalProperties: true
      }
    }, ['mission'])
  },
  {
    name: 'get_ptk_lifecycle_status',
    description: 'Return PTK bridge, lifecycle, validity, and findings-count status.',
    safety: 'safe',
    inputSchema: objectSchema({})
  },
  {
    name: 'get_scenario_status',
    description: 'Return scenario completion and failed-step status.',
    safety: 'safe',
    inputSchema: objectSchema({})
  },
  {
    name: 'get_recent_action_effects',
    description: 'Return recent agent action-effect records.',
    safety: 'safe',
    inputSchema: objectSchema({ limit: integerSchema(1, 100) })
  }
]);

const UNSAFE_TOOLS = Object.freeze([
  {
    name: 'get_raw_debug_state',
    description: 'Return raw debug state. Hidden unless unsafe tools are explicitly enabled.',
    safety: 'unsafe',
    inputSchema: objectSchema({})
  }
]);

function listManagerTools(options = {}) {
  const tools = options.includeUnsafe ? [...SAFE_TOOLS, ...UNSAFE_TOOLS] : SAFE_TOOLS;
  return tools.map(tool => ({ ...tool, inputSchema: clone(tool.inputSchema) }));
}

function getManagerTool(name, options = {}) {
  return listManagerTools(options).find(tool => tool.name === name) || null;
}

function toolRegistrySchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://pentestkit.local/schemas/agent-tools.schema.json',
    title: 'PTK Agents SDK Manager Tool Registry',
    type: 'object',
    required: ['schemaVersion', 'tools'],
    properties: {
      schemaVersion: { const: 'ptk-agent-v2-manager-tools' },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'description', 'safety', 'inputSchema'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            safety: { enum: ['safe', 'unsafe'] },
            inputSchema: { type: 'object' }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  };
}

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

function integerSchema(minimum, maximum) {
  return { type: 'integer', minimum, maximum };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  getManagerTool,
  listManagerTools,
  toolRegistrySchema
};
