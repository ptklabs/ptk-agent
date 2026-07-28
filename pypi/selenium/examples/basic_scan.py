import json

from ptk_selenium import PTKConfig, PTKExportError, ptk_session
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


def test_basic_scan():
    # Requires a pre-configured profile with PTK installed and Automation enabled.
    config = PTKConfig.from_env()
    with ptk_session(config, target_url="https://demo.testfire.net") as (driver, ptk):
        # Go directly to the login page to avoid landing page differences.


        driver.get("https://demo.testfire.net/login.jsp")
        wait = WebDriverWait(driver, 15)
        wait.until(EC.presence_of_element_located((By.ID, "uid"))).send_keys("admin")
        driver.find_element(By.ID, "passw").send_keys("admin")
        driver.find_element(By.NAME, "btnSubmit").click()

        summary = ptk.end_session()
        print("PTK summary:", summary)
        stats = summary.get("stats", {})
        print("PTK findings:", stats.get("vulnsCount", stats.get("findingsCount", 0)))
        print("PTK findings detail:", summary.get("findings", []))
        assert summary.get("ok", True)
        assert summary.get("status") == "completed"

        try:
            export = ptk.export_scan_payload(engine="ALL")
            print(f"Exported {len(export.get('scans', []))} engine(s)")
            print(f"Any truncated: {export.get('truncatedAny')}")
            if export.get("warnings"):
                print(f"Warnings: {export.get('warnings')}")

            for scan_info in export.get("scans", []):
                engine = scan_info.get("engine")
                size = scan_info.get("estimatedBytes")
                trunc = scan_info.get("truncated")
                print(f"  - {engine}: {size} bytes, truncated={trunc}")

            with open("scan_export_full.json", "w") as f:
                json.dump(export.get("scans"), f, indent=2)

            with open("scan_export_raw.json", "w") as f:
                json.dump([s["scan"] for s in export.get("scans", [])], f, indent=2)

            dast_scan = ptk.get_scan(export, "DAST")
            if dast_scan:
                findings_count = dast_scan.get("stats", {}).get("findingsCount", 0)
                print(f"DAST findings: {findings_count}")
        except PTKExportError as e:
            print(f"Export failed: {e.code} - {e}")
            if e.warnings:
                print(f"Warnings: {e.warnings}")


if __name__ == "__main__":
    test_basic_scan()
