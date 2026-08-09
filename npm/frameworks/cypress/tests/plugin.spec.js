"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const plugin = require("../src/plugin");

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function runPluginSpec() {
  const p = plugin._private;
  assert.ok(p, "plugin private exports should exist");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptk-cypress-plugin-"));
  const tempExtDir = path.join(tempRoot, "extension");
  const tempFirefoxExtDir = path.join(tempRoot, "extension-firefox");
  const tempProfileDir = path.join(tempRoot, "profile");
  fs.mkdirSync(tempExtDir, { recursive: true });
  fs.mkdirSync(tempProfileDir, { recursive: true });
  fs.writeFileSync(path.join(tempExtDir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "OWASP PTK",
    version: "1.0.0",
    background: { service_worker: "app.js" }
  }), "utf8");
  fs.writeFileSync(path.join(tempExtDir, "app.js"), "globalThis.PTK_AGENT = {};", "utf8");
  fs.mkdirSync(path.join(tempFirefoxExtDir, "ptk"), { recursive: true });
  fs.writeFileSync(path.join(tempFirefoxExtDir, "manifest.json"), JSON.stringify({
    manifest_version: 2,
    name: "OWASP PTK Automation",
    version: "1.0.0",
    background: { page: "ptk/background_automation.html" }
  }), "utf8");
  fs.writeFileSync(path.join(tempFirefoxExtDir, "ptk", "background_automation.html"), "<script></script>", "utf8");

  withEnv("PTK_CYPRESS_COMPAT_MODE", undefined, () => {
    assert.strictEqual(p.resolveCompatMode({ env: {} }), p.COMPAT_MODE_STRICT);
  });

  withEnv("PTK_CYPRESS_COMPAT_MODE", "experimental", () => {
    assert.strictEqual(p.resolveCompatMode({ env: {} }), p.COMPAT_MODE_EXPERIMENTAL);
  });

  assert.strictEqual(
    p.resolveCompatMode({ env: { PTK_CYPRESS_COMPAT_MODE: "experimental" } }),
    p.COMPAT_MODE_EXPERIMENTAL
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "electron", family: "electron", majorVersion: 120, isHeadless: false },
      p.COMPAT_MODE_STRICT
    ).status,
    "unsupported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "chrome", family: "chromium", majorVersion: 137, isHeadless: false },
      p.COMPAT_MODE_STRICT
    ).status,
    "unsupported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "chrome-for-testing", family: "chromium", majorVersion: 137, isHeadless: false },
      p.COMPAT_MODE_STRICT
    ).status,
    "supported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      {
        name: "chrome",
        family: "chromium",
        majorVersion: 148,
        isHeadless: false,
        path: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      },
      p.COMPAT_MODE_STRICT
    ).status,
    "supported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "chromium", family: "chromium", majorVersion: 121, isHeadless: true },
      p.COMPAT_MODE_STRICT
    ).status,
    "unsupported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "chromium", family: "chromium", majorVersion: 121, isHeadless: true },
      p.COMPAT_MODE_EXPERIMENTAL
    ).status,
    "experimental"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "firefox", family: "firefox", majorVersion: 123, isHeadless: true },
      p.COMPAT_MODE_STRICT
    ).status,
    "supported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "safari", family: "webkit", majorVersion: 17, isHeadless: false },
      p.COMPAT_MODE_STRICT
    ).status,
    "unsupported"
  );

  assert.strictEqual(
    p.resolveBrowserCompatibility(
      { name: "safari", family: "webkit", majorVersion: 17, isHeadless: false },
      p.COMPAT_MODE_EXPERIMENTAL
    ).status,
    "experimental"
  );

  assert.deepStrictEqual(
    p.resolveCypressAllowedOrigins({
      baseUrl: "http://localhost:3001/path",
      env: {}
    }, {}),
    ["http://localhost:3001"]
  );

  assert.deepStrictEqual(
    p.resolveCypressAllowedOrigins({
      baseUrl: "http://localhost:3001",
      env: { PTK_CYPRESS_ALLOWED_ORIGINS: "https://example.com,https://another.example/path" }
    }, { allowedOrigins: ["https://third.example/a"] }),
    [
      "http://localhost:3001",
      "https://third.example",
      "https://example.com",
      "https://another.example"
    ]
  );

  assert.throws(() => {
    p.resolveCypressAllowedOrigins({ env: {} }, {});
  }, /cypress_allowed_origins_required/);

  const launchOptions = p.ensureLaunchOptions({});
  assert.ok(Array.isArray(launchOptions.args));
  assert.ok(Array.isArray(launchOptions.extensions));

  const headlessArgs = { args: ["--foo", "--headless", "--bar"], extensions: [] };
  p.normalizeChromiumHeadlessArgs(headlessArgs);
  assert.ok(headlessArgs.args.includes("--headless=new"));
  assert.ok(!headlessArgs.args.includes("--headless"));

  withEnv("PTK_EXTENSION_PATH", undefined, () => {
    assert.strictEqual(
      p.getEnvConfigValue({ env: { PTK_EXTENSION_PATH: "/tmp/example" } }, "PTK_EXTENSION_PATH"),
      "/tmp/example"
    );
  });

  withEnv("PTK_EXTENSION_PATH", "/tmp/env-wins", () => {
    assert.strictEqual(
      p.getEnvConfigValue({ env: { PTK_EXTENSION_PATH: "/tmp/config" } }, "PTK_EXTENSION_PATH"),
      "/tmp/env-wins"
    );
  });

  withEnv("PTK_PROFILE_DIR", tempProfileDir, () => {
    assert.strictEqual(p.normalizeProfilePath({ env: {} }), tempProfileDir);
  });

  withEnv("PTK_EXTENSION_PATH", tempExtDir, () => {
    assert.strictEqual(p.normalizeExtensionPath({ env: {} }, true), tempExtDir);
  });

  assert.strictEqual(p.isPtkExtensionDir(tempExtDir), true);

  const preparedDir = path.join(tempRoot, "prepared-extension");
  const prepared = p.prepareCypressExtension(tempExtDir, {
    baseUrl: "https://app.example.test/suite",
    projectRoot: tempRoot,
    env: {},
  }, { extensionDir: preparedDir });
  assert.strictEqual(prepared.extensionPath, preparedDir);
  assert.strictEqual(prepared.sourceExtensionPath, tempExtDir);
  assert.deepStrictEqual(prepared.allowedOrigins, ["https://app.example.test"]);
  assert.ok(fs.existsSync(path.join(preparedDir, "manifest.json")));
  const devLocal = JSON.parse(fs.readFileSync(path.join(preparedDir, "dev.local.json"), "utf8"));
  assert.deepStrictEqual(devLocal, {
    automationEnabled: true,
  });

  const packageRoot = path.join(tempRoot, "package");
  const bundledExt = path.join(packageRoot, "extensions", "chromium-unpacked");
  fs.mkdirSync(bundledExt, { recursive: true });
  fs.copyFileSync(path.join(tempExtDir, "manifest.json"), path.join(bundledExt, "manifest.json"));
  fs.copyFileSync(path.join(tempExtDir, "app.js"), path.join(bundledExt, "app.js"));
  assert.strictEqual(p.findBundledExtensionPath(packageRoot), bundledExt);

  withEnv("PTK_EXTENSION_PATH", undefined, () => {
    assert.strictEqual(p.normalizeExtensionPath({ env: {} }, false), null);
  });

  withEnv("PTK_EXTENSION_FIREFOX_PATH", tempFirefoxExtDir, () => {
    assert.strictEqual(p.normalizeFirefoxExtensionPath({ env: {} }, true), tempFirefoxExtDir);
  });

  const firefoxArgs = ["-profile", "/tmp/other", "-headless"];
  const stripped = p.stripFirefoxProfileArgs(firefoxArgs);
  assert.deepStrictEqual(stripped, ["-headless"]);

  const launchWithProfile = { args: ["-profile", "/tmp/other"], extensions: [] };
  p.setFirefoxProfileArgs(launchWithProfile, tempProfileDir);
  assert.ok(launchWithProfile.args.includes("-no-remote"));
  const profileFlagIndex = launchWithProfile.args.indexOf("-profile");
  assert.ok(profileFlagIndex >= 0);
  assert.strictEqual(launchWithProfile.args[profileFlagIndex + 1], tempProfileDir);

  withEnv("PTK_PROFILE_DIR", tempProfileDir, () => {
    withEnv("PTK_EXTENSION_PATH", undefined, () => {
      let beforeLaunch = null;
      plugin.ptkPlugin((event, cb) => {
        if (event === "before:browser:launch") beforeLaunch = cb;
      }, { env: {} });
      assert.ok(beforeLaunch, "before:browser:launch handler should be registered");

      const launch = beforeLaunch(
        { name: "firefox", family: "firefox", majorVersion: 123, isHeadless: true },
        { args: [], extensions: [] }
      );
      assert.ok(launch.args.includes("-profile"));
      assert.strictEqual(launch.extensions.length, 0);
    });
  });

  withEnv("PTK_PROFILE_DIR", tempProfileDir, () => {
    withEnv("PTK_EXTENSION_PATH", undefined, () => {
      let beforeLaunch = null;
      plugin.ptkPlugin((event, cb) => {
        if (event === "before:browser:launch") beforeLaunch = cb;
      }, { env: {} });
      assert.ok(beforeLaunch, "before:browser:launch handler should be registered");

      assert.throws(() => {
        beforeLaunch(
          { name: "chromium", family: "chromium", majorVersion: 123, isHeadless: false },
          { args: [], extensions: [] }
        );
      }, /profile_mode_browser_unsupported/);
    });
  });

  withEnv("PTK_PROFILE_DIR", undefined, () => {
    withEnv("PTK_EXTENSION_PATH", tempExtDir, () => {
      withEnv("PTK_EXTENSION_FIREFOX_PATH", tempFirefoxExtDir, () => {
        let beforeLaunch = null;
        const config = {
          baseUrl: "https://qa.example.test",
          projectRoot: tempRoot,
          env: {},
        };
        plugin.setupPtkCypress((event, cb) => {
          if (event === "before:browser:launch") beforeLaunch = cb;
        }, config, {
          extensionDir: path.join(tempRoot, "plugin-prepared"),
          allowedOrigins: ["https://api.example.test"],
        });
        assert.ok(beforeLaunch, "before:browser:launch handler should be registered");
        assert.ok(config.env.PTK_EXTENSION_PATH.endsWith("plugin-prepared"));
        assert.ok(config.env.PTK_EXTENSION_FIREFOX_PATH.endsWith("plugin-prepared-firefox"));
        assert.strictEqual(
          config.env.PTK_CYPRESS_ALLOWED_ORIGINS,
          "https://qa.example.test,https://api.example.test"
        );
        const launch = beforeLaunch(
          { name: "chromium", family: "chromium", majorVersion: 123, isHeadless: false },
          { args: [], extensions: [] }
        );
        assert.ok(launch.extensions.includes(config.env.PTK_EXTENSION_PATH));
        const firefoxLaunch = beforeLaunch(
          { name: "firefox", family: "firefox", majorVersion: 123, isHeadless: true },
          { args: [], extensions: [] }
        );
        assert.ok(firefoxLaunch.extensions.includes(config.env.PTK_EXTENSION_FIREFOX_PATH));
      });
    });
  });
}

module.exports = { runPluginSpec };
