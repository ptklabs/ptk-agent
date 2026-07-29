# Browser Extension Support

PTK Agent uses PTK Auto for browser security automation. The installed `pentestkit` package selects the appropriate packaged extension for supported workflows.

| Integration | Browser | Support | Required setup |
| --- | --- | --- | --- |
| `ptk-scan` / Playwright | Chromium | Supported | Automatic unpacked extension loading. |
| `ptk-scan` / Playwright | Edge | Supported | Automatic unpacked extension loading with an installed Edge executable. |
| `ptk-scan` / Playwright | Chrome | Environment-dependent | Chrome must permit automation extension loading; otherwise use Chromium, Edge, or a prepared profile. |
| `ptk-scan` / Playwright | Firefox | Prepared profile | Install the signed PTK Auto XPI in a dedicated Firefox profile. |
| Puppeteer | Chromium-family | Supported | Use the packaged extension helper or `launchPtkBrowser()`. |
| Selenium | Chromium-family | Supported | Use a prepared profile, unpacked directory, or provider helper as appropriate. |
| Selenium | Firefox | Prepared profile | Install the signed PTK Auto XPI in the Firefox profile. |
| Cypress | Chromium-family | Supported where Cypress permits extension loading | `setupPtkCypress()` prepares the run-specific extension automatically. |
| Cypress | Firefox | Prepared profile | Use a Firefox profile with PTK Auto installed. |

Cloud-browser support depends on whether the provider exposes extension loading for the selected framework. See the [provider support matrix](../docs/npm/provider-browser-matrix.md).

Use a dedicated automation profile and do not run two browser processes against the same profile simultaneously. An automation token or WebSocket connection does not install PTK Auto by itself.
