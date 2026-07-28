# ptk-core Source

This directory contains the internal source for the `ptk-core` implementation package. Public package documentation is maintained in `ptk-agent/docs/pypi/core.md` for the `pentestkit.core` import surface.

## Source Setup

```bash
cd ptk-agent/pypi/core
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
cd ptk-agent/pypi
python scripts/smoke_packages.py
```
