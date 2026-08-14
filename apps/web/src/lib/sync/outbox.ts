// Persisted offline write queue.
//
// Every tenant-data write that Task 6's repo layer makes goes through
// `enqueue()` instead of calling `api()` directly: it records the HTTP
// request to replay (endpoint/method/body) in the local `outbox` mirror
// table (Task 3's mirror-schema.sql) *and* applies an optimistic write to
// the relevant mirror table, atomically, so the UI reflects the change
// immediately while the real request replays in the background (possibly
// much later, if offline).
//
// `flush()` is the retry loop: it reads due `pending` rows, replays them
// against the real API, deletes them on success, and reschedules them with
// exponential backoff on failure. After the backoff schedule is exhausted a
// row is dead-lettered (`status = 'dead'`) and surfaced via a non-blocking
// toast with a Retry action -- see the dead-letter contract on
// `fireDeadLetterToast` below. Retries also resume automatically on the
// browser's `online` event and on a periodic timer (`startOutboxWorker`).
//
// Deliberately framework-agnostic (no React), matching shape.ts's pattern
// (Task 4) so it can be unit tested directly and driven from anywhere
// (a React effect today, a service worker later).
import { toast } from "sonner";
import { db, ready } from "../db/pglite.js";

// Retry backoff schedule in milliseconds, per the plan brief ("1s, 2s, 5s,
// 15s, 60s, then dead-letter"). `attempts` counts failures so far; the Nth
// failure schedules `BACKOFF_SCHEDULE_MS[N - 1]` as the delay before the
// next try. Once `attempts` reaches the schedule's length, the row is
// dead-lettered instead of scheduled again. Exported so tests can drive the
// exact schedule without hardcoding numbers that could silently drift.
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 15000, 60000];

/**
 * An optimistic local write to apply in the same PGlite transaction as the
 * outbox insert, so the UI reflects a write before the server has
 * confirmed it. Plain parameterized SQL (not a callback) so the shape of
 * "what enqueue does" stays fully inspectable/testable without needing a
 * PGlite transaction handle to leak into callers.
 */
export type OptimisticWrite = {
  sql: string;
  params?: unknown[];
};

export type OutboxRow = {
  id: string;
  endpoint: string;
  method: string;
  body: unknown;
  attempts: number;
  next_retry_at: string | null;
};

// --- Change notification ---------------------------------------------------
//
// Task 7's `use-sync-status.ts` hook and `SyncBadge` need to know when the
// outbox's pending/dead counts change, to re-render the sync status UI
// without polling. Every mutation point below (enqueue, flushRow's three
// outcomes, retry, dismiss) calls `notifyOutboxChange()` after committing,
// matching shape.ts's `onSyncedChange` observable pattern (Task 4) rather
// than introducing a second, different notification style. A plain
// listener set (not a value-carrying event) is enough -- callers just
// requery the counts/rows they care about, same as `onSyncedChange`.
const outboxListeners = new Set<() => void>();

function notifyOutboxChange(): void {
  for (const listener of outboxListeners) listener();
}

export function onOutboxChange(callback: () => void): () => void {
  outboxListeners.add(callback);
  return () => outboxListeners.delete(callback);
}

/**
 * Queue a write for the real API and, optionally, apply an optimistic
 * local mutation -- both inside one PGlite transaction, so a crash between
 * the two is impossible (either both happen or neither does).
 *
 * Accepts either a single `OptimisticWrite` or an array of them, applied in
 * order in the same transaction as the outbox insert -- e.g.
 * `repo/books.ts`'s `createBook` needs both an `edition` INSERT and the
 * `book` INSERT that references it to land atomically with the outbox row
 * when creating a book with a brand-new edition.
 *
 * Returns the outbox row's id (useful for tests / callers that want to
 * track the specific write, though most callers won't need it).
 */
export async function enqueue(
  endpoint: string,
  method: string,
  body?: unknown,
  optimisticSql?: OptimisticWrite | OptimisticWrite[]
): Promise<string> {
  await ready;
  const id = crypto.randomUUID();
  const statements = optimisticSql ? (Array.isArray(optimisticSql) ? optimisticSql : [optimisticSql]) : [];

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO outbox (id, endpoint, method, body) VALUES ($1, $2, $3, $4::jsonb)`, [
      id,
      endpoint,
      method,
      body === undefined ? null : JSON.stringify(body),
    ]);
    for (const stmt of statements) {
      await tx.query(stmt.sql, stmt.params ?? []);
    }
  });

  notifyOutboxChange();
  // Don't wait for the next periodic tick (up to 5s, see
  // startOutboxWorker's comment) to send a write made while online -- fire
  // a flush immediately after committing. Deliberately not awaited: enqueue
  // callers (the repo layer) return as soon as the optimistic write has
  // landed locally, same as before this fix; the real network request
  // still happens in the background exactly like a retry would. flush()'s
  // own `flushing` guard makes this safe to call even if a background
  // flush (timer/online-triggered) is already in flight.
  void flush();
  return id;
}

// Guards against overlapping flush passes (e.g. the periodic timer firing
// while an `online`-triggered flush is still in flight, or `enqueue()`'s
// own post-commit `void flush()` racing an explicit caller's `flush()`)
// -- without this, two concurrent flushes could both pick up the same row
// and double-send it.
//
// Deliberately a shared *promise*, not a boolean: every call while a pass
// is already running returns that SAME in-flight promise rather than
// silently no-op'ing, so `await flush()` always really does wait for a
// pass covering the currently-due rows to finish, no matter how many other
// callers (enqueue, the `online` listener, the periodic timer) triggered
// it concurrently. A boolean guard that just returned early on a
// concurrent call would let a caller's `await flush()` resolve before the
// row it cares about had actually been sent.
let inFlightFlush: Promise<void> | null = null;

/**
 * Replay every due `pending` outbox row against the real API. A row is
 * "due" if it has never failed (`next_retry_at IS NULL`) or its backoff
 * window has elapsed. Rows with `status = 'dead'` or `'dismissed'` are
 * never picked up here -- only `'pending'` rows are.
 */
export function flush(): Promise<void> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = runFlushPass().finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

async function runFlushPass(): Promise<void> {
  await ready;
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, endpoint, method, body, attempts, next_retry_at FROM outbox
     WHERE status = 'pending'
     ORDER BY created_at ASC`
  );
  const now = Date.now();
  const due = rows.filter((row) => !row.next_retry_at || new Date(row.next_retry_at).getTime() <= now);
  for (const row of due) {
    await flushRow(row);
  }
}

async function flushRow(row: OutboxRow): Promise<void> {
  let ok = false;
  try {
    const res = await fetch(row.endpoint, {
      method: row.method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: row.body == null ? undefined : JSON.stringify(parseBody(row.body)),
    });
    ok = res.ok;
  } catch {
    // Network failure (offline, DNS, etc.) -- treated the same as a
    // non-2xx response: retry with backoff.
    ok = false;
  }

  if (ok) {
    await db.query(`DELETE FROM outbox WHERE id = $1`, [row.id]);
    notifyOutboxChange();
    return;
  }

  const attempts = row.attempts + 1;
  if (attempts >= BACKOFF_SCHEDULE_MS.length) {
    await db.query(`UPDATE outbox SET attempts = $2, status = 'dead', next_retry_at = NULL WHERE id = $1`, [
      row.id,
      attempts,
    ]);
    fireDeadLetterToast({ ...row, attempts });
    notifyOutboxChange();
    return;
  }

  const delayMs = BACKOFF_SCHEDULE_MS[attempts - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await db.query(`UPDATE outbox SET attempts = $2, next_retry_at = $3 WHERE id = $1`, [
    row.id,
    attempts,
    nextRetryAt,
  ]);
  notifyOutboxChange();
}

// jsonb columns generally round-trip as parsed objects through PGlite's
// query results, but defend against a raw string coming back (e.g. a
// different pg client config) rather than assume the driver's behavior.
// Exported so every call site that hands a raw OutboxRow.body to
// describeOperation() parses it first -- see SyncBadge.tsx, which used to
// skip this (Minor finding, final review fix round).
export function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Dead-letter surfacing contract (plan brief, Task 5 Step 3):
 *
 * When a row exhausts its retries, fire a non-blocking `toast.error()` with
 * a Retry action. The toast names the failed operation in human terms
 * (see `describeOperation`) but is not the only record of the failure --
 * dismissing the toast does NOT drop the row. The dead-lettered row stays
 * in PGlite and remains visible in the SyncBadge's failed-operations list
 * (Task 7) until the user explicitly dismisses it there. This toast is
 * purely the "immediate awareness" layer; the badge list is the durable
 * one.
 */
function fireDeadLetterToast(row: OutboxRow): void {
  const description = describeOperation(row.endpoint, row.method, parseBody(row.body));
  const message = description ? `Couldn't save: ${description}` : "Couldn't save changes";
  toast.error(message, {
    action: {
      label: "Retry",
      onClick: () => {
        void retry(row.id);
      },
    },
  });
}

/**
 * Re-queue a dead-lettered (or otherwise stuck) row: reset `attempts` to 0,
 * `status` to `pending`, clear `next_retry_at`, then flush immediately.
 * This is what both the dead-letter toast's Retry button and (later)
 * Task 7's SyncBadge Retry action call.
 */
export async function retry(id: string): Promise<void> {
  await ready;
  await db.query(`UPDATE outbox SET attempts = 0, status = 'pending', next_retry_at = NULL WHERE id = $1`, [id]);
  notifyOutboxChange();
  await flush();
}

/**
 * Explicitly abandon a dead-lettered row: mark it `dismissed` rather than
 * `dead`. `flush()`'s query already filters `WHERE status = 'pending'`, so a
 * `dismissed` row (like a `dead` one) is never picked up again -- the only
 * difference is presentational: `listDeadLettered` below deliberately
 * excludes `dismissed` rows, so dismissing one is what makes it disappear
 * from the SyncBadge's failed-operations list (Task 7), whereas a `dead` row
 * stays listed until the user acts on it one way or the other.
 */
export async function dismiss(id: string): Promise<void> {
  await ready;
  await db.query(`UPDATE outbox SET status = 'dismissed' WHERE id = $1`, [id]);
  notifyOutboxChange();
}

/**
 * Dead-lettered rows only (not `dismissed` ones) -- the list `SyncBadge`
 * renders in its "Sync issue" dialog, each entry describable via
 * `describeOperation(endpoint, method, body)`.
 */
export async function listDeadLettered(): Promise<OutboxRow[]> {
  await ready;
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, endpoint, method, body, attempts, next_retry_at FROM outbox
     WHERE status = 'dead'
     ORDER BY created_at ASC`
  );
  return rows;
}

/**
 * Count of rows actively queued to retry (`status = 'pending'`) -- this is
 * deliberately *not* "every non-dead row": a `dismissed` row is something
 * the user explicitly chose to abandon, so it should not make the SyncBadge
 * (or the sign-out gate) read "Saving..." / treat it as an unsaved change.
 */
export async function countPending(): Promise<number> {
  await ready;
  const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox WHERE status = 'pending'`);
  return Number(rows[0]?.count ?? 0);
}

/** Count of permanently-failed rows still awaiting a Retry/Dismiss decision. */
export async function countDead(): Promise<number> {
  await ready;
  const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox WHERE status = 'dead'`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Derive a human-readable description of what an outbox row is trying to
 * do, from its endpoint/method/body alone (the outbox never stores an
 * entity's display name, e.g. a book's title, separately from the request
 * body that happens to carry it). This is a best-effort judgment call, not
 * a guarantee:
 *
 * - When the body itself carries a name/title (POST /api/books' nested
 *   `edition.title`, POST /api/contacts' `name`, POST /api/tags' `name`),
 *   it's included in the description.
 * - When it doesn't (e.g. PATCH /api/books/:id/status only carries
 *   `{ status }`, no book title -- the outbox row has no way to know which
 *   book without a lookup), the description names the *kind* of change
 *   instead (e.g. "mark as finished") rather than the specific entity.
 *   Resolving the entity name would require querying the PGlite mirror by
 *   the id embedded in the endpoint path -- deliberately not done here to
 *   keep this a pure, synchronous, side-effect-free function; see the task
 *   report for the tradeoff.
 * - Anything unrecognized falls back to `undefined`, which
 *   `fireDeadLetterToast` renders as the generic "Couldn't save changes".
 */
export function describeOperation(endpoint: string, method: string, body: unknown): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>;

  if (method === "POST" && /^\/api\/books\/?$/.test(endpoint)) {
    const edition = b.edition as Record<string, unknown> | undefined;
    const title = edition && typeof edition.title === "string" ? edition.title : undefined;
    return title ? `add "${title}"` : "add a book";
  }

  // apps/api/src/routes/reading-status.ts mounts this as
  // `readingStatus.put(...)`, and repo/reading-status.ts sends PUT to
  // match -- this used to check PATCH, which never matched a real request
  // (Minor finding, final review fix round).
  if (method === "PUT" && /^\/api\/books\/[^/]+\/status\/?$/.test(endpoint)) {
    return typeof b.status === "string" ? `mark as ${b.status}` : "update reading status";
  }

  if (method === "PATCH" && /^\/api\/books\/[^/]+\/?$/.test(endpoint)) {
    if ("do_not_lend" in b) return "update do-not-lend";
    if ("shelf_id" in b) return "move book to a shelf";
    if ("wishlist_priority" in b) return "update wishlist priority";
    return "update a book";
  }

  if (method === "POST" && /^\/api\/books\/[^/]+\/tags\/?$/.test(endpoint)) {
    return "tag a book";
  }

  if (method === "POST" && /^\/api\/loans\/?$/.test(endpoint)) {
    return "record a loan";
  }

  if (method === "PATCH" && /^\/api\/loans\/[^/]+\/?$/.test(endpoint)) {
    return "returned_date" in b ? "mark loan returned" : "update a loan";
  }

  if (method === "POST" && /^\/api\/contacts\/?$/.test(endpoint)) {
    const name = typeof b.name === "string" ? b.name : undefined;
    return name ? `add contact ${name}` : "add a contact";
  }

  if (method === "PATCH" && /^\/api\/contacts\/[^/]+\/?$/.test(endpoint)) {
    return "update contact";
  }

  if (method === "POST" && /^\/api\/tags\/?$/.test(endpoint)) {
    const name = typeof b.name === "string" ? b.name : undefined;
    return name ? `add tag "${name}"` : "add a tag";
  }

  if (method === "POST" && /^\/api\/bookcases\/?$/.test(endpoint)) {
    return "add a bookcase";
  }

  if (method === "POST" && /^\/api\/bookcases\/[^/]+\/shelves\/?$/.test(endpoint)) {
    return "add a shelf";
  }

  if (method === "PATCH" && /^\/api\/shelves\/[^/]+\/?$/.test(endpoint)) {
    return "update a shelf";
  }

  return undefined;
}

// --- Background worker: resume flushing on `online` and on a timer -------

let started = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

function onOnline(): void {
  void flush();
}

/**
 * Start the outbox's background retry triggers: an `online` event listener
 * (resume as soon as connectivity comes back) and a 5s periodic timer
 * (catch backoff windows elapsing while the tab is idle/backgrounded, and
 * as a fallback for environments where the `online` event is unreliable).
 * Idempotent per page load, matching `startSync`'s contract in shape.ts.
 */
export function startOutboxWorker(): void {
  if (started) return;
  started = true;
  window.addEventListener("online", onOnline);
  intervalId = setInterval(() => {
    void flush();
  }, 5000);
}

// Tear down the background worker -- for tests only, so each test starts
// from a clean slate regardless of whether a previous test called
// `startOutboxWorker`.
export function __resetOutboxWorkerForTests(): void {
  if (intervalId !== undefined) clearInterval(intervalId);
  window.removeEventListener("online", onOnline);
  intervalId = undefined;
  started = false;
}
