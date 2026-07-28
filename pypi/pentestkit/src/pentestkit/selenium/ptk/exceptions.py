class PTKError(Exception):
    """Base exception for PTK SDK errors."""


class PTKNotReadyError(PTKError):
    """PTK automation bridge not available."""


class PTKAutomationDisabledError(PTKError):
    """Automation is disabled in PTK settings."""


class PTKBridgeError(PTKError):
    """Bridge version/capability mismatch."""


class PTKSessionError(PTKError):
    """Error starting or managing PTK session."""


class PTKTimeoutError(PTKError):
    """PTK operation timed out."""


class PTKExportError(PTKError):
    """
    Export-specific errors with stable codes.

    Known error codes:
        session_not_found: No session found
        session_not_completed: Session not completed
        invalid_engine: Invalid engine name
        no_exportable_results: No engines produced results
        export_too_large: Export exceeds size limit
        automation_disabled: Automation is disabled
    """

    CODES = {
        "session_not_found": "No session found. Call start_session() first or provide session_id.",
        "session_not_completed": "Session not completed. Call end_session() before export.",
        "invalid_engine": "Invalid engine. Use DAST, IAST, SAST, SCA, or ALL.",
        "no_exportable_results": "No engines produced exportable results.",
        "export_too_large": "Export exceeds size limit even after truncation.",
        "automation_disabled": "PTK automation is disabled in settings.",
    }

    def __init__(self, code: str, warnings: list = None):
        message = self.CODES.get(code, f"Export failed: {code}")
        super().__init__(message)
        self.code = code
        self.warnings = warnings or []
