# PTK Agent Node.js Workspace

This directory contains the Node.js implementation published in the [`pentestkit`](https://www.npmjs.com/package/pentestkit) package.

Package users should start with the [npm package guide](../docs/npm/README.md). The pages under [`../docs/npm/`](../docs/npm/README.md) describe supported commands, framework integrations, providers, extension loading, and troubleshooting.

## Source Layout

| Area | Public surface |
| --- | --- |
| `agents/` | `ptk-scan`, `ptk-agent`, and `ptk-agent-mcp-server` |
| `browser/` | `pentestkit/browser` |
| `frameworks/playwright/` | `pentestkit/playwright` |
| `frameworks/puppeteer/` | `pentestkit/puppeteer` |
| `frameworks/selenium/` | `pentestkit/selenium` |
| `frameworks/cypress/` | `pentestkit/cypress` |
| `providers/` | `pentestkit/providers/*` |

## Development

Install workspace dependencies:

```bash
cd npm
npm install
```

Run the repository audit and Node.js test suite:

```bash
npm run test:ci
```

Validate package assembly and public imports when changing package boundaries, documentation, or extension resolution:

```bash
npm run test:npm
```

Run framework validation when changing browser integration code:

```bash
npm run preflight:release-frameworks
npm run test:release-frameworks -- --mode package --baseline-only
```

Provider tests use real third-party accounts and should be run only against an explicitly authorised target. Supply credentials through environment variables; see [provider integrations](../docs/npm/providers.md).

## Documentation Changes

Public behavior must be documented under [`../docs/npm/`](../docs/npm/README.md). Keep those pages focused on installed-package users:

- use registry installation and public imports in examples;
- describe supported behavior rather than individual test runs;
- use environment variables or secret managers for credentials;
- explain scan-output protection as a user security responsibility;
- keep implementation and release operations out of user guides.

The package-assembly tests validate links and the public documentation boundary.

## License

The Node.js package is licensed under [AGPL-3.0-only](../LICENSE.txt).
