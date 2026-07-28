# Browserbase PTK Examples

These examples use the `pentestkit` npm package directly.

Required:

```bash
export BROWSERBASE_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

`BROWSERBASE_PROJECT_ID` is optional and is inferred when the account permits.

Set `BROWSERBASE_EXTENSION_ID` to reuse an uploaded PTK extension, or let the helper upload the packaged automation ZIP and cache the provider extension id.

All examples run DAST, SAST, IAST, and SCA, poll for engine participation,
allow same-origin child routes, reject external navigation, export evidence,
and release the Browserbase session in `finally`.

Run:

```bash
node node_modules/pentestkit/providers/browserbase/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/selenium-juice-shop.mjs
```
