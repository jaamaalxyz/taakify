import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Library: searching by title finds the added book", async ({ page }) => {
  await signUpAndOnboard(page);

  // Two books, not one: with a single book, "the searched-for title is
  // visible" would pass even if the search box filtered nothing (the
  // unfiltered list already shows it). Searching one title while asserting
  // the other disappears is what actually pins the filter's behavior.
  const title = `E2E Library Book ${randomUUID().slice(0, 8)}`;
  const otherTitle = `E2E Library Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);
  await addBookManually(page, otherTitle);

  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();

  // The search refetch is debounced and runs server-side (Library.tsx's
  // debouncedSearch effect), so the negative assertion below may need to
  // wait out the debounce round-trip before the non-matching book leaves
  // the list -- not.toBeVisible() retries until then.
  await page.getByLabel("Search books").fill(title);
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText(otherTitle)).not.toBeVisible();
});
