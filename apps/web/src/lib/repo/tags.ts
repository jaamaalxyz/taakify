// Tags + book_tag repo layer — mirrors GET/POST /api/tags and
// GET/POST/DELETE /api/books/:bookId/tags in apps/api/src/routes/tags.ts.
//
// Server-side POST /api/tags is an idempotent get-or-create (a unique
// violation on tag_live_uniq is caught and the existing row returned
// instead of erroring). The optimistic local write below approximates that
// by checking for an existing (household_id, name) row first — if found, no
// local write or outbox entry is needed at all, since the tag already
// exists both locally and (presumably) on the server.
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import type { Tag } from "@taakify/shared";

export async function listTags(householdId: string): Promise<Tag[]> {
  await ready;
  const { rows } = await db.query<Tag>(
    `SELECT id, name, updated_at FROM tag WHERE household_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [householdId]
  );
  return rows;
}

export async function listBookTags(bookId: string): Promise<Tag[]> {
  await ready;
  const { rows } = await db.query<Tag>(
    `SELECT t.id, t.name, t.updated_at
     FROM book_tag bt JOIN tag t ON t.id = bt.tag_id
     WHERE bt.book_id = $1 AND bt.deleted_at IS NULL AND t.deleted_at IS NULL
     ORDER BY t.name`,
    [bookId]
  );
  return rows;
}

// Returns the tag (existing or newly created locally).
export async function findOrCreateTag(householdId: string, name: string, createdBy: string): Promise<Tag> {
  await ready;
  const { rows: existing } = await db.query<Tag>(
    "SELECT id, name, updated_at FROM tag WHERE household_id = $1 AND name = $2 AND deleted_at IS NULL",
    [householdId, name]
  );
  if (existing[0]) return existing[0];

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await enqueue(
    "/api/tags",
    "POST",
    { householdId, name },
    {
      sql: `INSERT INTO tag (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
      params: [id, householdId, name, createdBy, now],
    }
  );
  return { id, name, updated_at: now };
}

export async function attachBookTag(bookId: string, householdId: string, tagId: string): Promise<void> {
  await ready;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await enqueue(
    `/api/books/${bookId}/tags`,
    "POST",
    { tagId },
    {
      sql: `INSERT INTO book_tag (id, household_id, book_id, tag_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
      params: [id, householdId, bookId, tagId, now],
    }
  );
}

export async function removeBookTag(bookId: string, tagId: string): Promise<void> {
  await ready;
  await enqueue(`/api/books/${bookId}/tags/${tagId}`, "DELETE", undefined, {
    sql: `UPDATE book_tag SET deleted_at = now(), updated_at = now() WHERE book_id = $1 AND tag_id = $2 AND deleted_at IS NULL`,
    params: [bookId, tagId],
  });
}
