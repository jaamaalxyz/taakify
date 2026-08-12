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

export type SyncStatus = {
  online: boolean;
  pending: number;
  dead: number;
};

export function useSyncStatus(): SyncStatus {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [dead, setDead] = useState(0);

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

  return { online, pending, dead };
}
