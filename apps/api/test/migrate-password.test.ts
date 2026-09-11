import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

// Same admin connection string test/global-setup.ts uses to migrate taakify_test.
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5433/taakify_test";
const CUSTOM_PASSWORD = "rotated-test-password-123";
const DEFAULT_PASSWORD = "taakify_app_dev";

function appPoolWith(password: string): pg.Pool {
  return new pg.Pool({
    connectionString: `postgresql://taakify_app:${password}@localhost:5433/taakify_test`,
  });
}

describe("migrate: taakify_app password parameterization", () => {
  // Every other test file's appPool() connects with DEFAULT_PASSWORD (see
  // test/env-setup.ts) -- restore it so later test files keep working
  // regardless of this test's outcome.
  afterAll(async () => {
    await migrate(ADMIN_URL);
  });

  it("sets the taakify_app role password from the appDbPassword option", async () => {
    await migrate(ADMIN_URL, { appDbPassword: CUSTOM_PASSWORD });

    const withNewPassword = appPoolWith(CUSTOM_PASSWORD);
    await expect(withNewPassword.query("SELECT 1")).resolves.toBeTruthy();
    await withNewPassword.end();

    const withOldPassword = appPoolWith(DEFAULT_PASSWORD);
    await expect(withOldPassword.query("SELECT 1")).rejects.toThrow(
      /password authentication failed/
    );
    await withOldPassword.end();
  });
});
