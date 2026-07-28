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
const REQUIRED_FINDINGS_TIMEOUT = Number(
  Cypress.env("PTK_REQUIRED_FINDINGS_TIMEOUT") ||
    Cypress.env("PTK_MAX_SCAN_SECONDS") ||
    300
);
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
    ["sca_vulnerable_component", "SCA vulnerable component finding", 1],
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

function waitForRequiredFindingGate() {
  const startedAt = scanStartedAt || Date.now();
  const floorDeadline = startedAt + Math.max(15, MIN_SCAN_SECONDS) * 1000;
  const hardDeadline = startedAt + Math.max(60, REQUIRED_FINDINGS_TIMEOUT) * 1000;

  function check() {
    const now = Date.now();
    if (now < floorDeadline) {
      return cy.wait(Math.min(5000, floorDeadline - now)).then(check);
    }

    return cy.ptkGetFindings(FINDINGS_LIMIT).then((payload) => {
      const findings = (payload && payload.findings) || [];
      const gate = evaluateRequiredFindings(findings);
      const missing = missingRequirementDescriptions(gate);
      if (gate.ok || Date.now() >= hardDeadline) {
        return { payload, gate };
      }
      cy.log("Waiting for required findings: " + missing.join(", "));
      return cy.wait(5000).then(check);
    });
  }

  return cy.then(check);
}

function writeJsonArtifact(fileName, payload) {
  const safeName = String(fileName || "artifact.json").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const endpoint = String(Cypress.env("PTK_ARTIFACTS_ENDPOINT") || "");
  if (endpoint && typeof fetch === "function") {
    return Cypress.Promise.resolve(
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ fileName: safeName, payload }),
      })
        .then((response) => response.json())
        .then((result) => {
          if (!result || result.ok !== true) {
            throw new Error("Artifact write failed: " + String(result && result.error ? result.error : "unknown"));
          }
          return result.path;
        })
    ).then((outPath) => {
      Cypress.log({
        name: "ptkArtifact",
        message: outPath,
        consoleProps: () => ({ path: outPath }),
      });
      return outPath;
    });
  }

  return cy.task("ptkWriteJsonArtifact", { fileName: safeName, payload }, { log: false }).then((outPath) => {
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
  }

  return cy.then(check);
}

function runLoginFlow() {
  cy.log("Opening login page");
  cy.visit("/#/login");
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

  cy.get("body", { log: false }).then(($body) => {
    const selector = firstVisibleSelector($body, [
      "#password",
      "input#passwordControl",
      "input[formcontrolname='password']",
      "input[type='password']",
    ]);
    if (selector) {
      cy.get(selector).filter(":visible").first().type("{enter}", { force: true });
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
  clickRequired(
    [
      "#navbarAccount",
      "button[aria-label='Show/hide account menu']",
      "#navbarAccount > .mdc-button__label > span",
      "button[aria-label*='Account']",
    ],
    "account menu button"
  );

  clickRequired(
    [
      "button[aria-label='Go to user profile']",
      "#navbarUser",
      "button[id='navbarUser']",
      ".mat-mdc-menu-panel #navbarUser",
      ".mat-menu-panel #navbarUser",
    ],
    "profile menu item"
  );

  cy.url({ timeout: 15000 }).should("include", "profile");
}

function exerciseJwtCookieSurface() {
  cy.window({ log: false }).then((win) => {
    const root = String(Cypress.config("baseUrl") || "").replace(/\/$/, "");
    return Promise.all([
      win.fetch(root + "/rest/user/whoami", { credentials: "include" }).catch((error) => ({ error: error.message })),
      win.fetch(root + "/profile", { credentials: "include" }).catch((error) => ({ error: error.message })),
    ]).then((responses) => {
      return responses.map((response) => response.status || 0);
    });
  }).then((statuses) => {
    return cy.log("JWT cookie surface exercised: " + statuses.join(", ")).then(() => statuses);
  });
}

function goHome() {
  cy.visit("/#/");
  cy.get(".mat-grid-tile", { timeout: 15000 }).should("exist");
}

function addProductsToBasket(count) {
  cy.get("button[aria-label='Add to Basket']", { timeout: 15000 })
    .filter(":visible")
    .its("length")
    .should("be.gte", count);

  for (let idx = 0; idx < count; idx += 1) {
    cy.get("button[aria-label='Add to Basket']").filter(":visible").eq(idx).click({ force: true });
  }
}

function openBasketPage() {
  cy.visit("/#/basket");
  cy.url({ timeout: 15000 }).should("include", "basket");
}

function clearBasketRecursive(maxIterations = 40) {
  if (maxIterations <= 0) {
    return;
  }

  cy.window().then((win) => {
    const trashIcon = win.document.querySelector(
      "app-purchase-basket svg[data-icon='trash-alt'], app-purchase-basket i.fa-trash-alt"
    );
    if (!trashIcon) {
      return false;
    }

    const button = trashIcon.closest("button");
    if (!button) {
      return false;
    }

    button.click();
    return true;
  }).then((removed) => {
    if (removed) {
      cy.wait(250);
      clearBasketRecursive(maxIterations - 1);
    }
  });
}

function clearBasket() {
  openBasketPage();
  clearBasketRecursive(40);
  goHome();
}

function clickRemoveWithRetry(maxIterations = 30) {
  if (maxIterations <= 0) {
    throw new Error("Could not locate remove item button in basket");
  }

  cy.window().then((win) => {
    const selectors = [
      "app-purchase-basket svg[data-icon='trash-alt']",
      "app-purchase-basket i.fa-trash-alt",
      "app-purchase-basket .cdk-column-remove button",
      "app-purchase-basket mat-cell.cdk-column-remove button",
      "app-purchase-basket mat-row mat-cell:nth-of-type(5) button",
      "app-purchase-basket button[aria-label='Remove from Basket']",
    ];

    let clicked = false;
    for (const selector of selectors) {
      const el = win.document.querySelector(selector);
      if (!el) {
        continue;
      }
      const button = selector.includes("trash-alt") ? el.closest("button") : el;
      if (button) {
        button.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      const firstRow = win.document.querySelector("app-purchase-basket mat-row");
      if (firstRow) {
        const rowButtons = firstRow.querySelectorAll("button");
        if (rowButtons.length > 0) {
          rowButtons[rowButtons.length - 1].click();
          clicked = true;
        }
      }
    }

    return clicked;
  }).then((clicked) => {
    if (clicked) {
      cy.wait(500);
      return;
    }
    cy.wait(500);
    clickRemoveWithRetry(maxIterations - 1);
  });
}

function removeOneItemFromBasket() {
  cy.get("app-purchase-basket mat-row, app-purchase-basket mat-table", { timeout: 15000 }).should("exist");
  clickRemoveWithRetry(30);
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
    cy.ptkWaitReady(30000);
    cy.ptkStartSession({
      project: Cypress.env("PTK_PROJECT") || "juice-shop",
      engines: Cypress.env("PTK_ENGINES") || DEFAULT_ENGINES,
    }).then((result) => {
      scanStartedAt = Date.now();
      return writeJsonArtifact("session_start.json", {
        status: "started",
        startedAt: new Date(scanStartedAt).toISOString(),
        response: result,
      });
    });
  });

  it("runs the unified SDK workflow", () => {
    dismissOverlays();

    runLoginFlow();
    openProfilePage();
    exerciseJwtCookieSurface();
    goHome();
    clearBasket();
    addProductsToBasket(2);
    openBasketPage();
    removeOneItemFromBasket();
    typeIntoSearch(SEARCH_TERM);
    cy.url({ timeout: 15000 }).should("include", "search");
  });

  after(function () {
    const bodyFailed = this.currentTest && this.currentTest.state === "failed";
    if (bodyFailed) {
      if (scanStartedAt <= 0) {
        return null;
      }
      return cy.ptkEndSession({
        wait: true,
        immediateAnalysis: IMMEDIATE_ANALYSIS,
      }).then(
        () => null,
        (error) => {
          cy.log("PTK cleanup after Cypress failure failed: " + String(error && error.message ? error.message : error));
          return null;
        }
      );
    }

    return cy.then(() => {
      const minMs = Math.max(0, Math.trunc(MIN_SCAN_SECONDS * 1000));
      const elapsedMs = scanStartedAt > 0 ? Date.now() - scanStartedAt : 0;
      if (elapsedMs < minMs) {
        cy.log("Keeping scan session open for " + Math.ceil((minMs - elapsedMs) / 1000) + "s");
        return cy.wait(minMs - elapsedMs);
      }
      return null;
    })
      .then(() => waitForRequiredFindingGate())
      .then(({ payload, gate }) => {
        latestFindingGate = gate;
        latestFindingPayload = payload;
        return null;
      })
      .then(() => cy.ptkGetSessionProgress())
      .then((progress) => {
        const engineGate = evaluateEngineGate(progress);
        return writeJsonArtifact("progress-summary.json", progress)
          .then(() => writeJsonArtifact("engine_gate.json", engineGate));
      })
      .then(() => {
        const stopStartedAt = Date.now();
        return cy.ptkEndSession({
          wait: true,
          maxWait: STOP_MAX_WAIT_SECONDS,
          pollInterval: 2000,
          immediateAnalysis: IMMEDIATE_ANALYSIS,
        }).then((result) => {
          return writeJsonArtifact("scan_stop.json", {
              requestedImmediateAnalysis: IMMEDIATE_ANALYSIS,
              stopSucceeded: true,
              stopResponse: result,
              elapsedMs: Date.now() - stopStartedAt,
            })
            .then(() => result);
        });
      })
      .then((result) => {
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
        return writeJsonArtifact("findings.json", finalPayload).then(() => {
          return writeJsonArtifact("finding_gate.json", finalGate);
        });
      })
      .then(() => cy.ptkGetStats())
      .then((stats) => {
        return writeJsonArtifact("session_stats.json", stats).then(() => stats);
      })
      .then((stats) => {
        cy.log("Total findings: " + stats.findingsCount);
        if (stats.bySeverity) {
          Object.keys(stats.bySeverity).forEach((sev) => {
            cy.log("  " + sev + ": " + stats.bySeverity[sev]);
          });
        }
      })
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
});
