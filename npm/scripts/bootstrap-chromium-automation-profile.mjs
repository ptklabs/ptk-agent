#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import process from "process";
import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const SOURCE_EXTENSION_DIR = path.resolve(PACKAGE_ROOT, "..", "..", "dist", "ptk_extension_unpacked_automation");
const PACKAGE_EXTENSION_DIR = path.resolve(PACKAGE_ROOT, "extensions", "chromium-unpacked");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveExtensionDir() {
  let resolved = null;
  if (process.env.PTK_EXTENSION_PATH) {
    resolved = path.resolve(process.env.PTK_EXTENSION_PATH);
  } else if (await exists(PACKAGE_EXTENSION_DIR)) {
    resolved = PACKAGE_EXTENSION_DIR;
  } else if (await exists(SOURCE_EXTENSION_DIR)) {
    resolved = SOURCE_EXTENSION_DIR;
  }
  if (!resolved) {
    throw new Error(
      "PTK_EXTENSION_PATH is required; no packaged extension or source-tree extension was found"
    );
  }
  return fs.realpath(resolved);
}

const PROFILE_DIR = path.resolve(
  process.env.PTK_PROFILE_DIR || path.join(process.cwd(), "tmp", "ptk-chromium-profile")
);
const BROWSER = String(process.env.PTK_BROWSER || "chromium").trim().toLowerCase();
const ARTIFACTS_DIR = process.env.PTK_ARTIFACTS_DIR
  ? path.resolve(process.env.PTK_ARTIFACTS_DIR)
  : null;
const TIMEOUT_MS = Number.isFinite(Number(process.env.PTK_TIMEOUT_MS))
  ? Math.max(5000, Number(process.env.PTK_TIMEOUT_MS))
  : 30000;

function browserChannelFor(name) {
  if (name === "edge") return "msedge";
  if (name === "chrome") return "chrome";
  return undefined;
}

function isHeadlessRequested() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PTK_HEADLESS || ""));
}

async function writeJsonArtifact(name, payload) {
  if (!ARTIFACTS_DIR) return null;
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const outPath = path.join(ARTIFACTS_DIR, name);
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outPath;
}

async function waitForServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers()[0] || null;
  if (existing) return existing;
  return Promise.race([
    context.waitForEvent("serviceworker"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("serviceworker_timeout")), timeoutMs)
    ),
  ]);
}

function extractExtensionId(worker) {
  return String(worker?.url?.().split("/")[2] || "").trim();
}

async function readAutomationStateFromWorker(worker, timeoutMs = 10000) {
  return Promise.race([
    worker.evaluate(async () => {
      if (!self.ptk_app) {
        throw new Error("ptk_app_missing");
      }
      await self.ptk_app.ready;
      const stored = await browser.storage.local.get("pentestkit8_settings");
      return {
        appAutomationEnabled: self.ptk_app?.settings?.automation?.enable === true,
        storedAutomationEnabled: stored?.pentestkit8_settings?.automation?.enable === true,
      };
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("worker_automation_timeout")), timeoutMs)
    ),
  ]);
}

async function verifySettingsPage(context, extensionId) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/ptk/browser/settings.html`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });
    await page.waitForSelector("#settings_save", { timeout: 15000 });
    await page.locator("a.item[forItem='automation_form']").click({
      force: true,
      timeout: 10000,
    });
    await page.waitForSelector("#automation_form", {
      state: "visible",
      timeout: 15000,
    });
    return {
      uiChecked: await page.locator("#automation_form input[name='enable']").isChecked(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const extensionDir = await resolveExtensionDir();
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--enable-unsafe-extension-debugging",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--use-mock-keychain",
    "--password-store=basic",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];

  const launchOptions = {
    userDataDir: PROFILE_DIR,
    headless: isHeadlessRequested() ? false : false,
    timeout: TIMEOUT_MS,
    ignoreDefaultArgs: ["--disable-extensions"],
    args,
  };

  const channel = browserChannelFor(BROWSER);
  if (channel) launchOptions.channel = channel;

  const browserLaunch = {
    browserName: BROWSER,
    browserVersion: null,
    executablePath: null,
    headless: launchOptions.headless,
    extensionPath: extensionDir,
    profileMode: "persistent-context",
    profileDir: PROFILE_DIR,
    launchArgs: args,
  };

  console.log(`[ptk-profile] browser=${BROWSER}`);
  console.log(`[ptk-profile] profile=${PROFILE_DIR}`);
  console.log(`[ptk-profile] extension=${extensionDir}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  try {
    browserLaunch.browserVersion = context.browser()?.version?.() || null;
    browserLaunch.executablePath = context.browser()?.browserType?.().executablePath?.() || null;
    await writeJsonArtifact("browser-launch.json", browserLaunch);

    const worker = await waitForServiceWorker(context, TIMEOUT_MS);
    const extensionId = extractExtensionId(worker);
    if (!extensionId) throw new Error("extension_id_missing");

    const workerState = await readAutomationStateFromWorker(worker, TIMEOUT_MS);
    const pageState = await verifySettingsPage(context, extensionId);
    const result = {
      ok:
        workerState.appAutomationEnabled === true &&
        workerState.storedAutomationEnabled === true,
      browser: BROWSER,
      profileDir: PROFILE_DIR,
      extensionDir,
      extensionId,
      ...workerState,
      ...pageState,
    };
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[ptk-profile] FAIL", error?.stack || String(error));
  process.exit(1);
});
