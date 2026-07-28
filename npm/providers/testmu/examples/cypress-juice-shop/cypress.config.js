const { defineConfig } = require("cypress");
const { setupPtkCypress } = require("pentestkit/cypress");

const targetUrl = process.env.PTK_PROVIDER_TARGET_URL || process.env.JUICE_SHOP_URL;
if (!targetUrl) {
  throw new Error("Set PTK_PROVIDER_TARGET_URL (or JUICE_SHOP_URL) to an explicitly approved target.");
}

const env = {
  PTK_PROJECT: process.env.PTK_PROJECT || "juice-shop-testmu-cypress",
  PTK_ENGINES: process.env.PTK_ENGINES || "DAST,SAST,IAST,SCA",
  PTK_IMMEDIATE_ANALYSIS: process.env.PTK_IMMEDIATE_ANALYSIS || "",
  PTK_FINDINGS_LIMIT: process.env.PTK_FINDINGS_LIMIT || "500"
};

if (process.env.PTK_CYPRESS_COMPAT_MODE) {
  env.PTK_CYPRESS_COMPAT_MODE = process.env.PTK_CYPRESS_COMPAT_MODE;
}

if (process.env.PTK_EXTENSION_PATH) {
  env.PTK_EXTENSION_PATH = process.env.PTK_EXTENSION_PATH;
}

module.exports = defineConfig({
  e2e: {
    baseUrl: targetUrl,
    testIsolation: false,
    supportFile: "cypress/support/e2e.js",
    specPattern: "cypress/e2e/juice-shop-with-ptk.cy.js",
    setupNodeEvents(on, config) {
      setupPtkCypress(on, config);
      return config;
    }
  },
  env
});
