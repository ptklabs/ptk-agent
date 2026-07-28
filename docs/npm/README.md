# PentestKit NPM Package

PentestKit (`pentestkit`) runs [OWASP Penetration Testing Kit](https://owasp.org/www-project-penetration-testing-kit/)-backed browser security automation from a normal Node project. It bundles the PTK browser extension artifacts and exposes command-line tools for one-command scans, deterministic crawling, scenario-guided exploration, CI validation, JavaScript framework wrappers, and optional tool-server workflows.

Use this documentation when installing `pentestkit` from the npm registry. This package is the Node/JavaScript SDK surface. If you cloned the repository and want to build/install the package locally from source, use `ptk-agent/npm/README.md` instead.

Source code, issues, and package documentation are maintained at [ptklabs/ptk-agent](https://github.com/ptklabs/ptk-agent). The package is licensed under [GNU AGPL v3.0](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt). Published package artifacts declare their extension provenance and npm-generated provenance.

## Install

Install from the npm registry:

```bash
npm install -D pentestkit
npx playwright install chromium
```

Local source-built package installs use the same imports after installation, but the build/install steps are documented in `ptk-agent/npm/README.md`.

If the first browser launch after install times out, retry once with `--browser-launch-timeout-ms 60000`. See [troubleshooting](troubleshooting.md#browser-launch-fails).

The package includes:

- `ptk-scan`: product scan command for most users
- `ptk-agent`: lower-level scan, crawl, config, module, and compare commands
- `ptk-agent-mcp-server`: optional MCP/tool server surface
- automation-enabled Chromium MV3 ZIP at `extensions/ptk-latest.zip`
- automation-enabled Firefox MV2 ZIP at `extensions/ptk-latest-firefox.zip`
- reviewed Chrome Web Store CRX at `extensions/ptk-latest.crx`
- reviewed AMO-signed Firefox XPI at `extensions/ptk-latest.xpi`
- Chromium MV3 and Firefox MV2 manifest templates under `extensions/manifests/`
- extension helpers that validate and resolve the four provenance-pinned artifacts
- shared browser automation helpers via `pentestkit/browser`
- Playwright JavaScript helpers via `pentestkit/playwright`
- Selenium JavaScript helpers via `pentestkit/selenium`
- Cypress integration via `require("pentestkit/cypress")`
- Puppeteer integration via `require("pentestkit/puppeteer")`
- cloud provider helpers via `pentestkit/providers/*`

## First Check

Verify that the installed package can resolve the bundled extension:

```bash
npx ptk-agent --doctor-extension
```

Expected result:

```json
{
  "source": "bundled-package"
}
```

If the source is not `bundled-package`, check whether `PTK_EXTENSION_DIR`, `PTK_EXTENSION_PATH`, or a config file is overriding extension resolution.

## Which Command Should I Use?

Use `ptk-scan` for normal scans. It is the product-level command for local testing and CI:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --max-routes 100 \
  --output-dir .ptk/artifacts
```

Use `ptk-agent` when you need lower-level tooling around the scan runner:

```bash
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-agent scan --config ptk.config.json
npx ptk-agent modules list
npx ptk-agent compare --baseline-artifact before.json --candidate-artifact after.json
npx ptk-agent --doctor-extension
```

| Command | Use it for | Typical input |
| --- | --- | --- |
| `ptk-scan` | Day-to-day security scans and CI scan jobs. | URL or config plus scan flags. |
| `ptk-agent scan` | Reproducible config-owned scan jobs. | `ptk.config.json`. |
| `ptk-agent validate-config` | Checking config before a browser launches. | `ptk.config.json`. |
| `ptk-agent --doctor-extension` | Debugging extension resolution. | No target needed. |
| `ptk-agent modules` | Inspecting available module packs. | Optional config. |
| `ptk-agent compare` | Comparing saved artifacts in CI. | Existing artifact files. |
| `ptk-agent-mcp-server` | Connecting PTK to an MCP-capable tool host. | MCP stdio or registry inspection. |

If you are unsure, start with `ptk-scan`. Move to `ptk-agent scan --config ptk.config.json` when the command should be owned by a committed CI config file.

## Quick Scan

With no `--engine` flag, `ptk-scan` enables the default browser engines only. Pass `--engine DAST,IAST,SAST,SCA` when you want all engines enabled.

Run a bounded DAST scan against an authorized target:

```bash
npx ptk-scan https://target.example \
  --engine DAST \
  --max-routes 50 \
  --max-actions-per-route 1 \
  --output-dir .ptk/artifacts/quick-scan
```

Run a broader PTK-backed browser scan:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --max-routes 100 \
  --output-dir .ptk/artifacts/ptk-scan
```

Use `--require-ptk-bridge` when the run must fail if the PTK extension bridge is unavailable. Use `--require-ptk-findings-export` when CI must fail if the final findings export cannot be retrieved.

Normal `ptk-scan` automation computes PTK analysis when the scan stops. Add `--defer-analysis` when CI should stop/export first and recompute analysis later after importing or loading the scan in PTK:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --defer-analysis \
  --output-dir .ptk/artifacts/deferred-analysis
```

## Authenticated Scan

Pass credentials through environment variables so secrets do not appear in shell history:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='change-me'

npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --max-routes 100 \
  --output-dir .ptk/artifacts/credential-aware-crawl
```

`--include-secrets` allows local browser execution to use supplied credentials. PTK artifacts and agent/provider prompts stay redacted by default.

This is credential-aware crawl, not automatic login. Credentials alone do not log in. They are values that scenario/auth/form steps can use. A plain crawl keeps `crawler.forms.allowAuth=false` by default, so login forms are discovered but not submitted. For authenticated Juice Shop-style flows, use a scenario.

## Scenario-Guided Scan

Scenarios can be markdown or JSON. Markdown is intended for normal users:

```bash
cat > ptk-scenario.md <<'EOF'
Log in with the provided credentials.
Search for "apple".
Add one visible product to the basket.
Open the basket.
Do not checkout or pay.
EOF

npx ptk-scan https://target.example \
  --engine DAST,IAST,SAST,SCA \
  --scenario ptk-scenario.md \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --max-routes 120 \
  --output-dir .ptk/artifacts/scenario
```

Scenario guidance does not expand scope or disable safety checks. Use `--aggressive` only when state-changing interactions are acceptable on the target.

## CI/CD Usage

For CI, commit a `ptk.config.json`, keep secrets in CI variables, and validate the config before the scan:

```json
{
  "version": "ptk-agent-v2-config",
  "target": {
    "baseUrl": "https://staging.example.test"
  },
  "scenario": {
    "enabled": true,
    "file": "ptk-scenario.md"
  },
  "engines": {
    "dast": { "enabled": true, "modulePacks": ["free"] },
    "iast": { "enabled": true, "modulePacks": ["free"] },
    "sast": { "enabled": false, "modulePacks": ["free"] },
    "sca": { "enabled": false, "modulePacks": [] }
  },
  "ptk": {
    "requireBridge": true,
    "requireFindingsExport": true,
    "drainMode": "until-complete",
    "drainTimeoutMs": 120000,
    "immediateAnalysis": true
  },
  "crawler": {
    "maxRoutes": 100
  },
  "artifacts": {
    "outputDir": ".ptk/artifacts"
  }
}
```

Example CI steps:

```bash
npm ci
npx playwright install chromium
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-scan --config ptk.config.json \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets
```

Use `--require-ptk-bridge` and `--require-ptk-findings-export` for CI gates where a missing extension or failed findings export should fail the job. Store `.ptk/artifacts` as a CI artifact, but do not commit it.

For GitHub Code Scanning, write SARIF and upload it with `github/codeql-action/upload-sarif`:

```bash
npx ptk-scan --config ptk.config.json \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high
```

SARIF is written before `--fail-on` returns a non-zero exit code. See [SARIF and severity gates](sarif.md) and [GitHub Actions](github-actions.md).

## Command Overview

```bash
npx ptk-scan --help
npx ptk-agent --help
npx ptk-agent-mcp-server --help
```

Common commands:

```bash
npx ptk-scan https://target.example
npx ptk-agent crawl --url https://target.example
npx ptk-agent scan --config ptk.config.json
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-agent modules list
npx ptk-agent compare --baseline-artifact before.json --candidate-artifact after.json
npx ptk-agent-mcp-server --stdio
npx ptk-agent-mcp-server --list-tools
```

See [CLI reference](cli.md) for the full command surface.
See [configuration files](configuration.md) for `ptk.config.json` structure and examples.
See [MCP server](mcp-server.md) for MCP client configuration and safety controls.

## Extension Loading

For npm installs, Chromium-family scans use the bundled Chromium automation ZIP and unpack it into a local cache when needed. Firefox workflows use the bundled signed XPI or Firefox ZIP according to the browser/provider API. Override only when testing a source-built extension:

```bash
PTK_EXTENSION_DIR=/absolute/path/to/unpacked-extension \
npx ptk-agent --doctor-extension
```

Resolution order:

1. explicit CLI/config extension path
2. `PTK_EXTENSION_DIR`
3. `PTK_EXTENSION_PATH`
4. bundled package extension
5. local-dev fallback only when explicitly allowed in source-tree workflows

See [extension loading](extension-loading.md).

## Framework Integrations

Cypress:

```js
const { defineConfig } = require("cypress");
const { setupPtkCypress } = require("pentestkit/cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: "https://target.example",
    setupNodeEvents(on, config) {
      setupPtkCypress(on, config);
      return config;
    }
  }
});
```

`setupPtkCypress()` uses the bundled package extension by default, creates the Cypress run-local extension copy automatically, and derives the allowed AUT origin from `baseUrl`. For suites that visit additional origins, pass `allowedOrigins` or set `PTK_CYPRESS_ALLOWED_ORIGINS`. See [framework integrations](frameworks.md#cypress).

For Playwright JavaScript, Selenium JavaScript, Cypress, Puppeteer, and shared browser helper examples, see the framework guide.

See [framework integrations](frameworks.md).

## Provider Integrations

Provider helpers connect PTK to cloud browser platforms without moving your test journey into PTK-owned scripts. They load or upload the packaged PTK automation extension, return the provider page or driver, and let you wrap your existing flow with `withPtkScan()`.

Supported provider modules:

- `pentestkit/providers/testmu`
- `pentestkit/providers/browserstack`
- `pentestkit/providers/browserbase`
- `pentestkit/providers/browserless`
- `pentestkit/providers/hyperbrowser`
- `pentestkit/providers/steel`

See [provider integrations](providers.md) and the [provider browser matrix](provider-browser-matrix.md).

## Outputs

By default, scan artifacts are written under `.ptk/artifacts` or the path passed to `--output-dir`.

Important artifacts include:

- `coverage.json`: routes, endpoints, forms, and observed surfaces
- `crawl-events.jsonl`: route/action/event timeline
- `ptk-lifecycle.json`: PTK start, status, drain, stop, and export lifecycle
- `ptk-lifecycle-normalized.json`: normalized export and engine readiness truth
- `ptk-results.sarif`: SARIF report when `--format sarif` is used
- `finding-threshold.json`: severity threshold decision when `--fail-on` is used
- `findings.json` or exported PTK report artifacts when findings export is available
- `scenario-result.json` when a scenario ran

Do not commit `.ptk/`, browser profiles, cookies, trace files, screenshots, or sensitive replay bundles.

## Replayable Exports

Normal page-facing exports are evidence-only and redacted. Replayable exports can include cookies, auth headers, CSRF tokens, and request bodies, so they require an explicit privileged SDK transport and a local output path. Agents and provider prompts never receive replayable secret-bearing exports.

See the framework-specific SDK docs for replayable export examples where a privileged transport is available.

## Documentation

- [CLI reference](cli.md)
- [SARIF and severity gates](sarif.md)
- [GitHub Actions](github-actions.md)
- [Configuration files](configuration.md)
- [MCP server](mcp-server.md)
- [Extension loading](extension-loading.md)
- [Authenticated scans](authenticated-scans.md)
- [Scenario-guided scans](scenarios.md)
- [Framework integrations](frameworks.md)
- [Provider integrations](providers.md)
- [Provider browser matrix](provider-browser-matrix.md)
- [Troubleshooting](troubleshooting.md)

## Safety

Run PTK only against systems you own or have explicit permission to test. Start with low route/action budgets in new environments, review output artifacts, then increase budgets as needed.
