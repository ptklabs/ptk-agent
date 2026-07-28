#!/usr/bin/env node
'use strict';

const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { ensureUnpackedPtkExtension } = require('pentestkit/extensions');
const { withPtkScan } = require('pentestkit/selenium');

async function main() {
  const targetUrl = process.env.JUICE_SHOP_URL || 'http://127.0.0.1:3000';
  const extensionPath = ensureUnpackedPtkExtension().path;

  const options = new chrome.Options()
    .addArguments(`--disable-extensions-except=${extensionPath}`)
    .addArguments(`--load-extension=${extensionPath}`);

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  try {
    await driver.get(targetUrl);
    await withPtkScan(driver, {
      project: 'juice-shop-selenium-example',
      engines: ['DAST', 'IAST', 'SAST'],
      resultsDir: './ptk-results'
    }, async ({ driver }) => {
      const searchButton = await driver.findElements(By.css("button[aria-label='Search'], .mat-search_icon-search"));
      if (searchButton[0]) await searchButton[0].click();
      const searchInputs = await driver.findElements(By.css("input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input"));
      if (!searchInputs[0]) throw new Error('Search input was not found');
      await searchInputs[0].sendKeys('test', Key.ENTER);
    });
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
