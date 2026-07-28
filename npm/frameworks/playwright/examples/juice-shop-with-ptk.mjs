import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUnpackedPtkExtension } from "pentestkit/extensions";
import { withPtkScan } from "pentestkit/playwright";

const targetUrl = process.env.JUICE_SHOP_URL || "http://127.0.0.1:3000";
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
    project: "juice-shop-playwright-example",
    engines: ["DAST", "IAST", "SAST"],
    resultsDir: "./ptk-results"
  }, async ({ page }) => {
    await page.getByRole("button", { name: /search/i }).click().catch(() => page.locator(".mat-search_icon-search").click());
    await page.locator("input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input").first().fill("test");
    await page.keyboard.press("Enter");
  });
} finally {
  await context.close();
}
