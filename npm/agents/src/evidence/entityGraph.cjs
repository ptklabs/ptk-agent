'use strict';

const { createGraphNode, createGraphEdge, stableHash } = require('./evidenceModel.cjs');

class EntityGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  recordEntity(kind, key, data = {}) {
    if (!kind || !key) return null;
    const node = createGraphNode(`entity:${kind}`, key, data);
    this.nodes.set(node.id, { ...(this.nodes.get(node.id) || {}), ...node });
    return node;
  }

  addEntity(entity = {}) {
    return this.recordEntity(entity.type || entity.kind || 'entity', entity.id, entity);
  }

  relate(fromEntity, toEntity, relation = 'related', data = {}) {
    if (!fromEntity || !toEntity) return null;
    const edge = createGraphEdge(relation, fromEntity.id, toEntity.id, data);
    this.edges.set(edge.id, edge);
    return edge;
  }

  ingestPageModel(model) {
    if (!model || !model.url) return;
    const route = this.recordEntity('route', model.url, {
      url: model.url,
      routeShape: model.routeShape,
      surfaceType: model.surfaceType
    });
    for (const form of model.forms || []) {
      const formNode = this.recordEntity('form', `${model.url}#${form.id}`, form);
      this.relate(route, formNode, 'contains-form');
      for (const field of form.fields || []) {
        const fieldNode = this.recordEntity('field', `${model.url}#${form.id}.${field.name || field.id}`, field);
        this.relate(formNode, fieldNode, 'contains-field');
      }
    }
    for (const action of model.actions || []) {
      const actionNode = this.recordEntity('action', `${model.url}#${action.id}`, action);
      this.relate(route, actionNode, 'contains-action');
    }
  }

  toJSON() {
    return {
      kind: 'entity-graph',
      graphId: `entity-graph:${stableHash(Array.from(this.nodes.keys()).sort())}`,
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }

  snapshot() {
    return {
      entities: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values())
    };
  }
}

function createEntityGraph() {
  return new EntityGraph();
}

function entityGraphFromPageModels(models = []) {
  const graph = createEntityGraph();
  for (const model of models) graph.ingestPageModel(model);
  return graph;
}

module.exports = {
  EntityGraph,
  createEntityGraph,
  entityGraphFromPageModels
};
