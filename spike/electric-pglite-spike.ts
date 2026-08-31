// Task 1 spike (throwaway): prove ElectricSQL's ShapeStream -> PGlite
// read-path works end to end against this repo's dev Postgres + Electric
// container, before Task 2+ build the real shape.ts/pglite.ts layer.
//
// Run: pnpm --filter @taakify/web exec tsx ../../spike/electric-pglite-spike.ts
// (or `npx tsx spike/electric-pglite-spike.ts` from repo root once tsx is
// resolvable — see task-1-report.md for exact invocation used).
//
// Findings are written up in:
// .superpowers/sdd/2026-08-02-taakify-plan-3-sync/task-1-report.md

import { PGlite } from "@electric-sql/pglite";
import { ShapeStream, isChangeMessage, isControlMessage, type Row } from "@electric-sql/client";

const ELECTRIC_URL = "http://localhost:3010/v1/shape";
// A real dev household id (queried directly from Postgres: `select id from household`).
const HOUSEHOLD_ID = process.env.SPIKE_HOUSEHOLD_ID ?? "0937824f-a6b1-4f4b-8529-916a9914f88e";

async function main() {
  console.log(`[spike] opening in-memory PGlite`);
  const db = new PGlite();

  console.log(`[spike] creating local mirror table "book_mirror"`);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS book_mirror (
      id uuid PRIMARY KEY,
      household_id uuid NOT NULL,
      edition_id uuid NOT NULL,
      ownership text NOT NULL,
      do_not_lend boolean NOT NULL,
      updated_at timestamptz NOT NULL,
      deleted_at timestamptz
    );
  `);

  console.log(`[spike] subscribing to shape: book WHERE household_id = ${HOUSEHOLD_ID}`);
  const stream = new ShapeStream({
    url: ELECTRIC_URL,
    params: {
      table: "book",
      where: `household_id = $1 AND deleted_at IS NULL`,
      params: { "1": HOUSEHOLD_ID },
      // Without this, `update` change messages only include the changed
      // columns + primary key (Electric's default "changes only" replica
      // mode) — a naive full-row upsert then writes `null` into NOT NULL
      // columns that weren't part of the diff. `replica: "full"` makes
      // Electric always send the complete row on insert/update, at the
      // cost of more bandwidth per message. See task-1-report.md.
      replica: "full",
    },
  });

  let sawUpToDate = false;
  const startedAt = Date.now();

  const unsubscribe = stream.subscribe(async (messages) => {
    for (const message of messages) {
      if (isControlMessage(message)) {
        console.log(`[spike] control message: ${JSON.stringify(message.headers)}`);
        if (message.headers.control === "up-to-date" && !sawUpToDate) {
          sawUpToDate = true;
          console.log(`[spike] UP TO DATE after ${Date.now() - startedAt}ms (initial catch-up)`);
        }
        continue;
      }
      if (isChangeMessage(message)) {
        const row = message.value as Row;
        const op = message.headers.operation;
        console.log(`[spike] change message op=${op} key=${message.key} value=${JSON.stringify(row)}`);

        if (op === "insert" || op === "update") {
          await db.query(
            `INSERT INTO book_mirror (id, household_id, edition_id, ownership, do_not_lend, updated_at, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               household_id = EXCLUDED.household_id,
               edition_id = EXCLUDED.edition_id,
               ownership = EXCLUDED.ownership,
               do_not_lend = EXCLUDED.do_not_lend,
               updated_at = EXCLUDED.updated_at,
               deleted_at = EXCLUDED.deleted_at`,
            [row.id, row.household_id, row.edition_id, row.ownership, row.do_not_lend, row.updated_at, row.deleted_at ?? null]
          );
        } else if (op === "delete") {
          await db.query(`DELETE FROM book_mirror WHERE id = $1`, [row.id]);
        }

        const { rows } = await db.query(`SELECT count(*)::int AS n FROM book_mirror`);
        console.log(`[spike] book_mirror now has ${(rows[0] as { n: number }).n} row(s)`);
      }
    }
  }, (error) => {
    console.error(`[spike] stream error`, error);
  });

  // Keep the process alive so external inserts (via psql/API in another
  // terminal) get streamed in. Ctrl-C to stop.
  console.log(`[spike] listening for changes... (Ctrl-C to stop)`);
  process.on("SIGINT", () => {
    unsubscribe();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[spike] fatal error`, err);
  process.exit(1);
});
