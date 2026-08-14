import { expect, test, type Page } from "@playwright/test";
import { appNav } from "@/lib/product-data";

const accountingGroup = appNav.find((item) => item.title === "Accounting & Financial Reporting");
if (!accountingGroup) throw new Error("Accounting & Financial Reporting group missing from appNav");

const accountingSections = accountingGroup.sections ?? [];
const overviewItems = accountingGroup.children ?? [];
const allAccountingItems = [...overviewItems, ...accountingSections.flatMap((section) => section.items)];

async function expandAccountingGroup(page: Page) {
  const groupButton = page.getByRole("button", { name: "Accounting & Financial Reporting" });
  // The group button has no aria-expanded attribute; detect state via a visible child link instead.
  if (!(await page.getByRole("link", { name: overviewItems[0].title, exact: true }).isVisible().catch(() => false))) {
    await groupButton.click();
  }
}

async function expandAllAccountingSections(page: Page) {
  await expandAccountingGroup(page);
  for (const section of accountingSections) {
    const sectionButton = page.getByRole("button", { name: section.title, exact: true });
    const firstItemLink = page.getByRole("link", { name: section.items[0].title, exact: true });
    if (!(await firstItemLink.isVisible().catch(() => false))) {
      await sectionButton.click();
    }
  }
}

test.describe("Accounting sidebar navigation", () => {
  test.beforeEach(async ({ page }) => {
    // The PWA install banner (components/pwa-installer.tsx) can appear over
    // page content on mobile browsers and intercept clicks meant for the nav
    // drawer underneath it. It's unrelated to what these tests exercise, so
    // suppress it up front rather than letting it flakily eat a click.
    await page.addInitScript(() => window.localStorage.setItem("docucorex_install_dismissed", "true"));
  });

  test("sidebar nav scrolls independently of the fixed header", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop/laptop sidebar only — mobile uses the drawer.");

    await page.goto("/accounting");
    await expandAllAccountingSections(page);

    const nav = page.locator("nav").filter({ has: page.getByRole("link", { name: "Overview", exact: true }) });
    const newButtonBoxBefore = await page.getByRole("button", { name: "New" }).boundingBox();

    const [scrollHeight, clientHeight] = await nav.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // Expanding sections above may have already auto-scrolled the nav container
    // (Playwright scrolls elements into view before clicking them) — reset to a
    // known position before proving the container itself can scroll.
    await nav.evaluate((el) => el.scrollTo(0, 0));
    expect(await nav.evaluate((el) => el.scrollTop)).toBe(0);

    await nav.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const scrolledTop = await nav.evaluate((el) => el.scrollTop);
    expect(scrolledTop).toBeGreaterThan(0);

    const newButtonBoxAfter = await page.getByRole("button", { name: "New" }).boundingBox();
    expect(newButtonBoxAfter?.y).toBe(newButtonBoxBefore?.y);
  });

  test("every accounting route is reachable from the desktop sidebar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Route reachability only needs to run once.");

    await page.goto("/accounting");
    await expandAllAccountingSections(page);

    for (const item of allAccountingItems) {
      await expect(page.getByRole("link", { name: item.title, exact: true })).toHaveAttribute("href", item.href);
    }
  });

  test("visiting a deep accounting route auto-expands only its group and section", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Expansion state only needs to run once.");

    await page.goto("/accounting/trial-balance");

    // The group and the "Accounting" section (which contains Trial Balance) are expanded.
    await expect(page.getByRole("link", { name: "Trial Balance", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Chart of Accounts", exact: true })).toBeVisible();

    // Sibling sections stay collapsed by default.
    await expect(page.getByRole("link", { name: "Bank Statements", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "VAT", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "Accounts Receivable", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "Financial Statements", exact: true })).toBeHidden();
  });

  test("manually collapsing an inactive section is remembered across reloads, but the active section is never remembered collapsed", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Persistence only needs to run once.");

    await page.goto("/accounting/trial-balance");

    // Expand a section that isn't active, then collapse it again manually — this deviation should persist.
    await page.getByRole("button", { name: "Banking", exact: true }).click();
    await expect(page.getByRole("link", { name: "Bank Statements", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Banking", exact: true }).click();
    await expect(page.getByRole("link", { name: "Bank Statements", exact: true })).toBeHidden();

    await page.reload();
    await expect(page.getByRole("link", { name: "Bank Statements", exact: true })).toBeHidden();

    // The "Accounting" section (containing the active Trial Balance route) stays expanded across reload,
    // even though localStorage may still hold a stale collapsed value from a previous visit elsewhere.
    await expect(page.getByRole("link", { name: "Trial Balance", exact: true })).toBeVisible();
  });

  test("mobile drawer reaches every accounting route and closes on navigation", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Drawer is mobile-only.");

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Open navigation" }).click();

    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();

    await drawer.getByRole("button", { name: "Accounting & Financial Reporting" }).click();
    await drawer.getByRole("button", { name: "Banking", exact: true }).click();

    const bankStatements = drawer.getByRole("link", { name: "Bank Statements", exact: true });
    await expect(bankStatements).toBeVisible();
    await bankStatements.click();

    // A route not yet hit elsewhere in the run can take a while to compile in
    // Next's dev server on first request — give this one more room than the
    // default assertion timeout before treating it as a real navigation failure.
    await expect(page).toHaveURL(/\/accounting\/bank-statements$/, { timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  });

  test("mobile drawer closes on Escape and backdrop click", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Drawer is mobile-only.");

    await page.goto("/dashboard");

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    // Click the backdrop just inside the viewport edge, away from the drawer panel itself.
    await page.mouse.click(page.viewportSize()!.width - 5, 20);
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  });

  test("main content column still scrolls when its content overflows the viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "laptop-short", "Regression for the reported short-viewport scroll bug.");

    await page.goto("/accounting");
    await expect(page.getByRole("heading", { name: "Accounting", exact: false }).first()).toBeVisible();

    // Real page content varies with backend/data state (loading states, empty
    // states, etc.), which makes its height an unreliable thing to assert on.
    // What's actually being regression-tested is a structural layout property —
    // whether the document can scroll at all when content overflows — so force
    // an overflow deterministically rather than depending on how tall this
    // particular page happens to render right now.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      document.body.appendChild(spacer);
    });

    const canScroll = await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight + 2);
    expect(canScroll).toBe(true);

    // `html { scroll-behavior: smooth }` (app/globals.css) means a plain scrollTo
    // animates — read scrollY immediately after would race the animation and
    // see the pre-scroll position. "instant" bypasses that.
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
  });

  test("Enterprise vault moved to Settings > Storage and out of the sidebar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Static relocation check only needs to run once.");

    await page.goto("/accounting");
    await expect(page.getByText("Enterprise vault")).toHaveCount(0);

    await page.goto("/settings/storage");
    await expect(page.getByText("Enterprise vault")).toBeVisible();
    await expect(page.getByText("Encrypted storage ready")).toBeVisible();
  });
});
