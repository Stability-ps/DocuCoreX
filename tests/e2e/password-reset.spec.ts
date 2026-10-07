import { expect, test } from "@playwright/test";

// An expired or already-used recovery link must explain itself and offer a new
// one, not dead-end on a generic error (release audit, 2026-10-07).
test("an invalid reset link explains itself and offers a new one", async ({ page }) => {
  await page.goto("/auth/reset-password?error=link_invalid");
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "invalid or has expired" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/login?mode=forgot");
});
