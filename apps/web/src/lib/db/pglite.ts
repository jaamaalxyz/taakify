import { PGliteWorker } from "@electric-sql/pglite/worker";
import PGliteDbWorker from "./pglite-worker.js?worker";
import mirrorSchema from "./mirror-schema.sql?raw";

// Singleton local mirror database, persisted to IndexedDB so it survives
// page reloads. Task 4 (Electric shape subscription) writes into these
// tables as shape data streams in; Task 6 (repo layer) reads from them.
//
// PGliteWorker, not a plain PGlite (issue #17): opening `idb://taakify`
// directly from every tab (the original approach) is documented as
// unsupported for concurrent multi-tab access -- two tabs both writing to
// the same idbfs-backed Postgres files can corrupt them, and opening a
// book in a new tab is a realistic user action, not a hypothetical. Every
// tab now runs its own dedicated Worker (pglite-worker.ts), but
// PGliteWorker's Web Locks-based leader election means only one of them
// (across ALL tabs on this origin, not just this one) ever actually opens
// the real files; every other tab's queries are relayed to the leader over
// a BroadcastChannel. `db` here still exposes the same PGliteInterface
// (query/exec/transaction/close/waitReady) plain PGlite did, so nothing
// downstream (repo layer, outbox, shape sync) needed to change.
//
// The Worker instance behind the `db` proxy. `db.close()` on a
// PGliteWorker only closes the *client* side -- the Worker itself (and its
// participation in leader election) survives, which is exactly what a
// normal tab wants: the worker is the tab's candidate for becoming leader
// later. Sign-out is the one flow that needs the worker fully dead: a live
// worker can win the election another tab's close just vacated and re-open
// `/pglite/taakify` underneath performSignOut's deleteDatabase (see
// signout-coordination.ts). Kept here so pglite.ts stays the only module
// that knows how the database is actually constructed.
const worker = new PGliteDbWorker();
export const db = new PGliteWorker(worker, { dataDir: "idb://taakify" });

/**
 * Close the database client AND terminate this tab's worker outright.
 * Sign-out only (performSignOut / signout-coordination.ts) -- normal
 * callers want `db.close()`. Returns once the client is closed; worker
 * termination is fire-and-forget since nothing talks to it afterwards.
 */
export async function closeLocalDatabase(): Promise<void> {
  await db.close().catch(() => undefined);
  worker.terminate();
}

// The `CREATE TABLE IF NOT EXISTS` statements in mirror-schema.sql make
// re-running the schema on every app open safe -- there's no migration
// tracking here, just an idempotent "make sure the tables exist" step.
//
// `db` itself has its own `waitReady` promise for the underlying Postgres
// process starting up, but callers of this module need to wait for *schema
// application* too, not just process startup, before they can safely query
// any mirror table. `ready` covers both.
export const ready: Promise<void> = db.waitReady.then(async () => {
  await db.exec(mirrorSchema);
});

// The real browser-level IndexedDB database name PGlite creates for
// `dataDir: "idb://taakify"` above -- NOT the literal string "taakify".
// Traced through @electric-sql/pglite@0.5.4's bundled source
// (dist/index.js): `idb://taakify` is parsed into `fsType: "idbfs"` with
// `dataDir` stripped down to `"taakify"`, which the idbfs backend then
// mounts into its emscripten filesystem at `${PGLITE_ROOT}/${dataDir}`
// (`PGLITE_ROOT` is the bundle-internal constant `"/pglite"`), i.e.
// `"/pglite/taakify"`. `IDBFS.getDB(mount.mountpoint, ...)` opens the
// *browser's* IndexedDB database keyed by that full mount path, not by the
// bare dataDir string -- so `indexedDB.deleteDatabase("taakify")` would
// silently target a database that never existed (deleteDatabase on a
// nonexistent name resolves without error) and leave the real data behind.
// Task 7's sign-out flow (AppShell.tsx) must delete this exact name so a
// shared device doesn't leak the previous household's local mirror.
export const IDB_DATABASE_NAME = "/pglite/taakify";
