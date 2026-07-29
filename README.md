# OWASP PTK Agent

PTK Agent brings [OWASP Penetration Testing Kit](https://owasp.org/www-project-penetration-testing-kit/) security checks into browser automation, command-line scans, and CI/CD workflows.

The npm package is named [`pentestkit`](https://www.npmjs.com/package/pentestkit). It includes the `ptk-scan` and `ptk-agent` commands, framework integrations, cloud-browser provider helpers, and the PTK Auto browser runtime for Chromium-family browsers and Firefox.

## Install

```bash
npm install -D pentestkit
```

Install the Playwright browser used by the default scanner:

```bash
npx playwright install chromium
```

## First Scan

Only scan applications you own or are explicitly authorised to test.

```bash
npx ptk-scan https://your-authorised-target.example \
  --engine DAST,IAST,SAST,SCA \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete
```

PTK Agent starts a browser with PTK Auto, keeps navigation within the configured target scope, runs the selected engines, and writes the scan results to the configured output directory.

To verify extension setup without starting a scan:

```bash
npx ptk-agent --doctor-extension
```

## Integrations

Use PTK with an existing automation journey through:

- Playwright: `pentestkit/playwright`
- Puppeteer: `pentestkit/puppeteer`
- Selenium: `pentestkit/selenium`
- Cypress: `pentestkit/cypress`

Cloud-browser helpers are available for Browserbase, Browserless, BrowserStack, Hyperbrowser, Steel, and TestMu. Framework availability differs by provider; check the [provider support matrix](docs/npm/provider-browser-matrix.md) before choosing a combination.

## Documentation

- [npm package guide](docs/npm/README.md)
- [CLI reference](docs/npm/cli.md)
- [Configuration](docs/npm/configuration.md)
- [Authenticated scans](docs/npm/authenticated-scans.md)
- [Framework integrations](docs/npm/frameworks.md)
- [Cloud providers](docs/npm/providers.md)
- [Extension loading](docs/npm/extension-loading.md)
- [GitHub Actions](docs/npm/github-actions.md)
- [SARIF output](docs/npm/sarif.md)
- [MCP server](docs/npm/mcp-server.md)
- [Troubleshooting](docs/npm/troubleshooting.md)

## Security And Privacy

PTK scan results can contain URLs, request metadata, page content, screenshots, and—when explicitly enabled—authentication or replay data. Treat scan outputs as sensitive security evidence: restrict access, redact before sharing, and apply an appropriate CI retention policy.

Provider credentials should be supplied through environment variables or a CI secret manager. PTK configuration and examples use variable names rather than embedded credentials.

## Contributing

The Node.js implementation is under [`npm/`](npm/README.md). The Python implementation is under [`pypi/`](pypi/README.md). Run the checks documented in the relevant workspace before submitting a change.

Please report security vulnerabilities through the repository's private security-advisory channel rather than a public issue.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE.txt) (`AGPL-3.0-only`). Denis Podgurskii is the package author; PTK Labs is the repository owner and a project contributor.
