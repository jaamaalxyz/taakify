import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Home: a newly added book appears under Recently added", async ({ page }) => {
  await signUpAndOnboard(page);

  const title = `E2E Home Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
});
