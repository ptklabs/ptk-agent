# PTK Playwright JavaScript SDK

`pentestkit/playwright` wraps an existing Playwright page with the PTK scan lifecycle. Your script still controls the browser journey; PTK observes and scans the traffic, routes, client-side state, and findings created during that journey.

## Install

```bash
npm install -D pentestkit playwright
npx playwright install chromium
```

Use the public package import:

```js
import { withPtkScan } from "pentestkit/playwright";
```

## What The Wrapper Does

`withPtkScan(page, options, runJourney)`:

1. Arms scoped IAST document-start hooks before `bootstrapUrl`, when IAST is selected.
2. Navigates to the application and waits for the PTK bridge.
3. Starts a PTK session.
4. Runs your Playwright journey callback.
5. Optionally collects findings before stop.
6. Stops the PTK session.
7. Writes artifacts when `resultsDir` is provided.

It does not install or upload the extension. The browser/context must already have PTK loaded.

## Basic Usage

```js
import { chromium } from "playwright";
import { ensureUnpackedPtkExtension } from "pentestkit/extensions";
import { withPtkScan } from "pentestkit/playwright";

const extensionPath = ensureUnpackedPtkExtension().path;

const context = await chromium.launchPersistentContext(".ptk/profiles/playwright", {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});
const page = context.pages()[0] || await context.newPage();

try {
  await withPtkScan(page, {
    project: "playwright-flow",
    engines: ["DAST", "IAST"],
    bootstrapUrl: "https://target.example",
    resultsDir: ".ptk/results/playwright",
    stop: { immediateAnalysis: true }
  }, async ({ page }) => {
    await page.locator("input[type=search]").fill("test");
    await page.keyboard.press("Enter");
  });
} finally {
  await context.close();
}
```

CommonJS works too:

```js
const { withPtkScan } = require("pentestkit/playwright");
```

## Extension Loading

Resolve the unpacked extension from the installed package:

```js
import { ensureUnpackedPtkExtension } from "pentestkit/extensions";

const extensionPath = ensureUnpackedPtkExtension().path;
```

Use `PTK_EXTENSION_PATH` only when testing a custom unpacked extension:

```bash
export PTK_EXTENSION_PATH=/absolute/path/to/custom-ptk-auto
```

For cloud browser providers such as Browserless or Browserbase, upload or preinstall PTK in the provider profile/session, connect to the provider as usual, then pass the provider page to `withPtkScan()`.

## Options

| Option | Purpose |
| --- | --- |
| `project` | PTK project/session label. |
| `engines` | Engines to enable, for example `["DAST", "IAST", "SAST"]`. |
| `bootstrapUrl` | Recommended first application URL. PTK navigates there before starting the page-bridge session. |
| `deferStart` | Lets a custom callback own navigation; call `startPtkScan()` after the first authorised `goto()`. |
| `policyCode` | Optional DAST policy code. |
| `resultsDir` | Directory where wrapper artifacts are written. |
| `artifactMode` | `report` writes `report.json` and `findings.json`; `debug` writes lifecycle diagnostics. Defaults to `report`. |
| `findingsLimit` | Max findings to collect in result artifacts. |
| `wait.timeoutMs` | Bridge-ready timeout. |
| `stop.wait` | Wait for PTK stop/drain completion. |
| `stop.immediateAnalysis` | `false` defers stop-time analysis until import/load/recompute in PTK. |
| `collect.afterStop` | Collect findings/stats/progress after stop. |
| `throwOnError` | Set `false` to receive a failed result object instead of throwing. |

## Results

When `resultsDir` is set, the wrapper writes `report.json` and `findings.json` by default. Use `artifactMode: "debug"` or `PTK_ARTIFACT_MODE=debug` when you need lifecycle diagnostics such as progress snapshots, stop responses, and the full wrapper result.

Use `collect.afterStop: true` with `stop.wait: true` when the test needs post-stop findings in the returned result:

```js
const result = await withPtkScan(page, {
  project: "after-stop",
  engines: ["DAST", "IAST"],
  resultsDir: ".ptk/results/after-stop",
  stop: { wait: true },
  collect: { afterStop: true }
}, async ({ page }) => {
  await page.goto("https://target.example");
});

console.log(result.afterStop);
```

## Juice Shop Example

Run the packaged Juice Shop example from an installed project:

```bash
JUICE_SHOP_URL=http://127.0.0.1:3001 \
node node_modules/pentestkit/frameworks/playwright/examples/juice-shop-with-ptk.mjs
```

## Troubleshooting

`PTK bridge not ready` usually means the extension did not load, Automation Mode is disabled, or the page was opened before the extension finished bootstrapping.

The SDK does not silently request activation. Use an automation-enabled PTK artifact, enable Automation Mode in the prepared profile, or pass `wait: { activate: true }` only from a trusted page you control.

Branded Chrome builds may reject unpacked extension loading. Prefer Playwright Chromium, Chrome for Testing, Edge, or a prepared browser profile when direct `--load-extension` fails.
