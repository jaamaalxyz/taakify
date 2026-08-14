import { useEffect, useState } from "react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog.js";
import { describeOperation, dismiss, listDeadLettered, parseBody, retry, type OutboxRow } from "../lib/sync/outbox.js";
import { useSyncStatus } from "../lib/sync/use-sync-status.js";

// State precedence (the brief leaves this to judgment): dead-lettered rows
// take precedence over both "Offline" and "Saving...". Those rows are
// permanently failed and need an explicit Retry/Dismiss decision regardless
// of the current network state -- burying the "Sync issue" trigger behind
// an "Offline" badge whenever the device happens to be offline would make
// the failed-operations list intermittently unreachable, which defeats the
// point of it being the *durable* visibility layer (vs. Task 5's transient
// toast). Offline and Saving are both transient/self-explanatory the moment
// connectivity changes, so ordering them below "dead" costs nothing.
export function SyncBadge() {
  const { online, pending, dead, stalled } = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<OutboxRow[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listDeadLettered().then((result) => {
      if (!cancelled) setRows(result);
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever `dead` changes while the dialog is open too (e.g. a
    // background flush dead-letters another row while the user is looking).
  }, [open, dead]);

  async function handleRetry(id: string) {
    await retry(id);
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  async function handleDismiss(id: string) {
    await dismiss(id);
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  if (dead > 0) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Badge variant="destructive" className="cursor-pointer gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
            Sync issue
          </Badge>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sync issues</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing left to review.</p>
            ) : (
              rows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <span className="text-sm">
                    {describeOperation(row.endpoint, row.method, parseBody(row.body)) ?? "Couldn't save changes"}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => void handleRetry(row.id)}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void handleDismiss(row.id)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!online) {
    return <Badge variant="destructive">Offline</Badge>;
  }

  // Distinct from "Offline": the browser thinks it has connectivity, but
  // the shape stream never reached up-to-date (Electric unreachable, its
  // container down, etc.) -- see shape.ts's SYNC_STALL_TIMEOUT_MS. Without
  // this, SyncGate's timeout/existing-data release backstop (Critical 2)
  // could show a fully-populated app with no indication the live sync
  // connection never actually came up.
  if (stalled) {
    return <Badge variant="destructive">Sync unavailable</Badge>;
  }

  if (pending > 0) {
    return <Badge variant="secondary">Saving…</Badge>;
  }

  return null;
}
