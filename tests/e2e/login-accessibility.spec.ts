import { expect, test } from "@playwright/test";

// The show/hide-password toggles were icon-only buttons with no accessible
// name, so a screen reader announced them as just "button" (release audit,
// 2026-10-07).
test.describe("Login accessibility", () => {
  test("every button on the login form has an accessible name", async ({ page }) => {
    await page.goto("/login");
    const unnamed = await page.getByRole("button").evaluateAll((buttons) =>
      buttons
        .filter((button) => (button as HTMLElement).offsetParent !== null)
        .filter((button) => !(button.getAttribute("aria-label") || button.textContent || "").trim())
        .map((button) => button.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });

  test("the password visibility toggle announces and applies its state", async ({ page }) => {
    await page.goto("/login");
    const toggle = page.getByRole("button", { name: "Show password" });
    const password = page.getByLabel("Password", { exact: true });

    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(password).toHaveAttribute("type", "password");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
  });
});
