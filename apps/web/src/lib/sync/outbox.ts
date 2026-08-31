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
// next try. Once `attempts` exceeds the schedule's length (i.e. every slot,
// including the final 60s one, has been used as a wait), the row is
// dead-lettered instead of scheduled again. Exported so tests can drive the
// exact schedule without hardcoding numbers that could silently drift.
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 15000, 60000];

// Per-request timeout for outbox replays. Rows flush sequentially and every
// flush trigger (timer, `online`, sign-out) shares one in-flight promise,
// so a single hung fetch on a flaky mobile connection -- exactly this app's
// context -- would otherwise wedge the whole queue for as long as the
// browser's own (minutes-long) fetch timeout. Aborting is safe even if the
// request actually reached the server: every write route's idempotent
// client-id upsert means a later replay converges instead of duplicating.
export const FLUSH_FETCH_TIMEOUT_MS = 15_000;

// How long a 401'd row waits before its next automatic attempt. A 401 means
// the session expired -- retrying sooner just burns requests that are
// guaranteed to fail the same way. The periodic worker timer picks the row
// back up once this window elapses (or immediately via any successful
// write/reset path if the user signs in again in the meantime). Exported
// for the same drift-avoidance reason as BACKOFF_SCHEDULE_MS.
export const AUTH_RETRY_DELAY_MS = 60_000;

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
  // Explicit touched entities, overriding the SQL-derived derivation in
  // deriveTouchedEntities. For statements whose target row isn't the row a
  // surface renders -- e.g. repo/tags.ts's book_tag add/remove, which mutate
  // a join row keyed by (book_id, tag_id) while the stale thing the user
  // actually sees is the BOOK's tag list -- this records the row the
  // "Unsynced" badge should sit on, instead of a (book_tag, <not-its-pk>)
  // pair no consumer ever looks up.
  touched?: TouchedEntity[];
};

export type OutboxRow = {
  id: string;
  endpoint: string;
  method: string;
  body: unknown;
  attempts: number;
  next_retry_at: string | null;
  // Only meaningful once status = 'dead': true when the server returned a
  // non-retryable 4xx (see isPermanentFailure) rather than the row exhausting
  // the backoff schedule. Retrying a permanent failure replays the identical
  // request, so the UI offers no Retry action for these.
  permanent: boolean;
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
  const touched = deriveTouchedEntities(statements);

  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO outbox (id, endpoint, method, body, touched) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`, [
      id,
      endpoint,
      method,
      body === undefined ? null : JSON.stringify(body),
      touched.length ? JSON.stringify(touched) : null,
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
  flushQuietly();
  return id;
}

/** A single mirror row an outbox entry's optimistic write applied to. */
export type TouchedEntity = { table: string; id: string };

// Derives which mirror row(s) an outbox row's optimistic write(s) touched,
// from the SQL text and params alone -- every optimistic INSERT/UPDATE in
// the repo layer follows the convention of the target row's id being the
// FIRST bound param (`params: [id, ...]` for an INSERT, `params: [rowId,
// ...]` for an UPDATE built from a dynamic SET list -- see books.ts,
// contacts.ts, loans.ts, shelves.ts, tags.ts, reading-status.ts). Best
// effort: a statement that doesn't match `INSERT INTO <table>` or
// `UPDATE <table>` (or has no params) is simply skipped rather than
// throwing -- this is a diagnostic aid (Important 6's dismiss-tracking),
// not something any write path's success should depend on.
function deriveTouchedEntities(statements: OptimisticWrite[]): TouchedEntity[] {
  const touched: TouchedEntity[] = [];
  for (const stmt of statements) {
    // Explicit override (see OptimisticWrite.touched) beats the convention
    // -- the whole point is recording a different row than the SQL implies.
    if (stmt.touched) {
      touched.push(...stmt.touched);
      continue;
    }
    const match = /^\s*(?:INSERT INTO|UPDATE)\s+(\w+)/i.exec(stmt.sql);
    const table = match?.[1];
    const id = stmt.params?.[0];
    if (table && typeof id === "string") {
      touched.push({ table, id });
    }
  }
  return touched;
}

// Guards against overlapping flush passes (e.g. the periodic timer firing
// while an `online`-triggered flush is still in flight, or `enqueue()`'s
// own post-commit background flush racing an explicit caller's `flush()`)
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
    const outcome = await flushRow(row);
    // A 401 means the session cookie is expired -- every remaining due row
    // would fail identically, so stop the pass rather than hammering the
    // API. The paused row's AUTH_RETRY_DELAY_MS window (and the periodic
    // worker timer) resumes the queue once the user has signed in again.
    if (outcome === "auth") break;
  }
}

/** What happened to one outbox row during a flush pass. */
type FlushOutcome = "sent" | "retry" | "dead" | "auth";

/**
 * A 4xx response is a deterministic verdict on *this request* (bad body,
 * validation failure, missing target, forbidden) -- replaying the identical
 * request can't change it, so these dead-letter immediately instead of
 * burning the full backoff schedule. 408 and 429 are the explicit
 * "transient, try again later" 4xx statuses and stay retryable; 5xx stays
 * retryable for the same reason (server-side trouble, not this request).
 */
function isPermanentFailure(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// One toast per 401 episode, not one per 401'd row/pass: reset by any
// successful send (the session works again), so the next expiry re-warns.
let authToastShown = false;

// For tests only -- resets the 401-episode flag so each test starts from a
// clean slate (an earlier test's 401 episode otherwise suppresses this
// one's toast).
export function __resetAuthToastForTests(): void {
  authToastShown = false;
}

async function flushRow(row: OutboxRow): Promise<FlushOutcome> {
  let httpStatus: number | undefined;
  try {
    const res = await fetch(row.endpoint, {
      method: row.method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: row.body == null ? undefined : JSON.stringify(parseBody(row.body)),
      signal: AbortSignal.timeout(FLUSH_FETCH_TIMEOUT_MS),
    });
    httpStatus = res.status;
    if (res.ok) {
      await db.query(`DELETE FROM outbox WHERE id = $1`, [row.id]);
      notifyOutboxChange();
      authToastShown = false;
      return "sent";
    }
  } catch {
    // Network failure (offline, DNS, or FLUSH_FETCH_TIMEOUT_MS aborting a
    // hung connection) -- retry with backoff. If the aborted request did
    // reach the server, the write routes' idempotent upserts make the
    // replay converge rather than duplicate.
    return scheduleRetry(row);
  }

  if (httpStatus === 401) {
    // Session expired. Not an attempt, not a dead letter: push the row's
    // next try out by AUTH_RETRY_DELAY_MS and tell the user once -- their
    // changes are safe locally and the queue resumes after re-auth.
    await db.query(`UPDATE outbox SET next_retry_at = $2 WHERE id = $1`, [
      row.id,
      new Date(Date.now() + AUTH_RETRY_DELAY_MS).toISOString(),
    ]);
    notifyOutboxChange();
    if (!authToastShown) {
      authToastShown = true;
      toast.error(
        "Couldn't sync your changes — please sign in again. They're saved on this device and will retry automatically."
      );
    }
    return "auth";
  }

  if (isPermanentFailure(httpStatus)) return deadLetter(row, true);

  return scheduleRetry(row);
}

async function scheduleRetry(row: OutboxRow): Promise<FlushOutcome> {
  const attempts = row.attempts + 1;
  if (attempts > BACKOFF_SCHEDULE_MS.length) return deadLetter(row, false);

  const delayMs = BACKOFF_SCHEDULE_MS[attempts - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await db.query(`UPDATE outbox SET attempts = $2, next_retry_at = $3 WHERE id = $1`, [
    row.id,
    attempts,
    nextRetryAt,
  ]);
  notifyOutboxChange();
  return "retry";
}

async function deadLetter(row: OutboxRow, permanent: boolean): Promise<FlushOutcome> {
  const attempts = row.attempts + 1;
  await db.query(
    `UPDATE outbox SET attempts = $2, status = 'dead', permanent = $3, next_retry_at = NULL WHERE id = $1`,
    [row.id, attempts, permanent]
  );
  fireDeadLetterToast({ ...row, attempts, permanent });
  notifyOutboxChange();
  return "dead";
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
 *
 * Rows dead-lettered via a non-retryable 4xx (`permanent`) get the same
 * toast minus the Retry action -- replaying an identical rejected request
 * can't succeed, so offering it would just re-fail in front of the user.
 */
function fireDeadLetterToast(row: OutboxRow): void {
  if (row.permanent) {
    toast.error(deadLetterMessage(row));
    return;
  }
  toast.error(deadLetterMessage(row), {
    action: {
      label: "Retry",
      onClick: () => {
        void retry(row.id);
      },
    },
  });
}

/**
 * Human-readable toast message for a dead-lettered row: "Couldn't
 * <operation>" from `describeOperation`, suffixed for permanent
 * (server-rejected) rows. (SyncBadge's dialog uses its own bare-description
 * `rowLabel` -- a list item under a "Sync issue" heading doesn't want this
 * toast's "Couldn't" prefix repeated per row.)
 */
export function deadLetterMessage(row: OutboxRow): string {
  const description = describeOperation(row.endpoint, row.method, parseBody(row.body));
  if (row.permanent) {
    return description
      ? `Couldn't ${description} — the server rejected this change`
      : "Couldn't save — the server rejected this change";
  }
  return description ? `Couldn't ${description}` : "Couldn't save changes";
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
 * Important 6 (final whole-branch review): dismissing a dead-lettered write
 * marks the OUTBOX row dismissed but never touches the corresponding
 * optimistic row it already wrote into the mirror -- that local book/loan/
 * etc. row has no server-side counterpart and will never be corrected, with
 * no trace of which row it was. A full "revert the mirror row on dismiss"
 * isn't attempted here (the outbox has no notion of "the value before this
 * write", only "the write to replay" -- reverting cleanly would need that
 * too) -- this is the documented minimal fix instead: every enqueue() call
 * now records which mirror row(s) it touched (`outbox.touched`, see
 * deriveTouchedEntities above), so a dismissed OR dead row's touched
 * entities are queryable here (issue #16: surface unsynced rows). A
 * `pending` row is deliberately excluded -- it hasn't failed permanently
 * yet, and the outbox row is deleted outright once it succeeds, so there's
 * nothing left to flag once it does.
 */
export async function listUnsyncedTouchedEntities(): Promise<TouchedEntity[]> {
  await ready;
  const { rows } = await db.query<{ touched: TouchedEntity[] | string | null }>(
    `SELECT touched FROM outbox WHERE status IN ('dead', 'dismissed') AND touched IS NOT NULL`
  );
  const entities: TouchedEntity[] = [];
  for (const row of rows) {
    const parsed = parseBody(row.touched) as TouchedEntity[] | null;
    if (Array.isArray(parsed)) entities.push(...parsed);
  }
  return entities;
}

/**
 * Dead-lettered rows only (not `dismissed` ones) -- the list `SyncBadge`
 * renders in its "Sync issue" dialog, each entry labeled via
 * `deadLetterMessage(row)` (with Retry hidden for `permanent` rows).
 */
export async function listDeadLettered(): Promise<OutboxRow[]> {
  await ready;
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, endpoint, method, body, attempts, next_retry_at, permanent FROM outbox
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

  if (method === "DELETE" && /^\/api\/books\/[^/]+\/?$/.test(endpoint)) {
    return "delete a book";
  }

  if (method === "DELETE" && /^\/api\/books\/[^/]+\/tags\/[^/]+\/?$/.test(endpoint)) {
    return "remove a tag";
  }

  if (method === "DELETE" && /^\/api\/shelves\/[^/]+\/?$/.test(endpoint)) {
    return "delete a shelf";
  }

  return undefined;
}

// --- Background worker: resume flushing on `online` and on a timer -------

// Background flush triggers (enqueue's post-commit kick, the online
// listener, the periodic timer) are fire-and-forget by design -- but an
// un-awaited promise that rejects (a mirror query landing after db.close(),
// any transient PGlite error mid-pass) surfaces as an unhandled rejection
// in both tests and the browser console. Log-and-swallow preserves the
// best-effort semantics without that crash surface; the next trigger
// (timer/online/enqueue) retries the pass anyway.
function flushQuietly(): void {
  flush().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[outbox] background flush failed", error);
  });
}

let started = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

function onOnline(): void {
  flushQuietly();
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
    flushQuietly();
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
