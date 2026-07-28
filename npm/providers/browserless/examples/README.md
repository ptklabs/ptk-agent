# Browserless PTK Examples

These examples use the `pentestkit` npm package directly.

Required:

```bash
export BROWSERLESS_API_KEY=...
export BROWSERLESS_EXTENSION_NAME=...
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

`BROWSERLESS_TOKEN` is accepted as an alias for `BROWSERLESS_API_KEY`. The extension must already be uploaded in Browserless. The provider helper passes it through `launch.extensions`.

Browserless PTK sessions use the Chromium root or `/chromium` CDP endpoint and
the extension-bearing default context. The examples run all four PTK engines,
poll for participation, enforce exact-origin navigation, export evidence, and
close the remote browser in `finally`.

Browserless Cloud v2 does not expose Selenium/WebDriver. Its current extension
support is limited to Chromium CDP through Playwright, Puppeteer, or BQL, so the
package intentionally does not offer a Browserless Selenium connector.

Run:

```bash
node node_modules/pentestkit/providers/browserless/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserless/examples/puppeteer-juice-shop.mjs
```
