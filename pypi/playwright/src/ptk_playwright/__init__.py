"""
PTK Playwright SDK - Stable CI automation with Playwright.

This SDK provides a Python interface for PTK automation using Playwright.

Example usage:
    from ptk_playwright import ptk_session, PTKPlaywrightConfig

    config = PTKPlaywrightConfig(
        extension_path="/path/to/ptk/extension",  # REQUIRED
        profile_dir="/path/to/profile",           # Optional
        headless=False,
    )

    with ptk_session(config, target_url="http://localhost:3000") as (page, ptk):
        # Run your test flow
        page.click("text=Login")
        page.fill("#email", "admin@example.com")
        page.fill("#password", "admin123")
        page.click("button[type=submit]")

        # Session auto-ends on exit
"""

from .config import PTKPlaywrightConfig
from .session import ptk_session
from .driver import PTKPlaywrightDriver
from .bridge import arm_iast_for_navigation, check_bridge_ready, validate_capabilities, preflight
from .wrapper import PlaywrightPageAdapter, create_ptk_bridge, wait_for_ptk, with_ptk_scan
from .exceptions import (
    PTKError,
    PTKNotReadyError,
    PTKAutomationDisabledError,
    PTKBridgeError,
    PTKSessionError,
    PTKTimeoutError,
    PTKExportError,
)
from .profiles import ProfileManager, ProfileLockedError, ProfileNotFoundError

__all__ = [
    # Main API
    "ptk_session",
    "PTKPlaywrightConfig",
    "PTKPlaywrightDriver",
    "with_ptk_scan",
    "create_ptk_bridge",
    "wait_for_ptk",
    "PlaywrightPageAdapter",
    # Bridge utilities
    "check_bridge_ready",
    "validate_capabilities",
    "preflight",
    "arm_iast_for_navigation",
    # Profile management
    "ProfileManager",
    "ProfileLockedError",
    "ProfileNotFoundError",
    # Exceptions
    "PTKError",
    "PTKNotReadyError",
    "PTKAutomationDisabledError",
    "PTKBridgeError",
    "PTKSessionError",
    "PTKTimeoutError",
    "PTKExportError",
]

__version__ = "0.1.0"
