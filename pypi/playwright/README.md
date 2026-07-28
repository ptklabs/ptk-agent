# ptk-playwright Source

This directory contains the internal source for the `ptk-playwright` implementation package. Public package documentation is maintained in `ptk-agent/docs/pypi/playwright.md` for the `pentestkit.playwright` import surface.

## Source Setup

```bash
cd ptk-agent/pypi/playwright
pip install -e .
playwright install chromium
```

For local source runs, provide the unpacked PTK automation artifact:

```bash
export PTK_EXTENSION_PATH=/path/to/ptk-agent/dist/ptk_extension_unpacked_automation
```

## Package Shape

- `src/ptk_playwright/`: public package source
- `examples/`: short examples that demonstrate the reusable API
- `smoke/`: release-gated Juice Shop flow with engine/finding checks
- `pyproject.toml`: package metadata and published README path

Public examples should stay small. Add comprehensive release validation to `smoke/`.

## Smoke

Run the Playwright Juice Shop smoke from this directory:

```bash
PTK_EXTENSION_PATH=/path/to/ptk-agent/dist/ptk_extension_unpacked_automation \
JUICE_SHOP_URL=http://127.0.0.1:3001 \
./smoke/run_juice_shop_smoke.sh chromium
```

Run package compile/import/wheel smoke from the PyPI SDK root:

```bash
cd ptk-agent/pypi
python scripts/smoke_packages.py
```

Set `PTK_IMMEDIATE_ANALYSIS=0` to verify deferred stop-time analysis.
