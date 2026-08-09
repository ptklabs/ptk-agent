# BrowserStack PTK Examples

PTK Agent supports Playwright, Puppeteer, and Selenium with Chrome on BrowserStack.

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

For Playwright or Puppeteer, either reuse an uploaded extension:

```bash
export BROWSERSTACK_MEDIA_URL=media://...
```

or explicitly allow PTK Agent to upload the packaged artifact once:

```bash
export BROWSERSTACK_UPLOAD_EXTENSION=1
```

Run a supported example:

```bash
node node_modules/pentestkit/providers/browserstack/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserstack/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

The Playwright/Puppeteer upload flow creates BrowserStack's required one-parent-folder ZIP and supplies it only through `browserstack.uploadMedia`; it does not add Chrome extension command-line flags. Selenium supplies the packaged PTK Auto CRX through Chrome capabilities.

Each example enables DAST, SAST, IAST, and SCA, requires `window.PTK_AGENT`, enforces the approved origin, exports findings, marks the remote session, and closes it.

See [BrowserStack Selenium](https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs) and [BrowserStack Playwright extension testing](https://www.browserstack.com/docs/automate/playwright/chrome-extension-testing).
