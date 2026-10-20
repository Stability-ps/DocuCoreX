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
      // Not "networkidle": a page that polls (live document statuses every 2.5 s)
      // never goes idle, and each wait then burned the whole 90 s test timeout —
      // seventeen routes, twice with the CI retry, ~50 min of a "hung" E2E job.
      // The heading assertion already waits for the page to render.
      await page.waitForLoadState("load");
      await expect(page.getByRole("heading", { level: 1 }), `${route} @${width}`).toHaveCount(1, { timeout: 15_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} @${width} horizontal overflow`).toBeLessThanOrEqual(0);
    }
  });
}
