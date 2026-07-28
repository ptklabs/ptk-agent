'use strict';

class MockProvider {
  constructor({ choice = null } = {}) {
    this.kind = 'mock';
    this.choice = choice;
  }

  async chooseMission(context) {
    if (this.choice) return this.choice;
    const mission = (context.missions || context.missionCandidates || [])[0] || null;
    const uiStep = mission ? uiStepForHandles(context.handles || []) : null;
    const routeHandle = mission && context.handlesByMission && typeof context.handlesByMission.get === 'function'
      ? context.handlesByMission.get(mission.id)
      : null;
    return {
      missionId: mission && mission.id,
      reason: mission ? 'mock_provider_first_mission' : 'no_mission_available',
      provider: 'mock',
      expectedDelta: mission ? expectedDeltaForMission(mission) : null,
      allowedCapability: mission ? allowedCapabilityForMission(mission) : null,
      riskModeRequired: 'safe',
      steps: uiStep ? [uiStep] : routeHandle ? [{
        type: 'visit_route',
        target: {
          routeHandleId: routeHandle.id,
          routeKey: routeHandle.routeKey
        },
        success: { routeChanged: true }
      }] : []
    };
  }
}

function uiStepForHandles(handles = []) {
  const surface = handles.find(handle => handle && handle.type === 'surface' && handle.policyTier === 'safe');
  if (surface) {
    return {
      type: 'open_surface',
      target: { surfaceId: surface.id },
      success: { newSurface: true }
    };
  }
  const control = handles.find(handle => handle && handle.type === 'control' && handle.policyTier === 'safe');
  if (control) {
    return {
      type: 'click_control',
      target: { controlId: control.id },
      success: { routeChanged: true }
    };
  }
  return null;
}

function expectedDeltaForMission(mission = {}) {
  if (mission.route) return { routes: 1, route: mission.route };
  if (mission.endpoint) return { endpoints: 1 };
  if (mission.params) return { endpointSignals: 1 };
  return { routes: 1, endpoints: 1, actions: 1 };
}

function allowedCapabilityForMission(mission = {}) {
  if (mission.kind === 'hidden-route-verification' || mission.kind === 'route-hint-flow') return 'route.visit';
  if (mission.kind === 'endpoint-backed-ui-flow') return mission.route ? 'route.visit' : 'mission:plan';
  if (mission.kind === 'graphql-operation-flow' || mission.kind === 'hidden-param-flow') return 'http.request';
  if (mission.kind === 'broad-coverage-tail') return 'crawl:direct';
  if (mission.kind === 'auth-flow' || mission.kind === 'scenario-unblock') return 'state.assert';
  return 'mission:plan';
}

function createMockProvider(options = {}) {
  return new MockProvider(options);
}

module.exports = {
  MockProvider,
  createMockProvider
};
