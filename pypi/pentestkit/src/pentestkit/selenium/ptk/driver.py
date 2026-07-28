import base64
import gzip
import json
import os
import time
import uuid
from urllib.parse import urlparse
from typing import Callable, Optional

from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException

from .bridge import check_bridge_ready, validate_capabilities
from .exceptions import (
    PTKNotReadyError,
    PTKAutomationDisabledError,
    PTKSessionError,
    PTKBridgeError,
    PTKExportError,
    PTKTimeoutError,
)


class PTKDriver:
    """
    High-level wrapper for PTK automation operations.

    Uses bridge-based automation exclusively (no UI clicking).
    """

    def __init__(self, driver: WebDriver, default_timeout: int = 30, extension_origin: str = None):
        self.driver = driver
        self.default_timeout = default_timeout
        self._session_id = None
        self._last_session_id = None
        self._tab_id = None
        self._extension_origin = extension_origin
        self._bridge_info = None

    def wait_ready(self, timeout: int = None) -> dict:
        """
        Wait until PTK automation bridge is available and validated.

        Raises:
            PTKNotReadyError: If bridge not available within timeout
            PTKAutomationDisabledError: If automation disabled
            PTKBridgeError: If capabilities missing
        """
        timeout = timeout or self.default_timeout
        wait = WebDriverWait(self.driver, timeout, poll_frequency=0.5)

        def check_ready(d):
            info = check_bridge_ready(d)
            if info.get("ok"):
                return info

            error = info.get("error", "")

            if error == "automation_disabled":
                raise PTKAutomationDisabledError(
                    "PTK automation is disabled. Enable in Settings -> Automation."
                )

            if error in ("ping_failed", "ping_exception"):
                msg = info.get("message", "unknown error")
                raise PTKNotReadyError(
                    f"PTK bridge ping failed: {msg}. "
                    "The extension may be corrupted or incompatible."
                )

            return False

        try:
            self._bridge_info = wait.until(check_ready)
            validate_capabilities(self._bridge_info)
            return self._bridge_info
        except (PTKAutomationDisabledError, PTKNotReadyError):
            raise
        except TimeoutException:
            raise PTKNotReadyError(
                f"PTK automation bridge not available after {timeout}s. "
                "Ensure PTK extension is installed and automation is enabled."
            )

    def is_ready(self) -> bool:
        """Check if PTK automation is available (non-blocking)."""
        try:
            info = check_bridge_ready(self.driver)
            return info.get("ok", False) and info.get("automationEnabled", True)
        except Exception:
            return False

    @property
    def bridge_version(self) -> str:
        """Bridge version from last handshake (informational only)."""
        return self._bridge_info.get("version") if self._bridge_info else None

    @property
    def session_id(self) -> str:
        """Current session ID or None."""
        return self._session_id

    def start_session(
        self,
        project: str = None,
        engines: list = None,
        policy_code: str = None,
        test_run_id: str = None,
        timeout: int = 60,
    ) -> dict:
        """Start a PTK scanning session."""
        if not self._bridge_info:
            self.wait_ready()

        result = self._execute_async(
            """
            const callback = arguments[arguments.length - 1];
            const options = arguments[0];

            window.PTK_AUTOMATION.startSession(options)
                .then(r => callback({ ok: true, ...r }))
                .catch(e => callback({ ok: false, error: e.message || String(e) }));
            """,
            {
                "project": project,
                "engines": engines or ["DAST"],
                "policyCode": policy_code,
                "testRunId": test_run_id,
            },
            timeout=timeout,
        )

        if not result.get("ok"):
            raise PTKSessionError(f"Session start failed: {result.get('error')}")
        if result.get("error"):
            raise PTKSessionError(f"Session start failed: {result.get('error')}")
        if result.get("status") == "error":
            raise PTKSessionError(f"Session start failed: {result.get('error')}")

        session_id = result.get("sessionId")
        if not session_id:
            status = str(result.get("status", "")).lower()
            if status == "started":
                # Some bridge builds report started without sessionId.
                # Keep flow running; most bridge operations are not keyed by sessionId.
                session_id = f"ptk-started-{int(time.time() * 1000)}"
                result["sessionId"] = session_id
            else:
                raise PTKSessionError(f"Session start returned no sessionId: {result}")

        self._session_id = session_id
        self._last_session_id = session_id
        if result.get("tabId") is not None:
            self._tab_id = result.get("tabId")
        return result

    def end_session(
        self,
        include_findings: bool = False,
        limit: int = 100,
        wait: bool = True,
        poll_interval: float = 2.0,
        max_wait: int = 600,  # 10 minutes
        stuck_threshold: int = 60,  # seconds without progress change
        on_progress: Optional[Callable[[dict], None]] = None,
        timeout: int = 30,  # Selenium script timeout for stop request
        immediate_analysis: Optional[bool] = None,
    ) -> dict:
        """
        End the PTK session.

        Args:
            include_findings: Include findings in response (only if wait=True and blocking)
            limit: Max findings to include
            wait: If True, wait for completion (default). If False, return immediately.
            poll_interval: Seconds between progress polls (when using stop+poll)
            max_wait: Maximum seconds to wait for completion
            stuck_threshold: Seconds without progress change before raising timeout
            on_progress: Optional callback(progress_dict) called on each poll
            timeout: Selenium script timeout (seconds) for non-blocking stop request
            immediate_analysis: If False, skip immediate post-stop analysis.
                Defaults to PTK's normal automation behavior.

        Returns:
            dict with summary

        Raises:
            PTKTimeoutError: If max_wait exceeded or stuck detected
        """
        stop_timeout = max(10, int(timeout or 10))
        capabilities = (self._bridge_info or {}).get("capabilities", [])
        supports_progress = "getSessionProgress" in capabilities

        def _normalize_stop_result(raw) -> dict:
            if raw is None:
                return {"ok": False, "error": "null_response"}

            if isinstance(raw, dict):
                result = dict(raw)
                if "ok" not in result:
                    # Backward compatibility: older bridges return summary payloads
                    # without an explicit "ok" field.
                    if result.get("error"):
                        result["ok"] = False
                    elif any(
                        key in result
                        for key in ("status", "summary", "stats", "findings", "truncated")
                    ):
                        result["ok"] = True
                    else:
                        result["ok"] = False
                        result["error"] = "empty_response"
                return result

            return {"ok": True, "data": raw}

        def _request_stop(
            request_timeout: int,
            blocking_wait: bool,
            include_findings_opt: bool,
        ) -> dict:
            stop_options = {
                "wait": blocking_wait,
                "includeFindings": include_findings_opt,
                "limit": min(limit, 500),
            }
            if immediate_analysis is not None:
                stop_options["immediateAnalysis"] = bool(immediate_analysis)
            raw = self._execute_async(
                """
                const callback = arguments[arguments.length - 1];
                const options = arguments[0];

                window.PTK_AUTOMATION.endSession(options)
                    .then(r => callback(r))
                    .catch(e => callback({ ok: false, error: e.message || String(e) }));
                """,
                stop_options,
                timeout=request_timeout,
            )
            return _normalize_stop_result(raw)

        # Legacy bridge fallback: no progress API, so use blocking endSession.
        if wait and not supports_progress:
            legacy_timeout = max(stop_timeout, int(max_wait))
            legacy_result = _request_stop(
                request_timeout=legacy_timeout,
                blocking_wait=True,
                include_findings_opt=include_findings,
            )

            if not legacy_result.get("ok"):
                error = legacy_result.get("error", "unknown")
                raise PTKSessionError(
                    f"Failed to stop session: {error} (payload={legacy_result})"
                )

            if legacy_result.get("status") == "error":
                error = legacy_result.get("error", "Session ended with error")
                raise PTKSessionError(error)

            self._session_id = None
            summary = legacy_result.get("summary")
            if not isinstance(summary, dict):
                summary = legacy_result
            return {"ok": True, "summary": summary}

        # Request stop (non-blocking, short timeout)
        stop_result = _request_stop(
            request_timeout=stop_timeout,
            blocking_wait=False,
            include_findings_opt=False,
        )

        # Chrome can occasionally miss the async callback on first attempt.
        # Retry once with a longer timeout before failing the session stop.
        if not stop_result.get("ok"):
            first_error = str(stop_result.get("error", "unknown"))
            if "script timeout" in first_error.lower():
                retry_timeout = max(stop_timeout, 30)
                stop_result = _request_stop(
                    request_timeout=retry_timeout,
                    blocking_wait=False,
                    include_findings_opt=False,
                )

        if not stop_result.get("ok"):
            error = stop_result.get("error", "unknown")
            raise PTKSessionError(
                f"Failed to stop session: {error} (payload={stop_result})"
            )

        if not wait:
            return stop_result

        if stop_result.get("status") == "completed":
            self._session_id = None
            summary = stop_result.get("summary")
            if not isinstance(summary, dict):
                summary = stop_result
            return {"ok": True, "summary": summary}

        if stop_result.get("status") == "error":
            self._session_id = None
            error = stop_result.get("error", "Session ended with error")
            raise PTKSessionError(error)

        # Poll for completion
        start_time = time.time()
        last_done = None
        last_done_time = start_time

        while True:
            elapsed = time.time() - start_time

            # Check max wait
            if elapsed > max_wait:
                self._session_id = None
                raise PTKTimeoutError(
                    f"Session did not complete within {max_wait}s"
                )

            # Get progress
            try:
                progress = self.get_session_progress(timeout=10)
            except Exception as e:
                # Transient error, continue polling
                if on_progress:
                    on_progress({"error": str(e)})
                time.sleep(poll_interval)
                continue

            if on_progress:
                on_progress(progress)

            status = progress.get("status")

            # Check completion
            if status == "completed":
                self._session_id = None
                return {
                    "ok": True,
                    "summary": progress.get("finalSummary") or progress.get("summary"),
                }

            if status == "error":
                self._session_id = None
                error = progress.get("error", "Session ended with error")
                raise PTKSessionError(error)

            # Stuck detection
            current_done = self._extract_done_count(progress)
            if current_done is not None:
                if current_done != last_done:
                    last_done = current_done
                    last_done_time = time.time()
                elif time.time() - last_done_time > stuck_threshold:
                    self._session_id = None
                    raise PTKTimeoutError(
                        f"Session appears stuck (no progress for {stuck_threshold}s)"
                    )

            time.sleep(poll_interval)

    def get_session_progress(
        self,
        session_id: str = None,
        timeout: int = 10,
    ) -> dict:
        """
        Get session progress (fast, non-blocking).

        Args:
            session_id: Optional session ID (defaults to current/last)
            timeout: Selenium script timeout in seconds

        Returns:
            dict with status, engines, summary, etc.
        """
        result = self._execute_async(
            """
            const callback = arguments[arguments.length - 1];
            const options = arguments[0];

            window.PTK_AUTOMATION.getSessionProgress(options)
                .then(r => callback(r))
                .catch(e => callback({ ok: false, error: e.message || String(e) }));
            """,
            {"sessionId": session_id},
            timeout=timeout,
        )

        if not result.get("ok"):
            error_code = result.get("error", "unknown")
            if error_code == "session_not_found":
                raise PTKSessionError("Session not found")
            # Return dict for other errors (allow caller to handle)

        return result

    def _extract_done_count(self, progress: dict) -> Optional[int]:
        """Extract total done count from progress for stuck detection."""
        engines = progress.get("engines", {})
        total = 0
        has_any = False
        for eng_progress in engines.values():
            done = eng_progress.get("progress", {}).get("done")
            if done is not None:
                total += done
                has_any = True
        return total if has_any else None

    def get_stats(self, timeout: int = 30) -> dict:
        """Get current session statistics."""
        if not self._session_id:
            return {"findingsCount": 0, "bySeverity": {}}

        result = self._execute_async(
            """
            const callback = arguments[arguments.length - 1];

            window.PTK_AUTOMATION.getStats()
                .then(r => callback({ ok: true, ...r }))
                .catch(e => callback({ ok: false, error: e.message || String(e) }));
            """,
            timeout=timeout,
        )

        if not result.get("ok"):
            return {"findingsCount": 0, "bySeverity": {}}

        return {
            "findingsCount": result.get("findingsCount", 0),
            "bySeverity": result.get("bySeverity", {}),
        }

    def get_findings(self, limit: int = 100, timeout: int = 30) -> dict:
        """Get session findings."""
        if not self._session_id:
            return {"findings": [], "truncated": False}

        result = self._execute_async(
            """
            const callback = arguments[arguments.length - 1];
            const limit = arguments[0];

            window.PTK_AUTOMATION.getFindings(limit)
                .then(r => callback({ ok: true, ...r }))
                .catch(e => callback({ ok: false, error: e.message || String(e) }));
            """,
            min(limit, 500),
            timeout=timeout,
        )

        if not result.get("ok"):
            return {"findings": [], "truncated": False}

        return {
            "findings": result.get("findings", []),
            "truncated": result.get("truncated", False),
        }

    def export_scan_payload(
        self,
        engine: str = "ALL",
        session_id: str = None,
        include_bodies: bool = True,
        include_evidence: bool = True,
        include_secrets: bool = False,
        export_mode: str = "evidence",
        sensitive: bool = False,
        output_path: str = None,
        max_export_bytes: int = 25 * 1024 * 1024,
        timeout: int = 60,
    ) -> dict:
        """
        Export scan payload (independent from end_session).

        Can be called after end_session(); requires completed session.
        Always returns scans as a list for consistency.
        """
        normalized_export_mode = str(export_mode or "evidence").lower()
        if include_secrets and normalized_export_mode != "replayable":
            raise PTKBridgeError("include_secrets_requires_replayable_export")
        if normalized_export_mode == "replayable" and not include_secrets:
            raise PTKBridgeError("replayable_export_requires_include_secrets")
        if normalized_export_mode == "replayable" and not sensitive:
            raise PTKBridgeError("replayable_export_requires_sensitive_true")
        if sensitive and normalized_export_mode != "replayable":
            raise PTKBridgeError("sensitive_export_requires_replayable_export")
        if normalized_export_mode == "replayable":
            return self._export_replayable_via_extension_page(
                engine=engine,
                session_id=session_id,
                output_path=output_path,
                timeout=timeout,
            )

        if self._bridge_info:
            caps = self._bridge_info.get("capabilities", [])
            if "exportScan" not in caps:
                raise PTKBridgeError(
                    "exportScan capability not available. "
                    "Update PTK extension to use this feature."
                )

        resolved_session_id = session_id or self._session_id or self._last_session_id

        result = self._execute_async(
            """
            const callback = arguments[arguments.length - 1];
            const options = arguments[0];

            window.PTK_AUTOMATION.exportScan(options)
                .then(r => callback(r))
                .catch(e => callback({ ok: false, error: e.message || String(e) }));
            """,
            {
                "engine": engine.upper(),
                "sessionId": resolved_session_id,
                "sessionScope": "current-tab",
                "includeBodies": include_bodies,
                "includeEvidence": include_evidence,
                "includeSecrets": False,
                "exportMode": "evidence",
                "maxExportBytes": max_export_bytes,
            },
            timeout=timeout,
        )

        if not result.get("ok"):
            error_code = result.get("error", "unknown")
            warnings = result.get("warnings", [])

            if error_code in PTKExportError.CODES:
                raise PTKExportError(error_code, warnings)

            return result

        return result

    def _validated_extension_origin(self) -> str:
        origin = self._extension_origin or (self._bridge_info or {}).get("extensionOrigin")
        if not origin:
            raise PTKBridgeError("replayable_export_requires_privileged_extension_export")
        parsed = urlparse(str(origin))
        if parsed.scheme not in ("chrome-extension", "moz-extension") or not parsed.netloc:
            raise PTKBridgeError("invalid_extension_origin")
        return f"{parsed.scheme}://{parsed.netloc}"

    def _execute_extension_async(self, method: str, request: dict, timeout: int = None) -> dict:
        timeout = timeout or self.default_timeout
        self.driver.set_script_timeout(timeout)
        try:
            result = self.driver.execute_async_script(
                """
                const callback = arguments[arguments.length - 1];
                const method = arguments[0];
                const request = arguments[1];
                const transport = window.PTK_REPLAYABLE_EXPORT_TRANSPORT;
                if (!transport || typeof transport[method] !== 'function') {
                    callback({ ok: false, error: 'privileged_export_transport_unavailable' });
                    return;
                }
                Promise.resolve(transport[method](request))
                    .then(r => callback(r || { ok: false, error: 'null_response' }))
                    .catch(e => callback({ ok: false, error: e && e.message ? e.message : String(e) }));
                """,
                method,
                request,
            )
            if result is None:
                return {"ok": False, "error": "null_response"}
            if isinstance(result, dict):
                return result
            return {"ok": True, "data": result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _write_sensitive_json(self, output_path: str, payload: dict) -> None:
        parent = os.path.dirname(os.path.abspath(output_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
                handle.write("\n")
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise

    def _export_replayable_via_extension_page(
        self,
        engine: str = "ALL",
        session_id: str = None,
        output_path: str = None,
        timeout: int = 60,
    ) -> dict:
        if not output_path:
            raise PTKBridgeError("replayable_export_requires_output_path")
        resolved_session_id = session_id or self._session_id or self._last_session_id
        if not resolved_session_id:
            raise PTKBridgeError("session_id_required")
        if self._tab_id is None:
            raise PTKBridgeError("original_scan_tab_required")

        origin = self._validated_extension_origin()
        export_url = f"{origin}/ptk/automation/export.html"
        self.driver.get(export_url)
        final_url = self.driver.current_url
        if not str(final_url).startswith(export_url):
            raise PTKBridgeError("invalid_extension_export_page")

        handshake = self.driver.execute_script(
            "return window.PTK_REPLAYABLE_EXPORT_TRANSPORT && window.PTK_REPLAYABLE_EXPORT_TRANSPORT.handshake ? window.PTK_REPLAYABLE_EXPORT_TRANSPORT.handshake() : null;"
        )
        if not isinstance(handshake, dict) or not handshake.get("ok"):
            raise PTKBridgeError("privileged_export_transport_unavailable")
        if handshake.get("extensionOrigin") != origin:
            raise PTKBridgeError("invalid_extension_origin")

        sdk_run_id = f"selenium-{uuid.uuid4()}"
        base_request = {
            "sessionId": resolved_session_id,
            "originalScanTabId": self._tab_id,
            "engine": str(engine or "ALL").upper(),
            "exportMode": "replayable",
            "includeSecrets": True,
            "sensitive": True,
            "transport": "extension-page",
            "sdk": "selenium",
            "sdkRunId": sdk_run_id,
        }
        export_request = {
            **base_request,
            "requestId": str(uuid.uuid4()),
            "nonce": str(uuid.uuid4()),
            "createdAt": int(time.time() * 1000),
        }
        export_result = self._execute_extension_async("export", export_request, timeout=timeout)
        if not export_result.get("ok"):
            raise PTKExportError(export_result.get("error", "no_exportable_results"), export_result.get("warnings", []))

        scans = []
        try:
            for descriptor in export_result.get("scans", []):
                chunks = []
                for index in range(int(descriptor.get("chunkCount", 0))):
                    chunk_result = self._execute_extension_async(
                        "chunk",
                        {
                            **base_request,
                            "requestId": str(uuid.uuid4()),
                            "leaseId": export_result.get("leaseId"),
                            "engine": descriptor.get("engine"),
                            "exportId": descriptor.get("exportId"),
                            "index": index,
                        },
                        timeout=timeout,
                    )
                    if not chunk_result.get("ok"):
                        raise PTKExportError(chunk_result.get("error", "chunk_read_failed"))
                    chunks.append(base64.b64decode(chunk_result.get("chunkBase64", "")))
                scan_payload = json.loads(gzip.decompress(b"".join(chunks)).decode("utf-8"))
                scans.append({
                    "engine": descriptor.get("engine"),
                    "scan": scan_payload,
                    "privacy": descriptor.get("privacy", {}),
                })
        finally:
            self._execute_extension_async(
                "release",
                {
                    **base_request,
                    "requestId": str(uuid.uuid4()),
                    "leaseId": export_result.get("leaseId"),
                    "engine": "ALL",
                },
                timeout=timeout,
            )

        payload = {
            "ok": True,
            "schemaVersion": "ptk-replayable-export-v1",
            "exportMode": "replayable",
            "sensitive": True,
            "sessionId": resolved_session_id,
            "originalScanTabId": self._tab_id,
            "sdkRunId": sdk_run_id,
            "privacy": {
                "exportMode": "replayable",
                "secretsIncluded": True,
                "replayableRequests": True,
                "sensitiveArtifact": True,
            },
            "scans": scans,
            "warnings": export_result.get("warnings", []),
        }
        self._write_sensitive_json(output_path, payload)
        return {
            "ok": True,
            "exportMode": "replayable",
            "sensitive": True,
            "secretsIncluded": True,
            "outputPath": output_path,
            "sessionId": resolved_session_id,
            "originalScanTabId": self._tab_id,
            "scanCount": len(scans),
            "warnings": export_result.get("warnings", []),
            "privacy": payload["privacy"],
        }

    @staticmethod
    def get_scan(export_result: dict, engine: str = None) -> dict:
        """Helper to extract a single scan from export result."""
        scans = export_result.get("scans", [])
        if not scans:
            return None

        if engine:
            engine_upper = engine.upper()
            for scan in scans:
                if scan.get("engine") == engine_upper:
                    return scan.get("scan")
            return None

        if len(scans) == 1:
            return scans[0].get("scan")

        return None

    def _execute_async(self, script: str, *args, timeout: int = None) -> dict:
        """Execute async JavaScript against PTK_AUTOMATION."""
        timeout = timeout or self.default_timeout
        self.driver.set_script_timeout(timeout)

        try:
            result = self.driver.execute_async_script(script, *args)

            if result is None:
                return {"ok": False, "error": "null_response"}
            if isinstance(result, dict):
                return result
            return {"ok": True, "data": result}

        except Exception as e:
            return {"ok": False, "error": str(e)}
