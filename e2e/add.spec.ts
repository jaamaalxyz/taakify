import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Add: filling the manual form adds a book and shows a success toast", async ({ page }) => {
  // Two full-page navigations (signup -> add) re-establish several Electric
  // shape long-polls plus module fetches under this dev environment's ~6-
  // concurrent-connection-per-origin limit -- see Task 3's home.spec.ts for
  // the same pattern and rationale.
  test.setTimeout(60_000);

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
