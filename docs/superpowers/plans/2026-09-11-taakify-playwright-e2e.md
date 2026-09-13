# Taakify Playwright E2E Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Playwright E2E suite the Public MVP Launch spec calls for (§7): one spec per screen (Home, Library, Add, Loans, Profile) covering that screen's primary action, plus one offline scenario proving the outbox actually flushes to the server on reconnect.

**Architecture:** A root-level `playwright.config.ts` and `e2e/` directory, run against the real dev stack (`pnpm dev:api` + `pnpm dev:web`, per spec §7 — Playwright's `webServer` option starts both if they aren't already running, and reuses them if they are). No database reset or seeding: every spec signs up a fresh user with a `randomUUID`-scoped email and household name — the same isolation pattern `apps/api/test/helpers.ts`'s `signUp()` already uses for API-level tests — so specs never collide on the shared dev Postgres database and nothing needs to be torn down between runs. Book-adding specs use the Add screen's Manual tab, not ISBN lookup, since ISBN lookup calls real external APIs (Open Library, Google Books — see `apps/api/src/routes/editions.ts`) and would make the suite flaky/network-dependent for no reason relevant to what these tests verify.

**Tech Stack:** `@playwright/test` (new root-level devDependency), Chromium only (no cross-browser matrix — matches the MVP-scope philosophy elsewhere in this spec, e.g. no OTel stack).

**Spec:** `docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md` (§7 Playwright E2E Suite, §10 Testing, §11 step 6)

## Global Constraints

- Spec §7, verbatim: "Playwright config at the repo root or in `apps/web`, run against `pnpm dev:api` + `pnpm dev:web` (and, before each production deploy, run once against the production build as a launch gate)." — this plan puts the config at the repo root (a cross-cutting suite spanning both `apps/api` and `apps/web`, not owned by either workspace) and wires it to the two existing `pnpm dev:api`/`pnpm dev:web` root scripts.
- Spec §7: "One spec per screen: Home, Library, Add, Loans, Profile — covering the primary action on each (e.g. Add: search-and-add a book; Loans: lend a book and see it appear as active)." Six spec files total (five screens + one offline scenario), each independently runnable.
- Spec §7: "One offline scenario: go offline (Playwright's network condition emulation), add a book, go back online, verify the outbox flushes and the book appears via sync — mirroring the original spec's §9 testing requirement."
- Prerequisite, not part of this plan's automation: Postgres + Electric must already be running (`docker compose -f docker-compose.dev.yml up -d`) and migrated (`pnpm migrate`), exactly as `CLAUDE.md`'s existing setup section already documents. This plan does not add database lifecycle management to the E2E suite — it reuses the same dev stack a developer already runs locally.
- Every spec must be independently runnable and order-independent: no spec may depend on state left behind by another spec, since Playwright may run spec files in parallel workers by default. This is safe here specifically because every spec's data (email, household name, book titles) is `randomUUID`-scoped and therefore never collides with another spec's data on the shared dev database.

---

## Task 1: Playwright scaffolding and a smoke spec

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/smoke.spec.ts`
- Modify: `package.json` (root) — add `@playwright/test` devDependency and a `test:e2e` script
- Modify: `.gitignore` — add Playwright's local output directories
- Modify: `CLAUDE.md` — document the new command and its prerequisites

**Interfaces:**
- Produces: `pnpm test:e2e` — the command every later task's spec files run under. `playwright.config.ts`'s `testDir: "./e2e"` and `baseURL: "http://localhost:5173"` are load-bearing for every later task — later specs use relative `page.goto("/signup")` etc., relying on this `baseURL`.

- [ ] **Step 1: Install Playwright at the workspace root**

```bash
pnpm add -D -w @playwright/test
pnpm exec playwright install chromium
```

(`-w` targets the root `package.json`, since this is a cross-cutting devDependency, not owned by `apps/api` or `apps/web`. The `playwright install` step downloads the Chromium binary Playwright drives — a one-time, machine-local step, not something `pnpm install` triggers automatically.)

- [ ] **Step 2: Add the root `test:e2e` script**

In root `package.json`, add to `"scripts"`:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 3: Create `playwright.config.ts`**

Create at the repo root:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Every spec's data (email, household name, book titles) is
  // randomUUID-scoped -- see e2e/helpers.ts -- so parallel spec files never
  // collide on the shared dev Postgres database. Safe to run with
  // Playwright's default worker count.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Prerequisite (not started here): docker compose -f docker-compose.dev.yml
  // up -d, then `pnpm migrate` -- see CLAUDE.md. These two dev servers are
  // what spec §7 means by "run against pnpm dev:api + pnpm dev:web";
  // reuseExistingServer means a developer who already has them running
  // (the normal CLAUDE.md workflow) doesn't pay a double-start cost.
  webServer: [
    {
      command: "pnpm dev:api",
      url: "http://localhost:3011/api/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "pnpm dev:web",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
```

- [ ] **Step 4: Write the smoke spec**

Create `e2e/smoke.spec.ts` — this proves the harness itself (config, webServer wiring, baseURL) works before Task 2 builds the shared helper every other spec depends on:

```ts
import { test, expect } from "@playwright/test";

test("the app loads and shows the landing page for a signed-out visitor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Taakify" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
});
```

- [ ] **Step 5: Run it**

Ensure the dev stack's prerequisites are up (`docker compose -f docker-compose.dev.yml up -d`, `pnpm migrate`, if not already running), then:

```bash
pnpm test:e2e
```

Expected: PASS, 1 test. Playwright's `webServer` config starts `dev:api`/`dev:web` automatically if they weren't already running (watch the output — it prints "Starting webServer..." the first time, "Reusing existing server..." on a later run with them already up).

- [ ] **Step 6: Add Playwright's output directories to `.gitignore`**

Add to `.gitignore`:

```
/test-results/
/playwright-report/
/blob-report/
```

- [ ] **Step 7: Document the command in `CLAUDE.md`**

In `CLAUDE.md`'s "## Commands" → "Test:" section, after the existing `pnpm test` line, add:

```
pnpm test:e2e                               # Playwright E2E suite (needs docker compose + pnpm migrate + dev:api/dev:web already runnable)
```

- [ ] **Step 8: Commit**

```bash
git add playwright.config.ts e2e/smoke.spec.ts package.json pnpm-lock.yaml .gitignore CLAUDE.md
git commit -m "feat: add Playwright E2E scaffolding and a smoke test"
```

---

## Task 2: Shared E2E helpers

**Files:**
- Create: `e2e/helpers.ts`

**Interfaces:**
- Consumes: nothing beyond `@playwright/test`'s `Page` type and Node's `node:crypto` `randomUUID`.
- Produces: `signUpAndOnboard(page: Page): Promise<{ email: string; householdId: string }>` and `addBookManually(page: Page, title: string): Promise<void>` — every later task's spec files (Tasks 3-8) import and call both of these. Their exact signatures and behavior are load-bearing: later tasks assume `signUpAndOnboard` leaves the browser on `/` (Home, authenticated, with a household already created) and that `addBookManually` leaves the browser on `/add` having shown the `Added "<title>"` toast.

- [ ] **Step 1: Write `e2e/helpers.ts`**

```ts
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
```

- [ ] **Step 2: Verify it compiles and is usable**

There's no independent test for a helpers module — it's exercised by every spec in Tasks 3-8. Confirm it type-checks cleanly as part of Task 3's first run (Playwright's TypeScript support type-checks on the fly; a syntax/type error in `helpers.ts` would surface as a failure in Task 3's spec run, not silently).

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers.ts
git commit -m "feat: add shared Playwright E2E signup and add-book helpers"
```

---

## Task 3: Home screen spec

**Files:**
- Create: `e2e/home.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard`, `addBookManually` from `./helpers.js` (Task 2).

- [ ] **Step 1: Write the spec**

Home's primary action (no literal example given in spec §7, unlike Add/Loans): a newly added book appearing under Home's "Recently added" section — this is the most direct, screen-specific observable effect Home offers, and chains naturally off the Add screen's own action rather than needing an isolated, artificial "primary action" for a page that's mostly a dashboard.

Create `e2e/home.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Home: a newly added book appears under Recently added", async ({ page }) => {
  await signUpAndOnboard(page);

  const title = `E2E Home Book ${randomUUID().slice(0, 8)}`;
  await addBookManually(page, title);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
});
```

Add the missing import at the top: `import { randomUUID } from "node:crypto";`

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/home.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/home.spec.ts
git commit -m "test: add Home screen E2E spec"
```

---

## Task 4: Library screen spec

**Files:**
- Create: `e2e/library.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard`, `addBookManually` from `./helpers.js` (Task 2).

- [ ] **Step 1: Write the spec**

Library's primary action: searching for a book by title and finding it (`apps/web/src/pages/Library.tsx:171-174` has a search `Input` with `aria-label="Search books"` and placeholder "Search by title or author").

Create `e2e/library.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/library.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/library.spec.ts
git commit -m "test: add Library screen E2E spec"
```

---

## Task 5: Add screen spec

**Files:**
- Create: `e2e/add.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard` from `./helpers.js` (Task 2). Does NOT reuse `addBookManually` here — this spec's whole job is to independently exercise the same UI interactions `addBookManually` encapsulates, so it writes them out directly rather than calling the helper (calling the helper here would make this spec test nothing that Task 3/4 didn't already exercise).

- [ ] **Step 1: Write the spec**

Add's primary action per spec §7's own example ("Add: search-and-add a book") is adding a book — this spec uses the Manual tab for the same determinism reason `addBookManually` does (documented in Task 2's helper comment), which is a deliberate, documented deviation from the spec's literal "search-and-add" wording: the ISBN-lookup path exists and is real, but making the E2E suite depend on a live third-party API (Open Library / Google Books) for a check that's really about "can a user successfully add a book" would trade determinism for a literal-but-superficial match to the example phrasing.

Create `e2e/add.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/add.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/add.spec.ts
git commit -m "test: add Add screen E2E spec"
```

---

## Task 6: Loans screen spec

**Files:**
- Create: `e2e/loans.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard`, `addBookManually` from `./helpers.js` (Task 2).

- [ ] **Step 1: Write the spec**

Loans' primary action, per spec §7's own example verbatim: "lend a book and see it appear as active." The Loans screen's "Add loan" dialog (`apps/web/src/pages/Loans.tsx`) needs a book to select (its `Select` is populated from the household's existing books), so this spec adds one first via the shared helper.

Create `e2e/loans.spec.ts`:

```ts
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard, addBookManually } from "./helpers.js";

test("Loans: lending a book makes it appear under Active", async ({ page }) => {
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
```

Note: the "New contact name" field (`id="lend-new-contact-name"`) only renders when the contact `Select`'s value is `+ New contact` — that's already the default (`NEW_CONTACT` constant in `Loans.tsx`), so no extra click is needed to reveal it.

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/loans.spec.ts
```

Expected: PASS. If the `Select`'s option-picking interaction doesn't behave as written (shadcn's `Select` is a Radix primitive rendered in a portal, which can need `page.getByRole("option", ...)` rather than a plain click on a rendered `<option>` — this file assumes Radix's accessible roles, matching how Radix Select is used elsewhere in this codebase), debug with `pnpm exec playwright test e2e/loans.spec.ts --debug` before changing the selector strategy.

- [ ] **Step 3: Commit**

```bash
git add e2e/loans.spec.ts
git commit -m "test: add Loans screen E2E spec"
```

---

## Task 7: Profile screen spec

**Files:**
- Create: `e2e/profile.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard` from `./helpers.js` (Task 2).

- [ ] **Step 1: Write the spec**

Profile's primary action: creating a household invite and seeing the shareable link (matching the existing unit-test convention in `apps/web/src/pages/Profile.test.tsx`: "invite dialog opens and creates an invite, showing the shareable URL" — this spec is the E2E equivalent of that same user story, against the real API instead of a mock).

Create `e2e/profile.spec.ts`:

```ts
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Profile: creating an invite shows a shareable link", async ({ page }) => {
  await signUpAndOnboard(page);

  await page.goto("/profile");

  await page.getByRole("button", { name: "Invite a family member" }).click();
  await expect(page.getByRole("heading", { name: "Invite a family member" })).toBeVisible();

  const inviteEmail = `e2e-invitee-${randomUUID()}@test.local`;
  await page.getByLabel("Email").fill(inviteEmail);
  await page.getByRole("button", { name: "Create invite" }).click();

  await expect(page.getByText("Invite created")).toBeVisible();
  const inviteUrlInput = page.getByLabel("Shareable link");
  await expect(inviteUrlInput).toHaveValue(/\/invite\//);
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/profile.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/profile.spec.ts
git commit -m "test: add Profile screen E2E spec"
```

---

## Task 8: Offline scenario spec

**Files:**
- Create: `e2e/offline.spec.ts`

**Interfaces:**
- Consumes: `signUpAndOnboard` from `./helpers.js` (Task 2). Does not use `addBookManually` — it needs to interleave the offline/online toggle with the add-book steps, so it writes them out directly (same rationale as Task 5).

- [ ] **Step 1: Write the spec**

The spec's own §7 wording: "go offline ... add a book, go back online, verify the outbox flushes and the book appears via sync." The decisive proof that a write actually reached the server (not merely the local PGlite mirror, which persists to IndexedDB and would still show the book after a page reload even if the sync had never happened) is calling the real API directly via `page.request` — which shares the browser context's session cookie — after the outbox has finished flushing.

`apps/web/src/components/SyncBadge.tsx` shows a destructive "Offline" badge whenever `navigator.onLine` is false (checked before its "Saving…" pending-count badge), and renders nothing (`null`) once online with zero pending/dead rows — so "the 'Offline' badge is gone and the app renders no sync badge at all" is the observable signal that the outbox has drained.

Create `e2e/offline.spec.ts`:

```ts
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Offline: a book added while offline syncs to the server once back online", async ({
  page,
  context,
}) => {
  const { householdId } = await signUpAndOnboard(page);
  const title = `E2E Offline Book ${randomUUID().slice(0, 8)}`;

  await page.goto("/add");
  await context.setOffline(true);

  await expect(page.getByText("Offline")).toBeVisible();

  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Add book" }).click();

  // The optimistic write succeeds locally even while offline -- the toast
  // and the "Offline" badge both show at once.
  await expect(page.getByText(`Added "${title}"`)).toBeVisible();
  await expect(page.getByText("Offline")).toBeVisible();

  // Confirm the write has NOT reached the server yet -- this is what makes
  // the later assertion meaningful, rather than trivially true regardless
  // of whether the outbox ever flushes.
  const beforeOnline = await page.request.get(`/api/books?householdId=${householdId}`);
  const beforeBody = await beforeOnline.json();
  expect(beforeBody.books.some((b: { edition: { title: string } }) => b.edition.title === title)).toBe(
    false
  );

  await context.setOffline(false);

  // outbox.ts flushes immediately on the browser's `online` event (not
  // waiting for its exponential-backoff schedule), so this should resolve
  // quickly -- the 10s timeout is generous headroom, not an expected wait.
  await expect(page.getByText("Offline")).not.toBeVisible({ timeout: 10_000 });

  // The decisive check: hit the real API (not the local PGlite mirror,
  // which would show this book either way) to confirm the outbox's queued
  // write actually reached Postgres.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/books?householdId=${householdId}`);
        const body = await res.json();
        return body.books.some((b: { edition: { title: string } }) => b.edition.title === title);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e e2e/offline.spec.ts
```

Expected: PASS. If the "Offline" badge assertion is flaky (a race between `context.setOffline(true)` and React re-rendering `SyncBadge` off the browser's `offline` event), add a short `page.waitForTimeout(200)` after `setOffline(true)` rather than removing the assertion — do not change this spec's approach without first confirming with `--debug` whether it's a genuine timing issue or a wrong selector.

- [ ] **Step 3: Run the full E2E suite together**

```bash
pnpm test:e2e
```

Expected: PASS, 7 tests total (smoke + 5 screens + offline) across whatever worker count Playwright's default picks.

- [ ] **Step 4: Commit**

```bash
git add e2e/offline.spec.ts
git commit -m "test: add offline-to-online sync E2E spec"
```

---

## Self-Review

**Spec coverage:** §7's three requirements are each covered — Playwright config against `dev:api`/`dev:web` (Task 1), one spec per screen with its primary action (Tasks 3-7: Home/Recently-added, Library/search, Add/manual-add, Loans/lend-and-see-active, Profile/create-invite), one offline scenario proving the outbox flushes to the server (Task 8). §11 step 6's framing ("most valuable once there's a production build to smoke-test against; also serves as the final pre-launch gate") is a future re-run against a prod build, not a new task this plan needs — the config built here is what that later gate reuses, pointed at a different `baseURL`.

**Placeholder scan:** No TBD/TODO markers. Every step has literal, runnable code. Two deliberate, explicitly-justified deviations from the spec's literal example wording are called out inline (Manual tab instead of ISBN lookup, in Tasks 2 and 5) rather than silently diverging.

**Type consistency:** `signUpAndOnboard`'s return type (`{ email: string; householdId: string }`) is used consistently — Task 8 is the only later task that actually consumes `householdId` (for its direct API check); Tasks 3-7 call `signUpAndOnboard(page)` without using its return value, which is fine (the function's side effects — leaving the browser on `/`, authenticated — are what those tasks need). `addBookManually(page: Page, title: string): Promise<void>` is called identically in Tasks 3 and 4.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-11-taakify-playwright-e2e.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
