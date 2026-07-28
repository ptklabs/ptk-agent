'use strict';

const { createGraphNode, createGraphEdge, stableHash } = require('./evidenceModel.cjs');

function endpointKey(endpoint) {
  return `${String(endpoint.method || 'GET').toUpperCase()} ${endpoint.url || endpoint.path || ''}`;
}

class EndpointGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  recordEndpoint(endpoint) {
    if (!endpoint || (!endpoint.url && !endpoint.path)) return null;
    const key = endpointKey(endpoint);
    const node = createGraphNode('endpoint', key, {
      url: endpoint.url || null,
      path: endpoint.path || null,
      method: String(endpoint.method || 'GET').toUpperCase(),
      status: endpoint.status || null,
      resourceType: endpoint.resourceType || 'unknown',
      graphqlOperationName: endpoint.graphqlOperationName || null
    });
    this.nodes.set(node.id, { ...(this.nodes.get(node.id) || {}), ...node });
    return node;
  }

  addEndpoint(endpoint, source = {}) {
    const node = this.recordEndpoint(endpoint);
    if (node && Object.keys(source).length) {
      node.data.sources = [...(node.data.sources || []), source];
      this.nodes.set(node.id, node);
    }
    return node;
  }

  addActionEndpointEdge(actionId, endpointId, data = {}) {
    if (!actionId || !endpointId) return null;
    const edge = createGraphEdge('action-endpoint', actionId, endpointId, data);
    this.edges.set(edge.id, edge);
    return edge;
  }

  linkRouteToEndpoint(routeUrl, endpoint, data = {}) {
    const endpointNode = this.recordEndpoint(endpoint);
    if (!routeUrl || !endpointNode) return null;
    const routeNode = createGraphNode('route', routeUrl, { url: routeUrl });
    this.nodes.set(routeNode.id, routeNode);
    const edge = createGraphEdge('observed-endpoint', routeNode.id, endpointNode.id, data);
    this.edges.set(edge.id, edge);
    return edge;
  }

  toJSON() {
    return {
      kind: 'endpoint-graph',
      graphId: `endpoint-graph:${stableHash(Array.from(this.nodes.keys()).sort())}`,
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }

  snapshot() {
    return {
      endpoints: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }
}

function createEndpointGraph() {
  return new EndpointGraph();
}

function endpointGraphFromCoverage(coverage = {}) {
  const graph = createEndpointGraph();
  for (const endpoint of coverage.endpoints || []) graph.linkRouteToEndpoint(endpoint.routeUrl, endpoint, { observedAt: endpoint.observedAt });
  return graph;
}

module.exports = {
  EndpointGraph,
  createEndpointGraph,
  endpointGraphFromCoverage,
  endpointKey
};
