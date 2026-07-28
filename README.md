# PTK Agent

`ptk-agent` is the PTK Labs package repository for [OWASP Penetration Testing Kit](https://owasp.org/www-project-penetration-testing-kit/) automation SDKs and command-line automation.

It owns npm and PyPI package source, framework wrappers, package documentation, examples, package smoke tests, and release staging for the agent packages.

## Repository Boundary

This repository does not own the PTK browser extension source or browser-extension release flow. It consumes prebuilt PTK automation-extension artifacts from repo-root `dist/` when building npm or PyPI packages.

Release automation downloads those artifacts from an exact `DenisPodgurskii/pentestkit` GitHub release tag. It requires the operator to supply the SHA-256 of `extension-provenance-automation.json`, then verifies that pin, every artifact hash and size, both browser manifests, and the `OWASP Penetration Testing Kit Automation` / `PTK Auto` identity before packaging anything. It never resolves a mutable `latest` release.

Expected extension artifacts:

```text
dist/
  chrome_<version>_automation.zip
  firefox_<version>_automation.zip
  ptk-latest-automation.crx
  ptk-latest-automation.xpi
  extension-provenance-automation.json
```

The npm tarball preserves four reviewed browser artifacts under stable names:

```text
extensions/ptk-latest.zip             # Chromium MV3 ZIP
extensions/ptk-latest-firefox.zip     # Firefox MV2 ZIP
extensions/ptk-latest.crx             # Chrome Web Store CRX
extensions/ptk-latest.xpi             # AMO-signed Firefox XPI
```

The ZIPs are the reviewed browser-specific upload/source archives. The CRX and
XPI are downloaded from their stores, not generated on the npm user's machine.
All four files are hash-pinned in extension provenance and must contain the
same version and browser-specific manifest as their corresponding release
artifact. None may contain `dev.local.json`.

Generated release packages, browser profiles, virtualenvs, caches, traces, and scan artifacts must stay out of source control.

## Source Layout

| Directory | Contents |
| --- | --- |
| `npm/` | npm workspace, Agent CLI, shared browser helpers, Playwright/Selenium/Cypress/Puppeteer wrappers, provider helpers, package scripts, and npm smoke tests. |
| `pypi/` | Python package sources for `pentestkit`, core helpers, Playwright helpers, Selenium helpers, and PyPI package smoke tests. |
| `docs/npm/` | Public npm package documentation staged into the npm package. |
| `docs/pypi/` | Public PyPI package documentation staged into Python packages. |

## Common Checks

Run npm package checks:

```bash
cd npm
npm run preflight:release-frameworks
npm run test:release-package
npm run test:release-frameworks -- --mode package
```

Run Python package smoke/import checks:

```bash
cd pypi
python3 scripts/smoke_packages.py
```

Build release packages from repo-root extension artifacts:

```bash
cd npm
npm run build:npm:release

cd ../pypi
python3 scripts/build_pypi_package.py --extension-input-dir ../dist
```

## npm Release Boundary

The `pentestkit` npm package is built from this repository. The protected [npm release workflow](.github/workflows/npm-release.yml) supports only:

- a prerelease such as `9.9.8-rc.1` under the `next` dist-tag
- a matching final version such as `9.9.8` under the `latest` dist-tag

The workflow uses npm trusted publishing and the `npm-release` GitHub environment. It does not use an npm token. Configure the npm trusted publisher for repository `ptklabs/ptk-agent` and workflow filename `npm-release.yml` before the first publish.

Repository CI and the release workflow audit source contents for generated archives, private keys, environment files, and recognizable credentials. The `dist/` input directory and all generated release outputs remain ignored.

## License

This repository and its npm and Python packages declare [GNU Affero General Public License v3.0](LICENSE.txt) (`AGPL-3.0-only`). Denis Podgurskii remains the package author; PTK Labs is listed as a contributor and repository owner.
