import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Home: a newly added book appears under Recently added", async ({ page }) => {
  // Default 30s test timeout is too tight here: this spec does two full
  // page.goto() reloads (signUpAndOnboard's own /signup load plus
  // addBookManually's /add load plus this test's own goto("/")), and each
  // reload re-establishes ~8 Electric shape long-polls over dev HTTP/1.1,
  // which the app's own console warning documents as capped at ~6
  // concurrent connections per origin -- observed to make the final
  // goto("/") take 30s+ on its own in this dev environment.
  test.setTimeout(60_000);

  await signUpAndOnboard(page);

  const title = `E2E Home Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
});
