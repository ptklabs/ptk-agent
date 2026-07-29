# BrowserStack PTK Example

The supported PTK Agent path on BrowserStack is Selenium with Chrome.

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

Run:

```bash
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

The helper adds the packaged PTK Auto CRX to Chrome capabilities, enables DAST, SAST, IAST, and SCA, enforces the approved origin, exports findings, marks the remote session, and closes it.

Playwright and Puppeteer are not currently supported PTK Auto quick starts on BrowserStack. Use them only with a remote session that you have independently confirmed exposes `window.PTK_AGENT`.

See [BrowserStack Selenium](https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs).
