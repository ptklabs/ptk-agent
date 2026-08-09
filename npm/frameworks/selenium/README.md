# PTK Selenium JavaScript SDK

`pentestkit/selenium` adapts a Selenium WebDriver instance to the shared PTK browser automation lifecycle. Your Selenium test still owns navigation and element interactions; PTK starts before the flow, scans while the flow runs, then stops and exports findings.

## Install

```bash
npm install -D pentestkit selenium-webdriver
```

Use the public package import:

```js
const { withPtkScan } = require("pentestkit/selenium");
```

## What The Adapter Does

The adapter converts Selenium's `driver.executeAsyncScript()` into the page-like bridge used by the common PTK helpers. It exports:

- `withPtkScan(driver, options, runJourney)`
- `waitForPtk(driver, options)`
- `createSeleniumPtkBridge(driver, options)`
- `collectPtkResults(driverOrBridge, session, options)`

It does not install PTK into the browser. Your test owns browser creation: use
the packaged signed XPI for Firefox, a prepared profile, or a Chromium build
that accepts unpacked extension loading.

## Basic Usage

```js
const { Builder, By, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { withPtkScan } = require("pentestkit/selenium");

const options = new chrome.Options()
  .addArguments("--user-data-dir=/path/to/prepared-ptk-profile");

const driver = await new Builder()
  .forBrowser("chrome")
  .setChromeOptions(options)
  .build();

try {
  await withPtkScan(driver, {
    project: "selenium-flow",
    engines: ["DAST", "IAST"],
    bootstrapUrl: "https://target.example",
    resultsDir: ".ptk/results/selenium",
    stop: { immediateAnalysis: true }
  }, async ({ driver }) => {
    await driver.findElement(By.css("input[type=search]")).sendKeys("test", Key.ENTER);
  });
} finally {
  await driver.quit();
}
```

ESM imports are supported:

```js
import { withPtkScan } from "pentestkit/selenium";
```

## Extension Loading

### Prepared Profile

Prepared profiles are the most stable Selenium path for Chrome, Edge, and Firefox:

1. Create a dedicated automation profile.
2. Install PTK in that profile.
3. Enable PTK Automation Mode in PTK settings.
4. Close the browser completely.
5. Launch Selenium with the same profile path.

Chrome example:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/path/to/prepared-ptk-profile \
  --no-first-run
```

Then use that path in Selenium:

```js
const options = new chrome.Options()
  .addArguments("--user-data-dir=/path/to/prepared-ptk-profile");
```

### Direct Unpacked Loading

Some automation browser builds accept unpacked extension loading:

```js
const extensionPath = process.env.PTK_EXTENSION_PATH;
const options = new chrome.Options()
  .addArguments(`--disable-extensions-except=${extensionPath}`)
  .addArguments(`--load-extension=${extensionPath}`);
```

Prefer Chrome for Testing, Chromium, or Edge for this mode. Newer branded Chrome builds may ignore or reject `--load-extension`; use a prepared profile when that happens.

Resolve the unpacked extension from the installed package:

```js
const { ensureUnpackedPtkExtension } = require("pentestkit/extensions");

const extensionPath = ensureUnpackedPtkExtension().path;
```

Use `PTK_EXTENSION_PATH` only when testing a custom unpacked extension:

```bash
export PTK_EXTENSION_PATH=/absolute/path/to/custom-ptk-auto
```

### Firefox Signed XPI

Resolve the AMO-signed Firefox artifact from the installed package and add it
to Selenium's generated profile before Firefox starts:

```js
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const { ensurePtkXpi } = require("pentestkit/extensions");

const xpiPath = ensurePtkXpi().path;
const options = new firefox.Options()
  .addExtensions(xpiPath);

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(options)
  .build();
```

Configure the XPI before `build()`. Installing it after Firefox has started can
miss the first document-start bridge. Firefox assigns the WebExtension origin;
PTK Agent does not require or configure a fixed `moz-extension://` UUID.

## Options

| Option | Purpose |
| --- | --- |
| `project` | PTK project/session label. |
| `engines` | Engines to enable, for example `["DAST", "IAST", "SAST"]`. |
| `bootstrapUrl` | Recommended first application URL. PTK navigates there before starting the page-bridge session. |
| `deferStart` | Lets a custom callback own navigation; call `startPtkScan()` after the first authorised `driver.get()`. |
| `policyCode` | Optional DAST policy code. |
| `resultsDir` | Directory where wrapper artifacts are written. |
| `artifactMode` | `report` writes `report.json` and `findings.json`; `debug` writes lifecycle diagnostics. Defaults to `report`. |
| `findingsLimit` | Max findings to collect in result artifacts. |
| `wait.timeoutMs` | Bridge-ready timeout. |
| `stop.wait` | Wait for PTK stop/drain completion. |
| `stop.immediateAnalysis` | `false` defers stop-time analysis until import/load/recompute in PTK. |
| `collect.afterStop` | Collect findings/stats/progress after stop. |
| `switchToDefaultContent` | Defaults to `true`; switch out of iframes before bridge calls. |

## Juice Shop Example

Run the packaged Juice Shop example from an installed project:

```bash
JUICE_SHOP_URL=http://127.0.0.1:3001 \
node node_modules/pentestkit/frameworks/selenium/examples/juice-shop-selenium.cjs
```

## Troubleshooting

`PTK bridge not ready` means Selenium reached the page but page JavaScript cannot see `window.PTK_AUTOMATION`. For Firefox, confirm that the signed XPI was supplied through `Options.addExtensions()` before `build()`. For a prepared profile, check that PTK is installed in the exact profile Selenium launched and Automation Mode is enabled.

The SDK does not silently request activation. Use an automation-enabled PTK artifact, enable Automation Mode in the prepared profile, or pass `wait: { activate: true }` only from a trusted page you control.

`Profile is locked` means another browser instance is using the profile. Close all windows for that browser or use a different profile path.

If direct unpacked loading fails on Chrome, retry with Chrome for Testing, Chromium, Edge, or a prepared profile.
