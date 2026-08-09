"""
PTK Session context manager for Playwright.

Provides a high-level context manager for PTK automation sessions,
mirroring the API of ptk_session from ptk-selenium.
"""

from contextlib import contextmanager
import time
from typing import Generator, Tuple

from playwright.sync_api import Page

from .config import PTKPlaywrightConfig
from .profiles import ProfileManager
from .driver import PTKPlaywrightDriver
from .hooks import PlaywrightFailureHooks
from .launcher import launch_persistent_context


@contextmanager
def ptk_session(
    config: PTKPlaywrightConfig = None,
    target_url: str = None,
    **kwargs,
) -> Generator[Tuple[Page, PTKPlaywrightDriver], None, None]:
    """
    Context manager for PTK Playwright sessions.

    Handles browser launch, profile locking, session lifecycle, and artifact
    capture on failure. Mirrors the API of ptk_session from ptk-selenium.

    Args:
        config: PTK Playwright configuration. If None, uses defaults or kwargs.
        target_url: Target application URL. If provided, auto-navigates and
                   starts session. If None, you must call page.goto() and
                   ptk.start_session() manually.
        **kwargs: Additional config options (merged with config).

    Yields:
        Tuple of (page, ptk):
            - page: Playwright Page instance for test interactions
            - ptk: PTKPlaywrightDriver for session management

    Example:
        with ptk_session(config, target_url="http://localhost:3000") as (page, ptk):
            # page is ready, session is started
            page.click("text=Login")
            page.fill("#email", "admin@example.com")
            # ... more interactions ...

        # Session auto-ends, browser closes, profile released

    Note:
        If target_url is provided:
        - Navigates to target_url without requiring a reload
        - Waits for PTK bridge to be ready
        - Starts session with config settings
        - Auto-ends session on context exit

        If target_url is None:
        - Browser is launched but no navigation
        - You must call page.goto() and ptk.start_session() manually
        - You must call ptk.end_session() manually if needed
    """
    config = config or PTKPlaywrightConfig(**kwargs)
    profiles = ProfileManager(config.profile_base_dir, sdk_name="ptk-playwright-sdk")

    profile_dir = None
    pw = None
    context = None
    page = None
    hooks = None
    locked = False
    session_started = False

    try:
        # Allocate or lock profile
        if config.profile_dir:
            profile_dir = config.profile_dir
            if config.lock_profile:
                profiles.lock(profile_dir)
                locked = True
        else:
            profile_dir = profiles.allocate(config.browser, config.worker_id)
            locked = True

        # Launch browser
        pw, context, page = launch_persistent_context(config, profile_dir)

        # Initialize driver
        ptk = PTKPlaywrightDriver(page, config.ready_timeout)

        # Set up failure hooks
        hooks = PlaywrightFailureHooks(
            page,
            context,
            output_dir=config.artifacts_dir,
            capture_screenshot=config.screenshot_on_failure,
            capture_console_logs=config.capture_console_logs,
            capture_page_errors=config.capture_page_errors,
            enable_tracing=config.enable_tracing,
            trace_mode=config.trace_mode,
        )

        # Start tracing if enabled
        if config.enable_tracing and config.trace_mode != "off":
            hooks.start_tracing()

        # Auto-setup if target_url provided
        if target_url:
            page.goto(target_url, wait_until="domcontentloaded")
            ptk.wait_ready(config.ready_timeout)
            ptk.start_session(
                project=config.project,
                engines=config.engines,
                policy_code=config.policy_code,
            )
            session_started = True

        yield page, ptk

        # Clean exit - stop tracing without saving (success case)
        if hooks and config.trace_mode == "on-failure":
            hooks.stop_tracing(save=False)
        elif hooks and config.trace_mode == "always":
            artifacts = hooks.capture_all(f"success-{int(time.time())}")
            print(f"Session artifacts saved: {artifacts}")

    except Exception:
        # Failure - capture artifacts
        if hooks:
            try:
                artifacts = hooks.capture_all(f"failure-{int(time.time())}")
                print(f"Failure artifacts saved: {artifacts}")
            except Exception:
                pass
        raise

    finally:
        # End session if we started it
        if session_started and ptk and ptk.session_id:
            try:
                ptk.end_session(
                    wait=True,
                    max_wait=config.session_timeout,
                    immediate_analysis=config.immediate_analysis,
                )
            except Exception:
                pass

        # Close browser
        if context:
            try:
                context.close()
            except Exception:
                pass

        if pw:
            try:
                pw.stop()
            except Exception:
                pass

        # Release profile lock
        if locked and profile_dir:
            profiles.release(profile_dir)
