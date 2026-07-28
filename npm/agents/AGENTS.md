# PTK Agents SDK

This directory contains the PTK Agents SDK implementation.

Do not copy previous control-plane, crawler, manager, or provider modules into this package without explicit review and simplification.

## Priorities

1. Fast deterministic crawling.
2. Predictable budgets.
3. Executable scenarios.
4. Evidence graphs.
5. Optional agent manager.
6. CI/CD package surface.

## Rules

- Use `../../docs/automation.md` as the PTK bridge/lifecycle contract before changing PTK scan start, status, stop, findings, export, or Automation Mode behavior. Update that doc when the bridge contract changes.
- Keep `docs/ptk-automation-and-extension-loading.md` aligned with `../README.md` and `../extension-loading-matrix.md` when SDK/browser support changes.
- Do not implement agents before the deterministic crawler is proven.
- Do not use `networkidle` by default.
- Do not add hidden 30-45 second waits.
- Do not add 45 second waits by default.
- Do not silently fallback between modes.
- Do not add hidden fallback.
- Do not use a keyword-soup scenario execution model.
- Do not model scenarios as keyword hints.
- Do not build a giant all-in-one crawl loop.
- Do not make provider prompts responsible for browser safety.
- Do not reduce direct baseline coverage in agent mode unless explicitly configured.

The SDK owns browser actions, selectors, validation, recovery, policy, telemetry, and evidence. Agents may choose missions later; they do not click directly.

Within the optional agent-manager phase, no mission mutation may execute before an explicit provider-selected mission. Mission success requires a validated transition, a policy block, or an intentional defer with evidence; a provider/tool call by itself is not success.

## PTK Automation Invariants

- Prefer `window.PTK_AGENT` for workflow calls: `describe`, `preflight`, `startScan`, `scanStatus`, `stopScan`, `getFindings`, and `exportFullReport`.
- Use `window.PTK_AUTOMATION` only for low-level compatibility and chunk follow-up where the PTK automation contract requires it.
- Full navigation replaces page context. After navigation, wait for bridge availability again before lifecycle or findings calls.
- Start PTK before authentication when possible so login, auth-boundary traffic, and login-form attack opportunities are observed.
- Benchmark scan mode must not treat missing PTK as zero findings. Missing bridge/export makes finding comparison invalid unless explicitly allowed.
- Secrets stay redacted by default. Runtime skills, provider context, telemetry, and artifacts must not expose credentials, cookies, tokens, auth headers, or sensitive request values unless an explicit include-secrets setting is used.

## Extension Loading Contract

- Supported current CLI baseline: Playwright Chromium with the bundled package extension or `dist/ptk_extension_unpacked_automation` loaded by the SDK.
- Preserve the root SDK guidance for Edge, Chrome, and Firefox, but do not document them as stable CLI paths until browser selection is implemented and tested.
- Best effort guidance: branded Chrome unpacked loading can fail because some builds ignore extension flags. Prefer Chromium when the PTK service worker is missing.
- Prepared-profile guidance: Firefox requires the signed PTK Auto XPI installed before it can be considered supported. A profile using the separate full extension also requires its Automation Mode setting.
- Browser bridge tokens are not PTK installers. They only connect to an already configured browser/profile.
- Use dedicated test profiles, not daily browser profiles. Do not share one profile across browser families.

## Runtime Skills

Development instructions under `.codex`, `.agents`, or `AGENTS.md` are for coding agents only. Runtime scan providers must receive package-owned skills explicitly loaded from `runtime-skills/`.

Runtime skill loading must be observable: record skill name, version/hash, and whether the skill text was included in provider artifacts. Runtime skills must never contain secrets.
