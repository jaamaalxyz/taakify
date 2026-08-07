import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BookOpen, HandCoins } from "lucide-react";
import { toast } from "sonner";
import { useHousehold } from "../lib/household-context.js";
import { api } from "../lib/api.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Input } from "../components/ui/input.js";
import { Card, CardContent } from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";

type Direction = "lent_out" | "borrowed_in";

type LoanBook = {
  id: string;
  ownership: string;
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: string | null;
  edition: {
    id: string;
    title: string;
    authors: string;
    cover_url: string | null;
    isbn: string | null;
    language: string | null;
  };
};

type Loan = {
  id: string;
  household_id: string;
  direction: Direction;
  out_date: string | null;
  due_date: string | null;
  returned_date: string | null;
  notes: string | null;
  updated_at: string;
  overdue: boolean;
  book: LoanBook;
  contact: { id: string; name: string };
};

type Contact = { id: string; name: string; phone: string | null; email: string | null };

type SimpleBook = { id: string; edition: { title: string; authors: string } };

const DIRECTION_LABELS: Record<Direction, string> = {
  lent_out: "Lent out",
  borrowed_in: "Borrowed in",
};

const NEW_CONTACT = "__new__";

// toISOString() renders in UTC, so in any non-UTC timezone it can report
// tomorrow's (or yesterday's) date depending on time of day — the same bug
// class apps/api/src/lib/date.ts's dateStr() was created to fix server-side.
// Build the string from local Date components instead.
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function LoanRow({
  loan,
  showReturnAction,
  onMarkReturned,
  returning,
}: {
  loan: Loan;
  showReturnAction: boolean;
  onMarkReturned?: (id: string) => void;
  returning?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border p-3">
      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {loan.book.edition.cover_url ? (
          <img src={loan.book.edition.cover_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <Link to={`/library/${loan.book.id}`} className="text-sm font-medium hover:underline">
          {loan.book.edition.title}
        </Link>
        <p className="text-xs text-muted-foreground">
          {DIRECTION_LABELS[loan.direction]} · {loan.contact.name}
          {loan.due_date && ` · due ${loan.due_date}`}
        </p>
        {loan.overdue && <Badge variant="destructive">Overdue</Badge>}
      </div>
      {showReturnAction && (
        <Button size="sm" variant="outline" onClick={() => onMarkReturned?.(loan.id)} disabled={returning}>
          {returning ? "Saving…" : "Mark returned"}
        </Button>
      )}
    </li>
  );
}

export function Loans() {
  const { household } = useHousehold();

  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [returningId, setReturningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [books, setBooks] = useState<SimpleBook[]>([]);
  // Surfaced inline in the "Add loan" dialog (not a blocking Alert) — a
  // failure here just means the book/contact pickers render empty, which
  // is otherwise unexplained to the user.
  const [contactsLoadError, setContactsLoadError] = useState("");
  const [booksLoadError, setBooksLoadError] = useState("");

  // Contacts dialog — doubles as create and edit, matching the brief's
  // "create/edit contact" requirement with one reused form: editingContactId
  // is null for "new contact" and set to an existing contact's id when the
  // user picks one from the list below the form to edit it.
  const [contactOpen, setContactOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState("");

  // Lend out dialog
  const [lendOpen, setLendOpen] = useState(false);
  const [lendBookId, setLendBookId] = useState("");
  const [lendContactSelection, setLendContactSelection] = useState<string>(NEW_CONTACT);
  const [lendNewContactName, setLendNewContactName] = useState("");
  const [lendDirection, setLendDirection] = useState<Direction>("lent_out");
  const [lendDueDate, setLendDueDate] = useState("");
  const [savingLoan, setSavingLoan] = useState(false);
  const [lendError, setLendError] = useState("");

  // Deliberate deviation from the GET /api/loans?active=true contract: we
  // fetch the full unfiltered loan list once and derive both the Active and
  // History sections from it client-side (see activeLoans/historyLoans
  // below), rather than issuing two separate requests (one with
  // active=true, one without). This keeps "mark returned" and "record a
  // loan" each need only one refetch to keep both sections in sync, at the
  // cost of fetching slightly more data up front than active=true alone
  // would. For a household's loan history size this is a non-issue.
  function loadLoans() {
    setLoadError("");
    const params = new URLSearchParams({ householdId: household.id });
    api<{ loans: Loan[] }>(`/api/loans?${params.toString()}`)
      .then((data) => setLoans(data.loans))
      .catch((e) => setLoadError((e as Error).message));
  }

  function loadContacts() {
    setContactsLoadError("");
    api<{ contacts: Contact[] }>(`/api/contacts?householdId=${household.id}`)
      .then((data) => setContacts(data.contacts))
      .catch((e) => {
        setContacts([]);
        setContactsLoadError((e as Error).message);
      });
  }

  function loadBooks() {
    setBooksLoadError("");
    api<{ books: SimpleBook[] }>(`/api/books?householdId=${household.id}`)
      .then((data) => setBooks(data.books))
      .catch((e) => {
        setBooks([]);
        setBooksLoadError((e as Error).message);
      });
  }

  useEffect(() => {
    loadLoans();
    loadContacts();
    loadBooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household.id]);

  async function handleMarkReturned(loanId: string) {
    setActionError("");
    setReturningId(loanId);
    try {
      await api(`/api/loans/${loanId}`, {
        method: "PATCH",
        body: JSON.stringify({ returned_date: todayStr() }),
      });
      toast("Marked as returned");
      loadLoans();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setReturningId(null);
    }
  }

  function resetContactForm() {
    setEditingContactId(null);
    setContactName("");
    setContactPhone("");
    setContactEmail("");
  }

  function startEditContact(contact: Contact) {
    setEditingContactId(contact.id);
    setContactName(contact.name);
    setContactPhone(contact.phone ?? "");
    setContactEmail(contact.email ?? "");
    setContactError("");
  }

  async function handleSaveContact(e: FormEvent) {
    e.preventDefault();
    if (!contactName.trim()) return;
    setContactError("");
    setSavingContact(true);
    try {
      if (editingContactId) {
        const data = await api<{ contact: Contact }>(`/api/contacts/${editingContactId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: contactName.trim(),
            phone: contactPhone.trim() || null,
            email: contactEmail.trim() || null,
          }),
        });
        setContacts((prev) => prev.map((c) => (c.id === data.contact.id ? data.contact : c)));
        toast(`Updated contact "${data.contact.name}"`);
      } else {
        const data = await api<{ contact: Contact }>("/api/contacts", {
          method: "POST",
          body: JSON.stringify({
            householdId: household.id,
            name: contactName.trim(),
            phone: contactPhone.trim() || undefined,
            email: contactEmail.trim() || undefined,
          }),
        });
        setContacts((prev) => [...prev, data.contact]);
        toast(`Added contact "${data.contact.name}"`);
      }
      resetContactForm();
      setContactOpen(false);
    } catch (err) {
      setContactError((err as Error).message);
    } finally {
      setSavingContact(false);
    }
  }

  async function handleCreateLoan(e: FormEvent) {
    e.preventDefault();
    if (!lendBookId) {
      setLendError("Choose a book.");
      return;
    }
    if (lendContactSelection === NEW_CONTACT && !lendNewContactName.trim()) {
      setLendError("Choose a contact or enter a new contact name.");
      return;
    }
    setLendError("");
    setSavingLoan(true);
    try {
      await api("/api/loans", {
        method: "POST",
        body: JSON.stringify({
          bookId: lendBookId,
          direction: lendDirection,
          dueDate: lendDueDate || undefined,
          contactId: lendContactSelection === NEW_CONTACT ? undefined : lendContactSelection,
          contactName: lendContactSelection === NEW_CONTACT ? lendNewContactName.trim() : undefined,
        }),
      });
      toast("Loan recorded");
      setLendOpen(false);
      setLendBookId("");
      setLendContactSelection(NEW_CONTACT);
      setLendNewContactName("");
      setLendDirection("lent_out");
      setLendDueDate("");
      loadLoans();
      loadContacts();
    } catch (err) {
      setLendError((err as Error).message);
    } finally {
      setSavingLoan(false);
    }
  }

  const activeLoans = loans?.filter((l) => l.returned_date === null) ?? [];
  const historyLoans = loans?.filter((l) => l.returned_date !== null) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Loans</h1>
        <div className="flex gap-2">
          <Dialog
            open={contactOpen}
            onOpenChange={(open) => {
              setContactOpen(open);
              if (!open) {
                resetContactForm();
                setContactError("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Contacts
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Contacts</DialogTitle>
              </DialogHeader>

              {contacts.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                  {contacts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => startEditContact(c)}
                        className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleSaveContact} className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    {editingContactId ? "Edit contact" : "New contact"}
                  </p>
                  {editingContactId && (
                    <button
                      type="button"
                      onClick={resetContactForm}
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      + New contact instead
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-name">Name</Label>
                  <Input
                    id="contact-name"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-phone">Phone</Label>
                  <Input id="contact-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-email">Email</Label>
                  <Input id="contact-email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
                </div>
                {contactError && (
                  <Alert variant="destructive">
                    <AlertDescription>{contactError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingContact}>
                    {savingContact ? "Saving…" : editingContactId ? "Save changes" : "Add contact"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={lendOpen} onOpenChange={setLendOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add loan</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record a loan</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateLoan} className="space-y-3">
                {(booksLoadError || contactsLoadError) && (
                  <p className="text-xs text-muted-foreground">
                    {booksLoadError && contactsLoadError
                      ? "Couldn't load books or contacts, so those pickers may be empty — try reopening this dialog."
                      : booksLoadError
                        ? "Couldn't load books, so the book picker may be empty — try reopening this dialog."
                        : "Couldn't load contacts, so the contact picker may be empty — try reopening this dialog."}
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="lend-book">Book</Label>
                  <Select value={lendBookId} onValueChange={setLendBookId}>
                    <SelectTrigger id="lend-book" className="w-full">
                      <SelectValue placeholder="Choose a book" />
                    </SelectTrigger>
                    <SelectContent>
                      {books.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.edition.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lend-direction">Direction</Label>
                  <Select value={lendDirection} onValueChange={(v) => setLendDirection(v as Direction)}>
                    <SelectTrigger id="lend-direction" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lent_out">Lent out</SelectItem>
                      <SelectItem value="borrowed_in">Borrowed in</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lend-contact">Contact</Label>
                  <Select value={lendContactSelection} onValueChange={setLendContactSelection}>
                    <SelectTrigger id="lend-contact" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NEW_CONTACT}>+ New contact</SelectItem>
                      {contacts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {lendContactSelection === NEW_CONTACT && (
                  <div className="space-y-1">
                    <Label htmlFor="lend-new-contact-name">New contact name</Label>
                    <Input
                      id="lend-new-contact-name"
                      value={lendNewContactName}
                      onChange={(e) => setLendNewContactName(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="lend-due-date">Due date</Label>
                  <Input
                    id="lend-due-date"
                    type="date"
                    value={lendDueDate}
                    onChange={(e) => setLendDueDate(e.target.value)}
                  />
                </div>
                {lendError && (
                  <Alert variant="destructive">
                    <AlertDescription>{lendError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={savingLoan}>
                    {savingLoan ? "Saving…" : "Record loan"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>Couldn't load loans: {loadError}</AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {!loadError && loans === null && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!loadError && loans !== null && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Active</h2>
            {activeLoans.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                  <HandCoins className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">No active loans.</p>
                </CardContent>
              </Card>
            )}
            {activeLoans.length > 0 && (
              <ul className="space-y-2">
                {activeLoans.map((loan) => (
                  <LoanRow
                    key={loan.id}
                    loan={loan}
                    showReturnAction
                    onMarkReturned={handleMarkReturned}
                    returning={returningId === loan.id}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">History</h2>
            {historyLoans.length === 0 && (
              <p className="text-sm text-muted-foreground">No returned loans yet.</p>
            )}
            {historyLoans.length > 0 && (
              <ul className="space-y-2">
                {historyLoans.map((loan) => (
                  <LoanRow key={loan.id} loan={loan} showReturnAction={false} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
