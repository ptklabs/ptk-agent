# PTK npm Package Source

This directory is the source and release workspace for the `pentestkit` npm package. It is not the installed package root that end-user tests import from directly.

Public npm users should start with [../docs/npm/README.md](../docs/npm/README.md). Keep user-facing usage, provider setup, extension artifact behavior, and copy-paste examples in `docs/npm/*`; this file should stay focused on source-tree build, staging, validation, and publish preparation.

## Public Documentation

The published package uses [../docs/npm/README.md](../docs/npm/README.md) as its package root `README.md`, and also includes the npm docs under `docs/npm/`.

Public docs:

| Topic | Doc |
| --- | --- |
| npm package overview | [../docs/npm/README.md](../docs/npm/README.md) |
| CLI commands | [../docs/npm/cli.md](../docs/npm/cli.md) |
| SARIF and severity gates | [../docs/npm/sarif.md](../docs/npm/sarif.md) |
| GitHub Actions | [../docs/npm/github-actions.md](../docs/npm/github-actions.md) |
| Configuration files | [../docs/npm/configuration.md](../docs/npm/configuration.md) |
| Extension ZIP, unpacked, CRX, XPI, cache, keys | [../docs/npm/extension-loading.md](../docs/npm/extension-loading.md) |
| Framework integrations | [../docs/npm/frameworks.md](../docs/npm/frameworks.md) |
| Provider integrations | [../docs/npm/providers.md](../docs/npm/providers.md) |
| Provider browser matrix | [../docs/npm/provider-browser-matrix.md](../docs/npm/provider-browser-matrix.md) |
| Authenticated scans | [../docs/npm/authenticated-scans.md](../docs/npm/authenticated-scans.md) |
| Scenario-guided scans | [../docs/npm/scenarios.md](../docs/npm/scenarios.md) |
| MCP server | [../docs/npm/mcp-server.md](../docs/npm/mcp-server.md) |
| Troubleshooting | [../docs/npm/troubleshooting.md](../docs/npm/troubleshooting.md) |

If package behavior changes, update the relevant public doc first, then update source/release notes here only when the build or validation workflow changes.

## Source Layout

| Area | Public import or command | Source docs |
| --- | --- | --- |
| Agent CLI | `ptk-scan`, `ptk-agent`, `ptk-agent-mcp-server` | [agents](agents/README.md) |
| Browser helpers | `pentestkit/browser` | [browser](browser/README.md) |
| Playwright JS | `pentestkit/playwright` | [frameworks/playwright](frameworks/playwright/README.md) |
| Selenium JS | `pentestkit/selenium` | [frameworks/selenium](frameworks/selenium/README.md) |
| Cypress | `pentestkit/cypress` | [frameworks/cypress](frameworks/cypress/README.md) |
| Puppeteer | `pentestkit/puppeteer` | [frameworks/puppeteer](frameworks/puppeteer/README.md) |
| Providers | `pentestkit/providers/*` | [providers](providers/README.md) |

The package builder stages only the public runtime surface. Internal release scripts, framework smoke fixtures, benchmark fixtures, duplicate source-package bins, and stale split-package metadata are kept in the repo but excluded from the npm tarball.

## Build And Stage

This repository does not build the browser extension. Copy or download the prebuilt PTK automation-extension artifacts into repo-root `dist/` before staging packages.

Do not use a mutable `latest` download for a release. The protected repository workflow downloads an exact extension release tag and requires an independently supplied SHA-256 for `extension-provenance-automation.json` before it trusts the hashes inside that file.

Stage and smoke the local npm package:

```bash
cd ptk-agent/npm
npm run test:npm
```

The staging step consumes automation artifacts from `../dist`, including:

```text
chrome_<version>_automation.zip
ptk-latest-automation.crx
ptk-latest-automation.xpi
extension-provenance-automation.json
```

The published package does not ship those artifact names. It stages:

```text
extensions/ptk-latest.zip
extensions/ptk-latest-firefox.zip
extensions/ptk-latest.crx
extensions/ptk-latest.xpi
extensions/manifests/chromium-mv3.json
extensions/manifests/firefox-mv2.json
extensions/extension-provenance.json
```

The staged package and tarball are written under:

```text
npm/.release/npm/pentestkit/
npm/.release/npm/pentestkit-<version>.tgz
```

## Install Local Tarball

Install the staged package into the project that runs tests:

```bash
npm install -D /path/to/ptk-agent/npm/.release/npm/pentestkit-*.tgz
```

After installation, use the same imports as a registry install:

```js
import { withPtkScan } from "pentestkit/playwright";
const { setupPtkCypress } = require("pentestkit/cypress");
```

Do not import from this source directory in application tests.

## Package Checks

Run source/package preflight:

```bash
cd ptk-agent/npm
npm run preflight:release-frameworks -- --mode source
npm run preflight:release-frameworks -- --mode package
```

Run the package staging flow:

```bash
npm run test:npm
```

Focused package-script tests:

```bash
node --test agents/test/unit/package_scripts.test.cjs
```

The package checks verify:

- public docs/examples allowlist
- npm README link rewriting for npmjs
- extension artifact provenance
- staged package safety and secret scans
- no internal `scripts/`, framework `smoke/`, agent benchmarks, duplicate agent bins, or stale nested package metadata
- tarball contents and public import smoke

## Framework And Provider Validation

The source tree still contains lower-level framework/provider validation harnesses for release work. They are not part of the published package API and should not be referenced by public docs.

Source mode is for repository validation and can use repo-local automation artifacts. Package mode installs the staged tarball and resolves SDK/extension code from the installed package. Its `smoke/` runners remain external release fixtures because the published tarball intentionally excludes internal test runners.

```bash
cd ptk-agent/npm
npm run test:release-frameworks -- --mode source --framework playwright --browser chromium
npm run test:release-frameworks -- --mode package --baseline-only
```

At this level, `--framework all` runs Playwright, Selenium, and Cypress by default. Add `--include-optional` to include Puppeteer:

```bash
npm run test:release-frameworks -- --mode package --framework all --include-optional
```

The repository-level SDK gate wraps this runner:

```bash
../../../tasks/test-sdk.sh --mode package
../../../tasks/test-sdk.sh --mode package --skip-optional
```

## Extension Artifact Rules

The public source of truth is [../docs/npm/extension-loading.md](../docs/npm/extension-loading.md).

For release validation:

- npm ships the reviewed Chromium ZIP, Firefox ZIP, Chrome Web Store CRX, and
  AMO-signed XPI plus browser-specific manifest templates.
- npm users do not rebuild or sign release CRX/XPI files. Runtime extraction of
  the Chromium ZIP still goes under a cache such as `.ptk`.
- CRX private keys must stay outside Git and outside npm.
- `PTK_CRX_KEY` exists only for legacy/source fallback generation and is not
  used by a normal package install.
- provider upload cache files are runtime artifacts and must not be committed.

## Publish Notes

Before manual publish approval, confirm:

```bash
npm run test:npm
npm run preflight:release-frameworks -- --mode package
```

For a publishable build, also verify the source artifacts explicitly:

```bash
node scripts/verify-extension-artifacts.cjs \
  --input-dir ../dist \
  --version 9.9.8 \
  --provenance-sha256 <reviewed-sha256>
```

The package builder is deliberately registry-independent. It creates and smokes a public package shape but does not call `npm whoami` or infer npm ownership. Exact-version availability and OIDC identity are checked by `.github/workflows/npm-release.yml`; only `npm publish` receives the trusted-publishing identity.

The release sequence is:

1. Publish the verified automation extension files on the exact extension release tag.
2. Dispatch `npm-release.yml` for `9.9.8-rc.1` with the `next` dist-tag.
3. Install and validate that tarball with Chromium/Edge and Firefox.
4. Dispatch the same workflow for final `9.9.8` with the `latest` dist-tag only after the release gates pass.

Inspect the staged package when changing package surface:

```bash
find .release/npm/pentestkit -maxdepth 4 -type f | sort
tar -tf .release/npm/pentestkit-*.tgz | sort
```

The package root `README.md` is generated from `../docs/npm/README.md`, with relative npm docs links rewritten to public repository URLs for npmjs rendering.

## Artifacts

Do not commit generated profiles, `.ptk/`, `.ptk-agent/`, `.release/`, cache directories, traces, screenshots, scan artifacts, provider upload cache files, or CRX private keys.

## Related Source Docs

- [Extension loading matrix](extension-loading-matrix.md)
- [Agent CLI source docs](agents/README.md)
- [Browser helper source docs](browser/README.md)
- [Playwright source docs](frameworks/playwright/README.md)
- [Selenium source docs](frameworks/selenium/README.md)
- [Cypress source docs](frameworks/cypress/README.md)
- [Puppeteer source docs](frameworks/puppeteer/README.md)
- [Provider source docs](providers/README.md)
