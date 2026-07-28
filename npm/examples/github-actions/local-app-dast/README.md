# GitHub Actions Local App DAST

Copy `ptk-security-scan.yml` into `.github/workflows/` in a Node app repository.

The workflow:

- installs the app dependencies
- starts the local app
- runs `ptk-scan` against `http://localhost:3000`
- writes `ptk-results.sarif`
- uploads SARIF to GitHub Code Scanning
- uploads `.ptk/artifacts` for scan debugging

Adjust the start command, target URL, engines, and `--fail-on` threshold for your repository.
