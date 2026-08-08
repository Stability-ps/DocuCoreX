import { expect, test } from "@playwright/test";

test.describe("DocuCoreX app shell smoke tests", () => {
  test("signup route opens the create account form", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/login\?mode=signup/);
    await expect(page.getByRole("heading", { name: "Create your workspace." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Account" }).last()).toBeVisible();
  });

  // Document intake was consolidated onto /documents: app/upload/page.tsx and
  // app/documents/folders/page.tsx are now bare redirects, and the workspace at
  // /documents does the uploading. This test previously asserted the pre-
  // consolidation world — a "New" menu with Upload Document -> /upload and
  // Create Folder -> /documents/folders, neither of which exists any more.
  test("dashboard document entry points link the canonical workspace route", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Run dashboard navigation checks once.");

    await page.goto("/dashboard");

    // The sidebar New menu (app-shell.tsx, backed by newActionItems) is where
    // the desktop document entry points live; they are not rendered until it is
    // opened.
    await page.getByRole("button", { name: "New" }).click();

    // The canonical route is linked directly, not reached via the redirect.
    const uploadEntry = page.getByRole("link", { name: "Upload Document" }).first();
    await expect(uploadEntry).toHaveAttribute("href", "/documents");
    // Scan Document and Import Files were folded into the same workspace.
    await expect(page.getByRole("link", { name: "Scan Document" })).toHaveAttribute("href", "/documents");
    await expect(page.getByRole("link", { name: "Import Files" })).toHaveAttribute("href", "/documents");

    await Promise.all([page.waitForURL(/\/documents$/), uploadEntry.click()]);
    await expect(page.getByRole("heading", { name: "Document workspace" })).toBeVisible();
  });

  // New coverage: the compatibility redirects are load-bearing for bookmarks and
  // external links, and nothing tested them before.
  test("legacy upload routes still redirect to the document workspace", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Route-level behaviour, run once.");

    for (const legacy of ["/upload", "/documents/folders"]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(/\/documents$/);
      await expect(page.getByRole("heading", { name: "Document workspace" })).toBeVisible();
    }
  });

  test("mobile bottom navigation uses invoices and profile menu contains documents", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile bottom navigation is hidden on desktop.");

    await page.goto("/invoices");

    await expect(page.getByRole("link", { name: "Invoices" }).last()).toBeVisible();
    // The "Upload" tab became the "Documents" tab in the same consolidation —
    // app-shell.tsx still calls it the upload tab internally
    // (`uploadTab = item.href === "/documents"`).
    await expect(page.getByRole("link", { name: "Documents", exact: true }).last()).toHaveAttribute("href", "/documents");
    await expect(page.getByRole("link", { name: "Accounting" }).last()).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("link", { name: "Documents", exact: true }).first()).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    expect(overflow).toBe(false);
  });
});
