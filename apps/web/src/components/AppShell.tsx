import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Library, Plus, HandCoins, User, LogOut } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { HouseholdProvider, useHousehold } from "../lib/household-context.js";
import { getSynced, onSyncedChange, startSync } from "../lib/sync/shape.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";
import { cn } from "../lib/utils.js";

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
  return (
    <header className="flex items-center justify-between border-b p-4">
      <h1 className="text-lg font-semibold">{household.name}</h1>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        onClick={() => authClient.signOut().finally(() => location.reload())}
      >
        <LogOut className="h-4 w-4" />
      </Button>
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
function SyncGate({ children }: { children: React.ReactNode }) {
  const { household } = useHousehold();
  const [synced, setSynced] = useState(getSynced);

  useEffect(() => {
    startSync(household.id);
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
