# PTK Automation Bridge

JavaScript API for running PTK security scans and retrieving results from page context.

PTK exposes two objects on the page when Automation Mode is enabled for the tab:

- [`window.PTK_AGENT`](#ptk_agent-workflow-api) is the workflow API for scan lifecycle, findings, and report export.
- [`window.PTK_AUTOMATION`](#ptk_automation-low-level-api) is the low-level API used by SDKs and for chunked export follow-up.

Both objects become available after the `ptk-automation-ready` event fires:

```javascript
window.addEventListener('ptk-automation-ready', () => {
  // window.PTK_AGENT and window.PTK_AUTOMATION are now available
})
```

Full navigation replaces the page context and destroys the bridge. After navigating to a new page, wait for the event again before using either object.

---

## PTK_AGENT Workflow API

`PTK_AGENT` methods return `{ ok: true, ... }` on success and `{ ok: false, code, message }` on failure.

### `PTK_AGENT.describe()`

Returns the workflow contract and capabilities. Does not check operational readiness.

```javascript
const info = PTK_AGENT.describe()
```

```json
{
  "ok": true,
  "api": "PTK_AGENT",
  "agentApiVersion": 1,
  "ptkVersion": "...",
  "bridgeId": "ptk-automation-bridge",
  "automationEnabled": true,
  "capabilities": [
    "describe", "preflight", "startScan", "scanStatus",
    "stopScan", "getFindings", "exportFullReport"
  ],
  "engines": ["DAST", "IAST", "SAST", "SCA"],
  "export": { "mode": "retrieval-plan" },
  "lowLevel": {
    "bridgeId": "ptk-automation-bridge",
    "capabilities": [
      "startSession", "endSession", "getStats", "getFindings",
      "exportScan", "getSessionProgress", "exportScanChunk",
      "releaseExportScan"
    ]
  }
}
```

### `PTK_AGENT.preflight()`

Checks whether the current page can run a scan now. Separate from `describe()`.

```javascript
const check = PTK_AGENT.preflight()
```

```json
{
  "ok": true,
  "ready": true,
  "automationEnabled": true,
  "blockers": []
}
```

When automation is disabled:

```json
{
  "ok": true,
  "ready": false,
  "automationEnabled": false,
  "blockers": ["automation_disabled"]
}
```

### `PTK_AGENT.startScan(options)`

Starts a scan on the current tab.

| Parameter | Type | Description |
|-----------|------|-------------|
| `project` | string | Project identifier |
| `engines` | string[] | Engines to activate, e.g. `['DAST']` |
| `policyCode` | string | Scan policy (optional) |
| `testRunId` | string | Test run ID for correlation (optional) |
| `runCve` | boolean | Include CVE-focused scanning (optional) |
| `engineConfigs` | object | Per-engine configuration (optional) |

```javascript
const result = await PTK_AGENT.startScan({
  project: 'my-project',
  engines: ['DAST']
})
```

```json
{
  "ok": true,
  "sessionId": "sess-1",
  "status": "running"
}
```

### `PTK_AGENT.scanStatus(options)`

Reads the current scan state.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Explicit session lookup (optional) |

```javascript
const status = await PTK_AGENT.scanStatus()
```

```json
{
  "ok": true,
  "sessionId": "sess-1",
  "status": "running",
  "startedAt": "2026-04-08T09:17:19.379Z",
  "finishedAt": null,
  "elapsedMs": 1234,
  "lastUpdatedAt": "2026-04-08T09:17:20.613Z",
  "stopRequestedAt": null,
  "engines": { "DAST": { "status": "running" } },
  "summary": { "findingsCount": 1 },
  "warnings": [],
  "finalSummary": { "status": "running" }
}
```

Engine statuses can include normalized lifecycle fields. SAST uses separate session, collection, and analysis state so SDKs can distinguish active code analysis from passive SPA waiting:

```json
{
  "engines": {
    "SAST": {
      "status": "running",
      "runtime": {
        "sessionState": "running",
        "collectionState": "waiting_for_page_activity",
        "analysisState": "complete",
        "isSessionRunning": true,
        "isAnalysisRunning": false,
        "currentGeneration": 3,
        "lastCompletedGeneration": 3
      }
    }
  }
}
```

When no session exists for this tab:

```json
{
  "ok": true,
  "sessionId": null,
  "status": "none",
  "engines": {},
  "summary": null,
  "warnings": []
}
```

### `PTK_AGENT.stopScan(options)`

Stops the scan. By default waits for completion before returning.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Explicit session lookup (optional) |
| `wait` | boolean | Wait for completion (default: `true`) |
| `stopTimeoutMs` | number | Engine stop/idle budget used by SDKs before status polling/export (optional; bounded by the bridge) |
| `immediateAnalysis` | boolean | Compute analysis immediately after stop. Normal automation defaults to `true`; pass `false` to defer analysis until import/load/recompute. |
| `includeFindings` | boolean | Include findings in response, requires `wait: true` (optional) |
| `limit` | number | Max findings to include (optional) |

Non-blocking stop:

```javascript
const result = await PTK_AGENT.stopScan({ wait: false })
```

```json
{
  "ok": true,
  "status": "stopping"
}
```

SDKs that need a bounded lifecycle can request a short engine stop budget, then poll `scanStatus()` until `completed` before calling `exportFullReport()`:

```javascript
await PTK_AGENT.stopScan({ wait: false, stopTimeoutMs: 2500 })
```

Deferred analysis stop:

```javascript
await PTK_AGENT.stopScan({ immediateAnalysis: false })
```

Blocking stop with findings:

```javascript
const result = await PTK_AGENT.stopScan({ includeFindings: true, limit: 10 })
```

```json
{
  "ok": true,
  "status": "completed",
  "stats": { "vulnsCount": 1, "bySeverity": { "high": 1 } },
  "findings": [{ "id": "finding-1" }],
  "truncated": false
}
```

### `PTK_AGENT.getFindings(options)`

Returns findings from the current tab's session.

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max findings to return (default: `100`, max: `500`) |
| `sessionId` | string | Explicit session lookup (optional) |

```javascript
const result = await PTK_AGENT.getFindings({ limit: 25 })
```

```json
{
  "ok": true,
  "findings": [{ "id": "finding-1" }],
  "truncated": false
}
```

### `PTK_AGENT.exportFullReport(options)`

Returns a retrieval plan describing the exported report chunks. Use `PTK_AUTOMATION.exportScanChunk` and `PTK_AUTOMATION.releaseExportScan` to fetch and release chunks.

| Parameter | Type | Description |
|-----------|------|-------------|
| `engine` | string | Engine to export, or `'ALL'` |
| `sessionId` | string | Explicit completed session lookup (optional) |
| `target` | string | Export target hint (optional) |
| `fileName` | string | Suggested file name (optional) |
| `transfer` | string | Must be `'retrieval-plan'` if set (optional) |
| `includeSecrets` | boolean | Not allowed on the page-facing API. `true` is rejected with `replayable_export_requires_privileged_extension_export`. |

Page-facing exports are redacted evidence exports only. They redact auth headers, cookies, request bodies, and token-like values before chunk handles are created. Replayable secret-bearing exports require an explicit privileged SDK transport and a local sensitive output path; target page JavaScript, `window.PTK_AGENT`, and `window.PTK_AUTOMATION` cannot request them.

```javascript
const plan = await PTK_AGENT.exportFullReport({ engine: 'DAST' })
```

```json
{
  "ok": true,
  "mode": "retrieval-plan",
  "scans": [{
    "engine": "DAST",
    "exportMode": "chunked",
    "exportId": "exp-1",
    "fileName": "PTK_DAST_scan.json.gz",
    "size": 7270,
    "chunkSize": 262144,
    "chunkCount": 1,
    "contentType": "application/gzip",
    "compression": "gzip",
    "expiresAt": 1775640179539
  }],
  "truncatedAny": false,
  "warnings": []
}
```

Product SDKs should export before stopping the PTK scan when strict report validity is required. Export after stop is supported for an explicit session id or the same tab's retained completed session, but failures return lookup diagnostics so callers can see whether the active-tab mapping, completed-tab mapping, explicit session, or retention state caused the miss.

`PTK_AGENT.getFindings()` is a diagnostic findings API. It is not the same thing as resolved report export/retrieval. Scanners that require a report export should treat `exportFullReport()` success as the validity source and should not use `getFindings()` alone as proof that report export succeeded.

Automation responses may include `sessionLookup` on success or failure:

```json
{
  "ok": false,
  "code": "session_not_found",
  "message": "No PTK session is available for this tab",
  "sessionLookup": {
    "requestedSessionId": "sess-1",
    "tabId": 123,
    "strictCurrentTab": true,
    "lookupSource": "none",
    "activeSessionIdForTab": null,
    "completedSessionIdForTab": null,
    "globalCompletedSessionId": null,
    "sessionExists": false,
    "sessionStatus": null,
    "sessionFinishedAt": null,
    "stopRequestedAt": null,
    "retention": {
      "ttlMs": 0,
      "maxCompletedSessions": 0,
      "evicted": false
    }
  }
}
```

### Scan Statuses

Workflow methods return statuses from this fixed set:

| Status | Meaning |
|--------|---------|
| `none` | No session exists for this tab |
| `starting` | Session is being created |
| `running` | Scan is active |
| `stopping` | Stop has been requested, waiting for engines |
| `completed` | Scan finished |
| `error` | Scan failed |
| `unknown` | PTK returned a status outside this set. The original value is in `rawStatus`. |

### Error Handling

All `PTK_AGENT` methods return `{ ok: false, code, message }` on failure.

| Code | Message |
|------|---------|
| `automation_disabled` | PTK Automation Mode is disabled for this tab |
| `automation_bridge_unavailable` | PTK automation bridge is unavailable in this page context |
| `session_not_found` | No PTK session is available for this tab |
| `session_already_running_in_tab` | A PTK scan is already active for this tab |
| `session_start_failed` | PTK scan could not be started |
| `session_status_failed` | PTK scan status could not be read |
| `session_stop_failed` | PTK scan could not be stopped |
| `get_findings_failed` | PTK findings could not be read |
| `export_failed` | PTK report export could not be prepared |
| `session_not_completed` | PTK scan must be completed before export |
| `no_exportable_results` | PTK could not prepare an export for this request |
| `unsupported_transfer_mode` | exportFullReport() only supports retrieval-plan mode |
| `no_tab_context` | PTK automation request requires a browser tab context |

Engine-specific or unexpected error codes are passed through with the code as the message.

---

## PTK_AUTOMATION Low-Level API

<!-- TODO: document the full PTK_AUTOMATION surface. Left undocumented for
     now because existing SDK consumers have their own bridge wrappers and
     READMEs, and no direct PTK_AUTOMATION callers exist outside those SDKs.
     Source-level JSDoc covers the full surface if a direct consumer appears. -->

The following `PTK_AUTOMATION` methods are used by `PTK_AGENT.exportFullReport` for chunked report retrieval. The full `PTK_AUTOMATION` reference is not yet documented here.

### `PTK_AUTOMATION.exportScanChunk(options)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `engine` | string | Engine that owns the export |
| `exportId` | string | Export handle from the retrieval plan |
| `index` | number | Zero-based chunk index |

```javascript
const chunk = await PTK_AUTOMATION.exportScanChunk({
  engine: 'DAST',
  exportId: 'exp-1',
  index: 0
})
```

```json
{
  "ok": true,
  "exportId": "exp-1",
  "index": 0,
  "chunkCount": 1,
  "encoding": "base64",
  "byteLength": 7270,
  "chunkBase64": "..."
}
```

### `PTK_AUTOMATION.releaseExportScan(options)`

Release the export handle after fetching chunks. Always release in both success and error paths.

| Parameter | Type | Description |
|-----------|------|-------------|
| `engine` | string | Engine that owns the export |
| `exportId` | string | Export handle from the retrieval plan |

```javascript
await PTK_AUTOMATION.releaseExportScan({
  engine: 'DAST',
  exportId: 'exp-1'
})
```

```json
{
  "ok": true
}
```
