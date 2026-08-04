import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { api, type Me } from "./api.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";

export type Household = { id: string; name: string; role: string };

type HouseholdContextValue = {
  user: Me["user"];
  household: Household;
};

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

/**
 * Fetches /api/me once on mount and exposes the signed-in user plus their
 * first household membership (this app doesn't support switching between
 * multiple households yet — see membership[0] below, matching the prior
 * Home.tsx behavior). Renders nothing but a Skeleton until loaded, a
 * destructive Alert on fetch failure, and redirects to /onboarding when the
 * user has zero memberships. Only renders `children` once a household is
 * available.
 */
export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  if (loadError)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>Couldn't load your library: {loadError}</AlertDescription>
        </Alert>
      </main>
    );

  if (!me)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-10 w-full" />
        </div>
      </main>
    );

  if (me.memberships.length === 0) return <Navigate to="/onboarding" />;

  const membership = me.memberships[0];
  const value: HouseholdContextValue = {
    user: me.user,
    household: { id: membership.household_id, name: membership.household_name, role: membership.role },
  };

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold must be used within a HouseholdProvider");
  return ctx;
}
