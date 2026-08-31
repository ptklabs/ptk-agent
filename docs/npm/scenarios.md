# Scenario-Guided Scans

Scenarios tell PTK how to exercise important business flows. They are useful when a crawler should do more than open links: login, search, add to basket, submit feedback, navigate account pages, or follow a known workflow.

## Choose One Journey Model

PTK engines run alongside a browser journey. The journey can be driven by the
deterministic crawler, a scenario, a recorded macro, or an optional Agent/LLM
expansion phase. These inputs are not interchangeable:

| Inputs | Browser journey and stage order |
| --- | --- |
| No scenario, macro, or Agent | Deterministic crawler only. |
| `--scenario` | Scenario first, then deterministic crawler discovery. |
| `--agent-mode` | Deterministic crawler baseline, then Agent/LLM expansion. |
| `--scenario` plus `--agent-mode` | Scenario, crawler baseline, then Agent/LLM expansion. |
| `--macro-file` | Recorded macro only. No crawler, form discovery, scenario, or Agent/LLM phase follows it. |
| `--scenario` plus `--macro-file` | PTK reports that scenario/crawler are skipped, then runs the macro only. |
| `--macro-file` plus `--agent-mode` | PTK reports that Agent/LLM is skipped, then runs the macro only. |
| All three | PTK reports both skipped inputs, then runs the macro only. |

“Macro only” describes the browser journey, not the security engines. DAST,
IAST, SAST, and SCA can all remain active while the macro replays.

Use a macro when results must be attributable to one exact recorded journey.
Use a scenario when PTK should perform a known workflow and then continue
discovering the application. Add an Agent/LLM only when you intentionally want
an exploratory phase after a valid deterministic baseline.

Conflicts with macro mode are deliberately non-fatal. Notices are written to
stderr before browser launch so they remain visible in local terminals and CI
logs. PTK also writes `execution-plan.json`, containing requested inputs,
effective stages, enabled engines, and notice codes. The run then proceeds
normally; unrelated validation, browser, scan, macro, engine-drain, and policy
failures retain their normal non-zero behavior.

## Recorded Macro Scans

PTK Agent can use a recorded browser macro as the deterministic and exclusive browser journey while DAST, IAST, SAST, and SCA run. Supported imports are PTK Flow JSON, PTK/XML and Katalon Recorder XML, ZAP Zest, Selenium IDE `.side`, and Chrome Recorder JSON.

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST,SAST,SCA \
  --macro-file login.zst \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete
```

Format detection is automatic. Use `--macro-format zest` only when a file is ambiguous. If `--scenario` and/or an enabled `--agent-mode` is also present, PTK explains that those phases are skipped and continues with the macro-only journey.

When `--macro-file` is present, PTK Agent does not continue into crawler, form-discovery, or Agent/LLM actions. It starts the selected engines, replays the imported steps once, drains and exports engine results, and stops. This keeps the observed traffic and findings attributable to the recorded journey.

Imported values, including passwords and tokens, are replayed literally. Macro files can therefore contain credentials and must be stored and shared securely. PTK does not prompt for or rewrite literal values.

Explicit runtime references remain available when a macro author chooses them:

- `${PTK_SECRET:PASSWORD}` reads `PTK_MACRO_SECRET_PASSWORD`.
- `${ACCOUNT_ID}` reads `PTK_MACRO_VAR_ACCOUNT_ID`.

The environment variables must be present in the process that starts
`ptk-scan`. For example:

```bash
PTK_MACRO_SECRET_PASSWORD='runtime-value' \
  npx ptk-scan https://target.example \
    --engine DAST,IAST,SAST,SCA \
    --macro-file login.zst
```

For GitHub Actions:

```yaml
env:
  PTK_MACRO_SECRET_PASSWORD: ${{ secrets.TARGET_PASSWORD }}
```

The browser extension does not read operating-system environment variables;
the Node.js Agent resolves them and supplies the runtime values to PTK Auto.
`--password` and `--password-env` populate the active persona and do not
implicitly resolve a macro placeholder. If a required macro value is absent,
PTK reports the exact missing `PTK_MACRO_*` name and fails before launching the
browser.

Code generated from the full-extension Macro UI is a separate execution path.
Generated Playwright, Puppeteer, and Selenium code reads
`PTK_SECRET_<NAME>`/`PTK_VAR_<NAME>` from `process.env`; generated Cypress code
uses the same names through `Cypress.env(...)`. This distinction is retained
for backward compatibility with existing exported scripts and PTK Agent CI
configurations.

Literal and explicitly referenced runtime values are redacted from scenario results. The Agent starts PTK before replay, uses native bounded browser actions, suppresses the interactive replay confirmation because no extension recorder session is created, and rejects any macro navigation outside the exact `target.baseUrl` origin.

Scroll-dependent journeys are preserved. PTK distinguishes bringing a target
into view, scrolling a page or container to an absolute position, and applying
a relative scroll delta. For Zest input, `ZestClientElementScrollTo` is a
visibility helper while `ZestClientElementScroll` applies its exact relative
`x`/`y` movement to the located element. This allows lazy-loaded controls and
other scroll-triggered application behavior to execute before the following
macro step.

The standalone `ptk-scan` macro runner currently supports Chromium, Chrome,
and Edge. Firefox PTK Auto remains available through supported framework and
provider integrations; standalone CLI XPI loading is not yet supported.

Equivalent config:

```json
{
  "scenario": {
    "enabled": true,
    "file": "login.zst",
    "inputType": "macro",
    "format": "auto",
    "continueOnFailure": false
  }
}
```

## Markdown Scenarios

Users can write scenarios as plain markdown or text:

```markdown
Log in with the provided credentials.
Search for "apple".
Add one visible product to the basket.
Open the basket.
Do not checkout or pay.
```

Run:

```bash
npx ptk-scan https://target.example \
  --engine DAST,IAST,SAST,SCA \
  --scenario scenario.md \
  --username-env PTK_SCAN_USERNAME \
  --password-env PTK_SCAN_PASSWORD \
  --include-secrets \
  --require-ptk-bridge \
  --require-ptk-findings-export \
  --wait-for-ptk-complete \
  --ptk-drain-timeout-ms 120000 \
  --max-routes 120 \
  --output-dir .ptk/artifacts/scenario
```

Markdown and plain-text scenarios are compiled into bounded executable steps. Numbered lists, bullet lists, and one-instruction-per-line text are supported. If a step cannot be executed, the failure is printed in the concise CLI output and artifacted in `scenario-result.json`.

## JSON Scenarios

JSON scenarios are useful for benchmark-style deterministic gates and CI jobs:

```json
{
  "version": "ptk-scenario-v2",
  "steps": [
    {
      "id": "login",
      "type": "auth",
      "success": { "authState": "authenticated" }
    },
    {
      "id": "search",
      "type": "search",
      "value": "apple",
      "dependsOn": ["login"],
      "success": { "completed": true }
    }
  ]
}
```

Run:

```bash
npx ptk-scan https://target.example --scenario scenario.json
```

Normal users do not need to write JSON. Markdown is the recommended authoring format.

## Safety Rules

Scenario guidance does not bypass core safety rules:

- same-origin scope is enforced
- off-origin links are blocked unless config explicitly permits them
- destructive actions are blocked by default
- credentials are redacted from artifacts
- provider/agent output is validated before browser execution
- route, action, and observation budgets still apply

Use `--aggressive` only when business mutations are acceptable on the target. Use `--allow-destructive-actions` only in disposable test environments.

## Continue On Failure

By default, scenario failure makes the scenario result invalid. To continue crawling after a failed scenario step:

```bash
npx ptk-scan https://target.example \
  --scenario scenario.md \
  --scenario-continue-on-failure
```

The scenario failure remains visible in `scenario-result.json`.

## Agent Assistance

Agent modes can help prioritize follow-up exploration after the deterministic baseline. They do not replace the crawler safety model.

```bash
npx ptk-scan https://target.example \
  --scenario scenario.md \
  --agent-mode provider \
  --agent-provider opencode \
  --agent-model opencode/big-pickle \
  --max-agent-turns 3
```

Use provider-backed agents only after the no-agent baseline is valid. Agent value should be measured as added route, endpoint, form, or finding coverage without losing baseline coverage.

With both `--scenario` and `--agent-mode`, PTK executes the scenario first,
continues with its deterministic crawler, validates that baseline, and only
then starts Agent/LLM expansion. If the required scenario baseline fails, the
Agent phase is skipped rather than being used to hide or repair the invalid
baseline.
