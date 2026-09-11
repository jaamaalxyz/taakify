import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Profile: creating an invite shows a shareable link", async ({ page }) => {
  // One full-page navigation via signUpAndOnboard's internal /signup plus
  // this test's own /profile goto, each re-establishing several Electric shape
  // long-polls plus module fetches, plus the real API round-trip to create the
  // invite -- all under this dev environment's ~6-concurrent-connection-per-origin
  // limit. See Task 3's home.spec.ts for the same pattern and rationale.
  test.setTimeout(60_000);

  await signUpAndOnboard(page);

  await page.goto("/profile");

  await page.getByRole("button", { name: "Invite a family member" }).click();
  await expect(page.getByRole("heading", { name: "Invite a family member" })).toBeVisible();

  const inviteEmail = `e2e-invitee-${randomUUID()}@test.local`;
  await page.getByLabel("Email").fill(inviteEmail);
  await page.getByRole("button", { name: "Create invite" }).click();

  // The API call to create the invite can take 10-20+ seconds under this
  // environment's ~6-concurrent-connection-per-origin limit. The shareable
  // link input appears after successful API completion, so we need a long
  // timeout here. The toast also depends on the API response.
  const inviteUrlInput = page.getByLabel("Shareable link");
  await expect(inviteUrlInput).toBeVisible({ timeout: 30_000 });

  await expect(page.getByText("Invite created")).toBeVisible();
  await expect(inviteUrlInput).toHaveValue(/\/invite\//);
});
