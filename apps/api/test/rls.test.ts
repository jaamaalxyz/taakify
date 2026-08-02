import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { withUser } from "../src/db/tenant.js";

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function seedUser(id: string) {
  await admin.query(
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, $1, $2)`,
    [id, `${id}@test.local`]
  );
}

async function seedHousehold(name: string, ownerId: string): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO household (name) VALUES ($1) RETURNING id", [name]
  );
  await admin.query(
    "INSERT INTO membership (household_id, user_id, role) VALUES ($1, $2, 'owner')",
    [rows[0].id, ownerId]
  );
  return rows[0].id;
}

describe("RLS household isolation", () => {
  const userA = `user-a-${randomUUID()}`;
  const userB = `user-b-${randomUUID()}`;
  let houseA: string;
  let houseB: string;

  beforeAll(async () => {
    await seedUser(userA);
    await seedUser(userB);
    houseA = await seedHousehold("House A", userA);
    houseB = await seedHousehold("House B", userB);
    const { rows } = await admin.query(
      "INSERT INTO edition (title) VALUES ('Sapiens') RETURNING id"
    );
    for (const [house, user] of [[houseA, userA], [houseB, userB]] as const) {
      await admin.query(
        "INSERT INTO book (household_id, edition_id, ownership, created_by) VALUES ($1, $2, 'owned', $3)",
        [house, rows[0].id, user]
      );
    }
  });

  afterAll(async () => await admin.end());

  it("a member sees only their own household's books", async () => {
    const books = await withUser(userA, async (c) =>
      (await c.query("SELECT household_id FROM book")).rows
    );
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((b) => b.household_id === houseA)).toBe(true);
  });

  it("a member cannot insert into another household", async () => {
    const { rows } = await admin.query("SELECT id FROM edition LIMIT 1");
    await expect(
      withUser(userA, (c) =>
        c.query(
          "INSERT INTO book (household_id, edition_id, ownership, created_by) VALUES ($1, $2, 'owned', $3)",
          [houseB, rows[0].id, userA]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a member cannot move or modify another household's rows via UPDATE", async () => {
    // Planting: updating an own row's household_id to another household must fail
    // (Postgres applies the UPDATE policy's USING as implicit WITH CHECK).
    const { rows: own } = await admin.query(
      "SELECT id FROM book WHERE household_id = $1 LIMIT 1", [houseA]
    );
    await expect(
      withUser(userA, (c) =>
        c.query("UPDATE book SET household_id = $1 WHERE id = $2", [houseB, own[0].id])
      )
    ).rejects.toThrow(/row-level security/);

    // Foreign row: invisible under USING, so UPDATE matches zero rows.
    const { rows: foreign } = await admin.query(
      "SELECT id FROM book WHERE household_id = $1 LIMIT 1", [houseB]
    );
    const result = await withUser(userA, (c) =>
      c.query("UPDATE book SET notes = 'hijacked' WHERE id = $1", [foreign[0].id])
    );
    expect(result.rowCount).toBe(0);
  });

  it("a user with no session setting sees nothing", async () => {
    const books = await withUser("nonexistent-user", async (c) =>
      (await c.query("SELECT id FROM book")).rows
    );
    expect(books).toHaveLength(0);
  });
});
