# PTK PyPI SDK Source

This directory contains the source packages for PTK Python SDKs. The public PyPI distribution is `pentestkit`, matching the npm package name. Published package documentation lives under `ptk-agent/docs/pypi/`; the README files in this directory are for source-tree development and release validation.

All Python packages in this repository are licensed under GNU AGPL v3.0 (`AGPL-3.0-only`). Release staging includes the repository `LICENSE.txt` in every wheel and source distribution.

| Directory | Package | Import | Purpose |
| --- | --- | --- | --- |
| `pentestkit/` | `pentestkit` | `pentestkit` | Public PyPI package with `pentestkit.core`, `pentestkit.extensions`, `pentestkit.playwright`, and `pentestkit.selenium`. |
| `core/` | `ptk-core` | `ptk_core` | Shared bridge, lifecycle, result, redaction, and exception helpers. |
| `playwright/` | `ptk-playwright` | `ptk_playwright` | Playwright Python wrapper around PTK scan lifecycle. |
| `selenium/` | `ptk-selenium` | `ptk_selenium` | Selenium WebDriver wrapper around PTK scan lifecycle. |

## Package Docs

- `docs/pypi/README.md`: `pentestkit` package overview
- `docs/pypi/core.md`: `pentestkit.core` package docs
- `docs/pypi/extensions.md`: `pentestkit.extensions` package docs
- `docs/pypi/playwright.md`: `pentestkit.playwright` package docs
- `docs/pypi/selenium.md`: `pentestkit.selenium` package docs

Publish builds are staged before packaging. The staging step copies the package source to a temporary directory, replaces `README.md` with the corresponding `docs/pypi/*.md` file, copies `chrome_<version>_automation.zip`, `ptk-latest-automation.crx`, and `ptk-latest-automation.xpi` from `dist/`, unpacks the CRX into `pentestkit/extensions/chromium-unpacked`, and writes extension provenance with `automationEnabledDefault: true`. The installed package keeps stable artifact names (`ptk-latest-chromium.zip`, `ptk-latest.crx`, and `ptk-latest.xpi`) under `pentestkit/extensions/`.

## Build Packages

This repository does not build the browser extension. Copy or download the prebuilt PTK automation-extension artifacts into repo-root `dist/` before staging packages.

Build the public PyPI package artifacts from this source tree:

```bash
cd ptk-agent/pypi
python3 scripts/build_pypi_package.py --extension-input-dir ../dist
```

This writes publish artifacts to `pypi/.release/pypi/`:

- `pentestkit-<version>-py3-none-any.whl`
- `pentestkit-<version>.tar.gz`

Build npm release artifacts from the same repo-root `dist/`:

```bash
cd ../npm
npm run build:npm:release
```

## Source Setup

Install the public package editable from the source tree:

```bash
cd ptk-agent/pypi/pentestkit
pip install -e .
```

Install the internal implementation packages only when changing or validating their compatibility shims:

```bash
cd ptk-agent/pypi/core
pip install -e .

cd ../playwright
pip install -e .

cd ../selenium
pip install -e .
```

Install browser/runtime dependencies as needed:

```bash
playwright install chromium
pip install selenium
```

## Smoke Checks

Run compile, public import, internal import, and public wheel-build smoke from this directory:

```bash
cd ptk-agent/pypi
python scripts/smoke_packages.py
```

Build internal implementation wheels too when validating the compatibility packages:

```bash
python scripts/smoke_packages.py --include-internal
```

Skip wheel builds when you only need a fast import/compile pass:

```bash
python scripts/smoke_packages.py --no-build
```

The integration preflight also runs PyPI import smoke unless `--skip-pypi` is passed:

```bash
cd integrations
npm run test:integrations -- --preflight-only --skip-provider-run
```

## Examples And Smoke Fixtures

Public examples under each package's `examples/` directory should stay short and show the reusable package API. Full Juice Shop release validation belongs under `smoke/`.

Generated wheels, virtualenvs, caches, traces, browser profiles, and scan artifacts must stay out of source control.
