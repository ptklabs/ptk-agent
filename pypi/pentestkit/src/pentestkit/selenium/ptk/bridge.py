"""
PTK Automation Bridge helpers.

Bridge Contract (versioned):
- window.PTK_AUTOMATION.version: string
- window.PTK_AUTOMATION.ping(): { ok, version, capabilities, automationEnabled, bridgeId }
- window.PTK_AUTOMATION.startSession(options): { sessionId, status, ... }
- window.PTK_AUTOMATION.endSession(options?): { status, stats, ... }
- window.PTK_AUTOMATION.getStats(): { findingsCount, bySeverity }
- window.PTK_AUTOMATION.getFindings(limit): { findings, truncated }
- window.PTK_AUTOMATION.exportScan(options): { ok, scans, truncatedAny, warnings }
"""

from .exceptions import PTKBridgeError, PTKAutomationDisabledError

REQUIRED_CAPABILITIES = ["startSession", "endSession", "getStats", "getFindings"]
OPTIONAL_CAPABILITIES = ["exportScan"]


def check_bridge_ready(driver, timeout: int = 10) -> dict:
    """
    Check if PTK automation bridge is available and compatible.

    Uses execute_async_script to handle both sync and async ping() implementations.
    """
    driver.set_script_timeout(timeout)

    script = """
    const callback = arguments[arguments.length - 1];

    if (!window.PTK_AUTOMATION) {
        callback({ ok: false, error: 'bridge_not_found' });
        return;
    }

    if (typeof window.PTK_AUTOMATION.ping === 'function') {
        try {
            Promise.resolve(window.PTK_AUTOMATION.ping())
                .then(result => callback(result))
                .catch(e => callback({ ok: false, error: 'ping_failed', message: e.message }));
            return;
        } catch (e) {
            callback({ ok: false, error: 'ping_exception', message: e.message });
            return;
        }
    }

    var capabilities = [];
    ['startSession', 'endSession', 'getStats', 'getFindings', 'exportScan'].forEach(function(m) {
        if (typeof window.PTK_AUTOMATION[m] === 'function') {
            capabilities.push(m);
        }
    });

    callback({
        ok: capabilities.length >= 4,
        version: window.PTK_AUTOMATION.version || 'unknown',
        capabilities: capabilities,
        automationEnabled: true
    });
    """
    return driver.execute_async_script(script)


def validate_capabilities(bridge_info: dict, require_export: bool = False) -> None:
    """Validate bridge has required capabilities."""
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


def preflight(driver, timeout: int = 30) -> dict:
    """
    One-call check that PTK is ready for automation.

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
        info = check_bridge_ready(driver, timeout=timeout)

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
