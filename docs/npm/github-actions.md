# GitHub Actions

The official [`ptklabs/ptk-action`](https://github.com/ptklabs/ptk-action)
wrapper is the recommended way to run the `pentestkit` npm package in a GitHub
Actions browser session. The Action runs PTK, preserves normal artifacts, and
returns a SARIF path for an explicit GitHub Code Scanning upload.

## Recommended workflow

Start the application before the PTK step. The Action does not build or start
your target.

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
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6

      - name: Install and start the application
        run: |
          npm ci
          npm run start:test &
          for attempt in {1..60}; do
            if curl --fail --silent http://127.0.0.1:3000 >/dev/null; then
              exit 0
            fi
            sleep 1
          done
          exit 1

      - name: Run OWASP PTK
        id: ptk
        uses: ptklabs/ptk-action@v1
        with:
          target: http://127.0.0.1:3000
          engines: DAST,IAST,SAST,SCA
          fail-on: high

      - name: Upload PTK SARIF
        if: always() && steps.ptk.outputs.sarif-file != ''
        uses: github/codeql-action/upload-sarif@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81 # v4
        with:
          sarif_file: ${{ steps.ptk.outputs.sarif-file }}
          category: owasp-ptk

      - name: Upload PTK artifacts
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: ptk-artifacts
          path: ${{ steps.ptk.outputs.output-dir }}
          if-no-files-found: error
```

The maintained `v1` tag follows compatible v1 releases. Pin
`ptklabs/ptk-action` to a full release commit SHA when your dependency policy
requires an immutable Action reference.

The Action's
[README](https://github.com/ptklabs/ptk-action#readme) is the source of truth
for supported runners, inputs, authentication, outputs, and complete examples.

## Direct CLI workflow

Use the CLI directly when you need to control package installation and browser
setup yourself:

```bash
npx playwright install chromium --with-deps
xvfb-run --auto-servernum npx ptk-scan http://127.0.0.1:3000 \
  --engines DAST,IAST,SAST,SCA \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --require-ptk-attack-completion \
  --format sarif \
  --output ptk-results.sarif \
  --output-dir .ptk/artifacts \
  --fail-on high
```

PTK writes SARIF before applying the `--fail-on` threshold, so a workflow can
upload the report from an `always()` step even when the security gate fails.

## Existing framework tests

If Playwright, Puppeteer, Selenium, or Cypress tests already drive your
application, wrap the relevant page or driver with the PTK framework helper and
store its result files as workflow artifacts. Run a standalone
`ptk-scan --format sarif` when the same job also needs GitHub Code Scanning
output.

Package examples are installed under:

```text
node_modules/pentestkit/examples/github-actions/
```

## Notes

- Run PTK only against systems you own or are authorized to test.
- `security-events: write` is required for Code Scanning SARIF upload.
- Pull requests from forks may need workflow and token-policy review before
  SARIF can be uploaded.
- DAST findings are runtime findings; source locations appear only when PTK has
  source evidence.
