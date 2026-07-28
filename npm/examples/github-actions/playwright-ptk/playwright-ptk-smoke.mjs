import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ensureUnpackedPtkExtension } from "pentestkit/extensions";
import { withPtkScan } from "pentestkit/playwright";

const targetUrl = process.env.PTK_TARGET_URL || "http://localhost:3000";
const extensionPath = ensureUnpackedPtkExtension().path;
const profileDir = process.env.PTK_PROFILE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "ptk-playwright-"));

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});

const page = context.pages()[0] || await context.newPage();

try {
  await page.goto(targetUrl);
  await withPtkScan(page, {
    project: "github-actions-playwright",
    engines: ["DAST", "IAST"],
    resultsDir: ".ptk/results/playwright",
    stop: { wait: true }
  }, async ({ page }) => {
    await page.locator("body").waitFor({ timeout: 30000 });
  });
} finally {
  await context.close();
}
