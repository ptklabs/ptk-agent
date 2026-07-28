import time
from typing import Iterable, Optional

from .exceptions import (
    PTKAutomationDisabledError,
    PTKBridgeError,
    PTKNotReadyError,
    PTKSessionError,
)

REQUIRED_CAPABILITIES = ["startSession", "endSession", "getStats", "getFindings"]
VALID_ENGINES = {"DAST", "IAST", "SAST", "SCA"}

PING_SCRIPT = """
async () => {
  const bridge = window.PTK_AUTOMATION;
  if (!bridge) return { ok: false, error: 'bridge_not_found' };
  if (typeof bridge.ping === 'function') return await bridge.ping();
  const capabilities = ['startSession', 'endSession', 'getStats', 'getFindings', 'getSessionProgress', 'exportScan']
    .filter((name) => typeof bridge[name] === 'function');
  return {
    ok: capabilities.length >= 4,
    version: bridge.version || 'unknown',
    capabilities,
    automationEnabled: true
  };
}
"""

REQUEST_ACTIVATION_SCRIPT = """
async (options) => {
  const bridge = window.PTK_AUTOMATION;
  if (!bridge || typeof bridge.requestActivation !== 'function') {
    return { ok: false, allowed: false, error: 'request_activation_unavailable' };
  }
  try {
    return await bridge.requestActivation(options || {});
  } catch (error) {
    return { ok: false, allowed: false, error: error?.message || String(error) };
  }
}
"""

CALL_SCRIPT = """
async ({ method, options }) => {
  const bridge = window.PTK_AUTOMATION;
  if (!bridge || typeof bridge[method] !== 'function') {
    return { ok: false, error: `bridge_method_unavailable:${method}` };
  }
  try {
    const result = await bridge[method](options || {});
    if (result && typeof result === 'object') return result;
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
"""


def normalize_engines(value, fallback: Optional[Iterable[str]] = None):
    fallback = list(fallback or ["DAST"])
    items = value if isinstance(value, (list, tuple, set)) else str(value or "").split(",")
    out = []
    seen = set()
    for item in items:
        engine = str(item or "").strip().upper()
        if engine not in VALID_ENGINES or engine in seen:
            continue
        seen.add(engine)
        out.append(engine)
    return out or fallback


def normalize_session_id(result):
    if not isinstance(result, dict):
        return None
    session = result.get("session")
    if isinstance(session, dict) and session.get("id"):
        return session.get("id")
    return result.get("sessionId") or result.get("id")


def is_failure_result(result) -> bool:
    return isinstance(result, dict) and (result.get("ok") is False or result.get("status") == "error")


def error_message(result, fallback="unknown_error"):
    if not isinstance(result, dict):
        return fallback
    return result.get("error") or result.get("message") or result.get("reason") or fallback


def validate_capabilities(info, required=None):
    required = required or REQUIRED_CAPABILITIES
    if info and info.get("automationEnabled") is False:
        raise PTKAutomationDisabledError(
            "PTK automation is disabled. Enable PTK Automation Mode or allow requestActivation.",
            info,
        )
    capabilities = info.get("capabilities", []) if isinstance(info, dict) else []
    missing = [name for name in required if name not in capabilities]
    if missing:
        raise PTKBridgeError(
            f"PTK bridge missing capabilities: {', '.join(missing)}",
            "PTK_CAPABILITY_MISSING",
            {"info": info, "missing": missing},
        )


class PTKBridge:
    """Framework-neutral PTK bridge wrapper.

    The adapter must expose ``evaluate(function_source, arg=None)`` and may
    expose ``wait_for_timeout(ms)``.
    """

    def __init__(self, adapter, default_timeout: float = 30, activate: bool = True):
        if not adapter or not hasattr(adapter, "evaluate"):
            raise PTKBridgeError("PTKBridge requires an adapter with evaluate()", "PTK_BRIDGE_NOT_FOUND")
        self.adapter = adapter
        self.default_timeout = default_timeout
        self.activate = activate
        self.session_id = None
        self.bridge_info = None

    def _sleep(self, seconds: float):
        wait = getattr(self.adapter, "wait_for_timeout", None)
        if callable(wait):
            wait(int(seconds * 1000))
        else:
            time.sleep(seconds)

    def ping(self):
        return self.adapter.evaluate(PING_SCRIPT)

    def request_activation(self, reason: str = "ptk_python_sdk_wait_ready"):
        return self.adapter.evaluate(REQUEST_ACTIVATION_SCRIPT, {"reason": reason})

    def wait_ready(self, timeout: Optional[float] = None, poll_interval: float = 0.5, activate: Optional[bool] = None):
        timeout = float(timeout if timeout is not None else self.default_timeout)
        should_activate = self.activate if activate is None else bool(activate)
        deadline = time.time() + timeout
        last = None

        while time.time() <= deadline:
            try:
                last = self.ping()
            except Exception as exc:
                last = {"ok": False, "error": str(exc)}
            if isinstance(last, dict) and last.get("ok"):
                validate_capabilities(last)
                self.bridge_info = last
                return last
            if should_activate and isinstance(last, dict) and (
                last.get("error") == "automation_disabled" or last.get("automationEnabled") is False
            ):
                self.request_activation()
                self._sleep(min(poll_interval, 0.25))
                continue
            self._sleep(poll_interval)

        if isinstance(last, dict) and (
            last.get("error") == "automation_disabled" or last.get("automationEnabled") is False
        ):
            raise PTKAutomationDisabledError("PTK automation is disabled after startup wait.", last)
        raise PTKNotReadyError(f"PTK bridge not ready after {int(timeout)}s: {last}", last)

    def call(self, method: str, options=None):
        return self.adapter.evaluate(CALL_SCRIPT, {"method": method, "options": options or {}})

    def start_session(
        self,
        project: str = None,
        engines=None,
        policy_code: str = None,
        test_run_id: str = None,
        **options,
    ):
        result = self.call(
            "startSession",
            {
                **options,
                "project": project,
                "engines": normalize_engines(engines or options.get("engines") or "DAST"),
                "policyCode": policy_code or options.get("policyCode"),
                "testRunId": test_run_id or options.get("testRunId"),
            },
        )
        if is_failure_result(result):
            raise PTKSessionError(f"PTK startSession failed: {error_message(result)}")
        session_id = normalize_session_id(result)
        if not session_id:
            session_id = f"ptk-started-{int(time.time() * 1000)}"
            if isinstance(result, dict):
                result["sessionId"] = session_id
        self.session_id = session_id
        return {"ok": True, **(result or {}), "sessionId": session_id}

    def end_session(self, wait: bool = True, session_id: str = None, **options):
        target_session_id = session_id or self.session_id
        if not target_session_id:
            raise PTKSessionError("PTK session id is required to stop a scan")
        result = self.call("endSession", {**options, "sessionId": target_session_id, "wait": bool(wait)})
        if is_failure_result(result):
            raise PTKSessionError(f"PTK endSession failed: {error_message(result)}")
        if wait:
            self.session_id = None
        return {"ok": True, **(result or {})}

    def get_stats(self, **options):
        return self.call("getStats", {**options, "sessionId": options.get("sessionId") or self.session_id})

    def get_findings(self, limit: int = 500, **options):
        return self.call(
            "getFindings",
            {**options, "limit": limit, "sessionId": options.get("sessionId") or self.session_id},
        )

    def get_session_progress(self, **options):
        return self.call(
            "getSessionProgress",
            {**options, "sessionId": options.get("sessionId") or self.session_id},
        )

    def export_scan(self, **options):
        return self.call("exportScan", {**options, "sessionId": options.get("sessionId") or self.session_id})
