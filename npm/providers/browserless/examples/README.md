# Browserless PTK Examples

Browserless loads PTK Auto by extension name in a Chromium Playwright or Puppeteer session.

Upload the Chromium PTK Auto ZIP in the Browserless dashboard, then set:

```bash
export BROWSERLESS_API_KEY=...
export BROWSERLESS_EXTENSION_NAME=ptk-auto
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

`BROWSERLESS_TOKEN` is accepted as an alias for `BROWSERLESS_API_KEY`.

Run:

```bash
node node_modules/pentestkit/providers/browserless/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserless/examples/puppeteer-juice-shop.mjs
```

Browserless v2 does not expose Selenium/WebDriver, so no Selenium example is provided. Each example enables all four PTK engines, enforces exact-origin scope while allowing same-origin child routes, exports evidence, and closes the remote browser.

See [Browserless browser extensions](https://docs.browserless.io/baas/features/browser-extensions).
