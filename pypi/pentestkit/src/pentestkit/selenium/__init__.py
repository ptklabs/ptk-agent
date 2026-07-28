"""PTK Selenium SDK public API."""

from .config import PTKConfig
from .session import ptk_session
from .ptk.driver import PTKDriver
from .ptk.bridge import preflight, check_bridge_ready
from .wrapper import SeleniumDriverAdapter, create_ptk_bridge, wait_for_ptk, with_ptk_scan
from .ptk.exceptions import (
    PTKError,
    PTKNotReadyError,
    PTKAutomationDisabledError,
    PTKBridgeError,
    PTKSessionError,
    PTKTimeoutError,
    PTKExportError,
)
from .browsers import (
    ProfileManager,
    ProfileLockedError,
    ProfileNotFoundError,
    launch_chrome,
    launch_edge,
    launch_firefox,
)

__all__ = [
    "PTKConfig",
    "ptk_session",
    "PTKDriver",
    "with_ptk_scan",
    "create_ptk_bridge",
    "wait_for_ptk",
    "SeleniumDriverAdapter",
    "preflight",
    "check_bridge_ready",
    "PTKError",
    "PTKNotReadyError",
    "PTKAutomationDisabledError",
    "PTKBridgeError",
    "PTKSessionError",
    "PTKTimeoutError",
    "PTKExportError",
    "ProfileManager",
    "ProfileLockedError",
    "ProfileNotFoundError",
    "launch_chrome",
    "launch_edge",
    "launch_firefox",
]
