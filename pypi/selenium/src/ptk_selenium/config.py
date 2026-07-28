from dataclasses import dataclass, field
from typing import Optional, List
import os


def _env_optional_bool(name: str) -> Optional[bool]:
    value = os.environ.get(name)
    if value is None or value == "":
        return None
    return value.lower() in ("1", "true", "yes", "on")


@dataclass
class PTKConfig:
    """Central configuration for PTK Selenium SDK."""

    # Browser selection
    browser: str = "chrome"  # "chrome", "edge", "firefox"
    headless: bool = False

    # Profile management
    profile_base_dir: str = "~/.ptk-selenium/profiles"
    profile_dir: Optional[str] = None  # Explicit override
    worker_id: Optional[str] = None    # For parallel execution
    lock_profile: bool = True          # Acquire SDK lock even for explicit profile_dir

    # Chrome/Edge profile subdirectory (within user-data-dir)
    profile_name: Optional[str] = "Default"

    # Extension installation
    # "profile" = pre-installed in profile (Chrome/Edge required, Firefox optional)
    # "temporary" = install at runtime (Firefox only, unsigned OK)
    install_mode: str = "profile"
    # Path to unpacked extension directory for Chrome/Edge runtime loading.
    extension_path: Optional[str] = None
    # Path to .xpi file - REQUIRED for Firefox install_mode="temporary"
    extension_xpi_path: Optional[str] = None

    # Browser binaries (optional - for Chrome for Testing, custom installs)
    chrome_binary: Optional[str] = None
    edge_binary: Optional[str] = None
    firefox_binary: Optional[str] = None

    # PTK session
    project: Optional[str] = None
    engines: List[str] = field(default_factory=lambda: ["DAST"])
    policy_code: Optional[str] = None
    immediate_analysis: Optional[bool] = None

    # Timeouts
    ready_timeout: int = 30
    session_timeout: int = 180

    # Debug
    screenshot_on_failure: bool = True
    capture_console_logs: bool = True  # Best-effort
    artifacts_dir: Optional[str] = None  # Stable dir for CI; None = temp dir per failure

    @classmethod
    def from_env(cls) -> "PTKConfig":
        """
        Load config from environment variables (for CI).

        Supported:
            PTK_BROWSER, PTK_HEADLESS, PTK_WORKER_ID,
            PTK_PROFILE_BASE, PTK_PROFILE_DIR, PTK_PROFILE_NAME,
            PTK_LOCK_PROFILE,
            PTK_CHROME_BINARY, PTK_EDGE_BINARY, PTK_FIREFOX_BINARY,
            PTK_EXTENSION_PATH, PTK_EXTENSION_XPI_PATH,
            PTK_PROJECT, PTK_ENGINES (comma-separated),
            PTK_POLICY_CODE, PTK_IMMEDIATE_ANALYSIS, PTK_ARTIFACTS_DIR
        """
        engines_str = os.environ.get("PTK_ENGINES", "DAST")
        return cls(
            browser=os.environ.get("PTK_BROWSER", "chrome"),
            headless=os.environ.get("PTK_HEADLESS", "").lower() in ("1", "true"),
            worker_id=os.environ.get("PTK_WORKER_ID"),
            profile_base_dir=os.environ.get("PTK_PROFILE_BASE", "~/.ptk-selenium/profiles"),
            profile_dir=os.environ.get("PTK_PROFILE_DIR"),
            profile_name=os.environ.get("PTK_PROFILE_NAME", "Default"),
            lock_profile=os.environ.get("PTK_LOCK_PROFILE", "1").lower() in ("1", "true"),
            chrome_binary=os.environ.get("PTK_CHROME_BINARY"),
            edge_binary=os.environ.get("PTK_EDGE_BINARY"),
            firefox_binary=os.environ.get("PTK_FIREFOX_BINARY"),
            install_mode=os.environ.get(
                "PTK_INSTALL_MODE",
                os.environ.get("PTK_FIREFOX_INSTALL_MODE", "profile"),
            ),
            extension_path=os.environ.get("PTK_EXTENSION_PATH"),
            extension_xpi_path=os.environ.get("PTK_EXTENSION_XPI_PATH"),
            project=os.environ.get("PTK_PROJECT"),
            engines=[e.strip() for e in engines_str.split(",") if e.strip()],
            policy_code=os.environ.get("PTK_POLICY_CODE"),
            immediate_analysis=_env_optional_bool("PTK_IMMEDIATE_ANALYSIS"),
            artifacts_dir=os.environ.get("PTK_ARTIFACTS_DIR"),
        )
