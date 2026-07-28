import warnings
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.edge.options import Options as EdgeOptions
from .base import BrowserLauncher


class EdgeLauncher(BrowserLauncher):
    """
    Edge launcher with PTK extension support.

    Same limitations as Chrome - use install_mode="profile" only.
    """

    def __init__(
        self,
        profile_dir: str = None,
        headless: bool = False,
        install_mode: str = "profile",
        profile_name: str = "Default",
        extra_args: list = None,
        prefs: dict = None,
        binary_location: str = None,
        extension_path: str = None,
    ):
        if install_mode not in ("profile",) and not extension_path:
            warnings.warn(
                f"install_mode='{install_mode}' is not reliably supported on "
                "branded Edge. Use install_mode='profile' with PTK pre-installed.",
                UserWarning,
            )

        super().__init__(
            profile_dir=profile_dir,
            headless=headless,
            install_mode=install_mode,
            extra_args=extra_args,
            prefs=prefs,
        )
        self.binary_location = binary_location
        self.profile_name = profile_name
        self.extension_path = extension_path

    def _extension_launch_args(self) -> list:
        if self.install_mode == "profile" or not self.extension_path:
            return []
        extension_dir = str(Path(self.extension_path).expanduser().resolve())
        return [
            "--enable-unsafe-extension-debugging",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            f"--disable-extensions-except={extension_dir}",
            f"--load-extension={extension_dir}",
        ]

    def build_options(self) -> EdgeOptions:
        """Build EdgeOptions (similar to Chrome)."""
        options = EdgeOptions()

        if self.binary_location:
            options.binary_location = self.binary_location

        if self.profile_dir:
            options.add_argument(f"--user-data-dir={self.profile_dir}")
            if self.profile_name:
                options.add_argument(f"--profile-directory={self.profile_name}")

        options.add_argument("--disable-infobars")
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")
        options.add_argument("--use-mock-keychain")
        options.add_argument("--password-store=basic")
        for arg in self._extension_launch_args():
            options.add_argument(arg)
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option(
            "prefs",
            {
                "credentials_enable_service": False,
                "profile.password_manager_enabled": False,
                **self.prefs,
            },
        )

        if self.headless:
            options.add_argument("--headless=new")

        for arg in self.extra_args:
            options.add_argument(arg)

        return options

    def launch(self) -> webdriver.Edge:
        """Launch Edge with configured options."""
        options = self.build_options()
        return webdriver.Edge(options=options)
