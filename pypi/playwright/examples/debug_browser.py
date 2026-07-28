#!/usr/bin/env python3
"""
Debug script to diagnose extension loading issues.

This launches Chrome for Testing and waits so you can:
1. Navigate to chrome://version to see the command line
2. Navigate to chrome://extensions to check extension state

Usage:
    PTK_EXTENSION_PATH=/path/to/ptk/extension python debug_browser.py
    PTK_EXTENSION_PATH=/path/to/ptk/extension python debug_browser.py --minimal
"""

import os
import sys
import time
from playwright.sync_api import sync_playwright

PROFILE_DIR = os.environ.get("PTK_PROFILE_DIR", "~/playwright/chromium_profile")
PROFILE_DIR = os.path.expanduser(PROFILE_DIR)

EXTENSION_PATH = os.environ.get("PTK_EXTENSION_PATH")
if not EXTENSION_PATH:
    print("ERROR: PTK_EXTENSION_PATH environment variable is required")
    print("Set it to the path of the unpacked PTK extension directory")
    print("\nExample:")
    print("  PTK_EXTENSION_PATH=/path/to/ptk/extension python debug_browser.py")
    sys.exit(1)

EXTENSION_PATH = os.path.expanduser(EXTENSION_PATH)
if not os.path.exists(EXTENSION_PATH):
    print(f"ERROR: Extension path does not exist: {EXTENSION_PATH}")
    sys.exit(1)

print(f"Using profile: {PROFILE_DIR}")

# These are the args we pass - let's test with minimal args first
MINIMAL_ARGS = [
    "--no-first-run",
    f"--load-extension={EXTENSION_PATH}",
    f"--disable-extensions-except={EXTENSION_PATH}",
]

# Full args from our launcher
FULL_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions-file-access-check",
    "--disable-features=TranslateUI",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
    "--log-level=3",
    "--use-mock-keychain",
    "--password-store=basic",
    # Extension loading - REQUIRED for Playwright
    f"--load-extension={EXTENSION_PATH}",
    f"--disable-extensions-except={EXTENSION_PATH}",
]

def test_launch(args_name: str, args: list):
    print(f"\n{'='*60}")
    print(f"Testing with {args_name}")
    print(f"{'='*60}")
    print(f"Args: {args}")

    pw = sync_playwright().start()

    try:
        print(f"\nLaunching browser...")
        print(f"Executable: {pw.chromium.executable_path}")

        context = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=args,
            viewport={"width": 1280, "height": 720},
            # CRITICAL: Playwright adds --disable-extensions by default!
            ignore_default_args=["--disable-extensions"],
        )

        page = context.pages[0] if context.pages else context.new_page()

        # Navigate to chrome://version
        print("\nNavigating to chrome://version...")
        page.goto("chrome://version")
        time.sleep(1)

        # Try to get command line
        try:
            cmd_line = page.locator("#command_line").text_content()
            print(f"\nActual Command Line:\n{cmd_line}")
        except Exception as e:
            print(f"Could not get command line: {e}")

        print("\n" + "="*60)
        print("Browser is open. Please check:")
        print("1. chrome://version - see command line")
        print("2. chrome://extensions - check if extensions are visible")
        print("3. Try loading an unpacked extension")
        print("="*60)
        print("\nPress Enter to close browser...")
        input()

        context.close()

    finally:
        pw.stop()

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--minimal":
        test_launch("MINIMAL_ARGS", MINIMAL_ARGS)
    else:
        test_launch("FULL_ARGS", FULL_ARGS)

    print("\nDone!")
