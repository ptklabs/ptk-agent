import { withPtkScan } from "pentestkit/selenium";
import { connectBrowserbaseSelenium } from "pentestkit/providers/browserbase";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectBrowserbaseSelenium();
try {
  await cloud.driver.manage().setTimeouts({ pageLoad: 90000 }).catch(() => {});
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.driver,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-browserbase-selenium",
    resultsDir: ".runs/browserbase/selenium",
    navigate: (url) => cloud.driver.get(url),
    currentUrl: () => cloud.driver.getCurrentUrl()
  });
  printPtkProviderExampleSummary(summary);
} finally {
  await cloud.close();
}
