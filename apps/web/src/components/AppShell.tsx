import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Library, Plus, HandCoins, User, LogOut } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { HouseholdProvider, useHousehold } from "../lib/household-context.js";
import { db, IDB_DATABASE_NAME } from "../lib/db/pglite.js";
import { bootstrap, getSynced, onSyncedChange, startSync } from "../lib/sync/shape.js";
import { flush } from "../lib/sync/outbox.js";
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
  indexedDB.deleteDatabase(IDB_DATABASE_NAME);
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
function SyncGate({ children }: { children: React.ReactNode }) {
  const { household } = useHousehold();
  const [synced, setSynced] = useState(getSynced);

  useEffect(() => {
    startSync(household.id);
    void bootstrap(household.id);
    // Reconcile immediately: `synced` may have already flipped true in the
    // window between this component's initial render (which read
    // `getSynced()` for its initial state) and this effect running --
    // subscribing alone would only catch *future* transitions and could
    // otherwise get stuck showing the loading state forever.
    setSynced(getSynced());
    return onSyncedChange(() => setSynced(getSynced()));
  }, [household.id]);

  if (!synced) {
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
