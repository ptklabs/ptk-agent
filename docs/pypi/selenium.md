# pentestkit.selenium

`pentestkit.selenium` wraps Selenium WebDriver tests with PTK scan lifecycle calls. Your Selenium script drives the application; PTK starts before the flow, scans while the flow runs, then stops and exports findings.

It is distributed as part of `pentestkit` under [GNU AGPL v3.0](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt) (`AGPL-3.0-only`).

## Install

```bash
pip install pentestkit
```

Selenium 4 includes Selenium Manager for browser drivers. Install browser-specific drivers manually only when your environment requires it.

## Extension Boundary

The PyPI package bundles PTK extension artifacts. `PTKConfig` resolves bundled paths automatically:

- `extension_path` defaults to the bundled unpacked Chromium extension for Chrome and Edge.
- `extension_xpi_path` defaults to the bundled XPI for Firefox.

Selenium Chrome and Edge are still most stable with prepared profiles. Newer branded Chrome/Edge builds may reject unpacked extension loading through command-line flags. Use the bundled unpacked extension for Chrome or Edge only when your browser build accepts `--load-extension`.

## Basic Usage

```python
from pentestkit.selenium import PTKConfig, ptk_session
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

config = PTKConfig(
    browser="chrome",
    profile_dir="/path/to/prepared-ptk-profile",
    headless=False,
    project="selenium-flow",
    engines=["DAST", "IAST"],
    artifacts_dir=".ptk/results/selenium",
)

with ptk_session(config, target_url="https://target.example") as (driver, ptk):
    driver.find_element(By.CSS_SELECTOR, "input[type=search]").send_keys("test", Keys.ENTER)
    result = ptk.end_session(wait=True)
```

When IAST is selected, `target_url` is armed before the first application navigation so document-start hooks observe the initial load without reloading the page. Firefox uses a private automation-extension frame in a fresh `about:blank` tab for this handshake; no privileged WebDriver system context is enabled.

Environment-driven configuration is usually better for CI:

```bash
export PTK_BROWSER=chrome
export PTK_PROFILE_DIR=/path/to/prepared-ptk-profile
export PTK_ENGINES=DAST,IAST
export PTK_ARTIFACTS_DIR=.ptk/results/selenium
```

```python
from pentestkit.selenium import PTKConfig, ptk_session

config = PTKConfig.from_env()

with ptk_session(config, target_url="https://target.example") as (driver, ptk):
    result = ptk.end_session(wait=True)
```

## Browser Support

| Browser | `PTK_BROWSER` | Extension loading |
| --- | --- | --- |
| Chrome | `chrome` | Prepared profile with PTK installed. |
| Edge | `edge` | Prepared profile with PTK installed. |
| Firefox | `firefox` | Prepared profile or temporary XPI install. |

Firefox temporary-addon mode:

```bash
PTK_BROWSER=firefox \
PTK_INSTALL_MODE=temporary \
PTK_PROFILE_DIR=.ptk/profiles/firefox \
python your_test.py
```

## Stop-Time Analysis

Normal automation computes PTK analysis when the session stops. Defer that work when CI should stop/export quickly and recompute later in PTK:

```python
result = ptk.end_session(wait=True, immediate_analysis=False)
```

Or use the environment variable:

```bash
export PTK_IMMEDIATE_ANALYSIS=0
```

## Common Configuration

| Environment variable | Config field |
| --- | --- |
| `PTK_BROWSER` | `browser` |
| `PTK_HEADLESS` | `headless` |
| `PTK_PROFILE_DIR` | `profile_dir` |
| `PTK_PROFILE_BASE` | `profile_base_dir` |
| `PTK_PROFILE_NAME` | `profile_name` |
| `PTK_CHROME_BINARY` | `chrome_binary` |
| `PTK_EDGE_BINARY` | `edge_binary` |
| `PTK_FIREFOX_BINARY` | `firefox_binary` |
| `PTK_EXTENSION_PATH` | `extension_path` |
| `PTK_EXTENSION_XPI_PATH` | `extension_xpi_path` |
| `PTK_PROJECT` | `project` |
| `PTK_ENGINES` | `engines` |
| `PTK_POLICY_CODE` | `policy_code` |
| `PTK_IMMEDIATE_ANALYSIS` | `immediate_analysis` |
| `PTK_ARTIFACTS_DIR` | `artifacts_dir` |

## Troubleshooting

`PTK automation bridge not available` means Selenium reached the page but page JavaScript cannot see `window.PTK_AUTOMATION`. Check that PTK is installed in the exact profile Selenium launched and Automation Mode is enabled.

`Profile is locked` means another browser instance is using the profile. Close all windows for that browser or use a different profile path.

For Chrome or Edge, use a prepared profile before treating command-line extension-loading failure as a scanner issue.
