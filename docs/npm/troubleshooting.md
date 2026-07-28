# Troubleshooting

## `--doctor-extension` Does Not Report `bundled-package`

Run:

```bash
npx ptk-agent --doctor-extension
```

If the source is `env`, `explicit`, or `local-dev`, check:

```bash
echo "$PTK_EXTENSION_DIR"
echo "$PTK_EXTENSION_PATH"
```

Unset overrides to test bundled resolution:

```bash
unset PTK_EXTENSION_DIR
unset PTK_EXTENSION_PATH
npx ptk-agent --doctor-extension
```

## PTK Bridge Missing

Symptoms:

- scan succeeds but PTK findings are invalid
- `--require-ptk-bridge` fails
- `ptk-lifecycle.json` reports missing bridge

Checks:

1. Make sure a supported browser is used.
2. Run headed once to see extension startup.
3. Verify Automation Mode is enabled for prepared profiles.
4. Confirm the extension path resolves with `--doctor-extension`.
5. Avoid reusing a browser profile that is already open in another browser process.

## Findings Export Missing

If `--require-ptk-findings-export` fails, inspect:

```text
ptk-lifecycle.json
ptk-lifecycle-normalized.json
```

Important fields:

- export attempted before stop
- export success/failure reason
- session lookup source
- findings API fallback usage
- engine incomplete/cancelled state
- SAST collection/analysis state

A valid scan with zero findings is different from an invalid scan where export failed.

## Auth Fails

Use environment variables and include secrets for local browser execution:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='change-me'

npx ptk-scan https://target.example \
  --engine DAST,IAST,SAST,SCA \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --scenario login.md \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000
```

Common causes:

- missing credentials
- placeholder credentials
- rejected credentials
- rate limiting
- account lock
- captcha
- CSRF token mismatch
- target network error

Do not judge crawler or agent value when auth preflight is invalid.

## Browser Launch Fails

Try Chromium first:

```bash
npx ptk-scan https://target.example --browser chromium --headed
```

If the error says the Playwright executable does not exist, install the browser binaries in the project where `pentestkit` is installed:

```bash
npx playwright install chromium
```

For Firefox scans:

```bash
npx playwright install firefox
```

If the error says `browserType.launchPersistentContext: Timeout ... exceeded`, the browser executable exists but the persistent extension profile did not finish starting within the startup budget. First launch after install/reinstall can be slower. Retry once, or increase the startup budget:

```bash
npx ptk-scan https://target.example --browser-launch-timeout-ms 60000
```

If using Edge or Chrome, verify the browser exists and is not blocked by local policy. If using a persistent profile, close all browser windows using that profile before the scan.

## Generated Extension Artifact Fails

If CRX generation fails, make sure Chrome or Chromium is available:

```bash
export CHROME_BIN=/path/to/chrome
```

Then run:

```bash
node -e 'const { ensurePtkCrx } = require("pentestkit/extensions"); console.log(ensurePtkCrx())'
```

If you need a stable Chromium extension id, provide a persistent private key:

```bash
export PTK_CRX_KEY=/secure/path/ptk-automation-crx.pem
```

Do not commit the key. Delete only generated CRX/XPI/cache artifacts when cleaning up; keep the key if stable extension ids matter.

If a provider upload keeps using an old extension id, refresh the upload cache:

```bash
PTK_EXTENSION_UPLOAD_CACHE=refresh node your-provider-test.js
```

Set `PTK_EXTENSION_UPLOAD_CACHE=off` when you want no provider upload cache reads or writes.

## Too Much Or Too Little Crawling

Start with small budgets:

```bash
npx ptk-scan https://target.example \
  --max-routes 20 \
  --max-actions-per-route 1 \
  --max-forms-per-route 0
```

Then increase:

```bash
npx ptk-scan https://target.example \
  --max-routes 100 \
  --crawl-depth 5 \
  --max-actions-per-route 3 \
  --max-forms-per-route 1
```

For business flows, use scenarios rather than only increasing route count.

## Agent Provider Does Not Add Value

First validate the no-agent baseline:

```bash
npx ptk-scan https://target.example \
  --agent-mode off \
  --output-dir .ptk/artifacts/no-agent
```

Then run provider mode:

```bash
npx ptk-scan https://target.example \
  --agent-mode provider \
  --agent-provider opencode \
  --agent-model opencode/big-pickle \
  --max-agent-turns 3 \
  --output-dir .ptk/artifacts/opencode
```

Compare coverage:

```bash
npx ptk-agent compare \
  --baseline-artifact .ptk/artifacts/no-agent/run-summary.json \
  --candidate-artifact .ptk/artifacts/opencode/run-summary.json \
  --format text
```

Agent value can be more routes, forms, endpoints, or business-flow coverage. It does not always mean more findings.

## Clean Local Artifacts

The following are runtime artifacts and should not be committed:

```text
.ptk/
.ptk-agent/
playwright-report/
test-results/
downloads/
videos/
screenshots/
*.trace.zip
*.har
```

Delete them when they are no longer needed.
