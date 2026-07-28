# pentestkit.core

`pentestkit.core` contains shared Python lifecycle helpers for PTK automation SDKs. Most users import framework helpers from `pentestkit.playwright` or `pentestkit.selenium`; this module provides the reusable bridge, lifecycle, result, redaction, and exception layers.

It is distributed as part of `pentestkit` under [GNU AGPL v3.0](https://github.com/ptklabs/ptk-agent/blob/main/LICENSE.txt) (`AGPL-3.0-only`).

## Install

```bash
pip install pentestkit
```

## What It Provides

- bridge calls to `window.PTK_AUTOMATION`
- PTK session start and stop helpers
- finding, stats, progress, and export collection helpers
- stop-time analysis option handling
- result writing and redaction utilities
- shared exception classes

## Basic Import

```python
from pentestkit.core import PTKBridge, with_ptk_scan, collect_ptk_results
```

## Extension Boundary

`pentestkit.core` does not launch browsers. The `pentestkit` package bundles PTK extension artifacts through `pentestkit.extensions`; framework helpers handle browser/profile setup.
