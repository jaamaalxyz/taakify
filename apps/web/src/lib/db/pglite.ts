import { PGlite } from "@electric-sql/pglite";
import mirrorSchema from "./mirror-schema.sql?raw";

// Singleton local mirror database, persisted to IndexedDB so it survives
// page reloads. Task 4 (Electric shape subscription) writes into these
// tables as shape data streams in; Task 6 (repo layer) reads from them.
export const db = new PGlite({ dataDir: "idb://taakify" });

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
