# Pro Modules

The module surface currently supports bundled free modules and safe local/cache resolution. Portal-backed Pro downloads are not enabled by default and must not be treated as working until entitlement, download, verification, and cache behavior are implemented and tested.

## Current Supported Commands

```bash
node src/cli/index.cjs modules --help
node src/cli/index.cjs modules list
node src/cli/index.cjs modules resolve --config examples/ptk.config.json
```

Normal `crawl` and `scan` runs also resolve configured modules before launching the browser and write:

- `module-resolution.json`
- `engine-summary.json`

## Planned Pro Flow

1. Read the portal token from the environment variable named by `modules.portal.tokenEnv`, default `PTK_PORTAL_TOKEN`.
2. Resolve entitlements.
3. Download module packs only when `modules.allowNetworkDownloads=true`.
4. Verify signatures and hashes.
5. Cache verified packs under `modules.cacheDir`.
6. Fail closed when entitlement, download, signature, or hash verification fails.

This planned flow is intentionally not claimed as complete.

## Guardrails

- Downloads must not happen as hidden fallback.
- Stubbed download is not success.
- `PTK_PORTAL_TOKEN` values must not appear in resolved config, telemetry, logs, or artifacts.
- Verification failures must stop module execution.
- Pro modules must not reduce deterministic crawler coverage by default.
- Local-dev examples may reference monorepo paths; CI/product docs should use explicit environment variables.

## Example Config Shape

```json
{
  "modules": {
    "packs": ["free"],
    "cacheDir": ".ptk/modules",
    "verifySignatures": true,
    "allowUnsigned": false,
    "allowNetworkDownloads": false,
    "portal": {
      "baseUrl": null,
      "tokenEnv": "PTK_PORTAL_TOKEN"
    }
  }
}
```
