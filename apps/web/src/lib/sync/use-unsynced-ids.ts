// Backs the "Unsynced" badge on BookCard, LoanRow, and BookDetail (issue
// #16): which mirror rows in `table` have a dead-lettered or dismissed
// outbox entry pointing at them, i.e. an optimistic local write that is
// permanently diverged from the server with no trace anywhere else in the
// UI. Re-queries on every outbox change (dismiss, dead-letter, retry,
// successful send) so the badge clears the moment the underlying write
// actually succeeds.
import { useEffect, useState } from "react";
import { listUnsyncedTouchedEntities, onOutboxChange } from "./outbox.js";

export function useUnsyncedIds(table: string): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      void listUnsyncedTouchedEntities().then((entities) => {
        if (cancelled) return;
        setIds(new Set(entities.filter((e) => e.table === table).map((e) => e.id)));
      });
    }

    refresh();
    return onOutboxChange(refresh);
  }, [table]);

  return ids;
}
