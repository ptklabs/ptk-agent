import base64
import json
import unittest

from ptk_playwright.driver import PTKPlaywrightDriver


class ChunkedDriver(PTKPlaywrightDriver):
    def __init__(self, report):
        super().__init__(page=object())
        self._bridge_info = {
            "capabilities": [
                "exportScan",
                "exportScanChunk",
                "releaseExportScan",
            ]
        }
        encoded = json.dumps(report).encode("utf-8")
        split = max(1, len(encoded) // 2)
        self.chunks = [encoded[:split], encoded[split:]]
        self.released = []

    def _execute_async(self, script, payload, timeout=None):
        if "exportScanChunk" in script:
            index = payload["index"]
            return {
                "ok": True,
                "exportId": payload["exportId"],
                "index": index,
                "chunkCount": len(self.chunks),
                "chunkBase64": base64.b64encode(self.chunks[index]).decode("ascii"),
            }
        if "releaseExportScan" in script:
            self.released.append(payload["exportId"])
            return {"ok": True}
        return {
            "ok": True,
            "scans": [{
                "engine": "ALL",
                "exportMode": "chunked",
                "exportId": "export-1",
                "chunkCount": len(self.chunks),
                "size": sum(len(chunk) for chunk in self.chunks),
                "compression": None,
            }],
            "warnings": [],
        }


class ChunkedEvidenceExportTests(unittest.TestCase):
    def test_public_chunks_are_materialized_as_per_engine_scans(self):
        report = {
            "schemaVersion": "ptklabs-full-redacted-export-v1",
            "export": {
                "engineParts": {
                    "DAST": {"requests": [{"url": "http://localhost:3001/api/test"}]},
                    "IAST": {"requests": []},
                }
            },
        }
        driver = ChunkedDriver(report)

        result = driver.export_scan_payload(session_id="session-1")

        self.assertTrue(result["ok"])
        self.assertEqual([scan["engine"] for scan in result["scans"]], ["DAST", "IAST"])
        self.assertEqual(result["scans"][0]["scan"]["requests"][0]["url"], "http://localhost:3001/api/test")
        self.assertEqual(driver.released, ["export-1"])


if __name__ == "__main__":
    unittest.main()
