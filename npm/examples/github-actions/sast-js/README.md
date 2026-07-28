# GitHub Actions JavaScript SAST SARIF

Copy `ptk-sast-js.yml` into `.github/workflows/`.

This workflow enables SAST in `ptk-scan` and uploads SARIF. PTK emits source-file SARIF locations only when the scan evidence contains real source locations; browser runtime findings use the documented runtime fallback location.

Adjust the target URL and engines for your app.
