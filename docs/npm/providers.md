# Cloud Browser Providers

PTK Agent provider helpers connect your existing Playwright, Puppeteer, or Selenium journey to a remote browser with PTK Auto loaded. Your test still controls navigation and application actions; PTK wraps that journey with DAST, SAST, IAST, and SCA checks.

Start with the [support matrix](provider-browser-matrix.md). Choose a **Supported** combination for production or CI use.

## Common Setup

Install the package:

```bash
npm install -D pentestkit
```

Some providers also require their official SDK, as shown below. The table's
“Additional package” column lists provider SDKs only. If you select a
Puppeteer connector, install `puppeteer` or `puppeteer-core` explicitly;
`pentestkit` never installs either package automatically.

Set an explicitly authorised target for the packaged examples:

```bash
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

Remote browsers cannot reach `localhost` unless the provider's secure tunnel or local-testing feature is running. PTK examples never fall back to a public target.

Provider credentials belong in environment variables or a CI secret manager. Avoid placing access keys in source files, command arguments, recorded capabilities, or shared logs.

## Common Scan Pattern

Provider connectors return a page or driver plus an idempotent `close()` method:

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserbasePlaywright } from "pentestkit/providers/browserbase";

const cloud = await connectBrowserbasePlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "cloud-security-check",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/cloud-security-check"
  }, async ({ page, startPtkScan }) => {
    await page.goto(process.env.PTK_PROVIDER_TARGET_URL, {
      waitUntil: "domcontentloaded"
    });

    await startPtkScan();

    // Continue the authorised, same-origin application journey here.
  });
} finally {
  await cloud.close();
}
```

Starting PTK after the first application document is available lets the helper bind the session to the correct origin. Same-origin child routes remain eligible; unrelated external navigation is rejected.

## Provider Summary

| Provider | Required variables | Additional package | Supported frameworks |
| --- | --- | --- | --- |
| Browserbase | `BROWSERBASE_API_KEY` | None | Playwright, Puppeteer, Selenium |
| Browserless | `BROWSERLESS_API_KEY`, `BROWSERLESS_EXTENSION_NAME` | None | Playwright, Puppeteer |
| BrowserStack | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` | None | Playwright, Puppeteer, Selenium |
| Hyperbrowser | `HYPERBROWSER_API_KEY` | `@hyperbrowser/sdk` | Playwright, Puppeteer; Selenium is limited |
| Steel | `STEEL_API_KEY` | `steel-sdk` | Playwright, Puppeteer |
| TestMu | `LT_USERNAME`, `LT_ACCESS_KEY` | `@testmuai/testmu-cloud` | Playwright, Puppeteer, Selenium |

## Browserbase

Browserbase accepts a Chromium extension ZIP and makes the resulting extension ID available to Playwright, Puppeteer, and Selenium sessions.

```bash
export BROWSERBASE_API_KEY=...
```

`BROWSERBASE_PROJECT_ID` is optional when Browserbase can infer the project from the API key. Set `BROWSERBASE_EXTENSION_ID` to reuse PTK Auto that is already uploaded to the same account.

Run the packaged examples:

```bash
node node_modules/pentestkit/providers/browserbase/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/selenium-juice-shop.mjs
```

See [Browserbase browser extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions) and [Browserbase Selenium](https://docs.browserbase.com/welcome/quickstarts/selenium).

## Browserless

Upload the packaged Chromium PTK Auto ZIP in the Browserless dashboard, then use its assigned name:

```bash
export BROWSERLESS_API_KEY=...
export BROWSERLESS_EXTENSION_NAME=ptk-auto
```

`BROWSERLESS_TOKEN` is accepted as an alias for `BROWSERLESS_API_KEY`.

Run:

```bash
node node_modules/pentestkit/providers/browserless/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserless/examples/puppeteer-juice-shop.mjs
```

Browserless extension sessions are Chromium-only. Browserless v2 does not provide Selenium/WebDriver, so there is no Browserless Selenium connector.

See [Browserless browser extensions](https://docs.browserless.io/baas/features/browser-extensions).

## BrowserStack

Set BrowserStack credentials and choose whether Playwright/Puppeteer should
reuse or upload PTK Auto:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
export BROWSERSTACK_MEDIA_URL=media://...        # reuse an existing upload
# or: export BROWSERSTACK_UPLOAD_EXTENSION=1     # create one upload

node node_modules/pentestkit/providers/browserstack/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserstack/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

For Playwright and Puppeteer, PTK Agent builds BrowserStack's required ZIP layout with one parent directory above `manifest.json` and supplies only `browserstack.uploadMedia`; it does not add `--load-extension` or `--disable-extensions-except`. A successful connection must also expose `window.PTK_AGENT` in the target page. Selenium supplies the packaged PTK Auto CRX through Chrome capabilities.

All three helpers close the remote session after export.

See [BrowserStack Selenium](https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs) and [BrowserStack Playwright extension testing](https://www.browserstack.com/docs/automate/playwright/chrome-extension-testing).

## Hyperbrowser

Install the official SDK and set your API key:

```bash
npm install -D @hyperbrowser/sdk
export HYPERBROWSER_API_KEY=...
```

PTK Agent uploads the Chromium ZIP and supplies the resulting ID when creating a session. Set `HYPERBROWSER_EXTENSION_ID` to reuse an existing upload.

```bash
node node_modules/pentestkit/providers/hyperbrowser/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs
```

The Selenium connector is limited because Hyperbrowser WebDriver access can require account enablement. Use it only after Hyperbrowser confirms Selenium availability for your account.

See [Hyperbrowser browser extensions](https://www.hyperbrowser.ai/docs/sessions/extensions) and [Hyperbrowser Selenium](https://www.hyperbrowser.ai/docs/sessions/selenium).

## Steel

Install the Steel SDK and set your API key:

```bash
npm install -D steel-sdk
export STEEL_API_KEY=...
```

PTK Agent uploads the Chromium ZIP and attaches the extension ID to Playwright or Puppeteer sessions. Set `STEEL_EXTENSION_ID` to reuse an existing upload.

```bash
node node_modules/pentestkit/providers/steel/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/puppeteer-juice-shop.mjs
```

Steel Selenium is not currently a supported PTK Auto path. Use Playwright or Puppeteer for PTK scans.

See [Steel browser extensions](https://docs.steel.dev/overview/extensions-api/overview), [Steel Playwright](https://docs.steel.dev/integrations/playwright), and [Steel Puppeteer](https://docs.steel.dev/integrations/puppeteer).

## TestMu

Install the TestMu Browser Cloud SDK and set the credentials from your account:

```bash
npm install -D @testmuai/testmu-cloud
export LT_USERNAME=...
export LT_ACCESS_KEY=...
```

For Playwright and Puppeteer, choose one extension source:

```bash
# Let the provider helper upload PTK Auto.
export TESTMU_UPLOAD_EXTENSION=1
```

```bash
# Or use a provider-accessible PTK Auto ZIP URL.
export TESTMU_EXTENSION_CLOUD_URL=https://downloads.example/ptk-auto.zip
```

```bash
# Or reuse an existing TestMu extension entry.
export TESTMU_EXTENSION_ID=...
```

Selenium uses the packaged CRX and does not require an uploaded ZIP URL.

```bash
node node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs
```

The helper tries the current TestMu SDK upload API first and uses the PTK transport fallback only for recognised upload-transport failures. Authentication and authorisation failures are returned directly.

TestMu Cypress and k6 samples are available under `node_modules/pentestkit/providers/testmu/examples/`. They require their provider-specific runners; see the packaged example README before using them.

See [TestMu browser extensions](https://www.testmuai.com/support/docs/browser-cloud-extensions/) and [TestMu Playwright](https://www.testmuai.com/support/docs/playwright-testing/).

## Results And Provider Logs

Cloud session recordings, console logs, network logs, screenshots, and PTK findings can contain application data. Enable only the provider diagnostics you need, restrict access in the provider dashboard, and apply a suitable retention policy.

When reporting a problem, include:

- provider, framework, and browser;
- `pentestkit` version;
- whether the provider dashboard shows PTK Auto loaded;
- the redacted bridge or lifecycle error;
- whether the target was provider-reachable;
- whether session cleanup completed.

Never include provider access keys, application credentials, cookies, authorisation headers, or unredacted replay data in a public issue.
