# CI Usage

PTK Agents SDK supports both source-tree execution and the published npm package. CI should use supported commands only and treat missing browser/PTK prerequisites as environment failures, not as zero findings.

## Baseline CI Checks

Run these on every pull request:

```bash
npm test
npm run test:cli-help
npm run validate:example
```

`npm run test:cli-help` covers:

- `ptk-agent` CLI help.
- `ptk-scan` product scan help.
- `ptk-agent-mcp-server` optional tool-surface help.

## Config Validation

Validate config before launching a browser:

```bash
node src/cli/index.cjs validate-config --config examples/ptk.config.json
```

Use `--json` when another CI step needs the resolved config:

```bash
node src/cli/index.cjs validate-config --config examples/ptk.config.json --json
```

Resolved config redacts credentials, portal token environment names, and other secret-like fields.

## Product Scan Command

When a target, browser, and PTK extension are available, use supported scan flags only:

```bash
node bin/ptk-scan "$PTK_TARGET_URL" \
  --engine DAST,IAST,SAST \
  --max-routes 40 \
  --crawl-depth 5 \
  --max-actions-per-route 1 \
  --max-observation-ms 250 \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --output-dir .ptk/artifacts/ci-scan
```

Use `--ptk-extension-dir` if auto-detection is not valid in CI:

```bash
node bin/ptk-scan "$PTK_TARGET_URL" \
  --ptk-extension-dir "$PTK_EXTENSION_DIR" \
  --require-ptk-bridge \
  --require-ptk-findings-export
```

Do not pass unsupported flags in CI. Unsupported flags fail explicitly.

## Stop-Time Analysis

Normal `ptk-scan` automation computes PTK analysis when the scan stops. This is the default because it makes Analysis and Attack Paths available immediately in PTK artifacts that include analysis.

Use `--defer-analysis` when CI should stop/export quickly and analysis can be recomputed later after the scan is imported or loaded in PTK:

```bash
node bin/ptk-scan "$PTK_TARGET_URL" \
  --engine DAST,IAST,SAST \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --defer-analysis \
  --output-dir .ptk/artifacts/ci-scan
```

`--immediate-analysis` forces the default behavior again when a config file sets `ptk.immediateAnalysis` to `false`. Finding export validity is still governed by bridge/export settings; deferred analysis only affects post-stop analysis snapshots and recommendation surfaces until recompute.

## Secrets

Use environment variables for credentials:

```bash
export PTK_SCAN_USERNAME='...'
export PTK_SCAN_PASSWORD='...'
node bin/ptk-scan "$PTK_TARGET_URL" \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD
```

`--include-secrets` only allows local SDK/browser execution to use supplied secrets where supported. Artifacts and provider prompts remain redacted by default.

Network-backed module downloads are disabled unless the runtime is explicitly configured for them. Tokens and entitlement metadata must not appear in resolved config, telemetry, logs, or artifacts.

## Authenticated Benchmark Matrix

The benchmark command runs Juice Shop, TestFire, and BrokenCrystals. Use `--scenario-mode all` to run both explicit scenarios and authenticated crawl-only rows. Benchmark rows force DAST, IAST, and SAST on. When credentials are provided, the `none` scenario variant performs a minimal auth-only setup before crawling; it does not run the full user workflow scenario.

```bash
export PTK_JUICE_USERNAME='...'
export PTK_JUICE_PASSWORD='...'
export PTK_TESTFIRE_USERNAME='...'
export PTK_TESTFIRE_PASSWORD='...'
export PTK_BROKENCRYSTALS_USERNAME='...'
export PTK_BROKENCRYSTALS_PASSWORD='...'

node src/cli/index.cjs benchmark \
  --agent-provider none \
  --scenario-mode all \
  --juice-username-env PTK_JUICE_USERNAME \
  --juice-password-env PTK_JUICE_PASSWORD \
  --testfire-username-env PTK_TESTFIRE_USERNAME \
  --testfire-password-env PTK_TESTFIRE_PASSWORD \
  --brokencrystals-username-env PTK_BROKENCRYSTALS_USERNAME \
  --brokencrystals-password-env PTK_BROKENCRYSTALS_PASSWORD
```

## Artifacts

CI should upload the configured artifact directory, commonly `.ptk/artifacts/ci-scan`.

Important files:

- `resolved-config.json`
- `crawl-summary.json`
- `coverage.json`
- `ptk-lifecycle.json`
- `ptk-findings-count.json`
- `engine-summary.json`
- `module-resolution.json`

Finding comparison is valid only when `ptk-lifecycle.json` reports a bridge and findings export.

## GitHub Action

Use [../examples/github-action.yml](../examples/github-action.yml) as the current safe baseline. It runs tests, CLI help, example validation, and package dry-run review. Live browser scans should be added only in CI environments that provide a legal target and PTK extension path.
