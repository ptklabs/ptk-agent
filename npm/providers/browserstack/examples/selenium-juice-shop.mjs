import { withPtkScan } from "pentestkit/selenium";
import {
  connectBrowserStackSelenium,
  setBrowserStackSessionStatus
} from "pentestkit/providers/browserstack";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectBrowserStackSelenium();
try {
  await cloud.driver.manage().setTimeouts({ pageLoad: 90000 }).catch(() => {});
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.driver,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-browserstack-selenium",
    resultsDir: ".runs/browserstack/selenium",
    navigate: (url) => cloud.driver.get(url),
    currentUrl: () => cloud.driver.getCurrentUrl()
  });
  await setBrowserStackSessionStatus(cloud.driver, "passed", "PTK four-engine scan completed").catch(() => {});
  printPtkProviderExampleSummary(summary);
} catch (error) {
  await setBrowserStackSessionStatus(cloud.driver, "failed", error.message || String(error)).catch(() => {});
  throw error;
} finally {
  await cloud.close();
}
