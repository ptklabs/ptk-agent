# TestMu Cypress Juice Shop With PTK

This is a minimal Cypress project for TestMu's `lambdatest-cypress-cli` flow. It follows the provider model: `lambdatest-config.json` describes the TestMu run, `cypress.config.js` loads the PTK Cypress plugin, and the spec runs a normal Juice Shop journey with PTK enabled.

## Install

Copy this folder into an application project or run it as a standalone sample, then install dependencies:

```bash
npm install
```

If you prefer the global CLI flow from the TestMu docs:

```bash
npm install -g lambdatest-cypress-cli
npm install -D pentestkit cypress
```

## Credentials

Set the credentials shown in the TestMu dashboard:

```bash
export LT_USERNAME="..."
export LT_ACCESS_KEY="..."
```

Then update `lambdatest-config.json`:

```json
"lambdatest_auth": {
  "username": "<Your LambdaTest username>",
  "access_key": "<Your LambdaTest access key>"
}
```

Keep the file out of source control when real credentials are written into it.

Select the explicitly approved provider-reachable target:

```bash
export PTK_PROVIDER_TARGET_URL="https://your-approved-target.example"
```

## Run

```bash
npm run testmu
```

or:

```bash
lambdatest-cypress run
```

For private or localhost targets, enable the TestMu tunnel in `lambdatest-config.json`.

## PTK Notes

PTK Cypress loads the automation-enabled extension from the `pentestkit` package and scopes the automation bridge to the configured `baseUrl` origin.

The default browser is Edge because branded Chrome 137+ no longer supports extension loading through Cypress in strict mode. If your TestMu account exposes Chrome for Testing or Chromium for Cypress, you can switch the browser matrix to that supported image. Avoid the default branded Chrome image unless `PTK_CYPRESS_COMPAT_MODE=experimental` is acceptable for a diagnostic run.

PTK-specific files:

- `cypress.config.js` calls `setupPtkCypress(on, config)`.
- `cypress/support/e2e.js` registers PTK Cypress commands.
- `cypress/e2e/juice-shop-with-ptk.cy.js` starts PTK after the first Juice Shop page is loaded and stops it after the test journey.
