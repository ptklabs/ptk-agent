import os
import tempfile

from playwright.sync_api import sync_playwright
from ptk_playwright import with_ptk_scan


target_url = os.getenv("JUICE_SHOP_URL", "http://127.0.0.1:3000")
extension_path = os.getenv("PTK_EXTENSION_PATH") or os.getenv("PTK_EXTENSION_DIR")
if not extension_path:
    raise RuntimeError("Set PTK_EXTENSION_PATH to the unpacked PTK extension directory.")

profile_dir = os.getenv("PTK_PROFILE_DIR") or tempfile.mkdtemp(prefix="ptk-playwright-")


def search_for_test(page, **_):
    page.goto(target_url)
    page.get_by_role("button", name="Search").click()
    page.locator(
        "input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input"
    ).first.fill("test")
    page.keyboard.press("Enter")


with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        profile_dir,
        headless=False,
        args=[
            f"--disable-extensions-except={extension_path}",
            f"--load-extension={extension_path}",
        ],
    )
    page = context.pages[0] if context.pages else context.new_page()
    try:
        with_ptk_scan(
            page,
            project="juice-shop-playwright-example",
            engines=["DAST", "IAST", "SAST"],
            results_dir="./ptk-results",
            run_journey=search_for_test,
        )
    finally:
        context.close()
