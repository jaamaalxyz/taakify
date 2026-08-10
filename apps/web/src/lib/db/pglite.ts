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
