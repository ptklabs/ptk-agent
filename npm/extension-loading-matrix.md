# PTK SDK Extension Loading Matrix

This matrix describes how each SDK/browser combination uses the PTK extension today.

For the user-facing automation overview and setup flow, see the [npm source README](https://github.com/ptklabs/ptk-agent/blob/main/npm/README.md).

This is the source-tree SDK matrix. When the npm package is installed, the Agent CLI and Node integrations resolve the bundled extension from `node_modules/pentestkit/extensions/` before any local-dev fallback.

| Framework / SDK | Browser | Unpacked extension load | Pre-installed extension/profile | Notes |
|---|---|---:|---:|---|
| Agent SDK direct (`ptk-scan`, default) | Chromium | Yes | Optional | SDK tests load `dist/ptk_extension_unpacked_automation` or the bundled package extension with `--load-extension`; the artifact provides the automation-enabled default. |
| Agent SDK direct (`ptk-scan`, default) | Chrome | Best effort | Optional | Some branded Chrome builds ignore command-line unpacked extension loading even with Playwright extension flags. If PTK service worker is missing, use Chromium or Edge. |
| Agent SDK direct (`ptk-scan`, default) | Edge | Yes | Optional | Same as Chromium, using the configured Edge executable. |
| Agent SDK direct (`ptk-scan`, default) | Firefox | No | Yes | Source mode uses `ptk-agent/dist/ptk-latest-automation.xpi`; installed-package mode resolves the bundled AMO-signed XPI with `pentestkit/extensions.resolvePtkXpiArtifact()`. Playwright Firefox may still reject/remove it, so use a Firefox-prepared profile with PTK Auto installed. |
| Playwright (Python) | Chromium | Yes | Optional (recommended for persisted automation state) | Uses `PTK_EXTENSION_PATH` + `--load-extension`; keep `PTK_PROFILE_DIR` for stable state. |
| Playwright (Python) | Chrome | Best effort | Optional (recommended for persisted automation state) | Same flow as Chromium when the installed Chrome accepts unpacked extension loading; otherwise use Chromium, Edge, or a prepared profile path. |
| Playwright (Python) | Edge | Yes | Optional (recommended for persisted automation state) | Same flow as Chromium. |
| Playwright (Python) | Firefox | No | Yes | Requires the signed `.xpi` pre-installed in the profile as `extensions/ptk-automation-agent@ptklabs.com.xpi`. |
| Cypress | Chrome for Testing | Yes | No (plugin profile mode not implemented for Chromium-family) | Uses `PTK_EXTENSION_PATH` or packaged auto-resolution via `before:browser:launch`; release baseline is headed mode. |
| Cypress | Chromium | Yes | No (plugin profile mode not implemented for Chromium-family) | Uses `PTK_EXTENSION_PATH` or packaged auto-resolution via `before:browser:launch`; release baseline is headed mode. |
| Cypress | Edge | Yes | No (plugin profile mode not implemented for Chromium-family) | Uses `PTK_EXTENSION_PATH` via `before:browser:launch`. |
| Cypress | Firefox | Yes | Yes | Supports both `PTK_EXTENSION_PATH` and `PTK_PROFILE_DIR` (profile mode). |
| Selenium (Python) | Chrome | No | Yes | Profile mode only (`install_mode=profile`). |
| Selenium (Python) | Edge | No | Yes | Profile mode only (`install_mode=profile`). |
| Selenium (Python) | Firefox | No (directory) / Yes (`.xpi` runtime) | Yes | Supports `install_mode=temporary` (`driver.install_addon(.xpi)`) and `install_mode=profile`. |

## Recommended Standard Policy

1. Prefer the Agent SDK direct mode with Chromium or Edge for unattended local scans because it controls Playwright directly and reliably loads PTK source in those browsers.
2. Use dedicated test profiles per browser (`PTK_PROFILE_DIR`) across all SDKs when profile persistence matters.
3. Install the signed PTK Auto XPI in dedicated Firefox profiles. Only profiles using the separate full extension need its manual Automation Mode setting.
4. Do not confuse browser bridge tokens with PTK installation. A token only lets a browser-tool adapter connect to an already configured browser.
5. Use unpacked loading only where the framework/browser supports it; Firefox requires a Firefox-prepared XPI/profile path, and branded Chrome may require a manually prepared profile outside the canonical Agent SDK command.

## Agent SDK Support Contract

- Supported unattended baseline: Chromium and Edge in direct mode.
- Best-effort only: branded Chrome source-extension launch. If the PTK service worker is missing, do not treat this as a scan failure; switch to Chromium or Edge.
- Prepared-profile only: Firefox. A copied XPI in a fresh Playwright profile is only a preparation attempt, not proof of support. Firefox is supported when the provided profile already proves PTK injection and Automation Mode on the target tab.
