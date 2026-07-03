import { expect, test } from "@playwright/test";

test.describe("DocuCoreX app shell smoke tests", () => {
  test("signup route opens the create account form", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/login\?mode=signup/);
    await expect(page.getByRole("heading", { name: "Create your workspace." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Account" }).last()).toBeVisible();
  });

  test("desktop new menu links to routed workspaces", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Desktop sidebar New menu is hidden on mobile.");

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "New" }).click();

    await expect(page.getByRole("link", { name: "Upload Document" })).toHaveAttribute("href", "/upload");
    await expect(page.getByRole("link", { name: "Create Folder" })).toHaveAttribute("href", "/documents/folders");

    await Promise.all([
      page.waitForURL(/\/documents\/folders/),
      page.getByRole("link", { name: "Create Folder" }).click(),
    ]);
    await expect(page.locator("h1", { hasText: "Folders" })).toBeVisible();
  });

  test("mobile bottom navigation uses invoices and profile menu contains documents", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile bottom navigation is hidden on desktop.");

    await page.goto("/invoices");

    await expect(page.getByRole("link", { name: "Invoices" }).last()).toBeVisible();
    await expect(page.getByRole("link", { name: "Upload" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Accounting" })).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("link", { name: "Documents" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    expect(overflow).toBe(false);
  });
});
