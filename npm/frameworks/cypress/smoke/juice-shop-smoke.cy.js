/**
 * PTK Cypress SDK - Juice Shop workflow example
 *
 * This mirrors the Playwright SDK lifecycle:
 *   wait_ready -> start_session -> user flow -> finding gate -> end_session (+ stats)
 */

function truthyEnv(name, defaultValue) {
  const raw = Cypress.env(name);
  const value = raw == null || String(raw).trim() === "" ? defaultValue : String(raw);
  return /^(1|true|yes|on)$/i.test(value);
}

function optionalBoolEnv(name) {
  const raw = Cypress.env(name);
  if (raw == null || String(raw).trim() === "") {
    return undefined;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

const DEFAULT_ENGINES = "DAST,IAST,SAST,SCA";
const MIN_SCAN_SECONDS = Number(Cypress.env("PTK_MIN_SCAN_SECONDS") || 30);
const FINDINGS_LIMIT = Number(Cypress.env("PTK_FINDINGS_LIMIT") || 500);
const LOGIN_EMAIL = String(Cypress.env("PTK_LOGIN_EMAIL") || "YOUR_USERNAME");
const LOGIN_PASSWORD = String(Cypress.env("PTK_LOGIN_PASSWORD") || "YOUR_PASSWORD");
const SEARCH_TERM = String(Cypress.env("PTK_SEARCH_TERM") || "test");
const IMMEDIATE_ANALYSIS = optionalBoolEnv("PTK_IMMEDIATE_ANALYSIS");
const STOP_MAX_WAIT_SECONDS = Number(Cypress.env("PTK_STOP_MAX_WAIT_SECONDS") || 300);

let scanStartedAt = 0;
let latestFindingGate = null;
let latestFindingPayload = null;
let frameworkStartedAt = new Date().toISOString();
let sessionEnded = false;
let preStopFindingGate = null;
let progressSummary = null;
let engineGate = null;
let stopArtifact = null;
let sessionStats = null;
let sessionStartArtifact = null;

function requiredEngines() {
  return String(Cypress.env("PTK_ENGINES") || DEFAULT_ENGINES)
    .split(",")
    .map((engine) => engine.trim().toUpperCase())
    .filter(Boolean);
}

function evaluateEngineGate(progress) {
  const engines = (progress && progress.engines) || {};
  const observed = Object.keys(engines).map((name) => name.toUpperCase()).sort();
  const required = Array.from(new Set(requiredEngines())).sort();
  const missing = required.filter((engine) => !observed.includes(engine));
  const errorEngines = Object.keys(engines)
    .filter((name) => engines[name] && engines[name].status === "error")
    .map((name) => name.toUpperCase())
    .sort();
  return {
    requiredEngines: required,
    observedEngines: observed,
    missingEngines: missing,
    errorEngines,
    passed: missing.length === 0 && errorEngines.length === 0,
  };
}

function summarizeProgress(progress) {
  const source = progress && typeof progress === "object" ? progress : {};
  const engines = {};
  Object.entries(source.engines || {}).forEach(([name, engine]) => {
    const value = engine && typeof engine === "object" ? engine : {};
    engines[name] = {
      status: value.status || null,
      progress: value.progress || null,
      findingsCount: Number.isFinite(value.findingsCount) ? value.findingsCount : null,
      lastActivityAt: value.lastActivityAt || null,
      error: value.error ? String(value.error).slice(0, 1000) : null,
    };
  });
  return {
    sessionId: source.sessionId || null,
    status: source.status || null,
    lastUpdatedAt: source.lastUpdatedAt || source.lastActivityAt || null,
    summary: source.summary || null,
    engines,
  };
}

function findingText(value) {
  const parts = [];

  function visit(item) {
    if (item == null) {
      return;
    }
    if (["string", "number", "boolean"].includes(typeof item)) {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object") {
      Object.keys(item).forEach((key) => {
        parts.push(key);
        visit(item[key]);
      });
    }
  }

  visit(value);
  return parts.join(" ");
}

function findingLabel(finding) {
  if (!finding || typeof finding !== "object") {
    return String(finding).slice(0, 160);
  }

  const labelKeys = [
    "name",
    "title",
    "moduleName",
    "module_name",
    "attackName",
    "attack_name",
    "vulnerability",
    "ruleName",
    "rule_name",
    "type",
    "id",
  ];
  for (const key of labelKeys) {
    const value = finding[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 220);
    }
  }
  return findingText(finding).slice(0, 220);
}

function evaluateRequiredFindings(findings) {
  const matched = {
    dast_security_header: [],
    iast_dom_xss: [],
    sca_vulnerable_component: [],
  };

  (findings || []).forEach((finding) => {
    const text = findingText(finding);
    const lower = text.toLowerCase();
    const label = findingLabel(finding);
    const engine = String(finding && finding.engine ? finding.engine : "").toUpperCase();

    if (
      engine === "DAST" &&
      (lower.includes("content-security-policy") ||
        lower.includes("security header") ||
        lower.includes("header_csp_missing"))
    ) {
      matched.dast_security_header.push(label);
    }

    if (
      engine === "IAST" &&
      lower.includes("dom") &&
      lower.includes("xss")
    ) {
      matched.iast_dom_xss.push(label);
    }

    if (engine === "SCA" && (lower.includes("jquery") || lower.includes("vulnerable_component"))) {
      matched.sca_vulnerable_component.push(label);
    }
  });

  const specs = [
    ["dast_security_header", "DAST security header finding", 1],
    ["iast_dom_xss", "IAST DOM XSS finding", 1],
  ];

  const requirements = specs.map(([key, description, minimum]) => {
    const samples = matched[key] || [];
    return {
      key,
      description,
      minimum,
      count: samples.length,
      ok: samples.length >= minimum,
      samples: samples.slice(0, 8),
    };
  });

  return {
    ok: requirements.every((item) => item.ok),
    totalFindings: (findings || []).length,
    requirements,
  };
}

function missingRequirementDescriptions(gate) {
  return (gate.requirements || [])
    .filter((item) => !item.ok)
    .map((item) => item.description);
}

function logFindingGate(gate) {
  cy.log("Required finding gate: " + (gate.ok ? "passed" : "failed"));
  (gate.requirements || []).forEach((item) => {
    const status = item.ok ? "OK" : "MISSING";
    cy.log(`[${status}] ${item.description}: ${item.count}/${item.minimum}`);
  });
}

function writeJsonArtifact(fileName, payload) {
  const safeName = String(fileName || "artifact.json").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const endpoint = String(Cypress.env("PTK_ARTIFACTS_ENDPOINT") || "");
  if (endpoint && typeof fetch === "function") {
    return Cypress.Promise.resolve(fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: safeName, payload }),
    }))
      .then((response) => response.json())
      .then((result) => {
        if (!result || result.ok !== true) {
          throw new Error("Artifact write failed: " + String(result && result.error ? result.error : "unknown"));
        }
        return result.path;
      });
  }
  return cy.task("ptkWriteJsonArtifact", { fileName: safeName, payload }, {
    log: false,
    timeout: 60000,
  }).then((outPath) => {
    Cypress.log({
      name: "ptkArtifact",
      message: outPath,
      consoleProps: () => ({ path: outPath }),
    });
    return outPath;
  });
}

function writeFrameworkRunArtifact(status, failureReason) {
  return writeJsonArtifact("framework-run.json", {
    framework: "cypress",
    browser: String(Cypress.browser && Cypress.browser.name ? Cypress.browser.name : Cypress.env("PTK_BROWSER") || "unknown"),
    mode: String(Cypress.env("PTK_RELEASE_TEST_MODE") || "source"),
    packageRoot: Cypress.env("PTK_PACKAGE_ROOT") || null,
    sdkRoot: null,
    extensionPath: Cypress.env("PTK_EXTENSION_PATH") || null,
    targetUrl: Cypress.config("baseUrl"),
    profileDir: Cypress.env("PTK_PROFILE_DIR") || null,
    artifactsDir: Cypress.env("PTK_ARTIFACTS_DIR") || null,
    startedAt: frameworkStartedAt,
    endedAt: status === "started" ? null : new Date().toISOString(),
    status,
    failureReason: failureReason || null,
  });
}

function dismissOverlays() {
  cy.get("body").then(($body) => {
    const selectors = [
      ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
      "button[aria-label='Close Welcome Banner']",
      "a.cc-dismiss",
      "button[aria-label='Close Dialog']",
    ];

    selectors.forEach((selector) => {
      const found = $body.find(selector);
      if (found.length > 0) {
        cy.wrap(found[0]).click({ force: true });
      }
    });
  });
}

function clickIfPresent(selector) {
  cy.get("body").then(($body) => {
    const found = $body.find(selector);
    if (found.length > 0) {
      cy.wrap(found[0]).click({ force: true });
    }
  });
}

function firstVisibleSelector($body, selectors) {
  return selectors.find((candidate) => {
    return $body.find(candidate).filter(":visible").length > 0;
  });
}

function clickRequired(selectors, label) {
  cy.get("body").then(($body) => {
    const selector = firstVisibleSelector($body, selectors);
    if (!selector) {
      throw new Error("Could not locate " + label + ". Tried: " + selectors.join(", "));
    }
    cy.get(selector).filter(":visible").first().click({ force: true });
  });
}

function typeRequired(selectors, value, label) {
  cy.get("body").then(($body) => {
    const selector = firstVisibleSelector($body, selectors);
    if (!selector) {
      throw new Error("Could not locate " + label + ". Tried: " + selectors.join(", "));
    }
    cy.get(selector).filter(":visible").first().click({ force: true }).clear({ force: true }).type(value, { force: true });
  });
}

function typeIntoSearch(text) {
  clickIfPresent(".mat-search_icon-search");
  clickIfPresent("#searchQuery");

  cy.get("body").then(($body) => {
    const candidates = [
      "#searchQuery input",
      "app-mat-search-bar input",
      "input[id^='mat-input-']",
      "input[placeholder*='Search']",
      "input[aria-label='Search']",
      "input[type='search']",
    ];

    const selector =
      candidates.find((candidate) => $body.find(candidate).filter(":visible").length > 0) ||
      candidates.find((candidate) => $body.find(candidate).length > 0);

    if (!selector) {
      throw new Error("Could not locate a search input");
    }

    const $matches = $body.find(selector);
    const target = $matches.filter(":visible")[0] || $matches[0];
    if (!target) {
      throw new Error("Could not select a search input element");
    }

    cy.wrap(target)
      .click({ force: true })
      .clear({ force: true })
      .type(text + "{enter}", { force: true });
  });
}

function ensureSmokeUser() {
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD || LOGIN_EMAIL === "YOUR_USERNAME" || LOGIN_PASSWORD === "YOUR_PASSWORD") {
    throw new Error("PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD are required for the Cypress Juice Shop smoke test");
  }

  const question = {
    id: 2,
    question: "Mother's maiden name?",
  };

  return cy.request({
    method: "POST",
    url: "/api/Users/",
    failOnStatusCode: false,
    body: {
      email: LOGIN_EMAIL,
      password: LOGIN_PASSWORD,
      passwordRepeat: LOGIN_PASSWORD,
      securityQuestion: question,
      securityAnswer: "ptk",
    },
  }).then((response) => {
    const status = Number(response && response.status);
    if ([200, 201, 400, 409].includes(status)) {
      return cy.log("Smoke user fixture status: " + status).then(() => response);
    }
    throw new Error("Could not prepare Juice Shop smoke user. Status: " + status);
  });
}

function waitForLoginSuccess(timeoutMs = 15000) {
  const startedAt = Date.now();
  const profileSelectors = [
    "[aria-label='Go to user profile']",
    "a[aria-label='Go to user profile']",
    "button[aria-label='Go to user profile']",
    "#navbarUser",
    "button[id='navbarUser']",
    ".mat-mdc-menu-panel #navbarUser",
    ".mat-menu-panel #navbarUser",
  ];

  function check() {
    return cy.window({ log: false }).then((win) => {
      try {
        if (win.localStorage.getItem("token")) return true;
      } catch (_) {
        // Continue with route and UI evidence.
      }
      return null;
    }).then((storageAuthenticated) => {
      if (storageAuthenticated) return true;
    return cy.url({ log: false }).then((url) => {
      if (!String(url).toLowerCase().includes("login")) {
        return true;
      }

      clickIfPresent("#navbarAccount");
      clickIfPresent("button[aria-label='Show/hide account menu']");

      return cy.get("body", { log: false }).then(($body) => {
        const found = firstVisibleSelector($body, profileSelectors);
        if (found) {
          return true;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          return false;
        }
        return cy.wait(500, { log: false }).then(check);
      });
    });
    });
  }

  return cy.then(check);
}

function navigateSpaHash(hash, expectedRoute) {
  cy.window({ log: false }).then((win) => {
    win.location.hash = hash;
  });
  cy.location("hash", { timeout: 15000 }).should("include", expectedRoute);
}

function runLoginFlow() {
  cy.log("Opening login page");
  navigateSpaHash("#/login", "login");
  cy.intercept("POST", "**/rest/user/login", (request) => {
    let email = request.body && request.body.email;
    if (!email && typeof request.body === "string") {
      try {
        email = JSON.parse(request.body).email;
      } catch (_) {
        email = null;
      }
    }
    if (String(email || "") === LOGIN_EMAIL) request.alias = "ptkUserLogin";
  });
  cy.url({ timeout: 15000 }).should("include", "login");

  cy.log("Filling login form");
  typeRequired(
    [
      "#email",
      "input#emailControl",
      "input[formcontrolname='email']",
      "input[type='email']",
    ],
    LOGIN_EMAIL,
    "email input"
  );

  typeRequired(
    [
      "#password",
      "input#passwordControl",
      "input[formcontrolname='password']",
      "input[type='password']",
    ],
    LOGIN_PASSWORD,
    "password input"
  );

  clickRequired(
    [
      "#loginButton",
      "button#loginButton",
      "button[type='submit']",
      "button:contains('Log in')",
    ],
    "login submit button"
  );

  cy.wait("@ptkUserLogin", { timeout: 15000 }).then((interception) => {
    const status = Number(interception && interception.response && interception.response.statusCode) || 0;
    if (status < 200 || status >= 300) {
      throw new Error("Juice Shop login request failed with status " + status);
    }
  });

  waitForLoginSuccess(15000).then((loggedIn) => {
    if (!loggedIn) {
      throw new Error(
        "Login did not complete. Verify PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD or the Juice Shop fixture user setup."
      );
    }
  });
}

function openProfilePage() {
  navigateSpaHash("#/profile", "profile");
}

function exerciseJwtCookieSurface() {
  cy.window({ log: false }).then((win) => {
    const root = String(Cypress.config("baseUrl") || "").replace(/\/$/, "");
    const request = (url, options = {}) => {
      const controller = new win.AbortController();
      const timer = win.setTimeout(() => controller.abort(), 2500);
      return win.fetch(url, {
        credentials: "include",
        signal: controller.signal,
        ...options,
      }).catch((error) => ({ error: error.message })).finally(() => win.clearTimeout(timer));
    };
    return request(root + "/rest/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ptk-smoke-invalid@example.invalid", password: "invalid" }),
    }).then((unlockResponse) => Promise.all([
        request(root + "/rest/user/whoami"),
        request(root + "/profile"),
        request(root + "/rest/products/search?q=ptk-cypress-" + Date.now()),
        request(root + "/api/Products?limit=5"),
      ]).then((responses) => [unlockResponse, ...responses]))
      .then((responses) => responses.map((response) => response.status || 0));
  }).then((statuses) => {
    return cy.log("JWT cookie surface exercised: " + statuses.join(", ")).then(() => statuses);
  });
}

function goHome() {
  navigateSpaHash("#/", "#/");
}

describe("Juice Shop Security Scan", () => {
  before(() => {
    frameworkStartedAt = new Date().toISOString();
    writeFrameworkRunArtifact("started");

    // Align with Playwright example: start from a clean site state.
    cy.visit("/");
    cy.clearCookies();
    cy.clearLocalStorage();
    cy.window({ log: false }).then((win) => {
      try {
        win.sessionStorage.clear();
      } catch (_) {
        // Ignore storage access issues.
      }
    });

    cy.visit("/");
    cy.viewport(1433, 990);
    ensureSmokeUser();
    runLoginFlow();
    cy.ptkWaitReady(30000);
    cy.ptkStartSession({
      project: Cypress.env("PTK_PROJECT") || "juice-shop",
      engines: Cypress.env("PTK_ENGINES") || DEFAULT_ENGINES,
    }).then((result) => {
      scanStartedAt = Date.now();
      sessionStartArtifact = {
        status: "started",
        startedAt: new Date(scanStartedAt).toISOString(),
        response: result,
      };
      return null;
    });
  });

  it("runs the unified SDK workflow", () => {
    dismissOverlays();

    openProfilePage();
    exerciseJwtCookieSurface();
    goHome();
    typeIntoSearch(SEARCH_TERM);
    cy.url({ timeout: 15000 }).should("include", "search");
  });

  it("validates engine findings and completes the PTK session", () => {
    return cy.then(() => {
      const minMs = Math.max(0, Math.trunc(MIN_SCAN_SECONDS * 1000));
      const elapsedMs = scanStartedAt > 0 ? Date.now() - scanStartedAt : 0;
      if (elapsedMs < minMs) {
        cy.log("Keeping scan session open for " + Math.ceil((minMs - elapsedMs) / 1000) + "s");
        return cy.wait(minMs - elapsedMs);
      }
      return null;
    })
      .then(() => cy.ptkGetFindings(FINDINGS_LIMIT))
      .then((payload) => {
        const findings = (payload && payload.findings) || [];
        const gate = evaluateRequiredFindings(findings);
        latestFindingGate = gate;
        latestFindingPayload = payload;
        preStopFindingGate = gate;
        return null;
      })
      .then(() => cy.ptkGetSessionProgress())
      .then((progress) => {
        progressSummary = summarizeProgress(progress);
        engineGate = evaluateEngineGate(progress);
        return null;
      })
      .then(() => {
        const stopStartedAt = Date.now();
        return cy.ptkEndSession({
          wait: true,
          maxWait: STOP_MAX_WAIT_SECONDS,
          pollInterval: 2000,
          immediateAnalysis: IMMEDIATE_ANALYSIS,
        }).then((result) => {
          stopArtifact = {
            requestedImmediateAnalysis: IMMEDIATE_ANALYSIS,
            stopSucceeded: true,
            stopResponse: result,
            elapsedMs: Date.now() - stopStartedAt,
          };
          return result;
        });
      })
      .then((result) => {
        sessionEnded = true;
        cy.log("Session ended: " + JSON.stringify(result));
      })
      .then(() => cy.ptkGetFindings(FINDINGS_LIMIT))
      .then((payload) => {
        const finalPayload =
          payload && Array.isArray(payload.findings) ? payload : latestFindingPayload;
        const finalFindings = (finalPayload && finalPayload.findings) || [];
        const finalGate = evaluateRequiredFindings(finalFindings);
        latestFindingGate = finalGate;
        latestFindingPayload = finalPayload;
        logFindingGate(finalGate);
        return null;
      })
      .then(() => cy.ptkGetStats())
      .then((stats) => {
        sessionStats = stats;
        return stats;
      })
      .then((stats) => {
        cy.log("Total findings: " + stats.findingsCount);
        if (stats.bySeverity) {
          Object.keys(stats.bySeverity).forEach((sev) => {
            cy.log("  " + sev + ": " + stats.bySeverity[sev]);
          });
        }
      })
      .then(() => writeJsonArtifact("finding_gate_pre_stop.json", preStopFindingGate))
      .then(() => writeJsonArtifact("session_start.json", sessionStartArtifact))
      .then(() => writeJsonArtifact("progress-summary.json", progressSummary))
      .then(() => writeJsonArtifact("engine_gate.json", engineGate))
      .then(() => writeJsonArtifact("scan_stop.json", stopArtifact))
      .then(() => writeJsonArtifact("findings.json", latestFindingPayload))
      .then(() => writeJsonArtifact("finding_gate.json", latestFindingGate))
      .then(() => writeJsonArtifact("session_stats.json", sessionStats))
      .then(() => {
        if (latestFindingGate && !latestFindingGate.ok) {
          throw new Error(
            "Required Juice Shop findings were not all observed: " +
              missingRequirementDescriptions(latestFindingGate).join(", ")
          );
        }
      })
      .then(() => writeFrameworkRunArtifact("passed"));
  });

  after(() => {
    if (scanStartedAt <= 0 || sessionEnded) {
      return null;
    }
    return cy.ptkEndSession({
      wait: true,
      immediateAnalysis: IMMEDIATE_ANALYSIS,
    }).then(
      () => {
        sessionEnded = true;
        return null;
      },
      (error) => {
        cy.log("PTK cleanup after Cypress failure failed: " + String(error && error.message ? error.message : error));
        return null;
      }
    );
  });
});
