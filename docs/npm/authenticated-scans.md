# Authenticated Scans

Authenticated scans let PTK observe login, authorization boundaries, account pages, and authenticated API traffic. Use dedicated test accounts and targets you are authorized to scan.

## Environment Variables

Prefer environment variables over command-line literals:

```bash
export PTK_SCAN_USERNAME='user@example.test'
export PTK_SCAN_PASSWORD='change-me'
```

Then run:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --max-routes 100 \
  --output-dir .ptk/artifacts/authenticated
```

`--include-secrets` is required when browser execution needs the real values. The SDK still redacts credentials in artifacts and provider-visible prompts by default.

This command is credential-aware crawl, but it is not an automatic login command. Without a scenario, PTK performs a safe crawl and leaves `crawler.forms.allowAuth=false`; login forms may be discovered, but they are not submitted. Use a scenario when the scan must authenticate.

## Scenario Login

Use a scenario to make login explicit:

```markdown
Log in with the provided credentials.
Search for "apple".
Add one visible product to the basket.
Open the basket.
Do not checkout or pay.
```

Run it:

```bash
npx ptk-scan https://target.example \
  --scenario authenticated-flow.md \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --output-dir .ptk/artifacts/auth-scenario
```

## Profile Files

For repeatable workflows, use a profile/crawl-data file:

```json
{
  "version": "ptk-crawl-data-v1",
  "activePersonaId": "buyer",
  "personas": [
    {
      "id": "buyer",
      "credentials": {
        "username": { "env": "PTK_SCAN_USERNAME" },
        "password": { "env": "PTK_SCAN_PASSWORD" }
      },
      "searchTerms": ["apple", "juice"],
      "workflowHints": ["open basket", "submit feedback"]
    }
  ]
}
```

Run:

```bash
npx ptk-scan https://target.example \
  --profile-file ptk-crawl-data.json \
  --persona buyer \
  --include-secrets \
  --scenario authenticated-flow.md
```

## Auth Preflight And Failures

When scenarios require login, failed authentication is treated differently from crawler failure. Common classifications include:

- credentials missing or placeholder
- target rejected credentials
- rate limited
- account locked
- captcha blocked
- CSRF missing
- network error

Do not compare scan coverage or agent value when the deterministic auth/scenario baseline is invalid.

## Protect Credentials And Evidence

- Supply credentials through environment variables or a CI secret manager.
- Use a dedicated test account with the minimum permissions needed for the scenario.
- Restrict access to browser profiles, cookies, traces, screenshots, videos, and replayable exports.
- Apply an appropriate retention policy to local and CI scan outputs.
- Agents and providers receive sanitised observations and redacted evidence by default.
- Replayable secret-bearing exports require an explicit privileged SDK path and should be encrypted and tightly access-controlled.
