# PTK Agent Python Workspace

This directory contains the Python implementation for the `pentestkit` package and its framework adapters.

Package users should start with the [Python package guide](../docs/pypi/README.md).

## Source Layout

| Directory | Public import | Purpose |
| --- | --- | --- |
| `pentestkit/` | `pentestkit` | Public package combining the supported Python APIs. |
| `core/` | `pentestkit.core` | Framework-neutral PTK lifecycle and result helpers. |
| `playwright/` | `pentestkit.playwright` | Playwright integration. |
| `selenium/` | `pentestkit.selenium` | Selenium integration. |

All Python packages are licensed under [AGPL-3.0-only](../LICENSE.txt).

## Development

Install the public package in editable mode:

```bash
cd pypi/pentestkit
python -m pip install -e .
```

Run compile, import, and package-build checks from the Python workspace:

```bash
cd pypi
python scripts/smoke_packages.py
```

Use `python scripts/smoke_packages.py --no-build` for a faster compile/import check.

Framework browser tests require PTK Auto and an explicitly authorised target. Use a dedicated automation browser profile; never use a personal browsing profile for a security scan.

## Documentation

- [Package overview](../docs/pypi/README.md)
- [Core API](../docs/pypi/core.md)
- [Extension helpers](../docs/pypi/extensions.md)
- [Playwright](../docs/pypi/playwright.md)
- [Selenium](../docs/pypi/selenium.md)

Keep public examples focused on installed-package usage. Scan outputs and browser profiles can contain sensitive application data and should be protected with appropriate access and retention controls.
