from .chrome import ChromeLauncher
from .edge import EdgeLauncher
from .firefox import FirefoxLauncher
from .profiles import ProfileManager, ProfileLockedError, ProfileNotFoundError


def launch_chrome(profile_dir: str = None, headless: bool = False, profile_name: str = "Default", **kwargs):
    """Quick launch Chrome with sensible defaults."""
    return ChromeLauncher(
        profile_dir=profile_dir,
        headless=headless,
        profile_name=profile_name,
        **kwargs,
    ).launch()


def launch_edge(profile_dir: str = None, headless: bool = False, profile_name: str = "Default", **kwargs):
    """Quick launch Edge with sensible defaults."""
    return EdgeLauncher(
        profile_dir=profile_dir,
        headless=headless,
        profile_name=profile_name,
        **kwargs,
    ).launch()


def launch_firefox(
    profile_dir: str = None,
    headless: bool = False,
    install_mode: str = "temporary",
    extension_xpi_path: str = None,
    **kwargs,
):
    """Quick launch Firefox Developer Edition with sensible defaults."""
    return FirefoxLauncher(
        profile_dir=profile_dir,
        headless=headless,
        install_mode=install_mode,
        extension_xpi_path=extension_xpi_path,
        **kwargs,
    ).launch()


__all__ = [
    "ChromeLauncher",
    "EdgeLauncher",
    "FirefoxLauncher",
    "ProfileManager",
    "ProfileLockedError",
    "ProfileNotFoundError",
    "launch_chrome",
    "launch_edge",
    "launch_firefox",
]
