# PTK Browser Automation API

`pentestkit/browser` contains the framework-neutral PTK lifecycle helpers used by the Playwright, Selenium, and Puppeteer adapters. Most users should import the framework-specific subpath, but this module is useful when a browser provider exposes a Playwright-like page object with `evaluate()`.

Install `pentestkit` from the npm registry:

```bash
npm install -D pentestkit
```

## Page Contract

The page object must provide:

```ts
interface PtkPageLike {
  evaluate<T = unknown>(pageFunction: Function | string, arg?: unknown): Promise<T>;
  goto?(url: string, options?: object): Promise<unknown>;
  waitForTimeout?(ms: number): Promise<void>;
}
```

The PTK extension must already be loaded in the browser and Automation Mode must be enabled. The helpers do not silently request activation; pass `wait: { activate: true }` only from a trusted page you control.

## Basic Usage

```js
import { withPtkScan } from "pentestkit/browser";

await withPtkScan(page, {
  project: "custom-provider-flow",
  engines: ["DAST", "IAST"],
  bootstrapUrl: "https://target.example",
  resultsDir: ".ptk/results/custom-provider"
}, async ({ page }) => {
  await page.locator("input[type=search]").fill("test");
  await page.keyboard.press("Enter");
});
```

CommonJS:

```js
const { withPtkScan, waitForPtk, createPtkBridge } = require("pentestkit/browser");
```

## Exports

| Export | Purpose |
| --- | --- |
| `createPtkBridge(page, options)` | Create a low-level bridge around `window.PTK_AUTOMATION`. |
| `waitForPtk(page, options)` | Wait for the PTK bridge to become ready. |
| `armPtkIastForNavigation(page, options)` | Scope and install IAST document-start hooks before the first application navigation. |
| `bootstrapPtkPage(page, options)` | Navigate to `bootstrapUrl` after any required IAST pre-navigation arm. |
| `withPtkScan(page, options, runJourney)` | Start PTK, run the journey, stop PTK, and optionally write artifacts. |
| `collectPtkResults(pageOrBridge, session, options)` | Collect findings, stats, progress, and export data. |
| `writePtkResults(result, resultsDir)` | Write report artifacts or debug diagnostics to disk. |
| `countFindings(payload)` | Count findings in a normalized or raw PTK payload. |

## Artifacts

When `resultsDir` is set, the wrapper writes `report.json` and `findings.json` by default. Set `artifactMode: "debug"` or `PTK_ARTIFACT_MODE=debug` to write lifecycle diagnostics such as progress snapshots, stop responses, and the full wrapper result.

When `bootstrapUrl` and IAST are selected, `withPtkScan()` automatically arms the exact scoped URL before the first application load. This installs document-start hooks without reloading the application.

Use `deferStart: true` when a custom journey must own the first navigation. In that mode, arm IAST before `goto()`, then start the PTK session:

```js
await withPtkScan(page, {
  engines: ["DAST", "IAST"],
  deferStart: true
}, async ({ page, armPtkIastForNavigation, startPtkScan }) => {
  const targetUrl = "https://target.example";
  await armPtkIastForNavigation(targetUrl);
  await page.goto(targetUrl);
  await startPtkScan();
});
```

## Stop-Time Analysis

Use `stop.immediateAnalysis: false` when the automation should stop/export quickly and recompute analysis later in PTK:

```js
await withPtkScan(page, {
  project: "deferred-analysis",
  engines: ["DAST", "IAST"],
  stop: { immediateAnalysis: false }
}, async ({ page }) => {
  await page.goto("https://target.example");
});
```
