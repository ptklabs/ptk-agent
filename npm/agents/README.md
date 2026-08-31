# PTK Agent Runtime

This directory implements the command-line and deterministic browser runtime published in the [`pentestkit`](https://www.npmjs.com/package/pentestkit) package.

Package users should start with the [npm package guide](../../docs/npm/README.md), [CLI reference](../../docs/npm/cli.md), and [configuration guide](../../docs/npm/configuration.md).

## Public Commands

- `ptk-scan` runs a normal local or CI security scan.
- `ptk-agent scan` runs a configuration-owned scan.
- `ptk-agent crawl` runs deterministic browser exploration.
- `ptk-agent validate-config` validates configuration without launching a browser.
- `ptk-agent modules` inspects available security module packs.
- `ptk-agent compare` compares saved scan results.
- `ptk-agent-mcp-server` exposes the optional MCP surface.

Use the installed commands rather than importing files from this directory:

```bash
npm install -D pentestkit
npx playwright install chromium
npx ptk-scan https://your-authorised-target.example
```

## Runtime Contract

The runtime is deterministic first:

- it starts from the configured target, scenarios, route hints, and same-origin links;
- same-origin child pages remain eligible for navigation and scanning;
- unrelated origins are rejected unless explicitly included in scope;
- route, action, form, and observation budgets are bounded;
- state-changing actions require explicit policy;
- a missing PTK bridge or failed findings export is not reported as zero findings;
- provider and browser resources are closed on completion or failure;
- macro input is an exclusive journey; conflicting scenario/Agent inputs are
  reported before launch, skipped, and recorded in `execution-plan.json`;
- credentials and sensitive evidence are redacted by default.

PTK Auto performs DAST, IAST, SAST, and SCA work. The Agent runtime controls browser journeys and records lifecycle evidence; it does not replace the PTK engines.

## Configuration Areas

The validated configuration model covers:

- target and scope;
- browser and profile selection;
- crawler and action budgets;
- scenarios and authenticated flows;
- structured macro journeys replayed after the selected PTK engines start;
- PTK engine and module selection;
- bridge, drain, stop, and export requirements;
- output and CI severity policy;
- optional provider and agent settings.

See [configuration](../../docs/npm/configuration.md) for the supported public schema.

## Scan Results

Normal result files describe resolved configuration, the requested/effective
execution plan, coverage, crawl events, engine participation, PTK lifecycle,
findings, and severity-gate decisions. Their exact presence depends on the
selected command and output format.

Treat results as sensitive security evidence. They can include application URLs, page observations, screenshots, traces, and—when explicitly requested—authentication or replay data. Restrict access, redact before sharing, and apply an appropriate retention policy.

## Development

From the Node workspace:

```bash
cd npm
npm install
npm run test:agents
```

When changing package boundaries or public commands, also run:

```bash
npm run test:ci
npm run test:npm
```

Keep user documentation under [`docs/npm/`](../../docs/npm/README.md) aligned with behavior changes.

## Design References

- [Architecture](docs/architecture.md)
- [CI usage](docs/ci-usage.md)
- [PTK automation and extension loading](docs/ptk-automation-and-extension-loading.md)
- [Pro module contract](docs/pro-modules.md)
