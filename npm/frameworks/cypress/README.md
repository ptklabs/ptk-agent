# PTK Cypress SDK

Cypress plugin for running PTK security scans during E2E tests.

For shared PTK automation concepts, browser support, extension-loading modes, and profile setup, start with the [framework integration guide](https://github.com/ptklabs/ptk-agent/blob/main/docs/npm/frameworks.md).

Supported startup modes:
- Extension mode: load the bundled PTK extension, or an unpacked source extension from `PTK_EXTENSION_PATH`, through a Cypress-prepared run-local copy.
- Profile mode (Firefox): use an existing profile from `PTK_PROFILE_DIR`.

## Prerequisites

- Node.js 18+
- Cypress 12+
- Bundled PTK browser extension from the `pentestkit` package, or an unpacked source extension via `PTK_EXTENSION_PATH`
- Or a Firefox profile with PTK pre-installed and **Automation Mode** already enabled (profile mode)
- A supported browser (see [Browser Support](#browser-support))

## Installation

### 1. Install the SDK

Install `pentestkit` from the registry:

```bash
npm install -D pentestkit cypress
```

For a local source-built package, build the tarball from `ptk-agent/npm` and install it instead:

```bash
npm install -D /path/to/ptk-agent/npm/.release/npm/pentestkit-*.tgz cypress
```

Both install paths use the same package export:

```javascript
const { setupPtkCypress, registerCommands } = require("pentestkit/cypress");
```

### 2. Register the Plugin

In your `cypress.config.js`:

```javascript
const { defineConfig } = require("cypress");
const { setupPtkCypress } = require("pentestkit/cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: "https://target.example",
    // Required when running one PTK session across multiple tests.
    testIsolation: false,
    setupNodeEvents(on, config) {
      setupPtkCypress(on, config);
      return config;
    },
  },
  env: {
    // Optional automation artifact override. Registry installs use the bundled extension by default.
    // PTK_EXTENSION_PATH: "/path/to/ptk-agent/dist/ptk_extension_unpacked_automation",
    // Profile mode (Firefox only; takes precedence if set)
    // PTK_PROFILE_DIR: "/path/to/firefox/profile",
  },
});
```

For a suite that visits more than the configured `baseUrl` origin, pass the extra AUT origins explicitly:

```javascript
setupNodeEvents(on, config) {
  setupPtkCypress(on, config, {
    allowedOrigins: ["https://example.com", "https://another.example"],
  });
  return config;
}
```

### 3. Register Custom Commands

In your `cypress/support/e2e.js`:

```javascript
const { registerCommands } = require("pentestkit/cypress");
registerCommands();
```

## Browser Support

Cypress defaults to Electron, which **does not support browser extensions**. You must use a real browser.

| Browser | CLI flag | Extension loading | Headless |
|---------|----------|-------------------|----------|
| Chrome for Testing | `--browser chrome-for-testing` | Supported (strict) | Experimental (`PTK_CYPRESS_COMPAT_MODE=experimental`) |
| Chromium | `--browser chromium` | Supported (strict) | Experimental (`PTK_CYPRESS_COMPAT_MODE=experimental`) |
| Edge | `--browser edge` | Supported (strict) | Experimental (`PTK_CYPRESS_COMPAT_MODE=experimental`) |
| Firefox | `--browser firefox` | Supported (strict); profile mode supported | Supported (strict) |
| Electron | (default) | **Not supported** | N/A |
| Chrome 137+ (branded) | `--browser chrome` | **Not supported** | **Not supported** |

### Why not Electron?

Electron is a customized Chromium shell that does not implement the Chrome Extensions API. Browser extensions cannot be loaded.

### Why not branded Chrome 137+?

Chrome 137 removed `--load-extension` support for branded builds. Use **Chrome for Testing** (purpose-built for automation) or **Chromium** instead.

### Running with a supported browser

```bash
# Recommended
npx cypress run --browser chrome-for-testing

# Alternatives
npx cypress run --browser chromium
npx cypress run --browser edge
npx cypress run --browser firefox

# By path
npx cypress run --browser /usr/bin/chromium-browser
```

### Compatibility mode

The plugin uses strict compatibility checks by default:

- `PTK_CYPRESS_COMPAT_MODE=strict` (default): block known-unsupported combinations.
- `PTK_CYPRESS_COMPAT_MODE=experimental`: allow unverified browser/mode combos with warnings.

## Configuration

Configuration is read from `cypress.env.json`, `defineConfig({ env })`, or environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `PTK_EXTENSION_PATH` | Optional path to an unpacked PTK extension source directory (extension mode override) | bundled package extension |
| `PTK_PROFILE_DIR` | Existing Firefox profile with PTK installed and automation enabled | — |
| `PTK_CYPRESS_ALLOWED_ORIGINS` | Additional comma-separated AUT origins when the suite visits more than `baseUrl` | — |
| `PTK_CYPRESS_EXTENSION_DIR` | Optional destination for the generated Cypress run-local extension copy | `.ptk/cypress-extension/<run>` |
| `PTK_PROJECT` | Project name for session | — |
| `PTK_ENGINES` | Engines to activate (comma-separated) | `DAST` |
| `PTK_POLICY_CODE` | Scan policy code | — |
| `PTK_IMMEDIATE_ANALYSIS` | `0`/`false` defers stop-time analysis until import/load/recompute | extension default |
| `PTK_MIN_SCAN_SECONDS` | Keep session open at least this many seconds before ending | `30` |
| `PTK_START_TIMEOUT_MS` | Max wait for `startSession` bridge response | `60000` |
| `PTK_LOGIN_EMAIL` | Example login email used by `examples/juice-shop.cy.js` | `YOUR_USERNAME` |
| `PTK_LOGIN_PASSWORD` | Example login password used by `examples/juice-shop.cy.js` | `YOUR_PASSWORD` |
| `PTK_CYPRESS_COMPAT_MODE` | Compatibility mode: `strict` or `experimental` | `strict` |

For Edge and some Chromium runs, PTK background startup can be slower. Increase start timeout if needed:

```bash
PTK_START_TIMEOUT_MS=120000 npx cypress run --browser edge --headed
```

## Cypress AUT Origins

Cypress runs the application under test inside a Cypress-owned child frame. The normal PTK extension does not expose the automation bridge into arbitrary child frames, so `setupPtkCypress()` creates a run-local extension copy and scopes the bridge to allowed AUT origins.

For normal suites, set `e2e.baseUrl`; the plugin derives the origin automatically. For multi-origin suites, pass `allowedOrigins` or set `PTK_CYPRESS_ALLOWED_ORIGINS`:

```javascript
setupNodeEvents(on, config) {
  setupPtkCypress(on, config, {
    allowedOrigins: ["https://api.example.test"],
  });
  return config;
}
```

The final allowlist is `baseUrl` plus explicit origins. Empty origin lists are rejected; they do not mean "allow all".

Do not edit the bundled ZIP in `node_modules`, the source extension in `pentestkit/src`, or generated CRX/XPI/cache artifacts. The generated copy is test fixture state and should stay out of source control.

## Security Model

The SDK does not expose any command to force-enable automation from page code. Cypress extension mode enables automation through the generated run-local extension copy before the browser launches, and only for the configured AUT origins. If automation is disabled in an existing PTK profile, session commands are blocked.

For secure and stable Cypress runs, use profile mode:
1. Create a dedicated Firefox profile.
2. Install PTK in that profile.
3. Enable Automation Mode once in PTK settings.
4. Run Cypress with `PTK_PROFILE_DIR` pointing to that profile.

```bash
PTK_PROFILE_DIR=/path/to/firefox/profile \
npx cypress run --browser firefox --headless \
  --config-file examples/cypress.config.js \
  --spec examples/juice-shop.cy.js
```

## Custom Commands

### `cy.ptkWaitReady(timeout?)`

Wait until the PTK automation bridge is available. Call after `cy.visit()`.

```javascript
cy.visit("http://localhost:3000");
cy.ptkWaitReady(30000); // 30s timeout (default)
```

### `cy.ptkStartSession(options?)`

Start a PTK scanning session.

```javascript
cy.ptkStartSession({
  project: "my-project",
  engines: ["DAST"],
  policyCode: "my-policy", // optional
});
```

Options default to `PTK_PROJECT`, `PTK_ENGINES`, and `PTK_POLICY_CODE` env values.

### `cy.ptkEndSession(options?)`

End the scanning session and wait for engines to finish.

```javascript
cy.ptkEndSession({
  wait: true,    // wait for completion (default: true)
  maxWait: 300,  // max wait in seconds (default: 600)
});
```

If the bridge supports `getSessionProgress()`, the command polls for progress and detects stuck sessions. Otherwise it blocks until the session ends.

Normal Cypress automation computes PTK analysis when the session stops. Set `immediateAnalysis: false` when the test should stop/export quickly and analysis can be recomputed later in PTK:

```javascript
cy.ptkEndSession({
  wait: true,
  immediateAnalysis: false,
});
```

### `cy.ptkGetStats()`

Get finding statistics.

```javascript
cy.ptkGetStats().then((stats) => {
  cy.log(`Findings: ${stats.findingsCount}`);
});
```

### `cy.ptkGetFindings(limit?)`

Get the findings list.

```javascript
cy.ptkGetFindings(100).then(({ findings, truncated }) => {
  findings.forEach((f) => cy.log(`${f.severity}: ${f.title}`));
});
```

### `cy.ptkExportScan(options?)`

Export scan payload for portal upload.

```javascript
cy.ptkExportScan({ engine: "DAST" }).then((payload) => {
  // Upload to portal
});
```

Cypress AUT-frame export is evidence-only. `includeSecrets`, `exportMode: "replayable"`, or `sensitive: true` are rejected; replayable export must be implemented from a privileged plugin/node-side transport, not from application page JavaScript.

## Example

See `examples/juice-shop.cy.js` for a complete example scanning OWASP Juice Shop.

```bash
docker run -d -p 3001:3000 bkimminich/juice-shop

# Copy or adapt the package example files into your Cypress project:
# node_modules/pentestkit/frameworks/cypress/examples/cypress.config.js
# node_modules/pentestkit/frameworks/cypress/examples/juice-shop.cy.js
# node_modules/pentestkit/frameworks/cypress/examples/support/e2e.js
```

For Chromium-family browsers the wrapper lets `setupPtkCypress()` create the scoped run-local extension copy before launching Cypress. Firefox profile mode keeps using `PTK_PROFILE_DIR`.

The example mirrors the Playwright and Selenium Juice Shop lifecycle: setup PTK in `before`, run the user flow in `it`, collect findings and enforce the Cypress finding gate in `after`, then stop the PTK session. It writes `session_start.json`, `findings.json`, `finding_gate.json`, `engine_gate.json`, `progress-summary.json`, `scan_stop.json`, `session_stats.json`, `framework-run.json`, and `browser-launch.json` under `PTK_ARTIFACTS_DIR` or `.ptk/artifacts/cypress-juice-shop`.

Set `PTK_IMMEDIATE_ANALYSIS=0` when you want to defer stop-time analysis until import/load/recompute in PTK. `PTK_PROFILE_DIR` is supported only for Firefox profile mode; do not set it for Chromium-family Cypress rows.

## Headless CI

For CI pipelines, prefer Firefox headless for strict mode:

```bash
npx cypress run --browser firefox --headless
```

For Chromium-family headless runs, enable experimental compatibility mode:

```bash
npx cypress run --browser chrome-for-testing --headless \
  --env PTK_CYPRESS_COMPAT_MODE=experimental
```

In experimental Chromium headless mode, the plugin normalizes headless args to `--headless=new`.

## Comparison with Playwright and Selenium SDKs

| Feature | Cypress SDK | Playwright SDK | Selenium SDK |
|---------|-------------|----------------|--------------|
| Language | JavaScript | JavaScript | JavaScript |
| Browser management | Cypress plugin hooks | User-created Playwright context | User-created WebDriver |
| Profile management | Cypress-managed; Firefox profile mode supported | User-provided persistent context/profile | User-provided browser profile |
| Extension loading | `launchOptions.extensions` plus Cypress-prepared extension copy | `--load-extension` or provider-preloaded extension | Prepared profile, or direct unpacked loading when the browser accepts it |
| Bridge communication | `cy.window()` | `page.evaluate()` | `execute_async_script()` |
| Tracing | Cypress videos/screenshots | Playwright traces | Driver/browser dependent |
