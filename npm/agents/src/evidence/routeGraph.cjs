'use strict';

const { routeShape } = require('../browser/pageModel.cjs');
const { createGraphNode, createGraphEdge, stableHash } = require('./evidenceModel.cjs');

class RouteGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  recordRoute(route = {}) {
    if (!route.url) return null;
    const node = createGraphNode('route', route.url, {
      url: route.url,
      routeShape: route.routeShape || routeShape(route.url),
      title: route.title || '',
      surfaceType: route.surfaceType || 'unknown'
    });
    this.nodes.set(node.id, { ...(this.nodes.get(node.id) || {}), ...node });
    return node;
  }

  addRoute(route) {
    return this.recordRoute(route);
  }

  recordTransition(fromRoute, toRoute, data = {}) {
    const from = this.recordRoute(typeof fromRoute === 'string' ? { url: fromRoute } : fromRoute);
    const to = this.recordRoute(typeof toRoute === 'string' ? { url: toRoute } : toRoute);
    if (!from || !to) return null;
    const edge = createGraphEdge('route-transition', from.id, to.id, data);
    this.edges.set(edge.id, edge);
    return edge;
  }

  recordLink(fromRouteUrl, link) {
    if (!link || !link.href) return null;
    return this.recordTransition({ url: fromRouteUrl }, { url: link.href }, { kind: 'link', label: link.text || link.label || '' });
  }

  toJSON() {
    return {
      kind: 'route-graph',
      graphId: `route-graph:${stableHash(Array.from(this.nodes.keys()).sort())}`,
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }

  snapshot() {
    return {
      routes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }
}

function createRouteGraph() {
  return new RouteGraph();
}

function routeGraphFromCoverage(coverage = {}) {
  const graph = createRouteGraph();
  for (const route of coverage.routes || []) graph.recordRoute(route);
  for (const transition of coverage.transitions || coverage.edges || []) {
    if (transition.fromUrl && transition.toUrl) graph.recordTransition(transition.fromUrl, transition.toUrl, transition);
  }
  return graph;
}

module.exports = {
  RouteGraph,
  createRouteGraph,
  routeGraphFromCoverage
};
