// Repo-layer unit tests against a real (in-memory) PGlite instance --
// Important 7, final whole-branch review (see tags.test.ts's header comment
// for the general rationale). This file's priority target is Important 3:
// createLoan's inline contact creation used to run as a bare, separate
// db.query() call BEFORE enqueue() was even invoked -- outside the outbox's
// atomic transaction. These tests assert on the ACTUAL outbox/mirror state
// after createLoan(), which is exactly what would have caught that gap (a
// mocked enqueue() call-args assertion, as the page-level tests use,
// can't see whether the contact insert landed atomically with the outbox
// row or not).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { createLoan, updateLoan } from "./loans.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const EDITION = "00000000-0000-0000-0000-00000000000b";
const USER = "user-1";

async function seedBook(id: string) {
  await db.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'owned', $4, now(), now())`,
    [id, HOUSEHOLD, EDITION, USER]
  );
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM loan");
  await db.exec("DELETE FROM contact");
  await db.exec("DELETE FROM book");
  // enqueue() now fires a background flush on every call (Critical 1 fix);
  // stub fetch to fail fast so these tests never make a real network call.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.close();
});

describe("createLoan atomicity (Important 3 regression)", () => {
  it("creating a loan with a brand-new contact writes both rows atomically as ONE outbox entry", async () => {
    const bookId = "00000000-0000-0000-0000-000000000020";
    await seedBook(bookId);

    const loanId = await createLoan({
      bookId,
      contactName: "Alex",
      direction: "lent_out",
      createdBy: USER,
    });

    // Exactly one outbox row -- the contact INSERT and the loan INSERT that
    // references it are collected into one enqueue() call, not two separate
    // writes with a crash window between them.
    const { rows: outboxRows } = await db.query<{ touched: { table: string; id: string }[] }>(
      "SELECT touched FROM outbox"
    );
    expect(outboxRows).toHaveLength(1);
    const tables = outboxRows[0].touched.map((t) => t.table).sort();
    expect(tables).toEqual(["contact", "loan"]);

    const { rows: contactRows } = await db.query<{ id: string; name: string }>("SELECT id, name FROM contact");
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0].name).toBe("Alex");

    const { rows: loanRows } = await db.query<{ id: string; contact_id: string }>(
      "SELECT id, contact_id FROM loan WHERE id = $1",
      [loanId]
    );
    expect(loanRows).toHaveLength(1);
    expect(loanRows[0].contact_id).toBe(contactRows[0].id);
  });

  it("the new contact's id matches the id sent to the server (newContactId), so a retry converges on the same row", async () => {
    const bookId = "00000000-0000-0000-0000-000000000021";
    await seedBook(bookId);

    await createLoan({ bookId, contactName: "Sam", direction: "borrowed_in", createdBy: USER });

    const { rows: contactRows } = await db.query<{ id: string }>("SELECT id FROM contact");
    const { rows: outboxRows } = await db.query<{ body: { newContactId?: string } }>(
      "SELECT body FROM outbox"
    );
    expect(outboxRows[0].body.newContactId).toBe(contactRows[0].id);
  });

  it("creating a loan with an existing contactId only writes the loan row (no contact insert)", async () => {
    const bookId = "00000000-0000-0000-0000-000000000022";
    const contactId = "00000000-0000-0000-0000-000000000023";
    await seedBook(bookId);
    await db.query(
      `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`,
      [contactId, HOUSEHOLD, "Existing Contact", USER]
    );

    await createLoan({ bookId, contactId, direction: "lent_out", createdBy: USER });

    const { rows: outboxRows } = await db.query<{ touched: { table: string; id: string }[] }>(
      "SELECT touched FROM outbox"
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].touched).toEqual([{ table: "loan", id: expect.any(String) }]);

    const { rows: contactRows } = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM contact");
    expect(contactRows[0].c).toBe(1); // still just the one seeded contact
  });
});

describe("updateLoan", () => {
  it("marks returned_date locally and enqueues the PATCH", async () => {
    const bookId = "00000000-0000-0000-0000-000000000024";
    await seedBook(bookId);
    const loanId = await createLoan({
      bookId,
      contactName: "Jordan",
      direction: "lent_out",
      createdBy: USER,
    });
    await db.exec("DELETE FROM outbox"); // isolate this test's own enqueue

    await updateLoan(loanId, { returned_date: "2026-01-15" });

    const { rows } = await db.query<{ returned_date: string }>(
      "SELECT returned_date FROM loan WHERE id = $1",
      [loanId]
    );
    expect(rows[0].returned_date).toBeTruthy();

    const { rows: outboxRows } = await db.query(`SELECT * FROM outbox WHERE endpoint = '/api/loans/${loanId}'`);
    expect(outboxRows).toHaveLength(1);
  });

  it("does nothing when given an empty input", async () => {
    const bookId = "00000000-0000-0000-0000-000000000025";
    await seedBook(bookId);
    const loanId = await createLoan({ bookId, contactName: "Robin", direction: "lent_out", createdBy: USER });
    await db.exec("DELETE FROM outbox");

    await updateLoan(loanId, {});

    const { rows } = await db.query("SELECT * FROM outbox");
    expect(rows).toHaveLength(0);
  });
});
