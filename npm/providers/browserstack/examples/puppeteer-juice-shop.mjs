import { withPtkScan } from "pentestkit/puppeteer";
import {
  connectBrowserStackPuppeteer,
  setBrowserStackSessionStatus
} from "pentestkit/providers/browserstack";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectBrowserStackPuppeteer();
try {
  cloud.page.setDefaultNavigationTimeout(90000);
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.page,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-browserstack-puppeteer",
    resultsDir: ".runs/browserstack/puppeteer",
    navigate: (url) => cloud.page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }),
    currentUrl: () => cloud.page.url()
  });
  await setBrowserStackSessionStatus(cloud.page, "passed", "PTK four-engine scan completed").catch(() => {});
  printPtkProviderExampleSummary(summary);
} catch (error) {
  await setBrowserStackSessionStatus(cloud.page, "failed", error.message || String(error)).catch(() => {});
  throw error;
} finally {
  await cloud.close();
}
