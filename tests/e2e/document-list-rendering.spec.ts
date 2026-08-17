import { expect, test } from "@playwright/test";

// Regression test for a production bug: the desktop document table's Name
// cell had className="max-w-0 px-4 py-3" (components/documents/document-list.tsx)
// — a typo for min-w-0, the standard flex/table truncation-enabler class.
// max-w-0 caps the cell's rendered width at zero, collapsing every filename
// down to about one character ("F.", "f.", "P.") instead of a normally
// truncated name. The underlying text node was still present in the DOM
// (so a plain toHaveText assertion would not have caught this), which is
// why this test checks the *rendered width* of the name cell instead.
//
// Mocks /api/documents directly rather than relying on this environment's
// mock-repository seed data, since /api/documents can itself return an error
// state here depending on backend configuration — unrelated to the bug under
// test.
const MOCK_DOCUMENT = {
  id: "doc-1",
  workspaceId: "workspace-1",
  ownerId: "user-1",
  name: "Business Statement Q2.pdf",
  mimeType: "application/pdf",
  sizeBytes: 8_400_000,
  pageCount: 42,
  status: "completed",
  detectedType: "bank_statement",
  storagePath: "documents/doc-1.pdf",
  tags: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

test.describe("Documents list rendering", () => {
  test("document name column renders at a usable width, not collapsed to ~0px", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Layout regression check only needs to run once.");

    await page.route("**/api/documents", (route) => route.fulfill({ json: { documents: [MOCK_DOCUMENT] } }));

    await page.goto("/documents");

    const nameLink = page.getByRole("button", { name: "Business Statement Q2.pdf" });
    await expect(nameLink).toBeVisible();

    const box = await nameLink.boundingBox();
    expect(box).not.toBeNull();
    // The name cell should be wide enough to show a meaningfully truncated
    // filename, not collapsed to the width of a single glyph. 150px is a
    // conservative floor — a max-w-0 regression renders at well under 30px.
    expect(box!.width).toBeGreaterThan(150);
  });
});
