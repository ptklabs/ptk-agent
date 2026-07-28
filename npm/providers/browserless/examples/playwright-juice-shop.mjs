import { withPtkScan } from "pentestkit/playwright";
import { connectBrowserlessPlaywright } from "pentestkit/providers/browserless";
import {
  printPtkProviderExampleSummary,
  runPtkProviderExample
} from "../../_shared/examples/run-ptk-example.mjs";

const cloud = await connectBrowserlessPlaywright();
try {
  const summary = await runPtkProviderExample({
    withPtkScan,
    scanTarget: cloud.page,
    targetUrl: process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL,
    project: "juice-shop-browserless-playwright",
    resultsDir: ".runs/browserless/playwright",
    navigate: (url) => cloud.page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }),
    currentUrl: () => cloud.page.url()
  });
  printPtkProviderExampleSummary(summary);
} finally {
  await cloud.close();
}
