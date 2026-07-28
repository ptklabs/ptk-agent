class PTKError(Exception):
    """Base exception for PTK SDK errors."""


class PTKBridgeError(PTKError):
    """PTK automation bridge returned an incompatible or failed response."""

    def __init__(self, message: str, code: str = "PTK_BRIDGE_ERROR", details=None):
        super().__init__(message)
        self.code = code
        self.details = details


class PTKAutomationDisabledError(PTKBridgeError):
    """PTK automation is disabled for the current tab."""

    def __init__(self, message: str, details=None):
        super().__init__(message, "PTK_AUTOMATION_DISABLED", details)


class PTKNotReadyError(PTKBridgeError):
    """PTK automation bridge was not ready before the timeout."""

    def __init__(self, message: str, details=None):
        super().__init__(message, "PTK_BRIDGE_NOT_READY", details)


class PTKSessionError(PTKError):
    """PTK scan session lifecycle failed."""


class PtkScanError(PTKError):
    """High-level scan wrapper failed."""

    def __init__(self, message: str, result=None, cause=None):
        super().__init__(message)
        self.result = result
        self.cause = cause
