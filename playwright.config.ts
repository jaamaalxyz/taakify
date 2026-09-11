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
