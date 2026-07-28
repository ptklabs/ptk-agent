describe("Juice Shop with PTK on TestMu", () => {
  const requiredEngines = ["DAST", "SAST", "IAST", "SCA"];

  function waitForEngineParticipation(deadline = Date.now() + 45000) {
    return cy.ptkGetSessionProgress().then((progress) => {
      const observed = Object.keys((progress && progress.engines) || {}).map((name) => name.toUpperCase());
      const missing = requiredEngines.filter((name) => !observed.includes(name));
      if (!missing.length) return progress;
      if (Date.now() >= deadline) {
        throw new Error(`PTK engines did not all participate: ${missing.join(", ")}`);
      }
      return cy.wait(1000, { log: false }).then(() => waitForEngineParticipation(deadline));
    });
  }

  before(() => {
    cy.visit("/");
    cy.ptkWaitReady(60000);
    cy.ptkStartSession({
      project: Cypress.env("PTK_PROJECT"),
      engines: Cypress.env("PTK_ENGINES")
    });
  });

  after(() => {
    waitForEngineParticipation().then((payload) => {
      cy.writeFile(".runs/testmu-cypress/progress_before_stop.json", payload);
    });
    cy.ptkGetFindings(Number(Cypress.env("PTK_FINDINGS_LIMIT") || 500)).then((payload) => {
      cy.writeFile(".runs/testmu-cypress/findings_before_stop.json", payload);
    });
    cy.ptkExportScan().then((payload) => {
      cy.writeFile(".runs/testmu-cypress/export_before_stop.json", payload);
    });
    cy.ptkEndSession({
      wait: true,
      immediateAnalysis: Cypress.env("PTK_IMMEDIATE_ANALYSIS")
    });
  });

  it("runs an existing Cypress journey", () => {
    cy.visit("/#/search?q=test");
    cy.location("hash").should("include", "/search");
    cy.get("body").should("be.visible");
  });
});
