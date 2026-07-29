# TestMu PTK Examples

Install TestMu Browser Cloud support:

```bash
npm install -D pentestkit @testmuai/testmu-cloud
```

Set your TestMu credentials and an authorised, provider-reachable target:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

For Playwright and Puppeteer, select one PTK Auto source:

```bash
export TESTMU_UPLOAD_EXTENSION=1
```

or:

```bash
export TESTMU_EXTENSION_CLOUD_URL=https://downloads.example/ptk-auto.zip
```

or reuse an existing TestMu entry:

```bash
export TESTMU_EXTENSION_ID=...
```

Selenium uses the packaged PTK Auto CRX and needs no uploaded ZIP URL.

Run:

```bash
node node_modules/pentestkit/providers/testmu/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/puppeteer-juice-shop.mjs
node node_modules/pentestkit/providers/testmu/examples/selenium-juice-shop.mjs
```

Each Node example enables DAST, SAST, IAST, and SCA; allows same-origin child routes; rejects unrelated external navigation; exports evidence; and closes the provider session.

TestMu Cypress and k6 examples are also included. They use provider-specific runners and are not part of the primary Node provider path:

- `node_modules/pentestkit/providers/testmu/examples/cypress-juice-shop/`
- `node_modules/pentestkit/providers/testmu/examples/k6-browser-juice-shop.js`

See [TestMu browser extensions](https://www.testmuai.com/support/docs/browser-cloud-extensions/).
