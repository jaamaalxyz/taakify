import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { authClient } from "../lib/auth.js";
import { api } from "../lib/api.js";
import { listBooks } from "../lib/repo/books.js";
import { friendlyError } from "../lib/error-messages.js";
import { priorityRank, WISHLIST_PRIORITY_LABELS, type Ownership, type WishlistPriority } from "../lib/labels.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Input } from "../components/ui/input.js";
import { Card, CardContent } from "../components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

type Book = {
  id: string;
  ownership: Ownership;
  wishlist_priority: WishlistPriority | null;
  edition: { id: string; title: string; authors: string };
};

export function Profile() {
  const { user, household, members } = useHousehold();

  const [books, setBooks] = useState<Book[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const [inviteError, setInviteError] = useState("");

  const [nameOpen, setNameOpen] = useState(false);
  const [nameValue, setNameValue] = useState(user.name);
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [emailOpen, setEmailOpen] = useState(false);
  const [emailStep, setEmailStep] = useState<"start" | "current-otp" | "new-otp">("start");
  const [currentOtp, setCurrentOtp] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newOtp, setNewOtp] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  useEffect(() => {
    listBooks({ householdId: household.id })
      .then((data) => setBooks(data))
      .catch((e) => setLoadError(friendlyError(e)));
  }, [household.id]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteError("");
    setSendingInvite(true);
    try {
      const data = await api<{ url: string }>(`/api/households/${household.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: "member" }),
      });
      setInviteUrl(`${location.origin}${data.url}`);
      toast("Invite created");
    } catch (err) {
      setInviteError(friendlyError(err));
    } finally {
      setSendingInvite(false);
    }
  }

  async function handleCopyInviteUrl() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast("Copied invite link");
    } catch {
      // Clipboard access can fail (permissions, insecure context in some
      // test/embedded environments) — the URL is still visible and
      // selectable in the read-only input, so this is non-fatal.
      setInviteError("Couldn't copy automatically — copy the link manually.");
    }
  }

  async function handleSaveName(e: FormEvent) {
    e.preventDefault();
    setNameError("");
    setSavingName(true);
    try {
      const { error } = await authClient.updateUser({ name: nameValue });
      if (error) return setNameError(error.message ?? "Couldn't save your name");
      toast("Name updated");
      setNameOpen(false);
    } finally {
      setSavingName(false);
    }
  }

  async function handleSendCurrentEmailOtp() {
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: user.email,
        type: "email-verification",
      });
      if (error) return setEmailError(error.message ?? "Couldn't send the code");
      setEmailStep("current-otp");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleRequestEmailChange(e: FormEvent) {
    e.preventDefault();
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({ newEmail, otp: currentOtp });
      if (error) return setEmailError(error.message ?? "Couldn't verify that code");
      setEmailStep("new-otp");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleConfirmEmailChange(e: FormEvent) {
    e.preventDefault();
    setEmailError("");
    setEmailBusy(true);
    try {
      const { error } = await authClient.emailOtp.changeEmail({ newEmail, otp: newOtp });
      if (error) return setEmailError(error.message ?? "Couldn't verify that code");
      toast("Email updated");
      setEmailOpen(false);
    } finally {
      setEmailBusy(false);
    }
  }

  function resetEmailDialog(open: boolean) {
    setEmailOpen(open);
    if (!open) {
      setEmailStep("start");
      setCurrentOtp("");
      setNewEmail("");
      setNewOtp("");
      setEmailError("");
    }
  }

  const counts = {
    owned: books?.filter((b) => b.ownership === "owned").length ?? 0,
    borrowed_in: books?.filter((b) => b.ownership === "borrowed_in").length ?? 0,
    wishlist: books?.filter((b) => b.ownership === "wishlist").length ?? 0,
  };

  const wishlist = (books ?? [])
    .filter((b) => b.ownership === "wishlist")
    .sort((a, b) => priorityRank(a.wishlist_priority) - priorityRank(b.wishlist_priority));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-serif text-lg font-semibold">{household.name}</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {user.name} ({user.email}) · {household.role}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Account</h2>
        <div className="flex flex-wrap gap-2">
          <Dialog open={nameOpen} onOpenChange={setNameOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Edit name
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit name</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSaveName} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="profile-name">Name</Label>
                  <Input
                    id="profile-name"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    required
                  />
                </div>
                {nameError && (
                  <Alert variant="destructive">
                    <AlertDescription>{nameError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingName}>
                    {savingName ? "Saving…" : "Save name"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={emailOpen} onOpenChange={resetEmailDialog}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Change email
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change email</DialogTitle>
              </DialogHeader>
              {emailStep === "start" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    We'll send a code to your current email ({user.email}) first, to confirm it's you.
                  </p>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button onClick={handleSendCurrentEmailOtp} disabled={emailBusy}>
                      {emailBusy ? "Sending…" : "Send code to current email"}
                    </Button>
                  </DialogFooter>
                </div>
              )}
              {emailStep === "current-otp" && (
                <form onSubmit={handleRequestEmailChange} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="current-otp">Code sent to your current email</Label>
                    <Input
                      id="current-otp"
                      value={currentOtp}
                      onChange={(e) => setCurrentOtp(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="new-email">New email</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      required
                    />
                  </div>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button type="submit" disabled={emailBusy}>
                      {emailBusy ? "Sending…" : "Send code to new email"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
              {emailStep === "new-otp" && (
                <form onSubmit={handleConfirmEmailChange} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="new-otp">Code sent to your new email</Label>
                    <Input id="new-otp" value={newOtp} onChange={(e) => setNewOtp(e.target.value)} required />
                  </div>
                  {emailError && (
                    <Alert variant="destructive">
                      <AlertDescription>{emailError}</AlertDescription>
                    </Alert>
                  )}
                  <DialogFooter>
                    <Button type="submit" disabled={emailBusy}>
                      {emailBusy ? "Confirming…" : "Confirm new email"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Reading counts</h2>
        {loadError && (
          <Alert variant="destructive">
            <AlertDescription>Couldn't load your books: {loadError}</AlertDescription>
          </Alert>
        )}
        {!loadError && books === null && (
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {!loadError && books !== null && (
          <div className="grid grid-cols-3 gap-2">
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-xl font-semibold">{counts.owned}</p>
                <p className="text-xs text-muted-foreground">Owned</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-xl font-semibold">{counts.borrowed_in}</p>
                <p className="text-xs text-muted-foreground">Borrowed</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <p className="text-xl font-semibold">{counts.wishlist}</p>
                <p className="text-xs text-muted-foreground">Wishlist</p>
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      {!loadError && books !== null && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Wishlist</h2>
          {wishlist.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing on your wishlist yet.</p>
          )}
          {wishlist.length > 0 && (
            <ul className="space-y-2">
              {wishlist.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                  <Link to={`/library/${b.id}`} className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.edition.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{b.edition.authors}</p>
                  </Link>
                  {b.wishlist_priority && (
                    <Badge variant="outline">{WISHLIST_PRIORITY_LABELS[b.wishlist_priority]}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Bookcases</h2>
        <Link to="/bookcases" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Manage bookcases &amp; shelves
        </Link>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Household</h2>
        {members === null && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        )}
        {members !== null && members.length > 0 && (
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                <span className="text-sm font-medium">{m.name}</span>
                <Badge variant="outline">{m.role}</Badge>
              </li>
            ))}
          </ul>
        )}
        <Dialog
          open={inviteOpen}
          onOpenChange={(open) => {
            setInviteOpen(open);
            if (!open) {
              setInviteEmail("");
              setInviteUrl("");
              setInviteError("");
            }
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">Invite a family member</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a family member</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleInvite} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                />
              </div>
              {inviteError && (
                <Alert variant="destructive">
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}
              {inviteUrl && (
                <div className="space-y-1">
                  <Label htmlFor="invite-url">Shareable link</Label>
                  <div className="flex gap-2">
                    <Input id="invite-url" readOnly value={inviteUrl} />
                    <Button type="button" size="icon" variant="outline" aria-label="Copy invite link" onClick={handleCopyInviteUrl}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={sendingInvite}>
                  {sendingInvite ? "Sending…" : "Create invite"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}
