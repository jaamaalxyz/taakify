import { test, expect } from "@playwright/test";

test("the app loads and shows the landing page for a signed-out visitor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Taakify" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
});
