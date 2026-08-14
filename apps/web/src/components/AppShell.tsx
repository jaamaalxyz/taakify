import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Library, Plus, HandCoins, User, LogOut } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { HouseholdProvider, useHousehold } from "../lib/household-context.js";
import { db, IDB_DATABASE_NAME, ready } from "../lib/db/pglite.js";
import {
  bootstrap,
  getSynced,
  getSyncStalled,
  onSyncedChange,
  onSyncStalledChange,
  startSync,
} from "../lib/sync/shape.js";
import { flush, startOutboxWorker } from "../lib/sync/outbox.js";
import { useSyncStatus } from "../lib/sync/use-sync-status.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Skeleton } from "./ui/skeleton.js";
import { SyncBadge } from "./SyncBadge.js";
import { cn } from "../lib/utils.js";

// Best-effort flush timeout before sign-out proceeds regardless -- long
// enough to let a healthy connection actually send the queued requests, but
// short enough not to hang the sign-out button indefinitely on a dead
// network (flush() itself has no timeout; it just gives up retrying until
// the next backoff window).
const SIGN_OUT_FLUSH_TIMEOUT_MS = 2000;

// Best-effort wait for another tab holding the same IndexedDB database open
// to release it before giving up -- `deleteDatabase`'s request never fires
// onsuccess/onerror while blocked, it just sits there, so without a timeout
// a second tab could hang sign-out indefinitely. Short: this is a rare edge
// case (another tab open to the same household mid-sign-out), and the
// fallback below still proceeds with the reload/sign-out either way -- it
// just means that one blocked case couldn't confirm the delete completed.
const IDB_DELETE_BLOCKED_TIMEOUT_MS = 1000;

// Wraps indexedDB.deleteDatabase in a Promise so callers can actually wait
// for the delete to finish (Important finding, final whole-branch review):
// the raw call is fire-and-forget, so `location.reload()` could previously
// fire before the delete completed, or the delete could silently stall
// forever in `onblocked` (another tab still has the database open) with no
// visibility at all. Since this is the branch's stated shared-device
// privacy guarantee (never leak the previous household's local mirror to
// the next person who signs in on this device), it needs to actually
// complete -- or at least be given a real chance to -- before sign-out
// proceeds to the reload.
function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      resolve();
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[sign-out] indexedDB.deleteDatabase threw synchronously", error);
      settle();
      return;
    }

    request.onsuccess = () => settle();
    request.onerror = () => {
      // eslint-disable-next-line no-console
      console.error("[sign-out] indexedDB.deleteDatabase failed", request.error);
      settle();
    };
    request.onblocked = () => {
      // Another tab still has the database open (e.g. a second tab on the
      // same household). Don't hang the sign-out flow forever waiting for
      // it to close -- log and give up after a short grace period; the
      // blocked delete may still complete later once that tab closes, but
      // this tab's sign-out proceeds regardless.
      // eslint-disable-next-line no-console
      console.error("[sign-out] indexedDB.deleteDatabase blocked by another open tab; proceeding anyway");
      setTimeout(settle, IDB_DELETE_BLOCKED_TIMEOUT_MS);
    };
  });
}

// Sign-out sequence shared by every path that actually proceeds (empty
// outbox / dead-only outbox / confirmed-despite-pending-writes): flush
// best-effort, close the PGlite connection, delete its IndexedDB database
// (so a shared device never leaks the previous household's local mirror --
// see IDB_DATABASE_NAME's comment for why the literal dataDir string
// wouldn't work here), sign out, then reload to a clean slate. Order
// matters: data must be cleared before the session is dropped, and nothing
// here runs unless the caller has already decided sign-out should proceed.
async function performSignOut(): Promise<void> {
  if (navigator.onLine) {
    await Promise.race([flush(), new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_FLUSH_TIMEOUT_MS))]);
  }
  await db.close();
  await deleteIndexedDb(IDB_DATABASE_NAME);
  await authClient.signOut().finally(() => location.reload());
}

function TabLink({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Library }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        cn("flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground", isActive && "text-primary")
      }
    >
      <Icon className="h-5 w-5" />
      {label}
    </NavLink>
  );
}

function AppHeader() {
  const { household } = useHousehold();
  const { pending } = useSyncStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSignOutClick() {
    // Case 1 (no pending writes, whether the outbox is empty or only holds
    // dead-lettered/dismissed rows) -> no friction, sign out immediately.
    // Case 2 (pending writes exist) -> warn first; performSignOut only runs
    // if the user confirms.
    if (pending === 0) {
      void performSignOut();
    } else {
      setConfirmOpen(true);
    }
  }

  return (
    <header className="flex items-center justify-between gap-3 border-b p-4">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-lg font-semibold">{household.name}</h1>
        <SyncBadge />
      </div>
      <Button variant="ghost" size="icon" aria-label="Sign out" onClick={handleSignOutClick}>
        <LogOut className="h-4 w-4" />
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertDescription>
              You have {pending} unsaved change{pending === 1 ? "" : "s"}. Sign out anyway? They&rsquo;ll be lost.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void performSignOut();
              }}
            >
              Sign out anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-background py-2">
      <TabLink to="/library" label="Library" icon={Library} />
      <TabLink to="/add" label="Add" icon={Plus} />
      <TabLink to="/loans" label="Loans" icon={HandCoins} />
      <TabLink to="/profile" label="Profile" icon={User} />
    </nav>
  );
}

// Cold-start sync gate: household id is only known once HouseholdProvider
// resolves /api/me, so this lives *inside* HouseholdProvider (it calls
// useHousehold()), rather than in AppShell itself. Starts the Electric
// shape stream once per household, then shows the app's existing full-page
// Skeleton loading pattern (see App.tsx / household-context.tsx) instead of
// the real screens until the mirror's initial catch-up completes -- so a
// slow first sync reads as "loading", never as "my library is gone" (see
// task-4-brief.md Step 3). Every screen under AppShell benefits without any
// of them needing their own sync-awareness; Task 6's repo layer is what
// will actually read from the now-populated mirror.
//
// `bootstrap()` (Task 8) is fired alongside `startSync`, not after -- it's a
// one-round-trip seed fetch that can land in the mirror well before any of
// the 7+ separate shape subscriptions reach their own `up-to-date` control
// message, so the loading skeleton above is shown for a shorter window (or,
// on a fast bootstrap response, skipped almost entirely once the shapes
// catch up moments later). It never blocks `synced`, which still depends
// only on the shapes' own signal -- see bootstrap()'s doc comment in
// shape.ts for why a bootstrap failure must stay a non-event here.
// Critical 2 fix (final whole-branch review): the gate used to wait
// unconditionally for `synced`, with no escape hatch -- a shape stream that
// never reaches up-to-date (Electric unreachable, offline reload, container
// restarting) meant this Skeleton spun forever, even when the local PGlite
// mirror already held a full, real copy of the household's data from a
// previous session. Two release paths besides genuine `synced === true`:
//
//   1. Existing local data: if the mirror already has at least one `book`
//      row, this isn't a true first-ever cold start -- release immediately
//      rather than waiting on the shape stream at all. The stream keeps the
//      data fresh once/if it connects; there's nothing to protect the user
//      from by holding the gate here.
//   2. A bounded timeout (shape.ts's SYNC_STALL_TIMEOUT_MS, shared with the
//      "stalled" signal SyncBadge surfaces): if neither `synced` nor the
//      existing-data check has released the gate by then, release anyway.
//
// A genuine first-ever cold start with a healthy connection still hits
// neither escape path in practice -- `synced` flips true well inside the
// timeout window, so the Skeleton shows only as briefly as it always did.
function SyncGate({ children }: { children: React.ReactNode }) {
  const { household } = useHousehold();
  const [synced, setSynced] = useState(getSynced);
  const [released, setReleased] = useState(() => getSynced() || getSyncStalled());

  useEffect(() => {
    startSync(household.id);
    startOutboxWorker();
    void bootstrap(household.id);
    // Reconcile immediately: `synced` may have already flipped true in the
    // window between this component's initial render (which read
    // `getSynced()` for its initial state) and this effect running --
    // subscribing alone would only catch *future* transitions and could
    // otherwise get stuck showing the loading state forever.
    setSynced(getSynced());
    if (getSynced() || getSyncStalled()) setReleased(true);

    let cancelled = false;
    void ready
      .then(() => db.query("SELECT 1 FROM book LIMIT 1"))
      .then((result) => {
        if (!cancelled && result.rows.length > 0) setReleased(true);
      })
      .catch(() => {
        // A failed probe query shouldn't block either of the other two
        // release paths (synced / stall timeout) -- just skip this one.
      });

    const unsubscribeSynced = onSyncedChange(() => {
      setSynced(getSynced());
      setReleased(true);
    });
    const unsubscribeStalled = onSyncStalledChange(() => {
      if (getSyncStalled()) setReleased(true);
    });

    return () => {
      cancelled = true;
      unsubscribeSynced();
      unsubscribeStalled();
    };
  }, [household.id]);

  if (!released) {
    return (
      <div className="flex min-h-dvh flex-col pb-16">
        <main className="flex-1 space-y-3 p-4">
          <Skeleton className="h-8 w-2/3" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[2/3] w-full" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  return <>{children}</>;
}

export function AppShell() {
  return (
    <HouseholdProvider>
      <SyncGate>
        <div className="flex min-h-dvh flex-col pb-16">
          <AppHeader />
          <main className="flex-1 p-4">
            <Outlet />
          </main>
          <TabBar />
        </div>
      </SyncGate>
    </HouseholdProvider>
  );
}
