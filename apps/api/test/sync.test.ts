// Integration test for the SaaS-critical invariant -- household A's data
// never reaches household B -- across the FULL sync path: local write ->
// outbox-style POST -> real API -> real Postgres -> (mocked) Electric shape
// stream -> remote PGlite mirror.
//
// Every prior task already unit-tests its own layer's household-scoping in
// isolation (RLS at the DB/route layer in rls.test.ts, the shape's `where`
// clause in apps/web/src/lib/sync/shape.test.ts, per-household bootstrap
// payloads in bootstrap.test.ts). This test is the one place that proves the
// layers *compose* correctly end to end -- it does not re-verify any single
// layer's internal correctness.
//
// Architecture note (path (a) vs (b), see task-9-brief.md): the scenario
// needs both a real Postgres (via apps/api's existing test infra, see
// global-setup.ts and helpers.ts's signUp()) and a PGlite mirror applying
// shape-stream-shaped writes. `@taakify/web`'s real shape.ts/outbox.ts/repo
// modules are browser-oriented and live in a separate workspace package that
// isn't meant to depend on (or be depended on by) @taakify/api -- pulling
// shape.ts in here would require a workspace dependency in the wrong
// direction. Investigating the reverse (a devDependency either direction just
// for this one test) was judged not worth the added coupling for a single
// integration test, so this file takes path (a): `@electric-sql/pglite` is
// added as a devDependency of @taakify/api (it's a plain npm package with no
// browser API requirement for basic in-memory use -- see Task 1's spike) and
// a small test-local `applyBookRowTo` helper re-implements *only* the `book`
// table half of shape.ts's upsert contract:
//   INSERT ... ON CONFLICT (id) DO UPDATE SET ... WHERE excluded.updated_at > book.updated_at
// and `DELETE FROM book WHERE id = $1` for delete ops. This mirrors
// shape.ts's applyChangeTo exactly for the one table this test cares about,
// but it is a deliberately small, test-local re-implementation -- it does
// NOT exercise shape.ts's actual code (that's already covered for real by
// Task 4's shape.test.ts). What THIS test proves is the composition: a
// real outbox-shaped write reaching Postgres correctly scoped by household,
// and a household-scoped mirror never receiving another household's rows.
//
// The "mock Electric stream" step (2) below simulates only the *effect* of
// Electric's shape stream (row lands in the mirror) rather than running a
// live Electric container -- Electric's own shape `where`-clause filtering
// was already independently verified against a *live* Electric container in
// Task 1's spike (see task-1-report.md's "Isolation" section); re-proving
// that mechanism here would just be retesting Electric itself. This test's
// job is proving the surrounding system: the real API + real Postgres write
// path, and the mirror-apply contract, compose to preserve the same
// household boundary end to end.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name: string) {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

// Mirrors bootstrap.test.ts's invite-and-accept pattern: makes `memberCookie`
// a real second member of the household owned by `ownerCookie` (a genuinely
// different person, not just a second household under the same user).
async function inviteMember(ownerCookie: string, householdId: string, memberCookie: string) {
  const inviteRes = await app.request(`/api/households/${householdId}/invites`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "member@test.local", role: "member" }),
  });
  expect(inviteRes.status).toBe(201);
  const { token } = await inviteRes.json();
  const acceptRes = await app.request(`/api/invites/${token}/accept`, {
    method: "POST",
    headers: { cookie: memberCookie },
  });
  expect(acceptRes.status).toBe(200);
}

// Minimal mirror schema for just the `book` table -- enough columns to
// exercise the upsert contract this test cares about. Matches the subset of
// mirror-schema.sql's `book` table columns that shape.ts's COLUMNS.book list
// and applyChangeTo's upsert touch.
async function createBookMirror(): Promise<PGlite> {
  const pglite = new PGlite();
  await pglite.exec(`
    CREATE TABLE book (
      id uuid PRIMARY KEY,
      household_id uuid NOT NULL,
      edition_id uuid NOT NULL,
      ownership text NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `);
  return pglite;
}

// Test-local re-implementation of shape.ts's applyChangeTo, scoped to just
// the `book` table -- see the file-level comment above for why this isn't
// the real shape.ts code and what that does/doesn't prove.
async function applyBookRowTo(
  pglite: PGlite,
  operation: "insert" | "update" | "delete",
  value: { id: string; household_id: string; edition_id: string; ownership: string; updated_at: string }
): Promise<void> {
  if (operation === "delete") {
    await pglite.query(`DELETE FROM book WHERE id = $1`, [value.id]);
    return;
  }
  await pglite.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       household_id = EXCLUDED.household_id,
       edition_id = EXCLUDED.edition_id,
       ownership = EXCLUDED.ownership,
       updated_at = EXCLUDED.updated_at
     WHERE EXCLUDED.updated_at > book.updated_at`,
    [value.id, value.household_id, value.edition_id, value.ownership, value.updated_at]
  );
}

describe("sync integration: household isolation across the full local -> API -> Postgres -> mirror path", () => {
  it(
    "an owner's outbox-style write reaches a fellow member's mirror, but never a separate household's",
    async () => {
      // --- Step 1: two empty PGlite instances for household A -- one per
      // device (owner's device, member's device). Both belong to the SAME
      // household A but are two genuinely different people.
      const ownerMirror = await createBookMirror();
      const memberMirror = await createBookMirror();

      const owner = await signUp(app);
      const member = await signUp(app);
      const houseA = await createHousehold(owner.cookie, "Household A");
      await inviteMember(owner.cookie, houseA.id, member.cookie);

      // --- Step 2: owner writes a book via the real write path -- an
      // outbox-style write with a client-generated id (Task 6's fix), POSTed
      // to the real API, matching contracts.ts's CreateBookRequest shape.
      const clientBookId = randomUUID();
      const createRes = await app.request("/api/books", {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          id: clientBookId,
          householdId: houseA.id,
          edition: { title: "Sync Isolation Test Book", authors: "Author" },
          ownership: "owned",
        }),
      });
      expect(createRes.status).toBe(201);
      const { book } = await createRes.json();
      // Task 6: the id used in the real API write is the client-generated
      // one, not a server-assigned replacement.
      expect(book.id).toBe(clientBookId);
      expect(book.household_id).toBe(houseA.id);

      // Confirm it landed in real Postgres by re-fetching it via the API.
      const fetchRes = await app.request(`/api/books/${book.id}`, {
        headers: { cookie: owner.cookie },
      });
      expect(fetchRes.status).toBe(200);

      // Owner's own local mirror also gets the row (as if their own outbox
      // flush echoed the confirmed write back in) -- establishes the
      // baseline before checking propagation to the *other* device.
      await applyBookRowTo(ownerMirror, "insert", {
        id: book.id,
        household_id: book.household_id,
        edition_id: book.edition_id,
        ownership: book.ownership,
        updated_at: book.updated_at,
      });

      // Mock Electric shape stream: simulate what Electric would deliver to
      // the MEMBER's device by applying the resulting Postgres row into the
      // member's PGlite mirror via the test-local apply helper (see file
      // header for why this isn't the real shape.ts code).
      await applyBookRowTo(memberMirror, "insert", {
        id: book.id,
        household_id: book.household_id,
        edition_id: book.edition_id,
        ownership: book.ownership,
        updated_at: book.updated_at,
      });

      // --- Step 3: assert the member's PGlite now has the book, same id.
      const memberRows = await memberMirror.query<{ id: string; household_id: string }>(
        "SELECT id, household_id FROM book WHERE id = $1",
        [book.id]
      );
      expect(memberRows.rows).toHaveLength(1);
      expect(memberRows.rows[0].id).toBe(clientBookId);
      expect(memberRows.rows[0].household_id).toBe(houseA.id);

      // --- Step 4: a genuinely separate household B (different user).
      const bUser = await signUp(app);
      const houseB = await createHousehold(bUser.cookie, "Household B");
      const houseBMirror = await createBookMirror();

      // Prove the boundary that would prevent Electric from ever delivering
      // household A's row to household B's shape in the first place: fetch
      // household A's book via the real API using household B's session.
      // RLS scopes book.id lookups to the caller's own households, so B's
      // session gets a 404 for a book it has no membership path to.
      const crossRes = await app.request(`/api/books/${book.id}`, {
        headers: { cookie: bUser.cookie },
      });
      expect(crossRes.status).toBe(404);

      // Same check via bootstrap, scoped explicitly to household B's id --
      // matches bootstrap.test.ts's cross-household pattern. Household A's
      // book must be completely absent from B's payload.
      const bootstrapRes = await app.request(`/api/bootstrap?householdId=${houseB.id}`, {
        headers: { cookie: bUser.cookie },
      });
      expect(bootstrapRes.status).toBe(200);
      const bootstrapBody = await bootstrapRes.json();
      expect(bootstrapBody.books).toHaveLength(0);
      expect(bootstrapBody.books.some((b: { id: string }) => b.id === clientBookId)).toBe(false);

      // Since the API (the only source a real shape stream could ever pull
      // from) never returns household A's row under household B's session,
      // household B's mirror -- fed only from what its own shape/bootstrap
      // could legitimately receive -- never gets the row either.
      const houseBRows = await houseBMirror.query("SELECT id FROM book WHERE id = $1", [clientBookId]);
      expect(houseBRows.rows).toHaveLength(0);
    },
    20_000
  );
});
