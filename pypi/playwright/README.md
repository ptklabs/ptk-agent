# PTK Playwright Python Source

This directory implements the `pentestkit.playwright` integration.

```bash
python -m pip install -e .
playwright install chromium
```

Use `PTK_EXTENSION_PATH` only when intentionally testing a custom unpacked PTK Auto build:

```bash
export PTK_EXTENSION_PATH=/absolute/path/to/custom-ptk-auto
```

Public usage is documented in [Playwright for Python](../../docs/pypi/playwright.md). Run package checks from `pypi/` with:

```bash
python scripts/smoke_packages.py
```
