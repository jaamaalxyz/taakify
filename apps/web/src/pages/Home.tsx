import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Copy, LogOut, UserPlus, BookOpen } from "lucide-react";
import { api, type Me } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Avatar, AvatarFallback } from "../components/ui/avatar.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch((e) => setLoadError((e as Error).message));
  }, []);

  async function invite(e: FormEvent<HTMLFormElement>, householdId: string) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setInviteError("");
    try {
      const { url } = await api<{ url: string }>(`/api/households/${householdId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role: "member" }),
      });
      setInviteUrl(`${location.origin}${url}`);
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  function onDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setInviteUrl("");
      setInviteError("");
    }
  }

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

  if (me.memberships.length === 0)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <BookOpen className="mx-auto h-10 w-10 text-primary" />
            <CardTitle>Welcome, {me.user.name}</CardTitle>
            <CardDescription>You're not in a library yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/onboarding">Create your library</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );

  const membership = me.memberships[0];

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{initials(me.user.name)}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-lg font-semibold">{membership.household_name}</h1>
            <p className="text-sm text-muted-foreground">
              {me.user.email} · {membership.role}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={() => authClient.signOut().finally(() => location.reload())}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogTrigger asChild>
          <Button className="w-full sm:w-auto">
            <UserPlus className="h-4 w-4" />
            Invite a family member
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a family member</DialogTitle>
            <DialogDescription>They'll get a link to join {membership.household_name}.</DialogDescription>
          </DialogHeader>
          {inviteUrl ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteUrl} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy invite link"
                onClick={() => navigator.clipboard.writeText(inviteUrl)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <form onSubmit={(e) => invite(e, membership.household_id)} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" name="email" type="email" placeholder="member@example.com" required />
              </div>
              {inviteError && (
                <Alert variant="destructive">
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit">Send invite</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <p className="text-sm text-muted-foreground">Books arrive in Plan 3. Sync arrives in Plan 2.</p>
    </main>
  );
}
