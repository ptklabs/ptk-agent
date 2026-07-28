# TestMu PTK Examples

These examples run from an application project that has the `pentestkit` npm package installed. They follow TestMu's documented style: define capabilities, connect to TestMu, run normal test steps, and wrap the journey with PTK.

## Install

```bash
npm install -D pentestkit @testmuai/testmu-cloud playwright puppeteer-core selenium-webdriver cypress lambdatest-cypress-cli
```

## Credentials

```bash
export LT_USERNAME="..."
export LT_ACCESS_KEY="..."
export PTK_PROVIDER_TARGET_URL="https://your-approved-target.example"
```

Playwright and Puppeteer need the PTK automation extension loaded into the TestMu Browser Cloud session. Use one of:

```bash
export TESTMU_EXTENSION_CLOUD_URL="https://.../ptk-latest.zip"
```

or, for a simple first run:

```bash
export TESTMU_UPLOAD_EXTENSION=1
```

The helper prefers `@testmuai/testmu-cloud`; the former
`@testmuai/browser-cloud` package remains accepted for compatibility. Explicit
upload uses the SDK first and falls back to PTK's curl-backed uploader only for
recognized transport/upload failures, never for credential failures.

Selenium embeds the packaged PTK CRX through Chrome capabilities and does not need an uploaded extension URL.

Cypress uses TestMu's `lambdatest-cypress-cli` project workflow instead of a direct browser-cloud connection. Put the credentials in the project-level `lambdatest-config.json` before running the Cypress example.

k6 Browser uses TestMu's CDP endpoint and the k6 runtime, not Node.js. It cannot import `pentestkit` from npm, so the example calls `window.PTK_AGENT` directly after the first real application page is available.

## Run

From your project:

```bash
node node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs
```

For Cypress, copy the packaged sample project and run the TestMu CLI from that project:

```bash
cp -R node_modules/pentestkit/providers/testmu/examples/cypress-juice-shop ./ptk-testmu-cypress
cd ./ptk-testmu-cypress
npm install
npm run testmu
```

For k6 Browser:

```bash
PTK_PROVIDER_TARGET_URL="https://your-approved-target.example" K6_BROWSER_ENABLED=true \
  k6 run node_modules/pentestkit/providers/testmu/examples/k6-browser-juice-shop.js
```

Each example requires an explicitly approved provider-reachable target, starts
PTK after the first real application page is available, performs a simple
same-origin search-route journey, and reports PTK findings. The Node examples
also write PTK results under `.runs/testmu/<framework>`; Cypress writes under
`.runs/testmu-cypress`.

The current examples request DAST, SAST, IAST, and SCA, poll for engine
participation instead of sleeping for a fixed duration, enforce exact-origin
navigation while allowing same-origin child routes, export evidence, and
release the TestMu session in `finally`.
