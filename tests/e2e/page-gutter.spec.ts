import { expect, test } from "@playwright/test";

// The eleven ledger pages rendered their header and cards with no content
// gutter at any width: flush against the sidebar on desktop and the screen
// edge on mobile, unlike every other page (release audit, 2026-10-07).
const ledgerRoutes = [
  "/accounting/chart-of-accounts",
  "/accounting/journals",
  "/accounting/general-ledger",
  "/accounting/trial-balance",
  "/accounting/vat",
  "/accounting/reconciliation",
  "/accounting/receivables",
  "/accounting/payables",
  "/accounting/fixed-assets",
  "/accounting/period-close",
  "/accounting/audit-trail",
];

for (const route of ledgerRoutes) {
  test(`${route} keeps its content inside the page gutter`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "laptop-short", "Covered by desktop.");
    await page.goto(route);
    const heading = page.locator("main h1:visible").first();
    await expect(heading).toBeVisible();
    const inset = await heading.evaluate((h1) => {
      const main = h1.closest("main")!.getBoundingClientRect();
      const box = h1.getBoundingClientRect();
      return { left: box.left - main.left, right: main.right - box.right };
    });
    expect(inset.left).toBeGreaterThanOrEqual(16);
    expect(inset.right).toBeGreaterThanOrEqual(16);
  });
}
