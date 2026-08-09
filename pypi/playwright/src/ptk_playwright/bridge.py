"""
PTK Automation Bridge helpers for Playwright.

Bridge Contract (versioned):
- window.PTK_AUTOMATION.version: string
- window.PTK_AUTOMATION.ping(): { ok, version, capabilities, automationEnabled, bridgeId }
- window.PTK_AUTOMATION.startSession(options): { sessionId, status, ... }
- window.PTK_AUTOMATION.endSession(options?): { status, stats, ... }
- window.PTK_AUTOMATION.getStats(): { findingsCount, bySeverity }
- window.PTK_AUTOMATION.getFindings(limit): { findings, truncated }
- window.PTK_AUTOMATION.exportScan(options): { ok, scans, truncatedAny, warnings }
"""

import time

from playwright.sync_api import Page

from .exceptions import PTKBridgeError, PTKAutomationDisabledError, PTKNotReadyError

REQUIRED_CAPABILITIES = ["startSession", "endSession", "getStats", "getFindings"]
OPTIONAL_CAPABILITIES = ["exportScan", "getSessionProgress"]


def request_bridge_activation(page: Page, reason: str = "sdk_agent_start", timeout: int = 5) -> dict:
    """
    Ask a disabled PTK automation bridge to activate for the current tab.

    The extension still owns the authorization decision. This only exercises the
    explicit current-tab activation path exposed by content_manual.js, which is
    required after manual-tab scoping was tightened to avoid enabling arbitrary
    tabs during another scan.
    """
    try:
        result = page.evaluate(
            """
            async ({ reason, timeoutMs }) => {
                const bridge = window.PTK_AUTOMATION;
                if (!bridge) {
                    return { ok: false, allowed: false, error: 'bridge_not_found' };
                }
                if (bridge._automationEnabled !== false) {
                    return { ok: true, allowed: true, reason: 'already_enabled' };
                }
                if (typeof bridge.requestActivation !== 'function') {
                    return { ok: false, allowed: false, error: 'activation_not_supported' };
                }

                const activation = bridge.requestActivation({ reason });
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), timeoutMs)
                );
                try {
                    return await Promise.race([activation, timeoutPromise]);
                } catch (e) {
                    if (e && e.message === 'timeout') {
                        return { ok: false, allowed: false, error: 'activation_timeout' };
                    }
                    return {
                        ok: false,
                        allowed: false,
                        error: e?.message || String(e) || 'activation_failed'
                    };
                }
            }
            """,
            {
                "reason": reason,
                "timeoutMs": int(timeout * 1000),
            },
        )
        return result if result else {"ok": False, "allowed": False, "error": "null_response"}
    except Exception as e:
        return {"ok": False, "allowed": False, "error": "activation_failed", "message": str(e)}


def check_bridge_ready(page: Page, timeout: int = 10) -> dict:
    """
    Check if PTK automation bridge is available and compatible.

    Args:
        page: Playwright Page instance
        timeout: Timeout in seconds (best-effort for ping)

    Returns:
        dict with bridge info: { ok, version, capabilities, automationEnabled, ... }
    """
    # First, check if bridge exists (simple sync check)
    try:
        exists = page.evaluate("() => !!window.PTK_AUTOMATION")
        if not exists:
            return {"ok": False, "error": "bridge_not_found"}
    except Exception as e:
        return {"ok": False, "error": "evaluate_failed", "message": str(e)}

    # Bridge exists, try to ping it
    try:
        # Playwright's evaluate() doesn't support timeout, so enforce it in JS.
        result = page.evaluate(
            """
            async (timeoutMs) => {
                const bridge = window.PTK_AUTOMATION;
                if (!bridge) {
                    return { ok: false, error: 'bridge_not_found' };
                }

                const ping = async () => {
                    if (typeof bridge.ping === 'function') {
                        return await bridge.ping();
                    }
                    // Fallback: build response manually
                    const capabilities = [];
                    ['startSession', 'endSession', 'getStats', 'getFindings', 'exportScan', 'getSessionProgress'].forEach(m => {
                        if (typeof bridge[m] === 'function') capabilities.push(m);
                    });
                    return {
                        ok: capabilities.length >= 4,
                        version: bridge.version || 'unknown',
                        capabilities: capabilities,
                        automationEnabled: true
                    };
                };

                if (!timeoutMs || timeoutMs <= 0) {
                    return await ping();
                }

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), timeoutMs)
                );

                try {
                    return await Promise.race([ping(), timeoutPromise]);
                } catch (e) {
                    if (e && e.message === 'timeout') {
                        return { ok: false, error: 'timeout' };
                    }
                    return { ok: false, error: 'ping_failed', message: e.message || String(e) };
                }
            }
            """,
            int(timeout * 1000),
        )
        return result if result else {"ok": False, "error": "null_response"}
    except Exception as e:
        return {"ok": False, "error": "ping_failed", "message": str(e)}


def validate_capabilities(bridge_info: dict, require_export: bool = False) -> None:
    """
    Validate bridge has required capabilities.

    Args:
        bridge_info: Result from check_bridge_ready()
        require_export: If True, require exportScan capability

    Raises:
        PTKAutomationDisabledError: If automation is disabled
        PTKBridgeError: If required capabilities are missing
    """
    if bridge_info.get("automationEnabled") is False:
        raise PTKAutomationDisabledError(
            "PTK automation is disabled. Enable in Settings -> Automation."
        )

    capabilities = bridge_info.get("capabilities", [])
    missing = set(REQUIRED_CAPABILITIES) - set(capabilities)

    if missing:
        raise PTKBridgeError(
            f"PTK bridge missing capabilities: {missing}. "
            f"Available: {capabilities}. "
            "Update PTK extension or check automation is enabled."
        )

    if require_export and "exportScan" not in capabilities:
        raise PTKBridgeError(
            "exportScan capability not available. "
            "Update PTK extension to use export_scan_payload()."
        )


def wait_bridge_ready(
    page: Page,
    timeout: int = 30,
    poll_interval: float = 0.5,
) -> dict:
    """
    Wait until PTK automation bridge is available and validated.

    Args:
        page: Playwright Page instance
        timeout: Maximum time to wait in seconds
        poll_interval: Time between checks in seconds

    Returns:
        dict with bridge info

    Raises:
        PTKNotReadyError: If bridge not available within timeout
        PTKAutomationDisabledError: If automation is disabled
        PTKBridgeError: If capabilities are missing
    """
    start_time = time.time()
    last_info = None
    last_activation = None
    last_activation_attempt_at = 0.0
    attempt = 0

    while time.time() - start_time < timeout:
        attempt += 1
        info = check_bridge_ready(page, timeout=5)
        last_info = info

        # Debug output
        if attempt <= 3 or attempt % 10 == 0:
            print(f"[PTK Bridge] Attempt {attempt}: {info}")

        if info.get("ok"):
            # Validate capabilities
            validate_capabilities(info)
            return info

        error = info.get("error", "")

        if error == "automation_disabled" or info.get("automationEnabled") is False:
            now = time.time()
            if now - last_activation_attempt_at >= 2:
                last_activation_attempt_at = now
                last_activation = request_bridge_activation(page, reason="sdk_agent_start", timeout=5)
                if attempt <= 3 or attempt % 10 == 0:
                    print(f"[PTK Bridge] Activation attempt {attempt}: {last_activation}")
                if last_activation.get("allowed") is True:
                    time.sleep(min(poll_interval, 0.25))
                    continue

        if error in ("ping_failed", "ping_exception"):
            msg = info.get("message", "unknown error")
            raise PTKNotReadyError(
                f"PTK bridge ping failed: {msg}. "
                "The extension may be corrupted or incompatible."
            )

        time.sleep(poll_interval)

    # Timeout reached - include full error details
    error = last_info.get("error", "unknown") if last_info else "no_response"
    message = last_info.get("message", "") if last_info else ""
    error_detail = f"{error}: {message}" if message else error
    if error == "automation_disabled" or last_info.get("automationEnabled") is False:
        activation_detail = ""
        if last_activation:
            activation_error = last_activation.get("error") or last_activation.get("reason") or "unknown"
            activation_detail = f" Last activation result: {activation_error}."
        raise PTKAutomationDisabledError(
            "PTK automation is disabled after startup wait. "
            "Enable in Settings -> Automation."
            + activation_detail
        )

    raise PTKNotReadyError(
        f"PTK automation bridge not available after {timeout}s. "
        f"Error: {error_detail}. "
        "Ensure PTK extension is loaded and automation is enabled."
    )


def preflight(page: Page, timeout: int = 30) -> dict:
    """
    One-call check that PTK is ready for automation.

    Args:
        page: Playwright Page instance
        timeout: Timeout in seconds

    Returns:
        dict with {
            ready: bool,
            version: str,
            bridgeId: str,
            automationEnabled: bool,
            capabilities: list,
            error: str or None
        }
    """
    try:
        info = check_bridge_ready(page, timeout=timeout)

        if not info.get("ok"):
            error = info.get("error", "unknown_error")
            return {
                "ready": False,
                "version": info.get("version"),
                "bridgeId": info.get("bridgeId"),
                "automationEnabled": info.get("automationEnabled", False),
                "capabilities": info.get("capabilities", []),
                "error": error,
            }

        if info.get("automationEnabled") is False:
            return {
                "ready": False,
                "version": info.get("version"),
                "bridgeId": info.get("bridgeId"),
                "automationEnabled": False,
                "capabilities": info.get("capabilities", []),
                "error": "automation_disabled",
            }

        missing = set(REQUIRED_CAPABILITIES) - set(info.get("capabilities", []))
        if missing:
            return {
                "ready": False,
                "version": info.get("version"),
                "bridgeId": info.get("bridgeId"),
                "automationEnabled": True,
                "capabilities": info.get("capabilities", []),
                "error": f"missing_capabilities: {list(missing)}",
            }

        return {
            "ready": True,
            "version": info.get("version"),
            "bridgeId": info.get("bridgeId"),
            "automationEnabled": True,
            "capabilities": info.get("capabilities", []),
            "error": None,
        }

    except Exception as e:
        return {
            "ready": False,
            "version": None,
            "bridgeId": None,
            "automationEnabled": False,
            "capabilities": [],
            "error": str(e),
        }
