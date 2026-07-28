'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAgentHandleRegistry,
  createAgentToolExecutor,
  runAgentManagerV2,
  validateActionPlan
} = require('../../../src/agent/index.cjs');
const { issuePageModelHandles } = require('../../../src/agent/sdkToolAdapter.cjs');

test('typed action plan rejects raw selectors and raw target strings', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const mission = { id: 'm1', kind: 'hidden-route-verification', route: '/admin' };
  const route = handles.issue({ type: 'route', routeKey: '/admin' });

  const selectorDecision = validateActionPlan({
    missionId: 'm1',
    reason: 'bad selector',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', selector: 'button:nth-child(2)', target: { controlId: 'ctrl_missing' } }]
  }, { missions: [mission], handles, turn: 1, agentConfig: { maxStepsPerTurn: 1 } });
  assert.equal(selectorDecision.allowed, false);
  assert.equal(selectorDecision.rejectReason, 'raw_selector_denied');

  const rawTargetDecision = validateActionPlan({
    missionId: 'm1',
    reason: 'bad url',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'visit_route', target: { url: '/admin', routeHandleId: route.id } }]
  }, { missions: [mission], handles, turn: 1, agentConfig: { maxStepsPerTurn: 1 } });
  assert.equal(rawTargetDecision.allowed, false);
  assert.equal(rawTargetDecision.rejectReason, 'raw_selector_denied');
});

test('typed action plan rejects stale handles', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const route = handles.issue({ type: 'route', routeKey: '/admin', expiresAfterTurn: 1 });
  const decision = validateActionPlan({
    missionId: 'm1',
    reason: 'stale route',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'visit_route', target: { routeHandleId: route.id, routeKey: '/admin' } }]
  }, {
    missions: [{ id: 'm1', kind: 'hidden-route-verification', route: '/admin' }],
    handles,
    turn: 2,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectReason, 'stale_handle');
});

test('typed action plan normalizes surface handle click aliases to open surface', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const surface = handles.issue({ type: 'surface', routeKey: '/', policyTier: 'safe' });
  const mission = { id: 'm1', kind: 'auth-surface-traversal', surfaceHandleId: surface.id };

  const decision = validateActionPlan({
    missionId: 'm1',
    reason: 'open the live navigation surface',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', target: { controlId: surface.id } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.plan.steps[0].type, 'open_surface');
  assert.equal(decision.plan.steps[0].target.surfaceId, surface.id);
  assert.equal(decision.plan.steps[0].normalizedFrom.reason, 'surface_handle_click_alias');
});

test('typed action plan normalizes route handles placed in surface or click fields to visit_route', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const route = handles.issue({ type: 'route', routeKey: 'http://app.test/#/address/saved', policyTier: 'safe' });
  const mission = { id: 'm1', kind: 'auth-surface-traversal', route: route.routeKey };

  const surfaceDecision = validateActionPlan({
    missionId: 'm1',
    reason: 'provider used open_surface for a route handle',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'open_surface', target: { surfaceId: route.id } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(surfaceDecision.allowed, true);
  assert.equal(surfaceDecision.plan.steps[0].type, 'visit_route');
  assert.equal(surfaceDecision.plan.steps[0].target.routeHandleId, route.id);
  assert.equal(surfaceDecision.plan.steps[0].normalizedFrom.reason, 'route_handle_surface_alias');

  const clickDecision = validateActionPlan({
    missionId: 'm1',
    reason: 'provider used click_control for a route handle',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', target: { controlId: route.id } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(clickDecision.allowed, true);
  assert.equal(clickDecision.plan.steps[0].type, 'visit_route');
  assert.equal(clickDecision.plan.steps[0].target.routeHandleId, route.id);
  assert.equal(clickDecision.plan.steps[0].normalizedFrom.reason, 'route_handle_click_alias');

  const explicitRouteFieldDecision = validateActionPlan({
    missionId: 'm1',
    reason: 'provider used open_surface with a route handle field',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'open_surface', target: { routeHandleId: route.id } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(explicitRouteFieldDecision.allowed, true);
  assert.equal(explicitRouteFieldDecision.plan.steps[0].type, 'visit_route');
  assert.equal(explicitRouteFieldDecision.plan.steps[0].target.routeHandleId, route.id);
  assert.equal(explicitRouteFieldDecision.plan.steps[0].normalizedFrom.reason, 'route_handle_open_surface_alias');
});

test('typed action plan still rejects incompatible non-surface click aliases', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/', policyTier: 'safe' });
  const mission = { id: 'm1', kind: 'auth-surface-traversal' };

  const decision = validateActionPlan({
    missionId: 'm1',
    reason: 'bad handle type',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', target: { controlId: form.id } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectReason, 'no_executable_steps');
  assert.ok(decision.errors.some(error => /wrong_handle_type/.test(error)));
});

test('form repair values must be local profile references', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/login' });
  const mission = { id: 'form-mission', kind: 'missing-required-fields' };

  const allowed = validateActionPlan({
    missionId: 'form-mission',
    reason: 'fill email locally',
    riskModeRequired: 'safe',
    expectedDelta: { forms: 1 },
    steps: [{ type: 'fill_form', target: { formId: form.id, values: { email: 'profile.email', password: 'profile.password' } } }]
  }, { missions: [mission], handles, turn: 1, agentConfig: { maxStepsPerTurn: 1 } });
  assert.equal(allowed.allowed, true);

  const rejected = validateActionPlan({
    missionId: 'form-mission',
    reason: 'provider asked for raw secret',
    riskModeRequired: 'safe',
    expectedDelta: { forms: 1 },
    steps: [{ type: 'fill_form', target: { formId: form.id, values: { password: 'YOUR_PASSWORD' } } }]
  }, { missions: [mission], handles, turn: 1, agentConfig: { maxStepsPerTurn: 1 } });
  assert.equal(rejected.allowed, false);
});

test('non-secret provider form literals are ignored so SDK resolves values locally', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/profile', policyTier: 'business' });
  const mission = { id: 'form-mission', kind: 'form-validation-repair' };

  const decision = validateActionPlan({
    missionId: 'form-mission',
    reason: 'submit profile image form',
    riskModeRequired: 'business',
    expectedDelta: { endpoints: 1 },
    steps: [{ type: 'submit_form', target: { formId: form.id, values: { imageUrl: 'https://example.test/avatar.png' } } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.plan.steps[0].type, 'submit_form');
  assert.deepEqual(decision.plan.steps[0].target.values, undefined);
  assert.equal(
    decision.plan.steps[0].normalizedFrom.formValues.reason,
    'provider_literals_ignored_sdk_local_form_resolution'
  );
  assert.deepEqual(decision.plan.steps[0].normalizedFrom.formValues.ignoredFields, ['imageUrl']);
});

test('form page-model refs are mapped only through an unambiguous fresh SDK form handle', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({
    type: 'form',
    routeKey: '/profile',
    policyTier: 'business',
    target: { id: 'form:1', kind: 'profile' },
    summary: { id: 'form:1', kind: 'profile' }
  });
  const mission = { id: 'form-mission', kind: 'form-validation-repair', formHandleId: form.id };

  const decision = validateActionPlan({
    missionId: 'form-mission',
    reason: 'provider copied a page-model form ref from summary',
    riskModeRequired: 'business',
    expectedDelta: { endpoints: 1 },
    steps: [{ type: 'submit_form', target: { formId: 'form:1' } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.plan.steps[0].target.formId, form.id);
  assert.equal(decision.plan.steps[0].normalizedFrom.formHandle.reason, 'form_handle_summary_alias');
});

test('provider plan normalization prefers resolved SDK mission over redacted provider mission id', () => {
  const { normalizeProviderPlan } = require('../../../src/agent/actionPlan.cjs');
  const mission = { id: 'mission:actual-sensitive-internal-id' };
  const normalized = normalizeProviderPlan({
    missionId: 'mission:[REDACTED]',
    reason: 'use resolved mission',
    riskModeRequired: 'safe',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'record_no_progress', target: {} }]
  }, { mission });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.plan.missionId, mission.id);
});

test('action plan validation does not redact mission ids before internal matching', () => {
  const { normalizeProviderPlan } = require('../../../src/agent/actionPlan.cjs');
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/', policyTier: 'business' });
  const mission = {
    id: 'mission:wrong-credential-field:ptk@example.test',
    kind: 'wrong-credential-field',
    formHandleId: form.id
  };
  const normalized = normalizeProviderPlan({
    missionId: 'mission:wrong-credential-field:[REDACTED_EMAIL]',
    reason: 'provider saw a redacted mission id but selected the fresh form handle',
    riskModeRequired: 'business',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'submit_form', target: { formId: form.id } }]
  }, { mission });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.plan.missionId, mission.id);
  const decision = validateActionPlan(normalized.plan, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.plan.missionId, mission.id);
  assert.notEqual(decision.redactedPlan.missionId, mission.id);
  assert.match(decision.redactedPlan.missionId, /\[REDACTED/);
});

test('ambiguous page-model form refs are not mapped to arbitrary SDK handles', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({ type: 'form', routeKey: '/profile', target: { id: 'form:1' }, summary: { id: 'form:1' } });
  handles.issue({ type: 'form', routeKey: '/profile', target: { id: 'form:1' }, summary: { id: 'form:1' } });
  const mission = { id: 'form-mission', kind: 'form-validation-repair' };

  const decision = validateActionPlan({
    missionId: 'form-mission',
    reason: 'ambiguous copied page-model form ref',
    riskModeRequired: 'safe',
    expectedDelta: { forms: 1 },
    steps: [{ type: 'submit_form', target: { formId: 'form:1' } }]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1 }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectReason, 'stale_handle');
  assert.ok(decision.errors.some(error => /unknown_handle/.test(error)));
});

test('fill then submit on the same form is coalesced into one submit transaction', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/feedback', policyTier: 'business' });
  const mission = { id: 'form-mission', kind: 'form-validation-repair' };

  const decision = validateActionPlan({
    missionId: 'form-mission',
    reason: 'fill and submit feedback',
    riskModeRequired: 'business',
    expectedDelta: { endpoints: 1 },
    steps: [
      { type: 'fill_form', target: { formId: form.id, values: { email: 'profile.email', message: 'profile.searchTerms[0]' } } },
      { type: 'submit_form', target: { formId: form.id } }
    ]
  }, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.plan.steps.length, 1);
  assert.equal(decision.plan.steps[0].type, 'submit_form');
  assert.deepEqual(decision.plan.steps[0].target.values, {
    email: 'profile.email',
    message: 'profile.searchTerms[0]'
  });
  assert.equal(decision.plan.steps[0].normalizedFrom.reason, 'same_form_submit_transaction');
});

test('business-tier form handles are rejected unless business mutations are enabled', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({ type: 'form', routeKey: '/feedback', policyTier: 'business' });
  const mission = { id: 'form-mission', kind: 'form-validation-repair' };
  const plan = {
    missionId: 'form-mission',
    reason: 'submit business form',
    riskModeRequired: 'safe',
    expectedDelta: { forms: 1 },
    steps: [{ type: 'submit_form', target: { formId: form.id, values: { message: 'profile.searchTerms[0]' } } }]
  };

  const safeDecision = validateActionPlan(plan, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'safe' }
  });
  assert.equal(safeDecision.allowed, false);
  assert.equal(safeDecision.rejectReason, 'policy_denied');

  const businessDecision = validateActionPlan(plan, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true }
  });
  assert.equal(businessDecision.allowed, true);
});

test('mutating tool transaction computes SDK actual delta and invalidates handles', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', routeKey: '/', policyTier: 'safe' });
  const browserContext = {};
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: {
      page: {
        url: () => 'http://app.test/',
        context: () => browserContext
      }
    },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      sdkToolAdapter: {
        executeControlHandle: async () => ({
          status: 'completed',
          coverage: { routes: [{ url: '/' }, { url: '/profile' }], endpoints: [{ key: 'GET /api/profile' }] },
          transition: { changed: true, noProgress: false, reason: 'clicked' },
          authStatePreserved: true
        })
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-menu-traversal' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.actualDelta.routes, 1);
  assert.equal(result.actualDelta.endpoints, 1);
  assert.equal(result.liveContext.invariant, 'same-live-page-context');
  assert.equal(result.liveContext.usedExistingPage, true);
  assert.equal(result.liveContext.createdNewContext, false);
  assert.equal(result.liveContext.samePage, true);
  assert.equal(result.liveContext.sameBrowserContext, true);
  assert.match(result.liveContext.pageIdBefore, /^page_/);
  assert.equal(result.liveContext.pageIdBefore, result.liveContext.pageIdAfter);
  assert.match(result.liveContext.browserContextIdBefore, /^context_/);
  assert.equal(result.liveContext.browserContextIdBefore, result.liveContext.browserContextIdAfter);
  assert.equal(result.liveContext.sessionLost, false);
  assert.equal(result.authStatePreserved, true);
  assert.equal(handles.validate(control.id, { type: 'control', turn: 1 }).ok, false);
});

test('mutating tool transaction reports auth loss from before and after auth evidence', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', routeKey: '/', policyTier: 'safe' });
  const browserContext = {};
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: {
      page: {
        url: () => 'http://app.test/',
        context: () => browserContext
      }
    },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      sdkToolAdapter: {
        executeControlHandle: async () => ({
          status: 'completed',
          coverage: { routes: [{ url: '/' }], endpoints: [{ key: 'GET /api/logout-check' }] },
          transition: { changed: true, noProgress: false, reason: 'clicked' },
          browserActionRan: true,
          authStateBefore: 'authenticated',
          authStateAfter: 'anonymous',
          authStatePreserved: false
        })
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'surface-expanded-route' },
    plan: { expectedDelta: { endpoints: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.liveContext.authStateBefore, 'authenticated');
  assert.equal(result.liveContext.authStateAfter, 'anonymous');
  assert.equal(result.liveContext.authStatePreserved, false);
  assert.equal(result.liveContext.sessionLost, true);
  assert.equal(result.authStatePreserved, false);
});

test('route tool execution merges coverage monotonically instead of replacing baseline', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const route = handles.issue({ type: 'route', routeKey: '/graphiql', policyTier: 'safe' });
  const context = {
    coverage: {
      routes: [{ url: '/' }, { url: '/account' }],
      endpoints: [{ key: 'GET /api/account' }]
    }
  };
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: { page: { url: () => 'http://app.test/' } },
    context,
    handles,
    executeRoute: async () => ({
      status: 'completed',
      coverage: {
        routes: [{ url: '/graphiql' }],
        endpoints: [{ key: 'POST /graphql' }]
      },
      transition: { changed: true, noProgress: false, reason: 'route-visited' }
    })
  });

  const result = await executor.executeStep({
    mission: { id: 'route-mission', kind: 'ptk-finding-entrypoint-reproduction' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'visit_route', target: { routeHandleId: route.id } },
    turn: 1
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.actualDelta.routes, 1);
  assert.equal(result.actualDelta.endpoints, 1);
  assert.deepEqual(context.coverage.routes.map(item => item.url).sort(), ['/', '/account', '/graphiql']);
  assert.deepEqual(context.coverage.endpoints.map(item => item.key).sort(), ['GET /api/account', 'POST /graphql']);
});

test('agent tool policy blocks logout controls even when the handle was misclassified safe', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({
    type: 'control',
    routeKey: '/',
    policyTier: 'safe',
    target: { id: 'logout', kind: 'click-link', label: 'Log out' },
    summary: { id: 'logout', kind: 'click-link', label: 'Log out' }
  });
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'business', allowBusinessMutations: true, allowDestructiveActions: false } },
    session: { page: { url: () => 'http://app.test/' } },
    context: { coverage: { routes: [{ url: '/' }], endpoints: [] } },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'surface-expanded-route' },
    plan: { expectedDelta: { endpoints: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'destructive_action_denied');
  assert.equal(result.browserActionRan, false);
});

test('fill_form tool resolves profile refs locally and fills without submitting', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({
    type: 'form',
    routeKey: 'http://app.test/',
    policyTier: 'business',
    target: {
      id: 'feedback',
      kind: 'feedback',
      fields: [
        { name: 'email', selector: '[name="email"]', type: 'email' },
        { name: 'message', selector: '[name="message"]', type: 'text' }
      ]
    },
    summary: { id: 'feedback', kind: 'feedback' }
  });
  const page = {
    url: () => 'http://app.test/',
    async evaluate(_fn, payload) {
      assert.equal(payload.formId, 'feedback');
      assert.deepEqual(payload.fields.map(field => [field.name, field.value]), [
        ['email', 'person@example.test'],
        ['message', 'crystal']
      ]);
      return { ok: true, reason: 'dom_fill', filled: 2, planned: 2 };
    }
  };
  const executor = createAgentToolExecutor({
    config: { crawler: { maxActionMs: 1000 }, agent: { riskMode: 'business', allowBusinessMutations: true } },
    session: { page },
    context: {
      coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [], forms: [], actions: [] },
      profile: { email: 'person@example.test', searchTerms: ['crystal'] }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'form-validation-repair' },
    plan: { expectedDelta: { actions: 1 } },
    step: { type: 'fill_form', target: { formId: form.id, values: { email: 'profile.email', message: 'profile.searchTerms[0]' } } },
    turn: 1
  });

  assert.equal(result.browserActionRan, true);
  assert.equal(result.toolResult.reason, 'form_fields_filled');
  assert.equal(result.actualDelta.actions, 1);
});

test('submit_form tool timeout is recorded as no progress, not agent failure', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const form = handles.issue({
    type: 'form',
    routeKey: 'http://app.test/',
    policyTier: 'business',
    target: { id: 'feedback', kind: 'feedback', fields: [{ name: 'message', selector: '[name="message"]', type: 'text' }] },
    summary: { id: 'feedback', kind: 'feedback' }
  });
  const executor = createAgentToolExecutor({
    config: { crawler: { maxActionMs: 1000 }, agent: { riskMode: 'business', allowBusinessMutations: true } },
    session: {
      page: {
        url: () => 'http://app.test/'
      }
    },
    context: {
      coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [], forms: [], actions: [] },
      sdkToolAdapter: {
        executeFormHandle: async () => {
          throw new Error('submit form feedback timed out after 1000ms (crawler.maxActionMs)');
        }
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'form-validation-repair' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'submit_form', target: { formId: form.id } },
    turn: 1
  });

  assert.equal(result.status, 'no_progress');
  assert.equal(result.reason, 'tool_timeout');
  assert.equal(result.browserActionRan, false);
  assert.equal(result.transitionValidated, false);
  assert.equal(result.toolResult.status, 'no_progress');
});

test('mutating tool transaction rejects stale handles at execution time', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', routeKey: '/', policyTier: 'safe' });
  handles.invalidateMutatingStep();
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: {
      page: {
        url: () => 'http://app.test/'
      }
    },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      sdkToolAdapter: {
        executeControlHandle: async () => {
          throw new Error('stale handle should not execute');
        }
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-menu-traversal' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'stale_handle');
  assert.equal(result.browserActionRan, false);
  assert.equal(result.actualDelta.routes, 0);
});

test('mutating tool transaction rejects handles whose route no longer matches the live page', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/register',
    policyTier: 'safe',
    target: {
      id: 'register-submit',
      kind: 'button',
      label: 'Submit',
      locatorPlan: { strategy: 'testid', value: 'register-submit' }
    }
  });
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: {
      page: {
        url: () => 'http://app.test/#/wallet',
        async evaluate() {
          throw new Error('stale route handle should not inspect or execute page');
        }
      }
    },
    context: {
      coverage: { routes: [{ url: 'http://app.test/#/wallet' }], endpoints: [] }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'surface-expanded-route' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'not_executable');
  assert.equal(result.reason, 'stale_handle_route_changed');
  assert.equal(result.browserActionRan, false);
  assert.equal(result.actualDelta.routes, 0);
});

test('mutating tool transaction treats SDK endpoint delta as progress even without visual route change', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', routeKey: '/', policyTier: 'safe' });
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: {
      page: {
        url: () => 'http://app.test/'
      }
    },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      sdkToolAdapter: {
        executeControlHandle: async () => ({
          status: 'no_progress',
          reason: 'no_visual_change',
          coverage: { routes: [{ url: '/' }], endpoints: [{ key: 'GET /api/menu' }] },
          transition: { changed: false, noProgress: true, reason: 'no_visual_change' },
          authStatePreserved: true
        })
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-surface-traversal' },
    plan: { expectedDelta: { endpoints: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.transitionValidated, true);
  assert.equal(result.actualDelta.endpoints, 1);
});

test('SDK adapter executes safe route-like button handles without treating them as generic unsafe buttons', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/chatbot',
    policyTier: 'safe',
    target: {
      id: 'profile-button',
      kind: 'click-button',
      label: 'Go to user profile',
      expectedEffect: 'route-change',
      semanticKind: 'navigation',
      locatorPlan: { strategy: 'testid', value: 'profile-button' }
    },
    summary: {
      label: 'Go to user profile',
      expectedEffect: 'route-change',
      semanticKind: 'navigation'
    }
  });
  let currentUrl = 'http://app.test/#/chatbot';
  let actionRan = false;
  const page = {
    url: () => currentUrl,
    async snapshot() {
      return {
        url: currentUrl,
        title: '',
        visibleText: '',
        links: [],
        forms: [],
        actions: []
      };
    },
    async performAction(action) {
      assert.equal(action.id, 'profile-button');
      actionRan = true;
      currentUrl = 'http://app.test/#/profile';
    }
  };
  const executor = createAgentToolExecutor({
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxActionMs: 50, maxObservationMs: 0 },
      agent: { riskMode: 'safe' }
    },
    session: { page },
    context: {
      coverage: { routes: [{ url: 'http://app.test/#/chatbot' }], endpoints: [], forms: [], actions: [] }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'surface-expanded-route' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(actionRan, true);
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(String(result.reason || ''), /Unsafe action refused/);
  assert.equal(result.actualDelta.routes, 1);
  assert.equal(result.liveContext.samePage, true);
});

test('SDK adapter still refuses generic unknown button handles', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/chatbot',
    policyTier: 'safe',
    target: {
      id: 'generic-button',
      kind: 'click-button',
      label: 'Continue',
      locatorPlan: { strategy: 'testid', value: 'generic-button' }
    },
    summary: { label: 'Continue' }
  });
  let actionRan = false;
  const page = {
    url: () => 'http://app.test/#/chatbot',
    async snapshot() {
      return {
        url: 'http://app.test/#/chatbot',
        title: '',
        visibleText: '',
        links: [],
        forms: [],
        actions: []
      };
    },
    async performAction() {
      actionRan = true;
    }
  };
  const executor = createAgentToolExecutor({
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { maxActionMs: 50, maxObservationMs: 0 },
      agent: { riskMode: 'safe' }
    },
    session: { page },
    context: {
      coverage: { routes: [{ url: 'http://app.test/#/chatbot' }], endpoints: [], forms: [], actions: [] }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'surface-expanded-route' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(actionRan, false);
  assert.equal(result.status, 'no_progress');
  assert.match(result.reason, /Unsafe action refused/);
  assert.equal(result.actualDelta.routes, 0);
});

test('failed mutating tool is not completed by action-count-only delta', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const surface = handles.issue({ type: 'surface', routeKey: '/', policyTier: 'safe' });
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: { page: { url: () => 'http://app.test/' } },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [], actions: [] },
      sdkToolAdapter: {
        executeSurfaceHandle: async () => ({
          ok: false,
          status: 'no_progress',
          reason: 'click timed out',
          coverage: { routes: [{ url: '/' }], endpoints: [], actions: [{ id: 'incidental-action' }] },
          transition: { changed: false, noProgress: true, reason: 'click timed out' },
          browserActionRan: true,
          authStatePreserved: true
        })
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-surface-traversal' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'open_surface', target: { surfaceId: surface.id } },
    turn: 1
  });

  assert.equal(result.status, 'no_progress');
  assert.equal(result.transitionValidated, false);
  assert.equal(result.actualDelta.actions, 1);
});

test('validated transition without coverage delta is recorded as no progress', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', routeKey: '/', policyTier: 'safe' });
  const executor = createAgentToolExecutor({
    config: { agent: { riskMode: 'safe' } },
    session: { page: { url: () => 'http://app.test/' } },
    context: {
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      sdkToolAdapter: {
        executeControlHandle: async () => ({
          ok: true,
          status: 'completed',
          reason: 'changed_existing_surface',
          coverage: { routes: [{ url: '/' }], endpoints: [] },
          transition: { changed: true, noProgress: false, reason: 'changed_existing_surface' },
          browserActionRan: true,
          authStatePreserved: true
        })
      }
    },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-surface-traversal' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'click_control', target: { controlId: control.id } },
    turn: 1
  });

  assert.equal(result.transitionValidated, true);
  assert.equal(result.status, 'no_progress');
  assert.equal(result.actualDelta.routes, 0);
});

test('agent live observation refreshes page model instead of reusing stale cache', async () => {
  const snapshots = {
    home: {
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Account',
      links: [],
      forms: [],
      controls: [],
      capturedAt: new Date().toISOString()
    },
    account: {
      url: 'http://app.test/account',
      title: 'Account',
      visibleText: 'Account Orders',
      links: [],
      forms: [],
      controls: [],
      capturedAt: new Date().toISOString()
    }
  };
  const page = {
    state: 'home',
    async evaluate() {
      return snapshots[this.state];
    }
  };
  const executor = createAgentToolExecutor({
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { preserveSpaHashRoutes: true },
      browserProbe: { enabled: false },
      agent: { riskMode: 'safe' }
    },
    session: { page },
    context: { coverage: { routes: [], endpoints: [] } },
    handles: createAgentHandleRegistry({ turn: 1 })
  });

  const first = await executor.observeCrawlerState();
  page.state = 'account';
  const second = await executor.observeCrawlerState();

  assert.equal(first.currentPage.url, 'http://app.test/');
  assert.equal(second.currentPage.url, 'http://app.test/account');
});

test('agent live observation times out page model extraction and returns a bounded fallback', async () => {
  const page = {
    url: () => 'http://app.test/#/slow',
    async evaluate() {
      await new Promise(() => {});
    }
  };
  const context = { coverage: { routes: [], endpoints: [] } };
  const executor = createAgentToolExecutor({
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { preserveSpaHashRoutes: true, maxObservationMs: 20 },
      browserProbe: { enabled: false },
      agent: { riskMode: 'safe', pageModelTimeoutMs: 5 }
    },
    session: { page },
    context,
    handles: createAgentHandleRegistry({ turn: 1 })
  });

  const observed = await executor.observeCrawlerState();

  assert.equal(observed.currentPage.url, 'http://app.test/#/slow');
  assert.match(observed.currentPage.extractionError, /page_model_extraction_timeout/);
  assert.equal(context.agentObservationErrors.length, 1);
});

test('agent typed tool recovers from generic click-blocking backdrop and retries once', async () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const page = {
    clickAttempts: 0,
    __snapshot: {
      url: 'http://app.test/',
      title: 'Home',
      visibleText: 'Home Account',
      links: [],
      forms: [],
      actions: [],
      capturedAt: new Date().toISOString()
    },
    url() {
      return this.__snapshot.url;
    },
    async clickLocator() {
      this.clickAttempts += 1;
      if (this.clickAttempts === 1) {
        throw new Error('<div class="mat-drawer-backdrop"></div> intercepts pointer events');
      }
      this.__snapshot = {
        url: 'http://app.test/#/account',
        title: 'Account',
        visibleText: 'Account Orders',
        links: [],
        forms: [],
        actions: [],
        capturedAt: new Date().toISOString()
      };
    },
    keyboard: {
      async press(key) {
        page.lastKey = key;
      }
    },
    locator() {
      return {
        first() { return this; },
        async click() { page.backdropClicked = true; }
      };
    },
    async evaluate() {
      return { blockerCount: 1, dispatchedEscape: true, clickedBackdrop: true };
    },
    async waitForTimeout() {}
  };
  const surface = handles.issue({
    type: 'surface',
    routeKey: 'http://app.test/',
    policyTier: 'safe',
    target: {
      id: 'account-menu',
      kind: 'open-menu',
      label: 'Account',
      riskTier: 'safe-interaction',
      expectedEffect: 'surface-expansion',
      locatorPlan: { strategy: 'testid', value: 'account-menu' }
    }
  });
  const executor = createAgentToolExecutor({
    config: {
      target: { baseUrl: 'http://app.test/' },
      crawler: { preserveSpaHashRoutes: true, maxActionMs: 1000, maxObservationMs: 10 },
      browserProbe: { enabled: false },
      agent: { riskMode: 'safe' }
    },
    session: { page },
    context: { coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [] } },
    handles
  });

  const result = await executor.executeStep({
    mission: { id: 'm1', kind: 'auth-surface-traversal' },
    plan: { expectedDelta: { routes: 1 } },
    step: { type: 'open_surface', target: { surfaceId: surface.id } },
    turn: 1
  });

  assert.equal(result.status, 'completed');
  assert.equal(page.clickAttempts, 2);
  assert.equal(page.lastKey, 'Escape');
  assert.equal(page.backdropClicked, true);
  assert.equal(result.actualDelta.routes, 1);
  assert.equal(result.toolResult.recoveredRetry, true);
  assert.equal(result.toolResult.recovery.closed, true);
});

test('risk policy keeps aggressive business separate from destructive actions', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  const control = handles.issue({ type: 'control', policyTier: 'destructive' });
  const mission = { id: 'm1', kind: 'auth-menu-traversal' };
  const plan = {
    missionId: 'm1',
    reason: 'try destructive',
    riskModeRequired: 'destructive',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', target: { controlId: control.id } }]
  };

  const aggressiveOnly = validateActionPlan(plan, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'business', allowBusinessMutations: true, allowDestructiveActions: false }
  });
  assert.equal(aggressiveOnly.allowed, false);
  assert.equal(aggressiveOnly.rejectReason, 'unsafe_risk_mode');

  const destructiveAllowed = validateActionPlan(plan, {
    missions: [mission],
    handles,
    turn: 1,
    agentConfig: { maxStepsPerTurn: 1, riskMode: 'destructive', allowBusinessMutations: true, allowDestructiveActions: true }
  });
  assert.equal(destructiveAllowed.allowed, true);
});

test('manager suppresses repeated no-progress live-handle mission across fresh turns', async () => {
  let providerCalls = 0;
  const page = {
    turn: 0,
    url: () => 'http://app.test/#/chatbot',
    async evaluate() {
      return {
        url: 'http://app.test/#/chatbot',
        title: 'Chatbot',
        visibleText: 'Chatbot Account',
        links: [],
        forms: [],
        actions: [{
          id: 'account',
          tagName: 'button',
          role: 'button',
          label: 'Account',
          selector: '#account',
          hasPopup: 'menu',
          expands: true,
          ariaExpanded: 'false',
          semanticKind: 'menu-toggle'
        }],
        capturedAt: new Date().toISOString()
      };
    }
  };
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', maxTurns: 3, maxStepsPerTurn: 1, maxNoProgress: 2 } },
    provider: {
      kind: 'mock',
      chooseMission: async ({ missions }) => {
        providerCalls += 1;
        const mission = missions.find(item => item.kind === 'auth-surface-traversal');
        return {
          missionId: mission && mission.id,
          reason: 'try surface',
          expectedDelta: { routes: 1 },
          allowedCapability: 'mission:plan',
          steps: [{ type: 'open_surface', target: { surfaceId: mission.surfaceHandleId } }]
        };
      }
    },
    context: {
      baselineComplete: true,
      session: { page },
      coverage: { routes: [{ url: 'http://app.test/#/chatbot' }], endpoints: [] },
      sdkToolAdapter: {
        executeSurfaceHandle: async () => ({
          status: 'no_progress',
          reason: 'blocked_once',
          coverage: { routes: [{ url: 'http://app.test/#/chatbot' }], endpoints: [] },
          transition: { changed: false, noProgress: true, reason: 'blocked_once' },
          browserActionRan: true,
          authStatePreserved: true
        })
      }
    }
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.telemetry.stopReason, 'no_executable_missions');
  assert.equal(result.results[0].status, 'no_progress');
  assert.equal(result.missionCompilerSummary.suppressionReasons.already_covered_no_delta >= 1, true);
});

test('manager does not offer policy-denied business form missions in safe mode', async () => {
  let providerCalled = false;
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', maxTurns: 1, maxStepsPerTurn: 1, riskMode: 'safe' } },
    provider: {
      kind: 'mock',
      chooseMission: async () => {
        providerCalled = true;
        return null;
      }
    },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/#/feedback' } },
      coverage: { routes: [{ url: 'http://app.test/#/feedback' }], endpoints: [] },
      currentPageModel: {
        url: 'http://app.test/#/feedback',
        routeShape: 'http://app.test/#/feedback',
        stateKey: 'feedback',
        actions: [],
        forms: [{
          id: 'feedback',
          kind: 'feedback',
          fields: [{ name: 'message', required: true }],
          validation: { message: 'required' }
        }],
        links: []
      }
    }
  });

  assert.equal(providerCalled, false);
  assert.equal(result.status, 'no_executable_missions');
  assert.equal(result.missionCompilerSummary.suppressionReasons.policy_denied >= 1, true);
});

test('multi-turn mock manager executes more than one route mission in the same session', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 2, maxStepsPerTurn: 1 } },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/' } },
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      missionCandidates: [
        { id: 'm1', kind: 'hidden-route-verification', route: '/orders', priority: 100 },
        { id: 'm2', kind: 'hidden-route-verification', route: '/wallet', priority: 90 }
      ]
    },
    handlers: {
      'hidden-route-verification': (mission) => ({
        status: 'completed',
        coverage: { routes: [{ url: '/' }, { url: mission.route }], endpoints: [{ key: `GET /api${mission.route}` }] },
        transition: { changed: true, noProgress: false, reason: 'test-route' }
      })
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, 2);
  assert.equal(result.turns.length, 2);
  assert.equal(result.coverageDelta.total.routes, 2);
  assert.equal(result.baselinePreservation.agentFailureAffectedBaseline, false);
});

test('mock provider proves same-session UI execution from fresh live handles', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1, maxStepsPerTurn: 1 } },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/account' } },
      coverage: { routes: [{ url: '/account' }], endpoints: [] },
      currentPageModel: {
        url: '/account',
        routeShape: '/account',
        stateKey: 'account-open',
        actions: [{
          id: 'orders-control',
          kind: 'click-link',
          label: 'Orders',
          href: '/orders',
          riskTier: 'safe-interaction',
          expectedEffect: 'route-change',
          source: 'pageModel'
        }],
        forms: [],
        links: []
      },
      sdkToolAdapter: {
        executeControlHandle: async ({ handle }) => ({
          status: 'completed',
          coverage: {
            routes: [{ url: '/account' }, { url: '/orders' }],
            endpoints: [{ key: 'GET /api/orders', method: 'GET', path: '/api/orders' }]
          },
          transition: { changed: true, noProgress: false, reason: `clicked:${handle.id}` },
          authStatePreserved: true
        })
      },
      missionCandidates: [
        { id: 'auth-surface', kind: 'auth-surface-traversal', priority: 100, allowedCapabilities: ['control.click', 'mission:plan'] }
      ]
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].executed, true);
  assert.equal(result.results[0].actualDelta.routes, 1);
  assert.equal(result.results[0].actualDelta.endpoints, 1);
  assert.equal(result.executionResults[0].liveContext.samePage, true);
  assert.equal(result.executionResults[0].liveContext.authStatePreserved, true);
  assert.equal(result.choices[0].steps[0].type, 'click_control');
});

test('agent can open authenticated surface then click nested business route through typed handles', async () => {
  let surfaceOpen = false;
  let currentUrl = 'http://app.test/#/account';
  const chosenStepTypes = [];
  const clickedLabels = [];

  const page = {
    url: () => currentUrl
  };

  function pageModelForState() {
    if (!surfaceOpen) {
      return {
        url: currentUrl,
        routeShape: currentUrl,
        stateKey: 'account-closed',
        surfaceType: 'account',
        authSignals: ['authenticated account surface'],
        actions: [{
          id: 'account-menu',
          kind: 'click-button',
          label: 'Account',
          riskTier: 'safe-interaction',
          expectedEffect: 'surface-expansion',
          semanticKind: 'menu-toggle',
          source: 'pageModel'
        }],
        newlyDiscoveredControls: [],
        forms: [],
        links: []
      };
    }
    return {
      url: currentUrl,
      routeShape: currentUrl,
      stateKey: 'account-open',
      surfaceType: 'account',
      authSignals: ['authenticated account surface'],
      actions: [{
        id: 'orders-control',
        kind: 'click-link',
        label: 'Orders',
        href: 'http://app.test/#/order-history',
        riskTier: 'safe-interaction',
        expectedEffect: 'route-change',
        semanticKind: 'route-control',
        source: 'pageModel'
      }],
      newlyDiscoveredControls: [],
      forms: [],
      links: []
    };
  }

  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', maxTurns: 2, maxStepsPerTurn: 1, maxNoProgress: 3 } },
    provider: {
      kind: 'mock',
      chooseMission: async context => {
        const surfaceMission = context.missions.find(mission => mission.surfaceHandleId);
        if (surfaceMission) {
          chosenStepTypes.push('open_surface');
          return {
            missionId: surfaceMission.id,
            reason: 'open authenticated account surface',
            provider: 'mock',
            expectedDelta: { actions: 1 },
            allowedCapability: 'mission:plan',
            riskModeRequired: 'safe',
            steps: [{ type: 'open_surface', target: { surfaceId: surfaceMission.surfaceHandleId } }]
          };
        }
        const controlMission = context.missions.find(mission => mission.controlHandleId);
        chosenStepTypes.push('click_control');
        return {
          missionId: controlMission.id,
          reason: 'click nested safe order history control',
          provider: 'mock',
          expectedDelta: { routes: 1, endpoints: 1 },
          allowedCapability: 'mission:plan',
          riskModeRequired: 'safe',
          steps: [{ type: 'click_control', target: { controlId: controlMission.controlHandleId } }]
        };
      }
    },
    context: {
      baselineComplete: true,
      session: { page },
      coverage: { routes: [{ url: currentUrl }], endpoints: [], forms: [], actions: [] },
      sdkToolAdapter: {
        observe: async ({ handles, turn, context, config }) => {
          const pageModel = pageModelForState();
          issuePageModelHandles({ handles, pageModel, coverage: context.coverage, config, turn });
          if (!surfaceOpen) {
            const hasSurface = handles.all().some(handle => handle.type === 'surface');
            if (!hasSurface) {
              handles.issue({
                type: 'surface',
                routeKey: pageModel.url,
                stateKey: pageModel.stateKey,
                source: 'surfaceExplorer',
                policyTier: 'safe',
                target: pageModel.actions[0],
                summary: {
                  id: 'account-menu',
                  label: 'Account',
                  semanticKind: 'menu-toggle',
                  expectedEffect: 'surface-expansion'
                }
              });
            }
          }
          return {
            currentPage: {
              url: pageModel.url,
              routeShape: pageModel.routeShape,
              stateKey: pageModel.stateKey,
              authSignals: pageModel.authSignals
            },
            coverage: context.coverage,
            handles: handles.snapshot()
          };
        },
        executeSurfaceHandle: async ({ handle }) => {
          assert.equal(handle.type, 'surface');
          surfaceOpen = true;
          return {
            status: 'completed',
            coverage: { routes: [{ url: currentUrl }], endpoints: [], forms: [], actions: [{ id: handle.id, label: 'Account' }] },
            transition: { changed: true, noProgress: false, reason: 'surface-opened' },
            browserActionRan: true,
            authStatePreserved: true
          };
        },
        executeControlHandle: async ({ handle }) => {
          assert.equal(handle.type, 'control');
          assert.equal(handle.summary.label, 'Orders');
          clickedLabels.push(handle.summary.label);
          currentUrl = 'http://app.test/#/order-history';
          return {
            status: 'completed',
            coverage: {
              routes: [{ url: 'http://app.test/#/account' }, { url: currentUrl }],
              endpoints: [{ key: 'GET /api/orders', method: 'GET', path: '/api/orders' }],
              forms: [],
              actions: [{ id: handle.id, label: 'Orders' }]
            },
            transition: { changed: true, noProgress: false, reason: 'nested-business-route-clicked' },
            browserActionRan: true,
            authStatePreserved: true
          };
        }
      }
    }
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(chosenStepTypes, ['open_surface', 'click_control']);
  assert.equal(result.choices.some(choice => choice.steps && choice.steps[0] && choice.steps[0].type === 'visit_route'), false);
  assert.deepEqual(clickedLabels, ['Orders']);
  assert.equal(result.executionResults.length, 2);
  assert.equal(result.executionResults[0].liveContext.samePage, true);
  assert.equal(result.executionResults[1].liveContext.samePage, true);
  assert.equal(result.executionResults[1].actualDelta.routes, 1);
  assert.equal(result.executionResults[1].actualDelta.endpoints, 1);
  assert.equal(result.executionResults[1].authStatePreserved, true);
  assert.equal(result.businessLogicSummary.authenticatedSurfacesAttempted, 1);
  assert.equal(result.businessLogicSummary.controlsClicked, 1);
  assert.equal(result.businessLogicSummary.safeActionsExecuted, 2);
  assert.equal(Object.values(result.businessLogicSummary.executionMissionKinds).reduce((sum, value) => sum + value, 0), 2);
});

test('manager suppresses low-value deterministic tail and already visited route missions', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1 } },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/' } },
      coverage: { routes: [{ url: '/visited' }], endpoints: [] },
      missionCandidates: [
        { id: 'tail', kind: 'broad-coverage-tail', priority: 100 },
        { id: 'visited', kind: 'hidden-route-verification', route: '/visited', priority: 90 }
      ]
    }
  });

  assert.equal(result.status, 'no_executable_missions');
  assert.equal(result.choices.length, 0);
});

test('no-scenario mode skips provider when only weak endpoint missions exist', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1 } },
    provider: {
      kind: 'mock',
      chooseMission: async () => {
        throw new Error('provider should not be called');
      }
    },
    context: {
      baselineComplete: true,
      noScenarioMode: true,
      coverage: { routes: [{ url: '/' }], endpoints: [] },
      missionCandidates: [
        {
          id: 'weak-endpoint',
          kind: 'endpoint-backed-ui-flow',
          endpoint: { method: 'GET', path: '/api/unknown' },
          priority: 100
        }
      ]
    }
  });

  assert.equal(result.status, 'no_executable_missions');
  assert.equal(result.telemetry.stopReason, 'no_high_confidence_executable_missions');
  assert.equal(result.choices.length, 0);
  assert.equal(result.missionCompilerSummary.suppressionReasons.endpoint_without_ui_path, 1);
});

test('manager suppresses endpoint missions whose UI route is already covered', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1 } },
    provider: {
      kind: 'mock',
      chooseMission: async () => {
        throw new Error('provider should not be called');
      }
    },
    context: {
      baselineComplete: true,
      coverage: {
        routes: [{ url: 'http://app.test/#/contact' }],
        endpoints: [{
          key: 'GET /api/challenges',
          method: 'GET',
          path: '/api/challenges',
          resourceType: 'xhr',
          source: 'response',
          routeUrl: 'http://app.test/#/contact'
        }]
      },
      scenarioVariant: 'no-scenario'
    }
  });

  assert.equal(result.status, 'no_executable_missions');
  assert.equal(result.choices.length, 0);
  assert.equal(result.missionCompilerSummary.suppressionReasons.already_covered_no_delta >= 1, true);
});
