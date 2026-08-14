import { expect, test } from "@playwright/test";

// Regression test for a production incident: /api/accounting/coverage responds
// { coverage, engagement }, but the Overview page's loader once assigned the
// whole response body to its `coverage` state instead of unwrapping the
// `coverage` field. `coverage.missing` was then undefined, and every
// `coverage.missing.length` read in ReadinessPanel/MetricCard threw, crashing
// the /accounting route into its error boundary (app/accounting/error.tsx) —
// but only once a workspace actually had a statement, since the empty-state
// return happens before any coverage field is read. Real backend data was
// needed to trigger it, which is why local mock-mode testing missed it.
// Mocking both endpoints here reproduces the exact shapes involved without
// depending on a live Supabase-backed workspace.
const MOCK_RUN = {
  id: "run-1",
  workspaceId: "workspace-1",
  documentId: null,
  processingJobId: null,
  bank: "FNB",
  statementType: "bank_statement",
  status: "completed",
  companyName: "Acme Co",
  accountNumber: "62905786151",
  statementPeriodStart: "2025-12-01",
  statementPeriodEnd: "2025-12-31",
  openingBalance: 1000,
  closingBalance: 1500,
  transactionCount: 42,
  bankChargesTotal: 0,
  sourceStoragePath: "statements/run-1.pdf",
  workbookStoragePath: null,
  extractionProvider: "openai",
  reviewRequired: false,
  reconciliationDifference: 0,
};

const MOCK_COVERAGE_RESPONSE = {
  coverage: {
    months: ["2025-12"],
    rows: [],
    coveragePercent: 100,
    missing: [],
    accountsTracked: 1,
    statementsReceived: 1,
    statementsReconciled: 1,
    engagementInferred: true,
  },
  engagement: { startDate: null, endDate: null, expectedAccounts: [] },
};

test.describe("Accounting overview coverage handling", () => {
  test("renders real content instead of crashing when coverage data is present", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Route-mocked data check only needs to run once.");

    await page.route("**/api/accounting/fnb/runs", (route) => route.fulfill({ json: { runs: [MOCK_RUN] } }));
    await page.route("**/api/accounting/coverage", (route) => route.fulfill({ json: MOCK_COVERAGE_RESPONSE }));
    await page.route("**/api/accounting/engine/review-queue**", (route) => route.fulfill({ json: { items: [] } }));

    await page.goto("/accounting");

    // The error boundary text from app/accounting/error.tsx — must never appear.
    await expect(page.getByText("Something went wrong loading this page")).toHaveCount(0);

    // Real overview content, derived from the mocked coverage/runs — proves the
    // page actually rendered past the coverage.missing.length reads rather than
    // just avoiding the crash by rendering nothing.
    await expect(page.getByRole("heading", { name: "Books readiness", level: 3 })).toBeVisible();
    await expect(page.getByText("Statement coverage complete for the period held")).toBeVisible();
    await expect(page.getByText("No gaps detected")).toBeVisible();
  });
});
