import os
import tempfile

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from ptk_selenium import with_ptk_scan


target_url = os.getenv("JUICE_SHOP_URL", "http://127.0.0.1:3000")
extension_path = os.getenv("PTK_EXTENSION_PATH") or os.getenv("PTK_EXTENSION_DIR")
if not extension_path:
    raise RuntimeError("Set PTK_EXTENSION_PATH to the unpacked PTK extension directory.")

profile_dir = os.getenv("PTK_PROFILE_DIR") or tempfile.mkdtemp(prefix="ptk-selenium-")

options = webdriver.ChromeOptions()
options.add_argument(f"--user-data-dir={profile_dir}")
options.add_argument(f"--disable-extensions-except={extension_path}")
options.add_argument(f"--load-extension={extension_path}")


def search_for_test(driver, **_):
    driver.get(target_url)
    buttons = driver.find_elements(By.CSS_SELECTOR, "button[aria-label='Search'], .mat-search_icon-search")
    if buttons:
        buttons[0].click()
    inputs = driver.find_elements(
        By.CSS_SELECTOR,
        "input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input",
    )
    if not inputs:
        raise RuntimeError("Search input was not found")
    inputs[0].send_keys("test", Keys.ENTER)


driver = webdriver.Chrome(options=options)
try:
    with_ptk_scan(
        driver,
        project="juice-shop-selenium-example",
        engines=["DAST", "IAST", "SAST"],
        results_dir="./ptk-results",
        run_journey=search_for_test,
    )
finally:
    driver.quit()
