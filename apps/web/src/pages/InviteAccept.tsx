import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

type Info = { householdName: string; email: string; role: string };

export function InviteAccept({ authed }: { authed: boolean }) {
  const { token } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api<Info>(`/api/invites/${token}`).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  async function accept() {
    try {
      await api(`/api/invites/${token}/accept`, { method: "POST" });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <main><p className="error">Invite problem: {error}</p></main>;
  if (!info) return <main className="muted">Loading invite…</main>;

  return (
    <main>
      <h1>Join "{info.householdName}"</h1>
      <p className="muted">You've been invited as {info.role} ({info.email}).</p>
      {authed ? (
        <button onClick={accept}>Accept invite</button>
      ) : (
        <p>
          First <Link to={`/signup?next=/invite/${token}`}>create an account</Link> or{" "}
          <Link to={`/signin?next=/invite/${token}`}>sign in</Link> — you'll come right back here.
        </p>
      )}
    </main>
  );
}
