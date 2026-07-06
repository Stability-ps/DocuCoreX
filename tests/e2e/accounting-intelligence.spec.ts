import { expect, test } from "@playwright/test";

const failedRun = {
  id: "run_failed_1",
  workspaceId: "workspace_demo",
  documentId: "doc_1",
  processingJobId: "job_1",
  bank: "FNB South Africa",
  statementType: "business_bank_statement",
  status: "failed",
  companyName: "ALLIANZ HOLDINGS (PTY) LTD",
  accountNumber: "63012589818",
  statementPeriodStart: "2026-02-01",
  statementPeriodEnd: "2026-02-28",
  openingBalance: 111600.56,
  closingBalance: 11196.46,
  transactionCount: 0,
  bankChargesTotal: 0,
  sourceStoragePath: "workspace_demo/accounting/fnb/fail.pdf",
  workbookStoragePath: null,
  extractionProvider: "python_fastapi",
  parserProfile: "fnb_business_v1",
  parserVersion: "fnb_business_v1",
  reviewRequired: false,
  reviewReason: null,
  requiresReview: false,
  processingDurationMs: 0,
  extractionAccuracy: 0,
  errorMessage: "OCR timed out while processing this statement.",
  parserDebug: { stage: "parser_detected", rows: 0 },
  ocrDebug: { attempted: true, used: true, duration_ms: 240000, status: "timeout" },
  lastStep: "ocr_processing",
  selectedParser: "fnb_business_v1",
  detectedPdfType: "scanned",
  confidence: 0,
  error: "OCR timed out while processing this statement.",
  createdAt: "2026-07-06T10:00:00.000Z",
  updatedAt: "2026-07-06T10:05:00.000Z",
};

test.describe("Accounting Intelligence failure handling", () => {
  test("failed runs stay selectable and show diagnostics with retry actions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Run once on desktop.");

    await page.route("**/api/accounting/fnb/runs**", async (route) => {
      const url = new URL(route.request().url());
      const isList = /\/api\/accounting\/fnb\/runs\/?$/.test(url.pathname);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(isList ? { runs: [failedRun] } : { run: failedRun, transactions: [] }),
      });
    });

    await page.goto("/accounting");
    await page.getByRole("button", { name: "Open February 2026 Statement", exact: true }).click();

    await expect(page.getByText("Processing failed")).toBeVisible();
    await expect(page.getByText("OCR timed out while processing this statement.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Force Reprocess" })).toBeVisible();
    await expect(page.getByText("Select or upload an FNB statement")).toHaveCount(0);
  });

  test("OCR failures are visible in UI instead of silent Failed state", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Run once on desktop.");

    const queuedRun = { ...failedRun, status: "queued", error: null, errorMessage: null, lastStep: "queued" };

    await page.route("**/api/accounting/fnb/runs**", async (route) => {
      const url = new URL(route.request().url());
      const isList = /\/api\/accounting\/fnb\/runs\/?$/.test(url.pathname);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(isList ? { runs: [queuedRun] } : { run: queuedRun, transactions: [] }),
      });
    });

    await page.route("**/api/accounting/fnb/process", async (route) => {
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          error: "OCR timed out while processing this statement.",
          workerStatus: 504,
          workerDetail: { message: "OCR timeout after 240000ms", status: "ocr_timeout" },
          workerRawBody: "{\"message\":\"OCR timeout\"}",
        }),
      });
    });

    await page.goto("/accounting");
    await page.getByRole("button", { name: "Open February 2026 Statement", exact: true }).click();
    await page.getByLabel(/Select .* for combined workbook/).check();
    await page.getByRole("button", { name: "Process Selected" }).click();

    await expect(page.getByText("OCR timeout after 240000ms Worker HTTP 504.")).toBeVisible();
    await expect(page.getByText("Show technical details")).toBeVisible();
  });
});
