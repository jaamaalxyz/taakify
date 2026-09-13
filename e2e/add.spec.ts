import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Add: filling the manual form adds a book and shows a success toast", async ({ page }) => {
  await signUpAndOnboard(page);

  const title = `E2E Add Book ${randomUUID().slice(0, 8)}`;

  await page.goto("/add");
  await expect(page.getByRole("heading", { name: "Add a book" })).toBeVisible();

  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Authors").fill("E2E Author");
  await page.getByRole("button", { name: "Add book" }).click();

  await expect(page.getByText(`Added "${title}"`)).toBeVisible();
});
