# Steel PTK Examples

Install the Steel SDK and set an authorised target:

```bash
npm install -D steel-sdk
export STEEL_API_KEY=...
export PTK_PROVIDER_TARGET_URL=https://your-authorised-target.example
```

Set `STEEL_EXTENSION_ID` only when you want to reuse PTK Auto already uploaded to the same account.

Run:

```bash
node node_modules/pentestkit/providers/steel/examples/playwright-juice-shop.mjs
node node_modules/pentestkit/providers/steel/examples/puppeteer-juice-shop.mjs
```

Steel Selenium is not currently a supported PTK Auto path. Each supported example enables DAST, SAST, IAST, and SCA; permits same-origin child routes; rejects unrelated external navigation; exports findings; and releases the session.

See [Steel browser extensions](https://docs.steel.dev/overview/extensions-api/overview).
