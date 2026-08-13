// Electric shape stream -> PGlite mirror.
//
// Subscribes to one Electric shape per household-scoped table (see
// TENANT_TABLES below) plus the global `edition` catalog, and applies each
// incoming change message into the local PGlite mirror (Task 3's
// mirror-schema.sql) with last-write-wins semantics keyed on `updated_at`.
//
// Deliberately framework-agnostic: this module is plain TS with no React
// dependency, so it can be unit tested directly (see shape.test.ts) and
// consumed either from a React effect (see AppShell.tsx) or, later, from a
// service worker / background sync context.
import type { PGlite } from "@electric-sql/pglite";
import { ShapeStream, isChangeMessage, isControlMessage, type Row } from "@electric-sql/client";
import { db, ready } from "../db/pglite.js";

// Matches the dev Electric container in docker-compose.dev.yml
// (ELECTRIC_INSECURE=true, no auth params needed). Overridable for other
// environments via VITE_ELECTRIC_URL.
const ELECTRIC_URL = (import.meta.env.VITE_ELECTRIC_URL as string | undefined) ?? "http://localhost:3010/v1/shape";

// Every household-scoped mirror table. Each gets its own shape subscription
// filtered by household_id. `edition` (global catalog, no household_id) is
// handled separately below.
const TENANT_TABLES = [
  "bookcase",
  "shelf",
  "book",
  "reading_status",
  "tag",
  "book_tag",
  "contact",
  "loan",
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

// Total shape subscriptions this module opens per household: the 8
// household-scoped tables plus the one global `edition` shape. `synced`
// flips true once every one of these has reported its initial `up-to-date`
// control message.
const TOTAL_SHAPE_COUNT = TENANT_TABLES.length + 1;

type Operation = "insert" | "update" | "delete";

/**
 * Apply one Electric change message to the local PGlite mirror.
 *
 * - insert/update: upsert, guarded so a message carrying a stale
 *   `updated_at` (e.g. a duplicate replay, or messages arriving out of
 *   order) never regresses a row already updated by a later message.
 * - delete: unconditional hard delete. The mirror doesn't need to preserve
 *   tombstones — for household-scoped tables, soft-deletes stream through
 *   as `update` messages (see `where` clause below, which deliberately does
 *   NOT filter `deleted_at IS NULL`), so a `delete` operation here only
 *   happens for genuinely-gone rows (e.g. shape compaction), not app-level
 *   soft deletes.
 *
 * Exported standalone (not just used internally) so unit tests can drive it
 * with synthetic messages, no real ShapeStream/network required. Takes the
 * PGlite instance explicitly (rather than reaching for the module-level
 * singleton) so tests can pass an in-memory `new PGlite()` instead of the
 * real `idb://`-backed mirror.
 */
export async function applyChangeTo(
  database: PGlite,
  table: TenantTable | "edition",
  operation: Operation,
  value: Row
): Promise<void> {
  if (operation === "delete") {
    await database.query(`DELETE FROM ${table} WHERE id = $1`, [value.id]);
    return;
  }

  const columns = COLUMNS[table];
  const columnList = columns.join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = columns
    .filter((c) => c !== "id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  await database.query(
    `INSERT INTO ${table} (${columnList})
     VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updateSet}
     WHERE EXCLUDED.updated_at > ${table}.updated_at`,
    columns.map((c) => value[c] ?? null)
  );
}

/**
 * Apply a change message to the real (singleton, `idb://`-backed) local
 * mirror. Thin wrapper around `applyChangeTo` that waits for the mirror
 * schema to be ready first — see `applyChangeTo` for the actual SQL.
 */
export async function applyChange(
  table: TenantTable | "edition",
  operation: Operation,
  value: Row
): Promise<void> {
  await ready;
  await applyChangeTo(db, table, operation, value);
}

// Column lists per mirror table, matching mirror-schema.sql exactly (order
// doesn't matter for correctness, just needs to match COLUMNS <-> the row
// shape Electric sends with replica: "full").
const COLUMNS: Record<TenantTable | "edition", string[]> = {
  edition: [
    "id",
    "isbn",
    "title",
    "authors",
    "language",
    "publisher",
    "published_year",
    "cover_url",
    "series_name",
    "series_number",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  bookcase: ["id", "household_id", "name", "created_by", "created_at", "updated_at", "deleted_at"],
  shelf: [
    "id",
    "household_id",
    "bookcase_id",
    "position",
    "label",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  book: [
    "id",
    "household_id",
    "edition_id",
    "ownership",
    "format",
    "shelf_id",
    "do_not_lend",
    "wishlist_priority",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  reading_status: [
    "id",
    "household_id",
    "book_id",
    "user_id",
    "status",
    "started_at",
    "finished_at",
    "rating",
    "review_note",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  tag: ["id", "household_id", "name", "created_by", "created_at", "updated_at", "deleted_at"],
  book_tag: ["id", "household_id", "book_id", "tag_id", "created_at", "updated_at", "deleted_at"],
  contact: [
    "id",
    "household_id",
    "name",
    "phone",
    "email",
    "linked_user_id",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  loan: [
    "id",
    "household_id",
    "book_id",
    "contact_id",
    "direction",
    "out_date",
    "due_date",
    "returned_date",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
};

// --- Cold-start `synced` signal -------------------------------------------
//
// False until every shape subscription (8 tenant tables + edition) has
// reported its initial `up-to-date` control message; true thereafter.
// Exposed via a tiny observable (getSynced/onSyncedChange) rather than a
// React hook, so this module stays framework-agnostic — a later React hook
// (Task 7's use-sync-status.ts) can wrap it, and AppShell.tsx wires it
// directly for now.
const upToDateTables = new Set<string>();
let synced = false;
const listeners = new Set<() => void>();

function markUpToDate(table: string): void {
  if (upToDateTables.has(table)) return;
  upToDateTables.add(table);
  const wasSynced = synced;
  synced = upToDateTables.size >= TOTAL_SHAPE_COUNT;
  if (synced !== wasSynced) {
    for (const listener of listeners) listener();
  }
}

export function getSynced(): boolean {
  return synced;
}

export function onSyncedChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// Reset module-level sync state — for tests only, so each test starts from
// a clean "not synced" slate regardless of subscription order.
export function __resetSyncedForTests(): void {
  upToDateTables.clear();
  synced = false;
}

// Drive the internal "table reached up-to-date" bookkeeping directly — for
// tests only, so the synced-signal contract can be exercised without a real
// ShapeStream/network call.
export function __markUpToDateForTests(table: string): void {
  markUpToDate(table);
}

// Total number of shape subscriptions `synced` waits on — exposed for tests
// only, so a test can drive exactly TOTAL_SHAPE_COUNT tables without
// hardcoding a number that would silently drift from TENANT_TABLES.
export function __totalShapeCountForTests(): number {
  return TOTAL_SHAPE_COUNT;
}

// --- Cold-start bootstrap seed ---------------------------------------------
//
// Fetches the household's full book-domain dataset from the server (Task
// 8's GET /api/bootstrap) and upserts every row straight into the PGlite
// mirror, so a slow initial Electric shape catch-up never shows an empty
// library. Purely an accelerant: it shares the exact same
// `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE EXCLUDED.updated_at >
// table.updated_at` upsert `applyChangeTo` already uses for shape-stream
// rows (same server-assigned row ids per Task 6's fix), so a bootstrap-seeded
// row and a later shape-synced row for the same id never conflict or
// duplicate -- whichever write has the newer `updated_at` wins.
//
// Response keys -> mirror table names. `book_tag` is intentionally not
// seeded here (not part of the bootstrap payload); it catches up via its own
// shape subscription like every other table not listed here.
const BOOTSTRAP_COLLECTIONS: Record<string, TenantTable | "edition"> = {
  bookcases: "bookcase",
  shelves: "shelf",
  books: "book",
  reading_statuses: "reading_status",
  tags: "tag",
  contacts: "contact",
  loans: "loan",
  editions: "edition",
};

/**
 * Fetch the bootstrap payload and apply it to `database`. Exported
 * standalone (mirroring the applyChangeTo/applyChange split above) so unit
 * tests can drive it against their own in-memory PGlite instance -- no
 * browser idb:// storage or real fetch/network required, `fetch` alone is
 * mocked. Throws on any failure (network, non-2xx, bad JSON); `bootstrap`
 * below is the version real callers use, which swallows those.
 */
export async function bootstrapInto(database: PGlite, householdId: string): Promise<void> {
  const res = await fetch(`/api/bootstrap?householdId=${householdId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`bootstrap fetch failed with status ${res.status}`);
  const data = (await res.json()) as Record<string, Row[] | undefined>;

  for (const [key, table] of Object.entries(BOOTSTRAP_COLLECTIONS)) {
    const rows = data[key];
    if (!rows) continue;
    for (const row of rows) {
      await applyChangeTo(database, table, "insert", row);
    }
  }
}

/**
 * Seed the local (singleton, `idb://`-backed) PGlite mirror from the
 * server's one-round-trip bootstrap endpoint. Never throws: a network
 * failure (or any other error) is logged and swallowed so the shape stream
 * remains the sole source of truth for `synced` -- bootstrap failing must
 * never block the app from becoming usable, it only means the cold-start UI
 * stays on the loading skeleton a bit longer while the shapes catch up on
 * their own.
 */
export async function bootstrap(householdId: string): Promise<void> {
  try {
    await ready;
    await bootstrapInto(db, householdId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[sync] bootstrap seed failed; relying on shape stream catch-up instead", error);
  }
}

// --- Subscription entry point ---------------------------------------------

let started = false;

/**
 * Start streaming Electric shapes for `householdId` into the PGlite mirror.
 * Idempotent per page load — calling it more than once (e.g. a React effect
 * re-running under StrictMode) is a no-op after the first call, since a
 * shape subscription is meant to live for the lifetime of the session.
 */
export function startSync(householdId: string): void {
  if (started) return;
  started = true;

  for (const table of TENANT_TABLES) {
    subscribeTable(table, `household_id = $1`, { "1": householdId });
  }
  // `edition` is a global catalog table with no household_id column (see
  // CLAUDE.md: "open select/insert/update to any authenticated app-role
  // connection", no RLS). Every household can already read every edition
  // row via the API, so mirroring the whole (small) catalog table
  // unfiltered is consistent with the existing trust model, not a new
  // leak — there's no per-household `where` clause to filter by.
  subscribeTable("edition", undefined, undefined);
}

function subscribeTable(
  table: TenantTable | "edition",
  where: string | undefined,
  params: Record<string, string> | undefined
): void {
  const stream = new ShapeStream({
    url: ELECTRIC_URL,
    params: {
      table,
      ...(where ? { where } : {}),
      ...(params ? { params } : {}),
      // Required: without it, `update` messages only carry changed columns
      // + PK (Electric's default "changes only" replica mode), and a
      // full-row upsert would then null out NOT NULL columns that weren't
      // part of the diff. See spike/electric-pglite-spike.ts.
      replica: "full",
    },
  });

  stream.subscribe((messages) => {
    for (const message of messages) {
      if (isControlMessage(message)) {
        if (message.headers.control === "up-to-date") {
          markUpToDate(table);
        }
        continue;
      }
      if (isChangeMessage(message)) {
        const operation = message.headers.operation as Operation;
        void applyChange(table, operation, message.value as Row);
      }
    }
  }, (error) => {
    // eslint-disable-next-line no-console
    console.error(`[sync] shape stream error for table "${table}"`, error);
  });
}
