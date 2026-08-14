// Sentinel `updated_at` value for optimistic local writes.
//
// shape.ts's applyChangeTo upserts incoming shape-stream/bootstrap rows
// with `WHERE EXCLUDED.updated_at > table.updated_at` -- last-write-wins
// keyed on updated_at. Every repo/*.ts write used to stamp its optimistic
// INSERT/UPDATE's updated_at with the browser's own clock
// (`new Date().toISOString()`, or SQL `now()` -- PGlite runs client-side,
// so that's the browser's clock too). If a device's clock runs meaningfully
// fast, that optimistic timestamp could exceed the server's real
// (authoritative) updated_at for the same row once it syncs down, causing
// the LWW guard above to permanently reject the server's canonical version
// in favor of the stale optimistic one (clock-skew finding, final
// whole-branch review).
//
// Fix: stamp every optimistic write's updated_at with this fixed far-past
// sentinel instead of "now". The LWW guard then ALWAYS treats an incoming
// real server row as newer than any purely-local optimistic placeholder,
// regardless of clock skew, since every genuine server updated_at is a real
// wall-clock timestamp from well after 1970. This is deliberately used ONLY
// for updated_at, never for created_at or any other column -- the
// optimistic row's actual displayed data is unaffected, it's purely a
// version marker for the LWW comparison. Verified (final review fix
// report) that no repo/screen code sorts or filters by updated_at, so
// rewinding it locally has no other user-visible effect while the write is
// in flight.
//
// Trade-off, documented rather than silently accepted: this narrows (but
// doesn't eliminate) a different, pre-existing race in the other direction
// -- if a shape resubscribe/backfill delivers a row's PRE-optimistic-write
// server state while the optimistic write is still in flight (outbox
// hasn't reached the server yet), that backfilled row's real updated_at is
// greater than the epoch sentinel and would apply, transiently clobbering
// the optimistic change until the real write's response syncs back down.
// This window is normally sub-second (the outbox flushes immediately on
// enqueue, see outbox.ts) and self-heals as soon as the server confirms the
// write -- a strict improvement over the clock-skew bug this replaces,
// which had no self-healing path at all.
export const OPTIMISTIC_UPDATED_AT = "1970-01-01T00:00:00.000Z";
