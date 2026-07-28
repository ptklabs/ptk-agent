from contextlib import contextmanager
from typing import Generator, Tuple
import time
import os

from selenium.webdriver.remote.webdriver import WebDriver

from .config import PTKConfig
from .browsers import ProfileManager, launch_chrome, launch_edge, launch_firefox
from .ptk.driver import PTKDriver
from .hooks import FailureHooks


def _launch_browser(config: PTKConfig, profile_dir: str) -> WebDriver:
    """Launch browser based on config."""
    if config.browser == "chrome":
        return launch_chrome(
            profile_dir=profile_dir,
            headless=config.headless,
            install_mode=config.install_mode,
            profile_name=config.profile_name,
            binary_location=config.chrome_binary,
            extension_path=config.extension_path,
        )
    if config.browser == "edge":
        return launch_edge(
            profile_dir=profile_dir,
            headless=config.headless,
            install_mode=config.install_mode,
            profile_name=config.profile_name,
            binary_location=config.edge_binary,
            extension_path=config.extension_path,
        )
    if config.browser == "firefox":
        return launch_firefox(
            profile_dir=profile_dir,
            headless=config.headless,
            install_mode=config.install_mode,
            extension_xpi_path=config.extension_xpi_path,
            binary_location=config.firefox_binary,
        )
    raise ValueError(f"Unknown browser: {config.browser}")


@contextmanager
def ptk_session(
    config: PTKConfig = None,
    target_url: str = None,
    **kwargs,
) -> Generator[Tuple[WebDriver, PTKDriver], None, None]:
    """
    Context manager for PTK test sessions.

    NOTE: If target_url is provided, scoped IAST hooks are armed before the
          first application navigation and the session then auto-starts.
          If target_url is None, you must call driver.get() and
          ptk.start_session() manually.
    """
    config = config or PTKConfig(**kwargs)
    profiles = ProfileManager(config.profile_base_dir)
    profile_dir = None
    driver = None
    hooks = None
    locked = False

    try:
        if config.profile_dir:
            profile_dir = config.profile_dir
            if config.lock_profile:
                profiles.lock(profile_dir)
                locked = True
        else:
            profile_dir = profiles.allocate(config.browser, config.worker_id)
            locked = True

        driver = _launch_browser(config, profile_dir)
        extension_origin = None
        if config.browser == "firefox":
            extension_uuid = os.environ.get(
                "PTK_FIREFOX_EXTENSION_UUID",
                "7b4b556d-55d0-4db7-bf08-7c1ec1a0f5c5",
            )
            extension_origin = f"moz-extension://{extension_uuid}"
        ptk = PTKDriver(driver, config.ready_timeout, extension_origin=extension_origin)
        hooks = FailureHooks(
            driver,
            output_dir=config.artifacts_dir,
            capture_screenshot=config.screenshot_on_failure,
            capture_console_logs=config.capture_console_logs,
        )

        if target_url:
            arm_result = ptk.arm_iast_for_navigation(
                target_url,
                engines=config.engines,
                policy_code=config.policy_code,
                timeout=config.ready_timeout,
            )
            if "IAST" in [str(value).upper() for value in config.engines] and not arm_result.get("ok"):
                raise RuntimeError(
                    f"PTK IAST pre-navigation arm failed: {arm_result.get('error', 'unknown_error')}"
                )
            driver.get(target_url)
            ptk.wait_ready(config.ready_timeout)
            ptk.start_session(
                project=config.project,
                engines=config.engines,
                policy_code=config.policy_code,
            )

        yield driver, ptk

    except Exception:
        if hooks:
            try:
                artifacts = hooks.capture_all(f"failure-{int(time.time())}")
                print(f"Failure artifacts saved: {artifacts}")
            except Exception:
                pass
        raise

    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        if locked and profile_dir:
            profiles.release(profile_dir)
