# pentestkit.extensions

`pentestkit.extensions` exposes the PTK browser extension artifacts bundled in the PyPI package.

## Included Artifacts

```text
pentestkit/extensions/
  chromium-unpacked/
  ptk-latest.zip
  ptk-latest-chromium.zip
  ptk-latest.crx
  ptk-latest-chromium.crx
  ptk-latest.xpi
  ptk-latest-firefox.xpi
  extension-provenance.json
```

The installed package keeps stable artifact names, but those files are built from the automation artifact set in `dist/` and include `dev.local.json` with `automationEnabled: true`. `ptk-latest-chromium.zip` is the Chromium MV3 archive for provider uploads. Store artifacts remain separate and automation-disabled.

## Basic Usage

```python
from pentestkit.extensions import (
    chromium_unpacked_path,
    chromium_zip_path,
    crx_path,
    extension_provenance,
    xpi_path,
)

extension_path = chromium_unpacked_path()
provider_upload_zip = chromium_zip_path()
firefox_xpi = xpi_path()
provenance = extension_provenance()
```

Resolution order:

1. Explicit environment override such as `PTK_EXTENSION_PATH`, `PTK_EXTENSION_DIR`, `PTK_EXTENSION_ZIP_PATH`, or `PTK_EXTENSION_XPI_PATH`.
2. Bundled artifacts from the installed `pentestkit` package.

## Framework Defaults

`pentestkit.playwright` uses the bundled unpacked Chromium extension automatically for Chromium, Chrome, and Edge when `extension_path` is not set.

`pentestkit.selenium` resolves bundled artifact paths automatically. Chrome and Edge still default to prepared-profile mode because browser vendors may reject command-line extension loading in branded builds. Use the bundled unpacked path for Selenium Chrome or Edge only when your browser build accepts `--load-extension`.

Firefox temporary-addon flows use the bundled `ptk-latest.xpi` when `extension_xpi_path` is not set.

## Overrides

Use overrides for custom extension builds or externally managed release artifacts:

```bash
export PTK_EXTENSION_PATH=/path/to/chromium-unpacked
export PTK_EXTENSION_ZIP_PATH=/path/to/ptk-latest-chromium.zip
export PTK_EXTENSION_XPI_PATH=/path/to/ptk-latest.xpi
```
