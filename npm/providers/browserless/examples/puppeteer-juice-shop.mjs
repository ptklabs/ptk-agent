import { withPtkScan } from "pentestkit/puppeteer";
import { connectBrowserlessPuppeteer } from "pentestkit/providers/browserless";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectBrowserlessPuppeteer();
try {
  cloud.page.setDefaultNavigationTimeout(90000);
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.page,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-browserless-puppeteer",
    resultsDir: ".runs/browserless/puppeteer",
    navigate: (url) => cloud.page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }),
    currentUrl: () => cloud.page.url()
  });
  printPtkProviderExampleSummary(summary);
} finally {
  await cloud.close();
}
