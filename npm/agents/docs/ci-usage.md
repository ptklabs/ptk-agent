# PTK Agent In CI

Use the published `pentestkit` commands in CI and treat a missing browser, PTK bridge, or findings export as an environment failure rather than a successful scan with zero findings.

## Recommended Job

```bash
npm ci
npx playwright install chromium
npx ptk-agent validate-config --config ptk.config.json --json
npx ptk-scan --config ptk.config.json \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete
```

For Code Scanning and a severity gate:

```bash
npx ptk-scan --config ptk.config.json \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high
```

SARIF is written before the threshold produces a non-zero exit code.

## Credentials

Read application and provider credentials from the CI secret manager:

```bash
npx ptk-scan --config ptk.config.json \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets
```

Use a dedicated test account with the minimum permissions needed for the scenario. Avoid printing resolved environment values or attaching unredacted browser recordings to job logs.

## Results

Upload the configured PTK output directory to protected CI artifact storage. Results can include routes, page observations, PTK lifecycle, findings, screenshots, traces, and replay material. Restrict access and set retention according to your organisation's security policy.

Finding comparisons are valid only when lifecycle evidence confirms both the PTK bridge and final findings export.

## Private Targets

A cloud provider cannot reach an internal or localhost target unless its tunnel or local-testing feature is active. Validate target reachability before interpreting crawl or engine results.

See the public [GitHub Actions guide](../../../docs/npm/github-actions.md), [SARIF guide](../../../docs/npm/sarif.md), and [troubleshooting guide](../../../docs/npm/troubleshooting.md).
