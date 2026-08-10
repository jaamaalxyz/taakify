import { Hono } from "hono";
import { withUser } from "../db/tenant.js";
import { type SessionUser } from "../middleware/session.js";
import { dateStr } from "../lib/date.js";
import { READING_STATUS_VALUES } from "@taakify/shared";

export const readingStatus = new Hono<{ Variables: { user: SessionUser } }>();

// requireUser is applied once, in app.ts, on the shared "/api/books/*"
// prefix — this sub-app is mounted there alongside books.ts and tags.ts's
// bookTags, so a per-sub-app "*" middleware here would run redundantly on
// every request to any /api/books/* path.
const VALID_STATUSES: readonly string[] = READING_STATUS_VALUES;

// PUT /api/books/:bookId/status — upserts the caller's own status row.
// household_id is never taken from the request body; it's derived server-side
// from the book row inside the same transaction, so a spoofed householdId in
// the body can't steer the write toward a household the caller doesn't own.
readingStatus.put("/:bookId/status", async (c) => {
  const user = c.get("user");
  const bookId = c.req.param("bookId");
  const body = await c.req.json<{
    status?: string;
    started_at?: string;
    finished_at?: string;
    rating?: number;
    review_note?: string;
  }>().catch(() => null);

  if (!body?.status || !VALID_STATUSES.includes(body.status)) {
    return c.json({ error: "status must be one of " + VALID_STATUSES.join(", ") }, 400);
  }
  if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
    return c.json({ error: "rating must be between 1 and 5" }, 400);
  }

  const result = await withUser(user.id, async (client) => {
    const { rows: bookRows } = await client.query(
      "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
      [bookId]
    );
    if (!bookRows[0]) return null;
    const householdId = bookRows[0].household_id;

    const { rows } = await client.query(
      `INSERT INTO reading_status (household_id, book_id, user_id, status, started_at, finished_at, rating, review_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (book_id, user_id) WHERE deleted_at IS NULL DO UPDATE
         SET status = EXCLUDED.status,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             rating = EXCLUDED.rating,
             review_note = EXCLUDED.review_note,
             updated_at = now()
       RETURNING id, book_id, user_id, status, started_at, finished_at, rating, review_note, updated_at`,
      [
        householdId,
        bookId,
        user.id,
        body.status,
        body.started_at ?? null,
        body.finished_at ?? null,
        body.rating ?? null,
        body.review_note ?? null,
      ]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return "forbidden" as const;
    throw err;
  });

  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json({
    status: {
      ...result,
      started_at: dateStr(result.started_at),
      finished_at: dateStr(result.finished_at),
    },
  });
});

// GET /api/books/:bookId/status — all members' status rows for the book.
// RLS already scopes reading_status to the caller's household(s); no extra filter needed.
readingStatus.get("/:bookId/status", async (c) => {
  const user = c.get("user");
  const bookId = c.req.param("bookId");

  const result = await withUser(user.id, async (client) => {
    const { rows: bookRows } = await client.query(
      "SELECT id FROM book WHERE id = $1 AND deleted_at IS NULL",
      [bookId]
    );
    if (!bookRows[0]) return null;

    const { rows } = await client.query(
      `SELECT id, book_id, user_id, status, started_at, finished_at, rating, review_note, updated_at
       FROM reading_status
       WHERE book_id = $1 AND deleted_at IS NULL`,
      [bookId]
    );
    return rows;
  });

  if (!result) return c.json({ error: "not found" }, 404);
  return c.json({
    statuses: result.map((row: any) => ({
      ...row,
      started_at: dateStr(row.started_at),
      finished_at: dateStr(row.finished_at),
    })),
  });
});
