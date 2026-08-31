// Tags + book_tag repo layer — mirrors GET/POST /api/tags and
// GET/POST/DELETE /api/books/:bookId/tags in apps/api/src/routes/tags.ts.
//
// Server-side POST /api/tags is an idempotent get-or-create (a unique
// violation on tag_live_uniq is caught and the existing row returned
// instead of erroring). The optimistic local write below approximates that
// by checking for an existing (household_id, name) row first — if found, no
// local write or outbox entry is needed at all, since the tag already
// exists both locally and (presumably) on the server.
//
// findOrCreateTag sends the generated id as `CreateTagRequest.id` (see
// books.ts's header comment for the general rationale) so a retried outbox
// row converges on the same tag id server-side. Residual gap: if two
// different callers race to create a tag with the same name under
// different ids (e.g. two members, both offline, both add "sci-fi"), the
// server's existing name-uniqueness fallback (catch 23505 on
// tag_live_uniq, re-select by name) still wins on the SECOND request that
// reaches it — but the loser's optimistic local id has no way to be
// reconciled with the row the server actually kept. This is strictly
// narrower than the bug this fix round closes (which affected every
// create, not just same-name races) and is accepted as-is per the reviewed
// fix design.
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import { OPTIMISTIC_UPDATED_AT } from "../sync/optimistic-clock.js";
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
    { id, householdId, name },
    {
      sql: `INSERT INTO tag (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      params: [id, householdId, name, createdBy, now, OPTIMISTIC_UPDATED_AT],
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
    // `id` now reaches the server (AttachBookTagRequest.id) so the
    // optimistic local row above and the eventual synced-down server row
    // converge on the same id instead of permanently duplicating — see
    // apps/api/src/routes/tags.ts's POST /:bookId/tags for the matching
    // server-side upsert (Critical 3, final review fix round).
    { id, tagId },
    {
      sql: `INSERT INTO book_tag (id, household_id, book_id, tag_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      params: [id, householdId, bookId, tagId, now, OPTIMISTIC_UPDATED_AT],
      // The statement targets a book_tag join row, but no surface renders
      // book_tag rows — the visible thing that goes stale when this write
      // dead-letters is the book's tag list, so that's the row the
      // "Unsynced" badge should sit on (issue #16 review finding: without
      // this override, a failed tag add/remove badges nothing at all).
      touched: [{ table: "book", id: bookId }],
    }
  );
}

export async function removeBookTag(bookId: string, tagId: string): Promise<void> {
  await ready;
  await enqueue(`/api/books/${bookId}/tags/${tagId}`, "DELETE", undefined, {
    sql: `UPDATE book_tag SET deleted_at = now(), updated_at = $3 WHERE book_id = $1 AND tag_id = $2 AND deleted_at IS NULL`,
    params: [bookId, tagId, OPTIMISTIC_UPDATED_AT],
    // Same rationale as attachBookTag above — plus the derived pair here
    // would be actively wrong: the first bound param is bookId, but the
    // statement's table is book_tag, whose PK is neither bookId nor tagId,
    // so the convention would record a nonexistent row id.
    touched: [{ table: "book", id: bookId }],
  });
}
