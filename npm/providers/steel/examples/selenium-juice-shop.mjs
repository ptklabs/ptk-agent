import { withPtkScan } from "pentestkit/selenium";
import { connectSteelSelenium } from "pentestkit/providers/steel";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectSteelSelenium();
try {
  await cloud.driver.manage().setTimeouts({ pageLoad: 90000 }).catch(() => {});
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.driver,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-steel-selenium",
    resultsDir: ".runs/steel/selenium",
    navigate: (url) => cloud.driver.get(url),
    currentUrl: () => cloud.driver.getCurrentUrl()
  });
  printPtkProviderExampleSummary(summary);
} finally {
  await cloud.close();
}
