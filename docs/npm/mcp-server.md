# MCP Server

`ptk-agent-mcp-server` lets an MCP client inspect PTK configuration, extension state, modules, and saved scan artifacts through the Model Context Protocol.

Normal users do not need this command for scans. Use:

```bash
npx ptk-scan https://target.example
```

Use the MCP server only when connecting PTK to an MCP-capable host.

## Quick Checks

These commands do not start a long-running server:

```bash
npx ptk-agent-mcp-server --help
npx ptk-agent-mcp-server --list-tools
npx ptk-agent-mcp-server --schema
```

`--list-tools` prints the safe default MCP tool registry.

## Stdio Server

Start a real MCP stdio server with:

```bash
npx ptk-agent-mcp-server --stdio
```

In stdio mode, stdout is reserved for MCP JSON-RPC messages. Logs and startup diagnostics go to stderr.

Recommended local MCP client configuration for a project where `pentestkit` is installed:

```json
{
  "mcpServers": {
    "pentestkit": {
      "command": "npx",
      "args": ["--no-install", "ptk-agent-mcp-server", "--stdio"],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

For a client that installs the package on demand:

```json
{
  "mcpServers": {
    "pentestkit": {
      "command": "npx",
      "args": ["-y", "-p", "pentestkit", "ptk-agent-mcp-server", "--stdio"],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

Set an explicit workspace when needed:

```bash
npx ptk-agent-mcp-server --stdio --workspace /absolute/path/to/project
```

All file paths passed to MCP tools must resolve inside the workspace.

## Default Tools

The default MCP server is read-only and redacted.

| Tool | Purpose |
| --- | --- |
| `ptk_doctor_extension` | Reports how the PTK browser extension resolves. |
| `ptk_validate_config` | Validates and resolves `ptk.config.json`. |
| `ptk_resolve_config` | Resolves config with a small safe override subset. |
| `ptk_resolve_modules` | Resolves module packs without exposing portal tokens. |
| `ptk_list_artifacts` | Lists recognized PTK artifact files. |
| `ptk_read_scan_summary` | Reads concise scan counts and lifecycle summary. |
| `ptk_read_findings_summary` | Reads redacted finding samples and counts. |
| `ptk_compare_artifacts` | Compares two saved PTK artifacts. |

The default server does not expose raw HTML, raw DOM snapshots, request bodies, response bodies, cookies, authorization headers, tokens, browser storage state, replayable exports, or raw debug state.

## Scan Execution

Scan execution is disabled by default. To expose `ptk_run_scan`, start the server with:

```bash
npx ptk-agent-mcp-server --stdio --allow-scan --workspace /absolute/path/to/project
```

`ptk_run_scan` is bounded:

- config, scenario, profile, route-hints, and output paths must stay inside the workspace
- route budgets are capped
- replayable export is not available
- destructive/browser-action tools are not enabled by `--allow-scan`
- tool results return concise summaries plus artifact paths

Use normal CLI scans in CI unless an MCP host specifically needs to trigger scans:

```bash
npx ptk-scan --config ptk.config.json
```

## Browser Actions

Browser action tools are not exposed by default. The reserved browser-action surface requires:

```bash
npx ptk-agent-mcp-server --stdio --allow-browser-actions
```

This is intentionally separate from `--allow-scan`. Do not enable it for general read-only artifact inspection.

## Unsafe Tools

Unsafe/debug tools are hidden unless explicitly requested:

```bash
npx ptk-agent-mcp-server --stdio --include-unsafe
```

Do not expose unsafe tools to general-purpose model clients.

