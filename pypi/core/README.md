# ptk-core Source

This directory implements the framework-neutral `pentestkit.core` API. Public usage is documented in [the core API guide](../../docs/pypi/core.md).

## Source Setup

```bash
pip install -e .
```

## Package Role

`ptk-core` provides shared lifecycle code used by `ptk-playwright` and `ptk-selenium`:

- bridge calls to `window.PTK_AUTOMATION`
- PTK session start/stop helpers
- findings, stats, progress, and export collection
- result writing and redaction utilities
- shared exception classes

Keep this package framework-neutral. Browser launching and profile management belong in the framework packages.

## Validation

Run the PyPI package smoke from the PyPI SDK root:

```bash
cd pypi
python scripts/smoke_packages.py
```
