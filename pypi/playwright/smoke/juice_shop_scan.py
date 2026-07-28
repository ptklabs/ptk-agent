"""
Juice Shop PTK Scan Example - Playwright Version

Unified workflow used across SDKs:
1. Start PTK session
2. Dismiss overlays
3. Open login page and log in
4. Open profile page, then return home
5. Clear basket, add 3 products, open basket, remove 1 item
6. Search for "test"
7. Check required findings and end PTK session
"""

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import List
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from ptk_playwright import (
    PTKPlaywrightConfig,
    PTKSessionError,
    PTKTimeoutError,
    arm_iast_for_navigation,
    ptk_session,
)


def _env(*names, default=None):
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return default


def _truthy_env(*names, default=""):
    value = _env(*names, default=default) or ""
    return value.lower() in {"1", "true", "yes", "on"}


def diagnostic_smoke_engines(default: List[str]) -> List[str]:
    raw = _env("PTK_DIAGNOSTIC_SMOKE_ENGINES")
    if not raw:
        return list(default)
    allowed = {"DAST", "IAST", "SAST", "SCA"}
    requested = []
    for value in raw.split(","):
        engine = value.strip().upper()
        if engine and engine not in requested:
            requested.append(engine)
    invalid = [engine for engine in requested if engine not in allowed]
    if not requested or invalid:
        raise ValueError(
            "PTK_DIAGNOSTIC_SMOKE_ENGINES must be a comma-separated subset of "
            f"{sorted(allowed)}; invalid={invalid}"
        )
    print(f"[diagnostic] overriding smoke engines: {requested}")
    return requested


def _safe_artifact_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in value)


def write_json_artifact(config: PTKPlaywrightConfig, name: str, payload: dict):
    artifacts_dir = Path(config.artifacts_dir or os.getcwd()).expanduser().resolve()
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    path = artifacts_dir / _safe_artifact_name(name)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(f"Artifact written: {path}")
    return path


def finding_text(value) -> str:
    parts = []

    def visit(item):
        if item is None:
            return
        if isinstance(item, (str, int, float, bool)):
            parts.append(str(item))
            return
        if isinstance(item, dict):
            for key, nested in item.items():
                parts.append(str(key))
                visit(nested)
            return
        if isinstance(item, list):
            for nested in item:
                visit(nested)

    visit(value)
    return " ".join(parts)


def finding_label(finding: dict) -> str:
    if not isinstance(finding, dict):
        return str(finding)[:160]
    for key in [
        "name",
        "title",
        "moduleName",
        "module_name",
        "attackName",
        "attack_name",
        "vulnerability",
        "ruleName",
        "rule_name",
        "type",
        "id",
    ]:
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:220]
    return finding_text(finding)[:220]


def evaluate_required_findings(findings: List[dict]) -> dict:
    matched = {
        "dast_sql_login": [],
        "dast_jwt_none_cookie": [],
        "dast_jwt_none_authorization": [],
        "dast_spa_dom_xss": [],
        "iast_innerhtml": [],
        "sast_angular_innerhtml": [],
    }

    for finding in findings or []:
        text = finding_text(finding)
        lower = text.lower()
        label = finding_label(finding)

        if ("sql" in lower or "sqli" in lower) and (
            "login" in lower or "/rest/user/login" in lower or "rest/user/login" in lower
        ):
            matched["dast_sql_login"].append(label)

        if "jwt" in lower and "none" in lower and "cookie" in lower:
            matched["dast_jwt_none_cookie"].append(label)

        if "jwt" in lower and "none" in lower and (
            "authorization" in lower or "authz" in lower or "bearer" in lower
        ):
            matched["dast_jwt_none_authorization"].append(label)

        if ("spa" in lower and "dom" in lower and "xss" in lower) or (
            "spa hash" in lower and "xss" in lower
        ):
            matched["dast_spa_dom_xss"].append(label)

        if (
            "dom xss via element.innerhtml" in lower
            or ("element.innerhtml" in lower and "dom xss" in lower)
            or ("dom.innerhtml" in lower and "iast" in lower)
        ):
            matched["iast_innerhtml"].append(label)

        if (
            "dom xss via innerhtml (angular)" in lower
            or ("angular" in lower and "innerhtml" in lower and "sast" in lower)
            or ("dom:angular_property_innerhtml" in lower)
            or ("dom:angular_renderer_setproperty" in lower)
        ):
            matched["sast_angular_innerhtml"].append(label)

    specs = [
        ("dast_sql_login", "DAST SQL injection on login", 1),
        ("dast_jwt_none_cookie", "DAST JWT None Cookie", 1),
        ("dast_jwt_none_authorization", "DAST JWT None Authorization Header", 1),
        ("dast_spa_dom_xss", "DAST SPA DOM XSS", 1),
        ("iast_innerhtml", "IAST DOM XSS via Element.innerHTML", 1),
        ("sast_angular_innerhtml", "SAST DOM XSS via innerHTML (Angular)", 2),
    ]
    requirements = []
    for key, description, minimum in specs:
        samples = matched[key]
        requirements.append({
            "key": key,
            "description": description,
            "minimum": minimum,
            "count": len(samples),
            "ok": len(samples) >= minimum,
            "samples": samples[:8],
        })

    return {
        "ok": all(item["ok"] for item in requirements),
        "totalFindings": len(findings or []),
        "requirements": requirements,
    }


def print_finding_gate(gate: dict):
    print("Required finding gate:")
    for item in gate.get("requirements", []):
        status = "OK" if item.get("ok") else "MISSING"
        print(f"  [{status}] {item['description']}: {item['count']}/{item['minimum']}")
        for sample in item.get("samples", [])[:3]:
            print(f"    - {sample}")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def required_engines(config: PTKPlaywrightConfig) -> List[str]:
    return [str(engine).strip().upper() for engine in (config.engines or []) if str(engine).strip()]


def evaluate_engine_gate(progress: dict, engines: List[str]) -> dict:
    progress_engines = progress.get("engines", {}) or {}
    observed = sorted(str(name).upper() for name in progress_engines.keys())
    required = sorted(set(str(engine).strip().upper() for engine in engines if str(engine).strip()))
    missing = [engine for engine in required if engine not in observed]
    error_engines = []
    for name, payload in progress_engines.items():
        if isinstance(payload, dict) and payload.get("status") == "error":
            error_engines.append(str(name).upper())
    return {
        "requiredEngines": required,
        "observedEngines": observed,
        "missingEngines": missing,
        "errorEngines": sorted(error_engines),
        "passed": not missing and not error_engines,
    }


VOLATILE_QUERY_KEYS = {
    "_",
    "cb",
    "cache",
    "cachebust",
    "cachebuster",
    "nonce",
    "requestid",
    "request_id",
    "rid",
    "sid",
    "t",
    "ts",
    "timestamp",
}
SENSITIVE_BODY_KEY_RE = re.compile(
    r"(?:^|[_-])(secret|token|password|passwd|pwd|api(?:[_-]?key)?|auth|authorization|bearer|credential|csrf|session|cookie)(?:[_-]|$)",
    re.I,
)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
HEX_ID_RE = re.compile(r"^[0-9a-f]{16,}$", re.I)


def _short_hash(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _is_volatile_query_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9_/-]", "", str(key or "").lower())
    return normalized in VOLATILE_QUERY_KEYS or normalized.startswith("utm_")


def _route_shape_path(path: str) -> str:
    parts = []
    for part in str(path or "").split("/"):
        if not part:
            parts.append(part)
            continue
        if part.isdigit() or UUID_RE.match(part) or HEX_ID_RE.match(part):
            parts.append(":id")
        else:
            parts.append(part)
    return "/".join(parts)


def _normalize_fragment(fragment: str, *, route_shape: bool = False) -> str:
    if not fragment:
        return ""
    if "?" not in fragment:
        return _route_shape_path(fragment) if route_shape else fragment
    path, query = fragment.split("?", 1)
    normalized_path = _route_shape_path(path) if route_shape else path
    pairs = []
    for key, value in parse_qsl(query, keep_blank_values=True):
        if _is_volatile_query_key(key):
            continue
        pairs.append((key, "" if route_shape else value))
    pairs.sort()
    if not pairs:
        return normalized_path
    if route_shape:
        return f"{normalized_path}?{'&'.join(key for key, _ in pairs)}"
    return f"{normalized_path}?{urlencode(pairs, doseq=True)}"


def _normalize_url(raw_url: str, *, route_shape: bool = False) -> str:
    if not raw_url:
        return ""
    text = str(raw_url)
    try:
        parsed = urlsplit(text)
    except Exception:
        return text

    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = _route_shape_path(parsed.path) if route_shape else parsed.path
    pairs = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if _is_volatile_query_key(key):
            continue
        pairs.append((key, "" if route_shape else value))
    pairs.sort()
    query = "&".join(key for key, _ in pairs) if route_shape else urlencode(pairs, doseq=True)
    fragment = _normalize_fragment(parsed.fragment, route_shape=route_shape)
    return urlunsplit((scheme, netloc, path, query, fragment))


def _header_entries(headers) -> List[dict]:
    if isinstance(headers, list):
        out = []
        for entry in headers:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("key")
            if not name:
                continue
            out.append({"name": str(name), "value": str(entry.get("value", ""))})
        return out
    if isinstance(headers, dict):
        return [{"name": str(key), "value": str(value)} for key, value in headers.items()]
    return []


def _header_value(headers, name: str) -> str:
    needle = str(name or "").lower()
    for entry in _header_entries(headers):
        if str(entry.get("name", "")).lower() == needle:
            return str(entry.get("value", ""))
    return ""


def _auth_surface(headers) -> str:
    surfaces = []
    if _header_value(headers, "authorization"):
        surfaces.append("authorization")
    if _header_value(headers, "cookie"):
        surfaces.append("cookie")
    return "+".join(surfaces) if surfaces else "none"


def _redact_body_value(key: str, value):
    if SENSITIVE_BODY_KEY_RE.search(str(key or "")):
        return {"kind": "secret"}
    if value is None:
        return {"kind": "null"}
    if isinstance(value, bool):
        return {"kind": "bool"}
    if isinstance(value, (int, float)):
        return {"kind": "number"}
    if isinstance(value, list):
        return {"kind": "list", "length": len(value)}
    if isinstance(value, dict):
        return {"kind": "object", "keys": sorted(str(key) for key in value.keys())[:24]}
    text = str(value)
    return {"kind": "string", "lengthBucket": min(4096, (len(text) // 16) * 16)}


def _body_shape_from_text(text: str):
    raw = str(text or "")
    if not raw:
        return {"kind": "none"}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {
                "kind": "json",
                "fields": {
                    str(key): _redact_body_value(str(key), value)
                    for key, value in sorted(parsed.items(), key=lambda item: str(item[0]))
                },
            }
    except Exception:
        pass

    pairs = parse_qsl(raw, keep_blank_values=True)
    if pairs:
        fields = {}
        for key, value in pairs:
            fields.setdefault(str(key), []).append(_redact_body_value(str(key), value))
        return {"kind": "form", "fields": fields}

    return {"kind": "raw", "lengthBucket": min(4096, (len(raw) // 32) * 32)}


def _body_shape(body):
    if body is None or body == "":
        return {"kind": "none"}
    if isinstance(body, str):
        return _body_shape_from_text(body)
    if isinstance(body, dict):
        if isinstance(body.get("text"), str):
            return _body_shape_from_text(body.get("text"))
        if isinstance(body.get("raw"), str):
            return _body_shape_from_text(body.get("raw"))
        if isinstance(body.get("postData"), str):
            return _body_shape_from_text(body.get("postData"))
        if isinstance(body.get("json"), dict):
            return {
                "kind": "json",
                "fields": {
                    str(key): _redact_body_value(str(key), value)
                    for key, value in sorted(body.get("json").items(), key=lambda item: str(item[0]))
                },
            }
        if isinstance(body.get("params"), list):
            fields = {}
            for item in body.get("params"):
                if not isinstance(item, dict):
                    continue
                key = str(item.get("name") or item.get("key") or "")
                if not key:
                    continue
                fields.setdefault(key, []).append(_redact_body_value(key, item.get("value")))
            if fields:
                return {"kind": "form", "fields": fields}
        if isinstance(body.get("formData"), dict):
            fields = {
                str(key): _redact_body_value(str(key), value)
                for key, value in sorted(body.get("formData").items(), key=lambda item: str(item[0]))
            }
            return {"kind": "form", "fields": fields}
    return {"kind": "other", "type": type(body).__name__}


def _request_payload_from_record(record: dict) -> dict:
    if not isinstance(record, dict):
        return {}
    original = record.get("original") if isinstance(record.get("original"), dict) else {}
    request = original.get("request") if isinstance(original.get("request"), dict) else None
    if request is None:
        request = record.get("request") if isinstance(record.get("request"), dict) else record
    return request if isinstance(request, dict) else {}


def _response_payload_from_record(record: dict) -> dict:
    if not isinstance(record, dict):
        return {}
    original = record.get("original") if isinstance(record.get("original"), dict) else {}
    response = original.get("response") if isinstance(original.get("response"), dict) else None
    if response is None:
        response = record.get("response") if isinstance(record.get("response"), dict) else {}
    return response if isinstance(response, dict) else {}


def _extract_request_entry(engine: str, record: dict) -> dict:
    if not isinstance(record, dict):
        record = {}
    request = _request_payload_from_record(record)
    response = _response_payload_from_record(record)
    method = str(request.get("method") or record.get("method") or "GET").upper()
    url = (
        request.get("url")
        or request.get("ui_url")
        or record.get("url")
        or record.get("displayUrl")
        or record.get("runtimeUrl")
        or ""
    )
    headers = request.get("headers") or request.get("requestHeaders") or record.get("requestHeaders") or []
    content_type = _header_value(headers, "content-type") or str(request.get("contentType") or "")
    body = (
        request.get("body")
        if "body" in request
        else request.get("requestBody", request.get("postData"))
    )
    shape = _body_shape(body)
    normalized_exact_url = _normalize_url(url, route_shape=False)
    normalized_route_url = _normalize_url(url, route_shape=True)
    body_hash = _short_hash(shape)
    status = response.get("statusCode") or response.get("status") or record.get("statusCode") or record.get("status")
    auth = _auth_surface(headers)
    content_type_key = content_type.split(";")[0].strip().lower() if content_type else "none"
    exact_key = f"{method} {normalized_exact_url} ct={content_type_key} auth={auth} body={body_hash}"
    route_key = f"{method} {normalized_route_url} ct={content_type_key} auth={auth} body={body_hash}"
    return {
        "engine": engine,
        "method": method,
        "url": str(url or ""),
        "normalizedUrl": normalized_exact_url,
        "routeUrl": normalized_route_url,
        "status": status,
        "authSurface": auth,
        "contentType": content_type_key,
        "bodyShape": shape.get("kind", "unknown"),
        "bodyShapeHash": body_hash,
        "exactKey": exact_key,
        "routeKey": route_key,
    }


def _add_group(groups: dict, key: str, entry: dict):
    group = groups.setdefault(key, {
        "key": key,
        "count": 0,
        "engines": set(),
        "methods": set(),
        "statuses": set(),
        "samples": [],
    })
    group["count"] += 1
    group["engines"].add(entry.get("engine"))
    group["methods"].add(entry.get("method"))
    if entry.get("status") is not None:
        group["statuses"].add(str(entry.get("status")))
    if len(group["samples"]) < 5:
        group["samples"].append({
            "engine": entry.get("engine"),
            "method": entry.get("method"),
            "url": entry.get("normalizedUrl")[:240],
            "routeUrl": entry.get("routeUrl")[:240],
            "status": entry.get("status"),
        })


def _finish_groups(groups: dict, *, only_duplicates: bool = False, limit: int = 20) -> List[dict]:
    rows = []
    for group in groups.values():
        if only_duplicates and group["count"] <= 1:
            continue
        rows.append({
            "key": group["key"],
            "count": group["count"],
            "engines": sorted(value for value in group["engines"] if value),
            "methods": sorted(value for value in group["methods"] if value),
            "statuses": sorted(value for value in group["statuses"] if value),
            "samples": group["samples"],
        })
    rows.sort(key=lambda item: (-item["count"], item["key"]))
    return rows[:limit]


def build_coverage_summary(export_result: dict, progress: dict = None) -> dict:
    exact_groups = {}
    route_groups = {}
    engine_summaries = []
    scans = export_result.get("scans") if isinstance(export_result, dict) else []
    if not isinstance(scans, list):
        scans = []

    for descriptor in scans:
        if not isinstance(descriptor, dict):
            continue
        engine = str(descriptor.get("engine") or "").upper() or "UNKNOWN"
        scan = descriptor.get("scan") if isinstance(descriptor.get("scan"), dict) else descriptor
        records = scan.get("requests") if isinstance(scan, dict) else []
        if not isinstance(records, list):
            records = []
        engine_exact = {}
        engine_route = {}
        for record in records:
            entry = _extract_request_entry(engine, record)
            if not entry.get("normalizedUrl"):
                continue
            _add_group(exact_groups, entry["exactKey"], entry)
            _add_group(route_groups, entry["routeKey"], entry)
            _add_group(engine_exact, entry["exactKey"], entry)
            _add_group(engine_route, entry["routeKey"], entry)
        engine_summaries.append({
            "engine": engine,
            "requestCount": len(records),
            "uniqueExactRequestCount": len(engine_exact),
            "uniqueRouteRequestCount": len(engine_route),
            "duplicateExactRequestCount": max(0, len(records) - len(engine_exact)),
            "duplicateRouteRequestCount": max(0, len(records) - len(engine_route)),
            "topDuplicateExactGroups": _finish_groups(engine_exact, only_duplicates=True, limit=10),
            "topDuplicateRouteGroups": _finish_groups(engine_route, only_duplicates=True, limit=10),
        })

    exact_keys = sorted(exact_groups.keys())
    route_keys = sorted(route_groups.keys())
    total_requests = sum(item.get("requestCount", 0) for item in engine_summaries)
    progress_capture = ((progress or {}).get("engines", {}) or {}).get("DAST", {}).get("captureStats", {})
    return {
        "ok": True,
        "generatedAt": iso_now(),
        "exportOk": bool(export_result.get("ok")) if isinstance(export_result, dict) else False,
        "exportWarnings": export_result.get("warnings", []) if isinstance(export_result, dict) else [],
        "totals": {
            "requestCount": total_requests,
            "uniqueExactRequestCount": len(exact_keys),
            "uniqueRouteRequestCount": len(route_keys),
            "duplicateExactRequestCount": max(0, total_requests - len(exact_keys)),
            "duplicateRouteRequestCount": max(0, total_requests - len(route_keys)),
        },
        "progressCaptureStats": progress_capture if isinstance(progress_capture, dict) else {},
        "engines": engine_summaries,
        "keys": {
            "exact": exact_keys,
            "route": route_keys,
        },
        "topDuplicateExactGroups": _finish_groups(exact_groups, only_duplicates=True, limit=20),
        "topDuplicateRouteGroups": _finish_groups(route_groups, only_duplicates=True, limit=20),
    }


def build_failed_coverage_summary(error: str, snapshot: dict = None, progress: dict = None) -> dict:
    return {
        "ok": False,
        "generatedAt": iso_now(),
        "error": error,
        "snapshotSummary": (snapshot or {}).get("summary") if isinstance(snapshot, dict) else None,
        "progressCaptureStats": (((progress or {}).get("engines", {}) or {}).get("DAST", {}) or {}).get("captureStats", {}),
        "totals": {
            "requestCount": 0,
            "uniqueExactRequestCount": 0,
            "uniqueRouteRequestCount": 0,
            "duplicateExactRequestCount": 0,
            "duplicateRouteRequestCount": 0,
        },
        "engines": [],
        "keys": {"exact": [], "route": []},
        "topDuplicateExactGroups": [],
        "topDuplicateRouteGroups": [],
    }


def write_browser_launch_artifact(config: PTKPlaywrightConfig, base_url: str):
    write_json_artifact(
        config,
        "browser-launch.json",
        {
            "browserName": config.browser,
            "browserVersion": None,
            "executablePath": config.executable_path,
            "headless": bool(config.headless),
            "extensionPath": config.extension_path,
            "profileMode": "persistent-context",
            "profileDir": config.profile_dir,
            "launchArgs": [],
            "targetUrl": base_url,
        },
    )


def write_framework_run_artifact(
    config: PTKPlaywrightConfig,
    base_url: str,
    started_at: str,
    status: str,
    failure_reason=None,
):
    write_json_artifact(
        config,
        "framework-run.json",
        {
            "framework": "playwright",
            "browser": config.browser,
            "mode": os.getenv("PTK_RELEASE_TEST_MODE", "source"),
            "packageRoot": os.getenv("PTK_PACKAGE_ROOT"),
            "sdkRoot": str(Path(__file__).resolve().parents[1]),
            "extensionPath": config.extension_path,
            "targetUrl": base_url,
            "profileDir": config.profile_dir,
            "artifactsDir": config.artifacts_dir,
            "startedAt": started_at,
            "endedAt": iso_now() if status != "started" else None,
            "status": status,
            "failureReason": failure_reason,
        },
    )


def clear_site_state(page, base_url: str):
    page.goto(f"{base_url}/")
    page.context.clear_cookies()
    try:
        page.evaluate("window.localStorage.clear()")
        page.evaluate("window.sessionStorage.clear()")
    except Exception:
        pass


def print_progress(progress: dict):
    if progress.get("error"):
        print(f"  [Progress error: {progress.get('error')}]")
        return

    status = progress.get("status", "unknown")
    elapsed = progress.get("elapsedMs", 0) / 1000
    summary = progress.get("summary", {})

    print(f"[{elapsed:.1f}s] Status: {status}")

    engines = progress.get("engines", {})
    for name, eng in engines.items():
        eng_status = eng.get("status", "?")
        done = eng.get("progress", {}).get("done")
        total = eng.get("progress", {}).get("total")
        findings = eng.get("findingsCount", 0)

        progress_str = ""
        if done is not None:
            progress_str = f" ({done}/{total if total is not None else '?'})"

        print(f"  {name}: {eng_status}{progress_str} - {findings} findings")

    total_findings = summary.get("findingsCount", 0)
    print(f"  Total findings: {total_findings}")
    print()


def summarize_progress(progress: dict) -> str:
    engines = progress.get("engines", {}) or {}
    parts = []
    for name, eng in engines.items():
        status = eng.get("status", "?")
        running = "running" if eng.get("isRunning") else "idle"
        drained = ":drained" if eng.get("idle") is True else ""
        phase = eng.get("phase")
        findings = eng.get("findingsCount", 0)
        done = eng.get("progress", {}).get("done")
        total = eng.get("progress", {}).get("total")
        remaining = eng.get("progress", {}).get("remaining", eng.get("remaining"))
        part = f"{name}:{status}:{running}{drained}"
        if phase:
            part += f":{phase}"
        part += f":{done if done is not None else '?'}/{total if total is not None else '?'}"
        if remaining is not None:
            part += f":remaining={remaining}"
        part += f":findings={findings}"
        parts.append(part)
    return " | ".join(parts)


def build_stability_signature(progress: dict, engines: List[str]) -> str:
    data = []
    progress_engines = progress.get("engines", {}) or {}
    for name in engines:
        eng = progress_engines.get(name, {}) or {}
        data.append(
            {
                "engine": name,
                "status": eng.get("status", "unknown"),
                "isRunning": eng.get("isRunning") is True,
                "idle": eng.get("idle") is True,
                "phase": eng.get("phase"),
                "done": eng.get("progress", {}).get("done"),
                "total": eng.get("progress", {}).get("total"),
                "remaining": eng.get("progress", {}).get("remaining", eng.get("remaining")),
                "findings": eng.get("findingsCount", 0),
                "lastActivityAt": eng.get("lastActivityAt"),
            }
        )
    return json.dumps(data, sort_keys=True)


def are_requested_engines_idle(progress: dict, engines: List[str]) -> bool:
    progress_engines = progress.get("engines", {}) or {}
    for name in engines:
        eng = progress_engines.get(name)
        if not eng or eng.get("isRunning") is not False:
            return False
    return True


def has_requested_dast(engines: List[str]) -> bool:
    return "DAST" in [str(engine).upper() for engine in (engines or [])]


def is_dast_ready_to_stop(progress: dict) -> bool:
    dast = (progress.get("engines", {}) or {}).get("DAST") or {}
    remaining = dast.get("progress", {}).get("remaining", dast.get("remaining"))
    if dast.get("idle") is not True:
        return False
    if remaining is None:
        return True
    try:
        return int(remaining) == 0
    except Exception:
        return False


def get_completion_max_wait_seconds(mode: str) -> float:
    specific = _env(
        "PTK_MAX_SCAN_SECONDS_PRO" if mode.upper() == "PRO" else "PTK_MAX_SCAN_SECONDS_FREE"
    )
    shared = _env("PTK_MAX_SCAN_SECONDS")
    raw = specific or shared
    if raw:
        try:
            return max(60.0, float(raw))
        except Exception:
            pass
    return 600.0 if mode.upper() == "PRO" else 180.0


def wait_for_session_quiescence(
    ptk,
    mode: str,
    engines: List[str],
    scan_started_at: float,
    min_scan_seconds: float,
    poll_interval: float = 2.0,
    stable_seconds: float = 12.0,
):
    plateau_seconds = max(float(os.getenv("PTK_PLATEAU_STABLE_SECONDS", "30")), stable_seconds)
    floor_deadline = scan_started_at + max(15.0, float(min_scan_seconds))
    hard_deadline = scan_started_at + get_completion_max_wait_seconds(mode)
    stable_since = None
    last_signature = None
    last_summary = None
    last_progress = None

    while time.time() < hard_deadline:
        progress = ptk.get_session_progress(timeout=10)
        last_progress = progress

        if not progress.get("ok", True):
            raise PTKSessionError(f"Progress error: {progress.get('error', 'unknown')}")
        if progress.get("status") == "error":
            raise PTKSessionError(f"Session error: {progress.get('error', 'unknown')}")

        engines_progress = progress.get("engines", {}) or {}
        for name in engines:
            eng = engines_progress.get(name, {}) or {}
            if eng.get("status") == "error":
                raise PTKSessionError(f"{name} error: {eng.get('error', 'unknown')}")

        summary = summarize_progress(progress)
        if summary != last_summary:
            print(f"[quiescence:{mode}] {summary}")
            if _truthy_env("PTK_PROGRESS_DEBUG"):
                dast_details = ((progress.get("engines", {}) or {}).get("DAST") or {}).get("details")
                if dast_details:
                    print(
                        f"[quiescence:{mode}:dast-details] "
                        f"{json.dumps(dast_details, sort_keys=True)}"
                    )
            last_summary = summary

        floor_satisfied = time.time() >= floor_deadline
        dast_requested = has_requested_dast(engines)
        ready_to_stop = is_dast_ready_to_stop(progress) if dast_requested else are_requested_engines_idle(progress, engines)
        signature = build_stability_signature(progress, engines)

        if floor_satisfied and ready_to_stop:
            if dast_requested:
                return progress
            if signature != last_signature:
                last_signature = signature
                stable_since = time.time()
            elif stable_since and (time.time() - stable_since) >= stable_seconds:
                return progress
        elif floor_satisfied and not dast_requested:
            if signature != last_signature:
                last_signature = signature
                stable_since = time.time()
            elif stable_since and (time.time() - stable_since) >= plateau_seconds:
                print(f"[quiescence:{mode}] accepting stable plateau: {summary}")
                return progress
        else:
            stable_since = None
            last_signature = signature

        time.sleep(max(0.5, poll_interval))

    raise PTKTimeoutError(
        f"Session did not become {'DAST-idle' if has_requested_dast(engines) else 'idle/stable'} "
        f"within {get_completion_max_wait_seconds(mode):.0f}s: "
        f"{summarize_progress(last_progress or {})}"
    )


def first_visible_element(page, selectors):
    for selector in selectors:
        try:
            locator = page.locator(selector)
            for index in range(min(locator.count(), 50)):
                candidate = locator.nth(index)
                if candidate.is_visible():
                    return selector, candidate
        except Exception:
            continue
    return None, None


def first_visible_selector(page, selectors):
    selector, _ = first_visible_element(page, selectors)
    return selector


def click_if_present(page, selector):
    try:
        _, locator = first_visible_element(page, [selector])
        if locator:
            locator.click(timeout=5000, force=True)
            return True
    except Exception:
        pass
    return False


def click_required(page, selectors, label):
    last_error = None
    for _ in range(3):
        selector, locator = first_visible_element(page, selectors)
        if not locator:
            last_error = RuntimeError(f"Could not locate {label}. Tried: {selectors}")
            dismiss_overlays(page)
            page.wait_for_timeout(400)
            continue
        try:
            locator.click(timeout=10000, force=True)
            return
        except Exception as err:
            last_error = err
            dismiss_overlays(page)
            page.wait_for_timeout(400)

    raise RuntimeError(f"Failed to click {label}: {last_error}")


def type_required(page, selectors, value, label):
    _, field = first_visible_element(page, selectors)
    if not field:
        raise RuntimeError(f"Could not locate {label}. Tried: {selectors}")

    field.click(timeout=10000, force=True)
    field.fill(value, timeout=10000)


def dismiss_overlays(page):
    for selector in [
        ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
        "button[aria-label='Close Welcome Banner']",
        "a.cc-btn.cc-dismiss",
        "button[aria-label='Close Dialog']",
    ]:
        click_if_present(page, selector)

    try:
        page.keyboard.press("Escape")
    except Exception:
        pass


def wait_for_url_contains(page, needle: str, timeout_ms: int = 15000):
    started = time.time()
    target = (needle or "").lower()
    while (time.time() - started) * 1000 < timeout_ms:
        if target in page.url.lower():
            return
        page.wait_for_timeout(250)
    raise RuntimeError(f"Timed out waiting for URL to contain: {needle}")


def wait_for_any_visible_selector(page, selectors, timeout_ms: int = 15000):
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        selector = first_visible_selector(page, selectors)
        if selector:
            return selector
        page.wait_for_timeout(250)
    return None


def type_into_search(page, text):
    click_if_present(page, ".mat-search_icon-search")
    click_if_present(page, "#searchQuery")

    candidates = [
        "#searchQuery input",
        "app-mat-search-bar input",
        "input[id^='mat-input-']",
        "input[placeholder*='Search']",
        "input[aria-label='Search']",
        "input[type='search']",
    ]

    last_error = None
    for selector in candidates:
        locator = page.locator(selector)
        if locator.count() == 0:
            continue

        field = locator.first
        try:
            field.fill(text, timeout=10000, force=True)
            try:
                field.press("Enter", timeout=3000)
            except Exception:
                page.keyboard.press("Enter")
            return
        except Exception as err:
            last_error = err
            click_if_present(page, ".mat-search_icon-search")
            click_if_present(page, "#searchQuery")
            page.wait_for_timeout(300)

    if last_error:
        raise RuntimeError(f"Could not type into search input: {last_error}")
    raise RuntimeError("Could not locate a search input element")


def run_login_flow(page, base_url, email, password):
    login_form_selectors = [
        "#email",
        "input#emailControl",
        "input[formcontrolname='email']",
        "input[type='email']",
    ]

    click_required(
        page,
        [
            "#navbarAccount",
            "button[aria-label='Show/hide account menu']",
            "#navbarAccount > .mdc-button__label > span",
            "button[aria-label*='Account']",
        ],
        "account menu button",
    )

    page.wait_for_selector(".mat-mdc-menu-panel, .mat-menu-panel, #navbarLoginButton", timeout=10000)

    click_required(
        page,
        [
            "#navbarLoginButton",
            "button[aria-label='Go to login page']",
            ".mat-mdc-menu-panel #navbarLoginButton",
            ".mat-menu-panel #navbarLoginButton",
        ],
        "login menu item",
    )

    try:
        wait_for_url_contains(page, "login", timeout_ms=5000)
    except Exception:
        # Juice Shop occasionally leaves the menu open without completing the
        # router transition. Fall back to direct navigation so the smoke test
        # remains a PTK automation check instead of a brittle menu-click check.
        for candidate in (f"{base_url}/login", f"{base_url}/#/login"):
            try:
                page.goto(candidate, wait_until="domcontentloaded")
            except Exception:
                continue
            if wait_for_any_visible_selector(page, login_form_selectors, timeout_ms=5000):
                break
        else:
            raise

    type_required(
        page,
        login_form_selectors,
        email,
        "email input",
    )

    type_required(
        page,
        ["#password", "input#passwordControl", "input[formcontrolname='password']", "input[type='password']"],
        password,
        "password input",
    )

    click_required(
        page,
        [
            "#loginButton",
            "button#loginButton",
            "button[type='submit']",
            "button:has-text('Log in')",
        ],
        "login submit button",
    )
    try:
        pw_selector = first_visible_selector(
            page,
            [
                "#password",
                "input#passwordControl",
                "input[formcontrolname='password']",
                "input[type='password']",
            ],
        )
        if pw_selector:
            page.locator(pw_selector).first.press("Enter", timeout=2000)
    except Exception:
        pass

    if not wait_for_login_success(page, timeout_ms=15000):
        raise RuntimeError(
            "Login did not complete. Verify PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD "
            "or create this user in Juice Shop first."
        )


def ensure_smoke_user(page, base_url, email, password):
    if not email or not password or email == "YOUR_USERNAME" or password == "YOUR_PASSWORD":
        raise RuntimeError("PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD are required for the Juice Shop smoke test")
    try:
        response = page.request.post(
            f"{base_url}/api/Users/",
            data={
                "email": email,
                "password": password,
                "passwordRepeat": password,
                "securityQuestion": {
                    "id": 2,
                    "question": "Mother's maiden name?",
                },
                "securityAnswer": "ptk",
            },
        )
        status = response.status
    except Exception as exc:
        raise RuntimeError(f"Could not prepare Juice Shop smoke user: {exc}") from exc
    if status not in {200, 201, 400, 409}:
        raise RuntimeError(f"Could not prepare Juice Shop smoke user. Status: {status}")
    print(f"Smoke user fixture status: {status}")


def wait_for_login_success(page, timeout_ms=15000):
    started = time.time()
    profile_selectors = [
        "[aria-label='Go to user profile']",
        "a[aria-label='Go to user profile']",
        "button[aria-label='Go to user profile']",
        "#navbarUser",
        "button[id='navbarUser']",
        ".mat-mdc-menu-panel #navbarUser",
        ".mat-menu-panel #navbarUser",
    ]

    while (time.time() - started) * 1000 < timeout_ms:
        if "login" not in page.url.lower():
            return True

        click_if_present(page, "#navbarAccount")
        click_if_present(page, "button[aria-label='Show/hide account menu']")

        if first_visible_selector(page, profile_selectors):
            return True

        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        page.wait_for_timeout(500)

    return False


def open_profile_page(page, base_url):
    profile_selectors = [
        ".cdk-overlay-container [aria-label='Go to user profile']",
        ".mat-mdc-menu-panel [aria-label='Go to user profile']",
        ".mat-menu-panel [aria-label='Go to user profile']",
        ".cdk-overlay-container #navbarUser",
        ".mat-mdc-menu-panel #navbarUser",
        ".mat-menu-panel #navbarUser",
        "[aria-label='Go to user profile']",
        "a[aria-label='Go to user profile']",
        "button[aria-label='Go to user profile']",
        "#navbarUser",
        "button[id='navbarUser']",
    ]

    if not wait_for_any_visible_selector(page, profile_selectors, timeout_ms=1000):
        account_opened = False
        for selector in [
            "#navbarAccount",
            "button[aria-label='Show/hide account menu']",
            "button[aria-label*='Account']",
        ]:
            if click_if_present(page, selector):
                account_opened = True
                break
        if account_opened:
            wait_for_any_visible_selector(page, profile_selectors, timeout_ms=5000)

    if first_visible_selector(page, profile_selectors):
        try:
            click_required(page, profile_selectors, "profile menu item")
        except Exception:
            pass
        else:
            try:
                wait_for_url_contains(page, "profile", timeout_ms=5000)
                return
            except Exception:
                pass

    for candidate in (f"{base_url}/#/profile", f"{base_url}/profile"):
        try:
            page.goto(candidate, wait_until="domcontentloaded")
            wait_for_url_contains(page, "profile", timeout_ms=5000)
            return
        except Exception:
            pass

    raise RuntimeError("Could not open Juice Shop profile page")


def exercise_jwt_cookie_surface(page, base_url):
    result = page.evaluate(
        """
        async (baseUrl) => {
            const root = String(baseUrl || "").replace(/\\/$/, "");
            const responses = await Promise.all([
                fetch(`${root}/rest/user/whoami`, { credentials: "include" }).catch(error => ({ error: error.message })),
                fetch(`${root}/profile`, { credentials: "include" }).catch(error => ({ error: error.message }))
            ]);
            return { ok: true, statuses: responses.map(response => response.status || 0) };
        }
        """,
        base_url,
    )
    print(f"JWT cookie surface exercised: {result}")


def go_home(page, base_url):
    selectors = [
        "button[aria-label='Back to homepage']",
        "button:has-text('OWASP Juice Shop')",
        "a[href='./#/']",
        "a[href='#/']",
        "a[href='/#/']",
        "a:has-text('Back')",
        "a[aria-label='OWASP Juice Shop Logo']",
        "a img[alt='OWASP Juice Shop Logo']",
    ]

    deadline = time.time() + 10
    last_error = None
    while time.time() < deadline:
        selector = first_visible_selector(page, selectors)
        if selector:
            target = page.locator(selector).first
            if selector == "a img[alt='OWASP Juice Shop Logo']":
                target = target.locator("xpath=ancestor::a[1]")
            try:
                target.click(timeout=5000, force=True)
                wait_for_url_contains(page, "#/", timeout_ms=15000)
                page.wait_for_selector(".mat-grid-tile", timeout=15000)
                return
            except Exception as err:
                last_error = err
        page.wait_for_timeout(500)

    # Juice Shop occasionally renders the profile page before the navigation
    # header is interactive. Fall back to direct navigation so the scan flow
    # can continue instead of failing on a stale UI affordance.
    page.goto(f"{base_url}/#/", wait_until="domcontentloaded")
    page.wait_for_selector(".mat-grid-tile", timeout=15000)


def add_products_to_basket(page, count=3):
    add_buttons = page.locator("button[aria-label='Add to Basket']")
    button_count = add_buttons.count()
    if button_count < count:
        raise RuntimeError(
            f"Expected at least {count} add-to-basket buttons, found {button_count}"
        )
    for idx in range(count):
        add_buttons.nth(idx).click(timeout=10000, force=True)
        page.wait_for_timeout(200)


def open_basket_page(page, base_url):
    click_required(
        page,
        [
            "button[aria-label='Show the shopping cart']",
            "button:has-text('Your Basket')",
        ],
        "basket button",
    )
    try:
        wait_for_url_contains(page, "basket", timeout_ms=5000)
    except Exception:
        page.goto(f"{base_url}/#/basket", wait_until="domcontentloaded")
        wait_for_url_contains(page, "basket", timeout_ms=15000)
    page.wait_for_selector("app-purchase-basket mat-row, app-purchase-basket mat-table", timeout=15000)


def clear_basket(page, base_url):
    open_basket_page(page, base_url)
    for _ in range(40):
        removed = page.evaluate(
            """
            () => {
                const trashIcon = document.querySelector(
                    "app-purchase-basket svg[data-icon='trash-alt'], app-purchase-basket i.fa-trash-alt"
                );
                if (!trashIcon) return false;
                const button = trashIcon.closest("button");
                if (!button) return false;
                button.click();
                return true;
            }
            """
        )
        if not removed:
            break
        page.wait_for_timeout(250)

    go_home(page, base_url)


def remove_one_item_from_basket(page):
    for _ in range(30):
        candidates = [
            page.locator("app-purchase-basket button[aria-label='Remove from Basket']").first,
            page.locator("app-purchase-basket mat-row").first.locator("button").last,
            page.locator("app-purchase-basket .cdk-column-remove button").first,
            page.locator("app-purchase-basket mat-cell.cdk-column-remove button").first,
            page.locator("app-purchase-basket mat-row mat-cell:nth-of-type(5) button").first,
        ]
        for locator in candidates:
            try:
                if locator.count() > 0 and locator.is_visible():
                    locator.click(timeout=5000, force=True)
                    page.wait_for_timeout(500)
                    return
            except Exception:
                continue
        page.wait_for_timeout(500)

    raise RuntimeError("Could not locate remove item button in basket")


def test_juice_shop_search():
    base_url = os.getenv("JUICE_SHOP_URL", "http://localhost:3001")
    clean_state = _truthy_env("PTK_CLEAN_STATE", default="1")
    min_scan_seconds = float(os.getenv("PTK_MIN_SCAN_SECONDS", "30"))
    idle_stable_seconds = float(os.getenv("PTK_IDLE_STABLE_SECONDS", "12"))
    progress_poll_seconds = float(os.getenv("PTK_PROGRESS_POLL_SECONDS", "2"))
    rulepack_mode = os.getenv("PTK_RULEPACK_MODE", "FREE").upper()
    login_email = os.getenv("PTK_LOGIN_EMAIL", "YOUR_USERNAME")
    login_password = os.getenv("PTK_LOGIN_PASSWORD", "YOUR_PASSWORD")
    search_term = os.getenv("PTK_SEARCH_TERM", "test")
    require_findings = _truthy_env("PTK_REQUIRE_FINDINGS", default="1")
    findings_limit = int(os.getenv("PTK_FINDINGS_LIMIT", "500"))

    config = PTKPlaywrightConfig.from_env()
    config.engines = diagnostic_smoke_engines(["DAST", "IAST", "SAST", "SCA"])
    started_at = iso_now()
    write_browser_launch_artifact(config, base_url)
    write_framework_run_artifact(config, base_url, started_at, "started")

    with ptk_session(config, target_url=None) as (page, ptk):
        arm_result = arm_iast_for_navigation(
            page,
            f"{base_url}/",
            scan_options={
                "engines": config.engines,
                "policyCode": config.policy_code,
            },
            extension_path=config.extension_path,
            timeout=config.ready_timeout,
        )
        if "IAST" in [str(value).upper() for value in config.engines] and not arm_result.get("ok"):
            raise RuntimeError(f"PTK IAST pre-navigation arm failed: {arm_result}")
        print("PTK IAST pre-navigation arm:", arm_result)
        if clean_state:
            clear_site_state(page, base_url)

        page.goto(f"{base_url}/")
        page.set_viewport_size({"width": 1433, "height": 990})
        page.wait_for_selector(".mat-grid-tile, .mat-search_icon-search", timeout=15000)

        bridge_info = ptk.wait_ready(config.ready_timeout)
        print(
            "PTK bridge ready:",
            {
                "version": bridge_info.get("version"),
                "capabilities": bridge_info.get("capabilities", []),
            },
        )

        start_result = ptk.start_session(
            project=config.project,
            engines=config.engines,
            policy_code=config.policy_code,
        )
        scan_started_at = time.time()
        write_json_artifact(
            config,
            "session_start.json",
            {
                "status": "started",
                "startedAt": iso_now(),
                "sessionId": ptk.session_id,
                "response": start_result,
            },
        )
        dismiss_overlays(page)

        ensure_smoke_user(page, base_url, login_email, login_password)
        run_login_flow(page, base_url, login_email, login_password)
        open_profile_page(page, base_url)
        exercise_jwt_cookie_surface(page, base_url)
        go_home(page, base_url)
        clear_basket(page, base_url)
        add_products_to_basket(page, count=3)
        open_basket_page(page, base_url)
        remove_one_item_from_basket(page)
        type_into_search(page, search_term)
        try:
            wait_for_url_contains(page, "search", timeout_ms=5000)
        except Exception:
            page.goto(f"{base_url}/#/search?q={quote(search_term)}", wait_until="domcontentloaded")
            wait_for_url_contains(page, "search", timeout_ms=15000)
        page.wait_for_selector(".mat-grid-tile, .mat-mdc-table, mat-grid-tile", timeout=10000)

        quiescent_progress = wait_for_session_quiescence(
            ptk,
            mode=rulepack_mode,
            engines=config.engines,
            scan_started_at=scan_started_at,
            min_scan_seconds=min_scan_seconds,
            poll_interval=progress_poll_seconds,
            stable_seconds=idle_stable_seconds,
        )
        print(f"Quiescent progress: {summarize_progress(quiescent_progress)}")
        write_json_artifact(config, "progress-summary.json", quiescent_progress)
        engine_gate = evaluate_engine_gate(quiescent_progress, required_engines(config))
        write_json_artifact(config, "engine_gate.json", engine_gate)

        findings_result = ptk.get_findings(limit=findings_limit, timeout=60)
        findings = findings_result.get("findings", [])
        findings_artifact = write_json_artifact(config, "findings.json", findings_result)
        finding_gate = evaluate_required_findings(findings)
        gate_artifact = write_json_artifact(config, "finding_gate.json", finding_gate)
        print_finding_gate(finding_gate)

        print("Ending session (with progress tracking)...")
        print("=" * 50)

        try:
            stop_timeout = int(os.getenv("PTK_STOP_TIMEOUT", "45"))
            stop_started = time.time()
            result = ptk.end_session(
                wait=True,
                poll_interval=2.0,
                max_wait=600,
                stuck_threshold=60,
                on_progress=print_progress,
                timeout=stop_timeout,
                immediate_analysis=config.immediate_analysis,
            )
            write_json_artifact(
                config,
                "scan_stop.json",
                {
                    "requestedImmediateAnalysis": config.immediate_analysis,
                    "stopSucceeded": bool(result.get("ok", True)),
                    "stopResponse": result,
                    "elapsedMs": int((time.time() - stop_started) * 1000),
                },
            )
            write_json_artifact(config, "session_stats.json", result.get("summary", result))

            try:
                coverage_export = ptk.export_scan_payload(
                    engine="ALL",
                    include_bodies=True,
                    include_evidence=False,
                    max_export_bytes=int(os.getenv("PTK_COVERAGE_MAX_EXPORT_BYTES", str(25 * 1024 * 1024))),
                    timeout=int(os.getenv("PTK_COVERAGE_EXPORT_TIMEOUT", "60")),
                )
                coverage_summary = build_coverage_summary(coverage_export, quiescent_progress)
                write_json_artifact(config, "coverage-summary.json", coverage_summary)
            except Exception as coverage_error:
                snapshot = {}
                try:
                    snapshot = ptk.get_analysis_snapshot(timeout=20)
                except Exception:
                    snapshot = {}
                write_json_artifact(
                    config,
                    "coverage-summary.json",
                    build_failed_coverage_summary(str(coverage_error), snapshot, quiescent_progress),
                )

            print("=" * 50)
            print("Session completed!")
            print(f"Summary: {json.dumps(result.get('summary'), indent=2)}")
            assert result.get("ok", True)
            if require_findings and not finding_gate.get("ok"):
                missing = [
                    item["description"]
                    for item in finding_gate.get("requirements", [])
                    if not item.get("ok")
                ]
                raise AssertionError(
                    "Required finding gate failed: "
                    + ", ".join(missing)
                    + f". See {findings_artifact} and {gate_artifact}"
                )
            write_framework_run_artifact(config, base_url, started_at, "passed")

        except PTKTimeoutError as e:
            write_framework_run_artifact(config, base_url, started_at, "failed", str(e))
            print(f"Timeout: {e}")
            raise
        except PTKSessionError as e:
            write_framework_run_artifact(config, base_url, started_at, "failed", str(e))
            print(f"Session error: {e}")
            raise
        except Exception as e:
            write_framework_run_artifact(config, base_url, started_at, "failed", str(e))
            raise


if __name__ == "__main__":
    test_juice_shop_search()
