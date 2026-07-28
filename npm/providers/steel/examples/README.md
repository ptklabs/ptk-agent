# Steel PTK Examples

These examples use the `pentestkit` npm package directly.

Required:

```bash
export STEEL_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

Set `STEEL_EXTENSION_ID` to reuse an uploaded PTK extension, or let the helper upload the packaged automation ZIP and cache the provider extension id.

The helper targets the current `steel-sdk` contract (`>=0.18.0 <1`), uses the
session's returned WebSocket URL, and releases the paid session on setup
failures. The Selenium helper implements Steel's documented `isSelenium`
session and authenticated W3C WebDriver transport, including bounded retries
while the provisioned WebDriver node becomes ready. It also supplies the
packaged CRX through standard ChromeDriver capabilities. Current Steel Cloud
sessions drop both the Steel extension id and ChromeDriver CRX, however, so
the Selenium example is diagnostic and is not a release-supported PTK path.
Playwright and Puppeteer run all four PTK engines with lifecycle polling,
exact-origin scope, export, and cleanup.

For `steel-sdk@0.18.0`, the helper supplies the ZIP as a Node file stream. A
raw `Buffer` is not recognized as uploadable by that SDK release and is
incorrectly expanded into multipart fields.

Run:

```bash
node node_modules/pentestkit/providers/steel/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/selenium-juice-shop.mjs
```

The Selenium command is expected to report `bridge_not_available` until Steel
supports extensions in its Selenium nodes.
