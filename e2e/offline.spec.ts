import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUpAndOnboard } from "./helpers.js";

test("Offline: a book added while offline syncs to the server once back online", async ({
  page,
  context,
}) => {
  // Three full-page navigations worth of work (signup -> onboarding -> /add),
  // each re-establishing several Electric shape long-polls plus module
  // fetches under this dev environment's ~6-concurrent-connection-per-origin
  // limit -- see Task 3's home.spec.ts for the same pattern and rationale.
  // Also see the timeout note below the final expect.poll: this spec's own
  // shape (a write made while offline, then coming back online) reliably
  // needs much more headroom than that alone would suggest.
  test.setTimeout(120_000);

  const { householdId } = await signUpAndOnboard(page);
  const title = `E2E Offline Book ${randomUUID().slice(0, 8)}`;

  await page.goto("/add");

  // Wait for the Add screen to actually render before going offline.
  // HouseholdProvider (lib/household-context.tsx) fetches /api/me on mount
  // and shows a fatal "Couldn't load your library" alert on any fetch
  // failure -- page.goto() resolving on the load event doesn't guarantee
  // that in-flight fetch has already settled, so flipping offline too early
  // aborts it and replaces the whole AppShell with that error screen
  // instead of the Add screen this test needs.
  await expect(page.getByRole("tab", { name: "Manual" })).toBeVisible();

  await context.setOffline(true);

  // A short grace period for React to re-render SyncBadge off the browser's
  // `offline` event -- context.setOffline(true) fires that event
  // asynchronously, and the badge update can lag Playwright's next
  // assertion by a beat.
  await page.waitForTimeout(200);

  // exact: true -- the book title itself contains the substring "Offline"
  // ("E2E Offline Book ..."), which would otherwise also match this locator
  // once the "Added ..." toast (below) is on screen.
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Add book" }).click();

  // The optimistic write succeeds locally even while offline -- the toast
  // and the "Offline" badge both show at once.
  await expect(page.getByText(`Added "${title}"`)).toBeVisible();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();

  // Confirm the write has NOT reached the server yet -- this is what makes
  // the later assertion meaningful, rather than trivially true regardless
  // of whether the outbox ever flushes.
  const beforeOnline = await page.request.get(`/api/books?householdId=${householdId}`);
  const beforeBody = await beforeOnline.json();
  expect(beforeBody.books.some((b: { edition: { title: string } }) => b.edition.title === title)).toBe(
    false
  );

  await context.setOffline(false);

  // outbox.ts flushes immediately on the browser's `online` event, so the
  // "Offline" badge itself clears almost instantly (that event flips
  // navigator.onLine, which SyncBadge reads directly) -- this is
  // independent of the outbox row's own flush/retry timing below.
  await expect(page.getByText("Offline", { exact: true })).not.toBeVisible({ timeout: 10_000 });

  // The decisive check: hit the real API (not the local PGlite mirror,
  // which would show this book either way) to confirm the outbox's queued
  // write actually reached Postgres.
  //
  // Timeout note (found via investigation with page/request-event
  // instrumentation, not guessed): in every observed run, the outbox's
  // very first flush attempt after context.setOffline(false) -- fired
  // immediately off the browser's `online` event, reusing the page's
  // existing fetch/connection state from before going offline -- hangs for
  // the full outbox.ts FLUSH_FETCH_TIMEOUT_MS (15s) before failing with
  // `net::ERR_ABORTED`, even though the browser is genuinely back online by
  // then; a subsequent attempt (after the backoff delay) typically
  // succeeds in well under a second, but occasionally also hangs the same
  // way, compounding with BACKOFF_SCHEDULE_MS's own delays between
  // attempts. This reads as a real Chromium/CDP quirk around reusing a
  // connection that was live before the network was toggled offline, not a
  // bug in outbox.ts's retry logic (each retry is correctly triggered; it's
  // the underlying fetch that stalls) -- and this dev environment's
  // HTTP/1.1 ~6-connection-per-origin limit (shared with several
  // concurrently-reconnecting Electric shape streams) plausibly compounds
  // it. 60s comfortably covers the two-hang case seen during
  // investigation without approaching outbox.ts's own dead-letter point
  // (5 exhausted attempts) -- a genuine regression (the row never sending)
  // would still fail this.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/books?householdId=${householdId}`);
        const body = await res.json();
        return body.books.some((b: { edition: { title: string } }) => b.edition.title === title);
      },
      { timeout: 60_000 }
    )
    .toBe(true);
});
