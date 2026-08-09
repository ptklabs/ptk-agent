# Cloud Provider Support Matrix

This matrix describes the provider and framework combinations supported by the current `pentestkit` package.

Status meanings:

- **Supported**: PTK Auto loading, PTK bridge readiness, DAST/SAST/IAST/SCA participation, findings export, and session cleanup are covered by the PTK Agent provider contract.
- **Limited**: the integration exists, but provider account enablement or an externally prepared extension session is required.
- **Example only**: an example is included for users who already have the provider feature configured, but it is outside the supported compatibility contract.
- **Not supported**: the provider/framework combination does not currently expose a reliable PTK Auto extension path through PTK Agent.

| Provider | Playwright | Puppeteer | Selenium | Recommended first path |
| --- | --- | --- | --- | --- |
| Browserbase | **Supported** | **Supported** | **Supported** | Playwright |
| Browserless | **Supported** | **Supported** | **Not supported** | Playwright |
| BrowserStack | **Supported** | **Supported** | **Supported** | Playwright |
| Hyperbrowser | **Supported** | **Supported** | **Limited** | Playwright |
| Steel | **Supported** | **Supported** | **Not supported** | Playwright |
| TestMu | **Supported** | **Supported** | **Supported** | Playwright over CDP |

Additional TestMu Cypress and k6 examples are packaged as **example only**. Cypress uses TestMu's project runner. k6 cannot import the Node package and requires PTK Auto to be present in the remote browser before the script starts.

## Browser Notes

- Provider integrations use Chrome or Chromium because the listed providers expose their custom-extension support there.
- A provider's general support for a framework does not guarantee that custom extensions are supported in that framework.
- BrowserStack Playwright and Puppeteer use the provider's uploaded-media extension flow; Selenium loads the packaged CRX through Chrome capabilities.
- Hyperbrowser Selenium can require account-level enablement. Use it only after the provider confirms that the WebDriver endpoint and extensions are available for your account.
- Browserless v2 does not support Selenium/WebDriver, so PTK Agent exposes Playwright and Puppeteer paths only.
- Steel supports Selenium sessions generally, but PTK Agent does not currently advertise Steel Selenium because PTK Auto extension loading is not reliable on that path.

## Extension Setup

| Provider | PTK Auto setup |
| --- | --- |
| Browserbase | The helper uploads the packaged Chromium ZIP, or reuses `BROWSERBASE_EXTENSION_ID`. |
| Browserless | Upload the Chromium ZIP in the Browserless dashboard and set `BROWSERLESS_EXTENSION_NAME`. |
| BrowserStack Playwright/Puppeteer | The helper creates the required one-parent ZIP, uploads or reuses it, and supplies `browserstack.uploadMedia`. |
| BrowserStack Selenium | The helper adds the packaged CRX to Chrome capabilities. |
| Hyperbrowser | The helper uploads the Chromium ZIP, or reuses `HYPERBROWSER_EXTENSION_ID`. |
| Steel | The helper uploads the Chromium ZIP, or reuses `STEEL_EXTENSION_ID`. |
| TestMu Playwright/Puppeteer | Use the provider upload flow, a hosted extension URL, or an existing TestMu extension entry. |
| TestMu Selenium | The helper adds the packaged CRX to Chrome capabilities. |

See [provider integrations](providers.md) for environment variables and runnable examples.

## Official Provider Documentation

- [Browserbase browser extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions)
- [Browserbase Selenium](https://docs.browserbase.com/welcome/quickstarts/selenium)
- [Browserless browser extensions](https://docs.browserless.io/baas/features/browser-extensions)
- [Browserless v2 migration](https://docs.browserless.io/enterprise/migrate-from-v1)
- [BrowserStack Playwright extension testing](https://www.browserstack.com/docs/automate/playwright/chrome-extension-testing)
- [BrowserStack Selenium](https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs)
- [Hyperbrowser browser extensions](https://www.hyperbrowser.ai/docs/sessions/extensions)
- [Hyperbrowser Selenium](https://www.hyperbrowser.ai/docs/sessions/selenium)
- [Steel browser extensions](https://docs.steel.dev/overview/extensions-api/overview)
- [Steel Playwright](https://docs.steel.dev/integrations/playwright)
- [Steel Selenium](https://docs.steel.dev/integrations/selenium)
- [TestMu browser extensions](https://www.testmuai.com/support/docs/browser-cloud-extensions/)
- [TestMu Playwright](https://www.testmuai.com/support/docs/playwright-testing/)

Provider APIs and account features can change independently of `pentestkit`. If a previously supported session cannot load PTK Auto, run the provider example with headed/live-view diagnostics and report the provider, framework, browser, package version, and redacted session error.
