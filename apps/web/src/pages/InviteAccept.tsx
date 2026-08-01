import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";

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

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      {error ? (
        <Alert variant="destructive" className="w-full max-w-sm">
          <AlertDescription>Invite problem: {error}</AlertDescription>
        </Alert>
      ) : !info ? (
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Join &quot;{info.householdName}&quot;</CardTitle>
            <CardDescription>
              You've been invited as {info.role} ({info.email}).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {authed ? (
              <Button className="w-full" onClick={accept}>
                Accept invite
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                First{" "}
                <Link to={`/signup?next=/invite/${token}`} className="text-primary underline-offset-4 hover:underline">
                  create an account
                </Link>{" "}
                or{" "}
                <Link to={`/signin?next=/invite/${token}`} className="text-primary underline-offset-4 hover:underline">
                  sign in
                </Link>{" "}
                — you'll come right back here.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
