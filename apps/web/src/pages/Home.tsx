import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Me } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

export function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((e) => setLoadError((e as Error).message));
  }, []);

  async function invite(householdId: string) {
    const email = prompt("Invitee's email?");
    if (!email) return;
    try {
      const { url } = await api<{ url: string }>(`/api/households/${householdId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role: "member" }),
      });
      setInviteUrl(`${location.origin}${url}`);
    } catch (err) {
      alert(`Invite failed: ${(err as Error).message}`);
    }
  }

  if (loadError)
    return (
      <main>
        <p className="error">Couldn't load your library: {loadError}</p>
      </main>
    );
  if (!me) return <main className="muted">Loading…</main>;
  if (me.memberships.length === 0)
    return (
      <main>
        <h1>Welcome, {me.user.name}</h1>
        <p>You're not in a library yet.</p>
        <Link to="/onboarding">Create your library</Link>
      </main>
    );

  return (
    <main>
      <h1>{me.memberships[0].household_name}</h1>
      <p className="muted">Signed in as {me.user.email} ({me.memberships[0].role})</p>
      <button onClick={() => invite(me.memberships[0].household_id)}>Invite a family member</button>
      {inviteUrl && (
        <p>
          Share this link: <code>{inviteUrl}</code>
        </p>
      )}
      <p className="muted">Books arrive in Plan 3. Sync arrives in Plan 2.</p>
      <button onClick={() => authClient.signOut().finally(() => location.reload())}>Sign out</button>
    </main>
  );
}
