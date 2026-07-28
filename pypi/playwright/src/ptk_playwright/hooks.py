"""
Failure capture hooks for PTK Playwright SDK.

Automatically captures debugging artifacts on test failure:
- Screenshot (PNG)
- Page HTML snapshot
- Console logs (buffered from page.on("console"))
- Page errors (buffered from page.on("pageerror"))
- Playwright trace (if enabled)
"""

import json
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from playwright.sync_api import Page, BrowserContext, ConsoleMessage, Error


@dataclass
class ConsoleEntry:
    """Captured console message."""
    type: str
    text: str
    location: Optional[dict] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class PageError:
    """Captured page error."""
    message: str
    stack: Optional[str] = None
    timestamp: float = field(default_factory=time.time)


class PlaywrightFailureHooks:
    """
    Automatic failure capture for Playwright tests.

    Unlike Selenium's on-demand capture, Playwright requires attaching
    event listeners before navigation. This class buffers console logs
    and page errors throughout the session, then dumps them on failure.

    Usage:
        hooks = PlaywrightFailureHooks(page, context, config)
        hooks.start_tracing()  # If tracing enabled

        # ... run test ...

        # On failure:
        artifacts = hooks.capture_all("test-name")

        # On success (cleanup):
        hooks.stop_tracing(save=False)
    """

    def __init__(
        self,
        page: Page,
        context: BrowserContext,
        output_dir: str = None,
        capture_screenshot: bool = True,
        capture_console_logs: bool = True,
        capture_page_errors: bool = True,
        enable_tracing: bool = True,
        trace_mode: str = "on-failure",
    ):
        self.page = page
        self.context = context
        self.output_dir = Path(output_dir or tempfile.mkdtemp(prefix="ptk-failure-"))
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.capture_screenshot = capture_screenshot
        self.capture_console_logs = capture_console_logs
        self.capture_page_errors = capture_page_errors
        self.enable_tracing = enable_tracing
        self.trace_mode = trace_mode

        # Buffers for captured events
        self._console_logs: List[ConsoleEntry] = []
        self._page_errors: List[PageError] = []
        self._tracing_started = False

        # Attach listeners
        if capture_console_logs:
            page.on("console", self._on_console)

        if capture_page_errors:
            page.on("pageerror", self._on_page_error)

    def _on_console(self, msg: ConsoleMessage) -> None:
        """Handle console message event."""
        try:
            location = None
            if msg.location:
                location = {
                    "url": msg.location.get("url"),
                    "lineNumber": msg.location.get("lineNumber"),
                    "columnNumber": msg.location.get("columnNumber"),
                }

            self._console_logs.append(ConsoleEntry(
                type=msg.type,
                text=msg.text,
                location=location,
            ))
        except Exception:
            # Don't fail on logging errors
            pass

    def _on_page_error(self, error: Error) -> None:
        """Handle page error event."""
        try:
            self._page_errors.append(PageError(
                message=error.message if hasattr(error, 'message') else str(error),
                stack=error.stack if hasattr(error, 'stack') else None,
            ))
        except Exception:
            # Don't fail on logging errors
            pass

    def start_tracing(self) -> None:
        """
        Start Playwright tracing.

        Call this at session start if trace_mode != "off".
        Tracing captures screenshots, snapshots, and sources for debugging.
        """
        if not self.enable_tracing or self.trace_mode == "off":
            return

        if self._tracing_started:
            return

        try:
            self.context.tracing.start(
                screenshots=True,
                snapshots=True,
                sources=True,
            )
            self._tracing_started = True
        except Exception:
            # Tracing may fail in some configurations
            pass

    def stop_tracing(self, save: bool = False, name: str = None) -> Optional[str]:
        """
        Stop Playwright tracing.

        Args:
            save: If True, save trace to file. If False, discard.
            name: Name prefix for trace file.

        Returns:
            Path to trace file if saved, None otherwise.
        """
        if not self._tracing_started:
            return None

        try:
            if save:
                name = name or f"trace-{int(time.time())}"
                trace_path = self.output_dir / f"{name}-trace.zip"
                self.context.tracing.stop(path=str(trace_path))
                self._tracing_started = False
                return str(trace_path)
            else:
                # Stop without saving
                self.context.tracing.stop()
                self._tracing_started = False
                return None
        except Exception:
            self._tracing_started = False
            return None

    def capture_all(self, test_name: str = None) -> dict:
        """
        Capture all available debug artifacts.

        Args:
            test_name: Name prefix for artifact files.

        Returns:
            dict mapping artifact type to file path or error.
        """
        artifacts = {}
        name = test_name or f"failure-{int(time.time())}"

        if self.capture_screenshot:
            try:
                artifacts["screenshot"] = self._save_screenshot(name)
            except Exception as e:
                artifacts["screenshot_error"] = str(e)

        try:
            artifacts["page_source"] = self._save_page_source(name)
        except Exception as e:
            artifacts["page_source_error"] = str(e)

        if self.capture_console_logs:
            try:
                artifacts["console_logs"] = self._save_console_logs(name)
            except Exception as e:
                artifacts["console_logs_error"] = str(e)

        if self.capture_page_errors:
            try:
                artifacts["page_errors"] = self._save_page_errors(name)
            except Exception as e:
                artifacts["page_errors_error"] = str(e)

        # Save trace if we were tracing
        if self._tracing_started:
            try:
                trace_path = self.stop_tracing(save=True, name=name)
                if trace_path:
                    artifacts["trace"] = trace_path
            except Exception as e:
                artifacts["trace_error"] = str(e)

        return artifacts

    def _save_screenshot(self, name: str) -> str:
        """Save page screenshot."""
        path = self.output_dir / f"{name}-screenshot.png"
        self.page.screenshot(path=str(path), full_page=True)
        return str(path)

    def _save_page_source(self, name: str) -> str:
        """Save page HTML content."""
        path = self.output_dir / f"{name}-page.html"
        content = self.page.content()
        path.write_text(content, encoding="utf-8", errors="ignore")
        return str(path)

    def _save_console_logs(self, name: str) -> str:
        """Save buffered console logs."""
        path = self.output_dir / f"{name}-console.json"
        logs = [
            {
                "type": entry.type,
                "text": entry.text,
                "location": entry.location,
                "timestamp": entry.timestamp,
            }
            for entry in self._console_logs
        ]
        path.write_text(json.dumps(logs, indent=2), encoding="utf-8")
        return str(path)

    def _save_page_errors(self, name: str) -> str:
        """Save buffered page errors."""
        path = self.output_dir / f"{name}-errors.json"
        errors = [
            {
                "message": entry.message,
                "stack": entry.stack,
                "timestamp": entry.timestamp,
            }
            for entry in self._page_errors
        ]
        path.write_text(json.dumps(errors, indent=2), encoding="utf-8")
        return str(path)

    def get_console_logs(self) -> List[ConsoleEntry]:
        """Get buffered console logs."""
        return list(self._console_logs)

    def get_page_errors(self) -> List[PageError]:
        """Get buffered page errors."""
        return list(self._page_errors)

    def clear_buffers(self) -> None:
        """Clear console and error buffers."""
        self._console_logs.clear()
        self._page_errors.clear()
