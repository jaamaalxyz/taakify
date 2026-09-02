// React hook wrapping the outbox's pending/dead counts plus browser
// connectivity, for `SyncBadge` (and the sign-out gate in AppShell.tsx) to
// render off of.
//
// Event-driven, not polled: outbox.ts (Task 5/7) exposes `onOutboxChange`,
// an observable following the same pattern as shape.ts's `onSyncedChange`
// (Task 4) -- every outbox mutation (enqueue, flush success/failure,
// dead-letter, retry, dismiss) calls it after committing. Subscribing to
// that and re-querying the counts on each notification is both simpler and
// snappier than a `setInterval` poll (no up-to-2s lag waiting for the next
// tick, no wasted queries when nothing changed) and keeps this module
// consistent with the rest of the sync layer's "framework-agnostic core +
// tiny observable" shape, so a polling fallback was not needed.
import { useEffect, useState } from "react";
import { countDead, countPending, onOutboxChange } from "./outbox.js";
import { getSyncStalled, onSyncStalledChange, getSyncStale, onSyncStaleChange } from "./shape.js";

export type SyncStatus = {
  online: boolean;
  pending: number;
  dead: number;
  // True once the Electric shape stream has gone SYNC_STALL_TIMEOUT_MS
  // (shape.ts) without reaching up-to-date -- distinct from `online` being
  // false: this is "the browser thinks it's online but Electric itself is
  // unreachable" (down container, network path blocked, etc.), which
  // SyncGate's timeout-release backstop can otherwise mask as a
  // fully-synced app with no visible indication anything's wrong.
  stalled: boolean;
  // Issue #18: `stalled` only ever arms once, during the cold-start window.
  // `stale` is the mid-session equivalent -- a table's shape stream has
  // gone quiet (or errored) AFTER the app already reached `synced`, and
  // hasn't freshened up again. Also distinct from `online`: the browser can
  // think it has connectivity while Electric itself is unreachable.
  stale: boolean;
};

export function useSyncStatus(): SyncStatus {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [dead, setDead] = useState(0);
  const [stalled, setStalled] = useState(getSyncStalled);
  const [stale, setStale] = useState(getSyncStale);

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const [p, d] = await Promise.all([countPending(), countDead()]);
      if (cancelled) return;
      setPending(p);
      setDead(d);
    }

    void refresh();
    return onOutboxChange(() => void refresh());
  }, []);

  useEffect(() => {
    setStalled(getSyncStalled());
    return onSyncStalledChange(() => setStalled(getSyncStalled()));
  }, []);

  useEffect(() => {
    setStale(getSyncStale());
    return onSyncStaleChange(() => setStale(getSyncStale()));
  }, []);

  return { online, pending, dead, stalled, stale };
}
