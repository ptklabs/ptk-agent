# PentestKit PyPI Package

The `pentestkit` Python package wraps existing Python browser automation with PTK scan lifecycle calls. Your Playwright or Selenium test still drives the application; PTK observes and scans the browser traffic, routes, client-side state, and findings created during that journey.

Source code is maintained at [ptklabs/ptk-agent](https://github.com/ptklabs/ptk-agent). This package is licensed under [GNU AGPL v3.0](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt) (`AGPL-3.0-only`).

## Install

```bash
pip install pentestkit
```

Install the browser runtime needed by your framework:

```bash
playwright install chromium
```

Selenium 4 includes Selenium Manager for browser drivers. Install browser-specific drivers manually only when your environment requires it.

## Imports

Use framework subpackages from the single `pentestkit` distribution:

```python
from pentestkit.playwright import PTKPlaywrightConfig, ptk_session
from pentestkit.selenium import PTKConfig, ptk_session
from pentestkit.extensions import chromium_unpacked_path, xpi_path
from pentestkit.core import PTKBridge
```

## Framework Modules

Use `pentestkit.playwright` for Playwright Python suites, `pentestkit.selenium` for Selenium WebDriver suites, `pentestkit.extensions` for bundled extension artifact paths, and `pentestkit.core` only when building a custom framework adapter.

## PTK Auto

The package includes the PTK Auto browser runtime required by the framework integrations. Playwright Chromium, Chrome, and Edge use the packaged Chromium extension by default. Override `PTK_EXTENSION_PATH` only when intentionally testing a custom extension build.

Selenium Chrome and Edge still work best with prepared profiles in many environments, but the bundled unpacked extension path is available through `pentestkit.extensions.chromium_unpacked_path()` and `PTKConfig.extension_path`. Firefox temporary-addon mode uses the bundled XPI unless `PTK_EXTENSION_XPI_PATH` is set.

PTK Auto is the dedicated automation extension; no manual Automation Mode setting is required.

Use dedicated automation profiles. Do not use a daily browser profile for security scans.

## Stop-Time Analysis

Normal automation computes PTK analysis when the scan stops. Set `PTK_IMMEDIATE_ANALYSIS=0` or pass `immediate_analysis=False` when CI should stop/export quickly and recompute analysis later after importing or opening the scan in PTK.
