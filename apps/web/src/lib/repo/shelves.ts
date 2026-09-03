// Bookcases + shelves repo layer — mirrors GET/POST /api/bookcases and
// POST/PATCH/DELETE /api/shelves in apps/api/src/routes/shelves.ts.
//
// createBookcase/createShelf generate the id client-side and send it in the
// request body (`CreateBookcaseRequest.id`, `CreateShelfRequest.id`) — see
// books.ts's header comment for the general client-supplied-id rationale.
// The shelf endpoint also has the server compute `position` as MAX+1, which
// the optimistic write below approximates locally against the mirror's
// current rows — a genuine, if rare, race with a concurrent server-side
// create from another device (unrelated to the id-convergence fix; the
// server route short-circuits and skips recomputing position on an
// id-retry, so this race is no worse than it was before).
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import { OPTIMISTIC_UPDATED_AT } from "../sync/optimistic-clock.js";
import type { Bookcase, Shelf } from "@taakify/shared";

type BookcaseShelfRow = {
  id: string;
  name: string;
  updated_at: string;
  shelf_id: string | null;
  position: number | null;
  label: string | null;
  shelf_updated_at: string | null;
};

export async function listBookcases(householdId: string): Promise<Bookcase[]> {
  await ready;
  const { rows } = await db.query<BookcaseShelfRow>(
    `SELECT b.id, b.name, b.updated_at,
            s.id AS shelf_id, s.position, s.label, s.updated_at AS shelf_updated_at
     FROM bookcase b
     LEFT JOIN shelf s ON s.bookcase_id = b.id AND s.deleted_at IS NULL
     WHERE b.household_id = $1 AND b.deleted_at IS NULL
     ORDER BY b.name, s.position`,
    [householdId]
  );

  const byId = new Map<string, Bookcase>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, { id: row.id, name: row.name, updated_at: row.updated_at, shelves: [] });
    }
    if (row.shelf_id) {
      byId.get(row.id)!.shelves.push({
        id: row.shelf_id,
        position: row.position!,
        label: row.label,
        updated_at: row.shelf_updated_at!,
      });
    }
  }
  return Array.from(byId.values());
}

export async function createBookcase(householdId: string, name: string, createdBy: string): Promise<string> {
  await ready;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await enqueue(
    "/api/bookcases",
    "POST",
    { id, householdId, name },
    {
      sql: `INSERT INTO bookcase (id, household_id, name, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      params: [id, householdId, name, createdBy, now, OPTIMISTIC_UPDATED_AT],
    }
  );
  return id;
}

export async function createShelf(
  bookcaseId: string,
  householdId: string,
  label: string | undefined,
  createdBy: string
): Promise<string> {
  await ready;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { rows } = await db.query<{ next_position: number }>(
    "SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM shelf WHERE bookcase_id = $1 AND deleted_at IS NULL",
    [bookcaseId]
  );
  const position = rows[0]?.next_position ?? 1;

  await enqueue(
    `/api/bookcases/${bookcaseId}/shelves`,
    "POST",
    { id, label: label || undefined },
    {
      sql: `INSERT INTO shelf (id, household_id, bookcase_id, position, label, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      params: [id, householdId, bookcaseId, position, label || null, createdBy, now, OPTIMISTIC_UPDATED_AT],
    }
  );
  return id;
}

export interface UpdateShelfInput {
  label?: string;
  position?: number;
}

export async function updateShelf(shelfId: string, input: UpdateShelfInput): Promise<void> {
  await ready;
  const allowed = ["label", "position"] as const;
  const sets: string[] = [];
  const params: unknown[] = [shelfId];
  let i = 2;
  for (const key of allowed) {
    if (key in input) {
      sets.push(`${key} = $${i}`);
      params.push((input as Record<string, unknown>)[key]);
      i++;
    }
  }
  if (!sets.length) return;

  // See optimistic-clock.ts — updated_at is a sentinel, not the browser's
  // clock, so a fast local clock can't cause the LWW guard to reject the
  // server's real row once this write syncs back down.
  params.push(OPTIMISTIC_UPDATED_AT);
  await enqueue(`/api/shelves/${shelfId}`, "PATCH", input, {
    sql: `UPDATE shelf SET ${sets.join(", ")}, updated_at = $${i} WHERE id = $1 AND deleted_at IS NULL`,
    params,
  });
}

/**
 * Reassign every shelf in `shelfIds` to its 1-based index as its new
 * position, in the given (final) order -- issue #13. Mirrors
 * `POST /api/bookcases/:id/reorder`'s atomic UPDATE loop: all positions are
 * written as one optimistic transaction alongside a single outbox row (like
 * createLoan's multi-statement enqueue), rather than the old approach of two
 * separate PATCH /api/shelves/:id calls with a partial-failure window
 * between them.
 */
export async function reorderShelves(bookcaseId: string, shelfIds: string[]): Promise<void> {
  await ready;
  const statements = shelfIds.map((shelfId, index) => ({
    sql: `UPDATE shelf SET position = $2, updated_at = $3 WHERE id = $1 AND deleted_at IS NULL`,
    params: [shelfId, index + 1, OPTIMISTIC_UPDATED_AT],
  }));
  await enqueue(`/api/bookcases/${bookcaseId}/reorder`, "POST", { shelfIds }, statements);
}

export async function deleteShelf(shelfId: string): Promise<void> {
  await ready;
  await enqueue(`/api/shelves/${shelfId}`, "DELETE", undefined, {
    sql: `UPDATE shelf SET deleted_at = now(), updated_at = $2 WHERE id = $1 AND deleted_at IS NULL`,
    params: [shelfId, OPTIMISTIC_UPDATED_AT],
  });
}

// Not part of any current screen's API surface, but kept here as the type
// re-export point so callers (Add.tsx, BookDetail.tsx) can import Shelf /
// Bookcase from one place instead of duplicating the shape.
export type { Bookcase, Shelf };
