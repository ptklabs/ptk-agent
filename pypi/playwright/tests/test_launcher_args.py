import unittest
from tempfile import TemporaryDirectory

from ptk_playwright.config import PTKPlaywrightConfig
from ptk_playwright.launcher import _build_chromium_args


class ChromiumLauncherArgsTests(unittest.TestCase):
    def test_disable_features_is_emitted_once(self):
        with TemporaryDirectory() as extension_path:
            args = _build_chromium_args(
                PTKPlaywrightConfig(extension_path=extension_path)
            )
        feature_args = [arg for arg in args if arg.startswith("--disable-features=")]

        self.assertEqual(
            feature_args,
            ["--disable-features=DisableLoadExtensionCommandLineSwitch,TranslateUI"],
        )


if __name__ == "__main__":
    unittest.main()
