# GitHub Actions Playwright PTK

This example keeps the application journey in Playwright and adds PTK with `pentestkit/playwright`.

Files:

- `playwright-ptk-smoke.mjs`: a minimal Playwright script that loads the bundled PTK extension and wraps a normal page journey with `withPtkScan`.
- `ptk-playwright.yml`: a workflow that starts the app, runs the Playwright PTK script, stores PTK artifacts, and runs `ptk-scan --format sarif` for GitHub Code Scanning.

Copy the workflow into `.github/workflows/` and the script into your test folder, then replace the simple page actions with your real test flow.
