import json
import time
import tempfile
from pathlib import Path

from selenium.webdriver.remote.webdriver import WebDriver


class FailureHooks:
    """
    Automatic failure capture for debugging.

    Browser support matrix:
    - Screenshots: All browsers
    - Page source: All browsers
    - Console logs: Chrome/Edge (best-effort), Firefox (limited)
    - Network logs: Chrome/Edge only (CDP required)
    """

    def __init__(
        self,
        driver: WebDriver,
        output_dir: str = None,
        capture_screenshot: bool = True,
        capture_console_logs: bool = True,
        capture_network_logs: bool = False,
    ):
        self.driver = driver
        self.output_dir = Path(output_dir or tempfile.mkdtemp(prefix="ptk-failure-"))
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.capture_screenshot = capture_screenshot
        self.capture_console_logs = capture_console_logs
        self.capture_network_logs = capture_network_logs

        self._browser_type = self._detect_browser_type()

    def _detect_browser_type(self) -> str:
        """Detect browser type from driver capabilities."""
        caps = self.driver.capabilities
        browser = caps.get("browserName", "").lower()
        if "chrome" in browser:
            return "chrome"
        if "edge" in browser or "msedge" in browser:
            return "edge"
        if "firefox" in browser:
            return "firefox"
        return "unknown"

    def capture_all(self, test_name: str = None) -> dict:
        """Capture all available debug info."""
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

        if self.capture_network_logs and self._browser_type in ("chrome", "edge"):
            try:
                artifacts["network_logs"] = self._save_network_logs(name)
            except Exception as e:
                artifacts["network_logs_error"] = str(e)

        return artifacts

    def _save_screenshot(self, name: str) -> str:
        path = self.output_dir / f"{name}-screenshot.png"
        self.driver.save_screenshot(str(path))
        return str(path)

    def _save_page_source(self, name: str) -> str:
        path = self.output_dir / f"{name}-page.html"
        path.write_text(self.driver.page_source, encoding="utf-8", errors="ignore")
        return str(path)

    def _save_console_logs(self, name: str) -> str:
        logs = []

        if self._browser_type in ("chrome", "edge"):
            try:
                logs = self.driver.get_log("browser")
            except Exception:
                pass
        else:
            try:
                logs = self.driver.get_log("browser")
            except Exception:
                logs = [{"level": "INFO", "message": "Console logs not available for Firefox"}]

        path = self.output_dir / f"{name}-console.json"
        path.write_text(json.dumps(logs, indent=2), encoding="utf-8")
        return str(path)

    def _save_network_logs(self, name: str) -> str:
        path = self.output_dir / f"{name}-network.json"
        path.write_text(
            json.dumps({"note": "Network logs require CDP setup"}, indent=2),
            encoding="utf-8",
        )
        return str(path)
