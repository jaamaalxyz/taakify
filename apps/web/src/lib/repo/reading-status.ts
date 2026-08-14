// Reading-status repo layer — mirrors PUT/GET /api/books/:bookId/status in
// apps/api/src/routes/reading-status.ts (a full-replace upsert keyed on
// (book_id, user_id)).
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import { OPTIMISTIC_UPDATED_AT } from "../sync/optimistic-clock.js";
import type { ReadingStatus, ReadingStatusRow } from "@taakify/shared";

export async function listReadingStatuses(bookId: string): Promise<ReadingStatusRow[]> {
  await ready;
  const { rows } = await db.query<ReadingStatusRow>(
    `SELECT id, book_id, user_id, status, started_at, finished_at, rating, review_note, updated_at
     FROM reading_status
     WHERE book_id = $1 AND deleted_at IS NULL`,
    [bookId]
  );
  return rows;
}

export interface UpsertReadingStatusInput {
  status: ReadingStatus;
  started_at?: string | null;
  finished_at?: string | null;
  rating?: number | null;
  review_note?: string | null;
}

// household_id is looked up locally from the book's mirror row, matching
// the server deriving it from the book row rather than trusting a client
// value (reading-status.ts).
export async function upsertMyReadingStatus(
  bookId: string,
  userId: string,
  input: UpsertReadingStatusInput
): Promise<void> {
  await ready;
  const { rows: bookRows } = await db.query<{ household_id: string }>(
    "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
    [bookId]
  );
  const householdId = bookRows[0]?.household_id ?? null;

  const { rows: existing } = await db.query<{ id: string }>(
    "SELECT id FROM reading_status WHERE book_id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [bookId, userId]
  );

  const now = new Date().toISOString();
  const startedAt = input.started_at ?? null;
  const finishedAt = input.finished_at ?? null;
  const rating = input.rating ?? null;
  const reviewNote = input.review_note ?? null;

  // A client-supplied `id` only matters for the true-INSERT branch (this
  // household member's very first status write for this book) — on the
  // UPDATE branch the existing row already has its own id, and the
  // server's ON CONFLICT (book_id, user_id) upsert correctly preserves it
  // regardless of what id we send, so there's nothing to thread through.
  const newId = existing[0] ? undefined : crypto.randomUUID();
  // updated_at is stamped with OPTIMISTIC_UPDATED_AT (not "now") in both
  // branches so a fast local clock can't cause the LWW guard in
  // shape.ts's applyChangeTo to reject the server's real row once this
  // write syncs back down — see optimistic-clock.ts.
  const optimistic = existing[0]
    ? {
        sql: `UPDATE reading_status SET status = $2, started_at = $3, finished_at = $4, rating = $5, review_note = $6, updated_at = $7
              WHERE id = $1`,
        params: [existing[0].id, input.status, startedAt, finishedAt, rating, reviewNote, OPTIMISTIC_UPDATED_AT],
      }
    : {
        sql: `INSERT INTO reading_status (id, household_id, book_id, user_id, status, started_at, finished_at, rating, review_note, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        params: [
          newId,
          householdId,
          bookId,
          userId,
          input.status,
          startedAt,
          finishedAt,
          rating,
          reviewNote,
          now,
          OPTIMISTIC_UPDATED_AT,
        ],
      };

  await enqueue(
    `/api/books/${bookId}/status`,
    "PUT",
    {
      id: newId,
      status: input.status,
      started_at: input.started_at ?? undefined,
      finished_at: input.finished_at ?? undefined,
      rating: input.rating ?? undefined,
      review_note: input.review_note ?? undefined,
    },
    optimistic
  );
}
