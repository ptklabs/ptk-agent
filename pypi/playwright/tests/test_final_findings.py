import unittest

from ptk_playwright.driver import PTKPlaywrightDriver


class FinalFindingsDriver(PTKPlaywrightDriver):
    def __init__(self):
        super().__init__(page=object())
        self._last_session_id = "completed-session"
        self.payload = None

    def _execute_async(self, script, payload, timeout=None):
        self.payload = payload
        return {
            "ok": True,
            "findings": [{"id": "final-finding"}],
            "truncated": False,
        }


class FinalFindingsTests(unittest.TestCase):
    def test_completed_session_findings_remain_retrievable(self):
        driver = FinalFindingsDriver()

        result = driver.get_findings(limit=250)

        self.assertEqual(result["findings"], [{"id": "final-finding"}])
        self.assertEqual(driver.payload, {
            "limit": 250,
            "sessionId": "completed-session",
        })


if __name__ == "__main__":
    unittest.main()
