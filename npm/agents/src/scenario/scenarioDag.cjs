'use strict';

const { assertValidScenario, collectDependencies } = require('./scenarioValidator.cjs');

function buildScenarioDag(scenario, options = {}) {
  assertValidScenario(scenario, options);
  const nodes = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  for (const [index, step] of scenario.steps.entries()) {
    const node = { ...step, index, dependsOn: collectDependencies(step) };
    nodes.set(step.id, node);
    outgoing.set(step.id, []);
    incoming.set(step.id, node.dependsOn.slice());
  }
  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) outgoing.get(dependency).push(node.id);
  }
  return { version: scenario.version, nodes, outgoing, incoming, order: scenario.steps.map(step => step.id) };
}

function topologicalSort(dag) {
  const counts = new Map();
  const ready = [];
  const sorted = [];
  for (const id of dag.order) {
    const count = (dag.incoming.get(id) || []).length;
    counts.set(id, count);
    if (count === 0) ready.push(id);
  }
  while (ready.length) {
    const id = ready.shift();
    sorted.push(dag.nodes.get(id));
    for (const nextId of dag.outgoing.get(id) || []) {
      const count = counts.get(nextId) - 1;
      counts.set(nextId, count);
      if (count === 0) ready.push(nextId);
    }
  }
  if (sorted.length !== dag.nodes.size) throw new Error('Scenario DAG cannot be sorted because it contains a cycle.');
  return sorted;
}

function createScenarioState(dag) {
  const state = { statusById: new Map(), resultById: new Map(), startedAt: new Date().toISOString() };
  for (const id of dag.order) state.statusById.set(id, 'pending');
  return state;
}

function getReadySteps(dag, state) {
  return dag.order.map(id => dag.nodes.get(id)).filter(step => {
    if (state.statusById.get(step.id) !== 'pending') return false;
    return (dag.incoming.get(step.id) || []).every(dependencyId => state.statusById.get(dependencyId) === 'completed');
  });
}

function markStepResult(state, stepId, result) {
  const status = result && result.ok ? 'completed' : 'failed';
  state.statusById.set(stepId, status);
  state.resultById.set(stepId, result || { ok: false, error: 'missing result' });
  return status;
}

function serializeDag(dag) {
  return {
    version: dag.version,
    order: dag.order.slice(),
    nodes: Array.from(dag.nodes.values()),
    edges: Array.from(dag.outgoing.entries()).flatMap(([from, targets]) => targets.map(to => ({ from, to })))
  };
}

module.exports = {
  buildScenarioDag,
  topologicalSort,
  createScenarioState,
  getReadySteps,
  markStepResult,
  serializeDag
};
