# Framework Integrations

The npm package contains the Node CLI, shared browser helpers, Playwright JavaScript helpers, Selenium JavaScript helpers, Cypress integration, Puppeteer integration, and bundled extension artifacts.

All browser-framework helpers assume your browser has PTK Auto loaded. If you deliberately use the separate full extension instead, enable its Automation Mode setting. The helpers do not replace your test script; they add a small wrapper around the flow you already run.

Public imports stay at `pentestkit/playwright`, `pentestkit/puppeteer`, `pentestkit/selenium`, and `pentestkit/cypress`. In the installed package, framework files and examples are physically stored under `node_modules/pentestkit/frameworks/`.

## Shared Browser API

Use `pentestkit/browser` when a framework exposes a Playwright-like page object with `evaluate()`:

```js
import { withPtkScan } from "pentestkit/browser";

await withPtkScan(page, {
  project: "checkout-flow",
  engines: ["DAST", "IAST"],
  resultsDir: ".ptk/results/checkout"
}, async () => {
  await page.goto("https://target.example");
  await page.getByRole("button", { name: "Search" }).click();
});
```

The same module exports `waitForPtk`, `createPtkBridge`, `collectPtkResults`, `writePtkResults`, and `countFindings`.

## Playwright JavaScript

Install in a Playwright project:

```bash
npm install -D pentestkit playwright
```

Use the Playwright wrapper after launching a browser/context with PTK loaded:

```js
import { chromium } from "playwright";
import { ensureUnpackedPtkExtension } from "pentestkit/extensions";
import { withPtkScan } from "pentestkit/playwright";

const extensionPath = ensureUnpackedPtkExtension().path;

const context = await chromium.launchPersistentContext(".ptk-profile", {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});
const page = context.pages()[0] || await context.newPage();

await withPtkScan(page, {
  project: "playwright-flow",
  engines: ["DAST", "IAST"],
  resultsDir: ".ptk/results/playwright"
}, async () => {
  await page.goto("https://target.example");
  await page.locator("input[type=search]").fill("test");
  await page.keyboard.press("Enter");
});

await context.close();
```

For cloud-browser providers that preload or upload the PTK extension, connect with the provider helper and pass the returned page to `withPtkScan`. See [provider integrations](providers.md).

## Selenium JavaScript

Install in a Selenium JavaScript project:

```bash
npm install -D pentestkit selenium-webdriver
```

Use a prepared Chrome, Edge, or Firefox profile with PTK Auto installed. A profile using the separate full extension also needs Automation Mode enabled:

```js
const { Builder, By, Key } = require("selenium-webdriver");
const { Options } = require("selenium-webdriver/chrome");
const { withPtkScan } = require("pentestkit/selenium");

const options = new Options().addArguments("--user-data-dir=/path/to/ptk-profile");
const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

await withPtkScan(driver, {
  project: "selenium-flow",
  engines: ["DAST", "IAST"],
  resultsDir: ".ptk/results/selenium"
}, async () => {
  await driver.get("https://target.example");
  await driver.findElement(By.css("input[type=search]")).sendKeys("test", Key.ENTER);
});

await driver.quit();
```

The Selenium wrapper adapts `driver.executeAsyncScript()` to the shared browser API.

## Cypress

Install in a Cypress project:

```bash
npm install -D pentestkit cypress
```

Example `cypress.config.js`:

```js
const { defineConfig } = require("cypress");
const { setupPtkCypress } = require("pentestkit/cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: "https://app.example.test",
    setupNodeEvents(on, config) {
      setupPtkCypress(on, config);
      return config;
    }
  }
});
```

For Chromium-family Cypress runs, `setupPtkCypress()` creates the run-local extension copy automatically and scopes the bridge to the configured AUT origins. `baseUrl` is included by default. For multi-origin suites, pass the extra origins:

```js
setupNodeEvents(on, config) {
  setupPtkCypress(on, config, {
    allowedOrigins: ["https://api.example.test", "https://another.example.test"]
  });
  return config;
}
```

Do not modify the installed package ZIP or generated cache artifacts. Override `PTK_EXTENSION_PATH` only when you need to test a source-built unpacked extension.

Register commands in `cypress/support/e2e.js`:

```js
const { registerCommands } = require("pentestkit/cypress");
registerCommands();
```

In a spec:

```js
describe("PTK scan", () => {
  it("scans the app while Cypress drives the flow", () => {
    cy.visit("/");
    cy.ptkWaitReady();
    cy.ptkStartSession({ engines: ["DAST", "IAST"] });
    cy.get("input[type=search]").type("apple{enter}");
    cy.ptkEndSession({ wait: true });
    cy.ptkExportScan().then((report) => {
      expect(report).to.exist;
    });
  });
});
```

Omit `immediateAnalysis` for the normal automation default, which computes analysis at stop. Set it to `false` to defer analysis until import/load/recompute in PTK:

```js
cy.ptkEndSession({ wait: true, immediateAnalysis: false });
```

Cypress application-frame export is evidence-only. `includeSecrets`, `exportMode: "replayable"`, and `sensitive: true` are rejected from page-facing automation APIs.

See `frameworks/cypress/README.md` and `frameworks/cypress/examples/` in the installed package.

## Puppeteer (Experimental)

The Puppeteer integration is optional and experimental. Install Puppeteer in the project that runs the test:

```bash
npm install -D pentestkit puppeteer
```

or use `puppeteer-core` with an explicit browser executable:

```bash
npm install -D pentestkit puppeteer-core
export PTK_PUPPETEER_EXECUTABLE_PATH=/path/to/chrome
```

Basic usage:

```js
const { launchPtkBrowser, withPtkScan } = require("pentestkit/puppeteer");

async function run() {
  const { browser, page, ptk } = await launchPtkBrowser();

  await withPtkScan(page, {
    project: "puppeteer-flow",
    engines: ["DAST", "IAST"],
    resultsDir: ".ptk/results/puppeteer"
  }, async () => {
    await page.goto("https://target.example");
    // Drive the app with Puppeteer.
  });
  await browser.close();
}

run();
```

## Agent CLI Inside Test Pipelines

If your test framework already drives the app, prefer framework integration. If you need a standalone scan before or after test execution, run:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST \
  --require-ptk-bridge \
  --output-dir .ptk/artifacts/standalone
```

Keep output directories as CI artifacts, not source-controlled files.
