import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Library: searching by title finds the added book", async ({ page }) => {
  await signUpAndOnboard(page);

  const title = `E2E Library Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();

  await page.getByLabel("Search books").fill(title);
  await expect(page.getByText(title)).toBeVisible();
});
