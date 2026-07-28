import os
import time
from typing import Optional

from selenium import webdriver
from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


def _env(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return default


def _truthy_env(*names: str) -> bool:
    return (_env(*names, default="") or "").lower() in {"1", "true", "yes", "on"}


def clear_site_state(driver, base_url: str):
    """Clear auth/session state for the target site."""
    driver.get(f"{base_url}/")
    driver.delete_all_cookies()

    # Clear storage tokens that can keep the user logged in.
    try:
        driver.execute_script("window.localStorage.clear();")
        driver.execute_script("window.sessionStorage.clear();")
    except Exception:
        pass

    # Chromium best effort: clear browser-level cache/cookies too.
    try:
        driver.execute_cdp_cmd("Network.clearBrowserCookies", {})
        driver.execute_cdp_cmd("Network.clearBrowserCache", {})
    except Exception:
        pass


def build_driver():
    """Create a plain Selenium driver (no PTK SDK / no PTK automation calls)."""
    browser = (_env("PTK_BROWSER", "SELENIUM_BROWSER", default="chrome") or "chrome").lower()
    headless = _truthy_env("PTK_HEADLESS", "SELENIUM_HEADLESS")
    profile_dir = _env("PTK_PROFILE_DIR", "SELENIUM_PROFILE_DIR")
    profile_name = _env("PTK_PROFILE_NAME", "SELENIUM_PROFILE_NAME", default="Default")

    if browser == "chrome":
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument("--headless=new")
        if profile_dir:
            options.add_argument(f"--user-data-dir={os.path.expanduser(profile_dir)}")
        if profile_name:
            options.add_argument(f"--profile-directory={profile_name}")
        if binary := _env("PTK_CHROME_BINARY", "SELENIUM_CHROME_BINARY"):
            options.binary_location = os.path.expanduser(binary)
        return webdriver.Chrome(options=options)

    if browser == "edge":
        options = webdriver.EdgeOptions()
        if headless:
            options.add_argument("--headless=new")
        if profile_dir:
            options.add_argument(f"--user-data-dir={os.path.expanduser(profile_dir)}")
        if profile_name:
            options.add_argument(f"--profile-directory={profile_name}")
        if binary := _env("PTK_EDGE_BINARY", "SELENIUM_EDGE_BINARY"):
            options.binary_location = os.path.expanduser(binary)
        return webdriver.Edge(options=options)

    if browser == "firefox":
        options = webdriver.FirefoxOptions()
        if headless:
            options.add_argument("-headless")
        if profile_dir:
            options.add_argument("-profile")
            options.add_argument(os.path.expanduser(profile_dir))
            options.add_argument("-no-remote")
        if binary := _env("PTK_FIREFOX_BINARY", "SELENIUM_FIREFOX_BINARY"):
            options.binary_location = os.path.expanduser(binary)
        return webdriver.Firefox(options=options)

    raise ValueError(
        f"Unsupported PTK_BROWSER/SELENIUM_BROWSER='{browser}'. "
        "Use chrome, edge, or firefox."
    )


def test_juice_shop_search_selenium_only():
    base_url = os.getenv("JUICE_SHOP_URL", "http://localhost:3001")
    hold_seconds = float(os.getenv("SELENIUM_HOLD_SECONDS", "0"))
    wait_timeout = int(os.getenv("SELENIUM_WAIT_TIMEOUT", "15"))
    clean_state = (
        (_env("PTK_CLEAN_STATE", "SELENIUM_CLEAN_STATE", default="1") or "").lower()
        in {"1", "true", "yes", "on"}
    )

    driver = build_driver()
    driver.set_window_size(1433, 990)
    wait = WebDriverWait(driver, wait_timeout)

    try:
        if clean_state:
            clear_site_state(driver, base_url)

        driver.get(f"{base_url}/")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".mat-search_icon-search"))
        )

        def dismiss_overlays():
            try:
                driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
            except Exception:
                pass
            try:
                backdrop = driver.find_element(
                    By.CSS_SELECTOR,
                    ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
                )
                backdrop.click()
            except Exception:
                pass

        def safe_click(selector, attempts=3):
            for _ in range(attempts):
                try:
                    wait.until(
                        EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
                    ).click()
                    return
                except ElementClickInterceptedException:
                    dismiss_overlays()
                    try:
                        wait.until(
                            EC.invisibility_of_element_located(
                                (
                                    By.CSS_SELECTOR,
                                    ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
                                )
                            )
                        )
                    except TimeoutException:
                        pass
            elem = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, selector)))
            driver.execute_script("arguments[0].click();", elem)

        safe_click("#navbarAccount > .mdc-button__label > span")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".mat-mdc-menu-panel"))
        )
        safe_click("#navbarLoginButton")

        login_email = os.getenv("PTK_LOGIN_EMAIL", "YOUR_USERNAME")
        login_password = os.getenv("PTK_LOGIN_PASSWORD", "YOUR_PASSWORD")
        wait.until(EC.element_to_be_clickable((By.ID, "email"))).send_keys(login_email)
        wait.until(EC.element_to_be_clickable((By.ID, "password"))).send_keys(login_password)
        safe_click("#loginButton")

        safe_click("#navbarAccount > .mdc-button__label > span")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".mat-mdc-menu-panel"))
        )
        safe_click(".mat-mdc-menu-panel .mat-mdc-menu-item")
        safe_click(".mdl-layout-title")

        safe_click(".mat-grid-tile:nth-child(2) .mdc-button__label > span")
        safe_click(".mat-grid-tile:nth-child(3) .mdc-button__label > span")

        safe_click(".ng-star-inserted > .mdc-button__label > .hide-lt-md")
        safe_click(
            ".mat-mdc-row:nth-child(2) > .mat-mdc-cell:nth-child(5) "
            ".mat-mdc-button-touch-target"
        )

        safe_click(".mat-search_icon-search")
        search_input = wait.until(EC.element_to_be_clickable((By.ID, "mat-input-1")))
        search_input.click()
        search_input.send_keys("test")
        search_input.send_keys(Keys.ENTER)

        if hold_seconds > 0:
            print(f"Holding browser open for {hold_seconds:.1f}s (SELENIUM_HOLD_SECONDS)")
            time.sleep(hold_seconds)

    except Exception:
        screenshot = f"juice_shop_selenium_only_failure_{int(time.time())}.png"
        try:
            driver.save_screenshot(screenshot)
            print(f"Saved failure screenshot: {screenshot}")
        except Exception:
            pass
        raise
    finally:
        driver.quit()


if __name__ == "__main__":
    test_juice_shop_search_selenium_only()
