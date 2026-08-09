import importlib.util
import unittest
from pathlib import Path


SMOKE_PATH = Path(__file__).resolve().parents[1] / "smoke" / "juice_shop_scan.py"
SPEC = importlib.util.spec_from_file_location("ptk_playwright_juice_shop_smoke", SMOKE_PATH)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class SmokeFindingGateTests(unittest.TestCase):
    def test_sast_text_cannot_satisfy_dast_spa_requirement(self):
        gate = SMOKE.evaluate_required_findings([
            {
                "engine": "SAST",
                "ruleId": "no-appendchild",
                "ruleName": "Review uses of appendChild",
                "source": "SPA DOM XSS fixture text that must not satisfy DAST",
            }
        ])

        requirement = next(
            item for item in gate["requirements"] if item["key"] == "dast_spa_dom_xss"
        )
        self.assertEqual(requirement["count"], 0)

    def test_authoritative_ptk_engine_identity_is_normalized(self):
        gate = SMOKE.evaluate_required_findings([
            {
                "engine": "PTK_DAST",
                "ruleId": "spa_dom_xss_default",
                "ruleName": "SPA hash DOM XSS",
            }
        ])

        requirement = next(
            item for item in gate["requirements"] if item["key"] == "dast_spa_dom_xss"
        )
        self.assertEqual(requirement["count"], 1)

    def test_missing_engine_identity_is_not_inferred_from_text(self):
        gate = SMOKE.evaluate_required_findings([
            {
                "ruleId": "dom_innerhtml_xss",
                "ruleName": "DOM XSS via Element.innerHTML",
            }
        ])

        requirement = next(
            item for item in gate["requirements"] if item["key"] == "iast_innerhtml"
        )
        self.assertEqual(requirement["count"], 0)


if __name__ == "__main__":
    unittest.main()
