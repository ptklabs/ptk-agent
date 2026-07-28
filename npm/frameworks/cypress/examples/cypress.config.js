const fs = require("fs");
const http = require("http");
const path = require("path");
const { defineConfig } = require("cypress");
const packageRoot = process.env.PTK_PACKAGE_ROOT;
const { setupPtkCypress } = process.env.PTK_RELEASE_TEST_MODE === "package" && packageRoot
  ? require(path.join(packageRoot, "frameworks", "cypress", "index.cjs"))
  : require("..");

const EXAMPLES_DIR = __dirname;
const CYPRESS_ROOT = path.resolve(EXAMPLES_DIR, "..");

module.exports = defineConfig({
  e2e: {
    baseUrl: "http://localhost:3001",
    // Keep a single AUT context across tests for one long PTK scan session.
    testIsolation: false,
    screenshotOnRunFailure: false,
    specPattern: [
      path.join(EXAMPLES_DIR, "**/*.cy.{js,jsx,ts,tsx}"),
      path.join(CYPRESS_ROOT, "smoke/**/*.cy.{js,jsx,ts,tsx}"),
    ],
    supportFile: path.join(EXAMPLES_DIR, "support/e2e.js"),
    setupNodeEvents(on, config) {
      function artifactsDir() {
        return (
          process.env.PTK_ARTIFACTS_DIR ||
          config.env.PTK_ARTIFACTS_DIR ||
          ".ptk/artifacts/cypress-juice-shop"
        );
      }

      function writeJsonArtifact(fileName, payload) {
        const safeName = String(fileName || "artifact.json").replace(/[^a-zA-Z0-9_.-]/g, "_");
        const outPath = path.resolve(artifactsDir(), safeName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
        return outPath;
      }

      const artifactServer = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method !== "POST" || req.url !== "/artifact") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }

        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 50 * 1024 * 1024) {
            req.destroy(new Error("artifact payload too large"));
          }
        });
        req.on("error", (error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body || "{}");
            const outPath = writeJsonArtifact(payload.fileName, payload.payload);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: outPath }));
          } catch (error) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
      });
      const artifactPort = Number(process.env.PTK_CYPRESS_ARTIFACT_PORT) || 45300 + (process.pid % 1000);
      artifactServer.listen(artifactPort, "127.0.0.1");
      config.env.PTK_ARTIFACTS_ENDPOINT = `http://127.0.0.1:${artifactPort}/artifact`;
      on("after:run", () => {
        artifactServer.close();
      });

      on("task", {
        ptkWriteJsonArtifact({ fileName, payload }) {
          return writeJsonArtifact(fileName, payload);
        },
      });
      on("after:spec", (_spec, results) => {
        const filePath = path.resolve(artifactsDir(), "framework-run.json");
        if (!fs.existsSync(filePath)) return;

        let current = {};
        try {
          current = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (_) {
          current = {};
        }

        if (current.status === "passed") return;

        const failures = Number(results && results.stats && results.stats.failures) || 0;
        if (failures <= 0) return;

        const firstError = (results.tests || [])
          .flatMap((test) => test.attempts || [])
          .map((attempt) => attempt.error && attempt.error.message)
          .find(Boolean);
        writeJsonArtifact("framework-run.json", {
          ...current,
          framework: current.framework || "cypress",
          browser: current.browser || "unknown",
          targetUrl: current.targetUrl || config.baseUrl || null,
          artifactsDir: current.artifactsDir || artifactsDir(),
          endedAt: new Date().toISOString(),
          status: "failed",
          failureReason: firstError || "cypress_spec_failed",
        });
      });
      setupPtkCypress(on, config);
      return config;
    },
  },
  env: {
    // Optional extension source override. The PTK plugin creates the Cypress run-local copy.
    PTK_EXTENSION_PATH: process.env.PTK_EXTENSION_PATH || "",
    // Profile mode (Firefox only): preconfigured profile with PTK + automation enabled
    PTK_PROFILE_DIR: process.env.PTK_PROFILE_DIR || "",
    // PTK session options (read by cy.ptkStartSession)
    PTK_PROJECT: process.env.PTK_PROJECT || "juice-shop",
    PTK_ENGINES: process.env.PTK_ENGINES || "DAST,IAST,SAST,SCA",
    PTK_ARTIFACTS_DIR: process.env.PTK_ARTIFACTS_DIR || ".ptk/artifacts/cypress-juice-shop",
    PTK_POLICY_CODE: process.env.PTK_POLICY_CODE || "",
    PTK_IMMEDIATE_ANALYSIS: process.env.PTK_IMMEDIATE_ANALYSIS || "",
    PTK_MIN_SCAN_SECONDS: process.env.PTK_MIN_SCAN_SECONDS || "30",
    PTK_FINDINGS_LIMIT: process.env.PTK_FINDINGS_LIMIT || "500",
    PTK_LOGIN_EMAIL: process.env.PTK_LOGIN_EMAIL || process.env.PTK_JUICE_USERNAME || "",
    PTK_LOGIN_PASSWORD: process.env.PTK_LOGIN_PASSWORD || process.env.PTK_JUICE_PASSWORD || "",
    PTK_SEARCH_TERM: process.env.PTK_SEARCH_TERM || "test",
    PTK_RELEASE_TEST_MODE: process.env.PTK_RELEASE_TEST_MODE || "source",
    PTK_CYPRESS_COMPAT_MODE: process.env.PTK_CYPRESS_COMPAT_MODE || "strict",
  },
});
