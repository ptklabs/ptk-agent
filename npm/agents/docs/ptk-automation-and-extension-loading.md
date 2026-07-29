# PTK Automation And Extension Loading

PTK Auto is the browser security runtime used by PTK Agent. The Agent drives the authorised browser journey; PTK Auto performs the selected DAST, IAST, SAST, and SCA work and exports the resulting evidence.

The public browser protocol is documented in [the automation API](../../../docs/automation.md). Installed-package browser setup is documented in [extension loading](../../../docs/npm/extension-loading.md).

## Required Lifecycle

Every PTK-backed run needs:

1. a supported browser with PTK Auto loaded;
2. an explicitly authorised target and bounded scope;
3. a PTK session started for the target origin;
4. the application journey or crawl;
5. engine drainage and a terminal stop;
6. a successful findings export;
7. browser and provider cleanup.

Use `window.PTK_AGENT` as the primary workflow API. `window.PTK_AUTOMATION` is the lower-level compatibility and chunked-export API.

Full navigation replaces page JavaScript state. Wait for the bridge again after a navigation before issuing lifecycle, status, findings, or export calls.

## IAST Before Navigation

IAST document-start hooks must be armed before the first application document loads. Framework helpers do this automatically when `bootstrapUrl` is provided. A custom journey using `deferStart` should call `armPtkIastForNavigation(targetUrl)` before its first `goto()` or `driver.get()`.

The arm operation is restricted to the exact approved origin and does not authorise external navigation.

## Browser Support

| Browser | Recommended loading mode |
| --- | --- |
| Chromium | Automatic unpacked PTK Auto loading. |
| Edge | Chromium integration with an installed Edge executable. |
| Chrome | Unpacked loading where local policy permits it; otherwise use a prepared profile, Edge, or Chromium. |
| Firefox | Dedicated profile with the signed PTK Auto XPI installed. |

A WebSocket endpoint, CDP connection, or browser bridge token does not install PTK Auto. Cloud-provider support also depends on whether that provider exposes custom extensions for the selected framework.

## Profiles

Use a dedicated automation profile for each browser family. Do not use a personal daily-browsing profile for security scans, and do not open the same profile from two browser processes simultaneously.

PTK Auto requires no manual mode switch. A prepared profile using the separate full OWASP PTK extension must have Automation Mode enabled.

## Validity

- Missing bridge means PTK was not available; it is not zero findings.
- Missing export means the findings comparison is invalid.
- A terminal export with zero findings is a valid result.
- Requested engines must show participation separately from finding counts.
- Browser closure must wait for engine and publisher queues to drain.

Lifecycle output should preserve these distinctions without exposing credentials, cookies, authorisation headers, tokens, request bodies, or replay secrets.
