import json
import os
import time
from pathlib import Path

from ptk_selenium import PTKConfig, PTKSessionError, PTKTimeoutError, ptk_session
from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

def _env(*names, default=None):
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return default


def _truthy_env(*names, default=""):
    value = _env(*names, default=default) or ""
    return value.lower() in {"1", "true", "yes", "on"}


def _safe_artifact_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in value)


def write_json_artifact(config: PTKConfig, name: str, payload: dict):
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


def finding_engine(finding: dict) -> str:
    if not isinstance(finding, dict):
        return ""
    metadata = finding.get("metadata") if isinstance(finding.get("metadata"), dict) else {}
    aggregate = (
        finding.get("presentationAggregate")
        if isinstance(finding.get("presentationAggregate"), dict)
        else {}
    )
    for candidate in [
        finding.get("engine"),
        finding.get("engineId"),
        finding.get("engine_id"),
        metadata.get("engine"),
        aggregate.get("engine"),
    ]:
        normalized = str(candidate or "").strip().upper()
        if normalized.startswith("PTK_"):
            normalized = normalized[4:]
        if normalized in {"DAST", "IAST", "SAST", "SCA"}:
            return normalized
    return ""


def evaluate_required_findings(findings) -> dict:
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
        engine = finding_engine(finding)

        if engine == "DAST" and ("sql" in lower or "sqli" in lower) and (
            "login" in lower or "/rest/user/login" in lower or "rest/user/login" in lower
        ):
            matched["dast_sql_login"].append(label)

        if engine == "DAST" and "jwt" in lower and "none" in lower and "cookie" in lower:
            matched["dast_jwt_none_cookie"].append(label)

        if engine == "DAST" and "jwt" in lower and "none" in lower and (
            "authorization" in lower or "authz" in lower or "bearer" in lower
        ):
            matched["dast_jwt_none_authorization"].append(label)

        if engine == "DAST" and (("spa" in lower and "dom" in lower and "xss" in lower) or (
            "spa hash" in lower and "xss" in lower
        )):
            matched["dast_spa_dom_xss"].append(label)

        if engine == "IAST" and (
            "dom xss via element.innerhtml" in lower
            or ("element.innerhtml" in lower and "dom xss" in lower)
            or ("dom.innerhtml" in lower and "iast" in lower)
        ):
            matched["iast_innerhtml"].append(label)

        if engine == "SAST" and (
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


def required_engines(config: PTKConfig):
    return [str(engine).strip().upper() for engine in (config.engines or []) if str(engine).strip()]


def evaluate_engine_gate(progress: dict, engines) -> dict:
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


def write_browser_launch_artifact(config: PTKConfig, base_url: str):
    write_json_artifact(
        config,
        "browser-launch.json",
        {
            "browserName": config.browser,
            "browserVersion": None,
            "executablePath": (
                config.chrome_binary
                if config.browser.lower() == "chrome"
                else config.edge_binary
                if config.browser.lower() == "edge"
                else config.firefox_binary
            ),
            "headless": bool(config.headless),
            "extensionPath": (
                config.extension_xpi_path
                if config.browser.lower() == "firefox"
                else config.extension_path
            ),
            "profileMode": "firefox-profile" if config.browser.lower() == "firefox" else "preinstalled-profile",
            "profileDir": config.profile_dir,
            "launchArgs": [],
            "targetUrl": base_url,
        },
    )


def write_framework_run_artifact(
    config: PTKConfig,
    base_url: str,
    started_at: str,
    status: str,
    failure_reason=None,
):
    write_json_artifact(
        config,
        "framework-run.json",
        {
            "framework": "selenium",
            "browser": config.browser,
            "mode": os.getenv("PTK_RELEASE_TEST_MODE", "source"),
            "packageRoot": os.getenv("PTK_PACKAGE_ROOT"),
            "sdkRoot": str(Path(__file__).resolve().parents[1]),
            "extensionPath": config.extension_xpi_path if config.browser.lower() == "firefox" else None,
            "targetUrl": base_url,
            "profileDir": config.profile_dir,
            "artifactsDir": config.artifacts_dir,
            "startedAt": started_at,
            "endedAt": iso_now() if status != "started" else None,
            "status": status,
            "failureReason": failure_reason,
        },
    )


def summarize_progress(progress: dict) -> str:
    engines = progress.get("engines", {}) or {}
    parts = []
    for name, eng in engines.items():
        status = eng.get("status", "?")
        running = "running" if eng.get("isRunning") else "idle"
        phase = eng.get("phase")
        done = eng.get("progress", {}).get("done")
        total = eng.get("progress", {}).get("total")
        remaining = eng.get("progress", {}).get("remaining", eng.get("remaining"))
        findings = eng.get("findingsCount", 0)
        part = f"{name}:{status}:{running}"
        if phase:
            part += f":{phase}"
        part += f":{done if done is not None else '?'}/{total if total is not None else '?'}"
        if remaining is not None:
            part += f":remaining={remaining}"
        part += f":findings={findings}"
        parts.append(part)
    return " | ".join(parts)


def get_required_findings_max_wait_seconds() -> float:
    raw = _env("PTK_REQUIRED_FINDINGS_TIMEOUT", "PTK_MAX_SCAN_SECONDS")
    if raw:
        try:
            return max(60.0, float(raw))
        except Exception:
            pass
    return 300.0


def wait_for_required_finding_gate(
    ptk,
    scan_started_at: float,
    min_scan_seconds: float,
    findings_limit: int,
):
    floor_deadline = scan_started_at + max(15.0, float(min_scan_seconds))
    hard_deadline = scan_started_at + get_required_findings_max_wait_seconds()
    last_progress_summary = None
    last_missing = None
    latest_payload = {"findings": [], "truncated": False}
    latest_gate = evaluate_required_findings([])

    while time.time() < hard_deadline:
        try:
            progress = ptk.get_session_progress(timeout=10)
            summary = summarize_progress(progress)
            if summary and summary != last_progress_summary:
                print(f"[finding-gate] {summary}")
                last_progress_summary = summary
        except Exception as err:
            print(f"[finding-gate] progress unavailable: {err}")

        if time.time() >= floor_deadline:
            latest_payload = ptk.get_findings(limit=findings_limit, timeout=60)
            latest_gate = evaluate_required_findings(latest_payload.get("findings", []))
            missing = [
                item["description"]
                for item in latest_gate.get("requirements", [])
                if not item.get("ok")
            ]
            if not missing:
                return latest_payload, latest_gate
            missing_key = ", ".join(missing)
            if missing_key != last_missing:
                print(f"[finding-gate] waiting for: {missing_key}")
                last_missing = missing_key

        time.sleep(5)

    return latest_payload, latest_gate


def ensure_bridge_automation_ready(driver, config: PTKConfig):
    timeout = max(5, int(os.getenv("PTK_AUTOMATION_BOOTSTRAP_TIMEOUT_MS", str(config.ready_timeout * 1000))) // 1000)
    deadline = time.time() + timeout
    last_result = None

    script = """
    const callback = arguments[arguments.length - 1];
    const bridge = window.PTK_AUTOMATION;
    if (!bridge) {
        callback({ ok: false, error: 'bridge_not_found' });
        return;
    }

    Promise.resolve(typeof bridge.ping === 'function' ? bridge.ping() : {})
        .then(async (before) => {
            if (before && before.ok) {
                callback({ ok: true, reason: 'already_enabled', ping: before });
                return;
            }

            if (before && before.error === 'automation_disabled' && typeof bridge.requestActivation === 'function') {
                const activation = await bridge.requestActivation({ reason: 'selenium_sdk_smoke' });
                const after = typeof bridge.ping === 'function' ? await bridge.ping() : {};
                callback({
                    ok: !!(after && after.ok),
                    error: after && after.error,
                    reason: activation && activation.reason,
                    activation,
                    before,
                    ping: after,
                });
                return;
            }

            callback({ ok: false, error: (before && before.error) || 'bridge_not_ready', before, ping: before });
        })
        .catch((error) => callback({ ok: false, error: error && error.message ? error.message : String(error) }));
    """

    while time.time() < deadline:
        try:
            driver.set_script_timeout(10)
            last_result = driver.execute_async_script(script)
            if last_result and last_result.get("ok"):
                ping = last_result.get("ping") or {}
                print(
                    "PTK Chromium automation enabled:",
                    {
                        "reason": last_result.get("reason"),
                        "version": ping.get("version"),
                        "automationEnabled": ping.get("automationEnabled"),
                    },
                )
                return
        except Exception as err:
            last_result = {"ok": False, "error": str(err)}
        time.sleep(0.5)

    raise RuntimeError(
        "PTK automation bridge was not ready. The smoke test expects an "
        f"automation-enabled extension artifact: {last_result}"
    )


def clear_site_state(driver, base_url: str):
    driver.get(f"{base_url}/")
    driver.delete_all_cookies()

    try:
        driver.execute_script("window.localStorage.clear();")
        driver.execute_script("window.sessionStorage.clear();")
    except Exception:
        pass

    try:
        driver.execute_cdp_cmd("Network.clearBrowserCookies", {})
        driver.execute_cdp_cmd("Network.clearBrowserCache", {})
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


def first_visible_selector(driver, selectors):
    for selector in selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
        except Exception:
            continue

        for element in elements:
            try:
                if element.is_displayed():
                    return selector
            except Exception:
                continue
    return None


def click_if_present(driver, selector):
    try:
        elements = driver.find_elements(By.CSS_SELECTOR, selector)
        for element in elements:
            if element.is_displayed():
                element.click()
                return True
    except Exception:
        pass
    return False


def dismiss_overlays(driver):
    for selector in [
        ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
        "button[aria-label='Close Welcome Banner']",
        "a.cc-btn.cc-dismiss",
        "button[aria-label='Close Dialog']",
    ]:
        click_if_present(driver, selector)

    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    except Exception:
        pass


def click_required(driver, wait, selectors, label):
    selector = first_visible_selector(driver, selectors)
    if not selector:
        raise RuntimeError(f"Could not locate {label}. Tried: {selectors}")

    last_error = None
    for _ in range(3):
        try:
            wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, selector))).click()
            return
        except (ElementClickInterceptedException, TimeoutException) as err:
            last_error = err
            dismiss_overlays(driver)
            time.sleep(0.4)

    element = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, selector)))
    try:
        driver.execute_script("arguments[0].click();", element)
    except Exception:
        raise RuntimeError(f"Failed to click {label}: {last_error}")


def type_required(driver, wait, selectors, value, label):
    selector = first_visible_selector(driver, selectors)
    if not selector:
        raise RuntimeError(f"Could not locate {label}. Tried: {selectors}")

    field = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, selector)))
    field.click()
    field.clear()
    field.send_keys(value)


def type_into_search(driver, wait, text):
    click_if_present(driver, ".mat-search_icon-search")
    click_if_present(driver, "#searchQuery")

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
        elements = driver.find_elements(By.CSS_SELECTOR, selector)
        if not elements:
            continue

        field = elements[0]
        try:
            try:
                field = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, selector)))
            except Exception:
                pass

            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", field)
            except Exception:
                pass

            try:
                field.click()
            except Exception:
                driver.execute_script("arguments[0].focus();", field)
            try:
                field.clear()
            except Exception:
                pass

            try:
                field.send_keys(text)
                field.send_keys(Keys.ENTER)
            except Exception:
                driver.execute_script(
                    """
                    const el = arguments[0];
                    const value = arguments[1];
                    el.focus();
                    el.value = "";
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.value = value;
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                    const opts = { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true };
                    el.dispatchEvent(new KeyboardEvent("keydown", opts));
                    el.dispatchEvent(new KeyboardEvent("keypress", opts));
                    el.dispatchEvent(new KeyboardEvent("keyup", opts));
                    """,
                    field,
                    text,
                )
            return
        except Exception as err:
            last_error = err
            click_if_present(driver, ".mat-search_icon-search")
            click_if_present(driver, "#searchQuery")
            time.sleep(0.3)

    if last_error:
        raise RuntimeError(f"Could not type into search input: {last_error}")
    raise RuntimeError("Could not locate a search input element")


def run_login_flow(driver, wait, email, password, base_url=None):
    if base_url:
        driver.get(f"{base_url}/#/login")
    else:
        click_required(
            driver,
            wait,
            [
                "#navbarAccount",
                "button[aria-label='Show/hide account menu']",
                "#navbarAccount > .mdc-button__label > span",
                "button[aria-label*='Account']",
            ],
            "account menu button",
        )

        wait.until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, ".mat-mdc-menu-panel, .mat-menu-panel, #navbarLoginButton")
            )
        )

        click_required(
            driver,
            wait,
            [
                "#navbarLoginButton",
                "button[aria-label='Go to login page']",
                ".mat-mdc-menu-panel #navbarLoginButton",
                ".mat-menu-panel #navbarLoginButton",
            ],
            "login menu item",
        )

    wait.until(lambda d: "login" in d.current_url)

    type_required(
        driver,
        wait,
        ["#email", "input#emailControl", "input[formcontrolname='email']", "input[type='email']"],
        email,
        "email input",
    )

    type_required(
        driver,
        wait,
        ["#password", "input#passwordControl", "input[formcontrolname='password']", "input[type='password']"],
        password,
        "password input",
    )

    click_required(
        driver,
        wait,
        ["#loginButton", "button#loginButton", "button[type='submit']"],
        "login submit button",
    )
    wait.until(lambda d: "login" not in d.current_url.lower())


def open_profile_page(driver, wait, base_url=None):
    if base_url:
        driver.get(f"{base_url}/#/profile")
    else:
        click_required(
            driver,
            wait,
            [
                "#navbarAccount",
                "button[aria-label='Show/hide account menu']",
                "#navbarAccount > .mdc-button__label > span",
                "button[aria-label*='Account']",
            ],
            "account menu button",
        )
        click_required(
            driver,
            wait,
            [
                "button[aria-label='Go to user profile']",
                "#navbarUser",
                "button[id='navbarUser']",
                ".mat-mdc-menu-panel #navbarUser",
                ".mat-menu-panel #navbarUser",
            ],
            "profile menu item",
        )
    wait.until(lambda d: "profile" in d.current_url.lower())


def exercise_jwt_cookie_surface(driver, base_url):
    result = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const baseUrl = arguments[0].replace(/\\/$/, "");
        Promise.all([
            fetch(`${baseUrl}/rest/user/whoami`, { credentials: "include" }).catch(e => ({ error: e.message })),
            fetch(`${baseUrl}/profile`, { credentials: "include" }).catch(e => ({ error: e.message }))
        ])
            .then(responses => done({ ok: true, statuses: responses.map(r => r.status || 0) }))
            .catch(error => done({ ok: false, error: error.message || String(error) }));
        """,
        base_url,
    )
    print(f"JWT cookie surface exercised: {result}")


def go_home(driver, wait, base_url):
    driver.get(f"{base_url}/#/")
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".mat-grid-tile")))


def add_products_to_basket(driver, wait, count=3):
    wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR, "button[aria-label='Add to Basket']")))
    buttons = [b for b in driver.find_elements(By.CSS_SELECTOR, "button[aria-label='Add to Basket']") if b.is_displayed()]
    if len(buttons) < count:
        raise RuntimeError(f"Expected at least {count} add-to-basket buttons, found {len(buttons)}")

    for idx in range(count):
        button = buttons[idx]
        try:
            button.click()
        except Exception:
            driver.execute_script("arguments[0].click();", button)
        time.sleep(0.2)


def open_basket_page(driver, wait, base_url):
    driver.get(f"{base_url}/#/basket")
    wait.until(
        EC.presence_of_element_located((By.CSS_SELECTOR, "app-purchase-basket mat-row, app-purchase-basket mat-table"))
    )


def clear_basket(driver, wait, base_url):
    open_basket_page(driver, wait, base_url)
    for _ in range(40):
        removed = driver.execute_script(
            """
            const trashIcon = document.querySelector("app-purchase-basket svg[data-icon='trash-alt'], app-purchase-basket i.fa-trash-alt");
            if (!trashIcon) return false;
            const button = trashIcon.closest("button");
            if (!button) return false;
            button.click();
            return true;
            """
        )
        if not removed:
            break
        time.sleep(0.25)

    go_home(driver, wait, base_url)


def remove_one_item_from_basket(driver, wait):
    for _ in range(30):
        clicked_selector = driver.execute_script(
            """
            const trashIcon = document.querySelector("app-purchase-basket svg[data-icon='trash-alt'], app-purchase-basket i.fa-trash-alt");
            if (trashIcon) {
              const button = trashIcon.closest("button");
              if (button) {
                button.click();
                return "app-purchase-basket svg[data-icon='trash-alt']";
              }
            }

            const selectors = [
              "app-purchase-basket .cdk-column-remove button",
              "app-purchase-basket mat-cell.cdk-column-remove button",
              "app-purchase-basket mat-row mat-cell:nth-of-type(5) button",
              "app-purchase-basket button[aria-label='Remove from Basket']",
            ];
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (el) {
                el.click();
                return selector;
              }
            }
            const firstRow = document.querySelector("app-purchase-basket mat-row");
            if (firstRow) {
              const buttons = firstRow.querySelectorAll("button");
              if (buttons.length > 0) {
                buttons[buttons.length - 1].click();
                return "app-purchase-basket mat-row:last-button";
              }
            }
            return null;
            """
        )
        if clicked_selector:
            time.sleep(0.5)
            return
        time.sleep(0.5)

    raise RuntimeError("Could not locate remove item button in basket")


def test_juice_shop_search():
    base_url = os.getenv("JUICE_SHOP_URL", "http://localhost:3001")
    clean_state = _truthy_env("PTK_CLEAN_STATE", default="1")
    min_scan_seconds = float(os.getenv("PTK_MIN_SCAN_SECONDS", "30"))
    login_email = os.getenv("PTK_LOGIN_EMAIL", "YOUR_USERNAME")
    login_password = os.getenv("PTK_LOGIN_PASSWORD", "YOUR_PASSWORD")
    search_term = os.getenv("PTK_SEARCH_TERM", "test")
    require_findings = _truthy_env("PTK_REQUIRE_FINDINGS", default="1")
    findings_limit = int(os.getenv("PTK_FINDINGS_LIMIT", "500"))

    config = PTKConfig.from_env()
    config.engines = ["DAST", "IAST", "SAST", "SCA"]
    started_at = iso_now()
    write_browser_launch_artifact(config, base_url)
    write_framework_run_artifact(config, base_url, started_at, "started")

    with ptk_session(config, target_url=None) as (driver, ptk):
        if clean_state:
            clear_site_state(driver, base_url)

        driver.get(f"{base_url}/")
        driver.set_window_size(1433, 990)

        wait = WebDriverWait(driver, 15)
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".mat-grid-tile, .mat-search_icon-search"))
        )

        ensure_bridge_automation_ready(driver, config)

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

        dismiss_overlays(driver)

        run_login_flow(driver, wait, login_email, login_password, base_url)
        open_profile_page(driver, wait, base_url)
        exercise_jwt_cookie_surface(driver, base_url)
        go_home(driver, wait, base_url)
        clear_basket(driver, wait, base_url)
        add_products_to_basket(driver, wait, count=3)
        open_basket_page(driver, wait, base_url)
        remove_one_item_from_basket(driver, wait)
        type_into_search(driver, wait, search_term)
        wait.until(lambda d: "search" in d.current_url.lower())

        elapsed = time.time() - scan_started_at
        if elapsed < min_scan_seconds:
            remaining = min_scan_seconds - elapsed
            print(
                f"Keeping scan session open for {remaining:.1f}s "
                f"(min window: {min_scan_seconds:.0f}s)"
            )
            time.sleep(remaining)

        print("Ending session (with progress tracking)...")
        print("=" * 50)

        if require_findings:
            findings_payload, finding_gate = wait_for_required_finding_gate(
                ptk,
                scan_started_at=scan_started_at,
                min_scan_seconds=min_scan_seconds,
                findings_limit=findings_limit,
            )
        else:
            findings_payload = ptk.get_findings(limit=findings_limit, timeout=60)
            finding_gate = evaluate_required_findings(findings_payload.get("findings", []))
        write_json_artifact(config, "findings.json", findings_payload)
        write_json_artifact(config, "finding_gate.json", finding_gate)
        print_finding_gate(finding_gate)
        try:
            progress_summary = ptk.get_session_progress(timeout=10)
        except Exception as err:
            progress_summary = {"ok": False, "error": str(err), "engines": {}}
        write_json_artifact(config, "progress-summary.json", progress_summary)
        engine_gate = evaluate_engine_gate(progress_summary, required_engines(config))
        write_json_artifact(config, "engine_gate.json", engine_gate)

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

            print("=" * 50)
            print("Session completed!")
            print(f"Summary: {json.dumps(result.get('summary'), indent=2)}")
            assert result.get("ok", True)
            if require_findings and not finding_gate.get("ok"):
                raise AssertionError("Required Juice Shop findings were not all observed")
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
