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

import json
import hashlib
import os
import time
from typing import Optional
from urllib.parse import urlparse

from playwright.sync_api import Page

from .exceptions import PTKBridgeError, PTKAutomationDisabledError, PTKNotReadyError

REQUIRED_CAPABILITIES = ["startSession", "endSession", "getStats", "getFindings"]
OPTIONAL_CAPABILITIES = ["exportScan", "getSessionProgress"]


def _extension_service_worker_path(extension_path: str = None) -> Optional[str]:
    path = extension_path or os.environ.get("PTK_EXTENSION_PATH") or os.environ.get("PTK_EXTENSION_DIR")
    if not path:
        return None
    try:
        with open(os.path.join(path, "manifest.json"), "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        service_worker = manifest.get("background", {}).get("service_worker")
        if not service_worker:
            return None
        return f"/{str(service_worker).lstrip('/')}"
    except (OSError, TypeError, ValueError):
        return None


def _context_service_workers(page: Page) -> list:
    context = getattr(page, "context", None)
    if context is None:
        return []
    workers = getattr(context, "service_workers", [])
    if callable(workers):
        try:
            workers = workers()
        except TypeError:
            workers = []
    return list(workers or [])


def _find_ptklabs_automation_worker(page: Page, extension_path: str = None):
    expected_path = _extension_service_worker_path(extension_path)
    for worker in _context_service_workers(page):
        worker_url = str(getattr(worker, "url", "") or "")
        parsed = urlparse(worker_url)
        if parsed.scheme != "chrome-extension":
            continue
        if expected_path and parsed.path != expected_path:
            continue
        try:
            available = worker.evaluate(
                """
                () => [
                    globalThis.PTK_EXTENSION_AUTOMATION,
                    globalThis.PTK_EXTENSION_FULL,
                    globalThis.PTK_EXTENSION_FULL_DEV,
                ].some(candidate => typeof candidate?.extension?.contentRuntime?.armPrimaryTab === 'function')
                """
            )
        except Exception:
            available = False
        if available:
            return worker
    return None


def _find_ptk_extension_worker(page: Page, extension_path: str = None):
    expected_path = _extension_service_worker_path(extension_path)
    for worker in _context_service_workers(page):
        worker_url = str(getattr(worker, "url", "") or "")
        parsed = urlparse(worker_url)
        if parsed.scheme != "chrome-extension":
            continue
        if expected_path and parsed.path != expected_path:
            continue
        if not expected_path and parsed.path not in ("/app.js", "/app_automation.js"):
            continue
        return worker
    return None


def _chromium_unpacked_extension_origin(extension_path: str = None) -> Optional[str]:
    """Derive Chrome's deterministic id for a locally loaded unpacked extension."""
    path = extension_path or os.environ.get("PTK_EXTENSION_PATH") or os.environ.get("PTK_EXTENSION_DIR")
    if not path or not os.path.isdir(path):
        return None
    normalized = os.path.realpath(os.path.abspath(path))
    digest = hashlib.sha256(normalized.encode("utf-8")).digest()[:16]
    extension_id = "".join(
        chr(ord("a") + nibble)
        for byte in digest
        for nibble in (byte >> 4, byte & 0x0F)
    )
    return f"chrome-extension://{extension_id}"


def arm_iast_for_navigation(
    page: Page,
    target_url: str,
    scan_options: dict = None,
    extension_path: str = None,
    timeout: int = 10,
    ttl_seconds: int = 60,
) -> dict:
    """Arm PTK IAST in the current tab before its first target navigation."""
    options = dict(scan_options or {})
    engines = [str(value).strip().upper() for value in options.get("engines", [])]
    if engines and "IAST" not in engines:
        return {"ok": True, "applicable": False, "reason": "iast_not_requested"}

    parsed_target = urlparse(str(target_url or ""))
    if parsed_target.scheme not in ("http", "https") or not parsed_target.netloc:
        return {"ok": False, "applicable": True, "error": "ptk_target_url_unsupported"}

    deadline = time.time() + max(1, int(timeout))
    worker = None
    while time.time() < deadline and worker is None:
        worker = _find_ptk_extension_worker(page, extension_path=extension_path)
        if worker is None:
            time.sleep(0.1)
    extension_origin = None
    used_unpacked_fallback = worker is None
    if worker is not None:
        worker_url = str(getattr(worker, "url", "") or "")
        worker_parsed = urlparse(worker_url)
        if worker_parsed.scheme != "chrome-extension" or not worker_parsed.netloc:
            return {"ok": False, "applicable": True, "error": "ptk_extension_origin_invalid"}
        extension_origin = f"{worker_parsed.scheme}://{worker_parsed.netloc}"
    else:
        # Chrome may suspend an otherwise healthy MV3 worker before the first
        # navigation. A local unpacked build still has a deterministic id, so
        # open its private control page to wake the worker instead of requiring
        # an application reload.
        extension_origin = _chromium_unpacked_extension_origin(extension_path)
    if not extension_origin:
        return {"ok": False, "applicable": False, "error": "ptk_extension_worker_not_found"}
    control_url = f"{extension_origin}/ptk/automation/control.html"

    try:
        navigation_timeout = max(1000, int(timeout) * 1000)
        if used_unpacked_fallback:
            # Chrome for Testing can register an unpacked extension lazily.
            # Initialize the manager before requesting its deterministic URL;
            # a failed direct request races Chrome's error-page navigation.
            page.goto("chrome://extensions/", wait_until="domcontentloaded", timeout=navigation_timeout)
            worker_deadline = time.time() + max(1, int(timeout))
            while time.time() < worker_deadline:
                worker = _find_ptk_extension_worker(page, extension_path=extension_path)
                if worker is not None:
                    worker_parsed = urlparse(str(getattr(worker, "url", "") or ""))
                    if worker_parsed.scheme == "chrome-extension" and worker_parsed.netloc:
                        extension_origin = f"{worker_parsed.scheme}://{worker_parsed.netloc}"
                        control_url = f"{extension_origin}/ptk/automation/control.html"
                        break
                time.sleep(0.1)
        page.goto(control_url, wait_until="domcontentloaded", timeout=navigation_timeout)
        result = page.evaluate(
            """
            async ({ targetUrl, scanOptions, ttlMs }) => {
                const control = globalThis.PTK_AUTOMATION_CONTROL;
                if (!control || typeof control.armIastForNavigation !== 'function') {
                    return { ok: false, error: 'ptk_automation_control_unavailable' };
                }
                return control.armIastForNavigation({ targetUrl, scanOptions, ttlMs });
            }
            """,
            {
                "targetUrl": str(target_url),
                "scanOptions": options,
                "ttlMs": max(1000, min(int(ttl_seconds * 1000), 60000)),
            },
        )
    except Exception as exc:
        return {
            "ok": False,
            "applicable": True,
            "error": "ptk_iast_pre_navigation_arm_failed",
            "message": str(exc),
        }
    if not isinstance(result, dict):
        return {"ok": False, "applicable": True, "error": "ptk_iast_pre_navigation_arm_invalid_response"}
    result.setdefault("applicable", True)
    result.setdefault("controlUrl", control_url)
    return result


def arm_ptklabs_automation_target(
    page: Page,
    extension_path: str = None,
    ttl_seconds: int = 60,
) -> dict:
    """Arm the exact current tab through the PTK Labs service-worker grant API."""
    worker = _find_ptklabs_automation_worker(page, extension_path=extension_path)
    if worker is None:
        return {"ok": False, "applicable": False, "error": "ptklabs_automation_worker_not_found"}

    target_url = str(getattr(page, "url", "") or "")
    try:
        parsed_target = urlparse(target_url)
    except ValueError:
        parsed_target = None
    if not parsed_target or parsed_target.scheme not in ("http", "https"):
        return {"ok": False, "applicable": True, "error": "ptk_target_url_unsupported"}

    target_origin = f"{parsed_target.scheme}://{parsed_target.netloc}"
    try:
        result = worker.evaluate(
            """
            async ({ targetUrl, targetOrigin, ttlMs }) => {
                const api = typeof browser !== 'undefined' ? browser : chrome;
                const owner = [
                    globalThis.PTK_EXTENSION_AUTOMATION,
                    globalThis.PTK_EXTENSION_FULL,
                    globalThis.PTK_EXTENSION_FULL_DEV,
                ].find(candidate => typeof candidate?.extension?.contentRuntime?.armPrimaryTab === 'function');
                const contentRuntime = owner?.extension?.contentRuntime || null;
                if (!contentRuntime || typeof contentRuntime.armPrimaryTab !== 'function') {
                    return { ok: false, applicable: false, error: 'ptklabs_automation_worker_not_found' };
                }

                let normalizedTargetUrl;
                try {
                    normalizedTargetUrl = new URL(targetUrl).href;
                } catch (_) {
                    return { ok: false, applicable: true, error: 'ptk_target_url_invalid' };
                }
                if (!['http:', 'https:'].includes(new URL(normalizedTargetUrl).protocol)) {
                    return { ok: false, applicable: true, error: 'ptk_target_url_unsupported' };
                }

                const sameUrl = (tab) => {
                    try {
                        return new URL(tab?.url || '').href === normalizedTargetUrl;
                    } catch (_) {
                        return false;
                    }
                };
                const activeTabs = typeof api.tabs?.query === 'function'
                    ? await api.tabs.query({ active: true, currentWindow: true })
                    : [];
                let matches = (Array.isArray(activeTabs) ? activeTabs : []).filter(sameUrl);
                if (matches.length !== 1 && typeof api.tabs?.query === 'function') {
                    const allTabs = await api.tabs.query({});
                    matches = (Array.isArray(allTabs) ? allTabs : []).filter(sameUrl);
                }
                if (matches.length !== 1) {
                    return {
                        ok: false,
                        applicable: true,
                        error: matches.length > 1 ? 'ptk_target_tab_ambiguous' : 'ptk_target_tab_not_found',
                        matchCount: matches.length,
                    };
                }

                const tab = matches[0];
                try {
                    const grant = await contentRuntime.armPrimaryTab({
                        caller: { trusted: true, source: 'ptk-agent-service-worker' },
                        tab,
                        tabId: tab.id,
                        url: tab.url || normalizedTargetUrl,
                        targetScope: {
                            origins: [targetOrigin],
                            urls: [],
                            excludeUrls: [],
                        },
                        ttlMs,
                    });
                    if (!grant || grant.ok === false) {
                        return {
                            ok: false,
                            applicable: true,
                            error: grant?.code || grant?.error || 'ptk_target_arm_failed',
                        };
                    }
                    return {
                        ok: true,
                        applicable: true,
                        implementation: 'ptklabs',
                        tabId: tab.id,
                        grantId: grant.grantId || null,
                        expiresAt: grant.expiresAt || null,
                    };
                } catch (error) {
                    return {
                        ok: false,
                        applicable: true,
                        error: error?.code || 'ptk_target_arm_failed',
                        message: error?.message || String(error),
                    };
                }
            }
            """,
            {
                "targetUrl": target_url,
                "targetOrigin": target_origin,
                "ttlMs": max(1, min(int(ttl_seconds * 1000), 60000)),
            },
        )
    except Exception as exc:
        return {
            "ok": False,
            "applicable": True,
            "error": "ptk_target_arm_failed",
            "message": str(exc),
        }
    return result if isinstance(result, dict) else {
        "ok": False,
        "applicable": True,
        "error": "ptk_target_arm_invalid_response",
    }


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
    ptklabs_bootstrap_attempted = False
    ptklabs_bootstrap = None
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

        if error == "bridge_not_found" and not ptklabs_bootstrap_attempted:
            ptklabs_bootstrap_attempted = True
            ptklabs_bootstrap = arm_ptklabs_automation_target(page)
            if ptklabs_bootstrap.get("applicable"):
                print(f"[PTK Bridge] PTK Labs target bootstrap: {ptklabs_bootstrap}")
            if ptklabs_bootstrap.get("ok"):
                page.reload(wait_until="domcontentloaded")
                time.sleep(min(poll_interval, 0.25))
                continue

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
    if ptklabs_bootstrap and ptklabs_bootstrap.get("applicable") and not ptklabs_bootstrap.get("ok"):
        bootstrap_error = ptklabs_bootstrap.get("error") or "unknown"
        bootstrap_message = ptklabs_bootstrap.get("message") or ""
        error_detail += f". PTK Labs bootstrap: {bootstrap_error}"
        if bootstrap_message:
            error_detail += f": {bootstrap_message}"

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
