# PTK Cloud Provider Helpers

The `pentestkit/providers/*` modules connect supported cloud browsers to the normal PTK framework lifecycle. They create or connect to an extension-enabled session and return the page or driver used by `withPtkScan()`.

Read the [provider guide](https://github.com/ptklabs/ptk-agent/blob/main/docs/npm/providers.md) and [support matrix](https://github.com/ptklabs/ptk-agent/blob/main/docs/npm/provider-browser-matrix.md) before selecting a framework.

## Modules

| Provider | Import | Supported paths |
| --- | --- | --- |
| Browserbase | `pentestkit/providers/browserbase` | Playwright, Puppeteer, Selenium |
| Browserless | `pentestkit/providers/browserless` | Playwright, Puppeteer |
| BrowserStack | `pentestkit/providers/browserstack` | Playwright, Puppeteer, Selenium |
| Hyperbrowser | `pentestkit/providers/hyperbrowser` | Playwright, Puppeteer; Selenium is account-dependent |
| Steel | `pentestkit/providers/steel` | Playwright, Puppeteer |
| TestMu | `pentestkit/providers/testmu` | Playwright, Puppeteer, Selenium |

## Example

```js
import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserbasePlaywright } from "pentestkit/providers/browserbase";

const cloud = await connectBrowserbasePlaywright();

try {
  await withPtkScan(cloud.page, {
    project: "provider-flow",
    engines: ["DAST", "SAST", "IAST", "SCA"],
    deferStart: true,
    resultsDir: ".ptk/results/provider-flow"
  }, async ({ page, startPtkScan }) => {
    await page.goto(process.env.PTK_PROVIDER_TARGET_URL, {
      waitUntil: "domcontentloaded"
    });
    await startPtkScan();

    // Continue the authorised same-origin test journey.
  });
} finally {
  await cloud.close();
}
```

Always close the returned provider object in `finally`; remote sessions may remain billable until they are released.

## Credentials

| Provider | Environment variables |
| --- | --- |
| Browserbase | `BROWSERBASE_API_KEY` |
| Browserless | `BROWSERLESS_API_KEY`, `BROWSERLESS_EXTENSION_NAME` |
| BrowserStack | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| Hyperbrowser | `HYPERBROWSER_API_KEY` |
| Steel | `STEEL_API_KEY` |
| TestMu | `LT_USERNAME`, `LT_ACCESS_KEY` |

Set `PTK_PROVIDER_TARGET_URL` to an explicitly authorised target before running any packaged example. Use environment variables or a secret manager for provider and application credentials.

Remote browsers require the provider's tunnel or local-testing feature to reach private or localhost targets.

## Packaged Examples

Examples are available under:

```text
providers/browserbase/examples/
providers/browserless/examples/
providers/browserstack/examples/
providers/hyperbrowser/examples/
providers/steel/examples/
providers/testmu/examples/
```

Each provider directory contains its required variables and supported commands. Example scans keep the configured origin in scope while allowing owned same-origin child routes.

## Security

Provider dashboards and saved PTK results may contain application URLs, screenshots, console or network logs, and security findings. Restrict access, enable only required diagnostics, redact before sharing, and set an appropriate retention period.
