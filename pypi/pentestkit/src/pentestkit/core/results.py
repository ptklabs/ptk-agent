import json
import time
from pathlib import Path

from .redact import redact


def count_findings(payload) -> int:
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for key in ("findings", "items", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return len(value)
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("findings"), list):
            return len(data["findings"])
    return 0


def wait_for_findings(bridge, timeout: float = 0, poll_interval: float = 1.0, limit: int = 500):
    deadline = time.time() + float(timeout or 0)
    last = None
    while True:
        last = bridge.get_findings(limit=limit)
        if count_findings(last) > 0 or not timeout or time.time() >= deadline:
            return last
        time.sleep(poll_interval)


def collect_ptk_results(bridge, session=None, findings_limit: int = 500, findings_timeout: float = 0):
    session_id = None
    if isinstance(session, dict):
        session_id = session.get("sessionId")
    session_id = session_id or bridge.session_id
    return {
        "progress": bridge.get_session_progress(sessionId=session_id),
        "findings": wait_for_findings(
            bridge,
            timeout=findings_timeout,
            limit=findings_limit,
        ),
        "stats": bridge.get_stats(sessionId=session_id),
    }


def write_json_artifact(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(redact(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return str(target)


def write_if_present(results_dir, name, value):
    if value is None:
        return None
    return write_json_artifact(Path(results_dir) / name, value)


def write_ptk_results(result, results_dir):
    if not results_dir:
        return []
    written = []

    def write(name, value):
        path = write_if_present(results_dir, name, value)
        if path:
            written.append(path)

    before_stop = result.get("beforeStop") or {}
    after_stop = result.get("afterStop") or {}
    write("session_start.json", result.get("session"))
    write("progress_before_stop.json", before_stop.get("progress"))
    write("findings_before_stop.json", before_stop.get("findings"))
    write("stats_before_stop.json", before_stop.get("stats"))
    write("scan_stop.json", result.get("stop"))
    write("progress_after_stop.json", after_stop.get("progress"))
    write("findings_after_stop.json", after_stop.get("findings"))
    write("stats_after_stop.json", after_stop.get("stats"))
    write("ptk-result.json", {**result, "artifacts": None})
    return written
