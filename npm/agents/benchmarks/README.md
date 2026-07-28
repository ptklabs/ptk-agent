# PTK Agents SDK Benchmarks

Benchmarks define target metadata and expected comparison metrics for the direct-vs-agent matrix.

Each benchmark records:

- target name
- target URL
- scenario file
- credentials policy
- deterministic route hints
- DAST, IAST, and SAST engine enablement
- required metrics
- comparison rule: agent value is measured as delta over direct baseline

The built-in matrix covers Juice Shop, TestFire, and BrokenCrystals. Run all benchmark rows with both explicit scenarios and no-scenario crawling:

```bash
node src/cli/index.cjs benchmark --agent-provider none --scenario-mode all
```

Scenario rows that require authentication use placeholder credentials by default. For CI/CD, provide credentials through environment variables and pass only variable names to the command:

```bash
export PTK_JUICE_USERNAME='...'
export PTK_JUICE_PASSWORD='...'
export PTK_TESTFIRE_USERNAME='...'
export PTK_TESTFIRE_PASSWORD='...'
export PTK_BROKENCRYSTALS_USERNAME='...'
export PTK_BROKENCRYSTALS_PASSWORD='...'

node src/cli/index.cjs benchmark \
  --agent-provider none \
  --scenario-mode all \
  --juice-username-env PTK_JUICE_USERNAME \
  --juice-password-env PTK_JUICE_PASSWORD \
  --testfire-username-env PTK_TESTFIRE_USERNAME \
  --testfire-password-env PTK_TESTFIRE_PASSWORD \
  --brokencrystals-username-env PTK_BROKENCRYSTALS_USERNAME \
  --brokencrystals-password-env PTK_BROKENCRYSTALS_PASSWORD
```

Benchmark runs force DAST, IAST, and SAST on for every target. With credentials configured, `--scenario-mode none` uses a minimal auth-only setup before crawl-only exploration, while `--scenario-mode explicit` runs the full benchmark scenario. BrokenCrystals also uses route hints for documented API, GraphQL, common-file, config, secret, file-read, and authenticated user-object surfaces.
