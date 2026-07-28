# pentestkit.playwright

`pentestkit.playwright` wraps Playwright Python tests with PTK scan lifecycle calls. Your Playwright script drives the application; PTK starts before the flow, scans while the flow runs, then stops and exports findings.

It is distributed as part of `pentestkit` under [GNU AGPL v3.0](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt) (`AGPL-3.0-only`).

## Install

```bash
pip install pentestkit
playwright install chromium
```

Install Firefox too if you plan to run Firefox profile flows:

```bash
playwright install firefox
```

## Extension Boundary

The PyPI package bundles PTK extension artifacts. For Chromium, Chrome, and Edge, `PTKPlaywrightConfig` uses the bundled unpacked extension automatically when `extension_path` is not set.

Override the bundled extension only for custom builds:

```bash
export PTK_EXTENSION_PATH=/path/to/chromium-unpacked
```

Firefox still requires a profile containing `pentestkit@DenisPodgurskii.xpi`.

## Basic Usage

```python
from pentestkit.playwright import PTKPlaywrightConfig, ptk_session

config = PTKPlaywrightConfig(
    browser="chromium",
    profile_dir=".ptk/profiles/playwright",
    headless=False,
    project="playwright-flow",
    engines=["DAST", "IAST"],
    artifacts_dir=".ptk/results/playwright",
)

with ptk_session(config, target_url="https://target.example") as (page, ptk):
    page.locator("input[type=search]").fill("test")
    page.keyboard.press("Enter")
```

When IAST is selected, `target_url` is armed before the first application navigation so document-start hooks observe the initial load without reloading the page.

Environment-driven configuration is usually better for CI:

```bash
export PTK_PROFILE_DIR=.ptk/profiles/playwright
export PTK_ENGINES=DAST,IAST
export PTK_ARTIFACTS_DIR=.ptk/results/playwright
```

```python
from pentestkit.playwright import PTKPlaywrightConfig, ptk_session

config = PTKPlaywrightConfig.from_env()

with ptk_session(config, target_url="https://target.example") as (page, ptk):
    page.locator("input[type=search]").fill("test")
    page.keyboard.press("Enter")
```

## Browser Support

| Browser | `PTK_BROWSER` | Extension loading |
| --- | --- | --- |
| Playwright Chromium | `chromium` | Bundled unpacked extension by default. |
| Chrome | `chrome` | Unpacked extension when the installed Chrome build accepts it. |
| Edge | `edge` | Bundled unpacked extension by default. |
| Playwright Firefox | `firefox` | PTK XPI pre-installed in the Firefox profile. |

Playwright Firefox must use Playwright's bundled Firefox because it needs the Juggler protocol. System Firefox and Firefox Developer Edition are not Playwright-compatible browser targets.

## Stop-Time Analysis

Normal automation computes PTK analysis when the session stops. Defer that work when CI should stop/export quickly and recompute later in PTK:

```python
result = ptk.end_session(wait=True, immediate_analysis=False)
```

For context-manager flows, set an environment variable or config option:

```bash
export PTK_IMMEDIATE_ANALYSIS=0
```

```python
config = PTKPlaywrightConfig.from_env()
config.immediate_analysis = False
```

## Common Configuration

| Environment variable | Config field |
| --- | --- |
| `PTK_BROWSER` | `browser` |
| `PTK_HEADLESS` | `headless` |
| `PTK_EXECUTABLE_PATH` | `executable_path` |
| `PTK_EXTENSION_PATH` | `extension_path` |
| `PTK_PROFILE_DIR` | `profile_dir` |
| `PTK_PROFILE_BASE` | `profile_base_dir` |
| `PTK_PROJECT` | `project` |
| `PTK_ENGINES` | `engines` |
| `PTK_POLICY_CODE` | `policy_code` |
| `PTK_IMMEDIATE_ANALYSIS` | `immediate_analysis` |
| `PTK_ARTIFACTS_DIR` | `artifacts_dir` |

## Troubleshooting

`PTK automation bridge not available` means the browser page cannot see `window.PTK_AUTOMATION`. Check that the PTK extension loaded and Automation Mode is enabled.

`extension_path is required` means bundled artifacts were not available and no override was set. Reinstall the packaged `pentestkit` distribution or set `PTK_EXTENSION_PATH` to an unpacked PTK extension directory.

If a branded Chrome build ignores `--load-extension`, use Playwright Chromium, Edge, or a prepared profile flow.
