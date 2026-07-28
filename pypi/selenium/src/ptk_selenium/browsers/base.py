from abc import ABC, abstractmethod
from selenium.webdriver.remote.webdriver import WebDriver


class BrowserLauncher(ABC):
    """Abstract base for browser launchers."""

    def __init__(
        self,
        profile_dir: str = None,
        headless: bool = False,
        install_mode: str = "profile",
        extension_xpi_path: str = None,
        extra_args: list = None,
        prefs: dict = None,
    ):
        self.profile_dir = profile_dir
        self.headless = headless
        self.install_mode = install_mode
        self.extension_xpi_path = extension_xpi_path
        self.extra_args = extra_args or []
        self.prefs = prefs or {}

    @abstractmethod
    def build_options(self):
        """Build browser-specific options."""

    @abstractmethod
    def launch(self) -> WebDriver:
        """Launch browser and return WebDriver."""

    def _apply_stability_prefs(self, options):
        """Apply common stability preferences (disable telemetry, etc.)."""
        return options
