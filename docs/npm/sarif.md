# SARIF And Severity Gates

`ptk-scan` can write SARIF 2.1.0 so PTK findings can be uploaded to GitHub Code Scanning or any SARIF-aware system.

## Write SARIF

```bash
npx ptk-scan http://localhost:3000 \
  --engine DAST \
  --format sarif \
  --output ptk-results.sarif \
  --output-dir .ptk/artifacts
```

When `--format sarif` is used without `--output`, PTK writes `.ptk/artifacts/ptk-results.sarif` or the equivalent path under `--output-dir`.

`--output` also supports JSON when you need a single machine-readable run result:

```bash
npx ptk-scan http://localhost:3000 \
  --format json \
  --output ptk-result.json
```

Normal scan artifacts are still written to `--output-dir`.

## Fail On Severity

Use `--fail-on` to turn findings into a CI gate:

```bash
npx ptk-scan http://localhost:3000 \
  --engine DAST,IAST \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high
```

Supported thresholds:

- `critical`
- `high`
- `medium`
- `low`
- `info`
- `none`

PTK writes SARIF and normal artifacts before returning a non-zero exit code for a threshold failure. The threshold decision is also written to:

```text
.ptk/artifacts/finding-threshold.json
```

Use `--fail-on none` when you want SARIF output without severity gating.

## Locations

SARIF source locations are emitted only when PTK has real source-file evidence. Browser DAST findings are runtime findings, so they use a stable fallback artifact location named `ptk-runtime-findings` and keep the real URL, method, parameter, engine, and severity in SARIF properties and messages.

This avoids pretending a runtime browser finding came from a source file while still producing SARIF that code scanning systems can ingest.

## GitHub Upload

In GitHub Actions, upload the SARIF file even when the scan fails on `--fail-on`:

```yaml
- name: Run OWASP PTK
  run: |
    npx ptk-scan http://localhost:3000 \
      --engine DAST \
      --format sarif \
      --output ptk-results.sarif \
      --fail-on high

- name: Upload PTK SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: ptk-results.sarif
    category: owasp-ptk
```

The workflow needs `security-events: write` permission. Private repository code scanning availability depends on the repository's GitHub Code Security settings.
