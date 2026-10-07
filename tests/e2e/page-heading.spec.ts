import { expect, test } from "@playwright/test";

// PageHeader is hidden below md by design, so pages built on it had no <h1> at
// all on phones (release audit, 2026-10-07). Each page must expose exactly one
// level-1 heading in the accessibility tree at every width — never none, and
// never two spoken titles — without horizontal overflow.
const widths = [320, 360, 375, 390, 430, 768, 1024, 1440];
const routes = [
  "/automations",
  "/billing",
  "/documents",
  "/documents/archive",
  "/documents/recent",
  "/documents/shared",
  "/documents/trash",
  "/help",
  "/intake",
  "/integrations",
  "/invoices",
  "/invoices/new",
  "/settings/automations",
  "/settings/companies",
  "/settings/integrations",
  "/team",
  "/accounting/trial-balance",
];

for (const route of routes) {
  test(`${route}: one page heading and no overflow at every width`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Iterates its own widths.");
    test.setTimeout(90_000);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 }), `${route} @${width}`).toHaveCount(1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} @${width} horizontal overflow`).toBeLessThanOrEqual(0);
    }
  });
}
