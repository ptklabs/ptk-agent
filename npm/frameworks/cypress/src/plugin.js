"use strict";

const fs = require("fs");
const path = require("path");

const COMPAT_MODE_STRICT = "strict";
const COMPAT_MODE_EXPERIMENTAL = "experimental";
const CHROME_EXTENSION_CUTOFF = 137;

const SUPPORTED_CHROMIUM_NAMES = new Set([
  "chrome-for-testing",
  "chromium",
  "edge",
  "canary",
  "chrome-canary",
  "chrome-beta",
]);

function toLower(value) {
  return String(value || "").toLowerCase();
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function getEnvConfigValue(config, key) {
  const fromEnv = process.env[key];
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }

  const fromConfig = config?.env?.[key];
  if (fromConfig != null && String(fromConfig).trim() !== "") {
    return String(fromConfig).trim();
  }

  return "";
}

function normalizeHttpOrigin(value, label) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("origin must use http or https");
    }
    return parsed.origin;
  } catch (error) {
    throw new Error(
      `[PTK][cypress_allowed_origin_invalid] Invalid ${label || "origin"}: ${raw}. ` +
        "Use absolute http(s) URLs such as https://app.example.test."
    );
  }
}

function parseOriginList(value, label) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => parseOriginList(item, label))
      .filter(Boolean);
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => normalizeHttpOrigin(item, label))
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveCompatMode(config) {
  const fromConfig = toLower(config?.env?.PTK_CYPRESS_COMPAT_MODE);
  const fromEnv = toLower(process.env.PTK_CYPRESS_COMPAT_MODE);
  const raw = fromConfig || fromEnv;
  return raw === COMPAT_MODE_EXPERIMENTAL
    ? COMPAT_MODE_EXPERIMENTAL
    : COMPAT_MODE_STRICT;
}

function normalizeBrowserInfo(browser, config) {
  const browserPath = toLower(browser?.path);
  const forcedChromeForTesting =
    toLower(getEnvConfigValue(config, "PTK_CYPRESS_CHROME_FOR_TESTING")) === "true";
  const isChromeForTestingPath =
    forcedChromeForTesting ||
    browserPath.includes("chrome for testing") ||
    browserPath.includes("chrome-for-testing") ||
    browserPath.includes("chrome_for_testing");
  return {
    name: toLower(browser?.name),
    family: toLower(browser?.family),
    majorVersion: toInt(browser?.majorVersion),
    isHeadless: browser?.isHeadless === true,
    path: browserPath,
    isChromeForTesting: isChromeForTestingPath,
  };
}

function makeResult(status, code, message, recommendation) {
  return {
    status,
    code,
    message,
    recommendation: recommendation || null,
  };
}

function resolveBrowserCompatibility(browser, mode, config) {
  const info = normalizeBrowserInfo(browser, config);
  const isElectron = info.name === "electron" || info.family === "electron";
  if (isElectron) {
    return makeResult(
      "unsupported",
      "browser_electron_unsupported",
      "Electron does not support browser extensions.",
      "Run with: cypress run --browser chrome-for-testing"
    );
  }

  const isBrandedChrome = info.name === "chrome" && !info.isChromeForTesting;
  const isChrome137Plus = isBrandedChrome && info.majorVersion != null && info.majorVersion >= CHROME_EXTENSION_CUTOFF;
  if (isChrome137Plus) {
    return makeResult(
      "unsupported",
      "browser_chrome_137_plus_unsupported",
      "Branded Chrome 137+ does not support extension loading in Cypress.",
      "Use Chrome for Testing or Chromium: cypress run --browser chrome-for-testing"
    );
  }

  if (info.family === "chromium") {
    const knownChromium =
      SUPPORTED_CHROMIUM_NAMES.has(info.name) ||
      info.isChromeForTesting ||
      (info.name === "chrome" && (info.majorVersion == null || info.majorVersion < CHROME_EXTENSION_CUTOFF));
    if (!knownChromium) {
      if (mode === COMPAT_MODE_EXPERIMENTAL) {
        return makeResult(
          "experimental",
          "browser_chromium_unknown",
          `Chromium-family browser "${info.name || "unknown"}" is not in the tested allowlist.`,
          "Proceeding in experimental mode."
        );
      }
      return makeResult(
        "unsupported",
        "browser_chromium_unknown",
        `Chromium-family browser "${info.name || "unknown"}" is not in the tested allowlist.`,
        "Use Chrome for Testing, Chromium, or Edge; or set PTK_CYPRESS_COMPAT_MODE=experimental."
      );
    }

    if (info.isHeadless) {
      if (mode === COMPAT_MODE_EXPERIMENTAL) {
        return makeResult(
          "experimental",
          "mode_headless_chromium_unstable",
          "Chromium headless + extensions is not guaranteed across Cypress/browser versions.",
          "Proceeding in experimental mode; validate bridge availability with cy.ptkWaitReady()."
        );
      }
      return makeResult(
        "unsupported",
        "mode_headless_chromium_unsupported",
        "Chromium headless mode is not supported for reliable extension loading in strict mode.",
        "Use headed mode, Firefox headless, or set PTK_CYPRESS_COMPAT_MODE=experimental."
      );
    }

    return makeResult(
      "supported",
      "browser_chromium_supported",
      "Chromium-family headed mode supports extension loading."
    );
  }

  if (info.family === "firefox" || info.name === "firefox") {
    return makeResult(
      "supported",
      "browser_firefox_supported",
      "Firefox supports extension loading in Cypress."
    );
  }

  if (mode === COMPAT_MODE_EXPERIMENTAL) {
    return makeResult(
      "experimental",
      "browser_unknown_family",
      `Browser family "${info.family || info.name || "unknown"}" is not officially tested.`,
      "Proceeding in experimental mode."
    );
  }

  return makeResult(
    "unsupported",
    "browser_unknown_family",
    `Browser family "${info.family || info.name || "unknown"}" is not supported.`,
    "Use Chrome for Testing, Chromium, Edge, or Firefox."
  );
}

function normalizeDirectoryPath(rawPath, keyName, notFoundHelp) {
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `${keyName} not found at: ${resolved}. ${notFoundHelp || `Check ${keyName}.`}`
    );
  }

  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(
      `${keyName} must point to a directory: ${resolved}`
    );
  }

  return resolved;
}

function isPtkExtensionDir(candidate) {
  if (!candidate) return false;
  try {
    const manifestPath = path.join(candidate, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const serviceWorker = manifest.background && manifest.background.service_worker;
    const appPath = path.join(candidate, serviceWorker || "app.js");
    if (!fs.existsSync(manifestPath) || (!fs.existsSync(appPath) && !fs.existsSync(path.join(candidate, "app.js")) && !fs.existsSync(path.join(candidate, "app_automation.js")))) return false;
    const name = `${manifest.name || ""} ${manifest.short_name || ""}`.toLowerCase();
    return name.includes("penetration testing kit") || name.includes("owasp ptk") || name.includes("ptk") || serviceWorker === "app.js" || serviceWorker === "app_automation.js";
  } catch (_) {
    return false;
  }
}

function findPackageRoot(startDir) {
  let current = path.resolve(startDir || __dirname);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (pkg.name === "pentestkit") return current;
      } catch (_) {
        // Keep walking; source-tree package.json files are not the packaged SDK root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(__dirname, "..", "..", "..");
}

function findBundledExtensionPath(packageRoot) {
  const root = packageRoot || findPackageRoot(__dirname);
  const candidate = path.join(root, "extensions", "chromium-unpacked");
  if (isPtkExtensionDir(candidate)) return candidate;
  const helperPath = path.join(root, "extensions", "index.cjs");
  if (!fs.existsSync(helperPath)) return null;
  try {
    const helpers = require(helperPath);
    const result = helpers.ensureUnpackedPtkExtension({
      packageRoot: root,
      cacheRoot: process.env.PTK_EXTENSION_CACHE_DIR || path.join(process.cwd(), ".ptk")
    });
    return result && isPtkExtensionDir(result.path) ? result.path : null;
  } catch (_) {
    return null;
  }
}

function normalizeExtensionPath(config, required) {
  const extensionPath = getEnvConfigValue(config, "PTK_EXTENSION_PATH");

  if (!extensionPath) {
    const bundled = findBundledExtensionPath();
    if (bundled) return bundled;
    if (required) {
      throw new Error(
        "PTK_EXTENSION_PATH is required. Set it in cypress.env.json, defineConfig({ env }), or environment variables, or install the packaged PTK SDK with bundled extensions."
      );
    }
    return null;
  }

  return normalizeDirectoryPath(
    extensionPath,
    "PTK_EXTENSION_PATH",
    "Check PTK_EXTENSION_PATH."
  );
}

function resolveCypressAllowedOrigins(config, options) {
  const fromOptions = options && Object.prototype.hasOwnProperty.call(options, "allowedOrigins")
    ? parseOriginList(options.allowedOrigins, "setupPtkCypress allowedOrigins")
    : [];
  const fromEnv = parseOriginList(
    getEnvConfigValue(config, "PTK_CYPRESS_ALLOWED_ORIGINS"),
    "PTK_CYPRESS_ALLOWED_ORIGINS"
  );
  const fromBaseUrl = options?.includeBaseUrl === false
    ? []
    : parseOriginList(config?.baseUrl || config?.e2e?.baseUrl || "", "Cypress baseUrl");

  const origins = unique(fromBaseUrl.concat(fromOptions, fromEnv));
  if (!origins.length) {
    throw new Error(
      "[PTK][cypress_allowed_origins_required] PTK Cypress extension mode requires at least one AUT origin. " +
        "Set e2e.baseUrl, pass setupPtkCypress(on, config, { allowedOrigins: [...] }), " +
        "or set PTK_CYPRESS_ALLOWED_ORIGINS."
    );
  }
  return origins;
}

function defaultPreparedExtensionDir(config) {
  const projectRoot = config?.projectRoot || process.cwd();
  const runId = process.env.PTK_RUN_ID || `${Date.now()}-${process.pid}`;
  return path.join(projectRoot, ".ptk", "cypress-extension", runId);
}

function copyExtensionForCypress(sourceExtensionPath, config, options) {
  const targetRaw =
    options?.extensionDir ||
    getEnvConfigValue(config, "PTK_CYPRESS_EXTENSION_DIR") ||
    defaultPreparedExtensionDir(config);
  const targetExtensionPath = path.resolve(targetRaw);
  const resolvedSource = fs.realpathSync(sourceExtensionPath);
  let targetAlreadySource = false;
  try {
    targetAlreadySource = fs.realpathSync(targetExtensionPath) === resolvedSource;
  } catch (_) {
    targetAlreadySource = path.resolve(targetExtensionPath) === resolvedSource;
  }
  if (targetAlreadySource) {
    throw new Error(
      "[PTK][cypress_extension_copy_required] PTK Cypress must use a run-local extension copy. " +
        "PTK_CYPRESS_EXTENSION_DIR must not point at PTK_EXTENSION_PATH or the bundled package extension."
    );
  }

  fs.rmSync(targetExtensionPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetExtensionPath), { recursive: true });
  fs.cpSync(sourceExtensionPath, targetExtensionPath, { recursive: true, dereference: true });
  return targetExtensionPath;
}

function prepareCypressExtension(sourceExtensionPath, config, options) {
  const allowedOrigins = resolveCypressAllowedOrigins(config, options);
  const preparedExtensionPath = copyExtensionForCypress(sourceExtensionPath, config, options);
  const devLocal = {
    automationEnabled: true,
    automationAllowChildFrameBootstrap: true,
    automationChildFrameBootstrapOrigins: allowedOrigins,
  };
  fs.writeFileSync(
    path.join(preparedExtensionPath, "dev.local.json"),
    `${JSON.stringify(devLocal, null, 2)}\n`,
    "utf8"
  );
  return {
    extensionPath: preparedExtensionPath,
    sourceExtensionPath,
    allowedOrigins,
    devLocal,
  };
}

function normalizeProfilePath(config) {
  const profilePath = getEnvConfigValue(config, "PTK_PROFILE_DIR");
  if (!profilePath) return null;

  return normalizeDirectoryPath(
    profilePath,
    "PTK_PROFILE_DIR",
    "Create the profile first and ensure the path is correct."
  );
}

function writeJsonArtifact(config, fileName, payload) {
  const artifactsDir =
    process.env.PTK_ARTIFACTS_DIR ||
    getEnvConfigValue(config, "PTK_ARTIFACTS_DIR");
  if (!artifactsDir) return;
  const outPath = path.resolve(artifactsDir, fileName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
}

function ensureLaunchOptions(launchOptions) {
  if (!launchOptions || typeof launchOptions !== "object") {
    return { args: [], extensions: [] };
  }
  if (!Array.isArray(launchOptions.args)) {
    launchOptions.args = [];
  }
  if (!Array.isArray(launchOptions.extensions)) {
    launchOptions.extensions = [];
  }
  return launchOptions;
}

function normalizeChromiumHeadlessArgs(launchOptions) {
  const args = launchOptions.args;
  const hasHeadless = args.some((arg) => /^--headless(?:=.*)?$/.test(String(arg)));
  if (!hasHeadless) return;

  launchOptions.args = args.filter((arg) => !/^--headless(?:=.*)?$/.test(String(arg)));
  launchOptions.args.push("--headless=new");
}

function stripFirefoxProfileArgs(args) {
  const normalized = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = String(args[i] || "");
    if (current === "-profile") {
      i += 1;
      continue;
    }
    if (current.startsWith("-profile=")) {
      continue;
    }
    normalized.push(args[i]);
  }
  return normalized;
}

function setFirefoxProfileArgs(launchOptions, profilePath) {
  launchOptions.args = stripFirefoxProfileArgs(launchOptions.args);
  if (!launchOptions.args.includes("-no-remote")) {
    launchOptions.args.push("-no-remote");
  }
  launchOptions.args.push("-profile", profilePath);
}

function addUniqueArg(args, value) {
  if (!args.includes(value)) args.push(value);
}

function setChromiumExtensionArgs(launchOptions, extensionPath) {
  addUniqueArg(launchOptions.args, "--disable-extensions-file-access-check");
  addUniqueArg(launchOptions.args, `--disable-extensions-except=${extensionPath}`);
  addUniqueArg(launchOptions.args, `--load-extension=${extensionPath}`);
}

function formatCompatibilityError(compat, browser, mode) {
  const name = browser?.name || "unknown";
  const family = browser?.family || "unknown";
  const version = browser?.version || browser?.majorVersion || "?";
  const base = `[PTK][${compat.code}] ${compat.message} Browser: ${name} (${family}) ${version}. Mode: ${mode}.`;
  return compat.recommendation ? `${base} ${compat.recommendation}` : base;
}

function setupPtkCypress(on, config, options) {
  options = options || {};
  const compatMode = resolveCompatMode(config);
  const profilePath = normalizeProfilePath(config);
  const sourceExtensionPath = normalizeExtensionPath(config, !profilePath);
  const prepared = profilePath
    ? null
    : prepareCypressExtension(sourceExtensionPath, config, options);
  const extensionPath = prepared ? prepared.extensionPath : sourceExtensionPath;

  if (!config.env || typeof config.env !== "object") config.env = {};
  if (prepared) {
    config.env.PTK_EXTENSION_PATH = prepared.extensionPath;
    config.env.PTK_CYPRESS_SOURCE_EXTENSION_PATH = prepared.sourceExtensionPath;
    config.env.PTK_CYPRESS_ALLOWED_ORIGINS = prepared.allowedOrigins.join(",");
  }

  if (profilePath && sourceExtensionPath) {
    console.warn(
      "[PTK] PTK_PROFILE_DIR is set. PTK_EXTENSION_PATH will be ignored and browser profile state will be used."
    );
  }

  on("before:browser:launch", (browser, launchOptionsRaw) => {
    const launchOptions = ensureLaunchOptions(launchOptionsRaw);
    const compat = resolveBrowserCompatibility(browser, compatMode, config);
    const browserFamily = toLower(browser?.family);
    const browserName = toLower(browser?.name);

    if (compat.status === "unsupported") {
      throw new Error(formatCompatibilityError(compat, browser, compatMode));
    }

    if (compat.status === "experimental") {
      console.warn(
        "[PTK] %s [%s] %s",
        compat.message,
        compat.code,
        compat.recommendation || ""
      );
    }

    if (profilePath) {
      const isFirefox = browserFamily === "firefox" || browserName === "firefox";
      if (!isFirefox) {
        throw new Error(
          `[PTK][profile_mode_browser_unsupported] PTK_PROFILE_DIR is supported only with Firefox in Cypress. Browser: ${browser?.name || "unknown"} (${browser?.family || "unknown"}).`
        );
      }
      setFirefoxProfileArgs(launchOptions, profilePath);
    } else if (!launchOptions.extensions.includes(extensionPath)) {
      launchOptions.extensions.push(extensionPath);
    }

    if (!profilePath && browserFamily === "chromium") {
      setChromiumExtensionArgs(launchOptions, extensionPath);
    }

    if (browserFamily === "chromium" && browser?.isHeadless === true) {
      normalizeChromiumHeadlessArgs(launchOptions);
    }

    if (profilePath) {
      console.log(
        "[PTK] Using Firefox profile %s (%s %s, mode=%s, compat=%s)",
        profilePath,
        browser?.name || "unknown",
        browser?.version || browser?.majorVersion || "?",
        compatMode,
        compat.status
      );
    } else {
      console.log(
        "[PTK] Extension loaded from %s (%s %s, mode=%s, compat=%s, allowedOrigins=%s)",
        extensionPath,
        browser?.name || "unknown",
        browser?.version || browser?.majorVersion || "?",
        compatMode,
        compat.status,
        prepared ? prepared.allowedOrigins.join(",") : "profile"
      );
    }

    writeJsonArtifact(config, "browser-launch.json", {
      browserName: browser?.name || "unknown",
      browserVersion: browser?.version || browser?.majorVersion || null,
      executablePath: browser?.path || null,
      headless: browser?.isHeadless === true,
      extensionPath: profilePath ? null : extensionPath,
      sourceExtensionPath: prepared ? prepared.sourceExtensionPath : null,
      allowedOrigins: prepared ? prepared.allowedOrigins : null,
      profileMode: profilePath ? "firefox-profile" : "cypress-extension-injection",
      profileDir: profilePath || null,
      launchArgs: launchOptions.args || [],
      compatibility: compat,
    });

    return launchOptions;
  });

  return config;
}

function ptkPlugin(on, config, options) {
  return setupPtkCypress(on, config, options);
}

module.exports = {
  setupPtkCypress,
  ptkPlugin,
  _private: {
    COMPAT_MODE_STRICT,
    COMPAT_MODE_EXPERIMENTAL,
    CHROME_EXTENSION_CUTOFF,
    resolveCompatMode,
    normalizeBrowserInfo,
    resolveBrowserCompatibility,
    getEnvConfigValue,
    normalizeHttpOrigin,
    parseOriginList,
    resolveCypressAllowedOrigins,
    prepareCypressExtension,
    copyExtensionForCypress,
    findBundledExtensionPath,
    isPtkExtensionDir,
    normalizeDirectoryPath,
    normalizeExtensionPath,
    normalizeProfilePath,
    ensureLaunchOptions,
    normalizeChromiumHeadlessArgs,
    stripFirefoxProfileArgs,
    setFirefoxProfileArgs,
    setChromiumExtensionArgs,
    formatCompatibilityError,
  },
};
