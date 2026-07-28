from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Optional

from .bridge import normalize_engines
from .exceptions import PtkScanError
from .results import collect_ptk_results, write_ptk_results


@dataclass
class PtkScanOptions:
    project: Optional[str] = None
    engines: Iterable[str] = field(default_factory=lambda: ["DAST"])
    policy_code: Optional[str] = None
    test_run_id: Optional[str] = None
    results_dir: Optional[str] = None
    findings_limit: int = 500
    findings_timeout: float = 0
    wait_timeout: float = 30
    stop_wait: bool = True
    immediate_analysis: Optional[bool] = None
    collect_before_stop: bool = True
    collect_after_stop: bool = False
    throw_on_error: bool = True
    start_options: Dict[str, Any] = field(default_factory=dict)
    stop_options: Dict[str, Any] = field(default_factory=dict)


def _call_journey(run_journey: Callable, context: Dict[str, Any]):
    try:
        return run_journey(**context)
    except TypeError:
        return run_journey(context)


def apply_automation_scan_defaults(start_options: Optional[Dict[str, Any]], engines: Iterable[str]):
    resolved = dict(start_options or {})
    normalized_engines = normalize_engines(engines)
    if "DAST" not in normalized_engines:
        return resolved

    engine_configs = dict(resolved.get("engineConfigs") or {})
    dast_config = dict(engine_configs.get("DAST") or {})
    if "allowCaptureWithoutInteraction" not in dast_config:
        dast_config["allowCaptureWithoutInteraction"] = True
        engine_configs["DAST"] = dast_config
        resolved["engineConfigs"] = engine_configs
    return resolved


def with_ptk_scan(bridge, options: PtkScanOptions, run_journey: Callable, context: Optional[Dict[str, Any]] = None):
    if not callable(run_journey):
        raise TypeError("with_ptk_scan requires a run_journey callback")

    context = dict(context or {})
    result = {
        "ok": False,
        "session": None,
        "journeyResult": None,
        "beforeStop": None,
        "afterStop": None,
        "stop": None,
        "error": None,
        "stopError": None,
        "resultsDir": options.results_dir,
    }
    journey_error = None

    try:
        bridge.wait_ready(timeout=options.wait_timeout)
        engines = normalize_engines(options.engines)
        start_options = apply_automation_scan_defaults(options.start_options, engines)
        result["session"] = bridge.start_session(
            project=options.project,
            engines=engines,
            policy_code=options.policy_code,
            test_run_id=options.test_run_id,
            **start_options,
        )
        context.update({"ptk": bridge, "session": result["session"]})
        result["journeyResult"] = _call_journey(run_journey, context)
    except Exception as exc:
        journey_error = exc
        result["error"] = {
            "message": str(exc),
            "name": exc.__class__.__name__,
            "code": getattr(exc, "code", None),
        }
    finally:
        if result["session"]:
            if options.collect_before_stop:
                result["beforeStop"] = collect_ptk_results(
                    bridge,
                    result["session"],
                    findings_limit=options.findings_limit,
                    findings_timeout=options.findings_timeout,
                )
            try:
                stop_payload = {
                    **(options.stop_options or {}),
                    "includeFindings": False,
                    "limit": options.findings_limit,
                }
                if options.immediate_analysis is not None:
                    stop_payload["immediateAnalysis"] = bool(options.immediate_analysis)
                result["stop"] = bridge.end_session(wait=options.stop_wait, **stop_payload)
            except Exception as exc:
                result["stopError"] = {
                    "message": str(exc),
                    "name": exc.__class__.__name__,
                    "code": getattr(exc, "code", None),
                }
            if options.collect_after_stop:
                result["afterStop"] = collect_ptk_results(
                    bridge,
                    result["session"],
                    findings_limit=options.findings_limit,
                )
        if options.results_dir:
            try:
                result["artifacts"] = write_ptk_results(result, options.results_dir)
            except Exception as exc:
                result["artifactError"] = {
                    "message": str(exc),
                    "name": exc.__class__.__name__,
                }

    result["ok"] = journey_error is None and result.get("stopError") is None
    if not result["ok"] and options.throw_on_error:
        if journey_error:
            raise journey_error
        raise PtkScanError(result["stopError"]["message"] or "PTK scan stop failed", result)
    return result
