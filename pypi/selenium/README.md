# ptk-selenium Source

This directory contains the internal source for the `ptk-selenium` implementation package. Public package documentation is maintained in `ptk-agent/docs/pypi/selenium.md` for the `pentestkit.selenium` import surface.

## Source Setup

```bash
cd ptk-agent/pypi/selenium
pip install -e .
```

Use a prepared browser profile for Chrome/Edge source runs:

```bash
export PTK_BROWSER=chrome
export PTK_PROFILE_DIR=/path/to/prepared-ptk-profile
```

Firefox development can use temporary XPI mode:

```bash
export PTK_BROWSER=firefox
export PTK_EXTENSION_XPI_PATH=/path/to/ptk-latest.xpi
```

## Package Shape

- `src/ptk_selenium/`: public package source
- `examples/`: short examples that demonstrate the reusable API
- `smoke/`: release-gated Juice Shop flow with engine/finding checks
- `tests/`: package unit tests
- `pyproject.toml`: package metadata and published README path

Public examples should stay small. Add comprehensive release validation to `smoke/`.

## Smoke

Run the Selenium Juice Shop smoke from this directory:

```bash
PTK_BROWSER=chrome \
PTK_PROFILE_DIR=/path/to/prepared-ptk-profile \
JUICE_SHOP_URL=http://127.0.0.1:3001 \
./smoke/run_juice_shop_smoke.sh chrome
```

Run package compile/import/wheel smoke from the PyPI SDK root:

```bash
cd ptk-agent/pypi
python scripts/smoke_packages.py
```

Set `PTK_IMMEDIATE_ANALYSIS=0` to verify deferred stop-time analysis.
