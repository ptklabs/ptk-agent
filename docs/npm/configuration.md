# Configuration Files

Use a config file when a scan needs to be repeatable in CI or shared by a team:

```bash
npx ptk-agent scan --config ptk.config.json
npx ptk-agent validate-config --config ptk.config.json --json
```

`ptk-scan` also accepts the same config file:

```bash
npx ptk-scan --config ptk.config.json
```

The config file is JSON. It is merged with PTK defaults, so you can keep it focused on the values you want to own. Unknown keys are rejected to catch spelling mistakes.

## Minimal Config

```json
{
  "version": "ptk-agent-v2-config",
  "target": {
    "baseUrl": "http://localhost:3001"
  },
  "crawler": {
    "maxRoutes": 100
  },
  "artifacts": {
    "outputDir": ".ptk/artifacts"
  }
}
```

When `target.scope.include` is omitted, PTK scopes the scan to `target.baseUrl/**`.

Validate before running:

```bash
npx ptk-agent validate-config --config ptk.config.json --json
```

## Authenticated Scenario Config

Keep secrets in environment variables, not in committed config files:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='change-me'
```

```json
{
  "version": "ptk-agent-v2-config",
  "target": {
    "baseUrl": "http://localhost:3001"
  },
  "scenario": {
    "enabled": true,
    "file": "ptk-scenario.md"
  },
  "profile": {
    "includeSecrets": false
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
    "drainTimeoutMs": 120000,
    "immediateAnalysis": true
  },
  "crawler": {
    "maxRoutes": 120
  },
  "artifacts": {
    "outputDir": ".ptk/artifacts/scenario"
  }
}
```

For CLI use, prefer passing credentials with `--username-env` and `--password-env` so the config file stays shareable:

```bash
npx ptk-scan --config ptk.config.json \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets
```

`--include-secrets` allows the local browser run to use those environment values while artifacts and provider-visible prompts remain redacted. Credential values alone do not log in. They provide values for scenario/auth/form steps. Use a scenario when the scan must authenticate.

## Common Sections

| Section | Purpose |
| --- | --- |
| `target` | Base URL and scan scope. |
| `crawler` | Crawl budgets, route hints, form policy, code-signal route discovery, and surface exploration. |
| `browserProbe` | Page model and DOM observation limits. |
| `scenario` | Markdown or JSON workflow file. |
| `agent` | Optional mock/provider agent settings. |
| `profile` | Credentials, personas, form values, and workflow data. |
| `memory` | Optional site-memory reuse. |
| `engines` | Enables DAST, IAST, SAST, and SCA. |
| `modules` | Module pack resolution and cache settings. |
| `browser` | Browser type, headed/headless mode, executable path, profile, and viewport. |
| `ptk` | PTK extension bridge/export requirements, drain behavior, and stop-time analysis policy. |
| `artifacts` | Output directory and artifact formats. |
| `ci` | Failure policy for CI gates. |

## Engine Defaults

The default config enables DAST and IAST only:

```json
{
  "engines": {
    "dast": { "enabled": true, "modulePacks": ["free"] },
    "iast": { "enabled": true, "modulePacks": ["free"] },
    "sast": { "enabled": false, "modulePacks": ["free"] },
    "sca": { "enabled": false, "modulePacks": [] }
  }
}
```

Enable all engines explicitly when that is what the run should prove:

```json
{
  "engines": {
    "dast": { "enabled": true, "modulePacks": ["free"] },
    "iast": { "enabled": true, "modulePacks": ["free"] },
    "sast": { "enabled": true, "modulePacks": ["free"] },
    "sca": { "enabled": true, "modulePacks": [] }
  }
}
```

## Browser And Extension Settings

For npm installs, Chromium scans use the bundled automation ZIP and generate an unpacked extension in the local automation cache. Usually you do not need to set `ptk.extensionPath`.

```json
{
  "browser": {
    "name": "chromium",
    "headless": true,
    "launchTimeoutMs": 60000,
    "viewport": {
      "width": 1280,
      "height": 800
    }
  },
  "ptk": {
    "enabled": true,
    "autoDetectExtension": true,
    "requireBridge": true,
    "requireFindingsExport": true,
    "immediateAnalysis": true
  }
}
```

`ptk.immediateAnalysis` defaults to `true` for normal automation. Set it to `false`, or pass `--defer-analysis`, when the run should skip immediate post-stop analysis and recompute later after import/load in PTK.

Use this diagnostic command to confirm what extension path is used:

```bash
npx ptk-agent --doctor-extension
```

## Route Hints

Route hints seed deterministic crawling without changing scope:

```json
{
  "crawler": {
    "routeHints": [
      "/#/login",
      "/#/search?q=apple",
      "/#/basket"
    ]
  }
}
```

Or keep hints in a JSON file:

```json
{
  "crawler": {
    "routeHintsFile": "route-hints.json"
  }
}
```

Relative paths are resolved from the config file location.

## Agent Config

Provider agents are opt-in:

```json
{
  "agent": {
    "enabled": true,
    "mode": "provider",
    "provider": "opencode",
    "model": null,
    "maxTurns": 3,
    "maxStepsPerTurn": 1,
    "maxProviderMs": 60000,
    "riskMode": "safe",
    "allowBusinessMutations": false,
    "allowDestructiveActions": false,
    "requireSuccess": false,
    "fallback": "fail"
  }
}
```

Agent rows remain bounded by the same browser session and PTK export rules. Agents do not receive replayable secret-bearing exports.

## Schema And Example Files

The npm package includes:

- `agents/docs/config.schema.json`
- `agents/examples/ptk.config.json`

From an installed project:

```bash
node -e 'const path=require("path"); const root=path.dirname(require.resolve("pentestkit/package.json")); console.log(path.join(root, "agents/docs/config.schema.json"))'
node -e 'const path=require("path"); const root=path.dirname(require.resolve("pentestkit/package.json")); console.log(path.join(root, "agents/examples/ptk.config.json"))'
```

Use `validate-config` as the source of truth because it applies defaults, resolves relative paths, normalizes budgets, resolves the PTK extension, and redacts secrets in output:

```bash
npx ptk-agent validate-config --config ptk.config.json --json
```
