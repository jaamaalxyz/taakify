// Bookcases + shelves repo layer — mirrors GET/POST /api/bookcases and
// POST/PATCH/DELETE /api/shelves in apps/api/src/routes/shelves.ts.
//
// See books.ts's header comment for the general "why no client-supplied id"
// caveat — it applies here too (POST /api/bookcases and POST
// /api/bookcases/:id/shelves both let the server assign the id; the shelf
// endpoint also has the server compute `position` as MAX+1, which the
// optimistic write below approximates locally against the mirror's current
// rows — a genuine, if rare, race with a concurrent server-side create from
// another device).
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
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
    { householdId, name },
    {
      sql: `INSERT INTO bookcase (id, household_id, name, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5)`,
      params: [id, householdId, name, createdBy, now],
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
    { label: label || undefined },
    {
      sql: `INSERT INTO shelf (id, household_id, bookcase_id, position, label, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      params: [id, householdId, bookcaseId, position, label || null, createdBy, now],
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

  await enqueue(`/api/shelves/${shelfId}`, "PATCH", input, {
    sql: `UPDATE shelf SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    params,
  });
}

export async function deleteShelf(shelfId: string): Promise<void> {
  await ready;
  await enqueue(`/api/shelves/${shelfId}`, "DELETE", undefined, {
    sql: `UPDATE shelf SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    params: [shelfId],
  });
}

// Not part of any current screen's API surface, but kept here as the type
// re-export point so callers (Add.tsx, BookDetail.tsx) can import Shelf /
// Bookcase from one place instead of duplicating the shape.
export type { Bookcase, Shelf };
