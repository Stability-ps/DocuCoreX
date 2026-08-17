import { expect, test } from "@playwright/test";

// Regression test for a production incident: /api/accounting/journals 500'd
// with a PostgREST "more than one relationship was found" ambiguous-embed
// error (lib/accounting/journals-server.ts — accounting_journal_lines has two
// FKs to accounting_journals since migration 037). Because listJournals()
// threw before journals.tsx's loadForCompany() ever called setAccounts(),
// "New Journal" and "Import CSV" stayed permanently disabled (accounts.length
// never left 0) even though the chart-of-accounts half of the same
// Promise.all had already succeeded — a silent failure masquerading as a
// disabled control, with no error shown to explain it.
//
// This mocks both endpoints succeeding to assert the buttons enable once
// accounts genuinely populate — the case a live/unmocked test can't
// reliably exercise, and the one this incident depended on.
const ENTITY_ID = "11111111-1111-1111-1111-111111111111";

const ENTITIES_RESPONSE = {
  entities: [{ id: ENTITY_ID, name: "Test Co", isDefault: true, financialYearEndMonth: 2, financialYearEndDay: 28 }],
};

const ACCOUNTS_RESPONSE = {
  entities: ENTITIES_RESPONSE.entities,
  accounts: [{ id: "acc-1", companyId: ENTITY_ID, code: "1000", name: "Bank", accountType: "asset", normalBalance: "debit", isActive: true, isSystem: false }],
  taxCodes: [],
  customers: [],
  suppliers: [],
};

const JOURNALS_RESPONSE = { journals: [] };

test.describe("Journals action buttons", () => {
  test("New Journal and Import CSV enable once accounts load successfully", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Route-mocked logic check only needs to run once.");

    await page.route("**/api/accounting/chart-of-accounts**", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("companyId")) {
        return route.fulfill({ json: ACCOUNTS_RESPONSE });
      }
      return route.fulfill({ json: ENTITIES_RESPONSE });
    });
    await page.route("**/api/accounting/journals**", (route) => route.fulfill({ json: JOURNALS_RESPONSE }));

    await page.goto("/accounting/journals");

    const newJournal = page.getByRole("button", { name: "New Journal" });
    const importCsv = page.getByRole("button", { name: "Import CSV" });

    await expect(newJournal).toBeEnabled();
    await expect(importCsv).toBeEnabled();
  });

  test("buttons stay disabled — without a misleading silent state — when the journals API fails", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Route-mocked logic check only needs to run once.");

    await page.route("**/api/accounting/chart-of-accounts**", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("companyId")) return route.fulfill({ json: ACCOUNTS_RESPONSE });
      return route.fulfill({ json: ENTITIES_RESPONSE });
    });
    await page.route("**/api/accounting/journals**", (route) =>
      route.fulfill({
        status: 500,
        json: { error: "Could not embed because more than one relationship was found for 'accounting_journals' and 'accounting_journal_lines'" },
      }),
    );

    await page.goto("/accounting/journals");

    // The buttons are disabled (accounts never populated because the
    // Promise.all rejected), but the real API error is surfaced on screen —
    // proving this isn't a silent failure, just a legitimately blocked action.
    await expect(page.getByText("Could not embed because more than one relationship was found", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Journal" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Import CSV" })).toBeDisabled();
  });
});
