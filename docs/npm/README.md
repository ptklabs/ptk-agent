# PentestKit for Node.js

[`pentestkit`](https://www.npmjs.com/package/pentestkit) connects browser automation to [OWASP Penetration Testing Kit](https://owasp.org/www-project-penetration-testing-kit/) security engines. Use it for command-line scans, existing end-to-end tests, CI/CD security gates, and supported cloud-browser platforms.

The package provides:

- `ptk-scan` for normal security scans;
- `ptk-agent` for configuration, modules, comparisons, and lower-level workflows;
- `ptk-agent-mcp-server` for MCP-capable clients;
- DAST, IAST, SAST, and SCA execution through PTK Auto;
- Playwright, Puppeteer, Selenium, and Cypress integrations;
- helpers for Browserbase, Browserless, BrowserStack, Hyperbrowser, Steel, and TestMu;
- Chromium and Firefox PTK Auto browser artifacts.

The source code and issue tracker are at [ptklabs/ptk-agent](https://github.com/ptklabs/ptk-agent). The package is licensed under [AGPL-3.0-only](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt).

## Install

```bash
npm install -D pentestkit
npx playwright install chromium
```

Verify that PTK Auto can be resolved:

```bash
npx ptk-agent --doctor-extension
```

A normal registry installation reports `bundled-package` as the extension source. See [troubleshooting](troubleshooting.md) if the diagnostic reports an override or cannot prepare the extension.

## First Scan

Only scan systems you own or are explicitly authorised to test.

```bash
npx ptk-scan https://your-authorised-target.example \
  --engine DAST,IAST,SAST,SCA \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --output-dir .ptk/results/first-scan
```

The strict bridge and export flags make the command fail if PTK Auto is unavailable or the final findings cannot be collected. They are recommended for CI.

Start with a small crawl budget on a new target:

```bash
npx ptk-scan https://your-authorised-target.example \
  --engine DAST,IAST \
  --max-routes 20 \
  --max-actions-per-route 1 \
  --max-forms-per-route 0
```

Increase the budget after reviewing the discovered routes and actions. PTK Agent allows same-origin child pages within the configured scope and rejects unrelated external navigation.

## Commands

| Command | Purpose |
| --- | --- |
| `ptk-scan` | Run a day-to-day local or CI scan. |
| `ptk-agent scan` | Run a scan from a configuration file. |
| `ptk-agent validate-config` | Validate configuration without launching a browser. |
| `ptk-agent --doctor-extension` | Diagnose PTK Auto resolution. |
| `ptk-agent modules` | Inspect available security module packs. |
| `ptk-agent compare` | Compare saved scan results. |
| `ptk-agent-mcp-server` | Connect PTK to an MCP-capable client. |

Useful entry points:

```bash
npx ptk-scan --help
npx ptk-agent --help
npx ptk-agent-mcp-server --help
npx ptk-agent-mcp-server --stdio
```

See the [CLI reference](cli.md) for all flags and subcommands.

## Authenticated Scans

Pass credentials through environment variables or a CI secret manager:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='replace-me'

npx ptk-scan https://your-authorised-target.example \
  --scenario login-and-search.md \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --engine DAST,IAST,SAST,SCA \
  --require-ptk-bridge \
  --require-ptk-findings-export
```

Credentials alone do not describe how to log in. Use a scenario for the login journey or configure your existing test framework to perform authentication. See [authenticated scans](authenticated-scans.md) and [scenarios](scenarios.md).

## Configuration

Use `ptk.config.json` for a repeatable scan:

```json
{
  "version": "ptk-agent-v2-config",
  "target": {
    "baseUrl": "https://staging.example.test"
  },
  "engines": {
    "dast": { "enabled": true, "modulePacks": ["free"] },
    "iast": { "enabled": true, "modulePacks": ["free"] },
    "sast": { "enabled": true, "modulePacks": ["free"] },
    "sca": { "enabled": true, "modulePacks": [] }
  },
  "ptk": {
    "requireBridge": true,
    "requireFindingsExport": true,
    "drainMode": "until-complete",
    "drainTimeoutMs": 120000
  },
  "crawler": {
    "maxRoutes": 100
  },
  "artifacts": {
    "outputDir": ".ptk/results"
  }
}
```

Validate and run it:

```bash
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-scan --config ptk.config.json
```

See [configuration](configuration.md) for the complete schema.

## CI/CD

A typical CI job installs the package and browser, validates configuration, runs the scan, then uploads results using protected CI artifact storage:

```bash
npm ci
npx playwright install chromium
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-scan --config ptk.config.json \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high
```

SARIF is written before a severity gate returns a non-zero exit status. See [SARIF and severity gates](sarif.md) and [GitHub Actions](github-actions.md).

## Framework Integrations

When your application journey already exists in a test suite, wrap that journey instead of launching a separate crawl:

- `pentestkit/playwright`
- `pentestkit/puppeteer`
- `pentestkit/selenium`
- `pentestkit/cypress`
- `pentestkit/browser` for the shared page-level API

See [framework integrations](frameworks.md) for installation and examples.

## Cloud Providers

Provider helpers create or connect to an extension-enabled browser session and return the page or driver used by the framework wrapper:

- `pentestkit/providers/browserbase`
- `pentestkit/providers/browserless`
- `pentestkit/providers/browserstack`
- `pentestkit/providers/hyperbrowser`
- `pentestkit/providers/steel`
- `pentestkit/providers/testmu`

Provider and framework support differs. Use the [provider guide](providers.md) and [support matrix](provider-browser-matrix.md) before configuring a session.

## Browser Extension

PTK Auto is bundled with the npm package. Local Chromium-family workflows prepare an unpacked extension automatically. Firefox and some remote platforms use a signed or packaged artifact as required by their browser API.

Most users should not set an extension path. Use an explicit override only when testing a custom PTK Auto build or a browser profile that already has PTK Auto installed. See [extension loading](extension-loading.md).

## Scan Results And Sensitive Data

Results are written under `.ptk/results`, `.ptk/artifacts`, or the directory selected with `--output-dir`. Depending on the scan configuration, output can include:

- findings and severity summaries;
- routes, endpoints, forms, and crawl events;
- PTK lifecycle and engine-completion state;
- SARIF reports and severity-gate decisions;
- screenshots, traces, page evidence, or scenario results;
- replay data when explicitly enabled.

Treat these files as sensitive security evidence. Limit access, encrypt storage where appropriate, redact data before sharing, and configure CI retention to match your security policy. Replayable exports may contain cookies, authorisation headers, CSRF tokens, or request bodies and require stricter handling.

Provider credentials and application credentials should remain in environment variables or a secret manager. Avoid printing resolved credentials in logs or including them in shared scan evidence.

## Documentation

- [CLI reference](cli.md)
- [Configuration](configuration.md)
- [Authenticated scans](authenticated-scans.md)
- [Scenario-guided scans](scenarios.md)
- [Extension loading](extension-loading.md)
- [Framework integrations](frameworks.md)
- [Provider integrations](providers.md)
- [Provider support matrix](provider-browser-matrix.md)
- [GitHub Actions](github-actions.md)
- [SARIF and severity gates](sarif.md)
- [MCP server](mcp-server.md)
- [Troubleshooting](troubleshooting.md)
