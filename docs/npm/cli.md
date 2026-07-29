# CLI Reference

The npm package installs three command-line programs:

```bash
npx ptk-scan
npx ptk-agent
npx ptk-agent-mcp-server
```

Use `ptk-scan` first. Use `ptk-agent` when you need lower-level commands or diagnostics.

## `ptk-scan`

`ptk-scan` accepts either a positional URL, `--url`, or `--config`.

```bash
npx ptk-scan https://target.example
npx ptk-scan --url https://target.example
npx ptk-scan --config ptk.config.json
```

By default, scan commands print a concise human summary and write detailed JSON artifacts to the configured output directory. Add `--verbose` when you want the full JSON result on stdout.

The default scan enables the normal browser engines, not every engine. Use `--engine DAST,IAST,SAST,SCA` when you want SAST and SCA included.

Common options:

| Option | Purpose |
| --- | --- |
| `--engine`, `--engines <list>` | Comma-separated `DAST`, `IAST`, `SAST`, `SCA`. |
| `--scenario <path>` | Markdown or JSON scenario file. |
| `--scenario-continue-on-failure` | Continue crawl after scenario failure while artifacting the failure. |
| `--username <value>` | Username for auth/profile workflows. Prefer env vars in CI. |
| `--username-env <name>` | Read username from an environment variable. |
| `--password <value>` | Password for auth/profile workflows. Prefer env vars in CI. |
| `--password-env <name>` | Read password from an environment variable. |
| `--include-secrets` | Allow local browser execution to use supplied secrets. Artifacts/providers stay redacted. |
| `--profile-file <path>` | Profile/crawl-data JSON file. |
| `--persona <id>` | Active persona id from profile data. |
| `--max-routes <n>` | Maximum route visits. |
| `--crawl-pages <n>` | Alias for `--max-routes`. |
| `--crawl-depth <n>` | Maximum discovery depth. |
| `--max-route-ms <ms>` | Per-route navigation/lifecycle budget. |
| `--max-action-ms <ms>` | Per-action budget. |
| `--max-actions-per-route <n>` | Maximum safe actions per route. |
| `--max-forms-per-route <n>` | Maximum safe form submissions per route. |
| `--max-observation-ms <ms>` | Browser observation window. |
| `--route-hints-file <path>` | Seed crawl with same-origin routes/API surfaces. |
| `--browser <name>` | `chromium`, `chrome`, `edge`, or `firefox`. |
| `--headed`, `--headless` | Browser visibility mode. |
| `--profile-dir <path>` | Persistent browser profile directory. |
| `--browser-launch-timeout-ms <ms>` | Browser startup timeout. Default is `30000`. Use `60000` on slow first launches. |
| `--ptk-extension-dir <dir>` | Explicit unpacked PTK extension directory. |
| `--allow-missing-ptk` | Do not fail validity when PTK bridge/export is missing. |
| `--require-ptk-bridge` | Mark run invalid if PTK bridge is missing. |
| `--require-ptk-findings-export` | Mark run invalid if findings export is unavailable. |
| `--ptk-drain-mode <mode>` | `off`, `brief`, `until-idle`, or `until-complete`. |
| `--ptk-drain-timeout-ms <ms>` | PTK drain timeout. |
| `--wait-for-ptk-complete` | Alias for completion-oriented drain mode. |
| `--require-ptk-attack-completion` | Fail when PTK planned attacks are incomplete/cancelled. |
| `--defer-analysis` | Skip immediate post-stop analysis. Import/load the scan in PTK and recompute later. |
| `--immediate-analysis` | Force immediate post-stop analysis. This is the normal automation default and mainly overrides config. |
| `--agent-mode <mode>` | `off`, `mock`, `manager`, `provider`, or `browser`. |
| `--agent-provider <name>` | Provider name such as `opencode` or `codex`. |
| `--agent-model <name>` | Provider model name. |
| `--max-agent-turns <n>` | Agent turns. |
| `--max-provider-ms <ms>` | Provider choice budget. |
| `--aggressive` | Allow business-tier agent/crawler mutations. |
| `--allow-destructive-actions` | Allow destructive-tier actions. Use only in disposable test targets. |
| `--require-agent-success` | Fail scan if agent execution fails. |
| `--format <sarif|json>` | Write an additional machine-readable report. |
| `--output <path>` | Report path for `--format`. SARIF defaults to `ptk-results.sarif` under `--output-dir`. |
| `--fail-on <severity|none>` | Return non-zero when findings meet `critical`, `high`, `medium`, `low`, or `info`. |
| `--dry-run` | Resolve config and write artifacts without launching a browser. |
| `--print-config` | Print redacted resolved config and CLI mapping summary. |
| `--verbose` | Print the full JSON result instead of the concise summary. |
| `--output-dir <dir>` | Artifact output directory. |

Examples:

```bash
npx ptk-scan https://target.example \
  --engine DAST \
  --max-routes 40 \
  --output-dir .ptk/artifacts/dast
```

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --output-dir .ptk/artifacts/strict
```

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --defer-analysis \
  --output-dir .ptk/artifacts/deferred-analysis
```

```bash
npx ptk-scan https://target.example \
  --scenario scenario.md \
  --engine DAST,IAST,SAST,SCA \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --output-dir .ptk/artifacts/scenario
```

Credential flags do not automatically submit login forms during a plain crawl. They provide values for scenario/auth/form steps. Use `--scenario` for authenticated flows.

SARIF and severity gate:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high \
  --output-dir .ptk/artifacts/sarif
```

PTK writes SARIF before returning a non-zero exit code for `--fail-on`. See [SARIF and severity gates](sarif.md).

## `ptk-agent`

`ptk-agent` exposes lower-level commands.

### Global Commands

```bash
npx ptk-agent --help
npx ptk-agent --version
npx ptk-agent --doctor-extension
```

`--doctor-extension` prints JSON describing how the PTK extension resolves.

### `ptk-agent crawl`

Runs deterministic crawling against a URL or config.

```bash
npx ptk-agent crawl --url https://target.example \
  --max-routes 50 \
  --output-dir .ptk/artifacts/crawl
```

Useful options mostly match `ptk-scan`: budgets, browser flags, PTK bridge/export requirements, scenario, credentials, route hints, memory, and agent options.

Special crawl options:

| Option | Purpose |
| --- | --- |
| `--open-only` | Open the page without crawling. |
| `--dry-run` | Resolve config and write dry-run artifacts. |
| `--verbose` | Print the full JSON result instead of the concise summary. |
| `--quiet` | Reduce runtime logging where supported. |

### `ptk-agent scan`

Runs from a config file.

```bash
npx ptk-agent scan --config ptk.config.json \
  --output-dir .ptk/artifacts/config-scan
```

Use this when CI owns a committed config and command-line flags only override selected values.

See [configuration files](configuration.md) for the supported `ptk.config.json` structure.

### `ptk-agent validate-config`

Loads config, applies CLI overrides, validates it, and prints a redacted resolved config.

```bash
npx ptk-agent validate-config --config ptk.config.json --json
```

This command does not launch a browser.

### `ptk-agent modules`

Inspects module pack configuration.

```bash
npx ptk-agent modules list
npx ptk-agent modules resolve --config ptk.config.json
```

Network-backed module downloads are disabled unless explicitly configured by the runtime.

### `ptk-agent compare`

Compares two run artifacts.

```bash
npx ptk-agent compare \
  --baseline-artifact before.json \
  --candidate-artifact after.json \
  --format text
```

Use this in CI to make coverage or finding regressions visible.

## `ptk-agent-mcp-server`

Optional MCP server entrypoint. This is for MCP-capable hosts, not normal scan CLI usage.

```bash
npx ptk-agent-mcp-server --help
npx ptk-agent-mcp-server --list-tools
npx ptk-agent-mcp-server --schema
npx ptk-agent-mcp-server --stdio
```

`--stdio` starts a real MCP stdio server. In that mode stdout is reserved for MCP JSON-RPC messages and logs go to stderr.

Default MCP tools are read-only and redacted. Scan execution is disabled unless the server starts with `--allow-scan`:

```bash
npx ptk-agent-mcp-server --stdio --allow-scan --workspace /absolute/path/to/project
```

See [MCP server](mcp-server.md) for MCP client configuration, default tools, opt-in scan execution, and security rules.

## Node Imports

The package exports:

```js
require("pentestkit");
require("pentestkit/agents");
require("pentestkit/browser");
require("pentestkit/cypress");
require("pentestkit/playwright");
require("pentestkit/puppeteer");
require("pentestkit/selenium");
require("pentestkit/extensions");
require("pentestkit/package.json");
```

Only documented exports are stable. Framework source files are physically packaged under `frameworks/`, but public imports stay at `pentestkit/playwright`, `pentestkit/puppeteer`, `pentestkit/selenium`, and `pentestkit/cypress`.
