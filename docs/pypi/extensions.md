# pentestkit.extensions

`pentestkit.extensions` locates the PTK Auto browser files included with the Python package.

## Basic Usage

```python
from pentestkit.extensions import (
    chromium_unpacked_path,
    chromium_zip_path,
    crx_path,
    xpi_path,
)

local_chromium_extension = chromium_unpacked_path()
provider_upload_zip = chromium_zip_path()
chromium_package = crx_path()
firefox_addon = xpi_path()
```

Framework integrations select the normal extension automatically:

- Playwright uses the packaged Chromium extension for Chromium, Chrome, and Edge.
- Selenium Chrome and Edge can use the unpacked extension where the browser accepts automation extension loading; a prepared profile is more reliable on restricted branded-browser builds.
- Firefox uses the signed XPI with a dedicated automation profile or temporary add-on flow.

## Custom Builds

Use overrides only when intentionally testing a custom PTK Auto build:

```bash
export PTK_EXTENSION_PATH=/absolute/path/to/custom-chromium-extension
export PTK_EXTENSION_ZIP_PATH=/absolute/path/to/custom-chromium.zip
export PTK_EXTENSION_XPI_PATH=/absolute/path/to/custom-firefox.xpi
```

An override is outside the installed package's compatibility contract. Confirm that the custom build is PTK Auto and uses a protocol version compatible with the Python package.

Use a dedicated automation browser profile. Browser profiles and security scan results can contain sensitive application data; restrict access and apply an appropriate retention policy.
