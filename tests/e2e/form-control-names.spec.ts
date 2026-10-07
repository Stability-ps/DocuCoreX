import { expect, test } from "@playwright/test";

// Release-audit sweep (2026-10-07, 47 routes × 7 widths): these pages had form
// controls with no accessible name — settings rows whose visible label was not
// tied to the control, notification switches, the invoice line-item inputs and
// the automation pipeline fields — and /invoices/new had two <h1>s.
const routes = ["/invoices/new", "/automations", "/settings/workspace", "/settings/notifications", "/settings/automations", "/login"];

for (const route of routes) {
  test(`${route}: every visible control has an accessible name and there is one h1`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Markup check, run once.");
    await page.goto(route);
    await page.waitForLoadState("networkidle");

    const unnamed = await page
      .locator("button, input:not([type=hidden]), select, textarea, [role=switch]")
      .evaluateAll((elements) =>
        elements
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .filter((el) => {
            const input = el as HTMLInputElement;
            const own = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
            const text = el.tagName === "BUTTON" ? (el.textContent || "").trim() : "";
            const labelled = Boolean(el.getAttribute("aria-labelledby")) || (input.labels?.length ?? 0) > 0;
            return !own && !text && !labelled && !(input.placeholder || "").trim();
          })
          .map((el) => el.outerHTML.slice(0, 140)),
      );
    expect(unnamed).toEqual([]);
    await expect(page.locator("h1")).toHaveCount(1);
  });
}
