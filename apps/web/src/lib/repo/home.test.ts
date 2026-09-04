// Repo-layer tests against a real (in-memory) PGlite instance -- same
// pattern as loans.test.ts/import.test.ts: seed rows directly and assert
// on the actual filtering/ordering/limit behavior of each read function.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { listOverdueLoans, listToReturnLoans, listCurrentlyReading, listRecentlyAdded } from "./home.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const OTHER_HOUSEHOLD = "00000000-0000-0000-0000-00000000000f";
const EDITION = "00000000-0000-0000-0000-00000000000b";
const USER = "user-1";

// Helper to generate UUIDs for tests - use a simple counter-based approach
let uuidCounter = 1;
const uuidCache: Record<string, string> = {};

function uuid(suffix: string): string {
  if (!uuidCache[suffix]) {
    const num = uuidCounter++;
    const hex = num.toString(16).padStart(12, "0");
    uuidCache[suffix] = `00000000-0000-0000-0000-${hex}`;
  }
  return uuidCache[suffix];
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function seedEdition(id: string, title: string) {
  await db.query(
    `INSERT INTO edition (id, title, authors, created_at, updated_at) VALUES ($1, $2, 'Author', now(), now())`,
    [id, title]
  );
}

async function seedBook(id: string, opts: { householdId?: string; editionId?: string; createdAt?: string } = {}) {
  await db.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'owned', $4, $5, now())`,
    [id, opts.householdId ?? HOUSEHOLD, opts.editionId ?? EDITION, USER, opts.createdAt ?? new Date().toISOString()]
  );
}

async function seedContact(id: string, name: string) {
  await db.query(
    `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, HOUSEHOLD, name, USER]
  );
}

async function seedLoan(
  id: string,
  bookId: string,
  contactId: string,
  opts: { direction?: "lent_out" | "borrowed_in"; dueDate?: string | null; returnedDate?: string | null } = {}
) {
  await db.query(
    `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, returned_date, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
    [
      id,
      HOUSEHOLD,
      bookId,
      contactId,
      opts.direction ?? "lent_out",
      todayStr(),
      opts.dueDate ?? null,
      opts.returnedDate ?? null,
      USER,
    ]
  );
}

async function seedReadingStatus(id: string, bookId: string, userId: string, status: string) {
  await db.query(
    `INSERT INTO reading_status (id, household_id, book_id, user_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [id, HOUSEHOLD, bookId, userId, status]
  );
}

beforeEach(async () => {
  // Reset UUID cache for each test to avoid collisions
  uuidCounter = 1;
  Object.keys(uuidCache).forEach((k) => delete uuidCache[k]);

  await ready;
  await db.exec("DELETE FROM reading_status");
  await db.exec("DELETE FROM loan");
  await db.exec("DELETE FROM contact");
  await db.exec("DELETE FROM book");
  await db.exec("DELETE FROM edition");
  await seedEdition(EDITION, "Default Edition");
});

afterAll(async () => {
  await db.close();
});

describe("listOverdueLoans", () => {
  it("returns only active loans past their due date, ordered most-overdue first, capped at 5", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedBook(uuid("03"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { dueDate: addDays(-1) }); // overdue by 1 day
    await seedLoan(uuid("l2"), uuid("02"), uuid("c1"), { dueDate: addDays(-5) }); // overdue by 5 days -- most overdue
    await seedLoan(uuid("l3"), uuid("03"), uuid("c1"), { dueDate: addDays(1) }); // not yet due

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result.map((l) => l.id)).toEqual([uuid("l2"), uuid("l1")]);
  });

  it("excludes returned loans, loans with no due date, and loans due today", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedBook(uuid("03"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { dueDate: addDays(-1), returnedDate: todayStr() }); // returned
    await seedLoan(uuid("l2"), uuid("02"), uuid("c1"), { dueDate: null }); // no due date
    await seedLoan(uuid("l3"), uuid("03"), uuid("c1"), { dueDate: todayStr() }); // due today -- not overdue

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });

  it("includes both loan directions", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { direction: "lent_out", dueDate: addDays(-1) });
    await seedLoan(uuid("l2"), uuid("02"), uuid("c1"), { direction: "borrowed_in", dueDate: addDays(-1) });

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result.map((l) => l.direction).sort()).toEqual(["borrowed_in", "lent_out"]);
  });

  it("caps results at 5 even when more than 5 loans are overdue", async () => {
    await seedContact(uuid("c1"), "Alex");
    for (let i = 0; i < 7; i++) {
      const bookKey = `b${i}`;
      const loanKey = `l${i}`;
      await seedBook(uuid(bookKey));
      await seedLoan(uuid(loanKey), uuid(bookKey), uuid("c1"), { dueDate: addDays(-1 - i) });
    }

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toHaveLength(5);
  });

  it("scopes to the given household", async () => {
    await seedBook(uuid("01"), { householdId: OTHER_HOUSEHOLD });
    await db.query(
      `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, 'Alex', $3, now(), now())`,
      [uuid("c-other"), OTHER_HOUSEHOLD, USER]
    );
    await db.query(
      `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'lent_out', $5, $6, $7, now(), now())`,
      [uuid("l1"), OTHER_HOUSEHOLD, uuid("01"), uuid("c-other"), todayStr(), addDays(-1), USER]
    );

    const result = await listOverdueLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });
});

describe("listToReturnLoans", () => {
  it("returns active borrowed_in loans not yet overdue, nearest due date first", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedBook(uuid("03"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { direction: "borrowed_in", dueDate: addDays(5) });
    await seedLoan(uuid("l2"), uuid("02"), uuid("c1"), { direction: "borrowed_in", dueDate: addDays(1) }); // soonest
    await seedLoan(uuid("l3"), uuid("03"), uuid("c1"), { direction: "borrowed_in", dueDate: null }); // no due date -- sorts last

    const result = await listToReturnLoans(HOUSEHOLD);

    expect(result.map((l) => l.id)).toEqual([uuid("l2"), uuid("l1"), uuid("l3")]);
  });

  it("a loan due exactly today counts as to-return, not overdue", async () => {
    await seedBook(uuid("01"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { direction: "borrowed_in", dueDate: todayStr() });

    const toReturn = await listToReturnLoans(HOUSEHOLD);
    const overdue = await listOverdueLoans(HOUSEHOLD);

    expect(toReturn.map((l) => l.id)).toEqual([uuid("l1")]);
    expect(overdue).toEqual([]);
  });

  it("excludes lent_out loans and overdue borrowed_in loans", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedContact(uuid("c1"), "Alex");
    await seedLoan(uuid("l1"), uuid("01"), uuid("c1"), { direction: "lent_out", dueDate: addDays(3) });
    await seedLoan(uuid("l2"), uuid("02"), uuid("c1"), { direction: "borrowed_in", dueDate: addDays(-1) }); // overdue

    const result = await listToReturnLoans(HOUSEHOLD);

    expect(result).toEqual([]);
  });
});

describe("listCurrentlyReading", () => {
  it("returns only status='reading' rows, most recently updated first", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedBook(uuid("03"));
    await seedReadingStatus(uuid("r1"), uuid("01"), "user-a", "reading");
    await new Promise((r) => setTimeout(r, 5));
    await seedReadingStatus(uuid("r2"), uuid("02"), "user-a", "reading");
    await seedReadingStatus(uuid("r3"), uuid("03"), "user-a", "finished"); // excluded

    const result = await listCurrentlyReading(HOUSEHOLD);

    expect(result.map((r) => r.book.id)).toEqual([uuid("02"), uuid("01")]);
  });

  it("includes rows from every member, not just one", async () => {
    await seedBook(uuid("01"));
    await seedBook(uuid("02"));
    await seedReadingStatus(uuid("r1"), uuid("01"), "user-a", "reading");
    await seedReadingStatus(uuid("r2"), uuid("02"), "user-b", "reading");

    const result = await listCurrentlyReading(HOUSEHOLD);

    expect(result.map((r) => r.user_id).sort()).toEqual(["user-a", "user-b"]);
  });
});

describe("listRecentlyAdded", () => {
  it("returns books newest-created first, respecting the limit", async () => {
    await seedBook(uuid("01"), { createdAt: "2026-01-01T00:00:00Z" });
    await seedBook(uuid("02"), { createdAt: "2026-03-01T00:00:00Z" }); // newest
    await seedBook(uuid("03"), { createdAt: "2026-02-01T00:00:00Z" });

    const result = await listRecentlyAdded(HOUSEHOLD, 2);

    expect(result.map((b) => b.id)).toEqual([uuid("02"), uuid("03")]);
  });

  it("defaults to a limit of 5 when none is given", async () => {
    for (let i = 0; i < 7; i++) {
      await seedBook(uuid(`b${i}`), { createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
    }

    const result = await listRecentlyAdded(HOUSEHOLD);

    expect(result).toHaveLength(5);
  });
});
