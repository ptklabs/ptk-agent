# PTK Automation And Extension Loading

This is the Agent SDK local guide for PTK browser integration. The source-of-truth API contract is `../../../docs/automation.md`; update that file when `window.PTK_AGENT` or `window.PTK_AUTOMATION` behavior changes.

## Runtime Contract

PTK is the scanner. The Agent SDK drives the browser so PTK can observe traffic, client-side state, and workflow transitions.

Every scanner run needs:

1. A supported browser with the PTK extension loaded.
2. The dedicated PTK Auto extension, or the separate full extension with its Automation Mode setting enabled for the target tab.
3. SDK lifecycle control: start scan, execute scenario/crawl, stop scan, export findings.

Use `window.PTK_AGENT` as the primary workflow API:

- `describe`
- `preflight`
- `startScan`
- `scanStatus`
- `stopScan`
- `getFindings`
- `exportFullReport`

`stopScan({ immediateAnalysis: false })` is the public way to defer post-stop analysis in normal automation. The default is immediate analysis. Use `immediateAnalysis: true` only when a caller needs to override a config that deferred it.

Use `window.PTK_AUTOMATION` only for low-level compatibility and export chunk follow-up required by the automation contract.

Full navigation replaces the page JavaScript context. After navigation, wait for the bridge again before calling lifecycle, status, findings, or export methods.

## Lifecycle Rules

- Start PTK before authentication when credentials or scenario auth are configured.
- Normal automation stops compute analysis by default; pass `immediateAnalysis: false` to defer analysis until import/load/recompute in PTK.
- Treat missing PTK as invalid findings, not as zero findings.
- In benchmark mode, require PTK bridge/export unless `--allow-missing-ptk` is explicit.
- Write `ptk-lifecycle.json` for bridge, start, stop, export, validity, and reason.
- Write `ptk-findings-count.json` for comparable finding counts and redacted samples.
- Redact secrets by default in bridge artifacts, provider context, telemetry, and exports.

## Browser Support

This mirrors the repo-level SDK matrix in `../../extension-loading-matrix.md`.

| Browser | SDK support | Loading mode |
|---|---|---|
| Chromium | Supported current CLI baseline | SDK tests load the bundled package extension or `dist/ptk_extension_unpacked_automation`; the artifact provides the automation-enabled default. |
| Edge | Supported when an executable path or install can be resolved | Same Chromium-family extension model. |
| Chrome | Best-effort guidance | Some branded Chrome builds ignore unpacked extension flags. Use Chromium first if the PTK service worker is missing. |
| Firefox | Prepared-profile guidance only | Use a Firefox profile with the signed PTK Auto XPI installed. The separate full-extension XPI also requires its Automation Mode setting. |

A browser bridge token is not a PTK installer. It only lets an adapter connect to a browser/profile that already has PTK and any required bridge extension installed.

## Profiles

Use dedicated test profiles. Do not use a daily browser profile.

Rules:

- Use one profile per browser family.
- Close all browser windows using a profile before automated runs.
- Keep persistent profiles outside the repo, for example `~/profiles/ptk/chromium`.
- Prefer per-run profiles for deterministic unpacked-extension scans.
- PTK Auto profiles need no manual mode switch. If a prepared profile uses the separate full extension, enable that extension's Automation Mode once.

## Scenario And PTK Interaction

Scenario execution should improve PTK visibility, not hide scanner failures.

- Use explicit JSON scenario DAGs for benchmark gates.
- Start PTK before scenario auth.
- Feed scenario-discovered routes/endpoints into crawl coverage.
- Mark scenario failure separately from crawl completion.
- Matrix rows must show scenario status, failed step, PTK bridge status, finding validity, and finding count.

## Troubleshooting

`PTK automation bridge not available`

- Confirm the browser loaded PTK.
- Confirm PTK Auto is installed, or that Automation Mode is enabled when the profile uses the separate full extension.
- In Chromium/Edge unpacked mode, check that the PTK service worker exists.
- Retry the default Chromium path before treating this as a scanner bug.

`PTK bridge detected but findings are invalid`

- Check `ptk-lifecycle.json`.
- `bridgeDetected=false` means PTK never loaded or automation was disabled.
- `exportSucceeded=false` means full report export failed; inspect `reason`.
- `hasFindingsExport=false` means finding comparison must not be trusted.

`Profile is locked`

- Close every browser window using that profile.
- Use a fresh per-run profile or a separate dedicated profile.

`Firefox starts but PTK is missing`

- Confirm the XPI is installed at the expected profile path.
- Confirm the signed PTK Auto XPI is installed. For the separate full extension, also confirm Automation Mode is enabled.
- Do not expect Chromium-style `--load-extension` behavior in Firefox.
