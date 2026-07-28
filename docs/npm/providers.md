# Provider Integrations

The npm package includes provider helpers under `pentestkit/providers/*`. They are small adapters around the provider's own connection model: create or connect to a cloud browser session, make sure PTK is loaded, then pass the normal page or driver to `withPtkScan()`.

Provider helpers do not own the test journey. Open your normal application URL in your test and start PTK after the first real application page is available.

For the current provider/framework/browser verification snapshot, see [provider browser matrix](provider-browser-matrix.md).

## Local Credential File

For local live-provider testing from the source repository, copy the committed
`.env.example` file to `.env` and fill only the providers you want to run.
`.env` and its values are ignored by Git; `.env.example` contains names and safe
defaults only. Load it explicitly with Node.js rather than adding a dotenv
runtime dependency:

```bash
node --env-file=.env path/to/provider-test.mjs
```

Do not use a localhost target with a remote browser unless the provider tunnel
is configured. The template requires an explicit approved provider-reachable
target and does not silently fall back to a public site.
Browserless additionally requires the name or id of a PTK extension that has
already been uploaded to the Browserless account.

The packaged Node examples request `DAST`, `SAST`, `IAST`, and `SCA`; poll for
participation instead of sleeping for a fixed duration; permit owned
same-origin child routes; reject cross-origin navigation; export evidence; and
always close the provider connection. Zero findings and a missing engine are
reported separately.

Set the target explicitly before running any packaged example:

```bash
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

The examples do not contain a public fallback target.

## Extension Formats By Provider

| Provider/framework | PTK artifact path |
| --- | --- |
| TestMu Playwright/Puppeteer | uploaded or hosted ZIP from `extensions/ptk-latest.zip` |
| TestMu Selenium | bundled, provenance-checked CRX embedded in Selenium capabilities |
| TestMu k6 Browser | `window.PTK_AGENT` only if PTK is preloaded in the provider browser session |
| BrowserStack Selenium | bundled, provenance-checked CRX embedded in Selenium capabilities |
| BrowserStack Playwright/Puppeteer diagnostics | BrowserStack upload-media `media://...` value passed as `browserstack.uploadMedia`; current live sessions expose zero extension targets |
| Browserbase | uploaded ZIP, resolved to provider extension id |
| Browserless Playwright/Puppeteer | already-uploaded Browserless extension name/id passed through `launch.extensions` |
| Hyperbrowser Playwright/Puppeteer/Selenium | uploaded ZIP, resolved to an extension id and passed through session `extensionIds` |
| Steel Playwright/Puppeteer | uploaded ZIP, resolved to provider extension id |
| Steel Selenium diagnostic | `isSelenium` plus authenticated W3C transport and bundled CRX; current Steel Cloud nodes install zero extensions |

The reviewed automation CRX is bundled in the package. Any fallback-generated
CRX/XPI files, upload cache entries, and CRX private keys live outside
`node_modules`; see [extension loading](extension-loading.md).

## TestMu Browser Cloud

Install:

```bash
npm install -D pentestkit @testmuai/testmu-cloud playwright puppeteer-core selenium-webdriver
```

Required credentials:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
```

For Playwright and Puppeteer, provide the PTK extension to TestMu in one of three ways:

```bash
export TESTMU_EXTENSION_CLOUD_URL="https://.../ptk-latest.zip"
```

or:

```bash
export TESTMU_UPLOAD_EXTENSION=1
```

or, when you already have a TestMu SDK extension registry entry:

```bash
export TESTMU_EXTENSION_ID=...
export TESTMU_EXTENSIONS_DIR=/path/to/testmu/extensions-metadata
```

`TESTMU_EXTENSION_ID` is a TestMu SDK registry id, not a browser extension id. It must resolve to a `lambda:loadExtension` URL through TestMu SDK metadata. If that metadata is unavailable, use `TESTMU_EXTENSION_CLOUD_URL` or `TESTMU_UPLOAD_EXTENSION=1`.

The adapter prefers the current `@testmuai/testmu-cloud` SDK and accepts the
former `@testmuai/browser-cloud` package for compatibility. With explicit
upload enabled, it calls the current SDK uploader first. PTK's existing
curl-backed upload is retained only as a bounded fallback for recognized
upload transport failures; authentication and authorization failures never
fall back.

Playwright:

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectTestMuPlaywright } from "pentestkit/providers/testmu";

const cloud = await connectTestMuPlaywright({
  capabilities: {
    browserName: "Chrome",
    browserVersion: "latest",
    "LT:Options": {
      platform: "Windows 10",
      build: "PTK Playwright Build",
      name: "PTK Playwright",
      user: process.env.LT_USERNAME,
      accessKey: process.env.LT_ACCESS_KEY,
      network: true,
      video: true,
      console: true
    }
  }
});

try {
  await withPtkScan(cloud.page, {
    project: "testmu-playwright",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/testmu-playwright"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    // Existing test steps continue here.
    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Packaged TestMu examples:

- `node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs`
- `node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs`
- `node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs`
- `node_modules/pentestkit/providers/testmu/examples/cypress-juice-shop/`
- `node_modules/pentestkit/providers/testmu/examples/k6-browser-juice-shop.js`
- `node_modules/pentestkit/providers/testmu/examples/README.md`

Run them from an installed project:

```bash
node node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs
```

TestMu Cypress uses the provider's `lambdatest-cypress-cli` workflow:

```bash
cp -R node_modules/pentestkit/providers/testmu/examples/cypress-juice-shop ./ptk-testmu-cypress
cd ./ptk-testmu-cypress
npm install
# write LT_USERNAME/LT_ACCESS_KEY into lambdatest-config.json
npm run testmu
```

The Cypress example keeps the TestMu config visible in `lambdatest-config.json` and adds PTK only through `cypress.config.js` plus `cypress/support/e2e.js`. It defaults to Edge because PTK Cypress strict mode rejects branded Chrome 137+ extension loading; use Chrome for Testing or Chromium if your TestMu Cypress account exposes those images.

TestMu k6 Browser uses the k6 runtime and CDP endpoint:

```bash
K6_BROWSER_ENABLED=true k6 run node_modules/pentestkit/providers/testmu/examples/k6-browser-juice-shop.js
```

k6 scripts cannot import `pentestkit` from npm, so the packaged script starts PTK through `window.PTK_AGENT` after the first real application page is available. The current TestMu k6 Browser documentation does not show an extension upload/preload capability; the browser session must already have PTK loaded and automation enabled.

TestMu Playwright defaults to the CDP transport because that is the verified path for PTK bridge visibility. Set `TESTMU_PLAYWRIGHT_CONNECT_MODE=playwright` only when diagnosing native TestMu Playwright behavior.

## BrowserStack

Install:

```bash
npm install -D pentestkit playwright puppeteer-core selenium-webdriver
```

Required credentials:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Selenium uses the bundled, provenance-checked CRX embedded in Chrome capabilities:

```js
import { withPtkScan } from "pentestkit/selenium";
import { connectBrowserStackSelenium } from "pentestkit/providers/browserstack";

const cloud = await connectBrowserStackSelenium({
  build: "PTK Selenium Build",
  name: "PTK Selenium"
});

try {
  await withPtkScan(cloud.driver, {
    project: "browserstack-selenium",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/browserstack-selenium"
  }, async ({ driver, startPtkScan }) => {
    await driver.get("https://your-approved-target.example/#/");
    await startPtkScan();

    // Existing test steps continue here.
    await driver.get("https://your-approved-target.example/#/search?q=test");
  });
} finally {
  await cloud.close();
}
```

Playwright and Puppeteer helpers remain available for BrowserStack CDP
diagnostics. BrowserStack's documented Chrome extension flow uploads a ZIP
through `automate/upload-media`, then passes the returned `media://...` value
in the top-level `browserstack.uploadMedia` capability. In the 2026-07-27 live
matrix those sessions started but PTK was not loaded, so these paths are not
advertised as supported. The exact documented Windows 10 Playwright contract
also installed zero targets for a harmless minimal MV3 control extension, so
the observed failure is not specific to PTK. BrowserStack does not currently
document this extension flow for Puppeteer. To reproduce the provider
limitation, let the helper
upload the packaged PTK ZIP:

```bash
export BROWSERSTACK_UPLOAD_EXTENSION=1
```

To reuse an existing BrowserStack upload:

```bash
export BROWSERSTACK_MEDIA_URL=media://...
```

Advanced users can still provide a preloaded websocket endpoint:

```bash
export BROWSERSTACK_PLAYWRIGHT_WS_ENDPOINT=wss://...
export BROWSERSTACK_PUPPETEER_WS_ENDPOINT=wss://...
```

Set `BROWSERSTACK_REQUIRE_EXTENSION=false` only when you intentionally connect to a session that does not load PTK.

BrowserStack's extension-testing documentation uses CDP mode for Playwright.
The diagnostic helper follows that by default; set
`BROWSERSTACK_PLAYWRIGHT_CONNECT_MODE=playwright` only for native-protocol
diagnostics.

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

## Browserbase

Install:

```bash
npm install -D pentestkit playwright puppeteer-core selenium-webdriver
```

Required credentials:

```bash
export BROWSERBASE_API_KEY=...
```

`BROWSERBASE_PROJECT_ID` is optional; Browserbase can infer the project from
the API key when the account permits it.

Browserbase uploads the packaged ZIP and returns an extension id. Reuse an existing id with `BROWSERBASE_EXTENSION_ID`.

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserbasePlaywright } from "pentestkit/providers/browserbase";

const cloud = await connectBrowserbasePlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "browserbase-playwright",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/browserbase-playwright"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserbase/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/selenium-juice-shop.mjs
```

Useful env vars:

- `BROWSERBASE_EXTENSION_ID`
- `BROWSERBASE_REGION`
- `BROWSERBASE_TIMEOUT_SECONDS`
- `BROWSERBASE_SELENIUM_SCRIPT_TIMEOUT_MS` (default `120000`; keeps PTK stop/export inside the remote async-script command)
- `PTK_EXTENSION_UPLOAD_CACHE`

## Browserless

Install:

```bash
npm install -D pentestkit playwright puppeteer-core
```

Required credentials:

```bash
export BROWSERLESS_API_KEY=...
export BROWSERLESS_EXTENSION_NAME=...
```

`BROWSERLESS_TOKEN` is accepted as an alias for `BROWSERLESS_API_KEY`. The extension must already be uploaded in Browserless; the helper passes it through `launch.extensions`.

Use the default timeout unless your Browserless plan documents a higher limit. The verification run passed with `BROWSERLESS_TIMEOUT_MS=60000`; a larger timeout was rejected by the provider account used for testing.

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserlessPlaywright } from "pentestkit/providers/browserless";

const cloud = await connectBrowserlessPlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "browserless-playwright",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/browserless-playwright"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserless/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserless/examples/puppeteer-juice-shop.mjs
```

Browserless v2 removed Selenium/WebDriver support. Its current extension path
requires Chromium CDP through Playwright or Puppeteer, so the package does not
offer a Browserless Selenium connector.

## Hyperbrowser

Install:

```bash
npm install -D pentestkit @hyperbrowser/sdk playwright puppeteer-core selenium-webdriver
```

Required credentials:

```bash
export HYPERBROWSER_API_KEY=...
```

The helper uploads the packaged Chromium automation ZIP through the official
`extensions.create({ filePath, name })` SDK method, caches the returned id by
account and immutable artifact hash, and supplies it to new sessions through
`extensionIds`. Set `HYPERBROWSER_EXTENSION_ID` to reuse an extension that is
already uploaded. Hyperbrowser requires the ZIP to contain `manifest.json` at
its root and documents an 8 MB upload limit; the helper validates both the PTK
artifact format and size before making a paid provider request.

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectHyperbrowserPlaywright } from "pentestkit/providers/hyperbrowser";

const cloud = await connectHyperbrowserPlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "hyperbrowser-playwright",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/hyperbrowser-playwright"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Packaged examples:

```bash
node node_modules/pentestkit/providers/hyperbrowser/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/selenium-juice-shop.mjs
```

Playwright and Puppeteer connect to the provider-returned `wsEndpoint` over
Chromium CDP. Selenium uses `webdriverEndpoint` and attaches the short-lived
`x-hyperbrowser-token` header to every WebDriver request. It retries only the
provider's exact bounded `selenium server not ready` startup response. Hyperbrowser's current
documentation asks customers to contact support for Selenium access, so do not
treat that row as supported until it passes in the intended account. The
2026-07-27 live account returned that same readiness response for all six
bounded attempts; Playwright and Puppeteer both passed the complete PTK gate.

Useful env vars:

- `HYPERBROWSER_EXTENSION_ID`
- `HYPERBROWSER_REQUEST_TIMEOUT_MS` (default SDK timeout `30000`)
- `HYPERBROWSER_SELENIUM_SCRIPT_TIMEOUT_MS` (default `120000`)
- `PTK_EXTENSION_UPLOAD_CACHE`

## Steel

Install:

```bash
npm install -D pentestkit steel-sdk playwright puppeteer-core selenium-webdriver
```

Required credentials:

```bash
export STEEL_API_KEY=...
```

Steel uploads the packaged ZIP and returns an extension id. Reuse an existing id with `STEEL_EXTENSION_ID`.
The adapter uses the `steel-sdk@0.18.0` file-stream upload path; passing that
SDK a raw ZIP `Buffer` causes it to recursively expand the bytes as multipart
fields.

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectSteelPlaywright } from "pentestkit/providers/steel";

const cloud = await connectSteelPlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "steel-playwright",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/steel-playwright"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Packaged examples:

```bash
node node_modules/pentestkit/providers/steel/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/selenium-juice-shop.mjs
```

The Selenium helper implements Steel's documented `isSelenium` provisioning,
adds the API-key and session-id headers to every W3C request, retries only the
observed transient WebDriver-node startup refusal, and supplies the bundled
CRX through ChromeDriver capabilities. Steel Cloud nevertheless installed zero
extensions in both headless and headful live controls on 2026-07-27. Keep this
example as a provider diagnostic; use Playwright or Puppeteer for PTK scans.

Useful env vars:

- `STEEL_EXTENSION_ID`
- `STEEL_UPLOAD_TIMEOUT_MS`
- `STEEL_UPLOAD_MAX_RETRIES`
- `STEEL_TIMEOUT_MS`
- `STEEL_SELENIUM_URL` (defaults to the TLS endpoint `https://connect.steelbrowser.com/selenium`)
- `STEEL_SELENIUM_SCRIPT_TIMEOUT_MS` (default `120000`)
- `STEEL_SELENIUM_READINESS_TIMEOUT_MS` (default `45000`)
- `PTK_EXTENSION_UPLOAD_CACHE`

## Provider Cache And Secrets

Provider upload IDs are cached under
`.ptk/provider-cache/<provider>/scope-<opaque-account-fingerprint>/` by
default. The path combines an irreversible account-context fingerprint with
the packaged ZIP hash, so changing provider accounts cannot reuse another
account's extension id. Do not commit provider cache files, credentials,
browser profiles, generated CRX/XPI files, or CRX private keys.

Use provider-native secret storage for credentials. The examples read credentials from environment variables and never hard-code access keys.
