# PTK Provider Helpers

The `pentestkit/providers/*` modules package provider-specific glue for cloud browser platforms. They use the automation-enabled extension shipped in `pentestkit/extensions/ptk-latest.zip`.

For the full artifact/key/cache explanation, see `docs/npm/extension-loading.md` in the source repository or package documentation. Generated CRX/XPI files, provider upload cache entries, and CRX private keys are runtime artifacts outside `node_modules`.

For the current provider/framework/browser verification snapshot, see `docs/npm/provider-browser-matrix.md` in the package documentation.

Every packaged Node example requests `DAST`, `SAST`, `IAST`, and `SCA`, allows
owned same-origin child routes, rejects cross-origin navigation, polls for
four-engine participation, exports evidence, and closes the provider session
in `finally`. Zero findings and a missing engine are reported differently; the
examples do not use fixed scan sleeps.

Every executable example also requires an explicit target:

```bash
export PTK_PROVIDER_TARGET_URL=https://your-approved-target.example
```

No packaged example silently attacks a public fallback target.

## TestMu Browser Cloud

Install:

```bash
npm install -D pentestkit @testmuai/testmu-cloud playwright puppeteer-core
```

Required env:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
export TESTMU_UPLOAD_EXTENSION=1
```

Playwright session setup:

```js
import { withPtkScan } from "pentestkit/playwright";
import {
  connectTestMuPlaywright
} from "pentestkit/providers/testmu";

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
    project: "my-app-testmu",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".runs/ptk"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    // Existing test starts here.
    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Use `TESTMU_EXTENSION_CLOUD_URL` instead of `TESTMU_UPLOAD_EXTENSION=1` when you already host the packaged PTK extension ZIP. `TESTMU_EXTENSION_ID` is supported only when the ID can be resolved from a persistent TestMu SDK extensions directory, because TestMu IDs are local SDK registry IDs that map to `lambda:loadExtension` URLs.

`@testmuai/testmu-cloud` is the recommended current SDK. The provider helper
still accepts `@testmuai/browser-cloud` for compatibility with existing
installations. When explicit upload is enabled, PTK tries the current SDK
uploader first and uses its curl-backed transport only for recognized upload
transport failures; authentication and authorization failures are returned
without fallback.

TestMu Playwright defaults to the proven CDP route. Native TestMu Playwright can be selected with `TESTMU_PLAYWRIGHT_CONNECT_MODE=playwright` for diagnostics, but the CDP route is the verified path for PTK bridge visibility.

Packaged examples:

```bash
node node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs
cp -R node_modules/pentestkit/providers/testmu/examples/cypress-juice-shop ./ptk-testmu-cypress
K6_BROWSER_ENABLED=true k6 run node_modules/pentestkit/providers/testmu/examples/k6-browser-juice-shop.js
```

The Cypress example is a small TestMu CLI project with `lambdatest-config.json`, `cypress.config.js`, and a Juice Shop spec. Copy it out of `node_modules`, install its dependencies, put TestMu credentials into `lambdatest-config.json`, and run `npm run testmu`.

The k6 Browser example follows TestMu's `wss://cdp.lambdatest.com/k6` flow. k6 cannot import the Node npm SDK, so the script uses `window.PTK_AGENT` directly after the first real application page is available.

## BrowserStack

Install:

```bash
npm install -D pentestkit playwright puppeteer-core selenium-webdriver
```

Required env:

```bash
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Selenium Chrome is the live-verified BrowserStack path. It generates a CRX
locally and embeds it through Chrome capabilities. Playwright and Puppeteer
CDP helpers remain available only for provider diagnostics: BrowserStack
accepted `browserstack.uploadMedia` and created the sessions in the 2026-07-27
matrix, but PTK was not loaded and the bridge was absent.

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserstack/examples/selenium-juice-shop.mjs
```

## Browserbase

Install:

```bash
npm install -D pentestkit playwright puppeteer-core selenium-webdriver
```

Required env:

```bash
export BROWSERBASE_API_KEY=...
```

`BROWSERBASE_PROJECT_ID` is optional; Browserbase can infer it for the API key.

Playwright session setup:

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserbasePlaywright } from "pentestkit/providers/browserbase";

const cloud = await connectBrowserbasePlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "my-app-browserbase",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".runs/ptk"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Set `BROWSERBASE_EXTENSION_ID` to reuse a previously uploaded extension. Without it, the helper uploads `extensions/ptk-latest.zip` and caches the provider extension id.

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserbase/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/browserbase/examples/selenium-juice-shop.mjs
```

## Browserless

Install:

```bash
npm install -D pentestkit playwright puppeteer-core
```

Required env:

```bash
export BROWSERLESS_API_KEY=...
export BROWSERLESS_EXTENSION_NAME=...
```

`BROWSERLESS_TOKEN` is accepted as an alias for `BROWSERLESS_API_KEY`. The extension must already be uploaded in Browserless; the helper passes it through `launch.extensions`.

Use the default timeout unless your Browserless plan documents a higher limit. The verification run passed with `BROWSERLESS_TIMEOUT_MS=60000`.

Packaged examples:

```bash
node node_modules/pentestkit/providers/browserless/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/browserless/examples/puppeteer-juice-shop.mjs
```

Browserless v2 removed Selenium/WebDriver support. PTK extensions on the
current Browserless cloud require Chromium CDP, so there is intentionally no
Browserless Selenium helper.

## Hyperbrowser

Install:

```bash
npm install -D pentestkit @hyperbrowser/sdk playwright puppeteer-core selenium-webdriver
```

Required env:

```bash
export HYPERBROWSER_API_KEY=...
```

Leave `HYPERBROWSER_EXTENSION_ID` empty to upload the packaged automation ZIP
through Hyperbrowser's official SDK and cache the returned extension id. Set it
when you want to reuse an extension already present in the account.

Packaged examples:

```bash
node node_modules/pentestkit/providers/hyperbrowser/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/hyperbrowser/examples/selenium-juice-shop.mjs
```

Playwright and Puppeteer use the extension-bearing Chromium CDP session.
Selenium uses Hyperbrowser's authenticated WebDriver endpoint; the provider
currently asks customers to contact support for Selenium access, so that
example remains a diagnostic until verified in the target account. The
2026-07-27 installed-package matrix passed Playwright and Puppeteer and received
the provider's repeated `selenium server not ready after 5s` response for
Selenium before cleanly releasing the session.

## Steel

Install:

```bash
npm install -D pentestkit steel-sdk playwright puppeteer-core selenium-webdriver
```

Required env:

```bash
export STEEL_API_KEY=...
```

Playwright session setup:

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectSteelPlaywright } from "pentestkit/providers/steel";

const cloud = await connectSteelPlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "my-app-steel",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".runs/ptk"
  }, async ({ page, startPtkScan }) => {
    await page.goto("https://your-approved-target.example/", { waitUntil: "domcontentloaded" });
    await startPtkScan();

    await page.goto("https://your-approved-target.example/#/search?q=test", { waitUntil: "domcontentloaded" });
  });
} finally {
  await cloud.close();
}
```

Set `STEEL_EXTENSION_ID` to reuse a previously uploaded extension. Without it, the helper uploads `extensions/ptk-latest.zip` and caches the provider extension id.

Packaged examples:

```bash
node node_modules/pentestkit/providers/steel/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/selenium-juice-shop.mjs
```

Steel Selenium support is implemented at the W3C transport layer: the helper
creates `isSelenium: true` sessions, authenticates every request, retries the
short WebDriver-node readiness race, and sends the bundled PTK CRX through
ChromeDriver capabilities. In live headless and headful controls on
2026-07-27, Steel created the WebDriver session but installed zero extensions;
the Selenium example therefore remains diagnostic rather than supported.
