# PTK Auto Extension Loading

Browser scans require PTK Auto, the automation runtime for OWASP Penetration Testing Kit. The `pentestkit` package includes browser-specific builds and prepares the correct form for each supported local framework or cloud provider.

For a normal installation, no separate extension download is required.

## Check Your Installation

```bash
npx ptk-agent --doctor-extension
```

A registry installation normally reports:

```json
{
  "source": "bundled-package"
}
```

The diagnostic also reports the selected browser format and extension version. If it reports an explicit or environment override, unset that override to return to the packaged PTK Auto build.

## Browser Formats

The package contains four PTK Auto browser formats because browser APIs accept different package types:

| File type | Used for |
| --- | --- |
| Chromium ZIP | Local unpacked loading and provider uploads that accept ZIP files. |
| Firefox ZIP | Provider uploads that require a Firefox ZIP. |
| Chrome Web Store CRX | Selenium/Grid capabilities and platforms that require a packaged Chromium extension. |
| Signed Firefox XPI | Firefox profiles and APIs that install signed add-ons. |

The framework and provider helpers choose a format automatically. Users should not convert the Chromium ZIP into a Firefox package, or the Firefox ZIP into a Chromium package; their manifests and browser permissions differ.

## Local Browser Support

| Browser | Recommended setup |
| --- | --- |
| Chromium | Automatic unpacked loading through the CLI or framework helper. |
| Microsoft Edge | Automatic unpacked loading through the Chromium integration. |
| Google Chrome | Use the normal Chromium integration when local policy permits extension loading; otherwise use Edge, Chromium, or a prepared Chrome profile. |
| Firefox | Use a dedicated profile with the signed PTK Auto XPI installed. |

Do not reuse a profile that is already open in another browser process. For unattended CI, use a dedicated automation profile rather than a personal browsing profile.

## Framework Helpers

Local Playwright and Puppeteer integrations can request an unpacked Chromium directory:

```js
const { ensureUnpackedPtkExtension } = require("pentestkit/extensions");

const extension = ensureUnpackedPtkExtension();
console.log(extension.path);
```

Cloud providers normally do not need this call; use the provider helper, which supplies the browser format expected by that platform.

The main extension resolver APIs are:

```js
const {
  ensureUnpackedPtkExtension,
  resolvePtkCrxArtifact,
  resolvePtkExtensionArtifact,
  resolvePtkFirefoxZipArtifact,
  resolvePtkXpiArtifact
} = require("pentestkit/extensions");
```

| Helper | Result |
| --- | --- |
| `ensureUnpackedPtkExtension()` | An unpacked Chromium extension directory. |
| `resolvePtkExtensionArtifact()` | The packaged Chromium ZIP. |
| `resolvePtkFirefoxZipArtifact()` | The packaged Firefox ZIP. |
| `resolvePtkCrxArtifact()` | The store-published Chromium CRX. |
| `resolvePtkXpiArtifact()` | The signed Firefox XPI. |

## Custom Extension Builds

Most users should use the bundled extension. To test a custom unpacked Chromium build, supply an absolute directory containing `manifest.json`:

```bash
PTK_EXTENSION_DIR=/absolute/path/to/custom-ptk-auto \
  npx ptk-agent --doctor-extension
```

or for one scan:

```bash
npx ptk-scan https://your-authorised-target.example \
  --ptk-extension-dir /absolute/path/to/custom-ptk-auto
```

`PTK_EXTENSION_DIR` takes precedence over `PTK_EXTENSION_PATH`. Remove both variables when diagnosing the installed package.

A custom extension is outside the package's tested compatibility contract. Confirm that it is PTK Auto, that Automation Mode is active, and that its protocol version is compatible with your installed `pentestkit` version.

## Cloud Providers

Remote platforms load extensions differently. Some upload a ZIP and return an extension ID; others accept a CRX in session capabilities or require an extension already present in the remote profile. The provider helpers hide those differences where the platform supports them.

Do not assume that a provider's general Playwright, Puppeteer, or Selenium support also means it supports extensions in that framework. Check the [provider support matrix](provider-browser-matrix.md) and the provider's official documentation.

## Common Problems

### The PTK bridge is missing

1. Run `npx ptk-agent --doctor-extension`.
2. Try a headed Chromium run so extension startup is visible.
3. Close other browser processes using the same profile.
4. For Firefox, confirm that the signed XPI is installed in the profile.
5. For a cloud provider, confirm that the selected provider/framework combination supports browser extensions.

### An environment override is selected unexpectedly

```bash
unset PTK_EXTENSION_DIR
unset PTK_EXTENSION_PATH
npx ptk-agent --doctor-extension
```

### A browser starts but no scan is recorded

Use `--require-ptk-bridge` and `--require-ptk-findings-export` so the run fails explicitly instead of returning an apparently successful browser journey without PTK evidence.

See [troubleshooting](troubleshooting.md) for additional checks.
