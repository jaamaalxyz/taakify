import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Loans: lending a book makes it appear under Active", async ({ page }) => {
  // Three full-page navigations (signup -> add -> loans), each re-establishing
  // several Electric shape long-polls plus module fetches under this dev
  // environment's ~6-concurrent-connection-per-origin limit -- see Task 3's
  // home.spec.ts for the same pattern and rationale.
  test.setTimeout(60_000);

  await signUpAndOnboard(page);

  const title = `E2E Loan Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/loans");
  await expect(page.getByRole("heading", { name: "Loans" })).toBeVisible();

  await page.getByRole("button", { name: "Add loan" }).click();
  await expect(page.getByRole("heading", { name: "Record a loan" })).toBeVisible();

  await page.getByLabel("Book").click();
  await page.getByRole("option", { name: title }).click();

  // Direction defaults to "Lent out" already -- leave it.
  await page.getByLabel("New contact name").fill("E2E Borrower");
  await page.getByRole("button", { name: "Record loan" }).click();

  await expect(page.getByText("Loan recorded")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Active" })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText(/Lent out.*E2E Borrower/)).toBeVisible();
});
