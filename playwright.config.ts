import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Every spec's data (email, household name, book titles) is
  // randomUUID-scoped -- see e2e/helpers.ts -- so parallel spec files never
  // collide on the shared dev Postgres database. Data isolation is NOT the
  // constraint on running this suite in parallel, though: one non-scaled dev
  // stack (a single `tsx watch` API + one Vite dev server) backs the whole
  // suite, and each spec drives real UI against ~8 Electric shape long-polls
  // under HTTP/1.1's ~6-connection-per-origin cap. At Playwright's
  // auto-detected worker count the stack cannot keep up and specs fail on
  // assertion timeouts. Serial execution costs wall-clock time and buys
  // determinism, which is the right trade for a suite meant to gate a
  // production deploy (spec §11 step 6).
  workers: 1,
  // Generous per-test budget so individual specs don't each need their own
  // test.setTimeout() override -- see e2e/offline.spec.ts's own
  // test.setTimeout(120_000) for the one case that's still genuinely
  // different (that spec's own comment explains why).
  timeout: 90_000,
  // test.setTimeout() does not affect assertion timeouts. The default 5s is
  // too tight for this real dev stack -- AppShell's own SyncGate fallback
  // alone is 6s (see e2e/helpers.ts's signUpAndOnboard).
  expect: { timeout: 15_000 },
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
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm dev:web",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
