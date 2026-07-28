# Provider Browser Matrix

This is the release-candidate provider matrix for `pentestkit@9.9.8`, run on
2026-07-27 from an isolated project that installed the publishable npm
tarball. The tarball contained PTK Automation 9.9.8 with Chromium ZIP SHA-256
`eb5ed1c005f18b34297c1885cb502ed598a3741bf828282315ea1e9dacc028aa`
and CRX SHA-256
`facfc04887667f1903dc57585a511f24a8f5a8e4ec897137854b71d6f15ce83a`.

The controlled target was `https://preview.owasp-juice.shop`. The runner kept
the exact target origin in scope, intentionally visited one same-origin child
route, and rejected cross-origin navigation. Packaged examples no longer
contain this or any other public fallback: users must set
`PTK_PROVIDER_TARGET_URL` (or the compatible `JUICE_SHOP_URL`) explicitly.

## Qualification Contract

A `PASS` row proves all of the following from the installed tarball:

- provider session and extension-bearing browser context created;
- `window.PTK_AGENT` bridge available;
- DAST, SAST, IAST, and SCA all participated without engine failure;
- condition-based lifecycle polling, with no fixed scan sleep;
- completed-session export succeeded;
- scan target remained on the exact approved origin while a same-origin child
  route remained eligible;
- browser/provider cleanup was successful and idempotent;
- saved evidence passed the credential-redaction audit.

A successful PTK export is authoritative completion evidence because the
extension rejects export with `session_not_completed` until its background
session is terminal. This matters for Browserbase Selenium, whose provider-side
progress snapshot remained stale after the completed export.

## Live 9.9.8 Results

| Provider | Framework | Browser | Release status | Findings (DAST / SAST / IAST / SCA) | Extension path | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Browserbase | Playwright | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Account-scoped uploaded ZIP/id | Default extension-bearing context, export and release passed. |
| Browserbase | Puppeteer | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Cached Browserbase extension id | Export and release passed. |
| Browserbase | Selenium | Chrome | **PASS — supported** | 2 / 167 / 4 / 0 | Cached Browserbase extension id | Uses `seleniumRemoteUrl`, signed HTTP agent, and a 120-second async-script timeout. Completion was proven by successful export despite stale progress. |
| Browserless | Playwright | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Pre-uploaded extension name in `launch.extensions` | Passed within the account's 60-second session limit. |
| Browserless | Puppeteer | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Pre-uploaded extension name in `launch.extensions` | Same result as Playwright. |
| Hyperbrowser | Playwright | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Account-scoped uploaded ZIP/id in `extensionIds` | Default extension-bearing context, terminal progress, export, exact-origin scope, redaction, and cleanup passed. |
| Hyperbrowser | Puppeteer | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Cached Hyperbrowser extension id in `extensionIds` | Same full result as Playwright. |
| Hyperbrowser | Selenium | Chrome | **FAIL — provider/account diagnostic** | 0 / 0 / 0 / 0 | Cached Hyperbrowser extension id in `extensionIds` | Session creation succeeded, but the authenticated WebDriver endpoint returned `selenium server not ready after 5s` for all six bounded attempts. Cleanup passed. Hyperbrowser documents that Selenium access may require support enablement. |
| BrowserStack | Playwright | Chrome | **FAIL — provider diagnostic** | 0 / 0 / 0 / 0 | BrowserStack `upload-media` ZIP | Exact documented Windows 10/CDP contract created Chrome 150, but BrowserStack exposed zero extension targets. A harmless minimal MV3 control extension was also uploaded successfully and was not installed, proving this is not PTK-specific. Cleanup passed. |
| BrowserStack | Puppeteer | Chrome | **FAIL — unsupported/unproven** | 0 / 0 / 0 / 0 | BrowserStack `upload-media` ZIP | Browser created with zero extension targets. BrowserStack does not document this Chrome-extension flow for Puppeteer. Cleanup passed. |
| BrowserStack | Selenium | Chrome | **PASS — supported** | 2 / 167 / 4 / 0 | Bundled provenance-checked CRX in Chrome capabilities | Terminal progress, export and cleanup passed. |
| Steel | Playwright | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Account-scoped Steel extension upload/id | Verified with `steel-sdk@0.18.0` and the session's returned WebSocket URL. |
| Steel | Puppeteer | Chromium | **PASS — supported** | 2 / 167 / 4 / 0 | Cached Steel extension id | Same result as Playwright. |
| Steel | Selenium | Chrome | **FAIL — provider diagnostic** | 0 / 0 / 0 / 0 | Steel extension id plus bundled CRX | The W3C connection works after a bounded readiness retry, but both headless and headful Steel sessions reported zero installed extensions. PTK cannot run until Steel forwards an extension mechanism to Selenium nodes. Cleanup passed. |
| TestMu | Playwright | Chrome | **PASS — supported** | 2 / 167 / 4 / 0 | Current SDK-first ZIP upload | CDP route; export, SDK release and redaction passed. |
| TestMu | Puppeteer | Chrome | **PASS — supported** | 2 / 167 / 4 / 0 | Current SDK-first ZIP upload | Export, SDK release and redaction passed. |
| TestMu | Selenium | Chrome | **PASS — supported** | 2 / 167 / 4 / 0 | Bundled provenance-checked CRX in Chrome capabilities | Terminal progress, export and cleanup passed. |

Result: every included provider has at least one release-supported path.
Thirteen provider/framework rows pass. Hyperbrowser Playwright and Puppeteer
are supported; Hyperbrowser Selenium remains an account/provider diagnostic.
BrowserStack Playwright and Puppeteer remain
available only as explicit diagnostics and are not advertised as working PTK
automation examples.

SCA participated in every passing row but returned zero findings on this
hosted target. A local control with the same installed artifact also returned
zero SCA findings against the hosted target, while `http://localhost:3001`
returned six SCA findings. The zero is target/resource behavior, not evidence
that SCA was omitted from cloud sessions.

## Recommended User Matrix

| Provider | Recommended first path | Also live-proven | Do not promote yet |
| --- | --- | --- | --- |
| Browserbase | Playwright | Puppeteer, Selenium Chrome | Other browsers |
| Browserless | Playwright | Puppeteer | Firefox/WebKit/Edge provider endpoints |
| Hyperbrowser | Playwright | Puppeteer | Selenium until account enablement and a live PTK pass are confirmed |
| BrowserStack | Selenium Chrome | — | Playwright `uploadMedia` until BrowserStack resolves the reproduced control failure; Puppeteer extension loading |
| Steel | Playwright | Puppeteer | Selenium until Steel forwards extensions to its WebDriver node; non-Chromium browsers |
| TestMu | Playwright CDP | Puppeteer, Selenium Chrome | Native Playwright transport, Cypress and k6 as 9.9.8 release claims |

The TestMu Cypress and k6 samples remain packaged integration examples, but
they were not part of this installed-tarball release matrix. k6 requires PTK to
be preloaded in the provider browser because k6 cannot import the Node package.

## Artifact Acquisition

| Provider | Default PTK artifact workflow |
| --- | --- |
| Browserbase | Upload packaged automation ZIP, cache returned id by account context and immutable ZIP hash, or use `BROWSERBASE_EXTENSION_ID`. |
| Browserless | User uploads the automation ZIP in Browserless, then configures `BROWSERLESS_EXTENSION_NAME`. The npm helper does not pretend Browserless exposes an upload API. |
| Hyperbrowser | Upload the packaged Chromium ZIP through `@hyperbrowser/sdk`, cache the id by account context/hash, or use `HYPERBROWSER_EXTENSION_ID`; pass the id in session `extensionIds`. |
| BrowserStack Selenium | Use the bundled provenance-checked CRX in Selenium Chrome capabilities. |
| BrowserStack CDP diagnostics | Upload ZIP through `automate/upload-media` and pass the returned `media://...` capability; both PTK and minimal-control live sessions currently omit the extension. |
| Steel Playwright/Puppeteer | Upload the ZIP through `steel-sdk@0.18.0`, cache the id by account context/hash, or use `STEEL_EXTENSION_ID`. The adapter must use a Node file stream: this SDK release incorrectly expands a raw `Buffer` into multipart fields. |
| Steel Selenium diagnostic | Create `isSelenium: true`, attach Steel authentication headers to every W3C command, retry the observed WebDriver-node startup race, and send the bundled CRX. Current Steel Cloud nodes still expose zero installed extensions. |
| TestMu Playwright/Puppeteer | Prefer `@testmuai/testmu-cloud`; use explicit cloud URL/registry id or SDK-first upload. The curl transport is restricted to recognized SDK upload transport failures and never masks authentication failures. |
| TestMu Selenium | Use the bundled provenance-checked CRX in Selenium Chrome capabilities. |

## Security And Dependency Gates

- The base installed `pentestkit@9.9.8` fixture, audited without optional
  provider SDKs, reports **0 vulnerabilities** (0 critical/high/moderate/low).
- Installing current `@testmuai/testmu-cloud@1.0.1` adds **9 high** npm audit
  findings through its Puppeteer-extra/user-data-dir dependency tree. npm
  reports no available fix. These findings are not in the base `pentestkit`
  dependency tree, but users enabling the TestMu SDK path inherit them.
- Provider connection metadata, cache keys, errors and saved matrix evidence
  passed secret-value scanning. Raw provider clients/sessions remain accessible
  for advanced callers but are non-enumerable.
- Provider upload cache entries are separated by opaque account-context
  fingerprints and the immutable extension artifact hash.

## Current Provider Sources

- TestMu Browser Cloud extensions: https://www.testmuai.com/support/docs/browser-cloud-extensions/
- TestMu Playwright: https://www.testmuai.com/support/docs/playwright-testing/
- BrowserStack Chrome extensions for Playwright: https://www.browserstack.com/docs/automate/playwright/chrome-extension-testing
- BrowserStack Selenium: https://www.browserstack.com/docs/automate/selenium/getting-started/nodejs
- Browserbase extensions: https://docs.browserbase.com/platform/browser/core-features/browser-extensions
- Browserbase Selenium: https://docs.browserbase.com/welcome/quickstarts/selenium
- Browserless extensions: https://docs.browserless.io/baas/features/browser-extensions
- Browserless v2 migration (Selenium/WebDriver removed): https://docs.browserless.io/baas/migrate
- Hyperbrowser extensions: https://www.hyperbrowser.ai/docs/sessions/extensions
- Hyperbrowser Playwright: https://www.hyperbrowser.ai/docs/sessions/playwright
- Hyperbrowser Puppeteer: https://www.hyperbrowser.ai/docs/sessions/puppeteer
- Hyperbrowser Selenium: https://www.hyperbrowser.ai/docs/sessions/selenium
- Steel extensions: https://docs.steel.dev/cookbook/extensions
- Steel Playwright: https://docs.steel.dev/integrations/playwright
- Steel Puppeteer: https://docs.steel.dev/integrations/puppeteer
- Steel Selenium: https://docs.steel.dev/integrations/selenium
