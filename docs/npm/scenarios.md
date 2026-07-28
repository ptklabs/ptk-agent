# Scenario-Guided Scans

Scenarios tell PTK how to exercise important business flows. They are useful when a crawler should do more than open links: login, search, add to basket, submit feedback, navigate account pages, or follow a known workflow.

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
