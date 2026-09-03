// The actual Postgres/idbfs instance now lives here, inside a dedicated
// Worker -- one per tab, but only ONE of them (the elected leader, via
// @electric-sql/pglite/worker's Web Locks-based election) ever touches the
// real `idb://taakify` dataDir. Every other tab's PGliteWorker client
// (pglite.ts) relays its queries to the leader's worker over a
// BroadcastChannel instead of opening its own competing connection to the
// same IndexedDB-backed files.
//
// This file's only job is to hand the library a real PGlite instance when
// (and only when) this worker wins the leader election -- everything else
// (the election itself, RPC relaying, leader handoff on tab close) is
// handled by `worker()`.
import { PGlite } from "@electric-sql/pglite";
import { worker } from "@electric-sql/pglite/worker";

worker({
  async init(options) {
    return new PGlite(options);
  },
});
