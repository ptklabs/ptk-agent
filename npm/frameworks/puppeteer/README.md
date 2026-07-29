# PTK Puppeteer SDK (Experimental)

This SDK is an experimental Puppeteer integration for PTK browser-extension automation.

Install either Puppeteer package in the project that runs the test:

```bash
npm install -D pentestkit puppeteer
```

or, when you provide a Chrome/Chromium executable yourself:

```bash
npm install -D pentestkit puppeteer-core
```

Use the public package import:

```js
const { launchPtkBrowser, withPtkScan } = require("pentestkit/puppeteer");
```

## Basic Usage

```js
const { launchPtkBrowser, withPtkScan } = require("pentestkit/puppeteer");

async function run() {
  const { browser, page } = await launchPtkBrowser({
    executablePath: process.env.PTK_CHROME_BINARY
  });

  try {
    const result = await withPtkScan(page, {
      project: "my-app",
      engines: ["DAST", "IAST"],
      bootstrapUrl: "https://target.example",
      stop: { wait: true, immediateAnalysis: true }
    }, async ({ page }) => {
      // Drive the application with normal Puppeteer actions.
      await page.click("input[type=search]");
      await page.keyboard.type("test");
    });
    console.log(result);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

`immediateAnalysis` follows the same semantics as the other SDKs. Omit it for the normal automation default, set `false` to stop/export quickly and recompute PTK analysis later, or set `true` to force immediate analysis.

The SDK does not silently request activation. Use an automation-enabled PTK artifact, enable Automation Mode in the prepared profile, or pass `wait: { activate: true }` only from a trusted page you control.

## Extension Loading

Puppeteer runs are Chromium-family only in this experimental phase. The SDK launches headed by default because extension loading is the stable path for PTK automation.

The SDK resolves the unpacked PTK extension from:

1. `extensionPath`
2. `PTK_EXTENSION_PATH` or `PTK_EXTENSION_DIR`
3. the installed package automation ZIP via `pentestkit/extensions.ensureUnpackedPtkExtension()`

For `puppeteer-core`, set one of:

```bash
export PTK_PUPPETEER_EXECUTABLE_PATH=/path/to/chrome
export PTK_EXECUTABLE_PATH=/path/to/chrome
export PTK_CHROME_BINARY=/path/to/chrome
```

## Juice Shop Example

Run the packaged Juice Shop example from an installed project:

```bash
JUICE_SHOP_URL=http://127.0.0.1:3001 \
node node_modules/pentestkit/frameworks/puppeteer/examples/juice-shop-with-ptk.cjs
```
