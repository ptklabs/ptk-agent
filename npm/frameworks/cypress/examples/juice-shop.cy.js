import "pentestkit/cypress";

describe("Juice Shop with PTK", () => {
  before(() => {
    cy.visit("/");
    cy.ptkWaitReady(30000);
    cy.ptkStartSession({
      project: Cypress.env("PTK_PROJECT") || "juice-shop-cypress-example",
      engines: Cypress.env("PTK_ENGINES") || ["DAST", "IAST", "SAST"]
    });
  });

  after(() => {
    cy.ptkEndSession({
      wait: false,
      immediateAnalysis: Cypress.env("PTK_IMMEDIATE_ANALYSIS")
    });
  });

  it("searches the shop", () => {
    cy.visit("/");
    cy.get("body").then(($body) => {
      const selectors = [
        "button[aria-label='Close Welcome Banner']",
        "a.cc-dismiss",
        "button[aria-label='Search']",
        ".mat-search_icon-search"
      ];
      selectors.forEach((selector) => {
        const found = $body.find(selector).filter(":visible");
        if (found.length) cy.wrap(found.first()).click({ force: true });
      });
    });
    cy.get("input#searchQuery, input[type='search'], input[aria-label='Search'], #searchQuery input", { timeout: 10000 })
      .first()
      .type("test{enter}", { force: true });
  });
});
