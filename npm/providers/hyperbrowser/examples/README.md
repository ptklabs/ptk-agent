# Hyperbrowser PTK Examples

Install the Hyperbrowser SDK and set an authorised target:

```bash
npm install -D @hyperbrowser/sdk
export HYPERBROWSER_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

Set `HYPERBROWSER_EXTENSION_ID` only when you want to reuse PTK Auto already uploaded to the same account.

Run a supported example:

```bash
node node_modules/pentestkit/providers/hyperbrowser/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs
```

The Selenium connector requires Hyperbrowser WebDriver access to be enabled for your account and is therefore a limited path. Each supported example enables all four PTK engines, allows same-origin child routes, blocks unrelated external navigation, exports evidence, and stops the session.

See [Hyperbrowser browser extensions](https://www.hyperbrowser.ai/docs/sessions/extensions).
