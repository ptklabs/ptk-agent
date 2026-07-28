# PTK Agents SDK

PTK Agents SDK is a command-line scanner and crawler for PTK-backed web security exploration. It runs a deterministic crawler by default, can execute scenario files, can drive the PTK browser extension when available, and can optionally use an agent manager after the baseline crawl has run.

The normal product entrypoint is `ptk-scan`. The lower-level `ptk-agent` command exposes the same runtime with separate `crawl`, `scan`, `validate-config`, `modules`, `benchmark`, and `compare` commands.

## Quick Start

From `ptk-agent/npm/agents`:

```bash
npm install
npx playwright install chromium
npm run test:cli-help
```

Run a dry scan to verify config resolution without opening a browser:

```bash
node bin/ptk-scan http://localhost:3001 \
  --max-routes 20 \
  --output-dir .ptk/artifacts/dry-run \
  --dry-run
```

Run a bounded crawl without requiring PTK:

```bash
node bin/ptk-scan http://localhost:3001 \
  --max-routes 40 \
  --max-actions-per-route 1 \
  --max-observation-ms 250 \
  --output-dir .ptk/artifacts/local-crawl
```

Run a PTK-backed scan when the extension is available:

```bash
node bin/ptk-scan http://localhost:3001 \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --max-routes 40 \
  --max-actions-per-route 1 \
  --max-observation-ms 250 \
  --output-dir .ptk/artifacts/ptk-scan
```

Defer stop-time analysis when CI should finish the browser run first and recompute analysis later in PTK:

```bash
node bin/ptk-scan http://localhost:3001 \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --defer-analysis \
  --output-dir .ptk/artifacts/deferred-analysis
```

Use a config file when the scan needs profiles, module settings, CI policy, or repeated options:

```bash
node src/cli/index.cjs validate-config --config examples/ptk.config.json --json
node bin/ptk-scan --config examples/ptk.config.json
```

## Commands

`ptk-scan`

Product scan command. It accepts a target URL or config file, maps scan flags into runtime config, writes artifacts, and runs the same deterministic runtime used by `ptk-agent`.

`ptk-agent crawl`

Runs deterministic crawling against `--url` or `--config`. Use this when you want crawler behavior without the product scan wrapper.

`ptk-agent scan`

Runs a configured scan from `--config`. Use this when CI or another tool already owns the config file.

`ptk-agent validate-config`

Loads a config file, applies CLI overrides, validates the result, and prints the redacted resolved config. It does not launch a browser.

`ptk-agent modules`

Inspects and resolves module packs. Network-backed module downloads are disabled unless explicitly supported by the configured resolver.

`ptk-agent benchmark`

Runs the local benchmark matrix and writes a markdown matrix plus JSON artifacts.

`ptk-agent compare`

Compares two run artifacts using baseline and candidate terminology:

```bash
node src/cli/index.cjs compare \
  --baseline-artifact before.json \
  --candidate-artifact after.json \
  --format text
```

`ptk-agent-mcp-server`

Optional tool-surface entrypoint. It is not required for normal scans.

## How Crawling Works

The crawler is deterministic-first:

- It starts from the target URL, scenario routes, imported hints, and same-origin links.
- Each route has explicit navigation and observation budgets.
- It records links, route shapes, forms, endpoints, requests, GraphQL names, PTK status, browser events, and action effects.
- It attempts only safe interactions by default, such as menus, tabs, search boxes, and bounded form workflows.
- Same-origin document links such as `/ftp/legal.md` are still visited and recorded. Static documents are observed with bounded work so a markdown, text, or file-like page cannot hold the scan forever.
- It does not use `networkidle` as a default wait strategy.
- It does not add hidden long waits.
- It does not treat a high route count as PTK scanner validity. PTK bridge status and findings export validity are separate artifacts.

If the crawler appears to sit on a page, check `crawl-events.jsonl`, `coverage.json`, `timing.json`, and `ptk-lifecycle.json` in the output directory. A valid run should show either a bounded route observation, a blocked scope event, a static document classification, or an explicit timeout/failure reason.

PTK-backed runs also write `ptk-lifecycle-normalized.json`. Use it when export or engine state looks surprising. It records whether export happened before stop, which session lookup source was used, whether report retrieval resolved, whether the findings API fallback was used, raw PTK status samples, normalized engine states, and lifecycle inconsistencies such as SAST waiting for page activity or an export session lookup failure.

## Scan Examples

Dry-run with config output:

```bash
node bin/ptk-scan http://localhost:3001 \
  --max-routes 10 \
  --print-config \
  --output-dir .ptk/artifacts/print-config
```

Scenario-driven crawl:

```bash
node bin/ptk-scan http://localhost:3001 \
  --scenario docs/scenario_juice_shop.md \
  --max-routes 40 \
  --output-dir .ptk/artifacts/scenario
```

Credentials from the environment:

```bash
export PTK_SCAN_USERNAME='YOUR_USERNAME'
export PTK_SCAN_PASSWORD='YOUR_PASSWORD'
node bin/ptk-scan http://localhost:3001 \
  --username "$PTK_SCAN_USERNAME" \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --output-dir .ptk/artifacts/authenticated
```

PTK scan that waits for scanner completion or fails partial completion:

```bash
node bin/ptk-scan http://localhost:3001 \
  --require-ptk-bridge \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --require-ptk-attack-completion \
  --output-dir .ptk/artifacts/ptk-complete
```

When `--require-ptk-findings-export` is set, findings validity requires resolved PTK report export/retrieval. The lighter `getFindings()` API can still be used as diagnostic fallback and is artifacted as `findings-api`, but it does not satisfy strict export validity.

Headed Chromium run with explicit extension path:

```bash
node bin/ptk-scan http://localhost:3001 \
  --headed \
  --browser chromium \
  --ptk-extension-dir ../../src \
  --require-ptk-bridge \
  --output-dir .ptk/artifacts/headed
```

## Flag Reference

Target, config, and output:

| Flag | Meaning |
| --- | --- |
| positional URL | Target URL for `ptk-scan`. |
| `--url <url>` | Target URL override. |
| `--config <path>` | Config file path. CLI options override config values. |
| `--output-dir <dir>` | Artifact output directory. |
| `--dry-run` | Resolve config and write dry-run artifacts without launching a browser. |
| `--print-config` | Print redacted resolved config, engine summary, and CLI mapping summary. |
| `--json` | Print JSON output where supported, mainly `validate-config`. |
| `-h`, `--help` | Show help. |
| `--version` | Print package version for `ptk-agent`. |

Crawler budgets:

Budgets are scoped by operation. Route and action budgets bound exploratory crawling, while scenario steps use their own visible step deadline for intentional workflows such as login, search, feedback, and transfer. A lower-level form submit must not fail just because `--max-action-ms` is small when it is running inside a scenario step. Observation windows remain short and separate from scan completion; PTK engine completion uses the explicit PTK drain options.

| Flag | Meaning |
| --- | --- |
| `--max-routes <n>` | Maximum route visits. |
| `--crawl-pages <n>` | Alias for `--max-routes`. |
| `--crawl-depth <n>` | Maximum discovery depth. Defaults to `5`; menu/submenu traversal uses the same depth budget. |
| `--max-route-ms <ms>` | Per-route navigation budget. |
| `--max-action-ms <ms>` | Per-action budget. |
| `--max-observation-ms <ms>` | Per-observation event window. |
| `--max-actions-per-route <n>` | Safe action attempts per route. |
| `--max-forms-per-route <n>` | Safe form submissions per route. |
| `--max-no-progress-actions <n>` | Stop attempting repeated actions with no coverage delta. |
| `--wait-strategy <name>` | Explicit wait strategy. Defaults stay bounded and do not use `networkidle`. |
| `--route-hints-file <path>` | Seed deterministic crawling with known same-origin routes or API surfaces from JSON. |
| `--open-only` | Open the page without crawling, available on `ptk-agent crawl`. |

Scenario and workflow:

| Flag | Meaning |
| --- | --- |
| `--scenario <path>` | Scenario JSON or markdown file. Markdown is compiled into executable steps. |
| `--scenario-continue-on-failure` | Continue crawl after scenario setup or step failure. The scenario failure remains artifacted. |

Profiles and secrets:

| Flag | Meaning |
| --- | --- |
| `--username <value>` | Active persona username. |
| `--username-env <name>` | Read the active persona username from an environment variable for CI/CD. |
| `--password <value>` | Active persona password. Redacted from artifacts by default. |
| `--password-env <name>` | Read the active persona password from an environment variable. The value is never written to artifacts. |
| `--profile-file <path>` | Profile and crawl-data JSON file. |
| `--crawl-data <path>` | Alias for `--profile-file`. |
| `--persona <id>` | Active persona id from the profile file. |
| `--include-secrets` | Allow local browser execution to use supplied secrets. Artifacts and providers remain redacted by default. |

PTK bridge and findings:

| Flag | Meaning |
| --- | --- |
| `--ptk-extension-dir <dir>` | Unpacked PTK extension directory. Auto-detected in the repository when possible. |
| `--allow-missing-ptk` | Do not mark the run invalid when PTK bridge or findings export is unavailable. |
| `--require-ptk-bridge` | Mark the run invalid if the PTK bridge is missing. |
| `--require-ptk-findings-export` | Mark the run invalid if findings export is unavailable. |
| `--ptk-drain-mode <mode>` | `off`, `brief`, `until-idle`, or `until-complete`. |
| `--ptk-drain-timeout-ms <ms>` | Explicit PTK drain timeout. Long waits are never hidden defaults. |
| `--wait-for-ptk-complete` | Alias for `--ptk-drain-mode until-complete` with a bounded default timeout. |
| `--require-ptk-attack-completion` | Fail when PTK planned tasks remain incomplete or cancelled. |
| `--defer-analysis` | Skip immediate post-stop analysis. Import/load the scan in PTK and recompute later. |
| `--immediate-analysis` | Force immediate post-stop analysis. This is the normal automation default and mainly overrides config. |

Engines and modules:

| Flag | Meaning |
| --- | --- |
| `--engine <list>` | Comma-separated engine list: `DAST`, `IAST`, `SAST`, `SCA`. |
| `--engines <list>` | Same as `--engine`. |

Browser launch:

| Flag | Meaning |
| --- | --- |
| `--browser <name>` | `chromium`, `chrome`, `edge`, or `firefox`. Firefox extension loading fails clearly until supported. |
| `--chrome-binary <path>` | Chrome executable path. |
| `--edge-binary <path>` | Edge executable path. |
| `--firefox-xpi <path>` | Firefox XPI path. Currently rejected unless the runtime supports it. |
| `--profile-dir <path>` | Persistent browser profile directory. Required for extension-loaded persistent contexts. |
| `--headed` | Run headed. |
| `--headless` | Run headless. |

Site memory:

| Flag | Meaning |
| --- | --- |
| `--memory-mode <mode>` | `off`, `read`, or `read-write`. |
| `--memory-storage <dir>` | Site memory storage directory. |
| `--memory-reset` | Clear selected site memory before the run. |

Agent options:

| Flag | Meaning |
| --- | --- |
| `--agent-mode <mode>` | `off`, `mock`, `manager`, `provider`, or `browser`. Defaults to no agent. |
| `--agent-provider <name>` | Provider name, such as `opencode` or `codex`. |
| `--agent-model <name>` | Provider model name. |
| `--max-provider-ms <ms>` | Provider choice budget. |

Benchmark options:

| Flag | Meaning |
| --- | --- |
| `--juice-url <url>` | Juice Shop benchmark target. Default: `http://localhost:3001/`. |
| `--testfire-url <url>` | TestFire benchmark target. Default: `http://localhost:88/`. |
| `--brokencrystals-url <url>` | BrokenCrystals benchmark target. Default: `https://brokencrystals.com/`. |
| `--juice-username <value>` | Juice Shop benchmark username. Default: `YOUR_USERNAME`. |
| `--juice-username-env <name>` | Environment variable containing the Juice Shop benchmark username. |
| `--juice-password-env <name>` | Environment variable containing the Juice Shop benchmark password. |
| `--testfire-username <value>` | TestFire benchmark username. Default: `YOUR_USERNAME`. |
| `--testfire-username-env <name>` | Environment variable containing the TestFire benchmark username. |
| `--testfire-password-env <name>` | Environment variable containing the TestFire benchmark password. |
| `--brokencrystals-username <value>` | BrokenCrystals benchmark username. Default: `YOUR_USERNAME`. |
| `--brokencrystals-username-env <name>` | Environment variable containing the BrokenCrystals benchmark username. |
| `--brokencrystals-password-env <name>` | Environment variable containing the BrokenCrystals benchmark password. |
| `--agent-provider <name>` | `none`, `opencode`, `codex`, or `all`. |
| `--scenario-mode <mode>` | `explicit`, `none`, or `all`. |
| `--opencode-model <model>` | Opencode benchmark model. |
| `--codex-model <model>` | Codex benchmark model. |

The benchmark matrix enables `DAST`, `IAST`, and `SAST` for every target. With credentials configured, `--scenario-mode none` runs an auth-only setup before crawl-only exploration; `--scenario-mode explicit` runs the full benchmark scenario. For CI/CD, prefer the `*-username-env` and `*-password-env` flags so credentials are injected by the environment instead of appearing in commands or job logs.

Lifecycle columns in `test-matrix.md` make PTK export and engine truth visible without opening JSON artifacts. Key columns include `ExportValiditySource`, `FindingsApiFallbackUsed`, `ExportLookupSource`, `ExportRetrievalResolved`, `SASTCollectionState`, `SASTAnalysisState`, `EngineIncomplete`, and `ExportFailureReason`.

Unsupported flags fail explicitly. The scanner should not silently expand policy, browser support, crawler depth, agent behavior, or secret exposure.

## Config File

`examples/ptk.config.json` is the supported starting point. Validate it before use:

```bash
node src/cli/index.cjs validate-config --config examples/ptk.config.json --json
```

Main config sections:

| Section | Purpose |
| --- | --- |
| `target` | Base URL and scope include/exclude rules. |
| `crawler` | Budgets, wait strategy, safe action limits, code-signal settings, and authenticated surface traversal controls. |
| `scenario` | Scenario enablement, file, and failure behavior. |
| `profile` | Persona file, active persona, credentials, and secret-use policy. |
| `ptk` | Extension path, bridge requirements, findings export requirements, drain policy, and stop-time analysis policy. |
| `browser` | Browser name, executable path, profile directory, headless mode, viewport. |
| `engines` | DAST, IAST, SAST, and SCA enablement. |
| `modules` | Module packs, cache, signature policy, and portal token environment name. |
| `memory` | Site memory mode and storage. |
| `agent` | Optional manager/provider settings. |
| `ci` | CI fail policy. |
| `artifacts` | Output directory and artifact secret policy. |

## Profiles And Crawl Data

Profiles let scenarios, login forms, search forms, feedback forms, transfer workflows, and generated fallback values use consistent data.

```bash
node bin/ptk-scan http://localhost:3001 \
  --profile-file examples/crawl-data.json \
  --persona standard-user \
  --scenario docs/scenario_juice_shop.md
```

CLI credentials override the active persona for the current run. Secret values are redacted from resolved config, telemetry, provider context, and artifacts unless a future destination-specific flag explicitly allows that destination.

## PTK Extension And Bridge

PTK-backed scans use `window.PTK_AGENT` in the browser page when the extension is loaded and Automation Mode is enabled.

For Chromium-family browsers, use an unpacked extension path:

```bash
node bin/ptk-scan http://localhost:3001 \
  --browser chromium \
  --ptk-extension-dir ../../src \
  --require-ptk-bridge
```

If bridge detection is required and the launch mode cannot load the extension, the run fails clearly. Missing PTK is never reported as valid zero findings unless you explicitly allow missing PTK.

`window.PTK_AGENT` and the lower-level `window.PTK_AUTOMATION` preserve session lookup diagnostics on status, findings, analysis snapshot, and export calls. If a row reports `session_not_found`, inspect `ptk-lifecycle-normalized.json` for active-tab, completed-tab, explicit-session, global-completed, and retention/eviction details.

SAST lifecycle is normalized into session, collection, and analysis state. A state such as `collectionState=waiting_for_page_activity` with `analysisState=complete` means SAST is waiting for more browser activity, not actively analyzing the same file again.

## Artifacts

Every run writes artifacts to `artifacts.outputDir` or `--output-dir`.

Important artifacts:

| Artifact | Contents |
| --- | --- |
| `resolved-config.json` | Redacted effective config. |
| `timing.json` | Runtime timing and wait budgets. |
| `crawl-summary.json` | Summary counts and status. |
| `crawl-events.jsonl` | Route, action, form, PTK, and recovery events. |
| `coverage.json` | Routes, route shapes, endpoints, forms, actions, evidence, and PTK summaries. |
| `scenario-result.json` | Scenario status when a scenario ran. |
| `browser-summary.json` | Browser name, launch mode, extension mode, and bridge detection mode. |
| `ptk-lifecycle.json` | PTK start, status, drain, stop, export, and attack completion data. |
| `ptk-lifecycle-normalized.json` | Product-scan lifecycle truth: export-before-stop, lookup source, export validity source, raw status samples, engine states, and inconsistencies. |
| `ptk-findings-count.json` | Findings count and severity breakdown when findings are available. |
| `engine-summary.json` | Requested and enabled engines plus PTK application status. |
| `module-resolution.json` | Module pack resolution result. |
| `site-memory.json` | Site memory summary when enabled. |
| `code-signals.json` | Code-signal collection summary when enabled. |
| `analysis-evidence.json` | Imported analysis and route/endpoint hints. |
| `browser-probe-summary.json` | Injected browser probe route/control/event summary. |
| `surface-explorer-summary.json` | Menu, drawer, tab, modal, and safe nested surface traversal summary. |
| `auth-surface-summary.json` | Authenticated surface actions found, executed, blocked, and route discoveries. |
| `agent-manager.json` | Optional agent manager decisions and effects. |

## CI Usage

Recommended PR checks:

```bash
npm test
npm run test:cli-help
npm run validate:example
```

Live scans in CI need a legal target, browser dependencies, and a PTK extension path when PTK validity is required. Use explicit output directories and upload artifacts.

```bash
export PTK_TARGET_URL='https://your-authorized-target.example'
export PTK_EXTENSION_DIR='/path/to/ptk-extension'
node bin/ptk-scan "$PTK_TARGET_URL" \
  --engine DAST,IAST \
  --max-routes 40 \
  --max-actions-per-route 1 \
  --max-observation-ms 250 \
  --ptk-extension-dir "$PTK_EXTENSION_DIR" \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --output-dir .ptk/artifacts/ci-scan
```

## Troubleshooting

`Unknown option`

The CLI rejects unknown flags. Run `node bin/ptk-scan --help` or `node src/cli/index.cjs <command> --help`.

`Missing PTK bridge`

Confirm the extension path, browser launch mode, and Automation Mode. For required PTK scans, inspect `browser-summary.json` and `ptk-lifecycle.json`.

`Findings are invalid`

Findings are invalid when the bridge or export is missing and the run requires them. This is distinct from a valid scan with zero findings.

`Run stops with partial PTK attack completion`

Fast bounded mode can stop before PTK finishes all planned engine work. Use `--wait-for-ptk-complete`, `--ptk-drain-timeout-ms`, and `--require-ptk-attack-completion` when product scan semantics require complete PTK processing.

`Crawler appears stuck on a document link`

Static same-origin documents are allowed, because they may contain useful disclosure. They should be classified and observed with bounded work. Check `crawl-events.jsonl` for static document classification, timeout, or recovery events.

## Related Docs

- [docs/ci-usage.md](docs/ci-usage.md)
- [docs/ptk-automation-and-extension-loading.md](docs/ptk-automation-and-extension-loading.md)
- [docs/scenario_juice_shop.md](docs/scenario_juice_shop.md)
- [docs/scenario_demo.testfire.net.md](docs/scenario_demo.testfire.net.md)
- [docs/scenario_brokencrystals.md](docs/scenario_brokencrystals.md)
- [examples/ptk.config.json](examples/ptk.config.json)
