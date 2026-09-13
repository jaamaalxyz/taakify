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
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByRole("heading", { name: "Name your library" })).toBeVisible();
  await page.getByLabel("Library name").fill(householdName);
  await page.getByRole("button", { name: "Create library" }).click();

  // AppShell's SyncGate (components/AppShell.tsx) holds the Home screen
  // behind a loading skeleton until the Electric shape stream reaches
  // "synced" or its own SYNC_STALL_TIMEOUT_MS (6s) fallback fires -- a brand
  // new household has no existing local mirror data to release the gate
  // early. Playwright's default 5s assertion timeout is shorter than that
  // 6s worst case, so this needs its own longer timeout or this step flakes
  // on a real (non-mocked) sync round-trip.
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible({ timeout: 10_000 });

  // page.request shares the browser context's session cookie, so this is
  // an authenticated call as the just-created user -- the household id
  // isn't otherwise exposed in the URL or DOM after onboarding.
  const me = await page.request.get("/api/me");
  expect(me.ok()).toBeTruthy();
  const body = await me.json();
  expect(body.memberships.length).toBeGreaterThan(0);
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
  // This toast (sonner, no custom duration set -- see
  // apps/web/src/components/ui/sonner.tsx) auto-dismisses after ~4s. A longer
  // timeout here helps against a merely-late render, but cannot rescue a
  // toast that already unmounted during a real stall -- the config's
  // `workers: 1` is what actually prevents that stall from happening.
  await expect(page.getByText(`Added "${title}"`)).toBeVisible({ timeout: 15_000 });
}
