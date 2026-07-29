# Browserbase PTK Examples

These examples run PTK Auto in Browserbase with Playwright, Puppeteer, or Selenium.

```bash
export BROWSERBASE_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

`BROWSERBASE_PROJECT_ID` is optional when Browserbase can infer the project from your API key. Set `BROWSERBASE_EXTENSION_ID` only when you want to reuse PTK Auto already uploaded to the same account.

Run one framework:

```bash
node node_modules/pentestkit/providers/browserbase/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/selenium-juice-shop.mjs
```

Each example enables DAST, SAST, IAST, and SCA; permits same-origin child routes; rejects unrelated external navigation; exports PTK evidence; and closes the Browserbase session.

See [Browserbase browser extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions).
