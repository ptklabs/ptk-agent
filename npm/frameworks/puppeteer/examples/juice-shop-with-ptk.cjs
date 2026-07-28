#!/usr/bin/env node
'use strict';

const { launchPtkBrowser, withPtkScan } = require('pentestkit/puppeteer');

async function clickSearch(page) {
  const selectors = [
    "button[aria-label='Search']",
    ".mat-search_icon-search",
    "#searchQuery"
  ];
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) {
      await handle.click();
      return;
    }
  }
}

async function main() {
  const targetUrl = process.env.JUICE_SHOP_URL || 'http://127.0.0.1:3000';
  const { browser, page } = await launchPtkBrowser({
    extensionPath: process.env.PTK_EXTENSION_PATH || process.env.PTK_EXTENSION_DIR
  });

  try {
    await page.goto(targetUrl);
    await withPtkScan(page, {
      project: 'juice-shop-puppeteer-example',
      engines: ['DAST', 'IAST', 'SAST'],
      resultsDir: './ptk-results'
    }, async ({ page }) => {
      await clickSearch(page);
      await page.type("input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input", 'test');
      await page.keyboard.press('Enter');
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
