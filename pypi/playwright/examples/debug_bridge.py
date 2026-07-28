#!/usr/bin/env python3
"""
Debug script to check PTK bridge availability.

This navigates to a page and checks if window.PTK_AUTOMATION is available.
"""

import os
import sys
import time
from playwright.sync_api import sync_playwright

PROFILE_DIR = os.environ.get("PTK_PROFILE_DIR", "~/playwright/chromium_profile")
PROFILE_DIR = os.path.expanduser(PROFILE_DIR)

EXTENSION_PATH = os.environ.get("PTK_EXTENSION_PATH")
if not EXTENSION_PATH:
    print("ERROR: PTK_EXTENSION_PATH is required")
    sys.exit(1)
EXTENSION_PATH = os.path.expanduser(EXTENSION_PATH)

TARGET_URL = os.environ.get("TARGET_URL", "http://localhost:3001")

print(f"Profile: {PROFILE_DIR}")
print(f"Extension: {EXTENSION_PATH}")
print(f"Target URL: {TARGET_URL}")

args = [
    "--no-first-run",
    "--no-default-browser-check",
    f"--load-extension={EXTENSION_PATH}",
    f"--disable-extensions-except={EXTENSION_PATH}",
]

with sync_playwright() as pw:
    print(f"\nLaunching browser...")
    print(f"Executable: {pw.chromium.executable_path}")

    context = pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=False,
        args=args,
        viewport={"width": 1280, "height": 720},
        ignore_default_args=["--disable-extensions"],
    )

    page = context.pages[0] if context.pages else context.new_page()

    print(f"\nNavigating to {TARGET_URL}...")
    page.goto(TARGET_URL)
    page.wait_for_load_state("domcontentloaded")

    print("\nWaiting 3 seconds for extension to initialize...")
    time.sleep(3)

    # Check what's available on window
    print("\n--- Checking window.PTK_AUTOMATION ---")

    # Simple check
    try:
        result = page.evaluate("() => typeof window.PTK_AUTOMATION")
        print(f"typeof window.PTK_AUTOMATION = {result}")
    except Exception as e:
        print(f"Error checking PTK_AUTOMATION type: {e}")

    # Check if it exists
    try:
        result = page.evaluate("() => !!window.PTK_AUTOMATION")
        print(f"window.PTK_AUTOMATION exists = {result}")
    except Exception as e:
        print(f"Error checking PTK_AUTOMATION exists: {e}")

    # List all PTK* globals
    try:
        result = page.evaluate("""
        () => {
            const ptkGlobals = [];
            for (const key in window) {
                if (key.startsWith('PTK') || key.toLowerCase().includes('ptk')) {
                    ptkGlobals.push(key);
                }
            }
            return ptkGlobals;
        }
        """)
        print(f"PTK-related window properties: {result}")
    except Exception as e:
        print(f"Error listing PTK globals: {e}")

    # Try to ping
    try:
        result = page.evaluate("""
        () => {
            if (!window.PTK_AUTOMATION) {
                return { error: 'not_found' };
            }
            if (typeof window.PTK_AUTOMATION.ping !== 'function') {
                return {
                    error: 'no_ping',
                    keys: Object.keys(window.PTK_AUTOMATION)
                };
            }
            return window.PTK_AUTOMATION.ping();
        }
        """)
        print(f"PTK ping result: {result}")
    except Exception as e:
        print(f"Error pinging PTK: {e}")

    print("\n" + "="*60)
    print("Browser is open. Check the console (F12) for errors.")
    print("Also check chrome://extensions to verify PTK is loaded.")
    print("="*60)
    print("\nPress Enter to close...")
    input()

    context.close()
