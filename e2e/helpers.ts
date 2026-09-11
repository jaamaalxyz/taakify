import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export type SignedUpUser = { email: string; householdId: string };

// Every spec calls this once, at the start of its own test. Each call signs
// up a fresh user (randomUUID-scoped email) and creates a fresh household
// (randomUUID-scoped name) against the same dev Postgres database
// `pnpm dev:api` already talks to -- the same isolation pattern
// apps/api/test/helpers.ts's signUp() uses for API-level tests. No DB reset
// or seeding is needed: specs never collide because their data never
// overlaps.
export async function signUpAndOnboard(page: Page): Promise<SignedUpUser> {
  const email = `e2e-${randomUUID()}@test.local`;
  const householdName = `E2E Household ${randomUUID().slice(0, 8)}`;

  await page.goto("/signup");
  await page.getByLabel("Your name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password-123456");
  await page.getRole("button", { name: "Sign up" }).click();

  await expect(page.getByRole("heading", { name: "Name your library" })).toBeVisible();
  await page.getByLabel("Library name").fill(householdName);
  await page.getByRole("button", { name: "Create library" }).click();

  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  // page.request shares the browser context's session cookie, so this is
  // an authenticated call as the just-created user -- the household id
  // isn't otherwise exposed in the URL or DOM after onboarding.
  const me = await page.request.get("/api/me");
  const body = await me.json();
  const householdId = body.memberships[0].household_id as string;

  return { email, householdId };
}

// Adds a book via the Add screen's Manual tab -- not the ISBN-lookup tab,
// which calls real external APIs (Open Library, then Google Books as a
// fallback -- see apps/api/src/routes/editions.ts) and would make this
// suite flaky/network-dependent for no reason relevant to what these tests
// verify (that a book can be added and shows up elsewhere in the app).
// Leaves the browser on /add having shown the success toast.
export async function addBookManually(page: Page, title: string): Promise<void> {
  await page.goto("/add");
  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Add book" }).click();
  await expect(page.getByText(`Added "${title}"`)).toBeVisible();
}
