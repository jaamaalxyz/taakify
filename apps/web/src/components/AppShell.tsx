import { NavLink, Outlet } from "react-router-dom";
import { Library, Plus, HandCoins, User, LogOut } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { HouseholdProvider, useHousehold } from "../lib/household-context.js";
import { Button } from "./ui/button.js";
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

export function AppShell() {
  return (
    <HouseholdProvider>
      <div className="flex min-h-dvh flex-col pb-16">
        <AppHeader />
        <main className="flex-1 p-4">
          <Outlet />
        </main>
        <TabBar />
      </div>
    </HouseholdProvider>
  );
}
