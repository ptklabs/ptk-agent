# Hyperbrowser PTK Examples

These examples use the `pentestkit` npm package and Hyperbrowser's official
extension-bearing session API.

Required:

```bash
export HYPERBROWSER_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

Set `HYPERBROWSER_EXTENSION_ID` to reuse an uploaded PTK extension, or leave it
empty so the helper uploads the packaged Chromium automation ZIP and caches the
returned extension id by account and artifact hash.

All examples run DAST, SAST, IAST, and SCA, poll for engine participation,
allow owned same-origin child routes, reject external navigation, export
evidence, and stop the Hyperbrowser session in `finally`.

Run:

```bash
node node_modules/pentestkit/providers/hyperbrowser/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/selenium-juice-shop.mjs
```

Playwright and Puppeteer use Chromium CDP. Hyperbrowser documents Selenium but
currently asks customers to contact support for access, so treat the Selenium
example as a candidate until it passes in your account.
