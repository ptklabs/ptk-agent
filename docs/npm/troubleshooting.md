# Troubleshooting

Use strict bridge and export requirements while diagnosing a scan:

```bash
npx ptk-scan https://your-authorised-target.example \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete
```

These flags turn a missing extension or failed export into a visible command failure.

## Extension Diagnostic Fails

Run:

```bash
npx ptk-agent --doctor-extension
```

A registry installation normally reports `bundled-package`. If it reports an environment or explicit override, check:

```bash
echo "$PTK_EXTENSION_DIR"
echo "$PTK_EXTENSION_PATH"
```

Remove unintended overrides:

```bash
unset PTK_EXTENSION_DIR
unset PTK_EXTENSION_PATH
npx ptk-agent --doctor-extension
```

When intentionally using a custom extension, confirm that the path is absolute, contains `manifest.json`, and points to PTK Auto rather than the full manual extension.

## PTK Bridge Missing

Common symptoms include `PTK bridge not ready`, `--require-ptk-bridge` failure, or lifecycle output that reports no bridge.

Check the following:

1. Use a supported browser and framework combination.
2. Run headed once so extension startup is visible.
3. Close other browser processes using the same automation profile.
4. Confirm PTK Auto is installed in a prepared Firefox or Chrome profile.
5. If using the full OWASP PTK extension, enable Automation Mode in its settings.
6. For cloud browsers, use a combination marked **Supported** in the [provider matrix](provider-browser-matrix.md).

An automation WebSocket, CDP endpoint, or provider session does not install PTK Auto by itself.

## Findings Export Missing

Inspect the lifecycle files in the selected output directory:

```text
ptk-lifecycle.json
ptk-lifecycle-normalized.json
```

Check whether:

- PTK started a session for the expected origin;
- each requested engine participated;
- the session reached a terminal state;
- pending findings were drained before browser close;
- findings export succeeded;
- an engine was cancelled or incomplete.

A completed scan with zero findings is valid. A run where the extension or export failed is not equivalent to zero findings.

## Browser Launch Fails

Try a headed Chromium run first:

```bash
npx ptk-scan https://your-authorised-target.example \
  --browser chromium \
  --headed
```

If Playwright reports that the browser executable is missing:

```bash
npx playwright install chromium
```

For Firefox:

```bash
npx playwright install firefox
```

If the first persistent-browser launch times out, retry once with a larger startup budget:

```bash
npx ptk-scan https://your-authorised-target.example \
  --browser-launch-timeout-ms 60000
```

For Edge or Chrome, confirm that the browser is installed and that local policy permits automation extension loading. If branded Chrome blocks unpacked extensions, use Chromium, Edge, or a prepared Chrome profile.

## Authentication Fails

Provide credentials through environment variables and pair them with a login scenario:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='replace-me'

npx ptk-scan https://your-authorised-target.example \
  --scenario login.md \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets
```

Common causes are rejected or placeholder credentials, account lockout, rate limiting, CAPTCHA, CSRF mismatch, and an unreachable identity provider. Resolve authentication before comparing crawl coverage or findings.

## Remote Provider Cannot Reach The Target

A cloud browser cannot normally access an application bound to your workstation's `localhost`. Use the provider's tunnel or local-testing feature, or deploy the target to an authorised environment reachable from that provider.

Confirm that:

- `PTK_PROVIDER_TARGET_URL` is set explicitly;
- the provider dashboard shows the intended URL;
- redirects remain within the authorised origin;
- the selected provider/framework supports extensions;
- the remote session shows PTK Auto loaded.

See [provider integrations](providers.md).

## Too Much Or Too Little Crawling

Start with conservative limits:

```bash
npx ptk-scan https://your-authorised-target.example \
  --max-routes 20 \
  --max-actions-per-route 1 \
  --max-forms-per-route 0
```

Then increase them deliberately:

```bash
npx ptk-scan https://your-authorised-target.example \
  --max-routes 100 \
  --crawl-depth 5 \
  --max-actions-per-route 3 \
  --max-forms-per-route 1
```

Use a scenario for login, checkout, and other business flows instead of relying only on a larger generic crawl budget.

## Results Contain Sensitive Data

Scan output can contain page evidence, URLs, request metadata, screenshots, traces, and—when explicitly enabled—authentication or replay material.

- Restrict access to local output and provider dashboards.
- Use protected CI artifact storage.
- Apply an appropriate retention policy.
- Redact credentials, cookies, authorisation headers, tokens, and personal data before sharing diagnostics.
- Prefer evidence-only exports unless replay data is specifically required.

If sensitive values were exposed in logs or an issue, revoke or rotate them through the relevant application or provider immediately.

## Getting Help

Include the following safe details in a bug report:

- `pentestkit` version;
- operating system, browser, framework, and provider;
- the command shape with secrets removed;
- redacted `--doctor-extension` output;
- redacted lifecycle status and error code;
- whether the problem reproduces in a headed local Chromium session.

Do not attach unredacted scan evidence or credentials to a public issue. Report suspected security vulnerabilities through a private GitHub security advisory.
