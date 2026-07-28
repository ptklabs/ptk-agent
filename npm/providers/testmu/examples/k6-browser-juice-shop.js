import { chromium } from "k6/experimental/browser";

const configuredTarget = __ENV.PTK_PROVIDER_TARGET_URL || __ENV.JUICE_SHOP_URL;
if (!configuredTarget) {
  throw new Error("Set PTK_PROVIDER_TARGET_URL (or JUICE_SHOP_URL) to an explicitly approved target.");
}
const TARGET_URL = configuredTarget.replace(/\/$/, "");
const REQUIRED_ENGINES = ["DAST", "SAST", "IAST", "SCA"];

const capabilities = {
  browserName: "Chrome",
  browserVersion: "latest",
  "LT:Options": {
    platform: "MacOS Ventura",
    build: "PTK k6 Browser Build",
    name: "PTK Juice Shop k6 Browser",
    user: `${__ENV.LT_USERNAME}`,
    accessKey: `${__ENV.LT_ACCESS_KEY}`,
    network: true,
    video: true,
    console: true,
    tunnel: false,
    tunnelName: "",
    geoLocation: ""
  }
};

export default async function () {
  const wsURL = `wss://cdp.lambdatest.com/k6?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`;
  const browser = chromium.connect(wsURL);
  const page = browser.newPage();
  let ptkStarted = false;

  try {
    await page.goto(`${TARGET_URL}/`);
    const preflight = await page.evaluate(() => {
      return window.PTK_AGENT?.preflight?.() || { ready: false, blockers: ["ptk_agent_unavailable"] };
    });
    if (!preflight.ready) {
      throw new Error(`PTK bridge is not ready: ${JSON.stringify(preflight.blockers || [])}`);
    }

    const start = await page.evaluate((engines) => {
      return window.PTK_AGENT.startScan({
        project: "juice-shop-testmu-k6-browser",
        engines
      });
    }, REQUIRED_ENGINES);
    if (!start || start.ok !== true) {
      throw new Error(`PTK start failed: ${JSON.stringify(start)}`);
    }
    ptkStarted = true;

    await page.goto(`${TARGET_URL}/#/search?q=test`);
    if (new URL(page.url()).origin !== new URL(TARGET_URL).origin) {
      throw new Error(`PTK k6 example refused out-of-scope navigation to ${page.url()}`);
    }

    const deadline = Date.now() + Number(__ENV.PTK_PROVIDER_ENGINE_TIMEOUT_MS || 45000);
    let progress = null;
    let missing = REQUIRED_ENGINES.slice();
    do {
      progress = await page.evaluate(() => window.PTK_AGENT.getSessionProgress());
      const observed = Object.keys((progress && progress.engines) || {}).map((name) => name.toUpperCase());
      missing = REQUIRED_ENGINES.filter((name) => !observed.includes(name));
      if (!missing.length) break;
      await page.waitForTimeout(1000);
    } while (Date.now() < deadline);
    if (missing.length) {
      throw new Error(`PTK engines did not all participate: ${missing.join(", ")}`);
    }

    const findings = await page.evaluate(() => window.PTK_AGENT.getFindings({ limit: 500 }));
    await page.evaluate(() => window.PTK_AGENT.exportScan());
    const count = findings && Array.isArray(findings.findings) ? findings.findings.length : 0;
    console.log(`PTK findings: ${count}`);
  } finally {
    if (ptkStarted) {
      await page.evaluate(() => window.PTK_AGENT.stopScan({ wait: true }));
    }
    page.close();
    browser.close();
  }
}
