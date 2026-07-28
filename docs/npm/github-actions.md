# GitHub Actions

OWASP PTK can run from the `pentestkit` npm package in GitHub Actions and publish SARIF to GitHub Code Scanning.

The core CI command is still `ptk-scan`:

```bash
npx ptk-scan http://localhost:3000 \
  --engine DAST \
  --format sarif \
  --output ptk-results.sarif \
  --fail-on high
```

## Local App DAST

```yaml
name: PTK Security Scan

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  ptk:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          package-manager-cache: false

      - name: Install dependencies
        run: npm ci

      - name: Install browser
        run: npx playwright install chromium --with-deps

      - name: Run app
        run: |
          npm run dev &
          npx wait-on http://localhost:3000

      - name: Run OWASP PTK
        run: |
          npx ptk-scan http://localhost:3000 \
            --engine DAST \
            --format sarif \
            --output ptk-results.sarif \
            --output-dir .ptk/artifacts \
            --fail-on high

      - name: Upload PTK SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: ptk-results.sarif
          category: owasp-ptk

      - name: Upload PTK artifacts
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: ptk-artifacts
          path: .ptk/artifacts
```

## Existing Framework Tests

If your Playwright, Puppeteer, Selenium, or Cypress tests already drive the app, keep that flow and wrap the relevant page/driver with the PTK framework helper. Store the PTK result files as build artifacts, and run a standalone `ptk-scan --format sarif` when you need GitHub Code Scanning output from the CLI.

The package examples are under:

```text
node_modules/pentestkit/examples/github-actions/
```

Source examples:

- `ptk-agent/npm/examples/github-actions/local-app-dast/`
- `ptk-agent/npm/examples/github-actions/playwright-ptk/`
- `ptk-agent/npm/examples/github-actions/sast-js/`

## Official Action Wrapper

The planned marketplace wrapper should be a composite action that installs `pentestkit`, maps its `target` input to `ptk-scan --url`, and leaves SARIF upload as an explicit workflow step:

```yaml
- name: Run OWASP PTK
  uses: ptklabs/owasp-ptk-action@v1
  with:
    target: http://localhost:3000
    engines: DAST
    fail-on: high
    sarif-file: ptk-results.sarif
```

The wrapper must not rename the CLI or own application startup. It should run `ptk-scan`, write SARIF before threshold failure, and let users upload with `github/codeql-action/upload-sarif`.

## Caveats

- Run PTK only against systems you own or are authorized to test.
- `security-events: write` is required for SARIF upload.
- Pull requests from forks may need workflow/security review before repository tokens can upload SARIF.
- DAST findings are runtime findings; source locations appear only when PTK has source evidence.
