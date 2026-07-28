# BrowserStack PTK Examples

These examples use the `pentestkit` npm package directly.

Required:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

Selenium is the live-verified PTK path. It embeds the bundled,
provenance-checked PTK CRX through
Chrome capabilities and passed the 9.9.8 installed-package release matrix.

Run the supported example:

```bash
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

## Experimental CDP diagnostics

The Playwright and Puppeteer files are retained as provider-follow-up
diagnostics, not supported quick starts. In the 2026-07-27 live matrix,
BrowserStack accepted the uploaded ZIP and created both browser sessions but
did not load the PTK bridge. A second run used a harmless minimal MV3 control
extension with the exact documented Windows 10/CDP capabilities; BrowserStack
also installed zero extension targets there. The Playwright failure is
therefore reproducible outside PTK. BrowserStack does not document the same
extension workflow for Puppeteer.

To reproduce that provider limitation, let the helper upload the packaged PTK
ZIP and set `browserstack.uploadMedia`:

```bash
export BROWSERSTACK_UPLOAD_EXTENSION=1
```

To reuse an existing BrowserStack upload, set the returned `media://...` value:

```bash
export BROWSERSTACK_MEDIA_URL=media://...
```

Advanced users can still provide a preloaded websocket endpoint:

```bash
export BROWSERSTACK_PLAYWRIGHT_WS_ENDPOINT=wss://...
export BROWSERSTACK_PUPPETEER_WS_ENDPOINT=wss://...
```

BrowserStack's Chrome extension testing documentation uses CDP mode for
Playwright. The diagnostic helper follows that by default. Set
`BROWSERSTACK_PLAYWRIGHT_CONNECT_MODE=playwright` only when diagnosing
native-protocol behavior.

All examples request DAST, SAST, IAST, and SCA, poll for participation, enforce
exact-origin navigation, export evidence, mark the BrowserStack session, and
close it in `finally`.

Diagnostic commands (expected to fail bridge readiness until BrowserStack
loads PTK in these session types):

```bash
node node_modules/pentestkit/providers/browserstack/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserstack/examples/puppeteer-juice-shop.mjs
```
