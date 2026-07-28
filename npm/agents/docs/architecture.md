# PTK Agents SDK Architecture

The SDK is built around a small, measurable crawler core. Agent behavior is optional and runs only after deterministic crawling, scenarios, forms, evidence graphs, and PTK bridge state have produced telemetry.

## Design Goals

- Keep direct crawling fast and budgeted.
- Make waits, route limits, action limits, and provider budgets visible in resolved config.
- Execute scenarios as explicit steps with success and failure conditions.
- Keep browser actions owned by the SDK, not by provider prompts.
- Treat PTK bridge detection and findings export as first-class validity checks.
- Keep secrets redacted from artifacts, telemetry, provider context, and screenshots by default.

## Worker Model

Each worker has a narrow responsibility:

- `routeWorker`: route navigation, bounded observation, link/action/form discovery.
- `actionWorker`: safe UI expansion such as menus, modals, tabs, and SPA controls.
- `formWorker`: field classification, profile value resolution, submit, validation feedback.
- `scenarioWorker`: ordered executable steps with success/failure conditions.
- `missionExecutor`: deterministic execution of provider-selected missions after baseline discovery.

No worker owns the whole crawl loop.

## Budget Model

All important waits are visible in resolved config:

- `maxRouteMs`
- `maxActionMs`
- `maxObservationMs`
- `maxRoutes`
- `maxActionsPerRoute`
- `maxNoProgressActions`
- `agent.maxTurns`

Default behavior uses short event windows. `networkidle` is not a default strategy.

## Scenario Model

Scenario text may be compiled into executable steps, but runtime execution uses a structured model:

```text
step -> action type -> success condition -> failure condition -> retry/defer rule
```

Each step produces telemetry. Success is validated from page, transition, event, and evidence state, not from keyword matching.

## Evidence Graph Model

Evidence is normalized into graphs:

- route graph
- endpoint graph
- action-to-endpoint graph
- form-to-endpoint graph
- entity graph

These graphs feed comparison, scenario validation, module selection, and optional agent missions.

## Agent Manager Model

The agent is a manager, not a clicker. It sees coverage gaps, scenario status, graphs, and PTK/SAST evidence. It chooses a mission. The SDK validates policy and executes browser steps.

The default flow is:

```text
fast direct discovery -> scenario execution -> optional agent missions -> direct continuation
```

Agent mode must never silently reduce direct baseline coverage.

## CI/CD Model

The package must run in CI:

- no hardcoded monorepo paths in product examples
- configurable extension path
- non-interactive config validation
- artifact output in configured directories
- Pro modules resolved through token-based CI flow only when the resolver is available

## Implementation Constraints

- no all-in-one crawl loops
- no hidden fallback behavior
- no default long waits
- no prompt-first browser execution
- no stale/global evidence as action success
- no fuzzy scenario keyword execution
- no direct browser mutation by providers
