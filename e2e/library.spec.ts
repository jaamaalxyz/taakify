import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Library: searching by title finds the added book", async ({ page }) => {
  // Three full-page navigations (signup -> add -> library), each re-establishing
  // several Electric shape long-polls plus module fetches under this dev
  // environment's ~6-concurrent-connection-per-origin limit -- see Task 3's
  // home.spec.ts for the same pattern and rationale.
  test.setTimeout(60_000);

  await signUpAndOnboard(page);

  const title = `E2E Library Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();

  await page.getByLabel("Search books").fill(title);
  await expect(page.getByText(title)).toBeVisible();
});
