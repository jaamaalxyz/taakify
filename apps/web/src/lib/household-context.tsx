import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { api, type Me } from "./api.js";
import { friendlyError } from "./error-messages.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";

export type Household = { id: string; name: string; role: string };

export type Member = { id: string; name: string; email: string; role: string };

type HouseholdContextValue = {
  user: Me["user"];
  household: Household;
  // The household roster, fetched once after /api/me resolves so every screen
  // shares one GET /api/households/:id/members call. `null` = still loading,
  // `[]` = loaded but empty (or failed — members are non-critical, so a fetch
  // failure degrades to an empty list rather than blocking the app).
  members: Member[] | null;
  // Re-fetches /api/me and updates `user`/`household`/`members` in place.
  // Consumers that mutate the signed-in user's own name/email (Profile.tsx)
  // must call this after a successful change — otherwise this context keeps
  // showing the stale value it fetched on mount until a full page reload,
  // and a second email change can fail outright (the current-email step
  // sends its OTP to the stale address, which no longer matches the
  // session's real current email server-side).
  refreshUser: () => Promise<void>;
};

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

/**
 * Fetches /api/me once on mount and exposes the signed-in user plus their
 * first household membership (this app doesn't support switching between
 * multiple households yet — see membership[0] below, matching the prior
 * Home.tsx behavior), and the household's member roster (for resolving who
 * wrote a reading status, etc.). Renders nothing but a Skeleton until loaded,
 * a destructive Alert on fetch failure, and redirects to /onboarding when the
 * user has zero memberships. Only renders `children` once a household is
 * available.
 */
export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");
  const [members, setMembers] = useState<Member[] | null>(null);

  function fetchMe(): Promise<void> {
    return api<Me>("/api/me")
      .then(setMe)
      .catch((e) => setLoadError(friendlyError(e)));
  }

  useEffect(() => {
    fetchMe();
  }, []);

  const householdId = me && me.memberships.length > 0 ? me.memberships[0].household_id : null;

  // Fetch the roster once we know the household. Members are non-critical
  // (only used to render display names alongside reading statuses today), so a
  // failure degrades to an empty list — the rest of the app still works.
  useEffect(() => {
    if (!householdId) return;
    api<{ members: Member[] }>(`/api/households/${householdId}/members`)
      .then((data) => setMembers(data.members))
      .catch(() => setMembers([]));
  }, [householdId]);

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
    members,
    refreshUser: fetchMe,
  };

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold must be used within a HouseholdProvider");
  return ctx;
}
