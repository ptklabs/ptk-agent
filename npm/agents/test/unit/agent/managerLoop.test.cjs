'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CodexProvider,
  MAX_PROVIDER_OUTPUT_CHARS,
  appendBoundedProviderOutput,
  buildOpencodeArgs,
  buildOpencodeEnvironment,
  buildMissionPrompt,
  classifyOpencodeFailure,
  classifyOpencodeWarnings,
  choiceFromOpencodeResult,
  compileMissionCandidates,
  compileMissions,
  createAgentRunMemory,
  createMockProvider,
  executeMission,
  parseProviderChoice,
  selectPromptMissions,
  recordActionEffect,
  validateProviderDecision,
  runAgentManagerV2
} = require('../../../src/agent/index.cjs');
const { finalStatusAfterProviderFailure, finalStatusAfterLoop, resolveChoiceMissionAlias, resolveTurnMissions } = require('../../../src/agent/managerLoop.cjs');
const { createAgentHandleRegistry } = require('../../../src/agent/handles.cjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('mission compiler prioritizes scenario gaps, route hints, app endpoints, GraphQL, and hidden params', () => {
  const missions = compileMissionCandidates({
    baselineComplete: true,
    coverage: {
      gaps: ['/admin'],
      routes: [{ url: '/' }],
      endpoints: [
        { key: 'GET /assets/app.js', method: 'GET', path: '/assets/app.js', resourceType: 'script' },
        { key: 'GET /api/products', method: 'GET', path: '/api/products', resourceType: 'fetch', routeUrl: '/products' },
        { key: 'POST /graphql Products', method: 'POST', path: '/graphql', resourceType: 'fetch', graphqlOperationName: 'Products' }
      ]
    },
    scenarioStatus: {
      blockedSteps: [{ stepId: 'login', label: 'Sign in user' }]
    },
    evidence: {
      routeHints: [
        { kind: 'route', url: '/account', coverage: { status: 'pending' } },
        { kind: 'route', url: '/static/theme.css', coverage: { status: 'pending' } },
        { kind: 'hidden-param', path: '/api/products', paramNames: ['debug'] }
      ],
      hiddenParams: [{ name: 'coupon', location: 'query', endpoint: { method: 'GET', path: '/api/products' } }]
    }
  });

  assert.equal(missions[0].kind, 'auth-flow');
  assert.equal(missions[1].kind, 'hidden-route-verification');
  assert.equal(missions.some(mission => mission.kind === 'graphql-operation-flow'), true);
  assert.equal(missions.some(mission => mission.kind === 'endpoint-backed-ui-flow' && /api\/products/.test(mission.id)), true);
  assert.equal(missions.some(mission => mission.kind === 'hidden-param-flow'), true);
  assert.equal(missions.some(mission => /assets\/app|theme\.css/.test(mission.id)), false);
  assert.equal(missions[0].id, compileMissionCandidates({
    baselineComplete: true,
    coverage: { gaps: ['/admin'] },
    scenarioStatus: { blockedSteps: [{ stepId: 'login', label: 'Sign in user' }] }
  })[0].id);
});

test('mission compiler promotes PTK finding entrypoints, auth surface gaps, and historical form repair work', () => {
  const missions = compileMissionCandidates({
    baselineComplete: true,
    coverage: {
      routes: [{ url: '/' }, { url: '/account', delta: false }],
      authSurfaceSummary: {
        menuActions: [
          { label: 'Orders', routeUrl: '/account/orders', reason: 'surface_reopen_failed' },
          { label: 'Logout', routeUrl: '/logout', reason: 'surface_reopen_failed' }
        ]
      },
      forms: [
        {
          id: 'feedback',
          kind: 'feedback',
          routeUrl: '/contact',
          validation: { message: 'required field missing' },
          fields: [{ name: 'comment' }]
        }
      ]
    },
    evidence: {
      ptkSignals: {
        findings: [
          {
            engine: 'DAST',
            ruleId: 'sql-injection',
            title: 'SQL Injection',
            severity: 'high',
            confidence: 'confirmed',
            location: { runtimeUrl: '/login' },
            parameter: 'email'
          },
          {
            engine: 'DAST',
            ruleId: 'jwt_3',
            title: 'JWT None Algorithm',
            severity: 'high',
            confidence: 'confirmed',
            location: { runtimeUrl: '/rest/basket/6' },
            parameter: 'Authorization'
          }
        ]
      }
    }
  });

  assert.equal(missions.some(mission => mission.kind === 'ptk-finding-entrypoint-reproduction' && mission.route === '/login'), true);
  assert.equal(missions.some(mission => mission.kind === 'ptk-finding-entrypoint-reproduction' && mission.route === '/rest/basket/6'), false);
  assert.equal(missions.some(mission => mission.kind === 'auth-surface-traversal' && mission.route === '/account/orders'), true);
  assert.equal(missions.some(mission => /logout/.test(mission.id)), false);
  assert.equal(missions.some(mission => mission.kind === 'form-validation-repair' && mission.route === '/contact'), true);
});

test('mission compiler derives auth surface route targets from generic router links', () => {
  const missions = compileMissionCandidates({
    baselineComplete: true,
    coverage: {
      authSurfaceSummary: {
        menuActions: [
          {
            routeUrl: 'http://localhost:3001/#/',
            actionId: 'button[routerlink="\\/saved-payment-methods"]',
            selector: 'button[routerlink="\\/saved-payment-methods"]',
            label: 'safe account route',
            reason: 'surface_explorer_budget_exhausted'
          },
          {
            routeUrl: 'http://localhost:3001/#/',
            actionId: 'div:nth-of-type(3) > button',
            label: 'opaque expansion',
            reason: 'surface_explorer_budget_exhausted'
          }
        ]
      }
    }
  });

  assert.equal(missions.some(mission => mission.kind === 'auth-surface-traversal' && mission.route === 'http://localhost:3001/#/saved-payment-methods'), true);
  assert.equal(missions.some(mission => mission.kind === 'auth-surface-traversal' && mission.route === 'http://localhost:3001/#/'), false);
});

test('mission compiler suppresses historical forms without repair evidence', () => {
  const missions = compileMissionCandidates({
    baselineComplete: true,
    coverage: {
      forms: [
        { id: 'newsletter', routeUrl: '/newsletter', fields: [{ name: 'email' }] },
        { id: 'feedback', routeUrl: '/contact', validation: { message: 'required field missing' }, fields: [{ name: 'comment' }] }
      ]
    }
  });

  assert.equal(missions.some(mission => /newsletter/.test(mission.id)), false);
  assert.equal(missions.some(mission => mission.kind === 'form-validation-repair' && mission.route === '/contact'), true);
});

test('mission compiler suppresses historical file-upload form repair without fixture intent', () => {
  const missions = compileMissionCandidates({
    baselineComplete: true,
    coverage: {
      forms: [
        {
          id: 'complaint-form',
          kind: 'file-upload',
          routeUrl: '/complain',
          validation: { message: 'attachment required' },
          fields: [
            { name: 'message', type: 'textarea' },
            { name: 'attachment', type: 'file' }
          ]
        }
      ]
    }
  });

  assert.equal(missions.some(mission => /complain|complaint-form|file-upload/.test(mission.id)), false);
});

test('no-scenario provider can run when high-confidence PTK finding entrypoint mission exists', async () => {
  const choices = [];
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async context => {
        choices.push(context.missions.map(mission => mission.kind));
        const mission = context.missions.find(candidate => candidate.kind === 'ptk-finding-entrypoint-reproduction');
        return {
          missionId: mission.id,
          reason: 'revisit PTK finding entrypoint in same session',
          provider: 'codex',
          expectedDelta: { routes: 1 },
          allowedCapability: 'mission:plan',
          riskModeRequired: 'safe'
        };
      }
    },
    context: {
      baselineComplete: true,
      noScenarioMode: true,
      session: { page: { url: () => 'http://app.test/' } }
    },
    coverage: { routes: [{ url: '/' }], endpoints: [] },
    evidence: {
      ptkSignals: {
        findings: [
          {
            engine: 'DAST',
            ruleId: 'xss',
            title: 'XSS',
            severity: 'high',
            location: { runtimeUrl: '/search' },
            parameter: 'q'
          }
        ]
      }
    },
    handlers: {
      'ptk-finding-entrypoint-reproduction': (mission) => ({
        status: 'completed',
        coverage: { routes: [{ url: '/' }, { url: mission.route }], endpoints: [{ key: 'GET /api/search', path: '/api/search' }] },
        transition: { changed: true, noProgress: false, reason: 'finding-entrypoint-revisited' }
      })
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(choices.length, 1);
  assert.ok(choices[0].includes('ptk-finding-entrypoint-reproduction'));
  assert.equal(result.results[0].kind, 'ptk-finding-entrypoint-reproduction');
  assert.equal(result.results[0].actualDelta.routes, 1);
});

test('no-scenario provider can still run PTK finding entrypoint mission when route was already visited', async () => {
  let offered = [];
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async context => {
        offered = context.missions.map(mission => mission.kind);
        const mission = context.missions.find(candidate => candidate.kind === 'ptk-finding-entrypoint-reproduction');
        return {
          missionId: mission.id,
          reason: 'revisit finding entrypoint for non-route evidence delta',
          provider: 'codex',
          expectedDelta: { endpoints: 1 },
          allowedCapability: 'mission:plan',
          riskModeRequired: 'safe'
        };
      }
    },
    context: {
      baselineComplete: true,
      noScenarioMode: true,
      session: { page: { url: () => 'http://app.test/search' } }
    },
    coverage: { routes: [{ url: '/' }, { url: '/search' }], endpoints: [] },
    evidence: {
      ptkSignals: {
        findings: [
          {
            engine: 'IAST',
            ruleId: 'dom-xss',
            title: 'DOM XSS',
            severity: 'high',
            location: { runtimeUrl: '/search' },
            parameter: 'q'
          }
        ]
      }
    },
    handlers: {
      'ptk-finding-entrypoint-reproduction': (mission) => ({
        status: 'completed',
        coverage: {
          routes: [{ url: '/' }, { url: mission.route }],
          endpoints: [{ key: 'GET /rest/products/search', path: '/rest/products/search' }]
        },
        transition: { changed: true, noProgress: false, reason: 'finding-entrypoint-replayed' }
      })
    }
  });

  assert.equal(result.status, 'completed');
  assert.ok(offered.includes('ptk-finding-entrypoint-reproduction'));
  assert.equal(result.results[0].actualDelta.routes, 0);
  assert.equal(result.results[0].actualDelta.endpoints, 1);
});

test('no-scenario mission compiler suppresses account-creation form repair as not high confidence', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'form',
    routeKey: 'http://app.test/#/register',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      id: 'register',
      kind: 'login',
      fieldCount: 3,
      fieldNames: ['email', 'password', 'repeatPassword'],
      validation: { message: 'required fields missing' }
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: { routes: [{ url: 'http://app.test/#/register' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/#/register' } },
    agentConfig: { riskMode: 'safe', allowBusinessMutations: false }
  });

  assert.equal(resolution.missions.length, 0);
  assert.equal(resolution.skipReason, 'no_high_confidence_executable_missions');
  assert.equal(resolution.summary.suppressionReasons.account_creation_not_high_confidence, 1);
});

test('mission compiler can still offer executable non-account form repair handles', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'form',
    routeKey: 'http://app.test/#/contact',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      id: 'feedback',
      kind: 'feedback',
      fieldCount: 2,
      fieldNames: ['comment', 'rating'],
      validation: { message: 'comment is required' }
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: { routes: [{ url: 'http://app.test/#/contact' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/#/contact' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.skipReason, null);
  assert.equal(resolution.missions.some(mission => mission.kind === 'form-validation-repair'), true);
});

test('mission compiler suppresses generic live forms without repair signal', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'form',
    routeKey: 'http://app.test/',
    source: 'pageModel',
    policyTier: 'business',
    summary: {
      id: 'form:1',
      kind: 'generic',
      fieldCount: 2
    },
    target: {
      id: 'form:1',
      kind: 'generic',
      fields: [
        { name: 'foo', type: 'text' },
        { name: 'bar', type: 'text' }
      ]
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true },
    coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(resolution.missions.some(mission => mission.formHandleId), false);
  assert.equal(resolution.summary.suppressionReasons.generic_form_without_repair_signal, 1);
});

test('mission compiler ignores empty validation metadata on generic forms', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'form',
    routeKey: 'http://app.test/',
    source: 'pageModel',
    policyTier: 'business',
    summary: {
      id: 'form:1',
      kind: 'generic',
      fieldCount: 2,
      validation: {},
      errors: []
    },
    target: {
      id: 'form:1',
      kind: 'generic',
      validation: {},
      errors: [],
      fields: [
        { name: 'foo', type: 'text' },
        { name: 'bar', type: 'text' }
      ]
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true },
    coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(resolution.missions.some(mission => mission.formHandleId), false);
  assert.equal(resolution.summary.suppressionReasons.generic_form_without_repair_signal, 1);
});

test('mission compiler suppresses file-upload form repair unless explicitly fixture-backed', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'form',
    routeKey: 'http://app.test/#/complain',
    source: 'pageModel',
    policyTier: 'business',
    summary: {
      id: 'complaint-form',
      kind: 'file-upload',
      semanticKind: 'file-upload',
      fieldCount: 3,
      fieldNames: ['email', 'message', 'attachment'],
      fields: [
        { name: 'email', type: 'email' },
        { name: 'message', type: 'textarea' },
        { name: 'attachment', type: 'file' }
      ],
      validation: { message: 'attachment is required' }
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, scenarioVariant: 'explicit' },
    coverage: { routes: [{ url: 'http://app.test/#/complain' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/#/complain' } },
    agentConfig: { riskMode: 'business', allowBusinessMutations: true }
  });

  assert.equal(resolution.missions.some(mission => mission.kind === 'form-validation-repair'), false);
  assert.equal(resolution.summary.suppressionReasons.upload_fixture_required, 1);
});

test('no-scenario provider skips generic live controls without high-confidence intent', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'control',
    routeKey: 'http://app.test/',
    source: 'dom',
    policyTier: 'safe',
    summary: {
      kind: 'click',
      expectedEffect: 'link'
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.missions.length, 0);
  assert.equal(resolution.skipReason, 'no_high_confidence_executable_missions');
  assert.equal(resolution.summary.suppressionReasons.no_scenario_gating, 1);
});

test('no-scenario provider can run high-confidence account navigation controls', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'control',
    routeKey: 'http://app.test/',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      kind: 'button',
      semanticKind: 'account-menu',
      label: 'Account',
      expectedEffect: 'menu'
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: { routes: [{ url: 'http://app.test/' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.skipReason, null);
  assert.equal(resolution.missions.some(mission => mission.kind === 'surface-expanded-route'), true);
});

test('mission resolver suppresses endpoint, GraphQL, and hidden-param missions without executable UI paths', () => {
  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: {
      routes: [{ url: 'http://app.test/' }],
      endpoints: [
        { key: 'GET /api/orders', method: 'GET', path: '/api/orders', resourceType: 'fetch' },
        { key: 'POST /graphql Products', method: 'POST', path: '/graphql', resourceType: 'fetch', graphqlOperationName: 'Products' }
      ]
    },
    evidence: {
      routeHints: [
        { kind: 'hidden-param', path: '/api/orders', paramNames: ['debug'] }
      ]
    },
    handles: createAgentHandleRegistry({ turn: 1 }),
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.missions.length, 0);
  assert.equal(resolution.skipReason, 'no_high_confidence_executable_missions');
  assert.equal(resolution.summary.suppressionReasons.endpoint_without_ui_path, 2);
  assert.equal(resolution.summary.suppressionReasons.intent_only_without_executor, 1);
});

test('mission resolver allows endpoint-backed UI flow only when a concrete UI path exists', () => {
  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: {
      routes: [{ url: 'http://app.test/' }],
      endpoints: [
        {
          key: 'GET /api/orders',
          method: 'GET',
          path: '/api/orders',
          resourceType: 'fetch',
          routeUrl: 'http://app.test/#/orders'
        }
      ]
    },
    handles: createAgentHandleRegistry({ turn: 1 }),
    observation: { currentPage: { url: 'http://app.test/' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.skipReason, null);
  assert.equal(resolution.missions.some(mission => mission.kind === 'endpoint-backed-ui-flow'), true);
});

test('mission compiler suppresses off-origin live control links', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      kind: 'link',
      label: 'External support video',
      href: 'https://video.example.test/watch',
      expectedEffect: 'link'
    }
  });
  handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      kind: 'link',
      label: 'Orders',
      href: 'http://app.test/#/orders',
      expectedEffect: 'link'
    }
  });

  const resolution = resolveTurnMissions({
    context: { baselineComplete: true, noScenarioMode: true },
    coverage: { routes: [{ url: 'http://app.test/#/' }], endpoints: [] },
    handles,
    observation: { currentPage: { url: 'http://app.test/#/' } },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(resolution.skipReason, null);
  assert.equal(resolution.missions.some(mission => /External support video/.test(JSON.stringify(mission))), false);
  assert.equal(resolution.missions.some(mission => /Orders/.test(JSON.stringify(mission))), true);
});

test('provider prompt includes bounded evidence summary without raw secret values', () => {
  const prompt = buildMissionPrompt({
    coverage: {
      ptk: { validity: { findingsValid: true, findingsCount: 1 } },
      authSurfaceSummary: {
        authenticatedSurfacesOpened: 1,
        menuActions: [{ label: 'Orders', routeUrl: '/orders', reason: 'surface_reopen_failed' }]
      },
      forms: [{ id: 'login', kind: 'login', routeUrl: '/login', fields: [{ name: 'password', value: 'YOUR_PASSWORD' }] }]
    },
    evidence: {
      ptkSignals: {
        findings: [{
          engine: 'DAST',
          title: 'SQL Injection',
          severity: 'high',
          location: { runtimeUrl: '/login?password=YOUR_PASSWORD' },
          parameter: 'email'
        }]
      }
    },
    missions: [{ id: 'mission:ptk-finding-entrypoint:/login', kind: 'ptk-finding-entrypoint-reproduction', route: '/login', priority: 100 }]
  });

  assert.match(prompt, /evidenceSummary/);
  assert.match(prompt, /SQL Injection/);
  assert.match(prompt, /authSurface/);
  assert.match(prompt, /analyze the current website state/);
  assert.match(prompt, /crawl-improving browser action/);
  assert.match(prompt, /business-flow crawler/);
  assert.match(prompt, /Prefer fresh live surface\/control\/form handles over route replay/);
  assert.match(prompt, /what website gap you are trying to unlock/);
  assert.doesNotMatch(prompt, /YOUR_PASSWORD/);
});

test('provider prompt is compact and only includes handles relevant to offered missions', () => {
  const handles = [];
  for (let index = 0; index < 60; index += 1) {
    handles.push({
      id: `ctrl_1_${index}`,
      type: 'control',
      routeKey: '/noise',
      source: 'pageModel',
      createdAtTurn: 1,
      expiresAfterTurn: 1,
      policyTier: 'safe',
      summary: { label: `noisy generic button ${index}` }
    });
  }
  handles.push({
    id: 'surface_1_account',
    type: 'surface',
    routeKey: '/account',
    source: 'surfaceExplorer',
    createdAtTurn: 1,
    expiresAfterTurn: 1,
    policyTier: 'safe',
    summary: { label: 'Account menu' }
  });
  handles.push({
    id: 'route_1_orders',
    type: 'route',
    routeKey: '/orders',
    source: 'missionCompiler',
    createdAtTurn: 1,
    expiresAfterTurn: 1,
    policyTier: 'safe',
    summary: { missionId: 'mission:orders', missionKind: 'auth-surface-traversal' }
  });
  const prompt = buildMissionPrompt({
    handles,
    missions: [
      { id: 'mission:orders', kind: 'auth-surface-traversal', priority: 120, route: '/orders', reason: 'account menu route', surfaceHandleId: 'surface_1_account' },
      { id: 'mission:noise', kind: 'broad-coverage-tail', priority: 1, reason: 'low value' }
    ]
  });

  assert.match(prompt, /route_1_orders/);
  assert.match(prompt, /surface_1_account/);
  assert.doesNotMatch(prompt, /ctrl_1_59/);
});

test('provider prompt does not expose non-owned live controls even when same-route missions exist', () => {
  const prompt = buildMissionPrompt({
    handles: [
      {
        id: 'ctrl_2_account_toggle',
        type: 'control',
        routeKey: 'http://app.test/#/',
        source: 'pageModel',
        createdAtTurn: 2,
        expiresAfterTurn: 2,
        policyTier: 'safe',
        summary: { label: 'Show/hide account menu', kind: 'open-menu' }
      },
      {
        id: 'route_2_orders',
        type: 'route',
        routeKey: 'http://app.test/#/orders',
        source: 'missionCompiler',
        createdAtTurn: 2,
        expiresAfterTurn: 2,
        policyTier: 'safe',
        summary: { missionId: 'mission:orders', missionKind: 'auth-surface-traversal' }
      }
    ],
    missions: [
      { id: 'mission:orders', kind: 'auth-surface-traversal', priority: 136, route: 'http://app.test/#/orders', reason: 'account menu route' },
      { id: 'mission:home-gap', kind: 'surface-expanded-route', priority: 120, route: 'http://app.test/#/', reason: 'same route business gap' }
    ]
  });

  assert.match(prompt, /route_2_orders/);
  assert.doesNotMatch(prompt, /ctrl_2_account_toggle/);
  assert.doesNotMatch(prompt, /Show\/hide account menu/);
});

test('provider prompt does not expose unrelated route handles', () => {
  const prompt = buildMissionPrompt({
    handles: [
      {
        id: 'route_1_change_password',
        type: 'route',
        routeKey: 'http://app.test/#/privacy-security/change-password',
        source: 'routeGraph',
        createdAtTurn: 1,
        expiresAfterTurn: 1,
        policyTier: 'safe',
        summary: { url: 'http://app.test/#/privacy-security/change-password', routeShape: 'http://app.test/#/privacy-security/change-password' }
      },
      {
        id: 'route_1_orders',
        type: 'route',
        routeKey: 'http://app.test/#/orders',
        source: 'missionCompiler',
        createdAtTurn: 1,
        expiresAfterTurn: 1,
        policyTier: 'safe',
        summary: { missionId: 'mission:orders', missionKind: 'auth-surface-traversal' }
      }
    ],
    missions: [
      { id: 'mission:orders', kind: 'auth-surface-traversal', priority: 120, route: 'http://app.test/#/orders', reason: 'account menu route' }
    ]
  });

  assert.match(prompt, /route_1_orders/);
  assert.doesNotMatch(prompt, /route_1_change_password/);
  assert.doesNotMatch(prompt, /change-password/);
});

test('provider prompt does not expose raw page-model form refs as executable targets', () => {
  const prompt = buildMissionPrompt({
    handles: [
      {
        id: 'form_3_profile',
        type: 'form',
        routeKey: 'http://app.test/#/profile',
        source: 'pageModel',
        createdAtTurn: 3,
        expiresAfterTurn: 3,
        policyTier: 'business',
        summary: { id: 'form:1', kind: 'profile', fieldCount: 1 }
      }
    ],
    missions: [
      {
        id: 'mission:form-validation-repair:profile',
        kind: 'form-validation-repair',
        priority: 144,
        route: 'http://app.test/#/profile',
        formHandleId: 'form_3_profile',
        liveHandleSummary: { id: 'form:1', kind: 'profile', fieldCount: 1 }
      }
    ]
  });

  assert.match(prompt, /form_3_profile/);
  assert.doesNotMatch(prompt, /form:1/);
});

test('provider prompt mission selector diversifies business, form, PTK, and endpoint work', () => {
  const missions = [
    { id: 'ptk-1', kind: 'ptk-finding-entrypoint-reproduction', priority: 130, route: '/search' },
    { id: 'ptk-2', kind: 'ptk-finding-entrypoint-reproduction', priority: 130, route: '/login' },
    { id: 'ptk-3', kind: 'ptk-finding-entrypoint-reproduction', priority: 130, route: '/profile' },
    { id: 'surface-1', kind: 'auth-surface-traversal', priority: 136, route: '/account', surfaceHandleId: 'surface_1' },
    { id: 'form-1', kind: 'form-validation-repair', priority: 144, route: '/contact', formHandleId: 'form_1' },
    { id: 'endpoint-1', kind: 'endpoint-backed-ui-flow', priority: 90, endpoint: { path: '/api/orders', routeUrl: '/orders' } }
  ];

  const selected = selectPromptMissions(missions, 5);

  assert.deepEqual(selected.map(mission => mission.id), [
    'surface-1',
    'form-1',
    'ptk-1',
    'endpoint-1',
    'ptk-2'
  ]);
});

test('turn mission resolver keeps covered auth-surface budget gaps for non-route delta', () => {
  const result = resolveTurnMissions({
    context: { scenarioVariant: 'no-scenario' },
    coverage: {
      routes: [
        { url: 'http://localhost:3001/#/saved-payment-methods', routeShape: 'http://localhost:3001/#/saved-payment-methods' }
      ],
      authSurfaceSummary: {
        menuActions: [
          {
            label: 'Go to saved payment methods page',
            actionId: 'button[routerlink="\\/saved-payment-methods"]',
            routeUrl: 'http://localhost:3001/#/',
            reason: 'surface_explorer_budget_exhausted'
          }
        ]
      }
    }
  });

  assert.equal(result.skipReason, null);
  assert.equal(result.missions.length, 1);
  assert.equal(result.missions[0].kind, 'auth-surface-traversal');
  assert.equal(result.missions[0].allowCoveredRouteReplay, true);
});

test('manager suppresses historical auth surface routes that baseline already covered', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async () => {
        throw new Error('provider should not be called for a covered historical auth-surface mission');
      }
    },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/#/orders' } },
      missionCandidates: [{
        id: 'mission:auth-surface-gap:orders',
        kind: 'auth-surface-traversal',
        source: 'auth-surface-summary',
        priority: 124,
        route: 'http://app.test/#/orders',
        reason: 'historical auth menu action was skipped'
      }]
    },
    coverage: {
      routes: [{ url: 'http://app.test/#/orders' }]
    }
  });

  assert.equal(result.status, 'no_executable_missions');
  assert.equal(result.telemetry.stopReason, 'no_executable_missions');
  assert.equal(result.missionCompilerSummary.suppressionReasons.already_covered_no_delta, 1);
});

test('manager keeps covered historical auth surface budget gaps for non-route delta', async () => {
  let offered = [];
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async context => {
        offered = context.missions.map(mission => mission.id);
        const mission = context.missions[0];
        return {
          missionId: mission.id,
          reason: 'retry budget-limited auth surface for endpoint/action delta',
          provider: 'codex',
          expectedDelta: { endpoints: 1 },
          allowedCapability: 'mission:plan',
          riskModeRequired: 'safe'
        };
      }
    },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/#/saved-payment-methods' } },
      missionCandidates: [{
        id: 'mission:auth-surface-gap:payments',
        kind: 'auth-surface-traversal',
        source: 'auth-surface-summary',
        priority: 124,
        route: 'http://app.test/#/saved-payment-methods',
        reason: 'historical auth menu action was not fully explored',
        surfaceGap: {
          route: 'http://app.test/#/saved-payment-methods',
          reason: 'surface_explorer_budget_exhausted'
        }
      }]
    },
    coverage: {
      routes: [{ url: 'http://app.test/#/saved-payment-methods' }]
    },
    handlers: {
      'auth-surface-traversal': mission => ({
        status: 'completed',
        coverage: {
          routes: [{ url: 'http://app.test/#/saved-payment-methods' }],
          endpoints: [{ key: 'GET /api/Cards', path: '/api/Cards' }]
        },
        transition: { changed: true, noProgress: false, reason: 'auth-surface-budget-retry' },
        effects: [{ kind: 'endpoint-observed', missionId: mission.id }]
      })
    }
  });

  assert.deepEqual(offered, ['mission:auth-surface-gap:payments']);
  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].actualDelta.routes, 0);
  assert.equal(result.results[0].actualDelta.endpoints, 1);
});

test('manager keeps live auth surface handle missions even when current route is covered', async () => {
  let offered = [];
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async context => {
        offered = context.missions.map(mission => mission.id);
        return {
          missionId: 'mission:auth-surface-live',
          reason: 'fresh surface handle can expose menu state',
          provider: 'codex',
          expectedDelta: { routes: 1 },
          allowedCapability: 'mission:plan',
          riskModeRequired: 'safe'
        };
      }
    },
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/#/account' } },
      missionCandidates: [{
        id: 'mission:auth-surface-live',
        kind: 'auth-surface-traversal',
        source: 'live-handle',
        priority: 124,
        route: 'http://app.test/#/account',
        surfaceHandleId: 'surface_1_account',
        reason: 'fresh account menu surface'
      }]
    },
    coverage: {
      routes: [{ url: 'http://app.test/#/account' }]
    },
    handlers: {
      'auth-surface-traversal': mission => ({
        status: 'completed',
        coverage: {
          routes: [{ url: 'http://app.test/#/account' }, { url: 'http://app.test/#/orders' }],
          endpoints: []
        },
        transition: { changed: true, noProgress: false, reason: 'fresh-surface-expanded' },
        effects: [{ kind: 'surface-expanded', missionId: mission.id }]
      })
    }
  });

  assert.deepEqual(offered, ['mission:auth-surface-live']);
  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].actualDelta.routes, 1);
});

test('turn mission resolver prioritizes fresh live UI handles over PTK route replay', () => {
  const handles = createAgentHandleRegistry({ turn: 1 });
  handles.issue({
    type: 'surface',
    routeKey: 'http://app.test/#/account',
    source: 'surfaceExplorer',
    policyTier: 'safe',
    summary: {
      label: 'Account menu',
      semanticKind: 'menu-toggle',
      expectedEffect: 'surface-expansion'
    }
  });
  handles.issue({
    type: 'control',
    routeKey: 'http://app.test/#/account',
    source: 'pageModel',
    policyTier: 'safe',
    summary: {
      label: 'Order history',
      href: 'http://app.test/#/order-history',
      expectedEffect: 'route-change'
    }
  });

  const result = resolveTurnMissions({
    context: { scenarioVariant: 'scenario' },
    coverage: { routes: [{ url: 'http://app.test/#/account' }], endpoints: [] },
    evidence: {
      ptkSignals: {
        findings: [{
          engine: 'DAST',
          ruleId: 'jwt',
          title: 'JWT None',
          severity: 'high',
          location: { runtimeUrl: 'http://app.test/#/profile' }
        }]
      }
    },
    handles,
    observation: {
      currentPage: {
        url: 'http://app.test/#/account',
        authSignals: ['authenticated account surface']
      }
    },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(result.skipReason, null);
  assert.equal(result.missions[0].kind, 'auth-surface-traversal');
  assert.equal(result.missions[0].source, 'surfaceExplorer');
  assert.equal(result.missions.some(mission => mission.kind === 'ptk-finding-entrypoint-reproduction'), false);
  assert.equal(result.summary.suppressionReasons.deferred_for_business_mission, 1);
});

test('historical authenticated surface budget gaps outrank PTK route replay', () => {
  const result = resolveTurnMissions({
    context: { scenarioVariant: 'scenario' },
    coverage: {
      routes: [{ url: 'http://app.test/#/address/saved' }],
      authSurfaceSummary: {
        menuActions: [{
          label: 'Saved addresses',
          routeUrl: 'http://app.test/#/',
          selector: 'button[routerlink="\\/address\\/saved"]',
          reason: 'surface_explorer_budget_exhausted'
        }]
      }
    },
    evidence: {
      ptkSignals: {
        findings: [{
          engine: 'DAST',
          ruleId: 'jwt',
          title: 'JWT None',
          severity: 'high',
          location: { runtimeUrl: 'http://app.test/#/profile' }
        }]
      }
    },
    agentConfig: { riskMode: 'safe' }
  });

  assert.equal(result.skipReason, null);
  assert.equal(result.missions[0].kind, 'auth-surface-traversal');
  assert.equal(result.missions.some(mission => mission.kind === 'ptk-finding-entrypoint-reproduction'), false);
  assert.equal(result.summary.suppressionReasons.deferred_for_business_mission, 1);
});

test('manager loop does not run before baseline discovery by default', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1 } },
    context: {
      baselineComplete: false,
      missionCandidates: [{ id: 'm1', kind: 'broad-coverage-tail' }]
    }
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.telemetry.actualMode, 'off');
  assert.equal(result.telemetry.fallbackReason, 'baseline-not-complete');
});

test('manager loop selects one mock mission and executes registered handler', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'mock', maxTurns: 1 } },
    provider: createMockProvider(),
    context: {
      baselineComplete: true,
      session: { page: { url: () => 'http://app.test/' } },
      missionCandidates: [
        { id: 'low', kind: 'broad-coverage-tail', priority: 1 },
        { id: 'high', kind: 'hidden-route-verification', route: '/admin', priority: 100 }
      ]
    },
    handlers: {
      'hidden-route-verification': (mission) => ({
        status: 'completed',
        coverage: { routes: [{ url: '/' }, { url: mission.route }], endpoints: [] },
        transition: { changed: true, noProgress: false, reason: 'test-route' },
        effects: [{ kind: 'planned', missionId: mission.id }]
      })
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.telemetry.actualMode, 'agent-mock');
  assert.equal(result.missions[0].id, 'high');
  assert.equal(result.results[0].status, 'completed');
  assert.equal(result.results[0].executed, true);
  assert.equal(result.results[0].transitionValidated, true);
  assert.equal(result.results[0].actualDelta.routes, 2);
  assert.equal(result.results[0].effects[0].missionId, 'high');
});

test('provider decision guard rejects malformed provider choices', () => {
  const missions = [{ id: 'm1', kind: 'hidden-route-verification', route: '/admin' }];
  const missingDelta = validateProviderDecision({
    missionId: 'm1',
    reason: 'try admin',
    allowedCapability: 'route.visit'
  }, { missions });
  assert.equal(missingDelta.allowed, false);
  assert.ok(missingDelta.errors.some(error => /expectedDelta/.test(error)));

  const unsafeCapability = validateProviderDecision({
    missionId: 'm1',
    reason: 'try admin',
    expectedDelta: { routes: 1 },
    allowedCapability: 'http.request'
  }, { missions });
  assert.equal(unsafeCapability.allowed, false);
  assert.ok(unsafeCapability.errors.some(error => /not allowed/.test(error)));
});

test('provider decision guard allows typed plans for hidden-route missions', () => {
  const decision = validateProviderDecision({
    missionId: 'route',
    reason: 'visit uncovered route through SDK typed plan',
    allowedCapability: 'mission:plan',
    expectedDelta: { routes: 1 }
  }, {
    missions: [{ id: 'route', kind: 'hidden-route-verification', route: '/admin' }]
  });

  assert.equal(decision.allowed, true);
});

test('manager loop rejects provider choice without expected delta', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async () => ({
        missionId: 'm1',
        reason: 'choose route without expected delta',
        provider: 'codex',
        allowedCapability: 'route.visit'
      })
    },
    context: {
      baselineComplete: true,
      missionCandidates: [
        { id: 'm1', kind: 'hidden-route-verification', route: '/admin', priority: 2 },
        { id: 'm2', kind: 'hidden-route-verification', route: '/settings', priority: 1 }
      ]
    }
  });

  assert.equal(result.status, 'provider_failed');
  assert.equal(result.result.reason, 'provider_choice_rejected');
  assert.ok(result.result.errors.some(error => /expectedDelta/.test(error)));
});

test('action effect recorder captures route and endpoint deltas', () => {
  const effect = recordActionEffect({
    mission: { id: 'm1', kind: 'hidden-route-verification' },
    beforeCoverage: {
      routes: [{ url: '/' }],
      endpoints: [{ key: 'GET /api/products', method: 'GET', path: '/api/products' }]
    },
    afterCoverage: {
      routes: [{ url: '/' }, { url: '/admin' }],
      endpoints: [
        { key: 'GET /api/products', method: 'GET', path: '/api/products' },
        { key: 'GET /api/admin', method: 'GET', path: '/api/admin' }
      ]
    },
    transition: { changed: true, signals: ['route-visited'] }
  });

  assert.equal(effect.status, 'progress');
  assert.equal(effect.delta.routes, 1);
  assert.equal(effect.delta.endpoints, 1);
});

test('action effect recorder captures unique finding fingerprint deltas', () => {
  const effect = recordActionEffect({
    mission: { id: 'm-findings', kind: 'ptk-finding-entrypoint-reproduction' },
    beforeCoverage: {
      ptk: {
        evidence: {
          findings: [
            { engine: 'DAST', ruleId: 'xss', title: 'XSS', severity: 'high', url: '/a', parameter: 'q' }
          ]
        }
      }
    },
    afterCoverage: {
      ptk: {
        evidence: {
          findings: [
            { engine: 'DAST', ruleId: 'xss', title: 'XSS', severity: 'high', url: '/a', parameter: 'q' },
            { engine: 'SAST', ruleId: 'dom-xss', title: 'DOM XSS', severity: 'high', url: '/main.js', parameter: 'sink' }
          ]
        }
      }
    },
    transition: { changed: true, signals: ['finding-observed'] }
  });

  assert.equal(effect.delta.findings, 1);
  assert.equal(effect.after.findings, 2);
});

test('run memory penalizes repeated no-progress missions', () => {
  const memory = createAgentRunMemory({ maxNoProgress: 2 });
  const mission = { id: 'm1', kind: 'hidden-route-verification', priority: 100 };
  assert.equal(memory.scoreMission(mission), 0);
  memory.recordEffect({ missionId: 'm1', missionKind: 'hidden-route-verification', status: 'no_progress', noProgress: true });
  assert.equal(memory.scoreMission(mission), -25);
  assert.equal(memory.shouldSuppress(mission), false);
  memory.recordEffect({ missionId: 'm1', missionKind: 'hidden-route-verification', status: 'no_progress', noProgress: true });
  assert.equal(memory.shouldSuppress(mission), true);
});

test('manager loop reports explicit fallback when unsupported provider is configured', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'native', fallback: 'off' } },
    provider: { kind: 'native-provider' },
    context: {
      baselineComplete: true,
      missionCandidates: [{ id: 'm1', kind: 'broad-coverage-tail' }]
    }
  });

  assert.equal(result.status, 'fallback');
  assert.equal(result.telemetry.fallbackMode, 'off');
  assert.match(result.telemetry.fallbackReason, /Unsupported manager provider/);
});

test('manager loop reports explicit provider failure instead of executing no mission', async () => {
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1 } },
    provider: {
      kind: 'codex',
      chooseMission: async () => ({
        missionId: null,
        reason: 'codex_provider_failed',
        provider: 'codex',
        error: 'codex exited with 1'
      })
    },
    context: {
      baselineComplete: true,
      missionCandidates: [{ id: 'm1', kind: 'hidden-route-verification', route: '/admin', priority: 1 }]
    }
  });

  assert.equal(result.status, 'provider_failed');
  assert.equal(result.actual, 'provider:codex');
  assert.equal(result.result.reason, 'codex_provider_failed');
  assert.equal(result.result.error, 'codex exited with 1');
  assert.equal(result.results[0].reason, 'codex_provider_failed');
});

test('manager preserves useful completed turns when a later provider failure occurs', () => {
  assert.equal(finalStatusAfterProviderFailure([]), 'provider_failed');
  assert.equal(finalStatusAfterProviderFailure([
    {
      status: 'completed',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 1, forms: 0, findings: 0 }
    },
    {
      status: 'provider_failed',
      reason: 'provider_selected_unknown_mission'
    }
  ]), 'completed_with_agent_failure');
});

test('manager final status preserves useful completed work when later turn has no progress', () => {
  assert.equal(finalStatusAfterLoop('no_progress', [
    {
      status: 'completed',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 1, forms: 1, actions: 2, findings: 0 }
    },
    {
      status: 'no_progress',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 }
    }
  ]), 'completed');
  assert.equal(finalStatusAfterLoop('no_progress', [
    {
      status: 'no_progress',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 }
    }
  ]), 'no_progress');
});

test('manager final status preserves useful completed work when later turn fails', () => {
  assert.equal(finalStatusAfterLoop('failed', [
    {
      status: 'completed',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 1, forms: 1, actions: 2, findings: 0 }
    },
    {
      status: 'failed',
      reason: 'submit form timed out',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 }
    }
  ]), 'completed_with_agent_failure');
  assert.equal(finalStatusAfterLoop('failed', [
    {
      status: 'failed',
      reason: 'submit form timed out',
      actualDelta: { routes: 0, routeShapes: 0, endpoints: 0, forms: 0, actions: 0, findings: 0 }
    }
  ]), 'failed');
});

test('manager resolves invented provider mission id only through an unambiguous fresh SDK handle', () => {
  const missions = [
    { id: 'mission:surface:search', kind: 'auth-surface-traversal', route: 'http://app.test/#/search' },
    { id: 'mission:route:orders', kind: 'auth-surface-traversal', route: 'http://app.test/#/orders' }
  ];
  const handles = {
    validate(id, options = {}) {
      assert.equal(options.turn, 2);
      if (id !== 'surface_2_1') return { ok: false, reason: 'unknown_handle' };
      return {
        ok: true,
        handle: {
          id,
          type: 'surface',
          routeKey: 'http://app.test/#/search',
          source: 'surfaceExplorer',
          summary: { semanticKind: 'navigation-toggle' }
        }
      };
    }
  };

  const resolved = resolveChoiceMissionAlias({
    missionId: 'mission:provider-invented-account-menu',
    reason: 'open current menu',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'open_surface', target: { surfaceId: 'surface_2_1' } }]
  }, { missions, handles, turn: 2 });

  assert.equal(resolved.missionId, 'mission:surface:search');
  assert.equal(resolved.providerMissionId, 'mission:provider-invented-account-menu');
  assert.equal(resolved.missionAliasResolved.reason, 'fresh_handle_unambiguous_mission');
});

test('manager resolves invented provider mission id through direct control handle ownership before route ambiguity', () => {
  const missions = [
    {
      id: 'mission:business-flow:account-menu',
      kind: 'surface-expanded-route',
      route: 'http://app.test/#/',
      controlHandleId: 'ctrl_1_6'
    },
    {
      id: 'mission:business-flow:search',
      kind: 'surface-expanded-route',
      route: 'http://app.test/#/',
      controlHandleId: 'ctrl_1_8'
    },
    {
      id: 'mission:auth-surface:address',
      kind: 'auth-surface-traversal',
      route: 'http://app.test/#/address/saved'
    }
  ];
  const handles = {
    validate(id, options = {}) {
      assert.equal(options.turn, 1);
      if (id !== 'ctrl_1_6') return { ok: false, reason: 'unknown_handle' };
      return {
        ok: true,
        handle: {
          id,
          type: 'control',
          routeKey: 'http://app.test/#/',
          source: 'pageModel',
          summary: { label: 'Account menu', expectedEffect: 'surface-change' }
        }
      };
    }
  };

  const resolved = resolveChoiceMissionAlias({
    missionId: 'mission:provider-invented-account-menu',
    reason: 'open account menu',
    expectedDelta: { routes: 1 },
    steps: [{ type: 'click_control', target: { controlId: 'ctrl_1_6' } }]
  }, { missions, handles, turn: 1 });

  assert.equal(resolved.missionId, 'mission:business-flow:account-menu');
  assert.equal(resolved.providerMissionId, 'mission:provider-invented-account-menu');
  assert.equal(resolved.missionAliasResolved.handleId, 'ctrl_1_6');
});

test('manager does not resolve invented mission id from ambiguous handles', () => {
  const missions = [
    { id: 'mission:a', kind: 'auth-surface-traversal', route: 'http://app.test/#/search' },
    { id: 'mission:b', kind: 'surface-expanded-route', route: 'http://app.test/#/search' }
  ];
  const handles = {
    validate() {
      return {
        ok: true,
        handle: {
          id: 'surface_1_1',
          type: 'surface',
          routeKey: 'http://app.test/#/search',
          source: 'surfaceExplorer'
        }
      };
    }
  };
  const choice = {
    missionId: 'mission:invented',
    steps: [{ type: 'open_surface', target: { surfaceId: 'surface_1_1' } }]
  };

  assert.equal(resolveChoiceMissionAlias(choice, { missions, handles, turn: 1 }).missionId, 'mission:invented');
});

test('manager loop bounds provider choice timeout and returns artifactable failure data', async () => {
  const events = [];
  const lifecycleEvents = [];
  const started = Date.now();
  const result = await runAgentManagerV2({
    config: { agent: { enabled: true, mode: 'provider', provider: 'codex', maxTurns: 1, maxProviderMs: 5 } },
    provider: {
      kind: 'codex',
      chooseMission: async () => {
        await sleep(50);
        return { missionId: 'm1', provider: 'codex' };
      }
    },
    context: {
      baselineComplete: true,
      missionCandidates: [{ id: 'm1', kind: 'hidden-route-verification', route: '/admin', priority: 1 }],
      writeRowLifecycle(type, details) {
        lifecycleEvents.push({ type, details });
      }
    },
    telemetry: {
      event(type, data) {
        events.push({ type, data });
      }
    }
  });
  const durationMs = Date.now() - started;

  assert.equal(result.status, 'provider_failed');
  assert.equal(result.result.reason, 'provider_timeout');
  assert.equal(result.result.provider, 'codex');
  assert.equal(result.result.timeoutMs, 5);
  assert.ok(durationMs < 200);
  assert.ok(events.some(event => event.type === 'agent.provider.timeout'));
  assert.deepEqual(lifecycleEvents.map(event => event.type), ['provider_started', 'provider_timeout']);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].result.reason, 'provider_timeout');
  assert.equal(result.providerDecisionQuality.decisions[0].decisionReason, 'provider_timeout');
});

test('codex provider can be constructed for GPT-5.3-Codex-Spark without executing provider', () => {
  const provider = new CodexProvider({ model: 'gpt-5.3-codex-spark', maxProviderMs: 1234, cwd: '/tmp' });
  assert.equal(provider.kind, 'codex');
  assert.equal(provider.model, 'gpt-5.3-codex-spark');
  assert.equal(provider.maxProviderMs, 1234);
});

test('opencode provider surfaces error logs and classifies provider availability failures', () => {
  const args = buildOpencodeArgs({ model: 'opencode/big-pickle', prompt: 'return json' });
  assert.deepEqual(args.slice(0, 9), ['--pure', '--print-logs', '--log-level', 'ERROR', 'run', '--agent', 'plan', '--title', 'ptk-agent-provider']);
  assert.equal(args.includes('opencode/big-pickle'), true);
  assert.equal(args.indexOf('--title') < args.indexOf('-m'), true);
  assert.equal(args.indexOf('--agent') < args.indexOf('-m'), true);
  assert.equal(args.includes('build'), false);

  const providerEnv = buildOpencodeEnvironment('/tmp/ptk-opencode-provider-test');
  assert.equal(providerEnv.XDG_DATA_HOME, '/tmp/ptk-opencode-provider-test/data');
  assert.equal(providerEnv.XDG_STATE_HOME, '/tmp/ptk-opencode-provider-test/state');
  assert.equal(providerEnv.XDG_CACHE_HOME, '/tmp/ptk-opencode-provider-test/cache');

  const billing = classifyOpencodeFailure({
    stderr: 'statusCode":401 responseBody {"type":"error","error":{"type":"CreditsError","message":"No payment method"}}'
  });
  assert.equal(billing.reason, 'opencode_provider_unavailable');

  const db = classifyOpencodeFailure({
    stderr: "SQLiteError: attempt to write a readonly database Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'"
  });
  assert.equal(db.reason, 'opencode_provider_environment_error');
});

test('opencode provider accepts valid stdout plan despite background billing log noise', () => {
  const result = choiceFromOpencodeResult({
    ok: false,
    code: 1,
    stdout: '{"missionId":"mission:auth","reason":"try surface","riskModeRequired":"safe","expectedDelta":{"routes":1},"steps":[{"type":"open_surface","target":{"surfaceId":"surface_1"}}]}',
    stderr: 'ERROR service=llm statusCode":401 responseBody {"type":"error","error":{"type":"CreditsError","message":"No payment method"}}',
    stdoutTruncated: false,
    stderrTruncated: false
  });

  assert.equal(result.provider, 'opencode');
  assert.equal(result.missionId, 'mission:auth');
  assert.equal(result.reason, 'try surface');
  assert.equal(result.providerExitCode, 1);
  assert.equal(result.providerWarnings.length, 1);
  assert.equal(result.providerWarnings[0].reason, 'opencode_background_billing_error');
});

test('opencode provider still fails billing errors when no valid plan was produced', () => {
  const warnings = classifyOpencodeWarnings({
    stderr: 'statusCode":401 responseBody {"type":"error","error":{"type":"CreditsError","message":"No payment method"}}'
  });
  assert.equal(warnings[0].reason, 'opencode_background_billing_error');

  const result = choiceFromOpencodeResult({
    ok: false,
    code: 1,
    stdout: '{"ok":true}',
    stderr: 'statusCode":401 responseBody {"type":"error","error":{"type":"CreditsError","message":"No payment method"}}'
  });
  assert.equal(result.reason, 'opencode_provider_unavailable');
});

test('provider choice parser is bounded and prefers trailing JSON from noisy output', () => {
  const noisyPrefix = `${'provider log { not json '.repeat(5000)}\n`;
  const choice = parseProviderChoice(`${noisyPrefix}{"missionId":"m1","reason":"bounded","expectedDelta":{"routes":1},"allowedCapability":"route.visit"}`);
  assert.equal(choice.missionId, 'm1');
  assert.equal(choice.expectedDelta.routes, 1);
});

test('provider process output capture keeps bounded tail and reports truncation', () => {
  const bounded = appendBoundedProviderOutput('a'.repeat(MAX_PROVIDER_OUTPUT_CHARS - 5), 'bbbbbbbbbb');
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.value.length, MAX_PROVIDER_OUTPUT_CHARS);
  assert.match(bounded.value, /bbbbbbbbbb$/);
});

test('mission compiler does not promote static assets to manager missions', () => {
  const missions = compileMissions({
    coverage: {
      endpoints: [
        { key: 'GET /images/icon_top.gif', method: 'GET', path: '/images/icon_top.gif', resourceType: 'image' },
        { key: 'GET /style.css', method: 'GET', path: '/style.css', resourceType: 'stylesheet' },
        { key: 'GET /api/products', method: 'GET', path: '/api/products', resourceType: 'fetch' },
        { key: 'POST /graphql', method: 'POST', path: '/graphql', resourceType: 'fetch', graphqlOperationName: 'Products' }
      ],
      routes: []
    }
  });

  assert.equal(missions.some(mission => /icon_top|style\.css/.test(mission.id)), false);
  assert.equal(missions.some(mission => mission.kind === 'endpoint-backed-ui-flow' && /api\/products/.test(mission.id)), true);
  assert.equal(missions.some(mission => mission.kind === 'graphql-operation-flow'), true);
});

test('mission executor returns not_executable intents for deterministic mission kinds without live handlers', async () => {
  const auth = await executeMission({
    mission: {
      id: 'auth',
      kind: 'auth-flow',
      scenarioGap: { stepId: 'login', route: '/login' }
    },
    context: { profile: { credentialRef: 'profile:default' } }
  });
  assert.equal(auth.status, 'not_executable');
  assert.equal(auth.intents.some(intent => intent.kind === 'auth.assess-scenario-gap'), true);
  assert.equal(auth.intents.some(intent => intent.kind === 'route.visit' && intent.route === '/login'), true);

  const route = await executeMission({
    mission: {
      id: 'route',
      kind: 'hidden-route-verification',
      routeHint: { url: '/admin', source: 'sast' }
    }
  });
  assert.equal(route.status, 'not_executable');
  assert.deepEqual(route.intents.map(intent => intent.kind), ['route.visit']);
  assert.equal(route.results[0].route, '/admin');

  const endpoint = await executeMission({
    mission: {
      id: 'endpoint',
      kind: 'endpoint-backed-ui-flow',
      endpoint: { method: 'GET', path: '/api/products', resourceType: 'fetch', routeUrl: '/products' }
    }
  });
  assert.equal(endpoint.status, 'not_executable');
  assert.equal(endpoint.intents[0].kind, 'endpoint.map-to-ui');
  assert.equal(endpoint.intents[1].kind, 'route.visit');

  const graphql = await executeMission({
    mission: {
      id: 'graphql',
      kind: 'graphql-operation-flow',
      endpoint: { method: 'POST', path: '/graphql', graphqlOperationName: 'Products', operationTypes: ['query'] }
    }
  });
  assert.equal(graphql.status, 'not_executable');
  assert.equal(graphql.intents[1].kind, 'graphql.operation.execute');
  assert.equal(graphql.results[0].safety, 'read-only');

  const hiddenParam = await executeMission({
    mission: {
      id: 'hidden',
      kind: 'hidden-param-flow',
      params: [{ name: 'debug', location: 'query', endpoint: { method: 'GET', path: '/api/products' } }]
    }
  });
  assert.equal(hiddenParam.status, 'not_executable');
  assert.equal(hiddenParam.intents[0].kind, 'hidden-param.probe');
  assert.equal(hiddenParam.results[0].paramCount, 1);

  const broad = await executeMission({
    mission: { id: 'broad', kind: 'broad-coverage-tail' }
  });
  assert.equal(broad.status, 'not_executable');
  assert.equal(broad.intents[0].kind, 'crawler.continue');
  assert.equal(broad.action, 'defer_to_direct_crawler');
});
